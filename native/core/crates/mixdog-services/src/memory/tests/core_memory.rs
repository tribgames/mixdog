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
    let ctx = CoreContext { db: &db, data_dir: &data_dir, session_cwd: None, snapshot_revision: &revision };

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

#[tokio::test(flavor = "multi_thread")]
#[ignore = "integration: needs a bundled Postgres runtime (MIXDOG_PG_RUNTIME)"]
async fn edit_and_delete_follow_the_listed_revision() {
    let pg = TestPg::start().await;
    let db = pg.db(Schema::Memory).await;
    ensure_memory_schema(&db, 384, &json!({ "model": "test", "dtype": "q8" })).await.expect("schema");
    let revision = AtomicU64::new(0);
    let data_dir = pg.dir.path().join("data");
    let ctx = CoreContext { db: &db, data_dir: &data_dir, session_cwd: None, snapshot_revision: &revision };

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

    let snapshot = crate::memory::core::snapshot::read(&data_dir).await.expect("snapshot written");
    let payload = crate::memory::core::snapshot::session_payload(&snapshot, None, "");
    assert_eq!(payload.user_lines, vec!["first standing rule, revised".to_owned()]);
}
