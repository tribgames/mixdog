//! The surface against the Node golden (`fixtures/workflow-surface/surface.json`,
//! `record-workflow-surface.mjs`): the targets of workflow and mode switches, and the standalone
//! tools a session is offered.

use std::sync::Arc;

use async_trait::async_trait;
use mixdog_app_protocol::v2::thread::ToolProfile;
use mixdog_core_api::domain::tool::Tool;
use mixdog_core_api::domain::tool::ToolAnnotations;
use mixdog_core_api::domain::tool::ToolContext;
use mixdog_core_api::domain::tool::ToolOutcome;
use mixdog_core_api::domain::tool::ToolOutput;
use mixdog_core_api::domain::tool::ToolSpec;
use mixdog_core_config::workflow::WorkflowPaths;
use mixdog_core_session::session::thread_switches::WorkflowSurface;
use mixdog_store::schema::record::Header;
use serde_json::Value;
use serde_json::json;

use super::FeatureProbes;
use super::SurfaceFailure;
use crate::run_host::workflow_surface::FeatureFacts;
use super::RunWorkflowSurface;
use super::SurfaceParts;
use crate::run_host::workflow_surface::testing::World;
use crate::run_host::workflow_surface::testing::open_world;
use crate::run_host::workflow_surface::testing::profile_of;

fn golden() -> Value {
    serde_json::from_str(include_str!("../../../../../fixtures/workflow-surface/surface.json")).expect("the golden is JSON")
}

struct Facts;

#[async_trait]
impl FeatureProbes for Facts {
    async fn read(&self) -> Result<FeatureFacts, SurfaceFailure> {
        Ok(FeatureFacts::default())
    }
}

/// Probes whose read cannot run.
struct BrokenFacts;

#[async_trait]
impl FeatureProbes for BrokenFacts {
    async fn read(&self) -> Result<FeatureFacts, SurfaceFailure> {
        Err(SurfaceFailure("the bridge probe could not run".into()))
    }
}

struct Named(ToolSpec);

#[async_trait]
impl Tool for Named {
    fn spec(&self) -> &ToolSpec {
        &self.0
    }
    async fn call(&self, _: &ToolContext, _: Value) -> ToolOutcome {
        Ok(ToolOutput::default())
    }
}

/// A tool holding what Node's definition object holds.
fn tool_of(def: &Value) -> Arc<dyn Tool> {
    let hints = &def["annotations"];
    let flag = |key: &str| hints.get(key).and_then(Value::as_bool);
    let text = |key: &str| def.get(key).and_then(Value::as_str).map(str::to_owned);
    Arc::new(Named(ToolSpec {
        name: def["name"].as_str().expect("name").to_owned(),
        title: text("title"),
        trigger: text("trigger"),
        public: def.get("public") != Some(&Value::Bool(false)),
        aliases: Vec::new(),
        description: def["description"].as_str().expect("description").to_owned(),
        input_schema: def["inputSchema"].clone(),
        annotations: ToolAnnotations {
            title: hints.get("title").and_then(Value::as_str).map(str::to_owned),
            read_only_hint: flag("readOnlyHint"),
            destructive_hint: flag("destructiveHint"),
            idempotent_hint: flag("idempotentHint"),
            open_world_hint: flag("openWorldHint"),
            compressible: flag("compressible"),
            compressible_lossless: flag("compressibleLossless"),
            agent_hidden: flag("agentHidden"),
        },
        parallel_safe: true,
        exclusive_with: Vec::new(),
    }))
}

fn surface_over(world: &World, probes: Arc<dyn FeatureProbes>, profile: ToolProfile, tools: &Value, agent_tools: &Value) -> RunWorkflowSurface {
    let names = |list: &Value| list.as_array().expect("names").iter().map(|name| name.as_str().expect("name").to_owned()).collect::<Vec<_>>();
    RunWorkflowSurface::new(SurfaceParts {
        lane: mixdog_rt::testing::tokens().interactive_io,
        paths: WorkflowPaths { root: world.root.clone(), data: world.data.clone() },
        config: world.config.clone(),
        agents: world.agents.clone(),
        probes,
        env: Arc::new(|_| None),
        tool_profile: profile,
        standalone: tools.as_array().expect("definitions").iter().map(tool_of).collect(),
        agent_tools: names(agent_tools),
    })
}

fn surface(world: &World, profile: ToolProfile, tools: &Value, agent_tools: &Value) -> RunWorkflowSurface {
    surface_over(world, Arc::new(Facts), profile, tools, agent_tools)
}


fn header(session: &Value) -> Header {
    session.as_object().cloned().unwrap_or_default()
}

#[tokio::test]
async fn the_target_of_a_switch_equals_nodes() {
    let golden = golden();
    let targets = &golden["targets"];
    let world = open_world(&targets["root"], &targets["data"], &targets["config"]).await;
    let surface = surface(&world, ToolProfile::Interactive, &json!([]), &json!([]));
    for call in targets["calls"].as_array().expect("calls") {
        let case = format!("{} {} {}", call["workflowId"], call["mode"], call["session"]);
        let want = &call["target"];
        let got = surface.target(&header(&call["session"]), call["workflowId"].as_str().expect("id"), call["mode"].as_str()).await.expect("the lane ran the reads");
        // Key order is part of the stored row.
        assert_eq!(got.summary.to_string(), want["summary"].to_string(), "{case}");
        assert_eq!(got.orchestration_mode, want["orchestrationMode"].as_str().expect("mode"), "{case}");
        assert_eq!(got.pack_context, want["packContext"].as_str().expect("block"), "{case}");
        assert_eq!(got.orchestration_context, want["orchestrationContext"].as_str().expect("text"), "{case}");
        assert_eq!(got.agent_catalog_context, want["agentCatalogContext"].as_str().expect("catalog"), "{case}");
        assert_eq!(got.contact_catalog_context, want["contactCatalogContext"].as_str().expect("contacts"), "{case}");
    }
    assert_eq!(surface.orchestration_instructions("swarm").await.expect("the lane ran the read"), "Orchestration text of swarm.");
}

/// Reads that cannot run are typed failures from every method, never an empty answer.
#[tokio::test]
async fn reads_that_cannot_run_are_typed_failures() {
    let golden = golden();
    let targets = &golden["targets"];
    let world = open_world(&targets["root"], &targets["data"], &targets["config"]).await;
    let tools = &golden["standaloneTools"];
    let session = header(&json!({ "id": "sess_task", "callerDisallowedTools": [] }));
    let broken = surface_over(&world, Arc::new(BrokenFacts), ToolProfile::Interactive, tools, &golden["agentTools"]);
    assert_eq!(broken.internal_tools(&session).await.err(), Some(SurfaceFailure("the bridge probe could not run".into())));
    assert_eq!(broken.live_denied_tools(&session, &json!({})).await.err(), Some(SurfaceFailure("the bridge probe could not run".into())));
    let surface = surface(&world, ToolProfile::Interactive, tools, &golden["agentTools"]);
    let _refusing = mixdog_rt::testing::refuse_jobs_on_this_thread();
    assert!(surface.target(&session, "review", None).await.is_err());
    assert!(surface.orchestration_instructions("swarm").await.is_err());
    drop(_refusing);
    // A session record Node would throw on.
    let bare = header(&json!({ "id": "sess_task" }));
    assert!(surface.live_denied_tools(&bare, &json!({})).await.is_err());
}

#[tokio::test]
async fn the_internal_tools_a_session_is_offered_equal_nodes() {
    let golden = golden();
    for case in golden["standalone"].as_array().expect("standalone") {
        let name = case["name"].as_str().expect("name");
        let agents: serde_json::Map<String, Value> = (0..case["delegatable"].as_u64().expect("count"))
            .map(|n| (format!("agents/a{n}/AGENT.md"), json!("Agent body.")))
            .collect();
        let world = open_world(&json!({}), &Value::Object(agents), &json!({})).await;
        let surface = surface(&world, profile_of(case["profile"].as_str().expect("profile")), &golden["standaloneTools"], &golden["agentTools"]);
        let features: Vec<String> = case["features"].as_array().expect("features").iter().map(|f| f.as_str().expect("name").to_owned()).collect();
        let offered = surface.gated_tools(&header(&case["session"]), &features).await.expect("the lane ran the reads");
        let got: Vec<String> = offered.iter().map(|tool| tool.spec().name.clone()).collect();
        let want: Vec<String> = case["tools"].as_array().expect("tools").iter().map(|t| t.as_str().expect("name").to_owned()).collect();
        assert_eq!(got, want, "{name}");
        // Each tool is Node's definition object: name, description, inputSchema and annotations.
        for tool in &offered {
            let node = golden["standaloneTools"].as_array().expect("definitions").iter().find(|def| def["name"] == tool.spec().name.as_str()).expect("a listed definition");
            let got = tool.spec().definition();
            assert_eq!(&got, node, "{name}: {}", tool.spec().name);
            // The annotations' key order is the definition's.
            assert_eq!(got["annotations"].to_string(), node["annotations"].to_string(), "{name}: {} annotations", tool.spec().name);
        }
    }
}
