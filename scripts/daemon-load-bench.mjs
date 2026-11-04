#!/usr/bin/env node
// Daemon main-thread load benchmark: a real daemon of the given source tree
// hosts N sessions (each over its own client attachment), then idles. Reports
// event-loop delay, the share of main-thread time spent in timer callbacks,
// event-loop utilization and process CPU for two windows: opening the
// sessions, and the steady state after them.
//
//   node scripts/daemon-load-bench.mjs [--tree <root>] [--label <name>]
//     [--sessions 20] [--settle-ms 8000] [--steady-ms 30000]
//     [--cpu-prof-dir <dir>] [--root-base <dir>]
//
// --tree defaults to this checkout; point it at an older release's tree to
// compare (the daemon, its session client and its protocol are that tree's own;
// only the probe and this driver come from here). Prints one JSON document.
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { launchObservedDaemon } from '../src/standalone/test-fixtures/daemon-steady-harness.mjs';

const args = new Map();
for (let i = 2; i < process.argv.length; i += 2) args.set(process.argv[i].replace(/^--/, ''), process.argv[i + 1]);
const number = (name, fallback) => Number(args.get(name) ?? fallback);
const treeRoot = args.get('tree') ?? fileURLToPath(new URL('..', import.meta.url));
const sessions = number('sessions', 20);
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

const daemon = await launchObservedDaemon({
  tree: treeRoot,
  ...(args.get('root-base') ? { base: args.get('root-base') } : {}),
  execArgv: cpuProfDir ? ['--cpu-prof', '--cpu-prof-dir', cpuProfDir] : [],
});
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
