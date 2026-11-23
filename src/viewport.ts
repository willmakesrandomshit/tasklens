/** Calculate a bounded window for a fixed-height virtualized list. */
export function visibleRange(count: number, scrollTop: number, height: number, rowHeight: number, overscan = 5): { first: number; last: number } {
  if (count <= 0 || rowHeight <= 0) return { first: 0, last: 0 };
  const visibleCount = Math.max(1, Math.ceil(Math.max(0, height) / rowHeight));
  const maxFirst = Math.max(0, count - visibleCount);
  const first = Math.min(maxFirst, Math.max(0, Math.floor(Math.max(0, scrollTop) / rowHeight) - overscan));
  return { first, last: Math.min(count, first + visibleCount + overscan * 2) };
}
