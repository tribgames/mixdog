// agent-tool/status-sets.mjs
// What getStatus answers each status scope, maintained per agent instead of
// recomputed per read. For every scope the set holds exactly the rows the
// status read (statusFor in agent-tool.mjs, kept as the reference) would list:
// the listed workers keyed by session id and the jobs keyed by task id, each
// with its serialised body and its place in the read's order.
//
// A source names what changed (a session id, an index row, a tag, a task
// owner) and only that entry is derived again, in the scopes it matches; a
// finished worker is simply not in a set. Inputs that change without naming
// themselves (a watchdog arming, transport arriving, a live copy evicted)
// are caught by comparing each listed agent's few in-memory inputs on every
// pass (`witnessOf`), which derives nothing unless one moved.
//
// Order rule (as the read's): workers from index rows first, in the index
// document's order (a new key comes last), then workers bound only by tag in
// the tag map's insertion order; jobs in task registration order.
import { _liveSessions } from '../../../runtime/agent/orchestrator/session/store/live-state.mjs';
import {
  FINISHED_TASK_TTL_MS,
  listBackgroundTasks,
  onBackgroundTasksEvicted,
} from '../../../runtime/shared/background-tasks.mjs';
import { getProgressWatchdogState } from '../agent-watchdog-registry.mjs';
import {
  callerSessionForContext,
  clean,
  positiveInt,
  rowMatchesContext,
  sessionMatchesContext,
  terminalPidForContext,
} from './helpers.mjs';
import { agentListRow } from './job-views/agent-list.mjs';
import { jobListRow, jobRowInTerminal } from './job-views/job-render.mjs';
import { isTerminalJobStatus, liveAgentStatusRow } from './job-views/session-progress.mjs';
import { workerRowToSession } from './worker-rows.mjs';

const WORKERS = 'w';
const JOBS = 'j';
const EMPTY = Object.freeze([]);

const sameOrder = (a, b) => a[0] === b[0] && a[1] === b[1];
const compareOrder = (a, b) => a.order[0] - b.order[0] || a.order[1] - b.order[1];

/** The `scope` field statusFor answers for a context. */
export function statusScopeOf(context) {
  const ownerSession = callerSessionForContext(context);
  const pid = terminalPidForContext(context);
  if (ownerSession) return { sessionId: ownerSession };
  if (pid) return { clientHostPid: pid };
  return { allTerminals: true };
}

// The fields of a task summary its job row reads (jobListRow).
const jobSig = (task) =>
  JSON.stringify([
    task.task_id,
    task.operation,
    task.status,
    task.startedAt,
    task.finishedAt,
    task.error,
    task.tag,
    task.sessionId,
    task.agent,
    task.preset,
    task.provider,
    task.model,
    task.effort,
    task.fast,
  ]);

// The scalar session fields a worker row reads (agentRow, rowState,
// sessionUsageTotals; sessionProgressExtras reads `status`), plus the message
// and tool counts witnessOf adds.
const SESSION_FIELDS = [
  'id',
  'status',
  'closed',
  'stage',
  'agent',
  'provider',
  'model',
  'presetName',
  'effort',
  'fast',
  'autoEffort',
  'modelParameters',
  'createdAt',
  'updatedAt',
  'lastUsedAt',
  'clientHostPid',
  'totalInputTokens',
  'totalOutputTokens',
  'totalToolCalls',
  'lastContextTokens',
  'lastInputTokens',
  'contextWindow',
  'permission',
  'toolPermission',
  'turnStartedAt',
];
const SESSION_FIELDS_ABSENT = Object.freeze([]);

let epochSeq = 0;

export function createStatusSets({ mgr, registry, progress, sessionRecords, now = () => Date.now() }) {
  const feed = registry.rowFeed;
  const { tags } = registry;
  const scopes = new Map(); // key -> scope
  const byOwner = new Map(); // owner session -> Set<scope>
  const byPid = new Map(); // pid -> Set<scope> without an owner
  const globals = new Set(); // scopes with neither
  const byTaskId = new Map(); // a session id a scope's task match reads -> Set<scope>
  const looseTaskScopes = new Set(); // scopes whose task match reads no session id
  let scopeSeq = 0;

  const counters = { evaluations: 0, derivations: 0, witnesses: 0, tombstoneIterations: 0, auditHits: 0, jobListings: 0 };

  // ── pending work ────────────────────────────────────────────────────────
  const dirtySids = new Set();
  const bindDirty = new Set(); // tags whose index binding may differ from the read's
  const jobGates = new Set(); // session ids a task change was announced for
  let jobGateAll = false;
  let rolesDirty = new Set();
  let releaseDue = false;

  // ── per-agent state ─────────────────────────────────────────────────────
  // sid -> { scopes: Set<scope> (listed as a worker), role, witness, recordRead }
  const agents = new Map();
  const sidTags = new Map(); // sid -> Set<tag> bound to it in `tags`
  const taskRecs = new Map(); // taskId -> { sig, summary, row, str, sid, role, running, finishedMs, scopes }
  const sidTasks = new Map(); // sid -> Set<taskId>
  let nextExpiry = Infinity;
  const witnesses = new Map(); // sid -> witness array (agents listed now)

  const addTo = (map, key, value) => {
    let set = map.get(key);
    if (!set) map.set(key, (set = new Set()));
    set.add(value);
  };
  const removeFrom = (map, key, value) => {
    const set = map.get(key);
    if (!set) return;
    set.delete(value);
    if (set.size === 0) map.delete(key);
  };

  for (const [tag, sid] of tags) addTo(sidTags, sid, tag);
  let binding = false;
  const stopTags = registry.onTagMapsChange((map, tag, previous, next) => {
    if (map === 'tags') {
      if (previous !== undefined) {
        removeFrom(sidTags, previous, tag);
        dirtySids.add(previous);
      }
      if (next !== undefined) {
        addTo(sidTags, next, tag);
        dirtySids.add(next);
      }
    }
    // The read re-binds index tags on every pass: another writer's change is undone there.
    if (!binding) bindDirty.add(tag);
  });
  // A prune anywhere (a read's, a register's cap) removed tasks: the scopes
  // listing them list again in the next step. A finished job's 30-minute
  // expiry is also a moment of its own (settleJobs), since the read itself
  // prunes it.
  const stopEvictions = onBackgroundTasksEvicted((evicted) => {
    for (const { taskId } of evicted) for (const scope of taskRecs.get(taskId)?.scopes || EMPTY) scope.gated = true;
  });
  const stopFeed = feed.subscribe(({ sids, tags: changedTags }) => {
    for (const sid of sids) dirtySids.add(sid);
    for (const tag of changedTags) {
      bindDirty.add(tag);
      // A tombstone of this tag may block or free the session bound to it.
      const bound = tags.get(tag);
      if (bound) dirtySids.add(bound);
    }
  });

  // ── scopes ──────────────────────────────────────────────────────────────
  function taskIdsOf(context) {
    return [context?.callerSessionId, context?.routingSessionId, context?.sessionId].map(clean).filter(Boolean);
  }

  function addScope(key, context) {
    if (scopes.has(key)) return;
    const owner = callerSessionForContext(context) || '';
    const pid = terminalPidForContext(context) || 0;
    const scope = {
      key,
      seq: ++scopeSeq,
      context,
      owner,
      pid,
      wantedPid: pid,
      taskIds: taskIdsOf(context),
      workers: new Map(), // sid -> slot { order, row, str }
      jobs: new Map(), // taskId -> slot
      jobsListed: [], // task ids in listing order (before the terminal filter)
      jobSeqs: new Map(),
      jobSeq: 0,
      handed: null,
      handedSlots: null,
      sinceHand: new Set(),
      failed: null,
      emitted: new Map(), // 'w\0id' | 'j\0id' -> { str, order }
      pending: new Set(),
      frameSeq: 0,
      epoch: `${process.pid.toString(36)}.${Date.now().toString(36)}.${(++epochSeq).toString(36)}`,
    };
    scopes.set(key, scope);
    if (owner) addTo(byOwner, owner, scope);
    else if (pid) addTo(byPid, pid, scope);
    else globals.add(scope);
    if (scope.taskIds.length === 0) looseTaskScopes.add(scope);
    for (const id of scope.taskIds) addTo(byTaskId, id, scope);
    everythingDirty();
    scope.gated = true;
  }

  function removeScope(key) {
    const scope = scopes.get(key);
    if (!scope) return;
    scopes.delete(key);
    if (scope.owner) removeFrom(byOwner, scope.owner, scope);
    else if (scope.pid) removeFrom(byPid, scope.pid, scope);
    else globals.delete(scope);
    looseTaskScopes.delete(scope);
    for (const id of scope.taskIds) removeFrom(byTaskId, id, scope);
    for (const sid of scope.workers.keys()) agents.get(sid)?.scopes.delete(scope);
    for (const id of scope.jobsListed) {
      const rec = taskRecs.get(id);
      rec?.scopes.delete(scope);
      if (rec && rec.scopes.size === 0) dropTask(id);
    }
    // The bindings and the records the read keeps follow the scopes.
    everythingDirty();
    releaseDue = true;
  }

  function everythingDirty() {
    for (const [sid, rec] of feed.rows()) {
      dirtySids.add(sid);
      bindDirty.add(rec.row.tag);
    }
    for (const sid of sidTags.keys()) dirtySids.add(sid);
    for (const sid of agents.keys()) dirtySids.add(sid);
  }

  /** The scopes whose read a record (row or session) matches, in scope order. */
  function scopesMatching(record, matches) {
    const out = [];
    const owner = clean(record?.parentSessionId || record?.ownerSessionId);
    const pid = positiveInt(record?.clientHostPid);
    for (const group of [owner ? byOwner.get(owner) : null, pid ? byPid.get(pid) : null, globals]) {
      if (!group) continue;
      for (const scope of group) if (matches(record, scope.context)) out.push(scope);
    }
    return out;
  }

  // ── slots, the sets themselves ──────────────────────────────────────────
  function setSlot(scope, list, id, order, row, str) {
    const map = list === WORKERS ? scope.workers : scope.jobs;
    const old = map.get(id);
    if (old && old.str === str && sameOrder(old.order, order)) {
      old.row = row;
      return;
    }
    map.set(id, { order, row, str });
    scope.pending.add(`${list}\0${id}`);
    scope.sinceHand.add(`${list}\0${id}`);
  }

  function dropSlot(scope, list, id) {
    const map = list === WORKERS ? scope.workers : scope.jobs;
    if (!map.delete(id)) return;
    scope.pending.add(`${list}\0${id}`);
    scope.sinceHand.add(`${list}\0${id}`);
  }

  // ── what a scope's reader last got ──────────────────────────────────────
  // `handedSlots` (slot key -> { str, order }) is the answer last handed out
  // when it was the set's own; `sinceHand` the slots changed since. Whether
  // the answer differs is then decided from those slots alone. Null after an
  // answer that was not the set's (not ready, failed, another read): the next
  // comparison is of whole answers.
  const slotOf = (scope, slotKey) => {
    const [list, id] = slotKey.split('\0');
    return (list === WORKERS ? scope.workers : scope.jobs).get(id);
  };

  function handedSequence(scope) {
    const lists = { [WORKERS]: [], [JOBS]: [] };
    for (const [slotKey, slot] of scope.handedSlots) lists[slotKey.split('\0')[0]].push(slot);
    const strs = (slots) => slots.sort(compareOrder).map((slot) => slot.str);
    return { workers: strs(lists[WORKERS]), jobs: strs(lists[JOBS]) };
  }

  function rebuildHanded(scope) {
    scope.handedSlots = new Map();
    for (const [list, map] of [[WORKERS, scope.workers], [JOBS, scope.jobs]]) {
      for (const [id, slot] of map) scope.handedSlots.set(`${list}\0${id}`, { str: slot.str, order: slot.order });
    }
    scope.sinceHand.clear();
  }

  /** Brings `handedSlots` up to the set; returns whether the answer differs. */
  function syncHanded(scope) {
    if (scope.sinceHand.size === 0) return false;
    let changed = false;
    let moved = false;
    for (const slotKey of scope.sinceHand) {
      const current = slotOf(scope, slotKey);
      const was = scope.handedSlots.get(slotKey);
      if (!current !== !was || (current && was.str !== current.str)) changed = true;
      else if (current && !sameOrder(was.order, current.order)) moved = true;
    }
    // Only rows that took other order keys: the answer differs only if their
    // places among the rows did (the whole sequence, a rare reorder).
    if (!changed && moved) {
      const before = handedSequence(scope);
      const now = strings(scope);
      changed = !(sameStrings(before.workers, now.workers) && sameStrings(before.jobs, now.jobs));
    }
    for (const slotKey of scope.sinceHand) {
      const current = slotOf(scope, slotKey);
      if (current) scope.handedSlots.set(slotKey, { str: current.str, order: current.order });
      else scope.handedSlots.delete(slotKey);
    }
    scope.sinceHand.clear();
    return changed;
  }

  // ── workers ─────────────────────────────────────────────────────────────
  function derive(entry, at) {
    counters.derivations += 1;
    const row = agentListRow({ mgr, progress }, entry, { now: at, memoryOnly: true });
    if (!row) return null;
    const shown = liveAgentStatusRow(row);
    return { row: shown, str: JSON.stringify(shown) };
  }

  function tagsOf(sid) {
    const set = sidTags.get(sid);
    if (!set) return EMPTY;
    if (set.size === 1) return [...set];
    return [...set].sort((a, b) => registry.tagSeq(a) - registry.tagSeq(b));
  }

  // The worker entry of `sid` in every scope, as the read builds it: its
  // admitted index row in the scopes that row matches, else the session a
  // tag is bound to in the scopes that session matches.
  function evalSid(sid, at) {
    counters.evaluations += 1;
    const prev = agents.get(sid);
    const next = new Map(); // scope -> slot fields
    const rec = feed.rows().get(sid);
    const rowScopes = rec?.admitted ? scopesMatching(rec.row, rowMatchesContext) : EMPTY;
    let recordRead = false;
    let role = null;
    if (rowScopes.length > 0) {
      const derived = derive({ tag: rec.row.tag, session: workerRowToSession(rec.row), indexRow: rec.row }, at);
      if (derived) {
        recordRead = true;
        role = rec.row.agent || null;
        for (const scope of rowScopes) next.set(scope, { order: [0, rec.seq], ...derived });
      }
    }
    const tagged = tagsOf(sid);
    // The read looks a tag's session up in every scope that has not listed
    // this id as an index row.
    if (tagged.length > 0 && scopes.size > rowScopes.length) {
      recordRead = true;
      const session = sessionRecords.session(sid);
      const tombstones = registry.tagTombstoneIndex();
      let entryTag = '';
      let boundTag = '';
      for (const tag of tagged) {
        entryTag = registry.tagEntryTag(session, tag, tombstones);
        if (entryTag) {
          boundTag = tag;
          break;
        }
      }
      if (entryTag) {
        const rowSet = new Set(rowScopes);
        const tagScopes = scopesMatching(session, sessionMatchesContext).filter((scope) => !rowSet.has(scope));
        if (tagScopes.length > 0) {
          const derived = derive({ tag: entryTag, session, loaded: true }, at);
          if (derived) {
            role = session.agent || null;
            for (const scope of tagScopes) next.set(scope, { order: [1, registry.tagSeq(boundTag)], ...derived });
          }
        }
      }
    }
    for (const scope of prev?.scopes || EMPTY) if (!next.has(scope)) dropSlot(scope, WORKERS, sid);
    for (const [scope, slot] of next) setSlot(scope, WORKERS, sid, slot.order, slot.row, slot.str);
    if (next.size === 0 && !recordRead) {
      if (prev) {
        agents.delete(sid);
        releaseDue = true;
      }
      return;
    }
    if (prev?.recordRead && !recordRead) releaseDue = true;
    agents.set(sid, { scopes: new Set(next.keys()), role, recordRead });
  }

  // ── tag bindings (the read binds every scope's admitted index rows) ────
  function settleBindings() {
    if (bindDirty.size === 0) return;
    const rows = feed.rows();
    const fresh = [];
    const bindings = [];
    for (const tag of bindDirty) {
      let last = null;
      let lastAgent = null;
      let lastCwd = null;
      let first = null;
      for (const sid of feed.byTag(tag) || EMPTY) {
        const rec = rows.get(sid);
        if (!rec?.admitted) continue;
        const matched = scopesMatching(rec.row, rowMatchesContext);
        if (matched.length === 0) continue;
        let min = Infinity;
        let max = -Infinity;
        for (const scope of matched) {
          min = Math.min(min, scope.seq);
          max = Math.max(max, scope.seq);
        }
        const late = [max, rec.seq];
        const early = [min, rec.seq];
        const later = (a, b) => !b || a[0] > b.key[0] || (a[0] === b.key[0] && a[1] > b.key[1]);
        if (later(late, last)) last = { key: late, rec };
        if (rec.row.agent && later(late, lastAgent)) lastAgent = { key: late, rec };
        if (rec.row.cwd && later(late, lastCwd)) lastCwd = { key: late, rec };
        if (!first || early[0] < first[0] || (early[0] === first[0] && early[1] < first[1])) first = early;
      }
      if (!last) continue;
      const binding = { tag, last, lastAgent, lastCwd, first };
      if (tags.has(tag)) bindings.push(binding);
      else fresh.push(binding);
    }
    bindDirty.clear();
    fresh.sort((a, b) => a.first[0] - b.first[0] || a.first[1] - b.first[1]);
    binding = true;
    try {
      for (const { tag, last, lastAgent, lastCwd } of [...bindings, ...fresh]) {
        if (tags.get(tag) !== last.rec.row.sessionId) tags.set(tag, last.rec.row.sessionId);
        if (lastAgent && registry.tagAgents.get(tag) !== lastAgent.rec.row.agent) {
          registry.tagAgents.set(tag, lastAgent.rec.row.agent);
        }
        if (lastCwd && registry.tagCwds.get(tag) !== lastCwd.rec.row.cwd) registry.tagCwds.set(tag, lastCwd.rec.row.cwd);
      }
    } finally {
      binding = false;
    }
  }

  // ── jobs ────────────────────────────────────────────────────────────────
  function deriveTask(rec, summary, at) {
    counters.derivations += 1;
    const row = jobListRow(progress, summary, at, true);
    const shown = liveAgentStatusRow(row);
    if (rec.sid !== summary.sessionId) {
      if (rec.sid) removeFrom(sidTasks, rec.sid, summary.task_id);
      if (summary.sessionId) addTo(sidTasks, summary.sessionId, summary.task_id);
    }
    const running = !isTerminalJobStatus(summary.status);
    const finishedMs = running ? 0 : Date.parse(summary.finishedAt || '') || 0;
    if (rec.running && rec.sid && !(running && rec.sid === summary.sessionId)) releaseDue = true;
    Object.assign(rec, {
      sig: jobSig(summary),
      summary,
      row: shown,
      // The terminal filter reads the worker's pid off the row.
      pid: row.clientHostPid,
      str: JSON.stringify(shown),
      sid: summary.sessionId || '',
      role: summary.agent || null,
      running,
      finishedMs,
    });
    if (finishedMs > 0) nextExpiry = Math.min(nextExpiry, finishedMs + FINISHED_TASK_TTL_MS);
  }

  function placeJob(scope, id) {
    const rec = taskRecs.get(id);
    if (rec && jobRowInTerminal({ clientHostPid: rec.pid }, scope.wantedPid)) {
      setSlot(scope, JOBS, id, [0, scope.jobSeqs.get(id)], rec.row, rec.str);
    } else dropSlot(scope, JOBS, id);
  }

  function dropTask(id) {
    const rec = taskRecs.get(id);
    if (!rec) return;
    taskRecs.delete(id);
    if (rec.sid) removeFrom(sidTasks, rec.sid, id);
    if (rec.running && rec.sid) releaseDue = true;
  }

  function listScopeJobs(scope, at) {
    counters.jobListings += 1;
    const listed = [];
    const seen = new Set();
    for (const summary of listBackgroundTasks({ surface: 'agent', context: scope.context })) {
      const id = summary.task_id;
      let rec = taskRecs.get(id);
      if (!rec) taskRecs.set(id, (rec = { sid: '', running: false, scopes: new Set() }));
      if (rec.sig !== jobSig(summary)) deriveTask(rec, summary, at);
      rec.scopes.add(scope);
      if (!scope.jobSeqs.has(id)) scope.jobSeqs.set(id, ++scope.jobSeq);
      listed.push(id);
      seen.add(id);
    }
    for (const id of scope.jobsListed) {
      if (seen.has(id)) continue;
      scope.jobSeqs.delete(id);
      dropSlot(scope, JOBS, id);
      const rec = taskRecs.get(id);
      rec?.scopes.delete(scope);
      if (rec && rec.scopes.size === 0) dropTask(id);
    }
    scope.jobsListed = listed;
    for (const id of listed) placeJob(scope, id);
  }

  function rederiveTasksOf(sid, at) {
    for (const id of sidTasks.get(sid) || EMPTY) {
      const rec = taskRecs.get(id);
      if (!rec?.summary) continue;
      deriveTask(rec, rec.summary, at);
      for (const scope of rec.scopes) placeJob(scope, id);
    }
  }

  function settleJobs(at) {
    let gated;
    if (jobGateAll) gated = [...scopes.values()];
    else {
      gated = new Set();
      for (const scope of scopes.values()) if (scope.gated) gated.add(scope);
      for (const id of jobGates) for (const scope of byTaskId.get(id) || EMPTY) gated.add(scope);
      // A scope that matches tasks by terminal or not at all may list any task.
      if (jobGates.size > 0) for (const scope of looseTaskScopes) gated.add(scope);
      if (at > nextExpiry) {
        nextExpiry = Infinity;
        for (const rec of taskRecs.values()) {
          if (rec.finishedMs <= 0) continue;
          const expiry = rec.finishedMs + FINISHED_TASK_TTL_MS;
          if (at > expiry) for (const scope of rec.scopes) gated.add(scope);
          else nextExpiry = Math.min(nextExpiry, expiry);
        }
      }
    }
    jobGateAll = false;
    jobGates.clear();
    for (const scope of gated) {
      scope.gated = false;
      listScopeJobs(scope, at);
    }
    // A listing may have pruned another scope's tasks: that scope lists in this step too.
    for (let again = true; again; ) {
      again = false;
      for (const scope of scopes.values()) {
        if (!scope.gated) continue;
        scope.gated = false;
        listScopeJobs(scope, at);
        again = true;
      }
    }
  }

  // ── announcement audit (tests and diagnostics only) ─────────────────────
  // Every input a row reads is announced by its source (sources.md), so a
  // pass derives only what was named. The audit checks that contract: after
  // each pass it compares every listed agent's inputs with what they were when
  // the agent was last derived, and counts each one that moved with no
  // announcement (`counters.auditHits`, the agents in `auditMisses`). It
  // derives nothing: a missed announcement stays visible in the answers too.
  let auditing = false;
  const auditMisses = [];
  function audit(derived) {
    const listed = listedSids();
    for (const sid of listed) {
      const current = witnessOf(sid, needsFullWitness(sid));
      const last = witnesses.get(sid);
      // A different shape: what the agent's rows read changed with its
      // listing (a job finished), which was announced; only values compare.
      if (!derived.has(sid) && last && last.length === current.length && !sameWitness(last, current)) {
        counters.auditHits += 1;
        // The agent and the inputs (witnessOf positions) that moved; each change counts once.
        const moved = current.map((value, i) => (Object.is(value, last[i]) ? -1 : i)).filter((i) => i >= 0);
        auditMisses.push(`${sid}@${moved.join('+')}`);
      }
      witnesses.set(sid, current);
    }
    for (const sid of witnesses.keys()) if (!listed.has(sid)) witnesses.delete(sid);
  }

  // What a listed agent's row reads in memory (the audit's comparison). A
  // terminal job reads only the live copy (its todo).
  function witnessOf(sid, full) {
    counters.witnesses += 1;
    const live = _liveSessions.get(sid);
    if (!full) return [live];
    const runtime = mgr.getSessionRuntime?.(sid) || null;
    const snapshot = mgr.getSessionProgressSnapshot?.(sid) || null;
    const watchdog = getProgressWatchdogState(mgr, sid);
    const session = sessionRecords.session(sid);
    return [
      live,
      session,
      // The answer may be the live copy itself, written in place by a turn
      // before its save announces it: the fields agentRow/rowState read.
      ...sessionFields(session),
      runtime?.stage,
      runtime?.awaitingUser,
      runtime?.taskWaits > 0,
      snapshot?.stage,
      snapshot?.waitingForTransport,
      snapshot?.waitingForFirstSemantic,
      watchdog.registered,
      watchdog.error,
      watchdog.policy,
      mgr.getSessionPendingMessageDepth?.(sid) ?? null,
    ];
  }

  function sessionFields(session) {
    if (!session) return SESSION_FIELDS_ABSENT;
    return [
      ...SESSION_FIELDS.map((key) => session[key]),
      Array.isArray(session.messages) ? session.messages.length : session.messageCount,
      Array.isArray(session.tools) ? session.tools.length : session.toolCount,
    ];
  }

  function needsFullWitness(sid) {
    if ((agents.get(sid)?.scopes.size || 0) > 0) return true;
    for (const id of sidTasks.get(sid) || EMPTY) if (taskRecs.get(id)?.running) return true;
    return false;
  }

  function listedSids() {
    const out = new Set();
    for (const [sid, state] of agents) if (state.scopes.size > 0) out.add(sid);
    for (const [sid, ids] of sidTasks) {
      for (const id of ids) {
        if ((taskRecs.get(id)?.scopes.size || 0) > 0) {
          out.add(sid);
          break;
        }
      }
    }
    return out;
  }

  const sameWitness = (a, b) => a && b && a.length === b.length && a.every((value, i) => Object.is(value, b[i]));

  // ── one step ────────────────────────────────────────────────────────────
  let failedSids = new Set();

  /** Apply every pending change. Throws nothing: a failing entry fails the
   *  scopes (their read would throw) until a later step derives it. */
  function processChanges() {
    const at = now();
    const derived = new Set();
    feed.sync();
    for (const sid of failedSids) dirtySids.add(sid);
    failedSids = new Set();
    for (const scope of scopes.values()) scope.failed = null;
    const evaluate = (sid) => {
      try {
        evalSid(sid, at);
        rederiveTasksOf(sid, at);
      } catch (error) {
        failedSids.add(sid);
        for (const scope of scopes.values()) scope.failed = error;
      }
      derived.add(sid);
    };
    const drain = () => {
      while (dirtySids.size > 0 || bindDirty.size > 0) {
        settleBindings();
        const batch = [...dirtySids];
        dirtySids.clear();
        for (const sid of batch) evaluate(sid);
      }
    };
    drain();
    if (rolesDirty.size > 0) {
      const roles = rolesDirty;
      rolesDirty = new Set();
      for (const [sid, state] of agents) if (roles.has(state.role)) dirtySids.add(sid);
      for (const rec of taskRecs.values()) if (rec.sid && roles.has(rec.role)) dirtySids.add(rec.sid);
      drain();
    }
    try {
      settleJobs(at);
    } catch (error) {
      for (const scope of scopes.values()) scope.failed = error;
    }
    if (auditing) audit(derived);
  }

  /** The records the read needs now (statusFor reads exactly these). */
  function releaseRecords() {
    if (!releaseDue) return;
    releaseDue = false;
    const keep = new Set();
    for (const [sid, state] of agents) if (state.recordRead) keep.add(sid);
    for (const rec of taskRecs.values()) if (rec.running && rec.sid && rec.scopes.size > 0) keep.add(rec.sid);
    sessionRecords.retain(keep);
  }

  // ── answers ─────────────────────────────────────────────────────────────
  const sorted = (map) => [...map].map(([id, slot]) => ({ id, ...slot })).sort(compareOrder);

  function strings(scope) {
    return {
      workers: sorted(scope.workers).map((slot) => slot.str),
      jobs: sorted(scope.jobs).map((slot) => slot.str),
    };
  }

  const sameStrings = (a, b) =>
    a.length === b.length && a.every((value, i) => value === b[i]);

  return {
    counters,
    /** Tests and diagnostics: audit every pass for unannounced changes
     *  (`counters.auditHits`, `auditMisses()` the agents). */
    setAudit(on) {
      auditing = on === true;
      witnesses.clear();
    },
    auditMisses: () => auditMisses.splice(0),
    addScope,
    removeScope,
    /** A source changed `sid`'s session (its record, its live copy, its turn). */
    noteSession(sid) {
      if (sid) dirtySids.add(sid);
    },
    /** A session's activity: its runtime, and the rows of the tasks it runs
     *  (derived with it). Which jobs a scope lists does not move with it: a
     *  job's registration and end announce themselves (noteJobs). An activity
     *  that names no session may be anyone's, jobs included. */
    noteActivity(sid) {
      if (sid) dirtySids.add(sid);
      else jobGateAll = true;
    },
    /** Agent jobs may have changed: `ownerSessionId`'s, or anyone's. */
    noteJobs(ownerSessionId = '') {
      if (ownerSessionId) jobGates.add(ownerSessionId);
      else jobGateAll = true;
    },
    noteRole(role) {
      rolesDirty.add(role ?? null);
    },
    /** A source that cannot name what it changed: every entry again. */
    rebuild() {
      everythingDirty();
      jobGateAll = true;
    },
    processChanges,
    releaseRecords,
    failed: (key) => scopes.get(key)?.failed || null,
    /** getStatus's answer for scope `key`: fresh objects, in the read's order. */
    answer(key) {
      const scope = scopes.get(key);
      return {
        workers: sorted(scope.workers).map((slot) => structuredClone(slot.row)),
        jobs: sorted(scope.jobs).map((slot) => structuredClone(slot.row)),
        scope: statusScopeOf(scope.context),
      };
    },
    /** The answer `key`'s reader got is the current one (or `given`: its
     *  serialised rows, or a marker for an answer that is not the set's). */
    handOut(key, given = null) {
      const scope = scopes.get(key);
      if (!scope) return;
      if (given !== null) {
        scope.handed = given;
        scope.handedSlots = null;
        scope.sinceHand.clear();
      } else if (scope.handedSlots) syncHanded(scope);
      else rebuildHanded(scope);
    },
    /** Whether `key`'s answer differs from the one its reader last got; it is
     *  then the one handed out. */
    passChanged(key) {
      const scope = scopes.get(key);
      if (!scope) return false;
      if (scope.failed) {
        const changed = scope.handedSlots !== null || scope.handed !== 'failed';
        scope.handed = 'failed';
        scope.handedSlots = null;
        scope.sinceHand.clear();
        return changed;
      }
      if (scope.handedSlots) return syncHanded(scope);
      // The reader got an answer that was not the set's: whole answers compare.
      const handed = scope.handed;
      const handedRows = handed !== null && typeof handed === 'object';
      const current = strings(scope);
      rebuildHanded(scope);
      return !(handedRows && sameStrings(handed.workers, current.workers) && sameStrings(handed.jobs, current.jobs));
    },
    /** The per-row frames of `key` since its last flush (wire.md). */
    flushFrames(key) {
      const scope = scopes.get(key);
      if (!scope || scope.pending.size === 0) return EMPTY;
      const frames = [];
      for (const pendingKey of scope.pending) {
        const [list, id] = pendingKey.split('\0');
        const current = (list === WORKERS ? scope.workers : scope.jobs).get(id);
        const emitted = scope.emitted.get(pendingKey);
        const name = list === WORKERS ? 'workers' : 'jobs';
        if (current) {
          if (emitted && emitted.str === current.str && sameOrder(emitted.order, current.order)) continue;
          scope.emitted.set(pendingKey, { str: current.str, order: current.order });
          frames.push({
            epoch: scope.epoch,
            seq: ++scope.frameSeq,
            list: name,
            id,
            order: [...current.order],
            row: structuredClone(current.row),
          });
        } else if (emitted) {
          scope.emitted.delete(pendingKey);
          frames.push({ epoch: scope.epoch, seq: ++scope.frameSeq, list: name, id, removed: true });
        }
      }
      scope.pending.clear();
      return frames;
    },
    /** The full list of `key` (wire.md): call after flushFrames. */
    list(key) {
      const scope = scopes.get(key);
      const entries = (map) => sorted(map).map((slot) => ({ id: slot.id, order: [...slot.order], row: structuredClone(slot.row) }));
      return {
        epoch: scope.epoch,
        seq: scope.frameSeq,
        scope: statusScopeOf(scope.context),
        workers: entries(scope.workers),
        jobs: entries(scope.jobs),
      };
    },
    keys: () => scopes.keys(),
    has: (key) => scopes.has(key),
    dispose() {
      stopTags();
      stopFeed();
      stopEvictions();
    },
  };
}
