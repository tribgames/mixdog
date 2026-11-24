//! A session owing its sensitive rewrite: no index read answers its content until it is released.

use std::path::Path;
use std::sync::Arc;
use std::sync::Mutex;

use mixdog_rt::CancellationToken;
use mixdog_rt::LaneToken;
use serde_json::Value;
use serde_json::json;

use super::*;
use crate::summary::CatalogHead;

const CODE: &str = "482913";

async fn index_in(data: &Path) -> SqliteStore {
    let tokens = mixdog_rt::testing::tokens();
    let at = data.to_path_buf();
    tokens
        .maintenance_io
        .submit(&CancellationToken::new(), move |lane| SqliteStore::open(lane, tokens.sqlite_writer_thread, tokens.interactive_io, &at))
        .expect("lane")
        .await
        .expect("job ran")
        .expect("index")
}

async fn put(index: &SqliteStore, id: &str, title: &str, updated: u64) {
    let header = json!({ "id": id, "title": title, "updatedAt": updated, "desktopSession": { "classification": "task", "projectPath": "/p" } });
    let head = CatalogHead { session: id.into(), log_id: "4f1c2a9e0b7d3c5a6e8f9012".into(), base_session: None, header: header.as_object().unwrap().clone().into() };
    index.upsert(head, DirtyMark::Clear).await.unwrap();
}

/// The row changes the index tells.
#[derive(Default)]
struct Told(Mutex<Vec<RowEdge>>);

impl RowSink for Told {
    fn written(&self, edge: RowEdge) {
        self.0.lock().unwrap().push(edge);
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_session_owing_its_rewrite_is_answered_without_its_content_until_released() {
    let dir = tempfile::tempdir().unwrap();
    let index = index_in(dir.path()).await;
    put(&index, "owed", &format!("code {CODE}"), 2).await;
    put(&index, "clean", "code plain", 1).await;
    let told = Arc::new(Told::default());
    index.observe_rows(told.clone()).unwrap();
    index.withhold(vec!["owed".to_owned()]).await.unwrap();
    let holds = |text: &str| text.contains(CODE);

    assert!(index.is_withheld("owed").await.unwrap() && !index.is_withheld("clean").await.unwrap());
    assert!(!holds(&index.summary("owed").await.unwrap().expect("listed")), "the list row is answered without its title");
    assert_eq!(index.title("owed").await.unwrap(), None);
    assert_eq!(index.listed("owed").await.unwrap(), None, "the listed members are the record's to answer");
    assert!(index.lead_row("owed").await.unwrap().is_none_or(|row| !holds(&Value::Object(row.row).to_string())));
    let marked = index.marked_rows().await.unwrap();
    assert!(marked.iter().all(|row| !holds(&Value::Object(row.row.clone()).to_string())));
    assert!(marked.iter().any(|row| row.row["id"] == "owed"), "the session stays in the catalog");
    let listed = index.list_sessions(true, None, None).await.unwrap();
    assert!(listed.iter().all(|row| !holds(&Value::Object(row.row.clone()).to_string())));
    assert!(index.search(CODE, 10, None).await.unwrap().is_empty(), "its content matches no search");
    let first = index.search("code", 1, None).await.unwrap();
    assert!(first.len() == 1 && first[0].contains("\"clean\""), "left out before the limit, the newer owed one takes no place: {first:?}");
    let recent = index.search("", 10, None).await.unwrap();
    assert!(recent.iter().all(|row| !holds(row)) && recent.iter().any(|row| row.contains("\"owed\"")));
    assert_eq!(index.title("clean").await.unwrap().as_deref(), Some("code plain"), "a session owing nothing is answered in full");

    index.release_withheld("owed").await.unwrap();
    assert_eq!(index.title("owed").await.unwrap(), Some(format!("code {CODE}")));
    assert!(holds(&index.summary("owed").await.unwrap().expect("listed")));
    assert_eq!(index.search(CODE, 10, None).await.unwrap().len(), 1);
    // A roster that showed the row without its content is told it changed to the row itself.
    let edges = told.0.lock().unwrap().clone();
    let release = edges.iter().find(|edge| edge.id == "owed").expect("the release is told");
    assert!(release.before.as_ref().is_some_and(|before| !holds(&before.summary)) && holds(&release.after.summary));
}

/// A worker-index load made while a worker session was withheld holds it without its content: its release moves the row's
/// revision, so the next load since then reads it again.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_release_moves_the_worker_revision_of_the_row() {
    let dir = tempfile::tempdir().unwrap();
    let index = index_in(dir.path()).await;
    let header = json!({ "id": "w", "title": format!("code {CODE}"), "updatedAt": 1, "worker": { "tag": "rev", "agent": "worker", "parentSessionId": "p" } });
    let head = CatalogHead { session: "w".into(), log_id: "4f1c2a9e0b7d3c5a6e8f9012".into(), base_session: None, header: header.as_object().unwrap().clone().into() };
    index.upsert(head, DirtyMark::Clear).await.unwrap();
    index.withhold(vec!["w".to_owned()]).await.unwrap();
    let held = index.worker_index_since(None, Vec::new()).await.unwrap();
    assert!(held.sessions.iter().any(|session| session.session == "w"), "the worker is listed while withheld");
    let unchanged = index.worker_index_since(Some((held.generation, held.revision)), Vec::new()).await.unwrap();
    assert!(!unchanged.full && unchanged.sessions.is_empty(), "nothing moved yet");
    index.release_withheld("w").await.unwrap();
    let after = index.worker_index_since(Some((held.generation, held.revision)), Vec::new()).await.unwrap();
    assert!(!after.full && after.sessions.iter().any(|session| session.session == "w"), "the released row is read again");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_worker_load_spanning_a_release_answers_the_row_its_revision_holds() {
    let dir = tempfile::tempdir().unwrap();
    let index = index_in(dir.path()).await;
    let header = json!({ "id": "w", "updatedAt": 1, "worker": { "tag": "rev", "agent": "worker", "parentSessionId": "p", "result": format!("code {CODE}") } });
    let head = CatalogHead { session: "w".into(), log_id: "4f1c2a9e0b7d3c5a6e8f9012".into(), base_session: None, header: header.as_object().unwrap().clone().into() };
    index.upsert(head, DirtyMark::Clear).await.unwrap();
    index.withhold(vec!["w".to_owned()]).await.unwrap();
    let worker_of = |read: &crate::worker::WorkerIndexRead| {
        read.sessions.iter().find(|session| session.session == "w").and_then(|session| session.worker.clone()).map(|w| Value::Object(w).to_string())
    };
    let before = index.worker_index_since(None, Vec::new()).await.unwrap();

    // The load stops inside its read transaction, its rows read; the release commits meanwhile.
    let (arrived, at) = std::sync::mpsc::channel::<()>();
    let (go, wait) = std::sync::mpsc::channel::<()>();
    *index.shared.worker_read_hold.lock().unwrap() = Some(Box::new(move || {
        arrived.send(()).unwrap();
        wait.recv().unwrap();
    }));
    let loading = index.clone();
    let spanning = tokio::spawn(async move { loading.worker_index_since(None, Vec::new()).await.unwrap() });
    tokio::task::spawn_blocking(move || at.recv().unwrap()).await.unwrap();
    index.release_withheld("w").await.unwrap();
    assert!(!index.is_withheld("w").await.unwrap(), "the release committed while the load holds its read");
    go.send(()).unwrap();
    let spanning = spanning.await.unwrap();

    assert_eq!(spanning.revision, before.revision, "the load answers the revision of the rows it read");
    assert!(!worker_of(&spanning).expect("the worker").contains(CODE), "its rows were read withheld, and are answered so");
    let after = index.worker_index_since(Some((spanning.generation, spanning.revision)), Vec::new()).await.unwrap();
    assert!(after.revision > spanning.revision);
    assert!(worker_of(&after).expect("the release moved the row").contains(CODE), "the next load reads the released row in full");
    let settled = index.worker_index_since(Some((after.generation, after.revision)), Vec::new()).await.unwrap();
    assert!(settled.sessions.is_empty(), "nothing is left to correct");
}

/// The withheld state is the catalog's: it outlives the store (a restart keeps a session withheld until a start resets it),
/// and a start's withholding is exactly its own set.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn the_withheld_state_is_stored_and_reset_by_each_start() {
    let dir = tempfile::tempdir().unwrap();
    let index = index_in(dir.path()).await;
    put(&index, "a", &format!("code {CODE}"), 2).await;
    put(&index, "b", "t", 1).await;
    index.withhold(vec!["a".to_owned()]).await.unwrap();
    tokio::task::block_in_place(|| index.close());
    let index = index_in(dir.path()).await;
    assert!(index.is_withheld("a").await.unwrap(), "kept on disk across a restart");
    assert_eq!(index.title("a").await.unwrap(), None);
    index.withhold(vec!["b".to_owned()]).await.unwrap();
    assert_eq!(index.withheld_sessions().await.unwrap(), ["b"]);
    assert_eq!(index.title("a").await.unwrap(), Some(format!("code {CODE}")));
}

/// A purge leaves a deleted session owing its rewrite (its folder may be moving) for a later one.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[allow(clippy::disallowed_methods, reason = "test setup makes the data folder's sessions folder")]
async fn a_purge_leaves_a_withheld_session_for_a_later_purge() {
    let tokens = mixdog_rt::testing::tokens();
    let dir = tempfile::tempdir().unwrap();
    // A data folder always holds `sessions` (the composition and `StoreThreads::over_data_dir` make it): the purge syncs it.
    std::fs::create_dir_all(dir.path().join("sessions")).unwrap();
    let index = index_in(dir.path()).await;
    put(&index, "owed", "t", 1).await;
    index.mark_deleted("owed").await.unwrap();
    index.withhold(vec!["owed".to_owned()]).await.unwrap();
    assert!(index.purge_deleted(tokens.maintenance_io, dir.path().to_path_buf()).await.unwrap().is_empty());
    index.release_withheld("owed").await.unwrap();
    assert_eq!(index.purge_deleted(tokens.maintenance_io, dir.path().to_path_buf()).await.unwrap(), ["owed"]);
}
