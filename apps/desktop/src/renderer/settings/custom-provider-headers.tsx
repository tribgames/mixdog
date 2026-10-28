import { ChevronDown } from 'lucide-react';

import { t } from '../i18n';
import { PairRows, type PairRow } from './pair-list-rows';

// The credential headers the runtime refuses (custom-provider-config.mjs
// AUTH_HEADERS): the API key field owns authentication.
const AUTH_HEADERS = new Set(['authorization', 'x-api-key', 'api-key']);

const isAuthHeader = (name: string): boolean => AUTH_HEADERS.has(name.trim().toLowerCase());

/** The name of the first credential header among the rows, or '' when there is none. */
export function blockedAuthHeader(rows: PairRow[]): string {
  return rows.find((row) => isAuthHeader(row.key))?.key.trim() ?? '';
}

export function blockedHeaderMessage(name: string): string {
  return t('The {{name}} header cannot be set here. Enter the API key in the API key field instead.', { name });
}

/** "HTTP headers": the provider's extra request headers as name/value rows,
 *  folded like "Add models manually". */
export function CustomProviderHeaders({
  open,
  rows,
  disabled,
  onToggle,
  onChange,
}: {
  open: boolean;
  rows: PairRow[];
  disabled: boolean;
  onToggle(open: boolean): void;
  onChange(rows: PairRow[]): void;
}) {
  const count = rows.filter((row) => row.key.trim() || row.value.trim()).length;
  const blocked = blockedAuthHeader(rows);
  return (
    <details
      className="settings-custom-models settings-custom-headers"
      open={open}
      onToggle={(event) => onToggle(event.currentTarget.open)}
    >
      <summary>
        <span>
          {t('HTTP headers')}
          {count > 0 && <span className="settings-custom-headers-count"> · {count}</span>}
        </span>
        <ChevronDown size={14} aria-hidden="true" />
      </summary>
      <p>{t('Optional. Sent with chat, model discovery and connection test requests.')}</p>
      <PairRows
        values={rows}
        keyPlaceholder={t('Header')}
        valuePlaceholder={t('Value')}
        busy={disabled}
        invalid={(row) => isAuthHeader(row.key)}
        removeLabel={(row) => (row.key.trim() ? t('Remove {{name}}', { name: row.key.trim() }) : t('Remove'))}
        onChange={onChange}
      >
        {blocked && (
          <p className="settings-custom-headers-error" role="alert">
            {blockedHeaderMessage(blocked)}
          </p>
        )}
      </PairRows>
    </details>
  );
}
