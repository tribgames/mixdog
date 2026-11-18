import { BrushCleaning } from 'lucide-react';
import type { ReactNode } from 'react';

/** The composer island panels' footer row (agents, shell, branch), below the
 *  list: the panel's own line or actions on the left, its tidy action at the
 *  right end. One component so the three panels keep one layout. Renders
 *  nothing when it would hold nothing. */
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
 *  action and the branch menu's last one. `description` (what it removes) is
 *  the tooltip, and the accessible name when `named`. */
export function TidyButton({
  className,
  kind,
  label,
  description,
  named = false,
  disabled = false,
  onClick,
}: {
  className: string;
  kind: string;
  label: string;
  description: string;
  named?: boolean;
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
      aria-label={named ? description : undefined}
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
