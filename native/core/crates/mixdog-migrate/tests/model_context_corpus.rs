//! Golden: the store's model-context read (`mixdog_store::context`) of every migrated
//! corpus session equals the context Node rebuilds for the next turn
//! (`vectors/model_context_corpus.json`, from `vectors/generate_context.mjs` over Node's own
//! record reader). The corpus is migrated with the product drivers and the store's own
//! index projector, then read through the four lane steps in small pages.

#![allow(
    clippy::disallowed_methods,
    clippy::disallowed_types,
    reason = "the golden copies the corpus with blocking std::fs before reading it through the store"
)]

use std::path::Path;
use std::path::PathBuf;
use std::sync::Arc;

use mixdog_migrate::framework::MigrationRoots;
use mixdog_migrate::index::IndexProjector;
use mixdog_migrate::json::js_stable;
use mixdog_migrate::run::MigrateOptions;
use mixdog_migrate::run::Migrator;
use mixdog_migrate::run::product_drivers;
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

fn sha(s: &str) -> String {
    sha2::Sha256::digest(s.as_bytes()).iter().map(|b| format!("{b:02x}")).collect()
}

/// `corpus-lib.cjs` `entry(m)`.
fn entry(m: &Value) -> Value {
    let calls: Vec<Value> = m
        .get("toolCalls")
        .and_then(Value::as_array)
        .map(|calls| {
            calls
                .iter()
                .map(|c| [c.get("id"), c.get("toolCallId")].into_iter().flatten().find(|v| !v.is_null()).cloned().unwrap_or(Value::Null))
                .collect()
        })
        .unwrap_or_default();
    let tool = m.get("toolCallId").filter(|v| !v.is_null()).cloned().unwrap_or(Value::Null);
    json!([m.get("role").cloned().unwrap_or(Value::Null), m.get("content").cloned().unwrap_or(Value::Null), tool, calls])
}

/// `generate_context.mjs` `unchanged(m)`.
fn unchanged(m: &Value) -> bool {
    m.get("role").and_then(Value::as_str) != Some("user") && m.get("reasoningItems").is_none() && m.get("thoughtParts").is_none()
}

/// The session's lineage, from its log's `session` frame down.
async fn lineage_of(sessions: &Path, data: &Path, store: &SqliteStore, id: &str) -> (Vec<LineageLevel>, Option<u64>) {
    let mut levels = vec![LineageLevel { session: id.to_owned(), end: None }];
    let mut cut = None;
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
            cut = opened.fold.base_cut;
        }
        if let Some(base) = &opened.fold.base {
            levels.push(LineageLevel { session: base.session.as_str().to_owned(), end: Some(base.end_ordinal_exclusive) });
            next = Some(base.session.as_str().to_owned());
        }
    }
    (levels, cut)
}

async fn model_context(sessions: &Path, data: &Path, store: &SqliteStore, levels: Vec<LineageLevel>, cut: Option<u64>) -> Vec<Value> {
    let (io, cpu) = (tokens().interactive_io, tokens().cpu_interactive);
    let mut out = Vec::new();
    let mut cursor = None;
    loop {
        let (store, sessions, lv) = (store.clone(), sessions.to_path_buf(), levels.clone());
        let page = io
            .submit(&CancellationToken::new(), move |l| store.context_page_on_lane(l, &sessions, &lv, cut, cursor, 7))
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
        out.extend(messages.into_iter().map(|m| m.body));
        match next {
            Some(c) => cursor = Some(c),
            None => return out,
        }
    }
}

async fn golden(scenario: &str, data_rel: &str) {
    let vectors: Value = serde_json::from_str(include_str!("vectors/model_context_corpus.json")).unwrap();
    let dir = tempfile::tempdir().unwrap();
    let roots = MigrationRoots { data: dir.path().join("data"), home: dir.path().join("home"), profile: None };
    copy_tree(&corpus().join(data_rel), &roots.data);
    copy_tree(&corpus().join("home"), &roots.home);
    Migrator::new(roots.clone(), product_drivers(Arc::new(StoreProjector)), MigrateOptions::default()).run().unwrap();
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
    let want = vectors[scenario].as_object().unwrap();
    assert!(!want.is_empty(), "{scenario}: no vectors");
    let mut bad = Vec::new();
    for (id, w) in want {
        let (levels, cut) = lineage_of(&sessions, &roots.data, &store, id).await;
        let messages = model_context(&sessions, &roots.data, &store, levels, cut).await;
        let entries = sha(&messages.iter().map(|m| js_stable(&entry(m))).collect::<Vec<_>>().join("\n"));
        let exact = sha(
            &messages
                .iter()
                .enumerate()
                .filter(|(_, m)| unchanged(m))
                .map(|(i, m)| format!("{i}:{}", js_stable(m)))
                .collect::<Vec<_>>()
                .join("\n"),
        );
        let have = json!({"count": messages.len(), "entries": entries, "exact": exact});
        if &have != w {
            bad.push(format!("{scenario}/{id}: want {w} have {have}"));
        }
    }
    assert!(bad.is_empty(), "{} sessions differ:\n{}", bad.len(), bad.join("\n"));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "release gate over the migration corpus (MIXDOG_MIGRATION_CORPUS)"]
async fn model_context_matches_node_v145() {
    golden("v145", "v145").await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "release gate over the migration corpus (MIXDOG_MIGRATION_CORPUS)"]
async fn model_context_matches_node_dev146() {
    golden("dev146", "dev146").await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "release gate over the migration corpus (MIXDOG_MIGRATION_CORPUS)"]
async fn model_context_matches_node_fixture_busy_seed() {
    golden("fixture-busy-seed", "fixture-busy-seed/data").await;
}
