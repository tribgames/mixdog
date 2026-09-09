import * as React from 'react';
import { useEffect, useId, useRef, useState, type CSSProperties, type RefObject } from 'react';
import { PaneDialogLayer } from './sidebar-dialog';
import { ErrorNotice } from './ErrorNotice';
import { MxIcon } from './MxIcon';
import { t } from './i18n';

export function ComposerGoalDialog({ anchor, disabled, onStart, onClose, returnFocus }: {
  /** The composer control that opened the dialog; the card centers in its pane. */
  anchor: RefObject<HTMLElement | null>;
  disabled: boolean;
  onStart(command: string): Promise<boolean>;
  onClose(): void;
  returnFocus(): void;
}) {
  const titleId = useId();
  const [objective, setObjective] = useState('');
  const [minutes, setMinutes] = useState('60');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const focusReturn = useRef(returnFocus);
  focusReturn.current = returnFocus;
  useEffect(() => () => focusReturn.current(), []);
  const close = () => { if (!busy) onClose(); };
  return <React.Fragment><PaneDialogLayer anchor={anchor} onClose={close}>
    <section className="schedules-dialog" role="dialog" aria-modal="true" aria-labelledby={titleId}
      style={{ '--mx-editor-width': '520px' } as CSSProperties}
      onKeyDown={event => {
        if (event.key !== 'Tab') return;
        const controls = [...event.currentTarget.querySelectorAll<HTMLElement>(
          'button:not(:disabled), input:not(:disabled), textarea:not(:disabled)',
        )];
        const first = controls[0];
        const last = controls.at(-1);
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault(); last?.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault(); first?.focus();
        }
      }}>
      <header>
        <h2 id={titleId}>{t('Set a goal')}</h2>
        <div className="schedules-dialog-header-actions">
          <button type="button" disabled={busy} aria-label={t('Close')} onClick={close}>
            <MxIcon name="close-small" size={16} />
          </button>
        </div>
      </header>
      <form onSubmit={async event => {
        event.preventDefault();
        const duration = Number(minutes);
        if (!objective.trim() || !Number.isInteger(duration) || duration < 1 || duration > 1440 || busy || disabled) return;
        setBusy(true); setError('');
        try {
          if (await onStart(`/goal ${objective.trim()} --time ${duration}m`)) onClose();
          else setError(t('Goal could not be started. Your input has been kept.'));
        } catch (reason) {
          setError(reason instanceof Error ? reason.message : String(reason));
        } finally { setBusy(false); }
      }}>
        <label className="schedules-field">
          <span>{t('Goal objective')}</span>
          <textarea autoFocus required rows={4} maxLength={4000} value={objective}
            disabled={busy} onChange={event => setObjective(event.target.value)} />
        </label>
        <label className="schedules-field">
          <span>{t('Duration in minutes')}</span>
          <input type="number" min="1" max="1440" step="1" required value={minutes}
            disabled={busy} onChange={event => setMinutes(event.target.value)} />
        </label>
        <footer>
          {error && <ErrorNotice error={error} />}
          <button type="button" className="secondary" disabled={busy} onClick={close}>{t('Cancel')}</button>
          <button type="submit" disabled={busy || disabled || !objective.trim()}>{t('Start goal')}</button>
        </footer>
      </form>
    </section>
  </PaneDialogLayer></React.Fragment>;
}
