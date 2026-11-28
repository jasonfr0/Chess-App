import type { CoachMessage } from '../coach/coach';

interface Props {
  /** The teaching turn message (kind 'teach') for the position on the board; null until it arrives. */
  message: CoachMessage | null;
  /** The confirmation of the user's latest good move ("Your last move"). */
  lastMove: CoachMessage | null;
  /** Shows the "coach offline" dot when the position text is a template because Claude is unavailable. */
  offline: boolean;
  /** Guide mode: "Show me options". */
  onShowOptions: () => void;
  /** "Watch" on option `index` (0-based). */
  onWatch: (index: number) => void;
  /** After Play on: what the mistake led to, when it happened. */
  consequence?: CoachMessage | null;
  /** The user's turn is being analysed and its message has not arrived yet. */
  pending?: boolean;
}

export const NO_OPTIONS = 'The coach has no checked options for this position. Play the move you think is best.';
export const THINKING = 'The coach is looking at the position…';

/**
 * A teaching game's coach panel: their move, the position and the good options (show mode), or the
 * questions and "Show me options" (guide mode). While the options are closed nothing of them is in the
 * page, not even hidden. No Play level decides what shows here.
 */
export function TeachPanel({ message, lastMove, offline, onShowOptions, onWatch, consequence, pending = false }: Props) {
  const thinking = pending && !message;
  if (!message && !lastMove && !consequence && !thinking) return null;
  const teach = message?.teach;
  const options = teach?.options ?? [];
  // Only a turn with options is offered to Claude for rewording.
  const offlineDot = offline && options.length > 0 && message?.source === 'template';

  return (
    <section className="card coach teach-panel" aria-label="Coach">
      <div className="coach-head">
        <span className="coach-title">
          Coach
          {offlineDot && <span className="offline" title="Coach offline: using built-in explanations"><span className="dot" aria-hidden="true" /> coach offline</span>}
        </span>
      </div>
      <div className="coach-body">
        {lastMove && (
          <div className="last-move">
            <h3 className="section-title">Your last move</h3>
            {lastMove.summary && <p className="summary">{lastMove.summary}</p>}
            {lastMove.explanation.whatHappened && <p>{lastMove.explanation.whatHappened}</p>}
            {lastMove.explanation.lesson && <p className="muted">{lastMove.explanation.lesson}</p>}
          </div>
        )}
        {consequence && (
          <div className="consequence">
            <p>{consequence.explanation.whatHappened}</p>
            {consequence.explanation.lesson && <p className="muted">{consequence.explanation.lesson}</p>}
          </div>
        )}
        {message && <Turn message={message} onShowOptions={onShowOptions} onWatch={onWatch} />}
        {thinking && <div className="now"><p className="muted">{THINKING}</p></div>}
      </div>
    </section>
  );
}

function Turn({ message, onShowOptions, onWatch }: { message: CoachMessage } & Pick<Props, 'onShowOptions' | 'onWatch'>) {
  const teach = message.teach;
  const options = teach?.options ?? [];
  const questions = message.questions ?? [];
  return (
    <div className="now">
      {message.theirMove && (
        <>
          <h3 className="section-title">Computer played</h3>
          <p className="what">{message.theirMove}</p>
        </>
      )}
      <h3 className="section-title">The position</h3>
      <p>{teach?.position ?? message.explanation.whatHappened}</p>
      {teach?.mode === 'guide' && questions.length > 0 && (
        <div className="questions">
          <h4>Think about</h4>
          <ul>{questions.map((q) => <li key={q}>{q}</li>)}</ul>
        </div>
      )}
      {options.length === 0 ? (
        <p>{NO_OPTIONS}</p>
      ) : teach?.optionsOpen ? (
        <>
          <h3 className="section-title">Good options</h3>
          <ol className="options">
            {options.map((o, i) => (
              <li key={o.uci}>
                <div className="option">
                  <span className="option-text"><strong>{o.san}</strong> – {o.reason}</span>
                  {o.watch && (
                    <button type="button" aria-label={`Watch option ${i + 1}`} onClick={() => onWatch(i)}>Watch</button>
                  )}
                </div>
              </li>
            ))}
          </ol>
        </>
      ) : (
        <div className="actions">
          <button type="button" className="primary" onClick={onShowOptions}>Show me options</button>
        </div>
      )}
    </div>
  );
}
