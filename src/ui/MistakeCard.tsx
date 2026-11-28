import { useId } from 'react';
import type { CoachMessage } from '../coach/coach';

interface Props {
  message: CoachMessage;
  onTakeBack: () => void;
  onPlayOn: () => void;
  /** "▶ Watch what happens": offered only when the message carries a line to watch. */
  onWatch?: () => void;
}

/**
 * Shown when the user's move is flagged; the game is paused until they choose. In Play it never names
 * the better move: that waits for Show me (after a take-back) or the reveal after Play on. A teaching
 * game's card comes with the reveal attached (`reveal`), so the better move is shown on it at once.
 */
export function MistakeCard({ message, onTakeBack, onPlayOn, onWatch }: Props) {
  const recId = useId();
  const headingId = useId();
  const { explanation, verdict } = message;
  const recommendTakeBack = verdict?.recommendation === 'take_back';

  return (
    <section className="card mistake" role="alertdialog" aria-labelledby={headingId}>
      <h2 id={headingId}>{verdict?.severity === 'blunder' ? '✗ Blunder' : '✗ Mistake'}</h2>
      <div className="section">
        <h3>What happened</h3>
        <p>{explanation.whatHappened}</p>
      </div>
      {message.reveal && explanation.better && (
        <div className="section">
          <h3>Better move</h3>
          <p>{explanation.better}</p>
        </div>
      )}
      {explanation.lesson && (
        <div className="section">
          <h3>The lesson</h3>
          <p>{explanation.lesson}</p>
        </div>
      )}
      {message.watch && message.watch.length > 0 && onWatch && (
        <button type="button" className="watch-button" onClick={onWatch}>▶ Watch what happens</button>
      )}
      <p id={recId} className="badge">
        Coach recommends: {recommendTakeBack ? 'Take it back and try again' : 'Play on and handle the position'}
      </p>
      <div className="actions">
        <button
          type="button"
          className={recommendTakeBack ? 'primary' : ''}
          aria-describedby={recommendTakeBack ? recId : undefined}
          onClick={onTakeBack}
        >
          Take it back
        </button>
        <button
          type="button"
          className={recommendTakeBack ? '' : 'primary'}
          aria-describedby={recommendTakeBack ? undefined : recId}
          onClick={onPlayOn}
        >
          Play on
        </button>
      </div>
    </section>
  );
}
