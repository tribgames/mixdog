import { join } from 'node:path';
import { existsSync } from 'node:fs';
import {
  clean,
  toolResponseText,
  isEmptyRecallText,
  currentSessionRecallRows,
} from './session-text.mjs';
import {
  publishGlobalExtensionChange,
  subscribeGlobalExtensionChanges,
} from './global-extensions.mjs';
import {
  addPlugin as registryAddPlugin,
  removePlugin as registryRemovePlugin,
  setPluginEnabled as registrySetPluginEnabled,
  updatePlugin as registryUpdatePlugin,
} from '../standalone/plugin-admin.mjs';
import {
  normalizePluginMcpServerConfig,
  pluginMcpServerName,
  pluginRawMcpServers,
  pluginMcpEnableScript,
  resolveContainedPluginPath,
  mergeMcpServerConfig,
} from './plugin-mcp.mjs';
import {
  EXTENSION_SCOPE_KINDS,
  cwdWithinProjects,
  extensionScopeProjects,
  extensionScopesFromConfig,
  pluginIdForMcpServer,
  withExtensionScope,
} from './extension-scopes.mjs';

// MCP servers, skills, plugins, hooks, and memory/recall surfaces. Extracted
// verbatim from the runtime API object; stateless helpers are imported directly
// and the runtime injects live state getters plus the closure callbacks.
export function createResourceApi(deps) {
  const {
    getConfig, getCurrentCwd,
    cfgMod, hooks, STANDALONE_DATA_DIR,
    saveConfigAndAdopt, connectConfiguredMcp, invalidatePreSessionToolSurface,
    refreshEmptySessionToolPolicy, normalizeMcpServerInput, mcpStatus, getMcpServerConfig,
    skillsStatus, skillContent, addGlobalSkill, saveSkillDocument, invalidateSkills,
    getDisabledSkills, setDisabledSkills, pluginsStatus, getMemoryModule,
    reloadFullConfig, flushSkillsSave, awaitKeychainPrewarm,
  } = deps;
  // Per-server MCP toggle serialization. The synchronous config adopt in
  // setMcpServerEnabled has already made the intent durable; the heavy
  // connectConfiguredMcp process spawn/handshake runs here off the toggle's
  // critical path. Rapid re-toggles on one server
  // update `desired` and ride the in-flight chain so it converges to the last
  // requested state without replacing any addressed session.
  const mcpToggleChains = new Map(); // name -> { desired, running }
  async function refreshGlobalExtensionSurface(kind) {
    invalidatePreSessionToolSurface();
    // Existing conversations retain their stable prompt/session identity.
    // Empty sessions can safely rebuild their policy in place; MCP has its own
    // first-turn/late-tool reconciliation against the live connection registry.
    if ((kind === 'skills' || kind === 'plugins')
      && typeof refreshEmptySessionToolPolicy === 'function') {
      await refreshEmptySessionToolPolicy();
    }
  }
  async function refreshGlobalExtensionState(kind) {
    reloadFullConfig?.();
    if (kind === 'skills' || kind === 'plugins') invalidateSkills?.();
    if (kind === 'mcp' || kind === 'plugins') {
      await connectConfiguredMcp({ reset: true });
    }
    await refreshGlobalExtensionSurface(kind);
  }
  const globalExtensionSubscription = subscribeGlobalExtensionChanges(refreshGlobalExtensionState);
  const publishGlobalChange = (kind) => (
    publishGlobalExtensionChange(kind, globalExtensionSubscription.id)
  );
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
          await refreshGlobalExtensionSurface('mcp');
        } finally {
          chain.running = null;
        }
        return status;
      })();
    }
    return chain.running;
  }
  // Project scope decoration for the status lists. `scope` is the entry's own
  // root list (null = global); `inheritedScope` is the owning plugin's; and
  // `activeHere` says whether the CURRENT cwd sees the entry, so panels can
  // badge "not in this project" without redoing the path match.
  function scopeInfo(kind, name, pluginId = '') {
    const scopes = extensionScopesFromConfig(getConfig());
    const scope = extensionScopeProjects(scopes, kind, name);
    const inheritedScope = pluginId ? extensionScopeProjects(scopes, 'plugins', pluginId) : null;
    const cwd = getCurrentCwd();
    const activeHere = (scope ? cwdWithinProjects(cwd, scope) : true)
      && (inheritedScope ? cwdWithinProjects(cwd, inheritedScope) : true);
    return { scope, inheritedScope, activeHere };
  }
  function decorateMcpStatus(status) {
    const plugins = pluginsStatus()?.plugins || [];
    return {
      ...status,
      servers: (Array.isArray(status?.servers) ? status.servers : []).map((server) => ({
        ...server,
        ...scopeInfo('mcp', server.name, pluginIdForMcpServer(server.name, plugins)),
      })),
    };
  }
  function decorateSkillsStatus(status) {
    return {
      ...status,
      skills: (Array.isArray(status?.skills) ? status.skills : []).map((skill) => ({
        ...skill,
        ...scopeInfo('skills', skill.name, skill?.owner?.kind === 'plugin' ? clean(skill.owner.id) : ''),
      })),
    };
  }
  function decoratePluginsStatus(status) {
    return {
      ...status,
      plugins: (Array.isArray(status?.plugins) ? status.plugins : []).map((plugin) => ({
        ...plugin,
        ...scopeInfo('plugins', plugin.id || plugin.name),
      })),
    };
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
      return decorateMcpStatus(mcpStatus());
    },
    getMcpServerConfig(name) {
      return getMcpServerConfig(name);
    },
    /** Limit one Skill / MCP server / Plugin to project roots; [] or null → global. */
    async setExtensionScope(kind, name, projects = null) {
      const scopeKind = clean(kind);
      if (!EXTENSION_SCOPE_KINDS.includes(scopeKind)) {
        throw new Error(`extension scope kind must be one of ${EXTENSION_SCOPE_KINDS.join(', ')}`);
      }
      const key = clean(name);
      if (!key) throw new Error('extension name is required');
      const list = Array.isArray(projects) ? projects : projects == null ? [] : [projects];
      saveConfigAndAdopt(withExtensionScope(getConfig(), scopeKind, key, list));
      // Connections and files are untouched; only what sessions see changes.
      if (scopeKind !== 'mcp') invalidateSkills?.();
      await refreshGlobalExtensionSurface(scopeKind);
      await publishGlobalChange(scopeKind);
      if (scopeKind === 'skills') return decorateSkillsStatus(skillsStatus());
      if (scopeKind === 'plugins') return decoratePluginsStatus(pluginsStatus());
      return decorateMcpStatus(mcpStatus());
    },
    async reconnectMcp() {
      await awaitKeychainPrewarm();
      reloadFullConfig();
      const status = await connectConfiguredMcp({ reset: true });
      await refreshGlobalExtensionSurface('mcp');
      await publishGlobalChange('mcp');
      return status;
    },
    async addMcpServer(input = {}) {
      const { name, config: serverConfig } = normalizeMcpServerInput(input);
      const nextConfig = { ...getConfig() };
      delete nextConfig.mcpProjectOverrides;
      nextConfig.mcpServers = {
        ...(nextConfig.mcpServers || {}),
        [name]: serverConfig,
      };
      saveConfigAndAdopt(nextConfig);
      const status = await connectConfiguredMcp({ reset: true });
      await refreshGlobalExtensionSurface('mcp');
      await publishGlobalChange('mcp');
      return { name, status };
    },
    async saveMcpServer(input = {}) {
      const originalName = clean(input.originalName);
      const normalizedInput = normalizeMcpServerInput(input);
      const name = originalName && clean(input.name) === originalName
        ? originalName
        : normalizedInput.name;
      const normalized = normalizedInput.config;
      const nextConfig = { ...getConfig() };
      delete nextConfig.mcpProjectOverrides;
      const servers = nextConfig.mcpServers && typeof nextConfig.mcpServers === 'object'
        ? { ...nextConfig.mcpServers }
        : {};
      if (originalName && !Object.prototype.hasOwnProperty.call(servers, originalName)) {
        throw new Error(`MCP server not configured: ${originalName}`);
      }
      if (name !== originalName && Object.prototype.hasOwnProperty.call(servers, name)) {
        throw new Error(`MCP server already exists: ${name}`);
      }
      const existing = originalName ? servers[originalName] : {};
      if (originalName && originalName !== name) delete servers[originalName];
      servers[name] = mergeMcpServerConfig(existing, normalized);
      nextConfig.mcpServers = servers;
      saveConfigAndAdopt(nextConfig);
      const status = await connectConfiguredMcp({ reset: true });
      await refreshGlobalExtensionSurface('mcp');
      await publishGlobalChange('mcp');
      return { name, source: 'config', status };
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
      delete nextConfig.mcpProjectOverrides;
      saveConfigAndAdopt({ ...nextConfig, mcpServers: current });
      const status = await connectConfiguredMcp({ reset: true });
      await refreshGlobalExtensionSurface('mcp');
      await publishGlobalChange('mcp');
      return status;
    },
    async setMcpServerEnabled(name, enabled) {
      const serverName = clean(name);
      if (!serverName) throw new Error('MCP server name is required');
      const want = enabled !== false;
      const shadowRow = mcpStatus().servers.find((s) => s.name === serverName);
      if (!shadowRow) throw new Error(`MCP server not configured: ${serverName}`);
      const nextConfig = { ...getConfig() };
      const servers = nextConfig.mcpServers && typeof nextConfig.mcpServers === 'object'
        ? { ...nextConfig.mcpServers }
        : {};
      const current = servers[serverName];
      if (!current || typeof current !== 'object' || Array.isArray(current)) {
        throw new Error(`MCP server not configured: ${serverName}`);
      }
      servers[serverName] = { ...current, enabled: want };
      delete nextConfig.mcpProjectOverrides;
      saveConfigAndAdopt({ ...nextConfig, mcpServers: servers });
      const status = await scheduleMcpToggle(serverName, want);
      await publishGlobalChange('mcp');
      return status;
    },
    skillsStatus() {
      return decorateSkillsStatus(skillsStatus());
    },
    skillContent(name) {
      return skillContent(name);
    },
    async addSkill(input = {}) {
      const skill = addGlobalSkill(input);
      invalidateSkills?.();
      await refreshGlobalExtensionSurface('skills');
      await publishGlobalChange('skills');
      return { skill, status: skillsStatus() };
    },
    async saveSkill(input = {}) {
      const skill = saveSkillDocument(input);
      if (skill.originalName !== skill.name) {
        const disabled = getDisabledSkills?.().disabled;
        if (Array.isArray(disabled) && disabled.includes(skill.originalName)) {
          setDisabledSkills?.(disabled.map((name) =>
            name === skill.originalName ? skill.name : name));
          flushSkillsSave?.();
        }
      }
      await refreshGlobalExtensionSurface('skills');
      await publishGlobalChange('skills');
      return { skill, status: skillsStatus() };
    },
    async setDisabledSkills(names = []) {
      const result = setDisabledSkills?.(names);
      flushSkillsSave?.();
      invalidateSkills?.();
      await refreshGlobalExtensionSurface('skills');
      await publishGlobalChange('skills');
      return result;
    },
    async reloadSkills() {
      invalidateSkills?.();
      await refreshGlobalExtensionSurface('skills');
      await publishGlobalChange('skills');
      return skillsStatus();
    },
    pluginsStatus() {
      return decoratePluginsStatus(pluginsStatus());
    },
    async reloadPlugins() {
      invalidateSkills?.();
      await refreshGlobalExtensionSurface('plugins');
      await publishGlobalChange('plugins');
      return pluginsStatus();
    },
    async addPlugin(source) {
      const dataDir = cfgMod.getPluginData?.();
      const plugin = registryAddPlugin(source, { dataDir });
      invalidateSkills?.();
      await refreshGlobalExtensionSurface('plugins');
      await publishGlobalChange('plugins');
      return { plugin, status: pluginsStatus() };
    },
    async updatePlugin(plugin = {}) {
      const key = clean(plugin.id || plugin.name || plugin);
      const dataDir = cfgMod.getPluginData?.();
      const updated = registryUpdatePlugin(key, { dataDir });
      invalidateSkills?.();
      await refreshGlobalExtensionSurface('plugins');
      await publishGlobalChange('plugins');
      return { plugin: updated, status: pluginsStatus() };
    },
    async setPluginEnabled(plugin = {}, enabled = true) {
      const key = clean(plugin.id || plugin.name || plugin);
      const dataDir = cfgMod.getPluginData?.();
      const updated = registrySetPluginEnabled(key, enabled, { dataDir });
      const nextConfig = { ...getConfig() };
      const serverName = pluginMcpServerName(plugin);
      const prefix = `${serverName}--`;
      let changedMcp = false;
      const mcpServers = {};
      for (const [name, value] of Object.entries(nextConfig.mcpServers || {})) {
        const config = value && typeof value === 'object' && !Array.isArray(value)
          ? { ...value }
          : value;
        if (name === serverName || name.startsWith(prefix)) {
          changedMcp = true;
          if (config && typeof config === 'object' && !Array.isArray(config)) {
            if (enabled === false) config._mixdogPluginDisabled = true;
            else delete config._mixdogPluginDisabled;
          }
        }
        mcpServers[name] = config;
      }
      if (changedMcp) {
        nextConfig.mcpServers = mcpServers;
        saveConfigAndAdopt(nextConfig);
        await connectConfiguredMcp({ reset: true });
        invalidatePreSessionToolSurface();
      }
      invalidateSkills?.();
      await refreshGlobalExtensionSurface('plugins');
      await publishGlobalChange('plugins');
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
      invalidateSkills?.();
      await refreshGlobalExtensionSurface('plugins');
      await publishGlobalChange('plugins');
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
          if (plugin.enabled === false) cfg._mixdogPluginDisabled = true;
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
            ...(plugin.enabled === false ? { _mixdogPluginDisabled: true } : {}),
          },
        };
      }
      saveConfigAndAdopt(nextConfig);
      const status = await connectConfiguredMcp({ reset: true });
      await refreshGlobalExtensionSurface('mcp');
      await publishGlobalChange('mcp');
      return { serverName, status };
    },
    disposeGlobalExtensionSubscription() {
      globalExtensionSubscription.unsubscribe();
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
