/**
 * Internal hidden roles — Mixdog-managed, user-untouchable.
 *
 * Unlike public workflow agents, these hidden roles are NEVER exposed to callers of the `agent` tool. They are
 * invoked only by internal handlers (explore / recall / search) and carry
 * their own system prompt + tool-set policy.
 *
 * Lookup order (agent-dispatch.resolvePresetName):
 *   1. explicit preset arg
 *   2. opts.preset
 *   3. hidden-role registry (defaults/hidden-roles.json + systemFile frontmatter)
 *
 * Role definitions live in defaults/hidden-roles.json and the referenced
 * systemFile markdown frontmatter. Editing those files is a Mixdog source change.
 *
 * The preset names refer to entries seeded in mixdog-config.json (agent.presets)
 * via DEFAULT_PRESETS (see config.mjs). If the user deletes the referenced preset
 * from their config the hidden roles degrade gracefully — `resolvePresetName`
 * returns a name, but session creation will fail with a clear "preset not
 * found" error rather than silently mis-dispatching.
 *
 * Kind classification:
 *   - 'retrieval'   : short-lived hidden retrieval roles (explore).
 *   - 'maintenance' : background-trigger hidden roles (memory cycle, scheduler,
 *                     webhook). Receive only their own self section in BP2.
 *
 * Permission classification:
 *   - 'read'       : read-only — apply_patch/shell blocked at loop.mjs runtime
 *                    guard with the same error string public read-only roles see.
 *   - 'read-write' : full tool surface — used by hidden roles that legitimately
 *                    mutate state (scheduler-task launches commands,
 *                    webhook-handler persists payloads). agent-dispatch honors this
 *                    declaratively instead of forcing every hidden role to 'read'.
 *
 * Tool schema profile:
 *   - 'none' : no tools exposed; pure transform/classifier roles.
 *   - 'read' : read/search/code-navigation tools only.
 *   - 'full' : shared agent tool schema for provider cache reuse.
 *
 * Role-specific instruction metadata (consumed by rules-builder.cjs
 * buildAgentRoleSpecificContent + collect.mjs):
 *   - inboundEvent   : role reports results back to Lead and must carry the
 *                      skip-protocol rule (rules/agent/20-skip-protocol.md)
 *                      in its BP2 role-rule block so no-op outputs opt out of the Lead
 *                      inject.
 *   - instructionDir : DATA_DIR subdir whose *.md tree is folded into the
 *                      role's BP4-adjacent user/task data (webhook-handler →
 *                      webhooks, scheduler-task → schedules).
 */

import { readFileSync, statSync } from 'fs'
import { join } from 'path'
import { mixdogRoot } from '../../shared/plugin-paths.mjs'
import {
  normalizeAgentPermissionOrNone,
  parseMarkdownFrontmatter,
} from '../../shared/markdown-frontmatter.mjs'

// Resolve the path to defaults/hidden-roles.json once.
const _MIXDOG_ROOT = mixdogRoot()
const _HIDDEN_ROLES_PATH = (() => {
  return join(_MIXDOG_ROOT, 'defaults', 'hidden-roles.json')
})()

/** @type {{ mtime: number, map: object } | null} */
let _hiddenRolesCache = null

function _mtimeSafe(file) {
  try { return statSync(file).mtimeMs } catch { return 0 }
}

function _hiddenRolesDependencyMtime() {
  let mtime = _mtimeSafe(_HIDDEN_ROLES_PATH)
  try {
    const raw = JSON.parse(readFileSync(_HIDDEN_ROLES_PATH, 'utf8'))
    for (const entry of (raw.roles || [])) {
      const systemFile = typeof entry?.systemFile === 'string' ? entry.systemFile.trim() : ''
      if (!systemFile) continue
      mtime = Math.max(mtime, _mtimeSafe(join(_MIXDOG_ROOT, systemFile)))
    }
  } catch {}
  return mtime
}

function _loadHiddenRoleFrontmatter(systemFile) {
  const rel = typeof systemFile === 'string' ? systemFile.trim() : ''
  if (!rel) return {}
  try {
    return parseMarkdownFrontmatter(readFileSync(join(_MIXDOG_ROOT, rel), 'utf8'))
  } catch {
    return {}
  }
}

function _mergeHiddenRoleFrontmatter(entry) {
  const fm = _loadHiddenRoleFrontmatter(entry.systemFile)
  const merged = { ...entry }
  const permission = normalizeAgentPermissionOrNone(fm.permission)
  if (permission) merged.permission = permission
  for (const key of ['toolSchemaProfile', 'kind', 'slot', 'maintKey', 'instructionDir']) {
    if (typeof fm[key] === 'string' && fm[key].trim()) merged[key] = fm[key].trim()
  }
  for (const key of ['inboundEvent']) {
    if (typeof fm[key] === 'string' && fm[key].trim()) {
      const raw = fm[key].trim().toLowerCase()
      if (raw === 'true') merged[key] = true
      else if (raw === 'false') merged[key] = false
    }
  }
  return merged
}

/**
 * Read and parse defaults/hidden-roles.json. Throws on missing/malformed.
 */
function _loadHiddenRoles() {
  try {
    const raw = JSON.parse(readFileSync(_HIDDEN_ROLES_PATH, 'utf8'))
    const map = Object.create(null)
    for (const entry of (raw.roles || [])) {
      if (entry && entry.name) map[entry.name] = Object.freeze(_mergeHiddenRoleFrontmatter(entry))
    }
    return Object.freeze(map)
  } catch (err) {
    // Fail loudly — a missing or malformed hidden-roles.json breaks dispatch.
    throw new Error(`[internal-roles] failed to load defaults/hidden-roles.json: ${err.message}`)
  }
}

/**
 * Return the hidden-role map, re-reading from disk when the file mtime has
 * changed since the last load. This ensures that BP2 cache rebuilds triggered
 * by a hidden-roles.json modification (tracked via maxMtimeRecursive in
 * collect.mjs) consume fresh metadata in the same process.
 */
function _getHiddenRoles() {
  try {
    const mtime = _hiddenRolesDependencyMtime()
    if (_hiddenRolesCache && mtime <= _hiddenRolesCache.mtime) {
      return _hiddenRolesCache.map
    }
    const map = _loadHiddenRoles()
    _hiddenRolesCache = { mtime, map }
    return map
  } catch (err) {
    // Fail loudly — re-throw with a clear message. A cache hit is never used
    // when statSync fails because the caller expects current data.
    throw new Error(`[internal-roles] failed to load defaults/hidden-roles.json: ${err.message}`)
  }
}

// Eager validate at module init so startup failures are immediate.
_getHiddenRoles()

/**
 * Return the hidden-role definition, or null if the name is not internal.
 */
export function getHiddenRole(name) {
  if (!name) return null
  return _getHiddenRoles()[name] || null
}

/**
 * Resolve permission stamped on a agent session. Hidden roles declared
 * `permission: 'read'` are read-locked — caller opts cannot upgrade them.
 * Other built-in permissions include `none`, `read-write`, `mcp`, and `full`.
 */
export function resolveAgentSessionPermission(role, callerPermission) {
  const hidden = getHiddenRole(role)
  if (hidden && hidden.permission === 'read') return 'read'
  if (callerPermission != null && callerPermission !== '') return callerPermission
  if (hidden?.permission) return hidden.permission
  return null
}

/**
 * Boolean check — useful for branching inside agent-dispatch / session-manager.
 */
export function isHiddenRole(name) {
  if (!name) return false
  return Object.prototype.hasOwnProperty.call(_getHiddenRoles(), name)
}

/**
 * List all hidden role names. Used by diagnostics / setup UI guards to ensure
 * a user-defined role doesn't collide with an internal one.
 */
export function listHiddenRoleNames() {
  return Object.keys(_getHiddenRoles())
}

/**
 * List hidden role names matching a given kind ('retrieval' | 'maintenance').
 * Consumed by collect.mjs to drive BP2 role-shard classification dynamically
 * instead of hard-coding role-name sets.
 */
export function listHiddenRolesByKind(kind) {
  const out = []
  for (const [name, def] of Object.entries(_getHiddenRoles())) {
    if (def.kind === kind) out.push(name)
  }
  return out
}

/**
 * Return the agents/<name>.md sections a hidden role shares in its BP2 catalog
 * (in addition to its own self section). Drives the explorer→worker cache
 * alignment declaratively instead of a hard-coded role-name branch in
 * collect.mjs. Returns [] when the role declares none.
 */
export function getRoleCatalogShareAgents(name) {
  const hidden = getHiddenRole(name)
  if (!hidden || !Array.isArray(hidden.catalogShareAgents)) return []
  return hidden.catalogShareAgents.map((n) => String(n || '').trim()).filter(Boolean)
}

/**
 * True when a hidden role reports results back to Lead and must carry the
 * skip-protocol rule in its BP2 role-rule block. Replaces the hard-coded
 * INBOUND_EVENT_ROLES set in collect.mjs.
 */
export function isInboundEventRole(name) {
  const hidden = getHiddenRole(name)
  return !!(hidden && hidden.inboundEvent === true)
}

/**
 * Return the DATA_DIR subdir whose *.md tree rides as BP4-adjacent
 * user/task data, or null when the role declares none. Replaces the
 * webhook/scheduler ternary in rules-builder.cjs buildAgentRoleSpecificContent.
 */
export function getRoleInstructionDir(name) {
  const hidden = getHiddenRole(name)
  const dir = hidden && typeof hidden.instructionDir === 'string' ? hidden.instructionDir.trim() : ''
  return dir || null
}
