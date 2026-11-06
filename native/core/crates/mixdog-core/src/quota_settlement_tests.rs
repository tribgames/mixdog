//! The quota-settlement guard against the Node recording (`fixtures/ai-admin/quota-settlement-twin.json`):
//! the transcript turn keys, `latestQuotaFailure`, and scripted settle / cancel sequences over the
//! real store and Goal runtime, comparing the entries and Goal notes after every step.

use std::sync::Arc;

use mixdog_rt::CancellationToken;
use serde_json::{Value, json};

use crate::goal::quota::GoalQuotaResume;
use crate::goal::{GoalConfig, GoalEnv, GoalRuntime};
use crate::quota_resume::QuotaResumeStore;
use crate::quota_settlement::{QuotaSettlement, QuotaFailure, latest_quota_failure, transcript_turn_keys};

fn twin() -> Value {
    serde_json::from_str(include_str!("../../../fixtures/ai-admin/quota-settlement-twin.json")).unwrap()
}

fn rows(value: &Value) -> Vec<Value> {
    value.as_array().unwrap().clone()
}

fn failure_value(failure: Option<QuotaFailure>) -> Value {
    failure.map_or(Value::Null, |f| {
        let request = f.schedule_request("", "", "");
        json!({ "turnKey": f.turn_key, "quota": { "provider": f.provider, "model": f.model, "resetAt": request["resetAt"] } })
    })
}

#[test]
fn turn_keys_and_the_latest_quota_failure_match_node() {
    let twin = twin();
    for (i, case) in twin["keyCases"].as_array().unwrap().iter().enumerate() {
        assert_eq!(json!(transcript_turn_keys(&rows(&case["items"]))), case["keys"], "keys {i}");
    }
    for (i, case) in twin["failureCases"].as_array().unwrap().iter().enumerate() {
        assert_eq!(failure_value(latest_quota_failure(&rows(&case["items"]))), case["failure"], "failure {i}");
    }
}

#[tokio::test]
async fn settle_and_cancel_sequences_match_node() {
    for (n, flow) in twin()["flows"].as_array().unwrap().iter().enumerate() {
        let dir = tempfile::tempdir().unwrap();
        let lane = mixdog_rt::testing::tokens().durability_io;
        let store = Arc::new(QuotaResumeStore::open(dir.path(), lane, CancellationToken::new()).await.unwrap());
        let goals = GoalRuntime::new(GoalConfig::new(dir.path().to_string_lossy().into_owned()), GoalEnv::system(lane));
        let guard = QuotaSettlement::new(GoalQuotaResume::new(store.clone(), goals));
        let (mut session, mut items) = ("sess_a".to_owned(), Vec::<Value>::new());
        for (s, step) in flow["steps"].as_array().unwrap().iter().enumerate() {
            let at = format!("flow {n} step {s} {}", step["op"]);
            let arg = |key: &str| step[key].as_str().unwrap_or_default().to_owned();
            let answer = match step["op"].as_str().unwrap() {
                "items" => {
                    items = rows(&step["items"]);
                    Value::Null
                }
                "session" => {
                    session = arg("sessionId");
                    Value::Null
                }
                "begin" => {
                    guard.begin(&session, &items);
                    Value::Null
                }
                "finish" => json!(guard.finish_goal(&arg("goalId")).await.unwrap()),
                "userInput" => {
                    guard.cancel_on_user_input(&session).await.unwrap();
                    Value::Null
                }
                "supersede" => {
                    guard.supersede(&arg("sessionId")).await.unwrap();
                    Value::Null
                }
                "cancel" => {
                    let id = arg("sessionId");
                    // `requireAddressed` is the session's own check.
                    if id.is_empty() || id != session {
                        json!({ "error": "session is not the active session" })
                    } else {
                        guard.cancel_resume(&id).await.unwrap();
                        json!(true)
                    }
                }
                other => panic!("{other}"),
            };
            assert_eq!(answer, step["answer"], "{at}");
            let notes: Vec<Value> = ["sess_a", "sess_b"].iter().map(|id| store.entry(id).map_or(Value::Null, |e| e.to_value())).collect();
            assert_eq!(json!(notes), step["notes"], "{at} entries");
            let mut keys = transcript_turn_keys(&items);
            keys.push("turn:u1".into());
            let suspended: Vec<String> =
                ["sess_a", "sess_b"].iter().flat_map(|id| keys.iter().map(|k| store.suspended_goal(id, k))).collect();
            assert_eq!(json!(suspended), step["suspended"], "{at} goal notes");
        }
    }
}
