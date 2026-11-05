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
use mixdog_app_protocol::v2::params::{RoomContinueParams, RoomCreateParams, RoomLeaveParams, RoomRemoveParams, RoomUpdateParams};
use mixdog_core_api::CoreError;
use mixdog_core_api::CoreRequest;
use mixdog_core_api::Reply;
use mixdog_core_api::ids::ConnectionId;
use mixdog_core_api::ids::Method;
use mixdog_core_api::service::Admit;
use mixdog_core_api::service::DomainService;
use rand::Rng;
use serde_json::{Map, Value, json};

use super::RoomError;
use super::config::RoomConfigInput;
use super::ids::{MIXY_AGENT_ID, room_member_session_id, room_session_id};
use super::records::{RoomPatch, RoomRecord, RoomStore, Rooms};
use crate::domains::OpScopes;
use crate::domains::support::{coded, decode, wrong_method};

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
    fn republish_catalog(&self);
}

/// The exchange scheduler: one bounded exchange per room at a time, memory-only.
#[async_trait]
pub trait RoomRunner: Send + Sync {
    fn is_running(&self, room_id: &str) -> bool;
    fn stop(&self, room_id: &str);
    /// Starts an exchange; `to` limits it to those members (empty: the whole room).
    async fn start(&self, room_id: &str, to: Vec<String>) -> Result<(), RoomError>;
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
fn new_room_id(now_ms: i64) -> String {
    let tail: [u8; 4] = rand::thread_rng().r#gen();
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
        RoomError::Invalid(_) => "invalid",
        RoomError::NotFound(_) => "notFound",
        RoomError::PreconditionFailed(_) => "preconditionFailed",
        RoomError::Port(_) => "failed",
    };
    coded("room", code, error.to_string())
}

pub struct RoomService<S: RoomStore, H: RoomHost, R: RoomRunner> {
    rooms: Arc<Rooms<S>>,
    host: Arc<H>,
    runner: Arc<R>,
    ops: OpScopes,
}

impl<S: RoomStore + 'static, H: RoomHost + 'static, R: RoomRunner + 'static> RoomService<S, H, R> {
    pub fn new(rooms: Arc<Rooms<S>>, host: Arc<H>, runner: Arc<R>, ops: OpScopes) -> Self {
        Self { rooms, host, runner, ops }
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

    async fn create(&self, input: &Value) -> Result<Value, RoomError> {
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
        self.host.republish_catalog();
        Ok(json!({ "sessionId": session_id, "roomId": room_id }))
    }

    async fn update(&self, input: &Value) -> Result<Value, RoomError> {
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
        if updated.renamed {
            if let Some(session_id) = room_session_id(room_id) {
                let _ = self.host.rename_session(&session_id, &updated.room.config.name).await;
            }
        }
        self.host.republish_catalog();
        let sessions: Vec<String> = updated.gone.iter().filter_map(|id| room_member_session_id(room_id, id)).collect();
        let failed = self.host.delete_sessions(&sessions).await;
        if failed > 0 {
            return Err(RoomError::Port(format!(
                "The room was updated, but {failed} conversations of removed members could not be deleted."
            )));
        }
        Ok(summary(&updated.room, self.runner.is_running(room_id)))
    }

    async fn remove(&self, input: &Value) -> Result<Value, RoomError> {
        let room_id = room_id_of(input)?;
        let room = self.rooms.get(room_id).await?;
        if let Some(session_id) = room_session_id(room_id) {
            self.runner.stop(room_id);
            self.rooms.remove(room_id).await?;
            let mut sessions: Vec<String> =
                room.config.members.iter().filter_map(|id| room_member_session_id(room_id, id)).collect();
            sessions.push(session_id);
            let failed = self.host.delete_sessions(&sessions).await;
            self.host.republish_catalog();
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

/// A room as the catalog shows it.
fn summary(room: &RoomRecord, running: bool) -> Value {
    json!({
        "id": room.id,
        "name": room.config.name,
        "members": room.config.members,
        "maxRounds": room.config.max_rounds,
        "maxMessages": room.config.max_messages,
        "shareTools": room.config.share_tools,
        "createdAt": room.created_at,
        "lastSpeaker": room.last_speaker,
        "lastAt": room.last_at,
        "lastPreview": room.last_preview,
        "running": running,
    })
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
            other => return Err(wrong_method("room", other)),
        };
        let method = method.to_owned();
        self.ops
            .run(
                &req,
                None,
                || async {
                    let result = match method.as_str() {
                        "room/create" => self.create(&input).await,
                        "room/update" => self.update(&input).await,
                        "room/continue" => self.proceed(&input).await,
                        "room/leave" => self.leave(&input).await,
                        _ => self.remove(&input).await,
                    };
                    result.map_err(failure)
                },
                || async { Ok(json!({})) },
            )
            .await
    }

    fn methods(&self) -> &'static [&'static str] {
        &["room/create", "room/update", "room/continue", "room/leave", "room/remove"]
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

    #[test]
    fn a_room_id_is_a_valid_room_id() {
        let id = new_room_id(1_793_306_570_000);
        assert!(room_session_id(&id).is_some(), "{id}");
    }
}
