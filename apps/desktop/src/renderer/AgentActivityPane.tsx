import { Bot, ChevronDown, ChevronRight } from 'lucide-react';
import type React from 'react';
import { memo, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { InitialSurface } from './InitialSurface';
import { AGENT_GROUP_EXPANSION_EVENT, AgentGroupsMenu, useHiddenAgentGroups } from './agent-group-visibility';
import { RowOverflowMenu, rowOverflowHostProps } from './RowOverflowMenu';
import { beginBootSurface, reportBootSurfaceReady } from './boot-metrics';
import { beginPaneDrag, finishPaneDrag, type PaneDragSession } from './pane-drag-session';
import type { DesktopAgentPoolRow, DesktopSessionSummary } from '../shared/contract';
import {
  desktopAgentActivityState,
  hasPendingDesktopAgentWork,
  type DesktopAgentActivityState,
} from '../shared/agent-activity';
import { sessionSummaryTitle } from '../shared/session-title.mjs';
import { t } from './i18n';
import { agentElapsedText } from './agent-row-meta';
import { useClock } from './use-clock';
import { clearableAgentTreeRows, dismissFinishedAgentRows, useVisibleAgentPool } from './agent-dismiss';
import { AgentProviderMark, AgentRouteSummary } from './agent-row-parts';
import { TextShimmer } from './transcript-primitives';
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
  onPrefetchSession,
  onOpenLeadSession,
  onOpenSession,
}: {
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
  const tag = String(agent.tag || '').trim();
  const sessionTitle = String(agent.title || '').trim();
  const name = !lead && tag && tag.toLowerCase() !== role.toLowerCase() ? `${role} · ${tag}` : role;
  const tabTitle =
    tag && tag.toLowerCase() !== sessionTitle.toLowerCase()
      ? [sessionTitle, tag].filter(Boolean).join(' · ')
      : sessionTitle || tag || role;
  const prefetch = () => {
    if (sessionId) onPrefetchSession?.(lead ? ownerSessionId : sessionId);
  };
  const [dragging, setDragging] = useState(false);
  // A settled native drag must not also fire the row's open click.
  const suppressClick = useRef(false);
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
      // Every row with a session is a pane source, exactly like a sidebar
      // session row: dropping it inside a pane opens the session as a tab and
      // dropping it on a pane edge splits a new pane there.
      draggable={Boolean(sessionId)}
      data-dragging={dragging ? 'true' : undefined}
      onPointerEnter={prefetch}
      onFocus={prefetch}
      onPointerDown={prefetch}
      onDragStart={(event) => {
        if (!sessionId) {
          event.preventDefault();
          return;
        }
        const drag: PaneDragSession = {
          kind: 'session',
          key: `session:${sessionId}`,
          title: tabTitle,
          selection: { kind: 'session', id: sessionId, title: tabTitle },
        };
        // The gesture settles in the global drag session, so this cleanup still
        // runs when the pool retires this row mid-drag.
        beginPaneDrag(
          event.nativeEvent,
          drag,
          event.currentTarget,
          () => {
            setDragging(false);
            suppressClick.current = true;
            window.setTimeout(() => {
              suppressClick.current = false;
            }, 0);
            delete document.body.dataset.tabDragging;
          },
          // The row's own frame follows the pointer, not a tab ghost.
          'frame'
        );
        setDragging(true);
        document.body.dataset.tabDragging = '1';
      }}
      onDragEnd={() => {
        finishPaneDrag();
      }}
      onClick={() => {
        if (!sessionId || suppressClick.current) return;
        if (lead) onOpenLeadSession?.(ownerSessionId);
        else onOpenSession?.(sessionId, tabTitle, ownerSessionId);
      }}
    >
      {/* The brand of the model the agent runs on marks the row, as in the
      Workflows panel (user: 에이전트 창은 이번 적용 안 된 거?). */}
      <AgentProviderMark agent={agent} />
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
  group: { ownerId: string; nodes: readonly AgentActivityNode[] };
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
      return session ? [{ ...group, session }] : [];
    })
    .sort((left, right) => {
      const leftTime = order.get(left.ownerId) || 0;
      const rightTime = order.get(right.ownerId) || 0;
      return rightTime - leftTime || left.ownerId.localeCompare(right.ownerId);
    });
}

type AgentActivitySessionGroup = ReturnType<typeof agentActivitySessionGroups>[number];

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

function renderAgentActivityGroup({
  group,
  expandedSessionIds,
  unreadSessionIds,
  setSessionExpanded,
  hideGroup,
  onPrefetchSession,
  onOpenLeadSession,
  onOpenSession,
}: {
  group: AgentActivitySessionGroup;
  expandedSessionIds: ReadonlySet<string>;
  unreadSessionIds?: ReadonlySet<string>;
  setSessionExpanded(sessionId: string, expanded: boolean): void;
  hideGroup(ownerId: string): void;
  onPrefetchSession?(sessionId: string): void;
  onOpenLeadSession?(sessionId: string): void;
  onOpenSession?(sessionId: string, title: string, ownerSessionId: string): void;
}) {
  const title = sessionSummaryTitle(group.session, t('Untitled session'));
  const expanded = expandedSessionIds.has(group.ownerId);
  // Any agent of the group still working — the Lead or a descendant — makes
  // the session name shimmer, so a folded group still reads as live.
  const working = group.agents.some((agent) => desktopAgentActivityState(agent) === 'running');
  const setGroupCollapsed = (collapsed: boolean): void => setSessionExpanded(group.ownerId, !collapsed);
  return (
    <section key={group.ownerId} className="workflows-models" data-agent-owner-session-id={group.ownerId}>
      <div className="workflows-section-head" {...rowOverflowHostProps()}>
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
        <RowOverflowMenu
          label={t('Actions for {{title}}', { title })}
          items={[
            {
              id: 'hide-agent-group',
              label: t('Hide this group'),
              onSelect: () => hideGroup(group.ownerId),
            },
            {
              id: 'clear-finished-agents',
              label: t('Clear finished'),
              disabled: clearableAgentTreeRows(group.nodes).length === 0,
              onSelect: () => {
                dismissFinishedAgentRows(clearableAgentTreeRows(group.nodes));
              },
            },
          ]}
        />
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

export function AgentActivityPane({
  active,
  showGroupActions = false,
  sessions,
  sessionsReady = true,
  unreadSessionIds,
  onPrefetchSession,
  onOpenLeadSession,
  onOpenSession,
}: {
  active: boolean;
  showGroupActions?: boolean;
  sessions: readonly DesktopSessionSummary[];
  sessionsReady?: boolean;
  activeSessionIds?: readonly string[];
  /** Recent-list unread set: an idle row whose session is unseen reads as
   *  "완료" until the session is actually opened. */
  unreadSessionIds?: ReadonlySet<string>;
  onPrefetchSession?(sessionId: string): void;
  onOpenLeadSession?(sessionId: string): void;
  onOpenSession?(sessionId: string, title: string, ownerSessionId: string): void;
}): React.ReactElement {
  const poolStore = useMemo(() => agentPoolStore(window.mixdogDesktop), []);
  // Rows the user cleared ("Clear finished") stay out of every group.
  const agents = useVisibleAgentPool(
    useSyncExternalStore(poolStore.subscribe, poolStore.getSnapshot, poolStore.getSnapshot)
  );
  const [expandedSessionIds, setExpandedSessionIds] = useState<ReadonlySet<string>>(() => new Set());
  const setSessionExpanded = (sessionId: string, expanded: boolean): void =>
    setExpandedSessionIds((current) => {
      if (current.has(sessionId) === expanded) return current;
      const next = new Set(current);
      if (expanded) next.add(sessionId);
      else next.delete(sessionId);
      return next;
    });
  const { hiddenOwnerIds, hideGroup } = useHiddenAgentGroups();
  const orderRef = useRef<Map<string, number>>(new Map());
  useAgentPoolCadence(poolStore, active);
  const groups = useMemo(() => agentActivitySessionGroups(agents, sessions, orderRef), [agents, sessions]);
  useEffect(() => {
    const setAllExpanded = (event: Event): void => {
      const expanded = (event as CustomEvent<boolean>).detail;
      setExpandedSessionIds(expanded ? expandedAgentActivityIds(groups, hiddenOwnerIds) : new Set());
    };
    window.addEventListener(AGENT_GROUP_EXPANSION_EVENT, setAllExpanded);
    return () => window.removeEventListener(AGENT_GROUP_EXPANSION_EVENT, setAllExpanded);
  }, [groups, hiddenOwnerIds]);

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
  const visibleGroups = groups.filter((group) => !hiddenOwnerIds.has(group.ownerId));
  return (
    <div className="schedules-page agent-activity-page">
      {showGroupActions && (
        <div className="agent-group-toolbar">
          <AgentGroupsMenu />
        </div>
      )}
      {visibleGroups.length === 0 && (
        <p className="schedules-empty agent-activity-empty">
          <Bot size={28} aria-hidden="true" />
          <span>{groups.length > 0 ? t('All agent groups are hidden.') : t('No agents are running.')}</span>
        </p>
      )}
      {visibleGroups.map((group) =>
        renderAgentActivityGroup({
          group,
          expandedSessionIds,
          unreadSessionIds,
          setSessionExpanded,
          hideGroup,
          onPrefetchSession,
          onOpenLeadSession,
          onOpenSession,
        })
      )}
    </div>
  );
}
