import { ChevronDown, ChevronRight, Star } from 'lucide-react';
import type React from 'react';
import { createPortal } from 'react-dom';
import {
  Fragment,
  lazy,
  memo,
  Suspense,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';
import { InitialSurface } from './InitialSurface';
import { AGENT_GROUP_EXPANSION_EVENT, useHiddenAgentGroups } from './agent-group-visibility';
import { ScmContextMenu, type ScmContextMenuState, contextMenuRowProps } from './ScmContextMenu';
import { ConnectorsPill } from './connector-card';
import { beginBootSurface, reportBootSurfaceReady } from './boot-metrics';
import type { DesktopAgentPoolRow, DesktopModelSelection, DesktopSessionSummary } from '../shared/contract';
import {
  desktopAgentActivityState,
  hasPendingDesktopAgentWork,
  type DesktopAgentActivityState,
} from '../shared/agent-activity';
import { RowOverflowMenu, rowOverflowHostProps } from './RowOverflowMenu';
import { sessionDisplayTitle } from './session-display-title';
import { t } from './i18n';
import { agentElapsedText } from './agent-row-meta';
import { useClock } from './use-clock';
import { clearableAgentTreeRows, dismissFinishedAgentRows, useVisibleAgentPool } from './agent-dismiss';
import { AgentProviderMark, AgentRouteSummary, useSessionDragSource } from './agent-row-parts';
import { type AgentChatIndicator, agentChatTimeLabel, agentRowName } from './agent-chat-summary';
import { ProgressSpinner } from './ProgressSpinner';
import { AgentRoomsSection, useAgentRoomRows } from './AgentRoomsSection';
import { AgentPaneHeaderActions } from './agent-pane-header-actions';
import { TextShimmer } from './transcript-primitives';
import { type AgentContact, agentContacts } from './agent-contacts-model';
import { AgentAvatar } from './agent-avatar';
import { type AgentLeadRow, AgentLeadRows, agentLeadRows, retainWindowMs } from './agent-lead-rows';
import { SubtreeToggle, subAgentNodes, subAgentsNeedAttention, subtreeMenuItem, subtreeRowAttr } from './agent-subtree';
import { LeadAppearanceDialog } from './lead-appearance-dialog';
import {
  applyBotOrder,
  hiddenPaneGroups,
  PANE_GROUP_IDS,
  type PaneToggleId,
  type PaneSectionId,
  paneSectionOrder,
  pinnedLeadIds,
  retainChoice,
  setGroupHidden,
  setLeadPinned,
  setRetainChoice,
  useBotOrder,
} from './bot-order-store';
import { ArrangedSections } from './agent-section-order';
import { usePaneBotReorder } from './bot-reorder';
import { type AvatarMotionState, useNewMessagePulse } from './avatar-motion';
import { openAgentProfile } from './agent-panel-tab';
import { agentContactMenuItems } from './agent-profile-actions';
import { EMPTY_SNAPSHOT } from './desktop-types';
import { draftModelSelectionFromSnapshot } from './draft-pane-prefs-store';
import { defaultSessionLaneStore } from './session-lane-store';
import { useSessionAttentionIndex } from './session-attention-index';
import { useSidebarHiddenBots } from './sidebar-hidden-bots-store';
import { useSidebarReferences } from './sidebar-reference-cache';
import { showDesktopToast } from './desktop-toasts';
import { errorMessageText } from './ErrorNotice';
import { MixyEmptyState, useMixyFirstPane } from './mixy-first';
import { isAgentChatSession } from './agent-chat-mode';
import { agentHomeSessionId } from '../../../../src/runtime/agent/orchestrator/session/agent-home.mjs';
import {
  AGENT_POOL_RECONCILE_MS,
  agentActivityGroups,
  agentPoolStore,
  agentRoleLabel,
  flattenAgentActivityNodes,
  poolRowKey,
  refreshAgentPool,
  startAgentPool,
  stickyGroupOrder,
  visibleAgentTreeRows,
} from './agent-activity-model';
import type { AgentActivityNode } from './agent-activity-model';

export {
  AGENT_POOL_RECONCILE_MS,
  agentActivityGroups,
  flattenAgentActivityNodes,
  liveAgentRows,
  preloadAgentPool,
} from './agent-activity-model';

// Loaded on "+" only: the Workflows editor graph stays out of every bundle
// that reaches this pane (the composer island among them).
const AgentCreateDialog = lazy(() =>
  import('./agent-create-dialog').then((module) => ({ default: module.AgentCreateDialog }))
);

/** A running row's clock: the caller's when it supplies one, otherwise a
 *  one-second tick owned by the leaf that reads it, so only that leaf
 *  re-renders each second, not its row or pane. */
function useRowClock(state: DesktopAgentActivityState, clock: number | undefined): number {
  const now = useClock(state === 'running' && clock === undefined);
  return clock ?? now;
}

/** The row's right-column text. */
function AgentRowElapsed({
  state,
  agent,
  clock,
}: {
  state: DesktopAgentActivityState;
  agent: DesktopAgentPoolRow;
  clock?: number;
}): React.ReactElement {
  const elapsed = agentElapsedText(state, agent, useRowClock(state, clock));
  return (
    // biome-ignore lint/a11y/useAriaPropsSupportedByRole: aria-label on <time> gives the elapsed duration an explicit accessible name
    <time
      className="agent-activity-elapsed"
      aria-label={elapsed || undefined}
      title={state === 'cancel-unconfirmed' ? t('Cancel unconfirmed') : undefined}
      data-state={state}
    >
      {elapsed}
    </time>
  );
}

/** The tab title a child agent opens under: its session title plus its tag. */
function agentTabTitle(agent: DesktopAgentPoolRow, role: string): string {
  const tag = String(agent.tag || '').trim();
  const sessionTitle = String(agent.title || '').trim();
  return tag && tag.toLowerCase() !== sessionTitle.toLowerCase()
    ? [sessionTitle, tag].filter(Boolean).join(' · ')
    : sessionTitle || tag || role;
}

export const AgentPoolRow = memo(function AgentPoolRow({
  agent,
  clock,
  stateOverride,
  ownerSessionId,
  depth = 0,
  parentSessionId = '',
  hasChildren = false,
  expanded = true,
  posInSet,
  setSize,
  tabIndex,
  unread = false,
  waitingForTasks = false,
  descendantCount = 0,
  fallbackProvider,
  onPrefetchSession,
  onOpenLeadSession,
  onOpenSession,
}: {
  /** The Lead row's brand when the pool row names none: its session's route. */
  fallbackProvider?: string;
  agent: DesktopAgentPoolRow;
  /** A caller-owned clock (the composer island's); omitted, a running row
   *  ticks on its own. */
  clock?: number;
  /** A lifecycle state the caller already resolved (the composer island's
   *  rows, which merge worker and job entries); the sidebar derives its own. */
  stateOverride?: DesktopAgentActivityState;
  ownerSessionId: string;
  /** Generations below the group heading: 0 for the visible root row (the Lead
   *  when the pool publishes one), 1 for its direct children, and so on. */
  depth?: number;
  parentSessionId?: string;
  hasChildren?: boolean;
  /** Real expansion state of this row's subtree; undefined for a leaf, which
   *  must not claim an expansion it does not have. */
  expanded?: boolean;
  posInSet?: number;
  setSize?: number;
  /** Roving tab focus: exactly one row per tree is in the tab order. */
  tabIndex?: number;
  /** Unseen activity is a completion only after descendant work has settled. */
  unread?: boolean;
  waitingForTasks?: boolean;
  descendantCount?: number;
  onPrefetchSession?(sessionId: string): void;
  onOpenLeadSession?(sessionId: string): void;
  onOpenSession?(sessionId: string, title: string, ownerSessionId: string): void;
}): React.ReactElement {
  // One lifecycle mapping owns this row. Cancellation is settled first, so a
  // stopped agent can never borrow the running timer or the "Completed" notice
  // (an agent cancelled mid-turn still carries stage `running`, and one
  // cancelled while waiting still carries stage `queued`).
  const state = stateOverride ?? desktopAgentActivityState(agent, { unread, waitingForTasks });
  const role = agentRoleLabel(agent.agent || agent.tag);
  const sessionId = String(agent.sessionId || '').trim();
  const lead = Boolean(sessionId) && sessionId === ownerSessionId;
  const name = agentRowName(agent, lead);
  const tabTitle = agentTabTitle(agent, role);
  const prefetch = () => {
    if (sessionId) onPrefetchSession?.(lead ? ownerSessionId : sessionId);
  };
  const { dragProps, clickSuppressed } = useSessionDragSource(sessionId, tabTitle);
  return (
    <button
      type="button"
      className="schedules-row workflows-agent-summary-row agent-pool-row"
      data-agent-tag={agent.tag || undefined}
      data-agent-session-id={sessionId || undefined}
      data-agent-parent-session-id={parentSessionId || undefined}
      data-agent-depth={depth}
      // Flat-tree ARIA: the DOM stays one row per control, so the hierarchy is
      // carried by level/position, and the tree owns arrow-key navigation.
      role="treeitem"
      aria-level={depth + 1}
      aria-posinset={posInSet}
      aria-setsize={setSize}
      aria-expanded={hasChildren ? expanded !== false : undefined}
      tabIndex={tabIndex}
      aria-label={name}
      disabled={!sessionId}
      {...dragProps}
      onPointerEnter={prefetch}
      onFocus={prefetch}
      onPointerDown={prefetch}
      onClick={() => {
        if (!sessionId || clickSuppressed()) return;
        if (lead) onOpenLeadSession?.(ownerSessionId);
        else onOpenSession?.(sessionId, tabTitle, ownerSessionId);
      }}
    >
      {/* The brand of the model the agent runs on marks the row, as in the
      Workflows panel (user: 에이전트 창은 이번 적용 안 된 거?). */}
      <AgentProviderMark agent={{ provider: agent.provider || (lead ? fallbackProvider : undefined) || null }} />
      <span className="schedules-row-copy">
        <span className="agent-pool-heading">
          <b className="agent-pool-name">{name}</b>
          {lead && descendantCount > 0 && <span className="dock-review-count">{descendantCount}</span>}
        </span>
        <AgentRouteSummary agent={agent} />
      </span>
      <span className="agent-activity-status">
        <AgentRowElapsed state={state} agent={agent} clock={clock} />
      </span>
    </button>
  );
});

/** An unread count as its pill shows it: capped at "99+". */
export function unreadBadgeLabel(count: number): string {
  return count > 99 ? '99+' : String(Math.max(1, Math.floor(count)));
}

/** The row's single trailing status (see AgentChatIndicator). Attention has
 *  no pill: the preview line already says what the agent waits for; a
 *  contact row (`attentionMark`) also shows a mark in its status cell. The
 *  attention and failure marks are filled "!" pills, amber and red, the
 *  unread count's shape (design/mockups/bot-list-messenger, option A). */
function AgentChatStatus({
  indicator,
  id,
  attentionMark = false,
}: {
  indicator: AgentChatIndicator;
  id: string;
  attentionMark?: boolean;
}) {
  if (!indicator) return null;
  if (indicator.kind === 'attention' && attentionMark) {
    return (
      <span id={id} className="agent-chat-status" data-kind="attention-mark">
        <span aria-hidden="true">!</span>
        <span className="sr-only">{t('Waiting for approval')}</span>
      </span>
    );
  }
  if (indicator.kind === 'attention') {
    return (
      <span id={id} className="sr-only">
        {t('Waiting for approval')}
      </span>
    );
  }
  if (indicator.kind === 'error') {
    return (
      <span id={id} className="agent-chat-status" data-kind="error">
        <span aria-hidden="true">!</span>
        <span className="sr-only">{t('Failed')}</span>
      </span>
    );
  }
  if (indicator.kind === 'running') {
    return (
      <span id={id} className="agent-chat-status" data-kind="running">
        <ProgressSpinner size={14} aria-hidden="true" />
        <span className="sr-only">{t('Working')}</span>
      </span>
    );
  }
  return (
    <span id={id} className="agent-chat-status" data-kind="unread">
      <span className="sr-only">{t('Unread')} </span>
      {unreadBadgeLabel(indicator.count)}
    </span>
  );
}

const AGENT_TREE_KEYS = new Set(['ArrowDown', 'ArrowUp', 'ArrowLeft', 'ArrowRight', 'Home', 'End']);

/** One owner group rendered as a real ARIA tree: roving tab focus, Arrow
 *  Up/Down through the painted rows, Arrow Right/Left to open, close and climb
 *  the hierarchy, Home/End to its ends. Every `aria-expanded` here reports the
 *  state the surface actually paints — including a row whose subtree is folded
 *  away with its group. */
function AgentActivityTree({
  group,
  label,
  groupExpanded,
  expandedSessionIds,
  onSetExpanded,
  unreadSessionIds,
  onExpandGroup,
  onCollapseGroup,
  onPrefetchSession,
  onOpenLeadSession,
  onOpenSession,
}: {
  group: { ownerId: string; nodes: readonly AgentActivityNode[]; session?: Pick<DesktopSessionSummary, 'provider'> };
  label: string;
  groupExpanded: boolean;
  expandedSessionIds: ReadonlySet<string>;
  onSetExpanded(sessionId: string, expanded: boolean): void;
  unreadSessionIds?: ReadonlySet<string>;
  onExpandGroup?(): void;
  onCollapseGroup?(): void;
  onPrefetchSession?(sessionId: string): void;
  onOpenLeadSession?(sessionId: string): void;
  onOpenSession?(sessionId: string, title: string, ownerSessionId: string): void;
}): React.ReactElement {
  const treeRef = useRef<HTMLDivElement | null>(null);
  const [focusedSessionId, setFocusedSessionId] = useState('');
  const descendantCount = useMemo(
    () => flattenAgentActivityNodes(group.nodes).filter((node) => node.sessionId !== group.ownerId).length,
    [group.nodes, group.ownerId]
  );
  const rows = useMemo(() => {
    const visible = visibleAgentTreeRows(group.nodes, expandedSessionIds);
    // A collapsed GROUP keeps exactly the owner's own row: every descendant,
    // at any generation, folds away with it.
    return groupExpanded ? visible : visible.filter((node) => node.sessionId === group.ownerId);
  }, [expandedSessionIds, group.nodes, group.ownerId, groupExpanded]);
  const focusedIndex = rows.findIndex((node) => node.sessionId === focusedSessionId);
  const activeIndex = focusedIndex >= 0 ? focusedIndex : 0;
  const rowExpanded = (node: AgentActivityNode): boolean => groupExpanded && expandedSessionIds.has(node.sessionId);
  const focusRow = (index: number): void => {
    const node = rows[Math.min(Math.max(index, 0), rows.length - 1)];
    if (!node) return;
    setFocusedSessionId(node.sessionId);
    treeRef.current?.querySelector<HTMLElement>(`[data-agent-session-id="${node.sessionId}"]`)?.focus();
  };
  const setRowCollapsed = (sessionId: string, collapsed: boolean): void => {
    setFocusedSessionId(sessionId);
    onSetExpanded(sessionId, !collapsed);
  };
  const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>): void => {
    if (!AGENT_TREE_KEYS.has(event.key)) return;
    if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
    const originId =
      (event.target as HTMLElement | null)?.closest<HTMLElement>('[data-agent-session-id]')?.dataset.agentSessionId ||
      '';
    const found = rows.findIndex((node) => node.sessionId === originId);
    const index = found >= 0 ? found : activeIndex;
    const node = rows[index];
    if (!node) return;
    event.preventDefault();
    if (event.key === 'ArrowDown') {
      focusRow(index + 1);
      return;
    }
    if (event.key === 'ArrowUp') {
      focusRow(index - 1);
      return;
    }
    if (event.key === 'Home') {
      focusRow(0);
      return;
    }
    if (event.key === 'End') {
      focusRow(rows.length - 1);
      return;
    }
    const hasChildren = node.children.length > 0;
    if (event.key === 'ArrowRight') {
      // The root row of a folded group opens the group itself: that fold is
      // the only thing hiding its subtree.
      if (!groupExpanded && node.sessionId === group.ownerId) {
        onExpandGroup?.();
        return;
      }
      if (!hasChildren) return;
      if (!rowExpanded(node)) {
        setRowCollapsed(node.sessionId, false);
        return;
      }
      // Expanded: its first child is the next row in depth-first order.
      focusRow(index + 1);
      return;
    }
    if (hasChildren && rowExpanded(node)) {
      setRowCollapsed(node.sessionId, true);
      return;
    }
    const parentIndex = rows.findIndex((row) => row.sessionId === node.parentSessionId);
    if (parentIndex >= 0) {
      focusRow(parentIndex);
      return;
    }
    if (groupExpanded) onCollapseGroup?.();
  };
  return (
    <div ref={treeRef} className="schedules-list" role="tree" aria-label={label} onKeyDown={onKeyDown}>
      {rows.map((node, index) => (
        <AgentPoolRow
          key={poolRowKey(node.agent, index)}
          agent={node.agent}
          depth={node.depth}
          parentSessionId={node.parentSessionId}
          hasChildren={node.children.length > 0}
          expanded={rowExpanded(node)}
          posInSet={node.posInSet}
          setSize={node.setSize}
          tabIndex={index === activeIndex ? 0 : -1}
          ownerSessionId={group.ownerId}
          descendantCount={descendantCount}
          fallbackProvider={group.session?.provider}
          unread={unreadSessionIds?.has(node.sessionId) === true}
          waitingForTasks={flattenAgentActivityNodes(node.children).some(({ agent }) =>
            hasPendingDesktopAgentWork(agent)
          )}
          onPrefetchSession={onPrefetchSession}
          onOpenLeadSession={onOpenLeadSession}
          onOpenSession={onOpenSession}
        />
      ))}
    </div>
  );
}

/** Pool reconciliation cadence. A hidden surface (phone screen off, app in the
 *  background, another tab) reconciles rows nobody can see while still paying
 *  for the request every two seconds over a metered link. Pause there and
 *  resume with ONE immediate refresh, so the first visible frame is current. */
function useAgentPoolCadence(poolStore: ReturnType<typeof agentPoolStore>, active: boolean): void {
  useEffect(() => {
    startAgentPool(poolStore);
    if (!active) return undefined;
    let reconcileTimer = 0;
    const stop = (): void => {
      if (!reconcileTimer) return;
      window.clearInterval(reconcileTimer);
      reconcileTimer = 0;
    };
    const start = (): void => {
      if (reconcileTimer) return;
      void refreshAgentPool(poolStore);
      reconcileTimer = window.setInterval(() => {
        void refreshAgentPool(poolStore);
      }, AGENT_POOL_RECONCILE_MS);
    };
    const syncCadence = (): void => {
      if (document.visibilityState === 'visible') start();
      else stop();
    };
    syncCadence();
    document.addEventListener('visibilitychange', syncCadence);
    return () => {
      document.removeEventListener('visibilitychange', syncCadence);
      stop();
    };
  }, [active, poolStore]);
}

/** Groups whose owner session still exists, newest first. Rebuilt each pass so
 *  departed sessions drop out; surviving groups carry their stamp forward,
 *  which is what keeps live rows from shuffling. */
function agentActivitySessionGroups(
  agents: Parameters<typeof agentActivityGroups>[0],
  sessions: readonly DesktopSessionSummary[],
  orderRef: { current: Map<string, number> }
) {
  const sessionById = new Map(sessions.map((session) => [session.id, session]));
  const built = agentActivityGroups(agents, (ownerId) => sessionById.has(ownerId));
  const order = new Map<string, number>();
  for (const group of built) {
    order.set(group.ownerId, stickyGroupOrder(orderRef.current, group.ownerId, group.agents));
  }
  orderRef.current = order;
  return built
    .flatMap((group) => {
      const session = sessionById.get(group.ownerId);
      return session ? [{ ...group, session, stamp: order.get(group.ownerId) || 0 }] : [];
    })
    .sort((left, right) => {
      const leftTime = order.get(left.ownerId) || 0;
      const rightTime = order.get(right.ownerId) || 0;
      return rightTime - leftTime || left.ownerId.localeCompare(right.ownerId);
    });
}

type AgentActivitySessionGroup = ReturnType<typeof agentActivitySessionGroups>[number];

/** Work sessions keep every Lead group except agent home threads, whose pool
 *  nodes feed their contact row instead. */
export function splitAgentHomeGroups<G extends { ownerId: string; session: DesktopSessionSummary; nodes: unknown }>(
  groups: readonly G[]
): { groups: G[]; homeNodes: Map<string, G['nodes']> } {
  const work: G[] = [];
  const homeNodes = new Map<string, G['nodes']>();
  for (const group of groups) {
    if (group.session.agentHome) homeNodes.set(group.ownerId, group.nodes);
    else work.push(group);
  }
  return { groups: work, homeNodes };
}

/** Every owner and descendant session the expand-all command reaches. */
function expandedAgentActivityIds(
  groups: readonly AgentActivitySessionGroup[],
  hiddenOwnerIds: ReadonlySet<string>
): Set<string> {
  return new Set(
    groups
      .filter((group) => !hiddenOwnerIds.has(group.ownerId))
      .flatMap((group) => [group.ownerId, ...flattenAgentActivityNodes(group.nodes).map((node) => node.sessionId)])
  );
}

/** One Lead session's group: its bold title with a collapse chevron and the
 *  group's own menu (the `…`, right-click, Menu/Shift+F10 and a touch
 *  long-press), over the Lead row and one row per child agent. */
function AgentActivityGroup({
  group,
  expandedSessionIds,
  unreadSessionIds,
  setSessionExpanded,
  hideGroup,
  onOpenMenu,
  onPrefetchSession,
  onOpenLeadSession,
  onOpenSession,
}: {
  group: AgentActivitySessionGroup;
  expandedSessionIds: ReadonlySet<string>;
  unreadSessionIds?: ReadonlySet<string>;
  setSessionExpanded(sessionId: string, expanded: boolean): void;
  hideGroup(ownerId: string): void;
  onOpenMenu(menu: ScmContextMenuState): void;
  onPrefetchSession?(sessionId: string): void;
  onOpenLeadSession?(sessionId: string): void;
  onOpenSession?(sessionId: string, title: string, ownerSessionId: string): void;
}): React.ReactElement {
  const title = sessionDisplayTitle(group.session, t('Untitled session'));
  const expanded = expandedSessionIds.has(group.ownerId);
  // Any agent of the group still working — the Lead or a descendant — makes
  // the session name shimmer, so a folded group still reads as live.
  const working = group.agents.some((agent) => desktopAgentActivityState(agent) === 'running');
  const setGroupCollapsed = (collapsed: boolean): void => setSessionExpanded(group.ownerId, !collapsed);
  const label = t('Actions for {{title}}', { title });
  const items = [
    { id: 'hide-agent-group', label: t('Hide this group'), onSelect: () => hideGroup(group.ownerId) },
    {
      id: 'clear-finished-agents',
      label: t('Clear finished'),
      disabled: clearableAgentTreeRows(group.nodes).length === 0,
      onSelect: () => dismissFinishedAgentRows(clearableAgentTreeRows(group.nodes)),
    },
  ];
  const menuProps = contextMenuRowProps((point) => onOpenMenu({ label, ...point, items }));
  return (
    <section className="workflows-models agent-activity-group" data-agent-owner-session-id={group.ownerId}>
      <div className="workflows-section-head" {...rowOverflowHostProps()} {...menuProps}>
        <button
          type="button"
          className="agent-session-heading"
          aria-label={title}
          aria-expanded={expanded}
          data-lead-session-id={group.ownerId}
          onClick={() => setGroupCollapsed(expanded)}
        >
          <h2>
            <TextShimmer text={title} active={working} />
          </h2>
          <span className="agent-session-chevron" aria-hidden="true">
            {expanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
          </span>
        </button>
        <RowOverflowMenu label={label} items={items} />
      </div>
      <AgentActivityTree
        group={group}
        label={title}
        groupExpanded={expanded}
        expandedSessionIds={expandedSessionIds}
        onSetExpanded={setSessionExpanded}
        unreadSessionIds={unreadSessionIds}
        onExpandGroup={() => setGroupCollapsed(false)}
        onCollapseGroup={() => setGroupCollapsed(true)}
        onPrefetchSession={onPrefetchSession}
        onOpenLeadSession={onOpenLeadSession}
        onOpenSession={onOpenSession}
      />
    </section>
  );
}

/** One contact: an agent as a messenger row over its home thread — avatar
 *  (its mascot; Mixy's carries a star), display name,
 *  time, last-message preview and the one trailing status. */
function AgentContactRow({
  contact,
  selected,
  subNodes,
  subOpen = false,
  onToggleSub,
  onOpen,
  onOpenMenu,
  onProfile,
  reorderProps,
  onReorderKey,
}: {
  contact: AgentContact;
  /** Drop target and drag-state marks of the row (usePaneBotReorder). */
  reorderProps?: object;
  /** Alt+Arrow on the row moves the bot (not offered for Mixy). */
  onReorderKey?(event: React.KeyboardEvent<HTMLElement>): void;
  selected: boolean;
  /** The pool nodes under its home thread: any sub-agent gives the row a chevron. */
  subNodes?: readonly AgentActivityNode[];
  subOpen?: boolean;
  onToggleSub?(expanded: boolean): void;
  onOpen(contact: AgentContact): void;
  onOpenMenu(menu: ScmContextMenuState): void;
  onProfile(contact: AgentContact): void;
}) {
  const describedBy = useId();
  const { dragProps, clickSuppressed } = useSessionDragSource(
    contact.session?.id ?? '',
    contact.name,
    contact.mixy ? undefined : contact.agentId
  );
  useSidebarHiddenBots(); // re-render so the menu offers 사이드바에 표시 while hidden
  const subCount = subAgentNodes(contact.session?.id ?? '', subNodes).length;
  const hasSubAgents = subCount > 0;
  // An empty second line still says there are sub-agents.
  const preview = contact.preview || (hasSubAgents ? t('Sub-agents {{count}}', { count: subCount }) : '');
  const items = [
    ...(hasSubAgents && onToggleSub ? [subtreeMenuItem(subOpen, onToggleSub)] : []),
    ...agentContactMenuItems(contact, { onOpen, onProfile }),
    ...(hasSubAgents && subNodes
      ? [
          {
            id: 'clear-finished-agents',
            label: t('Clear finished'),
            disabled: clearableAgentTreeRows(subNodes).length === 0,
            onSelect: () => dismissFinishedAgentRows(clearableAgentTreeRows(subNodes)),
          },
        ]
      : []),
  ];
  // The face bobs while the agent works and bounces once on a new message.
  const arrived = useNewMessagePulse(contact.indicator?.kind === 'unread' ? contact.indicator.count : 0);
  let faceState: AvatarMotionState = contact.indicator?.kind === 'running' ? 'typing' : 'still';
  if (arrived) faceState = 'message';
  return (
    <li
      className={`agent-chat-row${selected ? ' selected' : ''}`}
      data-kind="contact"
      data-agent-contact={contact.agentId}
      data-drag-frame="row"
      data-agent-disabled={contact.disabled ? 'true' : undefined}
      {...subtreeRowAttr(hasSubAgents && Boolean(onToggleSub))}
      {...reorderProps}
      data-name-only={contact.preview || contact.indicator || contact.at > 0 ? undefined : 'true'}
      {...contextMenuRowProps((point) =>
        onOpenMenu({ label: t('Actions for {{title}}', { title: contact.name }), ...point, items })
      )}
    >
      {hasSubAgents && onToggleSub && (
        <SubtreeToggle
          expanded={subOpen}
          name={contact.name}
          onToggle={onToggleSub}
          dragProps={dragProps}
          clickSuppressed={clickSuppressed}
        />
      )}
      <button
        type="button"
        className="agent-chat-row-main"
        aria-current={selected ? 'page' : undefined}
        aria-haspopup="menu"
        aria-label={contact.name}
        aria-describedby={`${describedBy}-preview ${describedBy}-status`}
        {...dragProps}
        aria-keyshortcuts={onReorderKey ? 'Alt+ArrowUp Alt+ArrowDown' : undefined}
        title={onReorderKey ? t('Drag or use Alt + arrow keys to reorder') : undefined}
        onKeyDown={onReorderKey}
        onClick={() => {
          if (!clickSuppressed()) onOpen(contact);
        }}
      >
        <span className="agent-chat-avatar">
          <AgentAvatar
            agentId={contact.agentId}
            avatar={contact.avatar}
            className="agent-contact-mascot"
            state={faceState}
            priority={2}
          />
          {contact.mixy && (
            <span className="agent-contact-badge" title={t('Representative bot')}>
              {/* A filled glyph: an outlined star blurs at badge size. */}
              <Star size={8} fill="currentColor" strokeWidth={0} aria-hidden="true" />
              <span className="sr-only">{t('Representative bot')}</span>
            </span>
          )}
        </span>
        {/* KakaoTalk layout, a 2×2 grid: name | time, then the preview (up
            to two lines) | status. The right column is reserved, so the
            preview never runs under the time or the badge. A name-only row
            (no messages, no status) has only the name, centred on the face. */}
        <span className="agent-chat-body agent-contact-body">
          <b className="agent-chat-title">{contact.name}</b>
          {preview && (
            <span id={`${describedBy}-preview`} className="agent-chat-preview">
              {preview}
            </span>
          )}
          {/* The right column: time over the one status. Without a status it
              sits on the name line; with one the pair centres on the row. */}
          {(contact.at > 0 || contact.indicator) && (
            <span className="agent-contact-aside" data-has-status={contact.indicator ? 'true' : undefined}>
              {contact.at > 0 && <time className="agent-chat-time">{agentChatTimeLabel(contact.at)}</time>}
              <AgentChatStatus indicator={contact.indicator} id={`${describedBy}-status`} attentionMark />
            </span>
          )}
        </span>
      </button>
    </li>
  );
}

/** The existing tree rows of one owner's sub-agents, under its messenger row.
 *  Open means the owner is in the expanded set; Arrow Left on a top
 *  sub-agent folds the owner again. */
function AgentSubtree({
  ownerId,
  nodes,
  session,
  expandedSessionIds,
  unreadSessionIds,
  setSessionExpanded,
  onPrefetchSession,
  onOpenLeadSession,
  onOpenSession,
}: {
  ownerId: string;
  nodes: readonly AgentActivityNode[];
  session?: Pick<DesktopSessionSummary, 'provider'>;
  expandedSessionIds: ReadonlySet<string>;
  unreadSessionIds?: ReadonlySet<string>;
  setSessionExpanded(sessionId: string, expanded: boolean): void;
  onPrefetchSession?(sessionId: string): void;
  onOpenLeadSession?(sessionId: string): void;
  onOpenSession?(sessionId: string, title: string, ownerSessionId: string): void;
}): React.ReactElement {
  return (
    <AgentActivityTree
      group={{ ownerId, nodes: subAgentNodes(ownerId, nodes), session }}
      label={t('Sub-agents')}
      groupExpanded
      expandedSessionIds={expandedSessionIds}
      onSetExpanded={setSessionExpanded}
      unreadSessionIds={unreadSessionIds}
      onCollapseGroup={() => setSessionExpanded(ownerId, false)}
      onPrefetchSession={onPrefetchSession}
      onOpenLeadSession={onOpenLeadSession}
      onOpenSession={onOpenSession}
    />
  );
}

/** Which owners and agents show their sub-agents. Collapsed by default; the
 *  expand-all command opens or folds every visible group, and sub-agents that
 *  wait on the user open their parent once as the wait begins (the user can
 *  fold it again). */
function useAgentSessionExpansion(
  allGroups: readonly AgentActivitySessionGroup[],
  hiddenOwnerIds: ReadonlySet<string>
) {
  const [expandedSessionIds, setExpandedSessionIds] = useState<ReadonlySet<string>>(() => new Set());
  const setSessionExpanded = (sessionId: string, expanded: boolean): void =>
    setExpandedSessionIds((current) => {
      if (current.has(sessionId) === expanded) return current;
      const next = new Set(current);
      if (expanded) next.add(sessionId);
      else next.delete(sessionId);
      return next;
    });
  useEffect(() => {
    const setAllExpanded = (event: Event): void => {
      const expanded = (event as CustomEvent<boolean>).detail;
      setExpandedSessionIds(expanded ? expandedAgentActivityIds(allGroups, hiddenOwnerIds) : new Set());
    };
    window.addEventListener(AGENT_GROUP_EXPANSION_EVENT, setAllExpanded);
    return () => window.removeEventListener(AGENT_GROUP_EXPANSION_EVENT, setAllExpanded);
  }, [allGroups, hiddenOwnerIds]);
  const autoOpened = useRef<Set<string>>(new Set());
  useEffect(() => {
    const waiting = new Set(
      allGroups
        // Only owners drawn as a messenger row (Lead, bot home): the older
        // owner groups keep their own fold.
        .filter(
          (group) =>
            (group.session.agentHome || !isAgentChatSession(group.ownerId)) &&
            subAgentsNeedAttention(group.ownerId, group.nodes)
        )
        .map((group) => group.ownerId)
    );
    for (const id of [...autoOpened.current]) if (!waiting.has(id)) autoOpened.current.delete(id);
    const fresh = [...waiting].filter((id) => !autoOpened.current.has(id));
    if (!fresh.length) return;
    for (const id of fresh) autoOpened.current.add(id);
    setExpandedSessionIds((current) => new Set([...current, ...fresh]));
  }, [allGroups]);
  return { expandedSessionIds, setSessionExpanded };
}

type OpenAgentSession = (sessionId: string, title: string, ownerSessionId: string, replaceKey?: string) => void;

/** Open a contact's home thread; resolves its session id ('' when it could
 *  not be opened, which a toast reports). */
async function openAgentContact(contact: AgentContact, onOpenSession: OpenAgentSession | undefined): Promise<string> {
  try {
    // The host stamps a home thread with its agent; a contact without one
    // yet asks the host, which resolves (and on first open creates) it.
    const sessionId =
      contact.session?.id ?? (await window.mixdogDesktop?.openAgentHome?.(contact.agentId))?.sessionId ?? '';
    if (sessionId) onOpenSession?.(sessionId, contact.name, sessionId);
    return sessionId;
  } catch (error) {
    showDesktopToast(
      t('Could not open {{name}}: {{error}}', { name: contact.name, error: errorMessageText(error) }),
      'error'
    );
    return '';
  }
}

type SubtreeProps = Omit<Parameters<typeof AgentSubtree>[0], 'ownerId' | 'nodes' | 'session'>;

/** The bots section: Mixy pinned on top past a divider, the other bots in the
 *  user's order (reorderable), each with its home thread's sub-agents folded
 *  under it. */
function AgentBotsSection({
  divider,
  mixyEmpty,
  onCreateMixy,
  contacts,
  homeNodes,
  selectedSessionId,
  subtreeProps,
  onOpenContact,
  onOpenMenu,
}: {
  divider: boolean;
  mixyEmpty: boolean;
  onCreateMixy(): void;
  contacts: AgentContact[];
  homeNodes: ReadonlyMap<string, readonly AgentActivityNode[]>;
  selectedSessionId: string;
  subtreeProps: SubtreeProps;
  onOpenContact(contact: AgentContact): Promise<string>;
  onOpenMenu(menu: ScmContextMenuState): void;
}) {
  const { expandedSessionIds, setSessionExpanded } = subtreeProps;
  const botList = usePaneBotReorder(contacts);
  const pinnedDividerAt = contacts.findIndex((contact) => !contact.mixy);
  return (
    <>
      {divider && <hr className="agent-chat-divider" aria-hidden="true" />}
      {mixyEmpty && contacts.length === 0 && <MixyEmptyState onCreate={onCreateMixy} />}
      <ul className="agent-contact-list" aria-label={t('Bots')} {...botList.listProps}>
        {contacts.map((contact, index) => {
          const homeId = contact.session?.id ?? '';
          const subNodes = homeId ? homeNodes.get(homeId) : undefined;
          const subOpen = expandedSessionIds.has(homeId);
          return (
            <Fragment key={contact.agentId}>
              {index > 0 && index === pinnedDividerAt && <li className="agent-contact-divider" aria-hidden="true" />}
              <AgentContactRow
                contact={contact}
                reorderProps={botList.rowProps(contact)}
                onReorderKey={contact.mixy ? undefined : (event) => botList.onKeyDown(contact, event)}
                subNodes={subNodes}
                subOpen={subOpen}
                onToggleSub={(next) => setSessionExpanded(homeId, next)}
                // The deterministic id: an empty home thread has no catalog row yet.
                selected={Boolean(selectedSessionId) && agentHomeSessionId(contact.agentId) === selectedSessionId}
                onOpen={(row) => void onOpenContact(row)}
                onOpenMenu={onOpenMenu}
                onProfile={(row) => void onOpenContact(row).then((sessionId) => openAgentProfile(sessionId))}
              />
              {subOpen && subNodes && subAgentNodes(homeId, subNodes).length > 0 && (
                <li className="agent-subtree" data-agent-subtree={homeId}>
                  <AgentSubtree
                    ownerId={homeId}
                    nodes={subNodes}
                    session={contact.session ?? undefined}
                    {...subtreeProps}
                  />
                </li>
              )}
            </Fragment>
          );
        })}
      </ul>
    </>
  );
}

const CONTACT_REFERENCE_KEYS = ['agents'] as const;

/** The agent catalog behind the contacts, re-read whenever a turn settles: a
 *  chat (Mixy's setup tool) may just have created or deleted an agent. */
function useContactAgents(active: boolean, sessions: readonly DesktopSessionSummary[]): unknown {
  const { values, refresh } = useSidebarReferences(window.mixdogDesktop, CONTACT_REFERENCE_KEYS, active);
  const working = sessions.filter((session) => session.working).length;
  const workingRef = useRef(working);
  useEffect(() => {
    const settled = working < workingRef.current;
    workingRef.current = working;
    if (settled && active) void refresh({ force: true });
  }, [active, refresh, working]);
  return values.agents;
}

export function AgentActivityPane({
  active,
  sessions,
  sessionsReady = true,
  selectedSessionId = '',
  headerActionSlot = null,
  unreadSessionIds,
  onPrefetchSession,
  onOpenLeadSession,
  onOpenSession,
  readComposerModel,
}: {
  active: boolean;
  /** The composer's current model, read when "+" opens a new agent. */
  readComposerModel?(): DesktopModelSelection | null;
  /** Retained for callers; the pane's actions show with or without a title. */
  showGroupActions?: boolean;
  sessions: readonly DesktopSessionSummary[];
  sessionsReady?: boolean;
  activeSessionIds?: readonly string[];
  /** The focused tab's session (the session sidebar's selection). */
  selectedSessionId?: string;
  /** The dock header's action row: search and "+" render there. */
  headerActionSlot?: HTMLElement | null;
  /** Recent-list unread set: an idle row whose session is unseen reads as
   *  "완료" until the session is actually opened. */
  unreadSessionIds?: ReadonlySet<string>;
  onPrefetchSession?(sessionId: string): void;
  onOpenLeadSession?(sessionId: string): void;
  onOpenSession?(sessionId: string, title: string, ownerSessionId: string, replaceKey?: string): void;
}): React.ReactElement {
  // Showing this page never opens or switches a tab: only a row click does.
  const mixyFirst = useMixyFirstPane(active);
  const poolStore = useMemo(() => agentPoolStore(window.mixdogDesktop), []);
  // Rows the user cleared ("Clear finished") stay out of every group.
  const agents = useVisibleAgentPool(
    useSyncExternalStore(poolStore.subscribe, poolStore.getSnapshot, poolStore.getSnapshot)
  );
  const { hiddenOwnerIds, hideGroup } = useHiddenAgentGroups();
  const orderRef = useRef<Map<string, number>>(new Map());
  useAgentPoolCadence(poolStore, active);
  const allGroups = useMemo(() => agentActivitySessionGroups(agents, sessions, orderRef), [agents, sessions]);
  const { expandedSessionIds, setSessionExpanded } = useAgentSessionExpansion(allGroups, hiddenOwnerIds);
  // A home thread's work belongs to its contact row, not to the work sessions.
  const { groups, homeNodes } = useMemo(() => splitAgentHomeGroups(allGroups), [allGroups]);
  const contactAgents = useContactAgents(active, sessions);
  const [menu, setMenu] = useState<ScmContextMenuState | null>(null);
  const [leadLookOpen, setLeadLookOpen] = useState(false);
  const [searching, setSearching] = useState(false);
  const [query, setQuery] = useState('');
  // The new-agent dialog, open with the model it starts on.
  const [creating, setCreating] = useState<{ route: DesktopModelSelection | null } | null>(null);
  const needle = searching ? query.trim().toLowerCase() : '';
  // The bot page lists every bot, a switched-off one too (shown as off).
  const contacts = useMemo(
    () => agentContacts(contactAgents, sessions, homeNodes, unreadSessionIds, { includeDisabled: true }),
    [contactAgents, homeNodes, sessions, unreadSessionIds]
  );
  // Sessions waiting on the user, a Lead's own approval or question included.
  const { needsUser } = useSessionAttentionIndex();
  const openContact = (contact: AgentContact): Promise<string> => openAgentContact(contact, onOpenSession);

  const botOrder = useBotOrder();
  const roomList = useAgentRoomRows(sessions, needle, unreadSessionIds);
  const loading = agents === null || (!sessionsReady && groups.length === 0);
  if (active) beginBootSurface('agent-activity', 'catalog');
  useEffect(() => {
    if (!loading) reportBootSurfaceReady('agent-activity', 'catalog');
  }, [loading]);
  if (loading)
    return (
      <div className="schedules-page agent-activity-page">
        <InitialSurface />
      </div>
    );
  // Local search over what the rows show: names and preview lines.
  const matches = (...texts: Array<string | undefined>) =>
    !needle ||
    texts.some((value) =>
      String(value || '')
        .toLowerCase()
        .includes(needle)
    );
  // Mixy stays on top, set apart by a hairline (no heading); the other bots
  // follow the user's order (shared with the Sessions sidebar, stored on the
  // host), new ones after it. With no order set yet: by latest conversation,
  // and one with none yet keeps its catalog place after them (the sort is stable).
  // The user's hidden groups; a search looks through everything, hidden or not.
  const userHidden = hiddenPaneGroups(botOrder);
  const hidden: ReadonlySet<PaneToggleId> = needle ? new Set() : userHidden;
  const shownContacts = applyBotOrder(
    contacts
      .filter(
        (contact) =>
          !(mixyFirst.empty && contact.mixy) &&
          !hidden.has(contact.mixy ? 'representative' : 'bots') &&
          matches(contact.name, contact.preview)
      )
      .sort((left, right) => Number(right.mixy) - Number(left.mixy) || right.at - left.at),
    botOrder
  );
  // The focused session's composer runs on its lane's model; a draft or the
  // engine snapshot answers otherwise.
  const composerRoute = () =>
    (selectedSessionId
      ? draftModelSelectionFromSnapshot(defaultSessionLaneStore.get(selectedSessionId) ?? EMPTY_SNAPSHOT)
      : null) ??
    readComposerModel?.() ??
    null;
  // The agent page lists agents and their chats only: an ordinary coding
  // session's work stays with that session (agent-created task sessions are
  // listed with the other sessions, not under their contact).
  const groupMatches = (group: (typeof groups)[number]): boolean =>
    matches(sessionDisplayTitle(group.session, ''), group.session.preview, group.session.lastMessagePreview);
  const visibleGroups = groups.filter(
    (group) => isAgentChatSession(group.ownerId) && !hiddenOwnerIds.has(group.ownerId) && groupMatches(group)
  );
  // Ordinary coding sessions whose Lead or any descendant works (or waits on
  // the user) now, one row each; a finished Lead stays, resting, for the
  // "Keep finished agents" window (1 hour by default, the pool's own window;
  // longer ones and pins are built from the session list, which outlives the
  // pool's rows). A task session a bot created is a Lead like any other: it
  // lists by its own title, never under the bot that created it.
  const leadSessionListed = (session: DesktopSessionSummary): boolean =>
    !isAgentChatSession(session.id) &&
    !session.archived &&
    !hiddenOwnerIds.has(session.id) &&
    matches(sessionDisplayTitle(session, ''), session.preview, session.lastMessagePreview);
  const leadRows = agentLeadRows(
    groups.filter((group) => leadSessionListed(group.session)),
    needsUser,
    {
      retainMs: retainWindowMs(retainChoice(botOrder)),
      pinned: pinnedLeadIds(botOrder),
      sessions: sessions.filter(leadSessionListed),
    }
  );
  const subtreeProps = {
    expandedSessionIds,
    unreadSessionIds,
    setSessionExpanded,
    onPrefetchSession,
    onOpenLeadSession,
    onOpenSession,
  };
  const openLeadMenu = (row: AgentLeadRow, point: { x: number; y: number }): void => {
    const group = groups.find((entry) => entry.ownerId === row.sessionId);
    const clearable = group ? clearableAgentTreeRows(group.nodes) : [];
    setMenu({
      label: t('Actions for {{title}}', { title: row.title }),
      ...point,
      items: [
        ...(row.hasSubAgents
          ? [subtreeMenuItem(expandedSessionIds.has(row.sessionId), (next) => setSessionExpanded(row.sessionId, next))]
          : []),
        {
          id: row.pinned ? 'unpin-lead' : 'pin-lead',
          label: row.pinned ? t('Unpin') : t('Pin'),
          onSelect: () => setLeadPinned(row.sessionId, !row.pinned),
        },
        { id: 'lead-appearance', label: t('Appearance'), onSelect: () => setLeadLookOpen(true) },
        { id: 'hide-agent-group', label: t('Hide this group'), onSelect: () => hideGroup(row.sessionId) },
        {
          id: 'clear-finished-agents',
          label: t('Clear finished'),
          disabled: clearable.length === 0,
          onSelect: () => dismissFinishedAgentRows(clearable),
        },
      ],
    });
  };
  // Without a representative bot the page shows only its create prompt: no Leads.
  const shownLeadRows = mixyFirst.empty ? [] : leadRows;
  const workCount = visibleGroups.length;
  const present: Record<PaneSectionId, boolean> = {
    bots: shownContacts.length > 0 || (mixyFirst.empty && !hidden.has('representative')),
    rooms: roomList.rows.length > 0 && !hidden.has('rooms'),
    agents: (workCount > 0 || shownLeadRows.length > 0) && !hidden.has('agents'),
  };
  const allHidden = PANE_GROUP_IDS.every((id) => hidden.has(id));
  // The three sections below the pinned Mixy row, in the user's order (shared
  // with the bot order). A hairline sits above every present section that has
  // a present one before it, so empty sections leave no double or missing line.
  const arrangeSections = (blocks: Record<PaneSectionId, (divider: boolean) => React.ReactNode>) => (
    <ArrangedSections order={paneSectionOrder(botOrder)} present={present} blocks={blocks} />
  );
  // The Sessions header's action classes; "+" is rightmost, as on every
  // page: search, ⋯, +.
  const headerActions = (
    <AgentPaneHeaderActions
      searching={searching}
      mixyEmpty={mixyFirst.empty}
      onToggleSearch={() => {
        setSearching((value) => !value);
        setQuery('');
      }}
      hiddenGroups={userHidden}
      onToggleGroup={setGroupHidden}
      retain={retainChoice(botOrder)}
      onRetain={setRetainChoice}
      onCreateMixy={() => mixyFirst.openMixyDialog()}
      onNewAgent={() => setCreating({ route: composerRoute() })}
      onOpenSession={onOpenSession}
    />
  );
  return (
    <div className="schedules-page agent-activity-page">
      {headerActionSlot ? (
        createPortal(headerActions, headerActionSlot)
      ) : (
        <div className="agent-group-toolbar session-panel-header-actions">{headerActions}</div>
      )}
      {searching && (
        <input
          className="agent-pane-search"
          type="search"
          // biome-ignore lint/a11y/noAutofocus: the search button opens this field to type into
          autoFocus
          value={query}
          placeholder={t('Search')}
          aria-label={t('Search')}
          onChange={(event) => setQuery(event.currentTarget.value)}
          onKeyDown={(event) => {
            if (event.key === 'Escape') setSearching(false);
          }}
        />
      )}
      {creating && (
        <Suspense fallback={null}>
          <AgentCreateDialog
            initialRoute={creating.route}
            onClose={() => setCreating(null)}
            onCreated={(sessionId, name) => onOpenSession?.(sessionId, name, sessionId)}
          />
        </Suspense>
      )}
      {mixyFirst.creatingMixy && (
        <Suspense fallback={null}>
          <AgentCreateDialog
            representative
            initialRoute={composerRoute()}
            onClose={() => mixyFirst.closeMixyDialog()}
            onCreated={(sessionId, name) => onOpenSession?.(sessionId, name, sessionId)}
          />
        </Suspense>
      )}
      {allHidden && (
        <p className="utility-dock-empty agent-activity-empty">
          <span>{t('All groups are hidden')}</span>
        </p>
      )}
      {arrangeSections({
        bots: (divider) =>
          !(hidden.has('bots') && hidden.has('representative')) && (
            <AgentBotsSection
              divider={divider}
              mixyEmpty={mixyFirst.empty && !hidden.has('representative')}
              onCreateMixy={() => mixyFirst.openMixyDialog()}
              contacts={shownContacts}
              homeNodes={homeNodes}
              selectedSessionId={selectedSessionId}
              subtreeProps={subtreeProps}
              onOpenContact={openContact}
              onOpenMenu={setMenu}
            />
          ),
        rooms: (divider) =>
          !hidden.has('rooms') && (
            <AgentRoomsSection
              rows={roomList.rows}
              label={roomList.label}
              divider={divider}
              selectedSessionId={selectedSessionId}
              onOpenSession={onOpenSession}
            />
          ),
        // The agent sessions: the work-session groups and the Leads, one unnamed section.
        agents: (divider) =>
          !hidden.has('agents') && (
            <>
              {divider && workCount > 0 && <hr className="agent-chat-divider" aria-hidden="true" />}
              {/* Work sessions follow the contacts after a hairline, no heading. With
          contacts present, no work shows nothing at all; the centred empty
          state is only for a pane with neither. */}
              {visibleGroups.length === 0 && contacts.length === 0 && !mixyFirst.empty && (
                <p className="utility-dock-empty agent-activity-empty">
                  <span>{t('No bots.')}</span>
                </p>
              )}
              {visibleGroups.map((group) => (
                <AgentActivityGroup
                  key={group.ownerId}
                  group={group}
                  expandedSessionIds={expandedSessionIds}
                  unreadSessionIds={unreadSessionIds}
                  setSessionExpanded={setSessionExpanded}
                  hideGroup={hideGroup}
                  onOpenMenu={setMenu}
                  onPrefetchSession={onPrefetchSession}
                  onOpenLeadSession={onOpenLeadSession}
                  onOpenSession={onOpenSession}
                />
              ))}
              {leadLookOpen && <LeadAppearanceDialog onClose={() => setLeadLookOpen(false)} />}
              {/* Without a representative bot the page shows only its create prompt. */}
              <AgentLeadRows
                rows={shownLeadRows}
                divider={divider || workCount > 0}
                selectedSessionId={selectedSessionId}
                onOpen={(sessionId) => onOpenLeadSession?.(sessionId)}
                onOpenMenu={openLeadMenu}
                expandedIds={expandedSessionIds}
                onToggleExpanded={setSessionExpanded}
                renderSubtree={(sessionId) => {
                  const group = groups.find((entry) => entry.ownerId === sessionId);
                  return group ? (
                    <AgentSubtree ownerId={sessionId} nodes={group.nodes} session={group.session} {...subtreeProps} />
                  ) : null;
                }}
              />
            </>
          ),
      })}
      <ScmContextMenu state={menu} onClose={() => setMenu(null)} />
      {/* The pane's foot, above 시작 가이드: opens Extensions → 커넥터. */}
      {!mixyFirst.empty && !userHidden.has('connectors') && <ConnectorsPill />}
    </div>
  );
}
