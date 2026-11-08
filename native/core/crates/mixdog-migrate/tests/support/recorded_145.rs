//! The harness of the recorded-1.4.5 tests: a scratch copy of the directory the real v1.4.5 code wrote
//! (`benchmarks/rust-core/recorders/record-migration-145.mjs` -> `fixtures/migration-145`), the migrator over it,
//! and the answers 1.4.5 gave for the same data (`answers.json`). Included by the tests that read the migrated
//! data back.

use std::collections::BTreeMap;
use std::path::Path;
use std::path::PathBuf;
use std::sync::Arc;

use mixdog_migrate::durable;
use mixdog_migrate::framework::MigrationRoots;
use mixdog_migrate::index::IndexProjector;
use mixdog_migrate::run::MigrateOptions;
use mixdog_migrate::run::Migrator;
use mixdog_migrate::run::product_drivers;
use mixdog_migrate::session::context_blobs::OfficeExtractor;
use mixdog_protocol::ThreadId;
use mixdog_store::schema::migration::Complete;
use mixdog_core_api::domain::ext::DocumentText;
use mixdog_core_api::domain::ext::ExtError;
use mixdog_core_api::domain::ext::PdfIntake;
use serde_json::Value;

/// The recording holds no office document: the extractor is never asked.
struct NoDocs;

#[async_trait::async_trait]
impl DocumentText for NoDocs {
    async fn office_text(&self, _: &ThreadId, filename: &str, _: &str) -> Result<Option<String>, ExtError> {
        panic!("the recorded data has no office part, yet {filename} was extracted")
    }
    async fn pdf_text(&self, _: &ThreadId, _: &str) -> Result<String, ExtError> {
        unreachable!("the migration extracts no PDF text")
    }
    async fn pdf_counts(&self, _: &ThreadId, _: &str) -> Result<PdfIntake, ExtError> {
        unreachable!("the migration counts no PDF")
    }
}

/// The store's own catalog projector, as `mixdogd migrate` runs it.
struct StoreProjector;

impl IndexProjector for StoreProjector {
    fn project(&self, data: &Path, db: &Path, sessions: &[String]) -> Result<(), String> {
        mixdog_store::sqlite::project_index(data, db, sessions)
    }
}

pub fn fixture_dir() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../../fixtures/migration-145")
}

pub fn answers() -> Value {
    serde_json::from_slice(&durable::read(&fixture_dir().join("answers.json")).expect("answers.json")).expect("answers parse")
}

/// A scratch copy of the recorded directory: `<root>/.mixdog/data` is `<D>`, `<root>/.mixdog` is `<H>`.
pub struct Copy {
    dir: tempfile::TempDir,
}

impl Copy {
    pub fn roots(&self) -> MigrationRoots {
        roots_at(self.dir.path())
    }
}

/// The roots of a recorded directory copied under `root`.
pub fn roots_at(root: &Path) -> MigrationRoots {
    let home = root.join(".mixdog");
    MigrationRoots { data: home.join("data"), home, profile: None }
}

/// The recorded directory copied under `root`.
pub fn copy_at(root: &Path) -> MigrationRoots {
    let from = fixture_dir().join(".mixdog");
    let home = root.join(".mixdog");
    for rel in durable::walk_files(&from).expect("walk the recording") {
        let target = home.join(&rel);
        std::fs::create_dir_all(target.parent().expect("a file has a parent")).expect("dir");
        std::fs::copy(from.join(&rel), &target).expect("copy");
    }
    roots_at(root)
}

pub fn copy() -> Copy {
    let dir = tempfile::tempdir().expect("scratch dir");
    copy_at(dir.path());
    Copy { dir }
}
pub fn migrator(roots: &MigrationRoots, options: MigrateOptions) -> Migrator {
    let office = OfficeExtractor { docs: Arc::new(NoDocs), runtime: runtime().handle().clone() };
    Migrator::new(roots.clone(), product_drivers(Arc::new(StoreProjector), office), options)
}

fn runtime() -> &'static tokio::runtime::Runtime {
    static RUNTIME: std::sync::LazyLock<tokio::runtime::Runtime> =
        std::sync::LazyLock::new(|| tokio::runtime::Builder::new_current_thread().build().expect("a runtime"));
    &RUNTIME
}

pub fn migrate(roots: &MigrationRoots) -> Complete {
    migrator(roots, MigrateOptions::default()).run().expect("the migration of the recorded data completes")
}

/// A completed migration of a fresh copy.
pub fn migrated() -> (Copy, Complete) {
    let copy = copy();
    let complete = migrate(&copy.roots());
    (copy, complete)
}

/// Paths (relative to `<H>`) and SHA-256 of every file the migration left, its journal included.
pub fn tree_digest(roots: &MigrationRoots) -> BTreeMap<String, String> {
    durable::walk_files(&roots.home)
        .expect("walk")
        .into_iter()
        .map(|rel| {
            let sha = durable::hash_file(&roots.home.join(&rel)).expect("hash").1;
            (rel, sha)
        })
        .collect()
}
/// `path -> sha256` of the recording, `.mixdog`-relative.
pub fn recorded_files() -> BTreeMap<String, String> {
    let from = fixture_dir().join(".mixdog");
    durable::walk_files(&from)
        .expect("walk the recording")
        .into_iter()
        .map(|rel| {
            let sha = durable::hash_file(&from.join(&rel)).expect("hash").1;
            (rel, sha)
        })
        .collect()
}
