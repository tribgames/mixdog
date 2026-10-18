import { AlertTriangle, CircleX, Hourglass } from 'lucide-react';
import type { SessionAttention } from '../shared/session-attention';
import { t } from './i18n';
import { ProgressSpinner } from './ProgressSpinner';

/** The glyph of a session that needs the user, failed, or waits on its
 *  background work, shared by tabs,
 *  sidebar rows and collapsed project groups; running keeps each surface's
 *  spinner and unread its dot. The shape, not only the tint, names the state. */
export function SessionAttentionGlyph({
  status,
  name,
  size,
  className,
}: {
  status: SessionAttention | '';
  name: string;
  size: number;
  className: string;
}) {
  if (status !== 'needs-you' && status !== 'failed' && status !== 'waiting') return null;
  let label = t('{{name}} has a failure', { name });
  let Glyph = CircleX;
  if (status === 'needs-you') {
    label = t('{{name}} needs you', { name });
    Glyph = AlertTriangle;
  } else if (status === 'waiting') {
    label = `${name}: ${t('Waiting for tasks')}`;
    Glyph = Hourglass;
  }
  return (
    <span className={`session-attention-glyph ${className}`} data-status={status} role="status" aria-label={label}>
      <Glyph size={size} aria-hidden="true" />
    </span>
  );
}

/** The trailing status icon of a sidebar row or a collapsed project folder:
 *  the spinner while running, the needs-you or failure glyph, else nothing
 *  (unread is the separate dot). */
export function SessionRowStatusIcon({ status, name }: { status: SessionAttention | ''; name: string }) {
  if (status === 'running') {
    return (
      <ProgressSpinner
        size={12}
        className="session-row-spinner"
        role="status"
        aria-label={t('{{name}} is working', { name })}
      />
    );
  }
  return <SessionAttentionGlyph status={status} name={name} size={12} className="session-row-attention" />;
}

/** The finished-unread dot of a sidebar row or a collapsed project folder. */
export function SessionRowUnreadDot({ name }: { name: string }) {
  return (
    <span className="session-row-unread-dot" role="status" aria-label={t('{{name}} has new activity', { name })} />
  );
}
