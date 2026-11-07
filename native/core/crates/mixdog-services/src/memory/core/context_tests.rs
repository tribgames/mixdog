//! The core-memory block against the golden recorded from the previous product
//! (`benchmarks/rust-core/recorders/record-core-memory-context.mjs`): snapshot files of every
//! shape, project markers, agents, the byte budget and the opt-out switch. Needs no Postgres.

#![allow(clippy::disallowed_methods, reason = "the test builds its files on the test thread")]

use std::sync::Arc;

use serde_json::Value;

use super::{CoreMemoryContext, format_core_memory_lines};

const GOLDEN: &str = include_str!("../../../../../fixtures/tools/memory/core-memory-context/golden.json");

fn strings(value: &Value) -> Vec<String> {
    value.as_array().expect("array").iter().map(|v| v.as_str().expect("string").to_owned()).collect()
}

#[tokio::test(flavor = "multi_thread")]
async fn the_block_matches_what_node_injects() {
    let golden: Value = serde_json::from_str(GOLDEN).expect("golden parses");
    let lane = mixdog_rt::testing::tokens().durability_io;
    let mut loaded = 0;
    for case in golden["cases"].as_array().expect("cases") {
        let name = case["name"].as_str().expect("name");
        let expected = case["expected"].as_str().expect("expected");
        if let Some(lines) = case.get("format") {
            assert_eq!(format_core_memory_lines(&strings(lines)), expected, "{name}");
            continue;
        }
        let root = tempfile::tempdir().expect("temp dir");
        let data = root.path().join("data");
        std::fs::create_dir_all(&data).expect("data dir");
        if let Some(file) = case["file"].as_str() {
            std::fs::write(data.join("core-memory.json"), file).expect("snapshot");
        }
        let work = root.path().join("cwd");
        let cwd = case["cwd"].as_str().expect("cwd").split('/').fold(work.clone(), |path, part| path.join(part));
        std::fs::create_dir_all(&cwd).expect("cwd");
        if let Some(marker) = case["marker"].as_str() {
            let dir = work.join("project").join(".mixdog");
            std::fs::create_dir_all(&dir).expect("marker dir");
            std::fs::write(dir.join("project.id"), marker).expect("marker");
        }
        let opted_out = case["optsOut"].as_bool().expect("optsOut");
        let context = CoreMemoryContext::new(lane, data, Arc::new(move || opted_out));
        let got = context.load(cwd.to_str().expect("utf-8 path"), case["agentId"].as_str().expect("agent")).await;
        assert_eq!(got, expected, "{name}");
        loaded += 1;
    }
    assert!(loaded > 50, "the golden holds the loader cases");
}

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
