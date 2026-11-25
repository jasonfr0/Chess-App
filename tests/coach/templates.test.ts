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

describe('mistakeTemplate wording', () => {
  const mk = (fenBefore: string, uci: string): PlayedMove => {
    const c = new Chess(fenBefore);
    const color = c.turn();
    const m = c.move({ from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci[4] });
    return { san: m.san, uci, fenBefore, fenAfter: c.fen(), color };
  };
  const verdictFor = (theme: Theme, bestUci: string, bestSan: string, refutationSan: string[]): Verdict => ({
    flagged: true, severity: 'blunder', cpLoss: 300, area: 'middlegame', theme,
    recommendation: 'take_back', bestUci, bestSan, refutationSan,
  });
  const explain = (move: PlayedMove, verdict: Verdict) =>
    mistakeTemplate({ verdict, move, factsAfter: positionFacts(move.fenAfter), themeCount: 0 });

  it('says "free" only for an undefended piece', () => {
    // Ne5?? — nothing defends e5, and the d6 pawn takes it.
    const move = mk('4k3/8/3p4/8/8/5N2/8/4K3 w - - 0 1', 'f3e5');
    const e = explain(move, verdictFor('hanging_piece', 'e1e2', 'Ke2', ['dxe5']));
    expect(e.whatHappened).toBe("After Ne5, your knight on e5 can be taken for free. They can play dxe5, and the engine's line is dxe5.");
  });

  it('a defended piece attacked by a cheaper one "can be won", never "free"', () => {
    // Nb5: the a4 pawn guards b5, but the c6 pawn can still take the knight.
    const move = mk('4k3/8/2p5/8/P7/2N5/8/4K3 w - - 0 1', 'c3b5');
    const e = explain(move, verdictFor('hanging_piece', 'e1e2', 'Ke2', ['cxb5', 'axb5']));
    expect(e.whatHappened).not.toMatch(/free/);
    expect(e.whatHappened).toBe(
      "After Nb5, your knight on b5 can be won: their pawn on c6 can take it, and a pawn is worth less than a knight. They can play cxb5, and the engine's line is cxb5, axb5.");
  });

  it('ignored_threat starts with a capital letter', () => {
    // Black to move; the bishop on g5 already attacks the undefended knight on f6, and Kd8 does not help.
    const move = mk('4k3/8/5n2/6B1/8/8/8/4K3 b - - 1 1', 'e8d8');
    const e = explain(move, verdictFor('ignored_threat', 'f6d5', 'Nd5', ['Bxf6+']));
    expect(e.whatHappened).toBe("Your knight on f6 was already under attack and Kd8 did not save it. They can play Bxf6+, and the engine's line is Bxf6+.");
  });

  it('allowed_fork names the fork with "both" for exactly two targets', () => {
    // h3?? lets the knight jump to c2, checking the king and attacking the rook.
    const move = mk('7k/8/8/8/1n6/8/7P/R3K3 w - - 0 1', 'h2h3');
    const e = explain(move, verdictFor('allowed_fork', 'a1a4', 'Ra4', ['Nc2+']));
    expect(e.whatHappened).toBe('After h3, they can play Nc2+, and their knight on c2 attacks both your rook on a1 and your king on e1.');
  });

  it('missed_fork describes the fork the better move made', () => {
    const move = mk('r3k3/7p/8/1N6/8/8/7P/7K w - - 0 1', 'h2h3');
    const e = explain(move, verdictFor('missed_fork', 'b5c7', 'Nc7+', ['Kd7']));
    expect(e.better).toBe('The better move was Nc7+. Nc7+ would have attacked both their rook on a8 and their king on e8 at once.');
  });

  it('missed_mate says checkmate', () => {
    const move = mk('6k1/5ppp/8/8/8/8/5PPP/3R2K1 w - - 0 1', 'h2h3');
    const e = explain(move, verdictFor('missed_mate', 'd1d8', 'Rd8#', ['h6']));
    expect(e.better).toBe('The better move was Rd8#. Rd8# was checkmate.');
  });
});

describe('preMoveTemplate', () => {
  it('drops "both" when their piece attacks three of yours', () => {
    // Nc2+ checks the king and attacks the rook on a1 and the queen on e3.
    const fenBefore = '7k/8/8/8/1n6/4Q3/8/R3K3 b - - 0 1';
    const c = new Chess(fenBefore);
    c.move('Nc2+');
    const last: PlayedMove = { san: 'Nc2+', uci: 'b4c2', fenBefore, fenAfter: c.fen(), color: 'b' };
    const analysis: Analysis = { fen: last.fenAfter, depth: 8, lines: [line(['e1d1'], -300)] };
    const e = preMoveTemplate({ fen: last.fenAfter, lastMove: last, facts: positionFacts(last.fenAfter), analysis, book: null, level: 'full' });
    expect(e.whatHappened).toContain('Their knight on c2 attacks your queen on e3, your rook on a1 and your king on e1.');
    expect(e.whatHappened).not.toContain('both');
  });

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
