import { AlertTriangle, CircleX, MessageCircleQuestion } from 'lucide-react';
import type { SessionAttention } from '../shared/session-attention';
import { t } from './i18n';
import { ProgressSpinner } from './ProgressSpinner';

const ATTENTION_GLYPHS = { 'needs-you': AlertTriangle, asking: MessageCircleQuestion, failed: CircleX };

function attentionLabel(status: 'needs-you' | 'asking' | 'failed', name: string, count: number): string {
  if (status === 'needs-you') {
    return count >= 2
      ? t('{{name}} · Waiting for approval ({{count}})', { name, count })
      : t('{{name}} · Waiting for approval', { name });
  }
  if (status === 'asking') return t('{{name}} · Waiting for your answer', { name });
  return t('{{name}} has a failure', { name });
}

/** The glyph of a session that needs the user, failed, or waits on its
 *  background work, shared by tabs,
 *  sidebar rows and collapsed project groups; running keeps each surface's
 *  spinner and unread its dot. The shape, not only the tint, names the state. */
export function SessionAttentionGlyph({
  status,
  name,
  size,
  className,
  count = 1,
}: {
  status: SessionAttention | '';
  name: string;
  size: number;
  className: string;
  /** Sessions waiting on approval behind a bot row; the digit shows from 2. */
  count?: number;
}) {
  if (status !== 'needs-you' && status !== 'asking' && status !== 'failed' && status !== 'waiting') return null;
  // Waiting on its own background work still reads as working: the plain
  // spinner, labelled with the waiting state.
  if (status === 'waiting') {
    return (
      <span
        className={`session-attention-glyph ${className}`}
        data-status={status}
        role="status"
        aria-label={`${name}: ${t('Waiting for tasks')}`}
      >
        <ProgressSpinner size={size} aria-hidden="true" />
      </span>
    );
  }
  const many = status === 'needs-you' && count >= 2;
  const label = attentionLabel(status, name, count);
  const Glyph = ATTENTION_GLYPHS[status];
  return (
    <span className={`session-attention-glyph ${className}`} data-status={status} role="status" aria-label={label}>
      <Glyph size={size} aria-hidden="true" />
      {many && (
        <span className="session-attention-count" aria-hidden="true">
          {count}
        </span>
      )}
    </span>
  );
}

/** The trailing status icon of a sidebar row or a collapsed project folder:
 *  the spinner while running, the needs-you or failure glyph, else nothing
 *  (unread is the separate dot). */
export function SessionRowStatusIcon({
  status,
  name,
  count,
}: {
  status: SessionAttention | '';
  name: string;
  count?: number;
}) {
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
  return (
    <SessionAttentionGlyph status={status} name={name} size={12} className="session-row-attention" count={count} />
  );
}

/** The finished-unread dot of a sidebar row or a collapsed project folder. */
export function SessionRowUnreadDot({ name }: { name: string }) {
  return (
    <span className="session-row-unread-dot" role="status" aria-label={t('{{name}} has new activity', { name })} />
  );
}
