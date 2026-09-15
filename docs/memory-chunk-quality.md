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

## Rare second-layer compression

`generateCycle1Chunks(rows, { layer: 2, ... })` uses the same engine, normalized
chunk shape and single-call policy with stronger compression. The model returns
one plain narrative, with paragraphs at topic changes. The runtime attaches all
selected parent rows; the model does not emit indexes or search metadata.
First-layer pipe format is unchanged.

This is intentionally lossy compression. The prompt prioritizes the main flow,
decisions, latest results and corrections, unresolved state and important
conditions. Secondary paths, examples, intermediate attempts and detailed
measurements may be omitted. There is no quotation matching, sentence expansion,
semantic verification, quality rejection or follow-up summarization call.
Details and qualifications may still be lost; completeness is not guaranteed.

About half the input length is a writing target, not an acceptance threshold.
The prompt includes modest headroom and a character guide derived from the
source character/token ratio. `compression.targetMet` is informational.
A nonempty shorter narrative is used unchanged even when it misses that target;
`compression.used` records whether it was used. Only an explicit
`summaryTokenBudget` imposes a hard available-context limit.

`generateSecondLayerChunks` is the guarded, session-local entry point. It does
not call AI until `firstLayerComplete` is true and `contextTokens` exceeds
`contextBudgetTokens`. The caller passes only selected OLD chunks and keeps
recent conversation/fixed instructions outside the selection. The helper checks
the remaining total-context budget, not the half-size writing target. It cannot
solve overflow in the protected context alone. No second-layer result is
persisted by this API.

Second-layer execution makes at most one AI call. An oversized selection is
returned unchanged with `single_call_input_too_large`; it is not split into
additional calls. Empty/non-shorter output or an actual context-limit overflow
leaves the originals in place without another attempt. Provider errors and
cancellation remain observable; these are not semantic-quality verdicts.
The caller selects a one-packet old range before invoking this entry point.
First-layer background batching remains separate.

The automatic session compactor is not wired to this new entry point yet.
The standalone real-AI check accepts prepared first-layer cases:

```powershell
node scripts/memory-layer2-check.mjs --input C:\path\layer2-input.json
```

It retains the supplied input, creates separate copies in a unique temporary
directory, and reports actual time, approximate token savings, parent-row
bookkeeping and raw responses. Parent membership is not proof of content
coverage. Prepared cases have no live-context budget, so the check does not
invent a hard half-size limit. Ordinary first-layer compression remains
unchanged in strength.
The check dispatches ephemeral maintenance sessions through the source runtime
and records the scoped role-policy hash. An installed broker with an older
first-layer-only policy is not a valid test of the new second-layer policy.
This does not replace or deploy the installed runtime.
It keeps the configured provider/model and defaults the second-layer test to
`low` reasoning effort; the runner pins this value. First-layer model settings
and global configuration are not changed. The generic engine uses the route
supplied by its caller; this work does not raise the second-layer effort.
Use `--case <name>` (repeatable) to select cases. Each selected case gets at most
one AI call. Missing the half-size target is a measurement, not a failed run.
Provider errors and integrity violations still exit nonzero; exit 0 does not
prove semantic equivalence. No extra review stage is required. Full responses
and supplied source criteria stay in `report.json`; console output omits raw
provider envelopes.

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
