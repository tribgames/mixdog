# Browser Use latency diagnostics

The core (`mixdogd`) records the timings in its agent trace when
`MIXDOG_AGENT_TRACE_TIMING=1` (or `MIXDOG_AGENT_TRACE_VERBOSE=1`) is in its
environment. This records timings only; it does not change browser actions,
wait policy, or model prompts. Do not restart a user's app without approval.

## Where the rows go

- The core reads these variables once, when it starts. A core the desktop
  starts inherits the desktop's environment; a core that is already running
  keeps its own.
- The file is `<data dir>/history/agent-trace.jsonl`, where the data dir is
  `MIXDOG_DATA_DIR`, else `<MIXDOG_HOME or ~/.mixdog>/data`. The core writes
  it only with diagnostic I/O on (`MIXDOG_DIAGNOSTICS=1`, `MIXDOG_MODE=dev`,
  or `MIXDOG_DEBUG=1`); otherwise name a file with `MIXDOG_AGENT_TRACE_PATH`.
  `MIXDOG_AGENT_TRACE_DISABLE=1` or `MIXDOG_AGENT_TRACE_LOCAL_DISABLE=1`
  turns it off. Without a file to write, the core times nothing and builds
  no rows.
- Rows are buffered: written at 100 rows, about a second after a row is
  queued, and when the core exits. The default file rotates above 10 MiB
  (`.1` to `.3`).

## Rows

Compare a session's `loop` rows with its `browser_timing` rows (same
`session_id`). The former cover model round trips; the latter contain one
record per `host/browser/command` the core sends to the desktop for its
browser tools, the handoff and saved-login commands, and a secret request
(`secret_bind`, then `secret_precheck` and `secret_fill`, which stand for
Node's one `secret_input` request). Browser commands of the desktop's own UI
or of a phone (`browser/command`, the live view's `input`) are not the
core's and are not recorded, as Node recorded only its runtime's requests.

`loop`, one per completed provider send, timed from the round of the loop
that settled it:

- `send_ms`: send start to the settled response, the provider's own retries
  and the stream included. A replay the loop runs as a new round, as Node's
  does (a reconnect once the provider's retries ran out, a replay after shown
  text was withdrawn or a tool call's arguments were cut, a content-filter
  replay, a request rebuilt without a rejected tool schema, image, or
  thinking replay), starts the iteration and the send again after its wait.
- `pre_send_ms`: iteration start to send start (steering, skill selection,
  compaction, the step-effort judgment; Node counts that judgment's wait in
  `send_ms`).
- `tool_resume_ms`: the previous tool batch's end to send start; null on
  the run's first send.
- `message_count`: transcript length. `body_bytes_est` is always null.

`browser_timing`:

- `action`; `turn_id` only when the command carries one.
- `bridge_ms`: from the core sending the request to the desktop's reply,
  including queueing, desktop execution, and protocol transport.
- `ok`: true when the desktop returned a result.
- `payload.queueMs`: time waiting for the page's command lane.
- `payload.commandMs`: desktop command execution.
- `payload.waitMs`: page-load waits, sequence rendering checkpoints, and
  reply settlement/postconditions/explicit waits.
- `payload.snapshotMs`, `payload.snapshots`: semantic observations,
  including target resolution and recovery.
- `payload.screenshotMs`, `payload.screenshots`: image capture and encoding.
- `payload.targetMs`, `payload.actionabilityMs`, `payload.inputMs`: target
  resolution, actionability checks, and input dispatch.
- `payload.steps`: for a `sequence`, up to six steps with their own phase
  durations; `payload.mouseEvents`: count and total time per mouse event
  type.

There is no `http_status`: the core reaches the desktop over the app
protocol, not HTTP. Phase durations can overlap and are not additive. The
bridge duration minus queue and command durations also includes transport
and serialization overhead, not model latency. A command the desktop failed
carries the timing of its error (`data.timing`); a cancelled command, or one
whose desktop closed or was replaced as host before it answered, records only
its bridge duration (`ok` false, empty payload); with no desktop host nothing
is sent or recorded.
No phase data is added to the model's page response. Page text, targets,
URLs, and values are excluded from these records.

For a same-page batch, intermediate steps yield to rendering (two animation
frames for visible pages, a queued task/layout checkpoint for hidden pages),
then the next action checks its own target. Every action's final response makes
a fresh rendering checkpoint. If a load or request is still pending, it retains
global DOM/network settlement; an idle rendered page does not restart a quiet window.
Explicit `expect` and `settleMs` remain independent requirements.
Navigation, SPA URL changes, blocking dialogs, and failed checkpoints stop
remaining dispatch. A known asynchronous dependency belongs in a `wait` step;
that step does not create an intermediate snapshot.
