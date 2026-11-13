//! A session as the old-format readers see it: what will become its frames, and the
//! source side of its observable state (SM §11.6).

use mixdog_store::schema::record::ArchiveTag;
use mixdog_store::schema::record::Form;
use mixdog_store::schema::record::Header;
use mixdog_store::schema::record::RunPhase;
use serde_json::Value;

/// One history row to emit.
#[derive(Debug, Clone, PartialEq)]
pub struct Row {
    pub iid: String,
    pub turn: Option<String>,
    pub role: Option<String>,
    pub form: Form,
    pub model: bool,
    pub visible: bool,
    pub archive: Option<ArchiveTag>,
    /// The display text when the row counts for prompt history (`ItemRecord.prompt`).
    pub prompt: Option<String>,
    pub body: Value,
}

#[derive(Debug, Clone, PartialEq)]
pub struct RunModel {
    pub rid: String,
    pub at: Option<i64>,
    /// Phases in order with their detail.
    pub phases: Vec<(RunPhase, Option<Value>)>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct SessionModel {
    pub id: String,
    /// The winning source's header (every key but `messages`).
    pub header: Header,
    /// Archive rows (display segments and pending jobs), seq order.
    pub archive: Vec<Row>,
    /// The transcript rows.
    pub messages: Vec<Row>,
    /// The model context 1.4.5 held (`(iid, body)` of every message and recovered turn row, in its order), when rows of
    /// it were written out of that order (`source::place_retained`): a silent `compacted` record after the rows
    /// restarts the context at it.
    pub context: Option<Vec<(String, Value)>>,
    /// Rows of recovered turn checkpoints, each followed by its run.
    pub checkpoint_rows: Vec<Row>,
    pub runs: Vec<RunModel>,
    /// `(qid, entry)` in delivery order.
    pub queue: Vec<(String, Value)>,
    /// Header changes, one `meta` frame each (worker row, other kind groups).
    pub metas: Vec<Header>,
    /// Pending-job seqs dropped because their segment is published.
    pub superseded_jobs: Vec<u64>,
    pub replaced_surrogates: u64,
}
