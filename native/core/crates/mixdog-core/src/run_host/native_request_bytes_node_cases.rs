//! Node's native request bytes (`fixtures/native-request-bytes-cases`, `record-native-request-bytes-cases.mjs`, the
//! scenarios of `native-request-bytes.test.mjs`): per native provider, each recorded step run again through the core's
//! own pieces and the whole session afterwards against Node's —
//!
//! * a session opened and switched by [`ToolSurface::apply`] and [`ToolSurface::rebuild_for_provider`];
//! * `load_tool` through the real [`LoadTool`] over the real [`SessionCatalog`] (the whole answer), with the servers'
//!   status where the step has one (Node does not wait for a connecting server: it names it in the answer);
//! * the late MCP catalog and the first-turn fold by [`ToolSurface::reconcile_mcp_catalog`] and
//!   [`ToolSurface::refresh_initial_mcp_surface`], the pending delta through the turn's reminder block
//!   ([`turn_reminders::build`]);
//! * a skill's dependencies armed by [`HeaderSkillArm`] (the whole Skill result);
//! * the refusals through [`SessionSurface`] (`refusal_for_call`, `deferred_call_refusal`);
//! * each request as the run takes it (`request_definitions`, the stored system rows read by `message_of`) encoded by
//!   the provider's own codec: the body's whole `tools`, and for Anthropic its whole `system`.

use std::sync::Arc;
use std::sync::Mutex;

use async_trait::async_trait;
use mixdog_agent::env::Clock;
use mixdog_ai::providers::anthropic::AnthropicCodec;
use mixdog_ai::providers::anthropic::AnthropicConfig;
use mixdog_ai::providers::anthropic::Flavor;
use mixdog_ai::providers::openai::codec::OpenAiCodec;
use mixdog_ai::providers::openai::config::CodexIdentity;
use mixdog_ai::providers::openai::config::NoFacts;
use mixdog_ai::providers::openai::config::OpenAiConfig;
use mixdog_ai::providers::openai::config::WireContext;
use mixdog_core_api::domain::provider::ModelRequest;
use mixdog_core_api::domain::provider::RequestOptions;
use mixdog_core_api::domain::keepalive::TransportKind;
use mixdog_core_api::domain::provider::WireCodec;
use mixdog_core_api::domain::mock::MockApprovalGate;
use mixdog_core_api::domain::mock::MockFileService;
use mixdog_core_api::domain::mock::MockProcessManager;
use mixdog_core_api::domain::mock::MockProgress;
use mixdog_core_api::domain::tool::SurfaceKind;
use mixdog_core_api::domain::tool::Tool;
use mixdog_core_api::domain::tool::ToolAnnotations;
use mixdog_core_api::domain::tool::ToolContext;
use mixdog_core_api::domain::tool::ToolIo;
use mixdog_core_api::domain::tool::ToolPart;
use mixdog_core_api::ids::ThreadId;
use mixdog_tools::orch::bridge::LoadTool;
use mixdog_core_ports::ports::threads::HeaderUpdate;
use mixdog_core_ports::ports::threads::HeaderUpdates;
use mixdog_core_ports::ports::threads::Section;
use mixdog_core_ports::ports::threads::ThreadState;
use mixdog_core_session::session::NoRouteExclusions;
use mixdog_mcp::skill_deps::DependencySource;
use mixdog_mcp::skill_deps::SkillToolDependencies;
use mixdog_mcp::skill_port::DeferredToolArm;
use mixdog_store::schema::record::Header;
use mixdog_tools::orch::util::PortError;
use mixdog_tools::policy::ConnectorPermissions;
use mixdog_tools::policy::SessionSurface;
use serde_json::Map;
use serde_json::Value;
use serde_json::json;

use super::context_world::request_definitions;
use super::session_catalog::McpServerStatus;
use super::session_catalog::RunningHeaders;
use super::session_catalog::SessionCatalog;
use super::skill_session::HeaderSkillArm;
use super::tool_surface::ApplyOptions;
use super::tool_surface::SurfaceHost;
use super::tool_surface::ToolSurface;
use super::turn_reminders;

fn golden() -> Value {
    serde_json::from_str(mixdog_testkit::fixture!("../../fixtures/native-request-bytes-cases/golden.json")).expect("json")
}

fn manifest() -> Value {
    serde_json::from_str(mixdog_testkit::fixture!("../../fixtures/native-request-bytes-cases/MANIFEST.json")).expect("json")
}

/// Node's clock in the recording.
struct Fixed(i64);

impl Clock for Fixed {
    fn now_ms(&self) -> i64 {
        self.0
    }
}

/// No bridge definitions (both providers are native) and the MCP client's server instructions as Node's answered.
struct Host(Value);

impl SurfaceHost for Host {
    fn bridge_tools(&self) -> Vec<Value> {
        Vec::new()
    }
    fn mcp_server_instructions(&self, _: Option<&str>) -> Value {
        self.0.clone()
    }
}

/// The one thread's header: read as the running session's, updated as the actor's.
struct Store(Mutex<Header>);

impl Store {
    fn of(session: &Value) -> Arc<Self> {
        Arc::new(Self(Mutex::new(session.as_object().expect("session").clone())))
    }
    fn session(&self) -> Value {
        Value::Object(self.0.lock().expect("store").clone())
    }
}

impl RunningHeaders for Store {
    fn header(&self, _: &ThreadId) -> Option<Arc<Header>> {
        Some(Arc::new(self.0.lock().expect("store").clone()))
    }
}

#[async_trait]
impl ThreadState for Store {
    async fn header(&self, _: &ThreadId) -> Result<Header, PortError> {
        Ok(self.0.lock().expect("store").clone())
    }
    async fn patch_header(&self, _: &ThreadId, _: Map<String, Value>, _: Vec<String>) -> Result<(), PortError> {
        unreachable!("loads update the header in one update")
    }
    async fn patch_header_if(&self, _: &ThreadId, _: Map<String, Value>, _: Map<String, Value>, _: Vec<String>) -> Result<Option<Map<String, Value>>, PortError> {
        unreachable!("loads update the header in one update")
    }
    async fn publish(&self, _: &ThreadId, _: Section) -> Result<(), PortError> {
        unreachable!("loads publish nothing")
    }
}

#[async_trait]
impl HeaderUpdates for Store {
    async fn update_header(&self, _: &ThreadId, update: HeaderUpdate) -> Result<(), PortError> {
        let mut header = self.0.lock().expect("store");
        let change = update(&header);
        header.extend(change.set);
        for key in change.unset {
            header.shift_remove(&key);
        }
        Ok(())
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

fn thread() -> ThreadId {
    ThreadId::from("t1")
}

/// `mcpStatus()` as the step recorded it.
struct Status(Value);

#[async_trait]
impl McpServerStatus for Status {
    async fn status(&self, _: &ThreadId) -> Value {
        self.0.clone()
    }
}

fn call_context() -> ToolContext {
    let tokens = mixdog_rt::testing::tokens();
    ToolContext {
        call_id: mixdog_protocol::ToolCallId::from("load"),
        thread_id: thread(),
        turn_id: mixdog_protocol::TurnId::from("turn"),
        tool: "load_tool".into(),
        cwd: mixdog_core_api::domain::common::AbsPath::new(std::env::temp_dir()).expect("absolute"),
        surface: SurfaceKind::Lead,
        cancel: tokio_util::sync::CancellationToken::new(),
        deadline: None,
        progress: Arc::new(MockProgress::default()),
        io: ToolIo { interactive: tokens.interactive_io, durability: tokens.durability_io, maintenance: tokens.maintenance_io },
        approvals: Arc::new(MockApprovalGate::default()),
        files: Arc::new(MockFileService::default()),
        processes: Arc::new(MockProcessManager::default()),
        options: Default::default(),
        review: None,
    }
}

/// The request one step sends, as the run takes it: the session's tools through `request_definitions` and its stored
/// rows read by `message_of`, then the user's `go`; encoded by the provider's own codec, the body as JSON.
fn request_body(session: &Value) -> Value {
    let header = session.as_object().expect("session");
    let provider = session["provider"].as_str().expect("provider");
    let rows = session["messages"].as_array().expect("messages");
    let tools = request_definitions(header, session["tools"].as_array().expect("tools"), rows, provider);
    let mut messages: Vec<_> = rows.iter().map(|row| super::message_row::message_of(row).expect("a stored row").message).collect();
    messages.push(super::message_row::message_of(&json!({ "role": "user", "content": "go" })).expect("the user row").message);
    let request = ModelRequest { model: session["model"].as_str().expect("model").into(), messages, tools, options: RequestOptions::default() };
    let wire = if provider.starts_with("openai") {
        let identity = CodexIdentity { installation_id: "i".into(), user_agent: "ua".into(), version: "1".into(), beta_features: String::new() };
        OpenAiCodec::new(OpenAiConfig::codex(false, true, identity, Arc::new(NoFacts), Arc::new(Ctx)), TransportKind::Http1).encode(&request)
    } else {
        AnthropicCodec::new(Flavor::ApiKey, AnthropicConfig::new(Arc::new(|_: &str| None))).encode(&request)
    };
    serde_json::from_slice(&wire.expect("encodes").body).expect("a JSON body")
}

/// The pending deferred-tools delta as the turn carries it: the reminder block of a turn with no prompt text, and the
/// revision it acknowledges.
fn delta(session: &Value) -> Value {
    let header = session.as_object().expect("session");
    let facts = turn_reminders::Facts { header, prior: &[], prompt_text: "", genuine: false, current_agents: None, mode_instructions: None, goal: None, hidden_agent: false, now_ms: 0.0 };
    let reminders = turn_reminders::build(&facts).expect("reminders");
    match reminders.revisions.deferred {
        Some(revision) => json!({ "revision": revision, "content": reminders.block }),
        None => {
            assert_eq!(reminders.block, "", "no other reminder rides this turn");
            Value::Null
        }
    }
}

/// The annotations the tool registry gives a catalog tool: its own.
fn annotations_of(session: &Value, name: &str) -> ToolAnnotations {
    let tool = session["deferredToolCatalog"].as_array().into_iter().flatten().find(|tool| tool["name"] == name).cloned().unwrap_or(Value::Null);
    let hint = |key: &str| tool["annotations"][key].as_bool();
    ToolAnnotations { read_only_hint: hint("readOnlyHint"), destructive_hint: hint("destructiveHint"), ..ToolAnnotations::default() }
}

#[tokio::test]
async fn every_recorded_native_request_step_is_nodes() {
    let golden = golden();
    let excluded = manifest()["excluded"].as_object().expect("excluded").clone();
    let clock = Arc::new(Fixed(golden["now"].as_i64().expect("now")));
    // The MCP client's live answer in Node's process; the scenario's own instructions sit on the opened sessions.
    let host = Arc::new(Host(golden["liveMcpInstructions"].clone()));
    let surface = ToolSurface { host: host.as_ref(), clock: clock.as_ref() };
    let cases = golden["cases"].as_array().expect("cases");
    assert_eq!(cases.len(), 2, "both native providers");
    let mut replayed = 0;
    for case in cases {
        let provider = case["provider"].as_str().expect("provider");
        let mut sessions: Map<String, Value> = Map::new();
        for (index, step) in case["steps"].as_array().expect("steps").iter().enumerate() {
            let label = step["session"].as_str().expect("session label");
            let at = format!("{provider}: step {index} ({} {} on {label})", step["op"], step["name"].as_str().unwrap_or_default());
            if excluded.contains_key(&at) {
                continue;
            }
            let session = sessions.entry(label.to_owned()).or_insert(Value::Null);
            match step["op"].as_str().expect("op") {
                "open" => {
                    *session = step["before"].clone();
                    let options = ApplyOptions { provider: Some(provider.to_owned()), ..ApplyOptions::default() };
                    surface.apply(session, step["mode"].as_str().expect("mode"), step["extraTools"].as_array().expect("extra tools"), &options);
                }
                "request" => {
                    let body = request_body(session);
                    assert_eq!(body["tools"], step["wireTools"], "{at}: the wire tools");
                    if !step["anthropicSystem"].is_null() {
                        assert_eq!(body["system"], step["anthropicSystem"], "{at}: the system blocks");
                    }
                }
                "load" => {
                    let store = Store::of(session);
                    let mut catalog = SessionCatalog::new(store.clone(), store.clone(), store.clone(), Arc::new(NoRouteExclusions), host.clone(), clock.clone());
                    // Node reads the servers' status once, without waiting: a server still connecting is named in the answer.
                    if !step["status"].is_null() {
                        catalog = catalog.with_status(Arc::new(Status(step["status"].clone())));
                    }
                    // The model's call: the `load_tool` tool, not the function under it.
                    let output = LoadTool::new(Arc::new(catalog)).call(&call_context(), step["args"].clone()).await.expect("an answer");
                    // Node's `renderToolSearch` returns the text, no error: the call answers `Ok` (`expect` above), the text is the
                    // only part, and nothing else (attachments, meta, an unknown outcome) rides with it.
                    let answered = mixdog_core_api::domain::tool::ToolOutput { parts: vec![ToolPart::Text(step["result"].as_str().expect("text").to_owned())], ..Default::default() };
                    assert_eq!(output, answered, "{at}: the answer");
                    *session = store.session();
                }
                "reconcile" => {
                    surface.reconcile_mcp_catalog(session, step["live"].as_array().expect("live"));
                }
                "refreshInitial" => {
                    surface.refresh_initial_mcp_surface(session, step["live"].as_array().expect("live"));
                }
                "delta" => {
                    let want = if step["result"].is_null() { Value::Null } else { json!({ "revision": step["result"]["revision"], "content": step["result"]["content"] }) };
                    assert_eq!(delta(session), want, "{at}: the delta");
                    // What the notice lists is what the session stages (`pendingDeferredToolDelta`), whole.
                    if !step["result"].is_null() {
                        let pending = &session["pendingDeferredToolDelta"];
                        let mut added = pending["added"].as_array().cloned().unwrap_or_default();
                        added.sort_by(|a, b| mixdog_js::locale_compare(a["name"].as_str().unwrap_or(""), b["name"].as_str().unwrap_or("")));
                        let mut removed = pending["removed"].as_array().cloned().unwrap_or_default();
                        removed.sort_by(|a, b| a.as_str().cmp(&b.as_str()));
                        assert_eq!((json!(added), json!(removed)), (step["result"]["added"].clone(), step["result"]["removed"].clone()), "{at}: the staged delta");
                    }
                    replayed += 1;
                    continue;
                }
                "skill" => {
                    let store = Store::of(session);
                    let arm = HeaderSkillArm::new(store.clone(), store.clone(), Arc::new(NoRouteExclusions), Arc::new(Open), host.clone(), clock.clone());
                    let dependencies = SkillToolDependencies {
                        tool_dependencies: step["dependencies"].as_array().expect("dependencies").clone(),
                        declared: Vec::new(),
                        source: DependencySource::Declaration,
                        issues: Vec::new(),
                    };
                    let notice = arm.arm(&thread(), &dependencies).await.expect("armed");
                    assert_eq!(notice.result(step["head"].as_str().expect("head")), step["result"]["result"].as_str().expect("result"), "{at}: the Skill result");
                    *session = store.session();
                }
                "callThrough" => {
                    let tool = step["tool"].as_str().expect("tool");
                    let refusal = SessionSurface::from_header(session.as_object().expect("session"), Vec::new()).deferred_call_refusal(tool, &annotations_of(session, tool));
                    assert_eq!(refusal.map(|deny| json!({ "deny": deny })).unwrap_or(Value::Null), step["result"], "{at}: the refusal");
                    replayed += 1;
                    continue;
                }
                "deny" => {
                    let refusal = SessionSurface::from_header(session.as_object().expect("session"), Vec::new()).refusal_for_call(step["tool"].as_str().expect("tool"), None, &json!({}));
                    assert_eq!(refusal.map(|deny| json!(deny.message_for_model)).unwrap_or(Value::Null), step["result"], "{at}: the refusal");
                    replayed += 1;
                    continue;
                }
                "switch" => {
                    let next = step["provider"].as_str().expect("provider");
                    session["provider"] = json!(next);
                    surface.rebuild_for_provider(session, next);
                }
                other => panic!("{at}: unknown step {other}"),
            }
            assert_eq!(*session, step["after"], "{at}: the session");
            replayed += 1;
        }
    }
    let steps: usize = cases.iter().map(|case| case["steps"].as_array().expect("steps").len()).sum();
    assert_eq!(replayed + excluded.len(), steps, "every step is replayed or named");
}
