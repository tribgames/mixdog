//! The Goal and todo reminder of a pre-send compaction: the kept latest request carries the session's open todo list, the
//! savings preview prices it without touching the session, and the session's pending reminder is cleared once the pass
//! was adopted, failed or cancelled and kept when the pass was skipped or changed nothing. A real session thread runs the
//! turn; the compactor under the wrapper is scripted.

use std::sync::Arc;
use std::sync::Mutex;

use async_trait::async_trait;
use mixdog_agent::env::CompactError;
use mixdog_agent::env::CompactOutput;
use mixdog_agent::env::CompactRequest;
use mixdog_agent::env::CompactTrigger;
use mixdog_agent::env::Compactor;
use mixdog_agent::message::AgentMessage;
use mixdog_core_api::CoreRequest;
use mixdog_core_api::Reply;
use mixdog_core_api::ThreadHandle;
use mixdog_core_api::call::CallContext;
use mixdog_core_api::ids::Method;
use mixdog_core_api::ids::OpId;
use mixdog_core_api::ids::ThreadId;
use mixdog_core_ports::ports::threads::ThreadState;
use mixdog_core_session::session::RunOutcome;
use mixdog_core_session::session::RunStart;
use mixdog_core_session::session::SessionDirectory;
use mixdog_core_session::session::testing::Rig;
use mixdog_core_session::session::thread_state::SessionThreads;
use serde_json::Value;
use serde_json::json;

use super::goal_reminder_compactor::GoalReminderCompactor;
use super::message_row::message_of;

/// What the scripted pass under the wrapper does.
#[derive(Clone, Copy)]
enum Pass {
    /// Adopts a shorter transcript.
    Shrinks,
    /// Finds no reduction: nothing is adopted.
    Skipped,
    /// Returns the transcript as it was.
    Unchanged,
    Fails,
}

struct Inner {
    pass: Pass,
    /// The `latest_user_prefix` of every request it was given: `(preview, prefix)`.
    prefixes: Arc<Mutex<Vec<(bool, String)>>>,
}

fn output(messages: Vec<AgentMessage>, skipped: bool) -> CompactOutput {
    CompactOutput {
        messages,
        usage: None,
        input_excludes_cache: false,
        dropped_count: 0,
        dropped: None,
        skipped,
        pipeline_ms: 0.0,
        summary_ms: None,
        summary_route: None,
    }
}

#[async_trait]
impl Compactor for Inner {
    fn estimate_tokens(&self, _: &[AgentMessage]) -> u64 {
        1
    }

    async fn reduces(&self, request: &CompactRequest<'_>) -> bool {
        self.prefixes.lock().unwrap().push((true, request.latest_user_prefix.to_owned()));
        true
    }

    async fn compact(&self, request: CompactRequest<'_>) -> Result<CompactOutput, CompactError> {
        self.prefixes.lock().unwrap().push((false, request.latest_user_prefix.to_owned()));
        match self.pass {
            Pass::Shrinks => Ok(output(request.messages[1..].to_vec(), false)),
            Pass::Skipped => Ok(output(request.messages[1..].to_vec(), true)),
            Pass::Unchanged => Ok(output(request.messages.to_vec(), false)),
            Pass::Fails => Err(CompactError::Failed("the summary failed".into())),
        }
    }
}

struct Observed {
    prefixes: Vec<(bool, String)>,
    /// The session's pending reminder after the pass, and after the preview alone.
    pending_after_preview: Value,
    pending_after_pass: Value,
}

fn header() -> serde_json::Map<String, Value> {
    json!({ "todo": { "phases": [{ "name": "Work", "tasks": [{ "content": "finish the report", "status": "pending" }] }] } }).as_object().unwrap().clone()
}

async fn pending(directory: &Arc<SessionDirectory>, id: &ThreadId) -> Value {
    SessionThreads::new(directory.clone()).header(id).await.expect("the header").get("pendingGoalReminder").cloned().unwrap_or(Value::Null)
}

/// A turn whose run asks the wrapped compactor for its preview and then its pass.
async fn observe(pass: Pass) -> Observed {
    let id = ThreadId::from("sess_goal_reminder");
    let rig = Rig::new();
    let deps = rig.deps_parts(rig.store.clone());
    let prefixes: Arc<Mutex<Vec<(bool, String)>>> = Arc::default();
    let (done_tx, done_rx) = tokio::sync::oneshot::channel::<()>();
    let (release_tx, release_rx) = tokio::sync::oneshot::channel::<()>();
    let hooks = Arc::new(Mutex::new(Some((done_tx, release_rx))));
    let directory_slot: Arc<Mutex<Option<Arc<SessionDirectory>>>> = Arc::default();
    let (seen, slot) = (prefixes.clone(), directory_slot.clone());
    let (pending_slot, thread) = (Arc::new(Mutex::new(Vec::<Value>::new())), id.clone());
    let during = pending_slot.clone();
    rig.set_script(Arc::new(move |run: RunStart| {
        let (done_tx, release_rx) = hooks.lock().unwrap().take().expect("one turn");
        let (seen, slot, during, thread) = (seen.clone(), slot.clone(), during.clone(), thread.clone());
        Box::pin(async move {
            let compactor = GoalReminderCompactor::new(Arc::new(Inner { pass, prefixes: seen }), run.port.clone());
            let messages: Vec<AgentMessage> =
                ["first", "second"].iter().map(|text| message_of(&json!({ "role": "user", "content": text })).expect("a stored row")).collect();
            let request = || CompactRequest {
                messages: &messages,
                budget_tokens: 1000,
                trigger: CompactTrigger::Auto,
                require_reduction: true,
                reference_latest_attachments: false,
                active_turn: true,
                latest_user_prefix: "",
            };
            compactor.reduces(&request()).await;
            // A header write made now is stored after the preview's reads: the preview changed nothing.
            run.port.save_header(mixdog_store::schema::record::HeaderChange { set: serde_json::Map::new(), unset: Vec::new() }).await.expect("barrier");
            let directory = slot.lock().unwrap().clone().expect("the directory");
            let after_preview = pending(&directory, &thread).await;
            during.lock().unwrap().push(after_preview);
            let _ = compactor.compact(request()).await;
            run.port.save_header(mixdog_store::schema::record::HeaderChange { set: serde_json::Map::new(), unset: Vec::new() }).await.expect("barrier");
            let _ = done_tx.send(());
            let _ = release_rx.await;
            RunOutcome::Completed(Default::default())
        })
    }));
    let directory = Arc::new(SessionDirectory::new(Arc::new(deps)));
    *directory_slot.lock().unwrap() = Some(directory.clone());
    directory.create_with_id(id.clone(), header(), json!({})).await.expect("the session");
    let handle = directory.open_handle(&id, &CallContext::internal("test")).await.expect("open");
    let started = handle
        .request(CoreRequest {
            method: Method("turn/start"),
            params: json!({ "threadId": id, "opId": "op-1", "input": { "prompt": "Continue." } }),
            op: Some(OpId::from("op-1")),
            ctx: CallContext::internal("test"),
        })
        .await
        .expect("turn/start");
    assert!(matches!(started, Reply::Value(_)), "the turn starts");
    done_rx.await.expect("the run's pass");
    let after = pending(&directory, &id).await;
    let _ = release_tx.send(());
    let before = pending_slot.lock().unwrap().first().cloned().unwrap_or(Value::Null);
    let prefixes = prefixes.lock().unwrap().clone();
    Observed { prefixes, pending_after_preview: before, pending_after_pass: after }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn the_kept_request_carries_the_open_todo_list_and_the_preview_prices_it_without_marking_the_session() {
    let seen = observe(Pass::Shrinks).await;
    assert_eq!(seen.prefixes.len(), 2, "the preview, then the pass");
    for (preview, prefix) in &seen.prefixes {
        assert!(prefix.starts_with("<system-reminder>\n<todo_state>\nContext was compacted; your todo list:"), "preview={preview}: {prefix}");
        assert!(prefix.contains("finish the report"), "{prefix}");
    }
    assert_eq!(seen.prefixes[0].1, seen.prefixes[1].1, "the preview prices the text the pass carries");
    assert_eq!(seen.pending_after_preview, Value::Null, "a preview marks nothing");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn an_adopted_or_failed_pass_clears_the_pending_reminder() {
    for pass in [Pass::Shrinks, Pass::Fails] {
        let seen = observe(pass).await;
        assert_eq!(seen.pending_after_pass, Value::Null);
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_skipped_or_unchanged_pass_leaves_the_reminder_pending_for_the_next_request() {
    for pass in [Pass::Skipped, Pass::Unchanged] {
        let seen = observe(pass).await;
        assert_eq!(seen.pending_after_pass["reason"], "compaction");
        assert_eq!(seen.pending_after_pass["revision"], 1);
    }
}
