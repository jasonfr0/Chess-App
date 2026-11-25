import { describe, it, expect } from 'vitest';
import { Chess } from 'chess.js';
import { areaOf, classifyMove } from '../../src/coach/classify';
import type { Analysis, CoachLevel, EngineLine, PlayedMove } from '../../src/types';

const START = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';

function play(fen: string, uci: string): PlayedMove {
  const c = new Chess(fen);
  const color = c.turn();
  const m = c.move({ from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci[4] });
  return { san: m.san, uci, fenBefore: fen, fenAfter: c.fen(), color };
}

function history(sans: string[]): PlayedMove[] {
  const c = new Chess();
  return sans.map((san) => {
    const fenBefore = c.fen();
    const color = c.turn();
    const m = c.move(san);
    return { san: m.san, uci: m.from + m.to + (m.promotion ?? ''), fenBefore, fenAfter: c.fen(), color };
  });
}

const line = (uci: string[], cp: number | null, mate: number | null = null): EngineLine => ({ uci, cp, mate });
const analysis = (fen: string, lines: EngineLine[]): Analysis => ({ fen, depth: 12, lines });

interface Case {
  fenBefore: string; uci: string; best: EngineLine; reply: EngineLine;
  level?: CoachLevel; plyCount?: number; inBook?: boolean; history?: PlayedMove[];
}

function run(c: Case) {
  const move = play(c.fenBefore, c.uci);
  return classifyMove({
    fenBefore: c.fenBefore,
    move,
    before: analysis(c.fenBefore, [c.best]),
    after: analysis(move.fenAfter, [c.reply]),
    history: c.history ?? [],
    level: c.level ?? 'full',
    plyCount: c.plyCount ?? 30,
    inBook: c.inBook ?? false,
  });
}

// White to move; Ne5?? puts the knight where the d6 pawn takes it.
const KNIGHT_EN_PRISE: Case = {
  fenBefore: '4k3/8/3p4/8/8/5N2/8/4K3 w - - 0 1',
  uci: 'f3e5',
  best: line(['e1e2'], 300),
  reply: line(['d6e5', 'e1e2'], 10), // black POV: +10 => mover -10 => loss 310
};

// White to move, down a rook. Rd3?? allows ...Ra1+ Rd1 Rxd1# (mate in 2).
const BACK_RANK: Case = {
  fenBefore: 'rr4k1/5ppp/8/8/8/8/5PPP/3R2K1 w - - 0 1',
  uci: 'd1d3',
  best: line(['h2h3'], -500),
  reply: line(['a8a1', 'd3d1', 'a1d1'], null, 2),
  plyCount: 40,
};

describe('classifyMove severity and flagging', () => {
  it('leaving a knight en prise is a flagged blunder, hanging_piece, take_back', () => {
    const v = run(KNIGHT_EN_PRISE);
    expect(v.cpLoss).toBe(310);
    expect(v.severity).toBe('blunder');
    expect(v.flagged).toBe(true);
    expect(v.theme).toBe('hanging_piece');
    expect(v.recommendation).toBe('take_back');
    expect(v.bestUci).toBe('e1e2');
    expect(v.bestSan).toBe('Ke2');
    expect(v.refutationSan).toEqual(['dxe5', 'Ke2']);
  });

  const quiet: Case = { fenBefore: START, uci: 'a2a3', best: line(['e2e4'], 30), reply: line(['e7e5'], 130), plyCount: 0 };

  it('cpLoss 160 with no tactic is a flagged mistake, play_on', () => {
    const v = run(quiet);
    expect(v.cpLoss).toBe(160);
    expect(v.severity).toBe('mistake');
    expect(v.flagged).toBe(true);
    expect(v.theme).toBe('other');
    expect(v.recommendation).toBe('play_on');
    expect(v.area).toBe('opening');
  });

  it('cpLoss 160 at level light is not flagged', () => {
    expect(run({ ...quiet, level: 'light' }).flagged).toBe(false);
  });

  it('cpLoss 40 is ok and not flagged', () => {
    const v = run({ ...quiet, reply: line(['e7e5'], 10) });
    expect(v.cpLoss).toBe(40);
    expect(v.severity).toBe('ok');
    expect(v.flagged).toBe(false);
    expect(v.recommendation).toBe('play_on');
  });

  it('cpLoss 60 is an inaccuracy, not flagged at full without a principle violation', () => {
    const v = run({ ...quiet, reply: line(['e7e5'], 30) });
    expect(v.severity).toBe('inaccuracy');
    expect(v.flagged).toBe(false);
  });

  it('a move allowing mate-in-2 is allowed_mate and take_back, flagged at every level but solo', () => {
    for (const level of ['full', 'guided', 'light', 'solo'] as CoachLevel[]) {
      const v = run({ ...BACK_RANK, level });
      expect(v.severity).toBe('blunder');
      expect(v.theme).toBe('allowed_mate');
      expect(v.recommendation).toBe('take_back');
      expect(v.cpLoss).toBe(2000);
      expect(v.flagged).toBe(level !== 'solo');
    }
  });

  it('eval before +900 and cpLoss 200 is not flagged', () => {
    const v = run({ fenBefore: START, uci: 'a2a3', best: line(['e2e4'], 900), reply: line(['e7e5'], -700), plyCount: 0 });
    expect(v.cpLoss).toBe(200);
    expect(v.flagged).toBe(false);
  });

  it('eval before -900 still flags a mate-related blunder', () => {
    const v = run({ ...BACK_RANK, best: line(['h2h3'], -900) });
    expect(v.theme).toBe('allowed_mate');
    expect(v.flagged).toBe(true);
  });

  it('a book move with cpLoss 70 is not flagged', () => {
    const v = run({ ...quiet, reply: line(['e7e5'], 40), inBook: true });
    expect(v.cpLoss).toBe(70);
    expect(v.flagged).toBe(false);
  });

  it('refutationSan has at most 4 plies', () => {
    const v = run({
      ...quiet,
      reply: line(['e7e5', 'e2e4', 'g8f6', 'g1f3', 'b8c6', 'f1c4'], 130),
    });
    expect(v.refutationSan).toEqual(['e5', 'e4', 'Nf6', 'Nf3']);
  });

  it('negative cp loss (engine noise) is clamped to 0', () => {
    const v = run({ ...quiet, reply: line(['e7e5'], -50) });
    expect(v.cpLoss).toBe(0);
    expect(v.severity).toBe('ok');
  });
});

describe('classifyMove mates and terminal positions', () => {
  // White to move: Qh5xf7 is mate (scholar's mate setup).
  const SCHOLAR = 'r1bqkbnr/pppp1ppp/2n5/4p2Q/2B1P3/8/PPPP1PPP/RNB1K1NR w KQkq - 2 4';

  it('delivering mate (after has no lines) is ok', () => {
    const move = play(SCHOLAR, 'h5f7');
    const v = classifyMove({
      fenBefore: SCHOLAR, move,
      before: analysis(SCHOLAR, [line(['h5f7'], null, 1)]),
      after: analysis(move.fenAfter, []),
      history: [], level: 'full', plyCount: 6, inBook: false,
    });
    expect(v.severity).toBe('ok');
    expect(v.cpLoss).toBe(0);
    expect(v.flagged).toBe(false);
  });

  it('missing mate-in-1 is a missed_mate blunder', () => {
    const v = run({ fenBefore: SCHOLAR, uci: 'b1c3', best: line(['h5f7'], null, 1), reply: line(['g8f6'], -300), plyCount: 6 });
    expect(v.severity).toBe('blunder');
    expect(v.theme).toBe('missed_mate');
    expect(v.recommendation).toBe('take_back');
    expect(v.bestSan).toBe('Qxf7#');
  });

  it('a slower mate is not a missed mate', () => {
    const v = run({ fenBefore: SCHOLAR, uci: 'b1c3', best: line(['h5f7'], null, 1), reply: line(['g8f6'], null, -3), plyCount: 6 });
    expect(v.severity).toBe('ok');
    expect(v.flagged).toBe(false);
  });

  it('stalemating move scores 0 and empty before lines give an unflagged ok', () => {
    // Qb7# was available; Qb6 stalemates the black king on a8.
    const fen = 'k7/8/2K5/8/8/8/8/1Q6 w - - 0 1';
    const move = play(fen, 'b1b6'); // stalemate
    expect(new Chess(move.fenAfter).isStalemate()).toBe(true);
    const v = classifyMove({
      fenBefore: fen, move,
      before: analysis(fen, [line(['b1b7'], null, 1)]),
      after: analysis(move.fenAfter, []),
      history: [], level: 'full', plyCount: 80, inBook: false,
    });
    expect(v.cpLoss).toBe(2000);
    expect(v.theme).toBe('missed_mate');

    const empty = classifyMove({
      fenBefore: fen, move,
      before: analysis(fen, []), after: analysis(move.fenAfter, []),
      history: [], level: 'full', plyCount: 80, inBook: false,
    });
    expect(empty).toMatchObject({ flagged: false, severity: 'ok', cpLoss: 0, bestUci: 'b1b6', bestSan: 'Qb6' });
  });
});

describe('classifyMove themes', () => {
  it('ignored_threat when a hanging piece is left hanging', () => {
    const v = run({
      fenBefore: '4k3/8/3p4/4N3/8/8/8/4K3 w - - 0 1', uci: 'e1e2',
      best: line(['e5c6'], 300), reply: line(['d6e5'], 0),
    });
    expect(v.theme).toBe('ignored_threat');
    expect(v.recommendation).toBe('take_back');
  });

  it('missed_fork when the best move is a knight fork', () => {
    const v = run({
      fenBefore: 'r3k3/8/8/1N6/8/8/8/4K3 w - - 0 1', uci: 'e1e2',
      best: line(['b5c7', 'e8d7', 'c7a8'], 500), reply: line(['a8a5'], 0),
    });
    expect(v.theme).toBe('missed_fork');
    expect(v.severity).toBe('blunder');
  });

  it('missed_pin when the best move pins a piece to the king', () => {
    const v = run({
      fenBefore: '4k3/p7/2n5/8/8/8/8/4KB2 w - - 0 1', uci: 'e1e2',
      best: line(['f1b5'], 200), reply: line(['e8e7'], 0),
    });
    expect(v.theme).toBe('missed_pin');
    expect(v.severity).toBe('mistake');
    expect(v.recommendation).toBe('play_on');
  });

  it('a new early queen move is flagged at cpLoss 80 with theme early_queen', () => {
    const h = history(['e4', 'e5']);
    const fen = h[1].fenAfter;
    const v = run({ fenBefore: fen, uci: 'd1h5', best: line(['g1f3'], 40), reply: line(['b8c6'], 40), history: h, plyCount: 2 });
    expect(v.severity).toBe('inaccuracy');
    expect(v.theme).toBe('early_queen');
    expect(v.flagged).toBe(true);
    expect(v.recommendation).toBe('play_on');
  });

  it('principle violations are not flagged at level light', () => {
    const h = history(['e4', 'e5']);
    const v = run({ fenBefore: h[1].fenAfter, uci: 'd1h5', best: line(['g1f3'], 40), reply: line(['b8c6'], 40), history: h, plyCount: 2, level: 'light' });
    expect(v.flagged).toBe(false);
  });

  it('bad_trade when the refutation wins material without a hanging piece', () => {
    // Rh2?? allows ...Nf3+ forking king and rook.
    const v = run({
      fenBefore: '4k3/8/8/8/3n4/8/8/4K2R w - - 0 1', uci: 'h1h2',
      best: line(['e1d2'], 200), reply: line(['d4f3', 'e1e2', 'f3h2'], 300),
    });
    expect(v.theme).toBe('bad_trade');
    expect(v.severity).toBe('blunder');
  });

  it('endgame_technique for a quiet endgame mistake', () => {
    const w = run({
      fenBefore: '4k3/r7/8/8/8/8/1R6/4K3 w - - 0 1', uci: 'e1f1',
      best: line(['e1d1'], 0), reply: line(['e8f8'], 200), plyCount: 60,
    });
    expect(w.area).toBe('endgame');
    expect(w.theme).toBe('endgame_technique');
  });
});

describe('areaOf', () => {
  it('start position at ply 0 is opening', () => {
    expect(areaOf(START, 0, false)).toBe('opening');
  });
  it('in-book is opening even late', () => {
    expect(areaOf(START, 30, true)).toBe('opening');
  });
  it('full material out of book at ply 30 is middlegame', () => {
    expect(areaOf(START, 30, false)).toBe('middlegame');
  });
  it('king and rook vs king and rook at ply 60 is endgame', () => {
    expect(areaOf('4k3/r7/8/8/8/8/R7/4K3 w - - 0 1', 60, false)).toBe('endgame');
  });
});
