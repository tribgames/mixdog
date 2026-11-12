#!/usr/bin/env node
// Before/after comparison of the daemon stress probe that says when it cannot
// be trusted. Runs scripts/daemon-stress-probe.mjs on two trees strictly
// alternately (A, B, A, B, ...; never overlapping), each run with a
// --cpu-prof of the daemon, and prints one JSON table:
//   - per run: worstGapMs, the machine's mean CPU load and lowest available
//     memory while it ran (recorded by the probe);
//   - per run, from the daemon's CPU profile (the last duration+5 s of it):
//     ownBlockingMs, the longest stretch of consecutive non-idle samples counted
//     only as the daemon actually ran (each sample capped at 2 sampling
//     intervals) = the daemon's own synchronous work, and notScheduledMs, the
//     rest of that stretch = time the process was in a run but not on a CPU;
//   - valid: false (and no verdict) when the two series' mean CPU loads differ
//     by more than --load-margin-pct (default 10 points).
//
//   node scripts/daemon-stress-compare.mjs --before <tree> --after <tree>
//     [--pairs 4] [--load-margin-pct 10] [--duration-ms 30000]
//     [--memory-pressure-mb <n>] [--slow-disk-ms <n>] [--size-scale <n>]
//     (the last three are the probe's injections, handed to every run of both
//     series and listed in the output as `injected`)
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const args = new Map();
for (let i = 2; i < process.argv.length; i += 2) args.set(process.argv[i].replace(/^--/, ''), process.argv[i + 1]);
const before = args.get('before');
const after = args.get('after');
if (!before || !after) throw new Error('--before <tree> and --after <tree> are required');
const pairs = Number(args.get('pairs') ?? 4);
const marginPct = Number(args.get('load-margin-pct') ?? 10);
const durationMs = Number(args.get('duration-ms') ?? 30_000);
const probe = fileURLToPath(new URL('./daemon-stress-probe.mjs', import.meta.url));
const SAMPLE_INTERVAL_US = 1000;
// The probe's own options: both series run under the same injection.
const PROBE_OPTIONS = ['memory-pressure-mb', 'slow-disk-ms', 'size-scale'];
const probeArgs = PROBE_OPTIONS.filter((name) => args.has(name)).flatMap((name) => [`--${name}`, String(args.get(name))]);
const known = new Set(['before', 'after', 'pairs', 'load-margin-pct', 'duration-ms', ...PROBE_OPTIONS]);
const unknown = [...args.keys()].filter((name) => !known.has(name));
if (unknown.length) throw new Error(`unknown option(s): ${unknown.map((name) => `--${name}`).join(', ')}`);

/** The daemon's own blocking in a profile's last `windowMs`, split from not-scheduled time. */
export function blockingFromProfile(profile, windowMs) {
  const idle = new Set(profile.nodes.filter((node) => node.callFrame.functionName === '(idle)').map((node) => node.id));
  const endUs = profile.startTime + profile.timeDeltas.reduce((a, b) => a + b, 0);
  let at = profile.startTime;
  let runWall = 0;
  let runOwn = 0;
  let worst = { wallMs: 0, ownMs: 0 };
  profile.samples.forEach((id, index) => {
    const delta = profile.timeDeltas[index];
    at += delta;
    if (at < endUs - windowMs * 1000) return;
    if (idle.has(id)) {
      runWall = 0;
      runOwn = 0;
      return;
    }
    runWall += delta;
    runOwn += Math.min(delta, 2 * SAMPLE_INTERVAL_US);
    if (runWall > worst.wallMs * 1000) worst = { wallMs: runWall / 1000, ownMs: runOwn / 1000 };
  });
  return {
    ownBlockingMs: Math.round(worst.ownMs),
    notScheduledMs: Math.round(worst.wallMs - worst.ownMs),
  };
}

const mean = (values) => values.reduce((a, b) => a + b, 0) / values.length;
const runs = [];
for (let pair = 0; pair < pairs; pair += 1) {
  for (const [side, tree] of [['before', before], ['after', after]]) {
    const profDir = mkdtempSync(join(tmpdir(), `stress-prof-${side}-`));
    const result = spawnSync(
      process.execPath,
      [probe, '--tree', tree, '--label', side, '--duration-ms', String(durationMs), '--cpu-prof-dir', profDir, ...probeArgs],
      { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }
    );
    const report = JSON.parse(result.stdout.slice(result.stdout.indexOf('{')));
    const file = readdirSync(profDir).find((name) => name.endsWith('.cpuprofile'));
    const blocking = file
      ? blockingFromProfile(JSON.parse(readFileSync(join(profDir, file), 'utf8')), durationMs + 5000)
      : { ownBlockingMs: null, notScheduledMs: null };
    runs.push({
      side,
      worstGapMs: report.worstGapMs,
      cpuLoadMeanPct: report.machine.cpuLoadMeanPct,
      availableMemoryMinMb: report.machine.availableMemoryMinMb,
      ...blocking,
    });
  }
}

const series = (side) => runs.filter((run) => run.side === side);
const summary = (side) => {
  const rows = series(side);
  const pick = (key) => rows.map((row) => row[key]).filter((value) => value !== null);
  return {
    runs: rows.length,
    worstGapMs: pick('worstGapMs'),
    ownBlockingMs: pick('ownBlockingMs'),
    notScheduledMs: pick('notScheduledMs'),
    cpuLoadMeanPct: Math.round(mean(pick('cpuLoadMeanPct')) * 10) / 10,
  };
};
const beforeSummary = summary('before');
const afterSummary = summary('after');
const loadDifference = Math.abs(beforeSummary.cpuLoadMeanPct - afterSummary.cpuLoadMeanPct);
const valid = loadDifference <= marginPct;
console.log(
  JSON.stringify(
    {
      order: runs.map((run) => run.side).join(','),
      injected: probeArgs.join(' ') || 'none',
      loadMarginPct: marginPct,
      loadDifferencePct: Math.round(loadDifference * 10) / 10,
      valid,
      verdict: valid
        ? {
            medianOwnBlockingMs: {
              before: median(beforeSummary.ownBlockingMs),
              after: median(afterSummary.ownBlockingMs),
            },
            medianWorstGapMs: { before: median(beforeSummary.worstGapMs), after: median(afterSummary.worstGapMs) },
          }
        : 'invalid: the series ran under loads that differ by more than the margin; no comparison is claimed',
      before: beforeSummary,
      after: afterSummary,
      runs,
    },
    null,
    2
  )
);

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted.length ? sorted[Math.floor(sorted.length / 2)] : null;
}
