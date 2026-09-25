# Setup actions and domain notes

Read this when choosing a `setup` mutation.

## Read and navigate

- `status` reads one domain: summary, model, agents, workflow, websearch,
  output-style, profile, autoclear, compaction, memory, features, local-provider, shell,
  providers, mcp, skills, plugins, update, onboarding, capabilities, desktop,
  appearance, projects, connection, schedules, or webhooks.
- `open` navigates to a supported UI surface. Read `surfaces.md` for targets and
  UI-only settings.

## Mutation map

| Intent | Action |
|---|---|
| Main model route | `set_route` |
| Agent-specific route or inheritance | `set_agent_route` |
| Web Search model route | `set_web_search_route` |
| Active workflow pack | `set_workflow` |
| Output style | `set_output_style` |
| User title, language, or experience level | `set_profile` |
| Idle session clearing | `set_autoclear` |
| Automatic context compaction | `set_compaction` |
| Memory capability | `set_memory_enabled` |
| Background memory cycles | `set_recap_enabled` |
| Web Search tool exposure | `set_web_search_enabled` |
| Git, Office, Code Tidy, Local Provider, Browser, Computer, or voice enabled state | `set_builtin_enabled` |
| One approval per session before the first Browser Use or Computer Use call (`name`: browser or computer; on by default) | `set_first_use_approval` |
| Git, Memory, Office, Code Tidy, Local Provider, Browser, Computer, or voice preparation | `install_builtin` |
| Managed local model installation (use the local-provider skill) | `install_local_model` |
| Start or resume a background runtime/model download | `start_local_installation` |
| Pause a shared local download, retaining partial files | `cancel_local_installation` |
| Local model idle memory release (0 disables) | `set_local_idle_ttl` |
| Search public Hugging Face GGUF repositories | `search_local_models` |
| Inspect repository files or a pinned GGUF candidate without installing | `inspect_hf_model` |
| Register an approved inspection receipt without downloading | `register_hf_model` |
| Read managed paths and obtain a deletion confirmation receipt | `local_model_details` |
| Background checksum verification or approved redownload | `maintain_local_model` |
| Permanently delete confirmed, unchanged, unused model files | `delete_local_model` |
| TUI system shell | `set_system_shell` |
| Automatic updates | `set_auto_update` |
| Remove stored provider authentication | `forget_provider_auth` |
| Add an MCP server | `add_mcp_server` |
| Edit or rename an MCP server | `save_mcp_server` |
| Remove an MCP server | `remove_mcp_server` |
| Enable or disable an MCP server | `set_mcp_enabled` |
| Reconnect an MCP server | `reconnect_mcp` |
| Replace the disabled skill list | `set_disabled_skills` |
| Limit a skill, MCP server, or plugin to Projects | `set_extension_scope` |
| Register a plugin | `add_plugin` |
| Refresh a plugin checkout | `update_plugin` |
| Enable or disable a plugin | `set_plugin_enabled` |
| Remove a plugin | `remove_plugin` |
| Available hosted models and their options; optionally native-search capable only | `list_models` |
| Agent orchestration, independent of workflow instructions | `set_orchestration_mode` |
| Safe MCP edit metadata, excluding raw connection/credential values | `get_mcp_server` |
| Read a workflow, agent, or skill definition | `read_definition` |
| Create a workflow, agent, or machine-global user skill | `create_definition` |
| Partially edit a workflow, agent, or machine-global user skill | `save_definition` |
| Delete a user workflow/agent definition or override | `delete_definition` |
| Save a schedule/webhook; explicitly overwrite to edit | `save_automation` |
| Delete an existing schedule/webhook | `delete_automation` |
| Enable/disable a schedule/webhook | `set_automation_enabled` |
| Webhook listener enabled state, port, or domain | `set_webhook_config` |
| Desktop keep-awake, usage pin, or Computer observe-only state | `set_desktop_settings` |
| Desktop theme, display language, side panels, or zoom | `set_appearance` |
| Register a Project and optionally set its display alias | `save_project` |
| Unregister a Project without deleting its files | `remove_project` |
| Read Project/Common Instructions before editing | `get_instructions` |
| Replace unchanged Project/Common Instructions and retain a backup | `set_instructions` |
| Revoke one linked device; re-pairing restores access | `revoke_linked_device` |
| Managed local model context allocation; null restores automatic | `set_local_context` |

## Routes and workflow

Inspect `status model`, `status agents`, `status websearch`, or `status
workflow` before changing the corresponding domain.

- A partial route preserves omitted values. Main routes also accept
  `modelParameters` and `contextPercent`; agent routes accept `disabled`.
  Use the model catalog for actual available options, not remembered model ids.
- A Web Search route must support native web search; tool exposure is changed
  separately.
- Definition actions use `definitionKind` (workflow, agent, skill). Read first,
  then supply only changed fields. Workflow/agent ids cannot be renamed through
  a save; change their display name instead. User skills may be renamed with
  `originalName` and `name`. Skill deletion is not exposed; disable it instead.
- Changing orchestration does not rewrite workflow instructions or agents.

## Providers and authentication

Use `status providers` for authenticated state and source. Never request secret
values through chat.

- API-key and OAuth providers: `open providers`, then the user completes
  authentication in the visible UI.
- Local Provider is installed and enabled as a Built-in. Its endpoint is
  Mixdog-managed and is never configured by the user.
  Use the `local-provider` skill for hardware checks, model selection, downloads,
  and recovery. Its narrow status domain exposes installed models and progress;
  the detail dialog lists installed models rather than the download catalog.
- Forgetting authentication is destructive and requires explicit approval.
- Usage sign-in is completed on the Usage or Providers surface.

## Profile, session, and Memory

- Output style changes do not rewrite the current answer already in progress.
- Auto-clear supports global/provider idle durations, `minContextPercent`,
  `reset`, and `resetProvider`. A reset and a duration are mutually exclusive;
  provider reset requires a provider.
- Compaction supports `enabled` and either `mainBufferTokens` or
  `mainBufferPercent`. Changing representation replaces the previous budget.
- If no supported action exposes a requested Memory interval, report it as
  unavailable rather than editing configuration.

## Built-in features

Read `status features` and distinguish installation, enabled state, and live
bridge state.

- Git, Memory, Office, and Local Provider are install-first capabilities.
- Git installation may prepare system Git.
- Office installation may prepare LibreOffice dependencies and global Noto
  fonts as well as the runtime component.
- Browser Use, Computer Use, and voice installation/toggles use the same
  `install_builtin` and `set_builtin_enabled` actions through a live Desktop
  receipt. Computer Use runs on Windows, macOS, and Linux desktops. These
  actions do not approve OS permission dialogs or first-use tool approval on
  the user's behalf.
- Environment feature overrides are diagnostics for headless or benchmark
  environments, not ordinary user settings.

## Skills, MCP, and plugins

- `status skills` plus `set_disabled_skills` manage activation.
- User skills live in the machine-global Mixdog data skills directory;
  `set_extension_scope` limits a global item to selected Project roots.
- Plugin scope is inherited by the skills and MCP integrations it contributes.
- MCP mutation results include reconnection state. Diagnose the returned error
  before making another change.
- MCP add requires name plus command or URL. Save uses `originalName` (defaults
  to name), so changing `name` with `originalName` renames the existing server.
  Omitted fields remain unchanged. Switching transport requires a complete new
  transport. Raw credential fields are not accepted; `env_vars`,
  `bearer_token_env_var`, and `env_http_headers` reference existing environment
  variables without exposing their values.
- Environment/header maps are partial patches. Omitted keys are preserved;
  `null` explicitly removes one key, including a stored credential.
- Plugin enablement moves its contributed skills and MCP integrations together.

## Desktop, Projects, and automation

- `status capabilities` lists supported actions and deliberate handoffs.
- Desktop-only operations require the owning conversation visible in the local
  Desktop app. They affect the Desktop host, not a paired phone. Never claim a
  persisted change from merely delivering a request.
- A display-language change returns `requiresReload`; setup does not reload,
  quit, deploy, or restart the app.
- A Project removal unregisters it only.
- Inspect schedules/webhooks before editing. `overwrite:true` updates an
  existing named entry and preserves omitted fields; a new schedule needs
  instructions plus exactly one of cron `time` or one-shot `at`.
- Attachment contents and webhook signing secrets are not returned by setup.
  Omitted attachments and existing webhook secrets are preserved. Copy a
  signing secret through the Webhooks UI, never chat.
- Enabling or creating automation may start its background worker. This is a
  persisted automation change, not permission to run an unrelated task now.

## Update

Use `status update` and `set_auto_update` for persisted update settings. An
actual update is a separate UI operation and may restart the app; never infer
approval for it from a settings request.

