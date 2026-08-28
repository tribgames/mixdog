import { Bot, ChevronDown, ChevronRight } from 'lucide-react';
import React, { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';

import type { DesktopAgentPoolRow, DesktopApi, DesktopSessionSummary } from '../shared/contract';
import {
  createDesktopCancellationLedger,
  desktopAgentActivityState,
  desktopAgentCancelStatus,
  desktopAgentIdentity,
  desktopAgentStatus,
  isActiveDesktopAgentEntry,
  isCancelUnconfirmedDesktopAgentEntry,
  isCancelledDesktopAgentEntry,
  isQueuedDesktopAgentEntry,
  type DesktopAgentActivityState,
  type DesktopAgentCancellationLedger,
} from '../shared/agent-activity';
import { sessionSummaryTitle } from '../shared/session-title.mjs';
import { t } from './i18n';
import { ProgressSpinner } from './ProgressSpinner';
import { modelDisplayName, ModelRouteLabel } from './provider-display';
import { record } from './record-utils';
import { formatWorkElapsed, timeMs } from './TranscriptView';

type RecordValue = Record<string, unknown>;
export const AGENT_POOL_RECONCILE_MS = 2_000;

interface AgentPoolStore {
  host?: DesktopApi;
  rows: DesktopAgentPoolRow[] | null;
  revision: number;
  started: boolean;
  inFlight?: Promise<void>;
  /** Cancelled identities survive here, so a later pool snapshot cannot
   *  republish a stopped agent as working. */
  cancellations: DesktopAgentCancellationLedger;
  listeners: Set<() => void>;
  getSnapshot(): DesktopAgentPoolRow[] | null;
  subscribe(listener: () => void): () => void;
}

const AGENT_POOL_STORES = new WeakMap<object, AgentPoolStore>();
const EMPTY_AGENT_POOL_STORE = createAgentPoolStore();

function createAgentPoolStore(host?: DesktopApi): AgentPoolStore {
  const store: AgentPoolStore = {
    host,
    rows: host ? null : [],
    revision: 0,
    started: false,
    cancellations: createDesktopCancellationLedger(),
    listeners: new Set(),
    getSnapshot: () => store.rows,
    subscribe: (listener) => {
      store.listeners.add(listener);
      return () => { store.listeners.delete(listener); };
    },
  };
  return store;
}

function agentPoolStore(host?: DesktopApi): AgentPoolStore {
  if (!host || typeof host !== 'object') return EMPTY_AGENT_POOL_STORE;
  const cached = AGENT_POOL_STORES.get(host);
  if (cached) return cached;
  const created = createAgentPoolStore(host);
  AGENT_POOL_STORES.set(host, created);
  return created;
}

function publishAgentPool(store: AgentPoolStore, rows: unknown): void {
  // Every snapshot passes the cancellation ledger: the pool's heartbeat
  // sidecar re-declares a session `running` once the durable index drops its
  // cancelled row, and that promotion is a stale lease, not new work.
  store.rows = store.cancellations.apply(
    Array.isArray(rows) ? rows as DesktopAgentPoolRow[] : [],
  );
  for (const listener of store.listeners) listener();
}

function refreshAgentPool(store: AgentPoolStore): Promise<void> {
  if (store.inFlight) return store.inFlight;
  const listAgentPool = store.host?.listAgentPool;
  if (typeof listAgentPool !== 'function') {
    publishAgentPool(store, []);
    return Promise.resolve();
  }
  const revision = store.revision;
  const request = Promise.resolve(listAgentPool()).then((rows) => {
    if (revision === store.revision) publishAgentPool(store, rows);
  }).catch(() => {
    if (revision === store.revision && store.rows === null) publishAgentPool(store, []);
  }).finally(() => {
    if (store.inFlight === request) store.inFlight = undefined;
  });
  store.inFlight = request;
  return request;
}

function startAgentPool(store: AgentPoolStore): void {
  if (store.started) return;
  store.started = true;
  const subscribeAgentPool = store.host?.subscribeAgentPool;
  if (typeof subscribeAgentPool === 'function') {
    subscribeAgentPool((rows) => {
      store.revision += 1;
      publishAgentPool(store, rows);
    });
  }
  void refreshAgentPool(store);
}

export function preloadAgentPool(host: DesktopApi | undefined = window.mixdogDesktop): void {
  startAgentPool(agentPoolStore(host));
}

interface LiveAgentSummary {
  key: string;
  role: string;
  roleId: string;
  model: string;
  provider: string;
  effort: string;
  fast: boolean;
  tag: string;
  status: string;
  /** Lifecycle the surface must paint. `cancel-unconfirmed` rows stay live on
   *  purpose: their process is not proven gone. */
  state: DesktopAgentActivityState;
  queued: boolean;
  startedAt: number;
  turnStartedAt: number;
  sessionId: string;
  ownerSessionId: string;
}

function agentRoleLabel(value: unknown): string {
  const role = String(value || '').trim();
  if (!role) return 'Agent';
  return role.split(/[-_\s]+/)
    .filter(Boolean)
    .map((part) => `${part.slice(0, 1).toLocaleUpperCase()}${part.slice(1)}`)
    .join(' ');
}

export function liveAgentRows(snapshot: unknown, fallbackOwnerSessionId = ''): LiveAgentSummary[] {
  const state = record(snapshot);
  const workers = (Array.isArray(state.agentWorkers) ? state.agentWorkers : []).map(record);
  const jobs = (Array.isArray(state.agentJobs) ? state.agentJobs : []).map(record);
  const workerByIdentity = new Map<string, RecordValue>();
  workers.forEach((entry) => {
    const identity = desktopAgentIdentity(entry);
    if (identity) workerByIdentity.set(identity, entry);
  });
  const mapped = new Map<string, LiveAgentSummary>();
  const entries = [
    ...workers.map((entry, index) => ({ entry, index, worker: true })),
    ...jobs.map((entry, index) => ({ entry, index: workers.length + index, worker: false })),
  ];
  // A CONFIRMED cancel is the last word about that identity. Worker and job
  // rows for one agent settle at different moments, so a cancelled job
  // routinely arrives beside a worker row that still says `running` (and vice
  // versa); taking the active row would keep the stopped agent on the live
  // surfaces forever. Collected BEFORE the active filter and the merge below,
  // so neither the entry order nor the status preference in the merge can
  // resurrect it.
  // An UNCONFIRMED cancel (`cancelling`, `cancel-unconfirmed`) is the opposite
  // case: the process is not proven gone — on Windows a git-bash background
  // survivor is unreachable from JS and answers with
  // SURVIVING_DESCENDANTS_UNREACHABLE_WARNING — so dropping it would hide a
  // possibly still-live agent. Those rows stay, carrying their own state.
  const cancelled = new Set<string>();
  const unconfirmedCancels = new Map<string, string>();
  for (const { entry } of entries) {
    if (!isCancelledDesktopAgentEntry(entry)) continue;
    const identity = desktopAgentIdentity(entry);
    if (!identity) continue;
    if (isCancelUnconfirmedDesktopAgentEntry(entry)) {
      unconfirmedCancels.set(identity, desktopAgentCancelStatus(entry) || 'cancel-unconfirmed');
    } else cancelled.add(identity);
  }
  // One unproven signal outranks a confirmed twin: nothing is proven gone.
  for (const identity of unconfirmedCancels.keys()) cancelled.delete(identity);
  entries.forEach(({ entry, index, worker }) => {
    const identity = desktopAgentIdentity(entry);
    if (identity && cancelled.has(identity)) return;
    const unconfirmed = (identity ? unconfirmedCancels.get(identity) : '')
      || (isCancelUnconfirmedDesktopAgentEntry(entry) ? desktopAgentCancelStatus(entry) : '');
    if (!unconfirmed && !isActiveDesktopAgentEntry(entry)) return;
    if (!worker && identity) {
      const workerEntry = workerByIdentity.get(identity);
      if (workerEntry
        && (isActiveDesktopAgentEntry(workerEntry) || !isQueuedDesktopAgentEntry(entry))) return;
    }
    const status = unconfirmed || desktopAgentStatus(entry);
    const state: DesktopAgentActivityState = unconfirmed
      ? 'cancel-unconfirmed'
      : desktopAgentActivityState(entry);
    const tag = String(entry.tag || '').trim();
    const taskId = String(entry.task_id || entry.taskId || '').trim();
    const roleValue = String(entry.agent || entry.name || entry.type || '').trim();
    const role = agentRoleLabel(roleValue);
    const roleId = roleValue.toLowerCase();
    const model = String(entry.model || '').trim();
    const provider = String(entry.provider || '').trim();
    const effort = String(entry.effort || '').trim();
    const fast = entry.fast === true;
    const startedAt = timeMs(entry.startedAt || entry.startTime || entry.createdAt);
    const turnStartedAt = timeMs(entry.turnStartedAt);
    const sessionId = String(entry.sessionId || '').trim();
    const ownerSessionId = String(entry.ownerSessionId || fallbackOwnerSessionId || '').trim();
    // An unproven cancel is not queued work, whatever stage the row still says.
    const queued = !unconfirmed && isQueuedDesktopAgentEntry(entry);
    const key = identity || `${roleValue || 'agent'}-${index}`;
    const current = mapped.get(key);
    if (!current) {
      mapped.set(key, {
        key,
        role,
        roleId,
        model,
        provider,
        effort,
        fast,
        tag: tag || taskId,
        status,
        state,
        queued,
        startedAt,
        turnStartedAt,
        sessionId,
        ownerSessionId,
      });
      return;
    }
    mapped.set(key, {
      ...current,
      role: current.role === 'Agent' ? role : current.role,
      roleId: current.roleId || roleId,
      model: current.model || model,
      provider: current.provider || provider,
      effort: current.effort || effort,
      fast: current.fast || fast,
      tag: current.tag || tag || taskId,
      // Keeping the earlier status is safe ONLY because a confirmed cancel
      // never reaches this merge (see the cancelled set above) and an
      // unconfirmed one wins here: whichever twin reports it, the merge can
      // never fall back to the live twin's status.
      status: state === 'cancel-unconfirmed' && current.state !== 'cancel-unconfirmed'
        ? status
        : current.queued && !queued ? status : current.status,
      state: state === 'cancel-unconfirmed' ? state : current.state,
      queued: current.queued && queued,
      startedAt: current.startedAt || startedAt,
      turnStartedAt: current.turnStartedAt || turnStartedAt,
      sessionId: current.sessionId || sessionId,
      ownerSessionId: current.ownerSessionId || ownerSessionId,
    });
  });
  return [...mapped.values()].sort((left, right) => {
    const leftTime = left.startedAt || Number.MAX_SAFE_INTEGER;
    const rightTime = right.startedAt || Number.MAX_SAFE_INTEGER;
    return leftTime - rightTime || left.key.localeCompare(right.key);
  });
}

interface LiveShellSummary {
  key: string;
  command: string;
  cwd: string;
  startedAt: number;
}

export function liveShellRows(snapshot: unknown): LiveShellSummary[] {
  const shellJobs = record(record(snapshot).shellJobs);
  const jobs = Array.isArray(shellJobs.jobs) ? shellJobs.jobs : [];
  return jobs.flatMap((value) => {
    const entry = record(value);
    const key = String(entry.taskId || entry.task_id || '').trim();
    if (!key) return [];
    return [{
      key,
      // One popover row per job: a multi-line command turned the fixed-width
      // popover into a wall of wrapped text.
      command: String(entry.command || '').replace(/\s+/g, ' ').trim(),
      cwd: String(entry.cwd || '').trim(),
      startedAt: timeMs(entry.startedAt) || 0,
    }];
  }).sort((left, right) =>
    (left.startedAt || Number.MAX_SAFE_INTEGER) - (right.startedAt || Number.MAX_SAFE_INTEGER)
      || left.key.localeCompare(right.key));
}

export function liveShellCount(snapshot: unknown): number {
  return Math.max(0, Number(record(record(snapshot).shellJobs).count) || 0);
}

export function liveTaskCount(snapshot: unknown): number {
  return liveAgentRows(snapshot).length + liveShellCount(snapshot);
}

function poolRowKey(agent: DesktopAgentPoolRow, index: number): string {
  return String(agent.sessionId || agent.tag || agent.taskId || index);
}

function poolSessionId(agent: DesktopAgentPoolRow): string {
  return String(agent.sessionId || '').trim();
}

/** The IMMEDIATE spawn parent of one pool row. `parentSessionId` is the exact
 *  link; `ownerSessionId` carries the same value for a first-generation child
 *  and is the only link older rows publish, so it stays the fallback. */
function poolParentId(agent: DesktopAgentPoolRow): string {
  const sessionId = poolSessionId(agent);
  const parent = String(agent.parentSessionId || '').trim();
  if (parent && parent !== sessionId) return parent;
  const owner = String(agent.ownerSessionId || '').trim();
  // A row that owns itself is a root (Lead): it has no parent to climb to.
  if (owner && owner !== sessionId) return owner;
  return '';
}

/** Guard for a self-referencing or corrupted spawn chain: a hierarchy this
 *  deep is a defect, and walking it forever would freeze the window. */
const MAX_AGENT_TREE_DEPTH = 16;

export interface AgentActivityNode {
  agent: DesktopAgentPoolRow;
  sessionId: string;
  /** Immediate parent as rendered: '' for a row that sits directly under the
   *  owner heading. */
  parentSessionId: string;
  depth: number;
  /** 1-based position among its rendered siblings, for aria-posinset. */
  posInSet: number;
  setSize: number;
  children: AgentActivityNode[];
}

export interface AgentActivityGroup {
  ownerId: string;
  agents: DesktopAgentPoolRow[];
  nodes: AgentActivityNode[];
}

/** Root owner of one row.
 *
 *  `ownerSessionId` is the AUTHORITATIVE root: the producer stamps every
 *  descendant with the owning Lead session, so a grandchild is filed under its
 *  Lead even when its immediate parent already finished or is hidden here.
 *  `parentSessionId` is only the immediate edge and is consulted as a fallback
 *  for older rows that carry no separate root — climbing it can never move a
 *  row to a non-catalog id, because every step is accepted only when the id is
 *  a real session-catalog row. A row that resolves to nothing is an internal
 *  reservation, not a user task. */
export function agentRootSessionId(
  agent: DesktopAgentPoolRow,
  rowsBySessionId: ReadonlyMap<string, DesktopAgentPoolRow>,
  isOwnerSession: (sessionId: string) => boolean,
): string {
  const owner = String(agent.ownerSessionId || '').trim();
  if (owner && isOwnerSession(owner)) return owner;
  // A Lead row owns itself and is its own root.
  const sessionId = poolSessionId(agent);
  if (sessionId && isOwnerSession(sessionId)) return sessionId;
  let current = agent;
  const seen = new Set<string>(sessionId ? [sessionId] : []);
  for (let step = 0; step < MAX_AGENT_TREE_DEPTH; step += 1) {
    const parent = poolParentId(current);
    if (!parent || seen.has(parent)) return '';
    if (isOwnerSession(parent)) return parent;
    const parentRow = rowsBySessionId.get(parent);
    if (!parentRow) return '';
    const parentOwner = String(parentRow.ownerSessionId || '').trim();
    if (parentOwner && isOwnerSession(parentOwner)) return parentOwner;
    seen.add(parent);
    current = parentRow;
  }
  return '';
}

function leadFirst(left: DesktopAgentPoolRow, right: DesktopAgentPoolRow): number {
  const leftLead = String(left.agent || '').toLowerCase() === 'lead' ? 0 : 1;
  const rightLead = String(right.agent || '').toLowerCase() === 'lead' ? 0 : 1;
  return leftLead - rightLead;
}

function agentTreeNodes(
  ownerId: string,
  agents: readonly DesktopAgentPoolRow[],
): AgentActivityNode[] {
  const idsInGroup = new Set(agents.map(poolSessionId).filter(Boolean));
  const childrenByParent = new Map<string, DesktopAgentPoolRow[]>();
  const top: DesktopAgentPoolRow[] = [];
  // When the owner's own Lead row is present it is the visible root of the
  // group, so every other row hangs beneath it: Lead → direct child →
  // descendant. Without a Lead row the direct children ARE the top level.
  const leadRow = agents.find((agent) => poolSessionId(agent) === ownerId);
  const attach = (parentId: string, agent: DesktopAgentPoolRow): void => {
    const siblings = childrenByParent.get(parentId);
    if (siblings) siblings.push(agent);
    else childrenByParent.set(parentId, [agent]);
  };
  for (const agent of agents) {
    const sessionId = poolSessionId(agent);
    if (sessionId && sessionId === ownerId) {
      top.push(agent);
      continue;
    }
    const parent = poolParentId(agent);
    // A live parent inside this group nests the row; a missing, hidden or
    // already-finished parent must never hide it — it stays a top-level orphan
    // under the same valid root.
    if (sessionId && parent && parent !== sessionId && parent !== ownerId
      && idsInGroup.has(parent)) {
      attach(parent, agent);
      continue;
    }
    if (leadRow) attach(ownerId, agent);
    else top.push(agent);
  }
  const placed = new Set<string>();
  const build = (
    rows: readonly DesktopAgentPoolRow[],
    depth: number,
    parentId: string,
  ): AgentActivityNode[] => {
    const ordered = [...rows].sort(leadFirst)
      .filter((agent) => {
        const sessionId = poolSessionId(agent);
        if (sessionId && placed.has(sessionId)) return false;
        if (sessionId) placed.add(sessionId);
        return true;
      });
    return ordered.map((agent, index) => {
      const sessionId = poolSessionId(agent);
      return {
        agent,
        sessionId,
        parentSessionId: parentId,
        depth,
        posInSet: index + 1,
        setSize: ordered.length,
        children: depth < MAX_AGENT_TREE_DEPTH && sessionId
          ? build(childrenByParent.get(sessionId) || [], depth + 1, sessionId)
          : [],
      };
    });
  };
  const nodes = build(top, 0, '');
  // A cyclic parent chain leaves rows that no traversal reached. They are real
  // work and stay visible: re-enter them as orphans under the root.
  const stranded = agents.filter((agent) => {
    const sessionId = poolSessionId(agent);
    return Boolean(sessionId) && !placed.has(sessionId);
  });
  if (stranded.length === 0) return nodes;
  const leadNode = nodes.find((node) => node.sessionId === ownerId);
  const host = leadNode ? leadNode.children : nodes;
  for (const agent of stranded) {
    if (placed.has(poolSessionId(agent))) continue;
    host.push(...build([agent], leadNode ? leadNode.depth + 1 : 0, leadNode ? ownerId : ''));
  }
  host.forEach((node, index) => {
    node.posInSet = index + 1;
    node.setSize = host.length;
  });
  return nodes;
}

/** Owner-rooted Parent–Child hierarchy for the Agent window. Rows are grouped
 *  by their ROOT owner session and nested by their immediate parent. */
export function agentActivityGroups(
  rows: readonly DesktopAgentPoolRow[] | null | undefined,
  isOwnerSession: (sessionId: string) => boolean,
): AgentActivityGroup[] {
  const visible = (rows || []).filter(visibleAgentActivityRow);
  const bySessionId = new Map<string, DesktopAgentPoolRow>();
  for (const agent of visible) {
    const sessionId = poolSessionId(agent);
    if (sessionId && !bySessionId.has(sessionId)) bySessionId.set(sessionId, agent);
  }
  const byOwner = new Map<string, DesktopAgentPoolRow[]>();
  for (const agent of visible) {
    // Internal control reservations and abandoned pre-submit runtimes are
    // resident pool entries, not user tasks: a group is real only once its
    // root owner has a resumable session-catalog row.
    const ownerId = agentRootSessionId(agent, bySessionId, isOwnerSession);
    if (!ownerId) continue;
    const group = byOwner.get(ownerId);
    if (group) group.push(agent);
    else byOwner.set(ownerId, [agent]);
  }
  return [...byOwner.entries()].map(([ownerId, agents]) => ({
    ownerId,
    agents,
    nodes: agentTreeNodes(ownerId, agents),
  }));
}

/** Depth-first render order: a parent is immediately followed by its subtree. */
export function flattenAgentActivityNodes(
  nodes: readonly AgentActivityNode[],
): AgentActivityNode[] {
  return nodes.flatMap((node) => [node, ...flattenAgentActivityNodes(node.children)]);
}

/** Rendered rows in depth-first order, skipping the subtree of every row the
 *  user collapsed. This is the list the tree's roving focus walks, so the
 *  keyboard can only ever reach rows that are actually painted. */
export function visibleAgentTreeRows(
  nodes: readonly AgentActivityNode[],
  collapsedSessionIds: ReadonlySet<string> = new Set<string>(),
): AgentActivityNode[] {
  return nodes.flatMap((node) => (collapsedSessionIds.has(node.sessionId)
    ? [node]
    : [node, ...visibleAgentTreeRows(node.children, collapsedSessionIds)]));
}

/** Ordering signal for the dock: the moment an agent LAST WENT IDLE (user
 *  decision: 유휴시간으로만). A working agent has no idle stamp, so it keeps
 *  its previous position and the list only reshuffles when work actually
 *  settles — the session catalog's activityAt reordered rows mid-turn. */
function poolRowIdleAt(agent: DesktopAgentPoolRow): number {
  const idle = timeMs(agent.idleSince);
  if (idle) return idle;
  // A working row has NO idle stamp, and its updatedAt is the live heartbeat:
  // ranking on it made every running session climb on each tick, so cards
  // leapfrogged mid-turn (user: 위아래로 튄다). The turn/start stamps are
  // frozen for the whole turn, so a live row holds its place until it stops.
  return timeMs(agent.turnStartedAt)
    || timeMs(agent.startedAt)
    || timeMs(agent.createdAt);
}

/** Sticky ordering stamp for one owner group. The pool decides `working` from
 *  a 2-minute heartbeat freshness window, so `idleSince` can vanish and come
 *  back mid-turn and a raw ranking swapped rows on every flip (user: 하트비트
 *  때문에 뒤죽박죽). A group's stamp therefore only ever ADVANCES, and only
 *  when a genuinely newer turn start or idle moment lands. */
export function stickyGroupOrder(
  previous: ReadonlyMap<string, number>,
  ownerId: string,
  agents: readonly DesktopAgentPoolRow[],
): number {
  const prior = previous.get(ownerId) || 0;
  // Two moments move a group, and both are FROZEN values: the turn it started
  // and the moment it went idle (user decision: 작업 시작 시 1회, 완료 시 1회).
  // The live heartbeat in updatedAt stays out of the ranking, so a running
  // session climbs once and then holds its slot for the whole turn.
  const moment = Math.max(
    0,
    ...agents.map((agent) => Math.max(timeMs(agent.idleSince), timeMs(agent.turnStartedAt))),
  );
  if (moment > prior) return moment;
  if (prior) return prior;
  // First sighting while still working: seed from the frozen turn/start stamps
  // so a new group lands in a sane slot instead of the bottom.
  return Math.max(0, ...agents.map(poolRowIdleAt));
}

export function visibleAgentActivityRow(agent: DesktopAgentPoolRow): boolean {
  const identity = String(agent.agent || String(agent.tag || '').split(':')[0] || '')
    .trim()
    .toLowerCase()
    .replace(/[\s_]+/g, '-');
  return identity !== 'maintainer' && identity !== 'web-search' && identity !== 'websearch';
}

function AgentPoolRow({
  agent,
  clock,
  ownerSessionId,
  depth = 0,
  parentSessionId = '',
  hasChildren = false,
  expanded = true,
  posInSet,
  setSize,
  tabIndex,
  unread = false,
  onPrefetchSession,
  onOpenLeadSession,
  onOpenSession,
}: {
  agent: DesktopAgentPoolRow;
  clock: number;
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
  /** The owner session has unseen activity: this rest is a FINISHED turn, not
   *  an idle sit — the row carries the completion notice the Recent dot does. */
  unread?: boolean;
  onPrefetchSession?(sessionId: string): void;
  onOpenLeadSession?(sessionId: string): void;
  onOpenSession?(sessionId: string, title: string, ownerSessionId: string): void;
}): React.ReactElement {
  // One lifecycle mapping owns this row. Cancellation is settled first, so a
  // stopped agent can never borrow the running timer or the "Completed" notice
  // (an agent cancelled mid-turn still carries stage `running`, and one
  // cancelled while waiting still carries stage `queued`).
  const state = desktopAgentActivityState(agent, { unread });
  const queued = state === 'queued';
  const running = state === 'running';
  const role = agentRoleLabel(agent.agent || agent.tag);
  const sessionId = String(agent.sessionId || '').trim();
  const lead = Boolean(sessionId) && sessionId === ownerSessionId;
  const tag = String(agent.tag || '').trim();
  const sessionTitle = String(agent.title || '').trim();
  const name = !lead && tag && tag.toLowerCase() !== role.toLowerCase()
    ? `${role} · ${tag}`
    : role;
  const tabTitle = tag && tag.toLowerCase() !== sessionTitle.toLowerCase()
    ? [sessionTitle, tag].filter(Boolean).join(' · ')
    : sessionTitle || tag || role;
  const elapsedBase = timeMs(agent.turnStartedAt) || timeMs(agent.startedAt);
  // Idle duration carries no information (user: 대기중인데 왜 시간 표기하냐):
  // a resting agent's card says only that it rests. Time belongs to work.
  const done = state === 'done';
  const workMeta = elapsedBase
    ? formatWorkElapsed(clock - elapsedBase) || '0s'
    : '0s';
  const elapsed = queued
    ? t('Queued')
    : running
      ? workMeta
      : state === 'cancel-unconfirmed'
        ? t('Cancel unconfirmed')
        : state === 'cancelled'
          ? t('Cancelled')
          : done
            ? t('Completed')
            : t('Idle');
  const modelLabel = modelDisplayName(String(agent.model || ''), String(agent.provider || ''));
  const effortValue = String(agent.effort || '').trim();
  const prefetch = () => {
    if (sessionId) onPrefetchSession?.(lead ? ownerSessionId : sessionId);
  };
  return <button type="button"
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
    onPointerEnter={prefetch}
    onFocus={prefetch}
    onPointerDown={prefetch}
    onClick={() => {
      if (!sessionId) return;
      if (lead) onOpenLeadSession?.(ownerSessionId);
      else onOpenSession?.(sessionId, tabTitle, ownerSessionId);
    }}>
    <span className="schedules-row-copy">
      <b className="agent-pool-name">{name}</b>
      <small className="agent-route-summary" title={String(agent.model || '') || undefined}>
        <ModelRouteLabel model={modelLabel} effort={effortValue} fast={agent.fast === true} />
      </small>
    </span>
    <span className="agent-activity-status">
      <time className="agent-activity-elapsed" aria-label={elapsed}
        title={state === 'cancel-unconfirmed'
          ? t('Cancel was delivered, but the process could not be confirmed stopped.')
          : undefined}
        data-state={state}>
        {elapsed}
      </time>
    </span>
  </button>;
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
  clock,
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
  clock: number;
  unreadSessionIds?: ReadonlySet<string>;
  onExpandGroup?(): void;
  onCollapseGroup?(): void;
  onPrefetchSession?(sessionId: string): void;
  onOpenLeadSession?(sessionId: string): void;
  onOpenSession?(sessionId: string, title: string, ownerSessionId: string): void;
}): React.ReactElement {
  const treeRef = useRef<HTMLDivElement | null>(null);
  const [collapsedRowIds, setCollapsedRowIds] = useState<ReadonlySet<string>>(
    () => new Set<string>(),
  );
  const [focusedSessionId, setFocusedSessionId] = useState('');
  const rows = useMemo(() => {
    const visible = visibleAgentTreeRows(group.nodes, collapsedRowIds);
    // A collapsed GROUP keeps exactly the owner's own row: every descendant,
    // at any generation, folds away with it.
    return groupExpanded
      ? visible
      : visible.filter((node) => node.sessionId === group.ownerId);
  }, [collapsedRowIds, group.nodes, group.ownerId, groupExpanded]);
  const focusedIndex = rows.findIndex((node) => node.sessionId === focusedSessionId);
  const activeIndex = focusedIndex >= 0 ? focusedIndex : 0;
  const rowExpanded = (node: AgentActivityNode): boolean =>
    groupExpanded && !collapsedRowIds.has(node.sessionId);
  const focusRow = (index: number): void => {
    const node = rows[Math.min(Math.max(index, 0), rows.length - 1)];
    if (!node) return;
    setFocusedSessionId(node.sessionId);
    treeRef.current
      ?.querySelector<HTMLElement>(`[data-agent-session-id="${node.sessionId}"]`)
      ?.focus();
  };
  const setRowCollapsed = (sessionId: string, collapsed: boolean): void => {
    setFocusedSessionId(sessionId);
    setCollapsedRowIds((current) => {
      if (current.has(sessionId) === collapsed) return current;
      const next = new Set(current);
      if (collapsed) next.add(sessionId);
      else next.delete(sessionId);
      return next;
    });
  };
  const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>): void => {
    if (!AGENT_TREE_KEYS.has(event.key)) return;
    if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
    const originId = (event.target as HTMLElement | null)
      ?.closest<HTMLElement>('[data-agent-session-id]')?.dataset.agentSessionId || '';
    const found = rows.findIndex((node) => node.sessionId === originId);
    const index = found >= 0 ? found : activeIndex;
    const node = rows[index];
    if (!node) return;
    event.preventDefault();
    if (event.key === 'ArrowDown') return focusRow(index + 1);
    if (event.key === 'ArrowUp') return focusRow(index - 1);
    if (event.key === 'Home') return focusRow(0);
    if (event.key === 'End') return focusRow(rows.length - 1);
    const hasChildren = node.children.length > 0;
    if (event.key === 'ArrowRight') {
      // The root row of a folded group opens the group itself: that fold is
      // the only thing hiding its subtree.
      if (!groupExpanded && node.sessionId === group.ownerId) return onExpandGroup?.();
      if (!hasChildren) return undefined;
      if (!rowExpanded(node)) return setRowCollapsed(node.sessionId, false);
      // Expanded: its first child is the next row in depth-first order.
      return focusRow(index + 1);
    }
    if (hasChildren && rowExpanded(node)) return setRowCollapsed(node.sessionId, true);
    const parentIndex = rows.findIndex((row) => row.sessionId === node.parentSessionId);
    if (parentIndex >= 0) return focusRow(parentIndex);
    if (groupExpanded) return onCollapseGroup?.();
    return undefined;
  };
  return <div ref={treeRef} className="schedules-list" role="tree" aria-label={label}
    onKeyDown={onKeyDown}>
    {rows.map((node, index) => <AgentPoolRow
      key={poolRowKey(node.agent, index)}
      agent={node.agent}
      clock={clock}
      depth={node.depth}
      parentSessionId={node.parentSessionId}
      hasChildren={node.children.length > 0}
      expanded={rowExpanded(node)}
      posInSet={node.posInSet}
      setSize={node.setSize}
      tabIndex={index === activeIndex ? 0 : -1}
      ownerSessionId={group.ownerId}
      unread={unreadSessionIds?.has(node.sessionId) === true}
      onPrefetchSession={onPrefetchSession}
      onOpenLeadSession={onOpenLeadSession}
      onOpenSession={onOpenSession} />)}
  </div>;
}

export function AgentActivityPane({
  active,
  sessions,
  unreadSessionIds,
  onPrefetchSession,
  onOpenLeadSession,
  onOpenSession,
}: {
  active: boolean;
  sessions: readonly DesktopSessionSummary[];
  activeSessionIds?: readonly string[];
  /** Recent-list unread set: an idle row whose session is unseen reads as
   *  "완료" until the session is actually opened. */
  unreadSessionIds?: ReadonlySet<string>;
  onPrefetchSession?(sessionId: string): void;
  onOpenLeadSession?(sessionId: string): void;
  onOpenSession?(sessionId: string, title: string, ownerSessionId: string): void;
}): React.ReactElement {
  const poolStore = useMemo(() => agentPoolStore(window.mixdogDesktop), []);
  const agents = useSyncExternalStore(
    poolStore.subscribe,
    poolStore.getSnapshot,
    poolStore.getSnapshot,
  );
  const [clock, setClock] = useState(() => Date.now());
  const [collapsedOwnerIds, setCollapsedOwnerIds] = useState<Set<string>>(() => new Set());
  const orderRef = useRef<Map<string, number>>(new Map());
  useEffect(() => {
    startAgentPool(poolStore);
    if (!active) return undefined;
    // A hidden surface (phone screen off, app in the background, another tab)
    // reconciles rows nobody can see while still paying for the request every
    // two seconds over a metered link. Pause there and resume with ONE
    // immediate refresh, so the first visible frame is already current.
    let reconcileTimer = 0;
    const stop = (): void => {
      if (!reconcileTimer) return;
      window.clearInterval(reconcileTimer);
      reconcileTimer = 0;
    };
    const start = (): void => {
      if (reconcileTimer) return;
      void refreshAgentPool(poolStore);
      reconcileTimer = window.setInterval(
        () => { void refreshAgentPool(poolStore); },
        AGENT_POOL_RECONCILE_MS,
      );
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
  const groups = useMemo(() => {
    const sessionById = new Map(sessions.map((session) => [session.id, session]));
    const built = agentActivityGroups(agents, (ownerId) => sessionById.has(ownerId));
    // Rebuilt each pass so departed sessions drop out; surviving groups carry
    // their stamp forward, which is what keeps live rows from shuffling.
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
  }, [agents, sessions]);
  const hasLiveClock = (agents || []).length > 0;
  useEffect(() => {
    if (!active || !hasLiveClock) return undefined;
    setClock(Date.now());
    const timer = window.setInterval(() => setClock(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [active, hasLiveClock]);

  if (agents === null) return <div className="schedules-page agent-activity-page">
    <div className="schedules-list">
      <div className="schedules-row workflows-agent-summary-row" role="status">
        <span className="schedules-row-copy">{t('Loading activity…')}</span>
        <span className="agent-activity-status"><ProgressSpinner size={16} /></span>
      </div>
    </div>
  </div>;
  if (groups.length === 0) return <div className="schedules-page agent-activity-page">
    <p className="schedules-empty agent-activity-empty">
      <Bot size={28} aria-hidden="true" />
      <span>{t('No agents are running.')}</span>
    </p>
  </div>;
  return <div className="schedules-page agent-activity-page">
    {groups.map((group) => {
      const title = sessionSummaryTitle(group.session);
      const expanded = !collapsedOwnerIds.has(group.ownerId);
      const setGroupCollapsed = (collapsed: boolean): void =>
        setCollapsedOwnerIds((current) => {
          if (current.has(group.ownerId) === collapsed) return current;
          const next = new Set(current);
          if (collapsed) next.add(group.ownerId);
          else next.delete(group.ownerId);
          return next;
        });
      return <section key={group.ownerId} className="workflows-models"
        data-agent-owner-session-id={group.ownerId}>
        <div className="workflows-section-head">
          <button type="button" className="agent-session-heading" aria-label={title}
            aria-expanded={expanded}
            data-lead-session-id={group.ownerId}
            onClick={() => setGroupCollapsed(expanded)}>
            <h2>{title}</h2>
            <span className="agent-session-chevron" aria-hidden="true">
              {expanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
            </span>
          </button>
        </div>
        <AgentActivityTree
          group={group}
          label={title}
          groupExpanded={expanded}
          clock={clock}
          unreadSessionIds={unreadSessionIds}
          onExpandGroup={() => setGroupCollapsed(false)}
          onCollapseGroup={() => setGroupCollapsed(true)}
          onPrefetchSession={onPrefetchSession}
          onOpenLeadSession={onOpenLeadSession}
          onOpenSession={onOpenSession} />
      </section>;
    })}
  </div>;
}
