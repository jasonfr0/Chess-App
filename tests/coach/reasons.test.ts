import { describe, it, expect } from 'vitest';
import { Chess } from 'chess.js';
import data from '../../src/openings/repertoire.json';
import { lookup, type RepertoireNode } from '../../src/openings/repertoire';
import { deriveReasons, reasonText, FUNDAMENTAL_WHY, type Fundamental } from '../../src/coach/reasons';
import { findJargon } from '../../src/coach/jargon';
import { areaOf } from '../../src/coach/classify';
import type { Color } from '../../src/types';

const START = new Chess().fen();
const fenOf = (sans: string[], start?: string) => {
  const c = new Chess(start);
  for (const s of sans) c.move(s);
  return c.fen();
};
const sentences = (t: string | null) => (t ?? '').split(/(?<=[.!?])\s+/).filter(Boolean).length;
const noBook = { book: null, area: 'opening' as const };

describe('FUNDAMENTAL_WHY', () => {
  it('is one plain sentence per fundamental, with no jargon', () => {
    for (const [k, s] of Object.entries(FUNDAMENTAL_WHY)) {
      expect(sentences(s), k).toBe(1);
      expect(findJargon(s), k).toEqual([]);
    }
  });
});

describe('deriveReasons', () => {
  it('Nf3 from the start develops and fights for the centre', () => {
    const r = deriveReasons(START, 'g1f3', { book: lookup('w', ['Nf3']) ?? null, area: 'opening' });
    expect(r.fundamentals).toContain('develops');
    expect(r.fundamentals).toContain('centre');
    expect(r.fundamentals).not.toContain('defends');
    expect(r.fundamentals).not.toContain('wins_material');
    const t = reasonText('Nf3', r);
    expect(t).toContain('knight');
    expect(sentences(t)).toBeLessThanOrEqual(3);
  });

  it('names the opening principle when out of book in the opening', () => {
    const r = deriveReasons(START, 'g1f3', noBook);
    expect(r.opening).toBeNull();
    expect(r.principle).toMatch(/knights and bishops/);
    expect(deriveReasons(START, 'g1f3', { book: null, area: 'middlegame' }).principle).toBeNull();
  });

  it('names an opening principle only when it is the main reason', () => {
    const r = deriveReasons(fenOf(['e4', 'e5', 'Bc4', 'Nc6']), 'd1h5', noBook);
    expect(r.fundamentals[0]).toBe('check_threat');
    expect(r.principle).toBeNull();
  });

  it('castling is king safety', () => {
    const fen = fenOf(['e4', 'e5', 'Nf3', 'Nc6', 'Bc4', 'Bc5']);
    const r = deriveReasons(fen, 'e1g1', noBook);
    expect(r.fundamentals).toContain('king_safety');
    expect(r.fundamentals).not.toContain('develops');
  });

  it('defends a piece that was attacked', () => {
    // 1.e4 e5 2.Nf3 Nf6: their knight attacks e4; 3.Nc3 defends it.
    const r = deriveReasons(fenOf(['e4', 'e5', 'Nf3', 'Nf6']), 'b1c3', noBook);
    expect(r.fundamentals).toContain('defends');
    expect(r.effect).toContain('defends your pawn on e4');
  });

  it('does not claim defends when nothing was attacked', () => {
    const r = deriveReasons(fenOf(['e4', 'e5']), 'b1c3', noBook);
    expect(r.fundamentals).not.toContain('defends');
    expect(r.effect ?? '').not.toContain('defends');
  });

  it('does not claim defends for a piece it already guarded', () => {
    // 1.e4 e5 2.Nf3 Nf6 3.Qe2 Nc6: the queen already guards e4, so 4.Qe3 is not "defends".
    const fen = fenOf(['e4', 'e5', 'Nf3', 'Nf6', 'Qe2', 'Nc6']);
    expect(deriveReasons(fen, 'e2e3', noBook).fundamentals).not.toContain('defends');
    expect(deriveReasons(fenOf(['e4', 'e5', 'Nf3', 'Nf6']), 'd1e2', noBook).fundamentals).toContain('defends');
  });

  it('a capture that wins a piece per the line is wins_material', () => {
    // 1.e4 e5 2.Nf3 Qg5?? 3.Nxg5 — the queen is free.
    const fen = fenOf(['e4', 'e5', 'Nf3', 'Qg5']);
    const r = deriveReasons(fen, 'f3g5', { book: null, area: 'opening', line: ['f3g5', 'b8c6', 'd2d4'] });
    expect(r.fundamentals).toContain('wins_material');
    expect(r.effect).toContain('queen on g5');
    const t = reasonText('Nxg5', r);
    expect(sentences(t)).toBeLessThanOrEqual(3);
    expect(t).toContain(FUNDAMENTAL_WHY.wins_material);
  });

  it('does not claim wins_material without a line, or when the line loses it back', () => {
    const fen = fenOf(['e4', 'e5', 'Nf3', 'Qg5']);
    expect(deriveReasons(fen, 'f3g5', noBook).fundamentals).not.toContain('wins_material');
    expect(deriveReasons(fen, 'f3g5', { ...noBook, line: ['f3g5'] }).fundamentals).not.toContain('wins_material');
    const fen2 = fenOf(['e4', 'e5', 'Nf3', 'Nc6', 'Bc4', 'Nf6']);
    const r = deriveReasons(fen2, 'c4f7', { ...noBook, line: ['c4f7', 'e8f7', 'f3g5', 'f7g8'] });
    expect(r.fundamentals).not.toContain('wins_material');
    expect(r.fundamentals).toContain('check_threat');
  });

  it('a quiet move never claims material won later in the line (the user\'s own next move)', () => {
    // White knight forks king and rook: the rook is won only by the user's next move, so no "wins".
    const fen = 'r3k3/8/8/8/8/8/8/1N2K3 w - - 0 30';
    const r = deriveReasons(fen, 'b1c3', { book: null, area: 'endgame', line: ['b1c3'] });
    expect(r.fundamentals).not.toContain('wins_material');
    const fen2 = 'r3k3/8/8/1N6/8/8/8/4K3 w - - 0 30';
    const r2 = deriveReasons(fen2, 'b5c7', { book: null, area: 'endgame', line: ['b5c7', 'e8d7', 'c7a8', 'd7c8'] });
    expect(r2.fundamentals).toContain('check_threat');
    expect(r2.fundamentals).not.toContain('wins_material');
    expect(r2.effect).not.toMatch(/wins/);
  });

  it('1.e4 with the line d5 exd5: no "wins" for the quiet pawn move', () => {
    const r = deriveReasons(START, 'e2e4', { book: null, area: 'opening', line: ['e2e4', 'd7d5', 'e4d5', 'g8f6', 'b1c3'] });
    expect(r.fundamentals).not.toContain('wins_material');
    expect(r.effect ?? '').not.toMatch(/wins|ahead/);
    expect(reasonText('e4', r) ?? '').not.toMatch(/wins|ahead/);
  });

  it('does not repeat an opening rule the "why" sentence already states', () => {
    for (const [uci, why] of [['g1f3', FUNDAMENTAL_WHY.develops], ['e2e4', FUNDAMENTAL_WHY.centre]] as const) {
      const t = reasonText('x', deriveReasons(START, uci, noBook))!;
      expect(t).toContain(why);
      expect(t).not.toMatch(/rule:/);
      expect(sentences(t)).toBeLessThanOrEqual(3);
    }
    const castle = fenOf(['e4', 'e5', 'Nf3', 'Nc6', 'Bc4', 'Bc5']);
    const t = reasonText('O-O', deriveReasons(castle, 'e1g1', noBook))!;
    expect(t).toContain(FUNDAMENTAL_WHY.king_safety);
    expect(t).not.toMatch(/rule:/);
  });

  it('threatens checkmate (Qh5 eyeing f7)', () => {
    const r = deriveReasons(fenOf(['e4', 'e5', 'Bc4', 'Nc6']), 'd1h5', noBook);
    expect(r.fundamentals).toContain('check_threat');
    expect(r.effect).toContain('threatens checkmate');
  });

  it('trades when ahead', () => {
    const fen = '3rk3/8/8/8/8/8/8/R2RK3 w - - 0 40';
    const r = deriveReasons(fen, 'd1d8', { book: null, area: 'endgame', line: ['d1d8', 'e8d8', 'a1a7'] });
    expect(r.fundamentals).toContain('trade_when_ahead');
    const even = '3rk3/8/8/8/8/8/8/3RK3 w - - 0 40';
    const r2 = deriveReasons(even, 'd1d8', { book: null, area: 'endgame', line: ['d1d8', 'e8d8', 'e1e2'] });
    expect(r2.fundamentals).not.toContain('trade_when_ahead');
  });

  it('passed pawn only when no enemy pawn can block or take it', () => {
    const r = deriveReasons('8/8/4k3/8/8/8/P7/4K3 w - - 0 50', 'a2a4', { book: null, area: 'endgame' });
    expect(r.fundamentals).toContain('passed_pawn');
    const r2 = deriveReasons('8/1p6/4k3/8/8/8/P7/4K3 w - - 0 50', 'a2a4', { book: null, area: 'endgame' });
    expect(r2.fundamentals).not.toContain('passed_pawn');
  });

  it('king activity only in the endgame, towards the middle', () => {
    const fen = '8/8/4k3/8/8/8/P7/4K3 w - - 0 50';
    expect(deriveReasons(fen, 'e1e2', { book: null, area: 'endgame' }).fundamentals).toContain('king_activity');
    expect(deriveReasons(fen, 'e1f1', { book: null, area: 'endgame' }).fundamentals).not.toContain('king_activity');
    expect(deriveReasons(fen, 'e1e2', { book: null, area: 'middlegame' }).fundamentals).not.toContain('king_activity');
  });

  it('attacks only what could be won: undefended, or worth more than the attacker', () => {
    // 1.e4 e5 2.Qh5: e5 is undefended; f7 (king) and h7 (rook) are guarded pawns.
    const r = deriveReasons(fenOf(['e4', 'e5']), 'd1h5', noBook);
    expect(r.fundamentals).toContain('attacks');
    expect(r.effect).toContain('their pawn on e5');
    expect(r.effect).not.toMatch(/f7|h7/);
    // Rd7 hits f7, which the king guards: nothing to win.
    const rd7 = deriveReasons('6k1/5p2/8/8/8/8/8/3R2K1 w - - 0 40', 'd1d7', { book: null, area: 'endgame' });
    expect(rd7.fundamentals).not.toContain('attacks');
    // 3.Bb5 hits a guarded knight of equal value: not counted.
    expect(deriveReasons(fenOf(['e4', 'e5', 'Nf3', 'Nc6']), 'f1b5', noBook).fundamentals).not.toContain('attacks');
    // A pawn hitting a guarded knight still counts (the knight is worth more).
    const pawn = deriveReasons(fenOf(['e4', 'e5', 'Nf3', 'Nc6', 'Bb5']), 'a7a6', noBook);
    expect(pawn.fundamentals).toContain('attacks');
    expect(pawn.effect).toContain('their bishop on b5');
  });

  it('gives no opening centre credit to early queen moves', () => {
    const r = deriveReasons(fenOf(['e4', 'e5']), 'd1h5', noBook);
    expect(r.fundamentals).not.toContain('centre');
    expect(r.principle).toBeNull();
    expect(reasonText('Qh5', r)).not.toContain('key opening rule');
  });

  it('checkmate says so, with no rule sentence', () => {
    const fen = fenOf(['e4', 'e5', 'Bc4', 'Nc6', 'Qh5', 'Nf6']);
    expect(reasonText('Qxf7#', deriveReasons(fen, 'h5f7', noBook))).toBe('Qxf7# is checkmate. That ends the game: you win.');
  });

  it('castling effect is just "castles"', () => {
    const r = deriveReasons(fenOf(['e4', 'e5', 'Nf3', 'Nc6', 'Bc4', 'Bc5']), 'e1g1', noBook);
    expect(r.effect).toBe('castles');
  });

  it('a capture that nets less than the piece "comes out ahead"', () => {
    const r = deriveReasons('4k3/3q4/8/8/8/8/8/3RK3 w - - 0 40', 'd1d7', { book: null, area: 'endgame', line: ['d1d7', 'e8d7', 'e1e2'] });
    expect(r.effect).toBe('captures the queen on d7 and comes out more than a piece ahead');
  });

  it('deals with a threat by moving the attacked piece', () => {
    // 1.e4 e5 2.Nf3 Nc6 3.Bb5 a6 4.Ba4: the bishop was hit by a pawn and steps away.
    const r = deriveReasons(fenOf(['e4', 'e5', 'Nf3', 'Nc6', 'Bb5', 'a6']), 'b5a4', noBook);
    expect(r.effect).toContain('deals with the threat to your bishop on b5');
    expect(reasonText('Ba4', r)).not.toBeNull();
  });

  it('gives the king a safe square against a back-rank threat, only when proven', () => {
    const r = deriveReasons('3r2k1/5ppp/8/2b5/8/8/6PP/7K w - - 0 30', 'h2h3', { book: null, area: 'middlegame' });
    expect(r.effect).toBe('gives your king a safe square');
    const calm = deriveReasons('6k1/5ppp/8/2b5/8/8/6PP/7K w - - 0 30', 'h2h3', { book: null, area: 'middlegame' });
    expect(calm.effect ?? '').not.toContain('safe square');
  });

  it('promotion says why a new queen matters', () => {
    const r = deriveReasons('8/P3k3/8/8/8/8/8/4K3 w - - 0 50', 'a7a8q', { book: null, area: 'endgame' });
    const t = reasonText('a8=Q', r)!;
    expect(t).toContain('a8=Q turns your pawn into a queen.');
    expect(t).toContain('A new queen is the strongest piece on the board.');
    expect(sentences(t)).toBeLessThanOrEqual(3);
  });

  it('never claims a saved piece when the move gives check (regression)', () => {
    const fen = '6k1/5pp1/3p3p/4N3/8/8/5PPP/R5K1 w - - 0 30';
    expect(deriveReasons(fen, 'a1a8', { book: null, area: 'middlegame' }).effect ?? '').not.toContain('deals with the threat');
    const withLine = deriveReasons(fen, 'a1a8', { book: null, area: 'middlegame', line: ['a1a8', 'g8h7', 'a8a7'] });
    expect(withLine.effect ?? '').not.toContain('deals with the threat');
  });

  it('no safe-square claim for ordinary pawn moves (regression)', () => {
    const fen = 'rnbqkbnr/1ppppppp/8/8/8/8/1PPPPPPP/RNBQKBNR w KQkq - 0 3';
    for (const uci of ['d2d4', 'e2e4']) {
      expect(deriveReasons(fen, uci, noBook).effect ?? '', uci).not.toContain('safe square');
    }
  });

  it('a capture that promotes says so', () => {
    const r = deriveReasons('r3k3/1P6/8/8/8/8/8/4K3 w - - 0 40', 'b7a8q', { book: null, area: 'endgame', line: ['b7a8q', 'e8d7', 'a8a7'] });
    expect(r.effect).toContain('captures the rook on a8 and becomes a queen');
  });

  it('no attack claim from a piece that can be taken for free (regression)', () => {
    const r = deriveReasons('7r/P3k3/8/8/8/8/8/4K3 w - - 0 50', 'a7a8q', { book: null, area: 'endgame' });
    expect(r.fundamentals).not.toContain('attacks');
    expect(r.effect ?? '').not.toContain('attacks their rook');
  });

  it('develops only in the opening', () => {
    const fen = fenOf(['e4', 'e5', 'Nf3', 'Nc6']);
    expect(deriveReasons(fen, 'b1c3', { book: null, area: 'middlegame' }).fundamentals).not.toContain('develops');
    expect(deriveReasons(fen, 'b1c3', noBook).fundamentals).toContain('develops');
  });

  it('returns null when there is no checked fact to say', () => {
    expect(reasonText('h3', deriveReasons('8/6p1/4k3/8/8/8/7P/4K3 w - - 0 50', 'h2h3', { book: null, area: 'endgame' }))).toBeNull();
    expect(reasonText('a3', deriveReasons(START, 'a2a3', noBook))).toBeNull();
  });

  it('in the Italian book after 3.Bc4 names the Italian Game', () => {
    const sans = ['e4', 'e5', 'Nf3', 'Nc6', 'Bc4'];
    const r = deriveReasons(fenOf(sans.slice(0, 4)), 'f1c4', { book: lookup('w', sans), area: 'opening' });
    expect(r.opening?.name).toContain('Italian');
    expect(r.principle).toBeNull();
    const t = reasonText('Bc4', r);
    expect(t).toContain('Italian');
    expect(sentences(t)).toBeLessThanOrEqual(3);
  });

  it('a book move keeps its opening idea as the third sentence (no fundamental why)', () => {
    const sans = ['e4', 'e5', 'Nf3', 'Nc6', 'Bc4'];
    const r = deriveReasons(fenOf(sans.slice(0, 4)), 'f1c4', { book: lookup('w', sans), area: 'opening' });
    const t = reasonText('Bc4', r)!;
    expect(t).toContain('f7');
    expect(t).not.toContain(FUNDAMENTAL_WHY[r.fundamentals[0]]);
    expect(sentences(t)).toBeLessThanOrEqual(3);
    const black = deriveReasons(fenOf(['e4']), 'e7e5', { book: lookup('b', ['e4', 'e5']), area: 'opening' });
    expect(black.opening).not.toBeNull();
    const tb = reasonText('e5', black)!;
    expect(tb).toContain('opens lines for your queen');
    expect(tb).not.toContain('Next,');
    expect(sentences(tb)).toBeLessThanOrEqual(3);
  });

  it('never joins two parts with a comma; the why matches the part shown first', () => {
    const fen = '7k/pp4pp/8/1r6/b7/8/PP2N1PP/6K1 w - - 0 20';
    const r = deriveReasons(fen, 'e2c3', { book: null, area: 'middlegame' });
    expect(r.effect).toBe('attacks their bishop on a4 and their rook on b5');
    expect(r.fundamentals[0]).toBe('attacks');
    const t = reasonText('Nc3', r)!;
    expect(t.split('. ')[0]).not.toContain(',');
    expect(t).not.toContain('aims at');
    expect(t).toContain(FUNDAMENTAL_WHY.attacks);
    expect(t).not.toContain(FUNDAMENTAL_WHY.centre);
    expect(sentences(t)).toBeLessThanOrEqual(3);
  });

  it('puts a second part in an "It also" sentence when it still fits in 3 sentences', () => {
    const r = deriveReasons(START, 'g1f3', noBook);
    expect(r.effect).toBe('brings your knight out');
    expect(r.also).toBe('aims at the middle squares d4 and e5');
    expect(reasonText('Nf3', r)).toBe(
      `Nf3 brings your knight out. It also aims at the middle squares d4 and e5. ${FUNDAMENTAL_WHY.develops}`,
    );
  });

  it('reasonText has no separate opening-principle sentence', () => {
    const t = reasonText('Nc3', { opening: null, principle: 'some rule', fundamentals: ['attacks'], effect: 'attacks their pawn on e5' });
    expect(t).not.toContain('some rule');
    expect(t).toContain('It follows a simple rule: put pressure on their pieces.');
  });

  it('ignores a book hit for a different move', () => {
    const r = deriveReasons(START, 'g1f3', { book: lookup('w', ['e4']), area: 'opening' });
    expect(r.opening).toBeNull();
  });

  it('an illegal move gives empty reasons', () => {
    const r = deriveReasons(START, 'e1e5', noBook);
    expect(r).toEqual({ opening: null, principle: null, fundamentals: [], effect: null });
  });
});

describe('reasonText sweep', () => {
  /** No jargon, at most 3 sentences, and no move named but the given one. */
  const check = (san: string, text: string | null, label: string) => {
    expect(text, label).not.toBeNull();
    if (text === null) return;
    expect(findJargon(text), label).toEqual([]);
    expect((text.split('.')[0].match(/ and /g) ?? []).length, label).toBeLessThanOrEqual(1);
    expect(sentences(text), label).toBeLessThanOrEqual(3);
    // Every SAN-looking token other than the given san is absent.
    const others = (text.match(/\b(?:[KQRBN][a-h]?[1-8]?x?[a-h][1-8]|[a-h]x[a-h][1-8]|O-O(?:-O)?)\b/g) ?? []).filter((t) => !san.startsWith(t));
    expect(others, label).toEqual([]);
  };

  const trees: Record<Color, RepertoireNode[]> = { w: data.white, b: data.black };
  for (const color of ['w', 'b'] as const) {
    it(`every ${color} repertoire user move`, () => {
      let count = 0;
      const visit = (nodes: RepertoireNode[], path: string[]) => {
        for (const node of nodes) {
          const here = [...path, node.san];
          const userMove = (here.length % 2 === 1) === (color === 'w');
          if (userMove) {
            const c = new Chess(fenOf(path));
            const fen = c.fen();
            const m = c.move(node.san);
            const uci = m.from + m.to + (m.promotion ?? '');
            const r = deriveReasons(fen, uci, { book: lookup(color, here), area: 'opening' });
            expect(r.opening, here.join(' ')).not.toBeNull();
            check(m.san, reasonText(m.san, r), here.join(' '));
            count++;
          }
          visit(node.children, here);
        }
      };
      visit(trees[color], []);
      expect(count).toBeGreaterThan(5);
    });
  }

  const fixtures: { sans: string[]; start?: string; line: string[] }[] = [
    { sans: ['e4', 'd5'], line: ['e4d5', 'd8d5', 'b1c3'] },
    { sans: ['e4', 'e5', 'Nf3', 'Nc6', 'Bc4', 'Nd4'], line: ['f3d4', 'e5d4', 'c2c3'] },
    { sans: ['e4', 'e5', 'Nf3', 'd6', 'd4', 'Bg4'], line: ['d4e5', 'g4f3', 'd1f3', 'd6e5', 'f1c4'] },
    { sans: ['d4', 'e5'], line: ['d4e5', 'b8c6', 'g1f3'] },
    { sans: ['e4', 'e5', 'Qh5', 'Nc6', 'Bc4', 'Nf6'], line: ['h5f7'] },
    { sans: ['e4', 'e5', 'Nf3', 'f6', 'Nxe5', 'fxe5', 'Qh5+', 'Ke7'], line: ['h5e5', 'e7f7', 'f1c4'] },
    { sans: ['Bd4'], start: '4k3/8/8/4b3/8/8/8/3RK3 b - - 0 30', line: ['d1d4', 'e8e7', 'e1e2'] },
    { sans: ['Ke8'], start: '3k4/4p3/3p4/8/8/8/8/3QK3 b - - 0 30', line: ['d1d6', 'e7d6', 'e1e2'] },
    { sans: ['e4', 'e5', 'Nf3', 'Nc6', 'Bb5', 'a6'], line: ['b5c6', 'd7c6', 'e1g1'] },
    { sans: ['Kd8'], start: 'r3k3/1P6/8/8/8/8/8/4K3 b - - 0 40', line: ['b7a8q', 'd8c7', 'a8a7'] },
    { sans: [], start: '8/8/4k3/8/8/8/P7/4K3 w - - 0 50', line: ['e1e2', 'e6d5', 'a2a4'] },
    { sans: [], start: '8/8/4k3/8/8/8/P7/4K3 w - - 0 50', line: ['a2a4', 'e6d5', 'a4a5'] },
    { sans: [], start: '3rk3/8/8/8/8/8/8/R2RK3 w - - 0 40', line: ['d1d8', 'e8d8', 'a1a7'] },
    { sans: ['e4', 'e5', 'Nf3', 'Nf6'], line: ['b1c3', 'f8b4'] },
    { sans: ['e4', 'e5', 'Nf3', 'Nc6', 'Bc4', 'Bc5'], line: ['e1g1', 'g8f6'] },
    { sans: ['e4', 'e5'], line: ['d1h5', 'b8c6'] },
    { sans: [], start: '3r2k1/5ppp/8/2b5/8/8/6PP/7K w - - 0 30', line: ['h2h3', 'g8f8'] },
  ];
  it.each(fixtures.map((f) => [`${f.sans.join(' ')} ${f.line[0]}`, f] as const))('engine line %s', (_l, f) => {
    const fen = fenOf(f.sans, f.start);
    const ply = f.start ? 40 : f.sans.length;
    const area = areaOf(fen, ply, false);
    const r = deriveReasons(fen, f.line[0], { book: null, area, line: f.line });
    const m = new Chess(fen).move({ from: f.line[0].slice(0, 2), to: f.line[0].slice(2, 4), promotion: f.line[0][4] });
    const text = reasonText(m.san, r);
    check(m.san, text, f.line[0]);
    expect(text?.startsWith(m.san)).toBe(true);
  });

  it('the fixtures cover every fundamental', () => {
    const seen = new Set<Fundamental>();
    for (const f of fixtures) {
      const fen = fenOf(f.sans, f.start);
      const area = areaOf(fen, f.start ? 40 : f.sans.length, false);
      deriveReasons(fen, f.line[0], { book: null, area, line: f.line }).fundamentals.forEach((x) => seen.add(x));
    }
    expect([...seen].sort()).toEqual(Object.keys(FUNDAMENTAL_WHY).sort());
  });
});
