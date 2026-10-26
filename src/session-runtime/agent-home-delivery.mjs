/**
 * Rows posted into an agent's home thread (`sess_home_<owner>`) from outside
 * its turns: held requests of unattended runs, reports of task sessions the
 * agent created, the agent's own reply of a turn it ran in a hidden session
 * (Mixy's heartbeat), and routine results left by runs from before routines
 * ran as turns in the thread itself (routine-home-turn.mjs).
 *
 * Delivery is durable. The finished run is first ENQUEUED in a persisted
 * per-home queue (`routine-results.json`), keyed by the run id, so a retried
 * enqueue adds nothing and a crash between posting and dequeuing never posts
 * twice (the posted message id is derived from the run id). One drainer per
 * home appends every queued result FIFO once the thread is idle; posting never
 * starts a turn. Rows that wake nobody (a task session's progress updates,
 * among others) also post right before any turn of the thread starts
 * (postBeforeTurn), so that turn reads them ahead of its prompt. A home thread that does not exist yet keeps its results
 * queued until it does; a deleted owner's results move to Mixy's home. Each
 * home keeps at most ROUTINE_LIMITS.homeQueueLimit results (the oldest drop
 * behind one "n omitted" notice), and posted run ids stay in a ledger so a
 * replay never posts twice, even after the thread was reset. The daemon
 * re-drains every queue on start, and
 * registers the live surface so a thread open in a window shows the notice at
 * once; a cold thread picks it up from its stored record.
 *
 * A group-room member's task reports (enqueueTask `from` its member session)
 * land in that member session alone, never as rows in the room's log. An
 * ended turn is owed a wake like a home's, but the relay turn runs in the
 * room: the desktop room host (agent-room-host.mjs `relay`) gives the member
 * one turn there to relay the result, with the same batches and retries.
 */
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { readAgentDefinitionKind } from '../runtime/shared/agent-kind.mjs';
import { BOT_AGENT_KIND, WORKFLOW_AGENT_KIND, isContactAgentId } from '../runtime/shared/agent-route-config.mjs';
import { botStoreActive, isStoreBot } from '../runtime/shared/agent-store.mjs';
import { readMarkdownDocument } from '../runtime/shared/markdown-frontmatter.mjs';
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
import { agentRoomHost } from '../runtime/shared/agent-room-host.mjs';
import { sendDepth } from '../runtime/shared/bot-hops.mjs';
import {
  TASK_LOOP_CAP,
  agentTaskMessage,
  agentTaskRelayFailedMessage,
  agentTaskWakePrompt,
  boundedReply,
  routineOmittedMessage,
  routineResultMessage,
  routineResultNotice,
  routineRunNotice,
  routineSummary,
} from '../runtime/agent/orchestrator/session/routine-result.mjs';
import { readJsonState, updateJsonAtomic } from '../runtime/shared/atomic-file.mjs';
import { endHandoff, noteHandoff } from '../runtime/shared/delegated-approval-host.mjs';
import { ROUTINE_LIMITS } from '../runtime/shared/routine-limits.mjs';
import { submissionIdsOf, submissionOutcome } from './agent-task-sessions.mjs';
import {
  heldRequestMessage,
  heldRequestNotice,
} from '../runtime/agent/orchestrator/session/human-gate/held-message.mjs';

/** `message` marked as posted outside any turn (`meta.transcript.posted`):
 *  its row is a turn of its own, never part of the rows around it
 *  (transcript-turn-keys.mjs). */
function postedMessage(message) {
  return { ...message, meta: { ...message.meta, transcript: { ...message.meta?.transcript, posted: true } } };
}

/** A queued item's stored message and live notice: a routine result, or a
 *  held request of an unattended run (session-runtime/held-requests.mjs). */
function deliveredRow(item, messageId) {
  const row = queuedRow(item, messageId);
  return { ...row, message: postedMessage(row.message) };
}

/** A task report past the round-trip cap with another agent's own thread:
 *  each wake could answer the other agent again without end. */
const taskWakeCapped = (item) =>
  (isAgentHomeSessionId(item.taskSessionId) || isRoomThreadSessionId(item.taskSessionId)) &&
  (item.round || 0) > TASK_LOOP_CAP;

/** Whether queued `item` wakes the agent once posted: a task turn's end (not
 *  its start, a wait for the user or a progress update), unless capped. */
const wakesAgent = (item) => item.kind === 'agent-task' && item.roundTrip === true && !taskWakeCapped(item);

function queuedRow(item, messageId) {
  // The agent's own words from a turn it ran elsewhere (mixy-heartbeat.mjs):
  // one ordinary reply of the agent in its thread.
  if (item.kind === 'agent-message') {
    const message = { role: 'assistant', content: item.text, meta: { transcript: { at: item.at, messageId } } };
    return { message, notice: { text: item.text, tone: 'info', assistant: true } };
  }
  if (item.kind === 'held-request') {
    const message = heldRequestMessage({ ...item.held, at: item.at, messageId });
    return { message, notice: heldRequestNotice(message) };
  }
  if (item.kind === 'agent-task') {
    const capped = taskWakeCapped(item);
    const message = agentTaskMessage({ ...item, messageId, ...(capped ? { woken: false } : {}) });
    return { message, notice: routineResultNotice(message), wake: wakesAgent(item) };
  }
  const message = routineResultMessage({ ...item, messageId });
  return { message, notice: routineResultNotice(message) };
}

/** Whether agent `id` can have a home chat, decided only from a definition
 *  read successfully: 'bot' (a store bot, or one the kind rule calls a bot),
 *  'none' (read, and a workflow agent: an explicit non-bot `kind`, a shipped
 *  role, or an unmarked agents/ copy once bots have their own store), else
 *  'unknown' — an unreadable file, an unparsable one, or an unmarked user
 *  copy without bot evidence never proves the agent is no bot. */
export function readHomeAgent({ dataDir, shippedRoot, id, read = (path) => readFileSync(path, 'utf8') }) {
  if (!dataDir || !id) return 'unknown';
  if (isStoreBot(dataDir, id)) return 'bot';
  const readOrAbsent = (path) => {
    try {
      return { text: read(path) };
    } catch (error) {
      return error?.code === 'ENOENT' || error?.code === 'ENOTDIR' ? { absent: true } : { failed: true };
    }
  };
  const user = readOrAbsent(join(dataDir, 'agents', id, 'AGENT.md'));
  if (user.failed) return 'unknown';
  const shipped = shippedRoot ? readOrAbsent(join(shippedRoot, 'agents', id, 'AGENT.md')) : { absent: true };
  const own = user.text ?? (shipped.failed ? null : shipped.text);
  if (typeof own !== 'string') return 'unknown';
  const kind = String(readMarkdownDocument(own).frontmatter?.kind || '')
    .trim()
    .toLowerCase();
  if (kind) {
    if (isContactAgentId(id, kind)) return 'bot';
    return kind === WORKFLOW_AGENT_KIND ? 'none' : 'unknown';
  }
  if (user.text === undefined || typeof shipped.text === 'string' || botStoreActive(dataDir)) return 'none';
  return readAgentDefinitionKind({ dataDir, shippedRoot, id }) === BOT_AGENT_KIND ? 'bot' : 'unknown';
}

/** The agent a schedule belongs to; ownerless rows belong to Mixy. */
export function scheduleOwnerAgentId(schedule) {
  const owner = typeof schedule?.ownerAgentId === 'string' ? schedule.ownerAgentId.trim() : '';
  return owner && agentHomeSessionId(owner) ? owner : MIXY_AGENT_ID;
}

let liveSurface = null;
/** `{ busy(sessionId), notice(sessionId, notice), react(sessionId, messageId,
 *  reactions), wake(sessionId, prompt, { id }), submit(sessionId, prompt,
 *  options), abort(sessionId) }` from the session service; `react` shows a
 *  message's new reactions in the runtime hosting it (message-reactions.mjs),
 *  `wake` starts one hidden turn with submission `id` (resolves
 *  false when it was refused, else `{ settled }`: a promise of the turn's end
 *  status, 'done' when it finished), `submit` queues a routine turn
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
const ROUND_TTL_MS = 30 * 24 * 60 * 60 * 1000;
// Per home: round-trip targets counted (least recently counted drop first),
// reporting turns watched at once, and posted results owed a wake.
export const QUEUE_CAPS = Object.freeze({ roundTargets: 100, watches: 200, wakeRunIds: 100 });
// Waits before the 2nd, 3rd and 4th try of a relay (wake) turn that did not finish.
const WAKE_RETRY_DELAYS_MS = Object.freeze([30_000, 120_000, 600_000]);
// Refused wake submissions of one batch, a minute apart, before it is given up.
const WAKE_REFUSAL_LIMIT = 10;

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

/** `own`'s per-target counts (`{ n, at }`) used within ROUND_TTL_MS of
 *  `nowMs`, the `cap` most recently counted. */
function freshRoundCounts(own, nowMs, cap) {
  return Object.fromEntries(
    Object.entries(own && typeof own === 'object' ? own : {})
      .filter(([, count]) => count && typeof count === 'object' && nowMs - (Number(count.at) || 0) < ROUND_TTL_MS)
      .sort(([, a], [, b]) => (Number(b.at) || 0) - (Number(a.at) || 0))
      .slice(0, cap)
  );
}

/** `doc` with `items` appended to `homeId`'s list, minus run ids it holds or
 *  posted; past `limit` the oldest drop, counted under `omitted`. Null when
 *  nothing changes. */
function appendedItems(doc, homeId, items, limit, omittedCount) {
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

/** `doc.wakes` with the run ids `wake` owed a wake by `homeId`, at most
 *  `cap` per home: past it the oldest owed collapse into the overflow marker
 *  (`overflowed` counts them). Stored batches never change. */
function owedWakes(doc, homeId, wake, cap) {
  const state = wakeState(doc.wakes, homeId);
  const batched = state.batches.flatMap((batch) => batch.runIds);
  const known = new Set([
    ...state.owed,
    ...batched,
    ...[state.overflow?.oldest, state.overflow?.newest].filter(Boolean),
  ]);
  const added = wake.filter((runId) => !known.has(runId));
  if (!added.length) return { wakes: doc.wakes, overflowed: 0 };
  const owed = [...state.owed, ...added];
  const room = Math.max(0, cap - batched.length);
  const excess = owed.slice(0, Math.max(0, owed.length - room));
  const overflow = excess.length
    ? {
        count: (state.overflow?.count || 0) + excess.length,
        oldest: state.overflow?.oldest || excess[0],
        newest: excess.at(-1),
      }
    : state.overflow;
  const { wakes } = withWakeState(doc, homeId, { ...state, owed: owed.slice(excess.length), overflow });
  return { wakes, overflowed: excess.length };
}

/** `doc` with the posted `runIds` of `homeId` dequeued into its posted
 *  ledger, and the posted omission notice `omitted` retired. */
function withDequeued(doc, homeId, runIds, omitted) {
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
}

/** `{ doc, item }`: task report `item` for `homeId` and the `doc` it joins,
 *  so that a final report never repeats progress update `progressRunId` that
 *  carried the same answer. Posted (`posted`: the thread holds it, or the
 *  ledger says so), the final report points to it instead of repeating its
 *  text (the row's one-line summary stays); only queued, that update is
 *  dropped and the final report carries the answer in its place. */
function withoutRepeatedProgress(doc, homeId, item, posted) {
  const { progressRunId, ...report } = item;
  if (!progressRunId) return { doc, item };
  if (posted || (doc.delivered[homeId] || []).includes(progressRunId)) {
    const { text: _text, textChars: _textChars, ...rest } = report;
    return { doc, item: { ...rest, text: '', answerAbove: true } };
  }
  const queued = doc.homes[homeId] || [];
  if (!queued.some((row) => row.runId === progressRunId)) return { doc, item: report };
  const homes = { ...doc.homes, [homeId]: queued.filter((row) => row.runId !== progressRunId) };
  return { doc: { ...doc, homes }, item: report };
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
  const freshRounds = (own) => freshRoundCounts(own, now(), caps.roundTargets);
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
  // A damaged queue file (empty, NUL-filled after a crash, malformed) is kept
  // aside and its last good copy restored (readJsonState); it never blocks
  // delivery. I/O errors still throw.
  async function read() {
    return parts(await readJsonState(filePath));
  }
  /** Read-modify-write under the file lock (`mutator(doc)` returns the next
   *  doc, or nothing to keep the file); every write also retires stale and
   *  surplus round counts. The watches a write added or removed, by any path
   *  (a report, a turn never taken, a cap eviction, a pruned home), start or
   *  end their hand-offs (delegated-approval-host.mjs). */
  async function update(mutator) {
    let watches = null;
    const result = await updateJsonAtomic(
      filePath,
      (raw) => {
        const doc = parts(raw);
        const next = mutator(doc);
        watches = { before: doc.watches, after: next ? section(next, 'watches') : doc.watches };
        return next ? { ...next, rounds: tidyRounds(next.rounds) } : undefined;
      },
      { backup: true }
    );
    if (watches) syncHandoffs(watches.before, watches.after);
    return result;
  }
  const appended = (doc, homeId, items, omittedCount = 0) => appendedItems(doc, homeId, items, limit, omittedCount);
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
    /** Batch `batchId`'s relay turn did not finish: it is owed again under a
     *  fresh wake id (the old one names the failed turn), as try `tries`, not
     *  before `notBefore`. Returns the new batch; null when it is gone. */
    async rewake(homeId, batchId, { tries, notBefore }) {
      let next = null;
      await update((doc) => {
        next = null;
        const state = wakeState(doc.wakes, homeId);
        const index = state.batches.findIndex((batch) => batch.id === batchId);
        if (index < 0) return undefined;
        // The new try's turn is its own: it follows no earlier turn.
        const { follows: _follows, ...batch } = state.batches[index];
        next = { ...batch, id: `awake_${randomUUID()}`, tries, notBefore };
        const batches = state.batches.map((batch, i) => (i === index ? next : batch));
        return withWakeState(doc, homeId, { ...state, batches });
      });
      return next;
    },
    /** Store `fields` on batch `batchId` (same wake id). */
    async markBatch(homeId, batchId, fields) {
      await update((doc) => {
        const state = wakeState(doc.wakes, homeId);
        if (!state.batches.some((batch) => batch.id === batchId)) return undefined;
        const batches = state.batches.map((batch) => (batch.id === batchId ? { ...batch, ...fields } : batch));
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
    /** Queue `item` for `homeId`; `unwatch` (run ids) drops those watches in the
     *  same write, also when the item was queued or posted before.
     *  `progressPosted`: the thread holds the progress update a final report
     *  names (withoutRepeatedProgress). `progressed` (`{ runId, turnId }`):
     *  watch `runId` reported turn `turnId` as progress — its durable mark,
     *  stored in the same write (agent-task-sessions.mjs progressedThrough). */
    async add(homeId, queued, { unwatch = [], progressPosted = false, progressed = null } = {}) {
      await update((stored) => {
        const { doc, item } = withoutRepeatedProgress(stored, homeId, queued, progressPosted);
        let next = null;
        if (item.roundTrip !== true) next = appended(doc, homeId, [item]);
        else {
          // A task turn's end counts one round trip, once per run id, per home
          // and target: the user's next message in that home starts over
          // (resetRounds), and so does a count idle past ROUND_TTL_MS. Only a
          // send made in a bot-descended turn counts: the user's or a routine's
          // own delegations never use the budget up.
          const own = freshRounds(doc.rounds[homeId]);
          const counts = sendDepth(item) > 0;
          const round = counts ? (own[item.taskSessionId]?.n || 0) + 1 : 0;
          next = appended(doc, homeId, [{ ...item, round }]);
          if (next && counts) {
            const counted = { ...own, [item.taskSessionId]: { n: round, at: now() } };
            next = { ...next, rounds: { ...doc.rounds, [homeId]: counted } };
          }
        }
        let watches = doc.watches;
        const marked = progressed?.turnId && watches[progressed.runId];
        if (marked && marked.progressed !== progressed.turnId) {
          watches = { ...watches, [progressed.runId]: { ...marked, progressed: progressed.turnId } };
        }
        const dropped = unwatch.filter((runId) => watches[runId]);
        if (dropped.length) {
          watches = { ...watches };
          for (const runId of dropped) delete watches[runId];
        }
        const base = next || doc;
        if (watches === doc.watches) return base === stored ? undefined : base;
        return { ...base, watches };
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
          throw Object.assign(new Error(`${watch.homeSessionId} already waits on ${own.length} session reports`), {
            code: 'REPORT_WATCH_CAP',
          });
        }
        return { ...doc, watches: { ...watches, [watch.runId]: watch } };
      });
    },
    watchCap: caps.watches,
    /** Every stored watch, oldest first; each is a live hand-off (after a
     *  restart, this read brings them back). */
    async watches() {
      const watches = Object.values((await read()).watches);
      for (const watch of watches) noteHandoff(watch ?? {});
      return watches;
    },
    /** The watch of `runId` follows the turn submitted as `submissionId`: a
     *  room member's one turn answering several sends, or a fresh turn
     *  replacing one cut short (recovery reads that turn's end). */
    async followWatch(runId, submissionId) {
      await update((doc) => {
        const watch = doc.watches[runId];
        if (!watch || watch.follows === submissionId) return undefined;
        return { ...doc, watches: { ...doc.watches, [runId]: { ...watch, follows: submissionId } } };
      });
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
        let wakes;
        ({ wakes, overflowed } = owedWakes(doc, homeId, wake, caps.wakeRunIds));
        return { ...withDequeued(doc, homeId, runIds, omitted), wakes };
      });
      return { overflowed };
    },
  };
}

const messageIdOf = (runId) => `routine_${runId}`;

/** Show `notice` live in `homeId` through the `live()` surface: its answer,
 *  or false (logged) when the surface threw. */
function noticeLive(live, log, homeId, notice) {
  try {
    return live()?.notice?.(homeId, { ...notice, posted: true });
  } catch (error) {
    log(`live notice in ${homeId} failed: ${error?.message || error}`);
    return false;
  }
}

/** Dequeue every queued item (and the omission) of `homeId` unposted, and
 *  its wake obligations. */
async function dropQueued(queue, homeId, items, omitted) {
  await queue.remove(
    homeId,
    items.map((item) => item.runId),
    omitted
  );
  await queue.dropWakes(homeId);
}

/** The queued item of `result` ({ runId, kind, ok, text, runSessionId }) of
 *  a schedule or webhook `row` (enqueue). */
function routineResultItem(row, result) {
  return {
    runId: String(result.runId),
    kind: result.kind === 'webhook' ? 'webhook' : 'schedule',
    name: row.name,
    ok: result.ok === true,
    text: routineSummary(result.text),
    runSessionId: result.runSessionId || null,
    ...(result.reason ? { reason: String(result.reason) } : {}),
    ...(result.paused === true ? { paused: true } : {}),
    at: Date.now(),
  };
}

/** End the hand-off of each watch in `before` and not `after`, and start
 *  each one `after` added (both keyed by run id). */
function syncHandoffs(before, after) {
  for (const runId of Object.keys(before)) if (!after[runId]) endHandoff(runId);
  for (const [runId, watch] of Object.entries(after)) if (!before[runId]) noteHandoff(watch ?? {});
}

/** The run ids of `watches` a home at its watch `cap` gives up before
 *  storing `watch`: its oldest whose target sessions are proven deleted. */
function watchesToDrop(watches, watch, cap, sessionDeleted) {
  const own = watches.filter((kept) => kept?.homeSessionId === watch.homeSessionId && kept.runId !== watch.runId);
  const over = own.length + 1 - cap;
  return over > 0
    ? own
        .filter((kept) => sessionDeleted(kept.taskSessionId))
        .slice(0, over)
        .map((kept) => kept.runId)
    : [];
}

/** A bookkept home proven deleted: a bot's home whose definition is gone,
 *  or a room thread whose room is. Never Mixy's home, never on a missing
 *  thread record, never on an unknown answer. */
function homeProvenDeleted(homeId, agentPresence, roomPresence) {
  const agentId = agentIdOfHomeSession(homeId);
  if (agentId) return agentId !== MIXY_AGENT_ID && agentPresence(agentId) === 'deleted';
  const roomId = roomIdOfSession(homeId) || roomMemberOfSession(homeId)?.roomId || '';
  return Boolean(roomId) && roomPresence(roomId) === 'deleted';
}

// Task report statuses that post a row and wake nobody.
const QUIET_TASK_STATUSES = new Set(['started', 'blocked', 'working']);

/** The queued item of one task report (enqueueTask). */
function taskReportItem({
  runId,
  taskSessionId,
  title,
  status,
  text = '',
  target,
  files = [],
  omitted = 0,
  hop = 0,
  watchId = '',
  watchIds = [],
  progressRunId = '',
}) {
  // The model-facing reply keeps its lines up to REPLY_LIMIT; the row's
  // one-line summary is derived from it (agentTaskMessage).
  const reply = boundedReply(text);
  return {
    runId: String(runId),
    kind: 'agent-task',
    taskSessionId,
    title,
    status,
    text: reply.text,
    // The UI row's one line comes from the whole reply, not its bounded part.
    summary: routineSummary(text),
    ...(reply.chars > reply.text.length ? { textChars: reply.chars } : {}),
    // Any session other than a task session the agent created.
    ...(target === 'session' ? { target } : {}),
    // The send this report ends (the `sendId` the send's result named).
    ...(watchId ? { sendId: String(watchId) } : {}),
    // Every send this one turn answered (sends folded into a running turn
    // report once); `sendId` is the first of them.
    ...(watchIds.length > 1 ? { sendIds: watchIds.map(String) } : {}),
    // The files the turn produced (handoff-attachments.mjs collectTurnArtifacts).
    ...(Array.isArray(files) && files.length ? { files, ...(omitted > 0 ? { omitted } : {}) } : {}),
    // The progress update that carried this final report's answer, if one
    // did: the queue keeps the answer from being repeated (withoutRepeatedProgress).
    ...(progressRunId ? { progressRunId: String(progressRunId) } : {}),
    // Only a turn's end wakes the agent and counts a round trip: not its
    // start, a wait for the user, or a progress update (status 'working').
    roundTrip: !QUIET_TASK_STATUSES.has(status),
    ...(hop > 0 ? { hop } : {}),
    at: Date.now(),
  };
}

/** Append to `session.messages` the omission notice and the queued `items`
 *  not posted before. `fresh`: the rows newly posted; `toWake`: the run ids
 *  owed a wake (every dequeued task result, posted now or before). */
function postQueuedRows(session, items, omitted) {
  const posted = new Set(session.messages.map((message) => message?.meta?.transcript?.messageId).filter(Boolean));
  const fresh = [];
  const omittedId = omitted ? messageIdOf(omitted.id) : '';
  if (omitted && !posted.has(omittedId)) {
    const message = postedMessage(routineOmittedMessage({ count: omitted.count, messageId: omittedId }));
    session.messages.push(message);
    fresh.push({ message, notice: routineResultNotice(message) });
  }
  const toWake = [];
  for (const item of items) {
    const row = deliveredRow(item, messageIdOf(item.runId));
    if (row.wake) toWake.push(item.runId);
    if (posted.has(messageIdOf(item.runId))) continue;
    session.messages.push(row.message);
    fresh.push(row);
  }
  return { fresh, toWake };
}

/** The relay of posted task results: owed results wake the agent with one
 *  hidden turn per batch. A batch is stored with its wake id BEFORE the wake
 *  is submitted and dropped once its relay turn settled done, so a restart in
 *  between re-checks that exact id; a relay turn that did not finish is owed
 *  again under a fresh id (retryRelay). Results owed later form a new batch.
 *  A replayed run id is never queued again. */
function createHomeRelay({
  queue,
  saveSession,
  live,
  roomRelay,
  busy,
  later,
  drain,
  log,
  wakeRetryDelaysMs,
  wakeRefusalLimit,
  busyRetryMs,
  missingRetryMs,
}) {
  // Wake batch id → 'running' while this process's relay turn runs, then
  // 'done' or 'failed' once it settled (until the batch is retired).
  const relays = new Map();

  /** How `batch`'s relay turn went: '' when no turn took it, else
   *  'running', 'done' or 'failed'. A turn an earlier process took decides by
   *  its recorded end; one with none was cut off by the restart. A room
   *  member's batch may be answered by a turn under another submission id
   *  (`follows`, recorded before that turn was submitted). */
  function relayOf(batch, messages, taken) {
    const local = relays.get(batch.id);
    if (local) return local;
    const turnId = batch.follows || batch.id;
    if (!taken.has(turnId)) return '';
    const outcome = submissionOutcome(messages, turnId);
    return outcome && outcome !== 'open' && outcome.status === 'completed' ? 'done' : 'failed';
  }

  /** The relay turn of `batch` did not finish: owe it again after a backoff,
   *  or, past the last try, leave a note in the thread and wake nobody. */
  async function retryRelay(homeId, session, batch) {
    const tries = (Number(batch.tries) || 0) + 1;
    if (tries <= wakeRetryDelaysMs.length) {
      log(`the relay turn in ${homeId} did not finish (try ${tries}); waking it again later`);
      await queue.rewake(homeId, batch.id, { tries, notBefore: Date.now() + wakeRetryDelaysMs[tries - 1] });
      return true;
    }
    return abandonRelay(homeId, session, batch, `did not finish after ${tries} tries`, tries);
  }

  /** Give up on `batch`'s relay: a note in the thread (once), nobody woken.
   *  False while the thread is busy (try again once it is idle). */
  async function abandonRelay(homeId, session, batch, why, tries) {
    if (busy(homeId)) return false;
    log(`the relay turn in ${homeId} ${why}; its results stay posted unrelayed`);
    const messageId = messageIdOf(`relay_${batch.id}`);
    if (!session.messages.some((message) => message?.meta?.transcript?.messageId === messageId)) {
      const message = postedMessage(
        agentTaskRelayFailedMessage({
          count: batch.runIds.length + (batch.overflow?.count || 0),
          tries,
          messageId,
        })
      );
      session.messages.push(message);
      session.updatedAt = Date.now();
      await saveSession(session);
      noticeLive(live, log, homeId, { ...routineResultNotice(message), messageId, at: message.meta.transcript.at });
    }
    await queue.woke(homeId, batch.id);
    return true;
  }

  /** Wake `homeId` (its idle `session`, just posted to) for its next owed batch. */
  async function wakeOwed(homeId, session) {
    const byId = new Map(session.messages.map((message) => [message?.meta?.transcript?.messageId, message]));
    const taken = new Set(session.messages.flatMap((message) => submissionIdsOf(message)));
    let batch = null;
    let woken = [];
    let more = 0;
    for (;;) {
      batch = (await queue.wakes(homeId)).batches[0] || (await queue.batchWake(homeId));
      if (!batch) return;
      const relay = relayOf(batch, session.messages, taken);
      // Its settle drains again.
      if (relay === 'running') return;
      if (relay) {
        relays.delete(batch.id);
        if (relay === 'done') await queue.woke(homeId, batch.id);
        else if (!(await retryRelay(homeId, session, batch))) return later(homeId, busyRetryMs);
        continue;
      }
      const wait = (Number(batch.notBefore) || 0) - Date.now();
      if (wait > 0) return later(homeId, wait);
      woken = batch.runIds.map((runId) => byId.get(messageIdOf(runId))).filter(Boolean);
      // Results past the wake cap ride this wake as a count of rows to read.
      more = byId.has(messageIdOf(batch.overflow?.newest)) ? batch.overflow.count : 0;
      if (woken.length || more) break;
      // Its rows are gone with a thread reset.
      await queue.woke(homeId, batch.id);
    }
    // A room member relays in its room (the room host runs that turn), any
    // other thread in a hidden turn of its own.
    const surface = live();
    const wake = roomMemberOfSession(homeId) ? roomRelay : surface?.wake?.bind(surface);
    if (typeof wake !== 'function') return later(homeId, busyRetryMs);
    const batchId = batch.id;
    let turn;
    relays.set(batchId, 'running');
    try {
      // The reports answer sends this home made itself: the wake turn resumes
      // at the depth of the turns that sent them (bot-hops.mjs), 0 for work the
      // user or a routine started, so only bot-descended chains keep counting.
      const hop = Math.max(0, ...woken.map((message) => sendDepth(message?.meta?.routine)));
      // A room relay may be answered under another turn's submission id: the
      // batch records it before that turn is submitted.
      const follow = (submissionId) => queue.markBatch(homeId, batchId, { follows: submissionId });
      turn = await wake(homeId, agentTaskWakePrompt(woken, { more }), { id: batchId, hop, follow });
      if (turn === false) throw new Error('the wake turn was refused');
    } catch (error) {
      relays.delete(batchId);
      // A wake refused (or failing) every time is retried a bounded number of times.
      const refusals = (Number(batch.refusals) || 0) + 1;
      if (refusals >= wakeRefusalLimit) {
        if (await abandonRelay(homeId, session, batch, `could not start (${refusals} refusals)`, refusals)) return;
        return later(homeId, busyRetryMs);
      }
      await queue.markBatch(homeId, batchId, { refusals });
      log(`waking ${homeId} failed (${refusals}/${wakeRefusalLimit}), retrying: ${error?.message || error}`);
      return later(homeId, missingRetryMs);
    }
    // `settled` resolves the relay turn's end status: only 'done' retires the batch.
    if (typeof turn?.settled?.then === 'function') {
      const settled = (status) => {
        relays.set(batchId, status === 'done' ? 'done' : 'failed');
        void drain(homeId);
      };
      turn.settled.then(settled, () => settled('failed'));
      return;
    }
    // A surface that cannot report the turn's end: taking it is relaying it.
    relays.delete(batchId);
    await queue.woke(homeId, batchId);
    // Another batch left by an earlier process wakes once this turn is done.
    if (owesWake(await queue.wakes(homeId))) later(homeId, busyRetryMs);
  }

  return { wakeOwed };
}

/** Whether home thread `sessionId` is busy: a turn in flight in this process,
 *  or the `live()` surface says so (false when it threw). */
const homeBusy = (turnInFlight, live) => (sessionId) => {
  if (turnInFlight(sessionId)) return true;
  try {
    return live()?.busy?.(sessionId) === true;
  } catch {
    return false;
  }
};

/** `later(homeId, ms)`: drain `homeId` again after `ms`, one retry timer per
 *  home armed at a time. */
function createRetryTimer(retryLater, drain) {
  const waiting = new Set(); // homes with a retry timer armed
  return function later(homeId, ms) {
    if (waiting.has(homeId)) return;
    waiting.add(homeId);
    retryLater(() => {
      waiting.delete(homeId);
      void drain(homeId);
    }, ms);
  };
}

/** The held requests shown live in a busy thread. A held request waits on the
 *  user, possibly raised by the very turn that keeps its thread busy (a
 *  routine turn): `show` shows it live at once; the stored row (same
 *  messageId) replaces it once the thread is idle, and `forget` lets a later
 *  one show again. */
function createHeldLiveDisplay(live, log) {
  const shownLive = new Set(); // held-request message ids shown live in a busy thread
  return {
    show(homeId, items) {
      for (const item of items) {
        if (item.kind !== 'held-request') continue;
        const messageId = messageIdOf(item.runId);
        if (shownLive.has(messageId)) continue;
        shownLive.add(messageId);
        noticeLive(live, log, homeId, { ...deliveredRow(item, messageId).notice, messageId, at: item.at });
      }
    },
    forget(items) {
      for (const item of items) shownLive.delete(messageIdOf(item.runId));
    },
  };
}

/** The queues a drain drops unposted instead of retrying them. */
function createQueueDrops({ queue, log, homeAgent, homeDeleted, sessionDeleted }) {
  /** A room thread proven gone: its queued rows are dropped, never retried. */
  async function dropGoneRoomThread(homeId, items, omitted) {
    if (!isRoomThreadSessionId(homeId) || !(homeDeleted(homeId) || sessionDeleted(homeId))) return false;
    log(`${items.length} task report(s) for the deleted ${homeId} are dropped`);
    await dropQueued(queue, homeId, items, omitted);
    return true;
  }

  /** A room log's queued rows: task reports go to member sessions now, so what
   *  an earlier version left under the log's id is dropped, never posted. */
  async function dropRoomLogQueue(logId, items, omitted) {
    log(`${items.length} legacy task report(s) queued for the room log ${logId} are dropped`);
    await dropQueued(queue, logId, items, omitted);
  }

  /** A missing home of an agent that can never have one (no bot): its queued
   *  rows are dropped with a log line, never retried. */
  async function dropHomeless(homeId, items, omitted) {
    const agentId = agentIdOfHomeSession(homeId);
    if (!agentId || agentId === MIXY_AGENT_ID || homeAgent(agentId) !== 'none') return false;
    log(`${items.length} result(s) for ${homeId} are dropped: ${agentId} is not a bot, so it has no chat`);
    await dropQueued(queue, homeId, items, omitted);
    return true;
  }

  return { dropGoneRoomThread, dropRoomLogQueue, dropHomeless };
}

/** The durable intake of a home: each enqueue persists its row for the home
 *  thread, then starts draining it, and resolves once it is queued. */
function createHomeEnqueue(queue, drain, { postingFor, postedIn }) {
  /** Persist `result` ({ runId, kind, ok, text, runSessionId }) of a schedule
   *  or webhook `row` for its owner's home, then start draining it. Resolves
   *  once it is queued. */
  async function enqueue(row, result) {
    const homeId = agentHomeSessionId(scheduleOwnerAgentId(row));
    if (!result?.runId) throw new Error('routine result: runId required');
    await queue.add(homeId, routineResultItem(row, result));
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
  async function enqueueTask(agentId, report) {
    const { runId, taskSessionId, watchId = '', watchIds = [], from = '' } = report;
    const homeId = agentHomeSessionId(agentId) || agentHomeSessionId(MIXY_AGENT_ID);
    if (!runId || !taskSessionId) throw new Error('task report: runId and taskSessionId required');
    const item = taskReportItem(report);
    const unwatch = [...new Set([watchId, ...watchIds].filter(Boolean).map(String))];
    // A room member's own work reports to its member session, never its home.
    const target = roomMemberOfSession(from)?.agentId === agentId ? from : homeId;
    if (item.progressRunId) {
      // Whether its answer already went out as that progress update is
      // decided in the thread's posting turn, against the thread itself: a
      // row being posted (or posted before a crash, not dequeued yet) counts
      // as posted, never as still queued.
      await postingFor(target, async () =>
        queue.add(target, item, { unwatch, progressPosted: postedIn(target, item.progressRunId) })
      );
    } else {
      // A progress update moves its send's watch mark (`progressed`) to the
      // turn it carries, in the same write: a restart never reports it again.
      const progressed = report.progressWatchId
        ? { runId: String(report.progressWatchId), turnId: String(report.answerId || '') }
        : null;
      await queue.add(target, item, { unwatch, progressed });
    }
    void drain(target);
    return target;
  }

  /** Persist `text`, the agent's own reply from turn `runId` it ran outside
   *  its thread, for `agentId`'s home thread, then start draining it. It posts
   *  once, as the agent's message; no turn follows. */
  async function enqueueMessage(agentId, { runId, text }) {
    const homeId = agentHomeSessionId(agentId) || agentHomeSessionId(MIXY_AGENT_ID);
    if (!runId || !String(text || '').trim()) throw new Error('agent message: runId and text required');
    await queue.add(homeId, { runId: String(runId), kind: 'agent-message', text: String(text).trim(), at: Date.now() });
    void drain(homeId);
    return homeId;
  }

  return { enqueue, enqueueHeld, enqueueTask, enqueueMessage };
}

/** The queue's bookkeeping across processes: report watches and the restart
 *  recovery that retires deleted homes and drains what was left queued. */
function createHomeBookkeeping({ queue, log, homeDeleted, sessionDeleted, drain }) {
  /** Retire the bookkeeping of deleted homes (and stale round counts). */
  async function prune() {
    await queue.prune((await queue.bookkeptHomes()).filter(homeDeleted));
  }

  /** Store `watch`; a home at its watch cap first gives up its oldest watches
   *  whose target sessions are proven deleted, and refuses the watch (so the
   *  send claims no report) when that frees too few. */
  async function watchTask(watch) {
    const drop = watchesToDrop(await queue.watches(), watch, queue.watchCap, sessionDeleted);
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
    // The stored watches name the hand-offs an earlier process left open:
    // reading them notes each one now, so a target that asks again after the
    // restart reaches the chat that handed it the work.
    try {
      await queue.watches();
    } catch (error) {
      log(`reading the report watches failed: ${error?.message || error}`);
    }
    const homes = await queue.pendingHomes();
    for (const homeId of homes) void drain(homeId);
    return homes;
  }

  return { watchTask, recover };
}

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
  // 'bot' | 'none' | 'unknown' per agent id: whether it can have a home chat
  // at all. 'none' (proven: a workflow agent such as Reviewer) drops the rows
  // queued for its missing home instead of waiting on it forever.
  homeAgent = () => 'unknown',
  // Waits before each new try of a relay turn that did not finish; past the
  // last one the results stay posted with a note and nobody is woken.
  wakeRetryDelaysMs = WAKE_RETRY_DELAYS_MS,
  // Refused or failing wake submissions of one batch (missingRetryMs apart)
  // before it is given up the same way.
  wakeRefusalLimit = WAKE_REFUSAL_LIMIT,
  // A room member's relay turn (wake of a member session): its turn in the
  // room, through the desktop room host (agent-room-host.mjs `relay`), with
  // the live surface's `wake` contract.
  roomRelay = (sessionId, prompt, options) => agentRoomHost().relay(sessionId, prompt, options),
  log = (line) => process.stderr.write(`mixdog routines: ${line}\n`),
}) {
  const busy = homeBusy(turnInFlight, live);
  const draining = new Map(); // home → the running pass
  const again = new Set(); // homes enqueued to while their pass ran
  const waitLogged = new Set(); // missing homes whose wait was logged
  const later = createRetryTimer(retryLater, drain);
  const heldLive = createHeldLiveDisplay(live, log);
  const homeDeleted = (homeId) => homeProvenDeleted(homeId, agentPresence, roomPresence);
  const { dropGoneRoomThread, dropRoomLogQueue, dropHomeless } = createQueueDrops({
    queue,
    log,
    homeAgent,
    homeDeleted,
    sessionDeleted,
  });
  const relay = createHomeRelay({
    queue,
    saveSession,
    live,
    roomRelay,
    busy,
    later,
    drain,
    log,
    wakeRetryDelaysMs,
    wakeRefusalLimit,
    busyRetryMs,
    missingRetryMs,
  });
  // Per thread, one posting turn at a time: push queued rows, save the
  // thread, dequeue them (the drain, the turn prelude), and a final report's
  // check whether its answer already went out as a progress update. No pass
  // ever dequeues rows another pushed but has not saved yet, and a row being
  // posted is never mistaken for one still queued.
  const postingChains = new Map();
  function postingFor(homeId, fn) {
    const run = (postingChains.get(homeId) || Promise.resolve()).then(fn);
    const tail = run.then(
      () => {},
      () => {}
    );
    postingChains.set(homeId, tail);
    void tail.then(() => {
      if (postingChains.get(homeId) === tail) postingChains.delete(homeId);
    });
    return run;
  }
  /** Whether queued row `runId` is in thread `homeId` (posted, saved or not). */
  const postedIn = (homeId, runId) => {
    const messages = loadSession(homeId)?.messages;
    const messageId = messageIdOf(runId);
    return Array.isArray(messages) && messages.some((message) => message?.meta?.transcript?.messageId === messageId);
  };
  const intake = createHomeEnqueue(queue, drain, { postingFor, postedIn });
  const { watchTask, recover } = createHomeBookkeeping({ queue, log, homeDeleted, sessionDeleted, drain });

  /** Append `items` (and the omission notice `omitted`) not posted before to
   *  `homeId`'s thread `session`, store it and show the new rows live.
   *  Returns the run ids owed a wake (postQueuedRows). Nothing awaits before
   *  the push, so no turn can start in between. */
  async function postRows(homeId, session, items, omitted) {
    if (!Array.isArray(session.messages)) session.messages = [];
    const { fresh, toWake } = postQueuedRows(session, items, omitted);
    heldLive.forget(items);
    // The caller dequeues `items` (and `omitted`) next: the thread holding
    // them is saved first, also when an earlier pass pushed them but its save
    // failed (they are in the thread in memory, not on disk).
    if (items.length || omitted) {
      if (fresh.length) session.updatedAt = Date.now();
      await saveSession(session);
    }
    for (const { message, notice } of fresh) {
      const { messageId, at } = message.meta.transcript;
      noticeLive(live, log, homeId, { ...notice, messageId, at });
    }
    return toWake;
  }

  /** Right before a turn of thread `homeId` takes its prompt (whatever started
   *  it: the user, a routine, a wake): post its queued rows that wake nobody —
   *  progress updates of the sessions its agent handed work to, start and wait
   *  lines, held requests, routine results — in queue order, so the turn reads
   *  them before its prompt. Rows that wake the agent stay for the drain after
   *  the turn, which posts them and wakes it as before. The caller starts the
   *  turn, so the thread's busy state is its own. Rows the queue dropped past
   *  its limit are announced first by the "n omitted" notice, retired in the
   *  same write that dequeues the posted rows (as the drain does). It runs
   *  in the thread's posting turn (postingFor), never beside the drain's. A
   *  failure is logged; the turn goes on and the drain posts the rows later. */
  async function postBeforeTurn(homeId) {
    try {
      await postingFor(homeId, async () => {
        const items = (await queue.items(homeId)).filter((item) => !wakesAgent(item));
        const omitted = await queue.omitted(homeId);
        if (!items.length && !omitted) return;
        const session = loadSession(homeId);
        if (!session || session.closed === true) return;
        await postRows(homeId, session, items, omitted);
        await queue.remove(
          homeId,
          items.map((item) => item.runId),
          omitted
        );
      });
    } catch (error) {
      log(`posting the rows owed before a turn of ${homeId} failed: ${error?.message || error}`);
    }
  }

  /** Post every queued result of `homeId` if its thread is idle, in its
   *  posting turn, then wake the agent for what it owes; else retry later.
   *  The wake runs outside the posting turn: the turn it starts posts first
   *  (postBeforeTurn). */
  async function drainOnce(homeId) {
    const session = await postingFor(homeId, () => postIdle(homeId));
    if (session) await relay.wakeOwed(homeId, session);
  }

  /** drainOnce's posting: the thread it posted to; nothing when nothing is
   *  owed or the pass ends here (moved, busy, missing, dropped). */
  async function postIdle(homeId) {
    const items = await queue.items(homeId);
    const omitted = await queue.omitted(homeId);
    const owed = owesWake(await queue.wakes(homeId));
    if (!items.length && !omitted && !owed) return;
    if (roomIdOfSession(homeId)) return dropRoomLogQueue(homeId, items, omitted);
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
      heldLive.show(homeId, items);
      return later(homeId, busyRetryMs);
    }
    // From here to the push nothing awaits, so no turn can start in between.
    const session = loadSession(homeId);
    if (!session || session.closed === true) {
      if (await dropGoneRoomThread(homeId, items, omitted)) return;
      if (await dropHomeless(homeId, items, omitted)) return;
      // Kept (a bot, or an agent whose kind cannot be read): logged once per process.
      if (!waitLogged.has(homeId)) {
        waitLogged.add(homeId);
        log(`${items.length} result(s) wait for the home thread ${homeId}`);
      }
      return later(homeId, missingRetryMs);
    }
    const toWake = await postRows(homeId, session, items, omitted);
    // Dequeuing and owing the wake are one write: no restart between posting
    // and waking loses the wake.
    const { overflowed } = await queue.remove(
      homeId,
      items.map((item) => item.runId),
      omitted,
      { wake: toWake }
    );
    if (overflowed) log(`${homeId} is at its wake cap: ${overflowed} result(s) ride the next wake as a count`);
    return session;
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

  /** Show `run`'s live-only row (routineRunNotice: `running`, or a result whose
   *  delivery failed) in `row`'s owner home when it is open and idle. Nothing
   *  is stored and no turn or unread mark follows; the posted result (same
   *  messageId) replaces it. False when no window shows it. */
  function announce(row, run) {
    const homeId = agentHomeSessionId(scheduleOwnerAgentId(row));
    if (!run?.runId || busy(homeId)) return false;
    const notice = routineRunNotice({ ...run, name: row.name, messageId: messageIdOf(run.runId) });
    return noticeLive(live, log, homeId, notice) === true;
  }

  return {
    ...intake,
    announce,
    drain,
    postBeforeTurn,
    recover,
    watchTask,
    unwatchTask: (runId) => queue.unwatch(runId),
    followTask: (runId, submissionId) => queue.followWatch(runId, submissionId),
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
      { mixdogRoot },
    ] = await Promise.all([
      import('../runtime/agent/orchestrator/session/store.mjs'),
      import('../runtime/agent/orchestrator/session/manager/runtime-liveness.mjs'),
      import('../runtime/agent/orchestrator/config.mjs'),
      import('./workflow-agents-api/agent-editor.mjs'),
      import('../runtime/agent/orchestrator/session/store/fs-probe.mjs'),
      import('../runtime/agent/orchestrator/session/store/session-paths.mjs'),
      import('../runtime/shared/plugin-paths.mjs'),
    ]);
    // The editor's per-id definition probe: 'deleted' only when proven gone.
    const { agentDefinitionPresence } = createAgentEditorApi({ cfgMod: { getPluginData } });
    defaultDelivery = createAgentHomeDelivery({
      loadSession,
      saveSession: (session) => saveSessionAsync(session, { expectedGeneration: session.generation }),
      turnInFlight: isSessionTurnInFlight,
      queue: createRoutineResultQueue(join(getPluginData(), 'routine-results.json')),
      agentPresence: (agentId) => agentDefinitionPresence([agentId])[agentId],
      // A home chat exists only for bots; only a definition read successfully
      // can prove an agent is none (readHomeAgent).
      homeAgent: (agentId) => readHomeAgent({ dataDir: getPluginData(), shippedRoot: mixdogRoot(), id: agentId }),
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

/** Queue the agent's own reply of a turn it ran outside its home thread. */
export async function deliverAgentMessage(agentId, message) {
  return (await processDelivery()).enqueueMessage(agentId, message);
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

/** One reporting turn's watch follows the turn submitted as `submissionId`. */
export async function followAgentTask(runId, submissionId) {
  return (await processDelivery()).followTask(runId, submissionId);
}

/** A user's own message in `homeId`: its round trips with every target restart. */
export async function resetAgentTaskRounds(homeId) {
  return (await processDelivery()).resetRounds(homeId);
}

/** The reporting turns whose report was not queued yet. */
export async function agentTaskWatches() {
  return (await processDelivery()).taskWatches();
}

/** The session turn prelude (session-turn-prelude.mjs) of the daemon: before a
 *  turn of an agent's home thread or a room member session starts, its queued
 *  rows that wake nobody post first (postBeforeTurn). Null for any other
 *  session: nothing to wait for. */
export function postBeforeAgentTurn(sessionId) {
  if (!isAgentHomeSessionId(sessionId) && !roomMemberOfSession(sessionId)) return null;
  return processDelivery().then((delivery) => delivery.postBeforeTurn(sessionId));
}

/** Daemon start: post the results an earlier process left queued. */
export async function recoverScheduleResults() {
  return (await processDelivery()).recover();
}
