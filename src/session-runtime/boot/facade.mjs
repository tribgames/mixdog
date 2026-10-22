// Boot stage 9: the runtime facade — the object createMixdogSessionRuntime
// returns and the setup tool/settings UIs drive.
import { configuredOrchestrationMode, sessionOrchestrationMode } from '../../runtime/shared/orchestration.mjs';
import { normalizeSystemShellConfig } from '../../runtime/agent/orchestrator/runtime-core/config-helpers.mjs';
import { webSearchRouteOrDefault } from '../../runtime/agent/orchestrator/runtime-core/workflow.mjs';
import { createRuntimeFacade } from '../runtime-facade.mjs';
import { bootProfile } from '../boot-profile.mjs';
import { assertAdmissionOpen, bindSessionAddress } from '../session-address.mjs';
import { dataDirOf, workflowHelpers } from './shared.mjs';
import { publicWorkspaceMethods } from '../workspace/transitions.mjs';

export function buildFacade(boot) {
  const { rt, setupTool } = boot;
  boot.runtimeFacade = createRuntimeFacade({
    state: rt,
    leadingApi: {
      ...boot.settingsApi,
      ...boot.channelConfigApi,
      ...boot.providerAuthApi,
      ...boot.usageStatsApi,
      ...boot.mediaApi,
      ...boot.conversationImportApi,
      ...boot.runtimeReviewApi,
    },
    goalApi: boot.goalFacadeApi,
    trailingApi: {
      ...boot.lifecycleApi,
      ...boot.resourceApi,
      ...boot.modelRouteApi,
      ...boot.workflowAgentsApi,
      ...boot.sessionTurnApi,
      // A surface registers its idle auto-clear here; returns an unregister.
      setCompletionWakeGate: (gate) => {
        const next = typeof gate === 'function' ? gate : null;
        boot.completionWakeGate = next;
        return () => {
          if (boot.completionWakeGate === next) boot.completionWakeGate = null;
        };
      },
      applyWorkspaceTransition: boot.workspaceApi.applyWorkspaceTransition,
      getWorkspace: boot.workspaceApi.getWorkspace,
      getLiveWorkspace: boot.workspaceApi.getLiveWorkspace,
      getBranchMenu: boot.workspaceApi.getBranchMenu,
      getProjectBranchMenu: boot.workspaceApi.getProjectBranchMenu,
      selectProjectBranch: boot.workspaceApi.selectProjectBranch,
      mergeProjectBranch: boot.workspaceApi.mergeProjectBranch,
      inspectProjectBranch: boot.workspaceApi.inspectProjectBranch,
      manageProjectBranch: boot.workspaceApi.manageProjectBranch,
      // selectBranch, requestWorktree, mergeWorkspace, removeWorktree,
      // listWorktrees, pruneWorktrees: the public arity only, so no external
      // caller (desktop IPC, the daemon's configure lane) reaches `ownTurn`.
      ...publicWorkspaceMethods(boot.workspaceApi),
      onWorktreeSetup: boot.workspaceApi.onWorktreeSetup,
      claimSetupRequest: setupTool.claimSetupRequest,
      isSetupRequestActive: setupTool.isSetupRequestActive,
      completeSetupRequest: setupTool.completeSetupRequest,
    },
    deliverToolCompletion: boot.notifySessionCompletion,
    reserveSessionId: (id) => reserveSessionId(boot, id),
    ...facadeGetters(boot),
  });
  return boot.runtimeFacade;
}

function reserveSessionId(boot, id) {
  const { rt } = boot;
  if (rt.session?.id && rt.session.id !== id) {
    throw new Error(`session ${rt.session.id} is already materialized`);
  }
  assertAdmissionOpen(rt);
  bindSessionAddress(rt, id);
  if (!rt.session?.id) rt.reservedSessionId = id;
  boot.bindRuntimeNotificationSession(id);
  boot.goalRuntime?.watchSession(id);
  // Reservation is the earliest safe point to prepare keychain, memory,
  // provider metadata, hooks, and the provider transport. This starts no
  // model response and therefore incurs no inference/token usage. The first
  // submit joins this single-flight promise instead of paying cold setup.
  void boot.createCurrentSession('reservation').catch((error) => {
    bootProfile('session:reservation-prewarm-failed', {
      error: error?.message || String(error),
    });
  });
}

// Every session's 2 s status pulse lands here; activeWorkflowSummary reads
// through the process-wide shared caches, so no per-session file I/O. A
// session presents its own workflow (set at creation, or switched in it);
// the configured one is the default for new sessions.
function currentWorkflow(boot) {
  const { rt, cfgMod } = boot;
  // A switch chosen while a turn runs shows at once; it applies next turn.
  const pending = rt.session?.pendingWorkflowId;
  if (pending) {
    return workflowHelpers.activeWorkflowSummary(
      { ...rt.config, workflow: { ...(rt.config?.workflow || {}), active: pending } },
      dataDirOf(cfgMod)
    );
  }
  const active = workflowHelpers.activeWorkflowSummary(rt.config, dataDirOf(cfgMod));
  const current = rt.session?.workflow;
  return current?.id && active?.id && current.id !== active.id ? current : active;
}

function facadeGetters(boot) {
  const { rt, settingsApi, mgr } = boot;
  return {
    getAutoClear: () => settingsApi.getAutoClear(),
    getSystemShell: () => normalizeSystemShellConfig(rt.config.shell),
    getWebSearchRoute: () => {
      rt.webSearchRoute = webSearchRouteOrDefault(rt.config.webSearchRoute, rt.webSearchRoute);
      return rt.webSearchRoute;
    },
    getWorkflow: () => currentWorkflow(boot),
    getOrchestrationMode: () =>
      rt.session?.id
        ? (rt.session.pendingOrchestrationMode ?? sessionOrchestrationMode(rt.session))
        : configuredOrchestrationMode(rt.config),
    getOutputStyle: () => boot.getOutputStyleStatusCached().current,
    getContextStatus: boot.computeContextStatus,
    getContextStatusForSession: boot.computeContextStatusForSession,
    renameSessionTitle: (sessionId, title) => mgr.updateSessionManualTitle(sessionId, title),
  };
}
