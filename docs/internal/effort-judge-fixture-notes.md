# Effort judge: differences from Node

Node reference: `src/runtime/effort-judge/judge-client.mjs` and `judge-worker.mjs` at `bb8c5e3b7`.

## Remaining difference: work the terminate flag cannot stop

- **Node:** the watchdog (`STUCK_MS`, 10 s) and `shutdownEffortJudge` terminate the worker thread,
  whatever it is doing. The next judgment starts a fresh worker. The client can never be left
  without a worker.
- **Core:** a Rust thread cannot be killed. A stuck inference is stopped with ONNX Runtime's
  `RunOptions::terminate`, so it returns at once. Work that flag cannot reach does not return:
  a model load, or a hang outside the session's run. That thread, and its model, stay alive until
  the work returns.
- **The bound:** such threads are counted against `THREADS` = 2 (`mixdog-services`
  `effort_judge/worker.rs`). When two such hangs are alive, no new thread starts. Every turn
  judgment answers `warming` at once, and a turn with that answer keeps its default effort. This
  lasts until one of the two returns.
- **Node cannot reach that state:** its worker is killed, not waited for.
- **Everything else matches Node:** the queue, answer, watchdog and cold-load timings, and the
  skip answers.
