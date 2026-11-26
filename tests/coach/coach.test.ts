import { describe, it, expect, vi } from 'vitest';
import { Coach } from '../../src/coach/coach';
import type { CoachDeps, CoachMessage } from '../../src/coach/coach';
import type { Verdict } from '../../src/coach/classify';
import { THEME_LESSONS, THEME_WHY } from '../../src/coach/templates';
import { findJargon } from '../../src/coach/jargon';
import type { Explanation } from '../../src/coach/templates';
import type { FactPacket } from '../../src/coach/claude';
import { HABIT_QUESTIONS } from '../../src/coach/questions';
import type { Engine } from '../../src/engine/engine';
import { GameState } from '../../src/game/gameState';
import type { Analysis, CoachLevel, EngineLine } from '../../src/types';

const line = (uci: string[], cp: number | null, mate: number | null = null): EngineLine => ({ uci, cp, mate });

class FakeEngine implements Engine {
  calls: { fen: string; multipv: number; depth: number }[] = [];
  stops = 0;
  /** When `gate` is set, every search waits for it before answering. */
  gate: Promise<void> | null = null;
  constructor(private table: Record<string, EngineLine[]>, private reject = false) {}
  async analyse(fen: string, opts: { multipv: number; depth: number }): Promise<Analysis> {
    this.calls.push({ fen, ...opts });
    if (this.gate) await this.gate;
    if (this.reject) throw new Error('stopped');
    return { fen, depth: opts.depth, lines: this.table[fen] ?? [] };
  }
  stop(): void { this.stops++; }
  busy(): boolean { return false; }
}

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

function makeDeps(engine: Engine, over: Partial<CoachDeps> = {}): CoachDeps {
  return {
    engine,
    explain: () => Promise.resolve(null),
    levelFor: () => 'full',
    profile: () => ({ topThemes: [], gamesPlayed: 0 }),
    themeCount: () => 0,
    ...over,
  };
}

// White to move; Ne5?? puts the knight where the d6 pawn takes it.
const KNIGHT_FEN = '4k3/8/3p4/8/8/5N2/8/4K3 w - - 0 1';
const KNIGHT_AFTER = '4k3/8/3p4/4N3/8/8/8/4K3 b - - 1 1';
const knightTable = (): Record<string, EngineLine[]> => ({
  [KNIGHT_FEN]: [line(['e1e2'], 300)],
  [KNIGHT_AFTER]: [line(['d6e5', 'e1e2'], 10)],
});

async function knightBlunder(over: Partial<CoachDeps> = {}) {
  const engine = new FakeEngine(knightTable());
  const coach = new Coach(makeDeps(engine, over));
  const game = new GameState('w', KNIGHT_FEN);
  const move = game.play('f3e5');
  const result = await coach.onUserMove(game, move);
  return { engine, coach, game, move, result };
}

// Black to move after White's Bg5, which attacks the undefended knight on f6.
const BISHOP_START = '4k3/8/5n2/8/8/8/8/2B1K3 w - - 0 1';
const BISHOP_FEN = '4k3/8/5n2/6B1/8/8/8/4K3 b - - 1 1';
const bishopTable = (): Record<string, EngineLine[]> => ({
  [BISHOP_FEN]: [line(['f6d5'], 0), line(['f6e4'], -20)],
});

describe('Coach.onUserMove', () => {
  it('flags a hanging knight with a template message, then upgrades it via onUpdate', async () => {
    const claude: Explanation = { whatHappened: 'Your knight on e5 can be taken by dxe5.' };
    const d = deferred<Explanation | null>();
    const explain = vi.fn((_p: FactPacket) => d.promise);
    const updates: CoachMessage[] = [];
    const engine = new FakeEngine(knightTable());
    const coach = new Coach(makeDeps(engine, { explain }));
    coach.onUpdate((m) => updates.push(m));
    const game = new GameState('w', KNIGHT_FEN);
    const move = game.play('f3e5');

    const { verdict, message } = await coach.onUserMove(game, move);
    expect(verdict.flagged).toBe(true);
    expect(verdict.theme).toBe('hanging_piece');
    expect(message?.kind).toBe('mistake');
    expect(message?.source).toBe('template');
    expect(message?.verdict).toEqual(verdict);
    expect(message?.explanation.whatHappened).toContain('your knight on e5');
    expect(message?.arrows).toEqual([{ from: 'd6', to: 'e5', color: 'red' }]);
    expect(engine.calls).toEqual([
      { fen: KNIGHT_FEN, multipv: 3, depth: 14 },
      { fen: KNIGHT_AFTER, multipv: 3, depth: 14 },
    ]);
    expect(explain).toHaveBeenCalledTimes(1);
    expect(explain.mock.calls[0][0].kind).toBe('mistake');
    expect(updates).toHaveLength(0);

    d.resolve(claude);
    await flush();
    expect(updates).toHaveLength(1);
    expect(updates[0].id).toBe(message!.id);
    expect(updates[0].source).toBe('claude');
    expect(updates[0].explanation.whatHappened).toBe(claude.whatHappened);
    expect(updates[0].arrows).toEqual(message!.arrows);
  });

  it('notifies every registered listener', async () => {
    const a: CoachMessage[] = [];
    const b: CoachMessage[] = [];
    const engine = new FakeEngine(knightTable());
    const coach = new Coach(makeDeps(engine, { explain: () => Promise.resolve({ whatHappened: 'x' }) }));
    coach.onUpdate((m) => a.push(m));
    coach.onUpdate((m) => b.push(m));
    const game = new GameState('w', KNIGHT_FEN);
    await coach.onUserMove(game, game.play('f3e5'));
    await flush();
    expect(a).toHaveLength(1);
    expect(b).toHaveLength(1);
  });

  it('keeps the template when explain resolves null', async () => {
    const updates: CoachMessage[] = [];
    const explain = vi.fn(() => Promise.resolve(null));
    const coach = new Coach(makeDeps(new FakeEngine(knightTable()), { explain }));
    coach.onUpdate((m) => updates.push(m));
    const game = new GameState('w', KNIGHT_FEN);
    const result = await coach.onUserMove(game, game.play('f3e5'));
    await flush();
    expect(explain).toHaveBeenCalledTimes(1);
    expect(result.message?.source).toBe('template');
    expect(updates).toHaveLength(0);
  });

  it('resolves and never throws when explain rejects (async or sync)', async () => {
    const updates: CoachMessage[] = [];
    const engine = new FakeEngine(knightTable());
    const coach = new Coach(makeDeps(engine, { explain: () => Promise.reject(new Error('boom')) }));
    coach.onUpdate((m) => updates.push(m));
    const game = new GameState('w', KNIGHT_FEN);
    const { verdict, message } = await coach.onUserMove(game, game.play('f3e5'));
    await flush();
    expect(verdict.flagged).toBe(true);
    expect(message?.source).toBe('template');
    expect(updates).toHaveLength(0);

    const coach2 = new Coach(makeDeps(new FakeEngine(knightTable()), {
      explain: () => { throw new Error('sync boom'); },
    }));
    const game2 = new GameState('w', KNIGHT_FEN);
    await expect(coach2.onUserMove(game2, game2.play('f3e5'))).resolves.toBeTruthy();
  });

  it('drops a late Claude result after cancelPending()', async () => {
    const d = deferred<Explanation | null>();
    const updates: CoachMessage[] = [];
    const { coach } = await knightBlunder({ explain: () => d.promise });
    coach.onUpdate((m) => updates.push(m));
    coach.cancelPending();
    d.resolve({ whatHappened: 'late' });
    await flush();
    expect(updates).toHaveLength(0);
  });

  it('cancelPending while the engine is thinking: no message, no explain, no second search', async () => {
    const engine = new FakeEngine(knightTable());
    const gate = deferred<void>();
    engine.gate = gate.promise;
    const explain = vi.fn(() => Promise.resolve(null));
    const coach = new Coach(makeDeps(engine, { explain }));
    const game = new GameState('w', KNIGHT_FEN);
    const pending = coach.onUserMove(game, game.play('f3e5'));
    coach.cancelPending();
    gate.resolve();
    const { verdict, message } = await pending;
    await flush();
    expect(message).toBeNull();
    expect(verdict.flagged).toBe(false);
    expect(explain).not.toHaveBeenCalled();
    expect(engine.calls.map((c) => c.fen)).toEqual([KNIGHT_FEN]);
  });

  it('resolves with an unflagged stub and no message when the engine rejects', async () => {
    const engine = new FakeEngine({}, true);
    const coach = new Coach(makeDeps(engine));
    const game = new GameState('w', KNIGHT_FEN);
    const move = game.play('f3e5');
    const { verdict, message } = await coach.onUserMove(game, move);
    expect(verdict.flagged).toBe(false);
    expect(verdict.severity).toBe('ok');
    expect(verdict.analysed).toBe(false);
    expect(message).toBeNull();
  });

  it('marks a verdict as unanalysed when the engine returns no lines for the position before', async () => {
    const engine = new FakeEngine({});
    const coach = new Coach(makeDeps(engine));
    const game = new GameState('w', KNIGHT_FEN);
    const { verdict } = await coach.onUserMove(game, game.play('f3e5'));
    expect(verdict.analysed).toBe(false);
  });

  it('analysed verdicts do not carry analysed: false', async () => {
    const { result } = await knightBlunder();
    expect(result.verdict.analysed).not.toBe(false);
  });

  it('makes no engine call and does not flag once the game is over', async () => {
    const engine = new FakeEngine({});
    const coach = new Coach(makeDeps(engine));
    const game = new GameState('w', '7k/6pp/8/8/8/8/8/R5K1 w - - 0 1');
    const move = game.play('a1a8'); // Ra8#
    expect(game.result()).not.toBeNull();
    const { verdict, message } = await coach.onUserMove(game, move);
    expect(verdict.flagged).toBe(false);
    expect(message).toBeNull();
    expect(engine.calls).toHaveLength(0);
  });

  it('treats the user\'s book moves as in book (never flagged)', async () => {
    const start = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
    const game = new GameState('w');
    const move = game.play('e2e4');
    const engine = new FakeEngine({
      [start]: [line(['d2d4'], 500)],
      [move.fenAfter]: [line(['e7e5'], 500)], // pretend 1.e4 lost a lot
    });
    const levelFor = vi.fn((): CoachLevel => 'full');
    const coach = new Coach(makeDeps(engine, { levelFor }));
    const { verdict } = await coach.onUserMove(game, move);
    expect(verdict.flagged).toBe(false);
    expect(levelFor).toHaveBeenCalledWith('opening');
  });

  it('passes the level for the move\'s area and the theme count to the template', async () => {
    const levelFor = vi.fn((): CoachLevel => 'full');
    const themeCount = vi.fn(() => 2);
    const { result } = await knightBlunder({ levelFor, themeCount });
    expect(levelFor).toHaveBeenCalledWith('opening');
    expect(themeCount).toHaveBeenCalledWith('hanging_piece');
    expect(result.message?.explanation.lesson).toContain('This keeps coming up (3 times)');
  });

  it('reuses the preMove analysis of the position the user moves from', async () => {
    const after = '4k3/8/8/3n2B1/8/8/8/4K3 w - - 2 2';
    const engine = new FakeEngine({ ...bishopTable(), [after]: [line(['g5d2'], 0)] });
    const coach = new Coach(makeDeps(engine));
    const game = new GameState('b', BISHOP_START, ['c1g5']);
    await coach.preMove(game);
    const move = game.play('f6d5');
    await coach.onUserMove(game, move);
    expect(engine.calls.map((c) => c.fen)).toEqual([BISHOP_FEN, after]);
  });
});

describe('Coach analysis cache', () => {
  it('a take-back and retry reuses the analysis of the position before the move', async () => {
    const engine = new FakeEngine(knightTable());
    const coach = new Coach(makeDeps(engine));
    const game = new GameState('w', KNIGHT_FEN);
    await coach.onUserMove(game, game.play('f3e5'));
    expect(engine.calls.map((c) => c.fen)).toEqual([KNIGHT_FEN, KNIGHT_AFTER]);
    coach.cancelPending();
    game.takeBackUserMove();
    await coach.onUserMove(game, game.play('e1e2'));
    coach.cancelPending();
    game.takeBackUserMove();
    await coach.onUserMove(game, game.play('e1d2')); // a second retry still reuses it
    expect(engine.calls.filter((c) => c.fen === KNIGHT_FEN)).toHaveLength(1);
    expect(engine.stops).toBe(0);
  });
});

// Black to move after White's quiet Kg1; ...Ra1 is mate on the back rank.
const MATE_START = 'r5k1/5ppp/8/8/8/8/5PPP/7K w - - 0 30';
const MATE_FEN = 'r5k1/5ppp/8/8/8/8/5PPP/6K1 b - - 1 30';
const START_FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';

describe('Coach.preMove', () => {
  it('returns null at light and solo, but prefetches the analysis for the user\'s move', async () => {
    for (const level of ['light', 'solo'] as CoachLevel[]) {
      const engine = new FakeEngine(bishopTable());
      const coach = new Coach(makeDeps(engine, { levelFor: () => level }));
      const game = new GameState('b', BISHOP_START, ['c1g5']);
      expect(await coach.preMove(game)).toBeNull();
      expect(engine.calls.map((c) => c.fen)).toEqual([BISHOP_FEN]);
      await coach.onUserMove(game, game.play('f6d5'));
      expect(engine.calls.filter((c) => c.fen === BISHOP_FEN)).toHaveLength(1); // reused, not searched again
    }
  });

  it('force: true (Ask the coach) gives the pre_move at light', async () => {
    const engine = new FakeEngine(bishopTable());
    const coach = new Coach(makeDeps(engine, { levelFor: () => 'light' }));
    const game = new GameState('b', BISHOP_START, ['c1g5']);
    const m = await coach.preMove(game, { force: true });
    expect(m?.kind).toBe('pre_move');
    expect(m?.theirMove).toContain('knight on f6');
  });

  it('works on move 1 as White: questions, no arrows, no move named', async () => {
    const explain = vi.fn((_p: FactPacket) => Promise.resolve(null));
    const engine = new FakeEngine({ [START_FEN]: [line(['e2e4'], 30)] });
    const coach = new Coach(makeDeps(engine, { explain }));
    const game = new GameState('w');
    const m = await coach.preMove(game);
    expect(m?.kind).toBe('pre_move');
    expect(m?.theirMove).toBeNull();
    expect(m?.questions?.length).toBeGreaterThanOrEqual(2);
    expect(m?.arrows).toEqual([]);
    expect(Object.keys(m!.explanation)).toEqual(['whatHappened']);
    await flush();
    expect(explain).not.toHaveBeenCalled();
  });

  it('drops a nudge that only repeats one of the questions', async () => {
    // On move 1 the only nudge is the opening plan, which is also the first question.
    const coach = new Coach(makeDeps(new FakeEngine({ [START_FEN]: [line(['e2e4'], 30)] })));
    const m = await coach.preMove(new GameState('w'));
    expect(m?.questions?.length).toBeGreaterThan(0);
    expect(m?.nudge).toBeNull();
    expect(m?.nudgeHighlight).toEqual([]);
  });

  it('after an opponent move: blue arrow only, a fact-backed nudge, and no Claude call', async () => {
    const explain = vi.fn((_p: FactPacket) => Promise.resolve(null));
    const engine = new FakeEngine(bishopTable());
    const coach = new Coach(makeDeps(engine, { explain }));
    const game = new GameState('b', BISHOP_START, ['c1g5']);
    const m = await coach.preMove(game);
    expect(m?.kind).toBe('pre_move');
    expect(m?.source).toBe('template');
    expect(m?.arrows).toEqual([{ from: 'c1', to: 'g5', color: 'blue' }]);
    expect(m?.theirMove).toContain('Their bishop now attacks your knight on f6');
    expect(m?.questions).toContain('One of your pieces is under attack and not safely protected. Can you find it?');
    expect(m?.nudge).toBe('Look at your knight on f6.');
    expect(m?.nudgeHighlight).toEqual(['f6']);
    expect(engine.calls).toEqual([{ fen: BISHOP_FEN, multipv: 3, depth: 14 }]);
    await flush();
    expect(explain).not.toHaveBeenCalled();
  });

  it('answers at once with habit questions, then updates the same id when the analysis arrives', async () => {
    const engine = new FakeEngine({ [MATE_FEN]: [line(['a8a1'], null, 1)] });
    const gate = deferred<void>();
    engine.gate = gate.promise;
    const updates: CoachMessage[] = [];
    const coach = new Coach(makeDeps(engine));
    coach.onUpdate((m) => updates.push(m));
    const game = new GameState('b', MATE_START, ['h1g1']);
    const m = await coach.preMove(game);
    expect(m?.kind).toBe('pre_move');
    expect(m?.questions).toEqual([...HABIT_QUESTIONS]);
    expect(m?.nudge).toBeNull();

    gate.resolve();
    await flush();
    expect(updates).toHaveLength(1);
    expect(updates[0].id).toBe(m!.id);
    expect(updates[0].kind).toBe('pre_move');
    expect(updates[0].questions?.[0]).toBe("There's a way to win right now. Look at every check you can give.");
    expect(updates[0].nudge).toBe('Look at checks with your rook.');
    expect(updates[0].arrows).toEqual([{ from: 'h1', to: 'g1', color: 'blue' }]);
  });

  it('uses an analysis that is already in hand straight away (no update needed)', async () => {
    const engine = new FakeEngine({ [MATE_FEN]: [line(['a8a1'], null, 1)] });
    const updates: CoachMessage[] = [];
    const coach = new Coach(makeDeps(engine));
    coach.onUpdate((m) => updates.push(m));
    const game = new GameState('b', MATE_START, ['h1g1']);
    await coach.preMove(game);
    await flush();
    updates.length = 0;
    const again = await coach.preMove(game);
    expect(again?.questions?.[0]).toBe("There's a way to win right now. Look at every check you can give.");
    await flush();
    expect(updates).toHaveLength(0);
    expect(engine.calls).toHaveLength(1);
  });

  it('drops the analysis update once the user has moved, and shares the search', async () => {
    const after = '4k3/8/8/3n2B1/8/8/8/4K3 w - - 2 2';
    const engine = new FakeEngine({ ...bishopTable(), [after]: [line(['g5d2'], 0)] });
    const gate = deferred<void>();
    engine.gate = gate.promise;
    const updates: CoachMessage[] = [];
    const coach = new Coach(makeDeps(engine));
    coach.onUpdate((m) => updates.push(m));
    const game = new GameState('b', BISHOP_START, ['c1g5']);
    const pre = await coach.preMove(game);
    expect(pre?.kind).toBe('pre_move');
    const move = game.play('f6d5');
    const user = coach.onUserMove(game, move);
    gate.resolve();
    await user;
    await flush();
    expect(updates.some((u) => u.id === pre!.id)).toBe(false);
    expect(engine.calls.map((c) => c.fen)).toEqual([BISHOP_FEN, after]);
  });

  it('drops the analysis update after cancelPending() or a newer preMove', async () => {
    for (const interrupt of ['cancel', 'newer'] as const) {
      const engine = new FakeEngine({ [MATE_FEN]: [line(['a8a1'], null, 1)] });
      const gate = deferred<void>();
      engine.gate = gate.promise;
      const updates: CoachMessage[] = [];
      const coach = new Coach(makeDeps(engine));
      coach.onUpdate((m) => updates.push(m));
      const game = new GameState('b', MATE_START, ['h1g1']);
      const first = await coach.preMove(game);
      if (interrupt === 'cancel') coach.cancelPending();
      else await coach.preMove(game);
      gate.resolve();
      await flush();
      expect(updates.some((u) => u.id === first!.id)).toBe(false);
    }
  });

  it('returns the facts-only message when the engine rejects, with no update', async () => {
    const updates: CoachMessage[] = [];
    const coach = new Coach(makeDeps(new FakeEngine({}, true)));
    coach.onUpdate((m) => updates.push(m));
    const game = new GameState('b', BISHOP_START, ['c1g5']);
    const m = await coach.preMove(game);
    expect(m?.kind).toBe('pre_move');
    await flush();
    expect(updates).toHaveLength(0);
  });

  it('returns null when it is not the user\'s turn or the game is over', async () => {
    const coach = new Coach(makeDeps(new FakeEngine({})));
    expect(await coach.preMove(new GameState('b'))).toBeNull();
    const over = new GameState('b', '7k/6pp/8/8/8/8/8/R5K1 w - - 0 1', ['a1a8']);
    expect(await coach.preMove(over)).toBeNull();
  });

  it('gives messages unique ids', async () => {
    const coach = new Coach(makeDeps(new FakeEngine(bishopTable())));
    const game = new GameState('b', BISHOP_START, ['c1g5']);
    const a = await coach.preMove(game);
    const b = await coach.preMove(game);
    expect(a!.id).not.toBe(b!.id);
  });
});

// White to move; Ke2 is best (300), Kd2 is 40 cp worse but not a mistake.
const KING_FEN = KNIGHT_FEN;
const kingTable = (game: GameState): Record<string, EngineLine[]> => {
  const after = (uci: string) => {
    const g = new GameState('w', game.fen());
    return g.play(uci).fenAfter;
  };
  return {
    [KING_FEN]: [line(['e1e2', 'e8e7'], 300), line(['e1d2', 'e8e7'], 260)],
    [after('e1e2')]: [line(['e8e7', 'f3d4'], -300)],
    [after('e1d2')]: [line(['e8d7', 'f3d4'], -260)],
  };
};

describe('Coach post_move', () => {
  function setup(over: Partial<CoachDeps> = {}) {
    const game = new GameState('w', KING_FEN);
    const engine = new FakeEngine(kingTable(game));
    const updates: CoachMessage[] = [];
    const coach = new Coach(makeDeps(engine, over));
    coach.onUpdate((m) => updates.push(m));
    return { game, engine, coach, updates };
  }

  it('the engine\'s best move gives a top post_move with no Claude call and no arrow', async () => {
    const explain = vi.fn((_p: FactPacket) => Promise.resolve(null));
    const { game, coach } = setup({ explain });
    const { verdict, message } = await coach.onUserMove(game, game.play('e1e2'));
    expect(verdict.flagged).toBe(false);
    expect(message?.kind).toBe('post_move');
    expect(message?.topKind).toBe('top');
    expect(message?.summary).toBe("✓ That's the top move. Do you see why it works?");
    expect(message?.explained).toBe(false);
    expect(message?.arrows).toEqual([]);
    await flush();
    expect(explain).not.toHaveBeenCalled();
  });

  it('a move missing from the multipv lines but within 20 cp (by its own search) is top', async () => {
    const game = new GameState('w', KING_FEN);
    const table = kingTable(game);
    table[new GameState('w', KING_FEN).play('e1f2').fenAfter] = [line(['e8e7', 'f3d4'], -285)];
    const coach = new Coach(makeDeps(new FakeEngine(table)));
    const { message } = await coach.onUserMove(game, game.play('e1f2'));
    expect(message?.kind).toBe('post_move');
    expect(message?.topKind).toBe('top');
  });

  it('explainTopMove shows the template, asks Claude once, and caches', async () => {
    const d = deferred<Explanation | null>();
    const explain = vi.fn((_p: FactPacket) => d.promise);
    const { game, coach, updates } = setup({ explain });
    const { message } = await coach.onUserMove(game, game.play('e1e2'));
    await coach.explainTopMove(message!.id);
    expect(updates).toHaveLength(1);
    expect(updates[0].id).toBe(message!.id);
    expect(updates[0].explained).toBe(true);
    expect(updates[0].source).toBe('template');
    expect(updates[0].explanation).toEqual(message!.explanation);
    await flush();
    expect(explain).toHaveBeenCalledTimes(1);
    expect(explain.mock.calls[0][0].kind).toBe('post_move');
    expect(explain.mock.calls[0][0].facts.playedMoveIs).toBe('top');

    d.resolve({ whatHappened: 'Ke2 keeps your king close to the knight.' });
    await flush();
    expect(updates).toHaveLength(2);
    expect(updates[1].source).toBe('claude');
    expect(updates[1].explained).toBe(true);
    expect(updates[1].explanation.whatHappened).toBe('Ke2 keeps your king close to the knight.');

    await coach.explainTopMove(message!.id);
    await flush();
    expect(explain).toHaveBeenCalledTimes(1);
    expect(updates).toHaveLength(2);
  });

  it('explainTopMove ignores an id that is not the current post_move', async () => {
    const explain = vi.fn((_p: FactPacket) => Promise.resolve(null));
    const { game, coach, updates } = setup({ explain });
    await coach.onUserMove(game, game.play('e1e2'));
    await coach.explainTopMove('coach-999');
    await flush();
    expect(explain).not.toHaveBeenCalled();
    expect(updates).toHaveLength(0);
  });

  it('a move 40 cp worse (not flagged) gives a stronger-option post_move, a Claude call and a green arrow', async () => {
    const explain = vi.fn((_p: FactPacket) => Promise.resolve(null));
    const { game, coach } = setup({ explain });
    const { verdict, message } = await coach.onUserMove(game, game.play('e1d2'));
    expect(verdict.flagged).toBe(false);
    expect(message?.kind).toBe('post_move');
    expect(message?.topKind).toBeNull();
    expect(message?.summary).toBe('Your move: Kd2. A stronger option was Ke2.');
    expect(message?.arrows).toEqual([{ from: 'e1', to: 'e2', color: 'green' }]);
    await flush();
    expect(explain).toHaveBeenCalledTimes(1);
    expect(explain.mock.calls[0][0].kind).toBe('post_move');
    expect(explain.mock.calls[0][0].facts.playedMoveIs).toBe('not_top');
  });

  it('post_move packets carry the engine-checked reasons; the better move\'s only when it is not top', async () => {
    const explain = vi.fn((_p: FactPacket) => Promise.resolve(null));
    // From the start, a3 is 40 cp worse than Nf3: the better move's reasons are its own, checked.
    const game = new GameState('w');
    const a3 = new GameState('w').play('a2a3');
    const engine = new FakeEngine({
      [START_FEN]: [line(['g1f3', 'd7d5'], 40), line(['a2a3', 'e7e5'], 0)],
      [a3.fenAfter]: [line(['e7e5', 'g1f3'], 0)],
    });
    const coach = new Coach(makeDeps(engine, { explain }));
    const first = await coach.onUserMove(game, game.play('a2a3'));
    expect(first.message?.topKind).toBeNull();
    await flush();
    const p = explain.mock.calls[0][0];
    expect(p.facts.playedMoveIs).toBe('not_top');
    expect(p.reasons?.fundamentals).toEqual([]);
    expect(p.bestReasons?.fundamentals[0]).toBe('develops');
    expect(p.bestReasons?.effect).toMatch(/^brings your knight out/);
    expect(p.template.better).toMatch(/^Nf3 brings your knight out/);
    expect(p.template.whatHappened).toBe('After a3, their best answer is e5. a3 does not bring a knight or bishop out.');

    const b = setup({ explain });
    const { message } = await b.coach.onUserMove(b.game, b.game.play('e1e2'));
    await b.coach.explainTopMove(message!.id);
    await flush();
    const q = explain.mock.calls[1][0];
    expect(q.facts.playedMoveIs).toBe('top');
    // A king step this early earns no checked reason: the packet says so, and the template falls back.
    expect(q.reasons).toEqual({ opening: null, principle: null, fundamentals: [], effect: null });
    expect(q.template.whatHappened).toBe("It keeps the engine's preferred plan going: Ke2, Ke7.");
    expect(q.bestReasons).toBeNull();
  });

  it('keeps a stronger-option upgrade through the opponent\'s reply and the next preMove', async () => {
    const d = deferred<Explanation | null>();
    const { game, coach, updates } = setup({ explain: () => d.promise });
    const { message } = await coach.onUserMove(game, game.play('e1d2'));
    game.play('e8d7');
    await coach.preMove(game);
    await flush();
    updates.length = 0;
    d.resolve({ whatHappened: 'Ke2 was a little better.' });
    await flush();
    expect(updates).toHaveLength(1);
    expect(updates[0].id).toBe(message!.id);
    expect(updates[0].source).toBe('claude');
  });

  it('a book move gives a book post_move; explainTopMove shows the idea and never calls Claude', async () => {
    const explain = vi.fn((_p: FactPacket) => Promise.resolve({ whatHappened: 'x' }));
    const game = new GameState('w');
    const move = game.play('e2e4');
    const engine = new FakeEngine({ [START_FEN]: [line(['d2d4'], 500)], [move.fenAfter]: [line(['e7e5'], 500)] });
    const updates: CoachMessage[] = [];
    const coach = new Coach(makeDeps(engine, { explain }));
    coach.onUpdate((m) => updates.push(m));
    const { message } = await coach.onUserMove(game, move);
    expect(message?.kind).toBe('post_move');
    expect(message?.topKind).toBe('book');
    expect(message?.summary).toBe('✓ Book move. Do you see why?');
    expect(message?.arrows).toEqual([]);
    await coach.explainTopMove(message!.id);
    await flush();
    expect(updates).toHaveLength(1);
    expect(updates[0].explained).toBe(true);
    expect(updates[0].explanation.whatHappened.length).toBeGreaterThan(0);
    expect(explain).not.toHaveBeenCalled();
  });

  it('drops a late Claude result after the next onUserMove or cancelPending()', async () => {
    for (const interrupt of ['next', 'cancel'] as const) {
      const d = deferred<Explanation | null>();
      const { game, coach, updates } = setup({ explain: () => d.promise });
      const { message } = await coach.onUserMove(game, game.play('e1d2'));
      if (interrupt === 'cancel') {
        coach.cancelPending();
      } else {
        game.play('e8d7');
        await coach.onUserMove(game, game.play('d2e2'));
      }
      d.resolve({ whatHappened: 'late' });
      await flush();
      expect(updates.some((u) => u.id === message!.id)).toBe(false);
    }
  });

  it('drops a late explainTopMove result after the next onUserMove or cancelPending()', async () => {
    for (const interrupt of ['next', 'cancel'] as const) {
      const d = deferred<Explanation | null>();
      const { game, coach, updates } = setup({ explain: () => d.promise });
      const { message } = await coach.onUserMove(game, game.play('e1e2'));
      await coach.explainTopMove(message!.id);
      if (interrupt === 'cancel') {
        coach.cancelPending();
      } else {
        game.play('e8e7');
        await coach.onUserMove(game, game.play('e2d2'));
      }
      updates.length = 0;
      d.resolve({ whatHappened: 'late' });
      await flush();
      expect(updates.some((u) => u.id === message!.id)).toBe(false);
    }
  });

  it('gives no post_move and no Claude call at light or solo', async () => {
    for (const level of ['light', 'solo'] as CoachLevel[]) {
      for (const uci of ['e1e2', 'e1d2']) {
        const explain = vi.fn((_p: FactPacket) => Promise.resolve(null));
        const { game, coach } = setup({ explain, levelFor: () => level });
        const { verdict, message } = await coach.onUserMove(game, game.play(uci));
        expect(verdict.flagged).toBe(false);
        expect(message).toBeNull();
        await flush();
        expect(explain).not.toHaveBeenCalled();
      }
    }
  });

  it('gives post_move feedback at guided', async () => {
    const explain = vi.fn((_p: FactPacket) => Promise.resolve(null));
    const { game, coach } = setup({ explain, levelFor: () => 'guided' });
    const { message } = await coach.onUserMove(game, game.play('e1d2'));
    expect(message?.kind).toBe('post_move');
    expect(message?.topKind).toBeNull();
    await flush();
    expect(explain).toHaveBeenCalledTimes(1);
  });

  it('gives no post_move when the move could not be analysed', async () => {
    const coach = new Coach(makeDeps(new FakeEngine({})));
    const game = new GameState('w', KING_FEN);
    const { message } = await coach.onUserMove(game, game.play('e1e2'));
    expect(message).toBeNull();
  });
});

describe('Coach hint ladder after a take-back', () => {
  it('climbs: theme habit, then piece square; Show me names the best move', async () => {
    const { coach, game } = await knightBlunder();
    game.takeBackUserMove();
    coach.cancelPending();
    expect(coach.hintStep(1).text).toContain(THEME_LESSONS.hanging_piece.habit);
    expect(coach.hintStep(2).text).toContain('e1');
    expect(coach.hintStep(2).text).not.toContain('Ke2');
    expect(coach.showMe()?.summary).toBe('The better move was Ke2.');
  });
});

describe('Coach.hintStep', () => {
  it('Hint 1 is the lesson habit and its why, with no highlight', async () => {
    const { coach } = await knightBlunder();
    const h = coach.hintStep(1);
    expect(h.text).toBe(`Remember the lesson (${THEME_LESSONS.hanging_piece.title}): ${THEME_LESSONS.hanging_piece.habit} ${THEME_WHY.hanging_piece}`);
    expect(h.highlight).toEqual([]);
    expect(h.text).not.toMatch(/\b[a-h][1-8]\b/);
    expect(findJargon(h.text)).toEqual([]);
  });

  it('Hint 2 rings the square the better move starts from and names no destination', async () => {
    const { coach } = await knightBlunder();
    expect(coach.hintStep(2)).toEqual({ text: 'Look at your king on e1.', highlight: ['e1'] });
  });

  it('gives empty steps with no mistake', () => {
    const coach = new Coach(makeDeps(new FakeEngine({})));
    expect(coach.hintStep(1)).toEqual({ text: '', highlight: [] });
    expect(coach.hintStep(2)).toEqual({ text: '', highlight: [] });
  });
});

describe('spoiler-free mistake card', () => {
  it('never shows the better move in the message, arrows or Claude packet', async () => {
    const explain = vi.fn((_p: FactPacket) => Promise.resolve(null));
    const { result } = await knightBlunder({ explain });
    const message = result.message!;
    const { bestSan, bestUci } = result.verdict;
    expect(bestSan).toBe('Ke2');
    expect(JSON.stringify(message.explanation)).not.toContain(bestSan);
    expect(message.explanation.better).toBeUndefined();
    expect(message.arrows.some((a) => a.color === 'green')).toBe(false);
    expect(message.verdict?.severity).toBe('blunder');
    const p = explain.mock.calls[0][0];
    expect(p.allowedMoves).toEqual(['Ne5', 'dxe5']);
    expect(JSON.stringify(p.facts)).not.toContain(bestSan);
    expect(JSON.stringify(p.facts)).not.toContain(bestUci);
    for (const t of [message.explanation.whatHappened, message.explanation.lesson ?? '']) expect(findJargon(t)).toEqual([]);
  });

  it('drops a "better" field from a Claude rewrite of the card', async () => {
    const updates: CoachMessage[] = [];
    const explain = () => Promise.resolve({ whatHappened: 'Your knight on e5 can be taken.', better: 'Moving your king was better.' });
    const engine = new FakeEngine(knightTable());
    const coach = new Coach(makeDeps(engine, { explain }));
    coach.onUpdate((m) => updates.push(m));
    const game = new GameState('w', KNIGHT_FEN);
    await coach.onUserMove(game, game.play('f3e5'));
    await flush();
    expect(updates).toHaveLength(1);
    expect(updates[0].explanation.whatHappened).toBe('Your knight on e5 can be taken.');
    expect(updates[0].explanation.better).toBeUndefined();
  });
});

describe('mistake card Claude rewrites that point at the better move in prose', () => {
  it.each([
    { whatHappened: 'Move your king to e2 instead.' },
    { whatHappened: 'Your knight on e5 can be taken.', lesson: 'Step your king on e1 up first.' },
    { whatHappened: 'Ke2 would keep things calm.' },
  ])('keeps the template for %o', async (out) => {
    const updates: CoachMessage[] = [];
    const coach = new Coach(makeDeps(new FakeEngine(knightTable()), { explain: () => Promise.resolve(out) }));
    coach.onUpdate((m) => updates.push(m));
    const game = new GameState('w', KNIGHT_FEN);
    await coach.onUserMove(game, game.play('f3e5'));
    await flush();
    expect(updates).toHaveLength(0);
  });
});

describe('Coach.showMe and playOnReveal', () => {
  it('is idempotent per mistake: the same message and a single Claude call', async () => {
    const explain = vi.fn((_p: FactPacket) => Promise.resolve(null));
    const { coach } = await knightBlunder({ explain });
    explain.mockClear();
    const a = coach.showMe();
    const b = coach.showMe();
    const c = coach.playOnReveal();
    await flush();
    expect(b?.id).toBe(a?.id);
    expect(c?.id).toBe(a?.id);
    expect(explain).toHaveBeenCalledTimes(1);
  });

  it('returns the upgraded reveal once Claude has answered', async () => {
    const explain = vi.fn((p: FactPacket) => Promise.resolve(p.kind === 'mistake' ? null : { whatHappened: 'Ke2 walks your king up.' }));
    const { coach } = await knightBlunder({ explain });
    const first = coach.showMe()!;
    await flush();
    const again = coach.showMe()!;
    expect(again.id).toBe(first.id);
    expect(again.source).toBe('claude');
    expect(again.explanation.whatHappened).toBe('Ke2 walks your king up.');
  });

  const expectReveal = (m: CoachMessage | null) => {
    expect(m?.kind).toBe('post_move');
    expect(m?.summary).toBe('The better move was Ke2.');
    expect(m?.arrows).toEqual([{ from: 'e1', to: 'e2', color: 'green' }]);
    expect(m?.topKind).toBeNull();
    expect(m?.reveal).toBe(true);
    expect(m?.explained).toBe(true);
    expect(m?.explanation.whatHappened).toMatch(/^Ke2 /);
    expect(m?.explanation.whatHappened).not.toMatch(/Ne5|dxe5/);
    for (const t of [m!.summary!, m!.explanation.whatHappened, m!.explanation.better ?? '']) expect(findJargon(t)).toEqual([]);
  };

  it('showMe reveals the better move after a take-back', async () => {
    const { coach, game } = await knightBlunder();
    game.takeBackUserMove();
    coach.cancelPending();
    expectReveal(coach.showMe());
  });

  it('playOnReveal gives the same reveal after Play on', async () => {
    const { coach } = await knightBlunder();
    coach.playOn();
    expectReveal(coach.playOnReveal());
  });

  it('returns null with no mistake', () => {
    const coach = new Coach(makeDeps(new FakeEngine({})));
    expect(coach.showMe()).toBeNull();
    expect(coach.playOnReveal()).toBeNull();
  });

  it('asks Claude with a reveal packet from the position before the mistake, holding only the better move', async () => {
    const explain = vi.fn((_p: FactPacket) => Promise.resolve(null));
    const { coach } = await knightBlunder({ explain });
    explain.mockClear();
    coach.showMe();
    await flush();
    expect(explain).toHaveBeenCalledTimes(1);
    const p = explain.mock.calls[0][0];
    expect(p.kind).toBe('post_move');
    expect(p.fen).toBe(KNIGHT_FEN);
    expect(p.allowedMoves).toEqual(['Ke2']);
    expect(p.reasons).toBeUndefined();
    expect(p.bestReasons).toBeTruthy();
    expect(JSON.stringify(p)).not.toMatch(/Ne5|dxe5/);
  });

  it('upgrades the reveal from Claude, but drops a stale answer once the user moves again', async () => {
    const d1 = deferred<Explanation | null>();
    const explain = vi.fn((p: FactPacket) => (p.kind === 'mistake' || !p.facts.reveal ? Promise.resolve(null) : d1.promise));
    const updates: CoachMessage[] = [];
    const { coach, game } = await knightBlunder({ explain });
    coach.onUpdate((m) => updates.push(m));
    game.takeBackUserMove();
    coach.cancelPending();

    coach.showMe();
    await coach.onUserMove(game, game.play('e1e2'));
    expect(coach.showMe()).toBeNull(); // the reveal belonged to the mistake, which is gone
    d1.resolve({ whatHappened: 'Ke2 is good.' });
    await flush();
    expect(updates.filter((m) => m.reveal)).toHaveLength(0);
  });

  it('emits the Claude upgrade of a current reveal', async () => {
    const updates: CoachMessage[] = [];
    const explain = (p: FactPacket) => Promise.resolve(p.kind === 'mistake' ? null : { whatHappened: 'Ke2 walks your king up.' });
    const { coach } = await knightBlunder({ explain });
    coach.onUpdate((m) => updates.push(m));
    const shown = coach.showMe()!;
    await flush();
    expect(updates).toHaveLength(1);
    expect(updates[0].id).toBe(shown.id);
    expect(updates[0].source).toBe('claude');
    expect(updates[0].summary).toBe('The better move was Ke2.');
  });
});

describe('Coach consequence tracker', () => {
  it('emits exactly one consequence when the refutation is played', async () => {
    const { coach, game } = await knightBlunder();
    coach.playOn();
    game.play('d6e5');
    const m = coach.checkConsequence(game);
    expect(m?.kind).toBe('consequence');
    expect(m?.explanation.whatHappened).toContain('your knight on e5');
    expect(m?.explanation.whatHappened).toContain('dxe5');
    expect(m?.verdict?.theme).toBe('hanging_piece');
    expect(coach.checkConsequence(game)).toBeNull();
  });

  it('emits when the user loses the refutation\'s material by another route', async () => {
    // Ne5?? hangs the knight to dxe5; here the line is longer but the knight still drops.
    const engine = new FakeEngine(knightTable());
    const coach = new Coach(makeDeps(engine));
    const game = new GameState('w', KNIGHT_FEN);
    await coach.onUserMove(game, game.play('f3e5'));
    coach.playOn();
    game.play('e8e7');
    expect(coach.checkConsequence(game)).toBeNull();
    game.play('e1e2');
    expect(coach.checkConsequence(game)).toBeNull();
    game.play('d6e5'); // the knight is lost a move later
    const m = coach.checkConsequence(game);
    expect(m?.kind).toBe('consequence');
    // The engine line is dxe5, Ke2: only the opponent's moves are named, never the user's own.
    expect(m?.explanation.whatHappened).toContain('dxe5');
    expect(m?.explanation.whatHappened).not.toContain('Ke2');
    expect(coach.checkConsequence(game)).toBeNull();
  });

  it('does not name the piece when material is lost without that piece being taken on its square', async () => {
    const { coach, game } = await knightBlunder();
    coach.playOn();
    // Kd8, then the knight wanders to c6 and is taken there instead of on e5.
    for (const uci of ['e8d8', 'e5c6', 'd8c7', 'e1e2']) {
      game.play(uci);
      expect(coach.checkConsequence(game)).toBeNull();
    }
    game.play('c7c6');
    const m = coach.checkConsequence(game);
    expect(m?.kind).toBe('consequence');
    expect(m?.explanation.whatHappened).toContain("Here's where Ne5 costs you.");
    expect(m?.explanation.whatHappened).not.toContain('your knight on e5');
  });

  it('disarms after 6 plies without the refutation', async () => {
    const { coach, game } = await knightBlunder();
    coach.playOn();
    for (const uci of ['e8e7', 'e5c4', 'e7e6', 'c4e3', 'e6e5', 'e3c2']) {
      game.play(uci);
      expect(coach.checkConsequence(game)).toBeNull();
    }
    game.play('d6d5');
    expect(coach.checkConsequence(game)).toBeNull();
  });

  it('is not armed without playOn, and cancelPending disarms', async () => {
    const { coach, game } = await knightBlunder();
    game.play('d6e5');
    expect(coach.checkConsequence(game)).toBeNull();

    const second = await knightBlunder();
    second.coach.playOn();
    second.coach.cancelPending();
    second.game.play('d6e5');
    expect(second.coach.checkConsequence(second.game)).toBeNull();
  });
});

describe('Coach.recap', () => {
  const v = (flagged: boolean, theme: Verdict['theme'] = 'other'): Verdict => ({
    flagged, severity: flagged ? 'blunder' : 'ok', cpLoss: flagged ? 300 : 0, area: 'middlegame', theme,
    recommendation: flagged ? 'take_back' : 'play_on', bestUci: 'e2e4', bestSan: 'e4', refutationSan: [],
  });
  const lines = (m: CoachMessage) =>
    [m.explanation.whatHappened, m.explanation.better, m.explanation.lesson]
      .filter((s): s is string => Boolean(s))
      .flatMap((s) => s.split('\n'));

  it('names the most frequent flagged theme, a good stretch and the habit, in at most 3 lines', () => {
    const coach = new Coach(makeDeps(new FakeEngine({})));
    const verdicts = [v(false), v(true, 'hanging_piece'), v(false), v(false), v(false), v(true, 'missed_fork'),
      v(true, 'hanging_piece')];
    const m = coach.recap(new GameState('w'), verdicts);
    expect(m.kind).toBe('recap');
    expect(m.source).toBe('template');
    expect(lines(m).length).toBeLessThanOrEqual(3);
    expect(m.explanation.whatHappened).toContain(THEME_LESSONS.hanging_piece.title);
    expect(m.explanation.better).toContain('3 moves in a row');
    expect(m.explanation.lesson).toContain(THEME_LESSONS.hanging_piece.habit);
  });

  it('says "no big mistakes" when nothing was flagged', () => {
    const coach = new Coach(makeDeps(new FakeEngine({})));
    const m = coach.recap(new GameState('w'), [v(false), v(false)]);
    expect(m.explanation.whatHappened.toLowerCase()).toContain('no big mistakes');
    expect(lines(m).length).toBeLessThanOrEqual(3);
  });
});

describe('mistake card watch line', () => {
  const BACK_RANK_FEN = 'rr4k1/5ppp/8/8/8/8/5PPP/3R2K1 w - - 0 1';
  const BACK_RANK_AFTER = 'rr4k1/5ppp/8/8/8/3R4/5PPP/6K1 b - - 1 1';

  it('offers the engine line when the mistake allows a forced mate', async () => {
    const engine = new FakeEngine({
      [BACK_RANK_FEN]: [line(['h2h3'], -500)],
      [BACK_RANK_AFTER]: [line(['a8a1', 'd3d1', 'a1d1'], null, 2)],
    });
    const coach = new Coach(makeDeps(engine));
    const game = new GameState('w', BACK_RANK_FEN);
    const { message } = await coach.onUserMove(game, game.play('d1d3'));
    expect(message?.kind).toBe('mistake');
    expect(message?.watch?.length).toBeGreaterThan(0);
    expect(message?.watch?.at(-1)?.san).toBe('Rxd1#');
  });

  it('has no watch line for a one-move loss', async () => {
    const { result } = await knightBlunder();
    expect(result.message?.watch).toBeUndefined();
  });
});
