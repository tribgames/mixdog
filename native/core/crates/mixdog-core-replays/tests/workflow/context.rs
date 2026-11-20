//! The pack summary and block against the Node golden (`fixtures/workflow-surface/context.json`,
//! `record-workflow-context.mjs`).

use std::path::Path;

use mixdog_core_config::workflow::WorkflowPaths;

use mixdog_core::run_host::workflow_surface::context::WorkflowPacks;

/// A lane that cannot run the pack read is a typed failure, not the row of a missing pack.
#[tokio::test]
async fn a_refused_lane_read_is_a_typed_failure() {
    let lane = mixdog_rt::testing::tokens().interactive_io;
    let packs = WorkflowPacks::new(lane, WorkflowPaths { root: "root".into(), data: "data".into() });
    let _refusing = mixdog_rt::testing::refuse_jobs_on_this_thread();
    let failure = packs.active("review", true).await.expect_err("the lane refuses");
    assert!(failure.0.contains("could not be read"), "{failure}");
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
    assert!(
        got.pack_context.starts_with("# Active Workflow: Default \u{2014} Handle tasks as requested.\n\nAn explicit request is the approval within its scope"),
        "{}",
        got.pack_context
    );
}
