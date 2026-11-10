/**
 * extensions.mjs — the session object's extension surface: MCP servers,
 * skills, plugins, hook rules, and the context/model-message reads. Every
 * mutation republishes the route + context stats, since it changes the tool
 * surface the next turn sees.
 */
import { createApiHelpers } from './shared.mjs';

export function createSessionExtensionsApi(bag) {
  const { runtime, getState, set, pushNotice, resetStatsAndSyncContext, routeState } = bag;
  const { withCommandLock, refreshRouteStats } = createApiHelpers({
    getState,
    set,
    resetStatsAndSyncContext,
    routeState,
  });
  // One locked runtime mutation, then republish and announce it. A refused
  // change throws so a caller never reports a skipped write as saved.
  const lockedChange = (call, notice) =>
    withCommandLock(
      async (...args) => {
        const result = await call(...args);
        refreshRouteStats();
        const [text, level = 'info'] = notice(result, ...args);
        pushNotice(text, level);
        return result;
      },
      { busyError: 'Another command is still running; try again when it finishes.' }
    );
  const pluginLabel = (result, plugin) => result?.plugin?.title || result?.plugin?.name || plugin?.name || plugin;
  // MCP OAuth sign-in methods the runtime must implement (no silent fallback).
  const mcpOAuth =
    (name) =>
    (...args) => {
      if (typeof runtime[name] !== 'function') throw new Error('MCP sign-in is unavailable');
      return runtime[name](...args);
    };

  return {
    mcpStatus: () => {
      return runtime.mcpStatus?.() || { servers: [], configuredCount: 0, connectedCount: 0, failedCount: 0 };
    },
    getMcpServerConfig: (name) => {
      return runtime.getMcpServerConfig?.(name);
    },
    reconnectMcp: lockedChange(
      () => runtime.reconnectMcp?.(),
      (status) => [
        `mcp reconnect: ${status?.connectedCount || 0}/${status?.configuredCount || 0} connected${status?.failedCount ? ` - ${status.failedCount} failed` : ''}`,
        status?.failedCount ? 'warn' : 'info',
      ]
    ),
    addMcpServer: lockedChange(
      (input) => runtime.addMcpServer?.(input),
      (result, input) => [`mcp added: ${result?.name || input?.name || 'server'}`]
    ),
    // No command lock: the runtime serializes adds per connector
    // (oneAddAtATime), so concurrent adds each succeed with their own key.
    addConnectorAccount: async (input) => {
      const result = await runtime.addConnectorAccount?.(input);
      refreshRouteStats();
      pushNotice(`mcp account added: ${result?.account || input?.connector || 'connector'}`);
      return result;
    },
    saveMcpServer: lockedChange(
      (input) => runtime.saveMcpServer?.(input),
      (result, input) => [`mcp saved: ${result?.name || input?.name || 'server'}`]
    ),
    removeMcpServer: lockedChange(
      (name) => runtime.removeMcpServer?.(name),
      (_status, name) => [`mcp removed: ${name}`]
    ),
    // Explicit OAuth sign-in: no command lock, the flow runs on the server's
    // own connect lane and the caller polls its status. The caller (TUI app)
    // owns the sign-in completion notice; the store never posts one.
    beginMcpOAuthLogin: async (name, options) => {
      const result = await mcpOAuth('beginMcpOAuthLogin')(name, options);
      if (result?.state === 'pending') pushNotice(`mcp sign-in started: ${name}`, 'info');
      return result;
    },
    getMcpOAuthLoginStatus: mcpOAuth('getMcpOAuthLoginStatus'),
    cancelMcpOAuthLogin: mcpOAuth('cancelMcpOAuthLogin'),
    completeMcpOAuthLogin: mcpOAuth('completeMcpOAuthLogin'),
    signOutMcpServer: lockedChange(mcpOAuth('signOutMcpServer'), (_status, name) => [`mcp signed out: ${name}`]),
    probeMcpServerAuth: mcpOAuth('probeMcpServerAuth'),
    setMcpServerEnabled: async (name, enabled) => {
      // No global commandBusy: the runtime adopts config synchronously and
      // serializes the heavy connect/close/recreate per server name, so rapid
      // re-toggles converge instead of being dropped. This awaits the
      // background chain purely to settle the picker on completion/failure.
      const status = await runtime.setMcpServerEnabled?.(name, enabled);
      // The context re-estimate is a full-transcript token count; defer it off
      // the interactive frame so it never runs inside the toggle key handler.
      setImmediate(refreshRouteStats);
      // A connect failure resolves as a status object (not a throw), so inspect
      // this server's row before claiming success: enabling can fail on spawn/
      // handshake. Disabling never spawns, so it is always a success.
      const row = status?.servers?.find((s) => s.name === name);
      if (enabled && row && (row.status === 'failed' || row.error)) {
        pushNotice(`mcp enable failed: ${name}${row.error ? ` — ${row.error}` : ''}`, 'error');
      } else if (enabled && row?.authRequired) {
        pushNotice(`mcp enabled: ${name} — sign-in required`, 'warn');
      } else {
        pushNotice(`mcp ${enabled ? 'enabled' : 'disabled'}: ${name}`, 'info');
      }
      return status;
    },
    getDisabledSkills: () => runtime.getDisabledSkills?.() || { disabled: [] },
    setDisabledSkills: (disabled) => runtime.setDisabledSkills?.(disabled) || { disabled: [] },
    setExtensionScope: async (kind, name, projects = null) => {
      if (typeof runtime.setExtensionScope !== 'function') {
        throw new Error('Extension scope is unavailable');
      }
      return await runtime.setExtensionScope(kind, name, projects);
    },
    // `options.cwd`: list and scope skills for that folder instead of this
    // session's (the desktop resolves a new-task draft's Project to it).
    skillsStatus: (options) => {
      return runtime.skillsStatus?.(options) || { cwd: getState().cwd, count: 0, skills: [] };
    },
    skillContent: (name) => {
      return runtime.skillContent?.(name);
    },
    addSkill: lockedChange(
      (input) => runtime.addSkill?.(input),
      (result, input) => [`skill added: ${result?.skill?.name || input?.name || 'skill'}`]
    ),
    saveSkill: lockedChange(
      (input) => runtime.saveSkill?.(input),
      (result, input) => [`skill saved: ${result?.skill?.name || input?.name || 'skill'}`]
    ),
    removeSkill: lockedChange(
      (input) => runtime.removeSkill?.(input),
      (result, input) => [`skill removed: ${result?.skill?.name || input?.name || 'skill'}`]
    ),
    reloadSkills: lockedChange(
      () => runtime.reloadSkills?.(),
      (status) => [`skills reload: ${status?.count || 0} available`]
    ),
    pluginsStatus: () => {
      return runtime.pluginsStatus?.() || { count: 0, plugins: [] };
    },
    reloadPlugins: lockedChange(
      () => runtime.reloadPlugins?.(),
      (status) => [`plugins reload: ${status?.count || 0} detected`]
    ),
    addPlugin: lockedChange(
      (source) => runtime.addPlugin?.(source),
      (result, source) => [`plugin added: ${result?.plugin?.title || result?.plugin?.name || source}`]
    ),
    updatePlugin: lockedChange(
      (plugin) => runtime.updatePlugin?.(plugin),
      (result, plugin) => [`plugin updated: ${pluginLabel(result, plugin)}`]
    ),
    setPluginEnabled: lockedChange(
      (plugin, enabled) => runtime.setPluginEnabled?.(plugin, enabled),
      (result, plugin, enabled) => [
        `plugin ${enabled === false ? 'disabled' : 'enabled'}: ${pluginLabel(result, plugin)}`,
      ]
    ),
    removePlugin: lockedChange(
      (plugin) => runtime.removePlugin?.(plugin),
      (result, plugin) => [`plugin uninstalled: ${pluginLabel(result, plugin)}`]
    ),
    enablePluginMcp: lockedChange(
      (plugin) => runtime.enablePluginMcp?.(plugin),
      (result, plugin) => [`plugin MCP enabled: ${result?.serverName || plugin?.name || 'plugin'}`]
    ),
    hooksStatus: () => {
      return runtime.hooksStatus?.() || { enabled: false, events: [], recent: [] };
    },
    contextStatus: (options) => {
      return runtime.contextStatus?.(options) || null;
    },
    readModelMessages: (messageStart = 0) => {
      return runtime.readModelMessages?.(messageStart) || { messageCount: 0, messages: [] };
    },
    addHookRule: (rule) => {
      const rules = runtime.addHookRule?.(rule) || [];
      pushNotice(`hook rule added (${rules.length} total)`, 'info');
      return rules;
    },
    setHookRuleEnabled: (index, enabled) => {
      const rules = runtime.setHookRuleEnabled?.(index, enabled) || [];
      pushNotice(`hook rule ${index + 1} ${enabled ? 'enabled' : 'disabled'}`, 'info');
      return rules;
    },
    deleteHookRule: (index) => {
      const rules = runtime.deleteHookRule?.(index) || [];
      pushNotice(`hook rule ${index + 1} deleted`, 'info');
      return rules;
    },
  };
}
