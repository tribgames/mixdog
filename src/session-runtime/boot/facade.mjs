// Boot stage 9: the runtime facade — the object createMixdogSessionRuntime
// returns and the setup tool/settings UIs drive.
import { configuredOrchestrationMode, sessionOrchestrationMode } from '../../runtime/shared/orchestration.mjs';
import { normalizeSystemShellConfig } from '../config-helpers.mjs';
import { webSearchRouteOrDefault } from '../workflow.mjs';
import { createRuntimeFacade } from '../runtime-facade.mjs';
import { bootProfile } from '../boot-profile.mjs';
import { dataDirOf, workflowHelpers } from './shared.mjs';

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
      ...boot.runtimeReviewApi,
    },
    goalApi: boot.goalFacadeApi,
    trailingApi: {
      ...boot.lifecycleApi,
      ...boot.resourceApi,
      ...boot.modelRouteApi,
      ...boot.workflowAgentsApi,
      ...boot.sessionTurnApi,
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
  rt.reservedSessionId = id;
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
// through the process-wide shared caches, so no per-session file I/O.
function currentWorkflow(boot) {
  const { rt, cfgMod } = boot;
  const active = workflowHelpers.activeWorkflowSummary(rt.config, dataDirOf(cfgMod));
  if (rt.session?.workflow && typeof rt.session.workflow === 'object') {
    const current = rt.session.workflow;
    return current?.id && active?.id && current.id !== active.id
      ? { ...active, currentSession: current, appliedToCurrentSession: false }
      : active;
  }
  return active;
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
      rt.session?.id ? sessionOrchestrationMode(rt.session) : configuredOrchestrationMode(rt.config),
    getOutputStyle: () => boot.getOutputStyleStatusCached().current,
    getContextStatus: boot.computeContextStatus,
    getContextStatusForSession: boot.computeContextStatusForSession,
    renameSessionTitle: (sessionId, title) => mgr.updateSessionManualTitle(sessionId, title),
  };
}
