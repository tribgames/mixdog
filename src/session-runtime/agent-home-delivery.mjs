/**
 * Rows posted into an agent's home thread (`sess_home_<owner>`) from outside
 * its turns: held requests of unattended runs, reports of task sessions the
 * agent created, and routine results left by runs from before routines ran as
 * turns in the thread itself (routine-home-turn.mjs).
 *
 * Delivery is durable. The finished run is first ENQUEUED in a persisted
 * per-home queue (`routine-results.json`), keyed by the run id, so a retried
 * enqueue adds nothing and a crash between posting and dequeuing never posts
 * twice (the posted message id is derived from the run id). One drainer per
 * home appends every queued result FIFO once the thread is idle; posting never
 * starts a turn. A home thread that does not exist yet keeps its results
 * queued until it does; a deleted owner's results move to Mixy's home. Each
 * home keeps at most ROUTINE_LIMITS.homeQueueLimit results (the oldest drop
 * behind one "n omitted" notice), and posted run ids stay in a ledger so a
 * replay never posts twice, even after the thread was reset. The daemon
 * re-drains every queue on start, and
 * registers the live surface so a thread open in a window shows the notice at
 * once; a cold thread picks it up from its stored record.
 */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  MIXY_AGENT_ID,
  agentHomeSessionId,
  agentIdOfHomeSession,
} from '../runtime/agent/orchestrator/session/agent-home.mjs';
import {
  agentTaskMessage,
  agentTaskWakePrompt,
  routineOmittedMessage,
  routineResultMessage,
  routineResultNotice,
  routineRunNotice,
  routineSummary,
} from '../runtime/agent/orchestrator/session/routine-result.mjs';
import { parseJsonText, updateJsonAtomic } from '../runtime/shared/atomic-file.mjs';
import { ROUTINE_LIMITS } from '../runtime/shared/routine-limits.mjs';
import {
  heldRequestMessage,
  heldRequestNotice,
} from '../runtime/agent/orchestrator/session/human-gate/held-message.mjs';

/** A queued item's stored message and live notice: a routine result, or a
 *  held request of an unattended run (session-runtime/held-requests.mjs). */
function deliveredRow(item, messageId) {
  if (item.kind === 'held-request') {
    const message = heldRequestMessage({ ...item.held, at: item.at, messageId });
    return { message, notice: heldRequestNotice(message) };
  }
  if (item.kind === 'agent-task') {
    // A turn's end (not its start or a wait for the user) wakes the agent.
    const message = agentTaskMessage({ ...item, messageId });
    return { message, notice: routineResultNotice(message), wake: item.roundTrip === true };
  }
  const message = routineResultMessage({ ...item, messageId });
  return { message, notice: routineResultNotice(message) };
}

/** The agent a schedule belongs to; ownerless rows belong to Mixy. */
export function scheduleOwnerAgentId(schedule) {
  const owner = typeof schedule?.ownerAgentId === 'string' ? schedule.ownerAgentId.trim() : '';
  return owner && agentHomeSessionId(owner) ? owner : MIXY_AGENT_ID;
}

let liveSurface = null;
/** `{ busy(sessionId), notice(sessionId, notice), wake(sessionId, prompt),
 *  submit(sessionId, prompt, options), abort(sessionId) }` from the session
 *  service; `wake` starts one hidden turn, `submit` queues a routine turn
 *  (resolves whether it was accepted), `abort` stops the running turn. */
export function setAgentHomeLiveSurface(surface) {
  liveSurface = surface || null;
}

/** The registered live surface (group-room rows post through it too). */
export function agentHomeLiveSurface() {
  return liveSurface;
}

// Run ids already posted, kept per home so a replayed run never posts twice,
// even into a thread that was reset ("대화 새로 시작") since.
const DELIVERED_LEDGER = 500;

/** The persisted queue at `filePath`: `{ homes: { [homeSessionId]: item[] },
 *  omitted: { [homeSessionId]: { id, count } }, delivered: { [homeSessionId]:
 *  runId[] } }`. A home keeps at most `limit` items: past it the oldest drop,
 *  counted under `omitted` so the thread gets one "n omitted" notice. */
export function createRoutineResultQueue(filePath, { limit = ROUTINE_LIMITS.homeQueueLimit } = {}) {
  const section = (doc, key) => (doc && typeof doc[key] === 'object' && doc[key]) || {};
  const parts = (doc) => ({
    homes: section(doc, 'homes'),
    omitted: section(doc, 'omitted'),
    delivered: section(doc, 'delivered'),
    // Agent-initiated round trips per task session (session create).
    rounds: section(doc, 'rounds'),
  });
  async function read() {
    try {
      return parts(parseJsonText(await readFile(filePath, 'utf8')));
    } catch (error) {
      if (error?.code === 'ENOENT') return parts(null);
      throw error;
    }
  }
  /** `doc` with `items` appended to `homeId`'s list, minus run ids it holds or posted. */
  function appended(doc, homeId, items, omittedCount = 0) {
    const list = doc.homes[homeId] || [];
    const seen = new Set([...list.map((row) => row.runId), ...(doc.delivered[homeId] || [])]);
    const fresh = items.filter((item) => !seen.has(item.runId) && seen.add(item.runId));
    if (!fresh.length && !omittedCount) return null;
    const next = [...list, ...fresh];
    const drop = Math.max(0, next.length - limit);
    const omitted = { ...doc.omitted };
    const count = drop + omittedCount;
    if (count) {
      const previous = omitted[homeId];
      omitted[homeId] = { id: previous?.id || `omit_${next[0].runId}`, count: (previous?.count || 0) + count };
    }
    return { ...doc, homes: { ...doc.homes, [homeId]: next.slice(drop) }, omitted };
  }
  return {
    async pendingHomes() {
      const { homes, omitted } = await read();
      return [...new Set([...Object.keys(homes).filter((id) => homes[id]?.length), ...Object.keys(omitted)])];
    },
    async items(homeId) {
      return (await read()).homes[homeId] || [];
    },
    /** `{ id, count }` of the results dropped for `homeId`; null when none. */
    async omitted(homeId) {
      return (await read()).omitted[homeId] || null;
    },
    async add(homeId, item) {
      await updateJsonAtomic(filePath, (raw) => {
        const doc = parts(raw);
        if (item.roundTrip !== true) return appended(doc, homeId, [item]) ?? undefined;
        // A task turn's end counts one round trip, once per run id.
        const round = (doc.rounds[item.taskSessionId] || 0) + 1;
        const next = appended(doc, homeId, [{ ...item, round }]);
        return next ? { ...next, rounds: { ...doc.rounds, [item.taskSessionId]: round } } : undefined;
      });
    },
    /** Hand every queued item (and omission) of `fromHome` to `toHome`. */
    async move(fromHome, toHome) {
      await updateJsonAtomic(filePath, (raw) => {
        const doc = parts(raw);
        const items = doc.homes[fromHome] || [];
        const dropped = doc.omitted[fromHome]?.count || 0;
        const next = appended(doc, toHome, items, dropped) || doc;
        const homes = { ...next.homes };
        const omitted = { ...next.omitted };
        delete homes[fromHome];
        delete omitted[fromHome];
        return { ...next, homes, omitted };
      });
    },
    /** Dequeue the posted `runIds` (and the posted omission notice `omitted`). */
    async remove(homeId, runIds, omitted = null) {
      await updateJsonAtomic(filePath, (raw) => {
        const doc = parts(raw);
        const homes = { ...doc.homes };
        const rest = (homes[homeId] || []).filter((row) => !runIds.includes(row.runId));
        if (rest.length) homes[homeId] = rest;
        else delete homes[homeId];
        const delivered = { ...doc.delivered };
        if (runIds.length) delivered[homeId] = [...(delivered[homeId] || []), ...runIds].slice(-DELIVERED_LEDGER);
        const omittedNow = { ...doc.omitted };
        const current = omittedNow[homeId];
        if (omitted && current?.id === omitted.id) {
          // More dropped while this pass posted: they get a notice of their own.
          const left = current.count - omitted.count;
          if (left > 0) omittedNow[homeId] = { id: `${current.id}.${omitted.count}`, count: left };
          else delete omittedNow[homeId];
        }
        return { ...doc, homes, omitted: omittedNow, delivered };
      });
    },
  };
}

const messageIdOf = (runId) => `routine_${runId}`;

export function createAgentHomeDelivery({
  loadSession,
  saveSession,
  turnInFlight,
  queue,
  live = () => liveSurface,
  retryLater = (fn, ms) => setTimeout(fn, ms).unref?.(),
  busyRetryMs = 1000,
  missingRetryMs = 60_000,
  // 'present' | 'deleted' | 'unknown' per agent id: a deleted owner's results go to Mixy.
  agentPresence = () => 'unknown',
  log = (line) => process.stderr.write(`mixdog routines: ${line}\n`),
}) {
  const busy = (sessionId) => {
    if (turnInFlight(sessionId)) return true;
    try {
      return live()?.busy?.(sessionId) === true;
    } catch {
      return false;
    }
  };
  const draining = new Map(); // home → the running pass
  const again = new Set(); // homes enqueued to while their pass ran
  const waiting = new Set(); // homes with a retry timer armed
  const shownLive = new Set(); // held-request message ids shown live in a busy thread

  /** A held request waits on the user, possibly raised by the very turn that
   *  keeps its thread busy (a routine turn): show it live at once; the stored
   *  row (same messageId) replaces it once the thread is idle. */
  function showHeldLive(homeId, items) {
    for (const item of items) {
      if (item.kind !== 'held-request') continue;
      const messageId = messageIdOf(item.runId);
      if (shownLive.has(messageId)) continue;
      shownLive.add(messageId);
      try {
        live()?.notice?.(homeId, { ...deliveredRow(item, messageId).notice, messageId });
      } catch (error) {
        log(`live notice in ${homeId} failed: ${error?.message || error}`);
      }
    }
  }

  function later(homeId, ms) {
    if (waiting.has(homeId)) return;
    waiting.add(homeId);
    retryLater(() => {
      waiting.delete(homeId);
      void drain(homeId);
    }, ms);
  }

  /** Post every queued result of `homeId` if its thread is idle; else retry later. */
  async function drainOnce(homeId) {
    const items = await queue.items(homeId);
    const omitted = await queue.omitted(homeId);
    if (!items.length && !omitted) return;
    const agentId = agentIdOfHomeSession(homeId);
    if (agentId && agentId !== MIXY_AGENT_ID && agentPresence(agentId) === 'deleted') {
      // The owner is gone (its home archived): Mixy, the default owner, gets them.
      const mixyHome = agentHomeSessionId(MIXY_AGENT_ID);
      log(`${items.length} result(s) of the deleted agent ${agentId} go to ${mixyHome}`);
      await queue.move(homeId, mixyHome);
      void drain(mixyHome);
      return;
    }
    if (busy(homeId)) {
      showHeldLive(homeId, items);
      return later(homeId, busyRetryMs);
    }
    // From here to the push nothing awaits, so no turn can start in between.
    const session = loadSession(homeId);
    if (!session || session.closed === true) {
      log(`${items.length} result(s) wait for the home thread ${homeId}`);
      return later(homeId, missingRetryMs);
    }
    if (!Array.isArray(session.messages)) session.messages = [];
    const posted = new Set(session.messages.map((message) => message?.meta?.transcript?.messageId).filter(Boolean));
    const fresh = [];
    const omittedId = omitted ? messageIdOf(omitted.id) : '';
    if (omitted && !posted.has(omittedId)) {
      const message = routineOmittedMessage({ count: omitted.count, messageId: omittedId });
      session.messages.push(message);
      fresh.push(message);
    }
    const woken = [];
    for (const item of items) {
      const row = deliveredRow(item, messageIdOf(item.runId));
      // Every dequeued task result wakes once, posted in this pass or before.
      if (row.wake) woken.push(row.message);
      if (posted.has(messageIdOf(item.runId))) continue;
      session.messages.push(row.message);
      fresh.push(row);
    }
    for (const item of items) shownLive.delete(messageIdOf(item.runId));
    if (fresh.length) {
      session.updatedAt = Date.now();
      await saveSession(session);
      for (const { message, notice } of fresh) {
        try {
          live()?.notice?.(homeId, { ...notice, messageId: message.meta.transcript.messageId });
        } catch (error) {
          log(`live notice in ${homeId} failed: ${error?.message || error}`);
        }
      }
    }
    await queue.remove(
      homeId,
      items.map((item) => item.runId),
      omitted
    );
    // Dequeued task results wake the agent with ONE hidden turn to relay them;
    // a replayed run id is never queued again, so it wakes nobody.
    if (woken.length) {
      try {
        await live()?.wake?.(homeId, agentTaskWakePrompt(woken));
      } catch (error) {
        log(`waking ${homeId} failed: ${error?.message || error}`);
      }
    }
  }

  /** The single drainer of `homeId`; a call during a pass runs one more pass. */
  function drain(homeId) {
    const running = draining.get(homeId);
    if (running) {
      again.add(homeId);
      return running;
    }
    const pass = (async () => {
      try {
        do {
          again.delete(homeId);
          await drainOnce(homeId);
        } while (again.has(homeId));
      } catch (error) {
        log(`delivery into ${homeId} failed, retrying: ${error?.message || error}`);
        later(homeId, busyRetryMs);
      } finally {
        draining.delete(homeId);
      }
    })();
    draining.set(homeId, pass);
    return pass;
  }

  /** Persist `result` ({ runId, kind, ok, text, runSessionId }) of a schedule
   *  or webhook `row` for its owner's home, then start draining it. Resolves
   *  once it is queued. */
  async function enqueue(row, result) {
    const homeId = agentHomeSessionId(scheduleOwnerAgentId(row));
    if (!result?.runId) throw new Error('routine result: runId required');
    await queue.add(homeId, {
      runId: String(result.runId),
      kind: result.kind === 'webhook' ? 'webhook' : 'schedule',
      name: row.name,
      ok: result.ok === true,
      text: routineSummary(result.text),
      runSessionId: result.runSessionId || null,
      ...(result.reason ? { reason: String(result.reason) } : {}),
      ...(result.paused === true ? { paused: true } : {}),
      at: Date.now(),
    });
    void drain(homeId);
    return homeId;
  }

  /** Persist one held-request row (`held`: normalizeHeldRequest fields) for
   *  `agentId`'s home thread, then start draining it. Each status posts once. */
  async function enqueueHeld(agentId, held) {
    const homeId = agentHomeSessionId(agentId) || agentHomeSessionId(MIXY_AGENT_ID);
    if (!held?.id) throw new Error('held request: id required');
    await queue.add(homeId, {
      runId: `${held.id}_${held.status || 'pending'}`,
      kind: 'held-request',
      held,
      at: Date.now(),
    });
    void drain(homeId);
    return homeId;
  }

  /** Persist one report of a coding task session `agentId` created (session
   *  create) for its home thread, then start draining it. `status` 'started'
   *  and 'blocked' only post a line; a turn's end also wakes the agent. */
  async function enqueueTask(agentId, { runId, taskSessionId, title, status, text = '' }) {
    const homeId = agentHomeSessionId(agentId) || agentHomeSessionId(MIXY_AGENT_ID);
    if (!runId || !taskSessionId) throw new Error('task report: runId and taskSessionId required');
    await queue.add(homeId, {
      runId: String(runId),
      kind: 'agent-task',
      taskSessionId,
      title,
      status,
      text: routineSummary(text),
      roundTrip: status !== 'started' && status !== 'blocked',
      at: Date.now(),
    });
    void drain(homeId);
    return homeId;
  }

  /** Show `run`'s live-only row (routineRunNotice: `running`, or a result whose
   *  delivery failed) in `row`'s owner home when it is open and idle. Nothing
   *  is stored and no turn or unread mark follows; the posted result (same
   *  messageId) replaces it. False when no window shows it. */
  function announce(row, run) {
    const homeId = agentHomeSessionId(scheduleOwnerAgentId(row));
    if (!run?.runId || busy(homeId)) return false;
    const notice = routineRunNotice({ ...run, name: row.name, messageId: messageIdOf(run.runId) });
    try {
      return live()?.notice?.(homeId, notice) === true;
    } catch (error) {
      log(`live notice in ${homeId} failed: ${error?.message || error}`);
      return false;
    }
  }

  /** Drain every queue left by an earlier process. */
  async function recover() {
    const homes = await queue.pendingHomes();
    for (const homeId of homes) void drain(homeId);
    return homes;
  }

  return { enqueue, enqueueHeld, enqueueTask, announce, drain, recover };
}

let defaultDelivery = null;
/** The process delivery over the session store and data dir; built on first use. */
async function processDelivery() {
  if (!defaultDelivery) {
    const [{ loadSession, saveSessionAsync }, { isSessionTurnInFlight }, { getPluginData }, { createAgentEditorApi }] =
      await Promise.all([
        import('../runtime/agent/orchestrator/session/store.mjs'),
        import('../runtime/agent/orchestrator/session/manager/runtime-liveness.mjs'),
        import('../runtime/agent/orchestrator/config.mjs'),
        import('./workflow-agents-api/agent-editor.mjs'),
      ]);
    // The editor's per-id definition probe: 'deleted' only when proven gone.
    const { agentDefinitionPresence } = createAgentEditorApi({ cfgMod: { getPluginData } });
    defaultDelivery = createAgentHomeDelivery({
      loadSession,
      saveSession: (session) => saveSessionAsync(session, { expectedGeneration: session.generation }),
      turnInFlight: isSessionTurnInFlight,
      queue: createRoutineResultQueue(join(getPluginData(), 'routine-results.json')),
      agentPresence: (agentId) => agentDefinitionPresence([agentId])[agentId],
    });
  }
  return defaultDelivery;
}

/** Queue one run's result for its owner's home thread. */
export async function deliverScheduleResult(schedule, result) {
  return (await processDelivery()).enqueue(schedule, result);
}

/** Show a run's live-only row (running / delivery failed) in its owner's home. */
export async function announceRoutineRun(row, run) {
  if (!liveSurface) return false;
  return (await processDelivery()).announce(row, run);
}

/** Queue one held-request row for `agentId`'s home thread. */
export async function deliverHeldRequest(agentId, held) {
  return (await processDelivery()).enqueueHeld(agentId, held);
}

/** Queue one report of a task session for `agentId`'s home thread. */
export async function deliverAgentTask(agentId, report) {
  return (await processDelivery()).enqueueTask(agentId, report);
}

/** Daemon start: post the results an earlier process left queued. */
export async function recoverScheduleResults() {
  return (await processDelivery()).recover();
}
