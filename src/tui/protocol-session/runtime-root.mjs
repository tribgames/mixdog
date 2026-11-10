// The runtime root: the folder whose `daemon.json` names the running core (discovery.mjs reads it).
import { lstatSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { isPidAlive } from '../../runtime/shared/pid-liveness.mjs';

let cachedDefaultRoot = '';

function currentUid() {
  if (typeof process.getuid !== 'function') return null;
  const uid = Number(process.getuid());
  return Number.isInteger(uid) && uid >= 0 ? uid : null;
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

export function isolatedRuntimeRoot({ platform = process.platform, tempDir = tmpdir(), uid = currentUid() } = {}) {
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
  cachedDefaultRoot = uid !== null && safeLiveLegacyRoot(legacy, uid) ? legacy : isolated;
  return cachedDefaultRoot;
}
