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
  { name: 'first-submit', selection: newSelection, fresh: true, measureSubmit: true },
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

async function stopIsolatedMemoryStore(profilePath) {
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
  const child = spawn(electron, [desktopDir, `--remote-debugging-port=${port}`], {
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

async function measureScenario(profilePath, scenario, port, temperature) {
  const { child, client } = await launch(profilePath, scenario.name, port);
  let renderer;
  try {
    const expectedSurface = JSON.stringify(scenario.expectedSurface || '');
    const measureSubmit = scenario.measureSubmit === true;
    renderer = await evaluateStable(client, `(async () => {
      const expectedSurface = ${expectedSurface};
      const measureSubmit = ${measureSubmit};
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
      let keystrokePaintMs = null;
      if (composer) {
        const previous = composer.value;
        const setter = Object.getOwnPropertyDescriptor(
          HTMLTextAreaElement.prototype,
          "value",
        )?.set;
        const inputStartedAt = performance.now();
        composer.focus({ preventScroll: true });
        setter?.call(composer, previous + "x");
        composer.dispatchEvent(new Event("input", { bubbles: true }));
        await new Promise((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(resolve)));
        keystrokePaintMs = performance.now() - inputStartedAt;
        setter?.call(composer, previous);
        composer.dispatchEvent(new Event("input", { bubbles: true }));
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
      return {
        bootContext,
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
        },
        firstSubmit,
        settled,
      };
    })()`, 20_000);
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
      + ` submit=${submit?.toFixed?.(1) ?? 'n/a'}ms settled=${result.settled?.ok !== false}`,
    );
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
