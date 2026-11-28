import { Chess } from 'chess.js';
import type { Color, GameResult, PlayedMove } from '../types';

function parseUci(uci: string): { from: string; to: string; promotion?: string } {
  if (!/^[a-h][1-8][a-h][1-8][qrbn]?$/.test(uci)) throw new Error(`Invalid UCI move: ${uci}`);
  return { from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci[4] };
}

export class GameState {
  readonly userColor: Color;
  private chess: Chess;
  private played: PlayedMove[] = [];
  private readonly customStart: boolean;

  constructor(userColor: Color, startFen?: string, moves: string[] = []) {
    this.userColor = userColor;
    this.chess = startFen ? new Chess(startFen) : new Chess();
    this.customStart = this.chess.fen() !== new Chess().fen();
    for (const m of moves) this.play(m);
  }

  fen(): string { return this.chess.fen(); }
  turn(): Color { return this.chess.turn(); }
  history(): PlayedMove[] { return [...this.played]; }
  isUserTurn(): boolean { return this.turn() === this.userColor; }
  /** True when the game began from a position other than the standard start (a ?fen= practice game). */
  hasCustomStart(): boolean { return this.customStart; }

  legalMovesFrom(square: string): string[] {
    return this.chess
      .moves({ square: square as never, verbose: true })
      .map((m) => m.from + m.to + (m.promotion ?? ''));
  }

  needsPromotion(from: string, to: string): boolean {
    return this.chess
      .moves({ square: from as never, verbose: true })
      .some((m) => m.to === to && m.promotion !== undefined);
  }

  play(uci: string): PlayedMove {
    const fenBefore = this.chess.fen();
    const m = this.chess.move(parseUci(uci)); // throws on illegal
    const move: PlayedMove = {
      san: m.san,
      uci: m.from + m.to + (m.promotion ?? ''),
      fenBefore,
      fenAfter: this.chess.fen(),
      color: m.color,
    };
    this.played.push(move);
    return move;
  }

  canTakeBack(): boolean {
    return this.played.some((m) => m.color === this.userColor);
  }

  /** Undoes the user's last move, plus the opponent's reply if one was made. */
  takeBackUserMove(): PlayedMove[] {
    if (!this.canTakeBack()) return [];
    const removed: PlayedMove[] = [];
    while (this.played.length > 0) {
      const last = this.played.pop()!;
      this.chess.undo();
      removed.unshift(last);
      if (last.color === this.userColor) break;
    }
    return removed;
  }

  result(): GameResult | null {
    const c = this.chess;
    if (c.isCheckmate()) return { winner: c.turn() === 'w' ? 'b' : 'w', reason: 'checkmate' };
    if (c.isStalemate()) return { winner: null, reason: 'stalemate' };
    if (c.isInsufficientMaterial()) return { winner: null, reason: 'insufficient' };
    if (c.isThreefoldRepetition()) return { winner: null, reason: 'repetition' };
    if (c.isDrawByFiftyMoves()) return { winner: null, reason: 'fifty_move' };
    return null;
  }

  toJSON(): { userColor: Color; moves: string[] } {
    return { userColor: this.userColor, moves: this.played.map((m) => m.uci) };
  }
}
