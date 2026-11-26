import { describe, it, expect } from 'vitest';
import { moveLeaks } from '../../src/coach/leaks';

describe('moveLeaks', () => {
  it.each([
    'Take it with exd5.',
    'Bring your knight to f3.',
    'Play d4 to grab the centre.',
    'Push the pawn to e5.',
    'Castle now.',
    'Nf3 is strong.',
    'capture the pawn on e5',
  ])('flags %s', (t) => {
    expect(moveLeaks(t).length).toBeGreaterThan(0);
  });

  it.each([
    ['Look at your knight on f6.', undefined],
    ['Black played d5, challenging your pawn on e4.', ['d5']],
    ['Can you castle soon?', undefined],
    ['Is your king safe yet?', undefined],
    ['Get a knight out to attack their centre pawn.', undefined],
    ['What does their last move attack?', undefined],
  ] as [string, string[] | undefined][])('allows %s', (t, allowed) => {
    expect(moveLeaks(t, allowed)).toEqual([]);
  });

  it('allows the opponent SAN when listed, case/castling-insensitively', () => {
    expect(moveLeaks('They castled: 0-0.', ['O-O'])).toEqual([]);
    expect(moveLeaks('They played Nf6+.', ['Nf6'])).toEqual([]);
    expect(moveLeaks('They played Nf6.')).toEqual(['Nf6']);
  });
});
