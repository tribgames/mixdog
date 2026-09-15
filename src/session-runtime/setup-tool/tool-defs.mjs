/** Built-in `setup` tool: the model's handle on a Mixdog user's persisted
 *  configuration. The description is a contract only; how to use each action
 *  (recipes, disk paths, UI routes) lives in the built-in `setup` skill. */

export const SETUP_STATUS_DOMAINS = Object.freeze([
  'summary',
  'model',
  'agents',
  'workflow',
  'websearch',
  'output-style',
  'profile',
  'autoclear',
  'compaction',
  'memory',
  'features',
  'local-provider',
  'shell',
  'providers',
  'mcp',
  'skills',
  'plugins',
  'update',
  'onboarding',
]);

/** Slash-command names shared by TUI (slash-commands.mjs) and Desktop
 *  (slash-commands.ts); each UI routes the name with its own table. */
export const SETUP_OPEN_TARGETS = Object.freeze([
  'settings',
  'providers',
  'model',
  'websearch',
  'workflow',
  'agents',
  'outputstyle',
  'theme',
  'profile',
  'autoclear',
  'memory',
  'mcp',
  'skills',
  'plugins',
  'update',
  'usage',
  'doctor',
  'context',
]);

// Runtime dispatch contract. A trailing ? denotes an optional field. Keep
// this out of the wire schema: field descriptions already name their actions.
export const SETUP_ACTION_FIELDS = Object.freeze({
  status: 'domain?',
  open: 'target',
  set_route: 'route',
  set_agent_route: 'agent route',
  set_web_search_route: 'route',
  set_workflow: 'workflow',
  set_output_style: 'style',
  set_profile: 'profile',
  set_autoclear: 'autoclear',
  set_compaction: 'enabled',
  set_memory_enabled: 'enabled',
  set_recap_enabled: 'enabled',
  set_web_search_enabled: 'enabled',
  set_builtin_enabled: 'name enabled',
  set_first_use_approval: 'name enabled',
  install_builtin: 'name',
  install_local_model: 'modelId',
  start_local_installation: 'phase modelId?',
  cancel_local_installation: 'jobId',
  set_local_idle_ttl: 'idleTtlSeconds?',
  search_local_models: 'query',
  inspect_hf_model: 'repository filename? contextWindow?',
  register_hf_model: 'previewId licenseAccepted',
  local_model_details: 'modelId',
  maintain_local_model: 'modelId operation',
  delete_local_model: 'confirmationToken',
  set_system_shell: 'command',
  set_auto_update: 'enabled',
  forget_provider_auth: 'name',
  add_mcp_server: 'server',
  save_mcp_server: 'server',
  remove_mcp_server: 'name',
  set_mcp_enabled: 'name enabled',
  reconnect_mcp: '',
  set_disabled_skills: 'skills',
  set_extension_scope: 'kind name projects',
  add_plugin: 'source',
  update_plugin: 'name',
  set_plugin_enabled: 'name enabled',
  remove_plugin: 'name',
});

export const SETUP_ACTIONS = Object.freeze(Object.keys(SETUP_ACTION_FIELDS));

export const SETUP_BUILTIN_TOGGLE_FEATURES = Object.freeze(['git', 'office', 'localProvider']);

const ROUTE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    provider: { type: 'string' },
    model: { type: 'string' },
    effort: { type: 'string' },
    fast: { type: 'boolean' },
  },
};

export const SETUP_TOOL_DEFS = Object.freeze([
  {
    name: 'setup',
    title: 'Setup',
    description: 'Read or change this Mixdog installation\'s settings through the runtime. Load the setup skill first (local-provider for managed local-model installation). status reads one domain; open navigates the attached app to a settings surface. Secrets (API keys, OAuth) are never accepted. Changes apply to new sessions unless the result says otherwise.',
    annotations: {
      title: 'Setup',
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: false,
      agentHidden: true,
    },
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['action'],
      properties: {
        action: { type: 'string', enum: [...SETUP_ACTIONS], description: 'Pass only fields for this action.' },
        domain: { type: 'string', enum: [...SETUP_STATUS_DOMAINS], description: 'status: which domain to read; default summary.' },
        target: { type: 'string', enum: [...SETUP_OPEN_TARGETS], description: 'open: settings surface, named by its slash command.' },
        route: { ...ROUTE_SCHEMA, description: 'set_route / set_agent_route / set_web_search_route. set_agent_route with provider "" restores inheritance.' },
        agent: { type: 'string', description: 'set_agent_route: agent id.' },
        workflow: { type: 'string', description: 'set_workflow: pack id.' },
        style: { type: 'string', description: 'set_output_style: style id.' },
        profile: {
          type: 'object', additionalProperties: false,
          properties: { title: { type: 'string' }, language: { type: 'string' }, experienceLevel: { type: 'string' } },
          description: 'set_profile: only the given fields change.',
        },
        autoclear: {
          type: 'object', additionalProperties: false,
          properties: {
            enabled: { type: 'boolean' },
            duration: { type: 'string', description: 'Idle window such as "45m" or "2h"; minimum 1m.' },
            provider: { type: 'string', description: 'Scope the duration to one provider.' },
          },
        },
        enabled: { type: 'boolean', description: 'Boolean setters (set_*_enabled, set_first_use_approval, set_compaction, set_auto_update, set_mcp_enabled, set_plugin_enabled).' },
        name: { type: 'string', description: `set_builtin_enabled: ${SETUP_BUILTIN_TOGGLE_FEATURES.join('|')}; install_builtin also accepts memory. Memory toggles use set_memory_enabled. set_first_use_approval: browser|computer; else MCP/plugin/provider id.` },
        modelId: { type: 'string', description: 'install_local_model: exact model id from status domain local-provider; runtime must already be installed.' },
        phase: { type: 'string', enum: ['runtime', 'model'], description: 'start_local_installation: which managed asset to install or resume. Model phase requires modelId.' },
        jobId: { type: 'string', description: 'cancel_local_installation: current jobId from local-provider status.' },
        idleTtlSeconds: { type: 'integer', minimum: 0, maximum: 86400, description: 'set_local_idle_ttl: unload after this many idle seconds, 0 disables; default 3600.' },
        query: { type: 'string', description: 'search_local_models: Hugging Face GGUF search query.' },
        repository: { type: 'string', description: 'inspect_hf_model: public Hugging Face owner/model repository.' },
        filename: { type: 'string', description: 'inspect_hf_model: exact GGUF filename from the repository listing; omit to list files.' },
        contextWindow: { type: 'integer', minimum: 512, maximum: 32768, description: 'inspect_hf_model: runtime context allocation, default 8192.' },
        previewId: { type: 'string', description: 'register_hf_model: unexpired read-only inspection receipt.' },
        licenseAccepted: { type: 'boolean', description: 'register_hf_model: explicit acceptance of the inspected license and installation plan.' },
        operation: { type: 'string', enum: ['verify', 'repair'], description: 'maintain_local_model: verify SHA-256 or redownload the pinned model; returns a background job.' },
        confirmationToken: { type: 'string', description: 'delete_local_model: unexpired token from local_model_details.' },
        command: { type: 'string', description: 'set_system_shell: required shell command; "" restores automatic selection.' },
        server: { type: 'object', additionalProperties: true, description: 'add_mcp_server / save_mcp_server: {name, type, command, args, cwd, env} or {name, type, url, headers}.' },
        skills: { type: 'array', items: { type: 'string' }, description: 'set_disabled_skills: full list of disabled skill names.' },
        source: { type: 'string', description: 'add_plugin: Git URL, owner/repo, or local path.' },
        kind: { type: 'string', enum: ['skills', 'mcp', 'plugins'], description: 'set_extension_scope: which extension list `name` belongs to.' },
        projects: { type: 'array', items: { type: 'string', minLength: 1, pattern: '\\S' }, description: 'set_extension_scope: required project roots; [] = every project.' },
      },
    },
  },
]);
