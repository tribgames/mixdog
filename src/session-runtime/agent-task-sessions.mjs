/**
 * `session create`: an attended agent-mode conversation (an agent's home
 * thread) hands coding to a new, visible coding-mode task session — the
 * user's own Lead, created through the same session service and defaults as a
 * desktop New task — and gets each of its own turns' results back.
 *
 * Only turns the origin agent starts (the brief, a later `send` from it)
 * report: when such a turn ends its result is queued durably for the agent's
 * home (agent-home-delivery.mjs), which posts it and wakes the agent once to
 * relay it. A turn blocked on the user's answer or approval posts one faint
 * line instead; the card stays in the task session for the user.
 *
 * An agent's send to any other session reports the same way, by an origin for
 * that send only (reportOrigin). Every reporting turn is also watched durably
 * (agent-home-delivery.mjs `watches`) until its end is queued, so a daemon
 * restart before that re-attaches it (recover): an ended turn reports once
 * from the target's record, a queued or running one is watched to its end.
 *
 * A group-room member (its member session `sess_rmem_<room>_<agent>`) opens
 * and drives task sessions the same way; its reports carry `from` (the member
 * session), so they land in that member session alone, never in its home or
 * the room's log, and an ended turn gives the member a turn in its room to
 * relay it (agent-home-delivery.mjs enqueueTask).
 *
 * A send to a group room's log goes to one member through the desktop room
 * host (daemon-session-control.mjs): the member's turn in its member session
 * is the reporting turn, taken by the room (`submit`), not by a prompt.
 */
import { randomUUID } from 'node:crypto';
import { realpathSync, statSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import { clean } from '../runtime/agent/orchestrator/runtime-core/session-text.mjs';
import { collectTurnArtifacts, handoffContent, sessionRoots, turnSlice } from './handoff-attachments.mjs';
import { roomMemberOfSession } from '../runtime/agent/orchestrator/session/agent-room.mjs';
import { wrapAgentMessage } from '../runtime/shared/agent-message-envelope.mjs';
import { sessionsWithPendingWork } from '../runtime/shared/pending-agent-work.mjs';
import { agentTaskIdOfExecution } from './services/agent-tool/restart-notify.mjs';

const TITLE_LIMIT = 60;

/** `{ cwd, desktopSession, project }` of `project`: a registered Project name
 *  (or alias) or an existing directory; none starts a task without a Project
 *  in the caller's folder, as a desktop New task does in its task workspace. */
export function resolveTaskProject(project, { projects = [], cwd = process.cwd() } = {}) {
  const requested = clean(project);
  if (!requested) return { cwd, desktopSession: { classification: 'task', projectPath: null }, project: null };
  const key = requested.toLowerCase();
  const named = projects.filter((entry) => [entry.name, entry.alias].some((name) => clean(name).toLowerCase() === key));
  if (named.length > 1)
    throw new Error(`session: Project "${requested}" is ambiguous; ask the user which one is meant`);
  let path = named[0]?.path || '';
  if (!path) {
    const candidate = resolve(cwd, requested);
    let directory = false;
    try {
      directory = statSync(candidate).isDirectory();
    } catch {}
    if (!directory) {
      throw new Error(
        `session: "${requested}" is neither a registered Project nor an existing directory; run list-projects`
      );
    }
    path = realpathSync(candidate);
  }
  return {
    cwd: path,
    desktopSession: { classification: 'project', projectPath: path },
    project: { name: named[0]?.name || basename(path), path },
  };
}

const turnStatus = (detail) =>
  ({ done: 'completed', completed: 'completed', failed: 'failed' })[detail?.status] || 'cancelled';

const INTERRUPTED = /^\[Request interrupted/;

const messageText = (content) =>
  typeof content === 'string'
    ? content
    : (Array.isArray(content) ? content : [])
        .map((part) => (typeof part === 'string' ? part : part?.type === 'text' ? part.text || '' : ''))
        .join('');

/** The submissions a stored user message delivered: a turn's prompt
 *  (`checkpointId`, `submissionIds` of a merged batch) or a steered message. */
export function submissionIdsOf(message) {
  if (message?.role !== 'user') return [];
  const meta = message.meta || {};
  const transcript = meta.transcript || {};
  return [
    transcript.checkpointId,
    ...(Array.isArray(transcript.submissionIds) ? transcript.submissionIds : []),
    ...(Array.isArray(meta.submissionIds) ? meta.submissionIds : []),
  ];
}

/** The end of the turn that took submission `runId`, from a session's stored
 *  `messages`: `{ status, text }` once that turn recorded its end (its
 *  completion, an interruption marker, or the next turn's prompt), 'open'
 *  while it has none, null when no turn took it. */
export function submissionOutcome(messages, runId) {
  const list = Array.isArray(messages) ? messages : [];
  const start = list.findIndex((message) => submissionIdsOf(message).includes(runId));
  if (start < 0) return null;
  for (let index = start; index < list.length; index += 1) {
    const message = list[index];
    const completion = message?.meta?.transcript?.completion;
    if (completion) {
      const status = turnStatus(completion);
      const text = status === 'failed' ? completion.detail || '' : message.role === 'assistant' ? message.content : '';
      return { status, text: messageText(text) };
    }
    if (index === start || message?.role !== 'user') continue;
    if (INTERRUPTED.test(messageText(message.content)) || message.meta?.transcript?.checkpointId) {
      return { status: 'cancelled', text: '' };
    }
  }
  return 'open';
}

// `agent` tool calls that can start a job (a spawn, or a send that begins one).
const STARTING_AGENT_CALLS = new Set(['spawn', 'send']);

const callArguments = (call) => {
  const raw = call?.arguments ?? call?.function?.arguments;
  if (raw && typeof raw === 'object') return raw;
  try {
    return JSON.parse(String(raw || '{}')) || {};
  } catch {
    return {};
  }
};

/** The agent task ids a woken turn's prompt delivered, from its stored
 *  provenance: the batch's `consumedExecutionIds` (session-flow/drain.mjs)
 *  or the single `execution` of a queue-fed turn; null for an id that names
 *  no task. Empty when the turn recorded none. */
function consumedTaskIds(message) {
  const recorded = message?.meta?.transcript?.consumedExecutionIds;
  const ids = Array.isArray(recorded) ? recorded : message?.meta?.execution?.id ? [message.meta.execution.id] : [];
  return ids.map((id) => (id ? agentTaskIdOfExecution(id) : null));
}

/** The latest turn of the chain that submission `runId` started in a
 *  session's stored `messages`, from structured provenance only: runId's own
 *  turn, then each turn that took a result of an agent task the chain started
 *  — as its prompt (a woken turn) or steered into it while it ran, even a turn
 *  the user started (its `agent` spawn/send results record
 *  `agentTaskIds`, tool-batch/finalize.mjs; the tasks those turns start join
 *  the chain). A turn the user typed, or one woken only by other agents,
 *  never joins it. `ambiguous` is set when provenance a chain decision needs
 *  is missing — a starting agent call of the chain without `agentTaskIds`,
 *  or a woken turn naming no task — so its answer may not be the final one.
 *  `{ id, outcome, at, ambiguous }`: that turn's submission id, its
 *  submissionOutcome and when its end was recorded (0 when unknown); null
 *  when no turn took runId. */
export function latestTurnOutcome(messages, runId) {
  const list = Array.isArray(messages) ? messages : [];
  const start = list.findIndex((message) => submissionIdsOf(message).includes(runId));
  if (start < 0) return null;
  const started = new Set();
  const startingCalls = new Set();
  let at = start;
  let id = runId;
  let inChain = true;
  let ambiguous = false;
  // The turn the walk is in: where its prompt is stored and its submission id.
  let turnAt = start;
  let turnId = runId;
  for (let index = start; index < list.length; index += 1) {
    const message = list[index];
    const checkpointId = index > start && message?.role === 'user' ? message.meta?.transcript?.checkpointId : '';
    if (checkpointId) {
      turnAt = index;
      turnId = checkpointId;
      inChain = false;
    }
    // A completion delivered as a turn's prompt (queue/bus wake), or steered
    // into a turn already running (loop/steering.mjs, no checkpoint of its
    // own): the turn that took the chain's result joins the chain, even one
    // the user started, so its answer becomes the candidate.
    const delivered =
      index > start && message?.role === 'user' && message.meta?.source === 'task-notification'
        ? consumedTaskIds(message)
        : null;
    if (delivered && !inChain) {
      if (delivered.some((taskId) => taskId && started.has(taskId))) {
        inChain = true;
        at = turnAt;
        id = turnId;
      } else if (!delivered.length || delivered.includes(null)) {
        ambiguous = true;
      }
    }
    if (checkpointId || delivered) continue;
    if (!inChain) continue;
    if (message?.role === 'assistant') {
      for (const call of Array.isArray(message.toolCalls) ? message.toolCalls : []) {
        const name = String(call?.name ?? call?.function?.name ?? '');
        const type = String(callArguments(call).type || 'spawn').trim();
        if (name === 'agent' && STARTING_AGENT_CALLS.has(type) && call?.id) startingCalls.add(call.id);
      }
      continue;
    }
    if (message?.role !== 'tool' || !startingCalls.has(message.toolCallId)) continue;
    if (Array.isArray(message.agentTaskIds)) for (const taskId of message.agentTaskIds) started.add(String(taskId));
    else if (message.toolKind !== 'error') ambiguous = true;
  }
  const turn = list.slice(at);
  const ended = turn.find((message) => message?.meta?.transcript?.completion);
  return { id, outcome: submissionOutcome(turn, id), at: Number(ended?.meta?.transcript?.at) || 0, ambiguous };
}

/** Whether task session `sessionId` still waits on agent work it handed off,
 *  from `agentWorking` (Lead ids with an Agent session in flight), `owed`
 *  (agent results queued for it that no turn has taken yet), `pool` (agent
 *  pool rows: the desktop notifier's rule, pending-agent-work.mjs) and
 *  `agentTaskOwners` (the sessions owning a queued, spawning or running agent
 *  task — one still waiting for admission has no turn in flight, and its pool
 *  row reads `unknown`). An agent task owned by an Agent session under it, at
 *  any depth, counts too: every descendant's pool row names the Lead as owner. */
export function pendingWorkOf(
  sessionId,
  { agentWorking = new Set(), owed = [], pool = [], agentTaskOwners = new Set() }
) {
  if (agentWorking.has(sessionId) || owed.length > 0 || agentTaskOwners.has(sessionId)) return true;
  if (sessionsWithPendingWork(pool).has(sessionId)) return true;
  return pool.some((row) => row?.ownerSessionId === sessionId && agentTaskOwners.has(String(row.sessionId || '')));
}

/** The agent results queued for `sessionId` that no turn has taken yet (its
 *  durable pending queue: an agent's completion, a restart failure): `{ text,
 *  meta }` as the notification bus delivers them. */
export async function owedAgentResults(sessionId) {
  const [{ _getPendingMessagesForSession }, { completionIsDelivered, isCompletionNotificationEntry }] =
    await Promise.all([
      import('../runtime/agent/orchestrator/session/manager/pending-messages.mjs'),
      import('../runtime/agent/orchestrator/session/manager/pending-message-entry.mjs'),
    ]);
  return _getPendingMessagesForSession(sessionId)
    .filter((entry) => isCompletionNotificationEntry(entry) && !completionIsDelivered(entry))
    .map((entry) => ({
      text: String(entry.text || entry.content || ''),
      meta: {
        type: 'agent_task_result',
        execution_surface: entry.execution?.surface || 'agent',
        execution_id: entry.executionId || entry.execution?.id || null,
        status: entry.execution?.status || null,
        caller_session_id: sessionId,
      },
    }));
}

/** pendingWorkOf over this process's state: the in-flight runtimes, the
 *  durable pending queue, the agent pool and the background agent tasks. */
export async function taskSessionPendingWork(sessionId, { owedResults = owedAgentResults } = {}) {
  const [{ inFlightSessionActivity }, { listStoredAgentWorkersAsync }, { activeBackgroundTaskSessionIds }] =
    await Promise.all([
      import('../runtime/agent/orchestrator/session/manager/runtime-state.mjs'),
      import('../runtime/agent/orchestrator/session/store-summary-reader.mjs'),
      import('../runtime/shared/background-tasks.mjs'),
    ]);
  const { working, agentWorking } = inFlightSessionActivity();
  const agentTaskOwners = activeBackgroundTaskSessionIds({ surface: 'agent' });
  if (pendingWorkOf(sessionId, { agentWorking, agentTaskOwners })) return true;
  if ((await owedResults(sessionId)).length) return true;
  const pool = await listStoredAgentWorkersAsync({ runningSessionIds: working });
  return pendingWorkOf(sessionId, { pool, agentTaskOwners });
}

// A task session idle with nothing pending must stay so this long before its
// latest answer is final: a finished agent's result can start the Lead's next
// turn right after (the desktop notifier's quiet period).
const FINAL_SETTLE_MS = 2500;
// While a report waits on pending work it re-checks this often (state changes
// of the session re-check at once).
const FINAL_POLL_MS = 15_000;

const REPORT_RETRY_DELAYS_MS = [200, 1000, 5000];

const LOST_TEXT = 'The message never ran: the app restarted before its turn started.';
const GONE_TEXT = 'The session no longer exists.';
const RESUME_FAILED_TEXT =
  'The agent task session could not continue after the app restarted: its agents’ results never reached it. Check that session.';
const PENDING_CAP_MS = 30 * 60_000;
const STILL_WORKING_TEXT =
  'Still in progress: its agents are still working 30+ minutes after this answer. This is the latest answer; the final one is reported when they finish.';
// Deliveries of a restarted task session's queued agent results before its
// report gives up as RESUME_FAILED_TEXT.
const OWED_WAKE_TRIES = 3;

// Why a send or create reports nothing back (its `reportsBackReason`).
const NOTIFY_OFF_REASON = 'this agent task session was created with notify: false, so its turns do not report back';
const WATCH_CAP_REASON =
  'this chat already waits on as many unreported session results as it can track; earlier ones must report first';

// The last-used model search stops after this many catalog pages.
const LAST_USED_ROUTE_MAX_PAGES = 20;

/** A report's `from` when its origin is a group-room member session: the
 *  report goes to that member session instead of the agent's home. */
const roomFrom = (originSessionId) => (roomMemberOfSession(originSessionId) ? { from: originSessionId } : {});

/** The route of `modelRef`: a provider/model[@effort…] ref (a superseded
 *  model runs on its successor) or a preset name. */
async function configModelRoute(modelRef) {
  const [{ modelRouteFields, parseScheduleModelRef }, { migrateCodexRoute }, { loadConfig }] = await Promise.all([
    import('../runtime/shared/schedule-model-ref.mjs'),
    import('../runtime/agent/orchestrator/providers/openai-oauth-catalog-store.mjs'),
    import('../runtime/agent/orchestrator/config.mjs'),
  ]);
  const ref = parseScheduleModelRef(modelRef);
  if (ref && typeof ref === 'object') return modelRouteFields(migrateCodexRoute(ref));
  const preset = loadConfig({ secrets: false }).presets?.find((p) => p.id === ref || p.name === ref);
  if (!preset) throw new Error(`model "${ref}" is neither a provider/model route nor a known preset name`);
  return modelRouteFields(preset);
}

/** The Lead (Main) route of the config — what a desktop New task starts on.
 *  Null while none is chosen. */
async function configLeadRoute() {
  const [{ modelRouteFields }, { resolveRoute }, { loadConfig }] = await Promise.all([
    import('../runtime/shared/schedule-model-ref.mjs'),
    import('./boot/shared.mjs'),
    import('../runtime/agent/orchestrator/config.mjs'),
  ]);
  const route = resolveRoute(loadConfig({ secrets: false }), {});
  return clean(route?.provider) && clean(route?.model) ? modelRouteFields(route) : null;
}

/** The model the user last used in a coding session (the runtime's stand-in
 *  for the desktop's last New-task model): the first row that has one in the
 *  catalog, which lists newest activity first. Pages on (bounded) until a
 *  row qualifies; null when none does. */
async function lastUsedSessionRoute(sessionService) {
  let cursor = null;
  for (let page = 0; page < LAST_USED_ROUTE_MAX_PAGES; page += 1) {
    const listed = await sessionService.listSessionCatalog({ page: { limit: 50, cursor } });
    const used = (Array.isArray(listed?.sessions) ? listed.sessions : []).find(
      (row) => row?.sessionMode !== 'agent' && clean(row?.provider) && clean(row?.model)
    );
    if (used) return { provider: clean(used.provider), model: clean(used.model) };
    cursor = listed?.nextCursor || null;
    if (!cursor) return null;
  }
  return null;
}

/** Wait for the final answer of the task turn `runId` of `sessionId` ended
 *  completed: the end of the latest turn since it (a Lead that handed work
 *  to agents ends its turn and answers in the turn their results wake),
 *  once the session is idle with no pending agent work (pendingWork) for
 *  `settleMs`. `immediate` is runId's own end, when this process saw it.
 *  `finish(status, text)` runs once; `check` re-evaluates (call it on every
 *  state change of `runtime`), `stop` ends the wait. */
function followTaskToFinal(
  { loadSession, owedResults, deliverCompletion, pendingWork, settleMs, pollMs, pendingCapMs, log },
  { sessionId, runId, runtime, immediate = null, wakeOwed = false, finish, progress = null }
) {
  let progressed = false;
  let pendingSince = 0;
  // Agent work still pending `pendingCapMs` after the chain's latest turn
  // ended: `progress(text)` reports that answer once, marked still in
  // progress, and the wait for the final one goes on.
  async function reportProgress() {
    if (progressed || typeof progress !== 'function') return;
    const latest = latestTurnOutcome((await loadSession(sessionId))?.messages, runId);
    let end = latest?.outcome && latest.outcome !== 'open' ? latest.outcome : null;
    if (immediate && (!latest || latest.id === runId)) end = immediate;
    if (!end) return;
    pendingSince ||= Date.now();
    if (Date.now() - (latest?.at || pendingSince) < pendingCapMs) return;
    progressed = true;
    await progress(`${STILL_WORKING_TEXT}\n\n${end.text}`);
  }
  let done = false;
  let checking = false;
  let again = false;
  let candidate = '';
  let candidateAt = 0;
  let timer = null;
  let wakes = 0;
  let wokeAt = 0;
  const unwoken = (why) => {
    log(`${sessionId} could not take its agents' results after the restart: ${why}`);
    return { key: 'unwoken', status: 'failed', text: RESUME_FAILED_TEXT, now: true };
  };
  // `wakeOwed` (a restarted watch): deliver the agent results queued for
  // the idle session through the notification bus so a turn takes them, at
  // most OWED_WAKE_TRIES times, a poll apart; null while that turn is owed.
  async function wakeForOwed() {
    const owed = await owedResults(sessionId);
    if (!owed.length) return undefined;
    if (Date.now() - wokeAt < pollMs) return null;
    if (wakes >= OWED_WAKE_TRIES) return unwoken(`still not taken after ${wakes} deliveries`);
    wakes += 1;
    wokeAt = Date.now();
    let delivered = false;
    try {
      if (typeof deliverCompletion === 'function') {
        const results = await Promise.all(owed.map(({ text, meta }) => deliverCompletion(sessionId, text, meta)));
        delivered = results.some((result) => result === true);
      }
    } catch (error) {
      return unwoken(error?.message || error);
    }
    return delivered ? null : unwoken('no session runtime took the delivery');
  }
  const arm = (ms) => {
    clearTimeout(timer);
    timer = setTimeout(() => void check().catch(failed), ms);
    timer.unref?.();
  };
  const stop = () => {
    done = true;
    clearTimeout(timer);
  };
  const failed = (error) => log(`following ${sessionId} to its final answer failed: ${error?.message || error}`);
  // The end to report now, or null while the task still works.
  async function ready() {
    if (runtime?.getState?.()?.busy) return null;
    if (wakeOwed) {
      const woke = await wakeForOwed();
      if (woke !== undefined) return woke;
    }
    if (await pendingWork(sessionId)) {
      await reportProgress();
      return null;
    }
    const stored = await loadSession(sessionId);
    if (!stored && !immediate) return { key: 'gone', status: 'cancelled', text: GONE_TEXT };
    const latest = latestTurnOutcome(stored?.messages, runId);
    // Provenance the chain needs is missing: its answer may not be final.
    if (latest?.ambiguous) {
      await reportProgress();
      return null;
    }
    if (immediate && (!latest || latest.id === runId)) return { key: runId, ...immediate };
    if (!latest?.outcome || latest.outcome === 'open') return null;
    return { key: `${latest.id}:${latest.outcome.status}`, ...latest.outcome };
  }
  async function check() {
    if (done) return;
    if (checking) {
      again = true;
      return;
    }
    checking = true;
    try {
      do {
        again = false;
        const end = await ready();
        if (done) return;
        if (!end) {
          candidate = '';
          arm(pollMs);
        } else if (!end.now && settleMs > 0 && (end.key !== candidate || Date.now() - candidateAt < settleMs)) {
          // Final only if it is still the answer after the quiet period.
          if (end.key !== candidate) {
            candidate = end.key;
            candidateAt = Date.now();
          }
          arm(candidateAt + settleMs - Date.now());
        } else {
          stop();
          await finish(end.status, end.text);
        }
      } while (again && !done);
    } finally {
      checking = false;
    }
  }
  return { check: () => check().catch(failed), stop };
}

/** Store the durable watch of turn `id` before it can start, so no end goes
 *  unreported across a restart; a turn whose watch could not be stored runs
 *  without a report (reportsBack false) rather than claim one. `noReport`:
 *  why the turn will not report back, told to the bot (reportsBackReason). */
async function watchTurn({ watches, owner, log }, sessionId, origin, id) {
  if (origin.notify === false) return { notify: false, noReport: NOTIFY_OFF_REASON };
  try {
    await watches.add({
      runId: id,
      agentId: origin.agentId,
      homeSessionId: origin.sessionId,
      taskSessionId: sessionId,
      title: origin.title,
      ...(origin.target === 'session' ? { target: 'session' } : {}),
      ...(origin.textOnly ? { textOnly: true } : {}),
      ...(origin.hop > 0 ? { hop: origin.hop } : {}),
      owner,
      at: Date.now(),
    });
    return { notify: true, noReport: '' };
  } catch (error) {
    log(`watch of ${sessionId} failed, sending without a report: ${error?.message || error}`);
    return {
      notify: false,
      noReport:
        error?.code === 'REPORT_WATCH_CAP'
          ? WATCH_CAP_REASON
          : `its report could not be recorded (${error?.message || error}); check that session for the result`,
    };
  }
}

/** Deliver report `payload` of task session `sessionId` to agent `agentId`,
 *  retrying after each of `retryDelaysMs`; the last failure throws. */
async function deliverWithRetries({ deliver, retryDelaysMs, log }, agentId, sessionId, payload) {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await deliver(agentId, payload);
    } catch (error) {
      if (attempt >= retryDelaysMs.length) throw error;
      log(`report of ${sessionId} failed (try ${attempt + 1}), retrying: ${error?.message || error}`);
      await new Promise((resolveWait) => setTimeout(resolveWait, retryDelaysMs[attempt]));
    }
  }
}

/** Start task session `sessionId` in its own worktree; a repo that cannot
 *  have one keeps the Project folder. */
async function requestTaskWorktree(sessions, sessionId, title, requestId) {
  try {
    await sessions.configureSession(
      {
        sessionId,
        action: 'requestWorktree',
        args: [{ provision: true, carryChanges: 'leave', prompt: title, txId: requestId }],
      },
      { revision: 1 }
    );
  } catch (error) {
    if (error?.code !== 'WORKTREE_UNSUPPORTED_REPO') throw error;
  }
}

/** The origin a `send` of agent `agentId` (from its home or room member
 *  session `callerSessionId`) reports to: the stored one of a task session
 *  it created, else one for this send only — never stored on the target,
 *  whose own origin and owner stay as they are. Either reports to the
 *  conversation the send came from. Null for a caller that is no agent
 *  conversation. */
async function sendReportOrigin({ loadSession, agentName }, sessionId, agentId, callerSessionId) {
  if (!agentId) return null;
  const target = await loadSession(sessionId);
  const origin = target?.taskOrigin;
  if (origin?.agentId === agentId) {
    return callerSessionId && callerSessionId !== origin.sessionId ? { ...origin, sessionId: callerSessionId } : origin;
  }
  const title = (clean(target?.title) || sessionId).slice(0, TITLE_LIMIT);
  // Files come back only from sessions the agent created (above) or its own
  // room member threads; any other session reports its text alone.
  const own = roomMemberOfSession(sessionId)?.agentId === agentId;
  return {
    agentId,
    sessionId: callerSessionId,
    title,
    notify: true,
    target: 'session',
    ...(own ? {} : { textOnly: true, envelopeName: await agentName(agentId) }),
  };
}

/** Re-attach one watch a stopped daemon left: report the turn's end once
 *  from the target's record, or watch it until it ends. */
async function rearmTaskWatch(
  { deliver, loadSession, materializeSession, queuedSubmissionIds, artifactFields, followToFinal, log },
  watch
) {
  const sessionId = watch.taskSessionId;
  // The turn that answers: the watched submission's own, or the one it
  // follows (a room member's turn under another submission id).
  const turnId = watch.follows || watch.runId;
  const finish = async (status, text = '') =>
    deliver(watch.agentId, {
      runId: `${watch.runId}_end`,
      taskSessionId: sessionId,
      title: watch.title,
      status,
      text,
      ...(watch.target === 'session' ? { target: 'session' } : {}),
      ...(watch.hop > 0 ? { hop: watch.hop } : {}),
      ...roomFrom(watch.homeSessionId),
      watchId: watch.runId,
      ...(watch.textOnly || text === GONE_TEXT || text === LOST_TEXT
        ? {}
        : await artifactFields(sessionId, turnId)),
    });
  if (!(await loadSession(sessionId))) return finish('cancelled', GONE_TEXT);
  let runtime;
  try {
    runtime = await materializeSession(sessionId);
  } catch (error) {
    // It can never take its agents' results: say so once instead of waiting.
    log(`${sessionId} could not be loaded after the restart: ${error?.message || error}`);
    return finish('failed', RESUME_FAILED_TEXT);
  }
  let done = false;
  let checking = false;
  let again = false;
  let unsubscribe = () => {};
  // Set once the watched turn is found ended completed: the report then
  // waits for the task's final answer, as in the process that sent it.
  let follow = null;
  const check = async () => {
    if (done) return;
    if (follow) return follow.check();
    if (checking) {
      again = true;
      return;
    }
    checking = true;
    try {
      do {
        again = false;
        const outcome = submissionOutcome((await loadSession(sessionId))?.messages, turnId);
        const state = runtime?.getState?.() || {};
        let end = outcome && outcome !== 'open' ? outcome : null;
        if (!end && !state.busy) {
          const queued = (state.queued || []).some((entry) => entry?.id === turnId);
          if (outcome === 'open' && !queued) end = { status: 'cancelled', text: '' };
          else if (!outcome && !queued && !(await queuedSubmissionIds(sessionId)).includes(turnId)) {
            end = { status: 'cancelled', text: LOST_TEXT };
          }
        }
        if (end?.status === 'completed') {
          follow = followToFinal({
            sessionId,
            runId: turnId,
            runtime,
            wakeOwed: true,
            progress: (text) =>
              deliver(watch.agentId, {
                runId: `${watch.runId}_progress`,
                taskSessionId: sessionId,
                title: watch.title,
                status: 'working',
                text,
                ...(watch.target === 'session' ? { target: 'session' } : {}),
                ...(watch.hop > 0 ? { hop: watch.hop } : {}),
                ...roomFrom(watch.homeSessionId),
              }),
            finish: async (status, text) => {
              done = true;
              unsubscribe();
              await finish(status, text);
            },
          });
        } else if (end) {
          done = true;
          unsubscribe();
          await finish(end.status, end.text);
        }
      } while (again && !done && !follow);
    } finally {
      checking = false;
    }
    if (follow) await follow.check();
  };
  const failed = (error) => log(`re-attaching ${sessionId} failed: ${error?.message || error}`);
  unsubscribe = runtime?.subscribe?.(() => void check().catch(failed)) || unsubscribe;
  await check();
}

export function createAgentTaskSessions({
  getSessionService,
  deliver = async (agentId, report) => (await import('./agent-home-delivery.mjs')).deliverAgentTask(agentId, report),
  // The durable watch of each reporting turn until its end is queued.
  watches = {
    add: async (watch) => (await import('./agent-home-delivery.mjs')).watchAgentTask(watch),
    list: async () => (await import('./agent-home-delivery.mjs')).agentTaskWatches(),
    remove: async (runId) => (await import('./agent-home-delivery.mjs')).unwatchAgentTask(runId),
    follow: async (runId, submissionId) =>
      (await import('./agent-home-delivery.mjs')).followAgentTask(runId, submissionId),
  },
  // Submissions still queued (durably) for a session after a restart.
  queuedSubmissionIds = async (sessionId) =>
    (await (await import('../tui/session/tui-steering-persist.mjs')).readTuiSteeringPersist(sessionId))
      .map((row) => row?.submissionId)
      .filter(Boolean),
  loadSession = async (sessionId) =>
    (await import('../runtime/agent/orchestrator/session/store.mjs')).loadSession(sessionId),
  listProjects = async () => (await import('../runtime/shared/projects.mjs')).listProjects(),
  newTaskDefault = async () =>
    (await import('../runtime/agent/orchestrator/config.mjs')).loadConfig({ secrets: false }).worktree?.newTaskDefault,
  modelRoute = configModelRoute,
  // The Lead (Main) route of the config — what a desktop New task starts on.
  leadRoute = configLeadRoute,
  // The model the user last used in a coding session.
  lastUsedRoute = lastUsedSessionRoute,
  // The files turn `runId` of `sessionId` produced (handoff-attachments.mjs),
  // read from its live runtime when one is given, else its stored record.
  turnArtifacts = async (sessionId, runId, runtime = null) => {
    const stored = await loadSession(sessionId);
    const live = typeof runtime?.readModelMessages === 'function' ? await runtime.readModelMessages(0) : null;
    const messages = turnSlice(Array.isArray(live?.messages) ? live.messages : stored?.messages, { runId });
    return collectTurnArtifacts(messages, { cwd: stored?.cwd, roots: sessionRoots(stored) });
  },
  // The name a bot goes by in the envelope of its messages to other sessions.
  agentName = async (agentId) =>
    (await import('../runtime/agent/orchestrator/context/role-instructions.mjs')).agentDisplayName(agentId),
  // Waits before each in-process retry of a report that could not be queued.
  retryDelaysMs = REPORT_RETRY_DELAYS_MS,
  // Whether a task session still waits on agent work it handed off; its
  // turn's end then is not the final answer yet.
  pendingWork = taskSessionPendingWork,
  settleMs = FINAL_SETTLE_MS,
  pollMs = FINAL_POLL_MS,
  // After a restart: the agent results queued for a task session, and the
  // notification-bus delivery (the session runtime host's
  // notifySessionCompletion) that makes it take them in a turn — the restart
  // left nothing to wake it. `settleAgentResults` first turns the agents the
  // restart killed into queued failure results (agent-tool restart-notify).
  owedResults = owedAgentResults,
  deliverCompletion = null,
  settleAgentResults = async () => {},
  // Pending agent work this long after the latest answer reports that answer
  // as still in progress (once); the final report still follows.
  pendingCapMs = PENDING_CAP_MS,
  log = (line) => process.stderr.write(`mixdog task sessions: ${line}\n`),
}) {
  /** The report fields of turn `runId`'s files; none when it produced none. */
  const artifactFields = async (sessionId, runId, runtime = null) => {
    try {
      const { files, omitted } = await turnArtifacts(sessionId, runId, runtime);
      return files.length ? { files, ...(omitted ? { omitted } : {}) } : {};
    } catch (error) {
      log(`collecting the files of ${sessionId} failed: ${error?.message || error}`);
      return {};
    }
  };
  // Marks this process's watches: recovery re-attaches only an earlier one's.
  const processToken = randomUUID();
  const service = () => {
    const value = getSessionService();
    if (!value) throw new Error('session: session service is unavailable');
    return value;
  };

  const followToFinal = (follow) =>
    followTaskToFinal(
      { loadSession, owedResults, deliverCompletion, pendingWork, settleMs, pollMs, pendingCapMs, log },
      follow
    );

  /** Submit `prompt` as the origin agent's turn; its end (and a wait for the
   *  user in it) reports to the agent's home. Resolves on intake. `submit`
   *  takes the turn in another way than a prompt to `sessionId` (a message
   *  into a group room, whose member answers in `sessionId`): given `{ id,
   *  onSettled }`, it resolves `{ accepted }`. */
  async function agentTurn(sessionId, prompt, origin, id = `atask_${randomUUID()}`, beforeReport = null, submit = null) {
    const sessions = service();
    const target = origin.target === 'session' ? { target: 'session' } : {};
    const { notify, noReport } = await watchTurn({ watches, owner: processToken, log }, sessionId, origin, id);
    const dropWatch = () =>
      watches.remove(id).catch((error) => log(`dropping the watch of ${sessionId} failed: ${error?.message || error}`));
    let runtime = null;
    // A report that cannot be queued is retried in this process; when every try
    // fails the durable watch stays and restart recovery delivers it (the queue
    // dedupes by runId, so a retry never posts twice).
    const report = (status, text = '') =>
      Promise.resolve(beforeReport)
        .then(async () =>
          deliverWithRetries({ deliver, retryDelaysMs, log }, origin.agentId, sessionId, {
            // 'working': a still-in-progress answer (followToFinal), not the end.
            runId: `${id}_${{ blocked: 'blocked', working: 'progress' }[status] || 'end'}`,
            taskSessionId: sessionId,
            title: origin.title,
            status,
            text,
            ...target,
            ...(origin.hop > 0 ? { hop: origin.hop } : {}),
            ...roomFrom(origin.sessionId),
            // A turn's end brings back the files it produced, when the agent
            // may receive them (reportOrigin `textOnly`).
            ...(status === 'blocked' || status === 'working'
              ? {}
              : { watchId: id, ...(origin.textOnly ? {} : await artifactFields(sessionId, id, runtime)) }),
          })
        )
        .catch((error) => log(`report of ${sessionId} failed: ${error?.message || error}`));
    let unwatch = () => {};
    // Set once the turn ended completed: the report waits for the final answer.
    let follow = null;
    let result;
    try {
      if (notify) {
        runtime = await sessions.materializeSession(sessionId);
        let blocked = false;
        unwatch =
          runtime?.subscribe?.(() => {
            follow?.check();
            if (blocked || !runtime.getState?.()?.toolApproval) return;
            blocked = true;
            void report('blocked');
          }) || unwatch;
      }
      // A bot's send to a session that is not its own task session reaches the
      // model inside the sender envelope (`envelopeName`, set by reportOrigin).
      const sent = origin.envelopeName
        ? wrapAgentMessage(prompt, { name: origin.envelopeName, agentId: origin.agentId })
        : prompt;
      const take = submit ?? ((options) => sessions.submitSession({ sessionId, prompt: sent, options }));
      result = await take({
        id,
        mode: 'prompt',
        // `fromAgent`: the sending bot, recorded when it writes into another
        // bot's home chat (otherwise the row would read as the user's);
        // `hop`: its place in a bot-to-bot chain (bot-hops.mjs).
        transcriptMeta: {
          sender: 'lead',
          ...(origin.envelopeName ? { fromAgent: origin.agentId } : {}),
          ...(origin.hop > 0 ? { hop: origin.hop } : {}),
        },
        ...(notify
          ? {
              // A room answers this send in a turn under another submission
              // id (one turn for several sends, or a fresh turn for one cut
              // short): the watch follows that turn, recorded before it runs.
              follow: (submissionId) => watches.follow?.(id, submissionId),
              onSettled: (detail) => {
                const status = turnStatus(detail);
                const text = detail?.result?.content || detail?.error || '';
                // A failed or cancelled turn reports at once; a completed one
                // reports the task's final answer (followToFinal).
                if (status !== 'completed') {
                  unwatch();
                  void report(status, text);
                  return;
                }
                follow = followToFinal({
                  sessionId,
                  runId: id,
                  runtime,
                  immediate: { status, text },
                  finish: async (endStatus, endText) => {
                    unwatch();
                    await report(endStatus, endText);
                  },
                  progress: (progressText) => report('working', progressText),
                });
                follow.check();
              },
            }
          : {}),
      });
    } catch (error) {
      unwatch();
      if (notify) await dropWatch();
      throw error;
    }
    const accepted = result?.accepted === true;
    if (!accepted) {
      unwatch();
      if (notify) await dropWatch();
    }
    return {
      accepted,
      reportsBack: accepted && notify,
      ...(accepted && !notify ? { reportsBackReason: noReport } : {}),
    };
  }

  const rearm = (watch) =>
    rearmTaskWatch(
      {
        deliver,
        loadSession,
        materializeSession: (sessionId) => service().materializeSession(sessionId),
        queuedSubmissionIds,
        artifactFields,
        followToFinal,
        log,
      },
      watch
    );

  /** Daemon start: re-attach every reporting turn an earlier process watched.
   *  Resolves once each is reported or watched. */
  async function recover() {
    const pending = (await watches.list()).filter((watch) => watch?.owner !== processToken);
    // The agents the restart killed become queued failure results first, so
    // each re-attached task session has them to take (followToFinal wakeOwed).
    if (pending.length) {
      await Promise.resolve()
        .then(settleAgentResults)
        .catch((error) => log(`settling the agents of the previous process failed: ${error?.message || error}`));
    }
    await Promise.all(
      pending.map((watch) =>
        rearm(watch).catch((error) => log(`re-attaching ${watch?.taskSessionId} failed: ${error?.message || error}`))
      )
    );
    return pending.length;
  }

  /** Create the task session for `brief` and start it; returns at once. */
  async function create(
    args = {},
    { callerSessionId, callerAgentId, callerCwd, callerHop = 0, attachmentParts = [] } = {}
  ) {
    if (!callerAgentId) throw new Error('session: create is only for an agent conversation');
    const brief = typeof args.brief === 'string' ? args.brief.trim() : '';
    if (!brief) throw new Error('session: brief is required for action=create');
    const where = resolveTaskProject(args.project, { projects: await listProjects(), cwd: callerCwd || process.cwd() });
    const requestId = `atask_${randomUUID()}`;
    const title = (clean(args.title) || clean(brief.split('\n')[0])).slice(0, TITLE_LIMIT);
    const taskOrigin = {
      agentId: callerAgentId,
      sessionId: callerSessionId,
      requestId,
      title,
      notify: args.notify !== false,
    };
    // A task session runs in coding mode under Lead: an explicit model wins,
    // else the Lead route, else the last-used model. Never a model-less
    // session — the composer would show no model and its first turn would fail.
    const route = clean(args.model)
      ? await modelRoute(clean(args.model))
      : (await leadRoute()) || (await lastUsedRoute(service()));
    if (!route) throw new Error('session: no model to start the task session on. Choose a Lead model first.');
    const sessions = service();
    const created = await sessions.createSession({
      ...route,
      cwd: where.cwd,
      desktopSession: where.desktopSession,
      sessionProfile: { taskOrigin },
    });
    const sessionId = String(created?.sessionId || '');
    if (!sessionId) throw new Error('session: task session creation returned no session id');
    // The user's New task default: a Project task starts in its own worktree.
    if (where.project && (await newTaskDefault()) === 'worktree') {
      await requestTaskWorktree(sessions, sessionId, title, requestId);
    }
    // "Started" lands in the home before any report of the brief's turn.
    let started = () => {};
    const ready = new Promise((resolveReady) => {
      started = resolveReady;
    });
    // The brief carries the files the agent forwarded (workspace-tools.mjs).
    const prompt = handoffContent(brief, attachmentParts);
    const { accepted, reportsBack, reportsBackReason } = await agentTurn(
      sessionId,
      prompt,
      callerHop > 0 ? { ...taskOrigin, hop: callerHop } : taskOrigin,
      requestId,
      ready
    );
    if (!accepted) throw new Error(`session: task session ${sessionId} did not accept the brief`);
    if (reportsBack) {
      await deliver(callerAgentId, {
        runId: `${requestId}_started`,
        taskSessionId: sessionId,
        title,
        status: 'started',
        ...roomFrom(callerSessionId),
      }).catch((error) => log(`start line of ${sessionId} failed: ${error?.message || error}`));
    }
    started();
    // Started, not done: the final answer is reported later.
    return {
      session_id: sessionId,
      status: 'started',
      title,
      project: where.project?.path ?? null,
      ...(taskOrigin.notify && !reportsBack ? { reportsBack: false, reportsBackReason } : {}),
    };
  }

  const reportOrigin = (sessionId, agentId, callerSessionId) =>
    sendReportOrigin({ loadSession, agentName }, sessionId, agentId, callerSessionId);

  return {
    create,
    reportOrigin,
    recover,
    send: (sessionId, prompt, origin, submit = null) => agentTurn(sessionId, prompt, origin, undefined, null, submit),
  };
}
