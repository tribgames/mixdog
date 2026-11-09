//! The progress watchdog's sweep (Node `agent-dispatch/watchdog.mjs`, `startDispatchWatchdog`): a
//! one-second poll that aborts the run's signal with the verdict's sentence when an unattended
//! run stops making progress under its policy (`agent_tool::watchdog::resolve_policy`). The abort
//! frees whatever the run holds, its admission slot included. An attended run is never armed:
//! a person can stop it, and SPEC §4.9 keeps content timers off it.

use std::sync::Arc;
use std::time::Duration;

use mixdog_agent::agent_tool::progress::{Snapshot, WatchdogPolicy, stale_report};
use mixdog_agent::cancel::Cancel;
use mixdog_agent::env::Clock;
use mixdog_rt::TaskClass;

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
        on_stale: impl FnOnce() + Send + 'static,
    ) -> Option<Self> {
        (unattended && policy.active()).then(|| {
            Self(mixdog_rt::spawn("agent-progress-watchdog", TaskClass::Control, async move {
                let mut sweep = tokio::time::interval_at(tokio::time::Instant::now() + SWEEP, SWEEP);
                loop {
                    sweep.tick().await;
                    if signal.is_aborted() {
                        return;
                    }
                    let now = clock.now_ms();
                    if let Some(message) = snapshot(now).and_then(|snapshot| stale_report(&snapshot, now, &policy)) {
                        // The reap is armed before the abort propagates (`armTurnTimeout`), while
                        // nothing else has stopped the turn.
                        on_stale();
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
    use std::sync::atomic::{AtomicBool, AtomicI64, Ordering};

    use serde_json::Value;

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

    /// What real Node's `evaluateAgentWatchdogAbort` answered for a streaming run last heard from
    /// `last` ms after `T0`, at `now` ms after it (`benchmarks/rust-core/recorders/
    /// record-agent-watchdog.mjs`). The recorded policy is the one `POLICY` carries.
    fn node_verdict(last: i64, awaiting_user: bool, now: i64) -> Option<String> {
        let golden: Value = serde_json::from_str(include_str!("../../../../fixtures/agent-watchdog/golden.json")).unwrap();
        let found = golden["evaluations"].as_array().unwrap().iter().find(|case| {
            case["snapshot"]["lastProgressAt"].as_i64() == Some(T0 + last)
                && case["snapshot"]["awaitingUser"].as_bool().unwrap_or(false) == awaiting_user
                && case["now"].as_i64() == Some(T0 + now)
                && case["policy"]["idleStaleMs"].as_i64() == Some(POLICY.idle_stale_ms)
        });
        found.unwrap_or_else(|| panic!("no recorded scenario for last={last} awaiting={awaiting_user} now={now}"))["message"].as_str().map(str::to_owned)
    }

    fn streaming(last_progress_at: i64) -> Snapshot {
        Snapshot { stage: Some("streaming".into()), last_progress_at, ..Snapshot::default() }
    }

    /// How many sweeps have looked at a snapshot, counted as the sweep asks for it.
    #[derive(Default)]
    struct Sweeps {
        seen: std::sync::atomic::AtomicU64,
        woke: tokio::sync::Notify,
    }

    impl Sweeps {
        fn seen(&self) -> u64 {
            self.seen.load(Ordering::SeqCst)
        }
    }

    fn counted(sweeps: &Arc<Sweeps>, snapshot: impl Fn(i64) -> Option<Snapshot> + Send + 'static) -> impl Fn(i64) -> Option<Snapshot> + Send + 'static {
        let sweeps = sweeps.clone();
        move |now| {
            let answer = snapshot(now);
            sweeps.seen.fetch_add(1, Ordering::SeqCst);
            sweeps.woke.notify_waiters();
            answer
        }
    }

    fn dog(watchdog: &Option<Watchdog>) -> &Watchdog {
        watchdog.as_ref().expect("armed")
    }

    /// Moves the paused clock one second at a time, only by this explicit advance, and after each second waits for every
    /// watchdog still running (a pair of its task and its signal; one that has aborted has ended) to have swept.
    async fn run_for(seconds: u64, sweeps: &Sweeps, dogs: &[(&Watchdog, &Cancel)]) {
        for _ in 0..seconds {
            let running: Vec<&Watchdog> = dogs.iter().filter(|(_, signal)| !signal.is_aborted()).map(|(dog, _)| *dog).collect();
            let want = sweeps.seen() + running.len() as u64;
            tokio::time::advance(SWEEP).await;
            // The guard is a virtual millisecond that can pass only when every task is idle, which is when no sweep is coming:
            // the runtime then moves the clock to the guard (before the next sweep, a second away). So a sweep that is not made
            // by the advance above, a sweep task that has ended or panicked, and a clock that is moved by anything but the
            // advance, each end in this assertion instead of a wait that never ends or one the idle clock quietly satisfies.
            let guard = tokio::time::sleep(Duration::from_millis(1));
            tokio::pin!(guard);
            let wakes: [&tokio::sync::Notify; 1] = [&sweeps.woke];
            tokio::select! {
                biased;
                () = mixdog_core_session::session::testing::eventually_on(&wakes, || (sweeps.seen() >= want).then_some(())) => {}
                () = &mut guard => panic!(
                    "the advance did not bring the sweeps: {} of {want} seen; sweep tasks finished: {:?}",
                    sweeps.seen(),
                    running.iter().map(|dog| dog.0.is_finished()).collect::<Vec<_>>()
                ),
            }
        }
    }

    /// The sweep task ticks one period after it first runs (production times it from its first poll), and a spawned task first runs
    /// when the test lets the runtime go, which the explicit advance does. So the run's clock starts one period late, at the end of
    /// that first advance, and the sweeps then come one period apart from it as in Node.
    fn run_clock() -> Arc<Virtual> {
        Arc::new(Virtual(tokio::time::Instant::now() + SWEEP))
    }

    async fn start(unattended: bool, snapshot: impl Fn(i64) -> Option<Snapshot> + Send + 'static) -> (Option<Watchdog>, Cancel, Arc<Sweeps>) {
        mixdog_rt::testing::tokens();
        let signal = Cancel::new();
        let sweeps = Arc::new(Sweeps::default());
        let watchdog = Watchdog::arm(unattended, POLICY, signal.clone(), run_clock(), counted(&sweeps, snapshot), || {});
        run_for(1, &sweeps, &[]).await;
        (watchdog, signal, sweeps)
    }

    #[tokio::test(start_paused = true)]
    async fn an_unattended_silent_run_is_aborted_with_nodes_stale_sentence() {
        let (watchdog, signal, sweeps) = start(true, |_| Some(streaming(T0))).await;
        assert!(watchdog.is_some());
        assert_eq!(node_verdict(0, false, 60_000), None);
        run_for(60, &sweeps, &[(dog(&watchdog), &signal)]).await;
        assert!(!signal.is_aborted());
        let stale = node_verdict(0, false, 61_000).expect("Node stops the run at 61 s");
        run_for(1, &sweeps, &[(dog(&watchdog), &signal)]).await;
        assert!(signal.is_aborted());
        assert_eq!(signal.reason(), stale);
    }

    #[tokio::test(start_paused = true)]
    async fn an_attended_run_is_never_armed() {
        let (watchdog, signal, sweeps) = start(false, |_| Some(streaming(T0))).await;
        assert!(watchdog.is_none());
        tokio::time::advance(Duration::from_secs(3_600)).await;
        assert_eq!(sweeps.seen(), 0);
        assert!(!signal.is_aborted(), "no content timer for an attended run");
    }

    #[tokio::test(start_paused = true)]
    async fn progress_and_a_waiting_approval_keep_a_run_alive_as_they_do_in_node() {
        let last = Arc::new(AtomicI64::new(T0));
        let waiting = Arc::new(AtomicBool::new(false));
        let (watchdog, signal, sweeps) = {
            let (last, waiting) = (last.clone(), waiting.clone());
            start(true, move |_| {
                let mut snapshot = streaming(last.load(Ordering::SeqCst));
                snapshot.awaiting_user = waiting.load(Ordering::SeqCst);
                Some(snapshot)
            }).await
        };
        let dogs = [(dog(&watchdog), &signal)];
        run_for(50, &sweeps, &dogs).await;
        last.store(T0 + 50_000, Ordering::SeqCst);
        assert_eq!(node_verdict(50_000, false, 110_000), None);
        run_for(60, &sweeps, &dogs).await;
        assert!(!signal.is_aborted(), "60 s after the progress is within budget");
        waiting.store(true, Ordering::SeqCst);
        assert_eq!(node_verdict(0, true, 700_000), None);
        run_for(600, &sweeps, &dogs).await;
        assert!(!signal.is_aborted(), "a turn waiting on the user is not stalled");
        waiting.store(false, Ordering::SeqCst);
        let stale = node_verdict(50_000, false, 111_000).expect("Node stops the run once the approval is answered");
        run_for(2, &sweeps, &dogs).await;
        assert_eq!(signal.reason(), stale);
    }

    #[tokio::test(start_paused = true)]
    async fn the_reap_runs_once_when_the_run_goes_stale_and_never_for_a_live_one() {
        mixdog_rt::testing::tokens();
        let reaped = Arc::new(std::sync::atomic::AtomicU32::new(0));
        let sweeps = Arc::new(Sweeps::default());
        let arm = |last: i64| {
            let (signal, reaped) = (Cancel::new(), reaped.clone());
            let clock = run_clock();
            let hook = { let (signal, reaped) = (signal.clone(), reaped.clone()); move || { assert!(!signal.is_aborted(), "armed before the abort"); reaped.fetch_add(1, Ordering::SeqCst); } };
            (Watchdog::arm(true, POLICY, signal.clone(), clock, counted(&sweeps, move |_| Some(streaming(last))), hook), signal)
        };
        let (live_dog, live) = arm(T0 + 3_600_000);
        run_for(1, &sweeps, &[]).await;
        run_for(120, &sweeps, &[(dog(&live_dog), &live)]).await;
        assert!(!live.is_aborted());
        assert_eq!(reaped.load(Ordering::SeqCst), 0);
        let (stale_dog, stale) = arm(T0 - 100_000);
        run_for(1, &sweeps, &[(dog(&live_dog), &live)]).await;
        run_for(5, &sweeps, &[(dog(&live_dog), &live), (dog(&stale_dog), &stale)]).await;
        assert!(stale.is_aborted());
        assert_eq!(reaped.load(Ordering::SeqCst), 1);
    }

    #[tokio::test(start_paused = true)]
    async fn a_run_with_no_progress_snapshot_yet_gets_no_verdict() {
        let (watchdog, signal, sweeps) = start(true, |_| None).await;
        run_for(3_600, &sweeps, &[(dog(&watchdog), &signal)]).await;
        assert!(!signal.is_aborted());
    }
}