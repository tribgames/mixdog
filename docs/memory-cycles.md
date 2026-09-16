# Memory maintenance

Conversation history and standing instructions have separate owners:

- **Cycle 1** summarizes conversation by session/topic, keeps source links, and
  generates search embeddings. Default interval: `10m`.
- **Cycle 2** reviews summaries against related predecessors in the same project.
  It keeps independent accounts, links corrections/continuations, and groups
  genuine duplicates through `duplicate_of` search aliases. Original chunks,
  session membership, provenance and summaries remain unchanged. A duplicate
  is collapsed only when its representative is in the same filtered result.
  Deduplication precedes result limits and page offsets; member expansion is
  restricted to the final selected results.
  It also maintains search indexes. Default interval: `1h`.
  Selected evidence is split by its actual UTF-8 request size without clipping
  summaries or losing predecessors. Large source groups can require additional
  requests, with at most four running concurrently. Split verdicts are joined
  and all source snapshots are checked before an atomic relationship update.
- **Standing memory** is user-curated through `memory` (`add`, `edit`, `delete`,
  `list`), with approval for the exact content and scope. Cycles cannot populate,
  rewrite, merge, or delete these entries.

There is no third cycle, candidate queue, importance promotion/demotion, or
generated-instruction exclusion operation. The memory tool lists curated records;
use `recall` for generated conversation history.

Public recall supports page sizes up to 100 and offsets up to 500. Internal
retrieval windows cover the requested page, and duplicate grouping runs again
after supplemental results and time filters are combined. Embedding, review and
backfill failures propagate as failures, with committed progress retained in
the result instead of being reported as a successful empty run.

## Existing databases

The additive `entries.cycle2_reviewed_at` field tracks search maintenance,
and `entries.duplicate_of` links search representatives independently from
chunk membership and legacy status values. Existing history, summaries, curated
entries, and obsolete metadata are not bulk rewritten or dropped. Old
`pending`/`active`/`archived` records remain searchable, including records with
old promotion metadata. Legacy archived curated entries remain inactive.
Conflicting legacy CORE keys are preserved and reported; startup defers the
unique index until explicit edits/deletes resolve them. Per-pool locked key
checks prevent new conflicting writes even while that index is deferred.

Old third-cycle configuration is ignored. Session snapshots contain only curated
entries; older snapshots with generated data can still be read, but that data
is never injected. Applying this code does not itself restart or deploy the app.

New databases do not create promotion-only columns/indexes or an active-only
materialized search view. Existing unused columns and indexes are left in place;
normal startup neither refreshes nor purges them. An old derived search view is
dropped only when an embedding-model migration needs to release its dependency.
