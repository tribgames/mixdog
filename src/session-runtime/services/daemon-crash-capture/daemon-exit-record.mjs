// The daemon's own exit record.
//
// The launcher's sidecar (./spawn-capture.mjs) learns a daemon's exit code only
// while the launcher itself is still alive. A daemon that outlives its launcher
// (the usual case: the desktop app or terminal closes first) therefore left a
// sidecar with no exit code and no reason. The daemon now writes what it knows
// into its own sidecar, in every way it can end:
//   * process 'exit'                    — every process.exit(), incl. shutdown()
//   * uncaughtExceptionMonitor          — the fatal error, before the crash
// and the NEXT daemon settles boots that ended without running any hook
// (TerminateProcess/SIGKILL by the launcher's process tree, power loss) by
// marking them `unrecorded-termination`, so no capture stays silent.
import fs from 'node:fs';
import path from 'node:path';
import { writeJsonAtomicSync } from '../../../runtime/shared/atomic-file.mjs';
import { isPidAlive } from '../../../runtime/shared/pid-liveness.mjs';
import { daemonCrashCaptureDir } from './paths.mjs';

const CAPTURE_RECORD_RE = /^daemon-\d{8}-\d{6}-\d+-[0-9a-f]{4}\.json$/;
const REASON_MAX_CHARS = 512;

// Windows NTSTATUS codes a process can be terminated with from outside.
const EXTERNAL_TERMINATION_CODES = new Map([
  [0x40010004, 'terminated externally (DBG_TERMINATE_PROCESS 0x40010004: process-tree/job termination by its parent)'],
  [0x40010005, 'terminated by Ctrl+C (DBG_CONTROL_C 0x40010005)'],
  [0xc000013a, 'terminated by Ctrl+C / console close (STATUS_CONTROL_C_EXIT 0xC000013A)'],
]);

/** Human reason for an exit the launcher or the daemon observed. */
export function describeExit(code, signal) {
  if (signal) return `killed by signal ${signal}`;
  if (Number.isInteger(code)) {
    const named = EXTERNAL_TERMINATION_CODES.get(code >>> 0);
    if (named) return named;
    return code === 0 ? 'exited normally (code 0)' : `exited with code ${code}`;
  }
  return 'exit not observed';
}

function boundedReason(value) {
  const text = String(value ?? '')
    .replace(/\s+/g, ' ')
    .trim();
  return text.length <= REASON_MAX_CHARS ? text : `${text.slice(0, REASON_MAX_CHARS)}…`;
}

function readRecord(file) {
  try {
    const record = JSON.parse(fs.readFileSync(file, 'utf8'));
    return record && typeof record === 'object' ? record : null;
  } catch {
    return null;
  }
}

/** The newest still-open sidecar the launcher published for `pid`, or null. */
export function findCaptureRecordFor(pid, { dir = daemonCrashCaptureDir() } = {}) {
  let names;
  try {
    names = fs.readdirSync(dir).filter((name) => CAPTURE_RECORD_RE.test(name));
  } catch {
    return null;
  }
  names.sort().reverse();
  for (const name of names) {
    const file = path.join(dir, name);
    const record = readRecord(file);
    if (record && record.pid === pid && !record.exitedAt) return { file, record };
  }
  return null;
}

/**
 * Install the daemon-side recorders. `setReason(reason, code)` names why the
 * next exit happens (shutdown paths call it first); without it the reason is
 * derived from the exit code. Returns `{ setReason, write }`; `write` is the
 * synchronous recorder the hooks call and is safe to call repeatedly.
 */
export function installDaemonExitRecorder({
  dataDir = null,
  pid = process.pid,
  now = Date.now,
  startedAtMs = now() - process.uptime() * 1000,
  memoryUsage = () => process.memoryUsage(),
  target = process,
} = {}) {
  const dir = daemonCrashCaptureDir({ dataDir });
  let located = null;
  let pending = null;

  function write({ reason, code = null, signal = null, error = null }) {
    try {
      located ||= findCaptureRecordFor(pid, { dir });
      if (!located) return false;
      const at = now();
      const memory = memoryUsage();
      const exit = {
        reason: boundedReason(reason),
        code: Number.isInteger(code) ? code : null,
        signal: signal ? String(signal) : null,
        error: error ? boundedReason(error) : null,
        at: new Date(at).toISOString(),
        uptimeMs: Math.max(0, Math.round(at - startedAtMs)),
        rssBytes: memory.rss,
        heapUsedBytes: memory.heapUsed,
      };
      // Re-read: the launcher may have updated the sidecar since it was found.
      const current = readRecord(located.file) || located.record;
      const next = { ...current, daemonExit: exit };
      // The launcher never saw this exit if it is already gone; fill the same
      // fields it would have (its own later write keeps the daemon's block).
      if (!next.exitedAt) {
        next.exitedAt = exit.at;
        next.exitCode = exit.code;
        next.exitSignal = exit.signal;
        next.uptimeMs = exit.uptimeMs;
      }
      next.exitReason = next.exitReason || exit.reason;
      writeJsonAtomicSync(located.file, next, { mode: 0o600 });
      return true;
    } catch {
      return false;
    }
  }

  target.on('uncaughtExceptionMonitor', (error, origin) => {
    const text = error?.stack || error?.message || error;
    pending = { reason: `fatal ${origin || 'uncaughtException'}`, code: 1, error: text };
    write({ ...pending });
  });
  target.on('exit', (code) => {
    const exitCode = Number.isInteger(code) ? code : 0;
    const reason = pending?.reason
      ? `${pending.reason} (${describeExit(exitCode, null)})`
      : describeExit(exitCode, null);
    write({ reason, code: exitCode, error: pending?.error ?? null });
  });

  return {
    setReason(reason, code = 0) {
      pending = { reason, code, error: null };
    },
    write,
  };
}

/**
 * Settle earlier boots that ended without any recorded exit: a sidecar whose
 * daemon pid is gone, that carries no exit time and no daemon-side record.
 * Only sidecars are edited; nothing is deleted. Returns how many were marked.
 */
export function reconcileLostDaemonCaptures({
  dir = daemonCrashCaptureDir(),
  selfPid = process.pid,
  pidAlive = isPidAlive,
  now = Date.now,
} = {}) {
  let names;
  try {
    names = fs.readdirSync(dir).filter((name) => CAPTURE_RECORD_RE.test(name));
  } catch {
    return 0;
  }
  let marked = 0;
  for (const name of names) {
    const file = path.join(dir, name);
    const record = readRecord(file);
    if (record?.kind !== 'mixdog-daemon-crash-capture') continue;
    if (!record.pid || record.pid === selfPid || record.exitedAt || record.daemonExit || record.exitReason) continue;
    if (pidAlive(record.pid)) continue;
    try {
      writeJsonAtomicSync(
        file,
        {
          ...record,
          exitReason:
            'unrecorded-termination: the daemon ended without running any exit hook and its launcher recorded no exit ' +
            '(externally killed, e.g. terminated with the launcher process tree)',
          exitReconciledAt: new Date(now()).toISOString(),
        },
        { mode: 0o600 }
      );
      marked += 1;
    } catch {
      /* best effort */
    }
  }
  return marked;
}
