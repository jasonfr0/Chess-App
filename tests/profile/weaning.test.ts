import { describe, it, expect } from 'vitest';
import { emptyProfile, recordMove } from '../../src/profile/profile';
import { ORDER, reviewLevels, levelChangeText, suggestClock } from '../../src/profile/weaning';
import type { Verdict } from '../../src/coach/classify';
import type { Area, ProfileData } from '../../src/types';

const v = (area: Area, flagged = false): Verdict => ({
  flagged, severity: flagged ? 'mistake' : 'ok', cpLoss: flagged ? 200 : 0, area, theme: 'other',
  recommendation: 'play_on', bestUci: 'e2e4', bestSan: 'e4', refutationSan: [],
});
function fill(area: Area, n: number, flaggedEvery = 0) {
  let p = emptyProfile();
  for (let i = 0; i < n; i++) {
    p = recordMove(p, v(area, flaggedEvery > 0 && i % flaggedEvery === 0), { gameId: 'g', ply: i, fen: 'f', at: i });
  }
  return p;
}

describe('weaning', () => {
  it('ORDER', () => expect(ORDER).toEqual(['full', 'guided', 'light', 'solo']));

  it('40 good moves step down once, then cool down', () => {
    const r = reviewLevels(fill('middlegame', 40));
    expect(r.profile.levels.middlegame).toBe('guided');
    expect(r.changes).toEqual([{ area: 'middlegame', from: 'full', to: 'guided' }]);
    const again = reviewLevels(r.profile);
    expect(again.changes).toEqual([]);
    expect(again.profile.levels.middlegame).toBe('guided');
  });

  it('steps down again after 40 more good records', () => {
    let p = reviewLevels(fill('middlegame', 40)).profile;
    for (let i = 0; i < 40; i++) p = recordMove(p, v('middlegame'), { gameId: 'g', ply: i, fen: 'f', at: 100 + i });
    expect(reviewLevels(p).profile.levels.middlegame).toBe('light');
  });

  it('39 records give no change', () => {
    expect(reviewLevels(fill('middlegame', 39)).changes).toEqual([]);
  });

  it('under 80% good gives no step down', () => {
    let p = emptyProfile();
    for (let i = 0; i < 40; i++) { // 9 flagged, all in the first 20, so no step-up either
      p = recordMove(p, v('middlegame', i < 9), { gameId: 'g', ply: i, fen: 'f', at: i });
    }
    expect(reviewLevels(p).changes).toEqual([]);
  });

  it('5 flagged of last 20 steps guided up to full', () => {
    const p = fill('opening', 20, 4); // 5 flagged
    const r = reviewLevels({ ...p, levels: { ...p.levels, opening: 'guided' } });
    expect(r.profile.levels.opening).toBe('full');
    expect(r.changes).toEqual([{ area: 'opening', from: 'guided', to: 'full' }]);
  });

  it('never steps past full or solo', () => {
    expect(reviewLevels(fill('opening', 20, 4)).changes).toEqual([]);
    const p = fill('endgame', 80);
    let cur: ProfileData = { ...p, levels: { ...p.levels, endgame: 'solo' } };
    expect(reviewLevels(cur).changes).toEqual([]);
    cur = { ...p, levels: { ...p.levels, endgame: 'light' } };
    expect(reviewLevels(cur).profile.levels.endgame).toBe('solo');
  });

  it('copy', () => {
    expect(levelChangeText({ area: 'middlegame', from: 'full', to: 'guided' })).toBe(
      "You've been spotting threats well in the middlegame. I'll stop showing your choices there — tap the coach if you want them.");
    expect(levelChangeText({ area: 'opening', from: 'guided', to: 'full' })).toBe(
      "A few more slips lately in the opening — I'll show your choices again for a while.");
  });

  it('suggestClock', () => {
    const p = emptyProfile();
    expect(suggestClock(p)).toBe(false);
    expect(suggestClock({ ...p, levels: { opening: 'guided', middlegame: 'light', endgame: 'solo' } })).toBe(true);
  });
});
