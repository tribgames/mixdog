# Task

Judge generated memory candidates. Output pipe-separated lines only: no JSON,
no prose, no fences, no tool calls. The first character of your response must
be a digit.

Example:

For Entries numbered `1. id:... 2. id:... 3. id:... 4. id:...`:

```
1|archived
2|active
2|why|A|Durable reply-style preference; forgetting it changes future responses.
2|core|user prefers terse one-line replies
3|update|compact element|one-sentence durable summary
3|why|B|Live project-map anchor documented nowhere else.
3|core|current project layout summary
4|merge|2|2,4|merged element|merged durable summary
2|why|A|Same durable preference as the survivor.
2|core|merged core line
```

## Required Lines

Emit exactly one primary verdict for every Entry:

The first field of every line MUST be the ROW NUMBER printed before the entry
in Entries (the `<n>.` prefix, 1-based). One verdict per row; do not skip a row
or invent a row number that is not listed.

```
<row>|active
<row>|archived
<row>|update|<element>|<summary>
<row>|merge|<target_row>|<source_rows_csv>|<element>|<summary>
```

For every non-archived primary verdict (`active`, `update`, `merge`), also emit:

```
<row>|why|A|<short reason>
<row>|core|<core_summary>
```

Use `why|A` for durable cross-session invariants (L1/L2). Use `why|B` for L3
current-map entries: one-line project-landscape summaries, live long-running
goals, and environment anchors documented nowhere else. `why` is validation
evidence only; it is
not stored. `core_summary` is injected into Core Memory, so keep it one
self-contained clause, <=120 chars. For `merge`, `why` and `core` may use the
survivor `target_row`.

Allowed primary verbs:

| Current status | Verbs |
|---|---|
| `pending` | `active`, `archived` |
| `active` | `active`, `archived`, `update`, `merge` |

## Source Of Truth

Current rules load every session. User-curated core is canonical. If a
candidate restates either source, archive it; do not promote duplicates.

### Current Rules

{{CURRENT_RULES}}

### User-Curated Core

{{USER_CORE}}

### Active Generated Core

{{CORE_MEMORY}}

## Entries

{{ITEMS}}

Active: {{ACTIVE_COUNT}} / cap: {{ACTIVE_CAP}}

## Decision Rule

Long-term memory is exceptional. Keep ONLY content that lands in one of three
layers:

- **L1 — Relationship / communication:** user identity, address form,
  reply-style preferences, and patterns the user dislikes. (`why|A`)
- **L2 — Behavior rules:** principles the user corrected or insisted on during
  work, hard safety boundaries, and quality bars. (`why|A`)
- **L3 — Current map:** one-line project-landscape summaries, live
  long-running goals, and environment anchors documented nowhere else. (`why|B`)

**Transform rule.** For a past decision or failure, ask: *does a lesson from it
still constrain today's behavior?* If yes → keep the one-line L2 lesson and
archive the narrative. For an ACTIVE row, use `update` to rewrite it into the
lesson. For a PENDING row (which allows only `active`/`archived`), promote with
`active` and put the one-line lesson in its `core` line — pending rows cannot
emit `update`. If no → archive. Anything whose source of truth is code, rules
files, or skill docs → archive.

Archive everything else: implementation specs, code-internal constants,
measurements, resolved-bug stories, and status snapshots.

The cap is an upper bound, not a target. When `Active < cap`, seed and grow the
active set: a pending row with a concrete A/B reason that is NOT a
Source-Of-Truth duplicate MUST be promoted with `active` — promotion is NOT
reserved for already-active rows, and an empty active set must be bootstrapped
from clear, non-duplicate A/B pending rows. When `Active > cap`, contract
strictly: any active entry without a concrete A/B reason must archive.

If useful content is buried inside work narrative, keep only the durable L2
behavior lesson (via `update` on an active row, or `active` for a pending row);
archive the surrounding story.

## Merge / Update

- `update` rewrites verbose durable entries into one short element and one
  one-sentence summary.
- `merge` only within the same project pool. The survivor is `target_row`.
- Never merge across project_id boundaries.
- `element` <=100 chars. `summary` <=200 chars. No literal `|` or newlines.
- When a row genuinely fails the A/B bar or you are unsure it qualifies, prefer
  `archived`. But never withhold `active` from a pending row that clearly meets
  A/B merely because it is currently pending — clear, non-duplicate A/B pending
  rows are promoted, not archived (rows that restate current rules or
  user-curated core still archive per Source Of Truth).

## Output

Pipe lines only. No prose. First character must be a digit. Each line's first
field MUST be the ROW NUMBER (`<n>.` prefix) shown before that entry in
Entries. Emit one verdict per listed row; do not skip rows or invent numbers.
