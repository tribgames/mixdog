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
 * Resolve the maintenance model ROUTE for a given task from agent-config.
 *
 * Maintenance slots now store a direct `{provider, model, effort?, fast?}`
 * route (parity with `agents.<role>`). This returns that route object. For
 * backward compatibility a slot still holding a legacy preset-NAME string is
 * resolved against config.presets and returned as a route. Falls back to the
 * canonical DEFAULT_MAINTENANCE route. Returns null only when nothing resolves.
 *
 * The returned value is passed straight through as `opts.preset` to
 * makeAgentDispatch, whose resolveMaintenanceRoute()/maintenanceRouteToPreset()
 * accept either a route object or a legacy name string.
 */
export function resolveMaintenancePreset(task, agentConfig) {
  const cfg = agentConfig || loadAgentConfig()
  const maint = cfg?.maintenance || {}
  const presets = cfg?.presets || []
  const slot = maint[task]
  // Preferred: slot already holds a direct route object.
  if (slot && typeof slot === 'object' && !Array.isArray(slot)
      && slot.provider && slot.model) {
    return { ...slot }
  }
  // Legacy: slot holds a preset-NAME string — resolve it to a route.
  const name = String(slot || '').trim()
  if (name) {
    const preset = presets.find(p => p && (p.id === name || p.name === name))
    if (preset && preset.provider && preset.model) {
      const route = { provider: preset.provider, model: preset.model }
      if (preset.effort) route.effort = preset.effort
      if (preset.fast === true) route.fast = true
      return route
    }
  }
  // Canonical default route (DEFAULT_MAINTENANCE is now route-shaped).
  const def = DEFAULT_MAINTENANCE[task]
  if (def && def.provider && def.model) return { ...def }
  return null
}
