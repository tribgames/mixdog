//! The recorded `.mixdog` data directories a test migrates and opens through the real store, as the core does at its first start.

use std::path::Path;
use std::sync::Arc;

use async_trait::async_trait;
use mixdog_core_api::domain::ext::DocumentText;
use mixdog_core_api::domain::ext::ExtError;
use mixdog_core_api::domain::ext::PdfIntake;
use mixdog_core_api::domain::mock::MockOwnership;
use mixdog_core_session::session::StoreThreads;
use mixdog_migrate::durable;
use mixdog_migrate::framework::MigrationRoots;
use mixdog_migrate::index::IndexProjector;
use mixdog_migrate::run::MigrateOptions;
use mixdog_migrate::run::Migrator;
use mixdog_migrate::run::product_drivers;
use mixdog_migrate::session::context_blobs::OfficeExtractor;
use mixdog_protocol::ThreadId;

struct NoDocuments;

#[async_trait]
impl DocumentText for NoDocuments {
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

struct StoreProjector;

impl IndexProjector for StoreProjector {
    fn project(&self, data: &Path, db: &Path, sessions: &[String]) -> Result<(), String> {
        mixdog_store::sqlite::project_index(data, db, sessions)
    }
}

fn copy_tree(from: &Path, to: &Path) {
    for rel in durable::walk_files(from).expect("walk the recording") {
        let target = to.join(&rel);
        durable::create_dir_all(target.parent().expect("a file has a parent")).expect("dir");
        durable::write_synced(&target, &durable::read(&from.join(&rel)).expect("read")).expect("copy");
    }
}

/// A recorded `.mixdog` (and its desktop `profile`, when the recording has one) copied to a scratch directory and migrated, as
/// the core does at its first start.
pub(super) async fn migrated_from(recording: &Path) -> (tempfile::TempDir, MigrationRoots) {
    let dir = tempfile::tempdir().expect("scratch dir");
    let home = dir.path().join(".mixdog");
    copy_tree(&recording.join(".mixdog"), &home);
    let profile = recording.join("profile").exists().then(|| {
        let profile = dir.path().join("profile");
        copy_tree(&recording.join("profile"), &profile);
        profile
    });
    let roots = MigrationRoots { data: home.join("data"), home, profile };
    let office = OfficeExtractor { docs: Arc::new(NoDocuments), runtime: tokio::runtime::Handle::current() };
    Migrator::new(roots.clone(), product_drivers(Arc::new(StoreProjector), office), MigrateOptions::default())
        .run()
        .expect("the migration of the recorded data completes");
    (dir, roots)
}

/// The migrated directory's index and thread store, as the core opens them.
pub(super) async fn opened(roots: &MigrationRoots) -> (mixdog_store::sqlite::SqliteStore, Arc<StoreThreads>) {
    let tokens = mixdog_rt::testing::tokens();
    let root = roots.data.clone();
    let index = mixdog_rt::LaneToken::submit(tokens.maintenance_io, &mixdog_rt::CancellationToken::new(), move |lane| {
        mixdog_store::sqlite::SqliteStore::open(lane, tokens.sqlite_writer_thread, tokens.interactive_io, &root)
    })
    .expect("lane")
    .await
    .expect("job ran")
    .expect("index");
    let threads = StoreThreads::over_data_dir(&roots.data, index.clone(), Arc::new(MockOwnership::default()), tokens.maintenance_io).await.expect("thread store");
    (index, Arc::new(threads))
}
