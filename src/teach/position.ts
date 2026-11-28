import type { Color, TeachMode, TeachTopic } from '../types';
import { positionFacts } from '../coach/facts';
import type { HangingPiece } from '../coach/facts';
import { NAMES } from '../coach/templates';

/**
 * What to look at when nothing on the board needs saying. Advice only: none of these claims
 * anything about the position, and none names a move or a square.
 */
export const TOPIC_FOCUS: Record<TeachTopic, string> = {
  opening: 'Follow the opening ideas: get your pieces out and fight for the middle of the board.',
  safety: 'Before you choose, check which of your pieces are attacked and whether each one is guarded.',
  captures: 'Look at every piece of theirs you could take, and check whether it is guarded.',
  checks: 'Look at every check you could give and every threat you could make before you choose.',
  development: 'Look for a piece that has not moved yet, and use this move to bring it into the game.',
  endgame: 'With few pieces left, your king can fight too, and every pawn could become a new queen.',
  other: 'Take a moment to see what each of your pieces is doing, and find the one doing the least.',
};

function joinAnd(items: string[]): string {
  return items.length <= 1 ? (items[0] ?? '') : `${items.slice(0, -1).join(', ')} and ${items.at(-1)}`;
}

const capitalise = (s: string) => s[0].toUpperCase() + s.slice(1);

/** "your knight on d4 and your pawn on e4". */
function pieceList(pieces: HangingPiece[], owner: 'your' | 'their'): string {
  return joinAnd(pieces.map((p) => `${owner} ${NAMES[p.piece]} on ${p.square}`));
}

/**
 * "The position": 1–2 sentences. In guide mode it never points at a piece the user can win.
 * Only `undefended` pieces are named: a piece attacked by a cheaper one is still guarded, so
 * "taken for free" and "not guarded" would not be true of it.
 */
export function positionText(input: {
  fen: string; userColor: Color; mode: TeachMode; topic: TeachTopic;
  lineName: string | null; plan: string | null;
}): string {
  const { fen, userColor, mode, topic, lineName, plan } = input;
  const free = positionFacts(fen).hanging.filter((p) => p.reason === 'undefended');
  const mine = free.filter((p) => p.color === userColor);
  const theirs = free.filter((p) => p.color !== userColor);
  const out: string[] = [];
  if (mine.length > 0) out.push(`${capitalise(pieceList(mine, 'your'))} can be taken for free.`);
  if (mode === 'show' && theirs.length > 0) {
    out.push(`${capitalise(pieceList(theirs, 'their'))} ${theirs.length > 1 ? 'are' : 'is'} not guarded.`);
  }
  if (lineName) {
    out.push(`You're in the ${lineName}.`);
    if (plan) out.push(plan);
  }
  if (out.length === 0) out.push(TOPIC_FOCUS[topic]);
  return out.slice(0, 2).join(' ');
}
