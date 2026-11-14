// The latency gate of the engine path: the browser tool runs through the core's engine (Electron is the host role, the core
// is a test-hooks mixdogd on an isolated profile) and each scenario's median `commandMs` is held to its baseline.
//   node apps/desktop/scripts/run-browser-latency-gate.mjs [--reps 10] [--warmup 1] [--out <file.json>]
// The core binary is MIXDOGD_TEST_BIN (a build with --features test-hooks), else MIXDOGD_BIN. Run it on an idle machine:
// CPU load above 20% before or after the run makes the timings invalid (exit 2). Exit 0: every scenario passed; 1: one failed.
//
// commandMs is read from the core's `browser_timing` rows (MIXDOG_AGENT_TRACE_TIMING, written to a file this script names),
// joined to the calls by `turn_id`. The harness side (src/main/browser/latency-scenarios.ts) writes one row per call with the
// events and the `host/browser/*` requests it saw; both are reported.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { readFile, rm, writeFile } from 'node:fs/promises';
import { cpus, loadavg, tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { startCore } from '../../../scripts/rust-core/lib/core-session.mjs';
import { computerSourceEsbuildPlugin } from './computer-source-assets.mjs';
import { bundleElectronEntry, electronProcessEnv, spawnElectron, waitForChildExit, withTempWorkspace } from './electron-harness.mjs';

const ELECTRON_LIMIT_MS = 5 * 60_000;
const CPU_LIMIT_PERCENT = 20;
const ROW_PREFIX = 'latency-gate-row ';

/** Median commandMs of the host path in the browser host integration harness (lat-a r1 summary.md, visible page, n=10). */
export const BASELINE_COMMAND_MS = {
  'navigate:root-fixture': 30.1,
  'snapshot:form': 1.4,
  'snapshot:frames': 1.3,
  'type:ascii10': 25.7,
  'type:ascii50': 47.0,
  'type:ascii200': 94.9,
  'type:korean50': 34.4,
  'click:no-iframe': 29.1,
};
/** A scenario passes while its median is within baseline + 10% + 5 ms. */
export const allowedCommandMs = (baseline) => baseline * 1.1 + 5;
/** R3: events and bytes the core is sent per typed character. */
export const MAX_EVENTS_PER_CHAR = 20;
export const MAX_BYTES_PER_CHAR = 10 * 1024;

export function median(values) {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!sorted.length) return null;
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

/**
 * The verdicts of a run. `rows` are the harness rows, `timings` maps turn_id to the core's `browser_timing` payload.
 * Warmups are not measured. A scenario with a baseline fails when it has no measured call with a commandMs.
 */
export function evaluate(rows, timings) {
  const byScenario = new Map();
  for (const row of rows) {
    if (row.warmup) continue;
    if (!byScenario.has(row.scenario)) byScenario.set(row.scenario, []);
    byScenario.get(row.scenario).push(row);
  }
  const results = [];
  const scenarios = new Set([...Object.keys(BASELINE_COMMAND_MS), ...byScenario.keys()]);
  for (const scenario of scenarios) {
    const measured = byScenario.get(scenario) ?? [];
    const baseline = BASELINE_COMMAND_MS[scenario];
    const commandMs = median(measured.map((row) => timings.get(row.turnId)?.commandMs));
    const result = {
      scenario,
      n: measured.length,
      commandMs,
      baseline: baseline ?? null,
      limit: baseline === undefined ? null : allowedCommandMs(baseline),
      hostCalls: median(measured.map((row) => row.hostCalls)),
      problems: [],
    };
    if (baseline !== undefined) {
      if (commandMs === null) result.problems.push('no browser_timing row with a commandMs');
      else if (commandMs > result.limit) result.problems.push(`commandMs ${commandMs.toFixed(1)} > ${result.limit.toFixed(1)}`);
    }
    const typed = measured.filter((row) => row.chars);
    if (typed.length) {
      result.eventsPerChar = median(typed.map((row) => row.events / row.chars));
      result.bytesPerChar = median(typed.map((row) => row.eventBytes / row.chars));
      if (result.eventsPerChar >= MAX_EVENTS_PER_CHAR) result.problems.push(`events/char ${result.eventsPerChar.toFixed(2)} >= ${MAX_EVENTS_PER_CHAR}`);
      if (result.bytesPerChar >= MAX_BYTES_PER_CHAR) result.problems.push(`bytes/char ${Math.round(result.bytesPerChar)} >= ${MAX_BYTES_PER_CHAR}`);
    }
    result.pass = result.problems.length === 0;
    results.push(result);
  }
  return results;
}

/** The `browser_timing` rows of the core's agent trace by turn_id (payload: queueMs, commandMs, ...). */
export function readTimings(traceText) {
  const timings = new Map();
  for (const line of traceText.split(/\r?\n/)) {
    if (!line.startsWith('{')) continue;
    let row;
    try {
      row = JSON.parse(line);
    } catch {
      continue;
    }
    if (row.kind === 'browser_timing' && row.turn_id !== undefined && row.payload) timings.set(row.turn_id, row.payload);
  }
  return timings;
}

function cpuLoad() {
  if (process.platform !== 'win32') return (loadavg()[0] / cpus().length) * 100;
  const script =
    "$v = @(); for ($i = 0; $i -lt 3; $i++) { $v += [double]((Get-CimInstance Win32_Processor | Measure-Object -Property LoadPercentage -Average).Average); if ($i -lt 2) { Start-Sleep -Seconds 1 } }; ($v | Measure-Object -Average).Average";
  const out = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8', windowsHide: true, timeout: 30_000 });
  return Number(out.trim());
}

function flag(name) {
  const at = process.argv.indexOf(`--${name}`);
  if (at >= 0) return process.argv[at + 1];
  return process.argv.find((arg) => arg.startsWith(`--${name}=`))?.slice(name.length + 3);
}

const format = (value, digits = 1) => (value === null || value === undefined || !Number.isFinite(value) ? '-' : value.toFixed(digits));

function report(results) {
  for (const result of results) {
    const parts = [
      result.pass ? 'PASS' : 'FAIL',
      result.scenario.padEnd(24),
      `n=${result.n}`,
      `commandMs median ${format(result.commandMs)}`,
      result.baseline === null ? 'no baseline' : `baseline ${format(result.baseline)} limit ${format(result.limit)}`,
      `host calls/command ${format(result.hostCalls, 0)}`,
    ];
    if (result.eventsPerChar !== undefined) parts.push(`events/char ${format(result.eventsPerChar, 2)} bytes/char ${format(result.bytesPerChar, 0)}`);
    console.log(parts.join('  '));
    for (const problem of result.problems) console.log(`       ${problem}`);
  }
}

async function main() {
  const bin = process.env.MIXDOGD_TEST_BIN || process.env.MIXDOGD_BIN;
  if (!bin || !existsSync(bin)) {
    console.error('MIXDOGD_TEST_BIN (a mixdogd built with --features test-hooks) names no file.');
    return 2;
  }
  const cpuBefore = cpuLoad();
  const testSupport = fileURLToPath(new URL('../src/main/browser/test-support/', import.meta.url));
  const scenarios = fileURLToPath(new URL('../src/main/browser/latency-scenarios.ts', import.meta.url));
  const coreRoot = mkdtempSync(join(tmpdir(), 'mixdog-browser-latency-'));
  const traceFile = join(coreRoot, 'agent-trace.jsonl');
  let core = null;
  let progress = '';
  try {
    core = await startCore({
      bin,
      root: coreRoot,
      extraEnv: { MIXDOGD_TEST_HOOKS: '1', MIXDOG_AGENT_TRACE_TIMING: '1', MIXDOG_AGENT_TRACE_PATH: traceFile },
      clientName: 'browser-latency-gate',
    });
    await withTempWorkspace('mixdog-browser-latency-gate-', async (staging) => {
      const output = join(staging, 'browser-latency-gate.mjs');
      const entry = join(staging, 'entry.ts');
      const progressPath = join(staging, 'progress.log');
      await writeFile(
        entry,
        `import { progress, runCoreHarnessSuite } from ${JSON.stringify(join(testSupport, 'core-harness.ts'))};\n` +
          `import { runBrowserEngineLatencyGate } from ${JSON.stringify(scenarios)};\n` +
          'runCoreHarnessSuite((harness) => runBrowserEngineLatencyGate(harness, progress));\n'
      );
      await bundleElectronEntry({
        entry,
        outfile: output,
        plugins: [computerSourceEsbuildPlugin()],
        external: ['electron', 'ws'],
        sourcemap: 'inline',
      });
      const env = electronProcessEnv({
        MIXDOG_BROWSER_INTEGRATION_LOG: progressPath,
        MIXDOG_CORE_HARNESS_RUNTIME_ROOT: core.paths.runtimeRoot,
        MIXDOG_CORE_HARNESS_ENGINE: 'core',
        MIXDOG_LATENCY_GATE_REPS: flag('reps') ?? '',
        MIXDOG_LATENCY_GATE_WARMUP: flag('warmup') ?? '',
      });
      const child = spawnElectron(output, { env });
      let exitCode;
      try {
        exitCode = await waitForChildExit(child, {
          timeoutMs: ELECTRON_LIMIT_MS,
          timeoutMessage: `the latency gate exceeded ${ELECTRON_LIMIT_MS / 1000} seconds`,
          signalMessage: (signal) => `the latency gate was terminated by ${signal}`,
        });
      } finally {
        progress = await readFile(progressPath, 'utf8').catch(() => '');
      }
      if (exitCode !== 0 || !progress.includes('integration passed')) {
        console.error(progress.split('\n').slice(-20).join('\n'));
        throw new Error(`the latency gate run failed before its success marker (exit ${exitCode})`);
      }
    });
  } finally {
    // The core writes its buffered trace rows as it exits.
    if (core) await core.stop().catch((error) => console.error(error.message));
  }
  const cpuAfter = cpuLoad();
  const traceText = existsSync(traceFile) ? readFileSync(traceFile, 'utf8') : '';
  await rm(coreRoot, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }).catch(() => {});

  const rows = progress
    .split(/\r?\n/)
    .filter((line) => line.startsWith(ROW_PREFIX))
    .map((line) => JSON.parse(line.slice(ROW_PREFIX.length)));
  const results = evaluate(rows, readTimings(traceText));
  report(results);
  const out = flag('out');
  if (out) await writeFile(out, `${JSON.stringify({ cpuBefore, cpuAfter, results }, null, 2)}\n`);
  if (!(cpuBefore < CPU_LIMIT_PERCENT && cpuAfter < CPU_LIMIT_PERCENT)) {
    console.log(`INVALID: CPU load ${format(cpuBefore, 0)}% before and ${format(cpuAfter, 0)}% after (the timings need under ${CPU_LIMIT_PERCENT}%).`);
    return 2;
  }
  const failed = results.filter((result) => !result.pass);
  console.log(failed.length ? `latency gate FAILED: ${failed.map((result) => result.scenario).join(', ')}` : 'latency gate passed');
  return failed.length ? 1 : 0;
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) process.exitCode = await main();
