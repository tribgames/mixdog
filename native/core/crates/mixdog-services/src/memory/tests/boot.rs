//! Memory start: the stored model identity, and the started stack end to end.

use std::path::PathBuf;
use std::sync::Arc;

use serde_json::json;

use crate::memory::boot::{MemoryBoot, MemoryStack};
use crate::memory::embed::config::{self, DEFAULT_MODEL_ID};
use crate::memory::runtime::RuntimeFlags;
use crate::memory::sensitive::SensitiveStore;
use crate::memory::session_search::ingest::IngestSession;

/// `_initStore`'s dimensions: the saved measurement of this identity wins (a model the profiles do
/// not list opens without being loaded), then the profile; an unlisted model with no saved
/// measurement has no source without the model.
#[tokio::test(flavor = "multi_thread")]
async fn dimensions_come_from_the_saved_measurement_then_the_profile() {
    use crate::memory::boot::resolve_dims;
    let lane = mixdog_rt::testing::tokens().durability_io;
    let dir = tempfile::tempdir().expect("dir");
    let unlisted = config::identity(None, "acme/unlisted", None);

    let err = resolve_dims(dir.path(), lane, &unlisted, "acme/unlisted", None).await.expect_err("no source");
    assert!(err.message().contains("embedding dims unavailable without an embedding model"), "{}", err.message());

    let mut saved = unlisted.clone();
    saved["dims"] = json!(777);
    std::fs::write(dir.path().join("embedding-meta.json"), saved.to_string()).expect("write");
    assert_eq!(resolve_dims(dir.path(), lane, &unlisted, "acme/unlisted", None).await.expect("saved"), 777);

    // The saved value belongs to its identity: another dtype is another measurement.
    let other = config::identity(None, "acme/unlisted", Some("q8"));
    assert!(resolve_dims(dir.path(), lane, &other, "acme/unlisted", None).await.is_err());

    // A listed model needs no measurement.
    let listed = config::identity(None, DEFAULT_MODEL_ID, None);
    assert_eq!(resolve_dims(dir.path(), lane, &listed, DEFAULT_MODEL_ID, None).await.expect("profile"), 384);
}

/// Node's `metaKey` (`index.mjs` `_initStore`), which `openDatabase` stores as
/// `embedding.current_model`; the same key under Node must not reset the vectors.
#[test]
fn the_stored_model_identity_is_nodes_meta_key() {
    assert_eq!(
        config::identity(None, DEFAULT_MODEL_ID, None),
        json!({ "provider": null, "model": "Xenova/multilingual-e5-small", "dtype": "q8", "format": "mixdog-embedding-v3" }),
    );
    assert_eq!(
        config::identity(Some("local"), "Xenova/bge-m3", Some("Q4 ")),
        json!({ "provider": "local", "model": "Xenova/bge-m3", "dtype": "q4", "format": "mixdog-embedding-v3" }),
    );
}

#[tokio::test(flavor = "multi_thread")]
#[ignore = "integration: needs a bundled Postgres runtime (MIXDOG_PG_RUNTIME)"]
async fn a_started_stack_serves_the_close_ingest_and_the_turn_search_copy() {
    let runtime = PathBuf::from(std::env::var_os("MIXDOG_PG_RUNTIME").expect("MIXDOG_PG_RUNTIME names a bundled postgres runtime dir"));
    let dir = tempfile::tempdir().expect("temp dir");
    let stack = MemoryStack::start(MemoryBoot {
        data_dir: dir.path().to_owned(),
        pg_runtime: runtime,
        embedder: None,
        embedding_provider: None,
        flags: RuntimeFlags::default(),
        progress: None,
        sensitive: Arc::new(SensitiveStore::default()),
        lane: mixdog_rt::testing::tokens().durability_io,
        maintenance: mixdog_rt::testing::tokens().maintenance_io,
        transcripts: None,
        cycles: None,
        backfill: None,
        processes: crate::tidy::process::Processes::for_tests(),
        cancel: tokio_util::sync::CancellationToken::new(),
    })
    .await
    .expect("memory starts");
    let messages = vec![
        json!({ "role": "user", "content": "Please remember that the build uses the g-tools target." }),
        json!({ "role": "assistant", "content": "Noted: the build uses the g-tools target." }),
    ];
    let text = stack
        .module()
        .memory(json!({ "action": "ingest_session", "sessionId": "boot-1", "cwd": dir.path().to_string_lossy(), "messages": messages }))
        .await;
    assert!(text.starts_with("ingest_session:"), "{text}");
    stack.search().ingest_turn(IngestSession { id: "boot-1".into(), messages, agent_only: false });
    stack.search().settle("boot-1").await;
    assert!(stack.search().db().session_ids().await.expect("ids").contains("boot-1"));
    stack.stop().await.expect("stops");
}
