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
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  MIXY_AGENT_ID,
  agentHomeSessionId,
  agentIdOfHomeSession,
  isAgentHomeSessionId,
} from '../runtime/agent/orchestrator/session/agent-home.mjs';
import {
  isRoomThreadSessionId,
  roomIdOfSession,
  roomMemberOfSession,
} from '../runtime/agent/orchestrator/session/agent-room.mjs';
import {
  TASK_LOOP_CAP,
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
import { submissionIdsOf } from './agent-task-sessions.mjs';
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
    // A turn's end (not its start or a wait for the user) wakes the agent —
    // except past the round-trip cap with another agent's own thread, where
    // each wake could answer the other agent again without end.
    const capped =
      (isAgentHomeSessionId(item.taskSessionId) || isRoomThreadSessionId(item.taskSessionId)) &&
      (item.round || 0) > TASK_LOOP_CAP;
    const message = agentTaskMessage({ ...item, messageId, ...(capped ? { woken: false } : {}) });
    return { message, notice: routineResultNotice(message), wake: item.roundTrip === true && !capped };
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
/** `{ busy(sessionId), notice(sessionId, notice), wake(sessionId, prompt, { id }),
 *  submit(sessionId, prompt, options), abort(sessionId) }` from the session
 *  service; `wake` starts one hidden turn with submission `id` (resolves
 *  false when it was refused), `submit` queues a routine turn
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
// A target's round-trip count left idle this long starts over.
export const ROUND_TTL_MS = 30 * 24 * 60 * 60 * 1000;
// Per home: round-trip targets counted (least recently counted drop first),
// reporting turns watched at once, and posted results owed a wake.
export const QUEUE_CAPS = Object.freeze({ roundTargets: 100, watches: 200, wakeRunIds: 100 });

/** `homeId`'s wake obligations in `wakes`: posted task results not in a batch
 *  yet (`owed`), those past the cap collapsed into one marker (`overflow`:
 *  `{ count, oldest, newest }` run ids) the next batch takes over, and
 *  batches (`{ id, runIds, overflow? }`) stored before their wake turn was
 *  submitted under that id. */
function wakeState(wakes, homeId) {
  const raw = wakes[homeId];
  if (Array.isArray(raw)) return { owed: raw, batches: [], overflow: null };
  return {
    owed: Array.isArray(raw?.owed) ? raw.owed : [],
    batches: Array.isArray(raw?.batches)
      ? raw.batches.filter((batch) => typeof batch?.id === 'string' && Array.isArray(batch.runIds))
      : [],
    overflow: raw?.overflow?.count > 0 ? raw.overflow : null,
  };
}

const owesWake = (state) => state.owed.length > 0 || state.batches.length > 0 || Boolean(state.overflow);

function withWakeState(doc, homeId, { owed, batches, overflow }) {
  const wakes = { ...doc.wakes };
  if (owesWake({ owed, batches, overflow })) wakes[homeId] = { owed, batches, ...(overflow ? { overflow } : {}) };
  else delete wakes[homeId];
  return { ...doc, wakes };
}

/** The persisted queue at `filePath`: `{ homes: { [homeSessionId]: item[] },
 *  omitted: { [homeSessionId]: { id, count } }, delivered: { [homeSessionId]:
 *  runId[] } }`. A home keeps at most `limit` items: past it the oldest drop,
 *  counted under `omitted` so the thread gets one "n omitted" notice. */
export function createRoutineResultQueue(
  filePath,
  { limit = ROUTINE_LIMITS.homeQueueLimit, now = Date.now, caps = QUEUE_CAPS } = {}
) {
  const section = (doc, key) => (doc && typeof doc[key] === 'object' && doc[key]) || {};
  /** `own`'s per-target counts (`{ n, at }`) used within ROUND_TTL_MS, the
   *  `caps.roundTargets` most recently counted. */
  const freshRounds = (own) =>
    Object.fromEntries(
      Object.entries(own && typeof own === 'object' ? own : {})
        .filter(([, count]) => count && typeof count === 'object' && now() - (Number(count.at) || 0) < ROUND_TTL_MS)
        .sort(([, a], [, b]) => (Number(b.at) || 0) - (Number(a.at) || 0))
        .slice(0, caps.roundTargets)
    );
  const tidyRounds = (rounds) =>
    Object.fromEntries(
      Object.entries(rounds || {})
        .map(([homeId, own]) => [homeId, freshRounds(own)])
        .filter(([, own]) => Object.keys(own).length)
    );
  const parts = (doc) => ({
    homes: section(doc, 'homes'),
    omitted: section(doc, 'omitted'),
    delivered: section(doc, 'delivered'),
    // Agent-initiated round trips per task session (session create).
    rounds: section(doc, 'rounds'),
    // Reporting turns not yet queued, by submission id (agent-task-sessions.mjs).
    watches: section(doc, 'watches'),
    // Posted task results whose wake turn was not taken yet, per home.
    wakes: section(doc, 'wakes'),
  });
  async function read() {
    try {
      return parts(parseJsonText(await readFile(filePath, 'utf8')));
    } catch (error) {
      if (error?.code === 'ENOENT') return parts(null);
      throw error;
    }
  }
  /** Read-modify-write under the file lock (`mutator(doc)` returns the next
   *  doc, or nothing to keep the file); every write also retires stale and
   *  surplus round counts. */
  function update(mutator) {
    return updateJsonAtomic(filePath, (raw) => {
      const next = mutator(parts(raw));
      return next ? { ...next, rounds: tidyRounds(next.rounds) } : undefined;
    });
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
      const { homes, omitted, wakes } = await read();
      return [
        ...new Set([
          ...Object.keys(homes).filter((id) => homes[id]?.length),
          ...Object.keys(omitted),
          ...Object.keys(wakes).filter((id) => owesWake(wakeState(wakes, id))),
        ]),
      ];
    },
    /** `homeId`'s wake obligations: `{ owed, batches, overflow }` (wakeState). */
    async wakes(homeId) {
      return wakeState((await read()).wakes, homeId);
    },
    /** Store the owed results (and overflow marker) of `homeId` as one new
     *  batch under a fresh wake id, before its wake is submitted; null when
     *  none are owed. */
    async batchWake(homeId) {
      let batch = null;
      await update((doc) => {
        batch = null;
        const state = wakeState(doc.wakes, homeId);
        if (!state.owed.length && !state.overflow) return undefined;
        batch = {
          id: `awake_${randomUUID()}`,
          runIds: state.owed,
          ...(state.overflow ? { overflow: state.overflow } : {}),
        };
        return withWakeState(doc, homeId, { owed: [], batches: [...state.batches, batch], overflow: null });
      });
      return batch;
    },
    /** The wake of batch `batchId` was taken (or is moot): it is owed no more. */
    async woke(homeId, batchId) {
      await update((doc) => {
        const state = wakeState(doc.wakes, homeId);
        const batches = state.batches.filter((batch) => batch.id !== batchId);
        if (batches.length === state.batches.length) return undefined;
        return withWakeState(doc, homeId, { ...state, batches });
      });
    },
    /** Drop every wake obligation of `homeId` (its owner is gone). */
    async dropWakes(homeId) {
      await update((doc) =>
        doc.wakes[homeId] ? withWakeState(doc, homeId, { owed: [], batches: [], overflow: null }) : undefined
      );
    },
    /** Every home the rounds, wakes, posted ledger or watches name. */
    async bookkeptHomes() {
      const doc = await read();
      const watched = Object.values(doc.watches).map((watch) => watch?.homeSessionId);
      return [
        ...new Set(
          [...Object.keys(doc.rounds), ...Object.keys(doc.wakes), ...Object.keys(doc.delivered), ...watched].filter(
            (id) => typeof id === 'string' && id
          )
        ),
      ];
    },
    /** Retire the rounds, wakes, posted ledger and watches of the `gone`
     *  homes (and, as every write does, stale round counts). */
    async prune(gone) {
      await update((doc) => {
        const kept = (part) => Object.fromEntries(Object.entries(part).filter(([homeId]) => !gone.includes(homeId)));
        const next = {
          ...doc,
          rounds: tidyRounds(kept(doc.rounds)),
          wakes: kept(doc.wakes),
          delivered: kept(doc.delivered),
          watches: Object.fromEntries(
            Object.entries(doc.watches).filter(([, watch]) => !gone.includes(watch?.homeSessionId))
          ),
        };
        return JSON.stringify(next) === JSON.stringify(doc) ? undefined : next;
      });
    },
    async items(homeId) {
      return (await read()).homes[homeId] || [];
    },
    /** `{ id, count }` of the results dropped for `homeId`; null when none. */
    async omitted(homeId) {
      return (await read()).omitted[homeId] || null;
    },
    /** Queue `item` for `homeId`; `unwatch` drops that watch in the same write,
     *  also when the item was queued or posted before. */
    async add(homeId, item, { unwatch = '' } = {}) {
      await update((doc) => {
        let next = null;
        if (item.roundTrip !== true) next = appended(doc, homeId, [item]);
        else {
          // A task turn's end counts one round trip, once per run id, per home
          // and target: the user's next message in that home starts over
          // (resetRounds), and so does a count idle past ROUND_TTL_MS.
          const own = freshRounds(doc.rounds[homeId]);
          const round = (own[item.taskSessionId]?.n || 0) + 1;
          next = appended(doc, homeId, [{ ...item, round }]);
          if (next) {
            const counted = { ...own, [item.taskSessionId]: { n: round, at: now() } };
            next = { ...next, rounds: { ...doc.rounds, [homeId]: counted } };
          }
        }
        if (!unwatch || !doc.watches[unwatch]) return next ?? undefined;
        const watches = { ...doc.watches };
        delete watches[unwatch];
        return { ...(next || doc), watches };
      });
    },
    /** Keep `watch` ({ runId, agentId, homeSessionId, taskSessionId, title,
     *  target? }) until its report is queued, dropping the watches `drop` in
     *  the same write. Throws when its home already keeps `caps.watches`. */
    async watch(watch, { drop = [] } = {}) {
      await update((doc) => {
        const watches = { ...doc.watches };
        for (const runId of drop) delete watches[runId];
        const own = Object.values(watches).filter(
          (kept) => kept?.homeSessionId === watch.homeSessionId && kept.runId !== watch.runId
        );
        if (own.length >= caps.watches) {
          throw new Error(`${watch.homeSessionId} already waits on ${own.length} session reports`);
        }
        return { ...doc, watches: { ...watches, [watch.runId]: watch } };
      });
    },
    watchCap: caps.watches,
    /** Every stored watch, oldest first. */
    async watches() {
      return Object.values((await read()).watches);
    },
    /** Drop the watch of `runId` (its turn was never taken). */
    async unwatch(runId) {
      await update((doc) => {
        if (!doc.watches[runId]) return undefined;
        const watches = { ...doc.watches };
        delete watches[runId];
        return { ...doc, watches };
      });
    },
    /** The user spoke in `homeId`: its round trips count from zero again. */
    async resetRounds(homeId) {
      await update((doc) => {
        if (!doc.rounds[homeId]) return undefined;
        const rounds = { ...doc.rounds };
        delete rounds[homeId];
        return { ...doc, rounds };
      });
    },
    /** Hand every queued item (and omission) of `fromHome` to `toHome`. */
    async move(fromHome, toHome) {
      await update((doc) => {
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
    /** Dequeue the posted `runIds` (and the posted omission notice `omitted`);
     *  those in `wake` stay owed a wake (`wakes`) in the same write, at most
     *  `caps.wakeRunIds` run ids per home: past it the oldest owed collapse
     *  into the overflow marker the next batch takes over (`overflowed`
     *  counts them). Stored batches never change. */
    async remove(homeId, runIds, omitted = null, { wake = [] } = {}) {
      let overflowed = 0;
      await update((doc) => {
        overflowed = 0;
        const state = wakeState(doc.wakes, homeId);
        const batched = state.batches.flatMap((batch) => batch.runIds);
        const known = new Set([
          ...state.owed,
          ...batched,
          ...[state.overflow?.oldest, state.overflow?.newest].filter(Boolean),
        ]);
        const added = wake.filter((runId) => !known.has(runId));
        let wakes = doc.wakes;
        if (added.length) {
          const owed = [...state.owed, ...added];
          const room = Math.max(0, caps.wakeRunIds - batched.length);
          const excess = owed.slice(0, Math.max(0, owed.length - room));
          overflowed = excess.length;
          const overflow = excess.length
            ? {
                count: (state.overflow?.count || 0) + excess.length,
                oldest: state.overflow?.oldest || excess[0],
                newest: excess.at(-1),
              }
            : state.overflow;
          ({ wakes } = withWakeState(doc, homeId, { ...state, owed: owed.slice(excess.length), overflow }));
        }
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
        return { ...doc, homes, omitted: omittedNow, delivered, wakes };
      });
      return { overflowed };
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
  // The same per room id. The daemon has no room store (rooms live in the
  // desktop host), so by default no room counts as deleted.
  roomPresence = () => 'unknown',
  // True only on positive evidence that session `id` was deleted; an
  // unreadable or unknown record is not deleted.
  sessionDeleted = () => false,
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
    const owed = owesWake(await queue.wakes(homeId));
    if (!items.length && !omitted && !owed) return;
    const agentId = agentIdOfHomeSession(homeId);
    if (agentId && agentId !== MIXY_AGENT_ID && agentPresence(agentId) === 'deleted') {
      // The owner is gone (its home archived): Mixy, the default owner, gets them.
      const mixyHome = agentHomeSessionId(MIXY_AGENT_ID);
      log(`${items.length} result(s) of the deleted agent ${agentId} go to ${mixyHome}`);
      await queue.move(homeId, mixyHome);
      if (owed) await queue.dropWakes(homeId);
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
    const toWake = [];
    for (const item of items) {
      const row = deliveredRow(item, messageIdOf(item.runId));
      // Every dequeued task result is owed one wake, posted in this pass or before.
      if (row.wake) toWake.push(item.runId);
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
    // Dequeuing and owing the wake are one write: no restart between posting
    // and waking loses the wake.
    const { overflowed } = await queue.remove(
      homeId,
      items.map((item) => item.runId),
      omitted,
      { wake: toWake }
    );
    if (overflowed) log(`${homeId} is at its wake cap: ${overflowed} result(s) ride the next wake as a count`);
    // Owed task results wake the agent with one hidden turn per batch. A batch
    // is stored with its wake id BEFORE the wake is submitted and dropped once
    // it is taken, so a restart in between re-checks that exact id; results
    // owed later form a new batch. A replayed run id is never queued again.
    const byId = new Map(session.messages.map((message) => [message?.meta?.transcript?.messageId, message]));
    const taken = new Set(session.messages.flatMap((message) => submissionIdsOf(message)));
    let batch = null;
    let woken = [];
    let more = 0;
    for (;;) {
      batch = (await queue.wakes(homeId)).batches[0] || (await queue.batchWake(homeId));
      if (!batch) return;
      const stale = taken.has(batch.id);
      woken = stale ? [] : batch.runIds.map((runId) => byId.get(messageIdOf(runId))).filter(Boolean);
      // Results past the wake cap ride this wake as a count of rows to read.
      more = !stale && byId.has(messageIdOf(batch.overflow?.newest)) ? batch.overflow.count : 0;
      if (woken.length || more) break;
      // Taken before a restart, or its rows gone with a thread reset.
      await queue.woke(homeId, batch.id);
    }
    const surface = live();
    if (typeof surface?.wake !== 'function') return later(homeId, busyRetryMs);
    try {
      if ((await surface.wake(homeId, agentTaskWakePrompt(woken, { more }), { id: batch.id })) === false) {
        throw new Error('the wake turn was refused');
      }
    } catch (error) {
      log(`waking ${homeId} failed, retrying: ${error?.message || error}`);
      return later(homeId, missingRetryMs);
    }
    await queue.woke(homeId, batch.id);
    // Another batch left by an earlier process wakes once this turn is done.
    if (owesWake(await queue.wakes(homeId))) later(homeId, busyRetryMs);
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
  async function enqueueTask(
    agentId,
    { runId, taskSessionId, title, status, text = '', target, watchId = '', files = [], omitted = 0 }
  ) {
    const homeId = agentHomeSessionId(agentId) || agentHomeSessionId(MIXY_AGENT_ID);
    if (!runId || !taskSessionId) throw new Error('task report: runId and taskSessionId required');
    await queue.add(
      homeId,
      {
        runId: String(runId),
        kind: 'agent-task',
        taskSessionId,
        title,
        status,
        text: routineSummary(text),
        // Any session other than a task session the agent created.
        ...(target === 'session' ? { target } : {}),
        // The files the turn produced (handoff-attachments.mjs collectTurnArtifacts).
        ...(Array.isArray(files) && files.length ? { files, ...(omitted > 0 ? { omitted } : {}) } : {}),
        roundTrip: status !== 'started' && status !== 'blocked',
        at: Date.now(),
      },
      { unwatch: watchId ? String(watchId) : '' }
    );
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

  /** A bookkept home proven deleted: a bot's home whose definition is gone,
   *  or a room thread whose room is. Never Mixy's home, never on a missing
   *  thread record, never on an unknown answer. */
  function homeDeleted(homeId) {
    const agentId = agentIdOfHomeSession(homeId);
    if (agentId) return agentId !== MIXY_AGENT_ID && agentPresence(agentId) === 'deleted';
    const roomId = roomIdOfSession(homeId) || roomMemberOfSession(homeId)?.roomId || '';
    return Boolean(roomId) && roomPresence(roomId) === 'deleted';
  }

  /** Retire the bookkeeping of deleted homes (and stale round counts). */
  async function prune() {
    await queue.prune((await queue.bookkeptHomes()).filter(homeDeleted));
  }

  /** Store `watch`; a home at its watch cap first gives up its oldest watches
   *  whose target sessions are proven deleted, and refuses the watch (so the
   *  send claims no report) when that frees too few. */
  async function watchTask(watch) {
    const own = (await queue.watches()).filter(
      (kept) => kept?.homeSessionId === watch.homeSessionId && kept.runId !== watch.runId
    );
    const over = own.length + 1 - queue.watchCap;
    const drop =
      over > 0
        ? own
            .filter((kept) => sessionDeleted(kept.taskSessionId))
            .slice(0, over)
            .map((kept) => kept.runId)
        : [];
    if (drop.length) {
      log(`${watch.homeSessionId} is at its watch cap: dropped ${drop.length} watch(es) of deleted sessions`);
    }
    await queue.watch(watch, { drop });
  }

  /** Drain every queue left by an earlier process, after retiring stale bookkeeping. */
  async function recover() {
    try {
      await prune();
    } catch (error) {
      log(`pruning the routine results failed: ${error?.message || error}`);
    }
    const homes = await queue.pendingHomes();
    for (const homeId of homes) void drain(homeId);
    return homes;
  }

  return {
    enqueue,
    enqueueHeld,
    enqueueTask,
    announce,
    drain,
    recover,
    watchTask,
    unwatchTask: (runId) => queue.unwatch(runId),
    taskWatches: () => queue.watches(),
    resetRounds: (homeId) => queue.resetRounds(homeId),
  };
}

let defaultDelivery = null;
/** The process delivery over the session store and data dir; built on first use. */
async function processDelivery() {
  if (!defaultDelivery) {
    const [
      { loadSession, saveSessionAsync },
      { isSessionTurnInFlight },
      { getPluginData },
      { createAgentEditorApi },
      { probePath, PROBE_ABSENT },
      { sessionPath },
    ] = await Promise.all([
      import('../runtime/agent/orchestrator/session/store.mjs'),
      import('../runtime/agent/orchestrator/session/manager/runtime-liveness.mjs'),
      import('../runtime/agent/orchestrator/config.mjs'),
      import('./workflow-agents-api/agent-editor.mjs'),
      import('../runtime/agent/orchestrator/session/store/fs-probe.mjs'),
      import('../runtime/agent/orchestrator/session/store/session-paths.mjs'),
    ]);
    // The editor's per-id definition probe: 'deleted' only when proven gone.
    const { agentDefinitionPresence } = createAgentEditorApi({ cfgMod: { getPluginData } });
    defaultDelivery = createAgentHomeDelivery({
      loadSession,
      saveSession: (session) => saveSessionAsync(session, { expectedGeneration: session.generation }),
      turnInFlight: isSessionTurnInFlight,
      queue: createRoutineResultQueue(join(getPluginData(), 'routine-results.json')),
      agentPresence: (agentId) => agentDefinitionPresence([agentId])[agentId],
      // Deleting a session unlinks its record (session-delete.mjs) and leaves
      // no tombstone: only an absent file with no in-memory copy proves it.
      // An unreadable file probes 'unreadable' and stays.
      sessionDeleted: (sessionId) => {
        try {
          return probePath(sessionPath(sessionId)).state === PROBE_ABSENT && !loadSession(sessionId);
        } catch {
          return false;
        }
      },
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

/** Keep one reporting turn's watch until its report is queued. */
export async function watchAgentTask(watch) {
  return (await processDelivery()).watchTask(watch);
}

/** Drop one reporting turn's watch (its turn was never taken). */
export async function unwatchAgentTask(runId) {
  return (await processDelivery()).unwatchTask(runId);
}

/** A user's own message in `homeId`: its round trips with every target restart. */
export async function resetAgentTaskRounds(homeId) {
  return (await processDelivery()).resetRounds(homeId);
}

/** The reporting turns whose report was not queued yet. */
export async function agentTaskWatches() {
  return (await processDelivery()).taskWatches();
}

/** Daemon start: post the results an earlier process left queued. */
export async function recoverScheduleResults() {
  return (await processDelivery()).recover();
}
