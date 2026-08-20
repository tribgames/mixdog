import { Check, Copy, Plus, Search, Webhook, X } from 'lucide-react';
import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { createPortal } from 'react-dom';

import type { DesktopApi, DesktopCapability, DesktopModelOption, DesktopProjectSummary } from '../shared/contract';
import { t } from './i18n';
import { useMobileBack } from './mobile-back';
import { filterConfiguredModels } from './model-catalog';
import { ModelRouteEditor } from './ModelRouteEditor';
import { dismissDesktopToast, showDesktopToast } from './notifications';
import { OpenSelect } from './OpenSelect';
import { ProgressSpinner } from './ProgressSpinner';
import { RowOverflowMenu } from './RowOverflowMenu';
import {
  AutomationAttachButton,
  AutomationAttachmentChips,
  attachmentsFromRecords,
  type AutomationAttachment,
} from './automation-attachments';
import {
  ModelRouteLabel,
  modelDisplayName,
  normalizeModelOptions,
  preferredModelParameters,
} from './provider-display';
import { SidebarPanelAction } from './session-sidebar';
import { useSidebarPanelDismiss } from './sidebar-panel-surface';
import { acquireTitleBarDim } from './titlebar-dim';
import {
  useSidebarReferences,
  type SidebarReferenceKey,
} from './sidebar-reference-cache';
import { copyTextToClipboard } from './text-format';

type RecordValue = Record<string, unknown>;
export type WebhooksApi = Partial<Pick<DesktopApi, 'invokeCapability' | 'listProviderModels' | 'listProjects'>>;

const PARSER_OPTIONS = [
  { value: 'generic', label: 'Generic JSON' },
  { value: 'github', label: 'GitHub' },
  { value: 'stripe', label: 'Stripe' },
  { value: 'sentry', label: 'Sentry' },
];

// Delivery: where a fire's result surfaces — the app session, the messaging
// channel, or both (user decision).
const DELIVERY_OPTIONS = [
  { value: 'app', label: 'App' },
  { value: 'channel', label: 'Channel' },
  { value: 'both', label: 'App + Channel' },
];

function record(value: unknown): RecordValue {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as RecordValue : {};
}

function rows(value: unknown): RecordValue[] {
  return Array.isArray(value) ? value.map(record) : [];
}

// webhook.model wire format matches schedules: "provider/model[@effort][+fast]".
function parseModelRef(ref: string): { route: string; effort: string; fast: boolean; modelParameters: Record<string, string> } {
  const raw = String(ref || '');
  const queryAt = raw.indexOf('?');
  let route = queryAt >= 0 ? raw.slice(0, queryAt) : raw;
  const modelParameters = queryAt >= 0 ? Object.fromEntries(new URLSearchParams(raw.slice(queryAt + 1))) : {};
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
  return { route, effort, fast, modelParameters };
}

function preferredEffort(option?: DesktopModelOption): string {
  if (!option?.effortOptions.length) return '';
  if (option.savedEffort && option.effortOptions.some((entry) => entry.value === option.savedEffort)) {
    return option.savedEffort;
  }
  if (option.defaultEffort && option.effortOptions.some((entry) => entry.value === option.defaultEffort)) {
    return option.defaultEffort;
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
  delivery: string;
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
    delivery: String(source.delivery || 'app'),
    attachments: attachmentsFromRecords(source.attachments),
    instructions: String(source.instructions || ''),
    enabled: source.enabled !== false,
  };
}

// Sub-line: parser first, then delivery route, model, and paused state.
function webhookMeta(webhook: RecordValue) {
  const parser = String(webhook.parser || 'github');
  const delivery = webhook.channel ? `channel ${String(webhook.channel)}` : 'session';
  const ref = parseModelRef(String(webhook.model || ''));
  let route: { model: string; effort: string; fast: boolean } | null = null;
  if (ref.route) {
    const slash = ref.route.indexOf('/');
    const model = slash > 0
      ? modelDisplayName(ref.route.slice(slash + 1), ref.route.slice(0, slash))
      : ref.route;
    route = { model, effort: ref.effort || '', fast: ref.fast };
  }
  return <>
    {parser} · {delivery}
    {route && <> · <ModelRouteLabel model={route.model} effort={route.effort} fast={route.fast} /></>}
    {webhook.secretSet !== true && <> · {t('secret missing')}</>}
    {webhook.enabled === false && <> · {t('paused')}</>}
  </>;
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

function ConnectionRow({ label, note, value, placeholder, copied, onCopy }: {
  label: string;
  note: string;
  value: string;
  placeholder: string;
  copied: boolean;
  onCopy(): void;
}) {
  return <div className="schedules-field webhook-connection-row">
    <span>{label}</span>
    <small>{note}</small>
    <div className="webhook-connection-value">
      <code>{value || placeholder}</code>
      {/* Icon-only copy (user decision): the value itself is the label. */}
      <button type="button" className="icon-button webhook-connection-copy" disabled={!value} onClick={onCopy}
        aria-label={t("Copy {{name}}", { name: t(label) })} data-tooltip={t("Copy {{name}}", { name: t(label) })}>
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
  const [delivery, setDelivery] = useState(draft.delivery);
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
  const [modelParameters, setModelParameters] = useState(initialModel.modelParameters);
  const [formError, setFormError] = useState('');
  const slash = model.indexOf('/');
  const modelProvider = slash > 0 ? model.slice(0, slash) : '';
  const modelId = slash > 0 ? model.slice(slash + 1) : '';
  const selected = models.find((option) => option.provider === modelProvider && option.model === modelId);
  const effortValue = selected?.effortOptions.some((entry) => entry.value === effort)
    ? effort
    : preferredEffort(selected);
  const selectedModelParameters = preferredModelParameters(selected, modelParameters);
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
  // The scrim cannot dim the NATIVE caption band — hold the titlebar claim
  // while this dialog is mounted (user: - ㅁ x 딤드 안 먹음).
  useEffect(() => acquireTitleBarDim(), []);
  // ABB: the editor is only mounted while it is open, so it owns back for its
  // whole life.
  useMobileBack(true, onCancel);
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
    <section className="schedules-dialog" role="dialog" aria-modal="true" aria-labelledby="webhooks-dialog-title">
      <header>
        <h2 id="webhooks-dialog-title">{editing ? t('Edit webhook') : t('Create webhook')}</h2>
        <button type="button" aria-label={t("Close webhook editor")} onClick={onCancel}><X size={16} aria-hidden="true" /></button>
      </header>
      <form onSubmit={(event: FormEvent<HTMLFormElement>) => {
        event.preventDefault();
        const data = new FormData(event.currentTarget);
        const text = (name: string) => String(data.get(name) || '').trim();
        setFormError('');
        const effortSuffix = selected && effortValue ? `@${effortValue}` : '';
        const fastSuffix = selected?.fastCapable && fast ? '+fast' : '';
        const parameterSuffix = Object.keys(selectedModelParameters).length
          ? `?${new URLSearchParams(selectedModelParameters).toString()}`
          : '';
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
          ...(model ? { model: `${model}${effortSuffix}${fastSuffix}${parameterSuffix}` } : {}),
          ...(cwd ? { cwd } : {}),
          ...(workflow ? { workflow } : {}),
          delivery,
          ...(attachments.length ? { attachments } : {}),
          ...(effectiveSecret ? { secret: effectiveSecret } : {}),
          instructions: text('webhook-instructions'),
          enabled: draft.enabled,
          ...(editing ? { overwrite: true } : {}),
        });
      }}>
        <label className="schedules-field"><span>{t('Name')}</span>
          <small>{t('Used in the endpoint URL and webhook lists.')}</small>
          <input name="webhook-name" defaultValue={draft.name} placeholder="github-issues" required autoFocus
            disabled={busy || editing} maxLength={64}
            onChange={(event) => setUrlName(event.currentTarget.value)} />
        </label>
        {/* Field order (user decision): composer right under Name, then
            Project → Delivery → Payload format as labeled fields. */}
        <div className="schedules-composer">
          <textarea name="webhook-instructions" defaultValue={draft.instructions} required disabled={busy}
            placeholder={t("What should Mixdog do when this webhook fires?")} aria-label={t("Webhook instructions")} />
          <AutomationAttachmentChips attachments={attachments} disabled={busy} onChange={setAttachments} />
          <div className="composer-footer schedules-composer-footer">
            <AutomationAttachButton attachments={attachments} disabled={busy}
              ariaLabel={t("Attach files to this webhook")}
              onChange={setAttachments} onError={setFormError} />
            <ModelRouteEditor models={models} disabled={busy} ariaLabel={t("Webhook model")}
              value={{
                provider: modelProvider,
                model: modelId,
                ...(effortValue ? { effort: effortValue } : {}),
                fast,
                modelParameters: selectedModelParameters,
              }}
              onChange={(selection) => {
                setModel(`${selection.provider}/${selection.model}`);
                setEffort(String(selection.effort || ''));
                setFast(selection.fast === true);
                setModelParameters(selection.modelParameters || {});
                setFormError('');
              }} />
            {/* Same flat, right-aligned workflow control as the chat
                composer (effort-control/workflow-control skin). */}
            <div className="effort-control workflow-control">
              <OpenSelect ariaLabel={t("Webhook workflow")} value={workflow} disabled={busy}
                options={workflows.length ? workflows : [{ value: 'default', label: 'Default' }]}
                onChange={setWorkflow} />
            </div>
          </div>
        </div>
        <div className="schedules-field">
          <span>{t('Project')}</span>
          <small>{t('Project used for each run.')}</small>
          <div className="schedules-frequency">
            <OpenSelect ariaLabel={t("Webhook project")} value={cwd || '__none__'} disabled={busy}
              options={projectOptions} onChange={(next) => setCwd(next === '__none__' ? '' : next)} />
          </div>
        </div>
        <div className="schedules-field">
          <span>{t('Delivery')}</span>
          <small>{t('Where completed results are sent.')}</small>
          <div className="schedules-frequency">
            <OpenSelect ariaLabel={t("Webhook delivery")} value={delivery} disabled={busy}
              options={DELIVERY_OPTIONS} onChange={setDelivery} />
          </div>
        </div>
        <div className="schedules-field">
          <span>{t('Payload format')}</span>
          <small>{t('How the request body is interpreted.')}</small>
          <div className="schedules-frequency">
            <OpenSelect ariaLabel={t("Webhook payload format")} value={parser} disabled={busy}
              options={PARSER_OPTIONS} onChange={setParser} />
          </div>
        </div>
        {/* Connection details (user decision): the endpoint URL stays
            visible; the signing secret shows only when freshly minted —
            create pre-mints it, edit offers Regenerate instead. */}
        <div className="webhook-connection" aria-label={t("Connection details")}>
          <ConnectionRow label={t("Endpoint URL")} note={t("Call this URL to trigger the webhook.")}
            value={editing ? endpointUrl(publicBase, draft.name) : previewUrl}
            placeholder={publicBase
              ? t('Type a name to preview the endpoint URL')
              : t('URL appears once the runtime connects to the relay')}
            copied={copiedField === 'url'}
            onCopy={() => copyField('url', editing ? endpointUrl(publicBase, draft.name) : previewUrl)} />
          {editing && !rotated
            ? <div className="schedules-field webhook-connection-row">
              <span>{t('Signing secret')}</span>
              <small>{t('The saved secret stays hidden. Regenerate it to create a new one.')}</small>
              <div className="webhook-connection-value">
                <button type="button" className="settings-action" disabled={busy}
                  onClick={() => setRotated(generateSigningSecret())}>{t('Regenerate secret')}</button>
              </div>
            </div>
            : <ConnectionRow label={t("Signing secret")} note={t("Sign requests with this secret — copy it now.")}
              value={editing ? rotated : secret}
              placeholder={t("Secret unavailable")}
              copied={copiedField === 'secret'}
              onCopy={() => copyField('secret', editing ? rotated : secret)} />}
        </div>
        <footer>
          {(formError || error) && <p className="schedules-form-error" role="alert">{formError || error}</p>}
          <button type="button" disabled={busy} onClick={onCancel}>{t('Cancel')}</button>
          <button type="submit" disabled={busy}>{t('Save')}</button>
        </footer>
      </form>
    </section>
  </div>, document.body);
}

// Same shared keys as Schedules: both panels read one channel setup, one quick
// model catalog, one project list and one workflow list.
const WEBHOOK_REFERENCE_KEYS = [
  'channelSetup',
  'quickProviderModels',
  'providerSetup',
  'projects',
  'workflows',
] as const satisfies readonly SidebarReferenceKey[];

// Inbound-webhooks panel (rail -> Webhooks): the Schedules grammar — a
// compact session-panel list with search, filters, and a popup editor.
export function WebhooksPane({ api = window.mixdogDesktop, active = true, runningNames }: {
  api?: WebhooksApi;
  active?: boolean;
  runningNames?: ReadonlySet<string>;
}) {
  // Cached seed → no loading cover on a warm first visit; the secret itself is
  // never cached (it is minted or rotated in the editor, never read back).
  const { values, loading, error: referenceError, completeMutation } =
    useSidebarReferences(api, WEBHOOK_REFERENCE_KEYS, active);
  const setup = values.channelSetup;
  // Configured-provider filtering matches Schedules and Workflows: models from
  // a disconnected provider never enter the picker.
  const models = useMemo(() => filterConfiguredModels(
    normalizeModelOptions(values.quickProviderModels),
    values.providerSetup,
  ), [values.quickProviderModels, values.providerSetup]);
  const projects = values.projects;
  const workflows = useMemo(() => values.workflows
    .map((row) => ({ value: String(row.id || ''), label: String(row.name || row.id || '') }))
    .filter((option) => option.value), [values.workflows]);
  const [pending, setPending] = useState('');
  const [error, setError] = useState('');
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<'all' | 'active' | 'paused'>('all');
  const [editor, setEditor] = useState<{ name: string; draft: WebhookDraft; secret: string } | null>(null);
  const [confirmingDelete, setConfirmingDelete] = useState('');
  // The editor portals to document.body: a hidden panel must never leave that
  // layer interactive above the workspace (search/filter state stays).
  useSidebarPanelDismiss(active, () => {
    setEditor(null);
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
      // Host-scoped completion: a result that lands after a host swap must not
      // resurrect the previous host's cache.
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

  return <div className="schedules-pane stable-surface-preserved stable-takeover-surface"
    data-surface-active={active ? 'true' : 'false'}
    inert={active ? undefined : true} aria-hidden={active ? undefined : true}>
    <div className="schedules-page">
      {/* Title and primary action live in the sidebar panel header. */}
      <SidebarPanelAction active={active} label={t("New webhook")} icon={Plus}
        className="webhooks-add" disabled={busy}
        onClick={() => {
          setError('');
          // Pre-mint the signing secret so the popup shows URL + secret with
          // copy buttons BEFORE the first save (user decision).
          setEditor({ name: '', draft: webhookDraft(undefined), secret: generateSigningSecret() });
        }} />
      <div className="schedules-search">
        <Search size={14} aria-hidden="true" />
        <input aria-label={t("Search webhooks")} placeholder={t("Search webhooks…")} value={query}
          onChange={(event) => setQuery(event.currentTarget.value)} />
      </div>
      <div className="schedules-filters" aria-label={t("Webhook filter")}>
        {([['all', 'All'], ['active', 'Active'], ['paused', 'Paused']] as const).map(([value, label]) =>
          <button key={value} type="button" className={filter === value ? 'active' : ''}
            aria-pressed={filter === value} onClick={() => setFilter(value)}>{t(label)}</button>)}
      </div>
      {active && editor && <WebhookEditor key={editor.name || '(new)'} draft={editor.draft} editing={Boolean(editor.name)}
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
          const running = runningNames?.has(name) === true;
          return <div key={name} className="schedules-row">
            <span className="schedules-row-status" role={running ? 'status' : undefined}
              aria-label={running ? t("{{name}} is running", { name }) : undefined} aria-hidden={running ? undefined : true}>
              {running
                ? <ProgressSpinner size={12} className="schedules-row-spinner" aria-hidden="true" />
                : <span className={`schedules-row-dot ${enabled ? 'on' : ''}`} />}
            </span>
            <div className="schedules-row-copy">
              <b>{name}</b>
              <small>{webhookMeta(webhook)}</small>
            </div>
            <RowOverflowMenu label={`Actions for ${name}`} items={[
              {
                id: 'toggle-enabled',
                label: enabled ? 'Pause' : 'Resume',
                disabled: busy,
                onSelect: () => void run('setWebhookEnabled', [name, !enabled], 'toast'),
              },
              {
                id: 'edit',
                label: 'Edit',
                disabled: busy,
                onSelect: () => openEditor(name, webhookDraft(webhook)),
              },
              {
                id: 'delete',
                label: confirmingDelete === name ? 'Confirm delete' : 'Delete',
                disabled: busy,
                danger: true,
                closeOnSelect: confirmingDelete === name,
                onSelect: () => {
                  if (confirmingDelete !== name) {
                    setConfirmingDelete(name);
                    return;
                  }
                  setConfirmingDelete('');
                  void run('deleteWebhook', [name], 'toast');
                },
              },
            ]} />
          </div>;
        })}</div>
        : <div className="schedules-empty">
          <Webhook size={40} strokeWidth={1.5} aria-hidden="true" />
          <p>{webhooks.length ? t('No webhooks match the current filter.') : t('No inbound webhooks yet.')}</p>
        </div>}
    </div>
  </div>;
}
