import { describe, it, expect, vi } from 'vitest';
import { Chess } from 'chess.js';
import { buildPacket, buildRevealPacket, createExplainer, explainWithClaude, validateClaims, validateExplanation } from '../../src/coach/claude';
import type { ClaudeClientLike, FactPacket } from '../../src/coach/claude';
import type { Explanation, MistakeContext } from '../../src/coach/templates';
import { mistakeTemplate } from '../../src/coach/templates';
import { positionFacts } from '../../src/coach/facts';
import type { ProfileSummary } from '../../src/types';
import { BANNED_TERMS } from '../../src/coach/jargon';
import { deriveReasons } from '../../src/coach/reasons';

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
  it('discards output that uses a banned term, in any field', async () => {
    const outs: Explanation[] = [
      { whatHappened: 'Nf3 gains a tempo on the pawn.' },
      { whatHappened: 'Your knight on f3 is fine.', better: 'Nc3 keeps the Initiative.' },
      { whatHappened: 'Your knight on f3 is fine.', lesson: 'Mind your pawn structure.' },
    ];
    for (const out of outs) {
      const { client } = fake({ stop_reason: 'end_turn', parsed_output: out });
      expect(await explainWithClaude(packet, { client, model: 'claude-sonnet-5-5' })).toEqual({ ok: false, reason: 'invalid' });
    }
  });
  it('keeps the template when Claude uses jargon: the explainer returns null and the coach stays online', async () => {
    const { client } = fake({ stop_reason: 'end_turn', parsed_output: { whatHappened: 'Nf3 wins a tempo.' } });
    const onOffline = vi.fn();
    const explain = createExplainer({
      settings: () => ({ apiKey: 'k', model: 'claude-sonnet-5-5' }), makeClient: async () => client, onOffline,
    });
    expect(await explain(packet)).toBeNull();
    expect(onOffline).toHaveBeenCalledWith(false);
  });
  it('the system prompt is pitched at about 350 and lists every banned term', async () => {
    const { client, reqs } = fake({ stop_reason: 'end_turn', parsed_output: good });
    await explainWithClaude(packet, { client, model: 'claude-sonnet-5-5' });
    const text: string = reqs[0].system[0].text;
    expect(text).toContain('about 350');
    for (const term of BANNED_TERMS) expect(text).toContain(`"${term}"`);
    expect(text).toMatch(/explain only the given reasons/i);
    expect(text).toMatch(/good example/i);
    expect(text).toMatch(/bad example/i);
    expect(text).not.toContain('400');
    expect(text).toContain('For the better move, describe pieces only where they stand now (it was not played)');
  });
  it('reports aborted when the caller aborts', async () => {
    const ac = new AbortController();
    const p = explainWithClaude(packet, { client: fake(() => new Promise(() => {})).client, model: 'claude-sonnet-5-5', signal: ac.signal });
    ac.abort();
    expect(await p).toEqual({ ok: false, reason: 'aborted' });
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
});

describe('templates pass their own claim checks', () => {
  it('a mistake template for a defended piece attacked by a pawn', () => {
    const fenBefore = '4k3/8/2p5/8/P7/2N5/8/4K3 w - - 0 1';
    const c = new Chess(fenBefore);
    c.move('Nb5');
    const move = { san: 'Nb5', uci: 'c3b5', fenBefore, fenAfter: c.fen(), color: 'w' as const };
    const ctx: MistakeContext = {
      verdict: { flagged: true, severity: 'blunder', cpLoss: 300, area: 'middlegame', theme: 'hanging_piece',
        recommendation: 'take_back', bestUci: 'e1e2', bestSan: 'Ke2', refutationSan: ['cxb5', 'axb5'] },
      move, factsAfter: positionFacts(move.fenAfter), themeCount: 0,
    };
    const t = mistakeTemplate(ctx);
    expect(validateClaims(t, buildPacket('mistake', ctx, t, profile))).toBe(true);
  });
});

describe('mistake packet hanging list', () => {
  it('lists only the user\'s own pieces, so a missed capture is never in the packet', () => {
    const fenBefore = 'k7/8/8/3q4/8/4N3/7P/K7 w - - 0 1';
    const c = new Chess(fenBefore);
    c.move('h3');
    const move = { san: 'h3', uci: 'h2h3', fenBefore, fenAfter: c.fen(), color: 'w' as const };
    const factsAfter = positionFacts(move.fenAfter);
    expect(factsAfter.hanging.some((h) => h.square === 'd5')).toBe(true);
    const ctx: MistakeContext = {
      verdict: { flagged: true, severity: 'blunder', cpLoss: 900, area: 'middlegame', theme: 'other',
        recommendation: 'take_back', bestUci: 'e3d5', bestSan: 'Nxd5', refutationSan: ['Qd1+'] },
      move, factsAfter, themeCount: 0,
    };
    const p = buildPacket('mistake', ctx, mistakeTemplate(ctx), profile);
    expect(p.hanging.some((h) => h.square === 'd5')).toBe(false);
    expect(p.hanging.every((h) => h.color === 'w')).toBe(true);
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
  it('tells Claude never to suggest what the user should play next', async () => {
    const { client, reqs } = fake({ stop_reason: 'end_turn', parsed_output: good });
    await explainWithClaude(packet, { client, model: 'claude-sonnet-5-5' });
    expect(reqs[0].system[0].text).toContain('Never suggest what the user should play next');
  });
  it('tells Claude which position "hanging" refers to for post_move and mistake packets', async () => {
    const { client, reqs } = fake({ stop_reason: 'end_turn', parsed_output: good });
    await explainWithClaude(packet, { client, model: 'claude-sonnet-5-5' });
    const text: string = reqs[0].system[0].text;
    expect(text).toContain('"hanging" lists the pieces the opponent can win in "fenAfter" (the position after the user\'s move, for both post_move and mistake)');
    expect(text).not.toContain('pre_move');
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
  it('allows only the user move and the opponent reply from the refutation (never the better move)', () => {
    const ctx = {
      verdict: { flagged: true, severity: 'blunder', cpLoss: 500, area: 'middlegame', theme: 'hanging_piece',
        recommendation: 'take_back', bestUci: 'g1f3', bestSan: 'Nf3', refutationSan: ['Qxh7#', 'Kf8'] },
      move: { san: 'h6', uci: 'h7h6', fenBefore: 'f', fenAfter: 'g', color: 'b' },
      factsAfter: { material: { w: 1, b: 1 }, hanging: [], attackedBy: () => [], forks: [], inCheck: false },
      themeCount: 2,
    } as unknown as MistakeContext;
    const p = buildPacket('mistake', ctx, { whatHappened: 'x' }, profile);
    expect(p.allowedMoves).toEqual(['h6', 'Qxh7#']);
    expect(p.allowedMoves).not.toContain('Kf8');
    expect(JSON.stringify(p.facts)).not.toMatch(/Nf3|g1f3/);
    expect(p.facts.refutation).toEqual(['Qxh7#']);
    expect(p.fen).toBe('f');
    expect(p.fenAfter).toBe('g');
    expect(p.hanging).toEqual([]);
    expect(() => JSON.stringify(p)).not.toThrow();
  });
});

describe('buildPacket post_move', () => {
  it('has kind, fenAfter and the allowed moves', async () => {
    const { postMoveTemplate } = await import('../../src/coach/postMove');
    const c = new Chess();
    const m = c.move('a3');
    const ctx = {
      verdict: { flagged: false, severity: 'ok' as const, cpLoss: 80, area: 'opening' as const, theme: 'other' as const,
        recommendation: 'play_on' as const, bestUci: 'e2e4', bestSan: 'e4', refutationSan: ['e5', 'Nf3'] },
      move: { san: m.san, uci: 'a2a3', fenBefore: new Chess().fen(), fenAfter: c.fen(), color: m.color },
      kind: null, bookIdea: null, lineName: null, factsAfter: positionFacts(c.fen()),
      reasons: deriveReasons(new Chess().fen(), 'a2a3', { book: null, area: 'opening' }),
      bestReasons: deriveReasons(new Chess().fen(), 'e2e4', { book: null, area: 'opening' }),
    };
    const t = postMoveTemplate(ctx).explanation;
    const p = buildPacket('post_move', ctx, t, profile);
    expect(p.kind).toBe('post_move');
    expect(p.fenAfter).toBe(c.fen());
    expect(p.fen).toBe(new Chess().fen());
    for (const s of ['a3', 'e4', 'e5']) expect(p.allowedMoves).toContain(s);
    // refutationSan[1] is the user's own next engine move: never allowed, never in the facts.
    expect(p.allowedMoves).not.toContain('Nf3');
    expect(p.facts.refutation).toEqual(['e5']);
    expect(validateExplanation(t, p.allowedMoves)).toBe(true);
    expect(validateClaims(t, p)).toBe(true);
    expect(p.reasons).toEqual(ctx.reasons);
    expect(p.bestReasons).toEqual(ctx.bestReasons);
    expect(t.better).toMatch(/^e4 puts your pawn on the middle square e4/);
  });
  it('sends only the first sentence of an opening idea in the reasons (no "Next, ..." advice)', async () => {
    const { postMoveTemplate } = await import('../../src/coach/postMove');
    const c = new Chess();
    const m = c.move('a3');
    const opening = { name: 'Italian Game', idea: 'Claim the centre. Next, bring out your bishop.' };
    const base = deriveReasons(new Chess().fen(), 'e2e4', { book: null, area: 'opening' });
    const ctx = {
      verdict: { flagged: false, severity: 'ok' as const, cpLoss: 80, area: 'opening' as const, theme: 'other' as const,
        recommendation: 'play_on' as const, bestUci: 'e2e4', bestSan: 'e4', refutationSan: ['e5'] },
      move: { san: m.san, uci: 'a2a3', fenBefore: new Chess().fen(), fenAfter: c.fen(), color: m.color },
      kind: null, bookIdea: null, lineName: null, factsAfter: positionFacts(c.fen()),
      reasons: { ...deriveReasons(new Chess().fen(), 'a2a3', { book: null, area: 'opening' }), opening },
      bestReasons: { ...base, opening },
    };
    const p = buildPacket('post_move', ctx, postMoveTemplate(ctx).explanation, profile);
    expect(p.reasons?.opening).toEqual({ name: 'Italian Game', idea: 'Claim the centre.' });
    expect(p.bestReasons?.opening).toEqual({ name: 'Italian Game', idea: 'Claim the centre.' });
    expect(JSON.stringify(p.reasons)).not.toContain('Next');
    expect(JSON.stringify(p.bestReasons)).not.toContain('Next');
    expect(ctx.bestReasons.opening.idea).toContain('Next'); // the context itself is not changed
  });
  it('a top move carries its reasons and no better-move reasons', async () => {
    const { postMoveTemplate } = await import('../../src/coach/postMove');
    const c = new Chess();
    const m = c.move('Nf3');
    const ctx = {
      verdict: { flagged: false, severity: 'ok' as const, cpLoss: 0, area: 'opening' as const, theme: 'other' as const,
        recommendation: 'play_on' as const, bestUci: 'g1f3', bestSan: 'Nf3', refutationSan: ['d5'] },
      move: { san: m.san, uci: 'g1f3', fenBefore: new Chess().fen(), fenAfter: c.fen(), color: m.color },
      kind: 'top' as const, bookIdea: null, lineName: null, factsAfter: positionFacts(c.fen()),
      reasons: deriveReasons(new Chess().fen(), 'g1f3', { book: null, area: 'opening' }),
      bestReasons: null,
    };
    const t = postMoveTemplate(ctx).explanation;
    const p = buildPacket('post_move', ctx, t, profile);
    expect(p.reasons).toEqual(ctx.reasons);
    expect(p.bestReasons).toBeNull();
    expect(validateExplanation(t, p.allowedMoves)).toBe(true);
    expect(validateClaims(t, p)).toBe(true);
  });
});

describe('the mistake packet keeps the better move hidden', () => {
  // Ne5?? hangs the knight to dxe5; the engine's better move is Ke2.
  const fenBefore = '4k3/8/3p4/8/8/5N2/8/4K3 w - - 0 1';
  const c = new Chess(fenBefore);
  c.move('Ne5');
  const move = { san: 'Ne5', uci: 'f3e5', fenBefore, fenAfter: c.fen(), color: 'w' as const };
  const ctx: MistakeContext = {
    verdict: { flagged: true, severity: 'blunder', cpLoss: 300, area: 'endgame', theme: 'hanging_piece',
      recommendation: 'take_back', bestUci: 'e1e2', bestSan: 'Ke2', refutationSan: ['dxe5', 'e2e3'] },
    move, factsAfter: positionFacts(move.fenAfter), themeCount: 0,
  };
  const t = mistakeTemplate(ctx);
  const p = buildPacket('mistake', ctx, t, profile);

  it('names only the move and the reply, with no best move anywhere in the packet', () => {
    expect(p.allowedMoves).toEqual(['Ne5', 'dxe5']);
    expect(JSON.stringify(p.facts)).not.toMatch(/Ke2|e1e2/);
    expect(JSON.stringify(p.template)).not.toContain('Ke2');
    expect(validateExplanation(t, p.allowedMoves)).toBe(true);
    expect(validateClaims(t, p)).toBe(true);
  });

  it('a Claude rewrite naming the better move is thrown away', async () => {
    const { client } = fake({ stop_reason: 'end_turn', parsed_output: {
      whatHappened: 'After Ne5, your knight on e5 can be taken by dxe5.', better: 'Ke2 was better.',
    } });
    expect(await explainWithClaude(p, { client, model: 'claude-sonnet-5-5' })).toEqual({ ok: false, reason: 'invalid' });
  });

  it('tells Claude never to name or point at the better move on the mistake card', async () => {
    const { client, reqs } = fake({ stop_reason: 'end_turn', parsed_output: good });
    await explainWithClaude(packet, { client, model: 'claude-sonnet-5-5' });
    expect(reqs[0].system[0].text).toContain('For kind "mistake": never name or hint at a better move');
  });
});

describe('buildRevealPacket', () => {
  const fenBefore = '4k3/8/3p4/8/8/5N2/8/4K3 w - - 0 1';
  const c = new Chess(fenBefore);
  c.move('Ne5');
  const move = { san: 'Ne5', uci: 'f3e5', fenBefore, fenAfter: c.fen(), color: 'w' as const };
  const verdict = { flagged: true, severity: 'blunder' as const, cpLoss: 300, area: 'endgame' as const,
    theme: 'hanging_piece' as const, recommendation: 'take_back' as const, bestUci: 'e1e2', bestSan: 'Ke2',
    refutationSan: ['dxe5', 'e2e3'] };
  const bestReasons = deriveReasons(fenBefore, 'e1e2', { book: null, area: 'endgame' });
  const t: Explanation = { whatHappened: 'Ke2 brings your king toward the middle.' };
  const p = buildRevealPacket({ verdict, move, bestReasons }, t, profile);

  it('is a post_move packet from the position before the mistake, allowing only the better move', () => {
    expect(p.kind).toBe('post_move');
    expect(p.fen).toBe(fenBefore);
    expect(p.fenAfter).toBeUndefined();
    expect(p.allowedMoves).toEqual(['Ke2']);
    expect(p.sanHistory).toEqual([]);
    expect(p.hanging).toEqual([]); // nothing of theirs can be won before Ne5
    expect(p.reasons).toBeUndefined();
    expect(p.bestReasons).toEqual(bestReasons);
    expect(p.facts).toEqual({ reveal: true, bestMove: 'Ke2', area: 'endgame' });
    expect(JSON.stringify(p)).not.toMatch(/Ne5|dxe5|e2e3/);
    expect(validateExplanation(t, p.allowedMoves)).toBe(true);
    expect(validateClaims(t, p)).toBe(true);
  });

  it('a Claude rewrite naming the played move or reply is thrown away', async () => {
    const { client } = fake({ stop_reason: 'end_turn', parsed_output: { whatHappened: 'Ke2 is better than Ne5.' } });
    expect(await explainWithClaude(p, { client, model: 'claude-sonnet-5-5' })).toEqual({ ok: false, reason: 'invalid' });
  });
});

describe('buildRevealPacket hanging pieces', () => {
  it("lists the opponent's pieces that can be won before the mistake, so a true \"free\" rewrite passes", () => {
    // White's Nf3 can take the undefended knight on g5; the user played Kd2 instead.
    const fenBefore = '4k3/8/8/6n1/8/5N2/8/4K3 w - - 0 1';
    const c = new Chess(fenBefore);
    c.move('Kd2');
    const move = { san: 'Kd2', uci: 'e1d2', fenBefore, fenAfter: c.fen(), color: 'w' as const };
    const verdict = { flagged: true, severity: 'blunder' as const, cpLoss: 300, area: 'endgame' as const,
      theme: 'other' as const, recommendation: 'take_back' as const, bestUci: 'f3g5', bestSan: 'Nxg5', refutationSan: [] };
    const bestReasons = deriveReasons(fenBefore, 'f3g5', { book: null, area: 'endgame' });
    const p = buildRevealPacket({ verdict, move, bestReasons }, { whatHappened: 'Nxg5 takes the knight on g5.' }, profile);
    expect(p.hanging.map((h) => [h.square, h.color])).toEqual([['g5', 'b']]);
    expect(validateClaims({ whatHappened: 'Nxg5 takes their knight on g5 for free.' }, p)).toBe(true);
  });

  it('tells Claude where "hanging" points for a reveal', async () => {
    const { client, reqs } = fake({ stop_reason: 'end_turn', parsed_output: good });
    await explainWithClaude(packet, { client, model: 'claude-sonnet-5-5' });
    expect(reqs[0].system[0].text).toContain('For a reveal there is no "fenAfter": "hanging" lists their pieces that can be won in "fen".');
  });
});
