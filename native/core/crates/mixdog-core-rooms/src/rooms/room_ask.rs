//! A message another session addresses to one member of a group room (`agentRoomHost().member` /
//! `.ask`, `addressee` and `acceptAsk` of agent-room-messages.ts): the member is resolved from `to`
//! (an agent id or display name), else a leading `@name` of the prompt; the message is posted in the
//! room as a user-kind row naming its real sender, and routed to that member alone (nobody else
//! follows up). The `session` tool's send to a room log goes through it.

use std::collections::HashMap;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};

use async_trait::async_trait;
use mixdog_core_base::rooms::ids::room_id_of_session;
use mixdog_js::js_trim;
use serde_json::{Map, Value, json};

use super::calls::{CallFollow, CallRunner, Request, RoomCall, RoomCalls, Settled};
use super::config::{MemberName, parse_room_ask, room_member_named};
use super::ready::RoomsReady;
use super::turn_host::MemberLabel;

/// The member a message from another session addresses: its member session exists afterwards, and
/// `text` is the message without the mention that named it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Addressee {
    pub agent_id: String,
    pub name: String,
    pub session_id: String,
    pub text: String,
}

/// A message from session `from_session` (agent `from_agent`, empty for the Lead) for member
/// `agent_id` alone. `id` / `on_settled`: the member's turn's submission id and end; `follow`: the
/// caller's durable record follows the turn that answers.
#[derive(Clone)]
pub struct Ask {
    pub agent_id: String,
    pub prompt: Value,
    pub from_session: String,
    pub from_agent: String,
    pub id: String,
    pub hop: u32,
    pub on_settled: Option<Arc<dyn Fn(&Settled) + Send + Sync>>,
    pub follow: Option<Arc<dyn CallFollow>>,
}

/// The room host's `member` and `ask`.
#[async_trait]
pub trait RoomAsk: Send + Sync {
    /// `member(roomSessionId, { to, prompt })`.
    async fn member(&self, session_id: &str, to: &Value, prompt: &Value) -> Result<Addressee, String>;
    /// `ask(roomSessionId, { agentId, prompt, from, id?, hop?, onSettled?, follow? })`.
    async fn ask(&self, session_id: &str, ask: Ask) -> Result<bool, String>;
}

/// One room as a message into it reads and writes it.
#[async_trait]
pub trait AskRoom: Send + Sync {
    fn name(&self) -> String;
    fn members(&self) -> Vec<String>;
    /// `memberLabels(room)`: every member's label, switched-off ones included.
    async fn labels(&self) -> Result<HashMap<String, MemberLabel>, String>;
    /// `names.get(agentId)`: an agent's display name.
    async fn display_name(&self, agent_id: &str) -> Option<String>;
    /// `memberSession(roomId, member)`: created on first use.
    async fn member_session(&self, member: &MemberLabel) -> Result<String, String>;
    /// `post(roomId, rows)`: the rows in the room's log.
    async fn post(&self, rows: Vec<Value>) -> Result<(), String>;
    /// `room.lastAt = at`.
    fn set_last_at(&self, at: i64);
    /// `persist()`.
    async fn persist(&self) -> Result<(), String>;
    /// `deps.republishCatalog()`.
    fn republish_catalog(&self);
    fn now(&self) -> i64;
    fn new_id(&self) -> String;
}

/// `roomOf(roomId)`: the room, or Node's error once it no longer exists.
pub trait AskRooms: Send + Sync {
    fn room(&self, room_id: &str) -> Result<Arc<dyn AskRoom>, String>;
}

/// A send/ask on its way to the scheduler (`IntakeRequest`): the stop button marks it stopped;
/// dropping it releases it.
pub trait Intake: Send {
    fn stopped(&self) -> bool;
}

/// The room scheduler as a message into a room uses it (`scheduler.intake`, `scheduler.route`).
pub trait AskScheduler: Send + Sync {
    fn intake(&self, room_id: &str) -> Box<dyn Intake>;
    fn route(&self, room_id: &str, request: Request);
}

struct CallsIntake<R: CallRunner + 'static> {
    calls: Arc<RoomCalls<R>>,
    room_id: String,
    flag: Arc<AtomicBool>,
}

impl<R: CallRunner + 'static> Intake for CallsIntake<R> {
    fn stopped(&self) -> bool {
        self.flag.load(Ordering::SeqCst)
    }
}

impl<R: CallRunner + 'static> Drop for CallsIntake<R> {
    fn drop(&mut self) {
        self.calls.release_intake(&self.room_id, &self.flag);
    }
}

impl<R: CallRunner + 'static> AskScheduler for Arc<RoomCalls<R>> {
    fn intake(&self, room_id: &str) -> Box<dyn Intake> {
        let flag = RoomCalls::request_intake(self, room_id);
        Box::new(CallsIntake { calls: self.clone(), room_id: room_id.to_owned(), flag })
    }

    fn route(&self, room_id: &str, request: Request) {
        RoomCalls::route(self, room_id, request);
    }
}

/// `promptText(prompt)`: a string trimmed, or the text parts joined by lines.
fn prompt_text(prompt: &Value) -> String {
    match prompt {
        Value::Array(parts) => {
            let texts: Vec<&str> = parts
                .iter()
                .filter_map(|part| if part.get("type").and_then(Value::as_str) == Some("text") { part.get("text").and_then(Value::as_str) } else { Some("") })
                .filter(|text| !text.is_empty())
                .collect();
            js_trim(&texts.join("\n")).to_owned()
        }
        Value::String(text) => js_trim(text).to_owned(),
        _ => String::new(),
    }
}

/// `roomUpload(prompt, {})`: the image and file parts a message carries up with its row.
fn room_upload(prompt: &Value) -> Option<Value> {
    let Value::Array(parts) = prompt else { return None };
    let files: Vec<Value> = parts.iter().filter(|part| part.get("type").and_then(Value::as_str) != Some("text")).cloned().collect();
    (!files.is_empty()).then(|| json!({ "parts": files }))
}

/// [`RoomAsk`] over the hosted rooms and the room scheduler.
pub struct RoomAsks {
    rooms: Arc<dyn AskRooms>,
    scheduler: Arc<dyn AskScheduler>,
    /// The rooms' first load, which every room call awaits first.
    ready: Arc<RoomsReady>,
}

impl RoomAsks {
    pub fn new(rooms: Arc<dyn AskRooms>, scheduler: Arc<dyn AskScheduler>, ready: Arc<RoomsReady>) -> Self {
        Self { rooms, scheduler, ready }
    }

    async fn room_of(&self, session_id: &str) -> Result<(String, Arc<dyn AskRoom>), String> {
        self.ready.ready().await.map_err(|error| error.to_string())?;
        let room_id = room_id_of_session(session_id).unwrap_or_default();
        let room = self.rooms.room(&room_id)?;
        Ok((room_id, room))
    }
}

#[async_trait]
impl RoomAsk for RoomAsks {
    /// `addressee`: `to`, else a leading `@name` naming exactly one member with a message after it.
    async fn member(&self, session_id: &str, to: &Value, prompt: &Value) -> Result<Addressee, String> {
        let (_, room) = self.room_of(session_id).await?;
        let labels = room.labels().await?;
        let members: Vec<&MemberLabel> = room.members().iter().filter_map(|id| labels.get(id)).collect();
        let names: Vec<MemberName> = members.iter().map(|member| MemberName { id: member.id.clone(), name: member.name.clone() }).collect();
        let named = to.as_str().map(js_trim).unwrap_or("");
        let asked = prompt.as_str().map(js_trim).unwrap_or("");
        let mut agent_id = room_member_named(named, &names).unwrap_or_default();
        let mut text = asked.to_owned();
        if named.is_empty()
            && let Some(rest) = asked.strip_prefix('@')
        {
            let parsed = parse_room_ask(&format!("/ask {rest}"), &names);
            if parsed.to.len() == 1 && !parsed.text.is_empty() {
                agent_id = parsed.to[0].clone();
                text = parsed.text;
            }
        }
        let roster = members.iter().map(|member| format!("{} ({})", member.name, member.id)).collect::<Vec<_>>().join(", ");
        if let Some(label) = labels.get(&agent_id).filter(|label| label.disabled) {
            return Err(format!("\"{}\" in room \"{}\" is switched off.", label.name, room.name()));
        }
        let Some(member) = labels.get(&agent_id).filter(|_| !agent_id.is_empty()) else {
            return Err(if named.is_empty() {
                format!("A message to room \"{}\" must name the member it is for (to: agent id or name); its members are {roster}.", room.name())
            } else {
                format!("\"{named}\" is not a member of room \"{}\"; its members are {roster}.", room.name())
            });
        };
        let session_id = room.member_session(member).await?;
        Ok(Addressee { agent_id, name: member.name.clone(), session_id, text })
    }

    /// `acceptAsk`: posted as a user-kind row naming its real sender, then routed to that member
    /// alone; a stop pressed while it was on its way ends its call cancelled.
    async fn ask(&self, session_id: &str, ask: Ask) -> Result<bool, String> {
        let room_id = room_id_of_session(session_id).unwrap_or_default();
        let intake = self.scheduler.intake(&room_id);
        let (_, room) = self.room_of(session_id).await?;
        let agent_id = ask.agent_id.as_str();
        if !room.members().iter().any(|member| member == agent_id) {
            return Err(format!("\"{agent_id}\" is not a member of room \"{}\".", room.name()));
        }
        let labels = room.labels().await?;
        let label_name = labels.get(agent_id).map_or_else(|| agent_id.to_owned(), |label| label.name.clone());
        if labels.get(agent_id).is_some_and(|label| label.disabled) {
            return Err(format!("\"{label_name}\" is switched off."));
        }
        let upload = room_upload(&ask.prompt);
        let text = prompt_text(&ask.prompt);
        if text.is_empty() && upload.is_none() {
            return Err("Write a message to send.".into());
        }
        let from_name = if ask.from_agent.is_empty() { "Lead".to_owned() } else { room.display_name(&ask.from_agent).await.unwrap_or_else(|| ask.from_agent.clone()) };
        let at = room.now();
        let mut row = Map::new();
        row.insert("id".into(), json!(format!("ask_{}", room.new_id())));
        row.insert("kind".into(), json!("user"));
        row.insert("at".into(), json!(at));
        row.insert("text".into(), json!(text));
        row.insert("to".into(), json!([agent_id]));
        row.insert("toName".into(), json!([label_name]));
        row.insert("fromSession".into(), json!(ask.from_session));
        if !ask.from_agent.is_empty() {
            row.insert("fromAgent".into(), json!(ask.from_agent));
        }
        row.insert("fromName".into(), json!(from_name));
        if let Some(upload) = upload {
            row.insert("upload".into(), upload);
        }
        room.post(vec![Value::Object(row)]).await?;
        room.set_last_at(at);
        let (mut call, _) = RoomCall::new(agent_id, &ask.id, ask.hop, &from_name, "", ask.follow);
        call.on_settled = ask.on_settled;
        if intake.stopped() {
            call.settle("cancelled");
        } else {
            self.scheduler.route(&room_id, Request { to: vec![agent_id.to_owned()], everyone: false, waiting: true, only: true, calls: vec![call] });
        }
        drop(intake);
        room.persist().await?;
        room.republish_catalog();
        Ok(true)
    }
}
