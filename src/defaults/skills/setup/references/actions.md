# Setup actions and domain notes

Read this when choosing a `setup` mutation.

## Read and navigate

- `status` reads one domain from the schema enum; pick the narrowest.
- Results are compact JSON. `status providers` lists configured providers
  only (`id`, `kind`, `authenticated`, `status`, `accounts` count); add
  `detail: true` for every provider with key URLs, expiry and account ids.
- `list_models` narrows in steps: no `catalog` returns the provider index
  (`provider`, `count`, `defaultModel?`); `catalog.provider` returns compact
  rows (`id`, `display`, `context`, `efforts`, `fast?`, `vision?`) with
  `total`/`page`/`pages`/`nextPage` (`page`, `limit` ≤ 100, default 25);
  `catalog.model` (plus `provider` if several offer the id) returns that
  model's full options. `webSearch` limits to native-search models; `refresh`
  reloads the catalog.
- `open` navigates to a supported UI surface. Read `surfaces.md` for targets and
  UI-only settings.

## Mutation map

| Intent | Action |
|---|---|
| Main model route | `set_route` |
| Agent-specific route or inheritance | `set_agent_route` |
| Web Search model route (and its `route.fallbacks`) | `set_web_search_route` |
| Active workflow pack | `set_workflow` |
| Output style | `set_output_style` |
| User title, language, or experience level | `set_profile` |
| Idle session clearing, per provider, including `unlimited` | `set_autoclear` |
| Automatic context compaction, compaction on model change, summary model | `set_compaction` |
| Context → Let AI rename sessions | `set_ai_session_titles` |
| Providers → Usage limits → Resume automatically when the limit resets | `set_quota_auto_resume` |
| Model management: "Show in /model" and favorites, per provider model | `set_model_preferences` |
| Memory capability | `set_memory_enabled` |
| Background memory cycles | `set_recap_enabled` |
| Web Search tool exposure | `set_web_search_enabled` |
| Which user instruction files (AGENTS.md / CLAUDE.md) new sessions load: all, agents, claude, or off | `set_instruction_files` |
| The reasoning effort Auto works around: low, medium (default), or high | `set_auto_effort_base` |
| Git, Office, Code Tidy, Local Provider, Auto Effort, Browser, Computer, voice, Visualize, or Media generation enabled state | `set_builtin_enabled` |
| Git, Memory, Office, Code Tidy, Local Provider, Auto Effort, Browser, Computer, or voice preparation | `install_builtin` |
| Managed local model installation | `install_local_model` |
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
| Mixy's heartbeat: a regular check that wakes her only when something needs attention and only after the user had no operation for 30 minutes (no sent turn, no keyboard/mouse/wheel input in the desktop app's windows) (on by default; `status features` reports `heartbeat.enabled` and `heartbeat.intervalMinutes`) | `set_heartbeat_enabled` |
| How often the heartbeat checks: `minutes` 30, 60 (default), 120 or 240; applies from the next tick, counted from the last check | `set_heartbeat_interval` |
| Bots' emoji reactions on the user's messages (on by default; `status features` reports `reactions.enabled`) | `set_reactions_enabled` |
| Worktree defaults: new tasks on the current branch or a new worktree, branch prefix, large-repository warning size, automatic cleanup | `set_worktree_settings` |
| Remove stored provider authentication (one OAuth account at a time, or an API-key provider's key) | `forget_provider_auth` |
| Select, rename, or reorder OAuth accounts, set automatic switching or the switching policy, or allow paid credits | `set_provider_account` |
| Developer options (approvals, risk-gated providers); `allowAllActions` can only be turned off | `set_developer_option` |
| Connect a catalog service (Notion, Linear, Gmail, …; not GitHub, which is the GitHub CLI) for the user: shows a connect card (sign-in, key sheet, or app-password dialog) | `connect_connector` |
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
| Turn back on and reconnect every MCP server a plugin declares | `enable_plugin_mcp` |
| Hosted model catalog: provider index, one provider's paged model rows, or one model's full options | `list_models` |
| Agent orchestration, independent of workflow instructions | `set_orchestration_mode` |
| Safe MCP edit metadata, excluding raw connection/credential values | `get_mcp_server` |
| Read a workflow, agent, or skill definition | `read_definition` |
| Create a workflow, agent, or machine-global user skill | `create_definition` |
| Partially edit a workflow, agent, or machine-global user skill | `save_definition` |
| Delete a user workflow/agent definition or override | `delete_definition` |
| Save a schedule/webhook; explicitly overwrite to edit. A new one belongs to the calling thread's agent (Mixy = `lead`); `entry.owner` moves it to another agent | `save_automation` |
| Delete an existing schedule/webhook | `delete_automation` |
| Enable/disable (pause/resume) a schedule/webhook | `set_automation_enabled` |
| Run a schedule once now, or re-run a webhook on its latest received payload; the result posts into the owning agent's thread | `run_automation` |
| Webhook listener enabled state, port, or domain | `set_webhook_config` |
| Desktop keep-awake, run in background after window close, turn-completion notifications, notification volume (Windows), usage pin, usage rail short + long bars, expanded usage accounts, usage rail slots (three / all), Computer observe-only, Browser auto sign-in, or the representative bot overlay (`desktop.botOverlay`) | `set_desktop_settings` |
| Desktop theme, imported color theme, UI/code font, UI scale, code size and ligatures, chat text size, skin transparency (outer or main panels), display language, time format, side panels and their position, markdown default view, link previews, or tool activity expansion | `set_appearance` |
| Add a before-tool hook rule | `add_hook_rule` |
| Enable or disable a hook rule by its `status hooks` index | `set_hook_rule_enabled` |
| Delete a hook rule by its `status hooks` index | `delete_hook_rule` |
| Settings "Default generator" pin per kind (image/video): lane, model, account; `lane: ""` clears it (Auto) | `set_media_default` |
| Which activity rail items are pinned, in order (current list in `status desktop`) | `set_activity_rail_pins` |
| Register a Project and optionally set its display alias | `save_project` |
| Unregister a Project without deleting its files | `remove_project` |
| Revoke one linked device by its client id from `status connection`; re-pairing restores access | `revoke_linked_device` |
| Managed local model context allocation; null restores automatic | `set_local_context` |
| Return a session that fell back (this one by default, `sessionId`, or every chat of a bot with `agent`) to its primary route and chain | `reset_route_fallback` |
| Switch a session whose last turn stopped on a usage limit onto another model (`sessionId`, `route`) | `continue_in_model` |
| Resend a usage-limit-stopped turn of a session at its reset time, or drop that pending resume | `schedule_quota_resume`, `cancel_quota_resume` |
| Prompt-cache warming on/off (`status compaction` `promptCacheWarming`) | `set_cache_warming_enabled` |
| Read an agent's action permissions, connector switches and always-allowed tools | `read_agent_settings` |
| Read a Project's connector switches | `read_project_connectors` |
| An agent's action permission (block/ask per action kind) | `set_agent_permission` |
| Switch a connector off for an agent / a Project (switching it back on is done in the desktop app) | `set_agent_connector`, `set_project_connector` |
| One connector tool of an agent to needs_approval or disabled | `set_agent_connector_tool` |
| Bring back an archived bot or agent (`definitionKind: "agent"`) | `restore_definition` |
| Bot display order (Bots page, Sessions bot section; `status agents` `botOrder`) | `set_bot_order` |

## Routes and workflow

Inspect `status model`, `status agents`, `status websearch`, or `status
workflow` before changing the corresponding domain.

- Main and agent routes also accept `modelParameters`, `contextPercent`, and
  `contextTokens` (an exact window in tokens that overrides `contextPercent`);
  agent routes accept `disabled`. Route `autoEffort` (Main and agent only)
  turns Auto reasoning on/off for that route; the Auto Effort built-in toggle
  is the machine-wide switch and must also be on and `ready`.
  Before `set_route`, read `list_models` with `catalog.model` (and `provider`)
  for the model's `effortOptions`, `defaultEffort`, `fastCapable`,
  `serviceTiers`, `modelParameterOptions` and `parameterVariants`; take
  `effort`, `fast` and `modelParameters` values only from it, never from
  remembered model ids.
- A Web Search route must support native web search; tool exposure is changed
  separately.
- Definition actions use `definitionKind` (workflow, agent, skill).
  A workflow or agent `read_definition` returns `path` when a user copy exists:
  to change part of its body, edit that file with the ordinary file edit tool
  instead of re-sending the whole body; keep its frontmatter as it is. Without
  `path` (a shipped-only definition), make the change with `save_definition`:
  a save equal to the shipped copy keeps no user file.
  Workflow/agent ids cannot be renamed through
  a save; change their display name instead. User skills may be renamed with
  `originalName` and `name`. A user skill's trigger line (`when_to_use`) is
  `definition.whenToUse` on create and save. Skill deletion is not exposed;
  disable it instead.
  Built-in and plugin skills accept only `toolDependencies` edits (`null`
  restores their declared dependencies).
- A created agent is a bot (`definition.kind: "bot"`) or a workflow agent
  (`"agent"`); omitted, the representative bot's chat creates a bot and any other chat a
  workflow agent. The kind is fixed after creation.
- Changing orchestration does not rewrite workflow instructions or agents.
- `set_route` is the Lead default for new sessions. A model chosen in New Task
  changes that default only when the user actually picks one there.
  `route.fallbacks` (ordered models, each on a different provider from the
  primary and the others; `[]` clears) works the same on `set_route` (Lead),
  `set_agent_route` (agents and bots, Mixy included) and `set_web_search_route`.
  Running sessions on that route read the chain at their next hop: an edit
  applies at once, and `[]` stops further hops, so the turn ends with the
  provider's own limit error. A session on another model follows no chain.
  `status model` returns `route.autoEffort`, `route.fallbacks`, and the
  position of this conversation (`session`) and other Lead conversations
  (`sessions`): `current` vs `primary`, `onPrimary`, `fallbackIndex`, the
  `fallbacks` it follows now, `next`, and `failures` (why it left each model);
  `status agents` `sessions` gives the same for bot chats and sub-agents. A
  session that fell back stays there until `reset_route_fallback` returns it
  to its primary from its next turn (chain restarted).
- Session actions on another session need the Mixdog app or daemon to host
  it; a bot's thread reaches only its own bot's sessions. `continue_in_model`
  does not resend the stopped turn: the user resumes it there.
- A workflow switch reaches a running conversation as a reminder on its next
  turn (the cached prompt is not swapped). A bot definition's instruction,
  persona or name applies when the user presses 적용, with one cache break.
  Connector and built-in feature changes reach a bot's open chat at once for
  availability: opened tools join the deferred catalog, removed ones are
  refused at call time, and the next turn's notice names both. Only the prompt
  text describing them waits until the cache next expires.

## Providers and authentication

Use `status providers` for authenticated state; `detail: true` adds each API
key's source.

- API-key and OAuth providers: `open providers`, then the user completes
  authentication in the visible UI.
- An SSH server's models run on this PC's logins by default. A server can use
  its own instead (Settings → Connection → the server → Model login → Server
  accounts); its logins are then managed in "Manage server logins" (a
  subscription login opens in this PC's browser; an API key is stored on the
  server, in an owner-only private file where it has no keychain, as on
  Linux). No setup action exists for this. Changing the model login restarts
  the server's Mixdog and stops its running sessions, so say so before the
  user confirms. The login key file (Advanced options of the connect dialog,
  or the server's settings) is also UI-only; it applies to every connection
  to that server. The connect dialog refuses a different key or folder for a
  server that is connected already (disconnect first); the server's own
  settings accept and save a changed key file while connected, and it applies
  from the next connection.
- Custom providers are registered, edited (non-secret fields too), tested, and
  removed in the Providers UI; no setup action exists yet;
  `status providers` with `detail: true` lists them as API rows with `custom: true`.
  Their model list (Nano-GPT included) loads there with up to a 60 s wait; the
  user can skip it and type model ids by hand.
- Local Provider is installed and enabled as a Built-in. Its endpoint is
  Mixdog-managed and is never configured by the user.
  Use the `local-provider` skill for hardware checks, model selection, downloads,
  and recovery. Its narrow status domain exposes installed models and progress;
  the detail dialog lists installed models rather than the download catalog.
- Forgetting authentication is destructive and requires explicit approval.
  It removes one OAuth account (a provider with several accounts requires
  `accountId` from the account list in `status providers` with `detail: true`)
  or an API-key provider's key (no `accountId`).
- `set_provider_account` changes the selected account, automatic switching
  when one is exhausted (`auto`), paid-credit use after
  plan limits (`useCredits`), account order (every account id exactly once),
  an account label, or the switching `policy`: `manual` stays on the selected
  account, `limit` switches when it hits a limit, `headroom` starts each new
  session on the account with the most headroom. `status providers` with
  `detail: true` returns the current `policy` when one is set. Sign-in for a new account still
  happens in the Providers UI.
- `status developer` lists developer options. An option with a `warning` is
  enabled only after the user explicitly accepts that warning, passed as
  `riskAccepted:true`; never assume acceptance. `allowAllActions` ("Allow all
  actions") can be turned off here, but turning it on is refused even then:
  only the person turns it on, so `open developer`.
- `set_quota_auto_resume` is read back as `quotaAutoResume` in `status
  providers`; turning it off cancels pending resumes.
- `set_model_preferences` (`hidden`, `favorite`; omitted = unchanged) matches
  Model management. `list_models` rows show `hidden` / `favorite`; a hidden
  custom-provider model no longer appears in `list_models`.

## Profile, session, and Memory

- Output style changes do not rewrite the current answer already in progress.
- Profile `language` and `experienceLevel` take ids listed by `status profile`;
  unknown ids are rejected, and an empty `experienceLevel` clears it.
- Auto-clear supports global/provider idle durations, `minContextPercent`,
  `reset`, and `resetProvider`. A provider window overrides the global
  duration; `provider: "default"` sets the fallback for providers without a
  built-in window. A reset and a duration are mutually exclusive; provider
  reset requires a provider.
- `duration: "unlimited"` (or `"never"`) stops idle clearing for a provider;
  without `provider` it applies to the current route's provider. `status
  autoclear` reports `unlimited`, `label` and per-provider `providerDefaults`
  (`builtInUnlimited` marks a built-in unlimited window); a provider reset
  restores its built-in window. Built-ins follow each provider's cache: Codex/
  ChatGPT login unlimited, OpenAI API 30 min, Anthropic and Gemini 1h. The
  OpenAI API caches a Lead-class session's stable prefix for 12h and its
  moving tail for 30 min (Lead, bot chats, bot task sessions, routine and
  webhook runs), so the 30 min window clears only a cold tail. Finished
  sub-agent sessions are always released on a finite timer (the provider's
  window, e.g. DeepSeek 24h; 1h for Codex/ChatGPT logins); unlimited does not
  disable it.
- Compaction supports `enabled` and a `compaction` object with either
  `mainBufferTokens` or `mainBufferPercent` (changing representation replaces
  the previous budget), `onModelChange` (compact before switching models) and
  `summaryMode`: `smart`, `maintainer`, or `self` (Conversation model).
  `status compaction` returns them plus `aiSessionTitles`
  (`set_ai_session_titles`).
- If no supported action exposes a requested Memory interval, report it as
  unavailable rather than editing configuration.

## Built-in features

Read `status features` and distinguish installation, enabled state, and live
bridge state. `status features` covers Git, Memory, Office, Code Tidy, Local
Provider, Auto Effort and Web Search plus Browser/Computer/Terminal bridge
activity and voice state (enabled, runtime installed, missing whisper/model/
ffmpeg components); the Browser Use / Computer Use installed and enabled
markers are read with `status desktop`.

- Git, Memory, Office, and Local Provider are install-first capabilities.
- Git and Office installation run on the Desktop when this conversation is
  open there, like the Built-in card: Git installs system Git; Office installs
  LibreOffice and global Noto fonts as well as the runtime component. When no
  Desktop takes the request, `install_builtin` activates them from the runtime
  (Office fonts only), so system Git and LibreOffice must already be present.
- Memory installation downloads the embedding model; an offline or failed
  download fails the install.
- Auto Effort is on by default where supported; it picks each turn's
  reasoning effort with a local judge model downloaded in the background.
  Enabling or installing it fails on unsupported machines; `status features`
  reports `supported`, `installing` (judge download running) and `ready`.
- Visualize (on by default) and Media generation are toggle-only through
  `set_builtin_enabled`; `install_builtin` does not accept them.
- Terminal follows the live Desktop terminal bridge and has no toggle.
- Environment feature overrides (`MIXDOG_FEATURE_*`) win over these toggles;
  they are diagnostics for headless or benchmark environments, not user
  settings.
- Browser Use and Computer Use installation/toggles use the same
  `install_builtin` and `set_builtin_enabled` actions through a live Desktop
  receipt. Computer Use runs on Windows, macOS, and Linux desktops. These
  actions do not approve OS permission dialogs on the user's behalf.
- Voice runs on the runtime, with or without a Desktop window. Enabling it
  (`set_builtin_enabled` true or `install_builtin`) first downloads any missing
  whisper runtime, model, or ffmpeg, which can take minutes; a failed or
  already-running install fails the action. Disabling keeps the installed
  runtime. `status features` reports `installing` while a download runs.

## Hooks and media

- `status hooks` lists before-tool rules with their `index`, plus configured
  lifecycle events, config sources and errors. Argument edits are reported
  only as `hasArgumentEdit`; their contents are never returned. Indexes shift
  after a delete;
  re-read status before addressing another rule.
- `add_hook_rule` with modify/rewrite needs exactly one of `patch` or `args`.
- `delete_hook_rule` is destructive and requires explicit approval for the
  named rule; disabling with `set_hook_rule_enabled` preserves it.
- Hook rule changes apply to open sessions and their sub-agents on the next
  tool call; no new session or restart is needed.
- `status media` returns `pinned` and `remembered` ({image, video} each). The
  pin is the Settings "Default generator"; the remembered entry is the last-used
  generator, and the pin wins over it. A generation naming no lane/model uses
  the pin, else the remembered one. `set_media_default` takes
  `{kind, lane, model?, accountId?}` and accepts only a signed-in lane that
  offers the kind (and the model, when given) in the live media catalog; the
  media tool's `list` reads that catalog. `lane: ""` clears the pin (Auto).

## Skills, MCP, and plugins

- `status skills` plus `set_disabled_skills` manage activation.
- `set_extension_scope` limits a global item to selected Project roots.
- Plugin scope is inherited by the skills and MCP integrations it contributes.
- MCP mutation results include reconnection state. Diagnose the returned error
  before making another change.
- MCP add requires name plus command or URL. Save uses `originalName` (defaults
  to name), so changing `name` with `originalName` renames the existing server.
  Omitted fields remain unchanged. Switching transport requires a complete new
  transport. Raw credential fields are not accepted; `env_vars`,
  `bearer_token_env_var`, and `env_http_headers` reference existing environment
  variables without exposing their values.
- `startupTimeoutSec` (connect/handshake, default 30) and `toolTimeoutSec`
  (per tool call, default 120) are positive seconds. Raise them for slow
  servers instead of reconnecting repeatedly; a timed-out call is never
  replayed.
- Environment/header maps are partial patches. Omitted keys are preserved;
  `null` explicitly removes one key, including a stored credential.
- Plugin enablement moves its contributed skills and MCP integrations together.
- A registered plugin's MCP servers (its `.mcp.json` and manifest
  `mcpServers`) appear automatically with `source: "plugin"` and `plugin` /
  `pluginServer` in `status mcp`; nothing is copied into the MCP list. A plugin
  server runs only while both the plugin and the server are enabled;
  `set_mcp_enabled` toggles the server, `set_plugin_enabled` the plugin, and
  `set_extension_scope` limits it (the plugin's scope still applies).
  `add_mcp_server`, `save_mcp_server`, and `remove_mcp_server` refuse plugin
  servers. Declaration problems and naming conflicts are reported as
  `declarationErrors` and `warnings`.
- `connect_connector` is how to connect a catalog service the user asks for
  ("Slack 연결해 줘"): it leaves a connect card in the conversation whose
  press runs the service's sign-in, key sheet or (Gmail: app password only)
  dialog in Desktop; nothing connects until the user presses it, so tell them to press the card and read
  `status mcp` afterwards. `add_mcp_server` with the service URL is not the
  sign-in flow; never use it for a catalog service.
- Agent permissions and connector switches change only toward less: `block`
  or `ask`, a connector off, a tool to `needs_approval`/`disabled`. Anything
  that lets an agent do more without asking (`allow`, a connector back on, a
  tool to `auto`) is refused ("make it on the desktop"); `open agents` and let
  the person do it. Payments and permanent deletes always ask regardless.
  Connector ids are MCP server names from `read_agent_settings`; a bot's
  thread changes only its own bot.
- `enable_plugin_mcp` turns every server the plugin declares back on and
  reconnects them; a disabled plugin stays disabled, and it fails for a plugin
  that declares no MCP servers.

## Desktop, Projects, and automation

- `status capabilities` lists supported actions and deliberate handoffs.
- Desktop-only operations require the owning conversation visible in the local
  Desktop app. Never claim a persisted change from merely delivering a request.
- A display-language change returns `requiresReload`; so does a changed
  `timeFormat` (already-shown times update after the window reloads, which is
  never automatic).
- `set_appearance` also takes `uiFont` / `codeFont` (a family name, `""` =
  built-in; text it lacks falls back to the built-in fonts), skin transparency
  (0–100, defaults outer 20 / main 40; higher shows more of the skin picture):
  `skinOuterTransparency` (window frame, titlebar, rail, sidebar, side dock),
  `skinMainTransparency` (conversation area and its cards), or `skinTransparency`
  to set both; and `colorTheme`
  (an imported theme id from `status appearance` `colorThemes`, or `"builtin"`).
  Also `timeFormat` (system|12h|24h), `sidePanelPosition` (right|bottom|auto),
  `uiScale` (0.85–1.2, step 0.05), `codeSize` (10–20), `codeLigatures`
  (bool) and `chatTextSize` (small|default|large|extra-large). The UI label
  "Light" is `theme: "white"`.
  Importing, exporting or removing a theme file and choosing a skin picture
  or its plate/accent/photo stay in the UI.
- `set_desktop_settings` `desktop.botOverlay` takes `enabled`, `position`
  (`pinned` above the message box, `pinnedHere`, `free` in the app window,
  `onScreen` free on screen), `keepAbove`, `collapsed`, `autoAdvance`,
  `autoClose` and `scale` (50–200, step 10). Enabling needs the
  representative bot; `status desktop` returns `botOverlay`. Reset position
  stays in the UI.
- A Project removal unregisters it only.
- Inspect schedules/webhooks before editing. `overwrite:true` updates an
  existing named entry and preserves omitted fields; a new schedule needs
  instructions and exactly one of cron `time` or one-shot `at`.
- Routine instructions say what to check and report; add a reply format only
  when the user asks. Never add a "nothing new" line ("say 변동 없음"): a run
  with nothing to tell stays silent on its own.
- Attachment contents and webhook signing secrets are not returned by setup.
  Omitted attachments and existing webhook secrets are preserved. A saved
  secret is never shown again: tell the user to open the Webhooks panel, edit
  the webhook, press Regenerate secret, copy the new value, and save.
- A routine run (schedule or webhook) is a turn in the owning bot's chat with
  nobody to approve: it never prompts, refuses payment and permanent-delete
  connectors (trash moves are allowed), and still honors bot permission
  "block". It can change only its own bot's automations and route. A webhook
  answers "accepted" at once and a delivery that arrives while its run is
  active is skipped. In an attended bot conversation (chat, room, or work a
  bot started) the same payment and permanent-delete connectors ask first,
  allow once or deny only; a coding session is not asked.
- Enabling or creating automation may start its background worker. This is a
  persisted automation change, not permission to run an unrelated task now.

## Update

Use `status update` and `set_auto_update` for persisted update settings. An
actual update is a separate UI operation and may restart the app; never infer
approval for it from a settings request.

