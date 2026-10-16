import {
  reconcileDeferredMcpToolCatalog,
  refreshInitialDeferredMcpSurface,
  scopedMcpToolsFor,
} from '../../../runtime/agent/orchestrator/runtime-core/tool-catalog.mjs';
import { throwIfAborted } from '../../../runtime/shared/abort-race.mjs';

// Session preparation before askSession: route readiness, session creation,
// transcript user row, first title, the MCP surface fold, and the
// UserPromptSubmit hook.
export function createTurnPreparation({
  getSession,
  getCurrentCwd,
  awaitRoutePreparation,
  createCurrentSession,
  ensureSessionTranscriptWriter,
  transcript,
  sessionTitles,
  hooks,
  hookCommonPayload,
  agentTool,
  getConfig,
  assertSessionAdmission,
  prepareTurnWorkspace,
  admitTurnWorkspace,
}) {
  const scopedMcpTools = (session) => scopedMcpToolsFor(session, getConfig());

  function scheduleFirstTitle(session0, prompt) {
    let resolve = null;
    const after = new Promise((done) => {
      resolve = done;
    });
    const release = () => {
      if (!resolve) return;
      const done = resolve;
      resolve = null;
      done();
    };
    try {
      sessionTitles?.scheduleFirst(session0, prompt, { after });
    } catch {
      /* title fallback stays the preview */
    }
    return release;
  }

  async function foldMcpSurface(turn, session0) {
    // Slower servers remain available through the late-tool path; a reconnect
    // in flight gets the same short TTFT grace BEFORE folding the catalog so it
    // cannot hold the provider request. No reconnect in flight → no-op.
    const awaitGrace = async (options) => {
      try {
        await turn.awaitTurn(() => turn.timing.awaitMcpGrace(options));
      } catch {
        /* gate must never break the turn */
      }
    };
    if (session0.deferredInitialRefreshPending) {
      // FIRST TURN of a FRESH session (session-local gate, NOT the process-wide
      // firstTurnCompleted): an MCP server may have finished its handshake
      // BETWEEN session-create and this first send. Re-fold the LIVE registry
      // into the INITIAL provider-visible surface (sync, in-place, idempotent).
      // One-shot: cleared before the fold so a throw still never re-runs it,
      // and a resumed session (flag unset) skips straight to the late path.
      session0.deferredInitialRefreshPending = false;
      // A spawned agent runtime owns a fresh MCP scope whose connect starts at
      // its boot, so the 0 ms default grace would hide every MCP tool from the
      // agent's first (often only) turn. Agents are not on the user's TTFT
      // path: wait for the initial connect within the server startup budget.
      const agentOwned = session0.owner === 'agent' || session0.visibility === 'agent-only';
      await awaitGrace({ untilConnected: agentOwned });
      try {
        refreshInitialDeferredMcpSurface(session0, scopedMcpTools(session0));
      } catch {
        /* first-turn MCP fold must never break the turn */
      }
      return;
    }
    await awaitGrace();
    try {
      // Persist a typed world-state delta on the session. askSession attaches
      // it to THIS real prompt; reconciliation itself never enqueues a
      // follow-up turn.
      reconcileDeferredMcpToolCatalog(session0, scopedMcpTools(session0));
    } catch {
      /* MCP delta must never break the turn */
    }
  }

  // Historical-session resume publishes its transcript immediately while
  // provider/model metadata initializes in the background. Only the next
  // actual turn waits, guaranteeing that it cannot run on a stale route.
  async function prepareSession(turn, prompt, options = {}) {
    // A closing/closed addressed runtime admits no turn (checked again after
    // every await that could have outlived a close).
    assertSessionAdmission?.();
    await turn.awaitTurn(() => awaitRoutePreparation?.());
    assertSessionAdmission?.();
    turn.timing.routeWaitMs = performance.now() - turn.routeStartedAt;
    if (!getSession()?.id) {
      await turn.awaitTurn(() => createCurrentSession('turn', { signal: turn.signal }));
    }
    throwIfAborted(turn.signal);
    assertSessionAdmission?.();
    // Turn admission: waits while this session's workspace transitions or
    // another session changes the checkout this session works in, then holds
    // the turn registered (released by settleTurn) so no checkout changes
    // under it.
    if (typeof admitTurnWorkspace === 'function') {
      turn.releaseWorkspace = await admitTurnWorkspace({ signal: turn.signal });
      throwIfAborted(turn.signal);
      assertSessionAdmission?.();
    }
    // Workspace gate: a session in recovery refuses the turn, and a pending
    // worktree intent is provisioned and applied (cwd, record, prompt context)
    // BEFORE the user row, the review snapshot, hooks, the provider and any
    // worker spawn. The submission id is the provisioning transaction id, so a
    // retried or duplicate send reuses the same worktree.
    if (typeof prepareTurnWorkspace === 'function') {
      await turn.awaitTurn(() =>
        prepareTurnWorkspace({
          submissionId: String(options.id || '').trim(),
          prompt,
          signal: turn.signal,
          confirmLarge: options.confirmLarge === true,
        })
      );
      throwIfAborted(turn.signal);
      assertSessionAdmission?.();
    }
    ensureSessionTranscriptWriter?.();
    transcript.appendUser(prompt);
    const session0 = getSession();
    turn.session0 = session0;
    // Turn-review boundary: Lead worktree capture overlaps route/MCP/provider
    // preparation. Worker apply_patch diffs bind to this generation and cannot
    // leak into the next turn/session.
    turn.snapshot.start(session0?.id);
    turn.releaseFirstTitle = scheduleFirstTitle(session0, prompt);
    await foldMcpSurface(turn, session0);
    hooks.emit('turn:start', { sessionId: session0.id, prompt, cwd: getCurrentCwd() });
    try {
      agentTool?.upsertLeadSession?.(session0, {
        status: 'running',
        stage: 'running',
        turnStartedAt: new Date().toISOString(),
      });
    } catch {
      /* lead pool must never break the turn */
    }
    return session0;
  }

  // UserPromptSubmit: a hook FAILURE must not block the turn, but
  // blocked===true MUST throw. Returns the turn context the hook adds to the
  // caller's own.
  async function dispatchPromptSubmit(turn, session0, prompt, options) {
    let promptDispatch = null;
    try {
      promptDispatch = await turn.awaitTurn(() =>
        hooks.dispatch('UserPromptSubmit', hookCommonPayload({ session_id: session0.id, prompt }))
      );
    } catch {
      throwIfAborted(turn.signal);
      // Ordinary hook failure never blocks the turn.
    }
    if (promptDispatch?.blocked === true) {
      throw new Error(`prompt blocked by hook: ${promptDispatch.reason || ''}`);
    }
    const hookContext = Array.isArray(promptDispatch?.additionalContext)
      ? promptDispatch.additionalContext.join('\n\n')
      : String(promptDispatch?.additionalContext || '');
    return [options.context || '', hookContext]
      .map((part) => String(part || '').trim())
      .filter(Boolean)
      .join('\n\n');
  }

  return { prepareSession, dispatchPromptSubmit };
}
