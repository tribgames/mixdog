// The line under a message sent while a turn runs. Until the model reads it:
// "Send now" (or "Runs after this task" for a slash command the turn holds),
// with ✕ to take it back (on hover or keyboard focus with a mouse, always on
// touch); a failed send offers "Send again".
// Once read, a muted ✓ stands in its place.
import { Check, X } from 'lucide-react';
import { useContext, type ReactNode } from 'react';
import type { TranscriptItem } from './desktop-types';
import { t } from './i18n';
import { SteerContext } from './steer-actions';
import { isPhoneSurfaceMarked } from './mobile-surface';
import { touchPrimaryPointer } from './surface-input-focus';

export function SteerStatus({ item }: { item: TranscriptItem }) {
  const steer = useContext(SteerContext);
  if (!item.steer) {
    if (item.steered !== true) return null;
    const label = t('Read by the model');
    return (
      <span className="message-steer-read" role="img" aria-label={label} data-tooltip={label}>
        <Check size={12} aria-hidden="true" />
      </span>
    );
  }
  // The turn is stopping to read it: nothing left to act on.
  if (item.steer === 'sending') return null;
  const id = String(item.id ?? '');
  const actions = steer?.actions;
  // Not in the session queue yet: there is nothing to send or take back.
  const unpublished = item.steerLocal === true && item.steer !== 'failed';
  let lead: ReactNode = null;
  if (item.steer === 'held') lead = <span className="message-steer-note">{t('Runs after this task')}</span>;
  else if (item.steer === 'failed') {
    lead = (
      <>
        <span className="message-steer-note">{t('Not sent')}</span>
        <span className="message-steer-dot" aria-hidden="true">
          ·
        </span>
        {actions && (
          <button type="button" className="message-steer-action" onClick={() => actions.retry(id)}>
            {t('Send again')}
          </button>
        )}
      </>
    );
  } else if (actions) {
    lead = (
      <button type="button" className="message-steer-action" disabled={unpublished} onClick={() => actions.sendNow(id)}>
        {t('Send now')}
      </button>
    );
  }
  // Touch has no hover: there ✕ always shows, beside Send now.
  const touch = touchPrimaryPointer() || isPhoneSurfaceMarked();
  return (
    <div className="message-steer" data-steer={item.steer} {...(touch ? { 'data-touch': '' } : {})}>
      {actions && !unpublished && (
        <button
          type="button"
          className="message-steer-cancel"
          aria-label={t('Cancel message')}
          data-tooltip={t('Cancel message')}
          onClick={() => actions.cancel(id)}
        >
          <X size={12} aria-hidden="true" />
        </button>
      )}
      {lead}
    </div>
  );
}
