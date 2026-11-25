import { describe, it, expect } from 'vitest';
import { buildPacket, explainWithClaude, validateExplanation } from '../../src/coach/claude';
import type { ClaudeClientLike, FactPacket } from '../../src/coach/claude';
import type { Explanation, MistakeContext } from '../../src/coach/templates';
import type { ProfileSummary } from '../../src/types';

const profile: ProfileSummary = { topThemes: [{ theme: 'hanging_piece', count: 3 }], gamesPlayed: 5 };
const tmpl: Explanation = { whatHappened: 'You played Nf3.', better: 'Nc3 was better.' };
const packet: FactPacket = {
  kind: 'mistake', fen: 'x', sanHistory: ['Nf3'], allowedMoves: ['Nf3', 'Nc3', 'Bxf7+'], facts: {}, template: tmpl, profile,
};
const good: Explanation = { whatHappened: 'Your knight on f3 controls the e5 square.', better: 'Nc3 was stronger; Bxf7+ is not possible.' };

function fake(result: unknown | (() => Promise<unknown>)) {
  const reqs: any[] = [];
  const client: ClaudeClientLike = {
    beta: { messages: { parse: (req: unknown) => { reqs.push(req); return typeof result === 'function' ? (result as any)() : Promise.resolve(result); } } },
  };
  return { client, reqs };
}

describe('explainWithClaude', () => {
  it('returns a valid parsed output and sends the right request for sonnet', async () => {
    const { client, reqs } = fake({ stop_reason: 'end_turn', parsed_output: good });
    expect(await explainWithClaude(packet, { client, model: 'claude-sonnet-5-5' })).toEqual(good);
    expect(reqs[0].model).toBe('claude-sonnet-5-5');
    expect(reqs[0].output_config.effort).toBe('low');
    expect(reqs[0].fallbacks).toBe('default');
    expect(reqs[0].betas).toEqual(['server-side-fallback-2026-07-01']);
    expect('temperature' in reqs[0]).toBe(false);
    expect(reqs[0].system[0].cache_control).toEqual({ type: 'ephemeral' });
  });
  it('omits fallbacks and betas for haiku', async () => {
    const { client, reqs } = fake({ stop_reason: 'end_turn', parsed_output: good });
    await explainWithClaude(packet, { client, model: 'claude-haiku-5-5' });
    expect('fallbacks' in reqs[0]).toBe(false);
    expect('betas' in reqs[0]).toBe(false);
  });
  it('discards output mentioning a move not allowed', async () => {
    const { client } = fake({ stop_reason: 'end_turn', parsed_output: { whatHappened: 'Qxh7 wins.' } });
    expect(await explainWithClaude(packet, { client, model: 'claude-sonnet-5-5' })).toBeNull();
  });
  it('returns null for null output, refusal, rejection, and timeout', async () => {
    const m = 'claude-sonnet-5-5' as const;
    expect(await explainWithClaude(packet, { client: fake({ parsed_output: null }).client, model: m })).toBeNull();
    expect(await explainWithClaude(packet, { client: fake({ stop_reason: 'refusal', parsed_output: good }).client, model: m })).toBeNull();
    const err = Object.assign(new Error('401'), { status: 401 });
    expect(await explainWithClaude(packet, { client: fake(() => Promise.reject(err)).client, model: m })).toBeNull();
    expect(await explainWithClaude(packet, { client: fake(() => new Promise(() => {})).client, model: m, timeoutMs: 50 })).toBeNull();
  });
  it('returns null when the caller aborts', async () => {
    const ac = new AbortController();
    const p = explainWithClaude(packet, { client: fake(() => new Promise(() => {})).client, model: 'claude-sonnet-5-5', signal: ac.signal });
    ac.abort();
    expect(await p).toBeNull();
  });
});

describe('validateExplanation', () => {
  it('treats bare squares in prose as squares', () => {
    expect(validateExplanation({ whatHappened: 'Control the e5 square.' }, [])).toBe(true);
  });
  it('checks captures, castling and piece moves, ignoring check marks', () => {
    expect(validateExplanation({ whatHappened: 'exd5 then O-O' }, ['exd5'])).toBe(false);
    expect(validateExplanation({ whatHappened: 'Bxf7 works' }, ['Bxf7+'])).toBe(true);
  });
  it('validates candidate notes and sans', () => {
    const e: Explanation = { whatHappened: 'ok', candidates: [{ san: 'Nf3', uci: 'g1f3', note: 'then Qxh7', best: true }] };
    expect(validateExplanation(e, ['Nf3'])).toBe(false);
    expect(validateExplanation({ ...e, candidates: [{ ...e.candidates![0], note: 'develops' }] }, ['Nf3'])).toBe(true);
  });
});

describe('buildPacket', () => {
  it('allows the user move, best move and every refutation SAN', () => {
    const ctx = {
      verdict: { flagged: true, severity: 'blunder', cpLoss: 500, area: 'middlegame', theme: 'hanging_piece',
        recommendation: 'take_back', bestUci: 'g1f3', bestSan: 'Nf3', refutationSan: ['Qxh7#', 'Kf8'] },
      move: { san: 'h6', uci: 'h7h6', fenBefore: 'f', fenAfter: 'g', color: 'b' },
      factsAfter: { material: { w: 1, b: 1 }, hanging: [], attackedBy: () => [], forks: [], inCheck: false },
      themeCount: 2,
    } as unknown as MistakeContext;
    const p = buildPacket('mistake', ctx, { whatHappened: 'x' }, profile);
    expect(p.allowedMoves).toEqual(expect.arrayContaining(['h6', 'Nf3', 'Qxh7#', 'Kf8']));
    expect(() => JSON.stringify(p)).not.toThrow();
  });
});
