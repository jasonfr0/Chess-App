import type { Area, CoachLevel, MoveRecord, ProfileData, ProfileSummary, Theme } from '../types';
import type { Verdict } from '../coach/classify';
import { defaultProfile, type Settings } from '../storage/db';

const MAX_EXAMPLES = 10;
export const MAX_RECORDS = 200;
const DAY_MS = 86_400_000;

/** Single source of truth for starting values lives in storage/db. */
export function emptyProfile(): ProfileData {
  return defaultProfile();
}

export function recordMove(
  p: ProfileData, v: Verdict, ctx: { gameId: string; ply: number; fen: string; at: number },
): ProfileData {
  const record: MoveRecord = { good: !v.flagged && v.cpLoss < 50, flagged: v.flagged, at: ctx.at };
  const all = [...p.moves[v.area], record];
  const trimmed = Math.max(0, all.length - MAX_RECORDS);
  const moves = { ...p.moves, [v.area]: all.slice(trimmed) };

  let levelChangedAt = p.levelChangedAt;
  if (trimmed > 0 && levelChangedAt?.[v.area] !== undefined) {
    levelChangedAt = { ...levelChangedAt, [v.area]: Math.max(0, levelChangedAt[v.area]! - trimmed) };
  }

  let themes = p.themes;
  if (v.flagged) {
    const old = p.themes[v.theme];
    themes = {
      ...p.themes,
      [v.theme]: {
        count: old.count + 1,
        lastSeen: ctx.at,
        examples: [...old.examples, { gameId: ctx.gameId, ply: ctx.ply, fen: ctx.fen }].slice(-MAX_EXAMPLES),
      },
    };
  }
  return { ...p, themes, moves, ...(levelChangedAt ? { levelChangedAt } : {}) };
}

/** Top 3 themes by count among themes seen in the last 30 days. `gamesPlayed` is not stored in the profile; callers pass it. */
export function summary(p: ProfileData, now: number = Date.now(), gamesPlayed = 0): ProfileSummary {
  const topThemes = (Object.entries(p.themes) as [Theme, ProfileData['themes'][Theme]][])
    .filter(([, s]) => s.count > 0 && now - s.lastSeen <= 30 * DAY_MS)
    .map(([theme, s]) => ({ theme, count: s.count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 3);
  return { topThemes, gamesPlayed };
}

export function levelFor(p: ProfileData, s: Settings, a: Area): CoachLevel {
  return s.levelOverride[a] ?? p.levels[a];
}
