//! The harness of the upgrade-chain tests: a small 1.4.5 data directory written by hand (`v145_dir_at`), the migrator over
//! it with the store's own catalog projector, and the digest of what a start leaves.

#![allow(
    dead_code,
    reason = "each test binary that includes this harness uses part of it"
)]
#![allow(
    clippy::disallowed_methods,
    clippy::disallowed_types,
    reason = "test fixtures build and inspect data dirs with blocking std::fs"
)]

use std::collections::BTreeMap;
use std::path::Path;
use std::sync::Arc;

use mixdog_core_api::domain::ext::DocumentText;
use mixdog_core_api::domain::ext::ExtError;
use mixdog_core_api::domain::ext::PdfIntake;
use mixdog_migrate::durable;
use mixdog_migrate::framework::MigrationRoots;
use mixdog_migrate::index::IndexProjector;
use mixdog_migrate::run::MigrateOptions;
use mixdog_migrate::run::Migrator;
use mixdog_migrate::run::product_drivers;
use mixdog_migrate::session::context_blobs::OfficeExtractor;
use mixdog_protocol::ThreadId;

/// The data holds no office document: the extractor is never asked.
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

/// The store's own catalog projector, as `mixdogd migrate` runs it.
struct StoreProjector;

impl IndexProjector for StoreProjector {
    fn project(&self, data: &Path, db: &Path, sessions: &[String]) -> Result<(), String> {
        mixdog_store::sqlite::project_index(data, db, sessions)
    }
}

/// `<root>/.mixdog/data` is the data directory, `<root>/.mixdog` the home.
pub fn roots_at(root: &Path) -> MigrationRoots {
    let home = root.join(".mixdog");
    MigrationRoots { data: home.join("data"), home, profile: None }
}

fn runtime() -> &'static tokio::runtime::Runtime {
    static RUNTIME: std::sync::LazyLock<tokio::runtime::Runtime> =
        std::sync::LazyLock::new(|| tokio::runtime::Builder::new_current_thread().build().expect("a runtime"));
    &RUNTIME
}

pub fn migrator(roots: &MigrationRoots, options: MigrateOptions) -> Migrator {
    let office = OfficeExtractor { docs: Arc::new(NoDocs), runtime: runtime().handle().clone() };
    Migrator::new(roots.clone(), product_drivers(Arc::new(StoreProjector), office), options)
}

/// Paths (relative to the home) and SHA-256 of every file the migration left, its journal included.
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

/// One session record as 1.4.5's `buildSessionRecord` and the session store left it (`session-record.mjs`,
/// `session-crud.mjs`): the record's own fields, every message stamped with the `meta.transcript` (`at`, `messageId`)
/// 1.4.5's transcript stamps on each message it persists, system messages included.
pub fn v145_record(id: &str, title: &str, messages: Vec<serde_json::Value>) -> serde_json::Value {
    let messages: Vec<serde_json::Value> = messages
        .into_iter()
        .enumerate()
        .map(|(i, mut message)| {
            message["meta"] = serde_json::json!({"transcript": {"at": 1_730_000_000_000_u64 + 1000 * i as u64, "messageId": format!("msg_{id}_{i}")}});
            message
        })
        .collect();
    serde_json::json!({
        "id": id, "title": title, "provider": "openai", "model": "gpt-test", "cwd": "/work/p", "owner": "user", "lane": "agent",
        "generation": 0, "closed": false, "status": "idle", "bp3EnvSplit": true,
        "createdAt": 1_730_000_000_000_u64, "updatedAt": 1_730_000_100_000_u64, "lastUsedAt": 1_730_000_100_000_u64,
        "messages": messages
    })
}

/// `<data>/sessions/<id>.json`, as 1.4.5's saver wrote it.
pub fn write_v145_session(data: &Path, record: &serde_json::Value) {
    let path = data.join("sessions").join(format!("{}.json", record["id"].as_str().expect("an id")));
    std::fs::create_dir_all(path.parent().expect("a file has a parent")).expect("dir");
    std::fs::write(path, record.to_string()).expect("write");
}

/// `<data>/usage/ledger.sqlite` as 1.4.5 left it: exactly the objects 1.4.5 created, holding three requests of two days
/// (2026-11-04: sessions `a` and `b`; 2026-11-05: `a`), each of 10 input, 5 output, 1 cache read, 2 cache write, $0.50.
pub fn write_v145_ledger(data: &Path) {
    let path = data.join("usage/ledger.sqlite");
    std::fs::create_dir_all(path.parent().expect("a file has a parent")).expect("dir");
    let conn = mixdog_ledger::db::Connection::open(&path).expect("open");
    conn.execute_batch(mixdog_store::schema::sql::LEDGER_V2_BASE).expect("1.4.5 schema");
    conn.pragma_update(None, "user_version", 2).expect("version");
    conn.execute("INSERT INTO usage_sessions(value) VALUES ('a'),('b')", []).expect("sessions");
    conn.execute("INSERT INTO usage_routes(signature) VALUES ('[\"p\",\"m\",\"k\",\"s\",\"provider\",null,\"live\",0]')", []).expect("route");
    conn.execute("INSERT INTO daily VALUES ('2026-11-04', 0, 'p', 'm', 'k', 's', 0, 2, 20, 10, 2, 4, 1.0, 200, 0)", []).expect("day");
    conn.execute("INSERT INTO daily VALUES ('2026-11-05', 0, 'p', 'm', 'k', 's', 0, 1, 10, 5, 1, 2, 0.5, 100, 0)", []).expect("day");
    for (id, ts, day, session) in [(1u8, 1_793_750_000_000_i64, 20_261_104, 1), (2, 1_793_800_000_000, 20_261_104, 2), (3, 1_793_880_000_000, 20_261_105, 1)] {
        conn.execute("INSERT INTO usage_events VALUES (?1, ?2, ?3, 1, ?4, 10, 5, 1, 2, 0.5, 100)", rusqlite::params![vec![id; 16], ts, day, session]).expect("event");
    }
}

/// A 1.4.5 data directory under `root`: a session with its messages, the settings, the client-version file and the
/// project registry.
pub fn v145_dir_at(root: &Path) -> MigrationRoots {
    let roots = roots_at(root);
    let write = |dir: &Path, rel: &str, text: &str| {
        let path = dir.join(rel);
        std::fs::create_dir_all(path.parent().expect("a file has a parent")).expect("dir");
        std::fs::write(path, text).expect("write");
    };
    let messages = vec![serde_json::json!({"role": "user", "content": "hi"}), serde_json::json!({"role": "assistant", "content": "hello"})];
    write_v145_session(&roots.data, &v145_record("sess_a", "A", messages));
    write(&roots.data, "mixdog-config.json", r#"{"agent":{"other":1}}"#);
    write(&roots.data, "client-versions.json", "{}");
    write(&roots.home, "projects.json", "{}");
    roots
}
