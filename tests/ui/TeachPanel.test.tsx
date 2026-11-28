import '@testing-library/jest-dom/vitest';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { TeachPanel } from '../../src/ui/TeachPanel';
import type { CoachMessage } from '../../src/coach/coach';
import type { TeachOption } from '../../src/teach/options';
import type { TeachMode } from '../../src/types';
import type { Verdict } from '../../src/coach/classify';

afterEach(cleanup);

const OPTIONS: TeachOption[] = [
  {
    uci: 'e1g1', san: 'O-O', reason: 'It gets your king safe before anything opens up.',
    watch: [
      { uci: 'e1g1', san: 'O-O', fen: '8/8/8/8/8/8/8/K6k b - - 0 1', by: 'user' },
      { uci: 'g8f6', san: 'Nf6', fen: '8/8/8/8/8/8/8/K6k w - - 0 1', by: 'opponent' },
    ],
  },
  { uci: 'c2c3', san: 'c3', reason: 'It prepares to push d4 and take the centre.', watch: null },
];

const teach = (mode: TeachMode, options: TeachOption[] = OPTIONS, over: Partial<CoachMessage> = {}): CoachMessage => ({
  id: 'teach-1', kind: 'teach', source: 'template', arrows: [],
  explanation: { whatHappened: 'Their bishop now aims at f2.' },
  theirMove: 'Their bishop now aims at f2, next to your king.',
  questions: ['What does their last move attack?'],
  nudge: 'Look at your king.',
  teach: {
    topic: 'opening', mode, position: 'Their bishop now aims at f2.', options,
    optionsOpen: mode === 'show', inBook: true,
  },
  ...over,
});

const verdict: Verdict = {
  flagged: false, severity: 'ok', cpLoss: 0, area: 'opening', theme: 'other', recommendation: 'play_on',
  bestUci: 'g1f3', bestSan: 'Nf3', refutationSan: [],
};
const goodMove: CoachMessage = {
  id: 'post-1', kind: 'post_move', source: 'template', arrows: [], verdict, summary: '✓ Good move.',
  topKind: 'top', explained: true, explanation: { whatHappened: 'Nf3 was one of the options shown.' },
};

function renderPanel(message: CoachMessage, lastMove: CoachMessage | null = null) {
  const onShowOptions = vi.fn();
  const onWatch = vi.fn();
  render(<TeachPanel message={message} lastMove={lastMove} offline={false} onShowOptions={onShowOptions} onWatch={onWatch} />);
  return { onShowOptions, onWatch };
}

describe('TeachPanel', () => {
  it('lists options with reasons and Watch buttons', () => {
    const { onWatch } = renderPanel(teach('show'));
    expect(screen.getByText('Computer played')).toBeInTheDocument();
    expect(screen.getByText('Their bishop now aims at f2, next to your king.')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'The position' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Good options' })).toBeInTheDocument();
    const items = screen.getAllByRole('listitem');
    expect(items).toHaveLength(2);
    expect(items[0]).toHaveTextContent('O-O – It gets your king safe before anything opens up.');
    expect(items[1]).toHaveTextContent('c3 – It prepares to push d4 and take the centre.');
    expect(screen.getAllByRole('button', { name: /^Watch option/ })).toHaveLength(1);
    expect(screen.queryByRole('button', { name: 'Watch option 2' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Watch option 1' }));
    expect(onWatch).toHaveBeenCalledWith(0);
    expect(screen.queryByRole('button', { name: 'Show me options' })).not.toBeInTheDocument();
    expect(screen.queryByText('Need a nudge?')).not.toBeInTheDocument();
  });

  it('guide mode shows questions and Show me options, no option text', () => {
    const { onShowOptions } = renderPanel(teach('guide'));
    expect(screen.getByText('What does their last move attack?')).toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/O-O|\bc3\b/);
    expect(document.body.textContent).not.toContain('king safe before');
    expect(document.body.textContent).not.toContain('push d4');
    expect(screen.queryByRole('heading', { name: 'Good options' })).not.toBeInTheDocument();
    expect(screen.queryByText('Need a nudge?')).not.toBeInTheDocument();
    expect(screen.queryByText('Look at your king.')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Show me options' }));
    expect(onShowOptions).toHaveBeenCalledTimes(1);
  });

  it('no options shows the fallback line', () => {
    renderPanel(teach('show', []));
    expect(screen.getByText('The coach has no checked options for this position. Play the move you think is best.')).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Good options' })).not.toBeInTheDocument();
  });

  it('omits "Computer played" when there is no last move to describe', () => {
    renderPanel(teach('show', OPTIONS, { theirMove: null }));
    expect(screen.queryByText('Computer played')).not.toBeInTheDocument();
  });

  it('shows a good move\'s confirmation under "Your last move" with no Explain buttons', () => {
    renderPanel(teach('show'), goodMove);
    expect(screen.getByText('Your last move')).toBeInTheDocument();
    expect(screen.getByText('✓ Good move.')).toBeInTheDocument();
    expect(screen.getByText('Nf3 was one of the options shown.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Explain it' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Yes, I got it' })).not.toBeInTheDocument();
  });
});
