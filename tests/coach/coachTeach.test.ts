import { describe, it, expect } from 'vitest';
import { Coach } from '../../src/coach/coach';
import type { CoachDeps, CoachMessage } from '../../src/coach/coach';
import { findJargon } from '../../src/coach/jargon';
import { moveLeaks } from '../../src/coach/leaks';
import type { Engine } from '../../src/engine/engine';
import { GameState } from '../../src/game/gameState';
import type { Analysis, EngineLine, TeachMode } from '../../src/types';

const line = (uci: string[], cp: number | null, mate: number | null = null): EngineLine => ({ uci, cp, mate });

class FakeEngine implements Engine {
  constructor(private table: Record<string, EngineLine[]>, private reject = false) {}
  async analyse(fen: string, opts: { multipv: number; depth: number }): Promise<Analysis> {
    if (this.reject) throw new Error('stopped');
    return { fen, depth: opts.depth, lines: this.table[fen] ?? [] };
  }
  stop(): void {}
  busy(): boolean { return false; }
}

function makeDeps(engine: Engine, over: Partial<CoachDeps> = {}): CoachDeps {
  return {
    engine,
    explain: () => Promise.resolve(null),
    levelFor: () => 'full',
    profile: () => ({ topThemes: [], gamesPlayed: 0 }),
    themeCount: () => 0,
    teachModeFor: () => 'show',
    ...over,
  };
}

const greens = (m: CoachMessage) => m.arrows.filter((a) => a.color === 'green');

// Black's knight comes out; White (the user) is then out of the repertoire, with two close engine lines.
const ITALIAN_BEFORE = 'rnbqkbnr/pppp1ppp/8/4p3/4P3/5N2/PPPP1PPP/RNBQKB1R b KQkq - 1 2';
function teachSetup(mode: TeachMode, opts: { reject?: boolean } = {}) {
  const game = new GameState('w', ITALIAN_BEFORE);
  game.play('b8c6');
  const table = {
    [game.fen()]: [line(['d2d4', 'e5d4'], 80), line(['b1c3', 'g8f6'], 40), line(['a2a3', 'g8f6'], -100)],
  };
  const coach = new Coach(makeDeps(new FakeEngine(table, opts.reject), { teachModeFor: () => mode }));
  coach.setMode('teach');
  return { game, coach };
}

// White to move; Ne5?? puts the knight where the d6 pawn takes it.
const KNIGHT_FEN = '4k3/8/3p4/8/8/5N2/8/4K3 w - - 0 1';
const KNIGHT_AFTER = '4k3/8/3p4/4N3/8/8/8/4K3 b - - 1 1';
const knightTable = (): Record<string, EngineLine[]> => ({
  [KNIGHT_FEN]: [line(['e1e2'], 200)],
  [KNIGHT_AFTER]: [line(['d6e5', 'e1e2'], 0)],
});

async function knightBlunder(mode: 'play' | 'teach', over: Partial<CoachDeps> = {}) {
  const coach = new Coach(makeDeps(new FakeEngine(knightTable()), over));
  coach.setMode('teach');
  if (mode === 'play') coach.setMode('play');
  const game = new GameState('w', KNIGHT_FEN);
  return coach.onUserMove(game, game.play('f3e5'));
}

describe('Coach.teachTurn', () => {
  it('show mode lists options with green arrows', async () => {
    const { game, coach } = teachSetup('show');
    const m = (await coach.teachTurn(game))!;
    expect(m.kind).toBe('teach');
    expect(m.source).toBe('template');
    expect(m.teach?.mode).toBe('show');
    expect(m.teach?.optionsOpen).toBe(true);
    expect(m.teach?.inBook).toBe(false);
    expect(m.teach?.options.map((o) => o.uci)).toEqual(['d2d4', 'b1c3']);
    expect(greens(m)).toEqual(m.teach!.options.map((o) => ({ from: o.uci.slice(0, 2), to: o.uci.slice(2, 4), color: 'green' })));
    expect(m.arrows).toContainEqual({ from: 'b8', to: 'c6', color: 'blue' });
    expect(m.explanation.whatHappened).toBe(m.teach!.position);
    expect(m.teach!.position.length).toBeGreaterThan(0);
  });

  it('guide mode hides options and names no move', async () => {
    const { game, coach } = teachSetup('guide');
    const m = (await coach.teachTurn(game))!;
    expect(m.teach?.mode).toBe('guide');
    expect(m.teach?.optionsOpen).toBe(false);
    expect(m.teach?.options.length).toBe(2);
    expect(greens(m)).toEqual([]);
    expect(moveLeaks(m.teach!.position)).toEqual([]);
    expect(m.questions?.length).toBeGreaterThan(0);
    for (const q of m.questions ?? []) expect(moveLeaks(q)).toEqual([]);
    if (m.nudge) expect(moveLeaks(m.nudge)).toEqual([]);

    const open = coach.openOptions(m.id)!;
    expect(open.id).toBe(m.id);
    expect(open.teach?.optionsOpen).toBe(true);
    expect(open.teach?.mode).toBe('guide');
    expect(greens(open).map((a) => a.from + a.to)).toEqual(['d2d4', 'b1c3']);
    expect(coach.openOptions('nope')).toBeNull();
  });

  it('engine failure still gives a turn', async () => {
    const { game, coach } = teachSetup('guide', { reject: true });
    const m = (await coach.teachTurn(game))!;
    expect(m.kind).toBe('teach');
    expect(m.teach?.options).toEqual([]);
    expect(m.teach?.mode).toBe('show');
    expect(m.teach?.position.length).toBeGreaterThan(0);
  });

  it("is null when it is not the user's turn", async () => {
    const coach = new Coach(makeDeps(new FakeEngine({})));
    coach.setMode('teach');
    expect(await coach.teachTurn(new GameState('w', ITALIAN_BEFORE))).toBeNull();
  });

  it('a stale message cannot be opened after the user moves', async () => {
    const { game, coach } = teachSetup('guide');
    const m = (await coach.teachTurn(game))!;
    await coach.onUserMove(game, game.play('d2d4'));
    expect(coach.openOptions(m.id)).toBeNull();
  });
});

describe('Coach teaching moves', () => {
  it('teaching ignores Play levels', async () => {
    const teach = await knightBlunder('teach', { levelFor: () => 'solo' });
    expect(teach.verdict.flagged).toBe(true);
    const play = await knightBlunder('play', { levelFor: () => 'solo' });
    expect(play.verdict.flagged).toBe(false);
  });

  it('a teaching mistake shows the better move at once', async () => {
    const { verdict, message } = await knightBlunder('teach', { themeCount: () => 5 });
    expect(message?.kind).toBe('mistake');
    expect(message?.reveal).toBe(true);
    expect(message?.explanation.better).toContain(verdict.bestSan);
    expect(message?.explanation.lesson).not.toContain('keeps coming up');
    expect(message?.arrows).toContainEqual({ from: 'd6', to: 'e5', color: 'red' });
    expect(message?.arrows).toContainEqual({ from: verdict.bestUci.slice(0, 2), to: verdict.bestUci.slice(2, 4), color: 'green' });
  });

  it('a good move gets an explained post_move', async () => {
    const coach = new Coach(makeDeps(new FakeEngine(knightTable())));
    coach.setMode('teach');
    const game = new GameState('w', KNIGHT_FEN);
    const { verdict, message } = await coach.onUserMove(game, game.play('e1e2'));
    expect(verdict.flagged).toBe(false);
    expect(message?.kind).toBe('post_move');
    expect(message?.explained).toBe(true);
  });

  it('play mode mistake still hides the better move', async () => {
    const { message } = await knightBlunder('play');
    expect(message?.kind).toBe('mistake');
    expect(message?.explanation.better).toBeUndefined();
    expect(message?.reveal).toBeUndefined();
    expect(message ? greens(message) : null).toEqual([]);
  });
});

describe('Coach.teachRecap', () => {
  it('names the topics and the changes in plain words', () => {
    const coach = new Coach(makeDeps(new FakeEngine({})));
    const m = coach.teachRecap([], ['opening', 'safety'], [{ topic: 'safety', to: 'guide' }]);
    expect(m.kind).toBe('recap');
    expect(m.explanation.whatHappened).toBe('Topics this game: Opening moves, Keeping your pieces safe.');
    expect(m.explanation.better).toBe("Keeping your pieces safe: I'll stop showing moves here and ask you first.");
    expect(m.explanation.lesson).toBe('No big mistakes this game.');
    for (const t of [m.explanation.whatHappened, m.explanation.better, m.explanation.lesson]) {
      expect(findJargon(t ?? '')).toEqual([]);
    }
  });

  it('a short game, a fall back to showing, and the habit from the mistakes', async () => {
    const { verdict } = await knightBlunder('teach');
    const coach = new Coach(makeDeps(new FakeEngine({})));
    const m = coach.teachRecap([verdict], [], [{ topic: 'captures', to: 'show' }]);
    expect(m.explanation.whatHappened).toBe('A short game: no topics came up.');
    expect(m.explanation.better).toBe("Winning material: I'll go back to showing moves for a while.");
    expect(m.explanation.lesson).toMatch(/^Habit to work on: /);
    expect(coach.teachRecap([], ['other'], []).explanation.better).toBeUndefined();
  });
});
