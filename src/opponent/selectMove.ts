import { Chess } from 'chess.js';
import type { Analysis, Color, EngineLine } from '../types';
import { bookReplies } from '../openings/repertoire';

export interface OpponentConfig { rating: number; bookChance: number /* default 0.7 */ }

const MATE_CP = 10000;
const clamp = (x: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, x));

const lineCp = (l: EngineLine): number =>
  l.mate !== null ? (l.mate > 0 ? MATE_CP : -MATE_CP) : (l.cp ?? 0);

function tryMove(chess: Chess, uci: string) {
  try {
    return chess.move({ from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci.slice(4, 5) || undefined });
  } catch {
    return null;
  }
}

/** True if playing uci leaves the user (side to move afterwards) a checkmate in one. */
function allowsMateInOne(fen: string, uci: string): boolean {
  const key = `${fen} ${uci}`;
  const hit = mateCache.get(key);
  if (hit !== undefined) return hit;
  const result = computeAllowsMateInOne(fen, uci);
  mateCache.set(key, result);
  return result;
}

const mateCache = new Map<string, boolean>();

function computeAllowsMateInOne(fen: string, uci: string): boolean {
  const chess = new Chess(fen);
  if (!tryMove(chess, uci)) return false;
  return chess.moves().some((san) => {
    chess.move(san);
    const mate = chess.isCheckmate();
    chess.undo();
    return mate;
  });
}

function pickWeighted<T>(items: T[], weights: number[], rng: () => number): T {
  const total = weights.reduce((a, b) => a + b, 0);
  let r = rng() * total;
  for (let i = 0; i < items.length; i++) {
    r -= weights[i];
    if (r < 0) return items[i];
  }
  return items[items.length - 1];
}

function bookMove(fen: string, sanHistory: string[], userColor: Color, cfg: OpponentConfig, rng: () => number): string | null {
  const chess = new Chess(fen);
  if (chess.turn() === userColor) return null;
  const replies = bookReplies(userColor, sanHistory);
  if (replies.length === 0 || !(rng() < cfg.bookChance)) return null;
  const legal = replies.flatMap((node) => {
    let m;
    try { m = new Chess(fen).move(node.san); } catch { m = null; }
    return m ? [{ uci: m.from + m.to + (m.promotion ?? ''), main: node.main }] : [];
  });
  if (legal.length === 0) return null;
  return pickWeighted(legal, legal.map((l) => (l.main ? 2 : 1)), rng).uci;
}

export function selectOpponentMove(
  fen: string, analysis: Analysis, sanHistory: string[], userColor: Color,
  cfg: OpponentConfig, rng: () => number,
): string {
  const book = bookMove(fen, sanHistory, userColor, cfg, rng);
  if (book) return book;

  const lines = analysis.lines.filter((l) => l.uci.length > 0);
  if (lines.length === 0) {
    const chess = new Chess(fen);
    const all = chess.moves({ verbose: true }).map((m) => m.from + m.to + (m.promotion ?? ''));
    const safe = all.filter((u) => !allowsMateInOne(fen, u));
    const pool = safe.length ? safe : all;
    return pool[Math.floor(rng() * pool.length)];
  }

  const isSafe = (l: EngineLine) => !allowsMateInOne(fen, l.uci[0]);
  const best = lineCp(lines[0]);

  // Blunder roll.
  const pBlunder = clamp(0.25 - cfg.rating / 4000, 0.02, 0.2);
  if (rng() < pBlunder) {
    const nonBest = lines.filter((l) => l !== lines[0] && isSafe(l));
    let cands = nonBest.filter((l) => best - lineCp(l) >= 150 && best - lineCp(l) <= 500);
    if (cands.length === 0 && lines.length > 1) {
      const worst = lines.reduce((w, l) => (lineCp(l) < lineCp(w) ? l : w), lines[0]);
      cands = worst !== lines[0] && isSafe(worst) ? [worst] : [];
    }
    if (cands.length > 0) return cands[Math.floor(rng() * cands.length)].uci[0];
  }

  // Softmax over multipv lines, never choosing a move that allows mate in one.
  const safe = lines.filter(isSafe);
  const pool = safe.length ? safe : lines;
  const temperature = clamp(300 - cfg.rating * 0.135, 25, 300);
  const top = Math.max(...pool.map(lineCp));
  const weights = pool.map((l) => Math.exp((lineCp(l) - top) / temperature));
  return pickWeighted(pool, weights, rng).uci[0];
}

export function adjustOpponentRating(current: number, userScoreLastFive: number): number {
  const delta = userScoreLastFive >= 3.5 ? 50 : userScoreLastFive <= 1.5 ? -50 : 0;
  return clamp(current + delta, 400, 2000);
}
