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
 */
import { randomUUID } from 'node:crypto';
import { realpathSync, statSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import { clean } from '../runtime/agent/orchestrator/runtime-core/session-text.mjs';

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

export function createAgentTaskSessions({
  getSessionService,
  deliver = async (agentId, report) => (await import('./agent-home-delivery.mjs')).deliverAgentTask(agentId, report),
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
  log = (line) => process.stderr.write(`mixdog task sessions: ${line}\n`),
}) {
  const service = () => {
    const value = getSessionService();
    if (!value) throw new Error('session: session service is unavailable');
    return value;
  };

  /** Submit `prompt` as the origin agent's turn; its end (and a wait for the
   *  user in it) reports to the agent's home. Resolves on intake. */
  async function agentTurn(sessionId, prompt, origin, id = `atask_${randomUUID()}`, beforeReport = null) {
    const sessions = service();
    const report = (status, text = '') =>
      Promise.resolve(beforeReport)
        .then(() =>
          deliver(origin.agentId, {
            runId: `${id}_${status === 'blocked' ? 'blocked' : 'end'}`,
            taskSessionId: sessionId,
            title: origin.title,
            status,
            text,
          })
        )
        .catch((error) => log(`report of ${sessionId} failed: ${error?.message || error}`));
    const notify = origin.notify !== false;
    let unwatch = () => {};
    if (notify) {
      const runtime = await sessions.materializeSession(sessionId);
      let blocked = false;
      unwatch =
        runtime?.subscribe?.(() => {
          if (blocked || !runtime.getState?.()?.toolApproval) return;
          blocked = true;
          void report('blocked');
        }) || unwatch;
    }
    const result = await sessions.submitSession({
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
    if (result?.accepted !== true) unwatch();
    return result?.accepted === true;
  }

  /** Create the task session for `brief` and start it; returns at once. */
  async function create(args = {}, { callerSessionId, callerAgentId, callerCwd } = {}) {
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
    const route = clean(args.model) ? await modelRoute(clean(args.model)) : {};
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
    const accepted = await agentTurn(sessionId, brief, taskOrigin, requestId, ready);
    if (!accepted) throw new Error(`session: task session ${sessionId} did not accept the brief`);
    if (taskOrigin.notify) {
      await deliver(callerAgentId, {
        runId: `${requestId}_started`,
        taskSessionId: sessionId,
        title,
        status: 'started',
      }).catch((error) => log(`start line of ${sessionId} failed: ${error?.message || error}`));
    }
    started();
    return { session_id: sessionId, title, project: where.project?.path ?? null };
  }

  /** The origin of a task session, when `agentId` created it. */
  async function originFor(sessionId, agentId) {
    if (!agentId) return null;
    const origin = (await loadSession(sessionId))?.taskOrigin;
    return origin?.agentId === agentId ? origin : null;
  }

  return { create, originFor, send: (sessionId, prompt, origin) => agentTurn(sessionId, prompt, origin) };
}
