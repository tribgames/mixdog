# Computer Use turn efficiency

## Scope

This pass removes redundant observation instructions and measures existing
installed-session records. It does not change input guards, batching limits,
settling, deployment, or the installed skill.

The built-in skill and tool description now accept a successful fresh returned
observation as the next input's evidence. Discovery, recapture, and verification
remain necessary when target or outcome evidence is unresolved. Delivery alone
does not prove task completion.

## Recorded baseline

Artifacts are under `artifacts/computer-use/turn-efficiency/`:

- `SKILL.before.md`: exact pre-edit skill, including existing uncommitted work.
- `current-baseline.json`: 30 retained host records, September 7, 2026,
  06:15–06:43 UTC, from an installed Claude Fable 5.1 session.
- `session-timing.json`: 18 timed Computer Use results retained in that session.

| Measurement | Samples | Median | P95 |
| --- | ---: | ---: | ---: |
| Host command | 30 | 2,020 ms | 6,488 ms |
| Successful host sequence | 3 | 4,797 ms | 6,946 ms |
| Session tool execution, including bridge | 18 | 1,607 ms | 4,761 ms |
| Execution end to result completion | 18 | 0 ms | 728 ms |
| Previous tool result to Computer Use dispatch | 17 | 5,434 ms | 37,522 ms |

The last row excludes intervening user messages but includes model, network,
and runtime work. It is **not isolated model inference latency**. Session and
host retention differ; these populations must not be subtracted or combined
into a percentage. No matching provider trace was found in the history trace
files. This is a baseline, not a measured improvement or a benchmark of the
current chat model.

Host records include seven capture timeouts and three session-aborted errors.
Fifteen of thirty commands are explicit captures. Their count alone does not
prove redundancy: failed surfaces, expiry, and interruptions require recovery.
Successful sequences are also slow enough to warrant internal phase timing.

## Workflow review

These are static scenario reviews, not live model A/B results:

| Same scenario before and after | Before | Revised decision |
| --- | --- | --- |
| Enter a value in a native field; returned value proves it | Example always asks for `verify` | Finish from returned evidence |
| A dialog interrupts a sequence; successor observation is usable | Example asks to capture the dialog | Use successor observation |
| Launch returns a resolved, observed window | Always list and verify existence | Reuse resolved observation |
| Recovery observation failed or expired | New observation required | Still required |
| Change a web-page field | Browser Use | Browser Use, unchanged |

No task-specific model harness was added. Live behavioral savings require
controlled baseline/draft evaluation with identical model, tools, and fixture;
that evaluation and installed deployment have not been performed.

## Next proposed scope

The approved follow-up adds phase timing without changing execution policy:

- Each executed step retains input, settle, before/after window-scan, recovery,
  and router-total durations when present. `execution_ms` measures the step
  wrapper even when the step throws; skipped steps have no synthetic duration.
- The sequence reports `steps_ms` and `post_capture_ms` separately.
- Run history and failure bundles retain up to six numeric-only step timing
  records and final capture phases. Persisted records are sanitized again on
  diagnostic readback. No input text, error prose, images, or titles are added.
- Phase times can overlap, especially screenshot and accessibility capture;
  do not sum them as an end-to-end duration. Outer cancellation can still
  prevent a completed sequence reply, leaving only the existing failure record.

### Capture timeout recovery analysis

The seven host capture timeouts occurred at approximately 2,502–2,517 ms.
The retained session calls at those times use state, som, and ax modes, all
of which request accessibility. The records do not identify the blocked
native operation; the following mechanism is established by source, not a
live reproduction of that session:

1. `capture.ts` gives the accessibility snapshot a 2,500 ms deadline.
2. For external windows it starts accessibility and screenshot acquisition
   concurrently. Screenshot acquisition first asks the same session worker
   for `window_bounds` (`capture-pixels.ts`).
3. `worker-pool.ts` starts the command timer at submission. A timeout retires
   the child and rejects **all** pending requests assigned to that child.
   Thus a timed-out accessibility request can also fail the bounds request,
   rather than merely leaving a usable pixel-only observation.
4. `error-recovery.mjs` groups every `computer_command_timeout` with menu
   failures and recommends capture again, without checking whether capture
   itself was the failed operation. This exposes a recapture feedback path.
5. Snapshot timeout may include worker startup or earlier queued work; the
   existing evidence does not distinguish these from an unresponsive UIA
   provider. Increasing the deadline is not yet justified.

Recommended next changes, **not implemented in this pass**:

- Separate timeout recovery guidance from menu recovery, and distinguish
  failed observation from uncertain input delivery. An unchanged failed
  capture must not be presented as the universal recovery action.
- Measure backend request queue/startup/execution separately before choosing
  observation-worker isolation or changed ordering for bounds and UIA.
- Preserve interruption, stale-target, authorization, and uncertain-delivery
  guards. Any changed batch capability or settle policy needs separate
  approval and observable native-fixture checks.

### Follow-up verification

All nine focused sequence, timing, run-log privacy, and failure-bundle tests
passed. The desktop node typecheck reported five `timing` property errors in
`src/main/browser/host.integration.ts:627–630`, outside this change; no Computer
Use type errors were reported. The full node typecheck remains unresolved.
No deployment, installed restart, or live desktop input was performed.
