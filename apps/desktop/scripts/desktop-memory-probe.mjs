// Renderer memory probe: boots the desktop app against the LIVE daemon in an
// isolated profile and measures JS heap + DOM counters + process RSS for
// three layouts — empty workspace, one (heaviest/latest) session, and a
// four-session split. Attribution for the renderer-memory reduction round.
//
// Run: node scripts/desktop-memory-probe.mjs [--sessions=4]
import { execFile, spawn } from 'node:child_process';
import { mkdir, rm } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

import { CdpClient, evaluateStable as evaluateRendererStable, stopApp, waitForTarget } from './cdp-client.mjs';
import { optionValue } from './cli-args.mjs';

const execFileAsync = promisify(execFile);
const desktopDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
// Stale MIXDOG_* overrides from the launching shell (perf-harness leftovers)
// would point both this reader AND the probe app at dead roots.
for (const key of Object.keys(process.env)) {
  if (key.startsWith('MIXDOG_')) delete process.env[key];
}
const electron = join(
  desktopDir,
  'node_modules',
  'electron',
  'dist',
  process.platform === 'win32' ? 'electron.exe' : 'electron'
);
const profileRoot = join(desktopDir, 'artifacts', 'memory-probe-profiles');
const SPLIT_SESSIONS = Math.max(2, Number(optionValue('sessions') || 4));

// Session ids come straight from the shared store (renderer listSessions is
// project-scoped and empty on a fresh profile): newest first.
async function recentSessionIds(limit) {
  const readerPath = join(
    desktopDir,
    '..',
    '..',
    'src',
    'runtime',
    'agent',
    'orchestrator',
    'session',
    'store-summary-reader.mjs'
  );
  const reader = await import(pathToFileURL(readerPath).href);
  const rows = (await reader.listStoredSessionSummaries?.()) || [];
  return (
    rows
      // Lead conversations only (agent==='lead' / user-owned): worker sessions
      // are rejected by the pane layout and would reset the seeded split.
      .filter(
        (row) =>
          row?.id &&
          row.closed !== true &&
          (row.agent === 'lead' || (!row.agent && (row.owner === 'user' || row.owner === 'cli')))
      )
      // Heaviest transcripts first: storageSize is the honest cost proxy.
      .sort((a, b) => (Number(b.storageSize) || 0) - (Number(a.storageSize) || 0))
      .slice(0, limit)
      .map((row) => String(row.id))
  );
}

/** This probe's own evaluation budget; a memory snapshot takes longer to
 *  settle than a boot phase. */
const evaluateStable = (client, expression, timeoutMs = 30_000) =>
  evaluateRendererStable(client, expression, timeoutMs);

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
  // A missing electron binary arrives as an 'error' event rather than an exit,
  // so without this listener it crashes the probe outright. And if the
  // handshake fails, the spawned app must not survive: it would keep this
  // isolated profile's daemon and store alive as orphans.
  const spawnFailed = new Promise((_resolve, reject) => {
    child.once('error', (error) => reject(new Error(`Failed to launch Electron (${electron}): ${error.message}`)));
  });
  try {
    const client = new CdpClient(await Promise.race([waitForTarget(port, child, { pollMs: 100 }), spawnFailed]));
    await client.connect();
    return { child, client };
  } catch (error) {
    child.kill();
    throw error;
  }
}

async function rendererRssMb(mainPid) {
  if (process.platform !== 'win32') return null;
  try {
    const { stdout } = await execFileAsync('powershell', [
      '-NoProfile',
      '-Command',
      `Get-CimInstance Win32_Process -Filter "ParentProcessId=${mainPid}" | ` +
        `Where-Object { $_.CommandLine -match '--type=renderer' } | ` +
        `ForEach-Object { (Get-Process -Id $_.ProcessId -ErrorAction SilentlyContinue).WorkingSet64 }`,
    ]);
    const values = stdout
      .trim()
      .split(/\r?\n/)
      .map(Number)
      .filter((value) => value > 0);
    if (!values.length) return null;
    return Math.round(Math.max(...values) / (1024 * 1024));
  } catch {
    return null;
  }
}

async function seedLayout(profilePath, port, kind, sessionIds = []) {
  const { child, client } = await launch(profilePath, port);
  try {
    const seeded = await evaluateStable(
      client,
      `(async () => {
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
      const persistSeed = () => {
        localStorage.setItem("mixdog.desktop.pane-layout.v1", JSON.stringify({
          layout, focusedLeafId: kind === "empty" ? "probe-pane" : (kind === "one" ? "probe-pane" : "probe-0"),
        }));
        localStorage.setItem("mixdog.desktop-sidebar-open.v1", "false");
        localStorage.removeItem("mixdog.desktop-last-session.v1");
      };
      persistSeed();
      window.addEventListener("pagehide", persistSeed, { once: true });
      return {
        sessions: ids.length,
        ids: kind === "empty" ? [] : ids.slice(0, kind === "one" ? 1 : ${SPLIT_SESSIONS}),
        first: ids[0] || null,
        timeOrigin: performance.timeOrigin,
      };
    })()`
    );
    try {
      await client.evaluate('window.location.reload(); true');
    } catch {
      /* context swaps below */
    }
    const restored = await evaluateStable(
      client,
      `(async () => {
      const previousTimeOrigin = ${JSON.stringify(seeded?.timeOrigin || 0)};
      const expectedIds = ${JSON.stringify(seeded?.ids || [])};
      const layoutReady = () => {
        const expectedKind = ${JSON.stringify(kind)};
        const persisted = JSON.parse(localStorage.getItem("mixdog.desktop.pane-layout.v1") || "null");
        const active = persisted?.layout?.activeKey || persisted?.layout?.type || null;
        if (expectedKind === "empty") {
          return Boolean(document.querySelector('.transcript[data-session-key="new-task"]'));
        }
        if (expectedKind === "one" && active !== "session:" + expectedIds[0]) {
          document.querySelector(
            '#recent-session-list [data-session-id="' + CSS.escape(expectedIds[0] || "") + '"]',
          )?.click();
          return false;
        }
        if (expectedKind === "split" && active !== "split") return false;
        return expectedIds.every((id) => {
          const transcript = document.querySelector(
            '.transcript[data-session-key="' + CSS.escape(id) + '"]',
          );
          if (expectedKind === "split") return Boolean(transcript);
          const rect = transcript?.getBoundingClientRect();
          return Boolean(rect && rect.width > 100 && rect.height > 100);
        });
      };
      const startupDeadline = performance.now() + 20_000;
      while ((performance.timeOrigin === previousTimeOrigin
        || !window.__mixdogStartupSettled
        || !layoutReady())
        && performance.now() < startupDeadline) {
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      if (performance.timeOrigin === previousTimeOrigin || !window.__mixdogStartupSettled
        || !layoutReady()) {
        throw new Error("Seeded memory layout did not restore after reload.");
      }
      await new Promise((resolve) => setTimeout(resolve, 250));
      const sessionRows = await window.mixdogDesktop.listSessions().catch(() => []);
      const expectedSessionId = ${JSON.stringify(seeded?.first || '')};
      const persisted = JSON.parse(localStorage.getItem("mixdog.desktop.pane-layout.v1") || "null");
      return {
        active: persisted?.layout?.activeKey || persisted?.layout?.type || null,
        leafCount: document.querySelectorAll("[data-pane-id]").length,
        catalogCount: sessionRows.length,
        expectedSession: expectedSessionId
          ? sessionRows.some((row) => row?.id === expectedSessionId)
          : null,
      };
    })()`,
      30_000
    );
    console.log(
      `[seed:${kind}] sessions=${seeded?.sessions} first=${seeded?.first}` +
        ` active=${restored?.active} leaves=${restored?.leafCount}` +
        ` catalog=${restored?.catalogCount} expected=${restored?.expectedSession}`
    );
  } finally {
    await stopApp(client, child);
  }
}

async function measure(profilePath, port, label) {
  const { child, client } = await launch(profilePath, port);
  try {
    // Let the layout restore, transcripts hydrate, and the heap settle.
    await evaluateStable(
      client,
      `(async () => {
      const startupDeadline = performance.now() + 20_000;
      while (!window.__mixdogStartupSettled && performance.now() < startupDeadline) {
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      await new Promise((resolve) => setTimeout(resolve, 8_000));
      return true;
    })()`,
      40_000
    );
    await client.request('HeapProfiler.collectGarbage', {}, 10_000).catch(() => null);
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
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
    console.log(
      `[${label}] jsHeap=${heap.usedMB}/${heap.totalMB}MB domNodes=${heap.domNodes}` +
        ` cdpNodes=${counters?.nodes ?? 'n/a'} listeners=${counters?.jsEventListeners ?? 'n/a'}` +
        ` rendererRss=${rss ?? 'n/a'}MB layout=${heap.activeLayout ?? 'n/a'}`
    );
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
  console.log(
    `delta one-session: heap +${one.heap.usedMB - empty.heap.usedMB}MB rss +${(one.rss ?? 0) - (empty.rss ?? 0)}MB`
  );
  console.log(
    `delta ${SPLIT_SESSIONS}-split: heap +${split.heap.usedMB - empty.heap.usedMB}MB rss +${(split.rss ?? 0) - (empty.rss ?? 0)}MB`
  );
}
process.exit(0);
