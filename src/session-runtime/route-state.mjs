// Pure route derivations: the effective effort / Fast capability of a route
// against provider model metadata, and its context-window percentage.
import { modelMetaLooksResolved, modelSettingsFor } from './config-helpers.mjs';
import { clean, hasOwn } from './session-text.mjs';
import { coerceEffortFor } from './effort.mjs';
import { fastCapableFor } from './model-capabilities.mjs';
import { providerCachedModelMetadataSync } from '../runtime/agent/orchestrator/providers/provider-catalog-cache.mjs';

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

// The persisted provider model rows are the SAME source the picker sized its
// slider against, so they carry both windows (openai-oauth: 272k default /
// 1M max). Reading them keeps a percentage saved against the picker's scale
// meaningful; anything that only knows a single window would silently rescale
// it (30% of 272k instead of 30% of 1M).
function cachedRouteWindows(provider, model) {
  const row = providerCachedModelMetadataSync(provider, model)?.rawProviderModel || null;
  if (!row) return null;
  const contextWindow = Number(row.contextWindow ?? row.context_window ?? row.max_input_tokens) || 0;
  const maxContextWindow = Number(row.maxContextWindow ?? row.max_context_window) || 0;
  return contextWindow > 0 || maxContextWindow > 0 ? { contextWindow, maxContextWindow } : null;
}

export function resolveRouteContextState(targetRoute = {}, modelMeta = null, windowLookup = cachedRouteWindows) {
  // Only providers that implement getCachedModelInfo (openai-oauth, cursor,
  // openai-compat, opencode-go) hand lookupModelMeta a window; every other one
  // (anthropic-oauth, grok-oauth, gemini, …) gets the bare `{ id, provider }`
  // placeholder. Reading the window from that alone yields 0, which dropped the
  // saved context percentage for the entire session — while resolveSessionContextMeta
  // went on to size that session from the provider/catalog window (Claude Opus 5:
  // a full 1M rather than the selected 500k). Read the cached provider row here so
  // the percentage and the session boundary cannot disagree.
  const windowMeta =
    Number(modelMeta?.contextWindow) > 0 || Number(modelMeta?.maxContextWindow) > 0
      ? modelMeta
      : windowLookup?.(clean(targetRoute?.provider), clean(targetRoute?.model)) || modelMeta;
  const defaultWindow = Math.max(0, Number(windowMeta?.contextWindow) || 0);
  const maxWindow = Math.max(defaultWindow, Number(windowMeta?.maxContextWindow) || 0);
  if (!maxWindow) {
    return { contextPercent: undefined, contextDefaultPercent: undefined, selectedContextWindow: undefined };
  }
  const contextDefaultPercent = Math.max(10, Math.min(100, Math.round((defaultWindow / maxWindow) * 10) * 10));
  const requested = Number(targetRoute?.contextPercent);
  const contextPercent =
    Number.isFinite(requested) && requested > 0
      ? Math.max(10, Math.min(100, Math.round(requested / 10) * 10))
      : contextDefaultPercent;
  const selectedContextWindow =
    contextPercent === contextDefaultPercent
      ? defaultWindow
      : Math.max(1, Math.floor((maxWindow * contextPercent) / 100));
  return { contextPercent, contextDefaultPercent, selectedContextWindow };
}

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
