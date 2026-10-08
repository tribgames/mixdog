import { useEffect, useId, useRef, useState, type FormEvent } from 'react';
import { Plus, X } from 'lucide-react';

import { t } from '../i18n';
import { ActionButton, ResourceRow } from './capability-controls';
import { providerLabel, type PanelContext, type RecordValue } from './capability-data';
import { record, rows } from '../record-utils';
import { useMobileBack } from '../mobile-back';
import { acquireTitleBarDim } from '../titlebar-dim';

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
}

export function isCustomProvider(provider: RecordValue): boolean {
  return provider.custom === true;
}

function customModels(provider: RecordValue): CustomModel[] {
  return rows(provider.models).flatMap((model) => (model.id ? [model as unknown as CustomModel] : []));
}

function protocolLabel(value: unknown): string {
  return CUSTOM_PROTOCOLS.find((item) => item.value === value)?.label ?? String(value || '');
}

function failure(reason: unknown): string {
  return reason instanceof Error ? reason.message : String(reason);
}

type Run = PanelContext['run'];

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
  const existing = provider ? customModels(provider) : [];
  const [name, setName] = useState(provider ? String(provider.name || '') : '');
  const [protocol, setProtocol] = useState<Protocol>(
    CUSTOM_PROTOCOLS.some((item) => item.value === provider?.protocol) ? (provider?.protocol as Protocol) : 'openai-chat'
  );
  const [baseURL, setBaseURL] = useState(provider ? String(provider.baseURL || '') : '');
  const [apiKey, setApiKey] = useState('');
  const [working, setWorking] = useState<'' | 'test' | 'save'>('');
  const [testResult, setTestResult] = useState<{ ok: boolean; message: string } | null>(null);
  const [saveError, setSaveError] = useState('');
  const disabled = busy || working !== '';
  const close = () => {
    if (!disabled) onClose();
  };
  useMobileBack(true, close);
  useEffect(() => acquireTitleBarDim(), []);

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
    // An empty model list uses the existing post-save provider catalog loader.
    // Preserve older explicit model configurations when editing that endpoint.
    const models = provider?.protocol === protocol && provider?.baseURL === baseURL.trim() ? existing : [];
    const input: RecordValue = { name: name.trim(), protocol, baseURL: baseURL.trim(), models };
    if (provider) input.id = provider.id;
    if (apiKey.trim()) input.apiKey = apiKey;
    return input;
  };
  const connectionReady = baseURL.trim() !== '';
  const changed = () => {
    setTestResult(null);
    setSaveError('');
  };

  const test = async () => {
    setWorking('test');
    setTestResult(null);
    try {
      const result = record(await run('testCustomProvider', [buildInput()], `custom-test-${uid}`, false, true, 'throw'));
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
    setWorking('save');
    setSaveError('');
    try {
      if (!provider && !apiKey.trim()) throw new Error(t('No API key'));
      const saved = await run('saveCustomProvider', [buildInput()], `custom-save-${uid}`, true, true, 'throw');
      if (!saved) throw new Error(t('Could not save the custom provider.'));
      onClose();
    } catch (reason) {
      setSaveError(failure(reason));
      setWorking('');
    }
  };

  const nameId = `${uid}-name`;
  const protocolId = `${uid}-protocol`;
  const urlId = `${uid}-url`;
  const keyId = `${uid}-key`;
  const formId = `${uid}-form`;
  return (
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
        autoFocus
        autoComplete="off"
        onChange={(event) => {
          setName(event.target.value);
          setSaveError('');
        }}
      />
      <label htmlFor={protocolId}>{t('API format')}</label>
      <select
        id={protocolId}
        value={protocol}
        disabled={disabled}
        onChange={(event) => {
          setProtocol(event.target.value as Protocol);
          changed();
        }}
      >
        {CUSTOM_PROTOCOLS.map((item) => (
          <option key={item.value} value={item.value}>
            {item.label}
          </option>
        ))}
      </select>
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
      <label htmlFor={keyId}>{t('API key')}</label>
      <input
        id={keyId}
        type="password"
        value={apiKey}
        disabled={disabled}
        required={!provider}
        autoComplete="new-password"
        placeholder={provider ? t('Leave blank to keep the saved key') : t('API key')}
        onChange={(event) => {
          setApiKey(event.target.value);
          changed();
        }}
      />
      <div aria-live="polite">
        {testResult && (
          <p className={testResult.ok ? 'settings-success' : 'settings-error'} role={testResult.ok ? 'status' : 'alert'}>
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
    provider.enabled === false ? t('Disabled') : provider.authenticated === false ? t('No API key') : t('Connected');
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
                actions={
                  <>
                    <ActionButton disabled={busy || editing !== null} onClick={() => openEditor(id)}>
                      Edit
                    </ActionButton>
                    <ActionButton
                      danger
                      disabled={busy}
                      onClick={() =>
                        confirm({
                          title: 'Delete custom provider?',
                          description: t('Remove {{name}} and its saved API key. Its models will no longer be available.', {
                            name: providerLabel(provider),
                          }),
                          confirmLabel: 'Delete',
                          danger: true,
                          onConfirm: () => void run('removeCustomProvider', [provider.id]),
                        })
                      }
                    >
                      Delete
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
          provider={editing === 'new' ? undefined : providers.find(provider => String(provider.id) === editing)}
          run={run}
          busy={busy}
          onClose={() => setEditing(null)}
        />
      )}
    </section>
  );
}
