import assert from 'node:assert/strict';
import { test } from 'node:test';
import { visibleRange } from '../src/viewport.ts';

test('keeps the visible window bounded when a process list shrinks while scrolled', () => {
  const range = visibleRange(12, 20_000, 380, 38);
  assert.deepEqual(range, { first: 2, last: 12 });
});

test('handles empty lists and normal scrolling', () => {
  assert.deepEqual(visibleRange(0, 500, 380, 38), { first: 0, last: 0 });
  assert.deepEqual(visibleRange(1_000, 380, 380, 38), { first: 5, last: 25 });
});
