import { describe, it, expect } from 'vitest';
import { Chess } from 'chess.js';
import { pins, positionFacts, principleViolations, uciLineToSan } from '../../src/coach/facts';
import type { PlayedMove } from '../../src/types';

const START = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';

function history(sans: string[]): PlayedMove[] {
  const c = new Chess();
  return sans.map((san) => {
    const fenBefore = c.fen();
    const color = c.turn();
    const m = c.move(san);
    return { san: m.san, uci: m.from + m.to + (m.promotion ?? ''), fenBefore, fenAfter: c.fen(), color };
  });
}

describe('positionFacts', () => {
  it('material at the start is 39 each', () => {
    expect(positionFacts(START).material).toEqual({ w: 39, b: 39 });
  });

  it('flags an undefended knight attacked by a bishop', () => {
    const f = positionFacts('4k3/8/5n2/6B1/8/8/8/4K3 w - - 0 1');
    expect(f.hanging).toContainEqual({ square: 'f6', piece: 'n', color: 'b' });
  });

  it('does not flag a defended knight attacked by an equal piece', () => {
    const f = positionFacts('4k3/4p3/5n2/6B1/8/8/8/4K3 w - - 0 1');
    expect(f.hanging.filter((p) => p.color === 'b')).toEqual([]);
  });

  it('flags a defended queen attacked by a pawn', () => {
    const f = positionFacts('3rk3/8/8/3q4/4P3/8/8/4K3 w - - 0 1');
    expect(f.hanging).toContainEqual({ square: 'd5', piece: 'q', color: 'b' });
  });

  it('never lists kings as hanging', () => {
    const f = positionFacts('4k3/8/8/8/8/8/4q3/4K3 w - - 0 1');
    expect(f.hanging.some((p) => p.piece === 'k')).toBe(false);
    expect(f.inCheck).toBe(true);
  });

  it('does not count a pinned piece as a capturer', () => {
    // Black knight on e7 pinned by Re1 to Ke8; it "attacks" Bc6 but cannot capture. Bc6 undefended.
    const f = positionFacts('4k3/4n3/2B5/8/8/8/8/4R1K1 b - - 0 1');
    expect(f.hanging.some((p) => p.square === 'c6')).toBe(false);
  });

  it('finds a knight fork of king and rook', () => {
    const f = positionFacts('r3k3/2N5/8/8/8/8/8/4K3 b - - 0 1');
    const fork = f.forks.find((x) => x.attacker.square === 'c7');
    expect(fork).toBeDefined();
    const squares = fork!.targets.map((t) => t.square).sort();
    expect(squares).toEqual(['a8', 'e8']);
    expect(f.inCheck).toBe(true);
  });

  it('does not report a fork on pawns only', () => {
    const f = positionFacts('4k3/8/1p1p4/8/2N5/8/8/4K3 w - - 0 1');
    expect(f.forks).toEqual([]);
  });

  it('attackedBy lists enemy pieces the moved piece now attacks', () => {
    const f = positionFacts('r3k3/2N5/8/8/8/8/8/4K3 b - - 0 1');
    const sq = f.attackedBy('e5c7').map((p) => p.square).sort();
    expect(sq).toEqual(['a8', 'e8']);
  });
});

describe('uciLineToSan', () => {
  it('converts a line', () => {
    expect(uciLineToSan(START, ['e2e4', 'e7e5'])).toEqual(['e4', 'e5']);
  });
  it('stops at an illegal move', () => {
    expect(uciLineToSan(START, ['e2e4', 'e2e4', 'e7e5'])).toEqual(['e4']);
  });
});

describe('principleViolations', () => {
  it('flags an early queen', () => {
    const h = history(['e4', 'e5', 'Qh5', 'Nc6', 'Qxf7+']);
    expect(principleViolations(h, 'w')).toContain('early_queen');
    expect(principleViolations(h, 'b')).not.toContain('early_queen');
  });

  it('does not flag a queen move once minors are developed', () => {
    const h = history(['e4', 'e5', 'Nf3', 'Nc6', 'Bc4', 'Bc5', 'Nc3', 'Nf6', 'Qe2']);
    expect(principleViolations(h, 'w')).not.toContain('early_queen');
  });

  it('flags pawn_moves for four pawn moves in the first six', () => {
    const h = history(['a3', 'a6', 'b3', 'b6', 'c3', 'c6', 'd3', 'd6']);
    expect(principleViolations(h, 'w')).toContain('pawn_moves');
  });

  it('flags undeveloped pieces at move 10', () => {
    const w = ['a3', 'b3', 'c3', 'd3', 'e3', 'f3', 'g3', 'h3', 'a4', 'b4'];
    const b = ['a6', 'b6', 'c6', 'd6', 'e6', 'f6', 'g6', 'h6', 'a5', 'b5'];
    const sans: string[] = [];
    for (let i = 0; i < 10; i++) sans.push(w[i], b[i]);
    // f3/f6 leave knights home; ignore illegal ones
    const c = new Chess();
    const ok: string[] = [];
    for (const s of sans) { try { c.move(s); ok.push(s); } catch { break; } }
    const h = history(ok);
    expect(h.length).toBeGreaterThanOrEqual(19);
    expect(principleViolations(h, 'w')).toContain('undeveloped');
  });

  it('is clean for a normal Italian opening', () => {
    const h = history(['e4', 'e5', 'Nf3', 'Nc6', 'Bc4', 'Bc5', 'O-O', 'Nf6']);
    expect(principleViolations(h, 'w')).toEqual([]);
    expect(principleViolations(h, 'b')).toEqual([]);
  });

  it('flags king_safety at move 10 with no pawns on the d- or e-file and no castling', () => {
    // Hand-built history: ten white moves, king never castled, d and e pawns gone.
    const fen = '4k3/8/8/8/8/8/PPP2PPP/R3K2R w KQ - 0 10';
    const h: PlayedMove[] = [];
    for (let i = 0; i < 10; i++) {
      h.push({ san: 'Ra2', uci: 'a1a2', fenBefore: fen, fenAfter: fen, color: 'w' });
      h.push({ san: 'Ke7', uci: 'e8e7', fenBefore: fen, fenAfter: fen, color: 'b' });
    }
    expect(principleViolations(h, 'w')).toContain('king_safety');
  });

  it('does not flag king_safety once castled', () => {
    const fen = '4k3/8/8/8/8/8/PPP2PPP/R4RK1 w - - 0 10';
    const h: PlayedMove[] = [{ san: 'O-O', uci: 'e1g1', fenBefore: fen, fenAfter: fen, color: 'w' }];
    for (let i = 0; i < 9; i++) h.push({ san: 'Rb1', uci: 'a1b1', fenBefore: fen, fenAfter: fen, color: 'w' });
    expect(principleViolations(h, 'w')).not.toContain('king_safety');
  });
});

describe('pins', () => {
  it('finds an absolute pin of a knight to the king', () => {
    expect(pins('4k3/8/2n5/1B6/8/8/8/4K3 b - - 0 1')).toEqual([
      {
        pinner: { square: 'b5', piece: 'b', color: 'w' },
        pinned: { square: 'c6', piece: 'n', color: 'b' },
        behind: { square: 'e8', piece: 'k', color: 'b' },
      },
    ]);
  });

  it('finds a relative pin of a knight to the queen', () => {
    const p = pins('3qk3/8/5n2/6B1/8/8/8/4K3 b - - 0 1');
    expect(p.map((x) => [x.pinner.square, x.pinned.square, x.behind.square])).toEqual([['g5', 'f6', 'd8']]);
  });

  it('ignores lower-value pieces behind, own pieces, and pieces of the pinner colour in between', () => {
    expect(pins('4k3/8/8/1p6/8/3q4/8/1B2K3 w - - 0 1')).toEqual([]); // queen in front of pawn: not a pin
    expect(pins('4k3/8/2N5/1B6/8/8/8/4K3 b - - 0 1')).toEqual([]); // own knight in the way
    expect(pins('4k3/8/8/8/8/8/8/R3K3 w - - 0 1')).toEqual([]); // nothing on the ray
  });
});
