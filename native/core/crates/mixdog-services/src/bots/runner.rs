//! The two real fire paths into the routine runtime: a schedule fire (`ScheduleRunner`) and a
//! received webhook (`WebhookDispatch`). Both hand the instructions to the owner bot's home
//! thread as a turn; the HTTP caller is answered 202 at once and the run, which has no
//! deadline, settles the delivery row when it ends.

use std::sync::Arc;

use async_trait::async_trait;
use serde_json::{Value, json};

use super::owned::{OwnedOutcome, Skip, never_cancelled};
use super::runtime::RoutineRuntime;
use super::sessions::{ScheduleRunOpts, WebhookRun};
use crate::channels::running::RunningWork;
use crate::scheduler::{RunOutcome, Schedule, ScheduleRunner, SkipReason};
use crate::webhooks::prompt::{prompt_headers, webhook_event_summary, webhook_run_prompt};
use crate::webhooks::signature::Headers;
use crate::webhooks::{EndpointRecords, HttpReply, WebhookDispatch};

/// A schedule fire as a visible turn in its owner's home thread.
pub struct HomeScheduleRunner {
    routines: Arc<RoutineRuntime>,
}

impl HomeScheduleRunner {
    pub fn new(routines: Arc<RoutineRuntime>) -> Self {
        Self { routines }
    }
}

#[async_trait]
impl ScheduleRunner for HomeScheduleRunner {
    async fn run(&self, schedule: &Schedule, prompt: &str) -> Result<RunOutcome, String> {
        // The fire has no deadline and nothing cancels it (Node passes no signal).
        let opts = ScheduleRunOpts { prompt: Some(prompt.to_string()), ..ScheduleRunOpts::default() };
        Ok(match self.routines.run_schedule(schedule, opts).await? {
            OwnedOutcome::Ran(_) => RunOutcome::Done,
            OwnedOutcome::Skipped(Skip::Owner(problem)) => RunOutcome::Skipped(SkipReason::Owner(problem.message().into())),
            OwnedOutcome::Skipped(Skip::Overlap) => RunOutcome::Skipped(SkipReason::Running),
            OwnedOutcome::Skipped(Skip::Backoff) => RunOutcome::Skipped(SkipReason::Backoff),
            OwnedOutcome::Skipped(Skip::Paused) => RunOutcome::Skipped(SkipReason::Paused),
        })
    }
}

/// Where a webhook that has no endpoint row goes: the parser-only event pipeline.
pub trait WebhookEvents: Send + Sync {
    /// Whether the pipeline took the event.
    fn handle_webhook(&self, name: &str, body: &Value, headers: &Headers) -> bool;
}

pub struct HomeWebhookDispatch {
    routines: Arc<RoutineRuntime>,
    store: Arc<dyn EndpointRecords>,
    events: Option<Arc<dyn WebhookEvents>>,
    work: RunningWork,
}

impl HomeWebhookDispatch {
    pub fn new(
        routines: Arc<RoutineRuntime>,
        store: Arc<dyn EndpointRecords>,
        events: Option<Arc<dyn WebhookEvents>>,
        work: RunningWork,
    ) -> Self {
        Self { routines, store, events, work }
    }

    /// A table endpoint runs as a visible turn in its owner's chat: no Lead injection, no
    /// channel delivery. Err = the dispatch failed before the run was handed over.
    async fn dispatch_endpoint(&self, name: &str, payload: &Value, headers: &Headers, id: &str) -> Result<HttpReply, String> {
        let endpoint = self.store.load(name).await?.ok_or_else(|| format!("webhook \"{name}\" does not exist"))?;
        let shown = prompt_headers(headers);
        let run = webhook_run_prompt(&endpoint.instructions, payload, &shown);
        // Kept for the app's "Run now", which re-runs the latest event. Losing the record never
        // blocks the delivery itself.
        let stored = json!({"body": payload, "headers": shown});
        if let Err(error) = self.store.record_event(name, stored, self.routines.clock.now()).await {
            mixdog_rt::node_stderr!("mixdog webhook: {name}: event record failed: {error}");
        }
        self.store.update_delivery_status(name, id, "processing", None).await?;
        let run = WebhookRun {
            name: name.to_string(),
            owner_agent_id: Some(endpoint.owner_agent_id.clone()).filter(|o| !o.is_empty()),
            executor_agent_id: endpoint.executor_agent_id.clone(),
            cwd: endpoint.cwd.clone(),
            attachments: endpoint.attachments.clone(),
            event: webhook_event_summary(&shown, payload),
            prompt: run.prompt,
            skill_selection: run.skill_selection,
        };
        // The delivery stays `processing` until the run ends, then `done` / `skipped` / `failed`;
        // a second delivery meanwhile is skipped by the run's own overlap rule.
        let (routines, store, task_id, guard) = (Arc::clone(&self.routines), Arc::clone(&self.store), id.to_string(), self.work.begin());
        let name_owned = name.to_string();
        tokio::spawn(async move {
            let id = task_id;
            let _busy = guard;
            // The dispatch has no deadline and nothing cancels it (Node passes no signal).
            let (status, error) = match routines.run_webhook(run, false, never_cancelled()).await {
                Ok(OwnedOutcome::Skipped(_)) => ("skipped", None),
                Ok(OwnedOutcome::Ran(_)) => ("done", None),
                Err(error) => ("failed", Some(error)),
            };
            match &error {
                Some(e) => mixdog_rt::node_stderr!("mixdog webhook: {name_owned}: webhook session run failed: {e}"),
                None if status == "skipped" => mixdog_rt::node_stderr!("mixdog webhook: {name_owned}: previous run still in progress; skipped (id={id})"),
                None => mixdog_rt::node_stderr!("mixdog webhook: {name_owned}: webhook session run dispatched (id={id})"),
            }
            if let Err(e) = store.update_delivery_status(&name_owned, &id, status, error.as_deref()).await {
                mixdog_rt::node_stderr!("mixdog webhook: {name_owned}: delivery status update failed: {e}");
            }
        });
        Ok(HttpReply { status: 202, body: json!({"status": "accepted", "handler": "session", "id": id}) })
    }
}

#[async_trait]
impl WebhookDispatch for HomeWebhookDispatch {
    async fn handle(
        &self,
        name: &str,
        payload: Value,
        headers: &Headers,
        delivery_id: &str,
        endpoint_in_table: bool,
    ) -> Result<HttpReply, String> {
        if endpoint_in_table {
            match self.dispatch_endpoint(name, &payload, headers, delivery_id).await {
                Ok(reply) => return Ok(reply),
                Err(error) => {
                    self.store.update_delivery_status(name, delivery_id, "failed", Some(&error)).await?;
                    mixdog_rt::node_stderr!("mixdog webhook: {name}: folder handler error: {error}");
                }
            }
        }
        if self.events.as_ref().is_some_and(|e| e.handle_webhook(name, &payload, headers)) {
            self.store.update_delivery_status(name, delivery_id, "done", None).await?;
            return Ok(HttpReply { status: 200, body: json!({"status": "accepted", "id": delivery_id}) });
        }
        self.store.update_delivery_status(name, delivery_id, "failed", Some("unknown endpoint")).await?;
        mixdog_rt::node_stderr!("mixdog webhook: unknown endpoint: {name}");
        Ok(HttpReply { status: 404, body: json!({"error": "unknown endpoint"}) })
    }
}
