import { describe, it, expect } from 'vitest';
import { topicOf, TOPIC_LABEL } from '../../src/teach/topic';
import type { Fundamental, Reasons } from '../../src/coach/reasons';

const r = (fundamentals: Fundamental[], extra: Partial<Reasons> = {}): Reasons =>
  ({ opening: null, principle: null, fundamentals, effect: 'x', ...extra });

describe('topicOf', () => {
  it('in book wins over everything', () => {
    expect(topicOf({ inBook: true, area: 'endgame', reasons: r(['wins_material'], { checkmate: true }) })).toBe('opening');
    expect(topicOf({ inBook: true, area: 'opening', reasons: null })).toBe('opening');
  });
  it('no reasons in an endgame is endgame', () => {
    expect(topicOf({ inBook: false, area: 'endgame', reasons: null })).toBe('endgame');
  });
  it('no reasons elsewhere is other', () => {
    expect(topicOf({ inBook: false, area: 'middlegame', reasons: null })).toBe('other');
  });
  it('checkmate is checks', () => {
    expect(topicOf({ inBook: false, area: 'endgame', reasons: r(['wins_material'], { checkmate: true }) })).toBe('checks');
  });
  it('defends is safety', () => {
    expect(topicOf({ inBook: false, area: 'middlegame', reasons: r(['defends', 'wins_material']) })).toBe('safety');
  });
  it('wins material is captures', () => {
    expect(topicOf({ inBook: false, area: 'middlegame', reasons: r(['wins_material']) })).toBe('captures');
  });
  it('check threats and attacks are checks', () => {
    expect(topicOf({ inBook: false, area: 'middlegame', reasons: r(['check_threat']) })).toBe('checks');
    expect(topicOf({ inBook: false, area: 'middlegame', reasons: r(['attacks']) })).toBe('checks');
  });
  it('develops, centre and king safety are development', () => {
    for (const f of ['develops', 'centre', 'king_safety'] as const) {
      expect(topicOf({ inBook: false, area: 'opening', reasons: r([f]) })).toBe('development');
    }
  });
  it('other ideas in an endgame are endgame', () => {
    expect(topicOf({ inBook: false, area: 'endgame', reasons: r(['king_activity']) })).toBe('endgame');
    expect(topicOf({ inBook: false, area: 'endgame', reasons: r([]) })).toBe('endgame');
  });
  it('other ideas elsewhere are other', () => {
    expect(topicOf({ inBook: false, area: 'middlegame', reasons: r(['passed_pawn']) })).toBe('other');
    expect(topicOf({ inBook: false, area: 'middlegame', reasons: r(['trade_when_ahead']) })).toBe('other');
  });
  it('every topic has a label', () => {
    expect(Object.keys(TOPIC_LABEL)).toHaveLength(7);
  });
});
