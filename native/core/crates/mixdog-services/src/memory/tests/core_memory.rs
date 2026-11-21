//! The `memory` tool against the goldens recorded from the previous product.

use std::sync::atomic::AtomicU64;

use serde_json::{Value, json};

use crate::memory::core::action::{CoreContext, run};
use crate::memory::pg::db::Schema;
use crate::memory::schema::ensure_memory_schema;
use crate::memory::tests::support::TestPg;

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

    let revised = format!("{}Final condition.", "A durable instruction. ".repeat(10));
    let edited = run(&ctx, &json!({ "op": "edit", "id": 1, "index_revision": revision_1, "summary": revised })).await;
    assert!(!edited.is_error, "{}", edited.text);
    assert!(edited.text.contains("project=COMMON") && edited.text.ends_with(&revised), "{}", edited.text);
    // The edit kept the pool's membership, so the listed revision still names it.
    let deleted = run(&ctx, &json!({ "op": "delete", "id": 2, "index_revision": revision_1 })).await;
    assert!(!deleted.is_error, "{}", deleted.text);
    assert!(deleted.text.starts_with("core deleted (project=COMMON id=2): second standing rule"));
    // Membership changed: the old revision is refused.
    let stale = run(&ctx, &json!({ "op": "delete", "id": 1, "index_revision": revision_1 })).await;
    assert_eq!(stale.text, "core delete failed: memory indices changed; list memories again before editing or deleting");

    let snapshot = crate::memory::core::snapshot::read(mixdog_rt::testing::tokens().durability_io, &data_dir).await.expect("snapshot written");
    let payload = crate::memory::core::snapshot::session_payload(&snapshot, None, "");
    assert_eq!(payload.user_lines, vec![revised]);
}

#[tokio::test(flavor = "multi_thread")]
#[ignore = "integration: needs a bundled Postgres runtime (MIXDOG_PG_RUNTIME)"]
async fn a_cancelled_delete_waiting_on_a_row_lock_does_not_commit() {
    use crate::memory::core::access::MemoryCaller;
    use crate::memory::core::store::{DeleteSettlement, delete_cancellable};
    use crate::memory::pg::db::Lease;
    use tokio_util::sync::CancellationToken;

    let pg = TestPg::start().await;
    let db = pg.db(Schema::Memory).await;
    ensure_memory_schema(&db, 384, &Value::Null).await.expect("schema");
    let ctx = CoreContext {
        db: &db,
        data_dir: pg.dir.path(),
        session_cwd: None,
        snapshot_revision: &AtomicU64::new(0),
        lane: mixdog_rt::testing::tokens().durability_io,
    };
    assert!(!run(&ctx, &json!({"op":"add","summary":"Keep this entry"})).await.is_error);
    let id: i64 = db.query("SELECT id FROM core_entries", &[]).await.unwrap()[0].get(0);
    let blocker = Lease::take(&db).await.unwrap();
    blocker.begin().await.unwrap();
    blocker.query_one("SELECT id FROM core_entries WHERE id = $1 FOR UPDATE", &[&id]).await.unwrap();
    let pid: i32 = blocker.query_one("SELECT pg_backend_pid()", &[]).await.unwrap().get(0);
    let cancel = CancellationToken::new();
    let settlement = DeleteSettlement::default();
    let caller = MemoryCaller::host();
    let delete = delete_cancellable(&db, id, None, None, &caller, Some(&cancel), Some(&settlement));
    let (result, ()) = tokio::join!(delete, async {
        tokio::time::timeout(std::time::Duration::from_secs(5), async {
            loop {
                let waiting: bool =
                    db.query("SELECT EXISTS (SELECT 1 FROM pg_stat_activity WHERE $1 = ANY(pg_blocking_pids(pid)))", &[&pid]).await.unwrap()[0].get(0);
                if waiting {
                    break;
                }
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("the delete must reach the locked row before cancellation");
        assert!(settlement.interrupt(), "cancellation owns settlement while DELETE waits");
        cancel.cancel();
        blocker.rollback().await.unwrap();
        blocker.release(None).await;
    });
    assert!(result.unwrap_err().message().contains("aborted"));
    assert!(db.query_opt("SELECT id FROM core_entries WHERE id = $1", &[&id]).await.unwrap().is_some());

    let completed = CancellationToken::new();
    delete_cancellable(&db, id, None, None, &caller, Some(&completed), None).await.expect("commit without cancellation");
    completed.cancel();
    assert!(db.query_opt("SELECT id FROM core_entries WHERE id = $1", &[&id]).await.unwrap().is_none());
}

#[tokio::test(flavor = "multi_thread")]
#[ignore = "integration: needs a bundled Postgres runtime (MIXDOG_PG_RUNTIME)"]
async fn a_folder_scope_change_rejects_add_and_move_without_touching_other_instructions() {
    async fn entries(ctx: &CoreContext<'_>) -> Value {
        let reply = run(ctx, &json!({ "op": "list", "project_id": "*", "format": "json" })).await;
        assert!(!reply.is_error, "{}", reply.text);
        serde_json::from_str::<Value>(&reply.text).expect("list JSON")["entries"].clone()
    }

    let pg = TestPg::start().await;
    let db = pg.db(Schema::Memory).await;
    ensure_memory_schema(&db, 384, &json!({ "model": "test", "dtype": "q8" })).await.expect("schema");
    let revision = AtomicU64::new(0);
    let data_dir = pg.dir.path().join("data");
    let ctx = CoreContext { db: &db, data_dir: &data_dir, session_cwd: None, snapshot_revision: &revision, lane: mixdog_rt::testing::tokens().durability_io };
    let folder = tempfile::tempdir().expect("destination folder");
    let cwd = folder.path().to_str().expect("destination path");
    let marker_dir = folder.path().join(".mixdog");
    std::fs::create_dir(&marker_dir).expect("marker directory");
    let marker = marker_dir.join("project.id");
    std::fs::write(&marker, "displayed-project\n").expect("original marker");
    let add = json!({ "op": "add", "element": "Destination instruction", "summary": "Same text",
        "project_id": "displayed-project", "destination_cwd": cwd });
    for input in [
        add.clone(),
        json!({ "op": "add", "element": "Selected instruction", "summary": "Same text", "project_id": "source" }),
        json!({ "op": "add", "element": "Common instruction", "summary": "Same text",
            "project_id": "common", "cwd": cwd }),
    ] {
        let reply = run(&ctx, &input).await;
        assert!(!reply.is_error, "{}", reply.text);
    }
    let before = entries(&ctx).await;
    let selected = before.as_array().unwrap().iter().find(|row| row["element"] == "Selected instruction").unwrap();
    let move_to_folder = json!({
        "op": "edit", "id": selected["id"], "index_revision": selected["index_revision"], "project_id": "source",
        "element": "Selected instruction", "summary": "Same text",
        "target_project_id": "displayed-project", "destination_cwd": cwd,
    });
    let mut stale_add = add;
    stale_add["element"] = json!("Late instruction");
    for scope in ["another-project", "common"] {
        std::fs::write(&marker, scope).expect("changed marker");
        for input in [&stale_add, &move_to_folder] {
            let reply = run(&ctx, input).await;
            assert!(reply.is_error && reply.text.contains("Destination memory scope changed"), "{}", reply.text);
        }
        assert_eq!(entries(&ctx).await, before);
    }

    // Legacy cwd fields do not override explicit Common, even with a marked
    // folder. The selected row still needs the revision of its source pool.
    std::fs::write(&marker, "displayed-project\n").expect("restore marker");
    let mut move_to_common = move_to_folder;
    move_to_common.as_object_mut().unwrap().remove("destination_cwd");
    move_to_common["target_project_id"] = json!("common");
    move_to_common["cwd"] = json!(cwd);
    move_to_common["target_cwd"] = json!(cwd);
    let mut stale_revision = move_to_common.clone();
    stale_revision["index_revision"] = json!("stale");
    let reply = run(&ctx, &stale_revision).await;
    assert!(reply.is_error && reply.text.contains("memory indices changed"), "{}", reply.text);
    let reply = run(&ctx, &move_to_common).await;
    assert!(!reply.is_error, "{}", reply.text);
    let after = entries(&ctx).await;
    let rows: Vec<_> =
        after.as_array().unwrap().iter().map(|row| (row["element"].as_str().unwrap(), row["project_id"].as_str(), row["summary"].as_str().unwrap())).collect();
    assert_eq!(
        rows,
        [
            ("Common instruction", None, "Same text"),
            ("Selected instruction", None, "Same text"),
            ("Destination instruction", Some("displayed-project"), "Same text"),
        ]
    );
}

async fn core_context_over<'a>(db: &'a crate::memory::pg::db::Db, data_dir: &'a std::path::Path, revision: &'a AtomicU64) -> CoreContext<'a> {
    CoreContext { db, data_dir, session_cwd: None, snapshot_revision: revision, lane: mixdog_rt::testing::tokens().durability_io }
}

#[tokio::test(flavor = "multi_thread")]
#[ignore = "integration: needs a bundled Postgres runtime (MIXDOG_PG_RUNTIME)"]
async fn a_category_only_edit_keeps_the_text_and_an_unchanged_edit_is_refused() {
    use crate::memory::core::access::MemoryCaller;
    use crate::memory::core::store::{self, Edit};

    let pg = TestPg::start().await;
    let db = pg.db(Schema::Memory).await;
    ensure_memory_schema(&db, 384, &Value::Null).await.expect("schema");
    let caller = MemoryCaller::from_value(None);
    let entry = store::add(&db, &json!({ "element": "E", "summary": "S", "category": "fact" }), None, None, &caller).await.expect("add");
    let input = json!({ "category": "rule" });
    let request = || Edit { input: &input, expected_project_id: None, expected_agent_id: None, target_project_id: None, caller: &caller };
    let edited = store::edit(&db, entry.id, request()).await.expect("category edit");
    assert_eq!((edited.element.as_str(), edited.summary.as_str(), edited.category.as_str()), ("E", "S", "rule"));
    let stored = db.query("SELECT category FROM core_entries WHERE id = $1", &[&entry.id]).await.unwrap();
    assert_eq!(stored[0].get::<_, String>(0), "rule");
    let again = store::edit(&db, entry.id, request()).await.expect_err("nothing changed");
    assert!(again.message().contains("no change"), "{}", again.message());
}

#[tokio::test(flavor = "multi_thread")]
#[ignore = "integration: needs a bundled Postgres runtime (MIXDOG_PG_RUNTIME)"]
async fn the_all_projects_scope_is_refused_for_add_and_delete_but_not_list() {
    let pg = TestPg::start().await;
    let db = pg.db(Schema::Memory).await;
    ensure_memory_schema(&db, 384, &Value::Null).await.expect("schema");
    let revision = AtomicU64::new(0);
    let data_dir = pg.dir.path().join("data");
    let ctx = core_context_over(&db, &data_dir, &revision).await;
    let added = run(&ctx, &json!({ "op": "add", "project_id": "*", "summary": "x" })).await;
    assert!(added.is_error && added.text.contains("only valid for op=\"list\""), "{}", added.text);
    let deleted = run(&ctx, &json!({ "op": "delete", "project_id": "*", "id": 1, "index_revision": "r" })).await;
    assert!(deleted.is_error && deleted.text.contains("only valid for op=\"list\""), "{}", deleted.text);
    let listed = run(&ctx, &json!({ "op": "list", "project_id": "*" })).await;
    assert!(!listed.is_error, "{}", listed.text);
}
