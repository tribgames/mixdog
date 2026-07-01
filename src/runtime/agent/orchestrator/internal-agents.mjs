/**
 * Internal hidden agents — Mixdog-managed, user-untouchable.
 *
 * Unlike public workflow agents, these hidden agents are NEVER exposed to callers of the `agent` tool. They are
 * invoked only by internal handlers (explore / recall / search) and carry
 * their own system prompt + tool-set policy.
 *
 * Lookup order (agent-dispatch.resolvePresetName):
 *   1. explicit preset arg
 *   2. opts.preset
 *   3. hidden-agent registry (defaults/agents.json + systemFile frontmatter)
 *
 * Agent definitions live in defaults/agents.json and the referenced
 * systemFile markdown frontmatter. Editing those files is a Mixdog source change.
 *
 * The preset names refer to entries seeded in mixdog-config.json (agent.presets)
 * via DEFAULT_PRESETS (see config.mjs). If the user deletes the referenced preset
 * from their config the hidden agents degrade gracefully — `resolvePresetName`
 * returns a name, but session creation will fail with a clear "preset not
 * found" error rather than silently mis-dispatching.
 *
 * Kind classification:
 *   - 'retrieval'   : short-lived hidden retrieval agents (explore).
 *   - 'maintenance' : background-trigger hidden agents (memory cycle, scheduler,
 *                     webhook). Receive only their own self section in BP2.
 *
 * Permission classification:
 *   - 'read'       : read-only — apply_patch/shell blocked at loop.mjs runtime
 *                    guard with the same error string public read-only agents see.
 *   - 'read-write' : full tool surface — used by hidden agents that legitimately
 *                    mutate state (scheduler-task launches commands,
 *                    webhook-handler persists payloads). agent-dispatch honors this
 *                    declaratively instead of forcing every hidden agent to 'read'.
 *
 * Tool schema profile:
 *   - 'none' : no tools exposed; pure transform/classifier agents.
 *   - 'read' : read/search/code-navigation tools only.
 *   - 'full' : shared agent tool schema for provider cache reuse.
 *
 * Agent-specific instruction metadata (consumed by rules-builder.cjs
 * buildAgentRoleSpecificContent + collect.mjs):
 *   - inboundEvent   : agent reports results back to Lead and must carry the
 *                      skip-protocol rule (rules/agent/20-skip-protocol.md)
 *                      in its BP2 agent-rule block so no-op outputs opt out of the Lead
 *                      inject.
 *   - instructionDir : DATA_DIR subdir whose *.md tree is folded into the
 *                      agent's BP4-adjacent user/task data (webhook-handler →
 *                      webhooks, scheduler-task → schedules).
 */

import { readFileSync, statSync } from 'fs'
import { join } from 'path'
import { mixdogRoot } from '../../shared/plugin-paths.mjs'
import {
  normalizeAgentPermissionOrNone,
  parseMarkdownFrontmatter,
} from '../../shared/markdown-frontmatter.mjs'

// Resolve the path to defaults/agents.json once.
const _MIXDOG_ROOT = mixdogRoot()
const _AGENTS_PATH = (() => {
  return join(_MIXDOG_ROOT, 'defaults', 'agents.json')
})()

/** @type {{ mtime: number, map: object } | null} */
let _hiddenAgentsCache = null

function _mtimeSafe(file) {
  try { return statSync(file).mtimeMs } catch { return 0 }
}

function _hiddenAgentsDependencyMtime() {
  let mtime = _mtimeSafe(_AGENTS_PATH)
  try {
    const raw = JSON.parse(readFileSync(_AGENTS_PATH, 'utf8'))
    for (const entry of (raw.agents || [])) {
      const systemFile = typeof entry?.systemFile === 'string' ? entry.systemFile.trim() : ''
      if (!systemFile) continue
      mtime = Math.max(mtime, _mtimeSafe(join(_MIXDOG_ROOT, systemFile)))
    }
  } catch {}
  return mtime
}

function _loadHiddenAgentFrontmatter(systemFile) {
  const rel = typeof systemFile === 'string' ? systemFile.trim() : ''
  if (!rel) return {}
  try {
    return parseMarkdownFrontmatter(readFileSync(join(_MIXDOG_ROOT, rel), 'utf8'))
  } catch {
    return {}
  }
}

function _mergeHiddenAgentFrontmatter(entry) {
  const fm = _loadHiddenAgentFrontmatter(entry.systemFile)
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
 * Read and parse defaults/agents.json. Throws on missing/malformed.
 */
function _loadHiddenAgents() {
  try {
    const raw = JSON.parse(readFileSync(_AGENTS_PATH, 'utf8'))
    const map = Object.create(null)
    for (const entry of (raw.agents || [])) {
      if (entry && entry.agent) map[entry.agent] = Object.freeze(_mergeHiddenAgentFrontmatter(entry))
    }
    return Object.freeze(map)
  } catch (err) {
    // Fail loudly — a missing or malformed agents.json breaks dispatch.
    throw new Error(`[internal-agents] failed to load defaults/agents.json: ${err.message}`)
  }
}

/**
 * Return the hidden-agent map, re-reading from disk when the file mtime has
 * changed since the last load. This ensures that BP2 cache rebuilds triggered
 * by an agents.json modification (tracked via maxMtimeRecursive in
 * collect.mjs) consume fresh metadata in the same process.
 */
function _getHiddenAgents() {
  try {
    const mtime = _hiddenAgentsDependencyMtime()
    if (_hiddenAgentsCache && mtime <= _hiddenAgentsCache.mtime) {
      return _hiddenAgentsCache.map
    }
    const map = _loadHiddenAgents()
    _hiddenAgentsCache = { mtime, map }
    return map
  } catch (err) {
    // Fail loudly — re-throw with a clear message. A cache hit is never used
    // when statSync fails because the caller expects current data.
    throw new Error(`[internal-agents] failed to load defaults/agents.json: ${err.message}`)
  }
}

// Eager validate at module init so startup failures are immediate.
_getHiddenAgents()

/**
 * Return the hidden-agent definition, or null if the name is not internal.
 */
export function getHiddenAgent(name) {
  if (!name) return null
  return _getHiddenAgents()[name] || null
}

/**
 * Resolve permission stamped on a agent session. Hidden agents declared
 * `permission: 'read'` are read-locked — caller opts cannot upgrade them.
 * Other built-in permissions include `none`, `read-write`, `mcp`, and `full`.
 */
export function resolveAgentSessionPermission(agent, callerPermission) {
  const hidden = getHiddenAgent(agent)
  if (hidden && hidden.permission === 'read') return 'read'
  if (callerPermission != null && callerPermission !== '') return callerPermission
  if (hidden?.permission) return hidden.permission
  return null
}

/**
 * Boolean check — useful for branching inside agent-dispatch / session-manager.
 */
export function isHiddenAgent(name) {
  if (!name) return false
  return Object.prototype.hasOwnProperty.call(_getHiddenAgents(), name)
}

/**
 * List all hidden agent names. Used by diagnostics / setup UI guards to ensure
 * a user-defined agent doesn't collide with an internal one.
 */
export function listHiddenAgentNames() {
  return Object.keys(_getHiddenAgents())
}

/**
 * List hidden agent names matching a given kind ('retrieval' | 'maintenance').
 * Consumed by collect.mjs to drive BP2 agent-shard classification dynamically
 * instead of hard-coding agent-name sets.
 */
export function listHiddenAgentsByKind(kind) {
  const out = []
  for (const [name, def] of Object.entries(_getHiddenAgents())) {
    if (def.kind === kind) out.push(name)
  }
  return out
}

/**
 * Return the agents/<name>.md sections a hidden agent shares in its BP2 catalog
 * (in addition to its own self section). Drives the explorer→worker cache
 * alignment declaratively instead of a hard-coded agent-name branch in
 * collect.mjs. Returns [] when the agent declares none.
 */
export function getAgentCatalogShareAgents(name) {
  const hidden = getHiddenAgent(name)
  if (!hidden || !Array.isArray(hidden.catalogShareAgents)) return []
  return hidden.catalogShareAgents.map((n) => String(n || '').trim()).filter(Boolean)
}

/**
 * True when a hidden agent reports results back to Lead and must carry the
 * skip-protocol rule in its BP2 agent-rule block. Replaces the hard-coded
 * INBOUND_EVENT_ROLES set in collect.mjs.
 */
export function isInboundEventAgent(name) {
  const hidden = getHiddenAgent(name)
  return !!(hidden && hidden.inboundEvent === true)
}

/**
 * Return the DATA_DIR subdir whose *.md tree rides as BP4-adjacent
 * user/task data, or null when the agent declares none. Replaces the
 * webhook/scheduler ternary in rules-builder.cjs buildAgentRoleSpecificContent.
 */
export function getAgentInstructionDir(name) {
  const hidden = getHiddenAgent(name)
  const dir = hidden && typeof hidden.instructionDir === 'string' ? hidden.instructionDir.trim() : ''
  return dir || null
}
