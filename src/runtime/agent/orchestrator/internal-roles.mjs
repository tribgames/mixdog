/**
 * Internal hidden roles — Mixdog-managed, user-untouchable.
 *
 * Unlike user-workflow.json roles (which the user defines and edits freely),
 * these roles are NEVER exposed to callers of the `bridge` MCP tool. They are
 * invoked only by internal handlers (explore / recall / search) and carry
 * their own system prompt + tool-set policy.
 *
 * Lookup order (bridge-llm.resolvePresetName):
 *   1. explicit preset arg
 *   2. opts.preset
 *   3. hidden-role registry (defaults/hidden-roles.json) <- Mixdog-internal
 *   4. user-workflow.json[role]                          ← user-owned
 *
 * Role definitions live in defaults/hidden-roles.json. Editing that file is a
 * Mixdog source change; users cannot break the dispatch path by touching their
 * workflow JSON.
 *
 * The preset names refer to entries seeded in mixdog-config.json (agent.presets)
 * via DEFAULT_PRESETS (see config.mjs). If the user deletes the referenced preset
 * from their config the hidden roles degrade gracefully — `resolvePresetName`
 * returns a name, but session creation will fail with a clear "preset not
 * found" error rather than silently mis-dispatching.
 *
 * Kind classification:
 *   - 'retrieval'   : short-lived hidden retrieval roles (explore).
 *   - 'maintenance' : background-trigger hidden roles (memory cycle, recap, scheduler,
 *                     webhook). Receive only their own self section in BP2.
 *
 * Permission classification:
 *   - 'read'       : read-only — write/edit/bash blocked at loop.mjs runtime
 *                    guard with the same error string public read-only roles see.
 *   - 'read-write' : full tool surface — used by hidden roles that legitimately
 *                    mutate state (scheduler-task launches commands,
 *                    webhook-handler persists payloads). bridge-llm honors this
 *                    declaratively instead of forcing every hidden role to 'read'.
 *
 * Tool schema profile:
 *   - 'unified'         : shared bridge tool schema for provider cache reuse.
 *   - 'llm-only'        : no tools exposed; pure transform/classifier roles.
 *
 * BP3 role-specific instruction metadata (consumed by rules-builder.cjs
 * buildBridgeRoleSpecificContent + collect.mjs):
 *   - inboundEvent   : role reports results back to Lead and must carry the
 *                      skip-protocol rule (rules/bridge/20-skip-protocol.md)
 *                      in its BP2 catalog so no-op outputs opt out of the Lead
 *                      inject.
 *   - instructionDir : DATA_DIR subdir whose *.md tree is folded into the
 *                      role's BP3 role-specific block (webhook-handler →
 *                      webhooks, scheduler-task → schedules).
 */

import { readFileSync, statSync } from 'fs'
import { join } from 'path'
import { mixdogRoot } from '../../shared/plugin-paths.mjs'

// Resolve the path to defaults/hidden-roles.json once.
const _HIDDEN_ROLES_PATH = (() => {
  const root = mixdogRoot()
  return join(root, 'defaults', 'hidden-roles.json')
})()

/** @type {{ mtime: number, map: object } | null} */
let _hiddenRolesCache = null

/**
 * Read and parse defaults/hidden-roles.json. Throws on missing/malformed.
 */
function _loadHiddenRoles() {
  try {
    const raw = JSON.parse(readFileSync(_HIDDEN_ROLES_PATH, 'utf8'))
    const map = Object.create(null)
    for (const entry of (raw.roles || [])) {
      if (entry && entry.name) map[entry.name] = Object.freeze({ ...entry })
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
    const mtime = statSync(_HIDDEN_ROLES_PATH).mtimeMs
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
 * Resolve permission stamped on a bridge session. Hidden roles declared
 * `permission: 'read'` are read-locked — caller opts cannot upgrade them.
 */
export function resolveBridgeSessionPermission(role, callerPermission) {
  const hidden = getHiddenRole(role)
  if (hidden && hidden.permission === 'read') return 'read'
  if (callerPermission != null && callerPermission !== '') return callerPermission
  if (hidden?.permission) return hidden.permission
  return null
}

/**
 * Boolean check — useful for branching inside bridge-llm / session-manager.
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
 * Consumed by collect.mjs to drive BP2 cache shard classification dynamically
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
 * skip-protocol rule in its BP2 catalog. Replaces the hard-coded
 * INBOUND_EVENT_ROLES set in collect.mjs.
 */
export function isInboundEventRole(name) {
  const hidden = getHiddenRole(name)
  return !!(hidden && hidden.inboundEvent === true)
}

/**
 * Return the DATA_DIR subdir whose *.md tree folds into a role's BP3
 * role-specific block, or null when the role declares none. Replaces the
 * webhook/scheduler ternary in rules-builder.cjs buildBridgeRoleSpecificContent.
 */
export function getRoleInstructionDir(name) {
  const hidden = getHiddenRole(name)
  const dir = hidden && typeof hidden.instructionDir === 'string' ? hidden.instructionDir.trim() : ''
  return dir || null
}
