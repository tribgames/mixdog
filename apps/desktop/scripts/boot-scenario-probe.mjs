import { spawn } from 'node:child_process';
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const desktopDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const projectArgument = process.argv.find((argument) => argument.startsWith('--project='));
const projectPath = resolve(projectArgument?.slice('--project='.length) || join(desktopDir, '..', '..'));
const relPath = process.argv.find((argument) => argument.startsWith('--file='))
  ?.slice('--file='.length) || 'apps/desktop/package.json';
const iterations = Math.max(1, Number(
  process.argv.find((argument) => argument.startsWith('--iterations='))
    ?.slice('--iterations='.length) || 2,
));
const electron = join(
  desktopDir,
  'node_modules',
  'electron',
  'dist',
  process.platform === 'win32' ? 'electron.exe' : 'electron',
);
const artifactDir = join(desktopDir, 'artifacts');
const profileRoot = join(artifactDir, 'boot-scenario-profiles');
const stamp = new Date().toISOString().replace(/[-:.]/g, '').replace('Z', 'Z');
const reportPath = join(artifactDir, `boot-scenarios-${stamp}.json`);

class CdpClient {
  constructor(url) {
    this.socket = new WebSocket(url);
    this.nextId = 1;
    this.pending = new Map();
    this.listeners = new Map();
  }
  /** Subscribe to a CDP event (`Tracing.dataCollected` …); returns unsubscribe. */
  on(method, listener) {
    const set = this.listeners.get(method) || new Set();
    set.add(listener);
    this.listeners.set(method, set);
    return () => { set.delete(listener); };
  }
  async connect() {
    this.socket.addEventListener('message', (event) => {
      const message = JSON.parse(String(event.data));
      if (!message.id) {
        if (message.method) {
          for (const listener of this.listeners.get(message.method) || []) listener(message.params);
        }
        return;
      }
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      clearTimeout(pending.timer);
      if (message.error) pending.reject(new Error(message.error.message));
      else pending.resolve(message.result);
    });
    await new Promise((resolvePromise, reject) => {
      const timer = setTimeout(() => reject(new Error('CDP connection timed out.')), 15_000);
      this.socket.addEventListener('open', () => {
        clearTimeout(timer);
        resolvePromise();
      }, { once: true });
      this.socket.addEventListener('error', () => {
        clearTimeout(timer);
        reject(new Error('CDP websocket failed.'));
      }, { once: true });
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
      expression,
      awaitPromise: true,
      returnByValue: true,
    }, timeoutMs);
    if (response.exceptionDetails) {
      throw new Error(response.exceptionDetails.exception?.description || response.exceptionDetails.text);
    }
    return response.result?.value;
  }
  close() {
    this.socket.close();
  }
}

const navigationKey = (selection) => {
  if (selection.kind === 'new') return `new:${selection.draftId || 'default'}`;
  if (selection.kind === 'project') return `project:${selection.path}`;
  if (selection.kind === 'file') return `file:${selection.project}:${selection.rel}`;
  if (selection.kind === 'studio') return `studio:${selection.id}`;
  if (selection.kind === 'terminal') return `terminal:${selection.id}`;
  if (selection.kind === 'diff') {
    return `diff:${selection.project}:${selection.source}:${selection.hash || ''}:${selection.rel}`;
  }
  return `session:${selection.id}`;
};
const leaf = (id, selection) => ({
  type: 'leaf',
  id,
  tabs: [selection],
  activeKey: navigationKey(selection),
});
const newSelection = { kind: 'new' };
const projectSelection = { kind: 'project', path: projectPath };
const editorSelection = { kind: 'file', project: projectPath, rel: relPath };
const studioSelection = { kind: 'studio', id: 'boot-studio' };
const terminalSelection = { kind: 'terminal', id: 'boot-terminal', cwd: projectPath };
const diffSelection = {
  kind: 'diff',
  project: projectPath,
  rel: relPath,
  source: 'unstaged',
};

const allScenarios = [
  { name: 'fresh-new', selection: newSelection, fresh: true },
  { name: 'first-submit', selection: newSelection, fresh: true, measureSubmit: true },
  // Menu entry in a WARM app (user: 메뉴 진입 반응성): after the boot warm-up
  // lane drains, click every rail destination, the pane dock toggles and the
  // settings gear, timing click → visible paint → first usable control.
  { name: 'menus', selection: newSelection, fresh: true, measureMenus: true },
  // Same entries against a REAL project: the pane-dock toggles (terminal,
  // explorer, source control) mount trees, git state and a pty on first
  // selection, which a project-less draft never exercises.
  {
    name: 'menus-session',
    selection: { kind: 'session', id: '__FIRST_SESSION__' },
    measureMenus: true,
  },
  { name: 'project', selection: projectSelection },
  {
    name: 'session',
    selection: { kind: 'session', id: '__FIRST_SESSION__' },
    expectedSurface: 'conversation',
  },
  { name: 'editor', selection: editorSelection, expectedSurface: 'editor' },
  { name: 'studio', selection: studioSelection, expectedSurface: 'studio' },
  { name: 'terminal', selection: terminalSelection, expectedSurface: 'terminal' },
  { name: 'diff', selection: diffSelection, expectedSurface: 'diff' },
  {
    name: 'mixed-split',
    expectedSurface: 'editor',
    layout: {
      type: 'split',
      direction: 'row',
      ratio: 0.5,
      first: leaf('mixed-editor', editorSelection),
      second: {
        type: 'split',
        direction: 'column',
        ratio: 0.5,
        first: leaf('mixed-studio', studioSelection),
        second: leaf('mixed-terminal', terminalSelection),
      },
    },
    focusedLeafId: 'mixed-editor',
  },
  { name: 'session-sidebar', selection: newSelection, sideView: 'sessions', expectedSurface: 'session-sidebar' },
  ...['agents', 'search'].map((sideView) => ({
    name: `sidebar-${sideView}`,
    selection: projectSelection,
    sideView,
    expectedSurface: 'sidebar',
  })),
  ...['source-control', 'pull-requests'].map((view) => ({
    name: `dock-${view}`,
    selection: projectSelection,
    dock: { open: true, view, surface: '', diff: null },
    expectedSurface: 'dock',
  })),
  // A session (paused Goal capsule docked to the DIFF) with the pane dock
  // showing a diff: the composer keystroke here shares the pane with the
  // diff rows and the Goal island (user: diff창/goal창 있는 상태에서 덜컹).
  {
    name: 'dock-diff-session',
    selection: { kind: 'session', id: '__FIRST_SESSION__' },
    dock: { open: true, view: 'source-control', surface: 'diff', diff: diffSelection },
    expectedSurface: 'conversation',
    typingBurst: true,
  },
  ...['terminal', 'problems'].map((tab) => ({
    name: `bottom-${tab}`,
    selection: editorSelection,
    bottom: { open: true, tab, height: 240 },
    expectedSurface: 'bottom-panel',
  })),
];
const scenarioFilter = process.argv.find((argument) => argument.startsWith('--scenario='))
  ?.slice('--scenario='.length);
const scenarios = scenarioFilter
  ? allScenarios.filter((scenario) => scenario.name === scenarioFilter)
  : allScenarios;
if (scenarios.length === 0) throw new Error(`Unknown boot scenario: ${scenarioFilter}`);
const DEFAULT_PERFORMANCE_BUDGET = Object.freeze({
  shellMs: 1_200,
  dataMs: 3_000,
  interactionMs: 3_000,
  keypaintMs: 100,
  // Warm-app menu entry: click → usable panel (user: 메뉴 진입 반응성).
  menuMs: 250,
});
const scenarioPerformanceBudgets = Object.freeze({
  terminal: { dataMs: 5_500, interactionMs: 5_500 },
  'dock-source-control': { dataMs: 5_500 },
  'dock-pull-requests': { dataMs: 5_500 },
  'first-submit': { submitMs: 2_000 },
});

function performanceFailures(result) {
  const budget = {
    ...DEFAULT_PERFORMANCE_BUDGET,
    ...(scenarioPerformanceBudgets[result.scenario] || {}),
  };
  const failures = [];
  const checks = [
    ['shell', result.interaction?.shellReadyAtMs, budget.shellMs],
    ['data', result.interaction?.dataReadyAtMs, budget.dataMs],
    ['interaction', result.interaction?.measuredAtMs, budget.interactionMs],
    ['keypaint', result.interaction?.keystrokePaintMs, budget.keypaintMs],
    ['submit', result.firstSubmit?.acceptanceMs, budget.submitMs],
  ];
  for (const [name, value, maximum] of checks) {
    if (maximum !== undefined && value !== null && value !== undefined && value > maximum) {
      failures.push(`${name}=${value.toFixed(1)}ms>${maximum}ms`);
    }
  }
  if (['editor', 'studio', 'terminal'].includes(result.scenario)
    && result.interaction?.activeControlCount === 0) {
    failures.push('surface-control=missing');
  }
  for (const entry of result.menus || []) {
    if (entry.skipped) continue;
    const value = entry.interactiveMs ?? entry.visibleMs;
    if (value === null || value === undefined) failures.push(`menu:${entry.label}=missing`);
    else if (value > budget.menuMs) failures.push(`menu:${entry.label}=${value.toFixed(1)}ms>${budget.menuMs}ms`);
  }
  return failures;
}

async function waitForTarget(port, child) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`Electron exited with ${child.exitCode}.`);
    try {
      const targets = await fetch(`http://127.0.0.1:${port}/json/list`).then((response) => response.json());
      const target = targets.find((candidate) =>
        candidate.type === 'page'
        && candidate.url?.includes('/out/renderer/index.html'));
      if (target?.webSocketDebuggerUrl) return target.webSocketDebuggerUrl;
    } catch {
      // CDP is not listening yet.
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 50));
  }
  throw new Error(`CDP target did not appear on port ${port}.`);
}

async function evaluateStable(client, expression, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      return await client.evaluate(expression, Math.max(1_000, deadline - Date.now()));
    } catch (error) {
      lastError = error;
      if (!/Execution context was destroyed|Cannot find context|Failed to read the 'localStorage' property/i
        .test(String(error?.message || error))) {
        throw error;
      }
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
    }
  }
  throw lastError || new Error('Renderer execution context did not stabilize.');
}

async function stopIsolatedDaemon(profilePath) {
  try {
    const raw = JSON.parse(await readFile(join(profilePath, 'runtime', 'daemon.json'), 'utf8'));
    const session = raw?.endpoints?.session;
    if (!raw?.pid || !session?.port || !session?.token) return;
    const { shutdownDaemon } = await import('../../../src/standalone/session-client.mjs');
    await shutdownDaemon({
      pid: raw.pid,
      port: session.port,
      token: session.token,
    }, {
      waitForExit: true,
      timeoutMs: 5_000,
    });
  } catch {
    // The Desktop process tree may already have taken its daemon down.
  }
}

// initdb/postgres that outlived the daemon (the app quit mid-initdb, so no
// postmaster.pid ever existed) hold their executable open under the profile;
// the profile rm then never completes. Only processes whose command line
// names this profile are touched, never the installed app's PostgreSQL.
async function killLingeringPgProcesses(profilePath) {
  const { execFile } = await import('node:child_process');
  const run = (file, args) => new Promise((resolvePromise) => {
    execFile(file, args, { windowsHide: true }, (error, stdout) => resolvePromise(error ? '' : String(stdout)));
  });
  const output = process.platform === 'win32'
    ? await run('powershell', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command',
      `Get-CimInstance Win32_Process -Filter "Name='initdb.exe' or Name='postgres.exe'"`
      + ` | Where-Object { $_.CommandLine -and $_.CommandLine.Contains('${profilePath.replaceAll("'", "''")}') }`
      + ' | ForEach-Object { $_.ProcessId }'])
    : await run('pgrep', ['-f', `(initdb|postgres).*${profilePath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`]);
  for (const line of output.split(/\r?\n/)) {
    const pid = Number.parseInt(line.trim(), 10);
    if (!Number.isInteger(pid) || pid <= 0) continue;
    try { process.kill(pid, 'SIGKILL'); } catch { /* already gone */ }
  }
}

// Where the probe window actually sits on the desktop: frontmost or not, and
// how many of five sample points (centre + quadrants) belong to another
// process's window. Chromium in Electron does not track native occlusion, so
// document.visibilityState stays "visible" behind the user's app while DWM
// throttles the window's presents; only Win32 can tell the two apart.
async function windowPlacement(pid) {
  if (process.platform !== 'win32') return null;
  const { execFile } = await import('node:child_process');
  const script = `
$code = @"
using System; using System.Runtime.InteropServices;
public static class ProbeWin {
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L, T, R, B; }
  [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X, Y; public POINT(int x, int y) { X = x; Y = y; } }
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern IntPtr WindowFromPoint(POINT p);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
}
"@
Add-Type -TypeDefinition $code -ErrorAction Stop
$proc = Get-Process -Id ${pid} -ErrorAction Stop
$h = $proc.MainWindowHandle
if ($h -eq [IntPtr]::Zero) { '{"window":false}'; exit 0 }
$r = New-Object ProbeWin+RECT
[void][ProbeWin]::GetWindowRect($h, [ref]$r)
$fg = [ProbeWin]::GetForegroundWindow()
$points = @(
  @(($r.L + $r.R) / 2, ($r.T + $r.B) / 2),
  @($r.L + 40, $r.T + 40), @($r.R - 40, $r.T + 40),
  @($r.L + 40, $r.B - 40), @($r.R - 40, $r.B - 40))
$covered = 0
foreach ($p in $points) {
  $owner = [ProbeWin]::WindowFromPoint((New-Object ProbeWin+POINT([int]$p[0], [int]$p[1])))
  $ownerPid = [uint32]0
  [void][ProbeWin]::GetWindowThreadProcessId($owner, [ref]$ownerPid)
  if ($ownerPid -ne ${pid}) { $covered++ }
}
@{ window = $true; foreground = ($fg -eq $h); minimized = [ProbeWin]::IsIconic($h)
   coveredPoints = $covered; rect = @($r.L, $r.T, $r.R, $r.B) } | ConvertTo-Json -Compress
`;
  return new Promise((resolvePromise) => {
    execFile('powershell', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script],
      { windowsHide: true, timeout: 15_000 }, (error, stdout) => {
        if (error) return resolvePromise({ error: String(error.message || error).split('\n')[0] });
        try { resolvePromise(JSON.parse(String(stdout).trim())); } catch { resolvePromise({ error: String(stdout).trim() }); }
      });
  });
}

async function stopIsolatedMemoryStore(profilePath) {
  await stopProfilePostmaster(profilePath);
  await killLingeringPgProcesses(profilePath);
}

async function stopProfilePostmaster(profilePath) {
  try {
    const dataPath = join(profilePath, 'data');
    const postmasterPid = Number.parseInt(
      (await readFile(join(dataPath, 'pgdata', 'postmaster.pid'), 'utf8')).split(/\r?\n/, 1)[0],
      10,
    );
    if (!Number.isInteger(postmasterPid) || postmasterPid <= 0) return;
    try {
      process.kill(postmasterPid, 0);
    } catch {
      return;
    }
    const runtimeRoot = join(dataPath, 'runtime');
    const entries = await readdir(runtimeRoot, { withFileTypes: true });
    const runtime = entries.find((entry) =>
      entry.isDirectory() && entry.name.startsWith('runtime-pg'));
    if (!runtime) return;
    const { stopPg } = await import('../../../src/runtime/memory/lib/pg/process.mjs');
    await stopPg({
      runtimeDir: join(runtimeRoot, runtime.name),
      pgdataDir: join(dataPath, 'pgdata'),
    });
  } catch (reason) {
    // A scenario that never touched memory has no PostgreSQL runtime to stop.
    if (reason?.code === 'ENOENT') return;
    throw reason;
  }
}

async function stopApp(client, child, profilePath) {
  try {
    await client.evaluate('window.mixdogDesktop?.quit?.()', 5_000);
  } catch {
    // Process termination below is the bounded fallback.
  }
  client.close();
  await Promise.race([
    new Promise((resolvePromise) => child.once('exit', resolvePromise)),
    new Promise((resolvePromise) => setTimeout(resolvePromise, 4_000)),
  ]);
  if (child.exitCode === null) child.kill();
  await stopIsolatedDaemon(profilePath);
  await stopIsolatedMemoryStore(profilePath);
}

async function launch(profilePath, scenarioName, port) {
  await Promise.all([
    mkdir(join(profilePath, 'runtime'), { recursive: true }),
    mkdir(join(profilePath, 'data'), { recursive: true }),
    mkdir(join(profilePath, 'home'), { recursive: true }),
  ]);
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key.startsWith('MIXDOG_') || key.startsWith('ELECTRON_')) delete env[key];
  }
  env.MIXDOG_DESKTOP_USER_DATA = profilePath;
  env.MIXDOG_RUNTIME_ROOT = join(profilePath, 'runtime');
  env.MIXDOG_DATA_DIR = join(profilePath, 'data');
  env.MIXDOG_HOME = join(profilePath, 'home');
  env.MIXDOG_DESKTOP_PERF = '1';
  env.MIXDOG_BOOT_SCENARIO = scenarioName;
  const child = spawn(electron, [desktopDir, `--remote-debugging-port=${port}`, ...extraElectronArgs], {
    cwd: desktopDir,
    env,
    stdio: 'ignore',
    windowsHide: false,
  });
  const client = new CdpClient(await waitForTarget(port, child));
  await client.connect();
  return { child, client };
}

async function seedScenario(profilePath, scenario, port) {
  const { child, client } = await launch(profilePath, `seed-${scenario.name}`, port);
  try {
    const seed = JSON.stringify(scenario);
    const seeded = await evaluateStable(client, `(async () => {
      const scenario = ${seed};
      const startupDeadline = performance.now() + 10_000;
      while (!window.__mixdogStartupSettled && performance.now() < startupDeadline) {
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      if (!window.__mixdogStartupSettled) {
        throw new Error("Seed renderer did not settle before persistence.");
      }
      await window.mixdogDesktop.addProject(${JSON.stringify(projectPath)});
      // A seeded profile stands for an EXISTING install: first-run setup is
      // done, so the measured boot never carries the wizard's own mount and
      // provider reads (fresh-* scenarios keep the first-run path).
      await window.mixdogDesktop.invokeCapability({ capability: "skipOnboarding", args: [] })
        .catch(() => undefined);
      let selection = scenario.selection || { kind: "new" };
      if (selection.id === "__FIRST_SESSION__") {
        let rows = await window.mixdogDesktop.listSessions().catch(() => []);
        if (!rows[0]?.id) {
          const fixture = await window.mixdogDesktop.submitNewTask(
            "Boot scenario fixture",
            {
              id: "boot-scenario-fixture",
              displayText: "Boot scenario fixture",
              goalCommand: "Boot scenario fixture",
            },
          );
          await window.mixdogDesktop.invokeCapability({
            capability: "goalControl",
            args: [{ command: "pause" }],
            sessionId: fixture.sessionId,
          });
          rows = await window.mixdogDesktop.listSessions().catch(() => []);
        }
        selection = rows[0]?.id ? { kind: "session", id: rows[0].id } : { kind: "new" };
      }
      const navigationKey = (entry) => {
        if (entry.kind === "new") return "new:" + (entry.draftId || "default");
        if (entry.kind === "project") return "project:" + entry.path;
        if (entry.kind === "file") return "file:" + entry.project + ":" + entry.rel;
        if (entry.kind === "studio") return "studio:" + entry.id;
        if (entry.kind === "terminal") return "terminal:" + entry.id;
        if (entry.kind === "diff") {
          return "diff:" + entry.project + ":" + entry.source + ":" + (entry.hash || "") + ":" + entry.rel;
        }
        return "session:" + entry.id;
      };
      const layout = scenario.layout || {
        type: "leaf",
        id: "boot-pane",
        tabs: [selection],
        activeKey: navigationKey(selection),
      };
      const paneState = JSON.stringify({
        layout,
        focusedLeafId: scenario.focusedLeafId || "boot-pane",
      });
      const persistSeed = () => {
        const focusedLeafId = scenario.focusedLeafId || "boot-pane";
        const defaultLeftViews = [
          "agents", "sessions", "schedules", "studio", "workflows",
          "search", "extensions", "projects", "webhooks",
        ];
        const preferredLeftView = scenario.sideView || "";
        const leftViews = preferredLeftView
          ? [preferredLeftView, ...defaultLeftViews.filter((id) => id !== preferredLeftView)]
          : defaultLeftViews;
        localStorage.setItem("mixdog.desktop.pane-layout.v1", paneState);
        localStorage.setItem("mixdog.desktop-sidebar-open.v1", String(Boolean(preferredLeftView)));
        localStorage.setItem(
          "mixdog.desktop.workbench-side-view-layout.pane-bound-right.v1",
          "1",
        );
        localStorage.setItem(
          "mixdog.desktop.workbench-side-view-layout.v1",
          JSON.stringify({
            left: leftViews.map((id) => [id]),
            right: [["source-control"], ["browser"], ["terminal"], ["pull-requests"]],
          }),
        );
        localStorage.setItem("mixdog.desktop-utility-dock.v1", JSON.stringify(
          { open: false, width: 380 }
        ));
        localStorage.setItem("mixdog.desktop.pane-side-dock.v1", JSON.stringify(
          scenario.dock ? { [focusedLeafId]: scenario.dock } : {}
        ));
        localStorage.setItem("mixdog.desktop.bottom-panel.v1", JSON.stringify(
          scenario.bottom || { open: false, tab: "terminal", height: 240 }
        ));
        if (selection.kind === "session") {
          localStorage.setItem("mixdog.desktop-last-session.v1", selection.id);
        } else {
          localStorage.removeItem("mixdog.desktop-last-session.v1");
        }
      };
      persistSeed();
      window.addEventListener("pagehide", persistSeed, { once: true });
      if (localStorage.getItem("mixdog.desktop.pane-layout.v1") !== paneState) {
        throw new Error("Seed pane layout did not persist.");
      }
      return { selection, layout, timeOrigin: performance.timeOrigin };
    })()`);
    try { await client.evaluate('window.location.reload(); true'); } catch { /* context swaps below */ }
    await evaluateStable(client, `(async () => {
      const previousTimeOrigin = ${JSON.stringify(seeded?.timeOrigin || 0)};
      const startupDeadline = performance.now() + 20_000;
      while ((performance.timeOrigin === previousTimeOrigin || !window.__mixdogStartupSettled)
        && performance.now() < startupDeadline) {
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      if (performance.timeOrigin === previousTimeOrigin || !window.__mixdogStartupSettled) {
        throw new Error("Seeded boot scenario did not restore after reload.");
      }
      return true;
    })()`, 30_000);
  } finally {
    await stopApp(client, child, profilePath);
  }
}

async function readBootDiagnostics(profilePath, bootId) {
  try {
    return (await readFile(join(profilePath, 'logs', 'desktop-diagnostics.jsonl'), 'utf8'))
      .trim()
      .split(/\r?\n/)
      .map((line) => JSON.parse(line))
      .filter((entry) => entry.bootId === bootId);
  } catch {
    return [];
  }
}

// --profile: sample the renderer's CPU for the whole measurement and report
// the hottest self-time frames, so a slow keystroke paint names its cause.
const profileRequested = process.argv.includes('--profile');
// --trace: record the renderer's timeline (style, layout, paint, tasks) and
// report what filled the keystroke→paint window. A CPU profile only sees
// JavaScript; a keystroke whose script ran 1ms yet painted 60ms late spent
// the rest in the rendering pipeline, which only the trace can name.
const traceRequested = process.argv.includes('--trace');
// --trace-dump=<dir>: also write each measurement's raw trace as
// <dir>/<scenario>-<temperature>.json, loadable in chrome://tracing or Perfetto.
const traceDumpDir = process.argv.find((argument) => argument.startsWith('--trace-dump='))
  ?.slice('--trace-dump='.length) || '';
// Frame, compositor and GPU categories name the wait when the main thread is
// idle inside the window: a keystroke whose paint committed at +3ms but whose
// next frame arrived at +36ms lost the difference in raster or the GPU.
const TRACE_CATEGORIES = [
  'devtools.timeline',
  'disabled-by-default-devtools.timeline',
  'disabled-by-default-devtools.timeline.frame',
  // Names the node and reason behind every paint invalidation, so a
  // keystroke that repaints the whole window says which ancestor did it.
  'disabled-by-default-devtools.timeline.invalidationTracking',
  'disabled-by-default-blink.invalidation',
  'blink.user_timing',
  'cc',
  'gpu',
  'viz',
].join(',');
const FRAME_EVENTS = new Set(['BeginMainThreadFrame', 'DrawFrame', 'Commit', 'ActivateLayerTree']);
const KEYSTROKE_MARK = 'mixdog-probe-keystroke';
const KEYPAINT_MARK = 'mixdog-probe-keypaint';
// Steady-state typing burst (scenario.typingBurst): after the surfaces settle,
// TYPING_BURST_TEXT is typed one character per committed frame. The trace
// window then spans the slowest keystroke of the burst, so a repaint or
// relayout that only a loaded diff/Goal pane provokes gets named.
const BURST_KEY_MARK = 'mixdog-probe-burst-keystroke';
const BURST_PAINT_MARK = 'mixdog-probe-burst-keypaint';
const TYPING_BURST_TEXT = 'The quick brown fox jumps over the lazy dog 0123456789 다람쥐 헌 쳇바퀴에 타고파';
// --inject-css=<rules>: A/B a style hypothesis without rebuilding, e.g.
// `.onboarding-layer{backdrop-filter:none!important}` to price a blur.
// Rules need !important: the sheet lands before the app's own stylesheets.
const injectCss = process.argv.find((argument) => argument.startsWith('--inject-css='))
  ?.slice('--inject-css='.length) || '';

// --electron-args=<a,b>: extra Chromium switches for the probe's Electron
// (e.g. disable-gpu-rasterization, disable-gpu) to bisect a GPU-side stall.
const extraElectronArgs = (process.argv.find((argument) => argument.startsWith('--electron-args='))
  ?.slice('--electron-args='.length) || '')
  .split(',').map((flag) => flag.trim()).filter(Boolean)
  .map((flag) => (flag.startsWith('--') ? flag : `--${flag}`));

async function injectStyle(client) {
  if (!injectCss) return;
  await evaluateStable(client, `(() => {
    // Before the app document exists the sheet would land in about:blank and
    // vanish with the navigation; retry until the shell is in place.
    if (!document.head || !document.body) throw new Error("Execution context was destroyed: no document yet");
    const style = document.createElement("style");
    style.setAttribute("data-mixdog-probe", "inject-css");
    style.textContent = ${JSON.stringify(injectCss)};
    (document.head || document.documentElement).appendChild(style);
    return true;
  })()`, 10_000);
}

async function startTrace(client) {
  const events = [];
  const stop = client.on('Tracing.dataCollected', (params) => {
    if (Array.isArray(params?.value)) events.push(...params.value);
  });
  await client.request('Tracing.start', {
    categories: TRACE_CATEGORIES,
    transferMode: 'ReportEvents',
    options: 'record-continuously',
  });
  return async () => {
    const complete = new Promise((resolvePromise) => {
      const off = client.on('Tracing.tracingComplete', () => { off(); resolvePromise(); });
    });
    await client.request('Tracing.end');
    await Promise.race([complete, new Promise((resolvePromise) => setTimeout(resolvePromise, 15_000))]);
    stop();
    return events;
  };
}

function traceEventDetail(event) {
  const data = event.args?.data || {};
  switch (event.name) {
    case 'FunctionCall':
    case 'FireAnimationFrame':
    case 'TimerFire':
      return [data.functionName, data.url ? `${String(data.url).split('/').at(-1)}:${(data.lineNumber ?? 0) + 1}` : '',
        data.timerId !== undefined ? `timer#${data.timerId}` : ''].filter(Boolean).join(' ');
    case 'EventDispatch':
      return data.type || '';
    case 'Paint': {
      // clip is a quad [x0,y0, x1,y1, x2,y2, x3,y3]: its extent is the area
      // handed to raster, which is what the GPU then pays for.
      const clip = Array.isArray(data.clip) ? data.clip : null;
      if (!clip || clip.length < 8) return '';
      const xs = [clip[0], clip[2], clip[4], clip[6]];
      const ys = [clip[1], clip[3], clip[5], clip[7]];
      return `${Math.round(Math.max(...xs) - Math.min(...xs))}x${Math.round(Math.max(...ys) - Math.min(...ys))}`
        + (data.layerId !== undefined ? ` layer#${data.layerId}` : '');
    }
    case 'RasterTask':
      return data.tileData ? `layer#${data.tileData.layerId} ${data.tileData.tileResolution || ''}`.trim() : '';
    case 'Layout': {
      const begin = event.args?.beginData || {};
      return [begin.dirtyObjects !== undefined ? `dirty=${begin.dirtyObjects}` : '',
        begin.totalObjects !== undefined ? `total=${begin.totalObjects}` : ''].filter(Boolean).join(' ');
    }
    case 'UpdateLayoutTree':
      return data.elementCount !== undefined ? `elements=${data.elementCount}` : '';
    case 'RunTask':
      return '';
    default:
      return '';
  }
}

// The keystroke→paint window on the renderer's main thread: every complete
// event ('X') inside it, grouped by name, plus the longest individual ones.
function summarizeKeystrokeTrace(events, limit = 10, window = 'boot') {
  const marks = events.filter((event) => event.cat?.includes('blink.user_timing'));
  let keystroke = marks.find((event) => event.name === KEYSTROKE_MARK);
  let keypaint = marks.find((event) => event.name === KEYPAINT_MARK);
  if (window === 'burst') {
    // The burst marks every keystroke; its slowest one is the window the
    // user feels while typing into the settled surfaces.
    const burstKeystrokes = marks.filter((event) => event.name === BURST_KEY_MARK);
    const burstPaints = marks.filter((event) => event.name === BURST_PAINT_MARK);
    if (burstKeystrokes.length === 0 || burstKeystrokes.length !== burstPaints.length) return null;
    let slowest = 0;
    for (let index = 0; index < burstKeystrokes.length; index += 1) {
      const span = burstPaints[index].ts - burstKeystrokes[index].ts;
      if (span > burstPaints[slowest].ts - burstKeystrokes[slowest].ts) slowest = index;
    }
    keystroke = burstKeystrokes[slowest];
    keypaint = burstPaints[slowest];
  }
  if (!keystroke || !keypaint) return null;
  const startUs = keystroke.ts;
  const endUs = keypaint.ts;
  const threadKey = `${keystroke.pid}:${keystroke.tid}`;
  const processNames = new Map();
  const threadNames = new Map();
  for (const event of events) {
    if (event.ph !== 'M') continue;
    if (event.name === 'process_name') processNames.set(event.pid, event.args?.name || '');
    if (event.name === 'thread_name') threadNames.set(`${event.pid}:${event.tid}`, event.args?.name || '');
  }
  const overlaps = (event) => event.ts + (event.dur || 0) > startUs && event.ts < endUs;
  const clip = (event) => Math.min(event.ts + (event.dur || 0), endUs) - Math.max(event.ts, startUs);
  const inWindow = events.filter((event) =>
    event.ph === 'X' && `${event.pid}:${event.tid}` === threadKey
    && overlaps(event) && event.name !== 'RunTask');
  const byName = new Map();
  for (const event of inWindow) {
    byName.set(event.name, (byName.get(event.name) || 0) + clip(event));
  }
  // Frame lifecycle inside the window, in order: shows how many frames the
  // keystroke waited for and where the pipeline paused between them.
  const frameEvents = events
    .filter((event) => FRAME_EVENTS.has(event.name) && event.pid === keystroke.pid
      && event.ts >= startUs - 2_000 && event.ts <= endUs + 2_000 && ['I', 'X', 'i'].includes(event.ph))
    .sort((left, right) => left.ts - right.ts);
  const frames = frameEvents.map((event) => `${event.name} +${((event.ts - startUs) / 1_000).toFixed(1)}`);
  // The honest keystroke latency: when the renderer committed the typed
  // character and when the first frame after that commit was drawn. The
  // double-rAF `keystrokePaintMs` also waits out any impl-only frames the
  // compositor runs before scheduling the main thread again.
  const commit = frameEvents.find((event) => event.name === 'Commit' && event.ts > startUs);
  const draw = commit && frameEvents.find((event) => event.name === 'DrawFrame' && event.ts > commit.ts);
  const relativeMs = (event) => (event ? Number(((event.ts - startUs) / 1_000).toFixed(1)) : null);
  // Work off the renderer's main thread (compositor, raster, GPU process)
  // that overlapped the window, grouped by process/thread and event name.
  const offMain = new Map();
  for (const event of events) {
    if (event.ph !== 'X' || `${event.pid}:${event.tid}` === threadKey || !overlaps(event)) continue;
    if ((event.dur || 0) < 200 || event.name === 'RunTask' || event.name === 'ThreadControllerImpl::RunTask') continue;
    const key = `${processNames.get(event.pid) || event.pid}/${threadNames.get(`${event.pid}:${event.tid}`) || event.tid} ${event.name}`;
    offMain.set(key, (offMain.get(key) || 0) + clip(event));
  }
  // Every Paint inside the window with its raster extent: one keystroke that
  // repaints 2560x1400 costs the GPU a full-window raster.
  const paints = inWindow
    .filter((event) => event.name === 'Paint')
    .map((event) => `+${((event.ts - startUs) / 1_000).toFixed(1)} ${traceEventDetail(event)}`);
  const rasterTasks = events.filter((event) =>
    event.ph === 'X' && event.name === 'RasterTask' && event.pid === keystroke.pid && overlaps(event));
  const rasterMs = rasterTasks.reduce((total, event) => total + clip(event), 0) / 1_000;
  // Paint invalidations recorded between the keystroke and its paint, by
  // node and reason: the entries with the largest rects are what forced the
  // root layer to repaint far beyond the composer.
  const invalidations = new Map();
  for (const event of events) {
    if (event.name !== 'PaintInvalidationTracking' || `${event.pid}:${event.tid}` !== threadKey) continue;
    if (event.ts < startUs - 500 || event.ts > endUs) continue;
    const data = event.args?.data || {};
    const rect = Array.isArray(data.clientRect) ? data.clientRect : null;
    const area = rect ? Math.round((rect[2] || 0) * (rect[3] || 0)) : 0;
    const key = `${data.nodeName || '?'}${data.selectorPart ? ` ${data.selectorPart}` : ''} :: ${data.reason || '?'}`;
    const entry = invalidations.get(key) || { count: 0, maxArea: 0, rect: null };
    entry.count += 1;
    if (area > entry.maxArea) { entry.maxArea = area; entry.rect = rect?.map((value) => Math.round(value)); }
    invalidations.set(key, entry);
  }
  // Style invalidations in the same window: which selector/attribute change
  // made the recalc walk far beyond the composer.
  const styleInvalidations = new Map();
  for (const event of events) {
    if (!/^(StyleRecalcInvalidationTracking|StyleInvalidatorInvalidationTracking|ScheduleStyleInvalidationTracking)$/.test(event.name)) continue;
    if (`${event.pid}:${event.tid}` !== threadKey || event.ts < startUs - 500 || event.ts > endUs) continue;
    const data = event.args?.data || {};
    const key = `${event.name.replace('InvalidationTracking', '')} ${data.nodeName || '?'} :: ${data.reason || '?'}`
      + `${data.selectorPart ? ` ${data.selectorPart}` : ''}${data.extraData ? ` ${data.extraData}` : ''}`
      + `${data.changedAttribute ? ` [${data.changedAttribute}]` : ''}${data.changedClass ? ` .${data.changedClass}` : ''}`;
    styleInvalidations.set(key, (styleInvalidations.get(key) || 0) + 1);
  }
  const topStyleInvalidations = [...styleInvalidations.entries()]
    .sort((left, right) => right[1] - left[1])
    .slice(0, 12)
    .map(([key, count]) => `${key} x${count}`);
  const topInvalidations = [...invalidations.entries()]
    .sort((left, right) => right[1].maxArea - left[1].maxArea || right[1].count - left[1].count)
    .slice(0, 12)
    .map(([key, entry]) => `${key} x${entry.count}${entry.rect ? ` [${entry.rect.join(',')}]` : ''}`);
  const longest = [...inWindow]
    .sort((left, right) => (right.dur || 0) - (left.dur || 0))
    .slice(0, limit)
    .map((event) => ({
      name: event.name,
      atMs: Number(((event.ts - startUs) / 1_000).toFixed(1)),
      durationMs: Number(((event.dur || 0) / 1_000).toFixed(1)),
      detail: traceEventDetail(event),
    }));
  return {
    windowMs: Number(((endUs - startUs) / 1_000).toFixed(1)),
    byName: [...byName.entries()]
      .sort((left, right) => right[1] - left[1])
      .slice(0, limit)
      .map(([name, us]) => ({ name, totalMs: Number((us / 1_000).toFixed(1)) })),
    longest,
    frames,
    commitMs: relativeMs(commit),
    drawMs: relativeMs(draw),
    paints,
    raster: { tasks: rasterTasks.length, totalMs: Number(rasterMs.toFixed(1)) },
    invalidations: topInvalidations,
    styleInvalidations: topStyleInvalidations,
    offMain: [...offMain.entries()]
      .sort((left, right) => right[1] - left[1])
      .slice(0, limit)
      .map(([name, us]) => ({ name, totalMs: Number((us / 1_000).toFixed(1)) })),
  };
}

function summarizeProfile(profile, limit = 18) {
  const byNode = new Map(profile.nodes.map((node) => [node.id, node]));
  const selfSamples = new Map();
  for (const id of profile.samples) selfSamples.set(id, (selfSamples.get(id) || 0) + 1);
  const totalSamples = profile.samples.length || 1;
  const durationMs = (profile.endTime - profile.startTime) / 1_000;
  const byFrame = new Map();
  for (const [id, count] of selfSamples) {
    const node = byNode.get(id);
    const frame = node?.callFrame;
    if (!frame) continue;
    const url = String(frame.url || '').split('/').slice(-1)[0];
    const key = `${frame.functionName || '(anonymous)'} ${url}:${frame.lineNumber + 1}`;
    byFrame.set(key, (byFrame.get(key) || 0) + count);
  }
  return [...byFrame.entries()]
    .sort((left, right) => right[1] - left[1])
    .slice(0, limit)
    .map(([key, count]) => ({
      frame: key,
      selfMs: Number(((count / totalSamples) * durationMs).toFixed(1)),
    }));
}

function profileFrameKey(node) {
  const frame = node?.callFrame;
  if (!frame) return '(unknown)';
  const url = String(frame.url || '').split('/').slice(-1)[0];
  return `${frame.functionName || '(anonymous)'} ${url}:${frame.lineNumber + 1}`;
}

// Contiguous non-idle runs of the sampled main thread: a keystroke that
// paints 90ms late landed inside one of these, and the totals above cannot
// say which. `keystrokeAtMs` is on the profile clock (see measureScenario).
function busyStretches(profile, keystrokeAtMs, minMs = 30, limit = 6) {
  const byNode = new Map(profile.nodes.map((node) => [node.id, node]));
  const stretches = [];
  let current = null;
  let atUs = profile.startTime;
  for (let index = 0; index < profile.samples.length; index += 1) {
    atUs += profile.timeDeltas[index] || 0;
    const node = byNode.get(profile.samples[index]);
    const name = node?.callFrame?.functionName || '';
    const idle = name === '(idle)' || name === '(root)';
    if (idle) {
      if (current) { current.endUs = atUs; stretches.push(current); current = null; }
      continue;
    }
    if (!current) current = { startUs: atUs, endUs: atUs, frames: new Map() };
    const key = profileFrameKey(node);
    current.frames.set(key, (current.frames.get(key) || 0) + (profile.timeDeltas[index + 1] || 0));
  }
  if (current) { current.endUs = atUs; stretches.push(current); }
  return stretches
    .map((stretch) => ({
      atMs: Math.round((stretch.startUs - profile.startTime) / 1_000),
      durationMs: Math.round((stretch.endUs - stretch.startUs) / 1_000),
      keystroke: keystrokeAtMs !== null
        && keystrokeAtMs >= (stretch.startUs - profile.startTime) / 1_000 - 5
        && keystrokeAtMs <= (stretch.endUs - profile.startTime) / 1_000 + 5,
      frames: [...stretch.frames.entries()]
        .sort((left, right) => right[1] - left[1])
        .slice(0, 5)
        .map(([frame, us]) => `${frame} ${(us / 1_000).toFixed(1)}ms`),
    }))
    .filter((stretch) => stretch.durationMs >= minMs || stretch.keystroke)
    .sort((left, right) => Number(right.keystroke) - Number(left.keystroke) || right.durationMs - left.durationMs)
    .slice(0, limit);
}

async function measureScenario(profilePath, scenario, port, temperature) {
  const { child, client } = await launch(profilePath, scenario.name, port);
  let renderer;
  let profileSummary = null;
  let profileStretches = null;
  let profileClockNowMs = null;
  let keystrokeTrace = null;
  let burstTrace = null;
  let stopTrace = null;
  let placement = null;
  try {
    await injectStyle(client);
    if (traceRequested) stopTrace = await startTrace(client);
    if (profileRequested) {
      await client.request('Profiler.enable');
      await client.request('Profiler.setSamplingInterval', { interval: 200 });
      await client.request('Profiler.start');
      // performance.now() and the profile share the monotonic tick clock;
      // this reading right after start anchors renderer stamps to the profile.
      profileClockNowMs = await client.evaluate('performance.now()');
    }
    const expectedSurface = JSON.stringify(scenario.expectedSurface || '');
    const measureSubmit = scenario.measureSubmit === true;
    const measureMenus = scenario.measureMenus === true;
    const typingBurst = scenario.typingBurst === true;
    renderer = await evaluateStable(client, `(async () => {
      const expectedSurface = ${expectedSurface};
      const measureSubmit = ${measureSubmit};
      const measureMenus = ${measureMenus};
      const typingBurst = ${typingBurst};
      const burstText = ${JSON.stringify(TYPING_BURST_TEXT)};
      const deadline = performance.now() + 15_000;
      while (performance.now() < deadline) {
        const metrics = window.__mixdogBootMetrics || [];
        const visible = metrics.some((entry) =>
          entry.category === "boot" && entry.stage === "window-visible-frame");
        const restored = metrics.some((entry) =>
          entry.category === "boot" && entry.stage === "startup-restored");
        const surfaceReady = !expectedSurface || metrics.some((entry) =>
          entry.category === "surface"
          && entry.surface === expectedSurface
          && entry.stage === "ready");
        const desktopReady = document.querySelector(".desktop-boot-gate")
          ?.getAttribute("data-ready") === "true";
        if (visible && restored && surfaceReady && desktopReady) break;
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      const settledMetrics = window.__mixdogBootMetrics || [];
      const visible = settledMetrics.some((entry) =>
        entry.category === "boot" && entry.stage === "window-visible-frame");
      const restored = settledMetrics.some((entry) =>
        entry.category === "boot" && entry.stage === "startup-restored");
      const surfaceReady = !expectedSurface || settledMetrics.some((entry) =>
        entry.category === "surface"
        && entry.surface === expectedSurface
        && entry.stage === "ready");
      const desktopReady = document.querySelector(".desktop-boot-gate")
        ?.getAttribute("data-ready") === "true";
      const settled = {
        ok: visible && restored && surfaceReady && desktopReady,
        visible,
        restored,
        desktopReady,
        surface: expectedSurface || "",
        surfaceReady,
        viewport: { width: innerWidth, height: innerHeight },
        sidebar: {
          storedOpen: localStorage.getItem("mixdog.desktop-sidebar-open.v1"),
          mounted: Boolean(document.getElementById("session-sidebar")),
          hidden: document.getElementById("session-sidebar")?.getAttribute("aria-hidden") || "",
        },
        surfaceMetrics: settledMetrics.filter((entry) => entry.category === "surface"),
      };
      const navigation = performance.getEntriesByType("navigation")[0];
      const interactionRoot = () => expectedSurface === "dock"
        ? document.querySelector(".utility-dock[data-state='open'][data-side='right']")
        : expectedSurface === "sidebar"
          ? document.querySelector(".utility-dock[data-state='open'][data-side='left']")
          : expectedSurface === "session-sidebar"
            ? document.getElementById("session-sidebar")
            : expectedSurface === "bottom-panel"
              ? document.querySelector(".bottom-panel[data-state='open']")
              : document.querySelector(".stable-pane-surface[data-surface-active='true']");
      const surfaceControls = () => [...(interactionRoot() || document).querySelectorAll(
          "button:not(:disabled),input:not(:disabled),textarea:not(:disabled),"
          + "select:not(:disabled),[contenteditable='true'],[tabindex]:not([tabindex='-1'])",
        )].filter((element) => {
          if (element.closest(".pane-surface-gate-content[aria-hidden='true']")) {
            return false;
          }
          const rect = element.getBoundingClientRect();
          const style = getComputedStyle(element);
          return rect.width > 0 && rect.height > 0
            && style.visibility !== "hidden" && style.display !== "none";
        });
      const waitsForSurfaceControl = ["editor", "studio", "terminal"].includes(expectedSurface);
      let activeControls = surfaceControls();
      const interactionDeadline = performance.now() + 15_000;
      while (waitsForSurfaceControl && activeControls.length === 0
        && performance.now() < interactionDeadline) {
        await new Promise((resolve) => setTimeout(resolve, 25));
        activeControls = surfaceControls();
      }
      const focusTarget = activeControls[0] || null;
      const focusStartedAt = performance.now();
      focusTarget?.focus({ preventScroll: true });
      await new Promise((resolve) => requestAnimationFrame(resolve));
      const focusMs = performance.now() - focusStartedAt;
      const composer = document.querySelector("form.composer textarea:not(:disabled)");
      // One rendered frame as the app produces it: rAF runs before that
      // frame's style/layout/paint, and a task posted from inside it runs
      // right after the frame is committed to the compositor. Waiting for a
      // SECOND rAF instead measured the OS: the next BeginMainFrame only comes
      // once the GPU has presented, and an occluded window (the probe came up
      // behind the user's app) has its presents throttled by DWM, so a 3ms
      // keystroke commit read as 50-130ms depending on window z-order.
      const committedFrame = () => new Promise((resolve) =>
        requestAnimationFrame(() => setTimeout(resolve, 0)));
      let keystrokePaintMs = null;
      let keystrokeAtMs = null;
      let runningAnimations = [];
      if (composer) {
        const previous = composer.value;
        const setter = Object.getOwnPropertyDescriptor(
          HTMLTextAreaElement.prototype,
          "value",
        )?.set;
        // What was animating while the keystroke painted: a running CSS
        // animation keeps the compositor producing frames, and the main
        // thread's own frame queues behind them.
        runningAnimations = document.getAnimations().slice(0, 12).map((animation) => {
          const target = animation.effect?.target;
          const tag = target ? target.tagName.toLowerCase()
            + (target.id ? "#" + target.id : "")
            + (target.className && typeof target.className === "string"
              ? "." + target.className.trim().split(/\\s+/).slice(0, 2).join(".") : "") : "?";
          return (animation.animationName || animation.transitionProperty || animation.constructor.name)
            + "@" + tag + " " + animation.playState;
        });
        const inputStartedAt = performance.now();
        keystrokeAtMs = inputStartedAt;
        performance.mark(${JSON.stringify(KEYSTROKE_MARK)});
        composer.focus({ preventScroll: true });
        setter?.call(composer, previous + "x");
        composer.dispatchEvent(new Event("input", { bubbles: true }));
        await committedFrame();
        keystrokePaintMs = performance.now() - inputStartedAt;
        performance.mark(${JSON.stringify(KEYPAINT_MARK)});
        setter?.call(composer, previous);
        composer.dispatchEvent(new Event("input", { bubbles: true }));
      }
      let burst = null;
      if (composer && typingBurst) {
        // Steady state first: the diff rows (or their error/empty notice)
        // must be on screen and the boot warm-up lane drained, so the burst
        // measures what the user types INTO, not the loading cover.
        const settledDeadline = performance.now() + 20_000;
        const diffSettled = () => Boolean(document.querySelector(
          ".workspace-git-diff-hunks, .workspace-git-diff-body [role='alert'],"
          + " .workspace-git-diff-body .diff-view, .workspace-git-diff-body table,"
          + " .workspace-git-diff-state:not(:has(svg))",
        ));
        while (performance.now() < settledDeadline && !diffSettled()) {
          await new Promise((resolve) => setTimeout(resolve, 50));
        }
        await new Promise((resolve) => setTimeout(resolve, 1_500));
        const previous = composer.value;
        const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
        const longTasks = [];
        const observer = typeof PerformanceObserver === "function"
          ? new PerformanceObserver((list) => {
            for (const entry of list.getEntries()) longTasks.push(Number(entry.duration.toFixed(1)));
          })
          : null;
        try { observer?.observe({ entryTypes: ["longtask"] }); } catch {}
        // DOM churn outside the composer during the burst names a surface
        // that re-renders on keystrokes it never received (diff rows, Goal).
        const churn = { diff: 0, goal: 0, dock: 0 };
        const churnObserver = new MutationObserver((records) => {
          for (const record of records) {
            const target = record.target instanceof Element ? record.target : record.target.parentElement;
            if (!target) continue;
            if (target.closest(".workspace-git-diff")) churn.diff += 1;
            else if (target.closest(".session-goal-host")) churn.goal += 1;
            else if (target.closest(".pane-side-dock")) churn.dock += 1;
          }
        });
        for (const node of document.querySelectorAll(".pane-side-dock")) {
          churnObserver.observe(node, { subtree: true, childList: true, attributes: true, characterData: true });
        }
        composer.focus({ preventScroll: true });
        const samples = [];
        const phases = [];
        const chars = [...burstText];
        // Phase 2/3 (user: diff창/goal창이 사라지거나 생성될 때 유독): the
        // diff is closed at one keystroke and reopened from its Source
        // Control row at a later one, typing straight through both.
        const diffRel = ${JSON.stringify(scenario.dock?.diff?.rel || '')};
        // --burst-steady: no close/reopen, so the slowest-keystroke trace
        // names the steady-state cost of typing beside a mounted diff.
        const steadyOnly = ${process.argv.includes('--burst-steady')};
        const closeAt = steadyOnly ? chars.length : 10;
        const reopenAt = steadyOnly ? chars.length : 40;
        const typeThrough = async (phase, from, to, before) => {
          for (let index = from; index < to; index += 1) {
            const startedAt = performance.now();
            if (index === from && before) before();
            performance.mark(${JSON.stringify(BURST_KEY_MARK)});
            setter?.call(composer, previous + chars.slice(0, index + 1).join(""));
            composer.dispatchEvent(new Event("input", { bubbles: true }));
            await committedFrame();
            performance.mark(${JSON.stringify(BURST_PAINT_MARK)});
            const ms = Number((performance.now() - startedAt).toFixed(1));
            samples.push(ms);
            phases.push(phase);
          }
        };
        const diffColumnHidden = () => {
          const column = document.querySelector(".pane-dock-diff-column, .workbench-side-surface-slot:has(.workspace-git-diff)");
          return !column || column.hidden || column.getAttribute("data-surface-active") === "false";
        };
        const transitions = { closedAt: null, reopenedAt: null };
        await typeThrough("steady", 0, closeAt);
        await typeThrough("close", closeAt, reopenAt, () => {
          // Locale-free: the close X is the last action of the diff header.
          const actions = document.querySelectorAll(".workspace-git-diff-actions > button");
          actions[actions.length - 1]?.click();
        });
        transitions.closedAt = diffColumnHidden();
        await typeThrough("reopen", reopenAt, chars.length, () => {
          // Locale-free: the row's title carries the raw path.
          document.querySelector(".dock-scm-file-main[title='" + diffRel + "']")?.click();
        });
        transitions.reopenedAt = !diffColumnHidden();
        transitions.scmRows = [...document.querySelectorAll(".dock-scm-file-main")]
          .slice(0, 5).map((row) => row.getAttribute("title") || "");
        observer?.disconnect();
        churnObserver.disconnect();
        setter?.call(composer, previous);
        composer.dispatchEvent(new Event("input", { bubbles: true }));
        const sorted = [...samples].sort((left, right) => left - right);
        burst = {
          count: samples.length,
          avgMs: Number((samples.reduce((total, value) => total + value, 0) / (samples.length || 1)).toFixed(1)),
          p95Ms: sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))] ?? null,
          maxMs: sorted.at(-1) ?? null,
          slow: samples.map((ms, index) => ({ index, ms, phase: phases[index] }))
            .filter((entry) => entry.ms >= 16),
          phaseMax: Object.fromEntries(["steady", "close", "reopen"].map((phase) => [
            phase,
            Math.max(0, ...samples.filter((_, index) => phases[index] === phase)),
          ])),
          diffReopened: Boolean(document.querySelector(".workspace-git-diff")),
          transitions,
          longTasks,
          churn,
          diffSettled: diffSettled(),
          goalVisible: Boolean(document.querySelector(".session-goal-host[data-goal-placement='diff'] .session-goal-island")),
          goalAnywhere: Boolean(document.querySelector(".session-goal-island")),
        };
      }
      const bootContext = window.mixdogDesktop?.bootContext || null;
      const interactionMeasuredAtMs = bootContext
        ? Math.max(0, Date.now() - bootContext.processStartedAt)
        : null;
      if (expectedSurface) {
        const dataDeadline = performance.now() + 15_000;
        while (performance.now() < dataDeadline) {
          const dataReady = (window.__mixdogBootMetrics || []).some((entry) =>
            entry.category === "surface"
            && entry.surface === expectedSurface
            && ["data", "interactive"].includes(entry.stage));
          if (dataReady) break;
          await new Promise((resolve) => setTimeout(resolve, 25));
        }
      }
      const finalMetrics = window.__mixdogBootMetrics || [];
      const shellReadyAtMs = expectedSurface
        ? finalMetrics.find((entry) =>
          entry.category === "surface"
          && entry.surface === expectedSurface
          && entry.stage === "ready")?.totalMs ?? null
        : finalMetrics.find((entry) =>
          entry.category === "boot" && entry.stage === "desktop-revealed")?.totalMs ?? null;
      const dataReadyAtMs = expectedSurface
        ? finalMetrics.filter((entry) =>
          entry.category === "surface"
          && entry.surface === expectedSurface
          && ["data", "interactive"].includes(entry.stage)).at(-1)?.totalMs ?? null
        : finalMetrics.filter((entry) =>
          entry.category === "surface"
          && ["data", "interactive"].includes(entry.stage)).at(-1)?.totalMs ?? null;
      let firstSubmit = null;
      if (measureSubmit) {
        const submitStartedAt = performance.now();
        const submitted = await window.mixdogDesktop.submitNewTask(
          "Boot scenario first submit",
          {
            id: "boot-scenario-first-submit-" + Math.round(performance.timeOrigin),
            displayText: "Boot scenario first submit",
            goalCommand: "Boot scenario first submit",
          },
        );
        const acceptanceMs = performance.now() - submitStartedAt;
        if (!submitted?.accepted || !submitted.sessionId) {
          throw new Error("First submit was not accepted.");
        }
        firstSubmit = {
          accepted: true,
          sessionId: submitted.sessionId,
          acceptanceMs,
        };
        await window.mixdogDesktop.invokeCapability({
          capability: "goalControl",
          args: [{ command: "pause" }],
          sessionId: submitted.sessionId,
        });
      }
      let menus = null;
      if (measureMenus) {
        // A warm app: wait for the warm-up lane to drain (bounded), then
        // let the thread settle one more beat.
        const drainDeadline = performance.now() + 10_000;
        while (!window.__mixdogBootWarmupDrained && performance.now() < drainDeadline) {
          await new Promise((resolve) => setTimeout(resolve, 50));
        }
        await new Promise((resolve) => setTimeout(resolve, 500));
        const frame = committedFrame;
        // A fresh profile opens the first-run wizard, which makes the whole
        // workbench inert (clicks would be swallowed). Skip it the way a user
        // does — footer Skip, then the confirmation's danger button.
        const wizardSkip = document.querySelector(".onboarding-dialog > footer > button.secondary");
        if (wizardSkip) {
          wizardSkip.click();
          const confirmDeadline = performance.now() + 3_000;
          let confirmButton = null;
          while (!confirmButton && performance.now() < confirmDeadline) {
            await frame();
            confirmButton = document.querySelector(".settings-confirm-dialog footer > button.danger");
          }
          confirmButton?.click();
          const goneDeadline = performance.now() + 5_000;
          while (document.querySelector(".settings-confirm-dialog, .onboarding-dialog")
            && performance.now() < goneDeadline) {
            await frame();
          }
          await new Promise((resolve) => setTimeout(resolve, 300));
        }
        const isShown = (element) => {
          if (!element || element.closest("[hidden],[aria-hidden='true'],[inert]")) return false;
          const rect = element.getBoundingClientRect();
          const style = getComputedStyle(element);
          return rect.width > 0 && rect.height > 0
            && style.visibility !== "hidden" && style.display !== "none";
        };
        const usableControl = (root) => root && [...root.querySelectorAll(
          "button:not(:disabled),input:not(:disabled),textarea:not(:disabled),select:not(:disabled)",
        )].find(isShown);
        // Click, then time (a) the first painted frame with the target shown
        // and (b) the first frame with a usable control inside it.
        const timeEntry = async (label, trigger, target, requireControl = true) => {
          if (!trigger) return { label, skipped: true };
          // Long tasks between the click and the paint are the "hitch" a user
          // feels even when the surface eventually lands: name the worst one.
          const longTasks = [];
          let observer = null;
          try {
            observer = new PerformanceObserver((list) => {
              for (const task of list.getEntries()) longTasks.push(task.duration);
            });
            observer.observe({ type: "longtask", buffered: false });
          } catch { observer = null; }
          const startedAt = performance.now();
          trigger.click();
          let visibleMs = null;
          let interactiveMs = null;
          const deadline = performance.now() + 4_000;
          while (performance.now() < deadline) {
            await frame();
            const root = target();
            if (visibleMs === null && isShown(root)) visibleMs = performance.now() - startedAt;
            if (visibleMs !== null && (!requireControl || usableControl(root))) {
              interactiveMs = performance.now() - startedAt;
              break;
            }
          }
          // One more frame so a long task that ended with the paint is reported.
          await frame();
          observer?.disconnect();
          const longTaskMaxMs = longTasks.length ? Math.max(...longTasks) : 0;
          const longTaskTotalMs = longTasks.reduce((sum, value) => sum + value, 0);
          const describe = (element) => {
            if (!element) return "missing";
            const chain = [];
            for (let node = element; node && node !== document.body; node = node.parentElement) {
              const flags = ["hidden", "aria-hidden", "inert"].filter((name) => node.hasAttribute(name))
                .map((name) => name + "=" + (node.getAttribute(name) || ""));
              if (flags.length) chain.push(node.tagName.toLowerCase() + "." + String(node.className).split(" ")[0] + "[" + flags.join(",") + "]");
            }
            const rect = element.getBoundingClientRect();
            return Math.round(rect.width) + "x" + Math.round(rect.height) + " " + (chain.join(" > ") || "clear");
          };
          return {
            label,
            visibleMs,
            interactiveMs,
            ...(longTasks.length ? { longTaskMaxMs, longTaskTotalMs, longTasks: longTasks.length } : {}),
            ...(visibleMs === null || interactiveMs === null ? { debug: describe(target()) } : {}),
          };
        };
        const entries = [];
        const rail = [...document.querySelectorAll(".workbench-side-icon-bar.is-vertical > button")];
        for (const button of rail) {
          const label = button.getAttribute("aria-label") || "";
          // Studio is a launcher: it opens a workspace tab, not a panel; the
          // view already showing would FOLD on a re-click.
          if (/studio|스튜디오/i.test(label) || button.getAttribute("aria-current") === "page") continue;
          // Every left destination — Sessions included — renders inside the
          // left WorkbenchSidePanel; the section for the clicked view is
          // the body that must paint.
          entries.push(await timeEntry("rail:" + label, button, () =>
            document.querySelector(".workbench-side-panel[data-side='left']:not([hidden]) .workbench-side-panel-body:not([hidden])")));
        }
        // A pressed toggle would FOLD the dock (warm profiles restore it open).
        const dockToggle = [...document.querySelectorAll(".pane-dock-toggle")]
          .find((button) => button.getAttribute("aria-disabled") !== "true"
            && button.getAttribute("aria-pressed") !== "true");
        // A fresh draft has no project, so Source Control shows its empty
        // hint without controls: the painted body is the whole answer here.
        entries.push(await timeEntry("dock:" + (dockToggle?.getAttribute("aria-label") || ""), dockToggle,
          () => document.querySelector(".pane-side-dock[data-open='true'] .utility-dock[data-state='open']"), false));
        // Every other pane-dock child in turn (terminal, explorer, …): each
        // first selection mounts that surface from scratch. The active layer is
        // whichever dock pane/surface is presented after the click.
        const dockSurface = () => document.querySelector(
          ".pane-side-dock[data-open='true'] .utility-dock-pane[data-surface-active='true'],"
          + " .pane-side-dock[data-open='true'] .dock-terminal, .pane-side-dock[data-open='true'] .xterm",
        );
        for (const toggle of [...document.querySelectorAll(".pane-dock-toggles > button")]) {
          if (toggle === dockToggle || toggle.getAttribute("aria-disabled") === "true"
            || toggle.getAttribute("aria-pressed") === "true") continue;
          const previous = dockSurface();
          entries.push(await timeEntry("dock:" + (toggle.getAttribute("aria-label") || ""), toggle,
            () => { const next = dockSurface(); return next && next !== previous ? next : null; }, false));
        }
        entries.push(await timeEntry("settings", document.querySelector(".sidebar-settings-button"),
          () => document.querySelector(".mixdog-settings-layer[data-surface-active='true'] .capability-settings-content")));
        // Reopen: the dialog stays mounted after its first open, so this is
        // the steady-state gear click a user feels for the rest of the session.
        const closeSettings = () => document.querySelector(
          ".mixdog-settings-layer button[aria-label*='닫기'], .mixdog-settings-layer button[aria-label*='Close']",
        )?.click();
        closeSettings();
        await new Promise((resolve) => setTimeout(resolve, 400));
        entries.push(await timeEntry("settings:reopen", document.querySelector(".sidebar-settings-button"),
          () => document.querySelector(".mixdog-settings-layer[data-surface-active='true'] .capability-settings-content")));
        // Composer model pill → route sheet rows, then the Model row → the full
        // catalog flyout with its first option row (user: 눌렀을 때 반응 —
        // the list must already exist when the row is entered).
        closeSettings();
        await frame();
        const modelTrigger = document.querySelector(".route-editor > .model-trigger:not(:disabled)");
        entries.push(await timeEntry("model:sheet", modelTrigger,
          () => document.querySelector(".route-sheet[data-state='open'] .route-sheet-rows")));
        const modelRow = document.querySelector(".route-sheet[data-state='open'] .route-sheet-row");
        // A fresh probe profile has no provider, so the list itself may be
        // empty: the painted catalog panel with its search field is the answer.
        entries.push(await timeEntry("model:catalog", modelRow,
          () => document.querySelector(".route-sheet-flyout--model:not([hidden]) .model-catalog-panel")));
        menus = entries;
      }
      return {
        bootContext,
        menus,
        metrics: finalMetrics,
        navigation: navigation ? {
          responseEnd: navigation.responseEnd,
          domContentLoadedEventEnd: navigation.domContentLoadedEventEnd,
          loadEventEnd: navigation.loadEventEnd,
        } : null,
        visible: document.visibilityState,
        active: {
          workspace: document.querySelector(".stable-pane-surface[data-surface-active='true']")?.className || "",
          dock: document.querySelector(".utility-dock[data-state='open']")?.getAttribute("data-side") || "",
          bottom: Boolean(document.querySelector(".bottom-panel")),
        },
        interaction: {
          shellReadyAtMs,
          dataReadyAtMs,
          measuredAtMs: interactionMeasuredAtMs,
          activeControlCount: activeControls.length,
          rawControlCount: interactionRoot()?.querySelectorAll(
            "button,input,textarea,select,[contenteditable='true'],[tabindex]",
          ).length ?? 0,
          gateStates: [...(interactionRoot()?.querySelectorAll(".pane-surface-gate") || [])]
            .map((element) => ({
              ready: element.getAttribute("data-ready") || "",
              contentHidden: element.querySelector(".pane-surface-gate-content")
                ?.getAttribute("aria-hidden") || "",
            })),
          focused: Boolean(focusTarget && document.activeElement === focusTarget),
          focusMs,
          composerReady: Boolean(composer),
          keystrokePaintMs,
          keystrokeAtMs,
          burst,
          runningAnimations,
          injectedStyle: Boolean(document.querySelector("style[data-mixdog-probe]")),
        },
        firstSubmit,
        settled,
      };
    })()`, measureMenus ? 120_000 : 20_000);
    if (profileRequested) {
      const { profile } = await client.request('Profiler.stop');
      profileSummary = summarizeProfile(profile);
      const keystrokeAt = renderer?.interaction?.keystrokeAtMs;
      profileStretches = busyStretches(
        profile,
        typeof keystrokeAt === 'number' && typeof profileClockNowMs === 'number'
          ? keystrokeAt - profileClockNowMs
          : null,
      );
    }
    if (stopTrace) {
      const traceEvents = await stopTrace();
      keystrokeTrace = summarizeKeystrokeTrace(traceEvents);
      burstTrace = summarizeKeystrokeTrace(traceEvents, 10, 'burst');
      if (traceDumpDir) {
        await mkdir(traceDumpDir, { recursive: true });
        await writeFile(join(traceDumpDir, `${scenario.name}-${temperature}.json`),
          JSON.stringify({ traceEvents }));
      }
    }
    placement = await windowPlacement(child.pid);
  } finally {
    await stopApp(client, child, profilePath);
  }
  const main = await readBootDiagnostics(profilePath, renderer?.bootContext?.bootId);
  return {
    scenario: scenario.name,
    temperature,
    bootId: renderer?.bootContext?.bootId || '',
    main,
    renderer: renderer?.metrics || [],
    navigation: renderer?.navigation || null,
    active: renderer?.active || null,
    interaction: renderer?.interaction || null,
    firstSubmit: renderer?.firstSubmit || null,
    menus: renderer?.menus || null,
    profile: profileSummary,
    busy: profileStretches,
    keystrokeTrace,
    burstTrace,
    window: placement,
    settled: renderer?.settled || null,
  };
}

await mkdir(artifactDir, { recursive: true });
try {
  const staleProfiles = await readdir(profileRoot, { withFileTypes: true });
  for (const entry of staleProfiles) {
    if (!entry.isDirectory()) continue;
    const staleProfile = join(profileRoot, entry.name);
    await stopIsolatedDaemon(staleProfile);
    await stopIsolatedMemoryStore(staleProfile);
  }
} catch (reason) {
  if (reason?.code !== 'ENOENT') throw reason;
}
await rm(profileRoot, {
  recursive: true,
  force: true,
  maxRetries: 10,
  retryDelay: 100,
});
await mkdir(profileRoot, { recursive: true });
const results = [];
let port = 9460;
for (const scenario of scenarios) {
  const profilePath = join(profileRoot, scenario.name);
  await mkdir(profilePath, { recursive: true });
  if (!scenario.fresh) {
    await seedScenario(profilePath, scenario, port++);
  }
  for (let iteration = 0; iteration < iterations; iteration += 1) {
    const temperature = iteration === 0 ? 'cold' : 'warm';
    const result = await measureScenario(profilePath, scenario, port++, temperature);
    results.push(result);
    const shown = result.main.find((entry) => entry.event === 'window-shown')?.durationMs;
    const ready = result.main.find((entry) => entry.event === 'renderer-ready')?.durationMs;
    const surface = result.renderer.find((entry) =>
      entry.category === 'surface'
      && entry.surface === scenario.expectedSurface
      && entry.stage === 'ready')?.totalMs;
    const interaction = result.interaction?.measuredAtMs;
    const shell = result.interaction?.shellReadyAtMs;
    const data = result.interaction?.dataReadyAtMs;
    const paint = result.interaction?.keystrokePaintMs;
    const submit = result.firstSubmit?.acceptanceMs;
    console.log(
      `${scenario.name} ${temperature}: renderer=${ready ?? 'n/a'}ms`
      + ` shown=${shown ?? 'n/a'}ms surface=${surface ?? 'n/a'}ms`
      + ` shell=${shell ?? 'n/a'}ms data=${data ?? 'n/a'}ms`
      + ` interactive=${interaction ?? 'n/a'}ms keypaint=${paint?.toFixed?.(1) ?? 'n/a'}ms`
      + ` submit=${submit?.toFixed?.(1) ?? 'n/a'}ms settled=${result.settled?.ok !== false}`
      + (result.window?.window
        ? ` window=${result.window.foreground ? 'front' : 'behind'}/${result.window.coveredPoints}of5covered`
        : result.window?.error ? ` window=error(${result.window.error})` : ''),
    );
    if (result.interaction?.runningAnimations?.length) {
      console.log(`  animating: ${result.interaction.runningAnimations.join(' | ')}`);
    }
    if (result.interaction?.burst) {
      const burst = result.interaction.burst;
      console.log(
        `  burst ${burst.count} keys: avg=${burst.avgMs}ms p95=${burst.p95Ms}ms max=${burst.maxMs}ms`
        + ` phaseMax=${Object.entries(burst.phaseMax).map(([phase, ms]) => `${phase}:${ms}`).join('/')}`
        + ` slow(>=16ms)=${burst.slow.map((entry) => `#${entry.index}${entry.phase ? `@${entry.phase}` : ''}:${entry.ms}`).join(',') || 'none'}`
        + ` closed=${burst.transitions?.closedAt} reopened=${burst.transitions?.reopenedAt}`
        + ` scmRows=${JSON.stringify(burst.transitions?.scmRows || [])}`
        + ` longtasks=${burst.longTasks.join(',') || 'none'}`
        + ` diffSettled=${burst.diffSettled} goalVisible=${burst.goalVisible}/${burst.goalAnywhere}`
        + ` churn=diff:${burst.churn.diff}/goal:${burst.churn.goal}/dock:${burst.churn.dock}`,
      );
    }
    if (injectCss) console.log(`  inject-css applied=${result.interaction?.injectedStyle ?? 'n/a'}`);
    for (const entry of result.profile || []) {
      console.log(`  cpu ${entry.selfMs}ms ${entry.frame}`);
    }
    for (const stretch of result.busy || []) {
      console.log(
        `  busy +${stretch.atMs}ms ${stretch.durationMs}ms${stretch.keystroke ? ' [keystroke]' : ''}`
        + ` :: ${stretch.frames.join(' | ')}`,
      );
    }
    for (const [label, trace] of [['keystroke', result.keystrokeTrace], ['burst-slowest', result.burstTrace]]) {
      if (!trace) continue;
      console.log(`  trace ${label} window ${trace.windowMs}ms :: ${
        trace.byName.map((entry) => `${entry.name} ${entry.totalMs}ms`).join(' | ')}`);
      for (const event of trace.longest) {
        console.log(`    +${event.atMs}ms ${event.durationMs}ms ${event.name}${event.detail ? ` (${event.detail})` : ''}`);
      }
      console.log(`  trace ${label} commit=${trace.commitMs ?? 'n/a'}ms firstDraw=${trace.drawMs ?? 'n/a'}ms`);
      if (trace.frames.length > 0) console.log(`  trace frames: ${trace.frames.join(' | ')}`);
      if (trace.paints.length > 0) {
        console.log(`  trace paints: ${trace.paints.join(' | ')} :: raster ${trace.raster.tasks} tasks ${trace.raster.totalMs}ms`);
      }
      for (const entry of trace.invalidations || []) console.log(`    invalidated ${entry}`);
      for (const entry of trace.styleInvalidations || []) console.log(`    style ${entry}`);
      if (trace.offMain.length > 0) {
        console.log(`  trace off-main: ${trace.offMain.map((entry) => `${entry.name} ${entry.totalMs}ms`).join(' | ')}`);
      }
    }
    for (const entry of result.menus || []) {
      console.log(
        `  menu ${entry.label}: ${entry.skipped ? 'skipped' : `visible=${entry.visibleMs?.toFixed?.(1) ?? 'n/a'}ms`
          + ` interactive=${entry.interactiveMs?.toFixed?.(1) ?? 'n/a'}ms`}`
          + (entry.longTasks ? ` longtask=${entry.longTaskMaxMs.toFixed(0)}ms(max)/${entry.longTaskTotalMs.toFixed(0)}ms(${entry.longTasks})` : '')
          + `${entry.debug ? ` [${entry.debug}]` : ''}`,
      );
    }
  }
}

const report = {
  generatedAt: new Date().toISOString(),
  projectPath,
  relPath,
  iterations,
  isolated: true,
  results,
};
const performance = results.flatMap((result) =>
  performanceFailures(result).map((failure) =>
    `${result.scenario}/${result.temperature}: ${failure}`));
report.performance = {
  ok: performance.length === 0,
  failures: performance,
};
await writeFile(reportPath, JSON.stringify(report, null, 2));
console.log(`BOOT_SCENARIO_REPORT=${reportPath}`);
for (const failure of performance) console.error(`PERFORMANCE_GATE ${failure}`);
if (results.some((result) => result.settled?.ok === false) || performance.length > 0) {
  process.exit(1);
}
