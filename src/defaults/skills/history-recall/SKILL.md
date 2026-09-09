---
name: history-recall
description: Retrieve and interpret prior sessions, decisions, and unfinished work.
when_to_use: 'Prior sessions, decisions, or work to resume; not current repo state or standing user preferences.'
dependencies:
  tools:
    - type: tool
      value: recall
---

# History recall

Use `recall` for stored session history. The tool schema owns arguments;
this guide owns retrieval and interpretation. Current repository state
belongs to repository tools, not historical memory.

## Retrieve

Search semantically, not with regex. Select the relevant Project and time
window; batch independent questions through the supported query array.
For a follow-up, use returned IDs, never invented ones. Recent-session paging
uses the returned cursor rather than a guessed offset.

## Interpret

Read only the missing context needed to decide the next action. Distinguish
historical evidence from current facts; do not treat a past measurement,
decision, or plan as proof of today's state. A miss is not proof that an event
never happened.

Retrieval does not save standing preferences. If the user requests such a
change, use `memory-management`; do not load its write tool merely to search.
Automatic summaries remain searchable history, not standing instructions.

Done when relevant stored evidence answers the historical question, or the
missing history is explicitly reported.
