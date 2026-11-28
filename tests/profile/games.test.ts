import { describe, it, expect } from 'vitest';
import { playGames } from '../../src/profile/games';
import type { SavedGame } from '../../src/storage/db';

const g = (id: string, mode?: SavedGame['mode']): SavedGame => ({
  id, startedAt: 1, userColor: 'w', moves: [], verdicts: [], result: null, ...(mode ? { mode } : {}),
});

describe('playGames', () => {
  it('drops teaching games and keeps games with no mode', () => {
    expect(playGames([g('a'), g('b', 'teach'), g('c', 'play')]).map((x) => x.id)).toEqual(['a', 'c']);
  });
});
