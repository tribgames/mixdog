import {
  ChevronRight,
  Compass,
  Globe,
  Layers3,
  Plus,
  Wrench,
  X,
} from 'lucide-react';
import { type FormEvent, useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';

import type {
  DesktopApi,
  DesktopCapability,
  DesktopModelOption,
  DesktopModelSelection,
} from '../shared/contract';
import { agentIcon } from './agent-icons';
import { t } from './i18n';
import { filterConfiguredModels } from './model-catalog';
import { ModelRouteEditor } from './ModelRouteEditor';
import { dismissDesktopToast, showDesktopToast } from './notifications';
import { OpenSelect } from './OpenSelect';
import {
  ModelRouteLabel,
  modelDisplayName,
  normalizeModelOptions,
} from './provider-display';
import { useSidebarPanelDismiss } from './sidebar-panel-surface';
import {
  useSidebarReferences,
  type SidebarReferenceKey,
} from './sidebar-reference-cache';
import {
  preferredEffort,
  routeOption,
} from './settings/capability-controls';
import { acquireTitleBarDim } from './titlebar-dim';
import { usePersistedListOrder } from './use-persisted-list-order';

type RecordValue = Record<string, unknown>;
export type WorkflowsApi = Partial<Pick<DesktopApi, 'invokeCapability' | 'listProviderModels'>>;
type RouteEditorTarget = {
  id: string;
  label: string;
  route: RecordValue;
  capability: Extract<DesktopCapability, 'setSearchRoute' | 'setAgentRoute'>;
  modelKind: 'search' | 'agent';
  description: string;
  readOnlyDefinition: boolean;
};

function record(value: unknown): RecordValue {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as RecordValue : {};
}

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
  const effortValue = String(route.effort || preferredEffort(selected) || '');
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

function AgentRouteSummaryView({ summary }: { summary: AgentRouteSummary }) {
  return <small className="agent-route-summary route-trigger-copy">
    <ModelRouteLabel model={summary.model} effort={summary.effort}
      fast={summary.fast} effortLabel={summary.effortLabel} />
  </small>;
}

// Shared services, not delegation targets: they run behind a tool (search,
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

const NEW_WORKFLOW_BODY = [
  '# New Workflow',
  '',
  'Describe how the Lead runs this workflow: when to delegate to agents,',
  'what each phase must deliver, and how results are verified.',
].join('\n');

const NEW_AGENT_BODY = [
  '# New Agent',
  '',
  'Describe this agent role: what it owns, how it works, and what it must',
  'deliver back to the Lead.',
].join('\n');

// Reuse the canonical compact route editor so model, effort, and fast mode
// match the existing options surface instead of drifting in a local copy.
function RouteControls({ label, route, models, disabled, onChange }: {
  label: string;
  route: RecordValue;
  models: DesktopModelOption[];
  disabled: boolean;
  onChange(selection: DesktopModelSelection): void;
}) {
  return <div className="workflows-route-controls">
    <ModelRouteEditor ariaLabel={label} models={models} disabled={disabled}
      value={route as unknown as DesktopModelSelection} onChange={onChange} />
  </div>;
}

// Popup editor (schedules-dialog grammar): name/description, delegation
// on/off, and the WORKFLOW.md body. `pack` null means create. Agents are
// global — packs no longer carry a roster.
function WorkflowEditorDialog({ pack, deletable, busy, error = '', onCancel, onSave, onDelete }: {
  pack: RecordValue | null;
  deletable: boolean;
  busy: boolean;
  error?: string;
  onCancel(): void;
  onSave(payload: RecordValue): void;
  onDelete(): void;
}) {
  const editing = Boolean(pack);
  // ONE agent-related setting per pack: delegates (every defined agent is
  // available) or not (Solo-style, `delegation: none`).
  const [delegates, setDelegates] = useState(() => !editing || pack?.delegatesAgents !== false);
  const [formError, setFormError] = useState('');
  const [confirmDelete, setConfirmDelete] = useState(false);
  // The scrim cannot dim the NATIVE caption band — hold the titlebar claim
  // while this dialog is mounted (user: - ㅁ x 딤드 안 먹음).
  useEffect(() => acquireTitleBarDim(), []);
  // Portaled editor: the list lives in the session panel, so the dialog must
  // escape the sidebar's clipped/transformed box.
  return createPortal(<div className="schedules-dialog-layer"
    onMouseDown={(event) => { if (event.target === event.currentTarget) onCancel(); }}
    onKeyDown={(event) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        onCancel();
      }
    }}>
    <section className="schedules-dialog workflows-dialog" role="dialog" aria-modal="true" aria-labelledby="workflows-dialog-title">
      <header>
        <h2 id="workflows-dialog-title">{editing ? t('Edit workflow') : t('Create workflow')}</h2>
        <button type="button" aria-label={t("Close workflow editor")} onClick={onCancel}><X size={16} aria-hidden="true" /></button>
      </header>
      <form onSubmit={(event: FormEvent<HTMLFormElement>) => {
        event.preventDefault();
        const data = new FormData(event.currentTarget);
        const text = (name: string) => String(data.get(name) || '').trim();
        const body = String(data.get('workflow-body') || '').trim();
        if (!body) {
          setFormError('WORKFLOW.md must not be empty.');
          return;
        }
        setFormError('');
        onSave({
          ...(editing ? { id: String(pack?.id || '') } : {}),
          name: text('workflow-name'),
          description: text('workflow-description'),
          // null keeps the pack delegating (no frontmatter key); 'none'
          // writes `delegation: none` (Solo-style, no agents at all).
          delegation: delegates ? null : 'none',
          body,
        });
      }}>
        <label className="schedules-field"><span>{t('Name')}</span>
          <small>{t('Shown in workflow lists and the composer.')}</small>
          <input name="workflow-name" defaultValue={String(pack?.name || '')}
            placeholder={t("Workflow name")} required autoFocus={!editing} disabled={busy} maxLength={64} />
        </label>
        <label className="schedules-field"><span>{t('Description')}</span>
          <small>{t('Shown in workflow lists and included in the prompt.')}</small>
          <input name="workflow-description" data-i18n-skip defaultValue={String(pack?.description || '')}
            placeholder={t('What this workflow does')} disabled={busy} maxLength={160} />
        </label>
        <div className="schedules-field">
          <span>{t('Agents')}</span>
          <small>{t('Whether this workflow can delegate to agents.')}</small>
          <div className="workflows-agent-mode-field">
            <OpenSelect ariaLabel={t('Agents')} value={delegates ? 'allow' : 'none'} disabled={busy}
              options={[
                { value: 'allow', label: t('Allow agents') },
                { value: 'none', label: t('Use no agents') },
              ]}
              onChange={(value) => setDelegates(value === 'allow')} />
          </div>
        </div>
        <label className="schedules-field workflows-md-field"><span data-i18n-skip>WORKFLOW.md</span>
          <small>{t('Instructions that define how this workflow works.')}</small>
          <textarea name="workflow-body" defaultValue={String(pack?.body || (editing ? '' : NEW_WORKFLOW_BODY))}
            required spellCheck={false} disabled={busy} aria-label="WORKFLOW.md body" />
        </label>
        <footer>
          {(formError || error) && <p className="schedules-form-error" role="alert">{formError || error}</p>}
          {deletable && <button type="button"
            className={`danger${confirmDelete ? ' confirming' : ''}`} disabled={busy}
            onClick={() => {
              if (!confirmDelete) {
                setConfirmDelete(true);
                return;
              }
              onDelete();
            }}>{confirmDelete ? t('Confirm delete') : t('Delete')}</button>}
          <button type="button" disabled={busy} onClick={onCancel}>{t('Cancel')}</button>
          <button type="submit" disabled={busy}>{t('Save')}</button>
        </footer>
      </form>
    </section>
  </div>, document.body);
}

// Agent editor dialog: custom agents are created from name, model, and
// AGENT.md; the runtime derives the internal ID. Editing keeps the existing ID.
function AgentEditorDialog({ agent, deletable, models, busy, error = '', onCancel, onSave, onDelete }: {
  agent: RecordValue | null;
  deletable: boolean;
  models: DesktopModelOption[];
  busy: boolean;
  error?: string;
  onCancel(): void;
  onSave(payload: RecordValue): void;
  onDelete(): void;
}) {
  const editing = Boolean(agent);
  const [route, setRoute] = useState<RecordValue>(() => record(agent?.route));
  const [formError, setFormError] = useState('');
  const [confirmDelete, setConfirmDelete] = useState(false);
  useEffect(() => acquireTitleBarDim(), []);
  return createPortal(<div className="schedules-dialog-layer"
    onMouseDown={(event) => { if (event.target === event.currentTarget) onCancel(); }}
    onKeyDown={(event) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        onCancel();
      }
    }}>
    <section className="schedules-dialog workflows-dialog" role="dialog" aria-modal="true" aria-labelledby="agent-dialog-title">
      <header>
        <h2 id="agent-dialog-title">{editing ? t('Edit agent') : t('Create agent')}</h2>
        <button type="button" aria-label={t("Close agent editor")} onClick={onCancel}><X size={16} aria-hidden="true" /></button>
      </header>
      <form onSubmit={(event: FormEvent<HTMLFormElement>) => {
        event.preventDefault();
        const data = new FormData(event.currentTarget);
        const text = (name: string) => String(data.get(name) || '').trim();
        const body = String(data.get('agent-body') || '').trim();
        if (!body) {
          setFormError('AGENT.md must not be empty.');
          return;
        }
        setFormError('');
        onSave({
          ...(editing ? { id: String(agent?.id || '') } : {}),
          name: text('agent-name'),
          description: text('agent-description'),
          ...(route.provider && route.model ? { route } : {}),
          body,
        });
      }}>
        <label className="schedules-field"><span>{t('Name')}</span>
          <small>{t('Shown in agent lists and delegation menus.')}</small>
          <input name="agent-name" defaultValue={String(agent?.name || '')}
            placeholder={t("Agent name")} required autoFocus={!editing} disabled={busy} maxLength={64} />
        </label>
        <label className="schedules-field"><span>{t('When to use')}</span>
          <small>{t('When Mixdog should delegate to this agent.')}</small>
          <input name="agent-description" data-i18n-skip defaultValue={String(agent?.description || '')}
            placeholder={t('When Mixdog should use this')} disabled={busy} maxLength={160} />
        </label>
        <div className="schedules-field">
          <span>{t('Model')}</span>
          <small>{t('Model used when this agent runs.')}</small>
          <div className="workflows-dialog-route">
            <RouteControls label={t("Agent model")} route={route} models={models} disabled={busy}
              onChange={(selection) => setRoute(selection as unknown as RecordValue)} />
          </div>
        </div>
        <label className="schedules-field workflows-md-field"><span data-i18n-skip>AGENT.md</span>
          <small>{t('Instructions that define how this agent works.')}</small>
          <textarea name="agent-body" defaultValue={String(agent?.body || (editing ? '' : NEW_AGENT_BODY))}
            required spellCheck={false} disabled={busy} aria-label="AGENT.md body" />
        </label>
        <footer>
          {(formError || error) && <p className="schedules-form-error" role="alert">{formError || error}</p>}
          {deletable && <button type="button"
            className={`danger${confirmDelete ? ' confirming' : ''}`} disabled={busy}
            onClick={() => {
              if (!confirmDelete) {
                setConfirmDelete(true);
                return;
              }
              onDelete();
            }}>{confirmDelete ? t('Confirm delete') : t('Delete')}</button>}
          <button type="button" disabled={busy} onClick={onCancel}>{t('Cancel')}</button>
          <button type="submit" disabled={busy}>{t('Save')}</button>
        </footer>
      </form>
    </section>
  </div>, document.body);
}

function RouteEditorDialog({ target, models, busy, error = '', onCancel, onSave }: {
  target: RouteEditorTarget;
  models: DesktopModelOption[];
  busy: boolean;
  error?: string;
  onCancel(): void;
  onSave(route: RecordValue): void;
}) {
  const [route, setRoute] = useState<RecordValue>(() => target.route);
  useEffect(() => acquireTitleBarDim(), []);
  return createPortal(<div className="schedules-dialog-layer"
    onMouseDown={(event) => { if (event.target === event.currentTarget) onCancel(); }}
    onKeyDown={(event) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        onCancel();
      }
    }}>
    <section className="schedules-dialog workflows-dialog" role="dialog" aria-modal="true"
      aria-labelledby="route-dialog-title">
      <header>
        <h2 id="route-dialog-title">{t('Edit {{name}}', { name: target.label })}</h2>
        <button type="button" aria-label={t("Close route editor")} onClick={onCancel}>
          <X size={16} aria-hidden="true" />
        </button>
      </header>
      <form onSubmit={(event) => {
        event.preventDefault();
        onSave(route);
      }}>
        {target.readOnlyDefinition && <>
          <label className="schedules-field"><span>{t('Name')}</span>
            <small>{t('Built-in name. This cannot be changed.')}</small>
            <input value={t(target.label)} readOnly disabled tabIndex={-1} />
          </label>
          <label className="schedules-field" title={t(target.description)}><span>{t('When to use')}</span>
            <small>{t('When Mixdog uses this built-in agent. This cannot be changed.')}</small>
            <input value={t(target.description)} readOnly disabled tabIndex={-1} />
          </label>
        </>}
        <div className="schedules-field">
          <span>{t('Model')}</span>
          <small>{t('Model used when this built-in agent runs.')}</small>
          <div className="workflows-dialog-route">
            <RouteControls label={`${target.label} model`} route={route} models={models} disabled={busy}
              onChange={(selection) => setRoute(selection as unknown as RecordValue)} />
          </div>
        </div>
        <footer>
          {error && <p className="schedules-form-error" role="alert">{error}</p>}
          <button type="button" disabled={busy} onClick={onCancel}>{t('Cancel')}</button>
          <button type="submit" disabled={busy}>{t('Save')}</button>
        </footer>
      </form>
    </section>
  </div>, document.body);
}

// listWorkflows/listAgents/quickProviderModels are the same shared snapshots
// Schedules and Webhooks read, so entering this panel costs nothing extra.
const WORKFLOW_REFERENCE_KEYS = [
  'workflows',
  'agents',
  'searchRoute',
  'searchModels',
  'providerSetup',
  'quickProviderModels',
] as const satisfies readonly SidebarReferenceKey[];

// Workflow and agent configuration panel (rail → Workflows).
export function WorkflowsPane({
  api = window.mixdogDesktop,
  active = true,
}: {
  api?: WorkflowsApi;
  active?: boolean;
}) {
  // App pre-mounts rail destinations while idle, and boot prewarms these keys,
  // so a normal first click is already a warm, atomic reveal.
  const { values, loading, error: referenceError, completeMutation } =
    useSidebarReferences(api, WORKFLOW_REFERENCE_KEYS, active);
  const workflows = values.workflows;
  const agents = values.agents;
  const searchRoute = values.searchRoute;
  const providerSetup = values.providerSetup;
  const models = useMemo(() => filterConfiguredModels(
    normalizeModelOptions(values.quickProviderModels),
    providerSetup,
  ), [values.quickProviderModels, providerSetup]);
  const searchModels = useMemo(() => filterConfiguredModels(
    normalizeModelOptions(values.searchModels.map(routeOption)),
    providerSetup,
  ), [values.searchModels, providerSetup]);
  const [pending, setPending] = useState('');
  const [error, setError] = useState('');
  const [editor, setEditor] = useState<{ pack: RecordValue | null; deletable: boolean } | null>(null);
  const [agentEditor, setAgentEditor] =
    useState<{ agent: RecordValue | null; deletable: boolean } | null>(null);
  const [routeEditor, setRouteEditor] = useState<RouteEditorTarget | null>(null);
  // Both editors portal to document.body, outside the sidebar's inert box:
  // deactivating the panel closes them and disarms pending deletions, while
  // the workflow/agent lists keep their state.
  useSidebarPanelDismiss(active, () => {
    setEditor(null);
    setAgentEditor(null);
    setRouteEditor(null);
  });
  const busy = Boolean(pending) || loading;
  useEffect(() => {
    if (!active || !referenceError) return undefined;
    const toastId = showDesktopToast(referenceError, 'error');
    return () => dismissDesktopToast(toastId);
  }, [active, referenceError]);
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
      if (errorMode === 'toast') showDesktopToast(message, 'error');
      else setError(message);
      return undefined;
    } finally {
      setPending('');
    }
  };

  const openEditor = async (id: string, deletable: boolean) => {
    if (!api?.invokeCapability) return;
    try {
      const result = await api.invokeCapability<RecordValue>({ capability: 'getWorkflowPack', args: [id] });
      setError('');
      setEditor({ pack: record(result?.value), deletable });
    } catch (reason) {
      showDesktopToast(reason instanceof Error ? reason.message : String(reason), 'error');
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
  const openAgentEditor = async (id: string, deletable: boolean) => {
    if (!api?.invokeCapability) return;
    try {
      const result = await api.invokeCapability<RecordValue>({ capability: 'getAgentDefinition', args: [id] });
      setError('');
      setAgentEditor({ agent: record(result?.value), deletable });
    } catch (reason) {
      showDesktopToast(reason instanceof Error ? reason.message : String(reason), 'error');
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
    const args = routeEditor.capability === 'setSearchRoute'
      ? [route]
      : [routeEditor.id, route];
    const result = await run(routeEditor.capability, args);
    if (result !== undefined) {
      setRouteEditor(null);
      showDesktopToast(`Saved "${routeEditor.label}" route.`, 'success');
    }
  };
  const renderAgentRow = (agent: AgentSummary) => {
    const Icon = agentIcon(agent.id);
    const row = agents.find((entry) => String(entry.id) === agent.id);
    const route = record(row?.route);
    return <div key={agent.id} className="schedules-row workflows-agent-summary-row"
      {...agentOrder.getReorderProps(agent.id)}>
      <span className="projects-row-icon"><Icon size={16} aria-hidden="true" /></span>
      <button type="button" className="schedules-row-copy projects-row-open"
        title={agent.description || agent.label}
        onClick={() => void openAgentEditor(agent.id, agent.custom)}>
        <b>{agent.label}</b>
        <AgentRouteSummaryView summary={agentRouteSummary(route, models)} />
      </button>
      <button type="button" className="session-panel-action workflows-row-enter" disabled={busy}
        aria-label={t('Edit {{name}}', { name: agent.label })}
        onClick={() => void openAgentEditor(agent.id, agent.custom)}>
        <ChevronRight size={16} aria-hidden="true" />
      </button>
    </div>;
  };

  return <div className="schedules-pane workflows-pane stable-surface-preserved stable-takeover-surface"
    data-surface-active={active ? 'true' : 'false'}
    inert={active ? undefined : true} aria-hidden={active ? undefined : true}>
    <div className="schedules-page workflows-settings-page">
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
        onDelete={() => void deleteAgent(String(record(agentEditor.agent).id || ''))} />}
      {active && routeEditor && <RouteEditorDialog key={`${routeEditor.capability}:${routeEditor.id}`}
        target={routeEditor}
        models={routeEditor.modelKind === 'search' ? searchModels : models}
        busy={busy} error={error}
        onCancel={() => {
          setError('');
          setRouteEditor(null);
        }}
        onSave={(route) => void saveRoute(route)} />}
      {loading ? null : <>
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
          return <div key={id} className="schedules-row" {...workflowOrder.getReorderProps(id)}>
            <span className="projects-row-icon"><Layers3 size={16} aria-hidden="true" /></span>
            <button type="button" className="schedules-row-copy projects-row-open"
              aria-label={t("Edit workflow {{name}}", { name })}
              onClick={() => void openEditor(id, custom)}>
              <b>{name}</b>
              <small>{[workflow.description ? t(String(workflow.description)) : '', custom ? t('Custom') : '']
                .filter(Boolean).join(' · ')}</small>
            </button>
            <button type="button" className="session-panel-action workflows-row-enter" disabled={busy}
              aria-label={t("Edit workflow {{name}}", { name })}
              onClick={() => void openEditor(id, custom)}>
              <ChevronRight size={16} aria-hidden="true" />
            </button>
          </div>;
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
          <div className="schedules-row workflows-agent-summary-row workflows-default-agent-summary-row"
            style={{ order: defaultAgentOrder.orderedIds.indexOf('web-search') }}
            {...defaultAgentOrder.getReorderProps('web-search')}>
            <span className="projects-row-icon"><Globe size={16} aria-hidden="true" /></span>
            <button type="button" className="schedules-row-copy projects-row-open"
              title={t('Use when Mixdog runs the search tool.')}
              onClick={() => setRouteEditor({
                id: 'web-search',
                label: 'Web Search',
                route: searchRoute,
                capability: 'setSearchRoute',
                modelKind: 'search',
                description: 'Use when Mixdog runs the search tool.',
                readOnlyDefinition: true,
              })}>
              <b>{t('Web Search')}</b>
              <AgentRouteSummaryView summary={agentRouteSummary(searchRoute, searchModels)} />
            </button>
            <button type="button" className="session-panel-action workflows-row-enter" disabled={busy}
              aria-label={t('Edit Web Search')}
              onClick={() => setRouteEditor({
                id: 'web-search',
                label: 'Web Search',
                route: searchRoute,
                capability: 'setSearchRoute',
                modelKind: 'search',
                description: 'Use when Mixdog runs the search tool.',
                readOnlyDefinition: true,
              })}>
              <ChevronRight size={16} aria-hidden="true" />
            </button>
          </div>
          {exploreAgent && <div className="schedules-row workflows-agent-summary-row workflows-default-agent-summary-row"
            style={{ order: defaultAgentOrder.orderedIds.indexOf(exploreAgent.id) }}
            {...defaultAgentOrder.getReorderProps(exploreAgent.id)}>
            <span className="projects-row-icon"><Compass size={16} aria-hidden="true" /></span>
            <button type="button" className="schedules-row-copy projects-row-open"
              title={exploreAgent.description || exploreAgent.label}
              onClick={() => setRouteEditor({
                id: exploreAgent.id,
                label: exploreAgent.label,
                route: record(exploreRow?.route),
                capability: 'setAgentRoute',
                modelKind: 'agent',
                description: exploreAgent.description,
                readOnlyDefinition: true,
              })}>
              <b>{exploreAgent.label}</b>
              <AgentRouteSummaryView summary={agentRouteSummary(record(exploreRow?.route), models)} />
            </button>
            <button type="button" className="session-panel-action workflows-row-enter" disabled={busy}
              aria-label={t('Edit {{name}}', { name: exploreAgent.label })}
              onClick={() => setRouteEditor({
                id: exploreAgent.id,
                label: exploreAgent.label,
                route: record(exploreRow?.route),
                capability: 'setAgentRoute',
                modelKind: 'agent',
                description: exploreAgent.description,
                readOnlyDefinition: true,
              })}>
              <ChevronRight size={16} aria-hidden="true" />
            </button>
          </div>}
          {maintainerAgent && <div className="schedules-row workflows-agent-summary-row workflows-default-agent-summary-row"
            style={{ order: defaultAgentOrder.orderedIds.indexOf(maintainerAgent.id) }}
            {...defaultAgentOrder.getReorderProps(maintainerAgent.id)}>
            <span className="projects-row-icon"><Wrench size={16} aria-hidden="true" /></span>
            <button type="button" className="schedules-row-copy projects-row-open"
              title={maintainerAgent.description || maintainerAgent.label}
              onClick={() => setRouteEditor({
                id: maintainerAgent.id,
                label: maintainerAgent.label,
                route: record(maintainerRow?.route),
                capability: 'setAgentRoute',
                modelKind: 'agent',
                description: maintainerAgent.description,
                readOnlyDefinition: true,
              })}>
              <b>{maintainerAgent.label}</b>
              <AgentRouteSummaryView summary={agentRouteSummary(record(maintainerRow?.route), models)} />
            </button>
            <button type="button" className="session-panel-action workflows-row-enter" disabled={busy}
              aria-label={t('Edit {{name}}', { name: maintainerAgent.label })}
              onClick={() => setRouteEditor({
                id: maintainerAgent.id,
                label: maintainerAgent.label,
                route: record(maintainerRow?.route),
                capability: 'setAgentRoute',
                modelKind: 'agent',
                description: maintainerAgent.description,
                readOnlyDefinition: true,
              })}>
              <ChevronRight size={16} aria-hidden="true" />
            </button>
          </div>}
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
    </div>
  </div>;
}
