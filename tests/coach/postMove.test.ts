import { describe, it, expect } from 'vitest';
import { Chess } from 'chess.js';
import { topMoveKind, postMoveTemplate, revealTemplate } from '../../src/coach/postMove';
import type { PostMoveContext } from '../../src/coach/postMove';
import { positionFacts } from '../../src/coach/facts';
import type { Analysis } from '../../src/types';
import type { Verdict } from '../../src/coach/classify';
import { FUNDAMENTAL_WHY, deriveReasons, reasonText } from '../../src/coach/reasons';
import { BANNED_TERMS, findJargon } from '../../src/coach/jargon';
import { betterReason } from '../../src/coach/templates';

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
  const uci = m.from + m.to + (m.promotion ?? '');
  const kind = over.kind ?? null;
  return {
    verdict, move: { san: m.san, uci, fenBefore: fen, fenAfter: c.fen(), color: m.color },
    kind, bookIdea: null, lineName: null, factsAfter: positionFacts(c.fen()),
    reasons: deriveReasons(fen, uci, { book: null, area: verdict.area }),
    bestReasons: kind === null ? deriveReasons(fen, verdict.bestUci, { book: null, area: verdict.area }) : null,
    ...over,
  };
}

describe('postMoveTemplate', () => {
  const start = new Chess().fen();
  it('book: states the reasons, naming the opening', () => {
    const r = deriveReasons(start, 'e2e4', { book: null, area: 'opening' });
    const opening = { ...r, opening: { name: 'Italian Game', idea: 'Claim the centre. Then develop.' } };
    const t = postMoveTemplate(ctx(start, 'e4', { kind: 'book', bookIdea: 'Claim the centre.', reasons: opening }));
    expect(t.summary).toBe('✓ Book move. Do you see why?');
    expect(t.explanation.whatHappened).toContain('e4 puts your pawn on the middle square e4.');
    expect(t.explanation.whatHappened).toContain('Italian Game');
    // A book move keeps its opening idea (first sentence only) instead of the fundamental "why".
    expect(t.explanation.whatHappened).toContain('Claim the centre.');
    expect(t.explanation.whatHappened).not.toContain('Then develop');
    expect(t.explanation.whatHappened).not.toContain(FUNDAMENTAL_WHY.centre);
  });
  it('book falls back to the node idea when there are no checked reasons', () => {
    const none = { opening: null, principle: null, fundamentals: [], effect: null };
    const t = postMoveTemplate(ctx(start, 'e4', { kind: 'book', bookIdea: 'Claim the centre.', reasons: none }));
    expect(t.explanation.whatHappened).toBe('Claim the centre.');
  });
  it('top move 1.Nf3 names the knight, says why, and uses no jargon', () => {
    const t = postMoveTemplate(ctx(start, 'Nf3', { kind: 'top' }));
    expect(t.summary).toBe("✓ That's the top move. Do you see why it works?");
    expect(t.explanation.whatHappened).toMatch(/^Nf3 brings your knight out/);
    expect(t.explanation.whatHappened).toContain('knight');
    expect(t.explanation.whatHappened).toContain(FUNDAMENTAL_WHY.develops);
    for (const term of BANNED_TERMS) expect(t.explanation.whatHappened.toLowerCase()).not.toContain(term);
    expect(findJargon(t.explanation.whatHappened)).toEqual([]);
  });
  it('top with a verified reason', () => {
    const t = postMoveTemplate(ctx('rnbqkbnr/pppp1ppp/8/4p3/4P3/8/PPPP1PPP/RNBQKBNR w KQkq - 0 2', 'Nf3', { kind: 'top' }));
    expect(t.explanation.whatHappened).toMatch(/^Nf3 brings your knight out/);
  });
  it('top reason for a capture', () => {
    // 1.e4 d5: exd5 takes the pawn.
    const t = postMoveTemplate(ctx('rnbqkbnr/ppp1pppp/8/3p4/4P3/8/PPPP1PPP/RNBQKBNR w KQkq - 0 2', 'exd5', { kind: 'top' }));
    expect(t.explanation.whatHappened).toMatch(/^exd5 captures the pawn on d5/);
  });
  it('top reason for a check', () => {
    const t = postMoveTemplate(ctx('4k3/8/8/8/8/8/8/R3K3 w - - 0 1', 'Ra8+', { kind: 'top' }));
    expect(t.explanation.whatHappened).toMatch(/^Ra8\+ gives check/);
    expect(t.explanation.whatHappened).toContain(FUNDAMENTAL_WHY.check_threat);
  });
  it('top reason for a defending move', () => {
    // The black rook on e8 attacks the knight on e4; Rf4 guards it.
    const t = postMoveTemplate(ctx('k3r3/8/8/8/4N3/8/5R2/K7 w - - 0 1', 'Rf4', { kind: 'top' }));
    expect(t.explanation.whatHappened).toMatch(/^Rf4 defends your knight on e4/);
    expect(t.explanation.whatHappened).toContain(FUNDAMENTAL_WHY.defends);
  });
  it('top falls back to the fact-backed note when the reasons say nothing', () => {
    const none = { opening: null, principle: null, fundamentals: [], effect: null };
    const t = postMoveTemplate(ctx('4k3/8/8/8/8/8/8/R3K3 w - - 0 1', 'Ra8+', { kind: 'top', reasons: none }));
    expect(t.explanation.whatHappened).toBe('Ra8+ gives check.');
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
  it('stronger option states the better move\'s reasons and why the idea works', () => {
    const t = postMoveTemplate(ctx(start, 'a3', {}, { bestSan: 'Nf3', bestUci: 'g1f3', refutationSan: ['e5'] }));
    expect(t.explanation.better).toContain('Nf3');
    expect(t.explanation.better).toMatch(/^Nf3 brings your knight out/);
    expect(Object.values(FUNDAMENTAL_WHY).some((w) => t.explanation.better!.includes(w))).toBe(true);
    // What the played move gives up, checked: a3 brings no knight or bishop out.
    expect(t.explanation.whatHappened).toBe('After a3, their best answer is e5. a3 does not bring a knight or bishop out.');
    for (const s of [t.summary, t.explanation.whatHappened, t.explanation.better!]) expect(findJargon(s)).toEqual([]);
  });
  it('stronger option: castling vs a move that does not castle', () => {
    const fen = 'r1bqk2r/pppp1ppp/2n2n2/2b1p3/2B1P3/5N2/PPPP1PPP/RNBQK2R w KQkq - 4 4';
    const t = postMoveTemplate(ctx(fen, 'a3', {}, { bestSan: 'O-O', bestUci: 'e1g1', refutationSan: ['d6'] }));
    expect(t.explanation.better).toMatch(/^O-O castles/);
    expect(t.explanation.better).toContain(FUNDAMENTAL_WHY.king_safety);
    expect(t.explanation.whatHappened).toBe('After a3, their best answer is d6. a3 does not castle.');
  });
  it('stronger option falls back to the engine fact when the better move has no checked reason', () => {
    const v = { bestSan: 'h3', bestUci: 'h2h3', refutationSan: ['e5'] };
    const c = ctx(start, 'a3', {}, v);
    expect(c.bestReasons).not.toBeNull();
    const t = postMoveTemplate(c);
    const mistakeCtx = { verdict: c.verdict, move: c.move, factsAfter: c.factsAfter, themeCount: 0 };
    expect(t.explanation.better).toBe(betterReason(mistakeCtx));
    expect(t.explanation.whatHappened).toBe('After a3, their best answer is e5.');
    const t2 = postMoveTemplate({ ...c, bestReasons: null });
    expect(t2.explanation.better).toBe(betterReason(mistakeCtx));
  });
  it('better: names only their reply, never the user\'s follow-up as "their" move', () => {
    const t = postMoveTemplate(ctx(start, 'a3', {}, { bestSan: 'e4', bestUci: 'e2e4', refutationSan: ['e5', 'Nf3', 'Nc6'] }));
    expect(t.explanation.whatHappened).toBe('After a3, their best answer is e5.');
    expect(t.explanation.whatHappened).not.toContain('Nf3');
  });
});

describe('revealTemplate', () => {
  const start = new Chess().fen();
  const reveal = (fen: string, playedSan: string, bestUci: string, bestSan: string, line?: string[]) => {
    const c = ctx(fen, playedSan, {}, { bestUci, bestSan, flagged: true, severity: 'mistake' });
    const bestReasons = deriveReasons(fen, bestUci, { book: null, area: 'opening', line });
    return revealTemplate({ verdict: c.verdict, move: c.move, bestReasons }, c.factsAfter).explanation.whatHappened;
  };

  it('speaks of the better move in the past conditional', () => {
    const t = reveal(start, 'a3', 'g1f3', 'Nf3');
    expect(t).toMatch(/^Nf3 would have brought your knight out\./);
    expect(t).toContain('It would also have aimed at the middle squares d4 and e5.');
    expect(t).not.toMatch(/\bbrings\b|\baims\b/);
  });

  it('"would have attacked" for an attack', () => {
    const fen = '7k/pp4pp/8/1r6/b7/8/PP2N1PP/6K1 w - - 0 20';
    const c = ctx(fen, 'h3', {}, { bestUci: 'e2c3', bestSan: 'Nc3', area: 'middlegame' });
    const bestReasons = deriveReasons(fen, 'e2c3', { book: null, area: 'middlegame' });
    const t = revealTemplate({ verdict: c.verdict, move: c.move, bestReasons }, c.factsAfter).explanation.whatHappened;
    expect(t).toMatch(/^Nc3 would have attacked their bishop on a4 and their rook on b5\./);
  });

  it('a capture that comes out ahead', () => {
    const fen = '4k3/3q4/8/8/8/8/8/3RK3 w - - 0 40';
    const c = ctx(fen, 'Ke2', {}, { bestUci: 'd1d7', bestSan: 'Rxd7+', area: 'endgame' });
    const bestReasons = deriveReasons(fen, 'd1d7', { book: null, area: 'endgame', line: ['d1d7', 'e8d7', 'e1e2'] });
    const t = revealTemplate({ verdict: c.verdict, move: c.move, bestReasons }, c.factsAfter).explanation.whatHappened;
    expect(t).toMatch(/^Rxd7\+ would have captured the queen on d7 and come out more than a piece ahead\./);
  });

  it('the post-move text for a played move stays in the present', () => {
    expect(reasonText('Nf3', deriveReasons(start, 'g1f3', { book: null, area: 'opening' }))).toMatch(/^Nf3 brings your knight out\./);
  });
});
