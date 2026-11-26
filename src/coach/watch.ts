import { Chess } from 'chess.js';
import type { Color } from '../types';
import { positionFacts } from './facts';

export interface WatchPly { uci: string; san: string; fen: string; by: 'opponent' | 'user' }

const MAX_PLIES = 8;

/**
 * The engine line to replay for a multi-move consequence, or null when the card's own text says it all.
 * `fenAfter` is the position after the user's move (opponent to move); `line` is the engine's best
 * line from there. Shown only when the line ends in mate, or the mover has less material at the last
 * ply where any material changes than after ply 1. Capped at 8 plies.
 */
export function watchLine(fenAfter: string, line: string[], mover: Color): WatchPly[] | null {
  const chess = new Chess(fenAfter);
  const plies: WatchPly[] = [];
  const own: number[] = []; // mover's material after each ply
  const total: number[] = []; // both sides' material after each ply
  let mateAt = -1;
  for (const uci of line.slice(0, MAX_PLIES)) {
    let san: string;
    try {
      san = chess.move({ from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci[4] }).san;
    } catch {
      break;
    }
    const fen = chess.fen();
    const m = positionFacts(fen).material;
    plies.push({ uci, san, fen, by: plies.length % 2 === 0 ? 'opponent' : 'user' });
    own.push(m[mover]);
    total.push(m.w + m.b);
    if (chess.isCheckmate()) { mateAt = plies.length - 1; break; }
  }
  if (mateAt >= 0) return plies;
  let last = 0; // last ply index where the material count changes
  for (let i = 1; i < plies.length; i++) if (total[i] !== total[i - 1]) last = i;
  if (plies.length === 0 || own[last] >= own[0]) return null;
  return plies.slice(0, last + 1);
}
