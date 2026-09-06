import { AlertCircle, ChevronDown, RotateCcw, X } from "lucide-react";
import { type ReactNode, useState } from "react";
// @ts-expect-error Shared runtime module is plain ESM.
import { describeError, safeErrorDetails } from "../../../../src/runtime/shared/error-presentation.mjs";
import { t } from "./i18n";
import { localizeErrorCopy } from "./error-notice-copy";

export { describeError, safeErrorDetails };

export function errorSummary(reason: unknown): string {
  const { summary } = describeError(reason);
  return localizeErrorCopy(summary);
}

export function ErrorNotice({
  error, errors, count, title, className = "", onRetry, retryDisabled = false,
  onDismiss, action, role = "alert",
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
  role?: "alert" | "status";
}) {
  const reasons = (errors || [error]).filter((value) => value !== undefined && value !== null && value !== "");
  const [open, setOpen] = useState(false);
  if (!reasons.length) return null;
  const latest = describeError(reasons.at(-1));
  const total = count ?? reasons.length;
  const summary = errorSummary(reasons.at(-1));
  const details = reasons.slice(-50).map((reason) => describeError(reason).details).filter(Boolean);
  const hasDetails = details.length > 1 || (details[0] && details[0] !== summary);
  return <section className={`error-notice ${className}`} role={role} data-count={total}>
    <div className="error-notice-summary">
      <AlertCircle size={15} aria-hidden="true" />
      <div className="error-notice-copy">
        {title && <strong>{title}</strong>}
        <span>{summary}</span>
      </div>
      {total > 1 && <span className="error-notice-count" aria-label={t("Errors")}>×{total}</span>}
      {onDismiss && <button type="button" className="error-notice-dismiss"
        onClick={onDismiss} aria-label={t("Dismiss error")}><X size={14} /></button>}
    </div>
    {latest.recovery && <p className="error-notice-recovery">{localizeErrorCopy(latest.recovery)}</p>}
    {(hasDetails || onRetry || action) && <div className="error-notice-actions">
      {hasDetails && <button type="button" aria-expanded={open} onClick={() => setOpen((value) => !value)}>
        <ChevronDown size={12} aria-hidden="true" data-open={open} />{t("Show details")}
      </button>}
      {action}
      {onRetry && <button type="button" disabled={retryDisabled} onClick={onRetry}>
        <RotateCcw size={12} aria-hidden="true" />{t("Retry")}
      </button>}
    </div>}
    {open && hasDetails && <div className="error-notice-details" data-scrollable>
      {total > details.length && <span>{t("Recent errors")}</span>}
      {details.map((detail, index) => <pre key={index}>{details.length > 1 ? `${total - details.length + index + 1}. ` : ""}{detail}</pre>)}
    </div>}
  </section>;
}

export function InlineErrors({ messages }: { messages: readonly unknown[] }) {
  return <ErrorNotice errors={messages} />;
}
