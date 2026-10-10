// Per-pane workspace tab strip: every pane group mounts one, so the
// Chrome-parity layout/animation model and the drag gestures (reorder inside
// the strip, drag below it to split/move) all live here. Class names are
// contract for the strip-contract dom tests and the shared CSS.
import React, {
  type KeyboardEvent,
  useCallback,
  useEffect,
  useLayoutEffect,
  useReducer,
  useRef,
  useState,
} from 'react';
import { createPortal } from 'react-dom';
import { clampOverlayIntoView } from './anchored-panel';
import { explorerAbsolutePath } from './explorer-tree-model';
import { isRemoteHostRenderer } from './remote-ui-projection';
import { FileText, FileDiff, Folder, Globe, MessageCircle, Plus, Sparkles, Terminal, X } from 'lucide-react';

import type { DesktopSessionSummary } from '../shared/contract';
import type { WorkspaceTab } from './nav-types';
import { t } from './i18n';
import { prefetchSurfaceForSelection } from './lazy-widgets';
import { useMobileRemoteSurface } from './mobile-surface';
import { useMobileBack } from './mobile-back';
import { ProgressSpinner } from './ProgressSpinner';
import { useTabStripReveal } from './use-tab-strip-reveal';
import {
  acceptPaneDrag,
  beginPaneDrag,
  currentPaneDrag,
  finishPaneDrag,
  type PaneDragSession,
} from './pane-drag-session';
import {
  TAB_MOTION_SETTLE_MS,
  calculateChromeTabWidths,
  type TabMenuAnchor,
  type SetTabMenu,
  tabMenuAnchorAt,
  tabsWithClosingGhosts,
  tabDropIndex,
} from './workspace-tab-layout';

interface WorkspaceTabStripProps {
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
  workingSessionIds: ReadonlySet<string> | undefined
): boolean {
  if (!tab) return false;
  if (tab.selection.kind === 'session') {
    return workingSessionIds?.has(tab.selection.id) === true;
  }
  // activeBusy belongs to the pre-session task owned by this focused strip.
  // Established sessions are keyed exclusively by workingSessionIds so a
  // busy session cannot leak its spinner into the newly selected idle tab.
  return tab.selection.kind === 'new' && active && activeBusy;
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
    case 'project':
      return <Folder size={size} />;
    case 'file':
      return <FileText size={size} />;
    case 'diff':
      return <FileDiff size={size} />;
    case 'studio':
      return <Sparkles size={size} />;
    case 'terminal':
      return <Terminal size={size} />;
    case 'browser':
      return <Globe size={15} />;
    default:
      // Chat/new-task tabs keep the bubble icon (user: 탭 앞 아이콘은 롤백).
      return <MessageCircle size={size} />;
  }
}

function menuFileTarget(selection: WorkspaceTab['selection']) {
  if (selection.kind === 'file') {
    return { project: selection.project, rel: selection.rel, accessToken: selection.accessToken };
  }
  if (selection.kind === 'diff') return { project: selection.project, rel: selection.rel, accessToken: undefined };
  return null;
}

/** Phone home slot: the brand mark opens the session drawer (user: 로고를
 *  구글 홈버튼 위치에, 누르면 사이드탭) — the desktop reaches the same drawer
 *  through its activity rail, which the phone has no room for. Frameless,
 *  currentColor strokes. */
function workspaceTabHomeButton() {
  return (
    <button
      type="button"
      className="workspace-tab-home"
      aria-label={t('Toggle session sidebar')}
      onClick={() => window.dispatchEvent(new Event('mixdog:mobile-home'))}
    >
      <svg className="workspace-tab-home-mark" viewBox="44 44 168 168" aria-hidden="true">
        <g fill="none" stroke="currentColor" strokeWidth="22" strokeLinecap="round">
          <path d="M116.2 61A68 68 0 0 1 191.9 104.7" />
          <path d="M116.2 61A68 68 0 0 1 191.9 104.7" transform="rotate(120 128 128)" />
          <path d="M116.2 61A68 68 0 0 1 191.9 104.7" transform="rotate(240 128 128)" />
        </g>
        <polygon points="128,112 133,123 144,128 133,133 128,144 123,133 112,128 123,123" fill="currentColor" />
      </svg>
    </button>
  );
}

/** Phone title pill (user decision (a): 제목 알약은 그대로): the run of tabs
 *  has no room on a phone, so ONE label names the active tab — sessions live
 *  in the left drawer. Tapping does nothing; long-press keeps the tab menu
 *  for closing. The + and the dock toggles beside it are the desktop's. */
function workspaceMobileTabPill({
  tabs,
  activeKey,
  activeBusy,
  workingSessionIds,
  setTabMenu,
}: {
  tabs: WorkspaceTab[];
  activeKey: string;
  activeBusy: boolean;
  workingSessionIds: ReadonlySet<string> | undefined;
  setTabMenu: SetTabMenu;
}) {
  const activeTab = tabs.find((tab) => tab.key === activeKey) ?? tabs[0];
  const working = tabIsWorking(activeTab, true, activeBusy, workingSessionIds);
  return (
    <button
      type="button"
      className="workspace-tab-compact-current"
      data-tooltip={activeTab?.title}
      onContextMenu={(event) => {
        if (!activeTab) return;
        event.preventDefault();
        setTabMenu(tabMenuAnchorAt(activeTab.key, event));
      }}
    >
      {working ? (
        <ProgressSpinner
          size={14}
          className="workspace-tab-status"
          role="status"
          aria-label={t('{{name}} is working', { name: activeTab?.title ?? '' })}
        />
      ) : (
        activeTab && tabGlyph(activeTab)
      )}
      <span>{activeTab?.title ?? ''}</span>
    </button>
  );
}

/** The same node the open tab had, stripped of its handlers and its width: it
 *  collapses and fades while the neighbours glide. */
function closingTabGhost(tab: WorkspaceTab, active: boolean) {
  return (
    <div
      key={tab.key}
      className={`workspace-tab closing ${active ? 'active' : ''}`}
      aria-hidden="true"
      data-tab-key={tab.key}
      data-closing="true"
    >
      <button type="button" className="workspace-tab-main" tabIndex={-1}>
        {tabGlyph(tab)}
        <span>{tab.title}</span>
      </button>
      <button type="button" className="workspace-tab-close" tabIndex={-1}>
        <X size={18} aria-hidden="true" />
      </button>
    </div>
  );
}

/** One live tab cell: selection, its working/unread readout, the drag source,
 *  the middle-click and context gestures, and the close control. */
function workspaceTabNode({
  tab,
  active,
  working,
  unread,
  dragging,
  entering,
  dropLeft,
  dropRight,
  pinnedTabWidth,
  suppressTabClick,
  setTabNode,
  selectTab,
  startNativeDrag,
  setTabMenu,
  onCloseTab,
  onPinTab,
}: {
  tab: WorkspaceTab;
  active: boolean;
  working: boolean;
  unread: boolean;
  dragging: boolean;
  entering: boolean;
  dropLeft: boolean;
  dropRight: boolean;
  pinnedTabWidth: number | undefined;
  suppressTabClick: { current: string };
  setTabNode(key: string, node: HTMLDivElement | null): void;
  selectTab(tab: WorkspaceTab): void;
  startNativeDrag(
    event: React.DragEvent<HTMLElement>,
    kind: 'tab' | 'group',
    sourceTab: WorkspaceTab | undefined
  ): void;
  setTabMenu: SetTabMenu;
  onCloseTab(tab: WorkspaceTab): void;
  onPinTab?(tab: WorkspaceTab): void;
}) {
  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: the tab wrapper only carries drag, middle-click and context menu; its inner button is the control.
    <div
      key={tab.key}
      ref={(node) => setTabNode(tab.key, node)}
      className={`workspace-tab ${active ? 'active' : ''} ${tab.preview ? 'preview' : ''} ${tab.dirty ? 'dirty' : ''} ${dragging ? 'dragging' : ''} ${dropLeft ? 'drop-target-left' : ''} ${dropRight ? 'drop-target-right' : ''} ${entering ? 'entering' : ''}`}
      data-tab-key={tab.key}
      data-active={active}
      data-working={working || undefined}
      aria-grabbed={dragging}
      draggable
      style={
        pinnedTabWidth
          ? ({
              '--workspace-tab-current-width': `${pinnedTabWidth}px`,
            } as React.CSSProperties)
          : undefined
      }
      onPointerEnter={() => prefetchTabSurface(tab)}
      onFocusCapture={() => prefetchTabSurface(tab)}
      onDragStart={(event) => {
        if ((event.target as Element | null)?.closest?.('.workspace-tab-close')) {
          event.preventDefault();
          return;
        }
        prefetchTabSurface(tab);
        event.stopPropagation();
        startNativeDrag(event, 'tab', tab);
      }}
      onMouseDown={(event) => {
        if (event.button !== 1) return;
        event.preventDefault();
        onCloseTab(tab);
      }}
      onDoubleClick={() => onPinTab?.(tab)}
      onContextMenu={(event) => {
        event.preventDefault();
        setTabMenu(tabMenuAnchorAt(tab.key, event));
      }}
    >
      <button
        type="button"
        className="workspace-tab-main"
        onClick={() => {
          if (suppressTabClick.current === tab.key) {
            suppressTabClick.current = '';
            return;
          }
          selectTab(tab);
        }}
        aria-current={active ? 'page' : undefined}
        // Compact tabs hide the title text; the name must not depend on it.
        aria-label={tab.title}
        data-tooltip={tab.title}
      >
        {/* While the session works, the tab GLYPH becomes the
              progress spinner (user decision) — no extra dot. */}
        {working ? (
          <ProgressSpinner
            size={14}
            className="workspace-tab-status"
            role="status"
            aria-label={t('{{name}} is working', { name: tab.title })}
          />
        ) : (
          tabGlyph(tab)
        )}
        <span>{tab.title}</span>
        {unread && !working && (
          <i
            className="workspace-tab-unread-dot"
            role="status"
            aria-label={t('{{name}} has new activity', { name: tab.title })}
          />
        )}
      </button>
      <button
        type="button"
        className="workspace-tab-close"
        onClick={(event) => {
          event.stopPropagation();
          onCloseTab(tab);
        }}
        aria-label={t('Close {{title}}', { title: tab.title })}
        data-tooltip={t('Close tab')}
      >
        {tab.dirty ? (
          <span className="workspace-tab-dirty-glyph" aria-hidden="true">
            ●
          </span>
        ) : (
          <X size={18} aria-hidden="true" />
        )}
      </button>
    </div>
  );
}

/** Tab context menu (Close / Close Others / Close to the Right / Keep Open /
 *  the file-target paths), portaled to the body at the clamped anchor. */
function workspaceTabContextMenu({
  tabMenu,
  tabs,
  tabMenuNode,
  setTabMenu,
  onCloseTab,
  onPinTab,
}: {
  tabMenu: TabMenuAnchor;
  tabs: WorkspaceTab[];
  tabMenuNode: React.RefObject<HTMLDivElement | null>;
  setTabMenu: SetTabMenu;
  onCloseTab(tab: WorkspaceTab): void;
  onPinTab?(tab: WorkspaceTab): void;
}) {
  const menuIndex = tabs.findIndex((row) => row.key === tabMenu.key);
  const menuTab = tabs[menuIndex];
  if (!menuTab) return null;
  const others = tabs.filter((row) => row.key !== menuTab.key);
  const toRight = tabs.slice(menuIndex + 1);
  const fileTarget = menuFileTarget(menuTab.selection);
  const items: Array<{ label: string; disabled?: boolean; run: () => void }> = [
    { label: t('Close'), run: () => onCloseTab(menuTab) },
    {
      label: t('Close Others'),
      disabled: !others.length,
      run: () => {
        for (const row of others) onCloseTab(row);
      },
    },
    {
      label: t('Close to the Right'),
      disabled: !toRight.length,
      run: () => {
        for (const row of toRight) onCloseTab(row);
      },
    },
    ...(onPinTab && menuTab.preview ? [{ label: t('Keep Open'), run: () => onPinTab(menuTab) }] : []),
    ...(fileTarget
      ? [
          {
            label: t('Copy Path'),
            run: () => {
              const absolute = explorerAbsolutePath(fileTarget.project, fileTarget.rel);
              void navigator.clipboard?.writeText(absolute)?.then(undefined, () => {});
            },
          },
          {
            label: t('Copy Relative Path'),
            run: () => {
              void navigator.clipboard?.writeText(fileTarget.rel)?.then(undefined, () => {});
            },
          },
          ...(isRemoteHostRenderer()
            ? []
            : [
                {
                  label: t('Reveal in Explorer'),
                  run: () => {
                    void window.mixdogDesktop?.revealFile?.(
                      fileTarget.project,
                      fileTarget.rel,
                      fileTarget.accessToken
                    );
                  },
                },
              ]),
        ]
      : []),
  ];
  return createPortal(
    <div
      ref={tabMenuNode}
      className="workspace-tab-new-menu workspace-tab-context-menu"
      role="menu"
      aria-label={t('{{title}} tab actions', { title: menuTab.title })}
      style={{ left: tabMenu.left, top: tabMenu.top }}
    >
      {items.map((item) => (
        <button
          type="button"
          role="menuitem"
          key={item.label}
          disabled={item.disabled}
          onClick={() => {
            setTabMenu(null);
            item.run();
          }}
        >
          <span>{item.label}</span>
        </button>
      ))}
    </div>,
    document.body
  );
}

export function WorkspaceTabStrip({
  tabs,
  activeKey,
  activeBusy = false,
  workingSessionIds,
  unreadSessionIds,
  focused = false,
  paneId = '',
  trailing,
  onSelectTab,
  onCloseTab,
  onReorderTab,
  onPinTab,
  onNewTask,
}: WorkspaceTabStripProps) {
  // The mobile root marker + device-scale factor install in main.tsx BEFORE
  // the first render (user: 첫 진입 레이아웃 시프트) — nothing to do here.
  const selectTab = useCallback(
    (tab: WorkspaceTab) => {
      prefetchTabSurface(tab);
      const startedAt = performance.now();
      onSelectTab(tab);
      if (!window.mixdogDesktop?.perfLog) return;
      window.requestAnimationFrame(() =>
        window.requestAnimationFrame(() => {
          window.mixdogDesktop?.perfLog?.(
            `tab-switch kind=${tab.selection.kind} paint=${(performance.now() - startedAt).toFixed(0)}ms`
          );
        })
      );
    },
    [onSelectTab]
  );
  const tabNodes = useRef(new Map<string, HTMLDivElement>());
  const tabStrip = useRef<HTMLElement>(null);
  const nativeDrag = useRef<PaneDragSession | null>(null);
  const dragSourceMounted = useRef(true);
  const suppressTabClick = useRef('');
  const [draggingKey, setDraggingKey] = useState('');
  const [dropIndex, setDropIndex] = useState<number | null>(null);
  const [draggingGroup, setDraggingGroup] = useState(false);
  const [dragScroll, setDragScroll] = useState(false);
  const [tabMenu, setTabMenu] = useState<TabMenuAnchor | null>(null);
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
  const mobile = useMobileRemoteSurface();
  // Layout INPUT: the width the tab run may spend — the shell minus the
  // home slot, the fixed + slot and the three-control trailing safe zone.
  const measureWidths = useCallback(() => {
    const shell = shellNode.current;
    if (!shell) return;
    const width = shell.clientWidth;
    setShellWidth((previous) => (previous === width ? previous : width));
    const homeButton = shell.querySelector<HTMLElement>(':scope > .workspace-tab-home');
    const newButton = shell.querySelector<HTMLElement>(':scope > .workspace-tab-new');
    const trailingBox = shell.querySelector<HTMLElement>(':scope > .workspace-tabs-trailing');
    const available =
      width - (homeButton?.offsetWidth ?? 0) - (newButton?.offsetWidth ?? 0) - (trailingBox?.offsetWidth ?? 0);
    setStripAvailable((previous) => (previous === available ? previous : available));
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
    document.addEventListener('pointerdown', closeOutside);
    window.addEventListener('resize', closeMenu);
    window.addEventListener('scroll', closeMenu, true);
    return () => {
      document.removeEventListener('pointerdown', closeOutside);
      window.removeEventListener('resize', closeMenu);
      window.removeEventListener('scroll', closeMenu, true);
    };
  }, [tabMenu]);
  // ABB: the context menu closes on hardware back like every other layer.
  useMobileBack(Boolean(tabMenu), () => setTabMenu(null));
  // Shell width drives the Chrome tab-width ladder.
  const hasTrailing = Boolean(trailing);
  // biome-ignore lint/correctness/useExhaustiveDependencies: hasTrailing re-attaches the observer when the trailing box mounts or unmounts
  useLayoutEffect(() => {
    const shell = shellNode.current;
    if (!shell || typeof ResizeObserver === 'undefined') return undefined;
    measureWidths();
    const observer = new ResizeObserver(measureWidths);
    observer.observe(shell);
    // The trailing controls resize WITHOUT resizing the shell (a dock toggle
    // appears, a status chip grows); observing the box itself replaces the
    // old re-measure on every render that handed a fresh `trailing` node —
    // which was every App render, each a forced layout inside the commit.
    const trailingBox = shell.querySelector<HTMLElement>(':scope > .workspace-tabs-trailing');
    if (trailingBox) observer.observe(trailingBox);
    return () => observer.disconnect();
  }, [measureWidths, hasTrailing]);
  // Tab-count changes move the available width without resizing the shell —
  // re-measure on those renders too.
  // biome-ignore lint/correctness/useExhaustiveDependencies: tab count and trailing presence move the available width without resizing the shell
  useLayoutEffect(() => {
    measureWidths();
  }, [tabs.length, hasTrailing, measureWidths]);
  // Menus can anchor hard against the window's right edge; the measured box
  // is what keeps them on screen.
  // biome-ignore lint/correctness/useExhaustiveDependencies: the menu box is re-clamped whenever a menu opens or moves
  useLayoutEffect(() => {
    clampOverlayIntoView(tabMenuNode.current);
  }, [tabMenu]);
  // Survivor widths follow the recalculated run immediately; the CSS width
  // transition glides them instead of holding then jumping.
  // A tab the strip has just lost stays mounted as a ghost for one motion beat,
  // collapsing to nothing so its neighbours slide into the released space
  // instead of jumping across it; a tab the strip has just gained grows in
  // from nothing over the same beat (CSS @starting-style), so the run never
  // overflows the strip and the leading tab is never clipped and scrolled
  // back. Both are derived during render from the previous tab list: the
  // closing element is the very node that was open (its width transition
  // starts from where it stands), and the entering mark is on the node when
  // it is inserted. A same-length change (a draft promoted to its session)
  // animates nothing — that is a replacement, not an add or a close.
  const previousTabs = useRef(tabs);
  const previousActiveKey = useRef(activeKey);
  const closingTabs = useRef(new Map<string, { tab: WorkspaceTab; index: number; active: boolean }>());
  const enteringKeys = useRef(new Set<string>());
  const [, settleTabMotion] = useReducer((count: number) => count + 1, 0);
  const displayTabs = tabsWithClosingGhosts(tabs, previousTabs, closingTabs, enteringKeys, previousActiveKey.current);
  useLayoutEffect(() => {
    previousTabs.current = tabs;
    previousActiveKey.current = activeKey;
  }, [tabs, activeKey]);
  // One beat after the last change the ghosts unmount and the entering marks
  // drop; a change inside the beat restarts it so every tab settles together.
  // biome-ignore lint/correctness/useExhaustiveDependencies: a tab list change restarts the settle beat
  useEffect(() => {
    if (!closingTabs.current.size && !enteringKeys.current.size) return undefined;
    const timer = window.setTimeout(() => {
      closingTabs.current.clear();
      enteringKeys.current.clear();
      settleTabMotion();
    }, TAB_MOTION_SETTLE_MS);
    return () => window.clearTimeout(timer);
  }, [tabs]);
  const setTabNode = useCallback((key: string, node: HTMLDivElement | null) => {
    if (node) tabNodes.current.set(key, node);
    else tabNodes.current.delete(key);
  }, []);
  const onTabKeyDown = useWorkspaceTabCommands({
    tabs,
    activeKey,
    onSelectTab: selectTab,
    onCloseTab,
  });

  // Global Ctrl+W close shortcut (App owns the key handler). Keep this path
  // immediate; keyboard close should not wait for the 200ms pointer animation.
  useEffect(() => {
    const closeActive = () => {
      if (!focused) return;
      const active = tabs.find((tab) => tab.key === activeKey);
      if (active) onCloseTab(active);
    };
    window.addEventListener('mixdog:close-active-tab', closeActive);
    return () => window.removeEventListener('mixdog:close-active-tab', closeActive);
  }, [activeKey, focused, onCloseTab, tabs]);

  const clearNativeDrag = useCallback(() => {
    const drag = nativeDrag.current;
    nativeDrag.current = null;
    delete document.body.dataset.tabDragging;
    if (!dragSourceMounted.current) return;
    setDraggingKey('');
    setDraggingGroup(false);
    setDragScroll(false);
    setDropIndex(null);
    if (drag?.kind === 'tab') {
      suppressTabClick.current = drag.key;
      window.setTimeout(() => {
        if (suppressTabClick.current === drag.key) suppressTabClick.current = '';
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

  const startNativeDrag = useCallback(
    (event: React.DragEvent<HTMLElement>, kind: 'tab' | 'group', sourceTab: WorkspaceTab | undefined) => {
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
      if (kind === 'group') setDraggingGroup(true);
      else setDraggingKey(sourceTab.key);
      document.body.dataset.tabDragging = '1';
    },
    [clearNativeDrag, paneId]
  );

  const dropIndexAt = useCallback(
    (clientX: number, target: EventTarget | null): number | null => {
      const strip = tabStrip.current;
      if (!strip) return null;
      return tabDropIndex({ tabs, tabNodes: tabNodes.current, strip, clientX, target });
    },
    [tabs]
  );

  const handleNativeDragOver = useCallback(
    (event: React.DragEvent<HTMLElement>) => {
      const drag = currentPaneDrag();
      if (!drag) return;
      setDragScroll(true);
      if (drag.kind !== 'tab' || drag.sourceLeafId !== paneId) return;
      event.preventDefault();
      event.stopPropagation();
      if (event.dataTransfer) event.dataTransfer.dropEffect = 'move';
      setDropIndex(dropIndexAt(event.clientX, event.target));
    },
    [dropIndexAt, paneId]
  );

  const handleNativeDrop = useCallback(
    (event: React.DragEvent<HTMLElement>) => {
      const drag = currentPaneDrag();
      if (drag?.kind !== 'tab' || drag.sourceLeafId !== paneId) return;
      event.preventDefault();
      event.stopPropagation();
      const index = dropIndexAt(event.clientX, event.target);
      if (index !== null) onReorderTab(drag.key, index);
      acceptPaneDrag();
      setDropIndex(null);
    },
    [dropIndexAt, onReorderTab, paneId]
  );

  // Chromium CalculateTabBounds output for the current strip input; the
  // per-tab width variable pins basis/min/max exactly like gfx::Rect bounds.
  const chromeWidths =
    stripAvailable > 0
      ? calculateChromeTabWidths(
          tabs.length,
          Math.max(
            0,
            tabs.findIndex((tab) => tab.key === activeKey)
          ),
          stripAvailable
        )
      : null;
  useTabStripReveal({
    stripRef: tabStrip,
    tabNodes,
    activeKey,
    signature: tabs.map((tab) => `${tab.key}\u0000${tab.title}`).join('\u0001'),
    availableWidth: stripAvailable,
    targetWidth: chromeWidths?.reduce((sum, width) => sum + width, 0) ?? null,
  });
  return (
    <div
      ref={shellNode}
      className="workspace-tabs-shell"
      data-slot="workspace-tabs"
      data-count={tabs.length}
      data-mobile={mobile ? 'true' : undefined}
      data-focused={focused ? 'true' : 'false'}
    >
      {mobile && workspaceTabHomeButton()}
      {mobile &&
        workspaceMobileTabPill({
          tabs,
          activeKey,
          activeBusy,
          workingSessionIds,
          setTabMenu,
        })}
      {!mobile && (
        <nav
          ref={tabStrip}
          className={`workspace-tabs${dragScroll ? ' drag-scroll' : ''}`}
          data-slot="workspace-tabs-scroll"
          data-group-dragging={draggingGroup ? 'true' : undefined}
          draggable
          aria-label={t('Open tabs')}
          onKeyDown={onTabKeyDown}
          onWheel={(event) => {
            // Scroll mapping: the vertical wheel drives the
            // horizontal tab run.
            const strip = tabStrip.current;
            const delta = Math.abs(event.deltaX) > Math.abs(event.deltaY) ? event.deltaX : event.deltaY;
            if (strip && delta) strip.scrollBy?.({ left: delta, behavior: 'auto' });
          }}
          onDragStart={(event) => {
            if (event.target !== event.currentTarget) return;
            startNativeDrag(event, 'group', tabs.find((tab) => tab.key === activeKey) ?? tabs[0]);
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
        >
          {displayTabs.map(({ tab, closing, active: closedActive }) => {
            if (closing) return closingTabGhost(tab, closedActive);
            const index = tabs.indexOf(tab);
            const active = tab.key === activeKey;
            const dropLeft = draggingKey && dropIndex !== null && tabs[dropIndex - 1]?.key === tab.key;
            const dropRight = draggingKey && dropIndex !== null && tabs[dropIndex]?.key === tab.key;
            const working = tabIsWorking(tab, active, activeBusy, workingSessionIds);
            const unread = tab.selection.kind === 'session' && unreadSessionIds?.has(tab.selection.id) === true;
            const pinnedTabWidth = chromeWidths?.[index];
            return workspaceTabNode({
              tab,
              active,
              working,
              unread,
              dragging: draggingKey === tab.key,
              entering: enteringKeys.current.has(tab.key),
              dropLeft: Boolean(dropLeft),
              dropRight: Boolean(dropRight),
              pinnedTabWidth,
              suppressTabClick,
              setTabNode,
              selectTab,
              startNativeDrag,
              setTabMenu,
              onCloseTab,
              onPinTab,
            });
          })}
        </nav>
      )}
      {/* The fixed add slot is OUTSIDE the horizontal viewport. At a pane's
            320px floor, tabs may scroll but can never paint beneath this
            control or make it disappear. */}
      <button
        type="button"
        className="workspace-tab-new"
        aria-label={t('New task')}
        data-tooltip={t('New task')}
        onClick={onNewTask}
      >
        {/* Same lucide family and weight as the tab glyphs and dock toggles
              beside it; the codicon + read as a foreign mark (user: + 버튼이
              이질감이 있네). */}
        {/* 15px → a ~8.8px cross on the strip's 1.5px line: at 18px the +
              out-sized the 14px tab labels (user: +가 너무 크다). */}
        <Plus size={15} aria-hidden="true" />
      </button>
      {tabMenu &&
        workspaceTabContextMenu({
          tabMenu,
          tabs,
          tabMenuNode,
          setTabMenu,
          onCloseTab,
          onPinTab,
        })}
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
}: Pick<WorkspaceTabStripProps, 'tabs' | 'activeKey' | 'onSelectTab' | 'onCloseTab'>) {
  return useCallback(
    (event: KeyboardEvent<HTMLElement>) => {
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

      if (event.key.toLocaleLowerCase() === 'w') {
        const tab = tabs[activeIndex];
        if (tab) {
          onCloseTab(tab);
          handled = true;
        }
      } else if (/^[1-9]$/.test(event.key)) {
        handled = select(Number(event.key) - 1);
      }

      if (handled) event.preventDefault();
    },
    [activeKey, onCloseTab, onSelectTab, tabs]
  );
}
