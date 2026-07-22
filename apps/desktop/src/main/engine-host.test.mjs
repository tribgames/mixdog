import assert from "node:assert/strict";
import { test } from "node:test";
import {
  desktopSessionSummaries,
  desktopSnapshot,
  requiredSessionId,
  SESSION_WORKING_HEARTBEAT_MS,
} from "./desktop-state.ts";
import {
  EngineHost,
  engineModuleUrl,
  projectDesktopLiveWorkState,
  projectsModuleUrl,
  sessionStoreModuleUrl,
  shellJobsPollDelay,
} from "./engine-host.ts";
import { searchProjectDirectory } from "./project-file-search.ts";
import { registerDesktopIpc } from "./ipc.ts";
import { DESKTOP_IPC } from "../shared/contract.ts";
import {
  fastCapableFor,
  fastPreferenceFor,
  saveModelSettings,
} from "../../../../src/session-runtime/model-capabilities.mjs";
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

function createProjectStore(seed = []) {
  let clock = 1_000;
  let projects = seed.map((entry, index) => ({
    name: entry.name || basename(entry.path),
    path: resolve(entry.path),
    addedAt: entry.addedAt ?? (clock - index),
    ...(entry.lastSelectedAt ? { lastSelectedAt: entry.lastSelectedAt } : {}),
  }));
  const calls = [];
  const key = (value) => {
    const normalized = resolve(value).replace(/[\\/]+$/, "");
    return process.platform === "win32" ? normalized.toLowerCase() : normalized;
  };
  const find = (value) => projects.find((entry) => key(entry.path) === key(value));
  const module = {
    resolveProjectPath: (value) => resolve(String(value || "")),
    listProjects: () => projects.slice().sort((left, right) =>
      (right.lastSelectedAt || right.addedAt) - (left.lastSelectedAt || left.addedAt)),
    addProject: (value) => {
      const path = resolve(value);
      calls.push(["addProject", path]);
      const existing = find(path);
      if (existing) return { ...existing };
      const entry = { name: basename(path), path, addedAt: ++clock };
      projects.push(entry);
      return { ...entry };
    },
    touchProjectSelected: (value) => {
      const path = resolve(value);
      calls.push(["touchProjectSelected", path]);
      const entry = find(path);
      if (!entry) return null;
      entry.lastSelectedAt = ++clock;
      return { ...entry };
    },
    renameProject: (value, name) => {
      const path = resolve(value);
      calls.push(["renameProject", path, name]);
      const entry = find(path);
      if (!entry) return null;
      entry.name = String(name || "").trim() || basename(path);
      return { ...entry };
    },
    removeProject: (value) => {
      const path = resolve(value);
      calls.push(["removeProject", path]);
      const before = projects.length;
      projects = projects.filter((entry) => key(entry.path) !== key(path));
      return projects.length !== before;
    },
  };
  return { module, calls };
}

test("engine module resolution uses the Electron app root outside packaged builds", () => {
  const roots = [
    { name: "source/dev", repository: join(tmpdir(), "mixdog-source") },
    { name: "built preview", repository: join(tmpdir(), "mixdog-preview") },
  ];
  for (const root of roots) {
    const appRoot = join(root.repository, "apps", "desktop");
    assert.equal(
      fileURLToPath(engineModuleUrl(false, join(root.repository, "resources"), appRoot)),
      join(root.repository, "src", "tui", "engine.mjs"),
      root.name,
    );
  }
});

test("packaged engine module resolution remains in the curated runtime archive", () => {
  const resourcesPath = join(tmpdir(), "mixdog-resources");
  assert.equal(
    engineModuleUrl(true, resourcesPath),
    pathToFileURL(join(
      resourcesPath,
      "runtime.asar",
      "node_modules",
      "mixdog",
      "src",
      "tui",
      "engine.mjs",
    )).href,
  );
});

test("project registration resolves to the shared TUI store in source and packaged runtimes", () => {
  const repositoryRoot = join(tmpdir(), "mixdog-project-store");
  const appRoot = join(repositoryRoot, "apps", "desktop");
  const resourcesPath = join(repositoryRoot, "resources");
  assert.equal(
    fileURLToPath(projectsModuleUrl(false, resourcesPath, appRoot)),
    join(repositoryRoot, "src", "standalone", "projects.mjs"),
  );
  assert.equal(
    fileURLToPath(projectsModuleUrl(true, resourcesPath, appRoot)),
    join(
      resourcesPath,
      "runtime.asar",
      "node_modules",
      "mixdog",
      "src",
      "standalone",
      "projects.mjs",
    ),
  );
});

test("session summary module resolves beside the shared runtime in source and packaged builds", () => {
  const repositoryRoot = join(tmpdir(), "mixdog-session-store");
  const appRoot = join(repositoryRoot, "apps", "desktop");
  const resourcesPath = join(repositoryRoot, "resources");
  assert.equal(
    fileURLToPath(sessionStoreModuleUrl(false, resourcesPath, appRoot)),
    join(repositoryRoot, "src", "runtime", "agent", "orchestrator", "session", "store-summary-reader.mjs"),
  );
  assert.equal(
    fileURLToPath(sessionStoreModuleUrl(true, resourcesPath, appRoot)),
    join(resourcesPath, "runtime.asar", "node_modules", "mixdog", "src", "runtime",
      "agent", "orchestrator", "session", "store-summary-reader.mjs"),
  );
});

test("non-packaged engine resolution rejects missing, empty, and relative application paths", () => {
  const resourcesPath = join(tmpdir(), "mixdog-resources");
  for (const appPath of [undefined, "", "   ", join("apps", "desktop")]) {
    assert.throws(
      () => engineModuleUrl(false, resourcesPath, appPath),
      /application path must be an absolute path/,
    );
  }
});

test("non-packaged hosts require application paths only for real engine loading", () => {
  assert.throws(
    () => new EngineHost({ appPath: join("apps", "desktop") }),
    /application path must be an absolute path/,
  );
  assert.doesNotThrow(() => new EngineHost({
    appPath: join("apps", "desktop"),
    createEngine: async () => {
      throw new Error("test-only engine override was unexpectedly loaded");
    },
  }));
});

test("resolved non-packaged runtime engine module imports", async () => {
  const repositoryRoot = resolve(import.meta.dirname, "../../../../");
  const appRoot = join(repositoryRoot, "apps", "desktop");
  const engineModule = await import(engineModuleUrl(false, join(repositoryRoot, "resources"), appRoot));
  assert.equal(typeof engineModule.createEngineSession, "function");
});

test("desktop snapshot exposes production current and recent project navigation state", () => {
  const snapshot = desktopSnapshot(
    {
      busy: true,
      thinking: "provider reasoning",
      spinner: { active: true, mode: "thinking", verb: "Reasoning" },
      items: [
        { id: "turn", kind: "turndone", status: "done" },
        { id: "compact", kind: "statusdone", label: "Compact complete" },
      ],
      queued: [],
      toasts: [{ tone: "error", text: "failed" }],
    },
    "C:\\work\\current",
    ["C:\\work\\current", "C:\\work\\previous"],
  );

  assert.equal(snapshot.currentProject, "C:\\work\\current");
  assert.deepEqual(snapshot.recentProjects, ["C:\\work\\current", "C:\\work\\previous"]);
  assert.equal(snapshot.thinking, "provider reasoning");
  assert.equal(snapshot.spinner.mode, "thinking");
  assert.deepEqual(snapshot.items, [
    { id: "turn", kind: "turndone", status: "done" },
    { id: "compact", kind: "statusdone", label: "Compact complete" },
  ]);
  assert.deepEqual(snapshot.toasts, [{ tone: "error", text: "failed" }]);
});

test("desktop snapshot retains recent projects while the active engine is switching", () => {
  const snapshot = desktopSnapshot(null, null, ["C:\\work\\previous"]);
  assert.equal(snapshot.currentProject, null);
  assert.deepEqual(snapshot.recentProjects, ["C:\\work\\previous"]);
  assert.deepEqual(snapshot.items, []);
  assert.deepEqual(snapshot.queued, []);
});

test("desktop live-work projection removes terminal history and trims IPC records", () => {
  const state = projectDesktopLiveWorkState({
    agentWorkers: [
      { tag: "build", status: "running", startedAt: 10, sessionId: "private", output: "large" },
      { tag: "old", status: "completed", startedAt: 1, finishedAt: 2 },
    ],
    agentJobs: [
      { task_id: "job-1", type: "review", stage: "running", startedAt: 20, error: "hidden" },
      { task_id: "job-2", status: "success", startedAt: 2 },
    ],
    activeToolSummary: "2:100:1:200",
    remoteEnabled: 1,
  });
  assert.deepEqual(state.agentWorkers, [
    { tag: "build", status: "running", startedAt: 10 },
  ]);
  assert.deepEqual(state.agentJobs, [
    { type: "review", task_id: "job-1", stage: "running", startedAt: 20 },
  ]);
  assert.deepEqual(state.activeTools, {
    explore: { count: 2, startedAt: 100 },
    search: { count: 1, startedAt: 200 },
  });
  assert.equal(state.remoteEnabled, false);
});

test("shell polling backs off while idle and accelerates for engine or shell activity", () => {
  assert.equal(shellJobsPollDelay({ busy: false, commandBusy: false }, 0), 5_000);
  assert.equal(shellJobsPollDelay({ busy: true }, 0), 1_000);
  assert.equal(shellJobsPollDelay({ commandBusy: true }, 0), 1_000);
  assert.equal(shellJobsPollDelay({ busy: false }, 2), 1_000);
});

test("desktop session summaries prioritize manual names over generated titles and previews", () => {
  const summaries = desktopSessionSummaries([
    {
      id: "task_1",
      preview: " Fresh task ",
      updatedAt: 10,
      cwd: "C:\\app\\workspace",
      desktopSession: { classification: "task", projectPath: null },
    },
    {
      id: "project_1",
      preview: "Project work",
      updatedAt: 9,
      cwd: "C:\\work",
      desktopSession: { classification: "project", projectPath: "C:\\work" },
    },
    { id: "cli_1", preview: "CLI lead", cwd: "C:\\cli", desktopSession: null },
    { id: "bad_meta", preview: "Bad", desktopSession: { classification: "worker" } },
    { id: "bad_scalar_meta", preview: "Bad", desktopSession: "project" },
    { id: "bad_project_path", preview: "Bad", desktopSession: { classification: "project", projectPath: {} } },
    { id: "../worker", preview: "invalid" },
  ], "task_1", { task_1: "Generated task title" }, { task_1: "Custom task name" });

  assert.equal(summaries.length, 3);
  assert.deepEqual(summaries[0], {
    id: "task_1",
    preview: "Fresh task",
    title: "Custom task name",
    updatedAt: 10,
    messageCount: 0,
    cwd: "C:\\app\\workspace",
    classification: "task",
    projectPath: null,
    currentSession: true,
  });
  assert.equal(summaries[1].classification, "project");
  assert.equal(summaries[1].projectPath, "C:\\work");
  assert.equal(summaries[2].id, "cli_1");
  assert.equal(summaries[2].classification, "project");
  assert.equal(summaries[2].projectPath, "C:\\cli");
});

test("desktop session summaries hide abandoned blank sessions but keep the active blank", () => {
  const summaries = desktopSessionSummaries([
    {
      id: "blank_active",
      preview: "",
      updatedAt: 30,
      cwd: "C:\\app\\workspace\\unclassified",
      desktopSession: { classification: "task", projectPath: null },
    },
    {
      id: "blank_abandoned",
      preview: "  ",
      updatedAt: 20,
      cwd: "C:\\app\\workspace\\unclassified",
      desktopSession: { classification: "task", projectPath: null },
    },
    {
      id: "blank_named",
      preview: "",
      updatedAt: 10,
      cwd: "C:\\app\\workspace\\unclassified",
      desktopSession: { classification: "task", projectPath: null },
    },
  ], "blank_active", {}, { blank_named: "Kept by name" });

  assert.deepEqual(summaries.map((row) => row.id), ["blank_active", "blank_named"]);
  assert.equal(summaries[0].currentSession, true);
  assert.equal(summaries[1].title, "Kept by name");
});

test("desktop session summaries expose only fresh cross-process heartbeat activity", () => {
  const now = 1_000_000;
  const rows = desktopSessionSummaries([
    {
      id: "fresh_heartbeat",
      preview: "Fresh heartbeat",
      heartbeatAt: now - 1_000,
      cwd: "C:\\work",
    },
    {
      id: "stale_heartbeat",
      preview: "Stale heartbeat",
      heartbeatAt: now - SESSION_WORKING_HEARTBEAT_MS - 1,
      cwd: "C:\\work",
    },
  ], "", {}, {}, now);

  assert.equal(rows.find((row) => row.id === "fresh_heartbeat")?.working, true);
  assert.equal(rows.find((row) => row.id === "stale_heartbeat")?.working, undefined);
});

test("host refreshes session summaries from storage for sidebar listing", async () => {
  const root = await mkdtemp(join(tmpdir(), "mixdog-session-refresh-"));
  const originalCwd = process.cwd();
  const calls = [];
  const newlySaved = {
    id: "desktop_new",
    preview: "New desktop task",
    updatedAt: 20,
    cwd: join(root, "workspace", "unclassified"),
    desktopSession: { classification: "task", projectPath: null },
  };
  const engine = {
    getState: () => ({ sessionId: "desktop_new" }),
    subscribe: () => () => {},
    submit: () => true,
    abort: () => false,
    resolveToolApproval: () => true,
    listProviderModels: async () => [],
    setRoute: async () => true,
    listSessions: (options) => {
      calls.push(options);
      return options?.refreshFromStorage
        ? [
          newlySaved,
          { id: "cli_only", preview: "CLI", desktopSession: null },
          { id: "worker_only", preview: "Worker", desktopSession: { classification: "worker" } },
        ]
        : [];
    },
    newSession: async () => true,
    resume: async () => true,
    dispose: async () => {},
  };
  const host = new EngineHost({ userDataPath: root, createEngine: async () => engine });
  try {
    assert.deepEqual((await host.listSessions()).map((row) => row.id), ["desktop_new", "cli_only"]);
    // Cross-process activity (channel-worker schedule runs) must be visible,
    // so the sidebar listing reads through the on-disk summary index.
    assert.deepEqual(calls, [{ refreshFromStorage: true }]);
  } finally {
    await host.dispose();
    process.chdir(originalCwd);
    await rm(root, { recursive: true, force: true });
  }
});

test("cold session listing never starts the runtime before a foreground action", async () => {
  const root = await mkdtemp(join(tmpdir(), "mixdog-cold-session-list-"));
  const originalCwd = process.cwd();
  const workspace = join(root, "workspace", "unclassified");
  await mkdir(workspace, { recursive: true });
  let engineCreates = 0;
  const storeCalls = [];
  const engine = {
    getState: () => ({ sessionId: null, items: [] }),
    subscribe: () => () => {},
    listSessions: () => [],
    dispose: async () => {},
  };
  const host = new EngineHost({
    userDataPath: root,
    createEngine: async () => {
      engineCreates += 1;
      return engine;
    },
    loadSessionStore: async () => ({
      listStoredSessionSummaries(options) {
        storeCalls.push(options);
        return [{
          id: "cold_indexed",
          preview: "Cold indexed session",
          updatedAt: 1,
          cwd: workspace,
          desktopSession: { classification: "task", projectPath: null },
        }];
      },
    }),
  });
  try {
    assert.deepEqual((await host.listSessions()).map((row) => row.id), ["cold_indexed"]);
    assert.equal(engineCreates, 0, "session list response must win the first paint");
    assert.deepEqual(storeCalls, [{ rebuildIfMissing: true }]);
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(engineCreates, 0, "background work must not compete with a user session choice");
    await host.startTask();
    assert.equal(engineCreates, 1, "the user-selected task should own the first runtime load");
  } finally {
    await host.dispose();
    process.chdir(originalCwd);
    await rm(root, { recursive: true, force: true });
  }
});

test("resume authorization reuses the cached catalog when the selected session is present", async () => {
  const root = await mkdtemp(join(tmpdir(), "mixdog-session-catalog-reuse-"));
  const originalCwd = process.cwd();
  const calls = [];
  let state = { sessionId: null, items: [] };
  const row = {
    id: "desktop_cached",
    preview: "Cached task",
    cwd: join(root, "workspace", "unclassified"),
    desktopSession: { classification: "task", projectPath: null },
  };
  const engine = {
    getState: () => state,
    subscribe: () => () => {},
    listSessions: (options) => {
      calls.push(options);
      return [row];
    },
    switchContext: async () => true,
    newSession: async () => true,
    resume: async (id) => {
      state = { sessionId: id, items: [] };
      return true;
    },
    dispose: async () => {},
  };
  const host = new EngineHost({ userDataPath: root, createEngine: async () => engine });
  try {
    await host.listSessions();
    await host.resumeSession(row.id);
    await host.listSessions();
    // Sidebar listings refresh from storage; the resume authorization in the
    // middle still reuses the cached catalog (no refresh flag).
    assert.deepEqual(calls, [{ refreshFromStorage: true }, undefined, { refreshFromStorage: true }]);
  } finally {
    await host.dispose();
    process.chdir(originalCwd);
    await rm(root, { recursive: true, force: true });
  }
});

test("host persists the first accepted prompt as a stable desktop session title", async () => {
  const root = await mkdtemp(join(tmpdir(), "mixdog-session-title-"));
  const originalCwd = process.cwd();
  const sessionId = "desktop_title";
  let state = { sessionId: null, items: [] };
  const row = {
    id: sessionId,
    preview: "Untitled session",
    updatedAt: 1,
    cwd: join(root, "workspace", "unclassified"),
    desktopSession: { classification: "task", projectPath: null },
  };
  const engine = {
    getState: () => state,
    subscribe: () => () => {},
    submit: (prompt) => {
      const text = String(prompt);
      row.preview = text;
      row.updatedAt += 1;
      state = {
        ...state,
        items: [...state.items, { kind: "user", id: `user_${state.items.length}`, text }],
      };
      return true;
    },
    listSessions: () => [row],
    newSession: async () => {
      state = { sessionId, items: [] };
      return true;
    },
    resume: async () => true,
    dispose: async () => {},
  };
  const host = new EngineHost({ userDataPath: root, createEngine: async () => engine });
  try {
    await host.startTask();
    assert.equal(await host.submit("Build the durable desktop title"), true);
    assert.equal((await host.listSessions())[0].title, "Build the durable desktop title");
    assert.equal(host.getSnapshot().desktopSessionTitle, "Build the durable desktop title");

    assert.equal(await host.submit("A newer preview must not rename this session"), true);
    const listed = await host.listSessions();
    assert.equal(listed[0].preview, "A newer preview must not rename this session");
    assert.equal(listed[0].title, "Build the durable desktop title");

    await host.dispose();
    const metadata = JSON.parse(await readFile(
      join(root, "desktop-session-metadata.json"),
      "utf8",
    ));
    assert.deepEqual(metadata, {
      version: 2,
      titles: { [sessionId]: "Build the durable desktop title" },
      names: {},
    });
  } finally {
    await host.dispose();
    process.chdir(originalCwd);
    await rm(root, { recursive: true, force: true });
  }
});

test("host persists user-renamed session titles and restores the override after restart", async () => {
  const root = await mkdtemp(join(tmpdir(), "mixdog-session-rename-"));
  const originalCwd = process.cwd();
  const row = {
    id: "desktop_rename",
    preview: "Generated title",
    cwd: join(root, "workspace", "unclassified"),
    desktopSession: { classification: "task", projectPath: null },
  };
  const engine = {
    getState: () => ({ sessionId: row.id, items: [] }),
    subscribe: () => () => {},
    listSessions: () => [row],
    dispose: async () => {},
  };
  const createHost = () => new EngineHost({ userDataPath: root, createEngine: async () => engine });
  const host = createHost();
  try {
    assert.equal((await host.listSessions())[0].title, "Generated title");
    await host.renameSession(row.id, "  Durable custom title  ");
    assert.equal((await host.listSessions())[0].title, "Durable custom title");
    await assert.rejects(host.renameSession("missing", "No session"), /not available/);
    await host.dispose();
    const metadata = JSON.parse(await readFile(
      join(root, "desktop-session-metadata.json"),
      "utf8",
    ));
    assert.deepEqual(metadata, {
      version: 2,
      titles: {},
      names: { [row.id]: "Durable custom title" },
    });

    const restarted = createHost();
    try {
      assert.equal((await restarted.listSessions())[0].title, "Durable custom title");
      assert.equal(restarted.getSnapshot().desktopSessionTitle, "Durable custom title");
    } finally {
      await restarted.dispose();
    }
  } finally {
    await host.dispose();
    process.chdir(originalCwd);
    await rm(root, { recursive: true, force: true });
  }
});

test("host deletes session metadata and returns the replacement snapshot for the active session", async () => {
  const root = await mkdtemp(join(tmpdir(), "mixdog-session-delete-"));
  const originalCwd = process.cwd();
  const rows = [
    {
      id: "desktop_active_delete",
      preview: "Active delete",
      cwd: join(root, "workspace", "unclassified"),
      desktopSession: { classification: "task", projectPath: null },
    },
    {
      id: "desktop_inactive_delete",
      preview: "Inactive delete",
      cwd: join(root, "workspace", "unclassified"),
      desktopSession: { classification: "task", projectPath: null },
    },
  ];
  let state = { sessionId: rows[0].id, items: [{ kind: "user", text: "Active delete" }] };
  const deleted = [];
  await writeFile(join(root, "desktop-session-metadata.json"), JSON.stringify({
    version: 2,
    titles: { [rows[0].id]: "Active title", [rows[1].id]: "Inactive title" },
    names: { [rows[0].id]: "Active name", [rows[1].id]: "Inactive name" },
  }));
  const engine = {
    getState: () => state,
    subscribe: () => () => {},
    listSessions: () => rows,
    deleteSession: async (id) => {
      deleted.push(id);
      const index = rows.findIndex((row) => row.id === id);
      if (index < 0) return false;
      rows.splice(index, 1);
      if (state.sessionId === id) state = { sessionId: null, items: [], queued: [] };
      return true;
    },
    dispose: async () => {},
  };
  const host = new EngineHost({ userDataPath: root, createEngine: async () => engine });
  try {
    await host.listSessions();
    assert.equal((await host.deleteSession("desktop_inactive_delete")).sessionId, rows[0].id);
    assert.equal((await host.deleteSession("desktop_active_delete")).sessionId, null);
    assert.deepEqual(deleted, ["desktop_inactive_delete", "desktop_active_delete"]);
    await host.dispose();
    const metadata = JSON.parse(await readFile(
      join(root, "desktop-session-metadata.json"),
      "utf8",
    ));
    assert.deepEqual(metadata, { version: 2, titles: {}, names: {} });
  } finally {
    await host.dispose();
    process.chdir(originalCwd);
    await rm(root, { recursive: true, force: true });
  }
});

test("host migrates legacy title overrides into manual names without changing their display", async () => {
  const root = await mkdtemp(join(tmpdir(), "mixdog-session-title-migration-"));
  const originalCwd = process.cwd();
  const row = {
    id: "desktop_legacy_title",
    preview: "Newer preview",
    cwd: join(root, "workspace", "unclassified"),
    desktopSession: { classification: "task", projectPath: null },
  };
  await writeFile(join(root, "desktop-session-metadata.json"), JSON.stringify({
    version: 1,
    titles: { [row.id]: "Legacy preserved title" },
  }));
  const engine = {
    getState: () => ({ sessionId: row.id, items: [] }),
    subscribe: () => () => {},
    listSessions: () => [row],
    dispose: async () => {},
  };
  const host = new EngineHost({ userDataPath: root, createEngine: async () => engine });
  try {
    assert.equal((await host.listSessions())[0].title, "Legacy preserved title");
    await host.renameSession(row.id, "Migrated custom name");
    await host.dispose();
    const metadata = JSON.parse(await readFile(
      join(root, "desktop-session-metadata.json"),
      "utf8",
    ));
    assert.deepEqual(metadata, {
      version: 2,
      titles: {},
      names: { [row.id]: "Migrated custom name" },
    });
  } finally {
    await host.dispose();
    process.chdir(originalCwd);
    await rm(root, { recursive: true, force: true });
  }
});

test("host removes polluted generated titles while preserving manual session names", async () => {
  const root = await mkdtemp(join(tmpdir(), "mixdog-session-generated-title-cleanup-"));
  const originalCwd = process.cwd();
  const rows = [
    {
      id: "desktop_polluted_title",
      preview: "Fix transcript filtering",
      cwd: join(root, "workspace", "unclassified"),
      desktopSession: { classification: "task", projectPath: null },
    },
    {
      id: "desktop_manual_title",
      preview: "A later preview",
      cwd: join(root, "workspace", "unclassified"),
      desktopSession: { classification: "task", projectPath: null },
    },
  ];
  await writeFile(join(root, "desktop-session-metadata.json"), JSON.stringify({
    version: 2,
    titles: {
      desktop_polluted_title:
        "A previous model worked on this task and produced the compacted handoff summary below. Build on it.",
    },
    names: { desktop_manual_title: "Keep my manual title" },
  }));
  const engine = {
    getState: () => ({ sessionId: rows[0].id, items: [] }),
    subscribe: () => () => {},
    listSessions: () => rows,
    dispose: async () => {},
  };
  const host = new EngineHost({ userDataPath: root, createEngine: async () => engine });
  try {
    const listed = await host.listSessions();
    assert.equal(listed.find((row) => row.id === "desktop_polluted_title").title,
      "Fix transcript filtering");
    assert.equal(listed.find((row) => row.id === "desktop_manual_title").title,
      "Keep my manual title");
    await host.dispose();
    const metadata = JSON.parse(await readFile(
      join(root, "desktop-session-metadata.json"),
      "utf8",
    ));
    assert.deepEqual(metadata, {
      version: 2,
      titles: {},
      names: { desktop_manual_title: "Keep my manual title" },
    });
  } finally {
    await host.dispose();
    process.chdir(originalCwd);
    await rm(root, { recursive: true, force: true });
  }
});

test("host recovers corrupt session title metadata and atomically replaces it", async () => {
  const root = await mkdtemp(join(tmpdir(), "mixdog-session-corrupt-title-"));
  const originalCwd = process.cwd();
  const row = {
    id: "desktop_recovered",
    preview: "Recovered preview",
    cwd: join(root, "workspace", "unclassified"),
    desktopSession: { classification: "task", projectPath: null },
  };
  await writeFile(join(root, "desktop-session-metadata.json"), '{"version":1,"titles":');
  const engine = {
    getState: () => ({ sessionId: row.id, items: [] }),
    subscribe: () => () => {},
    listSessions: () => [row],
    dispose: async () => {},
  };
  const host = new EngineHost({ userDataPath: root, createEngine: async () => engine });
  try {
    assert.equal((await host.listSessions())[0].title, "Recovered preview");
    await host.renameSession(row.id, "Recovered custom title");
    const saved = JSON.parse(await readFile(join(root, "desktop-session-metadata.json"), "utf8"));
    assert.deepEqual(saved, {
      version: 2,
      titles: {},
      names: { [row.id]: "Recovered custom title" },
    });
  } finally {
    await host.dispose();
    process.chdir(originalCwd);
    await rm(root, { recursive: true, force: true });
  }
});

test("host recovers null and array session metadata roots", async () => {
  for (const [name, metadata] of [["null", "null"], ["array", "[]"]]) {
    const root = await mkdtemp(join(tmpdir(), `mixdog-session-${name}-title-`));
    const originalCwd = process.cwd();
    const row = {
      id: `desktop_${name}`,
      preview: `${name} preview`,
      cwd: join(root, "workspace", "unclassified"),
      desktopSession: { classification: "task", projectPath: null },
    };
    await writeFile(join(root, "desktop-session-metadata.json"), metadata);
    const engine = {
      getState: () => ({ sessionId: row.id, items: [] }),
      subscribe: () => () => {},
      listSessions: () => [row],
      dispose: async () => {},
    };
    const host = new EngineHost({ userDataPath: root, createEngine: async () => engine });
    try {
      assert.equal((await host.listSessions())[0].title, `${name} preview`);
    } finally {
      await host.dispose();
      process.chdir(originalCwd);
      await rm(root, { recursive: true, force: true });
    }
  }
});

test("session title overrides safely support prototype-shaped session ids", async () => {
  const root = await mkdtemp(join(tmpdir(), "mixdog-session-proto-title-"));
  const originalCwd = process.cwd();
  const rows = ["__proto__", "constructor"].map((id) => ({
    id,
    preview: `Preview ${id}`,
    cwd: join(root, "workspace", "unclassified"),
    desktopSession: { classification: "task", projectPath: null },
  }));
  const engine = {
    getState: () => ({ sessionId: rows[0].id, items: [] }),
    subscribe: () => () => {},
    listSessions: () => rows,
    dispose: async () => {},
  };
  const createHost = () => new EngineHost({ userDataPath: root, createEngine: async () => engine });
  const host = createHost();
  try {
    await host.listSessions();
    await host.renameSession("__proto__", "Prototype title");
    await host.renameSession("constructor", "Constructor title");
    await host.dispose();
    const restarted = createHost();
    try {
      const listed = await restarted.listSessions();
      assert.equal(listed.find((row) => row.id === "__proto__").title, "Prototype title");
      assert.equal(listed.find((row) => row.id === "constructor").title, "Constructor title");
    } finally {
      await restarted.dispose();
    }
  } finally {
    await host.dispose();
    process.chdir(originalCwd);
    await rm(root, { recursive: true, force: true });
  }
});

test("project file traversal enforces its scan cap before consuming a directory", async () => {
  const root = await mkdtemp(join(tmpdir(), "mixdog-file-search-cap-"));
  try {
    await Promise.all(Array.from({ length: 20 }, (_, index) =>
      writeFile(join(root, `file-${String(index).padStart(2, "0")}.ts`), "")));
    const results = await searchProjectDirectory(root, "", 20, {
      maxScannedEntries: 3,
      yieldEvery: 1,
    });
    assert.equal(results.length, 3);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("host searches active project files with fuzzy matching, ignore pruning, and caps", async () => {
  const root = await mkdtemp(join(tmpdir(), "mixdog-file-search-"));
  const project = join(root, "project");
  const originalCwd = process.cwd();
  await Promise.all([
    mkdir(join(project, "src", "components", "generated"), { recursive: true }),
    mkdir(join(project, "node_modules", "package"), { recursive: true }),
    mkdir(join(project, ".git"), { recursive: true }),
    mkdir(join(project, "generated"), { recursive: true }),
  ]);
  await Promise.all([
    writeFile(join(project, ".gitignore"), "generated/\n*.log\n"),
    writeFile(join(project, "src", "components", "FilePicker.ts"), ""),
    writeFile(join(project, "src", "components", ".gitignore"), "generated/\n"),
    writeFile(join(project, "src", "components", "generated", "NestedIgnored.ts"), ""),
    writeFile(join(project, "src", "file-utils.ts"), ""),
    writeFile(join(project, "debug.log"), ""),
    writeFile(join(project, "node_modules", "package", "file.ts"), ""),
    writeFile(join(project, ".git", "config"), ""),
    writeFile(join(project, "generated", "file.ts"), ""),
  ]);
  const projectStore = createProjectStore([{ path: project }]);
  const engine = {
    getState: () => ({ sessionId: null, items: [] }),
    subscribe: () => () => {},
    listSessions: () => [],
    dispose: async () => {},
  };
  const host = new EngineHost({
    userDataPath: root,
    createEngine: async () => engine,
    loadProjects: async () => projectStore.module,
  });
  try {
    const snapshot = await host.startProject(project);
    const active = snapshot.currentProject;
    assert.deepEqual(await host.searchProjectFiles(active, "fp", 10), [
      "src/components/FilePicker.ts",
    ]);
    assert.deepEqual(await host.searchProjectFiles(active, "file", 1), [
      "src/components/FilePicker.ts",
    ]);
    const all = await host.searchProjectFiles(active, "", 20);
    assert.equal(all.includes("debug.log"), false);
    assert.equal(all.some((path) => path.startsWith("node_modules/")), false);
    assert.equal(all.some((path) => path.startsWith(".git/")), false);
    assert.equal(all.some((path) => path.startsWith("generated/")), false);
    assert.equal(all.includes("src/components/generated/NestedIgnored.ts"), false);
    await assert.rejects(host.searchProjectFiles(root, "file", 10), /not active/);
  } finally {
    await host.dispose();
    process.chdir(originalCwd);
    await rm(root, { recursive: true, force: true });
  }
});

test("host rejects file search results when the active project changes during traversal", async () => {
  const root = await mkdtemp(join(tmpdir(), "mixdog-file-search-stale-"));
  const first = join(root, "first");
  const second = join(root, "second");
  const originalCwd = process.cwd();
  await Promise.all([mkdir(first), mkdir(second)]);
  const projectStore = createProjectStore([{ path: first }, { path: second }]);
  let releaseSearch;
  const searchStarted = new Promise((resolve) => {
    releaseSearch = resolve;
  });
  let traversalStarted;
  const traversalPending = new Promise((resolve) => {
    traversalStarted = resolve;
  });
  const engine = {
    getState: () => ({ sessionId: null, items: [] }),
    subscribe: () => () => {},
    listSessions: () => [],
    switchContext: async () => true,
    dispose: async () => {},
  };
  const host = new EngineHost({
    userDataPath: root,
    createEngine: async () => engine,
    loadProjects: async () => projectStore.module,
    searchProjectDirectory: async () => {
      traversalStarted();
      await searchStarted;
      return ["stale.ts"];
    },
  });
  try {
    const firstSnapshot = await host.startProject(first);
    const pending = host.searchProjectFiles(firstSnapshot.currentProject, "", 10);
    await traversalPending;
    await host.startProject(second);
    releaseSearch();
    await assert.rejects(pending, /changed during file search/);
  } finally {
    await host.dispose();
    process.chdir(originalCwd);
    await rm(root, { recursive: true, force: true });
  }
});

test("host resumes another desktop task session in the same managed context without switching", async () => {
  const root = await mkdtemp(join(tmpdir(), "mixdog-session-resume-same-context-"));
  const originalCwd = process.cwd();
  const workspace = join(root, "workspace", "unclassified");
  const rows = ["desktop_first", "desktop_second"].map((id, index) => ({
    id,
    preview: `Task ${index + 1}`,
    updatedAt: 2 - index,
    cwd: workspace,
    desktopSession: { classification: "task", projectPath: null },
  }));
  let state = { sessionId: null, items: [] };
  const resumed = [];
  let switched = 0;
  let disposed = 0;
  const engine = {
    getState: () => state,
    subscribe: () => () => {},
    submit: () => true,
    listSessions: () => rows,
    switchContext: async () => {
      switched += 1;
      return true;
    },
    newSession: async () => {
      state = { sessionId: "desktop_first", items: [] };
      return true;
    },
    resume: async (id) => {
      resumed.push(id);
      state = { sessionId: id, items: [{ kind: "user", id: "first", text: "Task 2" }] };
      return true;
    },
    dispose: async () => { disposed += 1; },
  };
  const host = new EngineHost({ userDataPath: root, createEngine: async () => engine });
  try {
    await host.startTask();
    const snapshot = await host.resumeSession("desktop_second");

    assert.deepEqual(resumed, ["desktop_second"]);
    assert.equal(switched, 0);
    assert.equal(disposed, 0);
    assert.equal(snapshot.sessionId, "desktop_second");
  } finally {
    await host.dispose();
    assert.equal(disposed, 1);
    process.chdir(originalCwd);
    await rm(root, { recursive: true, force: true });
  }
});

test("host reuses one legacy workspace context and publishes the detached resume result", async () => {
  const root = await mkdtemp(join(tmpdir(), "mixdog-session-resume-legacy-context-"));
  const originalCwd = process.cwd();
  const taskWorkspace = join(root, "workspace", "unclassified");
  const legacyWorkspace = join(root, "legacy-project");
  await Promise.all([
    mkdir(taskWorkspace, { recursive: true }),
    mkdir(legacyWorkspace, { recursive: true }),
  ]);
  const rows = ["legacy_first", "legacy_second"].map((id, index) => ({
    id,
    preview: `Legacy ${index + 1}`,
    updatedAt: 2 - index,
    cwd: legacyWorkspace,
  }));
  let state = { sessionId: null, items: [], queued: [] };
  const resumed = [];
  let switched = 0;
  let disposed = 0;
  const engine = {
    getState: () => state,
    subscribe: () => () => {},
    listSessions: () => rows,
    switchContext: async () => {
      switched += 1;
      return true;
    },
    resume: async (id) => {
      resumed.push(id);
      state = { sessionId: id, items: [], queued: [] };
      return true;
    },
    dispose: async () => { disposed += 1; },
  };
  const host = new EngineHost({ userDataPath: root, createEngine: async () => engine });
  const publications = [];
  const unsubscribe = host.subscribe((snapshot) => publications.push(snapshot));
  try {
    await host.resumeSession("legacy_first");
    publications.length = 0;
    const snapshot = await host.resumeSession("legacy_second");

    assert.deepEqual(resumed, ["legacy_first", "legacy_second"]);
    assert.equal(switched, 1, "only the initial task-to-legacy context transition should reset context");
    assert.equal(disposed, 0);
    assert.equal(publications.length, 1);
    assert.equal(publications[0], snapshot,
      "the held state publication should reuse the detached snapshot returned by resume");
    assert.equal(snapshot.sessionId, "legacy_second");
  } finally {
    unsubscribe();
    await host.dispose();
    assert.equal(disposed, 1);
    process.chdir(originalCwd);
    await rm(root, { recursive: true, force: true });
  }
});

test("host rejects a resume result that remains bound to the previous session", async () => {
  const root = await mkdtemp(join(tmpdir(), "mixdog-session-resume-mismatch-"));
  const originalCwd = process.cwd();
  const workspace = join(root, "workspace", "unclassified");
  const rows = ["desktop_first", "desktop_second"].map((id, index) => ({
    id,
    preview: `Task ${index + 1}`,
    updatedAt: 2 - index,
    cwd: workspace,
    desktopSession: { classification: "task", projectPath: null },
  }));
  const state = {
    sessionId: "desktop_first",
    items: [{ kind: "user", id: "first", text: "Previous task" }],
  };
  const engine = {
    getState: () => state,
    subscribe: () => () => {},
    listSessions: () => rows,
    resume: async () => true,
    dispose: async () => {},
  };
  const host = new EngineHost({ userDataPath: root, createEngine: async () => engine });
  try {
    await host.startTask();
    await assert.rejects(
      () => host.resumeSession("desktop_second"),
      /unexpected session/i,
    );
    assert.equal(host.getSnapshot().sessionId, "desktop_first");
  } finally {
    await host.dispose();
    process.chdir(originalCwd);
    await rm(root, { recursive: true, force: true });
  }
});

test("desktop IPC session id validation rejects path-like input", () => {
  assert.equal(requiredSessionId(" session_123 "), "session_123");
  assert.equal(requiredSessionId("a".repeat(256)), "a".repeat(256));
  assert.throws(() => requiredSessionId("../session"), /invalid/);
  assert.throws(() => requiredSessionId("a/b"), /invalid/);
  assert.throws(() => requiredSessionId("a".repeat(257)), /invalid/);
  assert.throws(() => requiredSessionId(123), /string/);
});

test("desktop IPC enforces the owning main frame and validates bridge arguments", async () => {
  const handlers = new Map();
  const removed = [];
  const ipcMain = {
    handle: (channel, listener) => handlers.set(channel, listener),
    removeHandler: (channel) => {
      removed.push(channel);
      handlers.delete(channel);
    },
    on: () => {},
    removeListener: () => {},
  };
  const mainFrame = {};
  const sent = [];
  const webContents = {
    mainFrame,
    isDestroyed: () => false,
    send: (...args) => { sent.push(args); },
  };
  const window = {
    webContents,
    isDestroyed: () => false,
  };
  const calls = [];
  let quitCalls = 0;
  let disposeCalls = 0;
  let unsubscribed = false;
  let updaterUnsubscribed = false;
  let updaterInstalls = 0;
  const updaterState = { status: "ready", version: "2.0.0" };
  const host = {
    startProject: async (path) => { calls.push(["startProject", path]); return null; },
    startTask: async () => { calls.push(["startTask"]); return null; },
    listSessions: async () => { calls.push(["listSessions"]); return []; },
    renameSession: async (id, title) => { calls.push(["renameSession", id, title]); },
    deleteSession: async (id) => { calls.push(["deleteSession", id]); return null; },
    prefetchSession: async (id) => { calls.push(["prefetchSession", id]); return true; },
    resumeSession: async (id) => {
      calls.push(["resumeSession", id]);
      return {
        sessionId: id,
        sessionForkedFrom: "source",
        desktopSessionTitle: "Resumed",
        items: [{ id: "large-row", text: "must not cross invoke twice" }],
      };
    },
    searchProjectFiles: async (id, query, limit) => {
      calls.push(["searchProjectFiles", id, query, limit]);
      return ["src/index.ts"];
    },
    getSnapshot: () => null,
    submit: (prompt, options) => { calls.push(["submit", prompt, options]); return true; },
    abort: () => false,
    resolveToolApproval: () => true,
    listProviderModels: async () => {
      calls.push(["listProviderModels"]);
      return [];
    },
    setModelRoute: async (selection) => {
      calls.push(["setModelRoute", selection]);
      return null;
    },
    setFast: async (enabled) => {
      calls.push(["setFast", enabled]);
      return null;
    },
    invokeCapability: async (capability, args) => {
      calls.push(["invokeCapability", capability, args]);
      return { value: true, snapshot: null };
    },
    readCapabilities: async (requests) => {
      calls.push(["readCapabilities", requests]);
      return requests.map((request) => ({ ok: true, value: request.capability }));
    },
    listProjects: async () => [],
    startProjectTask: async (path) => { calls.push(["startProjectTask", path]); return null; },
    projectDirectory: async (path) => { calls.push(["projectDirectory", path]); return "C:\\canonical"; },
    renameProject: async (path, alias) => { calls.push(["renameProject", path, alias]); },
    setProjectPinned: async (path, pinned) => { calls.push(["setProjectPinned", path, pinned]); },
    removeProject: async (path) => { calls.push(["removeProject", path]); },
    dispose: async () => { disposeCalls += 1; },
    subscribe: () => () => { unsubscribed = true; },
    subscribeSessions: () => () => {},
  };
  const remove = registerDesktopIpc(window, host, {
    app: { quit: () => { quitCalls += 1; } },
    ipcMain,
    dialog: {
      showOpenDialog: async () => ({ canceled: true, filePaths: [] }),
      showMessageBox: async () => ({ response: 0 }),
    },
    shell: {
      openPath: async (path) => { calls.push(["openPath", path]); return ""; },
      openExternal: async (url) => { calls.push(["openExternal", url]); },
    },
    updater: {
      getState: () => updaterState,
      subscribe: (listener) => {
        listener(updaterState);
        return () => { updaterUnsubscribed = true; };
      },
      check: async () => updaterState,
      install: async () => { updaterInstalls += 1; },
    },
  });
  const validEvent = { sender: webContents, senderFrame: mainFrame };
  const invoke = (channel, event, ...args) => handlers.get(channel)(event, ...args);

  assert.throws(
    () => invoke(DESKTOP_IPC.startTask, { sender: {}, senderFrame: mainFrame }),
    /rejected/,
  );
  assert.throws(
    () => invoke(DESKTOP_IPC.listSessions, { sender: webContents, senderFrame: {} }),
    /rejected/,
  );
  await invoke(DESKTOP_IPC.startTask, validEvent);
  await invoke(DESKTOP_IPC.listSessions, validEvent);
  await invoke(DESKTOP_IPC.renameSession, validEvent, " rename_1 ", " New name ");
  await invoke(DESKTOP_IPC.deleteSession, validEvent, " delete_1 ");
  await invoke(DESKTOP_IPC.prefetchSession, validEvent, " resume_1 ");
  const resumeAck = await invoke(DESKTOP_IPC.resumeSession, validEvent, " resume_1 ");
  assert.deepEqual(resumeAck, {
    sessionId: "resume_1",
    sessionForkedFrom: "source",
    desktopSessionTitle: "Resumed",
  });
  await invoke(DESKTOP_IPC.searchProjectFiles, validEvent, " C:\\known ", "index", 12);
  await invoke(DESKTOP_IPC.listProviderModels, validEvent);
  await invoke(DESKTOP_IPC.setModelRoute, validEvent, {
    provider: " openai ",
    model: " gpt-5 ",
    effort: " high ",
    fast: true,
  });
  await invoke(DESKTOP_IPC.setFast, validEvent, true);
  await invoke(DESKTOP_IPC.invokeCapability, validEvent, {
    capability: "setMemoryEnabled",
    args: [false],
  });
  const reads = await invoke(DESKTOP_IPC.readCapabilities, validEvent, [
    { capability: "getProfile" },
    { capability: "getChannelSettings", args: [{ includeStatus: false }] },
    { capability: "getProviderSetup", args: [{ refresh: true }] },
  ]);
  assert.deepEqual(reads.map((result) => result.value), ["getProfile", "getChannelSettings", "getProviderSetup"]);
  assert.deepEqual(await invoke(DESKTOP_IPC.getUpdaterState, validEvent), updaterState);
  assert.deepEqual(await invoke(DESKTOP_IPC.checkForDesktopUpdate, validEvent), updaterState);
  assert.deepEqual(await invoke(DESKTOP_IPC.showDesktopUpdate, validEvent), updaterState);
  assert.equal(updaterInstalls, 1);
  assert.ok(sent.some(([channel, value]) =>
    channel === DESKTOP_IPC.updaterState && value.version === "2.0.0"));
  await Promise.all([
    invoke(DESKTOP_IPC.quit, validEvent),
    invoke(DESKTOP_IPC.quit, validEvent),
  ]);
  assert.equal(disposeCalls, 1);
  assert.equal(quitCalls, 1);
  assert.deepEqual(calls.slice(0, 10), [
    ["startTask"],
    ["listSessions"],
    ["renameSession", "rename_1", "New name"],
    ["deleteSession", "delete_1"],
    ["prefetchSession", "resume_1"],
    ["resumeSession", "resume_1"],
    ["searchProjectFiles", "C:\\known", "index", 12],
    ["listProviderModels"],
    ["setModelRoute", { provider: "openai", model: "gpt-5", effort: "high", fast: true }],
    ["setFast", true],
  ]);
  await invoke(DESKTOP_IPC.openExternal, validEvent, "https://example.com/docs?q=1");
  assert.deepEqual(calls.at(-1), ["openExternal", "https://example.com/docs?q=1"]);
  assert.throws(
    () => invoke(DESKTOP_IPC.openExternal, validEvent, "file:///C:/secret.txt"),
    /protocol is unsupported/,
  );

  await assert.rejects(
    invoke(DESKTOP_IPC.resumeSession, validEvent, "../resume"),
    /invalid/,
  );
  assert.throws(
    () => invoke(DESKTOP_IPC.deleteSession, validEvent, "../delete"),
    /invalid/,
  );
  await assert.rejects(
    invoke(DESKTOP_IPC.resumeSession, validEvent, "a".repeat(257)),
    /invalid/,
  );
  assert.throws(
    () => invoke(DESKTOP_IPC.renameSession, validEvent, "rename_1", " "),
    /title is invalid/,
  );
  assert.throws(
    () => invoke(DESKTOP_IPC.searchProjectFiles, validEvent, "C:\\known", "index", 0),
    /limit is invalid/,
  );
  assert.throws(
    () => invoke(DESKTOP_IPC.startProject, validEvent, " "),
    /projectPath is invalid/,
  );
  assert.throws(
    () => invoke(DESKTOP_IPC.submit, validEvent, 42),
    /prompt content is invalid/,
  );
  await assert.rejects(
    invoke(DESKTOP_IPC.invokeCapability, validEvent, {
      capability: "setMemoryEnabled",
      args: [],
    }),
    /invalid number of arguments/,
  );
  await assert.rejects(
    invoke(DESKTOP_IPC.invokeCapability, validEvent, {
      capability: "require",
      args: ["node:fs"],
    }),
    /unavailable/,
  );
  assert.throws(
    () => invoke(DESKTOP_IPC.readCapabilities, validEvent, [
      { capability: "setMemoryEnabled", args: [true] },
    ]),
    /not read-only/,
  );
  assert.throws(
    () => invoke(DESKTOP_IPC.setModelRoute, validEvent, { provider: "openai", model: "gpt-5", effort: 1 }),
    /selection.effort must be a string/,
  );
  assert.throws(
    () => invoke(DESKTOP_IPC.setModelRoute, validEvent, { provider: " ", model: "gpt-5" }),
    /selection.provider is invalid/,
  );
  assert.throws(
    () => invoke(DESKTOP_IPC.setModelRoute, validEvent, { provider: "openai", model: "gpt-5", fast: "yes" }),
    /selection.fast must be a boolean/,
  );
  assert.throws(
    () => invoke(DESKTOP_IPC.setFast, validEvent, "yes"),
    /enabled must be a boolean/,
  );
  assert.throws(
    () => invoke(DESKTOP_IPC.listProviderModels, validEvent, { force: "yes" }),
    /catalog options are invalid/,
  );
  await assert.rejects(
    invoke(DESKTOP_IPC.invokeCapability, validEvent, {
      capability: "getProviderSetup",
      args: [{ refresh: "yes" }],
    }),
    /provider setup options are invalid/,
  );
  await invoke(DESKTOP_IPC.renameProject, validEvent, " C:\\known ", "   ");
  assert.deepEqual(calls.at(-1), ["renameProject", "C:\\known", ""]);
  assert.throws(
    () => invoke(DESKTOP_IPC.renameProject, validEvent, "C:\\known", "bad\nname"),
    /alias is invalid/,
  );
  await invoke(DESKTOP_IPC.openProjectInExplorer, validEvent, " C:\\known ");
  assert.deepEqual(calls.slice(-2), [
    ["projectDirectory", "C:\\known"],
    ["openPath", "C:\\canonical"],
  ]);
  assert.throws(
    () => invoke(DESKTOP_IPC.setProjectPinned, validEvent, "C:\\known", "yes"),
    /boolean/,
  );

  remove();
  assert.equal(unsubscribed, true);
  assert.equal(updaterUnsubscribed, true);
  assert.equal(handlers.size, 0);
  assert.deepEqual(new Set(removed), new Set(
    Object.values(DESKTOP_IPC).filter((channel) =>
      channel !== DESKTOP_IPC.state && channel !== DESKTOP_IPC.updaterState
      && channel !== DESKTOP_IPC.perfLog && channel !== DESKTOP_IPC.termData
      && channel !== DESKTOP_IPC.termWrite && channel !== DESKTOP_IPC.termResize
      && channel !== DESKTOP_IPC.sessionsChanged && channel !== DESKTOP_IPC.stateResync),
  ));
});

test("desktop IPC state pushes ride identity-prefix transcript deltas", () => {
  const ipcMain = {
    handle: () => {},
    removeHandler: () => {},
    on: () => {},
    removeListener: () => {},
  };
  const sent = [];
  const webContents = { mainFrame: {}, isDestroyed: () => false, send: (...args) => { sent.push(args); } };
  const window = { webContents, isDestroyed: () => false };
  let publish;
  const host = {
    subscribe: (listener) => { publish = listener; return () => {}; },
    subscribeSessions: () => () => {},
    getSnapshot: () => null,
  };
  const remove = registerDesktopIpc(window, host, {
    app: { quit: () => {} },
    ipcMain,
    dialog: {},
    shell: {},
  });
  try {
    const itemA = { id: 1, kind: "user", text: "hello" };
    const itemB = { id: 2, kind: "assistant", text: "hi" };
    const itemB2 = { id: 2, kind: "assistant", text: "hi there" };
    publish({ items: [itemA], busy: true });
    publish({ items: [itemA, itemB], busy: true });
    publish({ items: [itemA, itemB2], busy: false });
    publish(null);
    publish({ items: [itemA], busy: false });
    const states = sent.filter(([channel]) => channel === DESKTOP_IPC.state).map(([, payload]) => payload);
    assert.equal(states.length, 5);
    // First send with items: full snapshot tagged with a revision.
    assert.equal(states[0].__itemsRevision, 1);
    assert.deepEqual(states[0].items, [itemA]);
    // Append: shared identity prefix travels as an offset, not as data.
    assert.equal(states[1].items, undefined);
    assert.deepEqual(states[1].__itemsPatch, { base: 1, revision: 2, prefix: 1, append: [itemB] });
    // In-place tail replacement (streaming): only the changed suffix is sent.
    assert.deepEqual(states[2].__itemsPatch, { base: 2, revision: 3, prefix: 1, append: [itemB2] });
    assert.equal(states[2].busy, false);
    // A null/itemless snapshot resets the stream: the next send is full again.
    assert.equal(states[3], null);
    assert.equal(states[4].__itemsRevision, 4);
    assert.deepEqual(states[4].items, [itemA]);
  } finally {
    remove();
  }
});

test("desktop fast data follows core catalog capability and persisted preference semantics", () => {
  assert.equal(fastCapableFor("openai", { id: "gpt-5.4" }), true);
  assert.equal(fastCapableFor("openai", { id: "gpt-4.1" }), false);
  assert.equal(fastCapableFor("openai-oauth", {
    id: "gpt-5",
    serviceTiers: [{ id: "priority" }],
  }), true);
  assert.equal(fastCapableFor("openai-oauth", { id: "gpt-5-mini" }), false);
  assert.equal(fastCapableFor("gemini", { id: "gemini-3-pro" }), false);

  let persisted = null;
  const cfgMod = {
    loadConfig: () => ({}),
    saveConfig: (value) => { persisted = structuredClone(value); },
  };
  const supportedRoute = { provider: "openai", model: "gpt-5.4", fast: true };
  const supportedConfig = saveModelSettings(cfgMod, supportedRoute, {
    fastCapable: fastCapableFor(supportedRoute.provider, supportedRoute.model),
    baseConfig: {},
  });
  assert.deepEqual(persisted, supportedConfig);
  assert.equal(fastPreferenceFor(supportedConfig, "openai", "gpt-5.4"), true);
  assert.equal(supportedConfig.fastModels["openai/gpt-5.4"], true);

  const unsupportedRoute = { provider: "openai", model: "gpt-4.1", fast: true };
  const unsupportedConfig = saveModelSettings(cfgMod, unsupportedRoute, {
    fastCapable: fastCapableFor(unsupportedRoute.provider, unsupportedRoute.model),
    baseConfig: {
      modelSettings: {},
      fastModels: { "openai/gpt-4.1": true },
    },
  });
  assert.equal(unsupportedConfig.modelSettings["openai/gpt-4.1"].fast, false);
  assert.equal(fastPreferenceFor(unsupportedConfig, "openai", "gpt-4.1"), false);
  assert.equal("openai/gpt-4.1" in unsupportedConfig.fastModels, false);
});

test("Fast preference works before a desktop session exists and is applied on first submit", async () => {
  const root = await mkdtemp(join(tmpdir(), "mixdog-pristine-fast-"));
  const originalCwd = process.cwd();
  let preference = false;
  let state = {
    sessionId: null,
    items: [],
    busy: false,
    commandBusy: false,
    fast: false,
    fastCapable: true,
  };
  const calls = [];
    const engine = {
      getState: () => state,
      subscribe: () => () => {},
      submit: () => true,
    switchContext: async () => {
      state = { ...state, sessionId: null, items: [], fast: false };
      return true;
    },
    setFast: async (enabled) => {
      calls.push(["setFast", enabled, state.sessionId]);
      preference = enabled;
      if (state.sessionId) state = { ...state, fast: enabled };
      return enabled;
    },
    newSession: async () => {
      state = { ...state, sessionId: "desktop_pristine", fast: preference };
      return true;
    },
    listSessions: () => [],
    dispose: async () => {},
  };
  const host = new EngineHost({ userDataPath: root, createEngine: async () => engine });
  try {
    const pristine = await host.setFast(true);
    assert.equal(pristine.sessionId, null);
    assert.equal(pristine.fast, true);
    assert.deepEqual(calls, [["setFast", true, null]]);

    const active = await host.startTask();
    assert.equal(active.sessionId, null);
    assert.equal(active.fast, true);
    assert.equal(await host.submit("Start the pristine task"), true);
    assert.equal(host.getSnapshot().sessionId, "desktop_pristine");
    assert.equal(host.getSnapshot().fast, true);
    assert.equal(preference, true);
  } finally {
    await host.dispose();
    process.chdir(originalCwd);
    await rm(root, { recursive: true, force: true });
  }
});

test("a pristine route Fast choice supersedes an earlier Fast-only preference", async () => {
  const root = await mkdtemp(join(tmpdir(), "mixdog-pristine-route-fast-"));
  const originalCwd = process.cwd();
  let preference = false;
  let state = {
    sessionId: null,
    items: [],
    busy: false,
    commandBusy: false,
    provider: "openai",
    model: "gpt-5.4",
    fast: false,
    fastCapable: true,
  };
  const calls = [];
    const engine = {
      getState: () => state,
      subscribe: () => () => {},
      submit: () => true,
    switchContext: async () => {
      state = { ...state, sessionId: null, items: [], fast: false };
      return true;
    },
    listProviderModels: async () => [{
      provider: "openai",
      id: "gpt-5.4",
      display: "GPT-5.4",
      fastCapable: true,
    }],
    setFast: async (enabled) => {
      calls.push(["setFast", enabled]);
      preference = enabled;
      if (state.sessionId) state = { ...state, fast: enabled };
      return enabled;
    },
    setRoute: async (selection) => {
      calls.push(["setRoute", selection]);
      if (typeof selection.fast === "boolean") preference = selection.fast;
      state = { ...state, provider: selection.provider, model: selection.model };
      return true;
    },
    newSession: async () => {
      state = { ...state, sessionId: "desktop_route_fast", fast: preference };
      return true;
    },
    listSessions: () => [],
    dispose: async () => {},
  };
  const host = new EngineHost({ userDataPath: root, createEngine: async () => engine });
  try {
    assert.equal((await host.setFast(true)).fast, true);
    const routed = await host.setModelRoute({
      provider: "openai",
      model: "gpt-5.4",
      fast: false,
    });
    assert.equal(routed.fast, false);

    const active = await host.startTask();
    assert.equal(active.sessionId, null);
    assert.equal(active.fast, false);
    assert.equal(await host.submit("Start the routed task"), true);
    assert.equal(host.getSnapshot().sessionId, "desktop_route_fast");
    assert.equal(host.getSnapshot().fast, false);
    assert.equal(preference, false);
    assert.deepEqual(calls, [
      ["setFast", true],
      ["setRoute", { provider: "openai", model: "gpt-5.4", fast: false }],
    ]);
  } finally {
    await host.dispose();
    process.chdir(originalCwd);
    await rm(root, { recursive: true, force: true });
  }
});

test("host lists normalized core models and applies next-session routes during an active turn", async () => {
  const root = await mkdtemp(join(tmpdir(), "mixdog-model-host-"));
  const originalCwd = process.cwd();
  let state = {
    busy: false,
    commandBusy: false,
    provider: "old",
    model: "old-model",
    fast: false,
    fastCapable: true,
  };
  const calls = [];
  const engine = {
    getState: () => state,
    subscribe: () => () => {},
    submit: () => true,
    abort: () => false,
    resolveToolApproval: () => true,
    listProviderModels: async (options) => {
      calls.push(["listProviderModels", options]);
      return [{
        provider: "openai",
        id: "gpt-5.4",
        display: "GPT-5.4",
        created: 1_784_131_200,
        releaseDate: "2026-07-15",
        contextWindow: 1_000_000,
        family: "gpt-5",
        latest: true,
        effortOptions: [{ value: "high", label: "High", description: "current" }],
        fastCapable: fastCapableFor("openai", { id: "gpt-5.4" }),
        fastPreferred: true,
        savedEffort: "high",
        savedFast: false,
      }, {
        provider: "openai",
        id: "gpt-4.1",
        display: "GPT-4.1",
        fastCapable: fastCapableFor("openai", { id: "gpt-4.1" }),
        fastPreferred: true,
      }, {
        provider: "ollama",
        id: "custom-model:latest",
      }, { provider: "", id: "ignored", display: "Ignored" }];
    },
    setRoute: async (selection) => {
      calls.push(["setRoute", selection]);
      state = { ...state, provider: selection.provider, model: selection.model };
      return true;
    },
    setFast: async (enabled) => {
      calls.push(["setFast", enabled]);
      state = { ...state, fast: enabled, ...(enabled ? { fastCapable: true } : {}) };
      return enabled;
    },
    listSessions: () => [],
    newSession: async () => true,
    resume: async () => true,
    dispose: async () => {},
  };
  const host = new EngineHost({ userDataPath: root, createEngine: async () => engine });
  let published = 0;
  host.subscribe(() => { published += 1; });
  try {
    assert.deepEqual(await host.listProviderModels(), [
      {
        provider: "openai",
        model: "gpt-5.4",
        display: "GPT-5.4",
        created: 1_784_131_200,
        releaseDate: "2026-07-15",
        contextWindow: 1_000_000,
        family: "gpt-5",
        latest: true,
        effortOptions: [{ value: "high", label: "High" }],
        fastCapable: true,
        fastPreferred: true,
        savedEffort: "high",
        savedFast: false,
      },
      {
        provider: "openai",
        model: "gpt-4.1",
        display: "GPT-4.1",
        effortOptions: [],
        fastCapable: false,
        fastPreferred: false,
      },
      {
        provider: "ollama",
        model: "custom-model:latest",
        display: "custom-model:latest",
        effortOptions: [],
        fastCapable: false,
        fastPreferred: false,
      },
    ]);
    assert.deepEqual(calls[0], ["listProviderModels", { quick: false }]);
    assert.deepEqual(calls[1], ["listProviderModels", { quick: false }]);
    await host.listProviderModels({ force: true });
    assert.deepEqual(calls[2], ["listProviderModels", { force: true, quick: false }]);

    const snapshot = await host.setModelRoute({
      provider: "openai",
      model: "gpt-5.4",
      effort: "high",
      fast: true,
    });
    assert.equal(snapshot.provider, "openai");
    assert.equal(snapshot.model, "gpt-5.4");
    assert.deepEqual(calls.slice(3, 5), [
      ["listProviderModels", { quick: false }],
      ["setRoute", {
      provider: "openai",
      model: "gpt-5.4",
      effort: "high",
      fast: true,
      }],
    ]);
    assert.equal(published, 2);

    const fastSnapshot = await host.setFast(true);
    assert.equal(fastSnapshot.fast, true);
    assert.deepEqual(calls.at(-1), ["setFast", true]);
    assert.equal(published, 3);

    // Capability metadata can be refreshed after the last renderer snapshot.
    // The backend return is authoritative, so a stale false flag must not
    // prevent a valid preference from being applied.
    state = { ...state, fast: false, fastCapable: false };
    const refreshedFast = await host.setFast(true);
    assert.equal(refreshedFast.fast, true);
    assert.deepEqual(calls.at(-1), ["setFast", true]);
    assert.equal(published, 4);

    const publishedBeforeRejections = published;
    await assert.rejects(
      host.setModelRoute({ provider: "unknown", model: "gpt-5.4" }),
      /provider\/model is unavailable/,
    );
    await assert.rejects(
      host.setModelRoute({ provider: "openai", model: "unknown" }),
      /provider\/model is unavailable/,
    );
    await assert.rejects(
      host.setModelRoute({ provider: "openai", model: "gpt-5.4", effort: "low" }),
      /effort is unavailable/,
    );
    await assert.rejects(
      host.setModelRoute({ provider: "openai", model: "gpt-4.1", fast: true }),
      /Fast mode is unavailable/,
    );
    assert.equal(published, publishedBeforeRejections);
    assert.equal(calls.filter(([name]) => name === "setRoute").length, 1);

    state = { ...state, busy: true };
    const nextTurnRoute = await host.setModelRoute({ provider: "openai", model: "gpt-5.4" });
    assert.equal(nextTurnRoute.busy, true);
    assert.equal(calls.filter(([name]) => name === "setRoute").length, 2);
    state = { ...state, busy: false, commandBusy: true };
    await assert.rejects(
      host.setModelRoute({ provider: "openai", model: "gpt-5.4" }),
      /Engine is busy/,
    );
    await assert.rejects(host.setFast(false), /Engine is busy/);
    assert.equal(calls.filter(([name]) => name === "setRoute").length, 2);
  } finally {
    await host.dispose();
    process.chdir(originalCwd);
    await rm(root, { recursive: true, force: true });
  }
});

test("full desktop model catalog recovers after an advisory quick warmup", async () => {
  const root = await mkdtemp(join(tmpdir(), "mixdog-model-quick-race-"));
  const originalCwd = process.cwd();
  let advisoryWarmupPending = false;
  const calls = [];
  const quickRows = [{ provider: "openai-oauth", id: "gpt-5.6-sol", display: "GPT-5.6-Sol" }];
  const partialRows = [{ provider: "ollama", id: "local-model", display: "Local model" }];
  const fullRows = [
    ...quickRows,
    { provider: "anthropic-oauth", id: "claude-sonnet-5", display: "Claude Sonnet 5" },
    { provider: "opencode-go", id: "glm-5.2", display: "GLM 5.2" },
  ];
  const engine = {
    getState: () => ({ busy: false, commandBusy: false }),
    subscribe: () => () => {},
    submit: () => true,
    abort: () => false,
    resolveToolApproval: () => true,
    listProviderModels: async (options) => {
      calls.push(structuredClone(options));
      if (options?.quick === true) {
        advisoryWarmupPending = true;
        return quickRows;
      }
      if (advisoryWarmupPending) {
        advisoryWarmupPending = false;
        return partialRows;
      }
      return fullRows;
    },
    setRoute: async () => true,
    setFast: async (enabled) => enabled,
    listSessions: () => [],
    newSession: async () => true,
    resume: async () => true,
    dispose: async () => {},
  };
  const host = new EngineHost({ userDataPath: root, createEngine: async () => engine });
  try {
    const quick = await host.listProviderModels({ quick: true });
    assert.deepEqual(quick.map((entry) => entry.provider), ["openai-oauth"]);
    const full = await host.listProviderModels({ quick: false });
    assert.deepEqual(full.map((entry) => entry.provider), ["openai-oauth", "anthropic-oauth", "opencode-go"]);
    assert.deepEqual(calls, [
      { quick: false },
      { quick: true },
      { quick: false },
      { quick: false },
    ]);
  } finally {
    await host.dispose();
    process.chdir(originalCwd);
    await rm(root, { recursive: true, force: true });
  }
});

test("host rejects a route when an engine command starts while the catalog is loading", async () => {
  const root = await mkdtemp(join(tmpdir(), "mixdog-model-race-"));
  const originalCwd = process.cwd();
  let state = { busy: false, commandBusy: false };
  let deferCatalog = false;
  let releaseCatalog;
  let catalogStarted;
  const catalogStartedPromise = new Promise((resolve) => { catalogStarted = resolve; });
  const catalog = [{
    provider: "openai",
    id: "gpt-5",
    display: "GPT-5",
    effortOptions: [{ value: "high", label: "High" }],
  }];
  let setRouteCalls = 0;
  const engine = {
    getState: () => state,
    subscribe: () => () => {},
    submit: () => true,
    abort: () => false,
    resolveToolApproval: () => true,
    listProviderModels: async () => {
      if (!deferCatalog) return catalog;
      catalogStarted();
      return await new Promise((resolve) => { releaseCatalog = resolve; });
    },
    setRoute: async () => {
      setRouteCalls += 1;
      return true;
    },
    listSessions: () => [],
    newSession: async () => true,
    resume: async () => true,
    dispose: async () => {},
  };
  const host = new EngineHost({ userDataPath: root, createEngine: async () => engine });
  try {
    await host.listProviderModels();
    let published = 0;
    host.subscribe(() => { published += 1; });
    deferCatalog = true;
    const route = host.setModelRoute({ provider: "openai", model: "gpt-5", effort: "high" });
    await catalogStartedPromise;
    state = { ...state, commandBusy: true };
    releaseCatalog(catalog);
    await assert.rejects(route, /Engine is busy/);
    assert.equal(setRouteCalls, 0);
    assert.equal(published, 0);
  } finally {
    await host.dispose();
    process.chdir(originalCwd);
    await rm(root, { recursive: true, force: true });
  }
});

test("desktop projects are sourced only from the shared registered-project store", async () => {
  const root = await mkdtemp(join(tmpdir(), "mixdog-project-integration-"));
  const newest = join(root, "newest");
  const older = join(root, "older");
  const desktopOnly = join(root, "desktop-only");
  await Promise.all([mkdir(newest), mkdir(older), mkdir(desktopOnly)]);
  const projectStore = createProjectStore([
    { name: "Core newest", path: newest, addedAt: 900 },
    { name: "Core older", path: older, addedAt: 800 },
  ]);
  await writeFile(join(root, "desktop-projects.json"), `${JSON.stringify({
    version: 1,
    recentProjects: [desktopOnly, newest],
    aliases: {
      [desktopOnly]: "Must not be imported",
      [newest]: "Desktop alias",
    },
    pinned: [desktopOnly],
    // A legacy remove/hide marker must not suppress a project that the TUI
    // projects.json store currently says is registered.
    hidden: [newest],
  }, null, 2)}\n`);
  const host = new EngineHost({
    userDataPath: root,
    createEngine: async () => { throw new Error("project listing must not create an engine"); },
    loadProjects: async () => projectStore.module,
  });
  try {
    assert.deepEqual(await host.listProjects(), [{
      name: "Core newest",
      path: resolve(newest),
      alias: "Desktop alias",
      pinned: false,
    }, {
      name: "Core older",
      path: resolve(older),
      alias: null,
      pinned: false,
    }]);
    await assert.rejects(
      host.startProjectTask(desktopOnly),
      /Project is not available/,
      "legacy desktop recents must not authorize a project-scoped task",
    );

    await host.setProjectPinned(older, true);
    assert.deepEqual((await host.listProjects()).map((project) => project.path), [
      resolve(older),
      resolve(newest),
    ]);
    await host.renameProject(newest, "Shared rename");
    const renamed = (await host.listProjects()).find((project) => project.path === resolve(newest));
    assert.equal(renamed.name, "Shared rename");
    assert.equal(renamed.alias, "Shared rename");

    await host.removeProject(newest);
    assert.deepEqual((await host.listProjects()).map((project) => project.path), [resolve(older)]);
    assert.deepEqual(projectStore.calls.slice(-2), [
      ["renameProject", resolve(newest), "Shared rename"],
      ["removeProject", resolve(newest)],
    ]);

    const savedMetadata = JSON.parse(await readFile(join(root, "desktop-projects.json"), "utf8"));
    assert.equal(savedMetadata.version, 2);
    assert.equal("recentProjects" in savedMetadata, false);
    assert.deepEqual(savedMetadata.pinned, [resolve(older)]);
  } finally {
    await host.dispose();
    await rm(root, { recursive: true, force: true });
  }
});

test("host start/list/resume persists desktop scope, restores transcript, and publishes once", async () => {
  const root = await mkdtemp(join(tmpdir(), "mixdog-host-"));
  const project = join(root, "project");
  await mkdir(project);
  const persistedTranscript = [
    { kind: "user", id: "u1", text: "Persisted prompt" },
    {
      kind: "user",
      id: "session-envelope",
      text: "# Session\nCwd: C:\\Project\\mixdog\nModel: GPT-5.6-Sol · XHIGH · FAST\nWorkflow: Solo\n\nVisible prompt after envelope",
    },
    {
      kind: "user",
      id: "session-envelope-only",
      text: "# Session\nCwd: C:\\Project\\mixdog\nModel: GPT-5.6-Sol · XHIGH · FAST\nWorkflow: Solo",
    },
    {
      kind: "user",
      id: "inline-system-reminder",
      text: "Visible before reminder\n<system-reminder>internal only</system-reminder>\nVisible after reminder",
    },
    {
      kind: "user",
      id: "system-reminder-only",
      text: "<system-reminder>hidden runtime injection</system-reminder>",
    },
    {
      kind: "user",
      id: "mcp-instructions-only",
      text: "<mcp-instructions>hidden MCP bootstrap</mcp-instructions>",
    },
    {
      kind: "user",
      id: "compacted-handoff",
      text: "A previous model worked on this task and produced the compacted handoff summary below. Build on it.",
    },
    {
      kind: "user",
      id: "async-agent-injection",
      text: "The async agent task task_agent has completed with an internal payload.",
    },
    { kind: "assistant", id: "a1", text: "Visible answer" },
    { kind: "notice", id: "n1", text: "Visible notice" },
    { kind: "failure", id: "f1", detail: "Visible failure" },
    { kind: "statusdone", id: "c1", label: "Compact complete" },
    { kind: "user", id: "sys-role", role: "system", text: "bootstrap payload" },
    { kind: "user", id: "dev-role", role: "developer", text: "developer payload" },
    { kind: "system", id: "sys-kind", text: "system payload" },
    { kind: "developer", id: "dev-kind", text: "developer payload" },
    { kind: "synthetic", id: "synthetic-kind", text: "synthetic payload" },
    { kind: "user", id: "internal-flag", text: "internal payload", internal: true },
    { kind: "user", id: "hidden-metadata", text: "hidden payload", metadata: { hidden: true } },
    { kind: "assistant", id: "synthetic-flag", text: "synthetic payload", synthetic: true },
    {
      kind: "tool",
      id: "shell",
      name: "shell",
      args: { command: "node bootstrap.js", script: "legitimate input" },
      result: "shell output",
    },
    {
      kind: "tool",
      id: "script",
      name: "script",
      args: { script: "console.log('legitimate')" },
      result: "script output",
    },
    {
      kind: "tool",
      id: "tool-with-internal-display",
      name: "shell",
      args: { command: "echo visible" },
      result: "visible output",
      displayMetadata: { internal: true, payload: "hidden bootstrap script" },
      metadata: {
        source: "runtime",
        display: { visibility: "internal", payload: "hidden nested script" },
      },
    },
  ];
  const rows = [{
    id: "cli_lead",
    preview: "Shared CLI session",
    cwd: project,
    desktopSession: null,
  }];
  const engines = [];
  const createEngine = async (options) => {
    let state = { sessionId: null, items: [] };
    const listeners = new Set();
    const engine = {
      options,
      listeners,
      emit: () => {
        for (const listener of listeners) listener();
      },
      getState: () => state,
      setStreamingTail: (streamingTail) => {
        state = { ...state, streamingTail: structuredClone(streamingTail) };
      },
      subscribe: (listener) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      submit: () => true,
      abort: () => false,
      resolveToolApproval: () => true,
      listSessions: () => rows,
      newSession: async () => {
        const id = `desktop_${rows.length}`;
        state = { sessionId: id, items: [] };
        rows.push({
          id,
          preview: "Fresh desktop task",
          updatedAt: 20,
          cwd: options.cwd,
          desktopSession: structuredClone(options.desktopSession),
          transcript: structuredClone(persistedTranscript),
        });
        return true;
      },
      resume: async (id) => {
        const row = rows.find((candidate) => candidate.id === id);
        if (!row) return false;
        state = { sessionId: id, items: structuredClone(row.transcript || []) };
        return true;
      },
      dispose: async () => {
        listeners.clear();
      },
    };
    engines.push(engine);
    return engine;
  };
  const originalCwd = process.cwd();
  const projectStore = createProjectStore();
  const host = new EngineHost({
    userDataPath: root,
    createEngine,
    loadProjects: async () => projectStore.module,
  });
  let publications = 0;
  host.subscribe(() => { publications += 1; });
  try {
    const taskResponse = await host.startTask();
    assert.match(engines[0].options.cwd, /workspace[\\/]unclassified$/);
    assert.equal(taskResponse.currentProject, null);
    assert.deepEqual(taskResponse.recentProjects, []);
    assert.equal(taskResponse.sessionId, null);
    assert.equal(rows.find((row) => row.desktopSession?.classification === "task"), undefined,
      "opening a blank task must not persist a runtime session");
    assert.equal(await host.submit("Fresh desktop task"), true);
    const desktopId = rows.find((row) => row.desktopSession?.classification === "task").id;
    assert.equal(host.getSnapshot().sessionId, desktopId);
    assert.equal(engines[0].listeners.size, 1);
    const beforeEmit = publications;
    engines[0].emit();
    engines[0].emit();
    assert.equal(publications, beforeEmit, "engine event publication should be deferred");
    await new Promise((resolve) => setTimeout(resolve, 75));
    assert.equal(publications, beforeEmit + 1);

    const listed = await host.listSessions();
    assert.deepEqual(listed.map((row) => row.id), ["cli_lead", desktopId]);

    const legacyResponse = await host.resumeSession("cli_lead");
    assert.equal(legacyResponse.currentProject, project);
    assert.equal(legacyResponse.sessionId, "cli_lead");
    assert.equal(engines.at(-1).options.desktopSession, undefined);

    const resumeResponse = await host.resumeSession(desktopId);
    const activeDesktopEngine = engines.at(-1);
    assert.deepEqual(activeDesktopEngine.options.desktopSession, { classification: "task", projectPath: null });
    assert.equal(resumeResponse.currentProject, null);
    assert.deepEqual(resumeResponse.recentProjects, []);
    assert.equal(resumeResponse.sessionId, desktopId);
    assert.deepEqual(resumeResponse.items, [
      { kind: "user", id: "u1", text: "Persisted prompt" },
      { kind: "user", id: "session-envelope", text: "Visible prompt after envelope" },
      {
        kind: "user",
        id: "inline-system-reminder",
        text: "Visible before reminder\n\nVisible after reminder",
      },
      { kind: "assistant", id: "a1", text: "Visible answer" },
      { kind: "notice", id: "n1", text: "Visible notice" },
      { kind: "failure", id: "f1", detail: "Visible failure" },
      { kind: "statusdone", id: "c1", label: "Compact complete" },
      {
        kind: "tool",
        id: "shell",
        name: "shell",
        args: { command: "node bootstrap.js", script: "legitimate input" },
        result: "shell output",
      },
      {
        kind: "tool",
        id: "script",
        name: "script",
        args: { script: "console.log('legitimate')" },
        result: "script output",
      },
      {
        kind: "tool",
        id: "tool-with-internal-display",
        name: "shell",
        args: { command: "echo visible" },
        result: "visible output",
        metadata: { source: "runtime" },
      },
    ]);
    assert.deepEqual(
      activeDesktopEngine.getState().items,
      persistedTranscript,
      "desktop display sanitization must not mutate the engine snapshot",
    );
    const secondDisplayCopy = host.getSnapshot();
    secondDisplayCopy.items[0].text = "renderer-only mutation";
    assert.equal(activeDesktopEngine.getState().items[0].text, "Persisted prompt");

    const hiddenStreamingTails = [
      { kind: "assistant", id: "tail-system", role: "system", text: "system bootstrap", streaming: true },
      { kind: "assistant", id: "tail-developer", role: "developer", text: "developer bootstrap", streaming: true },
      { kind: "synthetic", id: "tail-synthetic", text: "synthetic payload", streaming: true },
      { kind: "assistant", id: "tail-internal", text: "internal payload", streaming: true, internal: true },
      { kind: "assistant", id: "tail-hidden", text: "hidden payload", streaming: true, hidden: true },
    ];
    for (const tail of hiddenStreamingTails) {
      activeDesktopEngine.setStreamingTail(tail);
      assert.equal(host.getSnapshot().streamingTail, null);
      assert.deepEqual(
        activeDesktopEngine.getState().streamingTail,
        tail,
        "filtering an internal streaming tail must not mutate the engine state",
      );
    }

    const visibleStreamingTail = {
      kind: "assistant",
      id: "tail-visible",
      text: "Visible streaming answer",
      streaming: true,
    };
    activeDesktopEngine.setStreamingTail(visibleStreamingTail);
    const visibleTailCopy = host.getSnapshot().streamingTail;
    assert.deepEqual(visibleTailCopy, visibleStreamingTail);
    visibleTailCopy.text = "renderer-only tail mutation";
    assert.deepEqual(
      activeDesktopEngine.getState().streamingTail,
      visibleStreamingTail,
      "a visible streaming tail must remain an immutable display copy",
    );
    assert.equal(engines[0].listeners.size, 0);
    assert.equal(activeDesktopEngine.listeners.size, 1);

    const projectResponse = await host.startProject(project);
    const activeProjectEngine = engines.at(-1);
    const canonicalProject = await realpath(project);
    assert.deepEqual(projectStore.calls.slice(0, 2), [
      ["addProject", canonicalProject],
      ["touchProjectSelected", canonicalProject],
    ]);
    assert.equal(projectResponse.currentProject, canonicalProject);
    assert.deepEqual(projectResponse.recentProjects, [canonicalProject]);
    assert.equal(projectResponse.sessionId, null);
    assert.equal(activeProjectEngine.listeners.size, 1);
    const projectBeforeEmit = publications;
    activeProjectEngine.emit();
    activeProjectEngine.emit();
    assert.equal(publications, projectBeforeEmit, "project engine events should be coalesced");
    await new Promise((resolve) => setTimeout(resolve, 75));
    assert.equal(publications, projectBeforeEmit + 1);

    await host.renameProject(canonicalProject, "Desktop alias");
    await host.setProjectPinned(canonicalProject, true);
    assert.deepEqual(await host.listProjects(), [{
      name: "Desktop alias",
      path: canonicalProject,
      alias: "Desktop alias",
      pinned: true,
    }]);

    await host.dispose();
    const restarted = new EngineHost({
      userDataPath: root,
      createEngine,
      loadProjects: async () => projectStore.module,
    });
    try {
      const afterRestart = await restarted.listSessions();
      assert.equal(afterRestart.find((row) => row.id === desktopId).classification, "task");
      assert.equal(afterRestart.find((row) => row.id === desktopId).projectPath, null);
      assert.equal(afterRestart.find((row) => row.id === "cli_lead").classification, "project");
      assert.equal(afterRestart.find((row) => row.id === "cli_lead").projectPath, project);
      assert.equal((await restarted.listProjects())[0].alias, "Desktop alias");
      assert.equal((await restarted.listProjects())[0].pinned, true);
      await restarted.removeProject(canonicalProject);
      assert.deepEqual(await restarted.listProjects(), []);
      await assert.rejects(restarted.projectDirectory(canonicalProject), /not available/);
      await restarted.startProject(project);
      assert.equal((await restarted.listProjects())[0].alias, "Desktop alias");
      const freshProjectTask = await restarted.startProjectTask(canonicalProject);
      assert.equal(freshProjectTask.currentProject, canonicalProject);
      assert.equal(engines.at(-1).options.desktopSession.classification, "project");
      assert.equal(engines.at(-1).options.desktopSession.projectPath, canonicalProject);
      assert.equal(freshProjectTask.sessionId, null);
      assert.equal(await restarted.submit("Fresh project task"), true);
      assert.match(String(restarted.getSnapshot().sessionId), /^desktop_/);
    } finally {
      await restarted.dispose();
    }
  } finally {
    await host.dispose();
    process.chdir(originalCwd);
    await rm(root, { recursive: true, force: true });
  }
});

test("host reuses a context-switch capable backend and only tears it down at final disposal", async () => {
  const root = await mkdtemp(join(tmpdir(), "mixdog-host-reuse-"));
  const project = join(root, "project");
  await mkdir(project);
  const originalCwd = process.cwd();
  const switches = [];
  const creations = [];
  let created = 0;
  let disposed = 0;
  let state = { sessionId: "old", items: [{ kind: "user", id: "old", text: "durable" }] };
  const engine = {
    getState: () => state,
    subscribe: () => () => {},
    submit: () => true,
    abort: () => false,
    resolveToolApproval: () => true,
    listProviderModels: async () => [],
    setRoute: async () => true,
    setFast: async (enabled) => enabled,
    listSessions: () => [],
    switchContext: async (options) => {
      switches.push(structuredClone(options));
      state = { sessionId: null, items: [] };
      return true;
    },
    newSession: async () => {
      state = { sessionId: "new", items: [] };
      return true;
    },
    resume: async () => true,
    dispose: async () => { disposed += 1; },
  };
  const projectStore = createProjectStore();
  const host = new EngineHost({
    userDataPath: root,
    loadProjects: async () => projectStore.module,
    createEngine: async (options) => {
      created += 1;
      creations.push(structuredClone(options));
      return engine;
    },
  });
  try {
    await host.startTask();
    const canonicalProject = await realpath(project);
    await host.startProject(project);

    assert.equal(created, 1);
    assert.equal(disposed, 0);
    assert.deepEqual(creations[0].desktopSession, { classification: "task", projectPath: null });
    assert.deepEqual(switches, [
      {
        cwd: canonicalProject,
        desktopSession: { classification: "project", projectPath: canonicalProject },
      },
    ]);
  } finally {
    await host.dispose();
    assert.equal(disposed, 1);
    process.chdir(originalCwd);
    await rm(root, { recursive: true, force: true });
  }
});

test("host recreates after context switch rejection or failure and restores cwd if recreation fails", async () => {
  for (const failure of ["reject", "throw"]) {
    const root = await mkdtemp(join(tmpdir(), `mixdog-host-recovery-${failure}-`));
    const project = join(root, "project");
    await mkdir(project);
    const originalCwd = process.cwd();
    let firstDisposed = 0;
    let replacementDisposed = 0;
    const first = {
      getState: () => ({ sessionId: "old", items: [] }),
      subscribe: () => () => {},
      listSessions: () => [],
      newSession: async () => true,
      resume: async () => true,
      switchContext: async () => {
        if (failure === "throw") throw new Error("partially switched");
        return false;
      },
      dispose: async () => { firstDisposed += 1; },
    };
    const replacement = {
      ...first,
      getState: () => ({ sessionId: null, items: [] }),
      switchContext: async () => true,
      dispose: async () => { replacementDisposed += 1; },
    };
    let creates = 0;
    const projectStore = createProjectStore();
    const host = new EngineHost({
      userDataPath: root,
      loadProjects: async () => projectStore.module,
      createEngine: async () => (++creates === 1 ? first : replacement),
    });
    try {
      await host.startTask();
      const canonicalProject = await realpath(project);
      const snapshot = await host.startProject(project);
      assert.equal(snapshot.currentProject, canonicalProject);
      assert.equal(creates, 2);
      assert.equal(firstDisposed, 1);
      assert.equal(process.cwd(), canonicalProject);
    } finally {
      await host.dispose();
      assert.equal(replacementDisposed, 1);
      process.chdir(originalCwd);
      await rm(root, { recursive: true, force: true });
    }
  }

  const root = await mkdtemp(join(tmpdir(), "mixdog-host-recovery-load-failure-"));
  const project = join(root, "project");
  await mkdir(project);
  const originalCwd = process.cwd();
  let creates = 0;
  const projectStore = createProjectStore();
  const host = new EngineHost({
    userDataPath: root,
    loadProjects: async () => projectStore.module,
    createEngine: async () => {
      creates += 1;
      if (creates === 1) {
        return {
          getState: () => ({ items: [] }),
          subscribe: () => () => {},
          listSessions: () => [],
          newSession: async () => true,
          resume: async () => true,
          switchContext: async () => false,
          dispose: async () => {},
        };
      }
      throw new Error("replacement failed");
    },
  });
  try {
    await host.startTask();
    const beforeFailureCwd = process.cwd();
    await assert.rejects(host.startProject(project), /replacement failed/);
    assert.equal(process.cwd(), beforeFailureCwd);
    assert.deepEqual(projectStore.calls, [], "a failed switch must not register the folder");
  } finally {
    await host.dispose();
    process.chdir(originalCwd);
    await rm(root, { recursive: true, force: true });
  }
});

test("host restores cwd when initial or legacy replacement creation fails", async () => {
  for (const legacy of [false, true]) {
    const root = await mkdtemp(join(tmpdir(), `mixdog-host-cwd-failure-${legacy}-`));
    const project = join(root, "project");
    await mkdir(project);
    const originalCwd = process.cwd();
    let creates = 0;
    const legacyEngine = {
      getState: () => ({ items: [] }),
      subscribe: () => () => {},
      listSessions: () => [],
      newSession: async () => true,
      resume: async () => true,
      dispose: async () => {},
    };
    const projectStore = createProjectStore();
    const host = new EngineHost({
      userDataPath: root,
      loadProjects: async () => projectStore.module,
      createEngine: async () => {
        creates += 1;
        if (legacy && creates === 1) return legacyEngine;
        throw new Error("create failed");
      },
    });
    try {
      if (legacy) await host.startTask();
      const beforeFailureCwd = process.cwd();
      await assert.rejects(host.startProject(project), /create failed/);
      assert.equal(process.cwd(), beforeFailureCwd);
      assert.deepEqual(projectStore.calls, [], "a failed switch must not register the folder");
    } finally {
      await host.dispose();
      process.chdir(originalCwd);
      await rm(root, { recursive: true, force: true });
    }
  }
});

test("desktop capabilities invoke the existing engine and serialize interactive OAuth flows", async () => {
  const root = await mkdtemp(join(tmpdir(), "mixdog-capability-host-"));
  const originalCwd = process.cwd();
  const calls = [];
  let cancelled = 0;
  const engine = {
    getState: () => ({ items: [], queued: [], provider: "openai", model: "gpt-5" }),
    subscribe: () => () => {},
    submit: () => true,
    abort: () => false,
    resolveToolApproval: () => true,
    listProviderModels: async () => [],
    setRoute: async () => true,
    setFast: async (enabled) => enabled,
    listSessions: () => [],
    newSession: async () => true,
    resume: async () => true,
    getProfile: () => ({ title: "Builder", language: "system" }),
    setProfile: (value) => { calls.push(["setProfile", value]); return value; },
    getUsageDashboard: () => ({
      total: { providerCount: 1 },
      rows: [{ id: "openai", status: "available" }],
      format: { money: (value) => `$${value}` },
    }),
    getVoiceStatus: () => ({ enabled: false, installed: false, busy: false }),
    toggleVoice: async () => { calls.push(["toggleVoice"]); return { enabled: true, installed: true, busy: false }; },
    beginOAuthProviderLogin: async (provider) => ({
      provider,
      url: "https://example.test/oauth",
      manualUrl: "https://example.test/manual",
      waitForCallback: new Promise(() => {}),
      cancel: () => { cancelled += 1; },
      completeCode: async (code) => ({ provider, codeAccepted: code === "code-123" }),
    }),
    dispose: async () => {},
  };
  const host = new EngineHost({ userDataPath: root, createEngine: async () => engine });
  let publications = 0;
  const unsubscribe = host.subscribe(() => { publications += 1; });
  try {
    const profile = await host.invokeCapability("getProfile");
    assert.deepEqual(profile.value, { title: "Builder", language: "system" });
    assert.equal(profile.snapshot.model, "gpt-5");

    const publicationsBeforeBatch = publications;
    const batch = await host.readCapabilities([
      { capability: "getProfile" },
      { capability: "getUsageDashboard" },
      { capability: "getTheme" },
    ]);
    assert.deepEqual(batch[0], { ok: true, value: { title: "Builder", language: "system" } });
    assert.equal(batch[1].ok, true);
    assert.deepEqual(batch[2], {
      ok: false,
      error: "The active Mixdog engine does not support getTheme.",
    });
    assert.equal(publications, publicationsBeforeBatch);

    const updated = await host.invokeCapability("setProfile", [{ title: "Owner" }]);
    assert.deepEqual(updated.value, { title: "Owner" });
    assert.deepEqual(calls, [["setProfile", { title: "Owner" }]]);

    const voiceBefore = await host.invokeCapability("getVoiceStatus");
    assert.equal(voiceBefore.value.enabled, false);
    const voiceAfter = await host.invokeCapability("toggleVoice");
    assert.equal(voiceAfter.value.enabled, true);
    assert.deepEqual(calls.at(-1), ["toggleVoice"]);

    const usage = await host.invokeCapability("getUsageDashboard");
    assert.deepEqual(usage.value, {
      total: { providerCount: 1 },
      rows: [{ id: "openai", status: "available" }],
      format: {},
    });
    assert.doesNotThrow(() => structuredClone(usage));

    const started = await host.invokeCapability("beginOAuthProviderLogin", ["github-copilot"]);
    assert.equal(started.value.state, "pending");
    assert.equal(started.value.manualCodeSupported, true);
    assert.doesNotThrow(() => structuredClone(started));
    const completed = await host.invokeCapability("completeOAuthProviderLogin", [started.value.flowId, "code-123"]);
    assert.equal(completed.value.state, "complete");
    assert.equal(completed.value.completed, true);
    assert.equal(Object.hasOwn(completed.value, "result"), false);

    const second = await host.invokeCapability("beginOAuthProviderLogin", ["github-copilot"]);
    const cancelledFlow = await host.invokeCapability("cancelOAuthProviderLogin", [second.value.flowId]);
    assert.equal(cancelledFlow.value.state, "cancelled");
    assert.equal(cancelled, 1);
  } finally {
    unsubscribe();
    await host.dispose();
    process.chdir(originalCwd);
    await rm(root, { recursive: true, force: true });
  }
});
