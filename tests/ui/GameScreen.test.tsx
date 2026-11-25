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
import { openDb, DEFAULT_SETTINGS, defaultProfile } from '../../src/storage/db';

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
  analyse(fen: string, opts: { multipv: number; depth: number }): Promise<Analysis> {
    this.calls.push({ fen, depth: opts.depth });
    if (this.hold) return new Promise(() => {});
    return Promise.resolve({ fen, depth: opts.depth, lines: [] });
  }
  stop(): void {}
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

async function setup(startFen?: string) {
  const db = await openDb(`game-screen-${n++}`);
  const engine = new FakeEngine();
  const coach = fakeCoach();
  render(
    <GameScreen
      db={db} engine={engine} coach={coach} profile={defaultProfile()} settings={DEFAULT_SETTINGS}
      onProfile={() => {}} onSettings={() => {}} rng={() => 0.5} startFen={startFen} coachOffline={false}
    />,
  );
  return { db, engine, coach };
}

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
});
