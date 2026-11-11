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
pub fn stall_abort_ctx(session_id: &str, agent: Option<&str>, site: &StallSite, policy: &WatchdogPolicy, anchor_ts: i64, snapshot: &Snapshot, message: &str, now: i64) -> Map<String, Value> {
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
                let mut sweep = mixdog_rt::time::interval_at(first, SWEEP);
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
        let watchdog = Watchdog::arm(unattended, POLICY, signal.clone(), clock, counted(&sweeps, snapshot), |_, _, _| {});
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
                    let watchdog = Watchdog::arm(true, policy, signal.clone(), clock.clone(), counted(&sweeps, move |_| Some(streaming(progress.load(Ordering::SeqCst)))), |_, _, _| {});
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
            let hook = { let (signal, reaped) = (signal.clone(), reaped.clone()); move |_: &Snapshot, _: &str, _: i64| { assert!(!signal.is_aborted(), "armed before the abort"); reaped.fetch_add(1, Ordering::SeqCst); } };
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

    /// Epoch milliseconds that follow the paused tokio clock from a recorded run's own start.
    struct Since(tokio::time::Instant, i64);

    impl Clock for Since {
        fn now_ms(&self) -> i64 {
            self.1 + self.0.elapsed().as_millis() as i64
        }
    }

    /// Node's progress snapshot object (`getSessionProgressSnapshot`) as the Rust snapshot.
    fn snapshot_of(v: &Value) -> Snapshot {
        let n = |k: &str| v[k].as_i64().unwrap_or_else(|| panic!("{k} in {v}"));
        let b = |k: &str| v[k].as_bool().unwrap_or_else(|| panic!("{k} in {v}"));
        Snapshot {
            stage: v["stage"].as_str().map(str::to_owned),
            last_progress_at: n("lastProgressAt"),
            last_stream_delta_at: n("lastStreamDeltaAt"),
            tool_started_at: n("toolStartedAt"),
            ask_started_at: n("askStartedAt"),
            first_activity_at: n("firstActivityAt"),
            model_request_started_at: n("modelRequestStartedAt"),
            last_keepalive_at: n("lastKeepaliveAt"),
            last_visible_text_at: n("lastVisibleTextAt"),
            awaiting_model_response: b("awaitingModelResponse"),
            waiting_for_transport: b("waitingForTransport"),
            waiting_for_first_semantic: b("waitingForFirstSemantic"),
            has_first_semantic: b("hasFirstSemantic"),
            awaiting_user: v.get("awaitingUser").is_some(),
            last_semantic_kind: match v["lastSemanticKind"].as_str() {
                Some("tool") => Some(mixdog_agent::agent_tool::progress::SemanticKind::Tool),
                Some("text") => Some(mixdog_agent::agent_tool::progress::SemanticKind::Text),
                Some("reasoning") => Some(mixdog_agent::agent_tool::progress::SemanticKind::Reasoning),
                None => None,
                Some(other) => panic!("semantic kind {other}"),
            },
            current_tool: v["currentTool"].as_str().map(str::to_owned),
        }
    }

    /// The clock of the failure writer under test (the recorded run's epoch time on the paused clock), and the ordered record of
    /// the run's events: the writer's "appended <kind>" as each record's rows are queued, and "aborted" for the run's signal. The
    /// writer tells its appends as they happen; an abort is set synchronously and seen at the next append or at the run's end, so
    /// an abort delivered before an append comes before it in the record.
    #[derive(Default)]
    struct Probe {
        run: Mutex<Option<(tokio::time::Instant, i64, Cancel)>>,
        last: AtomicI64,
        events: Mutex<Vec<String>>,
    }

    impl Probe {
        /// "aborted", once, when the run's signal is aborted and the record does not have it yet.
        fn note_abort(&self) {
            let aborted = self.run.lock().unwrap().as_ref().is_some_and(|(_, _, signal)| signal.is_aborted());
            let mut events = self.events.lock().unwrap();
            if aborted && !events.iter().any(|e| e == "aborted") {
                events.push("aborted".to_owned());
            }
        }

        fn appended(&self, kind: &str) {
            self.note_abort();
            self.events.lock().unwrap().push(format!("appended {kind}"));
        }
    }

    impl Clock for Probe {
        fn now_ms(&self) -> i64 {
            match &*self.run.lock().unwrap() {
                Some((start, origin, _)) => {
                    let now = origin + start.elapsed().as_millis() as i64;
                    self.last.store(now, Ordering::SeqCst);
                    now
                }
                None => self.last.load(Ordering::SeqCst),
            }
        }
    }

    /// The registry's `registration_id`s of a whole file, each 8 lowercase hex digits, named `<registration:N>` by order of
    /// appearance (the run's own value the fixture's manifest declares, `runOwnValues.registration_id`).
    fn mask_registrations(text: &str) -> String {
        let mut seen: Vec<String> = Vec::new();
        text.split_inclusive('\n')
            .map(|line| {
                let row: Value = serde_json::from_str(line.trim_end_matches('\n')).unwrap();
                let Some(id) = row["registration_id"].as_str() else {
                    return line.to_owned();
                };
                assert!(id.len() == 8 && id.bytes().all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase()), "{id} is 8 hex digits");
                let n = seen.iter().position(|s| s == id).unwrap_or_else(|| {
                    seen.push(id.to_owned());
                    seen.len() - 1
                });
                line.replace(&format!("\"registration_id\":\"{id}\""), &format!("\"registration_id\":\"<registration:{}>\"", n + 1))
            })
            .collect()
    }

    /// Replays every run of `fixtures/watchdog-stall-rows` (recorded by `benchmarks/rust-core/recorders/record-watchdog-stall-rows.mjs`
    /// on mocked interval timers and clock) into the product's failure writer of a fresh data folder, configured from `env` as the host
    /// configures it: each run is armed at its recorded instant, each sweep is given the snapshot Node's sweep read at that instant, the
    /// clock moves only by the explicit one-second advance, and the stop is recorded as both arming sites record it (`factory.rs` hands
    /// `stall_abort_ctx` to the run's `RunFailureLog::stall_abort`; `agent_dispatch.rs` hands it to the host's `StallLog`, which is
    /// `FailureWriter::record_watchdog_abort` in `compose_flip.rs`). Each stop must come at Node's sweep with Node's sentence, and its
    /// run's events must be `appended`: the writer's append of the stop's rows, then the abort (Node records, then aborts:
    /// `agent-progress-watchdog.mjs:291-293`). Returns the two files the writer's exit flush left (`None`: not written).
    async fn replay_stall_rows(golden: &Value, env: &[(&str, &str)], appended: &[&str]) -> (Option<String>, Option<String>) {
        let tokens = mixdog_rt::testing::tokens();
        let policy = &golden["policy"];
        let policy = WatchdogPolicy {
            first_transport_ms: policy["firstTransportMs"].as_i64().unwrap(),
            first_semantic_ms: policy["firstSemanticMs"].as_i64().unwrap(),
            idle_stale_ms: policy["idleStaleMs"].as_i64().unwrap(),
        };
        let data = tempfile::tempdir().unwrap();
        let vars: std::collections::HashMap<String, String> = env.iter().map(|(k, v)| ((*k).to_owned(), (*v).to_owned())).collect();
        let config = mixdog_trace::TraceConfig::from_env(data.path(), &|name| vars.get(name).cloned(), false);
        let io = mixdog_core_api::domain::tool::ToolIo { interactive: tokens.interactive_io, durability: tokens.durability_io, maintenance: tokens.maintenance_io };
        let probe = Arc::new(Probe::default());
        let told = probe.clone();
        let writer = Arc::new(mixdog_core_run::run_host::failure_log::FailureWriter::with_appended(&config, io, probe.clone(), Arc::new(move |kind| told.appended(kind))));
        let runs = golden["runs"].as_array().unwrap();
        assert!(!runs.is_empty());
        for run in runs {
            let (site_name, name) = (run["site"].as_str().unwrap(), run["name"].as_str().unwrap());
            let (origin, session) = (run["origin"].as_i64().unwrap(), run["sessionId"].as_str().unwrap().to_owned());
            let agent = run["agent"].as_str().unwrap().to_owned();
            let seen: Vec<(i64, Snapshot)> = run["sweeps"].as_array().unwrap().iter().map(|sweep| (sweep["at"].as_i64().unwrap(), snapshot_of(&sweep["snapshot"]))).collect();
            let site = match site_name {
                "dispatch" => StallSite::Dispatch { iteration: Value::Null },
                "registry" => StallSite::Registry { registration_id: registration_id() },
                other => panic!("site {other}"),
            };
            let (signal, sweeps) = (Cancel::new(), Arc::new(Sweeps::default()));
            let start = tokio::time::Instant::now();
            *probe.run.lock().unwrap() = Some((start, origin, signal.clone()));
            probe.events.lock().unwrap().clear();
            let clock = Arc::new(Since(start, origin));
            let log = mixdog_core_run::run_host::failure_log::RunFailureLog::new(writer.clone(), &session, Some(&agent), "");
            let hook = move |snapshot: &Snapshot, message: &str, now: i64| {
                mixdog_agent::env::ToolFailureLog::stall_abort(&log, stall_abort_ctx(&session, Some(&agent), &site, &policy, origin, snapshot, message, now));
            };
            let snapshot = move |now: i64| -> Option<Snapshot> {
                let at = now - origin;
                Some(seen.iter().find(|(when, _)| *when == at).unwrap_or_else(|| panic!("no recorded sweep at {at} ms")).1.clone())
            };
            let watchdog = Watchdog::arm(true, policy, signal.clone(), clock, counted(&sweeps, snapshot), hook);
            let dogs = [(dog(&watchdog), &signal)];
            let stopped_at = run["abortedAt"].as_i64().unwrap();
            run_for((stopped_at / 1000) as u64, &sweeps, &dogs).await;
            assert!(signal.is_aborted(), "{site_name}/{name}: stopped by {stopped_at} ms");
            assert_eq!(signal.reason(), run["message"].as_str().unwrap(), "{site_name}/{name}: the sentence");
            probe.note_abort();
            let want: Vec<String> = appended.iter().map(|kind| format!("appended {kind}")).chain(["aborted".to_owned()]).collect();
            assert_eq!(*probe.events.lock().unwrap(), want, "{site_name}/{name}: the stop's rows are queued, then the abort is delivered");
        }
        *probe.run.lock().unwrap() = None;
        writer.flush().await;
        let read = |name: &str| std::fs::read_to_string(data.path().join("history").join(name)).ok();
        (read("tool-failures.jsonl"), read("agent-trace.jsonl"))
    }

    /// The two files Node wrote when its watchdogs stopped the recorded runs (`MIXDOG_DIAGNOSTICS=1`), whole and in order, the
    /// registration ids named as the manifest declares.
    #[tokio::test(start_paused = true)]
    async fn a_stop_writes_the_stall_abort_rows_node_writes() {
        let _held = HeldClock::hold();
        let golden: Value = serde_json::from_str(include_str!("../../../../fixtures/watchdog-stall-rows/golden.json")).unwrap();
        let manifest: Value = serde_json::from_str(include_str!("../../../../fixtures/watchdog-stall-rows/MANIFEST.json")).unwrap();
        assert!(manifest.to_string().contains("\"runOwnValues\":{\"registration_id\""), "the manifest declares the registration id as the run's own");
        let (failures, trace) = replay_stall_rows(&golden, &[("MIXDOG_DIAGNOSTICS", "1")], &["stall_abort"]).await;
        assert_eq!(mask_registrations(&failures.expect("tool-failures.jsonl")), golden["failures"].as_str().unwrap(), "history/tool-failures.jsonl");
        assert_eq!(trace.as_deref(), golden["trace"].as_str(), "history/agent-trace.jsonl");
    }

    /// With `MIXDOG_AGENT_TRACE_DISABLE=1` Node's stop records nothing (`agent-progress-watchdog.mjs:201`, and `appendAgentTrace`):
    /// the runs stop as before and the files are what Node's were (`traceDisabled`).
    #[tokio::test(start_paused = true)]
    async fn a_stop_with_the_trace_disabled_writes_what_node_writes() {
        let _held = HeldClock::hold();
        let golden: Value = serde_json::from_str(include_str!("../../../../fixtures/watchdog-stall-rows/golden.json")).unwrap();
        // The stop's append still runs before the abort, and queues nothing.
        let (failures, trace) = replay_stall_rows(&golden, &[("MIXDOG_DIAGNOSTICS", "1"), ("MIXDOG_AGENT_TRACE_DISABLE", "1")], &["stall_abort"]).await;
        assert_eq!(failures.as_deref(), golden["traceDisabled"]["failures"].as_str(), "history/tool-failures.jsonl");
        assert_eq!(trace.as_deref(), golden["traceDisabled"]["trace"].as_str(), "history/agent-trace.jsonl");
    }

    #[tokio::test(start_paused = true)]
    async fn a_run_with_no_progress_snapshot_yet_gets_no_verdict() {
        let _held = HeldClock::hold();
        let (watchdog, signal, sweeps) = start(true, |_| None);
        run_for(3_600, &sweeps, &[(dog(&watchdog), &signal)]).await;
        assert!(!signal.is_aborted());
    }
}