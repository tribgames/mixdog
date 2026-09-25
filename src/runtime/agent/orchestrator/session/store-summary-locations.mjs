/**
 * Where the cold read-only catalog reads from, and the heartbeat-sidecar scan
 * that gives it liveness. Leaf module by design: no store.mjs, no config, no
 * workers — every consumer of the cold path resolves paths through here so
 * they cannot drift apart.
 */
import { readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { probePath, PROBE_PRESENT } from './store/fs-probe.mjs';
import { isStoredSessionId } from './store-summary-fields.mjs';

export function dataDir() {
  if (process.env.MIXDOG_DATA_DIR) return process.env.MIXDOG_DATA_DIR;
  const home = process.env.MIXDOG_HOME || join(homedir(), '.mixdog');
  return join(home, 'data');
}

export function storedAgentWorkerIndexPath() {
  return join(dataDir(), 'agent-workers.json');
}

export function storedLeadWorkerIndexPath() {
  return join(dataDir(), 'lead-workers.json');
}

export function sessionHeartbeatMtimes() {
  const directory = join(dataDir(), 'sessions');
  const result = new Map();
  if (probePath(directory).state !== PROBE_PRESENT) return result;
  let entries = [];
  try {
    entries = readdirSync(directory);
  } catch {
    return result;
  }
  for (const filename of entries) {
    if (!filename.endsWith('.hb')) continue;
    const id = filename.slice(0, -3);
    if (!isStoredSessionId(id)) continue;
    // Liveness is additive: a sidecar that is absent OR unreadable simply
    // contributes nothing, and can never remove a row.
    const probe = probePath(join(directory, filename));
    if (probe.state === PROBE_PRESENT && probe.mtimeMs > 0) result.set(id, probe.mtimeMs);
  }
  return result;
}
