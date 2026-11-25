import '@testing-library/jest-dom/vitest';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { MistakeCard } from '../../src/ui/MistakeCard';
import type { CoachMessage } from '../../src/coach/coach';
import type { Verdict } from '../../src/coach/classify';

afterEach(cleanup);

const verdict = (recommendation: Verdict['recommendation']): Verdict => ({
  flagged: true, severity: 'blunder', cpLoss: 600, area: 'opening', theme: 'hanging_piece', recommendation,
  bestUci: 'd2d4', bestSan: 'd4', refutationSan: ['Nxa6'],
});
const message = (recommendation: Verdict['recommendation']): CoachMessage => ({
  id: 'coach-1', kind: 'mistake', source: 'template', arrows: [], verdict: verdict(recommendation),
  explanation: {
    whatHappened: 'After Ba6, your bishop on a6 can be taken for free.',
    better: 'The better move was d4.',
    lesson: 'Left a piece hanging: ask what is undefended.',
  },
});

describe('MistakeCard', () => {
  it('shows the three sections with their text', () => {
    render(<MistakeCard message={message('take_back')} onTakeBack={() => {}} onPlayOn={() => {}} />);
    expect(screen.getByText('Better move')).toBeInTheDocument();
    expect(screen.getByText('What it costs')).toBeInTheDocument();
    expect(screen.getByText('The lesson')).toBeInTheDocument();
    expect(screen.getByText('The better move was d4.')).toBeInTheDocument();
    expect(screen.getByText(/can be taken for free/)).toBeInTheDocument();
    expect(screen.getByText(/ask what is undefended/)).toBeInTheDocument();
  });

  it('calls onTakeBack and onPlayOn', () => {
    const onTakeBack = vi.fn();
    const onPlayOn = vi.fn();
    render(<MistakeCard message={message('take_back')} onTakeBack={onTakeBack} onPlayOn={onPlayOn} />);
    fireEvent.click(screen.getByRole('button', { name: 'Take it back' }));
    expect(onTakeBack).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole('button', { name: 'Play on' }));
    expect(onPlayOn).toHaveBeenCalledTimes(1);
  });

  it('points the recommended button at the recommendation text', () => {
    render(<MistakeCard message={message('take_back')} onTakeBack={() => {}} onPlayOn={() => {}} />);
    const takeBack = screen.getByRole('button', { name: 'Take it back' });
    const id = takeBack.getAttribute('aria-describedby');
    expect(id).toBeTruthy();
    expect(document.getElementById(id!)).toHaveTextContent(/recommends.*take it back/i);
    expect(screen.getByRole('button', { name: 'Play on' })).not.toHaveAttribute('aria-describedby');
  });

  it('can recommend playing on instead', () => {
    render(<MistakeCard message={message('play_on')} onTakeBack={() => {}} onPlayOn={() => {}} />);
    const playOn = screen.getByRole('button', { name: 'Play on' });
    expect(document.getElementById(playOn.getAttribute('aria-describedby')!)).toHaveTextContent(/recommends.*play on/i);
    expect(screen.getByRole('button', { name: 'Take it back' })).not.toHaveAttribute('aria-describedby');
  });
});
