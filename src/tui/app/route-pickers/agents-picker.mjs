// route-pickers/agents-picker.mjs
// The Agents roster and the per-agent panel: pin an agent to a model through
// the nested model picker, or switch it off.
import { theme } from '../../theme.mjs';

const NOT_USED_META = [
  { text: '(not used)', width: 17 },
  { text: '', width: 6 },
  { text: '', width: 4 },
];

export function createAgentsPicker({
  store,
  surface,
  setProviderPrompt,
  setSettingsPrompt,
  closeUsagePanel,
  clean,
  agentModelParts,
  agentModelProfile,
  openModelPicker,
}) {
  /** The agent's own panel: "Set model…" opens the nested model picker with
   *  the agent's route; "Not used" writes disabled and returns to the roster. */
  const openAgentOptions = (own, agent, refreshModels) => {
    // Agents are either pinned to a model or switched off — the same two
    // states the desktop panel offers. "Follows Main" is web-search only.
    const openAgentModelPicker = () =>
      void openModelPicker({
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
    const turnOff = async () => {
      // Post-ack handover back to Agents, bound to THIS keypress: a late
      // ack must not overwrite whatever replaced this panel meanwhile.
      const reopenAgents = own.defer(() => {
        void openAgentsPicker();
      });
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
    };
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
        await turnOff();
      },
      onCancel: () => {
        void openAgentsPicker();
      },
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
    const routeOverrides =
      options.routeOverrides && typeof options.routeOverrides === 'object' ? options.routeOverrides : {};
    const initialAgentId = clean(options.initialAgentId || '');
    const items = agents.map((agent) => ({
      value: agent.id,
      label: agent.label,
      metaParts:
        agent.disabled === true && !routeOverrides[agent.id]
          ? NOT_USED_META
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
      initialIndex: Math.max(
        0,
        items.findIndex((item) => item.value === initialAgentId)
      ),
      items,
      onSelect: (_value, item) => {
        if (item?._agent) openAgentOptions(own, item._agent, refreshModels);
      },
      onCancel: () => {
        own.close();
      },
    });
  };

  return { openAgentsPicker };
}
