import { Bot, ChevronRight, CircleX } from 'lucide-react';
import type React from 'react';
import { memo, useEffect, useId, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { InitialSurface } from './InitialSurface';
import { AGENT_GROUP_EXPANSION_EVENT, AgentGroupsMenu, useHiddenAgentGroups } from './agent-group-visibility';
import { RowOverflowMenu, rowOverflowHostProps } from './RowOverflowMenu';
import { beginBootSurface, reportBootSurfaceReady } from './boot-metrics';
import type { DesktopAgentPoolRow, DesktopSessionSummary } from '../shared/contract';
import { desktopAgentActivityState, type DesktopAgentActivityState } from '../shared/agent-activity';
import { sessionSummaryTitle } from '../shared/session-title.mjs';
import { t } from './i18n';
import { agentElapsedText } from './agent-row-meta';
import { useClock } from './use-clock';
import { clearableAgentTreeRows, dismissFinishedAgentRows, useVisibleAgentPool } from './agent-dismiss';
import { AgentProviderMark, AgentRouteSummary, useSessionDragSource } from './agent-row-parts';
import {
  type AgentChatIndicator,
  agentChatElapsed,
  agentChatTimeLabel,
  agentFailureText,
  agentNodeState,
  agentRowName,
  agentSessionChatSummary,
} from './agent-chat-summary';
import { ProgressSpinner } from './ProgressSpinner';
import { timeMs } from './transcript-primitives';
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

/** The row's right-column text; `compact` (the Agents list) keeps a running
 *  clock to its largest unit. */
function AgentRowElapsed({
  state,
  agent,
  clock,
  compact = false,
}: {
  state: DesktopAgentActivityState;
  agent: DesktopAgentPoolRow;
  clock?: number;
  compact?: boolean;
}): React.ReactElement {
  const now = useRowClock(state, clock);
  const turn = timeMs(agent.turnStartedAt);
  const elapsed =
    compact && turn && (state === 'running' || state === 'waiting')
      ? agentChatElapsed(now - turn)
      : agentElapsedText(state, agent, now);
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

/** The row's single trailing status (see AgentChatIndicator). */
function AgentChatStatus({ indicator, id }: { indicator: AgentChatIndicator; id: string }) {
  if (!indicator) return null;
  if (indicator.kind === 'attention') {
    return (
      <span id={id} className="agent-chat-status" data-kind="attention">
        {t('Needs attention')}
      </span>
    );
  }
  if (indicator.kind === 'error') {
    return (
      <span id={id} className="agent-chat-status" data-kind="error">
        <CircleX size={14} aria-hidden="true" />
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
      {indicator.count}
    </span>
  );
}

/** A session row's time: the running turn's elapsed while it works, otherwise
 *  the moment the group last started or settled work. */
function AgentChatTime({ lead, live, at }: { lead: DesktopAgentPoolRow | null; live: boolean; at: number }) {
  const ticking = live && Boolean(lead && timeMs(lead.turnStartedAt));
  const now = useClock(ticking);
  const text = ticking && lead ? agentChatElapsed(now - timeMs(lead.turnStartedAt)) : agentChatTimeLabel(at);
  return (
    <time className="agent-chat-time" data-live={ticking ? 'true' : undefined}>
      {text}
    </time>
  );
}

/** The twisty painted before the title of a row with agents below it. */
function AgentChatTwisty({ expanded }: { expanded: boolean }) {
  return (
    <span className="agent-chat-twisty" data-expanded={expanded ? 'true' : undefined} aria-hidden="true">
      <ChevronRight size={12} />
    </span>
  );
}

/** The twisty's hit area: a transparent button laid over the twisty and the
 *  avatar edge (no width of its own). Arrow keys on the row do the same; the
 *  button stays out of the tab order. */
function AgentChatToggle({
  expanded,
  label,
  leadSessionId,
  onToggle,
}: {
  expanded: boolean;
  label: string;
  leadSessionId?: string;
  onToggle(): void;
}) {
  return (
    <button
      type="button"
      className="agent-chat-toggle"
      tabIndex={-1}
      aria-label={`${expanded ? t('Fold') : t('Unfold')}: ${label}`}
      aria-expanded={expanded}
      data-lead-session-id={leadSessionId}
      onClick={onToggle}
    />
  );
}

const AGENT_TREE_KEYS = new Set(['ArrowDown', 'ArrowUp', 'ArrowLeft', 'ArrowRight', 'Home', 'End']);

type AgentChatTreeItem = {
  roving: { tabIndex: number; onFocus(): void };
  level: number;
};

/** One child agent: a compact row of the same shell, with its role/tag, model
 *  route, lifecycle and elapsed. */
function AgentMemberRow({
  node,
  ownerSessionId,
  state,
  expanded,
  item,
  onToggle,
  onPrefetchSession,
  onOpenSession,
}: {
  node: AgentActivityNode;
  ownerSessionId: string;
  state: DesktopAgentActivityState;
  expanded: boolean;
  item: AgentChatTreeItem;
  onToggle(): void;
  onPrefetchSession?(sessionId: string): void;
  onOpenSession?(sessionId: string, title: string, ownerSessionId: string): void;
}) {
  const { agent, sessionId } = node;
  const name = agentRowName(agent, false);
  const tabTitle = agentTabTitle(agent, agentRoleLabel(agent.agent || agent.tag));
  const hasChildren = node.children.length > 0;
  const { dragProps, clickSuppressed } = useSessionDragSource(sessionId, tabTitle);
  const prefetch = () => {
    if (sessionId) onPrefetchSession?.(sessionId);
  };
  return (
    <div
      className="agent-chat-row"
      data-kind="agent"
      role="none"
      style={{ '--agent-chat-depth': item.level - 2 } as React.CSSProperties}
    >
      <button
        type="button"
        className="agent-chat-row-main agent-pool-row"
        data-agent-tag={agent.tag || undefined}
        data-agent-session-id={sessionId || undefined}
        data-agent-parent-session-id={node.parentSessionId || undefined}
        data-agent-depth={item.level - 1}
        role="treeitem"
        aria-level={item.level}
        aria-posinset={node.posInSet}
        aria-setsize={node.setSize}
        aria-expanded={hasChildren ? expanded : undefined}
        aria-label={name}
        tabIndex={item.roving.tabIndex}
        disabled={!sessionId}
        {...dragProps}
        onPointerEnter={prefetch}
        onFocus={() => {
          item.roving.onFocus();
          prefetch();
        }}
        onPointerDown={prefetch}
        onClick={() => {
          if (!sessionId || clickSuppressed()) return;
          onOpenSession?.(sessionId, tabTitle, ownerSessionId);
        }}
      >
        <span className="agent-chat-avatar">
          <AgentProviderMark agent={agent} size={14} />
        </span>
        <span className="agent-chat-body">
          <span className="agent-chat-line">
            {hasChildren && <AgentChatTwisty expanded={expanded} />}
            <b className="agent-chat-title agent-pool-name">{name}</b>
            <AgentRowElapsed state={state} agent={agent} compact />
          </span>
          <span className="agent-chat-line">
            {state === 'failed' ? (
              <small className="agent-chat-preview" data-state="failed">
                {agentFailureText(agent)}
              </small>
            ) : (
              <AgentRouteSummary agent={agent} />
            )}
          </span>
        </span>
      </button>
      {hasChildren && <AgentChatToggle expanded={expanded} label={name} onToggle={onToggle} />}
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

/** One Lead session as a messenger row — avatar, bold title, time, a preview
 *  of what it is doing and one status — with its agents folded beneath it as
 *  compact rows of the same shell. The group is one ARIA tree: roving tab
 *  focus, Arrow Up/Down through the painted rows, Arrow Right/Left to open,
 *  close and climb, Home/End to its ends. Every `aria-expanded` reports what
 *  the surface actually paints. Right-click, Menu/Shift+F10 and a touch
 *  long-press open the row's overflow menu. */
function AgentChatGroup({
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
}): React.ReactElement {
  const { ownerId } = group;
  const title = sessionSummaryTitle(group.session, t('Untitled session'));
  const treeRef = useRef<HTMLDivElement | null>(null);
  const [focusedSessionId, setFocusedSessionId] = useState('');
  const describedBy = useId();
  const lead = group.nodes.find((node) => node.sessionId === ownerId) ?? null;
  // Under a Lead row its children are the members; without one the top rows are.
  const members = lead ? lead.children : group.nodes;
  const levelOffset = lead ? 1 : 2;
  const groupExpanded = expandedSessionIds.has(ownerId);
  const summary = useMemo(
    () => agentSessionChatSummary(ownerId, group.nodes, unreadSessionIds),
    [group.nodes, ownerId, unreadSessionIds]
  );
  const rows = useMemo(
    () => (groupExpanded ? visibleAgentTreeRows(members, expandedSessionIds) : []),
    [expandedSessionIds, groupExpanded, members]
  );
  const rowIds = [ownerId, ...rows.map((node) => node.sessionId)];
  const activeIndex = Math.max(0, rowIds.indexOf(focusedSessionId));
  const avatarAgent = lead?.agent ?? group.agents[0];
  const { dragProps, clickSuppressed } = useSessionDragSource(ownerId, title);
  const setGroupExpanded = (expanded: boolean) => setSessionExpanded(ownerId, expanded);
  const focusRow = (index: number): void => {
    const id = rowIds[Math.min(Math.max(index, 0), rowIds.length - 1)];
    if (!id) return;
    setFocusedSessionId(id);
    treeRef.current?.querySelector<HTMLElement>(`[data-agent-session-id="${id}"]`)?.focus();
  };
  const setRowExpanded = (sessionId: string, expanded: boolean): void => {
    setFocusedSessionId(sessionId);
    setSessionExpanded(sessionId, expanded);
  };
  const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>): void => {
    if (!AGENT_TREE_KEYS.has(event.key)) return;
    if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
    const origin = (event.target as HTMLElement | null)?.closest<HTMLElement>('[role="treeitem"]');
    if (!origin) return;
    const found = rowIds.indexOf(origin.dataset.agentSessionId || '');
    const index = found >= 0 ? found : activeIndex;
    event.preventDefault();
    const moves: Partial<Record<string, number>> = {
      ArrowDown: index + 1,
      ArrowUp: index - 1,
      Home: 0,
      End: rowIds.length - 1,
    };
    const target = moves[event.key];
    if (target !== undefined) {
      focusRow(target);
      return;
    }
    const node = index > 0 ? rows[index - 1] : undefined;
    if (!node) {
      // The session row: its fold is the whole group's.
      if (event.key === 'ArrowLeft') {
        if (groupExpanded) setRowExpanded(ownerId, false);
      } else if (!groupExpanded) {
        if (members.length > 0) setRowExpanded(ownerId, true);
      } else focusRow(1);
      return;
    }
    const hasChildren = node.children.length > 0;
    const expanded = expandedSessionIds.has(node.sessionId);
    if (event.key === 'ArrowRight') {
      if (!hasChildren) return;
      // Expanded: its first child is the next row in depth-first order.
      if (expanded) focusRow(index + 1);
      else setRowExpanded(node.sessionId, true);
      return;
    }
    if (hasChildren && expanded) {
      setRowExpanded(node.sessionId, false);
      return;
    }
    // Climb to the parent row; a top member's parent is the session row.
    focusRow(Math.max(0, rowIds.indexOf(node.parentSessionId)));
  };
  const roving = (sessionId: string, index: number) => ({
    tabIndex: index === activeIndex ? 0 : -1,
    onFocus: () => setFocusedSessionId(sessionId),
  });
  const clearable = clearableAgentTreeRows(group.nodes);
  const prefetch = () => onPrefetchSession?.(ownerId);
  return (
    <section className="agent-chat-group" data-agent-owner-session-id={ownerId}>
      <div ref={treeRef} className="agent-chat-tree" role="tree" aria-label={title} onKeyDown={onKeyDown}>
        <div className="agent-chat-row" data-kind="session" role="none" {...rowOverflowHostProps()}>
          <button
            type="button"
            className="agent-chat-row-main agent-pool-row"
            data-agent-tag={lead?.agent.tag || undefined}
            data-agent-session-id={ownerId}
            data-agent-depth={0}
            data-state={summary.state}
            role="treeitem"
            aria-level={1}
            aria-posinset={1}
            aria-setsize={1}
            aria-expanded={members.length > 0 ? groupExpanded : undefined}
            aria-label={title}
            aria-describedby={`${describedBy}-preview ${describedBy}-status`}
            tabIndex={activeIndex === 0 ? 0 : -1}
            {...dragProps}
            onPointerEnter={prefetch}
            onFocus={() => {
              setFocusedSessionId(ownerId);
              prefetch();
            }}
            onPointerDown={prefetch}
            onClick={() => {
              if (!clickSuppressed()) onOpenLeadSession?.(ownerId);
            }}
          >
            <span className="agent-chat-avatar">
              <AgentProviderMark agent={avatarAgent} size={20} />
            </span>
            <span className="agent-chat-body">
              <span className="agent-chat-line">
                {members.length > 0 && <AgentChatTwisty expanded={groupExpanded} />}
                <b className="agent-chat-title">{title}</b>
                <AgentChatTime
                  lead={lead?.agent ?? null}
                  live={summary.state === 'running' || summary.state === 'waiting'}
                  at={group.stamp}
                />
              </span>
              <span className="agent-chat-line">
                <span id={`${describedBy}-preview`} className="agent-chat-preview">
                  <span className="agent-chat-state" data-state={summary.state}>
                    {summary.stateText}
                  </span>
                  {summary.preview.slice(summary.stateText.length)}
                </span>
                <AgentChatStatus indicator={summary.indicator} id={`${describedBy}-status`} />
              </span>
            </span>
          </button>
          {members.length > 0 && (
            <AgentChatToggle
              expanded={groupExpanded}
              label={title}
              leadSessionId={ownerId}
              onToggle={() => setGroupExpanded(!groupExpanded)}
            />
          )}
          <RowOverflowMenu
            label={t('Actions for {{title}}', { title })}
            items={[
              {
                id: 'open-agent-session',
                label: t('Open in tab'),
                onSelect: () => onOpenLeadSession?.(ownerId),
              },
              {
                id: 'hide-agent-group',
                label: t('Hide this group'),
                separatorBefore: true,
                onSelect: () => hideGroup(ownerId),
              },
              {
                id: 'clear-finished-agents',
                label: t('Clear finished'),
                disabled: clearable.length === 0,
                onSelect: () => {
                  dismissFinishedAgentRows(clearableAgentTreeRows(group.nodes));
                },
              },
            ]}
          />
        </div>
        {rows.map((node, index) => (
          <AgentMemberRow
            key={poolRowKey(node.agent, index)}
            node={node}
            ownerSessionId={ownerId}
            state={agentNodeState(node, unreadSessionIds)}
            expanded={expandedSessionIds.has(node.sessionId)}
            item={{ roving: roving(node.sessionId, index + 1), level: node.depth + levelOffset }}
            onToggle={() => setRowExpanded(node.sessionId, !expandedSessionIds.has(node.sessionId))}
            onPrefetchSession={onPrefetchSession}
            onOpenSession={onOpenSession}
          />
        ))}
      </div>
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
      {visibleGroups.map((group) => (
        <AgentChatGroup
          key={group.ownerId}
          group={group}
          expandedSessionIds={expandedSessionIds}
          unreadSessionIds={unreadSessionIds}
          setSessionExpanded={setSessionExpanded}
          hideGroup={hideGroup}
          onPrefetchSession={onPrefetchSession}
          onOpenLeadSession={onOpenLeadSession}
          onOpenSession={onOpenSession}
        />
      ))}
    </div>
  );
}
