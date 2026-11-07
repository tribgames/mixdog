//! `review/diff/get` of a turn or a session: which of Node's five reads each parameter set picks, with what arguments,
//! and that the read's reply is the op's reply as it is (`getTurnReviewDiff`, `getTurnReviewFilePatch`, `getTurnChanges`,
//! `getSessionReviewDiff`, `getSessionReviewFilePatch`). The replies themselves are the turn review's own tests'.

use std::sync::Arc;
use std::sync::Mutex;

use async_trait::async_trait;
use mixdog_core_api::CoreError;
use mixdog_core_api::CoreRequest;
use mixdog_core_api::DomainService;
use mixdog_core_api::Reply;
use mixdog_core_api::call::CallContext;
use mixdog_core_api::ids::ConnectionId;
use mixdog_core_api::ids::Method;
use mixdog_core_api::mock::MockLimits;
use mixdog_core_api::mock::MockScopedFeeds;
use mixdog_core_api::mock::MockStatePublisher;
use mixdog_core_api::turn_review as tr;
use mixdog_protocol::ThreadId;
use serde_json::Value;
use serde_json::json;

use crate::engine::Scm;
use crate::service::FeatureGate;
use crate::service::ScmHandle;
use crate::service::ScmService;
use crate::service::ThreadWorktrees;
use crate::testing::TestProcesses;

type Log = Arc<Mutex<Vec<Value>>>;

/// A review that answers `{ "read": name, ... }` and logs what it was asked.
struct Reviews(Log);

impl Reviews {
    fn answer(&self, call: Value) -> tr::Reply {
        self.0.lock().unwrap().push(call.clone());
        let mut reply = tr::Reply::new();
        reply.insert("read".into(), call);
        reply
    }
}

#[async_trait]
impl tr::TurnReviewApi for Reviews {
    async fn record_call(&self, _: &str, _: &str, _: &str, _: Vec<tr::CallChange>) {}
    async fn record_tool_changes(&self, _: &str, _: &str, _: Vec<tr::CallChange>) {}
    fn take_call_diff(&self, _: &str) -> Option<String> {
        None
    }
    fn note_change(&self, _: Option<&[String]>) {}
    async fn begin_turn(&self, _: &str, _: &str, _: tr::TurnOpen) -> Option<tr::TurnToken> {
        None
    }
    async fn complete_turn(&self, _: &str, _: Option<&tr::TurnToken>) -> bool {
        false
    }
    fn begin_agent_review(&self, _: &str, _: &str, _: &str, _: &str) -> Option<Box<dyn tr::AgentReview>> {
        None
    }
    fn forget_session(&self, _: &str) {}
    async fn turn_review_diff(&self, worktree: &str, session: &str, read: tr::ReviewRead) -> tr::Reply {
        self.answer(json!(["turnReviewDiff", worktree, session, read.known, read.summary]))
    }
    async fn turn_review_file_patch(&self, worktree: &str, session: &str, file: &str) -> tr::Reply {
        self.answer(json!(["turnReviewFilePatch", worktree, session, file]))
    }
    async fn session_review_diff(&self, worktree: &str, session: &str) -> tr::Reply {
        self.answer(json!(["sessionReviewDiff", worktree, session]))
    }
    async fn session_review_file_patch(&self, worktree: &str, session: &str, file: &str, old_path: &str) -> tr::Reply {
        self.answer(json!(["sessionReviewFilePatch", worktree, session, file, old_path]))
    }
    async fn revert_turn_review(&self, _: &str, _: &str, _: &str) -> Result<tr::Reply, tr::ReviewError> {
        Err(tr::ReviewError::new("not read"))
    }
    async fn revert_turn_review_file(&self, _: &str, _: &str, _: &str, _: &str) -> Result<tr::Reply, tr::ReviewError> {
        Err(tr::ReviewError::new("not read"))
    }
    async fn turn_changes(&self, session: &str, read: tr::ChangesRead) -> Result<tr::Reply, tr::ReviewError> {
        if read.checkpoint_id == "gone" {
            return Err(tr::ReviewError::type_error("checkpointId is required"));
        }
        Ok(self.answer(json!(["turnChanges", session, read.checkpoint_id, read.patch, read.file])))
    }
    async fn revert_turn_changes(&self, _: &str, _: &str, _: Option<&str>, _: f64) -> Result<tr::Reply, tr::ReviewError> {
        Err(tr::ReviewError::new("not read"))
    }
    async fn reapply_turn_changes(&self, _: &str, _: &str, _: Option<&str>, _: f64) -> Result<tr::Reply, tr::ReviewError> {
        Err(tr::ReviewError::new("not read"))
    }
    async fn clear_change_history(&self, _: &str) -> Result<tr::Reply, tr::ReviewError> {
        Err(tr::ReviewError::new("not read"))
    }
}

struct Open;

#[async_trait]
impl FeatureGate for Open {
    async fn github_enabled(&self) -> bool {
        true
    }
}

/// `t1` runs in `/work/t1`; any other thread has no header.
struct Cwds;

#[async_trait]
impl ThreadWorktrees for Cwds {
    async fn cwd(&self, thread: &ThreadId) -> Result<Option<String>, CoreError> {
        Ok((thread.as_str() == "t1").then(|| "/work/t1".to_owned()))
    }
}

fn service(log: Log) -> ScmHandle {
    let scm = Scm::new(TestProcesses::shared(), mixdog_rt::testing::tokens().maintenance_io, std::env::temp_dir().join(format!("mixdog-scm-review-{}", std::process::id())));
    ScmHandle(ScmService::new(
        scm,
        Arc::new(MockScopedFeeds::new(MockLimits::default())),
        Arc::new(MockStatePublisher::default()),
        Arc::new(Open),
        Arc::new(Reviews(log)),
        Arc::new(Cwds),
    ))
}

async fn get(handle: &ScmHandle, params: Value) -> Result<Value, CoreError> {
    let ctx = CallContext::connection(ConnectionId(1), mixdog_protocol::Origin::Local, Default::default());
    match handle.call(CoreRequest { method: Method("review/diff/get"), params, op: None, ctx }).await? {
        Reply::Value(value) => Ok(value),
        _ => panic!("a review answers a value"),
    }
}

#[tokio::test]
async fn each_parameter_set_picks_the_read_node_runs() {
    let log = Log::default();
    let handle = service(log.clone());
    let cases = [
        // getTurnReviewDiff({ summary: true, known })
        (json!({ "scope": "turn", "threadId": "t1", "summary": true, "known": "abc" }), json!(["turnReviewDiff", "", "t1", "abc", true])),
        (json!({ "scope": "turn", "threadId": "t1" }), json!(["turnReviewDiff", "", "t1", null, false])),
        // getTurnReviewFilePatch(file)
        (json!({ "scope": "turn", "threadId": "t1", "path": "src/a.rs" }), json!(["turnReviewFilePatch", "", "t1", "src/a.rs"])),
        // getTurnChanges({ checkpointId, patch, file })
        (json!({ "scope": "turn", "threadId": "t1", "checkpointId": "cp1" }), json!(["turnChanges", "t1", "cp1", false, null])),
        (json!({ "scope": "turn", "threadId": "t1", "checkpointId": "cp1", "patch": true, "path": "b.rs" }), json!(["turnChanges", "t1", "cp1", true, "b.rs"])),
        // getSessionReviewDiff() and getSessionReviewFilePatch(file, oldPath)
        (json!({ "scope": "session", "threadId": "t1" }), json!(["sessionReviewDiff", "/work/t1", "t1"])),
        (json!({ "scope": "session", "threadId": "t1", "path": "n.rs", "oldPath": "o.rs" }), json!(["sessionReviewFilePatch", "/work/t1", "t1", "n.rs", "o.rs"])),
        (json!({ "scope": "session", "threadId": "t1", "path": "n.rs" }), json!(["sessionReviewFilePatch", "/work/t1", "t1", "n.rs", ""])),
    ];
    for (params, expected) in cases {
        assert_eq!(get(&handle, params.clone()).await.unwrap(), json!({ "read": expected }), "{params}");
    }
    assert_eq!(log.lock().unwrap().len(), 8, "one read each");
}

#[tokio::test]
async fn a_review_failure_keeps_the_message_node_threw() {
    let handle = service(Log::default());
    let error = get(&handle, json!({ "scope": "turn", "threadId": "t1", "checkpointId": "gone" })).await.unwrap_err();
    assert_eq!(
        error,
        CoreError::DomainError { domain: "turnReview".into(), code: None, message: Some("checkpointId is required".into()), detail: None }
    );
}

#[tokio::test]
async fn a_thread_review_needs_its_thread_and_a_session_review_its_directory() {
    let handle = service(Log::default());
    for params in [json!({ "scope": "turn" }), json!({ "scope": "session" })] {
        assert!(matches!(get(&handle, params).await, Err(CoreError::InvalidParams { path, .. }) if &*path == "threadId"));
    }
    assert!(matches!(
        get(&handle, json!({ "scope": "session", "threadId": "t2" })).await,
        Err(CoreError::InvalidParams { path, .. }) if &*path == "threadId"
    ));
}
