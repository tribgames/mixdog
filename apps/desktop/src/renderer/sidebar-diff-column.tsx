import {
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
} from "react";

import { DESKTOP_WORKSPACE_MIN_WIDTH } from "../shared/window-layout";
import {
  DIFF_STARTUP_DELAY_MS,
  ReadyGitDiffPane,
} from "./app-shell-components";
import { t } from "./i18n";
import { isMobileRemoteSurface } from "./mobile-surface";
import {
  PANE_SIDE_DOCK_DIFF_DEFAULT_WIDTH,
  PANE_SIDE_DOCK_DIFF_MAX_WIDTH,
  PANE_SIDE_DOCK_DIFF_MIN_WIDTH,
  readStoredWidth,
  useRetainedDiff,
  type PaneSideDockDiff,
} from "./pane-side-dock";
import { DeferredPersistentSurface } from "./PaneSurfaceGate";
import { DesktopLoadingSurface } from "./RendererRecovery";

/** The LEFT sidebar's diff column keeps its own width preference; the right
 *  dock's pair column has a separate one. */
const SIDEBAR_DIFF_WIDTH_KEY = "mixdog.desktop.sidebar-diff-width.v1";

/** Narrow bands render the left sidebar as a drawer sheet; the column has no
 *  place there and Source Control falls back to the diff tab. */
export function sidebarDiffColumnAvailable(): boolean {
  if (isMobileRemoteSurface()) return false;
  try { return !window.matchMedia("(max-width: 760px)").matches; } catch { return true; }
}

/** Diff column paired to the RIGHT of the left sidebar (user: 왼쪽 소스컨트롤도
 *  오른쪽 세션 변경사항 독처럼 우측 확장 스타일) — the same column grammar as
 *  the pane dock's `.pane-dock-diff-column`: draggable width, hidden (not
 *  unmounted) on close, and an overlay over the workspace when the pair no
 *  longer leaves the conversation its floor. */
export function SidebarDiffColumn({
  diff,
  showing,
  onClose,
  openFileTab,
}: {
  diff: PaneSideDockDiff | null;
  /** The sidebar is open on a view that owns the diff. */
  showing: boolean;
  onClose(): void;
  openFileTab(project: string, rel: string, line?: number): void;
}) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const [pref, setPref] = useState(() => readStoredWidth(
    SIDEBAR_DIFF_WIDTH_KEY,
    PANE_SIDE_DOCK_DIFF_MIN_WIDTH,
    PANE_SIDE_DOCK_DIFF_MAX_WIDTH,
    PANE_SIDE_DOCK_DIFF_DEFAULT_WIDTH,
  ));
  const resizeStart = useRef<{ x: number; width: number } | null>(null);
  const dragPending = useRef<number | null>(null);
  const retained = useRetainedDiff(diff);
  const columnDiff = diff ?? retained;
  const visible = showing && diff !== null;
  // Room to the right of the sidebar: the workbench width minus the column's
  // own left edge and the conversation floor. Below the column's minimum the
  // column floats over the workspace instead of crushing it.
  const [geometry, setGeometry] = useState({ left: 0, room: Number.POSITIVE_INFINITY });
  useEffect(() => {
    if (!visible) return undefined;
    const host = hostRef.current;
    const body = host?.closest<HTMLElement>(".desktop-body");
    if (!host || !body) return undefined;
    const measure = () => {
      const bodyRect = body.getBoundingClientRect();
      const previous = host.previousElementSibling as HTMLElement | null;
      const left = previous
        ? previous.getBoundingClientRect().right - bodyRect.left
        : host.getBoundingClientRect().left - bodyRect.left;
      const room = bodyRect.width - left - DESKTOP_WORKSPACE_MIN_WIDTH;
      setGeometry((current) =>
        current.left === left && current.room === room ? current : { left, room });
    };
    measure();
    if (typeof ResizeObserver === "undefined") return undefined;
    const observer = new ResizeObserver(measure);
    observer.observe(body);
    const previous = host.previousElementSibling;
    if (previous) observer.observe(previous);
    return () => observer.disconnect();
  }, [visible]);
  if (!columnDiff) return null;
  const desired = Math.max(
    PANE_SIDE_DOCK_DIFF_MIN_WIDTH,
    Math.min(pref, PANE_SIDE_DOCK_DIFF_MAX_WIDTH),
  );
  const overlay = visible && geometry.room < desired;
  const width = overlay
    ? Math.max(PANE_SIDE_DOCK_DIFF_MIN_WIDTH, Math.min(desired, geometry.room + DESKTOP_WORKSPACE_MIN_WIDTH))
    : desired;
  return <div className="sidebar-diff-column" ref={hostRef}
    hidden={!visible}
    inert={visible ? undefined : true}
    data-overlay={overlay ? "true" : "false"}
    style={{
      "--sidebar-diff-width": `${width}px`,
      "--sidebar-diff-left": `${geometry.left}px`,
    } as CSSProperties}>
    <div className="sidebar-diff-body">
      <div className="workbench-side-surface-slot"
        data-surface-active={visible ? "true" : "false"}>
        <DeferredPersistentSurface active
          startupDelayMs={DIFF_STARTUP_DELAY_MS}
          fallback={<DesktopLoadingSurface label={t("Loading diff…")} />}>
          <ReadyGitDiffPane selection={columnDiff} active={visible}
            onOpenFile={openFileTab}
            onClose={onClose} />
        </DeferredPersistentSurface>
      </div>
    </div>
    <div className="sidebar-diff-resize" role="separator"
      aria-orientation="vertical"
      onPointerDown={(event: ReactPointerEvent<HTMLDivElement>) => {
        if (event.button !== 0) return;
        resizeStart.current = { x: event.clientX, width };
        dragPending.current = null;
        event.currentTarget.setPointerCapture(event.pointerId);
      }}
      onPointerMove={(event) => {
        const start = resizeStart.current;
        if (!start || !event.currentTarget.hasPointerCapture(event.pointerId)) return;
        const next = Math.max(
          PANE_SIDE_DOCK_DIFF_MIN_WIDTH,
          Math.min(PANE_SIDE_DOCK_DIFF_MAX_WIDTH,
            Math.round(start.width + (event.clientX - start.x))),
        );
        dragPending.current = next;
        setPref(next);
      }}
      onPointerUp={(event) => {
        if (!resizeStart.current) return;
        resizeStart.current = null;
        try { event.currentTarget.releasePointerCapture(event.pointerId); } catch {}
        const next = dragPending.current ?? width;
        dragPending.current = null;
        try { window.localStorage.setItem(SIDEBAR_DIFF_WIDTH_KEY, String(next)); }
        catch { /* session-only */ }
      }} />
  </div>;
}
