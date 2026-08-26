import {
  X
} from 'lucide-react';
import { type FormEvent, type ReactNode, useEffect, useRef, useState } from 'react';

import { registerMobileBack } from '../mobile-back';
import { OpenSelect } from '../OpenSelect';
import { modelDisplayName, providerDisplayName } from '../provider-display';
import { record } from '../record-utils';
// The primitives translate their OWN string props: every settings panel that
// renders through Group/Rows/ActionButton gets localized titles without each
// call site wrapping literals. Dynamic values (model names, provider labels)
// simply miss the catalog and pass through unchanged.
import { t } from '../i18n';
import { acquireTitleBarDim } from '../titlebar-dim';

import { count, providerLabel, rows, type SettingsConfirmation } from "./capability-data";

export function Group({ title, description, children }: {
  title?: string; description?: string; children: ReactNode;
}) {
  return <section className="settings-group">
    {(title || description) &&
    <header>{title && <h3>{t(title)}</h3>}
      {description && <p>{t(description)}</p>}</header>}
    <div className="settings-group-body">{children}</div></section>;
}

export function ToggleRow({ title, description: _description, checked, disabled, onChange }: {
  title: string; description?: string; checked: boolean; disabled?: boolean; onChange(value: boolean): void;
}) {
  const displayTitle = t(title);
  return <div className="mixdog-settings__row"><div className="mixdog-settings__copy">
    <span className="mixdog-settings__row-title">{displayTitle}</span>
  </div><div className="settings-row-control"><CompactSwitch label={displayTitle} checked={checked}
    disabled={disabled} onChange={onChange} /></div></div>;
}

export function CompactSwitch({ label, checked, disabled, className = '', onChange }: {
  label: string; checked: boolean; disabled?: boolean; className?: string; onChange(value: boolean): void;
}) {
  // Optimistic: the switch follows the click immediately and each further click
  // flips the LAST intended value, so a burst is not coalesced against a
  // settings snapshot that has not refreshed yet. The override drops as soon as
  // the refreshed value agrees.
  const [override, setOverride] = useState<boolean | null>(null);
  useEffect(() => {
    setOverride((current) => (current === null || current === checked ? null : current));
  }, [checked]);
  const value = override ?? checked;
  // A toggle stays clickable while ITS OWN write is in flight: disabling it for
  // the round trip swallowed rapid consecutive clicks (the second press landed
  // on a disabled control). Writes are serialized and idempotent, so the last
  // click wins.
  const blocked = disabled === true && override === null;
  return <label className={`mixdog-settings__switch compact-switch ${className}`.trim()}>
    <input type="checkbox" aria-label={label} checked={value}
    disabled={blocked} onChange={(event) => {
      const next = event.currentTarget.checked;
      setOverride(next);
      onChange(next);
    }} /><span aria-hidden="true" />
  </label>;
}

export function SelectRow({ title, description: _description, value, disabled, options, onChange }: {
  title: string; description?: string; value: string; disabled?: boolean;
  options: ReadonlyArray<{ value: string; label: string }>; onChange(value: string): void;
}) {
  const normalized = options.some((entry) => entry.value === value)
    ? options
    : [{ value, label: value || t('Select…') }, ...options];
  const displayTitle = t(title);
  return <div className="mixdog-settings__row"><div className="mixdog-settings__copy">
    <span className="mixdog-settings__row-title">{displayTitle}</span>
  </div><div className="settings-row-control"><OpenSelect className="settings-select" ariaLabel={displayTitle} value={value} disabled={disabled}
    options={normalized.map((entry) => ({ ...entry, label: t(entry.label) }))} onChange={onChange} /></div></div>;
}

export function FormRow({ title, description: _description, status, children, resetOnSubmit = false, onSubmit }: {
  title: string; description?: string; status?: string; children: ReactNode; resetOnSubmit?: boolean; onSubmit(data: FormData): void;
}) {
  const state = status ? settingsStatus(status) : null;
  return <form className="settings-form-row" onSubmit={(event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = event.currentTarget;
    onSubmit(new FormData(form));
    if (resetOnSubmit) form.reset();
  }}><div className="settings-resource-title"><b>{t(title)}</b>
      {state && <span className={`settings-status settings-status--${state.tone}`}><i aria-hidden="true" />{t(state.label)}</span>}
    </div><div className="settings-form-controls">{children}</div></form>;
}

export function AutoSaveRow({ title, value, name, placeholder, required = false, disabled, actions, onSave }: {
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
  const displayTitle = t(title);
  return <div className="settings-form-row"><div><b>{displayTitle}</b></div><div className="settings-form-controls">
    <input key={value} name={name} aria-label={displayTitle} defaultValue={value}
      placeholder={placeholder === undefined ? undefined : t(placeholder)}
      required={required} disabled={disabled}
      onBlur={(event) => commit(event.currentTarget)}
      onKeyDown={(event) => {
        if (event.key === 'Enter') {
          event.preventDefault();
          event.currentTarget.blur();
        } else if (event.key === 'Escape') {
          event.preventDefault();
          event.currentTarget.value = value;
          event.currentTarget.blur();
        }
      }} />
    {actions}
  </div></div>;
}

export function ActionButton({ children, danger, disabled, onClick }: {
  children: ReactNode; danger?: boolean; disabled?: boolean; onClick(): void;
}) {
  return <button type="button" className={`settings-action ${danger ? 'danger' : ''}`} disabled={disabled} onClick={onClick}>
    {typeof children === 'string' ? t(children) : children}</button>;
}

export function SettingsConfirmDialog({ options, onClose }: { options: SettingsConfirmation; onClose(): void }) {
  const cancelRef = useRef<HTMLButtonElement>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  useEffect(() => { cancelRef.current?.focus(); }, []);
  // Fullscreen scrim: the native caption controls dim with it.
  useEffect(() => acquireTitleBarDim(), []);
  useEffect(() => registerMobileBack(() => onCloseRef.current()), []);
  const accept = () => {
    onClose();
    void options.onConfirm();
  };
  return <div className="settings-confirm-layer" onMouseDown={(event) => {
    if (event.target === event.currentTarget) onClose();
  }}>
    <section className="settings-confirm-dialog" role="alertdialog" aria-modal="true" aria-labelledby="settings-confirm-title"
      aria-describedby="settings-confirm-description" data-settings-nested-dialog>
      <header><h3 id="settings-confirm-title">{t(options.title)}</h3>
        <button type="button" aria-label={t('Close confirmation')} data-settings-nested-close
          onClick={onClose}><X aria-hidden="true" size={16} /></button></header>
      <p id="settings-confirm-description">{t(options.description)}</p>
      <footer><button ref={cancelRef} type="button" onClick={onClose}>{t('Cancel')}</button>
        <button type="button" className={options.danger ? 'danger' : 'primary'} onClick={accept}>
          {options.confirmLabel ? t(options.confirmLabel) : t('Continue')}
        </button></footer>
    </section>
  </div>;
}

export type SettingsStatusTone = 'positive' | 'warning' | 'danger' | 'neutral';

export function settingsStatus(value: string): { label: string; tone: SettingsStatusTone } {
  const text = value.replace(/[_-]+/g, ' ').trim();
  const label = text ? `${text.charAt(0).toUpperCase()}${text.slice(1)}` : 'Unknown';
  const normalized = label.toLowerCase();
  if (/(failed|error|invalid|missing|rejected|expired|reauth required)/.test(normalized)) return { label, tone: 'danger' };
  if (/(pending|installing|checking|starting|connecting|updating|running update)/.test(normalized)) {
    return { label, tone: 'warning' };
  }
  if (/(not connected|disabled|off|stopped|unknown|idle)/.test(normalized)) return { label, tone: 'neutral' };
  if (/(connected|enabled|ready|detected|complete|installed|running|active|on|saved|^set$)/.test(normalized)) {
    return { label, tone: 'positive' };
  }
  return { label, tone: 'neutral' };
}

export function ResourceRow({ title, description: _description, meta, status, selected = false, actions, className = '' }: {
  title: string; description?: string; meta?: string; status?: string; selected?: boolean; actions?: ReactNode; className?: string;
}) {
  const state = status ? settingsStatus(status) : selected ? settingsStatus('Active') : null;
  return <div className={`settings-resource ${className}`.trim()} aria-current={selected ? 'true' : undefined}><div>
    <div className="settings-resource-title"><b>{t(title)}</b>
      {state && <span className={`settings-status settings-status--${state.tone}`}><i aria-hidden="true" />{t(state.label)}</span>}
    </div>
    {meta && <small className="settings-resource-meta">{meta}</small>}
  </div>
    <div className="settings-resource-control">
      {actions && <div className="settings-resource-actions">{actions}</div>}</div></div>;
}

export function MetricGrid({ items }: { items: Array<{ label: string; value: unknown; tone?: string }> }) {
  const visible = items.filter((item) => item.value !== undefined && item.value !== null && item.value !== '');
  return visible.length ? <div className="settings-metric-grid">{visible.map((item) => <div key={item.label}
    className={item.tone ? `tone-${item.tone}` : ''}><span>{t(item.label)}</span><b>{String(item.value)}</b></div>)}</div>
    : <Empty text="No status data available." />;
}

export function ContextStatusView({ value }: { value: unknown }) {
  const context = record(value);
  const messages = record(context.messages);
  const request = record(context.request);
  const usage = record(context.usage);
  if (context.error) return <Empty text={String(context.error)} />;
  const used = Number(context.usedTokens || context.currentEstimatedTokens || 0);
  const window = Number(context.contextWindow || 0);
  const percent = window > 0 ? Math.min(100, Math.max(0, Math.round((used / window) * 100))) : 0;
  return <div className="settings-status-stack">
    <ResourceRow title={`${context.model
      ? modelDisplayName(String(context.model), String(context.provider || ''))
      : 'No model'} · ${context.provider ? providerDisplayName(String(context.provider)) : 'No provider'}`}
      description={String(context.cwd || 'No active project')} meta={String(context.toolMode || 'default tools')} />
    {window > 0 && <div className="settings-context-meter" aria-label={`Context ${percent}% used`}>
      <span style={{ width: `${percent}%` }} /><small>{count(used)} / {count(window)} tokens · {percent}%</small></div>}
    <MetricGrid items={[
      { label: 'Free tokens', value: count(context.freeTokens) },
      { label: 'Messages', value: count(messages.total ?? messages.count) },
      { label: 'Tool schema', value: `${count(request.toolSchemaTokens)} tokens` },
      { label: 'Request reserve', value: `${count(request.reserveTokens)} tokens` },
      { label: 'Last input', value: `${count(usage.lastInputTokens)} tokens` },
      { label: 'Last output', value: `${count(usage.lastOutputTokens)} tokens` },
    ]} />
  </div>;
}

export function UsageDashboard({ value }: { value: unknown }) {
  const dashboard = record(value);
  const total = record(dashboard.total);
  const providers = rows(dashboard, 'rows');
  if (dashboard.error) return <Empty text={String(dashboard.error)} />;
  return <div className="settings-status-stack">
    <MetricGrid items={[
      { label: 'Providers', value: count(total.providerCount ?? providers.length) },
      { label: 'Known remaining', value: `$${Number(total.knownRemainingUsd || 0).toFixed(2)}` },
      { label: 'Not configured', value: count(total.notConfiguredCount) },
      { label: 'Errors', value: count(total.errorCount), tone: Number(total.errorCount) > 0 ? 'danger' : 'good' },
    ]} />
    {providers.length ? <div>{providers.map((provider, index) => <ResourceRow
      key={String(provider.id || provider.provider || index)} title={providerLabel(provider, `Provider ${index + 1}`)}
      description={String(provider.detail || provider.sourceLabel || '')}
      meta={provider.primary ? String(provider.primary) : undefined}
      status={String(provider.status || 'unknown')} />)}</div> : <Empty text="No provider usage rows." />}
  </div>;
}

export function Empty({ text }: { text: string }) {
  return <p className="settings-empty">{t(text)}</p>;
}

export function ListEmpty({ text }: { text: string }) {
  return <p className="settings-empty settings-empty-list">{t(text)}</p>;
}
