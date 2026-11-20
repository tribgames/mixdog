//! The core-memory block against the golden recorded from the previous product
//! (`benchmarks/rust-core/recorders/record-core-memory-context.mjs`): snapshot files of every
//! shape, project markers, agents, the byte budget and the opt-out switch. Needs no Postgres.

#![allow(clippy::disallowed_methods, reason = "the test builds its files on the test thread")]

use std::sync::Arc;


use super::CoreMemoryContext;


#[tokio::test(flavor = "multi_thread")]
async fn a_snapshot_rewritten_after_the_first_load_is_read_again() {
    let root = tempfile::tempdir().expect("temp dir");
    let lane = mixdog_rt::testing::tokens().durability_io;
    let context = CoreMemoryContext::new(lane, root.path().to_owned(), Arc::new(|| false));
    let cwd = root.path().to_str().expect("utf-8 path");
    assert_eq!(context.load(cwd, "").await, "");
    let entry = |summary: &str| {
        serde_json::json!({ "version": 1, "revision": 1, "updatedAt": 0, "curated": [
            { "id": 1, "indexRevision": null, "summary": summary, "projectId": null, "agentId": null, "updatedAt": 0 }
        ] })
        .to_string()
    };
    std::fs::write(root.path().join("core-memory.json"), entry("first")).expect("snapshot");
    assert_eq!(context.load(cwd, "").await, "- first");
    std::fs::write(root.path().join("core-memory.json"), entry("second")).expect("snapshot");
    assert_eq!(context.load(cwd, "").await, "- second");
}


