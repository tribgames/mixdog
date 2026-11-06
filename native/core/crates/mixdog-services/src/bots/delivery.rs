//! Routine results from before routines ran in the bot's thread — and any a thread refused
//! — may still sit on a routine's record (`resultDelivery`, by run id). They are queued into
//! the owner's thread again here, never running the routine again
//! (owned-automation-run.mjs `redeliverRoutine`, `recoverRoutineDeliveries`,
//! `retryRoutineDelivery`).

pub mod env;
#[cfg(test)]
mod golden_tests;
pub mod home;
pub mod queue;
mod relay;
pub mod rows;

use std::sync::Arc;
use std::sync::atomic::Ordering;
use std::time::Duration;

use serde_json::{Value, json};

use super::host::{AnnouncedRun, DeliveryItem};
use super::routine::RoutineKind;
use super::runtime::{RoutineRuntime, RoutineState};

/// How long a refused result waits before the host-wide retry re-queues it.
const DELIVERY_RETRY: Duration = Duration::from_secs(60);

fn kind_of(text: &str) -> Result<RoutineKind, String> {
    match text {
        "schedule" => Ok(RoutineKind::Schedule),
        "webhook" => Ok(RoutineKind::Webhook),
        other => Err(format!("unknown routine kind \"{other}\"")),
    }
}

fn item_of(kind: RoutineKind, run_id: &str, entry: &Value) -> DeliveryItem {
    let result = &entry["result"];
    DeliveryItem {
        run_id: run_id.to_string(),
        kind,
        ok: result["ok"] == Value::Bool(true),
        text: result["text"].as_str().unwrap_or_default().to_string(),
        run_session_id: result["runSessionId"].as_str().map(String::from),
        reason: result["reason"].as_str().map(String::from),
        paused: result["paused"].as_bool(),
    }
}

impl RoutineRuntime {
    /// Queues `item` for `row`'s owner; clears the record on success, marks it `failed` (and
    /// the caller arms the retry) when the queue refuses it.
    async fn queue_result(&self, kind: RoutineKind, row: &RoutineState, item: DeliveryItem, entry: &Value) -> bool {
        if let Err(message) = self.host.deliver_result(&row.owner_agent_id, &row.name, &item).await {
            tracing::warn!("{} \"{}\": result could not be queued ({message}); retrying later", kind.word(), row.name);
            let mut failed = entry.clone();
            failed["state"] = "failed".into();
            failed["error"] = message.into();
            if let Err(error) = self.records.record_delivery(kind, &row.name, &item.run_id, Some(failed)).await {
                tracing::warn!("{} \"{}\": delivery failure not recorded: {error}", kind.word(), row.name);
            }
            // The home's run row turns into "result not delivered" (retry: `retry_routine_delivery`).
            let run = AnnouncedRun { item, state: "undelivered" };
            if let Err(error) = self.host.announce_run(&row.owner_agent_id, &row.name, &run).await {
                tracing::warn!("{} \"{}\": run row not shown: {error}", kind.word(), row.name);
            }
            return false;
        }
        // A clear that fails leaves the record `pending`: the next recovery re-queues it, which
        // the queue's run-id key turns into a no-op.
        if let Err(error) = self.records.record_delivery(kind, &row.name, &item.run_id, None).await {
            tracing::warn!("{} \"{}\": delivered result not cleared: {error}", kind.word(), row.name);
        }
        true
    }

    /// Re-queues every result `row`'s record still holds, oldest first; resolves the run ids
    /// the queue still refuses. Never reruns the routine.
    pub async fn redeliver_routine(self: &Arc<Self>, kind: RoutineKind, row: &RoutineState) -> Vec<String> {
        let mut entries: Vec<(String, Value)> = match &row.result_delivery {
            Some(Value::Object(map)) => map.iter().map(|(k, v)| (k.clone(), v.clone())).collect(),
            _ => Vec::new(),
        };
        // `at` is an ISO-8601 stamp we wrote ourselves (or the ASCII "null"), so byte order is JS order.
        entries.sort_by(|(_, a), (_, b)| a["at"].as_str().unwrap_or("null").cmp(b["at"].as_str().unwrap_or("null")));
        let mut failed = Vec::new();
        for (run_id, entry) in entries {
            let item = item_of(kind, &run_id, &entry);
            if !self.queue_result(kind, row, item, &entry).await {
                failed.push(run_id);
            }
        }
        if !failed.is_empty() {
            self.arm_delivery_retry();
        }
        failed
    }

    /// One timer for the whole host: re-queues every record's undelivered result.
    fn arm_delivery_retry(self: &Arc<Self>) {
        if self.retry_armed.swap(true, Ordering::SeqCst) {
            return;
        }
        let rt = Arc::clone(self);
        tokio::spawn(async move {
            tokio::time::sleep(DELIVERY_RETRY).await;
            rt.retry_armed.store(false, Ordering::SeqCst);
            if let Err(error) = rt.recover_routine_deliveries().await {
                tracing::warn!("mixdog routines: delivery retry failed: {error}");
            }
        });
    }

    /// Core start (and the retry timer): re-queues every undelivered result of every schedule
    /// and webhook; resolves how many runs still wait.
    pub async fn recover_routine_deliveries(self: &Arc<Self>) -> Result<usize, String> {
        let mut waiting = 0;
        for kind in [RoutineKind::Schedule, RoutineKind::Webhook] {
            for row in self.records.list(kind).await? {
                if row.result_delivery.as_ref().and_then(Value::as_object).is_some_and(|m| !m.is_empty()) {
                    waiting += self.redeliver_routine(kind, &row).await.len();
                }
            }
        }
        Ok(waiting)
    }

    /// The app's "retry" on one routine: rejects with the error when still refused.
    pub async fn retry_routine_delivery(self: &Arc<Self>, kind: &str, name: &str) -> Result<Value, String> {
        let kind = kind_of(kind)?;
        let row = self
            .records
            .state(kind, name)
            .await?
            .ok_or_else(|| format!("{} \"{name}\" does not exist", kind.word()))?;
        let failed = self.redeliver_routine(kind, &row).await;
        if let Some(last) = failed.last() {
            let latest = self.records.state(kind, name).await?;
            let error = latest
                .and_then(|l| l.result_delivery)
                .and_then(|d| d[last.as_str()]["error"].as_str().map(String::from))
                .filter(|e| !e.is_empty());
            return Err(format!(
                "\"{name}\": the result still could not be delivered{}",
                error.map(|e| format!(" ({e})")).unwrap_or_default()
            ));
        }
        let delivered = row.result_delivery.as_ref().and_then(Value::as_object).map_or(0, |m| m.len());
        Ok(json!({"name": name, "delivered": delivered}))
    }
}
