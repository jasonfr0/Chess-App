import Anthropic from '@anthropic-ai/sdk';
import { betaZodOutputFormat } from '@anthropic-ai/sdk/helpers/beta/zod';
import { z } from 'zod/v4';
import type { ProfileSummary } from '../types';
import type { Explanation, MistakeContext, PreMoveContext } from './templates';

export const MODEL_IDS = ['claude-sonnet-5-5', 'claude-opus-5-5', 'claude-haiku-5-5'] as const;
export type ModelId = (typeof MODEL_IDS)[number];

export interface FactPacket {
  kind: 'pre_move' | 'mistake';
  fen: string;
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
      kind, fen: c.fen, sanHistory: [c.lastMove.san],
      allowedMoves: allowedFrom([c.lastMove.san], t),
      facts: {
        lastOpponentMove: c.lastMove.san, hanging, forks, material, inCheck,
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
    kind, fen: c.move.fenBefore, sanHistory: [c.move.san],
    allowedMoves: allowedFrom([c.move.san, v.bestSan, ...v.refutationSan], t),
    facts: {
      userMove: c.move.san, bestMove: v.bestSan, refutation: v.refutationSan,
      severity: v.severity, cpLoss: v.cpLoss, area: v.area, theme: v.theme, themeCountBefore: c.themeCount,
      hangingAfter: hanging, forksAfter: forks, materialAfter: material, inCheckAfter: inCheck,
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
- Every claim about the position must come from the facts. Never claim a fork "wins" material; say it "attacks both" pieces. Only call a piece "free" or "hanging" if the facts list it as hanging.
- Keep candidates (san, uci, best) exactly as in the template; you may only improve each note, using only true statements from the template and facts.

Style:
- Plain words. Name the piece and the square, for example "your knight on f6".
- At most 3 sentences per field. Encouraging but direct.
- Use the profile to connect this to the player's recurring habits when it fits, without inventing statistics.

Return only the structured explanation.`;

export interface ClaudeClientLike {
  beta: { messages: { parse(req: unknown, opts?: { signal?: AbortSignal }): Promise<any> } };
}

export async function explainWithClaude(
  packet: FactPacket,
  opts: { client: ClaudeClientLike; model: ModelId; signal?: AbortSignal; timeoutMs?: number },
): Promise<Explanation | null> {
  const timeoutMs = opts.timeoutMs ?? 15000;
  const ctrl = new AbortController();
  const onAbort = () => ctrl.abort();
  if (opts.signal?.aborted) return null;
  opts.signal?.addEventListener('abort', onAbort);
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
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
    const timeout = new Promise<null>((resolve) => {
      timer = setTimeout(() => { ctrl.abort(); resolve(null); }, timeoutMs);
    });
    const aborted = new Promise<null>((resolve) => ctrl.signal.addEventListener('abort', () => resolve(null)));
    const msg = await Promise.race([opts.client.beta.messages.parse(req, { signal: ctrl.signal }), timeout, aborted]);
    if (!msg || msg.stop_reason === 'refusal' || !msg.parsed_output) return null;
    const out = msg.parsed_output as Explanation;
    if (!validateExplanation(out, packet.allowedMoves)) return null;
    // Only prose comes from Claude; the candidate list, uci and best flags are the engine's.
    const tc = packet.template.candidates;
    const candidates = tc?.map((c) => ({ ...c, note: out.candidates?.find((x) => x.san === c.san)?.note ?? c.note }));
    const { candidates: _drop, ...rest } = out;
    return candidates ? { ...rest, candidates } : rest;
  } catch {
    return null;
  } finally {
    if (timer) clearTimeout(timer);
    opts.signal?.removeEventListener('abort', onAbort);
  }
}

export function makeClient(apiKey: string): ClaudeClientLike {
  return new Anthropic({ apiKey, dangerouslyAllowBrowser: true }) as unknown as ClaudeClientLike;
}
