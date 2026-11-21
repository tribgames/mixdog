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
use crate::history::HistoryOutcome;
use crate::history::HistoryState;
use crate::history::HistoryWrite;
use crate::history::read_state;
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

/// A queued write, with its number in [`UsageWriter::marks`].
enum Command {
    Record {
        rows: Vec<UsageRecord>,
        reply: ReplyTx<Vec<Appended>>,
        mark: u64,
    },
    Quota {
        samples: Vec<QuotaReading>,
        reply: ReplyTx<Result<usize>>,
        mark: u64,
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
    /// `liveSince` and `importedThrough`.
    HistoryState {
        reply: ReplyTx<Result<HistoryState>>,
    },
    /// The usage history of the earlier daemon, committed once it is read and priced.
    History {
        write: Box<HistoryWrite>,
        mark: u64,
        reply: ReplyTx<Result<HistoryOutcome>>,
    },
    /// A `metadata` row the ledger keeps for itself: read (`value` none), or written.
    Note {
        key: &'static str,
        value: Option<String>,
        reply: ReplyTx<Result<Option<String>>>,
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
    /// Every queued record and quota command numbered, reported once committed or failed.
    marks: Arc<mixdog_rt::WriteMarks>,
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
fn commit_records(conn: &mut Connection, marks: &mixdog_rt::WriteMarks, group: RecordGroup) -> Vec<UsageRecord> {
    let all: Vec<UsageRecord> = group.iter().flat_map(|(rows, _, _)| rows.clone()).collect();
    let outcomes = append_rows(conn, &all);
    let inserted = all.iter().zip(&outcomes).filter(|(_, o)| matches!(o, Appended::Inserted)).map(|(row, _)| row.clone()).collect();
    let mut outcomes = outcomes.into_iter();
    for (rows, reply, mark) in group {
        let own: Vec<Appended> = outcomes.by_ref().take(rows.len()).collect();
        match own.iter().find_map(|outcome| match outcome {
            Appended::Failed(error) => Some(error.to_string()),
            _ => None,
        }) {
            Some(error) => marks.failed(mark, error),
            None => marks.written(mark),
        }
        reply.send(own);
    }
    inserted
}

/// Told, from the writer thread, that what the statistics show changed: once the queue is idle
/// after a commit (or a repair) that changed it, never at boot. Appends coalesce into one call.
/// It must not block: the owner publishes the `usage` section (P7), the writer only signals.
pub trait UsageChanged: Send + Sync {
    fn usage_changed(&self);
}

fn now_ms() -> i64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |d| i64::try_from(d.as_millis()).unwrap_or(i64::MAX))
}

/// What the writer thread needs besides its connection and queue.
struct Context {
    path: PathBuf,
    maintenance: MaintenanceIo,
    /// Weak: the thread must not keep its own queue open once the `UsageWriter` is dropped.
    inner: Weak<Inner>,
    changed: Option<Arc<dyn UsageChanged>>,
    build_budget: i64,
    marks: Arc<mixdog_rt::WriteMarks>,
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
            let next: i64 = conn.query_row("SELECT next FROM usage_session_days_state", [], |r| r.get(0))?;
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
                self.flight = Some(Flight { late: Vec::new(), stale: false });
            }
            Err(_) => self.blocked = true,
        }
    }

    /// A batch came back.
    fn built(&mut self, conn: &mut Connection, result: Result<Snapshot>) {
        let flight = self.flight.take();
        match (result, flight) {
            (Ok(snapshot), Some(flight)) if !flight.stale => match apply(conn, &snapshot, &flight.late) {
                Ok(Applied::Done(true)) => self.finish(),
                Ok(_) => {}
                Err(_) => self.blocked = true,
            },
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
            let session = conn.query_row("SELECT session FROM usage_events WHERE id=?1", [&id], |r| r.get::<_, i64>(0));
            match session {
                Ok(session) if flight.late.len() < MAX_LATE => flight.late.push(Late { session, id }),
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

type RecordGroup = Vec<(Vec<UsageRecord>, ReplyTx<Vec<Appended>>, u64)>;

/// Records queued behind `first` share its transaction, up to the row cap; a command of another
/// kind ends the group and is held so order is kept.
fn take_record_group(commands: &mpsc::Receiver<Command>, held: &mut Option<Command>, first: (Vec<UsageRecord>, ReplyTx<Vec<Appended>>, u64)) -> RecordGroup {
    let mut total = first.0.len();
    let mut group = vec![first];
    loop {
        match commands.try_recv() {
            Ok(Command::Record { rows, reply, mark }) if total + rows.len() <= MAX_APPEND_ROWS => {
                total += rows.len();
                group.push((rows, reply, mark));
            }
            Ok(other) => {
                *held = Some(other);
                break;
            }
            Err(_) => break,
        }
    }
    group
}

fn read_or_write_note(conn: &Connection, key: &'static str, value: Option<String>) -> Result<Option<String>> {
    use crate::db::OptionalExtension as _;
    match value {
        Some(value) => conn
            .execute("INSERT INTO metadata VALUES (?1, ?2) ON CONFLICT(key) DO UPDATE SET value=excluded.value", crate::db::params![key, value])
            .map(|_| None)
            .map_err(Into::into),
        None => conn.query_row("SELECT value FROM metadata WHERE key = ?1", [key], |r| r.get(0)).optional().map_err(Into::into),
    }
}

fn run(mut conn: Connection, commands: mpsc::Receiver<Command>, context: Context) {
    let mut held: Option<Command> = None;
    let mut build = Build { complete: sums_complete(&conn).unwrap_or(true), flight: None, blocked: false, waiters: Vec::new() };
    let mut days_stale = context.changed.is_some();
    let mut owner_unaware = false;
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
                Err(TryRecvError::Empty) => match (&context.changed, days_stale) {
                    (Some(changed), true) => {
                        days_stale = match maintain_usage(&mut conn, now_ms()) {
                            Ok(true) => {
                                if std::mem::take(&mut owner_unaware) {
                                    changed.usage_changed();
                                }
                                false
                            }
                            Ok(false) => true,
                            Err(_) => false,
                        };
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
            Command::Record { rows, reply, mark } => {
                let group = take_record_group(&commands, &mut held, (rows, reply, mark));
                let inserted = commit_records(&mut conn, &context.marks, group);
                build.note_committed(&conn, &inserted);
                if context.changed.is_some() && !inserted.is_empty() {
                    days_stale = true;
                    owner_unaware = true;
                }
            }
            Command::Quota { samples, reply, mark } => {
                let recorded = record_quota_samples(&mut conn, &samples);
                match &recorded {
                    Ok(_) => context.marks.written(mark),
                    Err(error) => context.marks.failed(mark, error),
                }
                reply.send(recorded);
            }
            Command::Stamp { reply } => reply.send(stamp(&conn)),
            Command::Repair { report, changes, options, now_ms, reply } => {
                let applied = apply_repair_if_unchanged(&mut conn, report, &changes, &options, now_ms);
                if let Some(flight) = build.flight.as_mut() {
                    flight.stale = true;
                }
                if context.changed.is_some() && applied.as_ref().is_ok_and(|r| !r.conflict) {
                    days_stale = true;
                    owner_unaware = true;
                }
                reply.send(applied);
            }
            Command::Settle { reply } => reply.send(()),
            Command::HistoryState { reply } => reply.send(read_state(&conn)),
            Command::History { write, reply, mark } => {
                let applied = write.apply(&mut conn);
                match &applied {
                    Ok(_) => context.marks.written(mark),
                    Err(error) => context.marks.failed(mark, error),
                }
                // Records came in behind a day-sum batch's snapshot: it is summed again.
                if let Some(flight) = build.flight.as_mut() {
                    flight.stale = true;
                }
                if context.changed.is_some() && applied.as_ref().is_ok_and(|outcome| outcome.changed) {
                    days_stale = true;
                    owner_unaware = true;
                }
                reply.send(applied);
            }
            Command::Note { key, value, reply } => {
                reply.send(read_or_write_note(&conn, key, value));
            }
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
    pub fn open(thread: SqliteWriterThread, maintenance: MaintenanceIo, path: &Path) -> Result<Arc<Self>> {
        Self::start(thread, maintenance, path, None, BUILD_BUDGET)
    }

    /// [`open`](Self::open) with another size for a day-sum batch (records, at least; it ends
    /// with the session that reaches it; the default is 500).
    pub fn open_with_build_budget(thread: SqliteWriterThread, maintenance: MaintenanceIo, path: &Path, build_budget: i64) -> Result<Arc<Self>> {
        Self::start(thread, maintenance, path, None, build_budget)
    }

    /// [`open`](Self::open), and the writer also tells `changed` when the statistics moved:
    /// once the queue is idle after a commit it recomputes stale rollup days in bounded steps
    /// (`maintain_usage`) and then signals. It recomputes at boot too, but does not signal for it.
    pub fn open_publishing(thread: SqliteWriterThread, maintenance: MaintenanceIo, path: &Path, changed: Arc<dyn UsageChanged>) -> Result<Arc<Self>> {
        Self::start(thread, maintenance, path, Some(changed), BUILD_BUDGET)
    }

    #[allow(clippy::disallowed_methods, reason = "boot-time open of the ledger file, before any lane serves")]
    fn start(
        thread: SqliteWriterThread,
        maintenance: MaintenanceIo,
        path: &Path,
        changed: Option<Arc<dyn UsageChanged>>,
        build_budget: i64,
    ) -> Result<Arc<Self>> {
        let mut conn = Connection::open(path)?;
        conn.execute_batch("PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL")?;
        prepare(&mut conn)?;
        let (commands, receiver) = mpsc::sync_channel(QUEUE);
        let marks = Arc::new(mixdog_rt::WriteMarks::new("the usage ledger"));
        let inner = Arc::new(Inner { commands, marks: marks.clone() });
        let context = Context { path: path.to_path_buf(), maintenance, inner: Arc::downgrade(&inner), changed, build_budget, marks };
        thread.spawn_thread("mixdog-usage-writer", move |_| run(conn, receiver, context))?;
        Ok(Arc::new(Self { inner }))
    }

    /// Queues `command` now, so queue order is call order.
    fn enqueue<T>(&self, make: impl FnOnce(ReplyTx<T>) -> Command) -> Result<ReplyRx<T>> {
        let (tx, rx) = reply();
        self.inner.commands.try_send(make(tx)).map_err(|e| match e {
            mpsc::TrySendError::Full(_) => LedgerError::Busy { queue: QUEUE_NAME },
            mpsc::TrySendError::Disconnected(_) => LedgerError::Stopped,
        })?;
        Ok(rx)
    }

    /// [`enqueue`](Self::enqueue) of a write, numbered in [`marks`](Self::marks); a write the queue refused is withdrawn.
    fn enqueue_write<T>(&self, make: impl FnOnce(ReplyTx<T>, u64) -> Command) -> Result<ReplyRx<T>> {
        let mark = self.inner.marks.accept();
        let queued = self.enqueue(|reply| make(reply, mark));
        if queued.is_err() {
            self.inner.marks.withdrawn(mark);
        }
        queued
    }

    /// The queued writes' numbers: a barrier takes `accepted()` when it arrives and waits for `reached` of it, every
    /// record and quota reading queued before it committed; one that failed is its error.
    pub fn marks(&self) -> &mixdog_rt::WriteMarks {
        &self.inner.marks
    }

    /// Queues one record (`recordQueued`): it is enqueued by this call, in call order, and the
    /// future resolves once the record is durable, or with the error that failed it. A
    /// duplicate id is not an error.
    pub fn record_queued(&self, row: UsageRecord) -> impl Future<Output = Result<()>> + Send + 'static + use<> {
        let queued = self.enqueue_write(|reply, mark| Command::Record { rows: vec![row], reply, mark });
        async move {
            match queued?.await?.pop() {
                Some(Appended::Failed(error)) => Err(error),
                _ => Ok(()),
            }
        }
    }

    /// Queues quota readings (`recordQuotaQueued`); resolves with how many were taken.
    pub fn record_quota_queued(&self, samples: Vec<QuotaReading>) -> impl Future<Output = Result<usize>> + Send + 'static + use<> {
        let queued = self.enqueue_write(|reply, mark| Command::Quota { samples, reply, mark });
        async move { queued?.await? }
    }

    /// Resolves once every record and quota reading queued before this call is committed or
    /// has failed (`settleWrites`). Statistics requested after a send include it.
    pub fn settle_writes(&self) -> impl Future<Output = Result<()>> + Send + 'static + use<> {
        let queued = self.enqueue(|reply| Command::Settle { reply });
        async move { queued?.await }
    }

    /// `liveSince` and `importedThrough`, read behind every write queued before.
    pub(crate) fn history_state(&self) -> impl Future<Output = Result<HistoryState>> + Send + 'static + use<> {
        let queued = self.enqueue(|reply| Command::HistoryState { reply });
        async move { queued?.await? }
    }

    /// Commits an import of the earlier daemon's history; it runs on the writer thread, in order
    /// with the records queued around it.
    pub(crate) fn import_history(&self, write: HistoryWrite) -> impl Future<Output = Result<HistoryOutcome>> + Send + 'static + use<> {
        let queued = self.enqueue_write(|reply, mark| Command::History { write: Box::new(write), mark, reply });
        async move { queued?.await? }
    }

    /// Resolves once the per-session day sums are complete (until then the session reads answer
    /// `SumsBuilding`).
    pub fn sums_built(&self) -> impl Future<Output = Result<()>> + Send + 'static + use<> {
        let queued = self.enqueue(|reply| Command::SumsBuilt { reply });
        async move { queued?.await }
    }

    /// The `metadata` row `key`, read behind every write queued before.
    pub(crate) fn note(&self, key: &'static str) -> impl Future<Output = Result<Option<String>>> + Send + 'static + use<> {
        let queued = self.enqueue(|reply| Command::Note { key, value: None, reply });
        async move { queued?.await? }
    }

    /// Writes the `metadata` row `key`.
    pub(crate) fn put_note(&self, key: &'static str, value: String) -> impl Future<Output = Result<()>> + Send + 'static + use<> {
        let queued = self.enqueue(|reply| Command::Note { key, value: Some(value), reply });
        async move { queued?.await?.map(drop) }
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
        let queued = self.enqueue(|reply| Command::Repair { report, changes, options, now_ms, reply });
        async move { queued?.await? }
    }
}
