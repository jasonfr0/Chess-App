import { describe, it, expect } from 'vitest';
import { Chess } from 'chess.js';
import { selectOpponentMove, adjustOpponentRating } from '../../src/opponent/selectMove';
import type { Analysis } from '../../src/types';

function mulberry32(a: number) {
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const START = new Chess().fen();
const mk = (fen: string, moves: [string, number][]): Analysis => ({
  fen, depth: 10, lines: moves.map(([u, cp]) => ({ uci: [u], cp, mate: null })),
});
const fixture = mk(START, [['e2e4', 50], ['d2d4', 20], ['g1f3', -10], ['a2a3', -200], ['h2h3', -600]]);
const noBook = { bookChance: 0 };

function count(analysis: Analysis, rating: number, seed: number, n = 1000) {
  const rng = mulberry32(seed);
  const counts: Record<string, number> = {};
  for (let i = 0; i < n; i++) {
    const m = selectOpponentMove(analysis.fen, analysis, [], 'b', { rating, ...noBook }, rng);
    counts[m] = (counts[m] ?? 0) + 1;
  }
  return counts;
}

describe('selectOpponentMove', () => {
  it('at 600 is human-like: mostly best, sometimes not, rarely bad', () => {
    const c = count(fixture, 600, 1);
    const best = (c.e2e4 ?? 0) / 1000;
    const bad = ((c.a2a3 ?? 0) + (c.h2h3 ?? 0)) / 1000;
    expect(best).toBeGreaterThanOrEqual(0.25);
    expect(best).toBeLessThanOrEqual(0.7);
    expect(1 - best).toBeGreaterThanOrEqual(0.1);
    expect(bad).toBeGreaterThanOrEqual(0.05);
    expect(bad).toBeLessThanOrEqual(0.35);
  });

  it('at 2000 is nearly always best', () => {
    const c = count(fixture, 2000, 2);
    expect((c.e2e4 ?? 0) / 1000).toBeGreaterThanOrEqual(0.6);
    expect(((c.a2a3 ?? 0) + (c.h2h3 ?? 0)) / 1000).toBeLessThan(0.05);
  });

  it('never plays a move that allows mate in one', () => {
    // 1.f3 e5 2.g4?? Qh4#
    const chess = new Chess();
    chess.move('f3'); chess.move('e5');
    const fen = chess.fen();
    const a = mk(fen, [['g2g4', 300], ['e2e4', 100], ['d2d4', 80], ['a2a3', -300]]);
    for (const rating of [600, 2000]) {
      const rng = mulberry32(3 + rating);
      for (let i = 0; i < 1000; i++) {
        const m = selectOpponentMove(fen, a, ['f3', 'e5'], 'b', { rating, ...noBook }, rng);
        expect(m).not.toBe('g2g4');
      }
    }
  });

  it('with bookChance 1 always plays a book move', () => {
    const hist = ['e4', 'e5', 'Nf3', 'Nc6'];
    const chess = new Chess();
    hist.forEach((s) => chess.move(s));
    const fen = chess.fen();
    const a = mk(fen, [['d2d3', 30], ['h2h3', 0]]);
    const rng = mulberry32(4);
    for (let i = 0; i < 200; i++) {
      const m = selectOpponentMove(fen, a, hist, 'b', { rating: 600, bookChance: 1 }, rng);
      expect(['f1c4', 'f1b5', 'd2d4']).toContain(m);
    }
  });
});

describe('adjustOpponentRating', () => {
  it('adjusts and clamps', () => {
    expect(adjustOpponentRating(600, 4)).toBe(650);
    expect(adjustOpponentRating(400, 0)).toBe(400);
    expect(adjustOpponentRating(600, 2.5)).toBe(600);
    expect(adjustOpponentRating(2000, 5)).toBe(2000);
  });
});
