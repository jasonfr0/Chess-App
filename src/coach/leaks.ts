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

const MOVE_VERB = /\b(play|plays|played|playing|push|pushes|pushing|move|moves|moved|moving|bring|brings|bringing|put|puts|putting|step|steps|stepping|go|goes|going|walk|walks|walking|jump|jumps|jumping|slide|slides|sliding|retreat|retreats|retreating|advance|advances|advancing|send|sends|sending)\b/i;
const squareRe = (sq: string) => new RegExp(`\\b${sq}\\b`, 'i');

/**
 * True when `text` points at one particular move (the better move, `bestSan` / `bestUci`): it names
 * the move, a piece going to its destination, either of its squares in a sentence with a move verb,
 * or castling when the move castles. Errs towards flagging. Used on Claude's rewrite of the mistake
 * card, which must keep the better move hidden while the user decides.
 */
export function revealsMove(text: string, bestSan: string, bestUci: string): boolean {
  const best = strip(bestSan);
  if (moveTokens(text).some((t) => isAllowedToken(t, new Set([best])))) return true;
  if (/^O-O/.test(best) && CASTLE.test(text)) return true;
  const from = bestUci.slice(0, 2);
  const to = bestUci.slice(2, 4);
  for (const m of text.matchAll(PIECE_TO_SQUARE)) if (squareRe(to).test(m[0])) return true;
  if (new RegExp(`\\b(to|onto|into|towards?)\\s+${to}\\b`, 'i').test(text)) return true;
  for (const sentence of text.match(/[^.?!]+[.?!]?/g) ?? []) {
    if (MOVE_VERB.test(sentence) && (squareRe(to).test(sentence) || squareRe(from).test(sentence))) return true;
  }
  return false;
}
