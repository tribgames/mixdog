use serde_json::Map;
use serde_json::Value;

use crate::append::UsageRecord;
use crate::append::append_batch;
use crate::db::Connection;
use crate::db::OptionalExtension;
use crate::db::Transaction;
use crate::db::TransactionBehavior;
use crate::db::params;
use crate::error::Result;

/// `liveSince` and `importedThrough` as numbers; a missing or unreadable one is 0 or NaN, which
/// every comparison of the import treats as "not there".
pub(crate) struct HistoryState {
    pub live_since: f64,
    pub imported_through: f64,
}

pub(crate) fn read_state(conn: &Connection) -> Result<HistoryState> {
    let read = |key: &str| -> Result<f64> {
        let value: Option<String> = conn.query_row("SELECT value FROM metadata WHERE key=?1", [key], |r| r.get(0)).optional()?;
        Ok(value.map_or(0.0, |value| mixdog_js::string_to_number(&value)))
    };
    Ok(HistoryState { live_since: read("liveSince")?, imported_through: read("importedThrough")? })
}

/// One file the import read, as the receipt records it.
pub(super) struct ReceiptFile {
    pub path: String,
    pub sha256: String,
    pub rows: usize,
}

/// What `importReceipt` says: what was read and how it went (the inserted count is the writer's).
pub(super) struct Receipt {
    pub source_rows: u64,
    pub unrecordable_rows: u64,
    pub torn_trace_lines: u64,
    pub files: Vec<ReceiptFile>,
    pub trace_rows: usize,
    pub until: f64,
}

impl Receipt {
    fn json(&self, inserted: usize) -> String {
        let files = self
            .files
            .iter()
            .map(|file| {
                let mut entry = Map::new();
                entry.insert("path".to_owned(), Value::from(file.path.as_str()));
                entry.insert("sha256".to_owned(), Value::from(file.sha256.as_str()));
                entry.insert("rows".to_owned(), Value::from(file.rows));
                Value::Object(entry)
            })
            .collect();
        let mut receipt = Map::new();
        receipt.insert("inserted".to_owned(), Value::from(inserted));
        receipt.insert("sourceRows".to_owned(), Value::from(self.source_rows));
        receipt.insert("unrecordableRows".to_owned(), Value::from(self.unrecordable_rows));
        receipt.insert("tornTraceLines".to_owned(), Value::from(self.torn_trace_lines));
        receipt.insert("files".to_owned(), Value::Array(files));
        receipt.insert("traceRows".to_owned(), Value::from(self.trace_rows));
        receipt.insert("until".to_owned(), mixdog_js::json_number(self.until));
        mixdog_js::json_stringify(&Value::Object(receipt))
    }
}

pub(crate) struct HistoryWrite {
    pub(super) records: Vec<UsageRecord>,
    /// `(day, document)` of the legacy rollup's days.
    pub(super) legacy_days: Vec<(String, String)>,
    /// The text `importedThrough` is set to; none when a damaged original was skipped.
    pub(super) through: Option<String>,
    pub(super) receipt: Option<Receipt>,
    pub(super) previously_inserted: usize,
}

pub(crate) struct HistoryOutcome {
    /// Records or legacy days were added: what the statistics show moved.
    pub changed: bool,
    pub inserted: usize,
    /// `importedThrough` is set.
    pub marked: bool,
}

fn set_metadata(tx: &Transaction, key: &str, value: &str) -> Result<()> {
    tx.prepare_cached("INSERT INTO metadata VALUES (?1,?2) ON CONFLICT(key) DO UPDATE SET value=excluded.value")?.execute(params![key, value])?;
    Ok(())
}

impl HistoryWrite {
    pub(crate) fn apply(&self, conn: &mut Connection) -> Result<HistoryOutcome> {
        // One original accept(rows) is one transaction, even across the live append batch size.
        let inserted = append_batch(conn, &self.records)?;
        if self.receipt.is_none() && self.legacy_days.is_empty() && self.through.is_none() {
            return Ok(HistoryOutcome { changed: inserted > 0, inserted, marked: false });
        }
        let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let mut days = 0;
        for (day, document) in &self.legacy_days {
            days += tx.prepare_cached("INSERT OR IGNORE INTO legacy_days VALUES (?1,?2)")?.execute(params![day, document])?;
        }
        if let Some(through) = &self.through {
            set_metadata(&tx, "importedThrough", through)?;
        }
        if let Some(receipt) = &self.receipt {
            set_metadata(&tx, "importReceipt", &receipt.json(self.previously_inserted + inserted))?;
        }
        tx.commit()?;
        Ok(HistoryOutcome { changed: inserted > 0 || days > 0, inserted, marked: self.through.is_some() })
    }
}
