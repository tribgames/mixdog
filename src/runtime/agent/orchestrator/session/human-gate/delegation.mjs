// session/human-gate/delegation.mjs
// Who a delegated session works for, recorded when it is created and re-bound
// only when another session sends it work (rebindDelegation): a sub-agent (any
// depth) carries `delegation` on its session record —
//   { rootSessionId, via, path }
// `rootSessionId` is the top-level conversation the work started in; `via`
// says what it is: 'coding' (a coding Lead's session or a task session a bot
// created) or 'bot' (a bot's own home chat or room member session); either way
// the agents under it mirror their ordinary approval cards into that root, but
// a 'bot' root's sub-agents are no bot: they ask no bot approval and use no
// bot grant. `path` is the agent steps from the root down
// ({ kind: 'agent', agent }).
// A task session a bot created is an ordinary coding Lead session: top-level,
// never delegated from the bot, and its sub-agents are rooted at it.
// It is copied from the parent's record (or bound from the parent itself when
// the parent is top-level) by the host at creation — never from tool input —
// so no parent walk happens at gate time. When a session sends an existing
// worker a new request, the record is re-bound to that sender's root. A
// record from before this field existed, or one stored in an older shape (a
// task step in its path, a home/room/run/unknown `via`), is derived again from
// its parent by the same rules (backfillOf) and kept on the in-memory record,
// which its next save persists. A session that has a parent link but no valid
// or derivable root has no delegation (it is no bot's own session either).
// Work a schedule/webhook run started (a sub-agent, a task session) carries the
// `run` it was started under on its record, stamped at creation from its
// creator (never from creation options or tool input) and re-stamped, whether
// or not a root resolves, when another session sends it work (`run: null` =
// attended). A record from before the stamp keeps the run it recorded (an old
// `via: 'run'` delegation, an `agent:<bot>@run` task source, or its parent's
// run when it recorded no delegation): that is stamped before its delegation is
// derived again, which would drop it.
import { agentIdOfHomeSession } from '../agent-home.mjs';
import { roomMemberOfSession } from '../agent-room.mjs';
import { loadSession } from '../store/load-session.mjs';
import { _liveSessions } from '../store/live-state.mjs';
import { saveSessionAsync } from '../store/save-worker.mjs';
import { isTurnInFlight, runtimeState } from '../manager/runtime-state.mjs';
import { unattendedApprovalPort } from './unattended-port.mjs';

const VIA = new Set(['coding', 'bot']);
const MAX_PATH = 32;
const clean = (value) => (typeof value === 'string' ? value.trim() : '');
const isRecord = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value);

const agentOwned = (record) =>
  clean(record?.owner).toLowerCase() === 'agent' || clean(record?.visibility).toLowerCase() === 'agent-only';

/** The session that spawned `record`, or '' for a top-level session (a task
 *  session a bot created is top-level, like any coding Lead). */
function parentOf(record) {
  return agentOwned(record) ? clean(record.parentSessionId) || clean(record.ownerSessionId) : '';
}

/** The step a new session adds to its parent's path. */
const stepOf = (record) => ({ kind: 'agent', agent: clean(record.agent) });

/** A recorded delegation, or null when it is malformed or carries a step that
 *  is not an agent (a stored task step: derived again, never trusted). */
function validDelegation(value) {
  if (!isRecord(value) || !clean(value.rootSessionId) || !VIA.has(value.via)) return null;
  if (!Array.isArray(value.path) || value.path.length === 0 || value.path.length > MAX_PATH) return null;
  if (!value.path.every((step) => step?.kind === 'agent')) return null;
  return value;
}

/** The recorded delegation of `record`, else its legacy backfill; null when
 *  it has none and none can be derived. */
function delegationOfRecord(id, record, depth) {
  stampRun(id, record);
  return validDelegation(record.delegation) || backfillOf(id, record, depth);
}

const RUN_TASK_SOURCE = /^agent:([A-Za-z0-9_-]+)@run$/;
const runStamp = (kind, agentId, name) =>
  clean(agentId)
    ? { kind: kind === 'webhook' ? 'webhook' : 'schedule', agentId: clean(agentId), name: String(name || '') }
    : null;

/** The run a record from before the `run` stamp was started by, from what it
 *  recorded itself: an old `via: 'run'` delegation, a host-set `@run` task
 *  source, else — a sub-agent that recorded no delegation — its parent's run. */
function legacyRunOf(id, record, depth) {
  const old = record.delegation;
  if (isRecord(old) && old.via === 'run' && isRecord(old.run)) {
    return runStamp(old.run.kind, old.rootAgentId || agentIdOfHomeSession(old.rootSessionId), old.run.name);
  }
  const taskBot =
    !agentOwned(record) && clean(record.sourceType) === 'lead'
      ? RUN_TASK_SOURCE.exec(clean(record.sourceName))?.[1]
      : '';
  if (taskBot) return runStamp('schedule', taskBot, '');
  const parent = parentOf(record);
  if (!parent || parent === id || isRecord(old) || depth >= MAX_PATH) return null;
  const parentRecord = loadRecord(parent);
  return parentRecord ? stampRun(parent, parentRecord, depth + 1) : null;
}

/** The `run` of `record`: its stamp (`null` = attended), else the run it
 *  recorded before stamps existed, kept on the live record. */
function stampRun(id, record, depth = 0) {
  if (record.run !== undefined) return isRecord(record.run) ? record.run : null;
  const run = legacyRunOf(id, record, depth);
  if (run && _liveSessions.get(id) === record) record.run = run;
  return run;
}

/** The run stamped on session `sessionId` (human-gate/delegation.mjs), or null. */
export function runStampOf(sessionId) {
  const id = clean(sessionId);
  const record = id ? loadRecord(id) : null;
  return record ? stampRun(id, record) : null;
}

/** The schedule/webhook run `sessionId` is, or inherited from the session that
 *  started it, as `{ kind, agentId, name }`; null otherwise (a room member's
 *  own session is no run here). */
function runOfSession(sessionId) {
  const run = unattendedApprovalPort()?.runOf?.(sessionId);
  return run && run.kind !== 'room' ? { kind: run.kind, agentId: run.agentId, name: String(run.name || '') } : null;
}

/**
 * The `run` to stamp on a session being created with `opts`: the run its
 * creator (the spawning session, or the chat a task session was created from)
 * is or inherited, else null. Work a run started stays the run's, however long
 * ago the run ended; it is read from the creator, never from tool input.
 */
export function runForNewSession(opts = {}) {
  const creator = parentOf(opts) || clean(opts.taskOrigin?.sessionId);
  return creator && creator !== clean(opts.id) ? runOfSession(creator) : null;
}

function loadRecord(sessionId) {
  try {
    return loadSession(sessionId);
  } catch {
    return null;
  }
}

/** What a top-level session `sessionId` is to a child: a bot's own home chat
 *  or room member session ('bot', no record needed, the id names its agent),
 *  a record-bearing coding session ('coding'), else nothing. */
function viaOf(sessionId, record) {
  if (roomMemberOfSession(sessionId) || agentIdOfHomeSession(sessionId)) return 'bot';
  return record && !agentOwned(record) ? 'coding' : null;
}

/** The root of a top-level `parent` for a child taking `step`. */
function rootFrom(parent, record, step) {
  const via = viaOf(parent, record);
  return via ? { rootSessionId: parent, via, path: [step] } : null;
}

/** The delegation a legacy `record` (id `id`, a parent link, none valid
 *  recorded) is given, derived now from its parent, and kept on the live
 *  record; null when it cannot be derived. */
function backfillOf(id, record, depth = 0) {
  const parent = parentOf(record);
  if (!parent || parent === id || depth >= MAX_PATH) return null;
  const parentRecord = loadRecord(parent);
  const step = stepOf(record);
  let delegation = null;
  if (parentOf(parentRecord)) {
    const inherited = delegationOfRecord(parent, parentRecord, depth + 1);
    if (!inherited || inherited.path.length >= MAX_PATH) return null;
    delegation = { ...inherited, path: [...inherited.path, step] };
  } else {
    delegation = rootFrom(parent, parentRecord, step);
  }
  if (delegation && _liveSessions.get(id) === record) record.delegation = delegation;
  return delegation;
}

/**
 * The `delegation` to record on a session being created with `opts` (its
 * owner/visibility, parentSessionId/ownerSessionId and agent), or
 * null: none for a top-level session, none for one whose parent's root cannot
 * be established (it is no bot's session: nothing is asked or mirrored for it).
 */
export function delegationForNewSession(opts = {}) {
  const parent = parentOf(opts);
  if (!parent || parent === clean(opts.id)) return null;
  return delegationUnder(parent, stepOf(opts));
}

/** The delegation of a session taking `step` under the session `parent`. */
function delegationUnder(parent, step) {
  const record = loadRecord(parent);
  if (record && parentOf(record)) {
    // The parent is delegated itself: its recorded root, one step deeper.
    const inherited = delegationOfRecord(parent, record);
    if (!inherited || inherited.path.length >= MAX_PATH) return null;
    return { ...inherited, path: [...inherited.path, step] };
  }
  return rootFrom(parent, record, step);
}

/**
 * Session `callerSessionId` sends the sub-agent or task session `sessionId`
 * new work (`agent send`, a spawn of its tag, a task-session send): from now
 * on it is run-stamped as it would have been created under the caller, and a
 * sub-agent is rooted under the caller's root when one can be established; the
 * record is saved, so a restart keeps it — work an unattended run started is
 * attended when the chat later reuses it, and the reverse. The run is passed on
 * whether or not a root resolves. A turn already running is never made a run
 * mid-turn. Resolves true when the record changed; false when nothing applies
 * (no record, neither a sub-agent nor a task session, no or the same caller,
 * nothing different).
 */
export async function rebindDelegation(sessionId, callerSessionId) {
  const id = clean(sessionId);
  const caller = clean(callerSessionId);
  const record = id ? loadRecord(id) : null;
  if (!record || record.closed === true || !caller || caller === id) return false;
  const delegated = Boolean(parentOf(record));
  if (!delegated && !record.taskOrigin) return false;
  const next = delegated ? delegationUnder(caller, stepOf(record)) : null;
  const run = runOfSession(caller);
  const current = stampRun(id, record);
  const same = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
  const reroot = Boolean(next) && !same(validDelegation(record.delegation), next);
  if (!reroot && same(current, run)) return false;
  if (run && !current && isTurnInFlight(runtimeState.get(id))) return false;
  if (reroot) record.delegation = next;
  if (run || current) record.run = run; // null = attended: legacy provenance no longer applies
  await saveSessionAsync(record, { expectedGeneration: record.generation });
  return true;
}

/** `{ state: 'resolved', ...delegation }` for a sub-agent whose root is known,
 *  else `{ state: 'top' }`: a top-level session, one with no record, or one
 *  with a parent link and no derivable root (no bot's session either). */
export function delegationOf(sessionId) {
  const id = clean(sessionId);
  const record = id ? loadRecord(id) : null;
  const parent = record ? parentOf(record) : '';
  const delegation = parent && parent !== id ? delegationOfRecord(id, record) : null;
  return delegation ? { state: 'resolved', ...delegation } : { state: 'top' };
}
