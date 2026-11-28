import type { SavedGame } from '../storage/db';

/** Games played for real: everything except teaching games (a game with no mode is a play game). */
export function playGames(games: SavedGame[]): SavedGame[] {
  return games.filter((g) => g.mode !== 'teach');
}
