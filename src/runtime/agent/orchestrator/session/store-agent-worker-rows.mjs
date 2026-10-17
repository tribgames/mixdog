/**
 * Projection of the durable worker indexes (agent-workers.json,
 * lead-workers.json) into the process-global active pool: the status
 * vocabulary, the live-work evidence a working row needs, frozen idle stamps,
 * the per-file session header cache and the orphan-child prune.
 *
 * Whether a session is working is the daemon's in-memory turn activity (every
 * session runs inline there), handed in as `runningSessionIds`: a running
 * session is working whatever its durable row declares, except that an
 * explicit cancel outranks it. A declared-working row the daemon does not
 * report as in flight reads `unknown` — without the daemon's answer nothing
 * is guessed.
 *
 * Assembly order lives in store-agent-worker-pool.mjs; this module owns the
 * row-level truth each projected row carries. Every status string, index
 * field name and row key is a consumed contract and is used verbatim.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { probePath, PROBE_PRESENT } from './store/fs-probe.mjs';
import { readJsonProjection } from '../../../shared/pending-json-projection.mjs';
import { listStoredAgentWorkers as assembleStoredAgentWorkers } from './store-agent-worker-pool.mjs';
import {
  TAG_TOMBSTONE_TTL_MS,
  agentPaneVisible,
  findTagTombstone,
  tagTombstoneKey,
  tombstoneBlocksWork,
} from '../../../shared/agent-reap-state.mjs';
import { dataDir, storedAgentWorkerIndexPath, storedLeadWorkerIndexPath } from './store-summary-locations.mjs';
import { cleanValue, isStoredSessionId, positiveNumber } from './store-summary-fields.mjs';
import { sessionUsageTotals } from '../../../shared/session-usage-totals.mjs';

const WORKING_AGENT_STATUS =
  /^(?:connecting|requesting|streaming|tool[-_\s]?running|running|queued|pending|starting|cancelling)$/i;
// Confirmed cancel vs a cancel whose stop is not proven. Neither is ever
// shown as `running`, and the two must stay distinct: `cancel-unconfirmed` is
// the honest Windows git-bash-survivor answer, not a successful cancel.
const CANCELLED_AGENT_STATUS = /^(?:cancelled|canceled|killed)$/i;
// Bare `cancelling` is still working (ACTIVE_STAGES). Only an explicit
// unconfirmed/pending cancel is a distinct terminal-unconfirmed outcome.
const CANCEL_UNCONFIRMED_AGENT_STATUS = /^(?:cancel[-_\s]?(?:unconfirmed|pending))$/i;
// A turn that did not finish (error, timeout, watchdog stop, dead runtime):
// dead like a completion, but it stays visible as the failure it is.
const FAILED_AGENT_STATUS = /^(?:error|fail|failed|timeout)$/i;
// A turn that finished normally. The row rests as `idle` (or an equivalent
// done status) and is listed as `completed` for the pane window.
const COMPLETED_AGENT_STATUS = /^(?:idle|done|complete|completed|success)$/i;
const SESSION_CANCEL_FIELDS = [
  'cancelStatus',
  'status',
  'state',
  'lastStatus',
  'stage',
  'outcome',
  'terminationReason',
];
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

/** The worker's lifecycle. `status` decides; `stage` is only the runtime phase
 *  copied in by the progress sweep, so mid-work it may read idle/done/error
 *  beside a worker that is still running. Only a row with no status falls
 *  back to its stage. */
function workerLifecycle(row) {
  return cleanValue(row?.status) || cleanValue(row?.stage);
}

function failedAgentWorker(row) {
  return FAILED_AGENT_STATUS.test(workerLifecycle(row));
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

function workStampMs(source) {
  if (!source || typeof source !== 'object') return 0;
  return Math.max(stampMs(source.turnStartedAt), stampMs(source.startedAt));
}

function cancelStampMs(source) {
  if (!source || typeof source !== 'object') return 0;
  return Math.max(stampMs(source.cancelledAt), stampMs(source.finishedAt));
}

/** When a settled agent finished: its finish/cancel/failure stamp, else its
 *  last update. The index row decides; the session header only fills a gap. */
function finishedAtMs(row, session = null) {
  return cancelStampMs(row) || stampMs(row?.updatedAt) || cancelStampMs(session) || stampMs(session?.updatedAt);
}

/** The cancel one source (index row or session header) records, or null.
 *  An unconfirmed stop outranks a confirmed one so a stop that was never
 *  proven is not reported as success. `cancelling` alone is working and is
 *  not a cancel. */
function cancelState(source) {
  if (!source || typeof source !== 'object') return null;
  const statuses = SESSION_CANCEL_FIELDS.map((key) => cleanValue(source[key])).filter(Boolean);
  const status =
    statuses.find((value) => CANCEL_UNCONFIRMED_AGENT_STATUS.test(value)) ||
    statuses.find((value) => CANCELLED_AGENT_STATUS.test(value)) ||
    '';
  return status ? { status, at: cancelStampMs(source) } : null;
}

/** The cancel that still holds across the index row and its session header:
 *  the unconfirmed one when the sources disagree (the row first otherwise).
 *  Only demonstrably newer work — a turn/start stamp strictly after a stamped
 *  cancel — supersedes it; an unstamped cancel is never superseded. */
function effectiveCancel(row, session) {
  const rowCancel = cancelState(row);
  const sessionCancel = cancelState(session);
  const cancel =
    rowCancel && sessionCancel && CANCEL_UNCONFIRMED_AGENT_STATUS.test(sessionCancel.status)
      ? CANCEL_UNCONFIRMED_AGENT_STATUS.test(rowCancel.status)
        ? rowCancel
        : sessionCancel
      : rowCancel || sessionCancel;
  if (!cancel) return null;
  const newerWork = cancel.at > 0 && Math.max(workStampMs(row), workStampMs(session)) > cancel.at;
  return newerWork ? null : cancel;
}

/** The stage shown beside a cancel: a stage that itself names the cancel (or
 *  the `cancelling` phase) is kept, any other phase is the cancel. */
function cancelStage(cancel, declaredStage) {
  return /^cancel/i.test(declaredStage) || CANCELLED_AGENT_STATUS.test(declaredStage) ? declaredStage : cancel.status;
}

function storedAgentWorkerIndex() {
  const path = storedAgentWorkerIndexPath();
  // This process's own queued (not yet persisted) writes win over the file.
  const projected = readJsonProjection(path);
  if (projected) return projected;
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
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
      if (!isStoredSessionId(sessionId) || (!parentSessionId && !ownerSessionId)) {
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
  'autoEffort',
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
  'totalInputTokens',
  'totalOutputTokens',
  'totalToolCalls',
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

/** Whether the daemon reports the session's turn in flight. */
function sessionRunning(sessionId, { runningSessionIds }) {
  return runningSessionIds instanceof Set && runningSessionIds.has(sessionId);
}

/** An already projected row is live work: its projected status is working
 *  only when the daemon reported it running (otherwise it reads `unknown`). */
function poolRowWorking(row) {
  return WORKING_AGENT_STATUS.test(workerLifecycle(row));
}

/** A child worker-index row projected into the pool, or null. A finished
 *  child — completed, cancelled or failed — stays listed for the pane window
 *  after its finish stamp so consumers see the outcome instead of the row
 *  vanishing; unconfirmed cancels are not dead and keep their own status. */
function projectChildWorkerRow(row, context) {
  if (!row || typeof row !== 'object') return null;
  if (cleanValue(row.agent).toLowerCase() === 'lead') return null;
  const sessionId = cleanValue(row.sessionId);
  const tag = cleanValue(row.tag);
  if (!sessionId || !tag || !isStoredSessionId(sessionId)) return null;
  // A stale done/error row does not hide a child the daemon is running. The
  // header is read before any pane-window cutoff: an expired row can still sit
  // beside a header that records a cancel-unconfirmed (possibly running)
  // process. A new row may precede its first session save (null header).
  const session = readWorkerSessionHeader(sessionId);
  const declaredStatus = cleanValue(row.status) || 'running';
  const declaredStage = cleanValue(row.stage || row.status) || 'running';
  const declaredWorking = WORKING_AGENT_STATUS.test(workerLifecycle(row) || 'running');
  // A cancel in the row (any field, stage included) or in the durable session
  // header holds until demonstrably newer work supersedes it.
  const cancel = effectiveCancel(row, session);
  // The daemon's in-memory run state is authoritative: a running session is
  // working whatever the durable row says. Only an explicit cancel outranks it.
  const working = !cancel && sessionRunning(sessionId, context);
  const completed = COMPLETED_AGENT_STATUS.test(workerLifecycle(row));
  const unconfirmedCancel = Boolean(cancel) && CANCEL_UNCONFIRMED_AGENT_STATUS.test(cancel.status);
  if (!working && !unconfirmedCancel && (cancel || !declaredWorking)) {
    // Settled: only a completed, failed or cancelled outcome is listed, and
    // only inside the pane window.
    if (!cancel && !completed && !failedAgentWorker(row)) return null;
    if (!agentPaneVisible(finishedAtMs(row, session), context.now)) return null;
  }
  let shownStatus = declaredStatus;
  let shownStage = declaredStage;
  if (cancel) {
    shownStatus = cancel.status;
    shownStage = cancelStage(cancel, declaredStage);
  } else if (working) {
    if (!declaredWorking) shownStatus = shownStage = 'running';
  } else if (declaredWorking) {
    shownStatus = shownStage = 'unknown';
  } else if (completed) {
    shownStatus = shownStage = 'completed';
  }
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
    ...(row.autoEffort === false || session?.autoEffort === false ? { autoEffort: false } : {}),
    status: shownStatus,
    stage: shownStage,
    // A live turn blocked on the user's approval (persisted by the agent
    // tool's worker index); never carried by a row that is no longer working.
    ...(working && row.awaitingUser === 'approval' ? { awaitingUser: 'approval' } : {}),
    // Why a settled failed row failed; a row working again has no failure.
    ...(!working && failedAgentWorker(row) && cleanValue(row.failureReason)
      ? { failureReason: cleanValue(row.failureReason) }
      : {}),
    startedAt: row.startedAt || row.createdAt || session?.createdAt || null,
    turnStartedAt: working ? row.turnStartedAt || null : null,
    createdAt: row.createdAt || session?.createdAt || null,
    updatedAt: row.updatedAt || session?.updatedAt || null,
    idleSince: frozenIdleSince(sessionId, working, row.finishedAt || row.updatedAt || session?.updatedAt || null),
    reapAt: row.reapAt || null,
    cwd: cleanValue(row.cwd || session?.cwd) || null,
    clientHostPid: positiveNumber(row.clientHostPid || session?.clientHostPid, 0) || null,
    taskId: cleanValue(row.task_id || row.taskId) || null,
    ...sessionUsageTotals(session),
  };
}

function storedLeadWorkerRows() {
  const path = storedLeadWorkerIndexPath();
  let parsed = readJsonProjection(path);
  if (!parsed) {
    try {
      parsed = JSON.parse(readFileSync(path, 'utf8'));
    } catch {
      /* no resident Lead pool */
    }
  }
  return workerRows(parsed);
}

/** A Lead-index row whose durable session turned out to be an agent's.
 *  Legacy Lead rows may predate a durable session record (no header). */
function leadRowOwnedByAgent(sessionId) {
  const header = readWorkerSessionHeader(sessionId);
  const owner = cleanValue(header?.owner).toLowerCase();
  const agent = cleanValue(header?.agent).toLowerCase();
  return owner === 'agent' || Boolean(agent && agent !== 'lead');
}

/** A Lead worker-index row projected into the pool, or null. */
function projectLeadWorkerRow(row, context) {
  const { now } = context;
  if (!row || typeof row !== 'object') return null;
  const sessionId = cleanValue(row.sessionId);
  if (!sessionId || !isStoredSessionId(sessionId)) return null;
  if (leadRowOwnedByAgent(sessionId)) return null;
  const declaredStatus = workerLifecycle(row) || 'idle';
  const declaredWorking = WORKING_AGENT_STATUS.test(declaredStatus);
  // As for child rows: an explicit cancel outranks the daemon's running report.
  const cancel = effectiveCancel(row, null);
  const working = !cancel && sessionRunning(sessionId, context);
  // Live work outlasts the pane window; a settled Lead is listed for it after
  // its finish stamp, whatever its provider reap window is.
  if (!working && !agentPaneVisible(finishedAtMs(row), now)) return null;
  let shownStatus = declaredStatus;
  if (cancel) shownStatus = cancel.status;
  else if (working) shownStatus = declaredWorking ? declaredStatus : 'running';
  else if (declaredWorking) shownStatus = 'unknown';
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
    ...(row.autoEffort === false ? { autoEffort: false } : {}),
    status: shownStatus,
    stage: shownStatus,
    startedAt: row.startedAt || row.createdAt || null,
    turnStartedAt: working ? row.turnStartedAt || null : null,
    createdAt: row.createdAt || null,
    updatedAt: row.updatedAt || null,
    idleSince: frozenIdleSince(sessionId, working, row.finishedAt || row.updatedAt || null),
    cwd: cleanValue(row.cwd) || null,
    clientHostPid: positiveNumber(row.clientHostPid, 0) || null,
    taskId: cleanValue(row.task_id || row.taskId) || null,
    ...sessionUsageTotals(readWorkerSessionHeader(sessionId)),
  };
}

/** A child row is a projection of its Lead. Once the Lead's row is gone (its
 *  lease was reaped, or the Lead runtime that owned it exited), leaving the
 *  child in the pool paints it as a top-level Agent-window row with no Lead
 *  above it (user report). Only a Lead CONVERSATION owner is judged — and a
 *  child that is still working always stays, so live work never disappears
 *  from the window. */
function pruneOrphanChildRows(bySessionId, { liveLeadSessionIds }) {
  for (const [sessionId, row] of [...bySessionId]) {
    if (cleanValue(row.agent).toLowerCase() === 'lead') continue;
    const ownerSessionId = cleanValue(row.ownerSessionId);
    if (!ownerSessionId || liveLeadSessionIds.has(ownerSessionId)) continue;
    if (!leadConversationHeader(readWorkerSessionHeader(ownerSessionId))) continue;
    if (poolRowWorking(row)) continue;
    bySessionId.delete(sessionId);
  }
}

/** Process-global active agent pool: the living rows (running or idle) of the
 * child and Lead indexes. No runtime starts and durable session history is
 * never projected into either pool. `runningSessionIds` is the daemon's set of
 * sessions whose turn is in flight; omitted, no row is shown as running. */
export function listStoredAgentWorkers({ runningSessionIds = null } = {}) {
  const now = Date.now();
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
    runningSessionIds,
    storedAgentWorkerIndexRows: () => rows.filter((row) => !isReaped(cleanValue(row.sessionId))),
    projectChildWorkerRow,
    storedLeadWorkerRows,
    projectLeadWorkerRow,
    pruneOrphanChildRows,
  });
}
