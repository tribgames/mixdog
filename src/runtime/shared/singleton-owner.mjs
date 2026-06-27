import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

export function isPidAlive(pid) {
  const n = Number(pid);
  if (!Number.isInteger(n) || n <= 0) return false;
  try {
    process.kill(n, 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
}

function readJson(path) {
  try {
    if (!existsSync(path)) return null;
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
}

function writeJsonAtomic(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`);
  renameSync(tmp, path);
}

function waitSync(ms) {
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  } catch {}
}

function acquireClaimLock(path) {
  const lockPath = `${path}.claim.lock`;
  for (let i = 0; i < 20; i++) {
    try {
      mkdirSync(lockPath, { recursive: false });
      return lockPath;
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
      try {
        const ageMs = Date.now() - statSync(lockPath).mtimeMs;
        if (ageMs > 5000) {
          rmSync(lockPath, { recursive: true, force: true });
          continue;
        }
      } catch {}
      waitSync(25);
    }
  }
  return null;
}

export function readSingletonOwner(path) {
  const owner = readJson(path);
  if (!owner || typeof owner !== 'object') return { owner: null, alive: false };
  return { owner, alive: isPidAlive(owner.pid) };
}

export function claimSingletonOwner(path, {
  kind = 'runtime',
  pid = process.pid,
  meta = {},
} = {}) {
  const owner = {
    kind,
    pid,
    claimedAt: new Date().toISOString(),
    ...meta,
  };

  const current = readJson(path);
  if (current?.pid && Number(current.pid) !== Number(pid) && isPidAlive(current.pid)) {
    return { owned: false, owner: current };
  }

  const lockPath = acquireClaimLock(path);
  if (!lockPath) return { owned: false, owner: readJson(path) };
  try {
    const lockedCurrent = readJson(path);
    if (lockedCurrent?.pid && Number(lockedCurrent.pid) !== Number(pid) && isPidAlive(lockedCurrent.pid)) {
      return { owned: false, owner: lockedCurrent };
    }
    writeJsonAtomic(path, owner);
    return { owned: true, owner };
  } finally {
    rmSync(lockPath, { recursive: true, force: true });
  }
}

export function releaseSingletonOwner(path, pid = process.pid) {
  const current = readJson(path);
  if (!current?.pid || Number(current.pid) !== Number(pid)) return false;
  try {
    rmSync(path, { force: true });
    return true;
  } catch {
    return false;
  }
}
