import { describe, it, expect } from 'vitest';
import { positionText, TOPIC_FOCUS } from '../../src/teach/position';
import { positionFacts } from '../../src/coach/facts';
import { findJargon } from '../../src/coach/jargon';
import { moveLeaks } from '../../src/coach/leaks';
import type { TeachMode, TeachTopic } from '../../src/types';

const START = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
const base = { userColor: 'w' as const, topic: 'other' as TeachTopic, lineName: null, plan: null };
const TOPICS: TeachTopic[] = ['opening', 'safety', 'captures', 'checks', 'development', 'endgame', 'other'];

describe('positionText', () => {
  it("names the user's attacked piece", () => {
    const fen = 'rnbqkbnr/pppp1ppp/8/4p3/3N4/8/PPPPPPPP/RNBQKB1R w KQkq - 0 1';
    expect(positionFacts(fen).hanging).toContainEqual(expect.objectContaining({ square: 'd4', piece: 'n', color: 'w', reason: 'undefended' }));
    for (const mode of ['show', 'guide'] as TeachMode[]) {
      const text = positionText({ ...base, fen, mode });
      expect(text).toContain('Your knight on d4 can be taken for free.');
    }
  });

  it('does not call a guarded piece free', () => {
    // White queen on d4 is guarded by the knight on f3 but attacked by the pawn on e5.
    const fen = 'rnbqkbnr/pppp1ppp/8/4p3/3Q4/5N2/PPPPPPPP/RNB1KB1R w KQkq - 0 1';
    expect(positionFacts(fen).hanging).toContainEqual(expect.objectContaining({ square: 'd4', reason: 'attacked_by_lower' }));
    expect(positionText({ ...base, fen, mode: 'show' })).not.toContain('for free');
  });

  it('guide mode does not point at a free enemy piece', () => {
    const fen = 'rnbqkb1r/pppppppp/8/3n4/4P3/8/PPPP1PPP/RNBQKBNR w KQkq - 0 1';
    expect(positionFacts(fen).hanging).toContainEqual(expect.objectContaining({ square: 'd5', piece: 'n', color: 'b', reason: 'undefended' }));
    const show = positionText({ ...base, fen, mode: 'show' });
    const guide = positionText({ ...base, fen, mode: 'guide' });
    expect(show).toContain('Their knight on d5 is not guarded.');
    expect(guide).not.toContain('Their');
    expect(moveLeaks(guide)).toEqual([]);
  });

  it('in book it names the line and plan', () => {
    const text = positionText({
      ...base, fen: START, mode: 'guide', topic: 'opening', lineName: 'Italian Game', plan: 'Get your pieces out quickly.',
    });
    expect(text).toBe("You're in the Italian Game. Get your pieces out quickly.");
  });

  it('keeps at most two sentences', () => {
    const fen = 'rnbqkbnr/pppp1ppp/8/4p3/3N4/8/PPPPPPPP/RNBQKB1R w KQkq - 0 1';
    const text = positionText({ ...base, fen, mode: 'guide', topic: 'opening', lineName: 'Italian Game', plan: 'Get your pieces out quickly.' });
    expect(text).toBe("Your knight on d4 can be taken for free. You're in the Italian Game.");
  });

  it('every focus line is plain', () => {
    for (const topic of TOPICS) {
      const text = positionText({ ...base, fen: START, mode: 'guide', topic });
      expect(text).toBe(TOPIC_FOCUS[topic]);
      expect(findJargon(text)).toEqual([]);
      expect(moveLeaks(text)).toEqual([]);
    }
  });
  it('names a guarded piece attacked by a cheaper one, after the free ones', () => {
    // Knight on d4 is unguarded; bishop on f4 is guarded by the g3 pawn; the e5 pawn attacks both.
    const fen = 'rnbqkbnr/pppp1ppp/8/4p3/3N1B2/6P1/PPPPPP1P/RN1QKB1R w KQkq - 0 1';
    const hanging = positionFacts(fen).hanging;
    expect(hanging).toContainEqual(expect.objectContaining({ square: 'd4', color: 'w', reason: 'undefended' }));
    expect(hanging).toContainEqual(expect.objectContaining({ square: 'f4', piece: 'b', color: 'w', reason: 'attacked_by_lower' }));
    for (const mode of ['show', 'guide'] as TeachMode[]) {
      const text = positionText({ ...base, fen, mode, lineName: 'Italian Game', plan: 'Get your pieces out quickly.' });
      expect(text).toBe('Your knight on d4 can be taken for free. Your bishop on f4 is attacked by a piece worth less.');
      expect(findJargon(text)).toEqual([]);
      expect(moveLeaks(text)).toEqual([]);
    }
  });

  it('the cheaper-attacker sentence ranks before the line name', () => {
    const fen = 'rnbqkbnr/pppp1ppp/8/4p3/3Q4/5N2/PPPPPPPP/RNB1KB1R w KQkq - 0 1';
    const text = positionText({ ...base, fen, mode: 'guide', lineName: 'Italian Game', plan: 'Get your pieces out quickly.' });
    expect(text).toBe("Your queen on d4 is attacked by a piece worth less. You're in the Italian Game.");
  });

  it("never says it of the opponent's pieces", () => {
    // Black bishop on f5 is guarded by the g6 pawn and attacked by the white e4 pawn.
    const fen = 'rnbqk1nr/pppppp1p/6p1/5b2/4P3/8/PPPP1PPP/RNBQKBNR w KQkq - 0 1';
    expect(positionFacts(fen).hanging).toContainEqual(expect.objectContaining({ square: 'f5', color: 'b', reason: 'attacked_by_lower' }));
    expect(positionText({ ...base, fen, mode: 'show' })).not.toContain('worth less');
  });
});
