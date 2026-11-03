/**
 * Unified config reader/writer.
 * Single file: mixdog-config.json with sections such as channels, agent, and memory.
 */
import { readFileSync, readdirSync, statSync, mkdirSync, existsSync, watch as fsWatch } from 'node:fs';
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
} from './user-data-guard.mjs';
import { AGENT_PROVIDER_ENV, AGENT_PROVIDER_ENV_ALIASES, getAgentApiKey } from './provider-api-key.mjs';
import { bumpConfigInputEpoch } from './config-epoch.mjs';

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

// Process-wide short-TTL cache of the RAW utf8 string of configPath() (never
// the parsed object). Parallel agent spawns each hit the non-RMW read path
// (readAll → readSection/readConfig/readCapabilities); without this every
// spawn pays a synchronous readFileSync(configPath()) on the event loop,
// serializing the whole fanout behind redundant disk I/O. Caching the raw
// string — not the parsed object — lets each caller re-JSON.parse for an
// isolated, freely-mutable object (no shared-reference poisoning). Only the
// non-RMW readAll() consults this; the RMW path (readAllForRmW) always reads
// disk under the lock. Read errors and malformed JSON are never cached.
let _configReadCache = null; // { raw, path, stat, atMs } | null
// While a change notification runs its listeners (runConfigChangeListeners).
let _inNotificationPass = false;
// Optional coarse fast-path window (ms). Default 0 => the cached raw string is
// validated against the file's mtime+size on EVERY read via a cheap statSync
// (no content read, no whole-file JSON.parse), so a cross-process edit is
// observed immediately with ZERO time-based staleness while the expensive
// full read + parse are still skipped on an unchanged file. Set >0 to also
// skip the statSync within the window, trading a bounded staleness for fewer
// syscalls under extreme spawn fanout.
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

function readConfigRawCached() {
  const now = Date.now();
  if (_configReadCache && _configReadCache.path !== configPath()) _configReadCache = null;
  if (_configReadCache) {
    // Fast path (only when a TTL window is configured): serve without any
    // syscall until the window lapses.
    if (CONFIG_READ_TTL_MS > 0 && now - _configReadCache.atMs < CONFIG_READ_TTL_MS) {
      return _configReadCache.raw;
    }
    // Freshness gate: metadata-only stat. Unchanged mtime+ctime+size+inode => the cached
    // raw is still current, cross-process writes included — atomic writers land
    // a new inode with a fresh mtime, so this reliably detects them.
    try {
      const st = statSync(configPath());
      if (statKey(st) === _configReadCache.stat) {
        _configReadCache.atMs = now;
        return _configReadCache.raw;
      }
    } catch {
      // stat failed (e.g. transient ENOENT mid-rename); fall through to a fresh
      // read which re-applies the ENOENT/backup-restore semantics below.
    }
  }
  // Stat BEFORE read: if a write lands between the two we cache newer content
  // against the older mtime, so the very next call re-reads instead of getting
  // stuck on stale bytes — the cache always converges toward fresh.
  let st = null;
  try {
    st = statSync(configPath());
  } catch (err) {
    if (err.code === 'ENOENT') {
      _configReadCache = null;
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
      _configReadCache = null;
      return null;
    }
    // Fail closed on unknown read errors (EACCES, EIO, …); do NOT cache.
    process.stderr.write(`[config] readJsonFile: unexpected read error for ${configPath()}: ${err.message}\n`);
    throw err;
  }
  _configReadCache = { raw, path: configPath(), stat: statKey(st), atMs: now };
  return raw;
}

// Canonical on-disk channel shape. Schedules live in the scheduler DB and
// prompt injection moved to runtime hooks, so neither belongs in config.
export function canonicalizeStoredChannelsConfig(value = {}) {
  const next = isPlainObject(value) ? { ...value } : {};
  delete next.promptInjection;
  delete next.schedules;
  return next;
}

// Scrub retired cross-section keys without touching independent domains
// (ui/theme, desktop, voice, channels access, memory schedules/embedding, …).
// No migration: canonical locations are the only ones read, and stale keys
// from old installs are DROPPED, not folded in. Reads use this shape
// in-memory; every subsequent locked write persists it.
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

function readConfigFile() {
  // Non-RMW read path: served from the short-TTL raw-string cache. Returning
  // {} on a read error here would let a subsequent updateSection() serialize
  // an empty object over an existing-but-temporarily-unreadable config and
  // erase every other section, so read errors surface (throw) uncached.
  const raw = readConfigRawCached();
  if (raw == null) return null;
  try {
    return parseJsonText(raw);
  } catch (err) {
    // Quarantine a malformed mixdog-config.json so the next boot starts fresh
    // instead of looping on a broken file. A cached raw string that fails to
    // parse must not be re-served; drop it so the post-quarantine/restore read
    // hits disk fresh (malformed = never cached).
    dropConfigReadCache();
    if (_inNotificationPass) throw configMidWriteError(err);
    quarantineMalformedConfig(err);
    return null;
  }
}

function writeConfigFile(data, postBackupReason = 'post-config-write') {
  // R4 data-at-rest: mixdog-config.json holds provider apiKeys; clamp to
  // owner-only on POSIX via 0o600/0o700 mode bits, AND fail-closed on
  // Windows where those bits are advisory — `secret: true` makes the
  // atomic writer apply an owner-only NTFS ACL (icacls) to the file,
  // temp, lock, and parent dir, throwing if the ACL cannot be enforced
  // so the key is never left world-readable. 0o700 on the parent dir
  // restricts directory traversal in shared-home setups on POSIX.
  mkdirSync(dirname(configPath()), { recursive: true, mode: 0o700 });
  // NOTE: lock:false here — callers that perform read-modify-write
  // (updateConfig/updateSection and their async twins) hold the lock at
  // the outer RMW boundary, so the inner write must not try to re-acquire
  // the same lock file (would self-deadlock on `openSync('wx')`). Direct
  // whole-config writers go through `writeAll` below.
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

/**
 * Write a config restored on a plain read back to disk through the normal save
 * path (atomic write + backups), so later reads hit the file instead of
 * restoring again. Try-once lock: a contended lock means a writer (possibly
 * this process's own outer RMW) is about to persist, so the next read retries.
 */
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
  // Symmetric with readAllForRmW(): a missing/unreadable config on a data
  // dir that was previously initialized means the file was LOST (deleted,
  // failed write), not a fresh install. A recreated data dir has no marker
  // and starts fresh. Self-heal from this data dir's newest
  // structurally-complete backup instead of silently collapsing to {} —
  // which callers (readSection/getCapabilities) merge with in-memory
  // defaults, dropping the user's presets/agent routes/sections. The restore
  // is persisted under the config lock (only if the file is still missing) so
  // later reads hit the file instead of restoring and logging again.
  // An upgraded data dir (legacy marker / matching legacy backup, no in-dir
  // marker yet) is a recovery case too; without a verifiable backup reads stay
  // empty and RMW writes refuse (see readAllForRmW).
  if (isUserDataRecoveryExpected(resolvePluginData())) {
    let restored = null;
    try {
      restored = loadLatestMixdogConfigFromBackup(resolvePluginData());
    } catch (err) {
      // A transient backup read failure: this read stays empty and the next
      // one retries (an RMW write refuses instead).
      process.stderr.write(`[config] backup restore lookup failed: ${err.message}\n`);
    }
    if (restored && isPlainObject(restored)) {
      const config = canonicalizeUnifiedConfig(restored);
      persistRestoredConfig(config);
      return config;
    }
  }
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

// A damaged config that was kept aside (its bytes preserved as
// mixdog-config.json.corrupt-<ts>) is not a lost config: those bytes are the
// safety net, so with no backup to restore a save may start from an empty
// config. Every save also snapshots a backup, so a stale copy from an earlier
// incident never reaches this point while a backup of a later config exists.
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

/**
 * Read-modify-write baseline. ENOENT on a never-initialized data dir → {}.
 * Malformed on-disk config (or missing config after prior init) → restore
 * from backup or throw; never silently collapse to a one-section overwrite.
 * The exception is a damaged config whose bytes were kept aside as
 * .corrupt-<ts>: with no backup to restore, the save starts from an empty
 * config. A config that cannot be READ (I/O error) still throws.
 */
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

// Secret change marker. Keychain writes never touch mixdog-config.json, so they
// publish through this file beside it (account -> token of its last change):
// it rides the same directory watch and notification as a config write. Each
// process remembers the tokens it has applied and drops exactly the changed
// accounts from its keychain read cache before listeners reload.
// A deletion removes the account's entry (the marker holds live accounts only)
// and moves this token: a process that never saw the account's entry (a secret
// stored before the marker existed, or set and deleted between two of its
// syncs) may still cache it, so it drops its whole keychain read cache.
const SECRETS_MARKER_FILE = 'mixdog-secrets-changed.json';
const SECRET_DELETED_KEY = '#deleted';
let _secretsSeen = null;
let _secretsSeenPath = '';
let _secretsMarkerStat = '';

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

// The read path of a process that may have no config-change subscriber (an
// injected config, a helper process): one stat, and a re-read only when the
// marker moved, so a secret changed or forgotten elsewhere is never served
// from this process's cache.
function syncSecretsMarkerIfMoved() {
  if (_secretsSeen !== null && _secretsSeenPath === secretsMarkerPath()) {
    if (secretsMarkerStat(_secretsSeenPath) === _secretsMarkerStat) return;
  }
  syncSecretsMarker();
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
  bumpConfigInputEpoch();
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

// Config-change notification. In-process writes notify directly after the file
// is persisted; writes from other processes arrive through one lazily started
// directory watch (the atomic rename replaces the file, which would orphan a
// file-level watch on POSIX). Bursts coalesce into one listener pass.
const CONFIG_CHANGE_DEBOUNCE_MS = 100;
// A watch that failed (or could not start) is re-established on this delay
// while anyone listens; changes missed meanwhile are announced once it is back.
const CONFIG_WATCH_RETRY_MS = 1000;
const WATCHED_FILES = new Set(['mixdog-config.json', SECRETS_MARKER_FILE]);
const _configChangeListeners = new Set();
let _configChangeTimer = null;
let _configWatcher = null;
let _configWatchDir = '';
let _configWatchRetryTimer = null;

/** The directory watch implementation; tests substitute a failing watcher. */
export const configWatchDeps = { watch: fsWatch };

function stopConfigWatcher() {
  try {
    _configWatcher?.close();
  } catch {}
  _configWatcher = null;
  _configWatchDir = '';
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

// A config that does not parse while a notification pass runs its listeners
// is usually a write in progress (a hand edit saved half-typed or torn, maybe
// landing after the pass began): every read of the pass (readConfigFile,
// readAllForRmW) then throws instead of quarantining it, so the listeners keep
// their current config, and the pass runs again once shortly. Only reads
// outside a pass (boot, explicit reads, writes) quarantine it.
const CONFIG_SETTLE_RETRY_MS = 300;
let _configSettleTimer = null;
let _configSettleRetried = false;

function configMidWriteError(parseErr) {
  // The retry runs the listeners even when the bytes then equal the ones this
  // pass saw (the save completed back to them).
  _configChangeForced = true;
  if (!_configSettleRetried && !_configSettleTimer && _configChangeListeners.size) {
    _configSettleTimer = setTimeout(() => {
      _configSettleTimer = null;
      _configSettleRetried = true;
      void runConfigChangeListeners();
    }, CONFIG_SETTLE_RETRY_MS);
    _configSettleTimer.unref?.();
  }
  const error = new Error(
    `[config] mixdog-config.json does not parse yet (${parseErr.message}); keeping the current config`
  );
  error.code = 'ECONFIG_MID_WRITE';
  return error;
}

async function runConfigChangeListeners() {
  const forced = _configChangeForced;
  _configChangeForced = false;
  const content = watchedContent();
  const last = _watchedContent;
  if (!forced && Array.isArray(last) && last.every((value, index) => value === content[index])) return;
  _watchedContent = content;
  dropConfigReadCache();
  // A Linux keyring is read only through a snapshot, which the invalidation
  // dropped: re-take it so listeners reload the changed keys.
  if (syncSecretsMarker().length && process.platform === 'linux') {
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
  _configSettleRetried = false;
  if (_configChangeTimer) clearTimeout(_configChangeTimer);
  _configChangeTimer = setTimeout(() => {
    _configChangeTimer = null;
    void runConfigChangeListeners();
  }, CONFIG_CHANGE_DEBOUNCE_MS);
  _configChangeTimer.unref?.();
}

function scheduleConfigWatchRetry() {
  if (_configWatchRetryTimer || !_configChangeListeners.size) return;
  _configWatchRetryTimer = setTimeout(() => {
    _configWatchRetryTimer = null;
    if (!_configChangeListeners.size) return;
    ensureConfigWatcher();
    if (_configWatcher) notifyConfigChanged();
  }, CONFIG_WATCH_RETRY_MS);
  _configWatchRetryTimer.unref?.();
}

function ensureConfigWatcher() {
  const dir = dirname(configPath());
  if (_configWatcher && _configWatchDir === dir) return;
  stopConfigWatcher();
  try {
    const watcher = configWatchDeps.watch(dir, (_event, filename) => {
      if (!filename || WATCHED_FILES.has(String(filename))) notifyConfigChanged({ fromWatch: true });
    });
    watcher.unref?.();
    watcher.on?.('error', () => {
      if (_configWatcher !== watcher) return;
      stopConfigWatcher();
      scheduleConfigWatchRetry();
    });
    _configWatcher = watcher;
    _configWatchDir = dir;
  } catch {
    _configWatcher = null;
    scheduleConfigWatchRetry();
  }
}

/** Run `fn` with the reads of a notification pass: a config that does not parse
 *  is taken for a write in progress and throws ECONFIG_MID_WRITE instead of
 *  being quarantined, and the pass is retried once shortly. For a reader that
 *  keeps its last good result (the agent config snapshot). */
export function withMidWriteTolerantReads(fn) {
  const previous = _inNotificationPass;
  _inNotificationPass = true;
  try {
    return fn();
  } finally {
    _inNotificationPass = previous;
  }
}

/** Moves whenever a keychain read may answer differently (see keychain-cjs). */
export function secretCacheVersion() {
  return _keychain.secretCacheVersion?.() ?? 0;
}

/** The files beside the config whose change a config-change subscriber hears:
 *  the config itself and the secret change marker. */
export function configInputFiles() {
  return [configPath(), secretsMarkerPath()];
}

/** Subscribe to persisted config and secret changes (this process or another). Returns unsubscribe. */
export function subscribeConfigChange(listener) {
  if (!_configChangeListeners.size) _watchedContent = watchedContent();
  _configChangeListeners.add(listener);
  // The first subscriber fixes the secret baseline this process applies from.
  if (_secretsSeen === null) syncSecretsMarker();
  ensureConfigWatcher();
  return () => {
    _configChangeListeners.delete(listener);
    if (!_configChangeListeners.size) {
      if (_configChangeTimer) clearTimeout(_configChangeTimer);
      _configChangeTimer = null;
      clearTimeout(_configSettleTimer);
      _configSettleTimer = null;
      if (_configWatchRetryTimer) clearTimeout(_configWatchRetryTimer);
      _configWatchRetryTimer = null;
      stopConfigWatcher();
    }
  };
}

function writeAll(data, postBackupReason) {
  writeConfigFile(canonicalizeUnifiedConfig(data), postBackupReason);
  notifyConfigChanged();
}

// Serialize a read-modify-write under the same file lock. Concurrent
// processes used to race here: each read the old config, each computed
// `all[section] = …`, each atomic-wrote — the later writer would
// silently clobber the earlier section update. Holding the lock across
// read+modify+write keeps RMW linearizable.
function withConfigLock(fn) {
  // The lock file itself carries no secret — only `<pid> <ts> <token>`, an
  // integrity marker. Clamping IT owner-only meant two synchronous icacls
  // spawns (plus whoami) INSIDE the critical section on every config write:
  // hundreds of ms with the daemon's event loop parked and every other writer
  // queued behind it. The CONFIG file keeps secret:true, which is where the
  // API keys actually live.
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

// ── Async write path (non-blocking) ─────────────────────────────────
// Parity with the sync RMW above, but every heavy blocker (cross-process
// lock wait, owner-only icacls ACL, user-data backup copy tree) is awaited
// off the event loop. Reuses the SAME lock file (`${configPath()}.lock`) and
// secret:true ACL protocol, so an async writer and a sync writer are mutually
// exclusive against one another AND against other processes — cross-process
// RMW linearizability is preserved. The in-lock read (readAllForRmW) stays
// synchronous: it is a small local read, not the hitch source.
async function writeConfigFileAsync(data) {
  mkdirSync(dirname(configPath()), { recursive: true, mode: 0o700 });
  try {
    await backupUserDataAsync(resolvePluginData(), 'pre-config-write');
  } catch {}
  await writeJsonAtomicAsync(configPath(), data, { lock: false, fsyncDir: true, mode: 0o600, secret: true });
  // Parity with writeConfigFile: invalidate synchronously after the async
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

// Process-wide registry at the lock-owning layer: every public async RMW path
// registers before lock acquisition and unregisters on both fulfillment and
// rejection. Lifecycle teardown can therefore drain direct callers too, not
// just its own debounce queues.
const _pendingConfigWrites = new Set();

function trackConfigWrite(work) {
  let promise;
  try {
    promise = Promise.resolve(work());
  } catch (error) {
    promise = Promise.reject(error);
  }
  _pendingConfigWrites.add(promise);
  const remove = () => {
    _pendingConfigWrites.delete(promise);
  };
  promise.then(remove, remove);
  return promise;
}

export async function pendingConfigWrites() {
  while (_pendingConfigWrites.size > 0) {
    await Promise.allSettled([..._pendingConfigWrites]);
  }
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

// ── Secret account names ─────────────────────────────────────────────────────
// Canonical account strings stored in the OS keychain (or, on a Linux host with
// no usable keychain provider, in the private secrets file behind the same
// get/set/delete calls: keychain-cjs.cjs "Linux fallback file").
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
  // Reached for a locked keyring, a non-Linux keychain failure, or a Linux host
  // with no keychain provider whose fallback secrets file could not be written
  // (keychain-cjs.cjs). Surface an actionable message that points at the
  // env-var read path the getters already honor, instead of silently writing
  // the plaintext secret to mixdog-config.json. The fallback is a separate
  // owner-only file, never the config.
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
    else bumpConfigInputEpoch();
  },
  async deleteSecretAsync(account, { announce = true } = {}) {
    await _keychain.deleteSecretAsync(account);
    if (announce) await publishSecretChangeAsync(account, true);
    else bumpConfigInputEpoch();
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
