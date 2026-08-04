'use strict';

import { spawn } from 'node:child_process';
import { detachedSpawnOpts } from './spawn-flags.mjs';

function positiveInt(value) {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : null;
}

const DEFAULT_MIN_FREE_MEMORY_MB = 1024;

export function childGuardianMemoryFloorMb(env = process.env) {
  const n = Math.floor(Number(env.MIXDOG_MIN_FREE_MEMORY_MB));
  return Number.isFinite(n) && n >= 0 ? n : DEFAULT_MIN_FREE_MEMORY_MB;
}

export function childGuardianSpawnEnv(env = process.env) {
  return {
    PATH: env.PATH || '',
    SystemRoot: env.SystemRoot || env.WINDIR || '',
    WINDIR: env.WINDIR || env.SystemRoot || '',
    // Desktop's engine runs inside an Electron utility process, where
    // process.execPath points at electron.exe. Without Node mode Electron
    // ignores --eval, starts a full app process, and the intended guardian
    // loop never runs — every completed shell then leaks ~100 MB until the
    // desktop exits.
    ELECTRON_RUN_AS_NODE: '1',
  };
}

function guardianScript({
  parentPid,
  childPid,
  childGroupPid,
  platform,
  pollMs,
  orphanGraceMs,
  forceGraceMs,
  minFreeMemoryMb,
  receiptPath,
}) {
  return `
const { spawnSync } = require('node:child_process');
const { freemem } = require('node:os');
const parentPid = ${JSON.stringify(parentPid)};
const childPid = ${JSON.stringify(childPid)};
const childGroupPid = ${JSON.stringify(childGroupPid || childPid)};
const platform = ${JSON.stringify(platform)};
const pollMs = ${JSON.stringify(pollMs)};
const orphanGraceMs = ${JSON.stringify(orphanGraceMs)};
const forceGraceMs = ${JSON.stringify(forceGraceMs)};
const minFreeMemoryBytes = ${JSON.stringify(minFreeMemoryMb * 1024 * 1024)};
const receiptPath = ${JSON.stringify(receiptPath || null)};
// Kill receipt: guardian kills are otherwise indistinguishable from a crashed
// wrapper ("process exited without reporting an exit code"). Written BEFORE
// the kill so the owner's next status refresh can attribute the death.
function writeReceipt(reason, extra) {
  if (!receiptPath) return;
  try {
    require('node:fs').writeFileSync(receiptPath, JSON.stringify({
      reason,
      at: new Date().toISOString(),
      guardianPid: process.pid,
      childPid,
      ...extra,
    }));
  } catch {}
}
function alive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; }
  catch (error) { return error && error.code === 'EPERM'; }
}
function killTarget(force) {
  if (platform === 'win32') {
    const systemRoot = process.env.SystemRoot || process.env.WINDIR || 'C:\\\\Windows';
    const taskkill = systemRoot + '\\\\System32\\\\taskkill.exe';
    if (force) {
      try { spawnSync(taskkill, ['/PID', String(childPid), '/T', '/F'], { stdio: 'ignore', windowsHide: true }); } catch {}
    } else {
      try { process.kill(childPid, 'SIGTERM'); } catch {}
      try { spawnSync(taskkill, ['/PID', String(childPid), '/T'], { stdio: 'ignore', windowsHide: true }); } catch {}
    }
    return;
  }
  const signal = force ? 'SIGKILL' : 'SIGTERM';
  try { process.kill(-childGroupPid, signal); return; } catch {}
  try { process.kill(childPid, signal); } catch {}
}
let killing = false;
let orphanedAt = 0;
const timer = setInterval(() => {
  if (!alive(childPid)) process.exit(0);
  // Admission protects only NEW work. A running shell can still consume the
  // host after it starts, so reclaim its entire tree before it starves the
  // owning Mixdog process. Force is intentional: at the memory floor there is
  // no safe grace window for a runaway allocator.
  if (!killing && minFreeMemoryBytes > 0) {
    let freeBytes = Number.POSITIVE_INFINITY;
    try { freeBytes = Number(freemem()); } catch {}
    if (Number.isFinite(freeBytes) && freeBytes < minFreeMemoryBytes) {
      killing = true;
      writeReceipt('host-memory-floor', { freeBytes, minFreeMemoryBytes });
      killTarget(true);
      process.exit(0);
    }
  }
  // Orphaned when the parent PID dies. Matches mainstream CLIs: no console
  // probe — a hidden shell spawn (windowsHide) plus tree-kill on cleanup, so
  // orphan detection is pure parent-liveness.
  if (alive(parentPid)) {
    orphanedAt = 0;
    return;
  }
  if (!orphanedAt) orphanedAt = Date.now();
  if (killing || Date.now() - orphanedAt < orphanGraceMs) return;
  killing = true;
  writeReceipt('parent-exit', {});
  killTarget(false);
  setTimeout(() => { if (alive(childPid)) killTarget(true); process.exit(0); }, forceGraceMs).unref?.();
}, pollMs);
`;
}

export function startChildGuardian({
  parentPid = process.pid,
  childPid,
  childGroupPid = childPid,
  label = 'child',
  pollMs = 750,
  graceMs = 3000,
  orphanGraceMs = graceMs,
  forceGraceMs = graceMs,
  protectHostMemory = false,
  minFreeMemoryMb = protectHostMemory ? childGuardianMemoryFloorMb() : 0,
  receiptPath = null,
} = {}) {
  const parent = positiveInt(parentPid);
  const child = positiveInt(childPid);
  if (!parent || !child || parent === child) return null;
  const memoryFloorMb = Math.max(0, Math.floor(Number(minFreeMemoryMb) || 0));

  try {
    const guardian = spawn(process.execPath, [
      '--no-warnings',
      '--eval',
      guardianScript({
        parentPid: parent,
        childPid: child,
        childGroupPid: positiveInt(childGroupPid) || child,
        platform: process.platform,
        pollMs: Math.max(100, Math.floor(Number(pollMs) || 750)),
        orphanGraceMs: Math.max(100, Math.floor(Number(orphanGraceMs) || Number(graceMs) || 3000)),
        forceGraceMs: Math.max(100, Math.floor(Number(forceGraceMs) || Number(graceMs) || 3000)),
        minFreeMemoryMb: memoryFloorMb,
        receiptPath: typeof receiptPath === 'string' && receiptPath ? receiptPath : null,
      }),
    ], {
      stdio: 'ignore',
      env: childGuardianSpawnEnv(),
      ...detachedSpawnOpts,
    });
    guardian.unref?.();
    let stopped = false;
    return {
      pid: guardian.pid || null,
      label,
      childPid: child,
      stop() {
        if (stopped) return false;
        stopped = true;
        try {
          guardian.kill();
          return true;
        } catch {
          return false;
        }
      },
    };
  } catch {
    return null;
  }
}
