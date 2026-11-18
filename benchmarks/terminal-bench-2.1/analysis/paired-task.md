# One paired task: v1.4.5 vs working tree

This offline reader produces one JSON report with aggregate counts only. It
does not start Mixdog, Harbor, a verifier, or a provider. Use it on isolated,
synthetic task inputs; share the report, not the manifest or raw artifacts.

## Lead: prepare one pair

1. Use a clean snapshot of `v1.4.5` and an immutable snapshot of the actual
   working tree (including intended changes). Capture a SHA-256 of each
   executed runtime bundle, not just the installed package version or `HEAD`.
   Use a fresh agent state and job directory on each side. Do not reuse or
   resume a job. Use one task, concurrency 1, one repeat, with an identical
   local synthetic provider or replay and no real-account credentials.
   Keep all externally imposed inputs fixed: exact task bytes/checksum,
   initial filesystem and prompt, verifier, provider route/model/effort,
   capabilities, capture definitions and retry policy. Runtime-generated
   prompt or tool schema differences are part of the treatment.
2. With an already configured, isolated Harbor harness, select the same task
   on each side. The existing `harness/run-tb21.ps1` takes `-Include <task>
   -Concurrent 1 -Attempts 1 -EffortJudge off -JobsDir <new-dir>
   -ProvenanceOut <file>` plus matching route controls. It snapshots the
   runtime from its own tree; invoking it twice in the same tree does not
   compare runtimes. The stock launcher may build a runtime or initialize
   provider auth; **do not launch it as-is** to exercise an offline fixture.
   Use an isolated adapter/replay already configured for the selected route,
   with no fallback to a live provider. If that is unavailable, limit the
   check to synthetic trial artifacts; do not represent those as a runtime
   comparison.
3. Keep every trial attempt in chronological order, including failed infra
   attempts before the verifier pass. Stop at the first pass, or report the
   final failure/timeout if there is no pass. A finished Harbor `result.json`
   with numeric verifier reward/accuracy `1` and no trial exception is the
   success condition; agent-reported success alone is insufficient. Capture
   from the first task send through verifier completion. Exclude runtime
   installation, auth preflight, verifier traffic and unrelated sessions
   from provider counters. List failed/missing captures rather than silently
   dropping their attempts. An unknown earlier verdict is not a failed
   verdict: it prevents establishing that a later pass was the first.

## Manifest and command

Save a private JSON manifest next to the job directories with `schemaVersion`
equal to `2`, and `baseline` and `current` objects. Each side has:

| Field | Meaning |
| --- | --- |
| `taskDigest` | Expected lowercase SHA-256 of the exact task/verifier fixture. |
| `controlsDigest` | Expected lowercase SHA-256 of the canonical external settings and capture definitions. |
| `runtimeDigest` | Expected lowercase SHA-256 of the v1.4.5 or working-tree runtime bundle. |
| `ledger` | Path to the capture-owned closed run ledger, relative to the manifest. Omit if unavailable. |
| `attempts` | Ordered array of `{"dir":"relative/path/to/trial"}` objects; paths locate artifacts but do not identify attempts. |

The manifest states expectations, not observations. The isolated launcher or
capture needs to emit the following independent evidence; the reader does not
manufacture it from stock files:

- **Run ledger:** `{"schemaVersion":1,"runId":"opaque-run-id","state":"closed","trialIds":["opaque-trial-id"]}`.
  Record every stable trial ID at dispatch, including abandoned or failed
  attempts. Mark the ledger closed only when that run has ended. IDs must
  match the `id` of each listed Harbor trial's `result.json`, in dispatch
  order, exactly once. Do not reconstruct the ledger from the manifest, list
  only successful attempts, or substitute directory names for IDs.
- **Per-trial `paired-trial-evidence.json`:** `schemaVersion: 1`, `runId`,
  `trialId`, `runtime` (`v1.4.5` or `working-tree`), `taskDigest`,
  `controlsDigest`, `runtimeDigest`, and `artifacts`. Derive the digests at
  capture from the actual task/verifier and applied launch controls and
  executed runtime; do not copy the manifest's expected values. `artifacts`
  maps `result`, `exec`, and `trace` to SHA-256 of the respective final file
  bytes (`result.json`, `agent/mixdog.txt`, `agent/agent-trace.jsonl`).
  The collector must bind evidence to the same trial at production time.
  These hashes check binding and integrity; they are not signatures and do
  not authenticate an untrusted collector.
- **Trace links:** Capture `exec_link: {"thread_id":"…","turn_id":"…","request_id":"…"}`
  on each `usage_raw` row, and use `tool_call_id` instead of `request_id` on
  each `tool` row. Record these links from known identity at capture time;
  the trace's own `session_id` must match the per-trial evidence's
  `traceSessionId`, but need not equal the exec thread ID.
  Do not infer a link from row order, iteration, count equality, or token
  values. If the link is unavailable, leave it out.

Stock artifacts can be read with missing evidence to show observed subtotals.
They cannot establish a paired result on their own. For a synthetic fixture
that exercises only this reader, author the result, trace, and corresponding
evidence together and label the output as pipeline evidence, not a real
runtime comparison.

From the repository root:

```powershell
node benchmarks/terminal-bench-2.1/analysis/paired-task.mjs <pair-manifest.json>
```

The per-trial evidence may also supply a `counters` object with aggregate
numbers from an identically scoped capture of that trial. No headers, request IDs, payloads,
tool content or accounts belong in it. Each optional counter is
`{"value":123,"complete":true}`. Set `complete:false` for a captured subtotal
and omit counters with no observations. Explicit zero is valid only when
observed for the stated scope (e.g. complete capture of a pre-send infra
failure).

| Counter keys | Required scope |
| --- | --- |
| `providerRequestWireBytes`, `providerResponseWireBytes` | Bytes actually sent/received at the same task-attributable wire boundary on both sides, including retries, failed responses and streams up to interruption. Record framing/headers/TLS scope in the capture definition; decrypted body length is **not** wire bytes. Omit if transport overhead cannot be attributed to the task. |
| `providerRequestSerializedBytes`, `providerResponseSerializedBytes` | Observed serialized provider protocol payload bytes (all requests/response chunks, before network overhead), not `Content-Length`, reserialization, tokens, or trace-file size. Separate from wire bytes; do not add them together. |
| `toolArgumentPayloadBytes`, `toolResultPayloadBytes` | Observed bytes at an identical, documented tool boundary, once per actual dispatch/result, including retries and errors. Do not substitute lifecycle JSON estimates. |
| `providerAttempts`, `providerRetryAttempts`, `toolRetryAttempts` | Independent counts of physical provider attempts and explicit provider/tool retry attempts. Use detector/transport evidence rather than text similarity, notification wording, or the difference between two unrelated counts. |

## Interpreting the report

- `value` is a total for that metric's stated basis; `null` means unavailable
  at that scope. `observedSubtotal` preserves known contributions, including
  explicit zero, and `unavailable` lists the reasons a total could not be
  established. `currentMinusBaseline` is populated per metric only when both
  sides have a bound, first verified completion and both values are available.
  Deltas use the same basis, never wire vs estimate. `attempts` preserves
  observed verdicts; an individual pass can have an unverified side outcome
  if its provenance, attempt history or earlier verdicts are unknown.
  Subtotals from ambiguous or duplicate rows are diagnostic, not lower bounds
  or proof of attribution.
- Logical model rounds count `model.request.started` in one exec thread/turn
  with a matching terminal outcome. Each request needs a unique, ordered
  completed or failed terminal event with the same request ID and index.
  Starts are checked against terminal `provider_requests`. Additional rounds are total minus the first
  task round, not minus one per trial. The callback fires once per logical
  send, not once per transport retry; auxiliary provider calls can also
  bypass it. Failed lifecycle rounds are not a retry count. Tool calls count
  `item.started` tool envelopes checked against terminal `tool_calls` and
  joined to exactly one later closing event by tool-call ID in the same turn,
  including later calls after a failure; retries within a single execution
  are not visible as new envelopes. Abandoned synthetic result closures do
  not contribute result bytes. Harbor trial retries are counted separately.
- Usage totals require exactly one `usage_raw` row per completed logical
  round for that exec thread/turn, with matching output counter. They use
  the existing `usage_raw` counters: normalized prompt,
  uncached input, cache read/write, output and reasoning. They are the
  runtime's reported counters, not a bill or a sum for every transport
  attempt. Missing fields, missing rows and logical round coverage mismatch
  do not become zeros. An emitted `0` can be a runtime default, particularly
  for cache writes; it is not proof the provider supplied that field.
  Usage on aborted/failed attempts without a usage report is unknown.
- `toolArgumentJsonEstimateBytes` measures UTF-8 JSON of the **parsed** exec
  arguments; `toolResultTextEstimateBytes` measures UTF-8 exec output (text
  as-is, structures as JSON). Neither includes provider encoding, nor later
  resends of history. `tracedToolResultEstimateBytes` reuses the existing
  reduction trace's `result_bytes_est`; cache hits and zero estimates can
  stand for suppressed or non-text output and are not treated as measured
  zero. These byte series are alternatives, not additive.
- Stock artifacts do not expose total wire bytes, actual serialized
  request/response bytes, exact tool payload bytes, or physical retry
  counts. v1.4.5's verbose `loop.body_bytes_est`, if collected, estimates
  the pre-adapter message envelope, not what was sent. It is preserved as
  a subtotal only; a serializer/decoder or SSE timing does not establish
  transport coverage. Without independent counters, report those gaps as
  unavailable rather than using the estimates to claim a bandwidth change.
  One pair describes one case, not a benchmark-wide effect.
