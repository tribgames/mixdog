use std::sync::Arc;
use std::time::Duration;

use mixdog_agent::agent_tool::progress::{Snapshot, WatchdogPolicy, stale_report};
use mixdog_agent::cancel::Cancel;
use mixdog_agent::env::Clock;
use mixdog_rt::TaskClass;
use serde_json::{Map, Value, json};

/// Which of Node's two watchdogs stopped the turn, with what only that one records.
pub enum StallSite {
    /// `startDispatchWatchdog` (`agent-dispatch/watchdog.mjs:26-34`): `iteration` is `sess.lastIterationIndex` when a number.
    Dispatch { iteration: Value },
    /// The worker-turn registry (`agent-watchdog-registry.mjs:106-117`): its `registrationId` and the agent tree's
    /// observation of an in-process runtime (`agent-tree.mjs:64-68`: read now, directly). Its `getSession` is the agent
    /// descriptor, which has no `lastIterationIndex` (`agent-tree.mjs:116-135`), so `iteration` is always null.
    Registry { registration_id: String },
}

/// `randomUUID().slice(0, 8)`: a registry watch's id (`agent-watchdog-registry.mjs:161`).
pub fn registration_id() -> String {
    uuid::Uuid::new_v4().to_string()[..8].to_owned()
}

/// The `ctx` of `abortAgentProgressWatchdog` for a stop judged at `now` on `snapshot` with `message`, armed at `anchor_ts`
/// (the fields `mixdog_trace::watchdog_abort_records` reads).
#[allow(clippy::too_many_arguments, reason = "Preserve the public watchdog-context API and its independent provenance, policy, timing and snapshot inputs")]
pub fn stall_abort_ctx(
    session_id: &str,
    agent: Option<&str>,
    site: &StallSite,
    policy: &WatchdogPolicy,
    anchor_ts: i64,
    snapshot: &Snapshot,
    message: &str,
    now: i64,
) -> Map<String, Value> {
    let mut ctx = Map::new();
    ctx.insert("sessionId".into(), json!(session_id));
    ctx.insert("agent".into(), json!(agent));
    ctx.insert("error".into(), json!({ "message": message }));
    ctx.insert("snapshot".into(), snapshot_ctx(snapshot));
    ctx.insert("policy".into(), json!({ "idleStaleMs": policy.idle_stale_ms }));
    ctx.insert("now".into(), json!(now));
    ctx.insert("anchorTs".into(), json!(anchor_ts));
    match site {
        StallSite::Dispatch { iteration } => {
            ctx.insert("iteration".into(), iteration.clone());
        }
        StallSite::Registry { registration_id } => {
            ctx.insert("iteration".into(), Value::Null);
            ctx.insert("observation".into(), json!({ "source": "direct", "lastReadOkAt": now, "readPendingSince": null, "lastReadError": null }));
            ctx.insert("registrationId".into(), json!(registration_id));
        }
    }
    ctx.insert("buildVersion".into(), json!(env!("CARGO_PKG_VERSION")));
    ctx
}

/// `getSessionProgressSnapshot`'s object, as `recordAgentWatchdogAbort` reads it (`awaitingUser` is present only while a person is asked).
fn snapshot_ctx(snapshot: &Snapshot) -> Value {
    let mut object = Map::new();
    object.insert("stage".into(), json!(snapshot.stage.as_deref().unwrap_or("idle")));
    object.insert("askStartedAt".into(), json!(snapshot.ask_started_at));
    object.insert("modelRequestStartedAt".into(), json!(snapshot.model_request_started_at));
    object.insert("firstActivityAt".into(), json!(snapshot.first_activity_at));
    object.insert("currentTool".into(), json!(snapshot.current_tool));
    object.insert("lastProgressAt".into(), json!(snapshot.last_progress_at));
    object.insert("lastKeepaliveAt".into(), json!(snapshot.last_keepalive_at));
    object.insert("waitingForTransport".into(), json!(snapshot.waiting_for_transport));
    object.insert("waitingForFirstSemantic".into(), json!(snapshot.waiting_for_first_semantic));
    if snapshot.awaiting_user {
        object.insert("awaitingUser".into(), json!("approval"));
    }
    Value::Object(object)
}

/// Node polls every second.
pub const SWEEP: Duration = Duration::from_secs(1);

/// An armed watchdog; dropping it stops the sweep (`stop()`).
pub struct Watchdog(tokio::task::JoinHandle<()>);

impl Drop for Watchdog {
    fn drop(&mut self) {
        self.0.abort();
    }
}

impl Watchdog {
    /// Arms the sweep for an unattended run whose policy has a deadline; `None` otherwise.
    /// `snapshot(now)` is the run's progress snapshot (`getSessionProgressSnapshot`); a run with
    /// none yet gets no verdict.
    pub fn arm(
        unattended: bool,
        policy: WatchdogPolicy,
        signal: Cancel,
        clock: Arc<dyn Clock>,
        snapshot: impl Fn(i64) -> Option<Snapshot> + Send + 'static,
        on_stale: impl FnOnce(&Snapshot, &str, i64) + Send + 'static,
    ) -> Option<Self> {
        (unattended && policy.active()).then(|| {
            // Node's `setInterval(…, 1000)` is made as the watchdog arms (`startDispatchWatchdog`), so the first sweep is one period after
            // arming however soon the task first runs; taken inside the task, the period would count from its first poll.
            let first = tokio::time::Instant::now() + SWEEP;
            Self(mixdog_rt::spawn("agent-progress-watchdog", TaskClass::Control, async move {
                // Node's interval is `unref()`ed (`agent-dispatch/watchdog.mjs:37`).
                let mut sweep = mixdog_rt::time::interval_at_unrefed(first, SWEEP);
                loop {
                    sweep.tick().await;
                    if signal.is_aborted() {
                        return;
                    }
                    let now = clock.now_ms();
                    if let Some(snapshot) = snapshot(now)
                        && let Some(message) = stale_report(&snapshot, now, &policy)
                    {
                        // The stop is recorded and the reap armed before the abort propagates (`armTurnTimeout`), while
                        // nothing else has stopped the turn.
                        mixdog_rt::node_stderr!("[agent-watchdog] stall detected: {message} (stage={})", snapshot.stage.as_deref().unwrap_or("unknown"));
                        on_stale(&snapshot, &message, now);
                        signal.abort(&message);
                        return;
                    }
                }
            }))
        })
    }
}

#[cfg(test)]
mod tests {
    use std::sync::Mutex;
    use std::sync::atomic::{AtomicU64, Ordering};

    use mixdog_core_session::session::testing::HeldClock;
    use mixdog_core_session::session::testing::eventually_on_awaiting;

    use super::*;

    /// Epoch milliseconds that follow the paused tokio clock, from the recorded scenarios' `t0`.
    const T0: i64 = 1_000_000;

    struct Virtual(tokio::time::Instant);

    impl Clock for Virtual {
        fn now_ms(&self) -> i64 {
            T0 + self.0.elapsed().as_millis() as i64
        }
    }

    const POLICY: WatchdogPolicy = WatchdogPolicy { first_transport_ms: 0, first_semantic_ms: 0, idle_stale_ms: 60_000 };
    fn streaming(last_progress_at: i64) -> Snapshot {
        Snapshot { stage: Some("streaming".into()), last_progress_at, ..Snapshot::default() }
    }

    /// What the sweeps have done, counted as the sweep asks for its snapshot: how many, at what time (the clock's reading), and
    /// the signal that wakes a waiter on any of it, including a sweep task ending.
    #[derive(Default)]
    struct Sweeps {
        seen: AtomicU64,
        times: Mutex<Vec<i64>>,
        woke: tokio::sync::Notify,
    }

    impl Sweeps {
        fn seen(&self) -> u64 {
            self.seen.load(Ordering::SeqCst)
        }
    }

    /// Dropped with the sweep task's closure, which is when the task ends (it returns, panics or is aborted): wakes the waiter.
    struct Ended(Arc<Sweeps>);

    impl Drop for Ended {
        fn drop(&mut self) {
            self.0.woke.notify_waiters();
        }
    }

    fn counted(sweeps: &Arc<Sweeps>, snapshot: impl Fn(i64) -> Option<Snapshot> + Send + 'static) -> impl Fn(i64) -> Option<Snapshot> + Send + 'static {
        let sweeps = sweeps.clone();
        let ended = Ended(sweeps.clone());
        move |now| {
            let _ended = &ended;
            let answer = snapshot(now);
            sweeps.times.lock().unwrap().push(now);
            sweeps.seen.fetch_add(1, Ordering::SeqCst);
            sweeps.woke.notify_waiters();
            answer
        }
    }

    fn dog(watchdog: &Option<Watchdog>) -> &Watchdog {
        watchdog.as_ref().expect("armed")
    }

    /// Moves the paused clock by `by`, only by this explicit advance (each test holds the clock, so the runtime never moves it
    /// itself), and waits until `want` sweeps have run in all. A sweep task that has ended without aborting its run (it returned or
    /// panicked) is the failure, not a wait; a sweep that never comes fails at the wait's deadline.
    async fn advance_until(by: Duration, want: u64, sweeps: &Sweeps, dogs: &[(&Watchdog, &Cancel)]) {
        tokio::time::advance(by).await;
        reached(by, want, sweeps, dogs).await;
    }

    /// Waits until `want` sweeps have run in all, after the clock was advanced by `by`; see `advance_until`.
    async fn reached(by: Duration, want: u64, sweeps: &Sweeps, dogs: &[(&Watchdog, &Cancel)]) {
        let wakes: [&tokio::sync::Notify; 1] = [&sweeps.woke];
        eventually_on_awaiting(
            || format!("{want} sweeps to have run after advancing {by:?} (the clock moves only by this advance)"),
            &wakes,
            || {
                if let Some((dog, _)) = dogs.iter().find(|(dog, signal)| dog.0.is_finished() && !signal.is_aborted()) {
                    panic!("a sweep task ended without aborting its run, with {} of {want} sweeps seen (finished: {})", sweeps.seen(), dog.0.is_finished());
                }
                (sweeps.seen() >= want).then_some(())
            },
        )
        .await;
    }

    /// One second at a time, each bringing one sweep from every watchdog still running (one that has aborted its run has ended).
    async fn run_for(seconds: u64, sweeps: &Sweeps, dogs: &[(&Watchdog, &Cancel)]) {
        for _ in 0..seconds {
            let running = dogs.iter().filter(|(_, signal)| !signal.is_aborted()).count() as u64;
            advance_until(SWEEP, sweeps.seen() + running, sweeps, dogs).await;
        }
    }

    fn start(unattended: bool, snapshot: impl Fn(i64) -> Option<Snapshot> + Send + 'static) -> (Option<Watchdog>, Cancel, Arc<Sweeps>) {
        mixdog_rt::testing::tokens();
        let signal = Cancel::new();
        let sweeps = Arc::new(Sweeps::default());
        let clock = Arc::new(Virtual(tokio::time::Instant::now()));
        let watchdog = Watchdog::arm(unattended, POLICY, signal.clone(), clock, counted(&sweeps, snapshot), |_, _, _| {});
        (watchdog, signal, sweeps)
    }
    #[tokio::test(start_paused = true)]
    async fn an_attended_run_is_never_armed() {
        let _held = HeldClock::hold();
        let (watchdog, signal, sweeps) = start(false, |_| Some(streaming(T0)));
        assert!(watchdog.is_none());
        tokio::time::advance(Duration::from_secs(3_600)).await;
        assert_eq!(sweeps.seen(), 0);
        assert!(!signal.is_aborted(), "no content timer for an attended run");
    }
    #[tokio::test(start_paused = true)]
    async fn the_reap_runs_once_when_the_run_goes_stale_and_never_for_a_live_one() {
        let _held = HeldClock::hold();
        mixdog_rt::testing::tokens();
        let reaped = Arc::new(std::sync::atomic::AtomicU32::new(0));
        let sweeps = Arc::new(Sweeps::default());
        let arm = |last: i64| {
            let (signal, reaped) = (Cancel::new(), reaped.clone());
            let clock = Arc::new(Virtual(tokio::time::Instant::now()));
            let hook = {
                let (signal, reaped) = (signal.clone(), reaped.clone());
                move |_: &Snapshot, _: &str, _: i64| {
                    assert!(!signal.is_aborted(), "armed before the abort");
                    reaped.fetch_add(1, Ordering::SeqCst);
                }
            };
            (Watchdog::arm(true, POLICY, signal.clone(), clock, counted(&sweeps, move |_| Some(streaming(last))), hook), signal)
        };
        let (live_dog, live) = arm(T0 + 3_600_000);
        run_for(120, &sweeps, &[(dog(&live_dog), &live)]).await;
        assert!(!live.is_aborted());
        assert_eq!(reaped.load(Ordering::SeqCst), 0);
        let (stale_dog, stale) = arm(T0 - 100_000);
        run_for(5, &sweeps, &[(dog(&live_dog), &live), (dog(&stale_dog), &stale)]).await;
        assert!(stale.is_aborted());
        assert_eq!(reaped.load(Ordering::SeqCst), 1);
    }

    #[tokio::test(start_paused = true)]
    async fn a_run_with_no_progress_snapshot_yet_gets_no_verdict() {
        let _held = HeldClock::hold();
        let (watchdog, signal, sweeps) = start(true, |_| None);
        run_for(3_600, &sweeps, &[(dog(&watchdog), &signal)]).await;
        assert!(!signal.is_aborted());
    }
}
