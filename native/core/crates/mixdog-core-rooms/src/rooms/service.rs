//! The `room` domain: `room/create`, `room/update`, `room/continue`, `room/leave`,
//! `room/remove` (`agentRoomAction`). Every mutation is one op under `global("room")` and every
//! record change goes through the one `Rooms` writer; sessions, the agent catalog and the
//! exchange scheduler sit behind `RoomHost` and `RoomRunner`.
//!
//! Inputs (`input` of the params): create takes the room config (`name`, `members`,
//! `maxRounds`, `maxMessages`, `shareTools`); update takes `roomId` plus the fields to change;
//! continue, leave and remove take `roomId`.

use std::sync::Arc;

use async_trait::async_trait;
use mixdog_app_protocol::v2::params::{RoomContinueParams, RoomCreateParams, RoomLeaveParams, RoomRemoveParams, RoomResetParams, RoomSendParams, RoomUpdateParams};
use mixdog_core_api::CoreError;
use mixdog_core_api::CoreRequest;
use mixdog_core_api::Reply;
use mixdog_core_api::AfterAnswer;
use mixdog_core_api::ids::ConnectionId;
use mixdog_rt::CancellationToken;
use mixdog_core_api::ids::Method;
use mixdog_core_api::service::Admit;
use mixdog_core_api::service::DomainService;
use rand::Rng;
use serde_json::{Map, Value, json};

use super::RoomError;
use super::config::RoomConfigInput;
use super::ready::RoomsReady;
use mixdog_core_base::rooms::ids::MIXY_AGENT_ID;
use mixdog_core_base::rooms::ids::room_member_session_id;
use mixdog_core_base::rooms::ids::room_session_id;
use super::records::{RoomPatch, RoomRecord, RoomStore, Rooms};
use mixdog_core_base::support::OpScopes;
use mixdog_core_base::support::coded;
use mixdog_core_base::support::decode;
use mixdog_core_base::support::failed;
use mixdog_protocol::DomainErrorDetail;
use super::user_send::{RoomSend, UserMessage};
use mixdog_core_base::support::wrong_method;

/// An agent contact as the room needs it.
#[derive(Clone, Debug)]
pub struct KnownAgent {
    pub id: String,
    /// Its model route (`provider`, `model`, optional `effort`, …); `Null` when it has none.
    pub route: Value,
}

#[async_trait]
pub trait RoomHost: Send + Sync {
    /// The agent catalog, Mixy excluded (she is always known).
    async fn agents(&self) -> Result<Vec<KnownAgent>, RoomError>;
    /// The route Mixy follows (her own, else Main's); `Null` when neither is set.
    async fn mixy_route(&self) -> Value;
    async fn task_workspace(&self) -> String;
    async fn session_exists(&self, session_id: &str) -> bool;
    async fn create_session(&self, session_id: &str, params: &Value) -> Result<(), RoomError>;
    async fn rename_session(&self, session_id: &str, title: &str) -> Result<(), RoomError>;
    async fn set_archived(&self, session_id: &str, archived: bool) -> Result<(), RoomError>;
    /// Deletes each session; the number that could not be deleted.
    async fn delete_sessions(&self, session_ids: &[String]) -> usize;
    /// `startSessionOver`: the session is cleared in place and its conversation kept under a new archived id
    /// (`None` when it had nothing to keep).
    async fn start_over(&self, session_id: &str) -> Result<Option<String>, RoomError>;
    /// `resetSessionConversation({ fork: false })`: a member's session is emptied, nothing kept.
    async fn reset_member(&self, session_id: &str) -> Result<(), RoomError>;
    /// `deps.republishCatalog` (`session-host.ts:353-356`): with the catalog loaded it is published when this returns and its
    /// failure is the call's. Before that a whole listing is started here and not awaited (`void publishCatalogs()`); it reads at
    /// once and its rows go out once `publish` is cancelled. The answer is that listing's end.
    async fn republish_catalog(&self, publish: &CancellationToken) -> Result<Option<ListingEnd>, RoomError>;
}

/// The end of a background catalog listing a room call started, for a call that joins it.
pub type ListingEnd = std::pin::Pin<Box<dyn std::future::Future<Output = ()> + Send>>;

/// Node's rule for a listing a room call starts before any listing was answered: its rows wait for the daemon's `session.list`
/// reply (`session-host.ts:797`), so they never overtake an answer the call makes with no I/O after the start, and may come
/// before an answer the call makes after awaiting I/O. The core's listing has no such round trip, so the call holds its rows
/// (`publish`, a hold on the reply's place on the connection) and lets go of them where Node's call first awaits I/O.
/// - create (`agent-rooms.ts:289-290`), remove (`:333-334`, its deletions come before the start), update without removed members
///   (`:312-319`, `deleteSessions([])` loops over nothing, `agent-room-membership.ts:52-56`): no I/O; held until the reply is queued.
/// - update removing members (`:315`) and a member forgotten (`:345-346`): each deletion awaits `listSessions()` first
///   (`session-host-lifecycle.ts:527`), which joins the listing in flight (`session-host.ts:790`): it reads before the deletion and
///   its rows go out before it ([`join`]).
/// - reset (`:388-392`): each member's session is read from the daemon (`sessionExists`, `session-host.ts:299-306`): from the first
///   read on the listing may publish ([`free`]).
pub(crate) fn free(publish: &CancellationToken) {
    publish.cancel();
}

/// [`free`], then the listing's end: Node's deletion joining the listing in flight.
pub(crate) async fn join(publish: &CancellationToken, listing: Option<ListingEnd>) {
    free(publish);
    if let Some(end) = listing {
        end.await;
    }
}

/// The exchange scheduler: one bounded exchange per room at a time, memory-only.
#[async_trait]
pub trait RoomRunner: Send + Sync {
    fn is_running(&self, room_id: &str) -> bool;
    fn stop(&self, room_id: &str);
    /// Starts an exchange; `to` limits it to those members (empty: the whole room).
    async fn start(&self, room_id: &str, to: Vec<String>) -> Result<(), RoomError>;
    /// `gone` left the room: what is owed to them ends (`cancelOwedTo`).
    fn cancel_owed_to(&self, room_id: &str, gone: &[String]);
}

/// The create-call route fields of a catalog route: `provider` and `model` or nothing.
pub fn route_params(route: &Value) -> Map<String, Value> {
    let leaf = route.as_array().and_then(|list| list.first()).unwrap_or(route);
    let text = |key: &str| leaf.get(key).and_then(Value::as_str).filter(|s| !s.is_empty());
    let (Some(provider), Some(model)) = (text("provider"), text("model")) else {
        return Map::new();
    };
    let mut out = Map::new();
    out.insert("provider".into(), json!(provider));
    out.insert("model".into(), json!(model));
    if let Some(effort) = text("effort") {
        out.insert("effort".into(), json!(effort));
    }
    if let Some(fast) = leaf.get("fast").filter(|v| v.is_boolean()) {
        out.insert("fast".into(), fast.clone());
    }
    if leaf.get("autoEffort") == Some(&json!(false)) {
        out.insert("autoEffort".into(), json!(false));
    }
    if let Some(parameters) = leaf.get("modelParameters").filter(|v| v.is_object()) {
        out.insert("modelParameters".into(), parameters.clone());
    }
    out
}

fn base36(mut n: u64) -> String {
    const DIGITS: &[u8] = b"0123456789abcdefghijklmnopqrstuvwxyz";
    let mut out = Vec::new();
    loop {
        out.push(DIGITS[(n % 36) as usize]);
        n /= 36;
        if n == 0 {
            break;
        }
    }
    out.reverse();
    String::from_utf8(out).expect("ascii digits")
}

/// A room id: the time in base 36 and four random bytes, matching `^[a-z0-9]{6,32}$`.
pub(crate) fn new_room_id(now_ms: i64) -> String {
    let tail: [u8; 4] = rand::rng().random();
    format!("{}{}", base36(now_ms.max(0) as u64), tail.iter().map(|b| format!("{b:02x}")).collect::<String>())
}

fn config_input(input: &Value, base: Option<&RoomRecord>) -> RoomConfigInput {
    let number = |key: &str| input.get(key).and_then(Value::as_f64);
    RoomConfigInput {
        name: input.get("name").and_then(Value::as_str).map(str::to_owned).or_else(|| base.map(|r| r.config.name.clone())).unwrap_or_default(),
        members: members_of(input).unwrap_or_else(|| base.map(|r| r.config.members.clone()).unwrap_or_default()),
        max_rounds: number("maxRounds"),
        max_messages: number("maxMessages"),
        share_tools: input.get("shareTools").and_then(Value::as_bool).unwrap_or(false),
    }
}

fn members_of(input: &Value) -> Option<Vec<String>> {
    input
        .get("members")
        .and_then(Value::as_array)
        .map(|list| list.iter().filter_map(Value::as_str).map(str::to_owned).collect())
}

fn room_id_of(input: &Value) -> Result<&str, RoomError> {
    input.get("roomId").and_then(Value::as_str).filter(|s| !s.is_empty()).ok_or_else(|| RoomError::Invalid("roomId is required.".into()))
}

fn failure(error: RoomError) -> CoreError {
    let code = match &error {
        RoomError::Invalid(_) | RoomError::OutOfRange(_) => "invalid",
        RoomError::NotFound(_) => "notFound",
        RoomError::PreconditionFailed(_) => "preconditionFailed",
        RoomError::Port(_) => "failed",
        RoomError::Refused(message) => return failed("room", message.clone()),
        RoomError::SwitchedOff(name) => {
            return CoreError::DomainError {
                domain: "room".into(),
                code: Some("ROOM_MEMBER_SWITCHED_OFF".into()),
                message: Some(error.to_string().into()),
                detail: Some(Box::new(DomainErrorDetail::RoomMemberSwitchedOff { name: name.clone() })),
            };
        }
    };
    coded("room", code, error.to_string())
}

pub struct RoomService<S: RoomStore, H: RoomHost, R: RoomRunner> {
    rooms: Arc<Rooms<S>>,
    host: Arc<H>,
    runner: Arc<R>,
    ops: OpScopes,
    /// The members' names an answered room summary carries (`refreshNames`, `agent-rooms.ts:304`).
    names: Arc<dyn super::catalog_rows::MemberNames>,
    /// The rooms' first load, which every room call awaits first (`agent-rooms.ts:267,294,323,365,376,409`).
    ready: Arc<RoomsReady>,
    /// A user's message into a room (`room/send`).
    sender: Arc<dyn RoomSend>,
}

impl<S: RoomStore + 'static, H: RoomHost + 'static, R: RoomRunner + 'static> RoomService<S, H, R> {
    pub fn new(
        rooms: Arc<Rooms<S>>,
        host: Arc<H>,
        runner: Arc<R>,
        ops: OpScopes,
        names: Arc<dyn super::catalog_rows::MemberNames>,
        ready: Arc<RoomsReady>,
        sender: Arc<dyn RoomSend>,
    ) -> Self {
        Self { rooms, host, runner, ops, names, ready, sender }
    }

    /// `submitToSession` on a room log (`session-host.ts:1089-1091` → `agentRooms.send`): the message posted and routed
    /// (`LiveRooms::send`), then the catalog republished (`agent-room-messages.ts:110`); `true`, also for a submission
    /// accepted before, which republishes nothing (`:76`).
    async fn send(&self, input: &Value, replied: &AfterAnswer) -> Result<Value, RoomError> {
        if self.sender.send(&UserMessage::of(input)?).await? {
            self.host.republish_catalog(&replied.hold()).await?;
        }
        Ok(json!(true))
    }

    async fn known(&self) -> Result<Vec<KnownAgent>, RoomError> {
        self.host.agents().await
    }

    fn missing<'a>(known: &[KnownAgent], members: &'a [String]) -> Option<&'a String> {
        members.iter().find(|id| id.as_str() != MIXY_AGENT_ID && !known.iter().any(|k| &k.id == *id))
    }

    /// The route a room's log session is stored with: the first member that has a model. A
    /// session without a model is never stored, so a room of members without any cannot start.
    async fn log_route(&self, members: &[String], known: &[KnownAgent]) -> Option<Map<String, Value>> {
        for id in members {
            let route = if id == MIXY_AGENT_ID {
                route_params(&self.host.mixy_route().await)
            } else {
                known.iter().find(|k| &k.id == id).map(|k| route_params(&k.route)).unwrap_or_default()
            };
            if route.contains_key("model") {
                return Some(route);
            }
        }
        None
    }

    async fn task_params(&self, mut params: Map<String, Value>) -> Value {
        params.insert("cwd".into(), json!(self.host.task_workspace().await));
        params.insert("desktopSession".into(), json!({ "classification": "task", "projectPath": null }));
        Value::Object(params)
    }

    async fn create(&self, input: &Value, replied: &AfterAnswer) -> Result<Value, RoomError> {
        let probe = super::config::normalize_room_config(&config_input(input, None))?;
        let known = self.known().await?;
        if let Some(missing) = Self::missing(&known, &probe.members) {
            return Err(RoomError::Invalid(format!("Agent \"{missing}\" is not available.")));
        }
        let route = self
            .log_route(&probe.members, &known)
            .await
            .ok_or_else(|| RoomError::Invalid("No model selected. Choose a model for one of the room members first.".into()))?;
        let now = chrono::Utc::now().timestamp_millis();
        let room_id = new_room_id(now);
        let session_id = room_session_id(&room_id).ok_or_else(|| RoomError::Port("room id is invalid".into()))?;
        let params = self.task_params(route).await;
        self.host.create_session(&session_id, &params).await?;
        self.rooms.create(&config_input(input, None), &room_id, now).await?;
        let _ = self.host.rename_session(&session_id, &probe.name).await;
        self.host.republish_catalog(&replied.hold()).await?;
        Ok(json!({ "sessionId": session_id, "roomId": room_id }))
    }

    async fn update(&self, input: &Value, replied: &AfterAnswer) -> Result<Value, RoomError> {
        let room_id = room_id_of(input)?;
        let current = self.rooms.get(room_id).await?;
        let merged = config_input(input, Some(&current));
        let merged_config = super::config::normalize_room_config(&RoomConfigInput {
            max_rounds: merged.max_rounds.or(Some(f64::from(current.config.max_rounds))),
            max_messages: merged.max_messages.or(Some(f64::from(current.config.max_messages))),
            share_tools: input.get("shareTools").and_then(Value::as_bool).unwrap_or(current.config.share_tools),
            ..merged
        })?;
        let added: Vec<String> = merged_config.members.iter().filter(|id| !current.config.members.contains(id)).cloned().collect();
        if !added.is_empty() {
            if let Some(missing) = Self::missing(&self.known().await?, &added) {
                return Err(RoomError::Invalid(format!("Agent \"{missing}\" is not available.")));
            }
        }
        let patch = RoomPatch {
            name: input.get("name").and_then(Value::as_str).map(str::to_owned),
            members: members_of(input),
            max_rounds: input.get("maxRounds").and_then(Value::as_f64),
            max_messages: input.get("maxMessages").and_then(Value::as_f64),
            share_tools: input.get("shareTools").and_then(Value::as_bool),
        };
        let updated = self.rooms.update(room_id, &patch).await?;
        if !updated.gone.is_empty() {
            self.runner.cancel_owed_to(room_id, &updated.gone);
        }
        if updated.renamed {
            if let Some(session_id) = room_session_id(room_id) {
                let _ = self.host.rename_session(&session_id, &updated.room.config.name).await;
            }
        }
        let publish = replied.hold();
        let listing = self.host.republish_catalog(&publish).await?;
        let sessions: Vec<String> = updated.gone.iter().filter_map(|id| room_member_session_id(room_id, id)).collect();
        if !sessions.is_empty() {
            join(&publish, listing).await;
        }
        let failed = self.host.delete_sessions(&sessions).await;
        if failed > 0 {
            return Err(RoomError::Port(format!(
                "The room was updated, but {failed} conversations of removed members could not be deleted."
            )));
        }
        // `summaryOf(room)` (`agent-rooms.ts:319`), the room as the catalog's `agentRoom` shows it.
        Ok(super::catalog_rows::room_summary(&updated.room, &self.names.names().await, self.runner.is_running(room_id)))
    }

    async fn remove(&self, input: &Value, replied: &AfterAnswer) -> Result<Value, RoomError> {
        let room_id = room_id_of(input)?;
        let room = self.rooms.get(room_id).await?;
        if let Some(session_id) = room_session_id(room_id) {
            self.runner.stop(room_id);
            self.rooms.remove(room_id).await?;
            let mut sessions: Vec<String> =
                room.config.members.iter().filter_map(|id| room_member_session_id(room_id, id)).collect();
            sessions.push(session_id);
            let failed = self.host.delete_sessions(&sessions).await;
            self.host.republish_catalog(&replied.hold()).await?;
            if failed > 0 {
                return Err(RoomError::Port(format!("The room was removed, but {failed} of its conversations could not be deleted.")));
            }
        }
        Ok(json!({}))
    }

    async fn leave(&self, input: &Value) -> Result<Value, RoomError> {
        let room_id = room_id_of(input)?;
        self.rooms.get(room_id).await?;
        self.runner.stop(room_id);
        let session_id = room_session_id(room_id).ok_or_else(|| RoomError::Port("room id is invalid".into()))?;
        self.host.set_archived(&session_id, true).await?;
        Ok(json!({}))
    }

    /// "대화 초기화" (`agent-rooms.ts` `reset`): the room's log starts over with the old one archived, every member's
    /// cursor restarts and each member's own session is emptied. Refused while members are speaking.
    async fn reset(&self, input: &Value, replied: &AfterAnswer) -> Result<Value, RoomError> {
        let room_id = room_id_of(input)?;
        let room = self.rooms.get(room_id).await?;
        let session_id = room_session_id(room_id).ok_or_else(|| RoomError::Port("room id is invalid".into()))?;
        if self.runner.is_running(room_id) {
            return Err(RoomError::Invalid("The room is still talking; stop it or wait before resetting.".into()));
        }
        let archived = self.host.start_over(&session_id).await?;
        self.rooms.reset(room_id, chrono::Utc::now().timestamp_millis()).await?;
        let publish = replied.hold();
        self.host.republish_catalog(&publish).await?;
        let mut failed = 0;
        for member in &room.config.members {
            let Some(member_session) = room_member_session_id(room_id, member) else { continue };
            free(&publish);
            if !self.host.session_exists(&member_session).await {
                continue;
            }
            if self.host.reset_member(&member_session).await.is_err() {
                failed += 1;
            }
        }
        if failed > 0 {
            return Err(RoomError::Port(format!("The room was reset, but {failed} of its members could not start over.")));
        }
        Ok(json!({ "archivedSessionId": archived }))
    }

    /// "더 진행": the members a capped message still owes a turn, else another bounded batch.
    async fn proceed(&self, input: &Value) -> Result<Value, RoomError> {
        let room_id = room_id_of(input)?;
        let room = self.rooms.get(room_id).await?;
        if self.runner.is_running(room_id) {
            return Ok(json!({}));
        }
        let owed: Vec<String> =
            room.owed.unwrap_or_default().into_iter().filter(|id| room.config.members.contains(id)).collect();
        self.runner.start(room_id, owed).await?;
        Ok(json!({}))
    }
}

#[async_trait]
impl<S: RoomStore + 'static, H: RoomHost + 'static, R: RoomRunner + 'static> DomainService for RoomService<S, H, R> {
    async fn call(&self, req: CoreRequest) -> Result<Reply, CoreError> {
        let method = req.method.as_str();
        let input: Value = match method {
            "room/create" => decode::<RoomCreateParams>(&req)?.input,
            "room/update" => decode::<RoomUpdateParams>(&req)?.input,
            "room/continue" => decode::<RoomContinueParams>(&req)?.input,
            "room/leave" => decode::<RoomLeaveParams>(&req)?.input,
            "room/remove" => decode::<RoomRemoveParams>(&req)?.input,
            "room/reset" => decode::<RoomResetParams>(&req)?.input,
            "room/send" => decode::<RoomSendParams>(&req)?.input,
            other => return Err(wrong_method("room", other)),
        };
        let method = method.to_owned();
        let replied = &req.ctx.after_answer;
        // A repeated op answers as the first did: a send `true`, every other room op `{}`.
        let repeated = if method == "room/send" { json!(true) } else { json!({}) };
        self.ops
            .run(
                &req,
                None,
                || async {
                    self.ready.ready().await.map_err(failure)?;
                    let result = match method.as_str() {
                        "room/create" => self.create(&input, replied).await,
                        "room/update" => self.update(&input, replied).await,
                        "room/continue" => self.proceed(&input).await,
                        "room/leave" => self.leave(&input).await,
                        "room/reset" => self.reset(&input, replied).await,
                        "room/send" => self.send(&input, replied).await,
                        _ => self.remove(&input, replied).await,
                    };
                    result.map_err(failure)
                },
                || async { Ok(repeated.clone()) },
            )
            .await
    }

    fn methods(&self) -> &'static [&'static str] {
        &["room/create", "room/update", "room/continue", "room/leave", "room/remove", "room/reset", "room/send"]
    }

    fn notify(&self, _method: Method, _params: Value, _from: ConnectionId) -> Admit {
        Admit::Accepted
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_route_without_a_model_gives_no_params_and_a_list_uses_its_first_leaf() {
        assert!(route_params(&json!({ "provider": "openai" })).is_empty());
        let route = route_params(&json!([{ "provider": "openai", "model": "m", "effort": "high", "fast": true }]));
        assert_eq!(Value::Object(route), json!({ "provider": "openai", "model": "m", "effort": "high", "fast": true }));
    }

    use super::super::records::{RoomDoc, RoomRecord, RoomStore};
    use std::sync::Mutex;

    /// No agent has a name: a summary names each member by its id.
    struct Unnamed;
    #[async_trait]
    impl super::super::catalog_rows::MemberNames for Unnamed {
        async fn names(&self) -> std::collections::HashMap<String, String> {
            std::collections::HashMap::new()
        }
    }

    struct Mem(Mutex<RoomDoc>);
    #[async_trait]
    impl RoomStore for Mem {
        async fn load(&self) -> Result<RoomDoc, RoomError> {
            Ok(self.0.lock().unwrap().clone())
        }
        async fn save(&self, doc: &RoomDoc) -> Result<(), RoomError> {
            *self.0.lock().unwrap() = doc.clone();
            Ok(())
        }
    }

    /// The scripted daemon of the recording: which sessions exist, which member clears fail, what the log's start-over answers.
    struct Scripted {
        existing: Vec<String>,
        fail_members: Vec<String>,
        start_over: Value,
        calls: Mutex<Vec<(String, String)>>,
    }
    #[async_trait]
    impl RoomHost for Scripted {
        async fn agents(&self) -> Result<Vec<KnownAgent>, RoomError> {
            Ok(vec![])
        }
        async fn mixy_route(&self) -> Value {
            Value::Null
        }
        async fn task_workspace(&self) -> String {
            String::new()
        }
        async fn session_exists(&self, id: &str) -> bool {
            self.existing.iter().any(|s| s == id)
        }
        async fn create_session(&self, _: &str, _: &Value) -> Result<(), RoomError> {
            Ok(())
        }
        async fn rename_session(&self, _: &str, _: &str) -> Result<(), RoomError> {
            Ok(())
        }
        async fn set_archived(&self, _: &str, _: bool) -> Result<(), RoomError> {
            Ok(())
        }
        async fn delete_sessions(&self, _: &[String]) -> usize {
            0
        }
        async fn republish_catalog(&self, _: &CancellationToken) -> Result<Option<ListingEnd>, RoomError> {
            Ok(None)
        }
        async fn start_over(&self, id: &str) -> Result<Option<String>, RoomError> {
            self.calls.lock().unwrap().push(("startOver".into(), id.into()));
            match &self.start_over {
                Value::String(archived) => Ok(Some(archived.clone())),
                Value::Null => Ok(None),
                _ => Err(RoomError::Port("archive failed".into())),
            }
        }
        async fn reset_member(&self, id: &str) -> Result<(), RoomError> {
            self.calls.lock().unwrap().push(("resetMember".into(), id.into()));
            if self.fail_members.iter().any(|who| id.ends_with(&format!("_{who}"))) {
                return Err(RoomError::Port("could not clear".into()));
            }
            Ok(())
        }
    }

    /// No user message is sent in these tests.
    struct NoSends;
    #[async_trait]
    impl RoomSend for NoSends {
        async fn send(&self, _: &UserMessage) -> Result<bool, RoomError> {
            unreachable!("no user message is sent here")
        }
    }

    struct Runs(bool);
    #[async_trait]
    impl RoomRunner for Runs {
        fn is_running(&self, _: &str) -> bool {
            self.0
        }
        fn stop(&self, _: &str) {}
        async fn start(&self, _: &str, _: Vec<String>) -> Result<(), RoomError> {
            Ok(())
        }
        fn cancel_owed_to(&self, _: &str, _: &[String]) {}
    }

    /// Every recorded Node `room/reset` replays whole: the answer or error text, the clears asked of the host in order,
    /// and the stored room afterwards (its cursors, last line and owed set restarted, members and limits kept).
    #[tokio::test]
    async fn room_reset_answers_every_recorded_case_as_nodes_reset_does() {
        let recorded: Value = serde_json::from_str(include_str!("../../../../fixtures/phone-chat-core/room-reset.json")).unwrap();
        let cases = recorded["cases"].as_array().unwrap();
        assert_eq!(cases.len(), 8);
        let dir = tempfile::tempdir().unwrap();
        for case in cases {
            let name = case["name"].as_str().unwrap();
            let room_id = case["roomId"].as_str().unwrap();
            let before: RoomRecord = serde_json::from_value(case["before"].clone()).unwrap();
            let strings = |v: &Value| v.as_array().unwrap().iter().map(|s| s.as_str().unwrap().to_owned()).collect::<Vec<_>>();
            let mut existing = strings(&case["existing"]);
            existing.push(case["logSession"].as_str().unwrap().to_owned());
            let host = Arc::new(Scripted {
                existing,
                fail_members: strings(&case["inject"]["failMembers"]),
                start_over: if case["inject"]["startOver"] == "throws" { json!(false) } else { case["inject"]["startOver"].clone() },
                calls: Mutex::default(),
            });
            let rooms = Arc::new(Rooms::new(Mem(Mutex::new(RoomDoc::from([(room_id.to_owned(), before.clone())])))));
            let ops = mixdog_core_base::support::testing::scopes(dir.path(), "room").await;
            let service = RoomService::new(rooms.clone(), host.clone(), Arc::new(Runs(case["running"] == true)), ops, Arc::new(Unnamed), RoomsReady::prepared(), Arc::new(NoSends));

            // The unknown room is asked for by another id than the one the record sits under.
            let asked = if name == "unknown room" { "nosuchroom" } else { room_id };
            let answer = service.reset(&json!({ "roomId": asked }), &AfterAnswer::default()).await;
            match (&case["outcome"]["ok"], answer) {
                (Value::Bool(true), Ok(value)) => assert_eq!(value, case["outcome"]["value"], "{name}"),
                (Value::Bool(false), Err(error)) => assert_eq!(error.to_string(), case["outcome"]["error"].as_str().unwrap(), "{name}"),
                (_, other) => panic!("{name}: Node's outcome {} but Rust answered {other:?}", case["outcome"]),
            }
            let calls: Vec<Vec<String>> = host.calls.lock().unwrap().iter().map(|(kind, id)| vec![kind.clone(), id.clone()]).collect();
            let want: Vec<Vec<String>> = case["calls"].as_array().unwrap().iter().map(strings).collect();
            assert_eq!(calls, want, "{name}: the clears asked of the host");

            let after = &case["after"];
            let now = rooms.get(room_id).await.unwrap();
            assert_eq!(now.cursors.len(), after["cursors"].as_object().unwrap().len(), "{name}: cursors");
            assert_eq!(now.seen.len(), after.get("seen").map_or(0, |s| s.as_object().unwrap().len()), "{name}: seen");
            assert_eq!(now.last_speaker.as_deref(), after["lastSpeaker"].as_str(), "{name}: lastSpeaker");
            assert_eq!(now.last_preview.as_deref(), after["lastPreview"].as_str(), "{name}: lastPreview");
            assert_eq!(now.owed, after["owed"].as_array().map(|list| strings(&Value::Array(list.clone()))), "{name}: owed");
            assert_eq!(now.config.members, strings(&after["members"]), "{name}: members");
            assert_eq!(now.config.max_rounds, after["maxRounds"].as_u64().unwrap() as u32, "{name}: maxRounds");
            // Node stamps its own clock; a reset that ran moved `lastAt`, one that was refused left it.
            assert_eq!(now.last_at > before.last_at, after["lastAt"] != case["before"]["lastAt"], "{name}: lastAt");
        }
    }

    #[test]
    fn a_room_id_is_a_valid_room_id() {
        let id = new_room_id(1_793_306_570_000);
        assert!(room_session_id(&id).is_some(), "{id}");
    }

    #[derive(Default)]
    struct Records(std::sync::Mutex<super::super::records::RoomDoc>);
    #[async_trait]
    impl RoomStore for Records {
        async fn load(&self) -> Result<super::super::records::RoomDoc, RoomError> {
            Ok(self.0.lock().unwrap().clone())
        }
        async fn save(&self, doc: &super::super::records::RoomDoc) -> Result<(), RoomError> {
            *self.0.lock().unwrap() = doc.clone();
            Ok(())
        }
    }

    /// A host whose catalog publish stops at a gate the test opens with the publish's outcome; `began` tells the publish was
    /// asked for. A second publish, or one with no gate, panics.
    struct Gated {
        began: std::sync::atomic::AtomicBool,
        open: std::sync::Mutex<Option<tokio::sync::oneshot::Receiver<Result<(), RoomError>>>>,
    }
    #[async_trait]
    impl RoomHost for Gated {
        async fn agents(&self) -> Result<Vec<KnownAgent>, RoomError> {
            let route = json!({ "provider": "p", "model": "m" });
            Ok(["gh", "rel"].map(|id| KnownAgent { id: id.into(), route: route.clone() }).to_vec())
        }
        async fn mixy_route(&self) -> Value {
            Value::Null
        }
        async fn task_workspace(&self) -> String {
            "/tasks".into()
        }
        async fn session_exists(&self, _: &str) -> bool {
            false
        }
        async fn create_session(&self, _: &str, _: &Value) -> Result<(), RoomError> {
            Ok(())
        }
        async fn rename_session(&self, _: &str, _: &str) -> Result<(), RoomError> {
            Ok(())
        }
        async fn set_archived(&self, _: &str, _: bool) -> Result<(), RoomError> {
            Ok(())
        }
        async fn delete_sessions(&self, _: &[String]) -> usize {
            0
        }
        async fn republish_catalog(&self, _: &CancellationToken) -> Result<Option<ListingEnd>, RoomError> {
            self.began.store(true, std::sync::atomic::Ordering::SeqCst);
            let open = self.open.lock().unwrap().take();
            open.expect("one publish").await.expect("the test opens the gate").map(|()| None)
        }
        async fn start_over(&self, _: &str) -> Result<Option<String>, RoomError> {
            Ok(None)
        }
        async fn reset_member(&self, _: &str) -> Result<(), RoomError> {
            Ok(())
        }
    }

    struct Idle;
    #[async_trait]
    impl RoomRunner for Idle {
        fn is_running(&self, _: &str) -> bool {
            false
        }
        fn stop(&self, _: &str) {}
        async fn start(&self, _: &str, _: Vec<String>) -> Result<(), RoomError> {
            Ok(())
        }
        fn cancel_owed_to(&self, _: &str, _: &[String]) {}
    }

    /// Node answers `createAgentRoom` after `deps.republishCatalog()` (`agent-rooms.ts` `create`, `session-host.ts:357-360`
    /// publishes the catalog synchronously): the room is listed and announced when the call answers. Polled while the
    /// publish is held, the creation has not answered; once the gate opens it answers with the room it made. Everything
    /// the creation awaits here is in memory, so one poll runs it to the gate or to its answer.
    #[tokio::test]
    async fn room_create_answers_only_after_the_catalog_is_published() {
        let (open_tx, open) = tokio::sync::oneshot::channel();
        let (service, host, _dir) = service_over(Some(open)).await;
        let input = json!({ "name": "Release", "members": ["gh", "rel"] });
        let replied = AfterAnswer::default();
        let create = service.create(&input, &replied);
        tokio::pin!(create);
        assert!(polled(&mut create).await.is_pending(), "the creation answered while the catalog publish was held");
        assert!(host.began.load(std::sync::atomic::Ordering::SeqCst), "it is held at the publish");
        open_tx.send(Ok(())).expect("the creation waits");
        let std::task::Poll::Ready(answer) = polled(&mut create).await else { panic!("the creation did not answer once the catalog was published") };
        let answer = answer.expect("created");
        assert!(answer["sessionId"].as_str().is_some_and(|id| id.starts_with("sess_room_")), "{answer}");
    }

    /// Node's publish throws into the room call (`agent-rooms.ts:289`, a `void` return of `session-host.ts:353`): the creation
    /// rejects with the publish's error, and the room it saved stays saved (no rollback).
    #[tokio::test]
    async fn room_create_rejects_with_the_publish_error_and_keeps_the_room() {
        let (open_tx, open) = tokio::sync::oneshot::channel();
        let (service, _host, _dir) = service_over(Some(open)).await;
        open_tx.send(Err(RoomError::Port("the room log was not indexed".into()))).expect("gate");
        let input = json!({ "name": "Release", "members": ["gh", "rel"] });
        let error = service.create(&input, &AfterAnswer::default()).await.expect_err("the publish failed");
        assert_eq!(error, RoomError::Port("the room log was not indexed".into()));
        assert_eq!(service.rooms.list().await.expect("rooms").len(), 1, "the saved room stays");
    }

    /// Node's `leave` only archives the room's log (`agent-rooms.ts:364-369`); it publishes nothing, so it must not wait for a
    /// publish: the host has no gate, and a publish panics.
    #[tokio::test]
    async fn room_leave_does_not_wait_for_a_publish() {
        let (open_tx, open) = tokio::sync::oneshot::channel();
        let (service, _host, _dir) = service_over(Some(open)).await;
        open_tx.send(Ok(())).expect("gate");
        let made = service.create(&json!({ "name": "Release", "members": ["gh", "rel"] }), &AfterAnswer::default()).await.expect("created");
        service.leave(&json!({ "roomId": made["roomId"] })).await.expect("left with no second publish");
    }

    /// One poll of `future`, whatever it answers. Everything the room service awaits here is in memory, so one poll runs it
    /// to the gate or to its answer.
    async fn polled<F: std::future::Future>(future: &mut std::pin::Pin<&mut F>) -> std::task::Poll<F::Output> {
        std::future::poll_fn(|cx| std::task::Poll::Ready(future.as_mut().poll(cx))).await
    }

    async fn service_over(
        gate: Option<tokio::sync::oneshot::Receiver<Result<(), RoomError>>>,
    ) -> (RoomService<Records, Gated, Idle>, Arc<Gated>, tempfile::TempDir) {
        let host = Arc::new(Gated { began: false.into(), open: gate.into() });
        let dir = tempfile::tempdir().expect("dir");
        let service = RoomService::new(
            Arc::new(Rooms::new(Records::default())),
            host.clone(),
            Arc::new(Idle),
            mixdog_core_base::support::testing::scopes(dir.path(), "room").await,
            Arc::new(Unnamed),
            RoomsReady::prepared(),
            Arc::new(NoSends),
        );
        (service, host, dir)
    }
}
