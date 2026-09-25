// Opt-in in-process CPU profiler for daemon event-loop stalls.
//
// Rides the 30s telemetry tick. While `<data dir>/lag-profile.on` exists, a
// node:inspector session profiles each telemetry window back to back (stop →
// start on every tick). A window's profile is kept only when that same
// window's event-loop lag was bad; kept windows land in `<data dir>/profiles`
// as standard .cpuprofile JSON (Chrome DevTools) with a one-line self-time
// summary in daemon.log. Removing the flag stops profiling and disconnects the
// session. Every failure is caught and logged once; nothing here may break the
// telemetry loop.

import { existsSync } from 'node:fs';
import * as fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const LAG_PROFILE_FLAG_FILE = 'lag-profile.on';
export const LAG_PROFILE_DIR_NAME = 'profiles';
export const LAG_PROFILE_KEEP = 10;
export const LAG_PROFILE_TOP = 15;
export const LAG_PROFILE_SAMPLING_US = 1000;
export const LAG_P99_THRESHOLD_MS = 1000;
export const LAG_MAX_THRESHOLD_MS = 2000;

const PROFILE_FILE_RE = /^daemon-lag-.+\.cpuprofile$/;
const SRC_ROOT = fileURLToPath(new URL('..', import.meta.url));
const NODE_MODULES = '/node_modules/';

export function isLagWindow({ p99Ms, maxMs } = {}) {
  return Number(p99Ms) >= LAG_P99_THRESHOLD_MS || Number(maxMs) >= LAG_MAX_THRESHOLD_MS;
}

export function profileFileName(at) {
  return `daemon-lag-${at.toISOString().replace(/:/g, '-')}.cpuprofile`;
}

/** Script URL → path relative to the repo src/ or the innermost node_modules/. */
export function shortenScriptUrl(url, srcRoot = SRC_ROOT) {
  let file = String(url || '');
  if (file.startsWith('file:')) {
    try {
      file = fileURLToPath(file);
    } catch {
      /* keep the URL text */
    }
  }
  file = file.replace(/\\/g, '/');
  const root = `${String(srcRoot).replace(/\\/g, '/').replace(/\/+$/, '')}/`;
  const insensitive = process.platform === 'win32';
  const head = file.slice(0, root.length);
  if (insensitive ? head.toLowerCase() === root.toLowerCase() : head === root) return file.slice(root.length);
  const marker = file.lastIndexOf(NODE_MODULES);
  if (marker >= 0) return file.slice(marker + NODE_MODULES.length);
  return file;
}

function frameLabel(callFrame, srcRoot) {
  const frame = callFrame || {};
  const name = frame.functionName || '(anonymous)';
  // (garbage collector), (program), (idle) and natives carry no script URL.
  if (!frame.url) return name;
  return `${name}@${shortenScriptUrl(frame.url, srcRoot)}:${Number(frame.lineNumber) + 1}`;
}

/** Self time per function (ms), highest first, from a .cpuprofile's samples. */
export function summarizeCpuProfile(profile, { limit = LAG_PROFILE_TOP, srcRoot = SRC_ROOT } = {}) {
  const nodes = new Map((profile?.nodes || []).map((node) => [node.id, node]));
  const samples = profile?.samples || [];
  const deltas = profile?.timeDeltas || [];
  const stamps = [];
  let clock = Number(profile?.startTime) || 0;
  for (let i = 0; i < samples.length; i += 1) {
    clock += Number(deltas[i]) || 0;
    stamps.push(clock);
  }
  const endTime = Number(profile?.endTime) || 0;
  const selfUs = new Map();
  for (let i = 0; i < samples.length; i += 1) {
    const next = i + 1 < samples.length ? stamps[i + 1] : Math.max(endTime, stamps[i]);
    const node = nodes.get(samples[i]);
    if (!node || node.callFrame?.functionName === '(root)') continue;
    const label = frameLabel(node.callFrame, srcRoot);
    selfUs.set(label, (selfUs.get(label) || 0) + Math.max(0, next - stamps[i]));
  }
  return [...selfUs]
    .map(([label, us]) => ({ label, ms: us / 1000 }))
    .sort((a, b) => b.ms - a.ms)
    .slice(0, limit);
}

export function formatTopEntries(entries) {
  return entries.map((entry) => `${entry.label}=${Math.round(entry.ms)}ms`).join(',');
}

/** Keep only the `keep` newest daemon-lag profiles (names sort by timestamp). */
export async function pruneProfiles(dir, keep = LAG_PROFILE_KEEP) {
  const names = (await fsp.readdir(dir)).filter((name) => PROFILE_FILE_RE.test(name)).sort();
  const stale = names.slice(0, Math.max(0, names.length - keep));
  for (const name of stale) await fsp.rm(path.join(dir, name), { force: true });
  return stale;
}

async function createInspectorSession() {
  const inspector = await import('node:inspector');
  const session = new inspector.Session();
  session.connect();
  return session;
}

function post(session, method, params = {}) {
  return new Promise((resolve, reject) => {
    session.post(method, params, (error, result) => (error ? reject(error) : resolve(result)));
  });
}

export function createLagProfiler({
  dataDir,
  log = () => {},
  now = () => new Date(),
  createSession = createInspectorSession,
  srcRoot = SRC_ROOT,
} = {}) {
  const flagPath = path.join(dataDir, LAG_PROFILE_FLAG_FILE);
  const profileDir = path.join(dataDir, LAG_PROFILE_DIR_NAME);
  let session = null;
  let pending = false;
  let lastFailure = '';

  function report(line) {
    try {
      log(line);
    } catch {
      /* logging must not break the tick */
    }
  }

  function fail(stage, error) {
    const message = `${stage}: ${error?.message || error}`;
    if (message === lastFailure) return;
    lastFailure = message;
    report(`lag-profile failed ${message}`);
  }

  async function begin() {
    session = await createSession();
    await post(session, 'Profiler.enable');
    await post(session, 'Profiler.setSamplingInterval', { interval: LAG_PROFILE_SAMPLING_US });
    await post(session, 'Profiler.start');
    report(`lag-profile enabled dir=${profileDir}`);
  }

  async function end() {
    const current = session;
    session = null;
    if (!current) return;
    await post(current, 'Profiler.stop').catch(() => {});
    await post(current, 'Profiler.disable').catch(() => {});
    try {
      current.disconnect();
    } catch {
      /* already gone */
    }
  }

  async function save(profile, at, { p99Ms, maxMs, busySessions }) {
    const name = profileFileName(at);
    await fsp.mkdir(profileDir, { recursive: true });
    await fsp.writeFile(path.join(profileDir, name), JSON.stringify(profile));
    await pruneProfiles(profileDir, LAG_PROFILE_KEEP);
    const top = formatTopEntries(summarizeCpuProfile(profile, { limit: LAG_PROFILE_TOP, srcRoot }));
    report(`lag-profile saved file=${name} p99=${p99Ms}ms max=${maxMs}ms busySessions=${busySessions} top=${top}`);
    return name;
  }

  /** One telemetry tick with that window's lag. Never rejects. Returns
   *  'disabled' | 'started' | 'discarded' | 'saved' | 'failed' | 'busy'. */
  async function tick({ p99Ms = 0, maxMs = 0, busySessions = 0 } = {}) {
    if (pending) return 'busy';
    pending = true;
    let kept = null;
    let at = null;
    try {
      let enabled = false;
      try {
        enabled = existsSync(flagPath);
      } catch {
        enabled = false;
      }
      if (!enabled) {
        lastFailure = '';
        if (session) {
          await end();
          report('lag-profile disabled');
        }
        return 'disabled';
      }
      if (!session) {
        await begin();
        return 'started';
      }
      const result = await post(session, 'Profiler.stop');
      at = new Date(now());
      await post(session, 'Profiler.start');
      if (!isLagWindow({ p99Ms, maxMs })) return 'discarded';
      kept = result?.profile;
      if (!kept) return 'discarded';
    } catch (error) {
      fail('profiler', error);
      await end().catch(() => {});
      return 'failed';
    } finally {
      pending = false;
    }
    try {
      await save(kept, at, { p99Ms, maxMs, busySessions });
      return 'saved';
    } catch (error) {
      fail('save', error);
      return 'failed';
    }
  }

  return {
    tick,
    get active() {
      return session !== null;
    },
  };
}
