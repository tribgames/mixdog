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
        let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../fixtures/agent-watchdog/golden.json");
        let golden: Value = serde_json::from_slice(&std::fs::read(path).unwrap()).unwrap();
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

    /// Moves paused time one second at a time so each sweep sees the time it fires at.
    async fn run_for(seconds: u64) {
        for _ in 0..seconds {
            tokio::time::advance(Duration::from_secs(1)).await;
            for _ in 0..8 {
                tokio::task::yield_now().await;
            }
        }
    }

    fn start(unattended: bool, snapshot: impl Fn(i64) -> Option<Snapshot> + Send + 'static) -> (Option<Watchdog>, Cancel) {
        mixdog_rt::testing::tokens();
        let signal = Cancel::new();
        let clock = Arc::new(Virtual(tokio::time::Instant::now()));
        (Watchdog::arm(unattended, POLICY, signal.clone(), clock, snapshot, || {}), signal)
    }

    #[tokio::test(start_paused = true)]
    async fn an_unattended_silent_run_is_aborted_with_nodes_stale_sentence() {
        let (watchdog, signal) = start(true, |_| Some(streaming(T0)));
        assert!(watchdog.is_some());
        assert_eq!(node_verdict(0, false, 60_000), None);
        run_for(60).await;
        assert!(!signal.is_aborted());
        let stale = node_verdict(0, false, 61_000).expect("Node stops the run at 61 s");
        run_for(1).await;
        assert!(signal.is_aborted());
        assert_eq!(signal.reason(), stale);
    }

    #[tokio::test(start_paused = true)]
    async fn an_attended_run_is_never_armed() {
        let (watchdog, signal) = start(false, |_| Some(streaming(T0)));
        assert!(watchdog.is_none());
        run_for(3_600).await;
        assert!(!signal.is_aborted(), "no content timer for an attended run");
    }

    #[tokio::test(start_paused = true)]
    async fn progress_and_a_waiting_approval_keep_a_run_alive_as_they_do_in_node() {
        let last = Arc::new(AtomicI64::new(T0));
        let waiting = Arc::new(AtomicBool::new(false));
        let (watchdog, signal) = {
            let (last, waiting) = (last.clone(), waiting.clone());
            start(true, move |_| {
                let mut snapshot = streaming(last.load(Ordering::SeqCst));
                snapshot.awaiting_user = waiting.load(Ordering::SeqCst);
                Some(snapshot)
            })
        };
        run_for(50).await;
        last.store(T0 + 50_000, Ordering::SeqCst);
        assert_eq!(node_verdict(50_000, false, 110_000), None);
        run_for(60).await;
        assert!(!signal.is_aborted(), "60 s after the progress is within budget");
        waiting.store(true, Ordering::SeqCst);
        assert_eq!(node_verdict(0, true, 700_000), None);
        run_for(600).await;
        assert!(!signal.is_aborted(), "a turn waiting on the user is not stalled");
        waiting.store(false, Ordering::SeqCst);
        let stale = node_verdict(50_000, false, 111_000).expect("Node stops the run once the approval is answered");
        run_for(2).await;
        assert_eq!(signal.reason(), stale);
        drop(watchdog);
    }

    #[tokio::test(start_paused = true)]
    async fn the_reap_runs_once_when_the_run_goes_stale_and_never_for_a_live_one() {
        mixdog_rt::testing::tokens();
        let reaped = Arc::new(std::sync::atomic::AtomicU32::new(0));
        let arm = |last: i64| {
            let (signal, reaped) = (Cancel::new(), reaped.clone());
            let clock = Arc::new(Virtual(tokio::time::Instant::now()));
            let hook = { let (signal, reaped) = (signal.clone(), reaped.clone()); move || { assert!(!signal.is_aborted(), "armed before the abort"); reaped.fetch_add(1, Ordering::SeqCst); } };
            (Watchdog::arm(true, POLICY, signal.clone(), clock, move |_| Some(streaming(last)), hook), signal)
        };
        let (_live, live) = arm(T0 + 3_600_000);
        run_for(120).await;
        assert!(!live.is_aborted());
        assert_eq!(reaped.load(Ordering::SeqCst), 0);
        let (_stale, stale) = arm(T0 - 100_000);
        run_for(5).await;
        assert!(stale.is_aborted());
        assert_eq!(reaped.load(Ordering::SeqCst), 1);
    }

    #[tokio::test(start_paused = true)]
    async fn a_run_with_no_progress_snapshot_yet_gets_no_verdict() {
        let (_watchdog, signal) = start(true, |_| None);
        run_for(3_600).await;
        assert!(!signal.is_aborted());
    }
}