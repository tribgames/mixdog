// Pure route derivations: the effective effort / Fast capability of a route
// against provider model metadata, and its context-window percentage.
import {
  modelMetaLooksResolved,
  modelSettingsFor,
} from '../runtime/agent/orchestrator/runtime-core/config-helpers.mjs';
import { clean, hasOwn } from '../runtime/agent/orchestrator/runtime-core/session-text.mjs';
import { coerceEffortFor } from '../runtime/agent/orchestrator/runtime-core/effort.mjs';
import { fastCapableFor } from '../runtime/agent/orchestrator/runtime-core/model-capabilities.mjs';

export function resolveRouteEffortState(targetRoute = {}, modelMeta = null) {
  const requested = hasOwn(targetRoute, 'effort') ? targetRoute.effort : targetRoute.preset?.effort || null;
  const metadataResolved = modelMetaLooksResolved(modelMeta);
  // A cold runtime initially has only `{ id, provider }`. Treating that
  // placeholder as authoritative erased a persisted effort and disabled a
  // persisted Fast route before the provider catalog finished warming.
  // Preserve the already-validated route until real capability metadata is
  // available; the provider still validates the exact variant before send.
  const effectiveEffort = metadataResolved
    ? coerceEffortFor(targetRoute.provider, modelMeta, requested)
    : requested || null;
  const fastCapable = metadataResolved
    ? fastCapableFor(targetRoute.provider, modelMeta, effectiveEffort, targetRoute.modelParameters)
    : targetRoute.fast === true;
  return { effectiveEffort, fastCapable, metadataResolved };
}

// Fast capability for a route selection or tuning write. Placeholder metadata
// (`{ id, provider }`, a catalog that is not loaded yet) is unknown, not "no
// Fast": clamping on it turned the selected route AND the saved model setting
// to fast:false. Unknown keeps the requested value; the provider still checks
// the exact tier before send.
export function selectionFastCapable(provider, modelMeta, effort, modelParameters) {
  return !modelMetaLooksResolved(modelMeta) || fastCapableFor(provider, modelMeta, effort, modelParameters);
}

export { resolveRouteContextState } from '../runtime/agent/orchestrator/runtime-core/route-context-state.mjs';

/**
 * Human label for the statusline. A display-only user alias
 * (modelSettings[provider/model].alias) wins over every catalog label so the
 * statusline matches the picker; the catalog `name` is only trusted when it
 * differs from the raw model id (some providers echo the id as `name`).
 * Falls back to the route's existing modelDisplay, then ''.
 */
export function routeModelDisplay(config, targetRoute, modelMeta) {
  const metaName = clean(modelMeta?.name);
  return (
    clean(modelSettingsFor(config, targetRoute.provider, targetRoute.model)?.alias) ||
    clean(modelMeta?.display) ||
    clean(modelMeta?.displayName) ||
    (metaName && metaName !== clean(targetRoute.model) ? metaName : '') ||
    clean(targetRoute.modelDisplay)
  );
}
