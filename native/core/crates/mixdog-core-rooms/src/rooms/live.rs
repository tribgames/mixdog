//! The room host of the daemon: what a room's exchange needs from the log, the members' sessions
//! and the agent catalog (`createAgentRooms` of `agent-rooms.ts` with `agent-room-log.ts` and
//! `agent-room-records.ts`). `LiveRooms` keeps each room's record in memory while the room is in
//! use, as Node's records do: a turn changes the live record and `persist` saves what the turn owns
//! (`Rooms::save_turn`); a change the room service saves (members, name, limits) is read back into
//! it. It serves the exchange as [`RoomHosts`] and the continue request's log read as
//! [`RoomRowsSource`].

use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Mutex, MutexGuard, OnceLock};

use async_trait::async_trait;
use mixdog_core_base::rooms::ids::MIXY_AGENT_ID;
use mixdog_core_base::rooms::ids::room_id_of_session;
use mixdog_core_base::rooms::ids::room_member_session_id;
use mixdog_core_base::rooms::ids::room_session_id;
use mixdog_rt::SerialChain;
use rand::Rng;
use serde_json::{Map, Value, json};

use super::RoomError;
use super::exchange::{Action, Decision};
use super::exchange_run::{RoomExchangeHost, RoomHosts, SupervisorStep};
use super::maintainer::{Maintained, Maintainer};
use super::member_turn::{MemberHost, PersistFuture, SubmitOptions};
use super::records::{RoomDoc, RoomRecord as Stored, RoomStore, Rooms, Running, TurnFields};
use super::row_message::{normalize_room_row, room_row_message};
use super::runner::RoomRowsSource;
use super::service::{new_room_id, route_params};
use super::sessions::{AgentCatalog, SessionOps};
use super::turn_post::approval_id;
use super::supervisor::{SupervisorInput, parse_room_decision, supervisor_prompt};
use super::turn_host::{MemberLabel, RoomRecord, RoomTurnHost, TurnState};
use super::turn_prompt::RoomPrompt;

/// The rows this host posted that are kept per room (`RECENT_ROWS`).
const RECENT_ROWS: usize = 200;
/// How long the wait for an answer sleeps between two reads of the member's session.
const POLL_MS: u64 = 500;
const PREVIEW_CAP: usize = 200;

/// The daemon calls a room makes (`AgentRoomDeps`): the log's rows and the members' sessions.
#[async_trait]
pub trait RoomDaemon: Send + Sync {
    /// Appends stored room messages (`roomRowMessage`) to a log session, those it holds skipped.
    async fn append_rows(&self, session_id: &str, messages: Vec<Value>) -> Result<(), String>;
    /// The room rows of a log session in log order (`roomRowsOfItems` of `readItems`).
    async fn room_rows(&self, session_id: &str) -> Result<Vec<Value>, String>;
    /// A member's turn; false when the daemon did not accept it.
    async fn submit(&self, session_id: &str, prompt: &RoomPrompt, options: &SubmitOptions) -> Result<bool, String>;
    /// The member's session as the turn wait reads it, with the `toolApproval` it shows
    /// (`agent-room-turn.ts:270`, `:278`).
    async fn read_snapshot(&self, session_id: &str) -> Result<Value, String>;
    async fn abort(&self, session_id: &str) -> Result<(), String>;
    fn republish_catalog(&self);
}

/// What a room's running exchange lays over its log for the views: `decorateRoomSnapshot`'s
/// `state` (`speaking`, `speakingName`, `typingId`, `approval`; `agent-room-views.ts:63-91`).
#[derive(Clone, Debug, Default, PartialEq)]
pub struct ExchangeView {
    pub speaking: String,
    pub speaking_name: String,
    pub typing_id: String,
    /// The speaking member's `toolApproval`, as its snapshot showed it.
    pub approval: Option<Value>,
}

/// A client's answer to a request the room shows (the core's server-request decision; the
/// approval or question is `request`). Named apart from the supervisor's [`Decision`].
pub type ApprovalAnswer = mixdog_core_api::thread::Decision;

/// The approval calls a room makes for its members, and the publish that shows their approvals
/// (`AgentRoomDeps`, `agent-rooms.ts:95-134`).
#[async_trait]
pub trait RoomApprovals: Send + Sync {
    /// `deps.approve(memberSession, approvalId, decision)` (`agent-rooms.ts:115`, called from
    /// `agent-room-scheduler.ts:284`): the answer to the approval `session_id` shows, the
    /// approval being `answer.request`. False when the member does not show that approval.
    async fn approve(&self, session_id: &str, answer: ApprovalAnswer) -> Result<bool, String>;
    /// `deps.approve(asked.memberSessionId, approvalId, decision)` for a handed-off question
    /// (`agent-rooms.ts:443`): answered through the member's own copy, which hands the answer to
    /// the asking session. False when the member holds no such copy (answered elsewhere first).
    async fn answer_question(&self, member_session: &str, answer: ApprovalAnswer) -> Result<bool, String>;
    /// The handed-off questions of `room_id`'s members (`roomHandoffQuestionsOf`,
    /// `agent-room-views.ts:28-56`): each member session's `handoffQuestions`, every question with
    /// an id tagged with `roomMember` (the member) and `memberSessionId` (its session).
    fn member_questions(&self, room_id: &str, members: &[String]) -> Vec<Value>;
    /// `deps.republish(roomSessionId)` (`agent-rooms.ts:124-125`): the room log published again
    /// through `decorate` (`agent-rooms.ts:453-456`): the running exchange's `view` (`None` when
    /// none runs) and the members' handed-off questions.
    fn publish_view(&self, room_session_id: &str, view: Option<ExchangeView>, questions: Vec<Value>);
}

/// The members as the room names them (`memberLabels`): display name, route, description and
/// whether the bot is switched off.
#[async_trait]
pub trait RoomLabels: Send + Sync {
    async fn labels(&self, members: &[String]) -> Result<HashMap<String, MemberLabel>, String>;
}

/// A row's files taken in (`storedRow`, `speechWithArtifacts` of `agent-room-delivery.mjs`): the
/// row comes back with its stored `parts` / `attachments` / `images`, and a row with nothing to
/// take in comes back as it is.
#[async_trait]
pub trait RoomFiles: Send + Sync {
    async fn take_in(&self, room_id: &str, row: Value) -> Result<Value, String>;
}

/// `plainPreviewText(text).slice(0, 200)`.
pub type Preview = Arc<dyn Fn(&str) -> String + Send + Sync>;
pub type LogLine = Arc<dyn Fn(&str) + Send + Sync>;
/// Ends the calls held back for a room failed: `dropRelays(roomId, { status: 'failed', error })`.
pub type FailRelays = Arc<dyn Fn(&str, &str) + Send + Sync>;

pub struct RoomPorts {
    pub daemon: Arc<dyn RoomDaemon>,
    pub approvals: Arc<dyn RoomApprovals>,
    pub labels: Arc<dyn RoomLabels>,
    pub files: Arc<dyn RoomFiles>,
    pub sessions: Arc<dyn SessionOps>,
    pub catalog: Arc<dyn AgentCatalog>,
    pub maintainer: Arc<dyn Maintainer>,
    pub preview: Preview,
    pub log: LogLine,
}

/// The save of a running room's own fields.
#[async_trait]
trait TurnSaves: Send + Sync {
    async fn save(&self, room_id: &str, fields: TurnFields) -> Result<(), RoomError>;
}

#[async_trait]
impl<S: RoomStore + 'static> TurnSaves for Rooms<S> {
    async fn save(&self, room_id: &str, fields: TurnFields) -> Result<(), RoomError> {
        self.save_turn(room_id, &fields).await
    }
}

/// What a room keeps beside the record a turn reads.
struct Extra {
    max_rounds: u32,
    max_messages: u32,
    running: Option<Running>,
    owed: Option<Vec<String>>,
    last_preview: Option<String>,
}

struct Live {
    record: Arc<Mutex<RoomRecord>>,
    extra: Mutex<Extra>,
    tracked: Mutex<Option<Arc<TurnState>>>,
    /// Rows this host posted, in log order.
    recent: Mutex<Vec<Value>>,
    /// Handed-off questions answered through the room: their cards leave at once, before the
    /// member's own list confirms it (`agent-rooms.ts:444-449`).
    answered: Mutex<HashSet<String>>,
}

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

impl Live {
    fn of(stored: &Stored) -> Self {
        let seen = (!stored.seen.is_empty()).then(|| stored.seen.clone());
        Self {
            record: Arc::new(Mutex::new(RoomRecord {
                name: stored.config.name.clone(),
                members: stored.config.members.clone(),
                cursors: stored.cursors.clone(),
                seen,
                share_tools: stored.config.share_tools,
                last_speaker: stored.last_speaker.clone(),
                last_at: stored.last_at,
            })),
            extra: Mutex::new(Extra {
                max_rounds: stored.config.max_rounds,
                max_messages: stored.config.max_messages,
                running: stored.running,
                owed: stored.owed.clone(),
                last_preview: stored.last_preview.clone(),
            }),
            tracked: Mutex::new(None),
            recent: Mutex::new(Vec::new()),
            answered: Mutex::new(HashSet::new()),
        }
    }

    /// What the room service saved: members, name and limits, and what was kept for members that
    /// left. The members array stays the same array (an exchange in flight holds it as its roster).
    fn follow(&self, stored: &Stored) {
        let mut record = lock(&self.record);
        record.name = stored.config.name.clone();
        record.members.clear();
        record.members.extend(stored.config.members.iter().cloned());
        record.share_tools = stored.config.share_tools;
        let members = &stored.config.members;
        record.cursors.retain(|id, _| members.contains(id));
        if let Some(seen) = record.seen.as_mut() {
            seen.retain(|id, _| members.contains(id));
        }
        let mut extra = lock(&self.extra);
        extra.max_rounds = stored.config.max_rounds;
        extra.max_messages = stored.config.max_messages;
        if let Some(owed) = extra.owed.as_mut() {
            owed.retain(|id| members.contains(id));
        }
    }

    fn fields(&self) -> TurnFields {
        let record = lock(&self.record);
        let extra = lock(&self.extra);
        TurnFields {
            cursors: record.cursors.clone(),
            seen: record.seen.clone().unwrap_or_default(),
            last_speaker: record.last_speaker.clone(),
            last_at: record.last_at,
            last_preview: extra.last_preview.clone(),
            running: extra.running,
            owed: extra.owed.clone(),
        }
    }
}

struct Shared {
    ports: RoomPorts,
    saves: Arc<dyn TurnSaves>,
    live: Mutex<HashMap<String, Arc<Live>>>,
    /// The one writer of member sessions (`ensureMemberSession` runs in the room writes' queue).
    writer: Arc<SerialChain>,
    relays: OnceLock<FailRelays>,
}

pub struct LiveRooms {
    shared: Arc<Shared>,
}

impl LiveRooms {
    pub fn new<S: RoomStore + 'static>(rooms: Arc<Rooms<S>>, ports: RoomPorts) -> Arc<Self> {
        let shared = Arc::new(Shared {
            ports,
            saves: rooms.clone(),
            live: Mutex::new(HashMap::new()),
            writer: SerialChain::new(),
            relays: OnceLock::new(),
        });
        let follower = Arc::downgrade(&shared);
        rooms.on_change(Arc::new(move |doc: &RoomDoc| {
            if let Some(shared) = follower.upgrade() {
                shared.follow(doc);
            }
        }));
        Arc::new(Self { shared })
    }

    /// `rooms.approve(sessionId, approvalId, decision)` (`agent-rooms.ts:439-451`): a request the
    /// room log `room_session_id` shows, the request being `answer.request`.
    /// - **A handed-off question** of a member: answered through that member's own copy, whether
    ///   or not it speaks now. Its card leaves at once, and the room is published again.
    /// - **Any other request** is the speaking member's approval (`scheduler.approve`,
    ///   `agent-room-scheduler.ts:280-288`). False when no exchange runs, nobody speaks or the room
    ///   shows another approval. Answered, the room stops showing it and is published again.
    pub async fn approve(&self, room_session_id: &str, answer: ApprovalAnswer) -> Result<bool, String> {
        let Some(room_id) = room_id_of_session(room_session_id) else { return Ok(false) };
        let Some(live) = lock(&self.shared.live).get(&room_id).cloned() else { return Ok(false) };
        let view = View { shared: self.shared.clone(), live: live.clone(), room_id };
        let asked = view.questions().into_iter().find(|question| question.get("id").and_then(Value::as_str) == Some(answer.request.as_str()));
        if let Some(asked) = asked {
            let member = asked.get("memberSessionId").and_then(Value::as_str).unwrap_or_default().to_owned();
            let id = answer.request.0.clone();
            let accepted = self.shared.ports.approvals.answer_question(&member, answer).await?;
            lock(&live.answered).insert(id);
            view.republish();
            return Ok(accepted);
        }
        let Some(state) = lock(&live.tracked).clone() else { return Ok(false) };
        let member = state.member_session();
        if member.is_empty() || approval_id(state.approval().as_ref()) != answer.request.0 {
            return Ok(false);
        }
        let accepted = self.shared.ports.approvals.approve(&member, answer).await?;
        state.set_approval(None);
        view.republish();
        Ok(accepted)
    }

    /// The speaking member's approval `resolved` resolved in its own thread: answered by a
    /// client on the room log, which receives a member's requests (P §8.3, §8.4), or anywhere
    /// else. The room stops showing it and is published again, as `scheduler.approve` does after
    /// its answer (`agent-room-scheduler.ts:285-286`). Another id, or no exchange, changes nothing.
    pub fn member_resolved(&self, room_id: &str, resolved: &str) {
        let Some(live) = lock(&self.shared.live).get(room_id).cloned() else { return };
        let Some(state) = lock(&live.tracked).clone() else { return };
        if approval_id(state.approval().as_ref()) != resolved {
            return;
        }
        state.set_approval(None);
        View { shared: self.shared.clone(), live, room_id: room_id.to_owned() }.republish();
    }

    /// `noteMemberRows` for one room (`agent-rooms.ts:424-433`): its members' handed-off questions
    /// changed, so the room is published again. A room not hosted (or not bound yet) has nothing to
    /// show.
    pub fn republish_room(&self, room_id: &str) {
        let Some(live) = lock(&self.shared.live).get(room_id).cloned() else { return };
        View { shared: self.shared.clone(), live, room_id: room_id.to_owned() }.republish();
    }

    /// Hands the scheduler's relay queue to the rooms (`failRelays`). Until then no room is hosted.
    pub fn bind_relays(&self, fail: FailRelays) {
        let _ = self.shared.relays.set(fail);
    }

    /// Start-up (`recover`): [`Self::host_loaded`], then [`Self::recover`]. The rooms to republish.
    pub async fn start<S: RoomStore + 'static>(&self, rooms: &Rooms<S>) -> Result<Vec<String>, RoomError> {
        self.host_loaded(rooms).await?;
        self.recover(rooms).await
    }

    /// The rooms loaded are hosted (part of the rooms' first load, `ready`).
    pub async fn host_loaded<S: RoomStore + 'static>(&self, rooms: &Rooms<S>) -> Result<(), RoomError> {
        let doc: RoomDoc = rooms.list().await?.into_iter().map(|room| (room.id.clone(), room)).collect();
        self.shared.follow(&doc);
        Ok(())
    }

    /// `recover` after `ready` (`agent-rooms.ts:470-479`): an exchange a restart cut off is marked interrupted, its members are
    /// stopped, and nothing resumes on its own; the catalog is republished. The rooms to republish.
    pub async fn recover<S: RoomStore + 'static>(&self, rooms: &Rooms<S>) -> Result<Vec<String>, RoomError> {
        let cut = rooms.recover().await?;
        for room in &cut {
            let Some(live) = lock(&self.shared.live).get(&room.id).cloned() else { continue };
            lock(&live.extra).running = None;
            for member in &room.config.members {
                if let Some(session) = room_member_session_id(&room.id, member) {
                    let _ = self.shared.ports.daemon.abort(&session).await;
                }
            }
            let view = View { shared: self.shared.clone(), live, room_id: room.id.clone() };
            let notice = json!({ "id": format!("row_{}", view.new_id()), "kind": "interrupted", "at": view.now(), "text": "" });
            if let Err(error) = view.post(vec![notice]).await {
                view.log(&format!("room {} interrupted notice: {error}", room.id));
            }
        }
        self.shared.ports.daemon.republish_catalog();
        Ok(cut.into_iter().map(|room| room.id).collect())
    }
}

impl Shared {
    /// The records as saved: rooms that appeared are hosted, the others follow, those gone leave.
    fn follow(&self, doc: &RoomDoc) {
        let mut live = lock(&self.live);
        live.retain(|id, _| doc.contains_key(id));
        for (id, stored) in doc {
            match live.get(id) {
                Some(room) => room.follow(stored),
                None => {
                    live.insert(id.clone(), Arc::new(Live::of(stored)));
                }
            }
        }
    }
}

impl RoomHosts for LiveRooms {
    fn host(&self, room_id: &str) -> Option<Arc<dyn RoomExchangeHost>> {
        self.shared.relays.get()?;
        let live = lock(&self.shared.live).get(room_id).cloned()?;
        Some(Arc::new(View { shared: self.shared.clone(), live, room_id: room_id.to_owned() }))
    }
}

impl super::room_ask::AskRooms for LiveRooms {
    fn room(&self, room_id: &str) -> Result<Arc<dyn super::room_ask::AskRoom>, String> {
        let live = lock(&self.shared.live).get(room_id).cloned().ok_or_else(|| "This room no longer exists.".to_owned())?;
        Ok(Arc::new(View { shared: self.shared.clone(), live, room_id: room_id.to_owned() }))
    }
}

#[async_trait]
impl super::room_ask::AskRoom for View {
    fn name(&self) -> String {
        lock(&self.live.record).name.clone()
    }

    fn members(&self) -> Vec<String> {
        View::members(self)
    }

    async fn labels(&self) -> Result<HashMap<String, MemberLabel>, String> {
        RoomExchangeHost::labels(self).await
    }

    /// `names.get(agentId)`: the name the agent catalog gives it.
    async fn display_name(&self, agent_id: &str) -> Option<String> {
        self.shared.ports.labels.labels(&[agent_id.to_owned()]).await.ok()?.remove(agent_id).map(|label| label.name)
    }

    async fn member_session(&self, member: &MemberLabel) -> Result<String, String> {
        MemberHost::member_session(self, member).await
    }

    async fn post(&self, rows: Vec<Value>) -> Result<(), String> {
        RoomTurnHost::post(self, rows).await
    }

    fn set_last_at(&self, at: i64) {
        lock(&self.live.record).last_at = Some(at);
    }

    async fn persist(&self) -> Result<(), String> {
        MemberHost::persist(self).await
    }

    fn republish_catalog(&self) {
        RoomExchangeHost::republish_catalog(self);
    }

    fn now(&self) -> i64 {
        RoomTurnHost::now(self)
    }

    fn new_id(&self) -> String {
        RoomTurnHost::new_id(self)
    }
}

#[async_trait]
impl RoomRowsSource for LiveRooms {
    async fn rows(&self, room_id: &str) -> Result<Vec<Value>, String> {
        let live = lock(&self.shared.live).get(room_id).cloned().ok_or_else(|| "This room no longer exists.".to_owned())?;
        View { shared: self.shared.clone(), live, room_id: room_id.to_owned() }.rows().await
    }
}

/// One room as its exchange and its turns see it.
struct View {
    shared: Arc<Shared>,
    live: Arc<Live>,
    room_id: String,
}

fn id_of(row: &Value) -> &str {
    row.get("id").and_then(Value::as_str).unwrap_or("")
}

/// `inLogOrder(read, posted)`: one list in log order from the log's tail window (`read`, the
/// authority) and the rows this host posted (`posted`, a subsequence of the log). A posted row the
/// read lacks sits before the window when a later posted row is in it, and after it otherwise; with
/// no posted row in the window, time decides which side the posted rows go.
fn in_log_order(read: Vec<Value>, posted: &[Value]) -> Vec<Value> {
    let at: HashMap<String, usize> = read.iter().enumerate().map(|(index, row)| (id_of(row).to_owned(), index)).collect();
    let mut older: Vec<Value> = Vec::new();
    let mut before: HashMap<usize, Vec<Value>> = HashMap::new();
    let mut pending: Vec<Value> = Vec::new();
    let mut shared = false;
    for row in posted {
        let Some(&index) = at.get(id_of(row)) else {
            pending.push(row.clone());
            continue;
        };
        if shared {
            before.insert(index, std::mem::take(&mut pending));
        } else {
            older.append(&mut pending);
        }
        shared = true;
    }
    if !shared {
        let opens = read.last().and_then(|row| row.get("at")).and_then(Value::as_f64);
        let first = posted.first().and_then(|row| row.get("at")).and_then(Value::as_f64);
        let newer = read.is_empty() || !matches!((first, opens), (Some(first), Some(opens)) if first <= opens);
        let mut out = Vec::new();
        if newer {
            out.extend(read);
            out.extend(posted.iter().cloned());
        } else {
            out.extend(posted.iter().cloned());
            out.extend(read);
        }
        return out;
    }
    let mut out = older;
    for (index, row) in read.into_iter().enumerate() {
        out.extend(before.remove(&index).unwrap_or_default());
        out.push(row);
    }
    out.extend(pending);
    out
}

impl View {
    fn session_id(&self) -> String {
        room_session_id(&self.room_id).expect("a hosted room has a valid id")
    }

    fn members(&self) -> Vec<String> {
        lock(&self.live.record).members.clone()
    }

    /// `memberQuestions.get(roomId)`: the members' handed-off questions, less those answered
    /// through the room. An answered id is forgotten once the member's list no longer has it.
    fn questions(&self) -> Vec<Value> {
        let listed = self.shared.ports.approvals.member_questions(&self.room_id, &self.members());
        let id = |question: &Value| question.get("id").and_then(Value::as_str).unwrap_or_default().to_owned();
        let mut answered = lock(&self.live.answered);
        answered.retain(|gone| listed.iter().any(|question| id(question) == *gone));
        listed.into_iter().filter(|question| !answered.contains(&id(question))).collect()
    }
}

#[async_trait]
impl RoomTurnHost for View {
    fn room_id(&self) -> &str {
        &self.room_id
    }

    fn poll_ms(&self) -> u64 {
        POLL_MS
    }

    fn now(&self) -> i64 {
        chrono::Utc::now().timestamp_millis()
    }

    fn new_id(&self) -> String {
        new_room_id(self.now())
    }

    /// `deps.republish(roomSessionId)` through `decorate`: the log with what the running exchange
    /// shows (`scheduler.state(roomId)`, the tracked state; nothing when none runs) and its
    /// members' handed-off questions.
    fn republish(&self) {
        let view = lock(&self.live.tracked).as_ref().map(|state| {
            let (speaking, speaking_name, typing_id) = state.speaking();
            ExchangeView { speaking, speaking_name, typing_id, approval: state.approval() }
        });
        self.shared.ports.approvals.publish_view(&self.session_id(), view, self.questions());
    }

    fn log(&self, line: &str) {
        (self.shared.ports.log)(line);
    }

    async fn sleep(&self, ms: u64) {
        tokio::time::sleep(std::time::Duration::from_millis(ms)).await;
    }

    /// `roomLog.post`: the rows' files taken in, each row stored in its canonical shape, and the
    /// list preview following the last spoken line.
    async fn post(&self, rows: Vec<Value>) -> Result<(), String> {
        let ports = &self.shared.ports;
        let mut kept = Vec::with_capacity(rows.len());
        for row in &rows {
            kept.push(normalize_room_row(&ports.files.take_in(&self.room_id, row.clone()).await?)?);
        }
        let now = self.now();
        let messages = kept.iter().map(|row| room_row_message(row, now)).collect::<Result<Vec<_>, _>>()?;
        ports.daemon.append_rows(&self.session_id(), messages).await?;
        {
            let mut recent = lock(&self.live.recent);
            recent.extend(kept);
            let excess = recent.len().saturating_sub(RECENT_ROWS);
            recent.drain(..excess);
        }
        let said = rows.iter().rev().find(|row| matches!(row.get("kind").and_then(Value::as_str), Some("user" | "speech")));
        if let Some(said) = said {
            let words = said.get("text").and_then(Value::as_str).unwrap_or("");
            lock(&self.live.extra).last_preview = Some(mixdog_js::slice_utf16(&(ports.preview)(words), PREVIEW_CAP));
            ports.daemon.republish_catalog();
        }
        Ok(())
    }

    async fn read_snapshot(&self, session_id: &str) -> Result<Value, String> {
        self.shared.ports.daemon.read_snapshot(session_id).await
    }
}

#[async_trait]
impl MemberHost for View {
    fn room(&self) -> Result<Arc<Mutex<RoomRecord>>, String> {
        if !self.exists() {
            return Err("This room no longer exists.".into());
        }
        Ok(self.live.record.clone())
    }

    /// `roomLog.rows`: the log read, with the rows this host posted that it has not caught up with.
    async fn rows(&self) -> Result<Vec<Value>, String> {
        let read = self.shared.ports.daemon.room_rows(&self.session_id()).await.unwrap_or_default();
        Ok(in_log_order(read, &lock(&self.live.recent)))
    }

    /// `ensureMemberSession`: the member's own session in the room, created on first use; whether
    /// the member still belongs is checked in the one writer queue.
    async fn member_session(&self, member: &MemberLabel) -> Result<String, String> {
        let session = room_member_session_id(&self.room_id, &member.id).ok_or_else(|| format!("\"{}\" has no session id.", member.id))?;
        let _turn = self.shared.writer.acquire().await;
        if !self.members().contains(&member.id) {
            return Err(format!("\"{}\" is not a member of that room.", member.id));
        }
        let ports = &self.shared.ports;
        if ports.sessions.route(&session).await.map_err(|error| error.to_string())?.is_some() {
            return Ok(session);
        }
        let mut params: Map<String, Value> = if member.id == MIXY_AGENT_ID {
            route_params(&ports.catalog.mixy_route().await)
        } else {
            let mut params = route_params(&member.route);
            params.insert("sessionProfile".into(), json!({ "homeAgent": member.id }));
            params
        };
        params.insert("cwd".into(), json!(ports.catalog.task_workspace().await));
        params.insert("desktopSession".into(), json!({ "classification": "task", "projectPath": null }));
        ports.sessions.create(&session, &Value::Object(params)).await.map_err(|error| error.to_string())?;
        Ok(session)
    }

    async fn switched_off(&self, agent_id: &str) -> Result<bool, String> {
        Ok(self.labels().await?.get(agent_id).is_some_and(|label| label.disabled))
    }

    async fn submit(&self, session_id: &str, prompt: &RoomPrompt, options: &SubmitOptions) -> Result<bool, String> {
        self.shared.ports.daemon.submit(session_id, prompt, options).await
    }

    async fn abort(&self, session_id: &str) -> Result<(), String> {
        self.shared.ports.daemon.abort(session_id).await
    }

    /// The record as of this call is saved; the returned future is the save finishing.
    fn persist(&self) -> PersistFuture {
        let (saves, room_id, fields) = (self.shared.saves.clone(), self.room_id.clone(), self.live.fields());
        Box::pin(async move { saves.save(&room_id, fields).await.map_err(|error| error.to_string()) })
    }
}

#[async_trait]
impl RoomExchangeHost for View {
    fn exists(&self) -> bool {
        lock(&self.shared.live).contains_key(&self.room_id)
    }

    fn track(&self, state: &Arc<TurnState>) {
        *lock(&self.live.tracked) = Some(state.clone());
    }

    fn untrack(&self, state: &Arc<TurnState>) -> bool {
        let mut tracked = lock(&self.live.tracked);
        let held = tracked.as_ref().is_some_and(|current| Arc::ptr_eq(current, state));
        if held {
            *tracked = None;
        }
        held
    }

    fn fail_relays(&self, error: &str) {
        if let Some(fail) = self.shared.relays.get() {
            fail(&self.room_id, error);
        }
    }

    async fn labels(&self) -> Result<HashMap<String, MemberLabel>, String> {
        self.shared.ports.labels.labels(&self.members()).await
    }

    /// `decideRoomTurn`: one step on the Maintainer model. `Ok(None)`: no usable answer.
    async fn decide_turn(&self, step: &SupervisorStep) -> Result<Option<Decision>, String> {
        let prompt = supervisor_prompt(&SupervisorInput { room_name: &step.room_name, members: &step.members, rows: &step.rows, decide: &step.decide });
        Ok(match self.shared.ports.maintainer.ask(&prompt.system, &prompt.user).await {
            Maintained::Unmanaged => Some(Decision { action: Action::Unmanaged, scene: None }),
            Maintained::Failed => None,
            Maintained::Text(reply) => parse_room_decision(&reply, &step.members),
        })
    }

    fn republish_catalog(&self) {
        self.shared.ports.daemon.republish_catalog();
    }

    fn random(&self) -> f64 {
        rand::rng().random::<f64>()
    }

    fn max_rounds(&self) -> u32 {
        lock(&self.live.extra).max_rounds
    }

    fn max_messages(&self) -> u32 {
        lock(&self.live.extra).max_messages
    }

    fn set_running(&self, started_at: Option<i64>) {
        lock(&self.live.extra).running = started_at.map(|started_at| Running { started_at });
    }

    fn set_owed(&self, owed: Option<Vec<String>>) {
        lock(&self.live.extra).owed = owed;
    }

    /// A request merged into the exchange in flight: the member speaking is cut off, its answer
    /// would respond to older rows.
    async fn cut_off(&self) {
        let state = lock(&self.live.tracked).clone();
        let Some(state) = state else { return };
        let (speaking, _, _) = state.speaking();
        let session = state.member_session();
        if !speaking.is_empty() && !session.is_empty() {
            let _ = self.shared.ports.daemon.abort(&session).await;
        }
    }
}

#[cfg(test)]
mod tests;
