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

export const SETUP_ACTIONS = Object.freeze([
  'status',
  'open',
  'set_route',
  'set_agent_route',
  'set_web_search_route',
  'set_workflow',
  'set_output_style',
  'set_profile',
  'set_autoclear',
  'set_compaction',
  'set_memory_enabled',
  'set_recap_enabled',
  'set_web_search_enabled',
  'set_builtin_enabled',
  'install_builtin',
  'set_system_shell',
  'set_auto_update',
  'set_local_provider',
  'forget_provider_auth',
  'add_mcp_server',
  'save_mcp_server',
  'remove_mcp_server',
  'set_mcp_enabled',
  'reconnect_mcp',
  'set_disabled_skills',
  'set_extension_scope',
  'add_plugin',
  'update_plugin',
  'set_plugin_enabled',
  'remove_plugin',
]);

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
    description: 'Read or change this Mixdog installation\'s settings through the runtime (never by editing config files). Load the setup skill first. status reads one domain; open navigates the attached app to a settings surface and reports whether a UI was there. Secrets (API keys, OAuth) are never accepted: open providers and let the user enter them. Every change applies to new sessions unless the result says otherwise.',
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
        action: { type: 'string', enum: [...SETUP_ACTIONS] },
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
        enabled: { type: 'boolean', description: 'Boolean setters (set_*_enabled, set_compaction, set_auto_update, set_mcp_enabled, set_plugin_enabled, set_local_provider).' },
        name: { type: 'string', description: 'Feature (git|memory|office), MCP server, plugin id, or provider id, per action.' },
        command: { type: 'string', description: 'set_system_shell: shell command; empty restores automatic selection.' },
        baseURL: { type: 'string', description: 'set_local_provider: OpenAI-compatible base URL.' },
        server: { type: 'object', additionalProperties: true, description: 'add_mcp_server / save_mcp_server: {name, type, command, args, cwd, env} or {name, type, url, headers}.' },
        skills: { type: 'array', items: { type: 'string' }, description: 'set_disabled_skills: full list of disabled skill names.' },
        source: { type: 'string', description: 'add_plugin: Git URL, owner/repo, or local path.' },
        kind: { type: 'string', enum: ['skills', 'mcp', 'plugins'], description: 'set_extension_scope: which extension list `name` belongs to.' },
        projects: { type: 'array', items: { type: 'string' }, description: 'set_extension_scope: project root paths the extension is limited to; empty = every project.' },
      },
    },
  },
]);
