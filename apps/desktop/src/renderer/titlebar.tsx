import React, {
  type KeyboardEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import {
  Archive,
  ArrowDown,
  Clock,
  Folder,
  FolderPlus,
  LoaderCircle,
  MessageCircle,
  MoreHorizontal,
  ArchiveRestore,
  ChevronDown,
  ChevronRight,
  PanelLeft,
  PanelRight,
  Pencil,
  Pin,
  Plus,
  Settings,
  Trash2,
  X,
} from "lucide-react";
import { MxIcon } from "./MxIcon";
import type {
  DesktopProjectSummary,
  DesktopSessionSummary,
  DesktopUpdaterState,
} from "../shared/contract";
import { sessionSummaryTitle } from "../shared/session-title.mjs";

import type { NavigationSelection, WorkspaceTab } from "./nav-types";

interface DesktopTitlebarProps {
  sidebarOpen: boolean;
  tabs: WorkspaceTab[];
  activeKey: string;
  activeBusy?: boolean;
  workingSessionIds?: ReadonlySet<string>;
  updaterState?: DesktopUpdaterState;
  dockOpen?: boolean;
  onToggleSidebar(): void;
  onSelectTab(tab: WorkspaceTab): void;
  onCloseTab(tab: WorkspaceTab): void;
  onReorderTab(sourceKey: string, targetKey: string): void;
  onNewTask(): void;
  onOpenUpdate?(): void;
  onToggleDock?(): void;
}

function SidebarToggleIcon({ open }: { open: boolean }) {
  // Outline-only glyph (user: no filled state) from the rounded lucide set,
  // matching the New task / Project icons.
  return <PanelLeft className="sidebar-toggle-icon" size={18}
    data-state={open ? "open" : "closed"} aria-hidden="true" />;
}

export function DesktopTitlebar({
  sidebarOpen,
  tabs,
  activeKey,
  activeBusy = false,
  workingSessionIds,
  updaterState,
  dockOpen = false,
  onToggleSidebar,
  onSelectTab,
  onCloseTab,
  onReorderTab,
  onNewTask,
  onOpenUpdate,
  onToggleDock,
}: DesktopTitlebarProps) {
  const tabNodes = useRef(new Map<string, HTMLDivElement>());
  const tabStrip = useRef<HTMLElement>(null);
  const pointerDrag = useRef<{
    pointerId: number;
    sourceKey: string;
    startX: number;
    started: boolean;
    lastTargetKey: string;
  } | null>(null);
  const suppressTabClick = useRef("");
  const [draggingKey, setDraggingKey] = useState("");
  // Chrome-parity close UX: closing a tab must NOT let the survivors re-expand
  // while the pointer stays on the strip — the next close button would slide
  // out from under the cursor. Pin the current tab width on pointer-close and
  // release it (recompute + smooth transition) once the pointer leaves.
  const [pinnedTabWidth, setPinnedTabWidth] = useState(0);
  const previousTabCount = useRef(tabs.length);
  useEffect(() => {
    // Opening a tab is not a close streak: Chrome re-lays-out immediately.
    if (tabs.length > previousTabCount.current) setPinnedTabWidth(0);
    previousTabCount.current = tabs.length;
  }, [tabs.length]);
  const closeTabPinned = useCallback((tab: WorkspaceTab) => {
    const width = tabNodes.current.get(tab.key)?.getBoundingClientRect().width || 0;
    if (width > 0) setPinnedTabWidth(width);
    onCloseTab(tab);
  }, [onCloseTab]);
  const windowsCaptionControls = typeof navigator !== "undefined" &&
    /Windows/i.test(navigator.userAgent);
  const setTabNode = useCallback((key: string, node: HTMLDivElement | null) => {
    if (node) tabNodes.current.set(key, node);
    else tabNodes.current.delete(key);
  }, []);
  const onTabKeyDown = useWorkspaceTabCommands({
    tabs,
    activeKey,
    onSelectTab,
    onCloseTab,
    onNewTask,
  });

  useEffect(() => {
    tabNodes.current.get(activeKey)?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [activeKey]);

  const finishPointerDrag = useCallback((pointerId: number) => {
    const drag = pointerDrag.current;
    if (!drag || drag.pointerId !== pointerId) return;
    if (drag.started) suppressTabClick.current = drag.sourceKey;
    const source = tabNodes.current.get(drag.sourceKey);
    try {
      if (source?.hasPointerCapture?.(pointerId)) source.releasePointerCapture(pointerId);
    } catch {
      // The browser can release capture before React delivers pointercancel.
    }
    pointerDrag.current = null;
    setDraggingKey("");
  }, []);

  const movePointerDrag = useCallback((event: React.PointerEvent<HTMLElement>) => {
    const drag = pointerDrag.current;
    const pointerId = event.pointerId || 1;
    if (!drag || drag.pointerId !== pointerId) return;
    if (!drag.started) {
      if (Math.abs(event.clientX - drag.startX) < 4) return;
      drag.started = true;
      const source = tabNodes.current.get(drag.sourceKey);
      try { source?.setPointerCapture?.(pointerId); } catch {}
      setDraggingKey(drag.sourceKey);
      const sourceTab = tabs.find((tab) => tab.key === drag.sourceKey);
      if (sourceTab && sourceTab.key !== activeKey) onSelectTab(sourceTab);
    }
    event.preventDefault();

    const strip = tabStrip.current;
    if (!strip) return;
    const stripRect = strip.getBoundingClientRect();
    const edge = Math.max(24, stripRect.width * 0.05);
    const scrollDistance = Math.max(8, Math.min(24, edge * 0.5));
    if (event.clientX < stripRect.left + edge) {
      strip.scrollBy?.({ left: -scrollDistance, behavior: "auto" });
    } else if (event.clientX > stripRect.right - edge) {
      strip.scrollBy?.({ left: scrollDistance, behavior: "auto" });
    }

    const pointed = document.elementFromPoint?.(event.clientX, event.clientY);
    let targetNode = pointed?.closest<HTMLElement>(".workspace-tab") ||
      (event.target as Element | null)?.closest?.<HTMLElement>(".workspace-tab") || null;
    if (targetNode && !strip.contains(targetNode)) targetNode = null;
    if (!targetNode) {
      let closestDistance = Number.POSITIVE_INFINITY;
      for (const node of tabNodes.current.values()) {
        const rect = node.getBoundingClientRect();
        if (rect.width <= 0) continue;
        const distance = Math.abs(event.clientX - (rect.left + rect.width / 2));
        if (distance < closestDistance) {
          closestDistance = distance;
          targetNode = node;
        }
      }
    }
    const targetKey = targetNode?.dataset.tabKey || "";
    if (!targetKey || targetKey === drag.sourceKey || targetKey === drag.lastTargetKey) return;
    drag.lastTargetKey = targetKey;
    onReorderTab(drag.sourceKey, targetKey);
  }, [activeKey, onReorderTab, onSelectTab, tabs]);

  const updateVisible = updaterState?.status === "ready" || updaterState?.status === "installing";
  const updateInstalling = updaterState?.status === "installing";

  return (
    <header className="topbar" aria-label="Workspace tabs">
      <div className="titlebar-leading">
        <button
          type="button"
          className="icon-button toolbar-sidebar"
          onClick={onToggleSidebar}
          aria-label={`${sidebarOpen ? "Collapse" : "Expand"} session sidebar`}
          aria-expanded={sidebarOpen}
          aria-controls="session-sidebar"
        >
          <SidebarToggleIcon open={sidebarOpen} />
        </button>
      </div>

      <div className="workspace-tabs-shell" data-slot="workspace-tabs" data-count={tabs.length}>
        <nav ref={tabStrip} className="workspace-tabs" data-slot="workspace-tabs-scroll"
          aria-label="Open workspaces" onKeyDown={onTabKeyDown}
          onPointerMove={movePointerDrag}
          onPointerLeave={() => setPinnedTabWidth(0)}
          onPointerUp={(event) => finishPointerDrag(event.pointerId || 1)}
          onPointerCancel={(event) => finishPointerDrag(event.pointerId || 1)}>
          {tabs.map((tab) => {
            const active = tab.key === activeKey;
            const working = (tab.selection.kind === "session" &&
              workingSessionIds?.has(tab.selection.id) === true) || (active && activeBusy);
            return (
                <div key={tab.key}
                  ref={(node) => setTabNode(tab.key, node)}
                  className={`workspace-tab ${active ? "active" : ""} ${draggingKey === tab.key ? "dragging" : ""}`}
                  data-tab-key={tab.key}
                  data-active={active}
                  data-working={working || undefined}
                  aria-grabbed={draggingKey === tab.key}
                  style={pinnedTabWidth > 0
                    ? { width: pinnedTabWidth, minWidth: pinnedTabWidth, flex: "0 0 auto" }
                    : undefined}
                  onPointerDown={(event) => {
                    if (event.button !== 0 || event.pointerType === "touch" ||
                      (event.target as Element | null)?.closest?.(".workspace-tab-close")) return;
                    const pointerId = event.pointerId || 1;
                    pointerDrag.current = {
                      pointerId,
                      sourceKey: tab.key,
                      startX: event.clientX,
                      started: false,
                      lastTargetKey: "",
                    };
                  }}
                  onLostPointerCapture={(event) => {
                    if (pointerDrag.current?.started) finishPointerDrag(event.pointerId || 1);
                  }}
                  onMouseDown={(event) => {
                    if (event.button !== 1) return;
                    event.preventDefault();
                    closeTabPinned(tab);
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
                      ? <LoaderCircle size={14} className="workspace-tab-status" role="status"
                        aria-label={`${tab.title} is working`} />
                      : tab.selection.kind === "project"
                        ? <Folder size={14} />
                        : <MessageCircle size={14} />}
                    <span>{tab.title}</span>
                  </button>
                  <button
                    type="button"
                    className="workspace-tab-close"
                    onClick={(event) => {
                      event.stopPropagation();
                      closeTabPinned(tab);
                    }}
                    aria-label={`Close ${tab.title}`}
                    data-tooltip="Close tab"
                  >
                    <X size={16} />
                  </button>
                </div>
            );
          })}
        </nav>
        {/* Chrome-parity new-tab affordance: + is ALWAYS visible and every
            press opens another independent draft tab (drafts carry unique
            keys), exactly like a browser's new-tab button. */}
        <button type="button" className="icon-button titlebar-new" onClick={onNewTask}
          aria-label="New task" data-tooltip="New task">
          <MxIcon name="plus" size={16} />
        </button>
      </div>

      {updateVisible && <div className="titlebar-update-shell">
        <button type="button" className="titlebar-update" onClick={onOpenUpdate}
          disabled={updateInstalling} aria-busy={updateInstalling}
          aria-label={updateInstalling ? "Installing update" : `Install Mixdog ${updaterState.version}`}>
          <span className="titlebar-update-label">
            {updateInstalling ? "Installing" : "Update"}
          </span>
          <span className="titlebar-update-icon" aria-hidden="true">
            {updateInstalling
              ? <span className="titlebar-update-loader" />
              : <ArrowDown size={12} />}
          </span>
        </button>
      </div>}
      {windowsCaptionControls && <div className="titlebar-caption-space" aria-hidden="true" />}
    </header>
  );
}

function useWorkspaceTabCommands({
  tabs,
  activeKey,
  onSelectTab,
  onCloseTab,
  onNewTask,
}: Pick<DesktopTitlebarProps, "tabs" | "activeKey" | "onSelectTab" | "onCloseTab" | "onNewTask">) {
  return useCallback((event: KeyboardEvent<HTMLElement>) => {
    if ((!event.metaKey && !event.ctrlKey) || event.shiftKey) return;
    const activeIndex = tabs.findIndex((tab) => tab.key === activeKey);
    const select = (index: number) => {
      const tab = tabs[index];
      if (!tab) return false;
      onSelectTab(tab);
      return true;
    };
    let handled = false;

    if (!event.altKey && event.key.toLocaleLowerCase() === "t") {
      onNewTask();
      handled = true;
    } else if (!event.altKey && event.key.toLocaleLowerCase() === "w") {
      const tab = tabs[activeIndex];
      if (tab) {
        onCloseTab(tab);
        handled = true;
      }
    } else if (event.altKey && tabs.length > 0 && event.key === "ArrowLeft") {
      handled = select((activeIndex - 1 + tabs.length) % tabs.length);
    } else if (event.altKey && tabs.length > 0 && event.key === "ArrowRight") {
      handled = select((activeIndex + 1) % tabs.length);
    } else if (!event.altKey && /^[1-9]$/.test(event.key)) {
      handled = select(Number(event.key) - 1);
    }

    if (handled) event.preventDefault();
  }, [activeKey, onCloseTab, onNewTask, onSelectTab, tabs]);
}
