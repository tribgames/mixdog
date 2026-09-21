/** `setup` tool dispatch. Every mutation goes through the runtime facade the
 *  TUI/Desktop settings surfaces already use, so normalization, MCP
 *  reconnects, and the empty-session tool-policy refresh all apply exactly as
 *  they do for a UI click. The facade is read lazily because runtime-core
 *  registers the tool executor before it finishes assembling the API object. */
import { builtinFeatureActive, builtinFirstUseApproval } from '../builtin-features.mjs';
import { ORCHESTRATION_MODES } from '../../runtime/shared/orchestration.mjs';
import { SETUP_DESKTOP_DOMAINS, SETUP_HANDOFFS } from './settings-contract.mjs';
import { executeExtendedSetupAction, publicAutomation, validateMcpInput } from './extended-actions.mjs';
import { createSetupUiRequests } from './ui-requests.mjs';
import {
  SETUP_ACTIONS,
  SETUP_ACTION_FIELDS,
  SETUP_OPEN_TARGETS,
  SETUP_STATUS_DOMAINS,
  SETUP_TOOL_DEFS,
  SETUP_BUILTIN_TOGGLE_FEATURES,
} from './tool-defs.mjs';
import { schemaValueError } from '../../runtime/shared/schema-value-error.mjs';

const clean = (value) => String(value ?? '').trim();
const ACTION_APPLIES_TO = {
  set_recap_enabled: 'background Memory cycles; no restart required',
  set_auto_update: 'subsequent automatic update checks',
  set_system_shell: 'subsequent shell calls',
  save_automation: 'the automation worker; scheduled runs follow the saved timing',
  delete_automation: 'future automation runs',
  set_automation_enabled: 'future automation runs',
  set_webhook_config: 'the webhook worker after configuration reload',
};

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
  memory:
    'Desktop: Extensions → Plugin → Built-in (Memory); core memories under Projects → project → Memories · TUI: /memory',
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

function routeInput(source) {
  const next = {};
  if (clean(source.provider) || Object.hasOwn(source, 'provider')) next.provider = clean(source.provider);
  if (clean(source.model)) next.model = clean(source.model);
  if (clean(source.effort)) next.effort = clean(source.effort);
  if (typeof source.fast === 'boolean') next.fast = source.fast;
  if (Object.hasOwn(source, 'modelParameters')) next.modelParameters = { ...source.modelParameters };
  if (Object.hasOwn(source, 'contextPercent')) next.contextPercent = source.contextPercent;
  if (Object.hasOwn(source, 'disabled')) next.disabled = source.disabled;
  return next;
}

function apiKeySource(row) {
  if (row.env) return `env:${row.envName}`;
  return row.stored ? 'keychain' : 'none';
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
    api: (setup?.api || []).map((row) =>
      pick(row, {
        source: apiKeySource(row),
        keyUrl: /^https:\/\//.test(String(row.url || '')) ? row.url : null,
      })
    ),
    oauth: (setup?.oauth || []).map((row) =>
      pick(row, {
        reauthRequired: row.reauthRequired === true,
        expiresAt: row.expiresAt || null,
      })
    ),
    local: (setup?.local || []).map((row) =>
      pick(row, {
        detected: row.detected === true,
        baseURL: row.baseURL || row.defaultURL || '',
      })
    ),
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

const mainRoute = (rt) => ({
  provider: rt.provider || '',
  model: rt.model || '',
  effort: rt.effort || null,
  fast: rt.fast === true,
  fastCapable: rt.fastCapable === true,
  modelParameters: rt.modelParameters || {},
  contextPercent: rt.contextPercent ?? null,
});

async function automationStatus(rt, { domain }) {
  const status = await rt.getChannelSetup();
  return {
    entries: status[domain].map(publicAutomation),
    ...(domain === 'webhooks'
      ? {
          listener: {
            enabled: status.webhook?.enabled === true,
            port: status.webhook?.port,
            domain: status.webhook?.domain || '',
          },
        }
      : {}),
  };
}

// status readers per non-desktop domain: (rt, { domain, getConfig }) → the
// public status shape. Desktop-hosted domains never reach this table.
function featureFlags(rt) {
  return Object.fromEntries(
    Object.entries(rt.getToolModuleSettings?.() || {}).map(([name, settings]) => [
      name,
      Object.fromEntries(
        Object.entries(settings).filter(([key]) => key === 'enabled' || key === 'installed')
      ),
    ])
  );
}

const SETUP_STATUS_READERS = {
  capabilities: () => ({
    actions: SETUP_ACTION_FIELDS,
    domains: SETUP_STATUS_DOMAINS,
    desktopScope: 'desktop-host; requires this conversation open in the local Desktop window',
    handoffs: SETUP_HANDOFFS,
  }),
  summary: (rt, { getConfig }) => {
    const config = getConfig();
    return {
      route: mainRoute(rt),
      workflow: (rt.listWorkflows?.() || []).find((pack) => pack.active) || null,
      outputStyle: rt.getOutputStyle?.()?.configured || null,
      profile: (({ title, language, experienceLevel }) => ({ title, language, experienceLevel }))(
        rt.getProfile?.() || {}
      ),
      features: {
        ...featureFlags(rt),
        browser: { active: builtinFeatureActive(config, 'browser') },
        computer: { active: builtinFeatureActive(config, 'computer') },
      },
      onboarding: rt.getOnboardingStatus?.() || null,
    };
  },
  model: (rt) => ({ route: mainRoute(rt), effortOptions: rt.effortOptions || [] }),
  agents: (rt) => ({
    agents: rt.listAgents?.() || [],
    orchestrationMode: rt.getOrchestrationMode(),
    orchestrationModes: ORCHESTRATION_MODES,
  }),
  workflow: (rt) => ({ workflows: rt.listWorkflows?.() || [] }),
  websearch: (rt) => ({
    route: rt.getWebSearchRoute?.() || null,
    enabled: rt.getToolModuleSettings?.()?.webSearch?.enabled !== false,
  }),
  'output-style': (rt) => rt.getOutputStyle?.() || {},
  profile: (rt) => {
    const profile = rt.getProfile?.() || {};
    return {
      title: profile.title || '',
      language: profile.language || 'system',
      experienceLevel: profile.experienceLevel || '',
      languages: (profile.languages || []).map((entry) => entry.id || entry),
      experienceLevels: (profile.experienceLevels || []).map((entry) => entry.id || entry),
    };
  },
  autoclear: (rt) => rt.getAutoClear?.() || {},
  compaction: (rt) => rt.getCompactionSettings?.() || {},
  memory: (rt) => ({ ...(rt.getToolModuleSettings?.()?.memory || {}), recap: rt.getRecapSettings?.() || null }),
  'local-provider': (rt) => rt.getToolModuleSettings().localProvider,
  features: (rt, { getConfig }) => {
    const config = getConfig();
    return {
      ...featureFlags(rt),
      browser: {
        active: builtinFeatureActive(config, 'browser'),
        firstUseApproval: builtinFirstUseApproval(config, 'browser'),
      },
      computer: {
        active: builtinFeatureActive(config, 'computer'),
        firstUseApproval: builtinFirstUseApproval(config, 'computer'),
      },
    };
  },
  shell: (rt) => rt.getSystemShell?.() || {},
  providers: async (rt) => publicProviderRows(await rt.getProviderSetup?.({})),
  mcp: (rt) => mcpRows(rt.mcpStatus?.()),
  skills: (rt) => ({ ...(rt.skillsStatus?.() || {}), disabled: rt.getDisabledSkills?.()?.disabled || [] }),
  plugins: (rt) => rt.pluginsStatus?.() || {},
  update: (rt) => rt.getUpdateSettings?.() || {},
  onboarding: (rt) => rt.getOnboardingStatus?.() || {},
  schedules: automationStatus,
  webhooks: automationStatus,
};

// Shape validation shared by every action: the action enum, the JSON
// schema, the per-action field list and the route/object-argument minimums.
function validateSetupInput(args) {
  const action = requireEnum(args?.action, SETUP_ACTIONS, 'action');
  const validationError = schemaValueError({ ...args, action }, SETUP_TOOL_DEFS[0].inputSchema, 'setup');
  if (validationError) throw new Error(`[tool-input-validation] ${validationError}`);
  const fields = SETUP_ACTION_FIELDS[action].split(' ').filter(Boolean);
  const allowed = fields.map((field) => field.replace(/\?$/, ''));
  const extras = Object.keys(args).filter((field) => field !== 'action' && !allowed.includes(field));
  if (extras.length)
    throw new Error(`[tool-input-validation] setup.${action} does not accept field(s): ${extras.join(', ')}`);
  const missing = fields.find((field) => !field.endsWith('?') && !Object.hasOwn(args, field));
  if (missing) throw new Error(`[tool-input-validation] ${missing} is required for setup.${action}`);
  if (args.route) {
    if (!Object.keys(args.route).length)
      throw new Error('route with at least one of the supported settings is required');
    if (action !== 'set_agent_route' && Object.hasOwn(args.route, 'disabled')) {
      throw new Error('route.disabled is only accepted by set_agent_route');
    }
    if (action !== 'set_route' && Object.hasOwn(args.route, 'contextPercent')) {
      throw new Error('route.contextPercent is only accepted by set_route');
    }
  }
  for (const field of ['desktop', 'appearance', 'webhook', 'compaction']) {
    if (args[field] && !Object.keys(args[field]).length) throw new Error(`${field} requires at least one setting`);
  }
  return action;
}

function mcpServerInput(args) {
  const server = args.server && typeof args.server === 'object' ? args.server : null;
  if (!server) throw new Error('server object is required');
  validateMcpInput(server);
  return server;
}

const DESKTOP_HOSTED_FEATURES = ['browser', 'computer', 'voice'];
const SETUP_INSTALLABLE_FEATURES = ['git', 'memory', 'office', 'tidy', 'localProvider', 'browser', 'computer', 'voice'];

// Action handlers: (rt, args, { requestDesktop, readStatus, openSurface }).
// `rt` is null for `status` and `open`, which never touch the facade.
const SETUP_ACTION_HANDLERS = {
  status: async (_rt, args, { readStatus, requestDesktop }) => {
    const domain = clean(args.domain) || 'summary';
    requireEnum(domain, SETUP_STATUS_DOMAINS, 'domain');
    return { domain, ...(await readStatus(domain, requestDesktop)) };
  },
  open: (_rt, args, { openSurface }) => openSurface(args.target),
  set_route: async (rt, args) => {
    const route = routeInput(args.route);
    const next = await rt.setRoute(route);
    return { route: next, appliesTo: 'next session (a conversation keeps its frozen route)' };
  },
  set_agent_route: async (rt, args) => {
    const agent = requireText(args.agent, 'agent');
    const route = routeInput(args.route);
    return { agent, route: await rt.setAgentRoute(agent, route) };
  },
  set_web_search_route: async (rt, args) => ({ route: await rt.setWebSearchRoute(routeInput(args.route)) }),
  set_workflow: (rt, args) => rt.setWorkflow(requireText(args.workflow, 'workflow')),
  set_output_style: async (rt, args) => {
    const result = await rt.setOutputStyle(requireText(args.style, 'style'));
    return {
      configured: result?.configured || null,
      appliedToCurrentSession: result?.appliedToCurrentSession === true,
    };
  },
  set_profile: (rt, args) => {
    const profile = args.profile && typeof args.profile === 'object' ? args.profile : null;
    if (!profile || !Object.keys(profile).length)
      throw new Error('profile with title, language, or experienceLevel is required');
    const result = rt.setProfile(profile);
    return {
      title: result.title || '',
      language: result.language || 'system',
      experienceLevel: result.experienceLevel || '',
    };
  },
  set_autoclear: (rt, args) => {
    const input = args.autoclear && typeof args.autoclear === 'object' ? args.autoclear : null;
    if (!input || !Object.keys(input).length)
      throw new Error('autoclear with enabled, duration, or provider is required');
    if (input.resetProvider && !clean(input.provider)) throw new Error('resetProvider requires provider');
    if (input.reset && input.provider) throw new Error('Use resetProvider for a provider override');
    if (input.duration && (input.reset || input.resetProvider))
      throw new Error('Cannot reset and set a duration together');
    return rt.setAutoClear(input);
  },
  set_compaction: (rt, args) => {
    const compaction = args.compaction || {};
    if (args.enabled === undefined && !Object.keys(compaction).length)
      throw new Error('enabled or compaction is required');
    if (Object.hasOwn(compaction, 'mainBufferTokens') && Object.hasOwn(compaction, 'mainBufferPercent')) {
      throw new Error('Choose mainBufferTokens or mainBufferPercent, not both');
    }
    return {
      ...rt.setCompactionSettings({ ...compaction, ...(args.enabled === undefined ? {} : { auto: args.enabled }) }),
      appliedToCurrentSession: true,
    };
  },
  set_memory_enabled: (rt, args) => rt.setMemoryToolsEnabled(requireBoolean(args.enabled)),
  set_recap_enabled: (rt, args) => rt.setRecapEnabled(requireBoolean(args.enabled)),
  set_web_search_enabled: (rt, args) => rt.setWebSearchEnabled(requireBoolean(args.enabled)),
  set_builtin_enabled: (rt, args, { requestDesktop }) => {
    const name = requireEnum(args.name, SETUP_BUILTIN_TOGGLE_FEATURES, 'name');
    if (DESKTOP_HOSTED_FEATURES.includes(name)) return requestDesktop(args);
    return rt.setBuiltinToolEnabled(name, requireBoolean(args.enabled));
  },
  set_first_use_approval: (rt, args) => {
    const name = requireEnum(args.name, ['browser', 'computer'], 'name');
    return rt.setBridgeFirstUseApproval(name, requireBoolean(args.enabled));
  },
  install_builtin: (rt, args, { requestDesktop }) => {
    const name = requireEnum(args.name, SETUP_INSTALLABLE_FEATURES, 'name');
    if (DESKTOP_HOSTED_FEATURES.includes(name)) return requestDesktop(args);
    return rt.installBuiltinFeature(name);
  },
  install_local_model: async (rt, args) =>
    (await rt.installLocalProviderModel(requireText(args.modelId, 'modelId'))).localProvider,
  start_local_installation: async (rt, args) => {
    const phase = requireEnum(args.phase, ['runtime', 'model'], 'phase');
    const result = await rt.startLocalProviderInstallation(
      phase,
      phase === 'model' ? requireText(args.modelId, 'modelId') : args.modelId
    );
    return { background: true, ...result.localProvider };
  },
  cancel_local_installation: async (rt, args) =>
    (await rt.cancelLocalProviderInstallation(requireText(args.jobId, 'jobId'))).localProvider,
  set_local_idle_ttl: async (rt, args) => (await rt.setLocalProviderIdleTtl(args.idleTtlSeconds)).localProvider,
  search_local_models: (rt, args) => rt.searchLocalProviderModels(requireText(args.query, 'query')),
  inspect_hf_model: (rt, args) =>
    rt.inspectHuggingFaceModel({
      repository: requireText(args.repository, 'repository'),
      filename: args.filename,
      contextWindow: args.contextWindow,
    }),
  register_hf_model: (rt, args) =>
    rt.registerHuggingFaceModel(
      requireText(args.previewId, 'previewId'),
      requireBoolean(args.licenseAccepted, 'licenseAccepted')
    ),
  local_model_details: (rt, args) => rt.getLocalProviderModelDetails(requireText(args.modelId, 'modelId')),
  maintain_local_model: (rt, args) =>
    rt.startLocalProviderModelMaintenance(
      requireText(args.modelId, 'modelId'),
      requireEnum(args.operation, ['verify', 'repair'], 'operation')
    ),
  delete_local_model: (rt, args) =>
    rt.deleteLocalProviderModel(requireText(args.confirmationToken, 'confirmationToken')),
  set_system_shell: (rt, args) => rt.setSystemShell({ command: clean(args.command) }),
  set_auto_update: (rt, args) => rt.setAutoUpdate(requireBoolean(args.enabled)),
  forget_provider_auth: (rt, args) => rt.forgetProviderAuth(requireText(args.name, 'name')),
  add_mcp_server: async (rt, args) => {
    const server = mcpServerInput(args);
    requireText(server.name, 'server.name');
    if (!clean(server.command) && !clean(server.url)) throw new Error('server.command or server.url is required');
    const result = await rt.addMcpServer(server);
    return { name: result?.name, mcp: mcpRows(result?.status) };
  },
  save_mcp_server: async (rt, args) => {
    const server = mcpServerInput(args);
    requireText(server.originalName || server.name, 'server.name or server.originalName');
    const result = await rt.saveMcpServer(server);
    return { name: result?.name, mcp: mcpRows(result?.status) };
  },
  remove_mcp_server: async (rt, args) => ({ mcp: mcpRows(await rt.removeMcpServer(requireText(args.name, 'name'))) }),
  set_mcp_enabled: async (rt, args) => ({
    mcp: mcpRows(await rt.setMcpServerEnabled(requireText(args.name, 'name'), requireBoolean(args.enabled))),
  }),
  reconnect_mcp: async (rt) => ({ mcp: mcpRows(await rt.reconnectMcp()) }),
  set_disabled_skills: (rt, args) => {
    if (!Array.isArray(args.skills)) throw new Error('skills (array of names) is required');
    return rt.setDisabledSkills(args.skills.map(clean).filter(Boolean));
  },
  set_extension_scope: async (rt, args) => {
    const kind = requireEnum(args.kind, ['skills', 'mcp', 'plugins'], 'kind');
    const projects = args.projects.map(clean);
    const status = await rt.setExtensionScope(kind, requireText(args.name, 'name'), projects);
    if (kind === 'mcp') return { mcp: mcpRows(status) };
    return status || {};
  },
  add_plugin: async (rt, args) => ({
    plugin: (await rt.addPlugin(requireText(args.source, 'source')))?.plugin || null,
  }),
  update_plugin: async (rt, args) => ({
    plugin: (await rt.updatePlugin(requireText(args.name, 'name')))?.plugin || null,
  }),
  set_plugin_enabled: async (rt, args) => ({
    plugin: (await rt.setPluginEnabled(requireText(args.name, 'name'), requireBoolean(args.enabled)))?.plugin || null,
  }),
  remove_plugin: async (rt, args) => ({
    plugin: (await rt.removePlugin(requireText(args.name, 'name')))?.plugin || null,
  }),
};

const READ_ONLY_SETUP_ACTIONS = new Set([
  'status',
  'open',
  'list_models',
  'get_mcp_server',
  'read_definition',
  'get_instructions',
  'search_local_models',
  'inspect_hf_model',
  'local_model_details',
]);
// Actions that start or steer work rather than saving a setting.
const BACKGROUND_SETUP_ACTIONS = new Set([
  'start_local_installation',
  'maintain_local_model',
  'cancel_local_installation',
  'reconnect_mcp',
]);

function setupMutationReceipt(action, result) {
  return JSON.stringify(
    {
      ...(BACKGROUND_SETUP_ACTIONS.has(action) ? {} : { saved: true }),
      scope: 'installation',
      appliesTo: ACTION_APPLIES_TO[action] || 'new sessions unless appliedToCurrentSession is true',
      ...result,
    },
    null,
    2
  );
}

export function createSetupToolExecutor({ getApi, getConfig, notifySessionUi, getSessionId, flushSettings }) {
  const desktop = createSetupUiRequests({ notifySessionUi, getSessionId });
  const api = () => {
    const facade = getApi?.();
    if (!facade) throw new Error('setup: runtime facade is not ready');
    return facade;
  };

  async function readStatus(domain, requestDesktop) {
    const rt = api();
    if (SETUP_DESKTOP_DOMAINS.includes(domain)) return requestDesktop({ action: 'status', domain });
    if (!Object.hasOwn(SETUP_STATUS_READERS, domain)) throw new Error(`setup: unknown status domain "${domain}"`);
    return SETUP_STATUS_READERS[domain](rt, { domain, getConfig: () => getConfig?.() || {} });
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

  async function execute(args = {}, { signal } = {}) {
    signal?.throwIfAborted();
    const requestDesktop = (request) => desktop.request(request, { signal });
    const action = validateSetupInput(args);
    const rt = action === 'status' || action === 'open' ? null : api();
    if (!Object.hasOwn(SETUP_ACTION_HANDLERS, action)) return executeExtendedSetupAction(rt, args, requestDesktop);
    return SETUP_ACTION_HANDLERS[action](rt, args, { requestDesktop, readStatus, openSurface });
  }

  return {
    claimSetupRequest: desktop.claimSetupRequest,
    isSetupRequestActive: desktop.isSetupRequestActive,
    completeSetupRequest: desktop.completeSetupRequest,
    dispose: desktop.dispose,
    async execute(args = {}, options = {}) {
      const result = await execute(args, options);
      if (READ_ONLY_SETUP_ACTIONS.has(args.action)) return JSON.stringify(result ?? {}, null, 2);
      await flushSettings?.();
      return setupMutationReceipt(args.action, result);
    },
  };
}
