//! Records the input of `src/session/restore/vectors/generate.mjs`: the transcript message
//! bodies of every migrated session of the corpus scenarios `restored_rows_match_node`
//! compares.
//!
//!   MIXDOG_RESTORE_DUMP=<dump.json> cargo run -p mixdog-migrate --example dump_corpus_messages
//!
//! `MIXDOG_MIGRATION_CORPUS` overrides the corpus path, as for the corpus gates.

#![allow(
    clippy::disallowed_methods,
    clippy::disallowed_types,
    reason = "a one-shot recorder copies the corpus and writes its dump with blocking std::fs"
)]

use std::path::Path;
use std::path::PathBuf;
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
use mixdog_migrate::session::target::read_sessions;
use mixdog_protocol::ThreadId;
use mixdog_store::schema::record::Form;
use serde_json::Value;
use serde_json::json;

/// `(scenario, data dir under the corpus)`, as `restored_rows_match_node` reads them.
const SCENARIOS: [(&str, &str); 2] = [("v145", "v145"), ("dev146", "dev146")];

struct StoreProjector;

impl IndexProjector for StoreProjector {
    fn project(&self, data: &Path, db: &Path, sessions: &[String]) -> Result<(), String> {
        mixdog_store::sqlite::project_index(data, db, sessions)
    }
}

/// The corpus scenarios recover no turn, so no context signature reads a document.
struct NoDocuments;

#[async_trait::async_trait]
impl DocumentText for NoDocuments {
    async fn office_text(&self, _: &ThreadId, filename: &str, _: &str) -> Result<Option<String>, ExtError> {
        unreachable!("the corpus signs no office document ({filename})")
    }
    async fn pdf_text(&self, _: &ThreadId, _: &str) -> Result<String, ExtError> {
        unreachable!("the migration extracts no PDF text")
    }
    async fn pdf_counts(&self, _: &ThreadId, _: &str) -> Result<PdfIntake, ExtError> {
        unreachable!("the migration counts no PDF")
    }
}

fn copy_tree(from: &Path, to: &Path) {
    for rel in mixdog_migrate::durable::walk_files(from).unwrap() {
        let dst = to.join(&rel);
        std::fs::create_dir_all(dst.parent().unwrap()).unwrap();
        std::fs::copy(from.join(&rel), dst).unwrap();
    }
    std::fs::create_dir_all(to).unwrap();
}

fn main() {
    let out = std::env::var_os("MIXDOG_RESTORE_DUMP").expect("MIXDOG_RESTORE_DUMP names the dump file");
    let corpus = std::env::var_os("MIXDOG_MIGRATION_CORPUS")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from(r"C:\Users\tempe\.mixdog\data\scratch\rust-core\migration-corpus"));
    let mut dump = serde_json::Map::new();
    let runtime = tokio::runtime::Builder::new_current_thread().build().unwrap();
    let office = OfficeExtractor { docs: Arc::new(NoDocuments), runtime: runtime.handle().clone() };
    for (scenario, data_rel) in SCENARIOS {
        let dir = tempfile::tempdir().unwrap();
        let roots = MigrationRoots {
            data: dir.path().join("data"),
            home: dir.path().join("home"),
            profile: None,
        };
        copy_tree(&corpus.join(data_rel), &roots.data);
        copy_tree(&corpus.join("home"), &roots.home);
        let drivers = product_drivers(Arc::new(StoreProjector), office.clone());
        let complete = Migrator::new(roots.clone(), drivers, MigrateOptions::default())
            .run()
            .unwrap();
        let sessions: serde_json::Map<String, Value> = read_sessions(&roots, &complete.manifest_sha256)
            .unwrap()
            .into_iter()
            .map(|(id, folded)| {
                let bodies = folded
                    .rows
                    .into_iter()
                    .filter(|r| r.form == Form::Message && r.archive.is_none())
                    .map(|r| r.body)
                    .collect();
                (id, Value::Array(bodies))
            })
            .collect();
        let data_dir = corpus.join(data_rel).to_string_lossy().into_owned();
        dump.insert(scenario.into(), json!({"dataDir": data_dir, "sessions": sessions}));
    }
    std::fs::write(out, serde_json::to_vec(&Value::Object(dump)).unwrap()).unwrap();
}
