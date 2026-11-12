#!/usr/bin/env node
// Rerunnable stress probe for the daemon's main thread: what the 2026-11-12
// 11:31 KST freeze looked like. A real daemon (isolated data dir, runtime root
// and home under a temp dir; never the user's) is started on a store of
// `--sessions` (default 20) long transcripts, i.e. a restart, and in one
// measured window it is driven with
//   - a resume burst: every stored session read and subscribed at once, over
//     its own attachment, then again every few seconds (re-attaching clients);
//   - agent tool traffic: sub-agent spawns/lists, turns on every session
//     (scripted provider), session creation, worktree requests, saves, lists;
//   - shared state files under foreign lock holds: agent-workers.json,
//     session-summaries.json, read-range-index, goals, provider accounts;
//   - a slow disk: every fs call on the daemon's data dir / runtime root costs
//     --slow-disk-ms (test-fixtures/daemon-slow-disk.mjs), blocking for sync
//     calls, awaiting for async ones.
// It prints JSON: `worstGapMs` is the longest the daemon's main thread went
// without running a 50 ms timer (the supervisor's ping is answered by that
// same thread, so a ping waits at most that long), plus the loop-delay
// histogram, the Atomics.wait and sync-fs call sites, and whether the
// supervisor extended or killed (lines in daemon.log).
//
//   node scripts/daemon-stress-probe.mjs [--sessions 20] [--duration-ms 45000]
//     [--slow-disk-ms 5] [--size-scale 1] [--tree <root>] [--label <name>]
//     [--memory-pressure-mb <n>]  (daemon holds an n MB heap; the probe's child
//     empties its working set every 250 ms, as under memory pressure; Windows)
// Exit code 1 when worstGapMs >= 2000 (--max-gap-ms to change).
import { spawn } from 'node:child_process';
import { mkdirSync, readFileSync } from 'node:fs';
import os, { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runBusyScenario } from '../src/standalone/test-fixtures/daemon-busy-scenario.mjs';
import { newBucket } from '../src/standalone/test-fixtures/daemon-busy-scenario.mjs';
import {
  FAKE_MODEL,
  FAKE_PROVIDER_ID,
  startFakeProvider,
  writeCustomProviderConfig,
} from '../src/standalone/test-fixtures/daemon-fake-provider.mjs';
import { createFixtureRepo, seedBusyStore } from '../src/standalone/test-fixtures/daemon-busy-seed.mjs';
import { launchObservedDaemon } from '../src/standalone/test-fixtures/daemon-steady-harness.mjs';

const args = new Map();
for (let i = 2; i < process.argv.length; i += 2) args.set(process.argv[i].replace(/^--/, ''), process.argv[i + 1]);
const number = (name, fallback) => Number(args.get(name) ?? fallback);
const treeRoot = args.get('tree') ?? fileURLToPath(new URL('..', import.meta.url));
const sessions = number('sessions', 20);
const slowDiskMs = number('slow-disk-ms', 5);
const maxGapMs = number('max-gap-ms', 2000);
const durationMs = number('duration-ms', 45_000);
const pressureMb = number('memory-pressure-mb', 0);
const fixtures = join(fileURLToPath(new URL('..', import.meta.url)), 'src/standalone/test-fixtures');
// A daemon takes one mutation module. Either injection asked for loads one:
// the ballast fixture (which loads the slow-disk injection itself, a no-op at
// 0 ms) under memory pressure, else the slow-disk injection.
const injected = pressureMb > 0 || slowDiskMs > 0;
const slowDisk = join(fixtures, pressureMb > 0 ? 'daemon-memory-pressure.mjs' : 'daemon-slow-disk.mjs');
// The injection reads its delay from the environment the daemon inherits.
process.env.MIXDOG_SLOW_DISK_MS = String(slowDiskMs);
process.env.MIXDOG_PRESSURE_MB = String(pressureMb);
// The ballast fixture states in this file what it actually allocated.
const pressureReport = join(tmpdir(), `mixdog-pressure-${process.pid}.json`);
process.env.MIXDOG_PRESSURE_REPORT = pressureReport;

// The machine's load while the probe ran, sampled once a second from the
// operating system's CPU counters (all logical CPUs, every process), with the
// memory still available: a comparison is only as good as these are alike.
function startMachineSampler() {
  const busyIdle = () =>
    os.cpus().reduce(
      (sum, { times }) => {
        const total = Object.values(times).reduce((a, b) => a + b, 0);
        return { idle: sum.idle + times.idle, total: sum.total + total };
      },
      { idle: 0, total: 0 }
    );
  let last = busyIdle();
  const loads = [];
  const freeMb = [os.freemem() / 2 ** 20];
  const timer = setInterval(() => {
    const now = busyIdle();
    if (now.total > last.total) loads.push(100 * (1 - (now.idle - last.idle) / (now.total - last.total)));
    last = now;
    freeMb.push(os.freemem() / 2 ** 20);
  }, 1000);
  return () => {
    clearInterval(timer);
    const mean = loads.length ? loads.reduce((a, b) => a + b, 0) / loads.length : null;
    return {
      cpuLoadMeanPct: mean === null ? null : Math.round(mean * 10) / 10,
      cpuLoadMaxPct: loads.length ? Math.round(Math.max(...loads) * 10) / 10 : null,
      availableMemoryMinMb: Math.round(Math.min(...freeMb)),
      availableMemoryStartMb: Math.round(freeMb[0]),
      logicalCpus: os.cpus().length,
      samples: loads.length,
    };
  };
}

// The probe's own child empties the daemon's working set (Windows) every
// 250 ms: the process's pages are taken away as under memory pressure, never
// the user's daemon (this one is the probe's isolated copy).
function startWorkingSetTrimmer(pid) {
  if (process.platform !== 'win32') throw new Error('--memory-pressure-mb needs Windows (EmptyWorkingSet)');
  const script =
    "Add-Type -MemberDefinition '[DllImport(\"psapi.dll\")] public static extern bool EmptyWorkingSet(IntPtr h);' -Name W -Namespace N;" +
    `$p = Get-Process -Id ${pid}; while ($true) { if ([N.W]::EmptyWorkingSet($p.Handle)) { 'trim' }; Start-Sleep -Milliseconds 250 }`;
  const child = spawn('powershell', ['-NoProfile', '-Command', script], {
    stdio: ['ignore', 'pipe', 'ignore'],
    windowsHide: true,
  });
  // Every trim that EmptyWorkingSet reported done is one line.
  child.trims = 0;
  child.stdout.on('data', (chunk) => {
    child.trims += String(chunk).split('\n').filter((line) => line.trim() === 'trim').length;
  });
  return child;
}

function heldHeapMb() {
  if (pressureMb <= 0) return 0;
  try {
    return JSON.parse(readFileSync(pressureReport, 'utf8')).heldMb;
  } catch {
    return 0;
  }
}

const LOCKED_STATE = [
  'agent-workers.json',
  'provider-accounts.json',
  'goals/goals.json',
  'read-range-index/stress.json',
];

const config = {
  seed: 1,
  busySessions: sessions,
  storeFiles: number('store-files', sessions + 150),
  sizeScale: number('size-scale', 1),
  durationMs,
  saveIntervalMs: 250,
  listIntervalMs: 1000,
  workspaceIntervalMs: 2000,
  lockHoldMs: 3000,
  lockEveryMs: 8000,
  listRefresh: false,
  turnIntervalMs: 4000,
  createIntervalMs: 1500,
  worktreeIntervalMs: 4000,
  agentIntervalMs: 3000,
  extra: async ({ daemon, busyRows, loop, timed, patient, buckets, deadline, holdLock }) => {
    buckets.resume = newBucket();
    buckets.resume.windowEnd = deadline;
    const started = [];
    // The burst, at once and again every 12 s with fresh attachments.
    started.push(
      loop(0, 12_000, async () => {
        await Promise.all(
          busyRows.map(async (row) => {
            const client = patient(await daemon.attach());
            await timed(buckets.resume, async () => {
              await client.call('session.read', { sessionId: row.id });
              await client.call('session.subscribe', { sessionId: row.id });
            });
          })
        );
      })
    );
    // Every shared state file's lock held by a foreign process in turn.
    LOCKED_STATE.forEach((file, index) => {
      started.push(holdLock(join(daemon.dataDir, `${file}.lock`), 1500, 5000, 1000 + index * 700));
    });
    return started;
  },
};

const fake = await startFakeProvider();
let daemon;
let trimmer = null;
let code = 0;
const stopMachineSampler = startMachineSampler();
try {
  daemon = await launchObservedDaemon({
    tree: treeRoot,
    ...(injected ? { mutation: slowDisk } : {}),
    ...(args.get('cpu-prof-dir') ? { execArgv: ['--cpu-prof', '--cpu-prof-dir', args.get('cpu-prof-dir')] } : {}),
    prepare: async ({ root, dataDir }) => {
      const repoDir = createFixtureRepo(join(root, 'repo'));
      writeCustomProviderConfig(dataDir, fake.baseURL);
      for (const file of LOCKED_STATE) mkdirSync(dirname(join(dataDir, file)), { recursive: true });
      globalThis.__stressSeed = await seedBusyStore({
        treeRoot,
        dataDir,
        cwd: root,
        busyCwd: repoDir,
        busy: config.busySessions,
        files: config.storeFiles,
        seed: config.seed,
        sizeScale: config.sizeScale,
        provider: FAKE_PROVIDER_ID,
        model: FAKE_MODEL,
      });
      globalThis.__stressRepo = repoDir;
    },
  });
  if (pressureMb > 0) trimmer = startWorkingSetTrimmer(daemon.discovery.pid);
  const summarize = (report) => ({
    delayMs: report.delayMs,
    atomicsWait: (report.atomicsWaits ?? [])
      .sort((a, b) => b.blockedMs - a.blockedMs)
      .slice(0, 8)
      .map(({ site, count, blockedMs }) => ({ site: site.replace(/^.*[\\/]src[\\/]/, 'src/'), count, blockedMs })),
    topSyncFs: [...report.syncFs]
      .sort((a, b) => b.count - a.count)
      .slice(0, 12)
      .map(({ method, site, count }) => ({ method, site: site.replace(/^.*[\\/]src[\\/]/, 'src/'), count })),
  });
  const run = await runBusyScenario({
    daemon,
    treeRoot,
    seeded: globalThis.__stressSeed,
    repoDir: globalThis.__stressRepo,
    config,
    summarize,
    fake,
  });
  const log = daemon.daemonLog().split('\n');
  const supervisor = log.filter((line) => /freeze supervisor/.test(line));
  const worstGapMs = run.gapTicker?.maxGapMs ?? null;
  code = worstGapMs === null || worstGapMs >= maxGapMs ? 1 : 0;
  console.log(
    JSON.stringify(
      {
        probe: 'daemon-stress',
        label: args.get('label') ?? treeRoot,
        sessions,
        // The delay the daemon's injection took from its environment (0 = none).
        slowDiskMs: slowDiskMs > 0 ? Number(process.env.MIXDOG_SLOW_DISK_MS) : 0,
        memoryPressureMb: pressureMb,
        // What was actually applied, not what was asked for: the ballast the
        // daemon reports holding, and the trims the trimmer completed.
        applied: {
          slowDiskMs: injected ? slowDiskMs : 0,
          heldHeapMb: heldHeapMb(),
          workingSetTrims: trimmer?.trims ?? 0,
        },
        machine: stopMachineSampler(),
        worstGapMs,
        maxGapMs,
        pass: code === 0,
        eventLoop: run.eventLoop,
        gapTicker: run.gapTicker,
        resume: run.operations.resume,
        operations: Object.fromEntries(
          Object.entries(run.operations)
            .filter(([, value]) => value && typeof value === 'object' && 'maxMs' in value)
            .map(([name, value]) => [name, { completed: value.completed, errors: value.errors, p95Ms: value.p95Ms, maxMs: value.maxMs }])
        ),
        supervisorLines: supervisor.map((line) => line.slice(0, 300)),
        supervisorExtended: supervisor.some((line) => /still working/.test(line)),
        supervisorKilled: supervisor.some((line) => /killing it/.test(line)),
      },
      null,
      2
    )
  );
} finally {
  trimmer?.kill();
  await daemon?.dispose?.();
  await fake.close();
}
process.exitCode = code;
