import { describe, it, expect } from 'vitest';
import { emptyProfile, recordMove } from '../../src/profile/profile';
import { ORDER, reviewLevels, levelChangeText, suggestClock } from '../../src/profile/weaning';
import type { Verdict } from '../../src/coach/classify';
import type { Area, ProfileData } from '../../src/types';
import { DEFAULT_SETTINGS } from '../../src/storage/db';

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

  it('step-up is idempotent: repeated reviews give exactly one step', () => {
    const p = fill('opening', 20, 4);
    const start: ProfileData = { ...p, levels: { ...p.levels, opening: 'solo' } };
    const r1 = reviewLevels(start);
    expect(r1.profile.levels.opening).toBe('light');
    const r2 = reviewLevels(r1.profile);
    expect(r2.changes).toEqual([]);
    expect(r2.profile.levels.opening).toBe('light');
  });

  it('steps up again only after 20 further records', () => {
    const p = fill('opening', 20, 4);
    let cur = reviewLevels({ ...p, levels: { ...p.levels, opening: 'solo' } }).profile;
    for (let i = 0; i < 20; i++) cur = recordMove(cur, v('opening', i % 4 === 0), { gameId: 'g', ply: i, fen: 'f', at: 50 + i });
    expect(reviewLevels(cur).profile.levels.opening).toBe('guided');
  });

  it('never steps past full or solo', () => {
    expect(reviewLevels(fill('opening', 20, 4)).changes).toEqual([]);
    const p = fill('endgame', 80);
    let cur: ProfileData = { ...p, levels: { ...p.levels, endgame: 'solo' } };
    expect(reviewLevels(cur).changes).toEqual([]);
    cur = { ...p, levels: { ...p.levels, endgame: 'light' } };
    expect(reviewLevels(cur).profile.levels.endgame).toBe('solo');
  });

  it('solo is not a trap: 25% bad (unflagged) moves over 20 post-change records step up to light', () => {
    let p: ProfileData = { ...emptyProfile(), levels: { ...emptyProfile().levels, middlegame: 'solo' }, levelChangedAt: { middlegame: 0 } };
    for (let i = 0; i < 20; i++) {
      const bad = i % 4 === 0;
      const verdict: Verdict = { ...v('middlegame'), severity: bad ? 'blunder' : 'ok', cpLoss: bad ? 400 : 0 }; // never flagged at solo
      p = recordMove(p, verdict, { gameId: 'g', ply: i, fen: 'f', at: i });
    }
    expect(p.moves.middlegame.every((m) => !m.flagged)).toBe(true);
    expect(reviewLevels(p).profile.levels.middlegame).toBe('light');
  });

  it('old records without "bad" count as bad when flagged', () => {
    const recs = Array.from({ length: 20 }, (_, i) => ({ good: i % 4 !== 0, flagged: i % 4 === 0, at: i }));
    const p: ProfileData = { ...emptyProfile(), moves: { ...emptyProfile().moves, opening: recs }, levels: { ...emptyProfile().levels, opening: 'guided' } };
    expect(reviewLevels(p).profile.levels.opening).toBe('full');
  });

  const atGuided = (): ProfileData => ({ ...emptyProfile(), levels: { ...emptyProfile().levels, middlegame: 'guided' } });

  it('below full, assisted moves do not count towards stepping down', () => {
    let p = atGuided();
    for (let i = 0; i < 60; i++) p = recordMove(p, v('middlegame'), { gameId: 'g', ply: i, fen: 'f', at: i, assisted: true });
    for (let i = 0; i < 39; i++) p = recordMove(p, v('middlegame'), { gameId: 'g', ply: i, fen: 'f', at: 100 + i });
    expect(reviewLevels(p).changes).toEqual([]);
    p = recordMove(p, v('middlegame'), { gameId: 'g', ply: 40, fen: 'f', at: 200 });
    expect(reviewLevels(p).profile.levels.middlegame).toBe('light');
  });

  it('below full, with assisted moves interleaved only independent ones are judged', () => {
    let p = atGuided();
    for (let i = 0; i < 80; i++) {
      p = recordMove(p, v('middlegame'), { gameId: 'g', ply: i, fen: 'f', at: i, assisted: i % 2 === 0 });
    }
    expect(reviewLevels(p).profile.levels.middlegame).toBe('light');
  });

  describe('full -> guided uses the same non-assisted rule as every level', () => {
    const fullWith = (n: number, assisted: boolean) => {
      let p = emptyProfile();
      for (let i = 0; i < n; i++) p = recordMove(p, v('middlegame'), { gameId: 'g', ply: i, fen: 'f', at: i, assisted });
      return p;
    };
    it('40 good assisted records do not step down', () => {
      expect(reviewLevels(fullWith(40, true)).changes).toEqual([]);
    });
    it('40 good non-assisted records step down to guided', () => {
      expect(reviewLevels(fullWith(40, false)).changes).toEqual([{ area: 'middlegame', from: 'full', to: 'guided' }]);
    });
    it('needs 40 records since the last change', () => {
      const p = fullWith(60, false);
      expect(reviewLevels({ ...p, levelChangedAt: { middlegame: 21 } }).changes).toEqual([]);
      expect(reviewLevels({ ...p, levelChangedAt: { middlegame: 20 } }).profile.levels.middlegame).toBe('guided');
    });
  });

  it('assisted bad moves still count towards stepping up', () => {
    let p: ProfileData = { ...emptyProfile(), levels: { ...emptyProfile().levels, opening: 'guided' } };
    for (let i = 0; i < 20; i++) {
      const verdict: Verdict = { ...v('opening'), severity: i % 4 === 0 ? 'mistake' : 'ok', cpLoss: i % 4 === 0 ? 200 : 0 };
      p = recordMove(p, verdict, { gameId: 'g', ply: i, fen: 'f', at: i, assisted: true });
    }
    expect(reviewLevels(p).profile.levels.opening).toBe('full');
  });

  it('copy', () => {
    expect(levelChangeText({ area: 'middlegame', from: 'full', to: 'guided' })).toBe(
      "You've been finding good moves in the middlegame. I'll hide the questions there — tap Show questions if you want them.");
    expect(levelChangeText({ area: 'opening', from: 'guided', to: 'full' })).toBe(
      "A few more slips lately in the opening — I'll show the questions again for a while.");
    expect(levelChangeText({ area: 'endgame', from: 'solo', to: 'light' })).toBe(
      "A few more slips lately in the endgame — I'll show the questions again for a while.");
  });

  it('copy for each step down matches what the new level does', () => {
    expect(levelChangeText({ area: 'middlegame', from: 'guided', to: 'light' })).toBe(
      "You've been spotting threats well in the middlegame. I'll stay quiet unless you tap Ask the coach.");
    expect(levelChangeText({ area: 'endgame', from: 'light', to: 'solo' })).toBe(
      "You've been spotting threats well in the endgame. Only a short recap at the end of each game.");
  });

  it('suggestClock', () => {
    const p = emptyProfile();
    expect(suggestClock(p)).toBe(false);
    expect(suggestClock({ ...p, levels: { opening: 'guided', middlegame: 'light', endgame: 'solo' } })).toBe(true);
  });

  it('suggestClock uses the effective level, including manual overrides', () => {
    const p: ProfileData = { ...emptyProfile(), levels: { opening: 'guided', middlegame: 'light', endgame: 'solo' } };
    expect(suggestClock(p, { ...DEFAULT_SETTINGS, levelOverride: { opening: 'full' } })).toBe(false);
    expect(suggestClock(emptyProfile(), { ...DEFAULT_SETTINGS, levelOverride: { opening: 'light', middlegame: 'guided' } })).toBe(true);
  });
});
