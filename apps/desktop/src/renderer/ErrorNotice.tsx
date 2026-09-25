import { AlertCircle, ChevronDown, ExternalLink, RotateCcw, X } from 'lucide-react';
import { type ReactNode, useState } from 'react';
// @ts-expect-error Shared runtime module is plain ESM.
import { describeError, safeErrorDetails } from '../../../../src/runtime/shared/error-presentation.mjs';
import { t } from './i18n';
import { localizeErrorCopy } from './error-notice-copy';

export { describeError, safeErrorDetails };

/** The message a failure carried, without Electron's IPC envelope
 *  (`Error invoking remote method '…': Error: …`). */
export function errorMessageText(reason: unknown): string {
  return safeErrorDetails(reason instanceof Error ? reason.message : String(reason))
    .replace(/^(?:Error invoking remote method ['"][^'"]+['"]:\s*)?(?:Error:\s*)?/i, '')
    .trim();
}

export function errorSummary(reason: unknown): string {
  const { summary } = describeError(reason);
  return localizeErrorCopy(summary);
}

// Google answers an account check with a one-time verification link buried in
// the error body. The link is the only way forward, so it gets its own action
// instead of hiding behind "Show details".
const VERIFICATION_URL = /https:\/\/accounts\.google\.com\/[^\s'"<>)]+/;

export function verificationUrlOf(reason: unknown): string {
  return VERIFICATION_URL.exec(describeError(reason).details)?.[0] ?? '';
}

export function ErrorNotice({
  error,
  errors,
  count,
  title,
  className = '',
  onRetry,
  retryDisabled = false,
  onDismiss,
  action,
  role = 'alert',
}: {
  error?: unknown;
  errors?: readonly unknown[];
  count?: number;
  title?: string;
  className?: string;
  onRetry?: () => void;
  retryDisabled?: boolean;
  onDismiss?: () => void;
  action?: ReactNode;
  role?: 'alert' | 'status';
}) {
  const reasons = (errors || [error]).filter((value) => value !== undefined && value !== null && value !== '');
  const [open, setOpen] = useState(false);
  if (!reasons.length) return null;
  const latest = describeError(reasons.at(-1));
  const total = count ?? reasons.length;
  const summary = localizeErrorCopy(latest.summary);
  const details = reasons
    .slice(-50)
    .map((reason) => describeError(reason).details)
    .filter(Boolean);
  const hasDetails = details.length > 1 || (details[0] && details[0] !== summary);
  const verificationUrl = verificationUrlOf(reasons.at(-1));
  return (
    <section className={`error-notice ${className}`} role={role} data-count={total}>
      <div className="error-notice-summary">
        <AlertCircle size={15} aria-hidden="true" />
        <div className="error-notice-copy">
          {title && <strong>{title}</strong>}
          <span>{summary}</span>
        </div>
        {total > 1 && (
          <span className="error-notice-count" aria-label={t('Errors')}>
            ×{total}
          </span>
        )}
        {onDismiss && (
          <button type="button" className="error-notice-dismiss" onClick={onDismiss} aria-label={t('Dismiss error')}>
            <X size={14} />
          </button>
        )}
      </div>
      {latest.recovery && <p className="error-notice-recovery">{localizeErrorCopy(latest.recovery)}</p>}
      {(hasDetails || onRetry || action || verificationUrl) && (
        <div className="error-notice-actions">
          {hasDetails && (
            <button type="button" aria-expanded={open} onClick={() => setOpen((value) => !value)}>
              <ChevronDown size={12} aria-hidden="true" data-open={open} />
              {t('Show details')}
            </button>
          )}
          {verificationUrl && (
            <button
              type="button"
              className="error-notice-verify"
              onClick={() => void window.mixdogDesktop?.openExternal?.(verificationUrl).catch(() => undefined)}
            >
              <ExternalLink size={12} aria-hidden="true" />
              {t('Open verification page')}
            </button>
          )}
          {action}
          {onRetry && (
            <button type="button" disabled={retryDisabled} onClick={onRetry}>
              <RotateCcw size={12} aria-hidden="true" />
              {t('Retry')}
            </button>
          )}
        </div>
      )}
      {open && hasDetails && (
        <div className="error-notice-details" data-scrollable>
          {total > details.length && <span>{t('Recent errors')}</span>}
          {details.map((detail, index) => (
            <pre key={index}>
              {details.length > 1 ? `${total - details.length + index + 1}. ` : ''}
              {detail}
            </pre>
          ))}
        </div>
      )}
    </section>
  );
}

export function InlineErrors({ messages }: { messages: readonly unknown[] }) {
  return <ErrorNotice errors={messages} />;
}
