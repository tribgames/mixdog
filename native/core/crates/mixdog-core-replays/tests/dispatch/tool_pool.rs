//! The tool pool's plug-ins against the real Node (`fixtures/tool-pool`, recorded by
//! `benchmarks/rust-core/recorders/record-tool-pool.mjs`): the caller facts, the tool list a
//! turn sees, the `call_tool` hand-off; and the session port's rules.

use std::collections::HashMap;
use std::collections::HashSet;
use std::sync::Arc;
use std::sync::Mutex;

use async_trait::async_trait;
use mixdog_core_api::CoreError;
use mixdog_core_api::domain::common::AbsPath;
use mixdog_core_api::domain::mock::MockApprovalGate;
use mixdog_core_api::domain::mock::MockFileService;
use mixdog_core_api::domain::mock::MockProcessManager;
use mixdog_core_api::domain::mock::MockProgress;
use mixdog_core_api::domain::tool::SurfaceKind;
use mixdog_core_api::domain::tool::Tool;
use mixdog_core_api::domain::tool::ToolAnnotations;
use mixdog_core_api::domain::tool::ToolContext;
use mixdog_core_api::domain::tool::ToolIo;
use mixdog_core_api::domain::tool::ToolOutcome;
use mixdog_core_api::domain::tool::ToolOutput;
use mixdog_core_api::domain::tool::ToolPart;
use mixdog_core_api::domain::tool::ToolSpec;
use mixdog_core_api::ids::ThreadId;
use mixdog_core_ports::ports::setup_actions::CallerScope;
use mixdog_core_ports::ports::run_stamps::RunStamps;
use mixdog_core_ports::ports::threads::Section;
use mixdog_core_ports::ports::threads::ThreadState;
use mixdog_protocol::ToolCallId;
use mixdog_protocol::TurnId;
use mixdog_services::bots::HeartbeatSessions;
use mixdog_store::schema::record::Header;
use mixdog_tools::orch::bridge::CallResolution;
use mixdog_tools::orch::bridge::CallTool;
use mixdog_tools::orch::bridge::CatalogView;
use mixdog_tools::orch::bridge::ToolDispatcher;
use mixdog_tools::orch::bridge::ToolDoc;
use mixdog_tools::orch::ports::CallerFacts;
use mixdog_tools::orch::session::RenameError;
use mixdog_tools::orch::session::SessionPort;
use mixdog_tools::orch::session::SidebarFlag;
use mixdog_tools::orch::session::TaskOrigin;
use mixdog_tools::orch::util::PortError;
use serde_json::Map;
use serde_json::Value;
use serde_json::json;
use tokio_util::sync::CancellationToken;

use mixdog_core::run_host::tool_pool::callers::ThreadCallers;
use mixdog_core::run_host::tool_pool::model_surface::SurfaceInputs;
use mixdog_core::run_host::tool_pool::model_surface::model_internal_tools;
use mixdog_core::run_host::tool_pool::session_port::AiTitleSetting;
use mixdog_core::run_host::tool_pool::session_port::BotIds;
use mixdog_core::run_host::tool_pool::session_port::DirectorySessionPort;
use mixdog_core::run_host::tool_pool::session_port::ProjectList;
use mixdog_core::run_host::tool_pool::session_port::SessionPortParts;
use mixdog_core::run_host::tool_pool::session_port::Suggestions;
use mixdog_core::run_host::tool_pool::session_port::ThreadRequests;
use mixdog_core::run_host::unattended::UnattendedRunRegistry;
use mixdog_tools::policy::RunKind;

fn golden(text: &str) -> Value {
    serde_json::from_str(text).expect("fixture")
}

fn caller_golden() -> Value {
    golden(include_str!("../../../../fixtures/tool-pool/caller-facts.json"))
}

fn tool_list_golden() -> Value {
    golden(include_str!("../../../../fixtures/tool-pool/tool-list.json"))
}

fn dispatch_golden() -> Value {
    golden(include_str!("../../../../fixtures/tool-pool/dispatch.json"))
}

/// A thread store of headers, with the compare-and-set patch the session actor does.
#[derive(Default)]
struct Threads(Mutex<HashMap<String, Header>>);

impl Threads {
    fn with(id: &str, header: Value) -> Arc<Self> {
        let threads = Self::default();
        threads.0.lock().expect("threads").insert(id.to_owned(), header.as_object().expect("object").clone());
        Arc::new(threads)
    }

    fn header_of(&self, id: &str) -> Header {
        self.0.lock().expect("threads").get(id).cloned().expect("thread")
    }
}

fn missing(thread: &ThreadId) -> PortError {
    PortError::NotFound { target: thread.as_str().to_owned(), message: format!("session: {} is unavailable", thread.as_str()) }
}

#[async_trait]
impl ThreadState for Threads {
    async fn header(&self, thread: &ThreadId) -> Result<Header, PortError> {
        self.0.lock().expect("threads").get(thread.as_str()).cloned().ok_or_else(|| missing(thread))
    }

    async fn patch_header(&self, thread: &ThreadId, set: Map<String, Value>, unset: Vec<String>) -> Result<(), PortError> {
        let mut threads = self.0.lock().expect("threads");
        let header = threads.get_mut(thread.as_str()).ok_or_else(|| missing(thread))?;
        header.extend(set);
        header.retain(|key, _| !unset.contains(key));
        Ok(())
    }

    async fn patch_header_if(
        &self,
        thread: &ThreadId,
        expect: Map<String, Value>,
        set: Map<String, Value>,
        unset: Vec<String>,
    ) -> Result<Option<Map<String, Value>>, PortError> {
        let current = {
            let threads = self.0.lock().expect("threads");
            let header = threads.get(thread.as_str()).ok_or_else(|| missing(thread))?;
            expect.keys().map(|key| (key.clone(), header.get(key).cloned().unwrap_or(Value::Null))).collect::<Map<_, _>>()
        };
        if current != expect {
            return Ok(Some(current));
        }
        self.patch_header(thread, set, unset).await.map(|()| None)
    }

    async fn publish(&self, _: &ThreadId, _: Section) -> Result<(), PortError> {
        Ok(())
    }
}

struct NoStamps;

#[async_trait]
impl RunStamps for NoStamps {
    async fn stamp_of(&self, _: &ThreadId) -> Option<Value> {
        None
    }
}

fn scope_json(scope: &CallerScope) -> Value {
    match scope {
        CallerScope::Human => json!({ "kind": "human" }),
        CallerScope::Headless => json!({ "kind": "headless" }),
        CallerScope::RoomMember => json!({ "kind": "room-member" }),
        CallerScope::Agent { agent_id, unattended } => {
            let mut scope = json!({ "kind": "agent", "agentId": agent_id });
            if *unattended {
                scope["unattended"] = json!(true);
            }
            scope
        }
    }
}

/// Node's `scheduleCallerScope`, `unattendedRunOf` marks and `isHeartbeatSession` over a session
/// record of every provenance, with and without the marks.
#[tokio::test]
async fn caller_facts_follow_the_node_scope_and_marks() {
    let g = caller_golden();
    for case in g["cases"].as_array().expect("cases") {
        let record = case["record"].as_object().expect("record").clone();
        let id = record.get("id").and_then(Value::as_str).unwrap_or("").to_owned();
        let marks = HeartbeatSessions::new();
        if case["heartbeat"] == json!(true) {
            marks.mark(&id);
        }
        let registry = UnattendedRunRegistry::new(Arc::new(NoStamps));
        let _run = case["run"].as_object().and_then(|run| {
            let kind = if run["kind"] == json!("webhook") { RunKind::Webhook } else { RunKind::Schedule };
            registry.mark(&id, kind, run["agentId"].as_str().expect("agent"), "")
        });
        let callers = ThreadCallers::new(Threads::with(&id, Value::Object(record)), marks, registry);
        let thread = ThreadId::from(id.as_str());
        let name = &case["name"];
        let got = scope_json(&callers.scope(&thread).await);
        let mut want = case["scope"].clone();
        if want["kind"] == json!("room-member") {
            // The scope carries the seat's agent for a room member; the unattended facts do not read it.
            want = json!({ "kind": "room-member" });
        }
        assert_eq!(got, want, "{name}");
        assert_eq!(callers.is_unattended(&thread).await, case["unattended"].as_bool().expect("flag"), "{name}");
        assert_eq!(callers.is_heartbeat(&thread).await, case["isHeartbeat"].as_bool().expect("flag"), "{name}");
    }
}

#[tokio::test]
async fn a_user_is_available_unless_the_session_has_no_approval_surface() {
    let marks = HeartbeatSessions::new();
    let registry = UnattendedRunRegistry::new(Arc::new(NoStamps));
    let threads = Threads::with("sess_a", json!({}));
    threads.0.lock().expect("threads").insert("sess_b".into(), json!({ "approvalMode": "implicit" }).as_object().expect("object").clone());
    let callers = ThreadCallers::new(threads, marks, registry);
    assert!(callers.user_available(&ThreadId::from("sess_a")).await);
    assert!(!callers.user_available(&ThreadId::from("sess_b")).await);
    assert!(!callers.user_available(&ThreadId::from("sess_gone")).await);
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

fn named(name: &str) -> Arc<dyn Tool> {
    Arc::new(Named(ToolSpec {
        name: name.into(),
        title: None,
        trigger: None,
        public: true,
        aliases: Vec::new(),
        description: String::new(),
        input_schema: json!({}),
        annotations: ToolAnnotations::default(),
        parallel_safe: true,
        exclusive_with: Vec::new(),
    }))
}

fn strings(value: &Value) -> Vec<String> {
    value.as_array().expect("array").iter().map(|v| v.as_str().expect("string").to_owned()).collect()
}

/// Node's `modelStandaloneTools()` over the product's own standalone tool definitions: the main
/// session, a delegated worker, workflows that do and do not delegate, and the narrowed profiles.
#[test]
fn the_tool_list_a_turn_sees_follows_node() {
    let g = tool_list_golden();
    let standalone: Vec<Arc<dyn Tool>> = strings(&g["standalone"]).iter().map(|n| named(n)).collect();
    let agent_tools = strings(&g["agentTools"]);
    let agent_set: HashSet<&str> = agent_tools.iter().map(String::as_str).collect();
    for case in g["cases"].as_array().expect("cases") {
        let session: Option<Header> = case["session"].as_object().cloned();
        let features = strings(&case["features"]);
        let profile = case["allowedByProfile"].as_array().map(|_| strings(&case["allowedByProfile"]));
        let allowed: Option<Vec<&str>> = profile.as_ref().map(|names| names.iter().map(String::as_str).collect());
        let delegatable = case["delegatable"].as_u64().expect("count") as usize;
        let got = model_internal_tools(
            &standalone,
            &agent_set,
            &SurfaceInputs { session: session.as_ref(), profile_allowed: allowed.as_deref(), feature_denied: &features, delegatable_agents: &|| delegatable },
        );
        let got: Vec<String> = got.iter().map(|t| t.spec().name.clone()).collect();
        assert_eq!(got, strings(&case["tools"]), "{}", case["name"]);
    }
}

struct Fixed(CallResolution);

#[async_trait]
impl CatalogView for Fixed {
    async fn announce(&self, _: &ThreadId, _: &[String]) {}
    fn available(&self, _: &ThreadId) -> Vec<ToolDoc> {
        Vec::new()
    }
    fn is_eager(&self, _: &ThreadId, _: &str) -> bool {
        false
    }
    fn block_reason(&self, _: &ThreadId, _: &str) -> Option<String> {
        None
    }
    fn alias_members(&self, _: &str) -> Vec<String> {
        Vec::new()
    }
    fn mcp_server_members(&self, _: &ThreadId, _: &str) -> Vec<String> {
        Vec::new()
    }
    fn instructions_for(&self, _: &ThreadId, _: &[String]) -> String {
        String::new()
    }
    fn resolve_call(&self, _: &ThreadId, _: &str) -> CallResolution {
        self.0.clone()
    }
}

#[derive(Default)]
struct Dispatched(Mutex<Vec<(String, Value)>>);

#[async_trait]
impl ToolDispatcher for Dispatched {
    async fn dispatch(&self, _: &ToolContext, name: &str, arguments: Value) -> ToolOutcome {
        self.0.lock().expect("dispatched").push((name.to_owned(), arguments));
        Ok(ToolOutput { parts: vec![ToolPart::Text("ran".into())], ..ToolOutput::default() })
    }
}

fn ctx() -> ToolContext {
    let tokens = mixdog_rt::testing::tokens();
    ToolContext {
        call_id: ToolCallId::from("call_1"),
        thread_id: ThreadId::from("sess_main"),
        turn_id: TurnId::from("r"),
        tool: "call_tool".into(),
        cwd: AbsPath::new(std::env::temp_dir()).expect("absolute"),
        surface: SurfaceKind::Lead,
        cancel: CancellationToken::new(),
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

/// What Node's loop makes of a `call_tool` before it runs it: the target and its arguments go to
/// the dispatcher, an unprojectable call is answered with the bridge error and nothing runs. (The
/// catalog's own answer is fixed per case: the targets Node projected are `Deferred`.)
#[tokio::test]
async fn call_tool_hands_the_projected_target_to_the_dispatcher_and_refuses_the_rest_in_nodes_words() {
    let g = dispatch_golden();
    for case in g["projections"].as_array().expect("projections") {
        let name = &case["name"];
        let dispatched = Arc::new(Dispatched::default());
        let resolution = match case["target"].as_str() {
            Some(target) => CallResolution::Deferred(target.to_owned()),
            // The catalog's answers are asserted by its own owner; these cases never reach it.
            None => CallResolution::NotFound,
        };
        let tool = CallTool::new(Arc::new(Fixed(resolution)), dispatched.clone());
        // The wire call is exactly the model's `call_tool` arguments.
        let got = tool.call(&ctx(), case["wire"].clone()).await;
        match (case["target"].as_str(), case["error"].as_str()) {
            (Some(target), None) => {
                assert!(got.is_ok(), "{name}");
                assert_eq!(*dispatched.0.lock().expect("dispatched"), [(target.to_owned(), case["arguments"].clone())], "{name}");
            }
            (None, Some(error)) => {
                // Node answers `Error: CODE: text`, and so does the tool.
                if error.starts_with("Error: TOOL_") || error.starts_with("Error: USE_DIRECT_TOOL") {
                    // The catalog's cases: asserted with the catalog.
                    continue;
                }
                assert_eq!(got.expect_err("refused").message_for_model, error, "{name}");
                assert!(dispatched.0.lock().expect("dispatched").is_empty(), "{name}");
            }
            other => panic!("{name}: {other:?}"),
        }
    }
}

// --- the session port ---------------------------------------------------------------------------

#[derive(Default)]
struct Requests {
    calls: Mutex<Vec<(String, String, Value)>>,
    reply: Mutex<Value>,
    interrupted: bool,
    /// The stored transcript `thread/…` reads answer: `ThreadItem`s as the protocol writes them.
    transcript: Vec<Value>,
}

#[async_trait]
impl ThreadRequests for Requests {
    async fn transcript(&self, _: &ThreadId) -> Result<Vec<mixdog_protocol::ThreadItem>, CoreError> {
        Ok(self.transcript.iter().map(|item| serde_json::from_value(item.clone()).expect("a protocol item")).collect())
    }
    async fn request(&self, thread: &ThreadId, method: &'static str, params: Value) -> Result<Value, CoreError> {
        self.calls.lock().expect("calls").push((thread.as_str().to_owned(), method.to_owned(), params));
        Ok(self.reply.lock().expect("reply").clone())
    }
    fn interrupt(&self, _: &ThreadId) -> Result<bool, CoreError> {
        Ok(self.interrupted)
    }
    fn compact_after_turn(&self, thread: &ThreadId) -> Result<(), CoreError> {
        self.calls.lock().expect("calls").push((thread.as_str().to_owned(), "compact-after-turn".to_owned(), Value::Null));
        Ok(())
    }
}

struct Bots(Vec<&'static str>);

#[async_trait]
impl BotIds for Bots {
    async fn ids(&self) -> Result<Vec<String>, String> {
        Ok(self.0.iter().map(|s| (*s).to_owned()).collect())
    }
}

struct NoProjects;

#[async_trait]
impl ProjectList for NoProjects {
    async fn list(&self) -> Vec<mixdog_tools::orch::session::ProjectRow> {
        Vec::new()
    }
}

struct Titles(bool);

impl AiTitleSetting for Titles {
    fn enabled(&self) -> bool {
        self.0
    }
}

#[derive(Default)]
struct Suggested(Mutex<Vec<(String, String, bool)>>);

#[async_trait]
impl Suggestions for Suggested {
    async fn record(&self, key: &str, text: &str, dismissed: bool) -> Result<Value, String> {
        self.0.lock().expect("suggested").push((key.to_owned(), text.to_owned(), dismissed));
        Ok(json!({ "recorded": true }))
    }
}

struct Messages;

#[async_trait]
impl mixdog_core_ports::ports::memory_source::ThreadMessages for Messages {
    async fn messages(&self, _: &ThreadId) -> Result<Vec<Value>, PortError> {
        Ok(Vec::new())
    }
}

struct Now;

impl mixdog_agent::env::Clock for Now {
    fn now_ms(&self) -> i64 {
        42
    }
}

struct Port {
    port: Arc<DirectorySessionPort>,
    callers: Arc<ThreadCallers>,
    threads: Arc<Threads>,
    requests: Arc<Requests>,
    suggested: Arc<Suggested>,
}

fn port(headers: &[(&str, Value)], requests: Requests) -> Port {
    let threads = Arc::new(Threads::default());
    for (id, header) in headers {
        threads.0.lock().expect("threads").insert((*id).to_owned(), header.as_object().expect("object").clone());
    }
    let marks = HeartbeatSessions::new();
    let runs = UnattendedRunRegistry::new(Arc::new(NoStamps));
    let requests = Arc::new(requests);
    let suggested = Arc::new(Suggested::default());
    let callers = Arc::new(ThreadCallers::new(threads.clone(), marks, runs));
    let port = Arc::new(DirectorySessionPort::new(SessionPortParts {
        callers: callers.clone(),
        threads: threads.clone(),
        requests: requests.clone(),
        titles: Arc::new(mixdog_core_session::session::session_title::StoredTitles::new(threads.clone(), Arc::new(Messages), Arc::new(Now))),
        ai_titles: Arc::new(Titles(true)),
        projects: Arc::new(NoProjects),
        bots: Arc::new(Bots(vec!["ann"])),
        suggestions: suggested.clone(),
        io: mixdog_rt::testing::tokens().interactive_io,
    }));
    Port { port, callers, threads, requests, suggested }
}

fn thread(id: &str) -> ThreadId {
    ThreadId::from(id)
}

/// `attendedAgentOf` and `resolveSessionMode`: a bot's own chat is attended and acts as the bot;
/// a delegated worker, a coding session and an unattended run are not and do not.
#[tokio::test]
async fn the_caller_is_what_the_session_record_says() {
    let p = port(
        &[
            ("sess_home_ann", json!({ "sourceType": "exec" })),
            ("sess_home_lead", json!({ "sourceType": "exec" })),
            ("sess_work", json!({ "sourceType": "lead", "owner": "agent", "taskOrigin": { "sessionId": "sess_home_ann", "agentId": "ann" } })),
            ("sess_code", json!({ "sourceType": "lead" })),
        ],
        Requests::default(),
    );
    let ann = p.port.caller(&thread("sess_home_ann")).await;
    assert_eq!((ann.attended_agent.as_str(), ann.acting_bot.as_str(), ann.is_mixy_chat, ann.ai_titles_enabled), ("ann", "ann", false, true));
    assert!(ann.task_origin.is_none());
    assert!(p.port.caller(&thread("sess_home_lead")).await.is_mixy_chat);
    let worker = p.port.caller(&thread("sess_work")).await;
    assert_eq!((worker.attended_agent.as_str(), worker.acting_bot.as_str()), ("", ""));
    assert_eq!(worker.task_origin, Some(TaskOrigin { session_id: "sess_home_ann".into(), agent_id: "ann".into() }));
    // A coding Lead acts as Mixy's coding mode, not as a bot.
    let code = p.port.caller(&thread("sess_code")).await;
    assert_eq!((code.attended_agent.as_str(), code.acting_bot.as_str()), ("", ""));
}

#[tokio::test]
async fn a_task_session_reaches_its_origin_by_session_or_by_the_agents_home() {
    let p = port(&[], Requests::default());
    let origin = TaskOrigin { session_id: "sess_origin".into(), agent_id: "ann".into() };
    assert!(p.port.is_task_origin("sess_origin", &origin));
    assert!(p.port.is_task_origin("sess_home_ann", &origin));
    assert!(!p.port.is_task_origin("sess_home_bob", &origin));
    assert!(!p.port.is_task_origin("sess_other", &origin));
}

/// `resolveBotTarget`: a known bot id (Mixy or a contact) names its home chat; any other id, bot-shaped
/// or not, stays as it was.
#[tokio::test]
async fn a_bot_id_resolves_to_its_home_chat() {
    let p = port(&[], Requests::default());
    for (target, want) in [("ann", "sess_home_ann"), ("lead", "sess_home_lead"), ("bob", "bob"), ("sess_abc", "sess_abc"), ("", "")] {
        assert_eq!(p.port.resolve_target(target).await.expect("resolved"), want, "{target}");
    }
}

#[tokio::test]
async fn the_status_is_the_sessions_route_and_project() {
    let p = port(
        &[(
            "sess_a",
            json!({
                "title": "Fix it", "titleSource": "ai", "provider": "anthropic", "model": "claude-sonnet-4", "effort": "high",
                "autoEffort": false, "fast": true, "workspace": { "projectPath": "/proj" }
            }),
        ), ("sess_b", json!({ "desktopSession": { "projectPath": "/desk" } })), ("sess_c", json!({}))],
        Requests::default(),
    );
    let cwd = AbsPath::new(std::env::temp_dir()).expect("absolute");
    let shown = cwd.as_path().to_string_lossy().into_owned();
    let a = p.port.status(&thread("sess_a"), &cwd).await;
    assert_eq!(serde_json::to_value(&a).expect("json"), json!({
        "sessionId": "sess_a", "title": "Fix it", "titleSource": "ai", "cwd": shown, "project": "/proj",
        "provider": "anthropic", "model": "claude-sonnet-4", "effort": "high", "autoEffort": false, "fast": true
    }));
    assert_eq!(p.port.status(&thread("sess_b"), &cwd).await.project, "/desk");
    let c = p.port.status(&thread("sess_c"), &cwd).await;
    assert_eq!((c.project.as_str(), c.title, c.provider, c.auto_effort, c.fast), (shown.as_str(), None, None, true, false));
}

/// `updateSessionAiTitle`: a title the model chose never overwrites the user's, locks against
/// generated ones, and is a title as `normalizeSessionTitle` makes it.
#[tokio::test]
async fn a_model_title_never_overwrites_the_users() {
    let p = port(
        &[
            ("sess_user", json!({ "title": "Mine", "titleLocked": true })),
            ("sess_ai", json!({ "title": "Old", "titleLocked": true, "titleSource": "ai" })),
            ("sess_free", json!({ "title": "Old" })),
            ("sess_closed", json!({ "closed": true })),
        ],
        Requests::default(),
    );
    assert_eq!(p.port.rename(&thread("sess_user"), "New").await, Err(RenameError::UserTitle));
    assert_eq!(p.threads.header_of("sess_user")["title"], "Mine");
    assert_eq!(p.port.rename(&thread("sess_ai"), "  A   fresh\n title ").await, Ok("A fresh title".to_owned()));
    let header = p.threads.header_of("sess_ai");
    assert_eq!((header["title"].as_str(), header["titleLocked"].as_bool(), header["titleSource"].as_str()), (Some("A fresh title"), Some(true), Some("ai")));
    assert_eq!(header["titleUpdatedAt"], 42);
    assert_eq!(p.port.rename(&thread("sess_free"), &"x".repeat(150)).await, Ok("x".repeat(100)));
    assert_eq!(p.port.rename(&thread("sess_free"), "   ").await, Err(RenameError::Failed("empty-title".into())));
    assert_eq!(p.port.rename(&thread("sess_closed"), "T").await, Err(RenameError::Failed("not-found".into())));
    assert_eq!(p.port.rename(&thread("sess_gone"), "T").await, Err(RenameError::Failed("not-found".into())));
}

#[tokio::test]
async fn a_fork_is_a_new_thread_titled_as_a_copy() {
    let requests = Requests { reply: Mutex::new(json!({ "thread": { "id": "sess_copy" } })), ..Requests::default() };
    let p = port(&[("sess_a", json!({})), ("sess_copy", json!({ "title": "Fix it" }))], requests);
    assert_eq!(p.port.fork(&thread("sess_a"), false).await, Ok(("sess_copy".to_owned(), false)));
    let calls = p.requests.calls.lock().expect("calls").clone();
    assert_eq!((calls[0].0.as_str(), calls[0].1.as_str(), &calls[0].2["threadId"]), ("sess_a", "thread/fork", &json!("sess_a")));
    assert_eq!(calls.len(), 1, "a plain fork compacts nothing");
    let header = p.threads.header_of("sess_copy");
    assert_eq!((header["title"].as_str(), header["titleLocked"].as_bool(), header["titleSource"].as_str()), (Some("Fix it (Fork)"), Some(true), Some("ai")));
}

fn session_tool(p: &Port) -> mixdog_tools::orch::session::SessionTool {
    mixdog_tools::orch::session::SessionTool::new(p.port.clone(), p.callers.clone())
}

async fn answer(tool: &mixdog_tools::orch::session::SessionTool, context: &ToolContext, args: Value) -> Result<String, String> {
    match tool.call(context, args).await {
        Ok(out) => match &out.parts[0] {
            ToolPart::Text(text) => Ok(text.clone()),
            other => panic!("a text answer, got {other:?}"),
        },
        Err(error) => Err(error.message_for_model),
    }
}

/// `session action=compact|fork` (`fixtures/session-compact-cases`, recorded by `record-session-compact-cases.mjs`): the
/// tool's answers, the one compaction a compact leaves behind (asking again changes nothing), the Lead-only refusal, and
/// the lifecycle request of a fork with and without `compact` (the copy is compacted, never left uncompacted).
#[tokio::test]
async fn compact_and_fork_answer_as_the_node_session_tool_does() {
    let g = golden(mixdog_testkit::fixture!("../../fixtures/session-compact-cases/golden.json"));
    let case = |name: &str| g["cases"].as_array().expect("cases").iter().find(|c| c["case"] == name).unwrap_or_else(|| panic!("{name}"))["observed"].clone();
    let want_text = |recorded: &Value, from: &str, to: &str| recorded.as_str().expect("text").replace(from, to);
    let heirs = || Requests { reply: Mutex::new(json!({ "thread": { "id": "new-1" } })), ..Requests::default() };
    let compacts = |p: &Port| -> Vec<String> { p.requests.calls.lock().expect("calls").iter().filter(|c| c.1 == "compact-after-turn").map(|c| c.0.clone()).collect() };

    // compact: Node's one-shot set holds the caller once however often it asks.
    let recorded = case("compact schedules one compaction and asking again changes nothing");
    let p = port(&[("sess_main", json!({}))], heirs());
    let tool = session_tool(&p);
    let first = answer(&tool, &ctx(), json!({ "action": "compact" })).await.expect("scheduled");
    assert_eq!(first, want_text(&recorded["first"], "sess-1", "sess_main"));
    assert_eq!(compacts(&p), ["sess_main"]);
    let second = answer(&tool, &ctx(), json!({ "action": "compact" })).await.expect("scheduled");
    assert_eq!(second, want_text(&recorded["second"], "sess-1", "sess_main"));
    assert!(compacts(&p).iter().all(|id| id == "sess_main"), "only the caller's own thread is ever scheduled");

    // A delegated worker is refused before anything is scheduled.
    let refused = case("compact belongs to the Lead session");
    let p = port(&[("sess_main", json!({}))], heirs());
    let worker = ToolContext { surface: SurfaceKind::Agent, ..ctx() };
    let got = answer(&session_tool(&p), &worker, json!({ "action": "compact" })).await.expect_err("refused");
    assert_eq!(got, refused["error"].as_str().expect("message"));
    assert!(compacts(&p).is_empty());

    // fork: every recorded call shape.
    for (name, args) in [
        ("fork asks the lifecycle with compact true", json!({ "action": "fork", "compact": true })),
        ("fork asks the lifecycle with compact false", json!({ "action": "fork", "compact": false })),
        ("fork asks the lifecycle with compact undefined", json!({ "action": "fork" })),
    ] {
        let recorded = case(name);
        let compact = recorded["calls"][0][1]["compact"] == json!(true);
        let p = port(&[("sess_main", json!({})), ("new-1", json!({}))], heirs());
        let got = answer(&session_tool(&p), &ctx(), args).await.expect(name);
        assert_eq!(got, want_text(&recorded["out"], "sess-1", "sess_main"), "{name}");
        let methods: Vec<String> = p.requests.calls.lock().expect("calls").iter().map(|c| c.1.clone()).collect();
        let wanted: &[&str] = if compact { &["thread/fork", "thread/compact/start"] } else { &["thread/fork"] };
        assert_eq!(methods, wanted, "{name}");
    }
}

/// A fork asked to compact that cannot (nothing was reduced) leaves no copy behind, as Node's refusal leaves no heir.
#[tokio::test]
async fn a_fork_whose_compaction_is_skipped_is_removed_and_refused() {
    struct Skipping(Requests);
    #[async_trait]
    impl ThreadRequests for Skipping {
        async fn request(&self, thread: &ThreadId, method: &'static str, params: Value) -> Result<Value, CoreError> {
            let reply = self.0.request(thread, method, params).await?;
            Ok(if method == "thread/compact/start" { json!({ "skipped": true, "reason": "no reduction" }) } else { reply })
        }
        fn interrupt(&self, thread: &ThreadId) -> Result<bool, CoreError> {
            self.0.interrupt(thread)
        }
        fn compact_after_turn(&self, thread: &ThreadId) -> Result<(), CoreError> {
            self.0.compact_after_turn(thread)
        }
        async fn transcript(&self, thread: &ThreadId) -> Result<Vec<mixdog_protocol::ThreadItem>, CoreError> {
            self.0.transcript(thread).await
        }
    }
    let inner = Arc::new(Skipping(Requests { reply: Mutex::new(json!({ "thread": { "id": "sess_copy" } })), ..Requests::default() }));
    let p = port(&[("sess_a", json!({})), ("sess_copy", json!({}))], Requests::default());
    let port = DirectorySessionPort::new(SessionPortParts {
        callers: p.callers.clone(),
        threads: p.threads.clone(),
        requests: inner.clone(),
        titles: Arc::new(mixdog_core_session::session::session_title::StoredTitles::new(p.threads.clone(), Arc::new(Messages), Arc::new(Now))),
        ai_titles: Arc::new(Titles(true)),
        projects: Arc::new(NoProjects),
        bots: Arc::new(Bots(vec![])),
        suggestions: p.suggested.clone(),
        io: mixdog_rt::testing::tokens().interactive_io,
    });
    let error = port.fork(&thread("sess_a"), true).await.expect_err("refused");
    assert!(matches!(&error, PortError::Failed { message, .. } if message == "session: fork with compact failed (no reduction)"), "{error:?}");
    let methods: Vec<String> = inner.0.calls.lock().expect("calls").iter().map(|c| c.1.clone()).collect();
    assert_eq!(methods, ["thread/fork", "thread/compact/start", "thread/delete"]);
}

#[tokio::test]
async fn the_sidebar_flags_and_the_control_actions_become_thread_requests() {
    let requests = Requests { reply: Mutex::new(json!(true)), interrupted: true, ..Requests::default() };
    let p = port(&[("sess_a", json!({}))], requests);
    p.port.sidebar(&thread("sess_a"), SidebarFlag::Favorite, true).await.expect("favorite");
    p.port.sidebar(&thread("sess_a"), SidebarFlag::Archived, true).await.expect("archive");
    p.port.sidebar(&thread("sess_a"), SidebarFlag::Archived, false).await.expect("restore");
    let calls = p.requests.calls.lock().expect("calls").clone();
    assert_eq!(calls.iter().map(|c| c.1.as_str()).collect::<Vec<_>>(), ["thread/metadata/update", "thread/archive", "thread/unarchive"]);
    assert_eq!(calls[0].2["favorite"], true);
    let control = |action: &str| mixdog_tools::orch::session::ControlCall {
        action: action.to_owned(),
        args: json!({ "session_id": " sess_x " }),
        caller_thread: thread("sess_a"),
        caller: Default::default(),
        cwd: String::new(),
        attachment_parts: Vec::new(),
    };
    assert_eq!(p.port.control(control("cancel")).await, Ok(json!({ "sessionId": "sess_x", "aborted": true })));
    assert_eq!(p.port.control(control("delete")).await, Ok(json!({ "sessionId": "sess_x", "deleted": true })));
    assert!(matches!(p.port.control(control("zap")).await, Err(PortError::Unavailable { .. })));
}

#[tokio::test]
async fn a_proposal_is_recorded_with_its_key_and_the_dismissal() {
    let p = port(&[], Requests::default());
    assert_eq!(p.port.suggest("pause-routine:news", "Pause the news routine?", true).await, Ok(json!({ "recorded": true })));
    assert_eq!(*p.suggested.0.lock().expect("suggested"), [("pause-routine:news".to_owned(), "Pause the news routine?".to_owned(), true)]);
}

// --- `session action=list|read` quoting ------------------------------------------------------------

mod session_output_replay {
    use mixdog_core::run_host::tool_pool::session_output::ListPage;
    use mixdog_core::run_host::tool_pool::session_output::ReadRange;
    use mixdog_core::run_host::tool_pool::session_output::Rich;
    use mixdog_core::run_host::tool_pool::session_output::catalog_cursor_of;
    use mixdog_core::run_host::tool_pool::session_output::session_list_output;
    use mixdog_core::run_host::tool_pool::session_output::session_read_output;
    use serde_json::Value;
    use serde_json::json;

    fn cases() -> Vec<Value> {
        let g: Value = serde_json::from_str(mixdog_testkit::fixture!("../../fixtures/session-tool-output/golden.json")).expect("fixture");
        g["cases"].as_array().expect("cases").clone()
    }

    /// The recorder writes a generated text as `{ "repeat": [unit, count] }`.
    fn expand(value: &Value) -> Value {
        match value {
            Value::Object(map) if map.len() == 1 && map.contains_key("repeat") => {
                let (unit, count) = (map["repeat"][0].as_str().expect("unit"), map["repeat"][1].as_u64().expect("count"));
                json!(unit.repeat(count as usize))
            }
            Value::Object(map) => Value::Object(map.iter().map(|(k, v)| (k.clone(), expand(v))).collect()),
            Value::Array(items) => Value::Array(items.iter().map(expand).collect()),
            other => other.clone(),
        }
    }

    fn page(input: &Value) -> ListPage {
        let page = expand(&input["page"]);
        ListPage {
            sessions: page["sessions"].as_array().expect("sessions").clone(),
            next_cursor: page.get("nextCursor").and_then(Value::as_str).map(str::to_owned),
        }
    }

    fn list(input: &Value) -> Result<Value, String> {
        let page = page(input);
        let limit = input["limit"].as_u64().expect("limit") as usize;
        let own = input["richOwn"].as_str().map(str::to_owned);
        let own_row = |row: &Value| own.as_deref().is_some_and(|id| row["id"] == id);
        let rich = if own.is_some() { Rich::Own(&own_row) } else { Rich::Every(input["rich"] != json!(false)) };
        if input["cursorOf"].is_string() {
            return session_list_output(&page, limit, &rich, &|row| format!("after:{}", row["id"].as_str().expect("id")));
        }
        session_list_output(&page, limit, &rich, &catalog_cursor_of)
    }

    fn range(spec: &Value) -> ReadRange {
        ReadRange { offset: spec["offset"].as_u64().unwrap_or(0), items: expand(&spec["items"]).as_array().expect("items").clone(), has_older: spec["hasOlder"] == json!(true) }
    }

    fn read(id: &str, range: &ReadRange, text_offset: usize, item: Option<&str>) -> Value {
        session_read_output(id, range, text_offset, item).expect("read")
    }

    fn the<'a>(cases: &'a [Value], name: &str) -> &'a Value {
        cases.iter().find(|c| c["case"] == name).unwrap_or_else(|| panic!("case {name}"))
    }

    /// `sessionListOutput` of Node over every recorded page: selection fields, the caller's own rows, the working state,
    /// the budget cut and the cursor that continues after it; compared whole, key order included.
    #[test]
    fn list_output_equals_the_recorded_node_output() {
        let cases = cases();
        for case in &cases {
            let name = case["case"].as_str().expect("name");
            if !name.starts_with("list") && !name.starts_with("an archived") && !name.starts_with("rich") && !name.starts_with("a task") && !name.starts_with("a background") && !name.starts_with("a bot") && !name.starts_with("a working") && !name.starts_with("a budget") && !name.starts_with("an empty") {
                continue;
            }
            let observed = &case["observed"];
            if name.starts_with("list cuts") {
                // The rows are generated from the recorded spec.
                let spec = &case["input"]["rows"];
                let rows: Vec<Value> = (0..spec["count"].as_u64().expect("count"))
                    .map(|i| {
                        json!({
                            "id": format!("fixture_{i}"),
                            "title": spec["title"].as_str().expect("title").repeat(spec["titleRepeat"].as_u64().expect("n") as usize),
                            "status": "idle",
                            "cwd": format!("{}{}", spec["cwdRoot"].as_str().expect("root"), spec["cwdUnit"].as_str().expect("unit").repeat(spec["cwdRepeat"].as_u64().expect("n") as usize)),
                            "updatedAt": spec["updatedAtFrom"].as_i64().expect("from") - i as i64,
                            "providerReplay": { "secret": "not part of the tool result" },
                            "storageSize": 123,
                        })
                    })
                    .collect();
                let out = session_list_output(&ListPage { sessions: rows.clone(), next_cursor: None }, 100, &Rich::Every(true), &catalog_cursor_of).expect("listed");
                assert_eq!(out, observed["out"], "{name}");
                let cut = out["sessions"].as_array().expect("sessions").len();
                let cursor = mixdog_store::sqlite::lead::decode_catalog_cursor(out["nextCursor"].as_str()).expect("a cursor").expect("some");
                assert_eq!((mixdog_js::json_number(cursor.activity), json!(cursor.id)), (observed["cursor"]["activity"].clone(), observed["cursor"]["id"].clone()), "{name}");
                let remainder = session_list_output(&ListPage { sessions: rows[cut..].to_vec(), next_cursor: None }, 100, &Rich::Every(true), &catalog_cursor_of).expect("listed");
                assert_eq!(remainder["sessions"][0]["id"], observed["remainderFirstId"], "{name}");
                let keys: Vec<&String> = out["sessions"][0].as_object().expect("row").keys().collect();
                assert_eq!(json!(keys), observed["keys"], "{name}");
            } else if name.starts_with("an empty") {
                assert_eq!(session_list_output(&ListPage { sessions: vec![], next_cursor: None }, 25, &Rich::Every(true), &catalog_cursor_of).expect("listed"), observed["empty"], "{name}");
                let uncut = ListPage { sessions: vec![json!({ "id": "one" })], next_cursor: Some("service-cursor".into()) };
                assert_eq!(session_list_output(&uncut, 1, &Rich::Every(true), &catalog_cursor_of).expect("listed"), observed["uncut"], "{name}");
            } else {
                assert_eq!(list(&case["input"]).expect("listed"), *observed, "{name}");
            }
        }
    }

    /// `sessionReadOutput` of Node: row offsets from the newest, the text windows and their continuation, the byte budgets
    /// of the tail and of a later page, the attachment counts; compared whole.
    #[test]
    fn read_output_equals_the_recorded_node_output() {
        let cases = cases();
        let unit = "😀漢字\"\\\n";
        let case = the(&cases, "read preserves range indices and removes rendering metadata");
        let spec = &case["input"];
        assert_eq!(read("s", &range(&spec["range"]), 0, None), case["observed"]);

        let case = the(&cases, "read bounds UTF-8 and escaped text and keeps failure and cancellation signals");
        let mut items: Vec<Value> = (0..100).map(|_| json!({ "kind": "assistant", "text": unit.repeat(2000) })).collect();
        items.push(json!({ "kind": "tool", "name": "shell", "isError": true, "status": "cancelled", "result": "Error: cancelled by caller" }));
        let full = read("s", &ReadRange { offset: 0, items, has_older: false }, 0, None);
        assert_eq!(full, case["observed"]["full"]);
        assert_eq!(read("s", &ReadRange { offset: 0, items: vec![], has_older: false }, 0, None), case["observed"]["empty"]);

        let case = the(&cases, "attachment counts prefer canonical records");
        assert_eq!(read("s", &range(&case["input"]["range"]), 0, None), case["observed"]);

        for kind in ["assistant", "tool"] {
            let case = the(&cases, &format!("text continuation reconstructs {kind} text without splitting emoji"));
            let text = format!("  code\n{}", unit.repeat(2500));
            let item = if kind == "tool" { json!({ "id": "stable", "kind": kind, "result": text }) } else { json!({ "id": "stable", "kind": kind, "text": text }) };
            let one = ReadRange { offset: 9, items: vec![item], has_older: false };
            let (mut pages, mut text_offset, mut restored) = (Vec::new(), 0usize, String::new());
            loop {
                let out = read("s", &one, text_offset, Some("stable"));
                let shown = out["items"][0]["text"].as_str().expect("text").to_owned();
                let next = out["items"][0].get("nextTextOffset").cloned().unwrap_or(Value::Null);
                pages.push(json!({ "textOffset": text_offset, "text": shown.encode_utf16().count(), "nextTextOffset": next }));
                restored.push_str(&shown);
                match next.as_u64() {
                    Some(at) => text_offset = at as usize,
                    None => break,
                }
            }
            let observed = &case["observed"];
            assert_eq!(json!(pages), observed["pages"], "{kind}");
            assert_eq!(restored == text, observed["restoredIsText"] == json!(true), "{kind}");
            assert_eq!(session_read_output("s", &one, 2, Some("moved")).expect_err("stale"), observed["stale"].as_str().expect("message"), "{kind}");
            let pair = ReadRange { offset: 0, items: vec![json!({ "kind": "assistant", "text": "a😀b" })], has_older: false };
            assert_eq!(session_read_output("s", &pair, 2, None).expect_err("split"), observed["splits"].as_str().expect("message"), "{kind}");
        }

        let case = the(&cases, "tail and subsequent pages use the same budgets");
        let items: Vec<Value> = (0..100).map(|i| json!({ "id": i.to_string(), "kind": "assistant", "text": "a".repeat(2000) })).collect();
        assert_eq!(read("s", &ReadRange { offset: 0, items: items.clone(), has_older: true }, 0, None), case["observed"]["tail"]);
        assert_eq!(read("s", &ReadRange { offset: 100, items, has_older: true }, 0, None), case["observed"]["page"]);
    }
}

/// `session action=read` through the tool and the port: another session's stored transcript is quoted from its newest
/// row (offset 0), each row by Node's row kinds, with Node's argument refusals and its unavailable-session sentence.
#[tokio::test]
async fn read_quotes_the_stored_transcript_from_its_newest_row() {
    let transcript = vec![
        json!({ "type": "userMessage", "id": "u1", "content": [], "displayText": "fix it", "countsForPromptHistory": true }),
        json!({ "type": "agentMessage", "id": "a1", "text": "done" }),
        json!({ "type": "turnEnd", "id": "t1", "status": "done", "elapsedMs": 5 }),
    ];
    let p = port(&[("sess_main", json!({})), ("sess_other", json!({}))], Requests { transcript, ..Requests::default() });
    let tool = session_tool(&p);
    let context = ctx();
    let read = |args: Value| answer(&tool, &context, args);
    let out: Value = serde_json::from_str(&read(json!({ "action": "read", "session_id": "sess_other", "limit": 2 })).await.expect("read")).expect("json");
    assert_eq!(out["sessionId"], "sess_other");
    assert_eq!(out["items"][0], json!({ "kind": "assistant", "offset": 1, "id": "a1", "text": "done" }));
    assert_eq!((out["items"][1]["kind"].clone(), out["items"][1]["offset"].clone(), out["items"][1]["status"].clone()), (json!("turndone"), json!(0), json!("done")));
    assert_eq!(out["nextOffset"], 2, "an older row is left");
    let whole: Value = serde_json::from_str(&read(json!({ "action": "read", "session_id": "sess_other" })).await.expect("read")).expect("json");
    assert_eq!((whole["items"].as_array().map(Vec::len), whole["nextOffset"].clone()), (Some(3), Value::Null));
    let past: Value = serde_json::from_str(&read(json!({ "action": "read", "session_id": "sess_other", "offset": 2, "limit": 5 })).await.expect("read")).expect("json");
    assert_eq!((past["items"][0]["text"].clone(), past["offset"].clone()), (json!("fix it"), json!(2)));
    for (args, want) in [
        (json!({ "action": "read", "session_id": "sess_other", "limit": 0 }), "session: limit must be an integer from 1 to 100"),
        (json!({ "action": "read", "session_id": "sess_other", "offset": -1 }), "session: offset must be a nonnegative safe integer"),
        (json!({ "action": "read", "session_id": "sess_other", "text_offset": 3 }), "session: text_offset requires offset, limit:1 and item_id from read"),
        (json!({ "action": "read", "session_id": "sess_gone" }), "session: sess_gone is unavailable"),
    ] {
        let message = read(args).await.expect_err("refused");
        assert!(message.contains(want), "{message}");
    }
}
