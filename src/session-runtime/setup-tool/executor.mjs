/** `setup` tool dispatch. Every mutation goes through the runtime facade the
 *  TUI/Desktop settings surfaces already use, so normalization, MCP
 *  reconnects, and the empty-session tool-policy refresh all apply exactly as
 *  they do for a UI click. The facade is read lazily because runtime-core
 *  registers the tool executor before it finishes assembling the API object. */
import { builtinFeatureActive } from '../../runtime/agent/orchestrator/runtime-core/builtin-features.mjs';
import { ORCHESTRATION_MODES } from '../../runtime/shared/orchestration.mjs';
import { AUTO_EFFORT_BASES } from '../../runtime/agent/orchestrator/providers/auto-effort.mjs';
import { INSTRUCTION_FILES_MODES } from '../../runtime/shared/instruction-files-mode.mjs';
import {
  normalizeHeartbeatIntervalMinutes,
  requireHeartbeatIntervalMinutes,
} from '../../runtime/shared/heartbeat-interval.mjs';
import { MEDIA_KINDS } from '../../runtime/media/tool-defs.mjs';
import { SETUP_DESKTOP_DOMAINS, SETUP_HANDOFFS } from './settings-contract.mjs';
import { executeExtendedSetupAction, publicAutomation, publicHookRule, validateMcpInput } from './extended-actions.mjs';
import {
  assertAgentEditorAccess,
  assertHeartbeatSetupAction,
  assertInteractiveCaller,
  assertOwnAgentSettings,
  scheduleCallerScope,
} from '../services/schedule-access.mjs';
import { SETUP_DESKTOP_UNCLAIMED, createSetupUiRequests } from './ui-requests.mjs';
import {
  SETUP_ACTIONS,
  SETUP_ACTION_FIELDS,
  SETUP_OPEN_TARGETS,
  SETUP_STATUS_DOMAINS,
  SETUP_TOOL_DEFS,
  SETUP_BUILTIN_TOGGLE_FEATURES,
} from './tool-defs.mjs';
import { schemaValueError } from '../../runtime/shared/schema-value-error.mjs';
import { clean } from '../../runtime/agent/orchestrator/runtime-core/session-text.mjs';
import { CONNECTOR_IDS, connectorById } from '../../runtime/shared/connector-catalog.mjs';
import profileConfig from '../../runtime/shared/profile-config.cjs';
import { SESSION_ROUTE_HANDLERS, routePositionsStatus } from './session-route-actions.mjs';
import { AGENT_SETTINGS_HANDLERS } from './agent-settings-actions.mjs';
import {
  routeFallbackPosition,
  sessionChainSource,
  sessionRoutePrimary,
} from '../../runtime/agent/orchestrator/session/manager/route-fallback-chain.mjs';
import { sameRouteModel } from '../../runtime/agent/orchestrator/session/manager/owner-route-fallbacks.mjs';

const AGENT_DEFINITION_ACTIONS = new Set([
  'create_definition',
  'save_definition',
  'delete_definition',
  'restore_definition',
]);
// Actions on one agent's own settings: another agent's thread changes only its own.
const OWN_AGENT_ACTIONS = new Set([
  'set_agent_route',
  'set_agent_permission',
  'set_agent_connector',
  'set_agent_connector_tool',
]);

// How a fallback chain edit reaches sessions that already run (route-fallback-chain.mjs).
const CHAIN_APPLIES =
  'a changed fallback chain reaches running sessions on that route from their next fallback hop ([] stops further hops at once; the turn ends with the provider error)';

const PROFILE_VALUE_IDS = Object.freeze({
  language: profileConfig.PROFILE_LANGUAGES.map((entry) => entry.id),
  experienceLevel: ['', ...profileConfig.PROFILE_EXPERIENCE_LEVELS.map((entry) => entry.id)],
});

const ACTION_APPLIES_TO = {
  set_route: `new sessions (an established conversation keeps its model); ${CHAIN_APPLIES}: Lead conversations and agents that inherit Main`,
  set_agent_route: `the bot's chats from their next turn (a running turn finishes on the old model); ${CHAIN_APPLIES}: its chats and sub-agents; an agent switched on or off reaches open conversations from their next turn as an agent list reminder`,
  reset_route_fallback:
    'each listed session from its next turn (a running turn finishes on its fallback model): it returns to its primary and its chain starts over',
  continue_in_model: 'that session now; its stopped turn is not resent',
  schedule_quota_resume: "that session's stopped turn, resent at the provider's reset time",
  cancel_quota_resume: 'that session: its pending resume is dropped; the turn stays stopped',
  set_cache_warming_enabled: 'the next prompt-cache warm of every session; no restart required',
  set_agent_permission: "that agent's next action of the kind, in every session",
  set_agent_connector: "that agent's next connector tool call, in every session",
  set_agent_connector_tool: "that agent's next call of the tool, in every session",
  set_project_connector: 'the next connector tool call of sessions in that Project',
  restore_definition: 'now: the bot and its chat return; its routines stay off',
  set_bot_order: 'the Bots page and the Sessions bot section on every device',
  set_orchestration_mode:
    "new sessions and an empty current one (the default mode); a conversation keeps its own mode until it is switched with the composer's mode selector",
  set_recap_enabled: 'background Memory cycles; no restart required',
  set_auto_update: 'subsequent automatic update checks',
  set_ai_session_titles: 'titles generated from now on; existing titles are unchanged',
  set_quota_auto_resume: 'subsequent usage-limit stops; turning it off cancels pending resumes',
  set_model_preferences: 'the /model picker and model management lists',
  set_heartbeat_enabled: "Mixy's next heartbeat check; no restart required",
  set_heartbeat_interval:
    "Mixy's heartbeat from the next tick: the next check is due the new interval after the last one; no restart required",
  set_reactions_enabled:
    "bots' chats; while off a reaction is refused at once and new chats are not offered the tool; reactions already left stay visible",
  set_worktree_settings: 'new tasks and worktrees created afterwards; existing worktrees are unchanged',
  set_system_shell: 'subsequent shell calls',
  save_automation: 'the automation worker; scheduled runs follow the saved timing',
  delete_automation: 'future automation runs',
  set_automation_enabled: 'future automation runs',
  run_automation: "one run now; its result posts into the owning agent's thread",
  set_webhook_config: 'the webhook worker after configuration reload',
  add_hook_rule: 'subsequent tool calls; no restart required',
  set_hook_rule_enabled: 'subsequent tool calls; no restart required',
  delete_hook_rule: 'subsequent tool calls; no restart required',
  set_media_default: 'media generations that name no lane/model; lane "" returns the kind to Auto',
};

const OPEN_TARGET_HINTS = Object.freeze({
  settings: 'Desktop: Settings (Ctrl+,) · TUI: /setting',
  providers: 'Desktop: Settings → Providers · TUI: /providers',
  model: 'Desktop: session header model picker · TUI: /model',
  websearch: 'Desktop: Workflows → Web Search · TUI: /websearch',
  workflow: 'Desktop: Workflows · TUI: /workflow',
  agents: 'Desktop: Workflows → Agents · TUI: /agents',
  outputstyle: 'Desktop: Settings → Output style · TUI: /OutputStyle',
  theme: 'Desktop: Settings → Theme · TUI: /theme',
  profile: 'Desktop: Settings → General → Profile · TUI: /profile',
  autoclear: 'Desktop: Settings → Context · TUI: /autoclear',
  memory:
    'Desktop: Extensions tab → Built-in (Memory); core memories under Projects → project → Memories · TUI: /memory',
  mcp: 'Desktop: Extensions → Connectors tab · TUI: /mcp',
  skills: 'Desktop: Skills (activity rail) · TUI: /skills',
  plugins:
    'Desktop: Extensions → Extensions tab (plugins that bring MCP servers: Connectors tab → Custom connectors) · TUI: /plugins',
  update: 'Desktop: Settings → System → Update · TUI: /update',
  usage: 'Desktop: /usage in the composer · TUI: /usage',
  doctor: 'Desktop: Settings → System → Doctor, or /doctor in the composer · TUI: /doctor',
  context: 'Desktop: /context in the composer · TUI: /context',
  developer: 'Desktop: Settings → Developer options · TUI: /setting → Developer',
  voice: 'Desktop: Extensions tab → Built-in (Voice) · TUI: /setting → Voice',
  connection: 'Desktop only: Settings → Connection',
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
  if (typeof source.autoEffort === 'boolean') next.autoEffort = source.autoEffort;
  if (Object.hasOwn(source, 'modelParameters')) next.modelParameters = { ...source.modelParameters };
  if (Object.hasOwn(source, 'contextPercent')) next.contextPercent = source.contextPercent;
  if (Object.hasOwn(source, 'contextTokens')) next.contextTokens = source.contextTokens;
  if (Object.hasOwn(source, 'disabled')) next.disabled = source.disabled;
  if (Object.hasOwn(source, 'fallbacks')) next.fallbacks = source.fallbacks.map(routeInput);
  return next;
}

/** A fallback chain edit's receipt: whether the calling conversation now
 *  follows the saved chain, and the position it reads it from. `owner` is
 *  whose route was edited: `{ kind: 'lead' }` (set_route) or `{ kind: 'bot',
 *  agent }` (set_agent_route); only a caller whose chain comes from that
 *  route's settings follows it. */
function chainReceipt(route, { caller, getConfig }, owner) {
  if (!Object.hasOwn(route, 'fallbacks') || !caller?.agent) return {};
  const config = getConfig();
  const position = routeFallbackPosition(caller, config);
  // Settings-sourced and still on that route's primary: a conversation left on
  // a previous model follows no chain, whatever the saved one is.
  const source = sessionChainSource(caller, config);
  const followsEdited =
    position.chainFrom === 'settings' &&
    sameRouteModel(source, sessionRoutePrimary(caller)) &&
    position.kind === owner.kind &&
    (owner.kind !== 'bot' || position.agent === owner.agent);
  const saved = route.fallbacks.map((entry) => `${entry.provider}/${entry.model}`);
  const followed = position.fallbacks.map((entry) => `${entry.provider}/${entry.model}`);
  return {
    appliedToCurrentSession: followsEdited && saved.join('\n') === followed.join('\n'),
    currentSession: position,
  };
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
    ...(setup?.managedByClient === true ? { managedByClient: true, unavailable: setup.unavailable === true } : {}),
    pendingSecrets: setup?.pendingSecrets === true,
    api: (setup?.api || []).map((row) =>
      pick(row, {
        source: apiKeySource(row),
        custom: row.custom === true,
        keyUrl: /^https:\/\//.test(String(row.url || '')) ? row.url : null,
      })
    ),
    oauth: (setup?.oauth || []).map((row) =>
      pick(row, {
        reauthRequired: row.reauthRequired === true,
        expiresAt: row.expiresAt || null,
        plan: row.plan || null,
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

/** Minimal provider rows for the model: only providers with a credential (or
 *  one needing re-authentication), counts instead of account rosters. Without
 *  `accountCount` (desktop-owned accounts) no counts are reported. */
function configuredProviderRows(rows, accountCount) {
  const providers = [];
  let notConfigured = 0;
  for (const [kind, list] of [
    ['api', rows.api],
    ['oauth', rows.oauth],
    ['local', rows.local],
  ]) {
    for (const row of list) {
      if (!row.authenticated && !row.reauthRequired) {
        notConfigured += 1;
        continue;
      }
      let accounts = {};
      if (kind === 'oauth' && accountCount) accounts = { accounts: row.authenticated ? accountCount(row.id) : 0 };
      providers.push({
        id: row.id,
        kind,
        authenticated: row.authenticated,
        status: row.status,
        ...(kind === 'oauth' ? { plan: row.plan || null } : {}),
        ...(row.reauthRequired ? { reauthRequired: true } : {}),
        ...accounts,
      });
    }
  }
  return { ...(rows.pendingSecrets ? { pendingSecrets: true } : {}), providers, notConfigured };
}

/** OAuth account roster without usage meters or provider-side identities. */
function publicAccounts(pool) {
  return {
    selectedId: pool.selectedId,
    auto: pool.auto,
    ...(pool.policy ? { policy: pool.policy } : {}),
    useCredits: pool.useCredits === true,
    accounts: pool.accounts.map(({ id, label, authenticated, reauthRequired }) => ({
      id,
      label,
      authenticated,
      reauthRequired,
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
      ...(server.owner?.kind === 'plugin'
        ? { plugin: server.owner.id, pluginServer: server.owner.key, disabledReason: server.disabledReason || null }
        : {}),
      error: server.error || null,
      ...(server.warnings?.length ? { warnings: server.warnings } : {}),
      scope: Array.isArray(server.scope) ? server.scope : null,
      ...(server.connector ? { connector: server.connector } : {}),
      // A multi-account connector's accounts: remove_mcp_server / sign-in take an account's name.
      ...(Array.isArray(server.accounts)
        ? {
            accounts: server.accounts.map((account) => ({
              name: account.name,
              email: account.email || '',
              ...(account.authRequired ? { authRequired: true } : {}),
              ...(account.error ? { error: account.error } : {}),
            })),
          }
        : {}),
    })),
    ...(status?.warnings?.length ? { warnings: status.warnings } : {}),
    ...(status?.declarationErrors?.length ? { declarationErrors: status.declarationErrors } : {}),
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
  contextTokens: rt.contextTokens ?? null,
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

// Summary keys per built-in; Auto Effort also reports machine support and
// judge-model readiness so a failed toggle or install is explainable.
const FEATURE_STATUS_KEYS = ['enabled', 'installed'];
const FEATURE_EXTRA_STATUS_KEYS = { autoEffort: ['supported', 'ready', 'installing'] };

async function featureStatus(rt, getConfig) {
  const config = getConfig();
  return {
    ...Object.fromEntries(
      Object.entries(rt.getToolModuleSettings?.() || {}).map(([name, settings]) => {
        // Scalar settings (instructionFiles mode) pass through as-is.
        if (!settings || typeof settings !== 'object') return [name, settings];
        const keys = [...FEATURE_STATUS_KEYS, ...(FEATURE_EXTRA_STATUS_KEYS[name] || [])];
        return [name, Object.fromEntries(Object.entries(settings).filter(([key]) => keys.includes(key)))];
      })
    ),
    browser: { active: builtinFeatureActive(config, 'browser') },
    computer: { active: builtinFeatureActive(config, 'computer') },
    terminal: { active: builtinFeatureActive(config, 'terminal') },
    heartbeat: {
      enabled: config?.heartbeat === true,
      intervalMinutes: normalizeHeartbeatIntervalMinutes(config?.heartbeatIntervalMinutes),
    },
    reactions: { enabled: config?.reactions !== false },
    voice: rt.getVoiceStatus ? voiceFeatureStatus(await rt.getVoiceStatus()) : null,
  };
}

async function mediaDefaults(rt) {
  const [pins, ...rows] = await Promise.all([
    rt.getMediaPins(),
    ...MEDIA_KINDS.map((kind) => rt.getMediaDefault(kind)),
  ]);
  const fieldsOf = (row, fields) => (row ? Object.fromEntries(fields.map((field) => [field, row[field]])) : null);
  return {
    // The default generator (Settings → Built-in → Media generation); null = Auto.
    pinned: Object.fromEntries(MEDIA_KINDS.map((kind) => [kind, fieldsOf(pins[kind], ['lane', 'model', 'account'])])),
    // The last generator used; applies only to a kind that is on Auto.
    remembered: Object.fromEntries(MEDIA_KINDS.map((kind, i) => [kind, fieldsOf(rows[i], ['lane', 'model'])])),
  };
}

function hookStatus(rt) {
  const status = rt.hooksStatus();
  return {
    enabled: status.enabled === true,
    configMode: status.configMode,
    rulesPath: status.rulesPath,
    ruleCount: status.ruleCount,
    rules: status.rules.map(publicHookRule),
    configuredEvents: status.configuredEvents,
    configSources: status.configSources,
    errors: status.errors,
    note: status.note,
  };
}

// status readers per non-desktop domain: (rt, { domain, getConfig }) → the
// public status shape. Desktop-hosted domains never reach this table.
const SETUP_STATUS_READERS = {
  capabilities: () => ({
    actions: SETUP_ACTION_FIELDS,
    domains: SETUP_STATUS_DOMAINS,
    desktopScope: 'desktop-host; requires this conversation open in the local Desktop window',
    handoffs: SETUP_HANDOFFS,
  }),
  summary: async (rt, { getConfig }) => ({
    route: mainRoute(rt),
    workflow: (rt.listWorkflows?.() || []).find((pack) => pack.active) || null,
    outputStyle: rt.getOutputStyle?.()?.configured || null,
    profile: (({ title, language, experienceLevel }) => ({ title, language, experienceLevel }))(
      rt.getProfile?.() || {}
    ),
    features: await featureStatus(rt, getConfig),
    onboarding: rt.getOnboardingStatus?.() || null,
  }),
  model: (rt, { getConfig, caller }) => ({
    route: {
      ...mainRoute(rt),
      autoEffort: rt.autoEffort !== false,
      // The Lead preset (workflow-lead) holds the Lead route's fallback chain, as the Workflows page reads it.
      fallbacks: (rt.listPresets?.() || []).find((preset) => preset?.id === 'workflow-lead')?.fallbacks || [],
    },
    effortOptions: rt.effortOptions || [],
    // Where this conversation and the other Lead conversations are on their chain.
    ...routePositionsStatus({ caller, config: getConfig(), keep: (row) => row.kind === 'lead' }),
  }),
  agents: (rt, { getConfig, caller }) => ({
    agents: rt.listAgents?.() || [],
    orchestrationMode: rt.getOrchestrationMode(),
    orchestrationModes: ORCHESTRATION_MODES,
    ...(rt.getBotOrder ? { botOrder: rt.getBotOrder().order } : {}),
    // Bot chats and sub-agents on their fallback chains.
    sessions: routePositionsStatus({ caller, config: getConfig(), keep: (row) => row.kind !== 'lead' }).sessions,
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
  compaction: (rt) => ({
    ...(rt.getCompactionSettings?.() || {}),
    ...(rt.getSessionTitleSettings?.() || {}),
    ...(rt.getCacheWarmingSettings ? { promptCacheWarming: rt.getCacheWarmingSettings().enabled } : {}),
  }),
  memory: (rt) => ({ ...(rt.getToolModuleSettings?.()?.memory || {}), recap: rt.getRecapSettings?.() || null }),
  'local-provider': (rt) => rt.getToolModuleSettings().localProvider,
  features: (rt, { getConfig }) => featureStatus(rt, getConfig),
  shell: (rt) => rt.getSystemShell?.() || {},
  providers: async (rt, { detail }) => {
    const rows = publicProviderRows(await rt.getProviderSetup?.({}));
    const quotaResume = rt.getQuotaAutoResume ? { quotaAutoResume: rt.getQuotaAutoResume() } : {};
    // Client mode: the desktop owns accounts, so the server roster is never read.
    if (rows.managedByClient) {
      if (detail) return { ...rows, ...quotaResume };
      return { managedByClient: true, unavailable: rows.unavailable, ...configuredProviderRows(rows), ...quotaResume };
    }
    if (!detail) {
      return { ...configuredProviderRows(rows, (id) => rt.getProviderAccounts(id).accounts.length), ...quotaResume };
    }
    Object.assign(rows, quotaResume);
    rows.oauth = rows.oauth.map((row) =>
      row.authenticated ? { ...row, accounts: publicAccounts(rt.getProviderAccounts(row.id)) } : row
    );
    return rows;
  },
  developer: (rt) => rt.getDeveloperSettings(),
  mcp: (rt) => mcpRows(rt.mcpStatus?.()),
  skills: (rt) => ({ ...(rt.skillsStatus?.() || {}), disabled: rt.getDisabledSkills?.()?.disabled || [] }),
  plugins: (rt) => rt.pluginsStatus?.() || {},
  update: (rt) => rt.getUpdateSettings?.() || {},
  onboarding: (rt) => rt.getOnboardingStatus?.() || {},
  worktree: (rt) => rt.getWorktreeSettings(),
  schedules: automationStatus,
  webhooks: automationStatus,
  hooks: hookStatus,
  media: mediaDefaults,
};

// Shape validation shared by every action: the action enum, the JSON
// schema, the per-action field list and the route/object-argument minimums.
function validateSetupInput(args) {
  const action = requireEnum(args?.action, SETUP_ACTIONS, 'action');
  // Old callers still ask to connect GitHub: it is the signed-in GitHub CLI, not a catalog connector.
  if (
    action === 'connect_connector' &&
    String(args.connector ?? '')
      .trim()
      .toLowerCase() === 'github'
  ) {
    throw new Error(
      'GitHub uses the signed-in GitHub CLI; no connector needed. Use the github tool or Settings → Git.'
    );
  }
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
    if (
      Object.hasOwn(args.route, 'fallbacks') &&
      !['set_route', 'set_agent_route', 'set_web_search_route'].includes(action)
    ) {
      throw new Error('route.fallbacks is only accepted by set_route, set_agent_route and set_web_search_route');
    }
    for (const field of ['contextPercent', 'contextTokens', 'autoEffort']) {
      if (action !== 'set_route' && action !== 'set_agent_route' && Object.hasOwn(args.route, field)) {
        throw new Error(`route.${field} is only accepted by set_route and set_agent_route`);
      }
    }
  }
  for (const field of ['desktop', 'appearance', 'webhook', 'compaction', 'providerAccount', 'worktree']) {
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

const DESKTOP_HOSTED_FEATURES = ['browser', 'computer'];

const publicVoice = (status) => ({
  enabled: status.enabled === true,
  installed: status.installed === true,
  components: status.components,
});
const voiceFeatureStatus = (status) => ({ ...publicVoice(status), installing: status.busy === true });

// Voice runs on the runtime toggle the Desktop Built-in card also uses:
// enabling installs any missing whisper/ffmpeg component first.
async function setVoice(rt, enabled) {
  const { status, error } = await rt.setVoiceEnabled(enabled);
  if (status.enabled !== enabled || (enabled && status.installed !== true)) {
    throw new Error(
      `Voice did not reach the requested ${enabled ? 'installed and enabled' : 'disabled'} state${error ? `: ${error}` : ''}`
    );
  }
  return { voice: publicVoice(status), appliesTo: 'channel voice transcription and Desktop dictation now' };
}

// Git and Office installs bring their system dependency (Git, LibreOffice) in
// through the Desktop's guided installers, the same steps as the Built-in card.
// A request no Desktop window takes keeps the runtime-only install.
const DESKTOP_PREPARED_FEATURES = ['git', 'office'];
const SETUP_INSTALLABLE_FEATURES = [
  'git',
  'memory',
  'office',
  'tidy',
  'localProvider',
  'autoEffort',
  'browser',
  'computer',
  'voice',
];

// Action handlers: (rt, args, { requestDesktop, readStatus, openSurface }).
// `rt` is null for `status` and `open`, which never touch the facade.
const SETUP_ACTION_HANDLERS = {
  status: async (_rt, args, { readStatus, requestDesktop, caller }) => {
    const domain = clean(args.domain) || 'summary';
    requireEnum(domain, SETUP_STATUS_DOMAINS, 'domain');
    return { domain, ...(await readStatus(domain, requestDesktop, args.detail === true, caller)) };
  },
  open: (_rt, args, { openSurface }) => openSurface(args.target),
  set_route: async (rt, args, context) => {
    const route = routeInput(args.route);
    const next = await rt.setRoute(route, { keepMainModel: false });
    return { route: next, ...chainReceipt(args.route, context, { kind: 'lead' }) };
  },
  set_agent_route: async (rt, args, context) => {
    const agent = requireText(args.agent, 'agent');
    const route = routeInput(args.route);
    return {
      agent,
      route: await rt.setAgentRoute(agent, route),
      ...chainReceipt(args.route, context, { kind: 'bot', agent }),
    };
  },
  ...SESSION_ROUTE_HANDLERS,
  ...AGENT_SETTINGS_HANDLERS,
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
    for (const [field, ids] of Object.entries(PROFILE_VALUE_IDS)) {
      if (Object.hasOwn(profile, field) && !ids.includes(profile[field])) {
        throw new Error(`profile.${field} must be one of ${ids.map((id) => JSON.stringify(id)).join(', ')}`);
      }
    }
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
  set_instruction_files: (rt, args) =>
    rt.setInstructionFiles(requireEnum(args.instructionFiles, INSTRUCTION_FILES_MODES, 'instructionFiles')),
  set_auto_effort_base: (rt, args) =>
    rt.setAutoEffortBase(requireEnum(args.autoEffortBase, AUTO_EFFORT_BASES, 'autoEffortBase')),
  set_builtin_enabled: (rt, args, { requestDesktop }) => {
    const name = requireEnum(args.name, SETUP_BUILTIN_TOGGLE_FEATURES, 'name');
    if (DESKTOP_HOSTED_FEATURES.includes(name)) return requestDesktop(args);
    if (name === 'voice') return setVoice(rt, requireBoolean(args.enabled));
    return rt.setBuiltinToolEnabled(name, requireBoolean(args.enabled));
  },
  install_builtin: async (rt, args, { requestDesktop }) => {
    const name = requireEnum(args.name, SETUP_INSTALLABLE_FEATURES, 'name');
    if (DESKTOP_HOSTED_FEATURES.includes(name)) return requestDesktop(args);
    if (name === 'voice') return setVoice(rt, true);
    if (DESKTOP_PREPARED_FEATURES.includes(name)) {
      try {
        return await requestDesktop(args);
      } catch (error) {
        if (error?.code !== SETUP_DESKTOP_UNCLAIMED) throw error;
      }
    }
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
  set_ai_session_titles: (rt, args) => rt.setAiSessionTitles(requireBoolean(args.enabled)),
  set_quota_auto_resume: async (rt, args) => ({
    quotaAutoResume: await rt.setQuotaAutoResume(requireBoolean(args.enabled)),
  }),
  set_model_preferences: async (rt, args) => {
    const change = { model: requireText(args.model, 'model') };
    for (const key of ['hidden', 'favorite'])
      if (Object.hasOwn(args, key)) change[key] = requireBoolean(args[key], key);
    if (Object.keys(change).length === 1) throw new Error('hidden or favorite is required');
    return rt.setModelPreferences(requireText(args.provider, 'provider'), [change]);
  },
  set_heartbeat_enabled: (rt, args) => rt.setHeartbeatEnabled(requireBoolean(args.enabled)),
  set_heartbeat_interval: (rt, args) => rt.setHeartbeatInterval(requireHeartbeatIntervalMinutes(args.minutes)),
  set_reactions_enabled: (rt, args) => rt.setReactionsEnabled(requireBoolean(args.enabled)),
  set_worktree_settings: (rt, args) => rt.setWorktreeSettings(args.worktree),
  forget_provider_auth: async (rt, args) => {
    const name = requireText(args.name, 'name');
    const setup = await rt.getProviderSetup({});
    if (setup?.managedByClient) throw new Error('Manage provider accounts in the local desktop window.');
    if (!(setup?.oauth || []).some((row) => row.id === name)) {
      if (Object.hasOwn(args, 'accountId')) throw new Error('accountId applies only to OAuth providers');
      return rt.forgetProviderAuth(name);
    }
    const { accounts } = rt.getProviderAccounts(name);
    if (!accounts.length) throw new Error(`${name} has no connected account`);
    if (!Object.hasOwn(args, 'accountId') && accounts.length > 1) {
      throw new Error(`${name} has ${accounts.length} accounts; pass accountId from status providers`);
    }
    const accountId = Object.hasOwn(args, 'accountId') ? requireText(args.accountId, 'accountId') : accounts[0].id;
    return { ...(await rt.forgetProviderAuth(name, accountId)), accountId };
  },
  set_provider_account: async (rt, args) => {
    if ((await rt.getProviderSetup?.({}))?.managedByClient) {
      throw new Error('Manage provider accounts in the local desktop window.');
    }
    return publicAccounts(await rt.updateProviderAccounts(requireText(args.name, 'name'), args.providerAccount));
  },
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
  reconnect_mcp: async (rt, args) => ({ mcp: mcpRows(await rt.reconnectMcp(clean(args.name) || undefined)) }),
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
  // The chat path of the one-click connect: the attached Desktop renders this
  // call as a connect card (agent-chat connector card) that runs the same flow
  // as Extensions → 커넥터. Nothing is connected here.
  connect_connector: async (rt, args) => {
    const entry = connectorById(requireText(args.connector, 'connector'));
    if (!entry) throw new Error(`connector must be one of ${CONNECTOR_IDS.join(', ')}`);
    const server = (rt.mcpStatus?.()?.servers || []).find((row) => row.connector === entry.id) || null;
    const connected = server?.connected === true;
    return {
      connector: entry.id,
      name: entry.name,
      backend: entry.backend.kind,
      ...(server ? { server: server.name } : {}),
      connected,
      note: connected
        ? `${entry.name} is already connected.`
        : `A connect card for ${entry.name} is shown in this conversation; the user presses it (Desktop: Extensions → 커넥터). Check status mcp afterwards.`,
    };
  },
  enable_plugin_mcp: async (rt, args) => {
    const name = requireText(args.name, 'name');
    const plugin = ((await rt.pluginsStatus())?.plugins || []).find((row) => row.name === name || row.id === name);
    if (!plugin) throw new Error(`plugin "${name}" not found`);
    const result = await rt.enablePluginMcp(plugin);
    return {
      serverName: result.serverName,
      ...(result.serverNames ? { serverNames: result.serverNames } : {}),
      mcp: mcpRows(result.status),
    };
  },
};

const READ_ONLY_SETUP_ACTIONS = new Set([
  'status',
  'open',
  'list_models',
  'get_mcp_server',
  'connect_connector',
  'read_definition',
  'search_local_models',
  'inspect_hf_model',
  'local_model_details',
  'read_agent_settings',
  'read_project_connectors',
]);
// Actions that start or steer work rather than saving a setting.
const BACKGROUND_SETUP_ACTIONS = new Set([
  'start_local_installation',
  'maintain_local_model',
  'cancel_local_installation',
  'reconnect_mcp',
  'run_automation',
  'reset_route_fallback',
  'continue_in_model',
  'schedule_quota_resume',
  'cancel_quota_resume',
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

/** `getCallerSession(id)` returns the calling session's record (null when it
 *  cannot be resolved): automation actions authorize by its provenance. */
export function createSetupToolExecutor({
  getApi,
  getConfig,
  notifySessionUi,
  getSessionId,
  getCallerSession,
  flushSettings,
  executeSessionControl = null,
}) {
  const desktop = createSetupUiRequests({ notifySessionUi, getSessionId });
  const api = () => {
    const facade = getApi?.();
    if (!facade) throw new Error('setup: runtime facade is not ready');
    return facade;
  };

  async function readStatus(domain, requestDesktop, detail, caller = null) {
    const rt = api();
    if (SETUP_DESKTOP_DOMAINS.includes(domain)) return requestDesktop({ action: 'status', domain });
    if (!Object.hasOwn(SETUP_STATUS_READERS, domain)) throw new Error(`setup: unknown status domain "${domain}"`);
    return SETUP_STATUS_READERS[domain](rt, { domain, detail, caller, getConfig: () => getConfig?.() || {} });
  }

  function openSurface(target) {
    const command = requireEnum(target, SETUP_OPEN_TARGETS, 'target');
    const sessionId = clean(getSessionId?.());
    const hint = OPEN_TARGET_HINTS[command] || `TUI: /${command}`;
    const handled =
      Boolean(sessionId) && notifySessionUi?.(sessionId, `Open /${command}`, { kind: 'ui-open', command }) === true;
    return {
      opened: handled,
      target: command,
      ...(handled
        ? { note: 'The attached app navigated to this surface; the user completes the step there.' }
        : { note: `No interactive UI is attached to this session. Tell the user where to go: ${hint}` }),
    };
  }

  async function execute(args, { signal, callerSessionId, requestApproval = null, toolCallId = null }) {
    signal?.throwIfAborted();
    const requestDesktop = (request) => desktop.request(request, { signal });
    const action = validateSetupInput(args);
    // The session that made this call, not just the runtime's own Lead.
    const sessionId = clean(callerSessionId) || clean(getSessionId?.());
    const caller = (sessionId && getCallerSession?.(sessionId)) || null;
    // A headless run (schedule, webhook, delegated agent) only reads settings:
    // it never creates agents, definitions or automations, nor changes any
    // other setting. Hosts without session provenance (no getCallerSession)
    // skip this gate; automation actions still refuse an unknown caller.
    let scope = null;
    if (getCallerSession && !READ_ONLY_SETUP_ACTIONS.has(action)) {
      scope = scheduleCallerScope(caller);
      assertInteractiveCaller(scope, action);
      // Agent definitions (contacts) change only from Mixy; another agent's
      // home changes only its own agent settings.
      if (AGENT_DEFINITION_ACTIONS.has(action) && args.definitionKind === 'agent') {
        assertAgentEditorAccess(scope, caller, action);
      }
      if (OWN_AGENT_ACTIONS.has(action)) assertOwnAgentSettings(scope, args.agent, action);
    }
    // Mixy's heartbeat session takes only its two routine actions, reads included.
    assertHeartbeatSetupAction(sessionId, action, args);
    const rt = action === 'status' || action === 'open' ? null : api();
    if (!Object.hasOwn(SETUP_ACTION_HANDLERS, action)) {
      return executeExtendedSetupAction(rt, args, requestDesktop, { sessionId, caller });
    }
    return SETUP_ACTION_HANDLERS[action](rt, args, {
      requestDesktop,
      readStatus,
      openSurface,
      sessionId,
      caller,
      // The session-scoped actions authorize each target against it (session-route-actions.mjs).
      scope,
      getSession: getCallerSession,
      getConfig: () => getConfig?.() || {},
      executeSessionControl,
      // The calling turn's approval card (a connector tool's widening asks the person).
      requestApproval,
      signal,
      toolCallId,
    });
  }

  return {
    claimSetupRequest: desktop.claimSetupRequest,
    isSetupRequestActive: desktop.isSetupRequestActive,
    completeSetupRequest: desktop.completeSetupRequest,
    dispose: desktop.dispose,
    async execute(args = {}, options = {}) {
      const result = await execute(args, options);
      if (READ_ONLY_SETUP_ACTIONS.has(args.action)) return JSON.stringify(result ?? {});
      await flushSettings?.();
      // Attached surfaces re-read what changed instead of waiting for their
      // next open or cache expiry.
      const sessionId = clean(getSessionId?.());
      if (sessionId) notifySessionUi?.(sessionId, 'Settings changed', { kind: 'setup-changed', action: args.action });
      return setupMutationReceipt(args.action, result);
    },
  };
}
