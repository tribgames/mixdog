//! The lifecycle of the sessions' MCP scopes (`scope_runtime.rs`) against real stdio servers
//! (`mock/server.rs`): a scope released while an operation on it is in flight stays released, a
//! second opener never sees a half-opened scope, operations on a scope run one at a time in
//! arrival order, and a newer full connect voids what was requested before it. Every interleaving
//! is made by gates in the configuration resolver: the test lets an operation go when the others
//! have arrived, never after a delay.

use std::collections::VecDeque;
use std::sync::Arc;
use std::sync::Mutex;

use async_trait::async_trait;
use mixdog_mcp::McpHub;
use mixdog_mcp::McpIo;
use mixdog_mcp::McpServer;
use mixdog_mcp::McpServerConfig;
use mixdog_mcp::hub::ScopeReleased;
use mixdog_mcp::mcp_glue::StatusInput;
use mixdog_mcp::mcp_glue::record_scope_failure;
use mixdog_mcp::mcp_glue::status_value;
use mixdog_mcp::mcp_logins::LoginBackend;
use mixdog_mcp::mcp_logins::McpLogins;
use mixdog_mcp::mcp_logins::Started;
use mixdog_mcp::oauth::account::AccountMode;
use mixdog_mcp::plugin_servers::Catalog;
use mixdog_mcp::result::OutputPolicy;
use mixdog_mcp::scope_runtime::Op;
use mixdog_mcp::scope_runtime::Resolved;
use mixdog_mcp::scope_runtime::ScopeConfigs;
use mixdog_mcp::scope_runtime::ScopeRuntime;
use mixdog_mcp::scope_runtime::request_scope;
use mixdog_mcp::scope_runtime::with_request_scope;
use mixdog_mcp::server::ServerState;
use serde_json::json;
use tokio::sync::oneshot;

const MOCK: &str = env!("CARGO_BIN_EXE_mixdog-mcp-mock-server");

fn io() -> McpIo {
    let tokens = mixdog_rt::testing::tokens();
    McpIo { spawn: tokens.spawn_io, durability: tokens.durability_io }
}

fn config(name: &str) -> McpServerConfig {
    McpServerConfig::from_entry(name, &json!({"command": MOCK}), &std::env::vars().collect()).unwrap()
}

fn lock<T>(mutex: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(|e| e.into_inner())
}

type Gate = (oneshot::Sender<()>, oneshot::Receiver<()>);

/// What the scopes are configured to run, and where a resolve can be held.
#[derive(Default)]
struct Configs {
    configs: Mutex<Vec<McpServerConfig>>,
    gates: Mutex<VecDeque<Gate>>,
    resolves: Mutex<usize>,
    /// The next resolve that was let on panics.
    panic_next: std::sync::atomic::AtomicBool,
}

impl Configs {
    fn set(&self, names: &[&str]) {
        *lock(&self.configs) = names.iter().map(|name| config(name)).collect();
    }

    /// The next resolve stops at a gate: the first half fires when it got there, the second lets it on.
    fn arm(&self) -> (oneshot::Receiver<()>, oneshot::Sender<()>) {
        let (entered_tx, entered_rx) = oneshot::channel();
        let (go_tx, go_rx) = oneshot::channel();
        lock(&self.gates).push_back((entered_tx, go_rx));
        (entered_rx, go_tx)
    }

    fn resolves(&self) -> usize {
        *lock(&self.resolves)
    }
}

#[async_trait]
impl ScopeConfigs for Configs {
    async fn resolve(&self, _: &str, _: &str, only: Option<&str>) -> Resolved {
        *lock(&self.resolves) += 1;
        // Read before the gate: what a gated resolve answers is stale once the test moves on.
        let snapshot = lock(&self.configs).clone();
        let gate = lock(&self.gates).pop_front();
        if let Some((entered, go)) = gate {
            let _ = entered.send(());
            let _ = go.await;
        }
        if self.panic_next.swap(false, std::sync::atomic::Ordering::SeqCst) {
            panic!("the configuration could not be read");
        }
        Resolved { configs: snapshot, targets: only.map(|name| vec![name.to_owned()]).unwrap_or_default() }
    }
}

struct Rig {
    runtime: Arc<ScopeRuntime>,
    hub: Arc<McpHub>,
    configs: Arc<Configs>,
    _artifacts: tempfile::TempDir,
}

fn rig() -> Rig {
    let artifacts = tempfile::tempdir().unwrap();
    let hub = McpHub::new(io(), artifacts.path().to_path_buf(), OutputPolicy::default());
    let configs = Arc::new(Configs::default());
    let runtime = ScopeRuntime::new(hub.clone(), configs.clone());
    Rig { runtime, hub, configs, _artifacts: artifacts }
}

async fn until(server: &McpServer, wanted: impl Fn(&ServerState) -> bool) {
    let mut rx = server.subscribe();
    rx.wait_for(|state| wanted(state)).await.unwrap();
}

fn ready(state: &ServerState) -> bool {
    matches!(state, ServerState::Ready(_))
}

fn closed(state: &ServerState) -> bool {
    matches!(state, ServerState::Closed)
}

/// A fan-out whose configuration was resolved before the owner closed cannot bring the scope back:
/// the apply finds the scope released, and nothing opens it again, for its owner or any other.
#[tokio::test(flavor = "multi_thread")]
async fn a_fan_out_overtaken_by_a_release_cannot_resurrect_the_scope() {
    let Rig { runtime, hub, configs, .. } = rig();
    configs.set(&["alpha"]);
    runtime.open("s1", "t1", "/w").await.unwrap();
    let alpha = hub.server_in("s1", "alpha").unwrap();
    until(&alpha, ready).await;

    let (entered, go) = configs.arm();
    let fan = runtime.fan_out(&Op::Reconcile);
    assert_eq!(fan.len(), 1);
    entered.await.unwrap();
    runtime.release("t1");
    assert!(hub.is_released("s1") && !hub.has_scope("s1"));
    go.send(()).unwrap();
    for task in fan {
        task.await.unwrap();
    }
    assert!(!hub.has_scope("s1"), "the reconcile resolved `alpha` and found the scope released");
    until(&alpha, closed).await;

    // Released once: a second release finds nothing, and nothing opens the scope again.
    runtime.release("t1");
    assert_eq!(runtime.open("s1", "t1", "/w").await, Err(ScopeReleased));
    assert_eq!(runtime.open("s1", "t2", "/w").await, Err(ScopeReleased), "the scope is gone for every owner");
    let resolves = configs.resolves();
    runtime.run("s1", Op::Reset).await;
    assert_eq!(configs.resolves(), resolves, "an operation on a released scope resolves nothing");
}

/// Node's `disconnectAll({ scopeId })` of the runtime's scope drops its servers and voids what is in
/// flight, and nothing more: the runtime stays readable (`mcpStatus` lists its servers `disconnected`) and
/// a reset connects it again (`connect.mjs:107`, `:142`). Releasing the runtime scope, by its owner or on the
/// hub, does the same here; a session scope released for good stays gone.
#[tokio::test(flavor = "multi_thread")]
async fn the_runtime_scope_stays_readable_after_its_servers_are_dropped() {
    let Rig { runtime, hub, configs, .. } = rig();
    configs.set(&["alpha"]);
    let scope = runtime.open_runtime("/w").await.unwrap();
    let alpha = hub.server_in(&scope, "alpha").unwrap();
    until(&alpha, ready).await;

    runtime.release("runtime");
    until(&alpha, closed).await;
    assert!(hub.servers_in(&scope).is_empty());
    assert!(!hub.is_released(&scope) && runtime.is_open(&scope));
    assert_eq!(runtime.runtime_ready().await.as_deref(), Some(scope.as_str()), "a read with no session still finds it");

    // The hub's own `disconnectAll` is the same, and a reset brings the servers back.
    runtime.run(&scope, Op::Reset).await;
    let again = hub.server_in(&scope, "alpha").unwrap();
    until(&again, ready).await;
    hub.release_scope(&scope).await;
    until(&again, closed).await;
    assert!(!hub.is_released(&scope));
    runtime.run(&scope, Op::Reset).await;
    until(&hub.server_in(&scope, "alpha").unwrap(), ready).await;
    assert_eq!(runtime.open_runtime("/w").await, Ok(scope.clone()), "the owner is not closed");
}
/// An owner that closes while its scope is still opening (a failed create after the seed, a
/// session closed at once) leaves no server behind, and the owner opens nothing afterwards.
#[tokio::test(flavor = "multi_thread")]
async fn an_owner_that_closes_while_its_scope_is_opening_leaves_nothing_behind() {
    let Rig { runtime, hub, configs, .. } = rig();
    configs.set(&["alpha"]);
    let (entered, go) = configs.arm();
    let opening = tokio::spawn({
        let runtime = runtime.clone();
        async move { runtime.open("s1", "t1", "/w").await }
    });
    entered.await.unwrap();
    runtime.release("t1");
    go.send(()).unwrap();
    assert_eq!(opening.await.unwrap(), Err(ScopeReleased), "the opener is told, not handed a dead scope");
    assert!(!hub.has_scope("s1") && hub.is_released("s1"));
    assert_eq!(runtime.open("s2", "t1", "/w").await, Err(ScopeReleased), "a closed owner opens no other scope");
}

/// A second opener of a scope that is still connecting waits for that connect (and so sees every
/// server settled); an operation requested meanwhile queues behind it and resolves its
/// configuration only when its turn comes; a worker sharing the scope does not release it.
#[tokio::test(flavor = "multi_thread")]
async fn a_second_opener_waits_for_the_first_connect_and_an_operation_queues_behind_it() {
    let Rig { runtime, hub, configs, .. } = rig();
    configs.set(&["alpha"]);
    let (entered, go) = configs.arm();
    let first = tokio::spawn({
        let runtime = runtime.clone();
        async move { runtime.open("s1", "lead", "/w").await }
    });
    entered.await.unwrap();
    let second = tokio::spawn({
        let runtime = runtime.clone();
        async move { runtime.open("s1", "worker", "/w").await }
    });
    let queued = tokio::spawn({
        let runtime = runtime.clone();
        async move { runtime.run("s1", Op::Reconcile).await }
    });
    // Everyone has arrived at the readiness barrier (the barrier counts its waiters), and none can pass it.
    let mut waiting = runtime.waiting("s1").expect("the scope is open");
    waiting.wait_for(|count| *count == 3).await.unwrap();
    assert!(!first.is_finished() && !second.is_finished() && !queued.is_finished());
    assert!(runtime.is_open("s1") && hub.servers_in("s1").is_empty(), "no half-opened scope is visible");
    assert_eq!(configs.resolves(), 1, "the queued operation has not resolved anything yet");

    go.send(()).unwrap();
    assert_eq!(first.await.unwrap(), Ok(()));
    assert_eq!(second.await.unwrap(), Ok(()));
    assert!(ready(&hub.server_in("s1", "alpha").unwrap().state()), "an opener returns with the servers settled");
    queued.await.unwrap();
    assert_eq!(configs.resolves(), 2, "the queued operation resolved after the first connect, in its own turn");

    runtime.release("worker");
    assert!(runtime.is_open("s1"), "only the scope's opener releases it");
    runtime.release("lead");
    assert!(!runtime.is_open("s1") && hub.is_released("s1"));
}

/// A full connect requested while an older operation is resolving voids that operation's apply and
/// every operation queued before the full connect; what is applied last is what was configured last.
#[tokio::test(flavor = "multi_thread")]
async fn a_newer_full_connect_voids_the_older_operations_and_the_last_configuration_wins() {
    let Rig { runtime, hub, configs, .. } = rig();
    configs.set(&[]);
    runtime.open("s1", "t1", "/w").await.unwrap();
    assert!(hub.servers_in("s1").is_empty());
    assert_eq!(configs.resolves(), 1);

    // An older full connect is resolving `alpha` (the configuration of the moment) ..
    configs.set(&["alpha"]);
    let (older_entered, older_go) = configs.arm();
    let older = tokio::spawn({
        let runtime = runtime.clone();
        async move { runtime.run("s1", Op::Reset).await }
    });
    older_entered.await.unwrap();
    // .. a reconcile is requested behind it, `alpha` is then switched off, and a newer full connect is requested.
    let reconcile = runtime.fan_out(&Op::Reconcile);
    configs.set(&[]);
    let (newer_entered, newer_go) = configs.arm();
    let newer = runtime.fan_out(&Op::Reset);
    assert_eq!((reconcile.len(), newer.len()), (1, 1));

    older_go.send(()).unwrap();
    older.await.unwrap();
    // The newer connect holds the turn now (the reconcile before it bailed without resolving): the
    // older apply, which would have started `alpha`, was void.
    newer_entered.await.unwrap();
    assert!(hub.servers_in("s1").is_empty(), "the older operation's stale `alpha` was not applied");
    assert_eq!(configs.resolves(), 3, "open, the older connect and the newer connect; the voided reconcile resolved nothing");
    newer_go.send(()).unwrap();
    for task in reconcile.into_iter().chain(newer) {
        task.await.unwrap();
    }
    assert!(hub.servers_in("s1").is_empty());
    assert!(!hub.is_released("s1") && runtime.is_open("s1"), "voiding operations leaves the scope itself open");
}

/// A panic in a scope's first connect settles the readiness barrier and records the failure on the
/// scope, which stays open: both openers are released and succeed (a session's seed is not refused),
/// the scope stays in the fan-out, and a later reconcile connects what the first connect did not.
#[tokio::test(flavor = "multi_thread")]
async fn a_panic_in_the_first_connect_is_recorded_and_a_later_reconcile_recovers() {
    let Rig { runtime, hub, configs, .. } = rig();
    configs.set(&["alpha"]);
    let (entered, go) = configs.arm();
    configs.panic_next.store(true, std::sync::atomic::Ordering::SeqCst);
    let first = tokio::spawn({
        let runtime = runtime.clone();
        async move { runtime.open("s1", "lead", "/w").await }
    });
    entered.await.unwrap();
    let second = tokio::spawn({
        let runtime = runtime.clone();
        async move { runtime.open("s1", "worker", "/w").await }
    });
    // Both are at the barrier when the connect panics.
    let mut waiting = runtime.waiting("s1").expect("the scope is open");
    waiting.wait_for(|count| *count == 2).await.unwrap();
    go.send(()).unwrap();
    assert_eq!(first.await.unwrap(), Ok(()), "the opener is not left waiting, nor refused");
    assert_eq!(second.await.unwrap(), Ok(()));
    assert!(runtime.is_open("s1") && !hub.is_released("s1"), "the scope is kept");
    assert_eq!(runtime.failure_of("s1").as_deref(), Some("the initial MCP connect panicked"), "the failure is recorded");
    assert!(hub.servers_in("s1").is_empty(), "nothing was connected");
    let fan = runtime.fan_out(&Op::Reconcile);
    assert_eq!(fan.len(), 1, "the failed scope is still in the fan-out");
    for task in fan {
        task.await.unwrap();
    }
    assert!(ready(&hub.server_in("s1", "alpha").unwrap().state()), "the reconcile connected the server");
    assert_eq!(runtime.failure_of("s1"), None, "an operation that applied clears the failure");
}

/// A request carries the scope it was resolved to through the work it runs (a thread's own scope is
/// resolved from its header by `McpRuntime::scope_of_request`, a child's from its parent's).
#[tokio::test(flavor = "multi_thread")]
async fn a_request_carries_its_scope_through_the_work_it_runs() {
    let Rig { runtime, hub, configs, .. } = rig();
    configs.set(&["alpha"]);
    runtime.open("s1", "t1", "/w").await.unwrap();
    assert!(runtime.is_open("s1"));
    runtime.release("t1");
    assert!(!runtime.is_open("s1"), "a released scope is no longer open: a thread naming it reads nothing");
    assert_eq!(request_scope(), None);
    let seen = with_request_scope(Some("s2".to_owned()), async { tokio::task::yield_now().await; request_scope() }).await;
    assert_eq!(seen.as_deref(), Some("s2"));
    // No scope is read unless named: the argument-less methods read `global`, which holds nothing.
    assert!(hub.server("alpha").is_none() && hub.tools().is_empty() && !hub.has_scope("global"));
}

/// The runtime scope has the id the hub minted, is opened once and connected (a second caller waits for
/// the first's connect and starts no second connection set), is ready for readers whenever they come,
/// and is no session's: releasing sessions leaves it, and its id never changes.
#[tokio::test(flavor = "multi_thread")]
async fn the_runtime_scope_is_one_stable_connected_scope_that_no_session_takes() {
    let Rig { runtime, hub, configs, .. } = rig();
    configs.set(&["alpha"]);
    assert_eq!(runtime.runtime_ready().await, None, "not started: nothing to read yet");
    let scope = runtime.open_runtime("/w").await.unwrap();
    assert_eq!(scope, hub.runtime_scope());
    assert_eq!(runtime.open_runtime("/w").await.unwrap(), scope, "opened once");
    assert_eq!(configs.resolves(), 1, "the second call started no second connect");
    assert_eq!(hub.servers_in(&scope).len(), 1);
    assert_eq!(runtime.runtime_ready().await.as_deref(), Some(scope.as_str()));
    runtime.open("s1", "t1", "/w").await.unwrap();
    assert_ne!(scope, "s1");
    runtime.release("t1");
    assert_eq!(runtime.runtime_ready().await.as_deref(), Some(scope.as_str()), "a session's close leaves the runtime scope");
    assert!(!hub.is_released(&scope) && ready(&hub.server_in(&scope, "alpha").unwrap().state()));
}
/// Every path a sign-in spawns keeps the scope of the request that began it: the flow's own task and the
/// follow-up it spawns when it completes (`mixdog-rt` does not carry task-locals across a spawn).
#[tokio::test(flavor = "multi_thread")]
async fn a_sign_in_and_its_completion_follow_up_keep_the_request_scope() {
    struct Probe {
        started: Mutex<Vec<Option<String>>>,
        completed: Mutex<Vec<Option<String>>>,
        done: tokio::sync::Notify,
    }
    #[async_trait]
    impl LoginBackend for Probe {
        async fn start(&self, _: &str, _: AccountMode, _: bool) -> Result<Started, String> {
            lock(&self.started).push(request_scope());
            Ok(Started::Connected)
        }
        async fn settle(&self, _: &str, _: AccountMode, _: bool, _: Option<String>) -> (bool, Option<String>) {
            (true, None)
        }
        fn open_browser(&self, _: &str) {}
        async fn completed(&self, _: &str) {
            lock(&self.completed).push(request_scope());
            self.done.notify_one();
        }
    }
    let _ = io();
    let probe = Arc::new(Probe { started: Mutex::default(), completed: Mutex::default(), done: tokio::sync::Notify::new() });
    let logins = McpLogins::new(probe.clone());
    with_request_scope(Some("s1".to_owned()), logins.begin("srv", &json!({}))).await.unwrap();
    probe.done.notified().await;
    assert_eq!(*lock(&probe.started), [Some("s1".to_owned())], "the flow's task addresses the scope that began it");
    assert_eq!(*lock(&probe.completed), [Some("s1".to_owned())], "so does the follow-up it spawns on completion");
}

/// A scope whose first connect did not return carries Node's one generic failure, named `mcp`
/// (`connect.mjs:121-124`), which the status matches by server name (`server-catalog.mjs:159`): an
/// ordinary server that is not connected stays `disconnected`; only a server named `mcp` shows `failed`.
#[test]
fn a_recorded_scope_failure_marks_only_the_server_it_names() {
    let status_of = |recorded: Option<&str>| {
        let catalog = Catalog {
            servers: [("linear", json!({"command": "linear-mcp"})), ("mcp", json!({"command": "mcp-mcp"}))]
                .into_iter()
                .map(|(name, cfg)| (name.to_owned(), cfg))
                .collect(),
            sources: Default::default(),
            entries: Default::default(),
            plugins: Default::default(),
            warnings: Vec::new(),
            adoption: None,
        };
        let mut failures = std::collections::HashMap::new();
        record_scope_failure(&mut failures, recorded.map(str::to_owned));
        let status = status_value(&StatusInput {
            catalog: &catalog,
            live: &Default::default(),
            failures: &failures,
            login_pending: &Default::default(),
            oauth: &Default::default(),
            health: &Default::default(),
            in_use: &Default::default(),
            google_client: false,
        });
        let row = |name: &str| status["servers"].as_array().unwrap().iter().find(|row| row["name"] == name).cloned().unwrap();
        (row("linear"), row("mcp"), status["failedCount"].clone())
    };
    let (linear, generic, failed) = status_of(Some("the initial MCP connect panicked"));
    assert_eq!(linear["status"], "disconnected");
    assert_eq!(linear["error"], json!(null));
    assert_eq!(generic["status"], "failed");
    assert_eq!(generic["error"], "the initial MCP connect panicked");
    assert_eq!(failed, 1);
    let (linear, generic, failed) = status_of(None);
    assert_eq!((linear["status"].clone(), generic["status"].clone(), failed), (json!("disconnected"), json!("disconnected"), json!(0)));
}

/// A control thread that names the runtime scope as its own (it was created in it, and resumes in it) does
/// not become its owner: the daemon keeps the scope, so closing the thread releases nothing and the
/// control thread and a thread-less read share one connection set.
#[tokio::test(flavor = "multi_thread")]
async fn a_control_thread_in_the_runtime_scope_neither_owns_nor_releases_it() {
    let Rig { runtime, hub, configs, .. } = rig();
    configs.set(&["alpha"]);
    // Resumed before the boot connect started: the opener is the control thread, the scope is still the daemon's.
    let scope = hub.runtime_scope().to_owned();
    runtime.open(&scope, "ctl", "/w").await.unwrap();
    assert_eq!(runtime.open_runtime("/w").await.unwrap(), scope);
    assert_eq!(configs.resolves(), 1, "one connection set for the control thread and the daemon");
    runtime.release("ctl");
    assert_eq!(runtime.runtime_ready().await.as_deref(), Some(scope.as_str()), "the control thread's close leaves the scope");
    assert!(!hub.is_released(&scope) && ready(&hub.server_in(&scope, "alpha").unwrap().state()));
}