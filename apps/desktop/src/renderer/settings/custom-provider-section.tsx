import { useEffect, useId, useRef, useState, type FormEvent } from 'react';
import { Plus, X } from 'lucide-react';

import { t } from '../i18n';
import { scrimDismiss } from '../scrim-dismiss';
import { OpenSelect } from '../OpenSelect';
import { ActionButton, CompactSwitch, ListEmpty, ResourceRow } from './capability-controls';
import { providerLabel, type PanelContext, type RecordValue } from './capability-data';
import { record, rows } from '../record-utils';
import { useMobileBack } from '../mobile-back';
import { acquireTitleBarDim } from '../titlebar-dim';
import { CustomModelEditor } from './custom-model-editor';
import { CustomProviderKeyFields, useKeyEnvPresence } from './custom-provider-key-fields';
import { type CustomModel, CustomProviderModelsList } from './custom-provider-models-list';
import { errorMessageText } from '../ErrorNotice';

export const CUSTOM_PROTOCOLS = [
  { value: 'openai-chat', label: 'OpenAI Chat Completions' },
  { value: 'openai-responses', label: 'OpenAI Responses' },
  { value: 'anthropic', label: 'Anthropic Messages' },
] as const;

type Protocol = (typeof CUSTOM_PROTOCOLS)[number]['value'];

function isCustomProvider(provider: RecordValue): boolean {
  return provider.custom === true;
}

/** The Providers page's order: OAuth providers, the
 *  API-key providers, then custom providers (local providers last). Every
 *  list that names providers takes its order from here. */
export function providerPageGroups(setup: RecordValue) {
  const allApi = rows(setup.api);
  return {
    oauth: rows(setup.oauth),
    otherApi: allApi.filter((provider) => !isCustomProvider(provider)),
    custom: allApi.filter(isCustomProvider),
    local: rows(setup.local),
  };
}

/** Provider ids in the Providers page's order. */
export function providerPageOrder(setup: RecordValue): string[] {
  const groups = providerPageGroups(setup);
  return [...groups.oauth, ...groups.otherApi, ...groups.custom, ...groups.local].map((provider) =>
    String(provider.id || provider.provider || '')
  );
}

// Effective model rows: the provider row's `models` and the discovery result's.
function customModels(provider: RecordValue): CustomModel[] {
  return rows(provider.models).flatMap((model) => (model.id ? [model as unknown as CustomModel] : []));
}

// The provider's manually added model ids (v2 `modelOverrides[id].manual`).
function manualModels(provider: RecordValue | undefined): CustomModel[] {
  return Object.entries(record(provider?.modelOverrides)).flatMap(([id, override]) =>
    record(override).manual === true ? [{ id }] : []
  );
}

// The v2 overrides to save: every stored override kept (so per-model
// settings survive), `manual` set exactly for the listed manual models.
function overridesWithManual(overrides: RecordValue, manual: CustomModel[]): RecordValue {
  const out: RecordValue = {};
  for (const [id, override] of Object.entries(overrides)) {
    const { manual: _manual, ...rest } = record(override);
    if (Object.keys(rest).length) out[id] = rest;
  }
  for (const model of manual) out[model.id] = { ...record(out[model.id]), manual: true };
  return out;
}

function protocolLabel(value: unknown): string {
  return CUSTOM_PROTOCOLS.find((item) => item.value === value)?.label ?? String(value || '');
}

// The runtime's custom provider name limit (custom-provider-config.mjs MAX_NAME).
const CUSTOM_NAME_MAX = 200;

const stripProviderTag = (raw: string): string => raw.replace(/^\[custom-provider\]\s*/, '').trim();

// Strips the runtime's "[custom-provider]" tag, then maps the known failures to localized text.
function friendlyMessage(raw: string): string {
  const message = stripProviderTag(raw);
  const timeout = /first byte timed out after (\d+)ms/i.exec(message);
  const testTimeout = /timed out after (\d+)s\b/i.exec(message);
  if (timeout || testTimeout) {
    return t('The server did not respond: timed out after {{seconds}} seconds.', {
      seconds: timeout ? String(Math.round(Number(timeout[1]) / 1000)) : String(testTimeout?.[1]),
    });
  }
  if (/^(?:TypeError:\s*)?(?:custom provider )?name (?:is invalid|is required|must)/i.test(message)) {
    return t('Enter a valid display name (at most {{max}} characters, no control characters).', {
      max: String(CUSTOM_NAME_MAX),
    });
  }
  const status = /\bmodels (\d{3})\b/.exec(message);
  if (status) return t('The model list request failed (HTTP {{status}}).', { status: status[1] });
  if (/^(?:Error:\s*)?(?:Connection error\.?|fetch failed|connect ECONNREFUSED.*)$/i.test(message)) {
    return t('Could not connect to the server. Check the URL and that the server is running.');
  }
  return message;
}

function failure(reason: unknown): string {
  return friendlyMessage(errorMessageText(reason));
}

type Run = PanelContext['run'];

function nameError(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return t('Enter a display name.');
  if (trimmed.length > CUSTOM_NAME_MAX) {
    return t('The display name must be at most {{max}} characters.', { max: String(CUSTOM_NAME_MAX) });
  }
  return '';
}

const API_KEY_ENV_PATTERN = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;

/** The form as the runtime's custom provider input; throws the message to
 *  show for a Base URL that is not HTTPS (or loopback HTTP) or an invalid
 *  environment variable name. */
function customProviderInput({
  provider,
  name,
  protocol,
  baseURL,
  keyless,
  overrides,
  models,
  modelDraft,
  envMode,
  envValid,
  envName,
  apiKey,
  savedEnv,
}: {
  provider?: RecordValue;
  name: string;
  protocol: Protocol;
  baseURL: string;
  keyless: boolean;
  overrides: RecordValue;
  models: CustomModel[];
  modelDraft: string;
  envMode: boolean;
  envValid: boolean;
  envName: string;
  apiKey: string;
  savedEnv: string;
}): RecordValue {
  let url: URL | null = null;
  try {
    url = new URL(baseURL.trim());
  } catch {
    // Reported below.
  }
  const loopback = url !== null && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (!url || (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback))) {
    throw new Error(t('Base URL must use HTTPS (HTTP is allowed only for localhost).'));
  }
  // Every visible manual model is submitted as a v2 manual override (the
  // user can remove any); none means automatic discovery.
  const draft = modelDraft.trim();
  const withDraft = draft && !models.some((model) => model.id === draft) ? [...models, { id: draft }] : models;
  const input: RecordValue = {
    schemaVersion: 2,
    name: name.trim(),
    protocol,
    baseURL: baseURL.trim(),
    auth: keyless ? 'none' : 'key',
    modelOverrides: overridesWithManual(overrides, withDraft),
  };
  if (provider) input.id = provider.id;
  if (!keyless && envMode) {
    if (!envValid) {
      throw new Error(
        t('Enter a valid environment variable name (letters, digits and underscores; it cannot start with a digit).')
      );
    }
    input.apiKeyEnv = envName.trim();
  } else {
    if (!keyless && apiKey.trim()) input.apiKey = apiKey;
    if (savedEnv) input.apiKeyEnv = null;
  }
  return input;
}

// Guidance comes only from the backend's explicit discovery error kind.
function discoveryFailure(error: RecordValue): string {
  switch (error.kind) {
    case 'unavailable':
      return t(
        'The model list could not be loaded (HTTP {{status}}). Check the URL or add model IDs manually; a model request is needed to verify the connection.',
        { status: String(error.status ?? '') }
      );
    case 'authentication':
      return t(
        'Model discovery was refused (authentication or access error). Check the API key and its access permissions.'
      );
    case 'empty':
      return t('Automatic discovery returned no models. Add model IDs manually.');
    case 'timeout':
      return t('The service did not return its model list in time. Retry later, or add model IDs manually.');
    default: {
      if (serverFailure(error)) {
        return t(
          'The service failed to return its model list (HTTP {{status}}). Retry later, or add model IDs manually.',
          { status: String(error.status) }
        );
      }
      const raw = String(error.message || '');
      const friendly = friendlyMessage(raw);
      // A recognized failure already reads as a full sentence.
      if (friendly !== stripProviderTag(raw)) return friendly;
      return t('Model discovery failed: {{message}}. Check your connection and retry.', { message: friendly });
    }
  }
}

const serverFailure = (error: RecordValue) =>
  error.kind === 'request' && typeof error.status === 'number' && error.status >= 500;

// Only these outcomes make manual entry the next step.
const needsManualEntry = (error: RecordValue) =>
  error.kind === 'unavailable' || error.kind === 'empty' || error.kind === 'timeout' || serverFailure(error);

/** The failure of a discovery answer; null when it listed models. */
function discoveryOutcome(found: RecordValue, listed: CustomModel[]): RecordValue | null {
  if (found.error) return record(found.error);
  return listed.length ? null : { kind: 'empty' };
}

/** The form's connection actions — Refresh models, Test connection, Save —
 *  and their outcome. One attempt runs at a time; discovery can take up to a
 *  minute on a slow service, so "Stop waiting" bumps the attempt: the pending
 *  answer is then ignored and manual entry opens. */
function useCustomProviderConnection({
  run,
  uid,
  buildInput,
  setRows,
  openManualEntry,
  onSaved,
}: {
  run: Run;
  uid: string;
  /** The runtime input; throws the message to show for an invalid form. */
  buildInput(): RecordValue;
  /** The discovered model rows (Refresh models). */
  setRows(rows: CustomModel[]): void;
  openManualEntry(): void;
  onSaved(): void;
}) {
  const [working, setWorking] = useState<'' | 'test' | 'save'>('');
  const [testResult, setTestResult] = useState<{ ok: boolean; message: string } | null>(null);
  const [saveError, setSaveError] = useState('');
  // Discovery errors come from discoverCustomProviderModels (Refresh models).
  const [discoveryError, setDiscoveryError] = useState('');
  const attempt = useRef(0);

  const refreshModels = async () => {
    const mine = ++attempt.current;
    setWorking('test');
    setSaveError('');
    try {
      const found = record(
        await run('discoverCustomProviderModels', [buildInput()], `custom-refresh-${uid}`, false, true, 'throw')
      );
      if (attempt.current !== mine) return;
      const listed = customModels(found);
      setRows(listed);
      const error = discoveryOutcome(found, listed);
      setDiscoveryError(error ? discoveryFailure(error) : '');
      if (error && needsManualEntry(error)) openManualEntry();
    } catch (reason) {
      if (attempt.current === mine) setDiscoveryError(failure(reason));
    } finally {
      if (attempt.current === mine) setWorking('');
    }
  };

  // Automatic discovery for an empty catalog during registration. Returns true
  // when models were found; otherwise reports guidance and opens manual entry
  // (unless the user stopped waiting meanwhile).
  const discover = async (input: RecordValue, mine: number): Promise<boolean> => {
    const found = record(
      await run('discoverCustomProviderModels', [input], `custom-discover-${uid}`, false, true, 'throw')
    );
    const error = discoveryOutcome(found, customModels(found));
    if (!error) return true;
    if (attempt.current === mine) {
      setSaveError(discoveryFailure(error));
      if (needsManualEntry(error)) openManualEntry();
    }
    return false;
  };

  const test = async () => {
    const mine = ++attempt.current;
    setWorking('test');
    setTestResult(null);
    try {
      const result = record(
        await run('testCustomProvider', [buildInput()], `custom-test-${uid}`, false, true, 'throw')
      );
      if (attempt.current !== mine) return;
      if (result.ok !== true && result.phase === 'discovery') {
        const error = record(result.error);
        if (needsManualEntry(error)) openManualEntry();
        setTestResult({ ok: false, message: discoveryFailure(error) });
        return;
      }
      setTestResult(
        result.ok === true
          ? { ok: true, message: t('Connection successful.') }
          : { ok: false, message: t('Connection test failed.') }
      );
    } catch (reason) {
      if (attempt.current === mine) setTestResult({ ok: false, message: failure(reason) });
    } finally {
      if (attempt.current === mine) setWorking('');
    }
  };

  /** `precheck` throws the message to show for a form that cannot be saved. */
  const save = async (precheck: () => void) => {
    const mine = ++attempt.current;
    setWorking('save');
    setSaveError('');
    try {
      precheck();
      const input = buildInput();
      if (!manualModels(input).length) {
        // An environment key may be unset yet: discovery failing then is not a reason to refuse saving.
        const viaEnv = input.apiKeyEnv !== undefined && input.apiKeyEnv !== null;
        const found = viaEnv ? await discover(input, mine).catch(() => false) : await discover(input, mine);
        if (attempt.current !== mine) return;
        if (viaEnv) setSaveError('');
        else if (!found) {
          setWorking('');
          return;
        }
      }
      const saved = await run('saveCustomProvider', [input], `custom-save-${uid}`, true, true, 'throw');
      if (!saved) throw new Error(t('Could not save the custom provider.'));
      onSaved();
    } catch (reason) {
      if (attempt.current !== mine) return;
      setSaveError(failure(reason));
      setWorking('');
    }
  };

  return {
    working,
    testResult,
    saveError,
    discoveryError,
    refreshModels,
    test,
    save,
    stopWaiting() {
      attempt.current += 1;
      setWorking('');
      openManualEntry();
    },
    /** An edited field invalidates the last test and save outcome. */
    clearOutcome() {
      setTestResult(null);
      setSaveError('');
    },
    clearSaveError: () => setSaveError(''),
  };
}

/** What the form's last connection attempt came to: the wait notice, then the discovery, test and save results. */
function CustomProviderOutcome({
  working,
  discoveryError,
  testResult,
  saveError,
}: {
  working: boolean;
  discoveryError: string;
  testResult: { ok: boolean; message: string } | null;
  saveError: string;
}) {
  return (
    <>
      {working && (
        <p role="status">
          {t('Waiting for the service to list its models. This can take up to a minute; you can stop waiting.')}
        </p>
      )}
      {discoveryError && (
        <p className="settings-error" role="alert">
          {discoveryError}
        </p>
      )}
      <div aria-live="polite">
        {testResult && (
          <p
            className={testResult.ok ? 'settings-success' : 'settings-error'}
            role={testResult.ok ? 'status' : 'alert'}
          >
            {testResult.message}
          </p>
        )}
        {saveError && (
          <p className="settings-error" role="alert">
            {saveError}
          </p>
        )}
      </div>
    </>
  );
}

function CustomProviderForm({
  provider,
  run,
  busy,
  onClose,
}: {
  provider?: RecordValue;
  run: Run;
  busy: boolean;
  onClose(): void;
}) {
  const uid = useId();
  const [rows, setRows] = useState<CustomModel[]>(provider ? customModels(provider) : []);
  // A saved model edit (or any other change of the provider's effective
  // models) refreshes the rows; the other form fields keep their drafts.
  const modelsKey = provider ? JSON.stringify(customModels(provider)) : '';
  const shownModelsKey = useRef(modelsKey);
  useEffect(() => {
    if (shownModelsKey.current === modelsKey) return;
    shownModelsKey.current = modelsKey;
    setRows(provider ? customModels(provider) : []);
  }, [modelsKey, provider]);
  // A model save stores that model's override at once, but `provider` keeps
  // the earlier overrides until the panel's reload lands; saving the provider
  // from them would undo the model save. The save's answer wins per model.
  const [savedOverrides, setSavedOverrides] = useState<RecordValue>({});
  const overrides = { ...record(provider?.modelOverrides), ...savedOverrides };
  const existing = manualModels(provider);
  const [keyless, setKeyless] = useState(provider?.auth === 'none');
  const [editingModel, setEditingModel] = useState<string | null>(null);
  const [name, setName] = useState(provider ? String(provider.name || '') : '');
  const [protocol, setProtocol] = useState<Protocol>(
    CUSTOM_PROTOCOLS.some((item) => item.value === provider?.protocol)
      ? (provider?.protocol as Protocol)
      : 'openai-chat'
  );
  const [baseURL, setBaseURL] = useState(provider ? String(provider.baseURL || '') : '');
  const [apiKey, setApiKey] = useState('');
  const savedEnv = typeof provider?.apiKeyEnv === 'string' ? provider.apiKeyEnv : '';
  const [envMode, setEnvMode] = useState(savedEnv !== '');
  const [envName, setEnvName] = useState(savedEnv);
  const envValid = API_KEY_ENV_PATTERN.test(envName.trim());
  const [nameProblem, setNameProblem] = useState('');
  const [models, setModels] = useState<CustomModel[]>(existing);
  const [manualOpen, setManualOpen] = useState(existing.length > 0);
  const [modelDraft, setModelDraft] = useState('');

  const checkedName = envMode && !keyless && envValid ? envName.trim() : '';
  const envFound = useKeyEnvPresence(run, uid, checkedName);

  const buildInput = () =>
    customProviderInput({
      provider,
      name,
      protocol,
      baseURL,
      keyless,
      overrides,
      models,
      modelDraft,
      envMode,
      envValid,
      envName,
      apiKey,
      savedEnv,
    });
  const connection = useCustomProviderConnection({
    run,
    uid,
    buildInput,
    setRows,
    openManualEntry: () => setManualOpen(true),
    onSaved: onClose,
  });
  const { working, testResult, saveError, discoveryError, refreshModels, test, stopWaiting } = connection;
  const changed = connection.clearOutcome;
  const disabled = busy || working !== '';
  const close = () => {
    if (!disabled) onClose();
  };
  useMobileBack(true, close);
  useEffect(() => acquireTitleBarDim(), []);
  const connectionReady = baseURL.trim() !== '';
  // A saved key (stored or from the environment) is kept only when this provider already has one.
  const needsKey = !provider || provider.auth === 'none' || savedEnv !== '';

  const addModel = () => {
    const id = modelDraft.trim();
    if (id && !models.some((model) => model.id === id)) setModels([...models, { id }]);
    setModelDraft('');
    changed();
  };

  const save = async (event: FormEvent) => {
    event.preventDefault();
    const problem = nameError(name);
    setNameProblem(problem);
    if (problem) return;
    await connection.save(() => {
      if (!keyless && !envMode && !apiKey.trim() && needsKey) throw new Error(t('No API key'));
    });
  };

  const nameId = `${uid}-name`;
  const urlId = `${uid}-url`;
  const keyId = `${uid}-key`;
  const formId = `${uid}-form`;
  return (
    // Scrim click-to-dismiss; keyboard dismissal is the dialog's close button and Escape.
    <div className="settings-oauth-layer" {...scrimDismiss(close)}>
      <section
        className="settings-oauth-dialog settings-custom-provider-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby={`${uid}-title`}
        data-settings-nested-dialog
      >
        <header>
          <div>
            <h3 id={`${uid}-title`}>{provider ? t('Edit custom provider') : t('Add custom provider')}</h3>
          </div>
          <button type="button" aria-label={t('Close')} data-settings-nested-close disabled={disabled} onClick={close}>
            <X size={16} aria-hidden="true" />
          </button>
        </header>
        <form
          id={formId}
          className="settings-custom-provider-form"
          aria-label={provider ? t('Edit custom provider') : t('Add custom provider')}
          onSubmit={(event) => void save(event)}
        >
          <label htmlFor={nameId}>{t('Display name')}</label>
          <input
            id={nameId}
            value={name}
            disabled={disabled}
            required
            // biome-ignore lint/a11y/noAutofocus: the dialog's first field takes focus on open.
            autoFocus
            autoComplete="off"
            maxLength={CUSTOM_NAME_MAX}
            aria-invalid={nameProblem !== ''}
            aria-describedby={nameProblem ? `${nameId}-error` : undefined}
            onChange={(event) => {
              setName(event.target.value);
              setNameProblem('');
              connection.clearSaveError();
            }}
          />
          {nameProblem && (
            <p id={`${nameId}-error`} className="settings-error" role="alert">
              {nameProblem}
            </p>
          )}
          {/* biome-ignore lint/a11y/noLabelWithoutControl: labels the custom OpenSelect, which carries its own aria-label. */}
          <label>{t('API format')}</label>
          <OpenSelect
            className="settings-select"
            ariaLabel={t('API format')}
            value={protocol}
            disabled={disabled}
            options={CUSTOM_PROTOCOLS}
            onChange={(value) => {
              setProtocol(value as Protocol);
              changed();
            }}
          />
          <label htmlFor={urlId}>{t('Base URL')}</label>
          <input
            id={urlId}
            type="url"
            value={baseURL}
            disabled={disabled}
            required
            autoComplete="off"
            placeholder="https://api.example.com/v1"
            onChange={(event) => {
              setBaseURL(event.target.value);
              changed();
            }}
          />
          <CustomProviderKeyFields
            keyId={keyId}
            envMode={envMode}
            envName={envName}
            envValid={envValid}
            envFound={envFound}
            apiKey={apiKey}
            keyless={keyless}
            disabled={disabled}
            needsKey={needsKey}
            keepsSavedKey={Boolean(provider && provider.auth !== 'none' && !savedEnv)}
            onEnvMode={(env) => {
              setEnvMode(env);
              changed();
            }}
            onEnvName={(value) => {
              setEnvName(value);
              changed();
            }}
            onApiKey={(value) => {
              setApiKey(value);
              changed();
            }}
          />
          <div className="settings-model-check">
            <CompactSwitch
              label={t('No authentication (local server)')}
              checked={keyless}
              disabled={disabled}
              optimistic={false}
              onChange={(next) => {
                setKeyless(next);
                changed();
              }}
            />
            <span>{t('No authentication (local server)')}</span>
          </div>
          <CustomProviderModelsList
            open={manualOpen}
            editable={Boolean(provider)}
            rows={rows}
            models={models}
            modelDraft={modelDraft}
            disabled={disabled}
            onToggle={setManualOpen}
            onDraftChange={(draft) => {
              setModelDraft(draft);
              changed();
            }}
            onAdd={addModel}
            onEdit={setEditingModel}
            onRemove={(explicit) => {
              setModels(models.filter((item) => item !== explicit));
              changed();
            }}
            onRefresh={() => void refreshModels()}
          />
          <CustomProviderOutcome
            working={working !== ''}
            discoveryError={discoveryError}
            testResult={testResult}
            saveError={saveError}
          />
        </form>
        <footer>
          <button type="button" disabled={disabled || !connectionReady} onClick={() => void test()}>
            {t(working === 'test' ? 'Testing…' : 'Test connection')}
          </button>
          {working === '' ? (
            <button type="button" className="secondary" disabled={disabled} onClick={close}>
              {t('Cancel')}
            </button>
          ) : (
            <button type="button" className="secondary" onClick={stopWaiting}>
              {t('Stop waiting')}
            </button>
          )}
          <button type="submit" form={formId} disabled={disabled}>
            {t('Save')}
          </button>
        </footer>
      </section>
      {provider && editingModel !== null && rows.some((row) => row.id === editingModel) && (
        <CustomModelEditor
          providerId={String(provider.id)}
          protocol={protocol}
          row={rows.find((row) => row.id === editingModel) as unknown as RecordValue}
          override={record(overrides[editingModel])}
          run={run}
          onSaved={(saved) => {
            // `run` answers nothing when it could not run; keep what is known then.
            if (!saved.modelOverrides) return;
            const override = record(record(saved.modelOverrides)[editingModel]);
            setSavedOverrides((previous) => ({ ...previous, [editingModel]: override }));
          }}
          onClose={() => setEditingModel(null)}
        />
      )}
    </div>
  );
}

export function CustomProvidersSection({
  providers,
  loading,
  run,
  confirm,
  busy,
}: {
  providers: RecordValue[];
  loading: boolean;
  run: Run;
  confirm: PanelContext['confirm'];
  busy: boolean;
}) {
  const [editing, setEditing] = useState<string | 'new' | null>(null);
  const triggerRef = useRef<HTMLElement | null>(null);
  const openEditor = (id: string) => {
    triggerRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setEditing(id);
  };
  useEffect(() => {
    if (editing === null) triggerRef.current?.focus();
  }, [editing]);
  const status = (provider: RecordValue) => {
    // Raw status words: ResourceRow classifies them, then translates the label.
    if (provider.configError) return 'Failed';
    if (provider.enabled === false) return 'Disabled';
    if (provider.authenticated === false) return 'No API key';
    return 'Connected';
  };
  return (
    <section className="settings-group settings-custom-providers">
      <header>
        <div className="settings-group-head">
          <h3>{t('Custom providers')}</h3>
          <button
            type="button"
            className="settings-action"
            disabled={busy || loading || editing !== null}
            onClick={() => openEditor('new')}
          >
            <Plus size={14} aria-hidden="true" />
            {t('Add custom provider')}
          </button>
        </div>
      </header>
      {providers.length === 0 && (
        <div className="settings-group-body">
          <ListEmpty text={t('No custom providers yet.')} />
        </div>
      )}
      {providers.map((provider) => {
        const id = String(provider.id);
        const total = customModels(provider).length;
        return (
          <div className="settings-group-body" key={id}>
            <ResourceRow
              title={providerLabel(provider)}
              description={`${protocolLabel(provider.protocol)} · ${String(provider.baseURL || '')} · ${t('Models: {{total}}', { total })}`}
              status={status(provider)}
              meta={provider.configError ? String(provider.configError) : undefined}
              actions={
                <>
                  <ActionButton disabled={busy || editing !== null} onClick={() => openEditor(id)}>
                    {t('Edit')}
                  </ActionButton>
                  <ActionButton
                    danger
                    disabled={busy}
                    onClick={() =>
                      confirm({
                        title: t('Delete custom provider?'),
                        description: t(
                          'Remove {{name}} and its saved API key. Its models will no longer be available.',
                          {
                            name: providerLabel(provider),
                          }
                        ),
                        confirmLabel: t('Delete'),
                        danger: true,
                        onConfirm: () => void run('removeCustomProvider', [provider.id]),
                      })
                    }
                  >
                    {t('Delete')}
                  </ActionButton>
                </>
              }
            />
          </div>
        );
      })}
      {editing !== null && (
        <CustomProviderForm
          key={editing}
          provider={editing === 'new' ? undefined : providers.find((provider) => String(provider.id) === editing)}
          run={run}
          busy={busy}
          onClose={() => setEditing(null)}
        />
      )}
    </section>
  );
}
