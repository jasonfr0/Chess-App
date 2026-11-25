import { describe, it, expect } from 'vitest';
import { Chess } from 'chess.js';
import { GameState } from '../../src/game/gameState';

const START = new Chess().fen();
const play = (g: GameState, ...ucis: string[]) => ucis.forEach((u) => g.play(u));

describe('GameState moves', () => {
  it('plays legal moves and records SAN; rejects illegal', () => {
    const g = new GameState('w');
    g.play('e2e4');
    expect(g.history()[0].san).toBe('e4');
    expect(() => g.play('e2e5')).toThrow();
  });

  it('castles', () => {
    const g = new GameState('w', 'r3k2r/8/8/8/8/8/8/R3K2R w KQkq - 0 1');
    expect(g.play('e1g1').san).toBe('O-O');
  });

  it('en passant removes the captured pawn', () => {
    const g = new GameState('w', '4k3/8/8/3pP3/8/8/8/4K3 w - d6 0 1');
    g.play('e5d6');
    expect(new Chess(g.fen()).get('d5' as never)).toBeFalsy();
  });

  it('promotion', () => {
    const g = new GameState('w', '4k3/P7/8/8/8/8/8/4K3 w - - 0 1');
    expect(g.needsPromotion('a7', 'a8')).toBe(true);
    expect(g.needsPromotion('e1', 'e2')).toBe(false);
    g.play('a7a8n');
    expect(new Chess(g.fen()).get('a8' as never)).toMatchObject({ type: 'n', color: 'w' });
  });

  it('legalMovesFrom lists uci moves', () => {
    const g = new GameState('w');
    expect(g.legalMovesFrom('e2').sort()).toEqual(['e2e3', 'e2e4']);
    expect(g.isUserTurn()).toBe(true);
    expect(g.turn()).toBe('w');
  });
});

describe('GameState results', () => {
  it('checkmate', () => {
    const g = new GameState('w');
    play(g, 'f2f3', 'e7e5', 'g2g4', 'd8h4');
    expect(g.result()).toEqual({ winner: 'b', reason: 'checkmate' });
  });
  it('stalemate', () => {
    expect(new GameState('w', '7k/5Q2/6K1/8/8/8/8/8 b - - 0 1').result()?.reason).toBe('stalemate');
  });
  it('insufficient material', () => {
    expect(new GameState('w', '4k3/8/8/8/8/8/8/4K3 w - - 0 1').result()?.reason).toBe('insufficient');
  });
  it('threefold repetition', () => {
    const g = new GameState('w');
    play(g, 'g1f3', 'g8f6', 'f3g1', 'f6g8', 'g1f3', 'g8f6', 'f3g1', 'f6g8');
    expect(g.result()).toEqual({ winner: null, reason: 'repetition' });
  });
  it('null while in progress', () => {
    expect(new GameState('w').result()).toBeNull();
  });
});

describe('GameState takeback', () => {
  it('undoes 2 plies when opponent replied', () => {
    const g = new GameState('w');
    play(g, 'e2e4', 'e7e5');
    expect(g.takeBackUserMove()).toHaveLength(2);
    expect(g.fen()).toBe(START);
  });
  it('undoes 1 ply when opponent has not replied', () => {
    const g = new GameState('w');
    play(g, 'e2e4');
    expect(g.takeBackUserMove()).toHaveLength(1);
  });
  it('cannot take back on fresh game', () => {
    expect(new GameState('w').canTakeBack()).toBe(false);
  });
  it('black user with no move yet cannot take back', () => {
    const g = new GameState('b');
    g.play('e2e4');
    expect(g.canTakeBack()).toBe(false);
  });
  it('alternating play/takeback returns to start', () => {
    const g = new GameState('w');
    for (let i = 0; i < 3; i++) {
      play(g, 'e2e4', 'e7e5');
      g.takeBackUserMove();
      expect(g.fen()).toBe(START);
    }
  });
});

describe('GameState serialization', () => {
  it('round-trips via toJSON', () => {
    const g = new GameState('w');
    play(g, 'e2e4', 'e7e5', 'g1f3');
    const json = g.toJSON();
    expect(json.userColor).toBe('w');
    expect(new GameState('w', undefined, json.moves).fen()).toBe(g.fen());
  });
});
