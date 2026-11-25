import { useState } from 'react';
import type { CoachMessage } from '../coach/coach';
import type { CoachLevel } from '../types';

interface Props {
  message: CoachMessage | null;
  consequence: CoachMessage | null;
  level: CoachLevel;
  showChoices: boolean;
  onShowChoices: () => void;
  /** Shows the "coach offline" dot when the shown text is a template because Claude is unavailable. */
  offline: boolean;
  hints: string[] | null;
  onHint: () => void;
}

const LEVEL_WORDS: Record<CoachLevel, string> = { full: 'Full', guided: 'Guided', light: 'Light', solo: 'Solo' };

export function CoachPanel({ message, consequence, level, showChoices, onShowChoices, offline, hints, onHint }: Props) {
  const [open, setOpen] = useState(true);
  const [revealedFor, setRevealedFor] = useState<string | null>(null);
  const shown = message ?? consequence;
  const offlineDot = offline && shown !== null && shown.source === 'template';
  const candidates = message?.explanation.candidates ?? [];
  const choicesVisible = level === 'full' || showChoices;

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
                  <button key={step} type="button" disabled={hints.length !== step - 1} onClick={onHint}>
                    Hint {step}
                  </button>
                ))}
              </div>
            </div>
          )}
          {message && (
            <>
              <p className="what">{message.explanation.whatHappened}</p>
              {candidates.length > 0 && (choicesVisible ? (
                <ul className="candidates">
                  {candidates.map((c) => (
                    <li key={c.uci}>
                      <strong>{c.san}</strong>{c.best && <span className="best"> best</span>} — {c.note}
                    </li>
                  ))}
                </ul>
              ) : (
                <button type="button" onClick={onShowChoices}>Show choices</button>
              ))}
              {message.blunderCheck && (
                <div className="blunder-check">
                  <p><strong>Blunder check:</strong> {message.blunderCheck.prompt}</p>
                  {revealedFor === message.id
                    ? <p className="answer">{message.blunderCheck.answer}</p>
                    : <button type="button" onClick={() => setRevealedFor(message.id)}>Reveal answer</button>}
                </div>
              )}
            </>
          )}
        </div>
      )}
    </section>
  );
}
