/**
 * Canonical resolver for the Mixdog data dir.
 *
 * Resolution order:
 *   1. MIXDOG_DATA_DIR
 *   2. <MIXDOG_HOME|~/.mixdog>/data
 */

import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const DEFAULT_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

// The defaults are joins over values that almost never change; they are hot
// (every session path resolves the data dir), so each default join is reused
// while its input string is unchanged. Env overrides are read on every call.
let homeBase = null;
let homePath = null;
let dataBase = null;
let dataPath = null;

export function mixdogHome() {
  const configured = process.env.MIXDOG_HOME;
  if (configured) return configured;
  const home = homedir();
  if (home !== homeBase) {
    homeBase = home;
    homePath = join(home, '.mixdog');
  }
  return homePath;
}

export function mixdogRoot() {
  return process.env.MIXDOG_ROOT || DEFAULT_ROOT;
}

export function resolvePluginData() {
  const configured = process.env.MIXDOG_DATA_DIR;
  if (configured) return configured;
  const home = mixdogHome();
  if (home !== dataBase) {
    dataBase = home;
    dataPath = join(home, 'data');
  }
  return dataPath;
}
