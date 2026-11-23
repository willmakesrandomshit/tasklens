import { describe, expect, it } from 'vitest';
import { bytes, selectProcesses, type ProcessInfo } from './model';

const process = (pid: number, name: string, cpu_usage: number): ProcessInfo => ({pid, name, cpu_usage, parent_pid: null, memory: 100, status: 'Running', start_time: 1, identity: String(pid), exe: `C:\\${name}.exe`, command: ''});
describe('process presentation', () => {
  it('formats memory values without inventing missing numbers', () => { expect(bytes(1024 ** 3)).toBe('1.0 GB'); expect(bytes(NaN)).toBe('Unavailable'); });
  it('searches executable paths and sorts by live CPU', () => {
    const items = [process(1, 'Alpha', 1), process(2, 'Beta', 7), process(3, 'Alpha helper', 4)];
    expect(selectProcesses(items, 'alpha', 'cpu_usage', false).map(p => p.pid)).toEqual([3, 1]);
    expect(selectProcesses(items, '2', 'name', true).map(p => p.pid)).toEqual([2]);
  });
});
