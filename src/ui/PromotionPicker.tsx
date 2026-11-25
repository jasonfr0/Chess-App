import type { Color } from '../types';

type Piece = 'q' | 'r' | 'b' | 'n';
const CHOICES: { piece: Piece; name: string; glyph: Record<Color, string> }[] = [
  { piece: 'q', name: 'Queen', glyph: { w: '♕', b: '♛' } },
  { piece: 'r', name: 'Rook', glyph: { w: '♖', b: '♜' } },
  { piece: 'b', name: 'Bishop', glyph: { w: '♗', b: '♝' } },
  { piece: 'n', name: 'Knight', glyph: { w: '♘', b: '♞' } },
];

interface Props {
  color: Color;
  onChoose: (piece: Piece) => void;
  onCancel: () => void;
}

export function PromotionPicker({ color, onChoose, onCancel }: Props) {
  return (
    <div className="overlay" onClick={onCancel}>
      <div className="card promotion" role="dialog" aria-modal="true" aria-label="Promote pawn to" onClick={(e) => e.stopPropagation()}>
        <h2>Promote your pawn to</h2>
        <div className="promotion-choices">
          {CHOICES.map((c) => (
            <button key={c.piece} type="button" aria-label={c.name} onClick={() => onChoose(c.piece)}>
              <span className="glyph" aria-hidden="true">{c.glyph[color]}</span>
              <span>{c.name}</span>
            </button>
          ))}
        </div>
        <button type="button" className="link" onClick={onCancel}>Cancel</button>
      </div>
    </div>
  );
}
