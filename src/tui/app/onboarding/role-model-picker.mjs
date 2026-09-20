// onboarding/role-model-picker.mjs
// Step 2's per-target model picker. `target` is the pseudo slot 'lead' (Main
// Model), 'webSearch', or a real agent id from listAgents(). No recommendation
// logic: the current effective route is pre-highlighted and the plain model
// list is shown. Selecting Main Model updates defaultRoute; agents that have
// no explicit override keep inheriting it.
import { theme } from '../../theme.mjs';
import { WEB_SEARCH_DEFAULT_ROUTE, isWebSearchDefaultRoute } from '../app-format.mjs';
import { normalizeModelOptions, modelDescription, routeFromModel } from '../model-options.mjs';

function routeStepDescription(isLead, isWebSearch, label) {
  if (isLead) return 'Pick the main model. Agents inherit this unless individually changed.';
  if (isWebSearch) return 'Pick the native web-search model, or Default to follow the Main Model.';
  return `Pick the model for ${label}, or Default to follow the Main Model.`;
}

const routeMatchesModel = (route, m) => route?.provider === m.provider && route?.model === m.id;

/** Current effective route for pre-marking: Main/Web Search show their own
 *  stored route (or none); agents show their explicit override only (unset =
 *  none, so an untouched agent never falsely marks the Main Model row). */
function currentRouteFor(state, target) {
  if (target === 'lead') return state.defaultRoute || null;
  if (target === 'webSearch') return state.webSearchRoute || null;
  return state.agentRoutes?.[target] || null;
}

function targetLabel(state, target) {
  if (target === 'lead') return 'Main';
  if (target === 'webSearch') return 'Web Search';
  return (state.agents || []).find((a) => a.id === target)?.label || target;
}

/** Picker rows for one target. Non-lead targets get a leading "Default" row
 *  that makes the target follow the Main Model at runtime; it is pre-marked
 *  when the target is unset (agent) or on the web-search marker route. */
export function roleModelItems({ target, models, state }) {
  const isLead = target === 'lead';
  const isWebSearch = target === 'webSearch';
  const currentRoute = currentRouteFor(state, target);
  const isUnset = isWebSearch ? !currentRoute || isWebSearchDefaultRoute(currentRoute) : !currentRoute;
  const modelItems = models.map((m) => ({
    value: `${m.provider}:${m.id}`,
    label: m.display || m.id,
    marker: routeMatchesModel(currentRoute, m) ? '✓' : '',
    markerColor: theme.success,
    description: modelDescription(m),
    _model: m,
  }));
  const defaultItem = {
    value: '__default__',
    label: 'Default',
    marker: isUnset ? '✓' : '',
    markerColor: theme.success,
    description: isWebSearch ? 'follows Main Model' : 'same as Main Model',
    _default: true,
  };
  const matchIdx = models.findIndex((m) => routeMatchesModel(currentRoute, m));
  let initialIndex = isUnset || matchIdx < 0 ? 0 : matchIdx + 1;
  if (isLead) initialIndex = Math.max(0, matchIdx);
  const label = targetLabel(state, target);
  return {
    title: `First Run · ${label}`,
    description: routeStepDescription(isLead, isWebSearch, label),
    initialIndex,
    items: isLead ? modelItems : [defaultItem, ...modelItems],
  };
}

/** Records the pick on the wizard state. "Default" clears an agent override,
 *  or for Web Search stores the WEB_SEARCH_DEFAULT marker so finish persists
 *  it and the runtime follows the Main Model (not a null that drops the
 *  field). Returns false when the row carried no model. */
export function applyRoleSelection(state, target, item) {
  if (item?._default) {
    if (target === 'webSearch') {
      state.webSearchRoute = { ...WEB_SEARCH_DEFAULT_ROUTE };
    } else {
      const nextOverrides = { ...(state.agentRoutes || {}) };
      delete nextOverrides[target];
      state.agentRoutes = nextOverrides;
    }
    return true;
  }
  const next = item?._model ? routeFromModel(item._model) : null;
  if (!next) return false;
  if (target === 'lead') state.defaultRoute = next;
  else if (target === 'webSearch') state.webSearchRoute = next;
  else state.agentRoutes = { ...(state.agentRoutes || {}), [target]: next };
  return true;
}

export function createRoleModelStep({ store, surface, onboardingRef, nav }) {
  /** Web Search uses the web-search-capable model list. An empty list hands
   *  the surface back to Step 2 — a paint by proxy, so ownership is proven
   *  first — and resolves to null. */
  async function loadWebSearchModels(own) {
    let webSearchModels = [];
    try {
      webSearchModels = await Promise.resolve(store.listWebSearchModels?.() || []);
    } catch (e) {
      store.pushNotice(`could not list web-search models: ${e?.message || e}`, 'warn');
    }
    const models = normalizeModelOptions(webSearchModels || []);
    if (models.length === 0) {
      store.pushNotice('no native web-search models available; connect OpenAI, Grok, Gemini, or Anthropic', 'warn');
      if (own.owns()) void nav.openWorkflowStep();
      return null;
    }
    return models;
  }

  /** Lead/agent use the provider models Step 2 loaded; none → back to Step 1. */
  function providerModels(own) {
    const models = normalizeModelOptions(onboardingRef.current.providerModels || []);
    if (models.length === 0) {
      store.pushNotice('no provider models available; open /providers to sign in', 'warn');
      if (own.owns()) nav.openAuthStep();
      return null;
    }
    return models;
  }

  return async function openOnboardingRoleModelPicker(target) {
    const own = surface.claim();
    const models = target === 'webSearch' ? await loadWebSearchModels(own) : providerModels(own);
    if (!models) return;
    const state = onboardingRef.current;
    if (!own.owns()) return;
    own.paint({
      ...roleModelItems({ target, models, state }),
      onSelect: (_value, item) => {
        if (!applyRoleSelection(state, target, item)) store.pushNotice('select a provider model first', 'warn');
        void nav.openWorkflowStep();
      },
      onCancel: () => {
        void nav.openWorkflowStep();
      },
    });
  };
}
