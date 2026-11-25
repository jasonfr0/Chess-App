import { Chess } from 'chess.js';
import type { Square } from 'chess.js';
import type { Engine } from '../engine/engine';
import { lookup } from '../openings/repertoire';
import type { Analysis, Area, CoachLevel, Color, PlayedMove, ProfileSummary, Theme } from '../types';
import type { GameState } from '../game/gameState';
import { areaOf, classifyMove } from './classify';
import type { Verdict } from './classify';
import { positionFacts } from './facts';
import type { PieceRef } from './facts';
import { THEME_LESSONS, mistakeTemplate, preMoveTemplate } from './templates';
import type { Explanation, MistakeContext, PreMoveContext } from './templates';
import { buildPacket } from './claude';
import type { FactPacket } from './claude';

export type Arrow = { from: string; to: string; color: 'green' | 'red' | 'blue' };
export interface CoachMessage {
  id: string; kind: 'pre_move' | 'mistake' | 'consequence' | 'recap' | 'level_change';
  explanation: Explanation; arrows: Arrow[]; source: 'template' | 'claude';
  verdict?: Verdict; blunderCheck?: { prompt: string; answer: string };
}
export interface CoachDeps {
  engine: Engine; explain: (p: FactPacket) => Promise<Explanation | null>;
  levelFor: (a: Area) => CoachLevel; profile: () => ProfileSummary; themeCount: (t: Theme) => number;
}

const ANALYSIS = { depth: 14, multipv: 3 };
const CONSEQUENCE_WINDOW = 6;
const BLUNDER_PROMPT = 'Before you move: what does their last move attack? Is anything of yours undefended?';
const NAMES: Record<PieceRef['piece'], string> = { p: 'pawn', n: 'knight', b: 'bishop', r: 'rook', q: 'queen', k: 'king' };

const opposite = (c: Color): Color => (c === 'w' ? 'b' : 'w');
const arrow = (uci: string, color: Arrow['color']): Arrow => ({ from: uci.slice(0, 2), to: uci.slice(2, 4), color });
const yours = (p: PieceRef) => `your ${NAMES[p.piece]} on ${p.square}`;

function joinList(items: string[]): string {
  return items.length <= 1 ? (items[0] ?? '') : `${items.slice(0, -1).join(', ')} and ${items.at(-1)}`;
}

/** Mover's material minus the opponent's. */
function balance(fen: string, color: Color): number {
  const m = positionFacts(fen).material;
  return color === 'w' ? m.w - m.b : m.b - m.w;
}

/** Plays `uci` from `fen` up to the first unplayable move; SANs and end FEN come from the same replay. */
function replayLine(fen: string, uci: string[]): { sans: string[]; fen: string } {
  const c = new Chess(fen);
  const sans: string[] = [];
  for (const u of uci) {
    try {
      sans.push(c.move({ from: u.slice(0, 2), to: u.slice(2, 4), promotion: u[4] }).san);
    } catch {
      break;
    }
  }
  return { sans, fen: c.fen() };
}

function stubVerdict(fenBefore: string, move: PlayedMove, plyCount: number, inBook: boolean): Verdict {
  let area: Area = 'opening';
  try { area = areaOf(fenBefore, plyCount, inBook); } catch { /* keep the default */ }
  return {
    flagged: false, severity: 'ok', cpLoss: 0, area, theme: 'other', recommendation: 'play_on',
    bestUci: move.uci, bestSan: move.san, refutationSan: [],
  };
}

/**
 * The user's piece the refutation's first move targets, if the facts listed it as hanging AND one of
 * the opponent's moves since the mistake actually captured it on that square.
 */
function lostPiece(move: PlayedMove, refutationUci: string[], since: PlayedMove[]): PieceRef | null {
  const dest = refutationUci[0]?.slice(2, 4);
  if (!dest) return null;
  const piece = positionFacts(move.fenAfter).hanging.find((p) => p.color === move.color && p.square === dest);
  if (!piece) return null;
  const captured = since.some((m) => {
    if (m.color === move.color || m.uci.slice(2, 4) !== dest) return false;
    const there = new Chess(m.fenBefore).get(dest as Square);
    return there?.type === piece.piece && there.color === piece.color;
  });
  return captured ? piece : null;
}

interface Mistake { verdict: Verdict; move: PlayedMove; refutationUci: string[]; plyAfter: number }
interface Tracker { mistake: Mistake; lineSans: string[]; opponentSans: string[]; gain: number; balanceAtMistake: number }

export class Coach {
  private listeners: ((m: CoachMessage) => void)[] = [];
  private nextId = 1;
  private epoch = 0;
  private currentId: string | null = null;
  private cache: { fen: string; analysis: Promise<Analysis> } | null = null;
  private lastMistake: Mistake | null = null;
  private tracker: Tracker | null = null;

  constructor(private deps: CoachDeps) {}

  onUpdate(cb: (m: CoachMessage) => void): void {
    this.listeners.push(cb);
  }

  cancelPending(): void {
    this.epoch++;
    this.currentId = null;
    this.tracker = null;
  }

  async preMove(game: GameState): Promise<CoachMessage | null> {
    this.currentId = null;
    try {
      const history = game.history();
      const lastMove = history.at(-1);
      if (!lastMove || lastMove.color === game.userColor || game.result() !== null) return null;
      const fen = game.fen();
      const book = lookup(game.userColor, history.map((m) => m.san));
      const level = this.deps.levelFor(areaOf(fen, history.length, book !== null));
      if (level === 'light' || level === 'solo') return null;

      const epoch = this.epoch;
      const plies = history.length;
      const analysis = await this.analyse(fen);
      // Cancelled, or the user already moved (or took back) while the engine was thinking.
      if (epoch !== this.epoch || game.fen() !== fen || game.history().length !== plies) return null;

      const facts = positionFacts(fen);
      const ctx: PreMoveContext = { fen, lastMove, facts, analysis, book, level };
      const explanation = preMoveTemplate(ctx);
      const arrows = [arrow(lastMove.uci, 'blue')];
      const best = analysis.lines[0]?.uci[0];
      if (best) arrows.push(arrow(best, 'green'));
      const message: CoachMessage = { id: this.newId(), kind: 'pre_move', explanation, arrows, source: 'template' };
      if (level === 'full') message.blunderCheck = { prompt: BLUNDER_PROMPT, answer: blunderAnswer(fen, lastMove) };
      this.publish(message, () => buildPacket('pre_move', ctx, explanation, this.deps.profile()));
      return message;
    } catch {
      return null;
    }
  }

  async onUserMove(game: GameState, move: PlayedMove): Promise<{ verdict: Verdict; message: CoachMessage | null }> {
    this.currentId = null;
    this.lastMistake = null; // hints and playOn always refer to this move's verdict
    const history = game.history();
    const found = history.findIndex((m) => m.uci === move.uci && m.fenBefore === move.fenBefore);
    const index = found >= 0 ? found : history.length;
    const before = history.slice(0, index);
    const inBook = lookup(game.userColor, [...before.map((m) => m.san), move.san]) !== null;
    const stub = { verdict: stubVerdict(move.fenBefore, move, index, inBook), message: null };
    if (game.result() !== null) return stub;

    const epoch = this.epoch;
    try {
      const level = this.deps.levelFor(areaOf(move.fenBefore, index, inBook));
      const beforeAnalysis = await this.analyse(move.fenBefore);
      if (epoch !== this.epoch) return stub;
      const afterAnalysis = await this.analyse(move.fenAfter);
      const verdict = classifyMove({
        fenBefore: move.fenBefore, move, before: beforeAnalysis, after: afterAnalysis,
        history: before, level, plyCount: index, inBook,
      });
      if (epoch !== this.epoch) return stub;
      if (!verdict.flagged) return { verdict, message: null };

      const refutationUci = afterAnalysis.lines[0]?.uci.slice(0, 4) ?? [];
      const ctx: MistakeContext = {
        verdict, move, factsAfter: positionFacts(move.fenAfter), themeCount: this.deps.themeCount(verdict.theme),
      };
      const explanation = mistakeTemplate(ctx);
      const arrows: Arrow[] = [];
      if (refutationUci[0]) arrows.push(arrow(refutationUci[0], 'red'));
      arrows.push(arrow(verdict.bestUci, 'green'));
      const message: CoachMessage = { id: this.newId(), kind: 'mistake', explanation, arrows, source: 'template', verdict };
      this.lastMistake = { verdict, move, refutationUci, plyAfter: index + 1 };
      this.publish(message, () => buildPacket('mistake', ctx, explanation, this.deps.profile()));
      return { verdict, message };
    } catch {
      return stub;
    }
  }

  hint(step: 1 | 2 | 3): string {
    const m = this.lastMistake;
    if (!m) return '';
    const { verdict, move } = m;
    if (step === 1) {
      const lesson = THEME_LESSONS[verdict.theme];
      return `Remember the lesson (${lesson.title}): ${lesson.habit}`;
    }
    if (step === 2) {
      const from = verdict.bestUci.slice(0, 2);
      const piece = new Chess(move.fenBefore).get(from as Square);
      return piece
        ? `Look at your ${NAMES[piece.type]} on ${from}.`
        : `Look at your piece on ${from}.`;
    }
    return `Try ${verdict.bestSan}.`;
  }

  playOn(): void {
    const m = this.lastMistake;
    if (!m) return;
    const line = replayLine(m.move.fenAfter, m.refutationUci);
    const balanceAtMistake = balance(m.move.fenAfter, m.move.color);
    const gain = balanceAtMistake - balance(line.fen, m.move.color);
    this.tracker = {
      mistake: m,
      lineSans: line.sans,
      opponentSans: line.sans.filter((_, i) => i % 2 === 0), // the refutation starts with their reply
      gain,
      balanceAtMistake,
    };
  }

  checkConsequence(game: GameState): CoachMessage | null {
    const t = this.tracker;
    if (!t) return null;
    const history = game.history();
    const since = history.slice(t.mistake.plyAfter);
    const stillThere = history[t.mistake.plyAfter - 1]?.fenAfter === t.mistake.move.fenAfter;
    if (!stillThere || since.length > CONSEQUENCE_WINDOW) {
      this.tracker = null;
      return null;
    }
    const theirs = since.filter((m) => m.color !== t.mistake.move.color).map((m) => m.san);
    const lineMatched = t.opponentSans.length > 0 && t.opponentSans.every((san, i) => theirs[i] === san);
    const materialLost = t.gain > 0 && t.balanceAtMistake - balance(game.fen(), t.mistake.move.color) >= t.gain;
    if (!lineMatched && !materialLost) return null;

    this.tracker = null;
    const { verdict, move, refutationUci } = t.mistake;
    const piece = lostPiece(move, refutationUci, since);
    const lead = piece ? `Here's where leaving ${yours(piece)} costs you.` : `Here's where ${move.san} costs you.`;
    const detail = lineMatched
      ? `They played ${joinList(t.opponentSans)}, just as the coach showed after ${move.san}.`
      : `You have now lost the material the coach's line after ${move.san} showed (${t.lineSans.join(', ')}).`;
    const lesson = THEME_LESSONS[verdict.theme];
    return {
      id: this.newId(), kind: 'consequence', arrows: [], source: 'template', verdict,
      explanation: { whatHappened: `${lead} ${detail}`, lesson: `${lesson.title}: ${lesson.habit}` },
    };
  }

  recap(_game: GameState, verdicts: Verdict[]): CoachMessage {
    const counts = new Map<Theme, number>();
    for (const v of verdicts) if (v.flagged) counts.set(v.theme, (counts.get(v.theme) ?? 0) + 1);
    let top: Theme | null = null;
    for (const [theme, n] of counts) if (top === null || n > counts.get(top)!) top = theme;

    let stretch = 0;
    let run = 0;
    for (const v of verdicts) {
      run = v.flagged ? 0 : run + 1;
      stretch = Math.max(stretch, run);
    }

    const themeLine = top
      ? `Main theme this game: ${THEME_LESSONS[top].title} (${counts.get(top)} ${counts.get(top) === 1 ? 'time' : 'times'}).`
      : 'No big mistakes this game.';
    const wellLine = stretch > 0
      ? `You played ${stretch} ${stretch === 1 ? 'move' : 'moves'} in a row without a big mistake.`
      : 'You played the game through to the end.';
    const habitTheme = top ?? this.deps.profile().topThemes[0]?.theme ?? 'hanging_piece';
    const habitLine = `Habit to work on: ${THEME_LESSONS[habitTheme].habit}`;
    return {
      id: this.newId(), kind: 'recap', arrows: [], source: 'template',
      explanation: { whatHappened: themeLine, better: wellLine, lesson: habitLine },
    };
  }

  private newId(): string {
    return `coach-${this.nextId++}`;
  }

  /** One-slot cache of the (possibly in-flight) search, so preMove and onUserMove never search a FEN twice. */
  private analyse(fen: string): Promise<Analysis> {
    if (this.cache?.fen === fen) return this.cache.analysis;
    const entry = { fen, analysis: this.deps.engine.analyse(fen, ANALYSIS) };
    this.cache = entry;
    entry.analysis.catch(() => {
      if (this.cache === entry) this.cache = null; // never reuse a failed or stopped search
    });
    return entry.analysis;
  }

  /** Makes `message` current and upgrades it in the background if Claude returns a valid explanation. */
  private publish(message: CoachMessage, packet: () => FactPacket): void {
    this.currentId = message.id;
    const epoch = this.epoch;
    Promise.resolve()
      .then(() => this.deps.explain(packet()))
      .then((better) => {
        if (!better || epoch !== this.epoch || this.currentId !== message.id) return;
        const upgraded: CoachMessage = { ...message, explanation: { ...message.explanation, ...better }, source: 'claude' };
        for (const cb of this.listeners) {
          try { cb(upgraded); } catch { /* a failing listener must not affect the others */ }
        }
      })
      .catch(() => { /* null or rejection: keep the template */ });
  }
}

/** Answer to the blunder-check prompt, from attackedBy(lastMove) plus the hanging list. */
function blunderAnswer(fen: string, lastMove: PlayedMove): string {
  const me = opposite(lastMove.color);
  const facts = positionFacts(fen);
  const to = lastMove.uci.slice(2, 4);
  const mover = new Chess(fen).get(to as Square);
  const attacker = mover ? `Their ${NAMES[mover.type]} on ${to}` : null;
  // attackedBy covers only the moved piece; check comes from the position itself (discovered checks too).
  const targets = facts.attackedBy(lastMove.uci).filter((p) => p.color === me && p.piece !== 'k');
  const hanging = facts.hanging.filter((p) => p.color === me);
  const isHanging = (p: PieceRef) => hanging.some((h) => h.square === p.square);

  const parts: string[] = [];
  if (facts.inCheck) parts.push('You are in check.');
  if (attacker && targets.length > 0) {
    const list = targets.map((p) => `${yours(p)}${isHanging(p) ? ', which is not safely protected' : ''}`);
    parts.push(`${attacker} now attacks ${joinList(list)}.`);
  } else if (attacker) {
    // Only the moved piece is checked here; a discovered attack shows up in the hanging sentence below.
    parts.push(`${attacker} does not attack anything of yours.`);
  }
  const others = hanging.filter((h) => !targets.some((t) => t.square === h.square));
  if (others.length > 0) {
    parts.push(`${joinList(others.map(yours)).replace(/^your/, 'Your')} ${others.length === 1 ? 'is' : 'are'} under attack and not safely protected.`);
  } else {
    parts.push(`Nothing ${targets.length > 0 ? 'else ' : ''}of yours is under attack without protection.`);
  }
  return parts.join(' ');
}
