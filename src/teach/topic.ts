import type { Area, TeachTopic } from '../types';
import type { Reasons } from '../coach/reasons';

export const TOPIC_LABEL: Record<TeachTopic, string> = {
  opening: 'Opening moves', safety: 'Keeping your pieces safe', captures: 'Winning material',
  checks: 'Checks and threats', development: 'Getting your pieces out', endgame: 'Endgames', other: 'Other positions',
};

/** The turn's topic, from the best move's checked reasons; first match wins. */
export function topicOf(input: { inBook: boolean; area: Area; reasons: Reasons | null }): TeachTopic {
  const { inBook, area, reasons } = input;
  if (inBook) return 'opening';
  if (reasons === null) return area === 'endgame' ? 'endgame' : 'other';
  if (reasons.checkmate) return 'checks';
  switch (reasons.fundamentals[0]) {
    case 'defends': return 'safety';
    case 'wins_material': return 'captures';
    case 'check_threat':
    case 'attacks': return 'checks';
    case 'develops':
    case 'centre':
    case 'king_safety': return 'development';
    default: return area === 'endgame' ? 'endgame' : 'other';
  }
}
