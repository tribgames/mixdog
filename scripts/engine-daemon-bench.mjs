// Where does the engine daemon spend time? Measures the two costs a view pays
// that an in-process store does not: per-call round trip and per-frame fan-out,
// against transcripts of growing size (the snapshot is the payload).
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';

const ROOT = mkdtempSync(join(tmpdir(), 'mixdog-engine-daemon-bench-'));
process.env.MIXDOG_RUNTIME_ROOT = ROOT;
process.env.MIXDOG_DATA_DIR = ROOT;
// Daemon attach is the DEFAULT for real surfaces; this bench drives the
// transport directly, so the seam stays in-process here.
process.env.MIXDOG_ENGINE_DAEMON = '0';

const { createEngineDaemonTransport } = await import('../src/standalone/engine-daemon-transport.mjs');
const { createEngineDaemonService } = await import('../src/standalone/engine-daemon-service.mjs');
const { attachEngineDaemon, createRemoteEngineSession } = await import('../src/standalone/engine-daemon-client.mjs');

const ITEM_TEXT = 'x'.repeat(400);

function createBenchEngine(itemCount) {
  let state = {
    sessionId: 'bench',
    busy: false,
    items: Array.from({ length: itemCount }, (_, index) => ({
      id: `item-${index}`, kind: index % 2 ? 'assistant' : 'user', text: ITEM_TEXT,
    })),
  };
  const listeners = new Set();
  let storeScans = 0;
  return {
    getState: () => state,
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    listSessions() {
      storeScans += 1;
      return [{ id: 'bench', title: 'Bench', updatedAt: 1 }];
    },
    get storeScans() { return storeScans; },
    ping() { return true; },
    append() {
      state = { ...state, items: [...state.items, { id: `item-${state.items.length}`, kind: 'assistant', text: ITEM_TEXT }] };
      for (const listener of [...listeners]) listener();
      return true;
    },
    async dispose() {},
  };
}

function percentile(values, fraction) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))];
}

async function benchmark(itemCount) {
  let engineRef = null;
  let frames = 0;
  let firstFrameBytes = 0;
  let deltaFrameBytes = 0;
  let deltaFrames = 0;
  const service = createEngineDaemonService({
    createEngine: async () => (engineRef = createBenchEngine(itemCount)),
    publishIntervalMs: 50,
    onFrame: (frame) => {
      frames += 1;
      const bytes = JSON.stringify(frame).length;
      if (frame.full !== undefined) firstFrameBytes = bytes;
      else { deltaFrames += 1; deltaFrameBytes += bytes; }
      transport.broadcast(frame);
    },
  });
  const transport = createEngineDaemonTransport({
    handleCall: (name, args) => service.handleCall(name, args),
    discoveryPath: join(ROOT, 'engine-daemon.json'),
  });
  const { port, token } = await transport.start();
  const discovery = { pid: process.pid, port, token };
  writeFileSync(join(ROOT, 'engine-daemon.json'), JSON.stringify(discovery));
  let received = 0;
  let view = null;
  const client = await attachEngineDaemon({
    discovery, cwd: process.cwd(), onFrame: () => { received += 1; },
  });
  try {
    // The product path is the VIEW proxy: it tracks revisions, so responses can
    // stay deltas instead of full snapshots.
    view = await createRemoteEngineSession({ cwd: process.cwd() });
    const scansAfterOpen = engineRef.storeScans;

    const latencies = [];
    for (let index = 0; index < 60; index += 1) {
      const started = performance.now();
      await view.ping();
      latencies.push(performance.now() - started);
    }
    const scansAfterCalls = engineRef.storeScans - scansAfterOpen;

    const streamStarted = performance.now();
    for (let index = 0; index < 200; index += 1) engineRef.append();
    await new Promise((resolve) => setTimeout(resolve, 400));
    const streamMs = performance.now() - streamStarted;

    console.log(
      `items=${String(itemCount).padStart(5)}  call p50=${percentile(latencies, 0.5).toFixed(1)}ms `
      + `p95=${percentile(latencies, 0.95).toFixed(1)}ms  store-scans/60-calls=${scansAfterCalls}  `
      + `full-frame=${firstFrameBytes}B delta-frames=${deltaFrames} `
      + `bytes/delta=${deltaFrames ? Math.round(deltaFrameBytes / deltaFrames) : 0} `
      + `stream200=${streamMs.toFixed(0)}ms received=${received}`,
    );
  } finally {
    if (view) { try { await view.dispose('bench end'); } catch { /* teardown */ } }
    await client.close('bench end');
    await service.stop('bench end');
    await transport.stop();
  }
}

try {
  for (const itemCount of [0, 200, 2000]) await benchmark(itemCount);
} finally {
  try { rmSync(ROOT, { recursive: true, force: true }); } catch {}
}
