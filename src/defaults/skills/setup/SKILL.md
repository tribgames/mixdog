---
name: setup
description: Inspect or change persisted Mixdog settings through the built-in setup tool.
when_to_use: 'Settings, models, workflows, MCP, plugins, skills, output style, or profile changes; not Mixdog code/builds/deployment.'
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
  supported path, report that limitation.
- API keys, OAuth credentials, tokens, and usage sign-ins stay out of tool
  arguments and the transcript. Open the Providers surface and let the user
  enter them.
- A mutation follows the active workflow's approval rules. `open` and `status`
  are read-only.
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
4. Read the mutation result. Call the narrow `status` domain afterward only
   when the result does not already prove the persisted value.
5. Report what changed and whether it applies now or in a new session.

Completion means the persisted state or UI handoff is evidenced, not merely
that a call returned without transport error.

## Load routing

- Read `references/actions.md` when selecting a mutation or handling a
  domain-specific edge case.
- Read `references/surfaces.md` only when the user asks where a setting lives,
  a secret must be entered, or no setup mutation exists.

## High-signal distinctions

- Main model, agent models, and Web Search model are separate routes. An agent
  override with an empty provider restores Main inheritance.
- Web Search model selection and Web Search tool exposure are separate.
- Memory master state controls the capability; recap controls background
  cycles only. Core Memory content is managed by the `memory` tool.
- Git, Memory, and Office have installation state separate from enabled state.
  Browser Use, Computer Use, and voice are managed through Built-in UI cards;
  `set_first_use_approval` controls once-per-session first-use approval for
  Browser Use and Computer Use only, not voice.
- MCP servers and plugins are machine-global integrations whose visibility may
  be scoped to selected Projects.
- User skills are machine-global. Enabled plugin skills and built-in skills are
  also discoverable; project-local `.mixdog/skills` directories are ignored.
  Use extension scope to limit where a global skill appears.
- `set_disabled_skills` replaces the complete disabled list; inspect the
  current list before changing one entry.

## Failure handling

- A headless `open` returns `opened:false`; relay its guidance instead of
  pretending a window opened.
- For an MCP failure, inspect the reported transport error before changing
  command, arguments, directory, environment, URL, headers, or enabled state.
- For an unavailable built-in, distinguish not installed, installed but
  disabled, and bridge inactive.
- If a requested setting is UI-only, navigate there when possible and hand
  control to the user. Do not imitate the missing action by editing storage.
- Unknown keys and retired configuration are diagnostics, not permission for
  direct cleanup.

## Finish

- Do not expose secrets or internal-only configuration as supported user
  options.
- Do not claim the current session changed when the receipt says next session.
- Do not commit, deploy, restart, or update the app unless separately requested
  and approved.
