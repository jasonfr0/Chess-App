import { Chess } from 'chess.js';
import type { Analysis, PlayedMove } from '../types';
import type { Verdict } from './classify';
import { lineScore } from './classify';
import type { PositionFacts } from './facts';
import { betterReason, moveNote } from './templates';
import type { Explanation, MistakeContext } from './templates';
import { reasonText } from './reasons';
import type { Fundamental, Reasons } from './reasons';

export type TopKind = 'book' | 'top' | null;

/** The played move is "top" when the engine's best or within this many cp of it (side-to-move POV). */
const TOP_WINDOW = 20;

/**
 * Book moves always count. Otherwise the gap to the best multipv line when the move is one of them,
 * else the classifier's cpLoss (the move was searched on its own after it was played).
 */
export function topMoveKind(
  before: Analysis, moveUci: string, inBook: boolean, verdict: Pick<Verdict, 'cpLoss' | 'analysed'>,
): TopKind {
  if (inBook) return 'book';
  if (verdict.analysed === false) return null;
  const lines = before.lines.filter((l) => l.uci.length > 0);
  if (lines.length === 0) return null;
  const best = Math.max(...lines.map(lineScore));
  const played = lines.find((l) => l.uci[0] === moveUci);
  const gap = played ? best - lineScore(played) : verdict.cpLoss;
  return gap <= TOP_WINDOW ? 'top' : null;
}

export interface PostMoveContext {
  verdict: Verdict; move: PlayedMove; kind: TopKind;
  bookIdea: string | null; lineName: string | null; factsAfter: PositionFacts;
  /** Checked reasons for the played move. */
  reasons: Reasons;
  /** Checked reasons for the better move; null when the played move is top or book. */
  bestReasons: Reasons | null;
}

/**
 * What the played move gives up, only where the reasons prove it: the better move's main idea is
 * one the played move does not have, and that absence is itself a fact (no knight or bishop left
 * its home square; no castling).
 */
const GIVES_UP: Partial<Record<Fundamental, (san: string) => string>> = {
  develops: (san) => `${san} does not bring a knight or bishop out.`,
  king_safety: (san) => `${san} does not castle.`,
};

function givesUp(ctx: PostMoveContext): string | null {
  const main = ctx.bestReasons?.fundamentals[0];
  const say = main ? GIVES_UP[main] : undefined;
  if (!main || !say || ctx.reasons.fundamentals.includes(main)) return null;
  return say(ctx.move.san);
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
      explanation: {
        whatHappened: reasonText(move.san, ctx.reasons) ?? ctx.bookIdea ?? `${move.san} is a main-line move here.`,
      },
    };
  }
  if (kind === 'top') {
    return {
      summary: "✓ That's the top move. Do you see why it works?",
      explanation: { whatHappened: reasonText(move.san, ctx.reasons) ?? topReason(ctx) },
    };
  }
  const mistakeCtx: MistakeContext = { verdict, move, factsAfter: ctx.factsAfter, themeCount: 0 };
  const reply = verdict.refutationSan[0];
  const answer = reply
    ? `After ${move.san}, their best answer is ${reply}.`
    : `You played ${move.san}.`;
  const why = ctx.bestReasons ? reasonText(verdict.bestSan, ctx.bestReasons) : null;
  const lost = why ? givesUp(ctx) : null;
  return {
    summary: `Your move: ${move.san}. A stronger option was ${verdict.bestSan}.`,
    // Fields stay at 3 sentences or fewer: what the played move gives up goes with what happened.
    explanation: { whatHappened: lost ? `${answer} ${lost}` : answer, better: why ?? betterReason(mistakeCtx) },
  };
}

/** What a reveal ("Show me", or the reveal after Play on) is built from: the mistake and the better move's reasons. */
export interface RevealContext { verdict: Verdict; move: PlayedMove; bestReasons: Reasons }

/**
 * The better move, revealed only after the user asked for it (Show me) or chose Play on. The
 * explanation is the better move's own checked reasons, else the theme's fact-backed sentence.
 */
export function revealTemplate(ctx: RevealContext, factsAfter: PositionFacts): { summary: string; explanation: Explanation } {
  const { verdict, move } = ctx;
  const mistakeCtx: MistakeContext = { verdict, move, factsAfter, themeCount: 0 };
  return {
    summary: `The better move was ${verdict.bestSan}.`,
    explanation: { whatHappened: reasonText(verdict.bestSan, ctx.bestReasons, { past: true }) ?? betterReason(mistakeCtx) },
  };
}
