//! The attended turn's quiet-time cue (Node `tui/session/turn-quiet.mjs` `startQuietWatch`, started by `turn.mjs`): the
//! turn's liveness is read every second while it runs, and its quiet state (`turnQuietState`, [`turn_quiet_state`]) is
//! published as the runtime section's `spinner.quiet` once the turn has gone the cue window without counted progress,
//! and cleared when progress resumes. The value is frozen for a whole silence, so a silence costs two publications.
//! A client turns it into its cue (`src/tui/spinner-meta.mjs`). Display only.

use std::sync::Arc;
use std::time::Duration;

use mixdog_agent::agent_tool::progress::Snapshot;
use mixdog_agent::env::Clock;
use mixdog_core_agents::agents::quiet_progress::turn_quiet_state;
use mixdog_core_ports::ports::threads::Section;
use mixdog_core_run::run_host::progress::RunProgress;
use mixdog_core_session::session::RunPort;
use mixdog_rt::TaskClass;
use serde_json::{Map, Value, json};
use tokio::sync::watch;
use tokio::task::JoinHandle;
use tokio_util::sync::{CancellationToken, DropGuard};

/// `QUIET_POLL_MS`.
const QUIET_POLL: Duration = Duration::from_secs(1);

/// `runtime.getTurnLiveness()` as the quiet state reads it. The snapshot keeps whether the sent request still waits for
/// its headers as a flag, so the record carries that flag in Node's own two stamps (a send at 1, no transport).
pub fn turn_liveness(snapshot: &Snapshot) -> Map<String, Value> {
    let mut row = json!({
        "stage": snapshot.stage,
        "lastProgressAt": snapshot.last_progress_at,
        "lastStreamDeltaAt": snapshot.last_stream_delta_at,
        "toolStartedAt": snapshot.tool_started_at,
        "askStartedAt": snapshot.ask_started_at,
        "currentTool": snapshot.current_tool,
    });
    if snapshot.awaiting_model_response {
        row["requestSentAt"] = json!(1);
        row["lastTransportAt"] = json!(0);
    }
    row.as_object().cloned().unwrap_or_default()
}

/// The task that publishes the turn's quiet state for the length of one run. Dropping it stops the task;
/// [`QuietWatch::finish`] also waits for it, so nothing is published after the run's outcome is on its way.
pub struct QuietWatch {
    stop: DropGuard,
    task: JoinHandle<()>,
}

impl QuietWatch {
    /// `warn_ms`: the lead's stall-watchdog warn point (`leadStallWarnMs`).
    pub fn start(progress: watch::Receiver<RunProgress>, port: RunPort, clock: Arc<dyn Clock>, warn_ms: f64) -> Self {
        let stop = CancellationToken::new();
        let done = stop.clone();
        let task = mixdog_rt::spawn("run-quiet-watch", TaskClass::Work, async move {
            let mut tick = tokio::time::interval_at(tokio::time::Instant::now() + QUIET_POLL, QUIET_POLL);
            tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
            let mut shown: Option<Value> = None;
            loop {
                tokio::select! {
                    _ = done.cancelled() => return,
                    _ = tick.tick() => {}
                }
                let now = clock.now_ms();
                let liveness = progress.borrow().snapshot(now).map(|snapshot| turn_liveness(&snapshot));
                let next = turn_quiet_state(liveness.as_ref(), now as f64, warn_ms);
                if next == shown {
                    continue;
                }
                tokio::select! {
                    _ = done.cancelled() => return,
                    sent = port.section(Section::SpinnerQuiet(next.clone())) => {
                        if sent.is_err() {
                            return;
                        }
                    }
                }
                shown = next;
            }
        });
        Self { stop: stop.drop_guard(), task }
    }

    pub async fn finish(self) {
        drop(self.stop);
        let _ = self.task.await;
    }
}
