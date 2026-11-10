// onboarding/models-step.mjs
// Step 2 of the wizard: one row per routing slot (Main, Web Search, each
// agent) showing its effective route, Enter opening that slot's model picker.
import { isWebSearchDefaultRoute } from '../app-format.mjs';
import { agentModelParts } from '../model-options.mjs';

// Marker route = follow Main Model → show a hint, not 'default/default'.
const followsMainParts = () => [
  { text: '(follows main)', width: 17 },
  { text: '', width: 6 },
  { text: '', width: 4 },
];

function modelsStepItems({ defaultRoute, webSearchRoute, overrides, agents }) {
  return [
    {
      value: 'main-model',
      label: 'Main',
      metaParts: agentModelParts(defaultRoute),
      description: 'main chat, planning, and agent default',
      _action: 'slot',
      _target: 'lead',
    },
    {
      value: 'web-search-model',
      label: 'Web Search',
      metaParts: isWebSearchDefaultRoute(webSearchRoute) ? followsMainParts() : agentModelParts(webSearchRoute),
      description: 'native web-search model',
      _action: 'slot',
      _target: 'webSearch',
    },
    ...agents.map((agent) => ({
      value: `agent:${agent.id}`,
      label: agent.label,
      metaParts: agentModelParts(overrides[agent.id] || null),
      description: agent.description || '',
      _action: 'slot',
      _target: agent.id,
    })),
  ];
}

export function createModelsStep({
  store,
  surface,
  setProviderPrompt,
  setSettingsPrompt,
  onboardingRef,
  stepData,
  nav,
}) {
  return async function openOnboardingWorkflowStep() {
    const own = surface.claim();
    if (!stepData.hasProviderModels()) await stepData.loadProviderModels();
    const models = onboardingRef.current.providerModels || [];
    if (models.length === 0) {
      onboardingRef.current.defaultRoute = null;
      onboardingRef.current.agentRoutes = {};
      store.pushNotice('no provider models available; open /providers to sign in', 'warn');
      // Step 2's empty-model fallback hands the surface to Step 1 after an
      // await: same ownership rule as its own paint below.
      if (own.owns()) nav.openAuthStep();
      return;
    }
    // Main Model stays unset until the user picks one; no auto-recommendation.
    // Load the real agent roster once: fixed Maintainer service plus active
    // starter/custom agents. Each defaults to Main unless overridden.
    if (!stepData.hasAgents()) await stepData.loadAgents();
    const state = onboardingRef.current;
    if (!own.owns()) return;
    setProviderPrompt(null);
    setSettingsPrompt(null);
    own.paint({
      title: 'First Run · Step 2/4 · Models',
      description: 'Set the Main Model; each agent inherits it unless changed.',
      indexMode: 'always',
      labelWidth: 18,
      metaWidth: 33,
      items: modelsStepItems({
        defaultRoute: state.defaultRoute,
        webSearchRoute: state.webSearchRoute || null,
        overrides: state.agentRoutes || {},
        agents: state.agents || [],
      }),
      confirmBar: {
        buttons: [
          { value: 'back', label: '◀ Back' },
          { value: 'next', label: 'Next ▶' },
        ],
        onConfirm: (button) => {
          // Leave Step 2 visible until the next picker replaces it: Step 1
          // preloads provider setup, so clearing now would flash a blank frame.
          if (button.value === 'back') nav.openAuthStep();
          else nav.openThemeStep();
        },
      },
      onSelect: (_value, item) => {
        if (item._action === 'slot') nav.openRoleModelPicker(item._target);
      },
      onCancel: () => {
        own.close();
        nav.warnReopen();
      },
    });
  };
}
