//! What a recall answers over a small stored history, without an embedding model: the lines it prints for a root and for a raw row, which
//! project's memory a scope shows, and the date order.

use std::sync::Arc;

use serde_json::{Value, json};
use tokio_util::sync::CancellationToken;

use crate::memory::pg::db::{Db, Schema};
use crate::memory::recall::period::Clock;
use crate::memory::recall::{Recall, RecallDeps};
use crate::memory::schema::ensure_memory_schema;
use crate::memory::tests::support::TestPg;

const NOW: i64 = 1_773_543_600_000;
const DAY: i64 = 86_400_000;

/// A root: a summary of the rows that follow it (`chunk_root` is its own id).
async fn root(db: &Db, ts: i64, project: Option<&str>, element: &str, summary: &str) -> i64 {
    let id: i64 = db
        .query_opt(
            "INSERT INTO entries (ts, role, content, source_ref, project_id, is_root, element, category, summary, status, last_seen_at)
             VALUES ($1, 'assistant', $2, $3, $4, 1, $5, 'decision', $2, 'active', $1) RETURNING id",
            &[&ts, &summary, &format!("root:{ts}:{element}"), &project, &element],
        )
        .await
        .expect("root")
        .expect("id")
        .get(0);
    db.execute("UPDATE entries SET chunk_root = id WHERE id = $1", &[&id]).await.expect("link");
    id
}

/// A raw row no cycle has summarised yet.
async fn raw(db: &Db, ts: i64, role: &str, content: &str) -> i64 {
    db.query_opt(
        "INSERT INTO entries (ts, role, content, source_ref, is_root, status) VALUES ($1, $2, $3, $4, 0, NULL) RETURNING id",
        &[&ts, &role, &content, &format!("raw:{ts}")],
    )
    .await
    .expect("raw")
    .expect("id")
    .get(0)
}

async fn recall_over(pg: &TestPg) -> (Db, Recall) {
    let db = pg.db(Schema::Memory).await;
    ensure_memory_schema(&db, 384, &json!({ "model": "test" })).await.expect("schema");
    let recall = Recall::new(RecallDeps {
        db: db.clone(),
        clock: Arc::new(|| Clock { now_ms: NOW, zone: chrono_tz::Asia::Seoul }),
        embedder: None,
        session_cwd: None,
        lane: mixdog_rt::testing::tokens().durability_io,
        estimate_tokens: Arc::new(mixdog_js::token_estimate::estimate_tokens),
        trace: None,
    });
    (db, recall)
}

async fn ask(recall: &Recall, args: Value) -> String {
    recall.recall_cancellable(&args, &CancellationToken::new()).await.text
}

#[tokio::test(flavor = "multi_thread")]
#[ignore = "integration: needs a bundled Postgres runtime (MIXDOG_PG_RUNTIME)"]
async fn a_root_prints_its_time_element_and_summary_and_a_raw_row_its_role_content_and_state() {
    let pg = TestPg::start().await;
    let (db, recall) = recall_over(&pg).await;
    let id = root(&db, 1_773_450_000_000, None, "staging deploy", "Deployed the staging cluster; rollout verified.").await;
    let pending = raw(&db, 1_773_540_600_000, "assistant", "The staging cluster rollout finished.").await;
    let text = ask(&recall, json!({ "query": "staging cluster", "projectScope": "all" })).await;
    assert!(text.contains(&format!("[2026-03-14 10:00 +09:00] staging deploy — Deployed the staging cluster; rollout verified. #{id}")), "{text}");
    assert!(text.contains(&format!("[2026-03-15 11:10 +09:00] a: The staging cluster rollout finished. [pending] #{pending}")), "{text}");
}

#[tokio::test(flavor = "multi_thread")]
#[ignore = "integration: needs a bundled Postgres runtime (MIXDOG_PG_RUNTIME)"]
async fn a_scope_shows_the_common_memory_with_its_own_project_and_all_shows_every_project() {
    let pg = TestPg::start().await;
    let (db, recall) = recall_over(&pg).await;
    let common = root(&db, NOW - 5 * DAY, None, "common note", "Alpha rollout is common knowledge.").await;
    let mine = root(&db, NOW - 4 * DAY, Some("proj-a"), "a note", "Alpha rollout belongs to project a.").await;
    let other = root(&db, NOW - 3 * DAY, Some("proj-b"), "b note", "Alpha rollout belongs to project b.").await;
    let shown = |text: &str| [common, mine, other].map(|id| text.contains(&format!("#{id}")));
    assert_eq!(shown(&ask(&recall, json!({ "query": "alpha rollout" })).await), [true, false, false], "the default is the common memory");
    assert_eq!(shown(&ask(&recall, json!({ "query": "alpha rollout", "projectScope": "proj-a" })).await), [true, true, false]);
    assert_eq!(shown(&ask(&recall, json!({ "query": "alpha rollout", "projectScope": "proj-b" })).await), [true, false, true]);
    assert_eq!(shown(&ask(&recall, json!({ "query": "alpha rollout", "projectScope": "all" })).await), [true, true, true]);
}

#[tokio::test(flavor = "multi_thread")]
#[ignore = "integration: needs a bundled Postgres runtime (MIXDOG_PG_RUNTIME)"]
async fn sorted_by_date_the_newest_comes_first() {
    let pg = TestPg::start().await;
    let (db, recall) = recall_over(&pg).await;
    let old = root(&db, NOW - 9 * DAY, None, "login bug", "Fixed the login bug in the refresh path.").await;
    let new = root(&db, NOW - 1 * DAY, None, "login bug again", "Fixed the login bug once more in the refresh path.").await;
    let mid = root(&db, NOW - 5 * DAY, None, "login bug review", "Reviewed the login bug fix in the refresh path.").await;
    let text = ask(&recall, json!({ "query": "login bug", "sort": "date", "projectScope": "all" })).await;
    let at = |id: i64| text.find(&format!("#{id}")).unwrap_or_else(|| panic!("#{id} missing from {text}"));
    assert!(at(new) < at(mid) && at(mid) < at(old), "{text}");
}
