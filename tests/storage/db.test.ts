import 'fake-indexeddb/auto';
import { describe, it, expect } from 'vitest';
import { openDb, DEFAULT_SETTINGS, ImportError, defaultProfile, type SavedGame } from '../../src/storage/db';

let n = 0;
const fresh = () => `test-db-${n++}-${Math.random()}`;
const game = (id: string): SavedGame => ({
  id, startedAt: 1000, userColor: 'w', moves: ['e4', 'e5'], verdicts: [], result: null,
});

describe('db', () => {
  it('returns default settings on a fresh db and round-trips settings', async () => {
    const db = await openDb(fresh());
    expect(await db.getSettings()).toEqual(DEFAULT_SETTINGS);
    const s = { ...DEFAULT_SETTINGS, apiKey: 'sk-x', clockMinutes: 5 };
    await db.saveSettings(s);
    expect(await db.getSettings()).toEqual(s);
  });

  it('fresh profile is the default', async () => {
    const db = await openDb(fresh());
    const p = await db.getProfile();
    expect(p).toEqual(defaultProfile());
    expect(p.levels).toEqual({ opening: 'full', middlegame: 'full', endgame: 'light' });
    expect(p.themes.hanging_piece.count).toBe(0);
  });

  it('persists current game across reopen', async () => {
    const name = fresh();
    const db = await openDb(name);
    await db.saveGame(game('g1'));
    await db.setCurrentGame('g1');
    const db2 = await openDb(name);
    const id = await db2.currentGameId();
    expect(id).toBe('g1');
    expect((await db2.getGame(id!))?.moves).toEqual(['e4', 'e5']);
  });

  it('exports and imports games and profile without apiKey, keeping local key', async () => {
    const a = await openDb(fresh());
    await a.saveSettings({ ...DEFAULT_SETTINGS, apiKey: 'sk-secret-123', opponentRating: 900 });
    await a.saveGame(game('g1'));
    const p = defaultProfile();
    p.themes.allowed_fork.count = 3;
    p.levelChangedAt = { opening: 5 };
    await a.saveProfile(p);
    const json = await a.exportAll();
    expect(json).not.toContain('sk-secret-123');

    const b = await openDb(fresh());
    await b.saveSettings({ ...DEFAULT_SETTINGS, apiKey: 'sk-local' });
    await b.importAll(json);
    expect(await b.listGames()).toEqual(await a.listGames());
    expect(await b.getProfile()).toEqual(p);
    const s = await b.getSettings();
    expect(s.apiKey).toBe('sk-local');
    expect(s.opponentRating).toBe(900);
  });

  it('rejects invalid imports and leaves data untouched', async () => {
    const db = await openDb(fresh());
    await db.saveGame(game('g1'));
    for (const bad of ['{"foo":1}', 'not json',
      JSON.stringify({ app: 'chess-coach', version: 2, games: [] }),
      JSON.stringify({ app: 'chess-coach', version: 1, games: [{ id: 'x', startedAt: 1, userColor: 'z', moves: [], verdicts: [], result: null }] })]) {
      await expect(db.importAll(bad)).rejects.toBeInstanceOf(ImportError);
    }
    expect((await db.listGames()).map((g) => g.id)).toEqual(['g1']);
  });
});
