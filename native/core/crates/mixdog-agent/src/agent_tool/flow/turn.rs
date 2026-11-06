//! One worker turn under its job (Node `runSpawn` in `spawn-flow/spawn-run.mjs` and `runSend` in
//! `send-flow.mjs`, which differ in the identity they report, the route the turn takes and the
//! subagent events a spawn emits): turn-review collection, the terminal completion value
//! (abnormal-empty finishes promoted to errors), the cancelled turn's partial handoff and
//! terminal accounting.
//!
//! Not ported: the watchdog's partial handoff and the stopped shell jobs it names. Both exist
//! only for a turn the progress watchdog aborted on silence (or a turn timeout reaping its jobs);
//! a user's abort never reaches them (`armTurnTimeoutOnProviderError` skips an aborted turn).

use std::sync::Arc;

use serde_json::Map;
use serde_json::Value;

use super::early::EarlyNotice;
use super::notify::NotifyContext;
use super::notify::worker_notify;
use super::reconcile::FinalStatus;
use super::reconcile::JobHandle;
use super::reconcile::TerminalHook;
use super::reconcile::reconcile_cancelled;
use super::reconcile::reconcile_failed;
use super::reconcile::reconcile_finally;
use super::result::WorkerResult;
use super::result::completion_value;
use super::result::turn_partial_handoff;
use super::review::TurnReview;
use super::seams::SubagentEvents;
use super::seams::TurnError;
use super::seams::TurnHooks;
use super::seams::TurnKind;
use super::seams::TurnRequest;
use super::seams::TurnReviews;
use super::seams::TurnSessions;
use super::seams::WorkerInbox;
use super::worker_turns::TurnOwner;

/// A prepared worker's turn.
pub struct TurnPlan {
    pub kind: TurnKind,
    pub session_id: String,
    pub parent_session_id: Option<String>,
    pub session_owner_id: Option<String>,
    pub tag: String,
    /// The agent the failure messages name.
    pub agent: String,
    /// The owner-facing identity of the result: a spawn's `{ tag, sessionId, …presetDescriptor }`,
    /// a send's `{ tag, sessionId, agent, provider, model }`.
    pub identity: Map<String, Value>,
    pub prompt: String,
    /// The caller's forwarded files, which ride along as attachment parts.
    pub attachments: Vec<Value>,
    pub context: Option<Value>,
    pub cwd: String,
    /// Host-set only (a routine executor): the trusted text skills are selected from.
    pub skill_selection: Option<String>,
    /// The surface hands off only (`sessionSurface.canonical`).
    pub canonical: bool,
}

pub struct TurnRunner {
    sessions: Arc<dyn TurnSessions>,
    turns: Arc<dyn TurnOwner>,
    reviews: Arc<dyn TurnReviews>,
    events: Arc<dyn SubagentEvents>,
    inbox: Arc<dyn WorkerInbox>,
    early: Arc<EarlyNotice>,
}

impl TurnRunner {
    pub fn new(
        sessions: Arc<dyn TurnSessions>,
        turns: Arc<dyn TurnOwner>,
        reviews: Arc<dyn TurnReviews>,
        events: Arc<dyn SubagentEvents>,
        inbox: Arc<dyn WorkerInbox>,
        early: Arc<EarlyNotice>,
    ) -> Self {
        Self { sessions, turns, reviews, events, inbox, early }
    }

    /// A cancelled turn reports the output it produced before it stopped.
    async fn settle_cancelled(&self, plan: &TurnPlan, job: Option<&JobHandle>, start: usize, error: Option<&TurnError>, result_content: Option<&str>) {
        let rows = self.sessions.assistant_texts(&plan.session_id, start).await;
        let partial = turn_partial_handoff(error.and_then(|e| e.partial_handoff.as_deref()), &rows);
        let content = partial.filter(|p| !p.is_empty()).or_else(|| result_content.filter(|c| !c.is_empty()).map(str::to_owned)).unwrap_or_default();
        if let Some(job) = job {
            reconcile_cancelled(job, &plan.identity, &content);
        }
    }

    async fn attempt(
        &self,
        plan: &TurnPlan,
        context: &NotifyContext,
        job: Option<&Arc<JobHandle>>,
        review: Option<&Arc<TurnReview>>,
        submission_id: String,
        status: &mut FinalStatus,
    ) -> Result<WorkerResult, String> {
        let start = self.sessions.message_count(&plan.session_id).await;
        let on_terminal_result = job.map(|job| {
            let hook = Arc::new(TerminalHook {
                job: job.clone(),
                review: review.cloned(),
                identity: plan.identity.clone(),
                canonical: plan.canonical,
                agent: plan.agent.clone(),
                early: self.early.clone(),
                notify_context: context.clone(),
            });
            Arc::new(move |terminal: &super::seams::TurnResult| hook.call(terminal)) as Arc<dyn Fn(&super::seams::TurnResult) + Send + Sync>
        });
        let on_tool_result = {
            let review = review.cloned();
            Arc::new(move |message: &super::seams::ToolResultMessage| {
                if let Some(review) = &review {
                    review.on_tool_result(message);
                }
            })
        };
        let request = TurnRequest {
            kind: plan.kind,
            session_id: plan.session_id.clone(),
            prompt: plan.prompt.clone(),
            attachments: plan.attachments.clone(),
            context: plan.context.clone(),
            cwd: plan.cwd.clone(),
            skill_selection: plan.skill_selection.clone(),
            hooks: TurnHooks { submission_id, notify: worker_notify(self.inbox.clone(), &plan.session_id), on_tool_result, on_terminal_result },
            slot: job.and_then(|j| j.slot()),
        };
        let failure = match self.sessions.run_turn(request).await {
            Ok(result) => {
                // The early preview does not promise body suppression, so the board's
                // notification fires exactly once with output via the reconcile/finally path.
                let value = completion_value(&plan.identity, &result, plan.canonical, &plan.agent);
                if job.is_some_and(|j| j.is_cancelled()) {
                    self.settle_cancelled(plan, job.map(|j| &**j), start, None, Some(&result.content)).await;
                    *status = FinalStatus::Cancelled;
                    return Ok(value);
                }
                // An abnormal-empty finish is thrown, so the failure path below (and the finally
                // reconcile, as `failed`) render the accurate reason.
                let Some(error) = value.error.clone() else { return Ok(value) };
                *status = FinalStatus::Error;
                if let Some(job) = job {
                    job.set_terminal_value(value);
                }
                TurnError::new(error)
            }
            Err(error) => error,
        };
        if job.is_some_and(|j| j.is_cancelled()) {
            self.settle_cancelled(plan, job.map(|j| &**j), start, Some(&failure), None).await;
            *status = FinalStatus::Cancelled;
            return Err(failure.message);
        }
        *status = FinalStatus::Error;
        if let Some(job) = job {
            reconcile_failed(job, &failure, &plan.identity);
        }
        Err(failure.message)
    }

    /// Runs the turn and settles everything around it; a failed turn is its message.
    pub async fn run(&self, plan: TurnPlan, context: Option<NotifyContext>, job: Option<Arc<JobHandle>>) -> Result<WorkerResult, String> {
        let context = context.unwrap_or_default();
        let claim = self.turns.claim(&plan.session_id, job.clone());
        let spawn = plan.kind == TurnKind::Spawn;
        // A send's follow-up is reviewed like a spawn's: its edits join the owner's turn review.
        let review = Some({
            Arc::new(TurnReview::begin(
                &*self.reviews,
                [
                    context.caller_session_id.as_deref(),
                    plan.parent_session_id.as_deref(),
                    context.owner_session_id.as_deref(),
                    plan.session_owner_id.as_deref(),
                ],
                &plan.session_id,
                &plan.tag,
                &plan.agent,
            ))
        });
        // SubagentStart: a worker session is about to run its first turn.
        if spawn {
            self.events.start(&plan.agent, &plan.session_id, &plan.tag);
        }
        let mut status = FinalStatus::Idle;
        let outcome = self.attempt(&plan, &context, job.as_ref(), review.as_ref(), claim.submission_id.clone(), &mut status).await;
        if let Some(review) = &review {
            review.complete();
        }
        claim.release(status);
        if let Some(job) = &job {
            reconcile_finally(job, status);
        }
        // SubagentStop: the worker finished (terminal), regardless of outcome.
        if spawn {
            self.events.stop(&plan.agent, &plan.session_id, &plan.tag, status.word());
        }
        // The durable session and tag stay for same-tag follow-ups; every process-local shell,
        // watchdog and tool cache is released now.
        self.sessions.unload_runtime(&plan.session_id, "agent-turn-complete");
        outcome
    }
}
