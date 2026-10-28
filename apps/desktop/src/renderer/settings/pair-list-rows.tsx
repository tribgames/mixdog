// Name/value pair rows shared by the MCP server editor and the custom
// provider's HTTP headers: the row look (`extensions-mcp-list-row
// extensions-mcp-pair-row`), the "+ Add" button and the row <-> record helpers.
import { X } from 'lucide-react';
import type { ReactNode } from 'react';
import { t } from '../i18n';
import { record } from '../record-utils';

export type PairRow = { key: string; value: string };

export function pairRows(value: unknown): PairRow[] {
  return Object.entries(record(value)).map(([key, entry]) => ({ key, value: String(entry ?? '') }));
}

/** The rows as a record; blank rows are skipped, a value without a key or a repeated key throws. */
export function pairRecord(values: PairRow[], field: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const row of values) {
    const key = row.key.trim();
    const value = row.value;
    if (!key && !value.trim()) continue;
    if (!key) throw new Error(t('{{field}} contains a value without a key.', { field }));
    if (Object.hasOwn(result, key)) {
      throw new Error(t('{{field}} contains duplicate key "{{key}}".', { field, key }));
    }
    result[key] = value;
  }
  return result;
}

/** The editable rows (one empty row when there are none) and the add button. */
export function PairRows({
  values,
  keyPlaceholder,
  valuePlaceholder,
  busy,
  onChange,
  removeLabel,
  invalid,
  children,
}: {
  values: PairRow[];
  keyPlaceholder: string;
  valuePlaceholder: string;
  busy: boolean;
  onChange(values: PairRow[]): void;
  /** The remove button's accessible name; default "Remove". */
  removeLabel?(row: PairRow): string;
  /** Marks the row's name input invalid. */
  invalid?(row: PairRow): boolean;
  /** Shown between the rows and the add button. */
  children?: ReactNode;
}) {
  const visible = values.length ? values : [{ key: '', value: '' }];
  return (
    <>
      <div className="extensions-mcp-list-rows">
        {visible.map((row, index) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: rows are key/value pairs edited by position and never reorder.
          <div className="extensions-mcp-list-row extensions-mcp-pair-row" key={index}>
            <input
              value={row.key}
              placeholder={keyPlaceholder}
              disabled={busy}
              spellCheck={false}
              aria-invalid={invalid?.(row) ? true : undefined}
              onChange={(event) => {
                const next = visible.map((entry) => ({ ...entry }));
                next[index].key = event.currentTarget.value;
                onChange(next);
              }}
            />
            <input
              value={row.value}
              placeholder={valuePlaceholder}
              disabled={busy}
              spellCheck={false}
              onChange={(event) => {
                const next = visible.map((entry) => ({ ...entry }));
                next[index].value = event.currentTarget.value;
                onChange(next);
              }}
            />
            <button
              type="button"
              aria-label={removeLabel ? removeLabel(row) : t('Remove')}
              disabled={busy || (!row.key && !row.value && values.length === 0)}
              onClick={() => onChange(visible.filter((_, rowIndex) => rowIndex !== index))}
            >
              <X size={14} aria-hidden="true" />
            </button>
          </div>
        ))}
      </div>
      {children}
      <button
        type="button"
        className="extensions-mcp-list-add"
        disabled={busy}
        onClick={() =>
          onChange([
            ...visible.filter((row, index) => row.key || row.value || index < values.length),
            { key: '', value: '' },
          ])
        }
      >
        + {t('Add')}
      </button>
    </>
  );
}
