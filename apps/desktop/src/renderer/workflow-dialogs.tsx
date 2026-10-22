import { X } from 'lucide-react';
import { type FormEvent, useState } from 'react';

import type { DesktopCapability, DesktopModelOption } from '../shared/contract';
import { AgentInstructionEditors } from './agent-instruction-editors';
import { t } from './i18n';
import { RouteChainEditor, routeChainComplete } from './RouteChainEditor';
import { record } from './record-utils';
import { EditorDialogFooter, SidebarDialogLayer } from './sidebar-dialog';
import { CompactSwitch } from './settings/capability-controls';
import type { RecordValue } from './desktop-types';

// Popup editors for the Projects panel's Workflow tab (WorkflowsView): the
// workflow pack, agent definition, and built-in route dialogs. They portal
// to document.body, so the hosting section closes them when it deactivates.

export type RouteEditorTarget = {
  id: string;
  label: string;
  route: RecordValue;
  /** 'setModelRoute' is the Main route's desktop API setter, not a capability. */
  capability: Extract<DesktopCapability, 'setWebSearchRoute' | 'setAgentRoute'> | 'setModelRoute';
  modelKind: 'webSearch' | 'agent' | 'main';
  description: string;
  disabled?: boolean;
  readOnlyDefinition: boolean;
};

const NEW_WORKFLOW_BODY = [
  '# New Workflow',
  '',
  'Describe how the Lead runs this workflow: how the work is approved,',
  'what each phase must deliver, and how results are reviewed and verified.',
].join('\n');

/** The AGENT.md an empty "일하는 방식" saves as: the name as its heading, what
 *  it does, then conversational conduct (the agent talks with the user; it is
 *  not a worker filing reports). The name is required, so the body is never empty. */
export function agentBodyFromBrief(name: string, description: string): string {
  const role = description.trim();
  return [
    `# ${name.trim()}`,
    role,
    [
      `- ${role ? 'Help the user with this role' : 'Help the user'} in a natural, friendly conversation, in the language they write in.`,
      '- Ask a short question when a request is unclear, and say plainly when something is outside what you do.',
      '- Keep replies as short or as detailed as the moment needs.',
    ].join('\n'),
  ]
    .filter(Boolean)
    .join('\n\n');
}

// Reuse the canonical compact route editor so model, effort, and fast mode
// match the existing options surface instead of drifting in a local copy.
function RouteControls({
  label,
  route,
  models,
  disabled,
  composerParity = false,
  fallbacks,
  providerNames,
  onChange,
}: {
  composerParity?: boolean;
  fallbacks?: boolean;
  label: string;
  route: RecordValue;
  models: DesktopModelOption[];
  providerNames?: Record<string, string>;
  disabled: boolean;
  onChange(selection: RecordValue): void;
}) {
  return (
    <div className="workflows-route-controls">
      <RouteChainEditor
        label={label}
        models={models}
        providerNames={providerNames}
        disabled={disabled}
        composerParity={composerParity}
        fallbacks={fallbacks}
        route={route}
        onChange={onChange}
      />
    </div>
  );
}

// Workflow instructions are independent of orchestration and global agents.
export function WorkflowEditorDialog({
  pack,
  deletable,
  busy,
  error = '',
  onCancel,
  onSave,
  onDelete,
  armDelete = false,
}: {
  pack: RecordValue | null;
  deletable: boolean;
  busy: boolean;
  error?: string;
  onCancel(): void;
  onSave(payload: RecordValue): void;
  onDelete(): void;
  armDelete?: boolean;
}) {
  const editing = Boolean(pack);
  const [formError, setFormError] = useState('');
  return (
    <SidebarDialogLayer onClose={onCancel}>
      <section
        className="schedules-dialog workflows-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="workflows-dialog-title"
      >
        <header>
          <h2 id="workflows-dialog-title">{editing ? t('Edit workflow') : t('Create workflow')}</h2>
          <div className="schedules-dialog-header-actions">
            <button type="button" aria-label={t('Close workflow editor')} onClick={onCancel}>
              <X size={16} aria-hidden="true" />
            </button>
          </div>
        </header>
        <form
          onSubmit={(event: FormEvent<HTMLFormElement>) => {
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
              body,
            });
          }}
        >
          <label className="schedules-field">
            <span>{t('Name')}</span>
            <small>{t('Shown in workflow lists and the composer.')}</small>
            <input
              name="workflow-name"
              defaultValue={String(pack?.name || '')}
              placeholder={t('Workflow name')}
              required
              // biome-ignore lint/a11y/noAutofocus: focuses the first field of the dialog when creating
              autoFocus={!editing}
              disabled={busy}
              maxLength={64}
            />
          </label>
          <label className="schedules-field">
            <span>{t('Description')}</span>
            <small>{t('Shown in workflow lists and included in the prompt.')}</small>
            <input
              name="workflow-description"
              defaultValue={String(pack?.description || '')}
              placeholder={t('What this workflow does')}
              disabled={busy}
              maxLength={160}
            />
          </label>
          <label className="schedules-field workflows-md-field">
            <span>WORKFLOW.md</span>
            <small>{t('Instructions that define how this workflow works.')}</small>
            <textarea
              name="workflow-body"
              defaultValue={String(pack?.body || (editing ? '' : NEW_WORKFLOW_BODY))}
              required
              spellCheck={false}
              disabled={busy}
              aria-label="WORKFLOW.md body"
            />
          </label>
          <EditorDialogFooter
            error={formError || error}
            busy={busy}
            onCancel={onCancel}
            onDelete={deletable ? onDelete : undefined}
            armDelete={armDelete}
          />
        </form>
      </section>
    </SidebarDialogLayer>
  );
}

// Agent editor dialog: custom agents are created from name, model, and
// AGENT.md; the runtime derives the internal ID. Editing keeps the existing ID.
export function AgentEditorDialog({
  agent,
  deletable,
  models,
  providerNames,
  busy,
  error = '',
  onCancel,
  onSave,
  onToggle,
  onDelete,
  armDelete = false,
}: {
  agent: RecordValue | null;
  deletable: boolean;
  models: DesktopModelOption[];
  providerNames?: Record<string, string>;
  busy: boolean;
  error?: string;
  onCancel(): void;
  onSave(payload: RecordValue): void;
  onToggle?(enabled: boolean, route: RecordValue): void;
  onDelete(): void;
  armDelete?: boolean;
}) {
  const editing = Boolean(agent);
  const [route, setRoute] = useState<RecordValue>(() => record(agent?.route));
  const [enabled, setEnabled] = useState(() => record(agent).disabled !== true);
  const [formError, setFormError] = useState('');
  const [body, setBody] = useState(() => String(agent?.body || ''));
  const [persona, setPersona] = useState(() => String(agent?.persona || ''));
  // An agent is either off or pinned to a model: switching it on waits for
  // one, and an on agent with an empty model cannot be saved.
  const needsModel = enabled && !routeChainComplete(route);
  return (
    <SidebarDialogLayer onClose={onCancel}>
      <section
        className="schedules-dialog workflows-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="agent-dialog-title"
      >
        <header>
          <h2 id="agent-dialog-title">{editing ? t('Edit agent') : t('Create agent')}</h2>
          <div className="schedules-dialog-header-actions">
            <CompactSwitch
              label={t('Agent status')}
              checked={enabled}
              disabled={busy}
              onChange={(next) => {
                setEnabled(next);
                if (editing && !(next && !(route.provider && route.model))) onToggle?.(next, route);
              }}
            />
            <button type="button" aria-label={t('Close agent editor')} onClick={onCancel}>
              <X size={16} aria-hidden="true" />
            </button>
          </div>
        </header>
        <form
          onSubmit={(event: FormEvent<HTMLFormElement>) => {
            event.preventDefault();
            const data = new FormData(event.currentTarget);
            const text = (name: string) => String(data.get(name) || '').trim();
            setFormError('');
            const picked = route.provider && route.model ? route : null;
            let routeField: { route?: object } = {};
            if (!enabled) routeField = { route: { ...(picked || {}), disabled: true } };
            else if (picked) routeField = { route: picked };
            onSave({
              ...(editing ? { id: String(agent?.id || '') } : {}),
              name: text('agent-name'),
              description: text('agent-description'),
              ...routeField,
              persona: persona.trim(),
              body: body.trim() || agentBodyFromBrief(text('agent-name'), text('agent-description')),
            });
          }}
        >
          <label className="schedules-field">
            <span>{t('Name')}</span>
            <small>{t('Shown in agent lists and delegation menus.')}</small>
            <input
              name="agent-name"
              defaultValue={String(agent?.name || '')}
              placeholder={t('Agent name')}
              required
              // biome-ignore lint/a11y/noAutofocus: focuses the first field of the dialog when creating
              autoFocus={!editing}
              disabled={busy}
              maxLength={64}
            />
          </label>
          <label className="schedules-field">
            <span>{t('When to use')}</span>
            <small>{t('When Mixdog should delegate to this agent.')}</small>
            <input
              name="agent-description"
              defaultValue={String(agent?.description || '')}
              placeholder={t('When Mixdog should use this')}
              disabled={busy}
            />
          </label>
          <div className="schedules-field">
            <div className="workflows-dialog-route">
              <RouteControls
                label={t('Agent model')}
                route={route}
                models={models}
                providerNames={providerNames}
                disabled={busy}
                composerParity
                onChange={(selection) => setRoute(selection as unknown as RecordValue)}
              />
            </div>
          </div>
          <div className="schedules-field workflows-md-field">
            <span>{t('Personality and how it works')}</span>
            <AgentInstructionEditors
              persona={persona}
              body={body}
              disabled={busy}
              onPersona={setPersona}
              onBody={setBody}
            />
          </div>
          <EditorDialogFooter
            error={formError || error}
            busy={busy}
            onCancel={onCancel}
            onDelete={deletable ? onDelete : undefined}
            saveDisabled={needsModel}
            armDelete={armDelete}
          />
        </form>
      </section>
    </SidebarDialogLayer>
  );
}

export function RouteEditorDialog({
  target,
  models,
  providerNames,
  busy,
  error = '',
  onCancel,
  onSave,
  onToggle,
}: {
  target: RouteEditorTarget;
  models: DesktopModelOption[];
  providerNames?: Record<string, string>;
  busy: boolean;
  error?: string;
  onCancel(): void;
  onSave(route: RecordValue): void;
  onToggle?(enabled: boolean, route: RecordValue): void;
}) {
  const [route, setRoute] = useState<RecordValue>(() => target.route);
  const [enabled, setEnabled] = useState(() => target.disabled !== true);
  const usageEditable = target.modelKind === 'agent';
  const routeSet = routeChainComplete(route);
  // Same rule as the agent editor: on means a model, so an empty one blocks
  // both the switch-on write and Save.
  const needsModel = (!usageEditable || enabled) && !routeSet;
  return (
    <SidebarDialogLayer onClose={onCancel}>
      <section
        className="schedules-dialog workflows-dialog workflows-route-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="route-dialog-title"
      >
        <header>
          <h2 id="route-dialog-title">{t('Edit {{name}}', { name: target.label })}</h2>
          <div className="schedules-dialog-header-actions">
            {usageEditable && (
              <CompactSwitch
                label={`${target.label} · ${t('Enabled')}`}
                checked={enabled}
                disabled={busy}
                onChange={(next) => {
                  setEnabled(next);
                  if (!next || routeSet) onToggle?.(next, route);
                }}
              />
            )}
            <button type="button" aria-label={t('Close route editor')} onClick={onCancel}>
              <X size={16} aria-hidden="true" />
            </button>
          </div>
        </header>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            onSave(usageEditable && !enabled ? { disabled: true } : route);
          }}
        >
          {/* A built-in definition is read, not edited: its name is the title and
            its usage one sentence of prose — no disabled inputs to scan past
            (user: 팝업 레이아웃 정리). */}
          {target.readOnlyDefinition && (
            <div className="schedules-field">
              {/* Lead runs every conversation, so it has no "when"; it says what it does. */}
              <span>{target.modelKind === 'main' ? t('What it does') : t('When to use')}</span>
              <small>{target.description}</small>
            </div>
          )}
          <div className="schedules-field">
            <div className="workflows-dialog-route">
              <RouteControls
                label={t('{{name}} model', { name: target.label })}
                route={route}
                models={models}
                providerNames={providerNames}
                disabled={busy}
                composerParity={target.modelKind !== 'webSearch'}
                onChange={(selection) => setRoute(selection as unknown as RecordValue)}
              />
            </div>
          </div>
          <EditorDialogFooter error={error} busy={busy} onCancel={onCancel} saveDisabled={needsModel} />
        </form>
      </section>
    </SidebarDialogLayer>
  );
}
