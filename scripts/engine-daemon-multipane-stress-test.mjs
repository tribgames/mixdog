// Free 64-pane stress regression: real daemon HTTP/SSE transport, stub engines.
// No provider, model, memory daemon, or external network request is involved.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { monitorEventLoopDelay, performance } from 'node:perf_hooks';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const PANE_COUNT = 64;
const STREAM_STEPS = 8;
const ACK_P95_LIMIT_MS = 1_500;
const FIRST_TOKEN_P95_LIMIT_MS = 1_500;
const COMPLETION_LIMIT_MS = 5_000;
const EVENT_LOOP_P95_LIMIT_MS = 100;
const CONTROL_P95_LIMIT_MS = 100;
const RSS_GROWTH_LIMIT_MB = 128;

const ROOT = mkdtempSync(join(tmpdir(), 'mixdog-engine-multipane-stress-'));
process.env.MIXDOG_RUNTIME_ROOT = ROOT;
process.env.MIXDOG_DATA_DIR = ROOT;
process.env.MIXDOG_ENGINE_DAEMON = '0';

const { createEngineDaemonTransport } =
  await import('../src/standalone/engine-daemon-transport.mjs');
const { createEngineDaemonService } =
  await import('../src/standalone/engine-daemon-service.mjs');
const { attachEngineDaemon, probeEngineDaemonHealth } =
  await import('../src/standalone/engine-daemon-client.mjs');

function percentile(values, fraction) {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))] ?? 0;
}

function foldFrame(states, frame) {
  const sessionId = String(frame?.sessionId || '');
  if (!sessionId) return null;
  if (frame.full !== undefined && frame.full !== null) {
    states.set(sessionId, frame.full);
    return frame.full;
  }
  if (!frame.patch) return states.get(sessionId) ?? null;
  const base = states.get(sessionId) ?? {};
  const next = { ...base, ...(frame.patch.set || {}) };
  for (const key of frame.patch.remove || []) delete next[key];
  if (frame.patch.itemsAppend) {
    const items = Array.isArray(base.items) ? base.items : [];
    next.items = items
      .slice(0, Number(frame.patch.itemsAppend.from) || 0)
      .concat(frame.patch.itemsAppend.values || []);
  }
  states.set(sessionId, next);
  return next;
}

function createStreamingEngine() {
  let state = { sessionId: '', items: [], busy: false };
  let disposed = false;
  const listeners = new Set();
  const publish = () => {
    for (const listener of [...listeners]) listener();
  };
  return {
    getState: () => state,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    reserveSession(sessionId) {
      state = { ...state, sessionId: String(sessionId) };
      publish();
      return true;
    },
    submit(prompt) {
      const sessionId = state.sessionId;
      state = {
        ...state,
        busy: true,
        items: [{ id: `user:${sessionId}`, kind: 'user', text: String(prompt) }],
      };
      publish();
      let step = 0;
      const stream = () => {
        if (disposed) return;
        step += 1;
        const done = step === STREAM_STEPS;
        state = {
          ...state,
          busy: !done,
          items: [
            state.items[0],
            {
              id: `assistant:${sessionId}`,
              kind: 'assistant',
              text: done ? `done:${sessionId}` : `chunk:${sessionId}:${step}`,
            },
          ],
        };
        publish();
        if (!done) setTimeout(stream, 1).unref?.();
      };
      setTimeout(stream, 1).unref?.();
      return true;
    },
    async dispose() {
      disposed = true;
      listeners.clear();
    },
  };
}

function waitFor(predicate, message, timeoutMs = COMPLETION_LIMIT_MS) {
  return new Promise((resolve, reject) => {
    const started = performance.now();
    const tick = () => {
      try {
        const value = predicate();
        if (value) {
          resolve(value);
          return;
        }
      } catch (error) {
        reject(error);
        return;
      }
      if (performance.now() - started > timeoutMs) {
        reject(new Error(`timeout: ${message}`));
        return;
      }
      setTimeout(tick, 5);
    };
    tick();
  });
}

test('64 panes submit and stream concurrently without starvation or cross-session bleed', async (t) => {
  let transport;
  const states = new Map();
  const firstTokenAt = new Map();
  const completedAt = new Map();
  const expected = new Set(
    Array.from({ length: PANE_COUNT }, (_, index) => `stress_pane_${index + 1}`),
  );
  let waveStartedAt = 0;
  const controlLatencies = [];
  let probeRunning = true;
  let peakRss = process.memoryUsage().rss;
  const baselineRss = peakRss;
  const eventLoop = monitorEventLoopDelay({ resolution: 10 });
  eventLoop.enable();
  const rssTimer = setInterval(() => {
    peakRss = Math.max(peakRss, process.memoryUsage().rss);
  }, 5);
  rssTimer.unref?.();

  const service = createEngineDaemonService({
    createEngine: async () => createStreamingEngine(),
    publishIntervalMs: 4,
    onFrame: (frame, targetTokens) => transport.broadcast(frame, targetTokens),
  });
  transport = createEngineDaemonTransport({
    handleCall: (name, args, ctx) => service.handleCall(name, args, ctx),
    discoveryPath: join(ROOT, 'engine-daemon.json'),
  });
  const { port, token } = await transport.start();
  const discovery = { pid: process.pid, port, token };
  writeFileSync(join(ROOT, 'engine-daemon.json'), JSON.stringify(discovery));
  const client = await attachEngineDaemon({
    discovery,
    cwd: ROOT,
    onFrame(frame) {
      if (frame?.type !== 'session-state') return;
      const sessionId = String(frame.sessionId || '');
      assert.ok(expected.has(sessionId), `unexpected session frame ${sessionId}`);
      const snapshot = foldFrame(states, frame);
      if (!waveStartedAt || !snapshot || !Array.isArray(snapshot.items) || snapshot.items.length === 0) {
        return;
      }
      const assistant = snapshot.items.at(-1);
      if (assistant?.kind === 'assistant' && !firstTokenAt.has(sessionId)) {
        firstTokenAt.set(sessionId, performance.now());
      }
      if (snapshot.busy === false && assistant?.text === `done:${sessionId}`) {
        completedAt.set(sessionId, performance.now());
      }
    },
  });
  const controlProbe = (async () => {
    while (probeRunning) {
      const started = performance.now();
      const health = await probeEngineDaemonHealth({
        port,
        token,
        timeoutMs: 500,
      });
      assert.ok(health, 'control-plane health probe timed out under session load');
      controlLatencies.push(performance.now() - started);
      await new Promise((resolve) => setTimeout(resolve, 2));
    }
  })();

  try {
    const sessionIds = [...expected];
    await Promise.all(sessionIds.map((sessionId) =>
      client.call('session.create', { sessionId, cwd: ROOT }, {
        callId: `stress-create:${sessionId}`,
      })));
    assert.equal(service.size, PANE_COUNT);

    waveStartedAt = performance.now();
    const ackLatencies = await Promise.all(sessionIds.map(async (sessionId) => {
      const started = performance.now();
      const result = await client.call('session.submit', {
        sessionId,
        prompt: `prompt:${sessionId}`,
        options: { id: `stress-submit:${sessionId}` },
      }, {
        callId: `stress-submit:${sessionId}`,
      });
      assert.equal(result.accepted, true);
      return performance.now() - started;
    }));
    const allCompletedAt = await waitFor(
      () => completedAt.size === PANE_COUNT ? performance.now() : 0,
      `${PANE_COUNT} pane streams complete`,
    );
    probeRunning = false;
    await controlProbe;

    for (const sessionId of sessionIds) {
      const snapshot = states.get(sessionId);
      assert.ok(snapshot, `missing final snapshot for ${sessionId}`);
      assert.deepEqual(
        snapshot.items.map((item) => item.text),
        [`prompt:${sessionId}`, `done:${sessionId}`],
        `session ${sessionId} contains only its own transcript`,
      );
      assert.ok(firstTokenAt.has(sessionId), `session ${sessionId} was starved before first token`);
      assert.ok(completedAt.has(sessionId), `session ${sessionId} was starved before completion`);
    }

    const ackP95Ms = percentile(ackLatencies, 0.95);
    const firstTokenP95Ms = percentile(
      [...firstTokenAt.values()].map((value) => value - waveStartedAt),
      0.95,
    );
    const completionMs = allCompletedAt - waveStartedAt;
    const eventLoopP95Ms = eventLoop.percentile(95) / 1e6;
    const controlP95Ms = percentile(controlLatencies, 0.95);
    const rssGrowthMb = Math.max(0, peakRss - baselineRss) / (1024 * 1024);

    t.diagnostic(
      `panes=${PANE_COUNT} ackP95=${ackP95Ms.toFixed(1)}ms `
      + `firstTokenP95=${firstTokenP95Ms.toFixed(1)}ms complete=${completionMs.toFixed(1)}ms `
      + `eventLoopP95=${eventLoopP95Ms.toFixed(1)}ms controlP95=${controlP95Ms.toFixed(1)}ms `
      + `rssGrowth=${rssGrowthMb.toFixed(1)}MB`,
    );
    assert.ok(ackP95Ms < ACK_P95_LIMIT_MS,
      `submit ACK p95 ${ackP95Ms.toFixed(1)}ms exceeded ${ACK_P95_LIMIT_MS}ms`);
    assert.ok(firstTokenP95Ms < FIRST_TOKEN_P95_LIMIT_MS,
      `first-token p95 ${firstTokenP95Ms.toFixed(1)}ms exceeded ${FIRST_TOKEN_P95_LIMIT_MS}ms`);
    assert.ok(completionMs < COMPLETION_LIMIT_MS,
      `all streams took ${completionMs.toFixed(1)}ms`);
    assert.ok(eventLoopP95Ms < EVENT_LOOP_P95_LIMIT_MS,
      `event-loop p95 ${eventLoopP95Ms.toFixed(1)}ms exceeded ${EVENT_LOOP_P95_LIMIT_MS}ms`);
    assert.ok(controlP95Ms < CONTROL_P95_LIMIT_MS,
      `control-plane p95 ${controlP95Ms.toFixed(1)}ms exceeded ${CONTROL_P95_LIMIT_MS}ms`);
    assert.ok(rssGrowthMb < RSS_GROWTH_LIMIT_MB,
      `RSS grew ${rssGrowthMb.toFixed(1)}MB, limit ${RSS_GROWTH_LIMIT_MB}MB`);
  } finally {
    probeRunning = false;
    await controlProbe.catch(() => {});
    clearInterval(rssTimer);
    eventLoop.disable();
    await client.close('stress test end');
    await service.stop('stress test end');
    await transport.stop();
    rmSync(ROOT, { recursive: true, force: true });
  }
});
