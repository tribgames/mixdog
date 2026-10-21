// Applying the orchestration mode and workflow choices made while a turn ran.
import { recordTranscriptBoundary } from '../model-route/set-route.mjs';
import { applyOrchestrationModeSwitch } from './mode-switch.mjs';
import { currentMode } from './surface-helpers.mjs';

// The transcript note of a pending workflow that could not be applied: the
// conversation keeps the workflow it runs.
function unavailableWorkflowBoundary(session, workflowId, error) {
  const current = session.workflow;
  const boundary = {
    fromId: current?.id || '',
    from: current?.name || current?.id || '',
    toId: workflowId,
    to: workflowId,
    unavailable: true,
    reason: String(error?.message || error),
    at: Date.now(),
  };
  recordTranscriptBoundary(
    session,
    'workflowSwitches',
    boundary,
    (entry) => entry?.at === boundary.at && entry?.toId === workflowId && entry?.unavailable === true
  );
  return boundary;
}

export function createPendingSwitchApplier({ getSession, resolveWorkflow, applyWorkflowSwitch }) {
  /** Turn start: apply the orchestration mode and workflow chosen while the
   *  previous turn ran (mode first, so a workflow reminder carries it). Both
   *  are resolved before anything changes; a workflow that is gone (or cannot
   *  be read) is dropped alone with a transcript note and the turn runs on the
   *  current workflow. The pending choices are cleared only once applied.
   *  Returns the transcript boundaries, or null when nothing switched. */
  return function applyPendingSessionSwitches() {
    const session = getSession?.();
    if (!session?.id) return null;
    const { pendingOrchestrationMode: mode, pendingWorkflowId: workflowId } = session;
    if (mode === undefined && workflowId === undefined) return null;
    let resolved = null;
    let unavailable = null;
    if (workflowId !== undefined) {
      try {
        resolved = resolveWorkflow(session, workflowId, mode ?? currentMode(session));
      } catch (error) {
        unavailable = unavailableWorkflowBoundary(session, workflowId, error);
      }
    }
    const switches = {};
    if (mode !== undefined) {
      switches.orchestrationModeSwitch = applyOrchestrationModeSwitch(session, mode).orchestrationModeSwitch;
    }
    if (resolved) switches.workflowSwitch = applyWorkflowSwitch(session, resolved).workflowSwitch;
    else if (unavailable) switches.workflowSwitch = unavailable;
    delete session.pendingOrchestrationMode;
    delete session.pendingWorkflowId;
    return switches.orchestrationModeSwitch || switches.workflowSwitch ? switches : null;
  };
}
