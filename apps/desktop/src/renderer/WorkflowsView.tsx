import {
  ChevronRight,
  Layers3,
  Plus,
} from 'lucide-react';
import { useMemo, useRef, useState } from 'react';

import type {
  DesktopApi,
  DesktopCapability,
  DesktopModelOption,
} from '../shared/contract';
import { t } from './i18n';
import { InitialSurface } from './InitialSurface';
import { filterConfiguredModels } from './model-catalog';
import { preferredModelEffort, routeOption } from './model-route-utils';
import { showDesktopToast } from './notifications';
import {
  ModelRouteLabel,
  modelDisplayName,
  normalizeModelOptions,
} from './provider-display';
import { record } from './record-utils';
import { SidebarLoadingDialog } from './sidebar-dialog';
import { useSidebarPanelDismiss } from './sidebar-panel-surface';
import {
  useSidebarReferences,
  type SidebarReferenceKey,
} from './sidebar-reference-cache';
import { usePersistedListOrder } from './use-persisted-list-order';
import {
  AgentEditorDialog,
  RouteEditorDialog,
  WorkflowEditorDialog,
  type RouteEditorTarget,
} from './workflow-dialogs';

type RecordValue = Record<string, unknown>;
export type WorkflowsApi = Partial<Pick<DesktopApi, 'invokeCapability' | 'listProviderModels'>>;

type AgentRouteSummary = {
  model: string;
  effort: string;
  fast: boolean;
  effortLabel: string;
};

function agentRouteSummary(route: RecordValue, models: DesktopModelOption[]): AgentRouteSummary {
  const provider = String(route.provider || '');
  const model = String(route.model || '');
  const selected = models.find((entry) => entry.provider === provider && entry.model === model);
  const modelLabel = model
    ? modelDisplayName(model, provider, selected?.display || '')
    : 'Default · follows Main';
  const effortValue = String(route.effort || preferredModelEffort(selected) || '');
  const effortOption = selected?.effortOptions.find((entry) => entry.value === effortValue);
  const rawEffortLabel = effortOption?.label || effortValue;
  const fastCapable = selected?.fastCapable === true || typeof route.fast === 'boolean';
  const fast = typeof route.fast === 'boolean' ? route.fast : selected?.fastPreferred === true;
  return {
    model: modelLabel,
    effort: effortValue,
    fast: fastCapable && fast,
    effortLabel: rawEffortLabel,
  };
}

function SidebarResourceTitle({ label }: {
  label: string;
}) {
  return <span className="sidebar-resource-title">
    <b>{label}</b>
  </span>;
}

function AgentRouteSummaryView({ summary }: {
  summary: AgentRouteSummary;
}) {
  return <small className="agent-route-summary route-trigger-copy">
    <ModelRouteLabel model={summary.model} effort={summary.effort}
      fast={summary.fast} effortLabel={summary.effortLabel} />
  </small>;
}

// Agents have exactly two states: a pinned model, or off. "Follows Main" is
// reserved for Web Search, whose row keeps its own default marker route.
// Shared services, not delegation targets: they run behind a tool (web_search,
// explore) or a background cycle (maintainer), so they carry a model route but
// no editable definition and never appear in a workflow's agent subset.
const DEFAULT_AGENT_IDS = new Set(['maintainer', 'explore']);

interface AgentSummary {
  id: string;
  label: string;
  description: string;
  custom: boolean;
  userOverride: boolean;
}

// listWorkflows/listAgents/quickProviderModels are the same shared snapshots
// Schedules and Webhooks read, so entering this panel costs nothing extra.
const WORKFLOW_REFERENCE_KEYS = [
  'workflows',
  'agents',
  'webSearchRoute',
  'webSearchModels',
  'providerSetup',
  'quickProviderModels',
] as const satisfies readonly SidebarReferenceKey[];

// Workflow and agent configuration (Projects panel → Workflow tab). The
// hosting ProjectsPane owns the surface wrapper and the section toolbar; this
// section renders its lists and popup editors.
export function WorkflowsPane({
  api = window.mixdogDesktop,
  active = true,
}: {
  api?: WorkflowsApi;
  active?: boolean;
}) {
  // App pre-mounts rail destinations while idle, and boot prewarms these keys,
  // so a normal first click is already a warm, atomic reveal.
  const { values, loading, completeMutation } =
    useSidebarReferences(api, WORKFLOW_REFERENCE_KEYS, active);
  const workflows = values.workflows;
  const agents = values.agents;
  const webSearchRoute = values.webSearchRoute;
  const providerSetup = values.providerSetup;
  const models = useMemo(() => filterConfiguredModels(
    normalizeModelOptions(values.quickProviderModels),
    providerSetup,
  ), [values.quickProviderModels, providerSetup]);
  const webSearchModels = useMemo(() => filterConfiguredModels(
    normalizeModelOptions(values.webSearchModels.map(routeOption)),
    providerSetup,
  ), [values.webSearchModels, providerSetup]);
  const [pending, setPending] = useState('');
  const [error, setError] = useState('');
  const [editor, setEditor] = useState<{ pack: RecordValue | null; deletable: boolean } | null>(null);
  const [agentEditor, setAgentEditor] =
    useState<{ agent: RecordValue | null; deletable: boolean } | null>(null);
  const [routeEditor, setRouteEditor] = useState<RouteEditorTarget | null>(null);
  const [loadingEditor, setLoadingEditor] =
    useState<{ kind: 'workflow' | 'agent'; title: string } | null>(null);
  const detailRequestRef = useRef(0);
  // Both editors portal to document.body, outside the sidebar's inert box:
  // deactivating the panel closes them and disarms pending deletions, while
  // the workflow/agent lists keep their state.
  useSidebarPanelDismiss(active, () => {
    detailRequestRef.current += 1;
    setLoadingEditor(null);
    setEditor(null);
    setAgentEditor(null);
    setRouteEditor(null);
  });
  const busy = Boolean(pending) || loading || loadingEditor !== null;
  const run = async (
    capability: DesktopCapability,
    args: unknown[] = [],
    errorMode: 'inline' | 'toast' = 'inline',
  ): Promise<unknown> => {
    if (!api?.invokeCapability || pending) return undefined;
    setPending(capability);
    setError('');
    try {
      const result = await api.invokeCapability({ capability, args });
      // Host-scoped completion boundary (see the cache module): never re-adopt
      // a host the app already left.
      await completeMutation(capability);
      return result?.value ?? true;
    } catch (reason) {
      const message = reason instanceof Error ? reason.message : String(reason);
      if (errorMode === 'toast') showDesktopToast(message, 'error', { scope: `workflow:${capability}` });
      else setError(message);
      return undefined;
    } finally {
      setPending('');
    }
  };

  const openEditor = async (id: string, title: string, deletable: boolean) => {
    if (!api?.invokeCapability) return;
    const requestId = ++detailRequestRef.current;
    setLoadingEditor({ kind: 'workflow', title });
    try {
      const result = await api.invokeCapability<RecordValue>({ capability: 'getWorkflowPack', args: [id] });
      if (detailRequestRef.current !== requestId) return;
      setError('');
      setEditor({ pack: record(result?.value), deletable });
    } catch (reason) {
      if (detailRequestRef.current !== requestId) return;
      showDesktopToast(reason instanceof Error ? reason.message : String(reason), 'error', { scope: `workflow:open:${id}` });
    } finally {
      if (detailRequestRef.current === requestId) setLoadingEditor(null);
    }
  };
  const saveWorkflow = async (payload: RecordValue) => {
    const result = await run(editor?.pack ? 'saveWorkflowPack' : 'createWorkflow', [payload]);
    if (result !== undefined) {
      setEditor(null);
      showDesktopToast(`Saved "${String(payload.name || payload.id)}".`, 'success');
    }
  };
  const deleteWorkflowPack = async (id: string) => {
    const result = await run('deleteWorkflow', [id]);
    if (result !== undefined) {
      setEditor(null);
      showDesktopToast(record(result).revertedToBuiltIn === true
        ? `"${id}" reverted to the built-in pack.`
        : `Deleted "${id}".`, 'success');
    }
  };
  const agentRoster = useMemo<AgentSummary[]>(() => agents.map((agent) => ({
    id: String(agent.id || ''),
    label: String(agent.label || record(agent.definition).name || agent.id || ''),
    description: String(record(agent.definition).description || agent.description || ''),
    custom: agent.custom === true,
    userOverride: agent.userOverride === true,
  })).filter((agent) => agent.id), [agents]);
  const maintainerAgent = agentRoster.find((agent) => agent.id === 'maintainer');
  const maintainerRow = agents.find((agent) => String(agent.id || '') === 'maintainer');
  const exploreAgent = agentRoster.find((agent) => agent.id === 'explore');
  const exploreRow = agents.find((agent) => String(agent.id || '') === 'explore');
  const editableAgents = agentRoster.filter((agent) => !DEFAULT_AGENT_IDS.has(agent.id));
  const workflowOrder = usePersistedListOrder(
    'mixdog.sidebar-order.workflows.v1',
    workflows.map((workflow) => String(workflow.id || '')),
  );
  const orderedWorkflows = workflowOrder.orderedIds
    .map((id) => workflows.find((workflow) => String(workflow.id || '') === id))
    .filter((workflow): workflow is RecordValue => Boolean(workflow));
  const defaultAgentIds = [
    'web-search',
    ...(exploreAgent ? [exploreAgent.id] : []),
    ...(maintainerAgent ? [maintainerAgent.id] : []),
  ];
  const defaultAgentOrder = usePersistedListOrder(
    'mixdog.sidebar-order.default-agents.v1',
    defaultAgentIds,
  );
  const agentOrder = usePersistedListOrder(
    'mixdog.sidebar-order.agents.v1',
    editableAgents.map((agent) => agent.id),
  );
  const orderedEditableAgents = agentOrder.orderedIds
    .map((id) => editableAgents.find((agent) => agent.id === id))
    .filter((agent): agent is AgentSummary => Boolean(agent));
  const openAgentEditor = async (id: string, title: string, deletable: boolean) => {
    if (!api?.invokeCapability) return;
    const requestId = ++detailRequestRef.current;
    setLoadingEditor({ kind: 'agent', title });
    try {
      const result = await api.invokeCapability<RecordValue>({ capability: 'getAgentDefinition', args: [id] });
      if (detailRequestRef.current !== requestId) return;
      setError('');
      setAgentEditor({ agent: record(result?.value), deletable });
    } catch (reason) {
      if (detailRequestRef.current !== requestId) return;
      showDesktopToast(reason instanceof Error ? reason.message : String(reason), 'error', { scope: `agent:open:${id}` });
    } finally {
      if (detailRequestRef.current === requestId) setLoadingEditor(null);
    }
  };
  const saveAgent = async (payload: RecordValue) => {
    const result = await run('saveAgentDefinition', [payload]);
    if (result !== undefined) {
      setAgentEditor(null);
      showDesktopToast(`Saved agent "${String(payload.name || payload.id)}".`, 'success');
    }
  };
  const deleteAgent = async (id: string) => {
    const result = await run('deleteAgentDefinition', [id]);
    if (result !== undefined) {
      setAgentEditor(null);
      showDesktopToast(`Deleted agent "${id}".`, 'success');
    }
  };
  const saveRoute = async (route: RecordValue) => {
    if (!routeEditor) return;
    const args = routeEditor.capability === 'setWebSearchRoute'
      ? [route]
      : [routeEditor.id, route];
    const result = await run(routeEditor.capability, args);
    if (result !== undefined) {
      setRouteEditor(null);
      showDesktopToast(`Saved "${routeEditor.label}" route.`, 'success');
    }
  };
  const setAgentEnabled = (id: string, enabled: boolean, route: RecordValue) => {
    void run('setAgentRoute', [id, enabled ? route : { disabled: true }]);
  };
  const renderAgentRow = (agent: AgentSummary) => {
    const row = agents.find((entry) => String(entry.id) === agent.id);
    const route = record(row?.route);
    return <button type="button" key={agent.id}
      className="schedules-row utilities-row sidebar-resource-row workflows-agent-summary-row"
      title={agent.description || agent.label} disabled={busy}
      aria-label={t('Edit {{name}}', { name: agent.label })}
      onClick={() => void openAgentEditor(agent.id, agent.label, agent.custom)}
      {...agentOrder.getReorderProps(agent.id)}>
      <span className="schedules-row-copy utilities-row-copy">
        <SidebarResourceTitle label={agent.label} />
        <AgentRouteSummaryView summary={agentRouteSummary(route, models)} />
      </span>
      <ChevronRight className="utilities-row-chevron" size={16} aria-hidden="true" />
    </button>;
  };

  return <>
      {active && loadingEditor && <SidebarLoadingDialog title={loadingEditor.title}
        dataAttributes={{ 'data-sidebar-loading': loadingEditor.kind }}
        onClose={() => {
          detailRequestRef.current += 1;
          setLoadingEditor(null);
        }} />}
      {active && editor && <WorkflowEditorDialog key={String(record(editor.pack).id || '(new)')}
        pack={editor.pack} deletable={editor.deletable} busy={busy} error={error}
        onCancel={() => {
          setError('');
          setEditor(null);
        }} onSave={(payload) => void saveWorkflow(payload)}
        onDelete={() => void deleteWorkflowPack(String(record(editor.pack).id || ''))} />}
      {active && agentEditor && <AgentEditorDialog key={String(record(agentEditor.agent).id || '(new-agent)')}
        agent={agentEditor.agent} deletable={agentEditor.deletable}
        models={models} busy={busy} error={error}
        onCancel={() => {
          setError('');
          setAgentEditor(null);
        }} onSave={(payload) => void saveAgent(payload)}
        onToggle={(enabled, route) => setAgentEnabled(
          String(record(agentEditor.agent).id || ''), enabled, route)}
        onDelete={() => void deleteAgent(String(record(agentEditor.agent).id || ''))} />}
      {active && routeEditor && <RouteEditorDialog key={`${routeEditor.capability}:${routeEditor.id}`}
        target={routeEditor}
        models={routeEditor.modelKind === 'webSearch' ? webSearchModels : models}
        busy={busy} error={error}
        onCancel={() => {
          setError('');
          setRouteEditor(null);
        }}
        onToggle={(enabled, route) => setAgentEnabled(routeEditor.id, enabled, route)}
        onSave={(route) => void saveRoute(route)} />}
      {loading ? <InitialSurface /> : <>
      <section className="workflows-models workflows-packs" aria-label={t("Workflows")}>
      <div className="workflows-section-head">
        <h2>{t('Workflows')}</h2>
        <button type="button" className="session-panel-action schedules-new" disabled={busy}
          aria-label={t("New workflow")} data-tooltip={t("New workflow")}
          onClick={() => {
            setError('');
            setEditor({ pack: null, deletable: false });
          }}>
          <Plus size={16} aria-hidden="true" />
        </button>
      </div>
      {workflows.length ? <div className="schedules-list">{orderedWorkflows.map((workflow) => {
          const id = String(workflow.id || '');
          const name = String(workflow.name || id);
          const custom = String(workflow.source || '') === 'user';
          return <button type="button" key={id}
            className="schedules-row utilities-row sidebar-resource-row"
            disabled={busy} aria-label={t("Edit workflow {{name}}", { name })}
            onClick={() => void openEditor(id, name, custom)} {...workflowOrder.getReorderProps(id)}>
            <span className="schedules-row-copy utilities-row-copy">
              <b>{name}</b>
              <small>{[workflow.description ? t(String(workflow.description)) : '', custom ? t('Custom') : '']
                .filter(Boolean).join(' · ')}</small>
            </span>
            <ChevronRight className="utilities-row-chevron" size={16} aria-hidden="true" />
          </button>;
        })}</div>
        : <div className="schedules-empty">
          <Layers3 size={40} strokeWidth={1.5} aria-hidden="true" />
          <p>{t('No workflow packs found.')}</p>
        </div>}
      </section>
      <section className="workflows-models" aria-label={t("Default agents")}>
        <h2>{t('Default agents')}</h2>
        <p>{t('Shared models without editable agent definitions.')}</p>
        <div className="schedules-list">
          <button type="button"
            className="schedules-row utilities-row sidebar-resource-row workflows-agent-summary-row workflows-default-agent-summary-row"
            style={{ order: defaultAgentOrder.orderedIds.indexOf('web-search') }}
            title={t('Use when Mixdog runs the web_search tool.')} disabled={busy}
            aria-label={t('Edit Web Search')}
            onClick={() => setRouteEditor({
                id: 'web-search',
                label: 'Web Search',
                route: webSearchRoute,
                capability: 'setWebSearchRoute',
                modelKind: 'webSearch',
                description: t('Use when Mixdog runs the web_search tool.'),
                readOnlyDefinition: true,
              })}
            {...defaultAgentOrder.getReorderProps('web-search')}>
            <span className="schedules-row-copy utilities-row-copy">
              <b>{t('Web Search')}</b>
              <AgentRouteSummaryView summary={agentRouteSummary(webSearchRoute, webSearchModels)} />
            </span>
            <ChevronRight className="utilities-row-chevron" size={16} aria-hidden="true" />
          </button>
          {exploreAgent && <button type="button"
            className="schedules-row utilities-row sidebar-resource-row workflows-agent-summary-row workflows-default-agent-summary-row"
            style={{ order: defaultAgentOrder.orderedIds.indexOf(exploreAgent.id) }}
            title={exploreAgent.description || exploreAgent.label} disabled={busy}
            aria-label={t('Edit {{name}}', { name: exploreAgent.label })}
            onClick={() => setRouteEditor({
                id: exploreAgent.id,
                label: exploreAgent.label,
                route: record(exploreRow?.route),
                disabled: exploreRow?.disabled === true,
                capability: 'setAgentRoute',
                modelKind: 'agent',
                description: exploreAgent.description,
                readOnlyDefinition: true,
              })}
            {...defaultAgentOrder.getReorderProps(exploreAgent.id)}>
            <span className="schedules-row-copy utilities-row-copy">
              <SidebarResourceTitle label={exploreAgent.label} />
              <AgentRouteSummaryView summary={agentRouteSummary(record(exploreRow?.route), models)} />
            </span>
            <ChevronRight className="utilities-row-chevron" size={16} aria-hidden="true" />
          </button>}
          {maintainerAgent && <button type="button"
            className="schedules-row utilities-row sidebar-resource-row workflows-agent-summary-row workflows-default-agent-summary-row"
            style={{ order: defaultAgentOrder.orderedIds.indexOf(maintainerAgent.id) }}
            title={maintainerAgent.description || maintainerAgent.label} disabled={busy}
            aria-label={t('Edit {{name}}', { name: maintainerAgent.label })}
            onClick={() => setRouteEditor({
                id: maintainerAgent.id,
                label: maintainerAgent.label,
                route: record(maintainerRow?.route),
                disabled: maintainerRow?.disabled === true,
                capability: 'setAgentRoute',
                modelKind: 'agent',
                description: maintainerAgent.description,
                readOnlyDefinition: true,
              })}
            {...defaultAgentOrder.getReorderProps(maintainerAgent.id)}>
            <span className="schedules-row-copy utilities-row-copy">
              <SidebarResourceTitle label={maintainerAgent.label} />
              <AgentRouteSummaryView summary={agentRouteSummary(record(maintainerRow?.route), models)} />
            </span>
            <ChevronRight className="utilities-row-chevron" size={16} aria-hidden="true" />
          </button>}
        </div>
      </section>
      <section className="workflows-models" aria-label={t("Agents")}>
        <div className="workflows-section-head">
          <h2>{t('Agents')}</h2>
          {/* Section action mirrors the panel-header "+" grammar (icon-only,
              24px) instead of a one-off text pill inside the list. */}
          <button type="button" className="session-panel-action schedules-new" disabled={busy}
            aria-label={t("New agent")} data-tooltip={t("New agent")}
            onClick={() => {
              setError('');
              setAgentEditor({ agent: null, deletable: false });
            }}>
            <Plus size={16} aria-hidden="true" />
          </button>
        </div>
            <p>{t('Starter and custom roles with editable definitions and models.')}</p>
        <div className="schedules-list">
          {orderedEditableAgents.map(renderAgentRow)}
        </div>
      </section>
      </>}
  </>;
}
