import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { UpdateBanner } from '../../src/ui/UpdateBanner';
import { ErrorBoundary } from '../../src/ui/ErrorBoundary';

describe('UpdateBanner', () => {
  it('shows nothing when no update is waiting', () => {
    const { container } = render(<UpdateBanner needRefresh={false} onReload={() => {}} onDismiss={() => {}} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('offers a reload when a new version is ready', () => {
    const onReload = vi.fn();
    const onDismiss = vi.fn();
    render(<UpdateBanner needRefresh onReload={onReload} onDismiss={onDismiss} />);
    expect(screen.getByRole('status')).toHaveTextContent('A new version is ready');
    fireEvent.click(screen.getByRole('button', { name: 'Reload' }));
    expect(onReload).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByRole('button', { name: 'Later' }));
    expect(onDismiss).toHaveBeenCalledOnce();
  });
});

describe('ErrorBoundary', () => {
  it('shows the error message and a reload button instead of a frozen screen', () => {
    const Boom = () => { throw new Error('kaboom in render'); };
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    render(<ErrorBoundary><Boom /></ErrorBoundary>);
    spy.mockRestore();
    expect(screen.getByRole('alert')).toHaveTextContent('Something went wrong');
    expect(screen.getByRole('alert')).toHaveTextContent('kaboom in render');
    expect(screen.getByRole('button', { name: 'Reload the app' })).toBeInTheDocument();
  });

  it('renders children when nothing throws', () => {
    render(<ErrorBoundary><p>fine</p></ErrorBoundary>);
    expect(screen.getByText('fine')).toBeInTheDocument();
  });
});
