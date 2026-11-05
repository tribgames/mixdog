//! A schedule fire and a webhook run as owned automations in their owner's home thread
//! (schedule-session-run.mjs, webhook-session-run.mjs). Shared by the timed fires, the
//! received webhooks and the app's "Run now".

use serde_json::Value;
use tokio_util::sync::CancellationToken;

use super::owned::{OwnedOutcome, RunOpts};
use super::routine::RoutineKind;
use super::runtime::RoutineRuntime;
use super::turn::TurnArgs;
use crate::scheduler::Schedule;
use crate::webhooks::RunStamp;

#[derive(Clone, Default)]
pub struct ScheduleRunOpts {
    /// A person's "Run now": no failure backoff.
    pub attended: bool,
    /// Overrides the schedule's prompt when the caller already resolved the body.
    pub prompt: Option<String>,
    /// The caller holds the name (`AutomationRuns::begin`) and releases it itself.
    pub reserved: bool,
    pub cancel: CancellationToken,
}

/// One run of a webhook endpoint in its owner's thread.
#[derive(Debug, Clone)]
pub struct WebhookRun {
    pub name: String,
    pub owner_agent_id: Option<String>,
    pub executor_agent_id: Option<String>,
    pub cwd: Option<String>,
    pub attachments: Option<Value>,
    pub event: String,
    /// The endpoint's instructions plus the fenced payload.
    pub prompt: String,
    /// Only the endpoint's instructions.
    pub skill_selection: String,
}

impl RoutineRuntime {
    /// One fire of `schedule`: its instructions become one turn in its owner bot's home thread.
    pub async fn run_schedule(&self, schedule: &Schedule, opts: ScheduleRunOpts) -> Result<OwnedOutcome, String> {
        let body = opts.prompt.as_deref().unwrap_or(&schedule.prompt);
        let body = mixdog_js::js_trim(body).to_string();
        let run_opts = RunOpts { attended: opts.attended, reserved: opts.reserved, cancel: opts.cancel };
        self.run_owned(RoutineKind::Schedule, &schedule.name, &schedule.owner_agent_id, &run_opts, |cancel| async move {
            self.run_routine_turn(
                TurnArgs {
                    kind: RoutineKind::Schedule,
                    name: schedule.name.clone(),
                    owner_agent_id: Some(schedule.owner_agent_id.clone()),
                    prompt: body,
                    skill_selection: None,
                    attachments: schedule.attachments.clone(),
                    cwd: schedule.cwd.clone().filter(|c| !c.is_empty()),
                    event: String::new(),
                    session_id: None,
                    header: None,
                    executor_agent_id: schedule.executor_agent_id.clone(),
                },
                &cancel,
            )
            .await
        })
        .await
    }

    async fn stamp_webhook(&self, name: &str, outcome: RunStamp) {
        if let Err(error) = self.records.record_webhook_run(name, outcome, self.clock.now()).await {
            tracing::warn!("mixdog webhook: {name} {outcome:?} stamp failed: {error}");
        }
    }

    /// One run of the endpoint in its owner's thread: a run while the previous one of the same
    /// endpoint is still going is skipped (and stamped), and every outcome is stamped on the
    /// endpoint.
    pub async fn run_webhook(&self, run: WebhookRun, attended: bool, cancel: CancellationToken) -> Result<OwnedOutcome, String> {
        let name = mixdog_js::js_trim(&run.name).to_string();
        let owner = run.owner_agent_id.clone().unwrap_or_default();
        let opts = RunOpts { attended, reserved: false, cancel };
        let (name_ref, run_ref) = (&name, &run);
        let outcome = self
            .run_owned(RoutineKind::Webhook, &name, &owner, &opts, |cancel| async move {
                self.run_routine_turn(
                    TurnArgs {
                        kind: RoutineKind::Webhook,
                        name: name_ref.clone(),
                        owner_agent_id: run_ref.owner_agent_id.clone(),
                        prompt: run_ref.prompt.clone(),
                        skill_selection: Some(run_ref.skill_selection.clone()),
                        attachments: run_ref.attachments.clone(),
                        cwd: run_ref.cwd.clone().filter(|c| !c.is_empty()),
                        event: run_ref.event.clone(),
                        session_id: None,
                        header: None,
                        executor_agent_id: run_ref.executor_agent_id.clone(),
                    },
                    &cancel,
                )
                .await
            })
            .await;
        match &outcome {
            Err(_) => self.stamp_webhook(&name, RunStamp::Failed).await,
            Ok(OwnedOutcome::Ran(_)) => self.stamp_webhook(&name, RunStamp::Success).await,
            // The skip is already stamped by `run_owned`.
            Ok(OwnedOutcome::Skipped(_)) => {}
        }
        outcome
    }
}
