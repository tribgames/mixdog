//! The mode texts against the Node golden (`fixtures/workflow-surface/orchestration.json`,
//! `record-workflow-orchestration-text.mjs`): what `readInstructionFile` answers for the user's
//! and the shipped file of a mode, and what `orchestrationInstructions` returns.

use mixdog_core::run_host::workflow_surface::instructions::OrchestrationTexts;

/// A lane that cannot run the read is a typed failure, not an empty mode text.
#[tokio::test]
async fn a_refused_lane_read_is_a_typed_failure() {
    let lane = mixdog_rt::testing::tokens().interactive_io;
    let texts = OrchestrationTexts::new(lane, "root", "data");
    let _refusing = mixdog_rt::testing::refuse_jobs_on_this_thread();
    let failure = texts.orchestration_instructions("swarm").await.expect_err("the lane refuses");
    assert!(failure.0.contains("could not be read"), "{failure}");
}
