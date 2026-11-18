//! The Lead's workflow slices and the target of a workflow or mode switch, over installs written inline: which pack and
//! orchestration text a session is given, which agents its catalog names, and who sees the bots.

use std::sync::Arc;

use async_trait::async_trait;
use mixdog_app_protocol::v2::thread::ToolProfile;
use mixdog_core::run_host::workflow_surface::FeatureFacts;
use mixdog_core::run_host::workflow_surface::FeatureProbes;
use mixdog_core::run_host::workflow_surface::RunWorkflowSurface;
use mixdog_core::run_host::workflow_surface::SurfaceParts;
use mixdog_core::run_host::workflow_surface::catalog::AGENT_MODE_DELEGATION;
use mixdog_core::run_host::workflow_surface::catalog::LeadParts;
use mixdog_core::run_host::workflow_surface::catalog::LeadPrompt;
use mixdog_core::run_host::workflow_surface::catalog::MIXY_CONTACTS_INTRO;
use mixdog_core::run_host::workflow_surface::instructions::OrchestrationTexts;
use mixdog_core_config::workflow::WorkflowPaths;
use mixdog_core_session::session::thread_switches::SurfaceFailure;
use mixdog_core_session::session::thread_switches::WorkflowSurface;
use mixdog_store::schema::record::Header;
use serde_json::Value;
use serde_json::json;

use crate::testing::World;
use crate::testing::open_world;

struct Facts;

#[async_trait]
impl FeatureProbes for Facts {
    async fn read(&self) -> Result<FeatureFacts, SurfaceFailure> {
        Ok(FeatureFacts::default())
    }
}

fn root() -> Value {
    json!({
        "workflows/default/WORKFLOW.md": "---\nname: Default\ndescription: The shipped default\n---\n# Default\n\nShipped default body.\n",
        "workflows/headless/WORKFLOW.md": "---\nname: Headless\ndescription: No agents\n---\n# Headless\n\nShipped headless.\n",
        "agents/worker/AGENT.md": "Worker body.",
        "agents/worker/agent.json": "{\"name\":\"Worker\",\"description\":\"Does the work\"}",
        "orchestration/none.md": "Orchestration text of none.\n",
        "orchestration/balanced.md": "Orchestration text of balanced.\n",
        "orchestration/swarm.md": "Orchestration text of swarm.\n",
    })
}

fn data() -> Value {
    json!({
        "workflows/review/WORKFLOW.md": "---\nname: Review\ndescription: Checks twice\n---\n# Review\n\nRead twice.\n",
        "agents/botty/AGENT.md": "---\nkind: bot\n---\nBot body.",
        "agents/botty/agent.json": "{\"name\":\"Botty\",\"description\":\"Chats\"}",
        "agents/lead/agent.json": "{\"name\":\"Mimi\"}",
    })
}

async fn installed(root: &Value, data: &Value) -> (World, LeadPrompt) {
    let lane = mixdog_rt::testing::tokens().interactive_io;
    let world = open_world(root, data, &json!({ "orchestrationMode": "swarm", "workflow": { "active": "headless" } })).await;
    let prompt = LeadPrompt::new(world.agents.clone(), OrchestrationTexts::new(lane, &world.root, &world.data), lane, &world.data);
    (world, prompt)
}

fn surface(world: &World) -> RunWorkflowSurface {
    RunWorkflowSurface::new(SurfaceParts {
        lane: mixdog_rt::testing::tokens().interactive_io,
        paths: WorkflowPaths { root: world.root.clone(), data: world.data.clone() },
        config: world.config.clone(),
        agents: world.agents.clone(),
        probes: Arc::new(Facts),
        env: Arc::new(|_| None),
        tool_profile: ToolProfile::Interactive,
        standalone: Vec::new(),
        agent_tools: Vec::new(),
    })
}

fn header(session: Value) -> Header {
    session.as_object().cloned().unwrap_or_default()
}

const WORKER_CATALOG: &str = "# Available Agents\n\n- Worker (worker): Does the work";

#[tokio::test]
async fn a_coding_lead_gets_the_modes_text_and_the_catalog_of_agents_that_are_not_bots() {
    let (_world, prompt) = installed(&root(), &data()).await;
    let parts = prompt.lead_prompt_parts("balanced", false, "").await.expect("the lane ran the reads");
    assert_eq!(
        parts,
        LeadParts { orchestration_context: "Orchestration text of balanced.".into(), agent_catalog_context: WORKER_CATALOG.into(), contact_catalog_context: String::new() }
    );
}

#[tokio::test]
async fn with_no_agents_to_delegate_to_the_solo_mode_has_no_text_and_no_catalog() {
    let (_world, prompt) = installed(&json!({ "orchestration/none.md": "Orchestration text of none.\n" }), &json!({})).await;
    assert_eq!(prompt.lead_prompt_parts("none", false, "").await.expect("the lane ran the reads"), LeadParts::default());
}

#[tokio::test]
async fn an_agent_mode_lead_gets_the_fixed_delegation_block_and_the_other_bots_as_contacts() {
    let (_world, prompt) = installed(&root(), &data()).await;
    let lead = prompt.lead_prompt_parts("balanced", true, "lead").await.expect("the lane ran the reads");
    assert_eq!(lead.orchestration_context, AGENT_MODE_DELEGATION);
    assert_eq!(lead.agent_catalog_context, WORKER_CATALOG);
    assert_eq!(lead.contact_catalog_context, format!("# Bots\n\n{MIXY_CONTACTS_INTRO}\n\n- Botty (botty): Chats"), "Mixy herself is not her own contact");
    let botty = prompt.lead_prompt_parts("balanced", true, "botty").await.expect("the lane ran the reads");
    assert_eq!(botty.contact_catalog_context, format!("# Bots\n\n{MIXY_CONTACTS_INTRO}\n\n- Mimi (lead): the user's representative bot"), "a bot is not its own contact");
}

#[tokio::test]
async fn a_read_the_lane_refuses_is_a_typed_failure_and_not_an_empty_roster() {
    let (_world, prompt) = installed(&root(), &data()).await;
    let _refusing = mixdog_rt::testing::refuse_jobs_on_this_thread();
    let failure = prompt.lead_prompt_parts("balanced", false, "").await.expect_err("the lane refuses");
    assert!(failure.0.contains("could not be read"), "{failure}");
}

#[tokio::test]
async fn a_switch_to_a_workflow_targets_its_pack_under_the_configured_orchestration_mode() {
    let (world, _) = installed(&root(), &data()).await;
    let surface = surface(&world);
    let target = surface.target(&header(json!({ "id": "sess_task" })), "review", None).await.expect("the lane ran the reads");
    assert_eq!(target.summary["id"], "review");
    assert_eq!((&target.summary["name"], &target.summary["description"]), (&json!("Review"), &json!("Checks twice")));
    assert_eq!(target.summary["delegatesAgents"], true, "a worker exists to delegate to");
    assert_eq!(target.pack_context, "# Active Workflow: Review — Checks twice\n\nRead twice.");
    assert_eq!(target.orchestration_mode, "swarm");
    assert_eq!(target.orchestration_context, "Orchestration text of swarm.");
    assert_eq!(target.agent_catalog_context, WORKER_CATALOG);
    assert_eq!(target.contact_catalog_context, "");
}

#[tokio::test]
async fn a_switch_of_mode_alone_changes_the_text_and_keeps_the_active_workflow() {
    let (world, _) = installed(&root(), &data()).await;
    let target = surface(&world).target(&header(json!({ "id": "sess_task" })), "", Some("none")).await.expect("the lane ran the reads");
    assert_eq!(target.orchestration_mode, "none");
    assert_eq!(target.orchestration_context, "Orchestration text of none.");
    assert_eq!(target.summary["id"], "headless", "the configured workflow stays active");
    assert_eq!(target.pack_context, "# Active Workflow: Headless — No agents\n\nShipped headless.");
}

#[tokio::test]
async fn a_bots_home_session_is_switched_to_the_delegation_block_and_not_the_modes_text() {
    let (world, _) = installed(&root(), &data()).await;
    let target = surface(&world).target(&header(json!({ "id": "sess_home_botty" })), "review", None).await.expect("the lane ran the reads");
    assert_eq!(target.orchestration_context, AGENT_MODE_DELEGATION);
    assert_eq!(target.contact_catalog_context, format!("# Bots\n\n{MIXY_CONTACTS_INTRO}\n\n- Mimi (lead): the user's representative bot"));
}

#[tokio::test]
async fn the_orchestration_text_of_a_mode_is_read_from_the_install_and_a_refused_read_fails() {
    let (world, _) = installed(&root(), &data()).await;
    let surface = surface(&world);
    assert_eq!(surface.orchestration_instructions("swarm").await.expect("the lane ran the read"), "Orchestration text of swarm.");
    let _refusing = mixdog_rt::testing::refuse_jobs_on_this_thread();
    assert!(surface.orchestration_instructions("swarm").await.is_err());
    assert!(surface.target(&header(json!({ "id": "sess_task" })), "review", None).await.is_err());
}