import {
  SETUP_EXTENDED_ACTION_FIELDS,
  SETUP_EXTENDED_DOMAINS,
  SETUP_EXTENDED_PROPERTIES,
  SETUP_MCP_SCHEMA,
} from './settings-contract.mjs';
import { MEDIA_KINDS } from '../../runtime/media/tool-defs.mjs';
import { INSTRUCTION_FILES_MODES } from '../../runtime/shared/instruction-files-mode.mjs';
import {
  DEFAULT_HEARTBEAT_INTERVAL_MINUTES,
  HEARTBEAT_INTERVAL_CHOICES,
} from '../../runtime/shared/heartbeat-interval.mjs';
import { AUTO_EFFORT_BASES } from '../../runtime/agent/orchestrator/providers/auto-effort.mjs';
import { WORKTREE_NEW_TASK_DEFAULTS } from '../../runtime/shared/worktrees/settings.mjs';
import { CONNECTOR_IDS } from '../../runtime/shared/connector-catalog.mjs';
import { COMPACTION_SUMMARY_MODES } from '../../runtime/agent/orchestrator/session/compact/summary-mode.mjs';
import { ACTION_KINDS } from '../../runtime/agent/orchestrator/session/human-gate/outbound-policy.mjs';
import { PERMISSION_MODES } from '../../runtime/agent/orchestrator/session/human-gate/store.mjs';
import { CONNECTOR_PERMISSIONS } from '../../runtime/agent/orchestrator/mcp/agent-connectors.mjs';

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
  'worktree',
  ...SETUP_EXTENDED_DOMAINS,
]);

/** Settings sections without a slash command. Each UI routes them with its
 *  own setup-open table (Desktop app-shell-ui-open-request.ts, TUI
 *  use-ui-open-request.mjs). */
export const SETUP_SECTION_OPEN_TARGETS = Object.freeze(['developer', 'voice', 'connection']);

/** Slash-command names shared by TUI (slash-commands.mjs) and Desktop
 *  (slash-commands.ts), then the settings sections above. */
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
  ...SETUP_SECTION_OPEN_TARGETS,
]);

// Runtime dispatch contract. A trailing ? denotes an optional field. Keep
// this out of the wire schema: field descriptions already name their actions.
export const SETUP_ACTION_FIELDS = Object.freeze({
  status: 'domain? detail?',
  open: 'target',
  set_route: 'route',
  set_agent_route: 'agent route',
  set_web_search_route: 'route',
  set_workflow: 'workflow',
  set_output_style: 'style',
  set_profile: 'profile',
  set_autoclear: 'autoclear',
  set_compaction: 'enabled? compaction?',
  set_memory_enabled: 'enabled',
  set_recap_enabled: 'enabled',
  set_web_search_enabled: 'enabled',
  set_instruction_files: 'instructionFiles',
  set_auto_effort_base: 'autoEffortBase',
  set_builtin_enabled: 'name enabled',
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
  set_ai_session_titles: 'enabled',
  set_quota_auto_resume: 'enabled',
  set_model_preferences: 'provider model hidden? favorite?',
  set_heartbeat_enabled: 'enabled',
  set_heartbeat_interval: 'minutes',
  set_reactions_enabled: 'enabled',
  forget_provider_auth: 'name accountId?',
  set_provider_account: 'name providerAccount',
  add_mcp_server: 'server',
  save_mcp_server: 'server',
  remove_mcp_server: 'name',
  set_mcp_enabled: 'name enabled',
  reconnect_mcp: 'name?',
  set_disabled_skills: 'skills',
  set_extension_scope: 'kind name projects',
  add_plugin: 'source',
  update_plugin: 'name',
  set_plugin_enabled: 'name enabled',
  remove_plugin: 'name',
  enable_plugin_mcp: 'name',
  connect_connector: 'connector',
  set_worktree_settings: 'worktree',
  reset_route_fallback: 'sessionId? agent?',
  continue_in_model: 'sessionId route',
  schedule_quota_resume: 'sessionId',
  cancel_quota_resume: 'sessionId',
  set_cache_warming_enabled: 'enabled',
  read_agent_settings: 'agent',
  read_project_connectors: 'projectPath',
  set_agent_permission: 'agent actionKind permissionMode',
  set_agent_connector: 'agent name enabled',
  set_agent_connector_tool: 'agent name tool permission',
  set_project_connector: 'projectPath name enabled',
  restore_definition: 'definitionKind name',
  set_bot_order: 'botOrder',
  ...SETUP_EXTENDED_ACTION_FIELDS,
});

export const SETUP_ACTIONS = Object.freeze(Object.keys(SETUP_ACTION_FIELDS));

export const SETUP_BUILTIN_TOGGLE_FEATURES = Object.freeze([
  'git',
  'office',
  'tidy',
  'localProvider',
  'autoEffort',
  'browser',
  'computer',
  'voice',
  'visualize',
  'media',
]);

const ROUTE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    provider: { type: 'string' },
    model: { type: 'string' },
    effort: { type: 'string' },
    fast: { type: 'boolean' },
    autoEffort: {
      type: 'boolean',
      description: 'Main and agent routes only: Auto reasoning for this route; omitted = preserved.',
    },
    modelParameters: { type: 'object', additionalProperties: { type: 'string' } },
    // A typed enum is unrepresentable on Gemini; the bounds project everywhere
    // and the executor rejects values that are not a multiple of 10.
    contextPercent: { type: 'integer', minimum: 10, maximum: 100, description: 'A multiple of 10.' },
    contextTokens: {
      type: 'integer',
      minimum: 1,
      description: 'Exact context window in tokens; overrides contextPercent, clamped to 10%-100% of the model window.',
    },
    disabled: {
      type: 'boolean',
      description: 'Agent routes only: true disables without losing the route; false re-enables.',
    },
  },
};

ROUTE_SCHEMA.properties.fallbacks = {
  type: 'array',
  description:
    'Lead (set_route), agent (bots included) and Web Search routes only: ordered fallback models tried when the model hits its usage limit or is unavailable, each on another provider; [] clears the list. Running sessions on that route read it at their next hop.',
  items: {
    type: 'object',
    additionalProperties: false,
    required: ['provider', 'model'],
    properties: Object.fromEntries(Object.entries(ROUTE_SCHEMA.properties).filter(([key]) => key !== 'disabled')),
  },
};

export const SETUP_TOOL_DEFS = Object.freeze([
  {
    name: 'setup',
    title: 'Setup',
    description:
      "Read or change this Mixdog installation's settings through the runtime. Load the setup skill first (local-provider for managed local-model installation). status reads one domain; open navigates the attached app to a settings surface; list_models returns a provider index, then one provider's paged compact rows, then one model's full options (catalog.model). Results are compact JSON. Secrets (API keys, OAuth) are never accepted. Changes apply to new sessions unless the result says otherwise.",
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
        domain: {
          type: 'string',
          enum: [...SETUP_STATUS_DOMAINS],
          description: 'status: which domain to read; default summary.',
        },
        detail: {
          type: 'boolean',
          description:
            'status providers: full rows for every provider (key URLs, expiry, account ids) instead of configured providers only.',
        },
        target: {
          type: 'string',
          enum: [...SETUP_OPEN_TARGETS],
          description: 'open: settings surface, named by its slash command or settings section.',
        },
        route: {
          ...ROUTE_SCHEMA,
          description:
            'Partial route update; omitted fields are preserved. Agent or Web Search provider "" restores Main inheritance. contextPercent and contextTokens apply to Main and agent routes only.',
        },
        agent: {
          type: 'string',
          description:
            'Agent or bot id (lead = Mixy): set_agent_route, read_agent_settings, set_agent_permission, set_agent_connector(_tool); reset_route_fallback: every chat of that bot.',
        },
        workflow: { type: 'string', description: 'set_workflow: pack id.' },
        style: { type: 'string', description: 'set_output_style: style id.' },
        profile: {
          type: 'object',
          additionalProperties: false,
          properties: { title: { type: 'string' }, language: { type: 'string' }, experienceLevel: { type: 'string' } },
          description:
            'set_profile: only the given fields change. language and experienceLevel take ids from status profile; experienceLevel "" clears it.',
        },
        autoclear: {
          type: 'object',
          additionalProperties: false,
          properties: {
            enabled: { type: 'boolean' },
            duration: {
              type: 'string',
              description:
                'Idle window such as "45m" or "2h" (minimum 1m), or "unlimited"/"never" to stop idle clearing. Without provider, "unlimited" applies to the current route provider.',
            },
            provider: {
              type: 'string',
              description:
                'Scope the duration to one provider; "default" is the fallback for providers without a built-in window.',
            },
            reset: { type: 'boolean', description: 'Restore the global idle duration default.' },
            resetProvider: { type: 'boolean', description: 'Restore the given provider idle duration default.' },
            minContextPercent: { type: 'number', minimum: 0, maximum: 100 },
          },
        },
        compaction: {
          type: 'object',
          additionalProperties: false,
          properties: {
            mainBufferTokens: { type: 'integer', minimum: 0 },
            mainBufferPercent: { type: 'number', minimum: 0, maximum: 100 },
            onModelChange: {
              type: 'boolean',
              description: 'Auto-compact a conversation on its current model before it switches to another one.',
            },
            summaryMode: {
              type: 'string',
              enum: [...COMPACTION_SUMMARY_MODES],
              description:
                'Which model writes compaction summaries: smart (default), maintainer (the Maintainer), self (the conversation model).',
            },
          },
          description:
            'set_compaction: reserved Main context budget (give tokens OR percent, not both), onModelChange and summaryMode; read back with status compaction.',
        },
        enabled: {
          type: 'boolean',
          description:
            'Boolean setters (set_*_enabled, set_compaction, set_auto_update, set_ai_session_titles, set_quota_auto_resume, set_heartbeat_enabled, set_mcp_enabled, set_plugin_enabled, set_agent_connector, set_project_connector).',
        },
        provider: { type: 'string', description: 'set_model_preferences: provider id.' },
        hidden: {
          type: 'boolean',
          description: 'set_model_preferences: false lists the model in /model, true hides it; omitted = unchanged.',
        },
        favorite: {
          type: 'boolean',
          description: 'set_model_preferences: favorite star on or off; omitted = unchanged.',
        },
        instructionFiles: {
          type: 'string',
          enum: [...INSTRUCTION_FILES_MODES],
          description:
            "set_instruction_files: which user instruction files new sessions load (global ~/.codex/AGENTS.md, ~/.claude/CLAUDE.md, then the Project root's AGENTS.md/CLAUDE.md).",
        },
        autoEffortBase: {
          type: 'string',
          enum: [...AUTO_EFFORT_BASES],
          description:
            "set_auto_effort_base: the reasoning effort Auto works around (global; default medium). Auto moves one step down to two steps up from it, within the model's supported efforts.",
        },
        name: {
          type: 'string',
          description: `set_builtin_enabled: ${SETUP_BUILTIN_TOGGLE_FEATURES.join('|')}; install_builtin also accepts memory. Memory toggles use set_memory_enabled. revoke_linked_device: client id from status connection, not its display name; set_developer_option: option id from status developer; read_definition/delete_definition: the definition id; reconnect_mcp: optional MCP server name (omit for all); set_agent_connector(_tool)/set_project_connector: connector (MCP server) id from read_agent_settings; restore_definition: archived agent id; else MCP/plugin/provider id.`,
        },
        accountId: {
          type: 'string',
          description:
            "forget_provider_auth: OAuth account id from status providers with detail:true; required when the provider has several accounts. set_media_default: optional account of the OAuth lane to pin; omitted = the lane provider's selected account.",
        },
        providerAccount: {
          type: 'object',
          additionalProperties: false,
          properties: {
            selectedId: { type: 'string', description: 'Account to use now.' },
            auto: { type: 'boolean', description: 'Automatic switching to another account when one is exhausted.' },
            policy: {
              type: 'string',
              enum: ['manual', 'limit', 'headroom'],
              description:
                'Account switching: manual = selected account only; limit = switch when it reaches a limit; headroom = each new session starts on the account with the most headroom.',
            },
            useCredits: { type: 'boolean', description: 'Allow paid credits once plan limits are reached.' },
            order: {
              type: 'array',
              items: { type: 'string' },
              description: 'Every connected account id exactly once.',
            },
            rename: {
              type: 'object',
              additionalProperties: false,
              required: ['id', 'label'],
              properties: { id: { type: 'string' }, label: { type: 'string', maxLength: 80 } },
            },
          },
          description:
            'set_provider_account: OAuth account change; account ids from status providers with detail:true.',
        },
        modelId: {
          type: 'string',
          description:
            'install_local_model: exact model id from status domain local-provider; runtime must already be installed.',
        },
        phase: {
          type: 'string',
          enum: ['runtime', 'model'],
          description:
            'start_local_installation: which managed asset to install or resume. Model phase requires modelId.',
        },
        jobId: { type: 'string', description: 'cancel_local_installation: current jobId from local-provider status.' },
        idleTtlSeconds: {
          type: 'integer',
          minimum: 0,
          maximum: 86400,
          description: 'set_local_idle_ttl: unload after this many idle seconds, 0 disables; default 3600.',
        },
        minutes: {
          type: 'integer',
          enum: [...HEARTBEAT_INTERVAL_CHOICES],
          description: `set_heartbeat_interval: minutes between Mixy's heartbeat checks; default ${DEFAULT_HEARTBEAT_INTERVAL_MINUTES}.`,
        },
        query: { type: 'string', description: 'search_local_models: Hugging Face GGUF search query.' },
        repository: { type: 'string', description: 'inspect_hf_model: public Hugging Face owner/model repository.' },
        filename: {
          type: 'string',
          description: 'inspect_hf_model: exact GGUF filename from the repository listing; omit to list files.',
        },
        contextWindow: {
          type: 'integer',
          minimum: 16384,
          maximum: 32768,
          description: 'inspect_hf_model: runtime context allocation; default 32768 when the GPU holds it, else 16384.',
        },
        previewId: { type: 'string', description: 'register_hf_model: unexpired read-only inspection receipt.' },
        licenseAccepted: {
          type: 'boolean',
          description: 'register_hf_model: explicit acceptance of the inspected license and installation plan.',
        },
        operation: {
          type: 'string',
          enum: ['verify', 'repair'],
          description: 'maintain_local_model: verify SHA-256 or redownload the pinned model; returns a background job.',
        },
        confirmationToken: {
          type: 'string',
          description: 'delete_local_model: unexpired token from local_model_details.',
        },
        command: {
          type: 'string',
          description: 'set_system_shell: required shell command; "" restores automatic selection.',
        },
        server: {
          ...SETUP_MCP_SCHEMA,
          description:
            'Add: name plus command or url. Save: name (or originalName) plus changed fields; omitted settings and credentials are preserved.',
        },
        skills: {
          type: 'array',
          items: { type: 'string' },
          description: 'set_disabled_skills: full list of disabled skill names.',
        },
        source: { type: 'string', description: 'add_plugin: Git URL, owner/repo, or local path.' },
        connector: {
          type: 'string',
          enum: [...CONNECTOR_IDS],
          description:
            'connect_connector: catalog service to connect. Shows the user a connect card in this conversation (one-click sign-in or a key sheet in Desktop); it never connects by itself.',
        },
        kind: {
          type: 'string',
          enum: ['skills', 'mcp', 'plugins', ...MEDIA_KINDS],
          description:
            'set_extension_scope: which extension list `name` belongs to (skills|mcp|plugins). set_media_default: media kind.',
        },
        projects: {
          type: 'array',
          items: { type: 'string', minLength: 1, pattern: '\\S' },
          description: 'set_extension_scope: required project roots; [] = every project.',
        },
        worktree: {
          type: 'object',
          additionalProperties: false,
          properties: {
            newTaskDefault: {
              type: 'string',
              enum: [...WORKTREE_NEW_TASK_DEFAULTS],
              description: 'branch = new tasks use the current branch (default); worktree = a new worktree.',
            },
            branchPrefix: { type: 'string', description: 'Ref prefix ending with "/"; default "mixdog/".' },
            sizeWarnBytes: {
              type: 'integer',
              minimum: 0,
              description: 'Repository size that asks for confirmation first; 0 never asks.',
            },
            autoCleanup: { type: 'boolean', description: 'Remove clean, merged worktrees when their task ends.' },
          },
          description: 'set_worktree_settings: only the given fields change.',
        },
        sessionId: {
          type: 'string',
          description:
            'reset_route_fallback (default: this session), continue_in_model, schedule_quota_resume, cancel_quota_resume: session id from status model/agents or the session tool. The last three take another session.',
        },
        actionKind: {
          type: 'string',
          enum: [...ACTION_KINDS],
          description: "set_agent_permission: the action kind row of the agent's permission table.",
        },
        permissionMode: {
          type: 'string',
          enum: [...PERMISSION_MODES],
          description:
            'set_agent_permission: block or ask; allow (and any change that lets an agent do more without asking) is made by the person in the desktop app.',
        },
        tool: { type: 'string', description: 'set_agent_connector_tool: tool name within the connector `name`.' },
        permission: {
          type: 'string',
          enum: [...CONNECTOR_PERMISSIONS],
          description: 'set_agent_connector_tool: needs_approval or disabled; auto is made in the desktop app.',
        },
        botOrder: {
          type: 'array',
          items: { type: 'string', minLength: 1, pattern: '\\S' },
          maxItems: 500,
          description:
            'set_bot_order: bot ids in display order (Mixy is always first and not listed); [] = default order.',
        },
        ...SETUP_EXTENDED_PROPERTIES,
      },
    },
  },
]);
