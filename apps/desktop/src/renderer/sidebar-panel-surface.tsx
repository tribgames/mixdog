import { Component, useLayoutEffect, useRef, type ReactNode } from "react";

/**
 * Shared lifecycle helpers for the rail destinations hosted in the session
 * panel (Projects / Schedules / Webhooks / Workflows).
 *
 * Those panels stay MOUNTED while hidden so their list, filter and scroll
 * state survive a collapse. Their editors, however, portal to document.body
 * to escape the sidebar's clipped box — and a portal is not covered by the
 * sidebar's `inert`/`aria-hidden`. A deactivated panel must therefore close
 * its own dialogs; anything else leaves a stale interactive layer floating
 * above the workspace with the focus still inside it.
 */
export function useSidebarPanelDismiss(active: boolean, dismiss: () => void): void {
  const latest = useRef(dismiss);
  latest.current = dismiss;
  useLayoutEffect(() => {
    if (active) return;
    // Layout phase: the dialog disappears in the same commit that hides the
    // panel, so no frame can expose it after the sidebar closed or another
    // destination took the panel area.
    latest.current();
  }, [active]);
}

/**
 * A rail panel's lazy chunk must never escape to the root boundary and
 * replace the whole app. A rejected import turns into a compact, panel-local
 * unavailable state with a retry that mounts a FRESH lazy component
 * (React.lazy caches a rejected loader forever).
 */
export class SidebarPanelBoundary extends Component<{
  label: string;
  active: boolean;
  onFailure?(error: unknown): void;
  onRetry?(): void;
  children: ReactNode;
}, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }

  componentDidCatch(error: unknown): void {
    this.props.onFailure?.(error);
  }

  private retry = (): void => {
    this.setState({ failed: false });
    this.props.onRetry?.();
  };

  render(): ReactNode {
    if (!this.state.failed) return this.props.children;
    const { active, label } = this.props;
    // Same surface grammar as a loaded pane: it can be presented, hidden, and
    // swapped like any other destination without special-casing.
    return <div
      className="schedules-pane sidebar-panel-unavailable stable-surface-preserved"
      data-surface-active={active ? "true" : "false"}
      inert={active ? undefined : true}
      aria-hidden={active ? undefined : true}>
      <div className="schedules-page">
        <div className="schedules-empty" role="status">
          <p>{label} could not be loaded.</p>
          <button type="button" className="sidebar-panel-retry" onClick={this.retry}>
            Retry
          </button>
        </div>
      </div>
    </div>;
  }
}
