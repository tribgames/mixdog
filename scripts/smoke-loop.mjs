#!/usr/bin/env node
import { appendFileSync, mkdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_DURATION_MS = 5 * 60 * 60 * 1000;

function argValue(name, fallback = null) {
  const idx = process.argv.indexOf(name);
  if (idx >= 0 && idx + 1 < process.argv.length) return process.argv[idx + 1];
  const prefix = `${name}=`;
  const hit = process.argv.find((arg) => arg.startsWith(prefix));
  return hit ? hit.slice(prefix.length) : fallback;
}

function argFlag(name) {
  return process.argv.includes(name);
}

function parseDuration(value, fallback) {
  const raw = String(value || '').trim();
  if (!raw) return fallback;
  if (/^\d+$/.test(raw)) return Number(raw);
  const match = raw.match(/^(\d+(?:\.\d+)?)(ms|s|m|h)$/i);
  if (!match) throw new Error(`invalid duration: ${raw}`);
  const n = Number(match[1]);
  const unit = match[2].toLowerCase();
  const mult = unit === 'ms' ? 1 : unit === 's' ? 1000 : unit === 'm' ? 60_000 : 3_600_000;
  return Math.max(1, Math.floor(n * mult));
}

function resolveOptionalPath(value, fallback) {
  const raw = String(value || '').trim();
  const picked = raw || fallback;
  if (!picked) return null;
  return isAbsolute(picked) ? picked : resolve(root, picked);
}

function runNode(args, label, timeoutMs = 180_000) {
  const startedAt = performance.now();
  const result = spawnSync(process.execPath, args, {
    cwd: root,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: timeoutMs,
    windowsHide: true,
  });
  const ms = performance.now() - startedAt;
  if (result.status !== 0) {
    const out = `${result.error ? `${result.error}\n` : ''}${result.stdout || ''}${result.stderr || ''}`.trim();
    throw new Error(`${label} failed in ${ms.toFixed(1)}ms:\n${out}`);
  }
  return { ms, stdout: result.stdout || '', stderr: result.stderr || '' };
}

function runSmokeAll(iteration) {
  let totalMs = 0;
  const steps = [];
  for (const script of ['scripts/boot-smoke.mjs', 'scripts/tool-smoke.mjs']) {
    const result = runNode([script], `${script} iteration ${iteration}`);
    totalMs += result.ms;
    steps.push({
      script,
      ms: Math.round(result.ms * 10) / 10,
    });
  }
  return { ms: totalMs, steps };
}

function sleep(ms) {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

function rssMb() {
  return Math.round((process.memoryUsage().rss / 1024 / 1024) * 10) / 10;
}

function summarize(values) {
  if (!values.length) return { min: 0, max: 0, avg: 0 };
  const min = Math.min(...values);
  const max = Math.max(...values);
  const avg = values.reduce((sum, value) => sum + value, 0) / values.length;
  return {
    min: Math.round(min * 10) / 10,
    max: Math.round(max * 10) / 10,
    avg: Math.round(avg * 10) / 10,
  };
}

function serializeError(error) {
  return {
    name: error?.name || 'Error',
    message: error?.message || String(error),
    stack: error?.stack || null,
  };
}

const durationMs = parseDuration(argValue('--duration', process.env.MIXDOG_SMOKE_LOOP_DURATION), DEFAULT_DURATION_MS);
const intervalMs = parseDuration(argValue('--interval', process.env.MIXDOG_SMOKE_LOOP_INTERVAL), 0);
const maxIterations = Number(argValue('--iterations', process.env.MIXDOG_SMOKE_LOOP_ITERATIONS || 0)) || Infinity;
const logPath = argFlag('--no-log')
  ? null
  : resolveOptionalPath(
    argValue('--log', process.env.MIXDOG_SMOKE_LOOP_LOG),
    '.mixdog/data/history/smoke-loop.jsonl',
  );
const startedAt = Date.now();
const since = new Date(startedAt).toISOString();
const deadline = startedAt + durationMs;
let iteration = 0;
const smokeTimes = [];
const rssSamples = [];

function writeLoopLog(row) {
  if (!logPath) return;
  mkdirSync(dirname(logPath), { recursive: true });
  appendFileSync(logPath, `${JSON.stringify({
    ts: new Date().toISOString(),
    pid: process.pid,
    ...row,
  })}\n`, { encoding: 'utf8', mode: 0o600 });
}

function writeFatalLog(error) {
  writeLoopLog({
    type: 'error',
    iteration,
    elapsed_ms: Date.now() - startedAt,
    error: serializeError(error),
  });
}

process.on('uncaughtException', (error) => {
  writeFatalLog(error);
  process.stderr.write(`${error?.stack || error}\n`);
  process.exit(1);
});

process.on('unhandledRejection', (reason) => {
  const error = reason instanceof Error ? reason : new Error(String(reason));
  writeFatalLog(error);
  process.stderr.write(`${error.stack || error}\n`);
  process.exit(1);
});

const startRss = rssMb();
writeLoopLog({
  type: 'start',
  duration_ms: durationMs,
  interval_ms: intervalMs,
  max_iterations: Number.isFinite(maxIterations) ? maxIterations : null,
  since,
  rss_mb: startRss,
});
process.stdout.write(`smoke loop start duration=${durationMs}ms interval=${intervalMs}ms since=${since} rss_mb=${startRss} log=${logPath || 'off'}\n`);

while (Date.now() < deadline && iteration < maxIterations) {
  iteration += 1;
  const iterStartedAt = Date.now();
  const smoke = runSmokeAll(iteration);
  smokeTimes.push(smoke.ms);
  const failure = runNode(['scripts/tool-failures.mjs', '--since', since, '--limit', '1'], `failures iteration ${iteration}`, 60_000);
  if (!/tool failures:\s+0\/0 shown/.test(failure.stdout)) {
    throw new Error(`tool failures appeared after loop start:\n${failure.stdout}`);
  }
  const currentRss = rssMb();
  rssSamples.push(currentRss);
  const elapsedMs = Date.now() - startedAt;
  writeLoopLog({
    type: 'iteration',
    iteration,
    smoke_ms: Math.round(smoke.ms * 10) / 10,
    steps: smoke.steps,
    rss_mb: currentRss,
    elapsed_ms: elapsedMs,
  });
  const stepSummary = smoke.steps.map((step) => `${step.script.replace(/^scripts\//, '')}=${step.ms}ms`).join(' ');
  process.stdout.write(`iteration ${iteration} ok smoke_ms=${smoke.ms.toFixed(1)} ${stepSummary} rss_mb=${currentRss} elapsed_ms=${elapsedMs}\n`);
  const remaining = deadline - Date.now();
  if (remaining <= 0 || iteration >= maxIterations) break;
  if (intervalMs > 0) await sleep(Math.min(intervalMs, remaining));
  if (Date.now() === iterStartedAt) await sleep(1);
}

const smokeSummary = summarize(smokeTimes);
const rssSummary = summarize(rssSamples);
const totalElapsedMs = Date.now() - startedAt;
writeLoopLog({
  type: 'summary',
  iterations: iteration,
  elapsed_ms: totalElapsedMs,
  smoke_ms: smokeSummary,
  rss_mb: rssSummary,
});
process.stdout.write(
  `smoke loop passed iterations=${iteration} elapsed_ms=${totalElapsedMs} `
  + `smoke_ms=min:${smokeSummary.min},avg:${smokeSummary.avg},max:${smokeSummary.max} `
  + `rss_mb=min:${rssSummary.min},avg:${rssSummary.avg},max:${rssSummary.max}\n`,
);
