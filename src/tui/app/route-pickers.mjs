/**
 * route-pickers.mjs — standalone route/model-adjacent pickers.
 *
 * A dependency-injection factory composing the panels in route-pickers/
 * (agents, workflow, output style) plus the web-search model picker, which
 * is the nested model picker with a web-search catalog and route. Later-defined
 * openers (openModelPicker) thread as lazy getter wrappers so they resolve the
 * live binding at call time.
 */
import { createAgentsPicker } from './route-pickers/agents-picker.mjs';
import { createOutputStylePicker } from './route-pickers/output-style-picker.mjs';
import { createWorkflowPicker } from './route-pickers/workflow-picker.mjs';

export { outputStyleNotice } from './route-pickers/output-style-picker.mjs';

export function createRoutePickers({
  store,
  surface,
  setProviderPrompt,
  setSettingsPrompt,
  closeUsagePanel,
  clean,
  routeLabel,
  agentModelParts,
  agentModelProfile,
  workflowSwitchNotice,
  openModelPicker,
}) {
  // Every opener below is async: on a daemon-backed store the list/get calls
  // are remote, and reading them synchronously yielded promises (empty pickers).
  const openWebSearchPicker = async (options = {}) => {
    const routeOverride = options.routeOverride || null;
    const returnTo = typeof options.returnTo === 'function' ? options.returnTo : null;
    // Surface claim (panel-surface.mjs) taken on this keypress: the route read
    // below is a daemon round-trip, so Esc can land before anything paints.
    const own = surface.claim();
    const currentWebSearchRoute = routeOverride || (await store.getWebSearchRoute?.()) || null;
    if (!own.owns()) return;
    void openModelPicker({
      title: 'Web Search Model',
      loadingDescription: 'Loading web-search-capable models...',
      providerDescription: 'Choose native web-search provider.',
      modelDescription: 'Select native web-search model. Adjust Effort with ←/→.',
      emptyNotice: 'no native web-search models available; connect OpenAI, Grok, Gemini, or Anthropic',
      cacheRef: 'webSearch',
      loadModels: store.listWebSearchModels,
      currentRoute: currentWebSearchRoute,
      returnTo,
      returnLabel: options.returnLabel || 'Settings',
      returnOnNestedCancel: options.returnOnNestedCancel === true,
      onImmediateSelect: () => {
        if (returnTo) returnTo();
        // Enter inside the nested picker: that keypress owns what it clears.
        else surface.claim().close();
      },
      onSelectRoute: async (routeInput) => {
        const result = await store.setWebSearchRoute?.(routeInput);
        if (!result) {
          store.pushNotice('Web-search model save is already running.', 'warn');
          return;
        }
        store.pushNotice(`Web-search model set to ${routeLabel(result)}`, 'info');
        return result;
      },
      onAfterSelect: null,
    });
  };

  const panelDeps = { store, surface, setProviderPrompt, setSettingsPrompt, closeUsagePanel };
  return {
    openWebSearchPicker,
    ...createAgentsPicker({ ...panelDeps, clean, agentModelParts, agentModelProfile, openModelPicker }),
    ...createWorkflowPicker({ ...panelDeps, workflowSwitchNotice }),
    ...createOutputStylePicker(panelDeps),
  };
}
