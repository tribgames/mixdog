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
| `mcp` | Extensions → Skill → MCP |
| `skills` | Extensions → Skill → Skills |
| `plugins` | Extensions → Plugin |
| `update` | Update surface |
| `usage` | Provider usage sign-in |
| `doctor` | Runtime diagnostics |
| `context` | Context and compaction |

An attached Desktop or TUI may navigate and return `opened:true`. Headless
execution returns `opened:false` with guidance to relay to the user.

## Desktop map

- Settings → General: profile, Web Search exposure, display language, theme,
  side panels, and notifications.
- Settings → Context: auto-compact and auto-clear.
- Settings → Output style: output style selection.
- Settings → Providers: API-key, OAuth, local providers, and usage sign-in.
- Extensions → Plugin → Git & GitHub: Git/GitHub CLI installation and connection.
- Settings → Connection: web-app pairing and linked devices.
- Settings → System: update, keep-awake, and Doctor.
- Projects: Project registration, name, Instructions, Common Instructions, and
  Core Memories.
- Workflows: workflow packs, Main and Web Search defaults, and agent editing.
- Extensions → Plugin: Built-in cards and plugins.
- Extensions → Skill: skills and MCP servers.

Provider authentication is intentionally hidden from the remote web app; guide
the user to Desktop.

## Desktop-backed settings

Setup can read and change Desktop appearance, keep-awake, usage pin,
Computer observe-only, Browser/Computer/voice installation and toggles,
Projects, Instructions, and linked-device revocation through the attached
Desktop. A receipt identifies `scope:desktop-host`; appearance is not applied
to the paired browser. No Desktop claimant means no confirmed change.

Schedules/webhooks and workflow/agent/skill definitions use their runtime
actions directly. These do not require clicking their Desktop rails.

## User-operated UI handoffs

The setup tool does not mutate:

- API keys, OAuth, usage sign-in, and GitHub CLI connection;
- notification permission and subscription on the receiving device;
- web-app pairing credentials and OS permission dialogs;
- TUI-local theme palettes (use `/theme`; Desktop themes are separate).

Use `open` where a target exists, then let the user act. Never simulate a
missing or denied operation by editing storage or switching surfaces.

## TUI notes

The TUI settings hub exposes system shell in addition to common settings.
Desktop-host actions need the Desktop app; opening the TUI is not a substitute.
Use the schema and `status capabilities` as the supported API boundary.

