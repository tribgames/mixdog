//! The supervisor against the scripted helper (`graph_host_fixture`): real processes, pipes and containment. The idle
//! deadline and the drain bounds run on a hand-stepped clock, and the helper's scripted points wait at a TCP barrier the
//! test releases. Nothing sleeps; every wait is for an event, bounded only so a missing one fails instead of hanging.

use std::collections::HashMap;
use std::future::Future;
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::Mutex;
use std::task::Context;
use std::task::Waker;
use std::time::Duration;

use mixdog_graph_host::CloseOutcome;
use mixdog_graph_host::GraphHost;
use mixdog_graph_host::HostConfig;
use mixdog_graph_host::HostError;
use mixdog_graph_host::HostEvent;
use mixdog_graph_host::HostState;
use mixdog_graph_host::IDLE;
use mixdog_graph_host::KillReason;
use mixdog_graph_host::Observer;
use mixdog_graph_host::OwnedCommand;
use mixdog_graph_host::Start;
use mixdog_graph_host::TransportError;
use mixdog_graph_host::clock::ManualClock;
use mixdog_graph_host::testing;
use mixdog_graph_host::wire::Answer;
use mixdog_graph_host::wire::Changed;
use mixdog_graph_host::wire::FailureKind;
use mixdog_graph_host::wire::FileIdentity;
use mixdog_graph_host::wire::ForgetRoot;
use mixdog_graph_host::wire::Forgot;
use mixdog_graph_host::wire::Prewarm;
use mixdog_graph_host::wire::Query;
use mixdog_graph_host::wire::Refusal;
use mixdog_graph_host::wire::Warmed;
use mixdog_graph_host::wire::WorkerFailure;
use serde_json::Value;
use serde_json::json;
use tokio::io::AsyncBufReadExt;
use tokio::io::AsyncReadExt;
use tokio::io::AsyncWriteExt;
use tokio::io::BufReader;
use tokio::net::TcpListener;
use tokio::net::TcpStream;
use tokio::sync::Notify;
use tokio::sync::oneshot;
use tokio::task::JoinHandle;
use tokio_util::sync::CancellationToken;
use tracing::Level;
use tracing_subscriber::layer::SubscriberExt;

const DRAIN: Duration = Duration::from_secs(30);
/// How long an awaited event may take before the test fails instead of hanging.
const BOUND: Duration = Duration::from_secs(60);

async fn within<T>(future: impl Future<Output = T>) -> T {
    mixdog_rt::time::timeout(BOUND, future).await.expect("the awaited event did not come")
}

#[derive(Default)]
struct Recorder {
    seen: Mutex<Vec<HostEvent>>,
    added: Notify,
}

impl Recorder {
    fn observer(self: &Arc<Self>) -> Observer {
        let recorder = self.clone();
        Arc::new(move |event: &HostEvent| {
            recorder.seen.lock().unwrap().push(event.clone());
            recorder.added.notify_waiters();
        })
    }

    fn all(&self) -> Vec<HostEvent> {
        self.seen.lock().unwrap().clone()
    }

    fn count(&self, matching: impl Fn(&HostEvent) -> bool) -> usize {
        self.all().iter().filter(|event| matching(event)).count()
    }

    fn position(&self, matching: impl Fn(&HostEvent) -> bool) -> usize {
        let events = self.all();
        events.iter().position(matching).unwrap_or_else(|| panic!("no such event in {events:?}"))
    }

    /// Waits until `n` events match.
    async fn until(&self, n: usize, matching: impl Fn(&HostEvent) -> bool) {
        loop {
            let added = self.added.notified();
            tokio::pin!(added);
            added.as_mut().enable();
            if self.count(&matching) >= n {
                return;
            }
            added.await;
        }
    }

    fn spawned_pid(&self, generation: u64) -> u32 {
        let events = self.all();
        events
            .iter()
            .find_map(|event| match event {
                HostEvent::Spawned { generation: spawned, pid } if *spawned == generation => Some(*pid),
                _ => None,
            })
            .unwrap_or_else(|| panic!("generation {generation} was not spawned: {events:?}"))
    }

    /// Every queued call was settled once, and no call more than once.
    fn assert_settled_once(&self) {
        let events = self.all();
        let mut settled = HashMap::<u64, usize>::new();
        for event in &events {
            if let HostEvent::Settled { ticket, .. } = event {
                *settled.entry(*ticket).or_default() += 1;
            }
        }
        assert!(settled.values().all(|&times| times == 1), "a call settled twice: {events:?}");
        for event in &events {
            if let HostEvent::Queued { ticket } = event {
                assert_eq!(settled.get(ticket), Some(&1), "call {ticket} was not settled: {events:?}");
            }
        }
    }
}

fn spawned(event: &HostEvent) -> bool {
    matches!(event, HostEvent::Spawned { .. })
}

fn killed(event: &HostEvent) -> bool {
    matches!(event, HostEvent::Killed { .. })
}

fn reaped(generation: u64) -> impl Fn(&HostEvent) -> bool {
    move |event| matches!(event, HostEvent::Reaped { generation: reaped, .. } if *reaped == generation)
}

fn spawned_as(generation: u64) -> impl Fn(&HostEvent) -> bool {
    move |event| matches!(event, HostEvent::Spawned { generation: spawned, .. } if *spawned == generation)
}

fn idle_armed(generation: u64) -> impl Fn(&HostEvent) -> bool {
    move |event| matches!(event, HostEvent::IdleArmed { generation: armed } if *armed == generation)
}

fn draining(generation: u64) -> impl Fn(&HostEvent) -> bool {
    move |event| matches!(event, HostEvent::Draining { generation: draining, .. } if *draining == generation)
}

/// The test's end of the scripted points: each connects, names itself and its pid, and waits for one byte.
struct Barrier {
    listener: TcpListener,
    address: String,
}

struct Entered {
    point: String,
    pid: u32,
    stream: TcpStream,
}

impl Barrier {
    async fn bind() -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap().to_string();
        Self { listener, address }
    }

    async fn entered(&self) -> Entered {
        let (stream, _) = self.listener.accept().await.unwrap();
        let mut stream = BufReader::new(stream);
        let mut line = String::new();
        stream.read_line(&mut line).await.unwrap();
        let (point, pid) = line.trim().split_once(' ').unwrap();
        Entered { point: point.to_owned(), pid: pid.parse().unwrap(), stream: stream.into_inner() }
    }
}

impl Entered {
    async fn release(mut self) {
        self.stream.write_all(b"x").await.unwrap();
    }
}

struct Harness {
    host: Arc<GraphHost>,
    clock: Arc<ManualClock>,
    events: Arc<Recorder>,
    barrier: Barrier,
}

async fn harness(flags: &[&str], queue_capacity: usize) -> Harness {
    harness_with(flags, queue_capacity, |command| command).await
}

/// A harness whose helper is started with `command` applied to its command.
async fn harness_with(flags: &[&str], queue_capacity: usize, command: impl FnOnce(OwnedCommand) -> OwnedCommand) -> Harness {
    let barrier = Barrier::bind().await;
    // A build reused from an archive runs elsewhere than it was compiled: the run names the moved fixture.
    let fixture = std::env::var("CARGO_BIN_EXE_graph_host_fixture").unwrap_or_else(|_| env!("CARGO_BIN_EXE_graph_host_fixture").to_owned());
    let command = command(OwnedCommand::new(fixture).arg("--barrier").arg(&barrier.address).args(flags.iter().copied()));
    let clock = Arc::new(ManualClock::new());
    let events = Arc::new(Recorder::default());
    let config = HostConfig { command, queue_capacity, idle: IDLE, drain_limit: DRAIN, clock: clock.clone(), observer: Some(events.observer()) };
    let (host, driver) = GraphHost::new(config);
    tokio::spawn(driver);
    Harness { host: Arc::new(host), clock, events, barrier }
}

fn query(args: Value) -> Query {
    Query { session_cwd: PathBuf::from("/fixture"), args, registered: Vec::new(), selected: Vec::new() }
}

fn spawn_query(harness: &Harness, args: Value, cancel: CancellationToken) -> JoinHandle<Result<Answer, HostError>> {
    let host = harness.host.clone();
    tokio::spawn(async move { host.query(query(args), &cancel).await })
}

async fn ask(harness: &Harness, args: Value) -> Result<Answer, HostError> {
    within(harness.host.query(query(args), &CancellationToken::new())).await
}

fn reported(answer: &Answer) -> Value {
    serde_json::from_str(&answer.text).unwrap()
}

fn pid_of(answer: &Answer) -> u32 {
    reported(answer)["pid"].as_u64().unwrap() as u32
}

fn changes_of(answer: &Answer) -> Vec<String> {
    reported(answer)["changes"].as_array().unwrap().iter().map(|change| change.as_str().unwrap().to_owned()).collect()
}

fn known(identity: &str) -> FileIdentity {
    FileIdentity::Known { identity: identity.to_owned() }
}

/// A removal of `root` whose disk routine must not run: only the helper may answer it.
fn spawn_forget(harness: &Harness, root: &str) -> JoinHandle<Result<Forgot, HostError>> {
    let (host, root) = (harness.host.clone(), PathBuf::from(root));
    tokio::spawn(async move { host.forget_root(ForgetRoot { root }, |_| async { Err("the disk routine ran".to_owned()) }).await })
}

/// A removal of `/live` whose disk routine reports, as `disk /live after <n> spawns`, how many helpers had been spawned
/// when it ran; it tells `started` that count, then waits for `release` if given one.
fn spawn_forget_on_disk(
    harness: &Harness,
    started: Option<oneshot::Sender<usize>>,
    release: Option<oneshot::Receiver<()>>,
) -> JoinHandle<Result<Forgot, HostError>> {
    let (host, events) = (harness.host.clone(), harness.events.clone());
    let on_disk = move |forget: ForgetRoot| async move {
        let spawns = events.count(spawned);
        if let Some(started) = started {
            let _ = started.send(spawns);
        }
        if let Some(release) = release {
            let _ = release.await;
        }
        Ok(Forgot { removed: vec![format!("disk {} after {spawns} spawns", forget.root.display())], kept: Vec::new() })
    };
    tokio::spawn(async move { host.forget_root(ForgetRoot { root: PathBuf::from("/live") }, on_disk).await })
}

#[tokio::test]
async fn concurrent_first_calls_share_one_startup() {
    let h = harness(&["--hold-ready"], 8).await;
    let calls: Vec<_> = (0..3).map(|_| spawn_query(&h, json!({}), CancellationToken::new())).collect();
    let ready = within(h.barrier.entered()).await;
    assert_eq!(ready.point, "ready");
    let status = within(h.host.wait_status(|status| status.queued == 3)).await;
    assert_eq!(status.state, HostState::Starting);
    let pid = ready.pid;
    ready.release().await;
    for call in calls {
        assert_eq!(pid_of(&within(call).await.unwrap().unwrap()), pid);
    }
    assert_eq!(h.events.count(spawned), 1);
    h.events.assert_settled_once();
}

#[tokio::test]
async fn the_queue_is_bounded_and_a_cancelled_queued_call_leaves_the_rest_alone() {
    let h = harness(&[], 2).await;
    let first = spawn_query(&h, json!({ "do": "block" }), CancellationToken::new());
    let held = within(h.barrier.entered()).await;
    let withdrawn = CancellationToken::new();
    let second = spawn_query(&h, json!({}), withdrawn.clone());
    let third = spawn_query(&h, json!({}), CancellationToken::new());
    within(h.host.wait_status(|status| status.queued == 2 && status.dispatched)).await;
    assert_eq!(ask(&h, json!({})).await, Err(HostError::Overloaded));
    withdrawn.cancel();
    assert_eq!(within(second).await.unwrap(), Err(HostError::Cancelled));
    within(h.host.wait_status(|status| status.queued == 1)).await;
    let fourth = spawn_query(&h, json!({}), CancellationToken::new());
    within(h.host.wait_status(|status| status.queued == 2)).await;
    let pid = held.pid;
    held.release().await;
    for call in [first, third, fourth] {
        assert_eq!(pid_of(&within(call).await.unwrap().unwrap()), pid);
    }
    assert_eq!(h.events.count(killed), 0);
    assert_eq!(h.events.count(spawned), 1);
    h.events.assert_settled_once();
}

#[tokio::test]
async fn cancelling_the_dispatched_call_kills_its_generation_and_the_next_starts_after_the_reap() {
    let h = harness(&[], 4).await;
    let cancel = CancellationToken::new();
    let first = spawn_query(&h, json!({ "do": "block" }), cancel.clone());
    let _held = within(h.barrier.entered()).await;
    let second = spawn_query(&h, json!({}), CancellationToken::new());
    within(h.host.wait_status(|status| status.queued == 1)).await;
    cancel.cancel();
    assert_eq!(within(first).await.unwrap(), Err(HostError::Cancelled));
    let answer = within(second).await.unwrap().unwrap();
    assert_eq!(pid_of(&answer), h.events.spawned_pid(2));
    let killed = h.events.position(|event| matches!(event, HostEvent::Killed { generation: 1, why: KillReason::Cancelled, .. }));
    let reaped = h.events.position(reaped(1));
    assert!(killed < reaped && reaped < h.events.position(spawned_as(2)), "{:?}", h.events.all());
    h.events.assert_settled_once();
}

#[tokio::test]
async fn dropping_the_dispatched_call_cancels_it() {
    let h = harness(&[], 4).await;
    let first = spawn_query(&h, json!({ "do": "block" }), CancellationToken::new());
    let _held = within(h.barrier.entered()).await;
    first.abort();
    assert!(within(first).await.unwrap_err().is_cancelled());
    within(h.events.until(1, reaped(1))).await;
    assert_eq!(h.events.count(|event| matches!(event, HostEvent::Killed { generation: 1, why: KillReason::Cancelled, .. })), 1);
    assert_eq!(pid_of(&ask(&h, json!({})).await.unwrap()), h.events.spawned_pid(2));
    h.events.assert_settled_once();
}

/// A query scripted to break the helper `mode`'s way fails once with a transport error matching `expected`, the
/// generation is reaped, and the next call is served by a new one started after that reap.
async fn a_broken_helper_settles_its_call_once(mode: &str, expected: impl Fn(&TransportError) -> bool) -> Arc<Recorder> {
    let h = harness(&[], 4).await;
    let error = ask(&h, json!({ "do": mode })).await.unwrap_err();
    assert!(matches!(&error, HostError::Transport(transport) if expected(transport)), "{error:?}");
    within(h.events.until(1, reaped(1))).await;
    assert_eq!(pid_of(&ask(&h, json!({})).await.unwrap()), h.events.spawned_pid(2));
    assert!(h.events.position(reaped(1)) < h.events.position(spawned_as(2)), "{:?}", h.events.all());
    h.events.assert_settled_once();
    h.events
}

fn killed_for_transport(event: &HostEvent) -> bool {
    matches!(event, HostEvent::Killed { generation: 1, why: KillReason::Transport, .. })
}

#[tokio::test]
async fn a_crash_settles_the_dispatched_call_once() {
    a_broken_helper_settles_its_call_once("crash", |error| matches!(error, TransportError::Eof | TransportError::Exited(Some(3)))).await;
}

/// A panic in the helper aborts it (Windows' `__fastfail` status; SIGABRT elsewhere, which leaves no code): a crash.
#[tokio::test]
async fn a_panic_aborts_the_helper_and_settles_the_dispatched_call_once() {
    let aborted = if cfg!(windows) { Some(0xC000_0409_u32 as i32) } else { None };
    a_broken_helper_settles_its_call_once("panic", |error| matches!(error, TransportError::Eof) || *error == TransportError::Exited(aborted)).await;
}

#[tokio::test]
async fn the_end_of_the_helpers_output_settles_the_dispatched_call_once_and_kills_it() {
    let events = a_broken_helper_settles_its_call_once("eof", |error| *error == TransportError::Eof).await;
    assert_eq!(events.count(killed_for_transport), 1);
}

#[tokio::test]
async fn a_malformed_frame_settles_the_dispatched_call_once_and_kills_it() {
    let events = a_broken_helper_settles_its_call_once("malformed", |error| matches!(error, TransportError::Malformed(_))).await;
    assert_eq!(events.count(killed_for_transport), 1);
}

#[tokio::test]
async fn an_incompatible_ready_fails_the_calls_waiting_for_the_startup() {
    let h = harness(&["--hold-ready", "--bad-ready"], 4).await;
    let calls: Vec<_> = (0..2).map(|_| spawn_query(&h, json!({}), CancellationToken::new())).collect();
    let ready = within(h.barrier.entered()).await;
    within(h.host.wait_status(|status| status.queued == 2)).await;
    ready.release().await;
    for call in calls {
        assert_eq!(within(call).await.unwrap(), Err(HostError::Transport(TransportError::Incompatible { version: 999 })));
    }
    within(h.events.until(1, reaped(1))).await;
    assert_eq!(h.events.count(killed_for_transport), 1);
    assert_eq!(h.events.count(spawned), 1);
    h.events.assert_settled_once();
}

#[tokio::test]
async fn a_call_during_idle_retirement_waits_for_the_old_process_to_be_reaped() {
    let h = harness(&["--hold-drain"], 4).await;
    let first = ask(&h, json!({})).await.unwrap();
    within(h.events.until(1, |event| matches!(event, HostEvent::IdleArmed { generation: 1 }))).await;
    h.clock.advance(IDLE);
    let drain = within(h.barrier.entered()).await;
    assert_eq!((drain.point.as_str(), drain.pid), ("drain", pid_of(&first)));
    let second = spawn_query(&h, json!({}), CancellationToken::new());
    let status = within(h.host.wait_status(|status| status.queued == 1)).await;
    assert_eq!(status.state, HostState::Retiring);
    assert_eq!(h.events.count(spawned), 1);
    drain.release().await;
    assert_eq!(pid_of(&within(second).await.unwrap().unwrap()), h.events.spawned_pid(2));
    let draining = h.events.position(|event| matches!(event, HostEvent::Draining { generation: 1, .. }));
    let reaped = h.events.position(reaped(1));
    assert!(draining < reaped && reaped < h.events.position(spawned_as(2)), "{:?}", h.events.all());
    assert_eq!(h.events.count(killed), 0);
    h.events.assert_settled_once();
}

#[tokio::test]
async fn a_completed_call_moves_the_idle_deadline() {
    let h = harness(&[], 4).await;
    let idle_armed = |event: &HostEvent| matches!(event, HostEvent::IdleArmed { generation: 1 });
    let pid = pid_of(&ask(&h, json!({})).await.unwrap());
    within(h.events.until(1, idle_armed)).await;
    h.clock.advance(IDLE - Duration::from_secs(1));
    assert_eq!(h.clock.pending(), 1);
    assert_eq!(pid_of(&ask(&h, json!({})).await.unwrap()), pid);
    within(h.events.until(2, idle_armed)).await;
    h.clock.advance(IDLE - Duration::from_secs(1));
    assert_eq!((h.clock.pending(), h.host.status().state), (1, HostState::Running));
    h.clock.advance(Duration::from_secs(1));
    within(h.events.until(1, reaped(1))).await;
    assert_eq!(h.events.count(|event| matches!(event, HostEvent::Draining { generation: 1, .. })), 1);
    assert_eq!(h.events.count(killed), 0);
}

#[tokio::test]
async fn a_call_in_the_same_turn_as_the_idle_deadline_keeps_the_helper() {
    let h = harness(&[], 4).await;
    let pid = pid_of(&ask(&h, json!({})).await.unwrap());
    within(h.events.until(1, |event| matches!(event, HostEvent::IdleArmed { generation: 1 }))).await;
    h.clock.advance(IDLE);
    let never = CancellationToken::new();
    let mut second = Box::pin(h.host.query(query(json!({})), &never));
    // Admitted before the driver runs again, so it finds the deadline and the call ready together.
    assert!(second.as_mut().poll(&mut Context::from_waker(Waker::noop())).is_pending());
    assert_eq!(pid_of(&within(second).await.unwrap()), pid);
    assert_eq!(h.events.count(|event| matches!(event, HostEvent::Draining { .. })), 0);
    assert_eq!(h.host.status().state, HostState::Running);
}

fn closed(event: &HostEvent) -> bool {
    matches!(event, HostEvent::Closed { .. })
}

#[tokio::test]
async fn close_with_a_build_in_flight_ends_the_helper_without_waiting_for_the_build() {
    let h = harness(&[], 4).await;
    let first = spawn_query(&h, json!({ "do": "block" }), CancellationToken::new());
    let mut held = within(h.barrier.entered()).await;
    let second = spawn_query(&h, json!({}), CancellationToken::new());
    within(h.host.wait_status(|status| status.queued == 1)).await;
    // The build stays at the barrier and the clock never moves: the close waits for neither.
    assert_eq!(within(h.host.close(Duration::from_secs(600))).await, CloseOutcome::Interrupted);
    assert_eq!(within(first).await.unwrap(), Err(HostError::Closed));
    assert_eq!(within(second).await.unwrap(), Err(HostError::Closed));
    // The helper is gone: its end of the barrier closed with it.
    let ended = within(held.stream.read(&mut [0; 1])).await;
    assert!(matches!(ended, Ok(0) | Err(_)), "{ended:?}");
    assert_eq!(h.events.count(|event| matches!(event, HostEvent::Killed { generation: 1, why: KillReason::Close, .. })), 1);
    assert_eq!(h.events.count(draining(1)), 0);
    assert!(h.events.position(reaped(1)) < h.events.position(closed));
    assert_eq!(h.host.status().state, HostState::Closed);
    assert_eq!(ask(&h, json!({})).await, Err(HostError::Closed));
    assert_eq!(within(h.host.close(Duration::ZERO)).await, CloseOutcome::Interrupted);
    h.events.assert_settled_once();
}

#[tokio::test]
async fn close_with_an_idle_helper_drains_it() {
    let h = harness(&["--hold-drain"], 4).await;
    let pid = pid_of(&ask(&h, json!({})).await.unwrap());
    let closing = {
        let host = h.host.clone();
        tokio::spawn(async move { host.close(Duration::from_secs(600)).await })
    };
    let drain = within(h.barrier.entered()).await;
    assert_eq!((drain.point.as_str(), drain.pid), ("drain", pid));
    assert!(!closing.is_finished(), "the close waits for the drain");
    drain.release().await;
    assert_eq!(within(closing).await.unwrap(), CloseOutcome::Drained);
    assert_eq!(h.events.count(draining(1)), 1);
    assert_eq!(h.events.count(killed), 0);
    assert!(h.events.position(reaped(1)) < h.events.position(closed));
    assert_eq!(h.host.status().state, HostState::Closed);
    assert_eq!(ask(&h, json!({})).await, Err(HostError::Closed));
    assert_eq!(within(h.host.close(Duration::ZERO)).await, CloseOutcome::Drained);
    h.events.assert_settled_once();
}

/// The core's log as the test's subscriber sees it: the records carried from a helper, as level, message and pid.
#[derive(Default)]
struct Relayed {
    records: Mutex<Vec<(Level, String, u64)>>,
    added: Notify,
}

impl Relayed {
    /// The process's subscriber: the relay logs on a thread of its own.
    fn install() -> Arc<Self> {
        let relayed = Arc::new(Self::default());
        tracing::subscriber::set_global_default(tracing_subscriber::registry().with(RelayedLayer(relayed.clone())))
            .expect("no other subscriber in this test's process");
        relayed
    }

    async fn until(&self, n: usize) -> Vec<(Level, String, u64)> {
        loop {
            let added = self.added.notified();
            tokio::pin!(added);
            added.as_mut().enable();
            let records = self.records.lock().unwrap().clone();
            if records.len() >= n {
                return records;
            }
            added.await;
        }
    }
}

struct RelayedLayer(Arc<Relayed>);

impl<S: tracing::Subscriber> tracing_subscriber::Layer<S> for RelayedLayer {
    fn on_event(&self, event: &tracing::Event<'_>, _: tracing_subscriber::layer::Context<'_, S>) {
        let mut fields = RelayedFields::default();
        event.record(&mut fields);
        if let Some(pid) = fields.helper_pid {
            self.0.records.lock().unwrap().push((*event.metadata().level(), fields.message, pid));
            self.0.added.notify_waiters();
        }
    }
}

#[derive(Default)]
struct RelayedFields {
    message: String,
    helper_pid: Option<u64>,
}

impl tracing::field::Visit for RelayedFields {
    fn record_u64(&mut self, field: &tracing::field::Field, value: u64) {
        if field.name() == "helper_pid" {
            self.helper_pid = Some(value);
        }
    }

    fn record_debug(&mut self, field: &tracing::field::Field, value: &dyn std::fmt::Debug) {
        if field.name() == "message" {
            self.message = format!("{value:?}");
        }
    }
}

#[tokio::test]
async fn the_helpers_log_and_its_other_standard_error_lines_reach_the_core_log() {
    let relayed = Relayed::install();
    let h = harness_with(&[], 4, |command| command.env("RUST_LOG", "warn")).await;
    let pid = u64::from(pid_of(&ask(&h, json!({ "do": "log" })).await.unwrap()));
    assert_eq!(
        within(relayed.until(2)).await,
        [(Level::WARN, "a record of the helper".to_owned(), pid), (Level::ERROR, "a line of the helper's own".to_owned(), pid)]
    );
}

#[tokio::test]
async fn close_kills_a_helper_that_does_not_drain_within_the_budget() {
    let h = harness(&["--hold-drain"], 4).await;
    ask(&h, json!({})).await.unwrap();
    let closing = {
        let host = h.host.clone();
        tokio::spawn(async move { host.close(DRAIN).await })
    };
    let _drain = within(h.barrier.entered()).await;
    h.clock.advance(DRAIN);
    assert_eq!(within(closing).await.unwrap(), CloseOutcome::Killed);
    assert_eq!(h.events.count(|event| matches!(event, HostEvent::Killed { generation: 1, why: KillReason::Close, .. })), 1);
    assert_eq!(h.events.count(reaped(1)), 1);
}

#[tokio::test]
async fn write_notices_reach_the_helper_during_a_build_and_none_starts_one() {
    let h = harness(&[], 4).await;
    h.host.changed(Changed { files: vec![known("before")] });
    let waiting = spawn_query(&h, json!({ "do": "wait-change" }), CancellationToken::new());
    within(h.events.until(1, |event| matches!(event, HostEvent::Dispatched { .. }))).await;
    h.host.changed(Changed { files: vec![known("a"), FileIdentity::Unknown] });
    h.host.changed(Changed { files: vec![known("release")] });
    assert_eq!(changes_of(&within(waiting).await.unwrap().unwrap()), ["a", "?", "release"]);
    assert_eq!(changes_of(&ask(&h, json!({})).await.unwrap()), ["a", "?", "release"]);
    assert!(matches!(h.events.all().first(), Some(HostEvent::Queued { .. })), "{:?}", h.events.all());
    assert_eq!(h.events.count(spawned), 1);
}

#[tokio::test]
async fn answers_keep_their_shape_and_size_across_the_pipe() {
    let h = harness(&[], 4).await;
    assert_eq!(ask(&h, json!({ "roots": null })).await.unwrap().dependency_roots, None);
    assert_eq!(ask(&h, json!({ "roots": [] })).await.unwrap().dependency_roots, Some(Vec::new()));
    let partial = ask(&h, json!({ "roots": ["/a", "/b"], "complete": false })).await.unwrap();
    assert_eq!((partial.dependency_roots, partial.complete), (Some(vec![PathBuf::from("/a"), PathBuf::from("/b")]), false));
    let big = ask(&h, json!({ "do": "big", "bytes": 3 << 20 })).await.unwrap();
    assert!(big.text.len() == 3 << 20 && big.text.bytes().all(|byte| byte == b'x'));
    assert_eq!(ask(&h, json!({ "do": "refuse" })).await, Err(HostError::Refused(Refusal { message: "refused by the fixture".to_owned() })));
    let failure = WorkerFailure { kind: FailureKind::Io, message: "failed by the fixture".to_owned() };
    assert_eq!(ask(&h, json!({ "do": "fail" })).await, Err(HostError::Failed(failure)));
    let prewarm = Prewarm { cwd: PathBuf::from("/fixture") };
    assert_eq!(within(h.host.prewarm(prewarm, Start::Demand, &CancellationToken::new())).await, Ok(Warmed { built: true }));
    assert_eq!((h.events.count(spawned), h.events.count(killed)), (1, 0));
    h.events.assert_settled_once();
}

#[tokio::test]
async fn a_root_is_forgotten_on_the_disk_without_a_helper_and_by_the_helper_with_one() {
    let h = harness(&[], 4).await;
    let on_disk = |forget: ForgetRoot| async move { Ok(Forgot { removed: vec![format!("disk {}", forget.root.display())], kept: Vec::new() }) };
    let forgot = within(h.host.forget_root(ForgetRoot { root: PathBuf::from("/gone") }, on_disk)).await.unwrap();
    assert_eq!(forgot.removed, ["disk /gone"]);
    assert_eq!(h.events.count(spawned), 0);
    ask(&h, json!({})).await.unwrap();
    let refused = |_: ForgetRoot| async { Err("the disk routine runs only without a helper".to_owned()) };
    let forgot = within(h.host.forget_root(ForgetRoot { root: PathBuf::from("/live") }, refused)).await.unwrap();
    assert_eq!(forgot.removed, ["/live"]);
    h.events.assert_settled_once();
}

#[tokio::test]
async fn a_background_prewarm_never_starts_a_helper() {
    let h = harness(&[], 4).await;
    let prewarm = || Prewarm { cwd: PathBuf::from("/fixture") };
    let never = CancellationToken::new();
    assert_eq!(within(h.host.prewarm(prewarm(), Start::IfRunning, &never)).await, Err(HostError::NotRunning));
    assert_eq!(h.events.count(spawned), 0);
    ask(&h, json!({})).await.unwrap();
    assert_eq!(within(h.host.prewarm(prewarm(), Start::IfRunning, &never)).await, Ok(Warmed { built: true }));
    assert_eq!(h.events.count(spawned), 1);
}

#[tokio::test]
async fn a_removal_the_cancelled_generation_had_not_answered_is_finished_on_the_disk_before_the_next_start() {
    let h = harness(&["--hold-forget"], 4).await;
    let cancel = CancellationToken::new();
    let first = spawn_query(&h, json!({ "do": "block" }), cancel.clone());
    let _query = within(h.barrier.entered()).await;
    let (started, on_disk) = oneshot::channel();
    let (release, released) = oneshot::channel();
    let removal = spawn_forget_on_disk(&h, Some(started), Some(released));
    let forget = within(h.barrier.entered()).await;
    assert_eq!(forget.point, "forget");
    cancel.cancel();
    assert_eq!(within(first).await.unwrap(), Err(HostError::Cancelled));
    assert_eq!(within(on_disk).await.unwrap(), 1);
    assert_eq!(h.events.count(reaped(1)), 1);
    // The disk routine holds the gate: a call arriving now waits for it.
    let next = spawn_query(&h, json!({}), CancellationToken::new());
    let status = within(h.host.wait_status(|status| status.queued == 1)).await;
    assert_eq!((status.state, h.events.count(spawned)), (HostState::Absent, 1));
    release.send(()).unwrap();
    assert_eq!(within(removal).await.unwrap().unwrap().removed, ["disk /live after 1 spawns"]);
    assert_eq!(pid_of(&within(next).await.unwrap().unwrap()), h.events.spawned_pid(2));
    h.events.assert_settled_once();
}

#[tokio::test]
async fn a_removal_a_crashed_helper_had_not_answered_is_finished_on_the_disk() {
    let h = harness(&["--hold-forget"], 4).await;
    ask(&h, json!({})).await.unwrap();
    let removal = spawn_forget_on_disk(&h, None, None);
    let forget = within(h.barrier.entered()).await;
    assert_eq!(forget.point, "forget");
    let error = ask(&h, json!({ "do": "crash" })).await.unwrap_err();
    assert!(matches!(error, HostError::Transport(_)), "{error:?}");
    assert_eq!(within(removal).await.unwrap().unwrap().removed, ["disk /live after 1 spawns"]);
    assert_eq!(pid_of(&ask(&h, json!({})).await.unwrap()), h.events.spawned_pid(2));
    h.events.assert_settled_once();
}

#[tokio::test]
async fn a_removal_answered_before_its_idle_helper_exits_is_the_helpers_answer() {
    let h = harness(&["--hold-forget", "--hold-drain"], 4).await;
    ask(&h, json!({})).await.unwrap();
    within(h.events.until(1, idle_armed(1))).await;
    let removal = spawn_forget(&h, "/live");
    let forget = within(h.barrier.entered()).await;
    assert_eq!(forget.point, "forget");
    h.clock.advance(IDLE);
    within(h.events.until(1, draining(1))).await;
    forget.release().await;
    assert_eq!(within(removal).await.unwrap().unwrap().removed, ["/live"]);
    let drain = within(h.barrier.entered()).await;
    assert_eq!((drain.point.as_str(), h.host.status().state), ("drain", HostState::Retiring));
    drain.release().await;
    within(h.host.wait_status(|status| status.state == HostState::Absent)).await;
    assert_eq!(h.events.count(killed), 0);
    h.events.assert_settled_once();
}

#[tokio::test]
async fn a_removal_answered_as_its_idle_helper_exits_is_not_failed_by_the_exit() {
    let h = harness(&["--hold-forget"], 4).await;
    ask(&h, json!({})).await.unwrap();
    within(h.events.until(1, idle_armed(1))).await;
    let removal = spawn_forget(&h, "/live");
    let forget = within(h.barrier.entered()).await;
    assert_eq!(forget.point, "forget");
    h.clock.advance(IDLE);
    within(h.events.until(1, draining(1))).await;
    // The helper's answer waits in the core's reader while the helper drains, exits and is reaped.
    testing::hold_reader();
    forget.release().await;
    within(testing::reader_held()).await;
    within(h.events.until(1, reaped(1))).await;
    assert!(!removal.is_finished());
    assert_eq!(h.host.status().state, HostState::Retiring);
    testing::release_reader();
    assert_eq!(within(removal).await.unwrap().unwrap().removed, ["/live"]);
    within(h.host.wait_status(|status| status.state == HostState::Absent)).await;
    assert_eq!(h.events.count(killed), 0);
    h.events.assert_settled_once();
}

#[tokio::test]
async fn a_startup_whose_last_caller_withdraws_is_killed() {
    let h = harness(&["--hold-ready"], 4).await;
    let cancel = CancellationToken::new();
    let call = spawn_query(&h, json!({}), cancel.clone());
    let _ready = within(h.barrier.entered()).await;
    assert_eq!(h.host.status().state, HostState::Starting);
    cancel.cancel();
    assert_eq!(within(call).await.unwrap(), Err(HostError::Cancelled));
    within(h.host.wait_status(|status| status.state == HostState::Absent)).await;
    assert_eq!(h.events.count(|event| matches!(event, HostEvent::Killed { generation: 1, why: KillReason::Cancelled, .. })), 1);
    assert_eq!(h.events.count(reaped(1)), 1);
    h.events.assert_settled_once();
}
