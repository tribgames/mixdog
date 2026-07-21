import { strict as assert } from "node:assert";
import { mkdtemp, mkdir, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { EngineHost } from "./engine-host.ts";
import { TranscriptRow } from "../renderer/App.tsx";

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
    resume: async (sessionId) => {
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
  } finally {
    await host.dispose();
    await rm(root, { recursive: true, force: true });
  }
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
