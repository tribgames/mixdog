import { useEffect, useId, useRef, useState, type FormEvent } from 'react';
import { ChevronDown, Plus, X } from 'lucide-react';

import { t } from '../i18n';
import { OpenSelect } from '../OpenSelect';
import { ActionButton, CompactSwitch, ResourceRow } from './capability-controls';
import { providerLabel, type PanelContext, type RecordValue } from './capability-data';
import { record, rows } from '../record-utils';
import { useMobileBack } from '../mobile-back';
import { acquireTitleBarDim } from '../titlebar-dim';
import { CustomModelEditor } from './custom-model-editor';
import { errorMessageText } from '../ErrorNotice';

export const CUSTOM_PROTOCOLS = [
  { value: 'openai-chat', label: 'OpenAI Chat Completions' },
  { value: 'openai-responses', label: 'OpenAI Responses' },
  { value: 'anthropic', label: 'Anthropic Messages' },
] as const;

type Protocol = (typeof CUSTOM_PROTOCOLS)[number]['value'];
interface CustomModel {
  id: string;
  name?: string;
  contextWindow?: number;
  maxOutputTokens?: number;
  hidden?: boolean;
  manual?: boolean;
}

export function isCustomProvider(provider: RecordValue): boolean {
  return provider.custom === true;
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
function overridesWithManual(provider: RecordValue | undefined, manual: CustomModel[]): RecordValue {
  const out: RecordValue = {};
  for (const [id, override] of Object.entries(record(provider?.modelOverrides))) {
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
export const CUSTOM_NAME_MAX = 200;

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
const ENV_CHECK_DEBOUNCE_MS = 300;

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
    default: {
      const raw = String(error.message || '');
      const friendly = friendlyMessage(raw);
      // A recognized failure already reads as a full sentence.
      if (friendly !== stripProviderTag(raw)) return friendly;
      return t('Model discovery failed: {{message}}. Check your connection and retry.', { message: friendly });
    }
  }
}

// Only these outcomes make manual entry the next step.
const needsManualEntry = (error: RecordValue) => error.kind === 'unavailable' || error.kind === 'empty';

/** The failure of a discovery answer; null when it listed models. */
function discoveryOutcome(found: RecordValue, listed: CustomModel[]): RecordValue | null {
  if (found.error) return record(found.error);
  return listed.length ? null : { kind: 'empty' };
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
  const existing = manualModels(provider);
  const [keyless, setKeyless] = useState(provider?.auth === 'none');
  // Discovery errors come from discoverCustomProviderModels (Refresh models).
  const [discoveryError, setDiscoveryError] = useState('');
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
  const [envFound, setEnvFound] = useState<boolean | null>(null);
  const envValid = API_KEY_ENV_PATTERN.test(envName.trim());
  const [working, setWorking] = useState<'' | 'test' | 'save'>('');
  const [testResult, setTestResult] = useState<{ ok: boolean; message: string } | null>(null);
  const [saveError, setSaveError] = useState('');
  const [nameProblem, setNameProblem] = useState('');
  const [models, setModels] = useState<CustomModel[]>(existing);
  const [manualOpen, setManualOpen] = useState(existing.length > 0);
  const [modelDraft, setModelDraft] = useState('');
  const disabled = busy || working !== '';
  const close = () => {
    if (!disabled) onClose();
  };
  useMobileBack(true, close);
  useEffect(() => acquireTitleBarDim(), []);

  // Debounced presence check of the named variable (on open and on typing).
  const checkedName = envMode && !keyless && envValid ? envName.trim() : '';
  const runRef = useRef(run);
  runRef.current = run;
  useEffect(() => {
    setEnvFound(null);
    if (!checkedName) return;
    let stale = false;
    const timer = setTimeout(() => {
      runRef.current('checkCustomProviderKeyEnv', [checkedName], `custom-env-${uid}`, false, true, 'throw').then(
        (result) => {
          if (!stale) setEnvFound(record(result).found === true);
        },
        () => {
          if (!stale) setEnvFound(null);
        }
      );
    }, ENV_CHECK_DEBOUNCE_MS);
    return () => {
      stale = true;
      clearTimeout(timer);
    };
  }, [checkedName, uid]);

  const buildInput = () => {
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
      modelOverrides: overridesWithManual(provider, withDraft),
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
  };
  const refreshModels = async () => {
    setWorking('test');
    setSaveError('');
    try {
      const found = record(
        await run('discoverCustomProviderModels', [buildInput()], `custom-refresh-${uid}`, false, true, 'throw')
      );
      const listed = customModels(found);
      setRows(listed);
      const error = discoveryOutcome(found, listed);
      setDiscoveryError(error ? discoveryFailure(error) : '');
      if (error && needsManualEntry(error)) setManualOpen(true);
    } catch (reason) {
      setDiscoveryError(failure(reason));
    } finally {
      setWorking('');
    }
  };
  const connectionReady = baseURL.trim() !== '';
  // A saved key (stored or from the environment) is kept only when this provider already has one.
  const needsKey = !provider || provider.auth === 'none' || savedEnv !== '';
  const changed = () => {
    setTestResult(null);
    setSaveError('');
  };

  const addModel = () => {
    const id = modelDraft.trim();
    if (id && !models.some((model) => model.id === id)) setModels([...models, { id }]);
    setModelDraft('');
    changed();
  };

  // Automatic discovery for an empty catalog during registration. Returns true
  // when models were found; otherwise reports guidance and opens manual entry.
  const discover = async (input: RecordValue): Promise<boolean> => {
    const found = record(
      await run('discoverCustomProviderModels', [input], `custom-discover-${uid}`, false, true, 'throw')
    );
    const error = discoveryOutcome(found, customModels(found));
    if (!error) return true;
    setSaveError(discoveryFailure(error));
    if (needsManualEntry(error)) setManualOpen(true);
    return false;
  };

  const test = async () => {
    setWorking('test');
    setTestResult(null);
    try {
      const result = record(
        await run('testCustomProvider', [buildInput()], `custom-test-${uid}`, false, true, 'throw')
      );
      if (result.ok !== true && result.phase === 'discovery') {
        const error = record(result.error);
        if (needsManualEntry(error)) setManualOpen(true);
        setTestResult({ ok: false, message: discoveryFailure(error) });
        return;
      }
      setTestResult(
        result.ok === true
          ? { ok: true, message: t('Connection successful.') }
          : { ok: false, message: t('Connection test failed.') }
      );
    } catch (reason) {
      setTestResult({ ok: false, message: failure(reason) });
    } finally {
      setWorking('');
    }
  };

  const save = async (event: FormEvent) => {
    event.preventDefault();
    const problem = nameError(name);
    setNameProblem(problem);
    if (problem) return;
    setWorking('save');
    setSaveError('');
    try {
      if (!keyless && !envMode && !apiKey.trim() && needsKey) throw new Error(t('No API key'));
      const input = buildInput();
      if (!manualModels(input).length) {
        // An environment key may be unset yet: discovery failing then is not a reason to refuse saving.
        const viaEnv = input.apiKeyEnv !== undefined && input.apiKeyEnv !== null;
        const found = viaEnv ? await discover(input).catch(() => false) : await discover(input);
        if (viaEnv) setSaveError('');
        else if (!found) {
          setWorking('');
          return;
        }
      }
      const saved = await run('saveCustomProvider', [input], `custom-save-${uid}`, true, true, 'throw');
      if (!saved) throw new Error(t('Could not save the custom provider.'));
      onClose();
    } catch (reason) {
      setSaveError(failure(reason));
      setWorking('');
    }
  };

  const nameId = `${uid}-name`;
  const urlId = `${uid}-url`;
  const keyId = `${uid}-key`;
  const formId = `${uid}-form`;
  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: scrim click-to-dismiss; keyboard dismissal is the dialog's close button and Escape.
    <div
      className="settings-oauth-layer"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) close();
      }}
    >
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
              setSaveError('');
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
          <div className="settings-custom-provider-key-row">
            <label htmlFor={keyId}>{envMode ? t('API key environment variable') : t('API key')}</label>
            {/* biome-ignore lint/a11y/useSemanticElements: a div button group, same as the MCP transport picker. */}
            <div className="mx-segmented mx-segmented-compact" role="group" aria-label={t('API key source')}>
              {[
                { env: false, label: t('Direct input') },
                { env: true, label: t('Environment variable') },
              ].map((option) => (
                <button
                  key={option.label}
                  type="button"
                  aria-pressed={envMode === option.env}
                  disabled={disabled || keyless}
                  onClick={() => {
                    setEnvMode(option.env);
                    changed();
                  }}
                >
                  {option.label}
                </button>
              ))}
            </div>
          </div>
          {envMode ? (
            <input
              id={keyId}
              type="text"
              className="settings-custom-provider-env"
              value={envName}
              disabled={disabled || keyless}
              required={!keyless}
              aria-invalid={envName.trim() !== '' && !envValid}
              autoComplete="off"
              spellCheck={false}
              placeholder="MY_API_KEY"
              onChange={(event) => {
                setEnvName(event.target.value);
                changed();
              }}
            />
          ) : (
            <input
              id={keyId}
              type="password"
              value={apiKey}
              disabled={disabled || keyless}
              required={!keyless && needsKey}
              autoComplete="new-password"
              placeholder={
                provider && provider.auth !== 'none' && !savedEnv
                  ? t('Leave blank to keep the saved key')
                  : t('API key')
              }
              onChange={(event) => {
                setApiKey(event.target.value);
                changed();
              }}
            />
          )}
          {envMode && !keyless && envFound !== null && (
            <p className={`settings-custom-provider-hint ${envFound ? 'ok' : 'warn'}`} role="status">
              {envFound
                ? t('Environment variable found. The key is read each time and is not stored.')
                : t('{{name}} was not found yet. If you just set it, restart Mixdog to apply it.', {
                    name: envName.trim(),
                  })}
            </p>
          )}
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
          <details
            className="settings-custom-models"
            open={manualOpen}
            onToggle={(event) => setManualOpen(event.currentTarget.open)}
          >
            <summary>
              <span>{t('Add models manually')}</span>
              <ChevronDown size={14} aria-hidden="true" />
            </summary>
            <p>{t('Optional. Leave empty to discover models automatically.')}</p>
            <div className="settings-custom-models-add">
              <input
                value={modelDraft}
                disabled={disabled}
                autoComplete="off"
                aria-label={t('Model ID')}
                placeholder={t('Model ID')}
                onChange={(event) => {
                  setModelDraft(event.target.value);
                  changed();
                }}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' && !event.nativeEvent.isComposing) {
                    event.preventDefault();
                    addModel();
                  }
                }}
              />
              <button
                type="button"
                className="provider-account-add-button"
                aria-label={t('Add model')}
                title={t('Add model')}
                disabled={disabled || !modelDraft.trim()}
                onClick={addModel}
              >
                <Plus size={16} aria-hidden="true" />
              </button>
            </div>
            <ul>
              {(provider
                ? [...rows, ...models.filter((model) => !rows.some((row) => row.id === model.id))]
                : models
              ).map((model) => {
                const explicit = models.find((item) => item.id === model.id);
                const backed = rows.some((row) => row.id === model.id);
                return (
                  <li
                    className={`extensions-mcp-list-row${model.hidden ? ' settings-model-hidden' : ''}`}
                    key={model.id}
                  >
                    <span title={model.id}>
                      {model.id}
                      {model.hidden ? ` (${t('Hidden')})` : ''}
                    </span>
                    {provider && backed && (
                      <button
                        type="button"
                        className="secondary"
                        disabled={disabled}
                        aria-label={t('Edit model {{name}}', { name: model.id })}
                        onClick={() => setEditingModel(model.id)}
                      >
                        {t('Edit')}
                      </button>
                    )}
                    {explicit && (
                      <button
                        type="button"
                        disabled={disabled}
                        aria-label={t('Remove {{name}}', { name: model.id })}
                        onClick={() => {
                          setModels(models.filter((item) => item !== explicit));
                          changed();
                        }}
                      >
                        <X size={14} aria-hidden="true" />
                      </button>
                    )}
                  </li>
                );
              })}
            </ul>
            {provider && (
              <button type="button" className="secondary" disabled={disabled} onClick={() => void refreshModels()}>
                {t('Refresh models')}
              </button>
            )}
          </details>
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
        </form>
        <footer>
          <button type="button" disabled={disabled || !connectionReady} onClick={() => void test()}>
            {t(working === 'test' ? 'Testing…' : 'Test connection')}
          </button>
          <button type="button" className="secondary" disabled={disabled} onClick={close}>
            {t('Cancel')}
          </button>
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
          override={record(record(provider.modelOverrides)[editingModel])}
          run={run}
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
  const status = (provider: RecordValue) =>
    // Raw status words: ResourceRow classifies them, then translates the label.
    provider.configError
      ? 'Failed'
      : provider.enabled === false
        ? 'Disabled'
        : provider.authenticated === false
          ? 'No API key'
          : 'Connected';
  return (
    <section className="settings-group settings-custom-providers">
      <header>
        <h3>{t('Custom providers')}</h3>
      </header>
      <div className="settings-group-body">
        <ResourceRow
          title={t('Add custom provider')}
          actions={
            <button
              type="button"
              className="provider-account-add-button"
              disabled={busy || loading || editing !== null}
              aria-label={t('Add custom provider')}
              title={t('Add custom provider')}
              onClick={() => openEditor('new')}
            >
              <Plus size={16} aria-hidden="true" />
            </button>
          }
        />
      </div>
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
