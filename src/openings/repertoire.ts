import type { Color } from '../types';
import data from './repertoire.json';

/**
 * `idea` is shown after the move is played: for the user's moves, why it is good; for the
 * opponent's, only what their move does. `plan` (opponent moves only) is shown before the user's
 * reply: a goal to aim for that names no move and no destination square.
 */
export interface RepertoireNode { san: string; name?: string; idea: string; plan?: string; children: RepertoireNode[]; main?: boolean }
export interface BookHit { node: RepertoireNode; lineName: string; inBook: true }

const roots: Record<Color, RepertoireNode[]> = { w: data.white, b: data.black };

/**
 * The opening plan before the user's first move: the root plan for White, and for Black the plan
 * after the opponent's first book move.
 */
export function rootPlan(color: Color): string {
  return color === 'w' ? data.whitePlan : (roots.b[0].plan ?? '');
}

/** Follows sanHistory down the tree; returns the visited nodes, or null if a move leaves the book. */
function walk(userColor: Color, sanHistory: string[]): RepertoireNode[] | null {
  const path: RepertoireNode[] = [];
  let level = roots[userColor];
  for (const san of sanHistory) {
    const next = level.find((n) => n.san === san);
    if (!next) return null;
    path.push(next);
    level = next.children;
  }
  return path;
}

/** The book node for the last move played, named after the deepest named line on the way there. */
export function lookup(userColor: Color, sanHistory: string[]): BookHit | null {
  const path = walk(userColor, sanHistory);
  const node = path?.at(-1);
  if (!path || !node) return null;
  const lineName = path.reduce((name, n) => n.name ?? name, '');
  return { node, lineName, inBook: true };
}

/** Book moves available after sanHistory (empty when out of book). */
export function bookReplies(userColor: Color, sanHistory: string[]): RepertoireNode[] {
  const path = walk(userColor, sanHistory);
  if (!path) return [];
  return path.at(-1)?.children ?? roots[userColor];
}
