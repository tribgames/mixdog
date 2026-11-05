//! The routine runtime: what runs a schedule or webhook fire as a turn in its owner bot's
//! home thread. The `impl` blocks live beside the Node modules they port: `turn`
//! (routine-home-turn.mjs), `executor` (routine-executor.mjs), `owned` (owned-automation-run.mjs,
//! the guards every run passes), `delivery` (its redelivery half) and `sessions`
//! (schedule-session-run.mjs, webhook-session-run.mjs).

use std::collections::{HashMap, HashSet};
use std::sync::atomic::AtomicBool;
use std::sync::{Arc, Mutex};

use async_trait::async_trait;
use chrono::{DateTime, Utc};
use chrono_tz::Tz;
use serde_json::Value;

use super::host::RoutineHost;
use super::routine::RoutineKind;
use crate::scheduler::{Clock, ScheduleRecords, ScheduleStore};
use crate::webhooks::{EndpointRecords, RunStamp};

/// The part of a stored routine the run guards and the redelivery read.
#[derive(Clone, Debug, PartialEq)]
pub struct RoutineState {
    pub name: String,
    pub owner_agent_id: String,
    pub enabled: bool,
    pub consecutive_failures: u32,
    pub last_failed_at: Option<DateTime<Utc>>,
    /// Results of finished runs not yet queued for the owner's thread, by run id.
    pub result_delivery: Option<Value>,
}

/// The stored side of both routine kinds.
#[async_trait]
pub trait RoutineRecords: Send + Sync {
    async fn state(&self, kind: RoutineKind, name: &str) -> Result<Option<RoutineState>, String>;
    async fn list(&self, kind: RoutineKind) -> Result<Vec<RoutineState>, String>;
    /// A run skipped because the previous one still runs, or its owner/backoff/pause refused it.
    async fn record_skip(&self, kind: RoutineKind, name: &str, at: DateTime<Utc>) -> Result<(), String>;
    async fn record_delivery(&self, kind: RoutineKind, name: &str, run_id: &str, entry: Option<Value>) -> Result<(), String>;
    /// Stamps a webhook run's outcome on its endpoint (a schedule's outcome is stamped by the
    /// scheduler).
    async fn record_webhook_run(&self, name: &str, outcome: RunStamp, at: DateTime<Utc>) -> Result<(), String>;
}

/// `RoutineRecords` over the schedule table and the webhook endpoint table.
pub struct StoreRoutineRecords {
    schedules: Arc<dyn ScheduleRecords>,
    webhooks: Arc<dyn EndpointRecords>,
}

impl StoreRoutineRecords {
    pub fn new(schedules: Arc<dyn ScheduleRecords>, webhooks: Arc<dyn EndpointRecords>) -> Self {
        Self { schedules, webhooks }
    }
}

#[async_trait]
impl RoutineRecords for StoreRoutineRecords {
    async fn state(&self, kind: RoutineKind, name: &str) -> Result<Option<RoutineState>, String> {
        Ok(match kind {
            RoutineKind::Schedule => self.schedules.get(name).await.map_err(|e| e.to_string())?.map(|s| RoutineState {
                name: s.name,
                owner_agent_id: s.owner_agent_id,
                enabled: s.enabled,
                consecutive_failures: s.consecutive_failures,
                last_failed_at: s.last_failed_at,
                result_delivery: s.result_delivery,
            }),
            RoutineKind::Webhook => self.webhooks.load(name).await?.map(webhook_state),
        })
    }

    async fn list(&self, kind: RoutineKind) -> Result<Vec<RoutineState>, String> {
        Ok(match kind {
            RoutineKind::Schedule => self
                .schedules
                .list()
                .await
                .map_err(|e| e.to_string())?
                .into_iter()
                .map(|s| RoutineState {
                    name: s.name,
                    owner_agent_id: s.owner_agent_id,
                    enabled: s.enabled,
                    consecutive_failures: s.consecutive_failures,
                    last_failed_at: s.last_failed_at,
                    result_delivery: s.result_delivery,
                })
                .collect(),
            RoutineKind::Webhook => self.webhooks.list().await?.into_iter().map(webhook_state).collect(),
        })
    }

    async fn record_skip(&self, kind: RoutineKind, name: &str, at: DateTime<Utc>) -> Result<(), String> {
        match kind {
            RoutineKind::Schedule => self.schedules.mark_skipped(name, at).await.map_err(|e| e.to_string()),
            RoutineKind::Webhook => self.webhooks.mark_run(name, RunStamp::Skipped, at).await,
        }
    }

    async fn record_delivery(&self, kind: RoutineKind, name: &str, run_id: &str, entry: Option<Value>) -> Result<(), String> {
        match kind {
            RoutineKind::Schedule => self.schedules.record_delivery(name, run_id, entry).await.map_err(|e| e.to_string()),
            RoutineKind::Webhook => self.webhooks.record_delivery(name, run_id, entry).await,
        }
    }

    async fn record_webhook_run(&self, name: &str, outcome: RunStamp, at: DateTime<Utc>) -> Result<(), String> {
        self.webhooks.mark_run(name, outcome, at).await
    }
}

fn webhook_state(e: crate::webhooks::EndpointRecord) -> RoutineState {
    RoutineState {
        name: e.name,
        owner_agent_id: e.owner_agent_id,
        enabled: e.enabled,
        consecutive_failures: e.consecutive_failures,
        last_failed_at: e.last_failed_at,
        result_delivery: e.result_delivery,
    }
}

/// `kind:name` of every run in flight in this process: timed fires, received webhooks and the
/// app's "Run now" all pass here, and a rename reserves the name against them.
#[derive(Default)]
pub struct AutomationRuns {
    active: Mutex<HashSet<String>>,
}

/// A held `kind:name`; dropping it releases the name.
pub struct Reservation {
    runs: Arc<AutomationRuns>,
    key: String,
}

impl Drop for Reservation {
    fn drop(&mut self) {
        self.runs.active.lock().unwrap().remove(&self.key);
    }
}

fn run_key(kind: RoutineKind, name: &str) -> String {
    format!("{}:{name}", kind.word())
}

impl AutomationRuns {
    pub fn new() -> Arc<Self> {
        Arc::new(Self::default())
    }

    /// Reserves `kind:name` against runs in this process; None when a run holds it. The check
    /// and the reservation are one step, and a run that finds the reservation is skipped as an
    /// overlap, so none can start under the name meanwhile.
    pub fn begin(self: &Arc<Self>, kind: RoutineKind, name: &str) -> Option<Reservation> {
        let key = run_key(kind, name);
        self.active.lock().unwrap().insert(key.clone()).then(|| Reservation { runs: Arc::clone(self), key })
    }

    pub(super) fn is_active(&self, kind: RoutineKind, name: &str) -> bool {
        self.active.lock().unwrap().contains(&run_key(kind, name))
    }
}

pub struct RoutineRuntime {
    pub(super) host: Arc<dyn RoutineHost>,
    pub(super) records: Arc<dyn RoutineRecords>,
    pub(super) clock: Arc<dyn Clock>,
    pub(super) tz: Tz,
    pub(super) runs: Arc<AutomationRuns>,
    /// Routine turns waiting or running per home thread.
    pub(super) waiting: Mutex<HashMap<String, usize>>,
    pub(super) retry_armed: AtomicBool,
}

impl RoutineRuntime {
    /// `tz` is the zone a turn's header states the local time in.
    pub fn new(host: Arc<dyn RoutineHost>, records: Arc<dyn RoutineRecords>, clock: Arc<dyn Clock>, tz: Tz) -> Arc<Self> {
        Arc::new(Self {
            host,
            records,
            clock,
            tz,
            runs: AutomationRuns::new(),
            waiting: Mutex::new(HashMap::new()),
            retry_armed: AtomicBool::new(false),
        })
    }

    pub fn runs(&self) -> &Arc<AutomationRuns> {
        &self.runs
    }

    pub fn host(&self) -> &Arc<dyn RoutineHost> {
        &self.host
    }
}
