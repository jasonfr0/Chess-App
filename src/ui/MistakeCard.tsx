import { useId } from 'react';
import type { CoachMessage } from '../coach/coach';

const SEVERITY: Record<string, string> = { inaccuracy: 'Inaccuracy', mistake: 'Mistake', blunder: 'Blunder' };

interface Props {
  message: CoachMessage;
  onTakeBack: () => void;
  onPlayOn: () => void;
}

/** Shown when the user's move is flagged; the game is paused until they choose. */
export function MistakeCard({ message, onTakeBack, onPlayOn }: Props) {
  const recId = useId();
  const headingId = useId();
  const { explanation, verdict } = message;
  const recommendTakeBack = verdict?.recommendation === 'take_back';

  return (
    <section className="card mistake" role="alertdialog" aria-labelledby={headingId}>
      <h2 id={headingId}>{(verdict && SEVERITY[verdict.severity]) ?? 'Mistake'}: let's look at that move</h2>
      {explanation.better && (
        <div className="section">
          <h3>Better move</h3>
          <p>{explanation.better}</p>
        </div>
      )}
      <div className="section">
        <h3>What it costs</h3>
        <p>{explanation.whatHappened}</p>
      </div>
      {explanation.lesson && (
        <div className="section">
          <h3>The lesson</h3>
          <p>{explanation.lesson}</p>
        </div>
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
