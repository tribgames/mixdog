//! The ledger's single write connection: one dedicated `SqliteWriter` thread (RL §8) that
//! owns it, fed by a bounded FIFO of commands. Queued records group-commit (every record
//! queued while a write is in flight shares the next transaction; a failing batch is retried
//! row by row, so one bad record only fails itself), and [`UsageWriter::settle_writes`] is a
//! barrier in that FIFO: it resolves once everything queued before it, quota readings
//! included, is committed or has failed (`UsageLedger.settleWrites`).
//!
//! While the queue is idle the thread also builds the per-session day sums, but it never sums
//! a session itself (a session can hold any number of records). It takes a snapshot of the
//! ledger on a second connection, hands it to a maintenance-lane job that sums whole sessions
//! with the same `SUM` statement Node uses, and applies the result in one short transaction
//! (`sums::apply_snapshot`), adding the few records it committed meanwhile. Queued commands
//! are served between those steps, so a large session delays no write.

use std::path::Path;
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::Weak;
use std::sync::mpsc;
use std::sync::mpsc::TryRecvError;

use mixdog_core_api::StatePublisher;
use mixdog_rt::CancellationToken;
use mixdog_rt::InLane;
use mixdog_rt::LaneToken;
use mixdog_rt::MaintenanceIo;
use mixdog_rt::SqliteWriterThread;
use mixdog_rt::ThreadToken;

use crate::append::Appended;
use crate::append::MAX_APPEND_ROWS;
use crate::append::UsageRecord;
use crate::append::append_rows;
use crate::append::encode_usage_id;
use crate::db::Connection;
use crate::db::TransactionBehavior;
use crate::error::LedgerError;
use crate::error::Result;
use crate::maintenance::maintain_usage;
use crate::quota::QuotaReading;
use crate::quota::record_quota_samples;
use crate::reader::open_reader;
use crate::repair::Change;
use crate::repair::RepairOptions;
use crate::repair::RepairReport;
use crate::repair::apply_repair_if_unchanged;
use crate::reply::ReplyRx;
use crate::reply::ReplyTx;
use crate::reply::reply;
use crate::schema::prepare;
use crate::sums::Applied;
use crate::sums::Late;
use crate::sums::Snapshot;
use crate::sums::aggregate_batch;
use crate::sums::apply_snapshot;
use crate::sums::sums_complete;

/// Commands waiting for the writer; a full queue answers `Busy` at once.
const QUEUE: usize = 1024;
/// Records one day-sum batch covers at least (whole sessions: it ends with the session that
/// reaches it).
const BUILD_BUDGET: i64 = 500;
/// Records kept for folding into a batch; more than this and the batch is summed again.
const MAX_LATE: usize = 65_536;
const QUEUE_NAME: &str = "usage-writer";

enum Command {
    Record {
        rows: Vec<UsageRecord>,
        reply: ReplyTx<Vec<Appended>>,
    },
    Quota {
        samples: Vec<QuotaReading>,
        reply: ReplyTx<Result<usize>>,
    },
    /// `total_changes()` and `data_version`: moves when any connection commits.
    Stamp {
        reply: ReplyTx<Result<String>>,
    },
    Repair {
        report: RepairReport,
        changes: Vec<Change>,
        options: RepairOptions,
        now_ms: i64,
        reply: ReplyTx<Result<RepairReport>>,
    },
    Settle {
        reply: ReplyTx<()>,
    },
    /// Resolves once the day sums are complete.
    SumsBuilt {
        reply: ReplyTx<()>,
    },
    /// A maintenance job's batch of sums, posted back by the job.
    Built(Result<Snapshot>),
}

struct Inner {
    commands: mpsc::SyncSender<Command>,
}

pub struct UsageWriter {
    inner: Arc<Inner>,
}

fn stamp(conn: &Connection) -> Result<String> {
    let local: i64 = conn.query_row("SELECT total_changes()", [], |r| r.get(0))?;
    let shared: i64 = conn.pragma_query_value(None, "data_version", |r| r.get(0))?;
    Ok(format!("{local}:{shared}"))
}

/// Appends every queued record of `group` in one transaction and answers each caller with the
/// outcomes of its own records. Returns the records that were new, in commit order.
fn commit_records(
    conn: &mut Connection,
    group: Vec<(Vec<UsageRecord>, ReplyTx<Vec<Appended>>)>,
) -> Vec<UsageRecord> {
    let all: Vec<UsageRecord> = group.iter().flat_map(|(rows, _)| rows.clone()).collect();
    let outcomes = append_rows(conn, &all);
    let inserted = all
        .iter()
        .zip(&outcomes)
        .filter(|(_, o)| matches!(o, Appended::Inserted))
        .map(|(row, _)| row.clone())
        .collect();
    let mut outcomes = outcomes.into_iter();
    for (rows, reply) in group {
        reply.send(outcomes.by_ref().take(rows.len()).collect());
    }
    inserted
}

/// Where the `usage` section is published (P7: the ledger writer, after batch commit).
struct Publication {
    publisher: Arc<dyn StatePublisher>,
    scope: String,
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |d| i64::try_from(d.as_millis()).unwrap_or(i64::MAX))
}

/// What the writer thread needs besides its connection and queue.
struct Context {
    path: PathBuf,
    maintenance: MaintenanceIo,
    /// Weak: the thread must not keep its own queue open once the `UsageWriter` is dropped.
    inner: Weak<Inner>,
    publication: Option<Publication>,
    build_budget: i64,
}

/// The day-sum build, as the writer thread sees it.
struct Build {
    complete: bool,
    flight: Option<Flight>,
    /// A dispatch, a job or an apply failed: nothing is retried before the next command.
    blocked: bool,
    waiters: Vec<ReplyTx<()>>,
}

/// A batch being summed on a maintenance lane, from a snapshot taken at its dispatch.
struct Flight {
    /// The records this thread committed since the snapshot, in commit order.
    late: Vec<Late>,
    /// The snapshot no longer describes the ledger (a repair rewrote records, or too many
    /// arrived): its result is dropped and the batch is summed again.
    stale: bool,
}

impl Build {
    fn wants_dispatch(&self) -> bool {
        !self.complete && self.flight.is_none() && !self.blocked
    }

    fn finish(&mut self) {
        self.complete = true;
        for waiter in self.waiters.drain(..) {
            waiter.send(());
        }
    }

    /// Takes a snapshot of the ledger as it is now and sends a maintenance job to sum the next
    /// sessions from it. The thread is the only writer of records, so the snapshot is exactly
    /// the ledger as of this point of its own history, and everything it commits from here on
    /// is `late`.
    fn dispatch(&mut self, context: &Context) {
        let snapshot = open_reader(&context.path).and_then(|conn| {
            conn.execute_batch("BEGIN")?;
            // The first read fixes the snapshot.
            let next: i64 =
                conn.query_row("SELECT next FROM usage_session_days_state", [], |r| {
                    r.get(0)
                })?;
            Ok((conn, next))
        });
        let Ok((conn, from_next)) = snapshot else {
            self.blocked = true;
            return;
        };
        let (inner, budget) = (context.inner.clone(), context.build_budget);
        let job = move |_: &InLane<MaintenanceIo>| {
            let result = aggregate_batch(&conn, from_next, budget);
            drop(conn);
            if let Some(inner) = inner.upgrade() {
                let _ = inner.commands.send(Command::Built(result));
            }
        };
        match context.maintenance.submit(&CancellationToken::new(), job) {
            Ok(_) => {
                self.flight = Some(Flight {
                    late: Vec::new(),
                    stale: false,
                });
            }
            Err(_) => self.blocked = true,
        }
    }

    /// A batch came back.
    fn built(&mut self, conn: &mut Connection, result: Result<Snapshot>) {
        let flight = self.flight.take();
        match (result, flight) {
            (Ok(snapshot), Some(flight)) if !flight.stale => {
                match apply(conn, &snapshot, &flight.late) {
                    Ok(Applied::Done(true)) => self.finish(),
                    Ok(_) => {}
                    Err(_) => self.blocked = true,
                }
            }
            // Out of date: it is summed again.
            (Ok(_), _) => {}
            (Err(_), _) => self.blocked = true,
        }
    }

    fn note_committed(&mut self, conn: &Connection, rows: &[UsageRecord]) {
        let Some(flight) = self.flight.as_mut() else {
            return;
        };
        for row in rows {
            let id = encode_usage_id(&row.id);
            let session =
                conn.query_row("SELECT session FROM usage_events WHERE id=?1", [&id], |r| {
                    r.get::<_, i64>(0)
                });
            match session {
                Ok(session) if flight.late.len() < MAX_LATE => {
                    flight.late.push(Late { session, id })
                }
                _ => {
                    flight.stale = true;
                    return;
                }
            }
        }
    }
}

fn apply(conn: &mut Connection, snapshot: &Snapshot, late: &[Late]) -> Result<Applied> {
    let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
    let applied = apply_snapshot(&tx, snapshot, late)?;
    tx.commit()?;
    Ok(applied)
}

fn run(mut conn: Connection, commands: mpsc::Receiver<Command>, context: Context) {
    let mut held: Option<Command> = None;
    let mut build = Build {
        complete: sums_complete(&conn).unwrap_or(true),
        flight: None,
        blocked: false,
        waiters: Vec::new(),
    };
    // The section is out of date: boot, or a commit changed what it summarizes.
    let mut stale = context.publication.is_some();
    loop {
        let command = match held.take() {
            Some(command) => command,
            None => match commands.try_recv() {
                Ok(command) => command,
                Err(TryRecvError::Disconnected) => break,
                Err(TryRecvError::Empty) if build.wants_dispatch() => {
                    build.dispatch(&context);
                    continue;
                }
                Err(TryRecvError::Empty) => match (&context.publication, stale) {
                    (Some(publication), true) => {
                        // Idle: one bounded step of the rollup-day recompute; the section is
                        // published once no day is stale. Appends coalesce into one
                        // publication. A failure waits for the next commit to retry.
                        stale = matches!(
                            maintain_usage(
                                &mut conn,
                                publication.publisher.as_ref(),
                                &publication.scope,
                                now_ms()
                            ),
                            Ok(false)
                        );
                        continue;
                    }
                    _ => match commands.recv() {
                        Ok(command) => command,
                        Err(_) => break,
                    },
                },
            },
        };
        build.blocked = false;
        match command {
            Command::Record { rows, reply } => {
                let mut total = rows.len();
                let mut group = vec![(rows, reply)];
                // Records queued behind it share the transaction, up to its row cap; a command
                // of another kind ends the group so order is kept.
                loop {
                    match commands.try_recv() {
                        Ok(Command::Record { rows, reply })
                            if total + rows.len() <= MAX_APPEND_ROWS =>
                        {
                            total += rows.len();
                            group.push((rows, reply));
                        }
                        Ok(other) => {
                            held = Some(other);
                            break;
                        }
                        Err(_) => break,
                    }
                }
                let inserted = commit_records(&mut conn, group);
                build.note_committed(&conn, &inserted);
                stale |= context.publication.is_some() && !inserted.is_empty();
            }
            Command::Quota { samples, reply } => {
                reply.send(record_quota_samples(&mut conn, &samples));
            }
            Command::Stamp { reply } => reply.send(stamp(&conn)),
            Command::Repair {
                report,
                changes,
                options,
                now_ms,
                reply,
            } => {
                let applied =
                    apply_repair_if_unchanged(&mut conn, report, &changes, &options, now_ms);
                if let Some(flight) = build.flight.as_mut() {
                    flight.stale = true;
                }
                stale |=
                    context.publication.is_some() && applied.as_ref().is_ok_and(|r| !r.conflict);
                reply.send(applied);
            }
            Command::Settle { reply } => reply.send(()),
            Command::SumsBuilt { reply } => {
                if build.complete {
                    reply.send(());
                } else {
                    build.waiters.push(reply);
                }
            }
            Command::Built(result) => build.built(&mut conn, result),
        }
    }
}

impl UsageWriter {
    /// Opens (and, if it is a recognized older shape, upgrades) the ledger, then starts its
    /// writer thread. Boot work, before the core serves. `maintenance` runs the day-sum
    /// build's aggregation.
    pub fn open(
        thread: SqliteWriterThread,
        maintenance: MaintenanceIo,
        path: &Path,
    ) -> Result<Arc<Self>> {
        Self::start(thread, maintenance, path, None, BUILD_BUDGET)
    }

    /// [`open`](Self::open) with another size for a day-sum batch (records, at least; it ends
    /// with the session that reaches it; the default is 500).
    pub fn open_with_build_budget(
        thread: SqliteWriterThread,
        maintenance: MaintenanceIo,
        path: &Path,
        build_budget: i64,
    ) -> Result<Arc<Self>> {
        Self::start(thread, maintenance, path, None, build_budget)
    }

    /// [`open`](Self::open), and the writer also keeps the `usage` section of `scope` current:
    /// once the queue is idle after a commit it recomputes stale rollup days in bounded steps
    /// and publishes the summary through `publisher` (`maintain_usage`).
    pub fn open_publishing(
        thread: SqliteWriterThread,
        maintenance: MaintenanceIo,
        path: &Path,
        publisher: Arc<dyn StatePublisher>,
        scope: &str,
    ) -> Result<Arc<Self>> {
        let scope = scope.to_string();
        Self::start(
            thread,
            maintenance,
            path,
            Some(Publication { publisher, scope }),
            BUILD_BUDGET,
        )
    }

    #[allow(
        clippy::disallowed_methods,
        reason = "boot-time open of the ledger file, before any lane serves"
    )]
    fn start(
        thread: SqliteWriterThread,
        maintenance: MaintenanceIo,
        path: &Path,
        publication: Option<Publication>,
        build_budget: i64,
    ) -> Result<Arc<Self>> {
        let mut conn = Connection::open(path)?;
        conn.execute_batch(
            "PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL",
        )?;
        prepare(&mut conn)?;
        let (commands, receiver) = mpsc::sync_channel(QUEUE);
        let inner = Arc::new(Inner { commands });
        let context = Context {
            path: path.to_path_buf(),
            maintenance,
            inner: Arc::downgrade(&inner),
            publication,
            build_budget,
        };
        thread.spawn_thread("mixdog-usage-writer", move |_| run(conn, receiver, context))?;
        Ok(Arc::new(Self { inner }))
    }

    /// Queues `command` now, so queue order is call order.
    fn enqueue<T>(&self, make: impl FnOnce(ReplyTx<T>) -> Command) -> Result<ReplyRx<T>> {
        let (tx, rx) = reply();
        self.inner
            .commands
            .try_send(make(tx))
            .map_err(|e| match e {
                mpsc::TrySendError::Full(_) => LedgerError::Busy { queue: QUEUE_NAME },
                mpsc::TrySendError::Disconnected(_) => LedgerError::Stopped,
            })?;
        Ok(rx)
    }

    /// Queues one record (`recordQueued`): it is enqueued by this call, in call order, and the
    /// future resolves once the record is durable, or with the error that failed it. A
    /// duplicate id is not an error.
    pub fn record_queued(
        &self,
        row: UsageRecord,
    ) -> impl Future<Output = Result<()>> + Send + 'static + use<> {
        let queued = self.enqueue(|reply| Command::Record {
            rows: vec![row],
            reply,
        });
        async move {
            match queued?.await?.pop() {
                Some(Appended::Failed(error)) => Err(error),
                _ => Ok(()),
            }
        }
    }

    /// Queues quota readings (`recordQuotaQueued`); resolves with how many were taken.
    pub fn record_quota_queued(
        &self,
        samples: Vec<QuotaReading>,
    ) -> impl Future<Output = Result<usize>> + Send + 'static + use<> {
        let queued = self.enqueue(|reply| Command::Quota { samples, reply });
        async move { queued?.await? }
    }

    /// Resolves once every record and quota reading queued before this call is committed or
    /// has failed (`settleWrites`). Statistics requested after a send include it.
    pub fn settle_writes(&self) -> impl Future<Output = Result<()>> + Send + 'static + use<> {
        let queued = self.enqueue(|reply| Command::Settle { reply });
        async move { queued?.await }
    }

    /// Resolves once the per-session day sums are complete (until then the session reads answer
    /// `SumsBuilding`).
    pub fn sums_built(&self) -> impl Future<Output = Result<()>> + Send + 'static + use<> {
        let queued = self.enqueue(|reply| Command::SumsBuilt { reply });
        async move { queued?.await }
    }

    /// The commit stamp (`changeStamp`): moves when any connection commits to the ledger.
    pub fn commit_stamp(&self) -> impl Future<Output = Result<String>> + Send + 'static + use<> {
        let queued = self.enqueue(|reply| Command::Stamp { reply });
        async move { queued?.await? }
    }

    /// Applies a repair planned elsewhere if every planned row still has the route and cost it
    /// was priced from; otherwise writes nothing and reports `conflict`.
    pub fn apply_repair(
        &self,
        report: RepairReport,
        changes: Vec<Change>,
        options: RepairOptions,
        now_ms: i64,
    ) -> impl Future<Output = Result<RepairReport>> + Send + 'static + use<> {
        let queued = self.enqueue(|reply| Command::Repair {
            report,
            changes,
            options,
            now_ms,
            reply,
        });
        async move { queued?.await? }
    }
}
