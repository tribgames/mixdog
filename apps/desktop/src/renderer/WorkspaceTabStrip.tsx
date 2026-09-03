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
  Plus,
  Sparkles,
  Terminal,
  X,
} from "lucide-react";

import type { DesktopSessionSummary } from "../shared/contract";
import type { WorkspaceTab } from "./nav-types";
import { t } from "./i18n";
import { prefetchSurfaceForSelection } from "./lazy-widgets";
import { isMobileRemoteSurface } from "./MobileTabOverview";
import { useMobileBack } from "./mobile-back";
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

/** Tab-kind glyph for the phone title pill (the full strip keeps its inline
 *  chain untouched for the strip contract tests). */
function tabGlyph(tab: WorkspaceTab, size = 14) {
  switch (tab.selection.kind) {
    case "project": return <Folder size={size} />;
    case "file": return <FileText size={size} />;
    case "diff": return <FileDiff size={size} />;
    case "studio": return <Sparkles size={size} />;
    case "terminal": return <Terminal size={size} />;
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
/* Glyph-only floor, matched by the tab's CSS min-width. The sliver floor
 * above is a PREFERRED cell: once the run no longer fits, inactive cells keep
 * giving width down to this floor so the strip never overflows and
 * reveal-active never has to scroll a tab half out of view. */
const TAB_HARD_MIN_WIDTH = 20;

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
  // Hard fit: past the sliver floor the run exceeded the strip, and
  // reveal-active then scrolled it right, leaving the leading tab sliced in
  // half against the rail edge (user: 창 크기를 줄이면 위쪽 라벨 왼쪽이 잘려
  // 보인다). Inactive cells surrender the surplus evenly, down to the glyph
  // floor, so the whole run stays inside the strip.
  const room = Math.floor(available);
  const inactiveCount = count - 1;
  if (widths.reduce((sum, width) => sum + width, 0) > room && inactiveCount > 0) {
    const budget = room - widths[activeIndex];
    const each = Math.max(TAB_HARD_MIN_WIDTH, Math.floor(budget / inactiveCount));
    let spare = budget - each * inactiveCount;
    for (let index = 0; index < count; index += 1) {
      if (index === activeIndex) continue;
      widths[index] = each + (spare > 0 ? 1 : 0);
      if (spare > 0) spare -= 1;
    }
    // Still past the floor, so the run genuinely has to scroll. Pad the ACTIVE
    // cell until the scrolled-out run is a whole number of sliver cells:
    // reveal-active then lands on a cell boundary instead of slicing the
    // leading tab down the middle.
    if (widths.reduce((sum, width) => sum + width, 0) > room) {
      widths[activeIndex] += ((room - widths[activeIndex]) % each + each) % each;
    }
  }
  return widths;
}

export function WorkspaceTabStrip({
  tabs,
  activeKey,
  activeBusy = false,
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
  const dragSourceMounted = useRef(true);
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
  // The phone draws the SAME strip as the desktop (user: PC에 최대한 맞춰서 —
  // 헤더가 완전 다르다): real tabs, X, + and the dock toggles. Its only
  // addition is the brand mark at the front, which opens the session drawer
  // the desktop reaches through its activity rail.
  const mobile = isMobileRemoteSurface();
  // Layout INPUT: the width the tab run may spend — the shell minus the
  // home slot, the fixed + slot and the three-control trailing safe zone.
  const measureWidths = useCallback(() => {
    const shell = shellNode.current;
    if (!shell) return;
    const width = shell.clientWidth;
    setShellWidth((previous) => previous === width ? previous : width);
    const homeButton = shell.querySelector<HTMLElement>(":scope > .workspace-tab-home");
    const newButton = shell.querySelector<HTMLElement>(":scope > .workspace-tab-new");
    const trailingBox = shell.querySelector<HTMLElement>(":scope > .workspace-tabs-trailing");
    const available = width - (homeButton?.offsetWidth ?? 0)
      - (newButton?.offsetWidth ?? 0) - (trailingBox?.offsetWidth ?? 0);
    setStripAvailable((previous) => previous === available ? previous : available);
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
  // Shell width drives the Chrome tab-width ladder.
  const hasTrailing = Boolean(trailing);
  useLayoutEffect(() => {
    const shell = shellNode.current;
    if (!shell || typeof ResizeObserver === "undefined") return undefined;
    measureWidths();
    const observer = new ResizeObserver(measureWidths);
    observer.observe(shell);
    // The trailing controls resize WITHOUT resizing the shell (a dock toggle
    // appears, a status chip grows); observing the box itself replaces the
    // old re-measure on every render that handed a fresh `trailing` node —
    // which was every App render, each a forced layout inside the commit.
    const trailingBox = shell.querySelector<HTMLElement>(":scope > .workspace-tabs-trailing");
    if (trailingBox) observer.observe(trailingBox);
    return () => observer.disconnect();
  }, [measureWidths, hasTrailing]);
  // Tab-count changes move the available width without resizing the shell —
  // re-measure on those renders too.
  useLayoutEffect(() => {
    measureWidths();
  }, [tabs.length, hasTrailing, measureWidths]);
  // Menus can anchor hard against the window's right edge; the measured box
  // is what keeps them on screen.
  useLayoutEffect(() => { clampOverlayIntoView(tabMenuNode.current); }, [tabMenu]);
  // Survivor widths follow the recalculated run immediately; the CSS width
  // transition glides them instead of holding then jumping.
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
  // aligns its left edge. The reveal reads clientWidth/scrollWidth inside
  // the commit, which forces a synchronous layout of the whole document —
  // keyed on the tab SET (keys + titles) rather than the `tabs` array, whose
  // identity changed on every App render and made each of those commits pay
  // that layout (a keystroke sharing the frame painted 80–160ms late).
  const tabSignature = tabs.map((tab) => `${tab.key}\u0000${tab.title}`).join("\u0001");
  useLayoutEffect(() => {
    revealActiveTab();
  }, [activeKey, revealActiveTab, tabSignature]);
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
  const closeTab = useCallback((tab: WorkspaceTab) => {
    setFixedTabWidths(new Map());
    onCloseTab(tab);
  }, [onCloseTab]);
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

  const clearNativeDrag = useCallback(() => {
    const drag = nativeDrag.current;
    nativeDrag.current = null;
    delete document.body.dataset.tabDragging;
    if (!dragSourceMounted.current) return;
    setDraggingKey("");
    setDraggingGroup(false);
    setDragScroll(false);
    setDropIndex(null);
    if (drag?.kind === "tab") {
      suppressTabClick.current = drag.key;
      window.setTimeout(() => {
        if (suppressTabClick.current === drag.key) suppressTabClick.current = "";
      }, 0);
    }
  }, []);
  const finishNativeDrag = useCallback(() => finishPaneDrag(), []);
  useEffect(() => {
    dragSourceMounted.current = true;
    return () => {
      dragSourceMounted.current = false;
      if (nativeDrag.current) finishPaneDrag();
      nativeDrag.current = null;
      delete document.body.dataset.tabDragging;
    };
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
    beginPaneDrag(event.nativeEvent, drag, event.currentTarget, clearNativeDrag);
    nativeDrag.current = drag;
    if (kind === "group") setDraggingGroup(true);
    else setDraggingKey(sourceTab.key);
    document.body.dataset.tabDragging = "1";
  }, [clearNativeDrag, paneId]);

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
  const chromeWidths = stripAvailable > 0
    ? calculateChromeTabWidths(
        tabs.length,
        Math.max(0, tabs.findIndex((tab) => tab.key === activeKey)),
        stripAvailable,
      )
    : null;
  return (
      <div ref={shellNode} className="workspace-tabs-shell" data-slot="workspace-tabs"
        data-count={tabs.length} data-mobile={mobile ? "true" : undefined}
        data-focused={focused ? "true" : "false"}>
        {/* Phone home slot: the brand mark opens the session drawer (user:
            로고를 구글 홈버튼 위치에, 누르면 사이드탭) — the desktop reaches
            the same drawer through its activity rail, which the phone has no
            room for. Frameless, currentColor strokes. */}
        {mobile && <button type="button" className="workspace-tab-home"
          aria-label={t("Toggle session sidebar")}
          onClick={() => window.dispatchEvent(new Event("mixdog:mobile-home"))}>
          <svg className="workspace-tab-home-mark" viewBox="44 44 168 168" aria-hidden="true">
            <g fill="none" stroke="currentColor" strokeWidth="22" strokeLinecap="round">
              <path d="M116.2 61A68 68 0 0 1 191.9 104.7" />
              <path d="M116.2 61A68 68 0 0 1 191.9 104.7" transform="rotate(120 128 128)" />
              <path d="M116.2 61A68 68 0 0 1 191.9 104.7" transform="rotate(240 128 128)" />
            </g>
            <polygon points="128,112 133,123 144,128 133,133 128,144 123,133 112,128 123,123" fill="currentColor" />
          </svg>
        </button>}
        {/* Phone title pill (user decision (a): 제목 알약은 그대로): the run
            of tabs has no room on a phone, so ONE label names the active tab —
            sessions live in the left drawer. Tapping does
            nothing; long-press keeps the tab menu for closing. The + and the
            dock toggles beside it are the desktop's. */}
        {mobile ? (() => {
          const activeTab = tabs.find((tab) => tab.key === activeKey) ?? tabs[0];
          const working = tabIsWorking(activeTab, true, activeBusy, workingSessionIds);
          return <button type="button"
            className="workspace-tab-compact-current"
            data-tooltip={activeTab?.title}
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
          </button>;
        })() : <nav ref={tabStrip}
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
                    closeTab(tab);
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
                      closeTab(tab);
                    }}
                    aria-label={t("Close {{title}}", { title: tab.title })}
                    data-tooltip={t("Close tab")}
                  >
                    {tab.dirty
                      ? <span className="workspace-tab-dirty-glyph" aria-hidden="true">●</span>
                      : <X size={18} strokeWidth={2} aria-hidden="true" />}
                  </button>
                </div>
            );
          })}
        </nav>}
        {/* The fixed add slot is OUTSIDE the horizontal viewport. At a pane's
            320px floor, tabs may scroll but can never paint beneath this
            control or make it disappear. */}
        <button type="button" className="workspace-tab-new"
          aria-label={t("New task")}
          data-tooltip={t("New task")}
          onClick={onNewTask}>
          {/* Same lucide family and weight as the tab glyphs and dock toggles
              beside it; the codicon + read as a foreign mark (user: + 버튼이
              이질감이 있네). */}
          {/* 18px @ stroke 2 → a 10.5px cross on a 1.5px line, the visible
              size of the codicon X in the tabs beside it. */}
          <Plus size={18} strokeWidth={2} aria-hidden="true" />
        </button>
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
        {/* Keep the pane's three-control corner zone even when this surface
            owns no controls (for example Studio or a file). Tabs and + must
            never grow into a region that can later gain dock toggles. */}
        <div className="workspace-tabs-trailing">{trailing}</div>
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
