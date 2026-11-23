import { describe, expect, it } from 'vitest';
import { visibleRange } from './viewport';

describe('visibleRange', () => {
  it('keeps the visible window bounded when a process list shrinks while scrolled', () => {
    expect(visibleRange(12, 20_000, 380, 38)).toEqual({ first: 2, last: 12 });
  });
  it('handles empty lists and normal scrolling', () => {
    expect(visibleRange(0, 500, 380, 38)).toEqual({ first: 0, last: 0 });
    expect(visibleRange(1_000, 380, 380, 38)).toEqual({ first: 5, last: 25 });
  });
});
