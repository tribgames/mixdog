// config-snapshot.mjs — the agent config as hot paths read it: an immutable
// copy of exactly what loadConfig() answers, rebuilt only after one of its
// inputs changed. A warm read does no I/O: it compares the config-input epoch
// and the clock.
//
// Every input change is an event that moves the epoch (shared/config-epoch.mjs):
//   - this process's writers bump it as they write (config, OAuth credential
//     files, the selected provider account, auth bindings; secrets through the
//     keychain cache's change event), so the very next read rebuilds;
//   - another process's config or secret write bumps it in the config-change
//     notification pass (its directory watch; the snapshot subscribes);
//   - another process's write of a credential file or the provider-account
//     roster bumps it through the watch on that file (watched-file-cache.mjs).
// Time is a trigger only for an access token with no refresh token: a read at
// or past its expiry rebuilds, and one timer at that exact moment tells the
// epoch's listeners. Nothing re-checks inputs on an interval.
// A build that meets a config caught mid-write reads the last config that
// parsed and everything else fresh, so a credential still expires on time;
// the write completing is the event that replaces the config part.
import { resolvePluginData } from '../../shared/plugin-paths.mjs';
import { subscribeConfigChange, withLastGoodConfigReads } from '../../shared/config.mjs';
import { bumpConfigInputEpoch, configInputEpoch } from '../../shared/config-epoch.mjs';
import { providerAccountsPath } from '../../shared/provider-accounts.mjs';
import { hasScopedProviderAuthBinding } from '../../shared/provider-auth-binding.mjs';
import { createWatchedFileCache, fileStamp, fileStampSync } from '../../shared/watched-file-cache.mjs';
import { oauthCredentialFiles, observeOAuthCredentialExpiry } from './providers/oauth-credential-probes.mjs';

// setTimeout's ceiling; a later deadline re-arms when this one fires.
const MAX_TIMER_MS = 2 ** 31 - 1;

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

// The inputs beside the config whose watch is this module's: the config and the
// secret marker are watched by the config-change pass.
const watchedInputFiles = () => [providerAccountsPath(), ...oauthCredentialFiles()];

/** `load(options)`: the uncached loader whose answer the snapshot holds. */
export function createConfigSnapshot(load) {
  const entries = new Map(); // mode -> { mode, value, epoch, validUntil }
  let dataDir = '';
  let unsubscribeConfig = null;
  let expiryTimer = null;
  // The value is the file's stamp: a watch event that finds the file's
  // identity changed (or the file gone) is an input change. A stat that fails
  // is a failed re-read, which keeps the last stamp until the next event.
  const stamped = (stamp) => ({ value: stamp, stamp });
  const files = createWatchedFileCache(
    {
      load: (path) => stamped(fileStampSync(path)),
      loadAsync: async (path) => {
        const stamp = await fileStamp(path);
        if (stamp === null) throw new Error(`[config] cannot stat ${path}`);
        return stamped(stamp);
      },
    },
    { onChange: bumpConfigInputEpoch }
  );
  let watched = new Set();

  // Built since the last input change; a stale entry rebuilds on its next read.
  const isLive = (entry) => entry.epoch === configInputEpoch();

  function retarget(dir) {
    entries.clear();
    files.clear();
    watched = new Set();
    dataDir = dir;
    // The config-change pass watches this data dir's config while subscribed;
    // its bump is what the snapshot hears, so the listener has nothing to do.
    unsubscribeConfig?.();
    unsubscribeConfig = subscribeConfigChange(() => {});
  }

  // Watch before loading, so a write after the load is never missed. A path
  // that cannot be stat'ed is left out; its probe reads it as unavailable.
  function watchInputs() {
    const next = new Set(watchedInputFiles());
    for (const path of watched) if (!next.has(path)) files.delete(path);
    for (const path of next) {
      try {
        files.get(path);
      } catch {}
    }
    watched = next;
  }

  // The one deadline time itself sets: the earliest expiry of a live entry.
  // A read past it rebuilds anyway; the timer tells the epoch's listeners.
  function scheduleExpiry() {
    clearTimeout(expiryTimer);
    expiryTimer = null;
    const at = Math.min(...[...entries.values()].filter(isLive).map((entry) => entry.validUntil));
    if (!Number.isFinite(at)) return;
    expiryTimer = setTimeout(
      () => {
        expiryTimer = null;
        if (Date.now() >= at) bumpConfigInputEpoch();
        else scheduleExpiry();
      },
      Math.min(MAX_TIMER_MS, Math.max(0, at - Date.now()))
    );
    expiryTimer.unref?.();
  }

  function keep(entry) {
    entries.set(entry.mode, entry);
    scheduleExpiry();
    return entry;
  }

  function build(mode) {
    watchInputs();
    let loaded;
    try {
      // A config caught mid-write answers the last one that parsed; the
      // credentials, and so `expiresAt`, are read fresh all the same.
      loaded = observeOAuthCredentialExpiry(() => withLastGoodConfigReads(() => load(MODE_OPTIONS[mode])));
    } catch {
      // No config has parsed here yet: the plain loader decides, exactly as loadConfig().
      loaded = observeOAuthCredentialExpiry(() => load(MODE_OPTIONS[mode]));
    }
    return keep({
      mode,
      value: frozenCopy(loaded.value),
      // Read after the load, which is synchronous: the only bumps inside it
      // are the load's own (a keychain cache it filled, a secret marker it
      // applied, a restore it wrote back) and `value` already reflects them.
      // Another process's write arrives as a watch event, delivered after this
      // returns: it moves the epoch then and the next read rebuilds.
      epoch: configInputEpoch(),
      validUntil: loaded.expiresAt,
    });
  }

  /** The agent config loadConfig(options) answers now, frozen. Warm: no I/O.
   *  A first read, or the first after an input changed, builds it on the spot. */
  return function getConfigSnapshot(options = {}) {
    const mode = modeOf(options);
    // Inside withProviderAccount the OAuth probes read that account's files.
    if (mode !== 'none' && hasScopedProviderAuthBinding()) return frozenCopy(load(MODE_OPTIONS[mode]));
    const dir = resolvePluginData();
    if (dir !== dataDir) retarget(dir);
    const entry = entries.get(mode);
    return entry && isLive(entry) && Date.now() < entry.validUntil ? entry.value : build(mode).value;
  };
}
