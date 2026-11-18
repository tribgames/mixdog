//! One member's turn in a group room: whether it gets a turn at all, what it is handed, and how the turn ends.

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

use async_trait::async_trait;
use serde_json::{Value, json};

use super::{MemberHost, Outcome, PersistFuture, SubmitOptions, TurnCall, combined_call, member_turn};
use crate::rooms::calls::{Run, RoomCall};
use crate::rooms::exchange::{Scene, Turn, TurnResult};
use crate::rooms::turn_host::{MemberLabel, RoomRecord, RoomTurnHost, TurnState};
use crate::rooms::turn_prompt::RoomPrompt;

struct Host {
    room: Arc<Mutex<RoomRecord>>,
    rows: Vec<Value>,
    snapshot: Value,
    switched_off: bool,
    accept: bool,
    clock: AtomicU64,
    seq: AtomicU64,
    submitted: Mutex<Vec<(String, String, SubmitOptions)>>,
    posted: Mutex<Vec<Value>>,
    logs: Mutex<Vec<String>>,
    aborted: Mutex<Vec<String>>,
    /// What happens in the room while the daemon accepts a submission.
    on_submit: Mutex<Option<Box<dyn Fn(&Host) + Send + Sync>>>,
}

impl Host {
    fn new(members: &[&str], rows: Vec<Value>, snapshot: Value) -> Self {
        let room = RoomRecord { name: "Design".into(), members: members.iter().map(|m| (*m).to_owned()).collect(), ..RoomRecord::default() };
        Self {
            room: Arc::new(Mutex::new(room)),
            rows,
            snapshot,
            switched_off: false,
            accept: true,
            clock: AtomicU64::new(1000),
            seq: AtomicU64::new(0),
            submitted: Mutex::default(),
            posted: Mutex::default(),
            logs: Mutex::default(),
            aborted: Mutex::default(),
            on_submit: Mutex::default(),
        }
    }
}

#[async_trait]
impl RoomTurnHost for Host {
    fn room_id(&self) -> &str {
        "room01"
    }
    fn poll_ms(&self) -> u64 {
        1
    }
    fn now(&self) -> i64 {
        i64::try_from(self.clock.fetch_add(1, Ordering::SeqCst) + 1).unwrap()
    }
    fn new_id(&self) -> String {
        format!("n{}", self.seq.fetch_add(1, Ordering::SeqCst) + 1)
    }
    fn republish(&self) {}
    fn log(&self, line: &str) {
        self.logs.lock().unwrap().push(line.to_owned());
    }
    async fn sleep(&self, _: u64) {}
    async fn post(&self, rows: Vec<Value>) -> Result<(), String> {
        self.posted.lock().unwrap().extend(rows);
        Ok(())
    }
    async fn read_snapshot(&self, _: &str) -> Result<Value, String> {
        Ok(self.snapshot.clone())
    }
}

#[async_trait]
impl MemberHost for Host {
    fn room(&self) -> Result<Arc<Mutex<RoomRecord>>, String> {
        Ok(self.room.clone())
    }
    async fn rows(&self) -> Result<Vec<Value>, String> {
        Ok(self.rows.clone())
    }
    async fn member_session(&self, member: &MemberLabel) -> Result<String, String> {
        Ok(format!("sess-{}", member.id))
    }
    async fn switched_off(&self, _: &str) -> Result<bool, String> {
        Ok(self.switched_off)
    }
    async fn submit(&self, session_id: &str, prompt: &RoomPrompt, options: &SubmitOptions) -> Result<bool, String> {
        let text = match prompt {
            RoomPrompt::Text(text) => text.clone(),
            RoomPrompt::Parts(parts) => parts.iter().filter_map(|p| p["text"].as_str()).collect::<Vec<_>>().join("\n"),
        };
        self.submitted.lock().unwrap().push((session_id.to_owned(), text, options.clone()));
        if let Some(act) = self.on_submit.lock().unwrap().as_ref() {
            act(self);
        }
        Ok(self.accept)
    }
    async fn abort(&self, session: &str) -> Result<(), String> {
        self.aborted.lock().unwrap().push(session.to_owned());
        Ok(())
    }
    fn persist(&self) -> PersistFuture {
        Box::pin(async { Ok(()) })
    }
}

fn labels() -> Arc<HashMap<String, MemberLabel>> {
    Arc::new(["ann", "bob"].iter().map(|id| ((*id).to_owned(), MemberLabel { id: (*id).into(), name: id.to_uppercase(), route: json!({ "provider": "route-p", "model": "route-m" }), description: String::new(), disabled: false })).collect())
}

fn turn() -> Turn {
    Turn { addressed: Vec::new(), instruction: String::new(), mentioned_by: String::new(), scene: Scene::Work }
}

fn user_row(id: &str, text: &str) -> Value {
    json!({ "kind": "user", "id": id, "text": text, "at": 1 })
}

fn answered(text: &str) -> Value {
    json!({ "items": [
        { "kind": "user", "id": "x1", "at": 1 },
        { "kind": "assistant", "id": "a1", "text": text },
        { "kind": "turndone", "id": "d1", "at": 5000, "status": "done", "finalAssistantId": "a1" },
    ] })
}

fn failed_snapshot(done: Value) -> Value {
    let mut item = json!({ "kind": "turndone", "id": "d1", "at": 5000, "status": "failed" });
    item.as_object_mut().unwrap().extend(done.as_object().unwrap().clone());
    json!({ "items": [{ "kind": "user", "id": "x1", "at": 1 }, item] })
}

async fn run(host: &Arc<Host>, state: &Arc<TurnState>, turn: &Turn) -> (crate::rooms::exchange::Answer, Arc<Outcome>) {
    let dynamic: Arc<dyn MemberHost> = host.clone();
    let outcome = Arc::new(Outcome::default());
    let answer = member_turn(&dynamic, state, &labels(), "ann", turn, None, &outcome).await.unwrap();
    (answer, outcome)
}

fn state() -> Arc<TurnState> {
    Arc::new(TurnState::new(Arc::new(Run::default())))
}

#[tokio::test]
async fn a_member_handed_a_waiting_user_message_submits_it_and_posts_its_answer() {
    let host = Arc::new(Host::new(&["ann", "bob"], vec![user_row("u1", "hello team")], answered("hi there")));
    let state = state();
    state.set_waiting(true);
    let (answer, _) = run(&host, &state, &turn()).await;
    assert_eq!(answer.result, TurnResult::Speech);

    let submitted = host.submitted.lock().unwrap().clone();
    assert_eq!(submitted.len(), 1);
    let (session, prompt, options) = &submitted[0];
    assert_eq!(session, "sess-ann");
    assert!(prompt.contains("hello team") && prompt.contains("You are ANN"), "{prompt}");
    assert_eq!(options.room_row.as_deref(), Some("u1"), "the user row the answer must respond to");
    assert!(options.id.as_deref().unwrap().starts_with("rsub_"), "every member submission has a stable id");

    let posted = host.posted.lock().unwrap().clone();
    assert_eq!(posted.len(), 1);
    assert_eq!((posted[0]["kind"].clone(), posted[0]["speaker"].clone(), posted[0]["text"].clone()), (json!("speech"), json!("ann"), json!("hi there")));
    let room = host.room.lock().unwrap();
    assert_eq!(room.cursors.get("ann").map(String::as_str), Some("u1"), "the cursor moves to the newest row handed");
    assert_eq!(room.seen.as_ref().and_then(|seen| seen.get("ann")).map(String::as_str), Some("u1"));
}

#[tokio::test]
async fn with_nothing_new_and_nobody_asking_the_member_passes_without_a_turn() {
    let host = Arc::new(Host::new(&["ann"], vec![user_row("u1", "old")], answered("unused")));
    host.room.lock().unwrap().cursors.insert("ann".into(), "u1".into());
    let (answer, _) = run(&host, &state(), &turn()).await;
    assert_eq!(answer.result, TurnResult::Pass);
    assert!(host.submitted.lock().unwrap().is_empty() && host.posted.lock().unwrap().is_empty());
}

#[tokio::test]
async fn a_member_that_left_or_was_switched_off_takes_no_turn() {
    let left = Arc::new(Host::new(&["bob"], vec![user_row("u1", "hi")], answered("x")));
    left.room.lock().unwrap().cursors.insert("ann".into(), "u0".into());
    let (answer, outcome) = run(&left, &state(), &turn()).await;
    assert_eq!(answer.result, TurnResult::Unavailable);
    assert!(left.submitted.lock().unwrap().is_empty());
    assert!(left.room.lock().unwrap().cursors.get("ann").is_none(), "a left member's cursor goes");
    assert!(outcome.removed.load(Ordering::SeqCst));

    let mut off = Host::new(&["ann"], vec![user_row("u1", "hi")], answered("x"));
    off.switched_off = true;
    let off = Arc::new(off);
    let (answer, _) = run(&off, &state(), &turn()).await;
    assert_eq!(answer.result, TurnResult::Unavailable);
    assert!(off.submitted.lock().unwrap().is_empty());
}

#[tokio::test]
async fn a_stop_leaves_no_trace() {
    let host = Arc::new(Host::new(&["ann"], vec![user_row("u1", "hi")], answered("x")));
    let state = state();
    state.run.set_stopped();
    let (answer, _) = run(&host, &state, &turn()).await;
    assert_eq!(answer.result, TurnResult::Stopped);
    assert!(host.submitted.lock().unwrap().is_empty() && host.posted.lock().unwrap().is_empty());
}

#[tokio::test]
async fn a_pass_reply_posts_a_pass_row_unless_the_user_is_waiting() {
    let host = Arc::new(Host::new(&["ann", "bob"], vec![user_row("u1", "chatter")], answered("(pass)")));
    let called = Turn { addressed: vec!["ann".into()], ..turn() };
    let (answer, _) = run(&host, &state(), &called).await;
    assert_eq!(answer.result, TurnResult::Pass);
    let posted = host.posted.lock().unwrap().clone();
    assert_eq!((posted.len(), posted[0]["kind"].clone(), posted[0]["text"].clone()), (1, json!("pass"), json!("")));
}

#[tokio::test]
async fn a_turn_the_daemon_does_not_accept_becomes_a_held_failure_with_the_reason() {
    let mut refusing = Host::new(&["ann"], vec![user_row("u1", "hi")], answered("x"));
    refusing.accept = false;
    let host = Arc::new(refusing);
    let state = state();
    state.set_waiting(true);
    let (answer, outcome) = run(&host, &state, &turn()).await;
    assert_eq!((answer.result, answer.failed), (TurnResult::Pass, true));
    assert!(outcome.failed.load(Ordering::SeqCst));
    let failures = state.failures();
    assert_eq!((failures[0].name.as_str(), failures[0].reason.as_str()), ("ANN", "the turn was not accepted"));
    assert!(host.logs.lock().unwrap().iter().any(|line| line.contains("could not speak in room room01")));
    assert!(host.posted.lock().unwrap().is_empty(), "a failure is held for the next post, not posted now");
}

#[tokio::test]
async fn a_failed_member_turn_holds_its_detail_and_a_usage_limit_ends_the_exchange_instead() {
    let failing = Arc::new(Host::new(&["ann"], vec![user_row("u1", "hi")], failed_snapshot(json!({ "detail": "boom" }))));
    let state_a = state();
    state_a.set_waiting(true);
    let (answer, _) = run(&failing, &state_a, &turn()).await;
    assert_eq!((answer.result, answer.failed, answer.usage), (TurnResult::Pass, true, None));
    assert_eq!(state_a.failures()[0].reason, "boom");

    let limited = Arc::new(Host::new(&["ann"], vec![user_row("u1", "hi")], failed_snapshot(json!({ "quota": { "provider": "openai", "model": "gpt-x", "resetAt": 9000 } }))));
    let state_b = state();
    state_b.set_waiting(true);
    let (answer, _) = run(&limited, &state_b, &turn()).await;
    let usage = answer.usage.expect("a usage limit");
    assert_eq!((usage.provider.as_str(), usage.model.as_str(), usage.reset_at), ("openai", "gpt-x", Some(9000)));
    assert!(state_b.failures().is_empty(), "the usage limit is said once by the exchange, not held as a failure");
}

#[test]
fn the_calls_one_turn_answers_share_its_id_hop_askers_and_relays() {
    let host = Host::new(&["ann"], Vec::new(), json!({}));
    let (first, _) = RoomCall::new("ann", "c1", 1, "Bob", "", None);
    let (second, _) = RoomCall::new("ann", "c2", 3, "Bob", "", None);
    let (third, _) = RoomCall::new("ann", "c3", 2, "Cy", "", None);
    first.mark_used();
    let combined: TurnCall = combined_call(&host, "ann", &[first.clone(), second, third]);
    assert_eq!(combined.id, "c2", "the first call id not used by an earlier turn");
    assert_eq!(combined.hop, 3);
    assert_eq!(combined.asked_by, "Bob, Cy");
    assert!(!combined.relay_only);

    let (used, _) = RoomCall::new("ann", "u1", 0, "", "", None);
    used.mark_used();
    assert!(combined_call(&host, "ann", &[used]).id.starts_with("rturn_"), "every id used: a fresh one");
    assert_eq!(combined_call(&host, "ann", &[]).id, "");

    let (r1, _) = RoomCall::new("ann", "", 0, "", "result one", None);
    let (r2, _) = RoomCall::new("ann", "", 0, "", "result two", None);
    let relays = combined_call(&host, "ann", &[r1, r2]);
    assert_eq!(relays.relay, "result one\n\nresult two");
    assert!(relays.relay_only);
}

fn waiting_state() -> Arc<TurnState> {
    let state = state();
    state.set_waiting(true);
    state
}

#[tokio::test]
async fn a_newer_message_pending_before_the_turn_submits_cuts_it_short_and_the_rows_come_again() {
    let host = Arc::new(Host::new(&["ann"], vec![user_row("u1", "old question")], answered("too late")));
    let state = waiting_state();
    *state.run.pending() = Some(crate::rooms::calls::Request::default());
    let (answer, _) = run(&host, &state, &turn()).await;
    assert_eq!(answer.result, TurnResult::Superseded);
    assert!(host.submitted.lock().unwrap().is_empty() && host.posted.lock().unwrap().is_empty(), "nothing is submitted or posted for rows a newer message outdates");
    assert_eq!(host.room.lock().unwrap().cursors.get("ann"), None, "the cursor is as it was before the turn took the rows");
    assert_eq!(*host.aborted.lock().unwrap(), ["sess-ann"], "the member's session is aborted");
}

#[tokio::test]
async fn a_newer_message_arriving_while_the_member_answers_posts_nothing_and_keeps_the_rows_seen() {
    let host = Host::new(&["ann"], vec![user_row("u1", "question")], answered("an answer to older rows"));
    let state = waiting_state();
    let run_of = state.run.clone();
    *host.on_submit.lock().unwrap() = Some(Box::new(move |_: &Host| *run_of.pending() = Some(crate::rooms::calls::Request::default())));
    let host = Arc::new(host);
    let (answer, _) = run(&host, &state, &turn()).await;
    assert_eq!(answer.result, TurnResult::Superseded);
    assert_eq!(host.submitted.lock().unwrap().len(), 1, "the turn was submitted");
    assert!(host.posted.lock().unwrap().is_empty(), "its answer is not posted");
    let room = host.room.lock().unwrap();
    assert_eq!(room.cursors.get("ann"), None, "the cursor goes back so the rows are handed again");
    assert_eq!(room.seen.as_ref().and_then(|seen| seen.get("ann")).map(String::as_str), Some("u1"), "the session holds them already: they come again marked as shown");
}

#[tokio::test]
async fn a_member_removed_from_the_room_while_its_turn_runs_posts_nothing_and_loses_its_cursors() {
    let host = Host::new(&["ann", "bob"], vec![user_row("u1", "question")], answered("an answer"));
    *host.on_submit.lock().unwrap() = Some(Box::new(|host: &Host| host.room.lock().unwrap().members.retain(|member| member != "ann")));
    let host = Arc::new(host);
    let (answer, outcome) = run(&host, &waiting_state(), &turn()).await;
    assert_eq!(answer.result, TurnResult::Unavailable);
    assert!(host.posted.lock().unwrap().is_empty());
    let room = host.room.lock().unwrap();
    assert!(room.cursors.get("ann").is_none() && room.seen.as_ref().is_none_or(|seen| !seen.contains_key("ann")));
    assert!(outcome.removed.load(Ordering::SeqCst));
    assert_eq!(*host.aborted.lock().unwrap(), ["sess-ann"]);
}

#[tokio::test]
async fn a_turn_that_only_relays_the_members_own_report_is_marked_system_caused_unless_a_user_row_is_shown() {
    let relay = |host: &Arc<Host>| {
        let (call, _) = RoomCall::relay("ann", "report: build finished", "", 0, None);
        combined_call(host.as_ref(), "ann", &[call])
    };
    let quiet = Arc::new(Host::new(&["ann"], Vec::new(), answered("noted")));
    let dynamic: Arc<dyn MemberHost> = quiet.clone();
    let outcome = Arc::new(Outcome::default());
    let answer = member_turn(&dynamic, &state(), &labels(), "ann", &turn(), Some(&relay(&quiet)), &outcome).await.unwrap();
    assert_eq!(answer.result, TurnResult::Speech);
    let submitted = quiet.submitted.lock().unwrap().clone();
    assert!(submitted[0].1.contains("report: build finished"), "{}", submitted[0].1);
    assert_eq!(submitted[0].2.origin, Some(super::AGENT_REPORT_ORIGIN), "the prompt-cache warmer does not learn from it");

    let with_user = Arc::new(Host::new(&["ann"], vec![user_row("u1", "and a question")], answered("noted")));
    let dynamic: Arc<dyn MemberHost> = with_user.clone();
    let outcome = Arc::new(Outcome::default());
    member_turn(&dynamic, &state(), &labels(), "ann", &turn(), Some(&relay(&with_user)), &outcome).await.unwrap();
    assert_eq!(with_user.submitted.lock().unwrap()[0].2.origin, None, "a user row makes the turn the user's");
}
