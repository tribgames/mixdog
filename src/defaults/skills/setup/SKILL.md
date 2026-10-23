---
name: setup
description: Inspect or change persisted Mixdog settings through the built-in setup tool.
when_to_use: 'Settings, models, workflows, MCP, plugins, skills, output style, profile changes; not Mixdog code.'
dependencies:
  tools:
    - type: tool
      value: setup
---

# Mixdog setup

Match the request to one settings domain, inspect current state, use the
supported `setup` action, and read its result as the change receipt.

> The tool schema owns action fields and live values. This skill owns routing,
> approval boundaries, UI handoff, and cross-domain distinctions.

## Non-negotiable boundaries

- Use the `setup` tool for persisted Mixdog configuration. Never edit
  `mixdog-config.json` or internal stores directly; if the tool and UI expose no
  supported path, report that limitation. The one exception is the definition
  file a workflow or agent `read_definition` returns as `path`.
- API keys, OAuth credentials, tokens, and usage sign-ins stay out of tool
  arguments and the transcript. Open the Providers surface and let the user
  enter them.
- Developer option "Allow all actions" (`allowAllActions`) can only be turned
  on by the person in the desktop app; the tool refuses it even with
  `riskAccepted:true`, and remote enablement is refused too. Open `developer`
  instead.
- A mutation follows the active workflow's approval rules. Status, catalog,
  definition and MCP-config reads do not change persisted settings.
- Most changes affect new sessions. Report `appliedToCurrentSession` and
  `appliesTo` exactly when the result supplies them.
- This skill does not own source edits, builds, installation deployment,
  releases, or app restarts.
- Managed local-model installation and recovery belong to `local-provider`;
  it uses this same setup tool, while ordinary route settings remain here.

## Core loop

1. Select one `status` domain and inspect it. Do not start with the full summary
   when a narrower domain answers the request.
2. Decide whether the request has a supported mutation, requires a UI handoff,
   or is not exposed.
3. For a supported mutation, send only the fields the user intends to change.
   Partial route and profile updates preserve omitted fields.
4. Read the mutation result, including `saved`, `scope`, `appliesTo`,
   `appliedToCurrentSession`, and `requiresReload` when present. Background
   installation receipts are not evidence of completed installation.
   Call the narrow `status` domain afterward only when the receipt does not
   already prove the persisted value.
5. Report what changed and whether it applies now or in a new session.

Completion means the persisted state or UI handoff is evidenced, not merely
that a call returned without transport error.

## Load routing

- Read `references/actions.md` when selecting a mutation or handling a
  domain-specific edge case.
- Read `references/surfaces.md` only when the user asks where a setting lives,
  a secret must be entered, or no setup mutation exists.

## High-signal distinctions

- Main model, agent models, and Web Search model are separate routes. Omitted
  fields preserve the selected route. An explicitly empty agent or Web Search
  provider restores Main inheritance; omission never resets it. Disabling an
  agent preserves its route for re-enabling.
- Web Search model selection and Web Search tool exposure are separate.
- Memory master state controls tools and background cycles; Core Memory
  injection stays on regardless. `set_recap_enabled` changes only the
  background cycles. Core Memory entries
  are read and changed with the `memory` tool, not setup.
- Built-ins have installation state separate from enabled state; Visualize
  (on by default) and Media generation are toggle-only (no install step). Browser Use,
  Computer Use actions require this conversation open in the local Desktop
  window; voice runs on the runtime and needs no Desktop.
- Hook rules are before-tool policy, separate from MCP and plugins. Deleting a
  rule is destructive; disabling preserves it. A rule change reaches open
  sessions and their sub-agents on the next tool call.
- Auto-clear is per provider and can be `unlimited` (`never`). Built-in
  windows: Codex/ChatGPT login unlimited, OpenAI API 30 min, Anthropic 1h.
  Unlimited stops idle clearing only: compaction still runs at the context
  limit, and finished sub-agent sessions are still released, never kept
  forever: after the provider's own window (OpenAI API 30 min, Anthropic 1h,
  DeepSeek 24h), or 1h for Codex/ChatGPT logins; an unlimited override does
  not stop that.
- Desktop appearance changes affect the Desktop host, not a paired phone.
  Fonts, imported color themes and skin transparency are saved per device.
  Display language is independent of profile response language. A required
  reload is reported, never performed automatically.
- A routine or webhook run has no user and no approval prompts: it may change
  only its own bot's automations and route, and payment and permanent-delete
  connectors are refused (trash moves are allowed). Bot permission "block"
  still applies. In an attended bot conversation (home or direct chat, group
  room, or a sub-agent/task session working for one) a payment or permanent
  delete connector call always asks first: allow once or deny, never "항상
  허용", whatever was stored before. Coding sessions are not asked.
- Prompt-affecting changes land without rewriting the cached prompt: a
  workflow switch arrives as a reminder on the next turn; a bot's
  instruction, persona or name applies on 적용 (one cache break); connector
  and built-in feature changes take effect at once (tool availability and
  call-time refusal), and only the prompt text about them waits for the cache
  to expire.
- Read definitions before editing them; use skill-creator when authoring a
  skill. Setup persists the supported definition fields. Workflow and agent
  ids are stable identities, distinct from their display names.
- MCP servers and plugins are machine-global integrations whose visibility may
  be scoped to selected Projects.
- User skills are machine-global. Enabled plugin skills and built-in skills are
  also discoverable; project-local `.mixdog/skills` directories are ignored.
- `set_disabled_skills` replaces the complete disabled list; inspect the
  current list before changing one entry.

## Failure handling

- A headless `open` returns `opened:false`; relay its guidance instead of
  pretending a window opened.
- For an MCP failure, inspect the reported transport error before changing
  command, arguments, directory, environment, URL, headers, or enabled state.
- MCP reads intentionally omit raw connection values that may contain secrets.
- An HTTP/SSE MCP server that needs OAuth waits for sign-in instead of
  failing; setup rows then show it enabled, not connected, with no `error`.
  Setup cannot sign in, and `reconnect_mcp` does not log in: hand off to
  `open mcp` (Connect/Reconnect) or the TUI `/mcp login`.
- For an unavailable built-in, distinguish not installed, installed but
  disabled, and bridge inactive.
- Desktop requests require a single live claimant and a confirmed receipt.
  A timeout or cancelled request is not success. If execution already started,
  inspect state before retrying; do not resubmit a possibly completed mutation.
- Notification permission/subscription, pairing credentials, and authentication
  remain user-operated UI handoffs. Do not imitate them by editing storage.
- Unknown keys and retired configuration are diagnostics, not permission for
  direct cleanup.

## Finish

- Do not expose internal-only configuration as a supported user option.
- Do not commit, deploy, restart, or update the app unless separately requested
  and approved.
