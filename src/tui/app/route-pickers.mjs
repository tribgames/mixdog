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
  setPicker,
  setProviderPrompt,
  setChannelPrompt,
  setHookPrompt,
  setSettingsPrompt,
  setContextPanel,
  closeUsagePanel,
  clean,
  copyToClipboard,
  routeLabel,
  agentModelParts,
  agentModelProfile,
  workflowSwitchNotice,
  openModelPicker,
}) {
  const openSearchPicker = (options = {}) => {
    const routeOverride = options.routeOverride || null;
    const returnTo = typeof options.returnTo === 'function' ? options.returnTo : null;
    void openModelPicker({
      title: 'Search Model',
      loadingDescription: 'Loading search-capable models...',
      providerDescription: 'Choose native search provider.',
      modelDescription: 'Select native search model. Adjust Effort with ←/→.',
      emptyNotice: 'no native search models available; connect OpenAI, Grok, Gemini, or Anthropic',
      cacheRef: 'search',
      loadModels: store.listSearchModels,
      currentRoute: routeOverride || store.getSearchRoute?.() || null,
      returnTo,
      returnLabel: options.returnLabel || 'Settings',
      returnOnNestedCancel: options.returnOnNestedCancel === true,
      onImmediateSelect: () => {
        if (returnTo) returnTo();
        else setPicker(null);
      },
      onSelectRoute: async (routeInput) => {
        const result = await store.setSearchRoute?.(routeInput);
        if (!result) {
          store.pushNotice('Search model save is already running.', 'warn');
          return;
        }
        store.pushNotice(`Search model set to ${routeLabel(result)}`, 'info');
        return result;
      },
      onAfterSelect: null,
    });
  };

  const openAgentsPicker = (options = {}) => {
    let agents = [];
    try {
      agents = store.listAgents?.() || [];
    } catch (e) {
      store.pushNotice(`could not list agents: ${e?.message || e}`, 'error');
      return;
    }
    const routeOverrides = options.routeOverrides && typeof options.routeOverrides === 'object' ? options.routeOverrides : {};
    const initialAgentId = clean(options.initialAgentId || '');
    const items = agents.map((agent) => ({
      value: agent.id,
      label: agent.label,
      metaParts: agentModelParts(routeOverrides[agent.id] || agent.route),
      description: agent.description || agent.definition?.description || '',
      _agent: agent,
    }));
    setProviderPrompt(null);
    setChannelPrompt(null);
    setHookPrompt(null);
    setSettingsPrompt(null);
    setContextPanel(null);
    closeUsagePanel();
    setPicker({
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
        void openModelPicker({
          title: `${agent.label} Model`,
          providerDescription: 'Choose a provider for this agent.',
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
      },
      onCancel: () => {
        setPicker(null);
      },
    });
  };

  const openWorkflowPicker = (options = {}) => {
    const returnTo = typeof options.returnTo === 'function' ? options.returnTo : null;
    let workflows = [];
    try {
      workflows = store.listWorkflows?.() || [];
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
    setProviderPrompt(null);
    setChannelPrompt(null);
    setHookPrompt(null);
    setSettingsPrompt(null);
    setContextPanel(null);
    closeUsagePanel();
    setPicker({
      title: 'Workflow',
      description: 'Select active workflow.',
      help: returnTo ? '↑/↓ Select · Enter Choose · Esc Settings' : '↑/↓ Select · Enter Choose · Esc Back',
      labelWidth: 18,
      items,
      onSelect: (_value, item) => {
        const workflow = item?._workflow;
        if (!workflow) return;
        setPicker(null);
        void store.setWorkflow?.(workflow.id)
          .then((result) => {
            if (!result) {
              store.pushNotice('Workflow switch is already running.', 'warn');
              return;
            }
            store.pushNotice(workflowSwitchNotice(result), 'info');
            if (returnTo) returnTo();
          })
          .catch((e) => store.pushNotice(`Couldn’t switch workflow: ${e?.message || e}`, 'error'));
      },
      onCancel: () => {
        setPicker(null);
        if (returnTo) returnTo();
      },
    });
  };

  const openOutputStylePicker = (options = {}) => {
    const returnTo = typeof options.returnTo === 'function' ? options.returnTo : null;
    // Onboarding mode: Enter (row select) and ConfirmBar Next must both persist
    // the chosen style, then advance. `onboarding.onAdvance/onBack` drive the
    // wizard; the confirm bar is built here so both paths share `saveStyle`.
    const onboarding = options.onboarding || null;
    let status = null;
    try {
      status = store.listOutputStyles?.() || null;
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
    setProviderPrompt(null);
    setChannelPrompt(null);
    setHookPrompt(null);
    setSettingsPrompt(null);
    setContextPanel(null);
    closeUsagePanel();
    const saveStyle = (styleId, { advance = false } = {}) => {
      if (!styleId) return;
      // Onboarding advance: keep the current picker visible during the async
      // style switch so the screen never flashes empty between steps; the next
      // step (or finishOnboarding) replaces/clears the picker itself.
      if (!(advance && onboarding)) setPicker(null);
      void store.setOutputStyle?.(styleId)
        .then((result) => {
          if (!result) {
            store.pushNotice('Output style switch is already running.', 'warn');
          } else {
            store.pushNotice(outputStyleNotice(result), 'info');
          }
          if (advance && onboarding) onboarding.onAdvance?.();
          else if (returnTo) returnTo();
        })
        .catch((e) => store.pushNotice(`Couldn’t switch output style: ${e?.message || e}`, 'error'));
    };
    setPicker({
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
            setPicker(null);
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
        setPicker(null);
        if (onboarding) onboarding.onCancel?.();
        else if (returnTo) returnTo();
      },
    });
  };

  const openBridgePicker = () => {
    setProviderPrompt(null);
    setChannelPrompt(null);
    setHookPrompt(null);
    setSettingsPrompt(null);
    setPicker({
      title: 'Agent Tasks',
      description: 'Inspect or clean up background agent tasks.',
      items: [
        {
          value: 'list',
          label: 'List agents/tasks',
          description: 'show active agents and async tasks',
          _action: 'control',
          _args: { type: 'list' },
        },
        {
          value: 'cleanup',
          label: 'Cleanup finished tasks',
          description: 'remove completed agent task records',
          _action: 'control',
          _args: { type: 'cleanup' },
        },
      ],
      onSelect: (_value, item) => {
        setPicker(null);
        if (item._action === 'control') {
          void store.agentControl?.(item._args)
            .catch((e) => store.pushNotice(`agent failed: ${e?.message || e}`, 'error'));
        }
      },
      onCancel: () => {
        setPicker(null);
      },
    });
  };

  const openToolsPicker = (query = '') => {
    let status;
    try {
      status = store.toolsStatus?.(query) || { tools: [] };
    } catch (e) {
      store.pushNotice(`tools status failed: ${e?.message || e}`, 'error');
      return;
    }
    const tools = status.tools || [];
    const items = [
      {
        value: 'summary',
        label: 'Tool surface',
        description: `${status.activeCount || 0}/${status.count || 0} active · mode ${status.mode || state.toolMode}`,
        _action: 'summary',
      },
      ...(tools.length ? tools.map((tool) => ({
        value: tool.name,
        label: tool.name,
        marker: tool.active ? '●' : '○',
        markerColor: tool.active ? theme.success : theme.inactive,
        description: `${tool.kind || 'tool'} · usage ${tool.usage || 0}${tool.description ? ` · ${tool.description}` : ''}`,
        _action: tool.active ? 'tool' : 'enable',
        _tool: tool,
      })) : [{
        value: 'empty',
        label: 'No tools',
        description: query ? `no matches for "${query}"` : 'tool catalog is empty',
        _action: 'noop',
      }]),
    ];
    setProviderPrompt(null);
    setChannelPrompt(null);
    setHookPrompt(null);
    setSettingsPrompt(null);
    setPicker({
      title: query ? `Tools · ${query}` : 'Tools',
      description: 'Browse active and deferred tools.',
      items,
      onSelect: (_value, item) => {
        setPicker(null);
        if (item._action === 'summary') {
          store.pushNotice([
            `mode: ${status.mode || state.toolMode}`,
            `active: ${status.activeCount || 0}/${status.count || 0}`,
            `active tools: ${(status.activeTools || []).join(', ') || '(none)'}`,
          ].join('\n'), 'info');
          return;
        }
        if (item._action === 'enable') {
          store.selectTools?.([item._tool.name]);
          void openToolsPicker(query);
          return;
        }
        if (item._action === 'tool') {
          const tool = item._tool;
          setPicker({
            title: `Tool · ${tool.name}`,
            description: 'Tool details and quick actions.',
            items: [
              {
                value: 'info',
                label: 'Tool info',
                description: `${tool.kind || 'tool'} · ${tool.active ? 'active' : 'deferred'}`,
                _action: 'info',
              },
              {
                value: 'copy-name',
                label: 'Copy name',
                description: tool.name,
                _action: 'copy-name',
              },
            ],
            onSelect: (_detailValue, detail) => {
              setPicker(null);
              if (detail._action === 'info') {
                store.pushNotice([
                  tool.name,
                  `kind: ${tool.kind || 'tool'}`,
                  `state: ${tool.active ? 'active' : 'deferred'}`,
                  `usage: ${tool.usage || 0}`,
                  tool.description || '',
                ].filter(Boolean).join('\n'), 'info');
                return;
              }
              if (detail._action === 'copy-name') {
                void copyToClipboard(tool.name)
                  .then(() => store.pushNotice(`copied tool name: ${tool.name}`, 'plain'))
                  .catch((e) => store.pushNotice(`copy failed: ${e?.message || e}`, 'error'));
              }
            },
            onCancel: () => openToolsPicker(query),
          });
        }
      },
      onCancel: () => {
        setPicker(null);
      },
    });
  };

  return {
    openSearchPicker,
    openAgentsPicker,
    openWorkflowPicker,
    openOutputStylePicker,
    openBridgePicker,
    openToolsPicker,
  };
}
