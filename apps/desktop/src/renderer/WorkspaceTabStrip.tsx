// Per-pane workspace tab strip (VS Code editor-group title control). This is
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
import {
  Bot,
  FileText,
  FileDiff,
  Folder,
  MessageCircle,
  Plus,
  Sparkles,
  Terminal,
  X,
} from "lucide-react";

import type { WorkspaceTab } from "./nav-types";
import { commitImmediateOverlay, useImmediateOverlayClickGuard } from "./immediate-overlay";
import { ProgressSpinner } from "./ProgressSpinner";
import {
  cancelLayoutFrame,
  flushLayoutFrame,
  scheduleLayoutFrame,
} from "./interaction-frame-scheduler";
import { publishTabDrag, type TabDragFrame } from "./tab-drag-bus";

export interface WorkspaceTabStripProps {
  tabs: WorkspaceTab[];
  activeKey: string;
  activeBusy?: boolean;
  workingSessionIds?: ReadonlySet<string>;
  unreadSessionIds?: ReadonlySet<string>;
  /** Only the focused group's strip consumes global close events (Ctrl+W). */
  focused?: boolean;
  /** Owning pane leaf id, stamped on published drag frames. */
  paneId?: string;
  /** Right-edge controls (VS Code editor actions): status, review, panel. */
  trailing?: React.ReactNode;
  onSelectTab(tab: WorkspaceTab): void;
  onCloseTab(tab: WorkspaceTab): void;
  /** Numeric target = VS Code drop index (tab half rule, container = end). */
  onReorderTab(sourceKey: string, target: string | number): void;
  onPinTab?(tab: WorkspaceTab): void;
  onNewTask(): void;
  onNewStudio?(): void;
  onOpenFile?(): void;
  onNewTerminal?(): void;
  onOpenFolder?(): void;
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
  onNewStudio,
  onOpenFile,
  onNewTerminal,
  onOpenFolder,
}: WorkspaceTabStripProps) {
  // Drag frames carry the source pane so a drop can MOVE the tab between
  // groups instead of copying it.
  const publishFrame = useCallback((frame: Omit<TabDragFrame, "sourceLeafId">) => {
    publishTabDrag({ ...frame, sourceLeafId: paneId });
  }, [paneId]);
  const tabNodes = useRef(new Map<string, HTMLDivElement>());
  const tabStrip = useRef<HTMLElement>(null);
  const ghostNode = useRef<HTMLDivElement | null>(null);
  const pointerDrag = useRef<{
    kind: "tab" | "group";
    pointerId: number;
    sourceKey: string;
    startX: number;
    startY: number;
    started: boolean;
    lastTargetKey: string;
    outside: boolean;
    lastX: number;
    lastY: number;
    /** Pending VS Code drop index while the pointer stays in the strip. */
    dropIndex: number | null;
  } | null>(null);
  const pointerMoveFrameKey = useRef({});
  const latestPointerMove = useRef<React.PointerEvent<HTMLElement> | PointerEvent | null>(null);
  const suppressTabClick = useRef("");
  const [draggingKey, setDraggingKey] = useState("");
  const [dropIndex, setDropIndex] = useState<number | null>(null);
  const [draggingGroup, setDraggingGroup] = useState(false);
  const [newMenu, setNewMenu] = useState<{ left: number; top: number } | null>(null);
  const [tabMenu, setTabMenu] = useState<{ key: string; left: number; top: number } | null>(null);
  const tabMenuNode = useRef<HTMLDivElement>(null);
  const newButton = useRef<HTMLButtonElement>(null);
  const newMenuNode = useRef<HTMLDivElement>(null);
  const newMenuAnchor = useRef<{ left: number; top: number } | null>(null);
  const newMenuClickGuard = useImmediateOverlayClickGuard();
  const rememberNewMenuAnchor = (element: HTMLButtonElement) => {
    const rect = element.getBoundingClientRect();
    newMenuAnchor.current = { left: rect.left, top: rect.bottom + 4 };
  };
  const toggleNewMenu = (element: HTMLButtonElement) => {
    const next = newMenu ? null : (newMenuAnchor.current
      ?? (rememberNewMenuAnchor(element), newMenuAnchor.current));
    commitImmediateOverlay(() => setNewMenu(next));
  };
  useEffect(() => {
    if (!newMenu) {
      newMenuAnchor.current = null;
      return undefined;
    }
    const closeOutside = (event: PointerEvent) => {
      const target = event.target as Node | null;
      if (target && (newButton.current?.contains(target)
        || newMenuNode.current?.contains(target))) return;
      setNewMenu(null);
    };
    const closeMenu = () => setNewMenu(null);
    document.addEventListener("pointerdown", closeOutside);
    window.addEventListener("resize", closeMenu);
    window.addEventListener("scroll", closeMenu, true);
    return () => {
      document.removeEventListener("pointerdown", closeOutside);
      window.removeEventListener("resize", closeMenu);
      window.removeEventListener("scroll", closeMenu, true);
    };
  }, [newMenu]);
  // VS Code-parity tab context menu (Close / Close Others / Close to the
  // Right / Keep Open) with the same dismissal rules as the new-tab menu.
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
  // VS Code fixed sizing mode freezes each tab's current width while the
  // pointer remains over the strip, allowing rapid repeated closes without
  // any width animation or timer.
  const [fixedTabWidths, setFixedTabWidths] =
    useState<ReadonlyMap<string, number>>(() => new Map());
  const previousTabKeys = useRef(tabs.map((tab) => tab.key));
  useLayoutEffect(() => {
    const previousKeys = previousTabKeys.current;
    const appended = tabs.length > previousKeys.length
      && previousKeys.every((key, index) => tabs[index]?.key === key);
    previousTabKeys.current = tabs.map((tab) => tab.key);
    if (!appended) return;

    setFixedTabWidths(new Map());
    // VS Code redraw({ forceRevealActiveTab: true }): a newly appended active
    // tab and the attached add-tab control are revealed before paint.
    if (tabStrip.current) tabStrip.current.scrollLeft = tabStrip.current.scrollWidth;
  }, [tabs]);
  // VS Code revealActiveTab: switching tabs scrolls the strip MINIMALLY so
  // the active tab is always fully visible — overflow scrolls, it never
  // hides tabs. Right overflow aligns the tab's right edge; left overflow
  // aligns its left edge (multiEditorTabsControl reveal synopsis).
  useLayoutEffect(() => {
    const strip = tabStrip.current;
    const node = tabNodes.current.get(activeKey);
    if (!strip || !node) return;
    const width = strip.clientWidth;
    if (width <= 0) return;
    const left = node.offsetLeft;
    const right = left + node.offsetWidth;
    if (right > strip.scrollLeft + width) strip.scrollLeft = right - width;
    else if (left < strip.scrollLeft) strip.scrollLeft = left;
  }, [activeKey, tabs]);
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
    onSelectTab,
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

  const finishPointerDrag = useCallback((pointerId: number, cancelled = false) => {
    flushLayoutFrame(pointerMoveFrameKey.current);
    latestPointerMove.current = null;
    const drag = pointerDrag.current;
    if (!drag || drag.pointerId !== pointerId) return;
    if (drag.started && drag.kind === "tab") suppressTabClick.current = drag.sourceKey;
    const source = drag.kind === "group"
      ? tabStrip.current
      : tabNodes.current.get(drag.sourceKey);
    // Clear ownership before releasing capture: browsers may synchronously
    // deliver lostpointercapture from releasePointerCapture().
    pointerDrag.current = null;
    try {
      if (source?.hasPointerCapture?.(pointerId)) source.releasePointerCapture(pointerId);
    } catch {
      // The browser can release capture before React delivers pointercancel.
    }
    setDraggingKey("");
    setDraggingGroup(false);
    setDropIndex(null);
    delete document.body.dataset.tabDragging;
    // Drag-to-split handoff: a gesture that ends below the strip belongs to
    // the pane workspace (tab-drag-bus). The strip must neither reorder nor
    // re-select for it — the workspace navigates once the split lands.
    if (drag.started && drag.outside) {
      const sourceTab = tabs.find((tab) =>
        tab.key === (drag.kind === "group" ? activeKey : drag.sourceKey)) ?? tabs[0];
      if (sourceTab) {
        publishFrame({
          kind: drag.kind,
          phase: cancelled ? "cancel" : "drop",
          key: sourceTab.key,
          title: sourceTab.title,
          selection: sourceTab.selection,
          x: drag.lastX,
          y: drag.lastY,
        });
      }
      return;
    }
    // VS Code commits the reorder ON DROP (multiEditorTabsControl.onDrop →
    // openEditor with the half-rule index); nothing moved during hover, and
    // a cancelled drag moves nothing at all.
    if (drag.kind === "tab" && drag.started && !cancelled && drag.dropIndex !== null) {
      onReorderTab(drag.sourceKey, drag.dropIndex);
    }
    // Chrome parity, moved OFF drag-start: selecting mid-gesture kicked the
    // heavy session/file-tab switch machinery while the pointer was captured
    // (file tabs with busy log reloads intermittently killed the drag). The
    // dragged tab activates once, on drop.
    if (drag.kind === "tab" && drag.started && drag.sourceKey !== activeKey) {
      const sourceTab = tabs.find((tab) => tab.key === drag.sourceKey);
      if (sourceTab) onSelectTab(sourceTab);
    }
  }, [activeKey, onReorderTab, onSelectTab, tabs]);

  const processPointerDrag = useCallback((event: React.PointerEvent<HTMLElement> | PointerEvent) => {
    const drag = pointerDrag.current;
    const pointerId = event.pointerId || 1;
    if (!drag || drag.pointerId !== pointerId) return;
    if (!drag.started) {
      // Split drags naturally leave the horizontal strip vertically. Measuring
      // only X treated a straight-down gesture as a click and selected the
      // background tab instead of handing it to the workspace.
      if (Math.hypot(event.clientX - drag.startX, event.clientY - drag.startY) < 4) return;
      drag.started = true;
      const source = drag.kind === "group"
        ? tabStrip.current
        : tabNodes.current.get(drag.sourceKey);
      try { source?.setPointerCapture?.(pointerId); } catch {}
      if (drag.kind === "group") setDraggingGroup(true);
      else setDraggingKey(drag.sourceKey);
      // Editors pause their disk polling while a tab drag is live.
      document.body.dataset.tabDragging = "1";
    }
    event.preventDefault();

    const strip = tabStrip.current;
    if (!strip) return;
    const stripRect = strip.getBoundingClientRect();
    drag.lastX = event.clientX;
    drag.lastY = event.clientY;
    // VS Code drag image: the ghost label's top-left corner rides at the
    // cursor (setDragImage(tab, 0, 0); text-only label as in shrink sizing).
    if (drag.kind === "tab" && ghostNode.current) {
      ghostNode.current.style.transform =
        `translate(${event.clientX}px, ${event.clientY}px)`;
    }
    // VS Code/orca drag-to-split: once the pointer leaves this strip's band
    // the gesture stops reordering and becomes a workspace drop preview.
    // With per-pane strips the band is the OWN shell box (side-by-side
    // groups sit at the same height), and hovering a foreign strip is
    // always outside. Zero-size rects (headless DOM) keep the legacy
    // bottom-only rule so pointer tests stay meaningful.
    const shell = strip.parentElement;
    const shellRect = (shell ?? strip).getBoundingClientRect();
    const pointedShell = document.elementFromPoint?.(event.clientX, event.clientY)
      ?.closest?.(".workspace-tabs-shell") ?? null;
    // A blank-strip drag owns the whole editor GROUP, so route every frame to
    // PaneWorkspace once the gesture starts. TAB drags stay in REORDER mode
    // while inside their own strip band: the root's top drop rail overlaps
    // the strip (both live on the panel's top edge), and letting it win there
    // made every in-strip drag jump straight to the split preview (user:
    // 라벨 순서 바꾸기가 안 되고 분할이 바로 나온다).
    // The band is the EXACT shell rect — VS Code has no slack: the moment
    // the pointer leaves the tabs container the editor-area overlay owns
    // the gesture (dragleave → DropOverlay).
    const outsideStrip = drag.kind === "group"
      || event.clientY > shellRect.bottom
      || (shellRect.height > 0 && event.clientY < shellRect.top)
      || (shellRect.width > 0 && (event.clientX < shellRect.left
        || event.clientX > shellRect.right))
      || (pointedShell !== null && pointedShell !== shell);
    if (outsideStrip !== drag.outside) {
      drag.outside = outsideStrip;
      // Leaving the band hands the gesture to the workspace drop preview;
      // the in-strip insertion feedback clears (VS Code onDragLeave).
      if (outsideStrip && drag.kind === "tab") {
        drag.dropIndex = null;
        setDropIndex(null);
      }
      if (!outsideStrip) {
        const sourceTab = tabs.find((tab) =>
          tab.key === (drag.kind === "group" ? activeKey : drag.sourceKey)) ?? tabs[0];
        if (sourceTab) {
          publishFrame({
            kind: drag.kind, phase: "cancel", key: sourceTab.key, title: sourceTab.title,
            selection: sourceTab.selection, x: event.clientX, y: event.clientY,
          });
        }
      }
    }
    if (drag.outside) {
      const sourceTab = tabs.find((tab) =>
        tab.key === (drag.kind === "group" ? activeKey : drag.sourceKey)) ?? tabs[0];
      if (sourceTab) {
        publishFrame({
          kind: drag.kind, phase: "move", key: sourceTab.key, title: sourceTab.title,
          selection: sourceTab.selection, x: event.clientX, y: event.clientY,
        });
      }
      return;
    }
    if (drag.kind === "group") return;
    const edge = Math.max(24, stripRect.width * 0.05);
    const scrollDistance = Math.max(8, Math.min(24, edge * 0.5));
    if (event.clientX < stripRect.left + edge) {
      strip.scrollBy?.({ left: -scrollDistance, behavior: "auto" });
    } else if (event.clientX > stripRect.right - edge) {
      strip.scrollBy?.({ left: scrollDistance, behavior: "auto" });
    }

    // VS Code drop feedback (multiEditorTabsControl computeDropTarget):
    // nothing moves during hover — the tab under the pointer resolves the
    // insertion index by its HALF (left half → before it, right half →
    // after it) and the empty container run targets the ends.
    let index = -1;
    let measured = false;
    let firstLeft = Number.POSITIVE_INFINITY;
    for (let at = 0; at < tabs.length; at += 1) {
      const rect = tabNodes.current.get(tabs[at].key)?.getBoundingClientRect();
      if (!rect || rect.width <= 0) continue;
      measured = true;
      firstLeft = Math.min(firstLeft, rect.left);
      if (index >= 0 || event.clientX < rect.left || event.clientX > rect.right) continue;
      index = at + (event.clientX - rect.left > rect.width / 2 ? 1 : 0);
    }
    if (!measured) {
      // Zero-size rects (headless DOM) keep the event-target tab rule.
      const pointedTab = (event.target as Element | null)
        ?.closest?.<HTMLElement>(".workspace-tab") || null;
      const key = pointedTab && strip.contains(pointedTab)
        ? pointedTab.dataset.tabKey || ""
        : "";
      const at = tabs.findIndex((tab) => tab.key === key);
      if (at >= 0 && pointedTab) {
        const rect = pointedTab.getBoundingClientRect();
        index = at + (event.clientX - rect.left > rect.width / 2 ? 1 : 0);
      }
    } else if (index < 0) {
      // Container run (VS Code tabsContainer drop): the left gutter aims
      // before the first tab, everywhere else after the last.
      index = event.clientX < firstLeft ? 0 : tabs.length;
    }
    const nextDropIndex = index < 0 ? null : index;
    if (drag.dropIndex !== nextDropIndex) {
      drag.dropIndex = nextDropIndex;
      setDropIndex(nextDropIndex);
    }
  }, [activeKey, tabs]);
  const movePointerDrag = useCallback((
    event: React.PointerEvent<HTMLElement> | PointerEvent,
  ) => {
    const drag = pointerDrag.current;
    if (!drag || drag.pointerId !== (event.pointerId || 1)) return;
    event.preventDefault();
    latestPointerMove.current = event;
    scheduleLayoutFrame(pointerMoveFrameKey.current, () => {
      const latest = latestPointerMove.current;
      latestPointerMove.current = null;
      if (latest) processPointerDrag(latest);
    });
  }, [processPointerDrag]);

  // Pending drags are not captured until they cross the movement threshold,
  // so tracking only on the strip loses a fast vertical gesture as soon as
  // the pointer leaves its 35px band. Window tracking bridges that gap; once
  // capture starts it also gives move/up one canonical handler.
  useEffect(() => {
    const onPointerMove = (event: PointerEvent) => movePointerDrag(event);
    const onPointerUp = (event: PointerEvent) => finishPointerDrag(event.pointerId || 1);
    const onPointerCancel = (event: PointerEvent) =>
      finishPointerDrag(event.pointerId || 1, true);
    window.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerup", onPointerUp);
    window.addEventListener("pointercancel", onPointerCancel);
    return () => {
      cancelLayoutFrame(pointerMoveFrameKey.current);
      latestPointerMove.current = null;
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerup", onPointerUp);
      window.removeEventListener("pointercancel", onPointerCancel);
    };
  }, [finishPointerDrag, movePointerDrag]);

  return (
      <div className="workspace-tabs-shell" data-slot="workspace-tabs" data-count={tabs.length}
        data-focused={focused ? "true" : "false"}>
        {/* VS Code drop-border feedback: the pending insertion index paints
            a 2px line between its two neighboring tabs. */}
        <nav ref={tabStrip} className="workspace-tabs"
          data-slot="workspace-tabs-scroll"
          data-group-dragging={draggingGroup ? "true" : undefined}
          aria-label="Open tabs" onKeyDown={onTabKeyDown}
          onWheel={(event) => {
            // VS Code tabsScrollbar scrollYToX: the vertical wheel drives the
            // horizontal tab run.
            const strip = tabStrip.current;
            const delta = Math.abs(event.deltaX) > Math.abs(event.deltaY)
              ? event.deltaX
              : event.deltaY;
            if (strip && delta) strip.scrollBy?.({ left: delta, behavior: "auto" });
          }}
          onPointerDown={(event) => {
            if (event.button !== 0 || event.pointerType === "touch"
              || event.target !== event.currentTarget) return;
            const pointerId = event.pointerId || 1;
            pointerDrag.current = {
              kind: "group",
              pointerId,
              sourceKey: activeKey,
              startX: event.clientX,
              startY: event.clientY,
              started: false,
              lastTargetKey: "",
              outside: false,
              lastX: event.clientX,
              lastY: event.clientY,
              dropIndex: null,
            };
          }}
          onPointerLeave={() => {
            setFixedTabWidths(new Map());
          }}>
          {tabs.map((tab) => {
            const active = tab.key === activeKey;
            const dropLeft = draggingKey && dropIndex !== null
              && tabs[dropIndex - 1]?.key === tab.key;
            const dropRight = draggingKey && dropIndex !== null
              && tabs[dropIndex]?.key === tab.key;
            const interactiveChat = tab.selection.kind === "session"
              || tab.selection.kind === "new";
            const working = (tab.selection.kind === "session" &&
              workingSessionIds?.has(tab.selection.id) === true)
              || (interactiveChat && active && activeBusy);
            const unread = tab.selection.kind === "session" &&
              unreadSessionIds?.has(tab.selection.id) === true;
            const fixedTabWidth = fixedTabWidths.get(tab.key);
            return (
                <div key={tab.key}
                  ref={(node) => setTabNode(tab.key, node)}
                  className={`workspace-tab ${active ? "active" : ""} ${tab.preview ? "preview" : ""} ${tab.dirty ? "dirty" : ""} ${draggingKey === tab.key ? "dragging" : ""} ${dropLeft ? "drop-target-left" : ""} ${dropRight ? "drop-target-right" : ""}`}
                  data-tab-key={tab.key}
                  data-active={active}
                  data-working={working || undefined}
                  aria-grabbed={draggingKey === tab.key}
                  style={fixedTabWidth ? ({
                    "--workspace-tab-current-width": `${fixedTabWidth}px`,
                  } as React.CSSProperties) : undefined}
                  onPointerDown={(event) => {
                    if (event.button !== 0 || event.pointerType === "touch" ||
                      (event.target as Element | null)?.closest?.(".workspace-tab-close")) return;
                    const pointerId = event.pointerId || 1;
                    pointerDrag.current = {
                      kind: "tab",
                      pointerId,
                      sourceKey: tab.key,
                      startX: event.clientX,
                      startY: event.clientY,
                      started: false,
                      lastTargetKey: "",
                      outside: false,
                      lastX: event.clientX,
                      lastY: event.clientY,
                      dropIndex: null,
                    };
                  }}
                  onLostPointerCapture={(event) => {
                    if (pointerDrag.current?.started) finishPointerDrag(event.pointerId || 1);
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
                    // the whole menu visible (VS Code behavior).
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
                      onSelectTab(tab);
                    }}
                    aria-current={active ? "page" : undefined}
                    data-tooltip={tab.title}
                  >
                    {/* While the session works, the tab GLYPH becomes the
                        progress spinner (user decision) — no extra dot. */}
                    {working
                      ? <ProgressSpinner size={14} className="workspace-tab-status" role="status"
                        aria-label={`${tab.title} is working`} />
                      : tab.selection.kind === "agent-session"
                        ? <Bot size={14} />
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
                      aria-label={`${tab.title} has new activity`} />}
                  </button>
                  <button
                    type="button"
                    className="workspace-tab-close"
                    onClick={(event) => {
                      event.stopPropagation();
                      closeTab(tab, true);
                    }}
                    aria-label={`Close ${tab.title}`}
                    data-tooltip="Close tab"
                  >
                    {tab.dirty
                      ? <span className="workspace-tab-dirty-glyph" aria-hidden="true">●</span>
                      : <X size={14} aria-hidden="true" />}
                  </button>
                </div>
            );
          })}
          <button ref={newButton} type="button" className="workspace-tab-new"
            aria-label="New tab" aria-haspopup="menu" aria-expanded={Boolean(newMenu)}
            data-tooltip="New tab"
            onPointerEnter={(event) => rememberNewMenuAnchor(event.currentTarget)}
            onFocus={(event) => rememberNewMenuAnchor(event.currentTarget)}
            onPointerDown={(event) => {
              if (event.button !== 0) return;
              newMenuClickGuard.markPointerActivation();
              toggleNewMenu(event.currentTarget);
            }}
            onClick={(event) => {
              if (newMenuClickGuard.consumePointerClick()) return;
              if (event.detail !== 0) return;
              toggleNewMenu(event.currentTarget);
            }}
            onPointerCancel={newMenuClickGuard.clearPointerActivation}>
            <Plus size={16} aria-hidden="true" />
          </button>
        </nav>
        {/* VS Code drag image: a text-only ghost label whose top-left corner
            rides at the cursor (setDragImage(tab, 0, 0) / applyDragImage). */}
        {draggingKey ? createPortal(
          <div className="workspace-tab-ghost" aria-hidden="true"
            ref={(node) => {
              ghostNode.current = node;
              const drag = pointerDrag.current;
              if (node && drag) {
                node.style.transform = `translate(${drag.lastX}px, ${drag.lastY}px)`;
              }
            }}>
            <span>{tabs.find((tab) => tab.key === draggingKey)?.title ?? ""}</span>
          </div>,
          document.body,
        ) : null}
        {newMenu ? createPortal(
          <div ref={newMenuNode} className="workspace-tab-new-menu" role="menu"
            aria-label="Create tab"
            style={{ left: newMenu.left, top: newMenu.top }}>
            {[
              { label: "New Task", icon: <MessageCircle size={15} />, run: onNewTask },
              { label: "New Studio", icon: <Sparkles size={15} />, run: onNewStudio },
              { label: "New File", icon: <FileText size={15} />, run: onOpenFile },
              { label: "New Terminal", icon: <Terminal size={15} />, run: onNewTerminal },
              { label: "Open Folder", icon: <Folder size={15} />, run: onOpenFolder },
            ].map((item) => <button type="button" role="menuitem" key={item.label}
              disabled={!item.run}
              onClick={() => {
                setNewMenu(null);
                item.run?.();
              }}>
              {item.icon}<span>{item.label}</span>
            </button>)}
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
              role="menu" aria-label={`${menuTab.title} tab actions`}
              style={{ left: tabMenu.left, top: tabMenu.top }}>
              {items.map((item) => <button type="button" role="menuitem" key={item.label}
                disabled={item.disabled}
                onClick={() => {
                  setTabMenu(null);
                  item.run();
                }}>
                <span>{item.label}</span>
              </button>)}
            </div>,
            document.body,
          );
        })() : null}
        {trailing
          ? <div className="workspace-tabs-trailing">{trailing}</div>
          : null}
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
    // Strip-scoped commands only. Arrows are owned globally (Ctrl+←/→ cycles
    // tabs, Alt+←/→ moves pane focus) and Ctrl+T opens the terminal panel, so
    // no Alt-modified binding may live here.
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
