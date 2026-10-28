import { useEffect, useRef, useState } from 'react';
import { X } from 'lucide-react';

import { t } from '../i18n';
import type { PanelContext, RecordValue } from './capability-data';
import { record, rows } from '../record-utils';

const ENV_CHECK_DEBOUNCE_MS = 300;
// The primary key and its additional keys make provider-accounts.mjs MAX_ACCOUNTS (20).
const MAX_EXTRA_KEYS = 19;

/** One additional key row: `id` for a saved key (a blank value keeps it), `apiKey` as typed. */
export type ExtraKeyRow = { id?: string; apiKey: string };

/** The provider's saved additional keys, by id only (values never reach the renderer). */
export function extraKeyRows(provider?: RecordValue): ExtraKeyRow[] {
  return rows(provider?.extraApiKeys).flatMap((row): ExtraKeyRow[] =>
    typeof row.id === 'string' ? [{ id: row.id, apiKey: '' }] : []
  );
}

/** The save input's `extraApiKeys`: a saved key keeps its id, a blank new row is dropped. */
export function extraKeysInput(values: ExtraKeyRow[]): RecordValue[] {
  return values
    .filter((row) => row.id || row.apiKey.trim())
    .map((row) => ({ ...(row.id ? { id: row.id } : {}), ...(row.apiKey.trim() ? { apiKey: row.apiKey } : {}) }));
}

/** "Additional keys": masked rows tried in order once a key hits its usage limit. */
export function CustomProviderExtraKeys({
  values,
  disabled,
  onChange,
}: {
  values: ExtraKeyRow[];
  disabled: boolean;
  onChange(values: ExtraKeyRow[]): void;
}) {
  return (
    <>
      {/* biome-ignore lint/a11y/noLabelWithoutControl: titles the key rows below, each with its own aria-label. */}
      <label>{t('Additional keys')}</label>
      <p className="settings-custom-provider-note">
        {t('Additional keys are used in order when one hits its usage limit.')}
      </p>
      {values.length > 0 && (
        <div className="extensions-mcp-list-rows">
          {values.map((row, index) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: key rows are edited by position and never reorder.
            <div className="extensions-mcp-list-row" key={index}>
              <input
                type="password"
                value={row.apiKey}
                disabled={disabled}
                autoComplete="new-password"
                aria-label={t('Additional key {{number}}', { number: String(index + 1) })}
                placeholder={row.id ? t('Leave blank to keep the saved key') : t('API key')}
                onChange={(event) => {
                  const value = event.currentTarget.value;
                  onChange(values.map((entry, rowIndex) => (rowIndex === index ? { ...entry, apiKey: value } : entry)));
                }}
              />
              <button
                type="button"
                aria-label={t('Remove additional key {{number}}', { number: String(index + 1) })}
                disabled={disabled}
                onClick={() => onChange(values.filter((_, rowIndex) => rowIndex !== index))}
              >
                <X size={14} aria-hidden="true" />
              </button>
            </div>
          ))}
        </div>
      )}
      <button
        type="button"
        className="extensions-mcp-list-add"
        disabled={disabled || values.length >= MAX_EXTRA_KEYS}
        onClick={() => onChange([...values, { apiKey: '' }])}
      >
        + {t('Add key')}
      </button>
    </>
  );
}

/** Debounced presence check of the named API key variable (on open and on
 *  typing): null while unchecked, unknown, or with no name to check. */
export function useKeyEnvPresence(run: PanelContext['run'], uid: string, checkedName: string): boolean | null {
  const [envFound, setEnvFound] = useState<boolean | null>(null);
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
  return envFound;
}

/** The API key source (typed in, or read from an environment variable), its
 *  field, and the variable's presence hint. */
export function CustomProviderKeyFields({
  keyId,
  envMode,
  envName,
  envValid,
  envFound,
  apiKey,
  keyless,
  disabled,
  needsKey,
  keepsSavedKey,
  onEnvMode,
  onEnvName,
  onApiKey,
}: {
  keyId: string;
  envMode: boolean;
  envName: string;
  envValid: boolean;
  envFound: boolean | null;
  apiKey: string;
  keyless: boolean;
  disabled: boolean;
  needsKey: boolean;
  /** A blank key keeps the provider's saved one. */
  keepsSavedKey: boolean;
  onEnvMode(env: boolean): void;
  onEnvName(name: string): void;
  onApiKey(key: string): void;
}) {
  const keyPlaceholder = keepsSavedKey ? t('Leave blank to keep the saved key') : t('API key');
  const envHint = envFound
    ? t('Environment variable found. The key is read each time and is not stored.')
    : t('{{name}} was not found yet. If you just set it, restart Mixdog to apply it.', { name: envName.trim() });
  return (
    <>
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
              onClick={() => onEnvMode(option.env)}
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
          onChange={(event) => onEnvName(event.target.value)}
        />
      ) : (
        <input
          id={keyId}
          type="password"
          value={apiKey}
          disabled={disabled || keyless}
          required={!keyless && needsKey}
          autoComplete="new-password"
          placeholder={keyPlaceholder}
          onChange={(event) => onApiKey(event.target.value)}
        />
      )}
      {envMode && !keyless && envFound !== null && (
        <p className={`settings-custom-provider-hint ${envFound ? 'ok' : 'warn'}`} role="status">
          {envHint}
        </p>
      )}
    </>
  );
}
