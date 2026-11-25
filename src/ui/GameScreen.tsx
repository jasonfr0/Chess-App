import { useMemo, useState, type CSSProperties } from 'react';
import { Chessboard, type Arrow as BoardArrow } from 'react-chessboard';
import type { Arrow, CoachMessage } from '../coach/coach';
import type { Color } from '../types';
import { CoachPanel } from './CoachPanel';
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
const SELECTED: CSSProperties = { background: 'rgba(255, 213, 0, 0.55)' };
const TARGET: CSSProperties = { background: 'radial-gradient(circle, rgba(0,0,0,0.3) 22%, transparent 24%)' };
const LAST_MOVE: CSSProperties = { background: 'rgba(255, 213, 0, 0.3)' };

const STATUS: Record<Phase, string> = {
  loading: 'Loading…', setup: 'Choose your colour to start.', user: 'Your move.',
  checking: 'Coach is looking at your move…', opponent: 'Opponent is thinking…',
  mistake: 'Paused: the coach spotted a problem.', over: 'Game over.',
};

function formatClock(ms: number): string {
  const s = Math.ceil(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

function boardArrows(message: CoachMessage | null, includeBest: boolean): BoardArrow[] {
  if (!message) return [];
  return message.arrows
    .filter((a) => includeBest || a.color !== 'green')
    .map((a) => ({ startSquare: a.from, endSquare: a.to, color: ARROW_COLORS[a.color] }));
}

export function GameScreen({ coachOffline, ...deps }: Props) {
  const [view, actions] = useGame(deps);
  const [selected, setSelected] = useState<string | null>(null);
  const { game, phase } = view;
  const fen = game?.fen();
  const history = game?.history() ?? [];
  const canMove = phase === 'user' && !!game?.isUserTurn() && !view.promotion;

  const level = useMemo(
    () => (game ? levelAt(game, deps.profile, deps.settings) : deps.profile.levels.opening),
    [fen, deps.profile, deps.settings],
  );

  const message = view.coachMsg;
  const showChoices = message !== null && view.choicesShownFor === message.id;
  const arrows = view.mistake
    ? boardArrows(view.mistake, true)
    : boardArrows(message, level === 'full' || showChoices);

  const squareStyles: Record<string, CSSProperties> = {};
  const last = history.at(-1);
  if (last) {
    squareStyles[last.uci.slice(0, 2)] = LAST_MOVE;
    squareStyles[last.uci.slice(2, 4)] = LAST_MOVE;
  }
  if (selected && game && canMove) {
    squareStyles[selected] = SELECTED;
    for (const m of game.legalMovesFrom(selected)) squareStyles[m.slice(2, 4)] = TARGET;
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
      {clockRow(opponentColor, 'Opponent')}
      <div className="board" data-fen={fen ?? ''}>
        <Chessboard
          options={{
            id: 'game',
            position: fen ?? START_FEN,
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

      <p className="status" role="status">{STATUS[phase]}</p>

      {view.promotion && (
        <PromotionPicker color={userColor} onChoose={actions.choosePromotion} onCancel={actions.cancelPromotion} />
      )}

      {phase === 'setup' && (
        <section className="card setup" aria-label="New game">
          <h2>New game: play as</h2>
          <div className="actions">
            <button type="button" className="primary" onClick={() => actions.start('w')}>White</button>
            <button type="button" className="primary" onClick={() => actions.start('b')}>Black</button>
            <button type="button" onClick={() => actions.start('random')}>Random</button>
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
        />
      )}

      {view.mistake && <MistakeCard message={view.mistake} onTakeBack={actions.takeBack} onPlayOn={actions.playOn} />}

      {game && phase !== 'over' && phase !== 'setup' && !view.mistake && (
        <CoachPanel
          message={message}
          consequence={view.consequence}
          level={level}
          showChoices={showChoices}
          onShowChoices={actions.showChoices}
          offline={coachOffline}
          hints={view.hints}
          onHint={actions.nextHint}
          onAskCoach={canMove ? actions.askCoach : undefined}
        />
      )}

      {game && history.length > 0 && (
        <p className="moves" aria-label="Moves">
          {history.map((m, i) => (
            <span key={i}>{i % 2 === 0 && <span className="num">{Math.floor(i / 2) + 1}.</span>}{m.san} </span>
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
