// Agent activity model: the shared agent-pool store, live agent/shell
// summaries and the activity tree built from pool rows.
import type { DesktopAgentPoolRow, DesktopApi } from '../shared/contract';
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
import type { RecordValue } from './desktop-types';
import { record } from './record-utils';
import { timeMs } from './TranscriptView';

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
      return () => {
        store.listeners.delete(listener);
      };
    },
  };
  return store;
}

export function agentPoolStore(host?: DesktopApi): AgentPoolStore {
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
  store.rows = store.cancellations.apply(Array.isArray(rows) ? (rows as DesktopAgentPoolRow[]) : []);
  for (const listener of store.listeners) listener();
}

export function refreshAgentPool(store: AgentPoolStore): Promise<void> {
  if (store.inFlight) return store.inFlight;
  const listAgentPool = store.host?.listAgentPool;
  if (typeof listAgentPool !== 'function') {
    publishAgentPool(store, []);
    return Promise.resolve();
  }
  const revision = store.revision;
  const request = Promise.resolve(listAgentPool())
    .then((rows) => {
      if (revision === store.revision) publishAgentPool(store, rows);
    })
    .catch(() => {
      if (revision === store.revision && store.rows === null) publishAgentPool(store, []);
    })
    .finally(() => {
      if (store.inFlight === request) store.inFlight = undefined;
    });
  store.inFlight = request;
  return request;
}

export function startAgentPool(store: AgentPoolStore): void {
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

export function agentRoleLabel(value: unknown): string {
  const role = String(value || '').trim();
  if (!role) return 'Agent';
  return role
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map((part) => `${part.slice(0, 1).toLocaleUpperCase()}${part.slice(1)}`)
    .join(' ');
}

// A CONFIRMED cancel is the last word about that identity. Worker and job
// rows for one agent settle at different moments, so a cancelled job
// routinely arrives beside a worker row that still says `running` (and vice
// versa); taking the active row would keep the stopped agent on the live
// surfaces forever. Collected BEFORE the active filter and the merge, so
// neither the entry order nor the status preference in the merge can
// resurrect it.
// An UNCONFIRMED cancel (`cancelling`, `cancel-unconfirmed`) is the opposite
// case: the process is not proven gone — on Windows a git-bash background
// survivor is unreachable from JS and answers with
// SURVIVING_DESCENDANTS_UNREACHABLE_WARNING — so dropping it would hide a
// possibly still-live agent. Those rows stay, carrying their own state.
function agentCancelSignals(entries: ReadonlyArray<{ entry: RecordValue }>): {
  cancelled: Set<string>;
  unconfirmedCancels: Map<string, string>;
} {
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
  return { cancelled, unconfirmedCancels };
}

function liveAgentSummary(
  entry: RecordValue,
  {
    identity,
    index,
    unconfirmed,
    fallbackOwnerSessionId,
  }: {
    identity: string;
    index: number;
    unconfirmed: string;
    fallbackOwnerSessionId: string;
  }
): LiveAgentSummary {
  const tag = String(entry.tag || '').trim();
  const taskId = String(entry.task_id || entry.taskId || '').trim();
  const roleValue = String(entry.agent || entry.name || entry.type || '').trim();
  const state: DesktopAgentActivityState = unconfirmed ? 'cancel-unconfirmed' : desktopAgentActivityState(entry);
  return {
    key: identity || `${roleValue || 'agent'}-${index}`,
    role: agentRoleLabel(roleValue),
    roleId: roleValue.toLowerCase(),
    model: String(entry.model || '').trim(),
    provider: String(entry.provider || '').trim(),
    effort: String(entry.effort || '').trim(),
    fast: entry.fast === true,
    tag: tag || taskId,
    status: unconfirmed || desktopAgentStatus(entry),
    state,
    // An unproven cancel is not queued work, whatever stage the row still says.
    queued: !unconfirmed && isQueuedDesktopAgentEntry(entry),
    startedAt: timeMs(entry.startedAt || entry.startTime || entry.createdAt),
    turnStartedAt: timeMs(entry.turnStartedAt),
    sessionId: String(entry.sessionId || '').trim(),
    ownerSessionId: String(entry.ownerSessionId || fallbackOwnerSessionId || '').trim(),
  };
}

// Worker and job rows for one agent merge field by field: the earlier row's
// values win except where the later row carries the stronger signal.
function mergeLiveAgentSummary(current: LiveAgentSummary, next: LiveAgentSummary): LiveAgentSummary {
  return {
    ...current,
    role: current.role === 'Agent' ? next.role : current.role,
    roleId: current.roleId || next.roleId,
    model: current.model || next.model,
    provider: current.provider || next.provider,
    effort: current.effort || next.effort,
    fast: current.fast || next.fast,
    tag: current.tag || next.tag,
    // Keeping the earlier status is safe ONLY because a confirmed cancel
    // never reaches this merge (see agentCancelSignals) and an unconfirmed
    // one wins here: whichever twin reports it, the merge can never fall
    // back to the live twin's status.
    status:
      (next.state === 'cancel-unconfirmed' && current.state !== 'cancel-unconfirmed') ||
      (current.queued && !next.queued)
        ? next.status
        : current.status,
    state: next.state === 'cancel-unconfirmed' ? next.state : current.state,
    queued: current.queued && next.queued,
    startedAt: current.startedAt || next.startedAt,
    turnStartedAt: current.turnStartedAt || next.turnStartedAt,
    sessionId: current.sessionId || next.sessionId,
    ownerSessionId: current.ownerSessionId || next.ownerSessionId,
  };
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
  const { cancelled, unconfirmedCancels } = agentCancelSignals(entries);
  entries.forEach(({ entry, index, worker }) => {
    const identity = desktopAgentIdentity(entry);
    if (identity && cancelled.has(identity)) return;
    const unconfirmed =
      (identity ? unconfirmedCancels.get(identity) : '') ||
      (isCancelUnconfirmedDesktopAgentEntry(entry) ? desktopAgentCancelStatus(entry) : '');
    if (!unconfirmed && !isActiveDesktopAgentEntry(entry)) return;
    if (!worker && identity) {
      const workerEntry = workerByIdentity.get(identity);
      if (workerEntry && (isActiveDesktopAgentEntry(workerEntry) || !isQueuedDesktopAgentEntry(entry))) return;
    }
    const next = liveAgentSummary(entry, { identity, index, unconfirmed, fallbackOwnerSessionId });
    const current = mapped.get(next.key);
    mapped.set(next.key, current ? mergeLiveAgentSummary(current, next) : next);
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
  return jobs
    .flatMap((value) => {
      const entry = record(value);
      const key = String(entry.taskId || entry.task_id || '').trim();
      if (!key) return [];
      return [
        {
          key,
          // One popover row per job: a multi-line command turned the fixed-width
          // popover into a wall of wrapped text.
          command: String(entry.command || '')
            .replace(/\s+/g, ' ')
            .trim(),
          cwd: String(entry.cwd || '').trim(),
          startedAt: timeMs(entry.startedAt) || 0,
        },
      ];
    })
    .sort(
      (left, right) =>
        (left.startedAt || Number.MAX_SAFE_INTEGER) - (right.startedAt || Number.MAX_SAFE_INTEGER) ||
        left.key.localeCompare(right.key)
    );
}

export function liveShellCount(snapshot: unknown): number {
  return Math.max(0, Number(record(record(snapshot).shellJobs).count) || 0);
}

export function liveTaskCount(snapshot: unknown): number {
  return liveAgentRows(snapshot).length + liveShellCount(snapshot);
}

export function poolRowKey(agent: DesktopAgentPoolRow, index: number): string {
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

interface AgentActivityGroup {
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
function agentRootSessionId(
  agent: DesktopAgentPoolRow,
  rowsBySessionId: ReadonlyMap<string, DesktopAgentPoolRow>,
  isOwnerSession: (sessionId: string) => boolean
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

// When the owner's own Lead row is present it is the visible root of the
// group, so every other row hangs beneath it: Lead → direct child →
// descendant. Without a Lead row the direct children ARE the top level.
function groupAgentRows(
  ownerId: string,
  agents: readonly DesktopAgentPoolRow[]
): { top: DesktopAgentPoolRow[]; childrenByParent: Map<string, DesktopAgentPoolRow[]> } {
  const idsInGroup = new Set(agents.map(poolSessionId).filter(Boolean));
  const childrenByParent = new Map<string, DesktopAgentPoolRow[]>();
  const top: DesktopAgentPoolRow[] = [];
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
    if (sessionId && parent && parent !== sessionId && parent !== ownerId && idsInGroup.has(parent)) {
      attach(parent, agent);
      continue;
    }
    if (leadRow) attach(ownerId, agent);
    else top.push(agent);
  }
  return { top, childrenByParent };
}

function agentTreeNodes(ownerId: string, agents: readonly DesktopAgentPoolRow[]): AgentActivityNode[] {
  const { top, childrenByParent } = groupAgentRows(ownerId, agents);
  const placed = new Set<string>();
  const build = (rows: readonly DesktopAgentPoolRow[], depth: number, parentId: string): AgentActivityNode[] => {
    const ordered = [...rows].sort(leadFirst).filter((agent) => {
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
        children:
          depth < MAX_AGENT_TREE_DEPTH && sessionId
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
  isOwnerSession: (sessionId: string) => boolean
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
export function flattenAgentActivityNodes(nodes: readonly AgentActivityNode[]): AgentActivityNode[] {
  return nodes.flatMap((node) => [node, ...flattenAgentActivityNodes(node.children)]);
}

/** Rendered rows in depth-first order, opening only explicitly expanded rows.
 *  This is the list the tree's roving focus walks, so the
 *  keyboard can only ever reach rows that are actually painted. */
export function visibleAgentTreeRows(
  nodes: readonly AgentActivityNode[],
  expandedSessionIds: ReadonlySet<string>
): AgentActivityNode[] {
  return nodes.flatMap((node) =>
    expandedSessionIds.has(node.sessionId) ? [node, ...visibleAgentTreeRows(node.children, expandedSessionIds)] : [node]
  );
}

/** Seed placement for a group the dock has never ranked: the moment it was
 *  CREATED (user decision: 생성기준으로 정렬). A row that already settled
 *  carries its idle stamp instead, so a completed session seeds where its
 *  work actually finished rather than where it began. */
function poolRowSeedAt(agent: DesktopAgentPoolRow): number {
  const idle = timeMs(agent.idleSince);
  if (idle) return idle;
  // A working row has NO idle stamp, and its updatedAt is the live heartbeat:
  // ranking on it made every running session climb on each tick, so cards
  // leapfrogged mid-turn (user: 위아래로 튄다). Creation is frozen for the
  // whole lifetime, so a live row holds its place until it stops.
  return timeMs(agent.createdAt) || timeMs(agent.startedAt) || timeMs(agent.turnStartedAt);
}

/** Sticky ordering stamp for one owner group. The pool decides `working` from
 *  a 2-minute heartbeat freshness window, so `idleSince` can vanish and come
 *  back mid-turn and a raw ranking swapped rows on every flip (user: 하트비트
 *  때문에 뒤죽박죽). A group's stamp therefore only ever ADVANCES, and only
 *  when a genuinely newer turn start or completion lands. */
export function stickyGroupOrder(
  previous: ReadonlyMap<string, number>,
  ownerId: string,
  agents: readonly DesktopAgentPoolRow[]
): number {
  const prior = previous.get(ownerId) || 0;
  // Two moments move a group, and both are FROZEN values: the turn it started
  // and the moment it went idle (user decision: 작업 시작 시 1회, 완료 시 1회).
  // The live heartbeat in updatedAt stays out of the ranking, so a running
  // session climbs once and then holds its slot for the whole turn.
  const moment = Math.max(0, ...agents.map((agent) => Math.max(timeMs(agent.idleSince), timeMs(agent.turnStartedAt))));
  if (moment > prior) return moment;
  if (prior) return prior;
  // First sighting: seed from the frozen creation stamp so a brand-new group
  // lands at the top by age instead of the bottom.
  return Math.max(0, ...agents.map(poolRowSeedAt));
}

function visibleAgentActivityRow(agent: DesktopAgentPoolRow): boolean {
  const identity = String(agent.agent || String(agent.tag || '').split(':')[0] || '')
    .trim()
    .toLowerCase()
    .replace(/[\s_]+/g, '-');
  return identity !== 'maintainer' && identity !== 'web-search' && identity !== 'websearch';
}
