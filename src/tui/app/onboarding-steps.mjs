/**
 * onboarding-steps.mjs — the first-run onboarding wizard step cluster.
 *
 * Extracted from App.jsx behavior-preservingly as a dependency-injection
 * factory. Every function body is the original App logic verbatim, with closure
 * identifiers threaded through the factory argument. Cross-references between
 * steps stay inside this factory; deps pointing at later-defined App fns
 * (openProviderSetupPicker, openThemePicker, openOutputStylePicker) thread as
 * lazy getter wrappers so they resolve the live opener at call time.
 */
import { theme } from '../theme.mjs';
import { SEARCH_DEFAULT_ROUTE, isSearchDefaultRoute } from './app-format.mjs';
import {
  normalizeModelOptions,
  modelDescription,
  agentModelParts,
  routeFromModel,
} from './model-options.mjs';

export function createOnboardingSteps({
  store,
  setPicker,
  setProviderPrompt,
  setChannelPrompt,
  setHookPrompt,
  setSettingsPrompt,
  setOnboardingActive,
  onboardingRef,
  providerModelsCacheRef,
  onboardingPrefetchSeqRef,
  openProviderSetupPicker,
  openThemePicker,
  openOutputStylePicker,
}) {
  // First-run onboarding is a 4-step wizard. Each step's ROOT screen carries a
  // ConfirmBar (Back/Next, Finish on the last step); the Picker owns the bar
  // focus and only fires onConfirm from the bar. Nested depths (API-key entry,
  // model route picker) render without a ConfirmBar so
  // their own key semantics are untouched and step-switching is disabled there.
  // Esc/cancel during onboarding = confirm skip. Mark onboarding complete
  // (routes/agents/provider untouched) so it does not reopen next launch;
  // `mixdog --onboarding` (forceOnboarding) still reopens regardless.
  const onboardingWarnReopen = () => {
    setOnboardingActive(false);
    try {
      store.skipOnboarding?.();
      store.pushNotice('Setup skipped. Run `mixdog --onboarding` to set up later.', 'info');
    } catch (e) {
      store.pushNotice(`Couldn’t save skip: ${e?.message || e}`, 'error');
    }
  };

  // Warm the Step 2 data (provider models + agent roster) in the background as
  // soon as Step 1 opens, so advancing to Step 2 renders instantly instead of
  // flashing an empty panel while the async load runs.
  const prefetchOnboardingStep2 = () => {
    if (!Array.isArray(onboardingRef.current.providerModels) || onboardingRef.current.providerModels.length === 0) {
      const seq = onboardingPrefetchSeqRef.current;
      void Promise.resolve(store.listProviderModels?.())
        .then((models) => {
          // Drop a stale result: if the provider cache was invalidated (auth
          // change) while this load was in flight, its generation moved on.
          if (seq !== onboardingPrefetchSeqRef.current) return;
          if (Array.isArray(models) && models.length) {
            onboardingRef.current.providerModels = models;
            providerModelsCacheRef.current = { models, at: Date.now() };
          }
        })
        .catch(() => { /* Step 2 falls back to its own load on entry. */ });
    }
    if (!Array.isArray(onboardingRef.current.agents) || onboardingRef.current.agents.length === 0) {
      try {
        const roster = (store.listAgents?.() || []).map((a) => ({ id: a.id, label: a.label || a.id, description: a.description || '' }));
        if (roster.length) onboardingRef.current.agents = roster;
      } catch { /* Step 2 retries on entry. */ }
    }
  };

  const openOnboardingAuthStep = async () => {
    prefetchOnboardingStep2();
    // Load the provider setup BEFORE opening the picker so Step 1 renders the
    // real list in one frame instead of flashing the "Checking Providers"
    // placeholder (that swap is what looked like a jump on entry). On failure,
    // fall back to the picker's own in-panel loading path.
    let preloadedSetup = null;
    try {
      preloadedSetup = await store.getProviderSetup?.();
    } catch { /* openProviderSetupPicker will show its loading frame + error. */ }
    void openProviderSetupPicker({
      title: 'First Run · Step 1/4 · Provider Auth',
      returnTo: () => openOnboardingAuthStep(),
      preloadedSetup,
      confirmBar: {
        buttons: [{ value: 'next', label: 'Next ▶' }],
        // Keep Step 1 visible while Step 2's async model load runs; the next
        // step replaces the picker itself, so no blank frame in between.
        onConfirm: () => { void openOnboardingWorkflowStep(); },
      },
      onCancel: onboardingWarnReopen,
    });
  };

  const openOnboardingThemeStep = () => {
    openThemePicker({
      onboarding: {
        onAdvance: () => openOnboardingOutputStyleStep(),
        onBack: () => void openOnboardingWorkflowStep(),
        onCancel: onboardingWarnReopen,
      },
    });
  };

  const openOnboardingOutputStyleStep = () => {
    openOutputStylePicker({
      onboarding: {
        isLastStep: true,
        onAdvance: () => finishOnboarding(),
        onBack: () => openOnboardingThemeStep(),
        onCancel: onboardingWarnReopen,
      },
    });
  };

  const finishOnboarding = () => {
    const defaultRoute = onboardingRef.current.defaultRoute;
    const searchRoute = onboardingRef.current.searchRoute || null;
    const overrides = onboardingRef.current.agentRoutes || {};
    const hasOverrides = Object.keys(overrides).length > 0;
    setPicker(null);
    setOnboardingActive(false);
    const done = () => store.pushNotice('First-run setup complete.', 'info');
    const failed = (e) => store.pushNotice(`Couldn’t save setup: ${e?.message || e}`, 'error');
    // Branch 1 — Main Model set: full persist. Agents without an explicit
    // override are sent; untouched agents are left out so the backend never
    // overwrites them (they follow the Main Model dynamically at runtime).
    if (defaultRoute) {
      void store.completeOnboarding?.({
        defaultRoute,
        defaultProvider: defaultRoute.provider,
        ...(hasOverrides ? { agentRoutes: { ...overrides } } : {}),
        ...(searchRoute ? { searchRoute } : {}),
      }).then(done).catch(failed);
      return;
    }
    // Branch 2 — Main unset but some Search/agent picks exist: partial persist.
    // Only the explicit overrides are sent (no defaultRoute/defaultProvider); the
    // backend skips agents lacking a route and marks onboarding complete.
    if (hasOverrides || searchRoute) {
      void store.completeOnboarding?.({
        ...(hasOverrides ? { agentRoutes: { ...overrides } } : {}),
        ...(searchRoute ? { searchRoute } : {}),
      }).then(done).catch(failed);
      return;
    }
    // Branch 3 — nothing configured: mark done only, leave config untouched.
    try {
      store.skipOnboarding?.();
    } catch (e) {
      failed(e);
      return;
    }
    done();
  };

  // Onboarding Step 2 per-target model picker. `target` is either the pseudo
  // slot 'lead' (Main Model) or a real agent id from listAgents(). No
  // recommendation logic: the current effective route is pre-highlighted, and
  // the plain model list is shown. Selecting Main Model updates defaultRoute;
  // agents that have no explicit override keep inheriting it.
  const openOnboardingRoleModelPicker = async (target) => {
    const isLead = target === 'lead';
    const isSearch = target === 'search';
    // Search uses the search-capable model list; lead/agent use provider models.
    let models;
    if (isSearch) {
      let searchModels = [];
      try {
        searchModels = await Promise.resolve(store.listSearchModels?.() || []);
      } catch (e) {
        store.pushNotice(`could not list search models: ${e?.message || e}`, 'warn');
      }
      models = normalizeModelOptions(searchModels || []);
      if (models.length === 0) {
        store.pushNotice('no native search models available; connect OpenAI, Grok, Gemini, or Anthropic', 'warn');
        void openOnboardingWorkflowStep();
        return;
      }
    } else {
      models = normalizeModelOptions(onboardingRef.current.providerModels || []);
      if (models.length === 0) {
        store.pushNotice('no provider models available; open /providers to sign in', 'warn');
        openOnboardingAuthStep();
        return;
      }
    }
    const overrides = onboardingRef.current.agentRoutes || {};
    // Current effective route for pre-marking: Main/Search show their own stored
    // route (or none); agents show their explicit override only (unset = none,
    // so we don't falsely mark the Main Model row on an untouched agent).
    const currentRoute = isLead
      ? (onboardingRef.current.defaultRoute || null)
      : isSearch
        ? (onboardingRef.current.searchRoute || null)
        : (overrides[target] || null);
    const routeMatchesModel = (route, m) => route?.provider === m.provider && route?.model === m.id;
    // Non-lead targets get a leading "Default" row that makes the target follow
    // the Main Model at runtime. For agents this clears the override (null);
    // for search this stores the SEARCH_DEFAULT marker route. "Default" is the
    // pre-marked row when the target is unset (agent) or on the marker (search).
    const isDefaultSelected = isSearch
      ? (!currentRoute || isSearchDefaultRoute(currentRoute))
      : !currentRoute;
    const isUnset = isDefaultSelected;
    const modelItems = models.map((m) => ({
      value: `${m.provider}:${m.id}`,
      label: m.display || m.id,
      marker: routeMatchesModel(currentRoute, m) ? '✓' : '',
      markerColor: theme.success,
      description: modelDescription(m),
      _model: m,
    }));
    const items = isLead
      ? modelItems
      : [
          {
            value: '__default__',
            label: 'Default',
            marker: isUnset ? '✓' : '',
            markerColor: theme.success,
            description: 'follows Main Model',
            _default: true,
          },
          ...modelItems,
        ];
    const matchIdx = models.findIndex((m) => routeMatchesModel(currentRoute, m));
    const initialIndex = isLead
      ? Math.max(0, matchIdx)
      : (isUnset || matchIdx < 0 ? 0 : matchIdx + 1);
    const label = isLead
      ? 'Main'
      : isSearch
        ? 'Search'
        : (onboardingRef.current.agents || []).find((a) => a.id === target)?.label || target;
    setPicker({
      title: `First Run · ${label}`,
      description: isLead
        ? 'Pick the main model. Agents inherit this unless individually changed.'
        : isSearch
          ? 'Pick the native web-search model, or Default to follow the Main Model.'
          : `Pick the model for ${label}, or Default to follow the Main Model.`,
      initialIndex,
      items,
      onSelect: (_value, item) => {
        // "Default" → clear the override so this target follows the Main Model.
        if (item?._default) {
          if (isSearch) {
            // Store the SEARCH_DEFAULT marker so finish persists it and the
            // runtime follows the Main Model (not a null that drops the field).
            onboardingRef.current.searchRoute = { ...SEARCH_DEFAULT_ROUTE };
          } else {
            const nextOverrides = { ...(onboardingRef.current.agentRoutes || {}) };
            delete nextOverrides[target];
            onboardingRef.current.agentRoutes = nextOverrides;
          }
          void openOnboardingWorkflowStep();
          return;
        }
        const next = item?._model ? routeFromModel(item._model) : null;
        if (!next) {
          store.pushNotice('select a provider model first', 'warn');
          void openOnboardingWorkflowStep();
          return;
        }
        if (isLead) {
          onboardingRef.current.defaultRoute = next;
        } else if (isSearch) {
          onboardingRef.current.searchRoute = next;
        } else {
          onboardingRef.current.agentRoutes = {
            ...(onboardingRef.current.agentRoutes || {}),
            [target]: next,
          };
        }
        void openOnboardingWorkflowStep();
      },
      onCancel: () => {
        void openOnboardingWorkflowStep();
      },
    });
  };

  const openOnboardingWorkflowStep = async () => {
    if (!Array.isArray(onboardingRef.current.providerModels) || onboardingRef.current.providerModels.length === 0) {
      try {
        onboardingRef.current.providerModels = await store.listProviderModels();
        providerModelsCacheRef.current = { models: onboardingRef.current.providerModels, at: Date.now() };
      } catch (e) {
        onboardingRef.current.providerModels = [];
        store.pushNotice(`could not list models: ${e?.message || e}`, 'warn');
      }
    }
    const models = onboardingRef.current.providerModels || [];
    if (models.length === 0) {
      onboardingRef.current.defaultRoute = null;
      onboardingRef.current.agentRoutes = {};
      store.pushNotice('no provider models available; open /providers to sign in', 'warn');
      openOnboardingAuthStep();
      return;
    }
    // Main Model stays unset until the user picks one; no auto-recommendation.
    // Load the real agent roster once (explore/maintainer/worker/heavy-worker/
    // reviewer/debugger). Each agent defaults to the Main Model unless the user
    // set an explicit override in agentRoutes.
    if (!Array.isArray(onboardingRef.current.agents) || onboardingRef.current.agents.length === 0) {
      try {
        onboardingRef.current.agents = (store.listAgents?.() || []).map((a) => ({ id: a.id, label: a.label || a.id, description: a.description || '' }));
      } catch (e) {
        onboardingRef.current.agents = [];
        store.pushNotice(`could not list agents: ${e?.message || e}`, 'warn');
      }
    }
    const defaultRoute = onboardingRef.current.defaultRoute;
    const searchRoute = onboardingRef.current.searchRoute || null;
    const overrides = onboardingRef.current.agentRoutes || {};
    const agents = onboardingRef.current.agents || [];
    setProviderPrompt(null);
    setChannelPrompt(null);
    setHookPrompt(null);
    setSettingsPrompt(null);
    setPicker({
      title: 'First Run · Step 2/4 · Models',
      description: 'Set the Main Model; each agent inherits it unless changed.',
      indexMode: 'always',
      labelWidth: 18,
      metaWidth: 33,
      items: [
        {
          value: 'main-model',
          label: 'Main',
          metaParts: agentModelParts(defaultRoute),
          description: 'main chat, planning, and agent default',
          _action: 'slot',
          _target: 'lead',
        },
        {
          value: 'search-model',
          label: 'Search',
          // Marker route = follow Main Model → show a hint, not 'default/default'.
          metaParts: isSearchDefaultRoute(searchRoute)
            ? [{ text: '(follows main)', width: 17 }, { text: '', width: 6 }, { text: '', width: 4 }]
            : agentModelParts(searchRoute),
          description: 'native search model',
          _action: 'slot',
          _target: 'search',
        },
        ...agents.map((agent) => ({
          value: `agent:${agent.id}`,
          label: agent.label,
          metaParts: agentModelParts(overrides[agent.id] || null),
          description: agent.description || '',
          _action: 'slot',
          _target: agent.id,
        })),
      ],
      confirmBar: {
        buttons: [
          { value: 'back', label: '◀ Back' },
          { value: 'next', label: 'Next ▶' },
        ],
        onConfirm: (button) => {
          // Both neighbors are async (Step 1 preloads provider setup; theme
          // list is sync but keep symmetric) — leave Step 2 visible until the
          // next picker replaces it to avoid a blank frame.
          if (button.value === 'back') openOnboardingAuthStep();
          else openOnboardingThemeStep();
        },
      },
      onSelect: (_value, item) => {
        if (item._action === 'slot') {
          openOnboardingRoleModelPicker(item._target);
        }
      },
      onCancel: () => {
        setPicker(null);
        onboardingWarnReopen();
      },
    });
  };

  return {
    onboardingWarnReopen,
    prefetchOnboardingStep2,
    openOnboardingAuthStep,
    openOnboardingThemeStep,
    openOnboardingOutputStyleStep,
    finishOnboarding,
    openOnboardingRoleModelPicker,
    openOnboardingWorkflowStep,
  };
}
