import type { Color } from '../types';
import data from './repertoire.json';

export interface RepertoireNode { san: string; name?: string; idea: string; children: RepertoireNode[]; main?: boolean }
export interface BookHit { node: RepertoireNode; lineName: string; inBook: true }

const roots: Record<Color, RepertoireNode[]> = { w: data.white, b: data.black };

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
