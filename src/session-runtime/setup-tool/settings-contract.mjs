import { ORCHESTRATION_MODES } from '../../runtime/shared/orchestration.mjs';

/** Additional settings surfaces. Keep this registry shared by the wire schema,
 * dispatch coverage tests and the model-visible capability inventory. */
const text = { type: 'string' };
const nonBlank = { type: 'string', minLength: 1, pattern: '\\S' };
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
  run_automation: 'automationKind name',
  set_webhook_config: 'webhook',
  set_desktop_settings: 'desktop',
  set_appearance: 'appearance',
  save_project: 'project',
  remove_project: 'projectPath',
  revoke_linked_device: 'name',
  set_activity_rail_pins: 'activityRailPins',
  set_developer_option: 'name enabled riskAccepted?',
  add_hook_rule: 'hookRule',
  set_hook_rule_enabled: 'ruleIndex enabled',
  delete_hook_rule: 'ruleIndex',
  set_media_default: 'kind lane model? accountId?',
});

/** Mirrors RULE_ACTIONS in services/hook-bus/rule-store.mjs. */
export const SETUP_HOOK_RULE_ACTIONS = Object.freeze(['allow', 'deny', 'block', 'modify', 'rewrite', 'ask']);

/** Mirrors ACTIVITY_RAIL_PIN_IDS in apps/desktop/src/shared/activity-rail-pins.ts. */
export const SETUP_ACTIVITY_RAIL_PIN_IDS = Object.freeze([
  'sessions',
  'agents',
  'schedules',
  'workflows',
  'projects',
  'extensions',
  'skills',
  'source-control',
  'search',
  'webhooks',
]);

export const SETUP_EXTENDED_DOMAINS = Object.freeze([
  'capabilities',
  'developer',
  'desktop',
  'appearance',
  'projects',
  'connection',
  'schedules',
  'webhooks',
  'hooks',
  'media',
]);

export const SETUP_DESKTOP_ACTIONS = Object.freeze([
  'set_desktop_settings',
  'set_appearance',
  'save_project',
  'remove_project',
  'revoke_linked_device',
  'set_activity_rail_pins',
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
  startupTimeoutSec: { type: 'number', description: 'Connect/handshake timeout in seconds (>0, default 30).' },
  toolTimeoutSec: { type: 'number', description: 'Per tool-call timeout in seconds (>0, default 120).' },
});

export const SETUP_EXTENDED_PROPERTIES = Object.freeze({
  catalog: object({
    provider: {
      ...text,
      description: "list_models: omit for the provider index; set for that provider's compact model rows.",
    },
    model: {
      ...text,
      description:
        'list_models: one model id; returns its full options (efforts, fast, service tiers, modelParameterOptions, parameterVariants) for set_route. Add provider when several offer the id.',
    },
    page: { type: 'integer', minimum: 1, description: 'list_models with provider: 1-based page; default 1.' },
    limit: {
      type: 'integer',
      minimum: 1,
      maximum: 100,
      description: 'list_models with provider: rows per page; default 25.',
    },
    webSearch: { ...boolean, description: 'list_models: native-search capable models only.' },
    refresh: { ...boolean, description: 'list_models: refresh the catalog first.' },
  }),
  localContextWindow: {
    type: ['integer', 'null'],
    minimum: 16384,
    description:
      'Managed local model context tokens (32768+ recommended for agent work); null restores automatic allocation. Maximum comes from the model status.',
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
    kind: {
      type: 'string',
      enum: ['bot', 'agent'],
      description:
        'Agent create only: "bot" (a contact the user chats with) or "agent" (a workflow sub-agent). Omitted: a bot when created from the representative bot\'s chat, else a workflow agent. Fixed after creation.',
    },
    whenToUse: {
      ...text,
      description:
        'Skill only: the SKILL.md when_to_use trigger line shown in the model\'s skill listing; "" clears it.',
    },
    toolDependencies: {
      type: ['array', 'null'],
      items: object({ type: { type: 'string', enum: ['tool', 'mcp'] }, value: text }, ['type', 'value']),
    },
  }),
  automationKind: { type: 'string', enum: ['schedule', 'webhook'] },
  entry: object(
    {
      name: text,
      newName: {
        ...text,
        description: 'Schedule only, with overwrite: rename the schedule `name` to this; its history is kept.',
      },
      description: text,
      instructions: text,
      time: { ...text, description: 'Schedule cron expression. Mutually exclusive with at.' },
      at: { ...text, description: 'One-shot schedule datetime. Mutually exclusive with time.' },
      timezone: text,
      days: { ...text, description: 'Schedule day selector, e.g. weekdays or mon,wed,fri.' },
      parser: { type: 'string', enum: ['github', 'generic', 'stripe', 'sentry'] },
      cwd: text,
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
      enabled: boolean,
      owner: {
        ...text,
        description:
          "The bot id that owns the schedule or webhook; each run is a turn in that bot's chat, where it replies with the result. The bot must exist (no representative bot yet = refused). New entries default to the bot of the calling thread (the representative bot = lead); on overwrite, omission keeps the owner.",
      },
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
    runInBackground: boolean,
    usagePinned: boolean,
    usageRailShortLong: boolean,
    usageAccountsExpanded: boolean,
    usageRailSlotsThree: boolean,
    usageRailSlotsAll: boolean,
    computerObserveOnly: boolean,
    browserAutoSignIn: boolean,
    notificationVolume: {
      type: 'integer',
      minimum: 0,
      maximum: 400,
      description: 'Windows only: notification sound volume percent.',
    },
    botOverlay: object(
      {
        enabled: {
          ...boolean,
          description: 'Show the representative bot overlay; refused while no representative bot exists.',
        },
        position: {
          type: 'string',
          enum: ['pinned', 'pinnedHere', 'free', 'onScreen'],
          description:
            'pinned = pin above the message box (default); pinnedHere = pin here; free = free in the app window; onScreen = free on screen.',
        },
        keepAbove: { ...boolean, description: 'Keep above other windows (default off).' },
        collapsed: { ...boolean, description: 'Collapse the bubble so only the bot shows (default off).' },
        autoAdvance: { ...boolean, description: 'Auto-advance long replies (default on).' },
        autoClose: { ...boolean, description: 'Close replies automatically once read (default on).' },
        scale: {
          type: 'integer',
          enum: [50, 60, 70, 80, 90, 100, 110, 120, 130, 140, 150, 160, 170, 180, 190, 200],
          description: 'Bot size in percent (default 100).',
        },
      },
      []
    ),
  }),
  appearance: object({
    theme: { type: 'string', enum: ['system', 'dark', 'white'] },
    displayLanguage: {
      ...text,
      description: 'Desktop UI language id from status appearance; independent of profile language.',
    },
    sidePanels: { type: 'string', enum: ['close-left', 'close-right', 'close-both', 'keep-open'] },
    sidePanelPosition: {
      type: 'string',
      enum: ['right', 'bottom', 'auto'],
      description:
        'Where the side dock sits on desktop: beside the chat, below it, or by window shape (default right).',
    },
    timeFormat: {
      type: 'string',
      enum: ['system', '12h', '24h'],
      description: 'Clock style for every time of day shown (default system = the UI language own clock).',
    },
    uiScale: {
      type: 'number',
      minimum: 0.85,
      maximum: 1.2,
      description: 'UI size multiplier, 0.85-1.2 in steps of 0.05 (default 1).',
    },
    codeSize: {
      type: 'integer',
      minimum: 10,
      maximum: 20,
      description: 'Code text size in px, 10-20 (default 13).',
    },
    codeLigatures: { ...boolean, description: 'Join symbols such as => into one glyph in code (default on).' },
    chatTextSize: {
      type: 'string',
      enum: ['small', 'default', 'large', 'extra-large'],
      description: 'Conversation and composer text size (default default).',
    },
    markdownDefaultView: { type: 'string', enum: ['preview', 'rich', 'source'] },
    linkPreview: boolean,
    toolActivityExpansion: { type: 'string', enum: ['collapsed', 'commands', 'all'] },
    uiFont: { ...text, description: 'Installed font family for the UI; "" restores the built-in font.' },
    codeFont: { ...text, description: 'Installed font family for code; "" restores the built-in font.' },
    skinTransparency: {
      type: 'integer',
      minimum: 0,
      maximum: 100,
      description: 'Sets both skin transparency sliders at once, 0-100 (defaults: outer 20, main 40).',
    },
    skinOuterTransparency: {
      type: 'integer',
      minimum: 0,
      maximum: 100,
      description:
        'How much of the skin picture shows through the outer panels (window frame, titlebar, rail, sidebar, side dock), 0-100 (default 20).',
    },
    skinMainTransparency: {
      type: 'integer',
      minimum: 0,
      maximum: 100,
      description:
        'How much of the skin picture shows through the main panel (conversation area, composer card, status island), 0-100 (default 40).',
    },
    colorTheme: {
      ...text,
      description: 'Imported JSON color theme id from status appearance colorThemes; "builtin" turns themes off.',
    },
  }),
  hookRule: object(
    {
      tool: { ...nonBlank, description: 'Tool name, prefix* pattern, or * (default).' },
      action: { type: 'string', enum: [...SETUP_HOOK_RULE_ACTIONS] },
      match: { ...nonBlank, description: 'Substring the tool arguments or cwd must contain.' },
      cwd: { ...nonBlank, description: 'Substring the working directory must contain.' },
      reason: nonBlank,
      patch: { type: 'object', description: 'modify/rewrite: fields merged into the tool arguments.' },
      args: { type: 'object', description: 'modify/rewrite: arguments that replace the tool arguments.' },
      enabled: boolean,
    },
    ['action']
  ),
  ruleIndex: {
    type: 'integer',
    minimum: 0,
    description: 'set_hook_rule_enabled/delete_hook_rule: rule index from status hooks.',
  },
  lane: {
    ...text,
    description:
      'set_media_default: lane id from the media catalog to pin as the default generator for the kind; "" clears the pin (back to Auto).',
  },
  model: {
    ...nonBlank,
    description:
      'set_media_default: model id offered by the lane for the kind; omitted = the lane default. set_model_preferences: model id of the provider.',
  },
  project: object({ path: text, alias: text }, ['path']),
  projectPath: { ...text, description: 'Exact registered Project root.' },
  activityRailPins: {
    type: 'array',
    items: { type: 'string', enum: [...SETUP_ACTIVITY_RAIL_PIN_IDS] },
    description:
      'set_activity_rail_pins: complete ordered list of pinned activity rail items; it replaces the current list.',
  },
  riskAccepted: {
    ...boolean,
    description:
      "set_developer_option: the user's explicit acceptance of the option warning; required to enable an option that has one. Exception: allowAllActions (allow all actions except payments and permanent deletes) can only be turned on by the person in the desktop app; it is rejected regardless of riskAccepted, and remote enablement is rejected too.",
  },
});

export const SETUP_HANDOFFS = Object.freeze({
  authentication: 'Provider API keys, OAuth and usage sign-ins require the Providers UI.',
  notifications: 'Notification permission/subscription requires a user gesture on the device receiving notifications.',
  pairing: 'Pairing credentials and OS permission approvals remain in the visible UI.',
  memoryContent: 'Use the memory tool for Core Memory, not setup.',
});
