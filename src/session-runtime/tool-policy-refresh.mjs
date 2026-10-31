// Bring a session to the settings as they stand at each turn start
// (reconcileTurnSettings): an empty session's tool surface and BP1/BP3 are
// rebuilt; a conversation keeps its prefix and takes moved tool gates live.
// Setters only save config. The exceptions are a workflow or orchestration mode switch
// made in the session itself (switchSessionWorkflow,
// switchSessionOrchestrationMode), which that conversation takes as an overlay.
import { sessionHasConversationMessages } from '../runtime/agent/orchestrator/runtime-core/session-text.mjs';
import { createAgentProfileFold } from './tool-policy/agent-profile-fold.mjs';
import { createPolicyStage } from './tool-policy/policy-stage.mjs';
import { createSessionSwitches } from './tool-policy/session-switches.mjs';
import { rewriteBp3Core } from './tool-policy/surface-helpers.mjs';
import {
  stageConnectorAvailability,
  stageToolAvailability,
} from '../runtime/agent/orchestrator/runtime-core/tool-availability.mjs';
import { resetBp2StableContext } from '../runtime/agent/orchestrator/context/collect.mjs';

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
  toolDefinitionsFor = () => [],
  getSurfaceGeneration,
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

  // What the gates a surface is built from read: the config object (replaced,
  // never mutated, on every adopt and every reload of a change made
  // elsewhere), the surface generation (skills/plugins invalidate it) and the
  // live gate list (which carries bridge presence).
  const configGenerations = new WeakMap();
  let configCount = 0;
  function availabilityKey() {
    const config = getConfig?.() || {};
    let generation = configGenerations.get(config);
    if (generation === undefined) {
      generation = ++configCount;
      configGenerations.set(config, generation);
    }
    return `${generation}|${getSurfaceGeneration?.() || 0}|${featureDisallowedTools().join(',')}`;
  }
  // Session → the key it was last brought to (process-local, so a session
  // first seen here, e.g. resumed, is checked once).
  const appliedKeys = new WeakMap();

  const conversationEmpty = (session) =>
    !sessionHasConversationMessages(session) && !sessionHasConversationMessages({ messages: session.liveTurnMessages });

  /** A session just built from the current settings. */
  function noteToolAvailability(session) {
    if (session) appliedKeys.set(session, { gates: availabilityKey() });
  }

  /** Whether a settings change reaches the current session's whole prompt
   *  (no session yet, or one without a conversation, rebuilt at its turn). */
  function settingsReachCurrentSession() {
    const session = getSession?.();
    return !session?.id || (Boolean(session.promptIdentity) && conversationEmpty(session));
  }

  async function reconcileSession(session) {
    // Connector switches are read from their (stat-cached) files every turn.
    const connectors = stageConnectorAvailability(session);
    const gates = availabilityKey();
    const identity = session.promptIdentity;
    if (appliedKeys.get(session)?.gates === gates) {
      return connectors ? { rebuilt: false, ...connectors } : null;
    }
    let rebuilt = false;
    if (identity && conversationEmpty(session)) {
      // Nothing was sent: the whole prompt is rebuilt in place.
      const staged = await stagePolicy(session, identity, getConfig());
      if (getSession?.() === session && conversationEmpty(session)) {
        if (typeof staged.stableContext === 'string') resetBp2StableContext(session, staged.stableContext);
        applyPolicy(session, staged);
        rewriteBp3Core(session, staged.core);
        // The first-turn MCP fold may rebuild it in place too (an empty
        // session reopened from disk was never marked).
        session.deferredInitialRefreshPending = true;
        rebuilt = true;
      }
    }
    const staged = stageToolAvailability(session, featureDisallowedTools(), toolDefinitionsFor);
    appliedKeys.set(session, { gates });
    const tools = staged || connectors;
    const merged = staged && connectors
      ? { added: [...staged.added, ...connectors.added], removed: [...staged.removed, ...connectors.removed] }
      : tools;
    return rebuilt || tools ? { rebuilt, ...(merged || {}) } : null;
  }

  // One reconcile per session at a time: a turn start and a surface read of
  // the same empty session share it.
  const inflight = new WeakMap();

  /** Turn start, any session kind: an empty session is rebuilt from current
   *  settings; a conversation keeps its prefix and takes moved tool gates
   *  live (stageToolAvailability). */
  function reconcileTurnSettings() {
    const session = getSession?.();
    if (!session?.id) return Promise.resolve(null);
    let running = inflight.get(session);
    if (!running) {
      running = reconcileSession(session).finally(() => inflight.delete(session));
      inflight.set(session, running);
    }
    return running;
  }

  /** A read of an empty session's surface or status: the same reconcile, so
   *  what is shown is what its first turn will send. A conversation (or a
   *  running turn) is left to its turn start. */
  function reconcileEmptySession() {
    const session = getSession?.();
    if (!session?.id || turnInFlight(session) || !conversationEmpty(session)) return Promise.resolve(null);
    return reconcileTurnSettings();
  }

  /** Sync: whether an empty session's surface lags the settings gates. */
  function emptySessionStale() {
    const session = getSession?.();
    if (!session?.id || turnInFlight(session) || !conversationEmpty(session)) return false;
    return appliedKeys.get(session)?.gates !== availabilityKey();
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
    if (typeof staged.stableContext === 'string') resetBp2StableContext(session, staged.stableContext);
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
    reconcileTurnSettings,
    reconcileEmptySession,
    emptySessionStale,
    noteToolAvailability,
    settingsReachCurrentSession,
    refreshEmptySessionToolPolicy,
    switchSessionWorkflow: switches.switchSessionWorkflow,
    switchSessionOrchestrationMode: switches.switchSessionOrchestrationMode,
    applyPendingSessionSwitches: switches.applyPendingSessionSwitches,
    refreshAgentProfile: profile.refreshAgentProfile,
    applyPendingAgentProfile: profile.applyPendingAgentProfile,
    currentAgents: profile.currentAgents,
  };
}
