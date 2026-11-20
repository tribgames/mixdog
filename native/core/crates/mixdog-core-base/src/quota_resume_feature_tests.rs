//! The quota-resume queue (`quota-resume.json`): what each change decides, the generation each entry is stamped with, who is told,
//! what a restart reads back, and which sessions may own a resume at all.

use std::sync::{Arc, Mutex};

use mixdog_rt::CancellationToken;
use serde_json::{Value, json};

use crate::quota_resume::{Entry, QUOTA_RESUME_FILE, QuotaError, QuotaResumeStore, is_agent_only_session};

async fn open(dir: &std::path::Path) -> QuotaResumeStore {
    QuotaResumeStore::open(dir, mixdog_rt::testing::tokens().durability_io, CancellationToken::new()).await.unwrap()
}

fn request(session: &str, turn: &str, reset_at: u64) -> Value {
    json!({ "sessionId": session, "turnKey": turn, "provider": "openai", "model": "gpt-5", "resetAt": reset_at, "routeProvider": "anthropic", "routeModel": "claude-x" })
}

fn file_of(dir: &std::path::Path) -> Value {
    serde_json::from_slice(&std::fs::read(dir.join(QUOTA_RESUME_FILE)).unwrap()).unwrap()
}

fn heard_by(store: &QuotaResumeStore) -> (Arc<Mutex<Vec<Option<String>>>>, crate::quota_resume::Subscription) {
    let heard = Arc::new(Mutex::new(Vec::new()));
    let sink = heard.clone();
    let subscription = store.subscribe(move |id| sink.lock().unwrap().push(id.map(str::to_owned)));
    (heard, subscription)
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_schedule_queues_the_resume_under_the_next_generation_and_a_new_store_reads_it_back() {
    let dir = tempfile::tempdir().unwrap();
    let store = open(dir.path()).await;
    let (heard, _subscription) = heard_by(&store);
    let first = store.schedule(&request("s1", "turn:a", 1_750_000_000_000)).await.unwrap();
    let second = store.schedule(&request("s2", "turn:b", 1_750_000_001_000)).await.unwrap();
    assert_eq!((first.generation, second.generation, first.attempts), (1, 2, 0));
    assert_eq!(
        first.to_value(),
        json!({ "sessionId": "s1", "turnKey": "turn:a", "provider": "openai", "model": "gpt-5", "resetAt": 1_750_000_000_000u64, "attempts": 0, "generation": 1, "routeProvider": "anthropic", "routeModel": "claude-x" })
    );
    assert_eq!(
        first.public(),
        json!({ "state": "waiting", "turnKey": "turn:a", "provider": "openai", "model": "gpt-5", "resetAt": 1_750_000_000_000u64, "attempts": 0 })
    );
    assert_eq!(*heard.lock().unwrap(), [Some("s1".to_owned()), Some("s2".to_owned())]);
    let file = file_of(dir.path());
    assert_eq!((file["version"].clone(), file["generation"].clone()), (json!(1), json!(2)));
    assert_eq!(file["entries"].as_array().unwrap().len(), 2);

    let again = open(dir.path()).await;
    assert_eq!(again.list(), vec![first, second]);
    let third = again.schedule(&request("s3", "turn:c", 5)).await.unwrap();
    assert_eq!(third.generation, 3, "a restart goes on from the highest generation it read");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn scheduling_a_session_again_replaces_its_entry_in_place_under_a_fresh_generation() {
    let dir = tempfile::tempdir().unwrap();
    let store = open(dir.path()).await;
    store.schedule(&request("s1", "turn:a", 1)).await.unwrap();
    store.schedule(&request("s2", "turn:b", 2)).await.unwrap();
    let replaced = store.schedule(&request("s1", "turn:c", 3)).await.unwrap();
    assert_eq!(replaced.generation, 3);
    let order: Vec<(String, String)> = store.list().into_iter().map(|e| (e.session_id, e.turn_key)).collect();
    assert_eq!(order, [("s1".to_owned(), "turn:c".to_owned()), ("s2".to_owned(), "turn:b".to_owned())]);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_request_without_a_session_turn_provider_or_reset_time_is_refused_and_changes_nothing() {
    let dir = tempfile::tempdir().unwrap();
    let store = open(dir.path()).await;
    let (heard, _subscription) = heard_by(&store);
    for bad in [
        json!({ "turnKey": "t", "provider": "p", "resetAt": 1 }),
        json!({ "sessionId": "s", "provider": "p", "resetAt": 1 }),
        json!({ "sessionId": "s", "turnKey": "t", "resetAt": 1 }),
        json!({ "sessionId": "s", "turnKey": "t", "provider": "p" }),
        json!({ "sessionId": "  ", "turnKey": "t", "provider": "p", "resetAt": 1 }),
        json!({ "sessionId": "s", "turnKey": "t", "provider": "p", "resetAt": "soon" }),
    ] {
        assert_eq!(store.schedule(&bad).await, Err(QuotaError::Type("quota resume needs a session, turn, provider and reset time".into())), "{bad}");
    }
    assert!(store.list().is_empty());
    assert!(heard.lock().unwrap().is_empty());
    assert!(!dir.path().join(QUOTA_RESUME_FILE).exists(), "nothing was written");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_cancel_removes_the_entry_or_only_the_exact_generation_and_tells_the_session() {
    let dir = tempfile::tempdir().unwrap();
    let store = open(dir.path()).await;
    let (heard, _subscription) = heard_by(&store);
    let entry = store.schedule(&request("s1", "turn:a", 1)).await.unwrap();
    assert!(!store.cancel("s1", Some(entry.generation + 1)).await.unwrap(), "another generation's cancel leaves it");
    assert!(store.entry("s1").is_some());
    assert!(!store.cancel("nobody", None).await.unwrap());
    assert!(store.cancel(" s1 ", Some(entry.generation)).await.unwrap());
    assert!(store.entry("s1").is_none());
    assert!(file_of(dir.path())["entries"].as_array().unwrap().is_empty());
    assert_eq!(*heard.lock().unwrap(), [Some("s1".to_owned()), Some("s1".to_owned())], "the schedule and the cancel were announced, the refusals not");
    store.schedule(&request("s1", "turn:b", 2)).await.unwrap();
    assert!(store.cancel("s1", None).await.unwrap(), "no generation named: whatever is queued goes");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_deferral_moves_the_exact_entry_to_a_later_reading_keeping_its_generation() {
    let dir = tempfile::tempdir().unwrap();
    let store = open(dir.path()).await;
    let entry = store.schedule(&request("s1", "turn:a", 100)).await.unwrap();
    let moved = store.defer("s1", Some(entry.generation), &json!({ "resetAt": 900, "attempts": 2 })).await.unwrap().expect("deferred");
    assert_eq!((moved.generation, moved.attempts, moved.reset_at.as_u64()), (entry.generation, 2, Some(900)));
    let reset = store.defer("s1", Some(entry.generation), &json!({ "resetAt": 1_000 })).await.unwrap().expect("deferred");
    assert_eq!(reset.attempts, 0, "an absent attempts resets the count");
    assert_eq!(store.defer("s1", Some(entry.generation + 1), &json!({ "resetAt": 5 })).await.unwrap(), None, "another generation");
    assert_eq!(store.defer("s1", None, &json!({ "resetAt": 5 })).await.unwrap(), None, "no generation named");
    assert_eq!(store.defer("nobody", Some(1), &json!({ "resetAt": 5 })).await.unwrap(), None);
    assert_eq!(
        store.defer("s1", Some(entry.generation), &json!({ "attempts": 1 })).await,
        Err(QuotaError::Type("quota resume deferral needs a reset time".into()))
    );
    assert_eq!(store.entry("s1").unwrap().reset_at.as_u64(), Some(1_000), "the refused deferral changed nothing");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn cancelling_all_drops_every_entry_counts_them_and_tells_everyone_once() {
    let dir = tempfile::tempdir().unwrap();
    let store = open(dir.path()).await;
    assert_eq!(store.cancel_all().await.unwrap(), 0);
    store.schedule(&request("s1", "turn:a", 1)).await.unwrap();
    store.schedule(&request("s2", "turn:b", 2)).await.unwrap();
    let (heard, _subscription) = heard_by(&store);
    assert_eq!(store.cancel_all().await.unwrap(), 2);
    assert!(store.list().is_empty());
    assert_eq!(*heard.lock().unwrap(), [None], "one notice that every entry changed");
    assert_eq!(store.cancel_all().await.unwrap(), 0);
    assert_eq!(heard.lock().unwrap().len(), 1, "nothing to drop, nothing announced");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn the_goal_a_quota_failure_suspended_is_noted_by_session_and_turn_and_forgotten() {
    let dir = tempfile::tempdir().unwrap();
    let store = open(dir.path()).await;
    assert!(store.note_suspended_goal("s1", "turn:a", "goal-1").await.unwrap());
    assert_eq!(store.suspended_goal("s1", "turn:a"), "goal-1");
    assert_eq!(store.suspended_goal("s1", "turn:other"), "", "another failure's goal is not this one's");
    assert_eq!(file_of(dir.path())["suspensions"], json!([{ "sessionId": "s1", "turnKey": "turn:a", "goalId": "goal-1" }]));
    assert!(store.note_suspended_goal("s1", "turn:b", "goal-2").await.unwrap());
    assert_eq!(store.suspended_goal("s1", "turn:a"), "", "a later note replaces the earlier one");
    assert_eq!(store.suspended_goal("s1", "turn:b"), "goal-2");
    assert!(!store.note_suspended_goal("s1", "", "goal-3").await.unwrap(), "a note without a turn or goal is nothing");
    assert!(!store.note_suspended_goal("", "turn:a", "goal-3").await.unwrap());
    assert!(!store.forget_suspended_goal("nobody").await.unwrap());
    assert!(store.forget_suspended_goal("s1").await.unwrap());
    assert_eq!(store.suspended_goal("s1", "turn:b"), "");
    assert!(file_of(dir.path())["suspensions"].as_array().unwrap().is_empty());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_rekey_moves_the_proven_entry_and_its_goal_together_and_invalidates_the_old_fires() {
    let dir = tempfile::tempdir().unwrap();
    let store = open(dir.path()).await;
    let entry = store.schedule(&request("s1", "legacy:1", 10)).await.unwrap();
    store.note_suspended_goal("s1", "legacy:1", "goal-1").await.unwrap();
    assert!(!store.rekey_turn("s1", "legacy:1", "legacy:1").await.unwrap(), "the same key is no move");
    assert!(!store.rekey_turn("s1", "", "turn:new").await.unwrap());
    assert!(!store.rekey_turn("s1", "legacy:other", "turn:new").await.unwrap(), "only the key the entry is under moves");
    assert!(store.rekey_turn("s1", "legacy:1", "turn:new").await.unwrap());
    let moved = store.entry("s1").unwrap();
    assert_eq!(moved.turn_key, "turn:new");
    assert_eq!(moved.generation, entry.generation + 1, "a fire made for the old key finds a different generation");
    assert_eq!(store.suspended_goal("s1", "turn:new"), "goal-1");
    assert_eq!(store.suspended_goal("s1", "legacy:1"), "");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_file_the_store_cannot_use_reads_as_an_empty_queue_and_unusable_entries_are_dropped() {
    let dir = tempfile::tempdir().unwrap();
    std::fs::write(dir.path().join(QUOTA_RESUME_FILE), b"{ not json").unwrap();
    assert!(open(dir.path()).await.list().is_empty(), "a torn file is an empty queue");

    let text = json!({
        "version": 1, "generation": 7,
        "entries": [
            { "sessionId": "ok", "turnKey": "t", "provider": "p", "resetAt": 5, "attempts": -3, "generation": 4 },
            { "sessionId": "no-turn", "provider": "p", "resetAt": 5, "generation": 5 },
            { "sessionId": "no-reset", "turnKey": "t", "provider": "p", "generation": 6 },
            { "sessionId": "no-generation", "turnKey": "t", "provider": "p", "resetAt": 5 },
        ],
    });
    std::fs::write(dir.path().join(QUOTA_RESUME_FILE), text.to_string()).unwrap();
    let store = open(dir.path()).await;
    let kept: Vec<Entry> = store.list();
    assert_eq!(kept.iter().map(|e| e.session_id.as_str()).collect::<Vec<_>>(), ["ok"]);
    assert_eq!(kept[0].attempts, 0, "a negative attempt count reads as none");
    assert_eq!(store.schedule(&request("next", "t", 1)).await.unwrap().generation, 8, "the file's own generation counter is kept");
}

#[test]
fn only_the_lead_decides_retries_so_a_delegated_agent_child_never_owns_a_resume() {
    for (session, agent_only) in [
        (json!({ "id": "s", "visibility": "agent-only" }), true),
        (json!({ "id": "s", "visibility": " Agent-Only " }), true),
        (json!({ "id": "child", "owner": "agent", "agent": "worker", "parentSessionId": "lead" }), true),
        (json!({ "id": "child", "owner": "agent", "agent": "worker", "ownerSessionId": "lead" }), true),
        (json!({ "id": "child", "owner": "agent", "agent": "lead", "parentSessionId": "p" }), false),
        (json!({ "id": "child", "owner": "agent", "agent": "worker", "parentSessionId": "child" }), false),
        (json!({ "id": "child", "owner": "agent", "agent": "worker" }), false),
        (json!({ "id": "s", "owner": "user", "agent": "worker", "parentSessionId": "p" }), false),
        (json!({ "id": "s", "visibility": "visible" }), false),
        (json!("not a session"), false),
    ] {
        assert_eq!(is_agent_only_session(&session), agent_only, "{session}");
    }
}
