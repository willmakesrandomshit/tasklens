// Reproducible performance measurements of the packaged app.
// Usage: node tests/bench/bench.mjs src-tauri/target/release/tasklens.exe [stability-seconds=60]
// Measures: cold/warm startup, collection time, IPC latency, search/sort latency, scroll frame times,
// idle CPU and memory, and memory stability. Prints a JSON report. Close other heavy programs first.
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const exe = process.argv[2];
const stabilitySecs = Number(process.argv[3] ?? 60);
const port = 9444;
const sleep = ms => new Promise(r => setTimeout(r, ms));
const ps = c => execFileSync('powershell', ['-NoProfile', '-Command', c]).toString().trim();
const profile = path.join(os.tmpdir(), 'tl-bench-profile');
const name = path.basename(exe, '.exe');

async function launch() {
  const t0 = performance.now();
  const app = spawn(exe, [], { env: { ...process.env, WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${port}`, WEBVIEW2_USER_DATA_FOLDER: profile }, stdio: 'ignore' });
  let pageInfo;
  for (let i = 0; i < 600 && !pageInfo; i++) {
    try { pageInfo = (await (await fetch(`http://127.0.0.1:${port}/json`)).json()).find(t => t.type === 'page'); } catch { /* not up yet */ }
    if (!pageInfo) await sleep(50);
  }
  const ws = new WebSocket(pageInfo.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  let id = 0; const pending = new Map();
  ws.onmessage = m => { const d = JSON.parse(m.data); pending.get(d.id)?.(d); };
  const ev = async expr => {
    const myId = ++id; const p = new Promise(r => pending.set(myId, r));
    ws.send(JSON.stringify({ id: myId, method: 'Runtime.evaluate', params: { expression: expr, awaitPromise: true, returnByValue: true } }));
    const d = await p;
    if (d.result?.exceptionDetails) throw new Error(JSON.stringify(d.result.exceptionDetails).slice(0, 300));
    return d.result.result.value;
  };
  while (!(await ev(`document.querySelectorAll('.process-row').length > 0`))) await sleep(20);
  return { app, ev, startupMs: performance.now() - t0 };
}

const stats = a => { const s = [...a].sort((x, y) => x - y); const q = p => s[Math.min(s.length - 1, Math.floor(p * s.length))]; return { n: s.length, median: +q(0.5).toFixed(2), p95: +q(0.95).toFixed(2), max: +s[s.length - 1].toFixed(2) }; };
const report = {
  machine: { cpu: os.cpus()[0].model.trim(), logicalCpus: os.cpus().length, ramGB: +(os.totalmem() / 1024 ** 3).toFixed(1), windows: ps('(Get-CimInstance Win32_OperatingSystem).Caption + " build " + (Get-CimInstance Win32_OperatingSystem).BuildNumber') },
  build: 'release (LTO), unsigned', refreshIntervalMs: 2000, date: new Date().toISOString(),
};

// cold start = fresh WebView2 profile; warm = profile and files already cached
fs.rmSync(profile, { recursive: true, force: true });
let run = await launch();
report.coldStartMs = Math.round(run.startupMs);
run.app.kill(); await sleep(2000);
run = await launch();
report.warmStartMs = Math.round(run.startupMs);
const { ev, app } = run;
await sleep(4000);

// collection time reported by the backend itself (cached snapshots carry the cost of their own collection)
const collect = [];
for (let i = 0; i < 15; i++) { collect.push(await ev(`window.__TAURI_INTERNALS__.invoke('snapshot').then(s => s.collect_ms)`)); await sleep(2100); }
report.processCount = await ev(`document.querySelector('.count-pill').innerText`);
report.collectionMs = stats(collect);
// IPC round trip incl. serialisation of the cached snapshot (hundreds of processes)
const ipc = [];
for (let i = 0; i < 30; i++) ipc.push(await ev(`(async () => { const t = performance.now(); await window.__TAURI_INTERNALS__.invoke('snapshot'); return performance.now() - t; })()`));
report.snapshotIpcMs = stats(ipc);

// UI latency: dispatch → two animation frames (layout + paint)
const settle = `new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))`;
const setSearch = v => `(async () => { const i = document.querySelector('input[aria-label="Search processes"]'); const t = performance.now(); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(i, ${JSON.stringify(v)}); i.dispatchEvent(new Event('input', { bubbles: true })); await ${settle}; return performance.now() - t; })()`;
const search = [];
for (const q of ['c', 'chrome', 'sys', 'x', 'svchost', '']) for (let k = 0; k < 4; k++) search.push(await ev(setSearch(q)));
report.searchLatencyMs = stats(search);
const sort = [];
for (const col of ['Name', 'PID', 'CPU', 'Memory', 'Threads', 'Handles']) for (let k = 0; k < 4; k++) sort.push(await ev(`(async () => { const b = [...document.querySelectorAll('.pt-sort')].find(x => x.innerText.startsWith(${JSON.stringify(col)})); const t = performance.now(); b.click(); await ${settle}; return performance.now() - t; })()`));
report.sortLatencyMs = stats(sort);

// scroll smoothness: scroll the whole table top to bottom, record frame intervals
const frames = await ev(`(async () => { const el = document.querySelector('.pt-scroll'); const max = el.scrollHeight - el.clientHeight; const ts = []; let y = 0; el.scrollTop = 0;
  await new Promise(done => { const step = t => { ts.push(t); y += max / 120; el.scrollTop = y; if (y < max) requestAnimationFrame(step); else done(); }; requestAnimationFrame(step); });
  el.scrollTop = 0; return ts.slice(1).map((t, i) => t - ts[i]); })()`);
report.scrollFrameMs = { ...stats(frames), droppedOver33ms: frames.filter(f => f > 33.4).length, frames: frames.length };

// idle: Overview page, nothing selected, 30 s window
await ev(`[...document.querySelectorAll('.nav-item')].find(b => b.innerText.trim().endsWith('Overview')).click()`);
await sleep(3000);
const cpuA = Number(ps(`(Get-Process ${name}).CPU`)); const t0 = Date.now(); await sleep(30000);
const cpuB = Number(ps(`(Get-Process ${name}).CPU`));
report.idle = { windowSeconds: 30, backendCpuPercentOfOneCore: +(((cpuB - cpuA) / ((Date.now() - t0) / 1000)) * 100).toFixed(2) };
const wsOf = () => Number(ps(`[math]::Round((Get-Process ${name}).WorkingSet64/1MB,1)`));
const wv = () => Number(ps(`Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'msedgewebview2.exe' -and $_.CommandLine -like '*tl-bench-profile*' } | ForEach-Object { (Get-Process -Id $_.ProcessId -ErrorAction SilentlyContinue).WorkingSet64 } | Measure-Object -Sum | ForEach-Object { [math]::Round($_.Sum/1MB,1) }`));
report.idle.backendWorkingSetMB = wsOf(); report.idle.webview2WorkingSetMB = wv();

// stability: working set over time
const series = [];
for (let s = 0; s < stabilitySecs; s += 10) { series.push({ t: s, backendMB: wsOf(), webviewMB: wv() }); await sleep(10000); }
report.stability = { seconds: stabilitySecs, samples: series, backendGrowthMB: +(series[series.length - 1].backendMB - series[0].backendMB).toFixed(1), webviewGrowthMB: +(series[series.length - 1].webviewMB - series[0].webviewMB).toFixed(1) };

app.kill();
fs.rmSync(profile, { recursive: true, force: true });
console.log(JSON.stringify(report, null, 2));
process.exit(0);
