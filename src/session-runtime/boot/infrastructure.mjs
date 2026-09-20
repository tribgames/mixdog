// Boot stage 4: MCP glue, the hook bus, self-update, the notification bus,
// session adoption, skills, and cwd/plugins.
import { performance } from 'node:perf_hooks';
import { existsSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { createStandaloneHookBus } from '../../standalone/hook-bus.mjs';
import { updateCurrentCwdOverride, writeLastSessionCwd } from '../../runtime/shared/user-cwd.mjs';
import { listRegisteredPlugins, pluginAdminStatus } from '../../standalone/plugin-admin.mjs';
import { clean } from '../session-text.mjs';
import { countSkillFiles, mcpScriptForPlugin, pluginManifest, pluginMcpServerName } from '../plugin-mcp.mjs';
import { bootProfile } from '../boot-profile.mjs';
import { createMcpGlue } from '../mcp-glue.mjs';
import { createSelfUpdateController } from '../self-update.mjs';
import { createCompletionWakeScheduler, createNotificationBus } from '../notification-bus.mjs';
import { createSkillsApi } from '../skills-api.mjs';
import { createCwdPlugins } from '../cwd-plugins.mjs';
import { STANDALONE_DATA_DIR } from '../runtime-paths.mjs';
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
  const { mcpStatus, getMcpServerConfig, connectConfiguredMcp, awaitInitialMcpConnect, normalizeMcpServerInput } =
    createMcpGlue({
      mcpClient,
      getConfig: () => rt.config,
      getCurrentCwd: () => rt.currentCwd,
      getMcpScopeId: () => rt.mcpScopeId,
      getDesktopSession: () => rt.desktopSession,
      setDesktopSession: (v) => {
        rt.desktopSession = v;
      },
      state: mcpState,
    });
  Object.assign(boot, {
    mcpStatus,
    getMcpServerConfig,
    connectConfiguredMcp,
    awaitInitialMcpConnect,
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
function sessionAdopter(boot) {
  const { rt } = boot;
  return (v) => {
    rt.session = v;
    if (v?.id) {
      rt.desktopSession = v.desktopSession || null;
      // Bind every adopted session, including a cold resume and a session
      // materialized before ask(). The shared tool executor must never fall
      // back to changing only a detached session object's cwd.
      Object.defineProperty(v, '_applyResolvedCwdForCaller', {
        value: (nextCwd) => {
          if (rt.session?.id !== v.id) throw new Error('cwd: the calling session is no longer active');
          return boot.applyResolvedCwd(nextCwd, { persistProjectSelection: true });
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
  const { skillsStatus, skillContent, skillToolContent, addGlobalSkill, saveSkillDocument, invalidateSkills } =
    createSkillsApi({
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
    invalidateSkills,
  });
}

// cwd resolution/apply + plugins-status + core-memory context
// (cwd-plugins.mjs). Boot keeps ownership of the mutable currentCwd/session/
// config via getter/setter injection and passes the later-defined callbacks
// (prewarm/tool-surface) through `boot`.
function wireCwdPlugins(boot) {
  const { rt, cfgMod, hooks, hookCommonPayload, getMemoryModule, connectConfiguredMcp, tunables } = boot;
  const { resolveCwdPath, applyResolvedCwd, pluginsStatus, loadCoreMemoryContext } = createCwdPlugins({
    getCurrentCwd: () => rt.currentCwd,
    setCurrentCwd: (next) => {
      rt.currentCwd = next;
    },
    getConfig: () => rt.config,
    getSession: () => rt.session,
    getDesktopSession: () => rt.desktopSession,
    setDesktopSession: (next) => {
      rt.desktopSession = next;
    },
    getRoute: () => rt.route,
    isCodeGraphPrewarmLazy: () => tunables.codeGraphPrewarmLazy,
    isCodeGraphFirstTurnPrewarmDone: () => rt.codeGraphFirstTurnPrewarmDone,
    getCodeGraphPrewarmDelayMs: () => tunables.codeGraphPrewarmDelayMs,
    connectConfiguredMcp,
    invalidatePreSessionToolSurface: (...a) => boot.invalidatePreSessionToolSurface(...a),
    scheduleCodeGraphPrewarm: (...a) => boot.scheduleCodeGraphPrewarm(...a),
    hooks,
    hookCommonPayload: (...a) => hookCommonPayload(...a),
    bootProfile,
    getMemoryModule: (...a) => getMemoryModule(...a),
    listRegisteredPlugins,
    pluginAdminStatus,
    pluginManifest,
    pluginMcpServerName,
    mcpScriptForPlugin,
    countSkillFiles,
    writeLastSessionCwd,
    updateCurrentCwdOverride,
    clean,
    resolve,
    statSync,
    existsSync,
    cfgMod,
    STANDALONE_DATA_DIR,
  });
  Object.assign(boot, { resolveCwdPath, applyResolvedCwd, pluginsStatus, loadCoreMemoryContext });
}
