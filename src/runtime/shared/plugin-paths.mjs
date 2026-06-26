/**
 * Canonical resolver for the Mixdog data dir.
 *
 * Resolution order:
 *   1. MIXDOG_DATA_DIR
 *   2. <MIXDOG_HOME|~/.mixdog>/data
 */

import { homedir } from 'os';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const DEFAULT_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

export function mixdogHome() {
  return process.env.MIXDOG_HOME || join(homedir(), '.mixdog');
}

export function mixdogRoot() {
  return process.env.MIXDOG_ROOT || DEFAULT_ROOT;
}

export function resolvePluginData() {
  return process.env.MIXDOG_DATA_DIR || join(mixdogHome(), 'data');
}
