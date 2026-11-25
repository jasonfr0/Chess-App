import { Chess } from 'chess.js';
import type { Square } from 'chess.js';
import type { Analysis, Area, CoachLevel, EngineLine, PlayedMove, Theme } from '../types';
import { pins, positionFacts, principleViolations, uciLineToSan } from './facts';
import type { Pin, PieceRef } from './facts';

export interface Verdict {
  flagged: boolean; severity: 'ok' | 'inaccuracy' | 'mistake' | 'blunder';
  cpLoss: number; area: Area; theme: Theme;
  recommendation: 'take_back' | 'play_on';
  bestUci: string; bestSan: string;
  refutationSan: string[]; // engine best line after the user's move, ≤ 4 plies
}

export interface ClassifyInput {
  fenBefore: string; move: PlayedMove; before: Analysis; after: Analysis;
  history: PlayedMove[]; level: CoachLevel; plyCount: number; inBook: boolean;
}

const MATE = 10000;
const CP_CAP = 2000;
const DECIDED = 800;
const NEAR_BEST = 60;
const NON_PAWN: Record<string, number> = { n: 3, b: 3, r: 5, q: 9 };
const PIECE_VALUE: Record<PieceRef['piece'], number> = { p: 1, n: 3, b: 3, r: 5, q: 9, k: 100 };

/** opening if inBook or plyCount < 20; endgame if non-pawn material (both sides, excl. kings) ≤ 13; else middlegame */
export function areaOf(fen: string, plyCount: number, inBook: boolean): Area {
  if (inBook || plyCount < 20) return 'opening';
  let nonPawn = 0;
  for (const row of new Chess(fen).board()) for (const p of row) if (p) nonPawn += NON_PAWN[p.type] ?? 0;
  return nonPawn <= 13 ? 'endgame' : 'middlegame';
}

/** Side-to-move POV score of a line; mate for the side to move = +MATE. */
function lineScore(l: EngineLine): number {
  if (l.mate !== null) return l.mate > 0 ? MATE : -MATE;
  return l.cp ?? 0;
}

/** Mover-POV eval of the position after the move (opponent to move). */
function evalAfter(after: Analysis, fenAfter: string): number {
  const best = after.lines[0];
  if (best) return -lineScore(best);
  return new Chess(fenAfter).isCheckmate() ? MATE : 0; // no lines: mate delivered, else a draw
}

function fenAfterUci(fen: string, uci: string): string | null {
  try {
    const c = new Chess(fen);
    c.move({ from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci[4] });
    return c.fen();
  } catch {
    return null;
  }
}

const sameSquare = (a: PieceRef, b: PieceRef) => a.square === b.square && a.piece === b.piece && a.color === b.color;
const samePin = (a: Pin, b: Pin) => sameSquare(a.pinner, b.pinner) && sameSquare(a.pinned, b.pinned) && sameSquare(a.behind, b.behind);

function severityOf(cpLoss: number, mateBlunder: boolean): Verdict['severity'] {
  if (mateBlunder || cpLoss >= 300) return 'blunder';
  if (cpLoss >= 150) return 'mistake';
  if (cpLoss >= 60) return 'inaccuracy';
  return 'ok';
}

/** The opening-principle theme newly broken by this move (mover's first 12 moves only). */
function newPrincipleTheme(history: PlayedMove[], move: PlayedMove): Theme | null {
  const withMove = [...history, move];
  if (withMove.filter((m) => m.color === move.color).length > 12) return null;
  const before = new Set(principleViolations(history, move.color));
  const fresh = principleViolations(withMove, move.color).filter((v) => !before.has(v));
  if (fresh.includes('early_queen')) return 'early_queen';
  if (fresh.includes('undeveloped') || fresh.includes('pawn_moves')) return 'undeveloped';
  if (fresh.includes('king_safety')) return 'king_safety';
  return null;
}

/** Mover's material minus opponent's at the end of `uci` played from `fen`. */
function materialBalance(fen: string, uci: string[], mover: PlayedMove['color']): number {
  const c = new Chess(fen);
  for (const u of uci) {
    try {
      c.move({ from: u.slice(0, 2), to: u.slice(2, 4), promotion: u[4] });
    } catch {
      break;
    }
  }
  const m = positionFacts(c.fen()).material;
  return mover === 'w' ? m.w - m.b : m.b - m.w;
}

/** True if, somewhere in `uci` played from `fen`, the opponent captures `piece` on its own square. */
function lineCaptures(fen: string, uci: string[], piece: PieceRef): boolean {
  const c = new Chess(fen);
  for (const u of uci) {
    const there = c.get(piece.square as Square);
    if (!there || there.type !== piece.piece || there.color !== piece.color) return false; // it moved away
    let m;
    try {
      m = c.move({ from: u.slice(0, 2), to: u.slice(2, 4), promotion: u[4] });
    } catch {
      return false;
    }
    if (m.color !== piece.color && m.to === piece.square && m.captured) return true;
  }
  return false;
}

export function classifyMove(input: ClassifyInput): Verdict {
  const { fenBefore, move, before, after, history, level, plyCount, inBook } = input;
  const area = areaOf(fenBefore, plyCount, inBook);
  const refutationUci = after.lines[0]?.uci.slice(0, 4) ?? [];
  const refutationSan = uciLineToSan(move.fenAfter, refutationUci);

  const bestLine = before.lines[0];
  if (!bestLine || bestLine.uci.length === 0) {
    return {
      flagged: false, severity: 'ok', cpLoss: 0, area, theme: 'other', recommendation: 'play_on',
      bestUci: move.uci, bestSan: move.san, refutationSan,
    };
  }

  const bestUci = bestLine.uci[0];
  const bestSan = uciLineToSan(fenBefore, [bestUci])[0] ?? bestUci;
  const bestEval = lineScore(bestLine);

  // The engine's own choice (or a line it rates within NEAR_BEST of best) is never a mistake,
  // even if the after-search disagrees at a different depth.
  const engineApproved = before.lines.some(
    (l) => l.uci[0] === move.uci && (l === bestLine || bestEval - lineScore(l) <= NEAR_BEST),
  );
  if (engineApproved) {
    return {
      flagged: false, severity: 'ok', cpLoss: 0, area, theme: 'other', recommendation: 'play_on',
      bestUci, bestSan, refutationSan,
    };
  }
  const afterEval = evalAfter(after, move.fenAfter);
  const cpLoss = Math.min(CP_CAP, Math.max(0, bestEval - afterEval));

  const alreadyMated = bestLine.mate !== null && bestLine.mate <= 0;
  const reply = after.lines[0];
  const allowsMate = !alreadyMated && reply !== undefined && reply.mate !== null && reply.mate > 0;
  const missesMate = bestLine.mate !== null && bestLine.mate >= 1 && bestLine.mate <= 3 && afterEval !== MATE;
  const severity = severityOf(cpLoss, allowsMate || missesMate);

  const principle = newPrincipleTheme(history, move);
  const theme = severity === 'ok'
    ? 'other'
    : pickTheme({ input, area, bestUci, refutationUci, allowsMate, missesMate, principle });

  let flagged: boolean;
  if (inBook || level === 'solo') flagged = false;
  else if (Math.abs(bestEval) >= DECIDED) flagged = (allowsMate || missesMate) && severity === 'blunder';
  else if (level === 'light') flagged = severity === 'blunder';
  else flagged = severity === 'mistake' || severity === 'blunder' || (principle !== null && cpLoss >= 60);

  const urgent: Theme[] = ['hanging_piece', 'ignored_threat', 'allowed_mate', 'missed_mate'];
  const recommendation = flagged && (severity === 'blunder' || urgent.includes(theme)) ? 'take_back' : 'play_on';

  return { flagged, severity, cpLoss, area, theme, recommendation, bestUci, bestSan, refutationSan };
}

function pickTheme(ctx: {
  input: ClassifyInput; area: Area; bestUci: string; refutationUci: string[];
  allowsMate: boolean; missesMate: boolean; principle: Theme | null;
}): Theme {
  const { input, area, bestUci, refutationUci, allowsMate, missesMate, principle } = ctx;
  const { fenBefore, move } = input;
  const mover = move.color;
  if (allowsMate) return 'allowed_mate';
  if (missesMate) return 'missed_mate';

  // Material claims must be confirmed by the engine's refutation, not just by static attack counts.
  const materialLost = materialBalance(move.fenAfter, refutationUci, mover) < materialBalance(fenBefore, [], mover);
  const engineWins = (p: PieceRef) => materialLost && lineCaptures(move.fenAfter, refutationUci, p);

  const mine = (ps: PieceRef[]) => ps.filter((p) => p.color === mover && p.piece !== 'k');
  const hangingBefore = mine(positionFacts(fenBefore).hanging);
  const hangingAfter = mine(positionFacts(move.fenAfter).hanging);
  const wasHanging = (p: PieceRef) => hangingBefore.some((q) => sameSquare(p, q));
  if (hangingAfter.some((p) => !wasHanging(p) && engineWins(p))) return 'hanging_piece';
  if (hangingAfter.some((p) => wasHanging(p) && engineWins(p))) return 'ignored_threat';

  const firstReply = refutationUci[0];
  const fenReply = firstReply ? fenAfterUci(move.fenAfter, firstReply) : null;
  if (fenReply && materialLost) {
    const dest = firstReply.slice(2, 4);
    if (positionFacts(fenReply).forks.some((f) => f.attacker.color !== mover && f.attacker.square === dest)) {
      return 'allowed_fork';
    }
  }

  const fenBest = bestUci !== move.uci ? fenAfterUci(fenBefore, bestUci) : null;
  if (fenBest) {
    const dest = bestUci.slice(2, 4);
    if (positionFacts(fenBest).forks.some((f) => f.attacker.color === mover && f.attacker.square === dest)) {
      return 'missed_fork';
    }
    const pinsBefore = pins(fenBefore);
    const newPin = (p: Pin) =>
      p.pinner.color === mover && p.pinner.square === dest && PIECE_VALUE[p.pinned.piece] >= 3 &&
      !pinsBefore.some((q) => samePin(p, q));
    if (pins(fenBest).some(newPin)) {
      return 'missed_pin';
    }
  }

  if (principle) return principle;
  if (refutationUci.length >= 2 && materialLost) return 'bad_trade';
  if (area === 'endgame') return 'endgame_technique';
  return 'other';
}
