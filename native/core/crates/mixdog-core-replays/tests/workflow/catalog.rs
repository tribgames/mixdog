//! The Lead's workflow slices against the Node golden (`fixtures/workflow-surface/lead-parts.json`,
//! `record-workflow-lead-parts.mjs`).

use serde_json::Value;
use serde_json::json;

use mixdog_core::run_host::workflow_surface::catalog::LeadParts;
use mixdog_core::run_host::workflow_surface::catalog::LeadPrompt;
use mixdog_core::run_host::workflow_surface::instructions::OrchestrationTexts;
use crate::testing::World;
use crate::testing::open_world;

fn golden() -> Value {
    serde_json::from_str(mixdog_testkit::fixture!("../../fixtures/workflow-surface/lead-parts.json")).expect("the golden is JSON")
}

fn expect(got: &LeadParts, want: &Value, case: &str) {
    let text = |key: &str| want[key].as_str().expect("part").to_owned();
    assert_eq!(got.orchestration_context, text("orchestrationContext"), "{case}");
    assert_eq!(got.agent_catalog_context, text("agentCatalogContext"), "{case}");
    assert_eq!(got.contact_catalog_context, text("contactCatalogContext"), "{case}");
}

/// The prompt over the world a golden entry describes.
async fn open(world: &Value) -> (World, LeadPrompt) {
    let lane = mixdog_rt::testing::tokens().interactive_io;
    let installed = open_world(&world["root"], &world["data"], &world["config"]).await;
    let prompt = LeadPrompt::new(installed.agents.clone(), OrchestrationTexts::new(lane, &installed.root, &installed.data), lane, &installed.data);
    (installed, prompt)
}

#[tokio::test]
async fn the_lead_slices_and_the_catalogs_equal_nodes() {
    let golden = golden();
    for world in golden["worlds"].as_array().expect("worlds") {
        let name = world["name"].as_str().expect("name");
        let (installed, prompt) = open(world).await;
        assert_eq!(json!(installed.agents.delegatable_agent_ids().await.expect("scan")), world["delegatable"], "{name}");
        for case in world["parts"].as_array().expect("parts") {
            let options = &case["options"];
            let agent_mode = options["agentMode"] == true;
            let agent_id = options["agentId"].as_str().unwrap_or_default();
            let got = prompt.lead_prompt_parts(case["mode"].as_str().expect("mode"), agent_mode, agent_id).await.expect("the lane ran the reads");
            expect(&got, &case["parts"], &format!("{name} {} {options}", case["mode"]));
        }
        for case in world["sessions"].as_array().expect("sessions") {
            let session = case["session"].as_object().expect("session");
            let got = prompt.lead_parts_for("balanced", session).await.expect("the lane ran the reads");
            expect(&got, &case["parts"], &format!("{name} {}", case["session"]));
        }
    }
}

/// Reads that cannot run are typed failures, not an empty roster.
#[tokio::test]
async fn a_refused_lane_read_is_a_typed_failure() {
    let golden = golden();
    let (_installed, prompt) = open(&golden["worlds"][1]).await;
    let _refusing = mixdog_rt::testing::refuse_jobs_on_this_thread();
    let failure = prompt.lead_prompt_parts("balanced", false, "").await.expect_err("the lane refuses");
    assert!(failure.0.contains("could not be read"), "{failure}");
}