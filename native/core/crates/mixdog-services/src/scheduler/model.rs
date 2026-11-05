//! The schedule row, its failure-streak rules and the structured rename refusals.

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use serde_json::Value;

use super::cron::CronExpr;

/// After a failure the next unattended fire waits `BACKOFF_BASE_MS * 2^(n-1)`; the
/// routine switches itself off at `PAUSE_AFTER_FAILURES` failures in a row.
pub const BACKOFF_BASE_MS: i64 = 60_000;
pub const PAUSE_AFTER_FAILURES: u32 = 5;
pub const HOME_QUEUE_LIMIT: usize = 200;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum ScheduleStatus {
    #[default]
    Active,
    Done,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Schedule {
    pub name: String,
    pub description: String,
    pub when_at: Option<DateTime<Utc>>,
    pub when_cron: Option<String>,
    pub timezone: Option<String>,
    pub cwd: Option<String>,
    pub attachments: Option<Value>,
    pub delivery: Option<String>,
    pub prompt: String,
    pub enabled: bool,
    pub status: ScheduleStatus,
    pub last_fired_at: Option<DateTime<Utc>>,
    pub last_scheduled_at: Option<DateTime<Utc>>,
    pub last_started_at: Option<DateTime<Utc>>,
    pub last_success_at: Option<DateTime<Utc>>,
    pub last_failed_at: Option<DateTime<Utc>>,
    pub last_skipped_at: Option<DateTime<Utc>>,
    pub owner_agent_id: String,
    pub executor_agent_id: Option<String>,
    pub consecutive_failures: u32,
    pub result_delivery: Option<Value>,
    pub next_fire_at: Option<DateTime<Utc>>,
    pub deferred_until: Option<DateTime<Utc>>,
    pub skipped_until: Option<DateTime<Utc>>,
    pub created_at: Option<DateTime<Utc>>,
    pub updated_at: Option<DateTime<Utc>>,
}

impl Default for Schedule {
    fn default() -> Self {
        Self {
            name: String::new(),
            description: String::new(),
            when_at: None,
            when_cron: None,
            timezone: None,
            cwd: None,
            attachments: None,
            delivery: None,
            prompt: String::new(),
            enabled: true,
            status: ScheduleStatus::Active,
            last_fired_at: None,
            last_scheduled_at: None,
            last_started_at: None,
            last_success_at: None,
            last_failed_at: None,
            last_skipped_at: None,
            owner_agent_id: "lead".into(),
            executor_agent_id: None,
            consecutive_failures: 0,
            result_delivery: None,
            next_fire_at: None,
            deferred_until: None,
            skipped_until: None,
            created_at: None,
            updated_at: None,
        }
    }
}

impl Schedule {
    /// Checks the row invariants: exactly one of `whenAt`/`whenCron`, a valid cron
    /// expression and a known timezone.
    pub fn validate(&self) -> Result<(), String> {
        if self.name.is_empty() {
            return Err("schedule name is required".into());
        }
        if self.prompt.is_empty() {
            return Err("schedule prompt is required".into());
        }
        match (&self.when_at, &self.when_cron) {
            (Some(_), Some(_)) | (None, None) => {
                return Err("exactly one of whenAt and whenCron is required".into());
            }
            (None, Some(cron)) => {
                CronExpr::parse(cron).map_err(|e| e.0)?;
            }
            _ => {}
        }
        if let Some(tz) = self.timezone.as_deref().map(str::trim).filter(|t| !t.is_empty()) {
            tz.parse::<chrono_tz::Tz>().map_err(|_| format!("invalid schedule timezone \"{tz}\""))?;
        }
        Ok(())
    }

    /// The later of a still-future `deferredUntil` and `skippedUntil`, if any.
    pub fn skip_until(&self, now: DateTime<Utc>) -> Option<DateTime<Utc>> {
        [self.deferred_until, self.skipped_until].into_iter().flatten().filter(|t| *t > now).max()
    }
}

/// How long (ms) an unattended fire still waits after `consecutive_failures`, the latest
/// at `last_failed_at`; 0 when it may run.
pub fn backoff_remaining_ms(consecutive_failures: u32, last_failed_at: Option<DateTime<Utc>>, now: DateTime<Utc>) -> i64 {
    let Some(at) = last_failed_at else { return 0 };
    if consecutive_failures < 1 {
        return 0;
    }
    let wait = BACKOFF_BASE_MS.saturating_mul(1i64 << (consecutive_failures - 1).min(40));
    (at.timestamp_millis().saturating_add(wait) - now.timestamp_millis()).max(0)
}

pub const SCHEDULE_NAME_TAKEN: &str = "SCHEDULE_NAME_TAKEN";
pub const SCHEDULE_RENAME_RUNNING: &str = "SCHEDULE_RENAME_RUNNING";
pub const SCHEDULE_RENAME_RELOAD_FAILED: &str = "SCHEDULE_RENAME_RELOAD_FAILED";
pub const SCHEDULE_RENAME_UNCERTAIN: &str = "SCHEDULE_RENAME_UNCERTAIN";

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ScheduleError {
    NameTaken { name: String },
    RenameRunning { name: String },
    RenameReloadFailed { name: String, cause: String },
    RenameUncertain { cause: String },
    Store(String),
    Run(String),
}

impl ScheduleError {
    /// The code and public `name` detail a reply may carry; nothing else crosses.
    pub fn code_fields(&self) -> Option<(&'static str, Option<&str>)> {
        match self {
            Self::NameTaken { name } => Some((SCHEDULE_NAME_TAKEN, Some(name))),
            Self::RenameRunning { name } => Some((SCHEDULE_RENAME_RUNNING, Some(name))),
            Self::RenameReloadFailed { name, .. } => Some((SCHEDULE_RENAME_RELOAD_FAILED, Some(name))),
            Self::RenameUncertain { .. } => Some((SCHEDULE_RENAME_UNCERTAIN, None)),
            Self::Store(_) | Self::Run(_) => None,
        }
    }
}

impl std::fmt::Display for ScheduleError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::NameTaken { name } => write!(f, "A schedule named \"{name}\" already exists."),
            Self::RenameRunning { name } => {
                write!(f, "Schedule \"{name}\" is running. Rename it after the run finishes.")
            }
            Self::RenameReloadFailed { name, cause } => write!(
                f,
                "Renamed to \"{name}\", but reloading the scheduler failed ({cause}); it is armed on the next reload."
            ),
            Self::RenameUncertain { cause } => write!(
                f,
                "The rename may or may not have applied (the scheduler did not answer: {cause}). Check the schedule list."
            ),
            Self::Store(m) | Self::Run(m) => f.write_str(m),
        }
    }
}
impl std::error::Error for ScheduleError {}

#[cfg(test)]
mod tests {
    use super::*;

    fn at(s: &str) -> DateTime<Utc> {
        s.parse().unwrap()
    }

    #[test]
    fn backoff_doubles_per_failure() {
        let failed = at("2025-01-01T00:00:00Z");
        let now = at("2025-01-01T00:00:30Z");
        assert_eq!(backoff_remaining_ms(0, Some(failed), now), 0);
        assert_eq!(backoff_remaining_ms(1, Some(failed), now), 30_000);
        assert_eq!(backoff_remaining_ms(3, Some(failed), now), 210_000);
        assert_eq!(backoff_remaining_ms(2, None, now), 0);
    }

    #[test]
    fn validate_requires_one_trigger() {
        let mut s = Schedule { name: "a".into(), prompt: "p".into(), ..Default::default() };
        assert!(s.validate().is_err());
        s.when_cron = Some("0 9 * * *".into());
        assert!(s.validate().is_ok());
        s.when_at = Some(at("2025-01-01T00:00:00Z"));
        assert!(s.validate().is_err());
        s.when_at = None;
        s.timezone = Some("Mars/Base".into());
        assert_eq!(s.validate().unwrap_err(), "invalid schedule timezone \"Mars/Base\"");
    }

    #[test]
    fn error_fields_expose_only_codes_and_names() {
        let e = ScheduleError::RenameReloadFailed { name: "n".into(), cause: "secret".into() };
        assert_eq!(e.code_fields(), Some((SCHEDULE_RENAME_RELOAD_FAILED, Some("n"))));
        assert_eq!(ScheduleError::Store("x".into()).code_fields(), None);
        assert_eq!(ScheduleError::RenameUncertain { cause: "c".into() }.code_fields(), Some((SCHEDULE_RENAME_UNCERTAIN, None)));
    }
}
