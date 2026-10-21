import { X } from 'lucide-react';
import { type ReactNode, useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

import { registerMobileBack } from '../mobile-back';
import { OpenSelect } from '../OpenSelect';
// The primitives render their string props literally. Call sites localize
// app-authored copy with t(...); custom names and content stay untouched.
import { t } from '../i18n';
import { scrimDismiss } from '../scrim-dismiss';
import { acquireTitleBarDim } from '../titlebar-dim';

import type { SettingsConfirmation } from './capability-data';
import { openModal } from './dialog-modality';

export function Group({
  title,
  description,
  actions,
  children,
}: {
  title?: string;
  description?: string;
  /** Sits at the right end of the title line. */
  actions?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="settings-group">
      {(title || description) && (
        <header>
          {actions ? (
            <div className="settings-group-head">
              {title && <h3>{title}</h3>}
              {actions}
            </div>
          ) : (
            title && <h3>{title}</h3>
          )}
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
  return (
    <div className="mixdog-settings__row">
      <div className="mixdog-settings__copy">
        <span className="mixdog-settings__row-title">{title}</span>
      </div>
      <div className="settings-row-control">
        <CompactSwitch
          label={title}
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
  return (
    <div className="mixdog-settings__row">
      <div className="mixdog-settings__copy">
        <span className="mixdog-settings__row-title">{title}</span>
      </div>
      <div className="settings-row-control">
        <OpenSelect
          className="settings-select"
          ariaLabel={title}
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
  return (
    <div className="settings-form-row">
      <div>
        <b>{title}</b>
      </div>
      <div className="settings-form-controls">
        <input
          key={value}
          name={name}
          aria-label={title}
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

export function SettingsConfirmDialog({
  options,
  onClose,
  portal = false,
  returnFocus,
}: {
  options: SettingsConfirmation;
  /** Where focus goes on close; defaults to the element focused on open. */
  returnFocus?: Element | null;
  onClose(): void;
  /** Render into document.body. A sidebar host must: the sidebar scroll's
   *  fade mask and isolation clip a fixed layer to the sidebar, which left
   *  only a dimmed sidebar with the dialog itself invisible. */
  portal?: boolean;
}) {
  const cancelRef = useRef<HTMLButtonElement>(null);
  const confirmRef = useRef<HTMLButtonElement>(null);
  const dialogRef = useRef<HTMLElement>(null);
  const opener = useRef<Element | null>(
    returnFocus ?? (typeof document === 'undefined' ? null : document.activeElement)
  );
  const id = useId();
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  // Modal: focus moves in (Cancel for a destructive ask, else the primary
  // action), the rest of the page is inert, and closing hands focus back.
  // biome-ignore lint/correctness/useExhaustiveDependencies: mount-only; the options at open decide the initial focus.
  useEffect(() => {
    const releaseModal = dialogRef.current ? openModal(dialogRef.current) : () => {};
    (options.danger || !options.onConfirm ? cancelRef : confirmRef).current?.focus();
    const from = opener.current;
    return () => {
      releaseModal();
      // Never focus a control that is gone, disabled, or still inert behind
      // another modal.
      const usable = (element: Element | null | undefined): element is HTMLElement =>
        Boolean(
          element?.isConnected &&
            !(element as HTMLButtonElement).disabled &&
            !element.closest('[inert]') &&
            typeof (element as HTMLElement).focus === 'function'
        );
      // The opener, else the focused pane's composer, else another visible
      // composer; nothing if none is usable.
      const visible = (element: HTMLElement) => element.getClientRects().length > 0;
      const composers = [
        ...document.querySelectorAll<HTMLElement>('.pane-cell.is-focused .composer textarea'),
        ...document.querySelectorAll<HTMLElement>('.composer textarea'),
      ];
      [from, ...composers.filter(visible)].find(usable)?.focus();
    };
  }, []);
  // Fullscreen scrim: the native caption controls dim with it.
  useEffect(() => acquireTitleBarDim(), []);
  useEffect(() => registerMobileBack(() => onCloseRef.current()), []);
  const accept = () => {
    onClose();
    void options.onConfirm?.();
  };
  const layer = (
    // biome-ignore lint/a11y/noStaticElementInteractions: scrim click-to-dismiss; Escape closes it here unless the settings dialog's capture handler already did.
    <div
      className="settings-confirm-layer"
      {...scrimDismiss(onClose)}
      onKeyDown={(event) => {
        if (event.key === 'Tab') {
          const stops = [...(dialogRef.current?.querySelectorAll<HTMLElement>('button:not(:disabled)') ?? [])];
          const first = stops[0];
          const last = stops[stops.length - 1];
          const active = document.activeElement;
          if (!stops.includes(active as HTMLElement) || (event.shiftKey ? active === first : active === last)) {
            event.preventDefault();
            (event.shiftKey ? last : first)?.focus();
          }
          return;
        }
        if (event.key !== 'Escape') return;
        event.preventDefault();
        event.stopPropagation();
        onClose();
      }}
    >
      <section
        ref={dialogRef}
        className="settings-confirm-dialog"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby={`${id}-title`}
        aria-describedby={`${id}-description`}
        data-settings-nested-dialog
      >
        <header>
          <h3 id={`${id}-title`}>{options.title}</h3>
          <button type="button" aria-label={t('Close confirmation')} data-settings-nested-close onClick={onClose}>
            <X aria-hidden="true" size={16} />
          </button>
        </header>
        <p id={`${id}-description`}>{options.description}</p>
        <footer>
          {options.onConfirm ? (
            <>
              <button ref={cancelRef} type="button" onClick={onClose}>
                {t('Cancel')}
              </button>
              <button ref={confirmRef} type="button" className={options.danger ? 'danger' : 'primary'} onClick={accept}>
                {options.confirmLabel ?? t('Continue')}
              </button>
            </>
          ) : (
            <button ref={cancelRef} type="button" className="primary" onClick={onClose}>
              {t('Close')}
            </button>
          )}
        </footer>
      </section>
    </div>
  );
  return portal ? createPortal(layer, document.body) : layer;
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
  plainStatus = false,
}: {
  title: string;
  description?: string;
  meta?: string;
  status?: string;
  selected?: boolean;
  actions?: ReactNode;
  className?: string;
  /** Status as plain muted text (green only when positive) instead of a pill. */
  plainStatus?: boolean;
}) {
  let state: ReturnType<typeof settingsStatus> | null = null;
  if (status) state = settingsStatus(status);
  else if (selected) state = settingsStatus('Active');
  return (
    <div className={`settings-resource ${className}`.trim()} aria-current={selected ? 'true' : undefined}>
      <div>
        <div className="settings-resource-title">
          <b>{title}</b>
          {state && plainStatus && (
            <span className={`settings-status-text settings-status-text--${state.tone}`}>{t(state.label)}</span>
          )}
          {state && !plainStatus && (
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

export function Empty({ text }: { text: string }) {
  return <p className="settings-empty">{text}</p>;
}

export function ListEmpty({ text }: { text: string }) {
  return <p className="settings-empty settings-empty-list">{text}</p>;
}
