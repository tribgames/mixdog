import { SETUP_EXTENDED_PROPERTIES, SETUP_DESKTOP_ACTIONS } from './settings-contract.mjs';
import { MEDIA_KINDS } from '../../runtime/media/tool-defs.mjs';
import { OPENAI_COMPAT_PRESETS } from '../../runtime/agent/orchestrator/providers/openai-compat-presets.mjs';

const own = (value, key) => Object.hasOwn(value || {}, key);
const pick = (value, keys) => Object.fromEntries(keys.filter((key) => own(value, key)).map((key) => [key, value[key]]));
const entryKeys = Object.keys(SETUP_EXTENDED_PROPERTIES.entry.properties);
const definitionKeys = Object.keys(SETUP_EXTENDED_PROPERTIES.definition.properties);

const MODEL_PAGE_DEFAULT = 25;

function providerIndex(rows) {
  const counts = new Map();
  for (const row of rows) counts.set(row.provider, (counts.get(row.provider) || 0) + 1);
  return [...counts].map(([provider, count]) => {
    const defaultModel = OPENAI_COMPAT_PRESETS[provider]?.defaultModel;
    return { provider, count, ...(defaultModel ? { defaultModel } : {}) };
  });
}

function compactModelRow(row) {
  const context = row.contextWindow || null;
  const maxContext = Number(row.maxContextWindow) || 0;
  return {
    id: row.id,
    display: row.display || row.id,
    context,
    ...(maxContext > (context || 0) ? { maxContext } : {}),
    efforts: (row.effortOptions || []).map((option) => option.value),
    ...(row.fastCapable === true ? { fast: true } : {}),
    ...(row.supportsVision === true ? { vision: true } : {}),
  };
}

const isPresent = (value) =>
  value != null &&
  value !== '' &&
  value !== false &&
  !(typeof value === 'object' && !Object.keys(value).length);

/** Everything set_route can use for one model; empty and false fields omitted. */
function modelDetail(row) {
  const detail = {
    provider: row.provider,
    id: row.id,
    display: row.display || row.id,
    context: row.contextWindow,
    maxContext: Number(row.maxContextWindow) > row.contextWindow ? row.maxContextWindow : null,
    outputTokens: row.outputTokens,
    vision: row.supportsVision,
    webSearch: row.supportsWebSearch,
    reasoning: row.supportsReasoning,
    effortOptions: (row.effortOptions || []).map(({ value, label }) => ({ value, label })),
    defaultEffort: row.defaultEffort,
    fastCapable: row.fastCapable,
    fastEfforts: row.fastEfforts,
    defaultFast: row.defaultFast,
    serviceTiers: row.serviceTiers,
    defaultServiceTier: row.defaultServiceTier,
    additionalSpeedTiers: row.additionalSpeedTiers,
    modelParameterOptions: row.modelParameterOptions,
    parameterVariants: row.parameterVariants,
    defaultModelParameters: row.defaultModelParameters,
    supportsMaxMode: row.supportsMaxMode,
  };
  return Object.fromEntries(Object.entries(detail).filter(([, value]) => isPresent(value)));
}

function findModel(rows, id, provider) {
  const matches = rows.filter((row) => row.id === id && (!provider || row.provider === provider));
  if (!matches.length) {
    throw new Error(`model "${id}" not found${provider ? ` for provider "${provider}"` : ''}; list_models with catalog.provider returns its model ids`);
  }
  const providers = [...new Set(matches.map((row) => row.provider))];
  if (providers.length > 1) throw new Error(`model "${id}" is offered by ${providers.join(', ')}; pass catalog.provider`);
  return matches[0];
}

export function publicAutomation(row) {
  const result = {
    ...pick(row, entryKeys),
    ...pick(row, ['whenAt', 'whenCron', 'secretSet']),
  };
  if (Array.isArray(result.attachments)) {
    result.attachments = result.attachments.map((attachment) => ({
      ...pick(attachment, ['kind', 'name', 'mimeType']),
      stored: true,
      size: String(attachment.data || '').length,
    }));
  }
  return result;
}

function publicMcpConfig(row) {
  const config = row?.config || {};
  let endpointOrigin = null;
  if (config.url) {
    try {
      endpointOrigin = new URL(config.url).origin;
    } catch {
      /* malformed legacy URL stays private */
    }
  }
  return {
    name: row.name,
    source: row.source,
    ...(row.owner?.kind === 'plugin' ? { plugin: row.owner.id, pluginServer: row.owner.key, readOnly: true } : {}),
    enabled: row.enabled !== false,
    type: config.type || 'stdio',
    cwd: config.cwd || '',
    endpointOrigin,
    argumentCount: Array.isArray(config.args) ? config.args.length : 0,
    environmentNames: Object.keys(config.env || {}),
    headerNames: Object.keys(config.headers || {}),
    ...pick(config, ['env_vars', 'bearer_token_env_var', 'env_http_headers']),
    hiddenFields: ['command', 'args', 'url', 'env', 'headers'].filter((key) => own(config, key)),
    note: 'Raw connection values may contain credentials and are not returned. Omitted fields are preserved when editing.',
  };
}

export function validateMcpInput(server) {
  for (const field of ['env', 'headers']) {
    for (const key of Object.keys(server[field] || {})) {
      if (server[field][key] !== null && /authorization|cookie|api[-_]?key|token|password|secret/i.test(key)) {
        throw new Error(`setup: ${field}.${key} must use an environment-variable reference, not a credential value`);
      }
    }
  }
  if (server.url) {
    const url = new URL(server.url);
    if (!['http:', 'https:', 'ws:', 'wss:'].includes(url.protocol))
      throw new Error('MCP URL must use HTTP(S) or WS(S)');
    if (
      url.username ||
      url.password ||
      [...url.searchParams.keys()].some((key) => /key|token|password|secret|auth/i.test(key))
    ) {
      throw new Error('MCP URL credentials are not accepted; use environment-variable references');
    }
  }
  if (server.command && server.url) throw new Error('MCP input must select command or url, not both');
  if (server.type === 'stdio' && server.url) throw new Error('stdio requires command, not url');
  if (server.type && server.type !== 'stdio' && server.command)
    throw new Error('network MCP transports require url, not command');
}

async function readDefinition(rt, kind, name) {
  if (kind === 'workflow') return rt.getWorkflowPack(name);
  if (kind === 'agent') return rt.getAgentDefinition(name);
  // skillContent already returns the SKILL.md body without frontmatter; the
  // frontmatter fields come from the catalog row.
  const resource = await rt.skillContent(name);
  const metadata = (await rt.skillsStatus()).skills.find((row) => row.name === name) || {};
  return {
    name,
    originalName: name,
    description: metadata.description || '',
    whenToUse: metadata.whenToUse || '',
    body: resource.content,
    toolDependencies: metadata.toolDependencies || [],
    editable: metadata.editable === true,
  };
}

async function saveDefinition(rt, args) {
  const kind = args.definitionKind;
  const input = args.definition;
  const allowed =
    kind === 'skill'
      ? ['originalName', 'name', 'description', 'body', 'whenToUse', 'toolDependencies']
      : ['id', 'name', 'description', 'body'];
  const unexpected = Object.keys(input).find((key) => !allowed.includes(key));
  if (unexpected) throw new Error(`${unexpected} is not a ${kind} definition field`);
  const creating = args.action === 'create_definition';
  const id = input.originalName || input.id || input.name;
  if (!creating && !String(id || '').trim()) throw new Error('An existing definition identity is required');
  const current = creating ? {} : await readDefinition(rt, kind, id);
  if (kind === 'skill' && !creating && !current.editable) {
    // Built-in and plugin skills keep their document; like the Skills editor,
    // only their tool dependencies are user-editable (null restores them).
    const edits = Object.keys(input).filter((key) => key !== 'originalName' && key !== 'name');
    if (edits.length !== 1 || edits[0] !== 'toolDependencies' || (own(input, 'name') && input.name !== current.name)) {
      throw new Error('Built-in and plugin skills accept only toolDependencies edits');
    }
    return rt.saveSkill({
      originalName: current.originalName,
      dependenciesOnly: true,
      toolDependencies: input.toolDependencies,
    });
  }
  const next = { ...pick(current, definitionKeys), ...input };
  if (!String(next.body || '').trim()) throw new Error('definition.body must not be empty');
  if (kind === 'workflow') {
    return creating ? rt.createWorkflow(next) : rt.saveWorkflowPack({ ...next, id: current.id });
  }
  if (kind === 'agent') {
    if (creating && input.id) {
      const agents = await rt.listAgents();
      if (agents.some((agent) => agent.id === input.id)) throw new Error(`agent "${input.id}" already exists`);
    }
    return rt.saveAgentDefinition(creating ? next : { ...next, id: current.id });
  }
  return creating ? rt.addSkill(next) : rt.saveSkill({ ...next, originalName: current.originalName });
}

export const EXTENDED_SETUP_HANDLERS = Object.freeze({
  set_local_context: (rt, args) => rt.setLocalProviderContext(args.modelId, args.localContextWindow),
  async list_models(rt, args) {
    const { provider, model, page = 1, limit = MODEL_PAGE_DEFAULT, webSearch, refresh } = args.catalog || {};
    const rows = webSearch
      ? await rt.listWebSearchModels({ refresh: refresh === true })
      : await rt.listProviderModels({ refresh: refresh === true });
    if (model) return { model: modelDetail(findModel(rows, model, provider)) };
    if (!provider) return { providers: providerIndex(rows) };
    const own = rows.filter((row) => row.provider === provider);
    const pages = Math.max(1, Math.ceil(own.length / limit));
    return {
      provider,
      total: own.length,
      page,
      pages,
      ...(page < pages ? { nextPage: page + 1 } : {}),
      models: own.slice((page - 1) * limit, page * limit).map(compactModelRow),
    };
  },
  set_orchestration_mode: (rt, args) => rt.setOrchestrationMode(args.mode),
  get_mcp_server: async (rt, args) => publicMcpConfig(await rt.getMcpServerConfig(args.name)),
  read_definition: (rt, args) => readDefinition(rt, args.definitionKind, args.name),
  create_definition: saveDefinition,
  save_definition: saveDefinition,
  async delete_definition(rt, args) {
    if (args.definitionKind === 'skill') throw new Error('Skill deletion is not supported; use set_disabled_skills');
    await readDefinition(rt, args.definitionKind, args.name);
    const result =
      args.definitionKind === 'workflow'
        ? await rt.deleteWorkflow(args.name)
        : await rt.deleteAgentDefinition(args.name);
    return {
      ...result,
      recovery:
        'User-authored definition files are deleted. A built-in override may revert to its built-in definition.',
    };
  },
  async save_automation(rt, args) {
    const kind = args.automationKind;
    const input = args.entry;
    if (kind === 'webhook' && ['time', 'at', 'timezone', 'days'].some((key) => own(input, key))) {
      throw new Error('Schedule timing fields are not accepted for webhooks');
    }
    if (kind === 'schedule' && own(input, 'parser')) throw new Error('parser is a webhook-only field');
    let previous = {};
    if (input.overwrite) {
      const status = await rt.getChannelSetup();
      previous = status[kind === 'schedule' ? 'schedules' : 'webhooks'].find((row) => row.name === input.name);
      if (!previous) throw new Error(`${kind} "${input.name}" does not exist`);
    }
    const next = { ...pick(previous, entryKeys), ...input };
    if (kind === 'schedule') {
      if (previous.whenAt && !own(input, 'time') && !own(input, 'at')) {
        next.at = new Date(previous.whenAt).toISOString();
        delete next.time;
      }
      if (own(input, 'time') && !own(input, 'at')) delete next.at;
      if (own(input, 'at') && !own(input, 'time')) delete next.time;
    }
    const result = kind === 'schedule' ? await rt.saveSchedule(next) : await rt.saveWebhook(next);
    return {
      ...publicAutomation(result),
      ...(kind === 'webhook'
        ? {
            secretSet: true,
            credentialHandoff:
              'The signing secret is never returned here or shown again. Open the Webhooks panel, edit this webhook, press Regenerate secret, copy the new value, and save.',
          }
        : {}),
    };
  },
  async delete_automation(rt, args) {
    const status = await rt.getChannelSetup();
    const rows = status[args.automationKind === 'schedule' ? 'schedules' : 'webhooks'];
    if (!rows.some((row) => row.name === args.name)) throw new Error('Automation entry not found');
    const result =
      args.automationKind === 'schedule' ? await rt.deleteSchedule(args.name) : await rt.deleteWebhook(args.name);
    return { ...result, recovery: 'The automation record is deleted; recreating it requires its definition.' };
  },
  set_automation_enabled: (rt, args) =>
    args.automationKind === 'schedule'
      ? rt.setScheduleEnabled(args.name, args.enabled)
      : rt.setWebhookEnabled(args.name, args.enabled),
  async set_developer_option(rt, args) {
    const option = rt
      .getDeveloperSettings()
      .sections.flatMap((section) => section.options)
      .find((row) => row.id === args.name);
    if (!option) throw new Error(`Unknown developer option "${args.name}"; read status developer`);
    if (args.enabled && option.warning && !args.riskAccepted) {
      throw new Error(
        `Enabling ${option.label} requires riskAccepted:true after the user explicitly accepts: ${option.warning}`
      );
    }
    return { developer: await rt.setDeveloperOption(option.id, args.enabled) };
  },
  async set_webhook_config(rt, args) {
    await rt.setWebhookConfig(args.webhook);
    const status = await rt.getChannelSetup();
    return { webhook: pick(status.webhook, ['enabled', 'port', 'domain']) };
  },
  add_hook_rule: async (rt, args) => {
    const rule = args.hookRule;
    const rewrites = ['modify', 'rewrite'].includes(rule.action);
    const edits = ['patch', 'args'].filter((key) => own(rule, key));
    if (rewrites && edits.length !== 1)
      throw new Error(`hookRule.${rule.action} requires exactly one of patch or args`);
    if (!rewrites && edits.length) throw new Error(`hookRule.${edits[0]} applies only to modify or rewrite rules`);
    return { rules: publicHookRules(await rt.addHookRule(rule)) };
  },
  async set_hook_rule_enabled(rt, args) {
    hookRuleAt(rt, args.ruleIndex);
    const rules = await rt.setHookRuleEnabled(args.ruleIndex, args.enabled);
    // Toggles are debounced; settle the write so the receipt reflects disk.
    rt.flushHookRules();
    return { rules: publicHookRules(rules) };
  },
  async delete_hook_rule(rt, args) {
    const deleted = hookRuleAt(rt, args.ruleIndex);
    return {
      deleted,
      rules: publicHookRules(await rt.deleteHookRule(args.ruleIndex)),
      recovery: 'The rule is removed from the hook rules file; re-adding it with add_hook_rule restores it.',
    };
  },
  async set_media_default(rt, args) {
    if (!MEDIA_KINDS.includes(args.kind)) throw new Error(`kind must be one of ${MEDIA_KINDS.join(', ')}`);
    const lane = (await rt.listMediaLanes()).find((row) => row.id === args.lane);
    if (!lane) throw new Error(`Unknown media lane "${args.lane}"; list lanes with the media tool`);
    if (!lane.authenticated) throw new Error(`${lane.label} is not signed in; open providers first`);
    const spec = lane[args.kind];
    if (!spec) throw new Error(lane.catalogError || `${lane.id} offers no ${args.kind} models`);
    if (own(args, 'model') && !spec.models.some((model) => model.id === args.model)) {
      throw new Error(`model "${args.model}" is not available on ${lane.id}/${args.kind}`);
    }
    return { media: await rt.setMediaDefault(pick(args, ['kind', 'lane', 'model'])) };
  },
});

/** Rule metadata only. Argument edits (patch/args) may embed credentials, so
 *  setup reports their presence, never their contents. */
export function publicHookRule(row) {
  return {
    ...pick(row, ['index', 'enabled', 'tool', 'action', 'match', 'cwd', 'reason']),
    hasArgumentEdit: row.patch != null,
  };
}

const publicHookRules = (rules) => rules.map(publicHookRule);

function hookRuleAt(rt, index) {
  const rule = rt.hooksStatus().rules.find((row) => row.index === index);
  if (!rule) throw new Error(`hook rule ${index} not found; read status hooks`);
  return publicHookRule(rule);
}

export async function executeExtendedSetupAction(rt, args, requestDesktop) {
  if (SETUP_DESKTOP_ACTIONS.includes(args.action)) return requestDesktop(args);
  const handler = EXTENDED_SETUP_HANDLERS[args.action];
  if (!handler) throw new Error(`setup: unhandled action "${args.action}"`);
  return handler(rt, args);
}
