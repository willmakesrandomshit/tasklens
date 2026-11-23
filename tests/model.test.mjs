import assert from 'node:assert/strict';
import { test } from 'node:test';
import { bytes, selectProcesses } from '../src/model.ts';

const processes = [
  { pid: 11, name: 'Browser', exe: 'C:\\Apps\\browser.exe', command: '--private', cpu_usage: 5, memory: 1024 },
  { pid: 2, name: 'Editor', exe: null, command: '', cpu_usage: 15, memory: 2048 },
];

test('searches names, paths, command lines, and PIDs', () => {
  for (const query of ['browser', 'APPS', '--private', '11']) {
    assert.deepEqual(selectProcesses(processes, query, 'pid', true).map(p => p.pid), [11]);
  }
});

test('sorts a copy and formats byte values', () => {
  assert.deepEqual(selectProcesses(processes, '', 'cpu_usage', false).map(p => p.pid), [2, 11]);
  assert.deepEqual(processes.map(p => p.pid), [11, 2]);
  assert.equal(bytes(1024), '1 KB');
  assert.equal(bytes(-1), 'Unavailable');
});
