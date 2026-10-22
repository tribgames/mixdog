// Refresh the empty Lead session's model-facing tool surface and BP1/BP3
// layers after workflow or search/memory settings change. Conversation
// sessions keep their frozen schema; the next new session picks up the
// updated policy. The exceptions are a workflow or orchestration mode switch
// made in the session itself (switchSessionWorkflow,
// switchSessionOrchestrationMode), which that conversation takes as an overlay.
import { sessionHasConversationMessages } from '../runtime/agent/orchestrator/runtime-core/session-text.mjs';
import { createAgentProfileFold } from './tool-policy/agent-profile-fold.mjs';
import { createPolicyStage } from './tool-policy/policy-stage.mjs';
import { createSessionSwitches } from './tool-policy/session-switches.mjs';
import { rewriteBp3Core } from './tool-policy/surface-helpers.mjs';

export function createToolPolicyRefresh({
  getSession,
  getRoute,
  getMode,
  getConfig,
  getDataDir,
  getActiveTurnCount,
  modelStandaloneTools,
  featureDisallowedTools,
  loadCoreMemoryContext,
  loadInstructionFilesContext,
  activeWorkflowContext,
  invalidatePreSessionToolSurface,
  persistSession,
}) {
  const { liveDeniedTools, stagePolicy, applyPolicy } = createPolicyStage({
    getRoute,
    getMode,
    getDataDir,
    modelStandaloneTools,
    featureDisallowedTools,
    loadCoreMemoryContext,
    loadInstructionFilesContext,
    activeWorkflowContext,
  });

  // A turn is executing from the moment it opens until it settles, even when
  // its transcript holds only notifications (which are not conversation
  // content). Its tool surface is frozen for that whole span.
  function turnInFlight(session) {
    return (getActiveTurnCount?.() || 0) > 0 || Array.isArray(session.liveTurnMessages);
  }

  // Admission: the session is still the current one, no turn is executing and
  // no conversation has started. Checked before staging and again right
  // before the staged change is applied.
  function admitsRefresh(session) {
    return (
      getSession?.() === session &&
      !turnInFlight(session) &&
      !sessionHasConversationMessages(session) &&
      !sessionHasConversationMessages({ messages: session.liveTurnMessages })
    );
  }

  async function refreshEmptySessionToolPolicy() {
    invalidatePreSessionToolSurface?.();
    const session = getSession?.();
    if (!session?.id) return { appliedToCurrentSession: true };
    if (!admitsRefresh(session)) return { appliedToCurrentSession: false };
    // Older records contain only compiled prompt text; rebuilding would guess
    // away custom instructions. Keep that immutable material for every owner.
    const identity = session.promptIdentity;
    if (!identity) return { appliedToCurrentSession: false, reason: 'missing-prompt-identity' };
    const staged = await stagePolicy(session, identity, getConfig());
    // Apply: re-check admission after the await, then mutate synchronously.
    if (!admitsRefresh(session)) return { appliedToCurrentSession: false };
    applyPolicy(session, staged);
    rewriteBp3Core(session, staged.core);
    return { appliedToCurrentSession: true };
  }

  const switches = createSessionSwitches({
    getSession,
    getConfig,
    getDataDir,
    modelStandaloneTools,
    activeWorkflowContext,
    persistSession,
    liveDeniedTools,
    turnInFlight,
  });
  const profile = createAgentProfileFold({
    getSession,
    getConfig,
    getDataDir,
    modelStandaloneTools,
    activeWorkflowContext,
    liveDeniedTools,
    stagePolicy,
    applyPolicy,
    turnInFlight,
  });

  return {
    refreshEmptySessionToolPolicy,
    switchSessionWorkflow: switches.switchSessionWorkflow,
    switchSessionOrchestrationMode: switches.switchSessionOrchestrationMode,
    applyPendingSessionSwitches: switches.applyPendingSessionSwitches,
    refreshAgentProfile: profile.refreshAgentProfile,
    applyPendingAgentProfile: profile.applyPendingAgentProfile,
    currentAgents: profile.currentAgents,
  };
}
