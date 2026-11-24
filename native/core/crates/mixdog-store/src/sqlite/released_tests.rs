//! An index of a released version opens in place: an update never holds its first start for a rebuild from the logs.

use mixdog_rt::CancellationToken;
use mixdog_rt::LaneToken;
use serde_json::json;

use super::*;
use crate::schema::sql::FIRST_RELEASED_INDEX_VERSION;
use crate::summary::CatalogHead;

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

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[allow(clippy::disallowed_methods, reason = "test setup stamps the index file with the released version")]
async fn an_index_of_the_first_released_version_keeps_its_rows_at_open() {
    let dir = tempfile::tempdir().unwrap();
    let index = index_in(dir.path()).await;
    let header = json!({ "id": "kept", "title": "Kept", "updatedAt": 1, "desktopSession": { "classification": "task", "projectPath": "/p" } });
    let head =
        CatalogHead { session: "kept".into(), log_id: "4f1c2a9e0b7d3c5a6e8f9012".into(), base_session: None, header: header.as_object().unwrap().clone().into() };
    index.upsert(head, DirtyMark::Clear).await.unwrap();
    index.close();
    drop(index);
    Connection::open(dir.path().join(INDEX_FILE)).unwrap().pragma_update(None, "user_version", FIRST_RELEASED_INDEX_VERSION).unwrap();

    let index = index_in(dir.path()).await;
    let kept = index.summary("kept").await.unwrap();
    index.close();
    assert!(
        kept.is_some(),
        "an index of version {FIRST_RELEASED_INDEX_VERSION} was rebuilt from the logs at open: a format change after it ships with a \
         delta that brings it to {INDEX_USER_VERSION} in place"
    );
}
