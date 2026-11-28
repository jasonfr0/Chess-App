import { useEffect, useMemo, useState, type CSSProperties } from 'react';
import { Chessboard, type Arrow as BoardArrow } from 'react-chessboard';
import { Chess } from 'chess.js';
import type { Arrow, CoachMessage } from '../coach/coach';
import { attackMap } from '../coach/attacks';
import { SUGGEST_LINES_OFF } from '../profile/attackLines';
import type { Color, GameMode } from '../types';
import { CoachPanel } from './CoachPanel';
import { TeachPanel } from './TeachPanel';
import { HistoryBar, ViewingCard, viewingLabel, viewingStatus } from './HistoryBar';
import { WatchPlayer } from './WatchPlayer';
import { MistakeCard } from './MistakeCard';
import { PromotionPicker } from './PromotionPicker';
import { RecapCard } from './RecapCard';
import { levelAt, useGame, type GameDeps, type Phase } from './useGame';

interface Props extends GameDeps {
  /** No key, or Claude's last attempt failed. */
  coachOffline: boolean;
}

const START_FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
const ARROW_COLORS: Record<Arrow['color'], string> = { green: '#1f9d55', red: '#d9302c', blue: '#2f6fd6' };
const SELECTED: CSSProperties = { backgroundColor: 'rgba(255, 213, 0, 0.55)' };
const TARGET: CSSProperties = { backgroundImage: 'radial-gradient(circle, rgba(0,0,0,0.3) 22%, transparent 24%)' };
const LAST_MOVE: CSSProperties = { backgroundColor: 'rgba(255, 213, 0, 0.3)' };
const CHECK: CSSProperties = { backgroundColor: 'rgba(217, 48, 44, 0.75)' };
const RING: CSSProperties = { boxShadow: 'inset 0 0 0 4px rgba(242, 194, 0, 0.95)' };
/** Low opacity so pieces stay readable; an image layer so it sits over the last-move colour. */

export type SquareMark = 'check' | 'ring';

/** Layers b over a: background images stack (b on top), everything else in b wins. */
function layer(a: CSSProperties | undefined, b: CSSProperties): CSSProperties {
  const images = [b.backgroundImage, a?.backgroundImage].filter(Boolean).join(', ');
  return { ...a, ...b, ...(images ? { backgroundImage: images } : {}) };
}

/**
 * Board aids derived from chess.js facts. Check: the checked king's square, always. Rings: only on the
 * live board (not in history view or the watch player). Attack lines: only during the user's live
 * decision, a red arrow from each opponent attacker to each of the user's pieces it hits (no tint). `marks` lists "square:kind" for tests (data-squares).
 */
export function boardDecorations(input: {
  fen: string; userColor: Color; isUserTurn: boolean; viewing: boolean; watching: boolean;
  attackLines: boolean; rings: string[];
}): { squareStyles: Record<string, CSSProperties>; arrows: BoardArrow[]; marks: string[] } {
  const { fen, userColor, isUserTurn, viewing, watching, attackLines, rings } = input;
  const squareStyles: Record<string, CSSProperties> = {};
  const marks: string[] = [];
  const arrows: BoardArrow[] = [];
  const mark = (sq: string, kind: SquareMark, style: CSSProperties) => {
    squareStyles[sq] = layer(squareStyles[sq], style);
    marks.push(`${sq}:${kind}`);
  };
  let chess: Chess | null = null;
  try { chess = new Chess(fen); } catch { /* not a position: nothing to mark */ }
  if (!chess) return { squareStyles, arrows, marks };
  if (chess.isCheck()) for (const sq of chess.findPiece({ type: 'k', color: chess.turn() })) mark(sq, 'check', CHECK);
  const live = !viewing && !watching;
  if (live) for (const sq of new Set(rings)) mark(sq, 'ring', RING);
  if (live && attackLines && isUserTurn) {
    const attacks = attackMap(fen, userColor === 'w' ? 'b' : 'w');
    for (const l of attacks.lines) arrows.push({ startSquare: l.from, endSquare: l.to, color: ARROW_COLORS.red });
  }
  return { squareStyles, arrows, marks };
}

const STATUS: Record<Phase, string> = {
  loading: 'Loading…', setup: 'Choose your colour to start.', user: 'Your move.',
  checking: 'Coach is looking at your move…', opponent: 'Opponent is thinking…',
  mistake: 'Paused: the coach spotted a problem.', over: 'Game over.',
};

function formatClock(ms: number): string {
  const s = Math.ceil(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/**
 * The mistake card's arrows while it is open. Otherwise the blue arrow for their last move, plus the
 * green "stronger option" (or Play on reveal) arrow while "Your last move" is expanded and the board
 * still shows the position right after the user's move: once it is the user's turn again no arrow may
 * suggest a move. The one exception is Show me, whose move then counts as helped (`shownMe`).
 */
function coachArrows(
  mistake: CoachMessage | null, now: CoachMessage | null, lastMove: CoachMessage | null, showBetter: boolean, shownMe: boolean,
): Arrow[] {
  if (mistake) return mistake.arrows;
  const blue = now?.arrows.filter((a) => a.color === 'blue') ?? [];
  const named = (showBetter && lastMove?.topKind === null) || (shownMe && !!lastMove?.reveal);
  const green = named ? lastMove!.arrows.filter((a) => a.color === 'green') : [];
  return [...blue, ...green];
}

/** A teaching game's arrows: the mistake card's, else the turn message's (blue, plus green while the options are open). */
function teachArrows(mistake: CoachMessage | null, now: CoachMessage | null): Arrow[] {
  if (mistake) return mistake.arrows;
  return now?.kind === 'teach' ? now.arrows : [];
}

export const TEACH_LABEL = "Teaching game · doesn't count toward your level";
export const TEACH_NOTE = "The coach shows you good moves before you play. These games don't count toward your level.";
const GAME_TYPES: { mode: GameMode; label: string }[] = [{ mode: 'play', label: 'Play' }, { mode: 'teach', label: 'Play to learn' }];

const toBoard = (arrows: Arrow[]): BoardArrow[] =>
  arrows.map((a) => ({ startSquare: a.from, endSquare: a.to, color: ARROW_COLORS[a.color] }));

export function GameScreen({ coachOffline, ...deps }: Props) {
  const [view, actions] = useGame(deps);
  const [selected, setSelected] = useState<string | null>(null);
  const [gameType, setGameType] = useState<GameMode>('play');
  const { game, phase, watching, viewPly } = view;
  const teaching = view.mode === 'teach';
  const fen = game?.fen();
  const history = game?.history() ?? [];
  const viewing = viewPly !== null && viewPly >= -1 && viewPly < history.length && history.length > 0;
  const watchPly = watching ? watching.plies[watching.index] : null;
  // The position on the board: the watch player's ply, a past ply, or the live game.
  const boardFen = watchPly?.fen ?? (viewing ? (viewPly < 0 ? history[0].fenBefore : history[viewPly].fenAfter) : fen);
  const live = !viewing && !watchPly;
  const canMove = live && phase === 'user' && !!game?.isUserTurn() && !view.promotion;

  const level = useMemo(
    () => (game ? levelAt(game, deps.profile, deps.settings) : deps.profile.levels.opening),
    [fen, deps.profile, deps.settings],
  );

  const message = view.coachMsg;
  const showBetter = view.lastMoveOpen && !!game && !game.isUserTurn() && phase !== 'over';
  const shownMe = view.lastMoveOpen && !!fen && view.showMeFor === fen;
  // History view and the watch player show nothing from the live position; the watch player shows its ply's move.
  const shownArrows: Arrow[] = watchPly
    ? [{ from: watchPly.uci.slice(0, 2), to: watchPly.uci.slice(2, 4), color: watchPly.by === 'opponent' ? 'red' : 'blue' }]
    : viewing ? []
    : teaching ? teachArrows(view.mistake, message)
    : coachArrows(view.mistake, message, view.lastMove, showBetter, shownMe);

  // Rings: the revealed nudge's squares (its position only) and the latest revealed hint's.
  const nudgeRings = fen && view.nudgeFor === fen && message?.nudge ? message.nudgeHighlight ?? [] : [];
  const isUserTurn = phase === 'user' && !!game?.isUserTurn();
  const deco = boardDecorations({
    fen: boardFen ?? START_FEN, userColor: game?.userColor ?? 'w', isUserTurn,
    viewing, watching: !!watchPly,
    attackLines: deps.settings.attackLines, rings: [...nudgeRings, ...view.hintHighlight],
  });
  // Attack lines on the board during this decision: a move from this position counts as made with them.
  const linesDisplayed = live && isUserTurn && deps.settings.attackLines && !!fen;
  useEffect(() => { if (linesDisplayed && fen) actions.linesShown(fen); }, [linesDisplayed, fen]);
  const arrows = [...toBoard(shownArrows), ...deco.arrows];
  const arrowNames = [...shownArrows.map((a) => a.color), ...deco.arrows.map(() => 'red')];

  const squareStyles: Record<string, CSSProperties> = {};
  const last = watchPly ?? (viewing ? history[viewPly] : history.at(-1)); // none at the start
  if (last) {
    squareStyles[last.uci.slice(0, 2)] = LAST_MOVE;
    squareStyles[last.uci.slice(2, 4)] = LAST_MOVE;
  }
  if (selected && game && canMove) {
    squareStyles[selected] = SELECTED;
    for (const m of game.legalMovesFrom(selected)) squareStyles[m.slice(2, 4)] = TARGET;
  }
  // Selection targets stay on top of the attack tint; the check colour wins over the last-move colour.
  for (const [sq, style] of Object.entries(deco.squareStyles)) {
    squareStyles[sq] = squareStyles[sq] === TARGET ? layer(style, TARGET) : layer(squareStyles[sq], style);
  }

  const tryMove = (from: string, to: string): boolean => {
    setSelected(null);
    return actions.userMove(from + to);
  };

  const onSquareClick = ({ square, piece }: { square: string; piece: { pieceType: string } | null }) => {
    if (!game || !canMove) return;
    const mine = piece !== null && piece.pieceType[0] === game.userColor;
    if (selected && selected !== square && !mine) {
      if (game.legalMovesFrom(selected).some((m) => m.slice(2, 4) === square)) tryMove(selected, square);
      else setSelected(null);
      return;
    }
    setSelected(mine && selected !== square ? square : null);
  };

  const userColor: Color = game?.userColor ?? 'w';
  const opponentColor: Color = userColor === 'w' ? 'b' : 'w';
  const clock = view.clock;
  const clockRow = (color: Color, label: string) => clock && (
    <div className={`clock${game?.turn() === color && phase !== 'over' ? ' running' : ''}${clock[color] < 30_000 ? ' low' : ''}`}>
      <span>{label}</span>
      <span className="time" aria-label={`${label} clock`}>{formatClock(clock[color])}</span>
    </div>
  );

  return (
    <div className="game">
      {teaching && game && <p className="teach-label">{TEACH_LABEL}</p>}
      {clockRow(opponentColor, 'Opponent')}
      <div className="board" data-fen={boardFen ?? ''} data-arrows={arrowNames.join(',')}
        data-squares={deco.marks.join(' ')}
      >
        <Chessboard
          options={{
            id: 'game',
            position: boardFen ?? START_FEN,
            boardOrientation: userColor === 'w' ? 'white' : 'black',
            allowDragging: canMove,
            allowDrawingArrows: false,
            arrows,
            squareStyles,
            animationDurationInMs: 200,
            onPieceDrop: ({ sourceSquare, targetSquare }) =>
              targetSquare !== null && canMove ? tryMove(sourceSquare, targetSquare) : false,
            onSquareClick,
          }}
        />
      </div>
      {clockRow(userColor, 'You')}
      {game && history.length > 0 && !watching && (
        <HistoryBar plies={history.length} viewPly={viewing ? viewPly : null} onStep={actions.stepView} />
      )}

      <p className="status" role="status">
        {viewing ? viewingStatus(history, viewPly) : STATUS[phase]}
      </p>

      {view.promotion && (
        <PromotionPicker color={userColor} onChoose={actions.choosePromotion} onCancel={actions.cancelPromotion} />
      )}

      {phase === 'setup' && (
        <section className="card setup" aria-label="New game">
          <div className="game-type" role="radiogroup" aria-label="Game type">
            {GAME_TYPES.map(({ mode, label }) => (
              <button
                key={mode} type="button" role="radio" aria-checked={gameType === mode}
                className={gameType === mode ? 'selected' : ''} onClick={() => setGameType(mode)}
              >
                {label}
              </button>
            ))}
          </div>
          {gameType === 'teach' && <p className="muted">{TEACH_NOTE}</p>}
          <h2>New game: play as</h2>
          <div className="actions">
            <button type="button" className="primary" onClick={() => actions.start('w', gameType)}>White</button>
            <button type="button" className="primary" onClick={() => actions.start('b', gameType)}>Black</button>
            <button type="button" onClick={() => actions.start('random', gameType)}>Random</button>
          </div>
        </section>
      )}

      {phase === 'over' && view.result && game && (
        <RecapCard
          result={view.result}
          userColor={game.userColor}
          recap={view.recap}
          levelNotes={view.levelNotes}
          clockSuggestion={view.clockSuggestion}
          onTurnOnClock={() => {
            deps.onSettings({ ...deps.settings, clockMinutes: 15 });
            actions.dismissClockSuggestion();
          }}
          onNewGame={actions.newGame}
          mode={view.mode}
        />
      )}

      {phase === 'over' && view.linesOffSuggestion && (
        <p className="card lines-suggestion" role="note">
          {SUGGEST_LINES_OFF}{' '}
          <button type="button" onClick={actions.dismissLinesOffSuggestion}>Dismiss</button>
        </p>
      )}

      {viewing && (
        <ViewingCard label={viewingLabel(history, viewPly)} newMove={view.newMoveWhileViewing} onBack={() => actions.viewPly(null)} />
      )}

      {watching && (
        <WatchPlayer
          plies={watching.plies} index={watching.index} onStep={actions.stepWatch} onClose={actions.closeWatch}
          closeLabel={teaching && !view.mistake ? 'Back to the options' : undefined}
        />
      )}

      {view.mistake && !viewing && !watching && (
        <MistakeCard message={view.mistake} onTakeBack={actions.takeBack} onPlayOn={actions.playOn} onWatch={actions.watch} />
      )}

      {teaching && game && phase !== 'over' && phase !== 'setup' && !view.mistake && !viewing && !watching && (
        <TeachPanel
          message={message?.kind === 'teach' ? message : null}
          lastMove={view.lastMove}
          offline={coachOffline}
          onShowOptions={actions.showOptions}
          onWatch={actions.watchOption}
          consequence={view.consequence}
        />
      )}

      {!teaching && game && phase !== 'over' && phase !== 'setup' && !view.mistake && !viewing && (
        <CoachPanel
          message={message}
          lastMove={view.lastMove}
          lastMoveOpen={view.lastMoveOpen}
          onToggleLastMove={actions.toggleLastMove}
          onAck={actions.ackLastMove}
          onExplain={actions.explainLastMove}
          consequence={view.consequence}
          level={level}
          questionsShown={!!fen && view.questionsShownFor === fen}
          onShowQuestions={actions.showQuestions}
          nudgeShown={!!fen && view.nudgeFor === fen}
          onNudge={actions.nudge}
          offline={coachOffline}
          hints={view.hints}
          onHint={actions.hint}
          onShowMe={actions.showMe}
          shownMe={view.reveal !== null}
          onAskCoach={canMove ? actions.askCoach : undefined}
        />
      )}

      {game && history.length > 0 && (
        <p className="moves" aria-label="Moves">
          {history.map((m, i) => (
            <span key={i}>
              {i % 2 === 0 && <span className="num">{Math.floor(i / 2) + 1}.</span>}
              <button
                type="button" className="move" aria-current={viewing && viewPly === i ? 'step' : undefined}
                disabled={!!watching} onClick={() => actions.viewPly(i)}
              >
                {m.san}
              </button>{' '}
            </span>
          ))}
        </p>
      )}

      {game && phase !== 'over' && phase !== 'setup' && phase !== 'loading' && (
        <div className="actions secondary">
          <button
            type="button"
            onClick={() => { if (window.confirm('Resign this game?')) actions.resign(); }}
          >
            Resign
          </button>
        </div>
      )}
    </div>
  );
}
