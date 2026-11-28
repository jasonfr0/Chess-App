import { describe, it, expect } from 'vitest';
import { suggestLinesOff, SUGGEST_LINES_OFF } from '../../src/profile/attackLines';
import type { SavedGame } from '../../src/storage/db';
import type { Verdict } from '../../src/coach/classify';
import type { Theme } from '../../src/types';

const verdict = (theme: Theme = 'other', flagged = false): Verdict => ({
  flagged, severity: 'ok', cpLoss: 0, area: 'opening', theme, recommendation: 'play_on',
  bestUci: 'e2e4', bestSan: 'e4', refutationSan: [],
});
const g = (i: number, extra: Partial<SavedGame> = {}): SavedGame => ({
  id: 'g' + i, startedAt: i, userColor: 'w', moves: [], verdicts: [verdict()],
  result: { winner: 'w', reason: 'resign' }, attackLinesMoves: 18, userMoves: 20, ...extra,
});

describe('suggestLinesOff', () => {
  it('copy is verbatim', () => {
    expect(SUGGEST_LINES_OFF).toBe("You've been spotting threats well — try turning attack lines off so your moves count toward your progress.");
  });
  it('true for 3 qualifying games', () => {
    expect(suggestLinesOff([g(1), g(2), g(3)])).toBe(true);
  });
  it('uses the 3 most recent finished games', () => {
    expect(suggestLinesOff([g(0, { attackLinesMoves: 0 }), g(1), g(2), g(3)])).toBe(true);
    expect(suggestLinesOff([g(1), g(2), g(3), g(4, { result: null, attackLinesMoves: 0 })])).toBe(true);
  });
  it('false if one game is at 70%', () => {
    expect(suggestLinesOff([g(1), g(2, { attackLinesMoves: 14 }), g(3)])).toBe(false);
  });
  it('false if one game has a flagged hanging_piece', () => {
    expect(suggestLinesOff([g(1), g(2, { verdicts: [verdict('hanging_piece', true)] }), g(3)])).toBe(false);
  });
  it('unflagged inaccuracy with a threat theme does not disqualify', () => {
    expect(suggestLinesOff([g(1), g(2, { verdicts: [verdict('hanging_piece', false)] }), g(3)])).toBe(true);
  });
  it('unflagged blunder/mistake with a threat theme disqualifies', () => {
    for (const severity of ['blunder', 'mistake'] as const) {
      const v = { ...verdict('hanging_piece', false), severity };
      expect(suggestLinesOff([g(1), g(2, { verdicts: [v] }), g(3)])).toBe(false);
    }
  });
  it('clamps the ratio at 1', () => {
    expect(suggestLinesOff([g(1), g(2, { attackLinesMoves: 30, userMoves: 20 }), g(3)])).toBe(true);
  });
  it('false with only 2 games', () => {
    expect(suggestLinesOff([g(1), g(2)])).toBe(false);
  });
  it('old games without the fields count as off; short games do not qualify', () => {
    expect(suggestLinesOff([g(1), g(2), g(3, { attackLinesMoves: undefined, userMoves: undefined })])).toBe(false);
    expect(suggestLinesOff([g(1), g(2), g(3, { userMoves: 9, attackLinesMoves: 9 })])).toBe(false);
  });
  it('ignores teaching games', () => {
    expect(suggestLinesOff([g(1), g(2), g(3), g(4, { mode: 'teach', attackLinesMoves: 0, userMoves: 3 })])).toBe(true);
  });
});
