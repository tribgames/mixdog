import { join } from 'node:path';
import { existsSync } from 'node:fs';
import {
  clean,
  toolResponseText,
  isEmptyRecallText,
  currentSessionRecallRows,
  tombstoneOnClose,
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
  setProjectMcpServerEnabled,
  normalizeMcpProjectPathKey,
} from './plugin-mcp.mjs';
import { invalidateProjectMcpCache } from './mcp-glue.mjs';

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
    reloadFullConfig, awaitKeychainPrewarm, getActiveTurnCount,
  } = deps;
  // Per-server MCP toggle serialization. The synchronous config adopt in
  // setMcpServerEnabled has already made the intent durable; the heavy
  // connectConfiguredMcp (process spawn/handshake) + session close/recreate
  // run here off the toggle's critical path. Rapid re-toggles on one server
  // update `desired` and ride the in-flight chain so it converges to the last
  // requested state, closing/recreating the session only once at the end.
  const mcpToggleChains = new Map(); // name -> { desired, running }
  // Close/recreate the live session only at a turn boundary: a background
  // toggle must never abort an in-flight turn. If a turn is active, poll until
  // it ends, then swap the session so it picks up the new tool surface.
  function applyMcpToggleRecreate(serverName) {
    if (typeof getActiveTurnCount === 'function' && getActiveTurnCount() > 0) {
      const timer = setTimeout(() => applyMcpToggleRecreate(serverName), 250);
      timer.unref?.();
      return;
    }
    invalidatePreSessionToolSurface();
    const session = getSession();
    if (session?.id) mgr.closeSession(session.id, 'cli-mcp-toggle', { tombstone: tombstoneOnClose(session) });
    // Recreate off the critical path (see removeMcpServer notes): the next
    // on-demand createCurrentSession dedupes onto this in-flight create.
    void recreateCurrentSessionIfReady().catch((err) => {
      process.stderr.write(`[mcp] session recreate after toggle failed: ${err?.message || err}\n`);
    });
  }
  function scheduleMcpToggle(serverName, enabled) {
    const chain = mcpToggleChains.get(serverName) || { desired: enabled, running: null };
    chain.desired = enabled;
    mcpToggleChains.set(serverName, chain);
    if (!chain.running) {
      chain.running = (async () => {
        let status;
        try {
          let want;
          do {
            want = chain.desired;
            status = await connectConfiguredMcp({ only: serverName, enabled: want });
          } while (chain.desired !== want);
          // Turn-safe: defers until any active turn ends (never aborts it).
          applyMcpToggleRecreate(serverName);
        } finally {
          chain.running = null;
        }
        return status;
      })();
    }
    return chain.running;
  }
  function configuredProfileIdentityLine() {
    try {
      const config = getConfig();
      const stored = config?.profile ?? config?.agent?.profile;
      const profile = cfgMod.normalizeProfileConfig(stored);
      const title = clean(profile?.title);
      if (!title) return '';
      return `[profile] Current configured user name/identity: ${title}. This profile value is authoritative; ignore stale memory rows that say the user's identity is unknown.`;
    } catch {
      return '';
    }
  }
  function isIdentityRecallQuery(query) {
    const q = clean(query).toLowerCase().replace(/\s+/g, '');
    if (!q) return false;
    return /(?:\uB0B4\uAC00|\uB098\uB294|\uB098|\uC0AC\uC6A9\uC790|\uC720\uC800|user|my|me).*(?:\uB204\uAD6C|\uB204\uAD70|\uC815\uCCB4|\uC774\uB984|name|identity)|(?:whoami|whoami\?|whoami？)|who(?:am)?i|whoami/.test(q)
      || /^(?:\uB098\uB204\uAD6C\uB0D0|\uB098\uB294\uB204\uAD6C\uB0D0|\uB0B4\uAC00\uB204\uAD6C\uB0D0|\uB0B4\uC774\uB984\uBB50|\uB0B4\uC774\uB984\uBB50\uC57C|whoami)$/i.test(q);
  }
  return {
    mcpStatus() {
      return mcpStatus();
    },
    async reconnectMcp() {
      await awaitKeychainPrewarm();
      reloadFullConfig();
      const status = await connectConfiguredMcp({ reset: true });
      invalidatePreSessionToolSurface();
      const session = getSession();
      if (session?.id) mgr.closeSession(session.id, 'cli-mcp-reconnect', { tombstone: tombstoneOnClose(session) });
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
      if (session?.id) mgr.closeSession(session.id, 'cli-mcp-add', { tombstone: tombstoneOnClose(session) });
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
      const currentOverrides = nextConfig.mcpProjectOverrides && typeof nextConfig.mcpProjectOverrides === 'object'
        ? nextConfig.mcpProjectOverrides
        : {};
      const mcpProjectOverrides = {};
      for (const [projectKey, serverOverrides] of Object.entries(currentOverrides)) {
        if (!serverOverrides || typeof serverOverrides !== 'object' || Array.isArray(serverOverrides)) continue;
        const nextServerOverrides = { ...serverOverrides };
        delete nextServerOverrides[serverName];
        if (Object.keys(nextServerOverrides).length > 0) {
          mcpProjectOverrides[projectKey] = nextServerOverrides;
        }
      }
      saveConfigAndAdopt({ ...nextConfig, mcpServers: current, mcpProjectOverrides });
      const status = await connectConfiguredMcp({ reset: true });
      invalidatePreSessionToolSurface();
      const session = getSession();
      if (session?.id) mgr.closeSession(session.id, 'cli-mcp-remove', { tombstone: tombstoneOnClose(session) });
      await recreateCurrentSessionIfReady();
      return status;
    },
    setMcpServerEnabled(name, enabled) {
      const serverName = clean(name);
      if (!serverName) throw new Error('MCP server name is required');
      const want = enabled !== false;
      // A project-local `.mcp.json` entry WINS over config for this name, so the
      // durable toggle must land in whichever file actually drives the server.
      // For project-sourced servers, persist the `enabled` flag into `.mcp.json`
      // then explicitly invalidate the project cache (mtime granularity is not
      // reliable for same-tick writes), before running the same
      // background connect/recreate chain used for config servers.
      const shadowRow = mcpStatus().servers.find((s) => s.name === serverName);
      if (shadowRow && shadowRow.source === 'project') {
        setProjectMcpServerEnabled(getCurrentCwd(), serverName, want);
        invalidateProjectMcpCache(getCurrentCwd());
        return scheduleMcpToggle(serverName, want);
      }
      const nextConfig = { ...getConfig() };
      const current = nextConfig.mcpServers && typeof nextConfig.mcpServers === 'object'
        ? { ...nextConfig.mcpServers }
        : {};
      if (!Object.prototype.hasOwnProperty.call(current, serverName)) {
        throw new Error(`MCP server not configured: ${serverName}`);
      }
      // Keep the global server definition single-source; only this project's
      // enabled override is adopted + persisted synchronously (fast), then
      // hand the heavy connect/close/recreate to the per-server background
      // chain. Return that chain's promise so callers can settle the picker on
      // completion, but the store no longer blocks on it.
      const projectKey = normalizeMcpProjectPathKey(getCurrentCwd());
      const currentOverrides = nextConfig.mcpProjectOverrides && typeof nextConfig.mcpProjectOverrides === 'object'
        ? nextConfig.mcpProjectOverrides
        : {};
      const projectOverrides = currentOverrides[projectKey] && typeof currentOverrides[projectKey] === 'object'
        ? currentOverrides[projectKey]
        : {};
      cfgMod.markMcpProjectOverrideDirty(projectKey, serverName, want);
      saveConfigAndAdopt({
        ...nextConfig,
        mcpProjectOverrides: {
          ...currentOverrides,
          [projectKey]: {
            ...projectOverrides,
            [serverName]: { enabled: want },
          },
        },
      });
      return scheduleMcpToggle(serverName, want);
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
      if (session?.id) mgr.closeSession(session.id, 'cli-skill-add', { tombstone: tombstoneOnClose(session) });
      await recreateCurrentSessionIfReady();
      return { skill, status: skillsStatus() };
    },
    async reloadSkills() {
      const session = getSession();
      if (session?.id) mgr.closeSession(session.id, 'cli-skills-reload', { tombstone: tombstoneOnClose(session) });
      await recreateCurrentSessionIfReady();
      return skillsStatus();
    },
    pluginsStatus() {
      return pluginsStatus();
    },
    async reloadPlugins() {
      const session = getSession();
      if (session?.id) mgr.closeSession(session.id, 'cli-plugins-reload', { tombstone: tombstoneOnClose(session) });
      await recreateCurrentSessionIfReady();
      return pluginsStatus();
    },
    async addPlugin(source) {
      const dataDir = cfgMod.getPluginData?.();
      const plugin = registryAddPlugin(source, { dataDir });
      const session = getSession();
      if (session?.id) mgr.closeSession(session.id, 'cli-plugin-add', { tombstone: tombstoneOnClose(session) });
      await recreateCurrentSessionIfReady();
      return { plugin, status: pluginsStatus() };
    },
    async updatePlugin(plugin = {}) {
      const key = clean(plugin.id || plugin.name || plugin);
      const dataDir = cfgMod.getPluginData?.();
      const updated = registryUpdatePlugin(key, { dataDir });
      const session = getSession();
      if (session?.id) mgr.closeSession(session.id, 'cli-plugin-update', { tombstone: tombstoneOnClose(session) });
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
      if (session?.id) mgr.closeSession(session.id, 'cli-plugin-remove', { tombstone: tombstoneOnClose(session) });
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
      if (session?.id) mgr.closeSession(session.id, 'cli-plugin-mcp-enable', { tombstone: tombstoneOnClose(session) });
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
      if (isIdentityRecallQuery(baseQuery)) {
        const profileLine = configuredProfileIdentityLine();
        if (profileLine) return profileLine;
      }
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
