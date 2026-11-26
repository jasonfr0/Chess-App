import { describe, it, expect } from 'vitest';
import { moveLeaks, revealsMove } from '../../src/coach/leaks';

describe('moveLeaks', () => {
  it.each([
    'Take it with exd5.',
    'Bring your knight to f3.',
    'Play d4 to grab the centre.',
    'Push the pawn to e5.',
    'Castle now.',
    'Nf3 is strong.',
    'capture the pawn on e5',
    // T1 regressions: lower-case piece letter, an annotation mark, a bare SAN as the subject.
    'Try nf3 here.',
    'Nxe5! wins a pawn.',
    'exd5 is the move.',
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

describe('revealsMove', () => {
  // The better move: Ke2 (e1e2).
  it.each([
    'Ke2 was better.',
    'Moving your king to e2 was safer.',
    'Your king to e2 keeps it safe.',
    'You could step your king on e1 forward.',
    'Move the king from e1 first.',
    'Put your king on e2.',
  ])('flags "%s"', (text) => {
    expect(revealsMove(text, 'Ke2', 'e1e2')).toBe(true);
  });

  it.each([
    'After Ne5, your knight on e5 can be taken for free.',
    'They can play dxe5.',
    'Left a piece hanging: after every move, ask what is undefended.',
    'Your king on e1 is safe for now.',
  ])('lets "%s" through', (text) => {
    expect(revealsMove(text, 'Ke2', 'e1e2')).toBe(false);
  });

  it('flags any castling talk when the better move castles', () => {
    expect(revealsMove('Getting your king safe by castling was better.', 'O-O', 'e1g1')).toBe(true);
  });
});
