// Remote session projection shared by the terminal TUI and Desktop host.
// Synchronous getState() mirrors daemon snapshots while commands cross the
// protocol client owned by the attachment pool.
import { randomUUID } from 'node:crypto';

import {
  createSessionProtocolClient,
  SESSION_CONFIGURE_ACTIONS,
  SESSION_CONFIGURE_ACTION_SET,
  SESSION_READ_ACTIONS,
  SESSION_READ_ACTION_SET,
} from './session-protocol.mjs';
import { SessionAttachmentPool } from './session-attachment-pool.mjs';

const CALL_RECOVERY_BACKOFF_MS = Object.freeze([0, 150, 600]);

function applyStatePatch(state, patch) {
  const next = { ...state, ...(patch.set || {}) };
  if (patch.itemsAppend) {
    const base = Array.isArray(state.items) ? state.items : [];
    next.items = base.slice(0, patch.itemsAppend.from).concat(patch.itemsAppend.values || []);
  }
  for (const key of patch.remove || []) delete next[key];
  return next;
}

export function createSessionProxyFactory({
  attachSession,
  ensureDaemon,
  closeIdleConnections = () => {},
}) {
  const sessionAttachments = new SessionAttachmentPool({
    attachSession,
    createProtocolClient: createSessionProtocolClient,
    ensureDaemon,
    onIdle: closeIdleConnections,
  });

  return async function createSession(options = {}) {
    const log = typeof options.log === 'function' ? options.log : () => {};
    const cwd = options.cwd || process.cwd();
    const openParams = {
      cwd,
      provider: options.provider,
      model: options.model,
      toolMode: options.toolMode || 'full',
      remote: options.remote === true,
      desktopSession: options.desktopSession ?? null,
    };
    let attachment = await sessionAttachments.ensure({ cwd, log });
    const created = await attachment.client.create(openParams, {
      callId: `session-create:${process.pid}:${randomUUID()}`,
    });
    let sessionId = String(created?.sessionId || '');
    if (!sessionId) throw new Error('session.create returned no sessionId');
    let state = created?.full ?? {};
    let revision = Number(created?.revision) || 0;
    let revisionAttachment = attachment;
    let revisionSessionId = sessionId;
    let reservedOnly = created?.reservedOnly === true;
    let disposed = false;
    const listeners = new Set();
    const resultAttachments = new WeakMap();

    function emit() {
      for (const listener of [...listeners]) {
        try { listener(); } catch (error) { log(`session listener threw: ${error?.message || error}`); }
      }
    }

    function applyBody(body, sourceAttachment = resultAttachments.get(body) || attachment) {
      if (disposed || !body) return false;
      if (sourceAttachment !== attachment) return true;
      if (Object.hasOwn(body, 'reservedOnly')) reservedOnly = body.reservedOnly === true;
      const incomingRevision = Number(body.revision);
      if (revisionAttachment !== sourceAttachment || revisionSessionId !== sessionId) {
        if (body.full === undefined || body.full === null) return false;
        state = body.full;
        revision = Number.isFinite(incomingRevision) ? incomingRevision : 0;
        revisionAttachment = sourceAttachment;
        revisionSessionId = sessionId;
        emit();
        return true;
      }
      if (Number.isFinite(incomingRevision) && incomingRevision < revision) return true;
      if (body.full !== undefined && body.full !== null) {
        state = body.full;
        revision = Number.isFinite(incomingRevision) ? incomingRevision : revision;
        emit();
        return true;
      }
      if (body.patch) {
        if (Number(body.revision) === revision
          && Number(body.baseRevision) === revision - 1) return true;
        if (Number(body.baseRevision) !== revision) return false;
        state = applyStatePatch(state, body.patch);
        revision = Number(body.revision) || revision;
        emit();
        return true;
      }
      if (Number.isFinite(Number(body.revision))) {
        revision = Number(body.revision);
        return true;
      }
      return false;
    }

    function baseRevisionFor(
      sourceAttachment = attachment,
      targetSessionId = sessionId,
    ) {
      return revisionAttachment === sourceAttachment && revisionSessionId === targetSessionId
        ? revision
        : null;
    }

    let resyncing = false;
    let resyncDirty = false;
    let resyncDirtyReason = '';
    let resyncFailed = false;
    function resync(reason) {
      if (disposed) return;
      if (resyncing) {
        resyncDirty = true;
        resyncDirtyReason = String(reason || 'revision gap');
        return;
      }
      resyncing = true;
      const requestAttachment = attachment;
      void requestAttachment.client.read({
        sessionId,
        open: openParams,
        baseRevision: baseRevisionFor(requestAttachment),
      }).then((result) => {
        if (disposed || requestAttachment !== attachment) return;
        if (result && typeof result === 'object') resultAttachments.set(result, requestAttachment);
        if (!applyBody(result, requestAttachment) && result?.revision !== undefined) {
          log(`session ${sessionId} resync returned an unusable body`);
          resyncDirty = true;
          resyncFailed = true;
          resyncDirtyReason = 'unusable resync body';
        }
      }).catch((error) => {
        log(`session ${sessionId} resync after ${reason} failed: ${error?.message || error}`);
        resyncDirty = true;
        resyncFailed = true;
        resyncDirtyReason = `retry after failed resync (${reason})`;
      }).finally(() => {
        resyncing = false;
        if (!resyncDirty || disposed) return;
        resyncDirty = false;
        const retryReason = resyncDirtyReason || 'revision gap';
        resyncDirtyReason = '';
        if (!resyncFailed) {
          resync(retryReason);
          return;
        }
        resyncFailed = false;
        const timer = setTimeout(() => { if (!disposed) resync(retryReason); }, 250);
        timer.unref?.();
      });
    }

    let recoveryPromise = null;
    let view;
    async function recover(nextAttachment) {
      if (disposed) return;
      if (recoveryPromise) return recoveryPromise;
      recoveryPromise = (async () => {
        const previousAttachment = attachment;
        if (previousAttachment !== nextAttachment) {
          sessionAttachments.removeView(previousAttachment, sessionId, view);
          attachment = nextAttachment;
        }
        const recoveryAttachment = attachment;
        sessionAttachments.addView(recoveryAttachment, sessionId, view);
        revisionAttachment = null;
        revisionSessionId = '';
        let result;
        try {
          result = await recoveryAttachment.client.subscribe({
            sessionId, open: openParams, baseRevision: null,
          });
        } catch (error) {
          if (!reservedOnly || !/session .* is not available/i.test(String(error?.message || error))) {
            throw error;
          }
          result = await recoveryAttachment.client.create({
            ...openParams,
            sessionId,
          }, {
            callId: `session-recover-reservation:${sessionId}`,
          });
        }
        if (disposed || recoveryAttachment !== attachment) return;
        if (result && typeof result === 'object') resultAttachments.set(result, recoveryAttachment);
        if (!applyBody(result, recoveryAttachment)) {
          const baseline = await recoveryAttachment.client.read({
            sessionId, open: openParams, baseRevision: null,
          });
          if (disposed || recoveryAttachment !== attachment) return;
          if (baseline && typeof baseline === 'object') {
            resultAttachments.set(baseline, recoveryAttachment);
          }
          if (!applyBody(baseline, recoveryAttachment)) {
            throw new Error(`session ${sessionId} recovery returned no full snapshot`);
          }
        }
        log(`session ${sessionId} projection recovered`);
      })();
      try {
        return await recoveryPromise;
      } finally {
        recoveryPromise = null;
      }
    }

    view = {
      sessionId: () => sessionId,
      applyFrame(frame, sourceAttachment = attachment) {
        if (disposed) return;
        if (!applyBody(frame, sourceAttachment)) resync('revision gap');
      },
      applyGone(reason) {
        if (disposed) return;
        log(`session ${sessionId} is no longer available (${reason})`);
      },
      applyDetached(reason) {
        log(`session ${sessionId} projection detached (${reason})`);
      },
      recover,
    };
    sessionAttachments.addView(attachment, sessionId, view);
    attachment.refs += 1;
    sessionAttachments.track(view);

    async function sendCall(route, payload, callId) {
      const send = async () => {
        const sourceAttachment = attachment;
        let result;
        if (route === 'session.create') result = await sourceAttachment.client.create(payload, { callId });
        else if (route === 'session.read') result = await sourceAttachment.client.read(payload, { callId });
        else if (route === 'session.subscribe') result = await sourceAttachment.client.subscribe(payload, { callId });
        else if (route === 'session.submit') result = await sourceAttachment.client.submit(payload, { callId });
        else if (route === 'session.abort') result = await sourceAttachment.client.abort(payload, { callId });
        else if (route === 'session.approve') result = await sourceAttachment.client.approve(payload, { callId });
        else if (route === 'session.configure') result = await sourceAttachment.client.configure(payload, { callId });
        else if (route === 'project.list') result = await sourceAttachment.client.projectList(payload, { callId });
        else if (route === 'project.inspect') result = await sourceAttachment.client.projectInspect(payload, { callId });
        else if (route === 'project.add') result = await sourceAttachment.client.projectAdd(payload, { callId });
        else if (route === 'project.touch') result = await sourceAttachment.client.projectTouch(payload, { callId });
        else if (route === 'project.rename') result = await sourceAttachment.client.projectRename(payload, { callId });
        else if (route === 'project.remove') result = await sourceAttachment.client.projectRemove(payload, { callId });
        else if (route === 'project.ensureDirectory') {
          result = await sourceAttachment.client.projectEnsureDirectory(payload, { callId });
        } else throw new TypeError(`session route ${route} is unavailable`);
        if (result && typeof result === 'object') {
          resultAttachments.set(result, sourceAttachment);
        }
        return result;
      };
      for (let attempt = 0; ; attempt += 1) {
        try {
          return await send();
        } catch (error) {
          const recoverable = error?.daemonTransportError
            || /unknown client token/i.test(String(error?.message || ''));
          if (!recoverable || disposed || attempt >= CALL_RECOVERY_BACKOFF_MS.length) throw error;
          const waitMs = CALL_RECOVERY_BACKOFF_MS[attempt];
          if (waitMs > 0) await new Promise((resolve) => { setTimeout(resolve, waitMs); });
          if (disposed) throw error;
          sessionAttachments.invalidate(attachment);
          const next = await sessionAttachments.ensure({ cwd, log });
          await recover(next);
          if (attempt > 0) {
            log(`session ${sessionId} call ${route} re-attached (attempt ${attempt + 1})`);
          }
        }
      }
    }

    async function applyResult(result, reason) {
      const sourceAttachment = resultAttachments.get(result) || attachment;
      const nextSessionId = String(result?.sessionId || sessionId);
      if (nextSessionId && nextSessionId !== sessionId) {
        const previousSessionId = sessionId;
        sessionAttachments.addView(attachment, nextSessionId, view);
        sessionAttachments.removeView(attachment, previousSessionId, view);
        sessionId = nextSessionId;
      }
      if (!applyBody(result, sourceAttachment) && result?.revision !== undefined) {
        resync(`${reason} body gap`);
      }
      return result;
    }

    let transitionChain = Promise.resolve();
    function serializeTransition(task) {
      const run = transitionChain.then(task);
      transitionChain = run.then(() => {}, () => {});
      return run;
    }

    function afterPendingTransition() {
      return transitionChain;
    }

    function remoteCall(method, args, callOptions = {}) {
      if (disposed) return Promise.reject(new Error('This session view is disposed.'));
      const route = SESSION_READ_ACTION_SET.has(method)
        ? 'session.read'
        : SESSION_CONFIGURE_ACTION_SET.has(method)
          ? 'session.configure'
          : null;
      if (!route) return Promise.reject(new TypeError(`session action ${method} is unavailable`));
      const stableCallId = typeof callOptions.callId === 'string' && callOptions.callId.trim()
        ? callOptions.callId.trim()
        : randomUUID();
      const dispatch = async () => {
        if (disposed) throw new Error('This session view is disposed.');
        const targetSessionId = sessionId;
        const baseRevision = baseRevisionFor(attachment, targetSessionId);
        const result = await sendCall(route, {
          sessionId: targetSessionId,
          action: method,
          args,
          open: openParams,
          baseRevision,
        }, stableCallId);
        if (!disposed && sessionId === targetSessionId) await applyResult(result, method);
        return result?.value ?? null;
      };
      return route === 'session.configure'
        ? afterPendingTransition().then(dispatch)
        : dispatch();
    }

    async function rebindTo(result, previousSessionId) {
      const nextSessionId = String(result?.sessionId || '');
      if (!nextSessionId) throw new Error('session route returned no sessionId');
      const lastLocalView = sessionAttachments.viewCount(attachment, previousSessionId) <= 1;
      sessionAttachments.addView(attachment, nextSessionId, view);
      sessionAttachments.removeView(attachment, previousSessionId, view);
      sessionId = nextSessionId;
      if (!applyBody(result) && result?.revision !== undefined) resync('session rebind body gap');
      if (previousSessionId && previousSessionId !== nextSessionId && lastLocalView) {
        try {
          await attachment.client.unsubscribe({ sessionId: previousSessionId });
        } catch (error) {
          log(`session ${previousSessionId} unsubscribe failed: ${error?.message || error}`);
        }
      }
      return nextSessionId;
    }

    async function createReservedSession() {
      return serializeTransition(async () => {
        if (disposed) throw new Error('This session view is disposed.');
        const previousSessionId = sessionId;
        const result = await sendCall('session.create', openParams,
          `session-create:${process.pid}:${randomUUID()}`);
        return rebindTo(result, previousSessionId);
      });
    }

    async function resumeSession(targetSessionId, resumeOptions) {
      const target = String(targetSessionId || '');
      if (!target) return false;
      return serializeTransition(async () => {
        if (disposed) throw new Error('This session view is disposed.');
        if (target === sessionId) {
          const result = await sendCall('session.read', {
            sessionId,
            open: openParams,
            baseRevision: baseRevisionFor(),
          }, randomUUID());
          await applyResult(result, 'resume');
          return true;
        }
        const previousSessionId = sessionId;
        const result = await sendCall('session.subscribe', {
          sessionId: target,
          open: { ...openParams, resumeOptions: resumeOptions || undefined },
          baseRevision: null,
        }, randomUUID());
        await rebindTo(result, previousSessionId);
        return true;
      });
    }

    let submitSeq = 0;
    async function submitAsync(prompt, options = {}) {
      if (disposed) throw new Error('This session view is disposed.');
      const submissionId = String(options?.id || '').trim()
        || `session-submit-${process.pid}-${Date.now()}-${(submitSeq += 1)}`;
      await afterPendingTransition();
      if (disposed) throw new Error('This session view is disposed.');
      const targetSessionId = sessionId;
      const baseRevision = baseRevisionFor(attachment, targetSessionId);
      const result = await sendCall('session.submit', {
        sessionId: targetSessionId,
        prompt,
        options: { ...(options || {}), id: submissionId },
        open: openParams,
        baseRevision,
      }, `session-submit:${targetSessionId}:${submissionId}`);
      if (!disposed && sessionId === targetSessionId) await applyResult(result, 'submit');
      return result?.accepted === true;
    }

    async function abortAsync(options = {}) {
      if (disposed) return { aborted: false };
      await afterPendingTransition();
      if (disposed) return { aborted: false };
      const result = await sendCall('session.abort', {
        sessionId, open: openParams, options,
        baseRevision: baseRevisionFor(),
      }, randomUUID());
      return applyResult(result, 'abort');
    }

    const base = {
      isRemoteSession: true,
      get disposedView() { return disposed; },
      getState: () => state,
      subscribe(listener) {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      async listSessions(options = {}) {
        const result = await attachment.client.list(options, { callId: randomUUID() });
        return Array.isArray(result?.sessions) ? result.sessions : [];
      },
      async listProjects() {
        const result = await sendCall('project.list', {}, randomUUID());
        return Array.isArray(result?.projects) ? result.projects : [];
      },
      async inspectProjectPath(projectPath) {
        return sendCall('project.inspect', { path: projectPath }, randomUUID());
      },
      async addProject(projectPath) {
        const result = await sendCall('project.add', { path: projectPath }, randomUUID());
        return result?.project ?? null;
      },
      async touchProjectSelected(projectPath) {
        const result = await sendCall('project.touch', { path: projectPath }, randomUUID());
        return result?.project ?? null;
      },
      async renameProject(projectPath, name) {
        const result = await sendCall('project.rename', { path: projectPath, name }, randomUUID());
        return result?.project ?? null;
      },
      async removeProject(projectPath) {
        const result = await sendCall('project.remove', { path: projectPath }, randomUUID());
        return result?.removed === true;
      },
      async ensureProjectDirectory(projectPath) {
        const result = await sendCall('project.ensureDirectory', {
          path: projectPath,
        }, randomUUID());
        return String(result?.path || '');
      },
      async newSession(options = {}) {
        if (options?.reuseReservation === true && reservedOnly) return true;
        await createReservedSession();
        return true;
      },
      resume: resumeSession,
      async prefetchSession(targetSessionId) {
        const target = String(targetSessionId || '');
        if (!target) return false;
        await attachment.client.read({
          sessionId: target,
          open: openParams,
          baseRevision: null,
        });
        return true;
      },
      submitAsync,
      submit(prompt, options) {
        if (disposed) return false;
        void submitAsync(prompt, options).catch((error) => {
          log(`session submit failed: ${error?.message || error}`);
        });
        return true;
      },
      abortAsync,
      abort(options = {}) {
        void abortAsync(options).catch((error) =>
          log(`session abort failed: ${error?.message || error}`));
        return true;
      },
      resolveToolApproval(id, decision) {
        void (async () => {
          if (disposed) return;
          const result = await sendCall('session.approve', {
            sessionId,
            approvalId: id,
            decision,
            open: openParams,
            baseRevision: baseRevisionFor(),
          }, randomUUID());
          await applyResult(result, 'approval');
        })().catch((error) => log(`session approval failed: ${error?.message || error}`));
        return true;
      },
      async dispose(reason = 'view dispose') {
        if (disposed) return;
        disposed = true;
        sessionAttachments.untrack(view);
        const releasedSessionId = sessionId;
        const lastLocalView = sessionAttachments.viewCount(attachment, releasedSessionId) <= 1;
        if (lastLocalView) {
          try {
            await attachment.client.unsubscribe({ sessionId: releasedSessionId });
          } catch (error) {
            log(`session ${releasedSessionId} unsubscribe failed: ${error?.message || error}`);
          }
        }
        sessionAttachments.removeView(attachment, releasedSessionId, view);
        listeners.clear();
        attachment.refs = Math.max(0, attachment.refs - 1);
        if (sessionAttachments.idle(attachment)) {
          try { await attachment.client.close(reason); } catch {}
          sessionAttachments.releaseIdle(attachment);
        }
      },
    };

    for (const action of SESSION_READ_ACTIONS) {
      if (!Object.hasOwn(base, action)) base[action] = (...args) => remoteCall(action, args);
    }
    for (const action of SESSION_CONFIGURE_ACTIONS) {
      if (!Object.hasOwn(base, action)) base[action] = (...args) => remoteCall(action, args);
    }
    return base;
  };
}
