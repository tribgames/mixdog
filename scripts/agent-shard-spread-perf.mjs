#!/usr/bin/env node
// Agent shard spread PERF harness (manual, real provider turns).
//
// Measures the Lead-process event-loop impact of an 8-agent fanout in both
// modes against the SAME real provider route:
//   OFF — workers run in-process (this process plays the Lead shard).
//   ON  — workers run as daemon-hosted sessions on other shards
//         (MIXDOG_AGENT_SHARD_SPREAD=1), daemon isolated via MIXDOG_RUNTIME_ROOT.
//
// Run: node scripts/agent-shard-spread-perf.mjs [provider model effort]
// Defaults to grok-oauth/grok-4.3 low. Uses the REAL user config/keychain for
// provider auth; worker-index/statusline writes go to a temp dataDir.
import { copyFileSync, existsSync, mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';

const ROOT = mkdtempSync(join(tmpdir(), 'mixdog-spread-perf-'));
process.env.MIXDOG_RUNTIME_ROOT = ROOT;            // isolated perf daemon
process.env.MIXDOG_DAEMON_SKIP_MEMORY = '1';       // no memory runtime for perf
// Shard prewarm/creates must not boot a per-root Postgres either: an isolated
// perf root's postmaster outlives the daemon and leaks (observed: six temp
// roots holding ~60-100MB PG trees each after a perf session).
process.env.MIXDOG_BOOT_CORE_MEMORY = '0';
process.env.MIXDOG_AGENT_TRACE_DISABLE = '1';
process.env.MIXDOG_AGENT_SHARD_SPREAD = '0';       // phase-controlled below

// Isolated DATA_DIR: the daemon owner lock lives in the data dir, so sharing
// the user's data dir would collide with the LIVE daemon (and revision-2
// clients must never trigger a replacement drain on it). Copy only the config
// and the provider credential files the perf route needs.
const DATA_DIR = join(ROOT, 'data');
mkdirSync(DATA_DIR, { recursive: true });
const REAL_DATA_DIR = join(homedir(), '.mixdog', 'data');
for (const file of [
  'mixdog-config.json',
  'grok-oauth.json',
  'grok-oauth-models.json',
  'openai-oauth.json',
  'openai-oauth-models.json',
  'anthropic-oauth-credentials.json',
  'anthropic-oauth-models.json',
]) {
  const from = join(REAL_DATA_DIR, file);
  if (existsSync(from)) copyFileSync(from, join(DATA_DIR, file));
}
process.env.MIXDOG_DATA_DIR = DATA_DIR;

const PROVIDER = process.argv[2] || 'grok-oauth';
const MODEL = process.argv[3] || 'grok-4.3';
const EFFORT = process.argv[4] || 'low';
const FANOUT = Math.max(1, Number(process.env.SPREAD_PERF_FANOUT) || 8);
const PHASES = (process.env.SPREAD_PERF_PHASE || 'both').toLowerCase();
const KEEP = process.env.SPREAD_PERF_KEEP === '1';
const JOB_TIMEOUT_MS = Math.max(30_000, Number(process.env.SPREAD_PERF_TIMEOUT_MS) || 240_000);
const WARM_WAIT_MS = Math.max(0, Number(process.env.SPREAD_PERF_WARM_WAIT_MS) || 0);
const EVICT_WAIT_MS = Math.max(0, Number(process.env.SPREAD_PERF_EVICT_WAIT_MS) || 0);
const REPO = 'C:/Project/mixdog';
const PROBE_INTERVAL_MS = 25;

const cfgMod = await import('../src/runtime/agent/orchestrator/config.mjs');
const reg = await import('../src/runtime/agent/orchestrator/providers/registry.mjs');
const mgr = await import('../src/runtime/agent/orchestrator/session/manager.mjs');
const { createStandaloneAgent } = await import('../src/standalone/agent-tool.mjs');
const {
  attachSession,
  ensureDaemon,
  probeSessionHealth,
  readSessionDiscovery,
  shutdownDaemon,
} = await import('../src/standalone/session-client.mjs');

function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }
function taskId(text) { return String(text).match(/agent task: (\S+)/)?.[1] || null; }

function startLagProbe() {
  const samples = [];
  let last = performance.now();
  const timer = setInterval(() => {
    const now = performance.now();
    samples.push(Math.max(0, now - last - PROBE_INTERVAL_MS));
    last = now;
  }, PROBE_INTERVAL_MS);
  return {
    stop() {
      clearInterval(timer);
      const sorted = [...samples].sort((a, b) => a - b);
      const at = (q) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))] ?? 0;
      const mean = sorted.length ? sorted.reduce((s, v) => s + v, 0) / sorted.length : 0;
      return {
        samples: sorted.length,
        meanMs: mean,
        p95Ms: at(0.95),
        p99Ms: at(0.99),
        maxMs: sorted[sorted.length - 1] ?? 0,
        over50ms: sorted.filter((v) => v > 50).length,
        over250ms: sorted.filter((v) => v > 250).length,
      };
    },
  };
}

async function waitJob(agent, out, label, timeoutMs = JOB_TIMEOUT_MS) {
  const id = taskId(out);
  if (!id) throw new Error(`missing task id for ${label}: ${out}`);
  const startedAt = Date.now();
  let last = '';
  while (Date.now() - startedAt < timeoutMs) {
    last = await agent.execute({ type: 'read', task_id: id }, { invocationSource: 'model-tool', cwd: REPO });
    if (/status: (completed|failed|error|cancelled)/.test(last)) return last;
    await sleep(500);
  }
  return `status: timeout\n${last}`;
}

async function runPhase(name) {
  const dataDir = join(ROOT, `data-${name}`);
  mkdirSync(dataDir, { recursive: true });
  const agent = createStandaloneAgent({
    cfgMod, reg, mgr, dataDir, cwd: REPO,
  });
  const probe = startLagProbe();
  const t0 = Date.now();
  const outs = await Promise.all(Array.from({ length: FANOUT }, (_, index) => agent.execute({
    type: 'spawn',
    agent: 'worker',
    provider: PROVIDER,
    model: MODEL,
    effort: EFFORT,
    tag: `${name}-w${index}`,
    cwd: REPO,
    prompt: `Read the file package.json in the current repo and reply with exactly the value of its "name" field plus the token #${index}. One short line. Do not edit anything.`,
  }, { invocationSource: 'model-tool', cwd: REPO })));
  const results = await Promise.all(outs.map((out, index) => waitJob(agent, out, `${name}-w${index}`)));
  const wallMs = Date.now() - t0;
  const lag = probe.stop();
  const ok = results.filter((r) => /status: completed/.test(r) && /mixdog/i.test(r)).length;
  try { agent.closeAll(`spread-perf-${name}-end`); } catch { /* teardown */ }
  return { name, wallMs, lag, ok, results };
}

function report(phase) {
  const { lag } = phase;
  process.stdout.write(
    `[${phase.name}] ok=${phase.ok}/${FANOUT} wall=${(phase.wallMs / 1000).toFixed(1)}s `
    + `loopLag mean=${lag.meanMs.toFixed(2)}ms p95=${lag.p95Ms.toFixed(1)}ms `
    + `p99=${lag.p99Ms.toFixed(1)}ms max=${lag.maxMs.toFixed(0)}ms `
    + `>50ms=${lag.over50ms} >250ms=${lag.over250ms} (n=${lag.samples})\n`,
  );
}

function processRssMb(pids) {
  const rss = new Map();
  const wanted = pids.filter((pid) => Number.isInteger(pid) && pid > 0);
  if (!wanted.length) return rss;
  try {
    const out = execFileSync('powershell', [
      '-NoProfile', '-Command',
      `Get-Process -Id ${wanted.join(',')} -ErrorAction SilentlyContinue | ForEach-Object { "$($_.Id) $($_.WorkingSet64)" }`,
    ], { encoding: 'utf8' });
    for (const line of out.split(/\r?\n/)) {
      const [pid, bytes] = line.trim().split(/\s+/);
      if (pid && bytes) rss.set(Number(pid), Number(bytes) / (1024 * 1024));
    }
  } catch { /* best-effort */ }
  return rss;
}

async function printShardLoad(discovery) {
  const health = await probeSessionHealth({ port: discovery.port, token: discovery.token, timeoutMs: 3_000 });
  const shards = health?.sessionShards?.shards || [];
  const rss = processRssMb([health?.pid, ...shards.map((shard) => shard.pid)]);
  const daemonRss = rss.get(Number(health?.pid));
  process.stdout.write(`[load] daemon pid=${health?.pid} sessions=${health?.sessions} busy=${health?.busy}`
    + `${daemonRss ? ` rss=${daemonRss.toFixed(0)}MB` : ''}\n`);
  for (const shard of shards) {
    if (!shard.pid) continue;
    const mb = rss.get(Number(shard.pid));
    process.stdout.write(`[load] shard ${shard.index}: pid=${shard.pid} runtimes=${shard.runtimes}`
      + ` pending=${shard.pending}${mb ? ` rss=${mb.toFixed(0)}MB` : ''}\n`);
  }
}

try {
  // Phase 1 — spread OFF: workers share this process's event loop.
  const off = PHASES !== 'on' ? await runPhase('off') : null;
  if (off) report(off);

  // Phase 2 — spread ON: isolated daemon + shard pool host the workers.
  let on = null;
  if (PHASES !== 'off') {
    process.env.MIXDOG_AGENT_SHARD_SPREAD = '1';
    const discovery = await ensureDaemon({ cwd: REPO, log: (line) => process.stdout.write(`[daemon-spawn] ${line}\n`) });
    const health = await probeSessionHealth({ port: discovery.port, token: discovery.token });
    process.stdout.write(`[on] perf daemon pid=${discovery.pid} rev=${health?.revision}\n`);
    if (WARM_WAIT_MS > 0) {
      // Warm-daemon scenario: the spread-prewarm starts on client REGISTRATION,
      // so attach once, then give it time to boot the peer shards before the
      // fanout — mirroring a daemon that has been serving a client for a while.
      await attachSession({
        discovery,
        lifecycle: false,
        cwd: REPO,
        onFrame: () => {},
        onFatal: () => {},
      }).catch(() => {});
      await sleep(WARM_WAIT_MS);
      await printShardLoad(discovery).catch(() => {});
    }
    on = await runPhase('on');
    report(on);
    await printShardLoad(discovery).catch(() => {});
    if (EVICT_WAIT_MS > 0) {
      // Reclamation probe: idle+unwatched worker runtimes should be evicted
      // (service sweep) and their shard RSS returned after this window.
      await sleep(EVICT_WAIT_MS);
      process.stdout.write(`[load] after ${(EVICT_WAIT_MS / 1000).toFixed(0)}s idle:\n`);
      await printShardLoad(discovery).catch(() => {});
    }
  }

  for (const phase of [off, on].filter(Boolean)) {
    for (const [index, result] of phase.results.entries()) {
      if (!/status: completed/.test(result) || !/mixdog/i.test(result)) {
        process.stdout.write(`--- ${phase.name}-w${index} ---\n${result.slice(0, 600)}\n`);
      }
    }
  }
  const gate = on || off;
  const verdict = gate.ok === FANOUT ? 'PASS' : 'FAIL';
  process.stdout.write(`verdict: ${verdict} (${gate.name}.ok=${gate.ok}/${FANOUT})\n`);
  process.exitCode = gate.ok === FANOUT ? 0 : 1;
} finally {
  if (KEEP) {
    process.stdout.write(`kept root: ${ROOT}\n`);
  } else {
    try { await shutdownDaemon(readSessionDiscovery()); } catch { /* teardown */ }
    await sleep(300);
    try { rmSync(ROOT, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); } catch { /* temp */ }
  }
}
process.exit(process.exitCode || 0);

