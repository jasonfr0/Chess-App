import { Chess } from 'chess.js';
import type { Move, Square } from 'chess.js';
import type { Color, PlayedMove, Theme } from '../types';
import type { Verdict } from './classify';
import { positionFacts } from './facts';
import type { HangingPiece, PieceRef, PositionFacts } from './facts';

export interface Explanation {
  whatHappened: string;
  better?: string;
  lesson?: string;
}
export interface MistakeContext {
  verdict: Verdict; move: PlayedMove; factsAfter: PositionFacts;
  themeCount: number; // times this theme was seen before
}

export const THEME_LESSONS: Record<Theme, { title: string; habit: string }> = {
  hanging_piece: { title: 'Left a piece hanging', habit: 'After every move — yours and theirs — ask: what is undefended?' },
  ignored_threat: { title: 'Missed their threat', habit: 'Before you move, look at what their last move attacks.' },
  allowed_fork: { title: 'Walked into a fork', habit: 'Before you move, check where their knights and pawns can jump — could one attack two of your pieces at once?' },
  missed_fork: { title: 'Missed a fork', habit: 'Look for one piece that can attack two things at once.' },
  missed_pin: { title: 'Missed a pin', habit: 'When two of their pieces line up, look for a pin.' },
  missed_mate: { title: 'Missed checkmate', habit: 'Always check every check first — it might be mate.' },
  allowed_mate: { title: 'Allowed checkmate', habit: "Before you move, ask: can they give a check that I can't answer?" },
  early_queen: { title: 'Queen out too early', habit: 'Develop knights and bishops before the queen.' },
  undeveloped: { title: 'Pieces still at home', habit: 'Get every minor piece out before starting an attack.' },
  king_safety: { title: 'King in the open', habit: 'Castle early, and keep the pawns in front of your king.' },
  bad_trade: { title: 'Uneven trade', habit: 'Count what you give and what you get before trading.' },
  endgame_technique: { title: 'Endgame technique', habit: 'In the endgame, activate your king and push passed pawns.' },
  other: { title: 'Better move available', habit: 'Compare your move with the alternatives before you play it.' },
};

/** Why each theme's habit matters, in one plain sentence. Names no square or move, so it never hints at one. */
export const THEME_WHY: Record<Theme, string> = {
  hanging_piece: 'A piece that nothing guards can be taken for nothing, and then you have less to fight with.',
  ignored_threat: 'Their move often makes a threat, and missing it can cost you a piece.',
  allowed_fork: 'A fork attacks two things at once, and you can usually save only one of them.',
  missed_fork: 'They can usually save only one of the two pieces, so you win the other.',
  missed_pin: 'A pinned piece cannot move without losing the piece behind it, so it is easy to attack.',
  missed_mate: 'Checkmate ends the game at once, so it beats every other move.',
  allowed_mate: 'A check you cannot answer is checkmate, and the game is over.',
  early_queen: 'An early queen gets chased by smaller pieces, and each chase lets them bring out another piece.',
  undeveloped: 'An attack with only a few pieces is easy to stop, and the pieces at home cannot help.',
  king_safety: 'A king in the middle is easy to attack, and checks can come before you are ready.',
  bad_trade: 'Pieces are worth different amounts, so a trade can leave you with less than they have.',
  endgame_technique: 'With few pieces left, your king is safe to fight, and a pawn that reaches the end becomes a queen.',
  other: 'Looking at a second idea before you move often finds a stronger one.',
};

export const NAMES: Record<PieceRef['piece'], string> = { p: 'pawn', n: 'knight', b: 'bishop', r: 'rook', q: 'queen', k: 'king' };

const VALUE: Record<PieceRef['piece'], number> = { p: 1, n: 3, b: 3, r: 5, q: 9, k: 100 };
const opposite = (c: Color): Color => (c === 'w' ? 'b' : 'w');
const describe = (p: PieceRef, viewer: Color) => `${p.color === viewer ? 'your' : 'their'} ${NAMES[p.piece]} on ${p.square}`;

function joinList(items: string[]): string {
  return items.length <= 1 ? (items[0] ?? '') : `${items.slice(0, -1).join(', ')} and ${items.at(-1)}`;
}

/** "attacks both A and B" for exactly two targets; "attacks A, B and C" otherwise. */
function attacksList(items: string[]): string {
  return `attacks ${items.length === 2 ? 'both ' : ''}${joinList(items)}`;
}

const capitalise = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

function tryFen(fen: string, uci: string): string | null {
  try {
    const c = new Chess(fen);
    c.move({ from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci[4] });
    return c.fen();
  } catch {
    return null;
  }
}

/** Destination square of a SAN move (null for castling). */
function sanDest(san: string): string | null {
  const m = /([a-h][1-8])(=[QRBN])?[+#]?$/.exec(san);
  return m ? m[1] : null;
}

/** A phrase that is true of this move, derived from chess.js; falls back to a neutral note. */
export function moveNote(fen: string, m: Move): string {
  const color = m.color;
  const names: Record<string, string> = NAMES;
  if (m.san.endsWith('#')) return 'checkmates';
  if (m.captured) {
    return m.flags.includes('e') ? 'captures a pawn en passant' : `captures the ${names[m.captured]} on ${m.to}`;
  }
  if (m.san.endsWith('+')) return 'gives check';
  if (m.san.startsWith('O-O')) return 'castles to safety';
  const after = new Chess(fen);
  after.move(m.san);
  const enemy = opposite(color);
  for (const row of after.board()) {
    for (const p of row) {
      if (!p || p.color !== color || p.type === 'k' || p.square === m.to) continue;
      const sq = p.square as Square;
      if (after.attackers(sq, enemy).length > 0 && after.attackers(sq, color).includes(m.to as Square)) {
        return `defends your ${names[p.type]} on ${p.square}`;
      }
    }
  }
  const homeRank = color === 'w' ? '1' : '8';
  if ((m.piece === 'n' || m.piece === 'b') && m.from[1] === homeRank && m.to[1] !== homeRank) {
    return `develops your ${names[m.piece]}`;
  }
  return 'a solid move';
}

/** The first refutation move's destination, if it lands on one of the mover's pieces. */
function capturedPiece(ctx: MistakeContext): HangingPiece | null {
  const { verdict, move, factsAfter } = ctx;
  const mine = factsAfter.hanging.filter((p) => p.color === move.color);
  const dest = verdict.refutationSan[0] ? sanDest(verdict.refutationSan[0]) : null;
  const hit = mine.find((p) => p.square === dest);
  if (hit) return hit;
  return mine.length === 1 ? mine[0] : null;
}

function forkAfterReply(ctx: MistakeContext): { attacker: PieceRef; targets: PieceRef[] } | null {
  const { verdict, move } = ctx;
  const reply = verdict.refutationSan[0];
  if (!reply) return null;
  try {
    const c = new Chess(move.fenAfter);
    const m = c.move(reply);
    return positionFacts(c.fen()).forks.find((f) => f.attacker.square === m.to && f.attacker.color === m.color) ?? null;
  } catch {
    return null;
  }
}

export function betterReason(ctx: MistakeContext): string {
  const { verdict, move } = ctx;
  const best = verdict.bestSan;
  const fenBest = tryFen(move.fenBefore, verdict.bestUci);
  const facts = fenBest ? positionFacts(fenBest) : null;
  const dest = verdict.bestUci.slice(2, 4);
  switch (verdict.theme) {
    case 'missed_mate':
      return best.endsWith('#') ? `${best} was checkmate.` : `${best} led to a forced checkmate.`;
    case 'missed_fork': {
      const f = facts?.forks.find((x) => x.attacker.square === dest && x.attacker.color === move.color);
      if (f) return `${best} would have ${attacksList(f.targets.map((t) => describe(t, move.color))).replace(/^attacks/, 'attacked')} at once.`;
      break;
    }
    case 'missed_pin':
      if (fenBest) return `${best} would have pinned one of their pieces to a more important one behind it.`;
      break;
    case 'hanging_piece':
    case 'ignored_threat':
      return `${best} was the move the engine preferred; it avoids losing material.`;
  }
  return `${best} was the engine's top choice here.`;
}

/** "Free" only when nothing defends it; a guarded piece attacked by a cheaper one "can be won". */
function loss(p: HangingPiece, viewer: Color): string {
  if (p.reason === 'undefended') return 'can be taken for free';
  return `can be won: ${describe(p.attacker, viewer)} can take it, and a ${NAMES[p.attacker.piece]} is worth less than a ${NAMES[p.piece]}`;
}

/**
 * What the opponent's reply does, checked with chess.js: mate, a capture, a check, or an attack on
 * one of the user's pieces that it could then win. Null when none of these is true.
 */
function replyNote(ctx: MistakeContext, reply: string): string | null {
  const { move } = ctx;
  try {
    const c = new Chess(move.fenAfter);
    const m = c.move(reply);
    if (m.san.endsWith('#')) return 'It is checkmate.';
    if (m.captured) {
      const sq = m.isEnPassant() ? m.to[0] + m.from[1] : m.to;
      return `It takes your ${NAMES[m.captured]} on ${sq}.`;
    }
    if (m.san.endsWith('+')) return 'It gives check.';
    const uci = m.from + m.to + (m.promotion ?? '');
    const facts = positionFacts(c.fen());
    const hanging = new Set(facts.hanging.filter((p) => p.color === move.color).map((p) => p.square));
    const target = facts.attackedBy(uci).filter((t) => t.piece !== 'k' && hanging.has(t.square))
      .sort((a, b) => VALUE[b.piece] - VALUE[a.piece])[0];
    return target ? `It attacks ${describe(target, move.color)}.` : null;
  } catch {
    return null;
  }
}

function whatHappenedMistake(ctx: MistakeContext): string {
  const { verdict, move } = ctx;
  // Only the opponent's reply: the rest of the engine line is the user's own next moves.
  const [reply] = verdict.refutationSan;
  if (!reply) return `After ${move.san}, the engine found a stronger plan for them.`;
  switch (verdict.theme) {
    case 'hanging_piece':
    case 'ignored_threat': {
      const p = capturedPiece(ctx);
      if (p) {
        const lead = verdict.theme === 'hanging_piece'
          ? `After ${move.san}, ${describe(p, move.color)} ${loss(p, move.color)}.`
          : `${capitalise(describe(p, move.color))} was already under attack and ${move.san} did not save it.`;
        return `${lead} They can play ${reply}.`;
      }
      break;
    }
    case 'allowed_mate':
      return `After ${move.san}, they can play ${reply}, which starts a forced checkmate against you.`;
    case 'allowed_fork': {
      const f = forkAfterReply(ctx);
      if (f) {
        return `After ${move.san}, they can play ${reply}, and their ${NAMES[f.attacker.piece]} on ${f.attacker.square} ${attacksList(f.targets.map((t) => describe(t, move.color)))}.`;
      }
      break;
    }
  }
  const note = replyNote(ctx, reply);
  return note ? `After ${move.san}, they can play ${reply}. ${note}` : `After ${move.san}, the engine's best answer for them is ${reply}.`;
}

/**
 * The mistake card: what the move allows (the opponent's reply and checked facts) and the theme's
 * habit with its why. It never names the better move: the user may still take back and look for it.
 */
export function mistakeTemplate(ctx: MistakeContext): Explanation {
  const { verdict, themeCount } = ctx;
  const lesson = THEME_LESSONS[verdict.theme];
  const prefix = themeCount >= 2 ? `This keeps coming up (${themeCount + 1} times). ` : '';
  return {
    whatHappened: whatHappenedMistake(ctx),
    lesson: `${prefix}${lesson.title}: ${lesson.habit} ${THEME_WHY[verdict.theme]}`,
  };
}

