import type { WatchPly } from '../coach/watch';

interface Props {
  plies: WatchPly[];
  index: number;
  onStep: (delta: -1 | 1) => void;
  onClose: () => void;
}

/** Steps through the mistake's consequence line on a read-only board; the live game is untouched. */
export function WatchPlayer({ plies, index, onStep, onClose }: Props) {
  const ply = plies[index];
  return (
    <section className="card watch" aria-label="Watch what happens">
      <h2>Watch what happens</h2>
      <p>
        <span className="muted">Move {index + 1} of {plies.length}: </span>
        <strong>{ply?.by === 'user' ? 'You' : 'They'} play {ply?.san}</strong>
      </p>
      <div className="step-buttons">
        <button type="button" aria-label="Previous move in line" disabled={index <= 0} onClick={() => onStep(-1)}>◀</button>
        <button type="button" aria-label="Next move in line" disabled={index >= plies.length - 1} onClick={() => onStep(1)}>▶</button>
      </div>
      <div className="actions">
        <button type="button" className="primary" onClick={onClose}>Back to the card</button>
      </div>
    </section>
  );
}
