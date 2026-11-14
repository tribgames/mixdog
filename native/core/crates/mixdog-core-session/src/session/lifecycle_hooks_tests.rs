//! When a session fires its user hooks (`lifecycle_hooks.rs`), as Node's session runtime does:
//! `SessionStart` at a runtime's session create with its context stored ahead of the first turn,
//! `StopFailure` for a turn that did not complete, `CwdChanged` for a folder that moved, and
//! `SessionEnd` when the runtime closes.

use std::sync::Arc;
use std::sync::Mutex;

use async_trait::async_trait;
use mixdog_core_api::ids::ThreadId;
use mixdog_store::schema::blob::Slot;
use mixdog_store::schema::record::Header;
use mixdog_store::schema::record::Record;
use serde_json::Value;
use serde_json::json;

use super::SessionDirectory;
use super::lifecycle_hooks::LifecycleHooks;
use super::seams::RunOutcome;
use super::testing::Rig;
use super::testing::lock;
use super::tests::echo;
use super::tests::idle;
use super::tests::start_thread;
use super::tests::turn;
use crate::eventually_on;

/// The hooks fired, in order: `<event>:<thread>:<cwd>[:<detail>]`. `SessionStart` answers `context`.
#[derive(Default)]
struct Fired {
    calls: Mutex<Vec<String>>,
    context: Vec<String>,
    called: tokio::sync::Notify,
}

impl Fired {
    fn note(&self, event: &str, thread: &ThreadId, header: &Header, detail: &str) {
        let cwd = header.get("cwd").and_then(Value::as_str).unwrap_or_default();
        lock(&self.calls).push(format!("{event}:{}:{cwd}{}{detail}", thread.as_str(), if detail.is_empty() { "" } else { ":" }));
        self.called.notify_waiters();
    }

    /// The calls of `event`, without the thread id.
    fn of(&self, event: &str, thread: &ThreadId) -> Vec<String> {
        let lead = format!("{event}:{}:", thread.as_str());
        lock(&self.calls).iter().filter_map(|call| call.strip_prefix(&lead).map(str::to_owned)).collect()
    }
}

#[async_trait]
impl LifecycleHooks for Fired {
    async fn session_start(&self, thread: &ThreadId, header: &Header) -> Vec<String> {
        self.note("SessionStart", thread, header, "");
        self.context.clone()
    }
    async fn stop_failure(&self, thread: &ThreadId, header: &Header, error_type: &str) {
        self.note("StopFailure", thread, header, error_type);
    }
    async fn session_end(&self, thread: &ThreadId, header: &Header, reason: &str) {
        self.note("SessionEnd", thread, header, reason);
    }
    async fn cwd_changed(&self, thread: &ThreadId, header: &Header) {
        self.note("CwdChanged", thread, header, "");
    }
}

fn sessions(rig: &Rig, fired: &Arc<Fired>) -> SessionDirectory {
    let mut deps = rig.deps_parts(rig.store.clone());
    deps.lifecycle = fired.clone();
    SessionDirectory::new(Arc::new(deps))
}

/// The stored message rows of `id`: each body and whether it is displayed.
fn rows(rig: &Rig, id: &ThreadId) -> Vec<(Value, bool)> {
    rig.store
        .records(id)
        .into_iter()
        .filter_map(|(_, record)| match record {
            Record::Item(item) => match item.body {
                Slot::Inline(body) => Some((body, item.visible)),
                _ => None,
            },
            _ => None,
        })
        .collect()
}

/// `dispatchSessionStart`: a `thread/start` fires `SessionStart` once, for the created session in
/// its folder, and the context its handlers add is in the conversation before the first prompt, as
/// a reminder and its ack that are never displayed.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_started_thread_fires_session_start_and_keeps_its_context_ahead_of_the_first_turn() {
    let rig = Rig::new();
    rig.set_script(echo());
    let fired = Arc::new(Fired { context: vec!["use the staging database".to_owned(), "be brief".to_owned()], ..Fired::default() });
    let directory = sessions(&rig, &fired);
    let handle = start_thread(&directory).await;
    assert_eq!(fired.of("SessionStart", &handle.id), ["/ws"]);
    let stored = rows(&rig, &handle.id);
    assert_eq!(
        stored,
        [
            (json!({ "role": "user", "content": "<system-reminder>\n# SessionStart Hook Context\nuse the staging database\n\nbe brief\n</system-reminder>" }), false),
            (json!({ "role": "assistant", "content": ".", "meta": { "source": "context-ack" } }), false),
        ]
    );
    turn(&handle, "hello", "op-1").await;
    eventually_on!(&[&handle.cell.stepped], || (idle(&handle) && rows(&rig, &handle.id).len() == 4).then_some(())).await;
    assert_eq!(rows(&rig, &handle.id)[..2], stored[..], "the context stays ahead of the first prompt");
    assert_eq!(fired.of("SessionStart", &handle.id).len(), 1, "a turn starts no session");
}

/// A session whose `SessionStart` handlers add nothing stores nothing.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_session_start_with_no_context_stores_no_row() {
    let rig = Rig::new();
    let fired = Arc::new(Fired::default());
    let directory = sessions(&rig, &fired);
    let handle = start_thread(&directory).await;
    assert_eq!(fired.of("SessionStart", &handle.id), ["/ws"]);
    assert!(rows(&rig, &handle.id).is_empty());
}

/// `reportTurnError`: a failed turn fires `StopFailure` with its message's class, a stopped one
/// with `unknown`; a completed turn fires none.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_turn_that_does_not_complete_fires_stop_failure_with_its_class() {
    let rig = Rig::new();
    rig.set_script(Arc::new(|run| {
        Box::pin(async move {
            run.port.input_durable().await.expect("input durable");
            let text = match &run.input.prompt {
                mixdog_protocol::PromptContent::Text(text) => text.clone(),
                mixdog_protocol::PromptContent::Parts(_) => String::new(),
            };
            match text.as_str() {
                "fine" => RunOutcome::Completed(Default::default()),
                "stop" => RunOutcome::Interrupted,
                message => RunOutcome::Failed(mixdog_protocol::TurnError { message: message.to_owned(), data: json!({}), provider_error: None }),
            }
        })
    }));
    let fired = Arc::new(Fired::default());
    let directory = sessions(&rig, &fired);
    let handle = start_thread(&directory).await;
    for (n, prompt) in ["fine", "HTTP 429 Too Many Requests", "stop", "the model context is unreadable"].into_iter().enumerate() {
        turn(&handle, prompt, &format!("op-{n}")).await;
        eventually_on!(&[&handle.cell.stepped], || idle(&handle).then_some(())).await;
    }
    eventually_on!(&[&fired.called], || (fired.of("StopFailure", &handle.id).len() == 3).then_some(())).await;
    assert_eq!(fired.of("StopFailure", &handle.id), ["/ws:rate_limit", "/ws:unknown", "/ws:unknown"]);
}

/// `applyResolvedCwd`: only a folder that really moved fires `CwdChanged`.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn only_a_moved_folder_fires_cwd_changed() {
    let rig = Rig::new();
    rig.set_script(echo());
    let fired = Arc::new(Fired::default());
    let directory = sessions(&rig, &fired);
    let handle = start_thread(&directory).await;
    handle.cwd_applied(false).expect("applied");
    handle.cwd_applied(true).expect("applied");
    handle.cwd_applied(false).expect("applied");
    // A turn after the applies: the control lane took them first.
    turn(&handle, "one", "op-1").await;
    eventually_on!(&[&handle.cell.stepped], || idle(&handle).then_some(())).await;
    eventually_on!(&[&fired.called], || (!fired.of("CwdChanged", &handle.id).is_empty()).then_some(())).await;
    assert_eq!(fired.of("CwdChanged", &handle.id), ["/ws"]);
}

/// `dispatchSessionEnd`: an unloading runtime ends its session with `other`, before its memory
/// ingest; the core's shutdown ends every loaded one with `exit`.
#[tokio::test(start_paused = true)]
async fn a_closing_runtime_fires_session_end_with_nodes_reason() {
    let rig = Rig::new();
    rig.set_script(echo());
    let fired = Arc::new(Fired::default());
    let directory = sessions(&rig, &fired);
    let unloaded = start_thread(&directory).await;
    turn(&unloaded, "hello", "op-1").await;
    eventually_on!(&[&unloaded.cell.stepped], || idle(&unloaded).then_some(())).await;
    assert!(unloaded.cell.subscribing());
    unloaded.cell.subscribed(true);
    assert!(fired.of("SessionEnd", &unloaded.id).is_empty(), "a loaded session has not ended");
    super::tests::left_idle(&unloaded).await;
    eventually_on!(&[&*rig.closes.ended], || (lock(&rig.closes.seen).len() == 1).then_some(())).await;
    assert_eq!(fired.of("SessionEnd", &unloaded.id), ["/ws:other"], "fired before the ingest ended");

    let rig = Rig::new();
    rig.set_script(echo());
    let fired = Arc::new(Fired::default());
    let directory = sessions(&rig, &fired);
    let live = start_thread(&directory).await;
    turn(&live, "hello", "op-1").await;
    eventually_on!(&[&live.cell.stepped], || idle(&live).then_some(())).await;
    directory.shutdown().await;
    assert_eq!(fired.of("SessionEnd", &live.id), ["/ws:exit"]);
}

/// The exit's `SessionEnd` is the runtime's own session's (`dispatchSessionEnd` in `close(reason)`): a worker session
/// the exit's `agentTool.closeAll` detaches ends none, and its shutdown is not held for a hook.
#[tokio::test(start_paused = true)]
async fn a_worker_session_fires_no_session_end_at_the_core_exit() {
    let rig = Rig::new();
    rig.set_script(echo());
    let fired = Arc::new(Fired::default());
    let directory = sessions(&rig, &fired);
    let header = json!({ "owner": "agent", "agent": "worker" }).as_object().cloned().expect("header");
    let id = ThreadId::from("sess_worker");
    directory.create_with_id(id.clone(), header, json!({})).await.expect("worker");
    directory.open_handle(&id, &mixdog_core_api::call::CallContext::internal("test")).await.expect("open");
    directory.shutdown().await;
    assert!(fired.of("SessionEnd", &id).is_empty(), "a worker's close fires no SessionEnd");
}
