import 'fake-indexeddb/auto';
import '@testing-library/jest-dom/vitest';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, act, waitFor, within } from '@testing-library/react';
import type { ChessboardOptions } from 'react-chessboard';
import { Chess } from 'chess.js';
import type { WatchPly } from '../../src/coach/watch';
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
  /** Searches never answer while held (until release()). */
  hold = false;
  stops = 0;
  /** The opponent's only candidate move by FEN (its depth-10 search answers with just this line). */
  replies = new Map<string, string>();
  private held: (() => void)[] = [];
  analyse(fen: string, opts: { multipv: number; depth: number }): Promise<Analysis> {
    this.calls.push({ fen, depth: opts.depth });
    const reply = opts.depth === 10 ? this.replies.get(fen) : undefined;
    const answer = (): Analysis => ({ fen, depth: opts.depth, lines: reply ? [{ uci: [reply], cp: 0, mate: null }] : [] });
    if (this.hold) return new Promise((resolve) => { this.held.push(() => resolve(answer())); });
    return Promise.resolve(answer());
  }
  /** Answers the held searches and stops holding. */
  release(): void { this.hold = false; const held = this.held; this.held = []; for (const r of held) r(); }
  stop(): void { this.stops++; this.held = []; }
  busy(): boolean { return this.held.length > 0; }
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
    hintStep: vi.fn(() => ({ text: '', highlight: [] as string[] })),
    showMe: vi.fn(() => null),
    playOnReveal: vi.fn(() => null),
    playOn: vi.fn(),
    checkConsequence: vi.fn(() => null),
    recap: vi.fn(() => recapMessage),
    setMode: vi.fn(),
    teachTurn: vi.fn(async () => null),
    openOptions: vi.fn(() => null),
    teachRecap: vi.fn(() => recapMessage),
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
  const screenWith = (settings: Settings) => (
    <GameScreen
      db={db} engine={engine} coach={coach} profile={o.profile ?? defaultProfile()} settings={settings}
      onProfile={onProfile} onSettings={() => {}} onGameListChanged={onGameListChanged}
      rng={() => 0.5} startFen={startFen} coachOffline={false}
    />
  );
  const { rerender } = render(screenWith(o.settings ?? DEFAULT_SETTINGS));
  return { db, engine, coach, onProfile, onGameListChanged, setSettings: (s: Settings) => rerender(screenWith(s)) };
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

const blunder = (bestUci = 'd2d4', bestSan = 'd4'): Verdict => ({
  flagged: true, severity: 'blunder', cpLoss: 400, area: 'opening', theme: 'hanging_piece',
  recommendation: 'take_back', bestUci, bestSan, refutationSan: [],
});
const mistakeMessage = (watch?: WatchPly[]): CoachMessage => ({
  id: 'm1', kind: 'mistake', source: 'template', arrows: [{ from: 'e7', to: 'e5', color: 'red' }], verdict: blunder(),
  explanation: { whatHappened: 'After that, something bad happens.', lesson: 'Look first.' }, ...(watch ? { watch } : {}),
});
const revealMessage = (): CoachMessage => ({
  id: 'reveal-1', kind: 'post_move', source: 'template', verdict: blunder(), topKind: null, explained: true, reveal: true,
  summary: 'The better move was d4.', arrows: [{ from: 'd2', to: 'd4', color: 'green' }],
  explanation: { whatHappened: 'd4 takes the centre.' },
});
/** A coach that flags `bad` (uci) as a blunder, with a Show me / Play on reveal and the hint ladder. */
function mistakeCoach(bad: string, watch?: WatchPly[]) {
  const coach = fakeCoach();
  const ok = coach.onUserMove;
  coach.onUserMove = vi.fn(async (g, move) => (move.uci === bad ? { verdict: blunder(), message: mistakeMessage(watch) } : ok(g, move)));
  coach.hintStep = vi.fn((step: 1 | 2) => ({ text: `hint ${step}`, highlight: step === 2 ? ['d2'] : [] }));
  coach.showMe = vi.fn(() => revealMessage());
  coach.playOnReveal = vi.fn(() => revealMessage());
  return coach;
}
/** The watch plies for `line` played from `fen` (opponent first). */
function plies(fen: string, line: string[]): WatchPly[] {
  const c = new Chess(fen);
  return line.map((uci, i) => {
    const san = c.move({ from: uci.slice(0, 2), to: uci.slice(2, 4) }).san;
    return { uci, san, fen: c.fen(), by: i % 2 === 0 ? 'opponent' : 'user' };
  });
}
const fenAfter = (fen: string, line: string[]) => { const c = new Chess(fen); for (const u of line) c.move({ from: u.slice(0, 2), to: u.slice(2, 4) }); return c.fen(); };
const savedGame = async (db: Db) => db.getGame((await db.currentGameId())!);
const boardEl = () => screen.getByTestId('board').closest('.board')!;

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
      explanation: { whatHappened: 'Bad.', lesson: 'Look first.' } };
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
      explanation: { whatHappened: 'After e4, something bad happens.', lesson: 'Look first.' },
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

  it('after a take-back, replaying the better move without Show me is not assisted, at any hint count', async () => {
    for (const hintsTaken of [0, 1, 2]) {
      cleanup();
      const coach = mistakeCoach('e2e4');
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
      expect(lastRecord(onProfile)?.assisted).toBeUndefined();
    }
  });

  it('after a take-back, a different move found on one\'s own is not assisted', async () => {
    const coach = mistakeCoach('e2e4');
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

describe('GameScreen mistake flow', () => {
  async function blunderE4(o: SetupOpts = {}) {
    const coach = o.coach ?? mistakeCoach('e2e4');
    const ctx = await setup(undefined, { ...o, coach });
    fireEvent.click(await screen.findByRole('button', { name: 'White' }));
    await waitFor(() => expect(board.options?.allowDragging).toBe(true));
    drop('e2', 'e4');
    await screen.findByRole('alertdialog');
    return { ...ctx, coach };
  }

  it('the card names no better move and shows no green arrow', async () => {
    await blunderE4();
    const card = screen.getByRole('alertdialog');
    expect(card).toHaveTextContent('✗ Blunder');
    expect(card).not.toHaveTextContent(/better move|\bd4\b/i);
    expect(arrowColors()).toEqual(['red']);
  });

  it('Take it back offers Hint 1, Hint 2 and Show me; Show me reveals the move and the next move is assisted', async () => {
    const { coach, onProfile } = await blunderE4();
    fireEvent.click(screen.getByRole('button', { name: 'Take it back' }));
    expect(await screen.findByRole('button', { name: 'Hint 1' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Hint 2' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Show me' })).toBeEnabled();
    expect(screen.queryByRole('button', { name: 'Hint 3' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Hint 1' }));
    fireEvent.click(screen.getByRole('button', { name: 'Hint 2' }));
    expect(marks()).toEqual(['d2:ring']);
    expect(arrowColors()).not.toContain('green');
    fireEvent.click(screen.getByRole('button', { name: 'Show me' }));
    expect(await screen.findByText('The better move was d4.')).toBeInTheDocument();
    expect(screen.getByText('d4 takes the centre.')).toBeInTheDocument();
    expect(marks()).toEqual([]); // the reveal's arrow replaces the Hint 2 ring
    expect(arrowColors()).toEqual(['green']);
    expect(screen.getByRole('button', { name: 'Show me' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Show me' }));
    expect(coach.showMe).toHaveBeenCalledTimes(1);
    onProfile.mockClear();
    drop('d2', 'd4');
    await waitFor(() => expect(onProfile).toHaveBeenCalled());
    expect(lastRecord(onProfile)).toMatchObject({ assisted: true });
  });

  it('Show me, then another move from that position: still assisted', async () => {
    const { onProfile } = await blunderE4();
    fireEvent.click(screen.getByRole('button', { name: 'Take it back' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Show me' }));
    onProfile.mockClear();
    drop('c2', 'c4');
    await waitFor(() => expect(onProfile).toHaveBeenCalled());
    expect(lastRecord(onProfile)?.assisted).toBe(true);
  });

  it('Play on shows the reveal expanded in "Your last move", with its green arrow until the opponent replies', async () => {
    const coach = mistakeCoach('e2e4');
    const { engine } = await setup(undefined, { coach });
    fireEvent.click(await screen.findByRole('button', { name: 'White' }));
    await waitFor(() => expect(board.options?.allowDragging).toBe(true));
    drop('e2', 'e4');
    await screen.findByRole('alertdialog');
    engine.hold = true;
    fireEvent.click(screen.getByRole('button', { name: 'Play on' }));
    expect(coach.playOn).toHaveBeenCalledTimes(1);
    expect(coach.playOnReveal).toHaveBeenCalledTimes(1);
    expect(await screen.findByText('The better move was d4.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Your last move/ })).toHaveAttribute('aria-expanded', 'true');
    expect(arrowColors()).toContain('green');
    act(() => engine.release());
    await waitFor(() => expect(fen()).toContain(' w '));
    expect(screen.getByRole('button', { name: /Your last move/ })).toHaveAttribute('aria-expanded', 'false');
    expect(arrowColors()).not.toContain('green');
  });

  it('Play on, the reply, then re-expanding the reveal: playing the move it names is assisted', async () => {
    const { onProfile } = await blunderE4();
    fireEvent.click(screen.getByRole('button', { name: 'Play on' }));
    await waitFor(() => expect(fen()).toContain(' w '));
    await waitFor(() => expect(board.options?.allowDragging).toBe(true));
    expect(screen.getByRole('button', { name: /Your last move/ })).toHaveAttribute('aria-expanded', 'false');
    fireEvent.click(screen.getByRole('button', { name: /Your last move/ }));
    expect(screen.getByText('The better move was d4.')).toBeInTheDocument();
    onProfile.mockClear();
    drop('d2', 'd4');
    await waitFor(() => expect(onProfile).toHaveBeenCalled());
    expect(lastRecord(onProfile)?.assisted).toBe(true);
  });

  it('take-back takes the move off the saved counts, lines included', async () => {
    const { db } = await blunderE4({ settings: LINES_ON });
    await waitFor(async () => expect(await savedGame(db)).toMatchObject({ userMoves: 1, attackLinesMoves: 1 }));
    fireEvent.click(screen.getByRole('button', { name: 'Take it back' }));
    await waitFor(async () => expect(await savedGame(db)).toMatchObject({ userMoves: 0, attackLinesMoves: 0 }));
    drop('d2', 'd4');
    await waitFor(async () => expect(await savedGame(db)).toMatchObject({ userMoves: 1, attackLinesMoves: 1 }));
  });

  describe('watch what happens', () => {
    // 1.a3 (flagged); the watched line: ...h6 2.b3 g6 3.c3.
    const AFTER_A3 = fenAfter(START, ['a2a3']);
    const LINE = ['h7h6', 'b2b3', 'g7g6', 'c2c3'];
    const WATCH = plies(AFTER_A3, LINE);

    async function blunderA3() {
      const coach = mistakeCoach('a2a3', WATCH);
      const ctx = await setup(undefined, { coach });
      ctx.engine.replies.set(AFTER_A3, 'h7h6');
      ctx.engine.replies.set(fenAfter(START, ['a2a3', 'h7h6', 'b2b3']), 'g7g6');
      fireEvent.click(await screen.findByRole('button', { name: 'White' }));
      await waitFor(() => expect(board.options?.allowDragging).toBe(true));
      drop('a2', 'a3');
      await screen.findByRole('alertdialog');
      return { ...ctx, coach };
    }

    it('steps through the line on a read-only board and goes back to the card', async () => {
      await blunderA3();
      fireEvent.click(screen.getByRole('button', { name: '▶ Watch what happens' }));
      expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
      expect(fen()).toBe(WATCH[0].fen);
      expect(board.options!.allowDragging).toBe(false);
      expect(board.options!.arrows).toEqual([{ startSquare: 'h7', endSquare: 'h6', color: '#d9302c' }]);
      fireEvent.click(screen.getByRole('button', { name: 'Next move in line' }));
      expect(fen()).toBe(WATCH[1].fen);
      expect(board.options!.arrows).toHaveLength(1);
      expect(board.options!.arrows![0]).toMatchObject({ startSquare: 'b2', endSquare: 'b3' });
      fireEvent.click(screen.getByRole('button', { name: 'Previous move in line' }));
      expect(fen()).toBe(WATCH[0].fen);
      fireEvent.click(screen.getByRole('button', { name: 'Back to the card' }));
      expect(fen()).toBe(AFTER_A3);
      expect(screen.getByRole('alertdialog')).toBeInTheDocument();
    });

    it('watched, then Play on: the line\'s user moves are assisted while the game follows it', async () => {
      const { onProfile } = await blunderA3();
      fireEvent.click(screen.getByRole('button', { name: '▶ Watch what happens' }));
      fireEvent.click(screen.getByRole('button', { name: 'Back to the card' }));
      fireEvent.click(screen.getByRole('button', { name: 'Play on' }));
      await waitFor(() => expect(fen()).toBe(WATCH[0].fen));
      await waitFor(() => expect(board.options?.allowDragging).toBe(true));
      onProfile.mockClear();
      drop('b2', 'b3');
      await waitFor(() => expect(onProfile).toHaveBeenCalled());
      expect(lastRecord(onProfile)?.assisted).toBe(true);
      await waitFor(() => expect(fen()).toBe(WATCH[2].fen));
      await waitFor(() => expect(board.options?.allowDragging).toBe(true));
      onProfile.mockClear();
      drop('c2', 'c3');
      await waitFor(() => expect(onProfile).toHaveBeenCalled());
      expect(lastRecord(onProfile)?.assisted).toBe(true);
    });

    it('not watched, then Play on: the same moves are independent', async () => {
      const { onProfile } = await blunderA3();
      fireEvent.click(screen.getByRole('button', { name: 'Play on' }));
      await waitFor(() => expect(fen()).toBe(WATCH[0].fen));
      await waitFor(() => expect(board.options?.allowDragging).toBe(true));
      onProfile.mockClear();
      drop('b2', 'b3');
      await waitFor(() => expect(onProfile).toHaveBeenCalled());
      expect(lastRecord(onProfile)?.assisted).toBeUndefined();
    });

    it('watched, then Take it back: a retry that plays one of the line\'s user moves is assisted', async () => {
      const { onProfile } = await blunderA3();
      fireEvent.click(screen.getByRole('button', { name: '▶ Watch what happens' }));
      fireEvent.click(screen.getByRole('button', { name: 'Back to the card' }));
      fireEvent.click(screen.getByRole('button', { name: 'Take it back' }));
      await waitFor(() => expect(fen()).toBe(START));
      await waitFor(() => expect(board.options?.allowDragging).toBe(true));
      onProfile.mockClear();
      drop('c2', 'c3'); // the line's second user move, played from the retry position
      await waitFor(() => expect(onProfile).toHaveBeenCalled());
      expect(lastRecord(onProfile)?.assisted).toBe(true);
    });

    it('not watched, then Take it back: the same retry is independent', async () => {
      const { onProfile } = await blunderA3();
      fireEvent.click(screen.getByRole('button', { name: 'Take it back' }));
      await waitFor(() => expect(fen()).toBe(START));
      await waitFor(() => expect(board.options?.allowDragging).toBe(true));
      onProfile.mockClear();
      drop('c2', 'c3');
      await waitFor(() => expect(onProfile).toHaveBeenCalled());
      expect(lastRecord(onProfile)?.assisted).toBeUndefined();
    });

    it('after the game leaves the line once, a later move from the old line is independent', async () => {
      const { onProfile } = await blunderA3();
      fireEvent.click(screen.getByRole('button', { name: '▶ Watch what happens' }));
      fireEvent.click(screen.getByRole('button', { name: 'Back to the card' }));
      fireEvent.click(screen.getByRole('button', { name: 'Play on' }));
      await waitFor(() => expect(fen()).toBe(WATCH[0].fen));
      await waitFor(() => expect(board.options?.allowDragging).toBe(true));
      onProfile.mockClear();
      drop('d2', 'd3'); // leaves the line
      await waitFor(() => expect(onProfile).toHaveBeenCalled());
      expect(lastRecord(onProfile)?.assisted).toBeUndefined();
      await waitFor(() => expect(fen()).toContain(' w '));
      await waitFor(() => expect(board.options?.allowDragging).toBe(true));
      onProfile.mockClear();
      drop('b2', 'b3'); // the old line's user move
      await waitFor(() => expect(onProfile).toHaveBeenCalled());
      expect(lastRecord(onProfile)?.assisted).toBeUndefined();
    });
  });
});

describe('GameScreen history', () => {
  it('viewing a past move during the user\'s turn is read-only and shows nothing from the live position', async () => {
    const coach = mistakeCoach('e2e4');
    const { engine, onProfile } = await setup(undefined, { coach, settings: LINES_ON });
    engine.replies.set(fenAfter(START, ['a2a3']), 'h7h6');
    fireEvent.click(await screen.findByRole('button', { name: 'White' }));
    await waitFor(() => expect(board.options?.allowDragging).toBe(true));
    drop('a2', 'a3');
    await waitFor(() => expect(fen()).toBe(fenAfter(START, ['a2a3', 'h7h6'])));
    await waitFor(() => expect(board.options?.allowDragging).toBe(true));
    drop('e2', 'e4');
    fireEvent.click(await screen.findByRole('button', { name: 'Take it back' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Hint 1' }));
    fireEvent.click(screen.getByRole('button', { name: 'Hint 2' }));
    const live = fen();
    const recorded = onProfile.mock.calls.length;
    expect(marks()).toContain('d2:ring');
    expect(marks().some((m) => m.endsWith(':attacked'))).toBe(false); // attack lines never tint squares
    const view = async () => {
      fireEvent.click(within(screen.getByLabelText('Moves')).getByRole('button', { name: 'a3' }));
      expect(fen()).toBe(fenAfter(START, ['a2a3']));
      expect(board.options!.allowDragging).toBe(false);
      expect(boardEl().getAttribute('data-arrows')).not.toMatch(/green/);
      expect(boardEl().getAttribute('data-arrows')).toBe('');
      expect(marks().filter((m) => m.endsWith(':ring') || m.endsWith(':attacked'))).toEqual([]);
      expect(screen.getByText('Viewing move 1 (White)')).toBeInTheDocument();
      expect(screen.queryByText('Try again. Find a better move.')).not.toBeInTheDocument(); // coach panel hidden
      expect(drop('b2', 'b3')).toBe(false);
    };
    await view();
    fireEvent.click(screen.getByRole('button', { name: 'Back to game' }));
    expect(fen()).toBe(live);
    expect(board.options!.allowDragging).toBe(true);
    expect(marks()).toContain('d2:ring');

    fireEvent.click(screen.getByRole('button', { name: 'Show me' }));
    expect(arrowColors()).toContain('green');
    await view();
    fireEvent.click(screen.getByRole('button', { name: 'Back to game' }));
    expect(fen()).toBe(live);
    expect(arrowColors()).toContain('green');
    expect(onProfile).toHaveBeenCalledTimes(recorded); // viewing recorded nothing
  });

  it('a revealed nudge\'s ring does not show while viewing', async () => {
    const coach = fakeCoach();
    coach.preMove = vi.fn(async () => ({ ...nudgeMessage(), nudgeHighlight: ['e2'] }));
    const { engine } = await setup(undefined, { coach });
    engine.replies.set(fenAfter(START, ['a2a3']), 'h7h6');
    fireEvent.click(await screen.findByRole('button', { name: 'White' }));
    await waitFor(() => expect(board.options?.allowDragging).toBe(true));
    drop('a2', 'a3');
    await waitFor(() => expect(fen()).toBe(fenAfter(START, ['a2a3', 'h7h6'])));
    fireEvent.click(await screen.findByRole('button', { name: 'Need a nudge?' }));
    await waitFor(() => expect(marks()).toEqual(['e2:ring']));
    fireEvent.click(within(screen.getByLabelText('Moves')).getByRole('button', { name: 'a3' }));
    expect(marks()).toEqual([]);
    expect(screen.getByRole('status')).toHaveTextContent('Viewing move 1 (White) of 1.');
    fireEvent.click(screen.getByRole('button', { name: 'Back to game' }));
    expect(marks()).toEqual(['e2:ring']);
    expect(screen.getByRole('status')).toHaveTextContent('Your move.');
  });

  it('◀ ▶ step through the moves; the last step returns to the live game', async () => {
    const { engine } = await setup();
    engine.replies.set(fenAfter(START, ['a2a3']), 'h7h6');
    fireEvent.click(await screen.findByRole('button', { name: 'White' }));
    await waitFor(() => expect(board.options?.allowDragging).toBe(true));
    drop('a2', 'a3');
    await waitFor(() => expect(fen()).toBe(fenAfter(START, ['a2a3', 'h7h6'])));
    const history = screen.getByRole('group', { name: 'History' });
    expect(within(history).getByRole('button', { name: 'Next move' })).toBeDisabled();
    fireEvent.click(within(history).getByRole('button', { name: 'Previous move' }));
    expect(fen()).toBe(fenAfter(START, ['a2a3']));
    expect(screen.getByText('Viewing move 1 (White)')).toBeInTheDocument();
    // One more step back shows the starting position.
    fireEvent.click(within(history).getByRole('button', { name: 'Previous move' }));
    expect(fen()).toBe(START);
    expect(screen.getByText('Viewing the start')).toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent('Viewing the start.');
    expect(within(history).getByRole('button', { name: 'Previous move' })).toBeDisabled();
    fireEvent.click(within(history).getByRole('button', { name: 'Next move' }));
    expect(screen.getByText('Viewing move 1 (White)')).toBeInTheDocument();
    fireEvent.click(within(history).getByRole('button', { name: 'Next move' }));
    expect(fen()).toBe(fenAfter(START, ['a2a3', 'h7h6']));
    expect(screen.queryByText(/Viewing move/)).not.toBeInTheDocument();
    expect(board.options!.allowDragging).toBe(true);
  });

  it('an opponent move while viewing keeps the view and shows "New move — Back to game"', async () => {
    const { engine } = await setup();
    engine.replies.set(fenAfter(START, ['a2a3']), 'h7h6');
    engine.replies.set(fenAfter(START, ['a2a3', 'h7h6', 'b2b3']), 'g7g6');
    fireEvent.click(await screen.findByRole('button', { name: 'White' }));
    await waitFor(() => expect(board.options?.allowDragging).toBe(true));
    drop('a2', 'a3');
    await waitFor(() => expect(fen()).toBe(fenAfter(START, ['a2a3', 'h7h6'])));
    await waitFor(() => expect(board.options?.allowDragging).toBe(true));
    engine.hold = true;
    drop('b2', 'b3');
    await waitFor(() => expect(engine.calls.filter((c) => c.depth === 10)).toHaveLength(2));
    fireEvent.click(within(screen.getByLabelText('Moves')).getByRole('button', { name: 'a3' }));
    expect(screen.getByRole('button', { name: 'Back to game' })).toBeInTheDocument();
    act(() => engine.release());
    expect(await screen.findByRole('button', { name: 'New move — Back to game' })).toBeInTheDocument();
    expect(fen()).toBe(fenAfter(START, ['a2a3']));
    fireEvent.click(screen.getByRole('button', { name: 'New move — Back to game' }));
    expect(fen()).toBe(fenAfter(START, ['a2a3', 'h7h6', 'b2b3', 'g7g6']));
    await waitFor(() => expect(board.options?.allowDragging).toBe(true));
    // Labels give the full-move number and the side that moved.
    fireEvent.click(within(screen.getByLabelText('Moves')).getByRole('button', { name: 'h6' }));
    expect(screen.getByText('Viewing move 1 (Black)')).toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent('Viewing move 1 (Black) of 2.');
    fireEvent.click(within(screen.getByLabelText('Moves')).getByRole('button', { name: 'b3' }));
    expect(screen.getByText('Viewing move 2 (White)')).toBeInTheDocument();
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
    // Only arrows to the user's attacked pieces: no tint on attacked squares.
    expect(on.marks.some((m) => m.endsWith(':attacked'))).toBe(false);
    expect(on.styles.c4).toBeUndefined();
    expect(on.styles.e4).toBeUndefined();
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
    expect(marks()).toEqual([]); // arrows only, no tinted squares
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

  // A resumed game one move from mate (scholar's mate), after two earlier qualifying games.
  const SCHOLAR = ['e2e4', 'e7e5', 'f1c4', 'b8c6', 'd1h5', 'g8f6'];
  const twoGamesAndOneToFinish = async (db: Db) => {
    for (let i = 1; i <= 2; i++) {
      await db.saveGame({ id: `g${i}`, startedAt: i, userColor: 'w', moves: [], verdicts: [],
        result: { winner: 'w', reason: 'checkmate' }, userMoves: 12, attackLinesMoves: 12 });
    }
    await db.saveGame({ id: 'g3', startedAt: 3, userColor: 'w', moves: SCHOLAR, verdicts: [], result: null,
      userMoves: 12, attackLinesMoves: 12 });
    await db.setCurrentGame('g3');
  };

  it('suggests turning attack lines off after 3 qualifying games, until dismissed', async () => {
    await setup(undefined, { settings: LINES_ON, prepare: twoGamesAndOneToFinish });
    await waitFor(() => expect(board.options?.allowDragging).toBe(true));
    drop('h5', 'f7');
    expect(await screen.findByText(SUGGEST_LINES_OFF)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }));
    expect(screen.queryByText(SUGGEST_LINES_OFF)).not.toBeInTheDocument();
  });

  it('does not suggest it once attack lines are already off', async () => {
    const { setSettings } = await setup(undefined, { settings: LINES_ON, prepare: twoGamesAndOneToFinish });
    await waitFor(() => expect(board.options?.allowDragging).toBe(true));
    setSettings(DEFAULT_SETTINGS);
    drop('h5', 'f7');
    const recap = await screen.findByRole('region', { name: /game over/i });
    await waitFor(() => expect(recap).toHaveTextContent('No big mistakes this game.'));
    expect(screen.queryByText(SUGGEST_LINES_OFF)).not.toBeInTheDocument();
  });

  it('does not suggest it in a ?fen= practice game', async () => {
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
    const recap = await screen.findByRole('region', { name: /game over/i });
    await waitFor(() => expect(recap).toHaveTextContent('No big mistakes this game.'));
    expect(screen.queryByText(SUGGEST_LINES_OFF)).not.toBeInTheDocument();
  });

  it('a move made after attack lines were shown, then turned off, is still assisted and counted', async () => {
    const { db, onProfile, setSettings } = await setup(undefined, { settings: LINES_ON });
    fireEvent.click(await screen.findByRole('button', { name: 'White' }));
    await waitFor(() => expect(board.options?.allowDragging).toBe(true));
    await waitFor(() => expect(boardEl().getAttribute('data-fen')).toBe(START));
    setSettings(DEFAULT_SETTINGS);
    drop('e2', 'e4');
    await waitFor(() => expect(onProfile).toHaveBeenCalled());
    expect(lastRecord(onProfile)?.assisted).toBe(true);
    await waitFor(async () => expect(await savedGame(db)).toMatchObject({ attackLinesMoves: 1, userMoves: 1 }));
  });

  it('a promotion is counted once', async () => {
    const { db } = await setup(undefined, {
      prepare: async (db) => {
        await db.saveGame({ id: 'p1', startedAt: 1, userColor: 'w', verdicts: [], result: null, userMoves: 4, attackLinesMoves: 0,
          moves: ['a2a4', 'b7b5', 'a4b5', 'a7a6', 'b5a6', 'c8b7', 'a6b7', 'e7e6'] });
        await db.setCurrentGame('p1');
      },
    });
    await waitFor(() => expect(board.options?.allowDragging).toBe(true));
    expect(drop('b7', 'a8')).toBe(false);
    fireEvent.click(await screen.findByRole('button', { name: 'Queen' }));
    await waitFor(async () => expect(await db.getGame('p1')).toMatchObject({ userMoves: 5 }));
  });
});

describe('GameScreen: Play to learn', () => {
  const TEACH_LABEL = "Teaching game · doesn't count toward your level";
  const option = { uci: 'e2e4', san: 'e4', reason: 'It takes the centre.', watch: null };
  const guideTurn = (): CoachMessage => ({
    id: 'teach-1', kind: 'teach', source: 'template', arrows: [], explanation: { whatHappened: 'The position.' },
    theirMove: null, questions: ['What does their last move attack?'],
    teach: { topic: 'opening', mode: 'guide', position: 'The position.', options: [option], optionsOpen: false, inBook: false },
  });
  function teachingCoach() {
    const coach = fakeCoach();
    coach.teachTurn = vi.fn(async () => guideTurn());
    coach.openOptions = vi.fn((): CoachMessage => {
      const m = guideTurn();
      return { ...m, arrows: [{ from: 'e2', to: 'e4', color: 'green' }], teach: { ...m.teach!, optionsOpen: true } };
    });
    return coach;
  }

  it('choosing Play to learn starts a teaching game', async () => {
    const coach = teachingCoach();
    await setup(undefined, { coach });
    const group = await screen.findByRole('radiogroup', { name: 'Game type' });
    expect(within(group).getByRole('radio', { name: 'Play' })).toHaveAttribute('aria-checked', 'true');
    const note = "The coach shows you good moves before you play. These games don't count toward your level.";
    expect(screen.queryByText(note)).not.toBeInTheDocument();
    fireEvent.click(within(group).getByRole('radio', { name: 'Play to learn' }));
    expect(within(group).getByRole('radio', { name: 'Play to learn' })).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByText(note)).toBeInTheDocument();
    fireEvent.click(within(group).getByRole('radio', { name: 'Play' }));
    expect(screen.queryByText(note)).not.toBeInTheDocument();
    fireEvent.click(within(group).getByRole('radio', { name: 'Play to learn' }));
    fireEvent.click(screen.getByRole('button', { name: 'White' }));
    expect(await screen.findByText(TEACH_LABEL)).toBeInTheDocument();
    await waitFor(() => expect(coach.teachTurn).toHaveBeenCalled());
    expect(coach.preMove).not.toHaveBeenCalled();
    expect(await screen.findByRole('button', { name: 'Show me options' })).toBeInTheDocument();
  });

  it('says the coach is looking while the teaching turn is prepared, and never in a play game', async () => {
    const THINKING = 'The coach is looking at the position…';
    const coach = teachingCoach();
    let release = () => {};
    const ready = new Promise<void>((r) => { release = r; });
    coach.teachTurn = vi.fn(async () => { await ready; return guideTurn(); });
    await setup(undefined, { coach });
    fireEvent.click(await screen.findByRole('radio', { name: 'Play to learn' }));
    fireEvent.click(screen.getByRole('button', { name: 'White' }));
    expect(await screen.findByText(THINKING)).toBeInTheDocument();
    release();
    expect(await screen.findByRole('button', { name: 'Show me options' })).toBeInTheDocument();
    expect(screen.queryByText(THINKING)).not.toBeInTheDocument();

    cleanup();
    const play = fakeCoach();
    await setup(undefined, { coach: play });
    fireEvent.click(await screen.findByRole('button', { name: 'White' }));
    await waitFor(() => expect(play.preMove).toHaveBeenCalled());
    expect(screen.queryByText(THINKING)).not.toBeInTheDocument();
  });

  it('default start is a play game', async () => {
    const coach = teachingCoach();
    await setup(undefined, { coach });
    fireEvent.click(await screen.findByRole('button', { name: 'White' }));
    await waitFor(() => expect(board.options?.allowDragging).toBe(true));
    await waitFor(() => expect(coach.preMove).toHaveBeenCalled());
    expect(coach.teachTurn).not.toHaveBeenCalled();
    expect(screen.queryByText(TEACH_LABEL)).not.toBeInTheDocument();
  });

  it('green option arrows only while options are open', async () => {
    const coach = teachingCoach();
    await setup(undefined, { coach });
    fireEvent.click(await screen.findByRole('radio', { name: 'Play to learn' }));
    fireEvent.click(screen.getByRole('button', { name: 'White' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Show me options' }));
    expect(boardEl().getAttribute('data-arrows')).toBe('green');
    expect(screen.getByRole('heading', { name: 'Good options' })).toBeInTheDocument();
    // Before opening there was no arrow: check by starting a fresh game in guide mode.
    cleanup();
    await setup(undefined, { coach: teachingCoach() });
    fireEvent.click(await screen.findByRole('radio', { name: 'Play to learn' }));
    fireEvent.click(screen.getByRole('button', { name: 'White' }));
    await screen.findByRole('button', { name: 'Show me options' });
    expect(boardEl().getAttribute('data-arrows')).toBe('');
  });

  it('watching an option goes "Back to the options"', async () => {
    const coach = fakeCoach();
    const watch = plies(START, ['e2e4', 'e7e5']).map((p, i) => ({ ...p, by: i % 2 === 0 ? 'user' as const : 'opponent' as const }));
    coach.teachTurn = vi.fn(async (): Promise<CoachMessage> => {
      const m = guideTurn();
      return { ...m, teach: { ...m.teach!, mode: 'show', optionsOpen: true, options: [{ ...option, watch }] } };
    });
    await setup(undefined, { coach });
    fireEvent.click(await screen.findByRole('radio', { name: 'Play to learn' }));
    fireEvent.click(screen.getByRole('button', { name: 'White' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Watch option 1' }));
    expect(screen.getByRole('region', { name: 'Watch what happens' })).toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'Coach' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Back to the options' }));
    expect(screen.getByRole('heading', { name: 'Good options' })).toBeInTheDocument();
  });

  it('a teaching game ends with the recap titled "Teaching game"', async () => {
    const coach = teachingCoach();
    await setup('r1bqkb1r/pppp1ppp/2n2n2/4p2Q/2B1P3/8/PPPP1PPP/RNB1K1NR w KQkq - 4 4', { coach });
    fireEvent.click(await screen.findByRole('radio', { name: 'Play to learn' }));
    fireEvent.click(screen.getByRole('button', { name: 'White' }));
    await waitFor(() => expect(board.options?.allowDragging).toBe(true));
    drop('h5', 'f7');
    const recap = await screen.findByRole('region', { name: /game over/i });
    expect(within(recap).getByRole('heading', { name: 'Teaching game' })).toBeInTheDocument();
    expect(coach.teachRecap).toHaveBeenCalled();
    expect(coach.recap).not.toHaveBeenCalled();
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
