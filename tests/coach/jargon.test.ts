import { describe, it, expect } from 'vitest';
import { BANNED_TERMS, findJargon } from '../../src/coach/jargon';

describe('findJargon', () => {
  it('holds exactly the banned list', () => {
    expect([...BANNED_TERMS]).toEqual([
      'outpost', 'tempo', 'prophylaxis', 'initiative', 'zwischenzug', 'positional', 'weakness complex',
      'pawn structure', 'space advantage', 'compensation', 'dynamic', 'static',
    ]);
  });

  it('finds banned terms, case-insensitively', () => {
    expect(findJargon('a strong outpost and tempo')).toEqual(['outpost', 'tempo']);
    expect(findJargon('Seize the INITIATIVE')).toEqual(['initiative']);
  });

  it('matches phrases, across any spacing', () => {
    expect(findJargon('Mind your pawn structure.')).toEqual(['pawn structure']);
    expect(findJargon('a weakness\ncomplex')).toEqual(['weakness complex']);
  });

  it('matches whole words only (plurals count)', () => {
    expect(findJargon('a quiet move')).toEqual([]);
    expect(findJargon('ecstatic, contemporary, outposted')).toEqual([]);
    expect(findJargon('two outposts')).toEqual(['outpost']);
  });
});
