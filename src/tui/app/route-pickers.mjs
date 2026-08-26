/**
 * route-pickers.mjs — standalone route/model-adjacent pickers.
 *
 * Extracted from App.jsx behavior-preservingly as a dependency-injection
 * factory. Every function body is the original App logic verbatim, with closure
 * identifiers threaded through the factory argument. Cross-references between
 * these openers stay inside this factory; later-defined openers (openModelPicker)
 * thread as lazy getter wrappers so they resolve the live binding at call time.
 */
import { theme } from '../theme.mjs';

export const outputStyleNotice = (result) => {
  const label = result?.current?.label || result?.current?.id || result?.configured || 'Default';
  return result?.appliedToCurrentSession === false
    ? `Output style set to ${label}. Use /clear to apply to this chat.`
    : `Output style set to ${label}.`;
};

export function createRoutePickers({
  store,
  state,
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

  const openAgentsPicker = async (options = {}) => {
    const own = surface.claim();
    let agents = [];
    try {
      // Await: on a daemon-backed store this is a remote call, and the old sync
      // read handed back a promise (the picker then showed an empty roster).
      agents = (await store.listAgents?.()) || [];
    } catch (e) {
      store.pushNotice(`could not list agents: ${e?.message || e}`, 'error');
      return;
    }
    // /agents refresh: force the nested model picker to reload the provider
    // catalog on the next agent open (the agents list itself is always fresh).
    const refreshModels = options.refreshModels === true;
    const routeOverrides = options.routeOverrides && typeof options.routeOverrides === 'object' ? options.routeOverrides : {};
    const initialAgentId = clean(options.initialAgentId || '');
    const items = agents.map((agent) => ({
      value: agent.id,
      label: agent.label,
      metaParts: agent.disabled === true && !routeOverrides[agent.id]
        ? [{ text: '(not used)', width: 17 }, { text: '', width: 6 }, { text: '', width: 4 }]
        : agentModelParts(routeOverrides[agent.id] || agent.route || {}),
      description: agent.description || agent.definition?.description || '',
      _agent: agent,
    }));
    if (!own.owns()) return;
    setProviderPrompt(null);
    setSettingsPrompt(null);
    own.context(null);
    closeUsagePanel();
    own.paint({
      title: 'Agents',
      description: 'Workflow agents available for agent tasks.',
      help: '↑/↓ Select · Enter Set Model · Esc Back',
      indexMode: 'always',
      labelWidth: 18,
      metaWidth: 33,
      initialIndex: Math.max(0, items.findIndex((item) => item.value === initialAgentId)),
      items,
      onSelect: (_value, item) => {
        const agent = item?._agent;
        if (!agent) return;
        // Agents are either pinned to a model or switched off — the same two
        // states the desktop panel offers. "Follows Main" is web-search only.
        const openAgentModelPicker = () => void openModelPicker({
          title: `${agent.label} Model`,
          providerDescription: 'Choose a provider for this agent.',
          refreshModels,
          currentRoute: agent.route || null,
          returnTo: () => openAgentsPicker(),
          onImmediateSelect: (routeInput) => {
            openAgentsPicker({ routeOverrides: { [agent.id]: routeInput }, initialAgentId: agent.id });
          },
          onSelectRoute: async (routeInput) => {
            const result = await store.setAgentRoute?.(agent.id, routeInput);
            if (!result) {
              store.pushNotice('Agent model save is already running.', 'warn');
              return;
            }
            store.pushNotice(`${agent.label} model set to ${agentModelProfile(result)}`, 'info');
          },
        });
        // Nested panel for an Enter on an agent row: the same claim that
        // painted the Agents list, re-armed by that paint.
        own.paint({
          title: agent.label,
          description: 'Pick a model for this agent, or turn it off.',
          help: '↑/↓ Select · Enter Choose · Esc Back',
          items: [
            {
              value: 'model',
              label: 'Set model…',
              marker: agent.disabled === true ? '' : '✓',
              markerColor: theme.success,
              description: 'Run this agent on a pinned model.',
            },
            {
              value: 'off',
              label: 'Not used',
              marker: agent.disabled === true ? '✓' : '',
              markerColor: theme.success,
              description: 'Hide this agent from the Lead entirely.',
            },
          ],
          initialIndex: agent.disabled === true ? 1 : 0,
          onSelect: async (value) => {
            if (value !== 'off') {
              openAgentModelPicker();
              return;
            }
            // Post-ack handover back to Agents, bound to THIS keypress: a late
            // ack must not overwrite whatever replaced this panel meanwhile.
            const reopenAgents = own.defer(() => { void openAgentsPicker(); });
            try {
              const result = await store.setAgentRoute?.(agent.id, { disabled: true });
              if (!result) {
                store.pushNotice('Agent save is already running.', 'warn');
                return;
              }
              store.pushNotice(`${agent.label} is no longer used.`, 'info');
            } catch (e) {
              store.pushNotice(`could not turn off ${agent.label}: ${e?.message || e}`, 'error');
            }
            reopenAgents();
          },
          onCancel: () => {
            void openAgentsPicker();
          },
        });
      },
      onCancel: () => {
        own.close();
      },
    });
  };

  const openWorkflowPicker = async (options = {}) => {
    const returnTo = typeof options.returnTo === 'function' ? options.returnTo : null;
    const handoffPanel = options.handoffPanel && typeof options.handoffPanel === 'object'
      ? options.handoffPanel
      : null;
    const own = surface.claim();
    let workflows = [];
    try {
      workflows = (await store.listWorkflows?.()) || [];
    } catch (e) {
      store.pushNotice(`could not list workflows: ${e?.message || e}`, 'error');
      return;
    }
    if (!workflows.length) {
      store.pushNotice('no workflows available', 'warn');
      return;
    }
    const items = workflows.map((workflow) => ({
      value: workflow.id,
      label: workflow.name,
      marker: workflow.active ? '✓' : '',
      markerColor: theme.success,
      description: workflow.description || `${workflow.source || 'workflow'} workflow`,
      _workflow: workflow,
    }));
    if (!own.owns()) return;
    setProviderPrompt(null);
    setSettingsPrompt(null);
    own.context(null);
    closeUsagePanel();
    own.paint({
      title: 'Workflow',
      description: 'Select active workflow.',
      help: returnTo ? '↑/↓ Select · Enter Choose · Esc Settings' : '↑/↓ Select · Enter Choose · Esc Back',
      labelWidth: 18,
      items,
      onSelect: (_value, item) => {
        const workflow = item?._workflow;
        if (!workflow) return;
        // Clear-and-continue: the flow keeps the surface it just emptied, so
        // the post-ack hop below is bound to THIS keypress. An Esc before the
        // switch acks cancels the hop instead of re-opening Settings.
        own.paint(handoffPanel);
        const returnAfterSwitch = own.defer(() => { if (returnTo) returnTo(); });
        void store.setWorkflow?.(workflow.id)
          .then((result) => {
            if (!result) {
              store.pushNotice('Workflow switch is already running.', 'warn');
              if (handoffPanel) returnAfterSwitch();
              return;
            }
            store.pushNotice(workflowSwitchNotice(result), 'info');
            returnAfterSwitch();
          })
          .catch((e) => {
            store.pushNotice(`Couldn’t switch workflow: ${e?.message || e}`, 'error');
            if (handoffPanel) returnAfterSwitch();
          });
      },
      onCancel: () => {
        if (handoffPanel) own.paint(handoffPanel);
        else own.close();
        if (returnTo) returnTo();
      },
    });
  };

  const openOutputStylePicker = async (options = {}) => {
    const returnTo = typeof options.returnTo === 'function' ? options.returnTo : null;
    const handoffPanel = options.handoffPanel && typeof options.handoffPanel === 'object'
      ? options.handoffPanel
      : null;
    // Onboarding mode: Enter (row select) and ConfirmBar Next must both persist
    // the chosen style, then advance. `onboarding.onAdvance/onBack` drive the
    // wizard; the confirm bar is built here so both paths share `saveStyle`.
    const onboarding = options.onboarding || null;
    const own = surface.claim();
    let status = null;
    try {
      status = (await store.listOutputStyles?.()) || null;
    } catch (e) {
      store.pushNotice(`could not list output styles: ${e?.message || e}`, 'error');
      return;
    }
    const styles = Array.isArray(status?.styles) ? status.styles : [];
    if (!styles.length) {
      store.pushNotice('no output styles available', 'warn');
      return;
    }
    const currentId = status?.current?.id || 'default';
    let highlightedStyleId = currentId;
    const items = styles.map((style) => ({
      value: style.id,
      label: style.label || style.id,
      marker: style.id === currentId ? '✓' : '',
      markerColor: theme.success,
      description: style.description || style.source || 'output style',
      _style: style,
    }));
    if (!own.owns()) return;
    setProviderPrompt(null);
    setSettingsPrompt(null);
    own.context(null);
    closeUsagePanel();
    const saveStyle = (styleId, { advance = false } = {}) => {
      if (!styleId) return;
      // Onboarding advance: keep the current picker visible during the async
      // style switch so the screen never flashes empty between steps; the next
      // step (or finishOnboarding) replaces/clears the picker itself.
      if (!(advance && onboarding)) own.paint(handoffPanel);
      // Post-ack delegation (next onboarding step, or back to the caller):
      // bound after this keypress's own navigation so an Esc while the switch
      // is in flight cannot paint a panel over the new surface.
      const advanceAfterSave = own.defer(() => {
        if (advance && onboarding) onboarding.onAdvance?.();
        else if (returnTo) returnTo();
      });
      void store.setOutputStyle?.(styleId)
        .then((result) => {
          if (!result) {
            store.pushNotice('Output style switch is already running.', 'warn');
          } else {
            store.pushNotice(outputStyleNotice(result), 'info');
          }
          advanceAfterSave();
        })
        .catch((e) => {
          store.pushNotice(`Couldn’t switch output style: ${e?.message || e}`, 'error');
          if (handoffPanel) advanceAfterSave();
        });
    };
    own.paint({
      title: 'Output Style',
      description: 'Select response style.',
      // Onboarding uses a ConfirmBar (←/→ = Back/Next); let the Picker supply
      // its ConfirmBar help instead of a stale ←/→ hint.
      help: onboarding ? undefined : (returnTo ? '↑/↓ Select · Enter Choose · Esc Settings' : '↑/↓ Select · Enter Choose · Esc Back'),
      labelWidth: 18,
      items,
      confirmBar: onboarding ? {
        buttons: [
          { value: 'back', label: '◀ Back' },
          { value: 'next', label: 'Next ▶' },
        ],
        onConfirm: (button) => {
          if (button.value === 'back') {
            own.close();
            onboarding.onBack?.();
            return;
          }
          saveStyle(highlightedStyleId, { advance: true });
        },
      } : (options.confirmBar || null),
      onHighlight: onboarding ? (_value, item) => {
        if (item?._style?.id) highlightedStyleId = item._style.id;
      } : undefined,
      onSelect: (_value, item) => {
        const style = item?._style;
        if (!style) return;
        saveStyle(style.id, { advance: Boolean(onboarding) });
      },
      onCancel: () => {
        if (handoffPanel) own.paint(handoffPanel);
        else own.close();
        if (onboarding) onboarding.onCancel?.();
        else if (returnTo) returnTo();
      },
    });
  };

  return {
    openWebSearchPicker,
    openAgentsPicker,
    openWorkflowPicker,
    openOutputStylePicker,
  };
}
