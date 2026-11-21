import type React from 'react';
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { t } from './i18n';
import { IconButton } from './ui/primitives';
import { cancelLayoutFrame, flushLayoutFrame, scheduleLayoutFrame } from './interaction-frame-scheduler';
import { beginBootSurface, reportBootSurfaceReady, reportBootSurfaceStage } from './boot-metrics';
import {
  bottomPanelOpenForPane,
  restoreBottomPanelOpenPaneIds,
  setBottomPanelPaneOpen,
} from './bottom-panel-pane-state';
import { usePageHideFlush } from './layout-persistence';
import { BOTTOM_SHEET_QUERY } from './use-responsive-shell-bands';

const BOTTOM_PANEL_KEY = 'mixdog.desktop.bottom-panel.v1';
const BOTTOM_PANEL_MIN_HEIGHT = 120;
const BOTTOM_PANEL_DEFAULT_HEIGHT = 380;
/** Sheet exit hold: --mx-side-panel-duration (180ms) plus one frame of slack. */
const SHEET_EXIT_MS = 200;

interface BottomPanelTab {
  id: string;
  label: string;
  badge?: React.ReactNode;
}

function clampBottomPanelHeight(value: number, viewportHeight: number): number {
  const max = Math.max(BOTTOM_PANEL_MIN_HEIGHT, Math.floor(viewportHeight * 0.7));
  if (!Number.isFinite(value)) return BOTTOM_PANEL_DEFAULT_HEIGHT;
  return Math.min(max, Math.max(BOTTOM_PANEL_MIN_HEIGHT, Math.round(value)));
}

type BottomPanelMotion = 'animated' | 'instant';

interface StoredBottomPanelState {
  openPaneIds: ReadonlySet<string>;
  height: number;
  tab: string;
}

export function useBottomPanelState(activePaneId: string, defaultTab = 'problems') {
  const [state, setState] = useState<StoredBottomPanelState>(() => {
    try {
      const record = JSON.parse(window.localStorage.getItem(BOTTOM_PANEL_KEY) || '') as Record<string, unknown>;
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
  const [motion, setMotion] = useState<BottomPanelMotion>('animated');
  const persistState = useCallback(() => {
    try {
      window.localStorage.setItem(
        BOTTOM_PANEL_KEY,
        JSON.stringify({
          openPaneIds: [...state.openPaneIds],
          height: state.height,
        })
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
  const setOpen = useCallback(
    (open: boolean, nextMotion: BottomPanelMotion = 'animated') => {
      setMotion(nextMotion);
      setState((prev) => ({
        ...prev,
        openPaneIds: setBottomPanelPaneOpen(prev.openPaneIds, activePaneId, open),
      }));
    },
    [activePaneId]
  );
  const toggle = useCallback(
    (nextMotion: BottomPanelMotion = 'animated') => {
      setMotion(nextMotion);
      setState((prev) => ({
        ...prev,
        openPaneIds: setBottomPanelPaneOpen(
          prev.openPaneIds,
          activePaneId,
          !bottomPanelOpenForPane(prev.openPaneIds, activePaneId)
        ),
      }));
    },
    [activePaneId]
  );
  const setOpenFor = useCallback((paneId: string, open: boolean) => {
    setState((prev) => ({
      ...prev,
      openPaneIds: setBottomPanelPaneOpen(prev.openPaneIds, paneId, open),
    }));
  }, []);
  const setHeight = useCallback((height: number) => {
    setState((prev) => ({ ...prev, height: clampBottomPanelHeight(height, window.innerHeight) }));
  }, []);
  const setTab = useCallback(
    (tab: string, nextMotion: BottomPanelMotion = 'animated') => {
      setMotion(nextMotion);
      setState((prev) => ({
        ...prev,
        tab,
        openPaneIds: setBottomPanelPaneOpen(prev.openPaneIds, activePaneId, true),
      }));
    },
    [activePaneId]
  );
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

/** Keeps the panel overlaying the pane bottom when its height outgrows the workspace column. */
function useBottomPanelOverlay(panelRef: { current: HTMLDivElement | null }, open: boolean, height: number) {
  const syncOverlay = useCallback(() => {
    const panel = panelRef.current;
    const parent = panel?.parentElement;
    if (!panel || !parent) return;
    panel.style.marginTop = '';
    const shortage = Math.max(0, parent.scrollHeight - parent.clientHeight);
    const overlap = Math.min(shortage, panel.offsetHeight);
    if (overlap > 0) {
      panel.style.marginTop = `-${overlap}px`;
      panel.dataset.overlaying = 'true';
    } else {
      panel.dataset.overlaying = 'false';
    }
  }, [panelRef]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: height is not read inside; a height change must re-measure the overlay
  useLayoutEffect(() => {
    if (open) syncOverlay();
  }, [open, height, syncOverlay]);
  // A flag, not `.main-panel:has(.bottom-panel)`: that :has() cost Chromium 10–16ms of style recalc per composer keystroke (measured).
  useLayoutEffect(() => {
    const panel = panelRef.current;
    const column = panel?.closest<HTMLElement>('.main-panel') ?? panel?.parentElement;
    if (!column) return undefined;
    column.dataset.bottomPanel = 'true';
    return () => {
      delete column.dataset.bottomPanel;
    };
  }, [panelRef]);
  useEffect(() => {
    if (!open || typeof ResizeObserver === 'undefined') return undefined;
    const parent = panelRef.current?.parentElement;
    if (!parent) return undefined;
    const observer = new ResizeObserver(() => syncOverlay());
    observer.observe(parent);
    return () => observer.disconnect();
  }, [open, syncOverlay, panelRef]);
  return syncOverlay;
}

/** Drag-to-resize from the top handle: the height previews on the panel and commits on release. */
function useBottomPanelResize(syncOverlay: () => void, onHeightChange: (height: number) => void) {
  const [dragging, setDragging] = useState(false);
  const cleanupRef = useRef<(() => void) | null>(null);
  const resizeFrameKey = useRef({});
  useEffect(() => () => cleanupRef.current?.(), []);
  const onPointerDown = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      event.preventDefault();
      const handle = event.currentTarget;
      cleanupRef.current?.();
      setDragging(true);
      handle.setPointerCapture(event.pointerId);
      const panel = handle.parentElement;
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
        pendingHeight = clampBottomPanelHeight(anchorBottom - moveEvent.clientY, window.innerHeight);
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
          // Chromium may already have dropped the capture on unmount.
        }
        handle.removeEventListener('pointermove', onPointerMove);
        handle.removeEventListener('pointerup', stop);
        handle.removeEventListener('pointercancel', stop);
        handle.removeEventListener('lostpointercapture', stop);
        if (commit && pendingHeight !== null) onHeightChange(pendingHeight);
        if (cleanupRef.current === dispose) cleanupRef.current = null;
      };
      const stop = () => cleanup(true);
      const dispose = () => cleanup(false);
      handle.addEventListener('pointermove', onPointerMove);
      handle.addEventListener('pointerup', stop);
      handle.addEventListener('pointercancel', stop);
      handle.addEventListener('lostpointercapture', stop);
      cleanupRef.current = dispose;
    },
    [onHeightChange, syncOverlay]
  );
  return { dragging, onPointerDown };
}

/** The open animation's one-shot settled flag, and the closing slide held
 *  on screen for the sheet clock before the panel unmounts. */
function useSheetPresence(open: boolean, motion: BottomPanelMotion) {
  const [settled, setSettled] = useState(false);
  useEffect(() => {
    if (!open) {
      setSettled(false);
      return undefined;
    }
    const timer = window.setTimeout(() => setSettled(true), 400);
    return () => window.clearTimeout(timer);
  }, [open]);
  const [closing, setClosing] = useState(false);
  const wasOpen = useRef(open);
  useEffect(() => {
    if (wasOpen.current === open) return undefined;
    wasOpen.current = open;
    if (open) {
      setClosing(false);
      return undefined;
    }
    const sheetBand = window.matchMedia?.(BOTTOM_SHEET_QUERY).matches === true;
    if (!sheetBand || motion === 'instant') {
      setClosing(false);
      return undefined;
    }
    setClosing(true);
    const timer = window.setTimeout(() => setClosing(false), SHEET_EXIT_MS);
    return () => window.clearTimeout(timer);
  }, [motion, open]);
  return { settled, closing };
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
  motion = 'animated',
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
  const panelRef = useRef<HTMLDivElement | null>(null);
  const syncOverlay = useBottomPanelOverlay(panelRef, open, height);
  useEffect(() => {
    if (!open) return;
    beginBootSurface('bottom-panel', activeTab);
    reportBootSurfaceStage('bottom-panel', activeTab, 'module');
    reportBootSurfaceStage('bottom-panel', activeTab, 'data');
    reportBootSurfaceReady('bottom-panel', activeTab);
  }, [activeTab, open]);
  const { dragging, onPointerDown } = useBottomPanelResize(syncOverlay, onHeightChange);
  const { settled, closing } = useSheetPresence(open, motion);
  if (!open && !closing) return null;
  return (
    <div
      className="bottom-panel"
      ref={panelRef}
      style={{ height }}
      data-testid="bottom-panel"
      data-state={open ? 'open' : 'closed'}
      aria-hidden={open ? undefined : true}
      inert={!open}
      data-settled={settled ? 'true' : undefined}
      data-motion={motion}
    >
      <div className={`bottom-panel-resize${dragging ? ' is-dragging' : ''}`} onPointerDown={onPointerDown} />
      <div className={`bottom-panel-tabs${actions ? ' has-toolbar' : ''}`}>
        <div className="bottom-panel-tab-region">
          <div className="bottom-panel-tab-list" role="tablist">
            {tabs.map((tab) => (
              <button
                key={tab.id}
                type="button"
                role="tab"
                aria-selected={tab.id === activeTab}
                className={`bottom-panel-tab${tab.id === activeTab ? ' is-active' : ''}`}
                onClick={() => onSelectTab(tab.id)}
              >
                {t(tab.label)}
                {tab.badge}
              </button>
            ))}
          </div>
        </div>
        <div className="bottom-panel-tabs-spacer" />
        {headerActions && <div className="bottom-panel-header-actions">{headerActions}</div>}
        <IconButton icon="close-small" label={t('Close panel')} className="bottom-panel-close" onClick={onClose} />
      </div>
      {actions && <div className="bottom-panel-toolbar">{actions}</div>}
      <div className="bottom-panel-body">{children}</div>
    </div>
  );
}
