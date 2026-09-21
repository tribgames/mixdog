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
schema owns arguments; this guide owns curation and approval policy.

## Choose the source

Past work, decisions, and resumes belong to the `history-recall` skill.
Load it only when historical evidence is needed for the requested change.
Current repository state belongs to repository tools, not memory. Automatic
summaries remain searchable history, not standing instructions.

## Curate standing memory

Store only user-specific preferences and constraints, as compact English
statements. Before adding or editing one, show its exact content
and scope and obtain approval. An explicit request for that exact change
already supplies approval.

Never turn inferred lessons into standing instructions or duplicate profile,
settings, rules, tool contracts, or skills. Do not save ordinary task outcomes
as preferences; automatic history already preserves them.

Omit `project_id` for the current Project, use `common` for shared memory,
or an explicit Project slug for another Project. The `*` scope is read-only.
Confirm the target before destructive changes.

Memory indices start at 1 independently in common memory and each Project.
Deletion and movement compact the affected scope's indices; new memories
append after its last index. For edit/delete, use the exact `project_id`,
`id`, and `index_revision` returned by the list. On a stale-version error,
read the list and identify the intended content again; never blindly retry
an old number. Internal database keys are not public memory indices.

The memory tool manages only user-curated entries. Conversation summaries are
searchable through `recall`; they never become standing instructions automatically.
Do not use a recall record ID as a memory index.

Done when the tool reports the approved change in the intended scope.
Do not reread a successful write merely to confirm it.
