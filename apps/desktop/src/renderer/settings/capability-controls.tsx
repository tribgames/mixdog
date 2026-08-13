import {
  X
} from 'lucide-react';
import { type FormEvent, type ReactNode, useEffect, useRef, useState } from 'react';

import type {
  DesktopModelOption,
  DesktopModelSelection
} from '../../shared/contract';
import { FastModeToggle } from '../FastModeToggle';
import { ModelPicker } from '../ModelPicker';
import { OpenSelect } from '../OpenSelect';
import { modelDisplayName, modelOptionLabel, providerDisplayName } from '../provider-display';
// The primitives translate their OWN string props: every settings panel that
// renders through Group/Rows/ActionButton gets localized titles without each
// call site wrapping literals. Dynamic values (model names, provider labels)
// simply miss the catalog and pass through unchanged.
import { t } from '../i18n';
import { acquireTitleBarDim } from '../titlebar-dim';

import { count, providerLabel, record, type RecordValue, rows, type SettingsConfirmation } from "./capability-data";

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
  const displayTitle = t(title);
  return <div className="mixdog-settings__row"><div className="mixdog-settings__copy">
    <span className="mixdog-settings__row-title">{displayTitle}</span>
  </div><div className="settings-row-control"><label className="mixdog-settings__switch"><input type="checkbox" aria-label={displayTitle} checked={value}
    disabled={blocked} onChange={(event) => {
      const next = event.currentTarget.checked;
      setOverride(next);
      onChange(next);
    }} /><span aria-hidden="true" /></label></div></div>;
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

export function QuietSelectRow({ title, value, disabled, options, kind, onChange }: {
  title: string;
  value: string;
  disabled?: boolean;
  options: ReadonlyArray<{ value: string; label: string }>;
  kind: 'effort' | 'fast';
  onChange(value: string): void;
}) {
  const normalized = options.some((entry) => entry.value === value)
    ? options
    : [{ value, label: value || t('Select…') }, ...options];
  const displayTitle = t(title);
  return <div className="mixdog-settings__row"><div className="mixdog-settings__copy">
    <span className="mixdog-settings__row-title">{displayTitle}</span>
  </div><div className="settings-row-control"><div className={`${kind}-control`}>
    <OpenSelect ariaLabel={displayTitle} value={value} disabled={disabled}
      localizeLabels={kind !== 'effort'}
      options={kind === 'effort'
        ? normalized
        : normalized.map((entry) => ({ ...entry, label: t(entry.label) }))} onChange={onChange} />
  </div></div></div>;
}

export function routeOption(value: RecordValue): DesktopModelOption {
  const model = String(value.id || value.model || '');
  const effortOptions = rows(value.effortOptions).flatMap((entry) => {
    const optionValue = String(entry.value || '');
    if (!optionValue) return [];
    return [{ value: optionValue, label: String(entry.label || optionValue) }];
  });
  const savedEffort = String(value.savedEffort || '');
  const savedFast = typeof value.savedFast === 'boolean' ? value.savedFast : undefined;
  const fastCapable = value.fastCapable === true;
  return {
    provider: String(value.provider || ''),
    model,
    display: String(value.display || value.name || model),
    effortOptions,
    fastCapable,
    fastPreferred: fastCapable && (value.fastPreferred === true || savedFast === true),
    ...(savedEffort ? { savedEffort } : {}),
    ...(savedFast === undefined ? {} : { savedFast }),
  };
}

export function preferredEffort(model: DesktopModelOption | undefined): string | undefined {
  if (!model?.effortOptions.length) return undefined;
  if (model.savedEffort && model.effortOptions.some((entry) => entry.value === model.savedEffort)) {
    return model.savedEffort;
  }
  for (const value of ['high', 'medium', 'low', 'none', 'xhigh', 'max', 'ultra']) {
    if (model.effortOptions.some((entry) => entry.value === value)) return value;
  }
  return model.effortOptions[0]?.value;
}

export function routeOptionLabel(model: DesktopModelOption): string {
  return model.provider === 'default' && model.model === 'default'
    ? 'Default · follows Main'
    : modelOptionLabel(model);
}

export function RouteEditor({ title, description: _description, route, models, disabled, compact = false,
  onChange, onOpenProviders }: {
  title: string;
  description?: string;
  route: RecordValue;
  models: DesktopModelOption[];
  disabled?: boolean;
  compact?: boolean;
  onChange(selection: DesktopModelSelection): unknown;
  onOpenProviders?: () => void;
}) {
  const currentKey = `${route.provider || ''}:${route.model || ''}`;
  const selected = models.find((entry) => `${entry.provider}:${entry.model}` === currentKey);
  const effort = selected?.effortOptions.some((entry) => entry.value === route.effort)
    ? String(route.effort)
    : preferredEffort(selected);
  const fast = selected?.fastCapable
    ? (typeof route.fast === 'boolean' ? route.fast === true : selected.fastPreferred)
    : false;
  const selectionFor = (model: DesktopModelOption, patch: Partial<DesktopModelSelection> = {}): DesktopModelSelection => {
    const nextEffort = patch.effort ?? (model === selected ? effort : preferredEffort(model));
    const nextFast = patch.fast ?? (model === selected ? fast : model.fastPreferred);
    return {
      provider: model.provider,
      model: model.model,
      ...(nextEffort ? { effort: nextEffort } : {}),
      ...(model.fastCapable ? { fast: nextFast === true } : {}),
    };
  };
  const modelSelect = <ModelPicker models={models}
    provider={String(route.provider || '')} model={String(route.model || '')}
    triggerLabel={selected
      ? modelDisplayName(selected.model, selected.provider, selected.display)
      : route.model ? modelDisplayName(String(route.model), String(route.provider || '')) : t('Select model…')}
    ariaLabel={title} triggerClassName="model-trigger settings-model-trigger"
    disabled={disabled} onSelect={(model) => onChange(selectionFor(model))}
    onOpenProviders={onOpenProviders} />;
  if (!compact) {
    return <>
      <div className="mixdog-settings__row settings-route-row">
        <div className="mixdog-settings__copy">
          <span className="mixdog-settings__row-title">{t('Model')}</span>
        </div>
        <div className="settings-row-control">{modelSelect}</div>
      </div>
      {selected && selected.effortOptions.length > 0 && <QuietSelectRow title="Effort" kind="effort"
        value={effort || selected.effortOptions[0]?.value || 'auto'} disabled={disabled}
        options={selected.effortOptions}
        onChange={(value) => onChange(selectionFor(selected, { effort: value }))} />}
      {selected?.fastCapable && <div className="mixdog-settings__row"><div className="mixdog-settings__copy">
        <span className="mixdog-settings__row-title">{t('Fast mode')}</span>
      </div><div className="settings-row-control"><div className="fast-control">
        <FastModeToggle enabled={fast} disabled={disabled}
          onChange={(enabled) => onChange(selectionFor(selected, { fast: enabled }))} />
      </div></div></div>}
    </>;
  }
  return <div className="settings-route-editor compact">
    <div className="settings-route-controls">
      {modelSelect}
      {selected && selected.effortOptions.length > 0 && <div className="effort-control">
        <OpenSelect variant="route" ariaLabel={`${title} effort`} value={effort} disabled={disabled}
          localizeLabels={false} options={selected.effortOptions}
          onChange={(value) => onChange(selectionFor(selected, { effort: value }))} />
      </div>}
      {selected?.fastCapable && <div className="fast-control">
        <FastModeToggle ariaLabel={`${title} fast mode`} enabled={fast} disabled={disabled}
          onChange={(enabled) => onChange(selectionFor(selected, { fast: enabled }))} />
      </div>}
    </div>
  </div>;
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
  useEffect(() => { cancelRef.current?.focus(); }, []);
  // Fullscreen scrim: the native caption controls dim with it.
  useEffect(() => acquireTitleBarDim(), []);
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
  if (/(failed|error|invalid|missing|rejected)/.test(normalized)) return { label, tone: 'danger' };
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
