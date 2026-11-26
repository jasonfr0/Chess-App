import { describe, it, expect } from 'vitest';
import { Chess } from 'chess.js';
import data from '../../src/openings/repertoire.json';
import { lookup, bookReplies, rootPlan, type RepertoireNode } from '../../src/openings/repertoire';
import { moveLeaks } from '../../src/coach/leaks';
import type { Color } from '../../src/types';
import { validateClaims } from '../../src/coach/claude';

const trees: Record<Color, RepertoireNode[]> = { w: data.white, b: data.black };

function walk(
  nodes: RepertoireNode[],
  path: string[],
  visit: (node: RepertoireNode, path: string[], siblings: RepertoireNode[]) => void,
): void {
  for (const node of nodes) {
    const here = [...path, node.san];
    visit(node, here, nodes);
    walk(node.children, here, visit);
  }
}

describe('repertoire tree', () => {
  for (const color of ['w', 'b'] as const) {
    it(`replays every ${color} path legally`, () => {
      let count = 0;
      walk(trees[color], [], (_node, path) => {
        const chess = new Chess();
        for (const san of path) expect(() => chess.move(san), path.join(' ')).not.toThrow();
        expect(chess.history().at(-1)).toBe(path.at(-1));
        count++;
      });
      expect(count).toBeGreaterThan(10);
    });

    it(`has a short, non-empty idea on every ${color} node`, () => {
      walk(trees[color], [], (node, path) => {
        expect(node.idea.trim().length, path.join(' ')).toBeGreaterThan(0);
        expect(node.idea.length, path.join(' ')).toBeLessThanOrEqual(300);
        const sentences = node.idea.split(/[.!?](?:\s|$)/).filter((s) => s.trim()).length;
        expect(sentences, path.join(' ')).toBeLessThanOrEqual(2);
      });
    });

    it(`marks main only on the user's own ${color} moves, one per choice`, () => {
      const userParity = color === 'w' ? 1 : 0; // white moves are odd plies
      const check = (siblings: RepertoireNode[], ply: number) => {
        const mains = siblings.filter((n) => n.main);
        if (ply % 2 === userParity) expect(mains.length).toBe(1);
        else expect(mains.length).toBe(0);
      };
      check(trees[color], 1);
      walk(trees[color], [], (node, path) => {
        if (node.children.length) check(node.children, path.length + 1);
      });
    });
  }

  it('names the Italian Game for White', () => {
    expect(lookup('w', ['e4', 'e5', 'Nf3', 'Nc6', 'Bc4'])?.lineName).toContain('Italian');
  });

  it('uses the deepest named ancestor for the line name', () => {
    const hit = lookup('w', ['e4', 'e5', 'Nf3', 'Nc6', 'Bc4', 'Bc5', 'c3']);
    expect(hit?.lineName).toBe('Giuoco Piano');
    expect(hit?.node.san).toBe('c3');
    expect(hit?.inBook).toBe(true);
  });

  it("names the Queen's Gambit Declined for Black", () => {
    expect(lookup('b', ['d4', 'd5', 'c4', 'e6'])?.lineName).toContain("Queen's Gambit Declined");
  });

  it('returns null when out of book', () => {
    expect(lookup('w', ['a3'])).toBeNull();
    expect(lookup('w', [])).toBeNull();
    expect(lookup('w', ['e4', 'e5', 'Nf3', 'Nc6', 'Bc4', 'h6', 'Ng5'])).toBeNull();
  });

  it('offers e5 as a book reply to 1.e4 for Black', () => {
    expect(bookReplies('b', ['e4']).map((n) => n.san)).toContain('e5');
  });

  it('offers root moves for an empty history and nothing out of book', () => {
    expect(bookReplies('w', []).map((n) => n.san)).toEqual(['e4']);
    expect(bookReplies('b', []).map((n) => n.san).sort()).toEqual(['d4', 'e4']);
    expect(bookReplies('w', ['a3'])).toEqual([]);
  });
});

/** True when the node's move is the opponent's (the user plays `color`). */
const isOpponent = (color: Color, path: string[]) => (path.length % 2 === 1 ? 'w' : 'b') !== color;

describe('repertoire before-move texts give no move away', () => {
  for (const color of ['w', 'b'] as const) {
    it(`has a short plan on every ${color} opponent-move node`, () => {
      let count = 0;
      walk(trees[color], [], (node, path) => {
        if (!isOpponent(color, path)) return;
        count++;
        expect(node.plan?.trim().length ?? 0, path.join(' ')).toBeGreaterThan(0);
        expect(node.plan!.length, path.join(' ')).toBeLessThanOrEqual(220);
      });
      expect(count).toBeGreaterThan(10);
    });

    it(`names no move in any ${color} plan or opponent idea`, () => {
      const bad: string[] = [];
      walk(trees[color], [], (node, path) => {
        if (!isOpponent(color, path)) return;
        for (const leak of moveLeaks(node.plan ?? '')) bad.push(`${path.join(' ')} plan: ${leak}`);
        for (const leak of moveLeaks(node.idea, [node.san])) bad.push(`${path.join(' ')} idea: ${leak}`);
      });
      expect(bad).toEqual([]);
    });

    it(`names no move but its own in any ${color} user-move idea (shown before the next decision)`, () => {
      const bad: string[] = [];
      walk(trees[color], [], (node, path) => {
        if (isOpponent(color, path)) return;
        for (const leak of moveLeaks(node.idea, [node.san])) bad.push(`${path.join(' ')} idea: ${leak}`);
      });
      expect(bad).toEqual([]);
    });
  }

  it('has a move-free plan for move 1 as White', () => {
    expect(rootPlan('w').trim().length).toBeGreaterThan(0);
    expect(rootPlan('w').length).toBeLessThanOrEqual(220);
    expect(moveLeaks(rootPlan('w'))).toEqual([]);
  });

  it("uses the opponent's first move plan for Black", () => {
    expect(rootPlan('b')).toBe(data.black[0].plan);
  });
});

describe('repertoire ideas pass the claim checks Claude is held to', () => {
  it('every "<piece> on <square>" and "free"/"hanging" claim is true in its position', () => {
    const bad: string[] = [];
    for (const color of ['w', 'b'] as Color[]) {
      walk(trees[color], [], (node, path) => {
        const c = new Chess();
        for (const san of path.slice(0, -1)) c.move(san);
        const fen = c.fen();
        c.move(node.san);
        if (!validateClaims({ whatHappened: node.idea }, { fen, fenAfter: c.fen(), hanging: [] })) bad.push(`${path.join(' ')}: ${node.idea}`);
        // A plan is read in the position after the opponent's move.
        if (node.plan && !validateClaims({ whatHappened: node.plan }, { fen: c.fen(), hanging: [] })) bad.push(`${path.join(' ')} plan: ${node.plan}`);
      });
    }
    expect(bad).toEqual([]);
  });

  it('warns not to block the c-pawn with the last knight (Nc3 would stop c3), without naming a move', () => {
    const hit = lookup('w', ['e4', 'e5', 'Nf3', 'Nc6', 'Bc4', 'Nf6', 'd3', 'Be7', 'O-O']);
    expect(hit?.node.idea).toContain('without blocking your c-pawn');
  });

  it('after 3...d6 says the f8 bishop can only go to e7', () => {
    expect(lookup('w', ['e4', 'e5', 'Nf3', 'Nc6', 'Bc4', 'd6'])?.node.idea)
      .toContain('hems in the bishop on f8, which can now only go to e7');
    const c = new Chess();
    for (const san of ['e4', 'e5', 'Nf3', 'Nc6', 'Bc4', 'd6', 'a3']) c.move(san);
    expect(c.moves({ square: 'f8' })).toEqual(['Be7']);
  });
});
