//! The `memory` tool against the goldens recorded from the previous product.

use std::sync::atomic::AtomicU64;

use regex::Regex;
use serde_json::{Value, json};

use crate::memory::core::action::{CoreContext, run};
use crate::memory::pg::db::Schema;
use crate::memory::schema::ensure_memory_schema;
use crate::memory::tests::support::TestPg;

fn golden(text: &'static str) -> Value {
    serde_json::from_str(text).expect("golden parses")
}

fn scrub(text: &str) -> String {
    Regex::new(r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}")
        .expect("uuid pattern")
        .replace_all(text, "<UUID>")
        .into_owned()
}

#[tokio::test(flavor = "multi_thread")]
#[ignore = "integration: needs a bundled Postgres runtime (MIXDOG_PG_RUNTIME)"]
async fn memory_tool_matches_recorded_goldens() {
    let pg = TestPg::start().await;
    let db = pg.db(Schema::Memory).await;
    ensure_memory_schema(&db, 384, &json!({ "model": "test", "dtype": "q8" })).await.expect("schema");
    let revision = AtomicU64::new(0);
    let data_dir = pg.dir.path().join("data");
    let ctx = CoreContext { db: &db, data_dir: &data_dir, session_cwd: None, snapshot_revision: &revision, lane: mixdog_rt::testing::tokens().durability_io };

    let cases = [
        golden(include_str!("../../../../../fixtures/tools/memory/list-empty.json")),
        golden(include_str!("../../../../../fixtures/tools/memory/add.json")),
        golden(include_str!("../../../../../fixtures/tools/memory/list-after-add.json")),
        golden(include_str!("../../../../../fixtures/tools/memory/error-edit-missing.json")),
        golden(include_str!("../../../../../fixtures/tools/memory/error-bad-op.json")),
    ];
    for case in cases {
        let reply = run(&ctx, &case["input"]).await;
        assert_eq!(scrub(&reply.envelope()), case["text"].as_str().expect("golden text"), "input {}", case["input"]);
        let recorded_error = serde_json::from_str::<Value>(case["text"].as_str().expect("text"))
            .expect("envelope json")["isError"]
            .as_bool()
            .expect("isError");
        assert_eq!(reply.is_error, recorded_error);
    }
}

/// memory-cycle-status.test.mjs: `action:"status"` reports the cycle1 backlog and the last run,
/// through the tool's route and the module's alike.
#[tokio::test(flavor = "multi_thread")]
#[ignore = "integration: needs a bundled Postgres runtime (MIXDOG_PG_RUNTIME)"]
async fn status_reports_the_backlog_and_the_last_cycle1_run() {
    use std::sync::Arc;

    use crate::memory::ingest::SessionIngest;
    use crate::memory::ingest::embed_flush::RawEmbedFlush;
    use crate::memory::recall::period::Clock;
    use crate::memory::recall::{Recall, RecallDeps};
    use crate::memory::service::{LocalMemory, MemoryModule};

    let pg = TestPg::start().await;
    let db = pg.db(Schema::Memory).await;
    ensure_memory_schema(&db, 384, &json!({ "model": "test", "dtype": "q8" })).await.expect("schema");
    for i in 0..10 {
        db.execute(
            "INSERT INTO entries (ts, role, content, source_ref, is_root) VALUES ($1, 'user', 'x', $2, $3)",
            &[&(i as i64), &format!("ref-{i}"), &i16::from(i < 4)],
        )
        .await
        .unwrap();
    }
    db.batch("UPDATE entries SET chunk_root = id WHERE is_root = 1").await.unwrap();
    let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_millis() as i64;
    db.execute("INSERT INTO meta (key, value) VALUES ('state.cycle_last_run', $1)", &[&json!({ "cycle1": now })]).await.unwrap();
    let lane = mixdog_rt::testing::tokens().durability_io;
    let recall = Recall::new(RecallDeps {
        db: db.clone(),
        clock: Arc::new(move || Clock { now_ms: now, zone: chrono_tz::Asia::Seoul }),
        embedder: None,
        session_cwd: None,
        lane,
        estimate_tokens: Arc::new(mixdog_js::token_estimate::estimate_tokens),
        trace: None,
    });
    let ingest = SessionIngest::new(db.clone(), Arc::new(RawEmbedFlush::new(db.clone(), None)), None, Arc::new(move || now), lane);
    let memory = LocalMemory::new(db, pg.dir.path().join("data"), recall, ingest, lane);

    let reply = memory.memory_reply(&json!({ "action": "status", "memory_caller": { "kind": "human" } })).await;
    assert!(!reply.is_error, "{}", reply.text);
    for line in ["entries: total=10 roots=4 cycle1_raw=6 (unchunked leaves)", "embedding_index: ready dims=384", "bootstrap: complete", "last_cycle1: 0m ago"] {
        assert!(reply.text.lines().any(|l| l == line), "{line} in {}", reply.text);
    }
    assert_eq!(memory.memory(json!({ "action": "status" })).await, reply.text, "the module answers the same readout");
}

#[tokio::test(flavor = "multi_thread")]
#[ignore = "integration: needs a bundled Postgres runtime (MIXDOG_PG_RUNTIME)"]
async fn edit_and_delete_follow_the_listed_revision() {
    let pg = TestPg::start().await;
    let db = pg.db(Schema::Memory).await;
    ensure_memory_schema(&db, 384, &json!({ "model": "test", "dtype": "q8" })).await.expect("schema");
    let revision = AtomicU64::new(0);
    let data_dir = pg.dir.path().join("data");
    let ctx = CoreContext { db: &db, data_dir: &data_dir, session_cwd: None, snapshot_revision: &revision, lane: mixdog_rt::testing::tokens().durability_io };

    run(&ctx, &json!({ "op": "add", "summary": "first standing rule" })).await;
    run(&ctx, &json!({ "op": "add", "summary": "second standing rule" })).await;
    let listed = run(&ctx, &json!({ "op": "list" })).await;
    let page: Value = serde_json::from_str(&listed.envelope()).expect("envelope");
    let revision_1 = page["entries"][0]["index_revision"].as_str().expect("revision").to_owned();

    let edited = run(&ctx, &json!({ "op": "edit", "id": 1, "index_revision": revision_1, "summary": "first standing rule, revised" })).await;
    assert!(!edited.is_error, "{}", edited.text);
    // The edit kept the pool's membership, so the listed revision still names it.
    let deleted = run(&ctx, &json!({ "op": "delete", "id": 2, "index_revision": revision_1 })).await;
    assert!(!deleted.is_error, "{}", deleted.text);
    assert!(deleted.text.starts_with("core deleted (project=COMMON id=2): second standing rule"));
    // Membership changed: the old revision is refused.
    let stale = run(&ctx, &json!({ "op": "delete", "id": 1, "index_revision": revision_1 })).await;
    assert_eq!(stale.text, "core delete failed: memory indices changed; list memories again before editing or deleting");

    let snapshot = crate::memory::core::snapshot::read(mixdog_rt::testing::tokens().durability_io, &data_dir).await.expect("snapshot written");
    let payload = crate::memory::core::snapshot::session_payload(&snapshot, None, "");
    assert_eq!(payload.user_lines, vec!["first standing rule, revised".to_owned()]);
}
