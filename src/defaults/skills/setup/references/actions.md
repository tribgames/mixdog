# Setup actions and domain notes

Read this when choosing a `setup` mutation. The current tool schema is the
authority for required fields and accepted values.

## Read and navigate

- `status` reads one domain: summary, model, agents, workflow, websearch,
  output-style, profile, autoclear, compaction, memory, features, local-provider, shell,
  providers, mcp, skills, plugins, update, or onboarding.
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
| Git, Office, or Local Provider enabled state | `set_builtin_enabled` |
| Git, Memory, Office, or Local Provider runtime preparation | `install_builtin` |
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

## Routes and workflow

Inspect `status model`, `status agents`, `status websearch`, or `status
workflow` before changing the corresponding domain.

- A partial route preserves omitted values.
- Setting an agent route provider to an empty string removes the override and
  restores Main inheritance.
- A Web Search route must support native web search; tool exposure is changed
  separately.
- Workflow definitions and custom agent definitions are edited through their
  supported UI or file workflow, not through undocumented setup keys.

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
- Profile response language and Desktop display language are separate.
- Auto-clear supports a global or provider-specific idle duration.
- Memory master state controls tools, core injection, and background cycles.
  `set_recap_enabled` changes only the background cycles.
- Core Memory entries are read and changed with the `memory` tool, not setup.
- If no supported action exposes a requested Memory interval, report it as
  unavailable rather than editing configuration.

## Built-in features

Read `status features` and distinguish installation, enabled state, and live
bridge state.

- Git, Memory, Office, and Local Provider are install-first capabilities.
- Git installation may prepare system Git.
- Office installation may prepare LibreOffice dependencies and global Noto
  fonts as well as the runtime component.
- Browser Use, Computer Use, and voice installation/toggles are UI-owned.
  Computer Use is Windows-only.
- Environment feature overrides are diagnostics for headless or benchmark
  environments, not ordinary user settings.

## Skills, MCP, and plugins

- `status skills` plus `set_disabled_skills` manage activation. The setter
  replaces the whole list.
- User skills live in the machine-global Mixdog data skills directory. There is
  no project-local skill source; `set_extension_scope` limits a global item to
  selected Project roots.
- MCP servers and plugins are machine-global. Plugin scope is inherited by the
  skills and MCP integrations it contributes.
- MCP mutation results include reconnection state. Diagnose the returned error
  before making another change.
- Plugin enablement moves its contributed skills and MCP integrations together.

## Update

Use `status update` and `set_auto_update` for persisted update settings. An
actual update is a separate UI operation and may restart the app; never infer
approval for it from a settings request.

