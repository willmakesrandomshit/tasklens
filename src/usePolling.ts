import { invoke } from '@tauri-apps/api/core';
import { useCallback, useEffect, useState } from 'react';

/** Calls a backend command on an interval while `active`, keeping the last good data on errors. */
export function usePolling<T>(command: string, intervalMs: number, active: boolean) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (!active) return;
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const run = async () => {
      try {
        const next = await invoke<T>(command);
        if (alive) { setData(next); setError(null); }
      } catch (e) { if (alive) setError(String(e)); }
      if (alive) timer = setTimeout(run, intervalMs);
    };
    void run();
    return () => { alive = false; clearTimeout(timer); };
  }, [command, intervalMs, active, tick]);
  const refresh = useCallback(() => setTick(t => t + 1), []);
  return { data, error, refresh };
}

export async function revealInExplorer(path: string): Promise<string | null> {
  try { await invoke('reveal_in_explorer', { path }); return null; } catch (e) { return String(e); }
}

export type SortDir = 'asc' | 'desc';
export function compareValues(a: string | number | null | undefined, b: string | number | null | undefined): number {
  if (a == null && b == null) return 0;
  if (a == null) return 1;
  if (b == null) return -1;
  return typeof a === 'string' && typeof b === 'string' ? a.localeCompare(b, undefined, { sensitivity: 'base' }) : Number(a) - Number(b);
}
