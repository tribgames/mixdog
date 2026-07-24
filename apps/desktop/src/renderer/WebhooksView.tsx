import React, { type FormEvent, useCallback, useEffect, useRef, useState } from 'react';
import { Check, Copy, Plus, Search, Webhook, X } from 'lucide-react';

import type { DesktopApi, DesktopCapability, DesktopModelOption, DesktopProjectSummary } from '../shared/contract';
import { OpenSelect } from './OpenSelect';
import { ModelPicker } from './ModelPicker';
import { modelDisplayName } from './provider-display';
import { copyTextToClipboard } from './text-format';
import {
  AutomationAttachButton,
  AutomationAttachmentChips,
  attachmentsFromRecords,
  type AutomationAttachment,
} from './automation-attachments';

type RecordValue = Record<string, unknown>;
export type WebhooksApi = Partial<Pick<DesktopApi, 'invokeCapability' | 'listProviderModels' | 'listProjects'>>;

const PARSER_OPTIONS = [
  { value: 'generic', label: 'Generic JSON' },
  { value: 'github', label: 'GitHub' },
  { value: 'stripe', label: 'Stripe' },
  { value: 'sentry', label: 'Sentry' },
];

function record(value: unknown): RecordValue {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as RecordValue : {};
}

function rows(value: unknown): RecordValue[] {
  return Array.isArray(value) ? value.map(record) : [];
}

// webhook.model wire format matches schedules: "provider/model[@effort][+fast]".
function parseModelRef(ref: string): { route: string; effort: string; fast: boolean } {
  let route = String(ref || '');
  let fast = false;
  if (route.endsWith('+fast')) {
    fast = true;
    route = route.slice(0, -5);
  }
  let effort = '';
  const slash = route.indexOf('/');
  if (slash > 0) {
    const at = route.lastIndexOf('@');
    if (at > slash) {
      effort = route.slice(at + 1);
      route = route.slice(0, at);
    }
  }
  return { route, effort, fast };
}

function preferredEffort(option?: DesktopModelOption): string {
  if (!option?.effortOptions.length) return '';
  if (option.savedEffort && option.effortOptions.some((entry) => entry.value === option.savedEffort)) {
    return option.savedEffort;
  }
  for (const value of ['high', 'medium', 'low', 'none', 'xhigh', 'max', 'ultra']) {
    if (option.effortOptions.some((entry) => entry.value === value)) return value;
  }
  return option.effortOptions[0]?.value || '';
}

interface WebhookDraft {
  name: string;
  description: string;
  parser: string;
  model: string;
  cwd: string;
  workflow: string;
  attachments: AutomationAttachment[];
  instructions: string;
  enabled: boolean;
}

function webhookDraft(webhook: RecordValue | undefined): WebhookDraft {
  const source = record(webhook);
  return {
    name: String(source.name || ''),
    description: String(source.description || ''),
    parser: String(source.parser || 'generic'),
    model: String(source.model || ''),
    cwd: String(source.cwd || ''),
    // New-task parity: an automation always carries a workflow; legacy rows
    // without one edit as the Default pack.
    workflow: String(source.workflow || 'default'),
    attachments: attachmentsFromRecords(source.attachments),
    instructions: String(source.instructions || ''),
    enabled: source.enabled !== false,
  };
}

// Sub-line: parser first, then delivery route, model, and paused state.
function webhookMeta(webhook: RecordValue): string {
  const parts = [String(webhook.parser || 'github')];
  parts.push(webhook.channel ? `channel ${String(webhook.channel)}` : 'session');
  const ref = parseModelRef(String(webhook.model || ''));
  if (ref.route) {
    const slash = ref.route.indexOf('/');
    parts.push(slash > 0 ? modelDisplayName(ref.route.slice(slash + 1), ref.route.slice(0, slash)) : ref.route);
  }
  if (webhook.secretSet !== true) parts.push('secret missing');
  if (webhook.enabled === false) parts.push('paused');
  return parts.filter(Boolean).join(' · ');
}

function endpointUrl(publicBase: string, name: string): string {
  return publicBase ? `${publicBase.replace(/\/+$/, '')}/webhook/${encodeURIComponent(name)}` : '';
}

// Client-side secret mint for NEW webhooks: showing the value (with copy)
// inside the editor beats the old one-shot post-save reveal. Same shape as
// the store's randomBytes(24) hex.
function generateSigningSecret(): string {
  const bytes = new Uint8Array(24);
  try {
    crypto.getRandomValues(bytes);
  } catch {
    for (let index = 0; index < bytes.length; index += 1) bytes[index] = Math.floor(Math.random() * 256);
  }
  return Array.from(bytes, (value) => value.toString(16).padStart(2, '0')).join('');
}

function ConnectionRow({ label, value, placeholder, copied, onCopy }: {
  label: string;
  value: string;
  placeholder: string;
  copied: boolean;
  onCopy(): void;
}) {
  return <div className="schedules-field webhook-connection-row">
    <span>{label}</span>
    <div className="webhook-connection-value">
      <code>{value || placeholder}</code>
      {/* Icon-only copy (user decision): the value itself is the label. */}
      <button type="button" className="icon-button webhook-connection-copy" disabled={!value} onClick={onCopy}
        aria-label={`Copy ${label.toLowerCase()}`} data-tooltip={`Copy ${label.toLowerCase()}`}>
        {copied ? <Check size={14} aria-hidden="true" /> : <Copy size={14} aria-hidden="true" />}
      </button>
    </div>
  </div>;
}

function WebhookEditor({ draft, editing, busy, models, projects, workflows, publicBase, secret, error = '', onCancel, onSave }: {
  draft: WebhookDraft;
  editing: boolean;
  busy: boolean;
  models: DesktopModelOption[];
  projects: DesktopProjectSummary[];
  workflows: Array<{ value: string; label: string }>;
  publicBase: string;
  secret: string;
  error?: string;
  onCancel(): void;
  onSave(entry: RecordValue): void;
}) {
  const [parser, setParser] = useState(draft.parser);
  const [cwd, setCwd] = useState(draft.cwd);
  const [workflow, setWorkflow] = useState(draft.workflow);
  const [attachments, setAttachments] = useState<AutomationAttachment[]>(draft.attachments);
  // EDIT never reveals the stored secret; rotation mints a replacement that
  // only persists on Save (user decision).
  const [rotated, setRotated] = useState('');
  // Uncontrolled name input + shadow state so the endpoint URL previews live
  // while typing (FormData still reads the input on submit).
  const [urlName, setUrlName] = useState(draft.name);
  const [copiedField, setCopiedField] = useState('');
  const copiedFieldTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => {
    if (copiedFieldTimer.current) clearTimeout(copiedFieldTimer.current);
  }, []);
  const copyField = (field: string, value: string) => {
    void copyTextToClipboard(value);
    setCopiedField(field);
    if (copiedFieldTimer.current) clearTimeout(copiedFieldTimer.current);
    copiedFieldTimer.current = setTimeout(() => setCopiedField(''), 1600);
  };
  const previewUrl = urlName.trim() ? endpointUrl(publicBase, urlName.trim()) : '';
  const initialModel = parseModelRef(draft.model);
  const [model, setModel] = useState(initialModel.route);
  const [effort, setEffort] = useState(initialModel.effort);
  const [fast, setFast] = useState(initialModel.fast);
  const [formError, setFormError] = useState('');
  const slash = model.indexOf('/');
  const modelProvider = slash > 0 ? model.slice(0, slash) : '';
  const modelId = slash > 0 ? model.slice(slash + 1) : '';
  const modelLabel = model ? (slash > 0 ? modelDisplayName(modelId, modelProvider) : model) : 'Model';
  const selected = models.find((option) => option.provider === modelProvider && option.model === modelId);
  const effortValue = selected?.effortOptions.some((entry) => entry.value === effort)
    ? effort
    : preferredEffort(selected);
  const projectOptions = [
    { value: '__none__', label: 'No project' },
    ...projects.map((project) => ({
      value: project.path,
      label: project.alias?.trim() || project.name?.trim() || project.path,
    })),
  ];
  if (cwd && !projectOptions.some((option) => option.value === cwd)) {
    projectOptions.push({ value: cwd, label: cwd });
  }
  return <div className="schedules-dialog-layer"
    onMouseDown={(event) => { if (event.target === event.currentTarget) onCancel(); }}
    onKeyDown={(event) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        onCancel();
      }
    }}>
    <section className="schedules-dialog" role="dialog" aria-modal="true" aria-labelledby="webhooks-dialog-title">
      <header>
        <h2 id="webhooks-dialog-title">{editing ? 'Edit webhook' : 'Create webhook'}</h2>
        <button type="button" aria-label="Close webhook editor" onClick={onCancel}><X size={15} aria-hidden="true" /></button>
      </header>
      <form onSubmit={(event: FormEvent<HTMLFormElement>) => {
        event.preventDefault();
        const data = new FormData(event.currentTarget);
        const text = (name: string) => String(data.get(name) || '').trim();
        setFormError('');
        const effortSuffix = selected && effortValue ? `@${effortValue}` : '';
        const fastSuffix = selected?.fastCapable && fast ? '+fast' : '';
        // A NEW webhook persists the displayed pre-minted secret; an EDIT
        // sends a secret only after an explicit Regenerate (the store
        // preserves the existing secret on plain overwrite).
        const effectiveSecret = editing ? rotated : secret;
        onSave({
          name: editing ? draft.name : text('webhook-name'),
          description: draft.description,
          parser,
          // Session-only delivery (user decision, schedules parity): every
          // webhook fire runs as a fresh New-task session — no channel
          // target, so saving a legacy channel webhook converts it.
          ...(model ? { model: `${model}${effortSuffix}${fastSuffix}` } : {}),
          ...(cwd ? { cwd } : {}),
          ...(workflow ? { workflow } : {}),
          ...(attachments.length ? { attachments } : {}),
          ...(effectiveSecret ? { secret: effectiveSecret } : {}),
          instructions: text('webhook-instructions'),
          enabled: draft.enabled,
          ...(editing ? { overwrite: true } : {}),
        });
      }}>
        <label className="schedules-field">Name
          <input name="webhook-name" defaultValue={draft.name} placeholder="github-issues" required autoFocus
            disabled={busy || editing} maxLength={64}
            onChange={(event) => setUrlName(event.currentTarget.value)} />
        </label>
        {/* Delivery/payload format lives OUTSIDE the composer as its own
            labeled field (user decision). */}
        <div className="schedules-field">
          <span>Payload format</span>
          <div className="schedules-frequency">
            <OpenSelect ariaLabel="Webhook payload format" value={parser} disabled={busy}
              options={PARSER_OPTIONS} onChange={setParser} />
          </div>
        </div>
        {/* Project mirrors the Payload format grammar: a labeled field with
            the same select style (user decision). */}
        <div className="schedules-field">
          <span>Project</span>
          <div className="schedules-frequency">
            <OpenSelect ariaLabel="Webhook project" value={cwd || '__none__'} disabled={busy}
              options={projectOptions} onChange={(next) => setCwd(next === '__none__' ? '' : next)} />
          </div>
        </div>
        <div className="schedules-composer">
          <textarea name="webhook-instructions" defaultValue={draft.instructions} required disabled={busy}
            placeholder="What should Mixdog do when this webhook fires?" aria-label="Webhook instructions" />
          <AutomationAttachmentChips attachments={attachments} disabled={busy} onChange={setAttachments} />
          <div className="composer-footer schedules-composer-footer">
            <AutomationAttachButton attachments={attachments} disabled={busy}
              ariaLabel="Attach files to this webhook"
              onChange={setAttachments} onError={setFormError} />
            <ModelPicker models={models} provider={modelProvider} model={modelId}
              triggerLabel={modelLabel} ariaLabel="Webhook model"
              triggerClassName="model-trigger schedules-model-trigger" disabled={busy}
              onSelect={(option) => {
                setModel(`${option.provider}/${option.model}`);
                setEffort(preferredEffort(option));
                setFast(option.fastCapable ? option.fastPreferred : false);
                setFormError('');
              }} />
            {selected && selected.effortOptions.length > 0 && <OpenSelect ariaLabel="Webhook reasoning effort"
              value={effortValue} disabled={busy} options={selected.effortOptions} onChange={setEffort} />}
            {selected?.fastCapable && <OpenSelect ariaLabel="Webhook fast mode"
              value={fast ? 'on' : 'off'} disabled={busy}
              options={[{ value: 'on', label: 'Fast On' }, { value: 'off', label: 'Fast Off' }]}
              onChange={(value) => setFast(value === 'on')} />}
            {/* Same flat, right-aligned workflow control as the chat
                composer (effort-control/workflow-control skin). */}
            <div className="effort-control workflow-control">
              <OpenSelect ariaLabel="Webhook workflow" value={workflow} disabled={busy}
                options={workflows.length ? workflows : [{ value: 'default', label: 'Default' }]}
                onChange={setWorkflow} />
            </div>
          </div>
        </div>
        {/* Connection details (user decision): the endpoint URL stays
            visible; the signing secret shows only when freshly minted —
            create pre-mints it, edit offers Regenerate instead. */}
        <div className="webhook-connection" aria-label="Connection details">
          <ConnectionRow label="Endpoint URL"
            value={editing ? endpointUrl(publicBase, draft.name) : previewUrl}
            placeholder={publicBase
              ? 'Type a name to preview the endpoint URL'
              : 'URL appears once the runtime connects to the relay'}
            copied={copiedField === 'url'}
            onCopy={() => copyField('url', editing ? endpointUrl(publicBase, draft.name) : previewUrl)} />
          {editing && !rotated
            ? <div className="schedules-field webhook-connection-row">
              <span>Signing secret</span>
              <div className="webhook-connection-value">
                <button type="button" className="settings-action" disabled={busy}
                  onClick={() => setRotated(generateSigningSecret())}>Regenerate secret</button>
              </div>
            </div>
            : <ConnectionRow label="Signing secret" value={editing ? rotated : secret}
              placeholder="Secret unavailable"
              copied={copiedField === 'secret'}
              onCopy={() => copyField('secret', editing ? rotated : secret)} />}
        </div>
        <footer>
          {(formError || error) && <p className="schedules-form-error" role="alert">{formError || error}</p>}
          <button type="button" disabled={busy} onClick={onCancel}>Cancel</button>
          <button type="submit" disabled={busy}>Save</button>
        </footer>
      </form>
    </section>
  </div>;
}

// Inbound-webhooks page (sidebar -> Webhooks): the Schedules-page grammar —
// a main-pane list with search, active/paused filters, and a popup editor.
export function WebhooksPane({ api = window.mixdogDesktop, active = true }: {
  api?: WebhooksApi;
  active?: boolean;
}) {
  const [setup, setSetup] = useState<RecordValue>({});
  const [models, setModels] = useState<DesktopModelOption[]>([]);
  const [projects, setProjects] = useState<DesktopProjectSummary[]>([]);
  const [workflows, setWorkflows] = useState<Array<{ value: string; label: string }>>([]);
  const [loading, setLoading] = useState(true);
  const [pending, setPending] = useState('');
  const [error, setError] = useState('');
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<'all' | 'active' | 'paused'>('all');
  const [editor, setEditor] = useState<{ name: string; draft: WebhookDraft; secret: string } | null>(null);
  const [confirmingDelete, setConfirmingDelete] = useState('');
  const loadSequence = useRef(0);

  const load = useCallback(async () => {
    if (!api?.invokeCapability) {
      setLoading(false);
      return;
    }
    const sequence = ++loadSequence.current;
    try {
      const [setupResult, modelRows, projectRows, workflowRows] = await Promise.all([
        api.invokeCapability({ capability: 'getChannelSetup', args: [] }),
        api.listProviderModels ? api.listProviderModels({ quick: true }).catch(() => []) : Promise.resolve([]),
        api.listProjects ? api.listProjects().catch(() => []) : Promise.resolve([]),
        api.invokeCapability({ capability: 'listWorkflows', args: [] }).catch(() => null),
      ]);
      if (sequence !== loadSequence.current) return;
      setSetup(record(setupResult?.value));
      setModels(Array.isArray(modelRows) ? modelRows : []);
      setProjects(Array.isArray(projectRows) ? projectRows : []);
      setWorkflows(rows(workflowRows?.value)
        .map((row) => ({ value: String(row.id || ''), label: String(row.name || row.id || '') }))
        .filter((option) => option.value));
      setError('');
    } catch (reason) {
      if (sequence !== loadSequence.current) return;
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      if (sequence === loadSequence.current) setLoading(false);
    }
  }, [api]);
  useEffect(() => {
    if (active) void load();
    return () => { loadSequence.current += 1; };
  }, [active, load]);

  const busy = Boolean(pending) || loading;
  const run = async (capability: DesktopCapability, args: unknown[] = []): Promise<unknown> => {
    if (!api?.invokeCapability || pending) return undefined;
    setPending(capability);
    setError('');
    try {
      const result = await api.invokeCapability({ capability, args });
      await load();
      return result?.value ?? true;
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
      return undefined;
    } finally {
      setPending('');
    }
  };

  const webhooks = rows(setup.webhooks);
  const publicBase = String(record(setup.webhook).publicUrl || '');
  const text = query.trim().toLowerCase();
  const visible = webhooks.filter((webhook) => {
    const enabled = webhook.enabled !== false;
    if (filter === 'active' && !enabled) return false;
    if (filter === 'paused' && enabled) return false;
    if (!text) return true;
    return [webhook.name, webhook.description, webhook.parser, webhook.model, webhook.channel]
      .map((value) => String(value || '').toLowerCase()).join(' ').includes(text);
  });
  const saveWebhook = async (entry: RecordValue) => {
    const result = await run('saveWebhook', [entry]);
    if (result === undefined) return;
    setEditor(null);
  };
  // Edit never reads the stored secret (user decision): rotation via the
  // editor's Regenerate button is the only way to obtain a copyable value.
  const openEditor = (name: string, draft: WebhookDraft) => {
    setConfirmingDelete('');
    setError('');
    setEditor({ name, draft, secret: '' });
  };

  return <div className="schedules-pane" style={active ? undefined : { display: 'none' }}>
    <div className="schedules-page">
      <header className="schedules-page-header">
        <div>
          <h1>Webhooks</h1>
          <p>Trigger prompts from external services through the relay tunnel.</p>
        </div>
        <button type="button" className="settings-action schedules-new" disabled={busy}
          onClick={() => {
            setError('');
            // Pre-mint the signing secret so the popup shows URL + secret
            // with copy buttons BEFORE the first save (user decision).
            setEditor({ name: '', draft: webhookDraft(undefined), secret: generateSigningSecret() });
          }}>
          <Plus size={14} aria-hidden="true" />New webhook</button>
      </header>
      <div className="schedules-search">
        <Search size={14} aria-hidden="true" />
        <input aria-label="Search webhooks" placeholder="Search webhooks…" value={query}
          onChange={(event) => setQuery(event.currentTarget.value)} />
      </div>
      <div className="schedules-filters" aria-label="Webhook filter">
        {([['all', 'All'], ['active', 'Active'], ['paused', 'Paused']] as const).map(([value, label]) =>
          <button key={value} type="button" className={filter === value ? 'active' : ''}
            aria-pressed={filter === value} onClick={() => setFilter(value)}>{label}</button>)}
      </div>
      {editor && <WebhookEditor key={editor.name || '(new)'} draft={editor.draft} editing={Boolean(editor.name)}
        busy={busy} models={models} projects={projects} workflows={workflows}
        publicBase={publicBase} secret={editor.secret} error={error}
        onCancel={() => {
          setError('');
          setEditor(null);
        }} onSave={(entry) => void saveWebhook(entry)} />}
      {/* No loading flash: the list area stays empty until the first snapshot
          lands (Schedules-page grammar). */}
      {loading ? null
        : visible.length ? <div className="schedules-list">{visible.map((webhook) => {
          const name = String(webhook.name);
          const enabled = webhook.enabled !== false;
          return <div key={name} className="schedules-row">
            <span className={`schedules-row-dot ${enabled ? 'on' : ''}`} aria-hidden="true" />
            <div className="schedules-row-copy">
              <b>{name}</b>
              <small>{webhookMeta(webhook)}</small>
            </div>
            <div className="schedules-row-actions">
              {/* No per-row Copy URL (user decision): the endpoint URL lives
                  in the editor's connection block. */}
              {/* Automation is decoupled from the messaging runtime: pause/
                  resume only needs the store, never the remote toggle. */}
              <button type="button" className="settings-action" disabled={busy}
                onClick={() => void run('setWebhookEnabled', [name, !enabled])}>{enabled ? 'Pause' : 'Resume'}</button>
              <button type="button" className="settings-action" disabled={busy}
                onClick={() => openEditor(name, webhookDraft(webhook))}>Edit</button>
              <button type="button" className="settings-action danger" disabled={busy}
                onClick={() => {
                  if (confirmingDelete !== name) {
                    setConfirmingDelete(name);
                    return;
                  }
                  setConfirmingDelete('');
                  void run('deleteWebhook', [name]);
                }}>{confirmingDelete === name ? 'Confirm delete' : 'Delete'}</button>
            </div>
          </div>;
        })}</div>
        : <div className="schedules-empty">
          <Webhook size={40} strokeWidth={1.5} aria-hidden="true" />
          <p>{webhooks.length ? 'No webhooks match the current filter.' : 'No inbound webhooks yet.'}</p>
        </div>}
      {error && !editor && <p className="mixdog-settings__error" role="alert">{error}</p>}
    </div>
  </div>;
}
