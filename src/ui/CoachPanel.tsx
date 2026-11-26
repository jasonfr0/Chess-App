import { useState } from 'react';
import type { CoachMessage } from '../coach/coach';
import type { CoachLevel } from '../types';

interface Props {
  /** Pre-move coaching for the position on the board ("Now"). */
  message: CoachMessage | null;
  /** Feedback on the user's latest move ("Your last move"). */
  lastMove: CoachMessage | null;
  lastMoveOpen: boolean;
  onToggleLastMove: () => void;
  /** "Yes, I got it". */
  onAck: () => void;
  /** "Explain it". */
  onExplain: () => void;
  consequence: CoachMessage | null;
  level: CoachLevel;
  /** At guided the questions wait for "Show questions". */
  questionsShown: boolean;
  onShowQuestions: () => void;
  nudgeShown: boolean;
  onNudge: () => void;
  /** Shows the "coach offline" dot when an after-move explanation is a template because Claude is unavailable. */
  offline: boolean;
  hints: string[] | null;
  onHint: () => void;
  /** Offered at light, where the coach stays quiet unless asked. Omitted when the user cannot move. */
  onAskCoach?: () => void;
}

const LEVEL_WORDS: Record<CoachLevel, string> = { full: 'Full', guided: 'Guided', light: 'Light', solo: 'Solo' };

/** True when the shown after-move text is one Claude would write (book ideas never are). */
function claudeEligible(m: CoachMessage | null): m is CoachMessage {
  return m !== null && (m.topKind === null || (m.topKind === 'top' && m.explained === true));
}

/** Once explained, a top or book move's line no longer asks "Do you see why…?". */
const EXPLAINED_SUMMARY = { top: "✓ That's the top move.", book: '✓ Book move.' } as const;

function summaryOf(m: CoachMessage): string | undefined {
  return m.topKind && m.explained ? EXPLAINED_SUMMARY[m.topKind] : m.summary;
}

function Explanation({ message }: { message: CoachMessage }) {
  const { whatHappened, better, lesson } = message.explanation;
  return (
    <>
      {whatHappened && <p>{whatHappened}</p>}
      {better && <p>{better}</p>}
      {lesson && <p className="muted">{lesson}</p>}
    </>
  );
}

export function CoachPanel(p: Props) {
  const { message, lastMove, consequence, level, hints } = p;
  const [open, setOpen] = useState(true);
  const offlineDot = p.offline && claudeEligible(lastMove) && lastMove.source === 'template';
  // Guided hides the questions until asked; light only has a message when the user asked the coach.
  const questionsVisible = level !== 'guided' || p.questionsShown;
  const questions = message?.questions ?? [];

  return (
    <section className="card coach" aria-label="Coach">
      <button type="button" className="coach-head" aria-expanded={open} onClick={() => setOpen(!open)}>
        <span className="coach-title">
          Coach <span className="muted">· {LEVEL_WORDS[level]}</span>
          {offlineDot && <span className="offline" title="Coach offline: using built-in explanations"><span className="dot" aria-hidden="true" /> coach offline</span>}
        </span>
        <span aria-hidden="true">{open ? '▾' : '▸'}</span>
      </button>
      {open && (
        <div className="coach-body">
          {lastMove && (
            <div className="last-move">
              <button type="button" className="section-head" aria-expanded={p.lastMoveOpen} onClick={p.onToggleLastMove}>
                <span>Your last move</span>
                <span aria-hidden="true">{p.lastMoveOpen ? '▾' : '▸'}</span>
              </button>
              {p.lastMoveOpen && (
                <div className="section-body">
                  {summaryOf(lastMove) && <p className="summary">{summaryOf(lastMove)}</p>}
                  {lastMove.topKind !== null && lastMove.explained === false ? (
                    <div className="actions">
                      <button type="button" onClick={p.onAck}>Yes, I got it</button>
                      <button type="button" onClick={p.onExplain}>Explain it</button>
                    </div>
                  ) : (
                    <Explanation message={lastMove} />
                  )}
                </div>
              )}
            </div>
          )}
          {consequence && (
            <div className="consequence">
              <p>{consequence.explanation.whatHappened}</p>
              {consequence.explanation.lesson && <p className="muted">{consequence.explanation.lesson}</p>}
            </div>
          )}
          {hints && (
            <div className="hints">
              <p>Try again. Find a better move.</p>
              <ol>{hints.map((h) => <li key={h}>{h}</li>)}</ol>
              <div className="hint-buttons">
                {[1, 2, 3].map((step) => (
                  <button key={step} type="button" disabled={hints.length !== step - 1} onClick={p.onHint}>
                    Hint {step}
                  </button>
                ))}
              </div>
            </div>
          )}
          {!message && level === 'light' && p.onAskCoach && (
            <button type="button" onClick={p.onAskCoach}>Ask the coach</button>
          )}
          {message && (
            <div className="now">
              {lastMove && <h3 className="section-title">Now</h3>}
              {message.theirMove && <p className="what">{message.theirMove}</p>}
              {questions.length > 0 && (questionsVisible ? (
                <div className="questions">
                  <h4>Think about</h4>
                  <ul>{questions.map((q) => <li key={q}>{q}</li>)}</ul>
                </div>
              ) : (
                <button type="button" onClick={p.onShowQuestions}>Show questions</button>
              ))}
              {message.nudge && (p.nudgeShown
                ? <p className="nudge">{message.nudge}</p>
                : <button type="button" className="link" onClick={p.onNudge}>Need a nudge?</button>)}
            </div>
          )}
        </div>
      )}
    </section>
  );
}
