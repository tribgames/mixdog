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
            // Node's `setInterval(…, 1000)` is made as the watchdog arms (`startDispatchWatchdog`), so the first sweep is one period after
            // arming however soon the task first runs; taken inside the task, the period would count from its first poll.
            let first = tokio::time::Instant::now() + SWEEP;
            Self(mixdog_rt::spawn("agent-progress-watchdog", TaskClass::Control, async move {
                let mut sweep = tokio::time::interval_at(first, SWEEP);
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
    use std::sync::Mutex;
    use std::sync::atomic::{AtomicBool, AtomicI64, AtomicU64, Ordering};

    use mixdog_core_session::session::testing::eventually_on_awaiting;
    use mixdog_core_session::session::testing::HeldClock;
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

        /// When each sweep ran, in milliseconds after `T0`.
        fn times(&self) -> Vec<i64> {
            self.times.lock().unwrap().iter().map(|now| now - T0).collect()
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
        eventually_on_awaiting(|| format!("{want} sweeps to have run after advancing {by:?} (the clock moves only by this advance)"), &wakes, || {
            if let Some((dog, _)) = dogs.iter().find(|(dog, signal)| dog.0.is_finished() && !signal.is_aborted()) {
                panic!("a sweep task ended without aborting its run, with {} of {want} sweeps seen (finished: {})", sweeps.seen(), dog.0.is_finished());
            }
            (sweeps.seen() >= want).then_some(())
        })
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
        let watchdog = Watchdog::arm(unattended, POLICY, signal.clone(), clock, counted(&sweeps, snapshot), || {});
        (watchdog, signal, sweeps)
    }

    /// One run in the replay below: armed at its recorded instant, its progress stamp what the recording's `updateSessionStage` calls made it.
    struct Replayed {
        name: String,
        armed_at: i64,
        watchdog: Option<Watchdog>,
        signal: Cancel,
        sweeps: Arc<Sweeps>,
        last_progress: Arc<AtomicI64>,
    }

    /// Node's `startDispatchWatchdog` (`agent-dispatch/watchdog.mjs`, `b6f10295a`; its only caller is a dispatch, `agent-dispatch.mjs:148`,
    /// so a session restored at boot has none) makes its own `setInterval(…, 1000)` as it arms, and judges each sweep by the
    /// session's progress snapshot (`:22-23`); its interval goes on firing after the abort until `stop()`, but those callbacks return
    /// at the aborted check (`:20`) before reading the snapshot, and Rust ends its timer at the abort (nothing visible). Node's timers
    /// and clock mocked, with the snapshot read instrumented, gave these evaluation times (relative to the timeline's
    /// start), abort moments and sentences, for a silent run, a run whose first poll comes late, a dispatch armed while another
    /// runs, a run that progressed after a sweep found nothing, and a policy with no deadline (`record-agent-dispatch-watchdog.mjs`).
    /// The replay arms each run at its recorded instant, moves the clock only by the explicit advance to each recorded stop (nothing
    /// runs between an arming and the next advance, so a sweep task's first poll comes after the clock has moved), and every run's
    /// evaluations must be the whole sequence Node's were, and its abort when and with what Node's was.
    #[tokio::test(start_paused = true)]
    async fn the_sweeps_come_when_nodes_come_counted_from_each_arming() {
        let _held = HeldClock::hold();
        mixdog_rt::testing::tokens();
        let recording: Value = serde_json::from_str(include_str!("../../../../fixtures/agent-dispatch-watchdog/golden.json")).unwrap();
        assert_eq!(recording["t0"].as_i64(), Some(T0));
        assert_eq!(recording["policy"]["idleStaleMs"].as_i64(), Some(POLICY.idle_stale_ms));
        let scenarios = recording["scenarios"].as_array().unwrap();
        assert!(!scenarios.is_empty());
        for scenario in scenarios {
            let name = scenario["name"].as_str().unwrap();
            let clock = Arc::new(Virtual(tokio::time::Instant::now()));
            let node = |dog: &str| scenario["dogs"][dog].clone();
            let ints = |value: &Value| -> Vec<i64> { value.as_array().unwrap().iter().map(|at| at.as_i64().unwrap()).collect() };
            let mut running: Vec<Replayed> = Vec::new();
            let mut now = 0;
            for (at_stop, stop) in ints(&scenario["stops"]).into_iter().enumerate() {
                if stop > now {
                    tokio::time::advance(Duration::from_millis((stop - now) as u64)).await;
                    now = stop;
                }
                // Every armed run has made the evaluations Node's had made by now (the recording's count after the timers due at this
                // stop), and is aborted when Node's was; Node's callbacks that returned at the aborted check evaluated nothing.
                let pairs: Vec<(&Watchdog, &Cancel)> = running.iter().filter_map(|run| run.watchdog.as_ref().map(|dog| (dog, &run.signal))).collect();
                for run in &running {
                    let after = &scenario["afterStops"][at_stop][&run.name];
                    let due = after["evaluated"].as_u64().unwrap_or(0);
                    if run.watchdog.is_some() {
                        reached(Duration::from_millis(stop as u64), due, &run.sweeps, &pairs).await;
                    }
                    assert_eq!(run.sweeps.seen(), due, "{name}/{}: the evaluations by {stop} ms", run.name);
                    assert_eq!(run.signal.is_aborted(), after["aborted"].as_bool().unwrap_or(false), "{name}/{}: aborted by {stop} ms", run.name);
                }
                // Then what happens at this instant: armings and progress, after the timers due at it.
                for arm in scenario["arms"].as_array().unwrap().iter().filter(|arm| arm["at"].as_i64() == Some(stop)) {
                    let (signal, sweeps, last_progress) = (Cancel::new(), Arc::new(Sweeps::default()), Arc::new(AtomicI64::new(T0 + stop)));
                    let policy = match arm.get("policy") {
                        Some(policy) => WatchdogPolicy {
                            first_transport_ms: policy["firstTransportMs"].as_i64().unwrap(),
                            first_semantic_ms: policy["firstSemanticMs"].as_i64().unwrap(),
                            idle_stale_ms: policy["idleStaleMs"].as_i64().unwrap(),
                        },
                        None => POLICY,
                    };
                    let progress = last_progress.clone();
                    let watchdog = Watchdog::arm(true, policy, signal.clone(), clock.clone(), counted(&sweeps, move |_| Some(streaming(progress.load(Ordering::SeqCst)))), || {});
                    let dog = arm["dog"].as_str().unwrap().to_owned();
                    assert_eq!(watchdog.is_some(), node(&dog)["armed"].as_bool().unwrap(), "{name}/{dog}: whether the run is armed");
                    running.push(Replayed { name: dog, armed_at: stop, watchdog, signal, sweeps, last_progress });
                }
                for stamp in scenario["progress"].as_array().unwrap().iter().filter(|stamp| stamp["at"].as_i64() == Some(stop)) {
                    let dog = stamp["dog"].as_str().unwrap();
                    running.iter().find(|run| run.name == dog).expect("a progress stamp is for an armed run").last_progress.store(T0 + stop, Ordering::SeqCst);
                }
            }
            for run in &running {
                let recorded = node(&run.name);
                assert_eq!(run.armed_at, recorded["armedAt"].as_i64().unwrap());
                assert_eq!(run.sweeps.times(), ints(&recorded["evaluations"]), "{name}/{}: when the evaluations ran", run.name);
                if recorded["abortedAt"].as_i64().is_some() {
                    assert_eq!(run.signal.reason(), recorded["message"].as_str().unwrap(), "{name}/{}: the abort sentence", run.name);
                }
            }
        }
    }

    #[tokio::test(start_paused = true)]
    async fn an_unattended_silent_run_is_aborted_with_nodes_stale_sentence() {
        let _held = HeldClock::hold();
        let (watchdog, signal, sweeps) = start(true, |_| Some(streaming(T0)));
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
        let _held = HeldClock::hold();
        let (watchdog, signal, sweeps) = start(false, |_| Some(streaming(T0)));
        assert!(watchdog.is_none());
        tokio::time::advance(Duration::from_secs(3_600)).await;
        assert_eq!(sweeps.seen(), 0);
        assert!(!signal.is_aborted(), "no content timer for an attended run");
    }

    #[tokio::test(start_paused = true)]
    async fn progress_and_a_waiting_approval_keep_a_run_alive_as_they_do_in_node() {
        let _held = HeldClock::hold();
        let last = Arc::new(AtomicI64::new(T0));
        let waiting = Arc::new(AtomicBool::new(false));
        let (watchdog, signal, sweeps) = {
            let (last, waiting) = (last.clone(), waiting.clone());
            start(true, move |_| {
                let mut snapshot = streaming(last.load(Ordering::SeqCst));
                snapshot.awaiting_user = waiting.load(Ordering::SeqCst);
                Some(snapshot)
            })
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
        let _held = HeldClock::hold();
        mixdog_rt::testing::tokens();
        let reaped = Arc::new(std::sync::atomic::AtomicU32::new(0));
        let sweeps = Arc::new(Sweeps::default());
        let arm = |last: i64| {
            let (signal, reaped) = (Cancel::new(), reaped.clone());
            let clock = Arc::new(Virtual(tokio::time::Instant::now()));
            let hook = { let (signal, reaped) = (signal.clone(), reaped.clone()); move || { assert!(!signal.is_aborted(), "armed before the abort"); reaped.fetch_add(1, Ordering::SeqCst); } };
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