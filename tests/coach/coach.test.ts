import { describe, it, expect, vi } from 'vitest';
import { Coach } from '../../src/coach/coach';
import type { CoachDeps, CoachMessage } from '../../src/coach/coach';
import type { Verdict } from '../../src/coach/classify';
import { THEME_LESSONS } from '../../src/coach/templates';
import type { Explanation } from '../../src/coach/templates';
import type { FactPacket } from '../../src/coach/claude';
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
    expect(message?.arrows).toEqual([
      { from: 'd6', to: 'e5', color: 'red' },
      { from: 'e1', to: 'e2', color: 'green' },
    ]);
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

describe('Coach.preMove', () => {
  it('returns null at light and solo without calling the engine', async () => {
    for (const level of ['light', 'solo'] as CoachLevel[]) {
      const engine = new FakeEngine(bishopTable());
      const coach = new Coach(makeDeps(engine, { levelFor: () => level }));
      const game = new GameState('b', BISHOP_START, ['c1g5']);
      expect(await coach.preMove(game)).toBeNull();
      expect(engine.calls).toHaveLength(0);
    }
  });

  it('at full gives whatHappened, candidates, arrows and a blunder check', async () => {
    const explain = vi.fn((_p: FactPacket) => Promise.resolve(null));
    const engine = new FakeEngine(bishopTable());
    const coach = new Coach(makeDeps(engine, { explain }));
    const game = new GameState('b', BISHOP_START, ['c1g5']);
    const m = await coach.preMove(game);
    expect(m?.kind).toBe('pre_move');
    expect(m?.source).toBe('template');
    expect(m?.explanation.whatHappened).toContain('your knight on f6');
    expect(m?.explanation.candidates?.[0].san).toBe('Nd5');
    expect(m?.arrows).toEqual([
      { from: 'c1', to: 'g5', color: 'blue' },
      { from: 'f6', to: 'd5', color: 'green' },
    ]);
    expect(m?.blunderCheck?.prompt).toMatch(/what does their last move attack/i);
    expect(m?.blunderCheck?.answer).toContain('Their bishop on g5 now attacks your knight on f6');
    expect(engine.calls).toEqual([{ fen: BISHOP_FEN, multipv: 3, depth: 14 }]);
    expect(explain.mock.calls[0][0].kind).toBe('pre_move');
  });

  it('blunder check says nothing else is loose when only the attacked piece is', async () => {
    // Bg5 attacks the f6 knight, which the g7 pawn defends; the a8 rook is attacked by nobody.
    const start = 'r3k3/6p1/5n2/8/8/8/8/2B1K3 w - - 0 1';
    const game = new GameState('b', start, ['c1g5']);
    const engine = new FakeEngine({ [game.fen()]: [line(['e8f7'], 0)] });
    const coach = new Coach(makeDeps(engine));
    const m = await coach.preMove(game);
    expect(m?.blunderCheck?.answer).toBe(
      'Their bishop on g5 now attacks your knight on f6. Nothing else of yours is under attack without protection.',
    );
  });

  it('at guided has no blunder check', async () => {
    const coach = new Coach(makeDeps(new FakeEngine(bishopTable()), { levelFor: () => 'guided' }));
    const game = new GameState('b', BISHOP_START, ['c1g5']);
    const m = await coach.preMove(game);
    expect(m?.explanation.whatHappened).toBeTruthy();
    expect(m?.blunderCheck).toBeUndefined();
  });

  it('passes the book hit for the opponent\'s last move', async () => {
    // User is Black; 1.e4 is in the Black repertoire (answered by 1...e5).
    const game = new GameState('b', undefined, ['e2e4']);
    const engine = new FakeEngine({ [game.fen()]: [line(['e7e5'], -20)] });
    const explain = vi.fn((_p: FactPacket) => Promise.resolve(null));
    const coach = new Coach(makeDeps(engine, { explain }));
    const m = await coach.preMove(game);
    expect(m?.explanation.candidates?.some((c) => c.san === 'e5')).toBe(true);
    expect(explain.mock.calls[0][0].facts.book).not.toBeNull();
  });

  it('blunder check after a discovered check does not over-claim', async () => {
    // Ne4-c5 uncovers the e1 rook's check on the e8 king; the knight itself attacks nothing.
    const game = new GameState('b', '4k3/8/8/8/4N3/8/8/4R1K1 w - - 0 1', ['e4c5']);
    const engine = new FakeEngine({ [game.fen()]: [line(['e8f7'], -500)] });
    const m = await new Coach(makeDeps(engine)).preMove(game);
    expect(m?.blunderCheck?.answer).toBe(
      'You are in check. Their knight on c5 does not attack anything of yours. ' +
        'Nothing of yours is under attack without protection.',
    );
  });

  it('blunder check after a discovered attack names the exposed piece', async () => {
    // Be4-b1 uncovers the e1 rook's attack on the undefended e7 rook.
    const game = new GameState('b', 'k7/4r3/8/8/4B3/8/8/4R1K1 w - - 0 1', ['e4b1']);
    const engine = new FakeEngine({ [game.fen()]: [line(['e7e1'], 0)] });
    const answer = (await new Coach(makeDeps(engine)).preMove(game))?.blunderCheck?.answer ?? '';
    expect(answer).not.toContain('Their last move does not attack');
    expect(answer).toBe(
      'Their bishop on b1 does not attack anything of yours. Your rook on e7 is under attack and not safely protected.',
    );
  });

  it('returns null if the user moves while the engine is thinking, and shares the search', async () => {
    const after = '4k3/8/8/3n2B1/8/8/8/4K3 w - - 2 2';
    const engine = new FakeEngine({ ...bishopTable(), [after]: [line(['g5d2'], 0)] });
    const gate = deferred<void>();
    engine.gate = gate.promise;
    const explain = vi.fn((_p: FactPacket) => Promise.resolve(null));
    const coach = new Coach(makeDeps(engine, { explain }));
    const game = new GameState('b', BISHOP_START, ['c1g5']);
    const pre = coach.preMove(game);
    const move = game.play('f6d5');
    const user = coach.onUserMove(game, move);
    gate.resolve();
    expect(await pre).toBeNull();
    await user;
    await flush();
    expect(engine.calls.map((c) => c.fen)).toEqual([BISHOP_FEN, after]);
    expect(explain).not.toHaveBeenCalled();
  });

  it('returns null when the engine rejects', async () => {
    const coach = new Coach(makeDeps(new FakeEngine({}, true)));
    const game = new GameState('b', BISHOP_START, ['c1g5']);
    await expect(coach.preMove(game)).resolves.toBeNull();
  });

  it('drops a pre-move Claude upgrade once the user has moved', async () => {
    const d = deferred<Explanation | null>();
    const updates: CoachMessage[] = [];
    const after = '4k3/8/8/3n2B1/8/8/8/4K3 w - - 2 2';
    const engine = new FakeEngine({ ...bishopTable(), [after]: [line(['g5d2'], 0)] });
    const coach = new Coach(makeDeps(engine, { explain: () => d.promise }));
    coach.onUpdate((m) => updates.push(m));
    const game = new GameState('b', BISHOP_START, ['c1g5']);
    await coach.preMove(game);
    await coach.onUserMove(game, game.play('f6d5'));
    d.resolve({ whatHappened: 'late' });
    await flush();
    expect(updates).toHaveLength(0);
  });

  it('gives messages unique ids', async () => {
    const coach = new Coach(makeDeps(new FakeEngine(bishopTable())));
    const game = new GameState('b', BISHOP_START, ['c1g5']);
    const a = await coach.preMove(game);
    const b = await coach.preMove(game);
    expect(a!.id).not.toBe(b!.id);
  });
});

describe('Coach.hint', () => {
  it('climbs a ladder: theme habit, then piece square, then best move', async () => {
    const { coach, game } = await knightBlunder();
    game.takeBackUserMove();
    coach.cancelPending();
    expect(coach.hint(1)).toContain(THEME_LESSONS.hanging_piece.habit);
    expect(coach.hint(2)).toContain('e1');
    expect(coach.hint(2)).not.toContain('Ke2');
    expect(coach.hint(3)).toContain('Ke2');
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
