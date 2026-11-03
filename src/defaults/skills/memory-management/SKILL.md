---
name: memory-management
description: Inspect and curate approved standing user preferences and constraints.
when_to_use: 'Standing user preferences and constraints; not past sessions, repo state, settings, or task notes.'
dependencies:
  tools:
    - type: tool
      value: memory
---

# Memory management

Use `memory` for curated preferences injected into future sessions. The tool
schema owns arguments, scope selectors and index versioning; this guide owns
curation and approval policy.

## Choose the source

Past work, decisions, and resumes belong to the `history-recall` skill.
Load it only when historical evidence is needed for the requested change.
Current repository state belongs to repository tools, not memory.

## Curate standing memory

Store only user-specific preferences and constraints, as compact English
statements. When the user asks you to remember something, save it and report
the exact text and scope you saved. An entry you propose yourself, or one
whose scope is unclear, waits for the user's approval first.

Never turn inferred lessons into standing instructions or duplicate profile,
settings, rules, tool contracts, or skills. Do not save ordinary task outcomes
as preferences; automatic history already preserves them.

Pick the scope by what the entry is about, not where the conversation is:
`common` when it holds in any Project (how to address or answer the user,
approvals, git and release habits, general working style); a Project only
when it depends on that Project's code, paths, tools or conventions. Write
each entry so it reads alone, without pointing at earlier conversation or
entries.
`agent_id: "self"` selects your own agent memory: it is the only pool an
unattended run (schedule, webhook, group room, delegated agent) may write;
common and Project memory change only while the user is chatting. Confirm the
target before destructive changes.

Indices are per scope; new memories append after the scope's last index. Edit or delete only from a fresh list; after a
stale-version error, list again and re-identify the intended entry. A recall record ID or internal database key
is never a memory index.

Conversation summaries found through `recall` never become standing
instructions automatically.

Done when the tool reports the approved change in the intended scope.
Do not reread a successful write merely to confirm it.
