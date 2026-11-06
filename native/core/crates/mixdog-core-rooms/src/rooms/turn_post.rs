//! The room host's side of a member's turn (`apps/desktop/src/main/agent-room-turn.ts`): waiting for
//! the member's answer (`pollForAnswer`), posting the failures held (`postFailures`) and posting
//! the member's words (`postSpeech`).

use std::collections::HashMap;
use std::future::Future;
use std::pin::Pin;
use std::sync::Mutex;

use mixdog_js::{json_number, value_to_string};
use serde_json::{Map, Value, json};

use super::config::{MemberName, room_mention_of};
use super::turn_answer::{SessionAnswer, empty_finished_turn, session_final_answer, tool_summaries};
use super::turn_host::{MemberLabel, RoomRecord, RoomTurnHost, TurnState};

#[cfg(test)]
mod tests;

/// How a turn was halted while it waited (`HaltOutcome`).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum HaltOutcome {
    Stopped,
    Unavailable,
    Superseded,
}

/// What the wait for a member's answer ended with.
#[derive(Debug, PartialEq)]
pub enum Polled {
    Answered { answer: SessionAnswer, snapshot: Value },
    Halted(HaltOutcome),
}

/// `halted()`: `None` while the turn may go on, else the halt's outcome, whose effects (a left
/// member, a cut-short turn) are already under way when it is returned.
pub type Halted<'a> = &'a (dyn Fn() -> Option<HaltFuture> + Send + Sync);

pub type HaltFuture = Pin<Box<dyn Future<Output = HaltOutcome> + Send>>;

/// The reads in a row that may fail before the wait ends with the error.
const MISSES: u32 = 6;

/// `String(approval?.id ?? '')`.
fn approval_id(approval: Option<&Value>) -> String {
    match approval.and_then(|approval| approval.get("id")) {
        None | Some(Value::Null) => String::new(),
        Some(id) => value_to_string(id),
    }
}

/// `pollForAnswer`: reads the member's session until it has answered. `Err`: the error of the sixth
/// failed read in a row.
pub async fn poll_for_answer(host: &dyn RoomTurnHost, state: &TurnState, session_id: &str, started_at: f64, halted: Halted<'_>) -> Result<Polled, String> {
    let mut misses = 0;
    loop {
        if let Some(halt) = halted() {
            return Ok(Polled::Halted(halt.await));
        }
        host.sleep(host.poll_ms()).await;
        let snapshot = match host.read_snapshot(session_id).await {
            Ok(snapshot) => {
                misses = 0;
                snapshot
            }
            Err(error) => {
                misses += 1;
                if misses >= MISSES {
                    return Err(error);
                }
                continue;
            }
        };
        if state.stop() {
            return Ok(Polled::Halted(HaltOutcome::Stopped));
        }
        let approval = snapshot.get("toolApproval").filter(|approval| !approval.is_null()).cloned();
        if approval_id(approval.as_ref()) != approval_id(state.approval().as_ref()) {
            state.set_approval(approval);
            host.republish();
        }
        let started = json!(started_at);
        if let Some(answer) = session_final_answer(&snapshot, &started).or_else(|| empty_finished_turn(&snapshot, &started)) {
            return Ok(Polled::Answered { answer, snapshot });
        }
    }
}

/// `postFailures`: the held failures as one failed-pass row naming every member and each distinct
/// reason; nothing is posted when none is held.
pub async fn post_failures(host: &dyn RoomTurnHost, state: &TurnState) -> Result<(), String> {
    let failures = state.take_failures();
    let Some(first) = failures.first() else { return Ok(()) };
    let mut names: Vec<&str> = Vec::new();
    let mut reasons: Vec<&str> = Vec::new();
    for failure in &failures {
        if !names.contains(&failure.name.as_str()) {
            names.push(&failure.name);
        }
        if !failure.reason.is_empty() && !reasons.contains(&failure.reason.as_str()) {
            reasons.push(&failure.reason);
        }
    }
    let id = format!("row_{}", host.new_id());
    let row = json!({
        "id": id,
        "kind": "pass",
        "speaker": first.id,
        "name": names[0],
        "names": names,
        "at": host.now(),
        "text": "",
        "failed": true,
        "reason": reasons,
    });
    host.post(vec![row]).await
}

/// The label of `id` in the room, or the id as its own name.
fn label_of(labels: &HashMap<String, MemberLabel>, id: &str) -> MemberName {
    MemberName { id: id.to_owned(), name: labels.get(id).map_or_else(|| id.to_owned(), |label| label.name.clone()) }
}

/// What `post_speech` posts: the answer `text` of `member` (`agent_id`) to the turn that began at
/// `started_at`, with the `snapshot` it came from.
#[derive(Clone, Copy)]
pub struct Speech<'a> {
    pub agent_id: &'a str,
    pub member: &'a MemberLabel,
    pub text: &'a str,
    pub snapshot: &'a Value,
    pub started_at: f64,
}

/// `postSpeech`: the member's answer `text` as a speech row in the room's log, with the files and
/// tools of the turn that began at `started_at`. Returns the one peer the speech addresses.
pub async fn post_speech(host: &dyn RoomTurnHost, state: &TurnState, room: &Mutex<RoomRecord>, labels: &HashMap<String, MemberLabel>, speech: &Speech<'_>) -> Result<Option<String>, String> {
    let Speech { agent_id, member, text, snapshot, started_at } = *speech;
    let id = format!("row_{}", host.new_id());
    let at = host.now();
    let mut row = Map::new();
    row.insert("id".into(), json!(id));
    row.insert("kind".into(), json!("speech"));
    row.insert("speaker".into(), json!(agent_id));
    row.insert("name".into(), json!(member.name));
    row.insert("at".into(), json!(at));
    row.insert("text".into(), json!(text));
    // The log takes in the files this turn produced (agent-room-delivery.mjs).
    let session = state.member_session();
    if !session.is_empty() {
        row.insert("artifactsFrom".into(), json!({ "sessionId": session, "since": json_number(started_at) }));
    }
    // The one peer the speech addresses: shown on its bubble, and a turn for that peer, never authority.
    let members: Vec<MemberName> = room.lock().unwrap_or_else(|poisoned| poisoned.into_inner()).members.iter().map(|id| label_of(labels, id)).collect();
    let mention = room_mention_of(text, &members, agent_id);
    if let Some(mention) = &mention {
        row.insert("to".into(), json!([mention]));
        row.insert("toName".into(), json!([label_of(labels, mention).name]));
    }
    let tools = tool_summaries(snapshot, started_at);
    if !tools.is_empty() {
        row.insert("tools".into(), Value::Array(tools.into_iter().map(|(name, summary)| json!({ "name": name, "summary": summary })).collect()));
    }
    post_failures(host, state).await?;
    host.post(vec![Value::Object(row)]).await?;
    state.set_waiting(false);
    // The cursor stays on the last row this turn was handed: a message that landed while the member
    // spoke sits after it and reaches the next turn.
    let mut room = room.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    room.last_speaker = Some(agent_id.to_owned());
    room.last_at = Some(at);
    Ok(mention)
}
