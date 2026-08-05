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
  ENGINE_PUBLICATION_INTERVAL_MS,
  engineModuleUrl,
  projectDesktopLiveWorkState,
  projectsModuleUrl,
  sessionStoreModuleUrl,
  shellJobsPollDelay,
  copySnapshot,
  streamingTailAppendEpoch,
  channelRemoteStatePath,
  normalizedChannelRemoteState,
  storedVisibleSessionSnapshotRegresses,
  sessionTranscriptGeneration,
  sessionSnapshotWithRememberedRoute,
} from "./engine-host.ts";
import { createSessionLiveLanes } from "./session-live-lanes.ts";
import { createShellJobsPoller } from "./shell-jobs-poller.ts";
import { searchProjectDirectory } from "./project-file-search.ts";
import { registerDesktopIpc, requiredWorkspaceSearchLimit } from "./ipc.ts";
import { TerminalDataBufferer } from "./terminal-data-buffer.ts";
import { TerminalReplayBuffer } from "./terminal-manager.ts";
import { DESKTOP_IPC } from "../shared/contract.ts";
import {
  fastCapableFor,
  fastPreferenceFor,
  saveModelSettings,
} from "../../../../src/session-runtime/model-capabilities.mjs";
import { sanitizeTranscriptItem } from "./engine-host-support.ts";
import { mkdtemp, mkdir, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  readProjectTextFileIn,
  writeProjectTextFileIn,
  writeProjectTextFilesIn,
} from "./project-files.ts";
import {
  deleteEditorBackup,
  readEditorBackup,
  writeEditorBackup,
} from "./editor-backups.ts";

test("workspace text search limit accepts the UI default independently of file search limits", () => {
  assert.equal(requiredWorkspaceSearchLimit(undefined), 2_000);
  assert.equal(requiredWorkspaceSearchLimit(2_000), 2_000);
  assert.equal(requiredWorkspaceSearchLimit(5_000), 5_000);
  assert.throws(() => requiredWorkspaceSearchLimit(0), /maxResults is invalid/);
  assert.throws(() => requiredWorkspaceSearchLimit(5_001), /maxResults is invalid/);
});

test("terminal output buffering coalesces each PTY independently and flushes on disposal", () => {
  const delivered = [];
  const bufferer = new TerminalDataBufferer((event) => delivered.push(event), 60_000);
  bufferer.push({ id: "a", data: "one" });
  bufferer.push({ id: "a", data: "-two" });
  bufferer.push({ id: "b", data: "other" });
  bufferer.flush("a");
  assert.deepEqual(delivered, [{ id: "a", data: "one-two" }]);
  bufferer.dispose();
  assert.deepEqual(delivered, [
    { id: "a", data: "one-two" },
    { id: "b", data: "other" },
  ]);
});

test("terminal replay buffer retains the newest bounded chunks in exact order", () => {
  const replay = new TerminalReplayBuffer(10);
  replay.append("abc");
  replay.append("defgh");
  replay.append("ijkl");
  assert.equal(replay.read(), "cdefghijkl");
  assert.equal(replay.read(), "cdefghijkl", "reattach reads must not consume replay");

  replay.append("MNOPQRSTUVWXYZ");
  assert.equal(replay.read(), "QRSTUVWXYZ", "one oversized chunk keeps only its newest suffix");
  replay.append("!");
  assert.equal(replay.read(), "RSTUVWXYZ!");
});

test("desktop transcript hides model-only async completion wrappers from persisted sessions", () => {
  const completion = {
    kind: "user",
    text: [
      "The async shell task job_123 has finished (failed, exit -1) - review this result in your next step.",
      "",
      "Result:",
      "> background task",
      "> task_id: job_123",
      "> status: failed",
    ].join("\n"),
  };
  assert.equal(sanitizeTranscriptItem(completion), false);
  assert.equal(sanitizeTranscriptItem({
    kind: "user",
    text: [
      "The async shell task job_legacy has finished (completed, exit 0) - review this result in your next step.",
      "Result:",
      "background task",
      "task_id: job_legacy",
      "surface: shell",
      "status: completed",
    ].join("\n"),
  }), false, "legacy unquoted completion rows must stay model-only");
  assert.equal(sanitizeTranscriptItem({
    kind: "user",
    text: "<system-reminder>internal workflow instruction</system-reminder>",
  }), false);
  assert.equal(sanitizeTranscriptItem({
    kind: "user",
    text: "[mixdog-runtime] Continue the interrupted internal step.",
  }), false);

  const userMessage = { kind: "user", text: "The terminal command failed; please inspect it." };
  assert.equal(sanitizeTranscriptItem(userMessage), true);
  assert.equal(userMessage.text, "The terminal command failed; please inspect it.");
});

test("terminal output buffering waits for renderer parse acknowledgements at the high watermark", () => {
  const delivered = [];
  const bufferer = new TerminalDataBufferer((event) => delivered.push(event), 60_000, 5);
  bufferer.push({ id: "a", data: "12345" });
  bufferer.flush("a");
  bufferer.push({ id: "a", data: "678901" });
  bufferer.flush("a");
  assert.deepEqual(delivered, [{ id: "a", data: "12345" }],
    "unparsed output must hold the next IPC batch in main");
  bufferer.acknowledge("a", 3);
  assert.deepEqual(delivered, [
    { id: "a", data: "12345" },
    { id: "a", data: "678" },
  ], "an xterm parse acknowledgement must release only the available capacity");
  bufferer.acknowledge("a", 5);
  assert.deepEqual(delivered.at(-1), { id: "a", data: "901" },
    "a large pending burst must remain split at the high watermark");
  bufferer.dispose();
});

test("terminal output buffering pauses and safely resumes a flooded PTY producer", () => {
  const delivered = [];
  const flow = [];
  const bufferer = new TerminalDataBufferer(
    (event) => delivered.push(event),
    60_000,
    8,
    {
      pause: (id) => flow.push(`pause:${id}`),
      resume: (id) => flow.push(`resume:${id}`),
    },
    2,
  );
  bufferer.push({ id: "a", data: "123456789" });
  assert.deepEqual(flow, ["pause:a"],
    "pending output above HIGH must stop the actual producer");
  bufferer.flush("a");
  assert.deepEqual(delivered, [{ id: "a", data: "12345678" }]);
  bufferer.acknowledge("a", 8);
  assert.deepEqual(delivered.at(-1), { id: "a", data: "9" });
  assert.deepEqual(flow, ["pause:a", "resume:a"],
    "producer must resume only after total pending output drains below LOW");

  bufferer.push({ id: "a", data: "abcdefgh" });
  assert.equal(flow.at(-1), "pause:a");
  bufferer.release("a");
  assert.equal(flow.at(-1), "resume:a",
    "disposing a terminal id must never leave its producer paused");
  bufferer.dispose();
});

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

test("project file roots join concurrent verification and reuse the short-lived result", async () => {
  const root = await mkdtemp(join(tmpdir(), "mixdog-project-root-cache-"));
  const project = join(root, "project");
  await mkdir(project);
  const store = createProjectStore([{ path: project }]);
  const host = new EngineHost({
    userDataPath: root,
    loadProjects: async () => store.module,
    createEngine: async () => ({ dispose: async () => {} }),
  });
  const originalCanonicalDirectory = host.canonicalDirectory.bind(host);
  let canonicalCalls = 0;
  let releaseCanonical;
  let canonicalStarted;
  const canonicalGate = new Promise((resolve) => { releaseCanonical = resolve; });
  const canonicalStartedPromise = new Promise((resolve) => { canonicalStarted = resolve; });
  host.canonicalDirectory = async (path) => {
    canonicalCalls += 1;
    canonicalStarted();
    await canonicalGate;
    return originalCanonicalDirectory(path);
  };
  try {
    const first = host.projectDirectory(project);
    await canonicalStartedPromise;
    const second = host.projectDirectory(project);
    releaseCanonical();
    const [firstRoot, secondRoot] = await Promise.all([first, second]);
    assert.equal(firstRoot, await realpath(project));
    assert.equal(secondRoot, firstRoot);
    assert.equal(canonicalCalls, 1);
    assert.equal(await host.projectDirectory(project), firstRoot);
    assert.equal(canonicalCalls, 1, "warm file and backup reads must not repeat realpath/stat");

    await host.removeProject(project);
    await assert.rejects(host.projectDirectory(project), /not available/i);
  } finally {
    await host.dispose();
    await rm(root, { recursive: true, force: true });
  }
});

test("editor saves compare disk content and never recreate a deleted file", async () => {
  const root = await mkdtemp(join(tmpdir(), "mixdog-editor-save-"));
  const file = join(root, "note.txt");
  try {
    await writeFile(file, "one", "utf8");
    await writeProjectTextFileIn(root, "note.txt", "two", "one");
    assert.equal(await readFile(file, "utf8"), "two");

    await writeFile(file, "external", "utf8");
    await assert.rejects(
      writeProjectTextFileIn(root, "note.txt", "three", "two"),
      /changed on disk/i,
    );
    assert.equal(await readFile(file, "utf8"), "external");

    await rm(file);
    await assert.rejects(
      writeProjectTextFileIn(root, "note.txt", "four", "external"),
      /ENOENT|no such file/i,
    );
    assert.equal(
      (await readdir(root)).some((name) => name.includes(".mixdog-save-")),
      false,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("editor reads and atomically preserves UTF BOM encodings", async () => {
  const root = await mkdtemp(join(tmpdir(), "mixdog-editor-encoding-"));
  try {
    const fixtures = [
      {
        name: "utf8bom.txt",
        bytes: Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from("one", "utf8")]),
        encoding: "utf8bom",
        prefix: [0xef, 0xbb, 0xbf],
      },
      {
        name: "utf16le.txt",
        bytes: Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from("one", "utf16le")]),
        encoding: "utf16le",
        prefix: [0xff, 0xfe],
      },
      {
        name: "utf16be.txt",
        bytes: Buffer.from([0xfe, 0xff, 0x00, 0x6f, 0x00, 0x6e, 0x00, 0x65]),
        encoding: "utf16be",
        prefix: [0xfe, 0xff],
      },
    ];
    for (const fixture of fixtures) {
      await writeFile(join(root, fixture.name), fixture.bytes);
      const loaded = await readProjectTextFileIn(root, fixture.name);
      assert.equal(loaded.content, "one");
      assert.equal(loaded.binary, false);
      assert.equal(loaded.encoding, fixture.encoding);
      await writeProjectTextFileIn(root, fixture.name, "two", "one");
      const saved = await readFile(join(root, fixture.name));
      assert.deepEqual([...saved.subarray(0, fixture.prefix.length)], fixture.prefix);
      assert.equal((await readProjectTextFileIn(root, fixture.name)).content, "two");
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("editor atomically converts to an explicitly selected encoding", async () => {
  const root = await mkdtemp(join(tmpdir(), "mixdog-editor-encoding-convert-"));
  const file = join(root, "note.txt");
  try {
    await writeFile(file, "one", "utf8");
    await writeProjectTextFileIn(root, "note.txt", "two", "one", "utf16be");
    const loaded = await readProjectTextFileIn(root, "note.txt");
    assert.equal(loaded.content, "two");
    assert.equal(loaded.encoding, "utf16be");
    assert.deepEqual([...(await readFile(file)).subarray(0, 2)], [0xfe, 0xff]);
    await assert.rejects(
      writeProjectTextFileIn(root, "note.txt", "three", "stale", "utf8"),
      /changed on disk/i,
    );
    assert.equal((await readProjectTextFileIn(root, "note.txt")).encoding, "utf16be");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("editor crash backups are isolated, bounded, and explicitly removable", async () => {
  const root = await mkdtemp(join(tmpdir(), "mixdog-editor-backup-"));
  const source = join(root, "project", "note.txt");
  try {
    assert.equal(await readEditorBackup(root, source), null);
    const written = await writeEditorBackup(root, source, "draft", "disk");
    assert.equal(written.content, "draft");
    assert.deepEqual(await readEditorBackup(root, source), written);
    assert.equal(await readEditorBackup(root, join(root, "project", "other.txt")), null);
    await deleteEditorBackup(root, source);
    assert.equal(await readEditorBackup(root, source), null);
    await assert.rejects(
      writeEditorBackup(root, source, "x".repeat(4_194_305), "disk"),
      /content is invalid/i,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("workspace edits compare every file before writing and roll back a later failure", async () => {
  const root = await mkdtemp(join(tmpdir(), "mixdog-workspace-edit-"));
  try {
    await writeFile(join(root, "one.txt"), "one", "utf8");
    await writeFile(join(root, "two.txt"), "two", "utf8");
    await writeProjectTextFilesIn(root, [
      { relPath: "one.txt", expectedContent: "one", content: "ONE" },
      { relPath: "two.txt", expectedContent: "two", content: "TWO" },
    ]);
    assert.equal(await readFile(join(root, "one.txt"), "utf8"), "ONE");
    assert.equal(await readFile(join(root, "two.txt"), "utf8"), "TWO");

    await writeFile(join(root, "two.txt"), "external", "utf8");
    await assert.rejects(writeProjectTextFilesIn(root, [
      { relPath: "one.txt", expectedContent: "ONE", content: "again" },
      { relPath: "two.txt", expectedContent: "TWO", content: "again" },
    ]), /changed on disk/i);
    assert.equal(await readFile(join(root, "one.txt"), "utf8"), "ONE");
    assert.equal(await readFile(join(root, "two.txt"), "utf8"), "external");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

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

test("desktop live-work projection removes terminal history, stale paired jobs, and trims IPC records", () => {
  const state = projectDesktopLiveWorkState({
    agentWorkers: [
      {
        tag: "build", agent: "worker", provider: "openai", model: "gpt-5.6-codex",
        status: "running", startedAt: 10, sessionId: "private", output: "large",
      },
      { tag: "old", status: "completed", startedAt: 1, finishedAt: 2 },
      { tag: "stale-pair", status: "idle", stage: "idle", startedAt: 30 },
      { tag: "conflicted", status: "idle", stage: "running", startedAt: 40 },
      { tag: "queued-reuse", status: "idle", startedAt: 50 },
    ],
    agentJobs: [
      {
        task_id: "job-1", type: "review", provider: "anthropic", model: "claude-opus-4-6",
        stage: "running", startedAt: 20, error: "hidden",
      },
      { task_id: "job-2", status: "success", startedAt: 2 },
      { tag: "stale-pair", task_id: "job-stale", status: "running", startedAt: 30 },
      { tag: "conflicted", task_id: "job-conflicted", status: "running", startedAt: 40 },
      { tag: "queued-reuse", task_id: "job-queued", type: "worker", status: "queued", startedAt: 60 },
    ],
    activeToolSummary: "2:100:1:200",
    remoteEnabled: 1,
  });
  assert.deepEqual(state.agentWorkers, [
    {
      tag: "build", agent: "worker", provider: "openai", model: "gpt-5.6-codex",
      status: "running", startedAt: 10,
    },
  ]);
  assert.deepEqual(state.agentJobs, [
    {
      type: "review", provider: "anthropic", model: "claude-opus-4-6",
      task_id: "job-1", stage: "running", startedAt: 20,
    },
    {
      tag: "queued-reuse", type: "worker", task_id: "job-queued",
      status: "queued", startedAt: 60,
    },
  ]);
  assert.deepEqual(state.activeTools, {
    explore: { count: 2, startedAt: 100 },
    search: { count: 1, startedAt: 200 },
  });
  assert.equal(state.remoteEnabled, false);
});

test("desktop mirrors the machine-global remote owner without polling", async () => {
  const root = await mkdtemp(join(tmpdir(), "mixdog-desktop-remote-owner-"));
  const host = new EngineHost({
    runtimeRoot: root,
    createEngine: async () => {
      throw new Error("remote owner projection must not boot the engine");
    },
  });
  const published = [];
  const unsubscribe = host.subscribe((snapshot) => published.push(snapshot));
  try {
    assert.deepEqual(normalizedChannelRemoteState({
      enabled: true,
      sessionId: "remote_cli",
      daemonPid: process.pid,
    }), {
      enabled: true,
      sessionId: "remote_cli",
      daemonPid: process.pid,
    });
    await writeFile(channelRemoteStatePath(root), JSON.stringify({
      enabled: true,
      sessionId: "remote_cli",
      daemonPid: process.pid,
      updatedAt: Date.now(),
    }));
    for (let i = 0; i < 30 && host.getSnapshot()?.remoteSessionId !== "remote_cli"; i++) {
      await new Promise((resolveWait) => setTimeout(resolveWait, 10));
    }
    assert.equal(host.getSnapshot()?.remoteEnabled, true);
    assert.equal(host.getSnapshot()?.remoteSessionId, "remote_cli");
    assert.equal(published.some((snapshot) => snapshot?.remoteSessionId === "remote_cli"), true);

    await writeFile(channelRemoteStatePath(root), JSON.stringify({
      enabled: false,
      sessionId: null,
      daemonPid: process.pid,
      updatedAt: Date.now(),
    }));
    for (let i = 0; i < 30 && host.getSnapshot()?.remoteEnabled === true; i++) {
      await new Promise((resolveWait) => setTimeout(resolveWait, 10));
    }
    assert.equal(host.getSnapshot()?.remoteEnabled, false);
    assert.equal(host.getSnapshot()?.remoteSessionId, null);
  } finally {
    unsubscribe();
    await host.dispose();
    await rm(root, { recursive: true, force: true });
  }
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
      lastUsedAt: 8,
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
    { id: "cli_1", title: "Shared backend title", preview: "CLI lead", cwd: "C:\\cli", desktopSession: null },
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
    activityAt: 8,
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
  assert.equal(summaries[2].title, "Shared backend title");
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
    {
      id: "synthetic_runtime",
      preview: "[mixdog-runtime] internal lifecycle row",
      updatedAt: 9,
      cwd: "C:\\app\\workspace\\unclassified",
      desktopSession: { classification: "task", projectPath: null },
    },
    {
      id: "interrupted",
      preview: "[Request interrupted by user]",
      updatedAt: 8,
      cwd: "C:\\app\\workspace\\unclassified",
      desktopSession: { classification: "task", projectPath: null },
    },
    {
      id: "compacted_recovered",
      preview: `Re-attached after compaction
<prior-compacted-context>
[2026-07-28 11:08] u: Restore the real session title #55871
</prior-compacted-context>`,
      updatedAt: 7,
      cwd: "C:\\app\\workspace\\unclassified",
      desktopSession: { classification: "task", projectPath: null },
    },
  ], "blank_active", {}, { blank_named: "Kept by name" });

  assert.deepEqual(
    summaries.map((row) => row.id),
    ["blank_active", "blank_named", "compacted_recovered"],
  );
  assert.equal(summaries[0].currentSession, true);
  assert.equal(summaries[1].title, "Kept by name");
  assert.equal(summaries[2].title, "Restore the real session title");
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
    {
      id: "fresh_agent_heartbeat",
      preview: "Fresh child agent heartbeat",
      agentHeartbeatAt: now - 2_000,
      cwd: "C:\\work",
    },
  ], "", {}, {}, now);

  assert.equal(rows.find((row) => row.id === "fresh_heartbeat")?.working, true);
  assert.equal(rows.find((row) => row.id === "stale_heartbeat")?.working, undefined);
  assert.equal(rows.find((row) => row.id === "fresh_agent_heartbeat")?.working, true);
  assert.equal(rows.find((row) => row.id === "fresh_agent_heartbeat")?.agentWorking, true);
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

test("lane frames carry an authoritative content generation, not an arrival counter", () => {
  const item = (id, text) => ({ id, kind: "assistant", text });
  const base = { sessionId: "gen", items: [item("a", "one"), item("b", "two")] };
  assert.equal(sessionTranscriptGeneration(base), sessionTranscriptGeneration({ ...base }),
    "re-projecting the same transcript keeps one generation");
  assert.notEqual(sessionTranscriptGeneration(base),
    sessionTranscriptGeneration({ ...base, items: [...base.items, item("c", "three")] }),
    "appending a row is a new generation");
  assert.notEqual(sessionTranscriptGeneration(base),
    sessionTranscriptGeneration({ ...base, items: [item("a", "one")] }),
    "trailing deletion is a new generation");
  assert.notEqual(sessionTranscriptGeneration(base),
    sessionTranscriptGeneration({ ...base, items: [] }),
    "a clear is a new generation");
  assert.notEqual(sessionTranscriptGeneration(base),
    sessionTranscriptGeneration({
      ...base,
      items: [item("a", "one"), item("b", "two rewritten")],
    }),
    "a tail rewrite is a new generation");
  assert.notEqual(sessionTranscriptGeneration(base),
    sessionTranscriptGeneration({
      ...base,
      items: [item("a", "one"), item("b", "TWO")],
    }),
    "a same-length tail rewrite is a new generation");
  assert.notEqual(sessionTranscriptGeneration({
    ...base,
    items: [item("a", "one"), item("middle", "before"), item("b", "two")],
  }), sessionTranscriptGeneration({
    ...base,
    items: [item("a", "one"), item("middle", "after!"), item("b", "two")],
  }), "a middle-row rewrite is a new generation");

  // Owner publications are stamped at the lane boundary; peeks/replays carry
  // whatever the host decided, so a stale projection cannot look newer.
  const stamped = [];
  let revision = 4;
  const lanes = createSessionLiveLanes({
    intervalMs: 5,
    projectSnapshot: () => base,
    describeLiveFrame: (sessionId, snapshot) => {
      assert.equal(sessionId, "gen");
      assert.equal(snapshot, base);
      return { frameSource: "live", contentRevision: revision };
    },
  });
  const stop = lanes.subscribe((update) => stamped.push(update));
  lanes.attach({
    getState: () => ({ sessionId: "gen" }),
    subscribe: () => () => {},
  });
  assert.equal(stamped.length, 1);
  assert.equal(stamped[0].frameSource, "live");
  assert.equal(stamped[0].contentRevision, 4);
  lanes.emitPeek({ sessionId: "gen", snapshot: base, frameSource: "replay", contentRevision: 4 });
  assert.deepEqual(
    stamped.map((update) => `${update.frameSource}:${update.contentRevision}`),
    ["live:4", "replay:4"],
    "a replay re-carries the accepted generation instead of minting a new one");
  revision = 5;
  lanes.replay({ getState: () => ({ sessionId: "gen" }), subscribe: () => () => {} });
  assert.equal(stamped.length, 2, "replay() only re-emits an attached engine");
  stop();
  lanes.detachAll();
});

test("session watcher pushes keep the process-global catalog when the warm engine is workspace-scoped", async () => {
  const root = await mkdtemp(join(tmpdir(), "mixdog-global-session-push-"));
  const originalCwd = process.cwd();
  const workspace = join(root, "workspace", "unclassified");
  await mkdir(workspace, { recursive: true });
  const active = {
    id: "desktop_active_scope",
    preview: "Active scope",
    updatedAt: 20,
    cwd: workspace,
    desktopSession: { classification: "task", projectPath: null },
  };
  const other = {
    id: "desktop_other_scope",
    preview: "Other scope",
    updatedAt: 10,
    cwd: join(root, "project"),
    desktopSession: { classification: "project", projectPath: join(root, "project") },
  };
  const engine = {
    getState: () => ({ sessionId: active.id, items: [] }),
    subscribe: () => () => {},
    listSessions: () => [active],
    dispose: async () => {},
  };
  const host = new EngineHost({
    userDataPath: root,
    createEngine: async () => engine,
    loadSessionStore: async () => ({
      listStoredSessionSummaries: () => [active, other],
    }),
  });
  try {
    await host.startTask();
    assert.deepEqual(
      (await host.listSessions()).map((row) => row.id),
      [active.id, other.id],
      "warm listings must keep the process-global catalog",
    );
    let pushed = [];
    host.subscribeSessions((rows) => { pushed = rows; });
    await host.emitSessionsChanged();
    assert.deepEqual(pushed.map((row) => row.id), [active.id, other.id]);
  } finally {
    await host.dispose();
    process.chdir(originalCwd);
    await rm(root, { recursive: true, force: true });
  }
});

test("agent pool publishes the process-global worker index independently of lead session state", async () => {
  const root = await mkdtemp(join(tmpdir(), "mixdog-global-agent-pool-"));
  let rows = [{
    tag: "pool-worker",
    sessionId: "agent_child_pool",
    ownerSessionId: "lead_owner_pool",
    agent: "worker",
    provider: "openai",
    model: "gpt-test",
    status: "running",
    stage: "streaming",
    startedAt: new Date().toISOString(),
  }];
  const host = new EngineHost({
    userDataPath: root,
    createEngine: async () => ({ getState: () => ({}), subscribe: () => () => {}, dispose: async () => {} }),
    loadSessionStore: async () => ({
      listStoredSessionSummaries: () => [],
      listStoredAgentWorkers: () => rows,
    }),
  });
  const publications = [];
  const unsubscribe = host.subscribeAgentPool((agents) => publications.push(agents));
  try {
    await host.emitAgentPoolChanged();
    assert.equal(publications.at(-1)?.[0]?.sessionId, "agent_child_pool");
    assert.equal(publications.at(-1)?.[0]?.ownerSessionId, "lead_owner_pool");
    rows = [];
    await host.emitAgentPoolChanged();
    assert.deepEqual(publications.at(-1), [],
      "the row must disappear only when the worker index leaves active lifecycle");
  } finally {
    unsubscribe();
    await host.dispose();
    await rm(root, { recursive: true, force: true });
  }
});

test("stored agent pool recovers every fresh heartbeat child when the worker index is empty", async () => {
  const { mkdir, writeFile, utimes, rm: remove } = await import("node:fs/promises");
  const { listStoredAgentWorkers } = await import(
    "../../../../src/runtime/agent/orchestrator/session/store-summary-reader.mjs"
  );
  const root = await mkdtemp(join(tmpdir(), "mixdog-heartbeat-agent-pool-"));
  const previousDataDir = process.env.MIXDOG_DATA_DIR;
  process.env.MIXDOG_DATA_DIR = root;
  const sessionsDir = join(root, "sessions");
  await mkdir(sessionsDir, { recursive: true });
  await writeFile(join(root, "agent-workers.json"), JSON.stringify({
    version: 2,
    workers: {},
    tombstones: {},
  }));
  const writeSession = async (id, fields, heartbeatAgeMs = 0) => {
    await writeFile(join(sessionsDir, `${id}.json`), JSON.stringify({
      id,
      owner: "agent",
      ownerSessionId: "lead-owner",
      agent: "heavy-worker",
      agentTag: id,
      status: "closed",
      closed: true,
      createdAt: new Date(Date.now() - 10_000).toISOString(),
      ...fields,
    }));
    const heartbeat = join(sessionsDir, `${id}.hb`);
    await writeFile(heartbeat, "");
    if (heartbeatAgeMs > 0) {
      const stale = new Date(Date.now() - heartbeatAgeMs);
      await utimes(heartbeat, stale, stale);
    }
  };
  try {
    await writeSession("agent-fresh-a", {});
    await writeSession("agent-fresh-b", { agent: "reviewer" });
    await writeSession("agent-stale", {}, 3 * 60 * 1000);
    await writeSession("lead-heartbeat", {
      owner: "cli",
      ownerSessionId: null,
      agent: "lead",
    });
    assert.deepEqual(
      listStoredAgentWorkers().map((row) => row.sessionId).sort(),
      ["agent-fresh-a", "agent-fresh-b"],
    );
    assert.equal(listStoredAgentWorkers()[0].status, "running",
      "fresh heartbeat must override the detached durable closed status");
    await remove(join(sessionsDir, "agent-fresh-a.hb"));
    assert.deepEqual(
      listStoredAgentWorkers().map((row) => row.sessionId),
      ["agent-fresh-b"],
      "heartbeat deletion must remove only the completed child",
    );
  } finally {
    if (previousDataDir === undefined) delete process.env.MIXDOG_DATA_DIR;
    else process.env.MIXDOG_DATA_DIR = previousDataDir;
    await remove(root, { recursive: true, force: true });
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
    peekSessionTranscript: (sessionId) => ({
      sessionId,
      items: [{ id: "cold-answer", kind: "assistant", text: "Cold pane restored" }],
      provider: "openai",
      model: "gpt-test",
      cwd: workspace,
      desktopSession: { classification: "task", projectPath: null },
      stats: {
        currentContextTokens: 0,
        currentEstimatedContextTokens: 33_000,
        currentContextSource: "estimated",
      },
      contextWindow: 272_000,
      rawContextWindow: 272_000,
      displayContextWindow: 244_800,
      compactBoundaryTokens: 272_000,
      autoCompactTokenLimit: 244_800,
      effectiveContextWindowPercent: 100,
    }),
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
      async readStoredSessionTranscript(sessionId) {
        return {
          sessionId,
          items: [{ id: "cold-answer", kind: "assistant", text: "Cold pane restored" }],
          provider: "openai",
          model: "gpt-test",
          cwd: workspace,
          desktopSession: { classification: "task", projectPath: null },
          stats: {
            currentContextTokens: 0,
            currentEstimatedContextTokens: 24_000,
            currentContextSource: "estimated",
          },
          contextWindow: 200_000,
          rawContextWindow: 256_000,
          displayContextWindow: 180_000,
          autoCompactTokenLimit: 160_000,
        };
      },
    }),
  });
  try {
    assert.deepEqual((await host.listSessions()).map((row) => row.id), ["cold_indexed"]);
    assert.equal(engineCreates, 0, "session list response must win the first paint");
    assert.deepEqual(storeCalls, [{ rebuildIfMissing: false }]);
    const paneFrames = [];
    const stopPaneFrames = host.subscribeSessionStates((update) => paneFrames.push(update));
    assert.equal(await host.setVisibleSessions(["cold_indexed"]), true);
    assert.match(paneFrames.at(-1)?.snapshot.items?.[0]?.text || "", /Cold pane restored/);
    assert.equal(paneFrames.at(-1)?.snapshot.stats?.currentEstimatedContextTokens, 24_000);
    assert.equal(paneFrames.at(-1)?.snapshot.contextWindow, 200_000);
    assert.equal(paneFrames.at(-1)?.snapshot.rawContextWindow, 256_000);
    assert.equal(paneFrames.at(-1)?.snapshot.displayContextWindow, 180_000);
    assert.equal(paneFrames.at(-1)?.snapshot.autoCompactTokenLimit, 160_000);
    assert.equal(engineCreates, 0, "a visible cold pane must hydrate without creating an engine");
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(engineCreates, 0, "background work must not compete with a user session choice");
    await host.startTask();
    assert.equal(engineCreates, 1, "the user-selected task should own the first runtime load");
    const refreshDeadline = Date.now() + 1_000;
    while (Date.now() < refreshDeadline
      && paneFrames.at(-1)?.snapshot.stats?.currentEstimatedContextTokens !== 33_000) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(paneFrames.at(-1)?.snapshot.stats?.currentEstimatedContextTokens, 33_000,
      "engine readiness must refresh every visible lane without a focus click");
    assert.equal(paneFrames.at(-1)?.snapshot.displayContextWindow, 244_800);
    assert.equal(paneFrames.at(-1)?.snapshot.compactBoundaryTokens, 272_000);
    assert.equal(paneFrames.at(-1)?.snapshot.autoCompactTokenLimit, 244_800);
    assert.equal(paneFrames.at(-1)?.snapshot.effectiveContextWindowPercent, 100);
    stopPaneFrames();
  } finally {
    await host.dispose();
    process.chdir(originalCwd);
    await rm(root, { recursive: true, force: true });
  }
});

test("visible cold panes mirror external owner frames without creating engines", async () => {
  const root = await mkdtemp(join(tmpdir(), "mixdog-visible-live-pane-"));
  const originalCwd = process.cwd();
  const workspace = join(root, "workspace", "unclassified");
  await mkdir(workspace, { recursive: true });
  let engineCreates = 0;
  let mirrorOptions = null;
  let mirrorDisposals = 0;
  let storedReads = 0;
  let storedText = "last persisted prompt";
  const host = new EngineHost({
    userDataPath: root,
    createEngine: async () => {
      engineCreates += 1;
      return {
        getState: () => ({ sessionId: null, items: [] }),
        subscribe: () => () => {},
        peekSessionTranscript: (sessionId) => ({
          sessionId,
          items: [{ id: "prepared-copy", kind: "user", text: "prepared transcript copy" }],
          stats: {
            currentContextTokens: 0,
            currentEstimatedContextTokens: 33_000,
            currentContextSource: "estimated",
          },
          contextWindow: 272_000,
          rawContextWindow: 272_000,
          displayContextWindow: 244_800,
          compactBoundaryTokens: 272_000,
          autoCompactTokenLimit: 244_800,
          effectiveContextWindowPercent: 100,
        }),
        dispose: async () => {},
      };
    },
    loadSessionStore: async () => ({
      listStoredSessionSummaries: () => [],
      async readStoredSessionTranscript(sessionId) {
        storedReads += 1;
        return {
          sessionId,
          items: [{ id: "persisted-user", kind: "user", text: storedText }],
          provider: "openai",
          model: "gpt-test",
          cwd: workspace,
          desktopSession: { classification: "task", projectPath: null },
          stats: {
            currentContextTokens: 0,
            currentEstimatedContextTokens: 33_000,
            currentContextSource: "estimated",
          },
          contextWindow: 272_000,
          rawContextWindow: 272_000,
          displayContextWindow: 244_800,
          compactBoundaryTokens: 272_000,
          autoCompactTokenLimit: 244_800,
          effectiveContextWindowPercent: 100,
          preparedContextProjection: true,
        };
      },
      async createStoredSessionLiveViewer(_sessionId, options) {
        mirrorOptions = options;
        return { dispose() { mirrorDisposals += 1; } };
      },
    }),
  });
  try {
    const updates = [];
    const unsubscribe = host.subscribeSessionStates((update) => updates.push(update));
    assert.equal(await host.setVisibleSessions(["desktop_external_live"]), true);
    assert.equal(engineCreates, 0, "background mirrors must not create full engines");
    assert.equal(updates.at(-1)?.snapshot.items?.[0]?.text, "last persisted prompt");
    storedText = "agent in-memory progress";
    assert.equal(await host.peekSession("desktop_external_live"), true);
    assert.equal(updates.at(-1)?.snapshot.items?.[0]?.text, "agent in-memory progress",
      "an explicit peek must refresh a retained non-live child frame");
    assert.equal(storedReads, 2);
    mirrorOptions.onSnapshot({
      ...mirrorOptions.initialSnapshot,
      items: [{ id: "owner-latest", kind: "assistant", text: "owner live progress" }],
      displayContextWindow: 272_000,
      busy: true,
    });
    assert.equal(updates.at(-1)?.snapshot.items?.[0]?.text, "owner live progress");
    assert.equal(updates.at(-1)?.snapshot.busy, true);
    assert.equal(updates.at(-1)?.snapshot.displayContextWindow, 244_800,
      "a cold prepared context projection must survive the first owner frame");
    await host.startTask();
    const projectionDeadline = Date.now() + 1_000;
    while (Date.now() < projectionDeadline
      && updates.at(-1)?.snapshot.stats?.currentEstimatedContextTokens !== 33_000) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(updates.at(-1)?.snapshot.items?.[0]?.text, "owner live progress",
      "engine readiness must retain the external owner's transcript");
    assert.equal(updates.at(-1)?.snapshot.stats?.currentEstimatedContextTokens, 33_000);
    assert.equal(updates.at(-1)?.snapshot.displayContextWindow, 244_800);
    mirrorOptions.onSnapshot({
      ...mirrorOptions.initialSnapshot,
      items: [{ id: "owner-next", kind: "assistant", text: "owner next progress" }],
      stats: {
        currentContextTokens: 0,
        currentEstimatedContextTokens: 24_000,
        currentContextSource: "estimated",
      },
      displayContextWindow: 272_000,
      busy: true,
    });
    assert.equal(updates.at(-1)?.snapshot.items?.[0]?.text, "owner next progress");
    assert.equal(updates.at(-1)?.snapshot.stats?.currentEstimatedContextTokens, 33_000,
      "later owner frames must retain the prepared context projection");
    assert.equal(updates.at(-1)?.snapshot.displayContextWindow, 244_800);
    storedText = "stale disk prompt";
    assert.equal(await host.peekSession("desktop_external_live"), true);
    assert.equal(updates.at(-1)?.snapshot.items?.[0]?.text, "owner next progress",
      "an explicit peek must replay rather than replace an authoritative live frame");
    assert.equal(storedReads, 3,
      "live peeks must not read again after the one engine-ready projection read");
    mirrorOptions.onOwnerClosed();
    await new Promise((resolve) => setTimeout(resolve, 1_600));
    assert.equal(updates.at(-1)?.snapshot.items?.[0]?.text, "owner next progress",
      "a completed owner's latest frame must not regress to an older disk prompt");
    assert.equal(updates.at(-1)?.snapshot.busy, false,
      "a retained completed frame must clear transient owner activity");
    assert.equal(mirrorDisposals, 1,
      "owner closure should replace the dropped viewer once");
    await host.setVisibleSessions([]);
    assert.equal(mirrorDisposals, 2, "closing the pane must release its replacement owner pipe");
    unsubscribe();
  } finally {
    await host.dispose();
    process.chdir(originalCwd);
    await rm(root, { recursive: true, force: true });
  }
});

// A projection that carries no route blanked the pane's model controls; the
// route belongs to the SESSION, so the host stamps the one it remembers.
test("a routeless stored projection keeps the session's remembered model route", async () => {
  const root = await mkdtemp(join(tmpdir(), "mixdog-route-stamp-"));
  const originalCwd = process.cwd();
  const workspace = join(root, "workspace", "unclassified");
  await mkdir(workspace, { recursive: true });
  let route = { provider: "openai", model: "gpt-test", effort: "high", fast: true };
  const host = new EngineHost({
    userDataPath: root,
    createEngine: async () => ({
      getState: () => ({ sessionId: null, items: [] }),
      subscribe: () => () => {},
      dispose: async () => {},
    }),
    loadSessionStore: async () => ({
      listStoredSessionSummaries: () => [],
      async readStoredSessionTranscript(sessionId) {
        return {
          sessionId,
          items: [{ id: "persisted-user", kind: "user", text: "keep my model" }],
          ...route,
          cwd: workspace,
          desktopSession: { classification: "task", projectPath: null },
        };
      },
    }),
  });
  try {
    const updates = [];
    const unsubscribe = host.subscribeSessionStates((update) => updates.push(update));
    assert.equal(await host.setVisibleSessions(["desktop_route_memory"]), true);
    assert.equal(updates.at(-1)?.snapshot.model, "gpt-test");
    route = {};
    assert.equal(await host.peekSession("desktop_route_memory"), true);
    assert.equal(updates.at(-1)?.snapshot.provider, "openai",
      "a routeless projection must not blank the pane's model controls");
    assert.equal(updates.at(-1)?.snapshot.model, "gpt-test");
    assert.equal(updates.at(-1)?.snapshot.effort, "high");
    assert.equal(updates.at(-1)?.snapshot.fast, true);
    unsubscribe();
  } finally {
    await host.dispose();
    process.chdir(originalCwd);
    await rm(root, { recursive: true, force: true });
  }
});

// Co-editing with a terminal: when the terminal (the owner) exits, a viewer-only
// pane froze on a disk projection and NOTHING drained the session's steering
// spool. The pane takes the session over instead.
test("a closed external owner promotes its visible pane instead of freezing it", async () => {
  const root = await mkdtemp(join(tmpdir(), "mixdog-owner-promote-"));
  const originalCwd = process.cwd();
  const workspace = join(root, "workspace", "unclassified");
  await mkdir(workspace, { recursive: true });
  const resumes = [];
  let mirrorOptions = null;
  const host = new EngineHost({
    userDataPath: root,
    createEngine: async () => {
      let state = { sessionId: null, items: [] };
      const listeners = new Set();
      return {
        // The daemon route is what makes a pane view attachable; a test engine
        // that claims it exercises the same promotion path.
        isRemoteEngine: true,
        getState: () => state,
        subscribe: (listener) => {
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
        listSessions: () => [],
        newSession: async () => true,
        resume: async (id) => {
          resumes.push(id);
          state = {
            sessionId: id,
            items: [{ id: "promoted", kind: "assistant", text: "promoted frame" }],
          };
          for (const listener of listeners) listener();
          return true;
        },
        dispose: async () => {},
      };
    },
    loadSessionStore: async () => ({
      listStoredSessionSummaries: () => [],
      async readStoredSessionTranscript(sessionId) {
        return {
          sessionId,
          items: [{ id: "persisted-user", kind: "user", text: "owned by the terminal" }],
          provider: "openai",
          model: "gpt-test",
          cwd: workspace,
          desktopSession: { classification: "task", projectPath: null },
        };
      },
      async createStoredSessionLiveViewer(_sessionId, options) {
        mirrorOptions = options;
        return { dispose() {} };
      },
    }),
  });
  try {
    await host.startTask();
    assert.equal(await host.setVisibleSessions(["desktop_owner_left"]), true);
    assert.ok(mirrorOptions, "a cold pane attaches to the external owner's pipe");
    assert.deepEqual(resumes, [],
      "a pane with a live external owner must NOT resume the session itself");
    mirrorOptions.onOwnerClosed();
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline && !resumes.includes("desktop_owner_left")) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    assert.deepEqual(resumes, ["desktop_owner_left"],
      "a pane whose owner exited must take the session over (steering drain + live frames)");
  } finally {
    await host.dispose();
    process.chdir(originalCwd);
    await rm(root, { recursive: true, force: true });
  }
});

test("stored frame with identical ids but stripped tool payloads counts as a regression", () => {
  const live = {
    sessionId: "s1",
    items: [
      { id: "u1", kind: "user", text: "run it" },
      { id: "t1", kind: "tool", name: "agent", args: { agent: "worker" }, result: "agent response body" },
      { id: "d1", kind: "turndone", text: "Composed for 7s" },
    ],
  };
  const storedStripped = {
    sessionId: "s1",
    items: [
      { id: "u1", kind: "user", text: "run it" },
      // Disk projections can trail the engine: same row id, payload gone.
      // Publishing this frame collapsed a rendered agent Response card back
      // to its bare Spawn row on an unfocused pane (user: cards vanish).
      { id: "t1", kind: "tool", name: "agent" },
      { id: "d1", kind: "turndone", text: "Composed for 7s" },
    ],
  };
  assert.equal(storedVisibleSessionSnapshotRegresses(live, storedStripped), true,
    "losing a tool result/args payload must keep the richer retained frame");
  const storedEqual = {
    sessionId: "s1",
    items: live.items.map((item) => ({ ...item })),
  };
  assert.equal(storedVisibleSessionSnapshotRegresses(live, storedEqual), false,
    "an equal-or-newer disk read still takes ownership normally");
  const storedGrown = {
    sessionId: "s1",
    items: [
      ...live.items.map((item) => ({ ...item })),
      { id: "u2", kind: "user", text: "next prompt" },
    ],
  };
  assert.equal(storedVisibleSessionSnapshotRegresses(live, storedGrown), false,
    "a longer stored transcript with intact payloads must win");
});

test("visible child checkpoint writes push through the pane session lane without polling", async () => {
  const root = await mkdtemp(join(tmpdir(), "mixdog-visible-checkpoint-pane-"));
  const dataRoot = join(root, "data");
  const sessionsDir = join(dataRoot, "sessions");
  const checkpointsDir = join(dataRoot, "turn-checkpoints");
  await mkdir(sessionsDir, { recursive: true });
  await mkdir(checkpointsDir, { recursive: true });
  const workerIndex = join(dataRoot, "agent-workers.json");
  await writeFile(workerIndex, JSON.stringify({ version: 2, workers: {} }));
  let storedText = "initial child task";
  let storedReads = 0;
  let enginePeeks = 0;
  const host = new EngineHost({
    userDataPath: root,
    createEngine: async () => ({
      getState: () => ({ sessionId: null, items: [] }),
      subscribe: () => () => {},
      dispose: async () => {},
    }),
    loadSessionStore: async () => ({
      listStoredSessionSummaries: () => [],
      storedAgentWorkerIndexPath: () => workerIndex,
      async readStoredSessionTranscript(sessionId) {
        storedReads += 1;
        return {
          sessionId,
          items: [{ id: "child-status", kind: "assistant", text: storedText }],
          provider: "openai",
          model: "gpt-test",
          readOnlyDetachedAgent: true,
        };
      },
    }),
  });
  host.engine = {
    getState: () => ({ sessionId: "desktop-parent", items: [] }),
    subscribe: () => () => {},
    peekSessionTranscript: (sessionId) => {
      enginePeeks += 1;
      return {
        sessionId,
        items: [{ id: "stale-task", kind: "user", text: "stale engine Task row" }],
      };
    },
    dispose: async () => {},
  };
  const updates = [];
  const unsubscribe = host.subscribeSessionStates((update) => updates.push(update));
  try {
    assert.equal(await host.setVisibleSessions(["agent_visible_checkpoint"]), true);
    assert.equal(updates.at(-1)?.snapshot.items?.[0]?.text, "initial child task");
    assert.equal(enginePeeks, 0,
      "an unrelated active engine must not mask a detached child checkpoint projection");
    storedText = "checkpoint assistant and tool progress";
    await writeFile(
      join(checkpointsDir, "agent_visible_checkpoint.json"),
      JSON.stringify({ updatedAt: Date.now() }),
    );
    const deadline = Date.now() + 2_000;
    while (Date.now() < deadline
      && updates.at(-1)?.snapshot.items?.[0]?.text !== storedText) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.equal(updates.at(-1)?.snapshot.items?.[0]?.text, storedText,
      "checkpoint fs event must publish the same keyed session lane");
    assert.ok(storedReads >= 2);
    await host.setVisibleSessions([]);
    const settledCount = updates.length;
    storedText = "must stay hidden after close";
    await writeFile(
      join(checkpointsDir, "agent_visible_checkpoint.json"),
      JSON.stringify({ updatedAt: Date.now() + 1 }),
    );
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(updates.length, settledCount,
      "closing the child pane must release its storage observation");
  } finally {
    unsubscribe();
    await host.dispose();
    await rm(root, { recursive: true, force: true });
  }
});

test("a visible detached child agent follows its heartbeat until the pane closes", async () => {
  const root = await mkdtemp(join(tmpdir(), "mixdog-detached-heartbeat-pane-"));
  const dataRoot = join(root, "data");
  const sessionsDir = join(dataRoot, "sessions");
  const checkpointsDir = join(dataRoot, "turn-checkpoints");
  await mkdir(sessionsDir, { recursive: true });
  await mkdir(checkpointsDir, { recursive: true });
  const workerIndex = join(dataRoot, "agent-workers.json");
  await writeFile(workerIndex, JSON.stringify({ version: 2, workers: {} }));
  const texts = new Map([
    ["agent_hb_child", "child turn start"],
    ["lead_hb_session", "lead transcript"],
  ]);
  const detached = new Set(["agent_hb_child"]);
  const reads = new Map();
  // Real heartbeats bump the mtime of an EXISTING file; create both up front so
  // every later write is a change event, never a creation.
  const childHeartbeat = join(sessionsDir, "agent_hb_child.hb");
  const leadHeartbeat = join(sessionsDir, "lead_hb_session.hb");
  await writeFile(childHeartbeat, "0");
  await writeFile(leadHeartbeat, "0");
  const host = new EngineHost({
    userDataPath: root,
    createEngine: async () => ({
      getState: () => ({ sessionId: null, items: [] }),
      subscribe: () => () => {},
      dispose: async () => {},
    }),
    loadSessionStore: async () => ({
      listStoredSessionSummaries: () => [],
      storedAgentWorkerIndexPath: () => workerIndex,
      async readStoredSessionTranscript(sessionId) {
        reads.set(sessionId, (reads.get(sessionId) ?? 0) + 1);
        return {
          sessionId,
          items: [{ id: `${sessionId}-item`, kind: "assistant", text: texts.get(sessionId) }],
          provider: "openai",
          model: "gpt-test",
          readOnlyDetachedAgent: detached.has(sessionId),
        };
      },
    }),
  });
  const updates = [];
  const lastText = (sessionId) => [...updates]
    .reverse()
    .find((update) => update.sessionId === sessionId)?.snapshot.items?.[0]?.text;
  const beat = async (file) => { await writeFile(file, String(Date.now())); };
  const awaitText = async (sessionId, expected) => {
    const deadline = Date.now() + 6_000;
    while (Date.now() < deadline && lastText(sessionId) !== expected) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    return lastText(sessionId);
  };
  const unsubscribe = host.subscribeSessionStates((update) => updates.push(update));
  try {
    assert.equal(
      await host.setVisibleSessions(["agent_hb_child", "lead_hb_session"]),
      true,
    );
    assert.equal(lastText("agent_hb_child"), "child turn start");
    const leadReads = reads.get("lead_hb_session");
    texts.set("agent_hb_child", "child turn in progress");
    // The child's turn is mid-flight: only the heartbeat mtime moves.
    await beat(childHeartbeat);
    await beat(leadHeartbeat);
    assert.equal(await awaitText("agent_hb_child", "child turn in progress"),
      "child turn in progress",
      "a detached child heartbeat must re-project its in-progress turn");
    assert.equal(reads.get("lead_hb_session"), leadReads,
      "an owner-backed lead heartbeat must not trigger stored re-reads");
    // Later beats on the same file (mtime bumps only) must keep following, but
    // the beat lane is rate limited: these bumps are spaced far beyond the fast
    // 50ms storage debounce yet sit inside one heartbeat budget window, so they
    // collapse into a single trailing stored read that still carries the newest
    // projection. The bound stays stall tolerant (<= 2 reads, i.e. a trailing
    // run plus at most one window rollover) while the pre-limit behaviour —
    // one read per beat — is 3 and still fails.
    texts.set("agent_hb_child", "child turn tool output");
    const burstReads = reads.get("agent_hb_child");
    await beat(childHeartbeat);
    await new Promise((resolve) => setTimeout(resolve, 250));
    await beat(childHeartbeat);
    await new Promise((resolve) => setTimeout(resolve, 250));
    await beat(childHeartbeat);
    assert.equal(await awaitText("agent_hb_child", "child turn tool output"),
      "child turn tool output",
      "repeated heartbeat mtime bumps must keep re-projecting the live turn");
    await new Promise((resolve) => setTimeout(resolve, 800));
    assert.ok(reads.get("agent_hb_child") <= burstReads + 2,
      `a beat burst inside one budget window must not parse per beat (reads delta ${
        reads.get("agent_hb_child") - burstReads})`);
    // Turn ends: the reader stops projecting a live checkpoint. The final frame
    // must still land (a finished projection only ever grows, so it clears the
    // stored-regression guard), and the detached marker must clear with it.
    const finalText = "child turn tool output and final answer";
    texts.set("agent_hb_child", finalText);
    detached.delete("agent_hb_child");
    await beat(childHeartbeat);
    assert.equal(await awaitText("agent_hb_child", finalText), finalText,
      "the finished turn must still render a final stored frame");
    const settledReads = reads.get("agent_hb_child");
    await beat(childHeartbeat);
    await new Promise((resolve) => setTimeout(resolve, 400));
    await beat(childHeartbeat);
    await new Promise((resolve) => setTimeout(resolve, 2_600));
    assert.equal(reads.get("agent_hb_child"), settledReads,
      "a terminal session must stop following heartbeats after its final frame");
    await host.setVisibleSessions([]);
    const settledCount = updates.length;
    texts.set("agent_hb_child", "must stay hidden after close");
    await beat(childHeartbeat);
    await writeFile(
      join(checkpointsDir, "agent_hb_child.json"),
      JSON.stringify({ updatedAt: Date.now() + 1 }),
    );
    await new Promise((resolve) => setTimeout(resolve, 150));
    assert.equal(updates.length, settledCount,
      "an invisible child pane must stop following its heartbeat");
  } finally {
    unsubscribe();
    await host.dispose();
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
    // middle re-uses the rows that listing already produced, so it lists
    // nothing at all (a full store scan there ran INSIDE the transition lock).
    assert.deepEqual(calls, [{ refreshFromStorage: true }, { refreshFromStorage: true }]);
  } finally {
    await host.dispose();
    process.chdir(originalCwd);
    await rm(root, { recursive: true, force: true });
  }
});

test("pooled engines stream per-session live lanes and accept routed submits", async () => {
  const root = await mkdtemp(join(tmpdir(), "mixdog-session-lanes-"));
  const originalCwd = process.cwd();
  const rows = ["desktop_lane_a", "desktop_lane_b"].map((id, index) => ({
    id,
    preview: `Lane ${index + 1}`,
    updatedAt: 2 - index,
    cwd: join(root, "workspace", "unclassified"),
    desktopSession: { classification: "task", projectPath: null },
  }));
  const engines = [];
  const makeEngine = () => {
    let state = { sessionId: "", items: [] };
    const listeners = [];
    const engine = {
      submits: [],
      disposed: 0,
      getState: () => state,
      subscribe: (listener) => {
        listeners.push(listener);
        return () => {};
      },
      submit: (prompt) => {
        engine.submits.push(prompt);
        state = { ...state, busy: true };
        for (const listener of listeners) listener();
        return true;
      },
      setState: (next) => {
        state = next;
      },
      fire: () => {
        for (const listener of listeners) listener();
      },
      listSessions: () => rows,
      newSession: async () => true,
      resume: async (id) => {
        // Session A keeps an active turn so switching away parks its engine.
        state = {
          sessionId: id,
          items: [{ kind: "agent", text: `resumed ${id}` }],
          busy: id === "desktop_lane_a",
        };
        return true;
      },
      dispose: async () => { engine.disposed += 1; },
    };
    engines.push(engine);
    return engine;
  };
  const host = new EngineHost({ userDataPath: root, createEngine: async () => makeEngine() });
  try {
    await host.listSessions();
    await host.resumeSession("desktop_lane_a");
    const updates = [];
    const unsubscribe = host.subscribeSessionStates((update) => updates.push(update));
    assert.deepEqual(updates.map((update) => update.sessionId), ["desktop_lane_a"],
      "the active pane must use the same live lane as every other visible pane");
    updates.length = 0;
    await host.resumeSession("desktop_lane_b"); // A busy -> parked
    assert.equal(engines.length, 2, "each session owns its own pooled engine");
    assert.ok(updates.some((update) => update.sessionId === "desktop_lane_a"),
      "parking A keeps publishing through the same lane");
    // Main's eager subscription can send these frames before preload installs
    // its renderer listener. Simulate that loss: pane peek must replay both the
    // active and parked pooled engines instead of returning a bare success.
    updates.length = 0;
    assert.equal(await host.peekSession("desktop_lane_b"), true);
    assert.deepEqual(updates.map((update) => update.sessionId), ["desktop_lane_b"],
      "active pane peek replays the same lane used before and after focus");
    updates.length = 0;
    assert.equal(await host.peekSession("desktop_lane_a"), true);
    assert.deepEqual(
      updates.map((update) => [update.sessionId, update.snapshot.items.at(-1)?.text]),
      [["desktop_lane_a", "resumed desktop_lane_a"]],
    );
    // A PARKED engine event streams on its own lane without touching B's.
    updates.length = 0;
    engines[0].setState({
      sessionId: "desktop_lane_a",
      items: [{ kind: "agent", text: "background progress" }],
      busy: true,
    });
    engines[0].fire();
    await new Promise((resolve) => setTimeout(resolve, ENGINE_PUBLICATION_INTERVAL_MS + 100));
    assert.ok(updates.some((update) => update.sessionId === "desktop_lane_a"
      && update.snapshot.items.at(-1)?.text === "background progress"));
    assert.ok(!updates.some((update) => update.sessionId === "desktop_lane_b"),
      "the active session must not republish for a parked engine's event");
    updates.length = 0;
    engines[1].setState({
      sessionId: "desktop_lane_b",
      items: [{ kind: "agent", text: "foreground progress" }],
      busy: true,
    });
    engines[1].fire();
    await new Promise((resolve) => setTimeout(resolve, ENGINE_PUBLICATION_INTERVAL_MS + 100));
    assert.ok(updates.some((update) => update.sessionId === "desktop_lane_b"
      && update.snapshot.items.at(-1)?.text === "foreground progress"),
    "the active pane keeps streaming through its own lane without focus-specific projection");
    // Routed submit reaches the parked engine; the active engine is untouched.
    assert.equal(await host.submitToSession("desktop_lane_a", "keep going"), true);
    assert.equal(engines[0].submits.length, 1);
    assert.equal(engines[1].submits.length, 0);
    // Once A publishes its terminal frame, the renderer keeps that bounded
    // snapshot while the now-idle engine and its runtime graph are released.
    updates.length = 0;
    engines[0].setState({
      sessionId: "desktop_lane_a",
      items: [{ kind: "assistant", id: "done", text: "background complete" }],
      busy: false,
      queued: [],
    });
    engines[0].fire();
    await new Promise((resolve) => setTimeout(resolve, ENGINE_PUBLICATION_INTERVAL_MS + 100));
    assert.ok(updates.some((update) => update.sessionId === "desktop_lane_a"
      && update.snapshot.items.at(-1)?.text === "background complete"));
    assert.equal(engines[0].disposed, 1,
      "a settled parked engine must release its retained runtime after the final lane frame");
    unsubscribe();
  } finally {
    await host.dispose();
    process.chdir(originalCwd);
    await rm(root, { recursive: true, force: true });
  }
});

test("session-switch engine disposal keeps process-global background work alive", async () => {
  const root = await mkdtemp(join(tmpdir(), "mixdog-park-dispose-"));
  const originalCwd = process.cwd();
  const rows = [
    {
      id: "desktop_park_a",
      preview: "Session A",
      updatedAt: 2,
      cwd: join(root, "workspace", "unclassified"),
      desktopSession: { classification: "task", projectPath: null },
    },
    {
      id: "desktop_park_b",
      preview: "Session B",
      updatedAt: 1,
      cwd: join(root, "workspace", "unclassified"),
      desktopSession: { classification: "task", projectPath: null },
    },
  ];
  const disposeCalls = [];
  const makeEngine = () => {
    let state = { sessionId: null, items: [] };
    return {
      getState: () => state,
      subscribe: () => () => {},
      listSessions: () => rows,
      switchContext: async () => true,
      newSession: async () => true,
      resume: async (id) => {
        // Session A keeps an active turn so switching away PARKS its engine;
        // session B stays idle so re-activating parked A must dispose B's
        // engine in place — the exact path that used to reap every session's
        // background jobs via the process-global shutdown registries.
        state = { sessionId: id, items: [], busy: id === "desktop_park_a" };
        return true;
      },
      dispose: async (reason, options) => {
        disposeCalls.push({
          reason: String(reason || ""),
          keep: options?.keepBackgroundWork === true,
        });
      },
    };
  };
  const host = new EngineHost({ userDataPath: root, createEngine: async () => makeEngine() });
  try {
    await host.listSessions();
    await host.resumeSession("desktop_park_a");
    await host.resumeSession("desktop_park_b"); // A busy -> parked
    await host.resumeSession("desktop_park_a"); // B idle -> disposed in place
    const parkedDispose = disposeCalls.find(
      (call) => call.reason === "desktop-session-activate-parked",
    );
    assert.ok(parkedDispose, "activating a parked session must dispose the idle outgoing engine");
    assert.equal(parkedDispose.keep, true,
      "in-process engine swaps must not reap process-global background work");
    for (const call of disposeCalls) {
      assert.equal(call.keep, true,
        `app-alive dispose (${call.reason}) must keep background work`);
    }
    disposeCalls.length = 0;
    await host.dispose();
    assert.ok(disposeCalls.length >= 1, "app shutdown must dispose the remaining engines");
    for (const call of disposeCalls) {
      assert.equal(call.keep, false, "app shutdown keeps the full background-work reap");
    }
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

    row.title = "First-turn LLM title";
    assert.equal((await host.listSessions())[0].title, "First-turn LLM title");
    assert.equal(host.getSnapshot().desktopSessionTitle, "First-turn LLM title");

    assert.equal(await host.submit("A newer preview must not rename this session"), true);
    const listed = await host.listSessions();
    assert.equal(listed[0].preview, "A newer preview must not rename this session");
    assert.equal(listed[0].title, "First-turn LLM title");

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

test("resume repairs a polluted profile title from the full durable session preview", async () => {
  const root = await mkdtemp(join(tmpdir(), "mixdog-session-title-resume-repair-"));
  const originalCwd = process.cwd();
  const sessionId = "desktop_resume_title_repair";
  const expectedTitle = "데스크탑에서 꺼진후에 대화내용날아가고 제목도이렇게바뀜";
  const row = {
    id: sessionId,
    preview:
      "확인 [2026-07-28 20:12] 세션 전환 후…이거 데스크탑에서 꺼진후에 대화내용날아가고 제목도이렇게바뀜",
    updatedAt: 1,
    cwd: join(root, "workspace", "unclassified"),
    desktopSession: { classification: "task", projectPath: null },
  };
  let state = { sessionId: null, items: [] };
  await writeFile(join(root, "desktop-session-metadata.json"), JSON.stringify({
    version: 2,
    titles: { [sessionId]: "확인 [2026-07-28 20:12] 세션 전환 후…" },
    names: {},
  }));
  const engine = {
    getState: () => state,
    subscribe: () => () => {},
    listSessions: () => [row],
    resume: async (id) => {
      state = {
        sessionId: id,
        items: [{
          kind: "user",
          text: "확인 [2026-07-28 20:12] 세션 전환 후…잘린 재개 창의 늦은 메시지",
        }],
      };
      return true;
    },
    dispose: async () => {},
  };
  const host = new EngineHost({ userDataPath: root, createEngine: async () => engine });
  try {
    await host.listSessions();
    const resumed = await host.resumeSession(sessionId);
    assert.equal(resumed.desktopSessionTitle, expectedTitle);
    assert.equal((await host.listSessions())[0].title, expectedTitle);
    await host.dispose();
    const metadata = JSON.parse(await readFile(
      join(root, "desktop-session-metadata.json"),
      "utf8",
    ));
    assert.equal(metadata.titles[sessionId], expectedTitle);
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
    renameSessionTitle: async (id, title) => {
      assert.equal(id, row.id);
      row.title = title;
      row.titleLocked = true;
      return true;
    },
    dispose: async () => {},
  };
  const createHost = () => new EngineHost({ userDataPath: root, createEngine: async () => engine });
  const host = createHost();
  let sessionsChanged = 0;
  host.scheduleSessionsChanged = () => { sessionsChanged += 1; };
  try {
    assert.equal((await host.listSessions())[0].title, "Generated title");
    await host.renameSession(row.id, "  Durable custom title  ");
    assert.equal(row.title, "Durable custom title");
    assert.equal(row.titleLocked, true);
    assert.equal(sessionsChanged, 1, "manual rename must notify every desktop session catalog");
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

test("host ignores pre-v2 metadata and starts clean", async () => {
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
    // Pre-v2 metadata is not shape-migrated: the row falls back to its preview.
    assert.equal((await host.listSessions())[0].title, "Newer preview");
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

test("host parks a running session engine and reconnects it after background completion", async () => {
  const root = await mkdtemp(join(tmpdir(), "mixdog-session-background-resume-"));
  const originalCwd = process.cwd();
  const workspace = join(root, "workspace", "unclassified");
  const rows = ["desktop_running", "desktop_other"].map((id, index) => ({
    id,
    preview: `Task ${index + 1}`,
    updatedAt: 2 - index,
    cwd: workspace,
    desktopSession: { classification: "task", projectPath: null },
  }));
  let runningState = {
    sessionId: "desktop_running",
    items: [
      { kind: "user", id: "prompt", text: "Keep working" },
      { kind: "assistant", id: "progress", text: "Working", status: "streaming" },
    ],
    busy: true,
  };
  let otherState = { sessionId: null, items: [], busy: false };
  let runningResumes = 0;
  let runningSwitches = 0;
  let runningDisposed = 0;
  let otherDisposed = 0;
  const runningEngine = {
    getState: () => runningState,
    subscribe: () => () => {},
    listSessions: () => rows,
    switchContext: async () => {
      runningSwitches += 1;
      return true;
    },
    resume: async () => {
      runningResumes += 1;
      return true;
    },
    dispose: async () => { runningDisposed += 1; },
  };
  const otherEngine = {
    getState: () => otherState,
    subscribe: () => () => {},
    listSessions: () => rows,
    resume: async (id) => {
      otherState = {
        sessionId: id,
        items: [{ kind: "user", id: "other", text: "Other task" }],
        busy: true,
      };
      return true;
    },
    dispose: async () => { otherDisposed += 1; },
  };
  const engines = [runningEngine, otherEngine];
  let created = 0;
  const host = new EngineHost({
    userDataPath: root,
    createEngine: async () => engines[created++],
  });
  try {
    await host.startTask();
    const other = await host.resumeSession("desktop_other");
    assert.equal(other.sessionId, "desktop_other");
    assert.equal(created, 2, "a running session must keep its own engine");
    assert.equal(runningSwitches, 0, "switching away must not close the running session");
    assert.equal(runningResumes, 0);
    assert.equal(runningDisposed, 0);

    runningState = {
      sessionId: "desktop_running",
      items: [
        { kind: "user", id: "prompt", text: "Keep working" },
        { kind: "assistant", id: "done", text: "Background result", status: "done" },
      ],
      busy: false,
    };
    const restored = await host.resumeSession("desktop_running");
    assert.equal(restored.sessionId, "desktop_running");
    assert.equal(restored.items.at(-1).text, "Background result");
    assert.equal(runningResumes, 0, "returning must reconnect the live engine instead of reloading storage");
    assert.equal(otherDisposed, 0, "a second running session should also be parked");
  } finally {
    await host.dispose();
    assert.equal(runningDisposed, 1);
    assert.equal(otherDisposed, 1, "final host disposal must clean parked engines");
    process.chdir(originalCwd);
    await rm(root, { recursive: true, force: true });
  }
});

test("host keeps a running session alive across every task and project navigation", async () => {
  const root = await mkdtemp(join(tmpdir(), "mixdog-session-navigation-preserve-"));
  const originalCwd = process.cwd();
  const taskWorkspace = join(root, "workspace", "unclassified");
  const project = join(root, "project");
  await mkdir(project, { recursive: true });
  const rows = [{
    id: "desktop_running",
    preview: "Keep working",
    updatedAt: 1,
    cwd: taskWorkspace,
    desktopSession: { classification: "task", projectPath: null },
  }];
  let runningState = {
    sessionId: "desktop_running",
    items: [
      { kind: "user", id: "prompt", text: "Keep working" },
      { kind: "assistant", id: "progress-1", text: "Started", status: "streaming" },
    ],
    busy: true,
  };
  let runningResumes = 0;
  let runningSwitches = 0;
  let runningDisposed = 0;
  const runningEngine = {
    getState: () => runningState,
    subscribe: () => () => {},
    listSessions: () => rows,
    switchContext: async () => {
      runningSwitches += 1;
      return true;
    },
    resume: async () => {
      runningResumes += 1;
      return true;
    },
    dispose: async () => { runningDisposed += 1; },
  };
  const navigationDisposals = [];
  const navigationEngine = (index) => ({
    getState: () => ({ sessionId: null, items: [], queued: [], busy: false }),
    subscribe: () => () => {},
    listSessions: () => rows,
    dispose: async () => { navigationDisposals[index] += 1; },
  });
  const engines = [
    runningEngine,
    navigationEngine(0),
    navigationEngine(1),
    navigationEngine(2),
  ];
  navigationDisposals.push(0, 0, 0);
  let created = 0;
  const projectStore = createProjectStore([{ path: project }]);
  const host = new EngineHost({
    userDataPath: root,
    createEngine: async () => engines[created++],
    loadProjects: async () => projectStore.module,
  });
  try {
    await host.startTask();

    const freshTask = await host.startTask();
    assert.equal(freshTask.sessionId, null);
    assert.equal(created, 2);
    assert.equal(runningSwitches, 0, "opening a fresh task must not switch the running engine");
    assert.equal(runningDisposed, 0);
    runningState = {
      ...runningState,
      items: [...runningState.items, {
        kind: "assistant", id: "progress-2", text: "Still working after task navigation", status: "streaming",
      }],
    };
    let restored = await host.resumeSession("desktop_running");
    assert.equal(restored.items.at(-1).text, "Still working after task navigation");
    assert.equal(runningResumes, 0);
    assert.deepEqual(navigationDisposals, [1, 0, 0]);

    const projectTask = await host.startProjectTask(project);
    assert.equal(projectTask.sessionId, null);
    assert.equal(created, 3);
    assert.equal(runningSwitches, 0, "opening a project task must not switch the running engine");
    assert.equal(runningDisposed, 0);
    runningState = {
      ...runningState,
      items: [...runningState.items, {
        kind: "assistant", id: "progress-3", text: "Still working after project task", status: "streaming",
      }],
    };
    restored = await host.resumeSession("desktop_running");
    assert.equal(restored.items.at(-1).text, "Still working after project task");
    assert.equal(runningResumes, 0);
    assert.deepEqual(navigationDisposals, [1, 1, 0]);

    const projectContext = await host.startProject(project);
    assert.equal(projectContext.sessionId, null);
    assert.equal(created, 4);
    assert.equal(runningSwitches, 0, "opening a project context must not switch the running engine");
    assert.equal(runningDisposed, 0);
    runningState = {
      sessionId: "desktop_running",
      items: [
        { kind: "user", id: "prompt", text: "Keep working" },
        { kind: "assistant", id: "done", text: "Finished across every navigation", status: "done" },
      ],
      busy: false,
    };
    restored = await host.resumeSession("desktop_running");
    assert.equal(restored.items.at(-1).text, "Finished across every navigation");
    assert.equal(runningResumes, 0, "returning must reconnect the original engine every time");
    assert.equal(runningDisposed, 0);
    assert.deepEqual(navigationDisposals, [1, 1, 1]);
  } finally {
    await host.dispose();
    assert.equal(runningDisposed, 1, "app disposal must clean the preserved engine");
    process.chdir(originalCwd);
    await rm(root, { recursive: true, force: true });
  }
});

test("atomic new-task submit applies draft preferences before queued navigation", async () => {
  const root = await mkdtemp(join(tmpdir(), "mixdog-atomic-new-task-"));
  const originalCwd = process.cwd();
  const workspace = join(root, "workspace", "unclassified");
  const rows = [{
    id: "desktop_running",
    preview: "Running task",
    updatedAt: 1,
    cwd: workspace,
    desktopSession: { classification: "task", projectPath: null },
  }];
  const events = [];
  const runningEngine = {
    getState: () => ({
      sessionId: "desktop_running",
      items: [{ kind: "assistant", id: "running", text: "Still running" }],
      busy: true,
    }),
    subscribe: () => () => {},
    listSessions: () => rows,
    listProviderModels: async () => [{
      provider: "anthropic",
      id: "claude-draft",
      effortOptions: [{ value: "high", label: "High" }],
      fastCapable: true,
    }],
    dispose: async () => {},
  };
  let draftState = { sessionId: null, items: [], busy: false, commandBusy: false };
  let draftCatalogReads = 0;
  const draftEngine = {
    getState: () => draftState,
    subscribe: () => () => {},
    listSessions: () => rows,
    listProviderModels: async () => {
      draftCatalogReads += 1;
      return [];
    },
    setWorkflow: async (id) => { events.push(`workflow:${id}`); return { id }; },
    setRoute: async (route) => { events.push(`route:${route.model}`); return true; },
    setFast: async (enabled) => { events.push(`fast:${enabled}`); return enabled; },
    newSession: async () => {
      events.push("newSession");
      draftState = { ...draftState, sessionId: "desktop_atomic" };
      return true;
    },
    submit: (prompt) => {
      events.push(`submit:${prompt}`);
      return true;
    },
    claimRemote: async () => {
      events.push("claimRemote");
      return true;
    },
    dispose: async () => {},
  };
  let created = 0;
  const host = new EngineHost({
    userDataPath: root,
    createEngine: async () => created++ === 0 ? runningEngine : draftEngine,
  });
  try {
    await host.startTask();
    await host.listSessions();
    await host.listProviderModels();
    const submitOptions = { id: "atomic-deduplicated-submit", submittedAt: Date.now() };
    const draft = {
      workflowId: "solo",
      route: { provider: "anthropic", model: "claude-draft", effort: "high", fast: true },
      remote: true,
    };
    const submitted = host.submitNewTask("Atomic prompt", submitOptions, draft);
    const duplicate = host.submitNewTask("Atomic prompt", submitOptions, draft);
    const resumed = host.resumeSession("desktop_running");
    const [result, duplicateResult, resumedSnapshot] = await Promise.all([
      submitted,
      duplicate,
      resumed,
    ]);
    assert.equal(result.accepted, true);
    assert.equal(result.sessionId, "desktop_atomic");
    assert.deepEqual(duplicateResult, result);
    assert.equal(draftCatalogReads, 0, "cached catalog validation must not extend the atomic lock");
    assert.deepEqual(events, [
      "workflow:solo",
      "route:claude-draft",
      "newSession",
      "fast:true",
      "submit:Atomic prompt",
      "claimRemote",
    ]);
    assert.equal(resumedSnapshot.sessionId, "desktop_running");
  } finally {
    await host.dispose();
    process.chdir(originalCwd);
    await rm(root, { recursive: true, force: true });
  }
});

test("idle same-context new-task submit skips context switching and publishes before title I/O", async () => {
  const root = await mkdtemp(join(tmpdir(), "mixdog-same-context-new-task-"));
  const originalCwd = process.cwd();
  let state = {
    sessionId: "desktop_idle",
    items: [
      { kind: "user", id: "old-user", text: "Previous task" },
      { kind: "assistant", id: "old-assistant", text: "Done" },
    ],
    queued: [],
    busy: false,
    commandBusy: false,
  };
  let contextSwitches = 0;
  let newSessions = 0;
  const engine = {
    getState: () => state,
    subscribe: () => () => {},
    switchContext: async () => {
      contextSwitches += 1;
      state = { ...state, sessionId: null, items: [] };
      return true;
    },
    newSession: async () => {
      newSessions += 1;
      state = { ...state, sessionId: "desktop_same_context", items: [] };
      return true;
    },
    submit: (prompt) => {
      state = {
        ...state,
        items: [{ kind: "user", id: "new-user", text: prompt }],
        busy: true,
      };
      return true;
    },
    listSessions: () => [],
    dispose: async () => {},
  };
  const host = new EngineHost({ userDataPath: root, createEngine: async () => engine });
  let releaseTitle = () => {};
  try {
    await host.startTask();
    let titleLoadStarted = false;
    const titleGate = new Promise((resolve) => { releaseTitle = resolve; });
    const internal = host;
    internal.sessionMetadata.titleMap = null;
    internal.sessionMetadata.nameMap = null;
    internal.sessionMetadata.archivedMap = null;
    internal.sessionMetadata.load = async () => {
      titleLoadStarted = true;
      await titleGate;
    };
    let resolvePublished;
    const published = new Promise((resolve) => { resolvePublished = resolve; });
    const unsubscribe = host.subscribe((snapshot) => {
      if (snapshot?.sessionId === "desktop_same_context") resolvePublished(snapshot);
    });
    const submission = host.submitNewTask(
      "Fast local handoff",
      { id: "same-context-submit", submittedAt: Date.now() },
    );
    const timeout = new Promise((resolve) => setTimeout(() => resolve(null), 500));
    const [result, liveSnapshot] = await Promise.all([
      Promise.race([submission, timeout]),
      Promise.race([published, timeout]),
    ]);
    await new Promise((resolve) => setImmediate(resolve));
    assert.ok(result, "submit acknowledgement must not wait for title metadata");
    assert.ok(liveSnapshot, "the materialized session must publish before title metadata");
    assert.equal(result.sessionId, "desktop_same_context");
    assert.equal(liveSnapshot.sessionId, "desktop_same_context");
    assert.equal(contextSwitches, 0);
    assert.equal(newSessions, 1);
    assert.equal(titleLoadStarted, true);
    unsubscribe();
    releaseTitle();
    await submission;
  } finally {
    releaseTitle();
    await host.dispose();
    process.chdir(originalCwd);
    await rm(root, { recursive: true, force: true });
  }
});

test("failed atomic new-task setup restores the parked running engine", async () => {
  const root = await mkdtemp(join(tmpdir(), "mixdog-atomic-new-task-rollback-"));
  const originalCwd = process.cwd();
  const workspace = join(root, "workspace", "unclassified");
  let draftDisposed = 0;
  const runningEngine = {
    getState: () => ({
      sessionId: "desktop_running",
      items: [{ kind: "assistant", id: "running", text: "Still running" }],
      busy: true,
    }),
    subscribe: () => () => {},
    listSessions: () => [{
      id: "desktop_running",
      preview: "Running",
      updatedAt: 1,
      cwd: workspace,
      desktopSession: { classification: "task", projectPath: null },
    }],
    dispose: async () => {},
  };
  const draftEngine = {
    getState: () => ({ sessionId: null, items: [], busy: false }),
    subscribe: () => () => {},
    setWorkflow: async () => { throw new Error("workflow setup failed"); },
    dispose: async () => { draftDisposed += 1; },
  };
  let created = 0;
  const host = new EngineHost({
    userDataPath: root,
    createEngine: async () => created++ === 0 ? runningEngine : draftEngine,
  });
  try {
    await host.startTask();
    await assert.rejects(
      () => host.submitNewTask("Fail safely", { id: "rollback-submit" }, { workflowId: "broken" }),
      /workflow setup failed/,
    );
    assert.equal(host.getSnapshot().sessionId, "desktop_running");
    assert.match(host.getSnapshot().items.at(-1).text, /Still running/);
    assert.equal(draftDisposed, 1);
  } finally {
    await host.dispose();
    process.chdir(originalCwd);
    await rm(root, { recursive: true, force: true });
  }
});

test("rejected atomic new-task submit restores the parked engine and stays idempotent", async () => {
  const root = await mkdtemp(join(tmpdir(), "mixdog-atomic-new-task-rejected-"));
  const originalCwd = process.cwd();
  const workspace = join(root, "workspace", "unclassified");
  const runningEngine = {
    getState: () => ({
      sessionId: "desktop_running",
      items: [{ kind: "assistant", id: "running", text: "Still running" }],
      busy: true,
    }),
    subscribe: () => () => {},
    listSessions: () => [{
      id: "desktop_running",
      preview: "Running",
      updatedAt: 1,
      cwd: workspace,
      desktopSession: { classification: "task", projectPath: null },
    }],
    dispose: async () => {},
  };
  let draftState = { sessionId: null, items: [], busy: false };
  let draftDisposed = 0;
  let submits = 0;
  const draftEngine = {
    getState: () => draftState,
    subscribe: () => () => {},
    newSession: async () => {
      draftState = { ...draftState, sessionId: "desktop_rejected" };
      return true;
    },
    submit: () => {
      submits += 1;
      return false;
    },
    dispose: async () => { draftDisposed += 1; },
  };
  let created = 0;
  const host = new EngineHost({
    userDataPath: root,
    createEngine: async () => created++ === 0 ? runningEngine : draftEngine,
  });
  try {
    await host.startTask();
    const options = { id: "rejected-submit" };
    const first = host.submitNewTask("Reject safely", options);
    const duplicate = host.submitNewTask("Reject safely", options);
    const [result, duplicateResult] = await Promise.all([first, duplicate]);
    assert.equal(result.accepted, false);
    assert.equal(result.sessionId, "");
    assert.equal(result.snapshot.sessionId, "desktop_running");
    assert.deepEqual(duplicateResult, result);
    assert.equal(submits, 1);
    assert.equal(draftDisposed, 1);
    assert.equal(host.getSnapshot().sessionId, "desktop_running");
  } finally {
    await host.dispose();
    process.chdir(originalCwd);
    await rm(root, { recursive: true, force: true });
  }
});

test("host restores a running session when navigation engine creation fails", async () => {
  const root = await mkdtemp(join(tmpdir(), "mixdog-session-navigation-rollback-"));
  const originalCwd = process.cwd();
  let runningDisposed = 0;
  const runningEngine = {
    getState: () => ({
      sessionId: "desktop_running",
      items: [{ kind: "assistant", id: "progress", text: "Still working", status: "streaming" }],
      busy: true,
    }),
    subscribe: () => () => {},
    listSessions: () => [],
    switchContext: async () => true,
    dispose: async () => { runningDisposed += 1; },
  };
  let created = 0;
  const host = new EngineHost({
    userDataPath: root,
    createEngine: async () => {
      created += 1;
      if (created === 1) return runningEngine;
      throw new Error("navigation engine failed");
    },
  });
  try {
    await host.startTask();
    await assert.rejects(() => host.startTask(), /navigation engine failed/);
    assert.equal(host.getSnapshot().sessionId, "desktop_running");
    assert.equal(host.getSnapshot().items.at(-1).text, "Still working");
    assert.equal(runningDisposed, 0);
  } finally {
    await host.dispose();
    assert.equal(runningDisposed, 1);
    process.chdir(originalCwd);
    await rm(root, { recursive: true, force: true });
  }
});

test("host protects an accepted submit before busy publishes and reconnects its engine", async () => {
  const root = await mkdtemp(join(tmpdir(), "mixdog-session-submit-lease-"));
  const originalCwd = process.cwd();
  const workspace = join(root, "workspace", "unclassified");
  const rows = ["desktop_running", "desktop_other"].map((id, index) => ({
    id,
    preview: `Task ${index + 1}`,
    updatedAt: 2 - index,
    cwd: workspace,
    desktopSession: { classification: "task", projectPath: null },
  }));
  let runningState = {
    sessionId: "desktop_running",
    structureRevision: 7,
    items: [{ kind: "assistant", id: "plan", text: "Ready" }],
    queued: [],
    busy: false,
    commandBusy: false,
  };
  let otherState = { sessionId: null, items: [], queued: [], busy: false, commandBusy: false };
  let submitted = 0;
  let runningResumes = 0;
  let runningSwitches = 0;
  let runningDisposed = 0;
  let otherDisposed = 0;
  const runningEngine = {
    getState: () => runningState,
    subscribe: () => () => {},
    listSessions: () => rows,
    submit: () => {
      submitted += 1;
      // Reproduce the real auto-clear preflight gap: submit is accepted, but
      // the published engine state is still completely idle.
      return true;
    },
    switchContext: async () => {
      runningSwitches += 1;
      return true;
    },
    resume: async () => {
      runningResumes += 1;
      return true;
    },
    dispose: async () => { runningDisposed += 1; },
  };
  const otherEngine = {
    getState: () => otherState,
    subscribe: () => () => {},
    listSessions: () => rows,
    resume: async (id) => {
      otherState = {
        sessionId: id,
        items: [{ kind: "user", id: "other", text: "Other task" }],
        queued: [],
        busy: true,
        commandBusy: false,
      };
      return true;
    },
    dispose: async () => { otherDisposed += 1; },
  };
  const engines = [runningEngine, otherEngine];
  let created = 0;
  const host = new EngineHost({
    userDataPath: root,
    createEngine: async () => engines[created++],
  });
  try {
    await host.startTask();
    assert.equal(await host.submit("rr"), true);
    assert.equal(submitted, 1);

    const other = await host.resumeSession("desktop_other");
    assert.equal(other.sessionId, "desktop_other");
    assert.equal(created, 2, "an accepted idle-looking submit must keep its own engine");
    assert.equal(runningSwitches, 0, "the submit gap must not close through a context switch");
    assert.equal(runningResumes, 0);
    assert.equal(runningDisposed, 0);

    runningState = {
      sessionId: "desktop_running",
      structureRevision: 9,
      items: [
        { kind: "assistant", id: "plan", text: "Ready" },
        { kind: "user", id: "retry", text: "rr" },
        { kind: "assistant", id: "done", text: "Recovered background result", status: "done" },
      ],
      queued: [],
      busy: false,
      commandBusy: false,
    };
    const restored = await host.resumeSession("desktop_running");
    assert.equal(restored.sessionId, "desktop_running");
    assert.equal(restored.items.at(-1).text, "Recovered background result");
    assert.equal(runningResumes, 0, "returning must reconnect the protected engine");
  } finally {
    await host.dispose();
    assert.equal(runningDisposed, 1);
    assert.equal(otherDisposed, 1);
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
  // One view per session: the daemon owns the engines, so a view that already
  // carries a session is never recycled onto the next one.
  const engines = [];
  const makeEngine = () => {
    let own = state;
    const engine = {
      switched: 0,
      disposed: 0,
      getState: () => own,
      subscribe: () => () => {},
      listSessions: () => rows,
      switchContext: async () => {
        engine.switched += 1;
        return true;
      },
      resume: async (id) => {
        resumed.push(id);
        own = { sessionId: id, items: [], queued: [] };
        state = own;
        return true;
      },
      dispose: async () => { engine.disposed += 1; },
    };
    engines.push(engine);
    return engine;
  };
  const host = new EngineHost({ userDataPath: root, createEngine: async () => makeEngine() });
  const publications = [];
  const unsubscribe = host.subscribe((snapshot) => publications.push(snapshot));
  try {
    await host.resumeSession("legacy_first");
    publications.length = 0;
    const snapshot = await host.resumeSession("legacy_second");

    assert.deepEqual(resumed, ["legacy_first", "legacy_second"]);
    assert.equal(engines[0].switched, 1,
      "only the initial task-to-legacy context transition should reset context");
    assert.equal(engines.length, 2, "the second legacy session gets its OWN view");
    // No pane shows the first session here, so its idle view is reclaimed by
    // the settled-release path; a VISIBLE session keeps its view (covered by
    // the pane-ownership test).
    assert.equal(publications.length, 1);
    assert.equal(publications[0], snapshot,
      "the held state publication should reuse the detached snapshot returned by resume");
    assert.equal(snapshot.sessionId, "legacy_second");
  } finally {
    unsubscribe();
    await host.dispose();
    assert.ok(engines.every((engine) => engine.disposed === 1),
      "every view is released when the host shuts down");
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
  // A dedicated view per open: the mismatch must roll back onto the parked
  // view that still carries the previous session.
  const makeEngine = () => ({
    getState: () => state,
    subscribe: () => () => {},
    listSessions: () => rows,
    resume: async () => true,
    dispose: async () => {},
  });
  const host = new EngineHost({ userDataPath: root, createEngine: async () => makeEngine() });
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
});

test("a route change addresses the pane's session, never the focused one", async () => {
  const root = await mkdtemp(join(tmpdir(), "mixdog-route-session-"));
  const originalCwd = process.cwd();
  const workspace = join(root, "workspace", "unclassified");
  await mkdir(workspace, { recursive: true });
  const rows = ["route_a", "route_b"].map((id, index) => ({
    id,
    preview: `Route ${index + 1}`,
    updatedAt: 2 - index,
    cwd: workspace,
    desktopSession: { classification: "task", projectPath: null },
  }));
  const engines = [];
  const makeEngine = () => {
    let state = { sessionId: "", items: [] };
    const engine = {
      routes: [],
      getState: () => state,
      subscribe: () => () => {},
      listSessions: () => rows,
      // The catalog speaks the runtime's shape: the model id lives in `id`.
      listProviderModels: async () => [{ provider: "p", id: "m", display: "M" }],
      setRoute: async (selection) => {
        engine.routes.push(selection);
        state = { ...state, provider: selection.provider, model: selection.model };
        return true;
      },
      resume: async (id) => {
        state = { sessionId: id, items: [] };
        return true;
      },
      dispose: async () => {},
    };
    engines.push(engine);
    return engine;
  };
  const host = new EngineHost({
    userDataPath: root,
    createEngine: async () => makeEngine(),
    loadSessionStore: async () => ({ listStoredSessionSummaries: () => rows }),
  });
  try {
    await host.resumeSession("route_a");
    await host.resumeSession("route_b");
    // Both sessions are on screen, so both keep their own view.
    await host.setVisibleSessions(["route_a", "route_b"]);
    const selection = { provider: "p", model: "m" };
    const routed = await host.setModelRoute(selection, "route_a");
    assert.equal(routed.sessionId, "route_a", "the answer describes the ADDRESSED session");
    assert.equal(host.getSnapshot().sessionId, "route_b",
      "a background pane's model change never moves the window's surface");
    const engineA = engines.find((engine) => engine.getState().sessionId === "route_a");
    const engineB = engines.find((engine) => engine.getState().sessionId === "route_b");
    assert.deepEqual(engineA.routes, [selection]);
    assert.deepEqual(engineB.routes, [], "the focused session keeps its own route");
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
  const trackedSubmitOptions = {
    id: "desktop-submit-ipc-test",
    submittedAt: 1_700_000_000_000,
    displayText: "Tracked prompt",
  };
  assert.equal(
    await invoke(DESKTOP_IPC.submit, validEvent, "Tracked prompt", trackedSubmitOptions),
    true,
  );
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
  assert.deepEqual(calls.slice(0, 11), [
    ["startTask"],
    ["listSessions"],
    ["submit", "Tracked prompt", trackedSubmitOptions],
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
  assert.throws(
    () => invoke(DESKTOP_IPC.submit, validEvent, "Prompt", { id: "", submittedAt: Date.now() }),
    /submit id is invalid/,
  );
  assert.throws(
    () => invoke(DESKTOP_IPC.submit, validEvent, "Prompt", { id: "desktop-submit-test", submittedAt: 0 }),
    /submit timestamp is invalid/,
  );
  assert.throws(
    () => invoke(DESKTOP_IPC.submit, validEvent, "Prompt", { unsupported: true }),
    /unsupported field/,
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

  remove();
  assert.equal(unsubscribed, true);
  assert.equal(updaterUnsubscribed, true);
  assert.equal(handlers.size, 0);
  assert.deepEqual(new Set(removed), new Set(
    Object.values(DESKTOP_IPC).filter((channel) =>
      channel !== DESKTOP_IPC.state && channel !== DESKTOP_IPC.updaterState
      && channel !== DESKTOP_IPC.perfLog && channel !== DESKTOP_IPC.rendererDiagnostic
      && channel !== DESKTOP_IPC.termData
      && channel !== DESKTOP_IPC.termWrite && channel !== DESKTOP_IPC.termResize
      && channel !== DESKTOP_IPC.termAcknowledge
      && channel !== DESKTOP_IPC.sessionsChanged && channel !== DESKTOP_IPC.stateResync
      && channel !== DESKTOP_IPC.agentPoolChanged
      && channel !== DESKTOP_IPC.sessionState
      && channel !== DESKTOP_IPC.sessionStateResync
      && channel !== DESKTOP_IPC.lspDiagnostics && channel !== DESKTOP_IPC.lspStatus
      && channel !== DESKTOP_IPC.workflowEvent),
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
    assert.deepEqual(states[1].__statePatch, {
      base: 1,
      revision: 2,
      changed: {},
      removed: [],
    });
    // In-place tail replacement (streaming): only the changed suffix is sent.
    assert.deepEqual(states[2].__itemsPatch, { base: 2, revision: 3, prefix: 1, append: [itemB2] });
    assert.equal(states[2].busy, undefined);
    assert.deepEqual(states[2].__statePatch, {
      base: 2,
      revision: 3,
      changed: { busy: false },
      removed: [],
    });
    // A null/itemless snapshot resets the stream: the next send is full again.
    assert.equal(states[3], null);
    assert.equal(states[4].__itemsRevision, 4);
    assert.deepEqual(states[4].items, [itemA]);
  } finally {
    remove();
  }
});

test("desktop snapshots reuse settled arrays and carry append epochs only in main", () => {
  const itemA = { id: 1, kind: "user", text: "hello" };
  const items = [itemA];
  const firstTail = { id: 2, kind: "assistant", text: "one\n", streaming: true };
  Object.defineProperty(firstTail, Symbol.for("mixdog.streaming-tail-text-epoch"), {
    value: 7,
    enumerable: false,
  });
  let state = { items, streamingTail: firstTail, busy: true };
  const engine = { getState: () => state };
  const first = copySnapshot(engine);
  state = {
    ...state,
    streamingTail: { id: 2, kind: "assistant", text: "one\ntwo\n", streaming: true },
  };
  Object.defineProperty(state.streamingTail, Symbol.for("mixdog.streaming-tail-text-epoch"), {
    value: 7,
    enumerable: false,
  });
  const second = copySnapshot(engine);
  assert.strictEqual(second.items, first.items);
  assert.strictEqual(second.items[0], first.items[0]);
  assert.equal(streamingTailAppendEpoch(first), 7);
  assert.equal(streamingTailAppendEpoch(second), 7);
  assert.equal(streamingTailAppendEpoch(structuredClone(second)), null);

  state = { ...state, items: [...items, { id: 2, kind: "assistant", text: "done" }] };
  const settled = copySnapshot(engine);
  assert.notStrictEqual(settled.items, second.items);
  assert.strictEqual(settled.items[0], second.items[0]);
});

test("desktop IPC streams marked tail suffixes without rebuilding stable settled items", () => {
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
  const items = [{ id: 1, kind: "user", text: "hello" }];
  let state;
  const engine = { getState: () => state };
  const tail = (text, epoch) => {
    const value = { id: 2, kind: "assistant", text, streaming: true };
    Object.defineProperty(value, Symbol.for("mixdog.streaming-tail-text-epoch"), {
      value: epoch,
      enumerable: false,
    });
    return value;
  };
  try {
    state = { items, streamingTail: tail("one\n", 3), busy: true };
    publish(copySnapshot(engine));
    state = { ...state, streamingTail: tail("one\ntwo\n", 3) };
    publish(copySnapshot(engine));
    state = { ...state, streamingTail: tail("replacement\n", 4) };
    publish(copySnapshot(engine));
    const states = sent.filter(([channel]) => channel === DESKTOP_IPC.state).map(([, payload]) => payload);
    assert.equal(states.length, 3);
    assert.deepEqual(states[1].__itemsPatch, { base: 1, revision: 2, prefix: 1, append: [] });
    assert.deepEqual(states[1].__streamingTailPatch, {
      prefix: 4,
      append: "two\n",
      tail: { id: 2, kind: "assistant", streaming: true },
    });
    assert.equal(states[2].__streamingTailPatch, undefined);
    assert.deepEqual(states[2].streamingTail, {
      id: 2,
      kind: "assistant",
      text: "replacement\n",
      streaming: true,
    });
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
  // modelSettings is the only writer now; the pre-modelSettings `fastModels`
  // mirror is read-only compatibility for old configs.
  assert.equal(supportedConfig.modelSettings["openai/gpt-5.4"].fast, true);
  assert.equal("openai/gpt-5.4" in supportedConfig.fastModels, false);

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
  let newSessionCalls = 0;
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
      newSessionCalls += 1;
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
    assert.equal(newSessionCalls, 0, "route preferences must not pre-create a session");

    const active = await host.startTask();
    assert.equal(active.sessionId, null);
    assert.equal(active.fast, true);
    assert.equal(newSessionCalls, 0, "opening New task must remain an unpersisted draft");
    assert.equal(await host.submit("Start the pristine task"), true);
    assert.equal(newSessionCalls, 1, "the first submit should create exactly one session");
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

test("concurrent desktop model catalog reads join one host request per mode", async () => {
  const root = await mkdtemp(join(tmpdir(), "mixdog-model-singleflight-"));
  const originalCwd = process.cwd();
  let releaseCatalog;
  let catalogStarted;
  const catalogGate = new Promise((resolve) => { releaseCatalog = resolve; });
  const catalogStartedPromise = new Promise((resolve) => { catalogStarted = resolve; });
  let calls = 0;
  const rows = [{ provider: "openai", id: "gpt-singleflight", display: "GPT Singleflight" }];
  const engine = {
    getState: () => ({ busy: false, commandBusy: false }),
    subscribe: () => () => {},
    submit: () => true,
    abort: () => false,
    resolveToolApproval: () => true,
    listProviderModels: async () => {
      calls += 1;
      if (calls === 1) {
        catalogStarted();
        await catalogGate;
      }
      return rows;
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
    const first = host.listProviderModels({ quick: false });
    await catalogStartedPromise;
    const second = host.listProviderModels({ quick: false });
    releaseCatalog();
    const [left, right] = await Promise.all([first, second]);
    assert.deepEqual(left, right);
    assert.equal(calls, 2,
      "joined callers should share the host's two-step authoritative catalog recovery");
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
    }, {
      name: "Core older",
      path: resolve(older),
      alias: null,
    }]);
    await assert.rejects(
      host.startProjectTask(desktopOnly),
      /Project is not available/,
      "legacy desktop recents must not authorize a project-scoped task",
    );

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
    assert.equal("pinned" in savedMetadata, false,
      "retired pin flag must no longer be persisted");
  } finally {
    await host.dispose();
    await rm(root, { recursive: true, force: true });
  }
});

test("addProject registers a folder in place without touching the active engine", async () => {
  const root = await mkdtemp(join(tmpdir(), "mixdog-add-project-"));
  const fresh = join(root, "fresh");
  await mkdir(fresh);
  const projectStore = createProjectStore([]);
  const host = new EngineHost({
    userDataPath: root,
    createEngine: async () => { throw new Error("addProject must not create an engine"); },
    loadProjects: async () => projectStore.module,
  });
  try {
    await host.addProject(fresh);
    assert.deepEqual(projectStore.calls.at(-1), ["addProject", resolve(fresh)]);
    assert.deepEqual((await host.listProjects()).map((project) => project.path), [resolve(fresh)]);
    await assert.rejects(host.addProject(join(root, "missing")));
  } finally {
    await host.dispose();
    await rm(root, { recursive: true, force: true });
  }
});

test("host start/list/resume persists desktop scope, restores transcript, and publishes once", async () => {
  const root = await mkdtemp(join(tmpdir(), "mixdog-host-"));
  const project = join(root, "project");
  await mkdir(project);
  await writeFile(join(root, "desktop-session-metadata.json"), JSON.stringify({
    version: 2,
    titles: {
      cli_media_title: "Mixdog_FdehV3ik5a.png 1044×990…",
    },
    names: {},
  }));
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
    // First-open projection fixture: a session this window has never shown
    // loads from storage, which is where envelope/reminder stripping and tool
    // sanitization are exercised.
    transcript: persistedTranscript,
  }, {
    id: "cli_media_title",
    preview: "",
    cwd: project,
    desktopSession: null,
    transcript: [{
      kind: "user",
      id: "compacted-media-title",
      text: `A previous model worked on this task and produced the compacted handoff summary below.
<prior-compacted-context>
[2026-07-28 11:08] u: 전체배포좀해줘 #55871
[2026-07-28 10:41] u: Mixdog_FdehV3ik5a.png
1044×990
세션나갔다들어오니 작업끊기는이슈
[2026-07-28 10:42] a: 확인하겠습니다. #55818
</prior-compacted-context>`,
    }],
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
      submit: (prompt) => {
        state = {
          ...state,
          structureRevision: (Number(state.structureRevision) || 0) + 1,
          items: [...state.items, {
            kind: "user",
            id: `submitted-${state.items.length}`,
            text: String(prompt),
          }],
        };
        return true;
      },
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
    // Two engine subscriptions per pooled engine: the focused host publication
    // and the per-session live lane (split panes).
    assert.equal(engines[0].listeners.size, 2);
    const beforeEmit = publications;
    engines[0].emit();
    engines[0].emit();
    assert.equal(publications, beforeEmit, "engine event publication should be deferred");
    await new Promise((resolve) => setTimeout(resolve, 75));
    assert.equal(publications, beforeEmit + 1);

    const listed = await host.listSessions();
    assert.deepEqual(listed.map((row) => row.id), ["cli_lead", "cli_media_title", desktopId]);
    assert.equal(listed.find((row) => row.id === "cli_media_title")?.title, "[Image]");
    const migratedMetadata = JSON.parse(await readFile(join(root, "desktop-session-metadata.json"), "utf8"));
    assert.equal(migratedMetadata.titles.cli_media_title, "[Image]");

    const mediaLegacyResponse = await host.resumeSession("cli_media_title");
    assert.equal(mediaLegacyResponse.currentProject, project);
    assert.equal(mediaLegacyResponse.sessionId, "cli_media_title");
    assert.equal(engines.at(-1).options.desktopSession, undefined);
    const upgraded = await host.listSessions();
    assert.equal(
      upgraded.find((row) => row.id === "cli_media_title")?.title,
      "세션나갔다들어오니 작업끊기는이슈",
    );

    const legacyResponse = await host.resumeSession("cli_lead");
    assert.equal(legacyResponse.currentProject, project);
    assert.equal(legacyResponse.sessionId, "cli_lead");
    assert.equal(engines.at(-1).options.desktopSession, undefined);

    const enginesBeforeReturn = engines.length;
    const resumeResponse = await host.resumeSession(desktopId);
    // Returning to a session re-activates ITS OWN parked view — no view is
    // recycled onto another session, and none is created twice.
    assert.equal(engines.length, enginesBeforeReturn,
      "returning to a session reuses that session's view instead of opening another");
    assert.deepEqual(engines[0].options.desktopSession, { classification: "task", projectPath: null });
    assert.equal(resumeResponse.currentProject, null);
    assert.deepEqual(resumeResponse.recentProjects, []);
    assert.equal(resumeResponse.sessionId, desktopId);
    // Returning to a live view keeps its OWN in-memory turn: no disk reload,
    // no repaint from a stale projection.
    assert.equal(resumeResponse.items.at(-1)?.text, "Fresh desktop task");
    // The stored-transcript projection (envelope stripping, hidden runtime
    // injections, tool sanitization) is exercised by the first resume of a
    // session this window had not opened yet.
    assert.deepEqual(legacyResponse.items, [
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
    // Point the window back at the stored-transcript session: its own view is
    // still parked, so this is a pointer move rather than a reload.
    await host.resumeSession("cli_lead");
    // The view the window publishes from carries BOTH subscriptions (focused
    // channel + its own lane); every other view keeps only its lane.
    const activeDesktopEngine = engines.find((engine) => engine.listeners.size === 2);
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
    // A view the window is not publishing from keeps ITS OWN lane: that is
    // what lets another pane keep painting that session.
    assert.equal(engines[0].listeners.size, 1);
    assert.equal(activeDesktopEngine.listeners.size, 2);

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
    assert.equal(activeProjectEngine.listeners.size, 2);
    const projectBeforeEmit = publications;
    activeProjectEngine.emit();
    activeProjectEngine.emit();
    assert.equal(publications, projectBeforeEmit, "project engine events should be coalesced");
    await new Promise((resolve) => setTimeout(resolve, 75));
    assert.equal(publications, projectBeforeEmit + 1);

    await host.renameProject(canonicalProject, "Desktop alias");
    assert.deepEqual(await host.listProjects(), [{
      name: "Desktop alias",
      path: canonicalProject,
      alias: "Desktop alias",
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

test("host marks a cross-context switch as resume-only before restoring a session", async () => {
  const root = await mkdtemp(join(tmpdir(), "mixdog-host-resume-context-"));
  const project = join(root, "project");
  await mkdir(project);
  const canonicalProject = await realpath(project);
  const originalCwd = process.cwd();
  const switches = [];
  let state = { sessionId: null, items: [] };
  const row = {
    id: "project_session",
    preview: "Project session",
    cwd: canonicalProject,
    desktopSession: { classification: "project", projectPath: canonicalProject },
  };
  const engine = {
    getState: () => state,
    subscribe: () => () => {},
    listSessions: () => [row],
    switchContext: async (options) => {
      switches.push(structuredClone(options));
      state = { sessionId: null, items: [] };
      return true;
    },
    resume: async (id) => {
      state = { sessionId: id, items: [{ kind: "user", id: "one", text: "History" }] };
      return true;
    },
    dispose: async () => {},
  };
  const host = new EngineHost({ userDataPath: root, createEngine: async () => engine });
  try {
    await host.startTask();
    const snapshot = await host.resumeSession(row.id);
    assert.equal(snapshot.sessionId, row.id);
    assert.deepEqual(switches, [{
      cwd: canonicalProject,
      desktopSession: { classification: "project", projectPath: canonicalProject },
      forResume: true,
    }]);
  } finally {
    await host.dispose();
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
  let releaseMediaLanes;
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
    listMediaLanes: () => new Promise((resolve) => { releaseMediaLanes = resolve; }),
    resolveMediaFile: (id) => ({
      id,
      path: `C:\\media\\${id}.jpg`,
      mime: "image/jpeg",
      available: true,
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

    const lanesPending = host.invokeCapability("listMediaLanes");
    await new Promise((resolve) => setImmediate(resolve));
    const mediaPending = host.invokeCapability("resolveMediaFile", ["asset-1", { variant: "thumb" }]);
    const mediaEscapedLaneRead = await Promise.race([
      mediaPending.then(() => true),
      new Promise((resolve) => setTimeout(() => resolve(false), 50)),
    ]);
    releaseMediaLanes([]);
    await lanesPending;
    assert.equal(mediaEscapedLaneRead, true,
      "thumbnail resolution must not queue behind the provider lane catalog");
    assert.equal((await mediaPending).value.path, "C:\\media\\asset-1.jpg");

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

test("a live-engine context switch publishes no mid-switch snapshot carrying the outgoing transcript", async () => {
  const root = await mkdtemp(join(tmpdir(), "mixdog-switch-hold-"));
  const originalCwd = process.cwd();
  let engineListener = null;
  let state = {
    sessionId: "outgoing_session",
    items: [{ id: "m1", kind: "user", text: "outgoing transcript" }],
  };
  const engine = {
    getState: () => state,
    subscribe: (listener) => { engineListener = listener; return () => {}; },
    listSessions: () => [],
    newSession: async () => true,
    resume: async () => true,
    dispose: async () => {},
    switchContext: async () => {
      state = { ...state, commandBusy: true };
      engineListener?.();
      // Outlive the publication throttle so a scheduled mid-switch
      // publication would fire while the old transcript is still in state.
      await new Promise((resolve) => setTimeout(resolve, ENGINE_PUBLICATION_INTERVAL_MS + 60));
      state = { sessionId: null, items: [] };
      engineListener?.();
      return true;
    },
  };
  const host = new EngineHost({ userDataPath: root, createEngine: async () => engine });
  try {
    await host.startTask();
    const published = [];
    const unsubscribe = host.subscribe((snapshot) => published.push(snapshot));
    await host.startTask();
    await new Promise((resolve) => setTimeout(resolve, ENGINE_PUBLICATION_INTERVAL_MS + 60));
    unsubscribe();
    assert.ok(published.length >= 1, "the switch should publish its settled snapshot");
    for (const snapshot of published) {
      const items = Array.isArray(snapshot?.items) ? snapshot.items : [];
      assert.equal(items.some((item) => String(item?.text || "").includes("outgoing transcript")), false,
        "mid-switch publications must not resurrect the outgoing transcript");
    }
  } finally {
    await host.dispose();
    process.chdir(originalCwd);
    await rm(root, { recursive: true, force: true });
  }
});

test("a switch whose engine settles late still returns and publishes the post-switch state", async () => {
  // Attached-viewer engines (CLI-owned sessions opened as disk followers)
  // resolve switchContext BEFORE their state reflects the reset. The host
  // must wait for the settled state; an immediate clone resurrected the
  // outgoing transcript in the renderer's fresh draft (measured ~35ms stale).
  const root = await mkdtemp(join(tmpdir(), "mixdog-switch-settle-"));
  const originalCwd = process.cwd();
  let engineListener = null;
  let state = {
    sessionId: "attached_outgoing",
    items: [{ id: "m1", kind: "user", text: "attached outgoing transcript" }],
  };
  const engine = {
    getState: () => state,
    subscribe: (listener) => { engineListener = listener; return () => {}; },
    listSessions: () => [],
    newSession: async () => true,
    resume: async () => true,
    dispose: async () => {},
    switchContext: async () => {
      // State clears AFTER the resolved promise (follower pump behavior).
      setTimeout(() => {
        state = { sessionId: null, items: [] };
        engineListener?.();
      }, 30);
      return true;
    },
  };
  const host = new EngineHost({ userDataPath: root, createEngine: async () => engine });
  try {
    await host.startTask();
    const published = [];
    const unsubscribe = host.subscribe((snapshot) => published.push(snapshot));
    const result = await host.startTask();
    unsubscribe();
    assert.equal(String(result?.sessionId || ""), "", "the invoke result must reflect the post-switch state");
    assert.equal((Array.isArray(result?.items) ? result.items : []).length, 0,
      "the invoke result must not carry the outgoing transcript");
    for (const snapshot of published) {
      const items = Array.isArray(snapshot?.items) ? snapshot.items : [];
      assert.equal(items.some((item) => String(item?.text || "").includes("attached outgoing transcript")), false,
        "post-switch publications must not resurrect the outgoing transcript");
    }
  } finally {
    await host.dispose();
    process.chdir(originalCwd);
    await rm(root, { recursive: true, force: true });
  }
});

test("focus resume hands a visible pane over atomically instead of replaying older disk state", async () => {
  const root = await mkdtemp(join(tmpdir(), "mixdog-resume-handoff-"));
  const originalCwd = process.cwd();
  const workspace = join(root, "workspace", "unclassified");
  await mkdir(workspace, { recursive: true });
  const sessionId = "desktop_handoff";
  const row = {
    id: sessionId,
    preview: "Handoff pane",
    updatedAt: 1,
    cwd: workspace,
    desktopSession: { classification: "task", projectPath: null },
  };
  const persisted = () => [{ id: "p1", kind: "user", text: "persisted turn" }];
  let viewerOptions = null;
  let viewerDisposals = 0;
  let state = { sessionId: "", items: [] };
  const listeners = [];
  const engine = {
    getState: () => state,
    subscribe: (listener) => { listeners.push(listener); return () => {}; },
    listSessions: () => [row],
    newSession: async () => true,
    // Resume rehydrates from disk: strictly OLDER than what the pane paints.
    resume: async (id) => {
      state = { sessionId: id, items: persisted(), busy: false };
      return true;
    },
    setState: (next) => { state = next; },
    fire: () => { for (const listener of listeners) listener(); },
    dispose: async () => {},
  };
  const host = new EngineHost({
    userDataPath: root,
    createEngine: async () => engine,
    loadSessionStore: async () => ({
      listStoredSessionSummaries: () => [row],
      async readStoredSessionTranscript(id) {
        return {
          sessionId: id,
          items: persisted(),
          provider: "openai",
          model: "gpt-test",
          cwd: workspace,
          desktopSession: { classification: "task", projectPath: null },
        };
      },
      async createStoredSessionLiveViewer(_id, options) {
        viewerOptions = options;
        return { dispose() { viewerDisposals += 1; } };
      },
    }),
  });
  const updates = [];
  const unsubscribe = host.subscribeSessionStates((update) => updates.push(update));
  try {
    assert.equal(await host.setVisibleSessions([sessionId]), true);
    // The visible pane owns a live frame NEWER than anything persisted.
    viewerOptions.onSnapshot({
      ...viewerOptions.initialSnapshot,
      items: [...persisted(), { id: "live-2", kind: "assistant", text: "live newer turn" }],
    });
    const liveFrame = updates.at(-1);
    assert.equal(liveFrame.snapshot.items.at(-1).text, "live newer turn");
    const liveRevision = liveFrame.contentRevision;
    updates.length = 0;

    const resumed = await host.resumeSession(sessionId);
    assert.equal(resumed.sessionId, sessionId, "focus still takes command/input ownership");
    await new Promise((resolve) => setTimeout(resolve, ENGINE_PUBLICATION_INTERVAL_MS + 100));
    const paneFrames = updates.filter((update) => update.sessionId === sessionId);
    assert.ok(
      paneFrames.every((update) => update.snapshot.items.at(-1)?.text === "live newer turn"),
      "focus must never replace a visible live frame with older/empty replay content",
    );
    assert.ok(
      paneFrames.every((update) => update.frameSource === "replay"
        && update.contentRevision === liveRevision),
      "suppressed resume frames keep stale-replay metadata for the renderer gate",
    );
    assert.equal(viewerDisposals, 0,
      "the visible viewer stays authoritative until the engine reaches that content");

    updates.length = 0;
    // A GENUINE newer transcript generation from the resumed engine publishes.
    state = {
      sessionId,
      items: [
        ...persisted(),
        { id: "live-2", kind: "assistant", text: "live newer turn" },
        { id: "engine-3", kind: "assistant", text: "engine newer turn" },
      ],
      busy: false,
    };
    engine.fire();
    await new Promise((resolve) => setTimeout(resolve, ENGINE_PUBLICATION_INTERVAL_MS + 100));
    const published = updates.filter((update) => update.sessionId === sessionId
      && update.snapshot.items.at(-1)?.text === "engine newer turn");
    assert.equal(published.length, 1, "the handoff publishes the newer generation exactly once");
    assert.equal(published[0].frameSource, "live");
    assert.ok(published[0].contentRevision > liveRevision,
      "an accepted newer generation advances the pane's content revision");
    assert.equal(viewerDisposals, 1,
      "the read-only viewer is released once the engine owns the pane");
  } finally {
    unsubscribe();
    await host.dispose();
    process.chdir(originalCwd);
    await rm(root, { recursive: true, force: true });
  }
});

test("cold and non-visible resumes publish the resumed engine through the host lane", async () => {
  const root = await mkdtemp(join(tmpdir(), "mixdog-resume-cold-lane-"));
  const originalCwd = process.cwd();
  const workspace = join(root, "workspace", "unclassified");
  await mkdir(workspace, { recursive: true });
  const rows = ["desktop_cold_a", "desktop_cold_b"].map((id, index) => ({
    id,
    preview: `Cold ${index + 1}`,
    updatedAt: 2 - index,
    cwd: workspace,
    desktopSession: { classification: "task", projectPath: null },
  }));
  let viewerCreates = 0;
  let viewerDisposals = 0;
  let state = { sessionId: "", items: [] };
  const listeners = [];
  const engine = {
    getState: () => state,
    subscribe: (listener) => { listeners.push(listener); return () => {}; },
    listSessions: () => rows,
    newSession: async () => true,
    resume: async (id) => {
      state = { sessionId: id, items: [{ id: `${id}-p`, kind: "user", text: `persisted ${id}` }], busy: false };
      return true;
    },
    fire: () => { for (const listener of listeners) listener(); },
    dispose: async () => {},
  };
  const host = new EngineHost({
    userDataPath: root,
    createEngine: async () => engine,
    loadSessionStore: async () => ({
      listStoredSessionSummaries: () => rows,
      async readStoredSessionTranscript(id) {
        return {
          sessionId: id,
          items: [{ id: `${id}-p`, kind: "user", text: `persisted ${id}` }],
          provider: "openai",
          model: "gpt-test",
          cwd: workspace,
          desktopSession: { classification: "task", projectPath: null },
        };
      },
      async createStoredSessionLiveViewer(_id, options) {
        viewerCreates += 1;
        return { dispose() { viewerDisposals += 1; }, options };
      },
    }),
  });
  const updates = [];
  const unsubscribe = host.subscribeSessionStates((update) => updates.push(update));
  try {
    // Cold visible pane: only a STORED frame is retained, so focus hands over
    // immediately and cleans the viewer up.
    assert.equal(await host.setVisibleSessions(["desktop_cold_a"]), true);
    assert.equal(viewerCreates, 1);
    assert.equal(updates.at(-1)?.snapshot.items?.[0]?.text, "persisted desktop_cold_a");
    const coldStoredRevision = updates.at(-1)?.contentRevision ?? 0;
    updates.length = 0;
    assert.equal((await host.resumeSession("desktop_cold_a")).sessionId, "desktop_cold_a");
    await new Promise((resolve) => setTimeout(resolve, ENGINE_PUBLICATION_INTERVAL_MS + 100));
    // No retained LIVE frame exists, so nothing is held back: the resumed
    // engine publishes its own content immediately, as an ordinary live frame,
    // without any synthetic transcript change.
    const coldResumeFrames = updates.filter((update) => update.sessionId === "desktop_cold_a");
    assert.ok(coldResumeFrames.length > 0, "a cold resume publishes on its pane lane immediately");
    assert.ok(coldResumeFrames.every((update) => update.frameSource === "live"),
      `cold resume publications are ordinary live frames, never suppressed replays: ${
        JSON.stringify(coldResumeFrames.map((update) => ({
          frameSource: update.frameSource,
          contentRevision: update.contentRevision,
          text: update.snapshot?.items?.at(-1)?.text,
        })))
      }`);
    assert.ok(coldResumeFrames.every((update) =>
      update.snapshot.items.at(-1)?.text === "persisted desktop_cold_a"),
      "a cold resume publishes the resumed engine's own content");
    assert.ok(coldResumeFrames.every((update) => update.contentRevision >= coldStoredRevision),
      "an immediate cold resume frame never regresses the pane's accepted revision");
    assert.equal(viewerDisposals, 1,
      "a cold pane's viewer is released on resume, with no artificial advance");
    updates.length = 0;
    state = {
      sessionId: "desktop_cold_a",
      items: [
        { id: "desktop_cold_a-p", kind: "user", text: "persisted desktop_cold_a" },
        { id: "cold-a-2", kind: "assistant", text: "cold engine progress" },
      ],
      busy: false,
    };
    engine.fire();
    await new Promise((resolve) => setTimeout(resolve, ENGINE_PUBLICATION_INTERVAL_MS + 100));
    const coldLive = updates.filter((update) => update.sessionId === "desktop_cold_a"
      && update.snapshot.items.at(-1)?.text === "cold engine progress");
    assert.equal(coldLive.length, 1, "a cold resume keeps streaming its own lane");
    assert.equal(coldLive[0].frameSource, "live");
    assert.equal(viewerDisposals, 1, "a cold pane's viewer is released once the engine owns it");

    // The host lane remains complete for direct consumers; Electron transport
    // applies visible-pane filtering at its process boundary.
    await host.setVisibleSessions([]);
    updates.length = 0;
    const resumedB = await host.resumeSession("desktop_cold_b");
    assert.equal(resumedB.sessionId, "desktop_cold_b");
    assert.equal(viewerCreates, 1, "a non-visible resume never opens a pane viewer");
    await new Promise((resolve) => setTimeout(resolve, ENGINE_PUBLICATION_INTERVAL_MS + 100));
    const hiddenResumeFrames = updates.filter((update) => update.sessionId === "desktop_cold_b");
    assert.ok(hiddenResumeFrames.length > 0,
      "a non-visible resume remains available on the host lane");
    assert.ok(hiddenResumeFrames.every((update) => update.frameSource === "live"
      && update.snapshot.items.at(-1)?.text === "persisted desktop_cold_b"),
      "the direct host lane publishes ordinary live content with no hold");
    updates.length = 0;
    state = {
      sessionId: "desktop_cold_b",
      items: [
        { id: "desktop_cold_b-p", kind: "user", text: "persisted desktop_cold_b" },
        { id: "cold-b-2", kind: "assistant", text: "hidden engine progress" },
      ],
      busy: false,
    };
    engine.fire();
    await new Promise((resolve) => setTimeout(resolve, ENGINE_PUBLICATION_INTERVAL_MS + 100));
    const hiddenLive = updates.filter((update) => update.sessionId === "desktop_cold_b"
      && update.snapshot.items.at(-1)?.text === "hidden engine progress");
    assert.equal(hiddenLive.length, 1);
    assert.equal(hiddenLive[0].frameSource, "live");
  } finally {
    unsubscribe();
    await host.dispose();
    process.chdir(originalCwd);
    await rm(root, { recursive: true, force: true });
  }
});

test("a delayed empty, older or diverged engine frame never takes a held visible pane", async () => {
  const root = await mkdtemp(join(tmpdir(), "mixdog-resume-hold-order-"));
  const originalCwd = process.cwd();
  const workspace = join(root, "workspace", "unclassified");
  await mkdir(workspace, { recursive: true });
  const sessionId = "desktop_hold_order";
  const row = {
    id: sessionId,
    preview: "Ordering pane",
    updatedAt: 1,
    cwd: workspace,
    desktopSession: { classification: "task", projectPath: null },
  };
  const persisted = () => [{ id: "p1", kind: "user", text: "persisted turn" }];
  const liveTurn = { id: "live-2", kind: "assistant", text: "live newer turn" };
  let viewerOptions = null;
  let viewerDisposals = 0;
  let state = { sessionId: "", items: [] };
  const listeners = [];
  const engine = {
    getState: () => state,
    subscribe: (listener) => { listeners.push(listener); return () => {}; },
    listSessions: () => [row],
    newSession: async () => true,
    resume: async (id) => {
      state = { sessionId: id, items: persisted(), busy: false };
      return true;
    },
    fire: () => { for (const listener of listeners) listener(); },
    dispose: async () => {},
  };
  const host = new EngineHost({
    userDataPath: root,
    createEngine: async () => engine,
    loadSessionStore: async () => ({
      listStoredSessionSummaries: () => [row],
      async readStoredSessionTranscript(id) {
        return {
          sessionId: id,
          items: persisted(),
          provider: "openai",
          model: "gpt-test",
          cwd: workspace,
          desktopSession: { classification: "task", projectPath: null },
        };
      },
      async createStoredSessionLiveViewer(_id, options) {
        viewerOptions = options;
        return { dispose() { viewerDisposals += 1; } };
      },
    }),
  });
  const updates = [];
  const unsubscribe = host.subscribeSessionStates((update) => updates.push(update));
  try {
    assert.equal(await host.setVisibleSessions([sessionId]), true);
    viewerOptions.onSnapshot({
      ...viewerOptions.initialSnapshot,
      items: [...persisted(), liveTurn],
    });
    const liveRevision = updates.at(-1).contentRevision;
    await host.resumeSession(sessionId);
    updates.length = 0;
    // A generation hash proves identity, never order. Each of these frames has
    // a DIFFERENT hash than the retained one and must still lose the lane.
    const stale = [
      { label: "empty", items: [] },
      { label: "older", items: persisted() },
      {
        label: "diverged same-length",
        items: [...persisted(), { id: "live-x", kind: "assistant", text: "other branch turn" }],
      },
      {
        label: "payload-stripped",
        items: [...persisted(), { id: "live-2", kind: "assistant", text: "live" }],
      },
    ];
    for (const frame of stale) {
      updates.length = 0;
      state = { sessionId, items: frame.items, busy: false };
      engine.fire();
      await new Promise((resolve) => setTimeout(resolve, ENGINE_PUBLICATION_INTERVAL_MS + 100));
      const paneFrames = updates.filter((update) => update.sessionId === sessionId);
      assert.ok(paneFrames.length > 0, `the ${frame.label} emission still projects the pane`);
      assert.ok(
        paneFrames.every((update) => update.snapshot.items.at(-1)?.text === "live newer turn"
          && update.frameSource === "replay"
          && update.contentRevision === liveRevision),
        `a ${frame.label} engine frame must not replace the retained live frame`,
      );
      assert.equal(viewerDisposals, 0,
        `a ${frame.label} engine frame must not dispose the pane's live viewer`);
    }
    // Only a frame PROVEN to carry the retained content hands authority over.
    updates.length = 0;
    state = {
      sessionId,
      items: [...persisted(), liveTurn, { id: "engine-3", kind: "assistant", text: "engine newer turn" }],
      busy: false,
    };
    engine.fire();
    await new Promise((resolve) => setTimeout(resolve, ENGINE_PUBLICATION_INTERVAL_MS + 100));
    const handed = updates.filter((update) => update.sessionId === sessionId
      && update.snapshot.items.at(-1)?.text === "engine newer turn");
    assert.equal(handed.length, 1, "a proven-current engine frame publishes exactly once");
    assert.equal(handed[0].frameSource, "live");
    assert.ok(handed[0].contentRevision > liveRevision);
    assert.equal(viewerDisposals, 1, "the viewer is released only by a successful handoff");
  } finally {
    unsubscribe();
    await host.dispose();
    process.chdir(originalCwd);
    await rm(root, { recursive: true, force: true });
  }
});

test("a rejected, throwing or mismatched resume clears the lane hold", async () => {
  const scenarios = [
    {
      label: "rejected resume",
      message: /could not be resumed/i,
      resume: () => false,
    },
    {
      label: "throwing resume",
      message: /resume exploded/,
      resume: () => { throw new Error("resume exploded"); },
    },
    {
      label: "mismatched resume",
      message: /unexpected session/i,
      resume: (_id, api) => {
        api.setState({ sessionId: "desktop_other_session", items: api.persisted(), busy: false });
        return true;
      },
    },
  ];
  for (const scenario of scenarios) {
    const root = await mkdtemp(join(tmpdir(), "mixdog-resume-hold-clear-"));
    const originalCwd = process.cwd();
    const workspace = join(root, "workspace", "unclassified");
    await mkdir(workspace, { recursive: true });
    const sessionId = "desktop_hold_clear";
    const row = {
      id: sessionId,
      preview: "Hold clear pane",
      updatedAt: 1,
      cwd: workspace,
      desktopSession: { classification: "task", projectPath: null },
    };
    const persisted = () => [{ id: "p1", kind: "user", text: "persisted turn" }];
    const liveTurn = { id: "live-2", kind: "assistant", text: "live newer turn" };
    let viewerOptions = null;
    let viewerDisposals = 0;
    let state = { sessionId: "", items: [] };
    const listeners = [];
    const engine = {
      getState: () => state,
      subscribe: (listener) => { listeners.push(listener); return () => {}; },
      listSessions: () => [row],
      newSession: async () => true,
      // The engine is REUSED across the failure (same managed context), so a
      // hold left behind would suppress its lane forever.
      resume: async (id) => scenario.resume(id, {
        setState: (next) => { state = next; },
        persisted,
      }),
      fire: () => { for (const listener of listeners) listener(); },
      dispose: async () => {},
    };
    const host = new EngineHost({
      userDataPath: root,
      createEngine: async () => engine,
      loadSessionStore: async () => ({
        listStoredSessionSummaries: () => [row],
        async readStoredSessionTranscript(id) {
          return {
            sessionId: id,
            items: persisted(),
            provider: "openai",
            model: "gpt-test",
            cwd: workspace,
            desktopSession: { classification: "task", projectPath: null },
          };
        },
        async createStoredSessionLiveViewer(_id, options) {
          viewerOptions = options;
          return { dispose() { viewerDisposals += 1; } };
        },
      }),
    });
    const updates = [];
    const unsubscribe = host.subscribeSessionStates((update) => updates.push(update));
    try {
      assert.equal(await host.setVisibleSessions([sessionId]), true);
      viewerOptions.onSnapshot({
        ...viewerOptions.initialSnapshot,
        items: [...persisted(), liveTurn],
      });
      const liveRevision = updates.at(-1).contentRevision;
      await assert.rejects(
        host.resumeSession(sessionId),
        scenario.message,
        `${scenario.label} must still surface its failure`,
      );
      updates.length = 0;
      // The same engine later becomes this session's live owner.
      state = {
        sessionId,
        items: [...persisted(), liveTurn, { id: "engine-3", kind: "assistant", text: "engine newer turn" }],
        busy: false,
      };
      engine.fire();
      await new Promise((resolve) => setTimeout(resolve, ENGINE_PUBLICATION_INTERVAL_MS + 100));
      const live = updates.filter((update) => update.sessionId === sessionId
        && update.snapshot.items.at(-1)?.text === "engine newer turn");
      assert.ok(live.length >= 1,
        `${scenario.label} must not suppress later live publications`);
      assert.equal(live[0].frameSource, "live",
        `${scenario.label} must leave no stale hold stamping replays`);
      assert.ok(live[0].contentRevision > liveRevision,
        `${scenario.label} must let the live frame advance the pane revision`);
      // No stale hold survives: the next reconcile hands the pane to the engine
      // and releases the read-only viewer instead of leaking it.
      await host.setVisibleSessions([sessionId]);
      assert.equal(viewerDisposals, 1,
        `${scenario.label} must release the pane viewer once the engine owns the lane`);
    } finally {
      unsubscribe();
      await host.dispose();
      process.chdir(originalCwd);
      await rm(root, { recursive: true, force: true });
    }
  }
});

test("a viewer created while a focus resume is pending survives until the handoff", async () => {
  const root = await mkdtemp(join(tmpdir(), "mixdog-resume-viewer-overlap-"));
  const originalCwd = process.cwd();
  const workspace = join(root, "workspace", "unclassified");
  await mkdir(workspace, { recursive: true });
  const sessionId = "desktop_overlap";
  const row = {
    id: sessionId,
    preview: "Overlap pane",
    updatedAt: 1,
    cwd: workspace,
    desktopSession: { classification: "task", projectPath: null },
  };
  const persisted = () => [{ id: "p1", kind: "user", text: "persisted turn" }];
  const liveTurn = { id: "live-2", kind: "assistant", text: "live newer turn" };
  let deferViewer = false;
  let releaseViewer = null;
  let viewerOptions = null;
  let viewerCreates = 0;
  let viewerDisposals = 0;
  let state = { sessionId: "", items: [] };
  const listeners = [];
  const engine = {
    getState: () => state,
    subscribe: (listener) => { listeners.push(listener); return () => {}; },
    listSessions: () => [row],
    newSession: async () => true,
    resume: async (id) => {
      state = { sessionId: id, items: persisted(), busy: false };
      return true;
    },
    fire: () => { for (const listener of listeners) listener(); },
    dispose: async () => {},
  };
  const host = new EngineHost({
    userDataPath: root,
    createEngine: async () => engine,
    loadSessionStore: async () => ({
      listStoredSessionSummaries: () => [row],
      async readStoredSessionTranscript(id) {
        return {
          sessionId: id,
          items: persisted(),
          provider: "openai",
          model: "gpt-test",
          cwd: workspace,
          desktopSession: { classification: "task", projectPath: null },
        };
      },
      async createStoredSessionLiveViewer(_id, options) {
        viewerCreates += 1;
        viewerOptions = options;
        const viewer = { dispose() { viewerDisposals += 1; } };
        if (!deferViewer) return viewer;
        return await new Promise((resolve) => { releaseViewer = () => resolve(viewer); });
      },
    }),
  });
  const updates = [];
  const unsubscribe = host.subscribeSessionStates((update) => updates.push(update));
  try {
    // The pane's live frame comes from the engine itself, then the engine
    // leaves the session and a replacement viewer starts being created.
    await host.resumeSession(sessionId);
    assert.equal(await host.setVisibleSessions([sessionId]), true);
    state = { sessionId, items: [...persisted(), liveTurn], busy: false };
    engine.fire();
    await new Promise((resolve) => setTimeout(resolve, ENGINE_PUBLICATION_INTERVAL_MS + 100));
    assert.equal(updates.at(-1).snapshot.items.at(-1)?.text, "live newer turn");
    const liveRevision = updates.at(-1).contentRevision;
    assert.equal(viewerCreates, 0, "a pooled engine needs no read-only viewer");

    state = { sessionId: "", items: [] };
    deferViewer = true;
    const visible = host.setVisibleSessions([sessionId]);
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(viewerCreates, 1, "the pane starts creating a replacement viewer");
    assert.equal(typeof releaseViewer, "function");

    // Focus resume lands DURING that creation: the engine is behind the pane.
    await host.resumeSession(sessionId);
    updates.length = 0;
    releaseViewer();
    await visible;
    await new Promise((resolve) => setTimeout(resolve, ENGINE_PUBLICATION_INTERVAL_MS + 100));
    assert.equal(viewerDisposals, 0,
      "a viewer whose creation overlapped the resume is not disposed while the handoff is pending");
    assert.ok(
      updates.filter((update) => update.sessionId === sessionId)
        .every((update) => update.snapshot.items.at(-1)?.text === "live newer turn"),
      "the pane keeps its retained live frame through the pending handoff",
    );

    // The overlapping viewer stays authoritative AND updating.
    updates.length = 0;
    viewerOptions.onSnapshot({
      ...viewerOptions.initialSnapshot,
      items: [...persisted(), liveTurn, { id: "live-3", kind: "assistant", text: "viewer newer turn" }],
    });
    const viewerFrames = updates.filter((update) => update.sessionId === sessionId
      && update.snapshot.items.at(-1)?.text === "viewer newer turn");
    assert.equal(viewerFrames.length, 1, "the overlapping viewer keeps publishing the pane");
    assert.equal(viewerFrames[0].frameSource, "live");
    assert.ok(viewerFrames[0].contentRevision > liveRevision);
    assert.equal(viewerDisposals, 0);

    // Convergence: only now does the engine take the lane and release it.
    updates.length = 0;
    state = {
      sessionId,
      items: [
        ...persisted(),
        liveTurn,
        { id: "live-3", kind: "assistant", text: "viewer newer turn" },
        { id: "engine-4", kind: "assistant", text: "engine newer turn" },
      ],
      busy: false,
    };
    engine.fire();
    await new Promise((resolve) => setTimeout(resolve, ENGINE_PUBLICATION_INTERVAL_MS + 100));
    const handed = updates.filter((update) => update.sessionId === sessionId
      && update.snapshot.items.at(-1)?.text === "engine newer turn");
    assert.equal(handed.length, 1);
    assert.equal(handed[0].frameSource, "live");
    assert.equal(viewerDisposals, 1,
      "the overlapping viewer is disposed only by the successful atomic handoff");
  } finally {
    unsubscribe();
    await host.dispose();
    process.chdir(originalCwd);
    await rm(root, { recursive: true, force: true });
  }
});

test("a middle-row rewrite or payload swap is never a convergence proof", async () => {
  const root = await mkdtemp(join(tmpdir(), "mixdog-resume-rewrite-"));
  const originalCwd = process.cwd();
  const workspace = join(root, "workspace", "unclassified");
  await mkdir(workspace, { recursive: true });
  const sessionId = "desktop_rewrite";
  const row = {
    id: sessionId,
    preview: "Rewrite pane",
    updatedAt: 1,
    cwd: workspace,
    desktopSession: { classification: "task", projectPath: null },
  };
  // A tool row in the MIDDLE of the retained transcript: length, tail and
  // "payload still present" checks all stay satisfied while it is rewritten.
  const persisted = () => [
    { id: "p1", kind: "user", text: "persisted turn" },
    {
      id: "t1",
      kind: "tool",
      label: "read",
      args: { path: "a.ts" },
      result: "original tool result",
    },
  ];
  const liveTurn = { id: "live-2", kind: "assistant", text: "live newer turn" };
  const retainedItems = () => [...persisted(), liveTurn];
  let viewerOptions = null;
  let viewerDisposals = 0;
  let state = { sessionId: "", items: [] };
  const listeners = [];
  const engine = {
    getState: () => state,
    subscribe: (listener) => { listeners.push(listener); return () => {}; },
    listSessions: () => [row],
    newSession: async () => true,
    resume: async (id) => {
      state = { sessionId: id, items: persisted(), busy: false };
      return true;
    },
    fire: () => { for (const listener of listeners) listener(); },
    dispose: async () => {},
  };
  const host = new EngineHost({
    userDataPath: root,
    createEngine: async () => engine,
    loadSessionStore: async () => ({
      listStoredSessionSummaries: () => [row],
      async readStoredSessionTranscript(id) {
        return {
          sessionId: id,
          items: persisted(),
          provider: "openai",
          model: "gpt-test",
          cwd: workspace,
          desktopSession: { classification: "task", projectPath: null },
        };
      },
      async createStoredSessionLiveViewer(_id, options) {
        viewerOptions = options;
        return { dispose() { viewerDisposals += 1; } };
      },
    }),
  });
  const updates = [];
  const unsubscribe = host.subscribeSessionStates((update) => updates.push(update));
  try {
    assert.equal(await host.setVisibleSessions([sessionId]), true);
    viewerOptions.onSnapshot({ ...viewerOptions.initialSnapshot, items: retainedItems() });
    const liveRevision = updates.at(-1).contentRevision;
    await host.resumeSession(sessionId);
    await new Promise((resolve) => setTimeout(resolve, ENGINE_PUBLICATION_INTERVAL_MS + 100));
    updates.length = 0;

    const diverged = [
      {
        label: "middle row rewritten under a longer transcript",
        items: [
          persisted()[0],
          { id: "t1", kind: "tool", label: "read", args: { path: "a.ts" }, result: "rewritten tool result" },
          liveTurn,
          { id: "engine-3", kind: "assistant", text: "engine newer turn" },
        ],
      },
      {
        label: "middle row payload swapped for another non-empty payload",
        items: [
          persisted()[0],
          { id: "t1", kind: "tool", label: "read", args: { path: "b.ts" }, result: "original tool result" },
          liveTurn,
        ],
      },
      {
        label: "middle row removed",
        items: [
          persisted()[0],
          liveTurn,
          { id: "engine-3", kind: "assistant", text: "engine newer turn" },
        ],
      },
    ];
    for (const scenario of diverged) {
      state = { sessionId, items: scenario.items, busy: false };
      engine.fire();
      await new Promise((resolve) => setTimeout(resolve, ENGINE_PUBLICATION_INTERVAL_MS + 60));
    }
    const paneFrames = updates.filter((update) => update.sessionId === sessionId);
    assert.ok(paneFrames.length >= diverged.length,
      "every diverged emission still projects the pane");
    assert.ok(
      paneFrames.every((update) => JSON.stringify(update.snapshot.items)
        === JSON.stringify(retainedItems())),
      "a rewritten or removed retained row must never replace the pane's content",
    );
    assert.ok(
      paneFrames.every((update) => update.frameSource === "replay"
        && update.contentRevision === liveRevision),
      "suppressed rewrites keep stale-replay metadata for the renderer gate",
    );
    assert.equal(viewerDisposals, 0,
      "no rewrite may release the viewer that owns the pane");

    // Only an UNCHANGED superset of the retained rows converges.
    updates.length = 0;
    state = {
      sessionId,
      items: [...retainedItems(), { id: "engine-9", kind: "assistant", text: "engine newer turn" }],
      busy: false,
    };
    engine.fire();
    await new Promise((resolve) => setTimeout(resolve, ENGINE_PUBLICATION_INTERVAL_MS + 100));
    const handed = updates.filter((update) => update.sessionId === sessionId
      && update.snapshot.items.at(-1)?.text === "engine newer turn");
    assert.equal(handed.length, 1, "the unchanged superset hands over exactly once");
    assert.equal(handed[0].frameSource, "live");
    assert.ok(handed[0].contentRevision > liveRevision);
    assert.equal(viewerDisposals, 1);
  } finally {
    unsubscribe();
    await host.dispose();
    process.chdir(originalCwd);
    await rm(root, { recursive: true, force: true });
  }
});

test("a fork-on-resume migrates the pane identity atomically", async () => {
  const root = await mkdtemp(join(tmpdir(), "mixdog-resume-fork-"));
  const originalCwd = process.cwd();
  const workspace = join(root, "workspace", "unclassified");
  await mkdir(workspace, { recursive: true });
  const sessionId = "desktop_fork_origin";
  const forkId = "desktop_fork_child";
  const row = {
    id: sessionId,
    preview: "Fork pane",
    updatedAt: 1,
    cwd: workspace,
    desktopSession: { classification: "task", projectPath: null },
  };
  const persisted = () => [{ id: "p1", kind: "user", text: "persisted turn" }];
  const liveTurn = { id: "live-2", kind: "assistant", text: "live newer turn" };
  const viewerTurn = { id: "live-3", kind: "assistant", text: "viewer newest turn" };
  let viewerOptions = null;
  let viewerDisposals = 0;
  let state = { sessionId: "", items: [] };
  const listeners = [];
  const engine = {
    getState: () => state,
    subscribe: (listener) => { listeners.push(listener); return () => {}; },
    listSessions: () => [row],
    newSession: async () => true,
    // Another live process drives the clicked session: the resume forks it.
    resume: async (id) => {
      state = { sessionId: forkId, sessionForkedFrom: id, items: persisted(), busy: false };
      return true;
    },
    fire: () => { for (const listener of listeners) listener(); },
    dispose: async () => {},
  };
  const host = new EngineHost({
    userDataPath: root,
    createEngine: async () => engine,
    loadSessionStore: async () => ({
      listStoredSessionSummaries: () => [row],
      async readStoredSessionTranscript(id) {
        return {
          sessionId: id,
          items: persisted(),
          provider: "openai",
          model: "gpt-test",
          cwd: workspace,
          desktopSession: { classification: "task", projectPath: null },
        };
      },
      async createStoredSessionLiveViewer(_id, options) {
        viewerOptions = options;
        return { dispose() { viewerDisposals += 1; } };
      },
    }),
  });
  const updates = [];
  const unsubscribe = host.subscribeSessionStates((update) => updates.push(update));
  try {
    assert.equal(await host.setVisibleSessions([sessionId]), true);
    viewerOptions.onSnapshot({
      ...viewerOptions.initialSnapshot,
      items: [...persisted(), liveTurn],
    });
    const liveRevision = updates.at(-1).contentRevision;
    updates.length = 0;

    const resumed = await host.resumeSession(sessionId);
    assert.equal(resumed.sessionId, forkId, "the fork takes command/input ownership");
    await new Promise((resolve) => setTimeout(resolve, ENGINE_PUBLICATION_INTERVAL_MS + 100));
    const forkFrames = updates.filter((update) => update.sessionId === forkId);
    assert.ok(forkFrames.length >= 1, "the fork publishes on its own lane");
    assert.ok(
      forkFrames.every((update) => update.snapshot.items.at(-1)?.text === "live newer turn"
        && update.frameSource === "replay"
        && update.contentRevision === liveRevision),
      "no unconverged fork publication: the migrated pane keeps its frame AND revision",
    );
    assert.ok(
      updates.filter((update) => update.sessionId === sessionId)
        .every((update) => update.frameSource === "replay"),
      "the origin lane never publishes unconverged content after the identity moved",
    );
    assert.equal(viewerDisposals, 0,
      "the origin viewer is retargeted onto the fork pane, not leaked or dropped");

    // The migrated viewer now feeds the FORK pane under the new id.
    updates.length = 0;
    viewerOptions.onSnapshot({
      ...viewerOptions.initialSnapshot,
      items: [...persisted(), liveTurn, viewerTurn],
    });
    const viewerFrame = updates.at(-1);
    assert.equal(viewerFrame.sessionId, forkId, "the viewer publishes under the fork id");
    assert.equal(viewerFrame.frameSource, "live");
    assert.equal(viewerFrame.snapshot.items.at(-1).text, "viewer newest turn");
    assert.ok(viewerFrame.contentRevision > liveRevision);
    const viewerRevision = viewerFrame.contentRevision;

    // Convergence on the fork lane performs the handoff and releases the viewer.
    updates.length = 0;
    state = {
      sessionId: forkId,
      sessionForkedFrom: sessionId,
      items: [
        ...persisted(),
        liveTurn,
        viewerTurn,
        { id: "fork-4", kind: "assistant", text: "fork engine turn" },
      ],
      busy: false,
    };
    engine.fire();
    await new Promise((resolve) => setTimeout(resolve, ENGINE_PUBLICATION_INTERVAL_MS + 100));
    const handed = updates.filter((update) => update.sessionId === forkId
      && update.snapshot.items.at(-1)?.text === "fork engine turn");
    assert.equal(handed.length, 1, "the fork hands over exactly once, on convergence");
    assert.equal(handed[0].frameSource, "live");
    assert.ok(handed[0].contentRevision > viewerRevision);
    assert.equal(viewerDisposals, 1,
      "the migrated viewer is released by the handoff, so no origin viewer leaks");
  } finally {
    unsubscribe();
    await host.dispose();
    process.chdir(originalCwd);
    await rm(root, { recursive: true, force: true });
  }
});

test("a hold that gains its viewer late still ends when that viewer disappears", async () => {
  const root = await mkdtemp(join(tmpdir(), "mixdog-resume-viewer-late-"));
  const originalCwd = process.cwd();
  const workspace = join(root, "workspace", "unclassified");
  await mkdir(workspace, { recursive: true });
  const sessionId = "desktop_late_backed";
  const row = {
    id: sessionId,
    preview: "Late pane",
    updatedAt: 1,
    cwd: workspace,
    desktopSession: { classification: "task", projectPath: null },
  };
  const persisted = () => [{ id: "p1", kind: "user", text: "persisted turn" }];
  const liveTurn = { id: "live-2", kind: "assistant", text: "live newer turn" };
  let deferViewer = false;
  let releaseViewer = null;
  let viewerDisposals = 0;
  let state = { sessionId: "", items: [] };
  const listeners = [];
  const engine = {
    getState: () => state,
    subscribe: (listener) => { listeners.push(listener); return () => {}; },
    listSessions: () => [row],
    newSession: async () => true,
    resume: async (id) => {
      state = { sessionId: id, items: persisted(), busy: false };
      return true;
    },
    fire: () => { for (const listener of listeners) listener(); },
    dispose: async () => {},
  };
  const host = new EngineHost({
    userDataPath: root,
    createEngine: async () => engine,
    loadSessionStore: async () => ({
      listStoredSessionSummaries: () => [row],
      async readStoredSessionTranscript(id) {
        return {
          sessionId: id,
          items: persisted(),
          provider: "openai",
          model: "gpt-test",
          cwd: workspace,
          desktopSession: { classification: "task", projectPath: null },
        };
      },
      async createStoredSessionLiveViewer(_id, options) {
        const viewer = { options, dispose() { viewerDisposals += 1; } };
        if (!deferViewer) return viewer;
        return await new Promise((resolve) => { releaseViewer = () => resolve(viewer); });
      },
    }),
  });
  const updates = [];
  const unsubscribe = host.subscribeSessionStates((update) => updates.push(update));
  try {
    // The retained frame is the ENGINE's own live frame, so the hold opens with
    // no viewer at all; a replacement viewer is created afterwards.
    await host.resumeSession(sessionId);
    assert.equal(await host.setVisibleSessions([sessionId]), true);
    state = { sessionId, items: [...persisted(), liveTurn], busy: false };
    engine.fire();
    await new Promise((resolve) => setTimeout(resolve, ENGINE_PUBLICATION_INTERVAL_MS + 100));
    assert.equal(updates.at(-1).snapshot.items.at(-1)?.text, "live newer turn");

    state = { sessionId: "", items: [] };
    deferViewer = true;
    const visible = host.setVisibleSessions([sessionId]);
    await new Promise((resolve) => setTimeout(resolve, 50));
    await host.resumeSession(sessionId);
    releaseViewer();
    await visible;
    await new Promise((resolve) => setTimeout(resolve, ENGINE_PUBLICATION_INTERVAL_MS + 100));
    assert.equal(viewerDisposals, 0, "the late viewer is installed into the open hold");

    // That viewer now backs the hold. When the pane loses it for good, the
    // suppression must END instead of freezing the pane forever.
    await host.setVisibleSessions([]);
    assert.equal(viewerDisposals, 1);
    assert.equal(await host.setVisibleSessions([sessionId]), true);
    updates.length = 0;
    state = { sessionId, items: persisted(), busy: false };
    engine.fire();
    await new Promise((resolve) => setTimeout(resolve, ENGINE_PUBLICATION_INTERVAL_MS + 150));
    const afterViewer = updates.filter((update) => update.sessionId === sessionId);
    assert.ok(afterViewer.length >= 1, "the engine keeps publishing its lane");
    assert.equal(afterViewer.at(-1).frameSource, "live",
      "a hold marked viewer-backed late still exits once that viewer is gone");
    assert.equal(afterViewer.at(-1).snapshot.items.at(-1)?.text, "persisted turn");
  } finally {
    unsubscribe();
    await host.dispose();
    process.chdir(originalCwd);
    await rm(root, { recursive: true, force: true });
  }
});

test("a reused engine's previous hold never rekeys onto the next session's lane", async () => {
  const root = await mkdtemp(join(tmpdir(), "mixdog-resume-prior-hold-"));
  const originalCwd = process.cwd();
  const workspace = join(root, "workspace", "unclassified");
  await mkdir(workspace, { recursive: true });
  const rows = ["desktop_prior_a", "desktop_prior_b"].map((id, index) => ({
    id,
    preview: `Prior ${index + 1}`,
    updatedAt: 2 - index,
    cwd: workspace,
    desktopSession: { classification: "task", projectPath: null },
  }));
  const persisted = (id) => [{ id: `${id}-p`, kind: "user", text: `persisted ${id}` }];
  const liveTurn = { id: "live-2", kind: "assistant", text: "live newer turn" };
  const viewerOptions = new Map();
  const viewerDisposals = new Map();
  let state = { sessionId: "", items: [] };
  const listeners = [];
  const engine = {
    getState: () => state,
    subscribe: (listener) => { listeners.push(listener); return () => {}; },
    listSessions: () => rows,
    newSession: async () => true,
    resume: async (id) => {
      state = { sessionId: id, items: persisted(id), busy: false };
      return true;
    },
    fire: () => { for (const listener of listeners) listener(); },
    dispose: async () => {},
  };
  const host = new EngineHost({
    userDataPath: root,
    createEngine: async () => engine,
    loadSessionStore: async () => ({
      listStoredSessionSummaries: () => rows,
      async readStoredSessionTranscript(id) {
        return {
          sessionId: id,
          items: persisted(id),
          provider: "openai",
          model: "gpt-test",
          cwd: workspace,
          desktopSession: { classification: "task", projectPath: null },
        };
      },
      async createStoredSessionLiveViewer(id, options) {
        viewerOptions.set(id, options);
        return {
          dispose() { viewerDisposals.set(id, (viewerDisposals.get(id) ?? 0) + 1); },
        };
      },
    }),
  });
  const updates = [];
  const unsubscribe = host.subscribeSessionStates((update) => updates.push(update));
  try {
    assert.equal(await host.setVisibleSessions(["desktop_prior_a", "desktop_prior_b"]), true);
    viewerOptions.get("desktop_prior_a").onSnapshot({
      ...viewerOptions.get("desktop_prior_a").initialSnapshot,
      items: [...persisted("desktop_prior_a"), liveTurn],
    });
    // Pane A opens a hold on the shared engine: its live frame outruns the resume.
    await host.resumeSession("desktop_prior_a");
    await new Promise((resolve) => setTimeout(resolve, ENGINE_PUBLICATION_INTERVAL_MS + 100));
    assert.equal(
      updates.filter((update) => update.sessionId === "desktop_prior_a").at(-1)
        ?.snapshot.items.at(-1)?.text,
      "live newer turn",
      "pane A holds its own live frame",
    );

    // Focus moves to the cold pane B on the SAME engine: A's hold must go.
    updates.length = 0;
    const resumedB = await host.resumeSession("desktop_prior_b");
    assert.equal(resumedB.sessionId, "desktop_prior_b");
    await new Promise((resolve) => setTimeout(resolve, ENGINE_PUBLICATION_INTERVAL_MS + 100));
    const paneB = updates.filter((update) => update.sessionId === "desktop_prior_b");
    assert.ok(paneB.length >= 1, "pane B publishes its resumed engine immediately");
    assert.ok(
      paneB.every((update) => update.snapshot.items.at(-1)?.text === "persisted desktop_prior_b"),
      "pane B never renders the previous session's retained snapshot",
    );
    assert.ok(paneB.every((update) => update.frameSource === "live"),
      "a cleared prior hold leaves pane B with ordinary live provenance");
    assert.equal(viewerDisposals.get("desktop_prior_b") ?? 0, 1,
      "pane B's read-only viewer is released once its engine owns the lane");
    assert.equal(viewerDisposals.get("desktop_prior_a") ?? 0, 0,
      "pane A keeps the viewer that still owns its content");

    // Pane A remains live through its own viewer, unaffected by the moved focus.
    updates.length = 0;
    viewerOptions.get("desktop_prior_a").onSnapshot({
      ...viewerOptions.get("desktop_prior_a").initialSnapshot,
      items: [...persisted("desktop_prior_a"), liveTurn, { id: "live-3", kind: "assistant", text: "pane a newest" }],
    });
    const paneA = updates.filter((update) => update.sessionId === "desktop_prior_a");
    assert.equal(paneA.at(-1)?.snapshot.items.at(-1)?.text, "pane a newest");
    assert.equal(paneA.at(-1)?.frameSource, "live");
  } finally {
    unsubscribe();
    await host.dispose();
    process.chdir(originalCwd);
    await rm(root, { recursive: true, force: true });
  }
});

// One host process owns every pooled pane's background shells, so the poller
// must hand each pane its OWN bucket: a blank New task pane was showing another
// session's running shell (user report).
test("shell job polling scopes counts to the dispatching session", async () => {
  const segments = `data:text/javascript,${encodeURIComponent(`
    let poll = 0;
    export function shellJobsStatus() {
      poll += 1;
      return poll === 1
        ? { count: 2, elapsedLabel: "7s", sessions: { "session-a": { count: 2, elapsedLabel: "7s" } } }
        : { count: 0, elapsedLabel: "", sessions: {} };
    }
  `)}`;
  const changes = [];
  let announce = () => {};
  const nextChange = () => new Promise((resolve) => { announce = resolve; });
  // The poller unrefs its timers so it never pins the app; the test must hold
  // the loop open itself while it waits for a tick.
  const keepAlive = setInterval(() => {}, 10);
  const poller = createShellJobsPoller({
    getEngineState: () => ({ clientHostPid: process.pid, busy: true }),
    moduleUrl: () => segments,
    onChange: (changedSessionIds) => {
      changes.push([...changedSessionIds]);
      announce();
    },
  });
  const started = nextChange();
  poller.start();
  await started;
  try {
    assert.deepEqual(changes[0], ["session-a"], "only the owning session's pane is republished");
    assert.equal(poller.status.count, 2, "the host-wide aggregate still drives keep-awake");
    assert.equal(poller.statusFor("session-a").count, 2);
    assert.equal(poller.statusFor("session-b").count, 0,
      "another session's pane must never inherit the job");
    assert.equal(poller.statusFor("").count, 0, "a blank New task pane owns no jobs");

    // The finished job repaints the owning pane exactly once more.
    await nextChange();
    assert.deepEqual(changes[1], ["session-a"]);
    assert.equal(poller.statusFor("session-a").count, 0);
  } finally {
    clearInterval(keepAlive);
    poller.stop();
  }
});
