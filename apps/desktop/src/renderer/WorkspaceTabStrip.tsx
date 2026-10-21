// Per-pane workspace tab strip: every pane group mounts one, so the
// Chrome-parity layout/animation model and the drag gestures (reorder inside
// the strip, drag below it to split/move) all live here. Class names are
// contract for the strip-contract dom tests and the shared CSS.
import React, { type KeyboardEvent, memo, useCallback, useEffect, useRef, useState } from 'react';
import { useStableEvent } from './use-stable-event';
import { createPortal } from 'react-dom';
import { explorerAbsolutePath } from './explorer-tree-model';
import { isRemoteHostRenderer } from './remote-ui-projection';
import { FileText, FileDiff, Folder, Globe, MessageCircle, Plus, Sparkles, Terminal, X } from 'lucide-react';

import type { DesktopSessionSummary } from '../shared/contract';
import { sessionAttention, type SessionAttention } from '../shared/session-attention';
import type { WorkspaceTab } from './nav-types';
import { sessionAttentionOf, useSessionAttentionIndex } from './session-attention-index';
import { SessionAttentionGlyph } from './session-status-mark';
import { t } from './i18n';
import { revealFileFromWindow } from './server-transfers';
import { prefetchSurfaceForSelection } from './lazy-widgets';
import { useMobileRemoteSurface } from './mobile-surface';
import { ProgressSpinner } from './ProgressSpinner';
import { RemotePcBrandDot } from './RemotePcSwitcher';
import { MixdogMark } from './mixdog-mark';
import { isAgentChatSession } from './agent-chat-mode';
import { AgentChatTabFace } from './agent-chat-header';
import { useTabStripReveal } from './use-tab-strip-reveal';
import { calculateChromeTabWidths, type TabMenuAnchor, type SetTabMenu, tabMenuAnchorAt } from './workspace-tab-layout';
import {
  type TabRename,
  useNewTaskTap,
  useTabMenuDismiss,
  useTabMotion,
  useTabRename,
  useTabRunWidth,
  useTabStripDrag,
} from './workspace-tab-strip-state';

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
  /** Session tabs rename in place on double-click (same commit rules as the sidebar row). */
  onRenameSession?(sessionId: string, title: string): unknown;
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
    case 'session':
      // A bot chat's tab carries the bot's face.
      if (isAgentChatSession(tab.selection.id)) return <AgentChatTabFace sessionId={tab.selection.id} />;
      return <MessageCircle size={size} />;
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
      <MixdogMark className="workspace-tab-home-mark" />
      <RemotePcBrandDot />
    </button>
  );
}

/** Phone title pill (user decision (a): 제목 알약은 그대로): the run of tabs
 *  has no room on a phone, so ONE label names the active tab — sessions live
 *  in the left drawer. Tapping re-selects the active tab (on an agent's home
 *  thread that opens its profile); long-press keeps the tab menu for
 *  closing. The + and the dock toggles beside it are the desktop's. */
function workspaceMobileTabPill({
  tabs,
  activeKey,
  activeBusy,
  workingSessionIds,
  pendingNewTask,
  setTabMenu,
  onSelectTab,
}: {
  onSelectTab(tab: WorkspaceTab): void;
  tabs: WorkspaceTab[];
  activeKey: string;
  activeBusy: boolean;
  workingSessionIds: ReadonlySet<string> | undefined;
  /** The + was just tapped: name the new task now, before the navigation commits. */
  pendingNewTask: boolean;
  setTabMenu: SetTabMenu;
}) {
  const pendingTab: WorkspaceTab = { key: '', title: t('New task'), selection: { kind: 'new' } };
  const activeTab = pendingNewTask ? pendingTab : (tabs.find((tab) => tab.key === activeKey) ?? tabs[0]);
  const working = !pendingNewTask && tabIsWorking(activeTab, true, activeBusy, workingSessionIds);
  return (
    <button
      type="button"
      className="workspace-tab-compact-current"
      data-tooltip={activeTab?.title}
      onClick={() => {
        if (activeTab && !pendingNewTask && activeTab.key === activeKey) onSelectTab(activeTab);
      }}
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
        <span className="workspace-tab-title">{tab.title}</span>
      </button>
      <button type="button" className="workspace-tab-close" tabIndex={-1}>
        <X size={18} aria-hidden="true" />
      </button>
    </div>
  );
}

type WorkspaceTabCellProps = Parameters<typeof workspaceTabNode>[0];

/** Equal when the cell would draw the same: the strip rebuilds every tab
 *  object per commit, so a tab compares by its fields; its handlers are the
 *  strip's stable events, and a rename by its draft (renameActions). */
function sameTabCell(previous: WorkspaceTabCellProps, next: WorkspaceTabCellProps): boolean {
  const a = previous.tab;
  const b = next.tab;
  return (
    a.key === b.key &&
    a.title === b.title &&
    a.selection === b.selection &&
    Boolean(a.preview) === Boolean(b.preview) &&
    Boolean(a.pinned) === Boolean(b.pinned) &&
    Boolean(a.dirty) === Boolean(b.dirty) &&
    previous.active === next.active &&
    previous.working === next.working &&
    previous.attention === next.attention &&
    previous.dragging === next.dragging &&
    previous.entering === next.entering &&
    previous.dropLeft === next.dropLeft &&
    previous.dropRight === next.dropRight &&
    previous.pinnedTabWidth === next.pinnedTabWidth &&
    previous.suppressTabClick === next.suppressTabClick &&
    previous.setTabNode === next.setTabNode &&
    previous.selectTab === next.selectTab &&
    previous.startNativeDrag === next.startNativeDrag &&
    previous.setTabMenu === next.setTabMenu &&
    previous.onCloseTab === next.onCloseTab &&
    previous.onPinTab === next.onPinTab &&
    Boolean(previous.rename) === Boolean(next.rename) &&
    previous.rename?.draft === next.rename?.draft &&
    previous.rename?.commit === next.rename?.commit
  );
}

/** One tab of the strip, rendered only when that tab changed: the strip
 *  itself renders on every App commit (a session switch is several). */
const WorkspaceTabCell = memo(function WorkspaceTabCell(props: WorkspaceTabCellProps) {
  return workspaceTabNode(props);
}, sameTabCell);

/** One live tab cell: selection, its status readout (the strongest of needs
 *  you, failed, working and unread), the drag source, the middle-click and
 *  context gestures, and the close control. */
function workspaceTabNode({
  tab,
  active,
  working,
  attention,
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
  rename,
}: {
  tab: WorkspaceTab;
  active: boolean;
  working: boolean;
  attention: SessionAttention | '';
  rename: TabRename | null;
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
  const editing = rename?.draft != null;
  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: the tab wrapper only carries drag, middle-click and context menu; its inner button is the control.
    <div
      key={tab.key}
      ref={(node) => setTabNode(tab.key, node)}
      className={`workspace-tab ${active ? 'active' : ''} ${tab.preview ? 'preview' : ''} ${tab.dirty ? 'dirty' : ''} ${dragging ? 'dragging' : ''} ${dropLeft ? 'drop-target-left' : ''} ${dropRight ? 'drop-target-right' : ''} ${entering ? 'entering' : ''} ${editing ? 'editing' : ''}`}
      data-tab-key={tab.key}
      data-active={active}
      data-working={working || undefined}
      data-attention={attention || undefined}
      aria-grabbed={dragging}
      draggable={!editing}
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
      onDoubleClick={(event) => {
        if (editing || (event.target as Element | null)?.closest?.('.workspace-tab-close')) return;
        onPinTab?.(tab);
        rename?.start(tab);
      }}
      onContextMenu={(event) => {
        if (editing) return;
        event.preventDefault();
        setTabMenu(tabMenuAnchorAt(tab.key, event));
      }}
    >
      {editing && rename && (
        <input
          // biome-ignore lint/a11y/noAutofocus: the rename field opens from an explicit double-click and must take the caret.
          autoFocus
          className="workspace-tab-title-input"
          value={rename.draft ?? ''}
          maxLength={100}
          aria-label={t('Rename {{name}}', { name: tab.title })}
          onFocus={(event) => event.currentTarget.select()}
          onInput={(event) => rename.change(event.currentTarget.value)}
          onClick={(event) => event.stopPropagation()}
          onMouseDown={(event) => event.stopPropagation()}
          onDoubleClick={(event) => event.stopPropagation()}
          onKeyDown={(event) => {
            event.stopPropagation();
            if (event.key === 'Enter' && !event.nativeEvent.isComposing) {
              event.preventDefault();
              rename.commit(tab);
            } else if (event.key === 'Escape') {
              event.preventDefault();
              rename.cancel();
            }
          }}
          onBlur={() => rename.commit(tab)}
        />
      )}
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
        {/* The tab GLYPH carries the strongest status: the needs-you or
              failure mark, else the progress spinner while the session works
              (user decision) — no extra dot. */}
        {attention === 'needs-you' || attention === 'failed' || attention === 'waiting' ? (
          <SessionAttentionGlyph status={attention} name={tab.title} size={14} className="workspace-tab-attention" />
        ) : working ? (
          <ProgressSpinner
            size={14}
            className="workspace-tab-status"
            role="status"
            aria-label={t('{{name}} is working', { name: tab.title })}
          />
        ) : (
          tabGlyph(tab)
        )}
        <span className="workspace-tab-title">{tab.title}</span>
        {attention === 'unread' && (
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
                    void revealFileFromWindow(fileTarget.project, fileTarget.rel, fileTarget.accessToken);
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
  onRenameSession,
  onNewTask,
}: WorkspaceTabStripProps) {
  const tabRename = useTabRename(onRenameSession);
  // The strip's owner hands fresh handlers on every App commit; the cells
  // call them through these, so an unchanged tab skips the commit.
  const selectTabEvent = useStableEvent(onSelectTab);
  const closeTabEvent = useStableEvent(onCloseTab);
  const pinTabEvent = useStableEvent((tab: WorkspaceTab) => onPinTab?.(tab));
  // The mobile root marker + device-scale factor install in main.tsx BEFORE
  // the first render (user: 첫 진입 레이아웃 시프트) — nothing to do here.
  const selectTab = useCallback(
    (tab: WorkspaceTab) => {
      prefetchTabSurface(tab);
      const startedAt = performance.now();
      selectTabEvent(tab);
      if (!window.mixdogDesktop?.perfLog) return;
      window.requestAnimationFrame(() =>
        window.requestAnimationFrame(() => {
          window.mixdogDesktop?.perfLog?.(
            `tab-switch kind=${tab.selection.kind} paint=${(performance.now() - startedAt).toFixed(0)}ms`
          );
        })
      );
    },
    [selectTabEvent]
  );
  const tabNodes = useRef(new Map<string, HTMLDivElement>());
  const tabStrip = useRef<HTMLElement>(null);
  const [tabMenu, setTabMenu] = useState<TabMenuAnchor | null>(null);
  const tabMenuNode = useRef<HTMLDivElement>(null);
  // Every renderer follows ONE tab-strip layout —
  // tabs shrink to sliver floors and never switch to a device-specific mode.
  const shellNode = useRef<HTMLDivElement>(null);
  // The phone draws the SAME strip as the desktop (user: PC에 최대한 맞춰서 —
  // 헤더가 완전 다르다): real tabs, X, + and the dock toggles. Its only
  // addition is the brand mark at the front, which opens the session drawer
  // the desktop reaches through its activity rail.
  const mobile = useMobileRemoteSurface();
  const [newTaskPending, tapNewTask] = useNewTaskTap(mobile, activeKey, onNewTask);
  // Needs-you and failure signals; working and unread come in as props.
  const attentionIndex = useSessionAttentionIndex();
  const stripAvailable = useTabRunWidth(shellNode, tabs.length, Boolean(trailing));
  useTabMenuDismiss(tabMenu, tabMenuNode, setTabMenu);
  const { displayTabs, enteringKeys } = useTabMotion(tabs, activeKey);
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

  const {
    draggingKey,
    dropIndex,
    draggingGroup,
    dragScroll,
    suppressTabClick,
    startNativeDrag,
    finishNativeDrag,
    handleNativeDragOver,
    handleNativeDrop,
    enterStrip,
    leaveStrip,
  } = useTabStripDrag({ tabs, paneId, tabStrip, tabNodes, onReorderTab });

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
          pendingNewTask: newTaskPending,
          setTabMenu,
          onSelectTab: selectTab,
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
          onDragEnter={enterStrip}
          onDragOver={handleNativeDragOver}
          onDragLeave={leaveStrip}
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
            const attention =
              tab.selection.kind === 'session'
                ? sessionAttentionOf(attentionIndex, tab.selection.id, { running: working, unread })
                : sessionAttention({ running: working });
            const pinnedTabWidth = chromeWidths?.[index];
            return (
              <WorkspaceTabCell
                key={tab.key}
                tab={tab}
                active={active}
                working={working}
                attention={attention}
                dragging={draggingKey === tab.key}
                entering={enteringKeys.current.has(tab.key)}
                dropLeft={Boolean(dropLeft)}
                dropRight={Boolean(dropRight)}
                pinnedTabWidth={pinnedTabWidth}
                suppressTabClick={suppressTabClick}
                setTabNode={setTabNode}
                selectTab={selectTab}
                startNativeDrag={startNativeDrag}
                setTabMenu={setTabMenu}
                onCloseTab={closeTabEvent}
                onPinTab={onPinTab ? pinTabEvent : undefined}
                rename={tabRename(tab)}
              />
            );
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
        onClick={tapNewTask}
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
