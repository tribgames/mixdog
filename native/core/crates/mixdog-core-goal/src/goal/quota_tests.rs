//! The Goal half of a quota resume over the real store and runtime: a quota failure suspends the
//! active Goal, the store remembers which one, and a resume revives exactly that Goal and then
//! drops the entry and the note (`tui/session/quota-resume.mjs`).
#![allow(clippy::disallowed_methods)]

use std::sync::Arc;

use mixdog_rt::CancellationToken;
use serde_json::{Value, json};

use super::js::string;
use super::quota::GoalQuotaResume;
use super::runtime::{Admission, GoalConfig, GoalEnv, GoalRuntime};
use mixdog_core_base::quota_resume::QuotaResumeStore;

async fn rig(dir: &std::path::Path) -> (GoalQuotaResume, Arc<QuotaResumeStore>, GoalRuntime) {
    let lane = mixdog_rt::testing::tokens().durability_io;
    let store = Arc::new(QuotaResumeStore::open(dir, lane, CancellationToken::new()).await.unwrap());
    let goals = GoalRuntime::new(GoalConfig::new(dir.to_string_lossy().into_owned()), GoalEnv::system(lane));
    (GoalQuotaResume::new(store.clone(), goals.clone()), store, goals)
}

fn schedule(session: &str, turn: &str) -> Value {
    json!({ "sessionId": session, "turnKey": turn, "provider": "anthropic", "model": "m", "resetAt": 1000 })
}

#[tokio::test]
async fn a_quota_failure_suspends_the_goal_and_the_resume_revives_that_goal_and_drops_the_notes() {
    let dir = tempfile::tempdir().unwrap();
    let (quota, store, goals) = rig(dir.path()).await;
    goals.control("s1", json!({ "action": "create", "objective": "ship it" })).await.unwrap();
    let before = goals.start_turn("s1").await.unwrap();
    let settled = goals.settle_turn("s1", json!({ "usageLimited": true })).await.unwrap();
    assert_eq!(string(settled.as_ref().unwrap(), "status"), "usage_limited");

    // A settlement that did not move the Goal from active to usage_limited records nothing.
    assert!(!quota.note_suspension("s1", "turn:a", settled.as_ref(), settled.as_ref()).await.unwrap());
    assert!(quota.note_suspension("s1", "turn:a", before.as_ref(), settled.as_ref()).await.unwrap());
    let goal_id = string(settled.as_ref().unwrap(), "id");
    assert_eq!(quota.suspended("s1", "turn:a"), goal_id);
    assert_eq!(quota.suspended("s1", "turn:other"), "");

    let entry = store.schedule(&schedule("s1", "turn:a")).await.unwrap();
    let revived = quota.resume("s1", &goal_id, Admission::default()).await.unwrap();
    assert_eq!(string(revived.as_ref().unwrap(), "status"), "active");
    // Another Goal's id is never revived.
    assert!(quota.resume("s1", "goal-other", Admission::default()).await.unwrap().is_none());

    assert!(quota.finish_resume("s1", "turn:a", &goal_id, Some(entry.generation)).await.unwrap());
    assert!(store.entry("s1").is_none(), "the fired entry is cancelled at its generation");
    assert_eq!(quota.suspended("s1", "turn:a"), "");
}

#[tokio::test]
async fn a_user_cancel_drops_the_resume_and_the_note_together() {
    let dir = tempfile::tempdir().unwrap();
    let (quota, store, _goals) = rig(dir.path()).await;
    store.schedule(&schedule("s1", "turn:a")).await.unwrap();
    store.note_suspended_goal("s1", "turn:a", "goal-1").await.unwrap();
    quota.cancel("s1").await.unwrap();
    assert!(store.entry("s1").is_none());
    assert_eq!(quota.suspended("s1", "turn:a"), "");
}
