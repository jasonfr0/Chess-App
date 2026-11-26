import { Chess } from 'chess.js';
import type { Analysis, PlayedMove } from '../types';
import type { Verdict } from './classify';
import { lineScore } from './classify';
import type { PositionFacts } from './facts';
import { betterReason, moveNote } from './templates';
import type { Explanation, MistakeContext } from './templates';

export type TopKind = 'book' | 'top' | null;

/** The played move is "top" when the engine's best or within this many cp of it (side-to-move POV). */
const TOP_WINDOW = 20;

export function topMoveKind(before: Analysis, moveUci: string, inBook: boolean): TopKind {
  if (inBook) return 'book';
  const lines = before.lines.filter((l) => l.uci.length > 0);
  if (lines.length === 0) return null;
  const best = Math.max(...lines.map(lineScore));
  const played = lines.find((l) => l.uci[0] === moveUci);
  return played && best - lineScore(played) <= TOP_WINDOW ? 'top' : null;
}

export interface PostMoveContext {
  verdict: Verdict; move: PlayedMove; kind: TopKind;
  bookIdea: string | null; lineName: string | null; factsAfter: PositionFacts;
}

/** Only fact-backed reasons: a chess.js-verified note, else the engine's own line. */
function topReason(ctx: PostMoveContext): string {
  const { move, verdict } = ctx;
  try {
    const m = new Chess(move.fenBefore).move({
      from: move.uci.slice(0, 2), to: move.uci.slice(2, 4), promotion: move.uci[4],
    });
    const note = moveNote(move.fenBefore, m);
    if (note !== 'a solid move') return `${move.san} ${note}.`;
  } catch {
    /* fall through to the engine sentence */
  }
  const reply = verdict.refutationSan[0];
  const line = reply ? `${move.san}, ${reply}` : move.san;
  return `It keeps the engine's preferred plan going: ${line}.`;
}

export function postMoveTemplate(ctx: PostMoveContext): { summary: string; explanation: Explanation } {
  const { kind, move, verdict } = ctx;
  if (kind === 'book') {
    return {
      summary: '✓ Book move. Do you see why?',
      explanation: { whatHappened: ctx.bookIdea ?? `${move.san} is a main-line move here.` },
    };
  }
  if (kind === 'top') {
    return {
      summary: "✓ That's the top move. Do you see why it works?",
      explanation: { whatHappened: topReason(ctx) },
    };
  }
  const mistakeCtx: MistakeContext = { verdict, move, factsAfter: ctx.factsAfter, themeCount: 0 };
  const reply = verdict.refutationSan[0];
  const gives = reply
    ? `After ${move.san}, the engine's best answer for them is ${verdict.refutationSan.join(', ')}.`
    : `You played ${move.san}.`;
  return {
    summary: `Your move: ${move.san}. A stronger option was ${verdict.bestSan}.`,
    explanation: { whatHappened: gives, better: betterReason(mistakeCtx) },
  };
}
