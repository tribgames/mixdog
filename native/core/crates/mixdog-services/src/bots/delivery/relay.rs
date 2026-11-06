//! The relay of posted task results (`createHomeRelay` of agent-home-delivery.mjs): owed results
//! wake the agent with one hidden turn per batch. A batch is stored with its wake id BEFORE the
//! wake is submitted and dropped once its relay turn settled done, so a restart in between re-checks
//! that exact id; a relay turn that did not finish is owed again under a fresh id. Results owed
//! later form a new batch. A replayed run id is never queued again.

use std::collections::{HashMap, HashSet};
use std::sync::Arc;
use std::time::Duration;

use mixdog_core_base::rooms::ids::room_member_of_session;
use serde_json::Value;

use super::env::WakeFollow;
use super::home::{AgentHomeDelivery, lock};
use super::queue::send_depth;
use super::rows::{
    agent_task_relay_failed_message, agent_task_wake_prompt, message_id_of, num_or_zero, posted_message, routine_result_notice, str_of,
};
use crate::bots::live::WakeOptions;

/// How a relay turn of this process went.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum RelayState {
    Running,
    Done,
    Failed,
}

fn message_ids(value: Option<&Value>) -> impl Iterator<Item = &str> {
    value.and_then(Value::as_array).into_iter().flatten().filter_map(Value::as_str)
}

/// The submissions a stored user message delivered: a turn's prompt (`checkpointId`,
/// `submissionIds` of a merged batch) or a steered message.
fn submission_ids_of(message: &Value) -> Vec<&str> {
    if str_of(message.get("role")) != "user" {
        return Vec::new();
    }
    let transcript = message.pointer("/meta/transcript");
    let mut ids: Vec<&str> = Vec::new();
    ids.extend(transcript.and_then(|t| t.get("checkpointId")).and_then(Value::as_str));
    ids.extend(message_ids(transcript.and_then(|t| t.get("submissionIds"))));
    ids.extend(message_ids(message.pointer("/meta/submissionIds")));
    ids
}

/// The text of a message's content (a string, or its text parts).
fn message_text(content: Option<&Value>) -> String {
    match content {
        Some(Value::String(text)) => text.clone(),
        Some(Value::Array(parts)) => parts
            .iter()
            .map(|part| match part {
                Value::String(text) => text.clone(),
                other if str_of(other.get("type")) == "text" => super::rows::text_of(other.get("text")),
                _ => String::new(),
            })
            .collect(),
        _ => String::new(),
    }
}

/// How the turn that took a submission ended, from a session's stored `messages` (the part of
/// `submissionOutcome` a relay reads): the end status once that turn recorded one (its completion,
/// an interruption marker, or the next turn's prompt), `Open` while it has none; `None` when no
/// turn took it.
#[derive(Debug, PartialEq, Eq)]
enum Outcome {
    Open,
    Ended(&'static str),
}

fn submission_outcome(messages: &[Value], run_id: &str) -> Option<Outcome> {
    let start = messages.iter().position(|message| submission_ids_of(message).contains(&run_id))?;
    for (index, message) in messages.iter().enumerate().skip(start) {
        if let Some(completion) = message.pointer("/meta/transcript/completion").filter(|c| super::rows::truthy(c)) {
            return Some(Outcome::Ended(match str_of(completion.get("status")) {
                "done" | "completed" => "completed",
                "failed" => "failed",
                _ => "cancelled",
            }));
        }
        if index == start || str_of(message.get("role")) != "user" {
            continue;
        }
        let checkpoint = message.pointer("/meta/transcript/checkpointId").is_some_and(super::rows::truthy);
        if message_text(message.get("content")).starts_with("[Request interrupted") || checkpoint {
            return Some(Outcome::Ended("cancelled"));
        }
    }
    Some(Outcome::Open)
}

impl AgentHomeDelivery {
    /// How `batch`'s relay turn went: `None` when no turn took it. A turn an earlier process took
    /// decides by its recorded end; one with none was cut off by the restart. A room member's
    /// batch may be answered by a turn under another submission id (`follows`, recorded before that
    /// turn was submitted).
    fn relay_of(&self, batch: &Value, messages: &[Value], taken: &HashSet<String>) -> Option<RelayState> {
        let id = str_of(batch.get("id"));
        if let Some(local) = lock(&self.relays).get(id) {
            return Some(*local);
        }
        let follows = str_of(batch.get("follows"));
        let turn_id = if follows.is_empty() { id } else { follows };
        if !taken.contains(turn_id) {
            return None;
        }
        Some(match submission_outcome(messages, turn_id) {
            Some(Outcome::Ended("completed")) => RelayState::Done,
            _ => RelayState::Failed,
        })
    }

    /// The relay turn of `batch` did not finish: owe it again after a backoff, or, past the last
    /// try, leave a note in the thread and wake nobody. False while the thread is busy.
    async fn retry_relay(self: &Arc<Self>, home: &str, batch: &Value) -> Result<bool, String> {
        let tries = num_or_zero(batch.get("tries")) as u64 + 1;
        if let Some(delay) = self.config.wake_retry_delays_ms.get(tries as usize - 1) {
            self.log(&format!("the relay turn in {home} did not finish (try {tries}); waking it again later"));
            self.queue.rewake(home, str_of(batch.get("id")), tries, self.now_ms() + *delay as i64).await?;
            return Ok(true);
        }
        self.abandon_relay(home, batch, &format!("did not finish after {tries} tries"), tries).await
    }

    /// Gives up on `batch`'s relay: a note in the thread (once), nobody woken. False while the
    /// thread is busy (try again once it is idle).
    async fn abandon_relay(&self, home: &str, batch: &Value, why: &str, tries: u64) -> Result<bool, String> {
        if self.busy(home) {
            return Ok(false);
        }
        self.log(&format!("the relay turn in {home} {why}; its results stay posted unrelayed"));
        let message_id = message_id_of(&format!("relay_{}", str_of(batch.get("id"))));
        if let Some(thread) = self.threads.load(home).await? {
            let noted = thread.messages.iter().any(|message| str_of(message.pointer("/meta/transcript/messageId")) == message_id);
            if !noted {
                let now = self.now_ms();
                let count = batch.get("runIds").and_then(Value::as_array).map_or(0.0, |ids| ids.len() as f64) + num_or_zero(batch.pointer("/overflow/count"));
                let message = posted_message(&agent_task_relay_failed_message(count, tries, &message_id, now));
                self.threads.append(home, vec![message.clone()], Some(now)).await?;
                let mut notice = routine_result_notice(&message);
                if let Some(map) = notice.as_object_mut() {
                    map.insert("messageId".into(), Value::from(message_id.as_str()));
                    if let Some(at) = message.pointer("/meta/transcript/at") {
                        map.insert("at".into(), at.clone());
                    }
                }
                self.notice_live(home, notice).await;
            }
        }
        self.queue.woke(home, str_of(batch.get("id"))).await?;
        Ok(true)
    }

    /// Wakes `home` (its idle thread, just posted to) for its next owed batch.
    pub(super) async fn wake_owed(self: &Arc<Self>, home: &str) -> Result<(), String> {
        let Some(thread) = self.threads.load(home).await? else { return Ok(()) };
        let messages = thread.messages;
        let by_id: HashMap<&str, &Value> = messages.iter().filter_map(|message| Some((message.pointer("/meta/transcript/messageId")?.as_str()?, message))).collect();
        let taken: HashSet<String> = messages.iter().flat_map(submission_ids_of).map(String::from).collect();
        let (batch, woken, more) = loop {
            let batch = match self.queue.wakes(home).await?.batches.into_iter().next() {
                Some(batch) => batch,
                None => match self.queue.batch_wake(home).await? {
                    Some(batch) => batch,
                    None => return Ok(()),
                },
            };
            let batch_id = str_of(batch.get("id")).to_string();
            match self.relay_of(&batch, &messages, &taken) {
                // Its settle drains again.
                Some(RelayState::Running) => return Ok(()),
                Some(settled) => {
                    lock(&self.relays).remove(&batch_id);
                    if settled == RelayState::Done {
                        self.queue.woke(home, &batch_id).await?;
                    } else if !self.retry_relay(home, &batch).await? {
                        self.later(home, self.config.busy_retry);
                        return Ok(());
                    }
                    continue;
                }
                None => {}
            }
            let wait = num_or_zero(batch.get("notBefore")) - self.now_ms() as f64;
            if wait > 0.0 {
                self.later(home, Duration::from_millis(wait as u64));
                return Ok(());
            }
            let woken: Vec<Value> = batch
                .get("runIds")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
                .filter_map(|run_id| by_id.get(message_id_of(&super::rows::js_str(Some(run_id))).as_str()).map(|message| (*message).clone()))
                .collect();
            // Results past the wake cap ride this wake as a count of rows to read.
            let newest = message_id_of(&super::rows::js_str(batch.pointer("/overflow/newest")));
            let more = if by_id.contains_key(newest.as_str()) { num_or_zero(batch.pointer("/overflow/count")) } else { 0.0 };
            if !woken.is_empty() || more != 0.0 {
                break (batch, woken, more);
            }
            // Its rows are gone with a thread reset.
            self.queue.woke(home, &batch_id).await?;
        };
        self.submit_wake(home, &batch, &woken, more).await
    }

    /// Submits the relay turn of `batch` and watches how it ends.
    async fn submit_wake(self: &Arc<Self>, home: &str, batch: &Value, woken: &[Value], more: f64) -> Result<(), String> {
        let batch_id = str_of(batch.get("id")).to_string();
        lock(&self.relays).insert(batch_id.clone(), RelayState::Running);
        // The reports answer sends this home made itself: the wake turn resumes at the depth of
        // the turns that sent them, 0 for work the user or a routine started, so only
        // bot-descended chains keep counting.
        let hop = woken.iter().map(|message| send_depth(message.pointer("/meta/routine"))).fold(0.0_f64, f64::max);
        let options = WakeOptions { id: batch_id.clone(), hop: hop as u32 };
        let prompt = agent_task_wake_prompt(woken, more);
        // A room member relays in its room (the room host runs that turn), any other thread in a
        // hidden turn of its own.
        let started = if room_member_of_session(home).is_some() {
            let follow = WakeFollow::of_batch(Arc::clone(&self.queue), home.to_string(), batch_id.clone());
            self.room_relay.relay(home, &prompt, options, follow).await
        } else if let Some(surface) = self.live.get() {
            surface.wake(home, &prompt, options).await
        } else {
            lock(&self.relays).remove(&batch_id);
            self.later(home, self.config.busy_retry);
            return Ok(());
        };
        let turn = match started {
            Ok(Some(turn)) => turn,
            refused => {
                let reason = refused.err().unwrap_or_else(|| "the wake turn was refused".to_string());
                lock(&self.relays).remove(&batch_id);
                // A wake refused (or failing) every time is retried a bounded number of times.
                let refusals = num_or_zero(batch.get("refusals")) as u64 + 1;
                if refusals >= self.config.wake_refusal_limit {
                    if self.abandon_relay(home, batch, &format!("could not start ({refusals} refusals)"), refusals).await? {
                        return Ok(());
                    }
                    self.later(home, self.config.busy_retry);
                    return Ok(());
                }
                let mut fields = serde_json::Map::new();
                fields.insert("refusals".into(), Value::from(refusals));
                self.queue.mark_batch(home, &batch_id, fields).await?;
                self.log(&format!("waking {home} failed ({refusals}/{}), retrying: {reason}", self.config.wake_refusal_limit));
                self.later(home, self.config.missing_retry);
                return Ok(());
            }
        };
        // `settled` resolves the relay turn's end status: only 'done' retires the batch.
        let this = Arc::clone(self);
        let home = home.to_string();
        tokio::spawn(async move {
            let status = turn.settled.await.unwrap_or_default();
            lock(&this.relays).insert(batch_id, if status == "done" { RelayState::Done } else { RelayState::Failed });
            drop(this.drain(&home));
        });
        Ok(())
    }
}
