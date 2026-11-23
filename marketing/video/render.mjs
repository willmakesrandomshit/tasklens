// Renders the TikTok launch video (1080x1920, 60 fps, H.264 + AAC) from the captured REAL footage.
// The soundtrack is synthesised here with ffmpeg (original, no third-party audio).
// Usage: node marketing/video/render.mjs   (run capture.mjs first)
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve('marketing/video');
const frames = path.join(root, 'frames');
const outDir = path.join(root, 'output');
fs.mkdirSync(outDir, { recursive: true });
const FONT_B = 'C\\:/Windows/Fonts/segoeuib.ttf';
const FONT = 'C\\:/Windows/Fonts/segoeui.ttf';
const ACCENT = '0x4f8cff';
const T = 0.4; // transition seconds
const esc = s => s.replace(/\\/g, '\\\\').replace(/:/g, '\\:').replace(/'/g, "\u2019").replace(/%/g, '\\%');

// scene: footage folder, seconds shown, headline lines, sub line, optional footer note, zoom end factor
const scenes = [
  { dir: 's1-hook', d: 3.2, head: ['Windows Task Manager', 'deserves competition.'], sub: [], cx: 330, cw: 1400, zoom: 1.1 },
  { dir: 's2-processes', d: 6.3, head: ['Live processes.'], sub: ['Instant search. Real sorting.', '25 columns.'], cx: 330, cw: 1400, zoom: 1.0 },
  { dir: 's3-performance', d: 7.5, head: ['Every resource.'], sub: ['CPU, memory, disk and GPU', 'from real Windows counters.'], cx: 330, cw: 1590, zoom: 1.0 },
  { dir: 's4-advanced', d: 9.0, head: ['Inspect. Manage.', 'Investigate.'], sub: ['Per-process graphs, resource monitor,', 'services and startup apps.'], cx: 330, cw: 1400, zoom: 1.0 },
  { dir: 's5-design', d: 6.5, head: ['Dark. Light. Fast.'], sub: ['Measured: 0.7 s warm start, 7 ms search,', '0 dropped frames while scrolling.'], foot: 'AMD Ryzen 5 9600X, Windows 11. Details: docs/PERFORMANCE_BENCHMARKS.md', cx: 330, cw: 1400, zoom: 1.0 },
];
const END = 6.6;
const total = scenes.reduce((a, s) => a + s.d, 0) + END - T * scenes.length;

const text = (t, y, size, color = 'white', font = FONT_B, start = 0.15, fade = 0.35) =>
  `drawtext=fontfile='${font}':text='${esc(t)}':fontsize=${size}:fontcolor=${color}:x=(w-text_w)/2:y=${y}:alpha='min(1,max(0,(t-${start})/${fade}))'`;

const lines = [];
const inputs = [];
scenes.forEach((s, i) => {
  const list = path.join(frames, s.dir, 'frames.txt');
  if (!fs.existsSync(list)) throw new Error(`missing ${list}; run capture.mjs first`);
  inputs.push('-f', 'concat', '-safe', '0', '-i', list);
  const dur = s.d + T;
  const H = Math.round((1200 * 1000) / s.cw / 2) * 2;
  const top = 610;
  const zoomExpr = s.zoom > 1 ? `'1+${((s.zoom - 1) / (dur * 60)).toFixed(6)}*on'` : "'1'";
  // app footage: trim, constant 60 fps, gentle zoom from the high-res source, scale to the canvas width
  lines.push(`[${i}:v]fps=60,tpad=stop_mode=clone:stop_duration=1,trim=duration=${dur},setpts=PTS-STARTPTS,crop=${s.cw}:1200:${s.cx}:0,zoompan=z=${zoomExpr}:x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=1:s=1000x${H}:fps=60,format=yuv420p[app${i}]`);
  lines.push(`color=c=0x0f1115:s=1080x1920:r=60:d=${dur},format=yuv420p[bg${i}]`);
  let chain = `[bg${i}][app${i}]overlay=40:${top}:shortest=1`;
  // thin frame around the footage
  chain += `,drawbox=x=38:y=${top - 2}:w=1004:h=${H + 4}:color=0x2a2f38:t=2`;
  s.head.forEach((h, k) => { chain += ',' + text(h, 210 + k * 100, 84); });
  s.sub.forEach((l, k) => { chain += ',' + text(l, 210 + s.head.length * 100 + 24 + k * 50, 38, '0x98a1af', FONT, 0.45); });
  if (s.foot) chain += ',' + text(s.foot, top + H + 60, 28, '0x98a1af', FONT, 0.6);
  lines.push(`${chain}[v${i}]`);
});
// end card (generated): logo + staged lines
const endIdx = scenes.length;
inputs.push('-loop', '1', '-framerate', '60', '-t', String(END), '-i', path.resolve('src-tauri/icons/icon.png'));
let end = `color=c=0x0f1115:s=1080x1920:r=60:d=${END},format=yuv420p[ebg];[${endIdx}:v]scale=300:300,format=yuva420p,fade=t=in:st=0.1:d=0.5:alpha=1[logo];[ebg][logo]overlay=(W-w)/2:430:shortest=1`;
end += ',' + text('TASKLENS', 800, 150, 'white', FONT_B, 0.3);
end += ',' + text('Your system. Every process. Total control.', 975, 40, '0x98a1af', FONT, 0.8);
end += ',' + text('Open Source.', 1130, 64, 'white', FONT_B, 1.3);
end += ',' + text('Built with Rust.', 1215, 64, 'white', FONT_B, 1.9);
end += ',' + text('Made by Wil & Elq.', 1300, 64, 'white', FONT_B, 2.5);
end += ',' + text('Available on GitHub.', 1385, 64, ACCENT, FONT_B, 3.1);
end += ',' + text('github.com/willmakesrandomshit/tasklens', 1530, 42, ACCENT, FONT, 3.7);
lines.push(`${end}[vend]`);

// chain the scenes with transitions
let prev = 'v0'; let acc = scenes[0].d;
for (let i = 1; i <= scenes.length; i++) {
  const label = i === scenes.length ? 'vend' : `v${i}`;
  const next = i === scenes.length ? 'vout' : `x${i}`;
  lines.push(`[${prev}][${label}]xfade=transition=${i % 2 ? 'slideleft' : 'fade'}:duration=${T}:offset=${(acc - T * (i - 1) - 0 ).toFixed(3)}[${next}]`);
  acc += i === scenes.length ? END : scenes[i].d;
  prev = next;
}
lines.push('[vout]scale=in_range=pc:out_range=tv:out_color_matrix=bt709,format=yuv420p[vfinal]');
fs.writeFileSync(path.join(outDir, 'filtergraph.txt'), lines.join(';\n'));

// ---- original soundtrack (synthesised)
const wav = path.join(outDir, 'soundtrack.wav');
const tx = []; let a = scenes[0].d - T / 2; // approximate transition times for whooshes
for (let i = 1; i <= scenes.length; i++) { tx.push(a - T / 2); a += (i < scenes.length ? scenes[i].d : END) - T; }
const endStart = tx[tx.length - 1] + T / 2 + 0.1;
const L = total + 1;
const beat = 60 / 110;
const aIn = [
  ['aevalsrc', `(0.17*sin(2*PI*55*t)+0.10*sin(2*PI*110*t+0.8*sin(2*PI*0.2*t))+0.06*sin(2*PI*164.81*t)+0.05*sin(2*PI*220*t)+0.035*sin(2*PI*277.18*t)+0.025*sin(2*PI*329.63*t))*(0.75+0.25*sin(2*PI*0.25*t))*min(1,t/2.5)`],
  ['aevalsrc', `0.75*sin(2*PI*(48+110*exp(-28*mod(t,${beat.toFixed(4)})))*mod(t,${beat.toFixed(4)}))*exp(-6.5*mod(t,${beat.toFixed(4)}))*gte(t,${scenes[0].d})`],
  ['aevalsrc', `(random(0)*2-1)*0.10*exp(-55*mod(t+${(beat / 2).toFixed(4)},${(beat / 2).toFixed(4)}))*gte(t,${scenes[0].d + scenes[1].d})`],
  ['aevalsrc', `0.28*sin(2*PI*(110+55*floor(mod(t/${(beat * 4).toFixed(4)},4)))*t)*exp(-1.4*mod(t,${(beat * 4).toFixed(4)}))*gte(t,${scenes[0].d})`],
];
const af = [];
const aArgs = [];
aIn.forEach(([src, expr], i) => { aArgs.push('-f', 'lavfi', '-i', `${src}='${expr}':s=48000:d=${L.toFixed(2)}`); af.push(`[${i}:a]volume=1[m${i}]`); });
let mixLabels = aIn.map((_, i) => `[m${i}]`).join('');
let idx = aIn.length;
// hats: high-pass the noise bus; whooshes at each transition; boom at the end card
af.push('[m2]highpass=f=6000[m2h]');
mixLabels = mixLabels.replace('[m2]', '[m2h]');
tx.forEach((t, k) => {
  aArgs.push('-f', 'lavfi', '-i', `anoisesrc=d=0.9:c=pink:a=0.35:r=48000`);
  af.push(`[${idx}:a]highpass=f=500,lowpass=f=${k === tx.length - 1 ? 2500 : 7000},afade=t=in:d=0.55,afade=t=out:st=0.55:d=0.35,adelay=${Math.max(0, Math.round((t - 0.55) * 1000))}|${Math.max(0, Math.round((t - 0.55) * 1000))}[w${k}]`);
  mixLabels += `[w${k}]`; idx++;
});
aArgs.push('-f', 'lavfi', '-i', `aevalsrc='0.9*sin(2*PI*(42+60*exp(-4*t))*t)*exp(-2.2*t)':s=48000:d=3`);
af.push(`[${idx}:a]adelay=${Math.round(endStart * 1000)}|${Math.round(endStart * 1000)}[boom]`);
mixLabels += '[boom]'; idx++;
af.push(`${mixLabels}amix=inputs=${idx}:normalize=0,alimiter=limit=0.9,loudnorm=I=-16:TP=-1.5:LRA=11,afade=t=in:d=0.5,afade=t=out:st=${(total - 1.4).toFixed(2)}:d=1.4,atrim=0:${total.toFixed(2)}[aout]`);
let r = spawnSync('ffmpeg', ['-y', '-hide_banner', '-loglevel', 'error', ...aArgs, '-filter_complex', af.join(';'), '-map', '[aout]', '-ar', '48000', '-ac', '2', wav], { stdio: 'inherit' });
if (r.status) throw new Error('audio render failed');

// ---- final video
const mp4 = path.join(outDir, 'tasklens-launch-tiktok.mp4');
r = spawnSync('ffmpeg', ['-y', '-hide_banner', '-loglevel', 'error', '-stats', ...inputs, '-i', wav, '-/filter_complex', path.join(outDir, 'filtergraph.txt'),
  '-map', '[vfinal]', '-map', `${endIdx + 1}:a`, '-c:v', 'libx264', '-preset', 'slow', '-crf', '17', '-pix_fmt', 'yuv420p', '-r', '60', '-profile:v', 'high', '-level', '4.2', '-color_range', 'tv', '-colorspace', 'bt709', '-color_primaries', 'bt709', '-color_trc', 'bt709',
  '-c:a', 'aac', '-b:a', '192k', '-movflags', '+faststart', '-t', total.toFixed(2), mp4], { stdio: 'inherit' });
if (r.status) throw new Error('video render failed');
// thumbnail
spawnSync('ffmpeg', ['-y', '-hide_banner', '-loglevel', 'error', '-ss', '4.5', '-i', mp4, '-frames:v', '1', '-q:v', '2', path.join(outDir, 'thumbnail.jpg')], { stdio: 'inherit' });
console.log(`rendered ${mp4} (${total.toFixed(1)} s)`);
