import { useEffect, useRef, useState } from 'react';
import { Chessboard } from 'react-chessboard';
import { THEME_LESSONS } from '../coach/templates';
import type { ProfileData, Theme, ThemeStat } from '../types';

const TOP = 5;

interface Props { profile: ProfileData }

type Example = ThemeStat['examples'][number];

const learned = (s: ThemeStat) => s.teachCount ?? 0;

/** "×3"; with flagged moves from teaching games, "×3 in games · 2 while learning". */
function countText(s: ThemeStat): string {
  return learned(s) > 0 ? `×${s.count} in games · ${learned(s)} while learning` : `×${s.count}`;
}

export function PatternsScreen({ profile }: Props) {
  const [fen, setFen] = useState<string | null>(null);
  const exampleRef = useRef<HTMLElement>(null);
  // The board sits above the list, so a tap low on the page would otherwise show nothing.
  useEffect(() => {
    if (fen) exampleRef.current?.scrollIntoView?.({ behavior: 'smooth', block: 'start' });
  }, [fen]);
  const themes = (Object.entries(profile.themes) as [Theme, ProfileData['themes'][Theme]][])
    .filter(([, s]) => s.count > 0 || learned(s) > 0)
    .sort((a, b) => b[1].count - a[1].count || learned(b[1]) - learned(a[1]))
    .slice(0, TOP);

  const examples = (list: Example[]) => (
    <ul className="examples">
      {[...list].reverse().map((ex, i) => (
        <li key={`${ex.gameId}-${ex.ply}-${i}`}>
          <button type="button" className="link" onClick={() => setFen(ex.fen)}>
            Position from move {Math.floor(ex.ply / 2) + 1}
          </button>
        </li>
      ))}
    </ul>
  );

  return (
    <div className="screen patterns">
      {fen && (
        <section className="card" aria-label="Example position" ref={exampleRef}>
          <div className="board">
            <Chessboard
              options={{
                id: 'pattern', position: fen, allowDragging: false, allowDrawingArrows: false,
                boardOrientation: fen.split(' ')[1] === 'b' ? 'black' : 'white',
              }}
            />
          </div>
          <p className="muted">Your move in this position. What did you miss?</p>
          <button type="button" onClick={() => setFen(null)}>Close</button>
        </section>
      )}
      {themes.length === 0 && (
        <section className="card">
          <h2>My patterns</h2>
          <p>No patterns yet. Play a few games and the coach will collect the habits worth working on.</p>
        </section>
      )}
      {themes.map(([theme, stat]) => (
        <section className="card" key={theme}>
          <h2>{THEME_LESSONS[theme].title} <span className="count">{countText(stat)}</span></h2>
          <p>{THEME_LESSONS[theme].habit}</p>
          {stat.examples.length > 0 && examples(stat.examples)}
          {(stat.teachExamples ?? []).length > 0 && (
            <>
              <h3>While learning</h3>
              {examples(stat.teachExamples!)}
            </>
          )}
        </section>
      ))}
    </div>
  );
}
