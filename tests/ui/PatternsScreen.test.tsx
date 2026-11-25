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
});
