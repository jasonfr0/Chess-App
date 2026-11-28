import { describe, it, expect } from 'vitest';
import { emptyProfile, recordMove, summary, levelFor, migrateProfile, recordTeachTheme, PROFILE_VERSION, RESET_NOTICE } from '../../src/profile/profile';
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

  it('records bad by severity, independent of the coach level', () => {
    let p = emptyProfile();
    p = recordMove(p, v({ severity: 'mistake', cpLoss: 200 }), ctx(1)); // not flagged (e.g. at solo)
    p = recordMove(p, v({ severity: 'blunder', cpLoss: 900 }), ctx(2));
    p = recordMove(p, v({ severity: 'inaccuracy', cpLoss: 80 }), ctx(3));
    p = recordMove(p, v(), ctx(4));
    expect(p.moves.middlegame.map((m) => m.bad)).toEqual([true, true, false, false]);
    expect(p.moves.middlegame.map((m) => m.flagged)).toEqual([false, false, false, false]);
  });

  it('an assisted move is never good but can still be bad', () => {
    let p = emptyProfile();
    p = recordMove(p, v(), { ...ctx(1), assisted: true });
    p = recordMove(p, v({ severity: 'blunder', cpLoss: 500 }), { ...ctx(2), assisted: true });
    expect(p.moves.middlegame).toEqual([
      { good: false, flagged: false, bad: false, assisted: true, at: 1000 },
      { good: false, flagged: false, bad: true, assisted: true, at: 1000 },
    ]);
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

describe('migrateProfile', () => {
  const v1 = () => {
    const p = emptyProfile();
    delete p.version;
    p.levels = { opening: 'guided', middlegame: 'guided', endgame: 'guided' };
    p.themes.allowed_fork.count = 3;
    p.levelChangedAt = { opening: 12 };
    return p;
  };
  it('resets a v1 profile once, keeping themes and moves', () => {
    const { profile, reset } = migrateProfile(v1());
    expect(reset).toBe(true);
    expect(profile.levels).toEqual({ opening: 'full', middlegame: 'full', endgame: 'light' });
    expect(profile.themes.allowed_fork.count).toBe(3);
    expect(profile.levelChangedAt).toBeUndefined();
    expect('levelChangedAt' in profile).toBe(false);
    expect(profile.version).toBe(PROFILE_VERSION);
  });
  it('is idempotent and returns the same object the second time', () => {
    const first = migrateProfile(v1()).profile;
    const second = migrateProfile(first);
    expect(second.reset).toBe(false);
    expect(second.profile).toBe(first);
  });
  it('emptyProfile is already version 2', () => {
    expect(emptyProfile().version).toBe(2);
    expect(PROFILE_VERSION).toBe(2);
    expect(migrateProfile(emptyProfile()).reset).toBe(false);
  });
  it('notice text', () => {
    expect(RESET_NOTICE).toBe("Coaching levels were reset: earlier games showed suggested moves, so they couldn't measure your own play.");
  });
});

describe('recordTeachTheme', () => {
  it('adds a flagged verdict to teachCount/teachExamples and touches nothing else', () => {
    const p = emptyProfile();
    const out = recordTeachTheme(p, flaggedV('hanging_piece'), ctx(3, 5000));
    const t = out.themes.hanging_piece;
    expect(t.teachCount).toBe(1);
    expect(t.teachExamples).toEqual([{ gameId: 'g1', ply: 3, fen: 'fen3' }]);
    expect(t.count).toBe(p.themes.hanging_piece.count);
    expect(t.examples).toEqual(p.themes.hanging_piece.examples);
    expect(t.lastSeen).toBe(p.themes.hanging_piece.lastSeen);
    expect(out.moves).toEqual(p.moves);
    expect(out.levels).toEqual(p.levels);
  });
  it('returns an equal profile for an unflagged verdict', () => {
    const p = emptyProfile();
    expect(recordTeachTheme(p, v(), ctx(1))).toEqual(p);
  });
  it('keeps the last 10 teach examples', () => {
    let p = emptyProfile();
    for (let i = 0; i < 11; i++) p = recordTeachTheme(p, flaggedV('other'), ctx(i));
    expect(p.themes.other.teachCount).toBe(11);
    expect(p.themes.other.teachExamples).toHaveLength(10);
    expect(p.themes.other.teachExamples![0].ply).toBe(1);
  });
});
