import '@testing-library/jest-dom/vitest';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, act } from '@testing-library/react';
import { SettingsScreen } from '../../src/ui/SettingsScreen';
import { DEFAULT_SETTINGS, defaultProfile, type Db } from '../../src/storage/db';

afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.useRealTimers(); });

describe('SettingsScreen export', () => {
  it('revokes the download URL only after the download has had time to start', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const create = vi.fn(() => 'blob:backup');
    const revoke = vi.fn();
    Object.assign(URL, { createObjectURL: create, revokeObjectURL: revoke });
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    const db = { exportAll: async () => '{}' } as unknown as Db;
    render(
      <SettingsScreen db={db} settings={DEFAULT_SETTINGS} profile={defaultProfile()} onSettings={() => {}} onImported={() => {}} />,
    );
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Export backup' })); });
    expect(click).toHaveBeenCalled();
    expect(screen.getByText(/Backup downloaded/)).toBeInTheDocument();
    expect(revoke).not.toHaveBeenCalled();
    act(() => { vi.advanceTimersByTime(1000); });
    expect(revoke).toHaveBeenCalledWith('blob:backup');
  });
});

describe('SettingsScreen attack lines', () => {
  it('shows the toggle with its label and saves attackLines', () => {
    const onSettings = vi.fn();
    render(
      <SettingsScreen db={{} as Db} settings={DEFAULT_SETTINGS} profile={defaultProfile()} onSettings={onSettings} onImported={() => {}} />,
    );
    const box = screen.getByRole('checkbox', { name: 'Show attack lines — moves made with this on count as helped' });
    expect(box).not.toBeChecked();
    fireEvent.click(box);
    expect(onSettings).toHaveBeenCalledWith({ ...DEFAULT_SETTINGS, attackLines: true });
  });
});
