//! The durable schedule table: one JSON row per schedule in the core state store
//! (`state/core.sqlite`, `meta` key `schedule:<name>`). Every statement of schedules-db.mjs is
//! one state transaction that reads the row, applies the shared row rule (`rows`) and writes
//! it back, so a claim, a stamp or a rename is as atomic as the Postgres `UPDATE` it replaces.

use std::sync::Arc;

use async_trait::async_trait;
use mixdog_store::sqlite::DbError;
use mixdog_store::state::{CoreState, StateTx};
use serde_json::Value;

use super::model::{Schedule, ScheduleError};
use super::rows;
use super::store::{Clock, ScheduleRecords, ScheduleStore, Ts};

pub const KEY_PREFIX: &str = "schedule:";

fn key(name: &str) -> String {
    format!("{KEY_PREFIX}{name}")
}

fn store_error(error: DbError) -> ScheduleError {
    ScheduleError::Store(format!("schedule store: {error}"))
}

fn parse(name: &str, text: &str) -> Result<Schedule, DbError> {
    serde_json::from_str(text).map_err(|e| DbError::Write(format!("schedule \"{name}\" is unreadable: {e}")))
}

fn read_row(tx: &StateTx<'_>, name: &str) -> Result<Option<Schedule>, DbError> {
    tx.meta(&key(name))?.map(|text| parse(name, &text)).transpose()
}

fn write_row(tx: &StateTx<'_>, row: &Schedule) -> Result<(), DbError> {
    let text = serde_json::to_string(row).map_err(|e| DbError::Write(e.to_string()))?;
    tx.put_meta(&key(&row.name), &text)
}

pub struct StateScheduleStore {
    state: CoreState,
    clock: Arc<dyn Clock>,
}

impl StateScheduleStore {
    pub fn new(state: CoreState, clock: Arc<dyn Clock>) -> Self {
        Self { state, clock }
    }

    /// Applies `f` to row `name` in one transaction and stamps `updatedAt`; None when the row
    /// does not exist.
    async fn edit<R: Send + 'static>(
        &self,
        name: &str,
        f: impl FnOnce(&mut Schedule) -> R + Send + 'static,
    ) -> Result<Option<R>, ScheduleError> {
        let (name, now) = (name.to_owned(), self.clock.now());
        self.state
            .write(move |tx| {
                let Some(mut row) = read_row(tx, &name)? else { return Ok(None) };
                let out = f(&mut row);
                row.updated_at = Some(now);
                write_row(tx, &row)?;
                Ok(Some(out))
            })
            .await
            .map_err(store_error)
    }
}

#[async_trait]
impl ScheduleStore for StateScheduleStore {
    async fn get(&self, name: &str) -> Result<Option<Schedule>, ScheduleError> {
        let text = self.state.meta(&key(name)).await.map_err(store_error)?;
        text.map(|t| parse(name, &t)).transpose().map_err(store_error)
    }

    async fn list(&self) -> Result<Vec<Schedule>, ScheduleError> {
        let rows = self.state.meta_prefix(KEY_PREFIX).await.map_err(store_error)?;
        let mut all = rows
            .iter()
            .map(|(k, text)| parse(&k[KEY_PREFIX.len()..], text))
            .collect::<Result<Vec<_>, _>>()
            .map_err(store_error)?;
        // Node's `ORDER BY name` runs on the embedded PG, initdb'd `--no-locale -E UTF8`
        // (memory/lib/pg/process.mjs): C collation = byte order of the UTF-8, i.e. code-point
        // order, which is exactly `str::cmp` (not UTF-16 order for names beyond the BMP).
        all.sort_by(|a, b| a.name.cmp(&b.name));
        Ok(all)
    }

    async fn mark_fired(&self, name: &str, at: Ts) -> Result<(), ScheduleError> {
        self.edit(name, move |s| s.last_fired_at = Some(at)).await.map(drop)
    }

    async fn set_next_fire(&self, name: &str, at: Option<Ts>) -> Result<(), ScheduleError> {
        self.edit(name, move |s| s.next_fire_at = at).await.map(drop)
    }

    async fn advance_cursor(&self, name: &str, scheduled_at: Ts, next: Option<Ts>) -> Result<bool, ScheduleError> {
        Ok(self.edit(name, move |s| rows::claim(s, scheduled_at, None, next)).await?.unwrap_or(false))
    }

    async fn claim_run(&self, name: &str, scheduled_at: Ts, started_at: Ts, next: Option<Ts>) -> Result<bool, ScheduleError> {
        Ok(self.edit(name, move |s| rows::claim(s, scheduled_at, Some(started_at), next)).await?.unwrap_or(false))
    }

    async fn mark_success(&self, name: &str, at: Ts) -> Result<(), ScheduleError> {
        self.edit(name, move |s| rows::success(s, at)).await.map(drop)
    }

    async fn mark_failure(&self, name: &str, at: Ts) -> Result<(), ScheduleError> {
        self.edit(name, move |s| rows::failure(s, at)).await.map(drop)
    }

    async fn mark_skipped(&self, name: &str, at: Ts) -> Result<(), ScheduleError> {
        self.edit(name, move |s| s.last_skipped_at = Some(at)).await.map(drop)
    }

    async fn mark_done(&self, name: &str) -> Result<(), ScheduleError> {
        self.edit(name, rows::done).await.map(drop)
    }

    async fn set_deferred(&self, name: &str, until: Option<Ts>) -> Result<(), ScheduleError> {
        self.edit(name, move |s| s.deferred_until = until).await.map(drop)
    }

    async fn set_skipped_until(&self, name: &str, until: Option<Ts>) -> Result<(), ScheduleError> {
        self.edit(name, move |s| s.skipped_until = until).await.map(drop)
    }
}

#[async_trait]
impl ScheduleRecords for StateScheduleStore {
    async fn upsert(&self, def: &Schedule) -> Result<Schedule, ScheduleError> {
        let (def, now) = (def.clone(), self.clock.now());
        self.state
            .write(move |tx| {
                let row = rows::redefined(&def, read_row(tx, &def.name)?.as_ref(), now);
                write_row(tx, &row)?;
                Ok(row)
            })
            .await
            .map_err(store_error)
    }

    async fn rename(&self, old: &str, def: &Schedule, timing_changed: bool) -> Result<Option<Schedule>, ScheduleError> {
        let (old, def, now) = (old.to_owned(), def.clone(), self.clock.now());
        // The occupied-name refusal rides out of the transaction as a value: it must roll
        // nothing back, because nothing was written.
        let outcome = self
            .state
            .write(move |tx| {
                let Some(current) = read_row(tx, &old)? else { return Ok(Ok(None)) };
                if def.name != old && tx.meta(&key(&def.name))?.is_some() {
                    return Ok(Err(def.name.clone()));
                }
                let row = rows::renamed(&current, &def, timing_changed, now);
                tx.delete_meta(&key(&old))?;
                write_row(tx, &row)?;
                Ok(Ok(Some(row)))
            })
            .await
            .map_err(store_error)?;
        outcome.map_err(|name| ScheduleError::NameTaken { name })
    }

    async fn delete(&self, name: &str) -> Result<bool, ScheduleError> {
        let name = name.to_owned();
        self.state.write(move |tx| tx.delete_meta(&key(&name))).await.map_err(store_error)
    }

    async fn set_enabled(&self, name: &str, enabled: bool) -> Result<Option<Schedule>, ScheduleError> {
        self.edit(name, move |s| {
            rows::enabled(s, enabled);
            s.clone()
        })
        .await
    }

    async fn record_delivery(&self, name: &str, run_id: &str, entry: Option<Value>) -> Result<(), ScheduleError> {
        let (name, run_id) = (name.to_owned(), run_id.to_owned());
        self.state
            .write(move |tx| {
                let Some(mut row) = read_row(tx, &name)? else { return Ok(()) };
                rows::delivery(&mut row, &run_id, entry);
                write_row(tx, &row)
            })
            .await
            .map_err(store_error)
    }
}

#[cfg(test)]
mod tests {
    use chrono::Utc;
    use mixdog_rt::testing::tokens;
    use serde_json::json;

    use super::*;
    use crate::scheduler::SystemClock;

    async fn open(dir: &std::path::Path) -> StateScheduleStore {
        let (state, _) = CoreState::open(tokens().sqlite_writer_thread, tokens().interactive_io, &dir.join("core.sqlite")).unwrap();
        StateScheduleStore::new(state, Arc::new(SystemClock))
    }

    fn def(name: &str) -> Schedule {
        Schedule { name: name.into(), prompt: "p".into(), when_cron: Some("0 9 * * *".into()), ..Default::default() }
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn rows_survive_a_restart_and_claims_are_once_per_slot() {
        let dir = tempfile::tempdir().unwrap();
        let store = open(dir.path()).await;
        store.upsert(&def("daily")).await.unwrap();
        let slot = Utc::now();
        assert!(store.claim_run("daily", slot, slot, None).await.unwrap());
        assert!(!store.claim_run("daily", slot, slot, None).await.unwrap());
        assert!(!store.claim_run("missing", slot, slot, None).await.unwrap());
        store.mark_failure("daily", slot).await.unwrap();
        drop(store);

        let store = open(dir.path()).await;
        let row = store.get("daily").await.unwrap().unwrap();
        assert_eq!((row.consecutive_failures, row.last_scheduled_at), (1, Some(slot)));
        assert_eq!(store.list().await.unwrap().len(), 1);
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn concurrent_claims_of_one_slot_have_one_winner() {
        let dir = tempfile::tempdir().unwrap();
        let store = Arc::new(open(dir.path()).await);
        store.upsert(&def("daily")).await.unwrap();
        let slot = Utc::now();
        let claims = (0..8).map(|_| {
            let store = store.clone();
            tokio::spawn(async move { store.claim_run("daily", slot, slot, None).await.unwrap() })
        });
        let wins = futures::future::join_all(claims).await.into_iter().filter(|w| *w.as_ref().unwrap()).count();
        assert_eq!(wins, 1);
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn rename_moves_the_row_and_an_occupied_name_changes_nothing() {
        let dir = tempfile::tempdir().unwrap();
        let store = open(dir.path()).await;
        store.upsert(&def("a")).await.unwrap();
        store.upsert(&def("b")).await.unwrap();
        let err = store.rename("a", &def("b"), false).await.unwrap_err();
        assert_eq!(err, ScheduleError::NameTaken { name: "b".into() });
        assert!(store.get("a").await.unwrap().is_some());
        let moved = store.rename("a", &def("c"), false).await.unwrap().unwrap();
        assert_eq!(moved.name, "c");
        assert!(store.get("a").await.unwrap().is_none());
        assert!(store.rename("a", &def("d"), false).await.unwrap().is_none());
        assert_eq!(store.list().await.unwrap().iter().map(|s| s.name.as_str()).collect::<Vec<_>>(), ["b", "c"]);
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn delivery_record_and_enable_switch_persist() {
        let dir = tempfile::tempdir().unwrap();
        let store = open(dir.path()).await;
        store.upsert(&def("a")).await.unwrap();
        store.record_delivery("a", "r1", Some(json!({"state":"failed"}))).await.unwrap();
        assert_eq!(store.get("a").await.unwrap().unwrap().result_delivery, Some(json!({"r1":{"state":"failed"}})));
        store.record_delivery("a", "r1", None).await.unwrap();
        assert_eq!(store.get("a").await.unwrap().unwrap().result_delivery, None);
        for _ in 0..5 {
            store.mark_failure("a", Utc::now()).await.unwrap();
        }
        assert!(!store.get("a").await.unwrap().unwrap().enabled);
        let on = store.set_enabled("a", true).await.unwrap().unwrap();
        assert_eq!((on.enabled, on.consecutive_failures), (true, 0));
        assert!(store.set_enabled("nope", true).await.unwrap().is_none());
        assert!(store.delete("a").await.unwrap());
        assert!(!store.delete("a").await.unwrap());
    }
}
