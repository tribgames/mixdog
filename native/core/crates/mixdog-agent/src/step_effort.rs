//! Auto effort for each tool-result step of a turn.
//!
//! After a tool batch the host's effort judge rates the decision the model
//! faces next; the judged effort is stored on the batch's last tool result,
//! where [`EffortRoute::project`](crate::effort::EffortRoute::project) turns it
//! into the mid-conversation effort change. The mark lives in the transcript,
//! so every later request rebuilds the same history and the prompt cache keeps
//! hitting. A missing or failing judge leaves the step at the effort in force.
//!
//! The judge is local inference. It runs beside the next iteration's pre-send
//! work, and the next request waits for it up to [`STEP_EFFORT_GRACE`] (Node
//! `step-auto-effort.mjs`); a slower judgment lands on the request after.

use std::sync::Arc;
use std::sync::Mutex;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use async_trait::async_trait;
use mixdog_core_api::domain::provider::Role;
use mixdog_core_api::domain::provider::ToolCall;
use mixdog_rt::TaskClass;

use crate::run::AgentError;
use crate::run::Run;

/// What the turn's auto effort is anchored to.
#[derive(Clone, Debug)]
pub struct StepAutoEffort {
    /// The user's request of the turn.
    pub request: String,
    /// The effort auto effort moves from.
    pub base: String,
}

pub struct StepCall {
    pub name: String,
    /// The first 600 code points of the arguments' JSON.
    pub args: String,
    pub result: String,
}

pub struct StepInput {
    pub request: String,
    /// The tool-result step number within the turn.
    pub step: u32,
    /// The model's text of this round.
    pub plan: String,
    pub calls: Vec<StepCall>,
}

/// A resolved judgment.
#[derive(Clone, PartialEq, Eq, Debug)]
pub struct StepResult {
    /// The per-request effort of a custom route.
    pub level: Option<String>,
    /// The session-named effort to record on the tool result.
    pub effort: Option<String>,
}

/// The effort judge and the ladder behind it (model, options, snapping).
///
/// A dead or stuck worker, a failed model load and a model that is not
/// installed all answer `None`, which leaves the step at the effort in force.
/// It is cancel-safe: the loop drops it when the run is cancelled.
#[async_trait]
pub trait StepEffortJudge: Send + Sync {
    async fn judge(&self, input: StepInput) -> Option<StepResult>;
}

/// How long a request waits for its step judgment (Node `STEP_EFFORT_GRACE_MS`;
/// measured judge p90 ≈ 284 ms).
pub const STEP_EFFORT_GRACE: Duration = Duration::from_millis(300);

type Slot = Arc<Mutex<Option<StepResult>>>;

/// A judgment task, stopped when it is dropped.
struct Judging(tokio::task::JoinHandle<()>);

impl Drop for Judging {
    fn drop(&mut self) {
        self.0.abort();
    }
}

/// The judgment started after a batch; the next request waits for it.
pub(crate) struct PendingStep {
    /// Call id of the tool result the mark lands on.
    target: String,
    slot: Slot,
    task: Judging,
    /// A newer step took its place before it ran: it skips its judgment.
    superseded: Arc<AtomicBool>,
    /// A request has waited for it (later requests do not wait again).
    sent: bool,
    applied: bool,
}

fn args_text(call: &ToolCall) -> String {
    let json = match &call.arguments {
        mixdog_protocol::JsonValue::String(s) => s.clone(),
        other => other.to_string(),
    };
    json.chars().take(600).collect()
}

impl Run {
    /// Before a request is built: waits up to [`STEP_EFFORT_GRACE`] for the
    /// judgment of the step just taken and applies it if it resolved. A slower
    /// one leaves this request at the effort in force and lands on the next
    /// batch ([`Self::mark_step_effort`]).
    pub(crate) async fn apply_step_effort(&mut self) -> Result<(), AgentError> {
        let cancel = self.cancel.clone();
        let Some(pending) = self.step_effort.as_mut() else {
            return Ok(());
        };
        if pending.sent {
            return Ok(());
        }
        if !pending.task.0.is_finished() {
            // The grace runs on the host's timer (`RunEnv::waiter`), so a test moves it explicitly.
            let waiter = self.env.waiter.clone();
            let judged = &mut pending.task.0;
            let grace = async move {
                tokio::select! {
                    biased;
                    // A judge that panicked or was stopped leaves the step unmarked.
                    _ = judged => {}
                    () = waiter.wait(STEP_EFFORT_GRACE) => {}
                }
            };
            if mixdog_rt::Scope::new().cancel(&cancel).run(grace).await.done().is_none() {
                return Err(AgentError::Aborted);
            }
        }
        pending.sent = true;
        if !pending.task.0.is_finished() || cancel.is_cancelled() {
            return Ok(());
        }
        let target = pending.target.clone();
        let result = pending.slot.lock().unwrap_or_else(std::sync::PoisonError::into_inner).clone();
        if let Some(result) = result {
            let applied = self.apply_result(&target, &result);
            if let Some(pending) = self.step_effort.as_mut() {
                pending.applied = applied;
            }
        }
        Ok(())
    }

    /// Records `result` on the tool result `target` and, for a custom route,
    /// as the per-request effort; false when `target` is not in the transcript.
    fn apply_result(&mut self, target: &str, result: &StepResult) -> bool {
        let Some(index) = self
            .messages
            .iter()
            .position(|m| m.role() == Role::Tool && m.tool_call_id() == Some(target))
        else {
            return false;
        };
        if let Some(level) = &result.level {
            self.config.options.effort = Some(level.clone());
        }
        let marked = self.config.effort.as_ref().and_then(|wiring| {
            let route = &wiring.route;
            let seed = route.seed.as_ref()?;
            let effort = result.effort.as_ref()?;
            route.allowed.contains(effort).then(|| {
                let mut snapshot = seed.clone();
                snapshot.effort.clone_from(effort);
                snapshot
            })
        });
        if let Some(snapshot) = marked {
            self.messages[index].effort = Some(snapshot);
            self.env.sink.replace(&self.messages, &crate::env::Rewrite::default());
        }
        true
    }

    /// After a tool batch: starts judging the next step (not awaited here).
    pub(crate) fn mark_step_effort(&mut self, calls: &[ToolCall], results_from: usize) {
        let (Some(auto), Some(judge)) = (self.config.step_auto_effort.clone(), self.env.step_judge.clone())
        else {
            return;
        };
        if self.config.effort.as_ref().and_then(|w| w.route.seed.as_ref()).is_none()
            || self.cancel.is_cancelled()
        {
            return;
        }
        let results: Vec<(String, String)> = self.messages[results_from..]
            .iter()
            .filter(|m| m.role() == Role::Tool)
            .filter_map(|m| Some((m.tool_call_id()?.to_owned(), m.text())))
            .filter(|(id, _)| calls.iter().any(|c| &c.id == id))
            .collect();
        let Some(last) = results.last().map(|(id, _)| id.clone()) else {
            return;
        };
        // A judgment that resolved after its request went out: this batch carries
        // it. One still running is superseded: this step's judgment queues behind
        // it and any judgment waiting in between is skipped (latest wins), so the
        // judge never has more than one running and one queued.
        let mut behind = None;
        if let Some(previous) = self.step_effort.take() {
            if previous.task.0.is_finished() {
                let result = previous.slot.lock().unwrap_or_else(std::sync::PoisonError::into_inner).take();
                if let Some(result) = result.filter(|_| !previous.applied) {
                    self.apply_result(&last, &result);
                }
            } else {
                previous.superseded.store(true, Ordering::SeqCst);
                behind = Some(previous.task);
            }
        }
        self.auto_effort_steps += 1;
        let plan = self
            .messages
            .iter()
            .rev()
            .find(|m| m.role() == Role::Assistant && m.tool_calls().iter().any(|c| calls.iter().any(|x| x.id == c.id)))
            .map(|m| m.text())
            .unwrap_or_default();
        let input = StepInput {
            request: auto.request,
            step: self.auto_effort_steps,
            plan,
            calls: calls
                .iter()
                .map(|call| StepCall {
                    name: call.name.clone(),
                    args: args_text(call),
                    result: results
                        .iter()
                        .find(|(id, _)| id == &call.id)
                        .map(|(_, text)| text.clone())
                        .unwrap_or_default(),
                })
                .collect(),
        };
        let slot: Slot = Arc::new(Mutex::new(None));
        let writer = Arc::clone(&slot);
        let superseded = Arc::new(AtomicBool::new(false));
        let skip = Arc::clone(&superseded);
        let handle = mixdog_rt::spawn("agent.step-effort", TaskClass::Work, async move {
            if let Some(mut behind) = behind {
                let _ = (&mut behind.0).await;
            }
            if skip.load(Ordering::SeqCst) {
                return;
            }
            let judged = judge.judge(input).await;
            *writer.lock().unwrap_or_else(std::sync::PoisonError::into_inner) = judged;
        });
        self.step_effort =
            Some(PendingStep { target: last, slot, task: Judging(handle), superseded, sent: false, applied: false });
    }
}
