import { Chess } from 'chess.js';
import type { Square } from 'chess.js';
import type { Color, PlayedMove } from '../types';

export interface PieceRef { square: string; piece: 'p' | 'n' | 'b' | 'r' | 'q' | 'k'; color: Color }
export interface PositionFacts {
  material: { w: number; b: number };
  hanging: PieceRef[];
  attackedBy(lastMoveUci: string): PieceRef[];
  forks: { attacker: PieceRef; targets: PieceRef[] }[];
  inCheck: boolean;
}

const VALUE: Record<PieceRef['piece'], number> = { p: 1, n: 3, b: 3, r: 5, q: 9, k: 100 };
const opposite = (c: Color): Color => (c === 'w' ? 'b' : 'w');

function allPieces(chess: Chess): PieceRef[] {
  const out: PieceRef[] = [];
  for (const row of chess.board()) {
    for (const p of row) if (p) out.push({ square: p.square, piece: p.type, color: p.color });
  }
  return out;
}

/**
 * True only if `from` can LEGALLY capture the non-king piece on `to`
 * (so pins, checks and defended-king-capture are all respected).
 * Any doubt (unloadable position) means false: facts must never over-claim.
 */
function canCapture(fen: string, from: string, to: string, color: Color): boolean {
  try {
    const parts = fen.split(' ');
    const flipped = [parts[0], color, parts[2] ?? '-', '-', parts[4] ?? '0', parts[5] ?? '1'].join(' ');
    const c = new Chess(flipped);
    return c.moves({ square: from as Square, verbose: true }).some((m) => m.to === to);
  } catch {
    return false;
  }
}

/** Squares of `byColor` pieces that can legally capture the non-king piece at `target`. */
function capturers(chess: Chess, fen: string, target: PieceRef, byColor: Color): PieceRef[] {
  const byColorPieces = new Map(allPieces(chess).filter((p) => p.color === byColor).map((p) => [p.square, p]));
  return chess
    .attackers(target.square as Square, byColor)
    .filter((sq) => canCapture(fen, sq, target.square, byColor))
    .map((sq) => byColorPieces.get(sq)!)
    .filter(Boolean);
}

function findHanging(chess: Chess, fen: string, pieces: PieceRef[]): PieceRef[] {
  const out: PieceRef[] = [];
  for (const p of pieces) {
    if (p.piece === 'k') continue;
    const enemy = opposite(p.color);
    const caps = capturers(chess, fen, p, enemy);
    if (caps.length === 0) continue;
    const undefended = chess.attackers(p.square as Square, p.color).length === 0;
    const byLower = caps.some((a) => VALUE[a.piece] < VALUE[p.piece]);
    if (undefended || byLower) out.push(p);
  }
  return out;
}

/** Enemy pieces (to `attacker`) that it attacks: legal captures, plus the king (check). */
function attackedTargets(chess: Chess, fen: string, attacker: PieceRef, pieces: PieceRef[]): PieceRef[] {
  const out: PieceRef[] = [];
  for (const t of pieces) {
    if (t.color === attacker.color) continue;
    if (t.piece === 'k') {
      if (chess.attackers(t.square as Square, attacker.color).includes(attacker.square as Square)) out.push(t);
    } else if (
      chess.attackers(t.square as Square, attacker.color).includes(attacker.square as Square) &&
      canCapture(fen, attacker.square, t.square, attacker.color)
    ) {
      out.push(t);
    }
  }
  return out;
}

export function positionFacts(fen: string): PositionFacts {
  const chess = new Chess(fen);
  const pieces = allPieces(chess);
  const material = { w: 0, b: 0 };
  for (const p of pieces) if (p.piece !== 'k') material[p.color] += VALUE[p.piece];

  const forks: PositionFacts['forks'] = [];
  for (const a of pieces) {
    const targets = attackedTargets(chess, fen, a, pieces).filter((t) => VALUE[t.piece] >= 3);
    if (targets.length >= 2) forks.push({ attacker: a, targets });
  }

  return {
    material,
    hanging: findHanging(chess, fen, pieces),
    forks,
    inCheck: chess.isCheck(),
    attackedBy(lastMoveUci: string): PieceRef[] {
      const to = lastMoveUci.slice(2, 4);
      const mover = pieces.find((p) => p.square === to);
      if (!mover) return [];
      return attackedTargets(chess, fen, mover, pieces);
    },
  };
}

export function uciLineToSan(fen: string, uci: string[]): string[] {
  const chess = new Chess(fen);
  const out: string[] = [];
  for (const u of uci) {
    try {
      const m = chess.move({ from: u.slice(0, 2), to: u.slice(2, 4), promotion: u[4] });
      out.push(m.san);
    } catch {
      break; // an unplayable move ends the line; never guess
    }
  }
  return out;
}

type Violation = 'early_queen' | 'undeveloped' | 'king_safety' | 'pawn_moves';

const MINOR_HOME: Record<Color, { square: string; piece: 'n' | 'b' }[]> = {
  w: [{ square: 'b1', piece: 'n' }, { square: 'g1', piece: 'n' }, { square: 'c1', piece: 'b' }, { square: 'f1', piece: 'b' }],
  b: [{ square: 'b8', piece: 'n' }, { square: 'g8', piece: 'n' }, { square: 'c8', piece: 'b' }, { square: 'f8', piece: 'b' }],
};

function undevelopedMinors(fen: string, color: Color): number {
  const chess = new Chess(fen);
  return MINOR_HOME[color].filter((h) => {
    const p = chess.get(h.square as Square);
    return p && p.color === color && p.type === h.piece;
  }).length;
}

function kingSafetyIssue(fen: string, color: Color): boolean {
  const chess = new Chess(fen);
  const kingSq = color === 'w' ? 'e1' : 'e8';
  const k = chess.get(kingSq as Square);
  if (!k || k.type !== 'k' || k.color !== color) return false;
  const pieces = allPieces(chess);
  const fileOpen = (f: string) => !pieces.some((p) => p.piece === 'p' && p.square[0] === f);
  return fileOpen('e') || fileOpen('d');
}

export function principleViolations(history: PlayedMove[], color: Color): Violation[] {
  const mine = history.filter((m) => m.color === color).slice(0, 12);
  const out: Violation[] = [];

  const queenMoveIdx = mine.findIndex((m) => m.san.startsWith('Q'));
  if (queenMoveIdx >= 0 && queenMoveIdx < 4 && undevelopedMinors(mine[queenMoveIdx].fenBefore, color) >= 2) {
    out.push('early_queen');
  }

  if (mine.length >= 10) {
    const last = mine[mine.length - 1];
    if (undevelopedMinors(last.fenAfter, color) >= 2) out.push('undeveloped');
    const castled = mine.some((m) => m.san.startsWith('O-O'));
    if (!castled && kingSafetyIssue(last.fenAfter, color)) out.push('king_safety');
  }

  const firstSix = mine.slice(0, 6);
  if (firstSix.filter((m) => /^[a-h]/.test(m.san)).length >= 4) out.push('pawn_moves');

  return out;
}

export interface Pin { pinner: PieceRef; pinned: PieceRef; behind: PieceRef }

const DIAGONALS = [[1, 1], [1, -1], [-1, 1], [-1, -1]];
const STRAIGHTS = [[1, 0], [-1, 0], [0, 1], [0, -1]];
const RAYS: Partial<Record<PieceRef['piece'], number[][]>> = {
  b: DIAGONALS, r: STRAIGHTS, q: [...DIAGONALS, ...STRAIGHTS],
};

/**
 * Pins by bishops, rooks and queens: an enemy non-king piece on the ray with, directly behind it,
 * the enemy king (absolute pin) or a higher-value enemy piece (relative pin).
 */
export function pins(fen: string): Pin[] {
  const chess = new Chess(fen);
  const pieces = allPieces(chess);
  const at = new Map(pieces.map((p) => [p.square, p]));
  const out: Pin[] = [];
  for (const pinner of pieces) {
    for (const [df, dr] of RAYS[pinner.piece] ?? []) {
      const onRay: PieceRef[] = [];
      let f = pinner.square.charCodeAt(0) - 97 + df;
      let r = Number(pinner.square[1]) + dr;
      while (f >= 0 && f < 8 && r >= 1 && r <= 8 && onRay.length < 2) {
        const p = at.get(String.fromCharCode(97 + f) + r);
        if (p) onRay.push(p);
        f += df;
        r += dr;
      }
      const [pinned, behind] = onRay;
      if (!pinned || !behind) continue;
      const enemy = opposite(pinner.color);
      if (pinned.color !== enemy || behind.color !== enemy || pinned.piece === 'k') continue;
      if (behind.piece === 'k' || VALUE[behind.piece] > VALUE[pinned.piece]) out.push({ pinner, pinned, behind });
    }
  }
  return out;
}
