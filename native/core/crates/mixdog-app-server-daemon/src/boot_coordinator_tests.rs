//! The boot coordinator against `fixtures/boot-recovery/golden.json`, recorded from Node's real
//! `daemon-boot-coordinator.mjs` over the real Goal recovery on a data dir of active, paused and
//! expired Goals. The Rust lane replays the same triggers and must do the same steps in the same
//! order and log the same lines. `keychain` is Node's warm-up of a secret store Rust reads where it
//! is used, so it is the one recorded event with no Rust step.

use std::sync::Arc;
use std::sync::Mutex;

use async_trait::async_trait;
use mixdog_app_server::ClientHook;
use mixdog_core_goal::goal::error::GoalError;
use mixdog_core_goal::goal::js::Goal;
use mixdog_core_goal::goal::error::GoalResult;
use mixdog_core_goal::goal::recovery::RecoverySource;
use mixdog_core_goal::goal::recovery::RecoverySummary;
use mixdog_core_goal::goal::recovery::StoredGoals;
use mixdog_core_goal::goal::recovery::recover_active_goals;
use mixdog_protocol::ConnectionKind;
use serde_json::Value;

use crate::boot_coordinator::BootCoordinator;
use crate::boot_coordinator::BootHook;
use crate::boot_coordinator::BootSteps;

type Trace = Arc<Mutex<Vec<String>>>;

fn push(trace: &Trace, line: impl Into<String>) {
    trace.lock().unwrap().push(line.into());
}

struct Source {
    stored: StoredGoals,
    trace: Trace,
    failing: Vec<String>,
}

#[async_trait]
impl RecoverySource for Source {
    async fn list_active_session_ids(&self) -> GoalResult<Vec<String>> {
        self.stored.list_active_session_ids().await
    }
    async fn read_stored_goal(&self, session_id: &str) -> GoalResult<Option<Goal>> {
        self.stored.read_snapshot(session_id).await
    }
    async fn materialize_session(&self, session_id: &str) -> GoalResult<()> {
        push(&self.trace, format!("materialize {session_id}"));
        if self.failing.iter().any(|id| id == session_id) {
            return Err(GoalError::new("cannot materialize"));
        }
        Ok(())
    }
    fn log(&self, line: &str) {
        push(&self.trace, format!("log {line}"));
    }
}

/// The steps over the real recovery; `recover` and `quota` are the recorded injections of a step
/// that rejects (the real ones cannot).
struct Steps {
    source: Source,
    trace: Trace,
    recover: Option<String>,
    quota: Option<String>,
}

#[async_trait]
impl BootSteps for Steps {
    async fn recover_goals(&self) -> Result<RecoverySummary, String> {
        push(&self.trace, "recover");
        match &self.recover {
            Some(error) => Err(error.clone()),
            None => Ok(recover_active_goals(&self.source).await),
        }
    }

    fn start_quota_resume(&self) -> Result<(), String> {
        push(&self.trace, "quota-start");
        match &self.quota {
            Some(error) => Err(error.clone()),
            None => Ok(()),
        }
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn boot_recovery_runs_as_nodes_coordinator_does() {
    let tokens = mixdog_rt::testing::tokens();
    let golden: Value = serde_json::from_str(include_str!("../../../../fixtures/boot-recovery/golden.json")).expect("golden.json");
    for case in golden["cases"].as_array().expect("cases") {
        let name = case["name"].as_str().expect("name");
        let data = tempfile::tempdir().expect("data dir");
        std::fs::create_dir_all(data.path().join("goals")).expect("goals dir");
        for (id, body) in case["files"].as_object().expect("files") {
            std::fs::write(data.path().join("goals").join(format!("{id}.json")), body.to_string()).expect("goal file");
        }
        let inject = &case["inject"];
        let text = |key: &str| inject[key].as_str().map(str::to_owned);
        let trace: Trace = Arc::default();
        let log_trace = trace.clone();
        let coordinator = BootCoordinator::new(
            Arc::new(Steps {
                source: Source {
                    stored: StoredGoals::new(data.path().to_string_lossy().into_owned(), tokens.durability_io),
                    trace: trace.clone(),
                    failing: inject["materializeFails"]
                        .as_array()
                        .map(|ids| ids.iter().map(|id| id.as_str().expect("id").to_owned()).collect())
                        .unwrap_or_default(),
                },
                trace: trace.clone(),
                recover: text("recover"),
                quota: text("quota"),
            }),
            Arc::new(move |line: &str| push(&log_trace, format!("log {line}"))),
        );
        let hook = BootHook(coordinator.clone());
        for trigger in case["triggers"].as_array().expect("triggers") {
            match trigger["registered"].as_str() {
                Some("desktop") => hook.registered(ConnectionKind::Desktop),
                Some("session") => hook.registered(ConnectionKind::Cli),
                Some(other) => panic!("{name}: unknown client kind {other}"),
                None => hook.desktop_ready(),
            }
            coordinator.settled().await;
        }
        let recorded = |key: &str| -> Vec<String> {
            case[key].as_array().expect(key).iter().map(|line| line.as_str().expect("line").to_owned()).collect()
        };
        // Node's events and logs are two lists in one order each; the trace interleaves them, so split it back.
        let (mut events, mut logs) = (Vec::new(), Vec::new());
        for line in trace.lock().unwrap().iter() {
            match line.strip_prefix("log ") {
                Some(log) => logs.push(log.to_owned()),
                None => events.push(line.clone()),
            }
        }
        let want_events: Vec<String> = recorded("events").into_iter().filter(|event| event != "keychain").collect();
        assert_eq!(events, want_events, "{name}: steps");
        assert_eq!(logs, recorded("logs"), "{name}: log lines");
        let mut left: Vec<String> = std::fs::read_dir(data.path().join("goals"))
            .expect("goals")
            .map(|entry| entry.expect("entry").file_name().to_string_lossy().into_owned())
            .collect();
        left.sort();
        assert_eq!(left, recorded("goalsLeft"), "{name}: Goal files left");
    }
}

/// The steps of the lane, counted.
struct Counting(Trace);

#[async_trait]
impl BootSteps for Counting {
    async fn recover_goals(&self) -> Result<RecoverySummary, String> {
        push(&self.0, "recover");
        Ok(RecoverySummary::default())
    }

    fn start_quota_resume(&self) -> Result<(), String> {
        push(&self.0, "quota-start");
        Ok(())
    }
}

/// One connection of the real app server over the mock core, as the transport would hand it in.
struct Wire {
    handle: mixdog_app_server::ConnectionHandle,
    wire: Arc<mixdog_core_api::mock::MockConnection>,
}

impl Wire {
    fn request(&self, id: i64, method: &str, params: Value) {
        let message = serde_json::from_value(serde_json::json!({ "id": id, "method": method, "params": params })).expect("a request");
        let _ = self.handle.on_message(message);
    }

    fn initialize(&self, kind: &str) {
        self.request(
            0,
            "initialize",
            serde_json::json!({
                "clientInfo": { "name": "test", "version": env!("CARGO_PKG_VERSION"), "kind": kind },
                "capabilities": {},
            }),
        );
    }

    /// Waits until the response of request `id` is written.
    async fn response(&self, id: i64) {
        for _ in 0..5_000 {
            for written in self.wire.drain() {
                let frame: Value = serde_json::from_slice(&written.frame).unwrap_or(Value::Null);
                if frame["id"] == serde_json::json!(id) {
                    assert!(frame.get("result").is_some(), "request {id} failed: {frame}");
                    return;
                }
            }
            pause().await;
        }
        panic!("no response to {id}");
    }
}

async fn pause() {
    tokio::task::yield_now().await;
    tokio::time::sleep(std::time::Duration::from_millis(1)).await;
}

/// Lets the spawned request tasks and the lane run to their end.
async fn quiesce(coordinator: &BootCoordinator) {
    for _ in 0..200 {
        pause().await;
    }
    coordinator.settled().await;
}

/// The real server and `initialize` / `app/subscribe` handling over a mock core, with the real
/// coordinator installed on the real `Outgoing` as the composition root does: the lane starts from
/// the server's own call sites, once, and only at Node's boundaries (a non-desktop client's
/// handshake; a desktop's `desktop.ready`, which is its `app/subscribe`, spec-v2 protocol.md §12.2).
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn the_servers_handshake_and_app_subscribe_start_the_lane_once() {
    use mixdog_core_api::ids::ConnectionId;
    use mixdog_core_api::mock::MockConnection;
    use mixdog_core_api::mock::MockCore;
    use mixdog_core_api::mock::MockLimits;

    mixdog_rt::testing::tokens();
    let app_methods: &'static [&'static str] = Box::leak(
        mixdog_app_protocol::CLIENT_METHODS
            .iter()
            .map(|spec| spec.method)
            .filter(|method| method.starts_with("app/"))
            .collect::<Vec<_>>()
            .into_boxed_slice(),
    );
    let core = Arc::new(MockCore::new(app_methods, MockLimits::default()));
    let outgoing = mixdog_app_server::Outgoing::new();
    let trace: Trace = Arc::default();
    let coordinator = BootCoordinator::new(Arc::new(Counting(trace.clone())), Arc::new(|_: &str| {}));
    assert!(outgoing.set_client_hook(Arc::new(BootHook(coordinator.clone()))).is_ok());
    let server = mixdog_app_server::AppServer::new(
        core,
        outgoing,
        Arc::new(|_| Some(mixdog_protocol::Origin::Local)),
        crate::server::server_config(mixdog_app_protocol::limits::Limits::default()),
    )
    .expect("the default limits are valid");
    let connect = |id: u64| {
        let wire = Arc::new(MockConnection::new(ConnectionId(id), MockLimits::default()));
        Wire { handle: server.open(ConnectionId(id), wire.clone()), wire }
    };
    let events = || trace.lock().unwrap().clone();

    // A desktop's handshake opens nothing.
    let desktop = connect(1);
    desktop.initialize("desktop");
    desktop.response(0).await;
    quiesce(&coordinator).await;
    assert!(events().is_empty(), "a desktop's registration alone: {:?}", events());

    // Its `app/subscribe` is `desktop.ready`: the lane runs, recovery before the quota clock.
    desktop.request(1, "app/subscribe", serde_json::json!({}));
    desktop.response(1).await;
    for _ in 0..5_000 {
        if events().len() == 2 {
            break;
        }
        pause().await;
    }
    quiesce(&coordinator).await;
    assert_eq!(events(), ["recover", "quota-start"]);

    // A non-desktop client's handshake and a second desktop's ready join the lane that began.
    let cli = connect(2);
    cli.initialize("cli");
    cli.response(0).await;
    let other = connect(3);
    other.initialize("desktop");
    other.response(0).await;
    other.request(1, "app/subscribe", serde_json::json!({}));
    other.response(1).await;
    quiesce(&coordinator).await;
    assert_eq!(events(), ["recover", "quota-start"], "once, however many clients arrive");
}

/// A non-desktop client's handshake alone opens the lane (Node's `onClientRegistered`).
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_non_desktop_clients_handshake_starts_the_lane() {
    use mixdog_core_api::ids::ConnectionId;
    use mixdog_core_api::mock::MockConnection;
    use mixdog_core_api::mock::MockCore;
    use mixdog_core_api::mock::MockLimits;

    mixdog_rt::testing::tokens();
    let outgoing = mixdog_app_server::Outgoing::new();
    let trace: Trace = Arc::default();
    let coordinator = BootCoordinator::new(Arc::new(Counting(trace.clone())), Arc::new(|_: &str| {}));
    assert!(outgoing.set_client_hook(Arc::new(BootHook(coordinator.clone()))).is_ok());
    let server = mixdog_app_server::AppServer::new(
        Arc::new(MockCore::new(&[], MockLimits::default())),
        outgoing,
        Arc::new(|_| Some(mixdog_protocol::Origin::Local)),
        crate::server::server_config(mixdog_app_protocol::limits::Limits::default()),
    )
    .expect("the default limits are valid");
    let wire = Arc::new(MockConnection::new(ConnectionId(1), MockLimits::default()));
    let cli = Wire { handle: server.open(ConnectionId(1), wire.clone()), wire };
    cli.initialize("cli");
    cli.response(0).await;
    for _ in 0..5_000 {
        if trace.lock().unwrap().len() == 2 {
            break;
        }
        pause().await;
    }
    quiesce(&coordinator).await;
    assert_eq!(*trace.lock().unwrap(), ["recover", "quota-start"]);
}
