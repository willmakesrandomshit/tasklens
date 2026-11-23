import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { call, type Settings, type SettingsReply } from './api';

export const defaultSettings: Settings = {
  theme: 'system', accent: '#4f8cff', density: 'compact', font_scale: 1, reduced_motion: false, refresh_ms: 2000,
  confirm_destructive: true,
  history: { enabled: false, interval_s: 5, retention_days: 7, max_mb: 100 },
  app: { start_minimized: false, always_on_top: false, tray_enabled: false, minimize_to_tray: false, compact: false, notify_in_app: true },
  alerts: [], ui: null,
};

interface Ctx {
  settings: Settings;
  loaded: boolean;
  note: string | null;
  autostart: boolean;
  /** Applies a change immediately in the UI and saves it (debounced) through the backend validator. */
  update: (change: (s: Settings) => Settings) => void;
  setAutostart: (on: boolean) => Promise<void>;
  saveError: string | null;
}

const SettingsContext = createContext<Ctx | null>(null);

/** Applies appearance settings to the document: theme, accent, density, font size, motion. */
export function applyAppearance(s: Settings, root: HTMLElement = document.documentElement) {
  root.dataset.theme = s.theme;
  root.dataset.density = s.density;
  root.dataset.motion = s.reduced_motion ? 'reduced' : 'full';
  root.style.setProperty('--accent', s.accent);
  root.style.fontSize = `${13 * s.font_scale}px`;
}

export function SettingsProvider({ children }: { children: ReactNode }) {
  const [settings, setSettings] = useState<Settings>(defaultSettings);
  const [loaded, setLoaded] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [autostart, setAutostartState] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const latest = useRef(settings);

  useEffect(() => {
    let alive = true;
    call<SettingsReply>('get_settings')
      .then(r => { if (alive) { latest.current = r.settings; setSettings(r.settings); setNote(r.note); setAutostartState(r.autostart); } })
      .catch(() => { /* not running inside the desktop shell: keep defaults */ })
      .finally(() => { if (alive) setLoaded(true); });
    return () => { alive = false; };
  }, []);

  useEffect(() => { applyAppearance(settings); }, [settings]);

  const update = useCallback((change: (s: Settings) => Settings) => {
    const next = change(latest.current);
    latest.current = next;
    setSettings(next);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      call<Settings>('save_settings', { settings: next })
        .then(saved => {
          setSaveError(null);
          // A newer change may have been made while this save was in flight; never let the older, sanitised
          // reply overwrite it (that would silently undo the user's latest choice).
          if (latest.current === next) { latest.current = saved; setSettings(saved); }
        })
        .catch(e => setSaveError(String(e.message ?? e)));
    }, 300);
  }, []);

  const setAutostart = useCallback(async (on: boolean) => {
    const actual = await call<boolean>('set_autostart', { enabled: on });
    setAutostartState(actual);
  }, []);

  const value = useMemo(() => ({ settings, loaded, note, autostart, update, setAutostart, saveError }), [settings, loaded, note, autostart, update, setAutostart, saveError]);
  return <SettingsContext.Provider value={value}>{children}</SettingsContext.Provider>;
}

export function useSettings(): Ctx {
  const ctx = useContext(SettingsContext);
  if (!ctx) throw new Error('useSettings must be used inside SettingsProvider');
  return ctx;
}
