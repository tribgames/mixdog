//! One member's turn in a group room (`apps/desktop/src/main/agent-room-turn.ts`; the room exchange
//! drives it): hand the member the rows new since it last spoke, wait for its answer while relaying
//! any approval it asks for, then post its words or a pass. `speak_in_room` is the turn with the
//! calls other sessions wait on for it: each is told how the turn ended.

use std::collections::HashMap;
use std::future::Future;
use std::pin::Pin;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};
use std::task::{Context, Poll, Waker};

use async_trait::async_trait;
use mixdog_js::js_trim;
use mixdog_rt::TaskClass;
use serde_json::{Value, json};

use super::calls::{RoomCall, Settled};
use super::exchange::{Answer, Turn, TurnResult};
use super::rows::rows_since_cursor;
use super::turn_answer::spoken_text;
use super::turn_host::{Failure, MemberLabel, RoomRecord, RoomTurnHost, TurnState};
use super::turn_post::{HaltFuture, HaltOutcome, Polled, Speech, poll_for_answer, post_speech};
use super::turn_prompt::{PromptInput, PromptMember, RoomPrompt, room_turn_prompt};
use super::usage::room_usage_limit;

#[cfg(test)]
mod tests;

/// `PROMPT_ORIGIN_AGENT_REPORT` (`shared/prompt-origin.mjs`).
const AGENT_REPORT_ORIGIN: &str = "agent-report";

/// What a turn's submission carries besides the prompt.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct SubmitOptions {
    pub id: Option<String>,
    pub hop: Option<u32>,
    /// The newest user row the prompt shows: what a reaction must hit to count as this turn's answer.
    pub room_row: Option<String>,
    pub origin: Option<&'static str>,
}

/// What a member's turn needs from the room host beyond [`RoomTurnHost`].
#[async_trait]
pub trait MemberHost: RoomTurnHost {
    /// The room's record; fails once the room no longer exists.
    fn room(&self) -> Result<Arc<Mutex<RoomRecord>>, String>;
    /// The room's rows in log order.
    async fn rows(&self) -> Result<Vec<Value>, String>;
    /// The member's own session in this room, created on first use.
    async fn member_session(&self, member: &MemberLabel) -> Result<String, String>;
    /// Whether the member's bot is switched off now (it may be turned off mid-exchange).
    async fn switched_off(&self, agent_id: &str) -> Result<bool, String>;
    /// `false`: the daemon did not accept the turn.
    async fn submit(&self, session_id: &str, prompt: &RoomPrompt, options: &SubmitOptions) -> Result<bool, String>;
    async fn abort(&self, session_id: &str) -> Result<(), String>;
    /// Starts the room's save: what must happen now (recording the call, submitting the lane job)
    /// happens before this returns, and the returned future is the save finishing.
    fn persist(&self) -> PersistFuture;
}

/// A save in progress.
pub type PersistFuture = Pin<Box<dyn Future<Output = Result<(), String>> + Send>>;

/// `void host.persist().catch(log)`: starts the save now and lets it finish in the background; one
/// that fails is logged in Node's wording. A save that finished by the time it was started (its
/// failure is known at once) is logged at once, as Node's already-settled promise is before the
/// turn's next step.
pub(crate) fn save_in_background(host: &Arc<dyn MemberHost>) {
    fn fail(host: &dyn MemberHost, error: &str) {
        host.log(&format!("room {} save failed: Error: {error}", host.room_id()));
    }
    let mut saving = host.persist();
    match saving.as_mut().poll(&mut Context::from_waker(Waker::noop())) {
        Poll::Ready(Ok(())) => {}
        Poll::Ready(Err(error)) => fail(host.as_ref(), &error),
        Poll::Pending => {
            let host = Arc::clone(host);
            mixdog_rt::spawn("room-save", TaskClass::Work, async move {
                if let Err(error) = saving.await {
                    fail(host.as_ref(), &error);
                }
            });
        }
    }
}

/// One turn's view of every call it answers (`combinedCall`): its submission id (the first unused
/// one, else a fresh one), the highest hop, every asker and every relay.
#[derive(Clone)]
pub struct TurnCall {
    pub agent_id: String,
    /// Empty for none.
    pub id: String,
    pub hop: u32,
    pub asked_by: String,
    pub relay: String,
    /// Every call is a relay of the member's own reported work: a turn the runtime starts, not the
    /// user or a peer asking.
    pub relay_only: bool,
    covered: Vec<RoomCall>,
}

impl TurnCall {
    /// Points every covered call's watch at the turn submitted under `turn_id`: the calls answered
    /// under another id, and a call whose own id is this turn's after an earlier turn had it follow
    /// another (its old alias is replaced). A record that cannot be written fails the turn before
    /// it is submitted.
    pub async fn follow(&self, turn_id: &str) -> Result<(), String> {
        for each in &self.covered {
            let Some(follow) = &each.follow else { continue };
            if each.id.is_empty() || (each.id == turn_id && !each.is_followed()) {
                continue;
            }
            follow.follow(turn_id).await?;
            each.set_followed(each.id != turn_id);
        }
        Ok(())
    }
}

pub fn combined_call(host: &dyn RoomTurnHost, agent_id: &str, calls: &[RoomCall]) -> TurnCall {
    let unused = calls.iter().find(|call| !call.id.is_empty() && !call.is_used()).map(|call| call.id.clone());
    let id = match unused {
        Some(id) => id,
        None if calls.iter().any(|call| !call.id.is_empty()) => format!("rturn_{}", host.new_id()),
        None => String::new(),
    };
    let hop = calls.iter().map(|call| call.hop).max().unwrap_or(0);
    let mut askers: Vec<&str> = Vec::new();
    for call in calls.iter().filter(|call| !call.asked_by.is_empty()) {
        if !askers.contains(&call.asked_by.as_str()) {
            askers.push(&call.asked_by);
        }
    }
    let relay = calls.iter().filter(|call| !call.relay.is_empty()).map(|call| call.relay.as_str()).collect::<Vec<_>>().join("\n\n");
    TurnCall {
        agent_id: agent_id.to_owned(),
        id,
        hop,
        asked_by: askers.join(", "),
        relay_only: !calls.is_empty() && calls.iter().all(|call| !call.relay.is_empty()),
        relay,
        covered: calls.to_vec(),
    }
}

/// How a turn went, beside its answer (`outcome` of `speakInRoom`).
#[derive(Default)]
pub struct Outcome {
    text: Mutex<String>,
    failed: AtomicBool,
    submitted: AtomicBool,
    removed: AtomicBool,
}

impl Outcome {
    fn text(&self) -> String {
        self.text.lock().unwrap_or_else(|poisoned| poisoned.into_inner()).clone()
    }
}

fn str_of<'a>(row: &'a Value, field: &str) -> &'a str {
    row.get(field).and_then(Value::as_str).unwrap_or("")
}

fn is_seen(row: &Value) -> bool {
    row.get("seen").and_then(Value::as_bool).unwrap_or(false)
}

/// The pieces of one member's turn that its helpers share (`memberTurn`'s closure).
struct Ctx {
    host: Arc<dyn MemberHost>,
    state: Arc<TurnState>,
    room: Arc<Mutex<RoomRecord>>,
    labels: Arc<HashMap<String, MemberLabel>>,
    agent_id: String,
    member: MemberLabel,
    outcome: Arc<Outcome>,
    /// `sessionId`: the member's session once it is made.
    session: Mutex<String>,
    cursor_before: Mutex<Option<String>>,
}

impl Ctx {
    fn room(&self) -> MutexGuard<'_, RoomRecord> {
        self.room.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    fn gone(&self) -> bool {
        !self.room().members.contains(&self.agent_id)
    }

    fn interrupted(&self) -> bool {
        self.state.run.interrupted()
    }

    /// An abort whose failure is ignored.
    async fn abort_quietly(&self, session: &str) {
        let _ = self.host.abort(session).await;
    }

    /// A member removed from the room gets no turn, and one in flight is aborted: nothing is
    /// posted, its cursors go, its calls end cancelled.
    async fn left(&self) -> HaltOutcome {
        self.outcome.removed.store(true, Ordering::SeqCst);
        {
            let mut room = self.room();
            room.cursors.retain(|member, _| *member != self.agent_id);
            if let Some(seen) = room.seen.as_mut() {
                seen.retain(|member, _| *member != self.agent_id);
            }
        }
        let session = self.session.lock().unwrap_or_else(|poisoned| poisoned.into_inner()).clone();
        if !session.is_empty() {
            self.abort_quietly(&session).await;
        }
        HaltOutcome::Unavailable
    }

    /// The cursor as it was before this turn took the rows.
    fn restore_cursor(&self) {
        let before = self.cursor_before.lock().unwrap_or_else(|poisoned| poisoned.into_inner()).clone();
        let mut room = self.room();
        match before {
            None => room.cursors.retain(|member, _| *member != self.agent_id),
            Some(cursor) => {
                room.cursors.insert(self.agent_id.clone(), cursor);
            }
        }
    }

    /// A newer user message cuts this turn short: its answer would only respond to rows older than
    /// that message, so nothing is posted for it, the member's session is aborted, and the rows it
    /// was handed come again on its next turn, marked as already shown.
    async fn cut_short(&self) -> HaltOutcome {
        self.restore_cursor();
        let session = self.state.member_session();
        if !session.is_empty() {
            self.abort_quietly(&session).await;
        }
        HaltOutcome::Superseded
    }

    fn halted(self: &Arc<Self>) -> Option<HaltFuture> {
        let ctx = Arc::clone(self);
        if self.state.stop() {
            return Some(Box::pin(async { HaltOutcome::Stopped }));
        }
        if self.gone() {
            return Some(Box::pin(async move { ctx.left().await }));
        }
        if self.interrupted() {
            return Some(Box::pin(async move { ctx.cut_short().await }));
        }
        None
    }
}

fn of_halt(outcome: HaltOutcome) -> Answer {
    Answer::of(match outcome {
        HaltOutcome::Stopped => TurnResult::Stopped,
        HaltOutcome::Unavailable => TurnResult::Unavailable,
        HaltOutcome::Superseded => TurnResult::Superseded,
    })
}

/// What the try block of a turn came to.
enum Attempt {
    Return(Answer),
    Answered { answer: super::turn_answer::SessionAnswer, snapshot: Value, started_at: f64 },
}

impl Ctx {
    /// The try block of `memberTurn`: an `Err` is the catch block's.
    async fn attempt(self: &Arc<Self>, turn: &Turn, call: Option<&TurnCall>, rows: &[Value], shown: &[Value], waiting: bool) -> Result<Attempt, String> {
        let host = &self.host;
        let session = host.member_session(&self.member).await?;
        *self.session.lock().unwrap_or_else(|poisoned| poisoned.into_inner()) = session.clone();
        self.state.set_member_session(&session);
        if self.gone() {
            return Ok(Attempt::Return(of_halt(self.left().await)));
        }
        let (name, share_tools, member_ids) = {
            let room = self.room();
            (room.name.clone(), room.share_tools, room.members.clone())
        };
        let members: Vec<PromptMember> = member_ids.iter().map(|id| PromptMember { id: id.clone(), name: self.labels.get(id).map_or_else(|| id.clone(), |label| label.name.clone()) }).collect();
        let myself = PromptMember { id: self.member.id.clone(), name: self.member.name.clone() };
        let mentioned_by = if turn.mentioned_by.is_empty() { String::new() } else { self.labels.get(&turn.mentioned_by).map_or_else(|| turn.mentioned_by.clone(), |label| label.name.clone()) };
        let prompt = room_turn_prompt(&PromptInput {
            room_name: &name,
            myself: &myself,
            members: &members,
            rows: shown,
            share_tools,
            addressed: &turn.addressed,
            mentioned_by: &mentioned_by,
            instruction: &turn.instruction,
            scene: turn.scene,
            waiting: Some(waiting),
            asked_by: call.map_or("", |call| call.asked_by.as_str()),
            relay: call.map_or("", |call| call.relay.as_str()),
        });
        if let Some(last) = rows.last() {
            self.room().cursors.insert(self.agent_id.clone(), str_of(last, "id").to_owned());
        }
        // Every covered call's watch follows this turn, durably, before the turn can start; a
        // record that fails throws, so the turn is never submitted and its calls end failed.
        if let Some(call) = call.filter(|call| !call.id.is_empty()) {
            call.follow(&call.id).await?;
        }
        if let Some(halt) = self.halted() {
            return Ok(Attempt::Return(of_halt(halt.await)));
        }
        // Switched off while its session, the room history or the call records were awaited: still
        // no turn, and the rows it was not handed stay new.
        if host.switched_off(&self.agent_id).await? {
            self.restore_cursor();
            self.outcome.removed.store(true, Ordering::SeqCst);
            return Ok(Attempt::Return(Answer::of(TurnResult::Unavailable)));
        }
        // Stop, removal or a newer message may have landed during that read. Nothing may yield
        // between this check and the submit below.
        if let Some(halt) = self.halted() {
            return Ok(Attempt::Return(of_halt(halt.await)));
        }
        let started_at = host.now();
        // From here the submission id counts as used, even when the call throws.
        self.outcome.submitted.store(true, Ordering::SeqCst);
        let shown_user = shown.iter().rev().find(|row| str_of(row, "kind") == "user");
        let options = SubmitOptions {
            id: call.filter(|call| !call.id.is_empty()).map(|call| call.id.clone()),
            hop: call.filter(|call| call.hop > 0).map(|call| call.hop),
            room_row: shown_user.map(|row| str_of(row, "id")).filter(|id| !id.is_empty()).map(str::to_owned),
            // A relay turn that hands the member no new user row is system-caused: the
            // prompt-cache warmer does not learn from it.
            origin: (call.is_some_and(|call| call.relay_only) && shown_user.is_none()).then_some(AGENT_REPORT_ORIGIN),
        };
        if !host.submit(&session, &prompt, &options).await? {
            return Err("the turn was not accepted".to_owned());
        }
        // The member's session now holds every row up to the newest: a cut short restores the
        // cursor, never this.
        if let Some(handed) = rows.last().map(|row| str_of(row, "id")).filter(|id| !id.is_empty()) {
            self.room().seen.get_or_insert_with(HashMap::new).insert(self.agent_id.clone(), handed.to_owned());
        }
        // Stop's abort may have run before the daemon accepted this turn.
        if self.state.stop() {
            self.abort_quietly(&session).await;
            return Ok(Attempt::Return(Answer::of(TurnResult::Stopped)));
        }
        let ctx = Arc::clone(self);
        let halted = move || ctx.halted();
        match poll_for_answer(host.as_ref(), &self.state, &session, started_at as f64, &halted).await? {
            Polled::Halted(outcome) => Ok(Attempt::Return(of_halt(outcome))),
            Polled::Answered { answer, snapshot } => Ok(Attempt::Answered { answer, snapshot, started_at: started_at as f64 }),
        }
    }
}

/// `memberTurn`.
pub async fn member_turn(
    host: &Arc<dyn MemberHost>,
    state: &Arc<TurnState>,
    labels: &Arc<HashMap<String, MemberLabel>>,
    agent_id: &str,
    turn: &Turn,
    call: Option<&TurnCall>,
    outcome: &Arc<Outcome>,
) -> Result<Answer, String> {
    let room = host.room()?;
    let member = labels.get(agent_id).cloned().unwrap_or_else(|| MemberLabel { id: agent_id.to_owned(), name: agent_id.to_owned(), route: Value::Null, description: String::new(), disabled: false });
    let ctx = Arc::new(Ctx {
        host: Arc::clone(host),
        state: Arc::clone(state),
        room,
        labels: Arc::clone(labels),
        agent_id: agent_id.to_owned(),
        member,
        outcome: Arc::clone(outcome),
        session: Mutex::default(),
        cursor_before: Mutex::default(),
    });
    // A member removed from the room (its bot was deleted) gets no turn.
    if ctx.gone() {
        return Ok(of_halt(ctx.left().await));
    }
    // A bot switched off since the exchange began stays a member but takes no turn; the calls
    // waiting on it end cancelled.
    if host.switched_off(agent_id).await? {
        outcome.removed.store(true, Ordering::SeqCst);
        return Ok(Answer::of(TurnResult::Unavailable));
    }
    // Whether the user's newest message still has no answer in the room.
    let waiting = state.waiting();
    let rows = host.rows().await?;
    let (cursor, seen_id) = {
        let room = ctx.room();
        (room.cursors.get(agent_id).cloned().unwrap_or_default(), room.seen.as_ref().and_then(|seen| seen.get(agent_id)).cloned().unwrap_or_default())
    };
    let mut shown = rows_since_cursor(&rows, &cursor, agent_id, &seen_id);
    // A user still waiting keeps their newest message in view, as context when this member was
    // already handed it.
    let asked = if waiting { rows.iter().rev().find(|row| str_of(row, "kind") == "user") } else { None };
    if let Some(asked) = asked.filter(|asked| !shown.iter().any(|row| row.get("id") == asked.get("id"))) {
        let mut context = asked.clone();
        context["seen"] = Value::Bool(true);
        shown.insert(0, context);
    }
    // Nothing new, nobody asking for it (the user, a peer's @mention or the supervisor's note) and
    // no user waiting: there is no turn to hand, so none is; the member counts as passing and
    // nothing is posted.
    let called = !turn.addressed.is_empty() || !turn.mentioned_by.is_empty() || !js_trim(&turn.instruction).is_empty() || call.is_some();
    if !waiting && !called && !shown.iter().any(|row| !is_seen(row)) {
        return Ok(Answer::of(TurnResult::Pass));
    }
    state.start_speaking(agent_id, &ctx.member.name, format!("room-typing-{}", host.new_id()));
    host.republish();
    *ctx.cursor_before.lock().unwrap_or_else(|poisoned| poisoned.into_inner()) = ctx.room().cursors.get(agent_id).cloned();
    let attempt = ctx.attempt(turn, call, &rows, &shown, waiting).await;
    let attempt = match attempt {
        Ok(attempt) => Ok(attempt),
        Err(error) => {
            host.log(&format!("{agent_id} could not speak in room {}: {error}", host.room_id()));
            if state.stop() {
                Err(Answer::of(TurnResult::Stopped))
            } else if ctx.gone() {
                Err(of_halt(ctx.left().await))
            } else if ctx.interrupted() {
                Err(of_halt(ctx.cut_short().await))
            } else {
                outcome.failed.store(true, Ordering::SeqCst);
                state.push_failure(Failure { id: agent_id.to_owned(), name: ctx.member.name.clone(), reason: error });
                Err(Answer { failed: true, ..Answer::of(TurnResult::Pass) })
            }
        }
    };
    // `finally`
    state.set_approval(None);
    // A save in passing: the exchange's own saves decide whether the room can go on.
    save_in_background(host);
    let (answer, snapshot, started_at) = match attempt {
        Err(answer) | Ok(Attempt::Return(answer)) => return Ok(answer),
        Ok(Attempt::Answered { answer, snapshot, started_at }) => (answer, snapshot, started_at),
    };
    if state.stop() {
        return Ok(Answer::of(TurnResult::Stopped));
    }
    if ctx.gone() {
        return Ok(of_halt(ctx.left().await));
    }
    if ctx.interrupted() {
        let cut = of_halt(ctx.cut_short().await);
        save_in_background(host);
        return Ok(cut);
    }
    // A relay of the member's own work is no turn to pass either.
    let relay = call.is_some_and(|call| !call.relay.is_empty());
    let text = spoken_text(&answer, waiting || relay);
    // A member whose answer was a reaction on the user's row alone has taken its turn: the reaction
    // shows under that row, and no pass row is posted.
    if text.is_empty() && answer.reacted {
        return Ok(Answer::of(TurnResult::Pass));
    }
    if text.is_empty() {
        let failed = answer.status != "done";
        outcome.failed.store(failed, Ordering::SeqCst);
        if !failed {
            let id = format!("row_{}", host.new_id());
            let row = json!({ "id": id, "kind": "pass", "speaker": agent_id, "name": ctx.member.name, "at": host.now(), "text": "" });
            host.post(vec![row]).await?;
            return Ok(Answer::of(TurnResult::Pass));
        }
        let done = snapshot
            .get("items")
            .and_then(Value::as_array)
            .and_then(|items| items.iter().find(|item| str_of(item, "kind") == "turndone" && item.get("id") == Some(&answer.id)))
            .cloned()
            .unwrap_or(Value::Null);
        // A usage limit fails every member alike: the exchange stops on it and says so once,
        // instead of showing this turn as one more failure.
        if let Some(usage) = room_usage_limit(&done, &ctx.member.route) {
            return Ok(Answer { failed: true, usage: Some(usage), ..Answer::of(TurnResult::Pass) });
        }
        state.push_failure(Failure { id: agent_id.to_owned(), name: ctx.member.name.clone(), reason: done.get("detail").and_then(Value::as_str).unwrap_or("").to_owned() });
        return Ok(Answer { failed: true, ..Answer::of(TurnResult::Pass) });
    }
    *outcome.text.lock().unwrap_or_else(|poisoned| poisoned.into_inner()) = text.clone();
    let speech = Speech { agent_id, member: &ctx.member, text: &text, snapshot: &snapshot, started_at };
    let mention = post_speech(host.as_ref(), state, &ctx.room, labels, &speech).await?;
    Ok(Answer { mention: mention.filter(|mention| !mention.is_empty()), ..Answer::of(TurnResult::Speech) })
}

/// One member's turn: hand it the new rows, wait for its answer (relaying any approval it asks for
/// into the room), then post its words or a pass. The turns other sessions wait on for this member
/// (`calls`) are all answered by this one turn: each is told how it ended, done with the posted
/// words ('' for a pass), failed, or cancelled on a stop. A turn a newer message cut short settles
/// none of them: the exchange hands them on to the next one (a submission id this turn used is not
/// used again). The turn takes the first unused submission id among them (a fresh one when all are
/// used) and their highest hop; every covered call's watch follows that id, recorded before the
/// turn is submitted.
pub async fn speak_in_room(host: &Arc<dyn MemberHost>, state: &Arc<TurnState>, labels: &Arc<HashMap<String, MemberLabel>>, agent_id: &str, turn: &Turn, calls: &[RoomCall]) -> Result<Answer, String> {
    let settle = |detail: Settled| {
        for call in calls {
            call.settle_with(&detail);
        }
    };
    let combined = (!calls.is_empty()).then(|| combined_call(host.as_ref(), agent_id, calls));
    let outcome = Arc::new(Outcome::default());
    let answer = match member_turn(host, state, labels, agent_id, turn, combined.as_ref(), &outcome).await {
        Ok(answer) => answer,
        Err(error) => {
            settle(Settled { status: "failed".into(), error: Some(error.clone()), content: None });
            return Err(error);
        }
    };
    if answer.result == TurnResult::Superseded {
        if outcome.submitted.load(Ordering::SeqCst) {
            let id = combined.as_ref().map_or("", |call| call.id.as_str());
            for each in calls.iter().filter(|each| each.id == id) {
                each.mark_used();
            }
        }
    } else if answer.result == TurnResult::Stopped || outcome.removed.load(Ordering::SeqCst) {
        settle(Settled { status: "cancelled".into(), error: None, content: None });
    } else if outcome.failed.load(Ordering::SeqCst) {
        settle(Settled { status: "failed".into(), error: Some("The member could not reply in the room.".into()), content: None });
    } else {
        settle(Settled { status: "done".into(), error: None, content: Some(outcome.text()) });
    }
    Ok(answer)
}
