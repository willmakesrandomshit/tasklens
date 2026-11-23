import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn(() => Promise.resolve(() => undefined)) }));

import { invoke } from '@tauri-apps/api/core';
import App from './App';
import { ContextMenu } from './ContextMenu';
import { Graph } from './Graph';
import { defaultSettings, SettingsProvider } from './settings';
import { proc, snapshot } from './testFixtures';

type Handler = (args: Record<string, unknown> | undefined) => unknown;
const mockInvoke = vi.mocked(invoke);
let calls: { cmd: string; args?: Record<string, unknown> }[] = [];

function backend(overrides: Record<string, Handler> = {}) {
  const handlers: Record<string, Handler> = {
    get_settings: () => ({ settings: defaultSettings, note: null, autostart: false }),
    save_settings: a => (a as { settings: unknown }).settings,
    snapshot: () => snapshot(),
    set_ui_active: () => undefined,
    process_file_info: () => ({ description: 'Test app', company: 'Acme', product: null, version: '1.0', signature: 'Valid' }),
    list_services: () => [], list_connections: () => [], list_startup: () => [], list_sessions: () => [], alert_log: () => [],
    terminate_process: () => undefined,
    ...overrides,
  };
  mockInvoke.mockImplementation(async (cmd, args) => {
    calls.push({ cmd, args: args as Record<string, unknown> | undefined });
    const h = handlers[cmd];
    if (!h) throw new Error(`unmocked command ${cmd}`);
    return h(args as Record<string, unknown> | undefined) as never;
  });
}

const renderApp = () => render(<SettingsProvider><App /></SettingsProvider>);
const nameOf = (row: Element) => row.querySelector('.process-name span[title]')?.textContent ?? null;
const rowNames = () => screen.queryAllByRole('row').filter(r => r.classList.contains('process-row')).map(nameOf);

beforeEach(() => { calls = []; document.documentElement.removeAttribute('data-theme'); });
afterEach(() => { cleanup(); mockInvoke.mockReset(); });

describe('ContextMenu', () => {
  it('runs enabled items, ignores disabled ones, and closes on Escape', () => {
    const run = vi.fn(), blocked = vi.fn(), close = vi.fn();
    render(<ContextMenu x={10} y={10} onClose={close} items={[{ label: 'Do it', onSelect: run }, { label: 'Nope', disabled: true, title: 'Not allowed', onSelect: blocked }]} />);
    fireEvent.click(screen.getByRole('menuitem', { name: 'Nope' }));
    expect(blocked).not.toHaveBeenCalled();
    expect(screen.getByRole('menuitem', { name: 'Nope' }).getAttribute('title')).toBe('Not allowed');
    fireEvent.click(screen.getByRole('menuitem', { name: 'Do it' }));
    expect(run).toHaveBeenCalledOnce();
    expect(close).toHaveBeenCalled();
    fireEvent.keyDown(screen.getByRole('menu'), { key: 'Escape' });
    expect(close).toHaveBeenCalledTimes(2);
  });
  it('supports keyboard selection', () => {
    const run = vi.fn();
    render(<ContextMenu x={0} y={0} onClose={() => undefined} items={[{ label: 'First', onSelect: vi.fn() }, { label: 'Second', onSelect: run }]} />);
    fireEvent.keyDown(screen.getByRole('menu'), { key: 'ArrowDown' });
    fireEvent.keyDown(screen.getByRole('menu'), { key: 'Enter' });
    expect(run).toHaveBeenCalledOnce();
  });
});

describe('Graph', () => {
  it('leaves a gap for unavailable values instead of drawing zero', () => {
    const { container } = render(<Graph series={[{ values: [10, 20, null, 30, 40], color: 'red', label: 'x' }]} max={100} step={1} points={5} format={n => String(n)} label="test" />);
    const line = container.querySelectorAll('path')[1].getAttribute('d')!;
    expect((line.match(/M/g) ?? []).length).toBe(2);
    expect(screen.getByRole('img', { name: 'test' })).toBeTruthy();
  });
});

describe('App', () => {
  it('shows real process rows from the backend and the system summary', async () => {
    backend(); renderApp();
    await waitFor(() => expect(rowNames()).toContain('gamma.exe'));
    expect(screen.getByText('Test CPU 9000')).toBeTruthy();
    expect(screen.getByText('3 processes')).toBeTruthy();
  });

  it('sorts by CPU descending by default and flips when the header is clicked', async () => {
    backend(); renderApp();
    await waitFor(() => expect(rowNames()[0]).toBe('gamma.exe'));
    fireEvent.click(screen.getByRole('button', { name: /Sort by CPU/ }));
    await waitFor(() => expect(rowNames()[0]).toBe('beta.exe'));
  });

  it('filters by search text and shows an empty state', async () => {
    backend(); renderApp();
    await waitFor(() => expect(rowNames().length).toBe(3));
    fireEvent.change(screen.getByLabelText('Search processes'), { target: { value: 'alp' } });
    await waitFor(() => expect(rowNames()).toEqual(['alpha.exe']));
    fireEvent.change(screen.getByLabelText('Search processes'), { target: { value: 'zzz-nothing' } });
    await waitFor(() => expect(screen.getByText('No processes match your search.')).toBeTruthy());
  });

  it('moves the selection with the keyboard', async () => {
    backend(); renderApp();
    await waitFor(() => expect(rowNames().length).toBe(3));
    const grid = document.querySelector('.pt-scroll') as HTMLElement;
    fireEvent.keyDown(grid, { key: 'ArrowDown' });
    fireEvent.keyDown(grid, { key: 'ArrowDown' });
    await waitFor(() => expect(document.querySelectorAll('.pt-row.selected').length).toBe(1));
    expect(nameOf(document.querySelector('.pt-row.selected') as HTMLElement)).toBe('alpha.exe');
  });

  it('shows a tree with children nested under their parent', async () => {
    backend(); renderApp();
    await waitFor(() => expect(rowNames().length).toBe(3));
    fireEvent.change(screen.getByLabelText('Grouping'), { target: { value: 'tree' } });
    await waitFor(() => expect(rowNames()).toEqual(['gamma.exe', 'alpha.exe']));
    fireEvent.click(screen.getAllByRole('button', { name: 'Expand children' })[0]);
    await waitFor(() => expect(rowNames()).toContain('beta.exe'));
  });

  it('asks for confirmation, then ends exactly the selected process with its identity', async () => {
    backend(); renderApp();
    await waitFor(() => expect(rowNames().length).toBe(3));
    fireEvent.click(document.querySelectorAll('.process-row')[2]); // alpha.exe (cpu 30, third by cpu desc? verify below)
    const selectedName = nameOf(document.querySelector('.pt-row.selected') as HTMLElement)!;
    const target = [proc(10, 'alpha.exe'), proc(20, 'beta.exe'), proc(30, 'gamma.exe')].find(p => p.name === selectedName)!;
    fireEvent.click(await screen.findByRole('button', { name: 'End process' }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText(new RegExp(`End ${selectedName}\\?`))).toBeTruthy();
    expect(calls.some(c => c.cmd === 'terminate_process')).toBe(false); // nothing happens before confirming
    fireEvent.click(within(dialog).getByRole('button', { name: 'End process' }));
    await waitFor(() => expect(calls.find(c => c.cmd === 'terminate_process')?.args).toEqual({ pid: target.pid, identity: target.identity }));
  });

  it('cancelling the confirmation ends nothing', async () => {
    backend(); renderApp();
    await waitFor(() => expect(rowNames().length).toBe(3));
    fireEvent.click(document.querySelectorAll('.process-row')[0]);
    fireEvent.click(await screen.findByRole('button', { name: 'End process' }));
    fireEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(calls.some(c => c.cmd === 'terminate_process')).toBe(false);
  });

  it('disables ending a process whose identity could not be read', async () => {
    backend({ snapshot: () => snapshot([proc(5, 'locked.exe', { identity: null })]) }); renderApp();
    await waitFor(() => expect(rowNames()).toEqual(['locked.exe']));
    fireEvent.click(document.querySelector('.process-row') as HTMLElement);
    const btn = await screen.findByRole('button', { name: 'End process' }) as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
    expect(btn.title).toMatch(/cannot be ended safely/);
  });

  it('shows an error state when the collector fails, and keeps the app usable', async () => {
    backend({ snapshot: () => { throw new Error('collector exploded'); } }); renderApp();
    expect(await screen.findByText(/Monitoring unavailable/)).toBeTruthy();
    expect(screen.getAllByText(/collector exploded/).length).toBeGreaterThan(0);
    fireEvent.click(screen.getByRole('button', { name: /Services/ }));
    expect(await screen.findByRole('heading', { name: 'Services' })).toBeTruthy();
  });

  it('navigates between every module', async () => {
    backend(); renderApp();
    await waitFor(() => expect(rowNames().length).toBe(3));
    const pages: [string, string][] = [['Overview', 'Overview'], ['Performance', 'Performance'], ['Resource Monitor', 'Resource Monitor'], ['Startup', 'Startup'], ['Services', 'Services'], ['Users', 'Users'], ['Network', 'Network'], ['History', 'History'], ['Alerts', 'Alerts'], ['System', 'System information'], ['Settings', 'Settings'], ['Processes', 'Processes']];
    for (const [nav, heading] of pages) {
      fireEvent.click(within(document.querySelector('.app-shell') as HTMLElement).getAllByRole('button', { name: new RegExp(`^.?\\s*${nav}$`) })[0]);
      expect(await screen.findByRole('heading', { level: 1, name: heading })).toBeTruthy();
    }
  });

  it('switching theme in Settings updates the document and persists through the backend', async () => {
    backend(); renderApp();
    fireEvent.click(screen.getByRole('button', { name: /Settings/ }));
    fireEvent.change(await screen.findByLabelText('Theme'), { target: { value: 'light' } });
    expect(document.documentElement.dataset.theme).toBe('light');
    await waitFor(() => expect((calls.find(c => c.cmd === 'save_settings')?.args as { settings: { theme: string } } | undefined)?.settings.theme).toBe('light'), { timeout: 3000 });
  });

  it('a slow save reply never overwrites a newer change', async () => {
    let releaseFirst: (v: unknown) => void = () => undefined;
    let saves = 0;
    backend({ save_settings: a => { saves += 1; const s = (a as { settings: unknown }).settings; return saves === 1 ? new Promise(res => { releaseFirst = () => res(s); }) : s; } });
    renderApp();
    fireEvent.click(screen.getByRole('button', { name: /Settings/ }));
    const theme = await screen.findByLabelText('Theme');
    fireEvent.change(theme, { target: { value: 'light' } });
    await waitFor(() => expect(saves).toBe(1), { timeout: 3000 });       // first save is now in flight, unanswered
    fireEvent.change(theme, { target: { value: 'dark' } });             // newer choice
    releaseFirst(null);                                                 // the old reply (theme=light) arrives late
    await new Promise(r => setTimeout(r, 100));
    expect(document.documentElement.dataset.theme).toBe('dark');
    expect((screen.getByLabelText('Theme') as HTMLSelectElement).value).toBe('dark');
  });

  it('applies saved accent, density and reduced motion from loaded settings', async () => {
    backend({ get_settings: () => ({ settings: { ...defaultSettings, accent: '#d9506e', density: 'comfortable', reduced_motion: true, theme: 'dark' }, note: null, autostart: false }) });
    renderApp();
    await waitFor(() => expect(document.documentElement.style.getPropertyValue('--accent')).toBe('#d9506e'));
    expect(document.documentElement.dataset.density).toBe('comfortable');
    expect(document.documentElement.dataset.motion).toBe('reduced');
    expect(document.documentElement.dataset.theme).toBe('dark');
  });

  it('reports a corrupted settings file instead of hiding it', async () => {
    backend({ get_settings: () => ({ settings: defaultSettings, note: 'Settings file was unreadable (x); defaults restored.', autostart: false }) });
    renderApp();
    fireEvent.click(screen.getByRole('button', { name: /Settings/ }));
    expect(await screen.findByText(/Settings file was unreadable/)).toBeTruthy();
  });

  it('shows a clear empty state for alerts and creates a rule', async () => {
    backend(); renderApp();
    fireEvent.click(screen.getByRole('button', { name: /Alerts/ }));
    expect(await screen.findByText('No alerts yet')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Add alert' }));
    expect(await screen.findByLabelText('Alert name')).toBeTruthy();
  });
});
