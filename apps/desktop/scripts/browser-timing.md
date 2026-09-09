# Browser Use latency diagnostics

Set `MIXDOG_AGENT_TRACE_TIMING=1` for the runtime whose session is being
measured. This records timings only; it does not change browser actions,
wait policy, or model prompts. Do not restart a user's app without approval.

Compare the same session's existing `loop` rows (`send_ms`, `pre_send_ms`,
`tool_resume_ms`) with its `browser_timing` rows. The former cover model
round trips; the latter contain one record per bridge request attempt:

- `bridge_ms`: HTTP request through complete response decoding, including
  queueing and desktop execution.
- `payload.queueMs`: time waiting for the page's command lane.
- `payload.commandMs`: desktop command execution.
- `payload.waitMs`: page-load waits, sequence rendering checkpoints, and
  reply settlement/postconditions/explicit waits.
- `payload.snapshotMs`, `payload.snapshots`: semantic observations,
  including target resolution and recovery.
- `payload.screenshotMs`, `payload.screenshots`: image capture and encoding.

Phase durations can overlap and are not additive. The bridge minus queue and
command durations also includes transport/serialization overhead, not model
latency. A failed request still records bridge duration; host phase details
are available only when a command result was returned. No phase data is
added to the model's page response. Page text, targets, URLs, and values are
excluded from these records.

For a same-page batch, intermediate steps yield to rendering (two animation
frames for visible pages, a queued task/layout checkpoint for hidden pages),
then the next action checks its own target. Every action's final response makes
a fresh rendering checkpoint. If a load or request is still pending, it retains
global DOM/network settlement; an idle rendered page does not restart a quiet window.
Explicit `expect` and `settleMs` remain independent requirements.
Navigation, SPA URL changes, blocking dialogs, and failed checkpoints stop
remaining dispatch. A known asynchronous dependency belongs in a `wait` step;
that step does not create an intermediate snapshot.
