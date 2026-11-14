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
//! is one command on the writer thread; an import never holds the writer while it reads or prices.

use std::path::PathBuf;
use std::sync::Arc;
use std::sync::Mutex;

use mixdog_rt::CancellationToken;
use mixdog_rt::CpuBulk;
use mixdog_rt::InLane;
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
use source::read_originals;
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
    waiters: Vec<ReplyTx<()>>,
    /// The failure last reported, so the same one is not reported at every statistics read.
    reported: Option<String>,
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
struct Running<'a>(&'a HistoryImporter);

impl Drop for Running<'_> {
    fn drop(&mut self) {
        let waiters = {
            let mut state = self.0.lock();
            state.running = false;
            std::mem::take(&mut state.waiters)
        };
        for waiter in waiters {
            waiter.send(());
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

/// Everything read, as the rows to commit: trace files, the database's rows, the gateway store,
/// then the legacy days.
fn plan(originals: &Originals, trace_rows: &[Value], until: f64, pricer: &dyn Pricer) -> Result<HistoryWrite> {
    let mut accepted = Accepted::default();
    let mut files = Vec::new();
    let mut torn = 0;
    for file in &originals.trace_files {
        torn += file.torn;
        accepted.take(&file.rows, until, pricer)?;
        files.push(ReceiptFile {
            path: file.path.clone(),
            sha256: file.sha256.clone(),
            rows: file.rows.len(),
        });
    }
    accepted.take(trace_rows, until, pricer)?;
    if let Some(events) = &originals.gateway {
        accepted.take(events, until, pricer)?;
    }
    let mut legacy_days = Vec::new();
    if let Some(days) = &originals.rollup_days {
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
        records: accepted.records,
        legacy_days,
        through: originals.ready.then(|| mixdog_js::number_to_string(until)),
        receipt: Receipt {
            source_rows: accepted.source_rows,
            unrecordable_rows: accepted.unrecordable_rows,
            torn_trace_lines: torn,
            files,
            trace_rows: trace_rows.len(),
            until,
        },
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

    /// Imports the history that is not in the ledger yet, once: a statistics read that arrives
    /// while another read imports waits for it. A history that cannot be imported is reported
    /// (once per distinct failure) and the statistics are still read from what the ledger holds;
    /// the import is tried again at the next read.
    pub(crate) async fn ensure(&self, writer: &Arc<UsageWriter>, now: i64) {
        if self.lock().done {
            return;
        }
        let wait = {
            let mut state = self.lock();
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
            let _ = rx.await;
            return;
        }
        let _running = Running(self);
        match self.settle(writer, now).await {
            Ok(()) => self.lock().reported = None,
            Err(error) => {
                let message = error.to_string();
                let fresh = {
                    let mut state = self.lock();
                    let fresh = state.reported.as_deref() != Some(message.as_str());
                    state.reported = Some(message.clone());
                    fresh
                };
                if fresh {
                    mixdog_rt::node_stderr!("[usage-ledger] {message}");
                }
            }
        }
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
        let originals = self
            .maintenance
            .submit(&CancellationToken::new(), move |_: &InLane<MaintenanceIo>| read_originals(&data_dir))
            .map_err(|_| LedgerError::Busy { queue: "io-maintenance" })?
            .await
            .map_err(|_| LedgerError::Stopped)??;
        for warning in &originals.warnings {
            mixdog_rt::node_stderr!("{warning}");
        }
        // A present-but-unreachable original store is an import error, not absence.
        let trace_rows = match &originals.pid_file {
            Some(pid_file) => self.trace.rows(pid_file, until as i64).await?,
            None => Vec::new(),
        };
        let pricer = self.pricer.clone();
        let write = self
            .cpu_bulk
            .submit(&CancellationToken::new(), move |_: &InLane<CpuBulk>| {
                plan(&originals, &trace_rows, until, pricer.as_ref())
            })
            .map_err(|_| LedgerError::Busy { queue: "cpu-bulk" })?
            .await
            .map_err(|_| LedgerError::Stopped)??;
        Ok(writer.import_history(write).await?.marked)
    }
}
