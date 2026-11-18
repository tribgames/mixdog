//! What a member's turn in a room needs from the room host, and the state of the exchange it runs in
//! (`RunState`, `RoomTurnHost`, `MemberLabel` of `apps/desktop/src/main/agent-room-turn.ts`).

use std::collections::HashMap;
use std::sync::{Arc, Mutex, MutexGuard};

use async_trait::async_trait;
use serde_json::Value;

use super::calls::Run;

/// What a member's turn asks of the room host, bound to one room. Rows are the room log's JSON rows.
#[async_trait]
pub trait RoomTurnHost: Send + Sync {
    fn room_id(&self) -> &str;
    /// How long the wait for an answer sleeps between two reads of the member's session.
    fn poll_ms(&self) -> u64;
    fn now(&self) -> i64;
    fn new_id(&self) -> String;
    /// Publishes the room's activity again, as the exchange's state holds it when the publication runs. The publication is
    /// serialized with the room's row posts, so an older call never shows an activity a later one retired.
    fn republish(&self);
    fn log(&self, line: &str);
    async fn sleep(&self, ms: u64);
    async fn post(&self, rows: Vec<Value>) -> Result<(), String>;
    /// `state`'s speaker's turn ends with no row (cut short, stopped, left, a reaction only, failed): the speaker is retired and the
    /// room's activity published. A host that publishes nothing only retires it.
    fn retire_turn(&self, state: &TurnState) {
        state.end_turn();
    }
    /// Posts `rows` that end `state`'s speaker's turn: the rows and the speaker's retirement are one update of the room (the
    /// default, for hosts that publish nothing, retires and posts).
    async fn post_ending_turn(&self, rows: Vec<Value>, state: &TurnState) -> Result<(), String> {
        state.end_turn();
        self.post(rows).await
    }
    /// The member's session as the session service shows it (`SessionSnapshot`).
    async fn read_snapshot(&self, session_id: &str) -> Result<Value, String>;
}

/// A member as the room names it.
#[derive(Clone, Debug, PartialEq)]
pub struct MemberLabel {
    pub id: String,
    pub name: String,
    pub route: Value,
    pub description: String,
    /// Switched off: still a member, never a new speaker.
    pub disabled: bool,
}

/// The room's record as far as a turn reads and writes it (`AgentRoomRecord`).
#[derive(Clone, Debug, Default, PartialEq)]
pub struct RoomRecord {
    pub name: String,
    pub members: Vec<String>,
    /// The last row id each member was handed.
    pub cursors: HashMap<String, String>,
    pub seen: Option<HashMap<String, String>>,
    pub share_tools: bool,
    pub last_speaker: Option<String>,
    pub last_at: Option<i64>,
}

/// A turn that failed and is not shown yet: a run of them posts as one row (`postFailures`).
#[derive(Clone, Debug, PartialEq)]
pub struct Failure {
    pub id: String,
    pub name: String,
    pub reason: String,
}

#[derive(Default)]
struct Inner {
    speaking: String,
    speaking_name: String,
    typing_id: String,
    /// The member in `speaking` is typing now. `speaking` itself stays what Node's state holds (the last speaker, which the
    /// usage-limit row names); the room's activity is this flag.
    typing: bool,
    member_session: String,
    approval: Option<Value>,
    waiting: bool,
    failures: Vec<Failure>,
}

/// What the room is doing while its exchange runs: a member types, or nobody does and the supervisor (or the next
/// scheduled turn) is choosing who speaks next. An exchange that has begun is always one or the other.
#[derive(Clone, Debug, PartialEq)]
pub enum Activity {
    Typing { speaker: String, name: String, typing_id: String },
    Deciding,
}

/// The exchange of one room in flight (`RunState`): `stop` and the pending request are the
/// scheduler's, in `run`; the rest is the turn's.
pub struct TurnState {
    pub run: Arc<Run>,
    inner: Mutex<Inner>,
}

impl TurnState {
    pub fn new(run: Arc<Run>) -> Self {
        Self { run, inner: Mutex::default() }
    }

    fn inner(&self) -> MutexGuard<'_, Inner> {
        self.inner.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    pub fn stop(&self) -> bool {
        self.run.stopped()
    }

    pub fn approval(&self) -> Option<Value> {
        self.inner().approval.clone()
    }

    pub fn set_approval(&self, approval: Option<Value>) {
        self.inner().approval = approval;
    }

    pub fn member_session(&self) -> String {
        self.inner().member_session.clone()
    }

    pub fn set_member_session(&self, session: &str) {
        self.inner().member_session = session.to_owned();
    }

    /// The user's newest message has no answer from this exchange yet.
    pub fn waiting(&self) -> bool {
        self.inner().waiting
    }

    pub fn set_waiting(&self, waiting: bool) {
        self.inner().waiting = waiting;
    }

    /// `Object.assign(state, { speaking, speakingName, typingId, memberSession: '', approval: null })`.
    pub fn start_speaking(&self, agent_id: &str, name: &str, typing_id: String) {
        let mut inner = self.inner();
        inner.speaking = agent_id.to_owned();
        inner.speaking_name = name.to_owned();
        inner.typing_id = typing_id;
        inner.typing = true;
        inner.member_session.clear();
        inner.approval = None;
    }

    /// The speaker's turn is over (its words or pass are posted, or it was cut short): the room is deciding who is next. The
    /// runner calls this inside the room's one publication (`RoomTurnHost::post_ending_turn`), or explicitly when the turn
    /// leaves no row.
    pub fn end_turn(&self) {
        self.inner().typing = false;
    }

    /// Nobody is typing: `Object.assign(state, { speaking: '', speakingName: '', memberSession: '' })`.
    pub fn stop_speaking(&self) {
        let mut inner = self.inner();
        inner.speaking.clear();
        inner.speaking_name.clear();
        inner.typing = false;
        inner.member_session.clear();
    }

    /// What the room shows now.
    pub fn activity(&self) -> Activity {
        let inner = self.inner();
        if inner.typing && !inner.speaking.is_empty() {
            Activity::Typing { speaker: inner.speaking.clone(), name: inner.speaking_name.clone(), typing_id: inner.typing_id.clone() }
        } else {
            Activity::Deciding
        }
    }

    pub fn speaking(&self) -> (String, String, String) {
        let inner = self.inner();
        (inner.speaking.clone(), inner.speaking_name.clone(), inner.typing_id.clone())
    }

    pub fn push_failure(&self, failure: Failure) {
        self.inner().failures.push(failure);
    }

    /// `state.failures.splice(0)`.
    pub fn take_failures(&self) -> Vec<Failure> {
        std::mem::take(&mut self.inner().failures)
    }

    pub fn failures(&self) -> Vec<Failure> {
        self.inner().failures.clone()
    }
}
