/**
 * Projection of the durable worker indexes (agent-workers.json,
 * lead-workers.json) and the heartbeat sidecars into the process-global
 * active pool: the status vocabulary, the 2-minute heartbeat lease and its
 * authority rules, cancel ranking, frozen idle stamps, the per-file session
 * header cache and the orphan-child prune.
 *
 * Assembly order lives in store-agent-worker-pool.mjs; this module owns the
 * row-level truth each projected row carries. Every status string, index
 * field name and row key is a consumed contract and is used verbatim.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { probePath, PROBE_PRESENT } from './store/fs-probe.mjs';
import { listStoredAgentWorkers as assembleStoredAgentWorkers } from './store-agent-worker-pool.mjs';
import {
  TAG_TOMBSTONE_TTL_MS,
  findTagTombstone,
  tagTombstoneKey,
  tombstoneBlocksWork,
} from '../../../shared/agent-reap-state.mjs';
import {
  dataDir,
  sessionHeartbeatMtimes,
  storedAgentWorkerIndexPath,
  storedLeadWorkerIndexPath,
} from './store-summary-locations.mjs';
import { cleanValue, positiveNumber } from './store-summary-fields.mjs';

const DEAD_AGENT_STATUS =
  /^(?:done|complete|completed|success|closed|error|fail|failed|cancelled|canceled|killed|timeout)$/i;
const LIVING_AGENT_STATUS =
  /^(?:idle|connecting|requesting|streaming|tool[-_\s]?running|running|queued|pending|starting|cancelling)$/i;
const WORKING_AGENT_STATUS =
  /^(?:connecting|requesting|streaming|tool[-_\s]?running|running|queued|pending|starting|cancelling)$/i;
// Confirmed cancel vs a cancel whose stop is not proven. The heartbeat lease
// must never rewrite either as `running`, and the two must stay distinct:
// `cancel-unconfirmed` is the honest Windows git-bash-survivor answer, not a
// successful cancel.
const CANCELLED_AGENT_STATUS = /^(?:cancelled|canceled|killed)$/i;
// Bare `cancelling` is still working (ACTIVE_STAGES). Only an explicit
// unconfirmed/pending cancel is a distinct terminal-unconfirmed outcome.
const CANCEL_UNCONFIRMED_AGENT_STATUS = /^(?:cancel[-_\s]?(?:unconfirmed|pending))$/i;
const SESSION_CANCEL_FIELDS = [
  'cancelStatus',
  'status',
  'state',
  'lastStatus',
  'stage',
  'outcome',
  'terminationReason',
];
const AGENT_POOL_HEARTBEAT_FRESH_MS = 2 * 60 * 1000;

function runtimeAlive(pid) {
  const id = positiveNumber(pid, 0);
  if (id <= 0 || id === process.pid) return true;
  try {
    process.kill(id, 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
}

function workerOwnerSessionId(row, session) {
  return (
    cleanValue(row?.ownerSessionId || session?.ownerSessionId || row?.parentSessionId || session?.parentSessionId) ||
    null
  );
}

function workerParentSessionId(row, session) {
  return (
    cleanValue(row?.parentSessionId || session?.parentSessionId || row?.ownerSessionId || session?.ownerSessionId) ||
    null
  );
}

// Frozen idle stamps: without finishedAt the idle moment fell back to the
// MUTABLE updatedAt, so every background save advanced the dock's ordering
// stamp and idle groups kept reshuffling (user: 유휴인데 목록이 깜빡인다).
// The first observation freezes the fallback; a row seen working clears it so
// the NEXT idle moment is stamped fresh.
const stickyIdleSince = new Map(); // sessionId -> stamp
const STICKY_IDLE_CAP = 512;
function frozenIdleSince(sessionId, working, fallback) {
  if (working) {
    stickyIdleSince.delete(sessionId);
    return null;
  }
  if (stickyIdleSince.has(sessionId)) return stickyIdleSince.get(sessionId);
  const value = fallback || null;
  stickyIdleSince.set(sessionId, value);
  if (stickyIdleSince.size > STICKY_IDLE_CAP) {
    stickyIdleSince.delete(stickyIdleSince.keys().next().value);
  }
  return value;
}

function agentStatusValues(row) {
  return [row?.stage, row?.status]
    .map(cleanValue)
    .filter((status, index, values) => Boolean(status) && values.indexOf(status) === index);
}

function activeAgentWorker(row) {
  const statuses = agentStatusValues(row);
  return (
    statuses.length > 0 &&
    !statuses.some((status) => DEAD_AGENT_STATUS.test(status)) &&
    statuses.some((status) => LIVING_AGENT_STATUS.test(status))
  );
}

function stampMs(value) {
  if (typeof value === 'number') return Number.isFinite(value) && value > 0 ? value : 0;
  const text = cleanValue(value);
  if (!text) return 0;
  const numeric = Number(text);
  if (Number.isFinite(numeric) && numeric > 0 && !/^\d{4}-/.test(text)) return numeric;
  const parsed = Date.parse(text);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

function workStampMs(row) {
  if (!row || typeof row !== 'object') return 0;
  return Math.max(stampMs(row.turnStartedAt), stampMs(row.startedAt));
}

function cancelStampMs(row) {
  if (!row || typeof row !== 'object') return 0;
  return Math.max(stampMs(row.cancelledAt), stampMs(row.finishedAt));
}

/** Confirmed cancel yields to unconfirmed when both are present so a
 *  still-tearing-down or unobservable stop is never reported as success.
 *  `cancelling` alone is working and is not a cancel. */
function sessionCancelState(row) {
  if (!row || typeof row !== 'object') return null;
  const statuses = SESSION_CANCEL_FIELDS.map((key) => cleanValue(row[key])).filter(
    (status, index, values) => Boolean(status) && values.indexOf(status) === index
  );
  const status =
    statuses.find((value) => CANCEL_UNCONFIRMED_AGENT_STATUS.test(value)) ||
    statuses.find((value) => CANCELLED_AGENT_STATUS.test(value)) ||
    '';
  if (!status) return null;
  return { status, at: cancelStampMs(row) };
}

/** Rank two cancel states: an unconfirmed stop always outranks a confirmed
 *  one, so no source can report success for a kill another source could not
 *  prove. Same-class states keep the index row (`a`) as the richer source. */
function preferUnconfirmedCancel(a, b) {
  if (!a) return b || null;
  if (!b) return a;
  const aUnconfirmed = CANCEL_UNCONFIRMED_AGENT_STATUS.test(a.status);
  const bUnconfirmed = CANCEL_UNCONFIRMED_AGENT_STATUS.test(b.status);
  if (aUnconfirmed === bUnconfirmed) return a;
  return aUnconfirmed ? a : b;
}

function storedAgentWorkerIndex() {
  let parsed = null;
  try {
    parsed = JSON.parse(readFileSync(storedAgentWorkerIndexPath(), 'utf8'));
  } catch {
    return null;
  }
  return parsed;
}

function storedAgentWorkerIndexRows() {
  return workerRows(storedAgentWorkerIndex());
}

/** A worker index stores its rows as a list or as an id-keyed map. */
function workerRows(parsed) {
  if (Array.isArray(parsed?.workers)) return parsed.workers;
  return parsed?.workers && typeof parsed.workers === 'object' ? Object.values(parsed.workers) : [];
}

/** Lightweight ancestry seam used to migrate pre-parentSessionId summary
 * rows. It reads only agent-workers.json and never opens session transcripts. */
export function listStoredAgentWorkerLinks() {
  return storedAgentWorkerIndexRows()
    .map((row) => {
      if (!row || typeof row !== 'object') return null;
      const sessionId = cleanValue(row.sessionId);
      const parentSessionId = cleanValue(row.parentSessionId);
      const ownerSessionId = cleanValue(row.ownerSessionId || row.parentSessionId);
      if (!/^[A-Za-z0-9_-]+$/.test(sessionId) || (!parentSessionId && !ownerSessionId)) {
        return null;
      }
      return {
        sessionId,
        parentSessionId: parentSessionId || ownerSessionId,
        ownerSessionId: ownerSessionId || parentSessionId,
      };
    })
    .filter(Boolean);
}

// The agent pool only reads top-level session fields, yet each refresh used to
// JSON.parse every active worker's whole transcript (megabytes per worker,
// every catalog publish). Cache the header per file fingerprint instead.
const WORKER_HEADER_CACHE_MAX = 256;
const workerSessionHeaderCache = new Map();
// Pool rows need identity, routing, and lifecycle metadata only. Keeping the
// rest of a session here also retained its tool catalogs and provider state.
const WORKER_HEADER_FIELDS = [
  'owner',
  'agent',
  'sourceType',
  'ownerSessionId',
  'parentSessionId',
  'title',
  'provider',
  'model',
  'effort',
  'fast',
  'createdAt',
  'updatedAt',
  'cwd',
  'clientHostPid',
  'agentTag',
  'task_id',
  'taskId',
  'turnStartedAt',
  'startedAt',
  'cancelledAt',
  'finishedAt',
  ...SESSION_CANCEL_FIELDS,
];

function readWorkerSessionHeader(sessionId) {
  const path = join(dataDir(), 'sessions', `${sessionId}.json`);
  const probe = probePath(path);
  if (probe.state !== PROBE_PRESENT) return null;
  const cached = workerSessionHeaderCache.get(path);
  if (cached && cached.mtimeMs === probe.mtimeMs && cached.size === probe.size) {
    // Refresh insertion order so the eviction below stays LRU-ish.
    workerSessionHeaderCache.delete(path);
    workerSessionHeaderCache.set(path, cached);
    return cached.header;
  }
  let session = null;
  try {
    session = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
  if (!session || typeof session !== 'object') return null;
  const header = {};
  for (const field of WORKER_HEADER_FIELDS) {
    if (Object.hasOwn(session, field)) header[field] = session[field];
  }
  workerSessionHeaderCache.set(path, { mtimeMs: probe.mtimeMs, size: probe.size, header });
  if (workerSessionHeaderCache.size > WORKER_HEADER_CACHE_MAX) {
    workerSessionHeaderCache.delete(workerSessionHeaderCache.keys().next().value);
  }
  return header;
}

/** Owner record of a child row that is a Lead CONVERSATION. Only such an owner
 *  lets a missing pool row mean "the Lead's lease expired"; an Agent-owned or
 *  unreadable owner keeps its child rows visible exactly as before. */
function leadConversationHeader(header) {
  if (!header || typeof header !== 'object') return false;
  const owner = cleanValue(header.owner).toLowerCase();
  const agent = cleanValue(header.agent).toLowerCase();
  return owner !== 'agent' && (agent === 'lead' || cleanValue(header.sourceType).toLowerCase() === 'lead');
}

const withinPoolWindow = (at, now) => at > 0 && now - at <= AGENT_POOL_HEARTBEAT_FRESH_MS;
const POOL_SESSION_ID = /^[A-Za-z0-9_-]+$/;

/** Live-work proof for an already projected row: a fresh heartbeat sidecar, or
 *  a working status whose own stamp is still inside the pool window. */
function poolRowWorking(row, heartbeatMtimes, now) {
  if (withinPoolWindow(heartbeatMtimes.get(cleanValue(row?.sessionId)) || 0, now)) return true;
  if (!WORKING_AGENT_STATUS.test(cleanValue(row?.stage || row?.status))) return false;
  return withinPoolWindow(Date.parse(cleanValue(row?.updatedAt)) || 0, now);
}

/** A child worker-index row projected into the pool, or null. Cancelled rows
 *  stay visible so the 2-minute heartbeat lease cannot resurrect them as
 *  `running` once DEAD_AGENT_STATUS would have dropped them from the map;
 *  unconfirmed cancels are not dead, but also must not be overwritten by the
 *  sidecar. */
function projectChildWorkerRow(row, { now, heartbeatMtimes }) {
  if (!row || typeof row !== 'object') return null;
  if (!activeAgentWorker(row) && !sessionCancelState(row)) return null;
  if (cleanValue(row.agent).toLowerCase() === 'lead') return null;
  const sessionId = cleanValue(row.sessionId);
  const tag = cleanValue(row.tag);
  if (!sessionId || !tag || !POOL_SESSION_ID.test(sessionId)) return null;
  // A new row may precede its first session save (null header).
  const session = readWorkerSessionHeader(sessionId);
  const declaredStatus = cleanValue(row.status) || 'running';
  const declaredStage = cleanValue(row.stage || row.status) || 'running';
  const declaredWorking = WORKING_AGENT_STATUS.test(declaredStatus) || WORKING_AGENT_STATUS.test(declaredStage);
  const heartbeatFresh = withinPoolWindow(heartbeatMtimes.get(sessionId) || 0, now);
  const recentlyUpdated = withinPoolWindow(Date.parse(cleanValue(row.updatedAt)) || 0, now);
  const runtimePid = positiveNumber(row.runtimePid, 0);
  const working = declaredWorking && (!runtimePid || runtimeAlive(runtimePid)) && (heartbeatFresh || recentlyUpdated);
  return {
    tag,
    sessionId,
    // Root ownership and immediate ancestry are independent. Nested
    // descendants keep the Lead/root owner while pointing at the Agent
    // session that directly spawned them.
    ownerSessionId: workerOwnerSessionId(row, session),
    parentSessionId: workerParentSessionId(row, session),
    title: cleanValue(row.title || session?.title) || null,
    agent: cleanValue(row.agent || session?.agent) || null,
    provider: cleanValue(row.provider || session?.provider) || null,
    model: cleanValue(row.model || session?.model) || null,
    effort: cleanValue(row.effort || session?.effort) || null,
    fast: row.fast === true || session?.fast === true,
    status: declaredWorking && !working ? 'unknown' : declaredStatus,
    stage: declaredWorking && !working ? 'unknown' : declaredStage,
    startedAt: row.startedAt || row.createdAt || session?.createdAt || null,
    turnStartedAt: working ? row.turnStartedAt || null : null,
    createdAt: row.createdAt || session?.createdAt || null,
    updatedAt: row.updatedAt || session?.updatedAt || null,
    idleSince: frozenIdleSince(sessionId, working, row.finishedAt || row.updatedAt || session?.updatedAt || null),
    reapAt: row.reapAt || null,
    cwd: cleanValue(row.cwd || session?.cwd) || null,
    clientHostPid: positiveNumber(row.clientHostPid || session?.clientHostPid, 0) || null,
    taskId: cleanValue(row.task_id || row.taskId) || null,
  };
}

/** The row a fresh heartbeat sidecar publishes over the current index row. */
function sidecarWorkerRow(
  current,
  session,
  { sessionId, heartbeatAt, ownerSessionId, parentSessionId, agent, status }
) {
  return {
    ...current,
    tag: cleanValue(session?.agentTag) || cleanValue(current.tag) || `${agent || 'agent'}:${sessionId}`,
    sessionId,
    ownerSessionId,
    parentSessionId,
    title: cleanValue(session?.title) || current.title || null,
    agent: agent || current.agent || null,
    provider: cleanValue(session?.provider) || current.provider || null,
    model: cleanValue(session?.model) || current.model || null,
    effort: cleanValue(session?.effort) || current.effort || null,
    fast: session?.fast === true || current.fast === true,
    status,
    stage: status,
    startedAt: session?.createdAt || current.startedAt || heartbeatAt,
    turnStartedAt: current.turnStartedAt || null,
    createdAt: session?.createdAt || current.createdAt || null,
    updatedAt: heartbeatAt,
    cwd: cleanValue(session?.cwd) || current.cwd || null,
    clientHostPid: positiveNumber(session?.clientHostPid, 0) || current.clientHostPid || null,
    taskId: cleanValue(session?.task_id || session?.taskId) || current.taskId || null,
  };
}

/** Promote one fresh heartbeat sidecar into the pool.
 *
 *  The durable index row is authoritative for FINISHED work: a worker's
 *  runtime unloads at turn end but its heartbeat sidecar stays fresh for up to
 *  the 2-minute window, and overwriting an idle row to `running` here made
 *  every completed agent show as working and then flip back — the dock read as
 *  blinking (user: 유휴인데 계속 살아있고 깜빡인다). The sidecar promotes only
 *  rows the index does not already mark idle. A cancel is the same class of
 *  authority: the lease must not rewrite cancelled / cancel-unconfirmed as
 *  running at any point. Bare `cancelling` stays working. Genuinely new work is
 *  a strictly later turn/start stamp, not a heartbeat-rewritten updatedAt. */
function promoteHeartbeatSidecar(bySessionId, sessionId, heartbeatAt) {
  const session = readWorkerSessionHeader(sessionId);
  if (!session) return;
  const current = bySessionId.get(sessionId) || {};
  const ownerSessionId = workerOwnerSessionId(current, session);
  const parentSessionId = workerParentSessionId(current, session);
  const owner = cleanValue(session?.owner).toLowerCase();
  const agent = cleanValue(session?.agent);
  if (!ownerSessionId || (owner !== 'agent' && (!agent || agent === 'lead'))) return;
  const identity = { sessionId, heartbeatAt, ownerSessionId, parentSessionId, agent };
  // An UNCONFIRMED cancel outranks a confirmed one whichever side holds it.
  // Taking the index row first let a row still stamped `cancelled` MASK the
  // durable `cancel-unconfirmed` on the session, reporting a stop that was
  // never proven as a success. Never the reverse: a confirmed row only wins
  // when the session is not unconfirmed.
  const currentCancel = sessionCancelState(current);
  const cancel = preferUnconfirmedCancel(currentCancel, sessionCancelState(session));
  const newerWork = Boolean(cancel?.at) && (workStampMs(current) > cancel.at || workStampMs(session) > cancel.at);
  if (cancel && !newerWork) {
    // A cancel outranks a leftover heartbeat. Newer work is only a strictly
    // later turn/start stamp — never updatedAt, which the sidecar rewrites
    // every tick.
    if (currentCancel) return;
    bySessionId.set(sessionId, sidecarWorkerRow(current, session, { ...identity, status: cancel.status }));
    return;
  }
  const currentStatus = cleanValue(current.stage || current.status);
  if (currentStatus && !WORKING_AGENT_STATUS.test(currentStatus)) return;
  // The sidecar is the live lease. Durable child sessions are intentionally
  // detached/closed while their external owner runs.
  bySessionId.set(sessionId, sidecarWorkerRow(current, session, { ...identity, status: 'running' }));
}

function storedLeadWorkerRows() {
  let parsed = null;
  try {
    parsed = JSON.parse(readFileSync(storedLeadWorkerIndexPath(), 'utf8'));
  } catch {
    /* no resident Lead pool */
  }
  return workerRows(parsed);
}

/** A Lead-index row whose durable session turned out to be an agent's. */
function leadRowOwnedByAgent(sessionId) {
  try {
    const session = JSON.parse(readFileSync(join(dataDir(), 'sessions', `${sessionId}.json`), 'utf8'));
    const owner = cleanValue(session?.owner).toLowerCase();
    const agent = cleanValue(session?.agent).toLowerCase();
    return owner === 'agent' || Boolean(agent && agent !== 'lead');
  } catch {
    /* legacy Lead rows may predate a durable session record */
    return false;
  }
}

/** A Lead worker-index row projected into the pool, or null. */
function projectLeadWorkerRow(row, { now, heartbeatMtimes }) {
  if (!row || typeof row !== 'object') return null;
  const sessionId = cleanValue(row.sessionId);
  if (!sessionId || !POOL_SESSION_ID.test(sessionId)) return null;
  if (leadRowOwnedByAgent(sessionId)) return null;
  const heartbeatAt = heartbeatMtimes.get(sessionId) || 0;
  const heartbeatFresh = withinPoolWindow(heartbeatAt, now);
  const recentlyUpdated = withinPoolWindow(Date.parse(cleanValue(row.updatedAt)) || 0, now);
  const declaredStatus = cleanValue(row.stage || row.status) || 'idle';
  const working = WORKING_AGENT_STATUS.test(declaredStatus) && (heartbeatFresh || recentlyUpdated);
  const reapAt = Date.parse(cleanValue(row.reapAt)) || 0;
  if (!heartbeatFresh && reapAt > 0 && now >= reapAt) return null;
  return {
    tag: `lead:${sessionId}`,
    sessionId,
    ownerSessionId: sessionId,
    parentSessionId: null,
    agent: 'lead',
    provider: cleanValue(row.provider) || null,
    model: cleanValue(row.model) || null,
    effort: cleanValue(row.effort) || null,
    fast: row.fast === true,
    status: !working && WORKING_AGENT_STATUS.test(declaredStatus) ? 'unknown' : declaredStatus,
    stage: !working && WORKING_AGENT_STATUS.test(declaredStatus) ? 'unknown' : declaredStatus,
    startedAt: row.startedAt || row.createdAt || null,
    turnStartedAt: working ? row.turnStartedAt || null : null,
    createdAt: row.createdAt || null,
    updatedAt: working ? heartbeatAt || row.updatedAt || null : row.updatedAt || null,
    idleSince: frozenIdleSince(sessionId, working, row.finishedAt || row.updatedAt || null),
    cwd: cleanValue(row.cwd) || null,
    clientHostPid: positiveNumber(row.clientHostPid, 0) || null,
    taskId: cleanValue(row.task_id || row.taskId) || null,
  };
}

/** A child row is a projection of its Lead. Once the Lead's row is gone (its
 *  lease was reaped, or the Lead runtime that owned it exited), leaving the
 *  child in the pool paints it as a top-level Agent-window row with no Lead
 *  above it (user report). Only a Lead CONVERSATION owner is judged — and a
 *  child that is still working always stays, so live work never disappears
 *  from the window. */
function pruneOrphanChildRows(bySessionId, { liveLeadSessionIds, heartbeatMtimes, now }) {
  for (const [sessionId, row] of [...bySessionId]) {
    if (cleanValue(row.agent).toLowerCase() === 'lead') continue;
    const ownerSessionId = cleanValue(row.ownerSessionId);
    if (!ownerSessionId || liveLeadSessionIds.has(ownerSessionId)) continue;
    if (!leadConversationHeader(readWorkerSessionHeader(ownerSessionId))) continue;
    if (poolRowWorking(row, heartbeatMtimes, now)) continue;
    bySessionId.delete(sessionId);
  }
}

/** Process-global active agent pool. Fresh child heartbeat sidecars are the
 * cross-process running source even when their durable session is detached
 * (`closed`) and a terminal reaper has already removed the worker-index row.
 * The child and Lead indexes remain additive for living rows (running or idle)
 * published before the heartbeat or by runtimes without a sidecar. No runtime
 * starts and durable session history is never projected into either pool. */
export function listStoredAgentWorkers() {
  const now = Date.now();
  const heartbeatMtimes = sessionHeartbeatMtimes();
  const index = storedAgentWorkerIndex();
  const rows = workerRows(index);
  const byId = new Map(rows.map((row) => [cleanValue(row.sessionId), row]));
  const tombstones = new Map(
    Object.values(index?.tombstones || {})
      .filter((row) => row && stampMs(row.reapedAt) >= now - TAG_TOMBSTONE_TTL_MS)
      .map((row) => [tagTombstoneKey(row), row])
  );
  const isReaped = (sessionId) => {
    const header = readWorkerSessionHeader(sessionId) || {};
    const row = byId.get(sessionId);
    const work = {
      ...header,
      ...row,
      parentSessionId: workerParentSessionId(row, header),
      ownerSessionId: workerOwnerSessionId(row, header),
      clientHostPid: row?.clientHostPid || header.clientHostPid,
      createdAt: row?.createdAt || header.createdAt,
      turnStartedAt: row?.turnStartedAt || header.turnStartedAt,
    };
    return tombstoneBlocksWork(work, findTagTombstone(work, tombstones));
  };
  return assembleStoredAgentWorkers({
    now,
    heartbeatMtimes,
    storedAgentWorkerIndexRows: () => rows.filter((row) => !isReaped(cleanValue(row.sessionId))),
    projectChildWorkerRow,
    promoteHeartbeatSidecar: (bySessionId, sessionId, heartbeatAt) => {
      if (withinPoolWindow(heartbeatAt, now) && !isReaped(sessionId)) {
        promoteHeartbeatSidecar(bySessionId, sessionId, heartbeatAt);
      }
    },
    storedLeadWorkerRows,
    projectLeadWorkerRow,
    pruneOrphanChildRows,
  });
}
