// Remote session projection shared by the terminal TUI and Desktop host.
// Synchronous getState() mirrors daemon snapshots while commands cross the
// protocol client owned by the attachment pool. One view's mutable identity
// — its attachment, session id and disposed flag — is the explicit `binding`
// record every piece under session-proxy/ reads: projection (state +
// revision), resync, transport-calls (send + recover) and transitions
// (session-id moves).
import { randomUUID } from 'node:crypto';

import { createSessionProtocolClient, SESSION_CONFIGURE_ACTIONS, SESSION_READ_ACTIONS } from './session-protocol.mjs';
import { SessionAttachmentPool } from './session-attachment-pool.mjs';
import { createProjection } from './session-proxy/projection.mjs';
import { createResync } from './session-proxy/resync.mjs';
import { createTransportCalls } from './session-proxy/transport-calls.mjs';
import { createTransitions } from './session-proxy/transitions.mjs';
import { createProxyView } from './session-proxy/proxy-view.mjs';
import { createRemoteActions } from './session-proxy/remote-actions.mjs';
import { createProjectRoutes } from './session-proxy/project-routes.mjs';

export function createSessionProxyFactory({ attachSession, ensureDaemon, closeIdleConnections = () => {} }) {
  const pool = new SessionAttachmentPool({
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
    const attachment = await pool.ensure({ cwd, log });
    const created = await attachment.client.create(openParams, {
      callId: `session-create:${process.pid}:${randomUUID()}`,
    });
    const sessionId = String(created?.sessionId || '');
    if (!sessionId) throw new Error('session.create returned no sessionId');
    const binding = { attachment, sessionId, disposed: false };
    const projection = createProjection({ binding, log });
    projection.seed(created);
    const resync = createResync({ binding, projection, openParams, log });
    let view;
    const getView = () => view;
    const { sendCall, recover } = createTransportCalls({ binding, projection, pool, openParams, cwd, log, getView });
    const transitions = createTransitions({ binding, projection, pool, sendCall, resync, openParams, log, getView });
    const { applyResult, afterPendingTransition } = transitions;
    const proxyView = createProxyView({ binding, projection, pool, resync, recover, log });
    view = proxyView.view;
    const { remoteCall, submitAsync, submit, abortAsync, abort, resolveToolApproval } = createRemoteActions({
      binding,
      projection,
      openParams,
      sendCall,
      applyResult,
      afterPendingTransition,
      log,
    });

    const base = {
      isRemoteSession: true,
      get disposedView() {
        return binding.disposed;
      },
      getState: projection.getState,
      subscribe: projection.subscribe,
      ...createProjectRoutes({ binding, sendCall }),
      async newSession(newOptions = {}) {
        if (newOptions?.reuseReservation === true && projection.reservedOnly) return true;
        await transitions.createReservedSession();
        return true;
      },
      resume: transitions.resumeSession,
      async prefetchSession(targetSessionId) {
        const target = String(targetSessionId || '');
        if (!target) return false;
        await binding.attachment.client.read({ sessionId: target, open: openParams, baseRevision: null });
        return true;
      },
      submitAsync,
      submit,
      abortAsync,
      abort,
      resolveToolApproval,
      dispose: proxyView.dispose,
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
