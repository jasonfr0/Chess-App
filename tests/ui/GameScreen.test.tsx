import 'fake-indexeddb/auto';
import '@testing-library/jest-dom/vitest';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, act, waitFor } from '@testing-library/react';
import type { ChessboardOptions } from 'react-chessboard';
import { GameScreen } from '../../src/ui/GameScreen';
import type { CoachApi } from '../../src/ui/useGame';
import type { Engine } from '../../src/engine/engine';
import type { Verdict } from '../../src/coach/classify';
import type { CoachMessage } from '../../src/coach/coach';
import type { Analysis } from '../../src/types';
import { openDb, DEFAULT_SETTINGS, defaultProfile, type Db, type Settings } from '../../src/storage/db';
import type { ProfileData } from '../../src/types';

const board = vi.hoisted(() => ({ options: null as ChessboardOptions | null }));
vi.mock('react-chessboard', () => ({
  Chessboard: ({ options }: { options: ChessboardOptions }) => {
    board.options = options;
    return <div data-testid="board" data-fen={String(options.position)} />;
  },
}));

afterEach(cleanup);

let n = 0;
const fen = () => screen.getByTestId('board').getAttribute('data-fen')!;
const drop = (from: string, to: string): boolean => {
  let ok = false;
  act(() => {
    ok = board.options!.onPieceDrop!({
      piece: { isSparePiece: false, position: from, pieceType: 'wP' }, sourceSquare: from, targetSquare: to,
    });
  });
  return ok;
};

class FakeEngine implements Engine {
  calls: { fen: string; depth: number }[] = [];
  /** Searches never answer while held. */
  hold = false;
  stops = 0;
  private held = 0;
  analyse(fen: string, opts: { multipv: number; depth: number }): Promise<Analysis> {
    this.calls.push({ fen, depth: opts.depth });
    if (this.hold) { this.held++; return new Promise(() => {}); }
    return Promise.resolve({ fen, depth: opts.depth, lines: [] });
  }
  stop(): void { this.stops++; this.held = 0; }
  busy(): boolean { return this.held > 0; }
}

function fakeCoach(): CoachApi & { recap: ReturnType<typeof vi.fn> } {
  const ok = (uci: string, san: string): Verdict => ({
    flagged: false, severity: 'ok', cpLoss: 0, area: 'opening', theme: 'other', recommendation: 'play_on',
    bestUci: uci, bestSan: san, refutationSan: [],
  });
  const recapMessage: CoachMessage = {
    id: 'recap', kind: 'recap', arrows: [], source: 'template',
    explanation: { whatHappened: 'No big mistakes this game.', better: 'Well played.', lesson: 'Keep checking.' },
  };
  return {
    onUpdate: vi.fn(),
    cancelPending: vi.fn(),
    preMove: vi.fn(async () => null),
    onUserMove: vi.fn(async (_g, move) => ({ verdict: ok(move.uci, move.san), message: null })),
    hint: vi.fn(() => ''),
    playOn: vi.fn(),
    checkConsequence: vi.fn(() => null),
    recap: vi.fn(() => recapMessage),
  };
}

interface SetupOpts {
  profile?: ProfileData; settings?: Settings; coach?: ReturnType<typeof fakeCoach>;
  prepare?: (db: Db) => Promise<void>;
}

async function setup(startFen?: string, o: SetupOpts = {}) {
  const db = await openDb(`game-screen-${n++}`);
  await o.prepare?.(db);
  const engine = new FakeEngine();
  const coach = o.coach ?? fakeCoach();
  const onProfile = vi.fn((_p: ProfileData) => {});
  const onGameListChanged = vi.fn();
  render(
    <GameScreen
      db={db} engine={engine} coach={coach} profile={o.profile ?? defaultProfile()} settings={o.settings ?? DEFAULT_SETTINGS}
      onProfile={onProfile} onSettings={() => {}} onGameListChanged={onGameListChanged}
      rng={() => 0.5} startFen={startFen} coachOffline={false}
    />,
  );
  return { db, engine, coach, onProfile, onGameListChanged };
}

const START = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';

/** A pre-move message offering e4 (best, with its green arrow) and Nf3. */
const choicesMessage = (): CoachMessage => ({
  id: 'pre-1', kind: 'pre_move', source: 'template',
  arrows: [{ from: 'e2', to: 'e4', color: 'green' }],
  explanation: {
    whatHappened: 'Start in the center.',
    candidates: [
      { san: 'e4', uci: 'e2e4', note: 'takes the center', best: true },
      { san: 'Nf3', uci: 'g1f3', note: 'develops your knight', best: false },
    ],
  },
});

const lastRecord = (onProfile: ReturnType<typeof vi.fn>) => {
  const p = onProfile.mock.calls.at(-1)![0] as ProfileData;
  return p.moves.opening.at(-1);
};

describe('GameScreen', () => {
  it('asks for the promotion piece and plays the chosen one', async () => {
    await setup('k7/4P3/8/8/8/8/7p/K7 w - - 0 1');
    fireEvent.click(await screen.findByRole('button', { name: 'White' }));
    await waitFor(() => expect(board.options?.allowDragging).toBe(true));
    expect(drop('e7', 'e8')).toBe(false);
    const picker = await screen.findByRole('dialog', { name: /promote/i });
    expect(picker).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Knight' }));
    await waitFor(() => expect(fen().split(' ')[0]).toBe('k3N3/8/8/8/8/8/7p/K7'));
    expect(screen.queryByRole('dialog', { name: /promote/i })).not.toBeInTheDocument();
  });

  it('ignores board drops while the opponent is thinking', async () => {
    const { engine } = await setup();
    engine.hold = true;
    fireEvent.click(await screen.findByRole('button', { name: 'White' }));
    await waitFor(() => expect(board.options?.allowDragging).toBe(true));
    expect(drop('e2', 'e4')).toBe(true);
    await waitFor(() => expect(engine.calls.some((c) => c.depth === 10)).toBe(true));
    const before = fen();
    expect(board.options!.allowDragging).toBe(false);
    expect(drop('e7', 'e5')).toBe(false);
    expect(drop('d2', 'd4')).toBe(false);
    expect(fen()).toBe(before);
  });

  it('shows the recap after checkmate and stops dragging', async () => {
    const { coach } = await setup('r1bqkb1r/pppp1ppp/2n2n2/4p2Q/2B1P3/8/PPPP1PPP/RNB1K1NR w KQkq - 4 4');
    fireEvent.click(await screen.findByRole('button', { name: 'White' }));
    await waitFor(() => expect(board.options?.allowDragging).toBe(true));
    drop('h5', 'f7');
    expect(await screen.findByRole('region', { name: /game over/i })).toHaveTextContent('No big mistakes this game.');
    expect(coach.recap).toHaveBeenCalled();
    expect(board.options!.allowDragging).toBe(false);
  });

  it('does not record an unanalysed (engine-failure) verdict', async () => {
    const coach = fakeCoach();
    coach.onUserMove = vi.fn(async (_g, move) => ({
      verdict: { flagged: false, severity: 'ok' as const, cpLoss: 0, area: 'opening' as const, theme: 'other' as const,
        recommendation: 'play_on' as const, bestUci: move.uci, bestSan: move.san, refutationSan: [], analysed: false },
      message: null,
    }));
    const { engine, onProfile } = await setup(undefined, { coach });
    fireEvent.click(await screen.findByRole('button', { name: 'White' }));
    await waitFor(() => expect(board.options?.allowDragging).toBe(true));
    drop('e2', 'e4');
    await waitFor(() => expect(engine.calls.some((c) => c.depth === 10)).toBe(true));
    expect(onProfile).not.toHaveBeenCalled();
  });

  it('records a move copied from the shown choices as assisted (full level)', async () => {
    const coach = fakeCoach();
    coach.preMove = vi.fn(async () => choicesMessage());
    const { onProfile } = await setup(undefined, { coach });
    fireEvent.click(await screen.findByRole('button', { name: 'White' }));
    await screen.findByText(/takes the center/);
    drop('e2', 'e4');
    await waitFor(() => expect(onProfile).toHaveBeenCalled());
    expect(lastRecord(onProfile)).toMatchObject({ assisted: true, good: false });
  });

  it('a move that was not among the shown choices is independent', async () => {
    const coach = fakeCoach();
    coach.preMove = vi.fn(async () => choicesMessage());
    const { onProfile } = await setup(undefined, { coach });
    fireEvent.click(await screen.findByRole('button', { name: 'White' }));
    await screen.findByText(/takes the center/);
    drop('d2', 'd4');
    await waitFor(() => expect(onProfile).toHaveBeenCalled());
    expect(lastRecord(onProfile)).toMatchObject({ good: true });
    expect(lastRecord(onProfile)?.assisted).toBeUndefined();
  });

  it('at guided, a choice counts as assisted only once Show choices was tapped', async () => {
    const guided: ProfileData = { ...defaultProfile(), levels: { opening: 'guided', middlegame: 'full', endgame: 'light' } };
    const coach = fakeCoach();
    coach.preMove = vi.fn(async () => choicesMessage());
    const { onProfile } = await setup(undefined, { coach, profile: guided });
    fireEvent.click(await screen.findByRole('button', { name: 'White' }));
    await screen.findByText('Start in the center.');
    expect(screen.queryByText(/takes the center/)).not.toBeInTheDocument();
    drop('e2', 'e4');
    await waitFor(() => expect(onProfile).toHaveBeenCalled());
    expect(lastRecord(onProfile)?.assisted).toBeUndefined();
  });

  it('at guided, tapping Show choices then playing one marks it assisted', async () => {
    const guided: ProfileData = { ...defaultProfile(), levels: { opening: 'guided', middlegame: 'full', endgame: 'light' } };
    const coach = fakeCoach();
    coach.preMove = vi.fn(async () => choicesMessage());
    const { onProfile } = await setup(undefined, { coach, profile: guided });
    fireEvent.click(await screen.findByRole('button', { name: 'White' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Show choices' }));
    await screen.findByText(/takes the center/);
    drop('g1', 'f3');
    await waitFor(() => expect(onProfile).toHaveBeenCalled());
    expect(lastRecord(onProfile)?.assisted).toBe(true);
  });

  it('does not announce level changes or suggest the clock against manual overrides', async () => {
    // 40 good opening moves step the opening down at the end of this game, and every area is past full...
    const p = defaultProfile();
    const profile: ProfileData = {
      ...p, levels: { opening: 'full', middlegame: 'guided', endgame: 'light' },
      moves: { ...p.moves, opening: Array.from({ length: 40 }, (_, i) => ({ good: true, flagged: false, bad: false, at: i })) },
    };
    // ...but the user pinned the opening to full.
    const settings: Settings = { ...DEFAULT_SETTINGS, levelOverride: { opening: 'full' } };
    await setup('r1bqkb1r/pppp1ppp/2n2n2/4p2Q/2B1P3/8/PPPP1PPP/RNB1K1NR w KQkq - 4 4', { profile, settings });
    fireEvent.click(await screen.findByRole('button', { name: 'White' }));
    await waitFor(() => expect(board.options?.allowDragging).toBe(true));
    drop('h5', 'f7');
    const recap = await screen.findByRole('region', { name: /game over/i });
    await waitFor(() => expect(recap).toHaveTextContent('No big mistakes this game.'));
    expect(recap).not.toHaveTextContent(/spotting threats/);
    expect(recap).not.toHaveTextContent(/clock/);
  });

  it('at light, "Ask the coach" asks for coaching on demand', async () => {
    const light: ProfileData = { ...defaultProfile(), levels: { opening: 'light', middlegame: 'light', endgame: 'light' } };
    const coach = fakeCoach();
    coach.preMove = vi.fn(async (_g, o?: { force?: boolean }) => (o?.force ? choicesMessage() : null));
    await setup(undefined, { coach, profile: light });
    fireEvent.click(await screen.findByRole('button', { name: 'White' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Ask the coach' }));
    expect(await screen.findByText('Start in the center.')).toBeInTheDocument();
    expect(coach.preMove).toHaveBeenLastCalledWith(expect.anything(), { force: true });
    expect(screen.queryByRole('button', { name: 'Ask the coach' })).not.toBeInTheDocument();
  });

  it('offers no "Ask the coach" button at full', async () => {
    await setup();
    fireEvent.click(await screen.findByRole('button', { name: 'White' }));
    await waitFor(() => expect(board.options?.allowDragging).toBe(true));
    expect(screen.queryByRole('button', { name: 'Ask the coach' })).not.toBeInTheDocument();
  });

  it('take back, then the hint ladder, then a retry that is judged again', async () => {
    const coach = fakeCoach();
    const mistake: CoachMessage = {
      id: 'm1', kind: 'mistake', source: 'template', arrows: [],
      explanation: { whatHappened: 'After e4, something bad happens.', better: 'The better move was d4.', lesson: 'Look first.' },
      verdict: { flagged: true, severity: 'blunder', cpLoss: 400, area: 'opening', theme: 'hanging_piece',
        recommendation: 'take_back', bestUci: 'd2d4', bestSan: 'd4', refutationSan: [] },
    };
    const ok = coach.onUserMove;
    coach.onUserMove = vi.fn(async (g, move) => (move.uci === 'e2e4' ? { verdict: mistake.verdict!, message: mistake } : ok(g, move)));
    coach.hint = vi.fn((step: 1 | 2 | 3) => `hint ${step}`);
    const { engine } = await setup(undefined, { coach });
    fireEvent.click(await screen.findByRole('button', { name: 'White' }));
    await waitFor(() => expect(board.options?.allowDragging).toBe(true));
    drop('e2', 'e4');
    fireEvent.click(await screen.findByRole('button', { name: 'Take it back' }));
    expect(fen()).toBe(START);
    expect(engine.stops).toBe(0); // nothing was searching: the engine worker is kept
    expect(coach.cancelPending).toHaveBeenCalled();
    expect(await screen.findByText('Try again. Find a better move.')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Hint 1' }));
    expect(await screen.findByText('hint 1')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Hint 2' }));
    expect(await screen.findByText('hint 2')).toBeInTheDocument();
    expect(board.options!.allowDragging).toBe(true);
    drop('d2', 'd4');
    await waitFor(() => expect(coach.onUserMove).toHaveBeenCalledTimes(2));
    expect(vi.mocked(coach.onUserMove).mock.calls[1][1].uci).toBe('d2d4');
    await waitFor(() => expect(engine.calls.some((c) => c.depth === 10)).toBe(true));
    expect(screen.queryByText('Try again. Find a better move.')).not.toBeInTheDocument();
  });

  it('resumes an unfinished saved game', async () => {
    await setup(undefined, {
      prepare: async (db) => {
        await db.saveGame({ id: 'g1', startedAt: 1, userColor: 'w', moves: ['e2e4', 'e7e5'], verdicts: [], result: null });
        await db.setCurrentGame('g1');
      },
    });
    await waitFor(() => expect(board.options?.allowDragging).toBe(true));
    expect(fen()).toBe('rnbqkbnr/pppp1ppp/8/4p3/4P3/8/PPPP1PPP/RNBQKBNR w KQkq - 0 2');
    expect(screen.queryByRole('button', { name: 'White' })).not.toBeInTheDocument();
    expect(screen.getByLabelText('Moves')).toHaveTextContent('1.e4 e5');
  });

  it('reports game-list changes at the start and end of a game only', async () => {
    const { onGameListChanged } = await setup();
    fireEvent.click(await screen.findByRole('button', { name: 'White' }));
    await waitFor(() => expect(onGameListChanged).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(board.options?.allowDragging).toBe(true));
    drop('e2', 'e4');
    await waitFor(() => expect(board.options?.allowDragging).toBe(true));
    expect(onGameListChanged).toHaveBeenCalledTimes(1);
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    fireEvent.click(screen.getByRole('button', { name: 'Resign' }));
    await waitFor(() => expect(onGameListChanged).toHaveBeenCalledTimes(2));
  });
});
