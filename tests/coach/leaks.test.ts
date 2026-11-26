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

  // The better move: Nxd5 (f3d5), taking an undefended queen.
  it.each([
    'Your knight on f3 could have taken their queen on d5 for free.',
    'You missed that your knight could capture on d5.',
    'Their queen on d5 was free for your knight.',
    'Your knight could win their queen on d5.',
    'Your knight was grabbing nothing while their queen on d5 sat there.',
  ])('flags a missed capture: "%s"', (text) => {
    expect(revealsMove(text, 'Nxd5', 'f3d5')).toBe(true);
  });

  it('flags a verb-less sentence naming the better move\'s square', () => {
    expect(revealsMove('Your king is safer on e2.', 'Ke2', 'e1e2')).toBe(true);
  });

  it('lets the better move\'s square through when it is the played move\'s or the reply\'s square', () => {
    // Played e2e4, reply d7d5: e2 and d5 are squares the user already sees.
    expect(revealsMove('Your pawn left e2 empty.', 'Ke2', 'e1e2', ['e2e4', 'd7d5'])).toBe(false);
    expect(revealsMove('Their pawn on d5 is strong.', 'Nxd5', 'f3d5', ['e2e4', 'd7d5'])).toBe(false);
    expect(revealsMove('Their pawn on d5 is strong.', 'Nxd5', 'f3d5')).toBe(true);
  });

  it('flags any castling talk when the better move castles', () => {
    expect(revealsMove('Getting your king safe by castling was better.', 'O-O', 'e1g1')).toBe(true);
  });
});
