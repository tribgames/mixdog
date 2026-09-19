import { ORCHESTRATION_MODES } from '../../runtime/shared/orchestration.mjs';

/** Additional settings surfaces. Keep this registry shared by the wire schema,
 * dispatch coverage tests and the model-visible capability inventory. */
const text = { type: 'string' };
const removableText = { type: ['string', 'null'] };
const boolean = { type: 'boolean' };
const strings = { type: 'array', items: text };
const object = (properties, required = []) => ({
  type: 'object',
  additionalProperties: false,
  properties,
  ...(required.length ? { required } : {}),
});

export const SETUP_EXTENDED_ACTION_FIELDS = Object.freeze({
  list_models: 'catalog?',
  set_local_context: 'modelId localContextWindow',
  set_orchestration_mode: 'mode',
  get_mcp_server: 'name',
  read_definition: 'definitionKind name',
  create_definition: 'definitionKind definition',
  save_definition: 'definitionKind definition',
  delete_definition: 'definitionKind name',
  save_automation: 'automationKind entry',
  delete_automation: 'automationKind name',
  set_automation_enabled: 'automationKind name enabled',
  set_webhook_config: 'webhook',
  set_desktop_settings: 'desktop',
  set_appearance: 'appearance',
  save_project: 'project',
  remove_project: 'projectPath',
  get_instructions: 'projectPath',
  set_instructions: 'projectPath content expectedContent',
  revoke_linked_device: 'name',
});

export const SETUP_EXTENDED_DOMAINS = Object.freeze([
  'capabilities',
  'desktop',
  'appearance',
  'projects',
  'connection',
  'schedules',
  'webhooks',
]);

export const SETUP_DESKTOP_ACTIONS = Object.freeze([
  'set_desktop_settings',
  'set_appearance',
  'save_project',
  'remove_project',
  'get_instructions',
  'set_instructions',
  'revoke_linked_device',
]);
export const SETUP_DESKTOP_DOMAINS = Object.freeze(['desktop', 'appearance', 'projects', 'connection']);

export const SETUP_MCP_SCHEMA = object({
  name: { ...text, description: 'Server name. For edits, omit to keep originalName.' },
  originalName: { ...text, description: 'Existing server identity when editing or renaming; defaults to name.' },
  type: { type: 'string', enum: ['stdio', 'http', 'streamable-http', 'sse', 'ws'] },
  command: { ...text, description: 'stdio executable. Never include credentials in command or args.' },
  args: strings,
  cwd: text,
  url: { ...text, description: 'HTTP(S)/WS(S) endpoint without embedded credentials.' },
  env: {
    type: 'object',
    additionalProperties: removableText,
    description:
      'Patch non-secret environment values; null removes a key. Omitted keys, including credentials, are preserved.',
  },
  headers: {
    type: 'object',
    additionalProperties: removableText,
    description: 'Patch non-secret HTTP headers; null removes a header. Omitted headers are preserved.',
  },
  env_vars: { ...strings, description: 'Names of existing environment variables to forward; never their secrets.' },
  bearer_token_env_var: {
    ...text,
    description: 'Name of an existing environment variable containing the bearer token.',
  },
  env_http_headers: {
    type: 'object',
    additionalProperties: removableText,
    description: 'HTTP header names mapped to existing environment variable names.',
  },
});

export const SETUP_EXTENDED_PROPERTIES = Object.freeze({
  catalog: object({
    provider: text,
    webSearch: boolean,
    refresh: boolean,
  }),
  localContextWindow: {
    type: ['integer', 'null'],
    minimum: 512,
    description:
      'Managed local model context tokens; null restores automatic allocation. Maximum comes from the model status.',
  },
  mode: {
    type: 'string',
    enum: [...ORCHESTRATION_MODES],
    description: 'set_orchestration_mode: execution mode; independent of workflow instructions.',
  },
  definitionKind: {
    type: 'string',
    enum: ['workflow', 'agent', 'skill'],
    description: 'Definition owner. Skill deletion is not supported; disable it instead.',
  },
  definition: object({
    id: text,
    originalName: text,
    name: text,
    description: text,
    body: text,
    whenToUse: text,
    toolDependencies: {
      type: ['array', 'null'],
      items: object({ type: { type: 'string', enum: ['tool', 'mcp'] }, value: text }, ['type', 'value']),
    },
  }),
  automationKind: { type: 'string', enum: ['schedule', 'webhook'] },
  entry: object(
    {
      name: text,
      description: text,
      instructions: text,
      time: { ...text, description: 'Schedule cron expression. Mutually exclusive with at.' },
      at: { ...text, description: 'One-shot schedule datetime. Mutually exclusive with time.' },
      timezone: text,
      days: { ...text, description: 'Schedule day selector, e.g. weekdays or mon,wed,fri.' },
      parser: { type: 'string', enum: ['github', 'generic', 'stripe', 'sentry'] },
      channel: text,
      model: text,
      cwd: text,
      workflow: text,
      attachments: {
        type: 'array',
        maxItems: 8,
        items: object(
          {
            kind: { type: 'string', enum: ['image', 'text', 'pdf'] },
            name: { type: 'string', maxLength: 200 },
            mimeType: text,
            data: {
              ...text,
              description:
                'Plain text for text attachments; base64 for image/PDF. Prefer existing attachments when editing.',
            },
          },
          ['kind', 'data']
        ),
      },
      delivery: { type: 'string', enum: ['app', 'channel', 'both'] },
      enabled: boolean,
      overwrite: { ...boolean, description: 'Explicitly update an existing entry; omitted fields are preserved.' },
    },
    ['name']
  ),
  webhook: object({
    enabled: boolean,
    port: { type: 'integer', minimum: 1, maximum: 65535 },
    domain: text,
  }),
  desktop: object({
    keepAwake: boolean,
    usagePinned: boolean,
    computerObserveOnly: boolean,
  }),
  appearance: object({
    theme: { type: 'string', enum: ['system', 'dark', 'white'] },
    displayLanguage: {
      ...text,
      description: 'Desktop UI language id from status appearance; independent of profile language.',
    },
    sidePanels: { type: 'string', enum: ['close-left', 'close-right', 'close-both', 'keep-open'] },
    zoom: { type: 'number', minimum: 0.5, maximum: 2 },
  }),
  project: object({ path: text, alias: text }, ['path']),
  projectPath: {
    type: ['string', 'null'],
    description: 'Exact registered Project root; null means Common Instructions (instruction actions only).',
  },
  content: { ...text, description: 'Complete new Instructions content. Preserve unrelated instructions.' },
  expectedContent: {
    ...text,
    description: 'Unchanged content returned by get_instructions; prevents overwriting a concurrent edit.',
  },
});

export const SETUP_HANDOFFS = Object.freeze({
  authentication: 'Provider API keys, OAuth and usage sign-ins require the Providers UI.',
  notifications: 'Notification permission/subscription requires a user gesture on the device receiving notifications.',
  pairing: 'Pairing credentials and OS permission approvals remain in the visible UI.',
  memoryContent: 'Use the memory tool for Core Memory, not setup.',
});
