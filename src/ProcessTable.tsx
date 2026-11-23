import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import type { ColumnContext, ColumnDef, DisplayRow, SortSpec } from './columns';
import { bytes, percent } from './model';
import { visibleRange } from './viewport';

interface Props {
  rows: DisplayRow[];
  columns: ColumnDef[];
  widths: Record<string, number>;
  rowHeight: number;
  ctx: ColumnContext;
  sorts: SortSpec[];
  selectedKey: string | null;
  pinned: ReadonlySet<string>;
  query: string;
  treeMode: boolean;
  maxCpu: number;
  maxMemory: number;
  onSelect: (key: string | null) => void;
  onContext: (key: string, x: number, y: number) => void;
  onToggle: (key: string) => void;
  onSort: (id: string, additive: boolean) => void;
  onResize: (id: string, width: number) => void;
  onReorder: (from: string, to: string) => void;
  onActivate: (key: string) => void;
  emptyText: string;
}

export const widthOf = (c: ColumnDef, widths: Record<string, number>) => widths[c.id] ?? c.width;

export function Highlight({ text, needle }: { text: string; needle: string }): ReactNode {
  const n = needle.trim().toLowerCase();
  if (!n) return text;
  const i = text.toLowerCase().indexOf(n);
  if (i < 0) return text;
  return <>{text.slice(0, i)}<mark>{text.slice(i, i + n.length)}</mark>{text.slice(i + n.length)}</>;
}

export function ProcessTable(p: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [height, setHeight] = useState(480);
  const drag = useRef<{ id: string; startX: number; startW: number } | null>(null);
  const [dragOver, setDragOver] = useState<string | null>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setHeight(el.clientHeight));
    ro.observe(el); setHeight(el.clientHeight);
    return () => ro.disconnect();
  }, []);

  const widths = p.columns.map(c => widthOf(c, p.widths));
  const total = widths.reduce((a, b) => a + b, 0);
  const template = widths.map(w => `${w}px`).join(' ');
  const { first, last } = visibleRange(p.rows.length, scrollTop, Math.max(height - p.rowHeight, p.rowHeight), p.rowHeight);
  const index = p.rows.findIndex(r => r.key === p.selectedKey);

  const moveTo = (next: number) => {
    const i = Math.max(0, Math.min(p.rows.length - 1, next));
    const row = p.rows[i];
    if (!row) return;
    p.onSelect(row.key);
    const el = ref.current;
    if (!el) return;
    const top = i * p.rowHeight, view = el.clientHeight - p.rowHeight;
    if (top < el.scrollTop) el.scrollTop = top;
    else if (top + p.rowHeight > el.scrollTop + view) el.scrollTop = top + p.rowHeight - view;
  };

  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    const page = Math.max(1, Math.floor(height / p.rowHeight) - 1);
    const row = index >= 0 ? p.rows[index] : undefined;
    switch (e.key) {
      case 'ArrowDown': e.preventDefault(); moveTo(index < 0 ? 0 : index + 1); break;
      case 'ArrowUp': e.preventDefault(); moveTo(index < 0 ? 0 : index - 1); break;
      case 'PageDown': e.preventDefault(); moveTo(index + page); break;
      case 'PageUp': e.preventDefault(); moveTo(index - page); break;
      case 'Home': e.preventDefault(); moveTo(0); break;
      case 'End': e.preventDefault(); moveTo(p.rows.length - 1); break;
      case 'ArrowRight': if (row && ((row.kind === 'process' && row.hasChildren && !row.expanded) || (row.kind === 'group' && !row.expanded))) { e.preventDefault(); p.onToggle(row.key); } break;
      case 'ArrowLeft': if (row && ((row.kind === 'process' && row.hasChildren && row.expanded) || (row.kind === 'group' && row.expanded))) { e.preventDefault(); p.onToggle(row.key); } break;
      case 'Enter': if (row) { e.preventDefault(); if (row.kind === 'group') p.onToggle(row.key); else p.onActivate(row.key); } break;
      case 'ContextMenu': case 'F10': if (row && (e.key === 'ContextMenu' || e.shiftKey)) { e.preventDefault(); const r = ref.current!.getBoundingClientRect(); p.onContext(row.key, r.left + 60, r.top + 40 + (index * p.rowHeight - ref.current!.scrollTop)); } break;
      default: break;
    }
  };

  const startResize = (e: React.MouseEvent, c: ColumnDef) => {
    e.preventDefault(); e.stopPropagation();
    drag.current = { id: c.id, startX: e.clientX, startW: widthOf(c, p.widths) };
    const move = (ev: MouseEvent) => { const d = drag.current; if (d) p.onResize(d.id, Math.max(40, d.startW + ev.clientX - d.startX)); };
    const up = () => { drag.current = null; window.removeEventListener('mousemove', move); window.removeEventListener('mouseup', up); };
    window.addEventListener('mousemove', move); window.addEventListener('mouseup', up);
  };

  const heat = (c: ColumnDef, proc: Parameters<NonNullable<ColumnDef['heat']>>[0]): string | undefined => {
    if (!c.heat) return undefined;
    const max = c.id === 'cpu' ? p.maxCpu : c.id === 'memory' ? p.maxMemory : 100;
    const h = Math.min(1, Math.max(0, c.heat(proc, p.ctx, max)));
    return h > 0.02 ? `color-mix(in srgb, var(--accent) ${Math.round(h * 38)}%, transparent)` : undefined;
  };

  return <div className="pt" role="grid" aria-label="Processes" aria-rowcount={p.rows.length + 1}>
    <div className="pt-scroll" ref={ref} tabIndex={0} onKeyDown={onKey} onScroll={e => setScrollTop(e.currentTarget.scrollTop)} aria-activedescendant={p.selectedKey ? `row-${p.selectedKey}` : undefined}>
      <div className="pt-head" role="row" style={{ gridTemplateColumns: template, width: Math.max(total, 0), height: p.rowHeight }}>
        {p.columns.map(c => {
          const s = p.sorts.findIndex(x => x.id === c.id);
          return <div key={c.id} role="columnheader" aria-sort={s === 0 ? (p.sorts[0].desc ? 'descending' : 'ascending') : 'none'} className={`pt-th${c.numeric ? ' num' : ''}${dragOver === c.id ? ' drop' : ''}`}
            draggable={c.id !== 'name'} title={c.hint}
            onDragStart={e => e.dataTransfer.setData('text/plain', c.id)} onDragOver={e => { if (c.id !== 'name') { e.preventDefault(); setDragOver(c.id); } }}
            onDragLeave={() => setDragOver(null)} onDrop={e => { e.preventDefault(); setDragOver(null); const from = e.dataTransfer.getData('text/plain'); if (from && from !== c.id) p.onReorder(from, c.id); }}>
            <button className="pt-sort" onClick={e => p.onSort(c.id, e.shiftKey)} aria-label={`Sort by ${c.label}. Shift-click adds a secondary sort.`}>
              {c.label}{s >= 0 && <span className="sort-ind">{p.sorts[s].desc ? '▼' : '▲'}{p.sorts.length > 1 ? s + 1 : ''}</span>}
            </button>
            <span className="col-resizer" onMouseDown={e => startResize(e, c)} role="separator" aria-orientation="vertical" aria-label={`Resize ${c.label}`} />
          </div>;
        })}
      </div>
      <div className="pt-body" style={{ height: p.rows.length * p.rowHeight, width: Math.max(total, 0) }}>
        {p.rows.slice(first, last).map((r, i) => {
          const top = (first + i) * p.rowHeight;
          if (r.kind === 'group') {
            return <div key={r.key} id={`row-${r.key}`} role="row" aria-expanded={r.expanded} aria-selected={r.key === p.selectedKey} className={`pt-row group${r.key === p.selectedKey ? ' selected' : ''}`} style={{ top, height: p.rowHeight, gridTemplateColumns: template }}
              onClick={() => { p.onSelect(r.key); p.onToggle(r.key); }}>
              <div className="pt-cell group-cell" style={{ gridColumn: '1 / -1' }}><span className="tree-toggle">{r.expanded ? '▾' : '▸'}</span><strong>{r.label}</strong><span className="muted"> · {r.count} process{r.count === 1 ? '' : 'es'} · {percent(r.cpu)} CPU · {bytes(r.memory)}</span></div>
            </div>;
          }
          const proc = r.process;
          const isPinned = p.pinned.has(proc.name.toLowerCase());
          return <div key={r.key} id={`row-${r.key}`} role="row" aria-selected={r.key === p.selectedKey} className={`pt-row process-row${r.key === p.selectedKey ? ' selected' : ''}${proc.suspended ? ' suspended' : ''}`} style={{ top, height: p.rowHeight, gridTemplateColumns: template }}
            onClick={() => p.onSelect(r.key)} onDoubleClick={() => p.onActivate(r.key)} onContextMenu={e => { e.preventDefault(); p.onSelect(r.key); p.onContext(r.key, e.clientX, e.clientY); }}>
            {p.columns.map((c, ci) => {
              const text = c.text ? c.text(proc, p.ctx) : String(c.value(proc, p.ctx) ?? '—');
              const bg = heat(c, proc);
              return <div key={c.id} role="gridcell" className={`pt-cell${c.numeric ? ' num' : ''}`} style={bg ? { background: bg } : undefined} title={ci === 0 ? undefined : text}>
                {c.id === 'name' ? <span className="process-name" style={{ paddingLeft: r.depth * 16 }}>
                  {p.treeMode && (r.hasChildren
                    ? <span className="tree-toggle" role="button" aria-label={r.expanded ? 'Collapse children' : 'Expand children'} aria-expanded={r.expanded} onClick={e => { e.stopPropagation(); p.onToggle(r.key); }}>{r.expanded ? '▾' : '▸'}</span>
                    : <span className="tree-toggle" aria-hidden="true" />)}
                  <span className="process-icon" aria-hidden="true">{proc.name[0]?.toUpperCase() || '?'}</span>
                  {isPinned && <span className="pin" title="Pinned" aria-label="Pinned">●</span>}
                  <span title={proc.name}><Highlight text={proc.name} needle={p.query} /></span>
                </span> : c.id === 'path' || c.id === 'command' ? <Highlight text={text} needle={p.query} /> : text}
              </div>;
            })}
          </div>;
        })}
      </div>
      {p.rows.length === 0 && <div className="empty">{p.emptyText}</div>}
    </div>
  </div>;
}
