import { ChevronDown } from 'lucide-react';
import { type ReactNode, useEffect, useState } from 'react';

import { t } from '../i18n';
import { PairRows, type PairRow } from './pair-list-rows';

// Mirrors custom-provider-config.mjs (CUSTOM_RESERVED_BODY_KEYS,
// CUSTOM_REQUEST_BODY_MAX_CHARS, AUTH_HEADERS, CUSTOM_MODEL_REFUSED_HEADERS);
// custom-request-options.test.mjs keeps the two lists identical.
export const RESERVED_BODY_KEYS: readonly string[] = [
  'model',
  'messages',
  'input',
  'system',
  'instructions',
  'tools',
  'tool_choice',
  'parallel_tool_calls',
  'stream',
  'stream_options',
  'previous_response_id',
  'store',
  'include',
  'prompt_cache_key',
  'max_tokens',
  'max_output_tokens',
  'max_completion_tokens',
];
// The runtime also refuses these prototype keys (custom-provider-config.mjs UNSAFE_KEYS).
const UNSAFE_BODY_KEYS: readonly string[] = ['__proto__', 'constructor', 'prototype'];
export const REQUEST_BODY_MAX_CHARS = 16384;
const EXAMPLE_JSON = JSON.stringify({ service_tier: 'flex' }, null, 2);
const REFUSED_MODEL_HEADERS = new Set([
  'authorization',
  'x-api-key',
  'api-key',
  'content-type',
  'content-length',
  'host',
  'connection',
  'transfer-encoding',
  'proxy-authorization',
]);
const AUTH_HEADER_NAMES = new Set(['authorization', 'x-api-key', 'api-key']);

export type RequestBodyState = { value: Record<string, unknown>; error: string };

/** The textarea's JSON as an object (blank = none) or the message to show beside it. */
export function parseRequestBody(text: string): RequestBodyState {
  if (!text.trim()) return { value: {}, error: '' };
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (reason) {
    return {
      value: {},
      error: t('Advanced request options must be valid JSON: {{message}}', {
        message: reason instanceof Error ? reason.message : String(reason),
      }),
    };
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { value: {}, error: t('Advanced request options must be a JSON object, like {"service_tier": "flex"}.') };
  }
  const object = parsed as Record<string, unknown>;
  // The runtime's measure: the serialized object, not the pretty-printed text.
  if (JSON.stringify(object).length > REQUEST_BODY_MAX_CHARS) {
    return {
      value: {},
      error: t('Advanced request options must be at most {{max}} characters.', { max: String(REQUEST_BODY_MAX_CHARS) }),
    };
  }
  const owned = RESERVED_BODY_KEYS.filter((key) => Object.hasOwn(object, key));
  const unsafe = UNSAFE_BODY_KEYS.filter((key) => Object.hasOwn(object, key));
  if (owned.length || unsafe.length) {
    const messages = [
      owned.length &&
        t('{{keys}} are set by the app and cannot be changed. Remove them to save.', { keys: owned.join(', ') }),
      unsafe.length && t("{{keys}} can't be used as option names.", { keys: unsafe.join(', ') }),
    ].filter(Boolean);
    return { value: {}, error: messages.join(' ') };
  }
  return { value: object, error: '' };
}

/** The stored object as editable text ('' when none). */
export function requestBodyText(value: unknown): string {
  return value && typeof value === 'object' && Object.keys(value).length ? JSON.stringify(value, null, 2) : '';
}

/** A model-level header the runtime refuses (credentials, transport). */
const isRefusedModelHeader = (row: PairRow) => REFUSED_MODEL_HEADERS.has(row.key.trim().toLowerCase());

/** The first refused model-level header's name, or ''. */
export function blockedModelHeader(rows: PairRow[]): string {
  return rows.find(isRefusedModelHeader)?.key.trim() ?? '';
}

export function blockedModelHeaderMessage(name: string): string {
  if (AUTH_HEADER_NAMES.has(name.toLowerCase())) {
    return t('The {{name}} header cannot be set here. Enter the API key in the API key field instead.', { name });
  }
  return t('The {{name}} header is set by the app and cannot be changed.', { name });
}

/** The folded "Advanced" disclosure (same head as "HTTP headers"): closed
 *  unless it holds a saved value, and it opens itself when a field has an error. */
export function RequestOptionsSection({
  hasValue,
  hasError,
  children,
}: {
  hasValue: boolean;
  hasError: boolean;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(hasValue);
  useEffect(() => {
    if (hasError) setOpen(true);
  }, [hasError]);
  return (
    <details
      className="settings-custom-models settings-request-options"
      open={open}
      onToggle={(event) => setOpen(event.currentTarget.open)}
    >
      <summary>
        <span>{t('Advanced')}</span>
        <ChevronDown size={14} aria-hidden="true" />
      </summary>
      <div className="settings-request-options-body">{children}</div>
    </details>
  );
}

/** "Advanced request options": a JSON textarea with its validation message. */
export function RequestBodyField({
  id,
  text,
  hint,
  disabled,
  error,
  onChange,
}: {
  id: string;
  text: string;
  hint: string;
  disabled: boolean;
  error: string;
  onChange(text: string): void;
}) {
  return (
    <>
      <label htmlFor={id}>{t('Advanced request options')}</label>
      <textarea
        id={id}
        value={text}
        rows={5}
        spellCheck={false}
        autoComplete="off"
        disabled={disabled}
        placeholder={EXAMPLE_JSON}
        aria-invalid={error !== ''}
        aria-describedby={`${id}-hint`}
        onChange={(event) => onChange(event.target.value)}
      />
      {error ? (
        <p id={`${id}-hint`} className="settings-custom-headers-error" role="alert">
          {error}
        </p>
      ) : (
        <p id={`${id}-hint`} className="settings-custom-provider-hint">
          {hint}
        </p>
      )}
    </>
  );
}

/** The model-only headers as name/value rows. */
export function ModelRequestHeaders({
  rows,
  disabled,
  onChange,
}: {
  rows: PairRow[];
  disabled: boolean;
  onChange(rows: PairRow[]): void;
}) {
  const blocked = blockedModelHeader(rows);
  return (
    <>
      <span className="settings-model-label">{t('Headers for this model only')}</span>
      <PairRows
        values={rows}
        keyPlaceholder={t('Header')}
        valuePlaceholder={t('Value')}
        busy={disabled}
        invalid={isRefusedModelHeader}
        removeLabel={(row) => (row.key.trim() ? t('Remove {{name}}', { name: row.key.trim() }) : t('Remove'))}
        onChange={onChange}
      >
        {blocked && (
          <p className="settings-custom-headers-error" role="alert">
            {blockedModelHeaderMessage(blocked)}
          </p>
        )}
      </PairRows>
      <p className="settings-custom-provider-hint">{t('Model headers override the provider headers.')}</p>
    </>
  );
}
