//! The steps of the 1.4.5 upgrade that run after `complete.json`, because what they carry is
//! read from the running database and the migration itself runs before it exists. Each step is
//! recorded in the store's `migration:` meta family, beside the rows the migration's own items
//! publish (`migration:desktopProfile/...`), and this module is the one place that names them:
//! their keys, what they carry, the value a finished one records, and the report of the family.
//!
//! A step is done once its marker exists, whatever it carried, nothing included (a profile with no
//! old database, no old tables, empty tables, or a fresh install). From then on a start reads that
//! one marker and does nothing else. A step without its marker (its read failed, the database was
//! not ready) is the one a later start runs again; its executor writes the marker in the same
//! transaction as what it carries, so a step is either whole or not recorded.
//!
//! The executors live where their client is: the PostgreSQL reading of `legacyRoutines` is
//! `mixdog_services::scheduler::legacy`, wired at the daemon's composition.

#![allow(
    clippy::disallowed_methods,
    clippy::disallowed_types,
    reason = "one-time migration: reads the state database directly on the caller's thread, as the migration does"
)]

use std::path::Path;

use rusqlite::Connection;
use rusqlite::OpenFlags;

use crate::error::Blocked;
use crate::error::Result;

/// A post-upgrade step.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Step {
    /// The step's key; its marker is `migration:<key>`.
    pub key: &'static str,
    /// What the step carries over, for the report.
    pub carries: &'static str,
}

impl Step {
    /// The `meta` key of the step's marker, in the family the migration's items use.
    pub fn meta_key(&self) -> String {
        format!("{}{}", FAMILY, self.key)
    }
}

/// The key prefix of the migration's markers.
pub const FAMILY: &str = "migration:";

/// The schedules and webhook endpoints 1.4.5 kept in its PostgreSQL database
/// (`scheduler.schedules`, `webhooks.endpoints`).
pub const LEGACY_ROUTINES: Step =
    Step { key: "legacyRoutines", carries: "schedules and webhook endpoints from the 1.4.5 database, with their run stamps, secrets and pause state" };

/// The delivery dedup log of the webhook endpoints (`webhooks.deliveries`): what makes a provider's redelivery of an event the
/// old version handled a duplicate. A step of its own, so an installation whose `legacyRoutines` is already recorded gets it
/// too, without the schedule and endpoint import running again.
pub const LEGACY_DELIVERIES: Step =
    Step { key: "legacyDeliveries", carries: "the webhook delivery dedup log from the 1.4.5 database, for the endpoints the store holds" };

/// Every post-upgrade step, in the order they run.
pub const STEPS: &[Step] = &[LEGACY_ROUTINES, LEGACY_DELIVERIES];

/// The `meta` key under which `legacyRoutines` records the rows it could not read (a JSON array of `{kind, name, reason}`).
pub const LEGACY_ROUTINES_SKIPPED_KEY: &str = "migration:legacyRoutines:skipped";

/// The value of a finished `legacyRoutines` marker: what was carried and what was left out, or `none`. `skipped` counts the
/// rows that could not be read; they are named under [`LEGACY_ROUTINES_SKIPPED_KEY`] and in the daemon's log.
pub fn legacy_routines_value(schedules: usize, endpoints: usize, kept: usize, skipped: usize) -> String {
    if schedules + endpoints + kept + skipped == 0 {
        return "none".to_owned();
    }
    format!("schedules={schedules},webhooks={endpoints},kept={kept},skipped={skipped}")
}

/// The value of a finished `legacyDeliveries` marker: the claims carried over (those the store already held are not counted)
/// and the rows that could not be read, or `none`.
pub fn legacy_deliveries_value(deliveries: usize, skipped: usize) -> String {
    if deliveries + skipped == 0 {
        return "none".to_owned();
    }
    format!("deliveries={deliveries},skipped={skipped}")
}

/// One step as the report shows it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StepStatus {
    pub step: Step,
    /// The marker's value; `None` while the step has not completed.
    pub recorded: Option<String>,
}

impl StepStatus {
    pub fn done(&self) -> bool {
        self.recorded.is_some()
    }
}

/// What the upgrade has recorded in the store: every `migration:` marker, and the post-upgrade steps
/// with their state.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Report {
    /// Every marker row of the family, by key.
    pub markers: Vec<(String, String)>,
    pub steps: Vec<StepStatus>,
}

/// The report over the family's rows (`CoreState::meta_prefix("migration:")`).
pub fn report(markers: Vec<(String, String)>) -> Report {
    let steps = STEPS
        .iter()
        .map(|step| StepStatus { step: *step, recorded: markers.iter().find(|(key, _)| *key == step.meta_key()).map(|(_, value)| value.clone()) })
        .collect();
    Report { markers, steps }
}

impl Report {
    /// The steps on one line for the completion report: `legacyRoutines: schedules=11,webhooks=0,kept=0,skipped=0; legacyDeliveries: none`,
    /// a step that has not completed reading `pending`.
    pub fn steps_line(&self) -> String {
        let steps: Vec<String> = self.steps.iter().map(|s| format!("{}: {}", s.step.key, s.recorded.as_deref().unwrap_or("pending"))).collect();
        steps.join("; ")
    }
}

/// The report read from `<data>/state/core.sqlite` without opening it for writing; a profile with no
/// state database has recorded nothing.
pub fn read_report(data: &Path) -> Result<Report> {
    let path = data.join("state").join("core.sqlite");
    if !path.exists() {
        return Ok(report(Vec::new()));
    }
    let blocked = |error: rusqlite::Error| Blocked::journal(format!("{}: {error}", path.display()));
    let connection = Connection::open_with_flags(&path, OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX).map_err(blocked)?;
    let has_meta: i64 =
        connection.query_row("SELECT count(*) FROM sqlite_master WHERE type = 'table' AND name = 'meta'", [], |row| row.get(0)).map_err(blocked)?;
    if has_meta == 0 {
        return Ok(report(Vec::new()));
    }
    let mut select = connection.prepare("SELECT key, value FROM meta WHERE key LIKE 'migration:%' ORDER BY key").map_err(blocked)?;
    let markers = select
        .query_map([], |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)))
        .map_err(blocked)?
        .collect::<std::result::Result<Vec<_>, _>>()
        .map_err(blocked)?;
    Ok(report(markers))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_marker_is_in_the_family_the_migration_items_use() {
        assert_eq!(LEGACY_ROUTINES.meta_key(), "migration:legacyRoutines");
        assert!(LEGACY_ROUTINES.meta_key().starts_with(FAMILY));
    }

    #[test]
    fn a_finished_step_records_what_it_carried_and_nothing_is_none() {
        assert_eq!(legacy_routines_value(11, 0, 0, 0), "schedules=11,webhooks=0,kept=0,skipped=0");
        assert_eq!(legacy_routines_value(3, 1, 0, 2), "schedules=3,webhooks=1,kept=0,skipped=2");
        assert_eq!(legacy_routines_value(0, 0, 0, 1), "schedules=0,webhooks=0,kept=0,skipped=1", "an unreadable row alone is not nothing");
        assert_eq!(legacy_routines_value(0, 0, 0, 0), "none");
        assert_eq!(legacy_deliveries_value(4, 1), "deliveries=4,skipped=1");
        assert_eq!(legacy_deliveries_value(0, 0), "none");
    }

    #[test]
    fn the_report_lists_the_family_and_each_step_as_done_or_pending() {
        let pending = report(vec![("migration:desktopProfile/sessionMetadata".into(), "abc".into())]);
        assert_eq!(pending.steps.len(), STEPS.len());
        assert!(!pending.steps[0].done());
        let done = report(vec![("migration:legacyRoutines".into(), "none".into())]);
        assert_eq!(done.steps[0].recorded.as_deref(), Some("none"));
        assert_eq!(pending.steps_line(), "legacyRoutines: pending; legacyDeliveries: pending");
        assert_eq!(done.steps_line(), "legacyRoutines: none; legacyDeliveries: pending");
    }

    #[test]
    fn the_report_reads_the_state_database_read_only() {
        let dir = tempfile::tempdir().unwrap();
        assert!(!read_report(dir.path()).unwrap().steps[0].done(), "no state database: nothing recorded");
        let state = dir.path().join("state");
        std::fs::create_dir_all(&state).unwrap();
        let connection = Connection::open(state.join("core.sqlite")).unwrap();
        connection.execute_batch("CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)").unwrap();
        connection
            .execute_batch(
                "INSERT INTO meta VALUES ('seq:approval', '9'), ('migration:desktopProfile/sessionMetadata', 'abc'), ('migration:legacyRoutines', 'schedules=3,webhooks=0,kept=0,skipped=0'), ('migration:legacyRoutines:skipped', '[]')",
            )
            .unwrap();
        drop(connection);
        let read = read_report(dir.path()).unwrap();
        assert_eq!(read.markers.len(), 3, "only the migration family");
        assert_eq!(read.steps[0].recorded.as_deref(), Some("schedules=3,webhooks=0,kept=0,skipped=0"));
        assert!(!read.steps[1].done(), "the skipped-rows key is not a step");
    }
}
