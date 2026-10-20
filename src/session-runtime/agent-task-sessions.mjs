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
 * session), so they land in the ROOM's log as that member's row and in its own
 * member session, never in its home (agent-home-delivery.mjs enqueueTask).
 */
import { randomUUID } from 'node:crypto';
import { realpathSync, statSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import { clean } from '../runtime/agent/orchestrator/runtime-core/session-text.mjs';
import { collectTurnArtifacts, handoffContent, sessionRoots, turnSlice } from './handoff-attachments.mjs';
import { roomMemberOfSession } from '../runtime/agent/orchestrator/session/agent-room.mjs';

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

const LOST_TEXT = 'The message never ran: the app restarted before its turn started.';
const GONE_TEXT = 'The session no longer exists.';

// The last-used model search stops after this many catalog pages.
const LAST_USED_ROUTE_MAX_PAGES = 20;

/** A report's `from` when its origin is a group-room member session: the
 *  report goes to that member's room instead of the agent's home. */
const roomFrom = (originSessionId) => (roomMemberOfSession(originSessionId) ? { from: originSessionId } : {});

export function createAgentTaskSessions({
  getSessionService,
  deliver = async (agentId, report) => (await import('./agent-home-delivery.mjs')).deliverAgentTask(agentId, report),
  // The durable watch of each reporting turn until its end is queued.
  watches = {
    add: async (watch) => (await import('./agent-home-delivery.mjs')).watchAgentTask(watch),
    list: async () => (await import('./agent-home-delivery.mjs')).agentTaskWatches(),
    remove: async (runId) => (await import('./agent-home-delivery.mjs')).unwatchAgentTask(runId),
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
  modelRoute = async (modelRef) => {
    const [{ modelRouteFields, parseScheduleModelRef }, { migrateCodexRoute }, { loadConfig }] = await Promise.all([
      import('../runtime/shared/schedule-model-ref.mjs'),
      import('../runtime/agent/orchestrator/providers/openai-oauth-catalog-store.mjs'),
      import('../runtime/agent/orchestrator/config.mjs'),
    ]);
    // A provider/model[@effort…] ref (a superseded model runs on its
    // successor) or a preset name.
    const ref = parseScheduleModelRef(modelRef);
    if (ref && typeof ref === 'object') return modelRouteFields(migrateCodexRoute(ref));
    const preset = loadConfig({ secrets: false }).presets?.find((p) => p.id === ref || p.name === ref);
    if (!preset) throw new Error(`model "${ref}" is neither a provider/model route nor a known preset name`);
    return modelRouteFields(preset);
  },
  // The Lead (Main) route of the config — what a desktop New task starts on.
  // Null while none is chosen.
  leadRoute = async () => {
    const [{ modelRouteFields }, { resolveRoute }, { loadConfig }] = await Promise.all([
      import('../runtime/shared/schedule-model-ref.mjs'),
      import('./boot/shared.mjs'),
      import('../runtime/agent/orchestrator/config.mjs'),
    ]);
    const route = resolveRoute(loadConfig({ secrets: false }), {});
    return clean(route?.provider) && clean(route?.model) ? modelRouteFields(route) : null;
  },
  // The model the user last used in a coding session (the runtime's stand-in
  // for the desktop's last New-task model): the first row that has one in the
  // catalog, which lists newest activity first. Pages on (bounded) until a
  // row qualifies; null when none does.
  lastUsedRoute = async (sessionService) => {
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
  },
  // The files turn `runId` of `sessionId` produced (handoff-attachments.mjs),
  // read from its live runtime when one is given, else its stored record.
  turnArtifacts = async (sessionId, runId, runtime = null) => {
    const stored = await loadSession(sessionId);
    const live = typeof runtime?.readModelMessages === 'function' ? await runtime.readModelMessages(0) : null;
    const messages = turnSlice(Array.isArray(live?.messages) ? live.messages : stored?.messages, { runId });
    return collectTurnArtifacts(messages, { cwd: stored?.cwd, roots: sessionRoots(stored) });
  },
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

  /** Submit `prompt` as the origin agent's turn; its end (and a wait for the
   *  user in it) reports to the agent's home. Resolves on intake. */
  async function agentTurn(sessionId, prompt, origin, id = `atask_${randomUUID()}`, beforeReport = null) {
    const sessions = service();
    const target = origin.target === 'session' ? { target: 'session' } : {};
    // The watch is durable before the turn can start, so no end goes
    // unreported across a restart; a turn whose watch could not be stored
    // runs without a report (reportsBack false) rather than claim one.
    let notify = false;
    if (origin.notify !== false) {
      try {
        await watches.add({
          runId: id,
          agentId: origin.agentId,
          homeSessionId: origin.sessionId,
          taskSessionId: sessionId,
          title: origin.title,
          ...target,
          ...(origin.textOnly ? { textOnly: true } : {}),
          owner: processToken,
          at: Date.now(),
        });
        notify = true;
      } catch (error) {
        log(`watch of ${sessionId} failed, sending without a report: ${error?.message || error}`);
      }
    }
    const dropWatch = () =>
      watches.remove(id).catch((error) => log(`dropping the watch of ${sessionId} failed: ${error?.message || error}`));
    let runtime = null;
    const report = (status, text = '') =>
      Promise.resolve(beforeReport)
        .then(async () =>
          deliver(origin.agentId, {
            runId: `${id}_${status === 'blocked' ? 'blocked' : 'end'}`,
            taskSessionId: sessionId,
            title: origin.title,
            status,
            text,
            ...target,
            ...roomFrom(origin.sessionId),
            // A turn's end brings back the files it produced, when the agent
            // may receive them (reportOrigin `textOnly`).
            ...(status === 'blocked'
              ? {}
              : { watchId: id, ...(origin.textOnly ? {} : await artifactFields(sessionId, id, runtime)) }),
          })
        )
        .catch((error) => log(`report of ${sessionId} failed: ${error?.message || error}`));
    let unwatch = () => {};
    let result;
    try {
      if (notify) {
        runtime = await sessions.materializeSession(sessionId);
        let blocked = false;
        unwatch =
          runtime?.subscribe?.(() => {
            if (blocked || !runtime.getState?.()?.toolApproval) return;
            blocked = true;
            void report('blocked');
          }) || unwatch;
      }
      result = await sessions.submitSession({
        sessionId,
        prompt,
        options: {
          id,
          mode: 'prompt',
          transcriptMeta: { sender: 'lead' },
          ...(notify
            ? {
                onSettled: (detail) => {
                  unwatch();
                  void report(turnStatus(detail), detail?.result?.content || detail?.error || '');
                },
              }
            : {}),
        },
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
    return { accepted, reportsBack: accepted && notify };
  }

  /** Re-attach one watch a stopped daemon left: report the turn's end once
   *  from the target's record, or watch it until it ends. */
  async function rearm(watch) {
    const sessionId = watch.taskSessionId;
    const finish = async (status, text = '') =>
      deliver(watch.agentId, {
        runId: `${watch.runId}_end`,
        taskSessionId: sessionId,
        title: watch.title,
        status,
        text,
        ...(watch.target === 'session' ? { target: 'session' } : {}),
        ...roomFrom(watch.homeSessionId),
        watchId: watch.runId,
        ...(watch.textOnly || text === GONE_TEXT || text === LOST_TEXT
          ? {}
          : await artifactFields(sessionId, watch.runId)),
      });
    if (!(await loadSession(sessionId))) return finish('cancelled', GONE_TEXT);
    const runtime = await service().materializeSession(sessionId);
    let done = false;
    let checking = false;
    let again = false;
    let unsubscribe = () => {};
    const check = async () => {
      if (done) return;
      if (checking) {
        again = true;
        return;
      }
      checking = true;
      try {
        do {
          again = false;
          const outcome = submissionOutcome((await loadSession(sessionId))?.messages, watch.runId);
          const state = runtime?.getState?.() || {};
          let end = outcome && outcome !== 'open' ? outcome : null;
          if (!end && !state.busy) {
            const queued = (state.queued || []).some((entry) => entry?.id === watch.runId);
            if (outcome === 'open' && !queued) end = { status: 'cancelled', text: '' };
            else if (!outcome && !queued && !(await queuedSubmissionIds(sessionId)).includes(watch.runId)) {
              end = { status: 'cancelled', text: LOST_TEXT };
            }
          }
          if (end) {
            done = true;
            unsubscribe();
            await finish(end.status, end.text);
          }
        } while (again && !done);
      } finally {
        checking = false;
      }
    };
    const failed = (error) => log(`re-attaching ${sessionId} failed: ${error?.message || error}`);
    unsubscribe = runtime?.subscribe?.(() => void check().catch(failed)) || unsubscribe;
    await check();
  }

  /** Daemon start: re-attach every reporting turn an earlier process watched.
   *  Resolves once each is reported or watched. */
  async function recover() {
    const pending = (await watches.list()).filter((watch) => watch?.owner !== processToken);
    await Promise.all(
      pending.map((watch) =>
        rearm(watch).catch((error) => log(`re-attaching ${watch?.taskSessionId} failed: ${error?.message || error}`))
      )
    );
    return pending.length;
  }

  /** Create the task session for `brief` and start it; returns at once. */
  async function create(args = {}, { callerSessionId, callerAgentId, callerCwd, attachmentParts = [] } = {}) {
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
    // "Started" lands in the home before any report of the brief's turn.
    let started = () => {};
    const ready = new Promise((resolveReady) => {
      started = resolveReady;
    });
    // The brief carries the files the agent forwarded (workspace-tools.mjs).
    const prompt = handoffContent(brief, attachmentParts);
    const { accepted, reportsBack } = await agentTurn(sessionId, prompt, taskOrigin, requestId, ready);
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
    return {
      session_id: sessionId,
      title,
      project: where.project?.path ?? null,
      ...(taskOrigin.notify && !reportsBack ? { reportsBack: false } : {}),
    };
  }

  /** The origin a `send` of agent `agentId` (from its home or room member
   *  session `callerSessionId`) reports to: the stored one of a task session
   *  it created, else one for this send only — never stored on the target,
   *  whose own origin and owner stay as they are. Either reports to the
   *  conversation the send came from. Null for a caller that is no agent
   *  conversation. */
  async function reportOrigin(sessionId, agentId, callerSessionId) {
    if (!agentId) return null;
    const target = await loadSession(sessionId);
    const origin = target?.taskOrigin;
    if (origin?.agentId === agentId) {
      return callerSessionId && callerSessionId !== origin.sessionId
        ? { ...origin, sessionId: callerSessionId }
        : origin;
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
      ...(own ? {} : { textOnly: true }),
    };
  }

  return { create, reportOrigin, recover, send: (sessionId, prompt, origin) => agentTurn(sessionId, prompt, origin) };
}
