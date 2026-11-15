//! The usage history the earlier daemon left, imported into the ledger when statistics are read
//! (`usage-ledger-import.mjs`, `ensureHistoryImported` of `usage-stats-api.mjs`).
//!
//! The surviving originals are the rotated agent trace, the gateway usage store, the legacy
//! rollup document and the earlier daemon's read-only database. They are read, never rewritten.
//! Request rows outrank overlapping turn and day summaries; incomplete historical coverage stays
//! explicit rather than inventing a missing balance. Only what is older than `liveSince` (the
//! first live record, or now when there is none yet) is imported, so a live send's diagnostic
//! copy cannot enter as history. The import is marked by `importedThrough`.
//!
//! The files are read on the maintenance lane, the rows are priced on `cpu-bulk`, and the write
//! commits each original batch in order; it never holds the writer while it reads or prices.

use std::path::PathBuf;
use std::sync::Arc;
use std::sync::Mutex;

use mixdog_rt::CancellationToken;
use mixdog_rt::CpuBulk;
use mixdog_rt::InLane;
use mixdog_rt::LaneToken;
use mixdog_rt::MaintenanceIo;
use serde_json::Value;

use crate::error::LedgerError;
use crate::error::Result;
use crate::refresh::Pricer;
use crate::reply::ReplyTx;
use crate::reply::reply;
use crate::writer::UsageWriter;

mod record;
mod source;
#[cfg(test)]
mod tests;
mod trace_db;
mod write;

pub(crate) use write::HistoryOutcome;
pub(crate) use write::HistoryState;
pub(crate) use write::HistoryWrite;
pub(crate) use write::read_state;

use source::Originals;
use write::Receipt;
use write::ReceiptFile;

pub use trace_db::OriginalTrace;
pub use trace_db::Postgres;
pub use trace_db::TraceFuture;

#[derive(Default)]
struct State {
    /// An import ran (or was found done) in this process.
    imported: bool,
    /// Nothing more to import: `liveSince` is known and `importedThrough` reaches it.
    done: bool,
    running: bool,
    waiters: Vec<ReplyTx<std::result::Result<(), Arc<LedgerError>>>>,
}

pub struct HistoryImporter {
    data_dir: PathBuf,
    maintenance: MaintenanceIo,
    cpu_bulk: CpuBulk,
    pricer: Arc<dyn Pricer>,
    trace: Arc<dyn OriginalTrace>,
    state: Mutex<State>,
}

/// Ends an import however it ends: frees the slot and wakes the readers that waited for it.
struct Running<'a> {
    importer: &'a HistoryImporter,
    result: std::result::Result<(), Arc<LedgerError>>,
}

impl Drop for Running<'_> {
    fn drop(&mut self) {
        let waiters = {
            let mut state = self.importer.lock();
            state.running = false;
            std::mem::take(&mut state.waiters)
        };
        for waiter in waiters {
            waiter.send(self.result.clone());
        }
    }
}

/// The rows an import accepts, and what became of the ones it did not.
#[derive(Default)]
struct Accepted {
    records: Vec<crate::append::UsageRecord>,
    source_rows: u64,
    unrecordable_rows: u64,
}

impl Accepted {
    fn take(&mut self, rows: &[Value], until: f64, pricer: &dyn Pricer) -> Result<()> {
        for row in rows {
            self.source_rows += 1;
            match record::import_row(row, pricer)? {
                None => self.unrecordable_rows += 1,
                Some(record) if (record.ts as f64) < until => self.records.push(record),
                Some(_) => {}
            }
        }
        Ok(())
    }
}

/// The final legacy import and completion metadata, after all accepted batches committed.
fn plan(originals: &Originals, until: f64, pricer: &dyn Pricer) -> Result<HistoryWrite> {
    let mut legacy_days = Vec::new();
    if let Some(days) = originals.rollup_days.as_ref().filter(|_| originals.ready) {
        // Only a day map holds days; an array is accepted as a document and holds none.
        if let Value::Object(days) = record::reprice_restored_days(days, pricer)? {
            for (day, value) in days {
                if is_day_key(&day) {
                    legacy_days.push((day, mixdog_js::json_stringify(&value)));
                }
            }
        }
    }
    Ok(HistoryWrite {
        records: Vec::new(),
        legacy_days,
        through: originals.ready.then(|| mixdog_js::number_to_string(until)),
        previously_inserted: 0,
        receipt: Some(Receipt {
            source_rows: 0,
            unrecordable_rows: 0,
            torn_trace_lines: 0,
            files: Vec::new(),
            trace_rows: 0,
            until,
        }),
    })
}

/// `YYYY-MM-DD`.
fn is_day_key(day: &str) -> bool {
    let bytes = day.as_bytes();
    bytes.len() == 10
        && bytes.iter().enumerate().all(|(at, byte)| match at {
            4 | 7 => *byte == b'-',
            _ => byte.is_ascii_digit(),
        })
}

impl HistoryImporter {
    pub(crate) fn new(
        data_dir: PathBuf,
        maintenance: MaintenanceIo,
        cpu_bulk: CpuBulk,
        pricer: Arc<dyn Pricer>,
        trace: Arc<dyn OriginalTrace>,
    ) -> Self {
        Self {
            data_dir,
            maintenance,
            cpu_bulk,
            pricer,
            trace,
            state: Mutex::new(State::default()),
        }
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, State> {
        self.state.lock().unwrap_or_else(std::sync::PoisonError::into_inner)
    }

    /// Readers joining an import receive that import's result; only a later call retries.
    pub(crate) async fn ensure(&self, writer: &Arc<UsageWriter>, now: i64) -> Result<()> {
        let wait = {
            let mut state = self.lock();
            if state.done { return Ok(()); }
            if state.running {
                let (tx, rx) = reply();
                state.waiters.push(tx);
                Some(rx)
            } else {
                state.running = true;
                None
            }
        };
        if let Some(rx) = wait {
            return rx.await?.map_err(LedgerError::SharedHistory);
        }
        // Cancellation also settles existing waiters, without turning failure into success.
        let mut running = Running { importer: self, result: Err(Arc::new(LedgerError::Stopped)) };
        running.result = self.settle(writer, now).await.map_err(Arc::new);
        running.result.clone().map_err(LedgerError::SharedHistory)
    }

    async fn settle(&self, writer: &Arc<UsageWriter>, now: i64) -> Result<()> {
        let state = writer.history_state().await?;
        let live = (state.live_since.is_finite() && state.live_since != 0.0).then_some(state.live_since);
        let imported = self.lock().imported;
        // Until the first live send fixes the cutover, the earlier writer may still be active:
        // a previous import is not a standing one.
        let reaches = live.is_some_and(|live| imported && state.imported_through >= live);
        let marked = reaches || self.import(writer, live.unwrap_or(now as f64), &state).await?;
        let mut state = self.lock();
        state.imported = true;
        state.done = marked && live.is_some();
        Ok(())
    }

    /// `importUsageHistory`: `true` when `importedThrough` reaches `until` afterwards.
    async fn import(&self, writer: &Arc<UsageWriter>, until: f64, state: &HistoryState) -> Result<bool> {
        if state.imported_through >= until {
            return Ok(true);
        }
        let data_dir = self.data_dir.clone();
        let names = self.read(move || source::trace_names(&data_dir.join("history"))).await?;
        let mut receipt = Receipt {
            source_rows: 0, unrecordable_rows: 0, torn_trace_lines: 0,
            files: Vec::new(), trace_rows: 0, until,
        };
        let mut inserted = 0;
        for name in names {
            let path = self.data_dir.join("history").join(name);
            let file = self.read(move || source::read_trace_file(&path)).await?;
            if file.torn > 0 {
                mixdog_rt::node_stderr!("[usage-ledger] warning: {} has {} torn trace line(s); skipped", file.path, file.torn);
            }
            let file_receipt = ReceiptFile { path: file.path, sha256: file.sha256, rows: file.rows.len() };
            receipt.torn_trace_lines += file.torn;
            inserted += self.accept(writer, file.rows, until, &mut receipt).await?;
            receipt.files.push(file_receipt);
        }
        let data_dir = self.data_dir.clone();
        let pid = self.read(move || source::read_pid(&data_dir)).await?;
        let trace_rows = match pid {
            Some(pid) => self.trace.rows(&pid, until as i64).await?,
            None => Vec::new(),
        };
        receipt.trace_rows = trace_rows.len();
        inserted += self.accept(writer, trace_rows, until, &mut receipt).await?;
        // Gateway IO and mapping happen after trace commits, and rollup IO after gateway commits.
        let data_dir = self.data_dir.clone();
        let mut originals = self.read(move || source::read_gateway(&data_dir)).await?;
        for warning in &originals.warnings { mixdog_rt::node_stderr!("{warning}"); }
        originals.warnings.clear();
        if let Some(events) = originals.gateway.take() {
            inserted += self.accept(writer, events, until, &mut receipt).await?;
        }
        let data_dir = self.data_dir.clone();
        let originals = self.read(move || source::read_rollup(&data_dir, originals)).await?;
        for warning in &originals.warnings { mixdog_rt::node_stderr!("{warning}"); }
        let pricer = self.pricer.clone();
        let mut write = self.cpu_bulk.submit(&CancellationToken::new(), move |_: &InLane<CpuBulk>| {
            plan(&originals, until, pricer.as_ref())
        }).map_err(|_| LedgerError::Busy { queue: "cpu-bulk" })?
            .await.map_err(|_| LedgerError::Stopped)??;
        write.receipt = Some(receipt);
        write.previously_inserted = inserted;
        Ok(writer.import_history(write).await?.marked)
    }

    async fn read<T: Send + 'static>(&self, work: impl FnOnce() -> Result<T> + Send + 'static) -> Result<T> {
        self.maintenance.submit(&CancellationToken::new(), move |_: &InLane<MaintenanceIo>| work())
            .map_err(|_| LedgerError::Busy { queue: "io-maintenance" })?
            .await.map_err(|_| LedgerError::Stopped)?
    }

    async fn accept(&self, writer: &Arc<UsageWriter>, rows: Vec<Value>, until: f64, receipt: &mut Receipt) -> Result<usize> {
        let pricer = self.pricer.clone();
        let accepted = self.cpu_bulk.submit(&CancellationToken::new(), move |_: &InLane<CpuBulk>| {
            let mut accepted = Accepted::default();
            accepted.take(&rows, until, pricer.as_ref())?;
            Ok::<_, LedgerError>(accepted)
        }).map_err(|_| LedgerError::Busy { queue: "cpu-bulk" })?
            .await.map_err(|_| LedgerError::Stopped)??;
        receipt.source_rows += accepted.source_rows;
        receipt.unrecordable_rows += accepted.unrecordable_rows;
        Ok(writer.import_history(HistoryWrite {
            records: accepted.records, legacy_days: Vec::new(), through: None,
            receipt: None, previously_inserted: 0,
        }).await?.inserted)
    }
}
