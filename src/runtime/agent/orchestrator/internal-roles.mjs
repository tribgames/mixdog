/**
 * Internal hidden roles — plugin-managed, user-untouchable.
 *
 * Unlike user-workflow.json roles (which the user defines and edits freely),
 * these roles are NEVER exposed to callers of the `bridge` MCP tool. They are
 * invoked only by internal MCP handlers (explore / recall / search) and carry
 * their own system prompt + tool-set policy.
 *
 * Lookup order (bridge-llm.resolvePresetName):
 *   1. explicit preset arg
 *   2. opts.preset
 *   3. hidden-role registry (defaults/hidden-roles.json) ← plugin-internal
 *   4. user-workflow.json[role]                          ← user-owned
 *
 * Role definitions live in defaults/hidden-roles.json. Editing that file is a
 * plugin-code change; users cannot break the dispatch path by touching their
 * workflow JSON.
 *
 * The preset names refer to entries seeded in mixdog-config.json (agent.presets)
 * via DEFAULT_PRESETS (see config.mjs). If the user deletes the referenced preset
 * from their config the hidden roles degrade gracefully — `resolvePresetName`
 * returns a name, but session creation will fail with a clear "preset not
 * found" error rather than silently mis-dispatching.
 *
 * Kind classification:
 *   - 'retrieval'   : short-lived MCP-invoked hidden retrieval roles (explore).
 *                     BP2 is cache-aligned with public `worker` (collect.mjs).
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
 */

import { fileURLToPath } from 'url'
import { readFileSync } from 'fs'
import { join, dirname } from 'path'

// Load hidden-role definitions from defaults/hidden-roles.json at module
// initialisation. CLAUDE_PLUGIN_ROOT points to the plugin root directory
// (same pattern used by bridge-llm.mjs pluginRoot()). Falls back to a
// path derived from import.meta.url (3 levels up from src/agent/orchestrator/)
// so tests and standalone scripts work without the env var.
function _loadHiddenRoles() {
  const root = process.env.CLAUDE_PLUGIN_ROOT
    || join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
  try {
    const raw = JSON.parse(readFileSync(join(root, 'defaults', 'hidden-roles.json'), 'utf8'))
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

const _HIDDEN_ROLES = _loadHiddenRoles()

/**
 * Return the hidden-role definition, or null if the name is not internal.
 */
export function getHiddenRole(name) {
  if (!name) return null
  return _HIDDEN_ROLES[name] || null
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
  return Object.prototype.hasOwnProperty.call(_HIDDEN_ROLES, name)
}

/**
 * List all hidden role names. Used by diagnostics / setup UI guards to ensure
 * a user-defined role doesn't collide with an internal one.
 */
export function listHiddenRoleNames() {
  return Object.keys(_HIDDEN_ROLES)
}

/**
 * List hidden role names matching a given kind ('retrieval' | 'maintenance').
 * Consumed by collect.mjs to drive BP2 cache shard classification dynamically
 * instead of hard-coding role-name sets.
 */
export function listHiddenRolesByKind(kind) {
  const out = []
  for (const [name, def] of Object.entries(_HIDDEN_ROLES)) {
    if (def.kind === kind) out.push(name)
  }
  return out
}
