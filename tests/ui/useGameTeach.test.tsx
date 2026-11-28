import 'fake-indexeddb/auto';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { renderHook, act, waitFor, cleanup } from '@testing-library/react';
import { Chess } from 'chess.js';
import { useGame, type CoachApi, type GameDeps } from '../../src/ui/useGame';
import type { Engine } from '../../src/engine/engine';
import type { Verdict } from '../../src/coach/classify';
import type { CoachMessage } from '../../src/coach/coach';
import type { TeachOption } from '../../src/teach/options';
import type { Analysis, ProfileData, TeachMode, TeachState, TeachTopic, Theme } from '../../src/types';
import { openDb, DEFAULT_SETTINGS, defaultProfile, type Db, type SavedGame, type Settings } from '../../src/storage/db';

afterEach(cleanup);

let n = 0;

/** Searches answer at once with no lines: the opponent then plays a safe move chosen by rng. */
const engine: Engine = {
  analyse: (fen: string): Promise<Analysis> => Promise.resolve({ fen, depth: 1, lines: [] }),
  stop: () => {},
  busy: () => false,
};

const verdictFor = (uci: string, san: string, flagged: boolean, theme: Theme = 'hanging_piece'): Verdict => ({
  flagged, severity: flagged ? 'blunder' : 'ok', cpLoss: flagged ? 400 : 0, area: 'opening', theme,
  recommendation: flagged ? 'take_back' : 'play_on', bestUci: uci, bestSan: san, refutationSan: [],
});

const OPTION: TeachOption = { uci: 'e2e4', san: 'e4', reason: 'It takes the centre.', watch: null };

interface TeachCoachOpts {
  topic?: TeachTopic; mode?: TeachMode; options?: TeachOption[];
  /** Which user moves (1-based, counting attempts) are flagged. */
  flagged?: number[];
  /** The first teaching turn never arrives (the user moves before it is shown). */
  holdFirstTurn?: boolean;
}

/** A coach whose teaching turns report a fixed topic, mode and options. */
function teachCoach(o: TeachCoachOpts = {}) {
  const topic = o.topic ?? 'safety';
  const mode = o.mode ?? 'show';
  const options = o.options ?? [OPTION];
  let id = 0;
  let attempt = 0;
  const turns = new Map<string, CoachMessage>();
  const coach = {
    onUpdate: vi.fn(),
    cancelPending: vi.fn(),
    setMode: vi.fn(),
    preMove: vi.fn(async () => null),
    teachTurn: vi.fn(async (): Promise<CoachMessage | null> => {
      if (o.holdFirstTurn && id === 0) { id++; return new Promise<CoachMessage | null>(() => {}); }
      const m: CoachMessage = {
        id: `teach-${++id}`, kind: 'teach', source: 'template', arrows: [], explanation: { whatHappened: 'The position.' },
        teach: { topic, mode, position: 'The position.', options, optionsOpen: mode === 'show', inBook: false },
      };
      turns.set(m.id, m);
      return m;
    }),
    openOptions: vi.fn((messageId: string): CoachMessage | null => {
      const m = turns.get(messageId);
      return m?.teach ? { ...m, teach: { ...m.teach, optionsOpen: true } } : null;
    }),
    onUserMove: vi.fn(async (_g: unknown, move: { uci: string; san: string }) => {
      attempt++;
      const flagged = (o.flagged ?? []).includes(attempt);
      const verdict = verdictFor(move.uci, move.san, flagged);
      const message: CoachMessage = flagged
        ? {
          id: `mistake-${attempt}`, kind: 'mistake', source: 'template', verdict, reveal: true,
          arrows: [{ from: 'd2', to: 'd4', color: 'green' }],
          explanation: { whatHappened: 'That loses a piece.', better: 'd4 was better.' },
        }
        : {
          id: `post-${attempt}`, kind: 'post_move', source: 'template', verdict, summary: '✓ Good move.',
          topKind: 'top', explained: true, arrows: [], explanation: { whatHappened: 'A fine move.' },
        };
      return { verdict, message };
    }),
    explainTopMove: vi.fn(async () => {}),
    hintStep: vi.fn(() => ({ text: '', highlight: [] as string[] })),
    showMe: vi.fn(() => null),
    playOnReveal: vi.fn(() => null),
    playOn: vi.fn(),
    checkConsequence: vi.fn(() => null),
    recap: vi.fn((): CoachMessage => ({ id: 'recap', kind: 'recap', arrows: [], source: 'template', explanation: { whatHappened: 'Play recap.' } })),
    teachRecap: vi.fn((): CoachMessage => ({ id: 'teach-recap', kind: 'recap', arrows: [], source: 'template', explanation: { whatHappened: 'Teaching recap.' } })),
  } satisfies CoachApi;
  return coach;
}

interface SetupOpts {
  profile?: ProfileData; settings?: Settings; coach?: ReturnType<typeof teachCoach>;
  prepare?: (db: Db) => Promise<void>; startFen?: string;
}

async function setup(o: SetupOpts = {}) {
  const db = await openDb(`use-game-teach-${n++}`);
  await o.prepare?.(db);
  const coach = o.coach ?? teachCoach();
  const start = o.profile ?? defaultProfile();
  const onProfile = vi.fn((_p: ProfileData) => {});
  const onSettings = vi.fn((_s: Settings) => {});
  const deps: GameDeps = {
    db, engine, coach, profile: start, settings: o.settings ?? DEFAULT_SETTINGS,
    onProfile, onSettings, rng: () => 0.5, startFen: o.startFen,
  };
  const hook = renderHook(() => useGame(deps));
  const view = () => hook.result.current[0];
  const actions = () => hook.result.current[1];
  const profile = (): ProfileData => (onProfile.mock.calls.at(-1)?.[0] as ProfileData | undefined) ?? start;
  return { db, coach, onProfile, onSettings, view, actions, profile };
}

type Setup = Awaited<ReturnType<typeof setup>>;

/** Waits for the user's turn with its teaching message shown. */
async function userTurn(s: Setup) {
  await waitFor(() => {
    expect(s.view().phase).toBe('user');
    expect(s.view().coachMsg?.kind).toBe('teach');
  });
}

/** Plays the first legal move in the position. */
function playAny(s: Setup) {
  const moves = new Chess(s.view().game!.fen()).moves({ verbose: true });
  const m = moves[0];
  let ok = false;
  act(() => { ok = s.actions().userMove(m.from + m.to + (m.promotion ?? '')); });
  expect(ok).toBe(true);
}

/** Strips the teaching-only fields, leaving what the assessment reads. */
function withoutTeaching(p: ProfileData): ProfileData {
  const { teaching: _t, ...rest } = p;
  const themes = Object.fromEntries(Object.entries(rest.themes).map(([k, v]) => {
    const { teachCount: _c, teachExamples: _e, ...stat } = v;
    return [k, stat];
  })) as ProfileData['themes'];
  return { ...rest, themes };
}

const lostGame = (i: number): SavedGame => ({
  id: `old-${i}`, startedAt: i, userColor: 'w', moves: ['f2f3', 'e7e5', 'g2g4', 'd8h4'], verdicts: [],
  result: { winner: 'b', reason: 'checkmate' },
});

describe('useGame: teaching games', () => {
  it('a teaching game never touches the assessment', async () => {
    const start = defaultProfile();
    start.levels = { opening: 'solo', middlegame: 'solo', endgame: 'solo' };
    const snapshot = structuredClone(start);
    const s = await setup({
      profile: start,
      settings: { ...DEFAULT_SETTINGS, opponentRating: 600 },
      coach: teachCoach({ flagged: [2] }),
      prepare: async (db) => { for (let i = 0; i < 5; i++) await db.saveGame(lostGame(i)); },
    });
    await waitFor(() => expect(s.view().phase).toBe('setup'));
    expect(s.view().mode).toBe('play');
    act(() => s.actions().start('w', 'teach'));
    expect(s.view().mode).toBe('teach');
    expect(s.coach.setMode).toHaveBeenCalledWith('teach');

    for (let move = 1; move <= 4; move++) {
      await userTurn(s);
      playAny(s);
      if (move === 2) {
        await waitFor(() => expect(s.view().phase).toBe('mistake'));
        act(() => s.actions().playOn());
      }
    }
    await userTurn(s);
    act(() => s.actions().resign());
    await waitFor(() => expect(s.view().recap?.id).toBe('teach-recap'));

    const end = s.profile();
    expect(end.moves).toEqual(snapshot.moves);
    expect(end.levels).toEqual(snapshot.levels);
    for (const [theme, stat] of Object.entries(end.themes)) {
      const before = snapshot.themes[theme as Theme];
      expect(stat.count).toBe(before.count);
      expect(stat.examples).toEqual(before.examples);
    }
    // Everything the assessment reads is exactly as it was.
    expect(withoutTeaching(end)).toEqual(snapshot);
    expect(start).toEqual(snapshot);
    expect(end.themes.hanging_piece.teachCount).toBe(1);
    expect(end.teaching?.gamesFinished).toBe(1);
    expect(s.onSettings).not.toHaveBeenCalled();
    expect(s.coach.recap).not.toHaveBeenCalled();
    expect(s.coach.teachRecap).toHaveBeenCalledWith(expect.any(Array), ['safety'], []);
    expect(s.view().levelNotes).toEqual([]);
    expect(s.view().clockSuggestion).toBe(false);
    expect(s.view().linesOffSuggestion).toBe(false);
    expect(s.coach.preMove).not.toHaveBeenCalled();

    let saved: SavedGame | undefined;
    await waitFor(async () => {
      saved = (await s.db.listGames()).find((g) => !g.id.startsWith('old-'));
      expect(saved?.result).not.toBeNull();
    });
    expect(saved!.mode).toBe('teach');
  });

  it('resuming keeps the mode', async () => {
    const s = await setup({
      prepare: async (db) => {
        await db.saveGame({ id: 'g1', startedAt: 1, userColor: 'w', moves: [], verdicts: [], result: null, mode: 'teach' });
        await db.setCurrentGame('g1');
      },
    });
    await userTurn(s);
    expect(s.view().mode).toBe('teach');
    expect(s.coach.setMode).toHaveBeenCalledWith('teach');
    expect(s.coach.teachTurn).toHaveBeenCalled();
    expect(s.coach.preMove).not.toHaveBeenCalled();
  });

  it('a retry after take-back is not counted again', async () => {
    const start: ProfileData = { ...defaultProfile(), teaching: { gamesFinished: 3, topics: {} } };
    const s = await setup({ profile: start, coach: teachCoach({ topic: 'safety', mode: 'show', flagged: [1] }) });
    await waitFor(() => expect(s.view().phase).toBe('setup'));
    act(() => s.actions().start('w', 'teach'));
    await userTurn(s);
    playAny(s);
    await waitFor(() => expect(s.view().phase).toBe('mistake'));
    expect(s.profile().teaching?.topics.safety?.shown).toBe(1);
    act(() => s.actions().takeBack());
    await userTurn(s);
    playAny(s);
    await waitFor(() => expect(s.coach.onUserMove).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(s.view().phase).not.toBe('checking'));
    expect(s.profile().teaching?.topics.safety?.shown).toBe(1);
    // The taken-back mistake still counts as a teaching theme.
    expect(s.profile().themes.hanging_piece.teachCount).toBe(1);
    expect(s.profile().moves).toEqual(start.moves);
  });

  it('a first attempt played before the turn showed is not counted, nor is its retry', async () => {
    const start: ProfileData = { ...defaultProfile(), teaching: { gamesFinished: 3, topics: {} } };
    const s = await setup({ profile: start, coach: teachCoach({ topic: 'safety', mode: 'show', flagged: [1], holdFirstTurn: true }) });
    await waitFor(() => expect(s.view().phase).toBe('setup'));
    act(() => s.actions().start('w', 'teach'));
    await waitFor(() => expect(s.view().phase).toBe('user'));
    expect(s.view().coachMsg).toBeNull();
    playAny(s);
    await waitFor(() => expect(s.view().phase).toBe('mistake'));
    act(() => s.actions().takeBack());
    await userTurn(s); // the retry's turn is shown
    playAny(s);
    await waitFor(() => expect(s.coach.onUserMove).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(s.view().phase).not.toBe('checking'));
    expect(s.profile().teaching?.topics.safety).toBeUndefined();
    expect(s.profile().themes.hanging_piece.teachCount).toBe(1);
  });

  it('opening the options counts as a miss', async () => {
    const start: ProfileData = { ...defaultProfile(), teaching: { gamesFinished: 3, topics: {} } };
    const s = await setup({ profile: start, coach: teachCoach({ topic: 'safety', mode: 'guide' }) });
    await waitFor(() => expect(s.view().phase).toBe('setup'));
    act(() => s.actions().start('w', 'teach'));
    await userTurn(s);
    expect(s.view().coachMsg?.teach?.optionsOpen).toBe(false);
    act(() => s.actions().showOptions());
    expect(s.coach.openOptions).toHaveBeenCalledWith(s.view().coachMsg!.id);
    expect(s.view().coachMsg?.teach?.optionsOpen).toBe(true);
    playAny(s);
    await waitFor(() => expect(s.profile().teaching?.topics.safety?.recent).toEqual([false]));
  });

  it('a turn with no options is not counted', async () => {
    const teaching: TeachState = { gamesFinished: 3, topics: {} };
    const start: ProfileData = { ...defaultProfile(), teaching };
    const s = await setup({ profile: start, coach: teachCoach({ topic: 'safety', mode: 'show', options: [] }) });
    await waitFor(() => expect(s.view().phase).toBe('setup'));
    act(() => s.actions().start('w', 'teach'));
    await userTurn(s);
    playAny(s);
    await waitFor(() => expect(s.coach.onUserMove).toHaveBeenCalledTimes(1));
    await userTurn(s);
    expect(s.profile().teaching).toEqual(teaching);
  });

  it('teaching games have no clock', async () => {
    const s = await setup({ settings: { ...DEFAULT_SETTINGS, clockMinutes: 5 } });
    await waitFor(() => expect(s.view().phase).toBe('setup'));
    act(() => s.actions().start('w', 'teach'));
    expect(s.view().clock).toBeNull();
    await userTurn(s);
    expect(s.view().clock).toBeNull();
  });

  it('watching an option plays its line and returns to the turn', async () => {
    const chess = new Chess();
    const watch = ['e2e4', 'e7e5'].map((uci, i) => {
      const san = chess.move({ from: uci.slice(0, 2), to: uci.slice(2, 4) }).san;
      return { uci, san, fen: chess.fen(), by: i % 2 === 0 ? 'user' as const : 'opponent' as const };
    });
    const s = await setup({ coach: teachCoach({ options: [OPTION, { ...OPTION, uci: 'd2d4', san: 'd4', watch }] }) });
    await waitFor(() => expect(s.view().phase).toBe('setup'));
    act(() => s.actions().start('w', 'teach'));
    await userTurn(s);
    act(() => s.actions().watchOption(0)); // no line: nothing to watch
    expect(s.view().watching).toBeNull();
    act(() => s.actions().watchOption(1));
    expect(s.view().watching).toEqual({ plies: watch, index: 0 });
    act(() => s.actions().closeWatch());
    expect(s.view().watching).toBeNull();
    expect(s.view().phase).toBe('user');
  });

  describe('a new game started while the finished one is still ending', () => {
    const settle = () => act(async () => { await new Promise((r) => setTimeout(r, 50)); });
    const withLosses = async (db: Db) => { for (let i = 0; i < 5; i++) await db.saveGame(lostGame(i)); };
    const soloProfile = () => {
      const p = defaultProfile();
      p.levels = { opening: 'solo', middlegame: 'solo', endgame: 'solo' };
      return p;
    };

    it('New game right after a teaching game ends: still a teaching game end', async () => {
      const start = soloProfile();
      const snapshot = structuredClone(start);
      const s = await setup({ profile: start, prepare: withLosses });
      await waitFor(() => expect(s.view().phase).toBe('setup'));
      act(() => s.actions().start('w', 'teach'));
      await userTurn(s);
      act(() => { s.actions().resign(); s.actions().newGame(); });
      await settle();
      expect(s.view().phase).toBe('setup');
      expect(s.view().recap).toBeNull();
      expect(s.onSettings).not.toHaveBeenCalled();
      expect(s.coach.recap).not.toHaveBeenCalled();
      expect(s.profile().levels).toEqual(snapshot.levels);
      expect(s.profile().moves).toEqual(snapshot.moves);
      expect(s.profile().teaching?.gamesFinished).toBe(1);
    });

    it('a play game started right after a teaching game ends gets no teaching recap', async () => {
      const s = await setup({ prepare: withLosses });
      await waitFor(() => expect(s.view().phase).toBe('setup'));
      act(() => s.actions().start('w', 'teach'));
      await userTurn(s);
      act(() => { s.actions().resign(); s.actions().start('w', 'play'); });
      await waitFor(() => expect(s.view().phase).toBe('user'));
      await settle();
      expect(s.view().mode).toBe('play');
      expect(s.view().recap).toBeNull();
      expect(s.onSettings).not.toHaveBeenCalled();
      expect(s.profile().teaching?.gamesFinished).toBe(1);
    });

    it('a teaching game started right after a play game ends: the play game is still assessed', async () => {
      const coach = teachCoach();
      const s = await setup({ coach, prepare: withLosses, settings: { ...DEFAULT_SETTINGS, opponentRating: 600 } });
      await waitFor(() => expect(s.view().phase).toBe('setup'));
      act(() => s.actions().start('w'));
      await waitFor(() => expect(s.view().phase).toBe('user'));
      act(() => { s.actions().resign(); s.actions().start('w', 'teach'); });
      await waitFor(() => expect(s.onSettings).toHaveBeenCalled());
      expect((s.onSettings.mock.calls.at(-1)![0] as Settings).opponentRating).toBeLessThan(600);
      expect(coach.recap).toHaveBeenCalled();
      expect(coach.teachRecap).not.toHaveBeenCalled();
      await userTurn(s);
      await settle();
      expect(s.view().mode).toBe('teach');
      expect(s.view().recap).toBeNull();
      expect(s.profile().teaching?.gamesFinished ?? 0).toBe(0);
    });
  });

  it('a play game after a teaching game still records moves', async () => {
    const coach = teachCoach();
    const s = await setup({ coach });
    await waitFor(() => expect(s.view().phase).toBe('setup'));
    act(() => s.actions().start('w', 'teach'));
    await userTurn(s);
    act(() => s.actions().resign());
    await waitFor(() => expect(s.view().recap).not.toBeNull());
    act(() => s.actions().newGame());
    expect(s.view().mode).toBe('play');
    act(() => s.actions().start('w'));
    expect(s.view().mode).toBe('play');
    expect(coach.setMode).toHaveBeenLastCalledWith('play');
    await waitFor(() => expect(s.view().phase).toBe('user'));
    expect(coach.preMove).toHaveBeenCalled();
    playAny(s);
    await waitFor(() => expect(s.profile().moves.opening).toHaveLength(1));
  });
});
