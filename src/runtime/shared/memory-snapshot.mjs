import { execFile } from 'node:child_process';
import {
  mkdir,
  open,
  rename,
  stat,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { freemem, totalmem } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { withFileLock } from './atomic-file.mjs';
import { resolvePluginData } from './plugin-paths.mjs';

const execFileAsync = promisify(execFile);
const MEMORY_PRESSURE_SNAPSHOT_MAX_BYTES = 64 * 1024;
const SNAPSHOT_NAME = 'memory-pressure.jsonl';
const SNAPSHOT_INTERVAL_MS = 10 * 60 * 1000;
const SNAPSHOT_INTERVAL_JITTER_MS = 60 * 1000;
const PERIODIC_SNAPSHOT_INTERVAL_MS = SNAPSHOT_INTERVAL_MS
  + Math.floor(Math.random() * ((2 * SNAPSHOT_INTERVAL_JITTER_MS) + 1))
  - SNAPSHOT_INTERVAL_JITTER_MS;
const SNAPSHOT_RATE_LIMIT_MS = 60 * 1000;
const SNAPSHOT_LOCK_STALE_MS = 10000;

let periodicTimer = null;
let lastPressureSnapshotAt = 0;

function enabled() {
  return process.env.MIXDOG_MEMORY_SNAPSHOT !== '0';
}

function snapshotPaths() {
  const directory = join(resolvePluginData(), 'diagnostics');
  const snapshot = join(directory, SNAPSHOT_NAME);
  return {
    directory,
    snapshot,
    previousSnapshot: `${snapshot}.1`,
    lock: join(directory, 'memory-pressure.lock'),
  };
}

function memoryUsage() {
  try {
    return process.memoryUsage();
  } catch {
    return {};
  }
}

function systemMemory() {
  try {
    return { freeMemoryBytes: freemem(), totalMemoryBytes: totalmem() };
  } catch {
    return {};
  }
}

async function pathExists(path) {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

async function rotateSnapshot(paths) {
  const size = Number((await stat(paths.snapshot)).size) || 0;
  try { await unlink(paths.previousSnapshot); } catch {}
  if (size <= MEMORY_PRESSURE_SNAPSHOT_MAX_BYTES) {
    await rename(paths.snapshot, paths.previousSnapshot);
    return;
  }
  await writeFile(paths.previousSnapshot, '', { mode: 0o600 });
  await unlink(paths.snapshot);
}

async function appendSnapshot(entry) {
  const line = `${JSON.stringify(entry)}\n`;
  if (Buffer.byteLength(line) > MEMORY_PRESSURE_SNAPSHOT_MAX_BYTES) return false;
  const paths = snapshotPaths();
  try {
    await mkdir(paths.directory, { recursive: true, mode: 0o700 });
    return await withFileLock(paths.lock, async () => {
      if (await pathExists(paths.previousSnapshot)
        && (await stat(paths.previousSnapshot)).size > MEMORY_PRESSURE_SNAPSHOT_MAX_BYTES) {
        await writeFile(paths.previousSnapshot, '', { mode: 0o600 });
      }
      if (await pathExists(paths.snapshot)
        && (await stat(paths.snapshot)).size + Buffer.byteLength(line) > MEMORY_PRESSURE_SNAPSHOT_MAX_BYTES) {
        await rotateSnapshot(paths);
      }
      const fd = await open(paths.snapshot, 'a', 0o600);
      try {
        await fd.write(line, null, 'utf8');
      } finally {
        await fd.close();
      }
      return (await stat(paths.snapshot)).size <= MEMORY_PRESSURE_SNAPSHOT_MAX_BYTES;
    }, {
      timeoutMs: 0,
      staleMs: SNAPSHOT_LOCK_STALE_MS,
    });
  } catch {
    return false;
  }
}

function workingSetMb(bytes) {
  return Math.round((Number(bytes) / (1024 * 1024)) * 10) / 10;
}

function nullableProcessText(value) {
  if (typeof value !== 'string') return null;
  if (!value.trim()) return null;
  return value.length > 200 ? value.slice(0, 200) : value;
}

function nullablePid(value) {
  if ((typeof value !== 'number' && typeof value !== 'string')
    || (typeof value === 'string' && !value.trim())) return null;
  const pid = Number(value);
  return Number.isInteger(pid) ? pid : null;
}

function parseWindowsProcesses(stdout) {
  const rows = JSON.parse(String(stdout).trim() || '[]');
  return (Array.isArray(rows) ? rows : [rows])
    .map((row) => ({
      name: String(row?.Name || ''),
      pid: Number(row?.ProcessId),
      workingSetMb: workingSetMb(row?.WorkingSetSize),
      commandLine: nullableProcessText(row?.CommandLine),
      parentPid: nullablePid(row?.ParentProcessId),
    }))
    .filter((row) => row.name && Number.isInteger(row.pid) && Number.isFinite(row.workingSetMb))
    .slice(0, 8);
}

function parsePosixProcesses(stdout) {
  return String(stdout).split(/\r?\n/)
    .map((line) => {
      const match = line.match(/^\s*(\d+)\s+(\d+)\s+(\S+)\s+(.*?)\s+(\d+)\s*$/);
      if (!match) return null;
      return {
        pid: Number(match[1]),
        parentPid: nullablePid(match[2]),
        name: match[3],
        commandLine: nullableProcessText(match[4]),
        workingSetMb: workingSetMb(Number(match[5]) * 1024),
      };
    })
    .filter((row) => row && Number.isInteger(row.pid) && Number.isFinite(row.workingSetMb))
    .sort((left, right) => right.workingSetMb - left.workingSetMb)
    .slice(0, 8);
}

async function topProcesses() {
  try {
    if (process.platform === 'win32') {
      const { stdout } = await execFileAsync('powershell.exe', [
        '-NoProfile', '-NonInteractive', '-Command',
        'Get-CimInstance Win32_Process | Sort-Object WorkingSetSize -Descending | Select-Object -First 8 ProcessId,Name,WorkingSetSize,CommandLine,ParentProcessId | ConvertTo-Json -Compress',
      ], {
        encoding: 'utf8',
        timeout: 3000,
        windowsHide: true,
      });
      return parseWindowsProcesses(stdout);
    }
    const { stdout } = await execFileAsync('ps', ['-eo', 'pid=,ppid=,comm=,args=,rss='], {
      encoding: 'utf8',
      timeout: 3000,
      windowsHide: true,
    });
    return parsePosixProcesses(stdout);
  } catch {
    return null;
  }
}

function baseSnapshot(reason) {
  return {
    timestamp: new Date().toISOString(),
    pid: process.pid,
    reason,
    memoryUsage: memoryUsage(),
    systemMemory: systemMemory(),
  };
}

/**
 * Collect a full attribution snapshot. Process enumeration failures are
 * intentionally omitted from the record, rather than surfacing to callers.
 */
async function captureMemoryPressureSnapshot(reason = 'memory-pressure') {
  if (!enabled()) return false;
  const entry = baseSnapshot(reason);
  const processes = await topProcesses();
  if (processes) entry.topProcesses = processes;
  return appendSnapshot(entry);
}

async function capturePeriodicMemorySnapshot() {
  if (!enabled()) return false;
  return appendSnapshot(baseSnapshot('periodic'));
}

/**
 * Schedules one full snapshot without work on the admission path. This
 * process-wide limiter deliberately reserves the interval before scheduling.
 */
export function requestMemoryPressureSnapshot(reason) {
  try {
    if (!enabled()) return false;
    const now = Date.now();
    if (now - lastPressureSnapshotAt < SNAPSHOT_RATE_LIMIT_MS) return false;
    lastPressureSnapshotAt = now;
    const immediate = setImmediate(() => {
      void captureMemoryPressureSnapshot(reason).catch(() => {});
    });
    immediate.unref?.();
    return true;
  } catch {
    return false;
  }
}

function armMemoryPressureSampling() {
  if (!enabled() || periodicTimer) return false;
  periodicTimer = setInterval(() => {
    void capturePeriodicMemorySnapshot().catch(() => {});
  }, PERIODIC_SNAPSHOT_INTERVAL_MS);
  periodicTimer.unref?.();
  return true;
}

function memoryPressureSnapshotPath() {
  return snapshotPaths().snapshot;
}

armMemoryPressureSampling();
