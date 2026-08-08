// Renderer memory probe: boots the desktop app against the LIVE daemon in an
// isolated profile and measures JS heap + DOM counters + process RSS for
// three layouts — empty workspace, one (heaviest/latest) session, and a
// four-session split. Attribution for the renderer-memory reduction round.
//
// Run: node scripts/desktop-memory-probe.mjs [--sessions=4]
import { spawn } from 'node:child_process';
import { execFile } from 'node:child_process';
import { mkdir, rm } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const desktopDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
// Stale MIXDOG_* overrides from the launching shell (perf-harness leftovers)
// would point both this reader AND the probe app at dead roots.
for (const key of Object.keys(process.env)) {
  if (key.startsWith('MIXDOG_')) delete process.env[key];
}
const electron = join(
  desktopDir, 'node_modules', 'electron', 'dist',
  process.platform === 'win32' ? 'electron.exe' : 'electron',
);
const profileRoot = join(desktopDir, 'artifacts', 'memory-probe-profiles');
const SPLIT_SESSIONS = Math.max(2, Number(
  process.argv.find((argument) => argument.startsWith('--sessions='))?.slice('--sessions='.length) || 4,
));

// Session ids come straight from the shared store (renderer listSessions is
// project-scoped and empty on a fresh profile): newest first.
async function recentSessionIds(limit) {
  const readerPath = join(desktopDir, '..', '..', 'src', 'runtime', 'agent', 'orchestrator', 'session', 'store-summary-reader.mjs');
  const reader = await import(pathToFileURL(readerPath).href);
  const rows = await reader.listStoredSessionSummaries?.() || [];
  return rows
    // Lead conversations only (agent==='lead' / user-owned): worker sessions
    // are rejected by the pane layout and would reset the seeded split.
    .filter((row) => row?.id && row.closed !== true
      && (row.agent === 'lead' || (!row.agent && (row.owner === 'user' || row.owner === 'cli'))))
    // Heaviest transcripts first: storageSize is the honest cost proxy.
    .sort((a, b) => (Number(b.storageSize) || 0) - (Number(a.storageSize) || 0))
    .slice(0, limit)
    .map((row) => String(row.id));
}

class CdpClient {
  constructor(url) {
    this.socket = new WebSocket(url);
    this.nextId = 1;
    this.pending = new Map();
  }
  async connect() {
    this.socket.addEventListener('message', (event) => {
      const message = JSON.parse(String(event.data));
      if (!message.id) return;
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      clearTimeout(pending.timer);
      if (message.error) pending.reject(new Error(message.error.message));
      else pending.resolve(message.result);
    });
    await new Promise((resolvePromise, reject) => {
      const timer = setTimeout(() => reject(new Error('CDP connection timed out.')), 15_000);
      this.socket.addEventListener('open', () => { clearTimeout(timer); resolvePromise(); }, { once: true });
      this.socket.addEventListener('error', () => { clearTimeout(timer); reject(new Error('CDP websocket failed.')); }, { once: true });
    });
  }
  request(method, params = {}, timeoutMs = 20_000) {
    const id = this.nextId++;
    return new Promise((resolvePromise, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method} timed out after ${timeoutMs}ms.`));
      }, timeoutMs);
      this.pending.set(id, { resolve: resolvePromise, reject, timer });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }
  async evaluate(expression, timeoutMs = 20_000) {
    const response = await this.request('Runtime.evaluate', {
      expression, awaitPromise: true, returnByValue: true,
    }, timeoutMs);
    if (response.exceptionDetails) {
      throw new Error(response.exceptionDetails.exception?.description || response.exceptionDetails.text);
    }
    return response.result?.value;
  }
  close() { this.socket.close(); }
}

async function waitForTarget(port, child) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`Electron exited with ${child.exitCode}.`);
    try {
      const targets = await fetch(`http://127.0.0.1:${port}/json/list`).then((response) => response.json());
      const target = targets.find((candidate) => candidate.type === 'page'
        && candidate.url?.includes('/out/renderer/index.html'));
      if (target?.webSocketDebuggerUrl) return target.webSocketDebuggerUrl;
    } catch { /* not listening yet */ }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
  }
  throw new Error(`CDP target did not appear on port ${port}.`);
}

async function evaluateStable(client, expression, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      return await client.evaluate(expression, Math.max(1_000, deadline - Date.now()));
    } catch (error) {
      lastError = error;
      if (!/Execution context was destroyed|Cannot find context|Failed to read the 'localStorage' property/i
        .test(String(error?.message || error))) throw error;
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
    }
  }
  throw lastError || new Error('Renderer execution context did not stabilize.');
}

async function stopApp(client, child) {
  try { await client.evaluate('window.mixdogDesktop?.quit?.()', 5_000); } catch { /* kill below */ }
  client.close();
  await Promise.race([
    new Promise((resolvePromise) => child.once('exit', resolvePromise)),
    new Promise((resolvePromise) => setTimeout(resolvePromise, 4_000)),
  ]);
  if (child.exitCode === null) child.kill();
}

async function launch(profilePath, port) {
  // The probe may run from inside a Mixdog shell whose environment carries
  // ELECTRON_RUN_AS_NODE=1 plus stale MIXDOG_* test overrides (runtime root,
  // data dir, spread flags) from earlier commands in the same persistent
  // shell. Any of those would point the app at a dead daemon/root; strip them
  // all and keep only the probe profile isolation.
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key.startsWith('MIXDOG_') || key.startsWith('ELECTRON_')) delete env[key];
  }
  env.MIXDOG_DESKTOP_USER_DATA = profilePath;
  const child = spawn(electron, [desktopDir, `--remote-debugging-port=${port}`], {
    cwd: desktopDir,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: false,
  });
  child.stdout.on('data', (chunk) => process.stdout.write(`[app] ${chunk}`));
  child.stderr.on('data', (chunk) => process.stdout.write(`[app-err] ${chunk}`));
  const client = new CdpClient(await waitForTarget(port, child));
  await client.connect();
  return { child, client };
}

async function rendererRssMb(mainPid) {
  if (process.platform !== 'win32') return null;
  try {
    const { stdout } = await execFileAsync('powershell', ['-NoProfile', '-Command',
      `Get-CimInstance Win32_Process -Filter "ParentProcessId=${mainPid}" | `
      + `Where-Object { $_.CommandLine -match '--type=renderer' } | `
      + `ForEach-Object { (Get-Process -Id $_.ProcessId -ErrorAction SilentlyContinue).WorkingSet64 }`,
    ]);
    const values = stdout.trim().split(/\r?\n/).map(Number).filter((value) => value > 0);
    if (!values.length) return null;
    return Math.round(Math.max(...values) / (1024 * 1024));
  } catch { return null; }
}

async function seedLayout(profilePath, port, kind, sessionIds = []) {
  const { child, client } = await launch(profilePath, port);
  try {
    const seeded = await evaluateStable(client, `(async () => {
      const startupDeadline = performance.now() + 10_000;
      while (!window.__mixdogStartupSettled && performance.now() < startupDeadline) {
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      // Session ids are injected from the shared store (renderer listSessions
      // is project-scoped and stays empty on a fresh probe profile).
      const ids = ${JSON.stringify(sessionIds)};
      const kind = ${JSON.stringify(kind)};
      const sessionLeaf = (paneId, id) => ({
        type: "leaf", id: paneId, tabs: [{ kind: "session", id }], activeKey: "session:" + id,
      });
      let layout;
      if (kind === "empty" || ids.length === 0) {
        layout = { type: "leaf", id: "probe-pane", tabs: [{ kind: "new" }], activeKey: "new:default" };
      } else if (kind === "one") {
        layout = sessionLeaf("probe-pane", ids[0]);
      } else {
        const picked = ids.slice(0, ${SPLIT_SESSIONS});
        while (picked.length < 2) picked.push(ids[0]);
        const leaves = picked.map((id, index) => sessionLeaf("probe-" + index, id));
        layout = leaves.reduce((first, second, index) => (index === 0 ? second : {
          type: "split", direction: index % 2 ? "row" : "column", ratio: 0.5, first, second,
        }));
      }
      localStorage.setItem("mixdog.desktop.pane-layout.v1", JSON.stringify({
        layout, focusedLeafId: kind === "empty" ? "probe-pane" : (kind === "one" ? "probe-pane" : "probe-0"),
      }));
      localStorage.setItem("mixdog.desktop-sidebar-open.v1", "false");
      localStorage.removeItem("mixdog.desktop-last-session.v1");
      return { sessions: ids.length, first: ids[0] || null };
    })()`);
    console.log(`[seed:${kind}] sessions=${seeded?.sessions} first=${seeded?.first}`);
  } finally {
    await stopApp(client, child);
  }
}

async function measure(profilePath, port, label) {
  const { child, client } = await launch(profilePath, port);
  try {
    // Let the layout restore, transcripts hydrate, and the heap settle.
    await evaluateStable(client, `(async () => {
      const startupDeadline = performance.now() + 20_000;
      while (!window.__mixdogStartupSettled && performance.now() < startupDeadline) {
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      await new Promise((resolve) => setTimeout(resolve, 8_000));
      return true;
    })()`, 40_000);
    const heap = await client.evaluate(`(() => {
      const memory = performance.memory || {};
      return {
        usedMB: Math.round((memory.usedJSHeapSize || 0) / 1048576),
        totalMB: Math.round((memory.totalJSHeapSize || 0) / 1048576),
        domNodes: document.querySelectorAll("*").length,
        activeLayout: (() => { try { return JSON.parse(localStorage.getItem("mixdog.desktop.pane-layout.v1") || "null")?.layout?.activeKey || JSON.parse(localStorage.getItem("mixdog.desktop.pane-layout.v1") || "null")?.layout?.type; } catch { return null; } })(),
      };
    })()`);
    const counters = await client.request('Memory.getDOMCounters', {}, 10_000).catch(() => null);
    const rss = await rendererRssMb(child.pid);
    console.log(`[${label}] jsHeap=${heap.usedMB}/${heap.totalMB}MB domNodes=${heap.domNodes}`
      + ` cdpNodes=${counters?.nodes ?? 'n/a'} listeners=${counters?.jsEventListeners ?? 'n/a'}`
      + ` rendererRss=${rss ?? 'n/a'}MB layout=${heap.activeLayout ?? 'n/a'}`);
    return { label, heap, counters, rss };
  } finally {
    await stopApp(client, child);
  }
}

await rm(profileRoot, { recursive: true, force: true });
let port = 9470;
const results = [];
const storeIds = await recentSessionIds(SPLIT_SESSIONS + 2);
console.log(`store sessions: ${storeIds.length} first=${storeIds[0] || 'none'}`);
for (const kind of ['empty', 'one', 'split']) {
  const profilePath = join(profileRoot, kind);
  await mkdir(profilePath, { recursive: true });
  await seedLayout(profilePath, port++, kind, kind === 'empty' ? [] : storeIds);
  results.push(await measure(profilePath, port++, kind));
}
const [empty, one, split] = results;
if (empty?.heap && one?.heap && split?.heap) {
  console.log(`delta one-session: heap +${one.heap.usedMB - empty.heap.usedMB}MB rss +${(one.rss ?? 0) - (empty.rss ?? 0)}MB`);
  console.log(`delta ${SPLIT_SESSIONS}-split: heap +${split.heap.usedMB - empty.heap.usedMB}MB rss +${(split.rss ?? 0) - (empty.rss ?? 0)}MB`);
}
process.exit(0);
