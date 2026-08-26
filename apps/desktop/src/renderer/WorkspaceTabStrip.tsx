// Per-pane workspace tab strip. This is
// the former titlebar strip moved verbatim into a reusable component: every
// pane group mounts one, so the Chrome-parity layout/animation model and the
// drag gestures (reorder inside the strip, drag below it to split/move) keep
// working unchanged. Class names are preserved for the strip-contract dom
// tests and the shared CSS.
import React, {
  type KeyboardEvent,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import { clampOverlayIntoView } from "./anchored-panel";
import {
  FileText,
  FileDiff,
  Folder,
  MessageCircle,
  Sparkles,
  Terminal,
} from "lucide-react";

import type { DesktopSessionSummary } from "../shared/contract";
import type { WorkspaceTab } from "./nav-types";
import { t } from "./i18n";
import { prefetchSurfaceForSelection } from "./lazy-widgets";
import { isMobileRemoteSurface, MobileTabOverview } from "./MobileTabOverview";
import { registerMobileBack, useMobileBack } from "./mobile-back";
import { ProgressSpinner } from "./ProgressSpinner";
import {
  acceptPaneDrag,
  beginPaneDrag,
  currentPaneDrag,
  finishPaneDrag,
  type PaneDragSession,
} from "./pane-drag-session";

export interface WorkspaceTabStripProps {
  tabs: WorkspaceTab[];
  activeKey: string;
  activeBusy?: boolean;
  /** Session catalog: the phone tab overview prints each conversation's own
   *  preview line on its card. */
  sessions?: readonly DesktopSessionSummary[];
  workingSessionIds?: ReadonlySet<string>;
  unreadSessionIds?: ReadonlySet<string>;
  /** Only the focused group's strip consumes global close events (Ctrl+W). */
  focused?: boolean;
  /** Owning pane leaf id, stamped on published drag frames. */
  paneId?: string;
  /** Right-edge controls: status, review, panel. */
  trailing?: React.ReactNode;
  onSelectTab(tab: WorkspaceTab): void;
  onCloseTab(tab: WorkspaceTab): void;
  /** Numeric target is the drop index (tab half rule, container = end). */
  onReorderTab(sourceKey: string, target: string | number): void;
  onPinTab?(tab: WorkspaceTab): void;
  onNewTask(): void;
}

function tabIsWorking(
  tab: WorkspaceTab | undefined,
  active: boolean,
  activeBusy: boolean,
  workingSessionIds: ReadonlySet<string> | undefined,
): boolean {
  if (!tab) return false;
  if (tab.selection.kind === "session") {
    return workingSessionIds?.has(tab.selection.id) === true;
  }
  // activeBusy belongs to the pre-session task owned by this focused strip.
  // Established sessions are keyed exclusively by workingSessionIds so a
  // busy session cannot leak its spinner into the newly selected idle tab.
  return tab.selection.kind === "new" && active && activeBusy;
}

function prefetchTabSurface(tab: WorkspaceTab): void {
  // Shared with the phone tab overview, which warms the same chunks from
  // touch-down because it has no hover to warm them on.
  prefetchSurfaceForSelection(tab.selection);
}

/** Tab-kind glyph shared by the compact current-tab button and the switcher
 *  rows (the full strip keeps its inline chain untouched for the strip
 *  contract tests). */
function tabGlyph(tab: WorkspaceTab, size = 14) {
  switch (tab.selection.kind) {
    case "project": return <Folder size={size} />;
    case "file": return <FileText size={size} />;
    case "diff": return <FileDiff size={size} />;
    case "studio": return <Sparkles size={size} />;
    case "terminal": return <Terminal size={size} />;
    case "folder": return <Folder size={size} />;
    default: return <MessageCircle size={size} />;
  }
}

/* Browser-style tab-strip layout —
 * two proportional layout
 * domains with our flat-design constants (overlap = 0). Above the crossover
 * every tab shares one interpolated width; below it the ACTIVE tab pins at
 * its favicon+close floor while inactive tabs interpolate down to the
 * sliver. The rounded-down remainder is re-granted +1px
 * left-to-right. */
const TAB_STANDARD_WIDTH = 160;
const TAB_MIN_ACTIVE_WIDTH = 56;
const TAB_MIN_INACTIVE_WIDTH = 28;

function calculateChromeTabWidths(
  count: number,
  activeIndex: number,
  available: number,
): number[] {
  if (count <= 0) return [];
  const lerp = (a: number, b: number, f: number) => a + (b - a) * f;
  const clamp01 = (value: number) => Math.min(1, Math.max(0, value));
  const minimum = (count - 1) * TAB_MIN_INACTIVE_WIDTH + TAB_MIN_ACTIVE_WIDTH;
  const crossover = count * TAB_MIN_ACTIVE_WIDTH;
  const preferred = count * TAB_STANDARD_WIDTH;
  let widths: number[];
  let atPreferred = false;
  if (available < crossover) {
    // LayoutDomain::kInactiveWidthBelowActiveWidth
    const fraction = minimum === crossover
      ? 1 : clamp01((available - minimum) / (crossover - minimum));
    widths = Array.from({ length: count }, (_, index) => Math.floor(
      index === activeIndex
        ? TAB_MIN_ACTIVE_WIDTH
        : lerp(TAB_MIN_INACTIVE_WIDTH, TAB_MIN_ACTIVE_WIDTH, fraction)));
  } else {
    // LayoutDomain::kInactiveWidthEqualsActiveWidth
    const fraction = preferred === crossover
      ? 1 : clamp01((available - crossover) / (preferred - crossover));
    atPreferred = fraction >= 1;
    const width = Math.floor(lerp(TAB_MIN_ACTIVE_WIDTH, TAB_STANDARD_WIDTH, fraction));
    widths = Array.from({ length: count }, () => width);
  }
  if (!atPreferred) {
    let extra = Math.floor(available) - widths.reduce((sum, width) => sum + width, 0);
    for (let index = 0; index < widths.length && extra > 0; index += 1, extra -= 1) {
      widths[index] += 1;
    }
  }
  return widths;
}

export function WorkspaceTabStrip({
  tabs,
  activeKey,
  activeBusy = false,
  sessions,
  workingSessionIds,
  unreadSessionIds,
  focused = false,
  paneId = "",
  trailing,
  onSelectTab,
  onCloseTab,
  onReorderTab,
  onPinTab,
  onNewTask,
}: WorkspaceTabStripProps) {
  // Full-screen grid overview backing the compact header's count button.
  const [mobileOverviewOpen, setMobileOverviewOpen] = useState(false);
  // ABB (user: 백버튼 처리): the open overview arms one history sentinel so
  // hardware back closes it instead of leaving the PWA.
  useEffect(() => {
    if (!mobileOverviewOpen) return undefined;
    return registerMobileBack(() => setMobileOverviewOpen(false));
  }, [mobileOverviewOpen]);
  // The mobile root marker + device-scale factor install in main.tsx BEFORE
  // the first render (user: 첫 진입 레이아웃 시프트) — nothing to do here.
  const selectTab = useCallback((tab: WorkspaceTab) => {
    prefetchTabSurface(tab);
    const startedAt = performance.now();
    onSelectTab(tab);
    if (!window.mixdogDesktop?.perfLog) return;
    window.requestAnimationFrame(() => window.requestAnimationFrame(() => {
      window.mixdogDesktop?.perfLog?.(
        `tab-switch kind=${tab.selection.kind} paint=${(performance.now() - startedAt).toFixed(0)}ms`,
      );
    }));
  }, [onSelectTab]);
  const tabNodes = useRef(new Map<string, HTMLDivElement>());
  const tabStrip = useRef<HTMLElement>(null);
  const nativeDrag = useRef<PaneDragSession | null>(null);
  const suppressTabClick = useRef("");
  const [draggingKey, setDraggingKey] = useState("");
  const [dropIndex, setDropIndex] = useState<number | null>(null);
  const [draggingGroup, setDraggingGroup] = useState(false);
  const [dragScroll, setDragScroll] = useState(false);
  const [tabMenu, setTabMenu] = useState<{ key: string; left: number; top: number } | null>(null);
  const tabMenuNode = useRef<HTMLDivElement>(null);
  // Every renderer follows ONE tab-strip layout —
  // tabs shrink to sliver floors and never switch to a device-specific mode.
  const shellNode = useRef<HTMLDivElement>(null);
  const [, setShellWidth] = useState(0);
  const [stripAvailable, setStripAvailable] = useState(0);
  const [tabSwitcher, setTabSwitcher] = useState<{ left: number; top: number } | null>(null);
  const switcherNode = useRef<HTMLDivElement>(null);
  const switcherTriggers = useRef(new Set<HTMLElement>());
  // Chrome-mobile compact header (label + count) engages ONLY where the
  // workspace holds a single pane — the phone remote surface. Wide surfaces
  // keep the full tab strip untouched; the count opens the grid
  // overview instead of the old dropdown list.
  const compact = isMobileRemoteSurface();
  // Layout INPUT: the width the tab run may spend — the shell minus the
  // fixed + slot and the trailing controls.
  const measureWidths = useCallback(() => {
    const shell = shellNode.current;
    if (!shell) return;
    const width = shell.clientWidth;
    setShellWidth((previous) => previous === width ? previous : width);
    const newButton = shell.querySelector<HTMLElement>(":scope > .workspace-tab-new");
    const trailingBox = shell.querySelector<HTMLElement>(":scope > .workspace-tabs-trailing");
    const available = width - (newButton?.offsetWidth ?? 0) - (trailingBox?.offsetWidth ?? 0);
    setStripAvailable((previous) => previous === available ? previous : available);
  }, []);
  const switcherTrigger = useCallback((node: HTMLButtonElement | null) => {
    if (node) switcherTriggers.current.add(node);
    else {
      for (const el of [...switcherTriggers.current]) {
        if (!el.isConnected) switcherTriggers.current.delete(el);
      }
    }
  }, []);
  // Tab context menu (Close / Close Others / Close to the
  // Right / Keep Open) with standard outside-click dismissal.
  useEffect(() => {
    if (!tabMenu) return undefined;
    const closeOutside = (event: PointerEvent) => {
      const target = event.target as Node | null;
      if (target && tabMenuNode.current?.contains(target)) return;
      setTabMenu(null);
    };
    const closeMenu = () => setTabMenu(null);
    document.addEventListener("pointerdown", closeOutside);
    window.addEventListener("resize", closeMenu);
    window.addEventListener("scroll", closeMenu, true);
    return () => {
      document.removeEventListener("pointerdown", closeOutside);
      window.removeEventListener("resize", closeMenu);
      window.removeEventListener("scroll", closeMenu, true);
    };
  }, [tabMenu]);
  // ABB: the context menu closes on hardware back like every other layer.
  useMobileBack(Boolean(tabMenu), () => setTabMenu(null));
  // Compact-mode plumbing: shell width drives the collapse; the switcher
  // follows the same dismissal grammar as the other strip menus.
  useLayoutEffect(() => {
    const shell = shellNode.current;
    if (!shell || typeof ResizeObserver === "undefined") return undefined;
    measureWidths();
    const observer = new ResizeObserver(measureWidths);
    observer.observe(shell);
    return () => observer.disconnect();
  }, [measureWidths]);
  // Trailing controls and tab-count changes move the available width without
  // resizing the shell — re-measure on those renders too.
  useLayoutEffect(() => {
    measureWidths();
  }, [tabs.length, trailing, compact, measureWidths]);
  useEffect(() => {
    if (!compact) setTabSwitcher(null);
  }, [compact]);
  useEffect(() => {
    if (!tabSwitcher) return undefined;
    const closeOutside = (event: PointerEvent) => {
      const target = event.target as Node | null;
      if (target && (switcherNode.current?.contains(target)
        || [...switcherTriggers.current].some((el) => el.contains(target)))) return;
      setTabSwitcher(null);
    };
    const closeMenu = () => setTabSwitcher(null);
    document.addEventListener("pointerdown", closeOutside);
    window.addEventListener("resize", closeMenu);
    window.addEventListener("scroll", closeMenu, true);
    return () => {
      document.removeEventListener("pointerdown", closeOutside);
      window.removeEventListener("resize", closeMenu);
      window.removeEventListener("scroll", closeMenu, true);
    };
  }, [tabSwitcher]);
  // ABB: the switcher list closes on hardware back like the overview above.
  useMobileBack(Boolean(tabSwitcher), () => setTabSwitcher(null));
  useLayoutEffect(() => { clampOverlayIntoView(switcherNode.current); }, [tabSwitcher]);
  // Menus can anchor hard against the window's right edge; the measured box
  // is what keeps them on screen.
  useLayoutEffect(() => { clampOverlayIntoView(tabMenuNode.current); }, [tabMenu]);
  // Fixed sizing freezes each tab's width while the
  // pointer remains over the strip, allowing rapid repeated closes without
  // any width animation or timer.
  const [fixedTabWidths, setFixedTabWidths] =
    useState<ReadonlyMap<string, number>>(() => new Map());
  const previousTabKeys = useRef(tabs.map((tab) => tab.key));
  const revealActiveTab = useCallback(() => {
    const strip = tabStrip.current;
    const node = tabNodes.current.get(activeKey);
    if (!strip || !node) return;
    // The add button is a sibling of the scroll viewport, so clientWidth is
    // already the complete unobscured label run.
    const visibleWidth = strip.clientWidth;
    if (visibleWidth <= 0) return;
    if (strip.scrollWidth <= visibleWidth) {
      strip.scrollLeft = 0;
      return;
    }
    const left = node.offsetLeft;
    const right = left + node.offsetWidth;
    if (right > strip.scrollLeft + visibleWidth) {
      strip.scrollLeft = right - visibleWidth;
    } else if (left < strip.scrollLeft) {
      strip.scrollLeft = left;
    }
  }, [activeKey]);
  useLayoutEffect(() => {
    const previousKeys = previousTabKeys.current;
    const appended = tabs.length > previousKeys.length
      && previousKeys.every((key, index) => tabs[index]?.key === key);
    previousTabKeys.current = tabs.map((tab) => tab.key);
    if (!appended) return;

    setFixedTabWidths(new Map());
    // Reveal a newly appended active
    // tab and the attached add-tab control are revealed before paint.
    if (tabStrip.current) tabStrip.current.scrollLeft = tabStrip.current.scrollWidth;
  }, [tabs]);
  // Reveal-active-tab: switching tabs scrolls the strip MINIMALLY so
  // the active tab is always fully visible — overflow scrolls, it never
  // hides tabs. Right overflow aligns the tab's right edge; left overflow
  // aligns its left edge.
  useLayoutEffect(() => {
    revealActiveTab();
  }, [activeKey, revealActiveTab, tabs]);
  // Parent layout calls are implicit in React/CSS, with no explicit
  // title-control layout pass. Observe this strip's OWN width so sash,
  // dock, sidebar and window changes all release mouse-close sizing and reveal
  // the active label without coupling pane labels to viewport breakpoints.
  useLayoutEffect(() => {
    const strip = tabStrip.current;
    if (!strip || typeof ResizeObserver === "undefined") return undefined;
    let previousWidth = strip.clientWidth;
    const observer = new ResizeObserver(() => {
      const nextWidth = strip.clientWidth;
      if (nextWidth === previousWidth) return;
      previousWidth = nextWidth;
      setFixedTabWidths((current) => current.size > 0 ? new Map() : current);
      revealActiveTab();
    });
    observer.observe(strip);
    return () => observer.disconnect();
  }, [revealActiveTab]);
  const closeTab = useCallback((tab: WorkspaceTab, freezeSurvivorWidths = false) => {
    const closingLastTab = tabs.at(-1)?.key === tab.key;
    if (freezeSurvivorWidths && !closingLastTab) {
      const overrides = new Map<string, number>();
      for (const [key, node] of tabNodes.current) {
        const tabWidth = node.getBoundingClientRect().width;
        if (tabWidth > 0) overrides.set(key, tabWidth);
      }
      setFixedTabWidths(overrides);
    } else {
      setFixedTabWidths(new Map());
    }
    onCloseTab(tab);
  }, [onCloseTab, tabs]);
  const setTabNode = useCallback((key: string, node: HTMLDivElement | null) => {
    if (node) tabNodes.current.set(key, node);
    else tabNodes.current.delete(key);
  }, []);
  const onTabKeyDown = useWorkspaceTabCommands({
    tabs,
    activeKey,
    onSelectTab: selectTab,
    onCloseTab: closeTab,
  });

  // Global Ctrl+W close shortcut (App owns the key handler). Keep this path
  // immediate; keyboard close should not wait for the 200ms pointer animation.
  useEffect(() => {
    const closeActive = () => {
      if (!focused) return;
      const active = tabs.find((tab) => tab.key === activeKey);
      if (active) onCloseTab(active);
    };
    window.addEventListener("mixdog:close-active-tab", closeActive);
    return () => window.removeEventListener("mixdog:close-active-tab", closeActive);
  }, [activeKey, focused, onCloseTab, tabs]);

  const finishNativeDrag = useCallback(() => {
    const drag = nativeDrag.current;
    finishPaneDrag();
    nativeDrag.current = null;
    setDraggingKey("");
    setDraggingGroup(false);
    setDragScroll(false);
    setDropIndex(null);
    delete document.body.dataset.tabDragging;
    if (drag?.kind === "tab") {
      suppressTabClick.current = drag.key;
      window.setTimeout(() => {
        if (suppressTabClick.current === drag.key) suppressTabClick.current = "";
      }, 0);
    }
  }, []);

  const startNativeDrag = useCallback((
    event: React.DragEvent<HTMLElement>,
    kind: "tab" | "group",
    sourceTab: WorkspaceTab | undefined,
  ) => {
    if (!sourceTab) {
      event.preventDefault();
      return;
    }
    const drag: PaneDragSession = {
      kind,
      key: sourceTab.key,
      title: sourceTab.title,
      selection: sourceTab.selection,
      sourceLeafId: paneId,
    };
    nativeDrag.current = drag;
    beginPaneDrag(event.nativeEvent, drag, event.currentTarget);
    if (kind === "group") setDraggingGroup(true);
    else setDraggingKey(sourceTab.key);
    document.body.dataset.tabDragging = "1";
  }, [paneId]);

  const dropIndexAt = useCallback((clientX: number, target: EventTarget | null): number | null => {
    const strip = tabStrip.current;
    if (!strip) return null;
    let index = -1;
    let measured = false;
    let firstLeft = Number.POSITIVE_INFINITY;
    for (let at = 0; at < tabs.length; at += 1) {
      const rect = tabNodes.current.get(tabs[at].key)?.getBoundingClientRect();
      if (!rect || rect.width <= 0) continue;
      measured = true;
      firstLeft = Math.min(firstLeft, rect.left);
      if (index >= 0 || clientX < rect.left || clientX > rect.right) continue;
      index = at + (clientX - rect.left > rect.width / 2 ? 1 : 0);
    }
    if (!measured) {
      const pointedTab = (target as Element | null)
        ?.closest?.<HTMLElement>(".workspace-tab") || null;
      const key = pointedTab && strip.contains(pointedTab)
        ? pointedTab.dataset.tabKey || ""
        : "";
      const at = tabs.findIndex((tab) => tab.key === key);
      if (at >= 0 && pointedTab) {
        const rect = pointedTab.getBoundingClientRect();
        index = at + (clientX - rect.left > rect.width / 2 ? 1 : 0);
      }
    } else if (index < 0) {
      index = clientX < firstLeft ? 0 : tabs.length;
    }
    return index < 0 ? null : index;
  }, [tabs]);

  const handleNativeDragOver = useCallback((event: React.DragEvent<HTMLElement>) => {
    const drag = currentPaneDrag();
    if (!drag) return;
    setDragScroll(true);
    if (drag.kind !== "tab" || drag.sourceLeafId !== paneId) return;
    event.preventDefault();
    event.stopPropagation();
    if (event.dataTransfer) event.dataTransfer.dropEffect = "move";
    setDropIndex(dropIndexAt(event.clientX, event.target));
  }, [dropIndexAt, paneId]);

  const handleNativeDrop = useCallback((event: React.DragEvent<HTMLElement>) => {
    const drag = currentPaneDrag();
    if (!drag || drag.kind !== "tab" || drag.sourceLeafId !== paneId) return;
    event.preventDefault();
    event.stopPropagation();
    const index = dropIndexAt(event.clientX, event.target);
    if (index !== null) onReorderTab(drag.key, index);
    acceptPaneDrag();
    setDropIndex(null);
  }, [dropIndexAt, onReorderTab, paneId]);

  // Chromium CalculateTabBounds output for the current strip input; the
  // per-tab width variable pins basis/min/max exactly like gfx::Rect bounds.
  const chromeWidths = !compact && stripAvailable > 0
    ? calculateChromeTabWidths(
        tabs.length,
        Math.max(0, tabs.findIndex((tab) => tab.key === activeKey)),
        stripAvailable,
      )
    : null;
  return (
      <div ref={shellNode} className="workspace-tabs-shell" data-slot="workspace-tabs"
        data-count={tabs.length} data-compact={compact ? "true" : undefined}
        data-focused={focused ? "true" : "false"}>
        {compact ? (() => {
          const activeTab = tabs.find((tab) => tab.key === activeKey) ?? tabs[0];
          const working = tabIsWorking(activeTab, true, activeBusy, workingSessionIds);
          return <>
            {/* Chrome-mobile home slot: the brand mark opens the session
                sidebar (user: 로고를 구글 홈버튼 위치에, 누르면 사이드탭). */}
            <button type="button" className="workspace-tab-home"
              aria-label={t("Toggle session sidebar")}
              onClick={() => window.dispatchEvent(new Event("mixdog:mobile-home"))}>
              {/* Frameless brand mark (user: 모바일은 프레임 안 들어간 로고):
                  currentColor strokes so it inks like Chrome's home glyph. */}
              <svg className="workspace-tab-home-mark" viewBox="44 44 168 168" aria-hidden="true">
                <g fill="none" stroke="currentColor" strokeWidth="22" strokeLinecap="round">
                  <path d="M116.2 61A68 68 0 0 1 191.9 104.7" />
                  <path d="M116.2 61A68 68 0 0 1 191.9 104.7" transform="rotate(120 128 128)" />
                  <path d="M116.2 61A68 68 0 0 1 191.9 104.7" transform="rotate(240 128 128)" />
                </g>
                <polygon points="128,112 133,123 144,128 133,133 128,144 123,133 112,128 123,123" fill="currentColor" />
              </svg>
            </button>
            <button type="button" ref={switcherTrigger}
              className="workspace-tab-compact-current"
              aria-haspopup="dialog" aria-expanded={mobileOverviewOpen}
              data-tooltip={activeTab?.title}
              onClick={() => setMobileOverviewOpen(true)}
              onContextMenu={(event) => {
                if (!activeTab) return;
                event.preventDefault();
                setTabMenu({
                  key: activeTab.key,
                  left: Math.max(8, Math.min(event.clientX, window.innerWidth - 208)),
                  top: Math.max(8, Math.min(event.clientY, window.innerHeight - 264)),
                });
              }}>
              {working
                ? <ProgressSpinner size={14} className="workspace-tab-status" role="status"
                  aria-label={t("{{name}} is working", { name: activeTab?.title ?? "" })} />
                : activeTab ? tabGlyph(activeTab) : null}
              <span>{activeTab?.title ?? ""}</span>
            </button>
            <button type="button" ref={switcherTrigger}
              className="workspace-tab-count"
              aria-label={t("Open tabs")} aria-haspopup="dialog"
              aria-expanded={mobileOverviewOpen}
              data-tooltip={t("Open tabs")}
              onClick={() => setMobileOverviewOpen(true)}>
              {tabs.length}
            </button>
            {/* User: ⋮ 말고 — the trailing cluster stays [N][하단][우측],
                three controls at ONE size (equal 40dp boxes, 24dp glyphs). */}
            <button type="button" className="workspace-tab-mobile-panel"
              aria-label={t("Open panel")}
              onClick={() => window.dispatchEvent(new Event("mixdog:mobile-panel"))}>
              <span className="codicon codicon-layout-panel" aria-hidden="true" />
            </button>
            <button type="button" className="workspace-tab-mobile-dock"
              aria-label={t("Open utility panel")}
              onClick={() => window.dispatchEvent(new Event("mixdog:mobile-dock"))}>
              <span className="codicon codicon-layout-sidebar-right" aria-hidden="true" />
            </button>
          </>;
        })() : <>
        {/* Drop-border feedback: the pending insertion index paints
            a 2px line between its two neighboring tabs. */}
        <nav ref={tabStrip}
          className={`workspace-tabs${dragScroll ? " drag-scroll" : ""}`}
          data-slot="workspace-tabs-scroll"
          data-group-dragging={draggingGroup ? "true" : undefined}
          draggable
          aria-label={t("Open tabs")} onKeyDown={onTabKeyDown}
          onWheel={(event) => {
            // Scroll mapping: the vertical wheel drives the
            // horizontal tab run.
            const strip = tabStrip.current;
            const delta = Math.abs(event.deltaX) > Math.abs(event.deltaY)
              ? event.deltaX
              : event.deltaY;
            if (strip && delta) strip.scrollBy?.({ left: delta, behavior: "auto" });
          }}
          onDragStart={(event) => {
            if (event.target !== event.currentTarget) return;
            startNativeDrag(
              event,
              "group",
              tabs.find((tab) => tab.key === activeKey) ?? tabs[0],
            );
          }}
          onDragEnter={() => setDragScroll(true)}
          onDragOver={handleNativeDragOver}
          onDragLeave={(event) => {
            if (event.currentTarget.contains(event.relatedTarget as Node | null)) return;
            setDragScroll(false);
            setDropIndex(null);
          }}
          onDrop={handleNativeDrop}
          onDragEnd={finishNativeDrag}
          onPointerLeave={() => {
            setFixedTabWidths(new Map());
          }}>
          {tabs.map((tab, index) => {
            const active = tab.key === activeKey;
            const dropLeft = draggingKey && dropIndex !== null
              && tabs[dropIndex - 1]?.key === tab.key;
            const dropRight = draggingKey && dropIndex !== null
              && tabs[dropIndex]?.key === tab.key;
            const working = tabIsWorking(tab, active, activeBusy, workingSessionIds);
            const unread = tab.selection.kind === "session" &&
              unreadSessionIds?.has(tab.selection.id) === true;
            const fixedTabWidth = fixedTabWidths.get(tab.key);
            const pinnedTabWidth = fixedTabWidth ?? chromeWidths?.[index];
            return (
                <div key={tab.key}
                  ref={(node) => setTabNode(tab.key, node)}
                  className={`workspace-tab ${active ? "active" : ""} ${tab.preview ? "preview" : ""} ${tab.dirty ? "dirty" : ""} ${draggingKey === tab.key ? "dragging" : ""} ${dropLeft ? "drop-target-left" : ""} ${dropRight ? "drop-target-right" : ""}`}
                  data-tab-key={tab.key}
                  data-active={active}
                  data-working={working || undefined}
                  aria-grabbed={draggingKey === tab.key}
                  draggable
                  style={pinnedTabWidth ? ({
                    "--workspace-tab-current-width": `${pinnedTabWidth}px`,
                  } as React.CSSProperties) : undefined}
                  onPointerEnter={() => prefetchTabSurface(tab)}
                  onFocusCapture={() => prefetchTabSurface(tab)}
                  onDragStart={(event) => {
                    if ((event.target as Element | null)?.closest?.(".workspace-tab-close")) {
                      event.preventDefault();
                      return;
                    }
                    prefetchTabSurface(tab);
                    event.stopPropagation();
                    startNativeDrag(event, "tab", tab);
                  }}
                  onMouseDown={(event) => {
                    if (event.button !== 1) return;
                    event.preventDefault();
                    closeTab(tab, true);
                  }}
                  onDoubleClick={() => onPinTab?.(tab)}
                  onContextMenu={(event) => {
                    event.preventDefault();
                    // Clamp inside the window so bottom/right-edge tabs keep
                    // the whole menu visible.
                    setTabMenu({
                      key: tab.key,
                      left: Math.max(8, Math.min(event.clientX, window.innerWidth - 208)),
                      top: Math.max(8, Math.min(event.clientY, window.innerHeight - 264)),
                    });
                  }}
                >
                  <button
                    type="button"
                    className="workspace-tab-main"
                    onClick={() => {
                      if (suppressTabClick.current === tab.key) {
                        suppressTabClick.current = "";
                        return;
                      }
                      selectTab(tab);
                    }}
                    aria-current={active ? "page" : undefined}
                    data-tooltip={tab.title}
                  >
                    {/* While the session works, the tab GLYPH becomes the
                        progress spinner (user decision) — no extra dot. */}
                    {working
                      ? <ProgressSpinner size={14} className="workspace-tab-status" role="status"
                        aria-label={t("{{name}} is working", { name: tab.title })} />
                      : tab.selection.kind === "project"
                        ? <Folder size={14} />
                        : tab.selection.kind === "file"
                          ? <FileText size={14} />
                          : tab.selection.kind === "diff"
                            ? <FileDiff size={14} />
                          : tab.selection.kind === "studio"
                            ? <Sparkles size={14} />
                            : tab.selection.kind === "terminal"
                              ? <Terminal size={14} />
                              : tab.selection.kind === "folder"
                                ? <Folder size={14} />
                              /* Chat/new-task tabs keep the bubble icon
                                 (user: 탭 앞 아이콘은 롤백). */
                                : <MessageCircle size={14} />}
                    <span>{tab.title}</span>
                    {unread && !working && <i className="workspace-tab-unread-dot" role="status"
                      aria-label={t("{{name}} has new activity", { name: tab.title })} />}
                  </button>
                  <button
                    type="button"
                    className="workspace-tab-close"
                    onClick={(event) => {
                      event.stopPropagation();
                      closeTab(tab, true);
                    }}
                    aria-label={t("Close {{title}}", { title: tab.title })}
                    data-tooltip={t("Close tab")}
                  >
                    {tab.dirty
                      ? <span className="workspace-tab-dirty-glyph" aria-hidden="true">●</span>
                      : <span className="codicon codicon-close" aria-hidden="true" />}
                  </button>
                </div>
            );
          })}
        </nav>
        </>}
        {/* The fixed add slot is OUTSIDE the horizontal viewport. At a pane's
            320px floor, tabs may scroll but can never paint beneath this
            control or make it disappear. */}
        <button type="button" className="workspace-tab-new"
          aria-label={t("New task")}
          data-tooltip={t("New task")}
          onClick={onNewTask}>
          <span className="codicon codicon-add" aria-hidden="true" />
        </button>
        {tabSwitcher ? createPortal(
          <div ref={switcherNode} className="workspace-tab-new-menu workspace-tab-switcher"
            role="menu" aria-label={t("Open tabs")}
            style={{ left: tabSwitcher.left, top: tabSwitcher.top }}>
            {tabs.map((tab) => {
              const active = tab.key === activeKey;
              return <div key={tab.key}
                className={`workspace-tab-switcher-row${active ? " active" : ""}`}>
                <button type="button" role="menuitem"
                  aria-current={active ? "page" : undefined}
                  onClick={() => {
                    setTabSwitcher(null);
                    selectTab(tab);
                  }}>
                  {tabGlyph(tab, 15)}<span>{tab.title}</span>
                </button>
                <button type="button" className="workspace-tab-switcher-close"
                  aria-label={t("Close {{title}}", { title: tab.title })}
                  data-tooltip={t("Close tab")}
                  onClick={() => closeTab(tab)}>
                  {tab.dirty
                    ? <span className="workspace-tab-dirty-glyph" aria-hidden="true">●</span>
                    : <span className="codicon codicon-close" aria-hidden="true" />}
                </button>
              </div>;
            })}
          </div>,
          document.body,
        ) : null}
        {tabMenu ? (() => {
          const menuIndex = tabs.findIndex((row) => row.key === tabMenu.key);
          const menuTab = tabs[menuIndex];
          if (!menuTab) return null;
          const others = tabs.filter((row) => row.key !== menuTab.key);
          const toRight = tabs.slice(menuIndex + 1);
          const fileTarget = menuTab.selection.kind === "file"
            ? {
                project: menuTab.selection.project,
                rel: menuTab.selection.rel,
                accessToken: menuTab.selection.accessToken,
              }
            : menuTab.selection.kind === "diff"
              ? {
                  project: menuTab.selection.project,
                  rel: menuTab.selection.rel,
                  accessToken: undefined,
                }
              : null;
          const items: Array<{ label: string; disabled?: boolean; run: () => void }> = [
            { label: "Close", run: () => closeTab(menuTab) },
            {
              label: "Close Others",
              disabled: !others.length,
              run: () => { for (const row of others) onCloseTab(row); },
            },
            {
              label: "Close to the Right",
              disabled: !toRight.length,
              run: () => { for (const row of toRight) onCloseTab(row); },
            },
            ...(onPinTab && menuTab.preview
              ? [{ label: "Keep Open", run: () => onPinTab(menuTab) }]
              : []),
            ...(fileTarget ? [
              {
                label: "Copy Path",
                run: () => {
                  const separator = fileTarget.project.includes("\\") ? "\\" : "/";
                  const absolute = `${fileTarget.project.replace(/[\\/]+$/, "")}${separator}${
                    fileTarget.rel.replace(/[\\/]+/g, separator)}`;
                  void navigator.clipboard?.writeText(absolute)?.then(undefined, () => {});
                },
              },
              {
                label: "Copy Relative Path",
                run: () => {
                  void navigator.clipboard?.writeText(fileTarget.rel)?.then(undefined, () => {});
                },
              },
              {
                label: "Reveal in Explorer",
                run: () => {
                  void window.mixdogDesktop?.revealFile?.(
                    fileTarget.project,
                    fileTarget.rel,
                    fileTarget.accessToken,
                  );
                },
              },
            ] : []),
          ];
          return createPortal(
            <div ref={tabMenuNode} className="workspace-tab-new-menu workspace-tab-context-menu"
              role="menu" aria-label={t("{{title}} tab actions", { title: menuTab.title })}
              style={{ left: tabMenu.left, top: tabMenu.top }}>
              {items.map((item) => <button type="button" role="menuitem" key={item.label}
                disabled={item.disabled}
                onClick={() => {
                  setTabMenu(null);
                  item.run();
                }}>
                <span>{t(item.label)}</span>
              </button>)}
            </div>,
            document.body,
          );
        })() : null}
        {trailing
          ? <div className="workspace-tabs-trailing">{trailing}</div>
          : null}
        {mobileOverviewOpen && <MobileTabOverview
          tabs={tabs}
          activeKey={activeKey}
          sessions={sessions}
          workingSessionIds={workingSessionIds}
          unreadSessionIds={unreadSessionIds}
          onSelectTab={selectTab}
          onCloseTab={onCloseTab}
          onNewTask={onNewTask}
          onClose={() => setMobileOverviewOpen(false)} />}
      </div>
  );
}

function useWorkspaceTabCommands({
  tabs,
  activeKey,
  onSelectTab,
  onCloseTab,
}: Pick<WorkspaceTabStripProps, "tabs" | "activeKey" | "onSelectTab" | "onCloseTab">) {
  return useCallback((event: KeyboardEvent<HTMLElement>) => {
    // Strip-scoped commands only. Ctrl+←/→ is owned globally and traverses
    // tabs before crossing pane boundaries; Ctrl+T opens the terminal panel.
    if ((!event.metaKey && !event.ctrlKey) || event.shiftKey || event.altKey) return;
    const activeIndex = tabs.findIndex((tab) => tab.key === activeKey);
    const select = (index: number) => {
      const tab = tabs[index];
      if (!tab) return false;
      onSelectTab(tab);
      return true;
    };
    let handled = false;

    if (event.key.toLocaleLowerCase() === "w") {
      const tab = tabs[activeIndex];
      if (tab) {
        onCloseTab(tab);
        handled = true;
      }
    } else if (/^[1-9]$/.test(event.key)) {
      handled = select(Number(event.key) - 1);
    }

    if (handled) event.preventDefault();
  }, [activeKey, onCloseTab, onSelectTab, tabs]);
}
