//! Golden: every migrated corpus session sends the system messages Node sends after loading it
//! (`vectors/request_system_*.json`, from `vectors/request_system_corpus.mjs` over Node's own
//! `loadSession`), and keeps none of them as a row. The corpus is migrated with the product
//! drivers; the request's system messages are read from the stored header the one way every
//! provider request reads them (`request_system_messages`).

#![allow(
    clippy::disallowed_methods,
    clippy::disallowed_types,
    reason = "the golden copies the corpus with blocking std::fs before reading it through the store"
)]

use std::path::Path;
use std::path::PathBuf;
use std::sync::Arc;

use mixdog_core::prompt::blocks::request_system_messages;
use mixdog_core_api::domain::ext::DocumentText;
use mixdog_core_api::domain::ext::ExtError;
use mixdog_core_api::domain::ext::PdfIntake;
use mixdog_core_api::domain::provider::CacheTier;
use mixdog_core_api::domain::provider::Content;
use mixdog_migrate::framework::MigrationRoots;
use mixdog_migrate::index::IndexProjector;
use mixdog_migrate::run::MigrateOptions;
use mixdog_migrate::run::Migrator;
use mixdog_migrate::run::product_drivers;
use mixdog_migrate::session::context_blobs::OfficeExtractor;
use mixdog_protocol::ThreadId;
use mixdog_rt::CancellationToken;
use mixdog_rt::LaneToken;
use mixdog_rt::testing::tokens;
use mixdog_store::blobs::BlobStore;
use mixdog_store::context::ContextBlobs;
use mixdog_store::context::decode_context;
use mixdog_store::context::finish_context;
use mixdog_store::context::read_context_blobs;
use mixdog_store::fold::LineageIndex;
use mixdog_store::log::open_log;
use mixdog_store::schema::record::Header;
use mixdog_store::sqlite::LineageLevel;
use mixdog_store::sqlite::SqliteStore;
use serde_json::Value;
use serde_json::json;
use sha2::Digest as _;

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

fn corpus() -> PathBuf {
    std::env::var_os("MIXDOG_MIGRATION_CORPUS")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from(r"C:\Users\tempe\.mixdog\data\scratch\rust-core\migration-corpus"))
}

fn copy_tree(from: &Path, to: &Path) {
    for rel in mixdog_migrate::durable::walk_files(from).unwrap() {
        let dst = to.join(&rel);
        std::fs::create_dir_all(dst.parent().unwrap()).unwrap();
        std::fs::copy(from.join(&rel), dst).unwrap();
    }
    std::fs::create_dir_all(to).unwrap();
}

/// `request_system_corpus.mjs`'s view of one request system message.
fn view(tier: Option<CacheTier>, text: &str) -> Value {
    let tier = match tier {
        None => Value::Null,
        Some(CacheTier::Tier3) => json!("tier3"),
        Some(CacheTier::Env) => json!("env"),
    };
    let sha: String = sha2::Sha256::digest(text.as_bytes()).iter().map(|b| format!("{b:02x}")).collect();
    json!({"cacheTier": tier, "length": text.encode_utf16().count(), "sha256": sha})
}

/// The session's folded header and lineage, from its log's `session` frame down.
async fn open(sessions: &Path, data: &Path, store: &SqliteStore, id: &str) -> (Header, Vec<LineageLevel>, Option<u64>) {
    let mut levels = vec![LineageLevel { session: id.to_owned(), end: None }];
    let (mut header, mut cut) = (Header::new(), None);
    let mut next = Some(id.to_owned());
    while let Some(s) = next.take() {
        let (dir, blobs, index) = (sessions.join(&s), BlobStore::new(data), store.clone());
        let opened = tokens()
            .interactive_io
            .submit(&CancellationToken::new(), move |l| open_log(l, &dir, &blobs, &index as &dyn LineageIndex).unwrap())
            .unwrap()
            .await
            .unwrap();
        if s == id {
            header = opened.fold.header.clone();
            cut = opened.fold.base_cut;
        }
        if let Some(base) = &opened.fold.base {
            levels.push(LineageLevel { session: base.session.as_str().to_owned(), end: Some(base.end_ordinal_exclusive) });
            next = Some(base.session.as_str().to_owned());
        }
    }
    (header, levels, cut)
}

/// Roles of the session's model context, through the store's lane steps.
async fn context_roles(sessions: &Path, data: &Path, store: &SqliteStore, levels: Vec<LineageLevel>, cut: Option<u64>) -> Vec<Option<String>> {
    let (io, cpu) = (tokens().interactive_io, tokens().cpu_interactive);
    let mut roles = Vec::new();
    let mut cursor = None;
    loop {
        let (store, sessions, lv) = (store.clone(), sessions.to_path_buf(), levels.clone());
        let page = io
            .submit(&CancellationToken::new(), move |l| store.context_page_on_lane(l, &sessions, &lv, cut, cursor, 64))
            .unwrap()
            .await
            .unwrap()
            .unwrap();
        let decoded = cpu.submit(&CancellationToken::new(), move |l| decode_context(l, page)).unwrap().await.unwrap().unwrap();
        let next = decoded.next;
        let (decoded, blobs) = if decoded.needs_blobs() {
            let store = BlobStore::new(data);
            io.submit(&CancellationToken::new(), move |l| {
                let b = read_context_blobs(l, &store, &decoded).unwrap();
                (decoded, b)
            })
            .unwrap()
            .await
            .unwrap()
        } else {
            (decoded, ContextBlobs::default())
        };
        let messages = cpu.submit(&CancellationToken::new(), move |l| finish_context(l, decoded, blobs)).unwrap().await.unwrap().unwrap();
        roles.extend(messages.into_iter().map(|m| m.body.get("role").and_then(Value::as_str).map(str::to_owned)));
        match next {
            Some(c) => cursor = Some(c),
            None => return roles,
        }
    }
}

async fn golden(scenario: &str, vectors: &str) {
    let want: serde_json::Map<String, Value> = serde_json::from_str(vectors).unwrap();
    assert!(!want.is_empty(), "{scenario}: no vectors");
    let dir = tempfile::tempdir().unwrap();
    let roots = MigrationRoots { data: dir.path().join("data"), home: dir.path().join("home"), profile: None };
    copy_tree(&corpus().join(scenario), &roots.data);
    copy_tree(&corpus().join("home"), &roots.home);
    let office = OfficeExtractor { docs: Arc::new(NoDocuments), runtime: tokio::runtime::Handle::current() };
    Migrator::new(roots.clone(), product_drivers(Arc::new(StoreProjector), office), MigrateOptions::default()).run().unwrap();
    let data = roots.data.clone();
    let store = tokens()
        .maintenance_io
        .submit(&CancellationToken::new(), move |lane| {
            SqliteStore::open(lane, tokens().sqlite_writer_thread, tokens().interactive_io, &data)
        })
        .unwrap()
        .await
        .unwrap()
        .unwrap();
    let sessions = roots.data.join("sessions");
    let mut bad = Vec::new();
    for (id, w) in &want {
        let (header, levels, cut) = open(&sessions, &roots.data, &store, id).await;
        let have: Vec<Value> = request_system_messages(&header)
            .into_iter()
            .map(|m| match &m.content {
                Content::Text(text) => view(m.cache_tier, text),
                other => panic!("{id}: a system message is text, not {other:?}"),
            })
            .collect();
        if &Value::Array(have.clone()) != w {
            bad.push(format!("{scenario}/{id}: want {w} have {}", Value::Array(have)));
        }
        let roles = context_roles(&sessions, &roots.data, &store, levels, cut).await;
        if let Some(at) = roles.iter().position(|role| role.as_deref() == Some("system")) {
            bad.push(format!("{scenario}/{id}: context row {at} is a system message"));
        }
    }
    assert!(bad.is_empty(), "{} sessions differ:\n{}", bad.len(), bad.join("\n"));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "release gate over the migration corpus (MIXDOG_MIGRATION_CORPUS)"]
async fn request_system_messages_match_node_v145() {
    golden("v145", include_str!("vectors/request_system_v145.json")).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "release gate over the migration corpus (MIXDOG_MIGRATION_CORPUS)"]
async fn request_system_messages_match_node_dev146() {
    golden("dev146", include_str!("vectors/request_system_dev146.json")).await;
}
