//! The HTTP caller of a webhook is answered 202 at once; the run, which has no deadline,
//! settles the delivery row when it ends.

use std::sync::Arc;

use async_trait::async_trait;
use serde_json::{Value, json};

use super::owned::{OwnedOutcome, Skip, never_cancelled};
use super::runtime::RoutineRuntime;
use super::sessions::{ScheduleRunOpts, WebhookRun};
use crate::channels::running::RunningWork;
use crate::scheduler::{RunOutcome, Schedule, ScheduleRunner, SkipReason};
use crate::webhooks::handler::WebhookRoute;
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
#[async_trait]
pub trait WebhookEvents: Send + Sync {
    fn matches(&self, name: &str) -> bool;
    /// `Ok(true)` means the rule filtered the event or durably enqueued it. `Ok(false)` means
    /// no rule matched, and `Err` means the handoff failed and can be retried.
    async fn handle_webhook(&self, name: &str, body: &Value, headers: &Headers, delivery_id: &str) -> Result<bool, String>;
}

pub struct HomeWebhookDispatch {
    routines: Arc<RoutineRuntime>,
    store: Arc<dyn EndpointRecords>,
    events: Option<Arc<dyn WebhookEvents>>,
    work: RunningWork,
}

impl HomeWebhookDispatch {
    pub fn new(routines: Arc<RoutineRuntime>, store: Arc<dyn EndpointRecords>, events: Option<Arc<dyn WebhookEvents>>, work: RunningWork) -> Self {
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
            event: webhook_event_summary(|n| headers.get(n), payload),
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
    async fn route(&self, name: &str, payload: Value, headers: &Headers, delivery_id: &str, endpoint_in_table: bool) -> Result<WebhookRoute, String> {
        let resumed = self.store.resuming_rule_handoff(name, delivery_id).await?;
        if endpoint_in_table && !resumed {
            match self.dispatch_endpoint(name, &payload, headers, delivery_id).await {
                Ok(reply) => return Ok(WebhookRoute::Reply(reply)),
                Err(error) => {
                    // `failed` is what lets the sender's retry claim the delivery again, so it is written only once the
                    // attempt has ended: the event fallback below can still run it and settles the status itself.
                    mixdog_rt::node_stderr!("mixdog webhook: {name}: folder handler error: {error}");
                }
            }
        }
        if let Some(events) = self.events.as_ref().filter(|events| resumed || events.matches(name)).cloned() {
            let (store, name, id, headers) = (self.store.clone(), name.to_owned(), delivery_id.to_owned(), headers.clone());
            return Ok(WebhookRoute::Rule(Box::pin(async move {
                if events.handle_webhook(&name, &payload, &headers, &id).await? {
                    // The real queue records its file receipt before it is runnable.
                    // A filtered delivery has no file and is settled here.
                    store.update_delivery_status(&name, &id, "done", None).await?;
                    return Ok(HttpReply { status: 200, body: json!({"status": "accepted", "id": id}) });
                }
                unknown_endpoint(&*store, &name, &id).await
            })));
        }
        unknown_endpoint(&*self.store, name, delivery_id).await.map(WebhookRoute::Reply)
    }

    async fn handle(&self, name: &str, payload: Value, headers: &Headers, delivery_id: &str, endpoint_in_table: bool) -> Result<HttpReply, String> {
        match self.route(name, payload, headers, delivery_id, endpoint_in_table).await? {
            WebhookRoute::Reply(reply) => Ok(reply),
            WebhookRoute::Rule(handoff) => handoff.await,
        }
    }
}

async fn unknown_endpoint(store: &dyn EndpointRecords, name: &str, id: &str) -> Result<HttpReply, String> {
    store.update_delivery_status(name, id, "failed", Some("unknown endpoint")).await?;
    mixdog_rt::node_stderr!("mixdog webhook: unknown endpoint: {name}");
    Ok(HttpReply { status: 404, body: json!({"error": "unknown endpoint"}) })
}
