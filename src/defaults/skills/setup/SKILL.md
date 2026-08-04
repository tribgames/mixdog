---
name: setup
description: Use this skill to configure a mixdog installation — request-driven recipes for models, MCP, channels, remote, output style, memory, skills, secrets, and workflow/agent packs. Triggers on "setup", "configure", "change model", "add MCP", "output style", "Discord token", "workflow", "remote".
---

# Setup Skill

Map the user request to the matching recipe below, confirm the intended change,
apply it, and verify the result.

> Record METHOD and POINTERS only. Do not store live model names, tokens, URLs,
> channel IDs, or other secrets in this document. Always read live values from
> config, runtime status, or environment variables at execution time.

## Common diagnostics before editing

- Config: `<mixdogData>/mixdog-config.json` (`MIXDOG_DATA_DIR` /
  `MIXDOG_HOME` may override the path; definition:
  `src/runtime/shared/config.mjs`).
- MCP: TUI `/mcp` list or runtime `mcpStatus()`.
- Skills: `skillsStatus()` or scan skill paths.
- Secrets: `hasStoredSecret(account)` for presence only, or relevant
  `MIXDOG_*` / provider environment variables.

## TUI entry points

- Slash commands: `src/tui/app/slash-commands.mjs`.
- Settings hub: `/setting` (aliases `/settings`, `/config`) via
  `src/tui/app/settings-picker.mjs`.

## Request index

| Request | Route |
|---|---|
| Main model | `/model` |
| Agent model | `/agents` |
| Workflow switch | `/workflow` |
| Workflow/agent definition | desktop Workflows page or pack files |
| Search model | `/search` |
| Reasoning effort | `/effort [level]` |
| Fast mode | `/fast [on|off]` |
| Output style | `/style` |
| Memory / core memories | `/memory`, config |
| MCP server | `/mcp`, config |
| Provider secret | provider login flow or secret store |
| Discord / Telegram / voice | `/channels`, config |
| Remote (channel control) | `/remote` (manual claim) |
| Theme | `/theme` |
| Profile (title/language) | `/profile` |
| Skill add/update | project or global `skills/<name>/SKILL.md` |
| Schedules / webhooks | desktop app only |

## Recipes

### Main model

1. Check current route via status line, `/model`, or config.
2. Change with `/model` and the model picker.
3. Verify the selected route is reflected in config and the status line.

### Agent model

1. Check `/agents` and the configured agent route.
2. Change the target agent route through the agent picker.
3. Verify the target agent reports the new route on the next run.

### Workflow switch

1. Check `/workflow` or `/setting` for the active workflow.
2. Change with `/workflow`; this updates `config.workflow.active`.
3. Verify the notice and active marker.

### Workflow / agent definitions

1. Workflows and agents are Markdown packs. Built-ins ship with mixdog
   (workflows `default`, `solo`; agents worker, heavy-worker, reviewer,
   debugger, maintainer); custom packs live at
   `<mixdogData>/workflows/<id>/WORKFLOW.md` and
   `<mixdogData>/agents/<id>/AGENT.md`.
2. Saving a built-in id writes a user override; deleting the override
   reverts to the built-in.
3. The desktop app (Workflows page) is the full editor. The TUI only
   switches the active workflow (`/workflow`) and per-agent model routes
   (`/agents`).
4. Verify with `/workflow` / `/agents` listings after the change.

### Search model

1. Check `searchRoute` in config and the status line.
2. Change with `/search`; the picker updates `store.setSearchRoute`.
3. Verify `searchRoute` and run a search call if needed.

### Reasoning effort

1. Check the status line effort value.
2. Change with `/effort [level]`; busy sessions reject the change.
3. Verify the notice and persisted route effort.

### Fast mode

1. Check the status line fast-mode marker.
2. Change with `/fast [on|off]` or toggle with `/fast`.
3. Verify the notice; the next turn uses the updated mode.

### Output style

1. Check `/style` or config.
2. Change with `/style` and the picker.
3. Verify the active style and run a short response if needed.

### Memory

1. `/memory` is the one-stop surface: memory on/off toggle plus core-memory
   list, add, edit, and delete.
2. Compact type is fixed to Fast-track; only auto-compact toggles in
   `/setting`.
3. Verify status output and, when relevant, run a small recall check.

### MCP server

1. Inspect `/mcp` or `mcpStatus()`.
2. Edit config or use the supported MCP flow.
3. Reconnect or restart as required.
4. Verify status, exposed tools, and any expected auth state.

### Secrets

1. Confirm which provider/account needs a secret.
2. Use the provider login flow, secret store, or environment variable path.
3. Verify presence only; never print the secret value.

### Discord / Telegram / voice channels

1. Check `/channels` (or `/setting` → Channel) and runtime channel status.
2. Update the requested backend, credential, or main channel/chat setting.
3. Restart/reconnect only when the channel implementation requires it.
4. Verify channel presence and a non-secret status signal.

Schedules and webhooks are managed in the desktop app, not the TUI.

### Remote

1. Remote is manual-only: `/remote` claims remote for the current session
   and takes over from any other session. There is no auto-start, and
   session handoffs never transfer ownership implicitly.
2. Turning remote OFF (or exiting the owning session) stops messaging;
   schedules and webhooks keep running.
3. Verify via the status line or `/setting` → Remote Runtime.

### Skills

1. Check existing skills with `/skills` or `skillsStatus()`.
2. Project skill path: `<cwd>/.mixdog/skills/<name>/SKILL.md`.
3. Global skill path: `<mixdogData>/skills/<name>/SKILL.md`.
4. Include frontmatter `name` and `description`; put trigger phrases in
   `description`.
5. Verify the skill appears in `/skills`.

## Safety rules

- Do not expose secrets.
- Do not hard-code live deployment values into this file.
- Prefer the smallest config change that satisfies the request.
- Verify after every configuration change.
