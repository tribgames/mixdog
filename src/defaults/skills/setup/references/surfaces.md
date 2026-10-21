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

- Settings → General: profile, Web Search exposure, display language,
  side panels, and notifications.
- Settings → Context: auto-compact and auto-clear.
- Settings → Output style: output style selection, plus the desktop-only
  "Expand tool activity" choice (collapsed / commands and edits / everything),
  saved per device; Ctrl+O toggles everything open for the current window.
- Settings → Theme (one page): System / Dark / Light or a skin picture
  (plate, accent, transparency), imported JSON color themes (about 26 color
  roles), installed fonts, font sizes and chat text size. Saved on this device
  only. First-run setup has a Theme step with the same System / Dark /
  Light / skin choice.
- Settings → Bots (desktop only): the representative bot overlay, a small
  window with the representative bot that opens a quick message to it. On
  by default; options to pin it above the message box (default on), keep it
  above other windows (default off: it follows the app window's layer),
  collapse its bubble and reset its position. The overlay's right-click
  menu has the same options. Saved on this PC.
- Settings → Providers: API-key, OAuth, custom provider registration, local
  providers, and usage sign-in. A custom provider's model list waits up to
  60 s, can be skipped, and then takes model ids typed by hand.
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
- TUI-local theme palettes (use `/theme`; Desktop themes are separate);
- importing or exporting a JSON color theme file, choosing a skin or custom
  skin picture, and the Lead's pixel face (stored on the host as `leadAvatar`,
  edited from the Desktop or a paired client, and shared by all of them; every
  Lead-class row and agent wears it, and the agent edit dialog has no avatar);
- approval grants ("항상 허용" is per feature and per bot, never for payment,
  permanent delete, Lead, workflow, Mixy link, group rooms or schedules) and
  browser action confirmations (`MIXDOG_BROWSER_CONFIRM_ACTIONS`,
  `MIXDOG_BROWSER_CONFIRM_SUBMIT`; see the browser-use skill).

Use `open` where a target exists, then let the user act.

## TUI notes

The TUI settings hub exposes system shell in addition to common settings.
Desktop-host actions need the Desktop app; opening the TUI is not a substitute.

