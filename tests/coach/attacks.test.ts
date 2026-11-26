import { describe, it, expect } from 'vitest';
import { attackMap } from '../../src/coach/attacks';

const START = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';

describe('attackMap', () => {
  it('counts pawn diagonals, not pushes, from the start position', () => {
    const m = attackMap(START, 'b');
    for (const f of 'abcdefgh') expect(m.squares).toContain(f + '6');
    expect(m.squares).not.toContain('e5');
    expect(m.lines).toEqual([]);
  });

  it('draws a line from a bishop to a defended knight', () => {
    // black bishop b4 attacks white knight d2 (defended by king e1); white to move
    const m = attackMap('4k3/8/8/8/1b6/8/3N4/4K3 w - - 0 1', 'b');
    expect(m.lines).toContainEqual({ from: 'b4', to: 'd2' });
  });

  it('still counts attacks by a pinned piece', () => {
    // black knight e5 pinned by rook e8 against... white rook e1 pins knight to king e8? use black king e8
    const m = attackMap('4k3/8/8/4n3/8/8/8/4R1K1 w - - 0 1', 'b');
    expect(m.squares).toContain('d3');
    expect(m.squares).toContain('f3');
  });
});
