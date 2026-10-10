import { X } from 'lucide-react';
import { type ReactNode, useEffect, useRef, useState } from 'react';

import { registerMobileBack } from '../mobile-back';
import { OpenSelect } from '../OpenSelect';
import { modelDisplayName, providerDisplayName } from '../provider-display';
import { record } from '../record-utils';
// biome-ignore format: @ts-expect-error must precede the specifier
// @ts-expect-error Shared presentation contract has no separate declaration file.
import { contextMeasurementStats, measuredContextUsage, contextMeasurementLabel } from '../../../../../src/ui/context-measurement.mjs';
// The primitives render their string props literally. Call sites localize
// app-authored copy with t(...); custom names and content stay untouched.
import { t } from '../i18n';
import { ErrorNotice } from '../ErrorNotice';
import { acquireTitleBarDim } from '../titlebar-dim';

import { count, type SettingsConfirmation } from './capability-data';

export function Group({ title, description, children }: { title?: string; description?: string; children: ReactNode }) {
  return (
    <section className="settings-group">
      {(title || description) && (
        <header>
          {title && <h3>{title}</h3>}
          {description && <p>{description}</p>}
        </header>
      )}
      <div className="settings-group-body">{children}</div>
    </section>
  );
}

export function ToggleRow({
  title,
  description: _description,
  checked,
  disabled,
  optimistic,
  onChange,
}: {
  title: string;
  description?: string;
  checked: boolean;
  disabled?: boolean;
  optimistic?: boolean;
  onChange(value: boolean): void;
}) {
  const displayTitle = title;
  return (
    <div className="mixdog-settings__row">
      <div className="mixdog-settings__copy">
        <span className="mixdog-settings__row-title">{displayTitle}</span>
      </div>
      <div className="settings-row-control">
        <CompactSwitch
          label={displayTitle}
          checked={checked}
          disabled={disabled}
          optimistic={optimistic}
          onChange={onChange}
        />
      </div>
    </div>
  );
}

export function CompactSwitch({
  label,
  checked,
  disabled,
  optimistic = true,
  className = '',
  onChange,
}: {
  label: string;
  checked: boolean;
  disabled?: boolean;
  optimistic?: boolean;
  className?: string;
  onChange(value: boolean): void;
}) {
  // Optimistic: the switch follows the click immediately and each further click
  // flips the LAST intended value, so a burst is not coalesced against a
  // settings snapshot that has not refreshed yet. The override drops as soon as
  // the refreshed value agrees.
  const [override, setOverride] = useState<boolean | null>(null);
  useEffect(() => {
    setOverride((current) => (!optimistic || current === null || current === checked ? null : current));
  }, [checked, optimistic]);
  const value = optimistic ? (override ?? checked) : checked;
  // A toggle stays clickable while ITS OWN write is in flight: disabling it for
  // the round trip swallowed rapid consecutive clicks (the second press landed
  // on a disabled control). Writes are serialized and idempotent, so the last
  // click wins.
  const blocked = disabled === true && (!optimistic || override === null);
  return (
    <label className={`mixdog-settings__switch compact-switch ${className}`.trim()}>
      <input
        type="checkbox"
        aria-label={label}
        checked={value}
        disabled={blocked}
        onChange={(event) => {
          const next = event.currentTarget.checked;
          if (optimistic) setOverride(next);
          onChange(next);
        }}
      />
      <span aria-hidden="true" />
    </label>
  );
}

export function SelectRow({
  title,
  description: _description,
  value,
  disabled,
  options,
  onChange,
}: {
  title: string;
  description?: string;
  value: string;
  disabled?: boolean;
  options: ReadonlyArray<{ value: string; label: string }>;
  onChange(value: string): void;
}) {
  const normalized = options.some((entry) => entry.value === value)
    ? options
    : [{ value, label: value || t('Select…') }, ...options];
  const displayTitle = title;
  return (
    <div className="mixdog-settings__row">
      <div className="mixdog-settings__copy">
        <span className="mixdog-settings__row-title">{displayTitle}</span>
      </div>
      <div className="settings-row-control">
        <OpenSelect
          className="settings-select"
          ariaLabel={displayTitle}
          value={value}
          disabled={disabled}
          options={normalized}
          onChange={onChange}
        />
      </div>
    </div>
  );
}

export function AutoSaveRow({
  title,
  value,
  name,
  placeholder,
  required = false,
  disabled,
  actions,
  onSave,
}: {
  title: string;
  value: string;
  name: string;
  placeholder?: string;
  required?: boolean;
  disabled?: boolean;
  actions?: ReactNode;
  onSave(value: string): void;
}) {
  const commit = (input: HTMLInputElement) => {
    if (input.value === value) return;
    if (required && !input.reportValidity()) return;
    onSave(input.value);
  };
  const displayTitle = title;
  return (
    <div className="settings-form-row">
      <div>
        <b>{displayTitle}</b>
      </div>
      <div className="settings-form-controls">
        <input
          key={value}
          name={name}
          aria-label={displayTitle}
          defaultValue={value}
          placeholder={placeholder}
          required={required}
          disabled={disabled}
          onBlur={(event) => commit(event.currentTarget)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.nativeEvent.isComposing) {
              event.preventDefault();
              event.currentTarget.blur();
            } else if (event.key === 'Escape') {
              event.preventDefault();
              event.currentTarget.value = value;
              event.currentTarget.blur();
            }
          }}
        />
        {actions}
      </div>
    </div>
  );
}

export function ActionButton({
  children,
  danger,
  disabled,
  onClick,
}: {
  children: ReactNode;
  danger?: boolean;
  disabled?: boolean;
  onClick(): void;
}) {
  return (
    <button type="button" className={`settings-action ${danger ? 'danger' : ''}`} disabled={disabled} onClick={onClick}>
      {children}
    </button>
  );
}

export function SettingsConfirmDialog({ options, onClose }: { options: SettingsConfirmation; onClose(): void }) {
  const cancelRef = useRef<HTMLButtonElement>(null);
  const confirmRef = useRef<HTMLButtonElement>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  useEffect(() => {
    cancelRef.current?.focus();
  }, []);
  // Fullscreen scrim: the native caption controls dim with it.
  useEffect(() => acquireTitleBarDim(), []);
  useEffect(() => registerMobileBack(() => onCloseRef.current()), []);
  const accept = () => {
    onClose();
    void options.onConfirm();
  };
  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: scrim click-to-dismiss; keyboard dismissal is the dialog's Escape handling.
    <div
      className="settings-confirm-layer"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <section
        className="settings-confirm-dialog"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="settings-confirm-title"
        aria-describedby="settings-confirm-description"
        data-settings-nested-dialog
      >
        <header>
          <h3 id="settings-confirm-title">{options.title}</h3>
          <button type="button" aria-label={t('Close confirmation')} data-settings-nested-close onClick={onClose}>
            <X aria-hidden="true" size={16} />
          </button>
        </header>
        <p id="settings-confirm-description">{options.description}</p>
        <footer>
          <button ref={cancelRef} type="button" onClick={onClose}>
            {t('Cancel')}
          </button>
          <button ref={confirmRef} type="button" className={options.danger ? 'danger' : 'primary'} onClick={accept}>
            {options.confirmLabel ?? t('Continue')}
          </button>
        </footer>
      </section>
    </div>
  );
}

type SettingsStatusTone = 'positive' | 'warning' | 'danger' | 'neutral';

export function settingsStatus(value: string): { label: string; tone: SettingsStatusTone } {
  const text = value.replace(/[_-]+/g, ' ').trim();
  const label = text ? `${text.charAt(0).toUpperCase()}${text.slice(1)}` : 'Unknown';
  const normalized = label.toLowerCase();
  if (/(failed|error|invalid|missing|rejected|expired|reauth required)/.test(normalized))
    return { label, tone: 'danger' };
  if (/(pending|installing|checking|starting|connecting|updating|running update)/.test(normalized)) {
    return { label, tone: 'warning' };
  }
  if (/(not connected|disabled|off|stopped|unknown|idle)/.test(normalized)) return { label, tone: 'neutral' };
  if (/(connected|enabled|ready|detected|complete|installed|running|active|on|saved|^set$)/.test(normalized)) {
    return { label, tone: 'positive' };
  }
  return { label, tone: 'neutral' };
}

export function ResourceRow({
  title,
  description: _description,
  meta,
  status,
  selected = false,
  actions,
  className = '',
}: {
  title: string;
  description?: string;
  meta?: string;
  status?: string;
  selected?: boolean;
  actions?: ReactNode;
  className?: string;
}) {
  let state: ReturnType<typeof settingsStatus> | null = null;
  if (status) state = settingsStatus(status);
  else if (selected) state = settingsStatus('Active');
  return (
    <div className={`settings-resource ${className}`.trim()} aria-current={selected ? 'true' : undefined}>
      <div>
        <div className="settings-resource-title">
          <b>{title}</b>
          {state && (
            <span className={`settings-status settings-status--${state.tone}`}>
              <i aria-hidden="true" />
              {t(state.label)}
            </span>
          )}
        </div>
        {meta && <small className="settings-resource-meta">{meta}</small>}
      </div>
      <div className="settings-resource-control">
        {actions && <div className="settings-resource-actions">{actions}</div>}
      </div>
    </div>
  );
}

function MetricGrid({ items }: { items: Array<{ label: string; value: unknown; tone?: string }> }) {
  const visible = items.filter((item) => item.value !== undefined && item.value !== null && item.value !== '');
  if (!visible.length) return <Empty text={t('No status data available.')} />;
  return (
    <div className="settings-metric-grid">
      {visible.map((item) => (
        <div key={item.label} className={item.tone ? `tone-${item.tone}` : ''}>
          <span>{item.label}</span>
          <b>{String(item.value)}</b>
        </div>
      ))}
    </div>
  );
}

export function ContextStatusView({ value }: { value: unknown }) {
  const context = record(value);
  const messages = record(context.messages);
  const request = record(context.request);
  const usage = record(context.usage);
  if (context.error) return <ErrorNotice error={context.error} role="status" />;
  const measured = measuredContextUsage({
    stats: contextMeasurementStats(context),
    contextWindow: context.effectiveContextWindow || context.contextWindow,
  });
  const { used, limit: window, percent } = measured;
  return (
    <div className="settings-status-stack">
      <ResourceRow
        title={`${
          context.model ? modelDisplayName(String(context.model), String(context.provider || '')) : t('No model')
        } · ${context.provider ? providerDisplayName(String(context.provider)) : t('No provider')}`}
        description={String(context.cwd || t('No active project'))}
        meta={String(context.toolMode || t('default tools'))}
      />
      {window > 0 && (
        // biome-ignore lint/a11y/useAriaPropsSupportedByRole: the meter div keeps its label; the tag and role stay unchanged.
        <div className="settings-context-meter" aria-label={t(contextMeasurementLabel(measured.source))}>
          <span style={{ width: `${percent ?? 0}%` }} />
          <small>
            {t(contextMeasurementLabel(measured.source))} · {used == null ? '—' : count(used)} / {count(window)}
            {percent == null ? '' : ` · ${percent}%`}
          </small>
        </div>
      )}
      <MetricGrid
        items={[
          { label: t('Free tokens'), value: used == null ? '—' : count(Math.max(0, window - used)) },
          { label: t('Messages'), value: count(messages.total ?? messages.count) },
          { label: t('Tool schema'), value: `${count(request.toolSchemaTokens)} ${t('tokens')}` },
          { label: t('Request reserve'), value: `${count(request.reserveTokens)} ${t('tokens')}` },
          { label: t('Last input'), value: `${count(usage.lastInputTokens)} ${t('tokens')}` },
          { label: t('Last output'), value: `${count(usage.lastOutputTokens)} ${t('tokens')}` },
        ]}
      />
    </div>
  );
}

export function Empty({ text }: { text: string }) {
  return <p className="settings-empty">{text}</p>;
}

export function ListEmpty({ text }: { text: string }) {
  return <p className="settings-empty settings-empty-list">{text}</p>;
}
