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

function createStubEngine() {
  let state = { sessionId: "daemon-session", items: [], busy: false, cwd: RUNTIME_ROOT };
  const listeners = new Set();
  const publish = () => { for (const listener of [...listeners]) listener(); };
  return {
    getState: () => state,
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    listSessions: () => [{ id: state.sessionId, title: "Daemon session", updatedAt: 1 }],
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

async function withDaemon(run) {
  const service = createEngineDaemonService({
    createEngine: async () => createStubEngine(),
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
    const terminal = await attachEngineDaemon({
      discovery, cwd: RUNTIME_ROOT, onFrame: (frame) => terminalFrames.push(frame),
    });
    try {
      const snapshot = await host.startTask();
      assert.equal(snapshot.sessionId, "daemon-session", "desktop projects the daemon engine's session");

      // Desktop submit -> the terminal view observes the same transcript.
      await host.submit([{ type: "text", text: "hello from desktop" }]);
      const mirrored = await waitFor(
        () => terminalFrames.filter((frame) => frame.type === "engine-state")
          .map((frame) => frame.snapshot)
          .find((state) => state?.items?.length === 1),
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
