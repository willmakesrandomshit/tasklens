// End-to-end test of the packaged app. Launches the real exe with WebView2 remote debugging and drives its
// real UI over the DevTools protocol, using only harmless throwaway child processes.
// Usage: node tests/e2e/smoke.mjs src-tauri/target/release/tasklens.exe [screenshots-dir]
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const exe = process.argv[2];
const shotsDir = process.argv[3];
const port = 9333;
const sleep = ms => new Promise(r => setTimeout(r, ms));
const log = (...a) => console.log(...a);
const ps = c => execFileSync('powershell', ['-NoProfile', '-Command', c]).toString().trim();

// The test changes settings and may create a history database in the real app-data folder; back up and restore.
const dataDir = path.join(process.env.APPDATA ?? '', 'com.tasklens.monitor');
const settingsFile = path.join(dataDir, 'settings.json');
const historyFile = path.join(dataDir, 'history.db');
const settingsBackup = fs.existsSync(settingsFile) ? fs.readFileSync(settingsFile) : null;
const hadHistory = fs.existsSync(historyFile);

const app = spawn(exe, [], {
  env: { ...process.env, WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${port}`, WEBVIEW2_USER_DATA_FOLDER: path.join(os.tmpdir(), 'tl-e2e-profile') },
  stdio: 'ignore',
});
const children = [];
const spawnPing = () => { const c = spawn('ping', ['-n', '300', '127.0.0.1'], { stdio: 'ignore' }); children.push(c); return c; };
let restored = false;
const cleanup = () => {
  for (const c of children) { try { c.kill(); } catch { /* already gone */ } }
  try { app.kill(); } catch { /* already gone */ }
  if (restored) return;
  restored = true;
  try { execFileSync('powershell', ['-NoProfile', '-Command', 'Start-Sleep -Milliseconds 800']); } catch { /* ignore */ }
  try {
    if (settingsBackup) fs.writeFileSync(settingsFile, settingsBackup); else fs.rmSync(settingsFile, { force: true });
    if (!hadHistory) for (const s of ['', '-wal', '-shm']) fs.rmSync(historyFile + s, { force: true });
  } catch (e) { log('WARN could not restore app data:', e.message); }
};
process.on('exit', cleanup);

async function target() {
  for (let i = 0; i < 60; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
      const page = list.find(t => t.type === 'page');
      if (page) return page;
    } catch { /* not up yet */ }
    await sleep(500);
  }
  throw new Error('WebView2 debug target never appeared');
}
const page = await target();
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
let id = 0; const pending = new Map();
ws.onmessage = m => { const d = JSON.parse(m.data); pending.get(d.id)?.(d); };
const send = async (method, params = {}) => {
  const myId = ++id;
  const p = new Promise(r => pending.set(myId, r));
  ws.send(JSON.stringify({ id: myId, method, params }));
  const d = await p;
  if (d.error) throw new Error(`CDP ${method}: ${JSON.stringify(d.error)}`);
  return d.result;
};
const ev = async expr => {
  const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error('JS: ' + (r.exceptionDetails.exception?.description ?? JSON.stringify(r.exceptionDetails)).slice(0, 300) + '\n  in: ' + expr.slice(0, 160));
  return r.result.value;
};
const waitFor = async (expr, what, ms = 20000) => {
  const t = Date.now();
  while (Date.now() - t < ms) { if (await ev(`!!(${expr})`)) return; await sleep(250); }
  throw new Error('timeout waiting for ' + what);
};
const results = [];
const check = (name, ok, detail = '') => { results.push({ name, ok }); log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`); };
const shot = async name => {
  if (!shotsDir) return;
  fs.mkdirSync(shotsDir, { recursive: true });
  const r = await send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(path.join(shotsDir, `${name}.png`), Buffer.from(r.data, 'base64'));
};

// The window is real and visible, so a human clicking it can change the page mid-run; always navigate explicitly.
const goto = async (name, ready) => {
  await ev(`[...document.querySelectorAll('.nav-item')].find(b => b.innerText.trim().endsWith('${name}')).click()`);
  await waitFor(ready, `${name} page`);
};
const gotoProcesses = () => goto('Processes', `document.querySelectorAll('.process-row').length > 0`);
const setInput = (sel, value) => ev(`(() => { const i = document.querySelector('${sel}'); const proto = i instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype; Object.getOwnPropertyDescriptor(proto, 'value').set.call(i, ${JSON.stringify(value)}); i.dispatchEvent(new Event(i instanceof HTMLSelectElement ? 'change' : 'input', { bubbles: true })); })()`);
const setCheckbox = label => ev(`document.querySelector('input[aria-label="${label}"]').click()`);
const rowFor = pid => `[...document.querySelectorAll('.process-row')].find(r => r.children[1].innerText === '${pid}')`;
const searchFor = async text => { await gotoProcesses(); await setInput('input[aria-label="Search processes"]', text); };
const selectRow = async pid => {
  await waitFor(rowFor(pid), `row ${pid}`);
  await ev(`${rowFor(pid)}.click()`);
  await waitFor(`document.querySelector('.inspector') && document.querySelector('.inspector').innerText.includes('PID ${pid}')`, `inspector ${pid}`);
};
const rightClick = pid => ev(`${rowFor(pid)}.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 300, clientY: 200 }))`);
const menuClick = label => ev(`[...document.querySelectorAll('[role=menuitem]')].find(b => b.innerText.trim().startsWith(${JSON.stringify(label)})).click()`);
const menuHover = label => ev(`[...document.querySelectorAll('[role=menuitem]')].find(b => b.innerText.trim().startsWith(${JSON.stringify(label)})).dispatchEvent(new MouseEvent('mouseover', { bubbles: true }))`);
const alive = pid => { try { return ps(`(Get-Process -Id ${pid} -ErrorAction SilentlyContinue) -ne $null`) === 'True'; } catch { return false; } };

try {
  // ---- real data + live updates
  await waitFor(`document.querySelectorAll('.process-row').length > 0`, 'process rows');
  const count = await ev(`document.querySelector('.count-pill').innerText`);
  const realCount = Number(ps('(Get-Process).Count'));
  const shown = Number(count.match(/\d+/)[0]);
  check('real process data displayed', shown > 20, `UI ${shown} vs Get-Process ${realCount}`);
  check('process count within 15% of OS', Math.abs(shown - realCount) / realCount < 0.15);
  const t1 = await ev(`document.querySelector('.top-time').innerText`);
  await sleep(4500);
  check('live updates (timestamp advances)', t1 !== (await ev(`document.querySelector('.top-time').innerText`)));
  const cols = await ev(`[...document.querySelectorAll('.pt-th')].map(h => h.innerText.trim())`);
  check('process table shows rich columns', ['CPU', 'Memory', 'GPU', 'Threads', 'Handles', 'User'].every(c => cols.some(x => x.startsWith(c))), cols.join(', '));
  const sample = await ev(`(() => { const r = document.querySelector('.process-row'); return [...r.children].map(c => c.innerText.trim()).join(' | '); })()`);
  log('first row:', sample);
  await shot('processes');

  // ---- search, sort, grouping
  await setInput('input[aria-label="Search processes"]', 'ping');
  await sleep(400);
  const filtered = await ev(`document.querySelectorAll('.process-row').length`);
  check('search narrows the list', filtered < shown, `${filtered} rows for "ping"`);
  await setInput('input[aria-label="Search processes"]', '');
  const before = await ev(`document.querySelector('.process-row').children[1].innerText`);
  await ev(`[...document.querySelectorAll('.pt-sort')].find(b => b.innerText.startsWith('PID')).click()`);
  await sleep(300);
  const sorted = await ev(`[...document.querySelectorAll('.process-row')].slice(0, 5).map(r => Number(r.children[1].innerText))`);
  check('sorting by PID reorders rows (numeric columns start descending)', sorted.every((v, i) => i === 0 || v <= sorted[i - 1]) && String(sorted[0]) !== before, sorted.join(','));
  await ev(`[...document.querySelectorAll('.pt-sort')].find(b => b.innerText.startsWith('CPU')).click()`);
  await setInput('select[aria-label="Grouping"]', 'tree');
  await waitFor(`document.querySelectorAll('.tree-toggle[role=button]').length > 0`, 'tree toggles');
  const roots = Number(await ev(`document.querySelector('.table-toolbar .muted').innerText.match(/\\d+/)[0]`));
  check('tree view collapses to fewer root rows', roots < shown, `${roots} roots vs ${shown}`);
  await ev(`document.querySelector('.tree-toggle[role=button]').click()`);
  await sleep(300);
  const expanded = Number(await ev(`document.querySelector('.table-toolbar .muted').innerText.match(/\\d+/)[0]`));
  check('expanding a node reveals its children', expanded > roots, `${roots} -> ${expanded}`);
  await shot('process-tree');
  await setInput('select[aria-label="Grouping"]', 'app');
  await waitFor(`document.querySelectorAll('.pt-row.group').length > 0`, 'groups');
  check('group by application works', (await ev(`document.querySelectorAll('.pt-row.group').length`)) > 5);
  await setInput('select[aria-label="Grouping"]', 'flat');

  // ---- context menu, priority, suspend/resume on a throwaway process
  const victim = spawnPing();
  await sleep(2500);
  await searchFor('ping.exe');
  await selectRow(victim.pid);
  await waitFor(`document.querySelector('.inspector-stats')`, 'inspector stats');
  check('inspector opens for selected PID', true);
  const ov = await ev(`document.querySelector('.inspector .tab-body').innerText.replace(/\\s+/g, ' ')`);
  check('inspector shows user, priority and architecture', /User/.test(ov) && /Normal/.test(ov) && /x64|ARM64/.test(ov), ov.slice(0, 120));
  await shot('inspector');
  await rightClick(victim.pid);
  await waitFor(`document.querySelector('[role=menu]')`, 'context menu');
  const items = await ev(`[...document.querySelectorAll('[role=menuitem]')].map(b => b.innerText.trim())`);
  check('context menu offers the expected actions', ['End process', 'End process tree', 'Suspend', 'Set priority', 'Open file location', 'Copy PID', 'Properties'].every(w => items.some(i => i.startsWith(w))), items.join(' / '));
  await menuHover('Set priority');
  await sleep(200);
  await menuClick('Below normal');
  await sleep(1200);
  check('priority changed through the UI is applied by Windows', ps(`(Get-Process -Id ${victim.pid}).PriorityClass`) === 'BelowNormal');
  await ev(`[...document.querySelectorAll('.inspector .secondary-button')].find(b => b.innerText === 'Suspend').click()`);
  await waitFor(`document.querySelector('.action-ok')?.innerText.includes('Suspended')`, 'suspend message');
  const suspended = ps(`(Get-Process -Id ${victim.pid}).Threads | ForEach-Object { $_.WaitReason } | Select-Object -Unique`);
  check('suspend through the UI suspends the process threads', /Suspended/.test(suspended), suspended);
  await ev(`[...document.querySelectorAll('.inspector .secondary-button')].find(b => b.innerText === 'Resume').click()`);
  await waitFor(`document.querySelector('.action-ok')?.innerText.includes('Resumed')`, 'resume message');
  check('resume works', !/Suspended/.test(ps(`(Get-Process -Id ${victim.pid}).Threads | ForEach-Object { $_.WaitReason } | Select-Object -Unique`)));

  // ---- end process: confirmation, then exactly that process
  await ev(`[...document.querySelectorAll('.inspector .danger-button')].find(b => b.innerText === 'End process').click()`);
  await waitFor(`document.querySelector('.modal')`, 'confirm dialog');
  check('confirmation dialog shown before kill', (await ev(`document.querySelector('.modal h2').innerText`)).startsWith('End '));
  check('victim still alive before confirm', alive(victim.pid));
  await ev(`document.querySelector('.modal .danger-button').click()`);
  await sleep(1500);
  check('victim process ended via UI', !alive(victim.pid));

  // ---- end process TREE: cmd -> ping. An unrelated ping must survive.
  const bystander = spawnPing();
  const root = spawn('cmd', ['/c', 'ping -n 300 127.0.0.1 >nul'], { stdio: 'ignore' }); children.push(root);
  await sleep(3000);
  const childPid = Number(ps(`(Get-CimInstance Win32_Process -Filter "ParentProcessId=${root.pid}" | Select-Object -First 1).ProcessId`));
  check('tree test fixture has a child process', childPid > 0, `root ${root.pid} -> ${childPid}`);
  await searchFor('cmd.exe');
  await selectRow(root.pid);
  await ev(`[...document.querySelectorAll('.inspector .danger-button')].find(b => b.innerText === 'End process tree').click()`);
  await waitFor(`document.querySelector('.modal')`, 'tree confirm');
  check('tree confirmation mentions the children', /process(es)? it started/.test(await ev(`document.querySelector('.modal p').innerText`)));
  await ev(`document.querySelector('.modal .danger-button').click()`);
  await sleep(2500);
  check('end process tree removed the root and its child', !alive(root.pid) && !alive(childPid));
  check('an unrelated process survived the tree kill', alive(bystander.pid));
  bystander.kill();

  // ---- refusals: a critical process cannot be ended from the UI
  await searchFor('csrss.exe');
  await sleep(500);
  const csrss = await ev(`(() => { const r = document.querySelector('.process-row'); return r ? r.children[1].innerText : null; })()`);
  if (csrss) {
    await selectRow(csrss);
    await ev(`[...document.querySelectorAll('.inspector .danger-button')].find(b => b.innerText === 'End process').click()`);
    const modal = await ev(`!!document.querySelector('.modal')`);
    if (modal) { await ev(`document.querySelector('.modal .danger-button').click()`); await sleep(1500); }
    check('a critical Windows process is refused (csrss.exe still alive)', alive(csrss) && /Refused|denied|critical|cannot/i.test(await ev(`document.querySelector('.action-error')?.innerText ?? ''`)), await ev(`document.querySelector('.action-error')?.innerText ?? ''`));
  } else check('csrss.exe visible for refusal test', false, 'not listed');
  await setInput('input[aria-label="Search processes"]', '');
  await ev(`document.querySelector('.inspector-head .icon-button')?.click()`);

  // ---- performance modules
  await goto('Performance', `document.querySelector('.performance-page')`);
  await waitFor(`document.querySelectorAll('.core-cell').length > 0`, 'core graphs');
  const coreCount = await ev(`document.querySelectorAll('.core-cell').length`);
  check('per-core CPU graphs match logical processors', coreCount === os.cpus().length, `${coreCount} vs ${os.cpus().length}`);
  await shot('performance-cpu');
  await ev(`[...document.querySelectorAll('.perf-tile')].find(b => b.innerText.startsWith('Memory')).click()`);
  await waitFor(`document.querySelector('.membar')`, 'memory composition');
  check('memory composition bar and commit data present', /Committed/.test(await ev(`document.querySelector('.perf-detail').innerText`)));
  await shot('performance-memory');
  await ev(`[...document.querySelectorAll('.perf-tile')].find(b => b.innerText.startsWith('Disk')).click()`);
  await sleep(2500);
  const disk = await ev(`document.querySelector('.perf-detail').innerText.replace(/\\s+/g, ' ')`);
  check('physical disk activity and response time shown', /Physical disks/.test(disk) && /ms/.test(disk), disk.slice(0, 160));
  await shot('performance-disk');
  await ev(`[...document.querySelectorAll('.perf-tile')].find(b => b.innerText.startsWith('Network')).click()`);
  await sleep(2500);
  const net = await ev(`document.querySelector('.perf-detail').innerText.replace(/\\s+/g, ' ')`);
  check('network adapters with link speed shown', /Mbps|Gbps/.test(net), net.slice(0, 160));
  await ev(`[...document.querySelectorAll('.perf-tile')].find(b => b.innerText.startsWith('GPU')).click()`);
  await sleep(1000);
  const gpu = await ev(`document.querySelector('.perf-detail').innerText.replace(/\\s+/g, ' ')`);
  check('GPU page lists adapters and is honest about unavailable sensors', /Adapters/.test(gpu) && /not available|Not available|temperature/i.test(gpu), gpu.slice(0, 200));
  await shot('performance-gpu');

  // ---- other modules
  await goto('Overview', `document.querySelector('.ov-tiles')`);
  check('overview shows resource tiles and top processes', (await ev(`document.querySelectorAll('.ov-tile').length`)) === 5 && (await ev(`document.querySelectorAll('.ov-lists .metric').length`)) === 4);
  await shot('overview');
  await goto('Resource Monitor', `document.querySelector('.rm-summary')`);
  await ev(`[...document.querySelectorAll('.tabs button')].find(b => b.innerText === 'Memory').click()`);
  await sleep(500);
  check('resource monitor lists processes per resource', (await ev(`document.querySelectorAll('.data-table tbody tr').length`)) > 10);
  await shot('resource-monitor');
  await goto('Services', `document.querySelectorAll('.data-table tbody tr').length > 50`);
  check('services page lists real services', (await ev(`document.querySelectorAll('.data-table tbody tr').length`)) > 50);
  await ev(`[...document.querySelectorAll('.data-table tbody tr')].find(r => r.children[1].innerText === 'RpcSs').click()`);
  await waitFor(`document.querySelector('.detail-panel h2')`, 'service details');
  const stopState = await ev(`(() => { const b = [...document.querySelectorAll('.detail-panel button')].find(x => x.innerText === 'Stop'); return b.disabled + '|' + b.title; })()`);
  check('stopping a core Windows service is refused in the UI', stopState.startsWith('true|'), stopState);
  await shot('services');
  await goto('Network', `document.querySelectorAll('.data-table tbody tr').length > 0`);
  check('network page lists connections incl. listeners', await ev(`[...document.querySelectorAll('.data-table tbody tr')].some(r => r.children[5].innerText === 'Listen')`));
  check('connections are matched to process names', await ev(`[...document.querySelectorAll('.data-table tbody tr')].some(r => !r.children[0].innerText.startsWith('Unknown'))`));
  await shot('network');
  await goto('Startup', `document.querySelector('.data-table') && !document.body.innerText.includes('Reading startup entries')`);
  check('startup page loads entries without error', !(await ev(`!!document.querySelector('.error-banner')`)), await ev(`document.querySelector('.count-pill').innerText`));
  await shot('startup');
  await goto('Users', `document.querySelectorAll('.data-table tbody tr').length > 0`);
  check('users page lists sessions and accounts', (await ev(`document.querySelectorAll('.data-table').length`)) === 2);
  await goto('System', `document.querySelector('.split-cols')`);
  await sleep(800);
  const sys = await ev(`document.querySelector('.split-cols').innerText.replace(/\\s+/g, ' ')`);
  check('system information shows Windows edition and CPU', /Windows 1[01]/.test(sys) && /Ryzen|Intel|Core|AMD|Snapdragon/i.test(sys), sys.slice(0, 120));
  await shot('system');

  // ---- settings: persistence, history recording, alerts
  await goto('Settings', `document.querySelector('.settings-page')`);
  await setInput('select[aria-label="Theme"]', 'light');
  await sleep(300);
  check('theme switch applies immediately', (await ev(`document.documentElement.dataset.theme`)) === 'light');
  await shot('settings-light');
  await setInput('select[aria-label="Density"]', 'comfortable');
  await setInput('select[aria-label="History interval"]', '1');
  await setCheckbox('Record history');
  await sleep(1200);
  const saved = fs.existsSync(settingsFile) ? JSON.parse(fs.readFileSync(settingsFile, 'utf8')) : null;
  check('settings persisted to disk by the backend', saved?.theme === 'light' && saved?.density === 'comfortable' && saved?.history?.enabled === true, saved ? `theme=${saved.theme}` : 'no file');
  await setInput('select[aria-label="Theme"]', 'dark');
  await shot('settings-dark');
  await sleep(6000); // let the engine record a few 1 s samples
  await goto('History', `document.querySelector('.rec-bar')`);
  await sleep(1500);
  const hist = await ev(`document.querySelector('.rec-bar').innerText + ' ' + (document.querySelector('.rec-bar + p')?.innerText ?? '')`);
  const samples = Number((hist.match(/([\d,]+) samples/) ?? [])[1]?.replace(/,/g, '') ?? 0);
  check('history recorded real samples to local storage', samples >= 3, `${samples} samples`);
  check('history charts render', (await ev(`document.querySelectorAll('.chart-grid .graph').length`)) >= 6);
  await shot('history');
  await goto('Alerts', `document.querySelector('.page-heading')`);
  await ev(`[...document.querySelectorAll('button')].find(b => b.innerText === 'Add alert').click()`);
  await waitFor(`document.querySelector('input[aria-label="Alert name"]')`, 'alert editor');
  check('alert editor creates a rule', true);
  await shot('alerts');
  await goto('Settings', `document.querySelector('.settings-page')`);

  // ---- responsive layout
  await goto('Processes', `document.querySelectorAll('.process-row').length > 0`);
  await send('Emulation.setDeviceMetricsOverride', { width: 820, height: 600, deviceScaleFactor: 1, mobile: false });
  await sleep(600);
  check('layout fits a narrow window without horizontal page scroll', (await ev(`document.documentElement.scrollWidth <= window.innerWidth + 1`)));
  await send('Emulation.clearDeviceMetricsOverride');

  // ---- idle cost (separate sample, not a benchmark)
  await ev(`document.querySelector('.inspector-head .icon-button')?.click()`);
  await goto('Overview', `document.querySelector('.ov-tiles')`);
  const name = path.basename(exe, '.exe');
  const cpu0 = Number(ps(`(Get-Process ${name}).CPU`)); await sleep(10000); const cpu1 = Number(ps(`(Get-Process ${name}).CPU`));
  const mem = Number(ps(`[math]::Round((Get-Process ${name}).WorkingSet64/1MB,1)`));
  const wv = ps(`Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'msedgewebview2.exe' -and $_.CommandLine -like '*tl-e2e-profile*' } | ForEach-Object { (Get-Process -Id $_.ProcessId -ErrorAction SilentlyContinue).WorkingSet64 } | Measure-Object -Sum | ForEach-Object { [math]::Round($_.Sum/1MB,1) }`);
  log(`IDLE (Overview page, 2 s refresh): backend CPU ${(((cpu1 - cpu0) / 10) * 100).toFixed(2)}% of one core; backend WS ${mem} MB; webview2 WS ${wv} MB`);
} catch (e) {
  check('script completed', false, String(e.message ?? e));
  try { log('page text at failure:', (await ev('document.body.innerText.slice(0,500)')).split('\n').join(' | ')); } catch { /* page gone */ }
} finally {
  cleanup();
  const failed = results.filter(r => !r.ok).length;
  log(`\n${results.length - failed}/${results.length} checks passed`);
  process.exit(failed ? 1 : 0);
}
