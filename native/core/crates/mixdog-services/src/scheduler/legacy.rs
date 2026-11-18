//! The executor of the upgrade's `legacyRoutines` step (`mixdog_migrate::post_upgrade`): the routines
//! 1.4.5 kept in its PostgreSQL database (`scheduler.schedules` and `webhooks.endpoints`) come into
//! the core state store, where the schedule and webhook tables now live (`durable`,
//! `webhooks::records`). Nothing else reads the old tables, so without this step an upgraded profile
//! starts with no schedule and no webhook endpoint.
//!
//! The step is done once its marker (`migration:legacyRoutines`, the migration's own family) exists,
//! and the marker commits in the same transaction as the rows: a done step is whole, and a later
//! start reads that marker and nothing else, so the old tables are never queried again and nothing
//! the user has edited or deleted since can be brought back. The step is done also when there was
//! nothing to carry (no old database, no old tables, empty tables). The old tables stay untouched,
//! the way back. A row the new store already holds under the same name is kept as it is. A row that
//! cannot be understood is left out and named (the step's `skipped` record and the daemon's log); the
//! others are carried and the step is finished. A read that fails writes nothing and leaves the step
//! open: that is the only case a later start runs it again.
//!
//! The webhook delivery dedup log (`webhooks.deliveries`) is a step of its own
//! ([`import_legacy_deliveries`], marker `migration:legacyDeliveries`), so an installation whose
//! routines step is already recorded gets it without the schedules and endpoints being read again.
//!
//! A schedule that was due while the profile sat in the old tables is not replayed: a recurring one
//! arms for its next slot after now, and a one-shot whose instant has passed fires once, as the
//! scheduler treats any past-due one-shot at start.

#[cfg(test)]
use std::sync::Arc;

use async_trait::async_trait;
use mixdog_store::state::CoreState;
use serde::de::DeserializeOwned;
use serde_json::{Map, Value};

use super::durable::{key as schedule_key, write_row};
use super::model::Schedule;
use crate::memory::access::MemoryAccess;
use crate::webhooks::records::{EndpointRecord, endpoint_key, endpoint_present, legacy_delivery, write_delivery_if_absent, write_endpoint};

/// The step's marker: its `meta` key, the key the rows it could not read are named under, and the value a finished step
/// records for what it carried (all are the migration's, `mixdog_migrate::post_upgrade`).
pub struct StepMarker {
    pub key: String,
    pub skipped_key: String,
    pub value: fn(&LegacyImport) -> String,
}

/// The marker of the delivery dedup step, and the value it records.
pub struct DeliveriesMarker {
    pub key: String,
    pub value: fn(&DeliveryImport) -> String,
}

/// The old rows, each one as PostgreSQL's `to_jsonb(row)::text` writes it.
#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub struct LegacyRows {
    pub schedules: Vec<String>,
    pub endpoints: Vec<String>,
}

/// Where the old rows come from. A store with no such tables answers no rows.
#[async_trait]
pub trait LegacyRoutineSource: Send + Sync {
    async fn read(&self) -> Result<LegacyRows, String>;
    /// The delivery dedup log (`webhooks.deliveries`), one `to_jsonb(row)::text` per claim.
    async fn read_deliveries(&self) -> Result<Vec<String>, String>;
}

/// An old row the step could not read: it is left out, and named here and in the step's record.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
pub struct SkippedRow {
    /// `schedule`, `webhook` or `delivery`.
    pub kind: &'static str,
    /// The row's name (`endpoint:delivery id` for a delivery), or its position when it has none.
    pub name: String,
    pub reason: String,
}

impl std::fmt::Display for SkippedRow {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{} \"{}\": {}", self.kind, self.name, self.reason)
    }
}

/// What a call did.
#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub struct LegacyImport {
    /// False when the step had already been done.
    pub ran: bool,
    pub schedules: usize,
    pub endpoints: usize,
    /// Old rows left out because the store already held a row of that name.
    pub kept: usize,
    /// Old rows that could not be read: the others were carried and the step is finished.
    pub skipped: Vec<SkippedRow>,
}

/// What a delivery dedup import did.
#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub struct DeliveryImport {
    /// False when the step had already been done.
    pub ran: bool,
    /// Claims written; those the store already held, and those of an endpoint it no longer holds, are not counted.
    pub deliveries: usize,
    pub skipped: Vec<SkippedRow>,
}

impl LegacyImport {
    /// Whether the scheduler and the webhook receiver must read their tables again.
    pub fn changed(&self) -> bool {
        self.schedules + self.endpoints > 0
    }
}

fn camel_key(key: &str) -> String {
    let mut out = String::with_capacity(key.len());
    let mut upper = false;
    for c in key.chars() {
        match (c, upper) {
            ('_', _) => upper = true,
            (c, true) => {
                out.extend(c.to_uppercase());
                upper = false;
            }
            (c, false) => out.push(c),
        }
    }
    out
}

/// A row read as the record `T` its camelCase JSON form names. A column the record does not carry
/// (the legacy `role`, `model`, `target`, ...) is ignored; a null column is an absent one.
fn record_of<T: DeserializeOwned>(kind: &'static str, index: usize, text: &str) -> Result<T, SkippedRow> {
    let skipped = |name: String, reason: String| SkippedRow { kind, name, reason };
    let position = || format!("row {}", index + 1);
    let columns = match serde_json::from_str(text) {
        Ok(Value::Object(columns)) => columns,
        Ok(_) => return Err(skipped(position(), "the row is not an object".to_owned())),
        Err(e) => return Err(skipped(position(), format!("the row is not JSON: {e}"))),
    };
    let record: Map<String, Value> = columns.into_iter().filter(|(_, v)| !v.is_null()).map(|(k, v)| (camel_key(&k), v)).collect();
    let name = record.get("name").and_then(Value::as_str).unwrap_or_default().to_owned();
    if name.is_empty() {
        return Err(skipped(position(), "the row has no name".to_owned()));
    }
    serde_json::from_value(Value::Object(record)).map_err(|e| skipped(name, e.to_string()))
}

/// The readable rows of one table, and the rows that were not.
fn records_of<T: DeserializeOwned>(kind: &'static str, rows: &[String]) -> (Vec<T>, Vec<SkippedRow>) {
    let (mut records, mut skipped) = (Vec::new(), Vec::new());
    for (index, text) in rows.iter().enumerate() {
        match record_of(kind, index, text) {
            Ok(record) => records.push(record),
            Err(row) => skipped.push(row),
        }
    }
    (records, skipped)
}

/// A profile with no old database: nothing to read, so the step records that it carried nothing.
pub struct NoLegacyRoutines;

#[async_trait]
impl LegacyRoutineSource for NoLegacyRoutines {
    async fn read(&self) -> Result<LegacyRows, String> {
        Ok(LegacyRows::default())
    }

    async fn read_deliveries(&self) -> Result<Vec<String>, String> {
        Ok(Vec::new())
    }
}

/// Whether the step has completed: its marker is there. The one read a done step costs.
pub async fn legacy_routines_done(state: &CoreState, marker: &StepMarker) -> Result<bool, String> {
    Ok(state.meta(&marker.key).await.map_err(|e| format!("legacy routines import: {e}"))?.is_some())
}

/// Carries the old rows over and records the step done, once. See the module text.
pub async fn import_legacy_routines(state: &CoreState, source: &dyn LegacyRoutineSource, marker: &StepMarker) -> Result<LegacyImport, String> {
    let store = |e: mixdog_store::sqlite::DbError| format!("legacy routines import: {e}");
    if legacy_routines_done(state, marker).await? {
        return Ok(LegacyImport::default());
    }
    let rows = source.read().await?;
    // A row that cannot be read is left out and named; the others are carried and the step is finished, so it is not run
    // again at every start for a row that will not get better.
    let (schedules, mut skipped) = records_of::<Schedule>("schedule", &rows.schedules);
    let (endpoints, bad_endpoints) = records_of::<EndpointRecord>("webhook", &rows.endpoints);
    skipped.extend(bad_endpoints);
    let (key, skipped_key, render) = (marker.key.clone(), marker.skipped_key.clone(), marker.value);
    state
        .write(move |tx| {
            // Read again inside the transaction: a done step is never written over.
            if tx.meta(&key)?.is_some() {
                return Ok(LegacyImport::default());
            }
            let mut done = LegacyImport { ran: true, skipped, ..LegacyImport::default() };
            for row in &schedules {
                if tx.meta(&schedule_key(&row.name))?.is_some() {
                    done.kept += 1;
                } else {
                    write_row(tx, row)?;
                    done.schedules += 1;
                }
            }
            for row in &endpoints {
                if tx.meta(&endpoint_key(&row.name))?.is_some() {
                    done.kept += 1;
                } else {
                    write_endpoint(tx, row)?;
                    done.endpoints += 1;
                }
            }
            if !done.skipped.is_empty() {
                let named = serde_json::to_string(&done.skipped).map_err(|e| mixdog_store::sqlite::DbError::Write(e.to_string()))?;
                tx.put_meta(&skipped_key, &named)?;
            }
            tx.put_meta(&key, &render(&done))?;
            Ok(done)
        })
        .await
        .map_err(store)
}

/// Carries the delivery dedup log over and records the step done, once. Each claim is written under the key a claim of its
/// id writes, so a provider's redelivery of an event the old version handled is a duplicate. Only the endpoints the store
/// holds get their claims (an endpoint removed since took its log with it), and a claim the store already holds is kept.
/// The old version never pruned the log, so there is no retention window to cut it by. A row that cannot be read is named
/// and left out; a failed read leaves the step open.
pub async fn import_legacy_deliveries(state: &CoreState, source: &dyn LegacyRoutineSource, marker: &DeliveriesMarker) -> Result<DeliveryImport, String> {
    let store = |e: mixdog_store::sqlite::DbError| format!("legacy deliveries import: {e}");
    if state.meta(&marker.key).await.map_err(store)?.is_some() {
        return Ok(DeliveryImport::default());
    }
    let rows = source.read_deliveries().await?;
    let (mut claims, mut skipped) = (Vec::new(), Vec::new());
    for (index, text) in rows.iter().enumerate() {
        match legacy_delivery(text) {
            Ok(claim) => claims.push(claim),
            Err(reason) => skipped.push(SkippedRow { kind: "delivery", name: format!("row {}", index + 1), reason }),
        }
    }
    let (key, render) = (marker.key.clone(), marker.value);
    state
        .write(move |tx| {
            if tx.meta(&key)?.is_some() {
                return Ok(DeliveryImport::default());
            }
            let mut done = DeliveryImport { ran: true, skipped, ..DeliveryImport::default() };
            for claim in &claims {
                if endpoint_present(tx, &claim.endpoint)? && write_delivery_if_absent(tx, claim)? {
                    done.deliveries += 1;
                }
            }
            tx.put_meta(&key, &render(&done))?;
            Ok(done)
        })
        .await
        .map_err(store)
}

/// The old tables in the cluster the memory stack runs on, read as scoped operations of the memory stack's owner: the stop drains or revokes a
/// read in progress and refuses one after it began.
pub struct PgLegacyRoutines {
    access: MemoryAccess,
}

impl PgLegacyRoutines {
    pub fn new(access: MemoryAccess) -> Self {
        Self { access }
    }

    async fn table(&self, table: &str, order: &str) -> Result<Vec<String>, String> {
        let failed = |e: crate::memory::error::MemoryError| format!("legacy routines import: {table}: {}", e.message());
        let (name, sql) = (table.to_owned(), format!("SELECT to_jsonb(t)::text FROM {table} t ORDER BY {order}"));
        let rows = self
            .access
            .run("services.scheduler.legacy-routines", move |db| async move {
                let present = db.query_opt("SELECT to_regclass($1)::text", &[&name]).await?;
                let present: Option<String> = match present {
                    Some(row) => row.try_get(0)?,
                    None => None,
                };
                if present.is_none() {
                    return Ok(Vec::new());
                }
                let rows = db.query(sql.as_str(), &[]).await?;
                Ok(rows.iter().map(|row| row.try_get::<_, String>(0)).collect::<Vec<_>>())
            })
            .await
            .map_err(failed)?;
        rows.into_iter().map(|row| row.map_err(|e| format!("legacy routines import: {table}: {e}"))).collect()
    }
}

#[async_trait]
impl LegacyRoutineSource for PgLegacyRoutines {
    async fn read(&self) -> Result<LegacyRows, String> {
        Ok(LegacyRows { schedules: self.table("scheduler.schedules", "name").await?, endpoints: self.table("webhooks.endpoints", "name").await? })
    }

    async fn read_deliveries(&self) -> Result<Vec<String>, String> {
        self.table("webhooks.deliveries", "endpoint, delivery_id").await
    }
}

#[cfg(test)]
mod tests {
    use std::sync::Mutex;
    use std::sync::atomic::{AtomicUsize, Ordering};

    use chrono::{DateTime, Utc};
    use chrono_tz::Tz;
    use mixdog_rt::testing::tokens;

    use super::*;
    use crate::channels::running::RunningWork;
    use crate::scheduler::store::{Clock, RunOutcome, ScheduleRecords, ScheduleRunner, ScheduleStore, SystemClock};
    use crate::scheduler::{Scheduler, StateScheduleStore};
    use crate::webhooks::records::{EndpointRecords, StateWebhookStore};

    fn at(s: &str) -> DateTime<Utc> {
        s.parse().unwrap()
    }

    /// A recurring schedule as 1.4.5's table reads (`to_jsonb`), taken from a real profile.
    const DAILY: &str = r#"{"name":"upbit daily","description":"","when_at":null,"when_cron":"0 9 * * *","timezone":"Asia/Seoul","cwd":"C:\\Users\\u\\.upbit","attachments":null,"delivery":null,"prompt":"check","enabled":true,"status":"active","last_fired_at":"2026-11-12T09:00:00.011+09:00","last_scheduled_at":"2026-11-12T09:00:00+09:00","last_started_at":"2026-11-12T09:00:00.011+09:00","last_success_at":"2026-11-12T09:00:08.963+09:00","last_failed_at":null,"last_skipped_at":null,"owner_agent_id":"agent-ae035c58e4","executor_agent_id":null,"consecutive_failures":0,"result_delivery":null,"next_fire_at":"2026-11-13T09:00:00+09:00","deferred_until":null,"skipped_until":null,"created_at":"2026-10-24T22:17:39.56379+09:00","updated_at":"2026-11-12T09:00:08.963+09:00","role":"","model":null,"target":"session","run_as_agent":false,"workflow":null}"#;
    const ONCE: &str = r#"{"name":"once","description":"","when_at":"2026-11-04T20:45:00+09:00","when_cron":null,"timezone":null,"prompt":"x","enabled":true,"status":"done","last_fired_at":"2026-11-04T20:45:00+09:00","owner_agent_id":"lead","consecutive_failures":0,"result_delivery":{"run1":{"state":"failed","at":"2026-11-04T11:48:00Z"}}}"#;
    const HOOK: &str = r#"{"name":"gh","description":"d","parser":"github","secret":"s3cret","cwd":null,"attachments":null,"delivery":null,"instructions":"do it","enabled":false,"owner_agent_id":"lead","executor_agent_id":null,"last_event_at":"2026-11-10T01:02:03.456+09:00","last_payload":{"body":{"a":1},"headers":{"x-github-event":"push"}},"last_success_at":null,"last_failed_at":"2026-11-10T01:02:04+09:00","last_skipped_at":null,"consecutive_failures":5,"result_delivery":null,"created_at":"2026-10-01T00:00:00+09:00","updated_at":"2026-11-10T01:02:04+09:00","role":""}"#;

    struct Fixed(Vec<String>, Vec<String>, AtomicUsize, bool, Vec<String>);

    #[async_trait]
    impl LegacyRoutineSource for Fixed {
        async fn read(&self) -> Result<LegacyRows, String> {
            self.2.fetch_add(1, Ordering::SeqCst);
            if self.3 {
                return Err("the database is not up".into());
            }
            Ok(LegacyRows { schedules: self.0.clone(), endpoints: self.1.clone() })
        }

        async fn read_deliveries(&self) -> Result<Vec<String>, String> {
            self.2.fetch_add(1, Ordering::SeqCst);
            if self.3 {
                return Err("the database is not up".into());
            }
            Ok(self.4.clone())
        }
    }

    fn source(schedules: &[&str], endpoints: &[&str]) -> Fixed {
        Fixed(schedules.iter().map(|s| s.to_string()).collect(), endpoints.iter().map(|s| s.to_string()).collect(), AtomicUsize::new(0), false, Vec::new())
    }

    fn deliveries_source(deliveries: &[&str]) -> Fixed {
        Fixed(Vec::new(), Vec::new(), AtomicUsize::new(0), false, deliveries.iter().map(|s| s.to_string()).collect())
    }

    fn marker() -> StepMarker {
        StepMarker {
            key: "migration:legacyRoutines".into(),
            skipped_key: "migration:legacyRoutines:skipped".into(),
            value: |d| format!("schedules={},webhooks={},kept={},skipped={}", d.schedules, d.endpoints, d.kept, d.skipped.len()),
        }
    }

    fn deliveries_marker() -> DeliveriesMarker {
        DeliveriesMarker { key: "migration:legacyDeliveries".into(), value: |d| format!("deliveries={},skipped={}", d.deliveries, d.skipped.len()) }
    }

    async fn open(dir: &std::path::Path) -> CoreState {
        CoreState::open(tokens().sqlite_writer_thread, tokens().interactive_io, &dir.join("core.sqlite")).unwrap().0
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn the_old_tables_come_over_once_with_their_stamps_secrets_and_pause_state() {
        let dir = tempfile::tempdir().unwrap();
        let state = open(dir.path()).await;
        let from = source(&[DAILY, ONCE], &[HOOK]);
        let done = import_legacy_routines(&state, &from, &marker()).await.unwrap();
        assert_eq!(done, LegacyImport { ran: true, schedules: 2, endpoints: 1, kept: 0, skipped: vec![] });
        assert_eq!(state.meta("migration:legacyRoutines").await.unwrap().as_deref(), Some("schedules=2,webhooks=1,kept=0,skipped=0"));
        assert!(done.changed());

        let schedules = StateScheduleStore::new(state.clone(), Arc::new(SystemClock));
        let daily = schedules.get("upbit daily").await.unwrap().unwrap();
        assert_eq!(daily.when_cron.as_deref(), Some("0 9 * * *"));
        assert_eq!(daily.timezone.as_deref(), Some("Asia/Seoul"));
        assert_eq!(daily.owner_agent_id, "agent-ae035c58e4");
        assert_eq!(daily.last_success_at, Some(at("2026-11-12T00:00:08.963Z")));
        assert_eq!(daily.last_scheduled_at, Some(at("2026-11-12T00:00:00Z")));
        let once = schedules.get("once").await.unwrap().unwrap();
        assert_eq!((once.status, once.when_at), (crate::scheduler::ScheduleStatus::Done, Some(at("2026-11-04T11:45:00Z"))));
        assert!(once.result_delivery.is_some());

        let hooks = StateWebhookStore::new(state.clone(), Arc::new(SystemClock));
        let gh = hooks.load("gh").await.unwrap().unwrap();
        assert_eq!((gh.enabled, gh.consecutive_failures, gh.parser.as_deref()), (false, 5, Some("github")));
        assert_eq!(gh.secret.as_deref(), Some("s3cret"));
        assert_eq!(gh.last_payload, Some(serde_json::json!({"body":{"a":1},"headers":{"x-github-event":"push"}})));

        // Once: a second call neither reads the old tables nor writes over what changed since, and
        // what the user deleted stays deleted.
        schedules.set_enabled("upbit daily", false).await.unwrap();
        schedules.delete("once").await.unwrap();
        assert_eq!(import_legacy_routines(&state, &from, &marker()).await.unwrap(), LegacyImport::default());
        assert_eq!(from.2.load(Ordering::SeqCst), 1, "a done step makes no query");
        assert!(!schedules.get("upbit daily").await.unwrap().unwrap().enabled);
        assert!(schedules.get("once").await.unwrap().is_none());
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn a_profile_with_nothing_to_carry_records_the_step_done_too() {
        let dir = tempfile::tempdir().unwrap();
        let state = open(dir.path()).await;
        let none = import_legacy_routines(&state, &NoLegacyRoutines, &marker()).await.unwrap();
        assert_eq!(none, LegacyImport { ran: true, ..LegacyImport::default() });
        assert!(!none.changed());
        assert_eq!(state.meta("migration:legacyRoutines").await.unwrap().as_deref(), Some("schedules=0,webhooks=0,kept=0,skipped=0"));
        assert!(legacy_routines_done(&state, &marker()).await.unwrap());
        let later = source(&[DAILY], &[]);
        assert_eq!(import_legacy_routines(&state, &later, &marker()).await.unwrap(), LegacyImport::default());
        assert_eq!(later.2.load(Ordering::SeqCst), 0, "rows that appear in the old tables afterwards are not read");
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn a_row_the_store_already_holds_is_kept_and_a_failed_read_leaves_the_step_open() {
        let dir = tempfile::tempdir().unwrap();
        let state = open(dir.path()).await;
        let schedules = StateScheduleStore::new(state.clone(), Arc::new(SystemClock));
        schedules
            .upsert(&Schedule { name: "upbit daily".into(), prompt: "new".into(), when_cron: Some("0 8 * * *".into()), ..Default::default() })
            .await
            .unwrap();

        let mut down = source(&[DAILY], &[]);
        down.3 = true;
        assert!(import_legacy_routines(&state, &down, &marker()).await.is_err());
        assert!(!legacy_routines_done(&state, &marker()).await.unwrap());

        let done = import_legacy_routines(&state, &source(&[DAILY], &[HOOK]), &marker()).await.unwrap();
        assert_eq!(done, LegacyImport { ran: true, schedules: 0, endpoints: 1, kept: 1, skipped: vec![] });
        assert_eq!(schedules.get("upbit daily").await.unwrap().unwrap().prompt, "new");
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn a_row_that_cannot_be_read_is_named_and_the_others_are_carried_and_the_step_is_finished() {
        let dir = tempfile::tempdir().unwrap();
        let state = open(dir.path()).await;
        let bad = r#"{"name":"x","when_cron":7}"#;
        let nameless = r#"{"prompt":"p"}"#;
        let done = import_legacy_routines(&state, &source(&[DAILY, bad], &[HOOK, nameless, "not json"]), &marker()).await.unwrap();
        assert_eq!((done.schedules, done.endpoints), (1, 1));
        let named: Vec<String> = done.skipped.iter().map(|row| format!("{}|{}", row.kind, row.name)).collect();
        assert_eq!(named, ["schedule|x", "webhook|row 2", "webhook|row 3"]);
        assert!(done.skipped.iter().all(|row| !row.reason.is_empty()));
        let schedules = StateScheduleStore::new(state.clone(), Arc::new(SystemClock));
        assert_eq!(schedules.list().await.unwrap().len(), 1, "the readable schedule came over");
        assert!(legacy_routines_done(&state, &marker()).await.unwrap(), "finished, so it is not run again at every start");
        assert_eq!(state.meta("migration:legacyRoutines").await.unwrap().as_deref(), Some("schedules=1,webhooks=1,kept=0,skipped=3"));
        let recorded = state.meta("migration:legacyRoutines:skipped").await.unwrap().unwrap();
        let recorded: Value = serde_json::from_str(&recorded).unwrap();
        assert_eq!(recorded[0], serde_json::json!({"kind":"schedule","name":"x","reason":done.skipped[0].reason}));
    }

    /// Node reads `row.owner_agent_id || 'lead'`: an owner stored empty is Mixy's, however the row came in.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn an_empty_owner_is_lead_as_node_reads_it() {
        let dir = tempfile::tempdir().unwrap();
        let state = open(dir.path()).await;
        let empty_schedule = r#"{"name":"s","prompt":"p","when_cron":"0 9 * * *","owner_agent_id":""}"#;
        let empty_hook = r#"{"name":"h","instructions":"i","owner_agent_id":""}"#;
        import_legacy_routines(&state, &source(&[empty_schedule], &[empty_hook]), &marker()).await.unwrap();
        let schedules = StateScheduleStore::new(state.clone(), Arc::new(SystemClock));
        assert_eq!(schedules.get("s").await.unwrap().unwrap().owner_agent_id, "lead");
        let hooks = StateWebhookStore::new(state.clone(), Arc::new(SystemClock));
        assert_eq!(hooks.load("h").await.unwrap().unwrap().owner_agent_id, "lead");
        // A row an earlier import stored with the empty owner reads the same: the rule is at the read, not only the import.
        state.write(|tx| tx.put_meta(&schedule_key("old"), r#"{"name":"old","prompt":"p","ownerAgentId":""}"#)).await.unwrap();
        assert_eq!(schedules.get("old").await.unwrap().unwrap().owner_agent_id, "lead");
    }

    const CLAIM_DONE: &str = r#"{"endpoint":"gh","delivery_id":"d1:body-sha256-aa","status":"done","event":"push","error":null,"headers_summary":{"event_type":"push"},"payload_preview":"{}","created_at":"2026-11-10T01:02:03.456+09:00","updated_at":"2026-11-10T01:02:05+09:00"}"#;
    const CLAIM_FAILED: &str = r#"{"endpoint":"gh","delivery_id":"d2:body-sha256-bb","status":"failed","event":null,"error":"boom","headers_summary":null,"payload_preview":null,"created_at":"2026-11-10T02:00:00+09:00","updated_at":"2026-11-10T02:00:01+09:00"}"#;
    const CLAIM_GONE: &str = r#"{"endpoint":"removed","delivery_id":"d3","status":"done","created_at":"2026-11-10T02:00:00+09:00","updated_at":"2026-11-10T02:00:01+09:00"}"#;

    /// A provider redelivering an event the old version handled must not run it again. Legacy
    /// failures do not say whether the old version had already accepted the delivery.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn a_delivery_the_old_version_handled_is_a_duplicate_after_the_upgrade() {
        use crate::webhooks::handler::{Claim, WebhookStore};
        let dir = tempfile::tempdir().unwrap();
        let state = open(dir.path()).await;
        import_legacy_routines(&state, &source(&[], &[HOOK]), &marker()).await.unwrap();
        let rows = deliveries_source(&[CLAIM_DONE, CLAIM_FAILED, CLAIM_GONE, "{\"endpoint\":\"gh\"}"]);
        let done = import_legacy_deliveries(&state, &rows, &deliveries_marker()).await.unwrap();
        assert_eq!((done.ran, done.deliveries, done.skipped.len()), (true, 2, 1), "the removed endpoint's claim is not brought back");
        assert_eq!(done.skipped[0].kind, "delivery");
        assert_eq!(state.meta("migration:legacyDeliveries").await.unwrap().as_deref(), Some("deliveries=2,skipped=1"));

        let hooks = StateWebhookStore::new(state.clone(), Arc::new(SystemClock));
        let claim = || Claim { status: "received", event: Some("push"), headers_summary: serde_json::json!({}), payload_preview: "{}".into() };
        assert!(!hooks.claim_delivery("gh", "d1:body-sha256-aa", claim()).await.unwrap(), "handled before the upgrade: a duplicate");
        assert!(!hooks.claim_delivery("gh", "d2:body-sha256-bb", claim()).await.unwrap(), "a legacy failure may have been an accepted run");
        assert!(hooks.claim_delivery("removed", "d3", claim()).await.unwrap());

        // Once, and on its own: a later call reads nothing, and the routines step is not involved.
        let again = deliveries_source(&[CLAIM_DONE]);
        assert_eq!(import_legacy_deliveries(&state, &again, &deliveries_marker()).await.unwrap(), DeliveryImport::default());
        assert_eq!(again.2.load(Ordering::SeqCst), 0);
    }

    /// The installation whose routines step is already recorded gets the dedup log without the schedules being read again.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn the_dedup_log_reaches_an_installation_whose_routines_step_is_already_recorded() {
        let dir = tempfile::tempdir().unwrap();
        let state = open(dir.path()).await;
        let routines = source(&[DAILY], &[HOOK]);
        import_legacy_routines(&state, &routines, &marker()).await.unwrap();
        let calls = routines.2.load(Ordering::SeqCst);
        let done = import_legacy_deliveries(&state, &deliveries_source(&[CLAIM_DONE]), &deliveries_marker()).await.unwrap();
        assert_eq!(done.deliveries, 1);
        assert_eq!(import_legacy_routines(&state, &routines, &marker()).await.unwrap(), LegacyImport::default());
        assert_eq!(routines.2.load(Ordering::SeqCst), calls, "the routines were not read again");
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn a_failed_delivery_read_leaves_the_dedup_step_open() {
        let dir = tempfile::tempdir().unwrap();
        let state = open(dir.path()).await;
        let mut down = deliveries_source(&[CLAIM_DONE]);
        down.3 = true;
        assert!(import_legacy_deliveries(&state, &down, &deliveries_marker()).await.is_err());
        assert!(state.meta("migration:legacyDeliveries").await.unwrap().is_none());
    }

    struct Idle(AtomicUsize);

    #[async_trait]
    impl ScheduleRunner for Idle {
        async fn run(&self, _: &Schedule, _: &str) -> Result<RunOutcome, String> {
            self.0.fetch_add(1, Ordering::SeqCst);
            Ok(RunOutcome::Done)
        }
    }

    struct At(Mutex<DateTime<Utc>>);
    impl Clock for At {
        fn now(&self) -> DateTime<Utc> {
            *self.0.lock().unwrap()
        }
    }

    /// The daily slot of 2026-11-13 and 2026-11-14 passed while the profile was away: neither runs,
    /// and the schedule waits for its next slot after now.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn an_imported_schedule_that_was_due_meanwhile_is_not_replayed() {
        let dir = tempfile::tempdir().unwrap();
        let state = open(dir.path()).await;
        import_legacy_routines(&state, &source(&[DAILY], &[]), &marker()).await.unwrap();
        let clock: Arc<dyn Clock> = Arc::new(At(Mutex::new(at("2026-11-15T01:00:00Z"))));
        let store = Arc::new(StateScheduleStore::new(state.clone(), clock.clone()));
        let rows = store.list().await.unwrap();
        let runner = Arc::new(Idle(AtomicUsize::new(0)));
        let scheduler = Scheduler::new(store, runner.clone(), clock, RunningWork::new(), Tz::UTC, rows);
        scheduler.start();
        assert_eq!(scheduler.status()[0].next_fire.as_deref(), Some("2026-11-16T00:00:00.000Z"));
        assert_eq!(runner.0.load(Ordering::SeqCst), 0);
        scheduler.stop();
    }
}
