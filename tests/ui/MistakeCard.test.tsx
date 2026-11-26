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
    lesson: 'Left a piece hanging: ask what is undefended.',
  },
});
const watch = [{ uci: 'b7a6', san: 'bxa6', fen: '8/8/8/8/8/8/8/K6k w - - 0 1', by: 'opponent' as const }];

describe('MistakeCard', () => {
  it('shows the title, what happened and the lesson, and no better move', () => {
    render(<MistakeCard message={message('take_back')} onTakeBack={() => {}} onPlayOn={() => {}} />);
    expect(screen.getByRole('heading', { level: 2 })).toHaveTextContent(/^✗ Blunder$/);
    expect(screen.getByText('What happened')).toBeInTheDocument();
    expect(screen.getByText('The lesson')).toBeInTheDocument();
    expect(screen.getByText(/can be taken for free/)).toBeInTheDocument();
    expect(screen.getByText(/ask what is undefended/)).toBeInTheDocument();
    expect(screen.queryByText(/better move/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/\bd4\b/)).not.toBeInTheDocument();
  });

  it('titles a mistake "✗ Mistake"', () => {
    const m = message('play_on');
    render(<MistakeCard message={{ ...m, verdict: { ...m.verdict!, severity: 'mistake' } }} onTakeBack={() => {}} onPlayOn={() => {}} />);
    expect(screen.getByRole('heading', { level: 2 })).toHaveTextContent(/^✗ Mistake$/);
  });

  it('offers "▶ Watch what happens" only when the message has a line to watch', () => {
    const onWatch = vi.fn();
    render(<MistakeCard message={message('take_back')} onTakeBack={() => {}} onPlayOn={() => {}} onWatch={onWatch} />);
    expect(screen.queryByRole('button', { name: '▶ Watch what happens' })).not.toBeInTheDocument();
    cleanup();
    render(<MistakeCard message={{ ...message('take_back'), watch }} onTakeBack={() => {}} onPlayOn={() => {}} onWatch={onWatch} />);
    fireEvent.click(screen.getByRole('button', { name: '▶ Watch what happens' }));
    expect(onWatch).toHaveBeenCalledTimes(1);
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
