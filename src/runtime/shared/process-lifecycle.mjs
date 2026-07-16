'use strict';

import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { withFileLockSync } from './atomic-file.mjs';
import { resolvePluginData } from './plugin-paths.mjs';

export const LIFECYCLE_LEDGER_MAX_BYTES = 64 * 1024;
export const LIFECYCLE_LEDGER_KEEP_FILES = 2;
const LEDGER_NAME = 'process-lifecycle.jsonl';
const MARKER_DIR_NAME = 'process-lifecycle.active';
const LEGACY_MARKER_NAME = 'process-lifecycle.active.json';
const REPORT_NAME = 'mixdog-node-report.json';
const LEDGER_LOCK_NAME = 'process-lifecycle.lock';
const LEDGER_LOCK_TIMEOUT_MS = 2000;
const LEDGER_LOCK_STALE_MS = 10000;
const IDENTITY_UPGRADE_DELAYS_MS = [1000, 9000, 20000];
const STATE_KEY = Symbol.for('mixdog.processLifecycle.v1');
const VALID_REASONS = new Set([
  'process-start',
  'prior-process-vanished',
  'clean-shutdown',
  'catchable-fatal-error',
  'forced-cleanup',
]);

function sharedState() {
  if (!globalThis[STATE_KEY]) globalThis[STATE_KEY] = { active: null };
  return globalThis[STATE_KEY];
}

function paths(directory) {
  const dir = directory || join(resolvePluginData(), 'diagnostics');
  return {
    dir,
    ledger: join(dir, LEDGER_NAME),
    previousLedger: join(dir, `${LEDGER_NAME}.1`),
    markerDir: join(dir, MARKER_DIR_NAME),
    legacyMarker: join(dir, LEGACY_MARKER_NAME),
    lock: join(dir, LEDGER_LOCK_NAME),
    report: join(dir, REPORT_NAME),
  };
}

function memoryCounters() {
  try {
    const value = process.memoryUsage();
    return {
      rss: value.rss,
      heapTotal: value.heapTotal,
      heapUsed: value.heapUsed,
      external: value.external,
      arrayBuffers: value.arrayBuffers,
    };
  } catch {
    return {};
  }
}

function rotateLedger(active) {
  const size = Number(statSync(active.ledger).size) || 0;
  try { unlinkSync(active.previousLedger); } catch {}
  if (size <= LIFECYCLE_LEDGER_MAX_BYTES) {
    renameSync(active.ledger, active.previousLedger);
    return;
  }

  // An oversized file cannot have been produced by this writer. Do not carry
  // an untrusted/partial record into the retained generation.
  writeFileSync(active.previousLedger, '', { mode: 0o600 });
  unlinkSync(active.ledger);
}

function boundPreviousLedger(active) {
  if (existsSync(active.previousLedger)
    && statSync(active.previousLedger).size > LIFECYCLE_LEDGER_MAX_BYTES) {
    writeFileSync(active.previousLedger, '', { mode: 0o600 });
  }
}

function appendEntry(active, entry) {
  const line = `${JSON.stringify(entry)}\n`;
  if (Buffer.byteLength(line) > LIFECYCLE_LEDGER_MAX_BYTES) return false;
  try {
    return withFileLockSync(active.lock, () => {
      boundPreviousLedger(active);
      if (existsSync(active.ledger)
        && statSync(active.ledger).size + Buffer.byteLength(line) > LIFECYCLE_LEDGER_MAX_BYTES) {
        rotateLedger(active);
      }
      const fd = openSync(active.ledger, 'a', 0o600);
      try {
        writeSync(fd, line, null, 'utf8');
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
      return statSync(active.ledger).size <= LIFECYCLE_LEDGER_MAX_BYTES;
    }, {
      timeoutMs: LEDGER_LOCK_TIMEOUT_MS,
      staleMs: LEDGER_LOCK_STALE_MS,
    });
  } catch {
    return false;
  }
}

function currentProcessIdentity() {
  if (process.platform !== 'linux') {
    const value = Math.floor((Date.now() - (process.uptime() * 1000)) / 1000);
    return Number.isSafeInteger(value) && value > 0
      ? { kind: 'start-seconds', value, method: 'uptime' }
      : null;
  }
  return processIdentityForPid(process.pid);
}

function windowsProcessIdentities(pids) {
  const identities = new Map();
  if (pids.length === 0) return identities;
  try {
    const out = execFileSync('powershell.exe', [
      '-NoProfile', '-NonInteractive', '-Command',
      `$ErrorActionPreference='SilentlyContinue'; Get-Process -Id @(${pids.join(',')}) | ForEach-Object { try { "$($_.Id):$(([DateTimeOffset]$_.StartTime).ToUnixTimeSeconds())" } catch {} }`,
    ], { encoding: 'utf8', timeout: 2000, windowsHide: true });
    for (const line of String(out).split(/\r?\n/)) {
      const match = /^(\d+):(\d+)$/.exec(line.trim());
      if (!match) continue;
      const pid = Number(match[1]);
      const value = Number(match[2]);
      if (Number.isSafeInteger(pid) && Number.isSafeInteger(value) && value > 0) {
        identities.set(pid, { kind: 'start-seconds', value, method: 'powershell' });
      }
    }
  } catch {}
  return identities;
}

function processIdentityForPid(pid) {
  if (process.platform === 'linux') {
    try {
      const raw = readFileSync(`/proc/${pid}/stat`, 'utf8');
      const fields = raw.slice(raw.lastIndexOf(') ') + 2).trim().split(/\s+/);
      return fields[19] && /^\d+$/.test(fields[19])
        ? { kind: 'linux-start-ticks', value: fields[19] }
        : null;
    } catch {
      return null;
    }
  }
  try {
    if (process.platform === 'win32') {
      return windowsProcessIdentities([pid]).get(pid) || null;
    }
    const out = execFileSync('ps', ['-o', 'lstart=', '-p', String(pid)], {
      encoding: 'utf8',
      timeout: 2000,
      windowsHide: true,
    });
    const value = Math.floor(Date.parse(String(out).trim()) / 1000);
    return Number.isInteger(value) ? { kind: 'start-seconds', value, method: 'ps' } : null;
  } catch {
    return null;
  }
}

function processIdentitiesForPids(pids) {
  const unique = [...new Set(pids)];
  if (process.platform !== 'win32') {
    return new Map(unique.map((pid) => [pid, processIdentityForPid(pid)]));
  }

  const identities = new Map();
  const otherPids = [];
  for (const pid of unique) {
    if (pid === process.pid) identities.set(pid, currentProcessIdentity());
    else otherPids.push(pid);
  }
  for (const [pid, identity] of windowsProcessIdentities(otherPids)) {
    identities.set(pid, identity);
  }
  return identities;
}

function sameProcessIdentity(expected, observed) {
  if (!expected || !observed || expected.kind !== observed.kind) return null;
  if (expected.kind === 'linux-start-ticks') {
    if (!/^\d+$/.test(String(expected.value)) || !/^\d+$/.test(String(observed.value))) return null;
    if (BigInt(expected.value) < 1n || BigInt(observed.value) < 1n) return null;
    return String(expected.value) === String(observed.value);
  }
  if (expected.kind === 'start-seconds') {
    if (!Number.isSafeInteger(expected.value) || expected.value < 1
      || !Number.isSafeInteger(observed.value) || observed.value < 1) return null;
    const crossMethod = expected.method === 'uptime' || observed.method === 'uptime';
    return crossMethod
      ? Math.abs(expected.value - observed.value) <= 2
      : expected.value === observed.value;
  }
  return null;
}

function recordCurrent(reason, exitCode = null) {
  const active = sharedState().active;
  if (!active || !VALID_REASONS.has(reason)) return false;
  return appendEntry(active, {
    version: 1,
    timestamp: new Date().toISOString(),
    pid: process.pid,
    ppid: process.ppid,
    reason,
    exitCode: Number.isInteger(exitCode) ? exitCode : null,
    memory: memoryCounters(),
    cwd: active.cwd,
  });
}

function recordPriorVanished(active, previous) {
  return appendEntry(active, {
    version: 1,
    timestamp: new Date().toISOString(),
    pid: previous.pid,
    ppid: Number.isInteger(previous.ppid) ? previous.ppid : null,
    reason: 'prior-process-vanished',
    exitCode: null,
  });
}

function pidLiveness(pid) {
  if (!Number.isInteger(pid) || pid < 1 || pid > 2147483647) return 'unknown';
  try {
    process.kill(pid, 0);
    return 'occupied';
  } catch (error) {
    if (error?.code === 'ESRCH') return 'dead';
    if (error?.code === 'EPERM') return 'occupied';
    return 'unknown';
  }
}

function markerOwned(active) {
  try {
    const marker = JSON.parse(readFileSync(active.markerPath, 'utf8'));
    return marker?.pid === process.pid && marker?.token === active.token;
  } catch {
    return false;
  }
}

function writeMarker(active) {
  try {
    mkdirSync(active.markerDir, { recursive: true, mode: 0o700 });
    writeFileSync(active.markerPath, `${JSON.stringify({
      version: 1,
      timestamp: new Date().toISOString(),
      pid: process.pid,
      ppid: process.ppid,
      token: active.token,
      processIdentity: active.processIdentity,
    })}\n`, { encoding: 'utf8', mode: 0o600 });
    const fd = openSync(active.markerPath, 'r');
    try { fsyncSync(fd); } finally { closeSync(fd); }
    return true;
  } catch {
    return false;
  }
}

function scheduleProcessIdentityUpgrade(active) {
  if (active.processIdentity?.method !== 'uptime') return;
  const scheduleAttempt = (attempt) => {
    if (attempt >= IDENTITY_UPGRADE_DELAYS_MS.length) return;
    const timer = setTimeout(() => {
      try {
        if (sharedState().active !== active || !markerOwned(active)) return;
        const processIdentity = processIdentityForPid(process.pid);
        if (processIdentity && processIdentity.method !== 'uptime') {
          const previousIdentity = active.processIdentity;
          active.processIdentity = processIdentity;
          if (writeMarker(active)) return;
          active.processIdentity = previousIdentity;
        }
      } catch {}
      scheduleAttempt(attempt + 1);
    }, IDENTITY_UPGRADE_DELAYS_MS[attempt]);
    timer.unref?.();
  };
  scheduleAttempt(0);
}

function reapVanishedMarkers(active) {
  const candidates = [];
  try {
    for (const entry of readdirSync(active.markerDir, { withFileTypes: true })) {
      if (entry.isFile() && entry.name.endsWith('.json')) {
        candidates.push(join(active.markerDir, entry.name));
      }
    }
  } catch {}
  if (existsSync(active.legacyMarker)) candidates.push(active.legacyMarker);
  const occupied = [];
  for (const markerPath of candidates) {
    try {
      const previous = JSON.parse(readFileSync(markerPath, 'utf8'));
      if (previous?.pid === process.pid && previous?.token !== active.token) {
        if (recordPriorVanished(active, previous)) unlinkSync(markerPath);
        continue;
      }
      const liveness = pidLiveness(previous?.pid);
      if (liveness === 'occupied') occupied.push({ markerPath, previous });
      else if (liveness === 'dead' && recordPriorVanished(active, previous)) unlinkSync(markerPath);
    } catch {}
  }
  const identities = processIdentitiesForPids(occupied.map(({ previous }) => previous.pid));
  for (const { markerPath, previous } of occupied) {
    try {
      const identityMatch = sameProcessIdentity(
        previous.processIdentity,
        identities.get(previous.pid) || null,
      );
      if (identityMatch === false && recordPriorVanished(active, previous)) unlinkSync(markerPath);
    } catch {}
  }
}

function configureNodeReports(reportPath, safeCommandLine) {
  const report = process.report;
  if (!report || !safeCommandLine || !('excludeEnv' in report)) return false;
  try {
    report.directory = '';
    report.filename = reportPath;
    report.compact = true;
    report.excludeEnv = true;
    if ('excludeNetwork' in report) report.excludeNetwork = true;
    report.reportOnFatalError = true;
    report.reportOnUncaughtException = true;
    return true;
  } catch {
    return false;
  }
}

export function beginProcessLifecycle({
  directory,
  configureReports = true,
  safeCommandLine = process.argv.length <= 2,
} = {}) {
  const state = sharedState();
  if (state.active) return state.active.api;
  const resolved = paths(directory);
  try {
    mkdirSync(resolved.dir, { recursive: true, mode: 0o700 });
    mkdirSync(resolved.markerDir, { recursive: true, mode: 0o700 });
  } catch {}
  const token = `${Date.now().toString(36)}-${process.hrtime.bigint().toString(36)}`;
  const active = {
    ...resolved,
    token,
    processIdentity: currentProcessIdentity(),
    markerPath: join(resolved.markerDir, `${process.pid}-${token}.json`),
    cwd: (() => { try { return process.cwd(); } catch { return null; } })(),
  };
  state.active = active;

  reapVanishedMarkers(active);
  writeMarker(active);
  recordCurrent('process-start');
  scheduleProcessIdentityUpgrade(active);
  if (configureReports && safeCommandLine) {
    try { unlinkSync(`${active.report}.1`); } catch {}
    try { renameSync(active.report, `${active.report}.1`); } catch {}
  }
  const reportsEnabled = configureReports && configureNodeReports(active.report, safeCommandLine);
  active.api = {
    directory: active.dir,
    ledgerPath: active.ledger,
    markerDir: active.markerDir,
    markerPath: active.markerPath,
    reportPath: reportsEnabled ? active.report : null,
  };
  return active.api;
}

export function recordCatchableFatal(exitCode = 1) {
  const active = sharedState().active;
  if (active) {
    const next = strongerReason(active.finalReason, 'catchable-fatal-error');
    if (next !== active.finalReason || !Number.isInteger(active.finalExitCode)) {
      active.finalExitCode = exitCode;
    }
    active.finalReason = next;
  }
  return recordCurrent('catchable-fatal-error', exitCode);
}

function strongerReason(current, candidate) {
  const rank = { 'clean-shutdown': 0, 'catchable-fatal-error': 1, 'forced-cleanup': 2 };
  return (rank[candidate] ?? 0) > (rank[current] ?? -1) ? candidate : current;
}

export function finishProcessLifecycle(reason = 'clean-shutdown', exitCode = 0) {
  const state = sharedState();
  const active = state.active;
  if (!active) return false;
  const finalReason = VALID_REASONS.has(reason) ? reason : 'clean-shutdown';
  const nextReason = strongerReason(active.finalReason, finalReason);
  if (nextReason !== active.finalReason || !Number.isInteger(active.finalExitCode)) {
    active.finalExitCode = exitCode;
  }
  active.finalReason = nextReason;
  const written = recordCurrent(active.finalReason, active.finalExitCode);
  if (!written) return false;
  if (markerOwned(active)) {
    try { unlinkSync(active.markerPath); } catch { return false; }
  }
  state.active = null;
  return true;
}

export function lifecyclePathsForTest(directory) {
  return paths(directory);
}
