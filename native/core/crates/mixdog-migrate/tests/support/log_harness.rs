//! The harness of the session-log tests: the record encodings of a 1.4.5 session log and the migrator over one log.
//! Included by the tests that migrate a log.

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
use mixdog_protocol::ThreadId;
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

pub fn run(roots: &MigrationRoots) -> Complete {
    let (_runtime, migrator) = migrator(roots, MigrateOptions::default());
    migrator.run().expect("the migration completes")
}

pub fn migrate(roots: &MigrationRoots) -> Complete {
    let complete = run(roots);
    assert_eq!(complete.kinds.data.quarantined_unexpected, 0);
    complete
}

// The record encodings of a 1.4.5 session log.

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
