//! The harness of the long-session-log tests: the recording of what Node's reader reads from session logs
//! (`fixtures/long-session-log`, from `benchmarks/rust-core/recorders/record-long-session-log.mjs`), the record
//! encodings it fixes, and the migrator over one log. Included by the tests that migrate a log.

#![allow(
    dead_code,
    reason = "each test binary that includes this harness uses part of it"
)]
#![allow(
    clippy::disallowed_methods,
    clippy::disallowed_types,
    reason = "test fixtures build and inspect data dirs with blocking std::fs"
)]

use std::path::Path;
use std::sync::Arc;

use mixdog_core_api::domain::ext::DocumentText;
use mixdog_core_api::domain::ext::ExtError;
use mixdog_core_api::domain::ext::PdfIntake;
use mixdog_migrate::framework::MigrationRoots;
use mixdog_migrate::index::IndexProjector;
use mixdog_migrate::run::MigrateOptions;
use mixdog_migrate::run::Migrator;
use mixdog_migrate::run::product_drivers;
use mixdog_migrate::session::context_blobs::OfficeExtractor;
use mixdog_migrate::session::target::Folded;
use mixdog_protocol::ThreadId;
use mixdog_store::schema::record::Form;
use mixdog_store::schema::migration::Complete;
use serde_json::Value;

struct NoDocs;

#[async_trait::async_trait]
impl DocumentText for NoDocs {
    async fn office_text(&self, _: &ThreadId, filename: &str, _: &str) -> Result<Option<String>, ExtError> {
        panic!("the data has no office part, yet {filename} was extracted")
    }
    async fn pdf_text(&self, _: &ThreadId, _: &str) -> Result<String, ExtError> {
        unreachable!("the migration extracts no PDF text")
    }
    async fn pdf_counts(&self, _: &ThreadId, _: &str) -> Result<PdfIntake, ExtError> {
        unreachable!("the migration counts no PDF")
    }
}

struct StoreProjector;

impl IndexProjector for StoreProjector {
    fn project(&self, data: &Path, db: &Path, sessions: &[String]) -> Result<(), String> {
        mixdog_store::sqlite::project_index(data, db, sessions)
    }
}

/// An empty data dir and home under `dir`, with the `sessions` folder a log goes in.
pub fn roots_in(dir: &Path) -> MigrationRoots {
    let roots = MigrationRoots { data: dir.join("data"), home: dir.join("home"), profile: None };
    std::fs::create_dir_all(roots.data.join("sessions")).expect("sessions dir");
    std::fs::create_dir_all(&roots.home).expect("home dir");
    roots
}

pub fn migrator(roots: &MigrationRoots, options: MigrateOptions) -> (tokio::runtime::Runtime, Migrator) {
    let runtime = tokio::runtime::Builder::new_current_thread().build().expect("a runtime");
    let office = OfficeExtractor { docs: Arc::new(NoDocs), runtime: runtime.handle().clone() };
    (runtime, Migrator::new(roots.clone(), product_drivers(Arc::new(StoreProjector), office), options))
}

pub fn migrate(roots: &MigrationRoots) -> Complete {
    let (_runtime, migrator) = migrator(roots, MigrateOptions::default());
    let complete = migrator.run().expect("the migration completes");
    assert_eq!(complete.kinds.data.quarantined_unexpected, 0);
    complete
}

/// The migrated session is the session Node's reader read from the same bytes: all of it, in order.
///
/// `node` is the recorded result of Node's `readSessionLog`. The store keeps the leading system message as the header's
/// `promptBase` and every other message as one row (`request_system_corpus.rs` proves that for the corpus), so the
/// expected header is Node's header with that key last, and the expected rows are Node's remaining messages, each row
/// the message's own bytes (key order too) and its `prompt` the trimmed content of a user message. Nothing is left out: the
/// header's every key, every row's every field this reading defines, and no run, queue entry, context or archive.
pub fn assert_is_what_node_reads(session: &Folded, node: &Value) {
    assert_eq!(node["valid"], true, "Node reads a session from this log");
    let messages = node["messages"].as_array().expect("Node's messages");
    let (system, rest) = messages.split_first().expect("a history");
    assert_eq!(system["role"], "system", "the history opens with its system message");
    assert_ne!(rest.first().map(|m| &m["role"]), Some(&Value::from("system")), "exactly one system message");

    let mut header = node["header"].as_object().expect("Node's header").clone();
    header.insert("promptBase".into(), system["content"].clone());
    let have = serde_json::to_value(&session.header).expect("header");
    assert_eq!(serde_json::to_string(&have).expect("json"), serde_json::to_string(&header).expect("json"), "the header");

    assert_eq!(session.rows.len(), rest.len(), "the message rows");
    for (n, (row, message)) in session.rows.iter().zip(rest).enumerate() {
        let want_prompt = (message["role"] == "user").then(|| mixdog_js::js_trim(message["content"].as_str().expect("user text")).to_owned());
        assert_eq!(row.ordinal, n as u64 + 1, "row {n} ordinal");
        assert!(row.form == Form::Message && row.model && row.visible, "row {n} is a visible model message");
        assert!(row.turn.is_none() && row.archive.is_none() && row.refs.is_empty(), "row {n} belongs to no turn, archive or attachment");
        assert_eq!(row.prompt, want_prompt, "row {n} prompt");
        assert_eq!(serde_json::to_string(&row.body).expect("json"), serde_json::to_string(message).expect("json"), "row {n} body");
    }
    assert!(session.context.is_none() && session.runs.is_empty() && session.queue.is_empty(), "no context, run or queue entry");
}

pub fn recorded(file: &str) -> Value {
    let path = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../fixtures/long-session-log").join(file);
    serde_json::from_slice(&std::fs::read(path).expect("the recording")).expect("json")
}

// The record encodings of `session-log-format.mjs`, as the recording shows them.

pub fn array(messages: &[String]) -> String {
    format!("[{}]", messages.join(","))
}

pub fn compacted(seq: u64, messages: &[String]) -> String {
    format!("{{\"t\":\"compacted\",\"s\":{seq},\"len\":{},\"messages\":{}}}\n", messages.len(), array(messages))
}

pub fn append(seq: u64, len: usize, messages: &[String]) -> String {
    format!("{{\"t\":\"append\",\"s\":{seq},\"len\":{len},\"messages\":{}}}\n", array(messages))
}

pub fn edit(seq: u64, len: usize, at: usize, del: usize, messages: &[String]) -> String {
    format!("{{\"t\":\"edit\",\"s\":{seq},\"len\":{len},\"at\":{at},\"del\":{del},\"messages\":{}}}\n", array(messages))
}

pub fn rollback(seq: u64, len: usize) -> String {
    format!("{{\"t\":\"rollback\",\"s\":{seq},\"len\":{len}}}\n")
}

pub fn patch(seq: u64, set: &Value, unset: &Value) -> String {
    format!("{{\"t\":\"patch\",\"s\":{seq},\"set\":{set},\"unset\":{unset}}}\n")
}

pub fn session(log_id: &str, id: &str, header: &Value) -> String {
    format!("{{\"t\":\"session\",\"s\":0,\"v\":1,\"logId\":\"{log_id}\",\"id\":\"{id}\",\"prev\":null,\"legacy\":null,\"header\":{header}}}\n")
}
