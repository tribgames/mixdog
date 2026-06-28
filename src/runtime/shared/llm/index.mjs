/**
 * Shared LLM helpers (post v0.6.46).
 *
 * The legacy `callLLM` dispatcher and direct CLI/HTTP runners have been
 * removed — every LLM call now flows through `agent-dispatch.mjs`
 * (`makeAgentDispatch({ taskType })`) and, for memory maintenance specifically,
 * through `maintenance-llm.mjs`'s thin wrapper.
 *
 * Only preset resolution remains here: memory-cycle and future backend
 * callers still need a consistent way to map `(task, agent-config)` to a
 * preset id.
 */

import { DEFAULT_MAINTENANCE } from '../../agent/orchestrator/config.mjs'
import { readSection } from '../config.mjs'

function loadAgentConfig() {
  try {
    return readSection('agent')
  } catch (e) {
    console.error(`[llm] agent-config load error: ${e.message}`)
    return {}
  }
}

/**
 * Resolve maintenance preset ID for a given task from agent-config.
 * Falls back to canonical defaults (DEFAULT_MAINTENANCE from config.mjs).
 * Returns null if no matching preset is registered (lets callers skip the call).
 */
export function resolveMaintenancePreset(task, agentConfig) {
  const cfg = agentConfig || loadAgentConfig()
  const maint = cfg?.maintenance || {}
  const presetId = maint[task] || DEFAULT_MAINTENANCE[task]
  const presets = cfg?.presets || []
  if (presets.some(p => p.id === presetId || p.name === presetId)) return presetId
  // No registered preset found — return the first available preset id so callers
  // always receive a real id, or null if the presets list is empty.
  const first = presets.find(p => p?.id || p?.name)
  return first ? (first.id || first.name) : null
}
