//! `resumeSession`'s `_refreshResumedTools` (`SessionDeps.resumed_tools`): a stored thread opened
//! for use writes its refreshed tool surface asynchronously after open completes; a new thread does not ask.

use std::sync::Arc;
use std::sync::Mutex;
use std::sync::atomic::AtomicBool;
use std::sync::atomic::AtomicUsize;
use std::sync::atomic::Ordering;
use std::time::Duration;

use async_trait::async_trait;
use mixdog_core_api::ThreadHandle;
use mixdog_core_api::call::CallContext;
use mixdog_core_api::call::CoreRequest;
use mixdog_core_api::ids::Method;
use mixdog_core_api::ids::ThreadId;
use mixdog_store::schema::record::Header;
use mixdog_store::schema::record::HeaderChange;
use serde_json::json;
use tokio::sync::Notify;

use super::ResumedTools;
use super::SessionDirectory;
use super::seams::RunOutcome;
use super::testing::Rig;
use super::testing::lock;
use super::tests::start_thread;
use super::tests::turn;
use crate::eventually_on;

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_stored_thread_opened_for_use_takes_its_refreshed_tools() {
    let rig = Rig::new();
    let first = SessionDirectory::new(rig.deps());
    let created = start_thread(&first).await;
    let id = created.id.clone();
    assert!(lock(&rig.resumed.asked).is_empty(), "a new thread builds its own surface");
    first.shutdown().await;

    let refreshed = json!({ "toolSpec": "mcp", "tools": [{ "name": "read" }] });
    *lock(&rig.resumed.change) =
        Some(HeaderChange { set: refreshed.as_object().unwrap().clone(), unset: vec!["toolExposureMode".into()], patch: Default::default() });
    let second = SessionDirectory::new(rig.deps());
    let opened = second.open_handle(&id, &CallContext::internal("test")).await.expect("open");
    eventually_on!(&[&opened.cell.stepped], || (opened.cell.header.load().get("toolSpec") == Some(&json!("mcp"))).then_some(())).await;
    assert_eq!(*lock(&rig.resumed.asked), [id.as_str().to_owned()]);
    assert_eq!(opened.cell.header.load().get("tools"), Some(&json!([{ "name": "read" }])));
    second.shutdown().await;
}

struct GatedResumedTools {
    entered: Arc<Notify>,
    gate: Arc<Notify>,
    calls: Arc<AtomicUsize>,
    dropped: Arc<AtomicBool>,
    drop_log: Option<Arc<Mutex<Vec<String>>>>,
    change: HeaderChange,
}

impl GatedResumedTools {
    fn new(change: HeaderChange) -> Self {
        Self {
            entered: Arc::new(Notify::new()),
            gate: Arc::new(Notify::new()),
            calls: Arc::new(AtomicUsize::new(0)),
            dropped: Arc::new(AtomicBool::new(false)),
            drop_log: None,
            change,
        }
    }
}

struct DropMark {
    dropped: Arc<AtomicBool>,
    log: Option<Arc<Mutex<Vec<String>>>>,
}

impl Drop for DropMark {
    fn drop(&mut self) {
        self.dropped.store(true, Ordering::SeqCst);
        if let Some(log) = &self.log {
            lock(log).push("refreshed-dropped".to_owned());
        }
    }
}

#[async_trait]
impl ResumedTools for GatedResumedTools {
    async fn refreshed(&self, _id: &ThreadId, _header: &Header) -> Option<HeaderChange> {
        let _mark = DropMark { dropped: self.dropped.clone(), log: self.drop_log.clone() };
        self.calls.fetch_add(1, Ordering::SeqCst);
        self.entered.notify_one();
        self.gate.notified().await;
        Some(self.change.clone())
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn cold_open_does_not_block_on_slow_resumed_tools_refresh() {
    let rig = Rig::new();
    let first = SessionDirectory::new(rig.deps());
    let created = start_thread(&first).await;
    let id = created.id.clone();
    first.shutdown().await;

    let refreshed = json!({ "toolSpec": "mcp-async" });
    let gated = Arc::new(GatedResumedTools::new(HeaderChange { set: refreshed.as_object().unwrap().clone(), unset: Vec::new(), patch: Default::default() }));
    let mut deps = rig.deps_parts(rig.store.clone());
    deps.resumed_tools = gated.clone();
    let second = SessionDirectory::new(Arc::new(deps));
    let opened = mixdog_rt::time::timeout(Duration::from_secs(5), second.open_handle(&id, &CallContext::internal("test")))
        .await
        .expect("cold open must not wait for resumed_tools refresh")
        .expect("open");
    assert_ne!(opened.cell.header.load().get("toolSpec"), Some(&json!("mcp-async")));

    gated.gate.notify_one();
    eventually_on!(&[&opened.cell.stepped], || (opened.cell.header.load().get("toolSpec") == Some(&json!("mcp-async"))).then_some(())).await;
    second.shutdown().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn immediate_turn_start_after_cold_open_waits_for_resumed_tools_refresh() {
    let rig = Rig::new();
    let first = SessionDirectory::new(rig.deps());
    let created = start_thread(&first).await;
    let id = created.id.clone();
    created
        .request(CoreRequest {
            method: Method("thread/header/patch"),
            params: json!({
                "threadId": id.as_str(),
                "set": { "disallowedTools": ["legacy"] },
                "unset": [],
            }),
            op: None,
            ctx: CallContext::internal("test"),
        })
        .await
        .expect("seed header");
    first.shutdown().await;

    let seen_header: Arc<Mutex<Option<Header>>> = Arc::new(Mutex::new(None));
    let run_started = Arc::new(Notify::new());
    let seen_for_run = seen_header.clone();
    let started_for_run = run_started.clone();
    rig.set_script(Arc::new(move |run| {
        let seen = seen_for_run.clone();
        let started = started_for_run.clone();
        Box::pin(async move {
            *lock(&seen) = Some(run.header.clone());
            started.notify_one();
            run.port.input_durable().await.expect("input durable");
            RunOutcome::Completed(Default::default())
        })
    }));

    let refreshed = json!({
        "mcpScopeId": "scope-refreshed",
        "toolSpec": "mcp-refreshed",
        "tools": [{ "name": "read" }],
    });
    let gated = Arc::new(GatedResumedTools::new(HeaderChange {
        set: refreshed.as_object().unwrap().clone(),
        unset: vec!["disallowedTools".into()],
        patch: Default::default(),
    }));
    let mut deps = rig.deps_parts(rig.store.clone());
    deps.resumed_tools = gated.clone();
    let second = SessionDirectory::new(Arc::new(deps));
    let opened = second.open_handle(&id, &CallContext::internal("test")).await.expect("open");

    let handle_for_turn = opened.clone();
    let turn_task = tokio::spawn(async move { turn(&handle_for_turn, "hello", "op-turn-1").await });

    mixdog_rt::time::timeout(Duration::from_secs(5), gated.entered.notified()).await.expect("refresh entered");
    assert!(
        mixdog_rt::time::timeout(Duration::from_millis(80), run_started.notified()).await.is_err(),
        "turn/start must wait for in-flight resumed_tools refresh before running"
    );

    gated.gate.notify_one();
    mixdog_rt::time::timeout(Duration::from_secs(5), turn_task).await.expect("turn finished").expect("turn join");
    mixdog_rt::time::timeout(Duration::from_secs(5), run_started.notified()).await.expect("run started");

    let header = lock(&seen_header).clone().expect("run captured header");
    assert_eq!(header.get("mcpScopeId"), Some(&json!("scope-refreshed")));
    assert_eq!(header.get("toolSpec"), Some(&json!("mcp-refreshed")));
    assert_eq!(header.get("tools"), Some(&json!([{ "name": "read" }])));
    assert_eq!(header.get("disallowedTools"), None);
    second.shutdown().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn concurrent_header_route_change_is_not_overwritten_by_stale_resumed_tools_refresh() {
    let rig = Rig::new();
    let first = SessionDirectory::new(rig.deps());
    let created = start_thread(&first).await;
    let id = created.id.clone();
    first.shutdown().await;

    let stale = json!({
        "mcpScopeId": "stale-scope",
        "toolSpec": "stale-open-spec",
        "tools": [{ "name": "stale" }],
    });
    let gated = Arc::new(GatedResumedTools::new(HeaderChange { set: stale.as_object().unwrap().clone(), unset: Vec::new(), patch: Default::default() }));
    let mut deps = rig.deps_parts(rig.store.clone());
    deps.resumed_tools = gated.clone();
    let second = SessionDirectory::new(Arc::new(deps));
    let opened = second.open_handle(&id, &CallContext::internal("test")).await.expect("open");

    mixdog_rt::time::timeout(Duration::from_secs(5), gated.entered.notified()).await.expect("refresh entered");

    opened
        .request(CoreRequest {
            method: Method("thread/header/patch"),
            params: json!({
                "threadId": id.as_str(),
                "set": {
                    "provider": "anthropic-oauth",
                    "model": "claude-switched",
                    "toolSpec": "switched-route-spec",
                    "tools": [{ "name": "switched" }],
                },
                "unset": [],
            }),
            op: None,
            ctx: CallContext::internal("route-switch"),
        })
        .await
        .expect("concurrent route patch");

    gated.gate.notify_one();
    mixdog_rt::time::timeout(Duration::from_secs(5), opened.resumed_tools.settled()).await.expect("refresh settled");

    let header = opened.cell.header.load_full();
    assert_eq!(header.get("provider"), Some(&json!("anthropic-oauth")));
    assert_eq!(header.get("model"), Some(&json!("claude-switched")));
    assert_eq!(header.get("toolSpec"), Some(&json!("switched-route-spec")));
    assert_eq!(header.get("tools"), Some(&json!([{ "name": "switched" }])));
    assert_eq!(header.get("mcpScopeId"), None);
    second.shutdown().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn unloading_cold_opened_session_cancels_and_joins_in_flight_resumed_tools_refresh() {
    let rig = Rig::new();
    let first = SessionDirectory::new(rig.deps());
    let created = start_thread(&first).await;
    let id = created.id.clone();
    first.shutdown().await;

    let orphaned = json!({ "toolSpec": "orphaned-after-unload" });
    let mut gated = GatedResumedTools::new(HeaderChange { set: orphaned.as_object().unwrap().clone(), unset: Vec::new(), patch: Default::default() });
    let timeline = Arc::new(Mutex::new(Vec::new()));
    gated.drop_log = Some(timeline.clone());
    let gated = Arc::new(gated);
    let mut deps = rig.deps_parts(rig.store.clone());
    deps.resumed_tools = gated.clone();
    let second = SessionDirectory::new(Arc::new(deps));
    let opened = second.open_handle(&id, &CallContext::internal("test")).await.expect("open");

    mixdog_rt::time::timeout(Duration::from_secs(5), gated.entered.notified()).await.expect("refresh entered");

    // Unload while `refreshed` is still blocked on `gate` (never notified before unload completes).
    opened.inbox.send(super::actor::Inbox::IdleDue).await.expect("send idle due");
    mixdog_rt::time::timeout(Duration::from_secs(5), eventually_on!(&[&opened.cell.stepped, second.left()], || second.handle(&id).is_none().then_some(())))
        .await
        .expect("session unloaded");
    mixdog_rt::time::timeout(Duration::from_secs(5), second.unload_settled(&id)).await.expect("unload settled");

    assert!(gated.dropped.load(Ordering::SeqCst), "in-flight refreshed future must be cancelled and dropped before unload settles");
    assert_eq!(*lock(&timeline), ["refreshed-dropped"]);
    assert_eq!(gated.calls.load(Ordering::SeqCst), 1, "no orphaned refresh call after unload");
    assert_ne!(opened.cell.header.load().get("toolSpec"), Some(&json!("orphaned-after-unload")));

    let release_event = format!("unloadMcpScope:{id}");
    let release_count = lock(&rig.deletes.0).iter().filter(|event| *event == &release_event).count();
    assert!(release_count >= 2, "unload must release runtime/MCP scopes after cancelling an in-flight refresh (events: {:?})", *lock(&rig.deletes.0));

    // Releasing the gate after unload must not trigger any orphaned refresh or header mutation.
    gated.gate.notify_one();
    tokio::task::yield_now().await;
    assert_eq!(gated.calls.load(Ordering::SeqCst), 1);
    second.shutdown().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn resumed_persisted_queue_waits_for_resumed_tools_refresh_before_starting_turn() {
    use mixdog_store::schema::blob::Slot;
    use mixdog_store::schema::bounded::Text;
    use mixdog_store::schema::record::{QueueAction, QueueRecord, Record};

    let rig = Rig::new();
    let first = SessionDirectory::new(rig.deps());
    let created = start_thread(&first).await;
    let id = created.id.clone();
    created
        .request(CoreRequest {
            method: Method("thread/header/patch"),
            params: json!({
                "threadId": id.as_str(),
                "set": { "disallowedTools": ["legacy"] },
                "unset": [],
            }),
            op: None,
            ctx: CallContext::internal("test"),
        })
        .await
        .expect("seed header");
    first.shutdown().await;

    let entry = json!({
        "kind": "prompt",
        "text": "persisted prompt",
        "content": "persisted prompt",
        "enqueuedAt": 1,
        "priority": "next",
    });
    rig.store.append_record(
        &id,
        Record::Queue(QueueRecord {
            qid: Text::try_from("restored-mcp-1").unwrap(),
            action: QueueAction::Enqueue,
            reason: None,
            op: None,
            entry: Some(Slot::Inline(entry)),
        }),
    );

    let seen_header: Arc<Mutex<Option<Header>>> = Arc::new(Mutex::new(None));
    let run_started = Arc::new(Notify::new());
    let seen_for_run = seen_header.clone();
    let started_for_run = run_started.clone();
    rig.set_script(Arc::new(move |run| {
        let seen = seen_for_run.clone();
        let started = started_for_run.clone();
        Box::pin(async move {
            *lock(&seen) = Some(run.header.clone());
            started.notify_one();
            run.port.input_durable().await.expect("input durable");
            RunOutcome::Completed(Default::default())
        })
    }));

    let refreshed = json!({
        "mcpScopeId": "scope-refreshed",
        "toolSpec": "mcp-refreshed",
        "tools": [{ "name": "read" }],
    });
    let gated = Arc::new(GatedResumedTools::new(HeaderChange {
        set: refreshed.as_object().unwrap().clone(),
        unset: vec!["disallowedTools".into()],
        patch: Default::default(),
    }));
    let mut deps = rig.deps_parts(rig.store.clone());
    deps.resumed_tools = gated.clone();
    let second = SessionDirectory::new(Arc::new(deps));

    // Cold open and thread/resume must remain non-blocking even while resumed_tools is slow.
    let opened = mixdog_rt::time::timeout(Duration::from_secs(5), second.open_handle(&id, &CallContext::internal("test")))
        .await
        .expect("cold open must not block on resumed_tools")
        .expect("open");
    mixdog_rt::time::timeout(
        Duration::from_secs(5),
        opened.request(CoreRequest {
            method: Method("thread/resume"),
            params: json!({ "threadId": id.as_str(), "window": { "lastItems": 32 } }),
            op: None,
            ctx: CallContext::internal("test"),
        }),
    )
    .await
    .expect("thread/resume must not block on resumed_tools")
    .expect("resume");

    mixdog_rt::time::timeout(Duration::from_secs(5), gated.entered.notified()).await.expect("refresh entered");
    assert!(
        mixdog_rt::time::timeout(Duration::from_millis(80), run_started.notified()).await.is_err(),
        "persisted queued prompt must wait for resumed_tools refresh before starting a turn"
    );

    gated.gate.notify_one();
    mixdog_rt::time::timeout(Duration::from_secs(5), run_started.notified()).await.expect("queued turn started after refresh");

    let header = lock(&seen_header).clone().expect("run captured header");
    assert_eq!(header.get("mcpScopeId"), Some(&json!("scope-refreshed")));
    assert_eq!(header.get("toolSpec"), Some(&json!("mcp-refreshed")));
    assert_eq!(header.get("tools"), Some(&json!([{ "name": "read" }])));
    assert_eq!(header.get("disallowedTools"), None);
    second.shutdown().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn shutting_down_resumed_persisted_queue_while_refresh_is_blocked_does_not_deadlock() {
    use mixdog_store::schema::blob::Slot;
    use mixdog_store::schema::bounded::Text;
    use mixdog_store::schema::record::{QueueAction, QueueRecord, Record};

    let rig = Rig::new();
    let first = SessionDirectory::new(rig.deps());
    let created = start_thread(&first).await;
    let id = created.id.clone();
    first.shutdown().await;

    let entry = json!({
        "kind": "prompt",
        "text": "persisted prompt",
        "content": "persisted prompt",
        "enqueuedAt": 1,
        "priority": "next",
    });
    rig.store.append_record(
        &id,
        Record::Queue(QueueRecord {
            qid: Text::try_from("restored-shutdown-1").unwrap(),
            action: QueueAction::Enqueue,
            reason: None,
            op: None,
            entry: Some(Slot::Inline(entry)),
        }),
    );

    let runs = Arc::new(AtomicUsize::new(0));
    let runs_for_script = runs.clone();
    rig.set_script(Arc::new(move |_| {
        let runs = runs_for_script.clone();
        Box::pin(async move {
            runs.fetch_add(1, Ordering::SeqCst);
            RunOutcome::Completed(Default::default())
        })
    }));

    let gated = Arc::new(GatedResumedTools::new(HeaderChange {
        set: json!({ "toolSpec": "late" }).as_object().unwrap().clone(),
        unset: Vec::new(),
        patch: Default::default(),
    }));
    let mut deps = rig.deps_parts(rig.store.clone());
    deps.resumed_tools = gated.clone();
    let second = SessionDirectory::new(Arc::new(deps));
    let opened = second.open_handle(&id, &CallContext::internal("test")).await.expect("open");
    opened.cell.deliver(super::control::Ctl::Resumed);
    mixdog_rt::time::timeout(Duration::from_secs(5), gated.entered.notified()).await.expect("refresh entered");

    // Shutdown while the refresh gate is still blocked must cancel cleanly without starting the queued turn.
    mixdog_rt::time::timeout(Duration::from_secs(5), second.shutdown()).await.expect("shutdown must not deadlock");
    assert_eq!(runs.load(Ordering::SeqCst), 0, "queued turn must not start after shutdown cancelled refresh");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn turn_steer_before_resume_waits_for_resumed_tools_refresh_before_starting_turn() {
    use mixdog_core_api::RunControl;
    use mixdog_core_api::ids::OpId;
    use mixdog_store::schema::blob::Slot;
    use mixdog_store::schema::bounded::Text;
    use mixdog_store::schema::record::{QueueAction, QueueRecord, Record};

    let rig = Rig::new();
    let first = SessionDirectory::new(rig.deps());
    let created = start_thread(&first).await;
    let id = created.id.clone();
    created
        .request(CoreRequest {
            method: Method("thread/header/patch"),
            params: json!({
                "threadId": id.as_str(),
                "set": { "disallowedTools": ["legacy"] },
                "unset": [],
            }),
            op: None,
            ctx: CallContext::internal("test"),
        })
        .await
        .expect("seed header");
    first.shutdown().await;

    let entry = json!({
        "kind": "prompt",
        "text": "steered persisted prompt",
        "content": "steered persisted prompt",
        "enqueuedAt": 1,
        "priority": "next",
    });
    rig.store.append_record(
        &id,
        Record::Queue(QueueRecord {
            qid: Text::try_from("restored-steer-1").unwrap(),
            action: QueueAction::Enqueue,
            reason: None,
            op: None,
            entry: Some(Slot::Inline(entry)),
        }),
    );

    let seen_header: Arc<Mutex<Option<Header>>> = Arc::new(Mutex::new(None));
    let run_started = Arc::new(Notify::new());
    let seen_for_run = seen_header.clone();
    let started_for_run = run_started.clone();
    rig.set_script(Arc::new(move |run| {
        let seen = seen_for_run.clone();
        let started = started_for_run.clone();
        Box::pin(async move {
            *lock(&seen) = Some(run.header.clone());
            started.notify_one();
            run.port.input_durable().await.expect("input durable");
            RunOutcome::Completed(Default::default())
        })
    }));

    let refreshed = json!({
        "mcpScopeId": "scope-refreshed",
        "toolSpec": "mcp-refreshed",
        "tools": [{ "name": "read" }],
    });
    let gated = Arc::new(GatedResumedTools::new(HeaderChange {
        set: refreshed.as_object().unwrap().clone(),
        unset: vec!["disallowedTools".into()],
        patch: Default::default(),
    }));
    let mut deps = rig.deps_parts(rig.store.clone());
    deps.resumed_tools = gated.clone();
    let second = SessionDirectory::new(Arc::new(deps));

    // Cold open publishes the handle before any `thread/resume` (`Ctl::Resumed`) arrives.
    let opened = mixdog_rt::time::timeout(Duration::from_secs(5), second.open_handle(&id, &CallContext::internal("test")))
        .await
        .expect("cold open must not block on resumed_tools")
        .expect("open");
    mixdog_rt::time::timeout(Duration::from_secs(5), gated.entered.notified()).await.expect("refresh entered");

    // `turn/steer` (`Ctl::Prioritize`) targeting the restored queued entry before `Ctl::Resumed`
    // must still respect the armed refresh gate instead of starting with stale tools.
    let holds_before = opened.cell.gate_holds.load(Ordering::SeqCst);
    RunControl::steer(opened.as_ref(), None, json!({ "queuedId": "restored-steer-1" }), OpId::from("op-steer-1")).expect("turn/steer accepted");
    mixdog_rt::time::timeout(
        Duration::from_secs(5),
        eventually_on!(&[&opened.cell.stepped], || (opened.cell.gate_holds.load(Ordering::SeqCst) > holds_before).then_some(())),
    )
    .await
    .expect("prioritize hit the refresh gate");
    assert!(
        mixdog_rt::time::timeout(Duration::from_millis(80), run_started.notified()).await.is_err(),
        "Ctl::Prioritize before Ctl::Resumed must wait for resumed_tools refresh"
    );

    gated.gate.notify_one();
    mixdog_rt::time::timeout(Duration::from_secs(5), run_started.notified()).await.expect("prioritized turn started after refresh");

    let header = lock(&seen_header).clone().expect("run captured header");
    assert_eq!(header.get("mcpScopeId"), Some(&json!("scope-refreshed")));
    assert_eq!(header.get("toolSpec"), Some(&json!("mcp-refreshed")));
    assert_eq!(header.get("tools"), Some(&json!([{ "name": "read" }])));
    assert_eq!(header.get("disallowedTools"), None);
    second.shutdown().await;
}
