// session/human-gate/delegation.mjs
// Who a delegated session works for, recorded when it is created and re-bound
// only when another session sends it work (rebindDelegation): a sub-agent (any
// depth) and a task session a bot created carry `delegation` on their session
// record —
//   { rootSessionId, rootAgentId, via, run?, path }
// `rootSessionId` is the top-level conversation (a bot's home chat, a room
// member session, a coding Lead's session); `rootAgentId` the bot or Mixy it
// acts for ('' under a coding Lead); `via` how that root was acting when the
// work started: 'home' (the bot's own attended chat), 'room', 'run' (a
// schedule/webhook turn; `run` = { kind, name }) or 'coding'; `path` the steps
// from the root down ({ kind: 'task' } | { kind: 'agent', agent }).
// It is copied from the parent's record (or bound from the parent itself when
// the parent is top-level) by the host at creation — never from tool input —
// so no parent walk happens at gate time. It follows the session that drives
// the work: when a session sends an existing worker (or task session) a new
// request, the record is re-bound to what that sender is doing now, so work an
// unattended run started asks when the attended chat later reuses it, and the
// reverse. A background wake of the worker is no new request and keeps it. A
// record from before this field existed is
// backfilled once, from its parent by the same rules (backfillOf), and kept on
// the in-memory record, which its next save persists. A session that has a
// parent link but no valid or derivable root is UNRESOLVED: the gate fails
// closed on it. `via: 'unknown'` — a legacy task session that names its bot
// but not where it was created: acts as that bot, never remembers.
import { agentHomeSessionId, agentIdOfHomeSession } from '../agent-home.mjs';
import { roomMemberOfSession } from '../agent-room.mjs';
import { loadSession } from '../store/load-session.mjs';
import { _liveSessions } from '../store/live-state.mjs';
import { saveSessionAsync } from '../store/save-worker.mjs';
import { isTurnInFlight, runtimeState } from '../manager/runtime-state.mjs';
import { unattendedApprovalPort } from './unattended-port.mjs';

const VIA = new Set(['home', 'room', 'run', 'coding', 'unknown']);
const AGENT_ID = /^[A-Za-z0-9_-]+$/;
const MAX_PATH = 32;
const clean = (value) => (typeof value === 'string' ? value.trim() : '');
const isRecord = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value);

const agentOwned = (record) =>
  clean(record?.owner).toLowerCase() === 'agent' || clean(record?.visibility).toLowerCase() === 'agent-only';

/** The session that started `record` (its spawn parent, or the chat that
 *  created a task session), or '' for a top-level session. */
function parentOf(record) {
  if (agentOwned(record)) return clean(record.parentSessionId) || clean(record.ownerSessionId);
  return clean(record?.taskOrigin?.sessionId);
}

/** The step a new session adds to its parent's path. */
function stepOf(record) {
  return agentOwned(record) ? { kind: 'agent', agent: clean(record.agent) } : { kind: 'task' };
}

function validDelegation(value) {
  if (!isRecord(value) || !clean(value.rootSessionId) || !VIA.has(value.via)) return null;
  if (!Array.isArray(value.path) || value.path.length === 0 || value.path.length > MAX_PATH) return null;
  if (value.via === 'run' && !isRecord(value.run)) return null;
  return value;
}

/** A failed rebind leaves `{ unresolved: true }` instead of a delegation: an
 *  explicit "no root", so the legacy backfill cannot derive one again from a
 *  parent that still holds a run. */
const UNRESOLVED = Object.freeze({ unresolved: true });
const isUnresolvedMark = (value) => isRecord(value) && value.unresolved === true;

/** The recorded delegation of `record`, else its legacy backfill; null when
 *  it has none or was explicitly left unresolved. */
function delegationOfRecord(id, record, depth) {
  if (isUnresolvedMark(record.delegation)) return null;
  return validDelegation(record.delegation) || backfillOf(id, record, depth);
}

function loadRecord(sessionId) {
  try {
    return loadSession(sessionId);
  } catch {
    return null;
  }
}

/** How a top-level session `sessionId` is acting right now (no record needed
 *  for a home or room member id, which name their agent themselves). */
function bindingOf(sessionId, record, { legacy = false } = {}) {
  // A legacy record is classified from what was recorded, never from what the
  // parent is doing now (a run going or ended since says nothing about it).
  const run = legacy ? null : unattendedApprovalPort()?.runOf?.(sessionId);
  if (run && run.kind !== 'room') {
    return { rootAgentId: clean(run.agentId), via: 'run', run: { kind: run.kind, name: String(run.name || '') } };
  }
  const member = roomMemberOfSession(sessionId);
  if (member) return { rootAgentId: member.agentId, via: 'room' };
  const home = agentIdOfHomeSession(sessionId);
  if (home) return { rootAgentId: home, via: 'home' };
  if (!record || agentOwned(record)) return null;
  // A Lead with host-set bot provenance (session-options taskOriginSuffix) is
  // a bot's task session, never coding work: its root is that bot's chat.
  const source = sourceTaskOf(record);
  if (source === false) return null;
  if (source) {
    const task = { rootSessionId: agentHomeSessionId(source.bot), rootAgentId: source.bot, task: true };
    if (source.from === 'home') return { ...task, via: 'home' };
    if (source.from === 'run') return { ...task, via: 'run', run: { kind: 'schedule', name: '' } };
    if (source.from === undefined) return { ...task, via: 'unknown' };
    return null; // a room (which one is not recorded) or anything else: ambiguous
  }
  return { rootAgentId: '', via: 'coding' };
}

/** A Lead's host-set bot provenance `agent:<bot>[@from]`: `{ bot, from }`,
 *  null when it has none, false when it is malformed. */
function sourceTaskOf(record) {
  const source = clean(record?.sourceName);
  if (agentOwned(record) || clean(record?.sourceType) !== 'lead' || !source.startsWith('agent:')) return null;
  const [bot, from, ...rest] = source.slice(6).split('@');
  return AGENT_ID.test(bot) && !rest.length ? { bot, from } : false;
}

/** The root of a top-level `parent` for a child taking `step`. */
function rootFrom(parent, record, step, options) {
  const binding = bindingOf(parent, record, options);
  if (!binding) return null;
  const { task, ...root } = binding;
  return { rootSessionId: parent, ...root, path: task ? [{ kind: 'task' }, step] : [step] };
}

/** The delegation a legacy `record` (id `id`, a parent link, none recorded)
 *  is given, derived now from what was recorded — its own host-set `@run`
 *  provenance, else its parent's record, which must exist — and kept on the
 *  live record; null when it cannot be derived. Never `via: 'home'`: whether
 *  an old record was started by the attended chat (or by a run that has
 *  ended since) is not recorded, so home ancestry becomes 'unknown' — that
 *  bot, never remembered. Only a session created with its `delegation` can be
 *  'home'. */
function backfillOf(id, record, depth = 0) {
  const parent = parentOf(record);
  if (!parent || parent === id || depth >= MAX_PATH) return null;
  const own = sourceTaskOf(record);
  let delegation = null;
  if (own && own.from === 'run') {
    // A run's task session stays the run's, whatever its origin chat is doing now.
    delegation = {
      rootSessionId: agentHomeSessionId(own.bot),
      rootAgentId: own.bot,
      via: 'run',
      run: { kind: 'schedule', name: '' },
      path: [{ kind: 'task' }],
    };
  } else {
    const parentRecord = loadRecord(parent);
    if (!parentRecord) return null;
    const step = stepOf(record);
    if (parentOf(parentRecord)) {
      const inherited = delegationOfRecord(parent, parentRecord, depth + 1);
      if (!inherited || inherited.path.length >= MAX_PATH) return null;
      delegation = { ...inherited, path: [...inherited.path, step] };
    } else {
      delegation = rootFrom(parent, parentRecord, step, { legacy: true });
    }
    if (delegation?.via === 'home') delegation = { ...delegation, via: 'unknown' };
  }
  if (delegation && _liveSessions.get(id) === record) record.delegation = delegation;
  return delegation;
}

/**
 * The `delegation` to record on a session being created with `opts` (its
 * owner/visibility, parentSessionId/ownerSessionId, taskOrigin and agent), or
 * null: none for a top-level session, none for one whose parent's root cannot
 * be established (the record then stays unresolved and the gate fails closed).
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
 * Session `callerSessionId` sends the delegated session `sessionId` new work
 * (`agent send`, a spawn of its tag, a task-session send): from now on it
 * acts as that caller does — the delegation it would have been created with
 * under the caller — and the record is saved, so a restart keeps it. A worker
 * a run started is attended when the chat sends it work, and the other way
 * round; only the requests of the session that sends it count, never the
 * session that created it. A turn already running keeps its attended status
 * against a run (the run's request queues behind it and asks): it is never
 * loosened mid-turn. Resolves true when the record changed; false when
 * nothing applies (no record, not delegated, no or the same caller, the same
 * delegation) or the running turn kept its status. A caller whose root cannot
 * be established leaves the record without one, which the gate fails closed on.
 */
export async function rebindDelegation(sessionId, callerSessionId) {
  const id = clean(sessionId);
  const caller = clean(callerSessionId);
  const record = id ? loadRecord(id) : null;
  if (!record || record.closed === true || !caller || caller === id || !parentOf(record)) return false;
  const current = validDelegation(record.delegation);
  const next = delegationUnder(caller, stepOf(record));
  if (next ? JSON.stringify(current) === JSON.stringify(next) : isUnresolvedMark(record.delegation)) return false;
  if (next?.via === 'run' && current?.via !== 'run' && isTurnInFlight(runtimeState.get(id))) return false;
  record.delegation = next || { ...UNRESOLVED };
  await saveSessionAsync(record, { expectedGeneration: record.generation });
  return true;
}

/** `{ state: 'top' }` for a top-level session (or one with no record),
 *  `{ state: 'resolved', ...delegation }` for a delegated one, `{ state:
 *  'unresolved' }` for one with a parent link and no valid recorded root. */
export function delegationOf(sessionId) {
  const id = clean(sessionId);
  const record = id ? loadRecord(id) : null;
  if (!record) return { state: 'top' };
  const parent = parentOf(record);
  if (!parent) return { state: 'top' };
  const delegation = parent === id ? null : delegationOfRecord(id, record);
  return delegation ? { state: 'resolved', ...delegation } : { state: 'unresolved' };
}
