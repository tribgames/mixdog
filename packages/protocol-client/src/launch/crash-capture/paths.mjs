// Where the daemon crash captures live.
import os from 'node:os';
import path from 'node:path';

const CAPTURE_DIR_NAME = 'daemon-crash';

export function daemonDataDir(env = process.env) {
  return env.MIXDOG_DATA_DIR
    ? path.resolve(env.MIXDOG_DATA_DIR)
    : path.join(env.MIXDOG_HOME || path.join(os.homedir(), '.mixdog'), 'data');
}

export function daemonCrashCaptureDir({ dataDir = null, env = process.env } = {}) {
  const base = dataDir ? path.resolve(dataDir) : daemonDataDir(env);
  return path.join(base, CAPTURE_DIR_NAME);
}
