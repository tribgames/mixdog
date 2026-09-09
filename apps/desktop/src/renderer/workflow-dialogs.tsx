import { X } from 'lucide-react';
import { type FormEvent, useState } from 'react';

import type {
  DesktopCapability,
  DesktopModelOption,
  DesktopModelSelection,
} from '../shared/contract';
import { t } from './i18n';
import { ErrorNotice } from './ErrorNotice';
import { ModelRouteEditor } from './ModelRouteEditor';
import { record } from './record-utils';
import { SidebarDialogLayer } from './sidebar-dialog';
import { CompactSwitch } from './settings/capability-controls';

// Popup editors for the Projects panel's Workflow tab (WorkflowsView): the
// workflow pack, agent definition, and built-in route dialogs. They portal
// to document.body, so the hosting section closes them when it deactivates.
type RecordValue = Record<string, unknown>;

export type RouteEditorTarget = {
  id: string;
  label: string;
  route: RecordValue;
  capability: Extract<DesktopCapability, 'setWebSearchRoute' | 'setAgentRoute'>;
  modelKind: 'webSearch' | 'agent';
  description: string;
  disabled?: boolean;
  readOnlyDefinition: boolean;
};

const NEW_WORKFLOW_BODY = [
  '# New Workflow',
  '',
  'Describe how the Lead runs this workflow: when to delegate to agents,',
  'what each phase must deliver, and how results are verified.',
].join('\n');

const NEW_AGENT_BODY = [
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
export function WorkflowEditorDialog({ pack, deletable, busy, error = '', onCancel, onSave, onDelete }: {
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
  return <SidebarDialogLayer onClose={onCancel}>
    <section className="schedules-dialog workflows-dialog" role="dialog" aria-modal="true" aria-labelledby="workflows-dialog-title">
      <header>
        <h2 id="workflows-dialog-title">{editing ? t('Edit workflow') : t('Create workflow')}</h2>
        <div className="schedules-dialog-header-actions">
          <button type="button" aria-label={t("Close workflow editor")} onClick={onCancel}><X size={16} aria-hidden="true" /></button>
        </div>
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
            <span>{t(delegates ? 'Allow agents' : 'Use no agents')}</span>
            <CompactSwitch label={t('Allow agents')} checked={delegates}
              disabled={busy} onChange={setDelegates} />
          </div>
        </div>
        <label className="schedules-field workflows-md-field"><span data-i18n-skip>WORKFLOW.md</span>
          <small>{t('Instructions that define how this workflow works.')}</small>
          <textarea name="workflow-body" defaultValue={String(pack?.body || (editing ? '' : NEW_WORKFLOW_BODY))}
            required spellCheck={false} disabled={busy} aria-label="WORKFLOW.md body" />
        </label>
        <footer>
          {(formError || error) && <ErrorNotice error={formError || error} />}
          {deletable && <button type="button"
            className={`danger${confirmDelete ? ' confirming' : ''}`} disabled={busy}
            onClick={() => {
              if (!confirmDelete) {
                setConfirmDelete(true);
                return;
              }
              onDelete();
            }}>{confirmDelete ? t('Confirm delete') : t('Delete')}</button>}
          <button type="button" className="secondary" disabled={busy} onClick={onCancel}>{t('Cancel')}</button>
          <button type="submit" disabled={busy}>{t('Save')}</button>
        </footer>
      </form>
    </section>
  </SidebarDialogLayer>;
}

// Agent editor dialog: custom agents are created from name, model, and
// AGENT.md; the runtime derives the internal ID. Editing keeps the existing ID.
export function AgentEditorDialog({ agent, deletable, models, busy, error = '', onCancel, onSave, onToggle, onDelete }: {
  agent: RecordValue | null;
  deletable: boolean;
  models: DesktopModelOption[];
  busy: boolean;
  error?: string;
  onCancel(): void;
  onSave(payload: RecordValue): void;
  onToggle?(enabled: boolean, route: RecordValue): void;
  onDelete(): void;
}) {
  const editing = Boolean(agent);
  const [route, setRoute] = useState<RecordValue>(() => record(agent?.route));
  const [enabled, setEnabled] = useState(() => record(agent).disabled !== true);
  const [formError, setFormError] = useState('');
  const [confirmDelete, setConfirmDelete] = useState(false);
  return <SidebarDialogLayer onClose={onCancel}>
    <section className="schedules-dialog workflows-dialog" role="dialog" aria-modal="true" aria-labelledby="agent-dialog-title">
      <header>
        <h2 id="agent-dialog-title">{editing ? t('Edit agent') : t('Create agent')}</h2>
        <div className="schedules-dialog-header-actions">
          <CompactSwitch label={t('Agent status')} checked={enabled} disabled={busy}
            onChange={(next) => {
              setEnabled(next);
              if (editing) onToggle?.(next, route);
            }} />
          <button type="button" aria-label={t("Close agent editor")} onClick={onCancel}><X size={16} aria-hidden="true" /></button>
        </div>
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
          ...(enabled
            ? (route.provider && route.model ? { route } : {})
            : { route: { disabled: true } }),
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
        {enabled && <div className="schedules-field">
          <span>{t('Model')}</span>
          <small>{t('Model used when this agent runs.')}</small>
          <div className="workflows-dialog-route">
            <RouteControls label={t("Agent model")} route={route} models={models} disabled={busy}
              onChange={(selection) => setRoute(selection as unknown as RecordValue)} />
          </div>
        </div>}
        <label className="schedules-field workflows-md-field"><span data-i18n-skip>AGENT.md</span>
          <small>{t('Instructions that define how this agent works.')}</small>
          <textarea name="agent-body" defaultValue={String(agent?.body || (editing ? '' : NEW_AGENT_BODY))}
            required spellCheck={false} disabled={busy} aria-label="AGENT.md body" />
        </label>
        <footer>
          {(formError || error) && <ErrorNotice error={formError || error} />}
          {deletable && <button type="button"
            className={`danger${confirmDelete ? ' confirming' : ''}`} disabled={busy}
            onClick={() => {
              if (!confirmDelete) {
                setConfirmDelete(true);
                return;
              }
              onDelete();
            }}>{confirmDelete ? t('Confirm delete') : t('Delete')}</button>}
          <button type="button" className="secondary" disabled={busy} onClick={onCancel}>{t('Cancel')}</button>
          <button type="submit" disabled={busy}>{t('Save')}</button>
        </footer>
      </form>
    </section>
  </SidebarDialogLayer>;
}

export function RouteEditorDialog({ target, models, busy, error = '', onCancel, onSave, onToggle }: {
  target: RouteEditorTarget;
  models: DesktopModelOption[];
  busy: boolean;
  error?: string;
  onCancel(): void;
  onSave(route: RecordValue): void;
  onToggle?(enabled: boolean, route: RecordValue): void;
}) {
  const [route, setRoute] = useState<RecordValue>(() => target.route);
  const [enabled, setEnabled] = useState(() => target.disabled !== true);
  const usageEditable = target.modelKind === 'agent';
  return <SidebarDialogLayer onClose={onCancel}>
    <section className="schedules-dialog workflows-dialog workflows-route-dialog" role="dialog" aria-modal="true"
      aria-labelledby="route-dialog-title">
      <header>
        <h2 id="route-dialog-title">{t('Edit {{name}}', { name: t(target.label) })}</h2>
        <div className="schedules-dialog-header-actions">
          {usageEditable && <CompactSwitch label={`${target.label} · ${t('Enabled')}`}
            checked={enabled} disabled={busy} onChange={(next) => {
              setEnabled(next);
              onToggle?.(next, route);
            }} />}
          <button type="button" aria-label={t("Close route editor")} onClick={onCancel}>
            <X size={16} aria-hidden="true" />
          </button>
        </div>
      </header>
      <form onSubmit={(event) => {
        event.preventDefault();
        onSave(usageEditable && !enabled ? { disabled: true } : route);
      }}>
        {/* A built-in definition is read, not edited: its name is the title and
            its usage one sentence of prose — no disabled inputs to scan past
            (user: 팝업 레이아웃 정리). */}
        {target.readOnlyDefinition && <div className="schedules-field">
          <span>{t('When to use')}</span>
          <p className="workflows-route-usage">{t(target.description)}</p>
        </div>}
        {(!usageEditable || enabled) && <div className="schedules-field">
          <span>{t('Model')}</span>
          <small>{t('Model used when this built-in agent runs.')}</small>
          <div className="workflows-dialog-route">
            <RouteControls label={`${target.label} model`} route={route} models={models} disabled={busy}
              onChange={(selection) => setRoute(selection as unknown as RecordValue)} />
          </div>
        </div>}
        <footer>
          {error && <ErrorNotice error={error} />}
          <button type="button" className="secondary" disabled={busy} onClick={onCancel}>{t('Cancel')}</button>
          <button type="submit" disabled={busy}>{t('Save')}</button>
        </footer>
      </form>
    </section>
  </SidebarDialogLayer>;
}
