# Cycle 1 lightweight conversation compression

Cycle 1 now separates full-source packet construction, compression, validation
and atomic persistence. It does not replace the session-local compaction flow.

- Source bodies are JSON-quoted verbatim. They are not cleaned or clipped at
  400 characters. Packets obey row and estimated-token limits. An oversized row
  is split reversibly; its fragments are never committed as partial source rows.
- Transcript/session ingestion stores the full conversation text after existing
  synthetic-envelope filtering, including code-only and URL-only messages.
  Session replay identity remains compatible with older stored rows. Already
  cleaned legacy DB bodies cannot recover removed code/tables/URLs from a
  chunk repair alone; their original transcript files would be needed.
- Each source packet gets one AI compression call. There is no separate AI
  verification call or quality retry. Oversized inputs still require multiple
  bounded source packets/fragments; this is not a one-call limit per session.
- A packet whose source estimates under 30 tokens stays RAW without an AI call:
  its summary could not be shorter than the rows.
- Code checks fields, valid indexes, duplicates, session isolation and estimated
  token savings. Overlapping/invalid chunks fall back to RAW without discarding
  independent valid chunks. Omitted rows are filled from the source, not retried.
- Accepted roots store `chunk_quality` provenance: validator version, member
  IDs, source/summary hashes, estimated sizes and verification time. Source
  rows are locked and compared again before the metadata transaction commits.
  The record says `structural`, not AI-verified.
- Nonempty rejected/uncompressed rows remain RAW and eligible after cooldown.
  Neither repeated model failures nor an outage retires them as archived.
- Compact memory projection reuses shorter, structurally usable legacy chunks
  without requiring historical verification records. Missing members, known
  stale provenance and overlaps still fall back to originals, including the
  original body stored on the root.
  Compressed bodies omit search metadata and IDs. RAW fallback preserves code,
  tables, URLs and other text that search-oriented cleaning would remove.

`input_token_budget` defaults to 16000 (minimum 4096), with a 2048-token reserve
for prompt overhead. The existing four-window concurrency cap remains. Timing
reports grouping calls, AI time, fetching and persistence. Legacy verification
and retry counters remain zero for comparisons. Token counts are estimates,
not provider billing.

Semantic completeness is not separately verified. A structurally valid summary
can still omit details, including in a reused legacy chunk. This explicitly
trades stricter semantic checking for lower latency and more chunk reuse.
Do not describe resulting compression ratios as proven lossless.

## Existing chunks: snapshot-first audit and simulation

From the repository root:

```powershell
node scripts/memory-chunk-quality.mjs
node scripts/memory-chunk-quality.mjs --input C:\path\snapshot.json --simulate-limit 2
```

The first command reads the advertised running PG service using a repeatable,
read-only transaction. It never starts a service or migrates the live schema.
The second re-chunks original member bodies from a supplied snapshot, using the
configured memory agent. It reports actual elapsed call time and checks exact
source-row coverage of the resulting chunks plus RAW fallback. It changes
neither the live DB nor the supplied snapshot.

Every run allocates a unique temporary directory and retains:

- `snapshot.json`: unchanged source backup.
- `working.json`: separate copy with simulated compressed outputs.
- `report.json`: per-chunk reasons, timings/errors, reuse counts and
  source/projection integrity checks.

Existing summaries passing the cheap checks can be reused without regeneration.
Simulation starts from original member bodies, never from a damaged summary.
Root/member identities and original content are preserved in the working copy.
A provider error stops further AI calls and exits nonzero while
retaining the report. No command here updates the live DB or deploys code.
Legacy deferred/sentinel rows are reported separately and remain available as
RAW; this audit does not silently requeue them.

Run the relevant tests with the repository runner:

```powershell
npm test -- memory-chunk memory-cycle1-quality memory-cycle-packets compact-handoff
```
