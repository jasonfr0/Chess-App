import { Chess } from 'chess.js';
import type { Analysis, Area, Color, EngineLine } from '../types';
import { bookReplies, lookup } from '../openings/repertoire';
import type { RepertoireNode } from '../openings/repertoire';
import { deriveReasons, reasonText } from '../coach/reasons';
import type { Reasons } from '../coach/reasons';
import { lineScore } from '../coach/classify';
import { uciLineToSan } from '../coach/facts';
import type { WatchPly } from '../coach/watch';

export interface TeachOption { uci: string; san: string; reason: string; watch: WatchPly[] | null }

/** Out of book, a line is an option when it is at most this much worse than the best line. */
export const OPTION_MARGIN_CP = 50;
export const MAX_OPTIONS = 3;
export const PREVIEW_PLIES = 6;
/** The best move's reason when no checked reason can be derived for it. */
export const NO_REASON = 'This is the strongest move here. Watch the line to see where it leads.';

const capitalise = (t: string) => t.charAt(0).toUpperCase() + t.slice(1);

/**
 * The UI prints "{san} – {reason}", so a reason must not open with the move again: "Qxf7 is checkmate. …"
 * becomes "Checkmate. …", "Nc3 brings your knight out…" becomes "Brings your knight out…".
 */
export function afterDash(san: string, text: string | null): string | null {
  if (text === null) return null;
  if (!text.startsWith(`${san} `)) return text;
  const rest = text.slice(san.length + 1);
  if (rest.startsWith('is checkmate.')) return `Checkmate.${rest.slice('is checkmate.'.length)}`;
  return capitalise(rest.startsWith('is ') ? rest.slice(3) : rest);
}

/** Replays `line` from `fen` (user to move): first ply by 'user', alternating. Null when fewer than 2 plies replay. Capped at PREVIEW_PLIES. */
export function previewLine(fen: string, line: string[]): WatchPly[] | null {
  let chess: Chess;
  try {
    chess = new Chess(fen);
  } catch {
    return null;
  }
  const plies: WatchPly[] = [];
  for (const uci of line.slice(0, PREVIEW_PLIES)) {
    let san: string;
    try {
      san = chess.move({ from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci[4] }).san;
    } catch {
      break; // an unplayable move ends the line; never guess
    }
    plies.push({ uci, san, fen: chess.fen(), by: plies.length % 2 === 0 ? 'user' : 'opponent' });
  }
  return plies.length >= 2 ? plies : null;
}

export interface TeachChoice {
  inBook: boolean;
  options: TeachOption[];
  /** Checked reasons of options[0]; null when there are no options. */
  bestReasons: Reasons | null;
}

type Input = {
  fen: string; userColor: Color; sanHistory: string[]; area: Area; analysis: Analysis | null;
  /** The game began from a custom position: its moves are never the repertoire's, whatever they are. */
  customStart?: boolean;
};

const NONE: TeachChoice = { inBook: false, options: [], bestReasons: null };

function toMove(fen: string): Color | null {
  try {
    return new Chess(fen).turn();
  } catch {
    return null;
  }
}

/** The uci of `san` in `fen`, or null when chess.js rejects it. */
function sanToUci(chess: Chess, san: string): string | null {
  try {
    const m = chess.move(san);
    return m.from + m.to + (m.promotion ?? '');
  } catch {
    return null;
  }
}

/** The book move `node` followed by the repertoire's continuation (main child, else the first), as uci. */
function bookContinuation(fen: string, node: RepertoireNode): string[] {
  const chess = new Chess(fen);
  const out: string[] = [];
  let cur: RepertoireNode | undefined = node;
  while (cur && out.length < PREVIEW_PLIES) {
    const uci = sanToUci(chess, cur.san);
    if (!uci) break;
    out.push(uci);
    cur = cur.children.find((n) => n.main) ?? cur.children[0];
  }
  return out;
}

function bookChoice(input: Input, nodes: RepertoireNode[]): TeachChoice {
  const { fen, userColor, sanHistory, area, analysis } = input;
  const ordered = [...nodes.filter((n) => n.main), ...nodes.filter((n) => !n.main)];
  const options: TeachOption[] = [];
  let bestReasons: Reasons | null = null;
  for (const node of ordered) {
    if (options.length >= MAX_OPTIONS) break;
    const uci = sanToUci(new Chess(fen), node.san);
    if (!uci || options.some((o) => o.uci === uci)) continue;
    const line = analysis?.lines.find((l) => l.uci[0] === uci)?.uci;
    const reasons = deriveReasons(fen, uci, { book: lookup(userColor, [...sanHistory, node.san]), area, line });
    // The position text already names the opening: the reason is the line's own idea.
    const reason = node.idea;
    const watch = (line && previewLine(fen, line)) || previewLine(fen, bookContinuation(fen, node));
    if (options.length === 0) bestReasons = reasons;
    options.push({ uci, san: node.san, reason, watch });
  }
  return { inBook: true, options, bestReasons: options.length > 0 ? bestReasons : null };
}

const isUserMate = (l: EngineLine) => l.mate !== null && l.mate > 0;

function engineChoice(input: Input, analysis: Analysis): TeachChoice {
  const { fen, area } = input;
  const best = analysis.lines[0];
  if (!best) return NONE;
  const bestScore = lineScore(best);
  const mateOnly = isUserMate(best);
  const options: TeachOption[] = [];
  let bestReasons: Reasons | null = null;
  for (const line of analysis.lines) {
    if (options.length >= MAX_OPTIONS) break;
    const uci = line.uci[0];
    if (!uci || options.some((o) => o.uci === uci)) continue;
    if (bestScore - lineScore(line) > OPTION_MARGIN_CP) continue;
    if (mateOnly && !isUserMate(line)) continue;
    const san = uciLineToSan(fen, [uci])[0];
    if (!san) continue;
    const reasons = deriveReasons(fen, uci, { book: null, area, line: line.uci });
    const text = afterDash(san, reasonText(san, reasons));
    const first = options.length === 0;
    if (text === null && !first) continue;
    if (first) bestReasons = reasons;
    options.push({ uci, san, reason: text ?? NO_REASON, watch: previewLine(fen, line.uci) });
  }
  return { inBook: false, options, bestReasons };
}

/**
 * `analysis` null = the engine gave nothing: book options still work; out of book returns no options.
 * A position counts as in book only when the game began from the standard start and at least one
 * repertoire move is legal in it.
 */
export function teachOptions(input: Input): TeachChoice {
  if (toMove(input.fen) !== input.userColor) return NONE;
  const nodes = input.customStart ? [] : bookReplies(input.userColor, input.sanHistory);
  if (nodes.length > 0) {
    const book = bookChoice(input, nodes);
    // No listed move is legal here (a custom start position): this is not the repertoire's position.
    if (book.options.length > 0) return book;
  }
  return input.analysis ? engineChoice(input, input.analysis) : NONE;
}
