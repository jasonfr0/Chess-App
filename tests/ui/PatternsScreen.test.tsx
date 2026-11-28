import '@testing-library/jest-dom/vitest';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { PatternsScreen } from '../../src/ui/PatternsScreen';
import { defaultProfile } from '../../src/storage/db';

vi.mock('react-chessboard', () => ({ Chessboard: () => <div data-testid="board" /> }));

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe('PatternsScreen', () => {
  it('scrolls the example board into view when an example is tapped', () => {
    const scroll = vi.fn();
    Element.prototype.scrollIntoView = scroll;
    const profile = defaultProfile();
    profile.themes.hanging_piece = {
      count: 2, lastSeen: 1,
      examples: [{ gameId: 'g', ply: 8, fen: '4k3/8/8/8/8/8/8/4K3 w - - 0 1' }],
    };
    render(<PatternsScreen profile={profile} />);
    expect(scroll).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Position from move 5' }));
    const region = screen.getByRole('region', { name: 'Example position' });
    expect(scroll).toHaveBeenCalledTimes(1);
    expect(scroll.mock.contexts[0]).toBe(region);
  });

  it('shows game and learning counts', () => {
    const profile = defaultProfile();
    profile.themes.hanging_piece = {
      count: 3, lastSeen: 1, teachCount: 2,
      examples: [{ gameId: 'g', ply: 8, fen: '4k3/8/8/8/8/8/8/4K3 w - - 0 1' }],
      teachExamples: [{ gameId: 't', ply: 4, fen: '4k3/8/8/8/8/8/8/4K3 w - - 0 1' }],
    };
    render(<PatternsScreen profile={profile} />);
    expect(screen.getByText('×3 in games · 2 while learning')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'While learning' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Position from move 3' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Position from move 5' })).toBeInTheDocument();
  });

  it('a learning-only theme is listed', () => {
    const profile = defaultProfile();
    profile.themes.hanging_piece = {
      count: 0, lastSeen: 1, teachCount: 1, examples: [],
      teachExamples: [{ gameId: 't', ply: 4, fen: '4k3/8/8/8/8/8/8/4K3 w - - 0 1' }],
    };
    render(<PatternsScreen profile={profile} />);
    expect(screen.queryByText(/No patterns yet/)).not.toBeInTheDocument();
    expect(screen.getByText('×0 in games · 1 while learning')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Position from move 3' }));
    expect(screen.getByRole('region', { name: 'Example position' })).toBeInTheDocument();
  });

  it('a theme with no learning count keeps ×3', () => {
    const profile = defaultProfile();
    profile.themes.hanging_piece = { count: 3, lastSeen: 1, examples: [] };
    render(<PatternsScreen profile={profile} />);
    expect(screen.getByText('×3')).toBeInTheDocument();
    expect(screen.queryByText(/in games|while learning/)).not.toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'While learning' })).not.toBeInTheDocument();
  });
});
