// A route's context-window selection against provider windows: the share and
// window a route names, and what a session is created with for it. Shared by
// every session builder (spawned agents, hidden-role dispatch, the Lead).
import { providerCachedModelMetadataSync } from '../providers/provider-catalog-cache.mjs';
import { contextWindowRange, normalizeContextTokens } from '../../../shared/llm/default-context-window.mjs';
import { clean } from './session-text.mjs';

// The persisted provider model rows are the SAME source the picker sized its
// slider against, so they carry both windows (openai-oauth: 272k default /
// 1M max). Reading them keeps a percentage saved against the picker's scale
// meaningful; anything that only knows a single window would silently rescale
// it (30% of 272k instead of 30% of 1M).
const clampPercent = (percent) => Math.max(10, Math.min(100, percent));

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
  const { defaultWindow, maxWindow } = contextWindowRange({
    provider: clean(targetRoute?.provider),
    contextWindow: windowMeta?.contextWindow,
    maxContextWindow: windowMeta?.maxContextWindow,
  });
  if (!maxWindow) {
    return { contextPercent: undefined, contextDefaultPercent: undefined, selectedContextWindow: undefined };
  }
  const contextDefaultPercent = clampPercent(Math.round((defaultWindow / maxWindow) * 10) * 10);
  // An exact token selection overrides the 10% stops. It is clamped to the
  // selectable range; one that lands on the default window is the default.
  const requestedTokens = normalizeContextTokens(targetRoute?.contextTokens);
  if (requestedTokens) {
    const contextTokens = Math.max(Math.ceil(maxWindow * 0.1), Math.min(maxWindow, requestedTokens));
    if (contextTokens === defaultWindow) {
      return { contextPercent: contextDefaultPercent, contextDefaultPercent, selectedContextWindow: defaultWindow };
    }
    const contextPercent = clampPercent(Math.round((contextTokens / maxWindow) * 10) * 10);
    return { contextPercent, contextDefaultPercent, selectedContextWindow: contextTokens, contextTokens };
  }
  const requested = Number(targetRoute?.contextPercent);
  const contextPercent =
    Number.isFinite(requested) && requested > 0 ? clampPercent(Math.round(requested / 10) * 10) : contextDefaultPercent;
  const selectedContextWindow =
    contextPercent === contextDefaultPercent
      ? defaultWindow
      : Math.max(1, Math.floor((maxWindow * contextPercent) / 100));
  return { contextPercent, contextDefaultPercent, selectedContextWindow };
}

/**
 * The session fields (`contextPercent`, `selectedContextWindow`, `contextTokens`)
 * a route's own context choice creates a session with, from its resolved
 * `state`. A model whose window is not known resolves to nothing: the choice
 * then travels as stored (the session sizes it from the provider's window)
 * instead of being dropped for the model's default. Only set fields are returned.
 */
export function contextSelectionFromState(state, route) {
  const windowKnown = state.contextDefaultPercent !== undefined;
  const chosen = {
    contextPercent: state.contextPercent ?? route.contextPercent,
    selectedContextWindow: state.selectedContextWindow,
    contextTokens: state.contextTokens ?? (windowKnown ? undefined : route.contextTokens),
  };
  return Object.fromEntries(Object.entries(chosen).filter(([, value]) => value));
}
