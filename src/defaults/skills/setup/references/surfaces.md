# Settings surfaces

Read this only when the user asks where a setting lives, must enter a secret,
or requests a setting with no mutation action.

## `open` targets

| Target | Destination |
|---|---|
| `settings` | Settings home |
| `providers` | Provider authentication |
| `model` | Main model selection |
| `websearch` | Web Search route |
| `workflow` | Workflow packs |
| `agents` | Agent definitions and routes |
| `outputstyle` | Output style |
| `theme` | Theme surface where supported |
| `profile` | User profile |
| `autoclear` | Session lifecycle controls |
| `memory` | Memory capability surface (Built-in card on the Extensions tab) |
| `mcp` | Extensions → Connectors tab, including OAuth Connect/Reconnect/Disconnect |
| `skills` | Skills (activity rail destination) |
| `plugins` | Extensions → Extensions tab (plugins that bring MCP servers: Connectors → Custom connectors) |
| `update` | Update surface |
| `usage` | The /usage surface (provider usage); no sign-in |
| `doctor` | Runtime diagnostics |
| `context` | Context and compaction |
| `developer` | Developer options (TUI: Developer picker) |
| `voice` | Voice Built-in card on the Extensions tab (TUI: Settings hub) |
| `connection` | Web-app pairing; Desktop only, the TUI shows guidance |

An attached Desktop or TUI may navigate and return `opened:true`.

## Desktop map

- Settings → General: profile; Features (Regular check-ins, Reactions, Web
  search, import conversations from other apps (UI-only), Load instruction
  files, Auto reasoning base, link preview); notifications; worktree
  defaults; display language, time format, side panels and their position;
  markdown default view.
- Settings → Context: Let AI rename sessions, auto-compact (also on model
  change, summary model) and auto-clear.
- Settings → Model management: "Show in /model" and favorites per model.
- Settings → Output style: output style selection, plus the desktop-only
  "Expand tool activity" choice (collapsed / commands and edits / everything),
  saved per device; Ctrl+O toggles everything open for the current window.
- Settings → Theme (one page): System / Dark / Light (`theme: "white"`) or a
  skin picture (plate, accent, photo, transparency), imported JSON color
  themes (about 26 color roles; import/export/remove are UI-only), installed
  fonts, font sizes and chat text size. Saved on this device only. First-run
  setup has a Theme step with the same System / Dark / Light / skin choice.
- Settings → Bots (desktop only): the representative bot overlay, a small
  window with the representative bot that opens a quick message to it. On
  by default; options: enable, Position (4-way: pinned above the message box
  (default), pinned here, free in the app window, free on screen), keep above
  other windows (default off), collapse bubble, auto-advance long replies,
  close replies automatically, size, and reset position (UI-only). The
  overlay's right-click menu has the same options. Saved on this PC.
- Settings → Providers: API-key and OAuth authentication, custom provider
  registration, and Usage limits (resume automatically). A custom provider's
  model list waits up to 60 s, can be skipped, and then takes model ids typed
  by hand. Local models are managed in the Local Provider Built-in detail.
- Settings → Connection (desktop only): web-app pairing, this PC's name and
  the remote-access switch, connected devices (rename, Disconnect all), "PCs
  I opened", SSH servers (per-server settings, server logins, cleanup), and
  "Reopen server windows". Only `revoke_linked_device` has a tool action.
  SSH connect: the address dialog's collapsed "Advanced options" take a login
  key file (typed or browsed) and a default server folder; the key file is
  used for every later connection to that server (reconnects included), and a
  server is saved only after a connection with those settings worked. A server
  that is connected already refuses a changed key or folder: disconnect first.
  Per-server "Model login" is "This PC's accounts" (the default; models run
  through this PC, only while it is connected) or "Server accounts" (models run
  with the logins signed in on the server). "Manage server logins" (Server
  accounts, connected server) logs a provider in or out on the server; an API
  key saved there is kept in a private file (owner-only) when the server has
  no keychain, as on Linux. Changing the model login restarts the server's
  Mixdog after one confirmation and stops its running sessions.
- Settings → System: update, keep-awake, run in background after the window
  closes, and Doctor.
- Settings → Developer options: data-driven sections (approvals, risk-gated
  providers); read them with `status developer`.
- Projects: Project registration, name, Project Memories, and Common Memory.
- Workflows: workflow packs, Main and Web Search defaults, and agent editing.
- Extensions → Extensions tab: Built-in cards (including Git & GitHub, Media
  generation and its Default generator) and plugins.
- Extensions → Connectors tab: MCP servers and catalog connectors (Gmail
  connects only with an app password; Calendar and Drive offer "Use my
  Google key"), plus Custom connectors (including plugin MCP servers).
- Skills (activity rail): skills.

Provider authentication is intentionally hidden from the remote web app; guide
the user to Desktop.

## Desktop-backed settings

`set_desktop_settings`, `set_appearance`, `set_activity_rail_pins`,
`save_project`, `remove_project`, `revoke_linked_device`, and Browser/Computer
install or toggles run through the attached Desktop; the receipt identifies
`scope:desktop-host`.

Computer observe-only and background Memory cycles (`set_recap_enabled`)
have no settings control in either app; setup is their only supported route.
Usage pin, the short + long rail bars, expanded accounts and rail slots live
in the usage card's flyout menu on the activity rail.

Schedules/webhooks and workflow/agent/skill definitions use their runtime
actions directly. These do not require clicking their Desktop rails.

## User-operated UI handoffs

The setup tool does not mutate:

- API keys, OAuth, and GitHub CLI connection;
- turning on the developer option "Allow all actions" (only the person turns
  it on; `set_developer_option` can turn it off);
- custom provider registration and edits (non-secret fields included), group
  room options, bot persona and avatar, import conversations, reset overlay
  position, SSH and remote-access settings, sidebar/list ordering (except bot order,
  `set_bot_order`) and other
  per-device view state;
- MCP server OAuth sign-in and sign-out (Desktop MCP list/editor, TUI
  `/mcp login` and `/mcp logout`; remote windows paste the redirect address);
- notification permission and subscription on the receiving device;
- web-app pairing credentials and OS permission dialogs;
- TUI-local theme palettes (use `/theme`; Desktop themes are separate);
- importing, exporting or removing a JSON color theme file, choosing a skin or
  custom skin picture (plate, accent, photo), and the Lead's pixel face
  (stored on the host as `leadAvatar`, edited from the Desktop or a paired
  client, and shared by all of them; bots and Mixy have per-bot avatars in
  the bot profile editor; only the Workflows agent editor has none);
- approval grants ("항상 허용" is per feature and per bot, never for payment,
  permanent delete, Lead, workflow, Mixy link, group rooms or schedules) and
  browser action confirmations (`MIXDOG_BROWSER_CONFIRM_ACTIONS`,
  `MIXDOG_BROWSER_CONFIRM_SUBMIT`; see the browser-use skill);
- widening an agent's authority: action permission `allow`, a connector
  switched back on for an agent or Project (setup only narrows them; a
  single connector tool's widening asks the user on an approval card);
- the remote-access switch ("Use this PC from other devices") and this PC's
  name: turning it off from a phone would cut that phone off mid-session;
- permanently deleting an archived bot (Sessions → Archived → delete);
- the stopped turn's Resume after `continue_in_model`, and the quota card's
  other-account switch.

Use `open` where a target exists, then let the user act.

## TUI notes

The TUI settings hub exposes system shell in addition to common settings.
Desktop-host actions need the Desktop app; opening the TUI is not a substitute.

