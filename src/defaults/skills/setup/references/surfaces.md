# Settings surfaces

Read this only when the user asks where a setting lives, must enter a secret,
or requests a setting with no mutation action.

## `open` targets

| Target | Destination |
|---|---|
| `settings` | Settings home |
| `providers` | Provider authentication and local providers |
| `model` | Main model selection |
| `websearch` | Web Search route |
| `workflow` | Workflow packs |
| `agents` | Agent definitions and routes |
| `outputstyle` | Output style |
| `theme` | Theme surface where supported |
| `profile` | User profile |
| `autoclear` | Session lifecycle controls |
| `memory` | Memory capability surface |
| `mcp` | Extensions → Skill → MCP, including OAuth Connect/Reconnect/Disconnect |
| `skills` | Extensions → Skill → Skills |
| `plugins` | Extensions → Plugin |
| `update` | Update surface |
| `usage` | Provider usage sign-in |
| `doctor` | Runtime diagnostics |
| `context` | Context and compaction |
| `developer` | Developer options (TUI: Developer picker) |
| `voice` | Voice built-in (TUI: Settings hub) |
| `connection` | Web-app pairing; Desktop only, the TUI shows guidance |

An attached Desktop or TUI may navigate and return `opened:true`.

## Desktop map

- Settings → General: profile, Web Search exposure, display language, theme,
  side panels, and notifications.
- Settings → Context: auto-compact and auto-clear.
- Settings → Output style: output style selection, plus the desktop-only
  "Expand tool activity" choice (collapsed / commands and edits / everything),
  saved per device; Ctrl+O toggles everything open for the current window.
- Settings → Providers: API-key, OAuth, custom provider registration, local
  providers, and usage sign-in.
- Extensions → Plugin → Git & GitHub: Git/GitHub CLI installation and connection.
- Settings → Connection: web-app pairing and linked devices.
- Settings → System: update, keep-awake, run in background after the window
  closes, and Doctor.
- Settings → Developer options: risk-gated OAuth providers.
- Projects: Project registration, name, Project Memories, and Common Memory.
- Workflows: workflow packs, Main and Web Search defaults, and agent editing.
- Extensions → Plugin: Built-in cards and plugins.
- Extensions → Skill: skills and MCP servers.

Provider authentication is intentionally hidden from the remote web app; guide
the user to Desktop.

## Desktop-backed settings

`set_desktop_settings`, `set_appearance`, `set_activity_rail_pins`,
`save_project`, `remove_project`, `revoke_linked_device`, and Browser/Computer
install or toggles run through the attached Desktop; the receipt identifies
`scope:desktop-host`.

Computer observe-only and background Memory cycles (`set_recap_enabled`)
have no settings control in either app; setup is their only supported route.
Usage pin and the short + long rail bars live in the usage card's flyout menu
on the activity rail.

Schedules/webhooks and workflow/agent/skill definitions use their runtime
actions directly. These do not require clicking their Desktop rails.

## User-operated UI handoffs

The setup tool does not mutate:

- API keys, OAuth, usage sign-in, and GitHub CLI connection;
- MCP server OAuth sign-in and sign-out (Desktop MCP list/editor, TUI
  `/mcp login` and `/mcp logout`; remote windows paste the redirect address);
- notification permission and subscription on the receiving device;
- web-app pairing credentials and OS permission dialogs;
- TUI-local theme palettes (use `/theme`; Desktop themes are separate).

Use `open` where a target exists, then let the user act.

## TUI notes

The TUI settings hub exposes system shell in addition to common settings.
Desktop-host actions need the Desktop app; opening the TUI is not a substitute.

