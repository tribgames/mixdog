// Bottom panel shell: toggleable, drag-resizable via a top
// edge handle, with a small tab row (shell jobs / background tasks / logs are
// mapped by the integration layer). Controlled component + a persistence
// hook, so App owns when it exists and what the active tab renders.
// Styling lives in pane-layout.css, imported once at the renderer entry
// (repo convention — components never import css, keeping node tests clean).
import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { t } from "./i18n";
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
import {
  bottomPanelOpenForPane,
  restoreBottomPanelOpenPaneIds,
  setBottomPanelPaneOpen,
} from "./bottom-panel-pane-state";
import { usePageHideFlush } from "./layout-persistence";

const BOTTOM_PANEL_KEY = "mixdog.desktop.bottom-panel.v1";
export const BOTTOM_PANEL_MIN_HEIGHT = 120;
export const BOTTOM_PANEL_DEFAULT_HEIGHT = 380;
/** Sheet exit hold: --mx-side-panel-duration (180ms) plus one frame of slack. */
const SHEET_EXIT_MS = 200;

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

export type BottomPanelMotion = "animated" | "instant";

interface StoredBottomPanelState {
  openPaneIds: ReadonlySet<string>;
  height: number;
  tab: string;
}

export function useBottomPanelState(activePaneId: string, defaultTab = "problems") {
  // Height and each PANE's open state carry across reloads; the ACTIVE TAB
  // never does. The legacy global `open` flag migrates to the focused PANE.
  const [state, setState] = useState<StoredBottomPanelState>(() => {
    try {
      const record = JSON.parse(
        window.localStorage.getItem(BOTTOM_PANEL_KEY) || "",
      ) as Record<string, unknown>;
      return {
        openPaneIds: restoreBottomPanelOpenPaneIds(record, activePaneId),
        height: clampBottomPanelHeight(Number(record.height), window.innerHeight),
        tab: defaultTab,
      };
    } catch {
      return {
        openPaneIds: new Set(),
        height: BOTTOM_PANEL_DEFAULT_HEIGHT,
        tab: defaultTab,
      };
    }
  });
  const [motion, setMotion] = useState<BottomPanelMotion>("animated");
  const persistState = useCallback(() => {
    try {
      window.localStorage.setItem(
        BOTTOM_PANEL_KEY,
        JSON.stringify({
          openPaneIds: [...state.openPaneIds],
          height: state.height,
        }),
      );
    } catch {
      // Panel persistence is a convenience only.
    }
  }, [state.height, state.openPaneIds]);
  usePageHideFlush(persistState);
  useEffect(() => {
    const timer = window.setTimeout(persistState, 120);
    return () => window.clearTimeout(timer);
  }, [persistState]);
  const setOpen = useCallback((
    open: boolean,
    nextMotion: BottomPanelMotion = "animated",
  ) => {
    setMotion(nextMotion);
    setState((prev) => ({
      ...prev,
      openPaneIds: setBottomPanelPaneOpen(prev.openPaneIds, activePaneId, open),
    }));
  }, [activePaneId]);
  const toggle = useCallback((nextMotion: BottomPanelMotion = "animated") => {
    setMotion(nextMotion);
    setState((prev) => ({
      ...prev,
      openPaneIds: setBottomPanelPaneOpen(
        prev.openPaneIds,
        activePaneId,
        !bottomPanelOpenForPane(prev.openPaneIds, activePaneId),
      ),
    }));
  }, [activePaneId]);
  // A pane's OWN close/open control targets that pane, focused or not — the
  // panel is the file editor's sub-panel now (user: DIFF처럼 스크립트에
  // 종속), so every pane renders its own instance from openPaneIds.
  const setOpenFor = useCallback((paneId: string, open: boolean) => {
    setState((prev) => ({
      ...prev,
      openPaneIds: setBottomPanelPaneOpen(prev.openPaneIds, paneId, open),
    }));
  }, []);
  const setHeight = useCallback((height: number) => {
    setState((prev) => ({ ...prev, height: clampBottomPanelHeight(height, window.innerHeight) }));
  }, []);
  const setTab = useCallback((
    tab: string,
    nextMotion: BottomPanelMotion = "animated",
  ) => {
    setMotion(nextMotion);
    setState((prev) => ({
      ...prev,
      tab,
      openPaneIds: setBottomPanelPaneOpen(prev.openPaneIds, activePaneId, true),
    }));
  }, [activePaneId]);
  return {
    open: bottomPanelOpenForPane(state.openPaneIds, activePaneId),
    openPaneIds: state.openPaneIds,
    height: state.height,
    tab: state.tab,
    motion,
    setOpen,
    setOpenFor,
    toggle,
    setHeight,
    setTab,
  };
}

export function BottomPanel({
  open,
  height,
  onHeightChange,
  tabs,
  activeTab,
  onSelectTab,
  onClose,
  headerActions,
  actions,
  children,
  motion = "animated",
}: {
  open: boolean;
  height: number;
  onHeightChange: (height: number) => void;
  tabs: ReadonlyArray<BottomPanelTab>;
  activeTab: string;
  onSelectTab: (id: string) => void;
  onClose: () => void;
  headerActions?: React.ReactNode;
  actions?: React.ReactNode;
  children?: React.ReactNode;
  motion?: BottomPanelMotion;
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
  // The workspace column's pane floor keys on this flag instead of
  // `.main-panel:has(.bottom-panel)`: that :has() made Chromium re-scan the
  // whole column — every diff row, every transcript row — on each composer
  // keystroke (measured 10–16ms of style recalc per key beside a big diff).
  useLayoutEffect(() => {
    const panel = panelRef.current;
    const column = panel?.closest<HTMLElement>(".main-panel") ?? panel?.parentElement;
    if (!column) return undefined;
    column.dataset.bottomPanel = "true";
    return () => { delete column.dataset.bottomPanel; };
  }, []);
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
    // The panel grows UPWARD from its own bottom edge — the pane bottom now,
    // the window bottom before. Measure that anchor once: it never moves
    // during the drag, while window math broke for panes above a split.
    const anchorBottom = panel?.getBoundingClientRect().bottom ?? window.innerHeight;
    let pendingHeight: number | null = null;
    const applyPreview = (): void => {
      if (panel && pendingHeight !== null) {
        panel.style.height = `${pendingHeight}px`;
        syncOverlay();
      }
    };
    const onPointerMove = (moveEvent: PointerEvent): void => {
      if (!handle.hasPointerCapture(event.pointerId)) return;
      pendingHeight = clampBottomPanelHeight(
        anchorBottom - moveEvent.clientY,
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
  // Mount-once animation flag (mirrors the dock's data-entering): once the
  // open animation has run, band crossings re-applying the sheet media
  // rules must not replay it (user rule: 해상도 전환엔 애니 없음).
  const [settled, setSettled] = useState(false);
  useEffect(() => {
    if (!open) { setSettled(false); return undefined; }
    const timer = window.setTimeout(() => setSettled(true), 400);
    return () => window.clearTimeout(timer);
  }, [open]);
  // Closing slide (user: 열리고 닫힐 때 부드럽게). Unmounting on close left CSS
  // with no element to animate, so the sheet vanished on its first frame while
  // the entry glided in. Hold it for the shared sheet clock
  // (--mx-side-panel-duration) as data-state="closed", then unmount. The
  // in-flow wide layout and instant band corrections skip the hold entirely.
  const [closing, setClosing] = useState(false);
  const wasOpen = useRef(open);
  useEffect(() => {
    if (wasOpen.current === open) return undefined;
    wasOpen.current = open;
    if (open) {
      setClosing(false);
      return undefined;
    }
    const sheetBand = window.matchMedia?.("(max-width: 940px)").matches === true;
    if (!sheetBand || motion === "instant") {
      setClosing(false);
      return undefined;
    }
    setClosing(true);
    const timer = window.setTimeout(() => setClosing(false), SHEET_EXIT_MS);
    return () => window.clearTimeout(timer);
  }, [motion, open]);
  if (!open && !closing) return null;
  return (
    <div className="bottom-panel" ref={panelRef} style={{ height }} data-testid="bottom-panel"
      data-state={open ? "open" : "closed"}
      aria-hidden={open ? undefined : true}
      inert={!open}
      data-settled={settled ? "true" : undefined} data-motion={motion}>
      <div
        className={`bottom-panel-resize${dragging ? " is-dragging" : ""}`}
        onPointerDown={onPointerDown}
      />
      <div className={`bottom-panel-tabs${actions ? " has-toolbar" : ""}`}>
        <div className="bottom-panel-tab-region">
          <div className="bottom-panel-tab-list" role="tablist">
            {tabs.map((tab) => <button key={tab.id} type="button" role="tab"
              aria-selected={tab.id === activeTab}
              className={`bottom-panel-tab${tab.id === activeTab ? " is-active" : ""}`}
              onClick={() => onSelectTab(tab.id)}>
              {t(tab.label)}{tab.badge}
            </button>)}
          </div>
        </div>
        <div className="bottom-panel-tabs-spacer" />
        {headerActions &&
          <div className="bottom-panel-header-actions">{headerActions}</div>}
        <IconButton icon="close-small" label={t("Close panel")}
          className="bottom-panel-close" onClick={onClose} />
      </div>
      {actions && <div className="bottom-panel-toolbar">{actions}</div>}
      <div className="bottom-panel-body">{children}</div>
    </div>
  );
}
