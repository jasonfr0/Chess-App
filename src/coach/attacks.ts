import { Chess } from 'chess.js';
import type { Color, Square } from 'chess.js';

const FILES = 'abcdefgh';

/**
 * Everything `by` attacks. Pseudo-legal: pinned pieces still attack; pawns attack diagonally only.
 * `lines` run from each attacker to every enemy piece standing on an attacked square (defended or not).
 */
export function attackMap(fen: string, by: Color): { squares: string[]; lines: { from: string; to: string }[] } {
  const chess = new Chess(fen);
  const squares: string[] = [];
  const lines: { from: string; to: string }[] = [];
  for (let r = 1; r <= 8; r++) {
    for (const f of FILES) {
      const sq = (f + r) as Square;
      const attackers = chess.attackers(sq, by);
      if (attackers.length === 0) continue;
      squares.push(sq);
      const occupant = chess.get(sq);
      if (occupant && occupant.color !== by) for (const from of attackers) lines.push({ from, to: sq });
    }
  }
  return { squares, lines };
}
