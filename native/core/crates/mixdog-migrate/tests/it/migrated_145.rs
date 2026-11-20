//! What a migrated 1.4.5 session gives back: the system messages its first request carries, the rows of its model
//! context (the system prefix is the header's prompt blocks, never a row), and what the catalog lists. The data directory
//! is written here in the formats 1.4.5 wrote.

#![allow(clippy::disallowed_methods, clippy::disallowed_types, reason = "the data directory is written with blocking std::fs before the store reads it")]

use std::path::Path;

use mixdog_core_api::domain::provider::CacheTier;
use mixdog_core_api::domain::provider::Content;
use mixdog_core_prompt::prompt::blocks::request_system_messages;
use mixdog_migrate::run::MigrateOptions;
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

use crate::profile_harness::*;

fn system(text: &str, tier: Option<&str>) -> Value {
    let mut message = json!({"role": "system", "content": text});
    if let Some(tier) = tier {
        message["cacheTier"] = json!(tier);
    }
    message
}

/// A session of 1.4.5 that split its environment from its core (`bp3EnvSplit`), with two turns.
fn write_session(data: &Path) {
    let messages = vec![
        system("rules", None),
        system("stable", None),
        system("core", Some("tier3")),
        system("env", Some("env")),
        json!({"role": "user", "content": "first question"}),
        json!({"role": "assistant", "content": "first answer"}),
        json!({"role": "user", "content": "second question"}),
    ];
    write_v145_session(data, &v145_record("sess_a", "A", messages));
}

async fn open_store(data: &Path) -> SqliteStore {
    let data = data.to_path_buf();
    tokens()
        .maintenance_io
        .submit(&CancellationToken::new(), move |lane| SqliteStore::open(lane, tokens().sqlite_writer_thread, tokens().interactive_io, &data))
        .unwrap()
        .await
        .unwrap()
        .unwrap()
}

async fn header_of(data: &Path, store: &SqliteStore, id: &str) -> Header {
    let (dir, blobs, index) = (data.join("sessions").join(id), BlobStore::new(data), store.clone());
    let opened = tokens()
        .interactive_io
        .submit(&CancellationToken::new(), move |l| open_log(l, &dir, &blobs, &index as &dyn LineageIndex).unwrap())
        .unwrap()
        .await
        .unwrap();
    opened.fold.header.clone()
}

/// The model context of `id` as (role, whole message body) rows, read through the store's lane steps in pages of two.
async fn context_rows(data: &Path, store: &SqliteStore, id: &str) -> Vec<(String, Value)> {
    let (io, cpu) = (tokens().interactive_io, tokens().cpu_interactive);
    let sessions = data.join("sessions");
    let levels = vec![LineageLevel { session: id.to_owned(), end: None }];
    let mut rows = Vec::new();
    let mut cursor = None;
    loop {
        let (store, sessions, lv) = (store.clone(), sessions.clone(), levels.clone());
        let page =
            io.submit(&CancellationToken::new(), move |l| store.context_page_on_lane(l, &sessions, &lv, None, cursor, 2)).unwrap().await.unwrap().unwrap();
        let decoded = cpu.submit(&CancellationToken::new(), move |l| decode_context(l, page)).unwrap().await.unwrap().unwrap();
        let next = decoded.next;
        let (decoded, blobs) = if decoded.needs_blobs() {
            let blob_store = BlobStore::new(data);
            io.submit(&CancellationToken::new(), move |l| {
                let b = read_context_blobs(l, &blob_store, &decoded).unwrap();
                (decoded, b)
            })
            .unwrap()
            .await
            .unwrap()
        } else {
            (decoded, ContextBlobs::default())
        };
        let messages = cpu.submit(&CancellationToken::new(), move |l| finish_context(l, decoded, blobs)).unwrap().await.unwrap().unwrap();
        rows.extend(messages.into_iter().map(|m| (m.body["role"].as_str().unwrap().to_owned(), m.body.clone())));
        match next {
            Some(c) => cursor = Some(c),
            None => return rows,
        }
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_migrated_session_sends_its_system_prefix_from_the_header_and_keeps_no_system_row() {
    let dir = tempfile::tempdir().unwrap();
    let roots = roots_at(dir.path());
    write_session(&roots.data);
    migrator(&roots, MigrateOptions::default()).run().expect("the migration completes");

    let store = open_store(&roots.data).await;
    let header = header_of(&roots.data, &store, "sess_a").await;
    let sent: Vec<(Option<CacheTier>, Content)> = request_system_messages(&header).into_iter().map(|m| (m.cache_tier, m.content)).collect();
    assert_eq!(
        sent,
        [
            (None, Content::Text("rules".into())),
            (None, Content::Text("stable".into())),
            (Some(CacheTier::Tier3), Content::Text("core".into())),
            (Some(CacheTier::Env), Content::Text("env".into())),
        ]
    );

    let rows = context_rows(&roots.data, &store, "sess_a").await;
    let roles: Vec<&str> = rows.iter().map(|(role, _)| role.as_str()).collect();
    assert_eq!(roles, ["user", "assistant", "user"], "the system prefix is not a row");
    assert!(rows[0].1.to_string().contains("first question"), "{:?}", rows[0]);
    assert!(rows[1].1.to_string().contains("first answer"), "{:?}", rows[1]);
    assert!(rows[2].1.to_string().contains("second question"), "{:?}", rows[2]);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_session_without_the_split_flag_keeps_one_combined_environment_message() {
    let dir = tempfile::tempdir().unwrap();
    let roots = roots_at(dir.path());
    let messages =
        vec![system("rules", None), system("stable", None), system("core\n\n---\n\n- Cwd: C:/p", Some("tier3")), json!({"role": "user", "content": "hi"})];
    let mut record = v145_record("sess_b", "B", messages);
    let fields = record.as_object_mut().unwrap();
    fields.remove("bp3EnvSplit");
    fields.insert("bp3CoreContext".into(), json!("core"));
    fields.insert("bp3EnvironmentContext".into(), json!("- Cwd: C:/p"));
    write_v145_session(&roots.data, &record);
    migrator(&roots, MigrateOptions::default()).run().expect("the migration completes");

    let store = open_store(&roots.data).await;
    let header = header_of(&roots.data, &store, "sess_b").await;
    assert!(header.get("bp3EnvSplit").is_none(), "the flag stays absent");
    let sent = request_system_messages(&header);
    assert_eq!(sent.len(), 3);
    assert_eq!(sent[2].cache_tier, Some(CacheTier::Tier3));
    assert_eq!(sent[2].content, Content::Text("core\n\n---\n\n- Cwd: C:/p".into()));
    let rows = context_rows(&roots.data, &store, "sess_b").await;
    assert_eq!(rows.len(), 1);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_migrated_tool_round_reads_back_in_order_with_its_result_paired() {
    let dir = tempfile::tempdir().unwrap();
    let roots = roots_at(dir.path());
    let messages = vec![
        system("rules", None),
        json!({"role": "user", "content": "read the file"}),
        json!({"role": "assistant", "content": "", "toolCalls": [{"id": "call_1", "name": "read", "arguments": {"path": "a.txt"}}]}),
        json!({"role": "tool", "toolCallId": "call_1", "content": "file text"}),
        json!({"role": "assistant", "content": "it says file text"}),
        json!({"role": "user", "content": "thanks"}),
    ];
    write_v145_session(&roots.data, &v145_record("sess_t", "T", messages));
    migrator(&roots, MigrateOptions::default()).run().expect("the migration completes");

    let store = open_store(&roots.data).await;
    let rows = context_rows(&roots.data, &store, "sess_t").await;
    let roles: Vec<&str> = rows.iter().map(|(role, _)| role.as_str()).collect();
    assert_eq!(roles, ["user", "assistant", "tool", "assistant", "user"], "pages of two rejoin in the order 1.4.5 wrote");
    assert!(rows[1].1["toolCalls"].to_string().contains("call_1"), "the call is in the assistant row's toolCalls: {:?}", rows[1]);
    assert_eq!(rows[2].1["toolCallId"], "call_1", "the result names the call it answers: {:?}", rows[2]);
    assert!(rows[2].1["content"].to_string().contains("file text"), "the result: {:?}", rows[2]);
    assert!(rows[3].1.to_string().contains("it says file text"), "{:?}", rows[3]);
}

/// The ledger 1.4.5 left is the one the core reads: its requests are kept and its statistics answer from them.
struct NoCatalog;

impl mixdog_ledger::refresh::Pricer for NoCatalog {
    fn revision(&self) -> String {
        String::new()
    }

    fn price(&self, _: &mixdog_ledger::repair::PriceRequest) -> mixdog_ledger::Result<mixdog_ledger::repair::Priced> {
        Ok(mixdog_ledger::repair::Priced { cost_usd: None, rates: None })
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn the_usage_ledger_of_a_145_directory_answers_its_statistics_after_migration() {
    let dir = tempfile::tempdir().unwrap();
    let roots = roots_at(dir.path());
    write_v145_session(&roots.data, &v145_record("sess_a", "A", vec![json!({"role": "user", "content": "hi"})]));
    write_v145_ledger(&roots.data);
    migrator(&roots, MigrateOptions::default()).run().expect("the migration completes");

    let tokens = tokens();
    let path = roots.data.join("usage").join("ledger.sqlite");
    let writer = mixdog_ledger::writer::UsageWriter::open(tokens.sqlite_writer_thread, tokens.maintenance_io, &path).expect("the migrated ledger opens");
    let reader = mixdog_ledger::reader::UsageReader::new(&path, tokens.interactive_io, tokens.maintenance_io);
    let refresher = mixdog_ledger::refresh::UsageRefresher::new(std::sync::Arc::new(NoCatalog), tokens.cpu_bulk);
    let ledger = mixdog_ledger::ledger::UsageLedger { writer, reader, refresher };
    let now = 1_793_900_000_000_i64;
    let options: mixdog_ledger::stats::UsageStatsOptions = serde_json::from_value(json!({"days": 30})).unwrap();
    let stats = ledger.get_usage_stats(options, || now).await.expect("usage stats");
    let totals = &stats["totals"];
    assert_eq!((&totals["turns"], &totals["tokens"], &totals["costUsd"]), (&json!(3), &json!(54), &json!(1.5)));
    assert_eq!(stats["range"]["activeDays"], json!(2));
}
