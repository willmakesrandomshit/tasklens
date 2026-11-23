import { describe, expect, it } from 'vitest';
import { buildGroups, COLUMNS, defaultLayout, matchesQuery, normalizeLayout, sortProcesses, visibleColumns, type ColumnContext } from './columns';
import { bitRate, duration, redactCommand } from './model';
import { proc } from './testFixtures';

const ctx: ColumnContext = { now: 5000, files: new Map(), cores: 4 };

describe('column layout', () => {
  it('repairs stored layouts: drops unknown columns, keeps Name first and visible, clamps widths', () => {
    const l = normalizeLayout({ order: ['pid', 'bogus', 'cpu'], visible: ['pid', 'bogus'], widths: { pid: 9999, cpu: 5, bogus: 100 } });
    expect(l.order[0]).toBe('name');
    expect(l.order).not.toContain('bogus');
    expect(l.order.length).toBe(COLUMNS.length);
    expect(l.visible).toEqual(['name', 'pid']);
    expect(l.widths).toEqual({ pid: 800, cpu: 40 });
  });
  it('falls back to defaults and respects visibility order', () => {
    expect(normalizeLayout(undefined)).toEqual(defaultLayout());
    const l = normalizeLayout({ order: ['memory', 'cpu'], visible: ['cpu', 'memory'], widths: {} });
    expect(visibleColumns(l).map(c => c.id)).toEqual(['name', 'memory', 'cpu']);
  });
});

describe('sorting and search', () => {
  const list = [proc(1, 'b.exe', { cpu_usage: 10, memory: 5 }), proc(2, 'a.exe', { cpu_usage: 10, memory: 9 }), proc(3, 'c.exe', { cpu_usage: 50, gpu_percent: null })];
  it('sorts by several columns with PID as the final tiebreak', () => {
    const out = sortProcesses(list, [{ id: 'cpu', desc: true }, { id: 'memory', desc: true }], ctx);
    expect(out.map(p => p.pid)).toEqual([3, 2, 1]);
  });
  it('keeps missing values last in both directions', () => {
    const asc = sortProcesses(list, [{ id: 'gpu', desc: false }], ctx).map(p => p.pid);
    const desc = sortProcesses(list, [{ id: 'gpu', desc: true }], ctx).map(p => p.pid);
    expect(asc[asc.length - 1]).toBe(3);
    expect(desc[desc.length - 1]).toBe(3);
  });
  it('matches name, pid, path, command, user and known publisher', () => {
    const p = proc(42, 'tool.exe', { user: 'PC\\ada' });
    const withFile: ColumnContext = { ...ctx, files: new Map([['c:\\apps\\tool.exe', { description: 'Hammer', company: 'Acme Corp', product: null, version: null, signature: 'Valid' }]]) };
    for (const q of ['tool', '42', 'apps', '--flag', 'ada', 'acme', 'hammer']) expect(matchesQuery(p, q, withFile), q).toBe(true);
    expect(matchesQuery(p, 'nothing-here', withFile)).toBe(false);
  });
});

describe('grouping', () => {
  it('groups by executable, orders groups by CPU and expands on demand', () => {
    const list = [proc(1, 'chrome.exe', { cpu_usage: 5, exe: 'C:\\c\\chrome.exe' }), proc(2, 'chrome.exe', { cpu_usage: 6, exe: 'C:\\c\\chrome.exe' }), proc(3, 'idle.exe', { cpu_usage: 1 })];
    const collapsed = buildGroups(list, 'app', new Set());
    expect(collapsed.map(r => r.kind)).toEqual(['group', 'group']);
    expect(collapsed[0]).toMatchObject({ label: 'chrome.exe', count: 2, cpu: 11 });
    const open = buildGroups(list, 'app', new Set(['group:c:\\c\\chrome.exe']));
    expect(open.map(r => r.kind)).toEqual(['group', 'process', 'process', 'group']);
  });
});

describe('formatting and redaction', () => {
  it('hides secrets in command lines but keeps ordinary arguments', () => {
    expect(redactCommand('app.exe --password hunter2 --verbose')).toBe('app.exe --password *** --verbose');
    expect(redactCommand('app.exe --token=abc123 --name bob')).toBe('app.exe --token=*** --name bob');
    expect(redactCommand('curl https://user:secret@host/path')).toBe('curl https://user:***@host/path');
    expect(redactCommand('node server.js --port 80')).toBe('node server.js --port 80');
    expect(redactCommand('x.exe API_KEY="a b c" y')).toBe('x.exe API_KEY=*** y');
  });
  it('formats durations and link speeds', () => {
    expect(duration(59)).toBe('59s');
    expect(duration(3700)).toBe('1h 1m');
    expect(duration(90000)).toBe('1d 1h');
    expect(duration(-1)).toBe('—');
    expect(bitRate(866e6)).toBe('866 Mbps');
    expect(bitRate(2.5e9)).toBe('2.5 Gbps');
  });
});
