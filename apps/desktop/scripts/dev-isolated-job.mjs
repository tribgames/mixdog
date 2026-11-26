// OS-level process unit containment and event-driven owner-exit watching.
// Windows: Job Object with JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE + WaitForSingleObject.async via koffi.
// Non-Windows: refuses explicitly rather than half-working without an OS process unit or handle wait.
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';

const require = createRequire(import.meta.url);

const JOB_OBJECT_EXTENDED_LIMIT_INFORMATION = 9;
const JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x2000;
const PROCESS_TERMINATE = 0x0001;
const PROCESS_SET_QUOTA = 0x0100;
const PROCESS_QUERY_LIMITED_INFORMATION = 0x1000;
const SYNCHRONIZE = 0x00100000;
const INFINITE = 0xffffffff;

let win32 = null;

export function assertSupportedUnitPlatform(platform = process.platform) {
  if (platform !== 'win32') {
    throw new Error(
      `Supervised isolated instances require Windows Job Objects and Win32 process handle waits; "${platform}" is not supported.`
    );
  }
}

function loadWin32() {
  if (win32) return win32;
  const koffi = require('koffi');
  const k32 = koffi.load('kernel32.dll');
  win32 = {
    CreateJobObjectW: k32.func('void* __stdcall CreateJobObjectW(void*, void*)'),
    SetInformationJobObject: k32.func('int __stdcall SetInformationJobObject(void*, int, void*, uint32_t)'),
    AssignProcessToJobObject: k32.func('int __stdcall AssignProcessToJobObject(void*, void*)'),
    TerminateJobObject: k32.func('int __stdcall TerminateJobObject(void*, uint32_t)'),
    OpenProcess: k32.func('void* __stdcall OpenProcess(uint32_t, int, uint32_t)'),
    GetProcessTimes: k32.func('int __stdcall GetProcessTimes(void*, void*, void*, void*, void*)'),
    CloseHandle: k32.func('int __stdcall CloseHandle(void*)'),
    CreateEventW: k32.func('void* __stdcall CreateEventW(void*, int, int, void*)'),
    SetEvent: k32.func('int __stdcall SetEvent(void*)'),
    WaitForMultipleObjects: k32.func('uint32_t __stdcall WaitForMultipleObjects(uint32_t, void**, int, uint32_t)'),
    GetLastError: k32.func('uint32_t __stdcall GetLastError()'),
  };
  return win32;
}

const FILETIME_UNIX_EPOCH_TICKS = 116444736000000000n;
const LINUX_USER_HZ = 100;
let cachedLinuxBootTimeMs = null;

function readLinuxBootTimeMs(readText) {
  if (!readText && cachedLinuxBootTimeMs !== null) return cachedLinuxBootTimeMs;
  const read = readText ?? ((path) => readFileSync(path, 'utf8'));
  const text = read('/proc/stat');
  const match = /^btime\s+(\d+)$/m.exec(text);
  if (!match) return null;
  const ms = Number(match[1]) * 1000;
  if (!Number.isFinite(ms)) return null;
  if (!readText) cachedLinuxBootTimeMs = ms;
  return ms;
}

function getLinuxProcessCreationTimeMs(pid, readText) {
  try {
    const bootTimeMs = readLinuxBootTimeMs(readText);
    if (bootTimeMs === null) return null;
    const read = readText ?? ((path) => readFileSync(path, 'utf8'));
    const stat = read(`/proc/${pid}/stat`);
    const rparen = stat.lastIndexOf(')');
    if (rparen === -1) return null;
    const fields = stat.slice(rparen + 1).trim().split(/\s+/);
    if (fields.length <= 19) return null;
    if (fields[0] === 'Z' || fields[0] === 'X' || fields[0] === 'x') return null;
    const startTicks = Number(fields[19]);
    if (!Number.isFinite(startTicks) || startTicks < 0) return null;
    return bootTimeMs + Math.trunc((startTicks * 1000) / LINUX_USER_HZ);
  } catch {
    return null;
  }
}

/** Returns the exact process creation time in Unix epoch milliseconds (Win32 GetProcessTimes or Linux /proc/<pid>/stat,
 *  no shell spawn), or null when the PID does not exist or cannot be queried. */
export function getProcessCreationTimeMs(pid, { platform = process.platform, readText } = {}) {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  if (platform === 'linux') return getLinuxProcessCreationTimeMs(pid, readText);
  if (platform !== 'win32') return null;
  const api = loadWin32();
  const hProc = api.OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
  if (!hProc) return null;
  try {
    const createBuf = Buffer.alloc(8);
    const exitBuf = Buffer.alloc(8);
    const kernelBuf = Buffer.alloc(8);
    const userBuf = Buffer.alloc(8);
    if (!api.GetProcessTimes(hProc, createBuf, exitBuf, kernelBuf, userBuf)) return null;
    const low = BigInt(createBuf.readUInt32LE(0));
    const high = BigInt(createBuf.readUInt32LE(4));
    const ticks = (high << 32n) | low;
    if (ticks < FILETIME_UNIX_EPOCH_TICKS) return null;
    return Number((ticks - FILETIME_UNIX_EPOCH_TICKS) / 10000n);
  } finally {
    api.CloseHandle(hProc);
  }
}

/** True only when `pid` is live AND still has the exact same creation time (rejecting reused PIDs). */
export function isSameProcess(
  pid,
  expectedCreatedMs,
  { alive, getCreated = getProcessCreationTimeMs } = {}
) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  if (alive && !alive(pid)) return false;
  if (typeof expectedCreatedMs !== 'number' || !Number.isFinite(expectedCreatedMs)) {
    return alive ? true : getCreated(pid) !== null;
  }
  const actual = getCreated(pid);
  if (typeof actual !== 'number' || !Number.isFinite(actual)) return false;
  return actual === expectedCreatedMs;
}

/**
 * Owns every child process of one isolated instance as a single OS Job Object.
 * Every assigned child and all of its descendants terminate atomically when `terminate()` or
 * `close()` runs — or immediately if the supervisor process crashes.
 */
export function createProcessGroup({ platform = process.platform } = {}) {
  assertSupportedUnitPlatform(platform);
  const pids = new Set();
  const api = loadWin32();
  const hJob = api.CreateJobObjectW(null, null);
  if (!hJob) throw new Error(`CreateJobObjectW failed (error ${api.GetLastError()}).`);
  // JOBOBJECT_EXTENDED_LIMIT_INFORMATION is 144 bytes on 64-bit Windows, 112 on 32-bit.
  // BasicLimitInformation.LimitFlags sits at byte offset 16 on both.
  const info = Buffer.alloc(process.arch === 'ia32' ? 112 : 144);
  info.writeUInt32LE(JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE, 16);
  if (!api.SetInformationJobObject(hJob, JOB_OBJECT_EXTENDED_LIMIT_INFORMATION, info, info.length)) {
    const err = api.GetLastError();
    api.CloseHandle(hJob);
    throw new Error(`SetInformationJobObject failed (error ${err}).`);
  }
  let closed = false;
  return {
    assign(pid) {
      if (closed || !Number.isInteger(pid) || pid <= 0) return false;
      const hProc = api.OpenProcess(
        PROCESS_SET_QUOTA | PROCESS_TERMINATE | PROCESS_QUERY_LIMITED_INFORMATION,
        0,
        pid
      );
      if (!hProc) return false;
      try {
        const assigned = Boolean(api.AssignProcessToJobObject(hJob, hProc));
        if (assigned) pids.add(pid);
        return assigned;
      } finally {
        api.CloseHandle(hProc);
      }
    },
    release(pid) {
      if (Number.isInteger(pid)) pids.delete(pid);
    },
    terminate() {
      if (closed) return;
      closed = true;
      api.TerminateJobObject(hJob, 1);
      api.CloseHandle(hJob);
    },
    close() {
      if (closed) return;
      closed = true;
      api.CloseHandle(hJob);
    },
    pids: () => [...pids],
  };
}

/**
 * Fires `onExit` once `pid` exits, using a Win32 OS handle wait (zero polling).
 * Returns `{ active, cancel() }`.
 */
export function watchProcessExit(pid, onExit, { platform = process.platform } = {}) {
  assertSupportedUnitPlatform(platform);
  if (!Number.isInteger(pid) || pid <= 0 || pid === process.pid) {
    return { active: false, cancel() {} };
  }
  const api = loadWin32();
  const hProc = api.OpenProcess(SYNCHRONIZE, 0, pid);
  if (!hProc) {
    queueMicrotask(() => onExit('already-exited'));
    return { active: true, cancel() {} };
  }
  const hCancel = api.CreateEventW(null, 1, 0, null);
  if (!hCancel) {
    api.CloseHandle(hProc);
    throw new Error(`CreateEventW failed (error ${api.GetLastError()}).`);
  }
  let cancelled = false;
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    api.CloseHandle(hProc);
    api.CloseHandle(hCancel);
  };
  api.WaitForMultipleObjects.async(2, [hProc, hCancel], 0, INFINITE, (error, waitResult) => {
    close();
    if (!cancelled && waitResult !== 1) onExit(error ? `wait-error:${error.message}` : 'exited');
  });
  return {
    active: true,
    cancel() {
      if (cancelled) return;
      cancelled = true;
      if (!closed) api.SetEvent(hCancel);
    },
  };
}

const EPHEMERAL_WRAPPER =
  /(?:^|[\\/"'])(?:node|npm|npx|cmd|pwsh|powershell|sh|bash|zsh)(?:\.(?:exe|cmd|bat))?["']?(?:\s|$)/i;
const EPHEMERAL_SHELL_FLAGS = /(?:\s|^)(?:-c|-command|-encodedcommand|-enc|-noninteractive|\/c|\/k)\b/i;
const NODE_OR_NPM = /(?:^|[\\/"'])(?:node|npm|npx)(?:\.(?:exe|cmd|bat))?["']?(?:\s|$)/i;

function isEphemeralCommand(cmd) {
  const text = String(cmd ?? '').trim();
  if (!text) return false;
  if (NODE_OR_NPM.test(text)) return true;
  if (EPHEMERAL_WRAPPER.test(text) && EPHEMERAL_SHELL_FLAGS.test(text)) return true;
  return false;
}

/**
 * Walks upward from `selfPid` through a single process snapshot to find the nearest persistent
 * session/terminal/host process (skipping ephemeral npm/node/command-wrapper shells).
 */
export function findPersistentOwnerPid(processes, selfPid = process.pid) {
  const byPid = new Map(processes.map((row) => [row.pid, row]));
  const seen = new Set([selfPid]);
  let current = byPid.get(selfPid);
  while (current && Number.isInteger(current.ppid) && current.ppid > 0 && !seen.has(current.ppid)) {
    seen.add(current.ppid);
    const parent = byPid.get(current.ppid);
    if (!parent) return current.ppid;
    if (!isEphemeralCommand(parent.cmd)) return parent.pid;
    current = parent;
  }
  return null;
}

const SESSION_SCRATCH_PATTERN = /[\\/]scratch[\\/](s\.[0-9a-f]+)[\\/]?$/i;

/** Extracts the Mixdog session scratch directory from TEMP/TMP/TMPDIR, if present. */
export function detectSessionScratchDir(env = process.env) {
  for (const key of ['MIXDOG_SESSION_SCRATCH', 'TEMP', 'TMP', 'TMPDIR']) {
    const raw = env[key];
    if (!raw) continue;
    const match = SESSION_SCRATCH_PATTERN.exec(raw);
    if (match) {
      const sessionDir = resolve(raw);
      return { sessionId: match[1], sessionDir, parentDir: dirname(sessionDir) };
    }
  }
  return null;
}

/** Identifies the calling agent/terminal session so instances are never shared across sessions. */
export function resolveCallerSession(
  env = process.env,
  { processes = [], selfPid = process.pid, ownerPid } = {}
) {
  const scratch = detectSessionScratchDir(env);
  const resolvedOwnerPid =
    ownerPid === null
      ? null
      : Number.isInteger(ownerPid) && ownerPid > 0
        ? ownerPid
        : findPersistentOwnerPid(processes, selfPid);
  if (scratch) {
    const slug = scratch.sessionId.replace(/[^a-z0-9-]/gi, '-').toLowerCase();
    return {
      sessionId: scratch.sessionId,
      sessionDir: scratch.sessionDir,
      ownerPid: resolvedOwnerPid,
      selfPid,
      defaultName: `cap-${slug}`.slice(0, 48),
    };
  }
  return {
    sessionId: null,
    sessionDir: null,
    ownerPid: resolvedOwnerPid,
    selfPid,
    defaultName: resolvedOwnerPid ? `cap-p${resolvedOwnerPid}` : `cap-${selfPid}`,
  };
}

/** True only when `lease` was started by `caller`'s session (never another agent's session). */
export function leaseBelongsToSession(lease, caller) {
  if (!lease || !caller) return false;
  if (caller.sessionId) return lease.sessionId === caller.sessionId;
  if (Number.isInteger(caller.ownerPid) && caller.ownerPid > 0) {
    return !lease.sessionId && lease.ownerPid === caller.ownerPid;
  }
  return !lease.sessionId && !lease.ownerPid && lease.starterPid === caller.selfPid;
}
