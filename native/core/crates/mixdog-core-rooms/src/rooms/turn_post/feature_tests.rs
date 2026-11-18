//! A member's turn from the room host's side: waiting for the answer, posting the failures held and posting the member's words.

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

use async_trait::async_trait;
use serde_json::{Value, json};

use super::{HaltFuture, HaltOutcome, Polled, Speech, poll_for_answer, post_failures, post_speech};
use crate::rooms::calls::Run;
use crate::rooms::turn_host::{Failure, MemberLabel, RoomRecord, RoomTurnHost, TurnState};

/// A host that reads scripted snapshots (a string is a failed read) and records what the turn did.
struct Host {
    snapshots: Vec<Result<Value, String>>,
    reads: AtomicU64,
    clock: AtomicU64,
    seq: AtomicU64,
    posted: Mutex<Vec<Value>>,
    sleeps: Mutex<Vec<u64>>,
    republished: AtomicU64,
    post_fails: Option<String>,
}

impl Host {
    fn new(snapshots: Vec<Result<Value, String>>) -> Self {
        Self {
            snapshots,
            reads: AtomicU64::new(0),
            clock: AtomicU64::new(1000),
            seq: AtomicU64::new(0),
            posted: Mutex::default(),
            sleeps: Mutex::default(),
            republished: AtomicU64::new(0),
            post_fails: None,
        }
    }
}

#[async_trait]
impl RoomTurnHost for Host {
    fn room_id(&self) -> &str {
        "room01"
    }
    fn poll_ms(&self) -> u64 {
        25
    }
    fn now(&self) -> i64 {
        i64::try_from(self.clock.fetch_add(1, Ordering::SeqCst) + 1).unwrap()
    }
    fn new_id(&self) -> String {
        format!("n{}", self.seq.fetch_add(1, Ordering::SeqCst) + 1)
    }
    fn republish(&self) {
        self.republished.fetch_add(1, Ordering::SeqCst);
    }
    fn log(&self, _: &str) {}
    async fn sleep(&self, ms: u64) {
        self.sleeps.lock().unwrap().push(ms);
    }
    async fn post(&self, rows: Vec<Value>) -> Result<(), String> {
        self.posted.lock().unwrap().extend(rows);
        match &self.post_fails {
            Some(error) => Err(error.clone()),
            None => Ok(()),
        }
    }
    async fn read_snapshot(&self, _: &str) -> Result<Value, String> {
        let read = usize::try_from(self.reads.fetch_add(1, Ordering::SeqCst)).unwrap();
        self.snapshots[read.min(self.snapshots.len() - 1)].clone()
    }
}

fn running() -> Value {
    json!({ "busy": true, "items": [] })
}

fn answered(text: &str) -> Value {
    json!({ "items": [
        { "kind": "user", "id": "u1", "at": 1 },
        { "kind": "assistant", "id": "a1", "text": text },
        { "kind": "turndone", "id": "d1", "at": 2000, "status": "done", "finalAssistantId": "a1" },
    ] })
}

fn never() -> impl Fn() -> Option<HaltFuture> + Send + Sync {
    || None
}

fn state() -> TurnState {
    TurnState::new(Arc::new(Run::default()))
}

#[tokio::test]
async fn the_wait_reads_the_session_every_interval_until_it_has_answered() {
    let host = Host::new(vec![Ok(running()), Ok(running()), Ok(answered("done it"))]);
    let polled = poll_for_answer(&host, &state(), "sess1", 1500.0, &never()).await.unwrap();
    let Polled::Answered { answer, .. } = polled else { panic!("{polled:?}") };
    assert_eq!((answer.status.as_str(), answer.text.as_str()), ("done", "done it"));
    assert_eq!(*host.sleeps.lock().unwrap(), [25, 25, 25], "one interval before each read");
}

#[tokio::test]
async fn a_halt_ends_the_wait_before_any_read() {
    let host = Host::new(vec![Ok(answered("late"))]);
    let halted = || Some(Box::pin(async { HaltOutcome::Superseded }) as HaltFuture);
    assert_eq!(poll_for_answer(&host, &state(), "sess1", 1500.0, &halted).await, Ok(Polled::Halted(HaltOutcome::Superseded)));
    assert_eq!(host.reads.load(Ordering::SeqCst), 0);
}

#[tokio::test]
async fn a_stop_seen_after_a_read_ends_the_wait_as_stopped() {
    let host = Host::new(vec![Ok(answered("too late"))]);
    let state = state();
    state.run.set_stopped();
    assert_eq!(poll_for_answer(&host, &state, "sess1", 1500.0, &never()).await, Ok(Polled::Halted(HaltOutcome::Stopped)));
}

#[tokio::test]
async fn five_failed_reads_in_a_row_are_survived_and_the_sixth_ends_the_wait() {
    let mut five = vec![Err("down".to_owned()); 5];
    five.push(Ok(answered("back")));
    let survived = poll_for_answer(&Host::new(five), &state(), "sess1", 1500.0, &never()).await.unwrap();
    assert!(matches!(survived, Polled::Answered { .. }));

    let six = vec![Err("down".to_owned())];
    let error = poll_for_answer(&Host::new(six), &state(), "sess1", 1500.0, &never()).await.unwrap_err();
    assert_eq!(error, "down");

    let mut broken = vec![Err("blip".to_owned()); 5];
    broken.push(Ok(running()));
    broken.extend(vec![Err("blip".to_owned()); 5]);
    broken.push(Ok(answered("fine")));
    assert!(matches!(poll_for_answer(&Host::new(broken), &state(), "sess1", 1500.0, &never()).await, Ok(Polled::Answered { .. })), "a good read resets the count");
}

#[tokio::test]
async fn a_new_tool_approval_is_kept_and_republished_once() {
    let mut asking = running();
    asking["toolApproval"] = json!({ "id": "ap1" });
    let mut answer = answered("ok");
    answer["toolApproval"] = json!({ "id": "ap1" });
    let host = Host::new(vec![Ok(asking), Ok(answer)]);
    let state = state();
    poll_for_answer(&host, &state, "sess1", 1500.0, &never()).await.unwrap();
    assert_eq!(state.approval().unwrap()["id"], json!("ap1"));
    assert_eq!(host.republished.load(Ordering::SeqCst), 1, "the same approval is not republished");
}

#[tokio::test]
async fn failures_held_post_as_one_failed_pass_row_naming_each_member_and_distinct_reason() {
    let host = Host::new(vec![Ok(running())]);
    let state = state();
    for (id, name, reason) in [("a", "Ann", "quota"), ("b", "Bob", "quota"), ("a", "Ann", "timeout")] {
        state.push_failure(Failure { id: id.into(), name: name.into(), reason: reason.into() });
    }
    post_failures(&host, &state).await.unwrap();
    let posted = host.posted.lock().unwrap().clone();
    assert_eq!(posted.len(), 1);
    assert_eq!(posted[0]["kind"], json!("pass"));
    assert_eq!(posted[0]["failed"], json!(true));
    assert_eq!(posted[0]["names"], json!(["Ann", "Bob"]));
    assert_eq!(posted[0]["reason"], json!(["quota", "timeout"]));
    assert_eq!(posted[0]["speaker"], json!("a"));
    assert!(state.failures().is_empty(), "the held failures are consumed");

    post_failures(&host, &state).await.unwrap();
    assert_eq!(host.posted.lock().unwrap().len(), 1, "nothing held posts nothing");
}

fn label(id: &str, name: &str) -> MemberLabel {
    MemberLabel { id: id.into(), name: name.into(), route: Value::Null, description: String::new(), disabled: false }
}

#[tokio::test]
async fn a_speech_row_carries_its_mention_session_files_and_tools_and_moves_the_cursor() {
    let host = Host::new(vec![Ok(running())]);
    let state = state();
    state.set_member_session("sess-ann");
    state.set_waiting(true);
    let room = Mutex::new(RoomRecord { name: "Room".into(), members: vec!["ann".into(), "alpha".into()], ..RoomRecord::default() });
    let labels: HashMap<String, MemberLabel> = [("ann", "Ann"), ("alpha", "Alpha")].iter().map(|(id, name)| ((*id).to_owned(), label(id, name))).collect();
    let snapshot = json!({ "items": [
        { "kind": "user", "id": "u1", "at": 1 },
        { "kind": "tool", "name": "read", "result": "contents", "at": 1600 },
    ] });
    let member = label("ann", "Ann");
    let speech = Speech { agent_id: "ann", member: &member, text: "@Alpha what do you think?", snapshot: &snapshot, started_at: 1500.0 };

    let mention = post_speech(&host, &state, &room, &labels, &speech).await.unwrap();
    assert_eq!(mention.as_deref(), Some("alpha"));
    let row = host.posted.lock().unwrap()[0].clone();
    assert_eq!(row["kind"], json!("speech"));
    assert_eq!(row["id"], json!("row_n1"));
    assert_eq!((row["speaker"].clone(), row["name"].clone()), (json!("ann"), json!("Ann")));
    assert_eq!((row["to"].clone(), row["toName"].clone()), (json!(["alpha"]), json!(["Alpha"])));
    assert_eq!(row["artifactsFrom"], json!({ "sessionId": "sess-ann", "since": 1500 }));
    assert_eq!(row["tools"], json!([{ "name": "read", "summary": "contents" }]));
    assert!(!state.waiting(), "the user's wait is over once the member spoke");
    let room = room.lock().unwrap();
    assert_eq!(room.last_speaker.as_deref(), Some("ann"));
    assert_eq!(room.last_at, row["at"].as_i64());
}

#[tokio::test]
async fn a_speech_without_a_mention_addresses_nobody_and_a_failed_post_leaves_the_cursor() {
    let mut host = Host::new(vec![Ok(running())]);
    let state = state();
    let room = Mutex::new(RoomRecord { members: vec!["ann".into()], ..RoomRecord::default() });
    let member = label("ann", "Ann");
    let snapshot = json!({ "items": [] });
    let speech = Speech { agent_id: "ann", member: &member, text: "just thinking aloud", snapshot: &snapshot, started_at: 1.0 };
    assert_eq!(post_speech(&host, &state, &room, &HashMap::new(), &speech).await.unwrap(), None);
    let row = host.posted.lock().unwrap()[0].clone();
    assert!(row.get("to").is_none() && row.get("tools").is_none() && row.get("artifactsFrom").is_none());

    host.post_fails = Some("disk full".into());
    room.lock().unwrap().last_speaker = None;
    assert_eq!(post_speech(&host, &state, &room, &HashMap::new(), &speech).await.unwrap_err(), "disk full");
    assert!(room.lock().unwrap().last_speaker.is_none());
}
