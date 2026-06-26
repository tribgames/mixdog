'use strict';

import { spawn } from 'node:child_process';

function positiveInt(value) {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : null;
}

function guardianScript({ parentPid, childPid, childGroupPid, platform, pollMs, orphanGraceMs, forceGraceMs }) {
  return `
const { spawnSync } = require('node:child_process');
const parentPid = ${JSON.stringify(parentPid)};
const childPid = ${JSON.stringify(childPid)};
const childGroupPid = ${JSON.stringify(childGroupPid || childPid)};
const platform = ${JSON.stringify(platform)};
const pollMs = ${JSON.stringify(pollMs)};
const orphanGraceMs = ${JSON.stringify(orphanGraceMs)};
const forceGraceMs = ${JSON.stringify(forceGraceMs)};
function alive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; }
  catch (error) { return error && error.code === 'EPERM'; }
}
function killTarget(force) {
  if (platform === 'win32') {
    if (force) {
      try { spawnSync('taskkill.exe', ['/PID', String(childPid), '/T', '/F'], { stdio: 'ignore', windowsHide: true }); } catch {}
    } else {
      try { process.kill(childPid, 'SIGTERM'); } catch {}
      try { spawnSync('taskkill.exe', ['/PID', String(childPid), '/T'], { stdio: 'ignore', windowsHide: true }); } catch {}
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
  if (alive(parentPid)) {
    orphanedAt = 0;
    return;
  }
  if (!orphanedAt) orphanedAt = Date.now();
  if (killing || Date.now() - orphanedAt < orphanGraceMs) return;
  killing = true;
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
} = {}) {
  const parent = positiveInt(parentPid);
  const child = positiveInt(childPid);
  if (!parent || !child || parent === child) return null;

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
      }),
    ], {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
      env: {
        PATH: process.env.PATH || '',
        SystemRoot: process.env.SystemRoot || process.env.WINDIR || '',
        WINDIR: process.env.WINDIR || process.env.SystemRoot || '',
      },
    });
    guardian.unref?.();
    return { pid: guardian.pid || null, label, childPid: child };
  } catch {
    return null;
  }
}
