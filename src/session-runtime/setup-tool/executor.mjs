/** `setup` tool dispatch. Every mutation goes through the runtime facade the
 *  TUI/Desktop settings surfaces already use, so normalization, MCP
 *  reconnects, and the empty-session tool-policy refresh all apply exactly as
 *  they do for a UI click. The facade is read lazily because runtime-core
 *  registers the tool executor before it finishes assembling the API object. */
import { builtinFeatureActive } from '../builtin-features.mjs';
import { SETUP_ACTIONS, SETUP_OPEN_TARGETS, SETUP_STATUS_DOMAINS } from './tool-defs.mjs';

const clean = (value) => String(value ?? '').trim();

const OPEN_TARGET_HINTS = Object.freeze({
  settings: 'Desktop: Settings (Ctrl+,) · TUI: /setting',
  providers: 'Desktop: Settings → Providers · TUI: /providers',
  model: 'Desktop: session header model picker · TUI: /model',
  websearch: 'Desktop: Workflows → Web Search · TUI: /websearch',
  workflow: 'Desktop: Workflows · TUI: /workflow',
  agents: 'Desktop: Workflows → Agents · TUI: /agents',
  outputstyle: 'Desktop: Settings → Output style · TUI: /OutputStyle',
  theme: 'Desktop: Settings → General → Theme · TUI: /theme',
  profile: 'Desktop: Settings → General → Profile · TUI: /profile',
  autoclear: 'Desktop: Settings → Context · TUI: /autoclear',
  memory: 'Desktop: Extensions → Plugin → Built-in (Memory); core memories under Projects → project → Memories · TUI: /memory',
  mcp: 'Desktop: Extensions → Skill tab → MCP · TUI: /mcp',
  skills: 'Desktop: Extensions → Skill tab → Skills · TUI: /skills',
  plugins: 'Desktop: Extensions → Plugin tab → Plugins · TUI: /plugins',
  update: 'Desktop: Settings → System → Update · TUI: /update',
  usage: 'Desktop: /usage in the composer · TUI: /usage',
  doctor: 'Desktop: Settings → System → Doctor, or /doctor in the composer · TUI: /doctor',
  context: 'Desktop: /context in the composer · TUI: /context',
});

function requireEnum(value, allowed, label) {
  const id = clean(value);
  if (!allowed.includes(id)) {
    throw new Error(`${label} must be one of ${allowed.join(', ')}`);
  }
  return id;
}

function requireBoolean(value, label = 'enabled') {
  if (typeof value !== 'boolean') throw new Error(`${label} (boolean) is required`);
  return value;
}

function requireText(value, label) {
  const text = clean(value);
  if (!text) throw new Error(`${label} is required`);
  return text;
}

function routeInput(route) {
  const source = route && typeof route === 'object' ? route : {};
  const next = {};
  if (clean(source.provider) || Object.prototype.hasOwnProperty.call(source, 'provider')) next.provider = clean(source.provider);
  if (clean(source.model)) next.model = clean(source.model);
  if (clean(source.effort)) next.effort = clean(source.effort);
  if (typeof source.fast === 'boolean') next.fast = source.fast;
  return next;
}

/** Provider rows for the model: connection state and key-console URL only.
 *  Secrets never reach this surface, and the row shape stays independent of
 *  whatever the UI panels add later. */
function publicProviderRows(setup) {
  const pick = (row, extra = {}) => ({
    id: row.id,
    name: row.name,
    type: row.type,
    enabled: row.enabled === true,
    authenticated: row.authenticated === true,
    status: row.status || '',
    ...extra,
  });
  return {
    pendingSecrets: setup?.pendingSecrets === true,
    api: (setup?.api || []).map((row) => pick(row, {
      source: row.env ? `env:${row.envName}` : row.stored ? 'keychain' : 'none',
      keyUrl: /^https:\/\//.test(String(row.url || '')) ? row.url : null,
    })),
    oauth: (setup?.oauth || []).map((row) => pick(row, {
      reauthRequired: row.reauthRequired === true,
      expiresAt: row.expiresAt || null,
    })),
    local: (setup?.local || []).map((row) => pick(row, {
      detected: row.detected === true,
      baseURL: row.baseURL || row.defaultURL || '',
    })),
  };
}

function mcpRows(status) {
  return {
    connectedCount: Number(status?.connectedCount || 0),
    servers: (status?.servers || []).map((server) => ({
      name: server.name,
      enabled: server.enabled !== false,
      connected: server.connected === true,
      transport: server.transport || server.type || '',
      toolCount: Number(server.toolCount || 0),
      source: server.source || '',
      error: server.error || null,
      scope: Array.isArray(server.scope) ? server.scope : null,
    })),
  };
}

export function createSetupToolExecutor({ getApi, getConfig, notifySessionUi, getSessionId }) {
  const api = () => {
    const facade = getApi?.();
    if (!facade) throw new Error('setup: runtime facade is not ready');
    return facade;
  };
  const mainRoute = (rt) => ({
    provider: rt.provider || '',
    model: rt.model || '',
    effort: rt.effort || null,
    fast: rt.fast === true,
    fastCapable: rt.fastCapable === true,
  });

  async function readStatus(domain) {
    const rt = api();
    switch (domain) {
      case 'summary': {
        const config = getConfig?.() || {};
        return {
          route: mainRoute(rt),
          workflow: (rt.listWorkflows?.() || []).find((pack) => pack.active) || null,
          outputStyle: rt.getOutputStyle?.()?.configured || null,
          profile: (({ title, language, experienceLevel }) => ({ title, language, experienceLevel }))(rt.getProfile?.() || {}),
          features: {
            ...(rt.getToolModuleSettings?.() || {}),
            browser: { active: builtinFeatureActive(config, 'browser') },
            computer: { active: builtinFeatureActive(config, 'computer') },
          },
          onboarding: rt.getOnboardingStatus?.() || null,
        };
      }
      case 'model': return { route: mainRoute(rt), effortOptions: rt.effortOptions || [] };
      case 'agents': return { agents: rt.listAgents?.() || [] };
      case 'workflow': return { workflows: rt.listWorkflows?.() || [] };
      case 'websearch': return { route: rt.getWebSearchRoute?.() || null, enabled: rt.getToolModuleSettings?.()?.webSearch?.enabled !== false };
      case 'output-style': return rt.getOutputStyle?.() || {};
      case 'profile': {
        const profile = rt.getProfile?.() || {};
        return {
          title: profile.title || '',
          language: profile.language || 'system',
          experienceLevel: profile.experienceLevel || '',
          languages: (profile.languages || []).map((entry) => entry.id || entry),
          experienceLevels: (profile.experienceLevels || []).map((entry) => entry.id || entry),
        };
      }
      case 'autoclear': return rt.getAutoClear?.() || {};
      case 'compaction': return rt.getCompactionSettings?.() || {};
      case 'memory': return { ...(rt.getToolModuleSettings?.()?.memory || {}), recap: rt.getRecapSettings?.() || null };
      case 'features': {
        const config = getConfig?.() || {};
        return {
          ...(rt.getToolModuleSettings?.() || {}),
          browser: { active: builtinFeatureActive(config, 'browser') },
          computer: { active: builtinFeatureActive(config, 'computer') },
        };
      }
      case 'shell': return rt.getSystemShell?.() || {};
      case 'providers': return publicProviderRows(await rt.getProviderSetup?.({}));
      case 'mcp': return mcpRows(rt.mcpStatus?.());
      case 'skills': return { ...(rt.skillsStatus?.() || {}), disabled: rt.getDisabledSkills?.()?.disabled || [] };
      case 'plugins': return rt.pluginsStatus?.() || {};
      case 'update': return rt.getUpdateSettings?.() || {};
      case 'onboarding': return rt.getOnboardingStatus?.() || {};
      default: throw new Error(`setup: unknown status domain "${domain}"`);
    }
  }

  function openSurface(target) {
    const command = requireEnum(target, SETUP_OPEN_TARGETS, 'target');
    const sessionId = clean(getSessionId?.());
    const hint = OPEN_TARGET_HINTS[command] || `TUI: /${command}`;
    const handled = sessionId
      ? notifySessionUi?.(sessionId, `Open /${command}`, { kind: 'ui-open', command }) === true
      : false;
    return {
      opened: handled,
      target: command,
      ...(handled
        ? { note: 'The attached app navigated to this surface; the user completes the step there.' }
        : { note: `No interactive UI is attached to this session. Tell the user where to go: ${hint}` }),
    };
  }

  async function execute(args = {}) {
    const action = requireEnum(args?.action, SETUP_ACTIONS, 'action');
    const rt = action === 'status' || action === 'open' ? null : api();
    switch (action) {
      case 'status': {
        const domain = clean(args.domain) || 'summary';
        requireEnum(domain, SETUP_STATUS_DOMAINS, 'domain');
        return { domain, ...(await readStatus(domain)) };
      }
      case 'open': return openSurface(args.target);
      case 'set_route': {
        const route = routeInput(args.route);
        if (!route.provider && !route.model && !route.effort && route.fast === undefined) {
          throw new Error('route with at least one of provider, model, effort, fast is required');
        }
        const next = await rt.setRoute(route);
        return { route: next, appliesTo: 'next session (a conversation keeps its frozen route)' };
      }
      case 'set_agent_route': {
        const agent = requireText(args.agent, 'agent');
        const route = routeInput(args.route);
        return { agent, route: await rt.setAgentRoute(agent, route) };
      }
      case 'set_web_search_route': return { route: await rt.setWebSearchRoute(routeInput(args.route)) };
      case 'set_workflow': return await rt.setWorkflow(requireText(args.workflow, 'workflow'));
      case 'set_output_style': {
        const result = await rt.setOutputStyle(requireText(args.style, 'style'));
        return { configured: result?.configured || null, appliedToCurrentSession: result?.appliedToCurrentSession === true };
      }
      case 'set_profile': {
        const profile = args.profile && typeof args.profile === 'object' ? args.profile : null;
        if (!profile || !Object.keys(profile).length) throw new Error('profile with title, language, or experienceLevel is required');
        const result = rt.setProfile(profile);
        return { title: result.title || '', language: result.language || 'system', experienceLevel: result.experienceLevel || '' };
      }
      case 'set_autoclear': {
        const input = args.autoclear && typeof args.autoclear === 'object' ? args.autoclear : null;
        if (!input || !Object.keys(input).length) throw new Error('autoclear with enabled, duration, or provider is required');
        return rt.setAutoClear(input);
      }
      case 'set_compaction': return rt.setCompactionSettings({ auto: requireBoolean(args.enabled) });
      case 'set_memory_enabled': return await rt.setMemoryToolsEnabled(requireBoolean(args.enabled));
      case 'set_recap_enabled': return rt.setRecapEnabled(requireBoolean(args.enabled));
      case 'set_web_search_enabled': return await rt.setWebSearchEnabled(requireBoolean(args.enabled));
      case 'set_builtin_enabled': {
        const name = requireEnum(args.name, ['git', 'office'], 'name');
        return await rt.setBuiltinToolEnabled(name, requireBoolean(args.enabled));
      }
      case 'install_builtin': {
        const name = requireEnum(args.name, ['git', 'memory', 'office'], 'name');
        return await rt.installBuiltinFeature(name);
      }
      case 'set_system_shell': return rt.setSystemShell({ command: clean(args.command) });
      case 'set_auto_update': return rt.setAutoUpdate(requireBoolean(args.enabled));
      case 'set_local_provider': {
        const name = requireText(args.name, 'name');
        const opts = {};
        if (typeof args.enabled === 'boolean') opts.enabled = args.enabled;
        if (clean(args.baseURL)) opts.baseURL = clean(args.baseURL);
        if (!Object.keys(opts).length) throw new Error('enabled and/or baseURL is required');
        return rt.setLocalProvider(name, opts);
      }
      case 'forget_provider_auth': return rt.forgetProviderAuth(requireText(args.name, 'name'));
      case 'add_mcp_server': {
        const server = args.server && typeof args.server === 'object' ? args.server : null;
        if (!server) throw new Error('server object is required');
        const result = await rt.addMcpServer(server);
        return { name: result?.name, mcp: mcpRows(result?.status) };
      }
      case 'save_mcp_server': {
        const server = args.server && typeof args.server === 'object' ? args.server : null;
        if (!server) throw new Error('server object is required');
        const result = await rt.saveMcpServer(server);
        return { name: result?.name, mcp: mcpRows(result?.status) };
      }
      case 'remove_mcp_server': return { mcp: mcpRows(await rt.removeMcpServer(requireText(args.name, 'name'))) };
      case 'set_mcp_enabled': return { mcp: mcpRows(await rt.setMcpServerEnabled(requireText(args.name, 'name'), requireBoolean(args.enabled))) };
      case 'reconnect_mcp': return { mcp: mcpRows(await rt.reconnectMcp()) };
      case 'set_disabled_skills': {
        if (!Array.isArray(args.skills)) throw new Error('skills (array of names) is required');
        return await rt.setDisabledSkills(args.skills.map(clean).filter(Boolean));
      }
      case 'set_extension_scope': {
        const kind = requireEnum(args.kind, ['skills', 'mcp', 'plugins'], 'kind');
        const projects = Array.isArray(args.projects) ? args.projects.map(clean).filter(Boolean) : [];
        const status = await rt.setExtensionScope(kind, requireText(args.name, 'name'), projects);
        if (kind === 'mcp') return { mcp: mcpRows(status) };
        return status || {};
      }
      case 'add_plugin': return { plugin: (await rt.addPlugin(requireText(args.source, 'source')))?.plugin || null };
      case 'update_plugin': return { plugin: (await rt.updatePlugin(requireText(args.name, 'name')))?.plugin || null };
      case 'set_plugin_enabled': return { plugin: (await rt.setPluginEnabled(requireText(args.name, 'name'), requireBoolean(args.enabled)))?.plugin || null };
      case 'remove_plugin': return { plugin: (await rt.removePlugin(requireText(args.name, 'name')))?.plugin || null };
      default: throw new Error(`setup: unhandled action "${action}"`);
    }
  }

  return {
    async execute(args = {}) {
      const result = await execute(args);
      return JSON.stringify(result ?? {}, null, 2);
    },
  };
}
