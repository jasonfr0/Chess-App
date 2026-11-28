import { useEffect, useReducer, useRef } from 'react';
import type { Coach, CoachMessage } from '../coach/coach';
import type { Verdict } from '../coach/classify';
import type { WatchPly } from '../coach/watch';
import type { Engine } from '../engine/engine';
import { GameState } from '../game/gameState';
import { adjustOpponentRating, selectOpponentMove } from '../opponent/selectMove';
import { areaOf } from '../coach/classify';
import { lookup } from '../openings/repertoire';
import { levelFor, recordMove, recordTeachTheme } from '../profile/profile';
import { levelChangeText, reviewLevels, suggestClock } from '../profile/weaning';
import { suggestLinesOff } from '../profile/attackLines';
import { playGames } from '../profile/games';
import type { Db, SavedGame, Settings } from '../storage/db';
import { finishGame, recordTurn, topicChanges } from '../teach/fade';
import type { Analysis, CoachLevel, Color, GameMode, GameResult, ProfileData, TeachMode, TeachState, TeachTopic } from '../types';

export type CoachApi = Pick<
  Coach,
  'onUpdate' | 'cancelPending' | 'preMove' | 'onUserMove' | 'explainTopMove' | 'hintStep' | 'showMe' | 'playOnReveal'
  | 'playOn' | 'checkConsequence' | 'recap' | 'setMode' | 'teachTurn' | 'openOptions' | 'teachRecap'
>;

export interface GameDeps {
  db: Db;
  engine: Engine;
  coach: CoachApi;
  profile: ProfileData;
  settings: Settings;
  onProfile: (p: ProfileData) => void;
  onSettings: (s: Settings) => void;
  /** Called when a game is created or finished (the saved-games list changed). */
  onGameListChanged?: () => void;
  rng: () => number;
  /** Test-only start position; such games are not saved or resumed. */
  startFen?: string;
}

/**
 * setup: choosing a colour. user: the user's turn (the only phase with board input).
 * checking: the coach is judging the user's move. opponent: the engine opponent is choosing.
 * mistake: paused on a flagged move. over: game finished.
 */
export type Phase = 'loading' | 'setup' | 'user' | 'checking' | 'opponent' | 'mistake' | 'over';

export interface GameView {
  phase: Phase;
  /** Play, or a teaching game ("Play to learn"), which never counts toward the assessment. 'play' before a game. */
  mode: GameMode;
  game: GameState | null;
  /** Latest pre-move coaching for the current position. */
  coachMsg: CoachMessage | null;
  consequence: CoachMessage | null;
  mistake: CoachMessage | null;
  /** Set after a take-back: the hint texts revealed so far (Hint 1, then Hint 2). */
  hints: string[] | null;
  /** The squares the latest revealed hint rings ([] when it names none); cleared by the next move or take-back. */
  hintHighlight: string[];
  promotion: { from: string; to: string } | null;
  clock: Record<Color, number> | null; // ms remaining
  result: GameResult | null;
  recap: CoachMessage | null;
  levelNotes: string[];
  clockSuggestion: boolean;
  /** Game end: the last games qualify for "try turning attack lines off". */
  linesOffSuggestion: boolean;
  /** The post_move feedback on the user's latest move, kept until their next move. */
  lastMove: CoachMessage | null;
  /** Whether the "Your last move" section is expanded. */
  lastMoveOpen: boolean;
  /** FEN in which the user tapped "Show questions" (guided). */
  questionsShownFor: string | null;
  /** FEN in which the user used "Need a nudge?"; a move from that position is assisted. */
  nudgeFor: string | null;
  /**
   * FEN in which the user re-expanded a "stronger option" feedback during their own decision: it names
   * a better move, so playing that move from this position is assisted.
   */
  betterShownFor: string | null;
  /** A past ply being viewed (0-based index into the history; -1 is the start); null means live. Read-only, changes nothing. */
  viewPly: number | null;
  /** The opponent moved while the user was viewing history. */
  newMoveWhileViewing: boolean;
  /** The mistake card's "Watch what happens" player: the line and the shown ply. */
  watching: { plies: WatchPly[]; index: number } | null;
  /**
   * After watching, then Play on: the watched line (it starts at ply `watchStart`). A user move
   * equal to the line's next user move, while the game still follows it, is assisted. Cleared once the
   * game leaves the line.
   */
  watchedLine: WatchPly[] | null;
  /**
   * After watching, then Take it back: the retry position (the FEN before the mistake) and the
   * watched line's user moves. A move from that position equal to any of them is assisted.
   */
  watchedTakeBackFor: { fen: string; ucis: string[] } | null;
  /** The Show me / Play on reveal of the better move, shown in "Your last move". */
  reveal: CoachMessage | null;
  /** FEN in which Show me was used: a move from it is assisted, and the reveal's green arrow shows there. */
  showMeFor: string | null;
  /** FEN in which attack lines were displayed during the user's decision: a move from it counts as made with them. */
  linesShownFor: string | null;
}

export interface GameActions {
  start(choice: Color | 'random', mode?: GameMode): void;
  /** Returns true if the move was played. */
  userMove(uci: string): boolean;
  choosePromotion(piece: 'q' | 'r' | 'b' | 'n'): void;
  cancelPromotion(): void;
  takeBack(): void;
  playOn(): void;
  /** The take-back hint ladder: Hint 1, then Hint 2. */
  hint(step: 1 | 2): void;
  /** "Show me": reveals the better move; the move played from this position is assisted. */
  showMe(): void;
  /** History view: a past ply (0-based), or null for the live game. */
  viewPly(n: number | null): void;
  stepView(delta: -1 | 1): void;
  /** "▶ Watch what happens" on the mistake card. */
  watch(): void;
  stepWatch(delta: -1 | 1): void;
  /** "Back to the card". */
  closeWatch(): void;
  /** Teaching game, guide mode: "Show me options" for this turn (counts as a miss for the fade). */
  showOptions(): void;
  /** Teaching game: plays options[index]'s line in the watch player. */
  watchOption(index: number): void;
  /** The board showed attack lines in this position during the user's decision. */
  linesShown(fen: string): void;
  resign(): void;
  newGame(): void;
  dismissClockSuggestion(): void;
  dismissLinesOffSuggestion(): void;
  /** Reveal the questions for this position (they are always visible at full). */
  showQuestions(): void;
  /** "Need a nudge?": reveals the nudge; the move played from this position is assisted. */
  nudge(): void;
  /** "Explain it" on a top or book move. */
  explainLastMove(): void;
  /** "Yes, I got it": collapses the last-move section. */
  ackLastMove(): void;
  toggleLastMove(): void;
  /** "Ask the coach": pre-move coaching on demand, at levels that stay quiet. */
  askCoach(): void;
}

const OPPONENT_SEARCH = { depth: 10, multipv: 5 };
const BOOK_CHANCE = 0.7;
const CLOCK_TICK_MS = 200;

const INITIAL: GameView = {
  phase: 'loading', mode: 'play', game: null, coachMsg: null, consequence: null, mistake: null, hints: null, hintHighlight: [],
  promotion: null, clock: null, result: null, recap: null, levelNotes: [], clockSuggestion: false, linesOffSuggestion: false,
  lastMove: null, lastMoveOpen: false, questionsShownFor: null, nudgeFor: null, betterShownFor: null,
  viewPly: null, newMoveWhileViewing: false, watching: null, watchedLine: null, watchedTakeBackFor: null, reveal: null, showMeFor: null,
  linesShownFor: null,
};

/** The teaching turn message shown for a position: what the fade counts the user's first move there as. */
interface TeachTurnShown { fen: string; topic: TeachTopic; mode: TeachMode; options: number }
/** Per teaching game: the fade state at load, topics seen, positions already counted, where options were opened. */
interface TeachGame {
  atStart: TeachState | undefined; topics: TeachTopic[]; countedFens: Set<string>;
  optionsOpenedFor: string | null; turn: TeachTurnShown | null;
}
const newTeachGame = (atStart: TeachState | undefined): TeachGame => (
  { atStart, topics: [], countedFens: new Set(), optionsOpenedFor: null, turn: null }
);

const opposite = (c: Color): Color => (c === 'w' ? 'b' : 'w');
const ignore = () => {};

/** Coach.onUpdate has no unsubscribe, so each coach gets one real listener that fans out. */
const fanOut = new WeakMap<CoachApi, Set<(m: CoachMessage) => void>>();
function subscribe(coach: CoachApi, cb: (m: CoachMessage) => void): () => void {
  let set = fanOut.get(coach);
  if (!set) {
    const listeners = new Set<(m: CoachMessage) => void>();
    set = listeners;
    fanOut.set(coach, listeners);
    coach.onUpdate((m) => { for (const l of listeners) l(m); });
  }
  set.add(cb);
  return () => { set.delete(cb); };
}

/** The coaching level for the position on the board (same rule the coach uses). */
export function levelAt(game: GameState, profile: ProfileData, settings: Pick<Settings, 'levelOverride'>): CoachLevel {
  const history = game.history();
  const inBook = lookup(game.userColor, history.map((m) => m.san)) !== null;
  return levelFor(profile, settings, areaOf(game.fen(), history.length, inBook));
}

/** Score of the user's last five finished games: win 1, draw 0.5. */
function lastFiveScore(games: SavedGame[]): number {
  return playGames(games)
    .filter((g) => g.result !== null)
    .slice(-5)
    .reduce((sum, g) => sum + (g.result!.winner === null ? 0.5 : g.result!.winner === g.userColor ? 1 : 0), 0);
}

/** The game loop: engine opponent, coach calls, saving, clock and game end. */
export function useGame(deps: GameDeps): [GameView, GameActions] {
  const view = useRef<GameView>(INITIAL);
  const [, render] = useReducer((x: number) => x + 1, 0);
  const set = (patch: Partial<GameView>) => {
    view.current = { ...view.current, ...patch };
    render();
  };

  // Latest deps for async flows. Profile/settings refs are written through immediately on change,
  // and only re-synced from props when the parent passes a new object.
  const d = useRef(deps);
  d.current = deps;
  const profile = useRef(deps.profile);
  const settings = useRef(deps.settings);
  /** The ply count where the watched line starts (right after the mistake), and whether it was watched. */
  const watchStart = useRef(0);
  const watchedThis = useRef(false);
  const seen = useRef({ profile: deps.profile, settings: deps.settings });
  if (deps.profile !== seen.current.profile) { seen.current.profile = deps.profile; profile.current = deps.profile; }
  if (deps.settings !== seen.current.settings) { seen.current.settings = deps.settings; settings.current = deps.settings; }

  const gen = useRef(0); // bumped whenever in-flight work must be dropped
  /** Per game: user moves played, how many of them with attack lines on, and whether the latest one was. */
  const meta = useRef<{ id: string; startedAt: number; verdicts: Verdict[]; userMoves: number; attackLinesMoves: number; lastWithLines: boolean }>(
    { id: '', startedAt: 0, verdicts: [], userMoves: 0, attackLinesMoves: 0, lastWithLines: false },
  );

  const teach = useRef<TeachGame>(newTeachGame(undefined));
  const teaching = () => view.current.mode === 'teach';

  const setProfile = (p: ProfileData) => { profile.current = p; d.current.onProfile(p); };
  const setSettings = (s: Settings) => { settings.current = s; d.current.onSettings(s); };

  const save = () => {
    const game = view.current.game;
    if (!game || d.current.startFen) return;
    const { id, startedAt, verdicts, userMoves, attackLinesMoves } = meta.current;
    const record: SavedGame = {
      id, startedAt, userColor: game.userColor, moves: game.toJSON().moves, verdicts: [...verdicts],
      result: view.current.result,
      // Teaching games track no move counts (they feed no suggestion).
      ...(teaching() ? { mode: 'teach' as const } : { userMoves, attackLinesMoves }),
    };
    d.current.db.saveGame(record).catch(ignore);
  };

  /** Drops in-flight work. The engine is stopped (its worker restarted) only if a search is running. */
  const stopWork = () => {
    gen.current++;
    const { engine } = d.current;
    try { if (engine.busy()) engine.stop(); } catch { /* nothing running */ }
    d.current.coach.cancelPending();
  };

  const runPreMove = (game: GameState, force = false) => {
    if (teaching()) { runTeachTurn(game); return; }
    const g = gen.current;
    const fen = game.fen();
    d.current.coach.preMove(game, force ? { force } : undefined).then((m) => {
      if (m && g === gen.current && game.fen() === fen) set({ coachMsg: m });
    }, ignore);
  };

  /** Teaching games: the turn message (options, topic, mode) in place of pre-move coaching. */
  const runTeachTurn = (game: GameState) => {
    const g = gen.current;
    const fen = game.fen();
    d.current.coach.teachTurn(game).then((m) => {
      if (!m?.teach || g !== gen.current || game.fen() !== fen) return;
      const { topic, mode, options } = m.teach;
      const t = teach.current;
      t.turn = { fen, topic, mode, options: options.length };
      if (!t.topics.includes(topic)) t.topics.push(topic);
      set({ coachMsg: m });
    }, ignore);
  };

  /**
   * Teaching games: a flagged move adds to the teaching theme count only, and the first analysed move
   * from a position whose turn had options counts once toward the fade (a retry after take-back does not).
   */
  const recordTeachMove = (verdict: Verdict, fenBefore: string, ctx: { gameId: string; ply: number; at: number }) => {
    let p = recordTeachTheme(profile.current, verdict, { ...ctx, fen: fenBefore });
    const t = teach.current;
    const turn = t.turn;
    if (turn?.fen === fenBefore && turn.options > 0 && !t.countedFens.has(fenBefore)) {
      t.countedFens.add(fenBefore);
      p = {
        ...p,
        teaching: recordTurn(p.teaching, turn.topic, { mode: turn.mode, flagged: verdict.flagged, openedOptions: t.optionsOpenedFor === fenBefore }),
      };
    }
    if (p !== profile.current) setProfile(p);
  };

  /** Teaching games end with the teaching recap and the fade's game count; nothing of the assessment runs. */
  const endTeachGame = () => {
    const teachingState = finishGame(profile.current.teaching);
    const changes = topicChanges(teach.current.atStart, teachingState);
    setProfile({ ...profile.current, teaching: teachingState });
    if (!d.current.startFen) d.current.onGameListChanged?.();
    set({
      recap: d.current.coach.teachRecap(meta.current.verdicts, teach.current.topics, changes),
      levelNotes: [], clockSuggestion: false, linesOffSuggestion: false,
    });
  };

  const endGame = async (result: GameResult) => {
    const game = view.current.game;
    if (!game || view.current.phase === 'over') return;
    gen.current++;
    d.current.coach.cancelPending();
    set({ phase: 'over', result, promotion: null, mistake: null, hints: null, hintHighlight: [], watching: null, watchedLine: null });
    save();
    const { db, coach, startFen } = d.current;
    if (!startFen) await db.setCurrentGame(null).catch(ignore);
    if (teaching()) { endTeachGame(); return; }

    const recap = coach.recap(game, meta.current.verdicts);
    const review = reviewLevels(profile.current);
    if (review.changes.length > 0) setProfile(review.profile);

    let games: SavedGame[] = [];
    try { games = await db.listGames(); } catch { /* keep the rating */ }
    if (!startFen) d.current.onGameListChanged?.();
    const rating = adjustOpponentRating(settings.current.opponentRating, lastFiveScore(games));
    if (rating !== settings.current.opponentRating) setSettings({ ...settings.current, opponentRating: rating });

    // A manual override pins an area's level, so changes underneath it are not announced.
    const { levelOverride } = settings.current;
    set({
      recap,
      levelNotes: review.changes.filter((c) => levelOverride[c.area] === undefined).map(levelChangeText),
      clockSuggestion: suggestClock(review.profile, settings.current) && !settings.current.clockMinutes,
      // Only worth saying while the lines are on, and never in a ?fen= practice game.
      linesOffSuggestion: !startFen && settings.current.attackLines && suggestLinesOff(games),
    });
  };

  const afterPositionChange = () => {
    const game = view.current.game!;
    const result = game.result();
    if (result) { void endGame(result); return; }
    if (game.isUserTurn()) {
      set({ phase: 'user' });
      runPreMove(game);
    } else {
      void opponentTurn();
    }
  };

  const opponentTurn = async () => {
    const game = view.current.game!;
    const g = gen.current;
    set({ phase: 'opponent' });
    const fen = game.fen();
    let analysis: Analysis;
    try {
      analysis = await d.current.engine.analyse(fen, OPPONENT_SEARCH);
    } catch {
      analysis = { fen, depth: 0, lines: [] }; // a stopped or failed search: pick a safe random move
    }
    if (g !== gen.current) return;
    const sans = game.history().map((m) => m.san);
    const uci = selectOpponentMove(
      fen, analysis, sans, game.userColor,
      { rating: settings.current.opponentRating, bookChance: BOOK_CHANCE }, d.current.rng,
    );
    game.play(uci);
    save();
    followWatchedLine(game);
    const result = game.result();
    if (result) { void endGame(result); return; }
    const consequence = d.current.coach.checkConsequence(game);
    // A new position: the nudge and shown questions belonged to the last one. A "stronger option"
    // names a move the user may still play, so it folds away for their decision (top/book stay).
    const foldBetter = view.current.lastMove?.topKind === null;
    set({
      phase: 'user', nudgeFor: null, questionsShownFor: null, betterShownFor: null, showMeFor: null, linesShownFor: null,
      ...(view.current.viewPly !== null ? { newMoveWhileViewing: true } : {}),
      ...(foldBetter ? { lastMoveOpen: false } : {}), ...(consequence ? { consequence } : {}),
    });
    runPreMove(game);
  };

  /** Whether the game since the mistake is still a prefix of the watched line. */
  const onWatchedLine = (game: GameState): boolean => {
    const line = view.current.watchedLine;
    if (!line) return false;
    const since = game.history().slice(watchStart.current);
    return since.length <= line.length && since.every((m, i) => m.uci === line[i].uci);
  };
  /** Once the game leaves the watched line (any move differs), the rule stops for good. */
  const followWatchedLine = (game: GameState) => {
    if (view.current.watchedLine && !onWatchedLine(game)) set({ watchedLine: null });
  };

  const checkUserMove = async (game: GameState, move: ReturnType<GameState['play']>, assisted: boolean) => {
    const g = gen.current;
    const ply = game.history().length - 1;
    let res: Awaited<ReturnType<CoachApi['onUserMove']>> | null = null;
    try { res = await d.current.coach.onUserMove(game, move); } catch { res = null; }
    if (g !== gen.current) return;
    // An unanalysed verdict (engine failure) is no evidence either way: it is neither shown nor recorded.
    if (res && res.verdict.analysed !== false) {
      meta.current.verdicts.push(res.verdict);
      const gameId = meta.current.id || 'test';
      if (teaching()) recordTeachMove(res.verdict, move.fenBefore, { gameId, ply, at: Date.now() });
      else setProfile(recordMove(profile.current, res.verdict, { gameId, ply, fen: move.fenBefore, at: Date.now(), assisted }));
      save();
    }
    const result = game.result();
    if (result) { void endGame(result); return; }
    if (res?.verdict.flagged && res.message) {
      watchedThis.current = false;
      set({ phase: 'mistake', mistake: res.message, watching: null, reveal: null });
      return;
    }
    if (res?.message?.kind === 'post_move') set({ lastMove: res.message, lastMoveOpen: true });
    void opponentTurn();
  };

  const load = (
    game: GameState, id: string, startedAt: number, verdicts: Verdict[],
    saved?: Pick<SavedGame, 'userMoves' | 'attackLinesMoves' | 'mode'>,
  ) => {
    const mode = saved?.mode ?? 'play';
    d.current.coach.setMode(mode);
    teach.current = newTeachGame(profile.current.teaching);
    meta.current = {
      id, startedAt, verdicts: [...verdicts],
      userMoves: saved?.userMoves ?? 0, attackLinesMoves: saved?.attackLinesMoves ?? 0, lastWithLines: false,
    };
    const minutes = settings.current.clockMinutes;
    set({
      ...INITIAL, phase: 'loading', mode, game,
      clock: minutes && mode === 'play' ? { w: minutes * 60_000, b: minutes * 60_000 } : null,
    });
    afterPositionChange();
  };

  // Resume an unfinished game on first mount.
  const started = useRef(false);
  useEffect(() => {
    if (started.current) return;
    started.current = true;
    (async () => {
      const { db, startFen } = d.current;
      if (!startFen) {
        try {
          const id = await db.currentGameId();
          const saved = id ? await db.getGame(id) : undefined;
          if (saved && saved.result === null) {
            load(new GameState(saved.userColor, undefined, saved.moves), saved.id, saved.startedAt, saved.verdicts, saved);
            return;
          }
        } catch { /* unreadable save: start fresh */ }
      }
      set({ phase: 'setup' });
    })();
  }, []);

  // Upgrade the shown message (analysis-backed questions, Explain, Claude's text). Each kind only
  // ever replaces its own slot: a late post_move upgrade must not touch "Now", nor the reverse.
  useEffect(() => subscribe(deps.coach, (m) => {
    const v = view.current;
    if ((m.kind === 'pre_move' || m.kind === 'teach') && v.coachMsg?.id === m.id) set({ coachMsg: m });
    if (m.kind === 'post_move' && v.lastMove?.id === m.id) set({ lastMove: m });
    if (m.kind === 'post_move' && v.reveal?.id === m.id) set({ reveal: m });
    if (m.kind === 'mistake' && v.mistake?.id === m.id) set({ mistake: m });
  }), [deps.coach]);

  // Clock: runs for the side to move; paused on the mistake card, before the game and after it.
  const { phase, clock } = view.current;
  const ticking = clock !== null && (phase === 'user' || phase === 'checking' || phase === 'opponent');
  useEffect(() => {
    if (!ticking) return;
    let last = Date.now();
    const timer = setInterval(() => {
      const v = view.current;
      if (!v.clock || !v.game) return;
      const now = Date.now();
      const side = v.game.turn();
      const left = Math.max(0, v.clock[side] - (now - last));
      last = now;
      set({ clock: { ...v.clock, [side]: left } });
      if (left === 0) void endGame({ winner: opposite(side), reason: 'timeout' });
    }, CLOCK_TICK_MS);
    return () => clearInterval(timer);
  }, [ticking]);

  const actions: GameActions = {
    start(choice, mode = 'play') {
      stopWork();
      const color: Color = choice === 'random' ? (Math.random() < 0.5 ? 'w' : 'b') : choice;
      const { db, startFen } = d.current;
      const game = new GameState(color, startFen);
      const id = `game-${Date.now()}`;
      const startedAt = Date.now();
      if (!startFen) {
        db.saveGame({ id, startedAt, userColor: color, moves: [], verdicts: [], result: null, ...(mode === 'teach' ? { mode } : {}) })
          .then(() => db.setCurrentGame(id))
          .then(() => d.current.onGameListChanged?.())
          .catch(ignore);
      }
      load(game, id, startedAt, [], { mode });
    },

    userMove(uci) {
      const v = view.current;
      const game = v.game;
      if (v.phase !== 'user' || v.promotion || !game || !game.isUserTurn()) return false;
      if (v.viewPly !== null || v.watching) return false; // history view and the watch player are read-only
      const from = uci.slice(0, 2);
      const to = uci.slice(2, 4);
      if (uci.length === 4 && game.needsPromotion(from, to)) {
        set({ promotion: { from, to } });
        return false;
      }
      const fen = game.fen();
      // Using the nudge in this position (kept across a take-back to it) is help.
      const nudged = v.nudgeFor === fen;
      // Show me named the better move, so whatever is played after it is not found on one's own.
      const shown = v.showMeFor === fen;
      // The re-expanded "stronger option" named this move during the decision.
      const playsShownBetter = v.betterShownFor === fen && v.lastMove?.verdict?.bestUci.slice(0, 4) === uci.slice(0, 4);
      // Attack lines show the opponent's threats during the decision: such a move is helped, even if
      // the lines were turned off again before moving.
      const withLines = settings.current.attackLines || v.linesShownFor === fen;
      // After watching the line and playing on: its next user move, while the game still follows it.
      const next = v.watchedLine && onWatchedLine(game) ? v.watchedLine[game.history().length - watchStart.current] : undefined;
      const followsWatched = next?.by === 'user' && next.uci === uci;
      // After watching, then taking back: a retry that plays any user move the line showed.
      const retriesWatched = v.watchedTakeBackFor?.fen === fen && v.watchedTakeBackFor.ucis.includes(uci);
      // Teaching games keep no assisted flags or move counts: nothing of them reaches the assessment.
      const inTeach = v.mode === 'teach';
      const assisted = !inTeach && (nudged || shown || playsShownBetter || withLines || followsWatched || retriesWatched);
      let move;
      try { move = game.play(uci); } catch { return false; }
      followWatchedLine(game);
      if (!inTeach) {
        meta.current.userMoves++;
        if (withLines) meta.current.attackLinesMoves++;
        meta.current.lastWithLines = withLines;
      }
      // Only the latest move's feedback is kept: the previous one goes now.
      set({
        phase: 'checking', coachMsg: null, consequence: null, hints: null, hintHighlight: [], lastMove: null, lastMoveOpen: false,
        reveal: null,
      });
      save();
      void checkUserMove(game, move, assisted);
      return true;
    },

    choosePromotion(piece) {
      const p = view.current.promotion;
      if (!p) return;
      set({ promotion: null });
      actions.userMove(p.from + p.to + piece);
    },

    cancelPromotion() { set({ promotion: null }); },

    takeBack() {
      const game = view.current.game;
      if (!game || view.current.phase !== 'mistake') return;
      stopWork();
      const watched = watchedThis.current && view.current.mistake?.watch ? view.current.mistake.watch : null;
      game.takeBackUserMove();
      if (teaching()) {
        // No hint ladder in teaching games: the turn message (with its options) is shown again.
        save();
        set({ phase: 'user', mistake: null, hints: null, hintHighlight: [], watching: null, reveal: null });
        runPreMove(game);
        return;
      }
      // The taken-back move no longer counts toward this game's moves.
      meta.current.userMoves = Math.max(0, meta.current.userMoves - 1);
      if (meta.current.lastWithLines) meta.current.attackLinesMoves = Math.max(0, meta.current.attackLinesMoves - 1);
      meta.current.lastWithLines = false;
      save();
      // The position never happens, but the watched line showed moves: replaying one from here is help.
      set({
        phase: 'user', mistake: null, hints: [], hintHighlight: [], watching: null, reveal: null,
        ...(watched ? { watchedTakeBackFor: { fen: game.fen(), ucis: watched.filter((p) => p.by === 'user').map((p) => p.uci) } } : {}),
      });
    },

    playOn() {
      const v = view.current;
      const game = v.game;
      if (v.phase !== 'mistake' || !game) return;
      const { coach } = d.current;
      coach.playOn();
      // The teaching mistake card already showed the better move: no second reveal, no watched-line rule.
      if (teaching()) {
        set({ mistake: null, watching: null });
        void opponentTurn();
        return;
      }
      const reveal = coach.playOnReveal();
      const watched = watchedThis.current && v.mistake?.watch ? v.mistake.watch : null;
      watchStart.current = game.history().length;
      // The reveal shows at once in "Your last move", with its green arrow until the opponent replies.
      set({
        mistake: null, watching: null, watchedLine: watched,
        ...(reveal ? { reveal, lastMove: reveal, lastMoveOpen: true } : {}),
      });
      void opponentTurn();
    },

    hint(step) {
      const hints = view.current.hints;
      if (!hints || hints.length !== step - 1 || teaching()) return;
      const { text, highlight } = d.current.coach.hintStep(step);
      if (text) set({ hints: [...hints, text], hintHighlight: highlight });
    },

    showMe() {
      const { hints, game, phase, reveal } = view.current;
      if (!hints || !game || phase !== 'user' || reveal || teaching()) return; // once per reveal
      const message = d.current.coach.showMe();
      if (!message) return;
      // The reveal's green arrow replaces any Hint 2 ring.
      set({ reveal: message, lastMove: message, lastMoveOpen: true, showMeFor: game.fen(), hintHighlight: [] });
    },

    viewPly(n) {
      const game = view.current.game;
      if (!game) return;
      const last = game.history().length - 1;
      // The last ply is the live position itself; -1 is the starting position.
      const ply = n === null || n >= last ? null : Math.max(-1, n);
      set({ viewPly: ply, ...(ply === null ? { newMoveWhileViewing: false } : {}) });
    },

    stepView(delta) {
      const { game, viewPly } = view.current;
      if (!game) return;
      const at = viewPly ?? game.history().length - 1;
      actions.viewPly(at + delta);
    },

    watch() {
      const { phase, mistake } = view.current;
      if (phase !== 'mistake' || !mistake?.watch?.length) return;
      watchedThis.current = true;
      set({ watching: { plies: mistake.watch, index: 0 }, viewPly: null, newMoveWhileViewing: false });
    },

    stepWatch(delta) {
      const w = view.current.watching;
      if (!w) return;
      const index = Math.min(w.plies.length - 1, Math.max(0, w.index + delta));
      if (index !== w.index) set({ watching: { ...w, index } });
    },

    closeWatch() { set({ watching: null }); },

    showOptions() {
      const { game, coachMsg, phase } = view.current;
      if (!game || phase !== 'user' || !coachMsg?.teach || coachMsg.teach.optionsOpen) return;
      const message = d.current.coach.openOptions(coachMsg.id);
      if (!message) return;
      teach.current.optionsOpenedFor = game.fen();
      set({ coachMsg: message });
    },

    watchOption(index) {
      const { coachMsg, phase } = view.current;
      const plies = coachMsg?.teach?.optionsOpen ? coachMsg.teach.options[index]?.watch : null;
      if (phase !== 'user' || !plies?.length) return;
      set({ watching: { plies, index: 0 }, viewPly: null, newMoveWhileViewing: false });
    },

    linesShown(fen) {
      if (view.current.linesShownFor !== fen) view.current = { ...view.current, linesShownFor: fen }; // no re-render needed
    },

    resign() {
      const game = view.current.game;
      if (!game || view.current.phase === 'over') return;
      void endGame({ winner: opposite(game.userColor), reason: 'resign' });
    },

    newGame() {
      stopWork();
      set({ ...INITIAL, phase: 'setup' });
    },

    dismissClockSuggestion() { set({ clockSuggestion: false }); },

    dismissLinesOffSuggestion() { set({ linesOffSuggestion: false }); },

    showQuestions() {
      const { game, coachMsg } = view.current;
      if (game && coachMsg) set({ questionsShownFor: game.fen() });
    },

    nudge() {
      const { game, coachMsg, phase } = view.current;
      if (game && phase === 'user' && coachMsg?.nudge) set({ nudgeFor: game.fen() });
    },

    explainLastMove() {
      const m = view.current.lastMove;
      if (!m) return;
      set({ lastMoveOpen: true });
      d.current.coach.explainTopMove(m.id).catch(ignore);
    },

    ackLastMove() { set({ lastMoveOpen: false }); },

    toggleLastMove() {
      const { lastMoveOpen, lastMove, game, phase } = view.current;
      const open = !lastMoveOpen;
      // Includes the Play-on reveal: it names a move the user could still play now.
      const revealsBetter = open && lastMove?.topKind === null && phase === 'user' && !!game?.isUserTurn();
      set({ lastMoveOpen: open, ...(revealsBetter ? { betterShownFor: game!.fen() } : {}) });
    },

    askCoach() {
      const { game, phase } = view.current;
      if (game && phase === 'user' && !teaching()) runPreMove(game, true);
    },
  };

  return [view.current, actions];
}
