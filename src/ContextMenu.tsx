import { useEffect, useRef, useState } from 'react';

export interface MenuItem {
  label: string;
  onSelect?: () => void;
  /** Shown as a tooltip and used to explain why the item is disabled. */
  title?: string;
  disabled?: boolean;
  danger?: boolean;
  separator?: boolean;
  submenu?: MenuItem[];
}

interface Props { x: number; y: number; items: MenuItem[]; onClose: () => void }

/** Keyboard-accessible context menu (arrows, Enter, Escape) that stays inside the viewport. */
export function ContextMenu({ x, y, items, onClose }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ x, y });
  const [open, setOpen] = useState<number | null>(null);
  const [focus, setFocus] = useState(0);
  const enabled = items.map((it, i) => (!it.separator && !it.disabled ? i : -1)).filter(i => i >= 0);

  useEffect(() => {
    const el = ref.current;
    if (el) setPos({ x: Math.min(x, window.innerWidth - el.offsetWidth - 8), y: Math.min(y, window.innerHeight - el.offsetHeight - 8) });
    el?.focus();
  }, [x, y]);
  useEffect(() => {
    const away = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) onClose(); };
    window.addEventListener('mousedown', away); window.addEventListener('blur', onClose);
    return () => { window.removeEventListener('mousedown', away); window.removeEventListener('blur', onClose); };
  }, [onClose]);

  const choose = (it: MenuItem, i: number) => {
    if (it.disabled) return;
    if (it.submenu) { setOpen(open === i ? null : i); return; }
    onClose(); it.onSelect?.();
  };
  const onKey = (e: React.KeyboardEvent) => {
    const at = enabled.indexOf(focus);
    if (e.key === 'Escape') { e.preventDefault(); onClose(); }
    else if (e.key === 'ArrowDown') { e.preventDefault(); setFocus(enabled[(at + 1) % enabled.length]); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setFocus(enabled[(at - 1 + enabled.length) % enabled.length]); }
    else if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); choose(items[focus], focus); }
    else if (e.key === 'ArrowRight' && items[focus]?.submenu) { e.preventDefault(); setOpen(focus); }
    else if (e.key === 'ArrowLeft') { e.preventDefault(); setOpen(null); }
  };

  return <div className="ctx" ref={ref} role="menu" tabIndex={-1} style={{ left: pos.x, top: pos.y }} onKeyDown={onKey} onContextMenu={e => e.preventDefault()}>
    {items.map((it, i) => it.separator ? <div key={i} className="ctx-sep" role="separator" /> :
      <div key={i} className="ctx-wrap">
        <button role="menuitem" className={`ctx-item${it.danger ? ' danger' : ''}${i === focus ? ' focus' : ''}`} disabled={it.disabled} title={it.title} aria-haspopup={it.submenu ? 'menu' : undefined} aria-disabled={it.disabled}
          onMouseEnter={() => { setFocus(i); if (it.submenu) setOpen(i); else setOpen(null); }} onClick={() => choose(it, i)}>
          <span>{it.label}</span>{it.submenu && <span aria-hidden="true">▸</span>}
        </button>
        {it.submenu && open === i && <div className="ctx sub" role="menu">{it.submenu.map((s, j) => <button key={j} role="menuitem" className="ctx-item" disabled={s.disabled} title={s.title} onClick={() => { onClose(); s.onSelect?.(); }}>{s.label}</button>)}</div>}
      </div>)}
  </div>;
}
