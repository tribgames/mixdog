import { strict as assert } from "node:assert";
import { mkdtemp, mkdir, realpath, rm } from "node:fs/promises";
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
  const source = await import("node:fs/promises")
    .then(({ readFile }) => readFile(new URL("../renderer/App.tsx", import.meta.url), "utf8"));
  for (const modulePath of [
    "./settings/SettingsView",
    "./settings/OnboardingWizard",
    "./CommandSurface",
    "./DiffView.lazy",
  ]) {
    assert.match(source, new RegExp(`lazy\\(\\(\\) => import\\(["']${modulePath.replaceAll(".", "\\.")}["']\\)`));
  }
});
