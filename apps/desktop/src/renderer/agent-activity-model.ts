// Agent activity model: the shared agent-pool store, live agent/shell
// summaries and the activity tree built from pool rows.
import type { DesktopAgentPoolRow, DesktopAgentPoolUsage, DesktopApi } from '../shared/contract';
import {
  createDesktopCancellationLedger,
  desktopAgentActivityState,
  desktopAgentCancelStatus,
  desktopAgentIdentity,
  desktopAgentStatus,
  hasPendingDesktopAgentWork,
  isActiveDesktopAgentEntry,
  isCancelUnconfirmedDesktopAgentEntry,
  isCancelledDesktopAgentEntry,
  isQueuedDesktopAgentEntry,
  type DesktopAgentActivityState,
  type DesktopAgentCancellationLedger,
} from '../shared/agent-activity';
import type { RecordValue } from './desktop-types';
import { record } from './record-utils';
import { timeMs } from './transcript-primitives';
import { sectionStoreFor } from './section-store';

interface AgentPoolStore {
  host?: DesktopApi;
  rows: DesktopAgentPoolRow[] | null;
  /** The rows the runtime lists now, the only list a dismissal may prune against: set by an inline pool, or by a read
   *  that completed for the latest publication; null while a stub's read is pending or failed, after a removal, and
   *  without sections. `rows` may still show cached rows meanwhile. */
  listing: DesktopAgentPoolRow[] | null;
  /** The `agentPool` entry last published (undefined: none, or removed). */
  entry: unknown;
  /** `rows` as the agent surfaces show them: a row whose only change is
   *  progress no surface shows (PROGRESS_ONLY_FIELDS) keeps its previous
   *  object, and the list keeps its identity while nothing shown changed. */
  view: DesktopAgentPoolRow[] | null;
  /** Advanced by every publication, a removal included; a read of an older one is dropped. */
  revision: number;
  started: boolean;
  /** Cancelled identities survive here, so a later pool snapshot cannot
   *  republish a stopped agent as working. */
  cancellations: DesktopAgentCancellationLedger;
  /** Each listed row's latest turn and plan (withoutEndedRunPlans). */
  runs: Map<string, AgentRun>;
  listeners: Set<() => void>;
  getSnapshot(): DesktopAgentPoolRow[] | null;
  getView(): DesktopAgentPoolRow[] | null;
  getListing(): DesktopAgentPoolRow[] | null;
  subscribe(listener: () => void): () => void;
}

const AGENT_POOL_STORES = new WeakMap<object, AgentPoolStore>();
const EMPTY_AGENT_POOL_STORE = createAgentPoolStore();

function createAgentPoolStore(host?: DesktopApi): AgentPoolStore {
  const rows = host ? null : [];
  const store: AgentPoolStore = {
    host,
    rows,
    view: rows,
    listing: null,
    entry: undefined,
    revision: 0,
    started: false,
    cancellations: createDesktopCancellationLedger(),
    runs: new Map(),
    listeners: new Set(),
    getSnapshot: () => store.rows,
    getView: () => store.view,
    getListing: () => store.listing,
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

/** Structural equality of two pool rows (plain JSON from the host). */
function samePoolValue(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (!left || !right || typeof left !== 'object' || typeof right !== 'object') return false;
  if (Array.isArray(left) !== Array.isArray(right)) return false;
  const leftKeys = Object.keys(left);
  if (leftKeys.length !== Object.keys(right).length) return false;
  return leftKeys.every(
    (key) =>
      Object.hasOwn(right, key) &&
      samePoolValue((left as Record<string, unknown>)[key], (right as Record<string, unknown>)[key])
  );
}

/** Fields that move with a running turn's progress and that no agent surface
 *  shows: the usage cue reads `ledgerToken` from the raw rows itself. */
const PROGRESS_ONLY_FIELDS: ReadonlySet<string> = new Set([
  'updatedAt',
  'progressAt',
  'progressStage',
  'progressTool',
  'stallWarnMs',
  'usage',
  'toolCalls',
  'ledgerToken',
]);

function shownFieldCount(row: DesktopAgentPoolRow): number {
  let count = 0;
  for (const key in row) if (Object.hasOwn(row, key) && !PROGRESS_ONLY_FIELDS.has(key)) count += 1;
  return count;
}

/** Equal in every field an agent surface shows. */
function sameShownRow(left: DesktopAgentPoolRow, right: DesktopAgentPoolRow): boolean {
  if (left === right) return true;
  for (const key in left) {
    if (!Object.hasOwn(left, key) || PROGRESS_ONLY_FIELDS.has(key)) continue;
    if (!Object.hasOwn(right, key) || !samePoolValue(left[key], right[key])) return false;
  }
  return shownFieldCount(left) === shownFieldCount(right);
}

/** `next` with each row that `same` finds unchanged replaced by its previous
 *  object; `previous` itself when no row changed. */
function shareRows(
  previous: DesktopAgentPoolRow[] | null,
  next: DesktopAgentPoolRow[],
  same: (prior: DesktopAgentPoolRow, row: DesktopAgentPoolRow) => boolean
): DesktopAgentPoolRow[] {
  if (!previous) return next;
  const identity = (row: DesktopAgentPoolRow) => `${row.sessionId}\0${desktopAgentIdentity(row)}`;
  const byIdentity = new Map(previous.map((row) => [identity(row), row]));
  let changed = previous.length !== next.length;
  const shared = next.map((row, index) => {
    const prior = byIdentity.get(identity(row));
    const kept = prior && same(prior, row) ? prior : row;
    if (kept !== previous[index]) changed = true;
    return kept;
  });
  return changed ? shared : previous;
}

/** A row that stays running keeps its run's origin: a snapshot (stale, or the
 *  first after a reconnect) that carries an older turn start or none must not
 *  move the elapsed backwards. A newer stamp is a new turn and wins. */
function keepRunOrigin(previous: DesktopAgentPoolRow[] | null, next: DesktopAgentPoolRow[]): DesktopAgentPoolRow[] {
  if (!previous) return next;
  const identity = (row: DesktopAgentPoolRow) => `${row.sessionId}\0${desktopAgentIdentity(row)}`;
  const byIdentity = new Map(previous.map((row) => [identity(row), row]));
  return next.map((row) => {
    const prior = byIdentity.get(identity(row));
    if (!prior || !isActiveDesktopAgentEntry(prior) || !isActiveDesktopAgentEntry(row)) return row;
    const origin = timeMs(prior.turnStartedAt);
    if (!origin || timeMs(row.turnStartedAt) >= origin) return row;
    return { ...row, turnStartedAt: prior.turnStartedAt };
  });
}

interface AgentRun {
  settled: boolean;
  todo: DesktopAgentPoolRow['todo'];
  /** The plan the last settled run ended with, while the run after it has written none. */
  ended: DesktopAgentPoolRow['todo'];
}

const SETTLED_RUN_STATES: ReadonlySet<DesktopAgentActivityState> = new Set(['idle', 'done', 'failed', 'cancelled']);

/** A restarted agent's row carries the plan its settled run left until the new
 *  run writes its own: that plan is not the work in hand, and is not shown. */
function withoutEndedRunPlans(runs: Map<string, AgentRun>, rows: DesktopAgentPoolRow[]): DesktopAgentPoolRow[] {
  const listed = new Set<string>();
  const shown = rows.map((row) => {
    const key = `${row.sessionId}\0${desktopAgentIdentity(row)}`;
    listed.add(key);
    const settled = SETTLED_RUN_STATES.has(desktopAgentActivityState(row));
    const run = runs.get(key);
    if (!run) {
      runs.set(key, { settled, todo: row.todo, ended: null });
      return row;
    }
    if (run.settled && hasPendingDesktopAgentWork(row)) run.ended = run.todo ?? null;
    if (hasPendingDesktopAgentWork(row) || settled) run.settled = settled;
    if (run.ended && row.todo && samePoolValue(row.todo, run.ended)) return { ...row, todo: null };
    run.ended = null;
    run.todo = row.todo;
    return row;
  });
  for (const key of runs.keys()) if (!listed.has(key)) runs.delete(key);
  return shown;
}

function publishAgentPool(store: AgentPoolStore, rows: DesktopAgentPoolRow[]): void {
  // Every snapshot passes the cancellation ledger: the daemon still reports a
  // cancelled session as running until its turn unwinds, and a snapshot that
  // shows it running again after the cancel is a stale report, not new work.
  const next = shareRows(
    store.rows,
    withoutEndedRunPlans(store.runs, keepRunOrigin(store.rows, store.cancellations.apply(rows))),
    samePoolValue
  );
  if (next === store.rows) return;
  store.rows = next;
  store.view = shareRows(store.view, next, sameShownRow);
  for (const listener of store.listeners) listener();
}

/** Publishes `rows` as the runtime's current listing. */
function publishAgentListing(store: AgentPoolStore, rows: DesktopAgentPoolRow[]): void {
  publishAgentPool(store, rows);
  store.listing = store.rows;
}

/** The pool is the core's `agentPool` section (desktop-services.md §9, §15 P6): every change is pushed, so
 *  there is no reconcile read. A host without sections shows an empty pool that is no listing. */
export function startAgentPool(store: AgentPoolStore): void {
  if (store.started) return;
  store.started = true;
  const sections = sectionStoreFor(store.host);
  if (!sections) {
    publishAgentPool(store, []);
    return;
  }
  const publish = (): void => {
    const entry = sections.get('agentPool');
    if (entry === store.entry) return;
    store.entry = entry;
    store.revision += 1;
    store.listing = null;
    if (!entry) return;
    if (Array.isArray(entry.value)) {
      publishAgentListing(store, entry.value as DesktopAgentPoolRow[]);
      return;
    }
    // A pool over the inline limit is a count-only stub: the rows are read through the list request. The rows held
    // meanwhile stay shown (null before any), and a read a newer publication overtook is dropped.
    const at = store.revision;
    void store.host?.listAgentPool?.().then(
      (rows) => {
        if (store.revision === at && Array.isArray(rows)) publishAgentListing(store, rows);
      },
      () => undefined
    );
  };
  sections.subscribe('agentPool', publish);
  // A store that already holds the pool (this consumer started late) announces nothing: read it now.
  publish();
  void sections.ready().then(publish);
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
  /** The route's model parameters (service tier, Daybreak…); absent when it has none. */
  modelParameters?: Record<string, string>;
  /** Per-route Auto reasoning; only an explicit `false` opts out. */
  autoEffort: boolean;
  tag: string;
  title: string;
  status: string;
  /** Lifecycle the surface must paint. `cancel-unconfirmed` rows stay live on
   *  purpose: their process is not proven gone. */
  state: DesktopAgentActivityState;
  queued: boolean;
  startedAt: number;
  turnStartedAt: number;
  sessionId: string;
  ownerSessionId: string;
  /** Cumulative session totals; null when the runtime does not know them. */
  usage: DesktopAgentPoolUsage | null;
  toolCalls: number | null;
}

function countOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}

/** The runtime's cumulative token totals of one row, or null when absent or malformed. */
function agentUsageTotals(value: unknown): DesktopAgentPoolUsage | null {
  const usage = record(value);
  const inputTokens = countOrNull(usage.inputTokens);
  const outputTokens = countOrNull(usage.outputTokens);
  const totalTokens = countOrNull(usage.totalTokens);
  if (inputTokens === null || outputTokens === null || totalTokens === null) return null;
  return { inputTokens, outputTokens, totalTokens };
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

function agentTaskId(entry: RecordValue): string {
  return String(entry.task_id || entry.taskId || '').trim();
}

// On Windows a git-bash background survivor is unreachable from JS and answers with
// SURVIVING_DESCENDANTS_UNREACHABLE_WARNING, so an unconfirmed cancel does not prove the process gone.
function agentCancelSignals(entries: ReadonlyArray<{ entry: RecordValue }>): {
  cancelled: Map<string, ReadonlySet<string> | null>;
  unconfirmedCancels: Map<string, string>;
} {
  const cancelledTasks = new Map<string, Set<string>>();
  const unconfirmedCancels = new Map<string, string>();
  for (const { entry } of entries) {
    if (!isCancelledDesktopAgentEntry(entry)) continue;
    const identity = desktopAgentIdentity(entry);
    if (!identity) continue;
    if (isCancelUnconfirmedDesktopAgentEntry(entry)) {
      unconfirmedCancels.set(identity, desktopAgentCancelStatus(entry) || 'cancel-unconfirmed');
    } else cancelledTasks.set(identity, (cancelledTasks.get(identity) ?? new Set()).add(agentTaskId(entry)));
  }
  // One unproven signal outranks a confirmed twin: nothing is proven gone.
  for (const identity of unconfirmedCancels.keys()) cancelledTasks.delete(identity);
  const cancelled = new Map<string, ReadonlySet<string> | null>();
  for (const [identity, tasks] of cancelledTasks) {
    const restarted =
      [...tasks].some(Boolean) &&
      entries.some(({ entry }) => {
        const taskId = agentTaskId(entry);
        return (
          Boolean(taskId) &&
          !tasks.has(taskId) &&
          desktopAgentIdentity(entry) === identity &&
          isActiveDesktopAgentEntry(entry)
        );
      });
    cancelled.set(identity, restarted ? tasks : null);
  }
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
  const taskId = agentTaskId(entry);
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
    ...(Object.keys(record(entry.modelParameters)).length
      ? { modelParameters: record(entry.modelParameters) as Record<string, string> }
      : {}),
    autoEffort: entry.autoEffort !== false,
    tag: tag || taskId,
    title: String(entry.title || '').trim(),
    status: unconfirmed || desktopAgentStatus(entry),
    state,
    // An unproven cancel is not queued work, whatever stage the row still says.
    queued: !unconfirmed && isQueuedDesktopAgentEntry(entry),
    startedAt: timeMs(entry.startedAt || entry.startTime || entry.createdAt),
    turnStartedAt: timeMs(entry.turnStartedAt),
    sessionId: String(entry.sessionId || '').trim(),
    ownerSessionId: String(entry.ownerSessionId || fallbackOwnerSessionId || '').trim(),
    usage: agentUsageTotals(entry.usage),
    toolCalls: countOrNull(entry.toolCalls),
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
    ...(current.modelParameters || next.modelParameters
      ? { modelParameters: current.modelParameters || next.modelParameters }
      : {}),
    autoEffort: current.autoEffort && next.autoEffort,
    tag: current.tag || next.tag,
    title: current.title || next.title,
    status:
      (next.state === 'cancel-unconfirmed' && current.state !== 'cancel-unconfirmed') ||
      (current.queued && !next.queued)
        ? next.status
        : current.status,
    // A twin that reports a pending user approval wins over plain work: the
    // agent is blocked on the user whichever row saw it first. A twin that
    // sees it parked on its background task likewise wins over running.
    state:
      next.state === 'cancel-unconfirmed' ||
      (next.state === 'needs-user' && current.state !== 'cancel-unconfirmed') ||
      (next.state === 'waiting' && current.state === 'running')
        ? next.state
        : current.state,
    queued: current.queued && next.queued,
    startedAt: current.startedAt || next.startedAt,
    turnStartedAt: current.turnStartedAt || next.turnStartedAt,
    sessionId: current.sessionId || next.sessionId,
    ownerSessionId: current.ownerSessionId || next.ownerSessionId,
    usage: current.usage ?? next.usage,
    toolCalls: current.toolCalls ?? next.toolCalls,
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
  const cancelledAttempt = (entry: RecordValue, identity: string) => {
    if (!identity || !cancelled.has(identity)) return false;
    const tasks = cancelled.get(identity);
    return !tasks || tasks.has(agentTaskId(entry));
  };
  entries.forEach(({ entry, index, worker }) => {
    const identity = desktopAgentIdentity(entry);
    if (cancelledAttempt(entry, identity)) return;
    const unconfirmed =
      (identity ? unconfirmedCancels.get(identity) : '') ||
      (isCancelUnconfirmedDesktopAgentEntry(entry) ? desktopAgentCancelStatus(entry) : '');
    if (!unconfirmed && !isActiveDesktopAgentEntry(entry)) return;
    if (!worker && identity) {
      const workerEntry = workerByIdentity.get(identity);
      if (
        workerEntry &&
        !cancelledAttempt(workerEntry, identity) &&
        (isActiveDesktopAgentEntry(workerEntry) || !isQueuedDesktopAgentEntry(entry))
      )
        return;
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

export interface IslandAgentRow {
  node: AgentActivityNode;
  state: DesktopAgentActivityState;
  waitingForTasks: boolean;
  /** Idle, done or cancelled. */
  finished: boolean;
}

/** What a session's agent keeps through its restarts (a follow-up, or a new session on its tag): when it was first
 *  listed, and its last known route, which a snapshot between turns can leave out. */
interface AgentPlace {
  /** Its first start stamp; Infinity while none is known. */
  at: number;
  /** First-seen order, breaking ties when siblings share a stamp or have none. */
  seq: number;
  kind: string;
  provider: string;
  model: string;
}

// Scoped per desktop host so live renderer sessions keep places across pool updates while isolated hosts stay independent.
const HOST_AGENT_PLACES = new WeakMap<object, Map<string, AgentPlace>>();
const FALLBACK_AGENT_PLACES = new Map<string, AgentPlace>();
let nextAgentPlaceSeq = 0;

function agentPlacesMap(): Map<string, AgentPlace> {
  const host = globalThis.window?.mixdogDesktop;
  if (!host || typeof host !== 'object') return FALLBACK_AGENT_PLACES;
  let places = HOST_AGENT_PLACES.get(host);
  if (!places) {
    places = new Map();
    HOST_AGENT_PLACES.set(host, places);
  }
  return places;
}

/** Releases remembered island places owned by or keyed to a deleted session. */
export function releaseAgentPlaces(sessionId: string): void {
  const clean = String(sessionId || '').trim();
  if (!clean) return;
  const places = agentPlacesMap();
  const prefix = `${clean}\0`;
  const suffix = `\0${clean}`;
  for (const key of [...places.keys()]) {
    if (key.startsWith(prefix) || key.endsWith(suffix)) places.delete(key);
  }
}

/** The place of `agent` among the agents of `ownerSessionId`, by its tag. */
export function agentPlace(ownerSessionId: string, agent: DesktopAgentPoolRow): AgentPlace {
  const places = agentPlacesMap();
  const key = `${ownerSessionId}\0${desktopAgentIdentity(agent) || poolSessionId(agent)}`;
  const kind = agentRoleLabel(agent.agent || agent.tag);
  let place = places.get(key);
  if (!place) {
    place = { at: Number.POSITIVE_INFINITY, seq: ++nextAgentPlaceSeq, kind, provider: '', model: '' };
    places.set(key, place);
  }
  const stamp = timeMs(agent.createdAt) || timeMs(agent.startedAt);
  if (stamp && stamp < place.at) place.at = stamp;
  // A closed row still sitting in the pool may seed an empty route, never overwrite a live replacement's.
  if (agent.released === true) {
    if (place.kind === kind && !place.provider && !place.model && (agent.provider || agent.model)) {
      place.provider = String(agent.provider || '');
      place.model = String(agent.model || '');
    }
  } else {
    if (place.kind !== kind) {
      place.kind = kind;
      place.provider = '';
      place.model = '';
    }
    if (agent.provider || agent.model) {
      place.provider = String(agent.provider || '');
      place.model = String(agent.model || '');
    }
  }
  return place;
}

const ISLAND_AGENT_STATES: ReadonlySet<DesktopAgentActivityState> = new Set([
  'queued',
  'running',
  'needs-user',
  'waiting',
  'cancel-unconfirmed',
  // The pool could not prove a worker that still claims work is alive; that
  // is not idle, so the row stays until the pool settles it.
  'unknown',
]);

/** Whether any descendant of `node`, at any depth, still has work in flight. */
export function descendantsHavePendingWork(node: AgentActivityNode): boolean {
  return node.children.some((child) => hasPendingDesktopAgentWork(child.agent) || descendantsHavePendingWork(child));
}

const ISLAND_ROWS = new WeakMap<readonly DesktopAgentPoolRow[], Map<string, IslandAgentRow[]>>();
const NO_ISLAND_ROWS: IslandAgentRow[] = [];

/** The agents the composer island lists for one session: its group in the
 *  Agents window (same grouping, nesting and depth-first order) minus the
 *  session's own Lead row, finished agents included but agents the Lead
 *  closed (`released`) left out. Each top-level subtree stays whole, and
 *  siblings stand in the order they were first listed (agentPlace): work
 *  starting, ending or restarting moves no row.
 *  Built once per pool list and session: every surface of the session shares it. */
export function islandAgentRows(
  pool: readonly DesktopAgentPoolRow[] | null | undefined,
  ownerSessionId: string
): IslandAgentRow[] {
  if (!pool) return NO_ISLAND_ROWS;
  let bySession = ISLAND_ROWS.get(pool);
  if (!bySession) {
    bySession = new Map();
    ISLAND_ROWS.set(pool, bySession);
  }
  let rows = bySession.get(ownerSessionId);
  if (!rows) {
    rows = buildIslandAgentRows(pool, ownerSessionId);
    bySession.set(ownerSessionId, rows);
  }
  return rows;
}

function buildIslandAgentRows(pool: readonly DesktopAgentPoolRow[], ownerSessionId: string): IslandAgentRow[] {
  const group = agentActivityGroups(pool, (id) => id === ownerSessionId).find(
    (candidate) => candidate.ownerId === ownerSessionId
  );
  if (!group) return NO_ISLAND_ROWS;
  const placed = (nodes: readonly AgentActivityNode[]) => {
    for (const node of nodes) agentPlace(ownerSessionId, node.agent);
    return [...nodes].sort((a, b) => {
      const left = agentPlace(ownerSessionId, a.agent);
      const right = agentPlace(ownerSessionId, b.agent);
      if (left.at !== right.at) return left.at - right.at;
      return left.seq - right.seq;
    });
  };
  const walk = (nodes: readonly AgentActivityNode[]): IslandAgentRow[] =>
    placed(nodes).flatMap((node) => {
      const waitingForTasks = descendantsHavePendingWork(node);
      const state = desktopAgentActivityState(node.agent, { waitingForTasks });
      // The session's own Lead row and agents the Lead closed are not listed;
      // a closed agent's subtree is still walked (a reused descendant shows).
      const unlisted = node.sessionId === ownerSessionId || node.agent.released === true;
      const row = { node, state, waitingForTasks, finished: !ISLAND_AGENT_STATES.has(state) };
      return [...(unlisted ? [] : [row]), ...walk(node.children)];
    });
  // The Lead's children are the units under a Lead row; otherwise the top rows.
  return walk(group.nodes.flatMap((node) => (node.sessionId === ownerSessionId ? node.children : [node])));
}

/** Depth-first render order: a parent is immediately followed by its subtree. */
export function flattenAgentActivityNodes(nodes: readonly AgentActivityNode[]): AgentActivityNode[] {
  return nodes.flatMap((node) => [node, ...flattenAgentActivityNodes(node.children)]);
}

/** Rendered rows in depth-first order, opening only explicitly expanded rows. */
export function visibleAgentTreeRows(
  nodes: readonly AgentActivityNode[],
  expandedSessionIds: ReadonlySet<string>
): AgentActivityNode[] {
  return nodes.flatMap((node) =>
    expandedSessionIds.has(node.sessionId) ? [node, ...visibleAgentTreeRows(node.children, expandedSessionIds)] : [node]
  );
}

function poolRowSeedAt(agent: DesktopAgentPoolRow): number {
  const idle = timeMs(agent.idleSince);
  if (idle) return idle;
  return timeMs(agent.createdAt) || timeMs(agent.startedAt) || timeMs(agent.turnStartedAt);
}

/** Ordering stamp for one owner group; it only advances, when a newer turn start or completion lands. */
export function stickyGroupOrder(
  previous: ReadonlyMap<string, number>,
  ownerId: string,
  agents: readonly DesktopAgentPoolRow[]
): number {
  const prior = previous.get(ownerId) || 0;
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
