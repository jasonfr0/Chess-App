import { describe, it, expect } from 'vitest';
import { Chess } from 'chess.js';
import data from '../../src/openings/repertoire.json';
import { lookup, rootPlan, type BookHit, type RepertoireNode } from '../../src/openings/repertoire';
import { positionFacts } from '../../src/coach/facts';
import { moveLeaks } from '../../src/coach/leaks';
import { HABIT_QUESTIONS, preMoveCoaching, type QuestionContext } from '../../src/coach/questions';
import type { Analysis, Color, EngineLine, PlayedMove } from '../../src/types';

const START = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
const CHECK_Q = "You're in check. What are all the ways to get out of it?";
const HANGING_Q = 'One of your pieces is under attack and not safely protected. Can you find it?';
const MATE_Q = "There's a way to win right now. Look at every check you can give.";
const WIN_Q = 'Is there anything of theirs you can win?';
const FORK_Q = 'Can one of your pieces attack two things at once?';
const UNDEVELOPED_Q = "Which pieces haven't moved yet?";

function history(sans: string[], start = START): PlayedMove[] {
  const c = new Chess(start);
  return sans.map((san) => {
    const fenBefore = c.fen();
    const color = c.turn();
    const m = c.move(san);
    return { san: m.san, uci: m.from + m.to + (m.promotion ?? ''), fenBefore, fenAfter: c.fen(), color };
  });
}

/** Context after `sans` from `start`; the user is the side to move. */
function ctxFrom(sans: string[], opts: { start?: string; analysis?: EngineLine | null; book?: BookHit | null } = {}): QuestionContext {
  const h = history(sans, opts.start);
  const fen = h.at(-1)?.fenAfter ?? opts.start ?? START;
  const userColor = new Chess(fen).turn() as Color;
  const analysis: Analysis | null = opts.analysis ? { fen, depth: 12, lines: [opts.analysis] } : null;
  const book = opts.book !== undefined ? opts.book : lookup(userColor, h.map((m) => m.san));
  return { fen, lastMove: h.at(-1) ?? null, history: h, userColor, facts: positionFacts(fen), analysis, book };
}

function allStrings(r: ReturnType<typeof preMoveCoaching>): string[] {
  return [r.theirMove, ...r.questions, r.nudge].filter((s): s is string => s !== null);
}

function expectNoLeaks(ctx: QuestionContext, label: string) {
  const r = preMoveCoaching(ctx);
  const allowed = ctx.lastMove ? [ctx.lastMove.san] : [];
  for (const s of allStrings(r)) expect(moveLeaks(s, allowed), `${label}: ${s}`).toEqual([]);
  expect(r.questions.length, label).toBeGreaterThanOrEqual(2);
  expect(r.questions.length, label).toBeLessThanOrEqual(3);
}

describe('HABIT_QUESTIONS', () => {
  it('are the two spec fallback questions', () => {
    expect(HABIT_QUESTIONS).toEqual([
      'What does their last move attack?',
      "What's your most useful move: does it develop, defend or attack?",
    ]);
  });
});

describe('preMoveCoaching questions', () => {
  it('asks about getting out of check first when in check', () => {
    const r = preMoveCoaching(ctxFrom(['e4', 'f6', 'Qh5+']));
    expect(r.questions[0]).toBe(CHECK_Q);
  });

  it('asks about an own hanging piece without naming it, and the nudge names it', () => {
    // Black's bishop on b5 attacks White's undefended knight on d3.
    const r = preMoveCoaching(ctxFrom(['Bb5'], { start: '4k3/3b4/8/8/8/3N4/8/4K3 b - - 0 30' }));
    expect(r.questions).toContain(HANGING_Q);
    expect(r.questions.join(' ')).not.toMatch(/knight|d3/);
    expect(r.nudge).toBe('Look at your knight on d3.');
  });

  it('also asks when the piece is guarded but attacked by a cheaper piece', () => {
    // Black's pawn on e5 attacks White's knight on d4, which the queen guards.
    const ctx = ctxFrom(['e5'], { start: '4k3/4p3/8/8/3N4/8/8/3QK3 b - - 0 30' });
    expect(ctx.facts.hanging.find((h) => h.color === 'w')?.reason).toBe('attacked_by_lower');
    const r = preMoveCoaching(ctx);
    expect(r.questions).toContain(HANGING_Q);
    expect(r.nudge).toBe('Look at your knight on d4.');
  });

  it('does not ask about a hanging piece when none of yours is hanging', () => {
    const r = preMoveCoaching(ctxFrom(['Ke8'], { start: '3k4/8/8/8/8/8/4P3/4K3 b - - 0 30' }));
    expect(r.questions).not.toContain(HANGING_Q);
    expect(r.questions).not.toContain(CHECK_Q);
    expect(r.questions).not.toContain(WIN_Q);
  });

  it('asks the mate question when the engine sees a mate that starts with a check', () => {
    const c = ctxFrom(['Kh8'], {
      start: '2r3k1/6pp/8/8/8/8/4RPPP/4R1K1 b - - 0 30',
      analysis: { uci: ['e2e8', 'c8e8', 'e1e8'], cp: null, mate: 2 },
    });
    const r = preMoveCoaching(c);
    expect(r.questions).toContain(MATE_Q);
    expect(r.nudge).toBe('Look at checks with your rook.');
  });

  it('does not ask the mate question without an engine mate', () => {
    const r = preMoveCoaching(ctxFrom(['Kh8'], {
      start: '2r3k1/6pp/8/8/8/8/4RPPP/4R1K1 b - - 0 30',
      analysis: { uci: ['h2h3'], cp: 50, mate: null },
    }));
    expect(r.questions).not.toContain(MATE_Q);
  });

  it('does not ask about winning a piece before the analysis arrives: the facts alone cannot tell a trap', () => {
    // Black's bishop on d4 is undefended and White's rook on d1 attacks it, but without the engine
    // the coach cannot know that taking it is safe.
    const r = preMoveCoaching(ctxFrom(['Bd4'], { start: '4k3/8/8/4b3/8/8/8/3RK3 b - - 0 30' }));
    expect(r.questions).not.toContain(WIN_Q);
    expect(r.nudge).not.toBe('Look at their bishop on d4.');
  });

  it('asks about winning a piece when the engine line captures it and gains material', () => {
    const r = preMoveCoaching(ctxFrom(['Bd4'], {
      start: '4k3/8/8/4b3/8/8/8/3RK3 b - - 0 30',
      analysis: { uci: ['d1d4', 'e8e7'], cp: 320, mate: null },
    }));
    expect(r.questions).toContain(WIN_Q);
    expect(r.nudge).toBe('Look at their bishop on d4.');
  });

  it('does not invite a capture when the engine prefers a quiet move', () => {
    const r = preMoveCoaching(ctxFrom(['Bd4'], {
      start: '4k3/8/8/4b3/8/8/8/3RK3 b - - 0 30',
      analysis: { uci: ['e1e2'], cp: 20, mate: null },
    }));
    expect(r.questions).not.toContain(WIN_Q);
    expect(r.nudge).toBeNull();
  });

  it('does not invite a capture that loses material in the engine line', () => {
    // Qxd6 exd6: a queen for a pawn.
    const r = preMoveCoaching(ctxFrom(['Ke8'], {
      start: '3k4/4p3/3p4/8/8/8/8/3QK3 b - - 0 30',
      analysis: { uci: ['d1d6', 'e7d6'], cp: -800, mate: null },
    }));
    expect(r.questions).not.toContain(WIN_Q);
  });

  it('asks the fork question when the best move makes a fork by the moved piece', () => {
    const r = preMoveCoaching(ctxFrom(['Ra8'], {
      start: '4k3/r7/8/1N6/8/8/8/4K3 b - - 0 30',
      analysis: { uci: ['b5c7', 'e8d7', 'c7a8'], cp: 500, mate: null },
    }));
    expect(r.questions).toContain(FORK_Q);
    expect(r.nudge).toBe('Look at what your knight could reach.');
  });

  it('does not ask the fork question when the best move makes no fork', () => {
    const r = preMoveCoaching(ctxFrom(['Ra8'], {
      start: '4k3/r7/8/1N6/8/8/8/4K3 b - - 0 30',
      analysis: { uci: ['e1e2'], cp: 0, mate: null },
    }));
    expect(r.questions).not.toContain(FORK_Q);
  });

  it('gives exactly the two habit questions and no nudge in a quiet position without analysis', () => {
    const r = preMoveCoaching(ctxFrom(['Ke8'], { start: '3k4/8/8/8/8/8/4P3/4K3 b - - 0 30' }));
    expect(r.questions).toEqual([...HABIT_QUESTIONS]);
    expect(r.nudge).toBeNull();
  });

  it('on move 1 as White has no opponent move and leads with the root plan', () => {
    const r = preMoveCoaching(ctxFrom([]));
    expect(r.theirMove).toBeNull();
    expect(r.questions[0]).toBe(rootPlan('w'));
    expect(r.questions).not.toContain(HABIT_QUESTIONS[0]);
    expect(r.nudge).toBe(rootPlan('w'));
  });

  it('uses the book node plan in book', () => {
    const ctx = ctxFrom(['e4', 'e5']);
    expect(ctx.book).not.toBeNull();
    const r = preMoveCoaching(ctx);
    expect(r.questions[0]).toBe(ctx.book!.node.plan);
    expect(r.nudge).toBe(ctx.book!.node.plan);
  });

  it("uses the book node plan on Black's first move in book", () => {
    const ctx = ctxFrom(['d4']);
    const r = preMoveCoaching(ctx);
    expect(r.questions[0]).toBe(lookup('b', ['d4'])!.node.plan);
  });

  it("falls back to the Black root plan on Black's first move out of book", () => {
    const ctx = ctxFrom(['c4']);
    expect(ctx.book).toBeNull();
    expect(preMoveCoaching(ctx).questions[0]).toBe(rootPlan('b'));
  });

  it('asks which pieces have not moved when development is behind', () => {
    const sans = ['a3', 'a6', 'h3', 'h6', 'a4', 'a5', 'h4', 'h5', 'b3', 'b6', 'g3', 'g6', 'c3', 'c6', 'f3', 'f6', 'Ra2', 'Ra7', 'Rh2', 'Rh7'];
    expect(preMoveCoaching(ctxFrom(sans)).questions).toContain(UNDEVELOPED_Q);
    expect(preMoveCoaching(ctxFrom(['d4', 'Nf6'])).questions).not.toContain(UNDEVELOPED_Q);
  });

  it('ignores analysis for a different position', () => {
    const ctx = ctxFrom(['Ke8'], { start: '3k4/8/8/8/8/8/4P3/4K3 b - - 0 30' });
    ctx.analysis = { fen: START, depth: 10, lines: [{ uci: ['e2e4'], cp: null, mate: 1 }] };
    expect(preMoveCoaching(ctx).questions).toEqual([...HABIT_QUESTIONS]);
  });
});

describe('preMoveCoaching theirMove', () => {
  it('uses the book idea in book', () => {
    const ctx = ctxFrom(['e4', 'e5']);
    expect(preMoveCoaching(ctx).theirMove).toBe(ctx.book!.node.idea);
  });

  it('describes a capture without listing safely guarded pawns', () => {
    const r = preMoveCoaching(ctxFrom(['e4', 'd5', 'exd5', 'Qxd5']));
    expect(r.theirMove).toBe('Their queen took your pawn on d5.');
  });

  it('lists the pieces the moved piece attacks', () => {
    const r = preMoveCoaching(ctxFrom(['e4', 'e5', 'Nf3', 'Nc6', 'Bb5', 'Nd4']));
    expect(r.theirMove).toBe('They played Nd4. Their knight now attacks both your bishop on b5 and your knight on f3.');
  });

  it('mentions check', () => {
    expect(preMoveCoaching(ctxFrom(['e4', 'f6', 'Qh5+'])).theirMove).toContain("You're in check.");
  });

  it('describes a pin made by the moved piece', () => {
    const r = preMoveCoaching(ctxFrom(['d4', 'Nf6', 'c4', 'e6', 'Nc3', 'Bb4']));
    expect(r.theirMove).toBe('They played Bb4. Their bishop on b4 now pins your knight on c3 to your king.');
  });

  it('falls back to facts when the book idea would leak a move', () => {
    const ctx = ctxFrom(['e4', 'e5']);
    const node: RepertoireNode = { ...ctx.book!.node, idea: 'Answer with Nf3 now.' };
    const r = preMoveCoaching({ ...ctx, book: { ...ctx.book!, node } });
    expect(r.theirMove).not.toContain('Nf3');
    expect(r.theirMove).toBeTruthy();
  });

  it('drops a leaking plan', () => {
    const ctx = ctxFrom(['e4', 'e5']);
    const node: RepertoireNode = { ...ctx.book!.node, plan: 'Bring your knight to f3.' };
    const r = preMoveCoaching({ ...ctx, book: { ...ctx.book!, node } });
    expect(r.questions).not.toContain('Bring your knight to f3.');
    expect(r.nudge).not.toBe('Bring your knight to f3.');
  });
});

describe('preMoveCoaching never leaks a move', () => {
  const trees: Record<Color, RepertoireNode[]> = { w: data.white, b: data.black };

  it('at move 1 as White', () => expectNoLeaks(ctxFrom([]), 'start'));

  for (const color of ['w', 'b'] as const) {
    it(`at every ${color} repertoire position where the user is to move`, () => {
      let count = 0;
      const visit = (nodes: RepertoireNode[], path: string[]) => {
        for (const node of nodes) {
          const here = [...path, node.san];
          const userToMove = (here.length % 2 === 0) === (color === 'w');
          if (userToMove) {
            expectNoLeaks(ctxFrom(here), here.join(' '));
            count++;
          }
          visit(node.children, here);
        }
      };
      visit(trees[color], []);
      expect(count).toBeGreaterThan(5);
    });
  }

  // Positions where the engine's best move is a capture.
  const engineFixtures: { sans: string[]; start?: string; line: string[]; cp: number | null; mate: number | null }[] = [
    { sans: ['e4', 'd5'], line: ['e4d5', 'd8d5'], cp: 30, mate: null },
    { sans: ['e4', 'e5', 'Nf3', 'Nc6', 'Bc4', 'Nd4'], line: ['f3d4', 'e5d4'], cp: 60, mate: null },
    { sans: ['e4', 'e5', 'Nf3', 'd6', 'd4', 'Bg4'], line: ['d4e5', 'g4f3', 'd1f3', 'd6e5'], cp: 120, mate: null },
    { sans: ['d4', 'e5'], line: ['d4e5'], cp: 90, mate: null },
    { sans: ['e4', 'e5', 'Qh5', 'Nc6', 'Bc4', 'Nf6'], line: ['h5f7'], cp: null, mate: 1 },
    { sans: ['e4', 'e5', 'Nf3', 'f6', 'Nxe5', 'fxe5', 'Qh5+', 'Ke7'], line: ['h5e5', 'e7f7', 'f1c4'], cp: null, mate: 4 },
    { sans: ['Bd4'], start: '4k3/8/8/4b3/8/8/8/3RK3 b - - 0 30', line: ['d1d4', 'e8e7'], cp: 320, mate: null },
    { sans: ['Ke8'], start: '3k4/4p3/3p4/8/8/8/8/3QK3 b - - 0 30', line: ['d1d6', 'e7d6'], cp: -800, mate: null },
    { sans: ['e4', 'e5', 'Nf3', 'Nc6', 'Bb5', 'a6'], line: ['b5c6', 'd7c6'], cp: 10, mate: null },
    { sans: ['e4', 'd5', 'exd5', 'Qxd5', 'Nc3', 'Qa5', 'd4', 'c6', 'Nf3', 'Bg4', 'h3', 'Bxf3'], line: ['d1f3', 'e7e6'], cp: 40, mate: null },
    { sans: ['Kd8'], start: 'r3k3/1P6/8/8/8/8/8/4K3 b - - 0 40', line: ['b7a8q', 'd8c7'], cp: 900, mate: null },
  ];

  it.each(engineFixtures.map((f) => [f.sans.join(' '), f] as const))('with engine capture after %s', (_label, f) => {
    const ctx = ctxFrom(f.sans, { start: f.start, analysis: { uci: f.line, cp: f.cp, mate: f.mate } });
    const first = new Chess(ctx.fen).move({ from: f.line[0].slice(0, 2), to: f.line[0].slice(2, 4), promotion: f.line[0][4] });
    expect(first.captured ?? (first.promotion ? 'promo' : undefined)).toBeTruthy();
    expectNoLeaks(ctx, f.sans.join(' '));
  });
});

describe('preMoveCoaching with stale analysis', () => {
  it('treats a stale analysis as none: no win question from the facts alone', () => {
    const ctx = ctxFrom(['Bd4'], { start: '4k3/8/8/4b3/8/8/8/3RK3 b - - 0 30' });
    ctx.analysis = { fen: START, depth: 10, lines: [{ uci: ['e2e4'], cp: 0, mate: null }] };
    expect(preMoveCoaching(ctx).questions).not.toContain('Is there anything of theirs you can win?');
  });
});

/**
 * Real Node Stockfish analyses (stockfish-19-lite-single, `go depth 15`, MultiPV 3).
 * In each, the engine's best move captures something, yet the user is not winning anything:
 * a level or losing position, or even trades.
 */
const NO_WIN_FIXTURES: { fen: string; lines: EngineLine[] }[] = [
  { fen: 'r1bq1knr/2bn1p2/p3p2p/1PpP2p1/5P2/2NPP2N/1P2Q1PP/R1B1KB1R b KQ - 0 13', lines: [
    { uci: ['e6d5', 'c3d5', 'c7d6', 'd5c3', 'g8f6', 'g2g3', 'c8b7', 'f1g2'], cp: -224, mate: null },
    { uci: ['e6e5', 'f4g5', 'h6g5', 'e3e4', 'c7a5', 'c1d2', 'g8f6', 'h3g5'], cp: -276, mate: null },
    { uci: ['d7f6', 'd5e6', 'c8e6', 'b5a6', 'c7a5', 'c1d2', 'a8a6', 'f4g5'], cp: -280, mate: null },
  ] },
  { fen: 'r1b1kb1r/ppqnpppp/5n2/2pp4/2PP4/P3PN2/1P3PPP/RNBQKB1R w KQkq - 1 6', lines: [
    { uci: ['c4d5', 'c5d4', 'f3d4', 'f6d5', 'e3e4', 'd5f6', 'c1e3', 'a7a6'], cp: 108, mate: null },
    { uci: ['b1c3', 'd5c4', 'd4d5', 'g7g6', 'f1c4', 'f8g7', 'c4a2', 'e8g8'], cp: 72, mate: null },
    { uci: ['d4c5', 'd5c4', 'f1c4', 'e7e6', 'b1d2', 'a7a5', 'b2b3', 'f8c5'], cp: 38, mate: null },
  ] },
  { fen: 'r1b4r/2bqnpk1/pn5p/1P1PP3/4BP2/2N2Q1N/1P4PP/R1B1K2R b KQ - 4 20', lines: [
    { uci: ['b6d5', 'e4d5', 'e7d5', 'c3d5', 'a8b8', 'f3g3', 'g7f8', 'g3a3'], cp: -627, mate: null },
    { uci: ['e7d5', 'c3d5', 'b6d5', 'e1g1', 'd7b5', 'e4d5', 'c8h3', 'd5c6'], cp: -646, mate: null },
    { uci: ['a6b5', 'a1a8', 'b6a8', 'h3f2', 'b5b4', 'c3e2', 'c7b6', 'd5d6'], cp: -720, mate: null },
  ] },
  { fen: '1rb3nr/pppp3Q/5kp1/2q1pP2/1bP1N3/2N5/1PBP1PPP/R1B2RK1 b - - 2 14', lines: [
    { uci: ['f6f5', 'h7f7', 'f5g4', 'f7g6', 'g4f4', 'g6g5'], cp: null, mate: -3 },
  ] },
];

/**
 * The reviewer's numbers for the same positions, with lines that stop mid-exchange (as a shorter or
 * truncated search returns them): judged at the line's last reply, each looked like a material gain.
 */
const REVIEWER_FIXTURES: { fen: string; line: EngineLine }[] = [
  // exd5 Nxd5 gxf4, then a quiet move: a pawn up only before White takes back.
  { fen: NO_WIN_FIXTURES[0].fen, line: { uci: ['e6d5', 'c3d5', 'g5f4', 'a1a2'], cp: -223, mate: null } },
  // cxd5 cxd4 Nxd4, then a quiet move: +117 but the trades are even after Black's first reply.
  { fen: NO_WIN_FIXTURES[1].fen, line: { uci: ['c4d5', 'c5d4', 'f3d4', 'e7e6'], cp: 117, mate: null } },
  // Nxd5 Bxd5 Nxd5, then a quiet move.
  { fen: NO_WIN_FIXTURES[2].fen, line: { uci: ['b6d5', 'e4d5', 'e7d5', 'a1a2'], cp: -655, mate: null } },
  // Kxf5, and White mates in 3.
  { fen: NO_WIN_FIXTURES[3].fen, line: { uci: ['f6f5', 'h7f7', 'f5g4', 'f7g6'], cp: null, mate: -3 } },
];

function bareCtx(fen: string, lines: EngineLine[]): QuestionContext {
  return {
    fen, lastMove: null, history: [], userColor: new Chess(fen).turn() as Color,
    facts: positionFacts(fen), analysis: { fen, depth: 14, lines }, book: null,
  };
}

describe('win question only when the user is really winning something', () => {
  it.each(NO_WIN_FIXTURES.map((f) => [f.fen, f] as const))('no win question (Stockfish) in %s', (_l, f) => {
    const r = preMoveCoaching(bareCtx(f.fen, f.lines));
    expect(new Chess(f.fen).move({ from: f.lines[0].uci[0].slice(0, 2), to: f.lines[0].uci[0].slice(2, 4) }).captured).toBeTruthy();
    expect(r.questions).not.toContain(WIN_Q);
  });

  it.each(REVIEWER_FIXTURES.map((f) => [f.fen, f] as const))('no win question (reviewer numbers) in %s', (_l, f) => {
    const c = new Chess(f.fen);
    for (const u of f.line.uci) c.move({ from: u.slice(0, 2), to: u.slice(2, 4) }); // a legal line
    expect(preMoveCoaching(bareCtx(f.fen, [f.line])).questions).not.toContain(WIN_Q);
  });

  it('judges the gain after the first reply only: a pawn grab that is taken straight back is not a win', () => {
    // Rxd5 exd5 Rxd5: two pawns for a rook, then a pawn back; after the first reply it is a loss.
    const fen = '3k4/8/4p3/3p4/8/8/3R4/3RK3 w - - 0 1';
    const r = preMoveCoaching(bareCtx(fen, [{ uci: ['d2d5', 'e6d5', 'd1d5'], cp: 150, mate: null }]));
    expect(r.questions).not.toContain(WIN_Q);
  });

  it('no win question when the line wins material but the eval is under +100', () => {
    const fen = '4k3/8/8/8/3b4/8/8/3RK3 w - - 0 30';
    const r = preMoveCoaching(bareCtx(fen, [{ uci: ['d1d4', 'e8e7'], cp: 99, mate: null }]));
    expect(r.questions).not.toContain(WIN_Q);
  });

  it('no win question when the line ends in a mate against the user', () => {
    const fen = '4k3/8/8/8/3b4/8/8/3RK3 w - - 0 30';
    const r = preMoveCoaching(bareCtx(fen, [{ uci: ['d1d4', 'e8e7'], cp: null, mate: -3 }]));
    expect(r.questions).not.toContain(WIN_Q);
  });

  it('asks the win question for a clean piece win (+300 after the first reply)', () => {
    const fen = '4k3/8/8/8/3b4/8/8/3RK3 w - - 0 30';
    const r = preMoveCoaching(bareCtx(fen, [{ uci: ['d1d4', 'e8e7', 'e1e2'], cp: 300, mate: null }]));
    expect(r.questions).toContain(WIN_Q);
    expect(r.nudge).toBe('Look at their bishop on d4.');
  });
});

describe('nudge highlight', () => {
  const SQUARE = /\b[a-h][1-8]\b/g;
  const expectHighlightMatchesText = (ctx: QuestionContext, label: string) => {
    const r = preMoveCoaching(ctx);
    const named = r.nudge ? [...new Set(r.nudge.match(SQUARE) ?? [])] : [];
    expect(r.nudgeHighlight, label).toEqual(named);
    const board = new Chess(ctx.fen);
    for (const sq of r.nudgeHighlight) expect(board.get(sq as never), `${label}: ${sq}`).toBeTruthy();
  };

  it('rings the square a "Look at your knight on f6." nudge names', () => {
    const r = preMoveCoaching(ctxFrom(['Bg5'], { start: '4k3/8/5n2/8/8/8/8/2B1K3 w - - 0 1' }));
    expect(r.nudge).toBe('Look at your knight on f6.');
    expect(r.nudgeHighlight).toEqual(['f6']);
  });

  it('rings nothing for a plan nudge that names no square', () => {
    const r = preMoveCoaching(ctxFrom([]));
    expect(r.nudge).toBe(rootPlan('w'));
    expect(r.nudgeHighlight).toEqual([]);
  });

  it('rings nothing when there is no nudge', () => {
    const r = preMoveCoaching(ctxFrom(['Ke7'], { start: '4k3/8/8/8/8/8/8/4K3 b - - 0 40' }));
    expect(r.nudge).toBeNull();
    expect(r.nudgeHighlight).toEqual([]);
  });

  it('every square named in a nudge is highlighted, and nothing else', () => {
    expectHighlightMatchesText(ctxFrom(['Bb5'], { start: '4k3/3b4/8/8/8/3N4/8/4K3 b - - 0 30' }), 'hanging');
    expectHighlightMatchesText(bareCtx('4k3/8/8/8/3b4/8/8/3RK3 w - - 0 30',
      [{ uci: ['d1d4', 'e8e7', 'e1e2'], cp: 300, mate: null }]), 'win');
    expectHighlightMatchesText(ctxFrom(['e4', 'e5']), 'book plan');
    expectHighlightMatchesText(ctxFrom(['e4', 'e5', 'Nf3']), 'book plan (black)');
    expectHighlightMatchesText(ctxFrom([]), 'root plan');
  });
});
