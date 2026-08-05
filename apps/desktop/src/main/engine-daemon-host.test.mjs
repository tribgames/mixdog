// Desktop over the machine-global engine daemon: EngineHost keeps all of its
// pooling/projection logic and only swaps its engine FACTORY for the daemon
// proxy. This test drives a real EngineHost against a real transport with a
// stub engine, so the desktop lane never has to boot a provider to prove that
// a terminal-side mutation reaches the desktop projection.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const RUNTIME_ROOT = mkdtempSync(join(tmpdir(), "mixdog-desktop-engine-daemon-"));
process.env.MIXDOG_RUNTIME_ROOT = RUNTIME_ROOT;
process.env.MIXDOG_DATA_DIR = RUNTIME_ROOT;

const { EngineHost } = await import("./engine-host");
const { createEngineDaemonTransport } = await import("../../../../src/standalone/engine-daemon-transport.mjs");
const { createEngineDaemonService } = await import("../../../../src/standalone/engine-daemon-service.mjs");
const { attachEngineDaemon, createRemoteEngineSession } = await import("../../../../src/standalone/engine-daemon-client.mjs");

function createStubEngine(knownSessions = []) {
  let state = { sessionId: "daemon-session", items: [], busy: false, cwd: RUNTIME_ROOT };
  const listeners = new Set();
  const publish = () => { for (const listener of [...listeners]) listener(); };
  // A real store lists every persisted session, not just the loaded one.
  const known = new Set(["daemon-session", ...knownSessions]);
  return {
    getState: () => state,
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    listSessions: () => [...known].map((id, index) => ({
      id, title: `Session ${id}`, updatedAt: index + 1, cwd: RUNTIME_ROOT, classification: "task",
    })),
    registerSession(id) { known.add(String(id)); return true; },
    async resume(id) {
      known.add(String(id));
      state = { ...state, sessionId: String(id), items: [{ id: "resumed", kind: "user", text: `resumed ${id}` }] };
      publish();
      return true;
    },
    async newSession() {
      state = { ...state, sessionId: "", items: [] };
      publish();
      return true;
    },
    async switchContext() { return true; },
    submit(prompt) {
      const text = typeof prompt === "string"
        ? prompt
        : (Array.isArray(prompt) ? prompt : [prompt])
          .map((part) => String(part?.text ?? ""))
          .join("");
      state = { ...state, items: [...state.items, { id: `item-${state.items.length + 1}`, kind: "user", text }] };
      publish();
      return true;
    },
    abort() { state = { ...state, busy: false }; publish(); return true; },
    async dispose() { state = { ...state, disposed: true }; publish(); },
  };
}

async function withDaemon(run, { knownSessions = [] } = {}) {
  const service = createEngineDaemonService({
    createEngine: async () => createStubEngine(knownSessions),
    publishIntervalMs: 5,
    onFrame: (frame) => transport.broadcast(frame),
  });
  const transport = createEngineDaemonTransport({
    handleCall: (name, args) => service.handleCall(name, args),
    discoveryPath: join(RUNTIME_ROOT, "engine-daemon.json"),
    clientGraceMs: 10_000,
    sweepMs: 1_000,
  });
  const { port, token } = await transport.start();
  const discovery = { pid: process.pid, port, token };
  writeFileSync(join(RUNTIME_ROOT, "engine-daemon.json"), JSON.stringify(discovery));
  try {
    await run({ discovery, service });
  } finally {
    await service.stop("test end");
    await transport.stop();
  }
}

function waitFor(predicate, message, timeoutMs = 4000) {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const tick = () => {
      let value;
      try { value = predicate(); } catch (error) { reject(error); return; }
      if (value) { resolve(value); return; }
      if (Date.now() - started > timeoutMs) { reject(new Error(`timeout: ${message}`)); return; }
      setTimeout(tick, 10).unref?.();
    };
    tick();
  });
}

test("the desktop host projects a daemon-hosted engine and shares it with a terminal view", async () => {
  await withDaemon(async ({ discovery }) => {
    const host = new EngineHost({
      userDataPath: RUNTIME_ROOT,
      createEngine: async (options) => createRemoteEngineSession(options),
      loadSessionStore: async () => ({ listStoredSessionSummaries: () => [] }),
    });
    const terminalFrames = [];
    // The daemon streams DELTAS against the revision each view holds, so a
    // terminal view mirrors frames exactly like the real client does.
    const terminalState = { snapshot: null };
    const foldFrame = (frame) => {
      if (frame?.type !== "engine-state") return;
      if (frame.full !== undefined && frame.full !== null) { terminalState.snapshot = frame.full; return; }
      if (!frame.patch) return;
      const base = terminalState.snapshot || {};
      const next = { ...base, ...(frame.patch.set || {}) };
      if (frame.patch.itemsAppend) {
        next.items = (Array.isArray(base.items) ? base.items : [])
          .slice(0, frame.patch.itemsAppend.from)
          .concat(frame.patch.itemsAppend.values || []);
      }
      for (const key of frame.patch.remove || []) delete next[key];
      terminalState.snapshot = next;
    };
    const terminal = await attachEngineDaemon({
      discovery,
      cwd: RUNTIME_ROOT,
      onFrame: (frame) => { terminalFrames.push(frame); foldFrame(frame); },
    });
    try {
      const snapshot = await host.startTask();
      assert.equal(snapshot.sessionId, "daemon-session", "desktop projects the daemon engine's session");

      // Desktop submit -> the terminal view observes the same transcript.
      await host.submit([{ type: "text", text: "hello from desktop" }]);
      const mirrored = await waitFor(
        () => (terminalState.snapshot?.items?.length === 1 ? terminalState.snapshot : null),
        "terminal view observes the desktop submission",
      );
      assert.equal(mirrored.items[0].text, "hello from desktop");

      // Terminal submit -> the desktop projection follows without a resume.
      const engineId = terminalFrames.find((frame) => frame.type === "engine-state")?.engineId;
      assert.ok(engineId, "the terminal view learned the engine id from the shared stream");
      await terminal.call("engine.call", {
        engineId, method: "submit", args: ["hello from terminal"],
      });
      await waitFor(
        () => (host.getSnapshot()?.items?.length ?? 0) === 2,
        "desktop projection follows the terminal submission",
      );
      assert.equal(host.getSnapshot().items.at(-1).text, "hello from terminal");
    } finally {
      await terminal.close("test");
      await host.dispose();
    }
  });
});

test("switching sessions and coming back leaves the composer usable", async () => {
  await withDaemon(async () => {
    const rows = [
      { id: "session-one", title: "One", updatedAt: 2, cwd: RUNTIME_ROOT, classification: "task" },
      { id: "session-two", title: "Two", updatedAt: 1, cwd: RUNTIME_ROOT, classification: "task" },
    ];
    const host = new EngineHost({
      userDataPath: RUNTIME_ROOT,
      createEngine: async (options) => createRemoteEngineSession(options),
      loadSessionStore: async () => ({ listStoredSessionSummaries: () => rows }),
    });
    try {
      await host.startTask();
      const first = await host.resumeSession("session-one");
      assert.equal(first.sessionId, "session-one", "the first session resumes into the desktop projection");
      const second = await host.resumeSession("session-two");
      assert.equal(second.sessionId, "session-two", "switching sessions follows the second session");
      // The reported regression: coming BACK to a session left the surface
      // unusable (busy/commandBusy stuck, submit refused).
      const back = await host.resumeSession("session-one");
      assert.equal(back.sessionId, "session-one", "returning to the first session projects it again");
      assert.notEqual(back.busy, true, "a resumed session is not stuck busy");
      assert.notEqual(back.commandBusy, true, "a resumed session does not hold the command lock");
      assert.equal(await host.submit([{ type: "text", text: "still typable" }]), true,
        "the composer can still submit after switching away and back");
      // The synchronous store surface accepts the submit and the engine's own
      // frame carries the transcript a beat later, exactly like in-process.
      await waitFor(() => host.getSnapshot().items.at(-1)?.text === "still typable",
        "the submitted message lands in the desktop projection");
    } finally {
      await host.dispose();
    }
  }, { knownSessions: ["session-one", "session-two"] });
});

test("a pane prompt for a session no local view holds goes to the daemon", async () => {
  await withDaemon(async ({ service }) => {
    const rows = [{
      id: "pane-session", title: "Pane", updatedAt: 1, cwd: RUNTIME_ROOT,
      classification: "task", desktopSession: { classification: "task", projectPath: null },
    }];
    const host = new EngineHost({
      userDataPath: RUNTIME_ROOT,
      // Resolves the daemon client module exactly like the packaged app does.
      appPath: join(import.meta.dirname, "..", ".."),
      createEngine: async (options) => createRemoteEngineSession(options),
      loadSessionStore: async () => ({ listStoredSessionSummaries: () => rows }),
    });
    const updates = [];
    const unsubscribe = host.subscribeSessionStates((update) => updates.push(update));
    try {
      await host.startTask();
      assert.equal(host.getSnapshot().sessionId, "daemon-session");
      // The pane's session has NO local engine — settled views are released and
      // a restarted app has none at all. Pre-daemon this threw "Session engine
      // is not live." and the composer restored the draft (user: 채팅이 안 쳐짐).
      assert.equal(
        await host.submitToSession("pane-session", [{ type: "text", text: "from a background pane" }]),
        true,
        "a pane addressed at the backend is always heard",
      );
      const owner = service.list().engines.find((entry) => entry.sessionId === "pane-session");
      assert.ok(owner, "the daemon loaded the pane's session");
      const hosted = await service.handleCall("engine.snapshot", { engineId: owner.engineId });
      assert.equal(hosted.snapshot.items.at(-1).text, "from a background pane");
      // The pane also gets a live lane, so it streams the answer it asked for.
      await waitFor(() => updates.some((update) => update.sessionId === "pane-session"),
        "the pane receives a live lane frame for the daemon-hosted session");
      // …and another pane's prompt never moves the active view.
      assert.equal(host.getSnapshot().sessionId, "daemon-session",
        "a background pane's submit leaves the focused session alone");
    } finally {
      unsubscribe();
      await host.dispose();
    }
  }, { knownSessions: ["pane-session"] });
});
