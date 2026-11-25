import { describe, it, expect } from 'vitest';
import { emptyProfile, recordMove, summary, levelFor } from '../../src/profile/profile';
import { defaultProfile, DEFAULT_SETTINGS } from '../../src/storage/db';
import type { Verdict } from '../../src/coach/classify';
import type { Theme, Area } from '../../src/types';

const v = (o: Partial<Verdict> = {}): Verdict => ({
  flagged: false, severity: 'ok', cpLoss: 0, area: 'middlegame', theme: 'other',
  recommendation: 'play_on', bestUci: 'e2e4', bestSan: 'e4', refutationSan: [], ...o,
});
const flaggedV = (theme: Theme, area: Area = 'middlegame') =>
  v({ flagged: true, severity: 'mistake', cpLoss: 200, theme, area });
const ctx = (ply: number, at = 1000) => ({ gameId: 'g1', ply, fen: 'fen' + ply, at });

describe('profile', () => {
  it('emptyProfile matches defaultProfile and has starting levels', () => {
    expect(emptyProfile()).toEqual(defaultProfile());
    expect(emptyProfile().levels).toEqual({ opening: 'full', middlegame: 'full', endgame: 'light' });
  });

  it('records good vs not good by flag and cpLoss', () => {
    let p = emptyProfile();
    p = recordMove(p, v({ cpLoss: 49 }), ctx(1));
    p = recordMove(p, v({ cpLoss: 50 }), ctx(2));
    p = recordMove(p, flaggedV('hanging_piece'), ctx(3));
    expect(p.moves.middlegame.map((m) => m.good)).toEqual([true, false, false]);
    expect(p.moves.middlegame[2].flagged).toBe(true);
  });

  it('does not mutate its input', () => {
    const p = emptyProfile();
    recordMove(p, flaggedV('hanging_piece'), ctx(1));
    expect(p).toEqual(defaultProfile());
  });

  it('keeps at most 10 newest examples per theme', () => {
    let p = emptyProfile();
    for (let i = 0; i < 12; i++) p = recordMove(p, flaggedV('missed_fork'), ctx(i));
    expect(p.themes.missed_fork.count).toBe(12);
    expect(p.themes.missed_fork.examples).toHaveLength(10);
    expect(p.themes.missed_fork.examples[0].ply).toBe(2);
    expect(p.themes.missed_fork.examples[9].ply).toBe(11);
  });

  it('bounds moves per area and shifts levelChangedAt', () => {
    let p = emptyProfile();
    p = { ...p, levelChangedAt: { middlegame: 150 } };
    for (let i = 0; i < 205; i++) p = recordMove(p, v(), ctx(i));
    expect(p.moves.middlegame).toHaveLength(200);
    expect(p.levelChangedAt?.middlegame).toBe(145);
  });

  it('clamps a trim-shifted levelChangedAt at 0', () => {
    let p = emptyProfile();
    p = { ...p, levelChangedAt: { middlegame: 2 } };
    for (let i = 0; i < 205; i++) p = recordMove(p, v(), ctx(i));
    expect(p.levelChangedAt?.middlegame).toBe(0);
  });

  it('summary orders themes by count, top 3, last 30 days only', () => {
    const day = 86_400_000;
    const now = 100 * day;
    let p = emptyProfile();
    for (let i = 0; i < 3; i++) p = recordMove(p, flaggedV('missed_pin'), ctx(i, now));
    for (let i = 0; i < 5; i++) p = recordMove(p, flaggedV('hanging_piece'), ctx(i, now - day));
    p = recordMove(p, flaggedV('early_queen'), ctx(1, now));
    p = recordMove(p, flaggedV('king_safety'), ctx(1, now));
    for (let i = 0; i < 9; i++) p = recordMove(p, flaggedV('bad_trade'), ctx(i, now - 40 * day));
    const s = summary(p, now);
    expect(s.topThemes).toHaveLength(3);
    expect(s.topThemes[0]).toEqual({ theme: 'hanging_piece', count: 5 });
    expect(s.topThemes[1]).toEqual({ theme: 'missed_pin', count: 3 });
    expect(s.topThemes.map((t) => t.theme)).not.toContain('bad_trade');
  });

  it('levelFor lets override win', () => {
    const p = emptyProfile();
    expect(levelFor(p, DEFAULT_SETTINGS, 'endgame')).toBe('light');
    expect(levelFor(p, { ...DEFAULT_SETTINGS, levelOverride: { endgame: 'solo' } }, 'endgame')).toBe('solo');
  });
});
