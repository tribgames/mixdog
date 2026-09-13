# Two-layer tool batching

Policy: first combine known required targets using each tool's supported array
arguments, then dispatch the resulting independent tool calls together. Never
expand scope to fill a batch. Dependency and mutation barriers still apply.

New `agent-trace.jsonl` batch rows retain `payload.tool_call_count` and add:

- `batch_schema_version: 1`, `batch_id`, and `iteration`.
- `calls[]`: `tool_call_id`, `tool_name`, and `array_lengths`.
- Counts come from the original arguments before normalization or truncation.
  `array_lengths` is `{}` for scalar calls to tracked array-capable tools and
  `null` for tools without a tracked array contract. Values and commands are
  not copied into this metadata.

Tool completion rows join through `payload.batch.batch_id` and `tool_call_id`.
`payload.execution_intervals[]` records epoch-millisecond invocation start/end
timestamps. It excludes dispatch queueing and postprocessing; eager timestamps
are read after settlement. Retries have separate intervals. Cache hits and
non-executed calls have an empty interval list; missing records remain unknown.
Existing result/error metadata is unchanged. No database columns are added.

`fast8-ten-analysis.mjs` includes `rows[].batching` using `tool-batching.mjs`:

1. **Internal arrays:** observed array-batched calls and per-tool/per-field
   array counts and item totals. Do not sum or multiply independent dimensions
   into fictional work units, especially grep scopes versus patterns.
2. **Inter-tool groups:** multi-call groups, mixed-tool groups, and observed
   concurrent invocation intervals. A grouped request is not proof of parallel
   execution. Touching endpoints do not overlap; repeated attempts do not count
   as different calls. Invocation intervals do not measure asynchronous work
   continuing outside the tool after it returns.

Legacy logs retain their group-width counts but have `null` for unavailable
array/concurrency metrics. Partial groups explicitly report timing coverage;
their observed concurrency is only a lower bound. Millisecond resolution cannot
prove the absence of sub-millisecond overlap. No missed-batching opportunities,
dependency freedom, or performance improvements are inferred automatically.
