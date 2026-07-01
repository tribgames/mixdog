/**
 * Unified config reader/writer.
 * Single file: mixdog-config.json with sections such as channels, agent, and memory.
 */
import { readFileSync, mkdirSync, existsSync } from 'fs'
import { join, dirname } from 'path'
import { createRequire } from 'module'
import { resolvePluginData } from './plugin-paths.mjs'
import { renameWithRetrySync, writeJsonAtomicSync, withFileLockSync } from './atomic-file.mjs'
import {
  backupUserData,
  markUserDataInitialized,
  loadLatestMixdogConfigFromBackup,
  hasUserDataInitMarker,
} from './user-data-guard.mjs'

const _require = createRequire(import.meta.url)
const { getSecret: _getSecret, setSecret: _setSecret, deleteSecret: _deleteSecret, hasSecret: _hasSecret } = _require('../../lib/keychain-cjs.cjs')

const DATA_DIR = resolvePluginData()

const CONFIG_PATH = join(DATA_DIR, 'mixdog-config.json')

const GENERATED_KEY = '_generated'

function isPlainObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

export function stripGeneratedMarker(data) {
  if (!isPlainObject(data) || !Object.prototype.hasOwnProperty.call(data, GENERATED_KEY)) return data
  const { [GENERATED_KEY]: _generated, ...rest } = data
  return rest
}

function readJsonFile(path) {
  let raw
  try {
    raw = readFileSync(path, 'utf8')
  } catch (err) {
    if (err.code === 'ENOENT') return null
    // Fail closed on unknown read errors (EACCES, EIO, …). Returning {}
    // here would let a subsequent writeSection() serialize an empty
    // object back over an existing-but-temporarily-unreadable config and
    // erase every other section. Better to surface the read error and
    // abort the RMW than silently destroy data.
    process.stderr.write(`[config] readJsonFile: unexpected read error for ${path}: ${err.message}\n`)
    throw err
  }
  try {
    return JSON.parse(raw)
  } catch (err) {
    // Quarantine a malformed mixdog-config.json so the next boot starts fresh
    // instead of looping on a broken file.
    if (path === CONFIG_PATH) {
      const corrupt = `${path}.corrupt-${Date.now()}`
      try { renameWithRetrySync(path, corrupt) } catch {}
      process.stderr.write(`[config] mixdog-config.json is malformed (${err.message}). Renamed to ${corrupt}. Restore it or delete to start fresh.\n`)
    }
    return null
  }
}

function writeJsonFile(path, data) {
  // R4 data-at-rest: mixdog-config.json holds provider apiKeys; clamp to
  // owner-only on POSIX via 0o600/0o700 mode bits, AND fail-closed on
  // Windows where those bits are advisory — `secret: true` makes the
  // atomic writer apply an owner-only NTFS ACL (icacls) to the file,
  // temp, lock, and parent dir, throwing if the ACL cannot be enforced
  // so the key is never left world-readable. 0o700 on the parent dir
  // restricts directory traversal in shared-home setups on POSIX.
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  // NOTE: lock:false here — callers that perform read-modify-write
  // (writeSection/updateSection) hold the lock at the outer RMW
  // boundary, so the inner write must not try to re-acquire the same
  // lock file (would self-deadlock on `openSync('wx')`). Direct
  // whole-config writers go through `writeAllLocked` below.
  if (path === CONFIG_PATH) {
    try { backupUserData(DATA_DIR, 'pre-config-write') } catch {}
  }
  writeJsonAtomicSync(path, data, { lock: false, fsyncDir: true, mode: 0o600, secret: true })
  if (path === CONFIG_PATH) {
    try { markUserDataInitialized(DATA_DIR) } catch {}
    try { backupUserData(DATA_DIR, 'post-config-write') } catch {}
  }
}

function readAll() {
  const parsed = readJsonFile(CONFIG_PATH)
  if (parsed != null) return parsed
  // Symmetric with readAllForRmW(): a missing/unreadable config on a data
  // dir that was previously initialized means the file was LOST (deleted,
  // failed write), not a fresh install. Self-heal from the newest
  // structurally-complete backup instead of silently collapsing to {} —
  // which callers (readSection/getCapabilities) merge with in-memory
  // defaults, dropping the user's presets/agent routes/sections. In-memory only:
  // readAll() runs OUTSIDE the config lock (unlike the RMW path), so we do
  // not write here to avoid an unlocked-write race; the next writeSection
  // re-persists the file under the lock.
  if (hasUserDataInitMarker(DATA_DIR)) {
    const restored = loadLatestMixdogConfigFromBackup(DATA_DIR)
    if (restored && isPlainObject(restored)) {
      process.stderr.write('[config] read: restored mixdog-config.json from latest user-data backup (missing after init)\n')
      return restored
    }
  }
  return {}
}

function quarantineMalformedConfig(parseErr) {
  const corrupt = `${CONFIG_PATH}.corrupt-${Date.now()}`
  try {
    if (existsSync(CONFIG_PATH)) renameWithRetrySync(CONFIG_PATH, corrupt)
  } catch {}
  process.stderr.write(
    `[config] mixdog-config.json is malformed (${parseErr.message}). Renamed to ${corrupt}. Restore it or delete to start fresh.\n`,
  )
}

function restoreAllForRmWOrThrow(reason) {
  const restored = loadLatestMixdogConfigFromBackup(DATA_DIR)
  if (restored && isPlainObject(restored)) {
    process.stderr.write(`[config] RMW read: restored mixdog-config.json from latest user-data backup (${reason})\n`)
    return restored
  }
  throw new Error(
    `[config] mixdog-config.json is unreadable and no valid backup was found (${reason}); refusing section write that would wipe other sections`,
  )
}

/**
 * Read-modify-write baseline. ENOENT on a never-initialized data dir → {}.
 * Malformed on-disk config (or missing config after prior init) → restore
 * from backup or throw; never silently collapse to a one-section overwrite.
 */
function readAllForRmW() {
  let raw
  try {
    raw = readFileSync(CONFIG_PATH, 'utf8')
  } catch (err) {
    if (err.code === 'ENOENT') {
      if (hasUserDataInitMarker(DATA_DIR)) {
        return restoreAllForRmWOrThrow('config file missing after user-data was initialized')
      }
      return {}
    }
    process.stderr.write(`[config] readAllForRmW: unexpected read error for ${CONFIG_PATH}: ${err.message}\n`)
    throw err
  }
  try {
    const parsed = JSON.parse(raw)
    if (!isPlainObject(parsed)) throw new SyntaxError('config root must be a JSON object')
    return parsed
  } catch (parseErr) {
    quarantineMalformedConfig(parseErr)
    return restoreAllForRmWOrThrow(parseErr.message)
  }
}

function writeAll(data) {
  writeJsonFile(CONFIG_PATH, data)
}

// Serialize a read-modify-write under the same file lock. Concurrent
// processes used to race here: each read the old config, each computed
// `all[section] = …`, each atomic-wrote — the later writer would
// silently clobber the earlier section update. Holding the lock across
// read+modify+write keeps RMW linearizable.
function withConfigLock(fn) {
  // secret:true clamps the lock file (which sits beside the API-key
  // config in a possibly shared home dir) to an owner-only ACL on win32,
  // fail-closed. POSIX is unaffected.
  return withFileLockSync(`${CONFIG_PATH}.lock`, fn, { secret: true })
}

export function readSection(section) {
  return stripGeneratedMarker(readAll()[section] ?? null) ?? {}
}

export function readConfig() {
  return stripGeneratedMarker(readAll()) ?? {}
}

export function updateConfig(updater) {
  let saved = null
  withConfigLock(() => {
    const current = stripGeneratedMarker(readAllForRmW()) || {}
    const next = typeof updater === 'function' ? updater({ ...current }) : updater
    if (!isPlainObject(next)) throw new Error('[config] updateConfig updater must return an object')
    saved = stripGeneratedMarker(next) || {}
    writeAll(saved)
  })
  return saved
}

export function writeSection(section, data) {
  withConfigLock(() => {
    const all = readAllForRmW()
    all[section] = stripGeneratedMarker(data)
    writeAll(all)
  })
}

export function updateSection(section, updater) {
  withConfigLock(() => {
    const all = readAllForRmW()
    const current = stripGeneratedMarker(all[section] || {})
    all[section] = stripGeneratedMarker(typeof updater === 'function' ? updater(current) : updater)
    writeAll(all)
  })
}

// ── Capabilities (B2 central path policy) ───────────────────────────
// Top-level `capabilities` section in mixdog-config.json. Safe defaults
// win on missing/malformed input — every cap is OFF unless explicitly
// enabled. Settings round-trip through the setup UI; the in-process
// path gate reads them via `getCapabilities()`.
//
// homeAccess: when true, file tools may write anywhere under $HOME. When
// false (default), file tools are cwd-scoped — matches the setup UI's
// out-of-the-box "OFF" toggle so a fresh install is restrictive until the
// user explicitly opts in. This ONLY controls the main-agent path gate —
// agent role Edit/Write to HOME paths always go through Discord approval
// regardless (enforced in hooks/pre-tool-subagent.cjs).
const CAPABILITY_DEFAULTS = Object.freeze({ homeAccess: false })

function readCapabilities() {
  const raw = readAll().capabilities
  const out = { ...CAPABILITY_DEFAULTS }
  if (raw && typeof raw === 'object') {
    if (raw.homeAccess === true) out.homeAccess = true
    else if (raw.homeAccess === false) out.homeAccess = false
  }
  return out
}

// Convenience alias requested by B2 call-site plumbing. Returns the
// same object shape as readCapabilities(); callers that only need a
// boolean can read `.homeAccess` directly.
export function getCapabilities() {
  return readCapabilities()
}

// ── Secret account names ─────────────────────────────────────────────────────
// Canonical account strings stored in the OS keychain. Must stay in sync with
// the migration logic in seed.mjs.
export const SECRET_ACCOUNTS = Object.freeze({
  discordToken: 'discord.token',
  telegramToken: 'telegram.token',
  webhookAuth:  'webhook.authtoken',
  agentApiKey:  (provider) => `agent.${provider}.apiKey`,
  openaiUsageSessionKey: 'agent.openai.usageSessionKey',
  opencodeGoAuthCookie: 'agent.opencode-go.authCookie',
})

export function isDiscordSnowflake(value) {
  return /^\d{17,20}$/.test(String(value || '').trim())
}

export function diagnoseDiscordTokenValue(value, config = {}) {
  const token = String(value || '').trim()
  if (!token) return null
  const discord = config?.discord && typeof config.discord === 'object' ? config.discord : {}
  const appId = String(discord.applicationId || '').trim()
  if (appId && token === appId) return 'Bot token field contains the Application ID, not the bot token.'
  const channels = config?.channelsConfig && typeof config.channelsConfig === 'object' ? config.channelsConfig : {}
  for (const ch of Object.values(channels)) {
    const channelId = String(ch?.channelId || '').trim()
    if (channelId && token === channelId) return 'Bot token field contains a Channel ID, not the bot token.'
  }
  if (isDiscordSnowflake(token)) return 'Bot token field contains a numeric Discord ID, not the bot token.'
  return null
}

// ── Secret-aware getters ─────────────────────────────────────────────────────
// Read order: ENV MIXDOG_<UPPER_SNAKE> → OS keychain → null.

function _envKey(account) {
  // 'discord.token' → 'MIXDOG_DISCORD_TOKEN'
  return 'MIXDOG_' + account.replace(/[.\s]+/g, '_').toUpperCase()
}

function _readSecret(account) {
  const envVal = process.env[_envKey(account)]
  if (envVal) return envVal
  try { return _getSecret(account) } catch { return null }
}

/**
 * Returns the Discord bot token.
 * Priority: MIXDOG_DISCORD_TOKEN → keychain('discord.token') → null
 */
export function getDiscordToken() {
  return _readSecret(SECRET_ACCOUNTS.discordToken)
}

/**
 * Returns the Telegram bot token.
 * Priority: MIXDOG_TELEGRAM_TOKEN → keychain('telegram.token') → null
 */
export function getTelegramToken() {
  return _readSecret(SECRET_ACCOUNTS.telegramToken)
}

/**
 * Returns the ngrok/webhook authtoken.
 * Priority: MIXDOG_WEBHOOK_AUTHTOKEN → keychain('webhook.authtoken') → null
 */
export function getWebhookAuthtoken() {
  return _readSecret(SECRET_ACCOUNTS.webhookAuth)
}

// Standard provider env names take precedence so existing OPENAI_API_KEY-style
// exports keep working, then MIXDOG_AGENT_<P>_APIKEY, then the OS keychain.
// SSOT for agent API-key providers: setup-server.mjs and config-merge.mjs import
// this so UI key-presence detection uses the exact same predicate the runtime
// loads from. Add a provider here and every path picks it up.
export const AGENT_PROVIDER_ENV = Object.freeze({
  openai: 'OPENAI_API_KEY', anthropic: 'ANTHROPIC_API_KEY', gemini: 'GEMINI_API_KEY',
  deepseek: 'DEEPSEEK_API_KEY', xai: 'XAI_API_KEY', 'opencode-go': 'OPENCODE_API_KEY',
})

// Last-resort env aliases honored AFTER the standard env / MIXDOG_AGENT_* /
// keychain sources. GROK_API_KEY is the established xAI alias elsewhere in the
// repo (search discovery, xai-api/grok-oauth backends), so honoring it here
// keeps provider discovery and dispatch resolving the same credential.
export const AGENT_PROVIDER_ENV_ALIASES = Object.freeze({
  xai: ['GROK_API_KEY'],
})

/**
 * Returns the API key for an agent provider.
 * Priority: <PROVIDER>_API_KEY env -> MIXDOG_AGENT_<PROVIDER>_APIKEY -> keychain('agent.<provider>.apiKey') -> alias env (e.g. GROK_API_KEY for xai) -> null.
 * Never reads mixdog-config.json — provider keys are keychain-only.
 */
export function getAgentApiKey(provider) {
  const std = AGENT_PROVIDER_ENV[provider]
  if (std && process.env[std]) return process.env[std]
  const fromStore = _readSecret(SECRET_ACCOUNTS.agentApiKey(provider))
  if (fromStore) return fromStore
  for (const alias of AGENT_PROVIDER_ENV_ALIASES[provider] || []) {
    if (process.env[alias]) return process.env[alias]
  }
  return null
}

export function getOpenAIUsageSessionKey() {
  return process.env.OPENAI_USAGE_SESSION_KEY
    || process.env.OPENAI_DASHBOARD_SESSION_KEY
    || process.env.OPENAI_SESSION_KEY
    || process.env.MIXDOG_OPENAI_USAGE_SESSION_KEY
    || _readSecret(SECRET_ACCOUNTS.openaiUsageSessionKey)
}

export function getOpenCodeGoAuthCookie() {
  return process.env.OPENCODE_AUTH_COOKIE
    || process.env.OPENCODE_GO_AUTH_COOKIE
    || process.env.MIXDOG_OPENCODE_AUTH_COOKIE
    || _readSecret(SECRET_ACCOUNTS.opencodeGoAuthCookie)
}

/**
 * Persist a secret to the OS keychain. Throws on failure.
 * Never writes to mixdog-config.json.
 */
export function saveSecret(account, value) {
  try {
    _setSecret(account, value)
  } catch (err) {
    // On WSL/headless Linux (and any host missing a usable keychain backend,
    // e.g. keytar/libsecret not installed or no running Secret Service) the OS
    // write throws a cryptic backend error. Surface an actionable message that
    // points at the env-var read path the getters already honor, instead of
    // silently writing the plaintext secret to mixdog-config.json.
    const envKey = _envKey(account)
    const agentMatch = String(account || '').match(/^agent\.([^.]+)\.apiKey$/)
    const stdEnv = agentMatch ? AGENT_PROVIDER_ENV[agentMatch[1]] : null
    const envHint = stdEnv ? `${stdEnv} (or ${envKey})` : envKey
    const e = new Error(
      `[config] could not save secret to the OS keychain: ${err && err.message ? err.message : err}\n` +
      `  No usable keychain backend on this host (common on WSL / headless Linux without libsecret).\n` +
      `  Set the ${envHint} environment variable instead — the runtime reads it directly.`
    )
    e.cause = err
    throw e
  }
}

export function deleteSecret(account) {
  _deleteSecret(account)
}

/**
 * Whether a secret is stored in the OS keychain for `account` (ignores env).
 * Lets the setup UI show "Set" WITHOUT ever sending the secret value to the
 * browser.
 */
export function hasStoredSecret(account) {
  try {
    if (typeof _hasSecret === 'function') return !!_hasSecret(account)
    return !!_getSecret(account)
  } catch { return false }
}

export { CONFIG_PATH }
