// VS Code-style bottom panel shell: toggleable, drag-resizable via a top
// edge handle, with a small tab row (shell jobs / background tasks / logs are
// mapped by the integration layer). Controlled component + a persistence
// hook, so App owns when it exists and what the active tab renders.
// Styling lives in pane-layout.css, imported once at the renderer entry
// (repo convention — components never import css, keeping node tests clean).
import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { IconButton } from "./ui/primitives";
import {
  cancelLayoutFrame,
  flushLayoutFrame,
  scheduleLayoutFrame,
} from "./interaction-frame-scheduler";
import {
  beginBootSurface,
  reportBootSurfaceReady,
  reportBootSurfaceStage,
} from "./boot-metrics";

const BOTTOM_PANEL_KEY = "mixdog.desktop.bottom-panel.v1";
export const BOTTOM_PANEL_MIN_HEIGHT = 120;
export const BOTTOM_PANEL_DEFAULT_HEIGHT = 240;

interface BottomPanelTab {
  id: string;
  label: string;
  badge?: React.ReactNode;
}

export function clampBottomPanelHeight(value: number, viewportHeight: number): number {
  const max = Math.max(BOTTOM_PANEL_MIN_HEIGHT, Math.floor(viewportHeight * 0.7));
  if (!Number.isFinite(value)) return BOTTOM_PANEL_DEFAULT_HEIGHT;
  return Math.min(max, Math.max(BOTTOM_PANEL_MIN_HEIGHT, Math.round(value)));
}

export interface BottomPanelState {
  open: boolean;
  height: number;
  tab: string;
}

export function useBottomPanelState(defaultTab = "") {
  const [state, setState] = useState<BottomPanelState>(() => {
    try {
      const record = JSON.parse(
        window.localStorage.getItem(BOTTOM_PANEL_KEY) || "",
      ) as Record<string, unknown>;
      return {
        open: record.open === true,
        height: clampBottomPanelHeight(Number(record.height), window.innerHeight),
        tab: typeof record.tab === "string" && record.tab.trim() ? record.tab : defaultTab,
      };
    } catch {
      return { open: false, height: BOTTOM_PANEL_DEFAULT_HEIGHT, tab: defaultTab };
    }
  });
  useEffect(() => {
    const timer = window.setTimeout(() => {
      try {
        window.localStorage.setItem(BOTTOM_PANEL_KEY, JSON.stringify(state));
      } catch {
        // Panel persistence is a convenience only.
      }
    }, 120);
    return () => window.clearTimeout(timer);
  }, [state]);
  const setOpen = useCallback((open: boolean) => setState((prev) => ({ ...prev, open })), []);
  const toggle = useCallback(() => setState((prev) => ({ ...prev, open: !prev.open })), []);
  const setHeight = useCallback((height: number) => {
    setState((prev) => ({ ...prev, height: clampBottomPanelHeight(height, window.innerHeight) }));
  }, []);
  const setTab = useCallback((tab: string) => setState((prev) => ({ ...prev, tab, open: true })), []);
  return { ...state, setOpen, toggle, setHeight, setTab };
}

export function BottomPanel({
  open,
  height,
  onHeightChange,
  tabs,
  activeTab,
  onSelectTab,
  onClose,
  actions,
  children,
}: {
  open: boolean;
  height: number;
  onHeightChange: (height: number) => void;
  tabs: ReadonlyArray<BottomPanelTab>;
  activeTab: string;
  onSelectTab: (id: string) => void;
  onClose: () => void;
  actions?: React.ReactNode;
  children?: React.ReactNode;
}): React.JSX.Element | null {
  const [dragging, setDragging] = useState(false);
  const cleanupRef = useRef<(() => void) | null>(null);
  const resizeFrameKey = useRef({});
  const panelRef = useRef<HTMLDivElement | null>(null);
  // Floor-overlap: the workspace column keeps its pane floor (pane-layout.css
  // min-height on .main-panel pane children); a taller panel therefore
  // overflows the column. Pull the panel UP by exactly that overflow so it
  // overlays the pane bottom instead of scrolling the workbench (user
  // decision). Reset-then-measure keeps the sync idempotent.
  const syncOverlay = useCallback(() => {
    const panel = panelRef.current;
    const parent = panel?.parentElement;
    if (!panel || !parent) return;
    panel.style.marginTop = "";
    const shortage = Math.max(0, parent.scrollHeight - parent.clientHeight);
    const overlap = Math.min(shortage, panel.offsetHeight);
    if (overlap > 0) {
      panel.style.marginTop = `-${overlap}px`;
      panel.dataset.overlaying = "true";
    } else {
      panel.dataset.overlaying = "false";
    }
  }, []);
  useLayoutEffect(() => {
    if (open) syncOverlay();
  }, [open, height, syncOverlay]);
  useEffect(() => {
    if (!open || typeof ResizeObserver === "undefined") return undefined;
    const parent = panelRef.current?.parentElement;
    if (!parent) return undefined;
    // The column's size comes from the desktop body, never from this panel's
    // margin, so observing it cannot loop through our own writes.
    const observer = new ResizeObserver(() => syncOverlay());
    observer.observe(parent);
    return () => observer.disconnect();
  }, [open, syncOverlay]);
  useEffect(() => () => cleanupRef.current?.(), []);
  useEffect(() => {
    if (!open) return;
    beginBootSurface("bottom-panel", activeTab);
    reportBootSurfaceStage("bottom-panel", activeTab, "module");
    reportBootSurfaceStage("bottom-panel", activeTab, "data");
    reportBootSurfaceReady("bottom-panel", activeTab);
  }, [activeTab, open]);
  const onPointerDown = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    const handle = event.currentTarget;
    cleanupRef.current?.();
    setDragging(true);
    handle.setPointerCapture(event.pointerId);
    const panel = handle.parentElement as HTMLElement | null;
    let pendingHeight: number | null = null;
    const applyPreview = (): void => {
      if (panel && pendingHeight !== null) {
        panel.style.height = `${pendingHeight}px`;
        syncOverlay();
      }
    };
    const onPointerMove = (moveEvent: PointerEvent): void => {
      if (!handle.hasPointerCapture(event.pointerId)) return;
      // The panel is glued to the window bottom, so its height is simply the
      // distance from the pointer to the bottom edge.
      pendingHeight = clampBottomPanelHeight(
        window.innerHeight - moveEvent.clientY,
        window.innerHeight,
      );
      scheduleLayoutFrame(resizeFrameKey.current, applyPreview);
    };
    let cleaned = false;
    const cleanup = (commit: boolean): void => {
      if (cleaned) return;
      cleaned = true;
      if (commit) flushLayoutFrame(resizeFrameKey.current);
      else cancelLayoutFrame(resizeFrameKey.current);
      setDragging(false);
      try {
        if (handle.hasPointerCapture(event.pointerId)) {
          handle.releasePointerCapture(event.pointerId);
        }
      } catch {
        // Unmount cleanup can run after Chromium already dropped the capture.
      }
      handle.removeEventListener("pointermove", onPointerMove);
      handle.removeEventListener("pointerup", stop);
      handle.removeEventListener("pointercancel", stop);
      handle.removeEventListener("lostpointercapture", stop);
      if (commit && pendingHeight !== null) onHeightChange(pendingHeight);
      if (cleanupRef.current === dispose) cleanupRef.current = null;
    };
    const stop = () => cleanup(true);
    const dispose = () => cleanup(false);
    handle.addEventListener("pointermove", onPointerMove);
    handle.addEventListener("pointerup", stop);
    handle.addEventListener("pointercancel", stop);
    handle.addEventListener("lostpointercapture", stop);
    cleanupRef.current = dispose;
  }, [onHeightChange, syncOverlay]);
  if (!open) return null;
  return (
    <div className="bottom-panel" ref={panelRef} style={{ height }} data-testid="bottom-panel">
      <div
        className={`bottom-panel-resize${dragging ? " is-dragging" : ""}`}
        onPointerDown={onPointerDown}
      />
      <div className="bottom-panel-tabs">
        <div className="bottom-panel-tab-region">
          <div className="bottom-panel-tab-list" role="tablist">
            {tabs.map((tab) => <button key={tab.id} type="button" role="tab"
              aria-selected={tab.id === activeTab}
              className={`bottom-panel-tab${tab.id === activeTab ? " is-active" : ""}`}
              onClick={() => onSelectTab(tab.id)}>
              {tab.label}{tab.badge}
            </button>)}
          </div>
        </div>
        <div className="bottom-panel-tabs-spacer" />
        {actions}
        <IconButton icon="close-small" label="Close panel"
          className="bottom-panel-close" onClick={onClose} />
      </div>
      <div className="bottom-panel-body">{children}</div>
    </div>
  );
}
