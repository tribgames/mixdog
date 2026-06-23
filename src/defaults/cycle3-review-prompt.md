# Task

You review user-curated CORE memory against the current project memory. Each
entry is shown with its most-related current memory. Emit ONE verdict line per
entry id. The system may conservatively apply safe compression updates and
strict duplicate merges automatically; deletes and broad rewrites require
explicit user confirmation. Extracting a lesson from a narrative is a BROAD
rewrite — emit it only as a proposal (proposal mode), never as an auto-applied
conservative "safe compression" update; conservative mode must not lossy-rewrite
user-curated core. The first character of your response is a digit.
Plain text — no preamble, JSON, or fences. NEVER attempt a tool call.

## What CORE is

CORE is durable standing knowledge that lands in one of three layers:

- **L1 — Relationship / communication:** user identity, address form,
  reply-style preferences, patterns the user dislikes.
- **L2 — Behavior rules:** principles the user corrected or insisted on, hard
  safety boundaries, quality bars.
- **L3 — Current map:** one-line project-landscape summaries, live long-running
  goals, environment anchors documented nowhere else.

Every entry should be ONE short clause (≤120 chars). CORE is not a log.

## The distinction that decides every verdict

- An entry that DESCRIBES how something currently is — an L1/L2/L3 rule,
  preference, goal, or live map entry — is DURABLE.
- An entry that RECORDS a past event that already happened — a version shipped,
  a value measured, a fix made — is NOT durable. For a past decision/failure,
  keep only the one-line lesson that still constrains behavior (as L2); archive
  the narrative. Extracting that lesson is a BROAD rewrite, so it belongs in a
  proposal, not an auto-applied conservative update — conservative mode must not
  lossy-rewrite user-curated core.
- Anything whose source of truth is code, rules files, or skill docs — plus
  implementation specs, code-internal constants, measurements, resolved-bug
  stories, status snapshots — is NOT durable.

When unsure which it is → keep.

Related memory is evidence, not authority. Archived related rows may contain
historical context or old work logs; use them only when they clearly prove a
CORE entry is a past-event log, duplicate, or stale. If related memory is empty
or inconclusive, keep the CORE entry.

## Verdicts

- `keep` — durable and already one short clause.
- `update` — durable but verbose or multi-sentence → rewrite as one ≤120-char clause.
- `merge` — duplicates another entry → fold into the survivor (same project pool).
- `delete` — records a past event, not a current rule or structure; OR merely
  restates a rule already in **Current rules** below (rules load every session,
  so a CORE copy is redundant); OR is sourced from code, rules files, or skill
  docs, or is an implementation spec, constant, measurement, resolved-bug
  story, or status snapshot that fits no L1/L2/L3 layer. Do not delete an entry
  that adds durable specifics the rule itself does not state.

A verbose durable entry is always `update`, never `keep`.
Delete is the rarest verdict. Prefer `keep` for durable rules/preferences and
`update` for compression when the current behavior is still valid.

## Current rules (Source Of Truth — loaded into the session every turn)

These rules are always present, so a CORE entry that merely restates one is
redundant → `delete`. Treat them as authority for the delete-on-restatement
verdict only; an entry that is merely related but adds durable specifics the
rule does not state stays `keep`/`update`.

{{CURRENT_RULES}}

## Entries to review

Each block is one CORE entry followed by its most-related current memory.

{{CORE_REVIEW}}

## Output

One line per entry id, any order:

```
<id>|keep
<id>|update|<element>|<summary>
<id>|merge|<target_id>|<source_ids_csv>
<id>|delete
```

`summary` ≤120 chars, one clause. No literal `|` or newline inside a field
(replace `|` with `/`). No prose, no fences. First character is a digit.
