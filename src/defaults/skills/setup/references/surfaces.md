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
- Extensions → Plugin → Git & GitHub: Git/GitHub CLI installation, connection, and commit-message preferences.
- Settings → Connection: web-app pairing and linked devices.
- Settings → System: update, keep-awake, and Doctor.
- Projects: Project registration, name, Instructions, Common Instructions, and
  Core Memories.
- Workflows: workflow packs, Main and Web Search defaults, and agent editing.
- Extensions → Plugin: Built-in cards and plugins.
- Extensions → Skill: skills and MCP servers.

Provider authentication is intentionally hidden from the remote web app; guide
the user to Desktop.

## UI-owned settings

The setup tool does not mutate:

- Desktop display language, theme, side panels, notifications, or keep-awake;
- GitHub CLI connection and commit-message preferences;
- web-app pairing and linked devices;
- Project registration, naming, or Project/Common Instructions;
- workflow-pack and agent-definition authoring;
- Browser Use, Computer Use, or voice install/toggle state;
- schedules and webhooks.

Use `open` where a target exists, then let the user act. Schedules and webhooks
live on their Desktop rails and have no setup action. Never simulate a missing
action by editing local storage, configuration files, or database rows.

## TUI notes

The TUI settings hub exposes system shell and Memory cycle controls in addition
to common settings. A visible control does not imply a setup mutation exists;
use the tool schema as the API boundary.

