import { Chess } from 'chess.js';
import type { Square } from 'chess.js';
import type { Engine } from '../engine/engine';
import { lookup } from '../openings/repertoire';
import type { BookHit } from '../openings/repertoire';
import type {
  Analysis, Area, CoachLevel, Color, GameMode, PlayedMove, ProfileSummary, TeachMode, TeachTopic, Theme,
} from '../types';
import type { GameState } from '../game/gameState';
import { areaOf, classifyMove } from './classify';
import type { Verdict } from './classify';
import { positionFacts } from './facts';
import type { PieceRef } from './facts';
import { THEME_LESSONS, THEME_WHY, mistakeTemplate } from './templates';
import type { Explanation, MistakeContext } from './templates';
import { planText, preMoveCoaching } from './questions';
import { moveLeaks, revealsMove } from './leaks';
import type { QuestionContext } from './questions';
import { postMoveTemplate, revealTemplate, topMoveKind } from './postMove';
import type { PostMoveContext, RevealContext, TopKind } from './postMove';
import { watchLine } from './watch';
import type { WatchPly } from './watch';
import { deriveReasons, reasonText } from './reasons';
import type { Reasons } from './reasons';
import { buildPacket, buildRevealPacket, buildTeachPacket } from './claude';
import type { FactPacket } from './claude';
import { teachOptions } from '../teach/options';
import type { TeachOption } from '../teach/options';
import { TOPIC_LABEL, topicOf } from '../teach/topic';
import { positionText } from '../teach/position';

export type Arrow = { from: string; to: string; color: 'green' | 'red' | 'blue' };
/** A take-back hint and the squares to ring for it ([] when its text names none). */
export interface HintStep { text: string; highlight: string[] }
export interface CoachMessage {
  id: string; kind: 'pre_move' | 'post_move' | 'mistake' | 'consequence' | 'recap' | 'level_change' | 'teach';
  explanation: Explanation; arrows: Arrow[]; source: 'template' | 'claude';
  /**
   * The judged move. On a 'mistake' message the UI must not render verdict.bestSan / bestUci (or
   * anything built from them): the better move stays hidden until Show me or Play on.
   */
  verdict?: Verdict;
  /** pre_move: what their last move did (null on move 1 as White), questions, and an optional hint. None names a move. */
  questions?: string[]; nudge?: string | null; theirMove?: string | null;
  /** pre_move: the squares the nudge names, to ring once the nudge is shown ([] when it names none). */
  nudgeHighlight?: string[];
  /**
   * post_move: the one-line verdict and the kind of move played. `explained` is false for a top or
   * book move until the user taps Explain; a "stronger option" explanation is shown at once (true).
   */
  summary?: string; topKind?: TopKind; explained?: boolean;
  /**
   * post_move: the better move after a mistake, revealed by Show me or after Play on (topKind is null).
   * mistake (teaching games only): the better move is shown on the card at once.
   */
  reveal?: boolean;
  /** mistake: the engine line to replay when the consequence takes several moves (a forced mate, or material lost after ply 1). */
  watch?: WatchPly[];
  /**
   * teach: the turn's topic and mode, the position text, the options (shown only while optionsOpen;
   * in guide mode they open on "Show me options"), and whether the position is in the repertoire.
   */
  teach?: { topic: TeachTopic; mode: TeachMode; position: string; options: TeachOption[]; optionsOpen: boolean; inBook: boolean };
}
export interface CoachDeps {
  engine: Engine; explain: (p: FactPacket) => Promise<Explanation | null>;
  levelFor: (a: Area) => CoachLevel; profile: () => ProfileSummary; themeCount: (t: Theme) => number;
  /** Teaching games: whether this topic is shown or guided. */
  teachModeFor: (t: TeachTopic) => TeachMode;
}

const ANALYSIS = { depth: 14, multipv: 3 };
/** Two slots: the position before the user's move and the one after, so a take-back retry reuses the first. */
const CACHE_SLOTS = 2;
const CONSEQUENCE_WINDOW = 6;
const NAMES: Record<PieceRef['piece'], string> = { p: 'pawn', n: 'knight', b: 'bishop', r: 'rook', q: 'queen', k: 'king' };

const arrow = (uci: string, color: Arrow['color']): Arrow => ({ from: uci.slice(0, 2), to: uci.slice(2, 4), color });
const yours = (p: PieceRef) => `your ${NAMES[p.piece]} on ${p.square}`;

/** The questions, nudge and their-move text; a nudge that only repeats a question is dropped. */
function preMoveFields(ctx: QuestionContext): Pick<CoachMessage, 'questions' | 'nudge' | 'theirMove' | 'nudgeHighlight'> {
  const { theirMove, questions, nudge, nudgeHighlight } = preMoveCoaching(ctx);
  const repeats = nudge !== null && questions.includes(nudge);
  return { theirMove, questions, nudge: repeats ? null : nudge, nudgeHighlight: repeats ? [] : nudgeHighlight };
}

/** The better move's checked reasons, in the position before the user's move. */
function bestReasonsFor(
  move: PlayedMove, userColor: Color, before: PlayedMove[], verdict: Verdict, analysis: Analysis,
): Reasons {
  return deriveReasons(move.fenBefore, verdict.bestUci, {
    book: lookup(userColor, [...before.map((m) => m.san), verdict.bestSan]),
    area: verdict.area,
    line: analysis.lines.find((l) => l.uci[0] === verdict.bestUci)?.uci,
  });
}

/** A mistake card never carries a better-move field, even from Claude. */
const withoutBetter = ({ better: _better, ...rest }: Explanation): Explanation => rest;

/** The most frequent theme among the flagged verdicts (first seen wins a tie), or null. */
function topTheme(verdicts: Verdict[]): { theme: Theme; count: number } | null {
  const counts = new Map<Theme, number>();
  for (const v of verdicts) if (v.flagged) counts.set(v.theme, (counts.get(v.theme) ?? 0) + 1);
  let top: Theme | null = null;
  for (const [theme, n] of counts) if (top === null || n > counts.get(top)!) top = theme;
  return top === null ? null : { theme: top, count: counts.get(top)! };
}

const habitLine = (theme: Theme) => `Habit to work on: ${THEME_LESSONS[theme].habit}`;

/** A teaching recap's line for a topic that moved between showing and guiding. */
function changeLine({ topic, to }: { topic: TeachTopic; to: TeachMode }): string {
  return to === 'guide'
    ? `${TOPIC_LABEL[topic]}: I'll stop showing moves here and ask you first.`
    : `${TOPIC_LABEL[topic]}: I'll go back to showing moves for a while.`;
}

/** Green arrows for the options while they are shown, after the blue arrow for their last move. */
function teachArrows(lastMove: PlayedMove | null, options: TeachOption[], open: boolean): Arrow[] {
  return [...(lastMove ? [arrow(lastMove.uci, 'blue')] : []), ...(open ? options.map((o) => arrow(o.uci, 'green')) : [])];
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
interface Mistake {
  verdict: Verdict; move: PlayedMove; refutationUci: string[]; plyAfter: number; bestReasons: Reasons;
  /** The reveal of the better move, once built; showMe and playOnReveal return it again. */
  revealed?: { message: CoachMessage };
}
interface Turn { message: CoachMessage; fen: string; lastMove: PlayedMove | null }
interface Tracker { mistake: Mistake; opponentSans: string[]; gain: number; balanceAtMistake: number }

export class Coach {
  private listeners: ((m: CoachMessage) => void)[] = [];
  private nextId = 1;
  private epoch = 0;
  private currentId: string | null = null;
  private cache: CacheEntry[] = [];
  /** The latest post_move and what it was built from (null for a reveal), until the next user move. */
  private post: { message: CoachMessage; ctx: PostMoveContext | null } | null = null;
  private lastMistake: Mistake | null = null;
  private tracker: Tracker | null = null;
  private mode: GameMode = 'play';
  /** The latest teach message, its position and the move it followed, until the next user move or cancel. */
  private turn: Turn | null = null;

  constructor(private deps: CoachDeps) {}

  onUpdate(cb: (m: CoachMessage) => void): void {
    this.listeners.push(cb);
  }

  cancelPending(): void {
    this.epoch++;
    this.currentId = null;
    this.post = null;
    this.tracker = null;
    this.turn = null;
  }

  /** Play or teaching game ('play' by default). Cancels anything pending. */
  setMode(mode: GameMode): void {
    this.mode = mode;
    this.cancelPending();
  }

  /**
   * The teaching pre-move message. Unlike preMove it waits for the analysis; with none (the engine
   * failed) it is built from the repertoire and the facts alone. Null when it is not the user's turn
   * or the game is over.
   */
  async teachTurn(game: GameState): Promise<CoachMessage | null> {
    this.currentId = null;
    this.turn = null;
    try {
      if (!game.isUserTurn() || game.result() !== null) return null;
      const history = game.history();
      const lastMove = history.at(-1) ?? null;
      const fen = game.fen();
      const { userColor } = game;
      const book = lookup(userColor, history.map((m) => m.san));
      const area = areaOf(fen, history.length, book !== null);
      const epoch = this.epoch;
      const analysis = await this.analyse(fen).catch(() => null);
      if (epoch !== this.epoch || game.fen() !== fen || game.history().length !== history.length) return null;

      const ctx: QuestionContext = { fen, lastMove, history, userColor, facts: positionFacts(fen), analysis, book };
      const choice = teachOptions({ fen, userColor, sanHistory: history.map((m) => m.san), area, analysis });
      const topic = topicOf({ inBook: choice.inBook, area, reasons: choice.bestReasons });
      const mode: TeachMode = choice.options.length === 0 ? 'show' : this.deps.teachModeFor(topic);
      const optionsOpen = mode === 'show';
      // Line name and plan only where the options really are the repertoire's.
      const position = positionText({
        fen, userColor, mode, topic,
        lineName: choice.inBook ? book?.lineName || null : null, plan: choice.inBook ? planText(ctx) : null,
      });
      const message: CoachMessage = {
        id: this.newId(), kind: 'teach', source: 'template', explanation: { whatHappened: position },
        arrows: teachArrows(lastMove, choice.options, optionsOpen),
        ...preMoveFields(ctx),
        teach: { topic, mode, position, options: choice.options, optionsOpen, inBook: choice.inBook },
      };
      this.currentId = message.id;
      const turn: Turn = { message, fen, lastMove };
      this.turn = turn;
      if (choice.options.length > 0) this.rewordTurn(turn, userColor);
      return message;
    } catch {
      return null;
    }
  }

  /** "Show me options" on a guided turn: the same message with the options and their arrows; null for a stale id. */
  openOptions(messageId: string): CoachMessage | null {
    const turn = this.turn;
    if (!turn?.message.teach || turn.message.id !== messageId || this.currentId !== messageId) return null;
    const { teach } = turn.message;
    const message: CoachMessage = {
      ...turn.message,
      arrows: teachArrows(turn.lastMove, teach.options, true),
      teach: { ...teach, optionsOpen: true },
    };
    turn.message = message;
    return message;
  }

  /**
   * Claude may reword the position text only (option reasons stay the checked text). With the options
   * closed it must name no move and no square of a piece the user could win. Dropped once the user
   * moves, takes back or opens the options.
   */
  private rewordTurn(turn: Turn, userColor: Color): void {
    const { message, fen } = turn;
    const teach = message.teach!;
    const winnable = positionFacts(fen).hanging.filter((h) => h.color !== userColor).map((h) => new RegExp(`\\b${h.square}\\b`, 'i'));
    const safe = (t: string) => moveLeaks(t).length === 0 && !winnable.some((re) => re.test(t));
    this.publish(message, () => buildTeachPacket({ fen, position: teach.position, options: teach.options, optionsOpen: teach.optionsOpen }, this.deps.profile()),
      () => this.turn === turn && turn.message === message, {
        accept: (e) => teach.optionsOpen || safe(e.whatHappened),
        fields: (e) => ({ whatHappened: e.whatHappened }),
        patch: (e) => ({ teach: { ...teach, position: e.whatHappened } }),
        onUpgrade: (upgraded) => { turn.message = upgraded; },
      });
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
    const teaching = this.mode === 'teach';
    const turn = this.turn;
    const openOptions = turn?.message.teach?.optionsOpen && turn.fen === move.fenBefore ? turn.message.teach.options : [];
    this.turn = null;
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
      // Teaching games judge every move at full, whatever the Play levels say.
      const level: CoachLevel = teaching ? 'full' : this.deps.levelFor(areaOf(move.fenBefore, index, inBook));
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
        const kind = topMoveKind(beforeAnalysis, move.uci, inBook, verdict);
        // The played move's line is the move plus the engine's answer; the better move's is its own search line.
        const reasons = deriveReasons(move.fenBefore, move.uci, {
          book: bookHit, area: verdict.area, line: [move.uci, ...(afterAnalysis.lines[0]?.uci ?? [])],
        });
        if (teaching) {
          return { verdict, message: this.teachGoodMove(verdict, move, kind, reasons, openOptions.some((o) => o.uci === move.uci)) };
        }
        const bestReasons = kind !== null ? null : bestReasonsFor(move, game.userColor, before, verdict, beforeAnalysis);
        return { verdict, message: this.postMove(verdict, move, kind, bookHit, reasons, bestReasons) };
      }

      const refutationUci = afterAnalysis.lines[0]?.uci.slice(0, 4) ?? [];
      const ctx: MistakeContext = {
        verdict, move, factsAfter: positionFacts(move.fenAfter),
        // The "nth time" line counts Play games only.
        themeCount: teaching ? 0 : this.deps.themeCount(verdict.theme),
      };
      // No better move and no green arrow: the user decides first (take back and look, or play on).
      const explanation = mistakeTemplate(ctx);
      const arrows: Arrow[] = refutationUci[0] ? [arrow(refutationUci[0], 'red')] : [];
      const message: CoachMessage = { id: this.newId(), kind: 'mistake', explanation, arrows, source: 'template', verdict };
      const watch = watchLine(move.fenAfter, afterAnalysis.lines[0]?.uci ?? [], game.userColor);
      if (watch) message.watch = watch;
      const bestReasons = bestReasonsFor(move, game.userColor, before, verdict, beforeAnalysis);
      this.lastMistake = { verdict, move, refutationUci, plyAfter: index + 1, bestReasons };
      this.currentId = message.id;
      if (teaching) return { verdict, message: this.teachMistake(message, ctx, bestReasons) };
      this.publish(message, () => buildPacket('mistake', ctx, explanation, this.deps.profile()),
        () => this.currentId === message.id, {
          // Claude's prose is checked too: no field may point at the better move.
          accept: (e) => ![e.whatHappened, e.better, e.lesson]
            .some((t) => t !== undefined && revealsMove(t, verdict.bestSan, verdict.bestUci, [move.uci, ...refutationUci.slice(0, 1)])),
          fields: withoutBetter,
        });
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
    if (!post?.ctx || post.message.id !== messageId || post.message.explained !== false) return;
    const ctx = post.ctx;
    const message: CoachMessage = { ...post.message, explained: true };
    post.message = message;
    this.emit(message);
    // Book moves are not sent to Claude: their template already ends with the repertoire's own idea.
    if (ctx.kind !== 'top') return;
    this.publish(message, () => buildPacket('post_move', ctx, message.explanation, this.deps.profile()),
      () => this.post === post, { onUpgrade: (upgraded) => { post.message = upgraded; } });
  }

  /**
   * A teaching game's mistake card: the better move, its reasons and its green arrow are on it at
   * once. Claude may reword what happened and the lesson; the better-move field stays the template's.
   */
  private teachMistake(message: CoachMessage, ctx: MistakeContext, bestReasons: Reasons): CoachMessage {
    const { verdict, move } = ctx;
    const packetTemplate = message.explanation;
    const better = revealTemplate({ verdict, move, bestReasons }, ctx.factsAfter).explanation.whatHappened;
    const shown: CoachMessage = {
      ...message, reveal: true,
      explanation: { ...message.explanation, better },
      arrows: [...message.arrows, arrow(verdict.bestUci, 'green')],
    };
    this.publish(shown, () => buildPacket('mistake', ctx, packetTemplate, this.deps.profile()),
      () => this.currentId === shown.id, { fields: (e) => ({ ...e, better }) });
    return shown;
  }

  /**
   * A teaching game's good (unflagged) move: a plain confirmation, never a question and never a
   * better move. A move that was not one of the shown options also gets its own checked reasons.
   */
  private teachGoodMove(verdict: Verdict, move: PlayedMove, kind: TopKind, reasons: Reasons, wasShown: boolean): CoachMessage {
    const why = wasShown ? null : reasonText(move.san, reasons);
    const whatHappened = why ?? (wasShown ? `${move.san} was one of the options shown.` : `${move.san} is a fine move here.`);
    const message: CoachMessage = {
      id: this.newId(), kind: 'post_move', explanation: { whatHappened }, source: 'template', verdict,
      summary: kind === 'book' ? '✓ Book move.' : '✓ Good move.', topKind: kind, explained: true, arrows: [],
    };
    this.post = { message, ctx: null };
    return message;
  }

  private postMove(
    verdict: Verdict, move: PlayedMove, kind: TopKind, book: BookHit | null,
    reasons: Reasons, bestReasons: Reasons | null,
  ): CoachMessage {
    const ctx: PostMoveContext = {
      verdict, move, kind, bookIdea: book?.node.idea ?? null, lineName: book?.lineName || null,
      factsAfter: positionFacts(move.fenAfter), reasons, bestReasons,
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
        () => this.post === post, { onUpgrade: (upgraded) => { post.message = upgraded; } });
    }
    return message;
  }

  /**
   * The take-back hint ladder. Hint 1: the theme's habit and why, ringing nothing. Hint 2: the piece
   * the better move starts from, ringing its square; it never names a destination.
   */
  hintStep(step: 1 | 2): HintStep {
    const m = this.lastMistake;
    if (!m) return { text: '', highlight: [] };
    const { verdict, move } = m;
    if (step === 1) {
      const lesson = THEME_LESSONS[verdict.theme];
      return { text: `Remember the lesson (${lesson.title}): ${lesson.habit} ${THEME_WHY[verdict.theme]}`, highlight: [] };
    }
    const from = verdict.bestUci.slice(0, 2);
    let piece: ReturnType<Chess['get']>;
    try { piece = new Chess(move.fenBefore).get(from as Square); } catch { piece = undefined; }
    return piece && piece.color === move.color
      ? { text: `Look at your ${NAMES[piece.type]} on ${from}.`, highlight: [from] }
      : { text: 'Look at which of your pieces could help.', highlight: [] };
  }

  /** "Show me": reveals the better move for the last mistake. The UI counts the next move as helped. */
  showMe(): CoachMessage | null {
    return this.reveal();
  }

  /** The same reveal, shown in "Your last move" after Play on. */
  playOnReveal(): CoachMessage | null {
    return this.reveal();
  }

  /**
   * A post_move naming the better move, its checked reasons and a green arrow. Claude may rewrite it
   * from a packet holding only the better move; the answer is dropped once the user moves again.
   */
  private reveal(): CoachMessage | null {
    const m = this.lastMistake;
    if (!m) return null;
    if (m.revealed) return m.revealed.message; // once per mistake: the same message, one Claude call
    const ctx: RevealContext = { verdict: m.verdict, move: m.move, bestReasons: m.bestReasons };
    const { summary, explanation } = revealTemplate(ctx, positionFacts(m.move.fenAfter));
    const message: CoachMessage = {
      id: this.newId(), kind: 'post_move', explanation, source: 'template', verdict: m.verdict, summary,
      topKind: null, explained: true, reveal: true, arrows: [arrow(m.verdict.bestUci, 'green')],
    };
    const post = { message, ctx: null };
    const revealed = { message };
    m.revealed = revealed;
    this.post = post;
    this.publish(message, () => buildRevealPacket(ctx, explanation, this.deps.profile()),
      () => this.post === post, { onUpgrade: (upgraded) => { post.message = upgraded; revealed.message = upgraded; } });
    return message;
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
    const top = topTheme(verdicts);

    let stretch = 0;
    let run = 0;
    for (const v of verdicts) {
      run = v.flagged ? 0 : run + 1;
      stretch = Math.max(stretch, run);
    }

    const themeLine = top
      ? `Main theme this game: ${THEME_LESSONS[top.theme].title} (${top.count} ${top.count === 1 ? 'time' : 'times'}).`
      : 'No big mistakes this game.';
    const wellLine = stretch > 0
      ? `You played ${stretch} ${stretch === 1 ? 'move' : 'moves'} in a row without a big mistake.`
      : 'You played the game through to the end.';
    const habitTheme = top?.theme ?? this.deps.profile().topThemes[0]?.theme ?? 'hanging_piece';
    return {
      id: this.newId(), kind: 'recap', arrows: [], source: 'template',
      explanation: { whatHappened: themeLine, better: wellLine, lesson: habitLine(habitTheme) },
    };
  }

  /** A teaching game's recap: the topics that came up, topics that moved between showing and guiding, and the habit. */
  teachRecap(verdicts: Verdict[], topics: TeachTopic[], changes: { topic: TeachTopic; to: TeachMode }[]): CoachMessage {
    const labels = [...new Set(topics)].map((t) => TOPIC_LABEL[t]);
    const top = topTheme(verdicts);
    const explanation: Explanation = {
      whatHappened: labels.length > 0 ? `Topics this game: ${labels.join(', ')}.` : 'A short game: no topics came up.',
      ...(changes.length > 0 ? { better: changes.map(changeLine).join(' ') } : {}),
      lesson: top ? habitLine(top.theme) : 'No big mistakes this game.',
    };
    return { id: this.newId(), kind: 'recap', arrows: [], source: 'template', explanation };
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
    opts: {
      onUpgrade?: (m: CoachMessage) => void;
      /** Claude's answer is used only if this holds. */
      accept?: (e: Explanation) => boolean;
      /** The fields kept from the merged explanation. */
      fields?: (e: Explanation) => Explanation;
      /** Other fields of the message that follow the new explanation. */
      patch?: (e: Explanation) => Partial<CoachMessage>;
    } = {},
  ): void {
    const { onUpgrade, accept = () => true, fields = (e: Explanation) => e, patch } = opts;
    const epoch = this.epoch;
    Promise.resolve()
      .then(() => this.deps.explain(packet()))
      .then((better) => {
        if (!better || epoch !== this.epoch || !isCurrent() || !accept(better)) return;
        const explanation = fields({ ...message.explanation, ...better });
        const upgraded: CoachMessage = { ...message, ...patch?.(explanation), explanation, source: 'claude' };
        onUpgrade?.(upgraded);
        this.emit(upgraded);
      })
      .catch(() => { /* null or rejection: keep the template */ });
  }
}
