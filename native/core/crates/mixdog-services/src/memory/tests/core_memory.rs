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

/// core-memory-uniqueness.test.mjs: start-up keeps conflicting rows, then installs the pool key
/// and drops the legacy (project_id, element) key, so an agent memory may share a common element;
/// a write racing the conflict check defers the index instead of failing start-up.
#[tokio::test(flavor = "multi_thread")]
#[ignore = "integration: needs a bundled Postgres runtime (MIXDOG_PG_RUNTIME)"]
async fn the_legacy_key_is_dropped_and_a_racing_conflict_defers_the_index() {
    const INSERT: &str = "INSERT INTO core_entries (element, summary, category, project_id, agent_id, created_at, updated_at) VALUES ($1, $2, 'rule', NULL, $3, 0, 0)";
    let identity = json!({ "model": "test", "dtype": "q8" });
    let pg = TestPg::start().await;
    let db = pg.db(Schema::Memory).await;
    ensure_memory_schema(&db, 384, &identity).await.expect("schema");
    let indexes = || async {
        let rows = db.query("SELECT indexname FROM pg_indexes WHERE tablename = 'core_entries' AND indexname LIKE 'core_entries_unique_%' ORDER BY 1", &[]).await.unwrap();
        rows.iter().map(|row| row.get::<_, String>(0)).collect::<Vec<_>>()
    };
    let rows = || async { db.query("SELECT id, element, summary FROM core_entries ORDER BY id", &[]).await.unwrap().iter().map(|r| (r.get::<_, i64>(0), r.get::<_, String>(1), r.get::<_, String>(2))).collect::<Vec<_>>() };

    // A store an old build left: duplicate common keys and the legacy key without the pool key.
    db.batch("DROP INDEX core_entries_unique_pool_elem").await.unwrap();
    db.execute(INSERT, &[&"key", &"First approved preference", &None::<String>]).await.unwrap();
    db.execute(INSERT, &[&"key", &"Second approved preference", &None::<String>]).await.unwrap();
    db.batch("CREATE UNIQUE INDEX core_entries_unique_proj_elem ON core_entries (project_id, (element || id::text))").await.unwrap();
    let before = rows().await;
    ensure_memory_schema(&db, 384, &identity).await.expect("conflicts never fail start-up");
    assert_eq!(rows().await, before, "no winner is chosen");
    assert_eq!(indexes().await, vec!["core_entries_unique_proj_elem".to_owned()]);

    db.execute("UPDATE core_entries SET element = 'resolved' WHERE id = $1", &[&before[1].0]).await.unwrap();
    db.batch("DROP INDEX core_entries_unique_proj_elem; CREATE UNIQUE INDEX core_entries_unique_proj_elem ON core_entries (project_id, element)").await.unwrap();
    ensure_memory_schema(&db, 384, &identity).await.expect("schema");
    assert_eq!(indexes().await, vec!["core_entries_unique_pool_elem".to_owned()], "the pool key replaces the project key");
    db.execute(INSERT, &[&"key", &"An agent may share the key", &Some("reviewer".to_owned())]).await.expect("an agent memory shares a common element");

    // A duplicate committed between the conflict check and the index build.
    db.batch("DROP INDEX core_entries_unique_pool_elem").await.unwrap();
    let mut writer = db.client().await.unwrap();
    let racing = writer.transaction().await.unwrap();
    racing.execute(INSERT, &[&"key", &"Racing duplicate", &None::<String>]).await.unwrap();
    // The key step alone: the DDL before it would wait on the open write before the check runs.
    let start = tokio::spawn({
        let db = pg.db(Schema::Memory).await;
        async move { crate::memory::schema::install_core_key_index(&db).await }
    });
    tokio::time::timeout(std::time::Duration::from_secs(20), async {
        while db.query_opt("SELECT 1 FROM pg_stat_activity WHERE wait_event_type = 'Lock' AND query LIKE '%CREATE UNIQUE INDEX%core_entries_unique_pool_elem%'", &[]).await.unwrap().is_none() {
            tokio::time::sleep(std::time::Duration::from_millis(20)).await;
        }
    })
    .await
    .expect("the index build waits behind the racing write");
    racing.commit().await.unwrap();
    start.await.unwrap().expect("a racing unique violation defers the index");
    assert!(indexes().await.is_empty(), "the index waits for an explicit resolution");
    assert_eq!(rows().await.len(), 4, "both racing rows are kept");
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
