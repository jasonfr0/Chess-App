import type { SavedGame } from '../storage/db';
import type { Theme } from '../types';

export const SUGGEST_LINES_OFF =
  "You've been spotting threats well — try turning attack lines off so your moves count toward your progress.";

const THREAT_THEMES: Theme[] = ['hanging_piece', 'ignored_threat', 'allowed_fork'];
const MIN_USER_MOVES = 10;
const MIN_SHARE = 0.8;

/** True iff the 3 most recent finished games each used attack lines on ≥80% of ≥10 user moves, with no flagged threat blunders. */
export function suggestLinesOff(lastGames: SavedGame[]): boolean {
  const recent = lastGames
    .filter((g) => g.result !== null)
    .sort((a, b) => b.startedAt - a.startedAt)
    .slice(0, 3);
  if (recent.length < 3) return false;
  return recent.every((g) => {
    const total = g.userMoves ?? 0;
    const lines = g.attackLinesMoves ?? 0;
    if (total < MIN_USER_MOVES || lines / total < MIN_SHARE) return false;
    return !g.verdicts.some((v) => v.flagged && THREAT_THEMES.includes(v.theme));
  });
}
