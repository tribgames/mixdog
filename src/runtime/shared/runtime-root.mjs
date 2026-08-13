import {
  chmodSync,
  lstatSync,
  mkdirSync,
  readFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

let cachedDefaultRoot = '';

function currentUid() {
  if (typeof process.getuid !== 'function') return null;
  const uid = Number(process.getuid());
  return Number.isInteger(uid) && uid >= 0 ? uid : null;
}

function isPidAlive(value) {
  const pid = Number(value);
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
}

function safeLiveLegacyRoot(root, uid) {
  try {
    const directory = lstatSync(root);
    if (!directory.isDirectory() || directory.uid !== uid || (directory.mode & 0o022) !== 0) {
      return false;
    }
    const discoveryPath = join(root, 'daemon.json');
    const discoveryFile = lstatSync(discoveryPath);
    if (!discoveryFile.isFile() || discoveryFile.uid !== uid || (discoveryFile.mode & 0o077) !== 0) {
      return false;
    }
    const discovery = JSON.parse(readFileSync(discoveryPath, 'utf8'));
    return isPidAlive(discovery?.pid);
  } catch {
    return false;
  }
}

export function isolatedRuntimeRoot({
  platform = process.platform,
  tempDir = tmpdir(),
  uid = currentUid(),
} = {}) {
  if (platform === 'win32' || uid === null) return join(tempDir, 'mixdog');
  return join(tempDir, `mixdog-${uid}`);
}

export function resolveRuntimeRoot() {
  const configured = String(process.env.MIXDOG_RUNTIME_ROOT || '').trim();
  if (configured) return resolve(configured);
  if (cachedDefaultRoot) return cachedDefaultRoot;

  const uid = currentUid();
  const isolated = isolatedRuntimeRoot({ uid });
  const legacy = join(tmpdir(), 'mixdog');
  cachedDefaultRoot = uid !== null && safeLiveLegacyRoot(legacy, uid)
    ? legacy
    : isolated;
  return cachedDefaultRoot;
}

export function ensurePrivateRuntimeRoot(root = resolveRuntimeRoot()) {
  mkdirSync(root, { recursive: true, mode: 0o700 });
  if (process.platform === 'win32' || typeof process.getuid !== 'function') return root;

  const directory = lstatSync(root);
  const uid = currentUid();
  if (!directory.isDirectory() || uid === null || directory.uid !== uid) {
    const error = new Error(`runtime root is not owned by the current user: ${root}`);
    error.code = 'EUNSAFERUNTIME';
    throw error;
  }
  chmodSync(root, 0o700);
  return root;
}
