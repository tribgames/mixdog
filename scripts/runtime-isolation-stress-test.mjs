import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { monitorEventLoopDelay, performance } from 'node:perf_hooks';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

const ROOT = mkdtempSync(join(tmpdir(), 'mixdog-runtime-isolation-'));
process.env.MIXDOG_CHILD_SPAWN_SEARCH_MAX_INFLIGHT = '4';
process.env.MIXDOG_CHILD_SPAWN_CODE_GRAPH_MAX_INFLIGHT = '2';

const [
  { ProviderAdmissionScheduler },
  { createStreamJsonPool },
  { acquire: acquireChildSlot, snapshot: childSpawnSnapshot },
  { createEngineDaemonTransport },
  { attachEngineDaemon, probeEngineDaemonHealth },
] = await Promise.all([
  import('../src/runtime/agent/orchestrator/providers/admission-scheduler.mjs'),
  import('../src/runtime/agent/orchestrator/providers/stream-json-pool.mjs'),
  import('../src/runtime/shared/child-spawn-gate.mjs'),
  import('../src/standalone/engine-daemon-transport.mjs'),
  import('../src/standalone/engine-daemon-client.mjs'),
]);

function percentile(values, fraction) {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))] ?? 0;
}

async function runChildTool(lane, started) {
  const release = await acquireChildSlot(null, lane);
  started.push(lane);
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 80)'], {
      windowsHide: true,
      stdio: 'ignore',
    });
    const settle = (error = null) => {
      release();
      if (error) reject(error);
      else resolve();
    };
    child.once('error', settle);
    child.once('exit', (code) => {
      if (code === 0) settle();
      else settle(new Error(`${lane} child exited ${code}`));
    });
  });
}

test('provider parser workers and child-tool lanes preserve daemon responsiveness under mixed load', async (t) => {
  const admission = new ProviderAdmissionScheduler();
  const parserPool = createStreamJsonPool({ maxWorkers: 4, minBatchBytes: 1 });
  const eventLoop = monitorEventLoopDelay({ resolution: 10 });
  eventLoop.enable();
  let transport;
  let client;
  t.after(async () => {
    eventLoop.disable();
    await client?.close('mixed isolation test').catch(() => {});
    await transport?.stop().catch(() => {});
    admission.shutdown();
    await parserPool.close('mixed isolation test');
    rmSync(ROOT, { recursive: true, force: true });
  });

  transport = createEngineDaemonTransport({
    discoveryPath: join(ROOT, 'engine-daemon.json'),
    handleCall: async (name, args) => ({
      accepted: name === 'session.submit',
      sessionId: String(args?.sessionId || ''),
    }),
    getStatus: () => ({
      workload: {
        childSpawns: childSpawnSnapshot(),
        streamParsing: parserPool.snapshot(),
      },
    }),
  });
  const { port, token } = await transport.start();
  client = await attachEngineDaemon({
    discovery: { pid: process.pid, port, token },
    cwd: ROOT,
  });

  const providerStarted = [];
  const payload = JSON.stringify({ text: 'x'.repeat(512 * 1024) });
  const providerWork = Array.from({ length: 32 }, (_, index) => {
    const sessionId = `mixed-provider-${index}`;
    const provider = ['openai', 'anthropic', 'gemini'][index % 3];
    const account = `account-${index % 8}`;
    return admission.run(`${provider}:${account}`, async () => {
      providerStarted.push(sessionId);
      const [parsed] = await parserPool.parseBatch([payload]);
      assert.equal(parsed.text.length, 512 * 1024);
    }, { ownerKey: sessionId });
  });

  const toolStarted = [];
  const toolWork = [
    ...Array.from({ length: 8 }, () => runChildTool('search', toolStarted)),
    ...Array.from({ length: 4 }, () => runChildTool('code-graph', toolStarted)),
  ];
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(providerStarted.length, 32, 'multi-account provider work starts without a global cap');
  assert.equal(toolStarted.filter((lane) => lane === 'search').length, 4);
  assert.equal(toolStarted.filter((lane) => lane === 'code-graph').length, 2);

  const controlLatencies = [];
  let probing = true;
  const controlProbe = (async () => {
    while (probing) {
      const started = performance.now();
      const health = await probeEngineDaemonHealth({ port, token, timeoutMs: 1_000 });
      assert.ok(health, 'health probe timed out during mixed provider/tool load');
      controlLatencies.push(performance.now() - started);
      await new Promise((resolve) => setTimeout(resolve, 2));
    }
  })();

  const ackLatencies = await Promise.all(Array.from({ length: 64 }, async (_, index) => {
    const started = performance.now();
    const result = await client.call('session.submit', {
      sessionId: `mixed-ack-${index}`,
      prompt: 'probe',
    }, { callId: `mixed-ack-${index}` });
    assert.equal(result.accepted, true);
    return performance.now() - started;
  }));
  await Promise.all([...providerWork, ...toolWork]);
  probing = false;
  await controlProbe;

  const ackP95 = percentile(ackLatencies, 0.95);
  const controlP95 = percentile(controlLatencies, 0.95);
  const eventLoopP95 = eventLoop.percentile(95) / 1e6;
  assert.ok(ackP95 < 500, `mixed-load ACK p95 ${ackP95.toFixed(1)}ms exceeded 500ms`);
  assert.ok(controlP95 < 500, `mixed-load control p95 ${controlP95.toFixed(1)}ms exceeded 500ms`);
  assert.ok(eventLoopP95 < 200, `mixed-load event-loop p95 ${eventLoopP95.toFixed(1)}ms exceeded 200ms`);
  assert.equal(parserPool.snapshot().ownerAffinities, 32);
  assert.ok(controlLatencies.length > 0);
  t.diagnostic(
    `providers=32 tools=12 ackP95=${ackP95.toFixed(1)}ms `
    + `controlP95=${controlP95.toFixed(1)}ms eventLoopP95=${eventLoopP95.toFixed(1)}ms`,
  );
});
