import '@testing-library/jest-dom/vitest';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { CoachPanel } from '../../src/ui/CoachPanel';
import type { CoachMessage } from '../../src/coach/coach';
import type { CoachLevel } from '../../src/types';
import type { Verdict } from '../../src/coach/classify';

afterEach(cleanup);

const preMove = (over: Partial<CoachMessage> = {}): CoachMessage => ({
  id: 'pre-1', kind: 'pre_move', source: 'template', arrows: [{ from: 'e7', to: 'e5', color: 'blue' }],
  explanation: { whatHappened: 'Their pawn takes space in the centre.' },
  theirMove: 'Their pawn takes space in the centre.',
  questions: ['What does their last move attack?', "What's your most useful move: does it develop, defend or attack?"],
  nudge: 'Look at your knight on f6.',
  ...over,
});

const verdict: Verdict = {
  flagged: false, severity: 'ok', cpLoss: 0, area: 'opening', theme: 'other', recommendation: 'play_on',
  bestUci: 'g1f3', bestSan: 'Nf3', refutationSan: [],
};

const postMove = (over: Partial<CoachMessage> = {}): CoachMessage => ({
  id: 'post-1', kind: 'post_move', source: 'template', arrows: [], verdict,
  summary: "✓ That's the top move. Do you see why it works?", topKind: 'top', explained: false,
  explanation: { whatHappened: 'Nf3 develops your knight and attacks e5.' },
  ...over,
});

interface Opts {
  message?: CoachMessage | null; lastMove?: CoachMessage | null; lastMoveOpen?: boolean; level?: CoachLevel;
  questionsShown?: boolean; nudgeShown?: boolean; offline?: boolean;
}

function renderPanel(o: Opts = {}) {
  const handlers = {
    onShowQuestions: vi.fn(), onNudge: vi.fn(), onExplain: vi.fn(), onAck: vi.fn(), onToggleLastMove: vi.fn(),
    onHint: vi.fn(),
  };
  render(
    <CoachPanel
      message={o.message === undefined ? preMove() : o.message}
      lastMove={o.lastMove ?? null}
      lastMoveOpen={o.lastMoveOpen ?? true}
      consequence={null}
      level={o.level ?? 'full'}
      questionsShown={o.questionsShown ?? false}
      nudgeShown={o.nudgeShown ?? false}
      offline={o.offline ?? false}
      hints={null}
      {...handlers}
    />,
  );
  return handlers;
}

const panel = () => screen.getByRole('region', { name: 'Coach' });

describe('CoachPanel', () => {
  it('a pre_move message shows their move and a "Think about" list, and never a best move or candidate list', () => {
    renderPanel();
    expect(screen.getByText('Their pawn takes space in the centre.')).toBeInTheDocument();
    expect(screen.getByText('Think about')).toBeInTheDocument();
    expect(screen.getByText('What does their last move attack?')).toBeInTheDocument();
    expect(panel()).not.toHaveTextContent(/\bbest\b/i);
    expect(panel().querySelector('.candidates')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Show choices' })).not.toBeInTheDocument();
  });

  it('renders no empty paragraph when there is no move of theirs yet', () => {
    renderPanel({ message: preMove({ theirMove: null, explanation: { whatHappened: '' } }) });
    expect(screen.getByText('Think about')).toBeInTheDocument();
    for (const p of panel().querySelectorAll('p')) expect(p.textContent?.trim()).not.toBe('');
  });

  it('at guided, the questions stay hidden until "Show questions"', () => {
    const h = renderPanel({ level: 'guided' });
    expect(screen.getByText('Their pawn takes space in the centre.')).toBeInTheDocument();
    expect(screen.queryByText('What does their last move attack?')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Show questions' }));
    expect(h.onShowQuestions).toHaveBeenCalled();
    cleanup();
    renderPanel({ level: 'guided', questionsShown: true });
    expect(screen.getByText('What does their last move attack?')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Show questions' })).not.toBeInTheDocument();
  });

  it('at light, a message the user asked for shows the full content', () => {
    renderPanel({ level: 'light' });
    expect(screen.getByText('What does their last move attack?')).toBeInTheDocument();
  });

  it('"Need a nudge?" reveals the nudge, and is absent when there is none', () => {
    const h = renderPanel();
    expect(screen.queryByText('Look at your knight on f6.')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Need a nudge?' }));
    expect(h.onNudge).toHaveBeenCalled();
    cleanup();
    renderPanel({ nudgeShown: true });
    expect(screen.getByText('Look at your knight on f6.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Need a nudge?' })).not.toBeInTheDocument();
    cleanup();
    renderPanel({ message: preMove({ nudge: null }) });
    expect(screen.queryByRole('button', { name: 'Need a nudge?' })).not.toBeInTheDocument();
  });

  it('a top post_move asks whether the user sees why, with Yes and Explain', () => {
    const h = renderPanel({ lastMove: postMove() });
    expect(screen.getByText('Your last move')).toBeInTheDocument();
    expect(screen.getByText('Now')).toBeInTheDocument();
    expect(screen.getByText("✓ That's the top move. Do you see why it works?")).toBeInTheDocument();
    expect(screen.queryByText('Nf3 develops your knight and attacks e5.')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Explain it' }));
    expect(h.onExplain).toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Yes, I got it' }));
    expect(h.onAck).toHaveBeenCalled();
  });

  it('an explained top move shows the explanation instead of the buttons', () => {
    renderPanel({ lastMove: postMove({ explained: true }) });
    expect(screen.getByText('Nf3 develops your knight and attacks e5.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Explain it' })).not.toBeInTheDocument();
  });

  it('a book move uses the book wording', () => {
    renderPanel({ lastMove: postMove({ topKind: 'book', summary: '✓ Book move. Do you see why?' }) });
    expect(screen.getByText('✓ Book move. Do you see why?')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Explain it' })).toBeInTheDocument();
  });

  it('a "stronger option" post_move shows its explanation at once, and collapses', () => {
    const lastMove = postMove({
      topKind: null, explained: true, summary: 'Your move: a3. A stronger option was Nf3.',
      explanation: { whatHappened: 'After a3, their best answer is e5.', better: 'Nf3 develops a piece.' },
    });
    const h = renderPanel({ lastMove });
    expect(screen.getByText('Your move: a3. A stronger option was Nf3.')).toBeInTheDocument();
    expect(screen.getByText('Nf3 develops a piece.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Explain it' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /Your last move/ }));
    expect(h.onToggleLastMove).toHaveBeenCalled();
    cleanup();
    renderPanel({ lastMove, lastMoveOpen: false });
    expect(screen.getByRole('button', { name: /Your last move/ })).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByText('Nf3 develops a piece.')).not.toBeInTheDocument();
  });

  it('the offline dot follows the after-move explanation, not the template-only questions', () => {
    renderPanel({ offline: true });
    expect(panel().querySelector('.offline')).toBeNull();
    cleanup();
    renderPanel({ offline: true, lastMove: postMove({ topKind: null, explained: true }) });
    expect(panel().querySelector('.offline')).not.toBeNull();
    cleanup();
    renderPanel({ offline: true, lastMove: postMove({ topKind: null, explained: true, source: 'claude' }) });
    expect(panel().querySelector('.offline')).toBeNull();
    cleanup();
    renderPanel({ offline: true, lastMove: postMove({ topKind: 'book', explained: true }) });
    expect(panel().querySelector('.offline')).toBeNull(); // book ideas never come from Claude
  });
});
