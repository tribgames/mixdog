//! The core-memory key at start-up: a pool is keyed by (project, agent, element), the key is installed only when no stored rows collide,
//! and a store that keeps legacy duplicates opens all the same.

use std::sync::Arc;

use mixdog_rt::node_log::{Channel, Origin};
use serde_json::{Value, json};

use super::awaiting::awaiting;
use crate::memory::pg::db::{Db, Schema};
use crate::memory::schema::{BEFORE_KEY_BUILD, BeforeKeyBuild, ensure_memory_schema};
use crate::memory::tests::support::TestPg;

const KEY: &str = "core_entries_unique_pool_elem";
const IDENTITY: fn() -> Value = || json!({ "model": "test", "dtype": "q8" });
const DUPLICATE_WARNING: &str = "[core-memory] duplicate keys preserved; resolve them with explicit edits/deletes before installing the unique index";

fn add(element: &str, summary: &str, agent: Option<&str>) -> String {
    let agent = agent.map_or("NULL".to_owned(), |a| format!("'{a}'"));
    format!("INSERT INTO core_entries (element, summary, category, project_id, agent_id, created_at, updated_at) VALUES ('{element}', '{summary}', 'rule', NULL, {agent}, 0, 0)")
}

async fn indexes(db: &Db) -> Vec<String> {
    db.query("SELECT indexname FROM pg_indexes WHERE schemaname = 'memory' AND tablename = 'core_entries' ORDER BY 1", &[]).await.expect("indexes").iter().map(|r| r.get(0)).collect()
}

async fn count(db: &Db) -> i64 {
    db.query_opt("SELECT count(*) FROM core_entries", &[]).await.unwrap().unwrap().get(0)
}

fn core_lines(lines: &std::sync::Mutex<Vec<(Origin, Channel, String)>>) -> Vec<String> {
    std::mem::take(&mut *lines.lock().unwrap()).into_iter().filter(|(origin, channel, line)| *origin == Origin::MemoryWorker && *channel == Channel::Stderr && line.starts_with("[core-memory]")).map(|(_, _, line)| line).collect()
}

#[tokio::test]
async fn a_fresh_profile_opens_with_the_pool_key_and_refuses_a_second_row_of_the_same_pool_and_element() {
    let pg = TestPg::start().await;
    let db = pg.db(Schema::Memory).await;
    ensure_memory_schema(&db, 384, &IDENTITY()).await.expect("a fresh profile opens");
    assert!(indexes(&db).await.contains(&KEY.to_owned()));
    db.execute(&add("key", "first", None), &[]).await.expect("the first row");
    let again = db.execute(&add("key", "second", None), &[]).await.expect_err("the same common element twice");
    let shown = format!("{again:?}");
    assert!(shown.contains(KEY) || shown.contains("23505"), "{shown}");
    db.execute(&add("key", "agent", Some("reviewer")), &[]).await.expect("an agent memory may share the element");
    db.execute(&add("other", "common", None), &[]).await.expect("another element");
    assert_eq!(count(&db).await, 3);
}

#[tokio::test]
async fn opening_again_changes_nothing() {
    let pg = TestPg::start().await;
    let db = pg.db(Schema::Memory).await;
    ensure_memory_schema(&db, 384, &IDENTITY()).await.unwrap();
    db.execute(&add("key", "first", None), &[]).await.unwrap();
    let before = indexes(&db).await;
    ensure_memory_schema(&db, 384, &IDENTITY()).await.unwrap();
    assert_eq!(indexes(&db).await, before);
    assert_eq!(count(&db).await, 1);
}

#[tokio::test]
async fn a_store_with_duplicate_keys_opens_keeps_both_rows_and_says_so_once() {
    let pg = TestPg::start().await;
    let db = pg.db(Schema::Memory).await;
    ensure_memory_schema(&db, 384, &IDENTITY()).await.unwrap();
    db.batch(&format!("DROP INDEX {KEY};\n{};\n{};\nCREATE UNIQUE INDEX core_entries_unique_proj_elem ON core_entries (project_id, (element || id::text))", add("key", "First approved preference", None), add("key", "Second approved preference", None))).await.expect("a store an old build left");
    let (lines, _guard) = mixdog_rt::node_log::capture();
    ensure_memory_schema(&db, 384, &IDENTITY()).await.expect("it opens");
    assert_eq!(core_lines(&lines), [DUPLICATE_WARNING]);
    assert_eq!(count(&db).await, 2, "no row is chosen over the other");
    assert!(!indexes(&db).await.contains(&KEY.to_owned()), "the pool key waits for the duplicates to be resolved");
    assert!(indexes(&db).await.contains(&"core_entries_unique_proj_elem".to_owned()), "the legacy key stays until the pool key replaces it");
}

#[tokio::test]
async fn once_the_duplicates_are_resolved_the_next_open_installs_the_pool_key_and_drops_the_legacy_one() {
    let pg = TestPg::start().await;
    let db = pg.db(Schema::Memory).await;
    ensure_memory_schema(&db, 384, &IDENTITY()).await.unwrap();
    db.batch(&format!("DROP INDEX {KEY};\n{};\n{};\nCREATE UNIQUE INDEX core_entries_unique_proj_elem ON core_entries (project_id, (element || id::text))", add("key", "First", None), add("key", "Second", None))).await.unwrap();
    ensure_memory_schema(&db, 384, &IDENTITY()).await.unwrap();
    db.execute("UPDATE core_entries SET element = 'resolved' WHERE id = 2", &[]).await.unwrap();
    let (lines, _guard) = mixdog_rt::node_log::capture();
    ensure_memory_schema(&db, 384, &IDENTITY()).await.unwrap();
    assert!(core_lines(&lines).is_empty(), "nothing to say once it is resolved");
    let names = indexes(&db).await;
    assert!(names.contains(&KEY.to_owned()) && !names.contains(&"core_entries_unique_proj_elem".to_owned()), "{names:?}");
    db.execute(&add("key", "An agent may share the key", Some("reviewer")), &[]).await.expect("an agent memory may share the key");
}

#[tokio::test]
async fn two_starters_building_the_missing_key_at_once_both_open_and_the_key_exists_after() {
    let pg = TestPg::start().await;
    let db = pg.db(Schema::Memory).await;
    ensure_memory_schema(&db, 384, &IDENTITY()).await.unwrap();
    db.execute(&add("key", "kept", None), &[]).await.unwrap();
    db.batch(&format!("DROP INDEX {KEY}")).await.unwrap();
    let (lines, _guard) = mixdog_rt::node_log::capture();
    // Each starter is held just before the key build until both have arrived, then released together.
    let arrived = Arc::new(tokio::sync::Semaphore::new(0));
    let (release, released) = tokio::sync::watch::channel(false);
    let stores = [pg.db(Schema::Memory).await, pg.db(Schema::Memory).await];
    let openings: Vec<_> = stores
        .into_iter()
        .map(|store| {
            let (arrived, released) = (arrived.clone(), released.clone());
            let gate: BeforeKeyBuild = Arc::new(move || {
                let (arrived, mut released) = (arrived.clone(), released.clone());
                Box::pin(async move {
                    arrived.add_permits(1);
                    released.wait_for(|go| *go).await.expect("the release");
                })
            });
            tokio::spawn(BEFORE_KEY_BUILD.scope(gate, async move { ensure_memory_schema(&store, 384, &IDENTITY()).await.map_err(|e| e.message()) }))
        })
        .collect();
    awaiting("both starters at the key build", arrived.acquire_many(2)).await.expect("permits").forget();
    release.send(true).expect("the starters wait");
    for opening in openings {
        awaiting("a starter's opening", opening).await.expect("the starter ran").expect("a starter opens whichever wins");
    }
    assert!(core_lines(&lines).iter().all(|line| line == "[core-memory] concurrent key conflict preserved; unique index deferred until explicit resolution"), "only the race's own line may be said");
    ensure_memory_schema(&db, 384, &IDENTITY()).await.unwrap();
    assert!(indexes(&db).await.contains(&KEY.to_owned()), "the next open leaves the key in place");
    assert_eq!(count(&db).await, 1);
}
