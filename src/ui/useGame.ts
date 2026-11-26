import { useEffect, useReducer, useRef } from 'react';
import type { Coach, CoachMessage } from '../coach/coach';
import type { Verdict } from '../coach/classify';
import type { Engine } from '../engine/engine';
import { GameState } from '../game/gameState';
import { adjustOpponentRating, selectOpponentMove } from '../opponent/selectMove';
import { areaOf } from '../coach/classify';
import { lookup } from '../openings/repertoire';
import { levelFor, recordMove } from '../profile/profile';
import { levelChangeText, reviewLevels, suggestClock } from '../profile/weaning';
import type { Db, SavedGame, Settings } from '../storage/db';
import type { Analysis, CoachLevel, Color, GameResult, ProfileData } from '../types';

export type CoachApi = Pick<
  Coach,
  'onUpdate' | 'cancelPending' | 'preMove' | 'onUserMove' | 'explainTopMove' | 'hint' | 'playOn' | 'checkConsequence' | 'recap'
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
  game: GameState | null;
  /** Latest pre-move coaching for the current position. */
  coachMsg: CoachMessage | null;
  consequence: CoachMessage | null;
  mistake: CoachMessage | null;
  /** Set after a take-back: the hint texts revealed so far (up to three). */
  hints: string[] | null;
  promotion: { from: string; to: string } | null;
  clock: Record<Color, number> | null; // ms remaining
  result: GameResult | null;
  recap: CoachMessage | null;
  levelNotes: string[];
  clockSuggestion: boolean;
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
}

export interface GameActions {
  start(choice: Color | 'random'): void;
  /** Returns true if the move was played. */
  userMove(uci: string): boolean;
  choosePromotion(piece: 'q' | 'r' | 'b' | 'n'): void;
  cancelPromotion(): void;
  takeBack(): void;
  playOn(): void;
  nextHint(): void;
  resign(): void;
  newGame(): void;
  dismissClockSuggestion(): void;
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
  phase: 'loading', game: null, coachMsg: null, consequence: null, mistake: null, hints: null,
  promotion: null, clock: null, result: null, recap: null, levelNotes: [], clockSuggestion: false,
  lastMove: null, lastMoveOpen: false, questionsShownFor: null, nudgeFor: null, betterShownFor: null,
};

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
  return games
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
  /** The better move the mistake card showed before a take-back (uci from+to), until the retry is played. */
  const retryBest = useRef<string | null>(null);
  const seen = useRef({ profile: deps.profile, settings: deps.settings });
  if (deps.profile !== seen.current.profile) { seen.current.profile = deps.profile; profile.current = deps.profile; }
  if (deps.settings !== seen.current.settings) { seen.current.settings = deps.settings; settings.current = deps.settings; }

  const gen = useRef(0); // bumped whenever in-flight work must be dropped
  const meta = useRef<{ id: string; startedAt: number; verdicts: Verdict[] }>({ id: '', startedAt: 0, verdicts: [] });

  const setProfile = (p: ProfileData) => { profile.current = p; d.current.onProfile(p); };
  const setSettings = (s: Settings) => { settings.current = s; d.current.onSettings(s); };

  const save = () => {
    const game = view.current.game;
    if (!game || d.current.startFen) return;
    const { id, startedAt, verdicts } = meta.current;
    const record: SavedGame = {
      id, startedAt, userColor: game.userColor, moves: game.toJSON().moves, verdicts: [...verdicts],
      result: view.current.result,
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
    const g = gen.current;
    const fen = game.fen();
    d.current.coach.preMove(game, force ? { force } : undefined).then((m) => {
      if (m && g === gen.current && game.fen() === fen) set({ coachMsg: m });
    }, ignore);
  };

  const endGame = async (result: GameResult) => {
    const game = view.current.game;
    if (!game || view.current.phase === 'over') return;
    gen.current++;
    d.current.coach.cancelPending();
    set({ phase: 'over', result, promotion: null, mistake: null, hints: null });
    save();
    const { db, coach, startFen } = d.current;
    if (!startFen) await db.setCurrentGame(null).catch(ignore);

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
    const result = game.result();
    if (result) { void endGame(result); return; }
    const consequence = d.current.coach.checkConsequence(game);
    // A new position: the nudge and shown questions belonged to the last one. A "stronger option"
    // names a move the user may still play, so it folds away for their decision (top/book stay).
    const foldBetter = view.current.lastMove?.topKind === null;
    set({
      phase: 'user', nudgeFor: null, questionsShownFor: null, betterShownFor: null,
      ...(foldBetter ? { lastMoveOpen: false } : {}), ...(consequence ? { consequence } : {}),
    });
    runPreMove(game);
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
      setProfile(recordMove(profile.current, res.verdict, {
        gameId: meta.current.id || 'test', ply, fen: move.fenBefore, at: Date.now(), assisted,
      }));
      save();
    }
    const result = game.result();
    if (result) { void endGame(result); return; }
    if (res?.verdict.flagged && res.message) {
      set({ phase: 'mistake', mistake: res.message });
      return;
    }
    if (res?.message?.kind === 'post_move') set({ lastMove: res.message, lastMoveOpen: true });
    void opponentTurn();
  };

  const load = (game: GameState, id: string, startedAt: number, verdicts: Verdict[]) => {
    meta.current = { id, startedAt, verdicts: [...verdicts] };
    const minutes = settings.current.clockMinutes;
    set({
      ...INITIAL, phase: 'loading', game,
      clock: minutes ? { w: minutes * 60_000, b: minutes * 60_000 } : null,
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
            load(new GameState(saved.userColor, undefined, saved.moves), saved.id, saved.startedAt, saved.verdicts);
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
    if (m.kind === 'pre_move' && v.coachMsg?.id === m.id) set({ coachMsg: m });
    if (m.kind === 'post_move' && v.lastMove?.id === m.id) set({ lastMove: m });
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
    start(choice) {
      stopWork();
      const color: Color = choice === 'random' ? (Math.random() < 0.5 ? 'w' : 'b') : choice;
      const { db, startFen } = d.current;
      const game = new GameState(color, startFen);
      const id = `game-${Date.now()}`;
      const startedAt = Date.now();
      if (!startFen) {
        db.saveGame({ id, startedAt, userColor: color, moves: [], verdicts: [], result: null })
          .then(() => db.setCurrentGame(id))
          .then(() => d.current.onGameListChanged?.())
          .catch(ignore);
      }
      load(game, id, startedAt, []);
    },

    userMove(uci) {
      const v = view.current;
      const game = v.game;
      if (v.phase !== 'user' || v.promotion || !game || !game.isUserTurn()) return false;
      const from = uci.slice(0, 2);
      const to = uci.slice(2, 4);
      if (uci.length === 4 && game.needsPromotion(from, to)) {
        set({ promotion: { from, to } });
        return false;
      }
      // Using the nudge in this position (kept across a take-back to it) is help.
      const nudged = v.nudgeFor === game.fen();
      // Hint 3 names the move outright, so whatever is played after it is not found on one's own.
      // After a take-back the mistake card has already shown the better move (text and arrow),
      // so replaying exactly that move is not found on one's own either.
      const replaysShownBest = v.hints !== null && retryBest.current === uci.slice(0, 4);
      // The re-expanded "stronger option" named this move during the decision.
      const playsShownBetter = v.betterShownFor === game.fen() && v.lastMove?.verdict?.bestUci.slice(0, 4) === uci.slice(0, 4);
      const assisted = nudged || (v.hints?.length ?? 0) >= 3 || replaysShownBest || playsShownBetter;
      retryBest.current = null;
      let move;
      try { move = game.play(uci); } catch { return false; }
      // Only the latest move's feedback is kept: the previous one goes now.
      set({ phase: 'checking', coachMsg: null, consequence: null, hints: null, lastMove: null, lastMoveOpen: false });
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
      retryBest.current = view.current.mistake?.verdict?.bestUci.slice(0, 4) ?? null;
      game.takeBackUserMove();
      save();
      set({ phase: 'user', mistake: null, hints: [] });
    },

    playOn() {
      if (view.current.phase !== 'mistake') return;
      d.current.coach.playOn();
      set({ mistake: null });
      void opponentTurn();
    },

    nextHint() {
      const hints = view.current.hints;
      if (!hints || hints.length >= 3) return;
      const text = d.current.coach.hint((hints.length + 1) as 1 | 2 | 3);
      if (text) set({ hints: [...hints, text] });
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
      const revealsBetter = open && lastMove?.topKind === null && phase === 'user' && !!game?.isUserTurn();
      set({ lastMoveOpen: open, ...(revealsBetter ? { betterShownFor: game!.fen() } : {}) });
    },

    askCoach() {
      const { game, phase } = view.current;
      if (game && phase === 'user') runPreMove(game, true);
    },
  };

  return [view.current, actions];
}
