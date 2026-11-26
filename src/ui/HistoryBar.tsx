interface Props {
  /** Plies played so far. */
  plies: number;
  /** The viewed ply (0-based), or null for the live game. */
  viewPly: number | null;
  onStep: (delta: -1 | 1) => void;
}

/** ◀ ▶ through the game's history, under the board. Viewing is read-only and never changes the game. */
export function HistoryBar({ plies, viewPly, onStep }: Props) {
  const at = viewPly ?? plies - 1;
  return (
    <div className="history-bar" role="group" aria-label="History">
      <button type="button" aria-label="Previous move" disabled={at <= 0} onClick={() => onStep(-1)}>◀</button>
      <button type="button" aria-label="Next move" disabled={viewPly === null} onClick={() => onStep(1)}>▶</button>
    </div>
  );
}

interface ViewingProps {
  viewPly: number;
  /** The opponent moved while the user was viewing. */
  newMove: boolean;
  onBack: () => void;
}

/** Stands in for the coach panel while a past position is shown: nothing about the live position. */
export function ViewingCard({ viewPly, newMove, onBack }: ViewingProps) {
  return (
    <section className="card viewing" aria-label="History view">
      <p className="viewing-label">Viewing move {viewPly + 1}</p>
      <button type="button" className="primary" onClick={onBack}>{newMove ? 'New move — Back to game' : 'Back to game'}</button>
    </section>
  );
}
