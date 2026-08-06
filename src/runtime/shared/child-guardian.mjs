'use strict';

import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { detachedSpawnOpts } from './spawn-flags.mjs';

function positiveInt(value) {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : null;
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

function guardianBrokerScript() {
  return `
const { spawnSync } = require('node:child_process');
const platform = ${JSON.stringify(process.platform)};
const targets = new Map();
let input = '';
let everHadTarget = false;
let emptySince = 0;
// Kill receipt: guardian kills are otherwise indistinguishable from a crashed
// wrapper ("process exited without reporting an exit code"). Written BEFORE
// the kill so the owner's next status refresh can attribute the death.
function writeReceipt(target, reason, extra) {
  if (!target.receiptPath) return;
  try {
    require('node:fs').writeFileSync(target.receiptPath, JSON.stringify({
      reason,
      at: new Date().toISOString(),
      guardianPid: process.pid,
      childPid: target.childPid,
      ...extra,
    }));
  } catch {}
}
function alive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; }
  catch (error) { return error && error.code === 'EPERM'; }
}
function killTarget(target, force) {
  if (platform === 'win32') {
    const systemRoot = process.env.SystemRoot || process.env.WINDIR || 'C:\\\\Windows';
    const taskkill = systemRoot + '\\\\System32\\\\taskkill.exe';
    if (force) {
      try { spawnSync(taskkill, ['/PID', String(target.childPid), '/T', '/F'], { stdio: 'ignore', windowsHide: true }); } catch {}
    } else {
      try { process.kill(target.childPid, 'SIGTERM'); } catch {}
      try { spawnSync(taskkill, ['/PID', String(target.childPid), '/T'], { stdio: 'ignore', windowsHide: true }); } catch {}
    }
    return;
  }
  const signal = force ? 'SIGKILL' : 'SIGTERM';
  try { process.kill(-target.childGroupPid, signal); return; } catch {}
  try { process.kill(target.childPid, signal); } catch {}
}
function accept(message) {
  if (!message || typeof message !== 'object') return;
  const id = String(message.id || '');
  if (!id) return;
  if (message.type === 'remove') {
    targets.delete(id);
    return;
  }
  if (message.type !== 'add') return;
  const childPid = Number(message.childPid);
  const parentPid = Number(message.parentPid);
  if (!Number.isInteger(childPid) || childPid <= 0
    || !Number.isInteger(parentPid) || parentPid <= 0) return;
  targets.set(id, {
    id,
    parentPid,
    childPid,
    childGroupPid: Number(message.childGroupPid) || childPid,
    pollMs: Math.max(100, Number(message.pollMs) || 750),
    orphanGraceMs: Math.max(100, Number(message.orphanGraceMs) || 3000),
    forceGraceMs: Math.max(100, Number(message.forceGraceMs) || 3000),
    receiptPath: typeof message.receiptPath === 'string' ? message.receiptPath : null,
    orphanedAt: 0,
    lastPolledAt: 0,
    killing: false,
  });
  everHadTarget = true;
  emptySince = 0;
}
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  input += chunk;
  let newline;
  while ((newline = input.indexOf('\\n')) >= 0) {
    const line = input.slice(0, newline);
    input = input.slice(newline + 1);
    try { accept(JSON.parse(line)); } catch {}
  }
});
const timer = setInterval(() => {
  const now = Date.now();
  for (const [id, target] of targets) {
    if (now - target.lastPolledAt < target.pollMs) continue;
    target.lastPolledAt = now;
    if (!alive(target.childPid)) {
      targets.delete(id);
      continue;
    }
    if (alive(target.parentPid)) {
      target.orphanedAt = 0;
      continue;
    }
    if (!target.orphanedAt) target.orphanedAt = now;
    if (target.killing || now - target.orphanedAt < target.orphanGraceMs) continue;
    target.killing = true;
    writeReceipt(target, 'parent-exit', {});
    killTarget(target, false);
    setTimeout(() => {
      if (alive(target.childPid)) killTarget(target, true);
      targets.delete(id);
    }, target.forceGraceMs).unref?.();
  }
  // Pay for one Node supervisor only while it owns at least one live child.
  // A short empty grace absorbs command-to-command reuse without keeping the
  // broker resident for the whole daemon lifetime.
  if (targets.size > 0) emptySince = 0;
  else if (everHadTarget) {
    if (!emptySince) emptySince = now;
    else if (now - emptySince >= 1000) process.exit(0);
  }
}, 100);
`;
}

let sharedBroker = null;
let brokerRestartTimer = null;
let brokerTargetSweepTimer = null;
const brokerTargets = new Map();

function sendBrokerMessage(message) {
  try {
    if (!sharedBroker?.stdin?.writable) return false;
    sharedBroker.stdin.write(`${JSON.stringify(message)}\n`);
    return true;
  } catch {
    return false;
  }
}

function targetPidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
}

function stopBrokerTargetSweepIfIdle() {
  if (brokerTargets.size > 0 || !brokerTargetSweepTimer) return;
  clearInterval(brokerTargetSweepTimer);
  brokerTargetSweepTimer = null;
}

function removeBrokerTarget(id, { notify = true } = {}) {
  const target = brokerTargets.get(id);
  if (!target) return false;
  brokerTargets.delete(id);
  try { target.onRemoved?.(); } catch {}
  if (notify) sendBrokerMessage({ type: 'remove', id });
  stopBrokerTargetSweepIfIdle();
  return true;
}

function ensureBrokerTargetSweep() {
  if (brokerTargetSweepTimer) return;
  brokerTargetSweepTimer = setInterval(() => {
    for (const [id, target] of brokerTargets) {
      if (!targetPidAlive(target.childPid)) removeBrokerTarget(id);
    }
    stopBrokerTargetSweepIfIdle();
  }, 250);
  brokerTargetSweepTimer.unref?.();
}

function ensureSharedBroker() {
  if (sharedBroker && sharedBroker.exitCode == null && sharedBroker.signalCode == null) {
    return sharedBroker;
  }
  try {
    const broker = spawn(process.execPath, [
      '--no-warnings',
      '--eval',
      guardianBrokerScript(),
    ], {
      stdio: ['pipe', 'ignore', 'ignore'],
      env: childGuardianSpawnEnv(),
      ...detachedSpawnOpts,
    });
    sharedBroker = broker;
    broker.unref?.();
    broker.stdin?.unref?.();
    broker.stdin?.on?.('error', () => {});
    broker.once('exit', () => {
      if (sharedBroker !== broker) return;
      sharedBroker = null;
      if (brokerTargets.size > 0 && !brokerRestartTimer) {
        brokerRestartTimer = setTimeout(() => {
          brokerRestartTimer = null;
          const replacement = ensureSharedBroker();
          if (!replacement) return;
          for (const target of brokerTargets.values()) sendBrokerMessage(target);
        }, 100);
        brokerRestartTimer.unref?.();
      }
    });
    for (const target of brokerTargets.values()) sendBrokerMessage(target);
    return broker;
  } catch {
    sharedBroker = null;
    return null;
  }
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
  receiptPath = null,
} = {}) {
  const parent = positiveInt(parentPid);
  const child = positiveInt(childPid);
  if (!parent || !child || parent === child) return null;
  const id = randomUUID();
  let stopped = false;
  const target = {
    type: 'add',
    id,
    parentPid: parent,
    childPid: child,
    childGroupPid: positiveInt(childGroupPid) || child,
    pollMs: Math.max(100, Math.floor(Number(pollMs) || 750)),
    orphanGraceMs: Math.max(100, Math.floor(Number(orphanGraceMs) || Number(graceMs) || 3000)),
    forceGraceMs: Math.max(100, Math.floor(Number(forceGraceMs) || Number(graceMs) || 3000)),
    receiptPath: typeof receiptPath === 'string' && receiptPath ? receiptPath : null,
    onRemoved: () => { stopped = true; },
  };
  brokerTargets.set(id, target);
  ensureBrokerTargetSweep();
  const broker = ensureSharedBroker();
  if (!broker) {
    removeBrokerTarget(id, { notify: false });
    return null;
  }
  sendBrokerMessage(target);
  return {
    pid: broker.pid || null,
    label,
    childPid: child,
    stop() {
      if (stopped) return false;
      stopped = true;
      return removeBrokerTarget(id);
    },
  };
}
