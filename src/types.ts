export type Color = 'w' | 'b';
export type Area = 'opening' | 'middlegame' | 'endgame';
export type CoachLevel = 'full' | 'guided' | 'light' | 'solo';
export type Theme =
  | 'hanging_piece' | 'ignored_threat' | 'allowed_fork' | 'missed_fork' | 'missed_pin'
  | 'missed_mate' | 'allowed_mate' | 'early_queen' | 'undeveloped' | 'king_safety'
  | 'bad_trade' | 'endgame_technique' | 'other';
export type GameResult = {
  winner: Color | null;
  reason: 'checkmate' | 'stalemate' | 'repetition' | 'fifty_move' | 'insufficient' | 'resign' | 'timeout';
};
export interface PlayedMove { san: string; uci: string; fenBefore: string; fenAfter: string; color: Color }

export interface EngineLine { uci: string[]; cp: number | null; mate: number | null } // side-to-move POV
export interface Analysis { fen: string; depth: number; lines: EngineLine[] }           // lines[0] = best

export interface ProfileSummary { topThemes: { theme: Theme; count: number }[]; gamesPlayed: number }

export interface ThemeStat {
  count: number;
  lastSeen: number;
  examples: { gameId: string; ply: number; fen: string }[];
}
export interface MoveRecord { good: boolean; flagged: boolean; at: number }
export interface ProfileData {
  themes: Record<Theme, ThemeStat>;
  moves: Record<Area, MoveRecord[]>;
  levels: Record<Area, CoachLevel>;
  levelChangedAt?: Partial<Record<Area, number>>;
}
