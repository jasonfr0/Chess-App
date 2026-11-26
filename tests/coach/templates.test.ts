import { describe, it, expect } from 'vitest';
import { Chess } from 'chess.js';
import { THEME_LESSONS, THEME_WHY, betterReason, mistakeTemplate, moveNote } from '../../src/coach/templates';
import type { Verdict } from '../../src/coach/classify';
import { positionFacts } from '../../src/coach/facts';
import type { PlayedMove, Theme } from '../../src/types';
import { findJargon } from '../../src/coach/jargon';
import { deriveReasons } from '../../src/coach/reasons';
import { postMoveTemplate } from '../../src/coach/postMove';

function playAll(sans: string[]): PlayedMove[] {
  const c = new Chess();
  return sans.map((san) => {
    const fenBefore = c.fen();
    const color = c.turn();
    const m = c.move(san);
    return { san: m.san, uci: m.from + m.to + (m.promotion ?? ''), fenBefore, fenAfter: c.fen(), color };
  });
}

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
    expect(e.better).toBeUndefined();
    expect(JSON.stringify(e)).not.toContain('Bc4');
    expect(JSON.stringify(e)).not.toContain('c4');
    expect(e.lesson).toBe(`${THEME_LESSONS.hanging_piece.title}: ${THEME_LESSONS.hanging_piece.habit} ${THEME_WHY.hanging_piece}`);
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
    expect(e.whatHappened).toBe("After Ne5, your knight on e5 can be taken for free. They can play dxe5.");
  });

  it('a defended piece attacked by a cheaper one "can be won", never "free"', () => {
    // Nb5: the a4 pawn guards b5, but the c6 pawn can still take the knight.
    const move = mk('4k3/8/2p5/8/P7/2N5/8/4K3 w - - 0 1', 'c3b5');
    const e = explain(move, verdictFor('hanging_piece', 'e1e2', 'Ke2', ['cxb5', 'axb5']));
    expect(e.whatHappened).not.toMatch(/free/);
    expect(e.whatHappened).toBe(
      "After Nb5, your knight on b5 can be won: their pawn on c6 can take it, and a pawn is worth less than a knight. They can play cxb5.");
    expect(e.whatHappened).not.toContain('axb5');
  });

  it('ignored_threat starts with a capital letter', () => {
    // Black to move; the bishop on g5 already attacks the undefended knight on f6, and Kd8 does not help.
    const move = mk('4k3/8/5n2/6B1/8/8/8/4K3 b - - 1 1', 'e8d8');
    const e = explain(move, verdictFor('ignored_threat', 'f6d5', 'Nd5', ['Bxf6+']));
    expect(e.whatHappened).toBe("Your knight on f6 was already under attack and Kd8 did not save it. They can play Bxf6+.");
  });

  it('allowed_fork names the fork with "both" for exactly two targets', () => {
    // h3?? lets the knight jump to c2, checking the king and attacking the rook.
    const move = mk('7k/8/8/8/1n6/8/7P/R3K3 w - - 0 1', 'h2h3');
    const e = explain(move, verdictFor('allowed_fork', 'a1a4', 'Ra4', ['Nc2+']));
    expect(e.whatHappened).toBe('After h3, they can play Nc2+, and their knight on c2 attacks both your rook on a1 and your king on e1.');
  });

  it('shows only the opponent reply from the refutation, never the user follow-up moves', () => {
    // a3 in the start position; the engine line continues with White's own next move.
    const move = mk(new Chess().fen(), 'a2a3');
    const e = explain(move, verdictFor('other', 'e2e4', 'e4', ['e5', 'Nf3', 'Nc6']));
    expect(e.whatHappened).toBe("After a3, the engine's best answer for them is e5.");
    for (const s of [e.whatHappened, e.lesson ?? '']) {
      expect(s).not.toContain('Nf3');
      expect(s).not.toContain('Nc6');
    }
  });

  const reason = (move: PlayedMove, verdict: Verdict) =>
    betterReason({ verdict, move, factsAfter: positionFacts(move.fenAfter), themeCount: 0 });

  it('missed_fork: the reveal reason describes the fork the better move made, the card does not name it', () => {
    const move = mk('r3k3/7p/8/1N6/8/8/7P/7K w - - 0 1', 'h2h3');
    const verdict = verdictFor('missed_fork', 'b5c7', 'Nc7+', ['Kd7']);
    expect(reason(move, verdict)).toBe('Nc7+ would have attacked both their rook on a8 and their king on e8 at once.');
    expect(JSON.stringify(explain(move, verdict))).not.toContain('Nc7');
  });

  it('missed_mate: the reveal reason says checkmate, the card does not name the move', () => {
    const move = mk('6k1/5ppp/8/8/8/8/5PPP/3R2K1 w - - 0 1', 'h2h3');
    const verdict = verdictFor('missed_mate', 'd1d8', 'Rd8#', ['h6']);
    expect(reason(move, verdict)).toBe('Rd8# was checkmate.');
    expect(JSON.stringify(explain(move, verdict))).not.toContain('Rd8');
  });

  it('says what the reply does when the theme has no special wording', () => {
    // Qe3?? puts the queen where Bc5 attacks it.
    const move = mk('5b1k/8/8/8/8/8/8/2Q1K3 w - - 0 1', 'c1e3');
    const e = explain(move, verdictFor('other', 'c1c2', 'Qc2', ['Bc5']));
    expect(e.whatHappened).toBe('After Qe3, they can play Bc5. It attacks your queen on e3.');
  });

  it('a capture reply says what it takes', () => {
    const move = mk('5b1k/8/8/8/8/8/8/2Q1K3 w - - 0 1', 'c1a3');
    const e = explain(move, verdictFor('other', 'c1c2', 'Qc2', ['Bxa3']));
    expect(e.whatHappened).toBe('After Qa3, they can play Bxa3. It takes your queen on a3.');
  });

  it('the card never names the better move or its squares, for any theme', () => {
    const move = mk('4k3/8/3p4/8/8/5N2/8/4K3 w - - 0 1', 'f3e5');
    for (const theme of Object.keys(THEME_LESSONS) as Theme[]) {
      const e = explain(move, verdictFor(theme, 'e1e2', 'Ke2', ['dxe5']));
      expect(e.better, theme).toBeUndefined();
      expect(JSON.stringify(e), theme).not.toMatch(/Ke2|e2/);
    }
  });
});

describe('moveNote', () => {
  it('notes captures, checks and development truthfully', () => {
    const fen = '4k3/8/8/4n3/8/8/R3R3/4K3 w - - 0 1';
    expect(moveNote(fen, new Chess(fen).move('Rxe5+'))).toBe('captures the knight on e5');
    expect(moveNote(fen, new Chess(fen).move('Ra8+'))).toBe('gives check');
    const start = new Chess().fen();
    expect(moveNote(start, new Chess().move('Nf3'))).toBe('develops your knight');
  });
});

describe('THEME_WHY', () => {
  it('gives every theme a plain why with no squares, moves or banned words', () => {
    for (const theme of Object.keys(THEME_LESSONS) as Theme[]) {
      const why = THEME_WHY[theme];
      expect(why, theme).toMatch(/^[A-Z].*\.$/);
      expect(why, theme).not.toMatch(/\b[a-h][1-8]\b/);
      expect(findJargon(why), theme).toEqual([]);
    }
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

describe('no jargon in template text (sweep)', () => {
  const THEMES: Theme[] = ['hanging_piece', 'ignored_threat', 'allowed_fork', 'missed_fork', 'missed_pin', 'missed_mate',
    'allowed_mate', 'early_queen', 'undeveloped', 'king_safety', 'bad_trade', 'endgame_technique', 'other'];
  // Deterministic pseudo-random games, so the sweep covers openings, middlegames and endgames.
  function rng(seed: number) {
    let x = seed;
    return () => { x = (x * 1103515245 + 12345) % 2147483648; return x / 2147483648; };
  }
  it('post-move and mistake templates use no banned term across many positions', () => {
    const found: string[] = [];
    const starts: [string, 'opening' | 'middlegame' | 'endgame'][] = [
      [new Chess().fen(), 'opening'], [new Chess().fen(), 'opening'],
      ['r1bq1rk1/pp2bppp/2n1pn2/3p4/2PP4/2N1PN2/PP2BPPP/R2QKB1R w KQ - 0 9', 'middlegame'],
      ['8/5pk1/6p1/3r4/1p6/1P3PP1/5K1P/2R5 w - - 0 40', 'endgame'],
    ];
    for (const [seed, [startFen, startArea]] of starts.entries()) {
      const rand = rng(seed + 1);
      const c = new Chess(startFen);
      for (let ply = 0; ply < 24 && !c.isGameOver(); ply++) {
        const fen = c.fen();
        const moves = c.moves({ verbose: true });
        const m = moves[Math.floor(rand() * moves.length)];
        const best = moves[Math.floor(rand() * moves.length)];
        const area = startArea === 'opening' && ply >= 12 ? 'middlegame' as const : startArea;
        c.move(m);
        const uci = m.from + m.to + (m.promotion ?? '');
        const bestUci = best.from + best.to + (best.promotion ?? '');
        const after = c.fen();
        const reply = c.moves({ verbose: true })[0];
        const move: PlayedMove = { san: m.san, uci, fenBefore: fen, fenAfter: after, color: m.color };
        const factsAfter = positionFacts(after);
        const replyUci = reply ? [reply.from + reply.to + (reply.promotion ?? '')] : [];
        const reasons = deriveReasons(fen, uci, { book: null, area, line: [uci, ...replyUci] });
        const bestReasons = deriveReasons(fen, bestUci, { book: null, area });
        const texts: string[] = [];
        const base: Verdict = {
          flagged: false, severity: 'ok', cpLoss: 40, area, theme: 'other', recommendation: 'play_on',
          bestUci, bestSan: best.san, refutationSan: reply ? [reply.san] : [],
        };
        for (const kind of ['top', 'book', null] as const) {
          const t = postMoveTemplate({
            verdict: base, move, kind, bookIdea: null, lineName: null, factsAfter, reasons,
            bestReasons: kind === null ? bestReasons : null,
          });
          texts.push(t.summary, t.explanation.whatHappened, t.explanation.better ?? '');
        }
        // One theme per position, in turn: betterReason (the post_move fallback) is covered through it.
        const verdict: Verdict = { ...base, theme: THEMES[ply % THEMES.length], flagged: true, severity: 'blunder' };
        const e = mistakeTemplate({ verdict, move, factsAfter, themeCount: 2 });
        texts.push(e.whatHappened, e.lesson ?? '', betterReason({ verdict, move, factsAfter, themeCount: 2 }));
        for (const t of texts) if (findJargon(t).length > 0) found.push(t);
      }
    }
    expect(found).toEqual([]);
  }, 30000);
});
