import 'fake-indexeddb/auto';
import '@testing-library/jest-dom/vitest';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, act, waitFor } from '@testing-library/react';
import type { ChessboardOptions } from 'react-chessboard';
import { GameScreen, boardDecorations } from '../../src/ui/GameScreen';
import { SUGGEST_LINES_OFF } from '../../src/profile/attackLines';
import { App } from '../../src/ui/App';
import { RESET_NOTICE } from '../../src/profile/profile';
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

vi.mock('../../src/engine/engine', () => ({
  createEngine: () => ({
    analyse: (fen: string) => Promise.resolve({ fen, depth: 1, lines: [] }), stop: () => {}, busy: () => false,
  }),
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

const okVerdict = (uci: string, san: string): Verdict => ({
  flagged: false, severity: 'ok', cpLoss: 0, area: 'opening', theme: 'other', recommendation: 'play_on',
  bestUci: uci, bestSan: san, refutationSan: [],
});

function fakeCoach(): CoachApi & { recap: ReturnType<typeof vi.fn> } {
  const ok = okVerdict;
  const recapMessage: CoachMessage = {
    id: 'recap', kind: 'recap', arrows: [], source: 'template',
    explanation: { whatHappened: 'No big mistakes this game.', better: 'Well played.', lesson: 'Keep checking.' },
  };
  return {
    onUpdate: vi.fn(),
    cancelPending: vi.fn(),
    preMove: vi.fn(async () => null),
    onUserMove: vi.fn(async (_g, move) => ({ verdict: ok(move.uci, move.san), message: null })),
    explainTopMove: vi.fn(async () => {}),
    hint: vi.fn(() => ''),
    hintStep: vi.fn(() => ({ text: '', highlight: [] as string[] })),
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

let preId = 0;
/** A pre-move message with questions and a nudge (a fresh id each time, like the real coach). */
const nudgeMessage = (): CoachMessage => ({
  id: `pre-${++preId}`, kind: 'pre_move', source: 'template', arrows: [{ from: 'e7', to: 'e5', color: 'blue' }],
  explanation: { whatHappened: '' }, theirMove: null,
  questions: ['What does their last move attack?', 'Which pieces have not moved yet?'],
  nudge: 'Look at your pawn on e2.',
});

/** A "stronger option" post_move with its green arrow. */
const strongerMessage = (v: Verdict): CoachMessage => ({
  id: `post-${v.bestUci}`, kind: 'post_move', source: 'template', verdict: v,
  arrows: [{ from: v.bestUci.slice(0, 2), to: v.bestUci.slice(2, 4), color: 'green' }],
  summary: 'Your move: e4. A stronger option was d4.', topKind: null, explained: true,
  explanation: { whatHappened: 'After e4, their best answer is e5.', better: 'd4 is better.' },
});

const ARROW_NAMES: Record<string, string> = { '#1f9d55': 'green', '#d9302c': 'red', '#2f6fd6': 'blue' };
const arrowColors = () => (board.options?.arrows ?? []).map((a) => ARROW_NAMES[a.color] ?? a.color);

/** The board's marked squares as "square:kind" (data-squares). */
const marks = () => (screen.getByTestId('board').closest('.board')!.getAttribute('data-squares') ?? '').split(' ').filter(Boolean);
const LINES_ON: Settings = { ...DEFAULT_SETTINGS, attackLines: true };

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

  it('a move played after "Need a nudge?" is assisted', async () => {
    const coach = fakeCoach();
    coach.preMove = vi.fn(async () => nudgeMessage());
    const { onProfile } = await setup(undefined, { coach });
    fireEvent.click(await screen.findByRole('button', { name: 'White' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Need a nudge?' }));
    expect(await screen.findByText('Look at your pawn on e2.')).toBeInTheDocument();
    drop('e2', 'e4');
    await waitFor(() => expect(onProfile).toHaveBeenCalled());
    expect(lastRecord(onProfile)).toMatchObject({ assisted: true, good: false });
  });

  it('a move played without the nudge is independent', async () => {
    const coach = fakeCoach();
    coach.preMove = vi.fn(async () => nudgeMessage());
    const { onProfile } = await setup(undefined, { coach });
    fireEvent.click(await screen.findByRole('button', { name: 'White' }));
    await screen.findByText('Think about');
    drop('e2', 'e4');
    await waitFor(() => expect(onProfile).toHaveBeenCalled());
    expect(lastRecord(onProfile)).toMatchObject({ good: true });
    expect(lastRecord(onProfile)?.assisted).toBeUndefined();
  });

  it('nudge, then a mistake, then a take-back and a retry from the same position: still assisted', async () => {
    const coach = fakeCoach();
    coach.preMove = vi.fn(async () => nudgeMessage());
    const verdict: Verdict = { flagged: true, severity: 'blunder', cpLoss: 400, area: 'opening', theme: 'hanging_piece',
      recommendation: 'take_back', bestUci: 'd2d4', bestSan: 'd4', refutationSan: [] };
    const mistake: CoachMessage = { id: 'm1', kind: 'mistake', source: 'template', arrows: [], verdict,
      explanation: { whatHappened: 'Bad.', better: 'The better move was d4.', lesson: 'Look first.' } };
    const ok = coach.onUserMove;
    coach.onUserMove = vi.fn(async (g, move) => (move.uci === 'e2e4' ? { verdict, message: mistake } : ok(g, move)));
    const { onProfile } = await setup(undefined, { coach });
    fireEvent.click(await screen.findByRole('button', { name: 'White' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Need a nudge?' }));
    drop('e2', 'e4');
    fireEvent.click(await screen.findByRole('button', { name: 'Take it back' }));
    onProfile.mockClear();
    drop('c2', 'c4');
    await waitFor(() => expect(onProfile).toHaveBeenCalled());
    expect(lastRecord(onProfile)?.assisted).toBe(true);
  });

  it('a new opponent move clears the nudge', async () => {
    const coach = fakeCoach();
    coach.preMove = vi.fn(async () => nudgeMessage());
    const { onProfile } = await setup(undefined, { coach });
    fireEvent.click(await screen.findByRole('button', { name: 'White' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Need a nudge?' }));
    drop('e2', 'e4');
    await waitFor(() => expect(fen()).toContain(' w '));
    expect(await screen.findByRole('button', { name: 'Need a nudge?' })).toBeInTheDocument();
    expect(screen.queryByText('Look at your pawn on e2.')).not.toBeInTheDocument();
    onProfile.mockClear();
    drop('d2', 'd4');
    await waitFor(() => expect(onProfile).toHaveBeenCalled());
    expect(lastRecord(onProfile)?.assisted).toBeUndefined();
  });

  it('at guided, the questions wait for "Show questions"', async () => {
    const guided: ProfileData = { ...defaultProfile(), levels: { opening: 'guided', middlegame: 'full', endgame: 'light' } };
    const coach = fakeCoach();
    coach.preMove = vi.fn(async () => nudgeMessage());
    await setup(undefined, { coach, profile: guided });
    fireEvent.click(await screen.findByRole('button', { name: 'White' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Show questions' }));
    expect(await screen.findByText('What does their last move attack?')).toBeInTheDocument();
  });

  it('the green "stronger option" arrow shows only until the opponent replies', async () => {
    const coach = fakeCoach();
    coach.preMove = vi.fn(async () => nudgeMessage());
    coach.onUserMove = vi.fn(async (_g, move) => {
      const v = { ...okVerdict(move.uci, move.san), bestUci: 'd2d4', bestSan: 'd4' };
      return { verdict: v, message: strongerMessage(v) };
    });
    const { engine } = await setup(undefined, { coach });
    fireEvent.click(await screen.findByRole('button', { name: 'White' }));
    await screen.findByText('Think about');
    engine.hold = true; // the opponent keeps thinking
    drop('e2', 'e4');
    expect(await screen.findByText('Your move: e4. A stronger option was d4.')).toBeInTheDocument();
    await waitFor(() => expect(arrowColors()).toContain('green'));
    fireEvent.click(screen.getByRole('button', { name: /Your last move/ }));
    expect(arrowColors()).not.toContain('green'); // collapsed: no arrow
    fireEvent.click(screen.getByRole('button', { name: /Your last move/ }));
    expect(arrowColors()).toContain('green');
    cleanup();

    await setup(undefined, { coach });
    fireEvent.click(await screen.findByRole('button', { name: 'White' }));
    await screen.findByText('Think about');
    drop('e2', 'e4');
    await waitFor(() => expect(fen()).toContain(' w '));
    await waitFor(() => expect(board.options?.allowDragging).toBe(true));
    // The opponent's reply collapses the "stronger option" feedback: during the user's next decision
    // it no longer names a move, and the board shows only the blue arrow.
    expect(screen.getByRole('button', { name: /Your last move/ })).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByText('Your move: e4. A stronger option was d4.')).not.toBeInTheDocument();
    expect(arrowColors()).not.toContain('green');
    expect(screen.getByTestId('board').closest('.board')).toHaveAttribute('data-arrows', 'blue');
    // Re-expanding it during the decision shows the text again, still without the green arrow.
    fireEvent.click(screen.getByRole('button', { name: /Your last move/ }));
    expect(screen.getByText('Your move: e4. A stronger option was d4.')).toBeInTheDocument();
    expect(arrowColors()).not.toContain('green');
  });

  describe('re-expanding a "stronger option" during the next decision', () => {
    async function playE4ThenWait() {
      const coach = fakeCoach();
      coach.onUserMove = vi.fn(async (_g, move) => {
        const v = { ...okVerdict(move.uci, move.san), bestUci: 'd2d4', bestSan: 'd4' };
        return { verdict: v, message: strongerMessage(v) };
      });
      const ctx = await setup(undefined, { coach });
      fireEvent.click(await screen.findByRole('button', { name: 'White' }));
      await waitFor(() => expect(board.options?.allowDragging).toBe(true));
      drop('e2', 'e4');
      await waitFor(() => expect(fen()).toContain(' w '));
      await waitFor(() => expect(board.options?.allowDragging).toBe(true));
      ctx.onProfile.mockClear();
      return ctx;
    }

    it('then playing the move it named is assisted', async () => {
      const { onProfile } = await playE4ThenWait();
      fireEvent.click(screen.getByRole('button', { name: /Your last move/ }));
      expect(screen.getByText('Your move: e4. A stronger option was d4.')).toBeInTheDocument();
      drop('d2', 'd4');
      await waitFor(() => expect(onProfile).toHaveBeenCalled());
      expect(lastRecord(onProfile)).toMatchObject({ assisted: true, good: false });
    });

    it('then playing another move is independent', async () => {
      const { onProfile } = await playE4ThenWait();
      fireEvent.click(screen.getByRole('button', { name: /Your last move/ }));
      drop('c2', 'c4');
      await waitFor(() => expect(onProfile).toHaveBeenCalled());
      expect(lastRecord(onProfile)?.assisted).toBeUndefined();
    });

    it('without re-expanding, the same move is independent', async () => {
      const { onProfile } = await playE4ThenWait();
      drop('d2', 'd4');
      await waitFor(() => expect(onProfile).toHaveBeenCalled());
      expect(lastRecord(onProfile)?.assisted).toBeUndefined();
    });
  });

  it('a top or book move\'s "Your last move" stays open after the opponent replies', async () => {
    const coach = fakeCoach();
    coach.onUserMove = vi.fn(async (_g, move) => ({
      verdict: okVerdict(move.uci, move.san),
      message: { id: 'post-1', kind: 'post_move' as const, source: 'template' as const, arrows: [], verdict: okVerdict(move.uci, move.san),
        summary: '✓ Book move. Do you see why?', topKind: 'book' as const, explained: false,
        explanation: { whatHappened: 'Book idea.' } },
    }));
    await setup(undefined, { coach });
    fireEvent.click(await screen.findByRole('button', { name: 'White' }));
    await waitFor(() => expect(board.options?.allowDragging).toBe(true));
    drop('e2', 'e4');
    await waitFor(() => expect(fen()).toContain(' w '));
    await waitFor(() => expect(board.options?.allowDragging).toBe(true));
    expect(screen.getByRole('button', { name: /Your last move/ })).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByRole('button', { name: 'Yes, I got it' })).toBeInTheDocument();
  });

  it('Explain on a top move asks the coach, and the upgrade fills "Your last move" only', async () => {
    const coach = fakeCoach();
    let listener: (m: CoachMessage) => void = () => {};
    coach.onUpdate = vi.fn((cb) => { listener = cb; });
    coach.preMove = vi.fn(async () => nudgeMessage());
    const top = (explained: boolean, text = 'e4 takes the centre.'): CoachMessage => ({
      id: 'post-1', kind: 'post_move', source: 'template', arrows: [], verdict: okVerdict('e2e4', 'e4'),
      summary: "✓ That's the top move. Do you see why it works?", topKind: 'top', explained,
      explanation: { whatHappened: text },
    });
    coach.onUserMove = vi.fn(async (_g, move) => ({ verdict: okVerdict(move.uci, move.san), message: top(false) }));
    coach.explainTopMove = vi.fn(async (id: string) => { listener({ ...top(true), id }); });
    await setup(undefined, { coach });
    fireEvent.click(await screen.findByRole('button', { name: 'White' }));
    await screen.findByText('Think about');
    drop('e2', 'e4');
    fireEvent.click(await screen.findByRole('button', { name: 'Explain it' }));
    expect(coach.explainTopMove).toHaveBeenCalledWith('post-1');
    expect(await screen.findByText('e4 takes the centre.')).toBeInTheDocument();
    act(() => listener({ ...top(true, 'Claude: e4 grabs the centre.'), source: 'claude' }));
    expect(await screen.findByText('Claude: e4 grabs the centre.')).toBeInTheDocument();
    expect(screen.getByText('Think about')).toBeInTheDocument(); // "Now" untouched
    fireEvent.click(screen.getByRole('button', { name: /Your last move/ }));
    expect(screen.queryByText('Claude: e4 grabs the centre.')).not.toBeInTheDocument();
  });

  it('"Yes, I got it" collapses the last-move section', async () => {
    const coach = fakeCoach();
    coach.onUserMove = vi.fn(async (_g, move) => ({
      verdict: okVerdict(move.uci, move.san),
      message: { id: 'post-1', kind: 'post_move' as const, source: 'template' as const, arrows: [], verdict: okVerdict(move.uci, move.san),
        summary: '✓ Book move. Do you see why?', topKind: 'book' as const, explained: false,
        explanation: { whatHappened: 'Book idea.' } },
    }));
    await setup(undefined, { coach });
    fireEvent.click(await screen.findByRole('button', { name: 'White' }));
    await waitFor(() => expect(board.options?.allowDragging).toBe(true));
    drop('e2', 'e4');
    fireEvent.click(await screen.findByRole('button', { name: 'Yes, I got it' }));
    expect(screen.getByRole('button', { name: /Your last move/ })).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByText('✓ Book move. Do you see why?')).not.toBeInTheDocument();
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
    expect(recap).not.toHaveTextContent(/avoiding mistakes|spotting threats/);
    expect(recap).not.toHaveTextContent(/clock/);
  });

  it('at light, "Ask the coach" asks for coaching on demand', async () => {
    const light: ProfileData = { ...defaultProfile(), levels: { opening: 'light', middlegame: 'light', endgame: 'light' } };
    const coach = fakeCoach();
    coach.preMove = vi.fn(async (_g, o?: { force?: boolean }) => (o?.force ? nudgeMessage() : null));
    await setup(undefined, { coach, profile: light });
    fireEvent.click(await screen.findByRole('button', { name: 'White' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Ask the coach' }));
    expect(await screen.findByText('What does their last move attack?')).toBeInTheDocument();
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
    coach.hintStep = vi.fn((step: 1 | 2) => ({ text: `hint ${step}`, highlight: step === 2 ? ['d2'] : [] }));
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
    expect(marks()).toEqual([]);
    fireEvent.click(screen.getByRole('button', { name: 'Hint 2' }));
    expect(await screen.findByText('hint 2')).toBeInTheDocument();
    expect(marks()).toEqual(['d2:ring']);
    expect(board.options!.allowDragging).toBe(true);
    drop('d2', 'd4');
    expect(marks()).toEqual([]); // the next move clears the ring
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

  it('after a take-back, replaying the better move the card showed counts as assisted at any hint count', async () => {
    for (const hintsTaken of [0, 2, 3]) {
      cleanup();
      const coach = fakeCoach();
      const verdict: Verdict = { flagged: true, severity: 'blunder', cpLoss: 400, area: 'opening', theme: 'hanging_piece',
        recommendation: 'take_back', bestUci: 'd2d4', bestSan: 'd4', refutationSan: [] };
      const mistake: CoachMessage = { id: 'm1', kind: 'mistake', source: 'template', arrows: [], verdict,
        explanation: { whatHappened: 'Bad.', better: 'The better move was d4.', lesson: 'Look first.' } };
      const ok = coach.onUserMove;
      coach.onUserMove = vi.fn(async (g, move) => (move.uci === 'e2e4' ? { verdict, message: mistake } : ok(g, move)));
      coach.hint = vi.fn((step: 1 | 2 | 3) => `hint ${step}`);
      coach.hintStep = vi.fn((step: 1 | 2) => ({ text: `hint ${step}`, highlight: [] }));
      const { onProfile } = await setup(undefined, { coach });
      fireEvent.click(await screen.findByRole('button', { name: 'White' }));
      await waitFor(() => expect(board.options?.allowDragging).toBe(true));
      drop('e2', 'e4');
      fireEvent.click(await screen.findByRole('button', { name: 'Take it back' }));
      for (let h = 1; h <= hintsTaken; h++) {
        fireEvent.click(await screen.findByRole('button', { name: `Hint ${h}` }));
        await screen.findByText(`hint ${h}`);
      }
      onProfile.mockClear();
      drop('d2', 'd4');
      await waitFor(() => expect(onProfile).toHaveBeenCalled());
      expect(lastRecord(onProfile)?.assisted).toBe(true);
    }
  });

  it('after a take-back, a different move found without Hint 3 is not assisted', async () => {
    const coach = fakeCoach();
    const verdict: Verdict = { flagged: true, severity: 'blunder', cpLoss: 400, area: 'opening', theme: 'hanging_piece',
      recommendation: 'take_back', bestUci: 'd2d4', bestSan: 'd4', refutationSan: [] };
    const mistake: CoachMessage = { id: 'm1', kind: 'mistake', source: 'template', arrows: [], verdict,
      explanation: { whatHappened: 'Bad.', better: 'The better move was d4.', lesson: 'Look first.' } };
    const ok = coach.onUserMove;
    coach.onUserMove = vi.fn(async (g, move) => (move.uci === 'e2e4' ? { verdict, message: mistake } : ok(g, move)));
    const { onProfile } = await setup(undefined, { coach });
    fireEvent.click(await screen.findByRole('button', { name: 'White' }));
    await waitFor(() => expect(board.options?.allowDragging).toBe(true));
    drop('e2', 'e4');
    fireEvent.click(await screen.findByRole('button', { name: 'Take it back' }));
    onProfile.mockClear();
    drop('c2', 'c4');
    await waitFor(() => expect(onProfile).toHaveBeenCalled());
    expect(lastRecord(onProfile)?.assisted).toBeUndefined();
  });
});

describe('boardDecorations', () => {
  const base = { userColor: 'w' as const, isUserTurn: true, viewing: false, watching: false, attackLines: false, rings: [] as string[] };
  const kinds = (fen: string, o: Partial<typeof base> = {}) => {
    const d = boardDecorations({ ...base, ...o, fen });
    return { marks: d.marks, arrows: d.arrows, styles: d.squareStyles };
  };

  it('gives a checked king a red square on either side, live or not', () => {
    const whiteInCheck = 'k7/8/8/8/8/8/8/K6r w - - 0 1';
    const blackInCheck = 'k6R/8/8/8/8/8/8/K7 b - - 0 1';
    expect(kinds(whiteInCheck).marks).toEqual(['a1:check']);
    expect(kinds(blackInCheck, { isUserTurn: false }).marks).toEqual(['a8:check']);
    expect(kinds(blackInCheck, { viewing: true }).marks).toEqual(['a8:check']);
    expect(kinds(blackInCheck, { watching: true }).marks).toEqual(['a8:check']);
    expect(kinds(whiteInCheck).styles.a1?.backgroundColor).toMatch(/rgba\(217, ?48, ?44/);
    expect(kinds(START).marks).toEqual([]);
  });

  it('rings squares only outside history view and the watch player', () => {
    expect(kinds(START, { rings: ['f6'] }).marks).toEqual(['f6:ring']);
    expect(kinds(START, { rings: ['f6'] }).styles.f6?.boxShadow).toMatch(/inset/);
    expect(kinds(START, { rings: ['f6'], viewing: true }).marks).toEqual([]);
    expect(kinds(START, { rings: ['f6'], watching: true }).marks).toEqual([]);
  });

  it('draws attack lines in red only on the user\'s live turn', () => {
    const fenE4D5 = 'rnbqkbnr/ppp1pppp/8/3p4/4P3/8/PPPP1PPP/RNBQKBNR w KQkq - 0 2';
    const on = kinds(fenE4D5, { attackLines: true });
    expect(on.arrows).toEqual([{ startSquare: 'd5', endSquare: 'e4', color: '#d9302c' }]);
    expect(on.marks).toContain('e4:attacked');
    expect(on.marks).toContain('c4:attacked');
    expect(on.marks).not.toContain('d4:attacked'); // pawn pushes do not attack
    expect(on.styles.c4?.backgroundImage).toMatch(/rgba\(217, ?48, ?44, ?0\.\d+\)/);
    for (const o of [{ isUserTurn: false }, { viewing: true }, { watching: true }, { attackLines: false }]) {
      const off = kinds(fenE4D5, { attackLines: true, ...o });
      expect(off.arrows).toEqual([]);
      expect(off.marks.some((m) => m.endsWith(':attacked'))).toBe(false);
    }
  });
});

describe('GameScreen board decorations', () => {
  it('marks the checked king on the user\'s turn and on the opponent\'s', async () => {
    await setup('k7/8/8/8/8/8/8/K6r w - - 0 1');
    fireEvent.click(await screen.findByRole('button', { name: 'White' }));
    await waitFor(() => expect(board.options?.allowDragging).toBe(true));
    expect(marks()).toContain('a1:check');
    cleanup();

    const { engine } = await setup('k7/8/8/8/8/8/8/K6R w - - 0 1');
    fireEvent.click(await screen.findByRole('button', { name: 'White' }));
    await waitFor(() => expect(board.options?.allowDragging).toBe(true));
    engine.hold = true;
    drop('h1', 'h8');
    await waitFor(() => expect(engine.calls.some((c) => c.depth === 10)).toBe(true));
    expect(marks()).toContain('a8:check');
  });

  it('rings the nudge\'s square once the nudge is revealed', async () => {
    const coach = fakeCoach();
    coach.preMove = vi.fn(async () => ({ ...nudgeMessage(), nudge: 'Look at your knight on f6.', nudgeHighlight: ['f6'] }));
    await setup('rnbqkb1r/pppppppp/5n2/8/8/8/PPPPPPPP/RNBQKBNR b KQkq - 1 1', { coach });
    fireEvent.click(await screen.findByRole('button', { name: 'Black' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Need a nudge?' }));
    await screen.findByText('Look at your knight on f6.');
    expect(marks()).toEqual(['f6:ring']);
  });

  it('shows no ring before the nudge is revealed', async () => {
    const coach = fakeCoach();
    coach.preMove = vi.fn(async () => ({ ...nudgeMessage(), nudgeHighlight: ['e2'] }));
    await setup(undefined, { coach });
    fireEvent.click(await screen.findByRole('button', { name: 'White' }));
    await screen.findByRole('button', { name: 'Need a nudge?' });
    expect(marks()).toEqual([]);
  });

  it('shows attack lines during the user\'s turn only', async () => {
    const { engine } = await setup('rnbqkbnr/ppp1pppp/8/3p4/4P3/8/PPPP1PPP/RNBQKBNR w KQkq - 0 2', { settings: LINES_ON });
    fireEvent.click(await screen.findByRole('button', { name: 'White' }));
    await waitFor(() => expect(board.options?.allowDragging).toBe(true));
    expect(arrowColors()).toEqual(['red']);
    expect(screen.getByTestId('board').closest('.board')).toHaveAttribute('data-arrows', 'red');
    expect(marks()).toContain('e4:attacked');
    engine.hold = true;
    drop('a2', 'a3');
    await waitFor(() => expect(engine.calls.some((c) => c.depth === 10)).toBe(true));
    expect(arrowColors()).toEqual([]);
    expect(marks().some((m) => m.endsWith(':attacked'))).toBe(false);
  });

  it('a move played with attack lines on is assisted and counted in the saved game', async () => {
    const { db, onProfile } = await setup(undefined, { settings: LINES_ON });
    fireEvent.click(await screen.findByRole('button', { name: 'White' }));
    await waitFor(() => expect(board.options?.allowDragging).toBe(true));
    drop('e2', 'e4');
    await waitFor(() => expect(onProfile).toHaveBeenCalled());
    expect(lastRecord(onProfile)?.assisted).toBe(true);
    await waitFor(async () => {
      const g = await db.getGame((await db.currentGameId())!);
      expect(g).toMatchObject({ attackLinesMoves: 1, userMoves: 1 });
    });
  });

  it('counts user moves without attack lines too', async () => {
    const { db, onProfile } = await setup();
    fireEvent.click(await screen.findByRole('button', { name: 'White' }));
    await waitFor(() => expect(board.options?.allowDragging).toBe(true));
    drop('e2', 'e4');
    await waitFor(() => expect(onProfile).toHaveBeenCalled());
    expect(lastRecord(onProfile)?.assisted).toBeUndefined();
    await waitFor(async () => {
      const g = await db.getGame((await db.currentGameId())!);
      expect(g).toMatchObject({ attackLinesMoves: 0, userMoves: 1 });
    });
  });

  it('suggests turning attack lines off after 3 qualifying games, until dismissed', async () => {
    await setup('r1bqkb1r/pppp1ppp/2n2n2/4p2Q/2B1P3/8/PPPP1PPP/RNB1K1NR w KQkq - 4 4', {
      settings: LINES_ON,
      prepare: async (db) => {
        for (let i = 1; i <= 3; i++) {
          await db.saveGame({ id: `g${i}`, startedAt: i, userColor: 'w', moves: [], verdicts: [],
            result: { winner: 'w', reason: 'checkmate' }, userMoves: 12, attackLinesMoves: 12 });
        }
      },
    });
    fireEvent.click(await screen.findByRole('button', { name: 'White' }));
    await waitFor(() => expect(board.options?.allowDragging).toBe(true));
    drop('h5', 'f7');
    expect(await screen.findByText(SUGGEST_LINES_OFF)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }));
    expect(screen.queryByText(SUGGEST_LINES_OFF)).not.toBeInTheDocument();
  });

  it('does not suggest it with fewer qualifying games', async () => {
    await setup('r1bqkb1r/pppp1ppp/2n2n2/4p2Q/2B1P3/8/PPPP1PPP/RNB1K1NR w KQkq - 4 4', { settings: LINES_ON });
    fireEvent.click(await screen.findByRole('button', { name: 'White' }));
    await waitFor(() => expect(board.options?.allowDragging).toBe(true));
    drop('h5', 'f7');
    const recap = await screen.findByRole('region', { name: /game over/i });
    await waitFor(() => expect(recap).toHaveTextContent('No big mistakes this game.'));
    expect(screen.queryByText(SUGGEST_LINES_OFF)).not.toBeInTheDocument();
  });
});

describe('App', () => {
  it('resets a v1 profile once, shows the notice until dismissed, and not again after a reload', async () => {
    const db = await openDb();
    const { version: _v, ...v1 } = defaultProfile();
    await db.saveProfile({ ...v1, levels: { opening: 'solo', middlegame: 'light', endgame: 'solo' }, levelChangedAt: { opening: 3 } });

    render(<App />);
    expect(await screen.findByText(RESET_NOTICE)).toBeInTheDocument();
    await waitFor(async () => expect((await db.getProfile()).version).toBe(2));
    const saved = await db.getProfile();
    expect(saved.levels).toEqual({ opening: 'full', middlegame: 'full', endgame: 'light' });
    expect(saved.levelChangedAt).toBeUndefined();
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }));
    expect(screen.queryByText(RESET_NOTICE)).not.toBeInTheDocument();
    cleanup();

    render(<App />); // a reload: the saved profile is already v2
    await screen.findByRole('button', { name: 'White' });
    expect(screen.queryByText(RESET_NOTICE)).not.toBeInTheDocument();
  });
});
