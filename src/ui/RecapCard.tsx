import type { CoachMessage } from '../coach/coach';
import type { Color, GameResult } from '../types';

const REASONS: Record<GameResult['reason'], string> = {
  checkmate: 'checkmate', stalemate: 'stalemate', repetition: 'repetition', fifty_move: 'the fifty-move rule',
  insufficient: 'insufficient material', resign: 'resignation', timeout: 'time',
};

function headline(result: GameResult, userColor: Color): string {
  if (result.winner === null) return `Draw by ${REASONS[result.reason]}`;
  return `${result.winner === userColor ? 'You won' : 'You lost'} by ${REASONS[result.reason]}`;
}

interface Props {
  result: GameResult;
  userColor: Color;
  recap: CoachMessage | null;
  levelNotes: string[];
  clockSuggestion: boolean;
  onTurnOnClock: () => void;
  onNewGame: () => void;
}

export function RecapCard({ result, userColor, recap, levelNotes, clockSuggestion, onTurnOnClock, onNewGame }: Props) {
  const e = recap?.explanation;
  return (
    <section className="card recap" aria-label="Game over">
      <h2>{headline(result, userColor)}</h2>
      {e && (
        <ul className="recap-lines">
          <li>{e.whatHappened}</li>
          {e.better && <li>{e.better}</li>}
          {e.lesson && <li>{e.lesson}</li>}
        </ul>
      )}
      {levelNotes.map((t) => <p key={t} className="level-note">{t}</p>)}
      {clockSuggestion && (
        <p className="clock-suggestion">
          You're ready to practise with a clock.{' '}
          <button type="button" onClick={onTurnOnClock}>Turn on 15-minute clock</button>
        </p>
      )}
      <div className="actions">
        <button type="button" className="primary" onClick={onNewGame}>New game</button>
      </div>
    </section>
  );
}
