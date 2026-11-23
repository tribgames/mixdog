import { BrushCleaning } from 'lucide-react';
import type { ReactNode } from 'react';
import { t } from './i18n';
import { MxIcon } from './MxIcon';

/** Every composer island panel's header: its own title chip (never a tab
 *  switcher), an optional quiet status beside it, an optional control, and the
 *  close button at the right end. */
export function IslandPanelHead({
  chip,
  meta,
  metaClassName,
  extra,
  onClose,
}: {
  chip: ReactNode;
  meta?: ReactNode;
  metaClassName?: string;
  /** A control between the counts and close (the files panel's source picker). */
  extra?: ReactNode;
  onClose(): void;
}) {
  return (
    <div className="composer-island-phead">
      <span className="composer-island-tab" data-active="true">
        {chip}
      </span>
      {meta ? (
        <span className={metaClassName ? `composer-island-phead-meta ${metaClassName}` : 'composer-island-phead-meta'}>
          {meta}
        </span>
      ) : null}
      {extra}
      <button
        type="button"
        className="composer-island-close"
        aria-label={t('Close')}
        title={t('Close')}
        onClick={onClose}
      >
        <MxIcon name="close-small" size={16} />
      </button>
    </div>
  );
}

/** An invisible cell in a panel list's state column carrying every label the
 *  column can show: the column takes the longest one's width up front (up to
 *  the stylesheet's cap), so a clock gaining a digit or a row changing state
 *  never re-sizes the column under the other rows. `element` follows the list
 *  (an item of a `ul`). */
export function IslandColumnSizer({ labels, element = 'span' }: { labels: string[]; element?: 'span' | 'li' }) {
  const Cell = element;
  return (
    <Cell className="composer-island-col-sizer" aria-hidden="true" role="none">
      {labels.map((label) => (
        <span key={label} className="agent-activity-elapsed">
          {label}
        </span>
      ))}
    </Cell>
  );
}

/** The composer island panels' footer row (agents, shell, branch), below the
 *  list: the panel's own line or actions on the left, its tidy action at the
 *  right end. Renders nothing when it would hold nothing. */
export function IslandPanelFoot({
  className,
  end,
  children,
}: {
  className?: string;
  /** The right-end action (a TidyButton). */
  end?: ReactNode;
  children?: ReactNode;
}) {
  if (!children && !end) return null;
  return (
    <div className={className ? `composer-island-panel-foot ${className}` : 'composer-island-panel-foot'}>
      {children}
      {end ? <div className="composer-island-panel-foot-end">{end}</div> : null}
    </div>
  );
}

/** The quiet "Clean up" button with the broom: the island footers' right-end
 *  action and the branch menu's last one. `label` is its accessible name, the
 *  broom alone too; `description` (what it removes) its tooltip and
 *  description. */
export function TidyButton({
  className,
  kind,
  label,
  description,
  disabled = false,
  onClick,
}: {
  className: string;
  kind: string;
  label: string;
  description: string;
  /** Shown but not clickable (aria-disabled, so the tooltip still reads). */
  disabled?: boolean;
  onClick(): void;
}) {
  return (
    <button
      type="button"
      className={className}
      data-kind={kind}
      aria-disabled={disabled || undefined}
      aria-label={label}
      title={description}
      onClick={() => {
        if (!disabled) onClick();
      }}
    >
      <BrushCleaning size={14} aria-hidden="true" />
      <span>{label}</span>
    </button>
  );
}
