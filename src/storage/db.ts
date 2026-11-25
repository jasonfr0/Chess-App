import { openDB, type IDBPDatabase } from 'idb';
import { z } from 'zod/v4';
import type { Area, CoachLevel, Color, GameResult, ProfileData, Theme } from '../types';
import type { Verdict } from '../coach/classify';
import { MODEL_IDS, type ModelId } from '../coach/claude';

export interface Settings {
  apiKey: string;
  model: ModelId;
  levelOverride: Partial<Record<Area, CoachLevel>>;
  clockMinutes: number | null;
  opponentRating: number;
}
export const DEFAULT_SETTINGS: Settings = {
  apiKey: '', model: 'claude-sonnet-5-5', levelOverride: {}, clockMinutes: null, opponentRating: 600,
};

export interface SavedGame {
  id: string; startedAt: number; userColor: Color; moves: string[];
  verdicts: Verdict[]; result: GameResult | null;
}

export interface Db {
  getSettings(): Promise<Settings>;
  saveSettings(s: Settings): Promise<void>;
  saveGame(g: SavedGame): Promise<void>;
  getGame(id: string): Promise<SavedGame | undefined>;
  listGames(): Promise<SavedGame[]>;
  currentGameId(): Promise<string | null>;
  setCurrentGame(id: string | null): Promise<void>;
  getProfile(): Promise<ProfileData>;
  saveProfile(p: ProfileData): Promise<void>;
  exportAll(): Promise<string>;
  importAll(json: string): Promise<void>;
}

export class ImportError extends Error {
  constructor(message: string) { super(message); this.name = 'ImportError'; }
}

export const THEMES: Theme[] = [
  'hanging_piece', 'ignored_threat', 'allowed_fork', 'missed_fork', 'missed_pin', 'missed_mate',
  'allowed_mate', 'early_queen', 'undeveloped', 'king_safety', 'bad_trade', 'endgame_technique', 'other',
];

export function defaultProfile(): ProfileData {
  const themes = {} as ProfileData['themes'];
  for (const t of THEMES) themes[t] = { count: 0, lastSeen: 0, examples: [] };
  return {
    themes,
    moves: { opening: [], middlegame: [], endgame: [] },
    levels: { opening: 'full', middlegame: 'full', endgame: 'light' },
  };
}

const areaEnum = z.enum(['opening', 'middlegame', 'endgame']);
const levelEnum = z.enum(['full', 'guided', 'light', 'solo']);
const settingsSchema = z.object({
  apiKey: z.string().optional(),
  model: z.enum(MODEL_IDS),
  levelOverride: z.partialRecord(areaEnum, levelEnum),
  clockMinutes: z.number().nullable(),
  opponentRating: z.number(),
});
const gameSchema = z.object({
  id: z.string(),
  startedAt: z.number(),
  userColor: z.enum(['w', 'b']),
  moves: z.array(z.string()),
  verdicts: z.array(z.looseObject({})),
  result: z.object({
    winner: z.enum(['w', 'b']).nullable(),
    reason: z.enum(['checkmate', 'stalemate', 'repetition', 'fifty_move', 'insufficient', 'resign', 'timeout']),
  }).nullable(),
});
const themeStatSchema = z.looseObject({
  count: z.number(),
  lastSeen: z.number(),
  examples: z.array(z.looseObject({ gameId: z.string(), ply: z.number(), fen: z.string() })),
});
const moveRecordSchema = z.looseObject({ good: z.boolean(), flagged: z.boolean(), at: z.number() });
const profileSchema = z.looseObject({
  themes: z.record(z.string(), themeStatSchema),
  moves: z.looseObject({
    opening: z.array(moveRecordSchema), middlegame: z.array(moveRecordSchema), endgame: z.array(moveRecordSchema),
  }),
  levels: z.record(areaEnum, levelEnum),
  levelChangedAt: z.partialRecord(areaEnum, z.number()).optional(),
});
const backupSchema = z.object({
  app: z.literal('chess-coach'),
  version: z.literal(1),
  exportedAt: z.number().optional(),
  settings: settingsSchema.optional(),
  games: z.array(gameSchema),
  currentGameId: z.string().nullable().optional(),
  profile: profileSchema.optional(),
});

async function open(name: string): Promise<IDBPDatabase> {
  return openDB(name, 1, {
    upgrade(d) {
      d.createObjectStore('games', { keyPath: 'id' });
      d.createObjectStore('kv');
    },
  });
}

export async function openDb(name = 'chess-coach'): Promise<Db> {
  const d = await open(name);
  const getSettings = async (): Promise<Settings> => ({
    ...DEFAULT_SETTINGS, ...((await d.get('kv', 'settings')) as Partial<Settings> | undefined),
  });
  const getProfile = async (): Promise<ProfileData> => {
    const stored = (await d.get('kv', 'profile')) as ProfileData | undefined;
    if (!stored) return defaultProfile();
    const base = defaultProfile();
    return { ...stored, themes: { ...base.themes, ...stored.themes } };
  };
  const listGames = async () => ((await d.getAll('games')) as SavedGame[]).sort((a, b) => a.startedAt - b.startedAt);

  return {
    getSettings,
    saveSettings: async (s) => { await d.put('kv', s, 'settings'); },
    saveGame: async (g) => { await d.put('games', g); },
    getGame: async (id) => (await d.get('games', id)) as SavedGame | undefined,
    listGames,
    currentGameId: async () => ((await d.get('kv', 'currentGameId')) as string | null | undefined) ?? null,
    setCurrentGame: async (id) => { await d.put('kv', id, 'currentGameId'); },
    getProfile,
    saveProfile: async (p) => { await d.put('kv', p, 'profile'); },

    async exportAll() {
      const { apiKey: _omit, ...settings } = await getSettings();
      return JSON.stringify({
        app: 'chess-coach', version: 1, exportedAt: Date.now(),
        settings, games: await listGames(),
        currentGameId: ((await d.get('kv', 'currentGameId')) as string | null | undefined) ?? null,
        profile: await getProfile(),
      });
    },

    async importAll(json) {
      let raw: unknown;
      try { raw = JSON.parse(json); } catch { throw new ImportError('Not valid JSON'); }
      const parsed = backupSchema.safeParse(raw);
      if (!parsed.success) throw new ImportError('Not a Chess Coach backup: ' + parsed.error.message);
      const b = parsed.data;
      const existing = await getSettings(); // read before the transaction; keeps local apiKey
      const tx = d.transaction(['games', 'kv'], 'readwrite');
      const games = tx.objectStore('games');
      const kv = tx.objectStore('kv');
      const currentId = b.currentGameId && b.games.some((g) => g.id === b.currentGameId) ? b.currentGameId : null;
      const pending: Promise<unknown>[] = [tx.done];
      try {
        // Every request promise and tx.done are collected and awaited together, so a failure
        // (even a synchronous throw mid-way) never leaves an unhandled rejection behind.
        pending.push(games.clear());
        for (const g of b.games) pending.push(games.put(g));
        if (b.settings) pending.push(kv.put({ ...DEFAULT_SETTINGS, ...b.settings, apiKey: existing.apiKey }, 'settings'));
        pending.push(kv.put(currentId, 'currentGameId'));
        if (b.profile) pending.push(kv.put(b.profile, 'profile'));
        await Promise.all(pending);
      } catch (e) {
        for (const p of pending) p.catch(() => {});
        try { tx.abort(); } catch { /* already finished */ }
        throw new ImportError('Import failed: ' + (e instanceof Error ? e.message : String(e)));
      }
    },
  };
}
