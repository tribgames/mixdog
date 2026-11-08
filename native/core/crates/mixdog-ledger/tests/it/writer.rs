//! The write side: queued records settle in order and once each, one bad record fails alone,
//! and the price refresh examines only what changed.
#![allow(
    clippy::disallowed_types,
    clippy::disallowed_methods,
    reason = "test fixture I/O; mixdog-store::sqlite has not landed"
)]

use std::path::Path;
use std::sync::Arc;
use std::sync::Mutex;

use mixdog_ledger::LedgerError;
use mixdog_ledger::append::UsageRecord;
use mixdog_ledger::db::Connection;
use mixdog_ledger::ledger::UsageLedger;
use mixdog_ledger::reader::UsageReader;
use mixdog_ledger::refresh::Pricer;
use mixdog_ledger::refresh::Refresh;
use mixdog_ledger::refresh::UsageRefresher;
use mixdog_ledger::repair::PriceRequest;
use mixdog_ledger::repair::Priced;
use mixdog_ledger::writer::UsageWriter;

fn record(id: &str, ts: i64, source: &str, cost: Option<f64>) -> UsageRecord {
    serde_json::from_value(serde_json::json!({
        "id": id, "ts": ts, "day": "2026-01-01", "provider": "p", "model": "m", "kind": "api",
        "sessionId": "s1", "sourceType": "user", "input": 10, "output": 5, "cacheRead": 1, "cacheWrite": 2,
        "costUsd": cost, "costSource": source, "origin": "live", "durationMs": 100
    }))
    .unwrap()
}

fn query<T: rusqlite::types::FromSql>(path: &Path, sql: &str) -> T {
    Connection::open(path)
        .unwrap()
        .query_row(sql, [], |r| r.get(0))
        .unwrap()
}

#[tokio::test]
async fn queued_records_settle_in_order_once_each_and_a_bad_one_fails_alone() {
    let tokens = mixdog_rt::testing::tokens();
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("ledger.sqlite");
    let writer =
        UsageWriter::open(tokens.sqlite_writer_thread, tokens.maintenance_io, &path).unwrap();

    let mut queued = Vec::new();
    for i in 0..20_i64 {
        // Descending times: the first queued record is the first live one (`liveSince`).
        queued.push((
            i,
            writer.record_queued(record(&format!("r{i}"), 2000 - i, "catalog", Some(0.1))),
        ));
    }
    let mut bad = record("bad", 1, "catalog", Some(0.1));
    bad.day = "not-a-day".into();
    let bad = writer.record_queued(bad);
    // A repeat of a stored id is not an error and is not counted twice.
    let repeat = writer.record_queued(record("r3", 1997, "catalog", Some(0.1)));
    writer.settle_writes().await.unwrap();

    // Everything queued before the barrier is committed before it resolves.
    assert_eq!(query::<i64>(&path, "SELECT COUNT(*) FROM usage_events"), 20);
    assert_eq!(
        query::<String>(&path, "SELECT value FROM metadata WHERE key='liveSince'"),
        "2000"
    );
    for (_, outcome) in queued {
        outcome.await.unwrap();
    }
    repeat.await.unwrap();
    assert!(matches!(bad.await, Err(LedgerError::Invalid(_))));
}

struct Table {
    revision: Mutex<String>,
    calls: std::sync::atomic::AtomicUsize,
}

impl Pricer for Table {
    fn revision(&self) -> String {
        self.revision.lock().unwrap().clone()
    }

    fn price(&self, _: &PriceRequest) -> mixdog_ledger::Result<Priced> {
        self.calls.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        Ok(Priced {
            cost_usd: Some(1.5),
            rates: None,
        })
    }
}

#[tokio::test]
async fn the_refresh_reprices_only_what_changed() {
    let tokens = mixdog_rt::testing::tokens();
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("ledger.sqlite");
    let writer =
        UsageWriter::open(tokens.sqlite_writer_thread, tokens.maintenance_io, &path).unwrap();
    let reader = UsageReader::new(&path, tokens.interactive_io, tokens.maintenance_io);
    let table = Arc::new(Table {
        revision: Mutex::new("r1".into()),
        calls: 0.into(),
    });
    let refresher = UsageRefresher::new(table.clone(), tokens.cpu_bulk);
    let ledger = UsageLedger {
        writer: writer.clone(),
        reader: reader.clone(),
        refresher: refresher.clone(),
    };
    let unpriced = |sql: &str| query::<i64>(&path, sql);
    let open_rows = "SELECT COUNT(*) FROM usage_events WHERE cost_usd IS NULL";
    let now = 10_000_i64;

    for i in 0..3_i64 {
        writer
            .record_queued(record(&format!("u{i}"), 100 + i, "unpriced", None))
            .await
            .unwrap();
    }
    ledger.writer.settle_writes().await.unwrap();
    let Refresh::Repaired(first) = refresher.refresh(&writer, &reader, now).await.unwrap() else {
        panic!("three unpriced records are examined");
    };
    assert_eq!(
        (first.repriced, first.still_unpriced, first.conflict),
        (3, 0, false)
    );
    assert_eq!(unpriced(open_rows), 0);

    // Nothing changed under the same table: skipped, whatever the clock.
    assert!(matches!(
        refresher.refresh(&writer, &reader, now).await.unwrap(),
        Refresh::Skipped
    ));
    // A new table with nothing unpriced left has nothing to examine either.
    *table.revision.lock().unwrap() = "r2".into();
    assert!(matches!(
        refresher.refresh(&writer, &reader, now).await.unwrap(),
        Refresh::Skipped
    ));

    // A record appended later is the only one examined.
    writer
        .record_queued(record("late", 200, "unpriced", None))
        .await
        .unwrap();
    let Refresh::Repaired(next) = refresher.refresh(&writer, &reader, now).await.unwrap() else {
        panic!("the appended record is examined");
    };
    assert_eq!((next.repriced, next.conflict), (1, false));
    assert_eq!(unpriced(open_rows), 0);
}

#[tokio::test]
async fn the_writer_signals_a_change_once_idle_after_a_commit() {
    use mixdog_ledger::writer::UsageChanged;

    struct Signals(tokio::sync::mpsc::UnboundedSender<()>);
    impl UsageChanged for Signals {
        fn usage_changed(&self) {
            self.0.send(()).unwrap();
        }
    }

    let tokens = mixdog_rt::testing::tokens();
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("ledger.sqlite");
    let (signals, mut told) = tokio::sync::mpsc::unbounded_channel();
    let writer = UsageWriter::open_publishing(
        tokens.sqlite_writer_thread,
        tokens.maintenance_io,
        &path,
        Arc::new(Signals(signals)),
    )
    .unwrap();

    // Booting is not a change: the first signal is the first record's.
    // A record that was already stored is not a change.
    let first = record("p0", 1_000, "catalog", Some(0.1));
    writer.record_queued(first.clone()).await.unwrap();
    told.recv().await.unwrap();
    writer.record_queued(first).await.unwrap();
    writer.settle_writes().await.unwrap();
    assert!(told.try_recv().is_err(), "a repeated id changes nothing");
    // A new record is.
    writer
        .record_queued(record("p1", 1_001, "catalog", Some(0.1)))
        .await
        .unwrap();
    told.recv().await.unwrap();
}

// ---- the ledger's read methods, the queue bound and the refresh's serialization ----

use mixdog_ledger::quota::QuotaHistoryOptions;
use mixdog_ledger::quota::QuotaReading;
use mixdog_ledger::quota::QuotaSample;
use mixdog_ledger::stats::UsageRequestsOptions;
use mixdog_ledger::stats::UsageStatsOptions;
use serde_json::Value;

const TS: i64 = 1_800_000_000_000;

struct Rig {
    _dir: tempfile::TempDir,
    path: std::path::PathBuf,
    writer: Arc<UsageWriter>,
    refresher: Arc<UsageRefresher>,
    table: Arc<Table>,
    ledger: UsageLedger,
}

fn rig() -> Rig {
    let tokens = mixdog_rt::testing::tokens();
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("ledger.sqlite");
    let writer =
        UsageWriter::open(tokens.sqlite_writer_thread, tokens.maintenance_io, &path).unwrap();
    let reader = UsageReader::new(&path, tokens.interactive_io, tokens.maintenance_io);
    let table = Arc::new(Table {
        revision: Mutex::new("r1".into()),
        calls: 0.into(),
    });
    let refresher = UsageRefresher::new(table.clone(), tokens.cpu_bulk);
    let ledger = UsageLedger {
        writer: writer.clone(),
        reader,
        refresher: refresher.clone(),
    };
    Rig {
        _dir: dir,
        path,
        writer,
        refresher,
        table,
        ledger,
    }
}

/// Holds the ledger's write lock: the writer thread cannot commit until it is released.
fn hold_writes(path: &Path) -> Connection {
    let lock = Connection::open(path).unwrap();
    lock.execute_batch("BEGIN IMMEDIATE").unwrap();
    lock
}

/// Queues a write behind a held write lock, starts a read, and checks that the read has not
/// answered while the write is pending; releases the lock and returns the read's answer. A read
/// that does not settle first answers at once, from the ledger without the write.
async fn read_waits_for_the_queued_write<W, R>(
    rig: &Rig,
    write: impl FnOnce(&UsageWriter) -> W,
    read: impl FnOnce(UsageLedger) -> R,
) -> Value
where
    W: Future<Output = ()>,
    R: Future<Output = mixdog_ledger::Result<Value>> + Send + 'static,
{
    let lock = hold_writes(&rig.path);
    let queued = write(&rig.writer);
    let task = tokio::spawn(read(rig.ledger.clone()));
    for _ in 0..40 {
        tokio::task::yield_now().await;
        std::thread::sleep(std::time::Duration::from_millis(5));
    }
    assert!(
        !task.is_finished(),
        "the read answered before the queued write committed"
    );
    lock.execute_batch("COMMIT").unwrap();
    queued.await;
    task.await.unwrap().unwrap()
}

#[tokio::test]
async fn session_usage_and_requests_wait_for_queued_records() {
    let rig = rig();
    let stored = |w: &UsageWriter| {
        let queued = w.record_queued(record("q1", TS, "catalog", Some(0.1)));
        async move { queued.await.unwrap() }
    };
    let usage = read_waits_for_the_queued_write(&rig, stored, |l| async move {
        l.session_usage(vec!["s1".into()], vec![]).await
    })
    .await;
    assert!(usage.to_string().contains("\"turns\":1"), "{usage}");

    let page = read_waits_for_the_queued_write(
        &rig,
        |w| {
            let queued = w.record_queued(record("q2", TS + 1, "catalog", Some(0.1)));
            async move { queued.await.unwrap() }
        },
        |l| async move {
            let options: UsageRequestsOptions = serde_json::from_str("{}").unwrap();
            l.get_usage_requests(options, TS + 1_000).await
        },
    )
    .await;
    assert_eq!(page["requests"].as_array().unwrap().len(), 2, "{page}");
}

#[tokio::test]
async fn statistics_wait_for_queued_records() {
    let rig = rig();
    let stats = read_waits_for_the_queued_write(
        &rig,
        |w| {
            let queued = w.record_queued(record("q1", TS, "catalog", Some(0.1)));
            async move { queued.await.unwrap() }
        },
        |l| async move {
            let options: UsageStatsOptions = serde_json::from_str(r#"{"view":"day"}"#).unwrap();
            l.get_usage_stats(options, || TS + 1_000).await
        },
    )
    .await;
    // `liveSince` is the first live record's time: the read saw the record.
    assert_eq!(stats["coverage"]["liveSince"], TS, "{stats}");
}

#[tokio::test]
async fn quota_history_waits_for_queued_readings() {
    let rig = rig();
    let reading = QuotaReading {
        provider: "prov".into(),
        account: "acc".into(),
        label: "5h".into(),
        sample: QuotaSample {
            ts: TS,
            used_pct: 12.5,
            reset_at: Some(TS + 3_600_000),
        },
    };
    let history = read_waits_for_the_queued_write(
        &rig,
        move |w| {
            let queued = w.record_quota_queued(vec![reading]);
            async move { assert_eq!(queued.await.unwrap(), 1) }
        },
        |l| async move {
            let options: QuotaHistoryOptions =
                serde_json::from_str(r#"{"provider":"prov","account":"acc","window":"5h"}"#)
                    .unwrap();
            l.get_quota_history(options, Default::default(), TS + 1_000)
                .await
        },
    )
    .await;
    assert!(history.to_string().contains("12.5"), "{history}");
}

#[tokio::test]
async fn a_full_queue_answers_busy_with_its_name() {
    let rig = rig();
    let lock = hold_writes(&rig.path);
    // The first record blocks the writer thread inside its commit; the rest wait in the queue.
    let blocked = rig
        .writer
        .record_queued(record("b0", TS, "catalog", Some(0.1)));
    let mut waiting = Vec::new();
    let mut busy = None;
    for _ in 0..2_000 {
        let barrier = rig.writer.settle_writes();
        let queued = rig
            .writer
            .record_queued(record("b1", TS + 1, "catalog", Some(0.1)));
        // An overflowing command answers at once, without waiting for the writer.
        let answer = futures_now(queued);
        if let Some(Err(error)) = answer {
            busy = Some(error);
            break;
        }
        waiting.push(barrier);
    }
    assert!(
        matches!(
            busy,
            Some(LedgerError::Busy {
                queue: "usage-writer"
            })
        ),
        "{busy:?}"
    );
    assert!(
        waiting.len() <= 1_024,
        "{} commands were accepted",
        waiting.len()
    );
    lock.execute_batch("COMMIT").unwrap();
    blocked.await.unwrap();
    for barrier in waiting {
        barrier.await.unwrap();
    }
}

/// The future's output if it is ready at its first poll (an enqueue that failed is).
fn futures_now<T>(future: impl Future<Output = T>) -> Option<T> {
    let mut future = std::pin::pin!(future);
    let mut cx = std::task::Context::from_waker(std::task::Waker::noop());
    match future.as_mut().poll(&mut cx) {
        std::task::Poll::Ready(value) => Some(value),
        std::task::Poll::Pending => None,
    }
}

#[tokio::test]
async fn two_concurrent_refreshes_are_serialized() {
    let rig = rig();
    for i in 0..3_i64 {
        rig.writer
            .record_queued(record(&format!("u{i}"), TS + i, "unpriced", None))
            .await
            .unwrap();
    }
    rig.writer.settle_writes().await.unwrap();
    let reader = rig.ledger.reader.clone();
    let (first, second) = tokio::join!(
        rig.refresher.refresh(&rig.writer, &reader, TS + 10_000),
        rig.refresher.refresh(&rig.writer, &reader, TS + 10_000),
    );
    let outcomes = [first.unwrap(), second.unwrap()];
    let repaired = outcomes
        .iter()
        .filter(|o| matches!(o, Refresh::Repaired(_)))
        .count();
    // One pass priced the three records; the other found nothing new once it had its turn.
    assert_eq!(repaired, 1, "{outcomes:?}");
    assert_eq!(rig.table.calls.load(std::sync::atomic::Ordering::SeqCst), 3);
}
