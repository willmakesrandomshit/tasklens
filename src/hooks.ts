import { useCallback, useEffect, useRef, useState } from 'react';
import { call, type FileInfo } from './api';
import type { Snapshot } from './model';

export interface MetricHistory {
  cpu: number[]; memory: number[]; gpu: (number | null)[]; diskActive: (number | null)[];
  diskRead: number[]; diskWrite: number[]; netIn: number[]; netOut: number[];
  perCore: number[][];
}
export const MAX_POINTS = 3600;

export function emptyMetricHistory(): MetricHistory {
  return { cpu: [], memory: [], gpu: [], diskActive: [], diskRead: [], diskWrite: [], netIn: [], netOut: [], perCore: [] };
}

const sum = (xs: (number | null)[]) => xs.reduce<number>((a, v) => a + (v ?? 0), 0);
const push = <T,>(arr: T[], v: T) => { arr.push(v); if (arr.length > MAX_POINTS) arr.splice(0, arr.length - MAX_POINTS); };

/** Appends one snapshot to the rolling history (mutates; the caller bumps a version to re-render). */
export function recordSnapshot(h: MetricHistory, s: Snapshot) {
  push(h.cpu, s.cpu_usage);
  push(h.memory, s.total_memory ? (s.used_memory / s.total_memory) * 100 : 0);
  push(h.gpu, s.gpu.supported ? Math.max(0, ...s.gpu.live.map(g => g.percent)) : null);
  const disks = s.perf.physical_disks.filter(d => d.active_percent !== null);
  push(h.diskActive, disks.length ? Math.max(...disks.map(d => d.active_percent as number)) : null);
  const phys = s.perf.physical_disks.length > 0;
  push(h.diskRead, phys ? sum(s.perf.physical_disks.map(d => d.read_per_s)) : sum(s.disks.map(d => d.read_per_s)));
  push(h.diskWrite, phys ? sum(s.perf.physical_disks.map(d => d.write_per_s)) : sum(s.disks.map(d => d.write_per_s)));
  // Only adapters that own a routable address count; filter drivers repeat the physical adapter's traffic.
  const routable = s.networks.filter(n => n.addresses.some(a => !/^(fe80|169\.254|127\.|::1)/.test(a)));
  const nets = routable.length ? routable : s.networks.slice(0, 1);
  push(h.netIn, sum(nets.map(n => n.received_per_s)));
  push(h.netOut, sum(nets.map(n => n.transmitted_per_s)));
  s.cpu_cores.forEach((v, i) => { (h.perCore[i] ??= []); push(h.perCore[i], v); });
}

/** Polls the engine's cached snapshot. Pauses when `paused`; tells the backend when the UI is hidden. */
export function useSnapshot(intervalMs: number, paused: boolean) {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const history = useRef<MetricHistory>(emptyMetricHistory());
  const [version, setVersion] = useState(0);
  const pausedRef = useRef(paused);
  pausedRef.current = paused;

  useEffect(() => {
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const poll = async () => {
      try {
        const s = await call<Snapshot>('snapshot');
        if (!alive) return;
        setError(null);
        if (!pausedRef.current) { setSnapshot(s); recordSnapshot(history.current, s); setVersion(v => v + 1); }
      } catch (e) { if (alive) setError(String((e as Error).message ?? e)); }
      if (alive) timer = setTimeout(poll, intervalMs);
    };
    void poll();
    return () => { alive = false; clearTimeout(timer); };
  }, [intervalMs]);

  useEffect(() => {
    const tell = () => { void call('set_ui_active', { active: document.visibilityState === 'visible' }).catch(() => undefined); };
    document.addEventListener('visibilitychange', tell);
    tell();
    return () => document.removeEventListener('visibilitychange', tell);
  }, []);

  return { snapshot, error, history: history.current, version };
}

const fileCache = new Map<string, FileInfo | null>();
const inflight = new Set<string>();

/** Lazily fetches publisher/description/signature for the executables currently visible. Cached per path. */
export function useFileInfo(paths: string[], enabled: boolean): Map<string, FileInfo> {
  const [, bump] = useState(0);
  const key = paths.join('|');
  useEffect(() => {
    if (!enabled) return;
    let changed = false;
    const pending = paths.filter(p => p && !fileCache.has(p.toLowerCase()) && !inflight.has(p.toLowerCase()));
    if (!pending.length) return;
    let alive = true;
    pending.forEach(p => inflight.add(p.toLowerCase()));
    Promise.all(pending.map(p => call<FileInfo>('process_file_info', { path: p }).then(r => fileCache.set(p.toLowerCase(), r), () => fileCache.set(p.toLowerCase(), null))
      .finally(() => { inflight.delete(p.toLowerCase()); changed = true; })))
      .then(() => { if (alive && changed) bump(v => v + 1); });
    return () => { alive = false; };
  }, [key, enabled]);
  const out = new Map<string, FileInfo>();
  for (const [k, v] of fileCache) if (v) out.set(k, v);
  return out;
}

/** Small helper: run an async action with busy/error state. */
export function useAction() {
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const run = useCallback(async (fn: () => Promise<string | void>) => {
    setBusy(true); setMessage(null);
    try { const text = await fn(); if (text) setMessage({ ok: true, text }); }
    catch (e) { setMessage({ ok: false, text: String((e as Error).message ?? e) }); }
    finally { setBusy(false); }
  }, []);
  return { busy, message, run, clear: () => setMessage(null) };
}
