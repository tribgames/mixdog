#!/usr/bin/env node
// Daemon main-thread load benchmark: a real daemon of the given source tree
// hosts N sessions (each over its own client attachment), then idles. Reports
// event-loop delay, the share of main-thread time spent in timer callbacks,
// event-loop utilization and process CPU for two windows: opening the
// sessions, and the steady state after them.
//
//   node scripts/daemon-load-bench.mjs [--tree <root>] [--label <name>]
//     [--scenario idle|busy] [--sessions 20] [--settle-ms 8000] [--steady-ms 30000]
//     [--cpu-prof-dir <dir>] [--root-base <dir>]
//
// --scenario busy (default idle, which is the above): --sessions busy sessions
// (default 12) with multi-MB seeded transcripts save concurrently while
// session.list refreshes from storage, a second process holds
// session-summaries.json.lock and workspace management runs on a git repo.
//     [--duration-ms 60000] [--store-files 300] [--size-scale 1] [--seed 1]
//     [--save-interval-ms 250] [--list-interval-ms 1000]
//     [--workspace-interval-ms 2000] [--lock-hold-ms 3000] [--lock-every-ms 10000]
//     [--list-refresh true]  (also list with a storage rescan, the TUI resume picker's call;
//      the default listing is the desktop sidebar's: session.list refreshFromStorage:false)
//     [--turn-interval-ms 4000] [--create-interval-ms 1500]
//     [--worktree-interval-ms 4000] [--agent-interval-ms 3000]
//     (turn-interval-ms 0: no scripted provider, no turns/spawns)
//
// --tree defaults to this checkout; point it at an older release's tree to
// compare (the daemon, its session client and its protocol are that tree's own;
// only the probe and this driver come from here). Prints one JSON document.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { runBusyScenario } from '../src/standalone/test-fixtures/daemon-busy-scenario.mjs';
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
const scenario = args.get('scenario') ?? 'idle';
// Idle: sessions opened and left alone (default 20). Busy: sessions that save.
const sessions = number('sessions', scenario === 'busy' ? 12 : 20);
const cpuProfDir = args.get('cpu-prof-dir');

const TARGETS = { p99Ms: 50, maxMs: 250, periodicPercent: 5 };

function summarize(report, top = number('top', 8)) {
  const timerSites = [...report.timers].sort((a, b) => b.busyMs - a.busyMs);
  return {
    windowMs: report.elapsedMs,
    delayMs: report.delayMs,
    periodicPercent: Math.round((report.timerBusyMs / report.elapsedMs) * 1000) / 10,
    utilizationPercent: Math.round(report.utilization * 1000) / 10,
    cpuPercent: report.cpuPercent,
    timerFires: report.timers.reduce((sum, timer) => sum + timer.fires, 0),
    syncFsCalls: report.syncFs.reduce((sum, call) => sum + call.count, 0),
    topTimers: timerSites.slice(0, top).map(({ site, kind, fires, busyMs, delay: ms }) => ({
      site: site.replace(/^.*[\\/]src[\\/]/, 'src/'),
      kind,
      delayMs: ms,
      fires,
      busyMs,
    })),
    topSyncFs: [...report.syncFs]
      .sort((a, b) => b.count - a.count)
      .slice(0, top)
      .map(({ method, site, count }) => ({ method, site: site.replace(/^.*[\\/]src[\\/]/, 'src/'), count })),
  };
}

// The busy scenario's window adds what it diagnoses with; the idle phases keep
// their original shape.
function summarizeBusy(report) {
  const waits = report.atomicsWaits ?? [];
  return {
    ...summarize(report),
    storageTouches: report.storageTouches ?? {},
    atomicsWait: {
      count: waits.reduce((sum, wait) => sum + wait.count, 0),
      blockedMs: waits.reduce((sum, wait) => sum + wait.blockedMs, 0),
      top: [...waits]
        .sort((a, b) => b.blockedMs - a.blockedMs)
        .slice(0, 5)
        .map(({ site, count, blockedMs }) => ({ site: site.replace(/^.*[\\/]src[\\/]/, 'src/'), count, blockedMs })),
    },
  };
}

const launchOptions = {
  tree: treeRoot,
  // A module the daemon loads first (diagnosis: stub or instrument something).
  ...(args.get('mutation') ? { mutation: args.get('mutation') } : {}),
  ...(args.get('root-base') ? { base: args.get('root-base') } : {}),
  execArgv: cpuProfDir ? ['--cpu-prof', '--cpu-prof-dir', cpuProfDir] : [],
};

async function runIdle() {
  const daemon = await launchObservedDaemon(launchOptions);
  try {
    await daemon.window.start();
    const openStartedAt = performance.now();
    await daemon.openSessions(sessions);
    const openMs = Math.round(performance.now() - openStartedAt);
    const opening = summarize(await daemon.window.stop());

    await delay(number('settle-ms', 8000));
    await daemon.window.start();
    await delay(number('steady-ms', 30_000));
    const steady = summarize(await daemon.window.stop());

    const verdict = (phase) => ({
      p99: phase.delayMs.p99 <= TARGETS.p99Ms,
      max: phase.delayMs.max <= TARGETS.maxMs,
      periodic: phase.periodicPercent <= TARGETS.periodicPercent,
    });
    console.log(
      JSON.stringify(
        {
          tree: treeRoot,
          label: args.get('label') ?? treeRoot,
          node: process.version,
          sessions,
          openMs,
          targets: TARGETS,
          opening: { ...opening, meetsTargets: verdict(opening) },
          steady: { ...steady, meetsTargets: verdict(steady) },
        },
        null,
        2
      )
    );
  } finally {
    await daemon.dispose();
  }
}

// Busy sessions: `--sessions` busy sessions with multi-MB records saving
// concurrently while session.list refreshes, a second process holds the summary
// index lock and workspace management runs. The daemon-side window is
// `--duration-ms` long.
async function runBusy() {
  const config = {
    seed: number('seed', 1),
    busySessions: sessions,
    storeFiles: number('store-files', 300),
    sizeScale: number('size-scale', 1),
    durationMs: number('duration-ms', 60_000),
    saveIntervalMs: number('save-interval-ms', 250),
    listIntervalMs: number('list-interval-ms', 1000),
    workspaceIntervalMs: number('workspace-interval-ms', 2000),
    lockHoldMs: number('lock-hold-ms', 3000),
    lockEveryMs: number('lock-every-ms', 10_000),
    // Off: the desktop never rescans storage; the TUI resume picker does.
    listRefresh: args.get('list-refresh') === 'true',
    // 0 disables: turns on the busy sessions, session creation, worktree
    // requests and agent calls (the last two need `turn-interval-ms` > 0 only
    // for the sub-agent spawn).
    turnIntervalMs: number('turn-interval-ms', 4000),
    createIntervalMs: number('create-interval-ms', 1500),
    worktreeIntervalMs: number('worktree-interval-ms', 4000),
    agentIntervalMs: number('agent-interval-ms', 3000),
  };
  const startedAt = performance.now();
  let seeded = null;
  let repoDir = '';
  // Scripted OpenAI-compatible endpoint, declared to the daemon as a custom
  // provider (a feature of both releases) in the isolated config.
  const fake = config.turnIntervalMs > 0 ? await startFakeProvider() : null;
  let daemon;
  try {
    daemon = await launchObservedDaemon({
      ...launchOptions,
      prepare: async ({ root, dataDir }) => {
        repoDir = createFixtureRepo(join(root, 'repo'));
        if (fake) writeCustomProviderConfig(dataDir, fake.baseURL);
        seeded = await seedBusyStore({
          treeRoot,
          dataDir,
          cwd: root,
          busyCwd: repoDir,
          busy: config.busySessions,
          files: config.storeFiles,
          seed: config.seed,
          sizeScale: config.sizeScale,
          ...(fake ? { provider: FAKE_PROVIDER_ID, model: FAKE_MODEL } : {}),
        });
      },
    });
  } catch (error) {
    await fake?.close();
    throw error;
  }
  const seedAndLaunchMs = Math.round(performance.now() - startedAt);
  try {
    const run = await runBusyScenario({ daemon, treeRoot, seeded, repoDir, config, summarize: summarizeBusy, fake });
    const treeVersion = JSON.parse(readFileSync(join(treeRoot, 'package.json'), 'utf8')).version;
    console.log(
      JSON.stringify(
        {
          scenario: 'busy',
          tree: treeRoot,
          label: args.get('label') ?? treeRoot,
          treeVersion,
          node: process.version,
          platform: `${process.platform} ${process.arch}`,
          seedAndLaunchMs,
          totalWallMs: Math.round(performance.now() - startedAt),
          seeded: {
            storeFiles: seeded.storeFiles,
            storeMb: Math.round(seeded.storeBytes / 1024 / 102.4) / 10,
            busy: seeded.busy,
          },
          ...run,
        },
        null,
        2
      )
    );
  } catch (error) {
    // The run failed: still one JSON document, with what the cleanup saw.
    console.log(
      JSON.stringify(
        {
          scenario: 'busy',
          tree: treeRoot,
          label: args.get('label') ?? treeRoot,
          failed: true,
          error: String(error?.message || error),
          ...(error?.cleanupProbeUnanswered
            ? { cleanupProbeUnanswered: true, cleanupProbeWaitedMs: error.cleanupProbeWaitedMs }
            : {}),
        },
        null,
        2
      )
    );
    process.exitCode = 1;
  } finally {
    try {
      await daemon.dispose();
    } finally {
      await fake?.close();
    }
  }
}

if (scenario === 'idle') await runIdle();
else if (scenario === 'busy') await runBusy();
else throw new Error(`unknown --scenario ${scenario} (idle | busy)`);
