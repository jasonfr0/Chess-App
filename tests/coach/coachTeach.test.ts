import { describe, it, expect } from 'vitest';
import { Coach } from '../../src/coach/coach';
import type { CoachDeps, CoachMessage } from '../../src/coach/coach';
import { findJargon } from '../../src/coach/jargon';
import { moveLeaks } from '../../src/coach/leaks';
import type { Engine } from '../../src/engine/engine';
import { GameState } from '../../src/game/gameState';
import type { Analysis, EngineLine, TeachMode } from '../../src/types';
import type { Explanation } from '../../src/coach/templates';
import type { FactPacket } from '../../src/coach/claude';

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
/** The position after `uci` from the Italian setup's turn. */
function italianAfter(uci: string): string {
  const g = new GameState('w', ITALIAN_BEFORE);
  g.play('b8c6');
  return g.play(uci).fenAfter;
}
function teachSetup(mode: TeachMode, opts: { reject?: boolean; over?: Partial<CoachDeps> } = {}) {
  const game = new GameState('w', ITALIAN_BEFORE);
  game.play('b8c6');
  const table = {
    [game.fen()]: [line(['d2d4', 'e5d4'], 80), line(['b1c3', 'g8f6'], 40), line(['a2a3', 'g8f6'], -100)],
    [italianAfter('d2d4')]: [line(['e5d4', 'f3d4'], -80)],
    // Bc4 is not an option, but only 40 worse: a good move that the classifier does not flag.
    [italianAfter('f1c4')]: [line(['g8f6', 'd2d3'], -40)],
  };
  const coach = new Coach(makeDeps(new FakeEngine(table, opts.reject), { teachModeFor: () => mode, ...opts.over }));
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

  it('a custom start position is out of the repertoire: engine options, no line name', async () => {
    const coach = new Coach(makeDeps(new FakeEngine({ [KNIGHT_FEN]: [line(['e1e2', 'e8e7'], 0)] })));
    coach.setMode('teach');
    const m = (await coach.teachTurn(new GameState('w', KNIGHT_FEN)))!;
    expect(m.teach?.inBook).toBe(false);
    expect(m.teach?.options.map((o) => o.uci)).toEqual(['e1e2']);
    expect(m.teach?.topic).not.toBe('opening');
    expect(m.teach?.position).not.toContain("You're in");
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

  it('a shown option gets a plain confirmation with no question', async () => {
    const { game, coach } = teachSetup('show');
    await coach.teachTurn(game);
    const { verdict, message } = await coach.onUserMove(game, game.play('d2d4'));
    expect(verdict.flagged).toBe(false);
    expect(message?.kind).toBe('post_move');
    expect(message?.explained).toBe(true);
    expect(message?.summary).toBe('✓ Good move.');
    for (const t of [message!.summary!, message!.explanation.whatHappened, message!.explanation.better ?? '', message!.explanation.lesson ?? '']) {
      expect(t).not.toContain('?');
      expect(findJargon(t)).toEqual([]);
    }
  });

  it('a good move that was not an option gets its own reasons and no better move', async () => {
    const { game, coach } = teachSetup('show');
    const turn = (await coach.teachTurn(game))!;
    expect(turn.teach?.options.some((o) => o.uci === 'f1c4')).toBe(false);
    const { verdict, message } = await coach.onUserMove(game, game.play('f1c4'));
    expect(verdict.flagged).toBe(false);
    expect(verdict.bestSan).toBe('d4');
    expect(message?.kind).toBe('post_move');
    expect(message?.explained).toBe(true);
    expect(message ? greens(message) : null).toEqual([]);
    const text = [message!.summary!, message!.explanation.whatHappened, message!.explanation.better ?? ''].join(' ');
    expect(text).not.toContain(verdict.bestSan);
    expect(text).not.toContain('?');
    expect(message!.explanation.whatHappened).toMatch(/^Bc4 /);
    expect(message!.explanation.whatHappened).not.toBe('Bc4 is a fine move here.');
  });

  it('play mode keeps its own feedback for the same move', async () => {
    const { game, coach } = teachSetup('show');
    coach.setMode('play');
    const { message } = await coach.onUserMove(game, game.play('f1c4'));
    expect(message?.summary).toBe('Your move: Bc4. A stronger option was d4.');
    expect(message ? greens(message).map((a) => a.from + a.to) : null).toEqual(['d2d4']);
  });

  it("Claude's rewrite of a teaching mistake keeps the reveal", async () => {
    const claude: Explanation = { whatHappened: 'Your knight on e5 can be taken.', better: 'Kd2 was the move.' };
    const updates: CoachMessage[] = [];
    const coach = new Coach(makeDeps(new FakeEngine(knightTable()), { explain: () => Promise.resolve(claude) }));
    coach.onUpdate((m) => updates.push(m));
    coach.setMode('teach');
    const game = new GameState('w', KNIGHT_FEN);
    const { verdict, message } = await coach.onUserMove(game, game.play('f3e5'));
    await new Promise((r) => setTimeout(r, 0));
    expect(updates).toHaveLength(1);
    const up = updates[0];
    expect(up.id).toBe(message!.id);
    expect(up.source).toBe('claude');
    expect(up.explanation.whatHappened).toBe(claude.whatHappened);
    expect(up.explanation.better).toBe(message!.explanation.better);
    expect(up.explanation.better).toContain(verdict.bestSan);
    expect(up.reveal).toBe(true);
    expect(up.arrows).toContainEqual({ from: verdict.bestUci.slice(0, 2), to: verdict.bestUci.slice(2, 4), color: 'green' });
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

describe("Claude's wording of the teaching turn", () => {
  const flush = () => new Promise((r) => setTimeout(r, 0));
  function withExplain(mode: TeachMode, explain: CoachDeps['explain']) {
    const calls: FactPacket[] = [];
    const setup = teachSetup(mode, { over: { explain: (p) => { calls.push(p); return explain(p); } } });
    const updates: CoachMessage[] = [];
    setup.coach.onUpdate((m) => updates.push(m));
    return { ...setup, updates, calls };
  }
  /** An explain answer the test releases by hand. */
  function gate(answer: Explanation) {
    let release = () => {};
    const ready = new Promise<void>((r) => { release = r; });
    return { explain: () => ready.then(() => answer), release };
  }

  it("Claude's wording replaces the position text", async () => {
    const text = 'Both sides have brought a knight out. Your move.';
    const { game, coach, updates, calls } = withExplain('show', () => Promise.resolve({ whatHappened: text, lesson: 'Extra.' }));
    const m = (await coach.teachTurn(game))!;
    expect(m.source).toBe('template');
    await flush();
    expect(calls).toHaveLength(1);
    expect(calls[0].kind).toBe('teach');
    expect(calls[0].allowedMoves).toEqual(m.teach!.options.map((o) => o.san));
    expect(updates).toHaveLength(1);
    const up = updates[0];
    expect(up.id).toBe(m.id);
    expect(up.source).toBe('claude');
    expect(up.explanation).toEqual({ whatHappened: text });
    expect(up.teach).toEqual({ ...m.teach, position: text });
    expect(up.arrows).toEqual(m.arrows);
    expect(up.questions).toEqual(m.questions);
  });

  it('a guide-mode rewrite that names a move is rejected', async () => {
    for (const whatHappened of ['Your knight came out with Nf3.', 'Think about pushing a pawn to d4.']) {
      const { game, coach, updates, calls } = withExplain('guide', () => Promise.resolve({ whatHappened }));
      await coach.teachTurn(game);
      await flush();
      expect(calls[0].allowedMoves).toEqual([]);
      expect(updates).toEqual([]);
    }
  });

  it('a guide-mode rewrite that points at a piece they can win is rejected', async () => {
    const fen = '4k3/8/8/6n1/8/5N2/8/R3K3 w - - 0 1';
    const updates: CoachMessage[] = [];
    const coach = new Coach(makeDeps(new FakeEngine({ [fen]: [line(['f3g5', 'e8e7'], 300)] }), {
      teachModeFor: () => 'guide', explain: () => Promise.resolve({ whatHappened: 'Their knight on g5 is not guarded.' }),
    }));
    coach.onUpdate((m) => updates.push(m));
    coach.setMode('teach');
    const m = (await coach.teachTurn(new GameState('w', fen)))!;
    expect(m.teach?.optionsOpen).toBe(false);
    await flush();
    expect(updates).toEqual([]);
  });

  it('a clean guide-mode rewrite is used, and kept when the options open', async () => {
    const text = 'Both sides have brought a knight out.';
    const { game, coach, updates } = withExplain('guide', () => Promise.resolve({ whatHappened: text }));
    const m = (await coach.teachTurn(game))!;
    await flush();
    expect(updates.map((u) => u.teach?.position)).toEqual([text]);
    const open = coach.openOptions(m.id)!;
    expect(open.teach?.position).toBe(text);
    expect(open.teach?.optionsOpen).toBe(true);
    expect(open.source).toBe('claude');
  });

  it('no key / explainer returns null keeps the template', async () => {
    const { game, coach, updates, calls } = withExplain('show', () => Promise.resolve(null));
    const m = (await coach.teachTurn(game))!;
    await flush();
    expect(calls).toHaveLength(1);
    expect(updates).toEqual([]);
    expect(m.source).toBe('template');
  });

  it('an engine-failure turn is not sent to Claude', async () => {
    const calls: FactPacket[] = [];
    const { game, coach } = teachSetup('show', { reject: true, over: { explain: (p) => { calls.push(p); return Promise.resolve(null); } } });
    expect((await coach.teachTurn(game))?.teach?.options).toEqual([]);
    await flush();
    expect(calls).toEqual([]);
  });

  it('a rewrite arriving after the options open is not applied', async () => {
    const g = gate({ whatHappened: 'Both sides have brought a knight out.' });
    const { game, coach, updates } = withExplain('guide', g.explain);
    const m = (await coach.teachTurn(game))!;
    const open = coach.openOptions(m.id)!;
    g.release();
    await flush();
    expect(updates).toEqual([]);
    expect(coach.openOptions(m.id)?.teach?.position).toBe(open.teach?.position);
  });

  it('a rewrite arriving after the user moved is not applied', async () => {
    const g = gate({ whatHappened: 'Both sides have brought a knight out.' });
    const { game, coach, updates } = withExplain('show', g.explain);
    await coach.teachTurn(game);
    await coach.onUserMove(game, game.play('d2d4'));
    g.release();
    await flush();
    expect(updates.filter((u) => u.kind === 'teach')).toEqual([]);
  });
});
