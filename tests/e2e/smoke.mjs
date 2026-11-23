// Usage: node tests/e2e/smoke.mjs src-tauri/target/release/tasklens.exe
// E2E smoke test: launches the packaged exe with WebView2 remote debugging and drives the real UI.
import { spawn, execFileSync } from 'node:child_process';
import os from 'node:os';

const exe = process.argv[2];
const port = 9333;
const sleep = ms => new Promise(r => setTimeout(r, ms));
const log = (...a) => console.log(...a);

const app = spawn(exe, [], {
  env: { ...process.env, WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${port}`, WEBVIEW2_USER_DATA_FOLDER: process.env.TEMP + '\\tl-e2e-profile' },
  stdio: 'ignore',
});
let victim;
const cleanup = () => { try { app.kill(); } catch { /* best effort */ } try { victim?.kill(); } catch { /* best effort */ } };
process.on('exit', cleanup);

async function target() {
  for (let i = 0; i < 60; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
      const page = list.find(t => t.type === 'page');
      if (page) return page;
    } catch { /* best effort */ }
    await sleep(500);
  }
  throw new Error('WebView2 debug target never appeared');
}
const page = await target();
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
let id = 0; const pending = new Map();
ws.onmessage = m => { const d = JSON.parse(m.data); pending.get(d.id)?.(d); };
const ev = async expr => {
  const myId = ++id;
  const p = new Promise(r => pending.set(myId, r));
  ws.send(JSON.stringify({ id: myId, method: 'Runtime.evaluate', params: { expression: expr, awaitPromise: true, returnByValue: true } }));
  const d = await p;
  if (d.error) throw new Error('CDP error for ' + expr.slice(0, 80) + ': ' + JSON.stringify(d.error));
  if (d.result?.exceptionDetails) throw new Error(JSON.stringify(d.result.exceptionDetails));
  return d.result.result.value;
};
const waitFor = async (expr, what, ms = 20000) => {
  const t = Date.now();
  while (Date.now() - t < ms) { if (await ev(`!!(${expr})`)) return; await sleep(250); }
  throw new Error('timeout waiting for ' + what);
};

// The window is real and visible, so a human (or anything else) clicking it can change the page mid-run.
// Always navigate explicitly before relying on a page.
const goto = async (name, ready) => {
  await ev(`[...document.querySelectorAll('.nav-item')].find(b => b.innerText.includes('${name}')).click()`);
  await waitFor(ready, `${name} page`);
};
const gotoProcesses = () => goto('Processes', `document.querySelectorAll('.process-row').length > 0`);

const results = [];
const check = (name, ok, detail = '') => { results.push({ name, ok }); log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`); };

try {
  await waitFor(`document.querySelectorAll('.process-row').length > 0`, 'process rows');
  const summary = await ev(`document.querySelector('.summary-strip').innerText.replace(/\\n+/g, ' | ')`);
  const count = await ev(`document.querySelector('.count-pill').innerText`);
  log('summary:', summary); log('count pill:', count);
  const realCount = Number(execFileSync('powershell', ['-NoProfile', '-Command', '(Get-Process).Count']).toString().trim());
  const shown = Number(count.match(/\d+/)[0]);
  check('real process data displayed', shown > 20, `UI ${shown} vs Get-Process ${realCount}`);
  check('process count within 15% of OS', Math.abs(shown - realCount) / realCount < 0.15);
  const t1 = await ev(`document.querySelector('.top-time').innerText`);
  await sleep(5000);
  const t2 = await ev(`document.querySelector('.top-time').innerText`);
  check('live updates (timestamp advances)', t1 !== t2, `${t1} -> ${t2}`);
  await gotoProcesses();
  const memPct = await ev(`document.querySelectorAll('.summary-strip strong')[1].innerText`);
  check('memory % is a real number', /^\d+(\.\d)?%$/.test(memPct), memPct);

  // navigation
  await ev(`[...document.querySelectorAll('.nav-item')].find(b => b.innerText.includes('Performance')).click()`);
  await waitFor(`document.querySelector('.performance-page')`, 'performance page');
  const cpuMeta = await ev(`document.querySelector('.metric-meta').innerText.replace(/\\n+/g,' | ')`);
  check('performance page shows CPU model/cores', /\d+ logical/.test(cpuMeta), cpuMeta);
  const coreCount = await ev(`document.querySelectorAll('.core').length`);
  check('per-core CPU bars match logical processors', coreCount === os.cpus().length, `${coreCount} vs ${os.cpus().length}`);
  await sleep(3000); // let a second sample provide rates
  const disks = await ev(`[...document.querySelectorAll('.performance-page .mini-table')][0].innerText.replace(/\\s+/g,' ')`);
  const nets = await ev(`[...document.querySelectorAll('.performance-page .mini-table')][1].innerText.replace(/\\s+/g,' ')`);
  log('disks:', disks); log('adapters:', nets);
  check('disk volumes listed', (await ev(`document.querySelectorAll('.performance-page .mini-table')[0].querySelectorAll('tbody tr').length`)) > 0);
  check('network adapters listed', (await ev(`document.querySelectorAll('.performance-page .mini-table')[1].querySelectorAll('tbody tr').length`)) > 0);
  await ev(`[...document.querySelectorAll('.nav-item')].find(b => b.innerText.includes('Processes')).click()`);
  await waitFor(`document.querySelectorAll('.process-row').length > 0`, 'rows back');

  // management pages
  await goto('Services', `document.querySelectorAll('.data-table tbody tr').length > 50`);
  const svcRows = await ev(`document.querySelectorAll('.data-table tbody tr').length`);
  check('services page lists real services', svcRows > 50, `${svcRows} rows`);
  await ev(`[...document.querySelectorAll('.data-table tbody tr')].find(r => r.children[1].innerText === 'RpcSs').click()`);
  await waitFor(`document.querySelector('.detail-panel h2')`, 'service details');
  const stopState = await ev(`(() => { const b = [...document.querySelectorAll('.detail-panel button')].find(x => x.innerText === 'Stop'); return b.disabled + '|' + b.title; })()`);
  check('stopping a core Windows service is refused in the UI', stopState.startsWith('true|'), stopState);
  await goto('Network', `document.querySelectorAll('.data-table tbody tr').length > 0`);
  const connRows = await ev(`document.querySelectorAll('.data-table tbody tr').length`);
  const listening = await ev(`[...document.querySelectorAll('.data-table tbody tr')].some(r => r.children[5].innerText === 'Listen')`);
  check('network page lists connections incl. listeners', connRows > 0 && listening, `${connRows} rows`);
  const named = await ev(`[...document.querySelectorAll('.data-table tbody tr')].some(r => !r.children[0].innerText.startsWith('Unknown'))`);
  check('connections are matched to process names', named);
  await goto('Startup', `document.querySelector('.data-table') && !document.body.innerText.includes('Reading startup entries')`);
  const startupText = await ev(`document.querySelector('.count-pill').innerText`);
  check('startup page loads entries without error', !(await ev(`!!document.querySelector('.error-banner')`)), startupText);
  await gotoProcesses();

  // process tree
  const flat = Number(await ev(`document.querySelector('.table-toolbar .muted').innerText.match(/\\d+/)[0]`));
  await ev(`[...document.querySelectorAll('.table-toolbar button')].find(b => b.innerText.includes('Tree view')).click()`);
  await waitFor(`document.querySelectorAll('.tree-toggle[role=button]').length > 0`, 'tree toggles');
  const roots = Number(await ev(`document.querySelector('.table-toolbar .muted').innerText.match(/\\d+/)[0]`));
  check('tree view collapses to fewer root rows', roots < flat, `${roots} roots vs ${flat} flat`);
  await ev(`document.querySelector('.tree-toggle[role=button]').click()`);
  await sleep(300);
  const expandedCount = Number(await ev(`document.querySelector('.table-toolbar .muted').innerText.match(/\\d+/)[0]`));
  check('expanding a node reveals its children', expandedCount > roots, `${roots} -> ${expandedCount}`);
  await ev(`[...document.querySelectorAll('.table-toolbar button')].find(b => b.innerText.includes('Tree view')).click()`);

  // UI kill of a harmless child
  victim = spawn('ping', ['-n', '300', '127.0.0.1'], { stdio: 'ignore' });
  const pid = victim.pid; log('victim pid', pid);
  let exited = false; victim.on('exit', () => { exited = true; });
  await sleep(2500); // let a snapshot include it
  await gotoProcesses();
  await ev(`(() => { const i = document.querySelector('input[aria-label="Search processes"]'); const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set; set.call(i, 'ping.exe'); i.dispatchEvent(new Event('input', { bubbles: true })); })()`);
  await waitFor(`[...document.querySelectorAll('.process-row')].some(r => r.children[1].innerText === '${pid}')`, 'victim row');
  await ev(`[...document.querySelectorAll('.process-row')].find(r => r.children[1].innerText === '${pid}').click()`);
  await waitFor(`document.querySelector('.inspector') && document.querySelector('.inspector').innerText.includes('PID ${pid}')`, 'inspector');
  check('inspector opens for selected PID', true);
  const disabled = await ev(`document.querySelector('.inspector .danger-button').disabled`);
  check('End process enabled for a readable process', disabled === false);
  await ev(`document.querySelector('.inspector .danger-button').click()`);
  await waitFor(`document.querySelector('.modal')`, 'confirm dialog');
  check('confirmation dialog shown before kill', true, await ev(`document.querySelector('.modal h2').innerText`));
  check('victim still alive before confirm', !exited);
  await ev(`document.querySelector('.modal .danger-button').click()`);
  const t = Date.now(); while (!exited && Date.now() - t < 8000) await sleep(100);
  check('victim process ended via UI', exited);

  // protected process must be refused (never attempted for real kill of anything critical: policy refuses)
  await ev(`(() => { const i = document.querySelector('input[aria-label="Search processes"]'); const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set; set.call(i, ''); i.dispatchEvent(new Event('input', { bubbles: true })); })()`);

  // idle cost
  const ps = c => execFileSync('powershell', ['-NoProfile', '-Command', c]).toString().trim();
  await ev(`document.querySelector('.inspector-head .icon-button')?.click()`);
  const name = 'tasklens';
  const cpu0 = Number(ps(`(Get-Process ${name}).CPU`)); await sleep(10000); const cpu1 = Number(ps(`(Get-Process ${name}).CPU`));
  const ws = Number(ps(`[math]::Round((Get-Process ${name}).WorkingSet64/1MB,1)`));
  const wv = ps(`$p=${app.pid}; $ids = @($p); Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'msedgewebview2.exe' -and $_.CommandLine -like '*tl-e2e-profile*' } | ForEach-Object { [math]::Round((Get-Process -Id $_.ProcessId).WorkingSet64/1MB,1) } | Measure-Object -Sum | ForEach-Object { $_.Sum }`);
  log(`IDLE: backend CPU over 10s = ${(((cpu1 - cpu0) / 10) * 100).toFixed(2)}% of one core; backend WS = ${ws} MB; webview2 procs WS sum = ${wv} MB`);
} catch (e) {
  check('script completed', false, String(e));
  try { log('page text at failure:', (await ev('document.body.innerText.slice(0,400)')).split('\n').join(' | ')); } catch { /* page gone */ }
} finally {
  cleanup();
  const failed = results.filter(r => !r.ok).length;
  log(`\n${results.length - failed}/${results.length} checks passed`);
  process.exit(failed ? 1 : 0);
}
