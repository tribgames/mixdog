// config-snapshot.mjs — the agent config as hot paths read it: an immutable
// copy of exactly what loadConfig() answers, rebuilt when one of its inputs
// changes instead of on every read. A warm read does no I/O.
//
// What moves it:
//   - this process's own writes (config, secrets, OAuth credential files,
//     provider-account selection, auth bindings) bump the input epoch, and the
//     keychain cache's version moves with what it answers, so the very next
//     read rebuilds;
//   - an access token with no refresh token rebuilds at its expiry;
//   - another process's config or secret write reaches the config-change
//     subscription (directory watch, debounced by the shared layer);
//   - a credential file the OAuth probes read changes under a watch of its
//     directory (debounced here);
//   - a probe that could not read a credential file yet re-probes on a backoff;
//   - every CONFIG_SNAPSHOT_CHECK_MS an async stat signature of all inputs
//     catches whatever an event missed.
// A rebuild that meets a config caught mid-write keeps the last good snapshot.
import { statSync, watch as fsWatch } from 'node:fs';
import { stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { basename, dirname } from 'node:path';
import { resolvePluginData } from '../../shared/plugin-paths.mjs';
import {
  configInputFiles,
  secretCacheVersion,
  subscribeConfigChange,
  withMidWriteTolerantReads,
} from '../../shared/config.mjs';
import { configInputEpoch } from '../../shared/config-epoch.mjs';
import { providerAccountsPath } from '../../shared/provider-accounts.mjs';
import { hasScopedProviderAuthBinding } from '../../shared/provider-auth-binding.mjs';
import { oauthCredentialFiles, observeOAuthCredentialExpiry } from './providers/oauth-credential-probes.mjs';

export const CONFIG_SNAPSHOT_CHECK_MS = 15_000;
const CREDENTIAL_WATCH_DEBOUNCE_MS = 100;
const PROBE_RETRY_FIRST_MS = 1_000;
// setTimeout's ceiling; a later expiry is re-armed by the rebuild it triggers.
const MAX_TIMER_MS = 2 ** 31 - 1;

/** The credential directory watch; tests substitute one that never fires. */
export const configSnapshotDeps = { watch: fsWatch };

const MODE_OPTIONS = Object.freeze({ none: { secrets: false }, full: {}, presence: { secrets: 'presence' } });

function modeOf(options) {
  if (options?.secrets === false) return 'none';
  return options?.secrets === 'presence' ? 'presence' : 'full';
}

// Cloned first: a fresh load may share nested objects with module defaults,
// which must stay mutable for every other reader.
function frozenCopy(value) {
  const freeze = (node) => {
    if (node && typeof node === 'object') {
      Object.freeze(node);
      for (const child of Object.values(node)) freeze(child);
    }
    return node;
  };
  return freeze(structuredClone(value));
}

const statKey = (st) => `${st.mtimeMs}:${st.ctimeMs}:${st.size}:${st.ino}`;

// Credentials and the provider-key lookup read the environment too.
function environmentFingerprint() {
  const entries = Object.entries(process.env).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return createHash('sha256').update(JSON.stringify(entries)).digest('base64url');
}

const signatureOf = (dataDir, files, stats) => JSON.stringify([dataDir, environmentFingerprint(), files, stats]);

function syncSignature(dataDir, files) {
  return signatureOf(
    dataDir,
    files,
    files.map((file) => {
      try {
        return statKey(statSync(file));
      } catch {
        return '-';
      }
    })
  );
}

async function asyncSignature(dataDir, files) {
  const stats = await Promise.all(files.map((file) => stat(file).then(statKey, () => '-')));
  return signatureOf(dataDir, files, stats);
}

// The config and the secret marker first: the config subscription hears them.
function inputFiles() {
  return [...configInputFiles(), providerAccountsPath(), ...oauthCredentialFiles()];
}

const hasUnsettledProbe = (config) =>
  Object.values(config?.providers || {}).some((entry) => entry?.credentialProbeUnavailable === true);

/** `load(options)`: the uncached loader whose answer the snapshot holds. */
export function createConfigSnapshot(load) {
  const entries = new Map(); // mode -> { value, epoch, signature, files }
  const watchers = new Map(); // directory -> { watcher, names }
  let dataDir = '';
  let unsubscribeConfig = null;
  let rebuildTimer = null;
  let checkTimer = null;
  let probeRetryTimer = null;
  let probeRetryMs = 0;
  let expiryTimer = null;
  let builds = 0;

  function closeWatchers() {
    for (const slot of watchers.values()) {
      try {
        slot.watcher.close();
      } catch {}
    }
    watchers.clear();
  }

  function retarget(dir) {
    entries.clear();
    closeWatchers();
    for (const timer of [rebuildTimer, checkTimer, probeRetryTimer, expiryTimer]) clearTimeout(timer);
    rebuildTimer = checkTimer = probeRetryTimer = expiryTimer = null;
    probeRetryMs = 0;
    dataDir = dir;
    unsubscribeConfig?.();
    unsubscribeConfig = subscribeConfigChange(rebuildActive);
  }

  function scheduleRebuild() {
    if (rebuildTimer) clearTimeout(rebuildTimer);
    rebuildTimer = setTimeout(() => {
      rebuildTimer = null;
      rebuildActive();
    }, CREDENTIAL_WATCH_DEBOUNCE_MS);
    rebuildTimer.unref?.();
  }

  // A directory that does not exist yet is not watched; the signature check
  // covers it, and the rebuild its creation causes (pool write) re-arms.
  function armWatchers(files) {
    const wanted = new Map();
    for (const file of files.slice(configInputFiles().length)) {
      const dir = dirname(file);
      if (!wanted.has(dir)) wanted.set(dir, new Set());
      wanted.get(dir).add(basename(file));
    }
    for (const [dir, slot] of watchers) {
      if (wanted.has(dir)) continue;
      try {
        slot.watcher.close();
      } catch {}
      watchers.delete(dir);
    }
    for (const [dir, names] of wanted) {
      const current = watchers.get(dir);
      if (current) {
        current.names = names;
        continue;
      }
      const slot = { watcher: null, names };
      try {
        slot.watcher = configSnapshotDeps.watch(dir, (_event, filename) => {
          if (!filename || slot.names.has(String(filename))) scheduleRebuild();
        });
      } catch {
        continue;
      }
      slot.watcher.unref?.();
      slot.watcher.on?.('error', () => {
        if (watchers.get(dir) !== slot) return;
        watchers.delete(dir);
        try {
          slot.watcher.close();
        } catch {}
      });
      watchers.set(dir, slot);
    }
  }

  // An OAuth credential file that exists but could not be read (a torn write,
  // a lock) is re-probed once it had time to settle, backing off to the check.
  function scheduleProbeRetry() {
    const unsettled = [...entries].some(([mode, entry]) => mode !== 'none' && hasUnsettledProbe(entry.value));
    if (!unsettled) {
      probeRetryMs = 0;
      clearTimeout(probeRetryTimer);
      probeRetryTimer = null;
      return;
    }
    if (probeRetryTimer) return;
    probeRetryMs = Math.min(CONFIG_SNAPSHOT_CHECK_MS, probeRetryMs ? probeRetryMs * 2 : PROBE_RETRY_FIRST_MS);
    probeRetryTimer = setTimeout(() => {
      probeRetryTimer = null;
      rebuildActive();
    }, probeRetryMs);
    probeRetryTimer.unref?.();
  }

  function scheduleCheck() {
    if (checkTimer || !entries.size) return;
    checkTimer = setTimeout(() => void runCheck(), CONFIG_SNAPSHOT_CHECK_MS);
    checkTimer.unref?.();
  }

  // Async stats only: never blocks a reader. A rebuild that landed while the
  // stats ran is newer than what they saw, so that round changes nothing.
  async function runCheck() {
    checkTimer = null;
    const dir = dataDir;
    const startedAt = builds;
    try {
      const stale = [];
      for (const [mode, entry] of entries) {
        if ((await asyncSignature(dir, entry.files)) !== entry.signature) stale.push(mode);
      }
      if (stale.length && builds === startedAt && dir === dataDir && dir === resolvePluginData()) {
        for (const mode of stale) build(mode);
      }
    } catch {
      // A rebuild that throws keeps the snapshot; the next round retries.
    } finally {
      scheduleCheck();
    }
  }

  // An access token with no refresh token stops counting at its expiry with no
  // file changing: the earliest such moment of every entry rebuilds them.
  function scheduleExpiry() {
    clearTimeout(expiryTimer);
    expiryTimer = null;
    const at = Math.min(...[...entries.values()].map((entry) => entry.expiresAt));
    if (!Number.isFinite(at)) return;
    // The probes read `expiresAt > now`: from that millisecond on it is gone.
    const delay = Math.min(MAX_TIMER_MS, Math.max(0, at - Date.now() + 1));
    expiryTimer = setTimeout(() => {
      expiryTimer = null;
      rebuildActive();
    }, delay);
    expiryTimer.unref?.();
  }

  // Secrets-less loads read no keychain value.
  const secretVersionOf = (mode) => (mode === 'none' ? null : secretCacheVersion());

  function build(mode) {
    const epoch = configInputEpoch();
    const secrets = secretVersionOf(mode);
    // Stat before the read: a write landing in between leaves a signature
    // older than the content, so the next check rebuilds rather than sticks.
    const files = inputFiles();
    const signature = syncSignature(dataDir, files);
    let loaded;
    try {
      loaded = observeOAuthCredentialExpiry(() => withMidWriteTolerantReads(() => load(MODE_OPTIONS[mode])));
    } catch {
      const last = entries.get(mode);
      // Mid-write or unreadable: the last good snapshot stays. Its blank
      // signature makes the next check rebuild if no event does first.
      if (last) {
        const kept = { ...last, epoch, secrets, signature: '' };
        entries.set(mode, kept);
        scheduleCheck();
        return kept;
      }
      // Nothing good yet: the plain loader decides, exactly as loadConfig().
      loaded = observeOAuthCredentialExpiry(() => load(MODE_OPTIONS[mode]));
    }
    const entry = {
      value: frozenCopy(loaded.value),
      epoch,
      secrets,
      signature,
      files,
      expiresAt: loaded.expiresAt,
    };
    entries.set(mode, entry);
    builds += 1;
    armWatchers(files);
    scheduleProbeRetry();
    scheduleExpiry();
    scheduleCheck();
    return entry;
  }

  function rebuildActive() {
    if (resolvePluginData() !== dataDir) return;
    for (const mode of [...entries.keys()]) build(mode);
  }

  /** The agent config loadConfig(options) answers now, frozen. Warm: no I/O.
   *  A first read, or the first after this process changed an input, builds
   *  it on the spot. */
  return function getConfigSnapshot(options = {}) {
    const mode = modeOf(options);
    // Inside withProviderAccount the OAuth probes read that account's files.
    if (mode !== 'none' && hasScopedProviderAuthBinding()) return frozenCopy(load(MODE_OPTIONS[mode]));
    const dir = resolvePluginData();
    if (dir !== dataDir) retarget(dir);
    const entry = entries.get(mode);
    if (entry && entry.epoch === configInputEpoch() && entry.secrets === secretVersionOf(mode)) return entry.value;
    return build(mode).value;
  };
}
