import { describe, expect, it } from 'vitest';
import { buildTreeRows, procKey, rate, type ProcessInfo } from './model';

const p = (pid: number, parent: number | null, start: number, name = `p${pid}`): ProcessInfo => ({
  pid, parent_pid: parent, name, cpu_usage: 0, memory: 0, status: 'Run', start_time: start,
  identity: String(start), exe: null, command: '',
});

describe('buildTreeRows', () => {
  const list = [p(1, null, 10), p(2, 1, 20), p(3, 2, 30), p(4, 1, 25)];
  it('shows only roots when nothing is expanded', () => {
    const rows = buildTreeRows(list, new Set(), 'pid', true);
    expect(rows.map(r => r.process.pid)).toEqual([1]);
    expect(rows[0].hasChildren).toBe(true);
  });
  it('expands children depth-first with depth', () => {
    const open = new Set([procKey(list[0]), procKey(list[1])]);
    const rows = buildTreeRows(list, open, 'pid', true);
    expect(rows.map(r => [r.process.pid, r.depth])).toEqual([[1, 0], [2, 1], [3, 2], [4, 1]]);
  });
  it('treats a process whose parent PID was reused (parent started later) as a root', () => {
    const reused = [p(10, 99, 100), p(99, null, 500)];
    const rows = buildTreeRows(reused, new Set(), 'pid', true);
    expect(rows.map(r => r.process.pid)).toEqual([10, 99]);
  });
  it('survives parent cycles without looping', () => {
    const cyc = [p(1, 2, 10), p(2, 1, 10)];
    expect(() => buildTreeRows(cyc, new Set([procKey(cyc[0]), procKey(cyc[1])]), 'pid', true)).not.toThrow();
  });
});

describe('rate', () => {
  it('never turns an unknown rate into zero', () => {
    expect(rate(null)).toBe('—');
    expect(rate(2048)).toBe('2 KB/s');
  });
});
