//! The thread route methods: `thread/continueInModel` over the Node-recorded route service
//! cases (`route-service-twin.json`), and `thread/quotaResume/schedule` / `cancel` over the
//! quota-resume store, with the transcript facts a recording session supplies. The app-server's
//! routing of these methods to this service is tested in its `dispatch` tests.

use std::sync::Arc;
use std::sync::Mutex;
use std::sync::atomic::{AtomicU32, Ordering};

use async_trait::async_trait;
use mixdog_core_api::error::CoreError;
use mixdog_core_api::ids::ThreadId;
use mixdog_core_api::service::DomainService;
use mixdog_rt::CancellationToken;
use serde_json::{Number, Value, json};

use super::route_service_tests::rig;
use super::thread_route_service::{QuotaFacts, QuotaFailure, QuotaResumeSessions, ThreadRouteService};
use crate::domains::support::testing::{request, scopes, value, with_op};
use crate::quota_resume::QuotaResumeStore;

fn twin() -> Value {
    serde_json::from_str(include_str!("../../../../../fixtures/ai-admin/route-service-twin.json")).unwrap()
}

struct Sessions {
    facts: Mutex<QuotaFacts>,
    cancelled: AtomicU32,
}

#[async_trait]
impl QuotaResumeSessions for Sessions {
    async fn facts(&self, _: &ThreadId) -> Result<QuotaFacts, CoreError> {
        Ok(self.facts.lock().unwrap().clone())
    }

    async fn cancelled(&self, _: &ThreadId) -> Result<(), CoreError> {
        self.cancelled.fetch_add(1, Ordering::SeqCst);
        Ok(())
    }
}

fn failure(reset_at: Option<u64>) -> QuotaFailure {
    QuotaFailure { turn_key: "turn:abc".into(), provider: "openai".into(), model: "gpt-5".into(), reset_at: reset_at.map(Number::from) }
}

fn facts(failure: Option<QuotaFailure>, resumable: bool) -> QuotaFacts {
    QuotaFacts { failure, resumable, route_provider: "anthropic".into(), route_model: "claude-x".into() }
}

fn message(error: CoreError) -> String {
    match error {
        CoreError::DomainError { code: None, message: Some(message), .. } => message.to_string(),
        other => panic!("{other:?}"),
    }
}

/// The service over the route-service rig of `case` and a fresh quota store.
async fn build(case: &Value, quota_facts: QuotaFacts) -> (ThreadRouteService, Arc<Sessions>, tempfile::TempDir, tempfile::TempDir) {
    let (routes, _writer, _log, dir) = rig(case).await;
    let state = tempfile::tempdir().unwrap();
    let store = QuotaResumeStore::open(state.path(), mixdog_rt::testing::tokens().durability_io, CancellationToken::new()).await.unwrap();
    let sessions = Arc::new(Sessions { facts: Mutex::new(quota_facts), cancelled: AtomicU32::new(0) });
    let ops = scopes(state.path(), "route").await;
    let service = ThreadRouteService { routes: Arc::new(routes), quota: Arc::new(store), sessions: sessions.clone(), ops };
    (service, sessions, dir, state)
}

fn continue_case(want_error: bool) -> Value {
    twin()["cases"]
        .as_array()
        .unwrap()
        .iter()
        // The wire's route names a provider and a model (`ModelSelection`).
        .find(|c| {
            c["kind"] == "continue"
                && c["continueSessionId"] == "t"
                && c["request"]["provider"].is_string()
                && c["request"]["model"].is_string()
                && c.get("error").is_some() == want_error
        })
        .unwrap()
        .clone()
}

#[tokio::test]
async fn continue_in_model_answers_what_the_route_service_answers() {
    let ok = continue_case(false);
    let (service, _, _dir, _state) = build(&ok, facts(None, false)).await;
    let params = with_op(json!({ "threadId": "t", "route": ok["request"] }), 1);
    let first = value(&service, request("thread/continueInModel", params.clone(), Some(1))).await.unwrap();
    assert_eq!(first, ok["value"]);
    // The same op again answers the recorded outcome and leaves the route as the first one did.
    let second = value(&service, request("thread/continueInModel", params, Some(1))).await.unwrap();
    assert_eq!(second, first);

    let bad = continue_case(true);
    let (service, _, _dir, _state) = build(&bad, facts(None, false)).await;
    let params = with_op(json!({ "threadId": "t", "route": bad["request"] }), 2);
    let error = value(&service, request("thread/continueInModel", params, Some(2))).await.unwrap_err();
    assert_eq!(message(error), bad["error"].as_str().unwrap());
}

#[tokio::test]
async fn a_mutation_without_an_op_id_is_refused() {
    let ok = continue_case(false);
    let (service, ..) = build(&ok, facts(None, false)).await;
    let error = value(&service, request("thread/quotaResume/cancel", json!({ "threadId": "t" }), None)).await.unwrap_err();
    assert!(matches!(error, CoreError::OpIdRequired), "{error:?}");
}

#[tokio::test]
async fn schedule_queues_the_latest_quota_failure_under_the_sessions_route() {
    let ok = continue_case(false);
    let (service, sessions, _dir, _state) = build(&ok, facts(Some(failure(Some(1_750_000_000_000))), true)).await;
    let params = with_op(json!({ "threadId": "t" }), 1);
    assert_eq!(value(&service, request("thread/quotaResume/schedule", params.clone(), Some(1))).await.unwrap(), json!(true));
    let entry = service.quota.entry("t").expect("queued");
    assert_eq!(
        entry.to_value(),
        json!({
            "sessionId": "t", "turnKey": "turn:abc", "provider": "openai", "model": "gpt-5", "resetAt": 1_750_000_000_000u64,
            "attempts": 0, "generation": 1, "routeProvider": "anthropic", "routeModel": "claude-x",
        })
    );
    // A duplicate op does not queue again under a new generation.
    value(&service, request("thread/quotaResume/schedule", params, Some(1))).await.unwrap();
    assert_eq!(service.quota.entry("t").unwrap().generation, 1);

    // Node refuses with these sentences: no failed quota turn or no reset time, then no input to
    // resume from.
    let no_quota = "latest turn did not fail on exhausted provider quota with a known reset time";
    for (n, refused) in [(2, facts(None, false)), (3, facts(Some(failure(None)), true))] {
        *sessions.facts.lock().unwrap() = refused;
        let error = value(&service, request("thread/quotaResume/schedule", with_op(json!({ "threadId": "t" }), n), Some(n))).await.unwrap_err();
        assert_eq!(message(error), no_quota);
    }
    *sessions.facts.lock().unwrap() = facts(Some(failure(Some(1_750_000_000_000))), false);
    let error = value(&service, request("thread/quotaResume/schedule", with_op(json!({ "threadId": "t" }), 4), Some(4))).await.unwrap_err();
    assert_eq!(message(error), "This turn cannot be resumed automatically. Send a new message to continue.");
    assert_eq!(service.quota.entry("t").unwrap().generation, 1, "a refusal queues nothing");
}

#[tokio::test]
async fn cancel_removes_the_entry_and_marks_the_session_superseded() {
    let ok = continue_case(false);
    let (service, sessions, _dir, _state) = build(&ok, facts(Some(failure(Some(1_750_000_000_000))), true)).await;
    value(&service, request("thread/quotaResume/schedule", with_op(json!({ "threadId": "t" }), 1), Some(1))).await.unwrap();
    assert!(service.quota.entry("t").is_some());
    let cancelled = value(&service, request("thread/quotaResume/cancel", with_op(json!({ "threadId": "t" }), 2), Some(2))).await.unwrap();
    assert_eq!(cancelled, json!(true));
    assert!(service.quota.entry("t").is_none());
    assert_eq!(sessions.cancelled.load(Ordering::SeqCst), 1);
    // Nothing queued is still a cancel that answers true.
    let again = value(&service, request("thread/quotaResume/cancel", with_op(json!({ "threadId": "t" }), 3), Some(3))).await.unwrap();
    assert_eq!(again, json!(true));
    assert_eq!(sessions.cancelled.load(Ordering::SeqCst), 2);
}
