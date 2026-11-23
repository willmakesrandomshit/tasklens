import { describe, expect, it } from 'vitest';
import { compareValues } from './usePolling';

describe('compareValues', () => {
  it('compares strings case-insensitively and numbers numerically', () => {
    expect(compareValues('alpha', 'Beta')).toBeLessThan(0);
    expect(compareValues(10, 9)).toBeGreaterThan(0);
  });
  it('sorts missing values last regardless of type', () => {
    expect(compareValues(null, 5)).toBeGreaterThan(0);
    expect(compareValues('x', undefined)).toBeLessThan(0);
    expect(compareValues(null, null)).toBe(0);
  });
});
