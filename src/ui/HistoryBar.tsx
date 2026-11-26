import type { PlayedMove } from '../types';

/** "Viewing move 2 (White)", from the ply's own position (full-move number and side), or "Viewing the start". */
export function viewingLabel(history: PlayedMove[], viewPly: number): string {
  const m = history[viewPly];
  if (viewPly < 0 || !m) return 'Viewing the start';
  return `Viewing move ${fullMove(m)} (${m.color === 'w' ? 'White' : 'Black'})`;
}

/** The status line: "Viewing move 2 (White) of 5." or "Viewing the start." */
export function viewingStatus(history: PlayedMove[], viewPly: number): string {
  const last = history.at(-1);
  if (viewPly < 0 || !history[viewPly] || !last) return 'Viewing the start.';
  return `${viewingLabel(history, viewPly)} of ${fullMove(last)}.`;
}

function fullMove(m: PlayedMove): number {
  return Number(m.fenBefore.split(' ')[5] ?? '1') || 1;
}

interface Props {
  /** Plies played so far. */
  plies: number;
  /** The viewed ply (0-based; -1 is the starting position), or null for the live game. */
  viewPly: number | null;
  onStep: (delta: -1 | 1) => void;
}

/** ◀ ▶ through the game's history, under the board. Viewing is read-only and never changes the game. */
export function HistoryBar({ plies, viewPly, onStep }: Props) {
  const at = viewPly ?? plies - 1;
  return (
    <div className="history-bar" role="group" aria-label="History">
      <button type="button" aria-label="Previous move" disabled={at < 0} onClick={() => onStep(-1)}>◀</button>
      <button type="button" aria-label="Next move" disabled={viewPly === null} onClick={() => onStep(1)}>▶</button>
    </div>
  );
}

interface ViewingProps {
  label: string;
  /** The opponent moved while the user was viewing. */
  newMove: boolean;
  onBack: () => void;
}

/** Stands in for the coach panel while a past position is shown: nothing about the live position. */
export function ViewingCard({ label, newMove, onBack }: ViewingProps) {
  return (
    <section className="card viewing" aria-label="History view">
      <p className="viewing-label">{label}</p>
      <button type="button" className="primary" onClick={onBack}>{newMove ? 'New move — Back to game' : 'Back to game'}</button>
    </section>
  );
}
