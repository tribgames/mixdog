//! The attended turn's quiet-time cue (Node `tui/session/turn-quiet.mjs` `startQuietWatch`, started by `turn.mjs`): the
//! turn's liveness is read every second while it runs, and its quiet state (`turnQuietState`, [`turn_quiet_state`]) is
//! published as the runtime section's `spinner.quiet` once the turn has gone the cue window without counted progress,
//! and cleared when progress resumes. The value is frozen for a whole silence, so a silence costs two publications.
//! A client turns it into its cue (`src/tui/spinner-meta.mjs`). Display only.

use std::future::Future;
use std::sync::Arc;
use std::time::Duration;

use mixdog_agent::agent_tool::progress::Snapshot;
use mixdog_agent::env::{Clock, RetryWait};
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
    /// `warn_ms`: the lead's stall-watchdog warn point (`leadStallWarnMs`). `clock` and `waiter` are the run's: the poll
    /// is a wait of the injected waiter and every reading is at the injected clock's time.
    pub fn start(progress: watch::Receiver<RunProgress>, port: RunPort, clock: Arc<dyn Clock>, waiter: Arc<dyn RetryWait>, warn_ms: f64) -> Self {
        let stop = CancellationToken::new();
        let liveness = move |now: i64| progress.borrow().snapshot(now).map(|snapshot| turn_liveness(&snapshot));
        let publish = move |quiet: Option<Value>| {
            let port = port.clone();
            async move { port.section(Section::SpinnerQuiet(quiet)).await.is_ok() }
        };
        let task = mixdog_rt::spawn("run-quiet-watch", TaskClass::Work, watch_quiet(clock, waiter, warn_ms, stop.clone(), liveness, publish));
        Self { stop: stop.drop_guard(), task }
    }

    pub async fn finish(self) {
        drop(self.stop);
        let _ = self.task.await;
    }
}

/// `startQuietWatch`'s interval: each poll reads the turn's liveness and publishes the quiet state it implies when it
/// differs from the one shown, until `done` (the turn is no longer current) or a publication fails.
async fn watch_quiet<P, F>(
    clock: Arc<dyn Clock>,
    waiter: Arc<dyn RetryWait>,
    warn_ms: f64,
    done: CancellationToken,
    mut liveness: impl FnMut(i64) -> Option<Map<String, Value>> + Send,
    publish: P,
) where
    P: Fn(Option<Value>) -> F + Send,
    F: Future<Output = bool> + Send,
{
    let mut shown: Option<Value> = None;
    loop {
        tokio::select! {
            _ = done.cancelled() => return,
            _ = waiter.wait(QUIET_POLL) => {}
        }
        let now = clock.now_ms();
        let next = turn_quiet_state(liveness(now).as_ref(), now as f64, warn_ms);
        if next == shown {
            continue;
        }
        tokio::select! {
            _ = done.cancelled() => return,
            sent = publish(next.clone()) => {
                if !sent {
                    return;
                }
            }
        }
        shown = next;
    }
}

#[cfg(test)]
mod tests {
    //! Node's recording `fixtures/quiet-progress-cases/golden.json` case 5 (`record-quiet-progress-cases.mjs`, `turn-quiet.mjs`
    //! `startQuietWatch` as `turn.mjs:781` starts it): the watch runs on a virtual clock that only the recording's
    //! `timers.advances` move; each poll is released when the clock reaches it and the next one is awaited as the watch arms
    //! it. The turn stops being current at `turnEndsAtMs`, where the run finishes the watch.
    use std::path::Path;
    use std::sync::Mutex;
    use std::sync::atomic::{AtomicI64, Ordering};

    use async_trait::async_trait;
    use mixdog_agent::agent_tool::watchdog::{AgentKind, stall_warn_ms};
    use mixdog_testkit::Exact;
    use tokio::sync::{mpsc, oneshot};

    use super::*;

    /// The longest the watch may take to arm its next poll after one is released.
    const BOUND: Duration = Duration::from_secs(10);

    struct Virtual {
        now: AtomicI64,
        armed: mpsc::UnboundedSender<(i64, oneshot::Sender<()>)>,
    }

    impl Clock for Virtual {
        fn now_ms(&self) -> i64 {
            self.now.load(Ordering::SeqCst)
        }
    }

    #[async_trait]
    impl RetryWait for Virtual {
        async fn wait(&self, delay: Duration) {
            let (release, released) = oneshot::channel();
            let due = self.now_ms() + delay.as_millis() as i64;
            self.armed.send((due, release)).expect("the test holds the receiver");
            let _ = released.await;
        }
    }

    #[tokio::test]
    async fn the_quiet_watch_publishes_what_nodes_published_on_the_recorded_clock() {
        let golden = Exact::load(Path::new(env!("CARGO_MANIFEST_DIR")).join("../../fixtures/quiet-progress-cases/golden.json"));
        let case = &golden.get("cases").as_array()[5];
        assert_eq!(case.get("case").as_str(), "the lead turn's quiet watch reads each second, publishes a frozen quiet state once per change and stops with its turn");
        let want = case.get("observed");
        let start = want.get("startMs").as_f64() as i64;
        let script = want.get("livenessScript").to_plain().unwrap();
        let ends = want.get("turnEndsAtMs").as_f64() as i64;

        let (armed_tx, mut armed) = mpsc::unbounded_channel();
        let clock = Arc::new(Virtual { now: AtomicI64::new(start), armed: armed_tx });
        let reads = Arc::new(Mutex::new(Vec::<i64>::new()));
        let publications = Arc::new(Mutex::new(Vec::<Value>::new()));
        let liveness = {
            let reads = reads.clone();
            move |now: i64| {
                let at = now - start;
                reads.lock().unwrap().push(at);
                let step = script.as_array().unwrap().iter().rev().find(|step| step["fromMs"].as_i64().unwrap() <= at).unwrap();
                step["liveness"].as_object().cloned()
            }
        };
        let publish = {
            let (publications, clock) = (publications.clone(), clock.clone());
            move |quiet: Option<Value>| {
                publications.lock().unwrap().push(json!({ "atMs": clock.now_ms() - start, "quiet": quiet }));
                async { true }
            }
        };
        // `leadStallWarnMs()`: the lead's warn point as the run computes it.
        let warn_ms = stall_warn_ms(AgentKind { name: Some("lead"), ..AgentKind::default() }, &|_: &str| None) as f64;
        let done = CancellationToken::new();
        let mut task = Some(tokio::spawn(watch_quiet(clock.clone(), clock.clone(), warn_ms, done.clone(), liveness, publish)));

        async fn next_poll(armed: &mut mpsc::UnboundedReceiver<(i64, oneshot::Sender<()>)>) -> (i64, oneshot::Sender<()>) {
            tokio::time::timeout(BOUND, armed.recv()).await.expect("the watch arms its next poll").expect("the watch holds the clock")
        }
        let mut poll = Some(next_poll(&mut armed).await);
        for advance in want.get("timers").get("advances").as_array() {
            let target = start + advance.get("toMs").as_f64() as i64;
            while let Some((due, release)) = poll.take_if(|(due, _)| *due <= target) {
                clock.now.store(due, Ordering::SeqCst);
                if due - start >= ends {
                    // The turn is no longer current: the run finishes the watch.
                    // The poll is never released: the watch ends on its token, not on a poll.
                    done.cancel();
                    let task = task.take().expect("the watch stops once");
                    tokio::time::timeout(BOUND, task).await.expect("the watch stops with its turn").expect("the watch task");
                    drop(release);
                    break;
                }
                release.send(()).expect("the watch waits on its poll");
                poll = Some(next_poll(&mut armed).await);
            }
            clock.now.store(target, Ordering::SeqCst);
        }
        assert!(task.is_none() && poll.is_none(), "the watch still polls after its turn ended");
        assert!(armed.try_recv().is_err(), "the watch armed a poll after its turn ended");

        // Compared whole: every read, every publication with its instant, and nothing left armed. `timers.armed` and
        // `timers.firedCount` are Node's one interval and its firings, the format of its timer (MANIFEST `replay.notCompared`).
        assert_eq!(Exact::plain(&json!(*reads.lock().unwrap())), *want.get("reads"), "the instants the watch read the turn's liveness");
        let published = Exact::plain(&Value::Array(publications.lock().unwrap().clone()));
        assert!(published == *want.get("publications"), "the watch published {published:?}");
        assert_eq!(Exact::plain(&json!([])), *want.get("timers").get("pending"), "polls left armed");
    }
}
