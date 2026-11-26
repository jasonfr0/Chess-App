import { describe, it, expect } from 'vitest';
import { watchLine } from '../../src/coach/watch';

// White just moved Rd3?? (classify fixture): ...Ra1+ Rd1 Rxd1# is mate in 2.
const BACK_RANK_AFTER = 'rr4k1/5ppp/8/8/8/3R4/5PPP/6K1 b - - 1 1';
const KNIGHT_AFTER = '4k3/8/3p4/4N3/8/8/8/4K3 b - - 1 1';
// Black to move; Rxb2 wins the knight at ply 3, and white's Rxa5 wins a pawn at ply 8.
const LONG_AFTER = '1r5k/8/8/p7/8/8/1N6/R5K1 b - - 0 1';
const LONG = ['h8g8', 'g1f1', 'b8b2', 'f1e1', 'g8h8', 'e1f1', 'h8g8', 'a1a5', 'g8h8', 'f1e1', 'h8g8', 'e1f1'];

describe('watchLine', () => {
  it('shows a forced mate through checkmate, starting with the opponent', () => {
    const w = watchLine(BACK_RANK_AFTER, ['a8a1', 'd3d1', 'a1d1'], 'w');
    expect(w).not.toBeNull();
    expect(w!.map((p) => p.san)).toEqual(['Ra1+', 'Rd1', 'Rxd1#']);
    expect(w!.map((p) => p.by)).toEqual(['opponent', 'user', 'opponent']);
    expect(w![2].fen).toContain('1r4k1/5ppp/8/8/8/8/5PPP/3r2K1 w');
  });

  it('is null for a single capture with nothing lost afterwards', () => {
    expect(watchLine(KNIGHT_AFTER, ['d6e5', 'e1e2'], 'w')).toBeNull();
  });

  it('shows plies through the one where a piece is lost after ply 1', () => {
    const w = watchLine(LONG_AFTER, LONG.slice(0, 5), 'w');
    expect(w!.map((p) => p.uci)).toEqual(['h8g8', 'g1f1', 'b8b2']);
  });

  it('caps a long line at 8 plies', () => {
    const w = watchLine(LONG_AFTER, LONG, 'w');
    expect(w).toHaveLength(8);
    expect(w![7].by).toBe('user');
  });

  it('is null for an empty line and stops at an unplayable move', () => {
    expect(watchLine(KNIGHT_AFTER, [], 'w')).toBeNull();
    expect(watchLine(BACK_RANK_AFTER, ['a8a1', 'zzzz'], 'w')).toBeNull();
  });
});
