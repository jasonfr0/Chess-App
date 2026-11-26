import { Chess } from 'chess.js';
import type { Move, Square } from 'chess.js';
import type { Area, Color } from '../types';
import type { BookHit } from '../openings/repertoire';
import { positionFacts } from './facts';
import type { PieceRef } from './facts';
import { NAMES, moveNote } from './templates';

export type Fundamental = 'develops' | 'centre' | 'king_safety' | 'defends' | 'attacks' | 'check_threat'
  | 'wins_material' | 'trade_when_ahead' | 'passed_pawn' | 'king_activity';

/**
 * Why a move is good, every field checked with chess.js or the engine line. `effect` is a
 * predicate about this game ("brings your knight out and attacks their pawn on e5"), to follow the SAN.
 */
export interface Reasons {
  opening: { name: string; idea: string } | null;
  principle: string | null;
  fundamentals: Fundamental[];
  effect: string | null;
  /** The move gives checkmate. */
  checkmate?: boolean;
  /** The piece a pawn promotes to. */
  promotion?: 'q' | 'r' | 'b' | 'n';
}

/** Why each idea works, in one plain sentence for a beginner. */
export const FUNDAMENTAL_WHY: Record<Fundamental, string> = {
  develops: 'Getting your knights and bishops out early puts more of your army into the fight.',
  centre: 'Pieces in the middle reach more squares, and pawns there take good squares away from your opponent.',
  king_safety: 'Castling moves your king away from the middle, where it is easiest to attack.',
  defends: 'A guarded piece can\'t be taken for free, because you can take back.',
  attacks: 'When you attack their pieces, they have to spend moves saving them instead of attacking you.',
  check_threat: 'Checks and threats force your opponent to answer them, so you decide what happens next.',
  wins_material: 'Everything you win is one less thing they can fight you with.',
  trade_when_ahead: 'When you are ahead, every even trade makes your extra material count for more.',
  passed_pawn: 'A pawn that no enemy pawn can stop may march all the way and become a new queen.',
  king_activity: 'With fewer pieces left, your king is usually safe to come out and becomes a strong fighter.',
};

/** The simple rule each fundamental follows, named in the explanation. */
const RULE: Record<Fundamental, string> = {
  develops: 'bring your pieces out',
  centre: 'fight for the middle of the board',
  king_safety: 'keep your king safe',
  defends: 'guard pieces that are attacked',
  attacks: 'put pressure on their pieces',
  check_threat: 'look for checks and threats',
  wins_material: 'take pieces when you can do it safely',
  trade_when_ahead: 'trade pieces when you are ahead',
  passed_pawn: 'push a pawn that no enemy pawn can stop',
  king_activity: 'use your king in the endgame',
};

/** Opening principles, named when out of book in the opening. */
const PRINCIPLE: Partial<Record<Fundamental, string>> = {
  king_safety: 'castle early to keep your king safe',
  develops: 'get your knights and bishops out before your queen',
  centre: 'put pawns and pieces in the middle of the board',
};

/** Most telling first: the one whose "why" is shown. */
const PRIORITY: Fundamental[] = [
  'wins_material', 'trade_when_ahead', 'check_threat', 'defends', 'king_safety', 'develops', 'centre',
  'passed_pawn', 'king_activity', 'attacks',
];

const VALUE: Record<PieceRef['piece'], number> = { p: 1, n: 3, b: 3, r: 5, q: 9, k: 100 };
const CENTRE: Square[] = ['d4', 'e4', 'd5', 'e5'];
const MINOR_HOME: Record<Color, Partial<Record<string, 'n' | 'b'>>> = {
  w: { b1: 'n', g1: 'n', c1: 'b', f1: 'b' },
  b: { b8: 'n', g8: 'n', c8: 'b', f8: 'b' },
};
const opposite = (c: Color): Color => (c === 'w' ? 'b' : 'w');
const EMPTY: Reasons = { opening: null, principle: null, fundamentals: [], effect: null };

function playUci(c: Chess, uci: string): Move | null {
  try {
    return c.move({ from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci[4] });
  } catch {
    return null;
  }
}

/** `fen` with `color` to move and no en passant square; null if chess.js rejects it. */
function withTurn(fen: string, color: Color): Chess | null {
  const p = fen.split(' ');
  try {
    return new Chess([p[0], color, p[2] ?? '-', '-', p[4] ?? '0', p[5] ?? '1'].join(' '));
  } catch {
    return null;
  }
}

function balance(c: Chess, color: Color): number {
  const m = positionFacts(c.fen()).material;
  return color === 'w' ? m.w - m.b : m.b - m.w;
}

function hasMateInOne(c: Chess | null): boolean {
  if (!c) return false;
  return c.moves({ verbose: true }).some((m) => {
    c.move(m);
    const mate = c.isCheckmate();
    c.undo();
    return mate;
  });
}

/** True only if the piece on `from` could legally take back on `target` (pins respected). */
function canRetake(fenAfter: string, from: string, target: string, color: Color): boolean {
  const c = withTurn(fenAfter, color);
  if (!c) return false;
  c.remove(target as Square);
  if (!c.put({ type: 'n', color: opposite(color) }, target as Square)) return false;
  return c.moves({ square: from as Square, verbose: true }).some((m) => m.to === target);
}

/** Pieces of the mover that were attacked, still are, and are now newly guarded by the moved piece. */
function newlyDefended(before: Chess, after: Chess, m: Move): PieceRef[] {
  const out: PieceRef[] = [];
  const enemy = opposite(m.color);
  for (const row of after.board()) {
    for (const p of row) {
      if (!p || p.color !== m.color || p.type === 'k' || p.square === m.to) continue;
      const was = before.get(p.square);
      if (!was || was.type !== p.type || was.color !== p.color) continue;
      if (before.attackers(p.square, enemy).length === 0 || after.attackers(p.square, enemy).length === 0) continue;
      if (!after.attackers(p.square, m.color).includes(m.to)) continue;
      if (before.attackers(p.square, m.color).includes(m.from)) continue;
      if (!canRetake(after.fen(), m.to, p.square, m.color)) continue;
      out.push({ square: p.square, piece: p.type, color: p.color });
    }
  }
  return out;
}

/**
 * Mover's material change after the line's first exchange (the first run of captures), and still
 * at the line's end. Null when the line has no capture, or ends before the exchange is shown to be over.
 */
function exchangeGain(fen: string, line: string[], color: Color): number | null {
  const c = new Chess(fen);
  const base = balance(c, color);
  const captures: boolean[] = [];
  const balances: number[] = [];
  for (const u of line) {
    const m = playUci(c, u);
    if (!m) break;
    captures.push(Boolean(m.captured));
    balances.push(balance(c, color));
  }
  const first = captures.indexOf(true);
  if (first < 0) return null;
  let end = first;
  while (end < captures.length && captures[end]) end++;
  if (end >= captures.length) return null; // nothing after the captures: a take-back may still come
  return Math.min(balances[end - 1], balances[balances.length - 1]) - base;
}

function isPassed(c: Chess, square: string, color: Color): boolean {
  const file = square.charCodeAt(0) - 97;
  const rank = Number(square[1]);
  for (const row of c.board()) {
    for (const p of row) {
      if (!p || p.type !== 'p' || p.color === color) continue;
      const f = p.square.charCodeAt(0) - 97;
      const r = Number(p.square[1]);
      if (Math.abs(f - file) <= 1 && (color === 'w' ? r > rank : r < rank)) return false;
    }
  }
  return true;
}

/** King steps from the four middle squares (0 on d4/e4/d5/e5). */
function centreDistance(square: string): number {
  const f = square.charCodeAt(0) - 97;
  const r = Number(square[1]) - 1;
  const d = (x: number) => (x < 3 ? 3 - x : x > 4 ? x - 4 : 0);
  return Math.max(d(f), d(r));
}

function joinAnd(items: string[]): string {
  return items.length <= 1 ? (items[0] ?? '') : `${items.slice(0, -1).join(', ')} and ${items.at(-1)}`;
}

function amount(gain: number): string {
  const words: Record<number, string> = {
    1: 'a pawn', 2: 'two pawns', 3: 'a piece', 4: 'more than a piece', 5: 'a rook', 6: 'more than a rook',
  };
  return words[gain] ?? (gain >= 8 ? 'a lot of material' : 'material');
}

/** Mover's pieces that the opponent could win (facts.ts hanging logic). */
function hangingOf(fen: string, color: Color): PieceRef[] {
  return positionFacts(fen).hanging.filter((p) => p.color === color);
}

/** Legal king moves for `color` in `c` (a copy with `color` to move). */
function kingMoves(c: Chess | null, color: Color): number {
  if (!c) return 0;
  const king = c.board().flat().find((p) => p && p.type === 'k' && p.color === color);
  return king ? c.moves({ square: king.square, verbose: true }).length : 0;
}

/**
 * True when the king had no legal square before, has one after, and an enemy rook or queen can
 * reach the king's rank right now (a back-rank mate threat). All checked with chess.js.
 */
function givesKingSquare(before: Chess, after: Chess, m: Move): boolean {
  if (m.piece === 'k' || before.inCheck()) return false;
  const king = after.board().flat().find((p) => p && p.type === 'k' && p.color === m.color);
  if (!king || king.square[1] !== (m.color === 'w' ? '1' : '8')) return false; // only on its own back rank
  if (kingMoves(before, m.color) !== 0 || kingMoves(withTurn(after.fen(), m.color), m.color) === 0) return false;
  // An enemy rook or queen can give check along that rank right now.
  return after.moves({ verbose: true }).some(
    (x) => (x.piece === 'r' || x.piece === 'q') && x.to[1] === king.square[1] && /[+#]$/.test(x.san),
  );
}

const PROMOTION_WHY: Record<'q' | 'r' | 'b' | 'n', string> = {
  q: 'A new queen is the strongest piece on the board.',
  r: 'A new rook is a strong extra piece on your side.',
  b: 'A new bishop is an extra piece on your side.',
  n: 'A new knight is an extra piece on your side.',
};

function ahead(gain: number): string {
  const a = amount(gain);
  return a === 'material' ? 'comes out ahead' : a === 'a lot of material' ? 'comes out well ahead' : `comes out ${a} ahead`;
}

const stripCheck = (san: string) => san.replace(/[+#]$/, '');

export function deriveReasons(
  fenBefore: string,
  uci: string,
  opts: { book: BookHit | null; area: Area; line?: string[] },
): Reasons {
  let before: Chess;
  let after: Chess;
  try {
    before = new Chess(fenBefore);
    after = new Chess(fenBefore);
  } catch {
    return EMPTY;
  }
  const m = playUci(after, uci);
  if (!m) return EMPTY;
  const color = m.color;
  const found = new Set<Fundamental>();
  const castle = m.flags.includes('k') || m.flags.includes('q');
  const mate = m.san.endsWith('#');
  const check = m.san.endsWith('+');

  if (opts.area === 'opening' && (m.piece === 'n' || m.piece === 'b') && MINOR_HOME[color][m.from] === m.piece) {
    found.add('develops');
  }

  // In the opening, only pawns and knights/bishops earn centre credit: an early queen or rook is no lesson.
  const centreOk = !castle && m.piece !== 'k' && !(opts.area === 'opening' && (m.piece === 'q' || m.piece === 'r'));
  const occupiesCentre = centreOk && CENTRE.includes(m.to);
  const aimsAt = !centreOk || occupiesCentre ? [] : CENTRE.filter(
    (sq) => after.get(sq)?.color !== color &&
      after.attackers(sq, color).includes(m.to) && !before.attackers(sq, color).includes(m.from),
  );
  if (opts.area !== 'endgame' && (occupiesCentre || aimsAt.length > 0)) found.add('centre');

  if (castle) found.add('king_safety');

  const defended = castle ? [] : newlyDefended(before, after, m);
  if (defended.length > 0) found.add('defends');

  // Only targets that could be won: undefended, or worth more than the attacker. Undefended first, then by value.
  const attackerValue = VALUE[m.promotion ?? m.piece];
  const undefended = (t: PieceRef) => after.attackers(t.square as Square, t.color).length === 0;
  const factsAfter = positionFacts(after.fen());
  // A piece that can itself be won right back is not "attacking" anything worth claiming.
  const moverHanging = factsAfter.hanging.some((p) => p.square === m.to && p.color === color);
  const attacked = castle || moverHanging ? [] : factsAfter.attackedBy(uci)
    .filter((t) => t.piece !== 'k' && !before.attackers(t.square as Square, color).includes(m.from))
    .filter((t) => undefended(t) || VALUE[t.piece] > attackerValue)
    .sort((a, b) => Number(undefended(b)) - Number(undefended(a)) || VALUE[b.piece] - VALUE[a.piece]);
  if (attacked.length > 0) found.add('attacks');

  const mateThreat = !mate && !check && hasMateInOne(withTurn(after.fen(), color)) && !hasMateInOne(before);
  if (mate || check || mateThreat) found.add('check_threat');

  const line = opts.line && opts.line[0] === uci ? opts.line : null;
  const gain = line ? exchangeGain(fenBefore, line, color) : null;
  if (gain !== null && gain > 0) found.add('wins_material');

  if (line && m.captured && m.captured !== 'p' && balance(before, color) >= 2) {
    const c = new Chess(fenBefore);
    playUci(c, uci);
    const reply = line[1] ? playUci(c, line[1]) : null;
    if (reply?.captured && reply.to === m.to && balance(c, color) === balance(before, color)) found.add('trade_when_ahead');
  }

  if (m.piece === 'p' && !m.promotion && isPassed(after, m.to, color)) found.add('passed_pawn');

  if (opts.area === 'endgame' && m.piece === 'k' && !castle && centreDistance(m.to) < centreDistance(m.from)) {
    found.add('king_activity');
  }

  const fundamentals = PRIORITY.filter((f) => found.has(f));

  // What it does here: an action, then (at most) one consequence.
  let action: string | null = null;
  const consequences: string[] = [];
  if (mate) action = 'gives checkmate';
  else if (m.captured) {
    action = moveNote(fenBefore, m);
    if (m.promotion) action += ` and becomes a ${NAMES[m.promotion as PieceRef['piece']]}`;
    else if (gain !== null && gain >= VALUE[m.captured]) action += ' for free';
    else if (gain !== null && gain > 0) consequences.push(ahead(gain));
  } else if (castle) action = 'castles';
  else if (m.promotion) action = `turns your pawn into a ${NAMES[m.promotion]}`;
  else if (found.has('develops')) action = `brings your ${NAMES[m.piece]} out`;
  else if (found.has('king_activity')) action = 'brings your king toward the middle';
  else if (found.has('passed_pawn')) action = 'pushes a pawn that no enemy pawn can block or take';
  else if (occupiesCentre && opts.area !== 'endgame') action = `puts your ${NAMES[m.piece]} on the middle square ${m.to}`;
  if (!mate) {
    if (check) consequences.push('gives check');
    if (mateThreat) consequences.push('threatens checkmate');
    if (!m.captured && gain !== null && gain > 0) consequences.push(`wins ${amount(gain)}`);
    // A piece of ours that could be won before, and no longer can (moved away, guarded or freed).
    // Never while giving check: with the opponent in check, legal captures are limited, so "not
    // hanging" proves nothing. With a line, the piece must also survive the reply.
    const hangingAfter = factsAfter.hanging.filter((p) => p.color === color);
    let hangingAfterReply: PieceRef[] = [];
    if (line?.[1]) {
      const c = new Chess(after.fen());
      hangingAfterReply = playUci(c, line[1]) && !c.inCheck() ? hangingOf(c.fen(), color) : [];
    }
    const saved = castle || check ? [] : hangingOf(fenBefore, color).filter((p) => {
      const now = p.square === m.from ? m.to : p.square;
      return !hangingAfter.some((q) => q.square === now) && !hangingAfterReply.some((q) => q.square === now) &&
        !defended.some((d) => d.square === p.square);
    });
    if (saved.length > 0) consequences.push(`deals with the threat to your ${NAMES[saved[0].piece]} on ${saved[0].square}`);
    if (givesKingSquare(before, after, m)) consequences.push('gives your king a safe square');
    if (defended.length > 0) consequences.push(`defends ${joinAnd(defended.slice(0, 2).map((p) => `your ${NAMES[p.piece]} on ${p.square}`))}`);
    if (attacked.length > 0) consequences.push(`attacks ${joinAnd(attacked.slice(0, 2).map((p) => `their ${NAMES[p.piece]} on ${p.square}`))}`);
    if (aimsAt.length > 0 && opts.area !== 'endgame') {
      consequences.push(`aims at the middle square${aimsAt.length > 1 ? 's' : ''} ${joinAnd([...aimsAt].sort())}`);
    }
  }
  const parts = (action ? [action, ...consequences.slice(0, 1)] : consequences.slice(0, 2));
  // One "and" per sentence: parts that already contain one are joined with a comma.
  const effect = parts.length === 0 ? null
    : parts.some((p) => p.includes(' and ')) ? parts.join(', ') : parts.join(' and ');

  const hit = opts.book && stripCheck(opts.book.node.san) === stripCheck(m.san) && opts.book.lineName
    ? { name: opts.book.lineName, idea: opts.book.node.idea }
    : null;
  // Only the rule behind the main reason, so the "why" that follows matches it.
  const main = fundamentals[0];
  const principle = !hit && opts.area === 'opening' && main && PRINCIPLE[main] ? PRINCIPLE[main]! : null;

  const out: Reasons = { opening: hit, principle, fundamentals, effect };
  if (mate) out.checkmate = true;
  if (m.promotion) out.promotion = m.promotion as Reasons['promotion'];
  return out;
}

function firstSentence(text: string): string {
  return /^.*?[.!?](?=\s|$)/.exec(text.trim())?.[0] ?? text.trim();
}

/**
 * At most 3 sentences: what it does here, then the opening or rule, then why that idea works.
 * Null when no checked fact is available: callers then show no explanation rather than filler.
 */
export function reasonText(san: string, r: Reasons): string | null {
  if (r.checkmate) return `${san} is checkmate. That ends the game: you win.`;
  const primary = r.fundamentals[0];
  const idea = r.opening ? firstSentence(r.opening.idea) : null;
  const out: string[] = [];
  if (r.effect) out.push(`${san} ${r.effect}.`);
  else if (r.opening) out.push(`${san} is part of the ${r.opening.name}.`);
  else return null; // a rule with nothing concrete to say about this game is filler
  if (r.promotion) return [...out, PROMOTION_WHY[r.promotion]].join(' ');

  if (r.opening) out.push(r.effect ? `It's part of the ${r.opening.name}.` : idea!);
  else if (r.principle) out.push(`It follows a key opening rule: ${r.principle}.`);
  else if (primary) out.push(`It follows a simple rule: ${RULE[primary]}.`);

  if (primary) out.push(FUNDAMENTAL_WHY[primary]);
  else if (r.opening && r.effect && idea) out.push(idea);
  return out.join(' ');
}
