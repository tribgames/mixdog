// Isolated daemon projection microbenchmark; no live daemon or provider.
// Run before/after a change: node --expose-gc scripts/session-projection-bench.mjs
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';

const root = mkdtempSync(join(tmpdir(), 'mixdog-projection-bench-'));
process.env.MIXDOG_RUNTIME_ROOT = root;
process.env.MIXDOG_DATA_DIR = root;
const { createSessionService } = await import('../src/standalone/session-service.mjs');

for (const itemCount of [200, 2_000, 20_000]) {
  let state = {
    sessionId: 'projection_bench',
    busy: false,
    items: Array.from({ length: itemCount }, (_, id) => ({
      id, kind: 'assistant', text: `message ${id} ${'x'.repeat(400)}`,
    })),
    queued: [{ id: 'next', text: 'next prompt', submittedAt: 1 }],
    streamingTail: { id: 'live', kind: 'assistant', text: '' },
  };
  const service = createSessionService({
    createSessionRuntime: async () => ({
      getState: () => state,
      subscribe: () => () => {},
      dispose: async () => {},
    }),
  });
  try {
    await service.handleCall('session.create', { sessionId: state.sessionId }, {
      clientToken: 'projection-bench',
    });
    const samples = [];
    for (let sample = 0; sample < 4; sample += 1) {
      globalThis.gc?.();
      const histories = new WeakSet();
      let historyArrays = 0;
      const started = performance.now();
      const cpu = process.cpuUsage();
      for (let tick = 0; tick < 500; tick += 1) {
        state = {
          ...state,
          streamingTail: { ...state.streamingTail, text: `token ${sample}:${tick}` },
        };
        const result = await service.handleCall('session.read', {
          sessionId: state.sessionId,
        });
        if (!histories.has(result.full.items)) {
          histories.add(result.full.items);
          historyArrays += 1;
        }
      }
      const used = process.cpuUsage(cpu);
      if (sample > 0) samples.push({
        wallMs: +(performance.now() - started).toFixed(2),
        cpuMs: +((used.user + used.system) / 1_000).toFixed(2),
        historyArrays,
      });
    }
    samples.sort((a, b) => a.wallMs - b.wallMs);
    console.log(JSON.stringify({ itemCount, updates: 500, median: samples[1], samples }));
  } finally {
    await service.stop('projection benchmark complete');
  }
}
