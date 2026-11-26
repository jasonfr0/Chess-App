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
  const v = (cpLoss: number) => ({ cpLoss });
  it('top for lines[0]', () => expect(topMoveKind(a, 'e2e4', false, v(0))).toBe('top'));
  it('top within 20 cp', () => expect(topMoveKind(a, 'd2d4', false, v(0))).toBe('top'));
  it('null at 25 cp below', () => expect(topMoveKind(a, 'a2a3', false, v(0))).toBeNull());
  it('null when absent and the verdict says it lost more than 20 cp', () =>
    expect(topMoveKind(a, 'h2h3', false, v(80))).toBeNull());
  it('book regardless', () => expect(topMoveKind(a, 'h2h3', true, v(500))).toBe('book'));
  it('handles mate lines', () => {
    const m = an([{ u: 'e2e4', mate: 2 }, { u: 'd2d4', cp: 900 }]);
    expect(topMoveKind(m, 'd2d4', false, v(0))).toBeNull();
  });
  it('exactly 20 cp below best is top; 21 is not', () => {
    const b = an([{ u: 'e2e4', cp: 50 }, { u: 'd2d4', cp: 30 }, { u: 'c2c4', cp: 29 }]);
    expect(topMoveKind(b, 'd2d4', false, v(0))).toBe('top');
    expect(topMoveKind(b, 'c2c4', false, v(0))).toBeNull();
  });
  it('a move missing from the multipv lines is top when the verdict puts it within 20 cp', () => {
    expect(topMoveKind(a, 'g1f3', false, v(20))).toBe('top');
    expect(topMoveKind(a, 'g1f3', false, v(5))).toBe('top');
    expect(topMoveKind(a, 'g1f3', false, v(21))).toBeNull();
  });
  it('never top when the move could not be analysed', () =>
    expect(topMoveKind(a, 'g1f3', false, { cpLoss: 0, analysed: false })).toBeNull());
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
  it('top reason for a capture', () => {
    // 1.e4 d5: exd5 takes the pawn.
    const t = postMoveTemplate(ctx('rnbqkbnr/ppp1pppp/8/3p4/4P3/8/PPPP1PPP/RNBQKBNR w KQkq - 0 2', 'exd5', { kind: 'top' }));
    expect(t.explanation.whatHappened).toBe('exd5 captures the pawn on d5.');
  });
  it('top reason for a check', () => {
    const t = postMoveTemplate(ctx('4k3/8/8/8/8/8/8/R3K3 w - - 0 1', 'Ra8+', { kind: 'top' }));
    expect(t.explanation.whatHappened).toBe('Ra8+ gives check.');
  });
  it('top reason for a defending move', () => {
    // The black rook on e8 attacks the knight on e4; Rf4 guards it.
    const t = postMoveTemplate(ctx('k3r3/8/8/8/4N3/8/5R2/K7 w - - 0 1', 'Rf4', { kind: 'top' }));
    expect(t.explanation.whatHappened).toBe('Rf4 defends your knight on e4.');
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
  it('better: names only their reply, never the user\'s follow-up as "their" move', () => {
    const t = postMoveTemplate(ctx(start, 'a3', {}, { bestSan: 'e4', bestUci: 'e2e4', refutationSan: ['e5', 'Nf3', 'Nc6'] }));
    expect(t.explanation.whatHappened).toBe('After a3, their best answer is e5.');
    expect(t.explanation.whatHappened).not.toContain('Nf3');
  });
});
