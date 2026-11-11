//! Node's request half of "skill dependencies are callable on the next request without changing the eager tools"
//! (`fixtures/skill-tool-loading-cases` `wire`, `record-skill-tool-loading-cases.mjs`), per provider through a real
//! session thread (the `SessionDirectory` over the `RunHostFactory`):
//!
//! * the test's session opened by [`ToolSurface::apply`] and written to the thread's header;
//! * the real `Skill` tool ([`SkillTool`] over [`CatalogSkillPort`]: the skill catalog on the data dir, the
//!   [`HeaderSkillArm`] over the thread, the thread's transcript) loading `deck-guide` twice; the whole result, the
//!   injected messages and the whole session after each, then the request tools before and after
//!   ([`request_definitions`]) and the session rebuilt for `openai-oauth`;
//! * a turn whose provider calls `Skill` twice and ends: each request the loop sent, with its tools snapshotted at the
//!   boundary as the product does ([`boundary_tools`]), encoded by the provider's own codec; the whole wire tools and,
//!   for OpenAI and Anthropic, the whole transcript part of the body, against Node's;
//! * `skillToolContent` (the MCP caller's Skill): the same tool once on `openai-oauth`.
//!
//! A session is compared as Node's whole session object against the header's same keys (the header also holds the
//! thread's own metadata, which Node keeps outside the session).

use std::sync::OnceLock;
use std::sync::Weak;

use mixdog_ai::providers::anthropic::AnthropicCodec;
use mixdog_ai::providers::anthropic::AnthropicConfig;
use mixdog_ai::providers::anthropic::Flavor;
use mixdog_ai::providers::compat::chat::CompatChatCodec;
use mixdog_ai::providers::compat::chat::CompatConfig;
use mixdog_ai::providers::compat::profile::CompatProfile;
use mixdog_ai::providers::google::codec::GEMINI_ORIGIN;
use mixdog_ai::providers::google::codec::GoogleCodec;
use mixdog_ai::providers::google::traits::ModelTraits;
use mixdog_ai::providers::google::traits::ThinkingControl;
use mixdog_ai::providers::openai::codec::OpenAiCodec;
use mixdog_ai::providers::openai::config::CodexIdentity;
use mixdog_ai::providers::openai::config::NoFacts;
use mixdog_ai::providers::openai::config::OpenAiConfig;
use mixdog_ai::providers::openai::config::WireContext;
use mixdog_core_api::domain::keepalive::TransportKind;
use mixdog_core_api::domain::provider::ToolDefinition;
use mixdog_core_ports::ports::route::Route;
use mixdog_core_ports::ports::route::RouteSession;
use mixdog_core_ports::ports::threads::ThreadState;
use mixdog_core_session::session::NoRouteExclusions;
use mixdog_core_session::session::testing::eventually_on_awaiting;
use mixdog_core_session::session::thread_state::SessionThreads;
use mixdog_mcp::skill_catalog::SkillCatalog;
use mixdog_mcp::skill_catalog::SkillSettings;
use mixdog_mcp::skill_catalog::SkillSettingsSource;
use mixdog_mcp::skill_port::CatalogSkillPort;
use mixdog_mcp::skill_port::TranscriptTexts;
use mixdog_mcp::skills::SkillRoot;
use mixdog_mcp::skills::SkillSource;
use mixdog_mcp::skills_watch::SkillsWatch;
use mixdog_tools::orch::skill::SkillTool;
use mixdog_tools::orch::util::PortError;
use mixdog_tools::policy::ConnectorPermissions;

use super::*;
use crate::run_host::context_world::request_definitions;
use crate::run_host::skill_session::HeaderSkillArm;
use crate::run_host::skill_session::ThreadTranscript;
use crate::run_host::tool_surface::ApplyOptions;
use crate::run_host::tool_surface::SurfaceHost;
use crate::run_host::tool_surface::ToolSurface;

fn recording() -> Value {
    serde_json::from_str(mixdog_testkit::fixture!("../../fixtures/skill-tool-loading-cases/golden.json")).expect("json")
}

/// The bridge's own definitions (`TOOL_BRIDGE_TOOLS`) and no connected server.
struct Bridge(Vec<Value>);

impl SurfaceHost for Bridge {
    fn bridge_tools(&self) -> Vec<Value> {
        self.0.clone()
    }
    fn mcp_server_instructions(&self, _: Option<&str>) -> Value {
        Value::Null
    }
}

/// No connector or project switch is set.
struct Open;

#[async_trait]
impl ConnectorPermissions for Open {
    fn needs_approval(&self, _: &str, _: &str) -> bool {
        false
    }
    fn disabled(&self, _: &str, _: &str) -> bool {
        false
    }
    fn project_disabled(&self, _: &ThreadId, _: &str) -> bool {
        false
    }
    async fn allow_always(&self, _: &str, _: &str) -> bool {
        false
    }
}

struct NoSettings;
impl SkillSettingsSource for NoSettings {
    fn current(&self) -> SkillSettings {
        SkillSettings::default()
    }
}

/// Node's `executeTool` outside a loop reads `session.messages`, which the test leaves empty.
struct NoTexts;
#[async_trait]
impl TranscriptTexts for NoTexts {
    async fn user_texts(&self, _: &ThreadId) -> Result<Vec<String>, PortError> {
        Ok(Vec::new())
    }
}

/// The running turn's working messages, as the product's route adapter reads them (`turn_messages`).
struct Live(Weak<SessionDirectory>);

#[async_trait]
impl RouteSession for Live {
    fn generation(&self, _: &ThreadId) -> u64 {
        0
    }
    async fn live_turn_messages(&self, thread: &ThreadId) -> Result<Vec<Value>, PortError> {
        Ok(self.0.upgrade().and_then(|directory| directory.handle(thread)).map(|handle| (*handle.turn_messages_snapshot()).clone()).unwrap_or_default())
    }
    fn has_user_conversation(&self, _: &[Value]) -> bool {
        unreachable!("the transcript asks for messages only")
    }
    async fn update_route(&self, _: &ThreadId, _: Route, _: bool) -> Result<bool, PortError> {
        unreachable!("the transcript asks for messages only")
    }
    async fn record_boundary(&self, _: &ThreadId, _: &str, _: Value) -> Result<bool, PortError> {
        unreachable!("the transcript asks for messages only")
    }
    async fn rebuild_tool_surface(&self, _: &ThreadId, _: &str) -> Result<(), PortError> {
        unreachable!("the transcript asks for messages only")
    }
    async fn owner_fallbacks(&self, _: &ThreadId, _: &mixdog_store::schema::record::Header, _: &str, _: &str) -> Result<Option<Vec<Value>>, PortError> {
        unreachable!("the transcript asks for messages only")
    }
    fn write_statusline(&self, _: &ThreadId, _: &Route) {}
    fn invalidate_context_status(&self, _: &ThreadId) {}
}

/// One of the session's tools, under the definition the session holds: `Skill` is the real tool, and the test's
/// provider never calls another.
struct Defined {
    spec: ToolSpec,
    skill: Option<Arc<dyn Tool>>,
}

#[async_trait]
impl Tool for Defined {
    fn spec(&self) -> &ToolSpec {
        &self.spec
    }
    async fn call(&self, ctx: &ToolContext, args: JsonValue) -> ToolOutcome {
        self.skill.as_ref().expect("the provider calls only Skill").call(ctx, args).await
    }
}

fn spec_of(doc: &Value) -> ToolSpec {
    let hint = |key: &str| doc["annotations"][key].as_bool();
    ToolSpec {
        name: doc["name"].as_str().expect("name").to_owned(),
        title: None,
        trigger: None,
        public: true,
        aliases: Vec::new(),
        description: doc["description"].as_str().unwrap_or_default().to_owned(),
        input_schema: doc["inputSchema"].clone(),
        annotations: ToolAnnotations { read_only_hint: hint("readOnlyHint"), destructive_hint: hint("destructiveHint"), ..ToolAnnotations::default() },
        parallel_safe: false,
        exclusive_with: Vec::new(),
    }
}

/// The test's provider: `Skill` on the first two requests, then an answer; every request is kept.
struct Calls {
    id: ProviderId,
    policy: RetryPolicy,
    keepalive: KeepaliveSchedule,
    codec: MockCodec,
    requests: Mutex<Vec<Arc<ModelRequest>>>,
}

#[async_trait]
impl ProviderAdapter for Calls {
    fn id(&self) -> &ProviderId {
        &self.id
    }
    fn codec(&self) -> &dyn WireCodec {
        &self.codec
    }
    fn retry_policy(&self) -> &RetryPolicy {
        &self.policy
    }
    fn keepalive(&self) -> &KeepaliveSchedule {
        &self.keepalive
    }
    async fn attempt(&self, request: Arc<ModelRequest>) -> Result<Box<dyn ModelStream>, ProviderError> {
        let n = {
            let mut requests = lock(&self.requests);
            requests.push(request);
            requests.len()
        };
        let completed = |stop| StreamEvent::Completed { stop: Some(stop), pricing_model: None, request_ms: None };
        let steps = if n <= 2 {
            vec![StreamEvent::ToolCallDone(ToolCall { id: format!("skill-{n}"), name: "Skill".into(), arguments: json!({ "name": "deck-guide" }), native_type: None }), completed(StopReason::ToolUse)]
        } else {
            vec![StreamEvent::TextDelta("done".into()), completed(StopReason::EndTurn)]
        };
        Ok(Box::new(Steps(steps.into())))
    }
}

struct WireRun {
    provider: Arc<Calls>,
    workspace: std::path::PathBuf,
    skill: OnceLock<Arc<dyn Tool>>,
    directory: OnceLock<Weak<SessionDirectory>>,
}

#[async_trait]
impl RunParts for WireRun {
    async fn reconcile_turn(&self, _: &ThreadId, header: mixdog_store::schema::record::Header, _: bool) -> Result<mixdog_store::schema::record::Header, TurnError> {
        Ok(header)
    }

    async fn assemble(&self, input: AssembleInput<'_>) -> Result<Assembled, TurnError> {
        let tokens = mixdog_rt::testing::tokens();
        let skill = self.skill.get().expect("bound").clone();
        let docs = input.header.get("tools").and_then(Value::as_array).cloned().unwrap_or_default();
        let tools: Vec<Arc<dyn Tool>> = docs
            .iter()
            .map(|doc| {
                let spec = spec_of(doc);
                let skill = (spec.name == "Skill").then(|| skill.clone());
                Arc::new(Defined { spec, skill }) as Arc<dyn Tool>
            })
            .collect();
        Ok(Assembled {
            provider: self.provider.clone(),
            tools: ToolSet::new(tools),
            tool_env: ToolEnv {
                thread_id: input.thread.clone(),
                turn_id: input.turn.clone(),
                cwd: mixdog_core_api::domain::common::AbsPath::new(self.workspace.clone()).unwrap(),
                surface: SurfaceKind::Lead,
                io: ToolIo { interactive: tokens.interactive_io, durability: tokens.durability_io, maintenance: tokens.maintenance_io },
                approvals: Arc::new(MockApprovalGate::default()),
                files: Arc::new(MockFileService::default()),
                processes: Arc::new(MockProcessManager::default()),
                progress: input.progress.clone(),
                deadline_of: None,
                notify: input.notify.clone(),
                review: None,
            },
            gate: Box::new(|_| Arc::new(AllowAll)),
            worktree: self.workspace.to_string_lossy().into_owned(),
            config: RunConfig::new(input.thread.clone(), input.turn.clone(), "m"),
            clock: Arc::new(Fixed),
            decider: Arc::new(MockRetryDecider),
            guards: Arc::new(NoGuards),
            compactor: None,
            route: None,
            skills: None,
            hooks: None,
            reuse: None,
            reactions: None,
            reaction_scope: None,
            rows: Arc::default(),
            tail: None,
            side: None,
            step_judge: None,
            artifacts: None,
            images: None,
            failures: None,
            blobs: Arc::new(NoBlobs),
            carry: RunCarry::default(),
        })
    }

    /// As the product's assembly takes it (`HostRunParts::request_snapshot`): the live header's snapshot.
    async fn request_snapshot(&self, thread: &ThreadId, tools: Vec<ToolDefinition>, native: Vec<Value>) -> Result<Vec<ToolDefinition>, TurnError> {
        let directory = self.directory.get().and_then(Weak::upgrade).expect("the directory");
        let header = directory.live_header(thread).header();
        Ok(crate::run_host::assemble::boundary_tools(&header, tools, &native))
    }
}

struct Ctx;

impl WireContext for Ctx {
    fn request_id(&self) -> String {
        "0".repeat(32)
    }
    fn now_unix_ms(&self) -> u64 {
        0
    }
    fn turn_state(&self, _: &str, _: &str) -> Option<String> {
        None
    }
}

struct AllGemini;

impl ModelTraits for AllGemini {
    fn is_gemini_family(&self, _: &str) -> bool {
        true
    }
    fn thinking(&self, _: &str) -> ThinkingControl {
        ThinkingControl::Unspecified
    }
}

/// `request` as `provider`'s own codec puts it on the wire: the whole body.
fn body_of(provider: &str, request: &ModelRequest) -> Value {
    let wire = match provider {
        "openai-oauth" => {
            let identity = CodexIdentity { installation_id: "i".into(), user_agent: "ua".into(), version: "1".into(), beta_features: String::new() };
            OpenAiCodec::new(OpenAiConfig::codex(false, true, identity, Arc::new(NoFacts), Arc::new(Ctx)), TransportKind::Http1).encode(request)
        }
        "anthropic-oauth" => AnthropicCodec::new(Flavor::ApiKey, AnthropicConfig::new(Arc::new(|_: &str| None))).encode(request),
        "gemini" => GoogleCodec::gemini(GEMINI_ORIGIN, Arc::new(AllGemini)).encode(request),
        _ => {
            let profile = CompatProfile::openrouter();
            let config = CompatConfig::for_profile(&profile);
            CompatChatCodec::new(profile, config).encode(request)
        }
    };
    serde_json::from_slice(&wire.expect("encodes").body).expect("a JSON body")
}

/// The request's tools as the provider's body carries them (Gemini: its one declarations entry), and the
/// transcript part of the body where the recording keeps it.
fn wire_of(provider: &str, request: &ModelRequest) -> Value {
    let body = body_of(provider, request);
    let tools = if provider == "gemini" { body["tools"][0].clone() } else { body["tools"].clone() };
    let input = match provider {
        "openai-oauth" => body["input"].clone(),
        "anthropic-oauth" => body["messages"].clone(),
        _ => Value::Null,
    };
    json!({ "tools": tools, "input": input })
}

/// A request with no messages and `tools`, as the provider sends the tools alone.
fn tools_of(provider: &str, tools: Vec<ToolDefinition>) -> Value {
    let request = ModelRequest { model: "m".into(), messages: vec![mixdog_core_api::domain::provider::Message::new(Role::User, mixdog_core_api::domain::provider::Content::Text("go".into()))], tools, options: Default::default() };
    wire_of(provider, &request)["tools"].clone()
}

/// The manifest's declared difference: a tool the test defines with no `description` reaches Node's wire with the key
/// absent (`undefined` drops from JSON), while the core's `ToolDefinition::description` is a string and the codec sends
/// `""`. Every product tool has a description, so only the test's own description-less tools (named from its input) lose
/// the empty key here.
fn without_absent_descriptions(value: Value, undescribed: &[String]) -> Value {
    match value {
        Value::Array(items) => Value::Array(items.into_iter().map(|item| without_absent_descriptions(item, undescribed)).collect()),
        Value::Object(mut map) => {
            if map.get("name").and_then(Value::as_str).is_some_and(|name| undescribed.iter().any(|n| n == name)) && map.get("description") == Some(&json!("")) {
                map.remove("description");
            }
            Value::Object(map.into_iter().map(|(key, item)| (key, without_absent_descriptions(item, undescribed))).collect())
        }
        other => other,
    }
}

/// Node's session object against the header's same keys.
fn session_of(header: &mixdog_store::schema::record::Header, node: &Value) -> Value {
    Value::Object(node.as_object().expect("session").keys().filter_map(|key| header.get(key).map(|value| (key.clone(), value.clone()))).collect())
}

struct World {
    rig: Rig,
    directory: Arc<SessionDirectory>,
    threads: Arc<SessionThreads>,
    catalog: Arc<SkillCatalog>,
    bridge: Arc<Bridge>,
    run: Arc<WireRun>,
    root: String,
    dir: tempfile::TempDir,
}

impl World {
    fn new(bridge: Vec<Value>, skill_md: &str) -> Self {
        let dir = tempfile::tempdir().unwrap();
        let skills = dir.path().join("data").join("skills");
        std::fs::create_dir_all(skills.join("deck-guide")).unwrap();
        #[allow(clippy::disallowed_methods)] // the test's skill file
        std::fs::write(skills.join("deck-guide").join("SKILL.md"), skill_md).unwrap();
        let tokens = mixdog_rt::testing::tokens();
        let root = SkillRoot { dir: skills, source: SkillSource::Global, plugin: None };
        let catalog = SkillCatalog::new(dir.path().join("data"), tokens.maintenance_io, Arc::new(move |_lane| vec![root.clone()]), Arc::new(NoSettings), &SkillsWatch::new());
        let provider = Arc::new(Calls { id: ProviderId::from("skill-wire-test"), policy: RetryPolicy::codex_default(), keepalive: KeepaliveSchedule::SPEC, codec: MockCodec, requests: Mutex::new(Vec::new()) });
        let run = Arc::new(WireRun { provider, workspace: dir.path().to_path_buf(), skill: OnceLock::new(), directory: OnceLock::new() });
        let rig = Rig::new();
        let mut deps = rig.deps_parts(rig.store.clone());
        deps.runs = Arc::new(RunHostFactory::new(mixdog_services::task_reports::runtime_state::RuntimeLiveness::new(), mixdog_tools::web::NativeSearchUsageSinks::new(), run.clone()));
        let directory = Arc::new(SessionDirectory::new(Arc::new(deps)));
        let _ = run.directory.set(Arc::downgrade(&directory));
        let threads = Arc::new(SessionThreads::new(directory.clone()));
        let bridge = Arc::new(Bridge(bridge));
        let root = dir.path().to_string_lossy().replace('\\', "/");
        Self { rig, directory, threads, catalog, bridge, run, root, dir }
    }

    /// The product's `Skill` tool over this directory's threads, reading `transcript`.
    fn skill(&self, transcript: Arc<dyn TranscriptTexts>) -> SkillTool {
        let arm = HeaderSkillArm::new(self.threads.clone(), self.threads.clone(), Arc::new(NoRouteExclusions), Arc::new(Open), self.bridge.clone(), Arc::new(Fixed));
        SkillTool::new(Arc::new(CatalogSkillPort::new(self.catalog.clone(), Arc::new(arm), transcript)))
    }

    /// A thread whose header holds the test's session for `provider`, opened by the core's surface.
    async fn thread(&self, provider: &str, tools: &Value) -> (ThreadId, Value) {
        let reply = self.directory.request(request("thread/start", json!({ "opId": "op-start", "kind": "task", "projectPath": "/ws" }), "op-start")).await.expect("thread/start");
        let Reply::Subscribe(subscribe) = reply else { panic!("thread/start subscribes") };
        let id = ThreadId::from(subscribe.result["thread"]["id"].as_str().expect("thread id"));
        let mut session = json!({ "provider": provider, "tools": tools, "messages": [], "toolSpec": "full" });
        ToolSurface { host: self.bridge.as_ref(), clock: &Fixed }.apply(&mut session, "full", &[], &ApplyOptions::default());
        let mut set = session.as_object().expect("session").clone();
        set.shift_remove("messages");
        self.threads.patch_header(&id, set, Vec::new()).await.expect("the session on the header");
        (id, session)
    }

    async fn header(&self, id: &ThreadId) -> mixdog_store::schema::record::Header {
        self.threads.header(id).await.expect("header")
    }

    /// The preparation Node's `executeTool` gives every call (`refreshDeferredMcpToolCatalog`, `call-prep.mjs:70`) and the
    /// core's loop runs around each tool call (`refresh_mcp`): the session's MCP catalog reconciled with the live registry,
    /// here no connected server, and written to the header.
    async fn prepare_call(&self, id: &ThreadId) {
        let header = self.header(id).await;
        if !header.get("deferredProviderMode").is_some_and(|mode| mode.as_str().is_some_and(|mode| !mode.is_empty())) {
            return;
        }
        let mut session = Value::Object(header.clone());
        ToolSurface { host: self.bridge.as_ref(), clock: &Fixed }.reconcile_mcp_catalog(&mut session, &[]);
        let changed: serde_json::Map<String, Value> = session.as_object().expect("session").iter().filter(|(key, value)| header.get(*key) != Some(*value)).map(|(key, value)| (key.clone(), value.clone())).collect();
        if !changed.is_empty() {
            self.threads.patch_header(id, changed, Vec::new()).await.expect("the prepared session on the header");
        }
    }

    /// Node's session object against the thread: the header's same keys, and `messages` the thread's transcript.
    async fn session(&self, id: &ThreadId, node: &Value) -> Value {
        let header = self.header(id).await;
        let mut session = session_of(&header, node);
        if node.get("messages").is_some() {
            let transcript: Vec<Value> = self.rig.store.records(id).into_iter().filter_map(|(_, record)| match record {
                Record::Item(item) => match &item.body {
                    Slot::Inline(body) => Some(body.clone()),
                    _ => None,
                },
                _ => None,
            }).collect();
            session["messages"] = Value::Array(transcript);
        }
        self.masked(session)
    }

    fn ctx(&self, id: &ThreadId) -> ToolContext {
        let tokens = mixdog_rt::testing::tokens();
        ToolContext {
            call_id: mixdog_protocol::ToolCallId::from("skill"),
            thread_id: id.clone(),
            turn_id: mixdog_core_api::ids::TurnId::from("turn"),
            tool: "Skill".into(),
            cwd: mixdog_core_api::domain::common::AbsPath::new(self.dir.path().to_path_buf()).unwrap(),
            surface: SurfaceKind::Lead,
            cancel: mixdog_rt::CancellationToken::new(),
            deadline: None,
            progress: Arc::new(mixdog_core_api::domain::mock::MockProgress::default()),
            io: ToolIo { interactive: tokens.interactive_io, durability: tokens.durability_io, maintenance: tokens.maintenance_io },
            approvals: Arc::new(MockApprovalGate::default()),
            files: Arc::new(MockFileService::default()),
            processes: Arc::new(MockProcessManager::default()),
            options: Default::default(),
            review: None,
        }
    }

    /// A Skill call's result as Node's normalized envelope keeps it: the text and the injected messages.
    async fn load(&self, tool: &SkillTool, id: &ThreadId) -> (Value, Value) {
        let output = tool.call(&self.ctx(id), json!({ "name": "deck-guide" })).await.expect("loaded");
        let [ToolPart::Text(text)] = output.parts.as_slice() else { panic!("one text part") };
        let injected: Vec<Value> = output.follow_up_messages.iter().map(|message| json!({ "role": "user", "content": message.text.replace(&self.root, "<root>"), "meta": message.meta })).collect();
        (json!(text.replace(&self.root, "<root>")), json!(injected))
    }

    fn masked(&self, value: Value) -> Value {
        serde_json::from_str(&value.to_string().replace(&self.root, "<root>")).expect("json")
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn skill_dependencies_reach_the_next_request_as_in_node() {
    let golden = recording();
    let wire = &golden["wire"];
    let skill_md = golden["cases"].as_array().expect("cases").iter().flat_map(|case| case["steps"].as_array().expect("steps")).find(|step| step["op"] == "parse" && step["skill"] == "deck-guide").expect("the test's SKILL.md")["text"].as_str().expect("text").to_owned();
    // The test's tools (Skill, office, read), as the same test's recorded per-provider case opens its sessions with.
    let test_tools = golden["cases"].as_array().expect("cases").iter().find(|case| case["name"].as_str().is_some_and(|name| name.ends_with(": the session per provider"))).expect("the per-provider case")["steps"]
        .as_array()
        .expect("steps")
        .iter()
        .find(|step| step["op"] == "open")
        .expect("an open")["tools"]
        .clone();
    let undescribed: Vec<String> = test_tools.as_array().expect("tools").iter().filter(|tool| tool.get("description").is_none()).filter_map(|tool| tool["name"].as_str().map(str::to_owned)).collect();
    let providers = wire["providers"].as_array().expect("providers");
    assert_eq!(providers.len(), 4, "every provider of the test");
    for node in providers {
        let provider = node["provider"].as_str().expect("provider");
        let world = World::new(golden["bridgeTools"].as_array().expect("bridge tools").clone(), &skill_md);

        // Outside a loop: `executeTool('Skill')` twice on the session.
        let (id, opened) = world.thread(provider, &test_tools).await;
        assert_eq!(opened, node["opened"], "{provider}: the opened session");
        let header = world.header(&id).await;
        let initial = request_definitions(&header, header["tools"].as_array().expect("tools"), &[], provider);
        assert_eq!(without_absent_descriptions(tools_of(provider, initial), &undescribed), node["initial"],"{provider}: the request tools before");
        let tool = world.skill(Arc::new(NoTexts));
        for (n, load) in node["loads"].as_array().expect("loads").iter().enumerate() {
            world.prepare_call(&id).await;
            let (result, injected) = world.load(&tool, &id).await;
            assert_eq!(result, load["result"], "{provider}: load {n}, the Skill result");
            assert_eq!(injected, load["newMessages"], "{provider}: load {n}, the injected messages");
            assert_eq!(world.session(&id, &load["session"]).await, load["session"], "{provider}: load {n}, the session");
        }
        let header = world.header(&id).await;
        let after = request_definitions(&header, header["tools"].as_array().expect("tools"), &[], provider);
        assert_eq!(without_absent_descriptions(tools_of(provider, after), &undescribed), node["after"],"{provider}: the request tools after");
        let mut rebuilt = world.session(&id, &node["rebuilt"]).await;
        ToolSurface { host: world.bridge.as_ref(), clock: &Fixed }.rebuild_for_provider(&mut rebuilt, "openai-oauth");
        assert_eq!(rebuilt, node["rebuilt"], "{provider}: rebuilt for openai-oauth");

        // The loop: a turn whose provider calls Skill twice.
        let (loop_id, loop_opened) = world.thread(provider, &test_tools).await;
        let mut want_opened = node["loop"]["opened"].clone();
        want_opened.as_object_mut().expect("session").retain(|key, _| key != "id" && key != "compaction");
        assert_eq!(loop_opened, want_opened, "{provider}: the loop's session");
        let _ = world.run.skill.set(Arc::new(world.skill(Arc::new(ThreadTranscript::new(Arc::new(Live(Arc::downgrade(&world.directory))), world.threads.clone())))));
        let handle = world.directory.handle(&loop_id).expect("loaded");
        handle.request(request("turn/start", json!({ "threadId": loop_id, "opId": "op-1", "input": { "prompt": "Create a presentation." } }), "op-1")).await.expect("turn/start");
        let answered = || world.rig.store.records(&loop_id).into_iter().any(|(_, record)| matches!(record, Record::Item(item) if matches!(&item.body, Slot::Inline(body) if body["role"] == "assistant" && body["content"] == "done")));
        // The run saves its session state (`todoCheck`) before the turn ends, after its answer may already be stored.
        let completed = || !world.rig.feeds.frames(loop_id.as_str()).into_iter().filter(|(_, method, _)| method == "turn/completed").collect::<Vec<_>>().is_empty();
        eventually_on_awaiting(|| "the turn's answer in the store and its end".to_owned(), &[handle.stepped()], || (answered() && completed()).then_some(())).await;
        let sent: Vec<Value> = lock(&world.run.provider.requests).iter().map(|request| world.masked(without_absent_descriptions(wire_of(provider, request), &undescribed))).collect();
        let want = node["loop"]["requests"].as_array().expect("requests");
        assert_eq!(sent.len(), want.len(), "{provider}: the requests sent");
        for (n, (got, want)) in sent.iter().zip(want).enumerate() {
            let pretty = |v: &Value| serde_json::to_string_pretty(v).unwrap();
            assert!(got == want, "{provider}: request {n}\n--- core\n{}\n--- node\n{}", pretty(got), pretty(want));
        }
        let mut want_session = node["loop"]["session"].clone();
        // The manifest's `excluded` loop-session keys: the agentLoop's transcript array (`messages`, compared whole as
        // each request's input), the in-memory prefix guard, which Node never stores (serialize.mjs:59-81), and the
        // per-turn MCP reconcile and todo cycle this replay's assembly does not run (the mcp-fold and todo-list sets).
        want_session.as_object_mut().expect("session").retain(|key, _| {
            !["id", "compaction", "messages", "_providerPrefixGuardState", "deferredMcpToolNames", "deferredLateToolCatalog", "todoCheck"].contains(&key.as_str())
        });
        let header = world.header(&loop_id).await;
        let mut got_session = world.masked(session_of(&header, &want_session));
        // The send time is each side's own clock: both record one, as a number.
        for side in [&mut got_session, &mut want_session] {
            let sent = side.as_object_mut().expect("session").remove("lastProviderSendAt");
            assert!(sent.as_ref().is_some_and(Value::is_number), "{provider}: a send time, as a number: {sent:?}");
        }
        assert_eq!(got_session, want_session, "{provider}: the loop's session after");
    }

    // `skillToolContent` on an `openai-oauth` session.
    let node = &wire["skillToolContent"];
    let world = World::new(golden["bridgeTools"].as_array().expect("bridge tools").clone(), &skill_md);
    let (id, opened) = world.thread("openai-oauth", &test_tools).await;
    assert_eq!(opened, node["opened"], "skillToolContent: the opened session");
    let (result, injected) = world.load(&world.skill(Arc::new(NoTexts)), &id).await;
    assert_eq!((result, injected), (node["result"].clone(), node["newMessages"].clone()), "skillToolContent: the result");
    let header = world.header(&id).await;
    // Node's session carries its transcript (`messages`); the core keeps it as the thread's item records.
    let mut want_session = node["session"].clone();
    let want_messages = want_session.as_object_mut().expect("session").remove("messages").expect("messages");
    let items: Vec<Value> = world.rig.store.records(&id).into_iter().filter_map(|(_, record)| match record {
        Record::Item(item) => match &item.body { Slot::Inline(body) => Some(body.clone()), _ => None },
        _ => None,
    }).collect();
    assert_eq!(Value::Array(items), want_messages, "skillToolContent: the transcript");
    assert_eq!(world.masked(session_of(&header, &want_session)), want_session, "skillToolContent: the session");
}
