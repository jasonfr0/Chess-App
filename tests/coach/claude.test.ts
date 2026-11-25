import { describe, it, expect, vi } from 'vitest';
import { buildPacket, createExplainer, explainWithClaude, validateClaims, validateExplanation } from '../../src/coach/claude';
import type { ClaudeClientLike, FactPacket } from '../../src/coach/claude';
import type { Explanation, MistakeContext } from '../../src/coach/templates';
import type { ProfileSummary } from '../../src/types';

const profile: ProfileSummary = { topThemes: [{ theme: 'hanging_piece', count: 3 }], gamesPlayed: 5 };
const tmpl: Explanation = { whatHappened: 'You played Nf3.', better: 'Nc3 was better.' };
// White knight on f3 (before and after the user's quiet king move).
const FEN = '4k3/8/8/8/8/5N2/8/4K3 w - - 0 1';
const FEN_AFTER = '4k3/8/8/8/8/5N2/4K3/8 b - - 1 1';
const packet: FactPacket = {
  kind: 'mistake', fen: FEN, fenAfter: FEN_AFTER, hanging: [], sanHistory: ['Nf3'], allowedMoves: ['Nf3', 'Nc3', 'Bxf7+'], facts: {}, template: tmpl, profile,
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
    expect(await explainWithClaude(packet, { client, model: 'claude-sonnet-5-5' })).toEqual({ ok: true, explanation: good });
    expect(reqs[0].model).toBe('claude-sonnet-5-5');
    expect(reqs[0].output_config.effort).toBe('low');
    expect(reqs[0].fallbacks).toBe('default');
    expect(reqs[0].betas).toEqual(['server-side-fallback-2026-07-01']);
    for (const k of ['temperature', 'top_p', 'top_k', 'thinking']) expect(k in reqs[0]).toBe(false);
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
    expect(await explainWithClaude(packet, { client, model: 'claude-sonnet-5-5' })).toEqual({ ok: false, reason: 'invalid' });
  });
  it('never throws, and says why it failed', async () => {
    const m = 'claude-sonnet-5-5' as const;
    const fail = async (result: unknown, timeoutMs?: number) =>
      explainWithClaude(packet, { client: fake(result).client, model: m, timeoutMs });
    const rejecting = (e: unknown) => () => Promise.reject(e);
    const named = (name: string, extra: object = {}) => Object.assign(new Error(name), { name, ...extra });
    expect(await fail({ parsed_output: null })).toEqual({ ok: false, reason: 'invalid' });
    expect(await fail({ stop_reason: 'refusal', parsed_output: good })).toEqual({ ok: false, reason: 'refusal' });
    expect(await fail(rejecting(Object.assign(new Error('401'), { status: 401 })))).toEqual({ ok: false, reason: 'auth' });
    expect(await fail(rejecting(Object.assign(new Error('403'), { status: 403 })))).toEqual({ ok: false, reason: 'auth' });
    expect(await fail(rejecting(named('APIConnectionError')))).toEqual({ ok: false, reason: 'network' });
    expect(await fail(rejecting(new TypeError('Failed to fetch')))).toEqual({ ok: false, reason: 'network' });
    expect(await fail(rejecting(named('APIConnectionTimeoutError')))).toEqual({ ok: false, reason: 'timeout' });
    expect(await fail(rejecting(Object.assign(new Error('529'), { status: 529 })))).toEqual({ ok: false, reason: 'api' });
    expect(await fail(rejecting(Object.assign(new Error('400'), { status: 400 })))).toEqual({ ok: false, reason: 'api' });
    expect(await fail(() => new Promise(() => {}), 50)).toEqual({ ok: false, reason: 'timeout' });
  });
  it('reports aborted when the caller aborts', async () => {
    const ac = new AbortController();
    const p = explainWithClaude(packet, { client: fake(() => new Promise(() => {})).client, model: 'claude-sonnet-5-5', signal: ac.signal });
    ac.abort();
    expect(await p).toEqual({ ok: false, reason: 'aborted' });
  });
});

describe('candidates', () => {
  it('keeps san/uci/best from the template, only taking notes from Claude', async () => {
    const template: Explanation = { whatHappened: 'x', candidates: [
      { san: 'Nf3', uci: 'g1f3', note: 'develops', best: true }, { san: 'Nc3', uci: 'b1c3', note: 'solid', best: false }] };
    const p: FactPacket = { ...packet, allowedMoves: ['Nf3', 'Nc3', 'Bc4'], template };
    const claude: Explanation = { whatHappened: 'ok', candidates: [
      { san: 'Nc3', uci: 'zzzz', note: 'nice', best: true }, { san: 'Nf3', uci: 'b1c3', note: 'good', best: false },
      { san: 'Bc4', uci: 'f1c4', note: 'extra', best: true }] };
    const { client } = fake({ stop_reason: 'end_turn', parsed_output: claude });
    const out = await explainWithClaude(p, { client, model: 'claude-sonnet-5-5' });
    expect(out.ok && out.explanation.candidates).toEqual([
      { san: 'Nf3', uci: 'g1f3', note: 'good', best: true }, { san: 'Nc3', uci: 'b1c3', note: 'nice', best: false }]);
  });
});

describe('validateExplanation', () => {
  it('catches 0-0 castling, lowercase piece moves and promotions', () => {
    expect(validateExplanation({ whatHappened: 'try 0-0 now' }, [])).toBe(false);
    expect(validateExplanation({ whatHappened: 'try 0-0-0' }, ['O-O-O'])).toBe(true);
    expect(validateExplanation({ whatHappened: 'play nf3' }, [])).toBe(false);
    expect(validateExplanation({ whatHappened: 'play nf3' }, ['Nf3'])).toBe(true);
    expect(validateExplanation({ whatHappened: 'push to e8=Q' }, [])).toBe(false);
    expect(validateExplanation({ whatHappened: 'push to e8=Q+' }, ['e8=Q'])).toBe(true);
    expect(validateExplanation({ whatHappened: 'the b4 square and e5' }, [])).toBe(true);
  });
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

describe('validateClaims', () => {
  // Mistake packet: Ne5 left the knight where the d6 pawn takes it for free; the bishop on c3 can be won by the pawn on b4.
  const before = '4k3/8/3p4/8/1p6/2B2N2/8/4K3 w - - 0 1';
  const after = '4k3/8/3p4/4N3/1p6/2B5/8/4K3 b - - 1 1';
  const p: FactPacket = {
    ...packet, fen: before, fenAfter: after, allowedMoves: ['Ne5', 'dxe5'],
    hanging: [
      { square: 'e5', piece: 'n', color: 'w', reason: 'undefended', attacker: { square: 'd6', piece: 'p', color: 'b' } },
      { square: 'c3', piece: 'b', color: 'w', reason: 'attacked_by_lower', attacker: { square: 'b4', piece: 'p', color: 'b' } },
    ],
  };
  const ok = (whatHappened: string) => validateClaims({ whatHappened }, p);

  it('accepts a piece named on a square it stands on before or after the move', () => {
    expect(ok('Your knight on f3 was safe.')).toBe(true);
    expect(ok('Your knight on e5 can be taken.')).toBe(true);
    expect(ok('Their pawns on d6 and b4 are strong.')).toBe(true);
  });
  it('rejects a piece named on a square where it never stands', () => {
    expect(ok('Your knight on e4 can be taken.')).toBe(false);
    expect(ok('Their queen on d6 attacks you.')).toBe(false);
    expect(validateClaims({ whatHappened: 'ok', better: 'Your rook on a1 is idle.' }, p)).toBe(false);
  });
  it('allows "free" and "undefended" only for an undefended piece in the hanging list', () => {
    expect(ok('After Ne5, your knight on e5 is free for them.')).toBe(true);
    expect(ok('The bishop on c3 can be taken for free.')).toBe(false);
    expect(ok('Your bishop on c3 is undefended.')).toBe(false);
    expect(ok('Your bishop on c3 is hanging.')).toBe(true);
    expect(ok('The pawn on d6 is hanging.')).toBe(false);
  });
  it('lets general habits through when they name no piece or square', () => {
    expect(ok('After every move, ask: what is undefended?')).toBe(true);
    expect(validateClaims({ whatHappened: 'x', lesson: 'Left a piece hanging: check what is free.' }, p)).toBe(true);
  });
  it('checks candidate notes too', () => {
    const e = { whatHappened: 'ok', candidates: [{ san: 'Ne5', uci: 'f3e5', note: 'hits the rook on e8', best: true }] };
    expect(validateClaims(e, p)).toBe(false);
  });
});

describe('explainWithClaude claim checks', () => {
  it('discards output that names a piece on the wrong square', async () => {
    const { client } = fake({ stop_reason: 'end_turn', parsed_output: { whatHappened: 'Your bishop on f3 is strong.' } });
    expect(await explainWithClaude(packet, { client, model: 'claude-sonnet-5-5' })).toEqual({ ok: false, reason: 'invalid' });
  });
  it('tells Claude "free" means undefended', async () => {
    const { client, reqs } = fake({ stop_reason: 'end_turn', parsed_output: good });
    await explainWithClaude(packet, { client, model: 'claude-sonnet-5-5' });
    expect(reqs[0].system[0].text).toContain('"free" only if its reason is "undefended"');
  });
});

describe('createExplainer', () => {
  const setup = (opts: { apiKey?: string; result?: unknown; makeClient?: () => Promise<ClaudeClientLike> } = {}) => {
    const offline: boolean[] = [];
    const { client } = fake(opts.result ?? { stop_reason: 'end_turn', parsed_output: good });
    const makeClient = vi.fn(opts.makeClient ?? (async () => client));
    const explain = createExplainer({
      settings: () => ({ apiKey: opts.apiKey ?? 'k', model: 'claude-sonnet-5-5' }),
      makeClient,
      onOffline: (o) => offline.push(o),
    });
    return { explain, offline, makeClient };
  };

  it('returns the explanation and clears the offline state', async () => {
    const { explain, offline } = setup();
    expect(await explain(packet)).toEqual(good);
    expect(offline).toEqual([false]);
  });
  it('without a key does nothing (the panel already shows offline)', async () => {
    const { explain, offline, makeClient } = setup({ apiKey: '' });
    expect(await explain(packet)).toBeNull();
    expect(makeClient).not.toHaveBeenCalled();
    expect(offline).toEqual([]);
  });
  it('goes offline when the SDK cannot load', async () => {
    const { explain, offline } = setup({ makeClient: () => Promise.reject(new TypeError('Failed to fetch dynamically imported module')) });
    expect(await explain(packet)).toBeNull();
    expect(offline).toEqual([true]);
  });
  it('goes offline on network or auth failures', async () => {
    for (const e of [new TypeError('Failed to fetch'), Object.assign(new Error('401'), { status: 401 })]) {
      const { explain, offline } = setup({ result: () => Promise.reject(e) });
      expect(await explain(packet)).toBeNull();
      expect(offline).toEqual([true]);
    }
  });
  it('stays online for a refusal or a rejected (invalid) answer', async () => {
    for (const result of [{ stop_reason: 'refusal', parsed_output: good }, { stop_reason: 'end_turn', parsed_output: { whatHappened: 'Qxh7 wins.' } }]) {
      const { explain, offline } = setup({ result });
      expect(await explain(packet)).toBeNull();
      expect(offline).toEqual([false]);
    }
  });
  it('creates the client once per key', async () => {
    const { explain, makeClient } = setup();
    await explain(packet);
    await explain(packet);
    expect(makeClient).toHaveBeenCalledTimes(1);
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
    expect(p.fen).toBe('f');
    expect(p.fenAfter).toBe('g');
    expect(p.hanging).toEqual([]);
    expect(() => JSON.stringify(p)).not.toThrow();
  });
});
