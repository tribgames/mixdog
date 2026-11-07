//! One bounded exchange of a group room (`apps/desktop/src/main/agent-room-exchange.ts`; the
//! scheduler, `calls.rs`, starts it): the user's addressees speak first, then a supervisor step on
//! the Maintainer model picks each next speaker or ends the talk, under hard caps. A request sent
//! meanwhile waits in `Run::pending`, and the scheduler runs it as the next exchange straight away.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use async_trait::async_trait;
use serde_json::{Value, json};

use super::calls::{CallRunner, Request, Run, Settled};
use super::config::room_message_budget;
use super::exchange::{Answer, CapLimit, DecideInput, Decision, ExchangeHost, ExchangeParams, Outcome, Turn, TurnResult, run_room_exchange};
use super::member_turn::{MemberHost, speak_in_room, typed_rows};
use super::supervisor::{SupervisorMember, supervisor_rows};
use super::turn_host::{MemberLabel, RoomRecord, TurnState};
use super::turn_post::post_failures;

#[cfg(test)]
mod tests;

/// One supervisor step as the Maintainer sees it (`RoomSupervisorInput`): `rows` are the rows it
/// reads (`roomSupervisorRows`), `decide` the step's budget and the turns taken so far.
pub struct SupervisorStep {
    pub room_name: String,
    pub members: Vec<SupervisorMember>,
    pub rows: Vec<super::rows::RoomRow>,
    pub decide: DecideInput,
}

/// What an exchange needs from the room host, bound to one room (`RoomExchangeHost`).
#[async_trait]
pub trait RoomExchangeHost: MemberHost {
    fn exists(&self) -> bool;
    /// Marks the room running with this state (the views read it).
    fn track(&self, state: &Arc<TurnState>);
    /// Stops tracking `state`; false when the room is no longer this state's.
    fn untrack(&self, state: &Arc<TurnState>) -> bool;
    /// The relays held back for the room end failed.
    fn fail_relays(&self, error: &str);
    async fn labels(&self) -> Result<HashMap<String, MemberLabel>, String>;
    /// `Ok(None)`: no usable decision; `Err`: the model failed.
    async fn decide_turn(&self, step: &SupervisorStep) -> Result<Option<Decision>, String>;
    fn republish_catalog(&self);
    /// A unit random number in [0, 1).
    fn random(&self) -> f64;
    fn max_rounds(&self) -> u32;
    fn max_messages(&self) -> u32;
    /// `room.running = { startedAt }` / `null`.
    fn set_running(&self, started_at: Option<i64>);
    /// `room.owed`: the members an exchange capped before they spoke still owes a turn.
    fn set_owed(&self, owed: Option<Vec<String>>);
    /// A request merged into the exchange in flight: abort the member speaking.
    async fn cut_off(&self);
}

/// The room's host by room id.
pub trait RoomHosts: Send + Sync {
    fn host(&self, room_id: &str) -> Option<Arc<dyn RoomExchangeHost>>;
}

/// The exchange as the scheduler's [`CallRunner`].
pub struct ExchangeRunner {
    hosts: Arc<dyn RoomHosts>,
}

impl ExchangeRunner {
    pub fn new(hosts: Arc<dyn RoomHosts>) -> Self {
        Self { hosts }
    }
}

#[async_trait]
impl CallRunner for ExchangeRunner {
    async fn run(&self, room_id: &str, request: &Request, run: &Arc<Run>) -> Result<(), String> {
        let host = self.hosts.host(room_id).ok_or_else(|| format!("room {room_id} is gone"))?;
        run_exchange(&host, request, run).await
    }

    async fn cut_off(&self, room_id: &str) {
        if let Some(host) = self.hosts.host(room_id) {
            host.cut_off().await;
        }
    }
}

fn exchange_failure(message: &str) -> Settled {
    Settled { status: "failed".into(), error: Some(message.to_owned()), content: None }
}

/// `runRoomExchangeIn` for one exchange: the request that arrives meanwhile is left in
/// `run.pending()` for the scheduler to run next. `Err`: a save the exchange depends on failed;
/// every call it held ended failed and the room was released (`abandonExchange`).
pub async fn run_exchange(host: &Arc<dyn RoomExchangeHost>, request: &Request, run: &Arc<Run>) -> Result<(), String> {
    let room = host.room()?;
    let state = Arc::new(TurnState::new(Arc::clone(run)));
    state.set_waiting(request.waiting);
    host.track(&state);
    let started = async {
        host.set_running(Some(host.now()));
        // Any new exchange settles what an earlier capped one still owed.
        host.set_owed(None);
        host.persist().await?;
        host.republish_catalog();
        host.republish();
        exchange_turns(host, &state, run, request, &room).await;
        settle_exchange(host, &state).await
    };
    match started.await {
        Ok(()) => Ok(()),
        Err(error) => {
            abandon_exchange(host, &state, run, &error);
            Err(error)
        }
    }
}

/// The room is released, when this exchange still holds it.
fn release_exchange(host: &Arc<dyn RoomExchangeHost>, state: &Arc<TurnState>) {
    if host.untrack(state) && host.exists() {
        host.set_running(None);
    }
}

/// The exchange's end: the room is released (unless a request sent meanwhile hands it straight to
/// the next exchange) and saved, and the views publish.
async fn settle_exchange(host: &Arc<dyn RoomExchangeHost>, state: &Arc<TurnState>) -> Result<(), String> {
    let chains = || state.run.pending().is_some() && !state.stop() && host.exists();
    // A request sent meanwhile runs the next exchange straight away: the room stays busy across the
    // hand-off, so the views never publish it idle in between.
    let hands_off = chains();
    if !hands_off {
        release_exchange(host, state);
    }
    host.persist().await?;
    host.republish_catalog();
    if !hands_off {
        host.republish();
    } else if !chains() {
        // The stop button came in while the room was saved.
        release_exchange(host, state);
        host.persist().await?;
        host.republish_catalog();
        host.republish();
    }
    Ok(())
}

/// A save the exchange depends on failed (its start, or its hand-off): the room is released, so
/// nothing waits on it forever, and every call this exchange or the next one held, and every relay
/// held back, ends failed.
fn abandon_exchange(host: &Arc<dyn RoomExchangeHost>, state: &Arc<TurnState>, run: &Arc<Run>, message: &str) {
    host.log(&format!("room {} exchange stopped: {message}", host.room_id()));
    release_exchange(host, state);
    let mut held: Vec<_> = std::mem::take(&mut *run.calls_lock());
    if let Some(pending) = run.pending().take() {
        held.extend(pending.calls);
    }
    for call in &held {
        call.settle_with(&exchange_failure(message));
    }
    host.fail_relays(message);
    host.republish_catalog();
    host.republish();
}

/// The calls no turn of this exchange took: the next exchange (a request sent meanwhile) gives them
/// their turns; with none to follow they end cancelled.
fn hand_over_calls(host: &Arc<dyn RoomExchangeHost>, state: &Arc<TurnState>, run: &Arc<Run>) {
    let mut calls = run.calls_lock();
    let mut pending = run.pending();
    match pending.as_mut() {
        Some(next) if !state.stop() && host.exists() => {
            if calls.is_empty() {
                return;
            }
            for call in calls.iter() {
                if !next.to.contains(&call.agent_id) {
                    next.to.push(call.agent_id.clone());
                }
            }
            let mut carried = std::mem::take(&mut *calls);
            carried.append(&mut next.calls);
            next.calls = carried;
        }
        other => {
            let cancelled = Settled { status: "cancelled".into(), error: None, content: None };
            for call in calls.iter().chain(other.map(|next| next.calls.iter()).into_iter().flatten()) {
                call.settle_with(&cancelled);
            }
        }
    }
    calls.clear();
}

/// What the exchange's helpers share while `run_room_exchange` drives its turns.
struct Session {
    host: Arc<dyn RoomExchangeHost>,
    state: Arc<TurnState>,
    run: Arc<Run>,
    room: Arc<Mutex<RoomRecord>>,
    labels: Arc<HashMap<String, MemberLabel>>,
    speaking: Vec<String>,
    /// A failure that Node throws out of `runRoomExchange` (a turn that throws, a log that cannot be
    /// read): the exchange ends at once and the error is logged.
    fatal: Mutex<Option<String>>,
}

impl Session {
    fn fail(&self, error: String) {
        self.fatal.lock().unwrap_or_else(|poisoned| poisoned.into_inner()).get_or_insert(error);
    }

    fn failed(&self) -> bool {
        self.fatal.lock().unwrap_or_else(|poisoned| poisoned.into_inner()).is_some()
    }
}

#[async_trait]
impl ExchangeHost for Session {
    /// A member's turn answers every call waiting on it; a turn a newer request cut short hands them
    /// back, for the next exchange.
    async fn speak(&self, agent_id: &str, turn: &Turn) -> Answer {
        let taken: Vec<_> = {
            let mut calls = self.run.calls_lock();
            let (taken, rest): (Vec<_>, Vec<_>) = std::mem::take(&mut *calls).into_iter().partition(|call| call.agent_id == agent_id);
            *calls = rest;
            taken
        };
        let host: Arc<dyn MemberHost> = self.host.clone();
        match speak_in_room(&host, &self.state, &self.labels, agent_id, turn, &taken).await {
            Ok(answer) => {
                if answer.result == TurnResult::Superseded {
                    self.run.calls_lock().extend(taken);
                }
                answer
            }
            Err(error) => {
                self.fail(error);
                Answer::of(TurnResult::Stopped)
            }
        }
    }

    /// One supervisor step: nobody is typing while it decides; a failed or unusable answer is
    /// logged and falls back (`None`).
    async fn decide(&self, input: &DecideInput) -> Option<Decision> {
        let host = &self.host;
        self.state.stop_speaking();
        host.republish();
        let rows = match host.rows().await {
            Ok(rows) => rows,
            Err(error) => {
                self.fail(error);
                return None;
            }
        };
        let in_room = self.room.lock().unwrap_or_else(|poisoned| poisoned.into_inner()).clone();

        let members = self
            .speaking
            .iter()
            .filter(|id| in_room.members.contains(id))
            .map(|id| {
                let label = self.labels.get(id);
                SupervisorMember { id: id.clone(), name: label.map_or_else(|| id.clone(), |label| label.name.clone()), description: label.map_or_else(String::new, |label| label.description.clone()) }
            })
            .collect();
        let typed = typed_rows(&rows);
        let step = SupervisorStep { room_name: in_room.name, members, rows: supervisor_rows(&typed).into_iter().cloned().collect(), decide: input.clone() };
        match host.decide_turn(&step).await {
            Ok(Some(decision)) => Some(decision),
            Ok(None) => {
                host.log(&format!("room {} supervisor gave no usable decision; falling back", host.room_id()));
                None
            }
            Err(error) => {
                host.log(&format!("room {} supervisor failed: {error}", host.room_id()));
                None
            }
        }
    }

    fn stopped(&self) -> bool {
        self.state.stop() || self.failed()
    }

    fn superseded(&self) -> bool {
        self.state.run.pending().is_some()
    }
}

/// The exchange's turns; a failing turn or notice is logged, and the calls no turn took are handed
/// on (`hand_over_calls`).
async fn exchange_turns(host: &Arc<dyn RoomExchangeHost>, state: &Arc<TurnState>, run: &Arc<Run>, request: &Request, room: &Arc<Mutex<RoomRecord>>) {
    if let Err(error) = turns_body(host, state, run, request, room).await {
        host.log(&format!("room {} exchange failed: {error}", host.room_id()));
    }
    hand_over_calls(host, state, run);
}

async fn turns_body(host: &Arc<dyn RoomExchangeHost>, state: &Arc<TurnState>, run: &Arc<Run>, request: &Request, room: &Arc<Mutex<RoomRecord>>) -> Result<(), String> {
    let labels = Arc::new(host.labels().await?);
    // A switched-off bot stays a member but takes no new turn.
    let members = room.lock().unwrap_or_else(|poisoned| poisoned.into_inner()).members.clone();
    let speaking: Vec<String> = members.into_iter().filter(|id| labels.get(id).is_none_or(|label| !label.disabled)).collect();
    let max_messages = host.max_messages();
    let session = Session { host: host.clone(), state: state.clone(), run: Arc::clone(run), room: Arc::clone(room), labels, speaking: speaking.clone(), fatal: Mutex::default() };
    let params = ExchangeParams {
        members: speaking.clone(),
        to: request.to.clone(),
        max_rounds: host.max_rounds(),
        // A user-addressed set keeps the full cap; a free exchange stops at a budget drawn each
        // time, so it does not always end at the same count.
        max_messages: if request.to.is_empty() { room_message_budget(u32::try_from(speaking.len()).unwrap_or(u32::MAX), max_messages, host.random()) } else { max_messages },
        waiting: state.waiting(),
        only: request.only,
        whole_room: Some(request.everyone),
    };
    let result = run_room_exchange(&session, params).await;
    if let Some(error) = session.fatal.lock().unwrap_or_else(|poisoned| poisoned.into_inner()).take() {
        return Err(error);
    }
    post_failures(host.as_ref(), state).await?;
    match result.outcome {
        Outcome::Limited => {
            // No supervisor step ran after the turn that met the limit, so the member still in
            // `speakingName` is the one that did.
            let usage = result.usage.as_ref().map_or(Value::Null, |usage| json!({ "kind": usage.kind, "provider": usage.provider, "model": usage.model, "resetAt": usage.reset_at }));
            let id = format!("row_{}", host.new_id());
            let (_, name, _) = state.speaking();
            host.post(vec![json!({ "id": id, "kind": "cap", "at": host.now(), "text": "", "name": name, "limit": "usage", "usage": usage })]).await?;
        }
        Outcome::Capped => {
            if !result.remaining.is_empty() {
                host.set_owed(Some(result.remaining.clone()));
            }
            let limit = match result.limit {
                Some(CapLimit::Messages) => "messages",
                Some(CapLimit::Rounds) | None => "rounds",
            };
            let id = format!("row_{}", host.new_id());
            host.post(vec![json!({ "id": id, "kind": "cap", "at": host.now(), "text": "", "limit": limit, "rounds": result.rounds, "messages": result.messages })]).await?;
        }
        Outcome::Stopped => {
            let id = format!("row_{}", host.new_id());
            host.post(vec![json!({ "id": id, "kind": "stopped", "at": host.now(), "text": "" })]).await?;
        }
        Outcome::Done | Outcome::Superseded | Outcome::Failed => {}
    }
    Ok(())
}
