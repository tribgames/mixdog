// The Bots page's work-session groups: a Lead's group with its pool rows and sub-agent tree, the live rows' status marks and the session-group bookkeeping that keeps them from shuffling (AgentActivityPane.tsx composes the page).
import { ChevronDown, ChevronRight } from 'lucide-react';
import type React from 'react';
import { memo, useEffect, useMemo, useRef, useState } from 'react';
import { type ScmContextMenuState, contextMenuRowProps } from './ScmContextMenu';
import type { DesktopAgentPoolRow, DesktopSessionSummary } from '../shared/contract';
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
import { AgentTodoMark } from './AgentTodoMark';
import { clearableAgentTreeRows, dismissFinishedAgentRows } from './agent-dismiss';
import { AgentProviderMark, AgentRouteSummary, useSessionDragSource } from './agent-row-parts';
import { type AgentChatIndicator, agentRowName } from './agent-chat-summary';
import { ProgressSpinner } from './ProgressSpinner';
import { SessionAttentionGlyph } from './session-status-mark';
import { TextShimmer } from './transcript-primitives';
import {
  agentActivityGroups,
  type agentPoolStore,
  agentRoleLabel,
  flattenAgentActivityNodes,
  poolRowKey,
  startAgentPool,
  stickyGroupOrder,
  visibleAgentTreeRows,
} from './agent-activity-model';
import type { AgentActivityNode } from './agent-activity-model';

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
      <AgentProviderMark agent={{ provider: agent.provider || (lead ? fallbackProvider : undefined) || null }} />
      <span className="schedules-row-copy">
        <span className="agent-pool-heading">
          <b className="agent-pool-name">{name}</b>
          {lead && descendantCount > 0 && <span className="dock-review-count">{descendantCount}</span>}
          <AgentTodoMark todo={agent.todo} />
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

export function AgentChatStatus({
  indicator,
  id,
  attentionMark = false,
  name = '',
  approvals = 1,
  asking = false,
}: {
  indicator: AgentChatIndicator;
  id: string;
  attentionMark?: boolean;
  name?: string;
  approvals?: number;
  asking?: boolean;
}) {
  if (!indicator) return null;
  if (indicator.kind === 'attention' && attentionMark) {
    return (
      <span id={id} className="agent-chat-status" data-kind="attention-mark">
        <SessionAttentionGlyph
          status={asking ? 'asking' : 'needs-you'}
          name={name}
          size={14}
          className="agent-chat-attention"
          count={approvals}
        />
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

export function AgentActivityTree({
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
  const activeIndex = Math.max(focusedIndex, 0);
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

/** The pool is pushed (section `agentPool`): the surface only starts listening. */
export function useAgentPoolCadence(poolStore: ReturnType<typeof agentPoolStore>): void {
  useEffect(() => {
    startAgentPool(poolStore);
  }, [poolStore]);
}

/** Groups whose owner session still exists, newest first. Rebuilt each pass so
 *  departed sessions drop out; surviving groups carry their stamp forward,
 *  which is what keeps live rows from shuffling. */
export function agentActivitySessionGroups(
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

export type AgentActivitySessionGroup = ReturnType<typeof agentActivitySessionGroups>[number];

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
export function expandedAgentActivityIds(
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
export function AgentActivityGroup({
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
