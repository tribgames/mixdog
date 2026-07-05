import { join } from 'node:path';
import { existsSync } from 'node:fs';
import {
  clean,
  toolResponseText,
  isEmptyRecallText,
  currentSessionRecallRows,
} from './session-text.mjs';
import {
  addPlugin as registryAddPlugin,
  removePlugin as registryRemovePlugin,
  updatePlugin as registryUpdatePlugin,
} from '../standalone/plugin-admin.mjs';
import {
  normalizePluginMcpServerConfig,
  pluginMcpServerName,
  pluginRawMcpServers,
  pluginMcpEnableScript,
  resolveContainedPluginPath,
} from './plugin-mcp.mjs';

// MCP servers, skills, plugins, hooks, and memory/recall surfaces. Extracted
// verbatim from the runtime API object; stateless helpers are imported directly
// and the runtime injects live state getters plus the closure callbacks.
export function createResourceApi(deps) {
  const {
    getConfig, getSession, getCurrentCwd,
    cfgMod, mgr, hooks, STANDALONE_DATA_DIR,
    saveConfigAndAdopt, connectConfiguredMcp, invalidatePreSessionToolSurface,
    recreateCurrentSessionIfReady, normalizeMcpServerInput, mcpStatus,
    skillsStatus, skillContent, addProjectSkill, pluginsStatus, getMemoryModule,
    reloadFullConfig,
  } = deps;
  return {
    mcpStatus() {
      return mcpStatus();
    },
    async reconnectMcp() {
      reloadFullConfig();
      const status = await connectConfiguredMcp({ reset: true });
      invalidatePreSessionToolSurface();
      const session = getSession();
      if (session?.id) mgr.closeSession(session.id, 'cli-mcp-reconnect');
      await recreateCurrentSessionIfReady();
      return status;
    },
    async addMcpServer(input = {}) {
      const { name, config: serverConfig } = normalizeMcpServerInput(input);
      const nextConfig = { ...getConfig() };
      nextConfig.mcpServers = {
        ...(nextConfig.mcpServers || {}),
        [name]: serverConfig,
      };
      saveConfigAndAdopt(nextConfig);
      const status = await connectConfiguredMcp({ reset: true });
      invalidatePreSessionToolSurface();
      const session = getSession();
      if (session?.id) mgr.closeSession(session.id, 'cli-mcp-add');
      await recreateCurrentSessionIfReady();
      return { name, status };
    },
    async removeMcpServer(name) {
      const serverName = clean(name);
      if (!serverName) throw new Error('MCP server name is required');
      const nextConfig = { ...getConfig() };
      const current = nextConfig.mcpServers && typeof nextConfig.mcpServers === 'object'
        ? { ...nextConfig.mcpServers }
        : {};
      if (!Object.prototype.hasOwnProperty.call(current, serverName)) {
        throw new Error(`MCP server not configured: ${serverName}`);
      }
      delete current[serverName];
      saveConfigAndAdopt({ ...nextConfig, mcpServers: current });
      const status = await connectConfiguredMcp({ reset: true });
      invalidatePreSessionToolSurface();
      const session = getSession();
      if (session?.id) mgr.closeSession(session.id, 'cli-mcp-remove');
      await recreateCurrentSessionIfReady();
      return status;
    },
    async setMcpServerEnabled(name, enabled) {
      const serverName = clean(name);
      if (!serverName) throw new Error('MCP server name is required');
      const nextConfig = { ...getConfig() };
      const current = nextConfig.mcpServers && typeof nextConfig.mcpServers === 'object'
        ? { ...nextConfig.mcpServers }
        : {};
      if (!Object.prototype.hasOwnProperty.call(current, serverName)) {
        throw new Error(`MCP server not configured: ${serverName}`);
      }
      current[serverName] = { ...(current[serverName] || {}), enabled: enabled !== false };
      saveConfigAndAdopt({ ...nextConfig, mcpServers: current });
      const status = await connectConfiguredMcp({ reset: true });
      invalidatePreSessionToolSurface();
      const session = getSession();
      if (session?.id) mgr.closeSession(session.id, 'cli-mcp-toggle');
      await recreateCurrentSessionIfReady();
      return status;
    },
    skillsStatus() {
      return skillsStatus();
    },
    skillContent(name) {
      return skillContent(name);
    },
    async addSkill(input = {}) {
      const skill = addProjectSkill(input);
      const session = getSession();
      if (session?.id) mgr.closeSession(session.id, 'cli-skill-add');
      await recreateCurrentSessionIfReady();
      return { skill, status: skillsStatus() };
    },
    async reloadSkills() {
      const session = getSession();
      if (session?.id) mgr.closeSession(session.id, 'cli-skills-reload');
      await recreateCurrentSessionIfReady();
      return skillsStatus();
    },
    pluginsStatus() {
      return pluginsStatus();
    },
    async reloadPlugins() {
      const session = getSession();
      if (session?.id) mgr.closeSession(session.id, 'cli-plugins-reload');
      await recreateCurrentSessionIfReady();
      return pluginsStatus();
    },
    async addPlugin(source) {
      const dataDir = cfgMod.getPluginData?.();
      const plugin = registryAddPlugin(source, { dataDir });
      const session = getSession();
      if (session?.id) mgr.closeSession(session.id, 'cli-plugin-add');
      await recreateCurrentSessionIfReady();
      return { plugin, status: pluginsStatus() };
    },
    async updatePlugin(plugin = {}) {
      const key = clean(plugin.id || plugin.name || plugin);
      const dataDir = cfgMod.getPluginData?.();
      const updated = registryUpdatePlugin(key, { dataDir });
      const session = getSession();
      if (session?.id) mgr.closeSession(session.id, 'cli-plugin-update');
      await recreateCurrentSessionIfReady();
      return { plugin: updated, status: pluginsStatus() };
    },
    async removePlugin(plugin = {}) {
      const key = clean(plugin.id || plugin.name || plugin);
      const dataDir = cfgMod.getPluginData?.();
      const removed = registryRemovePlugin(key, { dataDir });
      const nextConfig = { ...getConfig() };
      const serverName = pluginMcpServerName(plugin);
      const prefix = `${serverName}--`;
      const hasMatch = nextConfig.mcpServers && Object.keys(nextConfig.mcpServers).some(
        (k) => k === serverName || k.startsWith(prefix)
      );
      if (hasMatch) {
        const current = { ...nextConfig.mcpServers };
        for (const k of Object.keys(current)) {
          if (k === serverName || k.startsWith(prefix)) delete current[k];
        }
        saveConfigAndAdopt({ ...nextConfig, mcpServers: current });
        await connectConfiguredMcp({ reset: true });
        invalidatePreSessionToolSurface();
      }
      const session = getSession();
      if (session?.id) mgr.closeSession(session.id, 'cli-plugin-remove');
      await recreateCurrentSessionIfReady();
      return { plugin: removed, status: pluginsStatus() };
    },
    async enablePluginMcp(plugin = {}) {
      const root = clean(plugin.root);
      const script = pluginMcpEnableScript(root, plugin);
      if (!root || !script) throw new Error('plugin has no MCP script');
      const serverName = pluginMcpServerName(plugin);
      const nextConfig = { ...getConfig() };
      const manifestMcp = pluginRawMcpServers(root, script);
      if (manifestMcp) {
        const { rawServers, mcpRoot } = manifestMcp;
        const keys = Object.keys(rawServers).filter((k) => {
          const v = rawServers[k];
          return v !== null && typeof v === 'object' && !Array.isArray(v);
        });
        const ownedPrefix = `${serverName}--`;
        const nextServers = {};
        for (const [k, v] of Object.entries(nextConfig.mcpServers || {})) {
          if (k === serverName || k.startsWith(ownedPrefix)) continue;
          nextServers[k] = v;
        }
        for (const serverKey of keys) {
          const cfg = normalizePluginMcpServerConfig(rawServers[serverKey], mcpRoot);
          cfg.env = {
            ...(cfg.env || {}),
            MIXDOG_PLUGIN_ROOT: root,
            MIXDOG_PLUGIN_DATA: join(cfgMod.getPluginData?.() || STANDALONE_DATA_DIR, 'plugins', 'data', clean(plugin.id || plugin.name || serverName)),
          };
          const key = keys.length === 1 ? serverName : `${serverName}--${serverKey}`;
          nextServers[key] = cfg;
        }
        nextConfig.mcpServers = nextServers;
      } else {
        const scriptPath = resolveContainedPluginPath(root, script);
        if (!scriptPath || !existsSync(scriptPath)) throw new Error(`plugin MCP script not found: ${join(root, script)}`);
        nextConfig.mcpServers = {
          ...(nextConfig.mcpServers || {}),
          [serverName]: {
            command: 'node',
            args: [scriptPath],
            cwd: root,
            env: {
              MIXDOG_PLUGIN_ROOT: root,
              MIXDOG_PLUGIN_DATA: join(cfgMod.getPluginData?.() || STANDALONE_DATA_DIR, 'plugins', 'data', clean(plugin.id || plugin.name || serverName)),
            },
          },
        };
      }
      saveConfigAndAdopt(nextConfig);
      const status = await connectConfiguredMcp({ reset: true });
      invalidatePreSessionToolSurface();
      const session = getSession();
      if (session?.id) mgr.closeSession(session.id, 'cli-plugin-mcp-enable');
      await recreateCurrentSessionIfReady();
      return { serverName, status };
    },
    hooksStatus() {
      return hooks.status();
    },
    addHookRule(rule) {
      return hooks.addRule(rule);
    },
    setHookRuleEnabled(index, enabled) {
      return hooks.setRuleEnabled(index, enabled);
    },
    deleteHookRule(index) {
      return hooks.deleteRule(index);
    },
    async memoryControl(args = {}) {
      const memoryMod = await getMemoryModule();
      if (!memoryMod?.handleToolCall) throw new Error('memory runtime is not available');
      return toolResponseText(await memoryMod.handleToolCall('memory', args || {}));
    },
    async recall(query, args = {}) {
      const session = getSession();
      const currentCwd = getCurrentCwd();
      const baseQuery = query || args?.query || '';
      if (args?.currentSession !== false && session?.id) {
        const currentText = currentSessionRecallRows(session, baseQuery, { limit: args?.limit });
        if (!isEmptyRecallText(currentText)) return currentText;
      }
      const memoryMod = await getMemoryModule();
      if (!memoryMod?.handleToolCall) throw new Error('memory runtime is not available');
      const baseArgs = {
        ...(args || {}),
        query: baseQuery,
        cwd: args?.cwd || currentCwd,
        ...(session?.id ? { currentSessionId: session.id } : {}),
      };
      let result = '(no results)';
      if (session?.id && args?.currentSession !== false && args?.forceCycleOnEmpty !== false) {
        const messages = Array.isArray(session.messages) ? session.messages : [];
        if (messages.length > 0) {
          await memoryMod.handleToolCall('memory', {
            action: 'ingest_session',
            sessionId: session.id,
            cwd: currentCwd,
            messages,
          });
          result = toolResponseText(await memoryMod.handleToolCall('recall', {
            ...baseArgs,
            sessionId: session.id,
            currentSession: true,
            projectScope: baseArgs.projectScope || 'all',
            includeRaw: baseArgs.includeRaw !== false,
            includeArchived: baseArgs.includeArchived !== false,
          }));
        }
      }
      if (isEmptyRecallText(result)) {
        result = toolResponseText(await memoryMod.handleToolCall('recall', baseArgs));
      }
      return result;
    },
  };
}
