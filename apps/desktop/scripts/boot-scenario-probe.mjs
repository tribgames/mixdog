import { spawn } from 'node:child_process';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
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
  { name: 'project', selection: projectSelection },
  { name: 'session', selection: { kind: 'session', id: '__FIRST_SESSION__' } },
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
  { name: 'session-sidebar', selection: newSelection, sidebarOpen: true, expectedSurface: 'session-sidebar' },
  ...['tasks', 'files', 'search', 'source-control', 'outline'].map((tab) => ({
    name: `dock-${tab}`,
    selection: projectSelection,
    dock: { open: true, tab, width: 380 },
    expectedSurface: 'dock',
  })),
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

async function stopApp(client, child) {
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
}

async function launch(profilePath, scenarioName, port) {
  const child = spawn(electron, [desktopDir, `--remote-debugging-port=${port}`], {
    cwd: desktopDir,
    env: {
      ...process.env,
      MIXDOG_DESKTOP_USER_DATA: profilePath,
      MIXDOG_DESKTOP_PERF: '1',
      MIXDOG_BOOT_SCENARIO: scenarioName,
    },
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
    await evaluateStable(client, `(async () => {
      const scenario = ${seed};
      const startupDeadline = performance.now() + 10_000;
      while (!window.__mixdogStartupSettled && performance.now() < startupDeadline) {
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      if (!window.__mixdogStartupSettled) {
        throw new Error("Seed renderer did not settle before persistence.");
      }
      let selection = scenario.selection || { kind: "new" };
      if (selection.id === "__FIRST_SESSION__") {
        const rows = await window.mixdogDesktop.listSessions().catch(() => []);
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
      localStorage.setItem("mixdog.desktop.pane-layout.v1", paneState);
      localStorage.setItem("mixdog.desktop-sidebar-open.v1", String(scenario.sidebarOpen !== false));
      localStorage.setItem("mixdog.desktop-utility-dock.v1", JSON.stringify(
        scenario.dock || { open: false, tab: "tasks", width: 380 }
      ));
      localStorage.setItem("mixdog.desktop.bottom-panel.v1", JSON.stringify(
        scenario.bottom || { open: false, tab: "terminal", height: 240 }
      ));
      if (selection.kind === "session") {
        localStorage.setItem("mixdog.desktop-last-session.v1", selection.id);
      } else {
        localStorage.removeItem("mixdog.desktop-last-session.v1");
      }
      if (localStorage.getItem("mixdog.desktop.pane-layout.v1") !== paneState) {
        throw new Error("Seed pane layout did not persist.");
      }
      return { selection, layout };
    })()`);
  } finally {
    await stopApp(client, child);
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

async function measureScenario(profilePath, scenario, port, temperature) {
  const { child, client } = await launch(profilePath, scenario.name, port);
  let renderer;
  try {
    const expectedSurface = JSON.stringify(scenario.expectedSurface || '');
    renderer = await evaluateStable(client, `(async () => {
      const expectedSurface = ${expectedSurface};
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
        if (visible && restored && surfaceReady) break;
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
      if (!visible || !restored || !surfaceReady) {
        throw new Error(
          "Boot scenario did not settle:"
          + " visible=" + visible
          + " restored=" + restored
          + " surface=" + (expectedSurface || "none")
          + " ready=" + surfaceReady
        );
      }
      const navigation = performance.getEntriesByType("navigation")[0];
      return {
        bootContext: window.mixdogDesktop?.bootContext || null,
        metrics: window.__mixdogBootMetrics || [],
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
      };
    })()`, 20_000);
  } finally {
    await stopApp(client, child);
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
  };
}

await mkdir(artifactDir, { recursive: true });
await rm(profileRoot, { recursive: true, force: true });
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
    console.log(`${scenario.name} ${temperature}: renderer=${ready ?? 'n/a'}ms shown=${shown ?? 'n/a'}ms`);
  }
}

const report = {
  generatedAt: new Date().toISOString(),
  projectPath,
  relPath,
  iterations,
  results,
};
await writeFile(reportPath, JSON.stringify(report, null, 2));
console.log(`BOOT_SCENARIO_REPORT=${reportPath}`);
