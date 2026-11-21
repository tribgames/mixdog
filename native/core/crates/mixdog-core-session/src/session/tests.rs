//! Session behavior over the test doubles of `testing`: one scripted run per test, durable
//! state observed through the acked view and the frames the thread feed published.

// Compiled into a test-support build too (its helpers serve mixdog-core-session-replays); its tests run only in the library's own test build.
#![cfg_attr(not(test), allow(dead_code, unused_imports))]

use crate::eventually_on;
use crate::session::route_session::RouteChange;
use std::sync::Arc;
use std::sync::Mutex;
use std::time::Duration;

use mixdog_core_api::CoreError;
use mixdog_core_api::Reply;
use mixdog_core_api::RunControl;
use mixdog_core_api::ThreadDirectory;
use mixdog_core_api::ThreadHandle;
use mixdog_core_api::call::CallContext;
use mixdog_core_api::call::CoreRequest;
use mixdog_core_api::domain::approval::ApprovalAsk;
use mixdog_core_api::domain::approval::ApprovalGate;
use mixdog_core_api::domain::approval::ApprovalKind;
use mixdog_core_api::ids::ConnectionId;
use mixdog_core_api::ids::ItemId;
use mixdog_core_api::ids::Method;
use mixdog_core_api::ids::OpId;
use mixdog_core_api::ids::ThreadId;
use mixdog_core_api::ids::TurnId;
use mixdog_core_api::mock::ServerRequestEvent;
use mixdog_core_api::thread::Decision;
use mixdog_protocol::ApprovalResolution;
use mixdog_protocol::ConnectionKind;
use mixdog_protocol::ThreadItem;
use mixdog_rt::CancellationToken;
use serde_json::Value;
use serde_json::json;

use super::ItemCommit;
use super::SessionDirectory;
use super::SessionHandle;
use super::SteerInput;
use super::run::DrainRequest;
use super::run::DrainStage;
use super::run::Priority;
use super::run::SteerMode;
use super::seams::RunOutcome;
use super::testing::Rig;
use super::testing::Script;
use super::testing::lock;

pub(crate) fn connection() -> CallContext {
    CallContext::connection(ConnectionId(1), mixdog_protocol::Origin::Local, CancellationToken::new())
}

/// A conversation for a session that has none: `inheritFrom` refuses a source with nothing to carry.
async fn give_conversation(handle: &SessionHandle) {
    let messages = json!([{ "role": "user", "content": "hello" }, { "role": "assistant", "content": "hi" }]);
    let append =
        CoreRequest { method: Method("thread/inheritedRows/append"), params: json!({ "messages": messages }), op: None, ctx: CallContext::internal("test") };
    handle.request(append).await.expect("the conversation is appended");
}

pub(crate) fn request(method: &'static str, params: Value, op: &str) -> CoreRequest {
    CoreRequest { method: Method(method), params, op: Some(OpId::from(op)), ctx: connection() }
}

/// A conversation of more records than the durability lane holds (here a lane of 5 against 40 rows) is stored whole and in order, as
/// the heir of an inheritance is (`thread/inheritedRows/append`): the outbox hands records on as acks free the lane.
#[tokio::test(start_paused = true)]
async fn an_inherited_conversation_larger_than_the_lane_is_stored_whole_and_in_order() {
    let rig = Rig::new();
    let mut deps = rig.deps_parts(rig.store.clone());
    deps.limits = super::SessionLimits { window_records: 2, reserve_records: 1, control_lane: 1, ..super::SessionLimits::default() };
    let directory = SessionDirectory::new(Arc::new(deps));
    let handle = start_thread(&directory).await;
    let messages: Vec<Value> = (0..40).map(|n| json!({ "role": if n % 2 == 0 { "user" } else { "assistant" }, "content": format!("m{n}") })).collect();
    let append = CoreRequest {
        method: Method("thread/inheritedRows/append"),
        params: json!({ "messages": messages.clone() }),
        op: None,
        ctx: CallContext::internal("test"),
    };
    handle.request(append).await.expect("the whole conversation is stored");
    let stored: Vec<Value> = directory.model_context(&handle.id).read().await.expect("stored rows").into_iter().map(|(_, message)| message).collect();
    assert_eq!(stored, messages);
}

pub async fn start_thread(directory: &SessionDirectory) -> Arc<SessionHandle> {
    let reply = directory
        .request(request("thread/start", json!({ "opId": "op-start", "kind": "task", "projectPath": "/ws" }), "op-start"))
        .await
        .expect("thread/start");
    let Reply::Subscribe(subscribe) = reply else {
        panic!("thread/start subscribes");
    };
    let id = ThreadId::from(subscribe.result["thread"]["id"].as_str().expect("thread id"));
    directory.handle(&id).expect("loaded")
}

/// The route a Node session always has (`createSessionRuntime` requires a provider and a model), which a quota
/// stop names (`turnFailureRecord`: `quota.provider` is the error's own or the route's) and `scheduleQuotaResumeEntry`
/// requires: a resume is queued only for a session that has one.
pub const ROUTE_PROVIDER: &str = "anthropic-oauth";
pub const ROUTE_MODEL: &str = "m";

/// [`start_thread`] on that route, set before any turn.
pub async fn start_routed_thread(directory: &SessionDirectory) -> Arc<SessionHandle> {
    let handle = start_thread(directory).await;
    let params = json!({ "threadId": handle.id, "set": { "provider": ROUTE_PROVIDER, "model": ROUTE_MODEL }, "unset": [] });
    handle.request(CoreRequest { method: Method("thread/header/patch"), params, op: None, ctx: CallContext::internal("test") }).await.expect("route");
    handle
}

pub async fn turn(handle: &SessionHandle, prompt: &str, op: &str) -> Value {
    let reply =
        handle.request(request("turn/start", json!({ "threadId": handle.id, "opId": op, "input": { "prompt": prompt } }), op)).await.expect("turn/start");
    let Reply::Value(value) = reply else {
        panic!("turn/start answers a value");
    };
    value
}

/// Each run answers its prompt with `re: <prompt>` and completes.
pub fn echo() -> Script {
    Arc::new(|run| {
        Box::pin(async move {
            run.port.input_durable().await.expect("input durable");
            let text = match &run.input.prompt {
                mixdog_protocol::PromptContent::Text(text) => text.clone(),
                mixdog_protocol::PromptContent::Parts(_) => String::new(),
            };
            run.port
                .commit_item(ItemCommit {
                    iid: ItemId::from(format!("a-{}", run.turn)),
                    role: Some("assistant".into()),
                    model: true,
                    visible: true,
                    body: json!({ "text": format!("re: {text}") }),
                    prompt: None,
                })
                .await
                .expect("commit");
            RunOutcome::Completed(Default::default())
        })
    })
}

/// `(role, text)` of the acked view's items.
pub fn rows(handle: &SessionHandle) -> Vec<(&'static str, String)> {
    handle
        .cell
        .view
        .load_full()
        .items
        .iter()
        .map(|item| match item.as_ref() {
            ThreadItem::UserMessage { content, .. } => ("user", serde_json::to_value(content).unwrap()[0]["text"].as_str().unwrap().to_owned()),
            ThreadItem::AgentMessage { text, .. } => ("assistant", serde_json::to_value(text).unwrap().as_str().unwrap().to_owned()),
            _ => ("other", String::new()),
        })
        .collect()
}

pub fn prompt_list(handle: &SessionHandle) -> Vec<String> {
    handle.cell.view.load_full().state.prompt_history_list.clone().unwrap_or_default()
}

pub fn idle(handle: &SessionHandle) -> bool {
    handle.cell.run.load().is_none()
}

/// Idle with its last turn settled: the turn's end is stored. A fork or a person's clear reads the history only then; before it
/// they answer `history changed or has pending writes` (`history_revision`), which an empty `run` alone does not rule out.
pub fn settled_idle(handle: &SessionHandle) -> bool {
    use std::sync::atomic::Ordering::SeqCst;
    idle(handle) && !handle.cell.busy.load(SeqCst) && handle.cell.unacked.load(SeqCst) == 0
}

#[tokio::test(start_paused = true)]
async fn a_turn_publishes_its_rows_in_order_after_they_are_durable() {
    let rig = Rig::new();
    rig.set_script(echo());
    let directory = SessionDirectory::new(rig.deps());
    let handle = start_thread(&directory).await;

    let started = turn(&handle, "write a haiku", "op-1").await;
    assert_eq!(started["kind"], "started");
    eventually_on!(&[&handle.cell.stepped], || (rows(&handle).len() == 2 && idle(&handle)).then_some(())).await;

    assert_eq!(rows(&handle), vec![("user", "write a haiku".to_owned()), ("assistant", "re: write a haiku".to_owned())]);
    // Every published frame describes durable state: the rows are in the log, in order.
    let logged: Vec<String> = rig
        .store
        .records(&handle.id)
        .into_iter()
        .filter_map(|(_, record)| match record {
            mixdog_store::schema::record::Record::Item(item) => Some(item.iid.as_str().to_owned()),
            _ => None,
        })
        .collect();
    assert_eq!(logged.len(), 2);
    let frames = rig.feeds.frames(handle.id.as_str());
    let seqs: Vec<u64> = frames.iter().map(|(seq, ..)| *seq).collect();
    assert_eq!(seqs, (1..=seqs.len() as u64).collect::<Vec<_>>(), "contiguous seqs");
    let completed: Vec<String> = frames
        .iter()
        .filter(|(_, method, _)| method == "item/completed")
        .map(|(_, _, params)| params["item"]["id"].as_str().unwrap_or_default().to_owned())
        .collect();
    assert_eq!(completed, logged);
    assert!(frames.iter().any(|(_, method, _)| method == "turn/completed"));
}

#[tokio::test(start_paused = true)]
async fn an_implicit_approval_session_asks_nobody() {
    let rig = Rig::new();
    let resolved: Arc<Mutex<Option<ApprovalResolution>>> = Arc::default();
    let seen = resolved.clone();
    rig.set_script(Arc::new(move |run| {
        let seen = seen.clone();
        Box::pin(async move {
            run.port.input_durable().await.expect("input durable");
            let resolution = run
                .port
                .request(ApprovalAsk {
                    kind: ApprovalKind::Tool,
                    call_id: None,
                    tool: Some("shell".into()),
                    action_kind: None,
                    reason: Some("shell needs a look".into()),
                    payload: json!({ "name": "shell" }),
                    remember: Vec::new(),
                    expires_after: None,
                })
                .await;
            *lock(&seen) = Some(resolution);
            RunOutcome::Completed(Default::default())
        })
    }));
    let directory = SessionDirectory::new(rig.deps());
    let reply = directory
        .request(request(
            "thread/start",
            json!({
                "opId": "op-start", "kind": "task", "projectPath": "/ws",
                "session": { "toolProfile": "headless", "approvalMode": "implicit" },
            }),
            "op-start",
        ))
        .await
        .expect("thread/start");
    let Reply::Subscribe(started) = reply else { panic!("thread/start subscribes") };
    let id = ThreadId::from(started.result["thread"]["id"].as_str().expect("thread id"));
    let handle = directory.handle(&id).expect("loaded");
    turn(&handle, "clean", "op-1").await;
    let resolution = eventually_on!(&[&handle.cell.stepped], || lock(&resolved).clone()).await;
    assert!(matches!(resolution, ApprovalResolution::Unavailable { .. }), "{resolution:?}");
    eventually_on!(&[&handle.cell.stepped], || idle(&handle).then_some(())).await;
    assert!(rig.sink.events().is_empty(), "no approval request is published");
}

#[tokio::test(start_paused = true)]
async fn the_first_decision_wins_and_one_that_does_not_decode_is_a_denial() {
    let rig = Rig::new();
    let resolved: Arc<Mutex<Option<ApprovalResolution>>> = Arc::default();
    let seen = resolved.clone();
    rig.set_script(Arc::new(move |run| {
        let seen = seen.clone();
        Box::pin(async move {
            run.port.input_durable().await.expect("input durable");
            let resolution = run
                .port
                .request(ApprovalAsk {
                    kind: ApprovalKind::Tool,
                    call_id: None,
                    tool: Some("shell".into()),
                    action_kind: None,
                    reason: None,
                    payload: json!({ "kind": "shell", "tool": "shell", "request": { "target": "rm -rf build" } }),
                    remember: Vec::new(),
                    expires_after: None,
                })
                .await;
            *lock(&seen) = Some(resolution);
            RunOutcome::Completed(Default::default())
        })
    }));
    let directory = SessionDirectory::new(rig.deps());
    let handle = start_thread(&directory).await;
    turn(&handle, "clean", "op-1").await;
    let published = eventually_on!(&[&handle.cell.stepped], || {
        rig.sink.events().into_iter().find_map(|event| match event {
            ServerRequestEvent::Published(request) => Some(request),
            _ => None,
        })
    })
    .await;

    let decide = |connection: u64, result: Value| Decision {
        request: published.id.clone(),
        connection: ConnectionId(connection),
        device: format!("desktop-{connection}"),
        connection_kind: ConnectionKind::Desktop,
        origin: mixdog_protocol::Origin::Local,
        result,
    };
    // Node's `resolve` refuses no answer: `approved: 'yes'` is not `true`, so it is a denial, and it is the first.
    handle.decide(decide(7, json!({ "approved": "yes" }))).expect("routed");
    handle.decide(decide(8, json!({ "approved": true }))).expect("routed");
    handle.decide(decide(9, json!({ "approved": false }))).expect("routed");
    let resolution = eventually_on!(&[&handle.cell.stepped], || lock(&resolved).clone()).await;
    let ApprovalResolution::Decided { decision, device, .. } = resolution else {
        panic!("decided");
    };
    assert!(!decision.approved);
    assert_eq!(device, "desktop-7");
    let rejected: Vec<ConnectionId> = rig
        .sink
        .events()
        .into_iter()
        .filter_map(|event| match event {
            ServerRequestEvent::ResponseRejected(connection, _) => Some(connection),
            _ => None,
        })
        .collect();
    assert!(rejected.is_empty());
    eventually_on!(&[&handle.cell.stepped], || idle(&handle).then_some(())).await;
    let result = handle.cell.view.load_full().state.approvals.clone().and_then(|approvals| approvals.tool_approval_result).expect("result");
    assert_eq!(
        serde_json::to_value(result).unwrap(),
        json!({ "id": crate::session::room_approval::card_id(published.id.as_str()), "approved": false, "device": "desktop-7", "at": 1000 })
    );
}

#[tokio::test(start_paused = true)]
async fn interrupt_is_answered_on_the_control_path_and_ends_the_run() {
    let rig = Rig::new();
    let reason: Arc<Mutex<Option<String>>> = Arc::default();
    let seen = reason.clone();
    rig.set_script(Arc::new(move |run| {
        let seen = seen.clone();
        Box::pin(async move {
            run.cancel.cancelled().await;
            *seen.lock().unwrap() = Some(run.signal.reason());
            RunOutcome::Interrupted
        })
    }));
    let directory = SessionDirectory::new(rig.deps());
    let handle = start_thread(&directory).await;
    let started = turn(&handle, "long job", "op-1").await;
    let turn_id = TurnId::from(started["turnId"].as_str().expect("turn id"));
    // Rewind is idle-only.
    let busy = handle.request(request("thread/rewind", json!({ "threadId": handle.id, "opId": "op-r", "itemId": "any" }), "op-r")).await;
    assert!(matches!(busy, Err(CoreError::PreconditionFailed { .. })), "{busy:?}");

    // No await: the control cell answers synchronously.
    handle.interrupt(&turn_id, None).expect("interrupt");
    assert!(matches!(handle.interrupt(&TurnId::from("other"), None), Err(CoreError::TurnNotActive { .. })));
    eventually_on!(&[&handle.cell.stepped], || idle(&handle).then_some(())).await;
    // `turn/completed` is published once its run record is durable, after the slot clears.
    let completed =
        eventually_on!(&[&rig.feeds.published], || { rig.feeds.frames(handle.id.as_str()).into_iter().find(|(_, method, _)| method == "turn/completed") })
            .await;
    assert_eq!(completed.2["turn"]["status"], "interrupted");
    // The user's stop carries `abortRuntime`'s text with the Stop's reason (`abort.mjs:118`).
    let expected = format!("Session \"{}\" closed: runtime abort (reason=user-cancel)", handle.id.as_str());
    assert_eq!(reason.lock().unwrap().as_deref(), Some(expected.as_str()));
}

/// The real review, told apart by when its seals return: a turn settles after at most
/// `TURN_CLEANUP_SETTLE` of waiting for its seal, which then goes on detached, so a reader waits
/// for the seal's own end and not for the turn's.
struct SealWatch {
    inner: Arc<dyn mixdog_core_api::turn_review::TurnReviewApi>,
    sealed: tokio::sync::Notify,
}

#[async_trait::async_trait]
impl mixdog_core_api::turn_review::TurnReviewApi for SealWatch {
    async fn record_call(&self, a: &str, b: &str, c: &str, d: Vec<mixdog_core_api::turn_review::CallChange>) {
        self.inner.record_call(a, b, c, d).await
    }
    async fn record_tool_changes(&self, a: &str, b: &str, c: Vec<mixdog_core_api::turn_review::CallChange>) {
        self.inner.record_tool_changes(a, b, c).await
    }
    fn take_call_diff(&self, a: &str) -> Option<String> {
        self.inner.take_call_diff(a)
    }
    fn note_change(&self, a: Option<&[String]>) {
        self.inner.note_change(a)
    }
    async fn begin_turn(&self, a: &str, b: &str, c: mixdog_core_api::turn_review::TurnOpen) -> Option<mixdog_core_api::turn_review::TurnToken> {
        self.inner.begin_turn(a, b, c).await
    }
    async fn complete_turn(&self, a: &str, b: Option<&mixdog_core_api::turn_review::TurnToken>) -> bool {
        let done = self.inner.complete_turn(a, b).await;
        self.sealed.notify_one();
        done
    }
    fn begin_agent_review(&self, a: &str, b: &str, c: &str, d: &str) -> Option<Box<dyn mixdog_core_api::turn_review::AgentReview>> {
        self.inner.begin_agent_review(a, b, c, d)
    }
    fn forget_session(&self, a: &str) {
        self.inner.forget_session(a)
    }
    async fn turn_review_diff(&self, a: &str, b: &str, c: mixdog_core_api::turn_review::ReviewRead) -> mixdog_core_api::turn_review::Reply {
        self.inner.turn_review_diff(a, b, c).await
    }
    async fn turn_review_file_patch(&self, a: &str, b: &str, c: &str) -> mixdog_core_api::turn_review::Reply {
        self.inner.turn_review_file_patch(a, b, c).await
    }
    async fn session_review_diff(&self, a: &str, b: &str) -> mixdog_core_api::turn_review::Reply {
        self.inner.session_review_diff(a, b).await
    }
    async fn session_review_file_patch(&self, a: &str, b: &str, c: &str, d: &str) -> mixdog_core_api::turn_review::Reply {
        self.inner.session_review_file_patch(a, b, c, d).await
    }
    async fn revert_turn_review(&self, a: &str, b: &str, c: &str) -> Result<mixdog_core_api::turn_review::Reply, mixdog_core_api::turn_review::ReviewError> {
        self.inner.revert_turn_review(a, b, c).await
    }
    async fn revert_turn_review_file(
        &self,
        a: &str,
        b: &str,
        c: &str,
        d: &str,
    ) -> Result<mixdog_core_api::turn_review::Reply, mixdog_core_api::turn_review::ReviewError> {
        self.inner.revert_turn_review_file(a, b, c, d).await
    }
    async fn turn_changes(
        &self,
        a: &str,
        b: mixdog_core_api::turn_review::ChangesRead,
    ) -> Result<mixdog_core_api::turn_review::Reply, mixdog_core_api::turn_review::ReviewError> {
        self.inner.turn_changes(a, b).await
    }
    async fn revert_turn_changes(
        &self,
        a: &str,
        b: &str,
        c: Option<&str>,
        d: f64,
    ) -> Result<mixdog_core_api::turn_review::Reply, mixdog_core_api::turn_review::ReviewError> {
        self.inner.revert_turn_changes(a, b, c, d).await
    }
    async fn reapply_turn_changes(
        &self,
        a: &str,
        b: &str,
        c: Option<&str>,
        d: f64,
    ) -> Result<mixdog_core_api::turn_review::Reply, mixdog_core_api::turn_review::ReviewError> {
        self.inner.reapply_turn_changes(a, b, c, d).await
    }
    async fn clear_change_history(&self, a: &str) -> Result<mixdog_core_api::turn_review::Reply, mixdog_core_api::turn_review::ReviewError> {
        self.inner.clear_change_history(a).await
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[allow(clippy::disallowed_methods, clippy::disallowed_types, reason = "test setup: a git workspace and the run's file edit")]
async fn a_turn_that_edits_a_file_records_its_change_once_its_seal_returns() {
    use mixdog_core_api::turn_review::ChangesRead;
    use mixdog_core_api::turn_review::TurnReviewApi;
    let rig = Rig::new();
    let ws = tempfile::tempdir().unwrap();
    let root = ws.path().canonicalize().unwrap().to_string_lossy().trim_start_matches(r"\\?\").to_owned();
    assert!(std::process::Command::new("git").args(["init", "-q"]).current_dir(&root).status().unwrap().success());
    std::fs::write(ws.path().join("a.txt"), "one\n").unwrap();
    let checkpoints: Arc<Mutex<Vec<String>>> = Arc::default();
    let seen = checkpoints.clone();
    let cwd = root.clone();
    let mut deps = rig.deps_parts(rig.store.clone());
    let review = Arc::new(SealWatch { inner: deps.turn_review.clone(), sealed: tokio::sync::Notify::new() });
    deps.turn_review = review.clone();
    let deps = Arc::new(deps);
    let tool = review.clone();
    rig.set_script(Arc::new(move |run| {
        let (seen, cwd, tool) = (seen.clone(), cwd.clone(), tool.clone());
        Box::pin(async move {
            use mixdog_core_api::turn_review::{CallChange, ReviewContent};
            run.port.input_durable().await.expect("input durable");
            // The turn's checkpoint is its input row.
            seen.lock().unwrap().push(run.input_item.as_str().to_owned());
            run.review.start(&cwd);
            // The edit tool waits for the baseline, writes, and records its call.
            assert!(run.review.ready().await.is_some(), "a baseline");
            let file = std::path::Path::new(&cwd).join("a.txt");
            std::fs::write(&file, "two\n").unwrap();
            let change = CallChange {
                path: file.to_string_lossy().into_owned(),
                new_path: None,
                before: ReviewContent::Bytes(b"one\n".to_vec().into()),
                after: ReviewContent::Bytes(b"two\n".to_vec().into()),
            };
            tool.record_call("call-1", run.thread.as_str(), &cwd, vec![change]).await;
            RunOutcome::Completed(Box::default())
        })
    }));
    let directory = SessionDirectory::new(deps);
    let handle = start_thread(&directory).await;
    turn(&handle, "edit a.txt", "op-1").await;
    // The baseline and the seal run real Git (a shadow repository), and a settled turn does not
    // mean a sealed one (the seal outlives a turn's two-second wait): the record is readable once
    // the seal itself has returned, which is the event waited for.
    review.sealed.notified().await;
    let checkpoint = checkpoints.lock().unwrap()[0].clone();
    assert!(!checkpoint.is_empty());
    let read = ChangesRead { checkpoint_id: checkpoint, patch: true, file: None };
    let changes = review.turn_changes(handle.id.as_str(), read).await.expect("the turn's change record");
    let text = Value::Object(changes).to_string();
    assert!(text.contains("a.txt") && text.contains("+two"), "{text}");
}

fn drain(stage: DrainStage) -> DrainRequest {
    DrainRequest { stage, max_priority: Priority::Next }
}

/// The ports' header seam: `thread/header/patch` is one durable `meta` record and
/// `thread/header/read` answers the acked header; a connection may do neither.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn the_header_is_patched_and_read_through_the_ports_seam_only() {
    use crate::session::thread_state::SessionThreads;
    use mixdog_core_ports::ports::threads::ThreadState;
    let rig = Rig::new();
    let directory = Arc::new(SessionDirectory::new(rig.deps()));
    let handle = start_thread(&directory).await;
    let threads = SessionThreads::new(directory.clone());
    let mut set = serde_json::Map::new();
    set.insert("pendingRoute".into(), json!({ "provider": "p", "model": "m" }));
    set.insert("title".into(), json!("held"));
    threads.patch_header(&handle.id, set, Vec::new()).await.expect("patch");
    let header = threads.header(&handle.id).await.expect("read");
    assert_eq!(header["pendingRoute"], json!({ "provider": "p", "model": "m" }));
    assert!(rig.store.records(&handle.id).into_iter().any(|(_, record)| matches!(
        record,
        mixdog_store::schema::record::Record::Meta(meta)
            if matches!(&meta.change, mixdog_store::schema::blob::Slot::Inline(c) if c.set.contains_key("pendingRoute"))
    )));
    threads.patch_header(&handle.id, serde_json::Map::new(), vec!["pendingRoute".into()]).await.expect("unset");
    let header = threads.header(&handle.id).await.expect("read");
    assert!(!header.contains_key("pendingRoute"));
    assert_eq!(header["title"], "held");

    for method in ["thread/header/patch", "thread/header/read"] {
        let refused = handle.request(request(method, json!({ "threadId": handle.id, "set": { "x": 1 } }), "op-x")).await;
        assert!(matches!(refused, Err(CoreError::InvalidParams { .. })), "{method}: {refused:?}");
    }
}

/// A header change no note carries (the compaction count of a compaction that shows nothing live: the `session` tool's
/// scheduled one, an agent session's) is in what `thread/read` answers once it is durable, as Node's rows read the live session.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_header_change_no_note_carries_reaches_the_thread_read() {
    let rig = Rig::new();
    // The product's transcript: the summary reads the header's compaction count.
    let mut deps = rig.deps_parts(rig.store.clone());
    deps.transcript = Arc::new(super::transcript::RecordTranscript::new());
    let directory = SessionDirectory::new(Arc::new(deps));
    let handle = start_thread(&directory).await;
    let read = || CoreRequest { method: Method("thread/read"), params: json!({ "threadId": handle.id }), op: None, ctx: CallContext::internal("test") };
    let Reply::Value(before) = handle.request(read()).await.expect("thread/read") else { panic!("thread/read answers a value") };
    assert_eq!(before["thread"]["compactCount"], json!(0));
    let params = json!({ "threadId": handle.id, "set": { "compaction": { "compactCount": 1, "lastStage": "manual" } }, "unset": [] });
    handle.request(CoreRequest { method: Method("thread/header/patch"), params, op: None, ctx: CallContext::internal("test") }).await.expect("patched");
    let Reply::Value(after) = handle.request(read()).await.expect("thread/read") else { panic!("thread/read answers a value") };
    assert_eq!(after["thread"]["compactCount"], json!(1));
}

/// `HeaderUpdates`: an update runs on the thread's actor, on the header as it stands, so
/// concurrent updates and patches neither lose a write nor retry: twenty updates that each add one
/// to a counter they read leave twenty more, beside a patch made in between.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_header_update_is_computed_where_the_header_has_one_writer() {
    use crate::session::thread_state::SessionThreads;
    use mixdog_core_ports::ports::threads::HeaderUpdates;
    use mixdog_core_ports::ports::threads::ThreadState;
    let rig = Rig::new();
    let directory = Arc::new(SessionDirectory::new(rig.deps()));
    let handle = start_thread(&directory).await;
    let threads = Arc::new(SessionThreads::new(directory.clone()));
    let mut set = serde_json::Map::new();
    set.insert("skillCount".into(), json!(1));
    threads.patch_header(&handle.id, set, Vec::new()).await.expect("seed");
    let mut updates = tokio::task::JoinSet::new();
    for _ in 0..20 {
        let (threads, id) = (threads.clone(), handle.id.clone());
        updates.spawn(async move {
            threads
                .update_header(
                    &id,
                    Box::new(|header| {
                        let mut set = serde_json::Map::new();
                        set.insert("skillCount".into(), json!(header["skillCount"].as_u64().expect("count") + 1));
                        mixdog_store::schema::record::HeaderChange { set, unset: Vec::new() }
                    }),
                )
                .await
        });
    }
    let mut other = serde_json::Map::new();
    other.insert("title".into(), json!("held"));
    threads.patch_header(&handle.id, other, Vec::new()).await.expect("patch");
    while let Some(done) = updates.join_next().await {
        done.expect("joined").expect("updated");
    }
    let header = threads.header(&handle.id).await.expect("read");
    assert_eq!(header["skillCount"], json!(21));
    assert_eq!(header["title"], json!("held"));
    // A change that sets and unsets nothing writes nothing.
    let records = rig.store.records(&handle.id).len();
    threads
        .update_header(&handle.id, Box::new(|_| mixdog_store::schema::record::HeaderChange { set: serde_json::Map::new(), unset: Vec::new() }))
        .await
        .expect("empty");
    assert_eq!(rig.store.records(&handle.id).len(), records);
}

/// A panic in a header update fails only its caller (`Failed`), writes nothing and leaves the
/// actor running: the next update is computed and written, and the thread still answers.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_panicking_header_update_fails_only_its_caller() {
    use crate::session::thread_state::SessionThreads;
    use mixdog_core_ports::ports::threads::HeaderUpdates;
    use mixdog_core_ports::ports::threads::ThreadState;
    use mixdog_tools::orch::util::PortError;
    let rig = Rig::new();
    let directory = Arc::new(SessionDirectory::new(rig.deps()));
    let handle = start_thread(&directory).await;
    let threads = SessionThreads::new(directory.clone());
    let records = rig.store.records(&handle.id).len();
    let failed = threads.update_header(&handle.id, Box::new(|_| panic!("update gone wrong"))).await;
    assert!(matches!(failed, Err(PortError::Failed { .. })), "{failed:?}");
    assert_eq!(rig.store.records(&handle.id).len(), records, "nothing was written");
    threads
        .update_header(
            &handle.id,
            Box::new(|_| {
                let mut set = serde_json::Map::new();
                set.insert("skillCount".into(), json!(1));
                mixdog_store::schema::record::HeaderChange { set, unset: Vec::new() }
            }),
        )
        .await
        .expect("the actor serves the next update");
    assert_eq!(threads.header(&handle.id).await.expect("read")["skillCount"], json!(1));
}

pub fn runs_started(rig: &Rig, id: &ThreadId) -> usize {
    use mixdog_store::schema::record::Record;
    use mixdog_store::schema::record::RunPhase;
    rig.store.records(id).into_iter().filter(|(_, record)| matches!(record, Record::Run(run) if run.phase == RunPhase::Started)).count()
}

pub async fn start_with_session(directory: &SessionDirectory, session: Value) -> Arc<SessionHandle> {
    let reply = directory
        .request(request("thread/start", json!({ "opId": "op-start", "kind": "task", "projectPath": "/ws", "session": session }), "op-start"))
        .await
        .expect("thread/start");
    let Reply::Subscribe(started) = reply else { panic!("thread/start subscribes") };
    let id = ThreadId::from(started.result["thread"]["id"].as_str().expect("thread id"));
    directory.handle(&id).expect("loaded")
}

/// A new thread begins with the tool fields its seed gives the header, seeded under the id the
/// thread then has.
#[tokio::test(start_paused = true)]
async fn a_started_thread_begins_with_the_tools_its_seed_wrote() {
    use mixdog_store::schema::record::Header;
    struct Seeds(Mutex<Vec<ThreadId>>);
    #[async_trait::async_trait]
    impl super::NewThreadTools for Seeds {
        async fn seed(&self, thread: &ThreadId, header: &Header) -> Result<Header, String> {
            lock(&self.0).push(thread.clone());
            let mut seeded = header.clone();
            seeded.insert("tools".into(), json!([{ "name": "read" }]));
            Ok(seeded)
        }
    }
    let rig = Rig::new();
    let seeds = Arc::new(Seeds(Mutex::default()));
    let mut deps = rig.deps_parts(rig.store.clone());
    deps.new_tools = seeds.clone();
    let directory = SessionDirectory::new(Arc::new(deps));
    let handle = start_with_session(&directory, json!({ "toolMode": "readonly" })).await;
    assert_eq!(lock(&seeds.0).as_slice(), [handle.id.clone()]);
    let header = handle.cell.header.load_full();
    assert_eq!(header["tools"], json!([{ "name": "read" }]));
    assert_eq!(header["toolSpec"], json!(["tools:readonly"]));
}

/// A session the service creates itself (`create_session`: a bot's task session, Mixy's heartbeat run) is seeded as a
/// started thread is, under the id it then has; a refused seed creates nothing and abandons the id it was given.
#[tokio::test(start_paused = true)]
async fn an_internal_session_begins_with_the_tools_its_seed_wrote() {
    use mixdog_store::schema::record::Header;
    #[derive(Default)]
    struct Seeds {
        refuse: std::sync::atomic::AtomicBool,
        seeded: Mutex<Vec<ThreadId>>,
        abandoned: Mutex<Vec<ThreadId>>,
    }
    #[async_trait::async_trait]
    impl super::NewThreadTools for Seeds {
        async fn seed(&self, thread: &ThreadId, header: &Header) -> Result<Header, String> {
            lock(&self.seeded).push(thread.clone());
            if self.refuse.load(std::sync::atomic::Ordering::SeqCst) {
                return Err("refused".to_owned());
            }
            let mut seeded = header.clone();
            seeded.insert("tools".into(), json!([{ "name": "read" }]));
            Ok(seeded)
        }
        fn abandon(&self, thread: &ThreadId) {
            lock(&self.abandoned).push(thread.clone());
        }
    }
    let rig = Rig::new();
    let seeds = Arc::new(Seeds::default());
    let mut deps = rig.deps_parts(rig.store.clone());
    deps.new_tools = seeds.clone();
    let directory = SessionDirectory::new(Arc::new(deps));
    let id = directory.create_session(Header::new(), json!({})).await.expect("created");
    assert_eq!(lock(&seeds.seeded).as_slice(), [id.clone()]);
    assert_eq!(directory.handle(&id).expect("loaded").cell.header.load_full()["tools"], json!([{ "name": "read" }]));
    assert!(lock(&seeds.abandoned).is_empty(), "a created thread keeps what its seed opened");
    seeds.refuse.store(true, std::sync::atomic::Ordering::SeqCst);
    assert!(directory.create_session(Header::new(), json!({})).await.is_err());
    let refused = lock(&seeds.seeded).last().cloned().expect("seeded");
    assert_eq!(lock(&seeds.abandoned).as_slice(), [refused.clone()]);
    assert!(directory.stored_header(&refused).await.is_none(), "a refused seed creates nothing");
}

/// An imported conversation (`create_imported_session`) begins with the tools of the import's seed, which opens no MCP
/// scope, under the id it then has; it is never given the seed that opens one.
#[tokio::test(start_paused = true)]
async fn an_imported_session_begins_with_the_tools_of_the_imports_seed() {
    use mixdog_store::schema::record::Header;
    struct Seeds(Mutex<Vec<ThreadId>>);
    #[async_trait::async_trait]
    impl super::NewThreadTools for Seeds {
        async fn seed(&self, _: &ThreadId, _: &Header) -> Result<Header, String> {
            Err("the seed that opens a scope".to_owned())
        }
        async fn seed_imported(&self, thread: &ThreadId, header: &Header) -> Result<Header, String> {
            lock(&self.0).push(thread.clone());
            let mut seeded = header.clone();
            seeded.insert("tools".into(), json!([{ "name": "read" }]));
            Ok(seeded)
        }
    }
    let rig = Rig::new();
    let seeds = Arc::new(Seeds(Mutex::default()));
    let mut deps = rig.deps_parts(rig.store.clone());
    deps.new_tools = seeds.clone();
    let directory = SessionDirectory::new(Arc::new(deps));
    let id = directory.create_imported_session(Header::new(), json!({})).await.expect("created");
    assert_eq!(lock(&seeds.0).as_slice(), [id.clone()]);
    assert_eq!(directory.handle(&id).expect("loaded").cell.header.load_full()["tools"], json!([{ "name": "read" }]));
}

/// A thread's runtime boots on the route its header names (Node's `createRuntime({ provider, model })`, a resume's
/// `setRoute(resumedRoute)`): a session created on its creator's route (a task session, a delegated worker) before its
/// tools and prompt are composed, and a stored thread when it is opened for use.
#[tokio::test(start_paused = true)]
async fn a_thread_boots_on_its_headers_route_before_it_is_composed_and_when_it_is_opened() {
    use mixdog_store::schema::record::Header;
    type Steps = Arc<Mutex<Vec<Value>>>;
    struct Route(Steps);
    #[async_trait::async_trait]
    impl super::NewThreadRoute for Route {
        async fn adopt(&self, _: &ThreadId, _: Option<&serde_json::Map<String, Value>>) -> Result<serde_json::Map<String, Value>, String> {
            panic!("no thread is started")
        }
        async fn adopt_control(&self, _: &ThreadId) -> Result<serde_json::Map<String, Value>, String> {
            panic!("no thread is started")
        }
        async fn seat(&self, _: &ThreadId) -> Result<(), String> {
            panic!("no thread is started")
        }
        fn boot(&self, thread: &ThreadId, header: &Header) {
            lock(&self.0).push(json!(["boot", thread, header.get("model")]));
        }
    }
    struct Tools(Steps);
    #[async_trait::async_trait]
    impl super::NewThreadTools for Tools {
        async fn seed(&self, thread: &ThreadId, header: &Header) -> Result<Header, String> {
            lock(&self.0).push(json!(["seed", thread]));
            Ok(header.clone())
        }
        async fn seed_agent(&self, thread: &ThreadId, header: &Header) -> Result<Header, String> {
            lock(&self.0).push(json!(["seedAgent", thread]));
            Ok(header.clone())
        }
    }
    let rig = Rig::new();
    let steps: Steps = Arc::default();
    let directory_over = || {
        let mut deps = rig.deps_parts(rig.store.clone());
        deps.new_route = Arc::new(Route(steps.clone()));
        deps.new_tools = Arc::new(Tools(steps.clone()));
        SessionDirectory::new(Arc::new(deps))
    };
    let directory = directory_over();
    let routed = json!({ "cwd": "/ws", "provider": "custom-harness", "model": "harness-model" }).as_object().cloned().expect("header");
    let task = directory.create_session(routed.clone(), json!({})).await.expect("created");
    let worker = directory.create_agent_session(routed, json!({})).await.expect("created");
    assert_eq!(
        *lock(&steps),
        [json!(["boot", task, "harness-model"]), json!(["seed", task]), json!(["boot", worker, "harness-model"]), json!(["seedAgent", worker])]
    );
    // A restart opens the stored task session for use: its runtime boots on the route its record holds.
    lock(&steps).clear();
    let reopened = directory_over();
    reopened.open_handle(&task, &CallContext::internal("test")).await.expect("open");
    assert_eq!(*lock(&steps), [json!(["boot", task, "harness-model"])]);
}

/// A new thread's route is settled under its future id before its tools are composed, and seated on
/// it once it exists; a draft's route reaches the adoption as `configureDraft` sends it, a start with
/// no draft adopts the default.
#[tokio::test(start_paused = true)]
async fn a_started_thread_adopts_its_route_before_its_tools_and_seats_it_once_created() {
    use mixdog_store::schema::record::Header;
    type Steps = Arc<Mutex<Vec<Value>>>;
    struct Route(Steps);
    #[async_trait::async_trait]
    impl super::NewThreadRoute for Route {
        async fn adopt(&self, thread: &ThreadId, draft: Option<&serde_json::Map<String, Value>>) -> Result<serde_json::Map<String, Value>, String> {
            lock(&self.0).push(json!(["adopt", thread, draft]));
            Ok(json!({ "provider": "custom-harness", "model": "harness-model", "preset": { "name": "Lead" } }).as_object().cloned().expect("route"))
        }
        async fn adopt_control(&self, thread: &ThreadId) -> Result<serde_json::Map<String, Value>, String> {
            lock(&self.0).push(json!(["adoptControl", thread]));
            Ok(serde_json::Map::new())
        }
        async fn seat(&self, thread: &ThreadId) -> Result<(), String> {
            lock(&self.0).push(json!(["seat", thread]));
            Ok(())
        }
    }
    struct Tools(Steps);
    #[async_trait::async_trait]
    impl super::NewThreadTools for Tools {
        async fn seed(&self, thread: &ThreadId, header: &Header) -> Result<Header, String> {
            lock(&self.0).push(json!(["seed", thread]));
            // The seat writes `contextTokens: null` for a route with none; a created record omits it.
            let mut seeded = header.clone();
            seeded.insert("contextTokens".into(), Value::Null);
            Ok(seeded)
        }
    }
    let rig = Rig::new();
    let steps: Steps = Arc::default();
    let mut deps = rig.deps_parts(rig.store.clone());
    deps.new_route = Arc::new(Route(steps.clone()));
    deps.new_tools = Arc::new(Tools(steps.clone()));
    let directory = SessionDirectory::new(Arc::new(deps));
    let started = |reply: Reply| match reply {
        Reply::Subscribe(started) => ThreadId::from(started.result["thread"]["id"].as_str().expect("thread id")),
        Reply::Value(_) => panic!("thread/start subscribes"),
    };
    let draft = json!({ "route": { "provider": "custom-harness", "model": "harness-model", "fast": false } });
    let first = started(
        directory.request(request("thread/start", json!({ "opId": "op-draft", "kind": "task", "draft": draft }), "op-draft")).await.expect("thread/start"),
    );
    let pick = json!({ "provider": "custom-harness", "model": "harness-model", "fast": false });
    assert_eq!(*lock(&steps), [json!(["adopt", first, pick]), json!(["seed", first]), json!(["seat", first])]);
    let header = directory.handle(&first).expect("loaded").cell.header.load_full();
    assert_eq!(
        (header["presetName"].clone(), header["codexWireSessionId"].clone(), header["contextPercent"].clone()),
        (json!("Lead"), Value::Null, Value::Null)
    );
    assert!(!header.contains_key("contextTokens"), "a record without a window omits contextTokens");
    lock(&steps).clear();
    let second = started(directory.request(request("thread/start", json!({ "opId": "op-plain", "kind": "task" }), "op-plain")).await.expect("thread/start"));
    assert_eq!(*lock(&steps), [json!(["adopt", second, Value::Null]), json!(["seed", second]), json!(["seat", second])]);
}

/// `inheritFrom` into a thread that has no session yet (the control session, started before any model was chosen) creates
/// that session first - the route the config now resolves to is readied and seated - and only then looks the source up
/// (Node: `createCurrentSession('inherit')`, then "session ... was not found"); a thread that has its session is left as it is.
#[tokio::test(start_paused = true)]
async fn an_inherit_creates_the_heirs_session_before_the_source_is_looked_up() {
    type Steps = Arc<Mutex<Vec<Value>>>;
    struct Route(Steps);
    #[async_trait::async_trait]
    impl super::NewThreadRoute for Route {
        async fn adopt(&self, thread: &ThreadId, draft: Option<&serde_json::Map<String, Value>>) -> Result<serde_json::Map<String, Value>, String> {
            lock(&self.0).push(json!(["adopt", thread, draft]));
            Ok(serde_json::Map::new())
        }
        async fn adopt_control(&self, _: &ThreadId) -> Result<serde_json::Map<String, Value>, String> {
            panic!("an inherit starts no thread")
        }
        async fn seat(&self, thread: &ThreadId) -> Result<(), String> {
            lock(&self.0).push(json!(["seat", thread]));
            Ok(())
        }
    }
    let rig = Rig::new();
    let steps: Steps = Arc::default();
    let mut deps = rig.deps_parts(rig.store.clone());
    deps.new_route = Arc::new(Route(steps.clone()));
    let directory = SessionDirectory::new(Arc::new(deps));
    let header = |value: Value| value.as_object().cloned().expect("header");
    directory.create_with_id(ThreadId::from("sess_control"), header(json!({ "cwd": "/ws" })), json!({})).await.expect("create");
    directory
        .create_with_id(ThreadId::from("sess_seated"), header(json!({ "cwd": "/ws", "provider": "custom-harness", "model": "harness-model" })), json!({}))
        .await
        .expect("create");
    // A restart reads the same records: what has no session is still without one, and what has one still has it (a 1.4.5
    // record names its model, so it is a session).
    let mut deps = rig.deps_parts(rig.store.clone());
    deps.new_route = Arc::new(Route(steps.clone()));
    let reopened = SessionDirectory::new(Arc::new(deps));
    for (when, directory) in [("before a restart", &directory), ("after a restart", &reopened)] {
        for (heir, expected) in
            [("sess_control", vec![json!(["adopt", "sess_control", Value::Null]), json!(["seat", "sess_control"])]), ("sess_seated", Vec::new())]
        {
            // A request naming no source (empty or whitespace) is refused before the reservation is touched (`inheritFrom`
            // checks the source id first), the same way every time.
            lock(&steps).clear();
            for source in ["", " \t "] {
                let params = json!({ "threadId": source, "intoThreadId": heir, "opId": "op-inherit" });
                let refused = directory.request(request("thread/fork", params, "op-inherit")).await;
                assert!(matches!(refused, Err(CoreError::InvalidParams { .. })), "{when} {heir} source {source:?}: {refused:?}");
                assert!(lock(&steps).is_empty(), "{when} {heir}: a refused request seats nothing");
            }
            lock(&steps).clear();
            let params = json!({ "threadId": "harness-no-such-session", "intoThreadId": heir, "opId": "op-inherit" });
            let refused = directory.request(request("thread/fork", params, "op-inherit")).await;
            assert!(matches!(refused, Err(CoreError::ThreadNotFound { .. })), "{when} {heir}: {refused:?}");
            assert_eq!(*lock(&steps), expected, "{when} {heir}");
        }
    }
}

#[tokio::test(start_paused = true)]
async fn a_refused_carry_keeps_the_heirs_reference_set_and_takes_the_copy_mark_off() {
    let rig = Rig::new();
    let directory = SessionDirectory::new(Arc::new(rig.deps_parts(rig.store.clone())));
    let header = |value: Value| value.as_object().cloned().expect("header");
    for id in ["sess_source", "sess_heir"] {
        directory
            .create_with_id(ThreadId::from(id), header(json!({ "cwd": "/ws", "provider": "custom-harness", "model": "harness-model" })), json!({}))
            .await
            .expect("create");
    }
    let params = json!({ "threadId": "sess_source", "intoThreadId": "sess_heir", "opId": "op-inherit" });
    let refused = directory.request(request("thread/fork", params, "op-inherit")).await;
    assert!(matches!(&refused, Err(CoreError::DomainError { message: Some(message), .. }) if message.contains("no conversation to carry")), "{refused:?}");
    let held = directory.stored_header(&ThreadId::from("sess_heir")).await.expect("heir header");
    assert!(held.get(mixdog_store::offload_sources::INHERITING).is_none() && held.get(mixdog_store::offload_sources::INHERITING_BOOT).is_none(), "{held:?}");
    assert!(mixdog_store::offload_sources::sources(&held).contains(&"sess_source".to_owned()), "the set stays: {held:?}");
}

/// A thread that has no session yet (the control session, started before any model was chosen) gets it from a turn
/// (`createCurrentSession('turn')`), and a route with no model refuses that turn as `prepareRoute` does; a thread that has
/// its session is not seated again.
#[tokio::test(start_paused = true)]
async fn a_turn_creates_the_session_of_a_thread_that_has_none() {
    type Steps = Arc<Mutex<Vec<Value>>>;
    struct Route(Steps, Result<(), String>);
    #[async_trait::async_trait]
    impl super::NewThreadRoute for Route {
        async fn adopt(&self, thread: &ThreadId, _: Option<&serde_json::Map<String, Value>>) -> Result<serde_json::Map<String, Value>, String> {
            lock(&self.0).push(json!(["adopt", thread]));
            self.1.clone().map(|()| serde_json::Map::new())
        }
        async fn adopt_control(&self, _: &ThreadId) -> Result<serde_json::Map<String, Value>, String> {
            panic!("a turn starts no thread")
        }
        async fn seat(&self, thread: &ThreadId) -> Result<(), String> {
            lock(&self.0).push(json!(["seat", thread]));
            Ok(())
        }
    }
    let rig = Rig::new();
    let header = |value: Value| value.as_object().cloned().expect("header");
    async fn turn(directory: &SessionDirectory, id: &str) -> Result<Reply, CoreError> {
        let handle = directory.open_handle(&ThreadId::from(id), &CallContext::internal("test")).await.expect("open");
        handle.request(request("turn/start", json!({ "threadId": id, "opId": "op-turn", "input": { "prompt": "hi" } }), "op-turn")).await
    }
    let steps: Steps = Arc::default();
    let mut deps = rig.deps_parts(rig.store.clone());
    deps.new_route = Arc::new(Route(steps.clone(), Err("No model selected. Choose a model with /model first.".to_owned())));
    let directory = SessionDirectory::new(Arc::new(deps));
    directory.create_with_id(ThreadId::from("sess_control"), header(json!({ "cwd": "/ws" })), json!({})).await.expect("create");
    directory
        .create_with_id(ThreadId::from("sess_seated"), header(json!({ "cwd": "/ws", "provider": "custom-harness", "model": "harness-model" })), json!({}))
        .await
        .expect("create");
    let refused = turn(&directory, "sess_control").await.err().expect("no model, no turn");
    assert!(format!("{refused:?}").contains("No model selected. Choose a model with /model first."), "{refused:?}");
    assert_eq!(*lock(&steps), [json!(["adopt", "sess_control"])], "a refused route is not seated");
    lock(&steps).clear();
    turn(&directory, "sess_seated").await.expect("a thread with its session starts its turn");
    assert!(lock(&steps).is_empty(), "{:?}", lock(&steps));
    let mut deps = rig.deps_parts(rig.store.clone());
    deps.new_route = Arc::new(Route(steps.clone(), Ok(())));
    let directory = SessionDirectory::new(Arc::new(deps));
    turn(&directory, "sess_control").await.expect("the turn starts");
    assert_eq!(*lock(&steps), [json!(["adopt", "sess_control"]), json!(["seat", "sess_control"])]);
}

/// `inheritToNewSession` carries before it persists the heir: a fork asked to compact whose compaction cannot run is
/// refused and leaves no copy of the conversation behind.
#[tokio::test(start_paused = true)]
async fn a_refused_compacting_fork_leaves_no_heir() {
    let rig = Rig::new();
    let directory = SessionDirectory::new(rig.deps());
    let header = json!({ "cwd": "/ws", "provider": "custom-harness", "model": "harness-model" }).as_object().cloned().expect("header");
    let source = ThreadId::from("sess_source");
    directory.create_with_id(source.clone(), header, json!({})).await.expect("create the source");
    let handle = directory.open_handle(&source, &CallContext::internal("test")).await.expect("open");
    let rows = vec![json!({ "role": "user", "content": "work" }), json!({ "role": "assistant", "content": "done" })];
    let append = CoreRequest {
        method: mixdog_core_api::ids::Method("thread/inheritedRows/append"),
        params: json!({ "messages": rows }),
        op: None,
        ctx: CallContext::internal("test"),
    };
    handle.request(append).await.expect("append");
    rig.store.listed.store(true, std::sync::atomic::Ordering::SeqCst);
    *lock(&rig.inherit.budget) = Some(10_000);
    rig.compaction.heir_fails.store(true, std::sync::atomic::Ordering::SeqCst);
    let refused = directory.request(request("thread/fork", json!({ "threadId": "sess_source", "compact": true, "opId": "op-fork" }), "op-fork")).await;
    assert!(refused.is_err(), "{refused:?}");
    for id in directory.loaded_ids().into_iter().filter(|id| *id != source) {
        assert!(directory.stored_header(&id).await.is_none(), "the refused fork left {id:?}");
    }
}

/// `runtime.clear` answers false for a runtime with no session, which the host's reset turns into a refusal when it
/// rebuilds the prompt (`session-reset.mjs`: "The conversation could not be cleared."); a session clears.
#[tokio::test(start_paused = true)]
async fn a_rebuilding_clear_of_a_thread_with_no_session_is_refused() {
    let rig = Rig::new();
    let directory = SessionDirectory::new(rig.deps());
    let header = |value: Value| value.as_object().cloned().expect("header");
    directory.create_with_id(ThreadId::from("sess_control"), header(json!({ "cwd": "/ws" })), json!({})).await.expect("create");
    directory
        .create_with_id(ThreadId::from("sess_seated"), header(json!({ "cwd": "/ws", "provider": "custom-harness", "model": "harness-model" })), json!({}))
        .await
        .expect("create");
    async fn clear(directory: &SessionDirectory, id: &str) -> Result<Reply, CoreError> {
        let handle = directory.open_handle(&ThreadId::from(id), &CallContext::internal("test")).await.expect("open");
        handle.request(request("thread/clear", json!({ "threadId": id, "opId": "op-clear", "rebuildPrompt": true }), "op-clear")).await
    }
    let refused = clear(&directory, "sess_control").await.err().expect("no session, no clear");
    assert!(format!("{refused:?}").contains("The conversation could not be cleared."), "{refused:?}");
    assert!(clear(&directory, "sess_seated").await.is_ok());
}

/// A route the adoption refuses (a default with no model, as Node's `prepareRoute` throws) fails
/// `thread/start` with that text and no code before anything else runs: no tools are composed and
/// no thread exists.
#[tokio::test(start_paused = true)]
async fn a_start_whose_route_is_refused_creates_no_thread() {
    use mixdog_store::schema::record::Header;
    struct Refuses;
    #[async_trait::async_trait]
    impl super::NewThreadRoute for Refuses {
        async fn adopt(&self, _: &ThreadId, _: Option<&serde_json::Map<String, Value>>) -> Result<serde_json::Map<String, Value>, String> {
            Err("No model selected. Choose a model with /model first.".to_owned())
        }
        async fn adopt_control(&self, _: &ThreadId) -> Result<serde_json::Map<String, Value>, String> {
            panic!("a task start never adopts the control route")
        }
        async fn seat(&self, _: &ThreadId) -> Result<(), String> {
            panic!("a refused route is never seated")
        }
    }
    struct Tools(Arc<Mutex<u32>>);
    #[async_trait::async_trait]
    impl super::NewThreadTools for Tools {
        async fn seed(&self, _: &ThreadId, header: &Header) -> Result<Header, String> {
            *lock(&self.0) += 1;
            Ok(header.clone())
        }
    }
    let rig = Rig::new();
    let seeds = Arc::new(Mutex::new(0));
    let mut deps = rig.deps_parts(rig.store.clone());
    deps.new_route = Arc::new(Refuses);
    deps.new_tools = Arc::new(Tools(seeds.clone()));
    let directory = SessionDirectory::new(Arc::new(deps));
    let refused = directory.request(request("thread/start", json!({ "opId": "op-none", "kind": "task" }), "op-none")).await.err().expect("refused");
    assert!(matches!(&refused, CoreError::DomainError { code: None, .. }), "Node throws a plain Error: {refused:?}");
    assert!(format!("{refused:?}").contains("No model selected. Choose a model with /model first."), "{refused:?}");
    assert_eq!(*lock(&seeds), 0);
    assert!(directory.loaded_ids().is_empty());
}

/// The desktop's control session is created before any model is chosen (Node's `ensureControlSession`; a turn is what
/// needs one): a `kind: "control"` start takes its route as it is, while a task start on the same route is refused.
#[tokio::test(start_paused = true)]
async fn a_control_start_needs_no_model_where_a_task_start_does() {
    use mixdog_store::schema::record::Header;
    type Steps = Arc<Mutex<Vec<Value>>>;
    struct Modelless(Steps);
    #[async_trait::async_trait]
    impl super::NewThreadRoute for Modelless {
        async fn adopt(&self, _: &ThreadId, _: Option<&serde_json::Map<String, Value>>) -> Result<serde_json::Map<String, Value>, String> {
            Err("No provider models available. Open /providers to sign in, then /model to choose a model.".to_owned())
        }
        async fn adopt_control(&self, thread: &ThreadId) -> Result<serde_json::Map<String, Value>, String> {
            lock(&self.0).push(json!(["adoptControl", thread]));
            Ok(serde_json::Map::new())
        }
        async fn seat(&self, thread: &ThreadId) -> Result<(), String> {
            lock(&self.0).push(json!(["seat", thread]));
            Ok(())
        }
    }
    struct Tools(Steps);
    #[async_trait::async_trait]
    impl super::NewThreadTools for Tools {
        async fn seed(&self, thread: &ThreadId, header: &Header) -> Result<Header, String> {
            lock(&self.0).push(json!(["seed", thread]));
            Ok(header.clone())
        }
    }
    let rig = Rig::new();
    let steps: Steps = Arc::default();
    let mut deps = rig.deps_parts(rig.store.clone());
    deps.new_route = Arc::new(Modelless(steps.clone()));
    deps.new_tools = Arc::new(Tools(steps.clone()));
    let directory = SessionDirectory::new(Arc::new(deps));
    let refused =
        directory.request(request("thread/start", json!({ "opId": "op-task", "kind": "task" }), "op-task")).await.err().expect("a task needs a model");
    assert!(format!("{refused:?}").contains("No provider models available"), "{refused:?}");
    assert!(lock(&steps).is_empty());
    let reply = directory
        .request(request("thread/start", json!({ "opId": "op-control", "kind": "control" }), "op-control"))
        .await
        .expect("a control start needs no model");
    let Reply::Subscribe(started) = reply else { panic!("thread/start subscribes") };
    let control = ThreadId::from(started.result["thread"]["id"].as_str().expect("thread id"));
    assert_eq!(*lock(&steps), [json!(["adoptControl", control]), json!(["seed", control]), json!(["seat", control])]);
}

/// A thread whose tools were seeded and that is then not created is abandoned exactly once, whichever
/// way `thread/start` ends: a failed `create`, a refused seed, a request cancelled mid-seed. A
/// thread that is created is not abandoned (what the seed opened for it lives until it closes).
#[tokio::test(start_paused = true)]
async fn a_seeded_thread_that_is_not_created_is_abandoned_once() {
    use mixdog_store::schema::record::Header;
    enum Mode {
        Seed,
        Refuse,
        Hang(Arc<tokio::sync::Notify>),
    }
    struct Tools {
        mode: Mutex<Mode>,
        seeded: Mutex<Vec<ThreadId>>,
        abandoned: Mutex<Vec<ThreadId>>,
    }
    #[async_trait::async_trait]
    impl super::NewThreadTools for Tools {
        async fn seed(&self, thread: &ThreadId, header: &Header) -> Result<Header, String> {
            lock(&self.seeded).push(thread.clone());
            let entered = match &*lock(&self.mode) {
                Mode::Seed => None,
                Mode::Refuse => return Err("refused".to_owned()),
                Mode::Hang(entered) => Some(entered.clone()),
            };
            if let Some(entered) = entered {
                entered.notify_one();
                std::future::pending::<()>().await;
            }
            Ok(header.clone())
        }
        fn abandon(&self, thread: &ThreadId) {
            lock(&self.abandoned).push(thread.clone());
        }
    }
    let rig = Rig::new();
    let tools = Arc::new(Tools { mode: Mutex::new(Mode::Seed), seeded: Mutex::default(), abandoned: Mutex::default() });
    let mut deps = rig.deps_parts(rig.store.clone());
    deps.new_tools = tools.clone();
    let directory = Arc::new(SessionDirectory::new(Arc::new(deps)));
    let start = |op: &'static str| {
        let directory = directory.clone();
        async move { directory.request(request("thread/start", json!({ "opId": op, "kind": "task" }), op)).await }
    };
    let abandoned_as_seeded = |count: usize| {
        let (seeded, abandoned) = (lock(&tools.seeded).clone(), lock(&tools.abandoned).clone());
        assert_eq!(abandoned.len(), count, "{abandoned:?}");
        assert_eq!(abandoned, seeded[..count], "each abandoned thread is the one that was seeded");
    };

    // `create` fails (the first commit of the new log is rolled back).
    rig.store.fail_next.store(true, std::sync::atomic::Ordering::SeqCst);
    assert!(start("op-create").await.is_err());
    abandoned_as_seeded(1);
    // The seed itself is refused.
    *lock(&tools.mode) = Mode::Refuse;
    assert!(start("op-refused").await.is_err());
    abandoned_as_seeded(2);
    // The request is cancelled while the seed runs.
    let entered = Arc::new(tokio::sync::Notify::new());
    *lock(&tools.mode) = Mode::Hang(entered.clone());
    let task = tokio::spawn(start("op-cancelled"));
    entered.notified().await;
    task.abort();
    assert!(task.await.is_err(), "the request was cancelled");
    abandoned_as_seeded(3);
    // A thread that is created is not abandoned.
    *lock(&tools.mode) = Mode::Seed;
    assert!(start("op-created").await.is_ok());
    assert_eq!(lock(&tools.seeded).len(), 4);
    abandoned_as_seeded(3);
    assert_eq!(directory.loaded_ids().len(), 1);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_start_cancelled_after_the_thread_is_published_leaves_its_scope_to_the_actor() {
    use mixdog_store::schema::record::Header;
    struct Tools(Mutex<Vec<ThreadId>>, tokio::sync::Notify);
    #[async_trait::async_trait]
    impl super::NewThreadTools for Tools {
        async fn seed(&self, _: &ThreadId, header: &Header) -> Result<Header, String> {
            Ok(header.clone())
        }
        fn abandon(&self, thread: &ThreadId) {
            lock(&self.0).push(thread.clone());
            self.1.notify_waiters();
        }
    }
    let rig = Rig::new();
    let tools = Arc::new(Tools(Mutex::default(), tokio::sync::Notify::new()));
    let mut deps = rig.deps_parts(rig.store.clone());
    deps.new_tools = tools.clone();
    let directory = Arc::new(SessionDirectory::new(Arc::new(deps)));
    let cancelled_in_the_window = |op: &'static str| {
        let (arrived, go) = (Arc::new(tokio::sync::Notify::new()), std::sync::mpsc::channel());
        *lock(&rig.store.create_gate) = Some((arrived.clone(), go.1));
        let directory = directory.clone();
        let task = tokio::spawn(async move { directory.request(request("thread/start", json!({ "opId": op, "kind": "task" }), op)).await });
        async move {
            // The actor is published and its `session` record is at the store, unacknowledged.
            arrived.notified().await;
            task.abort();
            assert!(task.await.is_err(), "the request was cancelled");
            go.0
        }
    };

    let release = cancelled_in_the_window("op-window").await;
    assert!(lock(&tools.0).is_empty(), "the cancelled caller released nothing");
    let id = directory.loaded_ids().pop().expect("the published thread");
    release.send(()).expect("lane waits");
    eventually_on!(&[&rig.store.committed], || (rig.store.records(&id).len() == 1).then_some(())).await;
    let handle = directory.handle(&id).expect("loaded");
    handle
        .request(CoreRequest {
            method: Method("thread/header/patch"),
            params: json!({ "threadId": id, "set": {}, "unset": [] }),
            op: None,
            ctx: CallContext::internal("test"),
        })
        .await
        .expect("the created thread answers");
    assert!(lock(&tools.0).is_empty(), "a thread that was created keeps its scope");

    rig.store.fail_next.store(true, std::sync::atomic::Ordering::SeqCst);
    let release = cancelled_in_the_window("op-failed").await;
    let failed = directory.loaded_ids().into_iter().find(|loaded| *loaded != id).expect("the second published thread");
    release.send(()).expect("lane waits");
    let abandoned = eventually_on!(&[&tools.1], || Some(lock(&tools.0).clone()).filter(|abandoned| !abandoned.is_empty())).await;
    assert_eq!(abandoned, [failed], "the actor abandons the seed of a thread whose first record failed");
}

/// A control `thread/start`: the started thread's id.
async fn start_control(directory: &SessionDirectory, op: &str) -> Result<ThreadId, CoreError> {
    match directory.request(request("thread/start", json!({ "opId": op, "kind": "control" }), op)).await? {
        Reply::Subscribe(started) => Ok(ThreadId::from(started.result["thread"]["id"].as_str().expect("thread id"))),
        Reply::Value(_) => panic!("thread/start subscribes"),
    }
}

/// Where a step waits: it tells `.0` it arrived, then waits for `.1`.
type Gate = (Arc<tokio::sync::Notify>, Arc<tokio::sync::Notify>);

fn gate() -> Gate {
    (Arc::default(), Arc::default())
}

async fn pass(gate: &Option<Gate>) {
    if let Some((arrived, go)) = gate {
        arrived.notify_one();
        go.notified().await;
    }
}

/// The new thread's route, whose control resolution and seat wait at the gates a test sets.
#[derive(Default)]
struct GatedRoute {
    resolving: Option<Gate>,
    seating: Option<Gate>,
}

#[async_trait::async_trait]
impl super::NewThreadRoute for GatedRoute {
    async fn adopt(&self, _: &ThreadId, _: Option<&serde_json::Map<String, Value>>) -> Result<serde_json::Map<String, Value>, String> {
        Ok(serde_json::Map::new())
    }
    async fn adopt_control(&self, _: &ThreadId) -> Result<serde_json::Map<String, Value>, String> {
        pass(&self.resolving).await;
        Ok(serde_json::Map::new())
    }
    async fn seat(&self, _: &ThreadId) -> Result<(), String> {
        pass(&self.seating).await;
        Ok(())
    }
}

fn gated_directory(rig: &Rig, route: GatedRoute) -> Arc<SessionDirectory> {
    let mut deps = rig.deps_parts(rig.store.clone());
    deps.new_route = Arc::new(route);
    Arc::new(SessionDirectory::new(Arc::new(deps)))
}

#[tokio::test(start_paused = true)]
async fn a_control_start_is_synced_from_before_its_route_is_resolved_through_its_created_thread() {
    let rig = Rig::new();
    let resolving = gate();
    let directory = gated_directory(&rig, GatedRoute { resolving: Some(resolving.clone()), seating: None });
    let start = tokio::spawn({
        let directory = directory.clone();
        async move { start_control(&directory, "op-control").await }
    });
    resolving.0.notified().await;
    let [id] = <[ThreadId; 1]>::try_from(directory.control_ids()).expect("the start is listed while its route resolves");
    assert!(directory.handle(&id).is_none(), "not a thread yet");
    assert!(matches!(directory.open_handle(&id, &CallContext::internal("test")).await, Err(CoreError::ThreadNotFound { .. })));
    assert!(
        matches!(directory.create_with_id(id.clone(), Default::default(), json!({})).await, Err(CoreError::PreconditionFailed { .. })),
        "the id is the start's"
    );
    assert_eq!(directory.control_ids(), [id.clone()]);
    resolving.1.notify_one();
    assert_eq!(start.await.expect("joined").expect("control start"), id);
    assert_eq!(directory.control_ids(), [id.clone()]);
    let Some((_, mixdog_store::schema::record::Record::Session(session))) = rig.store.records(&id).first().cloned() else { panic!("the session record") };
    assert!(session.control, "the kind is the thread's own record's");
    let task = directory.request(request("thread/start", json!({ "opId": "op-task", "kind": "task" }), "op-task")).await.expect("task start");
    assert!(matches!(task, Reply::Subscribe(_)));
    assert_eq!(directory.loaded_ids().len(), 2);
    assert_eq!(directory.control_ids(), [id]);
}

/// Create fails, or the caller is cancelled before the create. The control threads the config's adoption syncs are the ones the
/// directory holds (`control_ids`), so a control start that does not end in a thread (a failed `create`, a refused seed, a
/// request cancelled mid-seed) leaves nothing to sync.
#[tokio::test(start_paused = true)]
async fn a_control_start_that_does_not_end_in_a_thread_leaves_nothing_to_sync() {
    use mixdog_store::schema::record::Header;
    enum Mode {
        Seed,
        Refuse,
        Hang(Arc<tokio::sync::Notify>),
    }
    struct Tools(Mutex<Mode>);
    #[async_trait::async_trait]
    impl super::NewThreadTools for Tools {
        async fn seed(&self, _: &ThreadId, header: &Header) -> Result<Header, String> {
            let entered = match &*lock(&self.0) {
                Mode::Seed => None,
                Mode::Refuse => return Err("refused".to_owned()),
                Mode::Hang(entered) => Some(entered.clone()),
            };
            if let Some(entered) = entered {
                entered.notify_one();
                std::future::pending::<()>().await;
            }
            Ok(header.clone())
        }
    }
    let rig = Rig::new();
    let tools = Arc::new(Tools(Mutex::new(Mode::Seed)));
    let mut deps = rig.deps_parts(rig.store.clone());
    deps.new_tools = tools.clone();
    let directory = Arc::new(SessionDirectory::new(Arc::new(deps)));
    let start = |op: &'static str, kind: &'static str| {
        let directory = directory.clone();
        async move { directory.request(request("thread/start", json!({ "opId": op, "kind": kind }), op)).await }
    };

    rig.store.fail_next.store(true, std::sync::atomic::Ordering::SeqCst);
    assert!(start("op-create", "control").await.is_err());
    assert!(directory.control_ids().is_empty(), "a failed create");
    *lock(&tools.0) = Mode::Refuse;
    assert!(start("op-refused", "control").await.is_err());
    assert!(directory.control_ids().is_empty(), "a refused seed");
    let entered = Arc::new(tokio::sync::Notify::new());
    *lock(&tools.0) = Mode::Hang(entered.clone());
    let task = tokio::spawn(start("op-cancelled", "control"));
    entered.notified().await;
    task.abort();
    assert!(task.await.is_err(), "the request was cancelled");
    assert!(directory.control_ids().is_empty(), "a request cancelled mid-seed");
    // A control start that ends in a thread is listed; a task thread beside it is not.
    *lock(&tools.0) = Mode::Seed;
    assert!(start("op-task", "task").await.is_ok());
    let Reply::Subscribe(started) = start("op-created", "control").await.expect("control start") else { panic!("thread/start subscribes") };
    let created = ThreadId::from(started.result["thread"]["id"].as_str().expect("thread id"));
    assert_eq!(directory.control_ids(), vec![created]);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_control_create_whose_caller_is_cancelled_before_the_commit_is_synced_only_once_it_commits() {
    let rig = Rig::new();
    let directory = Arc::new(SessionDirectory::new(Arc::new(rig.deps_parts(rig.store.clone()))));
    let cancelled_in_the_window = |op: &'static str| {
        let (arrived, go) = (Arc::new(tokio::sync::Notify::new()), std::sync::mpsc::channel());
        *lock(&rig.store.create_gate) = Some((arrived.clone(), go.1));
        let directory = directory.clone();
        let task = tokio::spawn(async move { start_control(&directory, op).await });
        async move {
            arrived.notified().await;
            task.abort();
            assert!(task.await.is_err(), "the request was cancelled");
            go.0
        }
    };

    let release = cancelled_in_the_window("op-window").await;
    let [id] = <[ThreadId; 1]>::try_from(directory.control_ids()).expect("the published control thread");
    let handle = directory.handle(&id).expect("published");
    release.send(()).expect("lane waits");
    eventually_on!(&[&handle.cell.stepped], || (rig.store.records(&id).len() == 1).then_some(())).await;
    assert_eq!(directory.control_ids(), [id.clone()], "the created thread is still synced");

    rig.store.fail_next.store(true, std::sync::atomic::Ordering::SeqCst);
    let release = cancelled_in_the_window("op-failed").await;
    let failed = directory.control_ids().into_iter().find(|listed| *listed != id).expect("the second published control thread");
    let failing = directory.handle(&failed).expect("published");
    release.send(()).expect("lane waits");
    // The actor ends once its slot is released (the lease is the first thing it drops).
    failing.inbox.closed().await;
    assert!(directory.handle(&failed).is_none());
    assert_eq!(directory.control_ids(), [id]);
}

/// Caller cancelled after the commit. A control start whose request is cancelled once its create returned (here, while the route
/// is seated) leaves a created thread, which stays synced: the thread is the slot's, not the request's.
#[tokio::test(start_paused = true)]
async fn a_control_start_cancelled_after_its_create_leaves_a_synced_thread() {
    let rig = Rig::new();
    let seating = gate();
    let directory = gated_directory(&rig, GatedRoute { resolving: None, seating: Some(seating.clone()) });
    let start = tokio::spawn({
        let directory = directory.clone();
        async move { start_control(&directory, "op-control").await }
    });
    seating.0.notified().await;
    let [id] = <[ThreadId; 1]>::try_from(directory.control_ids()).expect("the created control thread");
    assert_eq!(rig.store.records(&id).len(), 1, "created");
    start.abort();
    assert!(start.await.is_err(), "the request was cancelled");
    assert!(directory.handle(&id).is_some());
    assert_eq!(directory.control_ids(), [id]);
}

/// Actor panics before the reply. An actor that unwinds while the thread's first record is at the store releases its slot before it
/// drops the create's reply: the caller learns the thread is closing and finds it unlisted, with no slot left behind.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_control_actor_that_unwinds_before_its_reply_leaves_nothing_to_sync() {
    let rig = Rig::new();
    let directory = Arc::new(SessionDirectory::new(Arc::new(rig.deps_parts(rig.store.clone()))));
    let (arrived, go) = (Arc::new(tokio::sync::Notify::new()), std::sync::mpsc::channel());
    *lock(&rig.store.create_gate) = Some((arrived.clone(), go.1));
    let start = tokio::spawn({
        let directory = directory.clone();
        async move { start_control(&directory, "op-control").await }
    });
    arrived.notified().await;
    let [id] = <[ThreadId; 1]>::try_from(directory.control_ids()).expect("the published control thread");
    let handle = directory.handle(&id).expect("published");
    handle.inbox.send(super::actor::Inbox::Unwind(super::actor::UnwindAt::Now)).await.expect("the actor runs");
    let ended = start.await.expect("joined").err().expect("the create's reply is gone");
    assert!(matches!(ended, CoreError::ThreadClosing { .. }), "{ended:?}");
    assert!(directory.handle(&id).is_none());
    assert!(directory.control_ids().is_empty());
    go.0.send(()).expect("lane waits");
}

/// Actor panics after the reply, then reopen. An actor that unwinds after its thread was created releases its slot: the thread is not
/// live and is not synced. Reopened, the thread is the control session again, from the kind its own record carries.
#[tokio::test(start_paused = true)]
async fn a_control_actor_that_unwinds_after_its_reply_is_unlisted_until_it_is_reopened() {
    let rig = Rig::new();
    let directory = SessionDirectory::new(rig.deps());
    let id = start_control(&directory, "op-control").await.expect("control start");
    let handle = directory.handle(&id).expect("loaded");
    assert_eq!(directory.control_ids(), [id.clone()]);
    handle.inbox.send(super::actor::Inbox::Unwind(super::actor::UnwindAt::Now)).await.expect("the actor runs");
    handle.inbox.closed().await;
    assert!(directory.handle(&id).is_none());
    assert!(directory.control_ids().is_empty());
    let reopened = directory.open_handle(&id, &CallContext::internal("test")).await.expect("reopened");
    assert!(!Arc::ptr_eq(&reopened, &handle));
    assert_eq!(directory.control_ids(), [id]);
}

/// Close. A control thread the idle close tombstones leaves the directory and is not synced.
#[tokio::test(start_paused = true)]
async fn a_closed_control_thread_is_not_synced() {
    let rig = Rig::new();
    rig.store.listed.store(true, std::sync::atomic::Ordering::SeqCst);
    let directory = SessionDirectory::new(rig.deps());
    let id = start_control(&directory, "op-control").await.expect("control start");
    let read = super::sub_agent_retention::activity_at(&directory.stored_header(&id).await.expect("header"));
    assert!(directory.close_stored(id.as_str(), read, &CancellationToken::new()).await.expect("close"));
    assert!(directory.handle(&id).is_none());
    assert!(directory.control_ids().is_empty());
}

/// Purge. A deleted control thread leaves the directory and is not synced.
#[tokio::test(start_paused = true)]
async fn a_deleted_control_thread_is_not_synced() {
    let rig = Rig::new();
    rig.store.listed.store(true, std::sync::atomic::Ordering::SeqCst);
    let directory = SessionDirectory::new(rig.deps());
    let id = start_control(&directory, "op-control").await.expect("control start");
    let handle = directory.handle(&id).expect("loaded");
    let reply = handle.request(request("thread/delete", json!({ "threadId": id, "opId": "op-del" }), "op-del")).await.expect("thread/delete");
    assert!(matches!(reply, Reply::Value(Value::Bool(true))), "{reply:?}");
    assert!(directory.handle(&id).is_none());
    assert!(directory.control_ids().is_empty());
}

/// Concurrent create of the same id. While a create holds an id, another create of it is refused. When the first one's record fails,
/// its actor releases only its own slot; a create that claims the id after that keeps it, and the first caller's error, seen only
/// after the claim, removes nothing.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_failed_create_never_releases_the_create_that_claimed_its_id_after_it() {
    let rig = Rig::new();
    let directory = SessionDirectory::new(rig.deps());
    let id = ThreadId::from("sess_control_fixed");
    let (arrived, go) = (Arc::new(tokio::sync::Notify::new()), std::sync::mpsc::channel());
    *lock(&rig.store.create_gate) = Some((arrived.clone(), go.1));
    rig.store.fail_next.store(true, std::sync::atomic::Ordering::SeqCst);
    let mut first = Box::pin(directory.create_with_id(id.clone(), Default::default(), json!({})));
    assert!(futures::poll!(first.as_mut()).is_pending(), "the first create waits on its record");
    arrived.notified().await;
    let failing = directory.handle(&id).expect("the first create's slot");
    assert_eq!(directory.loaded_ids(), [id.clone()]);
    let refused = directory.create_with_id(id.clone(), Default::default(), json!({})).await.err().expect("the id is taken");
    assert!(matches!(refused, CoreError::PreconditionFailed { .. }), "{refused:?}");
    assert!(Arc::ptr_eq(&directory.handle(&id).expect("still the first"), &failing));
    go.0.send(()).expect("lane waits");
    failing.inbox.closed().await;
    assert!(directory.handle(&id).is_none(), "the failed create released its own slot");
    directory.create_with_id(id.clone(), Default::default(), json!({})).await.expect("the id is free again");
    let replacement = directory.handle(&id).expect("the replacement");
    assert!(first.await.is_err(), "the first create failed");
    assert!(Arc::ptr_eq(&directory.handle(&id).expect("still loaded"), &replacement), "the first caller's error removed nothing");
    assert_eq!(directory.loaded_ids(), [id]);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn an_adoption_never_writes_a_control_thread_that_ended_after_it_was_listed() {
    use mixdog_core_domains::domains::ai_admin::route_service::LiveControls;
    let rig = Rig::new();
    rig.store.listed.store(true, std::sync::atomic::Ordering::SeqCst);
    let resolving = gate();
    let directory = gated_directory(&rig, GatedRoute { resolving: Some(resolving.clone()), seating: None });
    let start = |op: &'static str| {
        let directory = directory.clone();
        tokio::spawn(async move { start_control(&directory, op).await })
    };
    let mut created = Vec::new();
    for op in ["op-closed", "op-live"] {
        let task = start(op);
        resolving.0.notified().await;
        resolving.1.notify_one();
        created.push(task.await.expect("joined").expect("control start"));
    }
    let [closed, live] = <[ThreadId; 2]>::try_from(created).expect("two control threads");
    let abandoned = start("op-abandoned");
    resolving.0.notified().await;
    assert_eq!(directory.control_ids().len(), 3, "both threads and the start are listed");

    let (arrived, go) = (Arc::new(tokio::sync::Notify::new()), std::sync::mpsc::channel());
    directory.gate_adoption(arrived.clone(), go.1);
    let synced = Arc::new(Mutex::new(Vec::new()));
    let adoption = std::thread::spawn({
        let (directory, synced) = (directory.clone(), synced.clone());
        move || directory.sync_live(&mut |id| lock(&synced).push(id.clone()))
    });
    arrived.notified().await;
    let read = super::sub_agent_retention::activity_at(&directory.stored_header(&closed).await.expect("header"));
    assert!(directory.close_stored(closed.as_str(), read, &CancellationToken::new()).await.expect("close"));
    abandoned.abort();
    assert!(abandoned.await.is_err(), "the start was cancelled");
    go.0.send(()).expect("the adoption waits");
    adoption.join().expect("the adoption ran");
    assert_eq!(*lock(&synced), [live.clone()], "only the thread still live is written");
    assert_eq!(directory.control_ids(), [live]);
}

/// A `thread/start` with no `session` options is a `full` Lead denied the goal tools, as
/// Node's `sessionOptions` makes it.
#[tokio::test(start_paused = true)]
async fn a_thread_started_without_options_still_denies_the_goal_tools() {
    let rig = Rig::new();
    let directory = SessionDirectory::new(Arc::new(rig.deps_parts(rig.store.clone())));
    let reply = directory.request(request("thread/start", json!({ "opId": "op-bare", "kind": "task" }), "op-bare")).await.expect("thread/start");
    let Reply::Subscribe(started) = reply else { panic!("thread/start subscribes") };
    let id = ThreadId::from(started.result["thread"]["id"].as_str().expect("thread id"));
    let header = directory.handle(&id).expect("loaded").cell.header.load_full();
    assert_eq!(header["toolSpec"], "full");
    assert_eq!(header["disallowedTools"], json!(["get_goal", "create_goal", "set_goal_tasks", "update_goal"]));
}

/// `kind: task` with no project begins in the task workspace the core resolves (Node: `cwd: await taskWorkspace()` for a
/// task session and for the control session); a project path is kept, and a project start names no task folder.
#[tokio::test(start_paused = true)]
async fn a_task_thread_begins_in_the_task_workspace() {
    let rig = Rig::new();
    let directory = SessionDirectory::new(Arc::new(rig.deps_parts(rig.store.clone())));
    let cwd_of = |reply: Reply| {
        let Reply::Subscribe(started) = reply else { panic!("thread/start subscribes") };
        let id = ThreadId::from(started.result["thread"]["id"].as_str().expect("thread id"));
        directory.handle(&id).expect("loaded").cell.header.load_full().get("cwd").cloned()
    };
    let task = directory.request(request("thread/start", json!({ "opId": "op-task", "kind": "task" }), "op-task")).await.expect("thread/start");
    assert_eq!(cwd_of(task), Some(json!("/tasks")));
    let kept = directory
        .request(request("thread/start", json!({ "opId": "op-kept", "kind": "task", "projectPath": "/repo" }), "op-kept"))
        .await
        .expect("thread/start");
    assert_eq!(cwd_of(kept), Some(json!("/repo")));
    let project = directory.request(request("thread/start", json!({ "opId": "op-proj", "kind": "project" }), "op-proj")).await.expect("thread/start");
    assert_eq!(cwd_of(project), None);
}

/// A new task or project thread carries Node's `desktopSession` classification in its header (the host's
/// `resolveSessionWorkspace`); the control session (no draft, no project) carries none (`desktopSession: null`).
#[tokio::test(start_paused = true)]
async fn a_started_thread_is_classified_as_the_desktop_host_classifies_a_session() {
    let rig = Rig::new();
    let directory = SessionDirectory::new(Arc::new(rig.deps_parts(rig.store.clone())));
    let header_of = |reply: Reply| {
        let Reply::Subscribe(started) = reply else { panic!("thread/start subscribes") };
        let id = ThreadId::from(started.result["thread"]["id"].as_str().expect("thread id"));
        directory.handle(&id).expect("loaded").cell.header.load_full()
    };
    let start = |op: &'static str, params: Value| {
        let directory = &directory;
        async move { directory.request(request("thread/start", params, op)).await.expect("thread/start") }
    };
    let task = header_of(start("op-task", json!({ "opId": "op-task", "kind": "task", "draft": {} })).await);
    assert_eq!(task["desktopSession"], json!({ "classification": "task", "projectPath": null }));
    assert_eq!(task["cwd"], "/tasks");
    let drafted = header_of(start("op-draft", json!({ "opId": "op-draft", "kind": "task", "draft": { "projectPath": "/repo" } })).await);
    assert_eq!(drafted["desktopSession"], json!({ "classification": "project", "projectPath": "/repo" }));
    assert_eq!(drafted["cwd"], "/repo");
    let project = header_of(start("op-proj", json!({ "opId": "op-proj", "kind": "project", "projectPath": "/repo" })).await);
    assert_eq!(project["desktopSession"], json!({ "classification": "project", "projectPath": "/repo" }));
    let blank = header_of(start("op-blank", json!({ "opId": "op-blank", "kind": "task", "draft": { "projectPath": "  " } })).await);
    assert_eq!(blank["desktopSession"], json!({ "classification": "task", "projectPath": null }));
    // The control session is its own kind (`ensureControlSession`): the task workspace and no classification, whatever else the
    // request names.
    let control = header_of(start("op-control", json!({ "opId": "op-control", "kind": "control" })).await);
    assert!(control.get("desktopSession").is_none());
    assert_eq!(control["cwd"], "/tasks");
    let named = header_of(start("op-named", json!({ "opId": "op-named", "kind": "control", "draft": { "projectPath": "/repo" } })).await);
    assert!(named.get("desktopSession").is_none());
    assert_eq!(named["cwd"], "/tasks");
    // A task start with no draft and no project is not the control session by inference: it takes no classification either (a
    // client without a host, as Node's TUI), but it is not marked.
    let bare = header_of(start("op-bare-task", json!({ "opId": "op-bare-task", "kind": "task" })).await);
    assert!(bare.get("desktopSession").is_none());
}

/// Node's cold heir drops the source's Codex wire identity and mints its own (`cold-heir.mjs:70`, `:143`): a fork of an
/// `openai-oauth` thread has a UUIDv7 of its own, never its source's; another provider's heir has none.
#[tokio::test(start_paused = true)]
async fn a_fork_has_a_codex_wire_identity_of_its_own() {
    use mixdog_store::schema::record::Header;
    let rig = Rig::new();
    let directory = SessionDirectory::new(Arc::new(rig.deps_parts(rig.store.clone())));
    let source_wire = "0190f0a0-1c2d-7e3f-8a4b-5c6d7e8f9a0d";
    let fork = |id: &'static str, provider: &'static str| {
        let directory = &directory;
        async move {
            let mut header = Header::new();
            header.insert("createdAt".into(), json!(1));
            header.insert("updatedAt".into(), json!(1));
            header.insert("cwd".into(), json!("/repo"));
            header.insert("provider".into(), json!(provider));
            header.insert("codexWireSessionId".into(), json!(source_wire));
            let thread = ThreadId::from(id.to_owned());
            directory.create_with_id(thread.clone(), header, json!({})).await.expect("source");
            give_conversation(&directory.handle(&thread).expect("loaded")).await;
            let params = json!({ "threadId": id, "opId": format!("op-{id}") });
            let reply = directory.handle(&thread).expect("loaded").request(request("thread/fork", params, &format!("op-{id}"))).await.expect("thread/fork");
            let Reply::Value(value) = reply else { panic!("thread/fork answers a value") };
            let heir = ThreadId::from(value["thread"]["id"].as_str().expect("heir id"));
            directory.handle(&heir).expect("loaded").cell.header.load_full()
        }
    };
    let oauth = fork("src_oauth", "openai-oauth").await;
    let minted = oauth["codexWireSessionId"].as_str().expect("the heir carries a wire identity");
    assert_ne!(minted, source_wire, "not the source's");
    assert_eq!(uuid::Uuid::parse_str(minted).expect("a uuid").get_version_num(), 7, "a UUIDv7: {minted}");
    let other = fork("src_other", "anthropic-oauth").await;
    assert!(other.get("codexWireSessionId").is_none_or(Value::is_null), "no Codex identity for another provider");
}

/// A fork holds its source's text: a value the source marks sensitive after the fork is the fork's to redact too.
#[tokio::test(start_paused = true)]
async fn a_value_the_source_marks_after_a_fork_is_the_forks_too() {
    use mixdog_store::schema::record::Header;
    let rig = Rig::new();
    let directory = SessionDirectory::new(Arc::new(rig.deps_parts(rig.store.clone())));
    let mut header = Header::new();
    header.insert("cwd".into(), json!("/repo"));
    let source = ThreadId::from("src_marked".to_owned());
    directory.create_with_id(source.clone(), header, json!({})).await.expect("source");
    give_conversation(&directory.handle(&source).expect("loaded")).await;
    let reply = directory
        .handle(&source)
        .expect("loaded")
        .request(request("thread/fork", json!({ "threadId": "src_marked", "opId": "op-fork" }), "op-fork"))
        .await
        .expect("thread/fork");
    let Reply::Value(value) = reply else { panic!("thread/fork answers a value") };
    let heir = value["thread"]["id"].as_str().expect("heir id").to_owned();
    let fill = json!({ "name": "browser", "arguments": { "action": "fill", "input": { "sensitive": true, "text": "482913" } } });
    assert!(rig.sensitive.remember("src_marked", &[fill]));
    assert_eq!(rig.sensitive.redact_text(&heir, "code 482913"), "code [redacted]");
}

/// The restart notice's queue (`enqueuePendingMessage` then `settlePendingMessageWrites`, `restart-notify.mjs:116-119`): the
/// call answers only once the entry's record is stored, and the same execution queued again (a retry after a crash before the
/// row's stamp) stays one entry and is answered too.
#[tokio::test(start_paused = true)]
async fn a_durable_completion_answers_once_stored_and_a_repeat_is_one_entry() {
    let rig = Rig::new();
    rig.set_script(echo());
    let directory = SessionDirectory::new(rig.deps());
    let owner = start_with_session(&directory, json!({ "autoWakeCompletions": false })).await;
    for attempt in 0..2 {
        directory.queue_completion_durably(&owner.id, "agent", "restart:t-1", "failed", "lost".into()).await.expect("stored");
        let queued = rig.store.records(&owner.id).into_iter().filter(|(_, record)| matches!(record, mixdog_store::schema::record::Record::Queue(_))).count();
        assert_eq!(queued, 1, "attempt {attempt}: one entry, stored before the answer");
    }
}

/// `thread/revertTurnReview` and `thread/revertTurnReviewFile` reach the turn review through the
/// thread handle: a thread with no turn answers Node's refusal, a malformed call is invalid params.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn turn_review_reverts_are_served_by_the_thread_handle() {
    let rig = Rig::new();
    let directory = SessionDirectory::new(rig.deps());
    let handle = start_thread(&directory).await;
    for (method, params) in [
        ("thread/revertTurnReview", json!({ "threadId": handle.id, "opId": "op-1" })),
        ("thread/revertTurnReviewFile", json!({ "threadId": handle.id, "opId": "op-1", "file": "a.txt" })),
    ] {
        let error = handle.request(request(method, params, "op-1")).await.expect_err("no turn to revert");
        match error {
            CoreError::DomainError { domain, message: Some(message), .. } => {
                assert_eq!((&*domain, &*message), ("turnReview", "turn worktree snapshot is unavailable"), "{method}");
            }
            other => panic!("{method}: {other:?}"),
        }
    }
    let error =
        handle.request(request("thread/revertTurnReviewFile", json!({ "threadId": handle.id, "opId": "op-2" }), "op-2")).await.expect_err("a file is required");
    assert!(matches!(error, CoreError::InvalidParams { .. }), "{error:?}");
}

/// Node's `updateSessionManualTitle` writes the title keys only: the row's creation, update and activity times stay.
#[tokio::test(start_paused = true)]
async fn a_rename_leaves_the_rows_times_alone() {
    let rig = Rig::new();
    let directory = SessionDirectory::new(rig.deps());
    let handle = start_thread(&directory).await;
    let times = |handle: &SessionHandle| {
        let header = handle.cell.header.load_full();
        ["createdAt", "updatedAt", "lastUsedAt"].map(|key| header.get(key).cloned())
    };
    let before = times(&handle);
    assert!(before.iter().all(Option::is_some), "a started thread is stamped {before:?}");
    rig.clock.0.store(9_000, std::sync::atomic::Ordering::SeqCst);
    handle.request(request("thread/name/set", json!({ "threadId": handle.id, "opId": "op-t", "title": "renamed" }), "op-t")).await.expect("name/set");
    eventually_on!(&[&handle.cell.stepped], || (handle.cell.view.load_full().state.title.as_deref() == Some("renamed")).then_some(())).await;
    assert_eq!(times(&handle), before);
}

#[tokio::test(start_paused = true)]
async fn a_failed_barrier_applies_nothing_and_answers_the_mutation() {
    let rig = Rig::new();
    let directory = SessionDirectory::new(rig.deps());
    let handle = start_thread(&directory).await;
    rig.store.fail_next.store(true, std::sync::atomic::Ordering::SeqCst);
    let error = handle
        .request(request("thread/name/set", json!({ "threadId": handle.id, "opId": "op-1", "title": "renamed" }), "op-1"))
        .await
        .expect_err("barrier failed");
    assert!(!matches!(error, CoreError::InvalidParams { .. }), "{error:?}");
    assert_ne!(handle.cell.view.load_full().state.title.as_deref(), Some("renamed"));
    // The next write succeeds.
    handle.request(request("thread/name/set", json!({ "threadId": handle.id, "opId": "op-2", "title": "renamed" }), "op-2")).await.expect("name/set");
    eventually_on!(&[&handle.cell.stepped], || { (handle.cell.view.load_full().state.title.as_deref() == Some("renamed")).then_some(()) }).await;
}

#[tokio::test(start_paused = true)]
async fn a_cold_open_is_single_flight_and_reopens_the_same_state() {
    let rig = Rig::new();
    rig.set_script(echo());
    let first = SessionDirectory::new(rig.deps());
    let handle = start_thread(&first).await;
    turn(&handle, "hello", "op-1").await;
    eventually_on!(&[&handle.cell.stepped], || (idle(&handle) && rows(&handle).len() == 2).then_some(())).await;
    let before = rows(&handle);
    let prompts = prompt_list(&handle);
    let id = handle.id.clone();

    let second = Arc::new(SessionDirectory::new(rig.deps()));
    let reads = rig.store.head_reads.load(std::sync::atomic::Ordering::SeqCst);
    let opens: Vec<_> = (0..8)
        .map(|_| {
            let (directory, id) = (second.clone(), id.clone());
            tokio::spawn(async move { directory.open_handle(&id, &CallContext::internal("test")).await.expect("open") })
        })
        .collect();
    let mut handles = Vec::new();
    for open in opens {
        handles.push(open.await.expect("join"));
    }
    assert_eq!(rig.store.head_reads.load(std::sync::atomic::Ordering::SeqCst), reads + 1);
    assert!(handles.iter().all(|h| Arc::ptr_eq(h, &handles[0])));
    let reopened = &handles[0];
    assert_eq!(rows(reopened), before);
    eventually_on!(&[&reopened.cell.stepped], || (prompt_list(reopened) == prompts).then_some(())).await;
    assert!(second.get(&ThreadId::from("missing")).is_none());
    assert!(matches!(second.open(&ThreadId::from("missing"), &CallContext::internal("test")).await, Err(CoreError::ThreadNotFound { .. })));
}

/// `markSessionClosed` logs the close metric only after the tombstone write is acknowledged: a
/// delete whose mark fails closed nothing and logs nothing; the delete that lands logs once.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_delete_whose_mark_fails_logs_no_close() {
    let rig = Rig::new();
    let directory = SessionDirectory::new(rig.deps());
    let handle = start_thread(&directory).await;
    let other = start_thread(&directory).await;
    rig.store.listed.store(true, std::sync::atomic::Ordering::SeqCst);
    let delete = |handle: &Arc<SessionHandle>, op: &'static str| {
        let (handle, id) = (handle.clone(), handle.id.clone());
        async move { handle.request(request("thread/delete", json!({ "threadId": id, "opId": op }), op)).await.expect("thread/delete") }
    };
    rig.store.fail_next.store(true, std::sync::atomic::Ordering::SeqCst);
    let reply = delete(&handle, "op-fail").await;
    assert!(matches!(reply, Reply::Value(Value::Bool(false))), "{reply:?}");
    let closes = |rig: &Rig| lock(&rig.deletes.0).iter().filter(|step| step.starts_with("sessionClosed:")).count();
    assert_eq!(closes(&rig), 0, "an unacknowledged mark is not a close");
    assert!(lock(&rig.deletes.2).is_empty(), "nor does it release the session's MCP scope");
    let reply = delete(&other, "op-ok").await;
    assert!(matches!(reply, Reply::Value(Value::Bool(true))), "{reply:?}");
    assert_eq!(closes(&rig), 1);
    assert_eq!(*lock(&rig.deletes.2), [other.id.as_str().to_owned()]);
}

/// A fork of a live memory-cycle dispatch is the user's own Lead (`cold-heir.mjs` `ROOT_LEAD_IDENTITY.sourceType`): it does not
/// inherit the maintenance provenance that keeps a dispatch out of memory, so its conversation is ingested when it closes.
#[tokio::test(start_paused = true)]
async fn a_fork_of_a_memory_cycle_dispatch_is_not_itself_a_memory_cycle_dispatch() {
    let rig = Rig::new();
    let directory = SessionDirectory::new(rig.deps());
    let ctx = CallContext::internal("test");
    let id = ThreadId::from("sess_cycle_source");
    let header = json!({ "cwd": "/ws", "provider": "custom-harness", "model": "harness-model", "sourceType": "memory-cycle" });
    directory.create_with_id(id.clone(), header.as_object().cloned().expect("header"), json!({})).await.expect("create the source");
    let source = directory.open_handle(&id, &ctx).await.expect("open the source");
    give_conversation(&source).await;
    let reply = source.request(request("thread/fork", json!({ "threadId": id, "opId": "op-fork" }), "op-fork")).await.expect("thread/fork");
    let Reply::Value(value) = reply else { panic!("thread/fork answers a value") };
    let heir = directory.open_handle(&ThreadId::from(value["thread"]["id"].as_str().expect("heir id")), &ctx).await.expect("open the heir");
    let header = heir.cell.header.load();
    assert!(super::session_options::memory_ingest_off(&source.cell.header.load()), "the source is a maintenance dispatch");
    assert!(!super::session_options::memory_ingest_off(&header), "its fork is not: {:?}", header.get("sourceType"));
}

/// A preserved copy (the copy a person's clear keeps, Node's `forkOutgoingTranscript`) keeps the source's own `sourceType`: it is a
/// copy of that session, not a new Lead, so it stays out of the Lead catalog and keeps its provenance. (A `thread/fork` heir is a
/// root Lead instead, `root_heir_identity`; the copy is made by `keep_cleared_copy`, not by a fork.)
#[tokio::test(start_paused = true)]
async fn a_fork_keeps_a_sources_ordinary_source_type() {
    let rig = Rig::new();
    let directory = SessionDirectory::new(rig.deps());
    let ctx = CallContext::internal("test");
    let id = ThreadId::from("sess_exec_source");
    let header = json!({ "cwd": "/ws", "provider": "custom-harness", "model": "harness-model", "sourceType": "exec" });
    directory.create_with_id(id.clone(), header.as_object().cloned().expect("header"), json!({})).await.expect("create the source");
    let source = directory.open_handle(&id, &ctx).await.expect("open the source");
    give_conversation(&source).await;
    let ids = || -> std::collections::BTreeSet<String> { rig.store.log_ids().iter().map(|id| id.as_str().to_owned()).collect() };
    let before = ids();
    source.request(request("thread/clear", json!({ "threadId": id, "opId": "op-clear" }), "op-clear")).await.expect("thread/clear");
    let copies: Vec<String> = ids().difference(&before).cloned().collect();
    let [copy] = copies.as_slice() else { panic!("one copy of the cleared conversation: {copies:?}") };
    let header = rig.store.stored_header(&ThreadId::from(copy.as_str())).expect("the copy's header");
    assert_eq!(header.get("sourceType"), Some(&json!("exec")));
}

/// The heir drops what it does not carry as Node's `delete` drops a key: the source's header keys it keeps stay in their order.
#[tokio::test(start_paused = true)]
async fn a_fork_keeps_the_order_of_the_header_keys_it_carries() {
    let rig = Rig::new();
    let directory = SessionDirectory::new(rig.deps());
    let ctx = CallContext::internal("test");
    let id = ThreadId::from("sess_key_order");
    // More dropped keys than the heir appends after the carried ones, so a swap-remove would pull a carried key forward.
    let header = json!({
        "cwd": "/ws", "provider": "custom-harness", "model": "harness-model", "codexWireSessionId": "wire", "alpha": 1, "todo": [],
        "beta": 2, "closeProvenance": "user", "gamma": 3, "bp3Cursor": 4, "delta": 5, "lastInputTokens": 6, "epsilon": 7,
        "lastOutputTokens": 8, "zeta": 9, "lastContextTokens": 10, "eta": 11, "turnHop": 12, "theta": 13, "usageReadout": 14, "iota": 15,
        "todoCheck": 16, "kappa": 17, "transcriptEpoch": 18, "lambda": 19,
    });
    directory.create_with_id(id.clone(), header.as_object().cloned().expect("header"), json!({})).await.expect("create the source");
    let source = directory.open_handle(&id, &ctx).await.expect("open the source");
    give_conversation(&source).await;
    let reply = source.request(request("thread/fork", json!({ "threadId": id, "opId": "op-fork" }), "op-fork")).await.expect("thread/fork");
    let Reply::Value(value) = reply else { panic!("thread/fork answers a value") };
    let heir = directory.open_handle(&ThreadId::from(value["thread"]["id"].as_str().expect("heir id")), &ctx).await.expect("open the heir");
    let header = heir.cell.header.load();
    let kept = ["cwd", "provider", "model", "alpha", "beta", "gamma", "delta", "epsilon", "zeta", "eta", "theta", "iota", "kappa", "lambda"];
    let carried: Vec<&str> = header.keys().map(String::as_str).filter(|key| kept.contains(key)).collect();
    assert_eq!(carried, kept);
}

/// `assertAgentEditorAccess` reads the caller record's own `agent`
/// (`String(caller?.agent || '').trim()`): an agent home carries it from creation, a coding
/// Lead names none; a thread that cannot be opened is an error, not "no agent".
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn the_acting_agent_is_the_callers_own_agent_field() {
    let rig = Rig::new();
    let directory = SessionDirectory::new(rig.deps());
    let header = |value: Value| value.as_object().cloned().unwrap();
    directory.create_with_id(ThreadId::from("sess_home_my_bot"), header(json!({ "agent": "my.bot" })), json!({})).await.expect("home");
    directory.create_with_id(ThreadId::from("sess_w1"), header(json!({ "owner": "agent", "agent": " reviewer " })), json!({})).await.expect("worker");
    directory.create_with_id(ThreadId::from("sess_lead1"), header(json!({ "agent": false })), json!({})).await.expect("lead");
    assert_eq!(directory.acting_agent(&ThreadId::from("sess_home_my_bot")).await.expect("home"), "my.bot");
    assert_eq!(directory.acting_agent(&ThreadId::from("sess_w1")).await.expect("worker"), "reviewer");
    assert_eq!(directory.acting_agent(&ThreadId::from("sess_lead1")).await.expect("lead"), "");
    assert!(matches!(directory.acting_agent(&ThreadId::from("sess_missing")).await, Err(CoreError::ThreadNotFound { .. })));
}

/// After a compaction the conversation is the summary alone, so the switch anchors on the
/// summary entry: it has no history row, and the record names the compaction frame.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_model_switch_after_a_compaction_anchors_on_the_summary() {
    use mixdog_store::schema::record::Record;
    let rig = Rig::new();
    let id = ThreadId::from("sess_compacted");
    let item: Record = serde_json::from_value(json!({
        "k": "item", "iid": "u1", "form": "message", "model": true, "visible": true, "role": "user",
        "refs": [], "body": { "inline": { "role": "user", "content": "hi" } },
    }))
    .expect("item");
    let compacted: Record = serde_json::from_value(json!({
        "k": "compacted", "cid": "c1", "summary_iid": "sum1",
        "replacement": { "inline": [{ "iid": "sum1", "body": { "role": "user", "content": "[summary] earlier work" } }] },
    }))
    .expect("compacted");
    rig.store.seed(&id, vec![item, compacted]);
    let directory = SessionDirectory::new(rig.deps());
    let boundary = json!({ "provider": "openai", "modelId": "gpt-next", "at": 300 });
    assert!(super::record_model_switch(&directory, &id, &boundary).await.expect("record"));
    let anchors: Vec<(String, u64)> = rig
        .store
        .records(&id)
        .into_iter()
        .filter_map(|(_, record)| match record {
            Record::ModelSwitch(switch) => Some((switch.anchor.iid.as_str().to_owned(), switch.anchor.ordinal)),
            _ => None,
        })
        .collect();
    assert_eq!(anchors, [("sum1".to_owned(), 1)], "the compaction frame's ordinal");
}

/// A turn that ends in a safety refusal tells the user with Node's warn notice; a turn that ends otherwise does not.
#[tokio::test(start_paused = true)]
async fn a_refused_turn_ends_with_the_refusal_notice() {
    let rig = Rig::new();
    rig.set_script(Arc::new(move |run| {
        Box::pin(async move {
            run.port.input_durable().await.expect("input durable");
            let mut result = mixdog_agent::agent_tool::flow::seams::TurnResult::default();
            result.termination = Some(mixdog_agent::response::Termination::Refusal);
            RunOutcome::Completed(Box::new(result))
        })
    }));
    let directory = SessionDirectory::new(rig.deps());
    let handle = start_thread(&directory).await;
    turn(&handle, "go", "op-1").await;
    eventually_on!(&[&handle.cell.stepped], || idle(&handle).then_some(())).await;
    let shown: Vec<ThreadItem> = handle.cell.view.load_full().items.iter().map(|item| (**item).clone()).collect();
    let notice = shown
        .iter()
        .find_map(|item| match item {
            ThreadItem::StatusRow { kind, meta, .. } if kind == "notice" => Some(serde_json::to_value(meta).expect("meta")),
            _ => None,
        })
        .expect("the refusal notice");
    assert_eq!(
        (notice["ext"]["text"].clone(), notice["ext"]["tone"].clone()),
        (json!("The model refused to respond (safety refusal) — retry or rephrase your prompt."), json!("warn")),
        "{notice}"
    );
}

/// A model call's usage is written to the session header when it is reported (`persistIterationMetrics`), not at
/// the turn's end, and every turn counts its calls under a new id (`bumpUsageMetricsTurnId`).
#[tokio::test(start_paused = true)]
async fn a_model_calls_usage_reaches_the_header_when_it_is_reported() {
    let rig = Rig::new();
    let gate: Arc<tokio::sync::Notify> = Arc::default();
    let release = gate.clone();
    rig.set_script(Arc::new(move |run| {
        let release = release.clone();
        Box::pin(async move {
            run.port.input_durable().await.expect("input durable");
            let usage = mixdog_core_api::domain::provider::Usage {
                input_tokens: 10,
                output_tokens: 5,
                cache_read_tokens: 3,
                cache_write_tokens: 2,
                ..Default::default()
            };
            run.port
                .usage(crate::session::UsageReport {
                    iteration: 1,
                    usage,
                    model: "m".into(),
                    requested_model: "m".into(),
                    delta_tool_calls: 2,
                    request_ms: 340,
                    delta_prompt: 15,
                    send_tools: Vec::new(),
                    reasoning_tokens: Some(4),
                    reasoning_tokens_complete: true,
                    outgoing: Vec::new().into(),
                    sent_at_ms: 4242,
                    input_excludes_cache: false,
                    tail_book: None,
                })
                .await
                .expect("usage");
            release.notified().await;
            RunOutcome::Completed(Default::default())
        })
    }));
    let directory = SessionDirectory::new(rig.deps());
    let handle = start_thread(&directory).await;
    turn(&handle, "go", "op-1").await;
    // While the turn still runs: the call is already counted.
    eventually_on!(&[&handle.cell.stepped], || (handle.live_header().header().get("totalInputTokens") == Some(&json!(10))).then_some(())).await;
    gate.notify_one();
    eventually_on!(&[&handle.cell.stepped], || idle(&handle).then_some(())).await;
    let live = handle.live_header();
    let header = live.header();
    for (key, want) in [
        ("usageMetricsTurnId", json!(1)),
        ("totalInputTokens", json!(10)),
        ("totalOutputTokens", json!(5)),
        ("totalToolCalls", json!(2)),
        ("tokensCumulative", json!(15)),
        ("totalCachedReadTokens", json!(3)),
        ("totalCacheWriteTokens", json!(2)),
        ("totalUncachedInputTokens", json!(5)),
        ("lastContextTokens", json!(10)),
        ("lastIterationIndex", json!(1)),
        ("lastProviderSendAt", json!(4242)),
        ("reasoningUsage", json!({ "reasoningTokens": 4, "reasoningTokensComplete": true })),
        ("usageReadout", json!({ "input": 10, "cacheRead": 3, "cacheWrite": 2, "output": 5, "requestOutputTokens": 5, "requestMs": 340 })),
    ] {
        assert_eq!(header.get(key), Some(&want), "{key}");
    }
}

/// A tool call's arguments streaming (`RunEvent::ToolStream`) reach the stored `lastHeartbeatAt` through the whole
/// path, one write per minute: the first event stamps it, one exactly 60 s later does not, one 1 ms past does.
#[tokio::test(start_paused = true)]
async fn a_streaming_tool_call_stamps_the_stored_heartbeat_once_a_minute() {
    const START: u64 = 1_700_000_000_000;
    let rig = Rig::new();
    rig.clock.0.store(START, std::sync::atomic::Ordering::SeqCst);
    let (tx, rx) = tokio::sync::mpsc::unbounded_channel::<u32>();
    let rx = Arc::new(tokio::sync::Mutex::new(Some(rx)));
    rig.set_script(Arc::new(move |run| {
        let rx = rx.clone();
        Box::pin(async move {
            run.port.input_durable().await.expect("input durable");
            let mut steps = rx.lock().await.take().expect("one run");
            while let Some(step) = steps.recv().await {
                run.port.tool_stream().await.expect("tool stream");
                // The lane is ordered: the call counted here has the stream event before it applied.
                let usage = mixdog_core_api::domain::provider::Usage { input_tokens: 1, output_tokens: 1, ..Default::default() };
                run.port
                    .usage(crate::session::UsageReport {
                        iteration: step,
                        usage,
                        model: "m".into(),
                        requested_model: "m".into(),
                        delta_tool_calls: 0,
                        request_ms: 0,
                        delta_prompt: 1,
                        send_tools: Vec::new(),
                        reasoning_tokens: None,
                        reasoning_tokens_complete: false,
                        outgoing: Vec::new().into(),
                        sent_at_ms: 0,
                        input_excludes_cache: false,
                        tail_book: None,
                    })
                    .await
                    .expect("usage");
            }
            RunOutcome::Completed(Default::default())
        })
    }));
    let directory = SessionDirectory::new(rig.deps());
    let handle = start_thread(&directory).await;
    turn(&handle, "go", "op-1").await;
    for (step, (offset, stamped)) in [(0u64, START), (60_000, START), (60_001, START + 60_001)].into_iter().enumerate() {
        let step = step as u32 + 1;
        rig.clock.0.store(START + offset, std::sync::atomic::Ordering::SeqCst);
        tx.send(step).expect("script alive");
        eventually_on!(&[&handle.cell.stepped], || (handle.live_header().header().get("lastIterationIndex") == Some(&json!(step))).then_some(())).await;
        assert_eq!(handle.live_header().header().get("lastHeartbeatAt"), Some(&json!(stamped)), "at +{offset} ms");
    }
    drop(tx);
    eventually_on!(&[&handle.cell.stepped], || idle(&handle).then_some(())).await;
}

/// The summary model's usage of a compaction pass is a usage report of the turn (`accumulateCompactUsage` ->
/// `onUsageDelta`): it reaches the header totals beside the calls', and does not move the usage epoch.
#[tokio::test(start_paused = true)]
async fn a_compaction_passs_summary_usage_reaches_the_header_totals() {
    let rig = Rig::new();
    rig.set_script(Arc::new(move |run| {
        Box::pin(async move {
            run.port.input_durable().await.expect("input durable");
            let usage = |input| mixdog_core_api::domain::provider::Usage { input_tokens: input, output_tokens: 1, ..Default::default() };
            run.port
                .usage(crate::session::UsageReport {
                    iteration: 1,
                    usage: usage(10),
                    model: "m".into(),
                    requested_model: "m".into(),
                    delta_tool_calls: 0,
                    request_ms: 0,
                    delta_prompt: 10,
                    send_tools: Vec::new(),
                    reasoning_tokens: None,
                    reasoning_tokens_complete: false,
                    outgoing: Vec::new().into(),
                    sent_at_ms: 0,
                    input_excludes_cache: false,
                    tail_book: None,
                })
                .await
                .expect("usage");
            run.port
                .compact_usage(crate::session::CompactUsageReport {
                    iteration: 1,
                    usage: usage(200),
                    reasoning_tokens: None,
                    reasoning_tokens_complete: false,
                    input_excludes_cache: false,
                })
                .await
                .expect("compact usage");
            RunOutcome::Completed(Default::default())
        })
    }));
    let directory = SessionDirectory::new(rig.deps());
    let handle = start_thread(&directory).await;
    turn(&handle, "go", "op-1").await;
    eventually_on!(&[&handle.cell.stepped], || idle(&handle).then_some(())).await;
    let live = handle.live_header();
    let header = live.header();
    assert_eq!(header.get("totalInputTokens"), Some(&json!(210)));
    assert_eq!(header.get("usageMetricsEpoch").and_then(Value::as_u64).unwrap_or(0), 0);
}

/// The Goal runtime with a held `turn_settled`.
pub(crate) struct HeldSettle {
    pub(crate) goals: mixdog_core_goal::goal::GoalRuntime,
    pub(crate) release: Arc<tokio::sync::Notify>,
    pub(crate) settled: Arc<std::sync::atomic::AtomicUsize>,
}

#[async_trait::async_trait]
impl mixdog_core_goal::goal::hooks::GoalTurnHooks for HeldSettle {
    async fn turn_started(&self, thread: &ThreadId) -> mixdog_core_goal::goal::GoalResult<Option<mixdog_core_goal::goal::js::Goal>> {
        mixdog_core_goal::goal::hooks::GoalTurnHooks::turn_started(&self.goals, thread).await
    }
    async fn turn_settled(&self, thread: &ThreadId, detail: Value) -> mixdog_core_goal::goal::GoalResult<Option<mixdog_core_goal::goal::js::Goal>> {
        self.release.notified().await;
        let goal = mixdog_core_goal::goal::hooks::GoalTurnHooks::turn_settled(&self.goals, thread, detail).await;
        self.settled.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        goal
    }
    async fn archive_completed_on_user_input(&self, thread: &ThreadId) -> mixdog_core_goal::goal::GoalResult<Option<mixdog_core_goal::goal::js::Goal>> {
        mixdog_core_goal::goal::hooks::GoalTurnHooks::archive_completed_on_user_input(&self.goals, thread).await
    }
    async fn reactivate_usage_limited(
        &self,
        thread: &ThreadId,
        goal_id: &str,
        admission: mixdog_core_goal::goal::Admission,
    ) -> mixdog_core_goal::goal::GoalResult<Option<mixdog_core_goal::goal::js::Goal>> {
        mixdog_core_goal::goal::hooks::GoalTurnHooks::reactivate_usage_limited(&self.goals, thread, goal_id, admission).await
    }
}

#[async_trait::async_trait]
impl mixdog_core_goal::goal::hooks::GoalContinuationHooks for HeldSettle {
    async fn continuation(
        &self,
        thread: &ThreadId,
        input: mixdog_core_goal::goal::ContinuationInput,
    ) -> mixdog_core_goal::goal::GoalResult<mixdog_core_goal::goal::Continuation> {
        mixdog_core_goal::goal::hooks::GoalContinuationHooks::continuation(&self.goals, thread, input).await
    }
    fn reset_continuation_rules(&self, thread: &ThreadId) -> mixdog_core_goal::goal::GoalResult<()> {
        mixdog_core_goal::goal::hooks::GoalContinuationHooks::reset_continuation_rules(&self.goals, thread)
    }
}

#[async_trait::async_trait]
impl mixdog_core_goal::goal::hooks::GoalViewHooks for HeldSettle {
    async fn goal_status(&self, thread: &ThreadId) -> mixdog_core_goal::goal::GoalResult<Option<mixdog_core_goal::goal::js::Goal>> {
        mixdog_core_goal::goal::hooks::GoalViewHooks::goal_status(&self.goals, thread).await
    }
    async fn stored_goal(&self, thread: &ThreadId) -> mixdog_core_goal::goal::GoalResult<Option<mixdog_core_goal::goal::js::Goal>> {
        mixdog_core_goal::goal::hooks::GoalViewHooks::stored_goal(&self.goals, thread).await
    }
    async fn goal_control(&self, thread: &ThreadId, request: Value) -> mixdog_core_goal::goal::GoalResult<Value> {
        mixdog_core_goal::goal::hooks::GoalViewHooks::goal_control(&self.goals, thread, request).await
    }
    fn on_goal_change(&self, listener: Box<dyn Fn(&mixdog_core_goal::goal::GoalEvent) + Send + Sync>) -> mixdog_core_goal::goal::Subscription {
        mixdog_core_goal::goal::hooks::GoalViewHooks::on_goal_change(&self.goals, listener)
    }
}

/// No reading is asked of it in these tests.
struct NoUsage;

#[async_trait::async_trait]
impl super::quota_resume_host::QuotaUsage for NoUsage {
    async fn usable(&self, _: &str, _: &str) -> Result<bool, super::quota_resume_scheduler::UsageError> {
        unreachable!("the fire is driven directly")
    }
}

/// `thread/clear` resets the environment in the same header change that drops the provider
/// state (`resetSessionBp3Environment`): the `env` block becomes the environment tail alone and
/// the next ask adds the `# Session` block again.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_clear_resets_the_environment_with_the_provider_state() {
    let rig = Rig::new();
    let directory = SessionDirectory::new(rig.deps());
    let handle = start_thread(&directory).await;
    let patch = json!({
        "threadId": handle.id,
        "set": {
            "providerState": { "x": 1 },
            "bp3EnvSplit": true,
            "promptEnv": "# Session\nold\n\ntail",
            "bp3EnvironmentContext": "tail",
            "sessionStartMetaInjected": true,
        },
    });
    handle.request(CoreRequest { method: Method("thread/header/patch"), params: patch, op: None, ctx: CallContext::internal("test") }).await.expect("patch");
    let expected = rig.route_change.environment_reset(&handle.cell.header.load());
    handle.request(request("thread/clear", json!({ "threadId": handle.id, "opId": "op-clear" }), "op-clear")).await.expect("clear");
    let header = handle.cell.header.load_full();
    assert!(header.get("providerState").is_none());
    assert_eq!((header.get("promptEnv"), header.get("sessionStartMetaInjected")), (Some(&json!("tail")), Some(&json!(false))));
    for (key, value) in &expected.set {
        assert_eq!(header.get(key), Some(value), "{key}");
    }
    for key in &expected.unset {
        assert!(header.get(key).is_none(), "{key}");
    }
}

/// A subscriber attaches (the counting `FeedSource::attach` does around the feed).
fn subscribe(handle: &SessionHandle) {
    assert!(handle.cell.subscribing());
    handle.cell.subscribed(true);
}

/// Attach and close are transitions of one word, so exactly one of a racing attach and a
/// delete's close wins, whichever reads first; a close that won refuses every later attach, an
/// attach that won refuses the close, and a detach reopens nothing.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn an_attach_and_a_delete_admission_never_both_win() {
    use std::sync::atomic::Ordering::SeqCst;
    let rig = Rig::new();
    let directory = SessionDirectory::new(rig.deps());
    for round in 0..40 {
        let cell = start_thread(&directory).await.cell.clone();
        let gate = Arc::new(std::sync::Barrier::new(2));
        let (a, g) = (cell.clone(), gate.clone());
        let attach = std::thread::spawn(move || {
            g.wait();
            a.subscribing()
        });
        let seen = cell.admission();
        gate.wait();
        let closed = cell.close_if_unchanged(seen);
        let attached = attach.join().unwrap();
        assert!(closed ^ attached, "round {round}: exactly one wins (closed={closed}, attached={attached})");
        assert_eq!(cell.attached(), usize::from(attached));
        assert_eq!(cell.closed.load(SeqCst), closed);
        assert!(!closed || !cell.subscribing(), "a closed thread takes no attach");
    }
}

/// The delete read the word (never attached), an attach and its detach run, and only then does
/// the delete close: the count is back at zero, but the word is not what the delete read, so the
/// close is refused and the thread still takes attaches. No second field can drift from it.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_close_from_a_stale_admission_word_is_refused_after_an_attach_and_detach() {
    let rig = Rig::new();
    let directory = SessionDirectory::new(rig.deps());
    let handle = start_thread(&directory).await;
    let cell = handle.cell.clone();

    let seen = cell.admission();
    assert_eq!(seen, 0, "open and never attached");
    // An attach that is admitted and then rolled back (the detach that tells no actor, so the
    // thread stays loaded for the rest of the test).
    assert!(cell.subscribing());
    cell.subscribed(false);
    assert_eq!(cell.attached(), 0, "the count is back at zero");

    assert!(!cell.close_if_unchanged(seen), "the attach in between refuses the close");
    assert!(!cell.closed.load(std::sync::atomic::Ordering::SeqCst), "nothing was closed");
    assert!(cell.subscribing(), "the thread still takes attaches");
    cell.subscribed(false);

    // Read afresh, it is the unload's business (ever attached, nobody now); a close from it
    // takes the word once, and a second close from the same word cannot.
    let fresh = cell.admission();
    assert_ne!(fresh, seen, "the word keeps the attach in its history");
    assert!(cell.close_if_unchanged(fresh));
    assert!(!cell.close_if_unchanged(fresh), "the word is taken");
    assert!(!cell.subscribing(), "a closed thread takes no attach");
}

#[tokio::test(start_paused = true)]
async fn a_completed_turn_goes_to_session_search_with_its_model_context() {
    let rig = Rig::new();
    rig.set_script(echo());
    let directory = SessionDirectory::new(rig.deps());
    let handle = start_thread(&directory).await;
    turn(&handle, "hello", "op-1").await;
    eventually_on!(&[&rig.ingests.1], || (lock(&rig.ingests.0).len() == 1).then_some(())).await;
    let (thread, messages) = lock(&rig.ingests.0)[0].clone();
    assert_eq!(thread, handle.id);
    assert_eq!(messages.len(), 2, "the input row and the reply: {messages:?}");
    assert_eq!(messages[1]["text"], "re: hello");
}

/// A value a call marked sensitive (`rememberSensitiveValues`, before the assistant row carrying it is committed) is in
/// no record the log is handed: the row is stored through the sensitive projection (`_messageForDisk`). The thread's
/// model context still reads the row as it was committed, as Node's loaded session keeps it (`sensitive-values.mjs:7-9`).
#[tokio::test(start_paused = true)]
async fn a_sensitive_value_never_reaches_the_log_and_the_model_context_keeps_it() {
    const CODE: &str = "482913";
    let rig = Rig::new();
    let committed = json!({
        "role": "assistant",
        "content": "",
        "toolCalls": [{ "id": "c1", "name": "browser", "arguments": { "action": "fill", "input": { "sensitive": true, "text": CODE } } }],
    });
    let body = committed.clone();
    rig.set_script(Arc::new(move |run| {
        let body = body.clone();
        Box::pin(async move {
            run.port.input_durable().await.expect("input durable");
            assert!(run.context.remember_sensitive(&[body["toolCalls"][0].clone()]), "the fill's value is marked");
            let row = ItemCommit { iid: ItemId::from("a-1"), role: Some("assistant".into()), model: true, visible: true, body, prompt: None };
            run.port.commit_item(row).await.expect("assistant row");
            RunOutcome::Completed(Default::default())
        })
    }));
    let directory = SessionDirectory::new(rig.deps());
    let handle = start_thread(&directory).await;
    turn(&handle, "fill the code", "op-1").await;
    let stored = eventually_on!(&[&rig.store.committed], || {
        rig.store.records(&handle.id).into_iter().find_map(|(_, record)| match record {
            mixdog_store::schema::record::Record::Item(row) if row.iid.as_str() == "a-1" => Some(row.body),
            _ => None,
        })
    })
    .await;
    let mixdog_store::schema::blob::Slot::Inline(stored) = stored else { panic!("an inline body") };
    for record in rig.store.records(&handle.id) {
        let bytes = serde_json::to_string(&record.1).expect("record json");
        assert!(!bytes.contains(CODE), "record {} holds the value: {bytes}", record.0);
    }
    assert_eq!(stored, rig.sensitive.redact_message(handle.id.as_str(), &committed), "stored as the projection stores it");
    let context = directory.model_context(&handle.id).read().await.expect("context");
    let row = context.iter().find(|(iid, _)| iid.as_str() == "a-1").expect("the assistant row");
    assert_eq!(row.1, committed, "the model context keeps the row as committed");
}

#[tokio::test(start_paused = true)]
async fn a_saved_provider_state_reaches_the_next_turn_whole_and_a_clear_drops_it() {
    use mixdog_core_api::domain::provider::ProviderState;

    let rig = Rig::new();
    let seen: Arc<Mutex<Vec<Option<ProviderState>>>> = Arc::default();
    let saved = ProviderState { gemini: None, rest: json!({ "xaiResponses": { "previousResponseId": "r1" } }).as_object().cloned().expect("object") };
    let (seen_in, saved_in) = (seen.clone(), saved.clone());
    rig.set_script(Arc::new(move |run| {
        let (seen, saved) = (seen_in.clone(), saved_in.clone());
        Box::pin(async move {
            run.port.input_durable().await.expect("input durable");
            let state = run.port.provider_state().await;
            lock(&seen).push(state);
            run.port.save_provider_state(Some(saved)).await.expect("saved");
            RunOutcome::Completed(Default::default())
        })
    }));
    let directory = SessionDirectory::new(rig.deps());
    let handle = start_thread(&directory).await;
    turn(&handle, "one", "op-1").await;
    eventually_on!(&[&handle.cell.stepped], || (idle(&handle) && lock(&seen).len() == 1).then_some(())).await;
    turn(&handle, "two", "op-2").await;
    eventually_on!(&[&handle.cell.stepped], || (idle(&handle) && lock(&seen).len() == 2).then_some(())).await;
    assert_eq!(lock(&seen).clone(), vec![None, Some(saved.clone())]);
    assert_eq!(handle.live_header().header().get("providerState"), Some(&json!({ "xaiResponses": { "previousResponseId": "r1" } })));

    handle.request(request("thread/clear", json!({ "threadId": handle.id, "opId": "op-3" }), "op-3")).await.expect("clear");
    assert_eq!(handle.live_header().header().get("providerState"), None);
}

#[tokio::test(start_paused = true)]
async fn a_tool_result_completes_its_call_in_place() {
    let rig = Rig::new();
    rig.set_script(Arc::new(|run| {
        Box::pin(async move {
            run.port.input_durable().await.expect("input durable");
            let call = json!({ "id": "c1", "name": "shell", "arguments": { "command": "ls" } });
            run.port
                .commit_item(ItemCommit {
                    iid: ItemId::from(format!("a-{}", run.turn)),
                    role: Some("assistant".into()),
                    model: true,
                    visible: true,
                    body: json!({ "text": "listing", "toolCalls": [call] }),
                    prompt: None,
                })
                .await
                .expect("call");
            run.port
                .commit_item(ItemCommit {
                    iid: ItemId::from(format!("t-{}", run.turn)),
                    role: Some("tool".into()),
                    model: true,
                    visible: true,
                    body: json!({ "toolCallId": "c1", "text": "a.txt" }),
                    prompt: None,
                })
                .await
                .expect("result");
            RunOutcome::Completed(Default::default())
        })
    }));
    let directory = SessionDirectory::new(rig.deps());
    let handle = start_thread(&directory).await;
    turn(&handle, "ls", "op-1").await;
    // A turn that opened a tool card is not a no-op, so it ends with its live turn end (`turnDoneItem`,
    // `isNoOpTurn`): the user row, the reply, the call, then the end.
    eventually_on!(&[&handle.cell.stepped], || (idle(&handle) && rows(&handle).len() == 4).then_some(())).await;
    assert!(matches!(handle.cell.view.load_full().items.last().map(|item| item.as_ref()), Some(ThreadItem::TurnEnd { .. })), "the turn ends with its live end");

    let call = handle.cell.view.load_full().items.iter().find(|item| item.id().as_str() == "call:c1").cloned().expect("call item");
    let ThreadItem::ToolCall { name, input, run, .. } = call.as_ref() else {
        panic!("tool call");
    };
    assert_eq!(name, "shell");
    assert_eq!(input["command"], "ls");
    assert_eq!(run.result, Some(mixdog_protocol::MaybeBlob::Inline("a.txt".into())));
    // Both the call and its merged result were published as `item/completed`.
    let completed: Vec<Value> = rig
        .feeds
        .frames(handle.id.as_str())
        .into_iter()
        .filter(|(_, method, params)| method == "item/completed" && params["item"]["id"] == "call:c1")
        .map(|(_, _, params)| params["item"]["run"]["result"].clone())
        .collect();
    assert_eq!(completed.len(), 2);
    assert_eq!(completed[1], "a.txt");
}

/// A live card starts when its call is recorded and completes when its result lands (Node stamps `completedAt: Date.now()` as the
/// result is applied, `tool-card-results/aggregate-result.mjs:30-46`): the result's time, not the call's again.
#[tokio::test(start_paused = true)]
async fn a_live_tool_card_completes_at_its_result() {
    use std::sync::atomic::Ordering;
    let rig = Rig::new();
    let clock = rig.clock.clone();
    rig.set_script(Arc::new(move |run| {
        let clock = clock.clone();
        Box::pin(async move {
            run.port.input_durable().await.expect("input durable");
            clock.0.store(2_000, Ordering::SeqCst);
            let call = json!({ "id": "c1", "name": "shell", "arguments": { "command": "ls" } });
            run.port
                .commit_item(ItemCommit {
                    iid: ItemId::from(format!("a-{}", run.turn)),
                    role: Some("assistant".into()),
                    model: true,
                    visible: true,
                    body: json!({ "text": "listing", "toolCalls": [call] }),
                    prompt: None,
                })
                .await
                .expect("call");
            clock.0.store(2_015, Ordering::SeqCst);
            run.port
                .commit_item(ItemCommit {
                    iid: ItemId::from(format!("t-{}", run.turn)),
                    role: Some("tool".into()),
                    model: true,
                    visible: true,
                    body: json!({ "toolCallId": "c1", "text": "a.txt" }),
                    prompt: None,
                })
                .await
                .expect("result");
            RunOutcome::Completed(Default::default())
        })
    }));
    let directory = SessionDirectory::new(rig.deps());
    let handle = start_thread(&directory).await;
    turn(&handle, "ls", "op-1").await;
    eventually_on!(&[&handle.cell.stepped], || (idle(&handle) && rows(&handle).len() == 4).then_some(())).await;
    let view = handle.cell.view.load_full();
    let call = view.items.iter().find(|item| item.id().as_str() == "call:c1").expect("call item");
    let ThreadItem::ToolCall { run, .. } = call.as_ref() else {
        panic!("tool call");
    };
    assert_eq!(run.completed_at, Some(2_015), "completed at the result");
    let completed: Vec<Value> = rig
        .feeds
        .frames(handle.id.as_str())
        .into_iter()
        .filter(|(_, method, params)| method == "item/completed" && params["item"]["id"] == "call:c1")
        .map(|(_, _, params)| params["item"]["run"]["completedAt"].clone())
        .collect();
    assert_eq!(completed, vec![Value::Null, json!(2_015)], "the call's frame is open, the result's carries the card's completion");
}

#[tokio::test(start_paused = true)]
async fn runs_get_the_sessions_tool_surface() {
    let rig = Rig::new();
    let seen: Arc<Mutex<Vec<Vec<String>>>> = Arc::default();
    let record = seen.clone();
    rig.set_script(Arc::new(move |run| {
        let record = record.clone();
        Box::pin(async move {
            lock(&record).push(run.surface.borrow().disallowed.clone());
            RunOutcome::Completed(Default::default())
        })
    }));
    let directory = SessionDirectory::new(rig.deps());
    let handle = start_thread(&directory).await;
    turn(&handle, "go", "op-1").await;
    eventually_on!(&[&handle.cell.stepped], || (lock(&seen).len() == 1).then_some(())).await;
    // A user thread denies the Lead-only goal tools (`createSession`'s `disallowedTools`,
    // `LEAD_DISALLOWED_TOOLS`, `tool-defs.mjs:228`).
    assert_eq!(lock(&seen)[0], ["get_goal", "create_goal", "set_goal_tasks", "update_goal"]);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn the_live_header_follows_acked_header_changes() {
    let rig = Rig::new();
    let directory = SessionDirectory::new(rig.deps());
    let handle = start_thread(&directory).await;
    let live = handle.live_header();
    assert_ne!(live.header().get("title"), Some(&json!("renamed")));
    handle.request(request("thread/name/set", json!({ "threadId": handle.id, "opId": "op-1", "title": "renamed" }), "op-1")).await.expect("name/set");
    assert_eq!(live.header().get("title"), Some(&json!("renamed")));
}

struct StoredPrompt {
    _first: SessionDirectory,
    _second: SessionDirectory,
    handle: Arc<SessionHandle>,
    paste: String,
    image: String,
}

async fn stored_prompt_with_attachments(rig: &Rig) -> StoredPrompt {
    use sha2::Digest;

    let deps = Arc::new(rig.deps_parts(rig.store.clone()));
    let root = rig._data.path().to_path_buf();
    let first = SessionDirectory::new(deps.clone());
    let id = start_thread(&first).await.id.clone();
    let blob = |bytes: &[u8]| {
        let reference = format!("{:x}", sha2::Sha256::digest(bytes));
        let dir = root.join(mixdog_store::schema::blob::BLOB_DIR).join(&reference[..2]);
        std::fs::create_dir_all(&dir).expect("blob dir");
        std::fs::write(dir.join(&reference), bytes).expect("blob");
        reference
    };
    let (paste, image, pdf) = (blob(b"pasted body"), blob(&[1, 2, 3]), blob(b"%PDF-1.7"));
    let gone = "e".repeat(64);
    let content = json!([
        { "type": "text", "text": "see [Pasted text #1 +1 lines] [Image #2] [Image #3]" },
        { "type": "text", "textKind": "paste", "attachmentRef": paste, "sizeBytes": 11 },
        { "type": "image", "attachmentRef": image, "sizeBytes": 3, "mimeType": "image/png" },
        { "type": "image", "attachmentRef": gone, "sizeBytes": 4, "mimeType": "image/png" },
        { "type": "file", "attachmentRef": pdf, "mimeType": "application/pdf", "filename": "r.pdf" },
    ]);
    let record: mixdog_store::schema::record::ItemRecord = serde_json::from_value(json!({
        "iid": "u1", "role": "user", "form": "message", "model": true, "visible": true, "refs": [],
        "prompt": { "inline": "see [Pasted text #1 +1 lines] [Image #2] [Image #3]" },
        "body": { "inline": { "role": "user", "content": content } },
    }))
    .expect("an item record");
    rig.store.seed(&id, vec![mixdog_store::schema::record::Record::Item(record)]);

    let second = SessionDirectory::new(deps);
    let handle = second.open_handle(&id, &CallContext::internal("test")).await.expect("open");
    StoredPrompt { _first: first, _second: second, handle, paste, image }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_rewind_refuses_a_composer_that_cannot_hold_the_prompts_files_and_leaves_the_conversation() {
    let rig = Rig::new();
    let stored = stored_prompt_with_attachments(&rig).await;
    let id = stored.handle.id.clone();
    let refused =
        stored.handle.request(request("thread/rewind", json!({ "threadId": id, "opId": "op-r1", "itemId": "u1", "restoreFiles": false }), "op-r1")).await;
    let Err(CoreError::DomainError { message, .. }) = refused else { panic!("a refusal") };
    assert_eq!(message.as_deref(), Some("this message has PDF/Office attachments the terminal composer cannot restore; edit it in the desktop app"));

    let reply = stored
        .handle
        .request(request("thread/rewind", json!({ "threadId": id, "opId": "op-r2", "itemId": "u1" }), "op-r2"))
        .await
        .expect("the same prompt is still there to rewind to");
    assert!(matches!(reply, Reply::Value(_)), "{reply:?}");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_rewind_hands_back_the_prompts_attachments_and_counts_the_one_that_is_gone() {
    let rig = Rig::new();
    let stored = stored_prompt_with_attachments(&rig).await;
    let id = stored.handle.id.clone();
    let reply = stored.handle.request(request("thread/rewind", json!({ "threadId": id, "opId": "op-r2", "itemId": "u1" }), "op-r2")).await.expect("rewind");
    let Reply::Value(value) = reply else { panic!("a value") };
    assert_eq!(value["text"], json!("see [Pasted text #1 +1 lines] [Image #2] [Image #3]"), "{value}");
    assert_eq!(
        value["pastedTexts"],
        json!({ "1": { "id": 1, "source": "paste", "attachmentRef": stored.paste, "sizeBytes": 11, "text": "pasted body" } }),
        "{value}"
    );
    assert_eq!(
        value["pastedImages"],
        json!({ "2": { "id": 2, "type": "image", "mediaType": "image/png", "attachmentRef": stored.image, "sizeBytes": 3, "content": "AQID" } }),
        "{value}"
    );
    assert_eq!(value["content"], json!([{ "type": "file", "data": "JVBERi0xLjc=", "mimeType": "application/pdf", "filename": "r.pdf" }]), "{value}");
    assert_eq!(value["notice"], json!("1 attachment was no longer available and dropped."), "{value}");
}

fn log_ids(rig: &Rig) -> std::collections::BTreeSet<String> {
    rig.store.log_ids().iter().map(|id| id.as_str().to_owned()).collect()
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_persons_clear_of_a_conversation_nobody_spoke_in_keeps_no_copy() {
    let rig = Rig::new();
    rig.set_script(echo());
    let directory = SessionDirectory::new(rig.deps());
    let handle = start_thread(&directory).await;
    handle.request(request("thread/clear", json!({ "threadId": handle.id, "opId": "op-c0" }), "op-c0")).await.expect("clear");
    assert_eq!(log_ids(&rig).len(), 1, "an empty conversation keeps no copy");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_persons_clear_keeps_the_conversation_as_a_session_of_its_own_and_records_when() {
    let rig = Rig::new();
    rig.set_script(echo());
    let directory = SessionDirectory::new(rig.deps());
    let handle = start_thread(&directory).await;
    turn(&handle, "one", "op-1").await;
    eventually_on!(&[&handle.cell.stepped], || (settled_idle(&handle) && rows(&handle).len() == 2).then_some(())).await;
    let before = log_ids(&rig);
    handle.request(request("thread/clear", json!({ "threadId": handle.id, "opId": "op-c1" }), "op-c1")).await.expect("clear");
    eventually_on!(&[&handle.cell.stepped], || rows(&handle).is_empty().then_some(())).await;
    let copies: Vec<String> = log_ids(&rig).difference(&before).cloned().collect();
    let [copy] = copies.as_slice() else { panic!("one copy of the cleared conversation: {copies:?}") };
    assert!(copy.starts_with("sess_"), "{copy}");
    let copy = ThreadId::from(copy.as_str());
    let read = CoreRequest {
        method: Method("thread/modelMessages/list"),
        params: json!({ "threadId": copy, "start": 0 }),
        op: None,
        ctx: CallContext::internal("test"),
    };
    let Reply::Value(listed) = directory.request(read).await.expect("the copy's conversation") else { panic!("a value") };
    let said: Vec<&str> =
        listed["messages"].as_array().expect("messages").iter().filter(|m| m["role"] == "user").filter_map(|m| m["content"].as_str()).collect();
    assert!(said.contains(&"one"), "the copy holds what was said: {listed}");

    let header = rig.store.stored_header(&handle.id).expect("the cleared session's header");
    let compaction = &header["compaction"];
    assert_eq!(compaction["lastStage"], json!("auto_clear"), "{compaction}");
    let now = rig.clock.0.load(std::sync::atomic::Ordering::SeqCst);
    assert_eq!(compaction["lastClearAt"], json!(now), "{compaction}");
    assert_eq!(compaction["lastCheckedAt"], json!(now), "{compaction}");
    assert_eq!(compaction["lastClearCompactError"], Value::Null);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn an_internal_reset_makes_no_copy_of_its_own() {
    let rig = Rig::new();
    rig.set_script(echo());
    let directory = SessionDirectory::new(rig.deps());
    let handle = start_thread(&directory).await;
    turn(&handle, "two", "op-2").await;
    eventually_on!(&[&handle.cell.stepped], || (idle(&handle) && rows(&handle).len() == 2).then_some(())).await;
    let before = log_ids(&rig);
    let own = CoreRequest {
        method: Method("thread/clear"),
        params: json!({ "threadId": handle.id, "opId": "op-c2" }),
        op: Some(OpId::from("op-c2")),
        ctx: CallContext::internal("test"),
    };
    handle.request(own).await.expect("clear");
    assert_eq!(log_ids(&rig), before, "an internal reset makes no copy of its own");
}

// ---- the retained working indicator: a run stage is the spinner's state, not an event a client reconstructs ----

/// The spinner of the acked view, as every client folds it.
fn spinner_of(handle: &SessionHandle) -> Option<Value> {
    handle.cell.view.load_full().state.runtime.as_ref().and_then(|runtime| runtime.spinner.clone())
}

/// One turn whose script performs `steps` in order and ends as `ending` says. `hold` waits for `gate`; a stage sent after the run
/// ended (`late`) is raised by a task of the run's own port once `late` is notified.
struct StageTurn {
    _directory: SessionDirectory,
    handle: Arc<SessionHandle>,
    gate: Arc<tokio::sync::Notify>,
    late: Arc<tokio::sync::Notify>,
    turn_id: TurnId,
}

async fn spinner_where(rig: &Rig, run: &StageTurn, _what: &str, ok: impl Fn(&Value) -> bool) -> Value {
    eventually_on!(&[&rig.feeds.published, &run.handle.cell.stepped], || spinner_of(&run.handle).filter(|spinner| ok(spinner))).await
}

async fn spinner_gone(rig: &Rig, run: &StageTurn) {
    eventually_on!(&[&rig.feeds.published, &run.handle.cell.stepped], || (idle(&run.handle) && spinner_of(&run.handle).is_none()).then_some(())).await;
}

/// A client attaching now: the spinner its first snapshot carries.
async fn attached_spinner(handle: &Arc<SessionHandle>, connection: u64) -> Value {
    use mixdog_core_api::mock::{MockConnection, MockLimits};
    use mixdog_core_api::sink::ConnectionSink;
    let resume = request("thread/resume", json!({ "threadId": handle.id, "window": { "lastItems": 10 } }), &format!("op-resume-{connection}"));
    let Reply::Subscribe(resumed) = handle.request(resume).await.expect("thread/resume") else { panic!("thread/resume subscribes") };
    let client = MockConnection::new(ConnectionId(connection), MockLimits::default());
    let attached =
        mixdog_core_api::feed::subscribe(&resumed.feed, mixdog_core_api::ids::SubscriptionId::from("client"), resumed.window, None, &client).expect("attach");
    client.send_control_release(bytes::Bytes::from_static(b"{}"), attached.release).expect("release");
    let texts = client.drain_text_until(|texts| texts.iter().any(|text| text.contains("thread/snapshot"))).await;
    // `drain_text` names the lane before the frame (`<subscription>:{...}`).
    let frame = texts.iter().find(|text| text.contains("thread/snapshot")).expect("a snapshot");
    serde_json::from_str::<Value>(&frame[frame.find('{').expect("a json frame")..]).expect("a frame")["params"]["state"]["runtime"]["spinner"].clone()
}

/// The Rig's Goal timers fire at their time on the test runtime's clock (here paused, so exactly),
/// and a cancelled one never fires.
#[tokio::test(start_paused = true)]
async fn the_rigs_goal_timers_follow_the_test_clock_and_cancel() {
    use std::sync::atomic::Ordering::SeqCst;

    use mixdog_core_goal::goal::GoalTimers;
    use mixdog_core_goal::goal::TimerKind;

    let fired = Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let (due, never) = (fired.clone(), fired.clone());
    let timers = super::testing::RigGoalTimers;
    let _due = timers.after(
        TimerKind::Deadline,
        60_000.0,
        Box::new(move || {
            due.fetch_add(1, SeqCst);
        }),
    );
    let cancelled = timers.after(
        TimerKind::Warning,
        30_000.0,
        Box::new(move || {
            never.fetch_add(10, SeqCst);
        }),
    );
    cancelled.cancel();
    mixdog_rt::time::sleep(Duration::from_secs(59)).await;
    assert_eq!(fired.load(SeqCst), 0, "not before its time");
    mixdog_rt::time::sleep(Duration::from_secs(2)).await;
    assert_eq!(fired.load(SeqCst), 1, "the due one fired once; the cancelled one never");
}

#[tokio::test(start_paused = true)]
async fn prompt_history_follows_todays_derivation_and_updates_incrementally() {
    let rig = Rig::new();
    rig.set_script(echo());
    let file = rig.prompts.file("/ws").expect("history file");
    crate::session::fixture_fs::write(&file, br#"{"version":1,"entries":["older","one"]}"#);
    let directory = SessionDirectory::new(rig.deps());
    let handle = start_thread(&directory).await;
    eventually_on!(&[&handle.cell.stepped], || (prompt_list(&handle) == ["one", "older"]).then_some(())).await;

    turn(&handle, "two", "op-1").await;
    eventually_on!(&[&handle.cell.stepped], || idle(&handle).then_some(())).await;
    turn(&handle, "  one  ", "op-2").await;
    eventually_on!(&[&handle.cell.stepped], || (idle(&handle) && rows(&handle).len() == 4).then_some(())).await;
    eventually_on!(&[&handle.cell.stepped], || (prompt_list(&handle) == ["one", "two", "older"]).then_some(())).await;
    // The persisted history of the cwd took both submits (`appendPromptHistory`), written behind
    // the window (`WRITE_BEHIND_MS`) after the last of them.
    let want = json!({ "version": 1, "entries": ["older", "two", "one"] });
    tokio::time::advance(Duration::from_millis(super::prompt_history::WRITE_BEHIND_MS)).await;
    let saved = eventually_on!(&[&*rig.prompts_wrote], || {
        let text = crate::session::fixture_fs::read_to_string(&file).ok()?;
        serde_json::from_str::<Value>(&text).ok().filter(|saved| *saved == want)
    })
    .await;
    assert_eq!(saved, want);

    let updates: Vec<Value> = rig
        .feeds
        .frames(handle.id.as_str())
        .into_iter()
        .filter(|(_, method, _)| method == "thread/promptHistory/updated")
        .map(|(_, _, params)| params["value"].clone())
        .collect();
    assert!(updates.contains(&json!({ "kind": "added", "prompt": "two" })));
    assert!(updates.contains(&json!({ "kind": "added", "prompt": "one" })));

    // Rewind to the second prompt: its text returns to the composer and leaves the list.
    let second = handle.cell.view.load_full().items[2].id().clone();
    let reply = handle.request(request("thread/rewind", json!({ "threadId": handle.id, "opId": "op-3", "itemId": second }), "op-3")).await.expect("rewind");
    let Reply::Value(value) = reply else { panic!() };
    assert_eq!(value["text"], "one");
    eventually_on!(&[&handle.cell.stepped], || (rows(&handle).len() == 2).then_some(())).await;
    assert_eq!(prompt_list(&handle), ["two", "older"]);
    let frames = rig.feeds.frames(handle.id.as_str());
    let reset = frames.iter().find(|(_, method, _)| method == "thread/historyReset").expect("historyReset");
    assert_eq!(reset.2["hasOlder"], false);
    assert_eq!(
        frames.last().map(|(_, m, p)| (m.as_str(), p["value"].clone())),
        Some(("thread/promptHistory/updated", json!({ "kind": "replaced", "prompts": ["two", "older"] })))
    );
}

/// A kickoff pushes no user row in Node (drain.mjs `renderBatchItems` skips `suppressDisplay`), so it never reaches the prompt
/// history, neither the session's list nor the cwd's file (recorded: `running-runtime-turn`'s states keep `promptHistoryList` empty).
#[tokio::test(start_paused = true)]
async fn a_kickoff_stays_out_of_the_prompt_history() {
    let rig = Rig::new();
    let file = rig.prompts.file("/ws").expect("history file");
    let directory = SessionDirectory::new(rig.deps());
    let handle = start_thread(&directory).await;
    handle
        .request(request(
            "turn/start",
            json!({ "threadId": handle.id, "opId": "op-1", "input": { "prompt": "greet the user", "options": { "clientSubmissionId": "sub-k", "kickoff": true } } }),
            "op-1",
        ))
        .await
        .expect("started");
    eventually_on!(&[&handle.cell.stepped], || idle(&handle).then_some(())).await;
    turn(&handle, "typed", "op-2").await;
    eventually_on!(&[&handle.cell.stepped], || (idle(&handle) && prompt_list(&handle) == ["typed"]).then_some(())).await;
    tokio::time::advance(Duration::from_millis(super::prompt_history::WRITE_BEHIND_MS)).await;
    let want = json!({ "version": 1, "entries": ["typed"] });
    let saved = eventually_on!(&[&*rig.prompts_wrote], || {
        let text = crate::session::fixture_fs::read_to_string(&file).ok()?;
        serde_json::from_str::<Value>(&text).ok().filter(|saved| *saved == want)
    })
    .await;
    assert_eq!(saved, want);
    let added: Vec<Value> = rig
        .feeds
        .frames(handle.id.as_str())
        .into_iter()
        .filter(|(_, method, _)| method == "thread/promptHistory/updated")
        .map(|(_, _, params)| params["value"].clone())
        .collect();
    assert_eq!(added, vec![json!({ "kind": "added", "prompt": "typed" })]);
}

/// The spinner follows a tool batch as Node's turn sets it: `tool-use` as the batch opens (`openToolCalls`,
/// `closeThinkingForToolBatch`), `tool-approval` while a call waits for the person (`approveToolRequest`), `requesting` once the
/// batch is over (`onToolPhaseCompleted`; recorded: `running-approval-pending`'s states show `tool-approval`, then `tool-use`).
#[tokio::test(start_paused = true)]
async fn the_spinner_follows_a_tool_batch() {
    use super::run::CallMark;
    let rig = Rig::new();
    rig.set_script(Arc::new(move |run| {
        Box::pin(async move {
            run.port.input_durable().await.expect("input durable");
            for mark in [CallMark::Streaming, CallMark::ToolCall, CallMark::ToolApproval, CallMark::ToolPhaseCompleted] {
                run.port.call_mark(mark).await.expect("shown");
            }
            RunOutcome::Completed(Default::default())
        })
    }));
    let directory = SessionDirectory::new(rig.deps());
    let handle = start_thread(&directory).await;
    turn(&handle, "use a tool", "op-1").await;
    eventually_on!(&[&handle.cell.stepped], || idle(&handle).then_some(())).await;
    let mut modes: Vec<String> = Vec::new();
    for (_, method, params) in rig.feeds.frames(handle.id.as_str()) {
        if method != "thread/runtime/updated" {
            continue;
        }
        if let Some(mode) = params["value"]["spinner"]["mode"].as_str()
            && modes.last().map(String::as_str) != Some(mode)
        {
            modes.push(mode.to_owned());
        }
    }
    assert_eq!(modes, ["requesting", "responding", "tool-use", "tool-approval", "requesting"]);
}

/// A batch holding a `task wait` (no card of its own) shows as the spinner's `task-wait` until the wait settles, then `tool-use`
/// again (`taskWaitSpinnerMode`, `refreshTaskWaitSpinner`): the turn reads as waiting, not thinking.
#[tokio::test(start_paused = true)]
async fn the_spinner_shows_a_task_wait_until_it_settles() {
    use super::run::CallMark;
    let rig = Rig::new();
    rig.set_script(Arc::new(move |run| {
        Box::pin(async move {
            run.port.input_durable().await.expect("input durable");
            for mark in [CallMark::ToolCall, CallMark::TaskWait(true), CallMark::TaskWait(false), CallMark::ToolPhaseCompleted] {
                run.port.call_mark(mark).await.expect("shown");
            }
            RunOutcome::Completed(Default::default())
        })
    }));
    let directory = SessionDirectory::new(rig.deps());
    let handle = start_thread(&directory).await;
    turn(&handle, "wait on a task", "op-1").await;
    eventually_on!(&[&handle.cell.stepped], || idle(&handle).then_some(())).await;
    let mut modes: Vec<String> = Vec::new();
    for (_, method, params) in rig.feeds.frames(handle.id.as_str()) {
        if method != "thread/runtime/updated" {
            continue;
        }
        if let Some(mode) = params["value"]["spinner"]["mode"].as_str()
            && modes.last().map(String::as_str) != Some(mode)
        {
            modes.push(mode.to_owned());
        }
    }
    assert_eq!(modes, ["requesting", "tool-use", "task-wait", "tool-use", "requesting"]);
}

#[tokio::test(start_paused = true)]
async fn input_and_task_notifications_release_the_runs_wait() {
    use mixdog_tools::exec::TaskNotifier;
    use mixdog_tools::exec::WakeReason;
    let rig = Rig::new();
    let wakes = rig.wakes.clone();
    let reasons: Arc<Mutex<Vec<WakeReason>>> = Arc::default();
    let seen = reasons.clone();
    let inputs: Arc<Mutex<Vec<Value>>> = Arc::default();
    let bodies = inputs.clone();
    // Told after each wait the run begins, each reason it records and each input it takes.
    let progress = Arc::new(tokio::sync::Notify::new());
    let told = progress.clone();
    // The first run's `task wait`, twice: once released by new input, once by a notification. A queued user message holds every
    // wait released until a model-call boundary delivers it (`WakeHub::boundary`), so between the two the run takes its boundary,
    // as the model's next call does, and the queued prompt is delivered into this turn.
    let delivered: Arc<Mutex<Vec<Value>>> = Arc::default();
    let given = delivered.clone();
    rig.set_script(Arc::new(move |run| {
        let wakes = wakes.clone();
        let seen = seen.clone();
        let told = told.clone();
        let given = given.clone();
        let first = {
            let mut bodies = lock(&bodies);
            bodies.push(run.input_body.clone());
            bodies.len() == 1
        };
        told.notify_waiters();
        Box::pin(async move {
            for round in 0..usize::from(first) * 2 {
                let wait = wakes.begin(&run.thread);
                told.notify_waiters();
                wait.released().await;
                lock(&seen).push(wait.wake().expect("released").reason);
                drop(wait);
                if round == 0 {
                    let steers = run.port.take_steers(drain(DrainStage::Terminal)).await.expect("take");
                    lock(&given).extend(steers.into_iter().map(|steer| steer.content));
                }
                told.notify_waiters();
            }
            RunOutcome::Completed(Default::default())
        })
    }));
    let directory = SessionDirectory::new(rig.deps());
    let handle = start_thread(&directory).await;
    turn(&handle, "build", "op-1").await;
    eventually_on!(&[&progress], || (rig.wakes.active_waits(&handle.id) == 1).then_some(())).await;
    assert_eq!(turn(&handle, "next", "op-2").await["kind"], "queued");
    eventually_on!(&[&progress], || (rig.wakes.active_waits(&handle.id) == 1 && lock(&reasons).len() == 1).then_some(())).await;
    assert_eq!(lock(&delivered).len(), 1, "the boundary delivered the prompt that released the first wait");

    directory.finished(&handle.id, "shell", "job-7", "completed", "Async shell task job-7 finished.".into()).await;
    eventually_on!(&[&progress], || (lock(&reasons).len() == 2).then_some(())).await;
    assert_eq!(*lock(&reasons), [WakeReason::UserMessage, WakeReason::Notification]);

    // The completion was queued, never a queued prompt; the turn took no boundary after it, so
    // it runs as its own turn, as a task-notification row.
    eventually_on!(&[&progress], || (lock(&inputs).len() == 2).then_some(())).await;
    let bodies = lock(&inputs).clone();
    assert_eq!(lock(&delivered)[0], "next");
    assert_eq!(bodies[1]["meta"]["source"], "task-notification");
    assert_eq!(bodies[1]["meta"]["execution"], json!({ "surface": "shell", "id": "job-7", "status": "completed" }));
    assert_eq!(bodies[1]["content"], "Async shell task job-7 finished.");
    assert!(!prompt_list(&handle).iter().any(|p| p.contains("job-7")));
    eventually_on!(&[&handle.cell.stepped], || idle(&handle).then_some(())).await;
    assert!(handle.cell.view.load_full().state.queued.as_ref().is_some_and(Vec::is_empty));
}

/// A queued completion as the run takes it at a boundary: `SteerMode::TaskNotification`
/// with its execution, after steered prompts; taken, it never starts a turn of its own.
#[tokio::test(start_paused = true)]
async fn a_running_turn_takes_a_completion_at_its_next_boundary() {
    use mixdog_tools::exec::TaskNotifier;
    let rig = Rig::new();
    let gate = Arc::new(tokio::sync::Notify::new());
    let taken: Arc<Mutex<Vec<SteerInput>>> = Arc::default();
    let (open, out) = (gate.clone(), taken.clone());
    rig.set_script(Arc::new(move |run| {
        let (open, out) = (open.clone(), out.clone());
        Box::pin(async move {
            run.port.input_durable().await.expect("input durable");
            open.notified().await;
            let steers = run.port.take_steers(drain(DrainStage::PreSend)).await.expect("take");
            lock(&out).extend(steers);
            RunOutcome::Completed(Default::default())
        })
    }));
    let directory = SessionDirectory::new(rig.deps());
    let handle = start_thread(&directory).await;
    turn(&handle, "build", "op-1").await;
    directory.finished(&handle.id, "shell", "job-7", "completed", "job-7 finished.".into()).await;
    // Durable before the boundary looks.
    eventually_on!(&[&handle.cell.stepped], || {
        rig.store.records(&handle.id).into_iter().any(|(_, record)| matches!(record, mixdog_store::schema::record::Record::Queue(_))).then_some(())
    })
    .await;
    mixdog_rt::time::sleep(Duration::from_millis(50)).await;
    gate.notify_one();
    eventually_on!(&[&handle.cell.stepped], || idle(&handle).then_some(())).await;
    let taken = lock(&taken).clone();
    assert_eq!(taken.len(), 1);
    assert_eq!(taken[0].mode, SteerMode::TaskNotification);
    assert_eq!(taken[0].execution, Some(json!({ "surface": "shell", "id": "job-7", "status": "completed" })));
    assert_eq!(taken[0].content, "job-7 finished.");
    mixdog_rt::time::sleep(Duration::from_millis(100)).await;
    assert_eq!(runs_started(&rig, &handle.id), 1, "a taken completion starts no turn");
}

/// `session-flow/steering.mjs:204` (`drainPendingSteering`, the desktop host's queue): every boundary takes each queued
/// prompt within its priority as an input of its own, never merged (session-send-world `recipient-queued`); the completion
/// then left alone in the queue is taken at the same boundary (`ask-turn-steering-drain.mjs:44-58`). None of it starts a turn.
#[tokio::test(start_paused = true)]
async fn queued_prompts_are_taken_one_by_one_at_the_next_boundary() {
    use mixdog_tools::exec::TaskNotifier;
    let rig = Rig::new();
    let gate = Arc::new(tokio::sync::Notify::new());
    let taken: Arc<Mutex<Vec<Vec<SteerInput>>>> = Arc::default();
    let (open, out) = (gate.clone(), taken.clone());
    rig.set_script(Arc::new(move |run| {
        let (open, out) = (open.clone(), out.clone());
        Box::pin(async move {
            run.port.input_durable().await.expect("input durable");
            if lock(&out).is_empty() {
                open.notified().await;
            }
            for stage in [DrainStage::PreSend, DrainStage::Terminal] {
                let steers = run.port.take_steers(drain(stage)).await.expect("take");
                lock(&out).push(steers);
            }
            RunOutcome::Completed(Default::default())
        })
    }));
    let directory = SessionDirectory::new(rig.deps());
    let handle = start_thread(&directory).await;
    turn(&handle, "build", "op-1").await;
    let first = turn(&handle, "first", "op-2").await;
    let second = turn(&handle, "second", "op-3").await;
    directory.finished(&handle.id, "shell", "job-7", "completed", "job-7 finished.".into()).await;
    eventually_on!(&[&handle.cell.stepped], || {
        let queued = rig.store.records(&handle.id).into_iter().filter(|(_, record)| matches!(record, mixdog_store::schema::record::Record::Queue(_)));
        (queued.count() == 3).then_some(())
    })
    .await;
    gate.notify_one();
    eventually_on!(&[&handle.cell.stepped], || idle(&handle).then_some(())).await;
    let taken = lock(&taken).clone();
    assert_eq!(taken.len(), 2);
    let next = &taken[0];
    assert_eq!(next.len(), 3);
    for (input, (content, queued)) in next.iter().zip([("first", &first), ("second", &second)]) {
        assert_eq!(input.mode, SteerMode::Prompt);
        assert_eq!(input.content, content);
        let ids: Vec<&str> = input.queued_ids.iter().map(|id| id.as_str()).collect();
        assert_eq!(ids, [queued["queuedId"].as_str().unwrap()]);
    }
    assert_eq!(next[2].mode, SteerMode::TaskNotification);
    assert_eq!(next[2].content, "job-7 finished.");
    assert!(taken[1].is_empty(), "the terminal boundary finds the queue empty");
    mixdog_rt::time::sleep(Duration::from_millis(100)).await;
    assert_eq!(runs_started(&rig, &handle.id), 1, "taken input starts no turn");
    assert!(handle.cell.view.load_full().state.queued.as_ref().is_some_and(Vec::is_empty));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_steered_prompt_shows_under_its_client_submission_beside_the_starters() {
    let data = tempfile::tempdir().expect("data dir");
    let store = real_store(data.path()).await;
    let rig = Rig::new();
    let gate = Arc::new(tokio::sync::Notify::new());
    let open = gate.clone();
    rig.set_script(Arc::new(move |run| {
        let open = open.clone();
        Box::pin(async move {
            run.port.input_durable().await.expect("input durable");
            open.notified().await;
            for input in run.port.take_steers(drain(DrainStage::PreSend)).await.expect("take") {
                let entry = mixdog_agent::env::SteerEntry {
                    content: mixdog_core_api::domain::provider::Content::Text(input.content.as_str().expect("text").to_owned()),
                    text: input.text,
                    ids: input.queued_ids.iter().map(|id| id.as_str().to_owned()).collect(),
                    submitted_at: input.submitted_at,
                    message_id: input.message_id,
                    originals_missing: input.originals_missing,
                    transcript_meta: input.transcript_meta,
                    mode: mixdog_agent::env::SteerMode::Prompt,
                    execution: None,
                };
                let merged = mixdog_agent::steer::normalize(&entry).expect("a prompt");
                let (message, _) = mixdog_agent::steer::inject(merged, DrainStage::PreSend, 0, || "m-steered".into());
                run.port
                    .commit_item(ItemCommit {
                        iid: ItemId::from("steered-row"),
                        role: Some("user".into()),
                        model: true,
                        visible: true,
                        body: mixdog_agent::message_row::row_of(&message),
                        prompt: Some("second".into()),
                    })
                    .await
                    .expect("commit");
            }
            RunOutcome::Completed(Default::default())
        })
    }));
    // The rig's text transcript shows rows from their prompt alone; the real one reads each row's `meta.transcript`, which is
    // what carries the submission id into the item.
    let over_store = |store: Arc<dyn super::ThreadStore>| {
        let mut deps = rig.deps_parts(store);
        deps.transcript = Arc::new(super::transcript::RecordTranscript::new());
        SessionDirectory::new(Arc::new(deps))
    };
    let directory = over_store(store.clone());
    let handle = start_thread(&directory).await;
    let send = |prompt: &str, submission: &str, op: &str| {
        handle.request(request(
            "turn/start",
            json!({ "threadId": handle.id, "opId": op, "input": { "prompt": prompt, "options": { "clientSubmissionId": submission } } }),
            op,
        ))
    };
    send("first", "sub-A", "op-1").await.expect("starter");
    send("second", "sub-B", "op-2").await.expect("steered");
    // The real store keeps its records itself, not in the rig's: the thread's own queue is what shows B waiting.
    eventually_on!(&[&handle.cell.stepped], || (handle.cell.queue.load().len() == 1).then_some(())).await;
    gate.notify_one();
    eventually_on!(&[&handle.cell.stepped], || idle(&handle).then_some(())).await;

    let live: Vec<ThreadItem> = handle.cell.view.load_full().items.iter().map(|item| (**item).clone()).collect();
    let user = |items: &[ThreadItem], text: &str| {
        items.iter().find_map(|item| match item {
            ThreadItem::UserMessage { id, display_text, client_submission_id, .. } if display_text == text => {
                Some((id.as_str().to_owned(), client_submission_id.clone()))
            }
            _ => None,
        })
    };
    let (starter, starter_submission) = user(&live, "first").expect("the starter's row");
    assert_eq!(starter_submission.as_deref(), Some("sub-A"), "{live:?}");
    let (steered, steered_submission) = user(&live, "second").expect("the steered row");
    assert_eq!(steered_submission.as_deref(), Some("sub-B"), "the live item shows under its submission: {live:?}");
    assert_ne!(steered, starter);
    // The scripted run writes no turn-end row; the turn's end takes its checkpoint from the starter's own row meta, so what is
    // owned here is that the steered row adds no other checkpoint (below).

    // The thread loaded again from the store, once the index holds every barrier acked so far.
    directory.history_row(&handle.id, live[0].id().as_str()).await.expect("read");
    let restarted = over_store(store);
    let Reply::Value(page) = restarted
        .request(CoreRequest { method: Method("thread/items/list"), params: json!({ "threadId": handle.id }), op: None, ctx: CallContext::internal("test") })
        .await
        .expect("thread/items/list")
    else {
        panic!("a page")
    };
    let items = page["data"].as_array().expect("items");
    let submissions: Vec<&str> = items.iter().filter_map(|item| item["clientSubmissionId"].as_str()).collect();
    assert_eq!(submissions, ["sub-A", "sub-B"], "{page}");
    let checkpoints: std::collections::BTreeSet<&str> = items.iter().filter_map(|item| item["checkpointId"].as_str()).collect();
    assert_eq!(checkpoints, [starter.as_str()].into(), "{page}");
}

/// `notification-bus.test.mjs` "one wake per session is in flight, and a suppressed wake
/// replays afterwards": completions that land after the woken turn's last look are one batch in one
/// turn, oldest first (`drain.mjs`: queued notices merged into one batch), and a replay that finds nothing ends the chain.
#[tokio::test(start_paused = true)]
async fn completions_after_the_woken_turns_last_look_replay_oldest_first() {
    use mixdog_tools::exec::TaskNotifier;
    let rig = Rig::new();
    let gate = Arc::new(tokio::sync::Notify::new());
    let inputs: Arc<Mutex<Vec<(Value, usize)>>> = Arc::default();
    let (open, seen) = (gate.clone(), inputs.clone());
    let progress = Arc::new(tokio::sync::Notify::new());
    let said = progress.clone();
    rig.set_script(Arc::new(move |run| {
        let (open, seen, told) = (open.clone(), seen.clone(), said.clone());
        Box::pin(async move {
            run.port.input_durable().await.expect("input durable");
            let first = lock(&seen).is_empty();
            // The boundary looks first; the woken turn then waits past its last look.
            let took = run.port.take_steers(drain(DrainStage::PreSend)).await.expect("take").len();
            lock(&seen).push((run.input_body.clone(), took));
            told.notify_waiters();
            if first {
                open.notified().await;
            }
            RunOutcome::Completed(Default::default())
        })
    }));
    let directory = SessionDirectory::new(rig.deps());
    let handle = start_thread(&directory).await;
    directory.finished(&handle.id, "shell", "job-1", "completed", "job-1 finished.".into()).await;
    eventually_on!(&[&progress], || (lock(&inputs).len() == 1).then_some(())).await;
    directory.finished(&handle.id, "shell", "job-2", "completed", "job-2 finished.".into()).await;
    directory.finished(&handle.id, "shell", "job-3", "completed", "job-3 finished.".into()).await;
    mixdog_rt::time::sleep(Duration::from_millis(50)).await;
    gate.notify_one();
    eventually_on!(&[&progress], || (lock(&inputs).len() == 2).then_some(())).await;
    eventually_on!(&[&handle.cell.stepped], || idle(&handle).then_some(())).await;
    mixdog_rt::time::sleep(Duration::from_millis(100)).await;
    let inputs = lock(&inputs).clone();
    let order: Vec<&str> = inputs.iter().map(|(body, _)| body["content"].as_str().unwrap()).collect();
    assert_eq!(order, ["job-1 finished.", "job-2 finished.\njob-3 finished."]);
    // The replayed wake drained both: they are one turn, not taken by a boundary.
    assert!(inputs.iter().all(|(_, took)| *took == 0), "{inputs:?}");
    assert_eq!(runs_started(&rig, &handle.id), 2, "a replay that finds nothing ends the chain");
}

/// `ask-turn-steering-drain.mjs:48`: while a route saved during the turn is held, the queued
/// completion is left to the next turn.
#[tokio::test(start_paused = true)]
async fn a_held_route_leaves_a_completion_to_the_next_turn() {
    use crate::session::thread_state::SessionThreads;
    use mixdog_core_ports::ports::threads::ThreadState;
    use mixdog_tools::exec::TaskNotifier;
    let rig = Rig::new();
    let gate = Arc::new(tokio::sync::Notify::new());
    let took: Arc<Mutex<Vec<usize>>> = Arc::default();
    let (open, seen) = (gate.clone(), took.clone());
    rig.set_script(Arc::new(move |run| {
        let (open, seen) = (open.clone(), seen.clone());
        Box::pin(async move {
            run.port.input_durable().await.expect("input durable");
            if lock(&seen).is_empty() {
                open.notified().await;
            }
            let n = run.port.take_steers(drain(DrainStage::PreSend)).await.expect("take").len();
            lock(&seen).push(n);
            RunOutcome::Completed(Default::default())
        })
    }));
    let directory = Arc::new(SessionDirectory::new(rig.deps()));
    let handle = start_thread(&directory).await;
    turn(&handle, "build", "op-1").await;
    let mut set = serde_json::Map::new();
    set.insert("pendingRoute".into(), json!({ "provider": "p", "model": "m" }));
    SessionThreads::new(directory.clone()).patch_header(&handle.id, set, Vec::new()).await.expect("held");
    directory.finished(&handle.id, "shell", "job-7", "completed", "job-7 finished.".into()).await;
    mixdog_rt::time::sleep(Duration::from_millis(50)).await;
    gate.notify_one();
    eventually_on!(&[&handle.cell.stepped], || (lock(&took).len() == 2).then_some(())).await;
    assert_eq!(lock(&took)[0], 0, "held: not taken by this turn");
    assert_eq!(runs_started(&rig, &handle.id), 2, "the next turn is the completion's");
}

/// The control kind is the `session` record's own field, outside its header: a control thread's hook transcript export and its
/// `thread/read` carry no trace of it, and a reopen in another directory over the same store still finds the control session.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_control_threads_export_and_read_carry_no_kind_and_a_reopen_restores_it() {
    let data = tempfile::tempdir().expect("data dir");
    let store = real_store(data.path()).await;
    let rig = Rig::new();
    rig.set_script(echo());
    let first = SessionDirectory::new(rig.deps_on(store.clone()));
    let id = start_control(&first, "op-control").await.expect("control start");
    let handle = first.handle(&id).expect("loaded");
    turn(&handle, "hello", "op-1").await;
    eventually_on!(&[&handle.cell.stepped], || (idle(&handle) && rows(&handle).len() == 2).then_some(())).await;
    let no_kind = |value: &Value, what: &str| {
        fn keys(value: &Value, out: &mut Vec<String>) {
            match value {
                Value::Object(map) => map.iter().for_each(|(key, value)| {
                    out.push(key.clone());
                    keys(value, out);
                }),
                Value::Array(items) => items.iter().for_each(|value| keys(value, out)),
                _ => {}
            }
        }
        let mut found = Vec::new();
        keys(value, &mut found);
        let kind: Vec<_> = found.iter().filter(|key| key.to_lowercase().contains("control")).collect();
        assert!(kind.is_empty(), "{what} carries {kind:?}");
    };

    let tokens = mixdog_rt::testing::tokens();
    let lanes = super::SessionLanes { cpu: tokens.cpu_interactive, io: tokens.interactive_io, durability: tokens.durability_io };
    let files = super::transcript_export::TranscriptFiles::new(data.path(), store.clone(), lanes, tokens.maintenance_io);
    let path = super::transcript_export::export_path(data.path(), id.as_str());
    use mixdog_mcp::hook_bus::TranscriptExport;
    assert_eq!(files.transcript_path(id.as_str()).await, json!(path.to_string_lossy()), "the thread has a transcript");
    let bytes = mixdog_core_base::support::on_lane(tokens.maintenance_io, &CancellationToken::new(), move |_| mixdog_statefile::read_content(&path))
        .await
        .expect("read job")
        .expect("readable")
        .expect("the export exists");
    let text = String::from_utf8(bytes).expect("UTF-8");
    let session: Value = serde_json::from_str(text.lines().next().expect("the session line")).expect("JSON");
    assert_eq!(session["header"]["id"], id.as_str(), "the export is the thread's");
    for line in text.lines() {
        no_kind(&serde_json::from_str(line).expect("JSON"), "the export");
    }

    let read = CoreRequest { method: Method("thread/read"), params: json!({ "threadId": id }), op: None, ctx: CallContext::internal("test") };
    let Reply::Value(read) = handle.request(read).await.expect("thread/read") else { panic!("thread/read answers a value") };
    assert_eq!(read["thread"]["id"], id.as_str());
    no_kind(&read, "thread/read");

    let second = SessionDirectory::new(rig.deps_on(store));
    second.open_handle(&id, &CallContext::internal("test")).await.expect("reopened");
    assert_eq!(second.control_ids(), [id]);
}

/// The draft's worktree is entered after the thread exists and before the first prompt, through the workspace seam, with the
/// worktree choice and the start's input; a draft without one, and a control start, enter nothing (`createNewTask`).
#[tokio::test(start_paused = true)]
async fn a_drafts_worktree_is_entered_once_the_thread_exists() {
    let rig = Rig::new();
    let place = Arc::new(super::testing::RecordingPlace::default());
    let mut deps = rig.deps_parts(rig.store.clone());
    deps.new_place = place.clone();
    let directory = SessionDirectory::new(Arc::new(deps));
    let draft = json!({ "projectPath": "/repo", "worktree": { "branch": "feat", "create": true } });
    let reply = directory.request(request("thread/start", json!({ "opId": "op-wt", "kind": "task", "draft": draft }), "op-wt")).await.expect("thread/start");
    let Reply::Subscribe(started) = reply else { panic!("thread/start subscribes") };
    let id = started.result["thread"]["id"].as_str().expect("thread id").to_owned();
    let header = directory.handle(&ThreadId::from(id.as_str())).expect("loaded").cell.header.load_full();
    // The project stays the project; the workspace service moves the folder.
    assert_eq!(header["desktopSession"], json!({ "classification": "project", "projectPath": "/repo" }));
    assert_eq!(*lock(&place.entered), vec![(id, json!({ "branch": "feat", "create": true }), None)]);
    directory
        .request(request("thread/start", json!({ "opId": "op-plain", "kind": "task", "draft": { "projectPath": "/repo" } }), "op-plain"))
        .await
        .expect("thread/start");
    directory
        .request(request("thread/start", json!({ "opId": "op-ctl", "kind": "control", "draft": { "worktree": { "fromDefault": true } } }), "op-ctl"))
        .await
        .expect("thread/start");
    assert_eq!(lock(&place.entered).len(), 1);
}

/// A fork the desktop makes is placed as `inheritSession` places its heir (`resolveSessionWorkspace(sessionProjectPath(source))`):
/// in the source's Project, or in the task workspace, with a fresh classification and no worktree record; a source of another
/// client keeps its header, and an inherit into an existing thread keeps that thread's place.
#[tokio::test(start_paused = true)]
async fn a_fork_is_placed_where_the_desktop_places_an_heir() {
    use mixdog_store::schema::record::Header;
    let rig = Rig::new();
    let place = Arc::new(super::testing::RecordingPlace { projects: vec!["/repo".to_owned()], ..Default::default() });
    let mut deps = rig.deps_parts(rig.store.clone());
    deps.new_place = place;
    let directory = SessionDirectory::new(Arc::new(deps));
    let source = |cwd: &str, desktop: Value| {
        let mut header = Header::new();
        header.insert("createdAt".into(), json!(1));
        header.insert("updatedAt".into(), json!(1));
        header.insert("cwd".into(), json!(cwd));
        // Only a project session can sit in a managed worktree: a task session has no `workspace` record.
        let in_project = desktop.get("classification") == Some(&json!("project"));
        if !desktop.is_null() {
            header.insert("desktopSession".into(), desktop);
        }
        if in_project {
            header.insert("workspace".into(), json!({ "worktreeId": "w1", "cwd": cwd, "projectPath": "/repo" }));
        }
        header
    };
    let fork = |id: &'static str, header: Header, extra: Value| {
        let directory = &directory;
        async move {
            let thread = ThreadId::from(id.to_owned());
            directory.create_with_id(thread.clone(), header, json!({})).await.expect("source");
            give_conversation(&directory.handle(&thread).expect("loaded")).await;
            let mut params = json!({ "threadId": id, "opId": format!("op-{id}") });
            params.as_object_mut().expect("object").extend(extra.as_object().expect("object").clone());
            let reply = directory.handle(&thread).expect("loaded").request(request("thread/fork", params, &format!("op-{id}"))).await.expect("thread/fork");
            let Reply::Value(value) = reply else { panic!("thread/fork answers a value") };
            let heir = ThreadId::from(value["thread"]["id"].as_str().expect("heir id"));
            directory.handle(&heir).expect("loaded").cell.header.load_full()
        }
    };
    let in_worktree = fork("src_wt", source("/repo/.wt/feat", json!({ "classification": "project", "projectPath": "/repo" })), json!({})).await;
    assert_eq!(in_worktree["cwd"], "/repo");
    assert_eq!(in_worktree["desktopSession"], json!({ "classification": "project", "projectPath": "/repo" }));
    assert!(in_worktree.get("workspace").is_none());
    let in_tasks = fork("src_task", source("/tasks", json!({ "classification": "task", "projectPath": null })), json!({})).await;
    assert_eq!(in_tasks["cwd"], "/tasks");
    assert_eq!(in_tasks["desktopSession"], json!({ "classification": "task", "projectPath": null }));
    let foreign = fork("src_tui", source("/elsewhere", Value::Null), json!({})).await;
    assert_eq!(foreign["cwd"], "/elsewhere");
    assert!(foreign.get("desktopSession").is_none());
    let into =
        fork("src_into", source("/repo/.wt/feat", json!({ "classification": "project", "projectPath": "/repo" })), json!({ "intoThreadId": "heir_existing" }))
            .await;
    assert_eq!(into["cwd"], "/repo/.wt/feat");
}

/// A fork of a worktree session of another client (no `desktopSession`) starts in the Project folder, not the source's worktree
/// (`cold-heir.mjs`: `replacementSessionCwd`), and is not told of the folder change the source has staged into that worktree.
#[tokio::test(start_paused = true)]
async fn a_fork_without_a_desktop_classification_leaves_the_sources_worktree() {
    use mixdog_store::schema::record::Header;
    let rig = Rig::new();
    let directory = SessionDirectory::new(Arc::new(rig.deps_parts(rig.store.clone())));
    let mut header = Header::new();
    header.insert("createdAt".into(), json!(1));
    header.insert("updatedAt".into(), json!(1));
    header.insert("cwd".into(), json!("/repo/.wt/feat"));
    header.insert(
        "workspace".into(),
        json!({ "worktreeId": "w1", "cwd": "/repo/.wt/feat", "projectPath": "/repo", "repoCommonDir": "/repo/.git", "branch": "feat" }),
    );
    header.insert("workspaceReroot".into(), json!({ "revision": 1, "seen": { "cwd": "/repo" }, "target": { "cwd": "/repo/.wt/feat" } }));
    let thread = ThreadId::from("src_wt_plain".to_owned());
    directory.create_with_id(thread.clone(), header, json!({})).await.expect("source");
    give_conversation(&directory.handle(&thread).expect("loaded")).await;
    let reply = directory
        .handle(&thread)
        .expect("loaded")
        .request(request("thread/fork", json!({ "threadId": "src_wt_plain", "opId": "op-wt" }), "op-wt"))
        .await
        .expect("thread/fork");
    let Reply::Value(value) = reply else { panic!("thread/fork answers a value") };
    let heir = directory.handle(&ThreadId::from(value["thread"]["id"].as_str().expect("heir id"))).expect("loaded").cell.header.load_full();
    assert_eq!(heir["cwd"], "/repo");
    assert_eq!(heir["workspace"]["cwd"], "/repo");
    assert!(heir["workspace"]["worktreeId"].is_null());
    assert!(heir.get("workspaceReroot").is_none(), "the source's staged folder change stays with the source");
}

/// `notification-bus.test.mjs` "a queued completion wakes its owner session" and
/// `ask-queue.mjs:87-101`: the completion is the woken turn's input, a task-notification row.
#[tokio::test(start_paused = true)]
async fn a_completion_on_an_idle_thread_wakes_it_with_the_completion_as_the_turns_input() {
    use mixdog_tools::exec::TaskNotifier;
    let rig = Rig::new();
    let inputs: Arc<Mutex<Vec<Value>>> = Arc::default();
    let seen = inputs.clone();
    rig.set_script(Arc::new(move |run| {
        lock(&seen).push(run.input_body.clone());
        Box::pin(async move {
            run.port.input_durable().await.expect("input durable");
            RunOutcome::Completed(Default::default())
        })
    }));
    let directory = SessionDirectory::new(rig.deps());
    let handle = start_thread(&directory).await;
    directory.finished(&handle.id, "shell", "job-7", "completed", "Async shell task job-7 finished.".into()).await;
    eventually_on!(&[&handle.cell.stepped], || (lock(&inputs).len() == 1).then_some(())).await;
    let body = lock(&inputs)[0].clone();
    assert_eq!(body["role"], "user");
    assert_eq!(body["content"], "Async shell task job-7 finished.");
    assert_eq!(body["meta"]["source"], "task-notification");
    assert_eq!(body["meta"]["execution"], json!({ "surface": "shell", "id": "job-7", "status": "completed" }));
    eventually_on!(&[&handle.cell.stepped], || idle(&handle).then_some(())).await;
    assert_eq!(runs_started(&rig, &handle.id), 1);
    assert!(prompt_list(&handle).is_empty(), "a completion is no prompt");
}

/// The real thread store (log writer, codec, index) over the data dir `data`
/// (`StoreThreads::over_data_dir`).
pub async fn real_store(data: &std::path::Path) -> Arc<dyn super::ThreadStore> {
    use mixdog_core_api::domain::mock::MockOwnership;
    use mixdog_store::sqlite::SqliteStore;

    let tokens = mixdog_rt::testing::tokens();
    let root = data.to_path_buf();
    let index = mixdog_rt::LaneToken::submit(tokens.maintenance_io, &mixdog_rt::CancellationToken::new(), move |lane| {
        SqliteStore::open(lane, tokens.sqlite_writer_thread, tokens.interactive_io, &root)
    })
    .expect("lane")
    .await
    .expect("job ran")
    .expect("index");
    let ownership = Arc::new(MockOwnership::default());
    Arc::new(super::StoreThreads::over_data_dir(data, index, ownership, tokens.maintenance_io).await.expect("the thread store"))
}

/// The fork carries the source's conversation as `inheritFrom` does (a copy, not a shared lineage), so it still opens with
/// that history once the source is deleted.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_deleted_base_stays_readable_by_its_fork() {
    let data = tempfile::tempdir().expect("data dir");
    let store = real_store(data.path()).await;
    let rig = Rig::new();
    rig.set_script(echo());
    let directory = SessionDirectory::new(rig.deps_on(store.clone()));
    let base = start_thread(&directory).await;
    turn(&base, "first", "op-1").await;
    eventually_on!(&[&base.cell.stepped], || (settled_idle(&base) && rows(&base).len() == 2).then_some(())).await;
    let reply = base.request(request("thread/fork", json!({ "threadId": base.id, "opId": "op-fork" }), "op-fork")).await.expect("thread/fork");
    let Reply::Value(value) = reply else { panic!("thread/fork answers a value") };
    let fork = ThreadId::from(value["thread"]["id"].as_str().expect("fork id"));
    let reply = base.request(request("thread/delete", json!({ "threadId": base.id, "opId": "op-del" }), "op-del")).await.expect("thread/delete");
    assert!(matches!(reply, Reply::Value(Value::Bool(true))), "{reply:?}");
    let second = SessionDirectory::new(rig.deps_on(store));
    let reopened = second.open_handle(&fork, &CallContext::internal("test")).await.expect("the fork opens");
    assert_eq!(rows(&reopened).len(), 2, "the base's history shows in the fork");
}

/// `thread/delete` with `ifIdle` (`deleteSessionIfIdle`): each refusal in Node's order deletes
/// nothing; an archived, unfavored, idle and unchanged session is deleted.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn an_idle_delete_refuses_as_node_does_and_deletes_an_idle_archived_session() {
    let data = tempfile::tempdir().expect("data dir");
    let store = real_store(data.path()).await;
    let rig = Rig::new();
    let release: Arc<tokio::sync::Notify> = Arc::default();
    let gate = release.clone();
    rig.set_script(Arc::new(move |run| {
        let gate = gate.clone();
        Box::pin(async move {
            run.port.input_durable().await.expect("input durable");
            gate.notified().await;
            RunOutcome::Completed(Default::default())
        })
    }));
    let directory = SessionDirectory::new(rig.deps_on(store));
    let handle = start_thread(&directory).await;
    let id = handle.id.clone();
    let ask = |expected: Value| {
        let handle = handle.clone();
        let id = id.clone();
        async move {
            match handle.request(request("thread/delete", json!({ "threadId": id, "opId": "op-d", "ifIdle": expected }), "op-d")).await.expect("delete") {
                Reply::Value(value) => value,
                other => panic!("{other:?}"),
            }
        }
    };
    // The desktop's archive and favorite marks are the session's header fields.
    let state = |archived: bool, favorite: bool| {
        let handle = handle.clone();
        async move {
            let (mut set, mut unset) = (serde_json::Map::new(), Vec::new());
            for (key, on) in [("archivedAt", archived), ("favoriteAt", favorite)] {
                if on {
                    set.insert(key.into(), json!(1_793_306_570_000_i64));
                } else {
                    unset.push(key);
                }
            }
            let params = json!({ "threadId": handle.id, "set": set, "unset": unset });
            handle.request(CoreRequest { method: Method("thread/header/patch"), params, op: None, ctx: CallContext::internal("test") }).await.expect("patch");
        }
    };
    let refused = |reason: &str| json!({ "deleted": false, "reason": reason });
    assert_eq!(ask(json!({})).await, refused("not-archived"), "never archived");
    state(false, true).await;
    assert_eq!(ask(json!({})).await, refused("not-archived"));
    state(true, true).await;
    assert_eq!(ask(json!({})).await, refused("favorite"));
    state(true, false).await;
    turn(&handle, "work", "op-1").await;
    assert_eq!(ask(json!({})).await, refused("busy"));
    release.notify_one();
    // Not settled yet, the turn still holds what Node's ask lock is held for (`busy`).
    eventually_on!(&[&handle.cell.stepped], || (idle(&handle) && !handle.cell.turn_held.load(std::sync::atomic::Ordering::SeqCst)).then_some(())).await;
    // The turn moved `lastUsedAt` past what the caller saw.
    let used = eventually_on!(&[&handle.cell.stepped, &rig.store.committed], || {
        let meta = futures::executor::block_on(directory.session_meta(&id)).expect("meta").expect("listed");
        (meta.last_used_at > 0.0).then_some(meta.last_used_at)
    })
    .await;
    assert_eq!(ask(json!({ "lastUsedAt": used - 1.0 })).await, refused("changed"));
    assert!(lock(&rig.deletes.0).is_empty(), "a refusal deletes nothing");
    assert_eq!(ask(json!({ "lastUsedAt": used })).await, json!({ "deleted": true }));
    let s = id.as_str();
    let worktree = format!("releaseDeletedWorktree:{s}");
    eventually_on!(&[&handle.cell.stepped, &rig.deletes.1], || lock(&rig.deletes.0).contains(&worktree).then_some(())).await;
    let steps = lock(&rig.deletes.0).clone();
    // The tombstone's close metric (`markSessionClosed`), logged at the mark's ack, precedes the purge hooks.
    assert_eq!(steps[0], format!("tombstoned:{s}"), "the conversation leaves the catalog when the mark lands");
    assert_eq!(steps[1], format!("sessionClosed:{s}:desktop-auto-delete"));
    assert_eq!(steps[2], format!("transcriptExport:{s}:/ws"), "the purge hooks run next");
    let tail: Vec<&str> = steps[steps.len() - 4..].iter().map(String::as_str).collect();
    assert_eq!(
        tail,
        [
            format!("thread/deleted:{s}"),
            format!("releaseSessionWork:{s}:desktop-auto-delete"),
            format!("forgetSessionSearch:{s}"),
            format!("releaseDeletedWorktree:{s}"),
        ]
    );
}

/// A prompt larger than a frame's inline budget goes through the runtime codec into a
/// blob of its own, and a reopen gives it back (prompt history and the rewind text).
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[allow(clippy::disallowed_methods, reason = "the test reads the written log")]
async fn a_large_prompt_round_trips_through_the_real_store() {
    let data = tempfile::tempdir().expect("data dir");
    let store = real_store(data.path()).await;
    let rig = Rig::new();
    rig.set_script(echo());
    let first = SessionDirectory::new(rig.deps_on(store.clone()));
    let handle = start_thread(&first).await;
    let text = format!("ask {}", "p".repeat(300 << 10));
    turn(&handle, &text, "op-1").await;
    eventually_on!(&[&handle.cell.stepped], || (idle(&handle) && rows(&handle).len() == 2).then_some(())).await;
    let id = handle.id.clone();
    // Body and prompt are blobs: the log holds neither copy of the text.
    let log = std::fs::read(data.path().join("sessions").join(id.as_str()).join("log.000000")).unwrap();
    assert!(log.len() < 64 << 10, "{} log bytes", log.len());

    let second = SessionDirectory::new(rig.deps_on(store));
    let reopened = second.open_handle(&id, &CallContext::internal("test")).await.expect("open");
    assert_eq!(prompt_list(&reopened), std::slice::from_ref(&text));
    let asked = reopened.cell.view.load_full().items[0].id().clone();
    let reply = reopened.request(request("thread/rewind", json!({ "threadId": id, "opId": "op-2", "itemId": asked }), "op-2")).await.expect("rewind");
    let Reply::Value(value) = reply else { panic!() };
    assert_eq!(value["text"], text.as_str());
}

/// A fence `op/status` recorded is in the log: a thread that loads afterwards answers the fenced
/// id `opFenced` and runs nothing (P §9.4).
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_fenced_op_is_refused_after_the_thread_reloads() {
    use mixdog_core_base::ops::ThreadOpGates;

    let data = tempfile::tempdir().expect("data dir");
    let store = real_store(data.path()).await;
    let rig = Rig::new();
    rig.set_script(echo());
    let first = SessionDirectory::new(rig.deps_on(store.clone()));
    let handle = start_thread(&first).await;
    let id = handle.id.clone();
    let op = "0190f0a0-1c2d-7e3f-8a4b-5c6d7e8f9a0b";
    let gate = first.thread_ops().gate(&id, &connection()).await.expect("gate");
    let status = gate.status(&[OpId::from(op)], true, &connection()).await.expect("status");
    assert!(matches!(status[..], [mixdog_core_api::ops::OpStatus::NotApplied]));

    let second = SessionDirectory::new(rig.deps_on(store));
    let reopened = second.open_handle(&id, &CallContext::internal("test")).await.expect("open");
    let late = reopened.request(request("turn/start", json!({ "threadId": id, "opId": op, "input": { "prompt": "late" } }), op)).await;
    assert!(matches!(late, Err(CoreError::OpFenced { .. })));
    assert!(rows(&reopened).is_empty(), "the fenced turn ran nothing");
}

/// The whole stored history reads every page of the lineage, oldest first, and a rewind's
/// superseded rows are not part of it.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn the_real_store_reads_the_whole_history_oldest_first() {
    let data = tempfile::tempdir().expect("data dir");
    let store = real_store(data.path()).await;
    let rig = Rig::new();
    rig.set_script(echo());
    let directory = SessionDirectory::new(rig.deps_on(store));
    let handle = start_thread(&directory).await;
    turn(&handle, "one", "op-1").await;
    eventually_on!(&[&handle.cell.stepped], || (idle(&handle) && rows(&handle).len() == 2).then_some(())).await;
    turn(&handle, "two", "op-2").await;
    eventually_on!(&[&handle.cell.stepped], || (idle(&handle) && rows(&handle).len() == 4).then_some(())).await;
    let ids = |items: Vec<mixdog_protocol::ThreadItem>| items.iter().map(|i| i.id().clone()).collect::<Vec<_>>();
    let shown: Vec<_> = handle.cell.view.load_full().items.iter().map(|i| i.id().clone()).collect();
    assert_eq!(ids(directory.history_items(&handle.id).await.expect("history")), shown);

    let second = shown[2].clone();
    let reply = handle.request(request("thread/rewind", json!({ "threadId": handle.id, "opId": "op-3", "itemId": second }), "op-3")).await.expect("rewind");
    assert!(matches!(reply, Reply::Value(_)));
    eventually_on!(&[&handle.cell.stepped], || (rows(&handle).len() == 2).then_some(())).await;
    assert_eq!(ids(directory.history_items(&handle.id).await.expect("history")), shown[..2]);
    assert!(directory.history_items(&ThreadId::from("missing")).await.is_err());
}

/// Paging history by item cursor across a rewind and across a clear (protocol §5.5): a cursor
/// naming a row the rewind or the clear removed is `cursorInvalidated`, and one that survived
/// still pages; the thread need not be loaded to be read.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn an_item_cursor_into_rewound_or_cleared_history_is_invalidated() {
    let data = tempfile::tempdir().expect("data dir");
    let store = real_store(data.path()).await;
    let rig = Rig::new();
    rig.set_script(echo());
    let directory = SessionDirectory::new(rig.deps_on(store));
    let handle = start_thread(&directory).await;
    turn(&handle, "one", "op-1").await;
    eventually_on!(&[&handle.cell.stepped], || (idle(&handle) && rows(&handle).len() == 2).then_some(())).await;
    turn(&handle, "two", "op-2").await;
    eventually_on!(&[&handle.cell.stepped], || (idle(&handle) && rows(&handle).len() == 4).then_some(())).await;
    let shown: Vec<_> = handle.cell.view.load_full().items.iter().map(|i| i.id().clone()).collect();
    let list =
        |cursor: &ItemId| directory.request(request("thread/items/list", json!({ "threadId": handle.id, "cursor": cursor, "sortDirection": "asc" }), "list"));

    let Reply::Value(page) = list(&shown[1]).await.expect("page") else { panic!() };
    assert_eq!(page["data"].as_array().map(Vec::len), Some(2));

    handle.request(request("thread/rewind", json!({ "threadId": handle.id, "opId": "op-3", "itemId": shown[2] }), "op-3")).await.expect("rewind");
    eventually_on!(&[&handle.cell.stepped], || (rows(&handle).len() == 2).then_some(())).await;
    assert!(matches!(list(&shown[3]).await, Err(CoreError::CursorInvalidated { .. })));
    assert!(list(&shown[0]).await.is_ok(), "a cursor that survived the rewind pages");

    handle.request(request("thread/clear", json!({ "threadId": handle.id, "opId": "op-4" }), "op-4")).await.expect("clear");
    eventually_on!(&[&handle.cell.stepped], || rows(&handle).is_empty().then_some(())).await;
    assert!(matches!(list(&shown[0]).await, Err(CoreError::CursorInvalidated { .. })));
}

/// `thread/clear` with `rebuildPrompt` (Node's `clear({ rebuildPrompt })`): the emptied thread's surface is composed again and the
/// answer says whether that applied; without it nothing is rebuilt; a running turn refuses it.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn clear_with_rebuild_prompt_reseeds_the_emptied_thread_and_answers_whether_it_applied() {
    struct Reseeds(Arc<Mutex<Vec<ThreadId>>>, bool);
    #[async_trait::async_trait]
    impl super::EmptyToolSurface for Reseeds {
        async fn refresh_empty(&self, thread: &ThreadId) -> Result<bool, String> {
            self.0.lock().expect("calls").push(thread.clone());
            Ok(self.1)
        }
    }
    for applied in [true, false] {
        let data = tempfile::tempdir().expect("data dir");
        let store = real_store(data.path()).await;
        let rig = Rig::new();
        rig.set_script(echo());
        let calls: Arc<Mutex<Vec<ThreadId>>> = Arc::default();
        let mut deps = rig.deps_parts(store);
        deps.empty_surface = Arc::new(Reseeds(calls.clone(), applied));
        let directory = SessionDirectory::new(Arc::new(deps));
        let handle = start_thread(&directory).await;
        // A session of a real route names its model; the rig's route has none, which would make the emptied thread a reservation.
        let set = json!({ "provider": "custom-harness", "model": "harness-model" });
        let patch = CoreRequest {
            method: mixdog_core_api::ids::Method("thread/header/patch"),
            params: json!({ "threadId": handle.id, "set": set, "unset": [] }),
            op: None,
            ctx: CallContext::internal("test"),
        };
        handle.request(patch).await.expect("patch");
        turn(&handle, "one", "op-1").await;
        eventually_on!(&[&handle.cell.stepped], || (settled_idle(&handle) && rows(&handle).len() == 2).then_some(())).await;
        let Reply::Value(plain) = handle.request(request("thread/clear", json!({ "threadId": handle.id, "opId": "op-2" }), "op-2")).await.expect("clear")
        else {
            panic!("a value")
        };
        assert_eq!(plain, json!({}), "without rebuildPrompt the answer is the clear's own");
        // The copy a person's clear keeps (`forkOutgoingTranscript`'s heir) has its own prompt composed; the cleared thread's is not.
        assert!(!calls.lock().expect("calls").contains(&handle.id), "nothing is rebuilt without it");
        calls.lock().expect("calls").clear();
        let Reply::Value(rebuilt) =
            handle.request(request("thread/clear", json!({ "threadId": handle.id, "opId": "op-3", "rebuildPrompt": true }), "op-3")).await.expect("clear")
        else {
            panic!("a value")
        };
        assert_eq!(rebuilt, json!({ "promptRebuilt": applied }));
        assert_eq!(*calls.lock().expect("calls"), [handle.id.clone()]);
    }
}

/// The run publishes its progress into the session cell; the registry's `runtime_stage` and the
/// worker views' `live` read that one value, and a thread this process does not host has none.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn the_runs_progress_is_read_from_the_session_cell() {
    use crate::session::agent_registry::LiveSessions;
    use mixdog_core_run::run_host::progress::ProgressPublisher;
    use mixdog_core_run::run_host::progress::WaitedJobs;

    struct At(i64);
    impl mixdog_agent::env::Clock for At {
        fn now_ms(&self) -> i64 {
            self.0
        }
    }
    struct NoJobs;
    impl WaitedJobs for NoJobs {
        fn silence(&self, _: &[String], _: i64) -> Option<mixdog_agent::agent_tool::progress::ToolSilence> {
            None
        }
    }

    let rig = Rig::new();
    rig.set_script(Arc::new(|run| {
        Box::pin(async move {
            let progress = ProgressPublisher::new(run.progress.clone(), Arc::new(At(1_000)));
            progress.ask_start();
            progress.stage("streaming");
            RunOutcome::Completed(Default::default())
        })
    }));
    let directory = SessionDirectory::new(rig.deps());
    let handle = start_thread(&directory).await;
    assert_eq!(LiveSessions::runtime_stage(&directory, handle.id.as_str()), None, "no marker yet");
    turn(&handle, "go", "op-1").await;
    eventually_on!(&[&handle.cell.stepped], || idle(&handle).then_some(())).await;
    assert_eq!(LiveSessions::runtime_stage(&directory, handle.id.as_str()).as_deref(), Some("streaming"));
    let live = directory.worker_live(&handle.id, 2_000, &NoJobs);
    assert_eq!(live.runtime_stage.as_deref(), Some("streaming"));
    assert_eq!(live.runtime.map(|facts| facts.ask_started_at), Some(1_000));
    assert_eq!(directory.worker_live(&ThreadId::from("elsewhere"), 2_000, &NoJobs), Default::default());
}

struct LiveEvents {
    rig: Rig,
    handle: Arc<SessionHandle>,
    _directory: SessionDirectory,
}

impl LiveEvents {
    fn items(&self) -> Vec<ThreadItem> {
        self.handle.cell.view.load_full().items.iter().map(|item| (**item).clone()).collect()
    }

    fn frames(&self) -> Vec<(u64, String, Value)> {
        self.rig.feeds.frames(self.handle.id.as_str())
    }

    fn notices(&self) -> Vec<Value> {
        self.items()
            .iter()
            .filter_map(|item| match item {
                ThreadItem::StatusRow { kind, meta, .. } if kind == "notice" => Some(serde_json::to_value(meta).expect("meta")),
                _ => None,
            })
            .collect()
    }
}

async fn run_live_events() -> LiveEvents {
    let rig = Rig::new();
    rig.set_script(Arc::new(|run| {
        Box::pin(async move {
            run.port.input_durable().await.expect("input durable");
            let reasoning = ItemId::from("r1".to_owned());
            let item = ThreadItem::Reasoning { id: reasoning.clone(), summary: Vec::new(), content: Vec::new(), meta: Default::default() };
            run.port.item_started(item).await.expect("started");
            run.port.reasoning_delta(reasoning.clone(), "think ".into()).await.expect("delta");
            run.port.reasoning_delta(reasoning.clone(), "more".into()).await.expect("delta");
            run.port.reasoning_completed(reasoning, "think more".into()).await.expect("completed");
            run.port.notice("model switch failed".into(), mixdog_agent::env::Tone::Info).await.expect("notice");
            let excluded = "Tool \"mcp__x__broken\" was excluded from this session's requests: its input schema is invalid at / (bad). Fix the tool's schema or disable the tool.";
            run.port.notice(excluded.into(), mixdog_agent::env::Tone::Warn).await.expect("warn notice");
            let usage = mixdog_core_api::domain::provider::Usage { input_tokens: 10, output_tokens: 5, cache_read_tokens: 3, cache_write_tokens: 2, ..Default::default() };
            let tool = mixdog_core_api::domain::provider::ToolDefinition { name: "read".into(), description: "d".into(), input_schema: json!({ "type": "object" }), defer_loading: true, freeform: None };
            run.port
                .usage(crate::session::UsageReport {
                    iteration: 1,
                    usage,
                    model: "gpt-answered".into(),
                    requested_model: "gpt-asked".into(),
                    delta_tool_calls: 2,
                    request_ms: 340,
                    delta_prompt: 15,
                    send_tools: vec![tool],
                    reasoning_tokens: Some(4),
                    reasoning_tokens_complete: true,
                    outgoing: Vec::new().into(),
                    sent_at_ms: 0,
                    input_excludes_cache: false,
                    tail_book: None,
                })
                .await
                .expect("usage");
            run.port
                .commit_item(ItemCommit {
                    iid: ItemId::from(format!("s-{}", run.turn)),
                    role: Some("user".into()),
                    model: true,
                    visible: true,
                    body: json!({ "role": "user", "content": "steered", "meta": { "transcript": { "at": 1 } } }),
                    prompt: Some("steered words".into()),
                })
                .await
                .expect("commit");
            RunOutcome::Completed(Default::default())
        })
    }));
    let directory = SessionDirectory::new(rig.deps());
    let handle = start_thread(&directory).await;
    turn(&handle, "go", "op-1").await;
    eventually_on!(&[&handle.cell.stepped], || idle(&handle).then_some(())).await;
    LiveEvents { rig, handle, _directory: directory }
}

#[tokio::test(start_paused = true)]
async fn a_runs_reasoning_grows_one_item_and_completes_it_in_place() {
    let live = run_live_events().await;
    let reasoning: Vec<ThreadItem> = live.items().into_iter().filter(|item| matches!(item, ThreadItem::Reasoning { .. })).collect();
    let [ThreadItem::Reasoning { content, .. }] = reasoning.as_slice() else { panic!("one reasoning item: {reasoning:?}") };
    assert_eq!(*content, ["think more"], "one growing part");
    let frames = live.frames();
    assert_eq!(frames.iter().filter(|(_, method, _)| method == "item/reasoning/textDelta").count(), 2);
    let completed: Vec<&Value> =
        frames.iter().filter(|(_, method, params)| method == "item/completed" && params["item"]["type"] == "reasoning").map(|(_, _, params)| params).collect();
    assert_eq!(completed.len(), 1);
    assert_eq!((completed[0]["item"]["id"].clone(), completed[0]["item"]["content"].clone()), (json!("r1"), json!(["think more"])));
}

#[tokio::test(start_paused = true)]
async fn a_runs_notices_show_with_their_tone() {
    let notices = run_live_events().await.notices();
    let info = notices.iter().find(|notice| notice["ext"]["text"] == "Couldn’t switch model.").expect("the notice");
    assert_eq!(info["ext"]["tone"], json!("info"), "{info}");
    let warned = notices
        .iter()
        .find(|notice| notice["ext"]["text"].as_str().is_some_and(|text| text.contains("was excluded from this session")))
        .expect("the warn notice");
    assert_eq!(warned["ext"]["tone"], json!("warn"), "{warned}");
}

#[tokio::test(start_paused = true)]
async fn a_model_calls_usage_is_published_as_a_token_usage_update() {
    let frames = run_live_events().await.frames();
    let usage = frames.iter().find(|(_, method, _)| method == "thread/tokenUsage/updated").expect("usage").2["usage"].clone();
    assert_eq!(
        (
            usage["deltaInput"].clone(),
            usage["deltaOutput"].clone(),
            usage["deltaCachedRead"].clone(),
            usage["deltaCacheWrite"].clone(),
            usage["iterationIndex"].clone()
        ),
        (json!(10), json!(5), json!(3), json!(2), json!(1))
    );
    let keys: Vec<&str> = usage.as_object().expect("usage").keys().map(String::as_str).collect();
    assert_eq!(
        keys,
        [
            "sessionId",
            "iterationIndex",
            "source",
            "requestedModel",
            "model",
            "deltaInput",
            "deltaOutput",
            "deltaToolCalls",
            "reasoningTokens",
            "reasoningTokensComplete",
            "deltaPrompt",
            "requestMs",
            "promptKnown",
            "deltaCachedRead",
            "deltaCacheWrite",
            "contextInputTokens",
            "contextOutputTokens",
            "contextPromptTokens",
            "contextCachedReadTokens",
            "contextCacheWriteTokens",
            "contextMeasuredTokens",
            "ts"
        ]
    );
    assert_eq!(
        (
            usage["model"].clone(),
            usage["requestedModel"].clone(),
            usage["deltaToolCalls"].clone(),
            usage["requestMs"].clone(),
            usage["deltaPrompt"].clone(),
            usage["reasoningTokens"].clone()
        ),
        (json!("gpt-answered"), json!("gpt-asked"), json!(2), json!(340), json!(15), json!(4))
    );
}

#[tokio::test(start_paused = true)]
async fn a_committed_rows_prompt_text_joins_the_prompt_history() {
    let live = run_live_events().await;
    eventually_on!(&[&live.handle.cell.stepped], || prompt_list(&live.handle).contains(&"steered words".to_owned()).then_some(())).await;
}

#[tokio::test(start_paused = true)]
async fn a_turn_stamps_its_heartbeat_and_prepares_its_meters_and_syncs_the_compaction_when_it_completes() {
    let rig = Rig::new();
    // The throttle compares with 0 for a header that never beat: a clock inside the first minute stamps nothing.
    rig.clock.0.store(1_700_000_000_000, std::sync::atomic::Ordering::SeqCst);
    let gate: Arc<tokio::sync::Notify> = Arc::default();
    let release = gate.clone();
    rig.set_script(Arc::new(move |run| {
        let release = release.clone();
        Box::pin(async move {
            run.port.input_durable().await.expect("input durable");
            let item = ItemId::from("a1".to_owned());
            run.port.delta(item.clone(), "hello ".into()).await.expect("delta");
            run.port.delta(item, "again".into()).await.expect("delta");
            run.port.send_check(crate::session::run::SendCheck { messages: Vec::new().into(), tools: Vec::new(), reactive: false }).await.expect("check");
            release.notified().await;
            RunOutcome::Completed(Default::default())
        })
    }));
    let directory = SessionDirectory::new(rig.deps());
    let handle = start_thread(&directory).await;
    turn(&handle, "go", "op-1").await;
    eventually_on!(&[&handle.cell.stepped], || handle
        .live_header()
        .header()
        .get("lastHeartbeatAt")
        .filter(|at| at.as_f64().is_some_and(|at| at > 0.0))
        .map(|_| ()))
    .await;
    let stamped = handle.live_header().header().get("lastHeartbeatAt").cloned();
    assert_eq!(*lock(&rig.compaction.sync_calls), vec![true], "the installation syncs; a turn start and its checks do not");
    gate.notify_one();
    eventually_on!(&[&handle.cell.stepped], || idle(&handle).then_some(())).await;
    let live = handle.live_header();
    let header = live.header();
    assert_eq!(*lock(&rig.compaction.sync_calls), vec![true, true], "the completed turn syncs again");
    assert_eq!(header.get("lastHeartbeatAt"), stamped.as_ref(), "the second delta is inside the minute");
    let provider = header.get("provider").and_then(Value::as_str).unwrap_or_default().to_owned();
    assert_eq!(*lock(&rig.compaction.prepared), vec![(provider, 0usize)]);
}

#[tokio::test(start_paused = true)]
async fn a_goal_continues_across_a_turn_until_it_stops() {
    use mixdog_core_goal::goal::hooks::GoalViewHooks;

    let rig = Rig::new();
    let inputs: Arc<Mutex<Vec<Value>>> = Arc::default();
    let (seen, goals) = (inputs.clone(), rig.goals.clone());
    rig.set_script(Arc::new(move |run| {
        let (seen, goals) = (seen.clone(), goals.clone());
        Box::pin(async move {
            run.port.input_durable().await.expect("input durable");
            let automatic = run.input_body.pointer("/meta/source") == Some(&json!("goal-continuation"));
            lock(&seen).push(run.input_body.clone());
            let action = if automatic {
                // The automatic turn does work, then the Goal is paused.
                let call = ItemCommit {
                    iid: ItemId::from(format!("t-{}", run.turn)),
                    role: Some("tool".into()),
                    model: true,
                    visible: true,
                    body: json!({ "role": "tool", "toolCallId": "c1", "content": "ok" }),
                    prompt: None,
                };
                run.port.commit_item(call).await.expect("tool row");
                json!({ "action": "pause" })
            } else {
                json!({ "action": "create", "objective": "Ship the feature" })
            };
            goals.goal_control(&run.thread, action).await.expect("goal control");
            RunOutcome::Completed(Default::default())
        })
    }));
    let directory = SessionDirectory::new(rig.deps());
    let handle = start_thread(&directory).await;
    turn(&handle, "start", "op-1").await;
    eventually_on!(&[&handle.cell.stepped], || (lock(&inputs).len() == 2 && idle(&handle)).then_some(())).await;
    let goal_status = |frames: &[(u64, String, Value)]| {
        frames.iter().rev().find(|(_, method, _)| method == "thread/goal/updated").map(|(_, _, p)| p["value"]["status"].clone())
    };
    eventually_on!(&[&rig.feeds.published], || (goal_status(&rig.feeds.frames(handle.id.as_str())) == Some(json!("paused"))).then_some(())).await;
    mixdog_rt::time::sleep(std::time::Duration::from_millis(200)).await;
    let inputs = lock(&inputs).clone();
    assert_eq!(inputs.len(), 2, "a paused Goal does not continue: {inputs:?}");
    let meta = &inputs[1]["meta"];
    assert_eq!((&meta["source"], &meta["synthetic"]), (&json!("goal-continuation"), &json!(true)), "{meta}");
    // Its prompt carries the turn's transcript metadata as a user prompt does (`persistedUserTranscriptMetadata`).
    assert!(meta.pointer("/transcript/messageId").and_then(Value::as_str).is_some_and(|id| id.starts_with("msg_")), "{meta}");
    assert!(meta.pointer("/transcript/attemptId").and_then(Value::as_str).is_some_and(|id| !id.is_empty()), "{meta}");
    assert!(!inputs[1]["content"].as_str().unwrap_or_default().is_empty(), "the runtime's continuation prompt");
    let users: Vec<String> = rows(&handle).into_iter().filter(|(role, _)| *role == "user").map(|(_, text)| text).collect();
    assert_eq!(users, ["start"], "the automatic turn shows no user row");
    let frames = rig.feeds.frames(handle.id.as_str());
    let statuses: Vec<Value> = frames.iter().filter(|(_, m, _)| m == "thread/goal/updated").map(|(_, _, p)| p["value"]["status"].clone()).collect();
    assert!(statuses.contains(&json!("active")), "{statuses:?}");
}

/// A turn queued behind a running one starts only once the running turn's settlement
/// (`turn_settled`) has returned, as Node's queue drains after `runTurn` awaits it.
#[tokio::test(start_paused = true)]
async fn a_queued_turn_starts_after_the_settlement_returns() {
    use std::sync::atomic::Ordering;

    let rig = Rig::new();
    rig.set_script(echo());
    let release: Arc<tokio::sync::Notify> = Arc::default();
    let settled: Arc<std::sync::atomic::AtomicUsize> = Arc::default();
    let mut deps = rig.deps_parts(rig.store.clone());
    deps.goals = Arc::new(HeldSettle { goals: rig.goals.clone(), release: release.clone(), settled: settled.clone() });
    let directory = SessionDirectory::new(Arc::new(deps));
    let handle = start_thread(&directory).await;
    turn(&handle, "one", "op-1").await;
    eventually_on!(&[&handle.cell.stepped], || idle(&handle).then_some(())).await;
    // The first turn ended; its settlement is held. A new prompt waits behind it.
    let queued = turn(&handle, "two", "op-2").await;
    assert_eq!(queued["kind"], "queued", "{queued}");
    mixdog_rt::time::sleep(std::time::Duration::from_millis(100)).await;
    assert!(idle(&handle), "no turn starts before the settlement");
    assert_eq!(settled.load(Ordering::SeqCst), 0);
    release.notify_one();
    eventually_on!(&[&handle.cell.stepped], || (settled.load(Ordering::SeqCst) == 1).then_some(())).await;
    eventually_on!(&[&handle.cell.stepped], || rows(&handle).iter().any(|(role, text)| *role == "user" && text == "two").then_some(())).await;
    release.notify_one();
    eventually_on!(&[&handle.cell.stepped], || (idle(&handle) && rows(&handle).len() == 4).then_some(())).await;
}

/// Each run fails on exhausted provider quota with the reset the provider named, as the run host
/// reports it; the session shows the failed turn end and the quota settlement reads it.
fn quota_failure() -> Script {
    Arc::new(|run| {
        Box::pin(async move {
            run.port.input_durable().await.expect("input durable");
            RunOutcome::Failed(super::testing::quota_error(5000))
        })
    })
}

#[tokio::test(start_paused = true)]
async fn a_cancel_inside_the_quota_settling_window_keeps_the_suspension_unrecorded() {
    use std::sync::atomic::Ordering;

    use mixdog_core_goal::goal::hooks::GoalViewHooks;

    let rig = Rig::new();
    let release: Arc<tokio::sync::Notify> = Arc::default();
    let settled: Arc<std::sync::atomic::AtomicUsize> = Arc::default();
    let mut deps = rig.deps_parts(rig.store.clone());
    deps.goals = Arc::new(HeldSettle { goals: rig.goals.clone(), release: release.clone(), settled: settled.clone() });
    let directory = SessionDirectory::new(Arc::new(deps));
    // A new active Goal continues at once: its automatic turn fails on quota, and the
    // settlement is held.
    let failed_turn = |rig: &Rig, handle: Arc<SessionHandle>| {
        let goals = rig.goals.clone();
        async move {
            goals.goal_control(&handle.id, json!({ "action": "create", "objective": "Ship it" })).await.expect("create");
            let goal = goals.goal_status(&handle.id).await.expect("status").expect("a goal");
            let attempt = eventually_on!(&[&handle.cell.stepped], || {
                handle.cell.view.load_full().items.iter().find_map(|item| match item.as_ref() {
                    ThreadItem::TurnEnd { meta, .. } => meta.ext.get("attemptId").and_then(Value::as_str).map(str::to_owned),
                    _ => None,
                })
            })
            .await;
            (goal["id"].as_str().expect("goal id").to_owned(), format!("attempt:{attempt}"))
        }
    };
    rig.set_script(quota_failure());

    // Settled undisturbed: the resume waits and the suspended Goal is recorded.
    let first = start_routed_thread(&directory).await;
    let (goal_id, key) = failed_turn(&rig, first.clone()).await;
    eventually_on!(&[&rig.quota_changed, &first.cell.stepped], || rig.quota.entry(first.id.as_str()).filter(|entry| entry.turn_key == key)).await;
    assert_eq!(settled.load(Ordering::SeqCst), 0);
    release.notify_one();
    eventually_on!(&[&rig.quota_changed, &first.cell.stepped], || (rig.quota.suspended_goal(first.id.as_str(), &key) == goal_id).then_some(())).await;

    // A prompt while the failed turn settles: the resume goes, and the settlement records nothing.
    let second = start_routed_thread(&directory).await;
    let (_, key) = failed_turn(&rig, second.clone()).await;
    let id = second.id.as_str();
    eventually_on!(&[&rig.quota_changed, &second.cell.stepped], || rig.quota.entry(id).filter(|entry| entry.turn_key == key)).await;
    rig.set_script(echo());
    let queued = turn(&second, "next", "op-next").await;
    assert_eq!(queued["kind"], "queued", "the failed turn is still settling: {queued}");
    eventually_on!(&[&rig.quota_changed, &second.cell.stepped], || rig.quota.entry(id).is_none().then_some(())).await;
    release.notify_one();
    eventually_on!(&[&second.cell.stepped], || (settled.load(Ordering::SeqCst) == 2).then_some(())).await;
    eventually_on!(&[&second.cell.stepped], || rows(&second).iter().any(|(role, text)| *role == "user" && text == "next").then_some(())).await;
    release.notify_one();
    eventually_on!(&[&second.cell.stepped], || (settled.load(Ordering::SeqCst) == 3).then_some(())).await;
    // The settlement's store call runs after the cancel's, on the session's quota lane.
    mixdog_rt::time::sleep(Duration::from_millis(200)).await;
    assert_eq!(rig.quota.suspended_goal(id, &key), "", "the cancel inside the window wins");
    assert!(rig.quota.entry(id).is_none());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_scheduler_fire_replays_the_failed_turn_once() {
    use super::quota_resume_host::SessionResumeHost;
    use super::quota_resume_scheduler::FireOutcome;
    use super::quota_resume_scheduler::ResumeHost;

    let rig = Rig::new();
    let directory = Arc::new(SessionDirectory::new(rig.deps()));
    rig.set_script(quota_failure());
    let handle = start_routed_thread(&directory).await;
    let id = handle.id.as_str().to_owned();
    turn(&handle, "build the parser", "op-failed").await;
    let entry = eventually_on!(&[&rig.quota_changed, &handle.cell.stepped], || rig.quota.entry(&id)).await;
    rig.set_script(echo());
    let host = SessionResumeHost::new(directory.clone(), Arc::new(NoUsage));
    host.materialize(&id).await.expect("loaded");
    // A generation that is not queued is stale at once.
    assert_eq!(host.fire(&id, entry.generation + 1).await, Ok(FireOutcome::Stale));
    // The fire answers `Busy` while `retry_blocked` holds (a turn, the quota settlement, a compaction, a wake, queued input):
    // wait for the actor to publish that it does not.
    eventually_on!(&[&handle.cell.stepped, &rig.quota_changed], || (!handle.cell.retry_blocked.load(std::sync::atomic::Ordering::SeqCst)).then_some(())).await;
    let outcome = host.fire(&id, entry.generation).await;
    assert_eq!(outcome, Ok(FireOutcome::Fired));
    assert_eq!(host.fire(&id, entry.generation).await, Ok(FireOutcome::Stale), "a repeat of the generation");
    eventually_on!(&[&rig.quota_changed, &handle.cell.stepped], || rig.quota.entry(&id).is_none().then_some(())).await;
    // The retry ran (the failed turn's own message, or its prompt, is what it answered).
    eventually_on!(&[&handle.cell.stepped], || rows(&handle).iter().any(|(role, text)| *role == "assistant" && text.starts_with("re: ")).then_some(())).await;
    eventually_on!(&[&handle.cell.stepped], || idle(&handle).then_some(())).await;
    assert_eq!(host.fire(&id, entry.generation).await, Ok(FireOutcome::Stale), "after the retry ran");
}

/// A restored window shows each compaction's divider where 1.4.5 restores it (after the rows
/// before the compaction, when its replacement kept none of them), the switches anchored on its
/// summary right after it, and a switch recorded live on the summary joins them.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_restored_compaction_shows_its_divider_and_the_switches_on_its_summary() {
    let data = tempfile::tempdir().expect("data dir");
    let store = real_store(data.path()).await;
    let rig = Rig::new();
    rig.set_script(echo());
    let directory = SessionDirectory::new(rig.deps_on(store.clone()));
    let handle = start_thread(&directory).await;
    turn(&handle, "first", "op-1").await;
    eventually_on!(&[&handle.cell.stepped], || (idle(&handle) && rows(&handle).len() == 2).then_some(())).await;
    rig.set_script(Arc::new(|run| {
        Box::pin(async move {
            run.port.input_durable().await.expect("input durable");
            let summary = json!({ "role": "user", "content": "[summary] earlier work" });
            let compaction = super::run::Compaction { replacement: vec![(ItemId::from("sum1".to_owned()), summary)], at: 777, dropped_count: 3, dropped: None };
            run.port.compacted(compaction).await.expect("compacted");
            RunOutcome::Completed(Default::default())
        })
    }));
    turn(&handle, "compact", "op-2").await;
    eventually_on!(&[&handle.cell.stepped], || (idle(&handle) && rows(&handle).len() == 4).then_some(())).await;
    let ids = |handle: &SessionHandle| -> Vec<String> { handle.cell.view.load_full().items.iter().map(|item| item.id().as_str().to_owned()).collect() };
    // Live: the divider shows where the compaction happened, and a switch on its summary
    // shows right after it.
    let live = ids(&handle);
    assert!(live[3].starts_with("divider:") && !live[3].contains(":model:"), "{live:?}");
    // Live: the rows the compaction took out of the context show `archived` once it is durable, as a reopen shows them.
    let archived = |handle: &SessionHandle| -> Vec<bool> {
        handle.cell.view.load_full().items.iter().map(|item| super::view::meta(item).ext.get("archived") == Some(&json!(true))).collect()
    };
    eventually_on!(&[&handle.cell.stepped], || archived(&handle)[0].then_some(())).await;
    let marked = archived(&handle);
    assert_eq!(marked, [true, true, true, false], "every row before the compaction, and not its divider");
    let id = handle.id.clone();
    let switch = |at: i64| json!({ "provider": "openai", "modelId": "gpt-next", "at": at });
    assert!(super::record_model_switch(&directory, &id, &switch(300)).await.expect("record"));
    eventually_on!(&[&handle.cell.stepped], || (ids(&handle).len() == 5).then_some(())).await;
    assert_eq!(ids(&handle)[4], format!("{}:model:300", live[3]));

    let reopened = SessionDirectory::new(rig.deps_on(store));
    let restored = reopened.open_handle(&id, &CallContext::internal("test")).await.expect("open");
    let shown = ids(&restored);
    let divider = shown.iter().position(|id| id.starts_with("divider:") && !id.contains(":model:")).expect("a divider");
    assert_eq!(divider, 3, "after the rows before the compaction: {shown:?}");
    assert_eq!(archived(&restored)[..4], marked[..], "the live marks are the reopened window's");
    let cid = shown[divider].trim_start_matches("divider:").to_owned();
    assert_eq!(shown[divider + 1..], [format!("divider:{cid}:model:300")]);
    let ThreadItem::ContextCompaction { meta, .. } = restored.cell.view.load_full().items[divider].as_ref().clone() else {
        panic!("the divider is a compaction row");
    };
    assert_eq!(meta.at, Some(777));

    assert!(super::record_model_switch(&reopened, &id, &switch(400)).await.expect("record live"));
    eventually_on!(&[&restored.cell.stepped], || (ids(&restored).len() == shown.len() + 1).then_some(())).await;
    assert_eq!(ids(&restored)[divider + 1..], [format!("divider:{cid}:model:300"), format!("divider:{cid}:model:400")]);
}

fn compact_event(before_tokens: u64, after_tokens: u64) -> mixdog_agent::env::CompactEvent {
    mixdog_agent::env::CompactEvent {
        dropped_count: 3,
        dropped: None,
        trigger: mixdog_agent::env::CompactTrigger::Auto,
        status: mixdog_agent::env::CompactStatus::Compacted,
        before_tokens,
        duration_ms: 110,
        after_tokens,
        before_messages: 4,
        after_messages: 1,
        pressure_tokens: before_tokens,
        trigger_tokens: 500_000,
        boundary_tokens: 500_000,
        target_budget_tokens: 40_000,
    }
}

fn compaction_record(iid: &str, at: i64, size: usize) -> super::run::Compaction {
    let summary = json!({ "role": "user", "content": format!("[summary] {iid}{}", "x".repeat(size)) });
    super::run::Compaction { replacement: vec![(ItemId::from(iid.to_owned()), summary)], at, dropped_count: 3, dropped: None }
}

fn compaction_rows(handle: &SessionHandle) -> Vec<(i64, Option<String>)> {
    handle
        .cell
        .view
        .load_full()
        .items
        .iter()
        .filter(|item| {
            matches!(item.as_ref(), ThreadItem::ContextCompaction { .. })
                || super::view::meta(item).label.as_deref().is_some_and(|label| label.starts_with("Compact"))
        })
        .map(|item| (super::view::meta(item).at.unwrap_or_default(), super::view::meta(item).detail.clone()))
        .collect()
}

#[tokio::test(start_paused = true)]
async fn one_compaction_of_a_run_shows_one_divider_with_its_stats() {
    for event_first in [true, false] {
        let rig = Rig::new();
        rig.set_script(Arc::new(move |run| {
            Box::pin(async move {
                run.port.input_durable().await.expect("input durable");
                let event = compact_event(537_276, 41_248);
                let summary = json!({ "role": "user", "content": "[summary] earlier work" });
                let compaction =
                    super::run::Compaction { replacement: vec![(ItemId::from("sum1".to_owned()), summary)], at: 777, dropped_count: 3, dropped: None };
                if event_first {
                    run.port.compact_event(event).await.expect("compact");
                    run.port.compacted(compaction).await.expect("compacted");
                } else {
                    run.port.compacted(compaction).await.expect("compacted");
                    run.port.compact_event(event).await.expect("compact");
                }
                RunOutcome::Completed(Default::default())
            })
        }));
        let directory = SessionDirectory::new(rig.deps());
        let handle = start_thread(&directory).await;
        turn(&handle, "go", "op-1").await;
        eventually_on!(&[&handle.cell.stepped], || idle(&handle).then_some(())).await;
        assert_eq!(compaction_rows(&handle), [(777, Some("1s · 537k→41k".to_owned()))], "event first: {event_first}");
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn two_compactions_of_one_turn_pair_their_stats_in_order_and_reopen_as_two_dividers() {
    for event_first in [true, false] {
        let data = tempfile::tempdir().expect("data dir");
        let store = real_store(data.path()).await;
        let rig = Rig::new();
        rig.set_script(Arc::new(move |run| {
            Box::pin(async move {
                run.port.input_durable().await.expect("input durable");
                if event_first {
                    run.port.compact_event(compact_event(537_276, 41_248)).await.expect("event a");
                    run.port.compact_event(compact_event(300_000, 20_000)).await.expect("event b");
                    run.port.compacted(compaction_record("sum1", 777, 0)).await.expect("record a");
                    run.port.compacted(compaction_record("sum2", 888, 0)).await.expect("record b");
                } else {
                    run.port.compacted(compaction_record("sum1", 777, 0)).await.expect("record a");
                    run.port.compacted(compaction_record("sum2", 888, 0)).await.expect("record b");
                    run.port.compact_event(compact_event(537_276, 41_248)).await.expect("event a");
                    run.port.compact_event(compact_event(300_000, 20_000)).await.expect("event b");
                }
                RunOutcome::Completed(Default::default())
            })
        }));
        let directory = SessionDirectory::new(rig.deps_on(store.clone()));
        let handle = start_thread(&directory).await;
        turn(&handle, "go", "op-1").await;
        eventually_on!(&[&handle.cell.stepped], || idle(&handle).then_some(())).await;
        assert_eq!(
            compaction_rows(&handle),
            [(777, Some("1s · 537k→41k".to_owned())), (888, Some("1s · 300k→20k".to_owned()))],
            "live, event first: {event_first}"
        );
        let id = handle.id.clone();
        let reopened = SessionDirectory::new(rig.deps_on(store));
        let restored = reopened.open_handle(&id, &CallContext::internal("test")).await.expect("open");
        assert_eq!(compaction_rows(&restored), [(777, None), (888, None)], "reopened, event first: {event_first}");
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_rejected_compaction_record_leaves_no_divider_in_either_arrival_order_and_later_pairs_stay_aligned() {
    for event_first in [true, false] {
        let data = tempfile::tempdir().expect("data dir");
        let store = real_store(data.path()).await;
        let rig = Rig::new();
        rig.set_script(Arc::new(move |run| {
            Box::pin(async move {
                run.port.input_durable().await.expect("input durable");
                let oversized = mixdog_protocol::MAX_BLOB_BYTES as usize + 1;
                let events = [compact_event(537_276, 41_248), compact_event(400_000, 30_000), compact_event(300_000, 20_000)];
                let records = [compaction_record("sum1", 777, 0), compaction_record("sum2", 888, oversized), compaction_record("sum3", 999, 0)];
                if event_first {
                    for event in events {
                        run.port.compact_event(event).await.expect("event");
                    }
                    for record in records {
                        let _ = run.port.compacted(record).await;
                    }
                } else {
                    for record in records {
                        let _ = run.port.compacted(record).await;
                    }
                    for event in events {
                        run.port.compact_event(event).await.expect("event");
                    }
                }
                RunOutcome::Completed(Default::default())
            })
        }));
        let directory = SessionDirectory::new(rig.deps_on(store.clone()));
        let handle = start_thread(&directory).await;
        turn(&handle, "go", "op-1").await;
        eventually_on!(&[&handle.cell.stepped], || idle(&handle).then_some(())).await;
        assert_eq!(
            compaction_rows(&handle),
            [(777, Some("1s · 537k→41k".to_owned())), (999, Some("1s · 300k→20k".to_owned()))],
            "live, event first: {event_first}"
        );
        let id = handle.id.clone();
        let reopened = SessionDirectory::new(rig.deps_on(store));
        let restored = reopened.open_handle(&id, &CallContext::internal("test")).await.expect("open");
        assert_eq!(compaction_rows(&restored), [(777, None), (999, None)], "reopened, event first: {event_first}");
    }
}

/// `recordModelSwitchBoundary`: the boundary goes on the switch anchor once, as a record
/// naming the stored row; the live row follows the anchor's, and a reader folds the record
/// back onto the anchor's `meta.modelSwitches`. A connection cannot write one.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_model_switch_is_recorded_once_on_its_anchor_and_read_back_folded() {
    let data = tempfile::tempdir().expect("data dir");
    let store = real_store(data.path()).await;
    let rig = Rig::new();
    rig.set_script(echo());
    let directory = SessionDirectory::new(rig.deps_on(store.clone()));
    let handle = start_thread(&directory).await;
    turn(&handle, "hello", "op-1").await;
    eventually_on!(&[&handle.cell.stepped], || (idle(&handle) && rows(&handle).len() == 2).then_some(())).await;
    let id = handle.id.clone();
    let boundary = json!({ "provider": "openai", "modelId": "gpt-next", "at": 200 });
    assert!(super::record_model_switch(&directory, &id, &boundary).await.expect("record"));
    assert!(super::record_model_switch(&directory, &id, &boundary).await.expect("again"), "recorded once");
    let items = handle.cell.view.load_full().items.clone();
    assert_eq!(items.len(), 3, "the switch row follows the anchor's");
    // The test transcript shows a row under its stored id.
    let anchor_iid = items[1].id().as_str().to_owned();
    assert_eq!(items[2].id().as_str(), format!("{anchor_iid}:model:200"));

    let reopened = SessionDirectory::new(rig.deps_on(store));
    let (_, anchor) = reopened.history_row(&id, &anchor_iid).await.expect("read").expect("anchor row");
    let mixdog_store::schema::blob::Slot::Inline(body) = &anchor.body else { panic!("inline") };
    assert_eq!(body["meta"]["modelSwitches"], json!([boundary]));

    let refused = handle
        .request(request("thread/boundary/record", json!({ "threadId": id, "anchor": { "iid": anchor_iid, "ordinal": 1 }, "entry": boundary }), "op-x"))
        .await;
    assert!(matches!(refused, Err(CoreError::InvalidParams { .. })), "{refused:?}");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn the_real_store_reopens_a_thread_and_appends_after_it() {
    let data = tempfile::tempdir().expect("data dir");
    let store = real_store(data.path()).await;
    let rig = Rig::new();
    rig.set_script(echo());

    let first = SessionDirectory::new(rig.deps_on(store.clone()));
    let handle = start_thread(&first).await;
    turn(&handle, "hello", "op-1").await;
    eventually_on!(&[&handle.cell.stepped], || (idle(&handle) && rows(&handle).len() == 2).then_some(())).await;
    turn(&handle, "again", "op-2").await;
    eventually_on!(&[&handle.cell.stepped], || (idle(&handle) && rows(&handle).len() == 4).then_some(())).await;
    let id = handle.id.clone();
    handle.request(request("thread/name/set", json!({ "threadId": id, "opId": "op-name", "title": "  Haiku  " }), "op-name")).await.expect("name/set");
    // The index answers the metadata with the stored (normalized) title, without loading anything.
    // Reading a row waits for the index to hold every barrier acked so far.
    first.history_row(&id, handle.cell.view.load_full().items[0].id().as_str()).await.expect("read");
    let meta = first.session_meta(&id).await.expect("meta").expect("listed");
    assert_eq!(meta.title.as_deref(), Some("Haiku"), "the index answers the stored title");
    assert_eq!(meta.agent, Value::Null);
    assert_eq!(meta.owner_session_id, Value::Null);
    assert_eq!(first.session_meta(&ThreadId::from("missing")).await.expect("meta"), None);

    // A fresh directory opens the thread from its log and the index.
    let second = SessionDirectory::new(rig.deps_on(store));
    let reopened = second.open_handle(&id, &CallContext::internal("test")).await.expect("open");
    assert_eq!(rows(&reopened), rows(&handle));
    assert_eq!(prompt_list(&reopened), ["again", "hello"]);

    // The first write after the open appends to the same log.
    let again = reopened.cell.view.load_full().items[2].id().clone();
    let reply = reopened.request(request("thread/rewind", json!({ "threadId": id, "opId": "op-3", "itemId": again }), "op-3")).await.expect("rewind");
    let Reply::Value(value) = reply else { panic!() };
    assert_eq!(value["text"], "again");
    eventually_on!(&[&reopened.cell.stepped], || (rows(&reopened).len() == 2).then_some(())).await;
    eventually_on!(&[&reopened.cell.stepped], || (prompt_list(&reopened) == ["hello"]).then_some(())).await;
}

#[tokio::test(start_paused = true)]
async fn shutdown_waits_for_the_ingests_at_most_2500_ms() {
    let rig = Rig::new();
    rig.set_script(echo());
    *lock(&rig.closes.delay) = Duration::from_secs(10);
    let directory = SessionDirectory::new(rig.deps());
    let handle = start_thread(&directory).await;
    turn(&handle, "hello", "op-1").await;
    eventually_on!(&[&handle.cell.stepped], || idle(&handle).then_some(())).await;

    let started = tokio::time::Instant::now();
    directory.shutdown().await;
    let took = started.elapsed();
    assert!(took >= Duration::from_millis(2400) && took < Duration::from_millis(4000), "{took:?}");
    assert!(directory.handle(&handle.id).is_none());
    assert!(lock(&rig.closes.seen).is_empty(), "the slow ingest was not waited for");
}

#[tokio::test(start_paused = true)]
async fn a_value_marked_sensitive_while_a_turn_runs_reingests_its_session_search_copy() {
    let rig = Rig::new();
    let (release, gate) = tokio::sync::watch::channel(false);
    rig.set_script(Arc::new(move |run| {
        let mut gate = gate.clone();
        Box::pin(async move {
            run.port.input_durable().await.expect("input durable");
            let _ = gate.wait_for(|open| *open).await;
            RunOutcome::Completed(Default::default())
        })
    }));
    let directory = SessionDirectory::new(rig.deps());
    let handle = start_thread(&directory).await;
    let fill = json!({
        "name": "browser",
        "arguments": { "action": "fill", "input": { "sensitive": true, "text": "hunter2" } },
    });
    // Outside a turn no barrier of a turn follows the mark: the thread rewrites its log and re-ingests its copy itself,
    // once.
    assert!(rig.sensitive.remember(handle.id.as_str(), std::slice::from_ref(&fill)));
    eventually_on!(&[&rig.ingests.1], || (lock(&rig.ingests.0).len() == 1).then_some(())).await;
    turn(&handle, "hold", "op-1").await;
    mixdog_rt::time::sleep(Duration::from_millis(100)).await;
    assert_eq!(lock(&rig.ingests.0).len(), 1);

    let again = json!({
        "name": "browser",
        "arguments": { "action": "fill", "input": { "sensitive": true, "text": "s3cret" } },
    });
    assert!(rig.sensitive.remember(handle.id.as_str(), &[again]));
    eventually_on!(&[&rig.ingests.1], || (lock(&rig.ingests.0).len() == 2).then_some(())).await;
    let (thread, messages) = lock(&rig.ingests.0)[1].clone();
    assert_eq!(thread, handle.id);
    assert_eq!(messages.len(), 1, "the turn's durable input row: {messages:?}");

    release.send(true).expect("release");
    eventually_on!(&[&rig.ingests.1], || (lock(&rig.ingests.0).len() == 3).then_some(())).await;
}

const MARKED_CODE: &str = "482913";

async fn thread_store_over(data: &std::path::Path) -> Arc<super::StoreThreads> {
    use mixdog_core_api::domain::mock::MockOwnership;
    let tokens = mixdog_rt::testing::tokens();
    let root = data.to_path_buf();
    let index = mixdog_rt::LaneToken::submit(tokens.maintenance_io, &mixdog_rt::CancellationToken::new(), move |lane| {
        mixdog_store::sqlite::SqliteStore::open(lane, tokens.sqlite_writer_thread, tokens.interactive_io, &root)
    })
    .expect("lane")
    .await
    .expect("job ran")
    .expect("index");
    Arc::new(super::StoreThreads::over_data_dir(data, index, Arc::new(MockOwnership::default()), tokens.maintenance_io).await.expect("the thread store"))
}

fn holds_marked_code(path: &std::path::Path) -> bool {
    std::fs::read(path).is_ok_and(|bytes| bytes.windows(MARKED_CODE.len()).any(|w| w == MARKED_CODE.as_bytes()))
}

fn files_holding_marked_code(dir: &std::path::Path) -> Vec<std::path::PathBuf> {
    let mut out = Vec::new();
    let mut stack = vec![dir.to_path_buf()];
    while let Some(dir) = stack.pop() {
        for entry in std::fs::read_dir(&dir).into_iter().flatten().flatten() {
            let path = entry.path();
            if path.is_dir() {
                stack.push(path);
            } else if holds_marked_code(&path) {
                out.push(path);
            }
        }
    }
    out
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_value_marked_after_it_was_written_leaves_every_stored_file_and_the_model_context_keeps_it() {
    let data = tempfile::tempdir().expect("data dir");
    let threads = thread_store_over(data.path()).await;
    let rig = Rig::new();
    let deps = rig.deps_parts(threads.clone());
    assert!(threads.redact_with(deps.sensitive.clone()).is_ok());
    let fill = json!({ "id": "c1", "name": "browser", "arguments": { "action": "fill", "input": { "sensitive": true, "text": MARKED_CODE } } });
    let body = json!({ "role": "assistant", "content": "", "toolCalls": [fill.clone()] });
    rig.set_script(Arc::new(move |run| {
        let (body, fill) = (body.clone(), fill.clone());
        Box::pin(async move {
            run.port.input_durable().await.expect("input durable");
            assert!(run.context.remember_sensitive(&[fill]));
            let row = ItemCommit { iid: ItemId::from("a-1"), role: Some("assistant".into()), model: true, visible: true, body, prompt: None };
            run.port.commit_item(row).await.expect("assistant row");
            RunOutcome::Completed(Default::default())
        })
    }));
    let directory = SessionDirectory::new(Arc::new(deps));
    let handle = start_thread(&directory).await;
    let prompt = format!("{MARKED_CODE} is the code from the mail");
    turn(&handle, &prompt, "op-1").await;
    let cwd = handle.cell.header.load_full()["cwd"].as_str().map(str::to_owned).expect("cwd");
    let history = rig.prompts.file(&cwd).expect("a prompt history file");
    eventually_on!(&[&handle.cell.stepped], || idle(&handle).then_some(())).await;
    threads.projected().await;
    eventually_on!(&[&*rig.prompts_wrote], || (history.is_file() && !holds_marked_code(&history)).then_some(())).await;
    let held = files_holding_marked_code(data.path());
    assert!(held.is_empty(), "files holding the value: {held:?}");
    let context = directory.model_context(&handle.id).read().await.expect("context");
    let texts = serde_json::to_string(&context.iter().map(|(_, row)| row.clone()).collect::<Vec<_>>()).expect("rows");
    assert!(texts.contains(&prompt), "the model context keeps the prompt whole: {texts}");
    assert!(std::fs::read_to_string(&history).expect("history").contains("[redacted] is the code from the mail"));
    let list = eventually_on!(&[&handle.cell.stepped], || {
        let list = prompt_list(&handle);
        list.iter().all(|entry| !entry.contains(MARKED_CODE)).then_some(list)
    })
    .await;
    assert_eq!(list, ["[redacted] is the code from the mail"]);
    let restarted = SessionDirectory::new(Arc::new(rig.deps_parts(threads.clone())));
    let reread = restarted.open_handle(&handle.id, &CallContext::internal("test")).await.expect("open");
    let read = reread.request(request("thread/read", json!({ "threadId": handle.id }), "op-read")).await.expect("thread/read");
    let Reply::Value(read) = read else { panic!("thread/read answers a value") };
    let read = serde_json::to_string(&read).expect("json");
    assert!(!read.contains(MARKED_CODE) && read.contains("[redacted] is the code from the mail"), "the loaded view: {read}");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_value_a_worker_marks_after_its_report_leaves_every_owner_up_the_chain() {
    let data = tempfile::tempdir().expect("data dir");
    let threads = thread_store_over(data.path()).await;
    let rig = Rig::new();
    let deps = rig.deps_parts(threads.clone());
    assert!(threads.redact_with(deps.sensitive.clone()).is_ok());
    let marks = deps.sensitive.clone();
    rig.set_script(Arc::new(move |run| {
        Box::pin(async move {
            run.port.input_durable().await.expect("input durable");
            let row = ItemCommit {
                iid: ItemId::from(format!("a-{}", run.turn)),
                role: Some("assistant".into()),
                model: true,
                visible: true,
                body: json!({ "role": "assistant", "content": "noted" }),
                prompt: None,
            };
            run.port.commit_item(row).await.expect("assistant row");
            RunOutcome::Completed(Default::default())
        })
    }));
    let directory = SessionDirectory::new(Arc::new(deps));
    let (parent, child, grandchild) = (start_thread(&directory).await, start_thread(&directory).await, start_thread(&directory).await);
    turn(&parent, &format!("the child reported {MARKED_CODE}"), "op-p").await;
    turn(&child, &format!("the grandchild reported {MARKED_CODE}"), "op-c").await;
    let all = [&parent, &child, &grandchild];
    eventually_on!(&[&parent.cell.stepped, &child.cell.stepped], || all.iter().all(|h| idle(h)).then_some(())).await;
    threads.projected().await;
    let held = || files_holding_marked_code(data.path());
    assert!(!held().is_empty(), "the reports are stored before the mark");
    marks.carry(&grandchild.id, &child.id);
    marks.carry(&child.id, &parent.id);
    let fill = json!({ "id": "c1", "name": "browser", "arguments": { "action": "fill", "input": { "sensitive": true, "text": MARKED_CODE } } });
    assert!(rig.sensitive.remember(grandchild.id.as_str(), &[fill]));
    super::testing::awaiting(|| format!("until no file holds the value: {:?}", held()), async {
        let wakes = [&parent.cell.stepped, &child.cell.stepped, &grandchild.cell.stepped, &*rig.prompts_wrote];
        loop {
            let mut waits: Vec<_> = wakes.iter().map(|wake| Box::pin(wake.notified())).collect();
            for wait in &mut waits {
                wait.as_mut().enable();
            }
            threads.projected().await;
            if held().is_empty() {
                return;
            }
            futures::future::select_all(waits).await;
        }
    })
    .await;
    assert!(all.iter().all(|h| idle(h)), "no turn ran for it");
    assert_eq!(rig.sensitive.redact_text(parent.id.as_str(), MARKED_CODE), "[redacted]", "the parent holds the mark");
}

/// `thread/reactions/set`: the reaction is stored on the user's message (an amend of its row), a
/// repeat changes nothing, and the refusals carry Node's text.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_reaction_is_stored_on_the_users_message_and_refused_as_node_does() {
    let data = tempfile::tempdir().expect("data dir");
    let store = real_store(data.path()).await;
    let rig = Rig::new();
    rig.set_script(Arc::new(|run| {
        Box::pin(async move {
            run.port.input_durable().await.expect("input durable");
            run.port
                .commit_item(ItemCommit {
                    iid: ItemId::from("u1".to_owned()),
                    role: Some("user".into()),
                    model: true,
                    visible: true,
                    body: json!({ "role": "user", "content": "hello", "meta": { "transcript": { "at": 1, "messageId": "m1" } } }),
                    prompt: None,
                })
                .await
                .expect("commit");
            RunOutcome::Completed(Default::default())
        })
    }));
    let directory = SessionDirectory::new(rig.deps_on(store.clone()));
    let handle = start_thread(&directory).await;
    turn(&handle, "go", "op-1").await;
    eventually_on!(&[&handle.cell.stepped], || idle(&handle).then_some(())).await;
    let id = handle.id.clone();
    let react = |params: Value| handle.request(CoreRequest { method: Method("thread/reactions/set"), params, op: None, ctx: CallContext::internal("test") });
    let value = |reply: Result<Reply, CoreError>| match reply.expect("reply") {
        Reply::Value(value) => value,
        Reply::Subscribe(_) => panic!("a value"),
    };

    let set = value(react(json!({ "agentId": "rev", "emoji": "👍", "messagesBack": 0 })).await);
    assert_eq!((set["changed"].clone(), set["messageId"].clone()), (json!(true), json!("m1")));
    assert_eq!(set["reactions"][0]["emoji"], "👍");
    let again = value(react(json!({ "agentId": "rev", "emoji": "👍" })).await);
    assert_eq!(again["changed"], false, "the same emoji again changes nothing");

    let stored = |directory: SessionDirectory| {
        let id = id.clone();
        async move {
            let (_, row) = directory.history_row(&id, "u1").await.expect("read").expect("row");
            let mixdog_store::schema::blob::Slot::Inline(body) = row.body else { panic!("inline") };
            body["meta"]["transcript"].clone()
        }
    };
    let reopened = SessionDirectory::new(rig.deps_on(store.clone()));
    let transcript = stored(reopened).await;
    assert_eq!(transcript["reactions"][0]["agentId"], "rev");
    assert_eq!(transcript["reactions"][0]["emoji"], "👍");

    let domain = |reply: Result<Reply, CoreError>| match reply {
        Err(CoreError::DomainError { message: Some(message), .. }) => message.to_string(),
        other => panic!("a domain error, got {other:?}"),
    };
    let taken = domain(react(json!({ "agentId": "bob", "emoji": "👍", "othersKeep": true })).await);
    assert_eq!(taken, "react: rev already left 👍 on that message");
    let far = domain(react(json!({ "agentId": "rev", "emoji": "🙏", "messagesBack": 3 })).await);
    assert_eq!(far, "react: there are only 1 user messages to react to");

    let removed = value(react(json!({ "agentId": "rev", "emoji": null })).await);
    assert_eq!((removed["changed"].clone(), removed["reactions"].clone()), (json!(true), json!([])));
    let reopened = SessionDirectory::new(rig.deps_on(store));
    assert!(stored(reopened).await.get("reactions").is_none(), "the last removal drops the key");
    let refused = handle.request(request("thread/reactions/set", json!({ "agentId": "rev", "emoji": "👍" }), "op-x")).await;
    assert!(matches!(refused, Err(CoreError::InvalidParams { .. }) | Err(CoreError::PermissionDenied { .. })), "{refused:?}");
}

/// The room log (`agent-room-delivery.mjs` `commit`): a post's rows land in the room session
/// without a turn and show at once; a messageId the conversation holds, or the post repeats,
/// is stored once; a session that does not exist is not available, in Node's words.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_room_post_stores_each_message_once_and_shows_it() {
    use super::room_log::RoomLog;
    let data = tempfile::tempdir().expect("data dir");
    let store = real_store(data.path()).await;
    let rig = Rig::new();
    let directory = Arc::new(SessionDirectory::new(rig.deps_on(store.clone())));
    let handle = start_thread(&directory).await;
    let id = handle.id.clone();
    let log = super::room_log::SessionRoomLog::new(directory.clone());
    let row = |message_id: &str, text: &str| {
        json!({
            "role": "user",
            "content": text,
            "meta": { "source": "room", "room": { "id": "r1", "speaker": "alice" }, "transcript": { "at": 5, "messageId": message_id } },
        })
    };
    let before = rows(&handle).len();
    let added = log.append_rows(id.as_str(), vec![row("m1", "one"), row("m2", "two"), row("m1", "again")]).await.expect("post");
    assert_eq!(added, 2, "a messageId repeated in the post is one row");
    let added = log.append_rows(id.as_str(), vec![row("m2", "two"), row("m3", "three")]).await.expect("post");
    assert_eq!(added, 1, "a messageId the conversation holds is skipped");
    eventually_on!(&[&handle.cell.stepped], || (rows(&handle).len() == before + 3).then_some(())).await;

    let reopened = SessionDirectory::new(rig.deps_on(store));
    let reread = reopened.open_handle(&id, &CallContext::internal("test")).await.expect("open");
    let Reply::Value(value) = reread
        .request(CoreRequest { method: Method("thread/messages/read"), params: json!({}), op: None, ctx: CallContext::internal("test") })
        .await
        .expect("messages")
    else {
        panic!("a value")
    };
    let texts: Vec<&str> = value["messages"].as_array().expect("messages").iter().filter_map(|m| m["content"].as_str()).collect();
    assert_eq!(texts, ["one", "two", "three"]);

    let missing = log.append_rows("sess_gone", vec![row("m9", "x")]).await;
    match missing {
        Err(CoreError::DomainError { message: Some(message), .. }) => assert_eq!(message.to_string(), "session sess_gone is not available"),
        other => panic!("{other:?}"),
    }
}

/// A room post admitted while its log is released on close (Node: the post's save is dropped by the generation fence of the
/// log's detach, and the fixed `commit` fails with `session <id> is not available`; recorded: `startup-interrupted-post-behind-detach`):
/// the post is refused in Node's words and no row is written.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_room_post_admitted_while_its_log_is_released_on_close_is_refused_and_writes_nothing() {
    struct NoShells;
    impl super::shell_jobs::OwnedShells for NoShells {
        fn cancel_owned(&self, _: &ThreadId) {}
    }
    struct NoProviders;
    #[async_trait::async_trait]
    impl mixdog_ai::registry::providers::ProviderBuilder for NoProviders {
        async fn build(&self, name: &str, _: &Value) -> Result<Arc<dyn mixdog_core_api::domain::provider::ProviderAdapter>, String> {
            Err(format!("no {name}"))
        }
        async fn custom_key_ids(&self, _: &str) -> Result<Vec<String>, String> {
            Ok(Vec::new())
        }
        fn available(&self, _: &str) -> bool {
            false
        }
        async fn oauth_credentials_usable(&self, _: &str) -> Result<bool, String> {
            Ok(false)
        }
    }
    let data = tempfile::tempdir().expect("data dir");
    let store = real_store(data.path()).await;
    let rig = Rig::new();
    let directory = Arc::new(SessionDirectory::new(rig.deps_on(store.clone())));
    let handle = start_thread(&directory).await;
    let id = handle.id.clone();
    let providers = Arc::new(mixdog_ai::registry::providers::ProviderRegistry::new(Arc::new(NoProviders)));
    let close = super::close::SessionClose::new(directory.clone(), providers, Arc::new(NoShells), Arc::new(mixdog_tools::fs::ReadState::new(None)));
    let row = json!({
        "role": "assistant",
        "content": "interrupted",
        "meta": { "source": "agent-room", "room": { "kind": "interrupted" }, "transcript": { "at": 5, "messageId": "row_1" } },
    });
    // The post's log is open (admitted) when the log's detach lands.
    assert!(close.detach(id.as_str(), "test", false).await);
    let refused = super::room_log::post_on_opened(&handle, vec![row]).await;
    match refused {
        Err(CoreError::DomainError { message: Some(message), .. }) => assert_eq!(message.to_string(), format!("session {id} is not available")),
        other => panic!("{other:?}"),
    }
    let reopened = SessionDirectory::new(rig.deps_on(store));
    let reread = reopened.open_handle(&id, &CallContext::internal("test")).await.expect("open");
    let Reply::Value(value) = reread
        .request(CoreRequest { method: Method("thread/messages/read"), params: json!({}), op: None, ctx: CallContext::internal("test") })
        .await
        .expect("messages")
    else {
        panic!("a value")
    };
    let texts: Vec<&str> = value["messages"].as_array().expect("messages").iter().filter_map(|m| m["content"].as_str()).collect();
    assert!(!texts.contains(&"interrupted"), "the refused post wrote nothing: {texts:?}");
}

/// A hook's `transcript_path` over the real thread store: Node's `<id>.json` before the session
/// has a model context, the refreshed `<id>.log.jsonl` after it, `null` for an id that names no
/// session.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_hooks_transcript_path_is_the_sessions_export() {
    use mixdog_mcp::hook_bus::TranscriptExport;

    let data = tempfile::tempdir().expect("data dir");
    let store = real_store(data.path()).await;
    let rig = Rig::new();
    rig.set_script(echo());
    let directory = SessionDirectory::new(rig.deps_on(store.clone()));
    let handle = start_thread(&directory).await;
    let tokens = mixdog_rt::testing::tokens();
    let lanes = super::SessionLanes { cpu: tokens.cpu_interactive, io: tokens.interactive_io, durability: tokens.durability_io };
    let files = super::transcript_export::TranscriptFiles::new(data.path(), store.clone(), lanes, tokens.maintenance_io);
    let id = handle.id.as_str().to_owned();
    let sessions = data.path().join("sessions");

    assert_eq!(files.transcript_path(&id).await, json!(sessions.join(format!("{id}.json")).to_string_lossy()));
    let unexported = sessions.join(format!("{id}.log.jsonl"));
    let found = mixdog_core_base::support::on_lane(tokens.maintenance_io, &CancellationToken::new(), move |_| mixdog_statefile::read_content(&unexported))
        .await
        .expect("read job")
        .expect("readable");
    assert!(found.is_none(), "nothing is exported before the first message");
    assert_eq!(files.transcript_path("../x").await, Value::Null);

    turn(&handle, "hello", "op-1").await;
    eventually_on!(&[&handle.cell.stepped], || idle(&handle).then_some(())).await;
    let log = sessions.join(format!("{id}.log.jsonl"));
    assert_eq!(files.transcript_path(&id).await, json!(log.to_string_lossy()));
    let read = log.clone();
    let bytes = mixdog_core_base::support::on_lane(tokens.maintenance_io, &CancellationToken::new(), move |_| mixdog_statefile::read_content(&read))
        .await
        .expect("read job")
        .expect("readable")
        .expect("the export exists");
    let text = String::from_utf8(bytes).expect("UTF-8");
    let lines: Vec<&str> = text.lines().collect();
    assert_eq!(lines.len(), 2, "the session record and the compacted record");
    let session: Value = serde_json::from_str(lines[0]).expect("session line");
    assert_eq!(session["t"], "session");
    assert_eq!(session["id"], id.as_str());
    let tid = ThreadId::from(id.as_str());
    let log_id = on_lane_io(&store, move |store, lane| store.read_log_id(lane, &tid)).await;
    assert_eq!(session["logId"], log_id.as_str());
    assert!(lines[1].starts_with(r#"{"t":"compacted","s":1,"len":2,"messages":["#), "{}", lines[1]);
    assert!(lines[1].contains("hello") && lines[1].contains("re: hello"), "{}", lines[1]);
}

async fn on_lane_io<R: Send + 'static>(
    store: &Arc<dyn super::ThreadStore>,
    job: impl FnOnce(&dyn super::ThreadStore, &mixdog_rt::InLane<mixdog_rt::InteractiveIo>) -> Result<R, CoreError> + Send + 'static,
) -> R {
    use mixdog_rt::LaneToken;
    let tokens = mixdog_rt::testing::tokens();
    let store = store.clone();
    tokens.interactive_io.submit(&CancellationToken::new(), move |lane| job(store.as_ref(), lane)).expect("lane").await.expect("job ran").expect("read")
}

/// A cancel of the pending auto-resume takes effect in memory at once (Node's `cancelEpoch += 1` and
/// `cancelQuotaResumeEntry` are synchronous): with the store write failing, a fire of the cancelled entry
/// is stale and the failed turn is not replayed.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_cancel_whose_store_write_fails_still_disarms_the_pending_resume() {
    use super::quota_resume_host::SessionResumeHost;
    use super::quota_resume_scheduler::FireOutcome;
    use super::quota_resume_scheduler::ResumeHost;
    use mixdog_core_ports::ports::domain_sessions::QuotaResumeSessions;

    let rig = Rig::new();
    let directory = Arc::new(SessionDirectory::new(rig.deps()));
    rig.set_script(quota_failure());
    let handle = start_routed_thread(&directory).await;
    let id = handle.id.as_str().to_owned();
    turn(&handle, "build the parser", "op-failed").await;
    let entry = eventually_on!(&[&rig.quota_changed, &handle.cell.stepped], || rig.quota.entry(&id)).await;
    eventually_on!(&[&handle.cell.stepped], || idle(&handle).then_some(())).await;
    // The next store write fails: the file's place becomes a directory (the atomic rename cannot land).
    let file = rig._data.path().join(mixdog_core_base::quota_resume::QUOTA_RESUME_FILE);
    crate::session::fixture_fs::remove_file(&file);
    crate::session::fixture_fs::create_dir_all(&file);
    directory.cancelled(&handle.id).await.unwrap();
    assert!(rig.quota.entry(&id).is_some(), "the entry is still stored: the write failed");

    rig.set_script(echo());
    let host = SessionResumeHost::new(directory.clone(), Arc::new(NoUsage));
    host.materialize(&id).await.expect("loaded");
    eventually_on!(&[&handle.cell.stepped], || (!handle.cell.busy.load(std::sync::atomic::Ordering::SeqCst)).then_some(())).await;
    let outcome = host.fire(&id, entry.generation).await;
    assert_eq!(outcome, Ok(FireOutcome::Stale), "the cancelled resume does not fire");
    assert!(!rows(&handle).iter().any(|(role, text)| *role == "assistant" && text.starts_with("re: ")), "and the failed turn was not replayed");
}

/// A worker's reply committed while the io-interactive lane is full (its threads and queue taken by jobs a gate holds)
/// waits for room: once the gate lets the lane go the row lands and the turn ends with it, never dropped as closed.
#[tokio::test(start_paused = true)]
async fn a_reply_committed_while_the_io_lane_is_full_lands_once_it_has_room() {
    let rig = Rig::new();
    let (release, gate) = tokio::sync::watch::channel(false);
    let committed: Arc<Mutex<Option<Result<(), super::run::RunError>>>> = Arc::default();
    let seen = committed.clone();
    rig.set_script(Arc::new(move |run| {
        let (mut gate, seen) = (gate.clone(), seen.clone());
        Box::pin(async move {
            run.port.input_durable().await.expect("input durable");
            let _ = gate.wait_for(|open| *open).await;
            let done = run
                .port
                .commit_item(ItemCommit {
                    iid: ItemId::from(format!("a-{}", run.turn)),
                    role: Some("assistant".into()),
                    model: true,
                    visible: true,
                    body: json!({ "text": "re: hello" }),
                    prompt: None,
                })
                .await;
            *lock(&seen) = Some(done);
            RunOutcome::Completed(Default::default())
        })
    }));
    let directory = SessionDirectory::new(rig.deps());
    let handle = start_thread(&directory).await;
    turn(&handle, "hello", "op-1").await;
    let full = mixdog_rt::testing::hold_full(mixdog_rt::LaneKind::InteractiveIo);
    release.send(true).expect("release");
    super::testing::awaiting(|| "the reply's commit to meet the full lane".into(), full.met_by_a_submit()).await;
    assert!(lock(&committed).is_none(), "the commit waits for room");
    assert!(!idle(&handle), "the run waits with it");
    drop(full);
    eventually_on!(&[&rig.ingests.1], || (lock(&rig.ingests.0).len() == 1).then_some(())).await;
    assert_eq!(*lock(&committed), Some(Ok(())));
    let (_, messages) = lock(&rig.ingests.0)[0].clone();
    assert_eq!(messages[1]["text"], "re: hello", "{messages:?}");
}

/// A Lead turn submitted while the io-interactive lane is full is accepted once it has room, not refused as closed.
#[tokio::test(start_paused = true)]
async fn a_turn_submitted_while_the_io_lane_is_full_starts_once_it_has_room() {
    let rig = Rig::new();
    rig.set_script(echo());
    let directory = SessionDirectory::new(rig.deps());
    let handle = start_thread(&directory).await;
    let full = mixdog_rt::testing::hold_full(mixdog_rt::LaneKind::InteractiveIo);
    let submitted = {
        let handle = handle.clone();
        tokio::spawn(async move { turn(&handle, "hello", "op-1").await })
    };
    super::testing::awaiting(|| "the turn's start to meet the full lane".into(), full.met_by_a_submit()).await;
    assert!(!submitted.is_finished(), "the start waits for room");
    drop(full);
    let started = super::testing::awaiting(|| "the turn's start once the lane has room".into(), submitted).await.expect("the submit's task");
    assert_eq!(started["kind"], "started", "{started}");
    eventually_on!(&[&rig.ingests.1], || (lock(&rig.ingests.0).len() == 1).then_some(())).await;
}

/// A turn whose input row's lane job can never run (a lane that cannot take it or signal room) is answered with an error
/// that names the lane, never "The session is closed.".
#[tokio::test]
async fn a_turn_whose_lane_job_is_refused_hears_the_lane_not_closed() {
    let rig = Rig::new();
    rig.set_script(echo());
    let directory = SessionDirectory::new(rig.deps());
    let handle = start_thread(&directory).await;
    let answer = {
        let _refused = mixdog_rt::testing::refuse_jobs_on_this_thread();
        handle.request(request("turn/start", json!({ "threadId": handle.id, "opId": "op-1", "input": { "prompt": "hello" } }), "op-1")).await
    };
    match answer {
        Err(CoreError::QueueFull { queue }) => assert_eq!(&*queue, mixdog_rt::LaneKind::InteractiveIo.name()),
        other => panic!("the refused start names the lane: {other:?}"),
    }
}

/// Each lane job a turn submits, refused in its turn (a lane that cannot run it): the start is answered with its result or
/// an error that names the cause, never "The session is closed.", and the thread takes the next turn.
#[tokio::test]
async fn a_refused_lane_job_anywhere_in_a_turn_never_closes_the_session() {
    let closed = |answer: &Result<Reply, CoreError>| format!("{answer:?}").contains("The session is closed.");
    for n in 0.. {
        let rig = Rig::new();
        // The run hears a refused input or commit as an error and ends interrupted: the refusal is the thread's to answer.
        rig.set_script(Arc::new(|run| {
            Box::pin(async move {
                if run.port.input_durable().await.is_err() {
                    return RunOutcome::Interrupted;
                }
                let commit = ItemCommit {
                    iid: ItemId::from(format!("a-{}", run.turn)),
                    role: Some("assistant".into()),
                    model: true,
                    visible: true,
                    body: json!({ "text": "re" }),
                    prompt: None,
                };
                match run.port.commit_item(commit).await {
                    Ok(_) => RunOutcome::Completed(Default::default()),
                    Err(_) => RunOutcome::Interrupted,
                }
            })
        }));
        let directory = SessionDirectory::new(rig.deps());
        let handle = start_thread(&directory).await;
        let (answer, reached) = {
            let _refused = mixdog_rt::testing::refuse_nth_job_on_this_thread(n);
            let answer = handle.request(request("turn/start", json!({ "threadId": handle.id, "opId": "op-1", "input": { "prompt": "hello" } }), "op-1")).await;
            eventually_on!(&[&handle.cell.stepped], || idle(&handle).then_some(())).await;
            (answer, mixdog_rt::testing::attempts_on_this_thread() > n)
        };
        assert!(!closed(&answer), "job {n} refused: {answer:?}");
        let next = handle.request(request("turn/start", json!({ "threadId": handle.id, "opId": "op-2", "input": { "prompt": "again" } }), "op-2")).await;
        assert!(next.is_ok(), "job {n} refused, then the next turn: {next:?}");
        if !reached {
            break;
        }
    }
}

/// A queue entry an earlier build wrote (its `{"type":"text"}` part beside an image, which this build's intake would have
/// cleaned) is delivered under the one rule on resume: the image reaches the turn's input row, the entry is delivered.
#[tokio::test(start_paused = true)]
async fn a_restored_queue_entry_keeps_its_image_beside_an_empty_text_part() {
    use mixdog_store::schema::blob::Slot;
    use mixdog_store::schema::bounded::Text;
    use mixdog_store::schema::record::{DequeueReason, QueueAction, QueueRecord, Record};
    let rig = Rig::new();
    let inputs: Arc<Mutex<Vec<Value>>> = Arc::default();
    let seen = inputs.clone();
    rig.set_script(Arc::new(move |run| {
        let seen = seen.clone();
        Box::pin(async move {
            run.port.input_durable().await.expect("input durable");
            lock(&seen).push(serde_json::to_value(&run.input.prompt).unwrap());
            RunOutcome::Completed(Default::default())
        })
    }));
    let first = SessionDirectory::new(rig.deps());
    let handle = start_thread(&first).await;
    let reference = "c".repeat(64);
    let entry = json!({
        "message": [
            { "type": "text", "text": "look" },
            { "type": "image", "mimeType": "image/png", "attachmentRef": reference, "sizeBytes": 5 },
            { "type": "text" }
        ],
        "enqueuedAt": 1,
        "priority": "next"
    });
    rig.store.append_record(
        &handle.id,
        Record::Queue(QueueRecord {
            qid: Text::try_from("restored-1").unwrap(),
            action: QueueAction::Enqueue,
            reason: None,
            op: None,
            entry: Some(Slot::Inline(entry)),
        }),
    );
    let second = SessionDirectory::new(rig.deps());
    let reopened = second.open_handle(&handle.id, &CallContext::internal("test")).await.expect("open");
    reopened.cell.deliver(super::control::Ctl::Resumed);
    eventually_on!(&[&reopened.cell.stepped], || (!lock(&inputs).is_empty()).then_some(())).await;
    let content = lock(&inputs)[0].clone();
    assert_eq!(content[0]["text"], "look");
    assert_eq!(content[1]["type"], "image");
    assert_eq!(content[1]["attachmentRef"], json!(reference));
    assert_eq!(content.as_array().map(Vec::len), Some(2), "the empty text part is left out: {content}");
    let dequeued: Vec<DequeueReason> = rig
        .store
        .records(&handle.id)
        .into_iter()
        .filter_map(|(_, record)| match record {
            Record::Queue(queue) if queue.action == QueueAction::Dequeue => queue.reason,
            _ => None,
        })
        .collect();
    assert_eq!(dequeued, [DequeueReason::Delivered]);
}

/// A restored queue entry that cannot be delivered is handed back to its sender under the submission id the sender registered
/// (`options.clientSubmissionId`, what a composer's `wasSubmittedHere` knows), and leaves the queue as cancelled, not delivered.
#[tokio::test(start_paused = true)]
async fn a_refused_queue_entry_is_handed_back_under_its_client_submission_id() {
    use mixdog_store::schema::blob::Slot;
    use mixdog_store::schema::bounded::Text;
    use mixdog_store::schema::record::{DequeueReason, QueueAction, QueueRecord, Record};
    let rig = Rig::new();
    let first = SessionDirectory::new(rig.deps());
    let handle = start_thread(&first).await;
    let entry = json!({
        "message": [{ "type": "text", "text": "look" }, { "type": "text", "attachmentRef": 5 }],
        "options": { "clientSubmissionId": "desktop-submit-abc", "displayText": "look" },
        "enqueuedAt": 1,
        "priority": "next"
    });
    rig.store.append_record(
        &handle.id,
        Record::Queue(QueueRecord {
            qid: Text::try_from("restored-2").unwrap(),
            action: QueueAction::Enqueue,
            reason: None,
            op: None,
            entry: Some(Slot::Inline(entry)),
        }),
    );
    let second = SessionDirectory::new(rig.deps());
    let reopened = second.open_handle(&handle.id, &CallContext::internal("test")).await.expect("open");
    reopened.cell.deliver(super::control::Ctl::Resumed);
    let restores = || -> Vec<Value> {
        rig.feeds.frames(handle.id.as_str()).into_iter().filter(|(_, method, _)| method == "thread/promptRestore").map(|(_, _, value)| value).collect()
    };
    eventually_on!(&[&reopened.cell.stepped, &*rig.feeds.published], || (!restores().is_empty()).then_some(())).await;
    let restore = restores().pop().unwrap();
    assert_eq!(restore["value"]["ids"], json!(["desktop-submit-abc"]), "{restore}");
    assert_eq!(restore["value"]["text"], "look", "{restore}");
    let dequeued: Vec<DequeueReason> = rig
        .store
        .records(&handle.id)
        .into_iter()
        .filter_map(|(_, record)| match record {
            Record::Queue(queue) if queue.action == QueueAction::Dequeue => queue.reason,
            _ => None,
        })
        .collect();
    assert_eq!(dequeued, [DequeueReason::Cancelled]);
}

/// One drain that refuses a prompt and hands back a slash command publishes one hand-back holding both, in queue order: the
/// command's hand-back does not replace the refused prompt's in the session state's one slot.
#[tokio::test(start_paused = true)]
async fn a_drain_hands_back_a_refused_prompt_and_a_command_together() {
    use mixdog_store::schema::blob::Slot;
    use mixdog_store::schema::bounded::Text;
    use mixdog_store::schema::record::{DequeueReason, QueueAction, QueueRecord, Record};
    let rig = Rig::new();
    let first = SessionDirectory::new(rig.deps());
    let handle = start_thread(&first).await;
    let command = json!({ "message": "/usage", "options": { "clientSubmissionId": "sub-usage" }, "enqueuedAt": 1, "priority": "next" });
    let refused = json!({
        "message": [{ "type": "text", "text": "look" }, { "type": "text", "attachmentRef": 5 }],
        "options": { "clientSubmissionId": "desktop-submit-abc", "displayText": "look" },
        "enqueuedAt": 2,
        "priority": "next"
    });
    for (qid, entry) in [("restored-command", command), ("restored-refused", refused)] {
        rig.store.append_record(
            &handle.id,
            Record::Queue(QueueRecord {
                qid: Text::try_from(qid).unwrap(),
                action: QueueAction::Enqueue,
                reason: None,
                op: None,
                entry: Some(Slot::Inline(entry)),
            }),
        );
    }
    let second = SessionDirectory::new(rig.deps());
    let reopened = second.open_handle(&handle.id, &CallContext::internal("test")).await.expect("open");
    reopened.cell.deliver(super::control::Ctl::Resumed);
    let restores = || -> Vec<Value> {
        rig.feeds.frames(handle.id.as_str()).into_iter().filter(|(_, method, _)| method == "thread/promptRestore").map(|(_, _, value)| value).collect()
    };
    eventually_on!(&[&reopened.cell.stepped, &*rig.feeds.published], || (reopened.cell.queued.load().is_empty() && !restores().is_empty()).then_some(())).await;
    let restores = restores();
    assert_eq!(restores.len(), 1, "one hand-back for the drain: {restores:?}");
    assert_eq!(restores[0]["value"]["ids"], json!(["sub-usage", "desktop-submit-abc"]), "{restores:?}");
    assert_eq!(restores[0]["value"]["text"], "/usage\nlook", "{restores:?}");
    let dequeued: Vec<DequeueReason> = rig
        .store
        .records(&handle.id)
        .into_iter()
        .filter_map(|(_, record)| match record {
            Record::Queue(queue) if queue.action == QueueAction::Dequeue => queue.reason,
            _ => None,
        })
        .collect();
    assert_eq!(dequeued, [DequeueReason::Cancelled, DequeueReason::Cancelled]);
}

async fn stage_turn(rig: &Rig, steps: &'static [&'static str], ending: &'static str) -> StageTurn {
    use super::run::CallMark;
    use mixdog_core_ports::ports::threads::Section;
    let gate = Arc::new(tokio::sync::Notify::new());
    let late = Arc::new(tokio::sync::Notify::new());
    let (held, after) = (gate.clone(), late.clone());
    rig.set_script(Arc::new(move |run| {
        let (held, after) = (held.clone(), after.clone());
        Box::pin(async move {
            run.port.input_durable().await.expect("input durable");
            for step in steps {
                match *step {
                    // A cancelled run leaves its hold, as a real run leaves what it waits on.
                    "hold" => tokio::select! {
                        _ = held.notified() => {}
                        _ = run.cancel.cancelled() => {}
                    },
                    "reconnecting" => run
                        .port
                        .stage("reconnecting".into(), Some(json!({ "message": "Retrying", "retryAt": super::spinner::core_now_ms() + 60_000 })))
                        .await
                        .expect("shown"),
                    "streaming" => run.port.call_mark(CallMark::Streaming).await.expect("shown"),
                    "tool" => run.port.call_mark(CallMark::ToolCall).await.expect("shown"),
                    "quiet" => run.port.section(Section::SpinnerQuiet(Some(json!({ "quietMs": 30_000 })))).await.expect("shown"),
                    "resumed" => run.port.section(Section::SpinnerQuiet(None)).await.expect("shown"),
                    stage => run.port.stage(stage.into(), None).await.expect("shown"),
                }
            }
            let port = run.port.clone();
            tokio::spawn(async move {
                after.notified().await;
                let _ = port.stage("compacting".into(), None).await;
                let _ = port.stage("reconnecting".into(), Some(json!({ "message": "late", "retryAt": super::spinner::core_now_ms() + 60_000 }))).await;
            });
            match ending {
                // Not a quota error: that one schedules a replay of the turn, which is another turn.
                "failed" => RunOutcome::Failed(mixdog_protocol::TurnError { message: "the run broke".into(), data: json!({}), provider_error: None }),
                "interrupted" => {
                    run.cancel.cancelled().await;
                    RunOutcome::Interrupted
                }
                _ => RunOutcome::Completed(Default::default()),
            }
        })
    }));
    let directory = SessionDirectory::new(rig.deps());
    let handle = start_thread(&directory).await;
    let started = turn(&handle, "go", "op-1").await;
    let turn_id = TurnId::from(started["turnId"].as_str().expect("turn id"));
    StageTurn { _directory: directory, handle, gate, late, turn_id }
}

/// A recovery snapshot, and a second client attaching at the same sequence later, show `reconnecting` with the wait left at their own
/// delivery, on the core's clock: the deadline's absolute value is meaningless to a client and the clock the stage was published by
/// is not the one the wait is read by.
#[tokio::test(start_paused = true)]
async fn a_snapshot_mid_retry_carries_the_wait_left_at_its_delivery() {
    let rig = Rig::new();
    // A clock far from the wall: the wait published with the stage is nonsense, the delivered one is not.
    rig.clock.0.store(5, std::sync::atomic::Ordering::SeqCst);
    let run = stage_turn(&rig, &["reconnecting", "hold"], "done").await;
    let held = spinner_where(&rig, &run, "reconnecting", |spinner| spinner["mode"] == "reconnecting").await;
    let retry_at = held["retryAt"].as_i64().expect("the deadline is retained");
    assert_eq!(held["verb"], "Retrying");
    let (before, first, after) = (super::spinner::core_now_ms(), attached_spinner(&run.handle, 1).await, super::spinner::core_now_ms());
    assert_eq!((first["mode"].as_str(), first["retryAt"].as_i64()), (Some("reconnecting"), Some(retry_at)));
    let first_left = first["retryInMs"].as_i64().expect("the wait left");
    // The wait left is the deadline minus the core's clock at the delivery, which fell between the two readings; the published
    // clock (5) would have made it about 1.7e12.
    assert!((retry_at - after..=retry_at - before).contains(&first_left), "{first_left} is not the deadline less the core's clock at delivery: {first}");
    // Let the core's clock move on by 100 ms, awaiting the clock itself rather than assuming how long a sleep takes.
    while super::spinner::core_now_ms() < after + 100 {
        std::thread::yield_now();
    }
    // The same sequence: the encoded snapshot is the cached one, and the wait left is the delivery's.
    let second = attached_spinner(&run.handle, 2).await;
    let second_left = second["retryInMs"].as_i64().expect("the wait left");
    assert_eq!(second["retryAt"].as_i64(), Some(retry_at), "the retry keeps its identity");
    assert!(second_left <= first_left - 100, "{second_left} is not at least 100 ms shorter than {first_left}");
    // A read shows the same.
    let view = run.handle.cell.view.load_full();
    let mut read = serde_json::to_value(&view.state).expect("state");
    super::spinner::project_retry(&mut read["runtime"]["spinner"], super::spinner::core_now_ms());
    assert!(read["runtime"]["spinner"]["retryInMs"].as_i64().unwrap() <= second_left);
    run.gate.notify_one();
    spinner_gone(&rig, &run).await;
}

/// A retry that succeeds straight into a tool-only response leaves `reconnecting` on the request's `Streaming`, before any text:
/// the retry fields go with it and no text delta was needed.
#[tokio::test(start_paused = true)]
async fn a_retry_that_succeeds_into_a_tool_only_response_replaces_reconnecting() {
    let rig = Rig::new();
    let run = stage_turn(&rig, &["reconnecting", "hold", "streaming", "hold", "tool", "hold"], "done").await;
    spinner_where(&rig, &run, "reconnecting", |spinner| spinner["mode"] == "reconnecting").await;
    run.gate.notify_one();
    let left = spinner_where(&rig, &run, "responding", |spinner| spinner["mode"] != "reconnecting").await;
    assert_eq!((left["retryAt"].is_null(), left["retryInMs"].is_null()), (true, true), "{left}");
    run.gate.notify_one();
    spinner_where(&rig, &run, "tool-use", |spinner| spinner["mode"] == "tool-use").await;
    run.gate.notify_one();
    spinner_gone(&rig, &run).await;
    let deltas = rig.feeds.frames(run.handle.id.as_str()).into_iter().filter(|(_, method, _)| method.contains("delta")).count();
    assert_eq!(deltas, 0, "no text arrived");
}

/// `compacting` is the mode until the next requesting or streaming, or the turn's end: a pass that succeeds, one that is skipped
/// and one that fails each leave the mode of what came next.
#[tokio::test(start_paused = true)]
async fn compacting_ends_on_the_next_phase_or_the_turns_end() {
    let cases: [(&str, &'static [&'static str], &str, &[&str]); 3] = [
        ("success", &["compacting", "hold", "requesting", "hold", "streaming", "hold"], "done", &["compacting", "requesting", "responding"]),
        ("skipped", &["compacting", "hold", "requesting", "hold"], "done", &["compacting", "requesting"]),
        ("failed", &["compacting", "hold"], "failed", &["compacting"]),
    ];
    for (name, steps, ending, modes) in cases {
        let rig = Rig::new();
        let run = stage_turn(&rig, steps, ending).await;
        for mode in modes {
            spinner_where(&rig, &run, mode, |spinner| spinner["mode"] == *mode).await;
            run.gate.notify_one();
        }
        spinner_gone(&rig, &run).await;
        let _ = name;
    }
}

/// The provider's "still thinking" stage is the mode `model-thinking`, and the request's `Streaming` ends it.
#[tokio::test(start_paused = true)]
async fn model_thinking_ends_on_streaming() {
    let rig = Rig::new();
    let run = stage_turn(&rig, &["model_thinking", "hold", "streaming", "hold"], "done").await;
    spinner_where(&rig, &run, "model-thinking", |spinner| spinner["mode"] == "model-thinking").await;
    run.gate.notify_one();
    spinner_where(&rig, &run, "responding", |spinner| spinner["mode"] == "responding").await;
    run.gate.notify_one();
    spinner_gone(&rig, &run).await;
}

/// The quiet cue is its own field of the spinner: a stage neither sets nor clears it, and progress that resumes is what clears it.
#[tokio::test(start_paused = true)]
async fn the_quiet_cue_is_independent_of_the_stage_and_clears_when_progress_resumes() {
    let rig = Rig::new();
    let run = stage_turn(&rig, &["quiet", "hold", "reconnecting", "hold", "streaming", "resumed", "hold"], "done").await;
    let quiet = spinner_where(&rig, &run, "quiet", |spinner| !spinner["quiet"].is_null()).await;
    assert_eq!(quiet["quiet"]["quietMs"], 30_000);
    run.gate.notify_one();
    let retrying = spinner_where(&rig, &run, "reconnecting", |spinner| spinner["mode"] == "reconnecting").await;
    assert!(!retrying["quiet"].is_null(), "the stage did not clear the quiet cue");
    run.gate.notify_one();
    let resumed = spinner_where(&rig, &run, "resumed", |spinner| spinner["mode"] == "responding" && spinner["quiet"].is_null()).await;
    assert!(resumed["retryAt"].is_null());
    run.gate.notify_one();
    spinner_gone(&rig, &run).await;
}

/// `abortRuntime` aborts synchronously: a control lane that is full (the actor has not drained it) cannot
/// refuse the user's stop.
#[tokio::test(start_paused = true)]
async fn interrupt_cancels_the_run_while_the_control_lane_is_full() {
    let rig = Rig::new();
    let (seen_tx, seen_rx) = tokio::sync::oneshot::channel::<String>();
    let seen_tx = Mutex::new(Some(seen_tx));
    let seen_tx = Arc::new(seen_tx);
    rig.set_script(Arc::new(move |run| {
        let seen_tx = seen_tx.clone();
        Box::pin(async move {
            run.cancel.cancelled().await;
            if let Some(tx) = seen_tx.lock().unwrap().take() {
                let _ = tx.send(run.signal.reason());
            }
            RunOutcome::Interrupted
        })
    }));
    let directory = SessionDirectory::new(rig.deps());
    let handle = start_thread(&directory).await;
    let started = turn(&handle, "long job", "op-1").await;
    let turn_id = TurnId::from(started["turnId"].as_str().expect("turn id"));

    // No await between the fill and the interrupt: the actor drains nothing.
    let mut filled = 0;
    while handle.cell.ctl_tx.try_send(crate::session::control::Ctl::RefreshSurface).is_ok() {
        filled += 1;
    }
    assert_eq!(filled, 32, "the control lane holds 32");
    handle.interrupt(&turn_id, None).expect("interrupt");

    let expected = format!("Session \"{}\" closed: runtime abort (reason=user-cancel)", handle.id.as_str());
    assert_eq!(seen_rx.await.expect("the script observed the cancel"), expected);
}

/// Returns once the actor has taken a message of its inbox. The loop is biased (jobs and deadlines before the inbox), so every
/// timer that is due, and every job it queued, was handled first.
pub async fn caught_up(handle: &SessionHandle) {
    let (tx, taken) = tokio::sync::oneshot::channel();
    handle.inbox.send(super::actor::Inbox::QuotaFacts { tx }).await.expect("the actor takes the inbox");
    crate::session::testing::awaiting(|| "the actor to take a message of its inbox".to_owned(), taken).await.expect("the actor answers");
}

/// Unload, reopen and fork. A control thread that unloads (its last subscriber left and its idle delay passed) is not synced;
/// reopened, it is again, from its record's header. Its heir (`thread/fork`) is a thread of its own, not a second control session.
#[tokio::test(start_paused = true)]
async fn an_unloaded_control_thread_is_synced_again_once_reopened_and_its_heir_is_not() {
    let rig = Rig::new();
    let directory = SessionDirectory::new(rig.deps());
    let id = start_control(&directory, "op-control").await.expect("control start");
    let handle = directory.handle(&id).expect("loaded");
    subscribe(&handle);
    left_idle(&handle).await;
    eventually_on!(&[&handle.cell.stepped, directory.left()], || directory.handle(&id).is_none().then_some(())).await;
    assert!(directory.control_ids().is_empty(), "an unloaded thread is not live");
    handle.inbox.closed().await;
    let reopened = directory.open_handle(&id, &CallContext::internal("test")).await.expect("reopened");
    assert_eq!(directory.control_ids(), [id.clone()]);
    give_conversation(&reopened).await;
    let reply = reopened.request(request("thread/fork", json!({ "threadId": id, "opId": "op-fork" }), "op-fork")).await.expect("thread/fork");
    let Reply::Value(value) = reply else { panic!("thread/fork answers a value") };
    let heir = ThreadId::from(value["thread"]["id"].as_str().expect("heir id"));
    assert!(!directory.handle(&heir).expect("loaded").control);
    assert_eq!(directory.control_ids(), [id]);
}

/// `autoWakeCompletions: false` (`infrastructure.mjs:154`) and an owner that is not the live
/// session (`notification-bus.test.mjs` "no longer the live session"): the completion is kept
/// for the next turn and starts none.
#[tokio::test(start_paused = true)]
async fn no_wake_without_auto_wake_or_for_a_thread_opened_for_the_completion() {
    use mixdog_tools::exec::TaskNotifier;
    let rig = Rig::new();
    rig.set_script(echo());
    let directory = SessionDirectory::new(rig.deps());
    let quiet = start_with_session(&directory, json!({ "autoWakeCompletions": false })).await;
    directory.finished(&quiet.id, "shell", "job-1", "completed", "job-1 finished.".into()).await;

    let parked = start_thread(&directory).await;
    subscribe(&parked);
    left_idle(&parked).await;
    eventually_on!(&[&parked.cell.stepped, directory.left()], || directory.handle(&parked.id).is_none().then_some(())).await;
    directory.finished(&parked.id, "shell", "job-2", "completed", "job-2 finished.".into()).await;

    for (handle, task) in [(&quiet, "job-1"), (&parked, "job-2")] {
        let queued = eventually_on!(&[&rig.store.committed], || {
            rig.store.records(&handle.id).into_iter().find_map(|(_, record)| match record {
                mixdog_store::schema::record::Record::Queue(queue) => queue.entry,
                _ => None,
            })
        })
        .await;
        let mixdog_store::schema::blob::Slot::Inline(entry) = &queued else { panic!("inline entry") };
        assert_eq!(entry["executionId"], task, "kept for the next turn");
    }
    mixdog_rt::time::sleep(Duration::from_millis(100)).await;
    assert_eq!(runs_started(&rig, &quiet.id), 0);
    assert_eq!(runs_started(&rig, &parked.id), 0);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn an_explicit_delete_ends_downloads_at_its_tombstone_before_the_purge_finishes() {
    use mixdog_core_api::domain::mock::MockOwnership;
    use mixdog_store::sqlite::SqliteStore;
    let data = tempfile::tempdir().expect("data dir");
    let tokens = mixdog_rt::testing::tokens();
    let root = data.path().to_path_buf();
    let index = mixdog_rt::LaneToken::submit(tokens.maintenance_io, &mixdog_rt::CancellationToken::new(), move |lane| {
        SqliteStore::open(lane, tokens.sqlite_writer_thread, tokens.interactive_io, &root)
    })
    .expect("lane")
    .await
    .expect("job ran")
    .expect("index");
    let list = index.clone();
    let store: Arc<dyn super::ThreadStore> = Arc::new(
        super::StoreThreads::over_data_dir(data.path(), index, Arc::new(MockOwnership::default()), tokens.maintenance_io).await.expect("the thread store"),
    );
    let rig = Rig::new();
    let directory = SessionDirectory::new(rig.deps_on(store));
    let handle = start_thread(&directory).await;
    turn(&handle, "hello", "op-1").await;
    let id = handle.id.clone();
    eventually_on!(&[&handle.cell.stepped, &rig.store.committed], || { futures::executor::block_on(list.summary(id.as_str())).expect("summary").map(|_| ()) })
        .await;
    let (reached, (release, held)) = (Arc::new(tokio::sync::Notify::new()), std::sync::mpsc::channel());
    *lock(&rig.deletes.6) = Some((reached.clone(), held));
    let delete = {
        let (handle, id) = (handle.clone(), id.clone());
        tokio::spawn(
            async move { handle.request(request("thread/delete", json!({ "threadId": id, "opId": "op-del" }), "op-del")).await.expect("thread/delete") },
        )
    };
    crate::session::testing::awaiting(|| "the purge's first hook".to_owned(), reached.notified()).await;
    let s = id.as_str();
    let steps = lock(&rig.deletes.0).clone();
    assert!(steps.contains(&format!("tombstoned:{s}")), "the downloads were told before the purge: {steps:?}");
    assert!(!steps.contains(&format!("thread/deleted:{s}")), "{steps:?}");
    assert_eq!(list.summary(s).await.expect("summary"), None, "the list row is gone while the purge is held");
    release.send(()).unwrap();
    assert!(matches!(delete.await.unwrap(), Reply::Value(Value::Bool(true))));
    assert!(lock(&rig.deletes.0).contains(&format!("thread/deleted:{s}")));
}

/// Node's reconnect recovery (`turn-checkpoint-recovery.mjs:113-131`): a thread whose process died with a tool call
/// unanswered opens with the call closed as cancelled and the restart line saved, so the first read, before any new
/// turn, shows the recovered conversation.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_turn_the_process_died_in_is_recovered_at_open_before_any_read() {
    let data = tempfile::tempdir().expect("data dir");
    let store = real_store(data.path()).await;
    let rig = Rig::new();
    let committed = Arc::new(tokio::sync::Notify::new());
    let told = committed.clone();
    rig.set_script(Arc::new(move |run| {
        let told = told.clone();
        Box::pin(async move {
            run.port.input_durable().await.expect("input durable");
            let call =
                json!({ "role": "assistant", "content": "Reading.", "toolCalls": [{ "id": "call_1", "name": "read", "arguments": { "path": "a.txt" } }] });
            let item = ItemCommit { iid: ItemId::from("itm_call"), role: Some("assistant".into()), model: true, visible: true, body: call, prompt: None };
            run.port.commit_item(item).await.expect("commit");
            told.notify_one();
            // The process dies here: the run never ends.
            std::future::pending::<RunOutcome>().await
        })
    }));
    let first = SessionDirectory::new(rig.deps_on(store.clone()));
    let handle = start_thread(&first).await;
    let id = handle.id.clone();
    turn(&handle, "read a", "op-1").await;
    crate::session::testing::awaiting(|| "the tool call row to be durable".to_owned(), committed.notified()).await;

    let second = SessionDirectory::new(rig.deps_on(store));
    let reopened = second.open_handle(&id, &CallContext::internal("test")).await.expect("open");
    let Reply::Value(read) = reopened
        .request(CoreRequest { method: Method("thread/messages/read"), params: json!({}), op: None, ctx: CallContext::internal("test") })
        .await
        .expect("read")
    else {
        panic!("a value")
    };
    let messages = read["messages"].as_array().expect("messages");
    let shown: Vec<(&str, &str)> = messages.iter().map(|m| (m["role"].as_str().unwrap_or_default(), m["content"].as_str().unwrap_or_default())).collect();
    assert_eq!(shown, [("user", "read a"), ("assistant", "Reading."), ("tool", "Cancelled"), ("user", "[Request interrupted by process restart]")], "{read}");
    assert_eq!(messages[2]["toolCallId"], "call_1");
}

/// A second crash during recovery must find the run still unfinished: the run's `Interrupted` marker is the last record the
/// recovery writes, behind the cancelled result and the restart line (Node keeps the checkpoint until the recovery is saved).
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn the_marker_of_a_recovered_run_lands_behind_its_recovery_rows() {
    use mixdog_store::schema::record::{Record, RunPhase};
    let rig = Rig::new();
    let committed = Arc::new(tokio::sync::Notify::new());
    let told = committed.clone();
    rig.set_script(Arc::new(move |run| {
        let told = told.clone();
        Box::pin(async move {
            run.port.input_durable().await.expect("input durable");
            let call =
                json!({ "role": "assistant", "content": "Reading.", "toolCalls": [{ "id": "call_1", "name": "read", "arguments": { "path": "a.txt" } }] });
            let item = ItemCommit { iid: ItemId::from("itm_call"), role: Some("assistant".into()), model: true, visible: true, body: call, prompt: None };
            run.port.commit_item(item).await.expect("commit");
            told.notify_one();
            std::future::pending::<RunOutcome>().await
        })
    }));
    let first = SessionDirectory::new(rig.deps());
    let handle = start_thread(&first).await;
    let id = handle.id.clone();
    turn(&handle, "read a", "op-1").await;
    crate::session::testing::awaiting(|| "the tool call row to be durable".to_owned(), committed.notified()).await;

    let second = SessionDirectory::new(rig.deps());
    second.open_handle(&id, &CallContext::internal("test")).await.expect("open");
    let records = rig.store.records(&id);
    let marker = records.iter().position(|(_, record)| matches!(record, Record::Run(run) if run.phase == RunPhase::Interrupted)).expect("the run ended");
    let restart = records
        .iter()
        .position(|(_, record)| matches!(record, Record::Item(row) if format!("{:?}", row.body).contains("process restart")))
        .expect("the restart line was saved");
    assert!(restart < marker, "the marker ends the recovery: {records:?}");
}

/// A run the process died in, with more rows than the opened window holds: its recovery still knows its input row (the
/// row before its start, read from the log), so a finished answer is not taken for an unanswered turn.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_crashed_run_past_the_window_is_recovered_with_its_input_row() {
    let data = tempfile::tempdir().expect("data dir");
    let store = real_store(data.path()).await;
    let rig = Rig::new();
    let committed = Arc::new(tokio::sync::Notify::new());
    let (begun, proceed) = (Arc::new(tokio::sync::Notify::new()), Arc::new(tokio::sync::Notify::new()));
    let (signal, started, go) = (committed.clone(), begun.clone(), proceed.clone());
    rig.set_script(Arc::new(move |run| {
        let (signal, started, go) = (signal.clone(), started.clone(), go.clone());
        Box::pin(async move {
            run.port.input_durable().await.expect("input durable");
            started.notify_one();
            go.notified().await;
            for n in 0..210 {
                let row = ItemCommit {
                    iid: ItemId::from(format!("t-{n}")),
                    role: Some("tool".into()),
                    model: true,
                    visible: true,
                    body: json!({ "text": format!("r{n}") }),
                    prompt: None,
                };
                run.port.commit_item(row).await.expect("a tool row");
            }
            signal.notify_one();
            // The process dies here: the run never ends.
            std::future::pending::<RunOutcome>().await
        })
    }));
    let first = SessionDirectory::new(rig.deps_on(store.clone()));
    let handle = start_thread(&first).await;
    turn(&handle, "hello", "op-1").await;
    crate::session::testing::awaiting(|| "the run's start".to_owned(), begun.notified()).await;
    // The input row, read before the run's rows push it out of the shown window.
    let input = handle.cell.view.load_full().items[0].id().clone();
    proceed.notify_one();
    crate::session::testing::awaiting(|| "the run's rows".to_owned(), committed.notified()).await;

    let second = SessionDirectory::new(rig.deps_on(store));
    let reopened = second.open_handle(&handle.id, &CallContext::internal("test")).await.expect("open");
    eventually_on!(&[&reopened.cell.stepped], || reopened.recovered().then_some(())).await;
    assert_eq!(*lock(&rig.runs.crashed), [Some(input)]);
}

/// A read of a stored session (its header, its context) recovers nothing and loads nothing, even when its turn was cut after
/// the sealed answer was drafted: the draft stays for the open that has work (a turn, a message), and that open recovers it.
/// A session whose turn ended is read the same way.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn reading_a_stored_session_leaves_its_cut_turn_for_the_open_that_has_work() {
    use mixdog_core_ports::ports::threads::ThreadState;
    let data = tempfile::tempdir().expect("data dir");
    let store = real_store(data.path()).await;
    let rig = Rig::new();
    let drafted = Arc::new(tokio::sync::Notify::new());
    let told = drafted.clone();
    rig.set_script(Arc::new(move |run| {
        let told = told.clone();
        Box::pin(async move {
            run.port.input_durable().await.expect("input durable");
            run.port.draft(json!({ "sealed": { "role": "assistant", "content": "the sealed answer" } })).await.expect("drafted");
            told.notify_one();
            // The process dies here: the answer's row never lands.
            std::future::pending::<RunOutcome>().await
        })
    }));
    let first = SessionDirectory::new(rig.deps_on(store.clone()));
    let cut = start_thread(&first).await;
    turn(&cut, "question", "op-1").await;
    crate::session::testing::awaiting(|| "the sealed draft to be durable".to_owned(), drafted.notified()).await;
    rig.set_script(echo());
    let done = start_thread(&first).await;
    turn(&done, "hello", "op-2").await;
    eventually_on!(&[&done.cell.stepped], || (idle(&done) && !done.turn_busy()).then_some(())).await;

    let reader = Arc::new(SessionDirectory::new(rig.deps_on(store)));
    let threads = crate::session::thread_state::SessionThreads::new(reader.clone());
    for id in [&cut.id, &done.id] {
        threads.header(id).await.expect("the header is read");
        reader.model_context(id).read_tail_until(|_| true).await.expect("the context tail is read");
    }
    assert!(reader.loaded_ids().is_empty(), "reading opens no session");
    assert!(lock(&rig.runs.crashed).is_empty(), "reading recovers no turn");

    let opened = reader.open_handle(&cut.id, &CallContext::internal("test")).await.expect("open");
    eventually_on!(&[&opened.cell.stepped], || opened.recovered().then_some(())).await;
    let drafts = lock(&rig.runs.crashed_drafts).clone();
    assert_eq!(drafts.len(), 1, "the open that has work recovers the cut turn");
    assert_eq!(drafts[0].sealed, Some(json!({ "role": "assistant", "content": "the sealed answer" })));
}

/// The last subscriber of a settled thread leaves and its idle delay passes (`Inbox::IdleDue` stands for it, so a test on the
/// real clock does not wait it out): the thread unloads, as Node releases a session `idle and unwatched`.
pub async fn left_idle(handle: &SessionHandle) {
    eventually_on!(&[&handle.cell.stepped], || (!handle.turn_busy()).then_some(())).await;
    handle.cell.unsubscribed();
    // The leave is taken before the deadline: on a multi-threaded runtime a step already polling could take the inbox first.
    caught_up(handle).await;
    handle.inbox.send(super::actor::Inbox::IdleDue).await.expect("the actor takes the inbox");
}

/// `retention.mjs`: the last subscriber leaving retains the thread (`retainedAt`); it unloads once it has been idle and
/// unwatched for the idle delay, and its context goes to memory.
#[tokio::test(start_paused = true)]
async fn an_idle_thread_unloads_one_idle_delay_after_its_last_subscriber_left_and_ingests_its_context() {
    let rig = Rig::new();
    rig.set_script(echo());
    let directory = SessionDirectory::new(rig.deps());
    let handle = start_thread(&directory).await;
    turn(&handle, "hello", "op-1").await;
    eventually_on!(&[&handle.cell.stepped], || (idle(&handle) && !handle.turn_busy()).then_some(())).await;
    subscribe(&handle);
    subscribe(&handle);
    handle.cell.unsubscribed();
    assert!(directory.handle(&handle.id).is_some(), "one subscriber is left");

    handle.cell.unsubscribed();
    caught_up(&handle).await;
    tokio::time::advance(super::actor::IDLE_EVICT - Duration::from_secs(1)).await;
    caught_up(&handle).await;
    assert!(directory.handle(&handle.id).is_some(), "retained for the idle delay");
    tokio::time::advance(Duration::from_secs(2)).await;
    eventually_on!(&[&handle.cell.stepped, directory.left()], || directory.handle(&handle.id).is_none().then_some(())).await;
    eventually_on!(&[&*rig.closes.ended], || (lock(&rig.closes.seen).len() == 1).then_some(())).await;
    assert_eq!(lock(&rig.closes.seen)[0].1.len(), 2, "the input row and the reply");
    assert!(!handle.cell.subscribing(), "an unloaded thread takes no subscriber");
    assert_eq!(*lock(&rig.deletes.0), [format!("unloadMcpScope:{}", handle.id)], "the unload released the thread's MCP scope");
    assert!(lock(&rig.deletes.2).is_empty(), "and did not close its owner");
    // A later open loads it again.
    let reopened = directory.open_handle(&handle.id, &connection()).await.expect("reopen");
    assert!(!Arc::ptr_eq(&reopened.cell, &handle.cell));
}

#[tokio::test(start_paused = true)]
async fn a_refused_last_attach_restarts_idle_eviction() {
    let rig = Rig::new();
    let directory = SessionDirectory::new(rig.deps());
    let handle = start_thread(&directory).await;
    assert!(handle.cell.subscribing());
    handle.inbox.send(super::actor::Inbox::IdleDue).await.expect("the actor takes the deadline");
    caught_up(&handle).await;
    assert!(directory.handle(&handle.id).is_some(), "the pending attach vetoed eviction");

    handle.cell.subscribed(false);
    caught_up(&handle).await;
    tokio::time::advance(super::actor::IDLE_EVICT + Duration::from_secs(1)).await;
    eventually_on!(&[directory.left()], || directory.handle(&handle.id).is_none().then_some(())).await;
}

#[tokio::test(start_paused = true)]
async fn shutdown_waits_for_close_work_of_a_thread_already_evicted() {
    let rig = Rig::new();
    rig.set_script(echo());
    *lock(&rig.closes.delay) = Duration::from_secs(1);
    let directory = SessionDirectory::new(rig.deps());
    let handle = start_thread(&directory).await;
    turn(&handle, "hello", "op-1").await;
    eventually_on!(&[&handle.cell.stepped], || (idle(&handle) && !handle.turn_busy()).then_some(())).await;

    directory.release(&handle.id).await;
    assert!(directory.handle(&handle.id).is_none(), "already evicted before shutdown");
    directory.shutdown().await;
    assert_eq!(lock(&rig.closes.seen).len(), 1, "shutdown joined the evicted thread's ingest");
}

#[tokio::test(start_paused = true)]
async fn a_header_without_an_epoch_is_named_one_and_keeps_its_provider_state() {
    let rig = Rig::new();
    rig.set_script(echo());
    let directory = SessionDirectory::new(rig.deps());
    let handle = start_thread(&directory).await;
    let state = json!({ "openaiResponses": { "model": "m", "seenMessageCount": 2, "previousResponseId": "resp_old" } });
    let patch = json!({ "threadId": handle.id, "set": { "providerState": state }, "unset": ["transcriptEpoch"] });
    handle.request(CoreRequest { method: Method("thread/header/patch"), params: patch, op: None, ctx: CallContext::internal("test") }).await.expect("plant");
    assert!(handle.live_header().header().get("transcriptEpoch").is_none(), "planted as an older build left it");
    turn(&handle, "hello", "op-1").await;
    eventually_on!(&[&handle.cell.stepped], || (idle(&handle) && !handle.turn_busy()).then_some(())).await;
    let header = handle.live_header().header();
    assert!(header.get("transcriptEpoch").and_then(Value::as_str).is_some_and(|epoch| !epoch.is_empty()), "the epoch is minted");
    assert_eq!(header.get("providerState"), Some(&state), "and the state is kept");
}

/// The prefix guard is the actor incarnation's: the runs of one actor share it (a turn's guard is the next turn's baseline), and an
/// actor that ends, however it ends, takes it along, so a replacement starts its first run on none (the agent that failed with
/// `Session state changed unexpectedly.` a minute after its turn ended was refused by the old actor's guard).
#[tokio::test(start_paused = true)]
async fn the_prefix_guard_goes_with_the_actor_incarnation_that_kept_it() {
    let rig = Rig::new();
    let seen = Arc::new(std::sync::Mutex::new(Vec::new()));
    let recorded = seen.clone();
    rig.set_script(Arc::new(move |run| {
        let recorded = recorded.clone();
        Box::pin(async move {
            run.port.input_durable().await.expect("input durable");
            lock(&recorded).push(run.prefix_guard.for_header(&Default::default()));
            run.prefix_guard.keep(Some(mixdog_agent::prefix_guard::Snapshot { provider: "kept".into(), ..Default::default() }));
            RunOutcome::Completed(Default::default())
        })
    }));
    let directory = SessionDirectory::new(rig.deps());
    let handle = start_thread(&directory).await;
    for (n, op) in ["op-1", "op-2"].into_iter().enumerate() {
        turn(&handle, "hello", op).await;
        eventually_on!(&[&handle.cell.stepped], || (idle(&handle) && lock(&seen).len() == n + 1 && !handle.turn_busy()).then_some(())).await;
    }
    // Unloaded at its idle deadline.
    subscribe(&handle);
    left_idle(&handle).await;
    eventually_on!(&[&handle.cell.stepped, directory.left()], || directory.handle(&handle.id).is_none().then_some(())).await;
    handle.inbox.closed().await;
    let reopened = directory.open_handle(&handle.id, &connection()).await.expect("reopen");
    turn(&reopened, "hello", "op-3").await;
    eventually_on!(&[&reopened.cell.stepped], || (idle(&reopened) && lock(&seen).len() == 3 && !reopened.turn_busy()).then_some(())).await;
    // Ended by an unwind, which releases the slot without an unload.
    reopened.inbox.send(super::actor::Inbox::Unwind(super::actor::UnwindAt::Now)).await.expect("the actor runs");
    reopened.inbox.closed().await;
    assert!(directory.handle(&handle.id).is_none());
    let replacement = directory.open_handle(&handle.id, &connection()).await.expect("reopen after the unwind");
    turn(&replacement, "hello", "op-4").await;
    eventually_on!(&[&replacement.cell.stepped], || (idle(&replacement) && lock(&seen).len() == 4 && !replacement.turn_busy()).then_some(())).await;
    let kept = Some(mixdog_agent::prefix_guard::Snapshot { provider: "kept".into(), ..Default::default() });
    assert_eq!(*lock(&seen), [None, kept, None, None], "first run, the same actor's next run, the run after an unload, the run after an unwind");
}

#[tokio::test(start_paused = true)]
async fn a_second_run_looks_up_the_prefix_guard_only_after_the_first_kept_its_own() {
    let rig = Rig::new();
    let log = Arc::new(std::sync::Mutex::new(Vec::<&'static str>::new()));
    let seen = Arc::new(std::sync::Mutex::new(Vec::new()));
    let release: Arc<tokio::sync::Notify> = Arc::default();
    let runs = Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let (script_log, script_seen, script_release) = (log.clone(), seen.clone(), release.clone());
    rig.set_script(Arc::new(move |run| {
        let (log, seen, release, runs) = (script_log.clone(), script_seen.clone(), script_release.clone(), runs.clone());
        Box::pin(async move {
            run.port.input_durable().await.expect("input durable");
            lock(&log).push("lookup");
            lock(&seen).push(run.prefix_guard.for_header(&Default::default()));
            if runs.fetch_add(1, std::sync::atomic::Ordering::SeqCst) == 0 {
                release.notified().await;
            }
            run.prefix_guard.keep(Some(mixdog_agent::prefix_guard::Snapshot { provider: "kept".into(), ..Default::default() }));
            lock(&log).push("keep");
            RunOutcome::Completed(Default::default())
        })
    }));
    let directory = SessionDirectory::new(rig.deps());
    let handle = start_thread(&directory).await;
    turn(&handle, "one", "op-1").await;
    eventually_on!(&[&handle.cell.stepped], || (lock(&log).len() == 1).then_some(())).await;
    let second = turn(&handle, "two", "op-2").await;
    assert_eq!(second["kind"], "queued", "{second}");
    mixdog_rt::time::sleep(std::time::Duration::from_millis(100)).await;
    assert_eq!(*lock(&log), ["lookup"], "the queued prompt's run does not start while the first holds its guard");
    release.notify_one();
    eventually_on!(&[&handle.cell.stepped], || (lock(&log).len() == 4 && idle(&handle) && !handle.turn_busy()).then_some(())).await;
    assert_eq!(*lock(&log), ["lookup", "keep", "lookup", "keep"]);
    let kept = Some(mixdog_agent::prefix_guard::Snapshot { provider: "kept".into(), ..Default::default() });
    assert_eq!(*lock(&seen), [None, kept]);
}

#[tokio::test(start_paused = true)]
async fn a_resumed_subscription_keeps_the_thread_off_the_idle_clock_and_its_last_detach_retains_it() {
    use mixdog_core_api::FeedSource;
    use mixdog_core_api::sink::ConnectionSink;
    let rig = Rig::new();
    rig.set_script(echo());
    let directory = SessionDirectory::new(rig.deps());
    let handle = start_thread(&directory).await;
    turn(&handle, "hello", "op-1").await;
    eventually_on!(&[&handle.cell.stepped], || (idle(&handle) && !handle.turn_busy()).then_some(())).await;
    let resume = |op: &str| request("thread/resume", json!({ "threadId": handle.id, "window": { "lastItems": 10 } }), op);
    let Reply::Subscribe(resumed) = handle.request(resume("op-resume-1")).await.expect("thread/resume") else { panic!("thread/resume subscribes") };
    let feed: Arc<dyn FeedSource> = resumed.feed;
    let client = mixdog_core_api::mock::MockConnection::new(ConnectionId(7), mixdog_core_api::mock::MockLimits::default());
    let sub = mixdog_core_api::ids::SubscriptionId::from("client");
    let attached = mixdog_core_api::feed::subscribe(&feed, sub.clone(), resumed.window, None, &client).expect("attach");
    client.send_control_release(bytes::Bytes::from_static(b"{}"), attached.release).expect("release");
    assert_eq!(handle.cell.attached(), 1, "the subscription is counted");

    tokio::time::advance(super::actor::IDLE_EVICT + Duration::from_secs(1)).await;
    caught_up(&handle).await;
    assert!(directory.handle(&handle.id).is_some(), "a watched thread is not evicted");

    subscribe(&handle);
    feed.detach(sub.clone());
    feed.detach(sub);
    assert_eq!(handle.cell.attached(), 1, "the second detach counted nothing");
    handle.cell.unsubscribed();
    caught_up(&handle).await;
    tokio::time::advance(super::actor::IDLE_EVICT - Duration::from_secs(1)).await;
    caught_up(&handle).await;
    assert!(directory.handle(&handle.id).is_some(), "retained for the idle delay");

    let Reply::Subscribe(_) = handle.request(resume("op-resume-2")).await.expect("thread/resume") else { panic!("thread/resume subscribes") };
    caught_up(&handle).await;
    tokio::time::advance(Duration::from_secs(2)).await;
    caught_up(&handle).await;
    assert!(directory.handle(&handle.id).is_some(), "the resume started the delay over");
    tokio::time::advance(super::actor::IDLE_EVICT).await;
    eventually_on!(&[&handle.cell.stepped, directory.left()], || directory.handle(&handle.id).is_none().then_some(())).await;
}

/// `sessionBusy` counts `commandBusy`: a compaction running when the idle deadline comes keeps the thread nobody watches
/// loaded and answers; its end starts the idle delay over (`onBusyChange`), and the thread unloads a whole delay later.
#[tokio::test(start_paused = true)]
async fn a_running_compaction_keeps_a_thread_nobody_watches_loaded() {
    let rig = Rig::new();
    let hold = Arc::new(tokio::sync::Notify::new());
    *lock(&rig.compaction.hold) = Some(hold.clone());
    let directory = SessionDirectory::new(rig.deps());
    let handle = start_thread(&directory).await;
    let compacting = {
        let handle = handle.clone();
        tokio::spawn(async move { handle.request(request("thread/compact/start", json!({ "threadId": handle.id, "opId": "op-compact" }), "op-compact")).await })
    };
    eventually_on!(&[&rig.compaction.called, &handle.cell.stepped], || (!lock(&rig.compaction.calls).is_empty()).then_some(())).await;
    caught_up(&handle).await;

    tokio::time::advance(super::actor::IDLE_EVICT + Duration::from_secs(1)).await;
    caught_up(&handle).await;
    assert!(directory.handle(&handle.id).is_some(), "a compacting thread is not evicted");
    // Half a delay later it still compacts: the deadline the busy thread armed again is nearer than a whole delay after its end.
    tokio::time::advance(super::actor::IDLE_EVICT / 2).await;
    caught_up(&handle).await;
    hold.notify_one();
    let answered = crate::session::testing::awaiting(|| "the compaction's answer".to_owned(), compacting).await;
    assert!(matches!(answered, Ok(Ok(Reply::Value(_)))), "the compaction answers: {answered:?}");
    tokio::time::advance(super::actor::IDLE_EVICT - Duration::from_secs(1)).await;
    caught_up(&handle).await;
    assert!(directory.handle(&handle.id).is_some(), "not before a whole delay after the compaction");
    tokio::time::advance(Duration::from_secs(2)).await;
    eventually_on!(&[&handle.cell.stepped, directory.left()], || directory.handle(&handle.id).is_none().then_some(())).await;
}

/// `idleEvictMs`: a quiet thread nobody watches (a worker, a headless run) unloads once it has been quiet for the idle
/// delay; one still working starts the delay over.
#[tokio::test(start_paused = true)]
async fn a_thread_nobody_watched_unloads_after_the_idle_delay() {
    let rig = Rig::new();
    let (release, gate) = tokio::sync::watch::channel(false);
    rig.set_script(Arc::new(move |run| {
        let mut gate = gate.clone();
        Box::pin(async move {
            run.port.input_durable().await.expect("input durable");
            let _ = gate.wait_for(|open| *open).await;
            RunOutcome::Completed(Default::default())
        })
    }));
    let directory = SessionDirectory::new(rig.deps());
    let handle = start_thread(&directory).await;
    turn(&handle, "hold", "op-1").await;

    // Working at the deadline: the whole delay starts again.
    tokio::time::advance(super::actor::IDLE_EVICT + Duration::from_secs(1)).await;
    caught_up(&handle).await;
    assert!(directory.handle(&handle.id).is_some(), "a running thread is never evicted");

    release.send(true).expect("release");
    eventually_on!(&[&handle.cell.stepped], || idle(&handle).then_some(())).await;
    tokio::time::advance(super::actor::IDLE_EVICT - Duration::from_secs(1)).await;
    caught_up(&handle).await;
    assert!(directory.handle(&handle.id).is_some(), "not before the delay");
    tokio::time::advance(Duration::from_secs(2)).await;
    eventually_on!(&[&handle.cell.stepped, directory.left()], || directory.handle(&handle.id).is_none().then_some(())).await;
}

/// What the process remembers of a thread's surface (`NewThreadTools::unloaded`) is let go each time the thread's slot
/// leaves the directory, whichever way it leaves: the idle unload, the idle sweep's tombstone, a delete. A thread that is
/// still loaded has let go of nothing.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn every_way_a_thread_leaves_the_directory_lets_go_of_its_surface_memory() {
    use mixdog_store::schema::record::Header;
    #[derive(Default)]
    struct Tools(Mutex<Vec<ThreadId>>);
    #[async_trait::async_trait]
    impl super::NewThreadTools for Tools {
        async fn seed(&self, _: &ThreadId, header: &Header) -> Result<Header, String> {
            Ok(header.clone())
        }
        fn unloaded(&self, thread: &ThreadId) {
            lock(&self.0).push(thread.clone());
        }
    }
    let data = tempfile::tempdir().expect("data dir");
    let store = real_store(data.path()).await;
    let rig = Rig::new();
    rig.set_script(echo());
    let tools = Arc::new(Tools::default());
    let mut deps = rig.deps_parts(store);
    deps.new_tools = tools.clone();
    let directory = SessionDirectory::new(Arc::new(deps));
    let let_go = |id: &ThreadId| lock(&tools.0).iter().filter(|left| *left == id).count();
    let live = CancellationToken::new();
    // A thread that ran a turn and then unloaded for want of a subscriber: its id and the activity a sweep reads of it.
    let unloaded = || async {
        let handle = start_thread(&directory).await;
        let id = handle.id.clone();
        turn(&handle, "hello", "op-1").await;
        eventually_on!(&[&handle.cell.stepped], || idle(&handle).then_some(())).await;
        let read = super::sub_agent_retention::activity_at(&directory.stored_header(&id).await.expect("header"));
        assert_eq!(let_go(&id), 0, "a loaded thread has let go of nothing");
        subscribe(&handle);
        left_idle(&handle).await;
        eventually_on!(&[&handle.cell.stepped, directory.left()], || directory.handle(&id).is_none().then_some(())).await;
        handle.inbox.closed().await;
        (id, read)
    };

    let (swept, read) = unloaded().await;
    assert_eq!(let_go(&swept), 1, "the idle unload");
    assert!(directory.close_stored(swept.as_str(), read, &live).await.expect("close"));
    assert_eq!(let_go(&swept), 2, "the sweep loaded it again and its tombstone took the slot");

    let (deleted, read) = unloaded().await;
    assert!(directory.delete_stored(deleted.as_str(), read, &[], &live).await.expect("delete"));
    assert_eq!(let_go(&deleted), 2, "the delete loaded it again and its mark took the slot");

    let kept = start_thread(&directory).await;
    assert_eq!(let_go(&kept.id), 0, "another thread, still loaded, keeps what it has");
}

/// Retention's delete (`deleteSession(id, { isSessionLive: treeChanged })`) asks again under the
/// thread's own admission, before it closes anything: a session opened or used after the pass
/// checked it, or a sweep that was shut down, is refused and stays.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_retention_delete_is_refused_when_the_session_changed_after_the_check() {
    let data = tempfile::tempdir().expect("data dir");
    let store = real_store(data.path()).await;
    let rig = Rig::new();
    rig.set_script(echo());
    let directory = SessionDirectory::new(rig.deps_on(store));
    let handle = start_thread(&directory).await;
    let id = handle.id.clone();
    turn(&handle, "hello", "op-1").await;
    eventually_on!(&[&handle.cell.stepped], || idle(&handle).then_some(())).await;
    let read = super::sub_agent_retention::activity_at(&directory.stored_header(&id).await.expect("header"));
    let live = CancellationToken::new();

    // Opened (attached) after the check.
    subscribe(&handle);
    assert!(!directory.delete_stored(id.as_str(), read, &[], &live).await.expect("delete"), "opened");
    assert!(directory.session_meta(&id).await.expect("meta").is_some(), "still listed");
    left_idle(&handle).await;
    eventually_on!(&[&handle.cell.stepped, directory.left()], || directory.handle(&id).is_none().then_some(())).await;
    handle.inbox.closed().await;

    // Used after the check: its activity is not what the pass read.
    assert!(!directory.delete_stored(id.as_str(), read - 1.0, &[], &live).await.expect("delete"), "moved");
    assert!(directory.session_meta(&id).await.expect("meta").is_some(), "still listed");

    // The sweep was shut down: no new mutation.
    let down = CancellationToken::new();
    down.cancel();
    assert!(!directory.delete_stored(id.as_str(), read, &[], &down).await.expect("delete"), "shut down");
    assert!(directory.session_meta(&id).await.expect("meta").is_some(), "still listed");

    // Unchanged and not shut down: gone.
    assert!(directory.delete_stored(id.as_str(), read, &[], &live).await.expect("delete"));
    assert!(directory.session_meta(&id).await.expect("meta").is_none(), "deleted");
}

/// The idle sweep's close (`markSessionClosed(id, 'idle-sweep')`) is admitted as the delete is:
/// refused when the session moved after the pass read it or the sweep was shut down, otherwise
/// the record is tombstoned (closed, `closedReason: idle-sweep`) and stays listed.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn an_idle_close_is_guarded_and_leaves_a_tombstone() {
    let data = tempfile::tempdir().expect("data dir");
    let store = real_store(data.path()).await;
    let rig = Rig::new();
    rig.set_script(echo());
    let directory = SessionDirectory::new(rig.deps_on(store));
    let handle = start_thread(&directory).await;
    let id = handle.id.clone();
    turn(&handle, "hello", "op-1").await;
    eventually_on!(&[&handle.cell.stepped], || idle(&handle).then_some(())).await;
    let read = super::sub_agent_retention::activity_at(&directory.stored_header(&id).await.expect("header"));
    let live = CancellationToken::new();
    subscribe(&handle);
    left_idle(&handle).await;
    eventually_on!(&[&handle.cell.stepped, directory.left()], || directory.handle(&id).is_none().then_some(())).await;
    handle.inbox.closed().await;

    assert!(!directory.close_stored(id.as_str(), read - 1.0, &live).await.expect("close"), "moved");
    let down = CancellationToken::new();
    down.cancel();
    assert!(!directory.close_stored(id.as_str(), read, &down).await.expect("close"), "shut down");
    let open = directory.stored_header(&id).await.expect("header");
    assert_ne!(open.get("closed"), Some(&serde_json::json!(true)), "refusals change nothing");

    assert!(directory.close_stored(id.as_str(), read, &live).await.expect("close"));
    let closed = directory.stored_header(&id).await.expect("header");
    assert_eq!(
        (closed.get("closed"), closed.get("status"), closed.get("closedReason")),
        (Some(&serde_json::json!(true)), Some(&serde_json::json!("closed")), Some(&serde_json::json!("idle-sweep")))
    );
    assert!(directory.session_meta(&id).await.expect("meta").is_some(), "a tombstone stays listed");
}

/// `treeChanged` is the whole tree's: a member other than the target that is open (opened after
/// the pass read the tree) refuses the delete under the target's admission; once it is gone the
/// delete goes through.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_retention_delete_is_refused_when_another_member_of_the_tree_is_open() {
    let data = tempfile::tempdir().expect("data dir");
    let store = real_store(data.path()).await;
    let rig = Rig::new();
    rig.set_script(echo());
    let directory = SessionDirectory::new(rig.deps_on(store));
    let target = start_thread(&directory).await;
    let id = target.id.clone();
    turn(&target, "hello", "op-1").await;
    eventually_on!(&[&target.cell.stepped], || idle(&target).then_some(())).await;
    let read = super::sub_agent_retention::activity_at(&directory.stored_header(&id).await.expect("header"));
    let peer = start_thread(&directory).await;
    let peer_id = peer.id.clone();
    let live = CancellationToken::new();
    async fn unload(directory: &SessionDirectory, handle: Arc<SessionHandle>) {
        subscribe(&handle);
        left_idle(&handle).await;
        eventually_on!(&[&handle.cell.stepped, directory.left()], || directory.handle(&handle.id).is_none().then_some(())).await;
        // Out of the directory is not stopped: the actor still hands off what it accepted. Its inbox
        // closes when it ends, and only then is the stored header final.
        handle.inbox.closed().await;
    }
    turn(&peer, "hello", "op-p1").await;
    eventually_on!(&[&peer.cell.stepped], || idle(&peer).then_some(())).await;
    let seen = |peer_at: f64| [(peer_id.as_str().to_owned(), peer_at)];

    // The member is open now (whatever the pass read).
    assert!(!directory.delete_stored(id.as_str(), read, &seen(0.0), &live).await.expect("delete"), "a member is open");
    assert!(directory.session_meta(&id).await.expect("meta").is_some(), "still listed");
    assert!(!target.cell.closed.load(std::sync::atomic::Ordering::SeqCst), "nothing was closed");

    // The member is stored again, as the pass read it: the delete goes ahead.
    unload(&directory, peer).await;
    let sweep_read = super::sub_agent_retention::activity_at(&directory.stored_header(&peer_id).await.expect("header"));

    // It was opened, used and unloaded between the pass and the delete: its stored activity is
    // not what the pass read, so the delete is refused though nothing of it is open.
    rig.clock.0.store(5000, std::sync::atomic::Ordering::SeqCst);
    let reopened = directory.open_handle(&peer_id, &connection()).await.expect("reopen");
    turn(&reopened, "again", "op-p2").await;
    eventually_on!(&[&reopened.cell.stepped], || idle(&reopened).then_some(())).await;
    unload(&directory, reopened).await;
    let now = super::sub_agent_retention::activity_at(&directory.stored_header(&peer_id).await.expect("header"));
    assert_ne!(now, sweep_read, "the member's activity moved");
    assert!(!directory.delete_stored(id.as_str(), read, &seen(sweep_read), &live).await.expect("delete"), "a member moved");
    assert!(directory.session_meta(&id).await.expect("meta").is_some(), "still listed");
    assert!(!target.cell.closed.load(std::sync::atomic::Ordering::SeqCst), "nothing was closed");

    // Read afresh, nothing open: deleted.
    assert!(directory.delete_stored(id.as_str(), read, &seen(now), &live).await.expect("delete"), "no member changed");
}

#[tokio::test(start_paused = true)]
async fn a_headless_session_keeps_its_options_and_ingests_no_memory_when_it_closes() {
    let rig = Rig::new();
    rig.set_script(echo());
    let directory = SessionDirectory::new(rig.deps());
    let reply = directory
        .request(request(
            "thread/start",
            json!({
                "opId": "op-start", "kind": "task", "projectPath": "/ws",
                "session": { "toolProfile": "headless", "approvalMode": "implicit", "memory": false },
            }),
            "op-start",
        ))
        .await
        .expect("thread/start");
    let Reply::Subscribe(started) = reply else { panic!("thread/start subscribes") };
    let id = ThreadId::from(started.result["thread"]["id"].as_str().expect("thread id"));
    let handle = directory.handle(&id).expect("loaded");
    let header = handle.cell.header.load_full();
    assert_eq!(header["approvalMode"], "implicit");
    assert_eq!(header["sourceType"], "exec");

    turn(&handle, "hello", "op-1").await;
    eventually_on!(&[&handle.cell.stepped], || idle(&handle).then_some(())).await;
    subscribe(&handle);
    left_idle(&handle).await;
    eventually_on!(&[&handle.cell.stepped, directory.left()], || directory.handle(&handle.id).is_none().then_some(())).await;
    // The decision is made where the session unloads, before anything is spawned.
    assert!(lock(&rig.closes.seen).is_empty(), "memory is off for this session");
}

/// A run outlives the client that walked away (`releaseClient`): the thread stays loaded while it runs, and its end starts the
/// idle delay over.
#[tokio::test(start_paused = true)]
async fn a_live_run_keeps_the_thread_loaded_until_it_ends() {
    let rig = Rig::new();
    let (release, gate) = tokio::sync::watch::channel(false);
    rig.set_script(Arc::new(move |run| {
        let mut gate = gate.clone();
        Box::pin(async move {
            run.port.input_durable().await.expect("input durable");
            let _ = gate.wait_for(|open| *open).await;
            RunOutcome::Completed(Default::default())
        })
    }));
    let directory = SessionDirectory::new(rig.deps());
    let handle = start_thread(&directory).await;
    subscribe(&handle);
    turn(&handle, "hold", "op-1").await;
    handle.cell.unsubscribed();
    caught_up(&handle).await;
    tokio::time::advance(super::actor::IDLE_EVICT + Duration::from_secs(1)).await;
    caught_up(&handle).await;
    assert!(directory.handle(&handle.id).is_some(), "the run is live");
    // Half a delay later it still runs: the deadline the busy thread armed again is nearer than a whole delay after its end.
    tokio::time::advance(super::actor::IDLE_EVICT / 2).await;
    caught_up(&handle).await;

    release.send(true).expect("release");
    eventually_on!(&[&handle.cell.stepped], || (idle(&handle) && !handle.turn_busy()).then_some(())).await;
    tokio::time::advance(super::actor::IDLE_EVICT - Duration::from_secs(1)).await;
    caught_up(&handle).await;
    assert!(directory.handle(&handle.id).is_some(), "not before the delay after the run");
    tokio::time::advance(Duration::from_secs(2)).await;
    eventually_on!(&[&handle.cell.stepped, directory.left()], || directory.handle(&handle.id).is_none().then_some(())).await;
}

/// The last view's leave reaches the actor although its control lane is full: the thread goes back on the idle clock and
/// unloads a delay later, never left loaded with nobody watching.
#[tokio::test(start_paused = true)]
async fn the_last_detach_on_a_full_control_lane_still_retains_the_thread() {
    let rig = Rig::new();
    let directory = SessionDirectory::new(rig.deps());
    let handle = start_thread(&directory).await;
    subscribe(&handle);
    // The deadline armed at the open finds the thread watched: it is off the idle clock.
    tokio::time::advance(super::actor::IDLE_EVICT + Duration::from_secs(1)).await;
    caught_up(&handle).await;
    assert!(directory.handle(&handle.id).is_some(), "a watched thread is not evicted");

    // No await between the fill and the leave: the actor drains nothing before it.
    while handle.cell.ctl_tx.try_send(crate::session::control::Ctl::RefreshSurface).is_ok() {}
    handle.cell.unsubscribed();
    // The leave waits for room behind the fill, and the actor takes it before the clock moves.
    caught_up(&handle).await;
    caught_up(&handle).await;
    tokio::time::advance(super::actor::IDLE_EVICT + Duration::from_secs(1)).await;
    eventually_on!(&[&handle.cell.stepped, directory.left()], || directory.handle(&handle.id).is_none().then_some(())).await;
}

/// The memory ingest of an unloading thread (`ingestSessionIntoMemory`) goes to a database on disk: a value the thread
/// marked sensitive goes there as the marker, though the model context holds it whole (Node bug, fixed on both sides:
/// `memory-ingest.mjs` passes the loaded session's messages as they are).
#[tokio::test(start_paused = true)]
async fn an_unloading_thread_goes_to_memory_with_its_sensitive_values_as_the_marker() {
    const CODE: &str = "482913";
    let rig = Rig::new();
    let fill = json!({ "id": "c1", "name": "browser", "arguments": { "action": "fill", "input": { "sensitive": true, "text": CODE } } });
    let body = json!({ "role": "assistant", "content": "", "toolCalls": [fill.clone()] });
    rig.set_script(Arc::new(move |run| {
        let (body, fill) = (body.clone(), fill.clone());
        Box::pin(async move {
            run.port.input_durable().await.expect("input durable");
            run.context.remember_sensitive(&[fill]);
            let row = ItemCommit { iid: ItemId::from("a-1"), role: Some("assistant".into()), model: true, visible: true, body, prompt: None };
            run.port.commit_item(row).await.expect("assistant row");
            RunOutcome::Completed(Default::default())
        })
    }));
    let directory = SessionDirectory::new(rig.deps());
    let handle = start_thread(&directory).await;
    turn(&handle, &format!("the code is {CODE}"), "op-1").await;
    eventually_on!(&[&handle.cell.stepped], || idle(&handle).then_some(())).await;
    subscribe(&handle);
    left_idle(&handle).await;
    eventually_on!(&[&*rig.closes.ended], || (lock(&rig.closes.seen).len() == 1).then_some(())).await;
    let ingested = serde_json::to_string(&lock(&rig.closes.seen)[0].1).expect("messages json");
    assert!(!ingested.contains(CODE), "the memory ingest holds the value: {ingested}");
    assert!(ingested.contains("[redacted]"), "{ingested}");
}

/// A turn that ends while a retry waits (done, failed, cancelled) removes the spinner, and a stage the run raises afterwards does not
/// bring it back.
#[tokio::test(start_paused = true)]
async fn a_turn_that_ends_during_the_wait_removes_the_spinner_and_a_late_stage_does_not_return_it() {
    for ending in ["done", "failed", "interrupted"] {
        let rig = Rig::new();
        let run = stage_turn(&rig, &["reconnecting", "hold"], ending).await;
        spinner_where(&rig, &run, "reconnecting", |spinner| spinner["mode"] == "reconnecting").await;
        if ending == "interrupted" {
            run.handle.interrupt(&run.turn_id, None).expect("interrupt");
        } else {
            run.gate.notify_one();
        }
        spinner_gone(&rig, &run).await;
        run.late.notify_one();
        caught_up(&run.handle).await;
        caught_up(&run.handle).await;
        assert!(spinner_of(&run.handle).is_none(), "{ending}: a late stage brought the spinner back");
    }
}

/// What a gate decision or a todo guard reads of a session is a few members of its header, taken without the rest (its
/// prompt and tool catalog): they are the header's own, and an unknown session has none, as it has no header.
#[tokio::test(start_paused = true)]
async fn the_picked_members_of_a_header_are_the_headers_own() {
    const FIELDS: &[&str] = &["createdAt", "updatedAt", "cwd", "noSuchMember"];
    let rig = Rig::new();
    let directory = SessionDirectory::new(rig.deps());
    let thread = start_thread(&directory).await.id.clone();
    let whole = directory.stored_header(&thread).await.expect("held");
    let expected: mixdog_store::schema::record::Header =
        whole.iter().filter(|(key, _)| FIELDS.contains(&key.as_str())).map(|(key, value)| (key.clone(), value.clone())).collect();
    assert!(!expected.is_empty() && expected.len() < whole.len(), "{expected:?} of {} members", whole.len());
    assert_eq!(directory.stored_fields(&thread, FIELDS).await, Some(expected.clone()));
    assert_eq!(directory.loaded_fields(&thread, FIELDS), Some(expected));
    assert_eq!(directory.stored_fields(&thread, &[]).await, Some(Default::default()), "a session that is there, asked for nothing");
    let unknown = ThreadId::from("sess_no_such_session");
    assert!(directory.stored_header(&unknown).await.is_none());
    assert!(directory.stored_fields(&unknown, FIELDS).await.is_none());
    assert!(directory.loaded_fields(&unknown, FIELDS).is_none());
}
