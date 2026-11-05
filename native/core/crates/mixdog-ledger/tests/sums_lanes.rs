//! The writer stays responsive while a batch of day sums is being summed on a maintenance lane.
//! This binary installs its own executors, with a gate that holds maintenance jobs, so the read
//! of a large session can be paused while the writer works. (One test: the backend is process
//! wide.)
#![allow(
    clippy::disallowed_types,
    clippy::disallowed_methods,
    reason = "test fixture I/O; mixdog-store::sqlite has not landed"
)]

use std::sync::Arc;
use std::sync::Condvar;
use std::sync::Mutex;
use std::time::Duration;

use mixdog_ledger::append::UsageRecord;
use mixdog_ledger::append::append_batch;
use mixdog_ledger::db::Connection;
use mixdog_ledger::schema::prepare;
use mixdog_ledger::sums::sums_complete;
use mixdog_ledger::writer::UsageWriter;
use mixdog_rt::Backend;
use mixdog_rt::LaneFull;
use mixdog_rt::LaneKind;
use mixdog_rt::QueuedJob;
use mixdog_rt::TaskClass;
use mixdog_rt::ThreadKind;

#[derive(Default)]
struct Gate {
    open: Mutex<bool>,
    changed: Condvar,
}

impl Gate {
    fn wait_open(&self) {
        let mut open = self.open.lock().unwrap();
        while !*open {
            open = self.changed.wait(open).unwrap();
        }
    }

    fn open(&self) {
        *self.open.lock().unwrap() = true;
        self.changed.notify_all();
    }
}

/// Every lane job runs on its own thread; maintenance jobs wait for the gate first.
struct Gated(Arc<Gate>);

impl Backend for Gated {
    fn handle(&self, _: TaskClass) -> tokio::runtime::Handle {
        tokio::runtime::Handle::current()
    }

    fn record_poll(&self, _: &'static str, _: TaskClass, _: Duration) {}

    fn submit(&self, job: QueuedJob) -> Result<(), LaneFull> {
        let gate = self.0.clone();
        std::thread::spawn(move || {
            if job.lane() == LaneKind::MaintenanceIo {
                gate.wait_open();
            }
            job.run();
        });
        Ok(())
    }

    fn enter_thread(&self, _: ThreadKind) {}
}

fn record(n: u64, session: &str) -> UsageRecord {
    serde_json::from_value(serde_json::json!({
        "id": format!("{n:064x}"), "ts": 1_000 + n, "day": "2026-01-01", "provider": "p", "model": "m",
        "kind": "api", "sessionId": session, "sourceType": "user", "input": 10, "output": 5,
        "cacheRead": 1, "cacheWrite": 2, "costUsd": 0.5, "costSource": "catalog", "origin": "live",
        "durationMs": 100
    }))
    .unwrap()
}

#[tokio::test]
async fn queued_writes_commit_while_a_large_session_is_summed() {
    let gate = Arc::new(Gate::default());
    let tokens = mixdog_rt::install(Arc::new(Gated(gate.clone()))).unwrap();
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("ledger.sqlite");
    {
        let mut conn = Connection::open(&path).unwrap();
        conn.pragma_update(None, "journal_mode", "WAL").unwrap();
        prepare(&mut conn).unwrap();
        // 'empty' is session 1 and holds nothing yet; 'big' is session 2, 'tail' session 3.
        conn.execute("INSERT INTO usage_sessions(value) VALUES ('empty')", [])
            .unwrap();
        let rows: Vec<UsageRecord> = (0..600)
            .map(|n| record(n, "big"))
            .chain((1_000..1_005).map(|n| record(n, "tail")))
            .collect();
        for chunk in rows.chunks(500) {
            append_batch(&mut conn, chunk).unwrap();
        }
        conn.execute_batch(
            "DELETE FROM usage_session_days; UPDATE usage_session_days_state SET complete=0,next=0",
        )
        .unwrap();
    }

    // The writer snapshots the ledger and sends the first batch (the 600-record session) to a
    // maintenance job, which the gate holds.
    let writer =
        UsageWriter::open(tokens.sqlite_writer_thread, tokens.maintenance_io, &path).unwrap();
    // Meanwhile it commits what is queued: to the session being summed, to an earlier session
    // that was empty, and to one the batch does not reach.
    writer.record_queued(record(10_000, "big")).await.unwrap();
    writer.record_queued(record(10_001, "empty")).await.unwrap();
    writer.record_queued(record(10_002, "tail")).await.unwrap();
    writer.settle_writes().await.unwrap();
    let check = Connection::open(&path).unwrap();
    assert!(
        !sums_complete(&check).unwrap(),
        "the batch is still being summed"
    );
    let events: i64 = check
        .query_row("SELECT COUNT(*) FROM usage_events", [], |r| r.get(0))
        .unwrap();
    assert_eq!(events, 608);

    gate.open();
    writer.sums_built().await.unwrap();

    let turns = |session: &str| -> i64 {
        check
            .query_row(
                "SELECT COALESCE(SUM(turns),0) FROM usage_session_days d JOIN usage_sessions s ON s.id=d.session
                 WHERE s.value=?1",
                [session],
                |r| r.get(0),
            )
            .unwrap()
    };
    assert_eq!((turns("empty"), turns("big"), turns("tail")), (1, 601, 6));
    let mismatched: i64 = check
        .query_row(
            "SELECT COUNT(*) FROM (
               SELECT session,day,route,COUNT(*) t,SUM(input) i,SUM(cost_usd) c FROM usage_events GROUP BY session,day,route
               EXCEPT SELECT session,day,route,turns,input,cost_usd FROM usage_session_days)",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(mismatched, 0);
}
