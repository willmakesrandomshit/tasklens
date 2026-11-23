// Records REAL footage of the running app for the launch video: drives the release exe over the DevTools
// protocol and saves screenshots at their true timestamps (frames.txt for ffmpeg's concat demuxer).
// A small cursor + click ripple is injected into the page so scripted clicks are visible; the app UI itself is
// untouched. Usage: node marketing/video/capture.mjs src-tauri/target/release/tasklens.exe
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const exe = process.argv[2];
const out = path.resolve('marketing/video/frames');
const port = 9555;
const sleep = ms => new Promise(r => setTimeout(r, ms));
const dataDir = path.join(process.env.APPDATA ?? '', 'com.tasklens.monitor');
const settingsFile = path.join(dataDir, 'settings.json');
const backup = fs.existsSync(settingsFile) ? fs.readFileSync(settingsFile) : null;

// Footage settings: hide the User column (shows the Windows account name), comfortable density, default theme.
fs.mkdirSync(dataDir, { recursive: true });
fs.writeFileSync(settingsFile, JSON.stringify({ theme: 'dark', accent: '#4f8cff', density: 'comfortable', refresh_ms: 1000, ui: { sort: [{ id: 'cpu', desc: true }], columns: { order: ['name', 'pid', 'parent', 'cpu', 'memory', 'private', 'peak', 'gpu', 'disk_read', 'disk_write', 'threads', 'handles', 'status', 'user', 'session', 'arch', 'priority', 'start', 'uptime', 'cpu_time', 'publisher', 'description', 'signature', 'path', 'command'], visible: ['name', 'pid', 'cpu', 'memory', 'gpu', 'disk_read', 'disk_write', 'threads', 'handles', 'status'], widths: {} } } }));

const app = spawn(exe, [], { env: { ...process.env, WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${port}`, WEBVIEW2_USER_DATA_FOLDER: path.join(os.tmpdir(), 'tl-video-profile') }, stdio: 'ignore' });
const restore = () => { try { app.kill(); } catch { /* gone */ } setTimeout(() => { try { if (backup) fs.writeFileSync(settingsFile, backup); else fs.rmSync(settingsFile, { force: true }); } catch { /* ignore */ } }, 1500); };
process.on('exit', restore);

let pageInfo;
for (let i = 0; i < 120 && !pageInfo; i++) {
  try { pageInfo = (await (await fetch(`http://127.0.0.1:${port}/json`)).json()).find(t => t.type === 'page'); } catch { /* wait */ }
  if (!pageInfo) await sleep(250);
}
const ws = new WebSocket(pageInfo.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
let id = 0; const pending = new Map();
ws.onmessage = m => { const d = JSON.parse(m.data); pending.get(d.id)?.(d); };
const send = async (method, params = {}) => { const i = ++id; const p = new Promise(r => pending.set(i, r)); ws.send(JSON.stringify({ id: i, method, params })); const d = await p; if (d.error) throw new Error(method + ': ' + JSON.stringify(d.error)); return d.result; };
const ev = async expr => { const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }); if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? 'js error'); return r.result.value; };
const waitFor = async (expr, ms = 15000) => { const t = Date.now(); while (Date.now() - t < ms) { if (await ev(`!!(${expr})`)) return; await sleep(150); } throw new Error('timeout ' + expr); };

await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 800, deviceScaleFactor: 1.5, mobile: false });
await waitFor(`document.querySelectorAll('.process-row').length > 0`);
await ev(`(() => { const c = document.createElement('div'); c.id = 'fake-cursor'; c.style.cssText = 'position:fixed;z-index:99999;left:640px;top:400px;width:22px;height:22px;pointer-events:none;transition:left .45s cubic-bezier(.2,.7,.2,1),top .45s cubic-bezier(.2,.7,.2,1)'; c.innerHTML = '<svg viewBox="0 0 24 24" width="22" height="22"><path d="M3 2l7.5 19 2.6-7.4L21 11z" fill="#fff" stroke="#111" stroke-width="1.4" stroke-linejoin="round"/></svg>'; document.body.appendChild(c); const s = document.createElement('style'); s.textContent = '@keyframes rip{from{transform:scale(.3);opacity:.9}to{transform:scale(2.2);opacity:0}}.ripple{position:fixed;z-index:99998;width:30px;height:30px;margin:-15px 0 0 -15px;border-radius:50%;border:2px solid #4f8cff;pointer-events:none;animation:rip .5s ease-out forwards}'; document.head.appendChild(s); })()`);

const moveTo = async sel => {
  const p = await ev(`(() => { const e = ${sel}; if (!e) return null; e.scrollIntoView({ block: 'nearest' }); const r = e.getBoundingClientRect(); return [r.left + Math.min(r.width / 2, 120), r.top + r.height / 2]; })()`);
  if (!p) throw new Error('target not found: ' + sel);
  await ev(`(() => { const c = document.getElementById('fake-cursor'); c.style.left = ${p[0]}+'px'; c.style.top = ${p[1]}+'px'; })()`);
  await sleep(520);
  return p;
};
const click = async sel => {
  const p = await moveTo(sel);
  await ev(`(() => { const r = document.createElement('div'); r.className = 'ripple'; r.style.left = ${p[0]}+'px'; r.style.top = ${p[1]}+'px'; document.body.appendChild(r); setTimeout(() => r.remove(), 600); ${sel}.click(); })()`);
  await sleep(250);
};
const typeInto = async (selector, text, delay = 170) => {
  await moveTo(`document.querySelector('${selector}')`);
  await ev(`document.querySelector('${selector}').focus()`);
  let acc = '';
  for (const ch of text) {
    acc += ch;
    await ev(`(() => { const i = document.querySelector('${selector}'); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(i, ${JSON.stringify(acc)}); i.dispatchEvent(new Event('input', { bubbles: true })); })()`);
    await sleep(delay);
  }
};
const nav = name => click(`[...document.querySelectorAll('.nav-item')].find(b => b.innerText.trim().endsWith('${name}'))`);
const tile = name => click(`[...document.querySelectorAll('.perf-tile')].find(b => b.innerText.startsWith('${name}'))`);

// ---- recording: capture frames continuously while `action` runs
async function scene(name, action, minMs = 0) {
  const dir = path.join(out, name);
  fs.rmSync(dir, { recursive: true, force: true }); fs.mkdirSync(dir, { recursive: true });
  const frames = [];
  let running = true;
  const started = performance.now();
  const loop = (async () => {
    let n = 0;
    while (running) {
      const t = performance.now() - started;
      const r = await send('Page.captureScreenshot', { format: 'jpeg', quality: 88 });
      const file = `${String(n++).padStart(4, '0')}.jpg`;
      fs.writeFileSync(path.join(dir, file), Buffer.from(r.data, 'base64'));
      frames.push({ file, t });
    }
  })();
  await action();
  while (performance.now() - started < minMs) await sleep(50);
  running = false; await loop;
  const end = performance.now() - started;
  const lines = frames.map((f, i) => `file '${f.file}'\nduration ${(((frames[i + 1]?.t ?? end) - f.t) / 1000).toFixed(4)}`);
  lines.push(`file '${frames[frames.length - 1].file}'`);
  fs.writeFileSync(path.join(dir, 'frames.txt'), lines.join('\n'));
  console.log(`${name}: ${frames.length} frames over ${(end / 1000).toFixed(1)} s (${(frames.length / (end / 1000)).toFixed(1)} fps)`);
}

await nav('Processes'); await sleep(1500);
await scene('s1-hook', async () => { await sleep(3200); }, 3200);
await scene('s2-processes', async () => {
  await typeInto('input[aria-label="Search processes"]', 'edge', 220);
  await sleep(900);
  await ev(`(() => { const i = document.querySelector('input[aria-label="Search processes"]'); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(i, ''); i.dispatchEvent(new Event('input', { bubbles: true })); })()`);
  await sleep(500);
  await click(`[...document.querySelectorAll('.pt-sort')].find(b => b.innerText.startsWith('Memory'))`);
  await sleep(900);
  await click(`[...document.querySelectorAll('.pt-sort')].find(b => b.innerText.startsWith('CPU'))`);
  await sleep(600);
}, 6200);
await scene('s3-performance', async () => {
  await nav('Performance'); await sleep(1500);
  await tile('Memory'); await sleep(1300);
  await tile('Disk'); await sleep(1200);
  await tile('GPU'); await sleep(1200);
}, 7000);
await scene('s4-advanced', async () => {
  await nav('Processes'); await sleep(500);
  await click(`document.querySelector('.process-row')`); await sleep(900);
  await click(`[...document.querySelectorAll('.inspector .tabs button')].find(b => b.innerText === 'Performance')`); await sleep(1300);
  await click(`document.querySelector('.inspector-head .icon-button')`);
  await nav('Resource Monitor'); await sleep(1300);
  await nav('Services'); await sleep(1300);
  await nav('Startup'); await sleep(1200);
}, 7500);
await scene('s5-design', async () => {
  await nav('Settings'); await sleep(700);
  await ev(`(() => { const s = document.querySelector('select[aria-label="Theme"]'); Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(s, 'light'); s.dispatchEvent(new Event('change', { bubbles: true })); })()`);
  await sleep(900);
  await nav('Processes'); await sleep(1500);
  await nav('Performance'); await sleep(1300);
  await ev(`(() => { const s = document.querySelector('select[aria-label="Theme"]'); if (s) { Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(s, 'dark'); s.dispatchEvent(new Event('change', { bubbles: true })); } })()`);
}, 6200);
console.log('done');
process.exit(0);
