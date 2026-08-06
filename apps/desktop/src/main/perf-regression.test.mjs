import { strict as assert } from "node:assert";
import { mkdtemp, mkdir, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { DESKTOP_TRANSCRIPT_ITEM_LIMIT, EngineHost } from "./engine-host.ts";
import {
  createSnapshotDeltaDecoder,
  createSnapshotDeltaEncoder,
  shouldPublishSessionState,
} from "./state-delta.ts";
import { nextHotFileEditorKeys, shouldKeepFileEditorMounted, TranscriptRow } from "../renderer/App.tsx";
import { mergeSessionCatalogRows } from "../shared/session-catalog.ts";
import {
  readTranscriptVirtualSnapshot,
  rememberTranscriptVirtualMeasurements,
  TRANSCRIPT_VIRTUAL_CACHE_LIMIT,
} from "../renderer/transcript-virtual-cache.ts";
import { hasActiveSnapshotWork, workingSessionIdsForSnapshot } from "../renderer/desktop-types.ts";
import {
  desktopChromeSnapshotsEqual,
  desktopConversationShellSnapshotsEqual,
  desktopConversationSnapshotsEqual,
  desktopDockSnapshotsEqual,
  desktopHeaderSnapshotsEqual,
  desktopSidebarSnapshotsEqual,
} from "../renderer/desktop-snapshot-store.ts";
import {
  createStreamingMarkdownCache,
  isPlainTextMarkdown,
  MAX_STREAMING_UNSTABLE_MARKDOWN_CHARS,
  resolveStreamingMarkdownChunks,
} from "../renderer/streaming-markdown.ts";
import { transcriptItemsEqual } from "../renderer/TranscriptView.tsx";

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
  const stats = { turns: 1, outputTokens: 10 };
  const engine = {
    getState: () => ({ sessionId: "large_session", items, queued: [], stats }),
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
  assert.equal(first.stats, second.stats,
    "unchanged non-transcript fields should reuse their detached clone");
  stats.outputTokens = 20;
  const changed = host.getSnapshot();
  assert.notEqual(changed.stats, second.stats);
  assert.equal(changed.stats.outputTokens, 20);
  assert.equal(second.stats.outputTokens, 10,
    "in-place engine mutation must not alter an already published snapshot");
  await host.dispose();
});

test("session catalog publications skip lifecycle-only saves and preserve changed-row identity", async () => {
  const first = [
    {
      id: "stable",
      preview: "Stable session",
      title: "Stable session",
      updatedAt: 10,
      activityAt: 5,
      messageCount: 2,
      cwd: "C:/work",
      classification: "project",
      projectPath: "C:/work",
      currentSession: true,
    },
    {
      id: "other",
      preview: "Other session",
      title: "Other session",
      updatedAt: 9,
      activityAt: 4,
      messageCount: 1,
      cwd: "C:/other",
      classification: "project",
      projectPath: "C:/other",
      currentSession: false,
    },
  ];
  const housekeeping = [
    { ...first[1], updatedAt: 99 },
    { ...first[0], updatedAt: 100 },
  ];
  assert.equal(mergeSessionCatalogRows(first, housekeeping), first,
    "updatedAt-only saves and source-order churn must reuse the complete catalog");
  const changed = mergeSessionCatalogRows(first, [
    first[0],
    { ...first[1], messageCount: 2 },
  ]);
  assert.notEqual(changed, first);
  assert.equal(changed[0], first[0], "unchanged rows should retain object identity");
  assert.notEqual(changed[1], first[1]);

  const root = await mkdtemp(join(tmpdir(), "mixdog-perf-session-push-"));
  let rows = [{
    id: "catalog_session",
    preview: "Catalog session",
    updatedAt: 10,
    lastUsedAt: 5,
    messageCount: 1,
    cwd: join(root, "workspace"),
  }];
  const engine = {
    getState: () => ({ sessionId: "catalog_session", items: [], queued: [] }),
    listSessions: () => rows.map((row) => ({ ...row })),
    dispose: async () => {},
  };
  const host = new EngineHost({ userDataPath: root, createEngine: async () => engine });
  const internal = host;
  internal.engine = engine;
  // This test owns publication deduplication, not the process-global sidecar
  // reader used by production pushSessionRows(). Keep its synthetic rows as
  // the authoritative publication source.
  internal.pushSessionRows = async () => rows.map((row) => ({
    ...row,
    title: row.preview,
    classification: "task",
    projectPath: null,
    currentSession: row.id === engine.getState().sessionId,
  }));
  const publications = [];
  const unsubscribe = host.subscribeSessions((next) => publications.push(next));
  try {
    await internal.emitSessionsChanged();
    rows = [{ ...rows[0], updatedAt: 20 }];
    await internal.emitSessionsChanged();
    assert.equal(publications.length, 1,
      "lifecycle-only persistence must not cross IPC");
    rows = [{ ...rows[0], updatedAt: 30, messageCount: 2 }];
    await internal.emitSessionsChanged();
    assert.equal(publications.length, 2,
      "user-visible catalog changes must still publish");
  } finally {
    unsubscribe();
    await host.dispose();
    await rm(root, { recursive: true, force: true });
  }
});

test("only the visible file editor remains mounted", async () => {
  const dirty = new Set(["file:dirty"]);
  const hot = new Set(["file:warm"]);
  assert.equal(shouldKeepFileEditorMounted("file:active", "file:active", dirty), true);
  assert.equal(shouldKeepFileEditorMounted("file:dirty", "file:active", dirty), false);
  assert.equal(shouldKeepFileEditorMounted("file:warm", "file:active", dirty, hot), false);
  assert.equal(shouldKeepFileEditorMounted("file:clean", "file:active", dirty), false);
  assert.deepEqual(
    nextHotFileEditorKeys(["file:old", "file:active"], ["file:new", "file:active"], 2),
    ["file:new", "file:active"],
  );
  const source = await readFile(new URL("../renderer/EditorPane.lazy.tsx", import.meta.url), "utf8");
  assert.match(source, /useEffect\(\(\) => \(\) => \{[\s\S]*?model\?\.dispose\(\)/);
});

test("the external LSP owns TypeScript intelligence without a duplicate Monaco worker", async () => {
  const setup = await readFile(new URL("../renderer/monaco-setup.ts", import.meta.url), "utf8");
  const editor = await readFile(new URL("../renderer/EditorPane.lazy.tsx", import.meta.url), "utf8");
  const vite = await readFile(new URL("../../electron.vite.config.ts", import.meta.url), "utf8");
  assert.match(vite, /language\[\\\\\/\]typescript[\s\S]*monaco\\\.contribution/);
  assert.match(vite, /monaco-typescript-external\.ts/);
  assert.doesNotMatch(setup, /ts\.worker|typescriptDefaults|javascriptDefaults/);
  assert.doesNotMatch(editor, /getTypeScriptWorker|getJavaScriptWorker|monacoTypeScript/);
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

test("slow session prefetch never occupies the foreground transition lock", async () => {
  const originalCwd = process.cwd();
  const root = await mkdtemp(join(tmpdir(), "mixdog-perf-prefetch-lock-"));
  const workspace = join(root, "workspace", "unclassified");
  await mkdir(workspace, { recursive: true });
  const canonicalWorkspace = await realpath(workspace);
  let releasePrefetch;
  const prefetchGate = new Promise((resolve) => { releasePrefetch = resolve; });
  let state = { sessionId: "active", items: [], queued: [] };
  const row = {
    id: "next_session",
    preview: "Next session",
    cwd: canonicalWorkspace,
    desktopSession: { classification: "task", projectPath: null },
  };
  const engine = {
    getState: () => state,
    listSessions: () => [row],
    prefetchSession: async () => {
      await prefetchGate;
      return true;
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
  const warming = host.prefetchSession(row.id);
  const resume = host.resumeSession(row.id);
  try {
    const resumed = await Promise.race([resume, wait(75).then(() => null)]);
    assert.equal(resumed?.sessionId, row.id,
      "foreground resume must complete while speculative prefetch is still pending");
  } finally {
    releasePrefetch();
    await warming;
    await resume;
    try {
      await host.dispose();
    } finally {
      process.chdir(originalCwd);
      await rm(root, { recursive: true, force: true });
    }
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
  let serialized = 0;
  const streaming = {
    ...item,
    streaming: true,
    text: "x".repeat(100_000),
    toJSON() {
      serialized += 1;
      return this;
    },
  };
  assert.equal(transcriptItemsEqual(streaming, { ...streaming, text: `${streaming.text}!` }), false);
  assert.equal(serialized, 0, "the growing streaming tail must never be JSON-stringified for memo equality");
});

test("session virtual measurements survive re-entry and stay bounded", () => {
  rememberTranscriptVirtualMeasurements("perf-session", [
    { index: 0, key: "perf-session:a", start: 0, end: 212, size: 212, lane: 0 },
  ]);
  const restored = readTranscriptVirtualSnapshot("perf-session");
  assert.equal(restored.measurements.length, 1,
    "real measurements replace estimates on the next mount");
  for (let index = 0; index < TRANSCRIPT_VIRTUAL_CACHE_LIMIT + 4; index += 1) {
    rememberTranscriptVirtualMeasurements(`overflow-${index}`, [
      { index: 0, key: `overflow-${index}:a`, start: 0, end: 60, size: 60, lane: 0 },
    ]);
  }
  assert.equal(readTranscriptVirtualSnapshot("perf-session"), undefined,
    "the geometry cache stays bounded to the most recent sessions");
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
    items: [], queued: [], agentWorkers: [{ status: "running" }],
  }), true);
  assert.equal(hasActiveSnapshotWork({
    items: [], queued: [], agentJobs: [{ status: "queued" }],
  }), true);
  assert.equal(hasActiveSnapshotWork({
    items: [], queued: [], spinner: { active: false }, commandStatus: { active: false },
  }), false);
  assert.equal(hasActiveSnapshotWork({
    items: [],
    queued: [],
    agentWorkers: [{ status: "done" }],
    agentJobs: [{ status: "cancelled" }],
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

  const attached = workingSessionIdsForSnapshot(sessions, "selected", false, true);
  assert.equal(attached.has("selected"), true,
    "an idle remote-attached viewer must preserve the external owner's heartbeat");

  const childAgent = workingSessionIdsForSnapshot([
    { id: "selected-agent-parent", working: true, agentWorking: true },
  ], "selected-agent-parent", false);
  assert.equal(childAgent.has("selected-agent-parent"), true,
    "an idle selected lead must preserve its running child-agent heartbeat");
});

test("streaming-only state patches preserve settled item array identity", async () => {
  const [preload, ipc] = await Promise.all([
    readFile(new URL("../preload/index.ts", import.meta.url), "utf8"),
    readFile(new URL("./ipc.ts", import.meta.url), "utf8"),
  ]);
  assert.match(preload, /patch\.prefix !== items\.length \|\| patch\.append\.length > 0/);
  assert.match(ipc, /wire\.__streamingTailPatch/);
  assert.match(ipc, /wire\.__statePatch/);
  assert.match(preload, /Object\.assign\(nextFields, statePatch\.changed\)/);
  assert.match(preload, /priorText\.slice\(0, tailPatch\.prefix\) \+ tailPatch\.append/);
});

test("more than eight pane lanes retain incremental 5,000-row delta baselines", async () => {
  const laneCount = 16;
  const iterations = 20;
  const lanes = Array.from({ length: laneCount }, (_, lane) => {
    const items = Array.from({ length: 5_000 }, (_, row) => ({
      id: `lane-${lane}-row-${row}`,
      kind: row % 2 === 0 ? "user" : "assistant",
      text: `Stable lane ${lane} transcript row ${row}`,
    }));
    return {
      items,
      encoder: createSnapshotDeltaEncoder(),
      decoder: createSnapshotDeltaDecoder(),
    };
  });
  let initialBytes = 0;
  let deltaBytes = 0;
  for (let lane = 0; lane < lanes.length; lane += 1) {
    const entry = lanes[lane];
    const wire = entry.encoder.encode({
      sessionId: `pane_${lane}`,
      items: entry.items,
      busy: true,
      stats: { outputTokens: 0 },
    });
    initialBytes += Buffer.byteLength(JSON.stringify(wire));
    assert.equal(entry.decoder.decode(wire).ok, true);
  }
  for (let iteration = 1; iteration <= iterations; iteration += 1) {
    for (let lane = 0; lane < lanes.length; lane += 1) {
      const entry = lanes[lane];
      const wire = entry.encoder.encode({
        sessionId: `pane_${lane}`,
        items: entry.items,
        busy: iteration < iterations,
        stats: { outputTokens: iteration },
      });
      assert.ok(wire.__itemsPatch, "every post-baseline pane publication must be a patch");
      assert.equal(wire.__itemsPatch.append.length, 0,
        "status-only event storms must never resend settled transcript rows");
      deltaBytes += Buffer.byteLength(JSON.stringify(wire));
      const decoded = entry.decoder.decode(wire);
      assert.equal(decoded.ok, true);
      assert.equal(decoded.snapshot.items.length, 5_000);
    }
  }
  assert.ok(deltaBytes < initialBytes / 10,
    `pane event-storm deltas are too large (${deltaBytes} vs initial ${initialBytes})`);

  const [host, ipc, backend, backendClient, preload, rendererEntry] = await Promise.all([
    readFile(new URL("./engine-host.ts", import.meta.url), "utf8"),
    readFile(new URL("./ipc.ts", import.meta.url), "utf8"),
    readFile(new URL("./desktop-backend.ts", import.meta.url), "utf8"),
    readFile(new URL("./desktop-backend-client.ts", import.meta.url), "utf8"),
    readFile(new URL("../preload/index.ts", import.meta.url), "utf8"),
    readFile(new URL("../renderer/main.tsx", import.meta.url), "utf8"),
  ]);
  assert.doesNotMatch(host, /MAX_VISIBLE_SESSION_LIVE_VIEWS|slice\(0,\s*8\)/);
  assert.doesNotMatch(ipc, /sessionStateEncoders\.size\s*>\s*8|slice\(0,\s*8\)/);
  assert.doesNotMatch(backend, /SESSION_STATE_DELTA_CACHE_LIMIT|sessionStateEncoders\.size\s*>\s*8/);
  assert.doesNotMatch(backendClient, /sessionStateDecoders\.size\s*>\s*8|slice\(0,\s*8\)/);
  assert.doesNotMatch(preload, /decoders\.size\s*>\s*8/);
  assert.doesNotMatch(rendererEntry, /slice\(0,\s*8\)/);
  assert.match(host, /return this\.sessionLanes\.subscribe\(listener\)/,
    "the host lane must preserve direct peek and pooled-engine publication contracts");
  const visible = new Set(["pane_visible"]);
  assert.equal(shouldPublishSessionState("pane_visible", {}, visible), true);
  assert.equal(shouldPublishSessionState("pane_hidden", {}, visible), false);
  assert.equal(shouldPublishSessionState("pane_hidden", null, visible), true,
    "release frames must cross the visibility gate");
  assert.match(backend,
    /shouldPublishSessionState\(update\.sessionId, update\.snapshot, visibleSessionIds\)/,
    "daemon backend pane IPC must stay proportional to visible panes");
  assert.match(ipc,
    /shouldPublishSessionState\(sessionId, update\.snapshot, visibleSessionStateIds\)/,
    "main-process pane IPC must stay proportional to visible panes");
  assert.match(backend, /snapshot === null[\s\S]*?sessionStateEncoders\.delete\(sessionId\)/,
    "closed panes must release daemon-backend delta baselines");
  assert.match(ipc, /update\.snapshot === null[\s\S]*?sessionStateEncoders\.delete\(sessionId\)/,
    "closed panes must release main-process delta baselines");
  assert.match(backendClient, /message\.wire === null\) this\.sessionStateDecoders\.delete\(sessionId\)/,
    "closed panes must release backend-client decoders");
  assert.match(preload, /update\.wire === null\) decoders\.delete\(sessionId\)/,
    "closed panes must release renderer-process decoders");
});

test("desktop snapshot selectors isolate streaming transcript publications", () => {
  const settled = {
    sessionId: "selected",
    currentProject: "C:/Project",
    busy: true,
    items: [{ id: "assistant", text: "stable" }],
    streamingTail: { id: "tail", kind: "assistant", text: "a" },
    stats: { outputTokens: 1 },
    agentWorkers: [],
  };
  const streamed = {
    ...settled,
    streamingTail: { ...settled.streamingTail, text: "a growing tail" },
    stats: { outputTokens: 2 },
  };
  assert.equal(desktopChromeSnapshotsEqual(settled, streamed), true);
  assert.equal(desktopConversationSnapshotsEqual(settled, streamed), false);
  assert.equal(desktopConversationShellSnapshotsEqual(settled, streamed), true,
    "token-only tail growth must update only the selector-driven live row");
  assert.equal(desktopConversationShellSnapshotsEqual(settled, {
    ...streamed,
    streamingTail: { ...streamed.streamingTail, id: "next-tail" },
  }), false, "tail identity changes must still rebuild shell geometry");
  assert.equal(desktopSidebarSnapshotsEqual(settled, streamed), true);
  assert.equal(desktopDockSnapshotsEqual(settled, streamed), true);
  assert.equal(desktopHeaderSnapshotsEqual(settled, streamed), false,
    "only the isolated live-status selector should observe token-counter changes");
  assert.equal(desktopDockSnapshotsEqual(settled, {
    ...settled,
    streamingTail: {
      id: "memory-tool",
      kind: "tool",
      name: "recall",
      startedAt: 1,
    },
  }), false, "the Tasks dock should observe live tool lifecycle changes");
  assert.equal(desktopDockSnapshotsEqual(settled, {
    ...settled,
    activeTools: { explore: { count: 1, startedAt: 1 } },
  }), false, "the Tasks dock should observe background tool summaries");
  assert.equal(desktopChromeSnapshotsEqual(settled, { ...streamed, busy: false }), false);
  assert.equal(desktopSidebarSnapshotsEqual(settled, { ...streamed, busy: false }), false);
  assert.equal(desktopConversationSnapshotsEqual(settled, {
    ...settled,
    stats: { outputTokens: 99 },
  }), true, "header-only counters must not invalidate the conversation tree");
  let selectorStringifies = 0;
  const stableThinking = {
    publicSummary: "Working",
    toJSON() {
      selectorStringifies += 1;
      return { publicSummary: this.publicSummary };
    },
  };
  const stableHeader = { ...settled, thinking: stableThinking };
  assert.equal(desktopHeaderSnapshotsEqual(stableHeader, { ...stableHeader }), true);
  assert.equal(selectorStringifies, 0,
    "snapshot selectors must use IPC-preserved identity instead of serializing stable objects");
});

test("desktop streaming Markdown retains stable parsed blocks and resets on regression", () => {
  const cache = createStreamingMarkdownCache();
  const paragraph = (label) => `${label} ${"content ".repeat(45).trim()}`;
  const firstText = `${paragraph("one")}\n\n${paragraph("two")}\n\n${paragraph("three")}`;
  const first = resolveStreamingMarkdownChunks(firstText, true, cache);
  assert.equal(first.stableChunks.length, 2);
  assert.match(first.stableChunks[0], /^one /);
  assert.match(first.stableChunks[1], /^two /);
  assert.match(first.unstableText, /^three /);
  assert.equal(first.parseUnstable, true);

  const second = resolveStreamingMarkdownChunks(
    `${firstText}\n\n${paragraph("four")}`,
    true,
    cache,
  );
  assert.equal(second.stableChunks[0], first.stableChunks[0]);
  assert.equal(second.stableChunks.length, 3);
  assert.doesNotMatch(second.unstableText, /^one /);
  assert.equal(second.parseUnstable, true);

  const settled = resolveStreamingMarkdownChunks(
    `${firstText}\n\n${paragraph("four")}`,
    false,
    cache,
  );
  assert.equal(settled.stableChunks, second.stableChunks,
    "settlement must retain memoized parsed blocks instead of reparsing the full response");
  assert.equal(settled.parseUnstable, true);

  const regressed = resolveStreamingMarkdownChunks("replacement", true, cache);
  assert.equal(regressed.stableChunks.length, 0);
  assert.equal(regressed.unstableText, "replacement");
  assert.equal(regressed.parseUnstable, true);
});

test("desktop streaming Markdown stops parsing an unbounded mutable tail", () => {
  const cache = createStreamingMarkdownCache();
  const openFence = `\`\`\`text\n${"unclosed output\n".repeat(
    Math.ceil(MAX_STREAMING_UNSTABLE_MARKDOWN_CHARS / 12),
  )}`;
  const streaming = resolveStreamingMarkdownChunks(openFence, true, cache);
  assert.equal(streaming.stableChunks.length, 0);
  assert.ok(streaming.unstableText.length > MAX_STREAMING_UNSTABLE_MARKDOWN_CHARS);
  assert.equal(streaming.parseUnstable, false,
    "a growing boundary-free tail must render as plain text instead of repeatedly running GFM");

  const settled = resolveStreamingMarkdownChunks(`${openFence}\n\`\`\``, false, cache);
  assert.equal(settled.parseUnstable, true,
    "the completed response should receive its final Markdown parse");
});

test("desktop streaming Markdown scans only newly appended complete lines", () => {
  const cache = createStreamingMarkdownCache();
  const openFence = `\`\`\`text\n${"unclosed output\n".repeat(1_000)}`;
  resolveStreamingMarkdownChunks(openFence, true, cache);
  const scannedBeforeAppend = cache.scannedCharacters;
  const appended = `${openFence}one new line\n`;
  resolveStreamingMarkdownChunks(appended, true, cache);
  assert.equal(
    cache.scannedCharacters - scannedBeforeAppend,
    "one new line\n".length,
    "an append-only stream must not rescan the accumulated open code fence",
  );
});

test("desktop Markdown bypasses GFM only for safe literal single lines", () => {
  assert.equal(isPlainTextMarkdown("A literal response."), true);
  assert.equal(isPlainTextMarkdown("two\nlines"), false);
  assert.equal(isPlainTextMarkdown("**strong**"), false);
  assert.equal(isPlainTextMarkdown("https://example.com"), false);
  assert.equal(isPlainTextMarkdown("fish & chips"), false);
});

test("desktop hot paths avoid synchronous process and filesystem work", async () => {
  const [conversation, turnReview, snapshotStore, shellRuntime, atomicFile, engineHost, main] =
    await Promise.all([
      readFile(new URL("../renderer/Conversation.tsx", import.meta.url), "utf8"),
      readFile(new URL("../renderer/TurnReview.tsx", import.meta.url), "utf8"),
      readFile(new URL("../renderer/desktop-snapshot-store.ts", import.meta.url), "utf8"),
      readFile(new URL("../../../../src/runtime/agent/orchestrator/tools/builtin/shell-runtime.mjs", import.meta.url), "utf8"),
      readFile(new URL("../../../../src/runtime/shared/atomic-file.mjs", import.meta.url), "utf8"),
      readFile(new URL("./engine-host.ts", import.meta.url), "utf8"),
      readFile(new URL("./index.ts", import.meta.url), "utf8"),
    ]);
  assert.match(conversation, /<TurnReviewBar items=\{settledItems\}/);
  assert.match(turnReview, /export const TurnReviewBar = memo\(function TurnReviewBar/);
  assert.doesNotMatch(snapshotStore, /JSON\.stringify/);
  assert.doesNotMatch(shellRuntime, /\bspawnSync\s*\(/);
  const asyncUpdate = atomicFile.slice(atomicFile.indexOf("export async function updateJsonAtomic"));
  assert.doesNotMatch(asyncUpdate, /\breadFileSync\s*\(|\bwriteJsonAtomicSync\s*\(/);
  assert.match(asyncUpdate, /await readFileAsync\(/);
  assert.match(asyncUpdate, /await writeJsonAtomicAsync\(/);
  assert.doesNotMatch(engineHost, /appendFileSync/);
  assert.doesNotMatch(main, /appendFileSync/);
  assert.match(main, /const installed = \[wrap\('spawnSync'\), wrap\('execSync'\), wrap\('execFileSync'\)\]\.some\(Boolean\)/);
  assert.match(main, /\}\)\(\)\.catch\(\(error\) => \{/,
    "optional sync-spawn diagnostics must never become an unhandled startup rejection");
});

test("heavy renderer surfaces remain dynamic imports", async () => {
  const [
    source,
    conversation,
    dock,
    notifications,
    warmup,
    main,
    lazyWidgets,
    rendererEntry,
    monacoSetup,
    viteConfig,
    snapshotViews,
    rendererRecovery,
    paneWorkspaceState,
    desktopBackend,
    studioLoader,
    sessionSidebar,
    sourceControl,
  ] = await Promise.all([
    readFile(new URL("../renderer/App.tsx", import.meta.url), "utf8"),
    readFile(new URL("../renderer/Conversation.tsx", import.meta.url), "utf8"),
    readFile(new URL("../renderer/UtilityDock.tsx", import.meta.url), "utf8"),
    readFile(new URL("../renderer/notifications.tsx", import.meta.url), "utf8"),
    readFile(new URL("../renderer/app-idle-warmup.ts", import.meta.url), "utf8"),
    readFile(new URL("./index.ts", import.meta.url), "utf8"),
    readFile(new URL("../renderer/lazy-widgets.ts", import.meta.url), "utf8"),
    readFile(new URL("../renderer/main.tsx", import.meta.url), "utf8"),
    readFile(new URL("../renderer/monaco-setup.ts", import.meta.url), "utf8"),
    readFile(new URL("../../electron.vite.config.ts", import.meta.url), "utf8"),
    readFile(new URL("../renderer/app-snapshot-views.tsx", import.meta.url), "utf8"),
    readFile(new URL("../renderer/RendererRecovery.tsx", import.meta.url), "utf8"),
    readFile(new URL("../renderer/pane-workspace-state.ts", import.meta.url), "utf8"),
    readFile(new URL("./desktop-backend.ts", import.meta.url), "utf8"),
    readFile(new URL("../renderer/studio-loader.ts", import.meta.url), "utf8"),
    readFile(new URL("../renderer/session-sidebar.tsx", import.meta.url), "utf8"),
    readFile(new URL("../renderer/SourceControlDock.tsx", import.meta.url), "utf8"),
  ]);
  for (const modulePath of [
    "./settings/SettingsView",
    "./settings/OnboardingWizard",
    "./CommandSurface",
    "./SchedulesView",
    "./WebhooksView",
    "./ProjectsView",
    "./WorkflowsView",
  ]) {
    assert.match(source, new RegExp(`import\\(["']${modulePath.replaceAll(".", "\\.")}["']\\)`));
  }
  assert.match(studioLoader, /import\(["']\.\/StudioView["']\)/);
  assert.match(lazyWidgets, /import\(["']\.\/DiffView\.lazy["']\)/);
  assert.doesNotMatch(source, /\.preloadSettings\(/,
    "startup may warm the settings chunk but must not hydrate engine capabilities");
  assert.doesNotMatch(source, /schedulePostInteractionIdle\(\(\) => setSettingsMounted\(true\)\)/,
    "startup must not mount the hidden settings tree and trigger its data effects");
  for (const startupSource of [source, conversation, dock, notifications]) {
    assert.doesNotMatch(startupSource, /^import .* from ["']\.\/CommandSurface["'];?$/m,
      "startup-loaded renderer modules must not pull the full command surface into the entry chunk");
  }
  assert.match(source,
    /\{dockOpen && <SnapshotUtilityDock[\s\S]*?contentReady/,
    "the Dock body must mount only while the panel is visible");
  assert.doesNotMatch(source, /dockContentReady|setDockContentReady/,
    "closed Dock content must not prewarm or retain a hidden renderer tree");
  assert.doesNotMatch(source, /\{dockRender && !fullPagePane && <SnapshotUtilityDock/);
  assert.match(lazyWidgets, /const importTerminalPane = \(\) => import\(["']\.\/TerminalPane["']\)/,
    "standalone terminal tabs must remain a dynamic chunk");
  assert.doesNotMatch(dock, /^import .* from ["']\.\/TerminalPane["'];?$/m,
    "the hidden Dock must not pull the standalone terminal into startup");
  assert.match(sourceControl, /const SCM_FILE_ROW_HEIGHT = 29;/);
  assert.match(sourceControl, /const fileWindow = useRowWindow\(/);
  assert.match(sourceControl, /filteredFiles\.slice\(fileWindow\.start, fileWindow\.end\)/,
    "Source Control must not mount every off-viewport change row");
  assert.doesNotMatch(sourceControl, /StableContentSwap/,
    "Source Control view changes must release the outgoing renderer tree");
  assert.match(snapshotViews,
    /return <UtilityDock \{\.\.\.props\} snapshot=\{hidden \? EMPTY_SNAPSHOT : selectedSnapshot\} \/>;/,
    "a hidden Dock must detach from live transcript snapshots");
  assert.doesNotMatch(conversation, /transcriptOverscan|setTranscriptOverscan|prewarmRange|resizeItem\(/,
    "no delayed task may mutate transcript geometry after entry");
  assert.match(warmup, /addEventListener\("pointerdown", postpone\)/);
  assert.doesNotMatch(warmup, /addEventListener\("pointerdown", queueIdle, \{ once: true \}\)/);
  assert.doesNotMatch(warmup, /import\("\.\/DiffView\.lazy"\)/,
    "the empty boot window must not evaluate the 1.7MB Diff surface");
  assert.match(warmup, /export function scheduleRendererWarmups/);
  assert.match(warmup, /preloadMarkdownBody\(\)/);
  assert.doesNotMatch(warmup, /prefetchEditorPane|prefetchTerminalPane|prefetchDiffView/,
    "idle chat must not permanently retain optional workbench modules");
  assert.match(lazyWidgets, /export function prefetchEditorPane\(\): Promise<unknown>/,
    "the Monaco chunk needs an independently schedulable prefetch");
  assert.match(lazyWidgets, /export function prefetchDiffView\(\): Promise<unknown>/,
    "the largest optional chunk needs its own session-driven prefetch");
  const sessionWidgetWarmup = lazyWidgets.slice(lazyWidgets.indexOf("export function prefetchLazyWidgets"));
  assert.match(sessionWidgetWarmup, /prefetchDiffView\(\)/);
  assert.doesNotMatch(sessionWidgetWarmup, /prefetchEditorPane|prefetchTerminalPane/,
    "session resume must warm transcript diff only, never Monaco or xterm");
  assert.match(source, /const openFileTab[\s\S]*?prefetchEditorPane\(\)/,
    "file navigation should start Monaco import on explicit intent");
  assert.match(source, /const openTerminalTab[\s\S]*?prefetchTerminalPane\(\)/,
    "terminal navigation should start xterm import on explicit intent");
  assert.match(rendererEntry, /import "monaco-editor\/min\/vs\/editor\/editor\.main\.css";/,
    "Monaco structural CSS must load with the renderer shell");
  assert.doesNotMatch(monacoSetup, /editor\.main\.css/,
    "the lazy Monaco module must not inject structural CSS after editor DOM");
  assert.match(viteConfig, /optimizeDeps:\s*\{[\s\S]*?['"]@monaco-editor\/react['"][\s\S]*?['"]monaco-editor['"]/,
    "Vite must pre-optimize dynamically discovered Monaco dependencies");
  assert.match(snapshotViews, /import .*PaneSurfaceCover|<PaneSurfaceCover/,
    "cold restored panes must keep transcript hydration behind an opaque stable cover");
  assert.match(source, /const EDITOR_COVER_MAX_MS = 900;/,
    "a stalled Monaco import must not leave Loading editor visible indefinitely");
  assert.match(source, /const markdownReady = preloadMarkdownBody\(\)[\s\S]*?prefetchLazyWidgets\(\);/,
    "Diff prewarm should run only with a real session resume");
  assert.match(main, /window\.__mixdogWindowShown = true;[\s\S]*?mixdog:window-shown/);
  assert.match(main, /DESKTOP_WINDOW_SHOW_DEADLINE_MS = 3_000/);
  assert.match(main, /showWhenComposed\(true, 'absolute-deadline'\)/);
  assert.match(main, /const postpone = \(\) => \{ if \(!started\) schedule\(2_000\); \};/);
  assert.match(main, /diagnostics\?\.write\('renderer-ready'/);
  assert.match(main, /diagnostics\?\.write\('window-shown'/);
  assert.doesNotMatch(conversation, /new PerformanceObserver/);
  assert.match(rendererRecovery, /new PerformanceObserver/);
  assert.doesNotMatch(rendererEntry, /\bStrictMode\b/,
    "the development renderer must not double-mount the full workbench");
  assert.match(rendererEntry, /document\.fonts\.load\([^)]*JetBrains Mono/,
    "restored editor and terminal surfaces must settle their mono face behind the boot cover");
  assert.match(rendererEntry, /window\.setTimeout\(resolve, 300\)/);
  assert.match(rendererEntry, /mixdog:react-committed/);
  assert.doesNotMatch(rendererEntry, /requestAnimationFrame\(\(\) => requestAnimationFrame/);
  assert.doesNotMatch(rendererEntry, /startup-settled[\s\S]*?rendererReady/,
    "session restoration must not block the first visible frame");
  assert.match(paneWorkspaceState, /return useMemo\(\(\) => \(\{/,
    "unrelated App state must retain the pane workspace object identity");
  assert.match(source,
    /<DeferredPersistentSurface\s+active=\{utilityActive \|\| activatedUtilitySurfaceKeys\.current\.has\(key\)\}[\s\S]*?startupDelayMs=\{startupDelayMs\}/,
    "restored utility panes must stage heavy chunks after the first shown frame");
  assert.match(source,
    /<DeferredPersistentSurface active=\{fileActive\}[\s\S]*?startupDelayMs=\{EDITOR_STARTUP_DELAY_MS\}/,
    "restored Monaco panes must stage their first mount after the first shown frame");
  assert.doesNotMatch(source,
    /if \(openPaneFileKeys\.length\) void prefetchEditorPane\(\)/,
    "restored file tabs must not evaluate Monaco while the launch window is hidden");
  assert.match(sessionSidebar, /const RECENT_SESSION_INITIAL_ROWS = 24;/);
  assert.match(sessionSidebar,
    /const visibleRecentRows = rows\.slice\(0, recentRowLimit\);/);
  assert.doesNotMatch(sessionSidebar, /SessionSidebarBootShell|sidebarChromeReady|recentStartupReady/);
  assert.doesNotMatch(sessionSidebar, /\{rows\.map\(\(session\) => <SessionSidebarRow/,
    "the cold sidebar must not construct every historical session row");
  assert.match(desktopBackend, /stateMailbox\.publish\(host\.getSnapshot\(\)\)/,
    "the daemon backend should publish lightweight state before pane requests");
  assert.doesNotMatch(desktopBackend, /host\.listSessions\(\)/,
    "daemon backend startup must not enumerate the session catalog before pane requests");
});

test("cold desktop entry keeps optional native and network modules outside its graph", async () => {
  const [entry, terminal, updater, host, hostSupport, desktopBackend] = await Promise.all([
    readFile(new URL("./index.ts", import.meta.url), "utf8"),
    readFile(new URL("./terminal-manager.ts", import.meta.url), "utf8"),
    readFile(new URL("./updater.ts", import.meta.url), "utf8"),
    readFile(new URL("./engine-host.ts", import.meta.url), "utf8"),
    readFile(new URL("./engine-host-support.ts", import.meta.url), "utf8"),
    readFile(new URL("./desktop-backend.ts", import.meta.url), "utf8"),
  ]);
  assert.doesNotMatch(entry,
    /from ['"]\.\/remote-(?:bridge|relay)['"]|import\(['"]\.\/remote-(?:bridge|relay)['"]\)/,
    "Electron main must not load backend-owned remote services");
  assert.match(desktopBackend, /from ['"]\.\/remote-bridge['"]/);
  assert.match(desktopBackend, /from ['"]\.\/remote-relay['"]/);
  assert.doesNotMatch(terminal, /^import \{[^}]*spawn[^}]*\} from ['"]@homebridge\/node-pty/m);
  assert.match(terminal, /import\(['"]@homebridge\/node-pty-prebuilt-multiarch['"]\)/);
  assert.doesNotMatch(updater, /^import electronUpdater from ['"]electron-updater['"];?$/m);
  assert.match(updater, /import\(['"]electron-updater['"]\)/);
  assert.match(hostSupport, /session\/store-summary-reader\.mjs/);
  assert.doesNotMatch(host, /scheduleDefaultEnginePrewarm|enginePrewarmPromise/,
    "cold sidebar listing must not enqueue background runtime work");
});
