import { describe, it, expect } from 'vitest';
import { Chess } from 'chess.js';
import { topMoveKind, postMoveTemplate } from '../../src/coach/postMove';
import type { PostMoveContext } from '../../src/coach/postMove';
import { positionFacts } from '../../src/coach/facts';
import type { Analysis } from '../../src/types';
import type { Verdict } from '../../src/coach/classify';

const an = (lines: { u: string; cp?: number; mate?: number }[]): Analysis => ({
  fen: '', depth: 10, lines: lines.map((l) => ({ uci: [l.u], cp: l.cp ?? null, mate: l.mate ?? null })),
});

describe('topMoveKind', () => {
  const a = an([{ u: 'e2e4', cp: 50 }, { u: 'd2d4', cp: 35 }, { u: 'a2a3', cp: 25 }]);
  it('top for lines[0]', () => expect(topMoveKind(a, 'e2e4', false)).toBe('top'));
  it('top within 20 cp', () => expect(topMoveKind(a, 'd2d4', false)).toBe('top'));
  it('null at 25 cp below', () => expect(topMoveKind(a, 'a2a3', false)).toBeNull());
  it('null when absent', () => expect(topMoveKind(a, 'h2h3', false)).toBeNull());
  it('book regardless', () => expect(topMoveKind(a, 'h2h3', true)).toBe('book'));
  it('handles mate lines', () => {
    const m = an([{ u: 'e2e4', mate: 2 }, { u: 'd2d4', cp: 900 }]);
    expect(topMoveKind(m, 'd2d4', false)).toBeNull();
  });
});

function ctx(fen: string, san: string, over: Partial<PostMoveContext> = {}, v: Partial<Verdict> = {}): PostMoveContext {
  const c = new Chess(fen);
  const m = c.move(san);
  const verdict: Verdict = {
    flagged: false, severity: 'ok', cpLoss: 0, area: 'opening', theme: 'other', recommendation: 'play_on',
    bestUci: 'g1f3', bestSan: 'Nf3', refutationSan: [], ...v,
  };
  return {
    verdict, move: { san: m.san, uci: m.from + m.to, fenBefore: fen, fenAfter: c.fen(), color: m.color },
    kind: null, bookIdea: null, lineName: null, factsAfter: positionFacts(c.fen()), ...over,
  };
}

describe('postMoveTemplate', () => {
  const start = new Chess().fen();
  it('book', () => {
    const t = postMoveTemplate(ctx(start, 'e4', { kind: 'book', bookIdea: 'Claim the centre.' }));
    expect(t.summary).toBe('✓ Book move. Do you see why?');
    expect(t.explanation.whatHappened).toBe('Claim the centre.');
  });
  it('top with a verified reason', () => {
    const t = postMoveTemplate(ctx('rnbqkbnr/pppp1ppp/8/4p3/4P3/8/PPPP1PPP/RNBQKBNR w KQkq - 0 2', 'Nf3', { kind: 'top' }));
    expect(t.summary).toBe("✓ That's the top move. Do you see why it works?");
    expect(t.explanation.whatHappened).toMatch(/develops your knight/);
  });
  it('top falls back to the engine line', () => {
    const t = postMoveTemplate(ctx(start, 'a3', { kind: 'top' }, { refutationSan: ['e5', 'Nf3'] }));
    expect(t.explanation.whatHappened).toBe("It keeps the engine's preferred plan going: a3, e5.");
  });
  it('better', () => {
    const t = postMoveTemplate(ctx(start, 'a3', {}, { bestSan: 'e4', bestUci: 'e2e4', refutationSan: ['e5'] }));
    expect(t.summary).toBe('Your move: a3. A stronger option was e4.');
    expect(t.explanation.better).toContain('e4');
    expect(t.explanation.whatHappened).toContain('e5');
  });
});
