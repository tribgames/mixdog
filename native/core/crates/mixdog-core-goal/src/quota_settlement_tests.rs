//! The quota-settlement guard against the Node recording (`fixtures/ai-admin/quota-settlement-twin.json`):
//! the transcript turn keys, `latestQuotaFailure`, and scripted settle / cancel sequences over the
//! real store and Goal runtime, comparing the entries and Goal notes after every step.

use std::sync::Arc;

use mixdog_rt::CancellationToken;
use serde_json::{Value, json};

use crate::goal::quota::GoalQuotaResume;
use crate::goal::{GoalConfig, GoalEnv, GoalRuntime};
use mixdog_core_base::quota_resume::QuotaResumeStore;
use crate::quota_settlement::{Begin, QuotaFailure, QuotaSettlement, ResumeContext, latest_quota_failure, transcript_turn_keys};

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
    let (mut queued, mut removed) = (0, 0);
    for (n, flow) in twin()["flows"].as_array().unwrap().iter().enumerate() {
        let dir = tempfile::tempdir().unwrap();
        let lane = mixdog_rt::testing::tokens().durability_io;
        let store = Arc::new(QuotaResumeStore::open(dir.path(), lane, CancellationToken::new()).await.unwrap());
        let goals = GoalRuntime::new(GoalConfig::new(dir.path().to_string_lossy().into_owned()), GoalEnv::system(lane));
        let guard = QuotaSettlement::new(GoalQuotaResume::new(store.clone(), goals));
        let (mut session, mut items) = ("sess_a".to_owned(), Vec::<Value>::new());
        let mut auto = true;
        for (s, step) in flow["steps"].as_array().unwrap().iter().enumerate() {
            let at = format!("flow {n} step {s} {}", step["op"]);
            let mut notices = json!([]);
            let held_before = ["sess_a", "sess_b"].iter().any(|id| store.entry(id).is_some());
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
                "auto" => {
                    auto = step["enabled"].as_bool().unwrap();
                    // Turning the setting off cancels every pending resume.
                    if !auto {
                        store.cancel_all().await.unwrap();
                    }
                    Value::Null
                }
                "begin" => {
                    let c = &step["context"];
                    assert_eq!(c["autoResume"], json!(auto), "{at} setting");
                    let context = ResumeContext {
                        auto_resume: auto,
                        retained_retry: c["retainedRetry"].as_bool().unwrap(),
                        goal_reactivatable: c["goalReactivatable"].as_bool().unwrap(),
                        route_provider: c["routeProvider"].as_str().unwrap().to_owned(),
                        route_model: c["routeModel"].as_str().unwrap().to_owned(),
                    };
                    match guard.begin(&session, &items, &context).await.unwrap() {
                        Begin::Nothing => Value::Null,
                        Begin::Queued(entry) => {
                            queued += 1;
                            entry.to_value()
                        }
                        Begin::NotResumable => {
                            notices = json!([["This turn cannot be resumed automatically. Send a new message to continue.", "warn", { "transcript": true }]]);
                            Value::Null
                        }
                    }
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
            assert_eq!(notices, step["notices"], "{at} notices");
            let notes: Vec<Value> = ["sess_a", "sess_b"].iter().map(|id| store.entry(id).map_or(Value::Null, |e| e.to_value())).collect();
            assert_eq!(json!(notes), step["notes"], "{at} entries");
            let mut keys = transcript_turn_keys(&items);
            keys.push("turn:u1".into());
            let suspended: Vec<String> =
                ["sess_a", "sess_b"].iter().flat_map(|id| keys.iter().map(|k| store.suspended_goal(id, k))).collect();
            assert_eq!(json!(suspended), step["suspended"], "{at} goal notes");
            let held_after = notes.iter().any(|n| !n.is_null());
            if held_before && !held_after && matches!(step["op"].as_str().unwrap(), "userInput" | "supersede" | "cancel") {
                removed += 1;
            }
        }
    }
    // The recording must exercise real resumes: queued, then taken away again by a cancel.
    assert!(queued >= 50 && removed >= 10, "queued {queued}, removed {removed}");
}

async fn fixture(dir: &std::path::Path) -> (Arc<QuotaResumeStore>, Arc<QuotaSettlement>) {
    let lane = mixdog_rt::testing::tokens().durability_io;
    let store = Arc::new(QuotaResumeStore::open(dir, lane, CancellationToken::new()).await.unwrap());
    let goals = GoalRuntime::new(GoalConfig::new(dir.to_string_lossy().into_owned()), GoalEnv::system(lane));
    (store.clone(), Arc::new(QuotaSettlement::new(GoalQuotaResume::new(store, goals))))
}

/// A turn that ended on quota; the settlement it opens is keyed `turn:u1`.
async fn settle_a_failed_turn(guard: &QuotaSettlement) {
    let items = vec![
        json!({ "kind": "user", "id": "u1", "text": "p" }),
        json!({ "kind": "turndone", "status": "failed", "quota": { "provider": "x", "resetAt": null } }),
    ];
    let context = ResumeContext { auto_resume: false, ..ResumeContext::default() };
    assert_eq!(guard.begin("sess_a", &items, &context).await.unwrap(), Begin::Nothing);
    assert!(guard.settling());
}

#[tokio::test]
async fn a_cancel_made_while_the_goal_note_waits_keeps_the_note_from_being_written() {
    let dir = tempfile::tempdir().unwrap();
    let (store, guard) = fixture(dir.path()).await;
    settle_a_failed_turn(&guard).await;
    // The session's turn is taken, so the settlement passes its first look at the epoch and waits.
    let held = guard.hold("sess_a").await;
    let mut finish = Box::pin(guard.finish_goal("goal-1"));
    assert!(std::future::poll_fn(|cx| std::task::Poll::Ready(finish.as_mut().poll(cx).is_pending())).await);
    let cancel = guard.cancel_on_user_input("sess_a");
    drop(held);
    let (finished, cancelled) = tokio::join!(finish, cancel);
    assert!(!finished.unwrap(), "the note was written after the epoch rose");
    cancelled.unwrap();
    assert_eq!(store.suspended_goal("sess_a", "turn:u1"), "");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_cancel_racing_the_goal_note_never_leaves_a_suspended_goal_behind() {
    for round in 0..200 {
        let dir = tempfile::tempdir().unwrap();
        let (store, guard) = fixture(dir.path()).await;
        settle_a_failed_turn(&guard).await;
        let (finish, cancel) = (guard.clone(), guard.clone());
        let finish = tokio::spawn(async move { finish.finish_goal("goal-1").await.unwrap() });
        let cancel = tokio::spawn(async move { cancel.cancel_on_user_input("sess_a").await.unwrap() });
        let _ = finish.await.unwrap();
        cancel.await.unwrap();
        assert_eq!(store.suspended_goal("sess_a", "turn:u1"), "", "round {round}");
    }
}
