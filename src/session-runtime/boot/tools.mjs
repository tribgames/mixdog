// Boot stage 5: the agent tool, goal runtime, channel worker, tool
// definitions and lead tool surface, context status, the setup tool and the
// internal-tool executor, then the MCP connect kick.
import { performance } from 'node:perf_hooks';
import { createStandaloneAgent } from '../../standalone/agent-tool.mjs';
import { createStandaloneChannelWorker } from '../../standalone/channel-worker.mjs';
import {
  channelNotificationModelContent,
  channelNotificationSessionId,
} from '../../runtime/shared/channel-notification-routing.mjs';
import { CHANNEL_NOTIFICATION_METHOD } from '../../standalone/channel-session-router.mjs';
import { envFlag } from '../../runtime/shared/env.mjs';
// Desktop-app bridges: tiny fs/fetch clients, so a static import adds no
// meaningful boot cost. The tools themselves are gated per session by the
// sync bridge-availability probes in runtime-feature-gates.mjs (headless runs
// never see them); execution lives in internal-tool-executor.mjs.
import { TOOL_DEFS as BROWSER_BRIDGE_TOOL_DEFS } from '../../runtime/browser-bridge/tool-defs.mjs';
import { TOOL_DEFS as COMPUTER_BRIDGE_TOOL_DEFS } from '../../runtime/computer-bridge/tool-defs.mjs';
import { TOOL_DEFS as OFFICE_TOOL_DEFS } from '../../runtime/office/tool-defs.mjs';
import { TOOL_DEFS as MEDIA_TOOL_DEFS } from '../../runtime/media/tool-defs.mjs';
import { TOOL_DEFS as TIDY_TOOL_DEFS } from '../../runtime/tidy/tool-defs.mjs';
import { SETUP_TOOL_DEFS } from '../setup-tool/tool-defs.mjs';
import { createSetupToolExecutor } from '../setup-tool/executor.mjs';
import { bootProfile } from '../boot-profile.mjs';
import { createRoutedAgentTool } from '../agent-tool-routing.mjs';
import { createGoalRuntime } from '../goal-runtime.mjs';
import { collectStandaloneToolDefs } from '../tool-defs.mjs';
import { createToolSurface } from '../tool-surface.mjs';
import { contextStatusForSession, createContextStatus } from '../context-status.mjs';
import { createInternalToolExecutor } from '../internal-tool-executor.mjs';
import { STANDALONE_ROOT, STANDALONE_DATA_DIR } from '../runtime-paths.mjs';
import { dataDirOf, workflowHelpers } from './shared.mjs';

export function wireTools(boot) {
  wireAgent(boot);
  wireGoalRuntime(boot);
  wireChannels(boot);
  wireToolSurface(boot);
  wireContextStatus(boot);
  wireInternalTools(boot);
  void boot
    .connectConfiguredMcp()
    .then((status) =>
      bootProfile('mcp:ready', {
        connected: Number(status?.connectedCount || 0),
        failed: Number(status?.failedCount || 0),
      })
    )
    .catch((error) => bootProfile('mcp:failed', { error: error?.message || String(error) }));
  boot.reloadChannelsSoon = () => {
    boot.channels.execute('reload_config', {}).catch(() => {});
  };
}

function wireAgent(boot) {
  const { rt, params, cfgMod, reg, mgr, hooks, hookCommonPayload, awaitKeychainPrewarm, notifySessionCompletion } = boot;
  const agentToolStartedAt = performance.now();
  const agentTool = createStandaloneAgent({
    cfgMod,
    reg,
    mgr,
    dataDir: cfgMod.getPluginData(),
    cwd: params.cwd,
    mcpScopeId: rt.mcpScopeId,
    awaitKeychainPrewarm,
    isKeychainPrewarmReady: () => rt.keychainPrewarmWaitDone,
    notifySessionCompletion,
    // SubagentStart/SubagentStop: bridge internal worker spawn/finish to the
    // standard hook bus. agent_type is passed top-level via hookCommonPayload.
    // Best-effort.
    onSubagentEvent: (phase, info = {}) => {
      try {
        const event = phase === 'stop' ? 'SubagentStop' : 'SubagentStart';
        void hooks.dispatch(
          event,
          hookCommonPayload({
            session_id: info?.session_id || null,
            agent_type: info?.agent_type || null,
          })
        );
      } catch {
        /* best-effort: subagent hook must never affect worker lifecycle */
      }
    },
  });
  const { routedAgentTool, agentStatusState } = createRoutedAgentTool({
    rt,
    agentTool,
    executeAgentControl: params.executeAgentControl,
  });
  bootProfile('agent:ready', { ms: (performance.now() - agentToolStartedAt).toFixed(1) });
  Object.assign(boot, { agentTool, routedAgentTool, agentStatusState });
}

function wireGoalRuntime(boot) {
  const { rt, cfgMod } = boot;
  const goalRuntime = createGoalRuntime({
    dataDir: dataDirOf(cfgMod),
    generateTitle: async (source, options = {}) => {
      const { generateSessionTitle } = await import('../../runtime/agent/orchestrator/agent-runtime/title-completion.mjs');
      return generateSessionTitle(source, options);
    },
  });
  if (rt.session?.id || rt.reservedSessionId) {
    goalRuntime.watchSession(rt.session?.id || rt.reservedSessionId);
  }
  boot.goalRuntime = goalRuntime;
}

function wireChannels(boot) {
  const { rt, params, cfgMod, notifySession } = boot;
  const channelsStartedAt = performance.now();
  boot.channels = createStandaloneChannelWorker({
    rootDir: STANDALONE_ROOT,
    dataDir: cfgMod.getPluginData(),
    cwd: params.cwd,
    // A session runtime can outlive the process that originally spawned the
    // daemon. Bind channel liveness to this runtime host, never that stale
    // inherited supervisor PID.
    leadPid: process.pid,
    // Sessions are lazy: a resumed session lives as a reserved id until its
    // first turn. Registering with a null id would make the daemon skip the
    // session-pinned channel-link restore for exactly the session that owns it.
    getSessionId: () => rt.session?.id || rt.reservedSessionId || null,
    onNotify: (msg) => {
      if (msg?.method !== CHANNEL_NOTIFICATION_METHOD) return;
      const p = msg?.params && typeof msg.params === 'object' ? msg.params : {};
      const meta = p.meta && typeof p.meta === 'object' ? p.meta : {};
      const content = channelNotificationModelContent(p);
      if (!content) return;
      notifySession(channelNotificationSessionId(rt.session, rt.reservedSessionId), content, meta);
    },
  });
  bootProfile('channels:worker-ready', { ms: (performance.now() - channelsStartedAt).toFixed(1) });
}

// Tool definitions, then the lead tool surface (workflow-gated agent tool,
// pre-session preview, deferred replay) from tool-surface.mjs.
function wireToolSurface(boot) {
  const { rt, cfgMod, mgr, goalRuntime, agentTool, channels, featureDisallowedTools } = boot;
  const toolsStartedAt = performance.now();
  const { standaloneTools, internalToolDefs, agentToolNames } = collectStandaloneToolDefs({
    webSearchToolDefs: boot.webSearchToolDefs,
    memoryToolDefs: boot.memoryToolDefs,
    channelToolDefs: boot.channelToolDefs,
    codeGraphToolDefs: boot.codeGraphToolDefs,
    browserToolDefs: BROWSER_BRIDGE_TOOL_DEFS,
    computerToolDefs: COMPUTER_BRIDGE_TOOL_DEFS,
    officeToolDefs: OFFICE_TOOL_DEFS,
    mediaToolDefs: MEDIA_TOOL_DEFS,
    tidyToolDefs: TIDY_TOOL_DEFS,
    setupToolDefs: SETUP_TOOL_DEFS,
    goalTools: goalRuntime.tools,
    agentTools: agentTool.tools,
    isChannelTool: (name) => channels.isChannelTool(name),
    skillToolEnabled: !envFlag('MIXDOG_DISABLE_SKILLS'),
  });
  bootProfile('tools:ready', { ms: (performance.now() - toolsStartedAt).toFixed(1), count: standaloneTools.length });
  const { modelStandaloneTools, invalidatePreSessionToolSurface, activeToolSurface, applyPreSessionToolSelection } =
    createToolSurface({
      mgr,
      mode: rt.mode,
      standaloneTools,
      agentToolNames,
      getSession: () => rt.session,
      getRoute: () => rt.route,
      getConfig: () => rt.config,
      getToolProfile: () => rt.toolProfile,
      getMcpScopeId: () => rt.mcpScopeId,
      getCurrentCwd: () => rt.currentCwd,
      cfgMod,
      delegatableAgentIds: workflowHelpers.delegatableAgentIds,
      dataDir: STANDALONE_DATA_DIR,
      getFeatureDisallowedTools: featureDisallowedTools,
    });
  Object.assign(boot, {
    standaloneTools,
    internalToolDefs,
    agentToolNames,
    modelStandaloneTools,
    invalidatePreSessionToolSurface,
    activeToolSurface,
    applyPreSessionToolSelection,
  });
}

function wireContextStatus(boot) {
  const { rt } = boot;
  const { contextStatus: computeContextStatus, invalidateContextStatusCache } = createContextStatus({
    getSession: () => rt.session,
    getRoute: () => rt.route,
    getCurrentCwd: () => rt.currentCwd,
    getMcpScopeId: () => rt.mcpScopeId,
    getMode: () => rt.mode,
  });
  Object.assign(boot, {
    computeContextStatus,
    invalidateContextStatusCache,
    computeContextStatusForSession: (session) =>
      contextStatusForSession(session, {
        getMode: () => rt.mode,
        fallbackCwd: rt.currentCwd,
      }),
  });
}

// The setup tool drives the same facade the settings UIs use. The facade is
// the object boot returns, so it is read lazily through `boot` on each call.
function wireInternalTools(boot) {
  const { rt, internalTools, notifySessionUi } = boot;
  const setupTool = createSetupToolExecutor({
    getApi: () => boot.runtimeFacade,
    getConfig: () => rt.config,
    notifySessionUi,
    getSessionId: () => rt.session?.id || rt.reservedSessionId || null,
    flushSettings: () => boot.flushAllConfigSavesAsync({ requireSaved: true }),
  });
  const disposeInternalTools = internalTools.setInternalToolsProvider({
    scopeId: rt.mcpScopeId,
    tools: boot.internalToolDefs,
    executor: createInternalToolExecutor({
      rt,
      channels: boot.channels,
      goalRuntime: boot.goalRuntime,
      agentTool: boot.routedAgentTool,
      setupTool,
      webSearchEnabled: boot.webSearchEnabled,
      memoryToolsEnabled: boot.memoryToolsEnabledFn,
      officeToolsEnabled: boot.officeToolsEnabledFn,
      mediaToolEnabled: boot.mediaToolEnabledFn,
      tidyToolEnabled: boot.tidyToolEnabledFn,
      channelsEnabled: boot.channelsEnabled,
      getWebSearchModule: boot.getWebSearchModule,
      getMemoryModule: boot.getMemoryModule,
      getCodeGraphModule: boot.getCodeGraphModule,
      notifyFnForSession: boot.notifyFnForSession,
      // Late-bound: createNativeWebSearch is constructed after this
      // registration; the executor only runs once a tool call arrives.
      runNativeWebSearch: (...a) => boot.runNativeWebSearch(...a),
      activeToolSurface: boot.activeToolSurface,
      mcpStatus: boot.mcpStatus,
      applyResolvedCwd: boot.applyResolvedCwd,
      skillToolContent: boot.skillToolContent,
    }),
  });
  Object.assign(boot, { setupTool, disposeInternalTools });
}
