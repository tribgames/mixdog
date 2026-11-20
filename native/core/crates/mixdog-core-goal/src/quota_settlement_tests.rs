//! The quota-settlement guard against the Node recording (`fixtures/ai-admin/quota-settlement-twin.json`):
//! the transcript turn keys, `latestQuotaFailure`, and scripted settle / cancel sequences over the
//! real store and Goal runtime, comparing the entries and Goal notes after every step.

use std::sync::Arc;

use mixdog_rt::CancellationToken;
use serde_json::{Value, json};

use crate::goal::quota::GoalQuotaResume;
use crate::goal::{GoalConfig, GoalEnv, GoalRuntime};
use crate::quota_settlement::{
    Begin, QuotaSettlement, RETRY_CONTINUE_INSTRUCTION, ResumeContext, failed_turn_retry_prompt, latest_quota_failure, transcript_turn_keys,
};
use mixdog_core_base::quota_resume::QuotaResumeStore;

async fn fixture(dir: &std::path::Path) -> (Arc<QuotaResumeStore>, Arc<QuotaSettlement>) {
    let lane = mixdog_rt::testing::tokens().durability_io;
    let store = Arc::new(QuotaResumeStore::open(dir, lane, CancellationToken::new()).await.unwrap());
    let goals = Arc::new(GoalRuntime::new(GoalConfig::new(dir.to_string_lossy().into_owned()), GoalEnv::system(lane)));
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

fn user(id: &str, text: &str) -> Value {
    json!({ "kind": "user", "id": id, "text": text })
}

fn failed(quota: Value) -> Value {
    json!({ "kind": "turndone", "status": "failed", "quota": quota })
}

#[test]
fn a_turn_is_named_by_its_first_user_row_until_its_turndone_gives_it_an_identity() {
    let open = vec![user("u1", "p"), json!({ "kind": "assistant", "id": "a1" }), json!({ "kind": "turndone", "status": "done" })];
    assert_eq!(transcript_turn_keys(&open), ["turn:u1", "turn:u1", "turn:u1"]);

    let attempt = vec![user("u1", "p"), json!({ "kind": "turndone", "attemptId": "a9" })];
    assert_eq!(transcript_turn_keys(&attempt), ["attempt:a9", "attempt:a9"]);
    let checkpoint = vec![user("u1", "p"), json!({ "kind": "turndone", "checkpointId": "c1" })];
    assert_eq!(transcript_turn_keys(&checkpoint), ["checkpoint:c1", "checkpoint:c1"]);

    let two = vec![user("u1", "p"), json!({ "kind": "turndone", "attemptId": "a1" }), user("u2", "q"), json!({ "kind": "assistant", "id": "a2" })];
    assert_eq!(transcript_turn_keys(&two), ["attempt:a1", "attempt:a1", "turn:u2", "turn:u2"]);
}

#[test]
fn rows_before_any_user_row_form_a_segment_and_an_id_less_row_is_keyed_by_its_label_and_place() {
    let rows = vec![json!({ "kind": "notice", "id": "n1" }), json!({ "kind": "assistant", "text": "hi" })];
    assert_eq!(transcript_turn_keys(&rows), ["segment:n1", "segment:n1"]);
    let unkeyed = vec![json!({ "kind": "user", "text": "go" })];
    assert_eq!(transcript_turn_keys(&unkeyed), ["turn:user:go:0"]);
}

#[test]
fn the_latest_failed_turndone_with_a_quota_is_the_failure_to_resume() {
    let items = vec![user("u1", "p"), failed(json!({ "provider": "openai", "model": "gpt-x", "resetAt": 1_800_000_000_000_i64 }))];
    let failure = latest_quota_failure(&items).expect("a failure");
    assert_eq!((failure.turn_key.as_str(), failure.provider.as_str(), failure.model.as_str()), ("turn:u1", "openai", "gpt-x"));
    assert_eq!(failure.reset_at, Some(1_800_000_000_000.0));

    let upper = vec![user("u1", "p"), json!({ "kind": "turndone", "status": "FAILED", "quota": { "provider": "p" } })];
    assert_eq!(latest_quota_failure(&upper).unwrap().reset_at, None, "no reset reading yet");
}

#[test]
fn a_turn_that_did_not_end_on_quota_or_was_overtaken_has_no_failure() {
    let done = vec![user("u1", "p"), json!({ "kind": "turndone", "status": "done", "quota": { "provider": "p" } })];
    assert!(latest_quota_failure(&done).is_none());
    assert!(latest_quota_failure(&[user("u1", "p"), failed(json!({}))]).is_none(), "a quota names its provider");
    assert!(latest_quota_failure(&[user("u1", "p"), failed(json!({ "provider": "p" })), user("u2", "q")]).is_none(), "a newer prompt supersedes");
    let mut archived = failed(json!({ "provider": "p" }));
    archived["archived"] = json!(true);
    assert!(latest_quota_failure(&[user("u1", "p"), archived]).is_none(), "a compacted turn is not the model's to resume");
    assert!(latest_quota_failure(&[]).is_none());
}

#[test]
fn retrying_a_failed_turn_resubmits_its_prompt_or_asks_to_continue_when_it_produced_output() {
    let bare = vec![user("u1", "  fix it  "), failed(json!({ "provider": "p" }))];
    assert_eq!(failed_turn_retry_prompt(&bare, "turn:u1").as_deref(), Some("fix it"));
    let sampled = vec![user("u1", "fix it"), json!({ "kind": "assistant", "id": "a1", "text": "working" }), failed(json!({ "provider": "p" }))];
    assert_eq!(failed_turn_retry_prompt(&sampled, "turn:u1").as_deref(), Some(RETRY_CONTINUE_INSTRUCTION));
    let empty = vec![user("u1", ""), failed(json!({ "provider": "p" }))];
    assert_eq!(failed_turn_retry_prompt(&empty, "turn:u1"), None, "nothing to replay");
    let media = vec![json!({ "kind": "user", "id": "u1", "text": "see", "images": [{ "name": "a.png" }] }), failed(json!({ "provider": "p" }))];
    assert_eq!(failed_turn_retry_prompt(&media, "turn:u1"), None, "a text replay would drop the attachment");
}

fn quota_turn(reset: Value) -> Vec<Value> {
    vec![user("u1", "p"), failed(json!({ "provider": "x", "model": "m", "resetAt": reset }))]
}

fn resumable() -> ResumeContext {
    ResumeContext { auto_resume: true, route_provider: "x".into(), route_model: "m".into(), ..ResumeContext::default() }
}

#[tokio::test]
async fn a_quota_failure_with_a_known_reset_queues_its_resume_under_the_failed_turn() {
    let dir = tempfile::tempdir().unwrap();
    let (store, guard) = fixture(dir.path()).await;
    let Begin::Queued(entry) = guard.begin("sess_a", &quota_turn(json!(1_800_000_000_000_i64)), &resumable()).await.unwrap() else {
        panic!("expected a queued resume")
    };
    assert_eq!((entry.session_id.as_str(), entry.turn_key.as_str(), entry.provider.as_str(), entry.attempts), ("sess_a", "turn:u1", "x", 0));
    assert_eq!((entry.route_provider.as_str(), entry.route_model.as_str()), ("x", "m"));
    assert_eq!(store.entry("sess_a").unwrap().turn_key, "turn:u1");
}

#[tokio::test]
async fn nothing_is_queued_without_a_reset_without_the_setting_or_when_the_turn_cannot_be_replayed() {
    let dir = tempfile::tempdir().unwrap();
    let (store, guard) = fixture(dir.path()).await;
    assert_eq!(guard.begin("sess_a", &quota_turn(json!(null)), &resumable()).await.unwrap(), Begin::Nothing, "no reset time");
    let off = ResumeContext { auto_resume: false, ..resumable() };
    assert_eq!(guard.begin("sess_a", &quota_turn(json!(1_800_000_000_000_i64)), &off).await.unwrap(), Begin::Nothing, "the setting is off");
    let media = vec![
        json!({ "kind": "user", "id": "u1", "text": "see", "images": [{ "name": "a.png" }] }),
        failed(json!({ "provider": "x", "resetAt": 1_800_000_000_000_i64 })),
    ];
    assert_eq!(guard.begin("sess_a", &media, &resumable()).await.unwrap(), Begin::NotResumable);
    let retained = ResumeContext { retained_retry: true, ..resumable() };
    assert!(matches!(guard.begin("sess_a", &media, &retained).await.unwrap(), Begin::Queued(_)), "the model history still holds the message");
    assert!(store.entry("sess_a").is_some());
}

#[tokio::test]
async fn new_user_input_cancels_the_queued_resume_and_the_note_but_an_explicit_cancel_keeps_the_note() {
    let dir = tempfile::tempdir().unwrap();
    let (store, guard) = fixture(dir.path()).await;
    guard.begin("sess_a", &quota_turn(json!(1_800_000_000_000_i64)), &resumable()).await.unwrap();
    assert!(guard.finish_goal("goal-1").await.unwrap(), "the Goal this failure suspended is noted");
    assert_eq!(store.suspended_goal("sess_a", "turn:u1"), "goal-1");

    assert!(guard.cancel_resume("sess_a").await.unwrap());
    assert!(store.entry("sess_a").is_none(), "the resume is dropped");
    assert_eq!(store.suspended_goal("sess_a", "turn:u1"), "goal-1", "an explicit cancel keeps the note");

    guard.cancel_on_user_input("sess_a").await.unwrap();
    assert_eq!(store.suspended_goal("sess_a", "turn:u1"), "", "new input supersedes the stopped turn");
}

#[tokio::test]
async fn a_cancel_before_the_settlement_begins_queues_nothing_and_an_empty_goal_is_never_noted() {
    let dir = tempfile::tempdir().unwrap();
    let (store, guard) = fixture(dir.path()).await;
    guard.begin("sess_a", &quota_turn(json!(null)), &resumable()).await.unwrap();
    assert!(!guard.finish_goal("").await.unwrap(), "no Goal was suspended");
    assert_eq!(store.suspended_goal("sess_a", "turn:u1"), "");
    assert!(!guard.finish_goal("goal-1").await.unwrap(), "the settlement was already consumed");
    assert!(guard.begin("", &quota_turn(json!(1_800_000_000_000_i64)), &resumable()).await.unwrap() == Begin::Nothing, "no session, no resume");
}
