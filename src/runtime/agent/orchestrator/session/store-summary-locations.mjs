/**
 * Where the cold read-only catalog reads from. Leaf module by design: no
 * store.mjs, no config, no workers — every consumer of the cold path resolves
 * paths through here so they cannot drift apart.
 */
import { homedir } from 'node:os';
import { join } from 'node:path';

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
