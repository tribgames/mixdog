---
name: setup
description: Inspect or change persisted Mixdog settings through the built-in setup tool.
when_to_use: 'Settings, not code/local installs: routes, workflows, MCP, plugins, skill toggles, style, profile.'
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
  definition and MCP-config reads do not change persisted settings. Deleting a
  hook rule and forgetting provider authentication are destructive and need
  explicit approval; disabling preserves.
- Notification permission/subscription, pairing credentials, and authentication
  remain user-operated UI handoffs. Do not imitate them by editing storage.
- Most changes affect new sessions. Report `appliedToCurrentSession` and
  `appliesTo` exactly when the result supplies them.
- Ownership: source edits, builds, installation deployment, releases and app
  restarts are not setup's. Managed local-model installation and recovery
  belong to `local-provider` (same setup tool; ordinary route settings stay
  here), skill authoring to `skill-creator`, Core Memory entries to the
  `memory` tool. Read a definition before editing it.
- Setup changes settings; it does not stop work. Use the owner: `session`
  `cancel` (another session's turn, a routine run, a group room's exchange; a
  Browser/Computer takeover ends with its turn), `agent` `cancel`/`close`,
  `task` (background shell jobs); the user pauses or stops an active Goal from
  its controls. Setup only prevents more: `set_automation_enabled false`,
  `fallbacks: []`, `cancel_quota_resume`, `set_builtin_enabled` browser/computer
  off.

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

## Distinctions to keep in mind

- Main model, agent models, and Web Search model are separate routes. An
  explicitly empty agent or Web Search provider restores Main inheritance;
  omission never resets it. Disabling an agent preserves its route.
- Built-ins have installation state separate from enabled state; Visualize and
  Media generation are toggle-only (`set_builtin_enabled`, no install step).
- Unknown keys and retired configuration are diagnostics, not permission for
  direct cleanup. Do not expose internal-only configuration as a supported
  user option.

## Failure handling

- A headless `open` returns `opened:false`; relay its guidance instead of
  pretending a window opened.
- Desktop requests require a single live claimant and a confirmed receipt.
  A timeout or cancelled request is not success. If execution already started,
  inspect state before retrying; do not resubmit a possibly completed mutation.
- Do not commit, deploy, restart, or update the app unless separately requested
  and approved.

## Resources

- `references/actions.md` — read when selecting a mutation, explaining domain
  behavior or change timing, or diagnosing MCP, plugin, or built-in failures.
- `references/surfaces.md` — read when the user asks where a setting lives, a
  secret must be entered, or no setup mutation exists.
