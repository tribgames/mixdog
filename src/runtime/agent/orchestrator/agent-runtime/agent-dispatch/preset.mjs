// Preset resolution for a dispatch: the maintenance route (or preset name)
// becomes the preset object and runtime spec the session is built from.
import { resolveRuntimeSpec } from '../../config.mjs';
import { resolveMaintenanceRoute } from '../maintenance-route.mjs';

/**
 * resolveMaintenanceRoute returns one of:
 *   - a route object `{ provider, model, effort?, fast? }` — the preferred
 *     shape: a maintenance slot now stores its model directly (parity with
 *     `agents.<role>`), so no preset-array name lookup is needed.
 *   - a string — a preset NAME (Main inheritance via config.default, or an
 *     explicit `preset`/`opts.preset` override), resolved here against
 *     config.presets.
 *   - null — unresolved.
 *
 * Hidden maintenance roles mirror public spawning precedence:
 * `agents.<role>` (including the `agents.maintenance` alias) → workflow route →
 * maintenance route → Main. The cycle1/2/3 agents share the memory knob via
 * their `maintKey: 'memory'` override. Scheduler and webhook are unchanged.
 */
// A maintenance slot value is a direct route when it carries provider+model.
function maintenanceRouteToPreset(routeOrName, agent) {
  if (!routeOrName || typeof routeOrName !== 'object') return null;
  const provider = String(routeOrName.provider || '').trim();
  const model = String(routeOrName.model || '').trim();
  if (!provider || !model) return null;
  const out = {
    id: `maint-${agent}`,
    name: `MAINT ${String(agent || '').toUpperCase()}`,
    type: 'agent',
    provider,
    model,
    tools: 'full',
  };
  const effort = String(routeOrName.effort || '').trim();
  if (effort) out.effort = effort;
  if (routeOrName.fast === true) out.fast = true;
  if (routeOrName.modelParameters && typeof routeOrName.modelParameters === 'object') {
    out.modelParameters = { ...routeOrName.modelParameters };
  }
  return out;
}

export function resolveDispatchPreset({ presetArg, optsPreset, agent, config }) {
  const routeOrName = resolveMaintenanceRoute({ preset: presetArg, optsPreset, agent, config });
  if (!routeOrName) {
    throw new Error(
      `[agent-dispatch] maintenance route unresolved for agent "${agent}" ` +
        `(preset="${presetArg || optsPreset || ''}")`
    );
  }
  // Preferred path: a maintenance slot that stores its model directly
  // (route object). Name path: Main inheritance (config.default) or an
  // explicit preset override still identify a preset by NAME.
  let preset = maintenanceRouteToPreset(routeOrName, agent);
  if (!preset) {
    const routeName = String(routeOrName || '').trim();
    preset = config.presets?.find((p) => p.id === routeName || p.name === routeName) || null;
    if (!preset) {
      throw new Error(
        `[agent-dispatch] maintenance route for agent "${agent}" is neither a ` +
          `{provider,model} route nor a known preset name ("${routeName}")`
      );
    }
  }
  // Stable label for traces / session metadata, derived from the resolved
  // preset object regardless of whether it came from a direct route or a
  // preset name.
  const presetName = preset.id || preset.name || `maint-${agent}`;
  const runtimeSpec = resolveRuntimeSpec(preset, { lane: 'agent', agentId: agent });
  return { preset, presetName, runtimeSpec };
}
