import { Chess } from 'chess.js';
import type { Move, Square } from 'chess.js';
import type { Analysis, Color, PlayedMove } from '../types';
import { rootPlan, type BookHit } from '../openings/repertoire';
import { pins, positionFacts, principleViolations } from './facts';
import type { PieceRef, PositionFacts } from './facts';
import { moveLeaks } from './leaks';
import { lineScore } from './classify';

/** Everything known before the user's move. `lastMove` is null on move 1 as White. */
export interface QuestionContext {
  fen: string; lastMove: PlayedMove | null; history: PlayedMove[];
  userColor: Color; facts: PositionFacts; analysis: Analysis | null; book: BookHit | null;
}
/** Before-move coaching: what their move did, questions to think about, one optional hint. None names a move. */
export interface PreMoveCoaching { theirMove: string | null; questions: string[]; nudge: string | null }

/** Always true, so they never mislead. */
export const HABIT_QUESTIONS = [
  'What does their last move attack?',
  "What's your most useful move: does it develop, defend or attack?",
] as const satisfies readonly [string, string];

const CHECK_Q = "You're in check. What are all the ways to get out of it?";
const HANGING_Q = 'One of your pieces is under attack and not safely protected. Can you find it?';
const MATE_CHECK_Q = "There's a way to win right now. Look at every check you can give.";
const MATE_QUIET_Q = "There's a way to win right now. Can you find it?";
const WIN_Q = 'Is there anything of theirs you can win?';
const FORK_Q = 'Can one of your pieces attack two things at once?';
const UNDEVELOPED_Q = "Which pieces haven't moved yet?";
const KING_SAFETY_Q = 'Is your king safe yet?';

const OPENING_LAST_MOVE = 12;
/** Mates further away than this are not "right now" for a beginner. */
const MAX_MATE = 3;
const MAX_QUESTIONS = 3;
const MIN_QUESTIONS = 2;
const MAX_TARGETS = 3;

const NAMES: Record<PieceRef['piece'], string> = { p: 'pawn', n: 'knight', b: 'bishop', r: 'rook', q: 'queen', k: 'king' };
const VALUE: Record<PieceRef['piece'], number> = { p: 1, n: 3, b: 3, r: 5, q: 9, k: 100 };
const opposite = (c: Color): Color => (c === 'w' ? 'b' : 'w');

interface Item { question: string; nudge?: string }

function playUci(chess: Chess, uci: string): Move | null {
  try {
    return chess.move({ from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci[4] });
  } catch {
    return null;
  }
}

/** User's material minus the opponent's. */
function balance(fen: string, user: Color): number {
  const m = positionFacts(fen).material;
  return m[user] - m[opposite(user)];
}

function joinList(items: string[]): string {
  return items.length <= 1 ? (items[0] ?? '') : `${items.slice(0, -1).join(', ')} and ${items.at(-1)}`;
}

/** Facts about the opponent's last move, in plain words. Never uses move/put/play/push/bring near a square. */
function describeTheirMove(ctx: QuestionContext, last: PlayedMove): string {
  const board = new Chess(ctx.fen);
  const to = last.uci.slice(2, 4);
  const moved = board.get(to as Square);
  const name = moved ? NAMES[moved.type] : 'piece';
  const parts: string[] = [];

  const before = new Chess(last.fenBefore);
  const target = before.get(to as Square);
  const isEnPassant = !target && last.san.includes('x');
  const captured = target ? NAMES[target.type] : isEnPassant ? 'pawn' : null;
  if (captured) {
    const sq = isEnPassant ? to[0] + last.uci[1] : to;
    parts.push(`Their ${name} took your ${captured} on ${sq}.`);
  } else {
    parts.push(`They played ${last.san}.`);
  }
  if (ctx.facts.inCheck) parts.push("You're in check.");

  // Pins of pawns, and attacks on pawns that are safely guarded, are noise for a beginner.
  const pin = pins(ctx.fen).find(
    (p) => p.pinner.square === to && p.pinned.color === ctx.userColor && p.pinned.piece !== 'p',
  );
  const hangingSquares = new Set(ctx.facts.hanging.map((h) => h.square));
  const targets = ctx.facts
    .attackedBy(last.uci)
    .filter((t) => t.piece !== 'k' && t.square !== pin?.pinned.square)
    .filter((t) => t.piece !== 'p' || hangingSquares.has(t.square))
    .sort((a, b) => VALUE[b.piece] - VALUE[a.piece])
    .slice(0, MAX_TARGETS)
    .map((t) => `your ${NAMES[t.piece]} on ${t.square}`);
  if (targets.length) parts.push(`Their ${name} now attacks ${targets.length === 2 ? 'both ' : ''}${joinList(targets)}.`);
  if (pin) {
    parts.push(`Their ${name} on ${to} now pins your ${NAMES[pin.pinned.piece]} on ${pin.pinned.square} to your ${NAMES[pin.behind.piece]}.`);
  }
  return parts.join(' ');
}

/** The analysis, only if it is for this position (a stale one counts as none). */
function analysisFor(ctx: QuestionContext): Analysis | null {
  return ctx.analysis && ctx.analysis.fen === ctx.fen ? ctx.analysis : null;
}

/** The engine's best line for this position. */
function bestLine(ctx: QuestionContext): Analysis['lines'][number] | null {
  const line = analysisFor(ctx)?.lines[0];
  return line && line.uci.length > 0 ? line : null;
}

function mateItem(ctx: QuestionContext): Item | null {
  const line = bestLine(ctx);
  if (!line || line.mate === null || line.mate <= 0 || line.mate > MAX_MATE) return null;
  const chess = new Chess(ctx.fen);
  const first = playUci(chess, line.uci[0]);
  if (!first) return null;
  const piece = NAMES[first.piece];
  return chess.isCheck()
    ? { question: MATE_CHECK_Q, nudge: `Look at checks with your ${piece}.` }
    : { question: MATE_QUIET_Q, nudge: `Look at what your ${piece} could reach.` };
}

/** The user must be clearly better in the engine line (side-to-move POV) for "win" to be true. */
const WIN_MIN_EVAL = 100;

/**
 * An opponent piece the user can win: the engine's best move captures it, the user is still ahead
 * in material after the opponent's first reply (so a recapture counts), and the engine rates the line
 * at least +1 pawn for the user (never a mate against them). Without analysis there is no win
 * question: the facts alone cannot tell a free piece from a trap.
 */
function winItem(ctx: QuestionContext): Item | null {
  const line = bestLine(ctx);
  if (!line || lineScore(line) < WIN_MIN_EVAL) return null;
  const chess = new Chess(ctx.fen);
  const first = playUci(chess, line.uci[0]);
  if (!first?.captured) return null;
  const square = first.isEnPassant() ? first.to[0] + first.from[1] : first.to;
  const start = balance(ctx.fen, ctx.userColor);
  if (line.uci.length > 1) {
    if (!playUci(chess, line.uci[1])) return null;
  } else if (!ctx.facts.hanging.some((h) => h.square === square && h.color !== ctx.userColor)) {
    return null; // no reply in the line: only trust the capture if the piece was hanging anyway
  }
  if (balance(chess.fen(), ctx.userColor) <= start) return null;
  return { question: WIN_Q, nudge: `Look at their ${NAMES[first.captured]} on ${square}.` };
}

function forkItem(ctx: QuestionContext): Item | null {
  const line = bestLine(ctx);
  if (!line) return null;
  const chess = new Chess(ctx.fen);
  const first = playUci(chess, line.uci[0]);
  if (!first) return null;
  const forks = positionFacts(chess.fen()).forks;
  if (!forks.some((f) => f.attacker.square === first.to && f.attacker.color === ctx.userColor)) return null;
  return { question: FORK_Q, nudge: `Look at what your ${NAMES[first.promotion ?? first.piece]} could reach.` };
}

/** The opening plan text for this position, per the repertoire. */
function planText(ctx: QuestionContext): string | null {
  if (ctx.book) return ctx.book.node.plan ?? null;
  if (ctx.history.length === 0 && ctx.userColor === 'w') return rootPlan('w');
  const userMoves = ctx.history.filter((m) => m.color === ctx.userColor).length;
  if (ctx.userColor === 'b' && userMoves === 0) return rootPlan('b');
  return null;
}

function openingItems(ctx: QuestionContext): Item[] {
  const fullmove = Number(ctx.fen.split(' ')[5] ?? '1');
  if (!ctx.book && fullmove > OPENING_LAST_MOVE) return [];
  const out: Item[] = [];
  const plan = planText(ctx);
  if (plan) out.push({ question: plan, nudge: plan });
  const v = principleViolations(ctx.history, ctx.userColor);
  if (v.includes('undeveloped') || v.includes('early_queen')) out.push({ question: UNDEVELOPED_Q });
  if (v.includes('king_safety')) out.push({ question: KING_SAFETY_Q });
  return out;
}

export function preMoveCoaching(ctx: QuestionContext): PreMoveCoaching {
  const allowed = ctx.lastMove ? [ctx.lastMove.san] : [];
  const safe = (s: string | null | undefined): s is string => !!s && moveLeaks(s, allowed).length === 0;

  let theirMove: string | null = null;
  if (ctx.lastMove) {
    const idea = ctx.book?.node.idea;
    theirMove = safe(idea) ? idea : describeTheirMove(ctx, ctx.lastMove);
    if (!safe(theirMove)) theirMove = null;
  }

  const items: Item[] = [];
  if (ctx.facts.inCheck) items.push({ question: CHECK_Q });
  const mine = ctx.facts.hanging
    .filter((h) => h.color === ctx.userColor)
    .sort((a, b) => VALUE[b.piece] - VALUE[a.piece])[0];
  if (mine) items.push({ question: HANGING_Q, nudge: `Look at your ${NAMES[mine.piece]} on ${mine.square}.` });
  for (const make of [mateItem, winItem, forkItem]) {
    const it = make(ctx);
    if (it) items.push(it);
  }
  items.push(...openingItems(ctx));

  const chosen = items.filter((i) => safe(i.question)).slice(0, MAX_QUESTIONS);
  const habits = HABIT_QUESTIONS.filter((q) => ctx.lastMove || q !== HABIT_QUESTIONS[0]);
  for (const q of habits) if (chosen.length < MIN_QUESTIONS) chosen.push({ question: q });

  const questions = [...new Set(chosen.map((i) => i.question))];
  const nudge = chosen.map((i) => i.nudge).find(safe) ?? null;
  return { theirMove, questions, nudge };
}
