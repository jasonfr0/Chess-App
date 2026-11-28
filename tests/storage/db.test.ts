import 'fake-indexeddb/auto';
import { describe, it, expect, vi } from 'vitest';
import { migrateProfile } from '../../src/profile/profile';
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

  it('imports a backup without profile version, which then migrates with a reset', async () => {
    const old = defaultProfile();
    delete old.version;
    old.levels = { opening: 'guided', middlegame: 'light', endgame: 'solo' };
    const db = await openDb(fresh());
    await db.importAll(JSON.stringify({ app: 'chess-coach', version: 1, games: [], profile: old }));
    const got = await db.getProfile();
    expect(got.version).toBeUndefined();
    const m = migrateProfile(got);
    expect(m.reset).toBe(true);
    expect(m.profile.levels).toEqual({ opening: 'full', middlegame: 'full', endgame: 'light' });
  });

  it('round-trips a version 2 profile through export/import', async () => {
    const a = await openDb(fresh());
    const p = defaultProfile();
    expect(p.version).toBe(2);
    await a.saveProfile(p);
    const b = await openDb(fresh());
    await b.importAll(await a.exportAll());
    expect((await b.getProfile()).version).toBe(2);
    expect(migrateProfile(await b.getProfile()).reset).toBe(false);
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

  it('rejects malformed profile entries and leaves data untouched', async () => {
    const db = await openDb(fresh());
    await db.saveGame(game('g1'));
    const p = defaultProfile();
    const mk = (mut: (x: any) => void) => { const c = JSON.parse(JSON.stringify(p)); mut(c); return JSON.stringify({ app: 'chess-coach', version: 1, games: [], profile: c }); };
    const bads = [
      mk((c) => { c.themes.allowed_fork = {}; }),
      mk((c) => { c.themes.allowed_fork.examples = [{ gameId: 1 }]; }),
      mk((c) => { c.moves.opening = [{ good: 'yes' }]; }),
      mk((c) => { c.levelChangedAt = { opening: 'x' }; }),
    ];
    for (const bad of bads) await expect(db.importAll(bad)).rejects.toBeInstanceOf(ImportError);
    expect((await db.listGames()).map((g) => g.id)).toEqual(['g1']);
  });

  it('imports move records with and without the newer bad/assisted fields', async () => {
    const db = await openDb(fresh());
    const p = defaultProfile();
    p.moves.opening = [
      { good: true, flagged: false, at: 1 } as never, // a record saved before bad/assisted existed
      { good: false, flagged: false, bad: true, assisted: true, at: 2 },
    ];
    await db.importAll(JSON.stringify({ app: 'chess-coach', version: 1, games: [], profile: p }));
    expect((await db.getProfile()).moves.opening).toEqual(p.moves.opening);
    const wrong = { ...p, moves: { ...p.moves, opening: [{ good: true, flagged: false, bad: 'yes', at: 1 }] } };
    await expect(db.importAll(JSON.stringify({ app: 'chess-coach', version: 1, games: [], profile: wrong })))
      .rejects.toBeInstanceOf(ImportError);
  });

  it('rejects invalid game result and model', async () => {
    const db = await openDb(fresh());
    const g = { ...game('x'), result: { winner: 'q', reason: 'nope' } };
    await expect(db.importAll(JSON.stringify({ app: 'chess-coach', version: 1, games: [g] }))).rejects.toBeInstanceOf(ImportError);
    const ok = { ...game('x'), result: { winner: null, reason: 'stalemate' } };
    await db.importAll(JSON.stringify({ app: 'chess-coach', version: 1, games: [ok] }));
    expect((await db.getGame('x'))?.result?.reason).toBe('stalemate');
  });

  it('nulls an imported currentGameId not among imported games', async () => {
    const db = await openDb(fresh());
    await db.importAll(JSON.stringify({ app: 'chess-coach', version: 1, games: [game('a')], currentGameId: 'zzz' }));
    expect(await db.currentGameId()).toBeNull();
    await db.importAll(JSON.stringify({ app: 'chess-coach', version: 1, games: [game('a')], currentGameId: 'a' }));
    expect(await db.currentGameId()).toBe('a');
  });

  it('is atomic when a write fails mid-import', async () => {
    const db = await openDb(fresh());
    await db.saveGame(game('old'));
    await db.saveSettings({ ...DEFAULT_SETTINGS, opponentRating: 777 });
    const p = defaultProfile(); p.themes.missed_pin.count = 4;
    await db.saveProfile(p);
    const json = JSON.stringify({ app: 'chess-coach', version: 1, games: [game('new')], settings: DEFAULT_SETTINGS, profile: defaultProfile() });
    const orig = IDBObjectStore.prototype.put;
    let calls = 0;
    const spy = vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementation(function (this: IDBObjectStore, ...a: Parameters<IDBObjectStore['put']>) {
      if (++calls === 2) throw new Error('boom');
      return orig.apply(this, a);
    });
    await expect(db.importAll(json)).rejects.toBeInstanceOf(ImportError);
    spy.mockRestore();
    expect((await db.listGames()).map((g) => g.id)).toEqual(['old']);
    expect((await db.getSettings()).opponentRating).toBe(777);
    expect((await db.getProfile()).themes.missed_pin.count).toBe(4);
  });

  it('defaults attackLines off and imports backups without the new fields', async () => {
    expect(DEFAULT_SETTINGS.attackLines).toBe(false);
    const db = await openDb(fresh());
    const oldSettings = { model: 'claude-sonnet-5-5', levelOverride: {}, clockMinutes: null, opponentRating: 600 };
    await db.importAll(JSON.stringify({ app: 'chess-coach', version: 1, settings: oldSettings, games: [game('a')] }));
    expect((await db.getSettings()).attackLines).toBe(false);
    expect((await db.getGame('a'))?.userMoves).toBeUndefined();
  });

  it('round-trips attackLines, attackLinesMoves and userMoves through export/import', async () => {
    const a = await openDb(fresh());
    await a.saveSettings({ ...DEFAULT_SETTINGS, attackLines: true });
    await a.saveGame({ ...game('a'), attackLinesMoves: 7, userMoves: 9 });
    const b = await openDb(fresh());
    await b.importAll(await a.exportAll());
    expect((await b.getSettings()).attackLines).toBe(true);
    const g = await b.getGame('a');
    expect([g?.attackLinesMoves, g?.userMoves]).toEqual([7, 9]);
  });

  it('imports a backup with no teaching fields', async () => {
    const db = await openDb(fresh());
    await db.importAll(JSON.stringify({ app: 'chess-coach', version: 1, games: [game('a')], profile: defaultProfile() }));
    expect((await db.getProfile()).teaching).toBeUndefined();
    expect((await db.getGame('a'))!.mode).toBeUndefined();
  });

  it('round-trips mode, teaching and teachCount through export/import', async () => {
    const a = await openDb(fresh());
    const p = defaultProfile();
    p.teaching = { gamesFinished: 2, topics: { safety: { mode: 'guide', shown: 3, need: 2, recent: [true, false] } } };
    p.themes.hanging_piece = { ...p.themes.hanging_piece, teachCount: 1, teachExamples: [{ gameId: 't', ply: 4, fen: 'f' }] };
    await a.saveProfile(p);
    await a.saveGame({ ...game('t'), mode: 'teach' });
    const b = await openDb(fresh());
    await b.importAll(await a.exportAll());
    expect((await b.getGame('t'))!.mode).toBe('teach');
    const q = await b.getProfile();
    expect(q.teaching).toEqual(p.teaching);
    expect(q.themes.hanging_piece.teachCount).toBe(1);
    expect(q.themes.hanging_piece.teachExamples).toEqual([{ gameId: 't', ply: 4, fen: 'f' }]);
  });

  it("rejects mode: 'other'", async () => {
    const db = await openDb(fresh());
    const bad = { ...game('x'), mode: 'other' };
    await expect(db.importAll(JSON.stringify({ app: 'chess-coach', version: 1, games: [bad] }))).rejects.toBeInstanceOf(ImportError);
  });
});
