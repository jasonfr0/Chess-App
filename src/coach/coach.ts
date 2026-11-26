import { Chess } from 'chess.js';
import type { Square } from 'chess.js';
import type { Engine } from '../engine/engine';
import { lookup } from '../openings/repertoire';
import type { BookHit } from '../openings/repertoire';
import type { Analysis, Area, CoachLevel, Color, PlayedMove, ProfileSummary, Theme } from '../types';
import type { GameState } from '../game/gameState';
import { areaOf, classifyMove } from './classify';
import type { Verdict } from './classify';
import { positionFacts } from './facts';
import type { PieceRef } from './facts';
import { THEME_LESSONS, mistakeTemplate } from './templates';
import type { Explanation, MistakeContext } from './templates';
import { preMoveCoaching } from './questions';
import type { QuestionContext } from './questions';
import { postMoveTemplate, topMoveKind } from './postMove';
import type { PostMoveContext, TopKind } from './postMove';
import { buildPacket } from './claude';
import type { FactPacket } from './claude';

export type Arrow = { from: string; to: string; color: 'green' | 'red' | 'blue' };
export interface CoachMessage {
  id: string; kind: 'pre_move' | 'post_move' | 'mistake' | 'consequence' | 'recap' | 'level_change';
  explanation: Explanation; arrows: Arrow[]; source: 'template' | 'claude';
  verdict?: Verdict;
  /** pre_move: what their last move did (null on move 1 as White), questions, and an optional hint. None names a move. */
  questions?: string[]; nudge?: string | null; theirMove?: string | null;
  /**
   * post_move: the one-line verdict and the kind of move played. `explained` is false for a top or
   * book move until the user taps Explain; a "stronger option" explanation is shown at once (true).
   */
  summary?: string; topKind?: TopKind; explained?: boolean;
}
export interface CoachDeps {
  engine: Engine; explain: (p: FactPacket) => Promise<Explanation | null>;
  levelFor: (a: Area) => CoachLevel; profile: () => ProfileSummary; themeCount: (t: Theme) => number;
}

const ANALYSIS = { depth: 14, multipv: 3 };
/** Two slots: the position before the user's move and the one after, so a take-back retry reuses the first. */
const CACHE_SLOTS = 2;
const CONSEQUENCE_WINDOW = 6;
const NAMES: Record<PieceRef['piece'], string> = { p: 'pawn', n: 'knight', b: 'bishop', r: 'rook', q: 'queen', k: 'king' };

const arrow = (uci: string, color: Arrow['color']): Arrow => ({ from: uci.slice(0, 2), to: uci.slice(2, 4), color });
const yours = (p: PieceRef) => `your ${NAMES[p.piece]} on ${p.square}`;

/** The questions, nudge and their-move text; a nudge that only repeats a question is dropped. */
function preMoveFields(ctx: QuestionContext): Pick<CoachMessage, 'questions' | 'nudge' | 'theirMove'> {
  const { theirMove, questions, nudge } = preMoveCoaching(ctx);
  return { theirMove, questions, nudge: nudge !== null && questions.includes(nudge) ? null : nudge };
}

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
    bestUci: move.uci, bestSan: move.san, refutationSan: [], analysed: false,
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

interface CacheEntry { fen: string; analysis: Promise<Analysis>; done?: Analysis }
interface Mistake { verdict: Verdict; move: PlayedMove; refutationUci: string[]; plyAfter: number }
interface Tracker { mistake: Mistake; opponentSans: string[]; gain: number; balanceAtMistake: number }

export class Coach {
  private listeners: ((m: CoachMessage) => void)[] = [];
  private nextId = 1;
  private epoch = 0;
  private currentId: string | null = null;
  private cache: CacheEntry[] = [];
  /** The latest post_move and what it was built from, until the next user move. */
  private post: { message: CoachMessage; ctx: PostMoveContext } | null = null;
  private lastMistake: Mistake | null = null;
  private tracker: Tracker | null = null;

  constructor(private deps: CoachDeps) {}

  onUpdate(cb: (m: CoachMessage) => void): void {
    this.listeners.push(cb);
  }

  cancelPending(): void {
    this.epoch++;
    this.currentId = null;
    this.post = null;
    this.tracker = null;
  }

  /**
   * Before-move coaching from templates only (no Claude). `force`: the user tapped "Ask the coach",
   * so coach even at light or solo. If the engine has not answered yet, the message is built from the
   * facts alone and the same id is re-sent through onUpdate once the analysis arrives.
   */
  async preMove(game: GameState, opts: { force?: boolean } = {}): Promise<CoachMessage | null> {
    this.currentId = null;
    try {
      if (!game.isUserTurn() || game.result() !== null) return null;
      const history = game.history();
      const lastMove = history.at(-1) ?? null;
      const fen = game.fen();
      const book = lookup(game.userColor, history.map((m) => m.san));
      const level = this.deps.levelFor(areaOf(fen, history.length, book !== null));
      const search = this.analyse(fen);
      search.catch(() => { /* onUserMove retries */ });
      // At light and solo nothing is shown, but the user's move will be judged from this position.
      if (!opts.force && (level === 'light' || level === 'solo')) return null;

      const base: QuestionContext = {
        fen, lastMove, history, userColor: game.userColor, facts: positionFacts(fen), analysis: null, book,
      };
      const ready = this.cached(fen);
      const message: CoachMessage = {
        id: this.newId(), kind: 'pre_move', source: 'template', explanation: { whatHappened: '' },
        arrows: lastMove ? [arrow(lastMove.uci, 'blue')] : [],
        ...preMoveFields({ ...base, analysis: ready }),
      };
      message.explanation = { whatHappened: message.theirMove ?? '' };
      this.currentId = message.id;
      if (ready) return message;

      const epoch = this.epoch;
      const plies = history.length;
      search.then((analysis) => {
        // Cancelled, superseded, or the user already moved (or took back) while the engine was thinking.
        if (epoch !== this.epoch || this.currentId !== message.id) return;
        if (game.fen() !== fen || game.history().length !== plies) return;
        const fields = preMoveFields({ ...base, analysis });
        this.emit({ ...message, ...fields, explanation: { whatHappened: fields.theirMove ?? '' } });
      }, () => { /* keep the facts-only questions */ });
      return message;
    } catch {
      return null;
    }
  }

  async onUserMove(game: GameState, move: PlayedMove): Promise<{ verdict: Verdict; message: CoachMessage | null }> {
    this.currentId = null;
    this.post = null;
    this.lastMistake = null; // hints and playOn always refer to this move's verdict
    const history = game.history();
    const found = history.findIndex((m) => m.uci === move.uci && m.fenBefore === move.fenBefore);
    const index = found >= 0 ? found : history.length;
    const before = history.slice(0, index);
    const bookHit = lookup(game.userColor, [...before.map((m) => m.san), move.san]);
    const inBook = bookHit !== null;
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
      if (!verdict.flagged) {
        // After-move feedback only where the coach still talks: full and guided.
        if (verdict.analysed === false || (level !== 'full' && level !== 'guided')) return { verdict, message: null };
        return { verdict, message: this.postMove(verdict, move, topMoveKind(beforeAnalysis, move.uci, inBook), bookHit) };
      }

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
      this.currentId = message.id;
      this.publish(message, () => buildPacket('mistake', ctx, explanation, this.deps.profile()),
        () => this.currentId === message.id);
      return { verdict, message };
    } catch {
      return stub;
    }
  }

  /**
   * The user tapped Explain on a top or book post_move: show the template at once, then (top moves
   * only) ask Claude. Each move is explained once; a second tap, or an old id, does nothing.
   */
  async explainTopMove(messageId: string): Promise<void> {
    const post = this.post;
    if (!post || post.message.id !== messageId || post.message.explained !== false) return;
    const message: CoachMessage = { ...post.message, explained: true };
    post.message = message;
    this.emit(message);
    if (post.ctx.kind !== 'top') return; // book moves keep the repertoire's own idea text
    this.publish(message, () => buildPacket('post_move', post.ctx, message.explanation, this.deps.profile()),
      () => this.post === post, (upgraded) => { post.message = upgraded; });
  }

  private postMove(verdict: Verdict, move: PlayedMove, kind: TopKind, book: BookHit | null): CoachMessage {
    const ctx: PostMoveContext = {
      verdict, move, kind, bookIdea: book?.node.idea ?? null, lineName: book?.lineName || null,
      factsAfter: positionFacts(move.fenAfter),
    };
    const { summary, explanation } = postMoveTemplate(ctx);
    const message: CoachMessage = {
      id: this.newId(), kind: 'post_move', explanation, source: 'template', verdict, summary, topKind: kind,
      explained: kind === null, arrows: kind === null ? [arrow(verdict.bestUci, 'green')] : [],
    };
    const post = { message, ctx };
    this.post = post;
    if (kind === null) {
      this.publish(message, () => buildPacket('post_move', ctx, explanation, this.deps.profile()),
        () => this.post === post, (upgraded) => { post.message = upgraded; });
    }
    return message;
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
      ? `They played ${joinList(t.opponentSans)}, just as the coach warned after ${move.san}.`
      : `You have now lost the material the coach warned about after ${move.san} (their line: ${joinList(t.opponentSans)}).`;
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

  /** Small cache of (possibly in-flight) searches, so preMove, onUserMove and a retry never search a FEN twice. */
  private analyse(fen: string): Promise<Analysis> {
    const hit = this.cache.find((e) => e.fen === fen);
    if (hit) {
      this.cache = [...this.cache.filter((e) => e !== hit), hit]; // most recently used last
      return hit.analysis;
    }
    const entry: CacheEntry = { fen, analysis: this.deps.engine.analyse(fen, ANALYSIS) };
    this.cache = [...this.cache, entry].slice(-CACHE_SLOTS);
    entry.analysis.then((a) => { entry.done = a; }, () => {
      this.cache = this.cache.filter((e) => e !== entry); // never reuse a failed or stopped search
    });
    return entry.analysis;
  }

  /** A finished search for `fen`, if one is in the cache. */
  private cached(fen: string): Analysis | null {
    return this.cache.find((e) => e.fen === fen)?.done ?? null;
  }

  private emit(message: CoachMessage): void {
    for (const cb of this.listeners) {
      try { cb(message); } catch { /* a failing listener must not affect the others */ }
    }
  }

  /**
   * Upgrades `message` in the background if Claude returns a valid explanation and `isCurrent()`
   * still holds (and nothing was cancelled) when it arrives.
   */
  private publish(
    message: CoachMessage, packet: () => FactPacket, isCurrent: () => boolean,
    onUpgrade?: (m: CoachMessage) => void,
  ): void {
    const epoch = this.epoch;
    Promise.resolve()
      .then(() => this.deps.explain(packet()))
      .then((better) => {
        if (!better || epoch !== this.epoch || !isCurrent()) return;
        const upgraded: CoachMessage = { ...message, explanation: { ...message.explanation, ...better }, source: 'claude' };
        onUpgrade?.(upgraded);
        this.emit(upgraded);
      })
      .catch(() => { /* null or rejection: keep the template */ });
  }
}
