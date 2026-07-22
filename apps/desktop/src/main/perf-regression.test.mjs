import { strict as assert } from "node:assert";
import { mkdtemp, mkdir, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { DESKTOP_TRANSCRIPT_ITEM_LIMIT, EngineHost } from "./engine-host.ts";
import {
  TranscriptRow,
  estimatedTranscriptRowHeight,
  hasActiveSnapshotWork,
  workingSessionIdsForSnapshot,
} from "../renderer/App.tsx";

const wait = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

test("engine event publications are coalesced and skip snapshots without subscribers", async () => {
  let stateReads = 0;
  const engine = {
    getState: () => {
      stateReads += 1;
      return { sessionId: "perf_session", items: [{ id: "answer", text: "stable" }], queued: [] };
    },
    dispose: async () => {},
  };
  const host = new EngineHost({ createEngine: async () => engine });
  const internal = host;
  internal.engine = engine;

  let publications = 0;
  const unsubscribe = host.subscribe(() => { publications += 1; });
  internal.publishEngineEvent();
  internal.publishEngineEvent();
  internal.publishEngineEvent();
  await wait(75);
  assert.equal(publications, 1);
  assert.equal(stateReads, 1);

  unsubscribe();
  internal.publishNow();
  assert.equal(stateReads, 1);
  await host.dispose();
});

test("large transcript snapshots reuse sanitized row projections", async () => {
  const items = Array.from({ length: 5_000 }, (_, index) => ({
    id: `row-${index}`,
    kind: index % 2 === 0 ? "user" : "assistant",
    text: `Stable transcript row ${index}`,
  }));
  const engine = {
    getState: () => ({ sessionId: "large_session", items, queued: [] }),
    dispose: async () => {},
  };
  const host = new EngineHost({ createEngine: async () => engine });
  const internal = host;
  internal.engine = engine;
  const first = host.getSnapshot();
  const second = host.getSnapshot();
  assert.equal(first.items.length, 5_000);
  assert.equal(second.items[4_999].text, "Stable transcript row 4999");
  assert.equal(first.items[2_500], second.items[2_500]);
  await host.dispose();
});

test("resumeSession uses the cached catalog before requesting a storage refresh", async () => {
  const root = await mkdtemp(join(tmpdir(), "mixdog-perf-resume-"));
  const workspace = join(root, "workspace", "unclassified");
  await mkdir(workspace, { recursive: true });
  const canonicalWorkspace = await realpath(workspace);
  const calls = [];
  let resumeOptions = null;
  let state = { sessionId: "", items: [], queued: [] };
  const row = {
    id: "cached_session",
    preview: "Cached session",
    cwd: canonicalWorkspace,
    desktopSession: { classification: "task", projectPath: null },
  };
  const engine = {
    getState: () => state,
    listSessions: (options) => {
      calls.push(options);
      return [row];
    },
    resume: async (sessionId, options) => {
      resumeOptions = options;
      state = { sessionId, items: [], queued: [] };
      return true;
    },
    subscribe: () => () => {},
    dispose: async () => {},
  };
  const host = new EngineHost({ userDataPath: root, createEngine: async () => engine });
  const internal = host;
  internal.engine = engine;
  internal.engineWorkspace = canonicalWorkspace;
  internal.engineDesktopSession = { classification: "task", projectPath: null };

  try {
    await host.resumeSession(row.id);
    assert.deepEqual(calls, [undefined]);
    assert.deepEqual(resumeOptions, { transcriptItemLimit: DESKTOP_TRANSCRIPT_ITEM_LIMIT });
  } finally {
    await host.dispose();
    await rm(root, { recursive: true, force: true });
  }
});

test("session prefetch reaches the warm engine without changing its active state", async () => {
  const calls = [];
  const state = { sessionId: "active", items: [], queued: [] };
  const engine = {
    getState: () => state,
    prefetchSession: async (id) => {
      calls.push(id);
      return true;
    },
    dispose: async () => {},
  };
  const host = new EngineHost({ createEngine: async () => engine });
  const internal = host;
  internal.engine = engine;

  assert.equal(await host.prefetchSession("next_session"), true);
  assert.deepEqual(calls, ["next_session"]);
  assert.equal(engine.getState().sessionId, "active");
  await host.dispose();
});

test("TranscriptRow keeps semantically unchanged rows memoized", () => {
  assert.equal(typeof TranscriptRow.compare, "function");
  const item = { id: "answer", kind: "assistant", text: "Stable response", streaming: false };
  assert.equal(
    TranscriptRow.compare({ item }, { item: { ...item } }),
    true,
  );
  assert.equal(
    TranscriptRow.compare({ item }, { item: { ...item, text: "Updated response" } }),
    false,
  );
});

test("live transcript estimates scale with a long streaming script", () => {
  const short = {
    id: "live-script",
    kind: "assistant",
    text: "```powershell\nGet-ChildItem\n```",
    streaming: true,
  };
  const long = {
    ...short,
    text: `\`\`\`powershell\n${Array.from({ length: 90 }, (_, index) =>
      `Write-Output "streaming line ${index}"`).join("\n")}\n\`\`\``,
  };
  assert.ok(estimatedTranscriptRowHeight(short) < estimatedTranscriptRowHeight(long));
  assert.ok(estimatedTranscriptRowHeight(long) > 1_500,
    "a mounted long live script must not start from the old 160px cap");
});

test("desktop work detection includes live engine activity fields", () => {
  assert.equal(hasActiveSnapshotWork({ items: [], queued: [], busy: true }), true);
  assert.equal(hasActiveSnapshotWork({
    items: [], queued: [], busy: false, spinner: { active: true },
  }), true);
  assert.equal(hasActiveSnapshotWork({
    items: [], queued: [], thinking: { summary: "Working" },
  }), true);
  assert.equal(hasActiveSnapshotWork({
    items: [], queued: [], spinner: { active: false }, commandStatus: { active: false },
  }), false);
});

test("selected live snapshot overrides a stale catalog heartbeat", () => {
  const sessions = [
    { id: "selected", working: true },
    { id: "background", working: true },
  ];
  const settled = workingSessionIdsForSnapshot(sessions, "selected", false);
  assert.equal(settled.has("selected"), false);
  assert.equal(settled.has("background"), true,
    "other live sessions must keep their cross-process progress indicator");

  const active = workingSessionIdsForSnapshot(sessions, "selected", true);
  assert.equal(active.has("selected"), true);
});

test("streaming-only state patches preserve settled item array identity", async () => {
  const preload = await readFile(new URL("../preload/index.ts", import.meta.url), "utf8");
  assert.match(preload, /patch\.prefix !== items\.length \|\| patch\.append\.length > 0/);
});

test("heavy renderer surfaces remain dynamic imports", async () => {
  const source = await readFile(new URL("../renderer/App.tsx", import.meta.url), "utf8");
  for (const modulePath of [
    "./settings/SettingsView",
    "./settings/OnboardingWizard",
    "./CommandSurface",
    "./DiffView.lazy",
  ]) {
    assert.match(source, new RegExp(`import\\(["']${modulePath.replaceAll(".", "\\.")}["']\\)`));
  }
  assert.doesNotMatch(source, /\.preloadSettings\(api\)/,
    "startup may warm the settings chunk but must not hydrate engine capabilities");
  assert.doesNotMatch(source, /schedulePostInteractionIdle\(\(\) => setSettingsMounted\(true\)\)/,
    "startup must not mount the hidden settings tree and trigger its data effects");
});

test("cold desktop entry keeps optional native and network modules behind dynamic imports", async () => {
  const [entry, terminal, updater, host] = await Promise.all([
    readFile(new URL("./index.ts", import.meta.url), "utf8"),
    readFile(new URL("./terminal-manager.ts", import.meta.url), "utf8"),
    readFile(new URL("./updater.ts", import.meta.url), "utf8"),
    readFile(new URL("./engine-host.ts", import.meta.url), "utf8"),
  ]);
  assert.doesNotMatch(entry, /^import (?!type\b).*['"]\.\/remote-(?:bridge|relay)['"];?$/m);
  assert.match(entry, /import\(['"]\.\/remote-bridge['"]\)/);
  assert.match(entry, /import\(['"]\.\/remote-relay['"]\)/);
  assert.doesNotMatch(terminal, /^import \{[^}]*spawn[^}]*\} from ['"]@homebridge\/node-pty/m);
  assert.match(terminal, /import\(['"]@homebridge\/node-pty-prebuilt-multiarch['"]\)/);
  assert.doesNotMatch(updater, /^import electronUpdater from ['"]electron-updater['"];?$/m);
  assert.match(updater, /import\(['"]electron-updater['"]\)/);
  assert.match(host, /session\/store-summary-reader\.mjs/);
  assert.doesNotMatch(host, /scheduleDefaultEnginePrewarm|enginePrewarmPromise/,
    "cold sidebar listing must not enqueue background runtime work");
});
