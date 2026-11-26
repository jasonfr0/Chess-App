import { Chess } from 'chess.js';
import type { Square } from 'chess.js';
import { z } from 'zod/v4';
import type { ProfileSummary } from '../types';
import { positionFacts } from './facts';
import type { HangingPiece } from './facts';
import type { Explanation, MistakeContext } from './templates';
import type { PostMoveContext, RevealContext } from './postMove';
import { BANNED_TERMS, findJargon } from './jargon';
import { firstSentence } from './reasons';
import type { Reasons } from './reasons';

export const MODEL_IDS = ['claude-sonnet-5-5', 'claude-opus-5-5', 'claude-haiku-5-5'] as const;
export type ModelId = (typeof MODEL_IDS)[number];

export interface FactPacket {
  kind: 'post_move' | 'mistake';
  /** The position before the user's move. */
  fen: string;
  /** The position after the user's move. */
  fenAfter?: string;
  /** Pieces the opponent can win in `fenAfter`. */
  hanging: HangingPiece[];
  sanHistory: string[];
  allowedMoves: string[]; // every SAN Claude may mention
  facts: Record<string, unknown>;
  template: Explanation;
  profile: ProfileSummary;
  /** post_move: the checked reasons for the played move. */
  reasons?: Reasons;
  /** post_move: the checked reasons for the better move (null when the played move is top or book). */
  bestReasons?: Reasons | null;
}

const SAN_RE = /\b([O0]-[O0](-[O0])?|[KQRBN]?[a-h]?[1-8]?x?[a-h][1-8](=[QRBN])?[+#]?)\b/gi;
export const strip = (s: string) => s.replace(/[+#]/g, '').replace(/0/g, 'O');

/** SAN-like tokens that are really moves: piece-letter start, a capture, or castling. Bare squares are not. */
export function moveTokens(text: string): string[] {
  return (text.match(SAN_RE) ?? []).filter(
    (t) => /^[KQRBN]/.test(t) || (/^[kqrbn]/.test(t) && t.length >= 3) || /[x=]/i.test(t) || /^[O0]-[O0]/.test(t),
  );
}

function explanationStrings(e: Explanation): string[] {
  const out = [e.whatHappened];
  if (e.better) out.push(e.better);
  if (e.lesson) out.push(e.lesson);
  return out;
}

/** True when a SAN token (as found by moveTokens) is in the allowed set, ignoring check marks, 0-0 spelling and piece-letter case. */
export function isAllowedToken(t: string, ok: Set<string>): boolean {
  const n = strip(t);
  return ok.has(n) || ok.has(n[0].toUpperCase() + n.slice(1));
}

export function validateExplanation(e: Explanation, allowed: string[]): boolean {
  const ok = new Set(allowed.map(strip));
  for (const s of explanationStrings(e)) {
    for (const t of moveTokens(s)) {
      if (!isAllowedToken(t, ok)) return false;
    }
  }
  return true;
}

const PIECE_WORDS: Record<string, string> = { pawn: 'p', knight: 'n', bishop: 'b', rook: 'r', queen: 'q', king: 'k' };
const PIECE_ON_RE = /\b(pawn|knight|bishop|rook|queen|king)s? on ([a-h][1-8])\b/gi;
const SQUARE_RE = /\b[a-h][1-8]\b/g;
const PIECE_WORD_RE = /\b(pawn|knight|bishop|rook|queen|king)s?\b/i;

function boardOf(fen: string | undefined): Chess | null {
  if (!fen) return null;
  try { return new Chess(fen); } catch { return null; }
}

/**
 * Squares and pieces in prose must match the packet (spec §8):
 * - "<piece> on <square>" needs that piece type on that square in `fen` or `fenAfter`
 * - a sentence about one particular piece that calls it "hanging" must name a square from the
 *   hanging list, and "free"/"undefended" additionally need that piece's reason to be "undefended".
 * Sentences naming no piece or square (general habits) are not claims about the board.
 */
export function validateClaims(
  e: Explanation, packet: Pick<FactPacket, 'fen' | 'fenAfter' | 'hanging'>,
): boolean {
  const boards = [packet.fen, packet.fenAfter].map(boardOf).filter((b): b is Chess => b !== null);
  const anyHanging = new Set(packet.hanging.map((h) => h.square));
  const freeHanging = new Set(packet.hanging.filter((h) => h.reason === 'undefended').map((h) => h.square));

  const texts = [e.whatHappened, e.better, e.lesson].filter((t): t is string => t !== undefined);

  for (const text of texts) {
    for (const m of text.matchAll(PIECE_ON_RE)) {
      const type = PIECE_WORDS[m[1].toLowerCase()];
      if (!boards.some((b) => b.get(m[2].toLowerCase() as Square)?.type === type)) return false;
    }
    for (const sentence of text.split(/(?<=[.!?;])\s+/)) {
      const free = /\b(free|undefended)\b/i.test(sentence);
      if (!free && !/\bhang(s|ing)?\b/i.test(sentence)) continue;
      const squares = sentence.toLowerCase().match(SQUARE_RE) ?? [];
      if (squares.length === 0 && !PIECE_WORD_RE.test(sentence)) continue; // a general habit
      const allowed = free ? freeHanging : anyHanging;
      if (!squares.some((sq) => allowed.has(sq))) return false;
    }
  }
  return true;
}

function allowedFrom(explicit: string[], t: Explanation): string[] {
  const set = new Set<string>(explicit.filter(Boolean));
  for (const s of explanationStrings(t)) for (const tok of moveTokens(s)) set.add(tok);
  return [...set];
}

/**
 * Only the opponent's reply from the engine line: refutationSan[1] is the user's own next engine move,
 * which would be named during their next decision.
 */
const opponentReply = (refutationSan: string[]) => refutationSan.slice(0, 1);

/** Reasons as sent to Claude: an opening idea keeps only its first sentence (no "Next, …" advice). */
function forPacket(r: Reasons): Reasons {
  return r.opening ? { ...r, opening: { ...r.opening, idea: firstSentence(r.opening.idea) } } : r;
}

export function buildPacket(kind: 'post_move', ctx: PostMoveContext, t: Explanation, p: ProfileSummary): FactPacket;
export function buildPacket(kind: 'mistake', ctx: MistakeContext, t: Explanation, p: ProfileSummary): FactPacket;
export function buildPacket(
  kind: 'post_move' | 'mistake',
  ctx: PostMoveContext | MistakeContext,
  t: Explanation,
  p: ProfileSummary,
): FactPacket {
  if (kind === 'post_move') {
    const c = ctx as PostMoveContext;
    const v = c.verdict;
    const reply = opponentReply(v.refutationSan);
    const { hanging, forks, material, inCheck } = c.factsAfter;
    return {
      kind, fen: c.move.fenBefore, fenAfter: c.move.fenAfter, hanging, sanHistory: [c.move.san],
      allowedMoves: allowedFrom([c.move.san, v.bestSan, ...reply], t),
      facts: {
        userMove: c.move.san, playedMoveIs: c.kind === 'book' ? 'book' : c.kind === 'top' ? 'top' : 'not_top',
        bestMove: v.bestSan, refutation: reply, cpLoss: v.cpLoss, area: v.area,
        bookIdea: c.bookIdea, bookLine: c.lineName,
        forksAfter: forks, materialAfter: material, inCheckAfter: inCheck,
      },
      template: t, profile: p, reasons: forPacket(c.reasons), bestReasons: c.bestReasons && forPacket(c.bestReasons),
    };
  }
  // The mistake card is shown while the user decides: the better move is not in the packet at all.
  const c = ctx as MistakeContext;
  const v = c.verdict;
  const reply = opponentReply(v.refutationSan);
  const { forks, material, inCheck } = c.factsAfter;
  // Only the user's own pieces: an enemy piece left hanging is a capture they missed (the better move).
  const hanging = c.factsAfter.hanging.filter((h) => h.color === c.move.color);
  return {
    kind, fen: c.move.fenBefore, fenAfter: c.move.fenAfter, hanging, sanHistory: [c.move.san],
    allowedMoves: [c.move.san, ...reply],
    facts: {
      userMove: c.move.san, refutation: reply,
      severity: v.severity, cpLoss: v.cpLoss, area: v.area, theme: v.theme, themeCountBefore: c.themeCount,
      forksAfter: forks, materialAfter: material, inCheckAfter: inCheck,
    },
    template: t, profile: p,
  };
}

/**
 * The packet for a reveal of the better move (Show me, or after Play on): a post_move packet from the
 * position before the mistake, naming only the better move and holding only its reasons. Nothing
 * about the user's move, the reply or any later move.
 */
export function buildRevealPacket(ctx: RevealContext, t: Explanation, p: ProfileSummary): FactPacket {
  const v = ctx.verdict;
  return {
    // No fenAfter: "hanging" is what the user could have won in the position before their move.
    kind: 'post_move', fen: ctx.move.fenBefore, sanHistory: [],
    hanging: positionFacts(ctx.move.fenBefore).hanging.filter((h) => h.color !== ctx.move.color),
    allowedMoves: [v.bestSan],
    facts: { reveal: true, bestMove: v.bestSan, area: v.area },
    template: t, profile: p, bestReasons: forPacket(ctx.bestReasons),
  };
}

const explanationSchema = z.object({
  whatHappened: z.string(),
  better: z.string().optional(),
  lesson: z.string().optional(),
});

const BANNED_LIST = BANNED_TERMS.map((t) => `"${t}"`).join(', ');

const SYSTEM_PROMPT = `You are a patient chess coach for a beginner rated about 350. They know how the pieces move, but not chess words. You receive a JSON fact packet and rewrite its "template" explanation in warmer, clearer words.

Explain only the given reasons:
- The reasons are in the template, and for kind "post_move" also in "reasons" (the played move) and "bestReasons" (the better move). Each was checked with the engine or the rules of chess.
- Never add a reason of your own. If the template gives one reason, give one reason.
- For kind "post_move": explain why the played move works (playedMoveIs "top" or "book") or why the stronger move is better than the played one ("not_top").
- When facts.reveal is true, the user asked to see the better move: explain only why bestMove is good, from "bestReasons". For a reveal there is no "fenAfter": "hanging" lists their pieces that can be won in "fen".
- For kind "mistake": never name or hint at a better move. The user may take the move back and look for it themselves.

Truth rule (strict):
- Mention only moves listed in allowedMoves. Never calculate new lines or invent variations, and never contradict the facts.
- Never suggest what the user should play next: the game goes on, and their next move is theirs to find.
- Every claim about the position must come from the facts. Never claim a fork "wins" material; say it "attacks" the pieces.
- "hanging" lists the pieces the opponent can win in "fenAfter" (the position after the user's move, for both post_move and mistake). Only call a piece "hanging" if it is in that list, and name its square. Call a piece "free" only if its reason is "undefended". A piece with reason "attacked_by_lower" is defended, but the attacker is worth less, so it "can be won" — never say it is free.
- When you write "<piece> on <square>", that piece must stand on that square in "fen" or "fenAfter".
- For the better move, describe pieces only where they stand now (it was not played).

How to write for this player:
- Short sentences. Everyday words. Name the real piece and square, for example "your knight on f3".
- One idea per sentence. Do not stack clauses with "which", "while" or "thereby".
- At most 3 sentences per field. Encouraging but direct.
- Use the profile to connect this to the player's recurring habits when it fits, without inventing statistics.
- Never use these words or phrases (any answer that uses one is thrown away): ${BANNED_LIST}.

Good example: "Nf3 brings your knight out. It also attacks their pawn on e5. Getting your knights and bishops out early puts more of your army into the fight."

Bad example (never write like this; it is full of words a beginner does not know): "Nf3 gains a tempo and seizes the initiative, with a positional grip on the centre."

Return only the structured explanation.`;

export interface ClaudeClientLike {
  beta: { messages: { parse(req: unknown, opts?: { signal?: AbortSignal }): Promise<any> } };
}

export type ClaudeFailure = 'network' | 'auth' | 'timeout' | 'refusal' | 'invalid' | 'aborted' | 'api';
export type ClaudeResult = { ok: true; explanation: Explanation } | { ok: false; reason: ClaudeFailure };
/** Failures meaning Claude cannot be reached with this key right now (the "coach offline" dot). */
export const OFFLINE_REASONS: ReadonlySet<ClaudeFailure> = new Set(['network', 'auth', 'timeout']);

function failureOf(e: unknown): ClaudeFailure {
  const status = (e as { status?: unknown } | null)?.status;
  const name = e instanceof Error ? e.name : '';
  if (status === 401 || status === 403) return 'auth';
  if (name === 'APIConnectionTimeoutError') return 'timeout';
  if (name === 'AbortError' || name === 'APIUserAbortError') return 'aborted';
  if (typeof status === 'number') return 'api'; // rate limits, overload, bad requests
  return 'network'; // connection errors, failed fetches, an SDK chunk that could not load
}

/** Never throws: every failure comes back as { ok: false, reason }. */
export async function explainWithClaude(
  packet: FactPacket,
  opts: { client: ClaudeClientLike; model: ModelId; signal?: AbortSignal; timeoutMs?: number },
): Promise<ClaudeResult> {
  const timeoutMs = opts.timeoutMs ?? 15000;
  const ctrl = new AbortController();
  const onAbort = () => ctrl.abort();
  const aborted: ClaudeResult = { ok: false, reason: 'aborted' };
  if (opts.signal?.aborted) return aborted;
  opts.signal?.addEventListener('abort', onAbort);
  let timer: ReturnType<typeof setTimeout> | undefined;
  let timedOut = false;
  try {
    const { betaZodOutputFormat } = await import('@anthropic-ai/sdk/helpers/beta/zod');
    if (ctrl.signal.aborted) return aborted; // aborted while the helper was loading
    const req: Record<string, unknown> = {
      model: opts.model,
      max_tokens: 2000,
      system: [{ type: 'text', text: SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } }],
      messages: [{ role: 'user', content: JSON.stringify(packet) }],
      output_config: { effort: 'low', format: betaZodOutputFormat(explanationSchema) },
    };
    if (opts.model !== 'claude-haiku-5-5') {
      req.betas = ['server-side-fallback-2026-07-01'];
      req.fallbacks = 'default';
    }
    const stopped = new Promise<null>((resolve) => {
      timer = setTimeout(() => { timedOut = true; ctrl.abort(); resolve(null); }, timeoutMs);
      ctrl.signal.addEventListener('abort', () => resolve(null));
    });
    const msg = await Promise.race([opts.client.beta.messages.parse(req, { signal: ctrl.signal }), stopped]);
    if (!msg) return timedOut ? { ok: false, reason: 'timeout' } : aborted;
    if (msg.stop_reason === 'refusal') return { ok: false, reason: 'refusal' };
    if (!msg.parsed_output) return { ok: false, reason: 'invalid' };
    const out = msg.parsed_output as Explanation;
    if (!validateExplanation(out, packet.allowedMoves) || !validateClaims(out, packet)) return { ok: false, reason: 'invalid' };
    if (explanationStrings(out).some((s) => findJargon(s).length > 0)) return { ok: false, reason: 'invalid' };
    const { whatHappened, better, lesson } = out; // prose fields only
    return { ok: true, explanation: { whatHappened, ...(better !== undefined ? { better } : {}), ...(lesson !== undefined ? { lesson } : {}) } };
  } catch (e) {
    if (timedOut) return { ok: false, reason: 'timeout' };
    if (ctrl.signal.aborted) return aborted;
    return { ok: false, reason: failureOf(e) };
  } finally {
    if (timer) clearTimeout(timer);
    opts.signal?.removeEventListener('abort', onAbort);
  }
}

/**
 * The coach's `explain` dependency: builds the client once per key, calls Claude, and reports whether
 * Claude is unreachable (`onOffline(true)` on network/auth/timeout or an SDK that cannot load;
 * `onOffline(false)` when Claude answered, even with a refusal or an answer we discarded).
 */
export function createExplainer(deps: {
  settings: () => { apiKey: string; model: ModelId };
  makeClient?: (apiKey: string) => Promise<ClaudeClientLike>;
  onOffline: (offline: boolean) => void;
}): (packet: FactPacket) => Promise<Explanation | null> {
  const make = deps.makeClient ?? makeClient;
  let cached: { key: string; client: ClaudeClientLike } | null = null;
  return async (packet) => {
    const { apiKey, model } = deps.settings();
    if (!apiKey) return null; // no key: the panel already shows the coach as offline
    try {
      if (cached?.key !== apiKey) cached = { key: apiKey, client: await make(apiKey) };
    } catch {
      deps.onOffline(true);
      return null;
    }
    const out = await explainWithClaude(packet, { client: cached.client, model });
    if (out.ok) {
      deps.onOffline(false);
      return out.explanation;
    }
    if (OFFLINE_REASONS.has(out.reason)) deps.onOffline(true);
    else if (out.reason === 'refusal' || out.reason === 'invalid') deps.onOffline(false);
    return null;
  };
}

/** The SDK is loaded on first use so it stays out of the main bundle. */
export async function makeClient(apiKey: string): Promise<ClaudeClientLike> {
  const { default: Anthropic } = await import('@anthropic-ai/sdk');
  return new Anthropic({ apiKey, dangerouslyAllowBrowser: true }) as unknown as ClaudeClientLike;
}
