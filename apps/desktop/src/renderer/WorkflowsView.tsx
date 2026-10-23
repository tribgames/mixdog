import { ChevronRight, Plus } from 'lucide-react';
import { useMemo, useState } from 'react';

import type { DesktopApi } from '../shared/contract';
import { t } from './i18n';
import { InitialSurface } from './InitialSurface';
import { customProviderDisplayNames, filterConfiguredModels } from './model-catalog';
import { routeOption } from './model-route-utils';
import { normalizeModelOptions } from './provider-display';
import { ScmContextMenu, type ScmContextMenuState } from './ScmContextMenu';
import { useSidebarReferences, WORKFLOW_REFERENCE_KEYS } from './sidebar-reference-cache';
import { usePersistedListOrder } from './use-persisted-list-order';
import { useSidebarCapabilityRunner } from './use-sidebar-capability-runner';
import type { RecordValue } from './desktop-types';
import {
  AgentRouteRow,
  AgentRouteSummaryView,
  AgentRowIcon,
  agentRosterOf,
  agentRouteSummary,
  type AgentSummary,
  ownRoute,
} from './workflows-agent-rows';
import { useWorkflowEditors, WorkflowEditorDialogs } from './workflows-editors';
import { useLeadMainRoute } from './workflows-main-route';
import { WorkRulesSection } from './workflows-work-rules';

export { leadFallbacksOf, leadRouteFrom } from './workflows-main-route';

type WorkflowsApi = Partial<
  Pick<DesktopApi, 'invokeCapability' | 'listProviderModels' | 'getSnapshot' | 'setModelRoute'>
>;

// Agents have exactly two states: a pinned model, or off. "Follows Main" is
// reserved for Web Search, whose row keeps its own default marker route.
// Shared services, not delegation targets: they run behind a tool (web_search,
// explore) or a background cycle (maintainer), so they carry a model route but
// no editable definition and never appear in a workflow's agent subset.
const DEFAULT_AGENT_IDS = new Set(['maintainer', 'explore']);

// listWorkflows/listAgents/quickProviderModels are the same shared snapshots
// Schedules and Webhooks read, so entering this panel costs nothing extra.
// Workflow and agent configuration has its own rail destination. The sidebar
// surface owns the panel wrapper; this body renders its lists and popup editors.
export function WorkflowsPane({ api = window.mixdogDesktop, active = true }: { api?: WorkflowsApi; active?: boolean }) {
  // App pre-mounts rail destinations while idle, and boot prewarms these keys,
  // so a normal first click is already a warm, atomic reveal.
  const { values, loading, completeMutation } = useSidebarReferences(api, WORKFLOW_REFERENCE_KEYS, active);
  const workflows = values.workflows;
  const agents = values.agents;
  const webSearchRoute = values.webSearchRoute;
  const providerSetup = values.providerSetup;
  const models = useMemo(
    () => filterConfiguredModels(normalizeModelOptions(values.quickProviderModels), providerSetup),
    [values.quickProviderModels, providerSetup]
  );
  const providerNames = useMemo(() => customProviderDisplayNames(providerSetup), [providerSetup]);
  const webSearchModels = useMemo(
    () => filterConfiguredModels(normalizeModelOptions(values.webSearchModels.map(routeOption)), providerSetup),
    [values.webSearchModels, providerSetup]
  );
  const { pending, error, setError, run } = useSidebarCapabilityRunner({
    api,
    completeMutation,
    toastScope: 'workflow',
  });
  const [menu, setMenu] = useState<ScmContextMenuState | null>(null);
  const [mainRoute, setMainRoute] = useLeadMainRoute(active, api);
  const editors = useWorkflowEditors({ api, active, run, setError, setMainRoute, onDismiss: () => setMenu(null) });
  const { openEditor, openAgentEditor, setAgentEnabled } = editors;
  const busy = Boolean(pending) || loading || editors.loadingEditor !== null;
  const agentRoster = useMemo(() => agentRosterOf(agents), [agents]);
  const maintainerAgent = agentRoster.find((agent) => agent.id === 'maintainer');
  const maintainerRow = agents.find((agent) => String(agent.id || '') === 'maintainer');
  const exploreAgent = agentRoster.find((agent) => agent.id === 'explore');
  const exploreRow = agents.find((agent) => String(agent.id || '') === 'explore');
  // Bots (agent-mode contacts) are not delegation roles.
  const editableAgents = agentRoster.filter((agent) => !DEFAULT_AGENT_IDS.has(agent.id) && !agent.contact);
  const workflowOrder = usePersistedListOrder(
    'mixdog.sidebar-order.workflows.v1',
    workflows.map((workflow) => String(workflow.id || ''))
  );
  const orderedWorkflows = workflowOrder.orderedIds
    .map((id) => workflows.find((workflow) => String(workflow.id || '') === id))
    .filter((workflow): workflow is RecordValue => Boolean(workflow));
  const defaultAgentIds = [
    'web-search',
    ...(exploreAgent ? [exploreAgent.id] : []),
    ...(maintainerAgent ? [maintainerAgent.id] : []),
  ];
  const defaultAgentOrder = usePersistedListOrder('mixdog.sidebar-order.default-agents.v1', defaultAgentIds);
  const agentOrder = usePersistedListOrder(
    'mixdog.sidebar-order.agents.v1',
    editableAgents.map((agent) => agent.id)
  );
  const orderedEditableAgents = agentOrder.orderedIds
    .map((id) => editableAgents.find((agent) => agent.id === id))
    .filter((agent): agent is AgentSummary => Boolean(agent));
  // Items that open an editor run after the menu closes and returns focus to
  // the row; Delete only opens the editor with its confirmation armed.
  const later = (action: () => void) => () => window.setTimeout(action, 0);
  const openRowMenu = (label: string, point: { x: number; y: number }, items: ScmContextMenuState['items']) =>
    setMenu({ label, ...point, items });
  const agentToggleItem = (id: string, disabled: boolean, route: RecordValue): ScmContextMenuState['items'][number] => {
    const { disabled: _off, ...picked } = route;
    const canEnable = Boolean(picked.provider && picked.model);
    return {
      id: 'toggle',
      label: disabled ? t('Enable') : t('Disable'),
      disabled: disabled && !canEnable,
      title: disabled && !canEnable ? t('Pick a model to turn this agent on.') : undefined,
      onSelect: () => setAgentEnabled(id, disabled, picked),
    };
  };
  const renderAgentRow = (agent: AgentSummary) => {
    const row = agents.find((entry) => String(entry.id) === agent.id);
    const route = ownRoute(row);
    const disabled = row?.disabled === true;
    const menuItems: ScmContextMenuState['items'] = [
      {
        id: 'edit',
        label: t('Edit'),
        onSelect: later(() => void openAgentEditor(agent.id, agent.label, agent.custom)),
      },
      agentToggleItem(agent.id, disabled, route),
      ...(agent.custom
        ? [
            {
              id: 'delete',
              label: t('Delete'),
              danger: true,
              separatorBefore: true,
              onSelect: later(() => void openAgentEditor(agent.id, agent.label, true, true)),
            },
          ]
        : []),
    ];
    return (
      <AgentRouteRow
        key={agent.id}
        agent={agent}
        route={route}
        disabled={disabled}
        models={models}
        busy={busy}
        reorderProps={agentOrder.getReorderProps(agent.id)}
        onOpen={() => void openAgentEditor(agent.id, agent.label, agent.custom)}
        onOpenMenu={(point) => openRowMenu(agent.label, point, menuItems)}
      />
    );
  };

  // Built-in shared-service agents (explore, maintainer): route-only rows.
  const renderDefaultAgentRow = (agent: AgentSummary, row: RecordValue | undefined) => {
    const disabled = row?.disabled === true;
    const route = ownRoute(row);
    const openRoute = () =>
      editors.openRoute({
        id: agent.id,
        label: agent.label,
        route,
        disabled,
        capability: 'setAgentRoute',
        modelKind: 'agent',
        description:
          agent.description && !agent.custom && !agent.userOverride ? t(agent.description) : agent.description,
        readOnlyDefinition: true,
      });
    const menuItems: ScmContextMenuState['items'] = [
      { id: 'settings', label: t('Agent settings'), onSelect: later(openRoute) },
      agentToggleItem(agent.id, disabled, route),
    ];
    return (
      <AgentRouteRow
        agent={agent}
        route={route}
        disabled={disabled}
        models={models}
        busy={busy}
        builtIn
        order={defaultAgentOrder.orderedIds.indexOf(agent.id)}
        reorderProps={defaultAgentOrder.getReorderProps(agent.id)}
        onOpen={openRoute}
        onOpenMenu={(point) => openRowMenu(agent.label, point, menuItems)}
      />
    );
  };

  return (
    <>
      {active && (
        <WorkflowEditorDialogs
          api={api}
          editors={editors}
          models={models}
          providerSetup={providerSetup}
          webSearchModels={webSearchModels}
          providerNames={providerNames}
          busy={busy}
          error={error}
        />
      )}
      <ScmContextMenu state={menu} onClose={() => setMenu(null)} />
      {loading && <InitialSurface variant="rows" />}
      {!loading && (
        <>
          {/* The panel is titled Workflows already; the list under it is named
          for what it holds (user: 워크플로우 두 개 붙어 있는 게 어색해서). */}
          <WorkRulesSection
            workflows={workflows}
            orderedWorkflows={orderedWorkflows}
            busy={busy}
            getReorderProps={workflowOrder.getReorderProps}
            later={later}
            onNew={editors.newWorkflow}
            onOpen={(id, name, deletable, armDelete) => void openEditor(id, name, deletable, armDelete)}
            openRowMenu={openRowMenu}
          />
          {/* The Lead runs on the Main route; its instructions come from the
              selected work-rules pack, so this row edits the model only. */}
          <section className="workflows-models" aria-label={t('Lead agent')}>
            <h2>{t('Lead agent')}</h2>
            <div className="schedules-list">
              <button
                type="button"
                className="schedules-row utilities-row sidebar-resource-row workflows-agent-summary-row workflows-default-agent-summary-row"
                data-agent-id="lead"
                data-tooltip={t('Agent settings')}
                disabled={busy}
                aria-label={t('Edit {{name}}', { name: 'Lead' })}
                onClick={() =>
                  editors.openRoute({
                    id: 'lead',
                    label: 'Lead',
                    route: mainRoute,
                    capability: 'setModelRoute',
                    modelKind: 'main',
                    description: t(
                      'Talks with you directly, plans the work, and hands parts of it to the agents below.'
                    ),
                    readOnlyDefinition: true,
                  })
                }
              >
                <AgentRowIcon route={mainRoute} />
                <span className="schedules-row-copy utilities-row-copy">
                  <b>Lead</b>
                  <AgentRouteSummaryView summary={agentRouteSummary(mainRoute, models)} />
                </span>
                <ChevronRight className="utilities-row-chevron" size={16} aria-hidden="true" />
              </button>
            </div>
          </section>
          {/* Built-in agents (Web Search, Explore, Maintainer) are read-only
              helpers, a group of their own above the delegation roles. */}
          <section className="workflows-models" aria-label={t('Built-in agents')}>
            <h2>{t('Built-in agents')}</h2>
            <div className="schedules-list">
              <button
                type="button"
                className="schedules-row utilities-row sidebar-resource-row workflows-agent-summary-row workflows-default-agent-summary-row"
                style={{ order: defaultAgentOrder.orderedIds.indexOf('web-search') }}
                title={t('Use when Mixdog runs the web_search tool.')}
                disabled={busy}
                aria-label={t('Edit Web Search')}
                onClick={() =>
                  editors.openRoute({
                    id: 'web-search',
                    label: 'Web Search',
                    route: webSearchRoute,
                    capability: 'setWebSearchRoute',
                    modelKind: 'webSearch',
                    description: t('Use when Mixdog runs the web_search tool.'),
                    readOnlyDefinition: true,
                  })
                }
                {...defaultAgentOrder.getReorderProps('web-search')}
              >
                <AgentRowIcon route={webSearchRoute} fallback="web" />
                <span className="schedules-row-copy utilities-row-copy">
                  {/* Agent names stay as named, like every other row (user: 워커명이 왜 저거만 한글이야). */}
                  <b>Web Search</b>
                  <AgentRouteSummaryView
                    summary={agentRouteSummary(webSearchRoute, webSearchModels, { webSearch: true })}
                  />
                </span>
                <ChevronRight className="utilities-row-chevron" size={16} aria-hidden="true" />
              </button>
              {exploreAgent && renderDefaultAgentRow(exploreAgent, exploreRow)}
              {maintainerAgent && renderDefaultAgentRow(maintainerAgent, maintainerRow)}
            </div>
          </section>
          <section className="workflows-models" aria-label={t('Agents')}>
            <div className="workflows-section-head">
              <h2>{t('Agents')}</h2>
              {/* Section action mirrors the panel-header "+" grammar (icon-only,
              24px) instead of a one-off text pill inside the list. */}
              <button
                type="button"
                className="session-panel-action schedules-new"
                disabled={busy}
                aria-label={t('New agent')}
                data-tooltip={t('New agent')}
                onClick={editors.newAgent}
              >
                <Plus size={16} aria-hidden="true" />
              </button>
            </div>
            <div className="schedules-list">{orderedEditableAgents.map(renderAgentRow)}</div>
          </section>
        </>
      )}
    </>
  );
}
