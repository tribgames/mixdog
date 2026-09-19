import { parseSkillDocument } from '../../runtime/shared/skill-document.mjs';
import { SETUP_EXTENDED_PROPERTIES, SETUP_DESKTOP_ACTIONS } from './settings-contract.mjs';

const own = (value, key) => Object.hasOwn(value || {}, key);
const pick = (value, keys) => Object.fromEntries(keys.filter((key) => own(value, key)).map((key) => [key, value[key]]));
const entryKeys = Object.keys(SETUP_EXTENDED_PROPERTIES.entry.properties);
const definitionKeys = Object.keys(SETUP_EXTENDED_PROPERTIES.definition.properties);

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

export function publicMcpConfig(row) {
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
  const resource = await rt.skillContent(name);
  const metadata = (await rt.skillsStatus()).skills.find((row) => row.name === name) || {};
  const parsed = parseSkillDocument(resource.content);
  return {
    name,
    originalName: name,
    description: metadata.description || parsed.description || '',
    whenToUse: metadata.whenToUse || parsed.whenToUse || '',
    body: parsed.body,
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
  if (!creating && !current.editable) throw new Error('Only machine-global user skills can be edited');
  return creating ? rt.addSkill(next) : rt.saveSkill({ ...next, originalName: current.originalName });
}

export const EXTENDED_SETUP_HANDLERS = Object.freeze({
  set_local_context: (rt, args) => rt.setLocalProviderContext(args.modelId, args.localContextWindow),
  async list_models(rt, args) {
    const options = args.catalog || {};
    const models = options.webSearch
      ? await rt.listWebSearchModels({ refresh: options.refresh === true })
      : await rt.listProviderModels({ refresh: options.refresh === true });
    return { models: options.provider ? models.filter((model) => model.provider === options.provider) : models };
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
    if (input.overwrite === true) {
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
        ? { secretSet: true, credentialHandoff: 'Use the Webhooks UI to copy the signing secret.' }
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
  async set_webhook_config(rt, args) {
    await rt.setWebhookConfig(args.webhook);
    const status = await rt.getChannelSetup();
    return { webhook: pick(status.webhook, ['enabled', 'port', 'domain']) };
  },
});

export async function executeExtendedSetupAction(rt, args, requestDesktop) {
  if (SETUP_DESKTOP_ACTIONS.includes(args.action)) return requestDesktop(args);
  const handler = EXTENDED_SETUP_HANDLERS[args.action];
  if (!handler) throw new Error(`setup: unhandled action "${args.action}"`);
  return handler(rt, args);
}
