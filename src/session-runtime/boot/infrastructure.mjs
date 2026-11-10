// Boot stage 4: MCP glue, the hook bus, self-update, the notification bus,
// session adoption, skills, and cwd/plugins.
import { performance } from 'node:perf_hooks';
import { existsSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { createStandaloneHookBus } from '../services/hook-bus.mjs';
import { attachSessionHooks } from '../session-hooks.mjs';
import { updateCurrentCwdOverride, writeLastSessionCwd } from '../../runtime/shared/user-cwd.mjs';
import { listRegisteredPlugins, pluginAdminStatus } from '../services/plugin-admin.mjs';
import { clean } from '../../runtime/agent/orchestrator/runtime-core/session-text.mjs';
import { countSkillFiles, pluginManifest } from '../../runtime/agent/orchestrator/runtime-core/plugin-mcp.mjs';
import { bootProfile } from '../boot-profile.mjs';
import { createMcpGlue } from '../mcp-glue.mjs';
import { createSelfUpdateController } from '../self-update.mjs';
import { createCompletionWakeScheduler, createNotificationBus } from '../notification-bus.mjs';
import { createSkillsApi } from '../skills-api.mjs';
import { createCwdPlugins } from '../cwd-plugins.mjs';
import { injectedMemoryAgentId } from '../services/memory-access.mjs';
import { listProjectsStrict } from '../../runtime/shared/projects.mjs';
import { isWithin } from '../../runtime/shared/worktrees/paths.mjs';
import { standaloneDataDir } from '../runtime-paths.mjs';
import { SessionAddressError, isAdmissionOpen, ownerLifecycle } from '../session-address.mjs';
import { syncSessionCompaction, usesInjectedConfig } from '../session-compaction-sync.mjs';
import { dataDirOf } from './shared.mjs';

export function wireInfrastructure(boot) {
  wireMcp(boot);
  wireHooks(boot);
  wireSelfUpdate(boot);
  wireNotifications(boot);
  boot.adoptSession = sessionAdopter(boot);
  wireSkills(boot);
  wireCwdPlugins(boot);
}

// MCP glue — config/currentCwd live-bound; connect state is owned here so
// teardown/reconnect paths still observe it (the factory mutates it in place).
function wireMcp(boot) {
  const { rt, mcpClient } = boot;
  const mcpState = {
    mcpFailures: [],
    mcpConnectGeneration: 0,
    mcpConnectInFlight: null,
  };
  const {
    mcpStatus,
    resolveMcpCatalog,
    resolveConfiguredMcpCatalog,
    pluginMcpServer,
    pluginMcpSummary,
    getMcpServerConfig,
    connectConfiguredMcp,
    awaitInitialMcpConnect,
    cancelMcpLogin,
    completeMcpLogin,
    normalizeMcpServerInput,
  } = createMcpGlue({
    mcpClient,
    getConfig: () => rt.config,
    getCurrentCwd: () => rt.currentCwd,
    getMcpScopeId: () => rt.mcpScopeId,
    // Plugin-declared servers are derived from the registry on every resolve.
    getPluginDataDir: () => dataDirOf(boot.cfgMod),
    listPlugins: () => listRegisteredPlugins({ dataDir: boot.cfgMod.getPluginData() }),
    state: mcpState,
  });
  Object.assign(boot, {
    mcpStatus,
    resolveMcpCatalog,
    resolveConfiguredMcpCatalog,
    pluginMcpServer,
    pluginMcpSummary,
    getMcpServerConfig,
    connectConfiguredMcp,
    awaitInitialMcpConnect,
    cancelMcpLogin,
    completeMcpLogin,
    normalizeMcpServerInput,
  });
}

function wireHooks(boot) {
  const { rt, cfgMod, mcpClient } = boot;
  const hooksStartedAt = performance.now();
  const hooks = createStandaloneHookBus({
    dataDir: cfgMod.getPluginData(),
    // `mcp_tool` hooks run against the SAME connected MCP servers this session
    // uses. Without this runner every configured mcp_tool hook reported
    // "handler type mcp_tool not configured", so the handler's timeout +
    // cancellation path never ran in production. The hook's abort signal is
    // forwarded so a timed-out hook cancels its tool call instead of leaving
    // it holding an admission slot.
    mcpToolRunner: async ({ name, args, signal }) => {
      if (typeof mcpClient?.executeMcpTool !== 'function') {
        throw new Error('MCP runtime is unavailable');
      }
      const result = await mcpClient.executeMcpTool(name, args ?? {}, {
        scopeId: rt.mcpScopeId,
        signal: signal || null,
        ownerKey: `hook:${name}`,
      });
      return typeof result === 'string' ? result : String(result?.result ?? '');
    },
  });
  hooks.emit('runtime:start', {
    cwd: rt.currentCwd,
    provider: rt.route.provider,
    model: rt.route.model,
    toolMode: rt.mode,
  });
  bootProfile('hooks:ready', { ms: (performance.now() - hooksStartedAt).toFixed(1) });
  boot.hooks = hooks;
}

// Self-update: registry check + background staging live in self-update.mjs;
// the facade only wires config/data-dir/notification access into it. The boot
// check is deferred past the constructor so a hanging registry request can
// never delay session boot.
function wireSelfUpdate(boot) {
  const { rt, cfgMod } = boot;
  const selfUpdate = createSelfUpdateController({
    getConfig: () => rt.config,
    getDataDir: () => dataDirOf(cfgMod),
    emitNotification: (...a) => boot.emitRuntimeNotification(...a),
  });
  selfUpdate.startBootCheck();
  boot.selfUpdate = selfUpdate;
}

// Notification fan-out (listener broadcast + pending-queue mirroring of
// terminal completions) lives in notification-bus.mjs. The turn api is built
// near the end of boot, while the bus must exist before it: late-bound.
function wireNotifications(boot) {
  const { rt, mgr, params, notificationListeners } = boot;
  const wakeQueuedCompletion = createCompletionWakeScheduler({
    getCurrentSessionId: () => rt.session?.id || rt.reservedSessionId || null,
    getTurnApi: () => boot.sessionTurnApi,
    getOwnerLifecycle: (sessionId) => ownerLifecycle(rt, sessionId),
    beforeWake: (sessionId) => boot.completionWakeGate?.(sessionId),
  });
  const {
    emitRuntimeNotification,
    notifySession,
    notifySessionUi,
    notifyFnForSession,
    notifySessionCompletion,
    subscribeRuntimeNotification,
    bindRuntimeNotificationSession,
    clearRuntimeNotifications,
  } = createNotificationBus({
    listeners: notificationListeners,
    mgr,
    getOwnerLifecycle: (sessionId) => ownerLifecycle(rt, sessionId),
    onCompletionQueued: params.autoWakeCompletions ? wakeQueuedCompletion : null,
  });
  Object.assign(boot, {
    emitRuntimeNotification,
    notifySession,
    notifySessionUi,
    notifyFnForSession,
    notifySessionCompletion,
    subscribeRuntimeNotification,
    bindRuntimeNotificationSession,
    clearRuntimeNotifications,
  });
}

// Adopt a session as this runtime's identity wherever setSession is injected
// (lifecycle resume, model-route swap, workflow swap, turn api). Binding here
// closes the restored-session hole: reserveSessionId binds fresh
// daemon-addressed sessions, but a daemon-boot RESUME reaches the runtime
// with listeners subscribed before any session id existed — completion
// notifications then emitted into an empty session bucket and the transcript
// card never rendered while the queued model twin worked.
export function sessionAdopter(boot) {
  const { rt } = boot;
  return (v) => {
    if (v?.id) {
      // Late async adoption (clear/rewind/compaction/turn settle/resume) must
      // never revive a fenced or closed conversation, nor retarget the
      // durable address to another id.
      if (!isAdmissionOpen(rt)) return;
      if (rt.addressedSessionId && rt.addressedSessionId !== v.id) {
        throw new SessionAddressError(
          `runtime is addressed as ${rt.addressedSessionId}; refusing to adopt ${v.id}`,
          rt.addressedSessionId
        );
      }
    }
    rt.session = v;
    // A resumed or swapped-in session keeps the compaction it was saved with
    // unless it follows the current global settings (not on an injected config).
    if (v?.id && !usesInjectedConfig(boot.params)) syncSessionCompaction(v, rt.config);
    // The PreToolUse/PostToolUse bridge is a non-enumerable property that
    // neither the store nor a resumed record carries: every session installed
    // here (create, resume, route swap, clear, the manager's copy) gets it, so
    // hook rules apply to all of them, not only to freshly created sessions.
    if (v?.id && typeof v.beforeToolHook !== 'function') {
      attachSessionHooks(v, {
        hooks: boot.hooks,
        hookCommonPayload: (...a) => boot.hookCommonPayload(...a),
        getCwd: () => rt.currentCwd,
      });
    }
    if (v?.id) {
      rt.desktopSession = v.desktopSession || null;
      // Bind every adopted session, including a cold resume and a session
      // materialized before ask(). The shared tool executor must never fall
      // back to changing only a detached session object's cwd.
      // The Lead's own `session set-project` call: the Project switch
      // authority, tolerating the calling turn.
      Object.defineProperty(v, '_applyResolvedCwdForCaller', {
        value: (nextCwd) => {
          if (rt.session?.id !== v.id) throw new Error('cwd: the calling session is no longer active');
          return boot.workspaceApi.switchProject(nextCwd, { ownTurn: true });
        },
        enumerable: false,
        configurable: true,
        writable: true,
      });
      rt.reservedSessionId = null;
      boot.bindRuntimeNotificationSession(v.id);
      boot.goalRuntime?.watchSession(v.id);
    }
  };
}

// Skill listing/loading/creation lives in skills-api.mjs; boot only supplies
// the mutable cwd, the context module and the live tool surface.
function wireSkills(boot) {
  const { rt, contextMod } = boot;
  const {
    skillsStatus,
    skillContent,
    skillToolContent,
    addGlobalSkill,
    saveSkillDocument,
    removeGlobalSkill,
    invalidateSkills,
  } = createSkillsApi({
    contextMod,
    getCwd: () => rt.currentCwd,
    getTools: () => {
      const surface = boot.activeToolSurface();
      return [
        ...new Map(
          [
            ...(surface?.tools || []),
            ...(surface?.deferredToolCatalog || []),
            ...(surface?.deferredLateToolCatalog || []),
          ].map((tool) => [tool.name, tool])
        ).values(),
      ];
    },
  });
  Object.assign(boot, {
    skillsStatus,
    skillContent,
    skillToolContent,
    addGlobalSkill,
    saveSkillDocument,
    removeGlobalSkill,
    invalidateSkills,
  });
}

// cwd resolution/apply + plugins-status + core-memory context
// (cwd-plugins.mjs). Boot keeps ownership of the mutable currentCwd/session/
// config via getter/setter injection and passes the later-defined callbacks
// (prewarm/tool-surface) through `boot`.
function wireCwdPlugins(boot) {
  const { rt, cfgMod, hooks, hookCommonPayload, tunables } = boot;
  const { resolveCwdPath, applyResolvedCwd, pluginsStatus, loadCoreMemoryContext } = createCwdPlugins({
    getCurrentCwd: () => rt.currentCwd,
    getMemoryAgentId: () =>
      injectedMemoryAgentId({ session: rt.session, sessionId: rt.reservedSessionId, profile: rt.sessionProfile }),
    setCurrentCwd: (next) => {
      rt.currentCwd = next;
    },
    getConfig: () => rt.config,
    getSession: () => rt.session,
    getDesktopSession: () => rt.desktopSession,
    setDesktopSession: (next) => {
      rt.desktopSession = next;
    },
    isCodeGraphPrewarmLazy: () => tunables.codeGraphPrewarmLazy,
    isCodeGraphFirstTurnPrewarmDone: () => rt.codeGraphFirstTurnPrewarmDone,
    getCodeGraphPrewarmDelayMs: () => tunables.codeGraphPrewarmDelayMs,
    scheduleCodeGraphPrewarm: (...a) => boot.scheduleCodeGraphPrewarm(...a),
    hooks,
    hookCommonPayload: (...a) => hookCommonPayload(...a),
    bootProfile,
    listRegisteredPlugins,
    pluginAdminStatus,
    pluginManifest,
    pluginMcpSummary: boot.pluginMcpSummary,
    // Plugin MCP servers without a declared cwd follow this runtime's cwd:
    // reconnect just those (and refresh advertised roots) in place.
    onCwdChanged: () => {
      void boot.connectConfiguredMcp({ reconcile: true }).catch(() => {});
    },
    isProjectFolder: (cwd) => listProjectsStrict().some((project) => isWithin(project.path, cwd)),
    countSkillFiles,
    writeLastSessionCwd,
    updateCurrentCwdOverride,
    clean,
    resolve,
    statSync,
    existsSync,
    cfgMod,
    STANDALONE_DATA_DIR: standaloneDataDir(),
  });
  Object.assign(boot, { resolveCwdPath, applyResolvedCwd, pluginsStatus, loadCoreMemoryContext });
}
