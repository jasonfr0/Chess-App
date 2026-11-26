import { isAllowedToken, moveTokens, strip } from './claude';

const PIECE_TO_SQUARE = /\b(pawn|knight|bishop|rook|queen|king)s?\s+(to|onto|into)\s+[a-h][1-8]\b/gi;
const TAKE_ON_SQUARE = /\b(take|takes|capture|captures|grab|win)\b[^.?!]*\bon\s+[a-h][1-8]\b/gi;
const PLAY_SQUARE = /\b(play|push|move|bring|put)\b[^.?!]*\b[a-h][1-8]\b/gi;
const CASTLE = /\b(castle|castling)\b/i;

/**
 * Fragments of `text` that give the player a move before they have moved.
 * Empty means safe. Errs towards flagging. `allowedSan` lists moves that may be
 * named (the opponent's last move).
 */
export function moveLeaks(text: string, allowedSan: string[] = []): string[] {
  const out: string[] = [];
  const ok = new Set(allowedSan.map(strip));
  for (const t of moveTokens(text)) if (!isAllowedToken(t, ok)) out.push(t);
  for (const re of [PIECE_TO_SQUARE, TAKE_ON_SQUARE, PLAY_SQUARE]) {
    for (const m of text.matchAll(re)) out.push(m[0]);
  }
  for (const sentence of text.match(/[^.?!]+[.?!]?/g) ?? []) {
    if (CASTLE.test(sentence) && !sentence.trim().endsWith('?')) out.push(sentence.trim());
  }
  return out;
}
