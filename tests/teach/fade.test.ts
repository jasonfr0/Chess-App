import { describe, it, expect } from 'vitest';
import { FADE, emptyTeachState, modeFor, recordTurn, finishGame, topicChanges } from '../../src/teach/fade';
import type { TeachState, TeachTopic } from '../../src/types';

const live: TeachState = { gamesFinished: 3, topics: {} };
const showTurn = { mode: 'show' as const, flagged: false, openedOptions: false };
const hit = { mode: 'guide' as const, flagged: false, openedOptions: false };
const miss = { mode: 'guide' as const, flagged: true, openedOptions: false };

function repeat(s: TeachState, topic: TeachTopic, turn: Parameters<typeof recordTurn>[2], n: number): TeachState {
  let cur = s;
  for (let i = 0; i < n; i++) cur = recordTurn(cur, topic, turn);
  return cur;
}

describe('teaching fade', () => {
  it('everything is show in the first 3 games', () => {
    const s: TeachState = { gamesFinished: 2, topics: { endgame: { mode: 'guide', shown: 0, need: 5, recent: [] } } };
    expect(modeFor(s, 'endgame')).toBe('show');
    expect(recordTurn(s, 'endgame', hit)).toEqual(s);
  });

  it('opening and other never leave show', () => {
    for (const t of ['opening', 'other'] as const) {
      const s = repeat(live, t, showTurn, 10);
      expect(modeFor(s, t)).toBe('show');
      expect(s.topics).toEqual({});
    }
  });

  it('endgame starts in guide once fading begins', () => {
    expect(modeFor(live, 'endgame')).toBe('guide');
    expect(modeFor(live, 'safety')).toBe('show');
  });

  it('5 shown turns start a guide trial', () => {
    expect(modeFor(repeat(live, 'safety', showTurn, FADE.SHOWN_BEFORE_TRIAL - 1), 'safety')).toBe('show');
    expect(modeFor(repeat(live, 'safety', showTurn, FADE.SHOWN_BEFORE_TRIAL), 'safety')).toBe('guide');
  });

  it('two misses in the last four guide turns fall back', () => {
    let s = repeat(live, 'safety', showTurn, 5);
    for (const t of [hit, miss, hit, miss]) s = recordTurn(s, 'safety', t);
    expect(modeFor(s, 'safety')).toBe('show');
    expect(s.topics.safety?.need).toBe(FADE.SHOWN_AFTER_FALL_BACK);
    expect(modeFor(repeat(s, 'safety', showTurn, 2), 'safety')).toBe('show');
    expect(modeFor(repeat(s, 'safety', showTurn, 3), 'safety')).toBe('guide');
  });

  it('a miss ages out of the window', () => {
    let s = repeat(live, 'safety', showTurn, 5);
    s = recordTurn(s, 'safety', miss);
    s = repeat(s, 'safety', hit, 4);
    s = recordTurn(s, 'safety', miss);
    expect(modeFor(s, 'safety')).toBe('guide');
  });

  it('opening the options is a miss even with a good move', () => {
    const opened = { mode: 'guide' as const, flagged: false, openedOptions: true };
    let s = repeat(live, 'safety', showTurn, 5);
    s = repeat(s, 'safety', opened, 2);
    expect(modeFor(s, 'safety')).toBe('show');
  });

  it('finishGame counts from undefined', () => {
    expect(finishGame(undefined).gamesFinished).toBe(1);
    expect(emptyTeachState()).toEqual({ gamesFinished: 0, topics: {} });
  });

  it('does not mutate its input', () => {
    const before = JSON.parse(JSON.stringify(live));
    recordTurn(live, 'safety', showTurn);
    finishGame(live);
    expect(live).toEqual(before);
  });

  it('topicChanges reports safety -> guide', () => {
    const before = repeat(live, 'safety', showTurn, 4);
    const after = recordTurn(before, 'safety', showTurn);
    expect(topicChanges(before, after)).toEqual([{ topic: 'safety', to: 'guide' }]);
    expect(topicChanges(live, live)).toEqual([]);
  });
});
