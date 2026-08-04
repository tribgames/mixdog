import {
  forwardRef,
  useEffect,
  type ButtonHTMLAttributes,
  type HTMLAttributes,
  type InputHTMLAttributes,
  type ReactNode,
  type SelectHTMLAttributes,
} from "react";

import { MxIcon } from "../MxIcon";
import { acquireTitleBarDim } from "../titlebar-dim";

function classes(...values: Array<string | false | null | undefined>): string {
  return values.filter(Boolean).join(" ");
}

export function Button({
  variant = "secondary",
  size = "sm",
  icon,
  busy = false,
  className,
  children,
  disabled,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: "primary" | "secondary" | "ghost" | "danger";
  size?: "xs" | "sm" | "md";
  icon?: string;
  busy?: boolean;
}) {
  return <button
    {...props}
    type={props.type || "button"}
    className={classes("mx-button", `is-${variant}`, `is-${size}`, className)}
    disabled={disabled || busy}
    aria-busy={busy || undefined}>
    {icon && <MxIcon name={busy ? "loading" : icon} size={14} />}
    {children}
  </button>;
}

export function IconButton({
  icon,
  label,
  className,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  icon: string;
  label: string;
}) {
  return <button {...props} type={props.type || "button"}
    className={classes("mx-icon-button", className)} aria-label={label}
    data-tooltip={label}>
    <MxIcon name={icon} size={15} />
  </button>;
}

export const TextInput = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(
  function TextInput({ className, ...props }, ref) {
    return <input {...props} ref={ref} className={classes("mx-input", className)} />;
  },
);

export function Select({
  className,
  children,
  ...props
}: SelectHTMLAttributes<HTMLSelectElement>) {
  return <select {...props} className={classes("mx-select", className)}>{children}</select>;
}

export function Toolbar({
  className,
  ...props
}: HTMLAttributes<HTMLDivElement>) {
  return <div {...props} className={classes("mx-toolbar", className)} />;
}

export function StatusBadge({
  tone = "neutral",
  children,
}: {
  tone?: "neutral" | "info" | "success" | "warning" | "danger";
  children: ReactNode;
}) {
  return <span className={`mx-status-badge is-${tone}`}>{children}</span>;
}

export function EmptyState({
  icon,
  title,
  detail,
  children,
}: {
  icon?: string;
  title: string;
  detail?: string;
  children?: ReactNode;
}) {
  return <div className="mx-empty-state">
    {icon && <MxIcon name={icon} size={24} />}
    <strong>{title}</strong>
    {detail && <p>{detail}</p>}
    {children}
  </div>;
}

export function Tabs<T extends string>({
  items,
  value,
  onChange,
  className,
  tabClassName,
}: {
  items: ReadonlyArray<{ id: T; label: ReactNode; badge?: ReactNode }>;
  value: T;
  onChange(value: T): void;
  className?: string;
  tabClassName?: string;
}) {
  return <div className={classes("mx-tabs", className)} role="tablist">
    {items.map((item) => <button key={item.id} type="button" role="tab"
      aria-selected={item.id === value}
      className={classes("mx-tab", tabClassName, item.id === value && "is-active")}
      onClick={() => onChange(item.id)}>
      {item.label}{item.badge}
    </button>)}
  </div>;
}

export function TreeView({
  label,
  children,
  className,
}: {
  label: string;
  children: ReactNode;
  className?: string;
}) {
  return <div role="tree" aria-label={label} className={classes("mx-tree", className)}>
    {children}
  </div>;
}

export function MenuList({
  label,
  children,
  className,
}: {
  label: string;
  children: ReactNode;
  className?: string;
}) {
  return <div role="menu" aria-label={label} className={classes("mx-menu", className)}>
    {children}
  </div>;
}

export function DialogFrame({
  title,
  onClose,
  children,
  footer,
}: {
  title: string;
  onClose(): void;
  children: ReactNode;
  footer?: ReactNode;
}) {
  // The scrim below cannot cover the NATIVE caption controls — hold the
  // titlebar dim claim for as long as this dialog layer is mounted.
  useEffect(() => acquireTitleBarDim(), []);
  return <div className="mx-dialog-layer" role="presentation">
    <section className="mx-dialog" role="dialog" aria-modal="true" aria-label={title}>
      <header><strong>{title}</strong><IconButton icon="close-small" label="Close" onClick={onClose} /></header>
      <div className="mx-dialog-body">{children}</div>
      {footer && <footer>{footer}</footer>}
    </section>
  </div>;
}
