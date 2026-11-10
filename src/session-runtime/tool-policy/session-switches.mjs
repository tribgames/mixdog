// Mid-conversation workflow and orchestration-mode switches of a coding
// session (see createToolPolicyRefresh for the cache contract they share).
import { sessionHasConversationMessages } from '../../runtime/agent/orchestrator/runtime-core/session-text.mjs';
import { toSessionWorkflowMeta } from '../../runtime/agent/orchestrator/runtime-core/workflow.mjs';
import { isAgentOwner } from '../../runtime/agent/orchestrator/agent-owner.mjs';
import { AGENT_MODE, sessionModeOf } from '../../runtime/agent/orchestrator/session/agent-mode.mjs';
import { applyOrchestrationModeSwitch } from './mode-switch.mjs';
import { createPendingSwitchApplier } from './pending-switches.mjs';
import { configForSession, configForWorkflow, currentMode, leadPartsFor } from './surface-helpers.mjs';
import { createWorkflowOverlay } from './workflow-overlay.mjs';

// The session a mid-conversation switch applies to: a coding session with a
// conversation (null: none, the caller's empty-session path applies);
// anything else cannot switch.
function switchableConversation(session, what) {
  if (!session?.id) return false;
  if (
    !sessionHasConversationMessages(session) &&
    !sessionHasConversationMessages({ messages: session.liveTurnMessages })
  ) {
    return false;
  }
  if (isAgentOwner(session) || sessionModeOf(session) === AGENT_MODE) {
    throw new Error(`Only a coding session has a ${what}.`);
  }
  if (!session.promptIdentity) throw new Error(`This session is too old to switch its ${what}; start a new task.`);
  return true;
}

// A choice made while a turn runs waits for the next turn: the latest one
// wins and a choice of what the session already runs cancels it.
function stagePendingSwitch(session, field, value, current) {
  if (value === current) delete session[field];
  else session[field] = value;
  session.updatedAt = Date.now();
}

export function createSessionSwitches({
  getSession,
  getConfig,
  getDataDir,
  modelStandaloneTools,
  activeWorkflowContext,
  persistSession,
  liveDeniedTools,
  turnInFlight,
}) {
  const { applyWorkflowSwitch } = createWorkflowOverlay({
    liveDeniedTools,
    modelStandaloneTools,
  });

  // The workflow `workflowId` names with orchestration mode `mode`, and its
  // Lead prompt parts, read before anything changes. The pack loader falls
  // back to the default pack for a missing id, so a different id is a gone one.
  function resolveWorkflow(session, workflowId, mode) {
    const target = activeWorkflowContext(configForSession(getConfig(), workflowId, mode), getDataDir());
    if (target.summary?.id !== workflowId) throw new Error(`workflow "${workflowId}" not found`);
    return { target, parts: leadPartsFor(session, target.leadPromptParts) };
  }

  // The shared flow of a mid-conversation switch: null without a conversation;
  // while a turn runs the choice is staged, else applied; saved either way.
  async function switchConversation(what, { pendingField, value, current, deferredResult, apply }) {
    const session = getSession?.();
    if (!switchableConversation(session, what)) return null;
    let result;
    if (turnInFlight(session)) {
      stagePendingSwitch(session, pendingField, value, current(session));
      result = deferredResult(session);
    } else {
      result = apply(session);
    }
    await persistSession(session);
    return result;
  }

  /**
   * Switch the current coding session's workflow mid-conversation (the
   * composer's workflow selector). The request prefix — BP1, BP2, BP3 and the
   * tool schemas — stays byte-identical, so the provider cache survives: the
   * session's workflow metadata changes now, and the next turn carries a
   * self-contained reminder with the new workflow's rules, orchestration,
   * agents and tool changes (manager/workflow-switch-notice.mjs). Tools the new
   * workflow denies keep their schema and are refused at call time; tools it
   * allows that the schema lacks stay unavailable until a new session. The
   * prompt takes the new workflow at the next point where the cache is cold
   * anyway (foldPromptIfCold). Never refused while a turn runs: the choice is
   * staged (`pendingWorkflowId`, the last one wins, a pick of the current
   * workflow cancels it) and applied when the next turn starts
   * (applyPendingSessionSwitches). Either way the session is saved before
   * this returns, so an acknowledged choice outlives a daemon restart. The
   * configured workflow (the default for new sessions) is the caller's and
   * stays as it is; the session keeps its own orchestration mode.
   *
   * Running work is untouched: agents and workers the session started under
   * the old workflow are separate sessions with their own prompts and tools,
   * so they keep running as they are (unlike a working-folder change, running
   * agents never refuse this); only delegation made from the next turn on
   * uses the new surface.
   *
   * Returns null when the session has no conversation (the caller applies the
   * configured workflow to an empty session as before), else
   * `{ appliedToCurrentSession: true, workflow, workflowSwitch }` where
   * `workflowSwitch` is the transcript boundary (null when unchanged or
   * deferred; a deferred switch answers `deferred: true` and the workflow
   * the session will run).
   */
  async function switchSessionWorkflow(workflowId) {
    return switchConversation('workflow', {
      pendingField: 'pendingWorkflowId',
      value: workflowId,
      current: (session) => session.workflow?.id,
      deferredResult: (session) => {
        const shown = session.pendingWorkflowId
          ? toSessionWorkflowMeta(
              activeWorkflowContext(configForWorkflow(getConfig(), session.pendingWorkflowId), getDataDir()).summary
            )
          : session.workflow;
        return { appliedToCurrentSession: true, deferred: true, workflow: shown, workflowSwitch: null };
      },
      apply: (session) => {
        const resolved = resolveWorkflow(session, workflowId, currentMode(session));
        delete session.pendingWorkflowId;
        return applyWorkflowSwitch(session, resolved);
      },
    });
  }

  /**
   * Switch the current coding session's orchestration (delegation) mode
   * mid-conversation, on the workflow switch's pattern: the request prefix
   * stays byte-identical, the session's mode changes now, and the next turn
   * carries a reminder with the new mode's rules (the block BP3 carries;
   * manager/orchestration-mode-switch-notice.mjs). The mode never changes
   * which tools may run — Solo still lets the Lead load `agent` when the user
   * asks — only how eagerly delegation is offered: the eager/deferred split
   * stays the prompt's (tool-catalog.mjs), so a mode that delegates while the
   * schema holds `agent` only as a deferred tool tells the model to load it.
   * Back on the prompt's mode the overlay is dropped; the prompt takes the
   * new mode at the next cold point (foldPromptIfCold). While a turn runs the
   * choice waits for the next turn (stagePendingSwitch). Either way the
   * session is saved before this returns. The configured mode (the default
   * for new sessions) is the caller's and stays as it is.
   * Returns null without a conversation (the caller's empty-session path),
   * else `{ appliedToCurrentSession: true, mode, orchestrationModeSwitch }`.
   */
  async function switchSessionOrchestrationMode(mode) {
    return switchConversation('orchestration mode', {
      pendingField: 'pendingOrchestrationMode',
      value: mode,
      current: currentMode,
      deferredResult: (session) => ({
        appliedToCurrentSession: true,
        deferred: true,
        mode: session.pendingOrchestrationMode ?? currentMode(session),
        orchestrationModeSwitch: null,
      }),
      apply: (session) => {
        delete session.pendingOrchestrationMode;
        return applyOrchestrationModeSwitch(session, mode);
      },
    });
  }

  const applyPendingSessionSwitches = createPendingSwitchApplier({ getSession, resolveWorkflow, applyWorkflowSwitch });

  return { switchSessionWorkflow, switchSessionOrchestrationMode, applyPendingSessionSwitches };
}
