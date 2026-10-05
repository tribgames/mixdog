# Memory maintenance

Conversation history and standing instructions have separate owners:

- **Cycle 1** summarizes conversation by session/topic, keeps source links, and
  generates search embeddings. Default interval: `10m`.
- **Standing memory** is user-curated through `memory` (`add`, `edit`, `delete`,
  `list`), with approval for the exact content and scope. Cycles cannot populate,
  rewrite, merge, or delete these entries.

Manual `flush`, `rebuild` and `backfill` run summarization and embedding
maintenance. The memory tool lists curated records;
use `recall` for generated conversation history.

Public recall supports page sizes up to 100 and offsets up to 500. Internal
retrieval windows cover the requested page, and existing duplicate grouping runs again
after supplemental results and time filters are combined. Embedding and
backfill failures propagate as failures, with committed progress retained in
the result instead of being reported as a successful empty run.

## Existing databases

Stored `duplicate_of` search aliases and concept/lineage links are preserved.
Recall uses these relationships; it does not generate new ones.
A duplicate is collapsed only when its
representative is in the same filtered result, before limits and pagination.
Existing history, summaries and curated
entries are not bulk rewritten or dropped. `pending`/`active`/`archived`
records are all searchable. Archived curated entries remain inactive.
Conflicting CORE keys are preserved and reported; startup defers the
unique index until explicit edits/deletes resolve them. Per-pool locked key
checks prevent new conflicting writes even while that index is deferred.

Session snapshots contain only curated entries.
