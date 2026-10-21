import { useEffect, useRef, useState } from 'react';

import { t } from '../i18n';
import type { PanelContext } from './capability-data';
import { record } from '../record-utils';

const ENV_CHECK_DEBOUNCE_MS = 300;

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
          placeholder={keepsSavedKey ? t('Leave blank to keep the saved key') : t('API key')}
          onChange={(event) => onApiKey(event.target.value)}
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
    </>
  );
}
