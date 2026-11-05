//! The storage and run seams of the scheduler, plus an in-memory store that applies the
//! same row rules as the Postgres statements (claim guard, failure streak, auto-pause).

use std::collections::HashMap;
use std::sync::Mutex;

use async_trait::async_trait;
use chrono::{DateTime, Utc};
use serde_json::Value;

use super::model::{Schedule, ScheduleError};
use super::rows;

pub type Ts = DateTime<Utc>;

pub trait Clock: Send + Sync {
    fn now(&self) -> Ts;
}

pub struct SystemClock;
impl Clock for SystemClock {
    fn now(&self) -> Ts {
        Utc::now()
    }
}

#[async_trait]
pub trait ScheduleStore: Send + Sync {
    async fn get(&self, name: &str) -> Result<Option<Schedule>, ScheduleError>;
    async fn list(&self) -> Result<Vec<Schedule>, ScheduleError>;
    async fn mark_fired(&self, name: &str, at: Ts) -> Result<(), ScheduleError>;
    async fn set_next_fire(&self, name: &str, at: Option<Ts>) -> Result<(), ScheduleError>;
    /// Moves the cursor of a skipped slot; false when the slot is stale or the row off.
    async fn advance_cursor(&self, name: &str, scheduled_at: Ts, next: Option<Ts>) -> Result<bool, ScheduleError>;
    /// Claims one cron slot exactly once; false for a duplicate/stale slot or an off row.
    async fn claim_run(&self, name: &str, scheduled_at: Ts, started_at: Ts, next: Option<Ts>)
    -> Result<bool, ScheduleError>;
    async fn mark_success(&self, name: &str, at: Ts) -> Result<(), ScheduleError>;
    /// One more failure in a row; the one reaching the pause limit switches the row off.
    async fn mark_failure(&self, name: &str, at: Ts) -> Result<(), ScheduleError>;
    async fn mark_skipped(&self, name: &str, at: Ts) -> Result<(), ScheduleError>;
    async fn mark_done(&self, name: &str) -> Result<(), ScheduleError>;
    async fn set_deferred(&self, name: &str, until: Option<Ts>) -> Result<(), ScheduleError>;
    async fn set_skipped_until(&self, name: &str, until: Option<Ts>) -> Result<(), ScheduleError>;
}

/// The admin side of the schedule table: saves, renames, deletes, the enable switch and the
/// undelivered-result record (schedules-db.mjs). The scheduler itself needs only `ScheduleStore`.
#[async_trait]
pub trait ScheduleRecords: ScheduleStore {
    /// Insert-or-replace by name; a redefinition clears stale runtime state (`rows::redefined`).
    async fn upsert(&self, def: &Schedule) -> Result<Schedule, ScheduleError>;
    /// Moves `old` to `def.name` in one step; None when `old` is gone, `NameTaken` when the
    /// new name is occupied (nothing changes).
    async fn rename(&self, old: &str, def: &Schedule, timing_changed: bool) -> Result<Option<Schedule>, ScheduleError>;
    async fn delete(&self, name: &str) -> Result<bool, ScheduleError>;
    async fn set_enabled(&self, name: &str, enabled: bool) -> Result<Option<Schedule>, ScheduleError>;
    /// Sets (`entry`) or clears (None) the undelivered result of run `run_id`.
    async fn record_delivery(&self, name: &str, run_id: &str, entry: Option<Value>) -> Result<(), ScheduleError>;
}

pub enum SkipReason {
    Backoff,
    Paused,
    Owner(String),
    Running,
}

impl SkipReason {
    pub fn text(&self) -> String {
        match self {
            Self::Backoff => "backing off after failures".into(),
            Self::Paused => "switched off".into(),
            Self::Owner(message) => format!("paused: {message}"),
            Self::Running => "previous run still in progress".into(),
        }
    }
}

pub enum RunOutcome {
    Done,
    /// The run path refused the fire and already persisted the skip.
    Skipped(SkipReason),
}

/// Runs one fire as a visible schedule session in the owner's home thread.
#[async_trait]
pub trait ScheduleRunner: Send + Sync {
    async fn run(&self, schedule: &Schedule, prompt: &str) -> Result<RunOutcome, String>;
}

#[derive(Default)]
pub struct MemoryScheduleStore {
    rows: Mutex<HashMap<String, Schedule>>,
}

impl MemoryScheduleStore {
    pub fn with(rows: impl IntoIterator<Item = Schedule>) -> Self {
        Self { rows: Mutex::new(rows.into_iter().map(|s| (s.name.clone(), s)).collect()) }
    }

    /// Overwrites one row, as an edit made outside the scheduler would.
    pub fn replace(&self, row: Schedule) {
        self.rows.lock().unwrap().insert(row.name.clone(), row);
    }

    fn edit(&self, name: &str, f: impl FnOnce(&mut Schedule)) {
        if let Some(row) = self.rows.lock().unwrap().get_mut(name) {
            f(row);
        }
    }
}

#[async_trait]
impl ScheduleStore for MemoryScheduleStore {
    async fn get(&self, name: &str) -> Result<Option<Schedule>, ScheduleError> {
        Ok(self.rows.lock().unwrap().get(name).cloned())
    }
    async fn list(&self) -> Result<Vec<Schedule>, ScheduleError> {
        let mut all: Vec<_> = self.rows.lock().unwrap().values().cloned().collect();
        // Same order as the durable store: PG's C collation, byte order of the UTF-8.
        all.sort_by(|a, b| a.name.cmp(&b.name));
        Ok(all)
    }
    async fn mark_fired(&self, name: &str, at: Ts) -> Result<(), ScheduleError> {
        self.edit(name, |s| s.last_fired_at = Some(at));
        Ok(())
    }
    async fn set_next_fire(&self, name: &str, at: Option<Ts>) -> Result<(), ScheduleError> {
        self.edit(name, |s| s.next_fire_at = at);
        Ok(())
    }
    async fn advance_cursor(&self, name: &str, scheduled_at: Ts, next: Option<Ts>) -> Result<bool, ScheduleError> {
        let mut claimed = false;
        self.edit(name, |s| claimed = rows::claim(s, scheduled_at, None, next));
        Ok(claimed)
    }
    async fn claim_run(
        &self,
        name: &str,
        scheduled_at: Ts,
        started_at: Ts,
        next: Option<Ts>,
    ) -> Result<bool, ScheduleError> {
        let mut claimed = false;
        self.edit(name, |s| claimed = rows::claim(s, scheduled_at, Some(started_at), next));
        Ok(claimed)
    }
    async fn mark_success(&self, name: &str, at: Ts) -> Result<(), ScheduleError> {
        self.edit(name, |s| rows::success(s, at));
        Ok(())
    }
    async fn mark_failure(&self, name: &str, at: Ts) -> Result<(), ScheduleError> {
        self.edit(name, |s| rows::failure(s, at));
        Ok(())
    }
    async fn mark_skipped(&self, name: &str, at: Ts) -> Result<(), ScheduleError> {
        self.edit(name, |s| s.last_skipped_at = Some(at));
        Ok(())
    }
    async fn mark_done(&self, name: &str) -> Result<(), ScheduleError> {
        self.edit(name, rows::done);
        Ok(())
    }
    async fn set_deferred(&self, name: &str, until: Option<Ts>) -> Result<(), ScheduleError> {
        self.edit(name, |s| s.deferred_until = until);
        Ok(())
    }
    async fn set_skipped_until(&self, name: &str, until: Option<Ts>) -> Result<(), ScheduleError> {
        self.edit(name, |s| s.skipped_until = until);
        Ok(())
    }
}

#[async_trait]
impl ScheduleRecords for MemoryScheduleStore {
    async fn upsert(&self, def: &Schedule) -> Result<Schedule, ScheduleError> {
        let mut rows = self.rows.lock().unwrap();
        let row = rows::redefined(def, rows.get(&def.name), Utc::now());
        rows.insert(row.name.clone(), row.clone());
        Ok(row)
    }
    async fn rename(&self, old: &str, def: &Schedule, timing_changed: bool) -> Result<Option<Schedule>, ScheduleError> {
        let mut rows = self.rows.lock().unwrap();
        let Some(current) = rows.get(old).cloned() else { return Ok(None) };
        if def.name != old && rows.contains_key(&def.name) {
            return Err(ScheduleError::NameTaken { name: def.name.clone() });
        }
        let row = rows::renamed(&current, def, timing_changed, Utc::now());
        rows.remove(old);
        rows.insert(row.name.clone(), row.clone());
        Ok(Some(row))
    }
    async fn delete(&self, name: &str) -> Result<bool, ScheduleError> {
        Ok(self.rows.lock().unwrap().remove(name).is_some())
    }
    async fn set_enabled(&self, name: &str, enabled: bool) -> Result<Option<Schedule>, ScheduleError> {
        Ok(self.rows.lock().unwrap().get_mut(name).map(|s| {
            rows::enabled(s, enabled);
            s.updated_at = Some(Utc::now());
            s.clone()
        }))
    }
    async fn record_delivery(&self, name: &str, run_id: &str, entry: Option<Value>) -> Result<(), ScheduleError> {
        self.edit(name, |s| rows::delivery(s, run_id, entry));
        Ok(())
    }
}
