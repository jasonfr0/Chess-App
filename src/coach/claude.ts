import { Chess } from 'chess.js';
import type { Square } from 'chess.js';
import { z } from 'zod/v4';
import type { ProfileSummary } from '../types';
import type { HangingPiece } from './facts';
import type { Explanation, MistakeContext, PreMoveContext } from './templates';

export const MODEL_IDS = ['claude-sonnet-5-5', 'claude-opus-5-5', 'claude-haiku-5-5'] as const;
export type ModelId = (typeof MODEL_IDS)[number];

export interface FactPacket {
  kind: 'pre_move' | 'mistake';
  /** pre_move: the current position. mistake: the position before the user's move. */
  fen: string;
  /** mistake only: the position after the user's move. */
  fenAfter?: string;
  /** pre_move only: the position before the opponent's last move. */
  fenBefore?: string;
  /** Pieces the opponent can win: in `fen` for pre_move, in `fenAfter` for a mistake. */
  hanging: HangingPiece[];
  sanHistory: string[];
  allowedMoves: string[]; // every SAN Claude may mention
  facts: Record<string, unknown>;
  template: Explanation;
  profile: ProfileSummary;
}

const SAN_RE = /\b([O0]-[O0](-[O0])?|[KQRBN]?[a-h]?[1-8]?x?[a-h][1-8](=[QRBN])?[+#]?)\b/gi;
const strip = (s: string) => s.replace(/[+#]/g, '').replace(/0/g, 'O');

/** SAN-like tokens that are really moves: piece-letter start, a capture, or castling. Bare squares are not. */
function moveTokens(text: string): string[] {
  return (text.match(SAN_RE) ?? []).filter(
    (t) => /^[KQRBN]/.test(t) || (/^[kqrbn]/.test(t) && t.length >= 3) || /[x=]/i.test(t) || /^[O0]-[O0]/.test(t),
  );
}

function explanationStrings(e: Explanation): string[] {
  const out = [e.whatHappened];
  if (e.better) out.push(e.better);
  if (e.lesson) out.push(e.lesson);
  for (const c of e.candidates ?? []) out.push(c.san, c.note);
  return out;
}

export function validateExplanation(e: Explanation, allowed: string[]): boolean {
  const ok = new Set(allowed.map(strip));
  for (const s of explanationStrings(e)) {
    for (const t of moveTokens(s)) {
      const n = strip(t);
      if (!ok.has(n) && !ok.has(n[0].toUpperCase() + n.slice(1))) return false;
    }
  }
  for (const c of e.candidates ?? []) if (!ok.has(strip(c.san))) return false;
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
 * - "<piece> on <square>" needs that piece type on that square in `fen`, `fenAfter` or `fenBefore`
 *   (a candidate's note may also describe the position after that candidate);
 * - a sentence about one particular piece that calls it "hanging" must name a square from the
 *   hanging list, and "free"/"undefended" additionally need that piece's reason to be "undefended".
 * Sentences naming no piece or square (general habits) are not claims about the board.
 */
export function validateClaims(
  e: Explanation, packet: Pick<FactPacket, 'fen' | 'fenAfter' | 'fenBefore' | 'hanging'>,
): boolean {
  const boards = [packet.fen, packet.fenAfter, packet.fenBefore].map(boardOf).filter((b): b is Chess => b !== null);
  const afterCandidate = (san: string): Chess[] => {
    const b = boardOf(packet.fen);
    try { b?.move(san); return b ? [b] : []; } catch { return []; }
  };
  const anyHanging = new Set(packet.hanging.map((h) => h.square));
  const freeHanging = new Set(packet.hanging.filter((h) => h.reason === 'undefended').map((h) => h.square));

  const texts: { text: string; boards: Chess[] }[] = [e.whatHappened, e.better, e.lesson]
    .filter((t): t is string => t !== undefined)
    .map((text) => ({ text, boards }));
  for (const c of e.candidates ?? []) texts.push({ text: c.note, boards: [...boards, ...afterCandidate(c.san)] });

  for (const { text, boards: on } of texts) {
    for (const m of text.matchAll(PIECE_ON_RE)) {
      const type = PIECE_WORDS[m[1].toLowerCase()];
      if (!on.some((b) => b.get(m[2].toLowerCase() as Square)?.type === type)) return false;
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
  for (const c of t.candidates ?? []) set.add(c.san);
  for (const s of explanationStrings(t)) for (const tok of moveTokens(s)) set.add(tok);
  return [...set];
}

export function buildPacket(kind: 'pre_move', ctx: PreMoveContext, t: Explanation, p: ProfileSummary): FactPacket;
export function buildPacket(kind: 'mistake', ctx: MistakeContext, t: Explanation, p: ProfileSummary): FactPacket;
export function buildPacket(
  kind: 'pre_move' | 'mistake',
  ctx: PreMoveContext | MistakeContext,
  t: Explanation,
  p: ProfileSummary,
): FactPacket {
  if (kind === 'pre_move') {
    const c = ctx as PreMoveContext;
    const { hanging, forks, material, inCheck } = c.facts;
    return {
      kind, fen: c.fen, fenBefore: c.lastMove.fenBefore, hanging, sanHistory: [c.lastMove.san],
      allowedMoves: allowedFrom([c.lastMove.san], t),
      facts: {
        lastOpponentMove: c.lastMove.san, forks, material, inCheck,
        engineLines: c.analysis.lines.map((l) => ({ cp: l.cp, mate: l.mate })),
        book: c.book ? { lineName: c.book.lineName } : null, level: c.level,
      },
      template: t, profile: p,
    };
  }
  const c = ctx as MistakeContext;
  const v = c.verdict;
  const { hanging, forks, material, inCheck } = c.factsAfter;
  return {
    kind, fen: c.move.fenBefore, fenAfter: c.move.fenAfter, hanging, sanHistory: [c.move.san],
    allowedMoves: allowedFrom([c.move.san, v.bestSan, ...v.refutationSan], t),
    facts: {
      userMove: c.move.san, bestMove: v.bestSan, refutation: v.refutationSan,
      severity: v.severity, cpLoss: v.cpLoss, area: v.area, theme: v.theme, themeCountBefore: c.themeCount,
      forksAfter: forks, materialAfter: material, inCheckAfter: inCheck,
    },
    template: t, profile: p,
  };
}

const candidateSchema = z.object({ san: z.string(), uci: z.string(), note: z.string(), best: z.boolean() });
const explanationSchema = z.object({
  whatHappened: z.string(),
  better: z.string().optional(),
  lesson: z.string().optional(),
  candidates: z.array(candidateSchema).optional(),
});

const SYSTEM_PROMPT = `You are a patient chess coach for a beginner rated about 400. You receive a JSON fact packet and rewrite its "template" explanation in warmer, clearer words.

Truth rule (strict):
- Mention only moves listed in allowedMoves. Never calculate new lines or invent variations, and never contradict the facts.
- Every claim about the position must come from the facts. Never claim a fork "wins" material; say it "attacks" the pieces.
- "hanging" lists the pieces the opponent can win (in "fen" for pre_move, in "fenAfter" for a mistake). Only call a piece "hanging" if it is in that list, and name its square. Call a piece "free" only if its reason is "undefended". A piece with reason "attacked_by_lower" is defended, but the attacker is worth less, so it "can be won" — never say it is free.
- When you write "<piece> on <square>", that piece must stand on that square in "fen", "fenAfter" or "fenBefore" (a candidate's note may also describe the position after that candidate).
- Keep candidates (san, uci, best) exactly as in the template; you may only improve each note, using only true statements from the template and facts.

Style:
- Plain words. Name the piece and the square, for example "your knight on f6".
- At most 3 sentences per field. Encouraging but direct.
- Use the profile to connect this to the player's recurring habits when it fits, without inventing statistics.

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
    // Only prose comes from Claude; the candidate list, uci and best flags are the engine's.
    const tc = packet.template.candidates;
    const candidates = tc?.map((c) => ({ ...c, note: out.candidates?.find((x) => x.san === c.san)?.note ?? c.note }));
    const { candidates: _drop, ...rest } = out;
    return { ok: true, explanation: candidates ? { ...rest, candidates } : rest };
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
