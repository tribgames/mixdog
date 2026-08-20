import { Bot, ChevronDown, ChevronRight } from 'lucide-react';
import React, { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';

import type { DesktopAgentPoolRow, DesktopApi, DesktopSessionSummary } from '../shared/contract';
import {
  desktopAgentIdentity,
  desktopAgentStatus,
  isActiveDesktopAgentEntry,
  isQueuedDesktopAgentEntry,
} from '../shared/agent-activity';
import { sessionSummaryTitle } from '../shared/session-title.mjs';
import { t } from './i18n';
import { ProgressSpinner } from './ProgressSpinner';
import { modelDisplayName, ModelRouteLabel } from './provider-display';
import { formatWorkElapsed, timeMs } from './TranscriptView';

type RecordValue = Record<string, unknown>;
export const AGENT_POOL_RECONCILE_MS = 2_000;

interface AgentPoolStore {
  host?: DesktopApi;
  rows: DesktopAgentPoolRow[] | null;
  revision: number;
  started: boolean;
  inFlight?: Promise<void>;
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
  store.rows = Array.isArray(rows) ? rows as DesktopAgentPoolRow[] : [];
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
  queued: boolean;
  startedAt: number;
  turnStartedAt: number;
  sessionId: string;
  ownerSessionId: string;
}

function record(value: unknown): RecordValue {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as RecordValue : {};
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
  [
    ...workers.map((entry, index) => ({ entry, index, worker: true })),
    ...jobs.map((entry, index) => ({ entry, index: workers.length + index, worker: false })),
  ].forEach(({ entry, index, worker }) => {
    if (!isActiveDesktopAgentEntry(entry)) return;
    const identity = desktopAgentIdentity(entry);
    if (!worker && identity) {
      const workerEntry = workerByIdentity.get(identity);
      if (workerEntry
        && (isActiveDesktopAgentEntry(workerEntry) || !isQueuedDesktopAgentEntry(entry))) return;
    }
    const status = desktopAgentStatus(entry);
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
    const queued = isQueuedDesktopAgentEntry(entry);
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
      status: current.queued && !queued ? status : current.status,
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

function poolOwnerId(agent: DesktopAgentPoolRow): string {
  return String(agent.ownerSessionId || agent.sessionId || '').trim();
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
  unread = false,
  onPrefetchSession,
  onOpenLeadSession,
  onOpenSession,
}: {
  agent: DesktopAgentPoolRow;
  clock: number;
  ownerSessionId: string;
  /** The owner session has unseen activity: this rest is a FINISHED turn, not
   *  an idle sit — the row carries the completion notice the Recent dot does. */
  unread?: boolean;
  onPrefetchSession?(sessionId: string): void;
  onOpenLeadSession?(sessionId: string): void;
  onOpenSession?(sessionId: string, title: string, ownerSessionId: string): void;
}): React.ReactElement {
  const queued = isQueuedDesktopAgentEntry(agent);
  const running = isActiveDesktopAgentEntry(agent) && !queued;
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
  const done = !queued && !running && unread;
  const workMeta = elapsedBase
    ? formatWorkElapsed(clock - elapsedBase) || '0s'
    : '0s';
  const elapsed = queued
    ? t('Queued')
    : running
      ? workMeta
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
        data-state={queued ? 'queued' : running ? 'running' : done ? 'done' : 'idle'}>
        {elapsed}
      </time>
    </span>
  </button>;
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
    void refreshAgentPool(poolStore);
    const reconcileTimer = window.setInterval(
      () => { void refreshAgentPool(poolStore); },
      AGENT_POOL_RECONCILE_MS,
    );
    return () => window.clearInterval(reconcileTimer);
  }, [active, poolStore]);
  const groups = useMemo(() => {
    const byOwner = new Map<string, {
      ownerId: string;
      session: DesktopSessionSummary;
      agents: DesktopAgentPoolRow[];
    }>();
    const sessionById = new Map(sessions.map((session) => [session.id, session]));
    for (const agent of agents || []) {
      if (!visibleAgentActivityRow(agent)) continue;
      const ownerId = poolOwnerId(agent);
      if (!ownerId) continue;
      const session = sessionById.get(ownerId);
      // Internal control reservations and abandoned pre-submit runtimes are
      // resident pool entries, not user tasks. A real Lead is visible only
      // once its owner has a resumable session-catalog row.
      if (!session) continue;
      let group = byOwner.get(ownerId);
      if (!group) {
        group = { ownerId, session, agents: [] };
        byOwner.set(ownerId, group);
      }
      group.agents.push(agent);
    }
    for (const group of byOwner.values()) {
      group.agents.sort((left, right) => {
        const leftLead = String(left.agent || '').toLowerCase() === 'lead' ? 0 : 1;
        const rightLead = String(right.agent || '').toLowerCase() === 'lead' ? 0 : 1;
        return leftLead - rightLead;
      });
    }
    // Rebuilt each pass so departed sessions drop out; surviving groups carry
    // their stamp forward, which is what keeps live rows from shuffling.
    const order = new Map<string, number>();
    for (const group of byOwner.values()) {
      order.set(group.ownerId, stickyGroupOrder(orderRef.current, group.ownerId, group.agents));
    }
    orderRef.current = order;
    return [...byOwner.values()].sort((left, right) => {
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
      const visibleAgents = expanded
        ? group.agents
        : group.agents.filter((agent) =>
          String(agent.sessionId || '').trim() === group.ownerId);
      return <section key={group.ownerId} className="workflows-models"
        data-agent-owner-session-id={group.ownerId}>
        <div className="workflows-section-head">
          <button type="button" className="agent-session-heading" aria-label={title}
            aria-expanded={expanded}
            data-lead-session-id={group.ownerId}
            onClick={() => setCollapsedOwnerIds((current) => {
              const next = new Set(current);
              if (next.has(group.ownerId)) next.delete(group.ownerId);
              else next.add(group.ownerId);
              return next;
            })}>
            <h2>{title}</h2>
            <span className="agent-session-chevron" aria-hidden="true">
              {expanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
            </span>
          </button>
        </div>
        <div className="schedules-list">
          {visibleAgents.map((agent, index) => <AgentPoolRow
            key={poolRowKey(agent, index)}
            agent={agent}
            clock={clock}
            ownerSessionId={group.ownerId}
            unread={unreadSessionIds?.has(String(agent.sessionId || '').trim()) === true}
            onPrefetchSession={onPrefetchSession}
            onOpenLeadSession={onOpenLeadSession}
            onOpenSession={onOpenSession} />)}
        </div>
      </section>;
    })}
  </div>;
}
