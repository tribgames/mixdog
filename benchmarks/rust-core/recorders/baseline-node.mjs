#!/usr/bin/env node
// RL §14 baselines on today's Node daemon: loop lag (event-loop delay per
// window), cold start, first/steady session.list, cold session open
// (session.read), model list and usage reads, over synthetic corpora.
//
//   node benchmarks/rust-core/recorders/baseline-node.mjs --tree <dir> \
//     [--corpora 100,10000] [--iterations 20] [--large true] [--out <json>]
//
// Isolated MIXDOG_DATA_DIR/HOME per run (launchObservedDaemon); no provider,
// no credential, no network. Stops every daemon it starts.
import { mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import os from 'node:os';
import { RESULTS_ROOT, importFrom, parseArgs, productIdentity, resolveTree, summarize, writeJson } from './lib/common.mjs';

const args = parseArgs();
const tree = resolveTree(args);
const iterations = Number(args.get('iterations') ?? 20);
const corpora = String(args.get('corpora') ?? '100,10000').split(',').map(Number);
const withLarge = args.get('large') !== 'false';
const out = args.get('out') ?? join(RESULTS_ROOT, 'baseline-node.json');
const NO_DEADLINE = 2 ** 31 - 1;

const { launchObservedDaemon } = await importFrom(tree, 'src/standalone/test-fixtures/daemon-steady-harness.mjs');

function writeAtomic(path, text) {
  writeFileSync(`${path}.tmp`, text);
  renameSync(`${path}.tmp`, path);
}

/** Deterministic small session record in the on-disk shape the store reads. */
function record(id, i, cwd, now, messages) {
  return {
    id, owner: 'user', agent: 'lead', closed: false, generation: 1,
    provider: 'openai', model: 'gpt-4o-mini', toolMode: 'full', cwd,
    title: `synthetic ${i}`, createdAt: now - (i + 60) * 60_000, updatedAt: now - i * 60_000, tools: [],
    messages,
  };
}
const smallMessages = (i) =>
  Array.from({ length: 8 }, (_, k) => ({ role: k % 2 ? 'assistant' : 'user', content: `message ${i}/${k} ${'x'.repeat(200)}` }));

function seed({ dataDir, cwd, count, large }) {
  const dir = join(dataDir, 'sessions');
  mkdirSync(dir, { recursive: true });
  const now = Date.now();
  for (let i = 0; i < count; i += 1) {
    writeAtomic(join(dir, `sess_syn_${String(i).padStart(6, '0')}.json`), JSON.stringify(record(`sess_syn_${String(i).padStart(6, '0')}`, i, cwd, now, smallMessages(i))));
  }
  const bigText = (bytes) => 'y'.repeat(bytes);
  const shapes = large
    ? {
        // ~19 MB log (the real corpus' largest session), 200 x 1 MiB entries, one 50 MiB tool output.
        sess_big_19mb: Array.from({ length: 4750 }, (_, k) => ({ role: k % 2 ? 'assistant' : 'user', content: bigText(4000) })),
        sess_big_200x1mib: Array.from({ length: 200 }, (_, k) => ({ role: k % 2 ? 'assistant' : 'user', content: bigText(1024 * 1024) })),
        sess_big_toolout_50mib: [
          { role: 'user', content: 'run' },
          { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'shell', input: { command: 'x' } }] },
          { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: bigText(50 * 1024 * 1024) }] },
        ],
      }
    : {};
  for (const [id, messages] of Object.entries(shapes)) {
    writeAtomic(join(dir, `${id}.json`), JSON.stringify(record(id, 0, cwd, now, messages)));
  }
  return Object.keys(shapes);
}

async function timed(fn) {
  const t = performance.now();
  const value = await fn();
  return { ms: performance.now() - t, value };
}

async function runCorpus(count, large) {
  let bigIds = [];
  const launchStart = performance.now();
  const daemon = await launchObservedDaemon({
    tree,
    prepare: async ({ root, dataDir }) => {
      bigIds = seed({ dataDir, cwd: root, count, large });
    },
  });
  const coldStartMs = performance.now() - launchStart; // includes seeding time of prepare(); reported separately below
  try {
    const client = await daemon.attach();
    const call = (name, params) => client.call(name, params, { timeoutMs: NO_DEADLINE });
    const windowed = async (fn) => {
      await daemon.window.start();
      const result = await fn();
      const w = await daemon.window.stop();
      return { result, loopDelayMs: w.delayMs, utilization: w.utilization, cpuPercent: w.cpuPercent };
    };
    const report = { sessions: count + bigIds.length, coldStartMsInclSeed: Math.round(coldStartMs) };

    const first = await windowed(() => timed(() => call('session.list', { refreshFromStorage: false })));
    report.firstList = { ms: Math.round(first.result.ms), loopDelayMs: first.loopDelayMs, rows: first.result.value?.sessions?.length ?? first.result.value?.length ?? null };
    const lists = await windowed(async () => {
      const s = [];
      for (let i = 0; i < iterations; i += 1) s.push((await timed(() => call('session.list', { refreshFromStorage: false }))).ms);
      return s;
    });
    report.list = { ms: summarize(lists.result), loopDelayMs: lists.loopDelayMs };

    const ids = [...bigIds, ...Array.from({ length: iterations }, (_, i) => `sess_syn_${String(i).padStart(6, '0')}`)];
    report.open = {};
    for (const id of ids.slice(0, bigIds.length)) {
      const o = await windowed(() => timed(() => call('session.read', { sessionId: id })));
      report.open[id] = { ms: Math.round(o.result.ms), loopDelayMs: o.loopDelayMs };
    }
    if (count >= iterations) {
      const o = await windowed(async () => {
        const s = [];
        for (const id of ids.slice(bigIds.length)) s.push((await timed(() => call('session.read', { sessionId: id }))).ms);
        return s;
      });
      report.open.coldSmall = { ms: summarize(o.result), loopDelayMs: o.loopDelayMs };
    }

    // Control-plane reads need a bound session id.
    const created = await call('session.create', { cwd: daemon.root, provider: 'openai', model: 'gpt-4o-mini', toolMode: 'full', remote: false, desktopSession: null });
    const sessionId = String(created.sessionId);
    for (const action of ['listProviderModels', 'getUsageDashboard', 'getUsageStats', 'getUsageRequests']) {
      const r = await windowed(async () => {
        const s = [];
        let error = null;
        for (let i = 0; i < iterations; i += 1) {
          try {
            s.push((await timed(() => call('session.read', { sessionId, action, args: [] }))).ms);
          } catch (e) {
            error = String(e?.message ?? e);
            break;
          }
        }
        return { s, error };
      });
      report[action] = { ms: summarize(r.result.s), loopDelayMs: r.loopDelayMs, ...(r.result.error ? { error: r.result.error } : {}) };
    }
    return report;
  } finally {
    await daemon.dispose();
  }
}

const result = {
  recordedAt: new Date().toISOString(),
  product: productIdentity(),
  machine: { cpu: os.cpus()[0].model, logical: os.cpus().length, memGiB: Math.round(os.totalmem() / 2 ** 30), node: process.version, platform: `${process.platform} ${process.arch}` },
  iterations,
  corpora: {},
};
for (const count of corpora) {
  process.stderr.write(`corpus ${count}\n`);
  result.corpora[`c${count}`] = await runCorpus(count, withLarge && count === corpora[0]);
}
writeJson(out, result);
process.stderr.write(`wrote ${out}\n`);
