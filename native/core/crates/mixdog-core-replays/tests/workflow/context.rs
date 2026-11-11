//! The pack summary and block against the Node golden (`fixtures/workflow-surface/context.json`,
//! `record-workflow-context.mjs`).

use std::path::Path;

use mixdog_core_config::workflow::WorkflowPaths;
use serde_json::Value;

use mixdog_core::run_host::workflow_surface::context::WorkflowPacks;
use mixdog_core::run_host::workflow_surface::context::context_block_from_pack;
use mixdog_core::run_host::fixture_fs;

fn golden() -> Value {
    serde_json::from_str(include_str!("../../../../fixtures/workflow-surface/context.json")).expect("the golden is JSON")
}

fn lay(folder: &Path, files: &Value) {
    fixture_fs::create_dir_all(folder);
    for (path, text) in files.as_object().expect("files") {
        fixture_fs::write(folder.join(path), text.as_str().expect("text"));
    }
}

/// A lane that cannot run the pack read is a typed failure, not the row of a missing pack.
#[tokio::test]
async fn a_refused_lane_read_is_a_typed_failure() {
    let lane = mixdog_rt::testing::tokens().interactive_io;
    let packs = WorkflowPacks::new(lane, WorkflowPaths { root: "root".into(), data: "data".into() });
    let _refusing = mixdog_rt::testing::refuse_jobs_on_this_thread();
    let failure = packs.active("review", true).await.expect_err("the lane refuses");
    assert!(failure.0.contains("could not be read"), "{failure}");
}

#[tokio::test]
async fn the_summary_and_the_pack_block_equal_nodes() {
    let lane = mixdog_rt::testing::tokens().interactive_io;
    let golden = golden();
    for case in golden["cases"].as_array().expect("cases") {
        let name = case["name"].as_str().expect("name");
        let dir = tempfile::tempdir().expect("sandbox");
        let (root, data) = (dir.path().join("root"), dir.path().join("data"));
        lay(&root, &case["root"]);
        lay(&data, &case["data"]);
        let packs = WorkflowPacks::new(lane, WorkflowPaths { root, data });
        let active = packs.load(case["active"].as_str().unwrap_or_default()).await.expect("the lane ran the read");
        let got = packs.active(case["active"].as_str().unwrap_or_default(), case["hasAgents"] == true).await.expect("the lane ran the read");
        // Key order is part of the stored row.
        assert_eq!(got.summary.to_string(), case["summary"].to_string(), "{name}");
        assert_eq!(got.pack_context, case["packContext"].as_str().expect("block"), "{name}");
        assert_eq!(context_block_from_pack(active.as_ref()), got.pack_context, "{name}");
    }
}

/// The shipped packs are `<package root>/src/workflows` (`mixdogRoot()` is the `src` folder): over this
/// repository's own tree the default workflow is the built-in pack a Node session records.
#[tokio::test]
async fn the_shipped_default_pack_is_read_from_the_src_folder() {
    let lane = mixdog_rt::testing::tokens().interactive_io;
    let package_root = Path::new(env!("CARGO_MANIFEST_DIR")).ancestors().nth(4).expect("the repository root");
    let data = tempfile::tempdir().expect("sandbox");
    let packs = WorkflowPacks::new(lane, WorkflowPaths { root: package_root.join("src"), data: data.path().to_path_buf() });
    let got = packs.active("default", true).await.expect("the lane ran the read");
    assert_eq!(
        got.summary.to_string(),
        r#"{"id":"default","name":"Default","description":"Handle tasks as requested.","source":"built-in","delegatesAgents":true}"#
    );
    assert!(got.pack_context.starts_with("# Active Workflow: Default \u{2014} Handle tasks as requested.\n\nAn explicit request is the approval within its scope"), "{}", got.pack_context);
}
