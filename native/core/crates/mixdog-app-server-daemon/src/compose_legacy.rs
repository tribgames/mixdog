//! The upgrade's steps that carry the earlier version's scheduled routines, webhook endpoints and delivery log over to the
//! core state: the order each runs its checks in. The composition starts them behind the serving core.

/// The step's marker: the migration's own (`migration:legacyRoutines`) and the value it records for what was carried.
pub(crate) fn legacy_routines_marker() -> mixdog_services::scheduler::legacy::StepMarker {
    mixdog_services::scheduler::legacy::StepMarker {
        key: mixdog_migrate::post_upgrade::LEGACY_ROUTINES.meta_key(),
        skipped_key: mixdog_migrate::post_upgrade::LEGACY_ROUTINES_SKIPPED_KEY.to_owned(),
        value: |done| mixdog_migrate::post_upgrade::legacy_routines_value(done.schedules, done.endpoints, done.kept, done.skipped.len()),
    }
}

/// The marker of the webhook delivery dedup step (`migration:legacyDeliveries`) and the value it records.
pub(crate) fn legacy_deliveries_marker() -> mixdog_services::scheduler::legacy::DeliveriesMarker {
    mixdog_services::scheduler::legacy::DeliveriesMarker {
        key: mixdog_migrate::post_upgrade::LEGACY_DELIVERIES.meta_key(),
        value: |done| mixdog_migrate::post_upgrade::legacy_deliveries_value(done.deliveries, done.skipped.len()),
    }
}

/// Whether the 1.4.5 cluster is there (`PG_VERSION` is its mark). `std::fs::exists`: absence is `Ok(false)`, a path that cannot
/// be told is an error, and so is a lost lane job.
pub(crate) async fn old_cluster_present(lane: mixdog_rt::MaintenanceIo, version: std::path::PathBuf) -> Result<bool, String> {
    use mixdog_rt::LaneToken as _;
    let job = lane.submit_wait(&tokio_util::sync::CancellationToken::new(), move |proof| mixdog_fsio::exists(proof, &version)).await;
    job.map_err(|error| format!("the cluster probe was not queued: {error:?}"))?
        .await
        .map_err(|error| format!("the cluster probe was dropped: {error:?}"))?
        .map_err(|error| format!("the old cluster could not be probed: {error}"))
}

/// The order of the `legacyDeliveries` step, as [`carry_over_legacy_routines`] orders its own: a done step is one marker read; no
/// old cluster is nothing to carry and the step is recorded at once; otherwise the database must be ready before anything is read.
pub(crate) async fn carry_over_legacy_deliveries(
    state: &mixdog_store::state::CoreState,
    marker: &mixdog_services::scheduler::legacy::DeliveriesMarker,
    cluster_exists: impl FnOnce() -> futures::future::BoxFuture<'static, Result<bool, String>>,
    ready: impl FnOnce() -> futures::future::BoxFuture<'static, Result<(), String>>,
    source: &dyn mixdog_services::scheduler::legacy::LegacyRoutineSource,
) -> Result<mixdog_services::scheduler::legacy::DeliveryImport, String> {
    use mixdog_services::scheduler::legacy::{NoLegacyRoutines, import_legacy_deliveries};
    if state.meta(&marker.key).await.map_err(|e| format!("legacy deliveries import: {e}"))?.is_some() {
        return Ok(Default::default());
    }
    if !cluster_exists().await? {
        return import_legacy_deliveries(state, &NoLegacyRoutines, marker).await;
    }
    ready().await?;
    import_legacy_deliveries(state, source, marker).await
}

/// How long the `legacyRoutines` step waits for the memory database to be ready before it gives the start up (the next one runs it).
pub(crate) const LEGACY_ROUTINES_DB_WAIT: std::time::Duration = std::time::Duration::from_secs(600);

/// The order of the upgrade's `legacyRoutines` step. A done step (its marker) is the only thing read. Otherwise: no old cluster is
/// nothing to carry, and the step is recorded done at once; with one, the database must be ready before anything is read; the rows
/// and the marker commit as one (the scheduler's own load sees all of them or none); and when rows came, `arm` makes the scheduler
/// arm them in this run. Any failure leaves the marker unwritten, so the next start runs the step again.
pub(crate) async fn carry_over_legacy_routines(
    state: &mixdog_store::state::CoreState,
    marker: &mixdog_services::scheduler::legacy::StepMarker,
    cluster_exists: impl FnOnce() -> futures::future::BoxFuture<'static, Result<bool, String>>,
    ready: impl FnOnce() -> futures::future::BoxFuture<'static, Result<(), String>>,
    source: &dyn mixdog_services::scheduler::legacy::LegacyRoutineSource,
    arm: impl FnOnce() -> futures::future::BoxFuture<'static, Result<(), String>>,
) -> Result<mixdog_services::scheduler::legacy::LegacyImport, String> {
    use mixdog_services::scheduler::legacy::{NoLegacyRoutines, import_legacy_routines, legacy_routines_done};
    if legacy_routines_done(state, marker).await? {
        return Ok(Default::default());
    }
    // Only a confirmed absence completes the step empty; a probe that failed leaves it open.
    if !cluster_exists().await? {
        return import_legacy_routines(state, &NoLegacyRoutines, marker).await;
    }
    ready().await?;
    let done = import_legacy_routines(state, source, marker).await?;
    if done.changed() {
        arm().await.map_err(|error| format!("the carried routines are stored, but arming them failed: {error}"))?;
    }
    Ok(done)
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;
    use std::sync::atomic::{AtomicUsize, Ordering};

    use async_trait::async_trait;
    use mixdog_services::scheduler::legacy::{LegacyImport, LegacyRoutineSource, LegacyRows};
    use mixdog_services::scheduler::{ScheduleRecords, ScheduleStore, StateScheduleStore, SystemClock};

    use super::*;

    const DAILY: &str = r#"{"name":"daily","description":"","when_at":null,"when_cron":"0 9 * * *","timezone":"Asia/Seoul","prompt":"check","enabled":true,"status":"active","owner_agent_id":"lead","consecutive_failures":0}"#;

    /// The old tables: how often they were read, and whether the database they sit in is up.
    struct OldTables {
        reads: AtomicUsize,
        rows: Vec<String>,
        deliveries: Vec<String>,
    }

    #[async_trait]
    impl LegacyRoutineSource for OldTables {
        async fn read(&self) -> Result<LegacyRows, String> {
            self.reads.fetch_add(1, Ordering::SeqCst);
            Ok(LegacyRows { schedules: self.rows.clone(), endpoints: Vec::new() })
        }

        async fn read_deliveries(&self) -> Result<Vec<String>, String> {
            self.reads.fetch_add(1, Ordering::SeqCst);
            Ok(self.deliveries.clone())
        }
    }

    /// What the step called, in how many calls.
    #[derive(Default)]
    struct Calls {
        cluster: AtomicUsize,
        ready: AtomicUsize,
        arm: AtomicUsize,
    }

    async fn run(
        state: &mixdog_store::state::CoreState,
        tables: &OldTables,
        calls: &Arc<Calls>,
        cluster: Result<bool, String>,
        ready: Result<(), String>,
        arm: Result<(), String>,
    ) -> Result<LegacyImport, String> {
        let (c, r, a) = (calls.clone(), calls.clone(), calls.clone());
        carry_over_legacy_routines(
            state,
            &legacy_routines_marker(),
            move || {
                Box::pin(async move {
                    c.cluster.fetch_add(1, Ordering::SeqCst);
                    cluster
                })
            },
            move || {
                Box::pin(async move {
                    r.ready.fetch_add(1, Ordering::SeqCst);
                    ready
                })
            },
            tables,
            move || {
                Box::pin(async move {
                    a.arm.fetch_add(1, Ordering::SeqCst);
                    arm
                })
            },
        )
        .await
    }

    fn open(dir: &std::path::Path) -> mixdog_store::state::CoreState {
        let tokens = mixdog_rt::testing::tokens();
        mixdog_store::state::CoreState::open(tokens.sqlite_writer_thread, tokens.interactive_io, &dir.join("core.sqlite")).unwrap().0
    }

    fn tables() -> OldTables {
        OldTables { reads: AtomicUsize::new(0), rows: vec![DAILY.to_owned()], deliveries: Vec::new() }
    }

    /// A done step is one marker read: a later start asks no question about the cluster, waits for no database and
    /// reads no old table, and what the user deleted from the new store stays deleted.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn a_done_step_makes_no_query_at_a_later_start() {
        let dir = tempfile::tempdir().unwrap();
        let state = open(dir.path());
        let (old, first) = (tables(), Arc::new(Calls::default()));
        let done = run(&state, &old, &first, Ok(true), Ok(()), Ok(())).await.unwrap();
        assert_eq!((done.ran, done.schedules), (true, 1));
        assert_eq!(state.meta("migration:legacyRoutines").await.unwrap().as_deref(), Some("schedules=1,webhooks=0,kept=0,skipped=0"));
        let store = StateScheduleStore::new(state.clone(), Arc::new(SystemClock));
        store.delete("daily").await.unwrap();

        let later = Arc::new(Calls::default());
        let again = run(&state, &old, &later, Ok(true), Err("must not be asked".into()), Err("must not be asked".into())).await.unwrap();
        assert_eq!(again, LegacyImport::default());
        assert_eq!(old.reads.load(Ordering::SeqCst), 1, "the old table was read by the first start only");
        assert_eq!((later.cluster.load(Ordering::SeqCst), later.ready.load(Ordering::SeqCst), later.arm.load(Ordering::SeqCst)), (0, 0, 0));
        assert!(store.get("daily").await.unwrap().is_none(), "a deleted row is not brought back");
    }

    /// Without an old cluster there is nothing to carry: the step is recorded done at once, the database is not waited for.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn a_profile_without_an_old_cluster_records_the_step_without_waiting_for_the_database() {
        let dir = tempfile::tempdir().unwrap();
        let state = open(dir.path());
        let (old, calls) = (tables(), Arc::new(Calls::default()));
        let done = run(&state, &old, &calls, Ok(false), Err("must not be asked".into()), Err("must not be asked".into())).await.unwrap();
        assert!(done.ran && !done.changed());
        assert_eq!(state.meta("migration:legacyRoutines").await.unwrap().as_deref(), Some("none"));
        assert_eq!((old.reads.load(Ordering::SeqCst), calls.ready.load(Ordering::SeqCst), calls.arm.load(Ordering::SeqCst)), (0, 0, 0));
    }

    /// A database that is not ready, or rows that cannot be read, leave the step open: the next start runs it again.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn a_database_that_is_not_ready_leaves_the_step_open_for_the_next_start() {
        let dir = tempfile::tempdir().unwrap();
        let state = open(dir.path());
        let (old, calls) = (tables(), Arc::new(Calls::default()));
        let failed = run(&state, &old, &calls, Ok(true), Err("the database did not open".into()), Ok(())).await;
        assert_eq!(failed, Err("the database did not open".to_owned()));
        assert!(state.meta("migration:legacyRoutines").await.unwrap().is_none());
        assert_eq!(old.reads.load(Ordering::SeqCst), 0);
        let next = run(&state, &old, &Arc::new(Calls::default()), Ok(true), Ok(()), Ok(())).await.unwrap();
        assert_eq!(next.schedules, 1);
    }

    /// A probe that could not tell whether the old cluster is there is not "nothing to carry": the step stays open, writes
    /// nothing, and the next start (whose probe answers) carries the rows.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn a_failed_cluster_probe_does_not_complete_the_step_empty() {
        let dir = tempfile::tempdir().unwrap();
        let state = open(dir.path());
        let (old, calls) = (tables(), Arc::new(Calls::default()));
        let failed = run(&state, &old, &calls, Err("the old cluster could not be probed: access denied".into()), Ok(()), Ok(())).await;
        assert_eq!(failed, Err("the old cluster could not be probed: access denied".to_owned()));
        assert!(state.meta("migration:legacyRoutines").await.unwrap().is_none());
        assert_eq!((old.reads.load(Ordering::SeqCst), calls.ready.load(Ordering::SeqCst)), (0, 0));
        let next = run(&state, &old, &Arc::new(Calls::default()), Ok(true), Ok(()), Ok(())).await.unwrap();
        assert_eq!(next.schedules, 1);
    }

    /// Rows that came are armed in this run, once; nothing that came arms nothing; a failed arming is reported and
    /// the step stays done (the rows are stored, and the next start loads them).
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn carried_rows_are_armed_in_the_same_run() {
        let dir = tempfile::tempdir().unwrap();
        let state = open(dir.path());
        let (old, calls) = (tables(), Arc::new(Calls::default()));
        run(&state, &old, &calls, Ok(true), Ok(()), Ok(())).await.unwrap();
        assert_eq!(calls.arm.load(Ordering::SeqCst), 1);

        let other = tempfile::tempdir().unwrap();
        let state = open(other.path());
        let (empty, calls) = (OldTables { reads: AtomicUsize::new(0), rows: Vec::new(), deliveries: Vec::new() }, Arc::new(Calls::default()));
        run(&state, &empty, &calls, Ok(true), Ok(()), Ok(())).await.unwrap();
        assert_eq!(calls.arm.load(Ordering::SeqCst), 0, "empty tables arm nothing");

        let third = tempfile::tempdir().unwrap();
        let state = open(third.path());
        let calls = Arc::new(Calls::default());
        let armed = run(&state, &tables(), &calls, Ok(true), Ok(()), Err("scheduler stopped".into())).await;
        assert!(armed.unwrap_err().contains("scheduler stopped"));
        assert!(state.meta("migration:legacyRoutines").await.unwrap().is_some());
    }

    const CLAIM: &str =
        r#"{"endpoint":"gh","delivery_id":"d1","status":"done","created_at":"2026-11-10T01:02:03+09:00","updated_at":"2026-11-10T01:02:05+09:00"}"#;

    /// An installation whose routines step is already recorded (the first version of the step) still gets the dedup log, on
    /// its own marker, without the schedules and endpoints being read again; and with no old cluster the step records nothing.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn the_dedup_step_runs_on_an_installation_whose_routines_step_is_recorded() {
        use mixdog_services::webhooks::{EndpointRecord, EndpointRecords, StateWebhookStore};
        let dir = tempfile::tempdir().unwrap();
        let state = open(dir.path());
        state.write(|tx| tx.put_meta("migration:legacyRoutines", "schedules=0,webhooks=1,kept=0")).await.unwrap();
        StateWebhookStore::new(state.clone(), Arc::new(SystemClock)).upsert(&EndpointRecord { name: "gh".into(), ..Default::default() }).await.unwrap();
        let old = OldTables { reads: AtomicUsize::new(0), rows: Vec::new(), deliveries: vec![CLAIM.to_owned()] };
        let routines = run(&state, &old, &Arc::new(Calls::default()), Ok(true), Ok(()), Ok(())).await.unwrap();
        assert_eq!(routines, LegacyImport::default(), "the routines step is done and reads nothing");
        assert_eq!(old.reads.load(Ordering::SeqCst), 0);

        let done = carry_over_legacy_deliveries(&state, &legacy_deliveries_marker(), || Box::pin(async { Ok(true) }), || Box::pin(async { Ok(()) }), &old)
            .await
            .unwrap();
        assert_eq!((done.ran, done.deliveries), (true, 1));
        assert_eq!(state.meta("migration:legacyDeliveries").await.unwrap().as_deref(), Some("deliveries=1,skipped=0"));
        assert_eq!(old.reads.load(Ordering::SeqCst), 1);
        let again = carry_over_legacy_deliveries(
            &state,
            &legacy_deliveries_marker(),
            || Box::pin(async { Err("must not be asked".into()) }),
            || Box::pin(async { Err("must not be asked".into()) }),
            &old,
        )
        .await
        .unwrap();
        assert!(!again.ran);

        let bare = tempfile::tempdir().unwrap();
        let state = open(bare.path());
        let none = carry_over_legacy_deliveries(
            &state,
            &legacy_deliveries_marker(),
            || Box::pin(async { Ok(false) }),
            || Box::pin(async { Err("must not be asked".into()) }),
            &old,
        )
        .await
        .unwrap();
        assert!(none.ran);
        assert_eq!(state.meta("migration:legacyDeliveries").await.unwrap().as_deref(), Some("none"));
    }
}
