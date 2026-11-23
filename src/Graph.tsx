import { useState } from 'react';

export interface Series { values: (number | null)[]; color: string; label: string }

interface Props {
  series: Series[];
  /** Fixed axis maximum (e.g. 100 for percentages). Omit to auto-scale to the data. */
  max?: number;
  /** Seconds between points, used for the x-axis labels. */
  step: number;
  /** Total points the window holds (the x-axis always spans this many). */
  points: number;
  format: (n: number) => string;
  label: string;
  height?: number;
}

function niceMax(v: number): number {
  if (v <= 0) return 1;
  const pow = 10 ** Math.floor(Math.log10(v));
  const n = v / pow;
  return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10) * pow;
}

/** Line chart with y-axis ticks, a time axis and a hover tooltip. `null` values leave gaps (unavailable). */
export function Graph({ series, max, step, points, format, label, height = 120 }: Props) {
  const [hover, setHover] = useState<number | null>(null);
  const top = max ?? niceMax(Math.max(0, ...series.flatMap(s => s.values.filter((v): v is number => v !== null))));
  const slots = Math.max(points, 2);
  const x = (i: number, len: number) => ((slots - len + i) / (slots - 1)) * 100;
  const y = (v: number) => 100 - Math.max(0, Math.min(100, (v / top) * 100));
  const paths = series.map(s => {
    const segs: string[] = [];
    let open = false;
    s.values.forEach((v, i) => {
      if (v === null) { open = false; return; }
      segs.push(`${open ? 'L' : 'M'}${x(i, s.values.length).toFixed(2)} ${y(v).toFixed(2)}`);
      open = true;
    });
    return segs.join(' ');
  });
  const len = Math.max(0, ...series.map(s => s.values.length));
  const onMove = (e: React.MouseEvent<SVGSVGElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    const frac = (e.clientX - r.left) / r.width;
    const idx = Math.round(frac * (slots - 1)) - (slots - len);
    setHover(idx >= 0 && idx < len ? idx : null);
  };
  const span = (slots - 1) * step;
  const ago = (s: number) => (s >= 3600 ? `${Math.round(s / 3600)}h` : s >= 60 ? `${Math.round(s / 60)}m` : `${Math.round(s)}s`);
  return <div className="graph-wrap" style={{ height }}>
    <div className="graph-y"><span>{format(top)}</span><span>{format(top / 2)}</span><span>0</span></div>
    <svg className="graph" viewBox="0 0 100 100" preserveAspectRatio="none" role="img" aria-label={label} onMouseMove={onMove} onMouseLeave={() => setHover(null)}>
      <path d="M0 0H100 M0 50H100 M0 100H100 M25 0V100 M50 0V100 M75 0V100" className="grid" />
      {paths.map((d, i) => <path key={i} d={d} fill="none" stroke={series[i].color} strokeWidth="1.5" vectorEffect="non-scaling-stroke" />)}
      {hover !== null && <line x1={x(hover, len)} x2={x(hover, len)} y1="0" y2="100" className="graph-cursor" vectorEffect="non-scaling-stroke" />}
    </svg>
    <div className="graph-x"><span>{ago(span)} ago</span><span>now</span></div>
    {hover !== null && <div className="graph-tip" style={{ left: `${x(hover, len)}%` }} role="status">
      {series.map(s => <div key={s.label}><span className="dot" style={{ background: s.color }} /> {s.label}: <strong>{s.values[hover] == null ? 'unavailable' : format(s.values[hover] as number)}</strong></div>)}
    </div>}
  </div>;
}

/** Tiny inline trend for tiles; no axes. */
export function Sparkline({ values, color, max = 100 }: { values: number[]; color: string; max?: number }) {
  const pts = values.map((v, i) => `${(i / Math.max(values.length - 1, 1)) * 100},${100 - Math.max(0, Math.min(100, (v / max) * 100))}`).join(' ');
  return <svg className="spark" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true"><polyline points={pts} fill="none" stroke={color} strokeWidth="2" vectorEffect="non-scaling-stroke" /></svg>;
}
