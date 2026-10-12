import { Check, ChevronRight, Copy, Plus, Search, Webhook, X } from 'lucide-react';
import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';

import type { DesktopApi, DesktopModelOption, DesktopProjectSummary } from '../shared/contract';
import { t } from './i18n';
import { InitialSurface } from './InitialSurface';
import { filterConfiguredModels } from './model-catalog';
import { ModelRouteEditor } from './ModelRouteEditor';
import { parseModelRef, preferredModelEffort, preferredModelParameters } from './model-route-utils';
import { showDesktopToast } from './notifications';
import { OpenSelect } from './OpenSelect';
import { ProgressSpinner } from './ProgressSpinner';
import { record, rows } from './record-utils';
import { SidebarResourceTitle } from './sidebar-resource-row';
import {
  AutomationAttachButton,
  AutomationAttachmentChips,
  attachmentsFromRecords,
  type AutomationAttachment,
} from './automation-attachments';
import { ModelRouteLabel, normalizeModelOptions } from './provider-display';
import {
  automationAutoEffortSuffix,
  automationFastSuffix,
  automationProjectOptions,
  automationRouteSummary,
  automationWorkflowOptions,
  splitModelRoute,
} from './automation-editor-support';
import { SidebarPanelAction } from './session-sidebar-sections';
import { EditorDialogFooter, SidebarDialogLayer } from './sidebar-dialog';
import { useSidebarPanelDismiss } from './sidebar-panel-surface';
import { useSidebarReferences, type SidebarReferenceKey } from './sidebar-reference-cache';
import { copyTextToClipboard } from './text-format';
import { useSidebarCapabilityRunner } from './use-sidebar-capability-runner';
import { usePersistedListOrder } from './use-persisted-list-order';
import { CompactSwitch } from './settings/capability-controls';
import type { RecordValue } from './desktop-types';

type WebhooksApi = Partial<Pick<DesktopApi, 'invokeCapability' | 'listProviderModels' | 'listProjects'>>;

const parserOptions = () => [
  { value: 'generic', label: t('Generic JSON') },
  { value: 'github', label: 'GitHub' },
  { value: 'stripe', label: 'Stripe' },
  { value: 'sentry', label: 'Sentry' },
];

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
    // Stored rows carry no parser default (webhooks.endpoints.parser is
    // nullable); the store's own reader substitutes 'github' for a missing
    // value, so the editor must open a legacy row as the same parser the list
    // shows — and save it back unchanged.
    parser: String(source.parser || 'github'),
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

// Sub-line (Schedules parity): payload format, then model and project; a
// missing secret is flagged last.
function webhookMeta(webhook: RecordValue) {
  const parser = String(webhook.parser || 'github');
  const route = automationRouteSummary(String(webhook.model || ''));
  const cwd = String(webhook.cwd || '');
  const cwdLabel = cwd ? cwd.split(/[\\/]/).filter(Boolean).pop() || cwd : '';
  return (
    <>
      {parser}
      {route && (
        <>
          {' '}
          · <ModelRouteLabel
            model={route.model}
            effort={route.effort}
            fast={route.fast}
            ultra={route.ultra}
            blue={route.blue}
            autoEffortCapable={route.autoEffortCapable}
            autoEffort={route.autoEffort}
          />
        </>
      )}
      {cwdLabel && <> · {cwdLabel}</>}
      {webhook.secretSet !== true && <> · {t('secret missing')}</>}
    </>
  );
}

function endpointUrl(publicBase: string, name: string): string {
  return publicBase ? `${publicBase.replace(/\/+$/, '')}/webhook/${encodeURIComponent(name)}` : '';
}

// Client-side secret mint for NEW webhooks: showing the value (with copy)
// inside the editor beats the old one-shot post-save reveal. Same shape as
// the store's randomBytes(24) hex.
// Only a cryptographic source may mint a signing secret: without one the
// caller surfaces the failure instead of issuing a guessable secret.
function generateSigningSecret(): string {
  const bytes = new Uint8Array(24);
  if (typeof globalThis.crypto?.getRandomValues !== 'function') {
    throw new Error('Secure random generation is unavailable, so a signing secret cannot be created.');
  }
  globalThis.crypto.getRandomValues(bytes);
  return Array.from(bytes, (value) => value.toString(16).padStart(2, '0')).join('');
}

// Value row of the connection card: title (+ optional note) with an icon-only
// copy on the right, the value in a full-width box underneath.
function ConnectionRow({
  label,
  note,
  value,
  placeholder,
  copied,
  onCopy,
}: {
  label: string;
  note?: string;
  value: string;
  placeholder: string;
  copied: boolean;
  onCopy(): void;
}) {
  return (
    <div className="schedules-field webhook-connection-row">
      <span>{label}</span>
      {note && <small>{note}</small>}
      <button
        type="button"
        className="icon-button webhook-connection-copy"
        disabled={!value}
        onClick={onCopy}
        aria-label={t('Copy {{name}}', { name: label })}
        data-tooltip={t('Copy {{name}}', { name: label })}
      >
        {copied ? <Check size={14} aria-hidden="true" /> : <Copy size={14} aria-hidden="true" />}
      </button>
      <div className="webhook-connection-value">
        <code>{value || placeholder}</code>
      </div>
    </div>
  );
}

interface WebhookTestResult {
  ok: boolean;
  status: number;
  /** Stable failure kind from the runtime: relay-unavailable | timeout | network | rejected. */
  code?: string;
  error?: string;
}

// Localized reason for a failed test: the runtime's stable code first, then
// the receiver's known error strings; anything else keeps its raw detail.
function webhookTestError(result: WebhookTestResult): string {
  const error = result.error || '';
  if (result.code === 'relay-unavailable')
    return t('The endpoint URL is not available yet. Wait for the relay to connect.');
  if (result.code === 'timeout') return t('No response within 15 seconds.');
  if (result.code === 'network') return t('Could not reach the endpoint: {{error}}', { error });
  if (error === 'disabled endpoint') return t('This webhook is turned off. Turn it on, then test again.');
  if (error === 'unknown endpoint') return t('The endpoint does not know this webhook yet. Save it, then test again.');
  if (error === 'invalid signature' || error === 'missing signature') {
    return t('The signature did not match the saved secret.');
  }
  if (error === 'test requires a signing secret')
    return t('This webhook has no signing secret. Regenerate one and save.');
  return error;
}

function webhookTestMessage(result: WebhookTestResult): string {
  if (result.ok) return t('Verified — the endpoint accepted the signature.');
  const error = webhookTestError(result);
  if (result.status) return t('Test failed (HTTP {{status}}): {{error}}', { status: result.status, error });
  return t('Test failed: {{error}}', { error });
}

// Edit-only: signs a test request with the SAVED configuration, so unsaved
// changes that affect signing (a regenerated secret, another payload format)
// block it until Save — `blockedNote` says which.
function WebhookTestRow({
  disabled,
  blockedNote,
  onTest,
}: {
  disabled: boolean;
  blockedNote: string;
  onTest(): Promise<WebhookTestResult>;
}) {
  const [testing, setTesting] = useState(false);
  const [result, setResult] = useState<WebhookTestResult | null>(null);
  const sendTest = async () => {
    setTesting(true);
    setResult(null);
    try {
      setResult(await onTest());
    } catch (reason) {
      setResult({ ok: false, status: 0, error: reason instanceof Error ? reason.message : String(reason) });
    } finally {
      setTesting(false);
    }
  };
  return (
    <div className="schedules-field webhook-connection-row is-action">
      <span>{t('Test delivery')}</span>
      {/* The latest result takes the note's place (status line under the title). */}
      {result && !blockedNote ? (
        <small className="webhook-test-result" role="status" data-ok={String(result.ok)}>
          {webhookTestMessage(result)}
        </small>
      ) : (
        <small>{blockedNote || t('Sends a signed test request to the endpoint URL. No task is run.')}</small>
      )}
      <div className="webhook-connection-value">
        <button
          type="button"
          className="settings-action"
          disabled={testing || disabled || Boolean(blockedNote)}
          aria-busy={testing || undefined}
          onClick={() => void sendTest()}
        >
          {testing ? t('Sending…') : t('Send test')}
        </button>
      </div>
    </div>
  );
}

function WebhookEditor({
  draft,
  editing,
  busy,
  models,
  projects,
  workflows,
  publicBase,
  secret,
  error = '',
  onCancel,
  onSave,
  onToggle,
  onDelete,
  onTest,
}: {
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
  onToggle?(enabled: boolean): void;
  onDelete?(): void;
  onTest?(): Promise<WebhookTestResult>;
}) {
  const [parser, setParser] = useState(draft.parser);
  const [cwd, setCwd] = useState(draft.cwd);
  const [workflow, setWorkflow] = useState(draft.workflow);
  const [attachments, setAttachments] = useState<AutomationAttachment[]>(draft.attachments);
  const [enabled, setEnabled] = useState(draft.enabled);
  // EDIT never reveals the stored secret; rotation mints a replacement that
  // only persists on Save (user decision).
  const [rotated, setRotated] = useState('');
  // Fields that change how a test is signed must be saved before testing.
  const unsavedSigning = () => {
    if (rotated) return t('Save first to test the new secret.');
    if (parser !== draft.parser) return t('Save first to test the new payload format.');
    return '';
  };
  // Uncontrolled name input + shadow state so the endpoint URL previews live
  // while typing (FormData still reads the input on submit).
  const [urlName, setUrlName] = useState(draft.name);
  const [copiedField, setCopiedField] = useState('');
  const copiedFieldTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (copiedFieldTimer.current) clearTimeout(copiedFieldTimer.current);
    },
    []
  );
  const copyField = (field: string, value: string) => {
    void copyTextToClipboard(value);
    setCopiedField(field);
    if (copiedFieldTimer.current) clearTimeout(copiedFieldTimer.current);
    copiedFieldTimer.current = setTimeout(() => setCopiedField(''), 1600);
  };
  const previewUrl = urlName.trim() ? endpointUrl(publicBase, urlName.trim()) : '';
  const shownUrl = editing ? endpointUrl(publicBase, draft.name) : previewUrl;
  const initialModel = parseModelRef(draft.model);
  const [model, setModel] = useState(initialModel.route);
  const [effort, setEffort] = useState(initialModel.effort);
  const [fast, setFast] = useState(initialModel.fast);
  const [autoEffort, setAutoEffort] = useState(initialModel.autoEffort);
  const [modelParameters, setModelParameters] = useState(initialModel.modelParameters);
  const [formError, setFormError] = useState('');
  const { provider: modelProvider, id: modelId } = splitModelRoute(model);
  const selected = models.find((option) => option.provider === modelProvider && option.model === modelId);
  const effortValue = selected?.effortOptions.some((entry) => entry.value === effort)
    ? effort
    : preferredModelEffort(selected) || '';
  const selectedModelParameters = preferredModelParameters(selected, modelParameters);
  const projectOptions = automationProjectOptions(projects, cwd);
  return (
    <SidebarDialogLayer onClose={onCancel}>
      <section
        className="schedules-dialog webhooks-editor-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="webhooks-dialog-title"
      >
        <header>
          <h2 id="webhooks-dialog-title">{editing ? t('Edit webhook') : t('Create webhook')}</h2>
          <div className="schedules-dialog-header-actions">
            <CompactSwitch
              label={t('Enabled')}
              checked={enabled}
              disabled={busy}
              onChange={(next) => {
                setEnabled(next);
                if (editing) onToggle?.(next);
              }}
            />
            <button type="button" aria-label={t('Close webhook editor')} onClick={onCancel}>
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
            const effortSuffix = selected && effortValue ? `@${effortValue}` : '';
            const fastSuffix = automationFastSuffix(selected, effortValue, selectedModelParameters, fast);
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
              ...(model ? { model: `${model}${effortSuffix}${fastSuffix}${automationAutoEffortSuffix(autoEffort)}${parameterSuffix}` } : {}),
              ...(cwd ? { cwd } : {}),
              ...(workflow ? { workflow } : {}),
              ...(attachments.length ? { attachments } : {}),
              ...(effectiveSecret ? { secret: effectiveSecret } : {}),
              instructions: text('webhook-instructions'),
              enabled,
              ...(editing ? { overwrite: true } : {}),
            });
          }}
        >
          <label className="schedules-field">
            <span>{t('Name')}</span>
            <small>{t('Used in the endpoint URL and webhook lists.')}</small>
            <input
              name="webhook-name"
              defaultValue={draft.name}
              placeholder="github-issues"
              required
              // biome-ignore lint/a11y/noAutofocus: focuses the first field of the dialog on open
              autoFocus
              disabled={busy || editing}
              maxLength={64}
              onChange={(event) => setUrlName(event.currentTarget.value)}
            />
          </label>
          {/* Field order (user decision): composer right under Name, then
            Project → Delivery → Payload format as labeled fields. */}
          <div className="schedules-composer">
            <textarea
              name="webhook-instructions"
              defaultValue={draft.instructions}
              required
              disabled={busy}
              placeholder={t('What should Mixdog do when this webhook fires?')}
              aria-label={t('Webhook instructions')}
            />
            <AutomationAttachmentChips attachments={attachments} disabled={busy} onChange={setAttachments} />
            <div className="composer-footer schedules-composer-footer">
              <AutomationAttachButton
                attachments={attachments}
                disabled={busy}
                ariaLabel={t('Attach files to this webhook')}
                onChange={setAttachments}
                onError={setFormError}
              />
              <ModelRouteEditor
                models={models}
                disabled={busy}
                ariaLabel={t('Webhook model')}
                autoEffortSwitch
                value={{
                  provider: modelProvider,
                  model: modelId,
                  ...(effortValue ? { effort: effortValue } : {}),
                  fast,
                  autoEffort,
                  modelParameters: selectedModelParameters,
                }}
                onChange={(selection) => {
                  setModel(`${selection.provider}/${selection.model}`);
                  setEffort(String(selection.effort || ''));
                  setFast(selection.fast === true);
                  setAutoEffort(selection.autoEffort !== false);
                  setModelParameters(selection.modelParameters || {});
                  setFormError('');
                }}
              />
              {/* Same flat, right-aligned workflow control as the chat
                composer (effort-control/workflow-control skin) — including its
                rule: a single pack is not a choice, so the control is omitted
                and the draft keeps the workflow it already carries. */}
              {workflows.length > 1 && (
                <div className="effort-control workflow-control">
                  <OpenSelect
                    ariaLabel={t('Webhook workflow')}
                    value={workflow}
                    disabled={busy}
                    options={workflows}
                    onChange={setWorkflow}
                  />
                </div>
              )}
            </div>
          </div>
          <div className="schedules-field">
            <span>{t('Project')}</span>
            <small>{t('Project used for each run.')}</small>
            <div className="schedules-frequency">
              <OpenSelect
                ariaLabel={t('Webhook project')}
                value={cwd || '__none__'}
                disabled={busy}
                options={projectOptions}
                onChange={(next) => setCwd(next === '__none__' ? '' : next)}
              />
            </div>
          </div>
          <div className="schedules-field">
            <span>{t('Payload format')}</span>
            <small>{t('How the request body is interpreted.')}</small>
            <div className="schedules-frequency">
              <OpenSelect
                ariaLabel={t('Webhook payload format')}
                value={parser}
                disabled={busy}
                options={parserOptions()}
                onChange={setParser}
              />
            </div>
          </div>
          {/* Connection details (user decision): the endpoint URL stays
            visible; the signing secret shows only when freshly minted —
            create pre-mints it, edit offers Regenerate instead. */}
          <div className="schedules-field">
            <span>{t('Connection')}</span>
            <small>{t('Register these with the external service.')}</small>
            {/* biome-ignore lint/a11y/useAriaPropsSupportedByRole: labels the plain details container for assistive tech; adding a role would change semantics */}
            <div className="webhook-connection" aria-label={t('Connection details')}>
              <ConnectionRow
                label={t('Endpoint URL')}
                value={shownUrl}
                placeholder={
                  publicBase
                    ? t('Type a name to preview the endpoint URL')
                    : t('URL appears once the runtime connects to the relay')
                }
                copied={copiedField === 'url'}
                onCopy={() => copyField('url', shownUrl)}
              />
              {editing && !rotated && (
                <div className="schedules-field webhook-connection-row is-action">
                  <span>{t('Signing secret')}</span>
                  <small>{t('The saved secret stays hidden. Regenerate it to create a new one.')}</small>
                  <div className="webhook-connection-value">
                    <button
                      type="button"
                      className="settings-action"
                      disabled={busy}
                      onClick={() => {
                        try {
                          setRotated(generateSigningSecret());
                        } catch (reason) {
                          setFormError(reason instanceof Error ? reason.message : String(reason));
                        }
                      }}
                    >
                      {t('Regenerate secret')}
                    </button>
                  </div>
                </div>
              )}
              {!(editing && !rotated) && (
                <ConnectionRow
                  label={t('Signing secret')}
                  note={t('Sign requests with this secret — copy it now.')}
                  value={editing ? rotated : secret}
                  placeholder={t('Secret unavailable')}
                  copied={copiedField === 'secret'}
                  onCopy={() => copyField('secret', editing ? rotated : secret)}
                />
              )}
              {editing && onTest && (
                <WebhookTestRow disabled={busy || !shownUrl} blockedNote={unsavedSigning()} onTest={onTest} />
              )}
            </div>
          </div>
          <EditorDialogFooter
            error={formError || error}
            busy={busy}
            onCancel={onCancel}
            onDelete={editing ? onDelete : undefined}
          />
        </form>
      </section>
    </SidebarDialogLayer>
  );
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
// compact session-panel list with search, drag reorder, and a popup editor.
export function WebhooksPane({
  api = window.mixdogDesktop,
  active = true,
  runningNames,
}: {
  api?: WebhooksApi;
  active?: boolean;
  runningNames?: ReadonlySet<string>;
}) {
  // Cached seed → no loading cover on a warm first visit; the secret itself is
  // never cached (it is minted or rotated in the editor, never read back).
  const { values, loading, completeMutation } = useSidebarReferences(api, WEBHOOK_REFERENCE_KEYS, active);
  const setup = values.channelSetup;
  // Configured-provider filtering matches Schedules and Workflows: models from
  // a disconnected provider never enter the picker.
  const models = useMemo(
    () => filterConfiguredModels(normalizeModelOptions(values.quickProviderModels), values.providerSetup),
    [values.quickProviderModels, values.providerSetup]
  );
  const projects = values.projects;
  const workflows = useMemo(() => automationWorkflowOptions(values.workflows), [values.workflows]);
  const { pending, error, setError, run } = useSidebarCapabilityRunner({
    api,
    completeMutation,
    toastScope: 'webhook',
  });
  const [query, setQuery] = useState('');
  const [editor, setEditor] = useState<{ name: string; draft: WebhookDraft; secret: string } | null>(null);
  // The editor portals to document.body: a hidden panel must never leave that
  // layer interactive above the workspace (search state stays).
  useSidebarPanelDismiss(active, () => {
    setEditor(null);
  });
  const busy = Boolean(pending) || loading;

  const webhooks = rows(setup.webhooks);
  // Schedules parity: drag to reorder, order kept per device.
  const webhookOrder = usePersistedListOrder(
    'mixdog.sidebar-order.webhooks.v1',
    webhooks.map((webhook) => String(webhook.name))
  );
  const orderedWebhooks = webhookOrder.orderedIds
    .map((name) => webhooks.find((webhook) => String(webhook.name) === name))
    .filter((webhook): webhook is RecordValue => Boolean(webhook));
  const publicBase = String(record(setup.webhook).publicUrl || '');
  const text = query.trim().toLowerCase();
  const visible = orderedWebhooks.filter((webhook) => {
    if (!text) return true;
    return [webhook.name, webhook.description, webhook.parser, webhook.model, webhook.channel]
      .map((value) => String(value || '').toLowerCase())
      .join(' ')
      .includes(text);
  });
  const saveWebhook = async (entry: RecordValue) => {
    const result = await run('saveWebhook', [entry]);
    if (result === undefined) return;
    setEditor(null);
  };
  // Edit never reads the stored secret (user decision): rotation via the
  // editor's Regenerate button is the only way to obtain a copyable value.
  const openEditor = (name: string, draft: WebhookDraft) => {
    setError('');
    setEditor({ name, draft, secret: '' });
  };

  return (
    <div
      className="schedules-pane stable-surface-preserved stable-takeover-surface"
      data-surface-active={active ? 'true' : 'false'}
      inert={active ? undefined : true}
      aria-hidden={active ? undefined : true}
    >
      <div className="schedules-page">
        {/* Title and primary action live in the sidebar panel header. */}
        <SidebarPanelAction
          active={active}
          label={t('New webhook')}
          icon={Plus}
          className="webhooks-add"
          disabled={busy}
          onClick={() => {
            setError('');
            // Pre-mint the signing secret so the popup shows URL + secret with
            // copy buttons BEFORE the first save (user decision).
            try {
              setEditor({ name: '', draft: webhookDraft(undefined), secret: generateSigningSecret() });
            } catch (reason) {
              showDesktopToast(reason instanceof Error ? reason.message : String(reason), 'error', {
                scope: 'webhook:secret',
              });
            }
          }}
        />
        <div className="schedules-search">
          <Search size={14} aria-hidden="true" />
          <input
            aria-label={t('Search webhooks')}
            placeholder={t('Search webhooks…')}
            value={query}
            onChange={(event) => setQuery(event.currentTarget.value)}
          />
        </div>
        {active && editor && (
          <WebhookEditor
            key={editor.name || '(new)'}
            draft={editor.draft}
            editing={Boolean(editor.name)}
            busy={busy}
            models={models}
            projects={projects}
            workflows={workflows}
            publicBase={publicBase}
            secret={editor.secret}
            error={error}
            onCancel={() => {
              setError('');
              setEditor(null);
            }}
            onDelete={
              editor.name
                ? () => {
                    const name = editor.name;
                    setEditor(null);
                    void run('deleteWebhook', [name], 'toast');
                  }
                : undefined
            }
            onTest={
              editor.name
                ? async () => {
                    const result = await api.invokeCapability?.<WebhookTestResult>({
                      capability: 'testWebhook',
                      args: [editor.name],
                    });
                    return result?.value ?? { ok: false, status: 0, error: '' };
                  }
                : undefined
            }
            onSave={(entry) => void saveWebhook(entry)}
            onToggle={(enabled) => void run('setWebhookEnabled', [editor.name, enabled], 'toast')}
          />
        )}
        {/* No loading flash: the list area stays empty until the first snapshot
          lands (Schedules-page grammar). */}
        {loading && <InitialSurface />}
        {!loading && visible.length > 0 && (
          <div className="schedules-list">
            {visible.map((webhook) => {
              const name = String(webhook.name);
              const enabled = webhook.enabled !== false;
              const running = runningNames?.has(name) === true;
              return (
                <button
                  type="button"
                  key={name}
                  className="schedules-row utilities-row sidebar-resource-row"
                  data-enabled={enabled ? 'true' : 'false'}
                  disabled={busy}
                  onClick={() => openEditor(name, webhookDraft(webhook))}
                  {...webhookOrder.getReorderProps(name)}
                >
                  <span className="sidebar-resource-icon" aria-hidden="true">
                    {running ? <ProgressSpinner size={12} className="schedules-row-spinner" /> : <Webhook size={16} />}
                  </span>
                  <span className="schedules-row-copy utilities-row-copy">
                    <SidebarResourceTitle
                      label={name}
                      tag={!enabled ? { label: t('Disabled'), tone: 'muted' } : null}
                    />
                    <small>{webhookMeta(webhook)}</small>
                  </span>
                  <ChevronRight className="utilities-row-chevron" size={16} aria-hidden="true" />
                </button>
              );
            })}
          </div>
        )}
        {!loading && visible.length === 0 && (
          <div className="schedules-empty">
            <Webhook size={40} aria-hidden="true" />
            <p>{webhooks.length ? t('No webhooks match your search.') : t('No inbound webhooks yet.')}</p>
          </div>
        )}
      </div>
    </div>
  );
}
