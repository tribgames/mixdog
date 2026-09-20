/**
 * lifecycle.mjs — the session object's session-boundary surface: tool
 * approval resolution, the session catalog reads and the runtime passthroughs,
 * composed with the transition groups under ./lifecycle/ (resets, inheritance,
 * resume, dispose).
 */
import { createSessionResetActions } from './lifecycle/session-reset.mjs';
import { createInheritanceActions } from './lifecycle/inheritance.mjs';
import { createResumeAction } from './lifecycle/resume.mjs';
import { createDisposeAction } from './lifecycle/dispose.mjs';

export function createSessionLifecycleApi(bag, { restoreTranscriptItems, oauthFlows }) {
  const { runtime, pushNotice, removeNotice, setProgressHint, finishToolApproval } = bag;

  return {
    resolveToolApproval: (id, decision = {}) => {
      const approved = decision === true || decision?.approved === true;
      return finishToolApproval(id, approved, decision?.reason || (approved ? 'approved by user' : 'denied by user'));
    },
    pushNotice,
    removeNotice,
    setProgressHint,
    ...createSessionResetActions(bag),
    listSessions: (options) => {
      return runtime.listSessions(options);
    },
    renameSessionTitle: (id, title) => {
      return runtime.renameSessionTitle?.(id, title) ?? false;
    },
    // Desktop sidebar watcher hook: the daemon watches this directory so
    // heartbeat sidecar create/delete pushes instant working/dot updates.
    // Without it the watcher silently no-ops and the sidebar falls back to
    // the 60s safety poll (user: spinner kept spinning after the turn ended).
    sessionStoreDir: () => {
      try {
        return runtime.sessionStoreDir?.() || null;
      } catch {
        return null;
      }
    },
    ...createInheritanceActions(bag, { restoreTranscriptItems }),
    ...createResumeAction(bag, { restoreTranscriptItems }),

    deliverToolCompletion: (sessionId, text, meta = {}) =>
      runtime.deliverToolCompletion?.(sessionId, text, meta) === true,

    closeCanonicalSession: (reason = 'canonical-session-close') => runtime.closeCanonicalSession?.(reason) === true,

    ...createDisposeAction(bag, { oauthFlows }),
  };
}
