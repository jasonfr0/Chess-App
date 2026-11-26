import type { Area, CoachLevel, MoveRecord, ProfileData } from '../types';
import { levelFor } from './profile';
import type { Settings } from '../storage/db';

export const ORDER: CoachLevel[] = ['full', 'guided', 'light', 'solo'];
const AREAS: Area[] = ['opening', 'middlegame', 'endgame'];
const DOWN_WINDOW = 40;
const UP_WINDOW = 20;

export interface LevelChange { area: Area; from: CoachLevel; to: CoachLevel }

/** Level-independent: a mistake or blunder. Records saved before `bad` existed fall back to `flagged`. */
const isBad = (m: MoveRecord) => m.bad ?? m.flagged;

/** Run between games only. Step-downs need a 40-record cool-down since the last change in that area. */
export function reviewLevels(p: ProfileData): { profile: ProfileData; changes: LevelChange[] } {
  const levels = { ...p.levels };
  const levelChangedAt = { ...p.levelChangedAt };
  const changes: LevelChange[] = [];

  for (const area of AREAS) {
    const recs = p.moves[area];
    const from = levels[area];
    const idx = ORDER.indexOf(from);
    let to: CoachLevel | null = null;

    const changedAt = levelChangedAt[area];
    const sinceChange = recs.length - (changedAt ?? -Infinity);
    const last20 = recs.slice(-UP_WINDOW);
    // Every window consists only of post-change records, so repeated reviews can't cascade.
    // Step-ups count every move (copied ones too).
    if (sinceChange >= UP_WINDOW && last20.length === UP_WINDOW && last20.filter(isBad).length * 4 >= UP_WINDOW) {
      // At 'full' (idx 0) there is nothing to step up to; stay put and skip the step-down check.
      if (idx > 0) to = ORDER[idx - 1];
    } else {
      // Only unhelped moves count, at every level (assisted moves excluded).
      const own = recs.slice(changedAt ?? 0).filter((m) => !m.assisted).slice(-DOWN_WINDOW);
      if (
        own.length === DOWN_WINDOW &&
        own.filter((m) => m.good).length * 5 >= DOWN_WINDOW * 4 && idx < ORDER.length - 1
      ) to = ORDER[idx + 1];
    }
    if (to) {
      levels[area] = to;
      levelChangedAt[area] = recs.length;
      changes.push({ area, from, to });
    }
  }
  return { profile: changes.length ? { ...p, levels, levelChangedAt } : p, changes };
}

const AREA_WORDS: Record<Area, string> = { opening: 'the opening', middlegame: 'the middlegame', endgame: 'the endgame' };

export function levelChangeText(c: LevelChange): string {
  const where = AREA_WORDS[c.area];
  if (ORDER.indexOf(c.to) > ORDER.indexOf(c.from)) {
    const praise = `You've been spotting threats well in ${where}.`;
    if (c.to === 'guided') return `You've been finding good moves in ${where}. I'll hide the questions there — tap Show questions if you want them.`;
    if (c.to === 'light') return `${praise} I'll stay quiet unless you tap Ask the coach.`;
    return `${praise} Only a short recap at the end of each game.`;
  }
  return `A few more slips lately in ${where} — I'll show the questions again for a while.`;
}

/** True when no area is effectively at 'full' (manual overrides included). */
export function suggestClock(p: ProfileData, s: Pick<Settings, 'levelOverride'> = { levelOverride: {} }): boolean {
  return AREAS.every((a) => levelFor(p, s, a) !== 'full');
}
