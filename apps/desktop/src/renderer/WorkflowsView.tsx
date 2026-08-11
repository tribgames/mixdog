import {
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
import { FastModeIndicator } from './FastModeToggle';
import { t } from './i18n';
import { filterConfiguredModels } from './ModelPicker';
import { dismissDesktopToast, showDesktopToast } from './notifications';
import { RowOverflowMenu } from './RowOverflowMenu';
import { modelDisplayName, normalizeModelOptions } from './provider-display';
import { useSidebarPanelDismiss } from './sidebar-panel-surface';
import {
  useSidebarReferences,
  type SidebarReferenceKey,
} from './sidebar-reference-cache';
import {
  preferredEffort,
  RouteEditor,
  routeOption,
} from './settings/capability-controls';
import { acquireTitleBarDim } from './titlebar-dim';

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
  label: string;
  fast: boolean;
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
  const effortLabel = rawEffortLabel
    ? `${rawEffortLabel.slice(0, 1).toLocaleUpperCase()}${rawEffortLabel.slice(1)}`
    : '';
  const fastCapable = selected?.fastCapable === true || typeof route.fast === 'boolean';
  const fast = typeof route.fast === 'boolean' ? route.fast : selected?.fastPreferred === true;
  return {
    label: [modelLabel, effortLabel].filter(Boolean).join(' · '),
    fast: fastCapable && fast,
  };
}

function AgentRouteSummaryView({ summary }: { summary: AgentRouteSummary }) {
  return <small className="agent-route-summary">
    <span>{summary.label}</span>
    {summary.fast && <FastModeIndicator />}
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
    <RouteEditor title={label} route={route} models={models} disabled={disabled} compact onChange={onChange} />
  </div>;
}

// Popup editor (schedules-dialog grammar): name/description, delegation
// on/off, and the WORKFLOW.md body. `pack` null means create. Agents are
// global — packs no longer carry a roster.
function WorkflowEditorDialog({ pack, busy, error = '', onCancel, onSave }: {
  pack: RecordValue | null;
  busy: boolean;
  error?: string;
  onCancel(): void;
  onSave(payload: RecordValue): void;
}) {
  const editing = Boolean(pack);
  // ONE agent-related setting per pack: delegates (every defined agent is
  // available) or not (Solo-style, `delegation: none`).
  const [delegates, setDelegates] = useState(() => !editing || pack?.delegatesAgents !== false);
  const [formError, setFormError] = useState('');
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
        <label className="schedules-field">{t('Name')}
          <input name="workflow-name" defaultValue={String(pack?.name || '')}
            placeholder={t("Workflow name")} required autoFocus={!editing} disabled={busy} maxLength={64} />
        </label>
        <label className="schedules-field">{t('Description')}
          <input name="workflow-description" defaultValue={String(pack?.description || '')}
            placeholder={t("One-line summary")} disabled={busy} maxLength={160} />
        </label>
        <div className="schedules-field">
          <span>{t('Agents')}</span>
          <div className="workflows-agent-list">
            <div className="workflows-agent-empty-row">
              <p className="workflows-agent-empty">{delegates
                ? t('Every defined agent is available to this workflow.')
                : t('No agents — this workflow delegates to none.')}</p>
              <button type="button" className="workflows-agent-mode" disabled={busy}
                onClick={() => setDelegates((current) => !current)}>
                {delegates ? t('Use no agents') : t('Allow agents')}
              </button>
            </div>
          </div>
        </div>
        <label className="schedules-field workflows-md-field">WORKFLOW.md
          <textarea name="workflow-body" defaultValue={String(pack?.body || (editing ? '' : NEW_WORKFLOW_BODY))}
            required spellCheck={false} disabled={busy} aria-label="WORKFLOW.md body" />
        </label>
        <footer>
          {(formError || error) && <p className="schedules-form-error" role="alert">{formError || error}</p>}
          <button type="button" disabled={busy} onClick={onCancel}>{t('Cancel')}</button>
          <button type="submit" disabled={busy}>{t('Save')}</button>
        </footer>
      </form>
    </section>
  </div>, document.body);
}

// Agent editor dialog: custom agents are created from name, model, and
// AGENT.md; the runtime derives the internal ID. Editing keeps the existing ID.
function AgentEditorDialog({ agent, models, busy, error = '', onCancel, onSave }: {
  agent: RecordValue | null;
  models: DesktopModelOption[];
  busy: boolean;
  error?: string;
  onCancel(): void;
  onSave(payload: RecordValue): void;
}) {
  const editing = Boolean(agent);
  const [route, setRoute] = useState<RecordValue>(() => record(agent?.route));
  const [formError, setFormError] = useState('');
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
        <label className="schedules-field">{t('Name')}
          <input name="agent-name" defaultValue={String(agent?.name || '')}
            placeholder={t("Agent name")} required autoFocus={!editing} disabled={busy} maxLength={64} />
        </label>
        <label className="schedules-field">{t('Description')}
          <input name="agent-description" defaultValue={String(agent?.description || '')}
            placeholder={t("One-line summary")} disabled={busy} maxLength={160} />
        </label>
        <div className="schedules-field">
          <span>{t('Model')}</span>
          <div className="workflows-dialog-route">
            <RouteControls label={t("Agent model")} route={route} models={models} disabled={busy}
              onChange={(selection) => setRoute(selection as unknown as RecordValue)} />
          </div>
        </div>
        <label className="schedules-field workflows-md-field">AGENT.md
          <textarea name="agent-body" defaultValue={String(agent?.body || (editing ? '' : NEW_AGENT_BODY))}
            required spellCheck={false} disabled={busy} aria-label="AGENT.md body" />
        </label>
        <footer>
          {(formError || error) && <p className="schedules-form-error" role="alert">{formError || error}</p>}
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
          <div className="schedules-field workflows-readonly-field">
            <div className="workflows-readonly-label">
              <span>{t('Name')}</span><small>{t('Read-only')}</small>
            </div>
            <p className="workflows-readonly-value">{target.label}</p>
          </div>
          <div className="schedules-field workflows-readonly-field">
            <div className="workflows-readonly-label">
              <span>{t('Description')}</span><small>{t('Read-only')}</small>
            </div>
            <p className="workflows-readonly-value">{target.description}</p>
          </div>
        </>}
        <div className="schedules-field">
          <span>{t('Model')}</span>
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

function AgentDeleteDialog({ target, busy, error = '', onCancel, onDelete }: {
  target: { id: string; label: string };
  busy: boolean;
  error?: string;
  onCancel(): void;
  onDelete(): void;
}) {
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
    <section className="schedules-dialog workflows-dialog workflows-delete-dialog"
      role="dialog" aria-modal="true" aria-labelledby="agent-delete-dialog-title">
      <header>
        <h2 id="agent-delete-dialog-title">{t('Delete agent')}</h2>
        <button type="button" aria-label={t("Close agent delete dialog")} onClick={onCancel}>
          <X size={16} aria-hidden="true" />
        </button>
      </header>
      <div className="workflows-delete-dialog-body">
        <p>{t('Delete {{name}} permanently? This cannot be undone.', { name: target.label })}</p>
      </div>
      <footer>
        {error && <p className="schedules-form-error" role="alert">{error}</p>}
        <button type="button" disabled={busy} onClick={onCancel}>{t('Cancel')}</button>
        <button type="button" className="danger" disabled={busy} onClick={onDelete}>{t('Delete')}</button>
      </footer>
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
  const [editor, setEditor] = useState<{ pack: RecordValue | null } | null>(null);
  const [agentEditor, setAgentEditor] = useState<{ agent: RecordValue | null } | null>(null);
  const [routeEditor, setRouteEditor] = useState<RouteEditorTarget | null>(null);
  const [agentDeleteTarget, setAgentDeleteTarget] =
    useState<{ id: string; label: string } | null>(null);
  const [confirmingDelete, setConfirmingDelete] = useState('');
  // Both editors portal to document.body, outside the sidebar's inert box:
  // deactivating the panel closes them and disarms pending deletions, while
  // the workflow/agent lists keep their state.
  useSidebarPanelDismiss(active, () => {
    setEditor(null);
    setAgentEditor(null);
    setRouteEditor(null);
    setAgentDeleteTarget(null);
    setConfirmingDelete('');
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

  const openEditor = async (id: string) => {
    if (!api?.invokeCapability) return;
    setConfirmingDelete('');
    try {
      const result = await api.invokeCapability<RecordValue>({ capability: 'getWorkflowPack', args: [id] });
      setError('');
      setEditor({ pack: record(result?.value) });
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
    const result = await run('deleteWorkflow', [id], 'toast');
    if (result !== undefined) {
      showDesktopToast(record(result).revertedToBuiltIn === true
        ? `"${id}" reverted to the built-in pack.`
        : `Deleted "${id}".`, 'success');
    }
  };
  const agentRoster = useMemo<AgentSummary[]>(() => agents.map((agent) => ({
    id: String(agent.id || ''),
    label: String(agent.label || record(agent.definition).name || agent.id || ''),
    description: String(agent.description || record(agent.definition).description || ''),
    custom: agent.custom === true,
    userOverride: agent.userOverride === true,
  })).filter((agent) => agent.id), [agents]);
  const maintainerAgent = agentRoster.find((agent) => agent.id === 'maintainer');
  const maintainerRow = agents.find((agent) => String(agent.id || '') === 'maintainer');
  const exploreAgent = agentRoster.find((agent) => agent.id === 'explore');
  const exploreRow = agents.find((agent) => String(agent.id || '') === 'explore');
  const editableAgents = agentRoster.filter((agent) => !DEFAULT_AGENT_IDS.has(agent.id));
  const openAgentEditor = async (id: string) => {
    if (!api?.invokeCapability) return;
    try {
      const result = await api.invokeCapability<RecordValue>({ capability: 'getAgentDefinition', args: [id] });
      setError('');
      setAgentEditor({ agent: record(result?.value) });
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
      setAgentDeleteTarget(null);
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
    return <div key={agent.id} className="schedules-row workflows-agent-summary-row">
      <span className="projects-row-icon"><Icon size={16} aria-hidden="true" /></span>
      <div className="schedules-row-copy" title={agent.description || agent.label}>
        <b>{agent.label}</b>
        <AgentRouteSummaryView summary={agentRouteSummary(route, models)} />
      </div>
      <RowOverflowMenu label={`Actions for ${agent.label}`} items={[
        { id: 'edit', label: 'Edit', disabled: busy, onSelect: () => void openAgentEditor(agent.id) },
        // Fixed services are protected. Starter and user-authored custom roles
        // expose Delete; agents are global, so no workflow bookkeeping is needed.
        ...(agent.custom ? [{
          id: 'delete',
          label: 'Delete',
          disabled: busy,
          danger: true,
          onSelect: () => {
            setError('');
            setAgentDeleteTarget({ id: agent.id, label: agent.label });
          },
        }] : []),
      ]} />
    </div>;
  };

  return <div className="schedules-pane workflows-pane stable-surface-preserved stable-takeover-surface"
    data-surface-active={active ? 'true' : 'false'}
    inert={active ? undefined : true} aria-hidden={active ? undefined : true}>
    <div className="schedules-page workflows-settings-page">
      {active && editor && <WorkflowEditorDialog key={String(record(editor.pack).id || '(new)')}
        pack={editor.pack} busy={busy} error={error}
        onCancel={() => {
          setError('');
          setEditor(null);
        }} onSave={(payload) => void saveWorkflow(payload)} />}
      {active && agentEditor && <AgentEditorDialog key={String(record(agentEditor.agent).id || '(new-agent)')}
        agent={agentEditor.agent} models={models} busy={busy} error={error}
        onCancel={() => {
          setError('');
          setAgentEditor(null);
        }} onSave={(payload) => void saveAgent(payload)} />}
      {active && routeEditor && <RouteEditorDialog key={`${routeEditor.capability}:${routeEditor.id}`}
        target={routeEditor}
        models={routeEditor.modelKind === 'search' ? searchModels : models}
        busy={busy} error={error}
        onCancel={() => {
          setError('');
          setRouteEditor(null);
        }}
        onSave={(route) => void saveRoute(route)} />}
      {active && agentDeleteTarget && <AgentDeleteDialog target={agentDeleteTarget}
        busy={busy} error={error}
        onCancel={() => {
          setError('');
          setAgentDeleteTarget(null);
        }}
        onDelete={() => void deleteAgent(agentDeleteTarget.id)} />}
      <section className="workflows-models workflows-packs" aria-label={t("Workflows")}>
      <div className="workflows-section-head">
        <h2>{t('Workflows')}</h2>
        <button type="button" className="session-panel-action schedules-new" disabled={busy}
          aria-label={t("New workflow")} data-tooltip={t("New workflow")}
          onClick={() => {
            setError('');
            setEditor({ pack: null });
          }}>
          <Plus size={16} aria-hidden="true" />
        </button>
      </div>
      {loading ? null
        : workflows.length ? <div className="schedules-list">{workflows.map((workflow) => {
          const id = String(workflow.id || '');
          const name = String(workflow.name || id);
          const custom = String(workflow.source || '') === 'user';
          return <div key={id} className="schedules-row">
            <span className="projects-row-icon"><Layers3 size={16} aria-hidden="true" /></span>
            <button type="button" className="schedules-row-copy projects-row-open"
              aria-label={t("Edit workflow {{name}}", { name })}
              onClick={() => void openEditor(id)}>
              <b>{name}</b>
              <small>{[String(workflow.description || ''), custom ? 'Custom' : '']
                .filter(Boolean).join(' · ')}</small>
            </button>
            <RowOverflowMenu label={`Actions for ${name}`} items={[
              { id: 'edit', label: 'Edit', disabled: busy, onSelect: () => void openEditor(id) },
              ...(custom ? [{
                id: 'delete',
                label: confirmingDelete === id ? 'Confirm delete' : 'Delete',
                disabled: busy,
                danger: true,
                closeOnSelect: confirmingDelete === id,
                onSelect: () => {
                  if (confirmingDelete !== id) {
                    setConfirmingDelete(id);
                    return;
                  }
                  setConfirmingDelete('');
                  void deleteWorkflowPack(id);
                },
              }] : []),
            ]} />
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
          <div className="schedules-row workflows-agent-summary-row workflows-default-agent-summary-row">
            <span className="projects-row-icon"><Globe size={16} aria-hidden="true" /></span>
            <div className="schedules-row-copy" title="Search-tool requests">
              <b>{t('Web search')}</b>
              <AgentRouteSummaryView summary={agentRouteSummary(searchRoute, searchModels)} />
            </div>
            <RowOverflowMenu label="Actions for Web search" items={[{
              id: 'edit',
              label: 'Edit',
              disabled: busy,
              onSelect: () => setRouteEditor({
                id: 'web-search',
                label: 'Web search',
                route: searchRoute,
                capability: 'setSearchRoute',
                modelKind: 'search',
                description: 'Search-tool requests',
                readOnlyDefinition: true,
              }),
            }]} />
          </div>
          {exploreAgent && <div className="schedules-row workflows-agent-summary-row workflows-default-agent-summary-row">
            <span className="projects-row-icon"><Compass size={16} aria-hidden="true" /></span>
            <div className="schedules-row-copy" title={exploreAgent.description || exploreAgent.label}>
              <b>{exploreAgent.label}</b>
              <AgentRouteSummaryView summary={agentRouteSummary(record(exploreRow?.route), models)} />
            </div>
            <RowOverflowMenu label={`Actions for ${exploreAgent.label}`} items={[{
              id: 'edit',
              label: 'Edit',
              disabled: busy,
              onSelect: () => setRouteEditor({
                id: exploreAgent.id,
                label: exploreAgent.label,
                route: record(exploreRow?.route),
                capability: 'setAgentRoute',
                modelKind: 'agent',
                description: exploreAgent.description,
                readOnlyDefinition: true,
              }),
            }]} />
          </div>}
          {maintainerAgent && <div className="schedules-row workflows-agent-summary-row workflows-default-agent-summary-row">
            <span className="projects-row-icon"><Wrench size={16} aria-hidden="true" /></span>
            <div className="schedules-row-copy" title={maintainerAgent.description || maintainerAgent.label}>
              <b>{maintainerAgent.label}</b>
              <AgentRouteSummaryView summary={agentRouteSummary(record(maintainerRow?.route), models)} />
            </div>
            <RowOverflowMenu label={`Actions for ${maintainerAgent.label}`} items={[{
              id: 'edit',
              label: 'Edit',
              disabled: busy,
              onSelect: () => setRouteEditor({
                id: maintainerAgent.id,
                label: maintainerAgent.label,
                route: record(maintainerRow?.route),
                capability: 'setAgentRoute',
                modelKind: 'agent',
                description: maintainerAgent.description,
                readOnlyDefinition: true,
              }),
            }]} />
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
              setAgentEditor({ agent: null });
            }}>
            <Plus size={16} aria-hidden="true" />
          </button>
        </div>
            <p>{t('Starter and custom roles with editable definitions and models.')}</p>
        <div className="schedules-list">
          {editableAgents.map(renderAgentRow)}
        </div>
      </section>
    </div>
  </div>;
}
