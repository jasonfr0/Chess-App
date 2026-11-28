import { describe, it, expect } from 'vitest';
import { Chess } from 'chess.js';
import { teachOptions, previewLine, NO_REASON, MAX_OPTIONS, PREVIEW_PLIES } from '../../src/teach/options';
import { bookReplies } from '../../src/openings/repertoire';
import { deriveReasons, reasonText } from '../../src/coach/reasons';
import type { Analysis, EngineLine } from '../../src/types';

const START = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
const analysis = (fen: string, lines: EngineLine[]): Analysis => ({ fen, depth: 14, lines });

describe('teachOptions', () => {
  it('in the repertoire, the options are the book moves, main line first', () => {
    const r = teachOptions({ fen: START, userColor: 'w', sanHistory: [], area: 'opening', analysis: null });
    const nodes = bookReplies('w', []);
    const main = nodes.find((n) => n.main) ?? nodes[0];
    expect(r.inBook).toBe(true);
    expect(r.options[0].san).toBe(main.san);
    expect(r.options.length).toBeLessThanOrEqual(MAX_OPTIONS);
    for (const o of r.options) expect(o.reason.length).toBeGreaterThan(0);
    expect(r.bestReasons).not.toBeNull();
    // With no engine line, Watch follows the repertoire's continuation.
    expect(r.options[0].watch?.[0].uci).toBe('e2e4');
  });

  it("the engine's favourite is not added in book", () => {
    const r = teachOptions({
      fen: START, userColor: 'w', sanHistory: [], area: 'opening',
      analysis: analysis(START, [{ uci: ['a2a3', 'e7e5'], cp: 40, mate: null }, { uci: ['e2e4', 'e7e5', 'g1f3'], cp: 30, mate: null }]),
    });
    expect(r.inBook).toBe(true);
    expect(r.options.some((o) => o.uci === 'a2a3')).toBe(false);
    expect(r.options[0].watch?.map((p) => p.uci)).toEqual(['e2e4', 'e7e5', 'g1f3']);
  });

  it('a forced mate only pairs with forced mates', () => {
    const fen = 'r1bqkbnr/pppp1ppp/2n5/4p3/2B1P3/5Q2/PPPP1PPP/RNB1K1NR w KQkq - 0 1';
    const r = teachOptions({
      fen, userColor: 'w', sanHistory: ['h3', 'h6'], area: 'opening',
      analysis: analysis(fen, [{ uci: ['f3f7'], cp: null, mate: 1 }, { uci: ['d2d3'], cp: 300, mate: null }]),
    });
    expect(r.inBook).toBe(false);
    expect(r.options.map((o) => o.uci)).toEqual(['f3f7']);
    expect(r.bestReasons?.checkmate).toBe(true);
  });

  it('drops lines more than 50 worse', () => {
    const fen = 'r1bqkbnr/pppp1ppp/2n5/4p3/4P3/5N2/PPPP1PPP/RNBQKB1R w KQkq - 0 1';
    // Precondition: the dropped move has a checked reason, so only the margin can drop it.
    expect(reasonText('Bc4', deriveReasons(fen, 'f1c4', { book: null, area: 'middlegame', line: ['f1c4'] }))).not.toBeNull();
    const r = teachOptions({
      fen, userColor: 'w', sanHistory: ['h3'], area: 'middlegame',
      analysis: analysis(fen, [
        { uci: ['d2d4', 'e5d4'], cp: 80, mate: null },
        { uci: ['b1c3', 'g8f6'], cp: 40, mate: null },
        { uci: ['f1c4', 'g8f6'], cp: 20, mate: null },
      ]),
    });
    expect(r.inBook).toBe(false);
    expect(r.options.map((o) => o.uci)).toEqual(['d2d4', 'b1c3']);
    expect(r.options[0].watch?.length).toBe(2);
  });

  it('one analysed line gives one option', () => {
    const fen = 'r1bqkbnr/pppp1ppp/2n5/4p3/4P3/5N2/PPPP1PPP/RNBQKB1R w KQkq - 0 1';
    const r = teachOptions({
      fen, userColor: 'w', sanHistory: ['h3'], area: 'middlegame',
      analysis: analysis(fen, [{ uci: ['d2d4', 'e5d4'], cp: 80, mate: null }, { uci: ['d2d4', 'c6d4'], cp: 75, mate: null }]),
    });
    expect(r.options).toHaveLength(1);
  });

  it('the best move with no checked reason gets the honest line', () => {
    const fen = '4k3/8/8/8/8/8/P7/4K3 w - - 0 1';
    expect(reasonText('Kf1', deriveReasons(fen, 'e1f1', { book: null, area: 'endgame', line: ['e1f1'] }))).toBeNull();
    const r = teachOptions({
      fen, userColor: 'w', sanHistory: ['h3'], area: 'endgame',
      analysis: analysis(fen, [{ uci: ['e1f1'], cp: 0, mate: null }]),
    });
    expect(r.options).toHaveLength(1);
    expect(r.options[0].reason).toBe(NO_REASON);
    expect(r.bestReasons).not.toBeNull();
  });

  it('a non-best move with no checked reason is dropped', () => {
    const fen = '4k3/8/8/8/8/8/P7/4K3 w - - 0 1';
    expect(reasonText('Kf1', deriveReasons(fen, 'e1f1', { book: null, area: 'endgame', line: ['e1f1'] }))).toBeNull();
    expect(reasonText('a4', deriveReasons(fen, 'a2a4', { book: null, area: 'endgame', line: ['a2a4'] }))).not.toBeNull();
    const r = teachOptions({
      fen, userColor: 'w', sanHistory: ['h3'], area: 'endgame',
      analysis: analysis(fen, [{ uci: ['a2a4'], cp: 500, mate: null }, { uci: ['e1f1'], cp: 490, mate: null }]),
    });
    expect(r.options.map((o) => o.uci)).toEqual(['a2a4']);
  });

  it('no analysis out of book gives no options', () => {
    const fen = 'r1bqkbnr/pppp1ppp/2n5/4p3/4P3/5N2/PPPP1PPP/RNBQKB1R w KQkq - 0 1';
    const r = teachOptions({ fen, userColor: 'w', sanHistory: ['h3'], area: 'middlegame', analysis: null });
    expect(r.inBook).toBe(false);
    expect(r.options).toEqual([]);
    expect(r.bestReasons).toBeNull();
  });
});

describe('previewLine', () => {
  const line = ['e2e4', 'e7e5', 'g1f3', 'b8c6', 'f1c4', 'g8f6', 'd2d3', 'f8c5'];

  it('one ply is not worth watching', () => {
    expect(previewLine(START, ['e2e4'])).toBeNull();
  });

  it('caps at 6 plies, user first, alternating, with replayed positions', () => {
    const p = previewLine(START, line)!;
    expect(p).toHaveLength(PREVIEW_PLIES);
    const c = new Chess(START);
    p.forEach((ply, i) => {
      expect(ply.by).toBe(i % 2 === 0 ? 'user' : 'opponent');
      const m = c.move({ from: line[i].slice(0, 2), to: line[i].slice(2, 4) });
      expect(ply.uci).toBe(line[i]);
      expect(ply.san).toBe(m.san);
      expect(ply.fen).toBe(c.fen());
    });
  });

  it('stops at an illegal move', () => {
    expect(previewLine(START, ['e2e4', 'e7e5', 'e1e3'])).toHaveLength(2);
  });
});
