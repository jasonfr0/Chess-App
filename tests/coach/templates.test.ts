import { describe, it, expect } from 'vitest';
import { Chess } from 'chess.js';
import { THEME_LESSONS, mistakeTemplate, preMoveTemplate } from '../../src/coach/templates';
import type { Verdict } from '../../src/coach/classify';
import { positionFacts } from '../../src/coach/facts';
import { lookup } from '../../src/openings/repertoire';
import type { Analysis, EngineLine, PlayedMove, Theme } from '../../src/types';

function playAll(sans: string[]): PlayedMove[] {
  const c = new Chess();
  return sans.map((san) => {
    const fenBefore = c.fen();
    const color = c.turn();
    const m = c.move(san);
    return { san: m.san, uci: m.from + m.to + (m.promotion ?? ''), fenBefore, fenAfter: c.fen(), color };
  });
}
const line = (uci: string[], cp: number | null, mate: number | null = null): EngineLine => ({ uci, cp, mate });

describe('mistakeTemplate', () => {
  // 1.e4 e5 2.Nf3 d6 3.Nh4?? hangs the knight to Qxh4
  const hist = playAll(['e4', 'e5', 'Nf3', 'd6', 'Nh4']);
  const move = hist[4];
  const verdict: Verdict = {
    flagged: true, severity: 'blunder', cpLoss: 320, area: 'opening', theme: 'hanging_piece',
    recommendation: 'take_back', bestUci: 'f1c4', bestSan: 'Bc4', refutationSan: ['Qxh4'],
  };
  const ctx = (themeCount: number) => ({ verdict, move, factsAfter: positionFacts(move.fenAfter), themeCount });

  it('names the refutation and the hanging square', () => {
    const e = mistakeTemplate(ctx(0));
    expect(e.whatHappened).toContain('Qxh4');
    expect(e.whatHappened).toContain('your knight on h4');
    expect(e.better).toContain('Bc4');
    expect(e.lesson).toContain(THEME_LESSONS.hanging_piece.habit);
  });

  it('prefixes the lesson when the theme repeats', () => {
    expect(mistakeTemplate(ctx(2)).lesson!.startsWith('This keeps coming up (3 times)')).toBe(true);
    expect(mistakeTemplate(ctx(1)).lesson!.startsWith('This keeps')).toBe(false);
  });

  it('does not claim a hanging piece for other themes', () => {
    const e = mistakeTemplate({ ...ctx(0), verdict: { ...verdict, theme: 'other' } });
    expect(e.whatHappened).not.toMatch(/free|hang/);
    expect(e.whatHappened).toContain('Qxh4');
  });
});

describe('preMoveTemplate', () => {
  it('puts book replies first with a note, in the Italian', () => {
    const hist = playAll(['e4', 'e5', 'Nf3', 'Nc6']);
    const last = hist[3];
    const book = lookup('w', hist.map((m) => m.san));
    expect(book).not.toBeNull();
    const analysis: Analysis = { fen: last.fenAfter, depth: 10, lines: [line(['f1b5'], 30), line(['f1c4'], 25)] };
    const e = preMoveTemplate({ fen: last.fenAfter, lastMove: last, facts: positionFacts(last.fenAfter), analysis, book, level: 'full' });
    expect(e.candidates![0].san).toBe('Bc4');
    expect(e.candidates![0].note.length).toBeGreaterThan(0);
    expect(e.candidates!.length).toBeLessThanOrEqual(3);
    expect(e.candidates!.filter((c) => c.best).length).toBeLessThanOrEqual(1);
  });

  it('without book: <=3 candidates within 150cp, exactly one best', () => {
    const hist = playAll(['d4', 'Nf6', 'c4', 'e6']);
    const last = hist[3];
    const analysis: Analysis = {
      fen: last.fenAfter, depth: 10,
      lines: [line(['b1c3'], 40), line(['g1f3'], 30), line(['g2g3'], -80), line(['a2a3'], -100), line(['h2h4'], 10)],
    };
    const e = preMoveTemplate({ fen: last.fenAfter, lastMove: last, facts: positionFacts(last.fenAfter), analysis, book: null, level: 'full' });
    const c = e.candidates!;
    expect(c.map((x) => x.uci)).toEqual(['b1c3', 'g1f3', 'h2h4']);
    expect(c.filter((x) => x.best)).toHaveLength(1);
    expect(c[0].best).toBe(true);
    expect(c.every((x) => x.note.length > 0)).toBe(true);
    expect(c[1].note).toBe('develops your knight');
  });

  it('notes captures and checks truthfully', () => {
    const fen = '4k3/8/8/4n3/8/8/R3R3/4K3 w - - 0 1';
    const last: PlayedMove = { san: 'Ne5', uci: 'c6e5', fenBefore: fen, fenAfter: fen, color: 'b' };
    const analysis: Analysis = { fen, depth: 8, lines: [line(['e2e5'], 300), line(['a2a8'], 290)] };
    const e = preMoveTemplate({ fen, lastMove: last, facts: positionFacts(fen), analysis, book: null, level: 'full' });
    expect(e.candidates![0].note).toBe('captures the knight on e5');
    expect(e.candidates![1].note).toBe('gives check');
  });
});

describe('THEME_LESSONS', () => {
  it('covers every theme', () => {
    const themes: Theme[] = ['hanging_piece', 'ignored_threat', 'allowed_fork', 'missed_fork', 'missed_pin', 'missed_mate',
      'allowed_mate', 'early_queen', 'undeveloped', 'king_safety', 'bad_trade', 'endgame_technique', 'other'];
    for (const t of themes) {
      expect(THEME_LESSONS[t].title.length).toBeGreaterThan(0);
      expect(THEME_LESSONS[t].habit.length).toBeGreaterThan(0);
    }
    expect(THEME_LESSONS.allowed_fork.title).toBe('Walked into a fork');
  });
});
