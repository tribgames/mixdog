import { readFileSync, readdirSync, statSync, mkdirSync, existsSync } from 'node:fs';
import { basename, join, dirname } from 'node:path';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import { resolvePluginData } from './plugin-paths.mjs';
import { hasOwn, isPlainObject } from './object.mjs';
import {
  parseJsonText,
  quarantinePath,
  renameWithRetrySync,
  writeJsonAtomicSync,
  writeJsonAtomicAsync,
  updateJsonAtomicSync,
  updateJsonAtomic,
  withFileLockSync,
  withFileLock,
} from './atomic-file.mjs';
import {
  backupUserData,
  backupUserDataAsync,
  markUserDataInitialized,
  ensureUserDataInitialized,
  loadLatestMixdogConfigFromBackup,
  isUserDataRecoveryExpected,
  findLegacyUserDataEvidence,
  USER_DATA_INIT_MARKER,
} from './user-data-guard.mjs';
import {
  AGENT_PROVIDER_ENV,
  AGENT_PROVIDER_ENV_ALIASES,
  getAgentApiKey,
  setBeforeStoredKeyRead,
} from './provider-api-key.mjs';
import { bumpConfigInputEpoch } from './config-epoch.mjs';
import { watchDirectory } from './directory-watch.mjs';
import { runtimeAsyncLocalStorage } from './root-async-context.mjs';

export { AGENT_PROVIDER_ENV, AGENT_PROVIDER_ENV_ALIASES, getAgentApiKey };

const _require = createRequire(import.meta.url);
const _keychain = _require('../../lib/keychain-cjs.cjs');
const {
  getSecret: _getSecret,
  setSecret: _setSecret,
  deleteSecret: _deleteSecret,
  hasSecret: _hasSecret,
  hasFallbackSecret: _hasFallbackSecret,
  setSecretAsync: _setSecretAsyncImpl,
  deleteSecretAsync: _deleteSecretAsyncImpl,
  keychainStatus: _keychainStatus,
  retryKeychain: _retryKeychain,
  refreshKeychainStatus: _refreshKeychainStatus,
  onKeychainRecovered: _onKeychainRecovered,
  prewarmSecrets: _prewarmSecrets,
} = _keychain;
// Every secret write, deletion or invalidation (this process's own, or another
// process's applied through the change marker) moves the agent config inputs.
_keychain.onSecretsChanged?.(bumpConfigInputEpoch);
const _setSecretAsync = _setSecretAsyncImpl ?? (async (account, value) => _setSecret(account, value));
const _deleteSecretAsync = _deleteSecretAsyncImpl ?? (async (account) => _deleteSecret(account));

// Resolved per call: the pristine-execution boundary retargets
// MIXDOG_resolvePluginData() at runtime, so an import-time capture would write into the
// wrong data dir.
function configPath() {
  return join(resolvePluginData(), 'mixdog-config.json');
}

const GENERATED_KEY = '_generated';

// Marker of the one-time "defaults live in code" separation (see
// defaults-separation.mjs). A file created by this code is born separated, so
// the first write into an empty config stamps the current version.
export const DEFAULTS_VERSION = 2;
export const DEFAULTS_VERSION_KEY = 'defaultsVersion';

function isFreshConfig(root) {
  return !isPlainObject(root) || Object.keys(root).length === 0;
}

function withFreshDefaultsVersion(fresh, root) {
  if (fresh && isPlainObject(root) && !hasOwn(root, DEFAULTS_VERSION_KEY))
    root[DEFAULTS_VERSION_KEY] = DEFAULTS_VERSION;
  return root;
}

let _configReadCache = null; // { raw, path, stat, atMs } | null
// While a change notification runs its listeners (runConfigChangeListeners).
let _inNotificationPass = false;
// MIXDOG_CONFIG_READ_TTL_MS > 0 skips the freshness stat within the window; 0 stats on every read.
const CONFIG_READ_TTL_MS = (() => {
  const n = Number(process.env.MIXDOG_CONFIG_READ_TTL_MS);
  return Number.isFinite(n) && n >= 0 ? n : 0;
})();

function dropConfigReadCache() {
  _configReadCache = null;
}

/** The file may have changed outside this cache (this process wrote it, or a
 *  caller knows it moved): drop the raw cache and mark the agent config
 *  snapshot stale so its next read rebuilds. */
export function invalidateConfigReadCache() {
  dropConfigReadCache();
  bumpConfigInputEpoch();
}

// A replacement of the same size within the mtime's resolution still moves the
// inode (atomic rename) or the change time.
function statKey(st) {
  return `${st.mtimeMs}:${st.ctimeMs}:${st.size}:${st.ino}`;
}

const watchTrusted = (entry) => entry.watch !== 0 && entry.watch === configWatchGeneration();

// undefined when the cache cannot vouch for the file; null is a vouched-for missing config.
function cachedRaw(now) {
  const cached = _configReadCache;
  if (!cached) return undefined;
  if (watchTrusted(cached)) return cached.raw;
  if (CONFIG_READ_TTL_MS > 0 && now - cached.atMs < CONFIG_READ_TTL_MS) return cached.raw;
  try {
    if (statKey(statSync(configPath())) === cached.stat) {
      cached.atMs = now;
      return cached.raw;
    }
  } catch {}
  return undefined;
}

// The config file as the last read from disk or listener pass found it.
let _readSeenConfig = null;

const configFileKey = (st) => `${configPath()}|${st ? statKey(st) : 'missing'}`;

function currentConfigFileKey() {
  try {
    return configFileKey(statSync(configPath()));
  } catch {
    return configFileKey(null);
  }
}

function sawConfigFile(st) {
  const previous = _readSeenConfig;
  _readSeenConfig = configFileKey(st);
  if (previous !== null && previous !== _readSeenConfig) announceFoundChange();
}

function readRawFromDisk(watch, now) {
  let st;
  try {
    st = statSync(configPath());
  } catch (err) {
    if (err.code === 'ENOENT') {
      _configReadCache = missingConfigEntry(watch, now);
      sawConfigFile(null);
      return null;
    }
    process.stderr.write(`[config] readConfigRawCached: unexpected stat error for ${configPath()}: ${err.message}\n`);
    throw err;
  }
  let raw;
  try {
    raw = readFileSync(configPath(), 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') {
      _configReadCache = missingConfigEntry(watch, now);
      sawConfigFile(null);
      return null;
    }
    process.stderr.write(`[config] readJsonFile: unexpected read error for ${configPath()}: ${err.message}\n`);
    throw err;
  }
  _configReadCache = { raw, path: configPath(), stat: statKey(st), atMs: now, watch };
  sawConfigFile(st);
  return raw;
}

function readConfigRawCached() {
  const now = Date.now();
  if (_configReadCache && _configReadCache.path !== configPath()) _configReadCache = null;
  // Taken before the stat and read, so an event during them drops what they fill.
  const watch = configWatchGeneration();
  const hit = cachedRaw(now);
  return hit !== undefined ? hit : readRawFromDisk(watch, now);
}

// A missing config is remembered only under the watch (its creation is an
// event); unwatched, every read looks again as before.
function missingConfigEntry(watch, now) {
  return watch ? { raw: null, path: configPath(), stat: 'missing', atMs: now, watch, empty: false } : null;
}

// The cache entry of a missing config the watch vouches for. The init marker
// sits in the watched directory, and its events drop the entry as well.
function trustedMissingConfig() {
  const entry = _configReadCache;
  return entry && entry.raw === null && watchTrusted(entry) ? entry : null;
}

// Canonical on-disk channel shape. Schedules live in the scheduler DB and
// prompt injection moved to runtime hooks, so neither belongs in config.
export function canonicalizeStoredChannelsConfig(value = {}) {
  const next = isPlainObject(value) ? { ...value } : {};
  delete next.promptInjection;
  delete next.schedules;
  return next;
}

function canonicalizeUnifiedConfig(value = {}) {
  const next = isPlainObject(value) ? { ...value } : {};
  const hadAgent = isPlainObject(next.agent);
  const agent = hadAgent ? { ...next.agent } : {};

  delete agent.outputStyle;
  for (const key of ['autoClear', 'compaction', 'shell']) delete next[key];
  delete next.mcpServers;
  delete agent.search;
  delete agent.capabilities;

  const modules = isPlainObject(agent.modules) ? { ...agent.modules } : {};
  if (hasOwn(modules, 'memory')) {
    delete modules.memory;
    agent.modules = modules;
  }

  if (isPlainObject(next.memory)) {
    const memory = { ...next.memory };
    const user = isPlainObject(memory.user) ? { ...memory.user } : {};
    delete user.title;
    if (Object.keys(user).length) memory.user = user;
    else delete memory.user;
    delete memory.enabled;
    if (Object.keys(memory).length) next.memory = memory;
    else delete next.memory;
  }

  if (isPlainObject(next.channels)) {
    next.channels = canonicalizeStoredChannelsConfig(next.channels);
  }
  // Both sections are retired. `search` had only a fixed timeout that the
  // runtime now owns, while `capabilities.homeAccess` never had a live path
  // consumer or settings writer. Do not keep inert user-facing config.
  delete next.search;
  delete next.capabilities;
  if (hadAgent || Object.keys(agent).length) next.agent = agent;
  return next;
}

function stripGeneratedMarker(data) {
  if (!isPlainObject(data) || !hasOwn(data, GENERATED_KEY)) return data;
  const { [GENERATED_KEY]: _generated, ...rest } = data;
  return rest;
}

// The last config text that parsed on the read path, for withLastGoodConfigReads.
let _lastGoodConfig = null; // { path, raw } | null
// Inside withLastGoodConfigReads.
let _lastGoodReads = false;

// A config that cannot be read or parsed right now, read inside
// withLastGoodConfigReads: the last one that parsed here stands in for it.
function lastGoodConfigOr(error) {
  if (!_lastGoodReads || _lastGoodConfig?.path !== configPath()) throw error;
  return parseJsonText(_lastGoodConfig.raw);
}

function readConfigFile() {
  let raw;
  try {
    raw = readConfigRawCached();
  } catch (err) {
    return lastGoodConfigOr(err);
  }
  if (raw == null) return null;
  let parsed;
  try {
    parsed = parseJsonText(raw);
  } catch (err) {
    dropConfigReadCache();
    if (_inNotificationPass) return lastGoodConfigOr(configMidWriteError(err));
    quarantineMalformedConfig(err);
    return null;
  }
  _lastGoodConfig = { path: configPath(), raw };
  return parsed;
}

function writeConfigFile(data, postBackupReason = 'post-config-write') {
  // secret: true gives the config (it holds provider apiKeys) an owner-only ACL on Windows, where mode bits are advisory.
  mkdirSync(dirname(configPath()), { recursive: true, mode: 0o700 });
  try {
    backupUserData(resolvePluginData(), 'pre-config-write');
  } catch {}
  writeJsonAtomicSync(configPath(), data, { lock: false, fsyncDir: true, mode: 0o600, secret: true });
  // Our own write just changed configPath() on disk; drop the stale raw cache
  // synchronously so the next in-process readAll() reflects it immediately.
  invalidateConfigReadCache();
  try {
    markUserDataInitialized(resolvePluginData());
  } catch {}
  try {
    backupUserData(resolvePluginData(), postBackupReason);
  } catch {}
}

// Config paths whose restore could not be persisted: the in-memory restore is
// still served, but the failure is logged (and the write retried) only once
// per process instead of on every read.
const _restorePersistFailed = new Set();

function persistRestoredConfig(restored) {
  const path = configPath();
  if (_restorePersistFailed.has(path)) return;
  try {
    const wrote = withFileLockSync(
      `${path}.lock`,
      () => {
        if (existsSync(path)) return false;
        writeAll(restored, 'post-restore');
        return true;
      },
      { timeoutMs: 0 }
    );
    if (wrote) {
      process.stderr.write(
        '[config] read: restored mixdog-config.json from latest user-data backup (missing after init) and saved it\n'
      );
    }
  } catch (err) {
    if (err?.code === 'ELOCKCONTENDED') return;
    _restorePersistFailed.add(path);
    process.stderr.write(
      `[config] read: restored mixdog-config.json from latest user-data backup (missing after init); saving it failed, serving it from memory: ${err?.message || err}\n`
    );
  }
}

function readAll() {
  const parsed = readConfigFile();
  if (parsed != null) {
    // A data dir from before the in-dir init marker gets one (plus a first
    // scoped snapshot) once per process, so its config stays recoverable.
    try {
      ensureUserDataInitialized(resolvePluginData());
    } catch {}
    return canonicalizeUnifiedConfig(parsed);
  }
  const missing = trustedMissingConfig();
  if (missing?.empty) return {};
  let lookupFailed = false;
  if (isUserDataRecoveryExpected(resolvePluginData())) {
    let restored = null;
    try {
      restored = loadLatestMixdogConfigFromBackup(resolvePluginData());
    } catch (err) {
      // A transient backup read failure: this read stays empty and the next
      // one retries (an RMW write refuses instead).
      lookupFailed = true;
      process.stderr.write(`[config] backup restore lookup failed: ${err.message}\n`);
    }
    if (restored && isPlainObject(restored)) {
      const config = canonicalizeUnifiedConfig(restored);
      persistRestoredConfig(config);
      return config;
    }
  }
  if (missing && !lookupFailed) missing.empty = true;
  return {};
}

function quarantineMalformedConfig(parseErr) {
  const corrupt = quarantinePath(configPath());
  let keptAside = false;
  try {
    if (existsSync(configPath())) renameWithRetrySync(configPath(), corrupt);
    keptAside = existsSync(corrupt);
    if (keptAside) bumpConfigInputEpoch();
  } catch {}
  process.stderr.write(
    `[config] mixdog-config.json is malformed (${parseErr.message}). Renamed to ${corrupt}. Restore it or delete to start fresh.\n`
  );
  return keptAside;
}

function hasQuarantinedCopy() {
  const dir = dirname(configPath());
  const prefix = `${basename(configPath())}.corrupt-`;
  try {
    return readdirSync(dir).some((name) => name.startsWith(prefix));
  } catch {
    return false;
  }
}

// `keptAside`: the unusable config's bytes are preserved on disk, so with no
// backup to restore a save starts from an empty config instead of refusing.
function restoreAllForRmWOrThrow(reason, keptAside = false) {
  const restored = loadLatestMixdogConfigFromBackup(resolvePluginData(), { fresh: true });
  if (restored && isPlainObject(restored)) {
    process.stderr.write(`[config] RMW read: restored mixdog-config.json from latest user-data backup (${reason})\n`);
    return restored;
  }
  if (keptAside) {
    process.stderr.write(
      `[config] RMW read: mixdog-config.json is unusable (${reason}); its bytes are kept aside and no backup exists; starting empty\n`
    );
    return {};
  }
  const legacy = findLegacyUserDataEvidence(resolvePluginData(), { fresh: true });
  if (legacy) {
    const err = new Error(
      `[config] mixdog-config.json is missing but this data dir (${resolvePluginData()}) was initialized by an older ` +
        `Mixdog build and no backup verified to belong to it was found; refusing to write a fresh config over a ` +
        `recoverable state. Restore mixdog-config.json from a backup under ${legacy.roots.join(' or ')}, or delete ` +
        `the legacy marker(s) to start fresh: ${legacy.markers.join(', ') || '(none; matching legacy backups are incomplete)'}`
    );
    err.code = 'EUSERDATARECOVERY';
    throw err;
  }
  throw new Error(
    `[config] mixdog-config.json is unreadable and no valid backup was found (${reason}); refusing section write that would wipe other sections`
  );
}

function readAllForRmW() {
  let raw;
  try {
    raw = readFileSync(configPath(), 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') {
      if (isUserDataRecoveryExpected(resolvePluginData(), { fresh: true })) {
        return restoreAllForRmWOrThrow('config file missing after user-data was initialized', hasQuarantinedCopy());
      }
      return {};
    }
    process.stderr.write(`[config] readAllForRmW: unexpected read error for ${configPath()}: ${err.message}\n`);
    throw err;
  }
  try {
    const parsed = parseJsonText(raw);
    if (!isPlainObject(parsed)) throw new SyntaxError('config root must be a JSON object');
    return parsed;
  } catch (parseErr) {
    if (_inNotificationPass) throw configMidWriteError(parseErr);
    return restoreAllForRmWOrThrow(parseErr.message, quarantineMalformedConfig(parseErr));
  }
}

const SECRETS_MARKER_FILE = 'mixdog-secrets-changed.json';
const SECRET_DELETED_KEY = '#deleted';
let _secretsSeen = null;
let _secretsSeenPath = '';
let _secretsMarkerStat = '';
// A read applied another process's secret change before the listener pass did.
let _secretsChangedSincePass = false;

function secretsMarkerPath() {
  return join(dirname(configPath()), SECRETS_MARKER_FILE);
}

function secretsMarkerStat(path) {
  try {
    const stat = statSync(path);
    return `${stat.mtimeMs}:${stat.size}:${stat.ino}`;
  } catch {
    return 'missing';
  }
}

function readSecretsMarker() {
  try {
    const parsed = parseJsonText(readFileSync(secretsMarkerPath(), 'utf8'));
    return isPlainObject(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

/** Apply marker entries this process has not seen; answers the changed accounts. */
function syncSecretsMarker() {
  const path = secretsMarkerPath();
  if (_secretsSeenPath !== path) {
    _secretsSeen = null;
    _secretsSeenPath = path;
  }
  _secretsMarkerStat = secretsMarkerStat(path);
  const marker = readSecretsMarker();
  if (_secretsSeen === null) {
    _secretsSeen = marker;
    return [];
  }
  const seen = _secretsSeen;
  const changed = [...new Set([...Object.keys(seen), ...Object.keys(marker)])].filter(
    (account) => seen[account] !== marker[account]
  );
  _secretsSeen = marker;
  if (changed.includes(SECRET_DELETED_KEY)) _keychain.invalidateSecretCache?.();
  else for (const account of changed) if (!account.startsWith('#')) _keychain.invalidateSecretCache?.(account);
  return changed;
}

setBeforeStoredKeyRead(() => syncSecretsMarkerIfMoved());

function syncSecretsMarkerIfMoved() {
  if (_secretsSeen !== null && _secretsSeenPath === secretsMarkerPath()) {
    if (secretsMarkerStat(_secretsSeenPath) === _secretsMarkerStat) return;
  }
  if (!syncSecretsMarker().length) return;
  _secretsChangedSincePass = true;
  announceFoundChange();
}

/** account -> token of the last change of that secret this process has
 *  applied (its own writes and other processes'). Values are never included. */
export function secretChangeTokens() {
  if (_secretsSeen === null) syncSecretsMarker();
  return { ..._secretsSeen };
}

const secretChangeToken = () => `${process.pid}:${Date.now()}:${randomUUID()}`;
function withSecretChange(marker, account, token, deleted) {
  const next = { ...(isPlainObject(marker) ? marker : {}) };
  if (deleted) {
    delete next[account];
    next[SECRET_DELETED_KEY] = token;
  } else {
    next[account] = token;
  }
  return next;
}

function beginSecretChange() {
  // Other processes' changes are applied first, so recording our own token
  // never absorbs theirs unapplied.
  syncSecretsMarker();
  return secretChangeToken();
}

function finishSecretChange(account, token, deleted) {
  // This process already holds the new value (the keychain module updated its
  // cache), so its own change is recorded as applied.
  _secretsSeen = withSecretChange(_secretsSeen, account, token, deleted);
  _secretsMarkerStat = secretsMarkerStat(secretsMarkerPath());
  notifyConfigChanged();
}

const secretMarkerFailure = (err) =>
  process.stderr.write(`[config] secret change marker write failed: ${err?.message || err}\n`);

// Never throws: the secret itself is already stored; a marker that could not
// be written is reported and only delays what other processes see.
function publishSecretChange(account, deleted = false) {
  const token = beginSecretChange();
  try {
    mkdirSync(dirname(secretsMarkerPath()), { recursive: true, mode: 0o700 });
    updateJsonAtomicSync(secretsMarkerPath(), (marker) => withSecretChange(marker, account, token, deleted), {
      mode: 0o600,
    });
  } catch (err) {
    secretMarkerFailure(err);
  }
  finishSecretChange(account, token, deleted);
}

async function publishSecretChangeAsync(account, deleted = false) {
  const token = beginSecretChange();
  try {
    mkdirSync(dirname(secretsMarkerPath()), { recursive: true, mode: 0o700 });
    await updateJsonAtomic(secretsMarkerPath(), (marker) => withSecretChange(marker, account, token, deleted), {
      mode: 0o600,
    });
  } catch (err) {
    secretMarkerFailure(err);
  }
  finishSecretChange(account, token, deleted);
}

const CONFIG_CHANGE_DEBOUNCE_MS = 100;
const WATCHED_FILES = new Set(['mixdog-config.json', SECRETS_MARKER_FILE]);
const CONFIG_DIR_FILES = [...WATCHED_FILES, USER_DATA_INIT_MARKER];
const _configChangeListeners = new Set();
let _configChangeTimer = null;
let _configChangePass = Promise.resolve();

/** Settles once the listener pass started last has run every listener
 *  (it may wait for a keyring snapshot first). */
export function configChangePassSettled() {
  return _configChangePass;
}
// `{ close(), trusted }`: the subscription to the config directory's files.
let _configWatcher = null;
// While the config directory cannot be watched (missing, or its watch
// failed): the subscription that waits for it to be named, in the nearest
// ancestor that can be watched.
let _configWaiter = null;
let _configWatchDir = '';

/** The shared directory watch (directory-watch.mjs `watchDirectory`); tests
 *  substitute failing watches. `vouches`: a live watch's silence means the
 *  files are unchanged, so reads under it skip the file. Not on macOS: there a
 *  directory watch hears only some time after it returns, and every watch the
 *  process starts or closes restarts all of them (libuv's one FSEvents
 *  stream), so a change made meanwhile is never heard. */
export const configWatchDeps = { watch: watchDirectory, vouches: process.platform !== 'darwin' };

function stopConfigWatcher() {
  const watchers = [_configWatcher, _configWaiter];
  _configWatcher = null;
  _configWaiter = null;
  _configWatchDir = '';
  for (const watcher of watchers) watcher?.close();
}

// The watched files' bytes at the last listener pass (or the first subscribe).
// A pass caused only by the watch finds nothing to do when they are unchanged,
// e.g. another process rewriting a marker with identical content.
let _configChangeForced = false;
let _watchedContent = null;

function watchedContent() {
  const dir = dirname(configPath());
  return [...WATCHED_FILES].map((file) => {
    try {
      return readFileSync(join(dir, file), 'latin1');
    } catch {
      return null;
    }
  });
}

function configMidWriteError(parseErr) {
  // That next pass runs the listeners even when the completed bytes equal the
  // ones the previous pass recorded (the save completed back to them).
  _configChangeForced = true;
  const error = new Error(
    `[config] mixdog-config.json does not parse yet (${parseErr.message}); keeping the current config`
  );
  error.code = 'ECONFIG_MID_WRITE';
  return error;
}

async function runConfigChangeListeners() {
  const forced = _configChangeForced;
  _configChangeForced = false;
  // The key before the bytes: a change between them is then found by the next read.
  _readSeenConfig = currentConfigFileKey();
  const content = watchedContent();
  const last = _watchedContent;
  if (!forced && Array.isArray(last) && last.every((value, index) => value === content[index])) return;
  _watchedContent = content;
  // Before any listener runs, so each one reads the changed config.
  invalidateConfigReadCache();
  // A Linux keyring is read only through a snapshot, which the invalidation
  // dropped: re-take it so listeners reload the changed keys.
  const secretsChanged = syncSecretsMarker().length > 0 || _secretsChangedSincePass;
  _secretsChangedSincePass = false;
  if (secretsChanged && process.platform === 'linux') {
    try {
      await _prewarmSecrets?.();
    } catch {}
  }
  _inNotificationPass = true;
  try {
    for (const listener of [..._configChangeListeners]) {
      try {
        listener();
      } catch {}
    }
  } finally {
    _inNotificationPass = false;
  }
}

// In-process writes and a re-established watch always run the listeners (a
// secret stored while its marker write failed changes no watched byte).
function notifyConfigChanged({ fromWatch = false } = {}) {
  if (!_configChangeListeners.size) return;
  if (!fromWatch) _configChangeForced = true;
  // Trailing debounce: the pass reads after the last event of a burst.
  if (_configChangeTimer) clearTimeout(_configChangeTimer);
  _configChangeTimer = setTimeout(() => {
    _configChangeTimer = null;
    _configChangePass = runConfigChangeListeners();
  }, CONFIG_CHANGE_DEBOUNCE_MS);
  _configChangeTimer.unref?.();
}

// Where no watch vouches, a change a read finds by its own check (the config
// file's stat, the secrets marker's) goes the way a watch event's does.
function announceFoundChange() {
  if (!configWatchDeps.vouches && _configWatchDir === dirname(configPath())) notifyConfigChanged({ fromWatch: true });
}

// Moves each time a directory watch starts; 0 while none runs for the current
// config directory, while nothing would hear that directory replaced, or where
// no watch vouches (its reads are then checked by stat). A raw read records it (readConfigRawCached).
let _configWatchStarts = 0;
function configWatchGeneration() {
  if (!configWatchDeps.vouches || !_configWatcher?.trusted || _configWatchDir !== dirname(configPath())) return 0;
  return _configWatchStarts;
}

// Throws what the watch throws when `dir` cannot be watched now.
function watchConfigDir(dir) {
  const watcher = configWatchDeps.watch(dir, CONFIG_DIR_FILES, {
    replace: true,
    onEvent: (_event, name) => {
      // The raw read goes stale at once (the listener pass is debounced). An
      // event with no name — also the directory replaced — may be any file.
      dropConfigReadCache();
      if (name !== USER_DATA_INIT_MARKER) notifyConfigChanged({ fromWatch: true });
    },
    // A watch that errors or closes on its own (or finds the directory gone
    // after a replacement) no longer reports the live directory: its reads
    // stop being trusted at once, and it waits to be named again.
    onLost: () => {
      if (_configWatcher !== watcher) return;
      _configWatcher = null;
      dropConfigReadCache();
      waitForConfigDir(dir, dir);
    },
  });
  _configWatchStarts += 1;
  _configWatcher = watcher;
}

function waitForConfigDir(dir, failed) {
  for (let step = failed; dirname(step) !== step; step = dirname(step)) {
    try {
      // Replaced, the ancestor's watch would follow the moved one: it follows its parent too.
      const waiter = configWatchDeps.watch(dirname(step), [basename(step)], {
        replace: true,
        onEvent: () => {
          if (_configWaiter === waiter) configDirNamed(dir);
        },
        onLost: () => {
          if (_configWaiter !== waiter) return;
          _configWaiter = null;
          waitForConfigDir(dir, dirname(step));
        },
      });
      _configWaiter = waiter;
      return;
    } catch {}
  }
}

// An event named the way to the config directory: watch it if it is there
// now (announcing what changed while it was not watched), else wait closer.
function configDirNamed(dir) {
  const waiter = _configWaiter;
  _configWaiter = null;
  try {
    watchConfigDir(dir);
  } catch {
    waitForConfigDir(dir, dir);
    return;
  } finally {
    // Let go only now: a wait that resumes on the same ancestor keeps its watch.
    waiter.close();
  }
  dropConfigReadCache();
  notifyConfigChanged();
}

function ensureConfigWatcher() {
  const dir = dirname(configPath());
  if ((_configWatcher || _configWaiter) && _configWatchDir === dir) return;
  stopConfigWatcher();
  _configWatchDir = dir;
  try {
    watchConfigDir(dir);
  } catch {
    waitForConfigDir(dir, dir);
  }
}

/** Run `fn` with the reads of a notification pass, except that a config that
 *  cannot be read or parsed right now (a write in progress) answers the last
 *  one that parsed in this process instead of throwing; it is never
 *  quarantined, and the completing write's watch event runs the next pass.
 *  Writes inside still refuse to start from it (ECONFIG_MID_WRITE). With no
 *  config parsed yet the error stands. For the agent config snapshot: the
 *  config part stays last good while everything else is read fresh. */
export function withLastGoodConfigReads(fn) {
  const previous = [_inNotificationPass, _lastGoodReads];
  _inNotificationPass = true;
  _lastGoodReads = true;
  try {
    return fn();
  } finally {
    [_inNotificationPass, _lastGoodReads] = previous;
  }
}

/** Subscribe to persisted config and secret changes (this process or another),
 *  each announced once, after a 100 ms debounce. Returns unsubscribe. This
 *  process's writes are announced at once. Another process's are announced on
 *  the watch event where the watch vouches (configWatchDeps.vouches). Where it
 *  does not (macOS), the event may never come: the change is announced at the
 *  latest by the next read in this process that checks the file it changed,
 *  and while nothing reads, nothing is announced. */
export function subscribeConfigChange(listener) {
  // Another data dir's bytes are no baseline: equal bytes there would hide a change here.
  if (!_configChangeListeners.size || _configWatchDir !== dirname(configPath())) {
    _readSeenConfig = currentConfigFileKey();
    _watchedContent = watchedContent();
  }
  _configChangeListeners.add(listener);
  // The first subscriber fixes the secret baseline this process applies from.
  if (_secretsSeen === null) syncSecretsMarker();
  ensureConfigWatcher();
  return () => {
    _configChangeListeners.delete(listener);
    if (!_configChangeListeners.size) {
      if (_configChangeTimer) clearTimeout(_configChangeTimer);
      _configChangeTimer = null;
      stopConfigWatcher();
    }
  };
}

function writeAll(data, postBackupReason) {
  writeConfigFile(canonicalizeUnifiedConfig(data), postBackupReason);
  notifyConfigChanged();
}

function withConfigLock(fn) {
  return withFileLockSync(`${configPath()}.lock`, fn);
}

export function readSection(section) {
  return stripGeneratedMarker(readAll()[section] ?? null) ?? {};
}

/**
 * One section straight from the file, read-only: never served from the read
 * cache, restored from a backup, quarantined or written. A missing, unreadable
 * or malformed config throws. For checks that must fail closed, where a stale
 * value restored from a backup must not count (developerOptionEnabledStrict).
 */
export function readSectionStrict(section) {
  const parsed = parseJsonText(readFileSync(configPath(), 'utf8'));
  if (!isPlainObject(parsed)) throw new SyntaxError('config root must be a JSON object');
  return stripGeneratedMarker(parsed[section] ?? null) ?? {};
}

export function readConfig() {
  return stripGeneratedMarker(readAll()) ?? {};
}

export function updateConfig(updater) {
  let saved = null;
  withConfigLock(() => {
    const current = stripGeneratedMarker(readAllForRmW()) || {};
    const fresh = isFreshConfig(current);
    const next = typeof updater === 'function' ? updater({ ...current }) : updater;
    if (!isPlainObject(next)) throw new Error('[config] updateConfig updater must return an object');
    saved = withFreshDefaultsVersion(fresh, canonicalizeUnifiedConfig(stripGeneratedMarker(next) || {}));
    writeAll(saved);
  });
  return saved;
}

export function updateSection(section, updater) {
  withConfigLock(() => {
    const all = readAllForRmW();
    const fresh = isFreshConfig(all);
    const current = stripGeneratedMarker(all[section] || {});
    all[section] = stripGeneratedMarker(typeof updater === 'function' ? updater(current) : updater);
    writeAll(withFreshDefaultsVersion(fresh, all));
  });
}

async function writeConfigFileAsync(data) {
  mkdirSync(dirname(configPath()), { recursive: true, mode: 0o700 });
  try {
    await backupUserDataAsync(resolvePluginData(), 'pre-config-write');
  } catch {}
  await writeJsonAtomicAsync(configPath(), data, { lock: false, fsyncDir: true, mode: 0o600, secret: true });
  // As in writeConfigFile: invalidate synchronously after the async
  // write resolves so this process never serves a stale cached config.
  invalidateConfigReadCache();
  try {
    markUserDataInitialized(resolvePluginData());
  } catch {}
  try {
    await backupUserDataAsync(resolvePluginData(), 'post-config-write');
  } catch {}
}

async function writeAllAsync(data) {
  await writeConfigFileAsync(canonicalizeUnifiedConfig(data));
  notifyConfigChanged();
}

function withConfigLockAsync(fn) {
  // Same reasoning as withConfigLock: the ACL belongs on the config file, not
  // on its lock marker, and icacls has no business inside the lock.
  return withFileLock(`${configPath()}.lock`, fn);
}

const _pendingConfigWrites = new Set();
const configWriteOwner = runtimeAsyncLocalStorage();

function trackConfigWrite(work) {
  let promise;
  try {
    promise = Promise.resolve(work());
  } catch (error) {
    promise = Promise.reject(error);
  }
  const owned = configWriteOwner.getStore();
  _pendingConfigWrites.add(promise);
  owned?.add(promise);
  const remove = () => {
    _pendingConfigWrites.delete(promise);
    owned?.delete(promise);
  };
  promise.then(remove, remove);
  return promise;
}

async function settleUntilEmpty(writes) {
  while (writes.size > 0) {
    await Promise.allSettled([...writes]);
  }
}

/** Settles once the config writes in flight at this call have; writes started
 *  later are newer than what a reader needs, and the atomic rename keeps the
 *  file whole while they land. */
export async function pendingConfigWrites() {
  await Promise.allSettled([..._pendingConfigWrites]);
}

/** Settles once no config write of this process is in flight, writes started
 *  while it waits included: the process shutdown barrier. */
export function drainConfigWrites() {
  return settleUntilEmpty(_pendingConfigWrites);
}

/** One session runtime's share of the config writes: `run(fn)` attributes
 *  every write started in `fn`'s async context to it, and `settled()` resolves
 *  once none of them is in flight. */
export function createConfigWriteOwner() {
  const writes = new Set();
  return {
    run: (fn) => configWriteOwner.run(writes, fn),
    settled: () => settleUntilEmpty(writes),
  };
}

export function updateConfigAsync(updater) {
  return trackConfigWrite(async () => {
    let saved = null;
    await withConfigLockAsync(async () => {
      const current = stripGeneratedMarker(readAllForRmW()) || {};
      const fresh = isFreshConfig(current);
      const next = typeof updater === 'function' ? updater({ ...current }) : updater;
      if (!isPlainObject(next)) throw new Error('[config] updateConfigAsync updater must return an object');
      saved = withFreshDefaultsVersion(fresh, canonicalizeUnifiedConfig(stripGeneratedMarker(next) || {}));
      await writeAllAsync(saved);
    });
    return saved;
  });
}

export function updateSectionAsync(section, updater) {
  return trackConfigWrite(() =>
    withConfigLockAsync(async () => {
      const all = readAllForRmW();
      const fresh = isFreshConfig(all);
      const current = stripGeneratedMarker(all[section] || {});
      all[section] = stripGeneratedMarker(typeof updater === 'function' ? updater(current) : updater);
      await writeAllAsync(withFreshDefaultsVersion(fresh, all));
    })
  );
}

export const SECRET_ACCOUNTS = Object.freeze({
  agentApiKey: (provider) => `agent.${provider}.apiKey`,
  openaiUsageSessionKey: 'agent.openai.usageSessionKey',
});

// ── Secret-aware getters ─────────────────────────────────────────────────────
// Read order: ENV MIXDOG_<UPPER_SNAKE> → OS keychain → Linux fallback secrets
// file (read by _getSecret when the keychain has nothing) → null.

function _envKey(account) {
  // 'agent.openai.apiKey' → 'MIXDOG_AGENT_OPENAI_APIKEY'
  return `MIXDOG_${account.replace(/[.\s]+/g, '_').toUpperCase()}`;
}

function _readSecret(account) {
  const envVal = process.env[_envKey(account)];
  if (envVal) return envVal;
  try {
    syncSecretsMarkerIfMoved();
    return _getSecret(account);
  } catch {
    return null;
  }
}

export function getOpenAIUsageSessionKey() {
  return (
    process.env.OPENAI_USAGE_SESSION_KEY ||
    process.env.OPENAI_DASHBOARD_SESSION_KEY ||
    process.env.OPENAI_SESSION_KEY ||
    process.env.MIXDOG_OPENAI_USAGE_SESSION_KEY ||
    _readSecret(SECRET_ACCOUNTS.openaiUsageSessionKey)
  );
}

/**
 * Persist a secret to the OS keychain; on a Linux host with no keychain provider
 * (secret-tool/libsecret missing, no Secret Service) to the owner-only secrets
 * file in the data dir instead. Throws on failure.
 * Never writes to mixdog-config.json.
 */
export function saveSecret(account, value) {
  try {
    _setSecret(account, value);
  } catch (err) {
    throw saveSecretError(account, err);
  }
  publishSecretChange(account);
}

/** Non-blocking saveSecret: Linux secret-tool runs off the event loop. */
export async function saveSecretAsync(account, value) {
  try {
    await _setSecretAsync(account, value);
  } catch (err) {
    throw saveSecretError(account, err);
  }
  await publishSecretChangeAsync(account);
}

function saveSecretError(account, err) {
  const envKey = _envKey(account);
  const agentMatch = String(account || '').match(/^agent\.([^.]+)\.apiKey$/);
  const stdEnv = agentMatch ? AGENT_PROVIDER_ENV[agentMatch[1]] : null;
  const envHint = stdEnv ? `${stdEnv} (or ${envKey})` : envKey;
  const e = new Error(
    `[config] could not save secret to the OS keychain: ${err?.message ? err.message : err}\n` +
      `  Set the ${envHint} environment variable instead — the runtime reads it directly.`
  );
  e.cause = err;
  return e;
}

/** Remove a secret from the OS keychain (if present) and the Linux fallback file. */
export function deleteSecret(account) {
  _deleteSecret(account);
  publishSecretChange(account, true);
}

/** Non-blocking deleteSecret: Linux secret-tool runs off the event loop. */
export async function deleteSecretAsync(account) {
  await _deleteSecretAsync(account);
  await publishSecretChangeAsync(account, true);
}

/**
 * The keychain as a credential store for modules that keep their own secrets
 * in it (MCP OAuth tokens and client secrets, Gmail app passwords). Reads are
 * the keychain's own; every write publishes the secret change marker exactly
 * as saveSecret/deleteSecret do, so other processes learn of it. Write errors
 * stay the keychain's: the provider-key environment hint of saveSecret does
 * not apply to these accounts. Calls reach the keychain module at call time.
 * `{ announce: false }` writes without the marker, for a change other
 * processes observe by their own means (an MCP OAuth token refresh: its
 * revision marker), so it does not reach every runtime as a settings change.
 * Reads first apply the marker, so a process without a config-change
 * subscriber never serves a secret changed or forgotten elsewhere.
 */
export const keychainSecretStore = Object.freeze({
  getSecretAsync(account) {
    syncSecretsMarkerIfMoved();
    return _keychain.getSecretAsync(account);
  },
  invalidateSecretCache: (account) => _keychain.invalidateSecretCache?.(account),
  async setSecretAsync(account, value, { announce = true } = {}) {
    await _keychain.setSecretAsync(account, value);
    if (announce) await publishSecretChangeAsync(account);
  },
  async deleteSecretAsync(account, { announce = true } = {}) {
    await _keychain.deleteSecretAsync(account);
    if (announce) await publishSecretChangeAsync(account, true);
  },
});

/** Announce a change of state kept outside mixdog-config.json that settings
 *  depend on (`plugins`: the plugin registry), under a reserved `#` key of the
 *  secret change marker, so it reaches other processes on the same path. */
export function announceStoredStateChange(key) {
  publishSecretChange(`#${key}`);
}

/** Retry a failed Linux keyring read; true when it just recovered. */
export async function retryKeychain(options) {
  return typeof _retryKeychain === 'function' ? await _retryKeychain(options) : false;
}

/** Passively detect a keyring that locked after it was read and re-snapshot a
 *  stale cache (no unlock prompt). Resolves true when stored values changed. */
export async function refreshKeychainStatus(options) {
  return typeof _refreshKeychainStatus === 'function' ? (await _refreshKeychainStatus(options)) === true : false;
}

/** Subscribe to a locked/failed Linux keyring becoming readable again. */
export function onKeychainRecovered(listener) {
  return typeof _onKeychainRecovered === 'function' ? _onKeychainRecovered(listener) : () => {};
}

/** Keyring health for the UI: { state: ok|locked|missing|unreachable|error|unknown, message, fallback }.
 *  `fallback` is true when no keychain provider exists on this Linux host and
 *  secrets live in the private secrets file: working storage, not a failure. */
export function getKeychainStatus() {
  return typeof _keychainStatus === 'function' ? _keychainStatus() : { state: 'unknown', message: '' };
}

/**
 * Whether a secret is stored in the OS keychain (or Linux fallback file) for
 * `account` (ignores env).
 * Lets the setup UI show "Set" WITHOUT ever sending the secret value to the
 * browser.
 */
export function hasStoredSecret(account) {
  try {
    syncSecretsMarkerIfMoved();
    if (typeof _hasSecret === 'function') return !!_hasSecret(account);
    return !!_getSecret(account);
  } catch {
    return false;
  }
}

/** Whether `account`'s stored secret currently lives in the Linux fallback file
 *  (never true on Windows/macOS). Lets the UI label where a key is kept. */
export function isFallbackSecret(account) {
  return typeof _hasFallbackSecret === 'function' ? !!_hasFallbackSecret(account) : false;
}

export { configPath };
