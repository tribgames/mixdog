use std::collections::HashSet;
use std::path::Path;
use std::sync::Arc;
use std::sync::Mutex;

use async_trait::async_trait;
use mixdog_agent::env::Clock;
use mixdog_core_api::domain::tool::Tool;
use mixdog_core_api::domain::tool::ToolAnnotations;
use mixdog_core_api::domain::tool::ToolContext;
use mixdog_core_api::domain::tool::ToolOutcome;
use mixdog_core_api::domain::tool::ToolOutput;
use mixdog_core_api::domain::tool::ToolSpec;
use mixdog_core_ports::ports::route::Route;
use mixdog_core_ports::ports::threads::Section;
use mixdog_core_session::session::agent_registry::Row;
use mixdog_core_session::session::thread_switches::SurfaceFailure;
use mixdog_core_session::session::thread_switches::WorkflowTarget;

use crate::run_host::prompt_session::SessionPrompt;
use crate::run_host::session_tools::internal_tools;

use super::*;

struct Stub(ToolSpec, Option<ToolSpec>);

#[async_trait]
impl Tool for Stub {
    fn spec(&self) -> &ToolSpec {
        &self.0
    }
    fn agent_spec(&self) -> Option<&ToolSpec> {
        self.1.as_ref()
    }
    async fn call(&self, _: &ToolContext, _: Value) -> ToolOutcome {
        Ok(ToolOutput::default())
    }
}

fn flag(doc: &Value, key: &str) -> Option<bool> {
    doc.pointer(&format!("/annotations/{key}")).and_then(Value::as_bool)
}

/// The tool spec of a definition Node published.
fn spec_of_doc(doc: &Value) -> ToolSpec {
    ToolSpec {
        name: doc["name"].as_str().expect("name").into(),
        title: doc.get("title").and_then(Value::as_str).map(str::to_owned),
        trigger: doc.get("trigger").and_then(Value::as_str).map(str::to_owned),
        public: doc.get("public") != Some(&Value::Bool(false)),
        aliases: Vec::new(),
        // The golden pool was recorded on a Claude route, so its shell text already names `edit`; the registered tool carries the template `edit/apply_patch` (builtin-tools.mjs:45) that the surface rewrites per model (`edit-tool-dialect.mjs`).
        description: doc["description"].as_str().unwrap_or_default().replace("`>`→edit; git→git", "`>`→edit/apply_patch; git→git"),
        input_schema: doc["inputSchema"].clone(),
        annotations: ToolAnnotations {
            title: doc.pointer("/annotations/title").and_then(Value::as_str).map(str::to_owned),
            read_only_hint: flag(doc, "readOnlyHint"),
            destructive_hint: flag(doc, "destructiveHint"),
            idempotent_hint: flag(doc, "idempotentHint"),
            open_world_hint: flag(doc, "openWorldHint"),
            compressible: flag(doc, "compressible"),
            compressible_lossless: flag(doc, "compressibleLossless"),
            agent_hidden: flag(doc, "agentHidden"),
        },
        parallel_safe: true,
        exclusive_with: Vec::new(),
    }
}

/// A pool tool carrying the definition Node published.
fn stub(doc: &Value) -> Arc<dyn Tool> {
    let spec = spec_of_doc(doc);
    // `git` and `task` have the definition delegated agents are sent, as the real ones do.
    let agent = matches!(spec.name.as_str(), "git" | "task").then(|| spec.clone());
    Arc::new(Stub(spec, agent))
}

fn golden() -> Value {
    mixdog_js::fixture_tools::parse_golden(include_str!("../../../../../fixtures/surface-host/golden.json")).expect("golden")
}

/// The golden's pool in the order the golden lists it (Node's session preview, not its registration
/// order). The internal tools' order in a surface is `internal_tools`' to give (`STANDALONE_ORDER`),
/// whatever order the pool was registered in.
fn pool_of(g: &Value) -> Vec<Arc<dyn Tool>> {
    g["pool"].as_array().expect("pool").iter().map(stub).collect()
}

fn names(value: &Value) -> Vec<String> {
    value.as_array().into_iter().flatten().map(|v| v.as_str().expect("name").to_owned()).collect()
}

fn doc_names(value: Option<&Value>) -> Vec<String> {
    value.and_then(Value::as_array).into_iter().flatten().map(tool_name).collect()
}

struct Routes(Route);
impl LiveRoute for Routes {
    fn route(&self, _: &ThreadId) -> Route {
        self.0.clone()
    }
    fn adopt_held(&self, _: &ThreadId, _: &Route) {}
}

/// The connected servers' tools, whatever the folder.
struct Mcp(Vec<Arc<dyn Tool>>);
impl SessionMcp for Mcp {
    fn tools(&self, _: &Path) -> Vec<Arc<dyn Tool>> {
        self.0.clone()
    }
}

/// The prompt a rebuild composes: fixed blocks, and the request it was asked for.
struct FakePrompt(Mutex<Vec<RebuildRequest>>);

#[async_trait]
impl PromptRebuild for FakePrompt {
    async fn rebuild(&self, request: RebuildRequest) -> Result<SessionPrompt, String> {
        // The identity a rebuild gives back is the one it was asked for (`composeSessionSystem` keeps the session's).
        let identity = request.header.get("promptIdentity").cloned().unwrap_or_else(|| json!({}));
        self.0.lock().unwrap().push(request);
        Ok(SessionPrompt {
            blocks: SystemBlocks { base: Some("# Tool Calls\nrules".into()), stable: Some("# Profile".into()), core: Some("# Core".into()), env: Some("# Env".into()), combined: false },
            environment_tail: "tail".into(),
            prompt_identity: identity,
            prompt_settings: json!({ "revision": "r1" }),
            sections: Default::default(),
            response_language: Value::Null,
        })
    }
}

/// The live gate list, as the test sets it.
struct Gates(Vec<String>);

#[async_trait]
impl FeatureDenied for Gates {
    async fn denied(&self) -> Result<Vec<String>, String> {
        Ok(self.0.clone())
    }
}

/// A gate list the test moves between two uses.
struct Moving(Mutex<Vec<String>>);

#[async_trait]
impl FeatureDenied for Moving {
    async fn denied(&self) -> Result<Vec<String>, String> {
        Ok(self.0.lock().unwrap().clone())
    }
}

/// The connector tools the policies switch off right now.
struct Connectors(Mutex<Vec<String>>);

#[async_trait]
impl ConnectorPermissions for Connectors {
    fn needs_approval(&self, _: &str, _: &str) -> bool {
        false
    }
    fn disabled(&self, _: &str, tool: &str) -> bool {
        self.0.lock().unwrap().iter().any(|name| name == tool)
    }
    fn project_disabled(&self, _: &ThreadId, _: &str) -> bool {
        false
    }
    async fn allow_always(&self, _: &str, _: &str) -> bool {
        false
    }
}

struct NoSkills;
#[async_trait]
impl SkillsListed for NoSkills {
    async fn any_for(&self, _: &Path) -> Result<bool, String> {
        Ok(false)
    }
}

struct Bridge(Vec<Value>);
impl ToolSurfaceHost for Bridge {
    fn bridge_tools(&self) -> Vec<Value> {
        self.0.clone()
    }
    fn mcp_server_instructions(&self, _: Option<&str>) -> Value {
        json!({})
    }
}

struct Fixed;
impl Clock for Fixed {
    fn now_ms(&self) -> i64 {
        1_700_000_000_000
    }
}

/// The keys set and unset by one patch.
type Patch = (Map<String, Value>, Vec<String>);

/// One thread: its header, and the patches written to it.
struct Threads {
    header: Mutex<Header>,
    patches: Mutex<Vec<Patch>>,
}

#[async_trait]
impl ThreadState for Threads {
    async fn header(&self, _: &ThreadId) -> Result<Header, PortError> {
        Ok(self.header.lock().unwrap().clone())
    }
    async fn patch_header(&self, _: &ThreadId, _: Map<String, Value>, _: Vec<String>) -> Result<(), PortError> {
        Ok(())
    }
    async fn patch_header_if(&self, _: &ThreadId, expect: Map<String, Value>, set: Map<String, Value>, unset: Vec<String>) -> Result<Option<Map<String, Value>>, PortError> {
        let mut header = self.header.lock().unwrap();
        for (key, value) in &expect {
            assert_eq!(header.get(key).unwrap_or(&Value::Null), value, "expected {key}");
        }
        for key in &unset {
            header.shift_remove(key);
        }
        header.extend(set.clone());
        self.patches.lock().unwrap().push((set, unset));
        Ok(None)
    }
    async fn publish(&self, _: &ThreadId, _: Section) -> Result<(), PortError> {
        Ok(())
    }
}

struct Messages(Vec<Value>);
#[async_trait]
impl ThreadMessages for Messages {
    async fn messages(&self, _: &ThreadId) -> Result<Vec<Value>, PortError> {
        Ok(self.0.clone())
    }
}

struct Live(bool);
impl LiveSessions for Live {
    fn loaded(&self) -> Vec<String> {
        Vec::new()
    }
    fn header(&self, _: &str) -> Option<Row> {
        None
    }
    fn running(&self, _: &str) -> bool {
        self.0
    }
    fn has_live_work(&self, _: &str) -> bool {
        self.0
    }
    fn runtime_stage(&self, _: &str) -> Option<String> {
        None
    }
}

struct Workflow {
    denied: Vec<String>,
    standalone: Vec<Value>,
    summary: Value,
    orchestration: String,
}
#[async_trait]
impl WorkflowSurface for Workflow {
    async fn target(&self, _: &Header, _: &str, _: Option<&str>) -> Result<WorkflowTarget, SurfaceFailure> {
        Ok(WorkflowTarget {
            summary: self.summary.clone(),
            orchestration_mode: self.orchestration.clone(),
            pack_context: String::new(),
            orchestration_context: String::new(),
            agent_catalog_context: String::new(),
            contact_catalog_context: "# Bots\n\n- Mimi (lead)".into(),
        })
    }
    async fn live_denied_tools(&self, _: &Header, _: &Value) -> Result<Vec<String>, SurfaceFailure> {
        Ok(self.denied.clone())
    }
    async fn internal_tools(&self, _: &Header) -> Result<Vec<Value>, SurfaceFailure> {
        Ok(self.standalone.clone())
    }
    async fn orchestration_instructions(&self, _: &str) -> Result<String, SurfaceFailure> {
        Ok(String::new())
    }
}
struct Rig {
    host: LeadSurfaceHost,
    threads: Arc<Threads>,
    prompts: Arc<FakePrompt>,
    connectors: Arc<Connectors>,
    generation: SurfaceGeneration,
}

/// What a test varies: the mode, the Lead's route, the gates, and the thread under reconcile.
struct Setup {
    mode: String,
    route: Value,
    feature_denied: Vec<String>,
    header: Header,
    messages: Vec<Value>,
    running: bool,
    denied: Vec<String>,
    /// modelStandaloneTools() as the workflow gates it; the pool's internal tools when None.
    standalone: Option<Vec<Value>>,
    summary: Value,
    orchestration: String,
    /// A gate list that moves while the host is in use, instead of `feature_denied`.
    live: Option<Arc<dyn FeatureDenied>>,
    /// Takes the agent definition away from this pool tool.
    without_agent_spec: Option<&'static str>,
    /// The registered pool, in registration order; the golden's when None.
    pool: Option<Vec<Arc<dyn Tool>>>,
    /// The connected servers' tools.
    mcp: Vec<Arc<dyn Tool>>,
}

fn setup(mode: &str) -> Setup {
    Setup {
        mode: mode.into(),
        route: json!({ "provider": "anthropic", "model": "claude-opus-4-6" }),
        feature_denied: Vec::new(),
        header: Header::new(),
        messages: Vec::new(),
        running: false,
        denied: Vec::new(),
        standalone: None,
        summary: json!({ "id": "default" }),
        orchestration: "balanced".into(),
        live: None,
        without_agent_spec: None,
        pool: None,
        mcp: Vec::new(),
    }
}

fn rig(g: &Value, setup: Setup) -> Rig {
    try_rig(g, setup).expect("a pool whose git and task have their agent definitions")
}

fn try_rig(g: &Value, setup: Setup) -> Result<Rig, VariantError> {
    let Setup { mode, route, feature_denied, header, messages, running, denied, standalone, summary, orchestration, live, without_agent_spec, pool, mcp } = setup;
    let mut pool = pool.unwrap_or_else(|| pool_of(g));
    if let Some(name) = without_agent_spec {
        let at = pool.iter().position(|tool| tool.spec().name == name).expect("the tool");
        pool[at] = Arc::new(Stub(pool[at].spec().clone(), None));
    }
    let threads = Arc::new(Threads { header: Mutex::new(header), patches: Mutex::default() });
    let prompts = Arc::new(FakePrompt(Mutex::default()));
    let connectors = Arc::new(Connectors(Mutex::default()));
    let generation = SurfaceGeneration::default();
    let standalone = standalone.unwrap_or_else(|| internal_tools(&pool).iter().map(tool_doc).collect());
    let host = LeadSurfaceHost::new(SurfaceSources {
        mode,
        tool_host: Arc::new(Bridge(bridge_docs(&pool))),
        pool,
        agent_tools: HashSet::from(["agent"]),
        mcp: Arc::new(Mcp(mcp)),
        cwd: "/work".into(),
        routes: Arc::new(Routes(route.as_object().expect("route").clone())),
        feature_denied: live.unwrap_or_else(|| Arc::new(Gates(feature_denied))),
        orchestration_mode: Arc::new(|| "balanced".to_owned()),
        skills: Arc::new(NoSkills),
        connectors: connectors.clone(),
        hidden_agent: Arc::new(|agent| agent == Some("title-agent")),
        prompt: prompts.clone(),
        clock: Arc::new(Fixed),
        threads: threads.clone(),
        messages: Arc::new(Messages(messages)),
        live: Arc::new(Live(running)),
        workflow: Arc::new(Workflow { denied, standalone, summary, orchestration }),
        config_revision: Arc::new(|| 0),
        surface_generation: generation.clone(),
    })?;
    Ok(Rig { host, threads, prompts, connectors, generation })
}

/// Node's pre-session surface (`createToolSurface().activeToolSurface()`) over the real tool
/// resolution, deferred catalog and standalone tools: what is eager, deferred, callable and listed.
#[tokio::test]
async fn the_preview_surface_follows_node() {
    let g = golden();
    // The standalone tools of the pool are the ones Node's runtime registered.
    let mut internal: Vec<String> = internal_tools(&pool_of(&g)).iter().map(|tool| tool.spec().name.clone()).collect();
    let mut standalone = names(&g["standalone"]);
    internal.sort();
    standalone.sort();
    assert_eq!(internal, standalone);
    assert_eq!(names(&g["agentTools"]), ["agent"]);
    for case in g["cases"].as_array().expect("cases") {
        let rig = rig(
            &g,
            Setup { route: case["route"].clone(), feature_denied: names(&case["featureDenied"]), ..setup(case["mode"].as_str().expect("mode")) },
        );
        let surface = rig.host.preview_surface().await.expect("preview");
        let expect = &case["expect"];
        let label = case["name"].as_str().expect("name");
        assert_eq!(doc_names(surface.get("tools")), names(&expect["tools"]), "{label}: tools");
        let catalog: Vec<Value> = surface["deferredToolCatalog"]
            .as_array()
            .expect("catalog")
            .iter()
            .map(|tool| json!({ "name": tool["name"], "description": tool["description"], "agentHidden": tool.pointer("/annotations/agentHidden") == Some(&json!(true)) }))
            .collect();
        assert_eq!(Value::Array(catalog), expect["catalog"], "{label}: catalog");
        assert_eq!(names(&surface["deferredCallableTools"]), names(&expect["callable"]), "{label}: callable");
        assert_eq!(names(&surface["deferredDiscoveredTools"]), names(&expect["discovered"]), "{label}: discovered");
        assert_eq!(rig.host.preview().await.expect("preview").listed, names(&expect["listed"]), "{label}: listed");
        assert_eq!(rig.host.mode(None), case["mode"].as_str().expect("mode"), "{label}: mode");
    }
}

/// A thread started with the options `thread/start` writes (`write_header`) begins with the
/// tools and the deferred surface a Lead with no session lists: Node's `createSession` +
/// `seedToolSurface` run the same resolution, denials and `applyDeferredToolSurface`.
#[tokio::test]
async fn a_new_thread_starts_with_the_tools_node_gives_it() {
    let g = golden();
    for case in g["cases"].as_array().expect("cases") {
        let mode = case["mode"].as_str().expect("mode");
        let feature_denied = names(&case["featureDenied"]);
        let rig = rig(&g, Setup { route: case["route"].clone(), feature_denied: feature_denied.clone(), ..setup(mode) });
        let mut denied: Vec<String> = LEAD_DISALLOWED_TOOLS.iter().map(|n| (*n).to_owned()).collect();
        denied.extend(feature_denied);
        let mut header = Header::new();
        header.insert("toolSpec".into(), tool_spec_for_mode(mode));
        header.insert("disallowedTools".into(), json!(denied));
        header.insert("cwd".into(), json!("/work"));
        let seeded = rig.host.seed(&ThreadId::from("t1"), &header).await.expect("seed");
        assert_eq!(rig.generation.get(), 1, "a new session moves the surface generation (`new-session-config.mjs:39`)");
        let expect = &case["expect"];
        let label = case["name"].as_str().expect("name");
        assert_eq!(doc_names(seeded.get("tools")), names(&expect["tools"]), "{label}: tools");
        assert_eq!(names(&seeded["deferredCallableTools"]), names(&expect["callable"]), "{label}: callable");
        assert_eq!(names(&seeded["deferredDiscoveredTools"]), names(&expect["discovered"]), "{label}: discovered");
        assert_eq!(surface_of_header("full".into(), &seeded).listed, names(&expect["listed"]), "{label}: listed");
        assert_eq!(seeded["cwd"], "/work");
        assert_eq!(seeded["deferredInitialRefreshPending"], true, "{label}: eligible for the first turn's MCP fold");
        // `createSession` ends with `refreshSessionBp3Environment`: the `# Session` block (folder, model) leads the environment tail.
        let env = SystemBlocks::from_header(&seeded).env.expect("env block");
        assert!(env.starts_with("# Session\nCwd: /work\nModel: ") && env.ends_with("\n\n---\n\ntail"), "{label}: env {env:?}");
        assert_eq!(seeded["sessionStartMetaInjected"], true, "{label}: session block injected");
        // The session system is composed once, at creation, by the rebuild every reconcile uses.
        let requests = rig.prompts.0.lock().unwrap();
        assert_eq!(requests.len(), 1, "{label}: one composition");
        assert_eq!(requests[0].header["promptIdentity"]["agent"], "lead");
        assert_eq!(requests[0].header["id"], "t1");
        assert!(requests[0].denied.contains(&"react".to_owned()), "{label}: BP1 omits react");
        assert_eq!(SystemBlocks::from_header(&seeded).base.as_deref(), Some("# Tool Calls\nrules"), "{label}: blocks");
        assert_eq!(seeded["promptSettings"]["revision"], "r1");
        assert_eq!(seeded["workflow"]["id"], "default");
        assert_eq!(seeded["orchestrationMode"], "balanced");
        assert_eq!(seeded["sessionMode"], "coding");
        assert!(names(&seeded["disallowedTools"]).contains(&"react".to_owned()));
        assert!(seeded.get("messages").is_none());
        // The record fields of a Lead, and the stamps of what its prompt was composed from. The roster is
        // `leadRosterRevision` of the fake workflow's slices (`"" \0 "# Bots\n\n- Mimi (lead)" \0`, sha-256).
        assert_eq!((seeded["agent"].clone(), seeded["owner"].clone(), seeded["lane"].clone()), (json!("lead"), json!("cli"), json!("cli")));
        assert_eq!(seeded["agentProfileRevision"], "coding-lead");
        assert_eq!(seeded["agentRosterRevision"], "fe1e7f32a83c59ea9da75764");
        assert_eq!(seeded["lastUsedAt"], 1_700_000_000_000_i64);
        assert_eq!((seeded["generation"].clone(), seeded["closed"].clone()), (json!(0), json!(false)));
    }
}

/// A thread just created is built from the settings as they stand (`noteToolAvailability`): its first
/// turn composes the prompt to read its settings and finds nothing to rebuild.
#[tokio::test]
async fn a_just_created_thread_is_not_rebuilt_at_its_first_turn() {
    let g = golden();
    let case = &g["cases"][0];
    let mode = case["mode"].as_str().expect("mode");
    let rig = rig(&g, Setup { route: case["route"].clone(), ..setup(mode) });
    let thread = ThreadId::from("t1");
    let mut header = Header::new();
    header.insert("toolSpec".into(), tool_spec_for_mode(mode));
    header.insert("cwd".into(), json!("/work"));
    let seeded = rig.host.seed(&thread, &header).await.expect("seed");
    assert!(rig.host.applied_to(&thread) == Some(Applied { gates: "0|".to_owned(), settings: "r1".to_owned() }));
    *rig.threads.header.lock().unwrap() = seeded;
    rig.host.reconcile_empty(&thread).await.expect("first turn");
    assert_eq!(rig.prompts.0.lock().unwrap().len(), 2, "composed at creation and read again at the turn");
    // The connectors' baseline is the one thing a first turn records.
    assert!(rig.threads.patches.lock().unwrap().iter().all(|(set, unset)| unset.is_empty() && set.keys().all(|key| key == "agentConnectorTools")));
    // A skill, plugin or MCP change moves the surface generation: the next turn rebuilds and is brought to the new key.
    rig.generation.bump();
    rig.host.reconcile_empty(&thread).await.expect("after a change");
    assert!(rig.host.applied_to(&thread) == Some(Applied { gates: "0|1|".to_owned(), settings: "r1".to_owned() }));
}

/// `createSession` denies the feature gates as they stand (`disallowedTools: [...callerDisallowedTools,
/// ...featureDisallowedTools()]`), whatever the options wrote: a header that names only the caller's denials
/// starts with the surface Node's recorder gave a session built with the gates in them, and a tool a setting
/// switches off is not in the announced deferred pool either.
#[tokio::test]
async fn a_new_thread_denies_the_gates_as_they_stand() {
    let g = golden();
    for case in g["cases"].as_array().expect("cases") {
        let mode = case["mode"].as_str().expect("mode");
        let feature_denied = names(&case["featureDenied"]);
        let rig = rig(&g, Setup { route: case["route"].clone(), feature_denied: feature_denied.clone(), ..setup(mode) });
        let mut header = Header::new();
        header.insert("toolSpec".into(), tool_spec_for_mode(mode));
        header.insert("disallowedTools".into(), json!(LEAD_DISALLOWED_TOOLS));
        header.insert("cwd".into(), json!("/work"));
        let seeded = rig.host.seed(&ThreadId::from("t1"), &header).await.expect("seed");
        let expect = &case["expect"];
        let label = case["name"].as_str().expect("name");
        assert_eq!(doc_names(seeded.get("tools")), names(&expect["tools"]), "{label}: tools");
        assert_eq!(names(&seeded["deferredCallableTools"]), names(&expect["callable"]), "{label}: callable");
        assert_eq!(names(&seeded["deferredDiscoveredTools"]), names(&expect["discovered"]), "{label}: discovered");
        assert_eq!(surface_of_header("full".into(), &seeded).listed, names(&expect["listed"]), "{label}: listed");
        let denied = names(&seeded["disallowedTools"]);
        let announced = names(&seeded["deferredAnnouncedTools"]);
        for name in &feature_denied {
            assert!(denied.contains(name), "{label}: {name} is denied");
            assert!(!announced.contains(name), "{label}: {name} is not announced");
        }
    }
}

/// `leadRosterRevision` over the slices Node's recorder gave it (`create_goldens/lead.json`).
#[test]
fn the_roster_revision_is_nodes() {
    let golden: Value = serde_json::from_str(include_str!("../../../../mixdog-core-session/src/session/create_goldens/lead.json")).expect("golden");
    let text = |key: &str| golden["parts"][key].as_str().expect("slice").to_owned();
    let target = WorkflowTarget {
        summary: Value::Null,
        orchestration_mode: String::new(),
        pack_context: String::new(),
        orchestration_context: String::new(),
        agent_catalog_context: text("agentCatalogContext"),
        contact_catalog_context: text("contactCatalogContext"),
    };
    assert_eq!(golden["record"]["agentRosterRevision"], json!(roster_revision(&target)));
}

/// A pool whose `git` has no definition for delegated agents is refused when the host is built, with
/// the tool named, instead of letting an agent's thread carry the Lead's text.
#[test]
fn a_pool_whose_git_lost_its_agent_definition_is_refused_at_construction() {
    let g = golden();
    let error = try_rig(&g, Setup { without_agent_spec: Some("git"), ..setup("full") }).err().expect("refused");
    assert_eq!(error, VariantError { tool: "git" });
    assert!(try_rig(&g, setup("full")).is_ok());
}

#[test]
fn an_unknown_mode_is_full() {
    let g = golden();
    assert_eq!(rig(&g, setup(" Whatever ")).host.mode(None), "full");
    assert_eq!(rig(&g, setup("READONLY")).host.mode(None), "readonly");
}

/// `configuredOrchestrationMode(config)`, the reader the flip hands `SurfaceSources`: the stored
/// mode, `balanced` for none or an unknown one.
#[test]
fn the_configured_orchestration_mode_is_readable_from_the_host_crate() {
    use mixdog_core_config::workflow::ids::configured_orchestration_mode;
    let doc = |value: Value| value.as_object().expect("doc").clone();
    assert_eq!(configured_orchestration_mode(&doc(json!({}))), "balanced");
    assert_eq!(configured_orchestration_mode(&doc(json!({ "orchestrationMode": "swarm" }))), "swarm");
    assert_eq!(configured_orchestration_mode(&doc(json!({ "orchestrationMode": "bogus" }))), "balanced");
}

/// A thread reports its own mode (what `thread/start` or `thread/setToolMode` wrote), not the
/// runtime's; a header from before the key is read from its spec.
#[test]
fn a_thread_reports_its_own_mode() {
    let g = golden();
    let host = rig(&g, setup("full")).host;
    let header = |value: Value| value.as_object().expect("header").clone();
    assert_eq!(host.mode(Some(&header(json!({ "toolMode": "readonly", "toolSpec": ["tools:readonly"] })))), "readonly");
    assert_eq!(host.mode(Some(&header(json!({ "toolMode": " Lead ", "toolSpec": "full" })))), "lead");
    assert_eq!(host.mode(Some(&header(json!({ "toolSpec": ["tools:readonly"] })))), "readonly");
    assert_eq!(host.mode(Some(&header(json!({})))), "full");
    assert_eq!(host.mode(None), "full");
}

/// The header of an empty thread whose surface was built before `shell` was denied.
async fn stale_header(g: &Value) -> Header {
    let mut header = rig(g, setup("full")).host.preview_surface().await.expect("preview");
    header.insert("provider".into(), json!("anthropic"));
    header.insert("model".into(), json!("claude-opus-4-6"));
    // `thread/start` writes the denials a thread begins with (the preview surface carries none).
    header.insert("disallowedTools".into(), json!([]));
    header
}

async fn reconciled(g: &Value, messages: Vec<Value>, running: bool) -> Rig {
    rig(g, Setup { header: stale_header(g).await, messages, running, denied: vec!["shell".into()], ..setup("full") })
}

/// Node rebuilds the catalog from `[...session.tools, ...extra, ...deferredCatalogUnion]` and sorts it by route rank, then measured usage,
/// then that input index (`surfaceCatalog` in `runtime-core/tool-catalog.mjs:407-424`, `sortedCatalogByMeasuredUsage` in
/// `tool-catalog-schema.mjs:133-146`). The input is the previous pass's output, so a tool that the first pass put in `tools` moves ahead of its
/// ties on the next pass: Node's catalog order is not a fixed point after one pass either. From the second pass on the input already has the
/// tools first within every tie, so the order stays. The property is therefore: the second reconcile may only reorder `deferredToolCatalog`
/// (same members), and the third changes nothing.
async fn settles_after_the_catalog_reorders_once(rig: &Rig, thread: &ThreadId) {
    let before = doc_names(rig.threads.header.lock().unwrap().get("deferredToolCatalog"));
    let written = rig.threads.patches.lock().unwrap().len();
    rig.host.reconcile_empty(thread).await.expect("second");
    {
        let patches = rig.threads.patches.lock().unwrap();
        assert!(patches.len() <= written + 1, "the second reconcile writes at most the reordered catalog");
        if patches.len() > written {
            let (set, unset) = &patches[written];
            assert!(unset.is_empty(), "the second reconcile unsets nothing: {unset:?}");
            assert_eq!(set.keys().map(String::as_str).collect::<Vec<_>>(), ["deferredToolCatalog"], "the second reconcile writes only the catalog");
        }
    }
    let after = doc_names(rig.threads.header.lock().unwrap().get("deferredToolCatalog"));
    let (mut a, mut b) = (before.clone(), after.clone());
    a.sort();
    b.sort();
    assert_eq!(a, b, "the same tools, in another order");
    let settled = rig.threads.patches.lock().unwrap().len();
    rig.host.reconcile_empty(thread).await.expect("third");
    assert_eq!(rig.threads.patches.lock().unwrap().len(), settled, "the third reconcile finds nothing to change");
}
#[tokio::test]
async fn an_empty_idle_thread_takes_the_denials_and_the_third_reconcile_changes_nothing() {
    let g = golden();
    let rig = reconciled(&g, Vec::new(), false).await;
    let thread = ThreadId::from("t1");
    rig.host.reconcile_empty(&thread).await.expect("reconcile");
    let header = rig.threads.header.lock().unwrap().clone();
    assert_eq!(names(&header["disallowedTools"]), ["shell"]);
    assert!(!doc_names(header.get("tools")).contains(&"shell".to_owned()));
    assert!(!doc_names(header.get("deferredToolCatalog")).contains(&"shell".to_owned()));
    assert_eq!(rig.threads.patches.lock().unwrap().len(), 1);
    settles_after_the_catalog_reorders_once(&rig, &thread).await;
}

#[tokio::test]
async fn a_conversation_or_a_running_turn_keeps_its_surface() {
    let g = golden();
    let thread = ThreadId::from("t1");
    let talked = reconciled(&g, vec![json!({ "role": "user", "content": "hello" })], false).await;
    talked.host.reconcile_empty(&thread).await.expect("conversation");
    assert!(talked.threads.patches.lock().unwrap().is_empty());
    let running = reconciled(&g, Vec::new(), true).await;
    running.host.reconcile_empty(&thread).await.expect("running");
    assert!(running.threads.patches.lock().unwrap().is_empty());
}

/// An empty thread with a prompt identity gets its prompt composed again and the workflow the
/// config gives now; the request carries the denials and the route.
#[tokio::test]
async fn an_empty_thread_with_a_prompt_identity_takes_a_new_prompt_and_the_workflow() {
    let g = golden();
    let mut header = stale_header(&g).await;
    header.insert("promptIdentity".into(), json!({ "systemPrompt": "", "skipAgentRules": false, "profileSkip": {}, "agent": null }));
    header.insert("workflowOverlay".into(), json!({ "id": "x" }));
    let rig = rig(&g, Setup { header, denied: vec!["shell".into()], ..setup("full") });
    rig.host.reconcile_empty(&ThreadId::from("t1")).await.expect("reconcile");
    let after = rig.threads.header.lock().unwrap().clone();
    let blocks = SystemBlocks::from_header(&after);
    assert_eq!(blocks.base.as_deref(), Some("# Tool Calls\nrules"));
    assert_eq!(after["bp3EnvironmentContext"], "tail");
    assert_eq!(after["promptSettings"]["revision"], "r1");
    assert_eq!(after["workflow"]["id"], "default");
    assert_eq!(after["orchestrationMode"], "balanced");
    assert!(after.get("workflowOverlay").is_none());
    {
        let requests = rig.prompts.0.lock().unwrap();
        assert_eq!(requests.len(), 1);
        assert_eq!(requests[0].denied, ["shell"]);
        assert_eq!(requests[0].provider, "anthropic");
        assert_eq!(requests[0].target.contact_catalog_context, "# Bots\n\n- Mimi (lead)", "the contact catalog of the workflow reaches the prompt");
        assert!(!requests[0].has_git_tool || doc_names(after.get("tools")).contains(&"git".to_owned()) || doc_names(after.get("deferredToolCatalog")).contains(&"git".to_owned()));
    }
    // The catalog reorders once at most, then nothing changes.
    settles_after_the_catalog_reorders_once(&rig, &ThreadId::from("t1")).await;
}

/// A thread with a conversation takes a moved settings gate without being re-prefixed: the tool
/// a gate opened is announced in the pending delta and the prompt is marked for a fold
/// (`stageToolAvailability`; its own cases are `fixtures/tool-availability`).
#[tokio::test]
async fn a_moved_gate_reaches_a_thread_with_a_conversation() {
    let g = golden();
    let mut header = stale_header(&g).await;
    let mut denied = names(&header["disallowedTools"]);
    denied.push("memory".to_owned());
    header.insert("disallowedTools".into(), json!(denied));
    let rig = rig(&g, Setup { header, messages: vec![json!({ "role": "user", "content": "hello" })], ..setup("full") });
    let thread = ThreadId::from("t1");
    let moved = rig.host.stage_gates(&thread).await.expect("stage").moved.expect("the gate moved");
    assert_eq!(moved.added, ["memory"]);
    let after = rig.threads.header.lock().unwrap().clone();
    assert!(!names(&after["disallowedTools"]).contains(&"memory".to_owned()));
    assert_eq!(after["promptFoldPending"], true);
    assert_eq!(after["pendingDeferredToolDelta"]["added"][0]["name"], "memory");
    assert_eq!(after["featureDeniedTools"], json!([]));
    assert_eq!(rig.threads.patches.lock().unwrap().len(), 1);
    assert!(rig.host.stage_gates(&thread).await.expect("again").moved.is_none());
    // The turn start asks for the header afterwards: a turn built from it sees the moved gate.
    let header = TurnSettings::reconcile(&rig.host, &thread, true).await.expect("turn settings");
    assert!(!names(&header["disallowedTools"]).contains(&"memory".to_owned()));
    assert_eq!(header["promptFoldPending"], true);
    // Only the MCP fold writes more (the connected names and the late pool a thread never reconciled); the gate has nothing left to write.
    let patches = rig.threads.patches.lock().unwrap();
    assert_eq!(patches.len(), 2);
    let (set, unset) = &patches[1];
    assert!(unset.is_empty());
    let mut keys: Vec<&str> = set.keys().map(String::as_str).collect();
    keys.sort_unstable();
    assert_eq!(keys, ["deferredLateToolCatalog", "deferredMcpToolNames"]);
}

/// Node's `foldMcpSurface` and the request boundary's reconcile (`fixtures/mcp-fold`, the `turn` cases), over the header
/// a thread stores: the prompt's deferred-tool block comes out of, and goes back into, the header's blocks.
fn fold_golden() -> Value {
    mixdog_js::fixture_tools::parse_golden(include_str!("../../../../../fixtures/mcp-fold/golden.json")).expect("mcp fold golden")
}

/// A recorded session as a thread's header: its leading system messages are the header's prompt blocks.
fn header_of(session: &Value) -> Header {
    let mut header = session.as_object().expect("session").clone();
    let messages = header.shift_remove("messages").and_then(|messages| messages.as_array().cloned()).unwrap_or_default();
    header.insert("bp3EnvSplit".into(), Value::Bool(true));
    SystemBlocks::from_node_messages(&messages).expect("a system prefix").write(&mut header);
    header
}

#[test]
fn the_mcp_fold_follows_node() {
    let golden = golden();
    let host = rig(&golden, setup("full")).host;
    let fold = fold_golden();
    let mut turns = 0;
    for case in fold["cases"].as_array().expect("cases").iter().filter(|case| case["suite"] == "turn") {
        let label = case["name"].as_str().expect("name");
        let thread = ThreadId::from(label);
        let mut header = header_of(&case["before"]);
        for (n, step) in case["steps"].as_array().expect("steps").iter().enumerate() {
            let live = step["live"].as_array().expect("live").clone();
            // Another writer's change between two calls (an acknowledged delta, a gate).
            for (key, value) in step["set"].as_object().into_iter().flatten() {
                header.insert(key.clone(), value.clone());
            }
            // `turn`: the turn start; `refresh`: `refreshDeferredMcpToolCatalog` over the (empty) registry.
            let (next, state) = match step["call"].as_str().expect("call") {
                "turn" => host.folded_surface(&thread, &header, &live, true),
                "refresh" => host.folded_surface(&thread, &header, &[], false),
                // The request boundary over a registry holding `live`.
                "boundary" => host.folded_surface(&thread, &header, &live, false),
                other => panic!("{label} step {n}: unknown call {other}"),
            }
            .expect(label);
            host.note_mcp_state(&thread, state);
            header = next;
            assert_eq!(header, header_of(&step["after"]), "{label} step {n}");
            turns += 1;
        }
    }
    assert!(turns > 0);
}

/// Node's `migrateToolExposureAtBoundary` and the request boundary's cache-break clean-up (`fixtures/mcp-fold`, the
/// `migrate` cases): a session persisted for another exposure than its provider's is rebuilt and what was measured
/// against the old surface is dropped; a session already on its provider's, one with no exposure yet, and one with a
/// tool call waiting for its result are left as they are.
#[test]
fn the_exposure_migration_follows_node() {
    let golden = golden();
    let host = rig(&golden, setup("full")).host;
    let fold = fold_golden();
    let (mut steps, mut migrations) = (0, 0);
    for case in fold["cases"].as_array().expect("cases").iter().filter(|case| case["suite"] == "migrate") {
        let label = case["name"].as_str().expect("name");
        let mut header = header_of(&case["before"]);
        for (n, step) in case["steps"].as_array().expect("steps").iter().enumerate() {
            for (key, value) in step["set"].as_object().into_iter().flatten() {
                header.insert(key.clone(), value.clone());
            }
            let transcript = step["transcript"].as_array().expect("transcript");
            let next = host.migrate_exposure_of(&header, crate::run_host::tool_migration::has_unanswered_tool_calls(transcript)).expect(label);
            assert_eq!(next.is_some(), step["result"] == true, "{label} step {n}");
            migrations += usize::from(next.is_some());
            if let Some(next) = next {
                header = next;
            }
            assert_eq!(header, header_of(&step["after"]), "{label} step {n}");
            steps += 1;
        }
    }
    assert_eq!((steps, migrations), (8, 4));
}

/// The request boundary migrates at every boundary (`request-boundary.mjs:67`): the thread's header is written with what
/// Node leaves (`fixtures/mcp-fold`, the `migrate` cases), once; the same transcript again finds nothing to migrate, and
/// a tool call that waits for its result is no boundary until it is answered.
#[tokio::test]
async fn the_boundary_migrates_the_thread_header_at_every_boundary() {
    let golden = golden();
    let fold = fold_golden();
    let case = |name: &str| fold["cases"].as_array().expect("cases").iter().find(|case| case["name"] == name).expect("case").clone();
    let thread = ThreadId::from("t1");
    let rows = |step: &Value| step["transcript"].as_array().expect("transcript").clone();
    let started = |case: &Value| {
        let mut header = header_of(&case["before"]);
        for (key, value) in case["steps"][0]["set"].as_object().into_iter().flatten() {
            header.insert(key.clone(), value.clone());
        }
        header
    };

    let once = case("a native session whose provider became a bridge one migrates once");
    let rig_once = rig(&golden, Setup { header: started(&once), ..setup("full") });
    let migrated = TurnSettings::migrate_exposure(&rig_once.host, &thread, &rows(&once["steps"][0])).await.expect("migrate").expect("migrated");
    assert_eq!(migrated, header_of(&once["steps"][0]["after"]));
    assert_eq!(*rig_once.threads.header.lock().unwrap(), migrated);
    assert_eq!(rig_once.threads.patches.lock().unwrap().len(), 1);
    assert!(TurnSettings::migrate_exposure(&rig_once.host, &thread, &rows(&once["steps"][1])).await.expect("again").is_none());
    assert_eq!(rig_once.threads.patches.lock().unwrap().len(), 1, "nothing left to write");

    let waiting = case("an unanswered tool call is not a safe boundary, an answered one is");
    let rig_waiting = rig(&golden, Setup { header: started(&waiting), ..setup("full") });
    assert!(TurnSettings::migrate_exposure(&rig_waiting.host, &thread, &rows(&waiting["steps"][0])).await.expect("waiting").is_none());
    assert!(rig_waiting.threads.patches.lock().unwrap().is_empty());
    let answered = TurnSettings::migrate_exposure(&rig_waiting.host, &thread, &rows(&waiting["steps"][1])).await.expect("answered").expect("migrated at the next boundary");
    assert_eq!(answered, header_of(&waiting["steps"][1]["after"]));
}

/// The loop's refresh (request boundary, tool call, `load_tool`) writes what Node's
/// `refreshDeferredMcpToolCatalog` leaves, once: the same registry again is skipped by the state cache. A thread with
/// no deferred mode is not touched.
#[tokio::test]
async fn the_loops_mcp_refresh_follows_nodes() {
    let golden = golden();
    let fold = fold_golden();
    let case = |name: &str| fold["cases"].as_array().expect("cases").iter().find(|case| case["name"] == name).expect("case").clone();
    let thread = ThreadId::from("t1");
    let moving = case("refresh: a session with a deferred mode follows the registry");
    let rig_moving = rig(&golden, Setup { header: header_of(&moving["before"]), ..setup("full") });
    rig_moving.host.refresh_mcp(&thread).await.expect("refresh");
    assert_eq!(*rig_moving.threads.header.lock().unwrap(), header_of(&moving["steps"][0]["after"]));
    assert_eq!(rig_moving.threads.patches.lock().unwrap().len(), 1);
    rig_moving.host.refresh_mcp(&thread).await.expect("again");
    assert_eq!(*rig_moving.threads.header.lock().unwrap(), header_of(&moving["steps"][1]["after"]));
    assert_eq!(rig_moving.threads.patches.lock().unwrap().len(), 1, "an unchanged registry writes nothing");
    let bare = case("refresh: a session with no deferred mode is left alone");
    let rig_bare = rig(&golden, Setup { header: header_of(&bare["before"]), ..setup("full") });
    rig_bare.host.refresh_mcp(&thread).await.expect("refresh");
    assert_eq!(*rig_bare.threads.header.lock().unwrap(), header_of(&bare["steps"][0]["after"]));
    assert!(rig_bare.threads.patches.lock().unwrap().is_empty());
}

/// The first turn clears its one-shot flag and writes the initial fold once, and nothing else before the request
/// boundary (Node's turn start returns after the fold, `turn-prepare.mjs:53-57`): no reconcile has run, so no state is
/// remembered and the late pool and connected names are not written yet. The boundary then reconciles exactly once: it
/// writes what Node's reconcile leaves, and the same registry at the next boundary is skipped by the state cache.
#[tokio::test]
async fn the_first_turn_reconciles_once_at_the_request_boundary() {
    let golden = golden();
    let fold = fold_golden();
    let case = fold["cases"].as_array().expect("cases").iter().find(|case| case["name"] == "first turn: nothing connected").expect("case");
    let rig = rig(&golden, Setup { header: header_of(&case["before"]), ..setup("full") });
    let thread = ThreadId::from("t1");
    assert_eq!(rig.threads.header.lock().unwrap().get("deferredInitialRefreshPending"), Some(&json!(true)));
    let want = header_of(&case["steps"][0]["after"]);
    assert_eq!(rig.host.fold_mcp_surface(&thread).await.expect("fold"), want);
    assert_eq!(*rig.threads.header.lock().unwrap(), want);
    assert_eq!(want["deferredInitialRefreshPending"], false);
    assert_eq!(rig.threads.patches.lock().unwrap().len(), 1);
    assert!(want.get("deferredMcpToolNames").is_none() && want.get("deferredLateToolCatalog").is_none(), "no reconcile output before the boundary");
    assert!(rig.host.mcp_state.lock().unwrap().is_empty(), "no reconcile has run, so none is remembered");
    let boundary = header_of(&case["steps"][1]["after"]);
    assert_ne!(boundary, want, "the boundary's reconcile writes the connected names and the late pool");
    rig.host.refresh_mcp(&thread).await.expect("boundary");
    assert_eq!(*rig.threads.header.lock().unwrap(), boundary);
    assert_eq!(rig.threads.patches.lock().unwrap().len(), 2, "one write for the fold, one for the boundary's reconcile");
    assert_eq!(rig.host.mcp_state.lock().unwrap().len(), 1, "the reconcile left its state");
    rig.host.refresh_mcp(&thread).await.expect("next boundary");
    assert_eq!(rig.threads.patches.lock().unwrap().len(), 2, "the same registry is not reconciled again");
}

/// The first turn of an empty thread rebuilds it whole, as Node's `reconcileTurnSettings` does for a
/// session with a prompt identity; a thread that already holds a conversation, and one Node never
/// rebuilds (no identity), take only the moved gates.
#[tokio::test]
async fn the_first_turn_of_an_empty_thread_rebuilds_it_and_other_threads_are_left_alone() {
    let g = golden();
    let identity = json!({ "systemPrompt": "", "skipAgentRules": false, "profileSkip": {}, "agent": null });
    let thread = ThreadId::from("t1");
    let base = stale_header(&g).await;
    let with = |identity: Option<&Value>| {
        let mut header = base.clone();
        if let Some(identity) = identity {
            header.insert("promptIdentity".into(), identity.clone());
        }
        rig(&g, Setup { header, denied: vec!["shell".into()], ..setup("full") })
    };

    let first = with(Some(&identity));
    let header = TurnSettings::reconcile(&first.host, &thread, false).await.expect("first turn");
    assert_eq!(first.prompts.0.lock().unwrap().len(), 1, "the prompt is composed again");
    assert_eq!(header["promptSettings"]["revision"], "r1");
    assert_eq!(names(&header["disallowedTools"]), ["shell"], "the turn is built from the rebuilt header");
    assert!(!doc_names(header.get("tools")).contains(&"shell".to_owned()));

    let later = with(Some(&identity));
    let kept = TurnSettings::reconcile(&later.host, &thread, true).await.expect("later turn");
    // The prompt is composed only to read its sections (the settings comparison); its blocks and denials are not taken.
    assert_eq!(later.prompts.0.lock().unwrap().len(), 1, "a conversation compares its settings with the sections as they stand");
    // A prompt from before settings were recorded presents what the sections give; the thread's own denials are still the ones it began with (`stale_header` writes `[]`, as `thread/start` does), not the rebuilt `["shell"]`.
    assert!(kept.get("promptSettings").is_some());
    assert!(kept.get("promptSettingsNotice").is_none());
    assert_eq!(kept["disallowedTools"], json!([]));

    let legacy = with(None);
    TurnSettings::reconcile(&legacy.host, &thread, false).await.expect("no identity");
    assert!(legacy.prompts.0.lock().unwrap().is_empty(), "a session without an identity is never rebuilt");
    assert!(legacy.threads.patches.lock().unwrap().iter().all(|(set, _)| !set.contains_key("promptSettings") && !set.contains_key("disallowedTools")));
}

/// A conversation's prompt settings are compared with the sections as they stand at each turn start
/// (`reconcileSession`): what differs from its prompt is told once by a staged notice and folds in at the next
/// cold point; a turn start that finds the same gates and sections stages nothing again.
#[tokio::test]
async fn a_conversation_is_told_the_settings_that_moved_since_its_prompt() {
    let g = golden();
    let mut header = stale_header(&g).await;
    header.insert("promptIdentity".into(), json!({ "systemPrompt": "", "skipAgentRules": false, "profileSkip": {}, "agent": null }));
    let presented = OwnedSections { core_memory: "# Core Memory\nOld".into(), ..OwnedSections::default() };
    header.insert("promptSettings".into(), presented.record());
    let rig = rig(&g, Setup { header, messages: vec![json!({ "role": "user", "content": "hello" })], ..setup("full") });
    let thread = ThreadId::from("t1");
    let after = TurnSettings::reconcile(&rig.host, &thread, true).await.expect("turn settings");
    let notice = after["promptSettingsNotice"]["content"].as_str().expect("a staged notice");
    assert!(notice.contains("# Core Memory\nCore memory was updated"), "{notice}");
    assert_eq!(after["promptFoldPending"], true);
    assert_eq!(after["promptSettingsNotice"]["revision"], 1);
    let written = rig.threads.patches.lock().unwrap().len();
    let again = TurnSettings::reconcile(&rig.host, &thread, true).await.expect("same gates, same sections");
    assert_eq!(again["promptSettingsNotice"], after["promptSettingsNotice"], "the same notice is not staged again");
    assert_eq!(rig.threads.patches.lock().unwrap().len(), written, "nothing left to write");
}

/// A connector switched off between two turn starts reaches the second one: the first records the
/// baseline, the move joins the pending delta (`stageConnectorAvailability`; its cases are
/// `fixtures/connector-availability`).
#[tokio::test]
async fn a_switched_off_connector_reaches_the_next_turn() {
    let g = golden();
    let mut header = stale_header(&g).await;
    let docs = |names: &[&str]| Value::Array(names.iter().map(|n| json!({ "name": n, "description": format!("{n} tool") })).collect());
    header.insert("tools".into(), docs(&["read", "mcp__alpha__list"]));
    header.insert("deferredToolCatalog".into(), docs(&["read", "mcp__alpha__list", "mcp__beta__ping"]));
    let rig = rig(&g, Setup { header, messages: vec![json!({ "role": "user", "content": "hello" })], ..setup("full") });
    let thread = ThreadId::from("t1");
    let first = rig.host.stage_gates(&thread).await.expect("stage");
    assert!(first.connectors.is_none(), "the first call is the baseline");
    assert_eq!(first.header["agentConnectorTools"], json!(["mcp__alpha__list", "mcp__beta__ping"]));
    *rig.connectors.0.lock().unwrap() = vec!["mcp__alpha__list".to_owned()];
    let second = rig.host.stage_gates(&thread).await.expect("stage");
    assert_eq!(second.connectors.expect("alpha switched off").removed, ["mcp__alpha__list"]);
    assert_eq!(second.header["pendingDeferredToolDelta"]["removed"], json!(["mcp__alpha__list"]));
    assert_eq!(second.header["agentConnectorTools"], json!(["mcp__beta__ping"]));
}

/// The gates are read on every use, never kept: a gate that moves between two turn starts is seen by
/// the second one.
#[tokio::test]
async fn the_gates_are_read_fresh_on_every_use() {
    let g = golden();
    let moving = Arc::new(Moving(Mutex::default()));
    let rig = rig(&g, Setup { header: stale_header(&g).await, messages: vec![json!({ "role": "user", "content": "hello" })], live: Some(moving.clone()), ..setup("full") });
    let thread = ThreadId::from("t1");
    let first = rig.host.stage_gates(&thread).await.expect("stage");
    assert!(first.moved.is_none());
    assert_eq!(first.header["featureDeniedTools"], json!([]));
    *moving.0.lock().unwrap() = vec!["memory".to_owned()];
    let second = rig.host.stage_gates(&thread).await.expect("stage");
    assert_eq!(second.moved.expect("memory closed").removed, ["memory"]);
    assert_eq!(second.header["featureDeniedTools"], json!(["memory"]));
    assert!(names(&second.header["disallowedTools"]).contains(&"memory".to_owned()));
}

/// A thread without a prompt identity keeps its prompt (Node recomposes only what has an identity).
#[tokio::test]
async fn a_thread_without_a_prompt_identity_is_not_recomposed() {
    let g = golden();
    let rig = reconciled(&g, Vec::new(), false).await;
    rig.host.reconcile_empty(&ThreadId::from("t1")).await.expect("reconcile");
    assert!(rig.prompts.0.lock().unwrap().is_empty());
}

/// Node's `reconcileEmptySession` over a Lead and delegated workers built by `composeSessionSystem`
/// (`fixtures/surface-reconcile`): the same tool surface, denials and workflow afterwards, and a
/// conversation or a running turn left alone. The workflow, the denials and the prompt are the
/// ports' answers (here Node's own), so this holds the host's pipeline to Node's.
#[tokio::test]
async fn the_reconcile_follows_node() {
    let g: Value = mixdog_js::fixture_tools::parse_golden(include_str!("../../../../../fixtures/surface-reconcile/golden.json")).expect("golden");
    let pool = golden();
    for case in g["cases"].as_array().expect("cases") {
        let label = case["name"].as_str().expect("name");
        let mut header = case["before"].as_object().expect("before").clone();
        // The recorded conversation cases end in user rows; the blocks are the leading system messages (the rig adds the conversation itself).
        let prefix: Vec<Value> = case["beforeMessages"].as_array().expect("messages").iter().take_while(|m| m["role"] == "system").cloned().collect();
        let blocks = SystemBlocks::from_node_messages(&prefix).expect("a system prefix");
        blocks.write(&mut header);
        let conversation = label.contains("conversation");
        let rig = reconcile_rig(&pool, &g, case, header, conversation);
        let thread = ThreadId::from("t1");
        rig.host.reconcile_empty(&thread).await.expect(label);
        let after = rig.threads.header.lock().unwrap().clone();
        if !case["reconciled"].as_bool().expect("reconciled") {
            assert!(rig.threads.patches.lock().unwrap().is_empty(), "{label}: left alone");
            continue;
        }
        let node = &case["after"];
        assert_eq!(doc_names(after.get("tools")), names(&node["tools"]), "{label}: tools");
        assert_eq!(doc_names(after.get("deferredToolCatalog")), names(&node["catalog"]), "{label}: catalog");
        assert_eq!(names(&after["deferredCallableTools"]), names(&node["callable"]), "{label}: callable");
        assert_eq!(names(after.get("deferredDiscoveredTools").unwrap_or(&json!([]))), names(&node["discovered"]), "{label}: discovered");
        assert_eq!(after["disallowedTools"], node["disallowedTools"], "{label}: denials");
        assert_eq!(after["workflow"], node["workflow"], "{label}: workflow");
        assert_eq!(after["orchestrationMode"], node["orchestrationMode"], "{label}: orchestration mode");
        assert_eq!(after["sessionMode"], node["sessionMode"], "{label}: session mode");
        assert_eq!(after["promptIdentity"], case["before"]["promptIdentity"], "{label}: identity");
        let requests = rig.prompts.0.lock().unwrap();
        assert_eq!(requests[0].denied, names(&node["disallowedTools"]), "{label}: BP1 omits the denied tools");
    }
}

/// The host over a recorded session: Node's denials and workflow, the recorded prompt.
fn reconcile_rig(pool: &Value, g: &Value, case: &Value, header: Header, conversation: bool) -> Rig {
    let route = case["route"].clone();
    let running = case["name"].as_str().expect("name").contains("running");
    let rig = rig(
        pool,
        Setup {
            route,
            header,
            running,
            messages: if conversation { vec![json!({ "role": "user", "content": "hello" })] } else { Vec::new() },
            denied: names(&case["after"]["disallowedTools"]),
            feature_denied: names(&case["featureDenied"]),
            standalone: Some(g["standalone"].as_array().expect("standalone").clone()),
            summary: case["workflowSummary"].clone(),
            orchestration: case["orchestrationMode"].as_str().expect("mode").to_owned(),
            ..setup("full")
        },
    );
    rig
}
// ---- the provider tool array, replayed from Node's recording (`fixtures/tool-resolution/golden.json`) ----

use mixdog_agent::tools::ToolSet;
use mixdog_core_api::domain::provider::ToolDefinition;
use mixdog_tools::policy::SessionSurface;

use crate::run_host::assemble::SessionTools;
use crate::run_host::context_world::snapshot_tools;
use crate::run_host::resume_tools::McpToolNames;
use crate::run_host::resume_tools::ResumeTools;
use crate::run_host::route_surface::resumed_surface_change;
use crate::run_host::rules::RulesPolicy;
use crate::run_host::session_tools::SessionToolBuilder;

fn recording() -> Value {
    mixdog_js::fixture_tools::parse_golden(include_str!("../../../../../fixtures/tool-resolution/golden.json")).expect("tool-resolution golden")
}

/// The order the daemon builds its pool in (`compose_flip`): `orch::register::tools`, then `code_graph`, the
/// file, shell and git tools, the web tools and the memory tools. It is an input, not an expectation: Node's own
/// order for the same tools is `STANDALONE_ORDER`'s to give.
const DAEMON_ORDER: [&str; 36] = [
    "load_tool", "call_tool", "Skill", "session", "agent", "explore", "todo", "goal", "ask_user", "handoff_user", "react", "setup", "media", "tidy", "office", "browser",
    "browser_devtools", "visualize", "terminal", "computer", "code_graph", "read", "edit", "shell", "git", "github", "task", "grep", "glob", "find", "list", "apply_patch",
    "web_search", "web_fetch", "memory", "recall",
];

/// The recorded pool in the daemon's registration order, each tool with the definition delegated agents are sent where Node binds one.
fn recorded_pool(r: &Value) -> Vec<Arc<dyn Tool>> {
    let entries = r["pool"]["tools"].as_array().expect("pool");
    assert_eq!(entries.len(), DAEMON_ORDER.len(), "every recorded tool has a place in the daemon's order");
    DAEMON_ORDER
        .iter()
        .map(|name| {
            let entry = entries.iter().find(|entry| entry["name"] == *name).unwrap_or_else(|| panic!("{name} is in the recording"));
            Arc::new(Stub(spec_of_doc(&entry["definition"]), entry.get("agent").map(spec_of_doc))) as Arc<dyn Tool>
        })
        .collect()
}

fn recorded_mcp(r: &Value) -> Vec<Arc<dyn Tool>> {
    r["pool"]["mcpTools"].as_array().expect("mcp tools").iter().map(|doc| Arc::new(Stub(spec_of_doc(doc), None)) as Arc<dyn Tool>).collect()
}

/// What is compared of a tool on the wire: its name, text, schema and `deferLoading`.
fn wire(tool: &ToolDefinition) -> Value {
    json!({ "name": tool.name, "description": tool.description, "inputSchema": tool.input_schema, "deferLoading": tool.defer_loading })
}

fn node_wire(r: &Value, case: &Value) -> Vec<Value> {
    case["provider"]
        .as_array()
        .expect("provider")
        .iter()
        .map(|entry| {
            let tool = &r["definitions"][entry["definition"].as_str().expect("definition id")];
            json!({ "name": tool["name"], "description": tool["description"], "inputSchema": tool["inputSchema"], "deferLoading": entry.get("deferLoading") == Some(&Value::Bool(true)) })
        })
        .collect()
}

/// No connected server names its tools differently from the recording.
struct Unshortened;
impl McpToolNames for Unshortened {
    fn names(&self, _: &str) -> Option<(String, String)> {
        None
    }
}

/// `getHiddenAgent(agent)` as the recording took it.
struct Role(bool);
impl RulesPolicy for Role {
    fn hidden_agent(&self, _: Option<&str>) -> bool {
        self.0
    }
    fn delegation_disabled(&self, _: &Value, _: bool) -> bool {
        false
    }
}

/// What a request of `header` carries: the session's tools in the header's order (`SessionToolBuilder`), as the loop's
/// `ToolSet` lists them to the model, then the request boundary's snapshot (`McpCatalog::snapshot`).
async fn request_tools(pool: &[Arc<dyn Tool>], mcp: &[Arc<dyn Tool>], header: &Header) -> Vec<ToolDefinition> {
    let builder = SessionToolBuilder::new(pool.to_vec(), Arc::new(Mcp(mcp.to_vec())), Arc::new(NoSkills)).expect("a pool with the agent definitions");
    let surface = SessionSurface::from_header(header, Vec::new());
    let SessionTools { tools, builtins, agent } = builder.tools(header, &surface).await.expect("tools");
    let provider = header.get("provider").and_then(Value::as_str).unwrap_or_default();
    snapshot_tools(header, ToolSet::with_builtins(tools, builtins).for_agent(agent).definitions(), Vec::new(), provider)
}

/// A Lead thread started as `thread/start` writes it: the host seeds its tools and deferred surface.
async fn lead_request(pool: &[Arc<dyn Tool>], mcp: &[Arc<dyn Tool>], case: &Value) -> Vec<ToolDefinition> {
    let input = &case["input"];
    let (provider, model) = (input["provider"].clone(), input["model"].clone());
    let mode = if input["mode"] == "readonly" { "readonly" } else { "lead" };
    let rig = rig(
        &Value::Null,
        Setup {
            route: json!({ "provider": provider, "model": model }),
            feature_denied: names(&input["featureDenied"]),
            pool: Some(pool.to_vec()),
            mcp: mcp.to_vec(),
            ..setup(mode)
        },
    );
    let mut header = Header::new();
    header.insert("toolSpec".into(), case["toolSpec"].clone());
    header.insert("disallowedTools".into(), input["callerDisallowed"].clone());
    if input["schemaAllowedTools"].is_array() {
        header.insert("schemaAllowedTools".into(), input["schemaAllowedTools"].clone());
    }
    header.insert("cwd".into(), json!("/work"));
    header.insert("provider".into(), provider);
    header.insert("model".into(), model);
    let seeded = rig.host.seed(&ThreadId::from(input["sessionId"].as_str().expect("session id")), &header).await.expect(case["name"].as_str().expect("name"));
    request_tools(pool, mcp, &seeded).await
}

/// A delegated worker's thread: its tools resolved as a stored session's are (`ResumeTools`), then the
/// agent exposure of its route (`applyAgentToolExposure`).
async fn worker_request(pool: &[Arc<dyn Tool>], mcp: &[Arc<dyn Tool>], case: &Value) -> Vec<ToolDefinition> {
    let input = &case["input"];
    let hidden = case["hiddenAgent"] == true;
    let mut header = Header::new();
    header.insert("id".into(), input["sessionId"].clone());
    header.insert("owner".into(), json!("agent"));
    header.insert("agent".into(), input["agent"].clone());
    header.insert("provider".into(), input["provider"].clone());
    header.insert("model".into(), input["model"].clone());
    header.insert("cwd".into(), json!("/work"));
    header.insert("disallowedTools".into(), case["persisted"]["disallowedTools"].clone());
    if case["persisted"]["schemaAllowedTools"].is_array() {
        header.insert("schemaAllowedTools".into(), case["persisted"]["schemaAllowedTools"].clone());
    }
    let resume = ResumeTools { pool: pool.to_vec(), mcp: Arc::new(Mcp(mcp.to_vec())), mcp_names: Arc::new(Unshortened), skills: Arc::new(NoSkills), policy: Arc::new(Role(hidden)) };
    let prepared = resume.prepare_tools(&header).await.expect("prepared");
    let host = Bridge(bridge_docs(pool));
    let surface = ToolSurface { host: &host, clock: &Fixed };
    let change = resumed_surface_change(&surface, &Fixed, &header, prepared, hidden);
    for key in &change.unset {
        header.shift_remove(key);
    }
    header.extend(change.set);
    request_tools(pool, mcp, &header).await
}

/// The tool array each kind of session sends the provider is Node's: which tools, in which order, with which
/// definitions. Node's resolution drops the hidden tools, sorts the public internal and MCP tools by name, ranks them
/// by route, appends `todo`, and a bridge surface appends `load_tool` and `call_tool` after (`tool-resolution.mjs`,
/// `tool-catalog.mjs`); the deferred anchor rides last on an Anthropic route. The pool is registered in the
/// daemon's order, not Node's.
#[tokio::test]
async fn the_provider_tool_array_follows_node_for_every_recorded_session() {
    let r = recording();
    let (pool, mcp) = (recorded_pool(&r), recorded_mcp(&r));
    for case in r["cases"].as_array().expect("cases") {
        let label = case["name"].as_str().expect("name");
        let sent = if case["input"]["kind"] == "worker" { worker_request(&pool, &mcp, case).await } else { lead_request(&pool, &mcp, case).await };
        let sent: Vec<Value> = sent.iter().map(wire).collect();
        let node = node_wire(&r, case);
        let names_of = |tools: &[Value]| tools.iter().map(|tool| tool["name"].as_str().unwrap_or_default().to_owned()).collect::<Vec<_>>();
        assert_eq!(names_of(&sent), names_of(&node), "{label}: tools and their order");
        assert_eq!(sent, node, "{label}: definitions");
    }
}

/// `standalone_tools` lists the pool's standalone tools as `collectStandaloneToolDefs` does, whatever order the pool was registered in.
#[test]
fn the_standalone_tools_are_in_nodes_order_whatever_the_pool_order() {
    let r = recording();
    let pool = recorded_pool(&r);
    let ours: Vec<String> = internal_tools(&pool).iter().map(|tool| tool.spec().name.clone()).collect();
    assert_eq!(ours, names(&r["pool"]["standalone"]));
}
