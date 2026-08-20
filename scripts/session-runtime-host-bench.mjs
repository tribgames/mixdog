#!/usr/bin/env node
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';

import { createSessionRuntimeHost } from '../src/standalone/session-runtime-host.mjs';

const DEFAULT_DELAY_MS = Math.max(1, Number(process.env.RUNTIME_HOST_BENCH_DELAY_MS) || 250);
const IO_DELAYS_MS = String(process.env.RUNTIME_HOST_BENCH_DELAYS || '10,250,1000')
  .split(',')
  .map((value) => Math.max(1, Math.floor(Number(value) || 0)))
  .filter(Boolean);
const IO_FANOUTS = String(process.env.RUNTIME_HOST_BENCH_FANOUTS || '1,10,20,50,100')
  .split(',')
  .map((value) => Math.max(1, Math.floor(Number(value) || 0)))
  .filter(Boolean);
const CPU_FANOUTS = String(process.env.RUNTIME_HOST_BENCH_CPU_FANOUTS || '1,10,20,50')
  .split(',')
  .map((value) => Math.max(1, Math.floor(Number(value) || 0)))
  .filter(Boolean);
const CPU_COSTS_MS = String(process.env.RUNTIME_HOST_BENCH_CPU_COSTS || '0,5,20')
  .split(',')
  .map((value) => Math.max(0, Number(value) || 0));
const REPEATS = Math.max(1, Math.floor(Number(process.env.RUNTIME_HOST_BENCH_REPEATS) || 3));
const CPU_PROVIDER_DELAY_MS = 10;
const COLD_PROVIDER_DELAY_MS = 10;
const STABILITY_FANOUT = 100;
const PROBE_INTERVAL_MS = 5;

const root = mkdtempSync(join(tmpdir(), 'mixdog-runtime-host-bench-'));
const workerEntry = join(root, 'fixed-runtime-worker.mjs');

writeFileSync(workerEntry, `
import { monitorEventLoopDelay, performance } from 'node:perf_hooks';

const records = new Map();
const defaultDelayMs = Math.max(1, Number(process.env.RUNTIME_HOST_BENCH_DELAY_MS) || 250);
const eventLoop = monitorEventLoopDelay({ resolution: 10 });
eventLoop.enable();

function send(message) {
  if (process.connected) process.send(message);
}

function respond(requestId, value) {
  send({ type: 'response', requestId, ok: true, value });
}

function publish(runtimeId, revision, state) {
  send({ type: 'state', runtimeId, revision, full: state });
}

process.on('message', (message) => {
  const requestId = String(message?.requestId || '');
  void (async () => {
    if (message.type === 'prewarm') return { ready: true };
    if (message.type === 'create') {
      const state = { sessionId: String(message.options?.sessionId || ''), busy: false };
      records.set(message.runtimeId, { revision: 1, state });
      publish(message.runtimeId, 1, state);
      return { created: true };
    }
    if (message.type === 'snapshot') {
      const record = records.get(message.runtimeId);
      if (!record) throw new Error('runtime missing');
      record.revision += 1;
      publish(message.runtimeId, record.revision, record.state);
      return { published: true };
    }
    if (message.type === 'workload') {
      const workload = {
        runtimes: records.size,
        defaultDelayMs,
        eventLoop: {
          meanMs: Number(eventLoop.mean) / 1e6,
          p99Ms: Number(eventLoop.percentile(99)) / 1e6,
          maxMs: Number(eventLoop.max) / 1e6,
        },
        memory: process.memoryUsage(),
      };
      eventLoop.reset();
      return workload;
    }
    if (message.type === 'call') {
      const record = records.get(message.runtimeId);
      if (!record) throw new Error('runtime missing');
      if (message.method === 'submitAsync') {
        const options = message.args?.[0] && typeof message.args[0] === 'object'
          ? message.args[0]
          : {};
        const delayMs = Math.max(1, Number(options.delayMs) || defaultDelayMs);
        const cpuMs = Math.max(0, Number(options.cpuMs) || 0);
        record.state = { ...record.state, busy: true };
        record.revision += 1;
        publish(message.runtimeId, record.revision, record.state);
        await new Promise((resolve) => setTimeout(resolve, delayMs));
        const cpuStartedAt = performance.now();
        while (performance.now() - cpuStartedAt < cpuMs) {
          // Deliberately synchronous: this models response parsing/context work.
        }
        record.state = { ...record.state, busy: false };
        record.revision += 1;
        publish(message.runtimeId, record.revision, record.state);
        return { ok: true };
      }
      if (message.method === 'dispose') {
        records.delete(message.runtimeId);
        return true;
      }
      return true;
    }
    if (message.type === 'shutdown') return { stopped: true };
    throw new Error('unknown message');
  })().then((value) => {
    if (requestId) respond(requestId, value ?? null);
    if (message.type === 'shutdown') setImmediate(() => process.exit(0));
  }).catch((error) => {
    if (requestId) {
      send({
        type: 'response',
        requestId,
        ok: false,
        error: { name: error.name, message: error.message, stack: error.stack },
      });
    }
  });
});

process.on('disconnect', () => process.exit(0));
`, 'utf8');

function startLagProbe() {
  const samples = [];
  let previous = performance.now();
  const timer = setInterval(() => {
    const now = performance.now();
    samples.push(Math.max(0, now - previous - PROBE_INTERVAL_MS));
    previous = now;
  }, PROBE_INTERVAL_MS);
  return {
    stop() {
      clearInterval(timer);
      const sorted = samples.sort((left, right) => left - right);
      const at = (quantile) => sorted[Math.min(
        Math.max(0, sorted.length - 1),
        Math.floor(sorted.length * quantile),
      )] ?? 0;
      return {
        meanMs: sorted.length
          ? sorted.reduce((sum, value) => sum + value, 0) / sorted.length
          : 0,
        p99Ms: at(0.99),
        maxMs: sorted.at(-1) ?? 0,
      };
    },
  };
}

async function disposeAll(runtimes) {
  await Promise.allSettled(runtimes.map((runtime) => runtime.dispose('bench complete')));
}

async function measureDirect(fanout, delayMs, cpuMs = 0) {
  const probe = startLagProbe();
  const createStartedAt = performance.now();
  const runtimes = Array.from({ length: fanout }, (_, index) => ({
    id: `direct-${fanout}-${index}`,
    async submitAsync() {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
      const cpuStartedAt = performance.now();
      while (performance.now() - cpuStartedAt < cpuMs) {
        // Same synchronous post-processing as the hosted worker.
      }
      return { ok: true };
    },
  }));
  const createMs = performance.now() - createStartedAt;
  const submitStartedAt = performance.now();
  await Promise.all(runtimes.map((runtime) => runtime.submitAsync()));
  const submitMs = performance.now() - submitStartedAt;
  await new Promise((resolve) => setTimeout(resolve, PROBE_INTERVAL_MS * 2));
  const eventLoop = probe.stop();
  return {
    createMs,
    submitMs,
    overheadMs: Math.max(0, submitMs - delayMs - (fanout * cpuMs)),
    eventLoop,
  };
}

async function measureHosted(host, fanout, delayMs, cpuMs = 0) {
  const probe = startLagProbe();
  const createStartedAt = performance.now();
  const runtimes = await Promise.all(Array.from(
    { length: fanout },
    (_, index) => host.create({ sessionId: `hosted-${fanout}-${index}` }),
  ));
  const createMs = performance.now() - createStartedAt;
  const submitStartedAt = performance.now();
  await Promise.all(runtimes.map((runtime) => runtime.submitAsync({ delayMs, cpuMs })));
  const submitMs = performance.now() - submitStartedAt;
  await disposeAll(runtimes);
  await host.refreshRuntimeWorkload();
  await new Promise((resolve) => setTimeout(resolve, PROBE_INTERVAL_MS * 2));
  const eventLoop = probe.stop();
  return {
    createMs,
    submitMs,
    overheadMs: Math.max(0, submitMs - delayMs - (fanout * cpuMs)),
    eventLoop,
    worker: host.workloads.worker,
  };
}

function createHost() {
  return createSessionRuntimeHost({
    workerEntry,
    cwd: root,
    env: {
      ...process.env,
      RUNTIME_HOST_BENCH_DELAY_MS: String(DEFAULT_DELAY_MS),
    },
  });
}

function median(values) {
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2
    ? sorted[middle]
    : (sorted[middle - 1] + sorted[middle]) / 2;
}

function rounded(value, digits = 3) {
  return Number(Number(value || 0).toFixed(digits));
}

function summarizePair(samples) {
  const directSubmit = samples.map((sample) => sample.direct.submitMs);
  const hostedSubmit = samples.map((sample) => sample.hosted.submitMs);
  const deltas = samples.map((sample) => sample.hosted.submitMs - sample.direct.submitMs);
  return {
    directSubmitMedianMs: rounded(median(directSubmit)),
    hostedSubmitMedianMs: rounded(median(hostedSubmit)),
    hostedDeltaMedianMs: rounded(median(deltas)),
    hostedDeltaWorstMs: rounded(Math.max(...deltas)),
    hostedCreateMedianMs: rounded(median(samples.map((sample) => sample.hosted.createMs))),
    directEventLoopMaxMs: rounded(Math.max(...samples.map((sample) => sample.direct.eventLoop.maxMs))),
    hostedClientEventLoopMaxMs: rounded(Math.max(...samples.map((sample) => sample.hosted.eventLoop.maxMs))),
    hostedWorkerEventLoopMaxMs: rounded(Math.max(
      ...samples.map((sample) => sample.hosted.worker?.eventLoop?.maxMs || 0),
    )),
  };
}

async function measurePair(host, fanout, delayMs, cpuMs = 0) {
  const samples = [];
  for (let repeat = 0; repeat < REPEATS; repeat += 1) {
    // Alternate order so a fixed first-run bias cannot favor one path.
    if (repeat % 2 === 0) {
      const direct = await measureDirect(fanout, delayMs, cpuMs);
      const hosted = await measureHosted(host, fanout, delayMs, cpuMs);
      samples.push({ direct, hosted });
    } else {
      const hosted = await measureHosted(host, fanout, delayMs, cpuMs);
      const direct = await measureDirect(fanout, delayMs, cpuMs);
      samples.push({ direct, hosted });
    }
  }
  return summarizePair(samples);
}

async function measureColdStart() {
  const samples = [];
  for (let repeat = 0; repeat < REPEATS; repeat += 1) {
    const coldHost = createHost();
    const startedAt = performance.now();
    await coldHost.prewarm();
    const readyMs = performance.now() - startedAt;
    const runtime = await coldHost.create({ sessionId: `cold-${repeat}` });
    const createdMs = performance.now() - startedAt;
    await runtime.submitAsync({ delayMs: COLD_PROVIDER_DELAY_MS, cpuMs: 0 });
    const firstResponseMs = performance.now() - startedAt;
    await runtime.dispose('cold benchmark complete');
    await coldHost.close('cold benchmark complete');
    samples.push({ readyMs, createdMs, firstResponseMs });
  }
  return {
    workerReadyMedianMs: rounded(median(samples.map((sample) => sample.readyMs))),
    workerReadyWorstMs: rounded(Math.max(...samples.map((sample) => sample.readyMs))),
    sessionCreatedMedianMs: rounded(median(samples.map((sample) => sample.createdMs))),
    firstResponseMedianMs: rounded(median(samples.map((sample) => sample.firstResponseMs))),
    firstResponseWorstMs: rounded(Math.max(...samples.map((sample) => sample.firstResponseMs))),
    providerDelayMs: COLD_PROVIDER_DELAY_MS,
  };
}

async function snapshotWorker(host) {
  await host.refreshRuntimeWorkload();
  return host.workloads.worker;
}

async function measureStability(host) {
  const before = await snapshotWorker(host);
  const cycles = [];
  for (let repeat = 0; repeat < REPEATS; repeat += 1) {
    const result = await measureHosted(host, STABILITY_FANOUT, CPU_PROVIDER_DELAY_MS, 0);
    await new Promise((resolve) => setTimeout(resolve, 50));
    const after = await snapshotWorker(host);
    cycles.push({
      cycle: repeat + 1,
      runtimeCount: after?.runtimes ?? null,
      rssMb: rounded((after?.memory?.rss || 0) / (1024 * 1024), 1),
      heapUsedMb: rounded((after?.memory?.heapUsed || 0) / (1024 * 1024), 1),
      submitMs: rounded(result.submitMs),
    });
  }
  const last = await snapshotWorker(host);
  return {
    sessionsPerCycle: STABILITY_FANOUT,
    cycles,
    finalRuntimeCount: last?.runtimes ?? null,
    rssDeltaMb: rounded(
      ((last?.memory?.rss || 0) - (before?.memory?.rss || 0)) / (1024 * 1024),
      1,
    ),
    heapUsedDeltaMb: rounded(
      ((last?.memory?.heapUsed || 0) - (before?.memory?.heapUsed || 0)) / (1024 * 1024),
      1,
    ),
  };
}

const host = createHost();

try {
  process.stdout.write(`${JSON.stringify({
    type: 'config',
    repeats: REPEATS,
    ioFanouts: IO_FANOUTS,
    ioDelaysMs: IO_DELAYS_MS,
    cpuFanouts: CPU_FANOUTS,
    cpuCostsMs: CPU_COSTS_MS,
  })}\n`);

  const cold = await measureColdStart();
  process.stdout.write(`${JSON.stringify({ type: 'cold-start', ...cold })}\n`);

  // Equal warm state: neither measured path below includes module/process startup.
  await new Promise((resolve) => setTimeout(resolve, DEFAULT_DELAY_MS));
  await host.prewarm();
  const warm = await host.create({ sessionId: 'hosted-warmup' });
  await warm.submitAsync({ delayMs: CPU_PROVIDER_DELAY_MS, cpuMs: 0 });
  await warm.dispose('warmup complete');

  for (const delayMs of IO_DELAYS_MS) {
    for (const fanout of IO_FANOUTS) {
      const summary = await measurePair(host, fanout, delayMs, 0);
      process.stdout.write(`${JSON.stringify({
        type: 'warm-io',
        delayMs,
        fanout,
        ...summary,
      })}\n`);
    }
  }

  for (const cpuMs of CPU_COSTS_MS) {
    for (const fanout of CPU_FANOUTS) {
      const summary = await measurePair(host, fanout, CPU_PROVIDER_DELAY_MS, cpuMs);
      process.stdout.write(`${JSON.stringify({
        type: 'cpu-postprocess',
        providerDelayMs: CPU_PROVIDER_DELAY_MS,
        cpuMsPerResponse: cpuMs,
        fanout,
        ...summary,
      })}\n`);
    }
  }

  const stability = await measureStability(host);
  process.stdout.write(`${JSON.stringify({ type: 'stability', ...stability })}\n`);
} finally {
  await host.close('benchmark complete');
  rmSync(root, { recursive: true, force: true });
}
