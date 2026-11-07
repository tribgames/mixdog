//! `StoredConsumers` against `fixtures/stored-consumers/golden.json`
//! (`record-stored-consumers.mjs`): the store files real Node wrote, migrated, and the consumers
//! Node's `storedWorkspaceConsumers` returned for them, with the refusal Node gave once a
//! record could not be read.

use std::sync::Arc;

use serde_json::Value;

use super::StoredConsumers;
use crate::session::search_backfill::StoredSearchSessions;
use crate::session::search_backfill::tests::migrated;

fn golden() -> Value {
    serde_json::from_str(include_str!("../../../../fixtures/stored-consumers/golden.json")).expect("golden.json")
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn the_consumers_are_the_ones_node_listed_and_an_unreadable_record_refuses_them_all() {
    let golden = golden();
    let (dir, threads, lanes) = migrated(&golden).await;
    let consumers = StoredConsumers::new(Arc::new(StoredSearchSessions::new(threads, lanes)));

    let mut got: Vec<Value> = consumers
        .list()
        .await
        .expect("listing")
        .into_iter()
        .map(|s| {
            serde_json::json!({
                "id": s.id, "cwd": s.cwd, "active": s.active, "closed": s.closed,
                "ownerSessionId": s.owner_session_id, "parentSessionId": s.parent_session_id,
            })
        })
        .collect();
    got.sort_by(|a, b| a["id"].as_str().cmp(&b["id"].as_str()));
    let mut want = golden["consumers"].as_array().expect("consumers").clone();
    want.sort_by(|a, b| a["id"].as_str().cmp(&b["id"].as_str()));
    assert_eq!(got, want);

    // A session folder whose record cannot be read: the whole listing is refused.
    crate::session::fixture_fs::create_dir_all(dir.path().join("data").join("sessions").join("sess_broken"));
    let refused = consumers.list().await.expect_err("an unreadable record refuses");
    assert_eq!(refused.to_string(), golden["refusal"].as_str().expect("refusal"));
}

/// The store folder itself cannot be listed: Node's readdir text reaches the user, with the folder
/// standing as <sessions>.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn an_unlistable_store_folder_reads_as_nodes_readdir_error() {
    let golden = golden();
    let (dir, threads, lanes) = migrated(&golden).await;
    let consumers = StoredConsumers::new(Arc::new(StoredSearchSessions::new(threads, lanes)));
    let sessions = dir.path().join("data").join("sessions");
    let said = |error: mixdog_scm::error::ScmFailure| error.to_string().replace(&sessions.display().to_string(), "<sessions>");

    crate::session::fixture_fs::remove_dir_all(&sessions);
    assert_eq!(said(consumers.list().await.expect_err("absent")), golden["unlistable"]["absent"].as_str().expect("absent"));

    crate::session::fixture_fs::write(&sessions, "not a folder");
    assert_eq!(said(consumers.list().await.expect_err("not a folder")), golden["unlistable"]["notAFolder"].as_str().expect("notAFolder"));
}