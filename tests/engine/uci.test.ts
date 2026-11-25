import { describe, it, expect } from 'vitest';
import { parseInfo, parseBestMove } from '../../src/engine/uci';

describe('parseInfo', () => {
  it('parses a cp score line', () => {
    expect(parseInfo('info depth 12 seldepth 18 multipv 2 score cp -35 nodes 1 pv e7e5 g1f3')).toEqual({
      multipv: 2, depth: 12, line: { uci: ['e7e5', 'g1f3'], cp: -35, mate: null },
    });
  });
  it('parses a mate score', () => {
    const r = parseInfo('info depth 8 multipv 1 score mate -3 nodes 1 pv h7h8');
    expect(r?.line).toEqual({ uci: ['h7h8'], cp: null, mate: -3 });
  });
  it('defaults multipv to 1', () => {
    expect(parseInfo('info depth 5 score cp 10 pv e2e4')?.multipv).toBe(1);
  });
  it('returns null without pv', () => {
    expect(parseInfo('info depth 12 score cp 10 nodes 5')).toBeNull();
    expect(parseInfo('readyok')).toBeNull();
  });
});

describe('parseBestMove', () => {
  it('extracts the move', () => expect(parseBestMove('bestmove e2e4 ponder e7e5')).toBe('e2e4'));
  it('returns null for (none)', () => expect(parseBestMove('bestmove (none)')).toBeNull());
  it('returns null for other lines', () => expect(parseBestMove('info depth 1')).toBeNull());
});

describe('parseInfo bounds', () => {
  it('skips lowerbound/upperbound lines', () => {
    expect(parseInfo('info depth 10 multipv 1 score cp 50 lowerbound nodes 1 pv e2e4')).toBeNull();
    expect(parseInfo('info depth 10 multipv 1 score cp 50 upperbound nodes 1 pv e2e4')).toBeNull();
  });
});
