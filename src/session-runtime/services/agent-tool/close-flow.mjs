import {
  cancelBackgroundTask,
  cleanupBackgroundTasks,
  getBackgroundTask,
  listBackgroundTasks,
  onBackgroundTasksEvicted,
  taskIdFromArgs,
} from '../../../runtime/shared/background-tasks.mjs';
import { agentScope, agentTagOf, clean, clearAgentStatuslineRoute, sessionMatchesContext } from './helpers.mjs';
import { isLeadPoolAgent } from './worker-rows.mjs';
import { isOpenIdleRow } from './job-views/agent-list.mjs';
import { archivedSessions, forgetGoneHidden, hideSessions } from './close-flow/hide-sessions.mjs';
import { createCloseAll } from './close-flow/close-all.mjs';

const CLOSE_REASON = 'cancelled by agent close';

// close / cleanup / closeAll: tearing workers down without leaving lingering
// worker rows or tasks that would republish a closed session as `running`.
export function createCloseFlow({ mgr, registry, views }) {
  const { tags, tagAgents } = registry;

  // Stale local metadata only: resolveTag found no session in this
  // terminal/scope, so there is no sessionId-safe worker row to delete. Never
  // turn it into a tag-wide persisted-row removal.
  // `tags`/`tagAgents` are shared by every caller on the canonical agent, so a
  // binding alone does not prove the caller owns it: only a live session or a
  // persisted row inside the caller's scope does. Another session's tag must
  // stay untouched.
  function tagBoundByCaller(target, scopedContext) {
    const live = registry.getLiveSession(tags.get(target));
    if (live) return sessionMatchesContext(live, scopedContext);
    return registry.readWorkerRows(scopedContext).some((row) => clean(row.tag) === target);
  }

  function forgetStaleLocalTag(target, task) {
    registry.unbindTag(target);
    if (task?.taskId) cancelBackgroundTask(task.taskId, CLOSE_REASON);
    return { closed: true, forgotten: true, tag: target, sessionId: null, task_id: task?.taskId || null };
  }

  // Cancel any running background task bound to this session BEFORE closing
  // the session. Otherwise closeSession rejects the in-flight runSpawn with
  // "Session closed: closeSession" and the catch path reconciles the task as
  // `failed` — a user-initiated close must surface as `cancelled` instead.
  function cancelSessionTasks(sessionId, target, scopedContext) {
    for (const row of listBackgroundTasks({ surface: 'agent', context: scopedContext })) {
      if (row.sessionId !== sessionId && row.tag !== target) continue;
      cancelBackgroundTask(row.task_id, CLOSE_REASON);
    }
  }

  function dropGoneRow(tag, sessionId) {
    registry.removeWorkerRow({ tag, sessionId });
    if (tag) registry.unbindTag(tag);
    lostResults.delete(sessionId);
  }

  // A deleted session has nothing left to close: only its row and tag remain.
  // Only a manager that asks the store can say so: a descriptor outlives its
  // deleted session, and is absent until the stored agents are loaded.
  const sessionGone = async (sessionId) => (await mgr.sessionGone?.(sessionId)) === true;

  /** `keepRow`: a process exit closes the worker but leaves its row (and its
   *  descendants') for the next process (close-all.mjs). */
  async function close(args, context = {}, { keepRow = false } = {}) {
    const scopedContext = agentScope(args, context);
    registry.refreshTagsFromSessions({ scanSessions: registry.wantsSessionScan(args), context: scopedContext });
    const taskId = taskIdFromArgs(args);
    const task = taskId ? getBackgroundTask(taskId, { surface: 'agent', context }) : null;
    const taskMeta = task?.meta || {};
    const target = clean(args.tag || args.sessionId || taskMeta.sessionId);
    if (!target) {
      if (task?.taskId) {
        cancelBackgroundTask(task.taskId, CLOSE_REASON);
        return { closed: true, tag: taskMeta.tag || null, sessionId: null, task_id: task.taskId };
      }
      throw new Error('agent close: tag or sessionId is required');
    }
    const sessionId = registry.resolveTag(target, scopedContext, { scanSessions: registry.wantsSessionScan(args) });
    if (!sessionId) {
      if (!target.startsWith('sess_') && tagAgents.has(target) && tagBoundByCaller(target, scopedContext)) {
        return forgetStaleLocalTag(target, task);
      }
      throw new Error(`agent close: target "${target}" not found`);
    }
    if (isLeadPoolAgent(registry.getLiveSession(sessionId)?.agent)) {
      throw new Error(`agent close: target "${target}" is a Lead session`);
    }
    const tag = registry.tagForSession(sessionId);
    if (await sessionGone(sessionId)) {
      dropGoneRow(tag || (target.startsWith('sess_') ? '' : target), sessionId);
      if (task?.taskId) cancelBackgroundTask(task.taskId, CLOSE_REASON);
      return {
        closed: true,
        sessionGone: true,
        note: 'the session was already gone; its row was dropped',
        tag,
        sessionId,
        task_id: task?.taskId || null,
      };
    }
    const descendantSessionIds =
      typeof mgr.descendantSessionIds === 'function' ? mgr.descendantSessionIds(sessionId) : [];
    let hideFailed = [];
    clearAgentStatuslineRoute(sessionId);
    cancelSessionTasks(sessionId, target, scopedContext);
    // Close (and stamp cancelStatus) BEFORE dropping the worker row, so the
    // row never outlives an unrecorded cancel. The explicit task_id cancel
    // below is an idempotent no-op fallback once terminal.
    // Closing a runtime cancels its work; only explicit session deletion
    // may tombstone the conversation.
    // An owner's close (not a process exit's) is recorded on the session itself,
    // so a later reuse of its reaped tag never continues it.
    const ok = await mgr.closeSession(sessionId, 'cli-agent-close', {
      tombstone: false,
      ...(keepRow ? {} : { ownerClose: true }),
    });
    if (task?.taskId) cancelBackgroundTask(task.taskId, CLOSE_REASON);
    // Drop the row only once the cancellation is DURABLY recorded: a failed
    // close that still forgot the row would leave no cancelled state behind.
    if (ok && !keepRow) {
      registry.forgetTerminalSession(tag, sessionId);
      for (const descendantSessionId of descendantSessionIds) {
        registry.removeWorkerRow({ sessionId: descendantSessionId });
      }
      // The sessions stay open (a send reuses them), so a later scan, even
      // after a restart, would list them again: remember the owner closed them.
      registry.markReleased([sessionId, ...descendantSessionIds]);
      hideFailed = (await hideSessions([sessionId, ...descendantSessionIds])).failed;
    }
    const base = { closed: ok, tag, sessionId, task_id: task?.taskId || null };
    if (!ok) return { ...base, reason: closeFailureReason(sessionId) };
    return hideFailed.length ? { ...base, hideFailed } : base;
  }

  // The barrier failure closeSession recorded on the runtime entry.
  function closeFailureReason(sessionId) {
    return mgr.getSessionRuntime?.(sessionId)?.closeBarrierError?.message || 'the session close was not recorded';
  }

  function rowContext(row) {
    const owner = clean(row.parentSessionId || row.ownerSessionId);
    if (owner) return { callerSessionId: owner };
    return row.clientHostPid ? { clientHostPid: row.clientHostPid } : {};
  }

  // Agents (session id, and the owner's tag) whose undelivered task was pruned:
  // a missing task never reads as delivered. A tag is one owner's: another
  // Lead's agent under the same tag is not held by it.
  const lostResults = new Set();
  const lostTagKey = (ownerSessionId, tag) => `tag:${clean(ownerSessionId)}\n${tag}`;
  onBackgroundTasksEvicted((evicted) => {
    for (const task of evicted) {
      if (task.surface !== 'agent') continue;
      // A later delivered result supersedes an earlier lost one.
      const mark = task.delivered ? (key) => lostResults.delete(key) : (key) => lostResults.add(key);
      if (task.agentSessionId) mark(task.agentSessionId);
      if (task.tag) mark(lostTagKey(task.sessionId, task.tag));
    }
  });

  // A result counts as delivered once its newest task is cancelled by the
  // owner or its completion went out with the body. With no task left, it is
  // delivered unless the task was pruned undelivered.
  function resultDelivered(row, scopedContext) {
    let latest = null;
    for (const summary of listBackgroundTasks({ surface: 'agent', context: scopedContext })) {
      if (summary.sessionId !== row.sessionId && summary.tag !== row.tag) continue;
      if (!latest || Date.parse(summary.startedAt) >= Date.parse(latest.startedAt)) latest = summary;
    }
    const task = latest && getBackgroundTask(latest.task_id, { surface: 'agent', context: scopedContext });
    if (!task) {
      const owner = row.parentSessionId || row.ownerSessionId || scopedContext?.callerSessionId;
      return !lostResults.has(row.sessionId) && !(row.tag && lostResults.has(lostTagKey(owner, row.tag)));
    }
    if (task.status === 'running') return false;
    return task.status === 'cancelled' || task.notifiedWithBody === true || task.completionAcknowledged === true;
  }

  /** Closes an idle agent whose last result was delivered. Resolves
   *  `{ state: 'closed' | 'gone' | 'busy' | 'undelivered' | 'failed', reason?, hideFailed? }`
   *  (`hideFailed`: the closed sessions that stay listed, with the reason). */
  async function releaseIdle(row, scopedContext = rowContext(row)) {
    if (await sessionGone(row.sessionId)) {
      dropGoneRow(clean(row.tag), row.sessionId);
      return { state: 'gone' };
    }
    if (mgr.isSessionTurnInFlight?.(row.sessionId) === true) return { state: 'busy' };
    if (!resultDelivered(row, scopedContext)) return { state: 'undelivered' };
    try {
      const result = await close({ sessionId: row.sessionId }, scopedContext);
      if (result.sessionGone) return { state: 'gone' };
      return result.closed
        ? { state: 'closed', hideFailed: result.hideFailed || [] }
        : { state: 'failed', reason: result.reason };
    } catch (error) {
      return { state: 'failed', reason: error?.message || String(error) };
    }
  }

  /** The idle timer's release: an idle agent whose last result was delivered
   *  gives up its runtime (provider connection, shells, caches, live session)
   *  but stays open, listed and unhidden; a send resumes it from disk. Same
   *  states as releaseIdle, `parked` instead of `closed`. */
  async function parkIdle(row, scopedContext = rowContext(row)) {
    if (await sessionGone(row.sessionId)) {
      dropGoneRow(clean(row.tag), row.sessionId);
      return { state: 'gone' };
    }
    if (mgr.isSessionTurnInFlight?.(row.sessionId) === true) return { state: 'busy' };
    if (!resultDelivered(row, scopedContext)) return { state: 'undelivered' };
    try {
      return (await mgr.parkSession?.(row.sessionId))
        ? { state: 'parked' }
        : { state: 'failed', reason: 'the session runtime could not be released' };
    } catch (error) {
      return { state: 'failed', reason: error?.message || String(error) };
    }
  }

  // Idle records of the caller's agents that no worker row points to (what
  // earlier closes left open): hidden, not closed.
  async function hideLeftovers(scopedContext) {
    const archived = await archivedSessions();
    const pointed = new Set([...registry.readWorkerRows({}).map((row) => clean(row.sessionId)), ...tags.values()]);
    const leftovers = [];
    for (const session of mgr.listSessions?.() || []) {
      const id = clean(session.id);
      if (!id || pointed.has(id) || archived[id] !== undefined) continue;
      if (!agentTagOf(session) || isLeadPoolAgent(session.agent) || !sessionMatchesContext(session, scopedContext)) continue;
      if ((clean(session.status) || 'idle') !== 'idle' || mgr.isSessionTurnInFlight?.(id) === true) continue;
      const row = { sessionId: id, tag: agentTagOf(session) };
      if (resultDelivered(row, scopedContext)) leftovers.push(id);
    }
    const { hidden, failed } = await hideSessions(leftovers);
    return { hidden: hidden.length, failed };
  }

  async function cleanup(args = {}, context = {}) {
    const scopedContext = agentScope(args, context);
    const beforeTags = tags.size;
    registry.refreshTagsFromSessions({ scanSessions: registry.wantsSessionScan(args), context: scopedContext });
    const cleaned = cleanupBackgroundTasks({ surface: 'agent', context: scopedContext, force: args.force === true });
    let agentsClosed = 0;
    let goneRowsCleared = 0;
    const notClosed = [];
    const notHidden = [];
    for (const row of [...registry.readWorkerRows(scopedContext)]) {
      const sessionId = clean(row.sessionId);
      if (!sessionId) continue;
      // A row of any status whose session was deleted is only a leftover.
      if (await sessionGone(sessionId)) {
        cancelSessionTasks(sessionId, sessionId, scopedContext);
        dropGoneRow(clean(row.tag), sessionId);
        goneRowsCleared += 1;
        continue;
      }
      if (!isOpenIdleRow(row)) continue;
      const { state, reason, hideFailed = [] } = await releaseIdle(row, scopedContext);
      if (state === 'closed') agentsClosed += 1;
      else if (state === 'gone') goneRowsCleared += 1;
      else if (state === 'failed') notClosed.push({ tag: row.tag || null, sessionId, reason });
      for (const failed of hideFailed) notHidden.push({ tag: row.tag || null, ...failed });
    }
    const leftovers = await hideLeftovers(scopedContext);
    for (const { sessionId, reason } of leftovers.failed) notHidden.push({ tag: null, sessionId, reason });
    // Housekeeping: its failure costs nothing of what was done above, and the next cleanup tries again.
    await forgetGoneHidden(sessionGone).catch(() => {});
    return {
      tasksRemoved: cleaned.removed,
      tagsRemoved: beforeTags - tags.size,
      agentsClosed,
      ...(goneRowsCleared ? { goneRowsCleared } : {}),
      leftoversHidden: leftovers.hidden,
      ...(notClosed.length ? { notClosed } : {}),
      ...(notHidden.length ? { notHidden } : {}),
      tasks: views.listJobs(scopedContext).length,
      // Cleanup reports how many worker rows remain known (idle/terminal
      // included); only the /agents worker section hides terminal rows.
      workers: views.list({
        scanSessions: registry.wantsSessionScan(args),
        context: scopedContext,
        includeTerminal: true,
      }).length,
    };
  }

  return { close, cleanup, releaseIdle, parkIdle, closeAll: createCloseAll({ registry, close }) };
}
