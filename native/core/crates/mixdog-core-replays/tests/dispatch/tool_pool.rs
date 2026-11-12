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
use mixdog_core::run_host::tool_pool::session_output::ListPage;
use mixdog_core::run_host::tool_pool::session_port::AiTitleSetting;
use mixdog_core::run_host::tool_pool::session_port::LiveWork;
use mixdog_core::run_host::tool_pool::session_port::ThreadCatalog;
use mixdog_core::run_host::tool_pool::session_port::BotIds;
use mixdog_core::run_host::tool_pool::session_port::BotRow;
use mixdog_core::run_host::tool_pool::session_port::BotWorld;
use mixdog_core::run_host::tool_pool::session_port::SessionWork;
use mixdog_core::run_host::tool_pool::session_port::DirectorySessionPort;
use mixdog_core::run_host::tool_pool::session_port::ProjectList;
use mixdog_core::run_host::tool_pool::session_port::SessionPortParts;
use mixdog_core::run_host::tool_pool::session_port::Suggestions;
use mixdog_core::run_host::tool_pool::session_port::ThreadRequests;
use mixdog_core::run_host::unattended::UnattendedRunRegistry;
use mixdog_tools::policy::RunKind;

#[path = "session_project_node_cases.rs"]
mod session_project_node_cases;

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

#[path = "session_control_tests.rs"]
mod replay;

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
        // A page of the stored transcript, newest first, as `thread/items/list` answers it.
        if method == "thread/items/list" {
            let items: Vec<mixdog_protocol::ThreadItem> = self.transcript.iter().map(|item| serde_json::from_value(item.clone()).expect("a protocol item")).collect();
            let end = match params.get("cursor").and_then(Value::as_str) {
                Some(cursor) => items.iter().position(|item| item.id().as_str() == cursor).expect("cursor row"),
                None => items.len(),
            };
            let start = end.saturating_sub(params["limit"].as_u64().expect("limit") as usize);
            let data = items[start..end].to_vec();
            let has_older = start > 0;
            let next_cursor = has_older.then(|| data[0].id().as_str().to_owned());
            return Ok(serde_json::to_value(mixdog_app_protocol::v2::thread::ThreadItemsListResponse { data, has_older, has_newer: end < items.len(), next_cursor, backwards_cursor: None }).expect("page"));
        }
        // A fork carries the conversation compacted when asked, and answers that it did.
        let compacted = (method == "thread/fork").then(|| params.get("compact").cloned().unwrap_or(Value::Bool(false)));
        self.calls.lock().expect("calls").push((thread.as_str().to_owned(), method.to_owned(), params));
        let mut reply = self.reply.lock().expect("reply").clone();
        if let Some(compacted) = compacted {
            reply["compacted"] = compacted;
        }
        Ok(reply)
    }
    async fn set_caller_cwd(&self, _: &ThreadId, path: &str) -> Result<String, CoreError> {
        Ok(path.to_owned())
    }
    fn interrupt(&self, _: &ThreadId) -> Result<bool, CoreError> {
        Ok(self.interrupted)
    }
    fn compact_after_turn(&self, thread: &ThreadId) -> Result<(), CoreError> {
        self.calls.lock().expect("calls").push((thread.as_str().to_owned(), "compact-after-turn".to_owned(), Value::Null));
        Ok(())
    }
    async fn submit(&self, thread: &ThreadId, _: &Value, id: &str, _: u32, _: &[String], _: Option<&str>) -> Result<bool, CoreError> {
        self.calls.lock().expect("calls").push((thread.as_str().to_owned(), "submit".to_owned(), json!(id)));
        Ok(true)
    }
    async fn start(&self, params: Value) -> Result<Value, CoreError> {
        self.calls.lock().expect("calls").push((String::new(), "thread/start".to_owned(), params));
        Ok(self.reply.lock().expect("reply").clone())
    }
    fn turn_state(&self, _: &ThreadId) -> (u32, Vec<String>) {
        (0, Vec::new())
    }
}

struct Bots(Vec<&'static str>);

#[async_trait]
impl BotIds for Bots {
    async fn ids(&self) -> Result<Vec<String>, String> {
        Ok(self.0.iter().map(|s| (*s).to_owned()).collect())
    }
    async fn name(&self, id: &str) -> String {
        format!("Agent {id}")
    }
}

struct NoCatalog;

#[async_trait]
impl ThreadCatalog for NoCatalog {
    async fn page(&self, _: Option<&str>, _: usize) -> Result<ListPage, CoreError> {
        Ok(ListPage { sessions: Vec::new(), next_cursor: None })
    }
    async fn row(&self, _: &str) -> Result<Option<Value>, CoreError> {
        Ok(None)
    }
    fn live(&self) -> LiveWork {
        LiveWork::default()
    }
    fn work_of(&self, _: &str) -> SessionWork {
        SessionWork::default()
    }
}

/// No bots, routines, held requests or watches: the tests that do not read `session bots`.
struct NoBotWorld;

#[async_trait]
impl BotWorld for NoBotWorld {
    async fn bots(&self) -> Result<Vec<BotRow>, String> {
        Ok(Vec::new())
    }
    async fn routines(&self) -> Result<Vec<Value>, String> {
        Ok(Vec::new())
    }
    async fn held_requests(&self) -> Result<Vec<Value>, String> {
        Ok(Vec::new())
    }
    async fn task_watches(&self) -> Result<Vec<Value>, String> {
        Ok(Vec::new())
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
        catalog: Arc::new(NoCatalog),
        world: Arc::new(NoBotWorld),
        quota: mixdog_core_session::session::testing::Rig::new().quota.clone(),
        clock: Arc::new(Now),
        listing: Arc::new(replay::Fixture::default()),
        send: Arc::new(mixdog_core::run_host::tool_pool::session_send::LateSend::default()),
        bot_sources: Arc::new(mixdog_core::run_host::tool_pool::session_bots::LateBotSources::default()),
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
    let compacts = |p: &Port| -> Vec<String> { p.requests.calls.lock().expect("calls").iter().filter(|c| c.1 == "thread/compact/schedule").map(|c| c.0.clone()).collect() };

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

    // fork: every recorded call shape. A fork asked to compact is one `thread/fork` that carries the conversation compacted
    // (Node's `inheritToNewSession({ compact })`), whose real compaction `fork_compact_node_tests.rs` replays.
    let named = case("fork with compact true compacts the copy with the real compaction");
    let p = port(&[("sess_main", json!({})), ("new-1", json!({}))], heirs());
    let got = answer(&session_tool(&p), &ctx(), json!({ "action": "fork", "compact": true })).await.expect("fork with compact");
    let want = named["out"].as_str().expect("text").replace("sess_fork_compact_src", "sess_main").replace("<heir>", "new-1");
    assert_eq!(got, want);
    let calls = p.requests.calls.lock().expect("calls").clone();
    assert_eq!(calls.iter().map(|c| c.1.as_str()).collect::<Vec<_>>(), ["thread/fork"]);
    assert_eq!(calls[0].2["compact"], json!(true));
    for (name, args) in [
        ("fork asks the lifecycle with compact false", json!({ "action": "fork", "compact": false })),
        ("fork asks the lifecycle with compact undefined", json!({ "action": "fork" })),
    ] {
        let recorded = case(name);
        let p = port(&[("sess_main", json!({})), ("new-1", json!({}))], heirs());
        let got = answer(&session_tool(&p), &ctx(), args).await.expect(name);
        assert_eq!(got, want_text(&recorded["out"], "sess-1", "sess_main"), "{name}");
        let calls = p.requests.calls.lock().expect("calls").clone();
        assert_eq!(calls.iter().map(|c| c.1.as_str()).collect::<Vec<_>>(), ["thread/fork"], "{name}");
        assert_eq!(calls[0].2["compact"], json!(false), "{name}");
    }
}
#[tokio::test]
async fn the_sidebar_flags_and_the_control_actions_become_thread_requests() {
    let requests = Requests { reply: Mutex::new(json!(true)), interrupted: true, ..Requests::default() };
    let p = port(&[("sess_a", json!({})), ("sess_x", json!({}))], requests);
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
        (json!({ "action": "read", "session_id": "sess_gone" }), "session sess_gone is not available"),
    ] {
        let message = read(args).await.expect_err("refused");
        assert!(message.contains(want), "{message}");
    }
}

// --- `session action=list|send|create|status|bots` (`fixtures/session-control-cases`) ------------------------------------------

/// The catalog a case scripts: the pages in the order they are asked for, the rows read by id, the live sessions. The catalog is
/// the index of stored sessions (what Node's recording scripted as `listSessions`); every session itself is real.
struct ScriptedCatalog {
    pages: Mutex<std::collections::VecDeque<Value>>,
    rows: HashMap<String, Value>,
    live: LiveWork,
    approvals: HashSet<String>,
    directory: Arc<mixdog_core_session::session::SessionDirectory>,
    log: Arc<Mutex<Vec<Value>>>,
}

#[async_trait]
impl ThreadCatalog for ScriptedCatalog {
    async fn page(&self, cursor: Option<&str>, limit: usize) -> Result<ListPage, CoreError> {
        // The call Node's service made of its catalog, `includeAgentOnly` being its own.
        self.log.lock().expect("log").push(json!(["listSessions", { "page": { "limit": limit, "cursor": cursor }, "includeAgentOnly": false }]));
        let page = self.pages.lock().expect("pages").pop_front().unwrap_or_else(|| json!({ "sessions": [], "nextCursor": null }));
        Ok(ListPage { sessions: page["sessions"].as_array().cloned().unwrap_or_default(), next_cursor: page["nextCursor"].as_str().map(str::to_owned) })
    }
    async fn row(&self, id: &str) -> Result<Option<Value>, CoreError> {
        Ok(self.rows.get(id).cloned())
    }
    fn live(&self) -> LiveWork {
        // The sessions running a turn are the directory's own; the agents they work for are the case's.
        let mut live = self.live.clone();
        live.own.extend(self.directory.loaded_ids().into_iter().filter(|id| self.directory.thread_busy(id)).map(|id| id.as_str().to_owned()));
        live
    }
    fn work_of(&self, id: &str) -> SessionWork {
        SessionWork { handed_by: Vec::new(), awaiting_approval: self.approvals.contains(id) }
    }
}

/// Node's recorder: the agent work that is pending is the owners the case names; none is in flight.
struct PendingOwners(HashSet<String>);

#[async_trait]
impl mixdog_services::task_reports::host::AgentRegistry for PendingOwners {
    async fn owed_results(&self, _: &str) -> Vec<mixdog_services::task_reports::chain::Owed> {
        Vec::new()
    }
    fn in_flight(&self) -> mixdog_services::task_reports::host::InFlight {
        Default::default()
    }
    fn agent_task_owners(&self) -> HashSet<String> {
        self.0.clone()
    }
    fn agent_tasks(&self) -> Vec<mixdog_services::task_reports::chain::AgentTask> {
        Vec::new()
    }
    async fn stored_workers(&self, _: &HashSet<String>) -> Vec<Value> {
        Vec::new()
    }
    async fn settle_restart_failures(&self) -> Result<(), String> {
        Ok(())
    }
}

/// The store's listing over a case's scripted catalog: its pages in order, its rows by id and the live work laid over.
struct ScriptedListing {
    catalog: Arc<ScriptedCatalog>,
    now: i64,
}

fn listed(row: Value) -> mixdog_core::run_host::tool_pool::session_control::ListedRow {
    let archived = row["archived"] == json!(true);
    mixdog_core::run_host::tool_pool::session_control::ListedRow { row: row.as_object().cloned().unwrap_or_default(), archived }
}

#[async_trait]
impl mixdog_core::run_host::tool_pool::session_control::SessionListing for ScriptedListing {
    async fn page(&self, limit: usize, cursor: Option<&str>) -> Result<mixdog_core::run_host::tool_pool::session_control::ListingPage, String> {
        let page = self.catalog.page(cursor, limit).await.map_err(|error| format!("{error:?}"))?;
        Ok(mixdog_core::run_host::tool_pool::session_control::ListingPage { rows: page.sessions.into_iter().map(listed).collect(), next_cursor: page.next_cursor })
    }
    async fn row(&self, id: &str) -> Result<Option<mixdog_core::run_host::tool_pool::session_control::ListedRow>, String> {
        Ok(self.catalog.row(id).await.map_err(|error| format!("{error:?}"))?.map(listed))
    }
    async fn live_sources(&self) -> Result<mixdog_core::run_host::tool_pool::session_control::LiveSources, String> {
        let live = self.catalog.live();
        Ok(mixdog_core::run_host::tool_pool::session_control::LiveSources { working: live.own, agent_working: live.agents, pool: Vec::new(), now: self.now })
    }
}

/// What `session action=bots` reads besides the catalog: the case's bots, watches, held requests and routines.
struct ScriptedBotSources {
    bots: Vec<Value>,
    watches: Vec<Value>,
    held: Vec<Value>,
    routines: Result<Vec<Value>, String>,
    mixy: String,
    approvals: HashSet<String>,
    now: i64,
}

#[async_trait]
impl mixdog_core::run_host::tool_pool::session_bots::BotSources for ScriptedBotSources {
    async fn bots(&self) -> Result<Vec<Value>, String> {
        Ok(self.bots.clone())
    }
    async fn task_watches(&self) -> Result<Vec<Value>, String> {
        Ok(self.watches.clone())
    }
    async fn held(&self) -> Result<Vec<Value>, String> {
        Ok(self.held.clone())
    }
    async fn routines(&self) -> Result<Vec<Value>, String> {
        self.routines.clone()
    }
    async fn mixy_name(&self) -> Result<String, String> {
        Ok(self.mixy.clone())
    }
    fn awaiting_approval(&self, session_id: &str) -> bool {
        self.approvals.contains(session_id)
    }
    fn now_ms(&self) -> i64 {
        self.now
    }
}

struct ListedBots {
    ids: Vec<String>,
    mixy: Option<String>,
}

#[async_trait]
impl BotIds for ListedBots {
    async fn ids(&self) -> Result<Vec<String>, String> {
        Ok(self.ids.clone())
    }
    async fn name(&self, id: &str) -> String {
        match (&self.mixy, id) {
            (Some(name), "lead") => name.clone(),
            _ => format!("Agent {id}"),
        }
    }
}

/// The bots, routines, held requests and report watches a case's world holds.
struct ScriptedBotWorld {
    bots: Vec<BotRow>,
    routines: Result<Vec<Value>, String>,
    held: Vec<Value>,
    watches: Vec<Value>,
}

#[async_trait]
impl BotWorld for ScriptedBotWorld {
    async fn bots(&self) -> Result<Vec<BotRow>, String> {
        Ok(self.bots.clone())
    }
    async fn routines(&self) -> Result<Vec<Value>, String> {
        self.routines.clone()
    }
    async fn held_requests(&self) -> Result<Vec<Value>, String> {
        Ok(self.held.clone())
    }
    async fn task_watches(&self) -> Result<Vec<Value>, String> {
        Ok(self.watches.clone())
    }
}

struct ListedProjects(Vec<mixdog_tools::orch::session::ProjectRow>);

#[async_trait]
impl ProjectList for ListedProjects {
    async fn list(&self) -> Vec<mixdog_tools::orch::session::ProjectRow> {
        self.0.clone()
    }
}

struct At(i64);

impl mixdog_agent::env::Clock for At {
    fn now_ms(&self) -> i64 {
        self.0
    }
}

/// What the runs of a world saw, in the order they started: each run's thread and the input row it was handed.
struct Runs {
    inputs: Mutex<Vec<(String, Value)>>,
    started: tokio::sync::Notify,
    /// A turn whose prompt is `hold` stays in flight until this is given permits.
    release: tokio::sync::Semaphore,
}

/// The prompts the world's own seeding sends: a turn held in flight, and one that fails on the provider's quota.
const HOLD: &str = "hold";
const QUOTA: &str = "quota";

impl Runs {
    fn prompts(&self) -> Vec<(String, Value)> {
        self.inputs.lock().expect("runs").iter().filter(|(_, body)| !matches!(body["content"].as_str(), Some(HOLD | QUOTA))).cloned().collect()
    }
}

/// The session directory over the real thread store (SQLite index and files under a temp folder) with scripted runs: the
/// threads, their records, the turns and the thread requests are the product's own.
struct World {
    directory: Arc<mixdog_core_session::session::SessionDirectory>,
    runs: Arc<Runs>,
    quota: Arc<mixdog_core_base::quota_resume::QuotaResumeStore>,
    _rig: mixdog_core_session::session::testing::Rig,
    config: mixdog_core_config::config::Config,
    routes: Arc<dyn mixdog_core_domains::domains::ai_admin::chain::RouteContext>,
    service: Arc<mixdog_core_domains::domains::ai_admin::route_service::RouteService>,
    models: Arc<mixdog_core_domains::domains::ai_admin::model_list::ModelListService>,
    _data: tempfile::TempDir,
    _config: tempfile::TempDir,
}

/// The route facts of a route change: the window rule alone, no registered provider.
struct WindowFacts;

#[async_trait]
impl mixdog_core::run_host::route_change::RouteFacts for WindowFacts {
    fn context_meta(&self, provider: &str, model: &str, seed: &Value) -> Option<mixdog_core_run::run_host::session_context_meta::ContextMeta> {
        Some(mixdog_core_run::run_host::session_context_meta::resolve_context_meta(None, None, provider, model, seed, false))
    }
    fn cache_opts(&self, _: &str, _: &str, _: Option<&str>, _: &Header) -> Option<Value> {
        None
    }
}

struct Quiet;

impl mixdog_core_session::session::route_session::RouteStatusline for Quiet {
    fn write(&self, _: &str, _: &mixdog_core_ports::ports::route::Route, _: Option<u64>) {}
}

impl mixdog_core_session::session::route_session::ContextStatusCache for Quiet {
    fn invalidate(&self, _: &ThreadId) {}
}

struct NoBotRoutes;

#[async_trait]
impl mixdog_core_run::run_host::route_chain::BotRoutes for NoBotRoutes {
    async fn bot_route(&self, _: &str) -> Result<Option<Option<Value>>, mixdog_core_run::run_host::route_chain::RouteReadUnavailable> {
        Ok(None)
    }
    async fn stored_bot_route(&self, _: &str) -> Result<Option<Value>, mixdog_core_run::run_host::route_chain::RouteReadUnavailable> {
        Ok(None)
    }
}

impl mixdog_core_session::session::route_session::RouteConfig for Quiet {
    fn agent_config(&self) -> mixdog_core_ports::ports::domain_sessions::Obj {
        mixdog_core_ports::ports::domain_sessions::Obj::new()
    }
    fn bots(&self) -> &(dyn mixdog_core_run::run_host::route_chain::BotRoutes + Send + Sync) {
        &NoBotRoutes
    }
}

struct NoUsage;

impl mixdog_core_ports::ports::route_write::StatuslineUsage for NoUsage {
    fn refresh(&self, _: &ThreadId, _: &mixdog_ai::service::admin_route::Obj) {}
}

/// No model list is fetched: nothing replayed reads the network.
struct Offline;

#[async_trait]
impl mixdog_ai::transport::http::HttpSend for Offline {
    async fn send(
        &self,
        _: mixdog_core_api::domain::provider::WireRequest,
        _: mixdog_ai::transport::Exchange,
    ) -> Result<mixdog_ai::transport::http::HttpResponse, mixdog_core_api::domain::provider::ProviderError> {
        Err(mixdog_core_api::domain::provider::ProviderError::new(mixdog_core_api::domain::provider::ErrorKind::Transient, mixdog_core_api::domain::provider::DeliveryState::NotSent))
    }
}

/// The provider registry's builder: every provider builds a scripted adapter; no replayed call sends.
struct Builds;

#[async_trait]
impl mixdog_ai::registry::providers::ProviderBuilder for Builds {
    async fn build(&self, _: &str, _: &Value) -> Result<Arc<dyn mixdog_core_api::domain::provider::ProviderAdapter>, String> {
        Ok(Arc::new(mixdog_core_api::domain::mock::MockProvider::new([])))
    }
    async fn custom_key_ids(&self, _: &str) -> Result<Vec<String>, String> {
        Ok(Vec::new())
    }
    fn available(&self, _: &str) -> bool {
        true
    }
    async fn oauth_credentials_usable(&self, _: &str) -> Result<bool, String> {
        Ok(false)
    }
}
async fn real_store(data: &std::path::Path) -> Arc<dyn mixdog_core_session::session::ThreadStore> {
    use mixdog_core_api::domain::mock::MockOwnership;
    use mixdog_store::sqlite::SqliteStore;

    let tokens = mixdog_rt::testing::tokens();
    let root = data.to_path_buf();
    let index = mixdog_rt::LaneToken::submit(tokens.maintenance_io, &CancellationToken::new(), move |lane| SqliteStore::open(lane, tokens.sqlite_writer_thread, tokens.interactive_io, &root))
        .expect("lane")
        .await
        .expect("job ran")
        .expect("index");
    Arc::new(mixdog_core_session::session::StoreThreads::over_data_dir(data, index, Arc::new(MockOwnership::default()), tokens.maintenance_io).await.expect("the thread store"))
}

/// The world over the real route service (`RouteService` over `LiveRouteWriter`, `SessionRoutes` and the real config file):
/// a task started without a route of its own begins on the Lead route of that config, `lead` (`{provider, model}`).
async fn world(quota_reset: u64, lead: &Value) -> World {
    use mixdog_core_session::session::RunOutcome;
    use mixdog_core_session::session::testing::Rig;

    let data = tempfile::tempdir().expect("data dir");
    let store = real_store(data.path()).await;
    let rig = Rig::new();
    let runs = Arc::new(Runs { inputs: Mutex::default(), started: tokio::sync::Notify::new(), release: tokio::sync::Semaphore::new(0) });
    let seen = runs.clone();
    rig.set_script(Arc::new(move |run| {
        let runs = seen.clone();
        Box::pin(async move {
            run.port.input_durable().await.expect("the input is durable");
            runs.inputs.lock().expect("runs").push((run.thread.as_str().to_owned(), run.input_body.clone()));
            runs.started.notify_waiters();
            match run.input_body["content"].as_str() {
                Some(HOLD) => {
                    runs.release.acquire().await.expect("open").forget();
                    RunOutcome::Completed(Box::default())
                }
                Some(QUOTA) => RunOutcome::Failed(mixdog_core_session::session::testing::quota_error(quota_reset)),
                _ => RunOutcome::Completed(Box::default()),
            }
        })
    }));
    let late = Arc::new(mixdog_core::run_host::route_start::LateNewRoute::default());
    let mut deps = rig.deps_parts(store);
    deps.new_route = late.clone();
    let directory = Arc::new(mixdog_core_session::session::SessionDirectory::new(Arc::new(deps)));
    let threads = Arc::new(mixdog_core_session::session::thread_state::SessionThreads::new(directory.clone()));
    let change = Arc::new(mixdog_core::run_host::route_change::RunHostRouteChange::new(Arc::new(WindowFacts), Arc::new(At(0))));
    let adapter = Arc::new(mixdog_core_session::session::route_session::SessionRouteAdapter::new(directory.clone(), threads.clone(), change, Arc::new(Quiet), Arc::new(Quiet), Arc::new(Quiet), rig.clock.clone()));
    let config_dir = tempfile::tempdir().expect("config dir");
    let path = config_dir.path().join("mixdog-config.json");
    let agent = json!({ "default": "lead", "presets": [{ "id": "lead", "name": "Lead", "provider": lead["provider"], "model": lead["model"] }] });
    std::fs::write(&path, serde_json::to_vec(&json!({ "agent": agent })).expect("config")).expect("the config file");
    let tokens = mixdog_rt::testing::tokens();
    let lanes = mixdog_core_config::config::ConfigLanes { read: tokens.interactive_io, write: tokens.durability_io };
    let (config, _) = mixdog_core_config::config::Config::open(&path, Arc::new(mixdog_core_api::mock::MockStatePublisher::default()), lanes).await.expect("the config");
    let io = mixdog_ai::oauth::CredentialIo { read: tokens.interactive_io, write: tokens.durability_io };
    let metadata = mixdog_ai::catalog::ModelsDevSource::new(Arc::new(Offline), config_dir.path().to_path_buf(), io);
    let catalog = Arc::new(mixdog_ai::catalog::CatalogService::cold_start(mixdog_ai::catalog::CatalogSnapshot::default(), Vec::new(), metadata).await);
    let registry = Arc::new(mixdog_ai::registry::providers::ProviderRegistry::new(Arc::new(Builds)));
    let readiness = mixdog_ai::catalog::ProviderReadiness::new(registry, catalog.clone());
    let facts = Arc::new(mixdog_core_domains::domains::ai_admin::chain::CatalogFacts { catalog: catalog.clone(), readiness: readiness.clone(), config: config.clone() });
    let models = Arc::new(mixdog_core_domains::domains::ai_admin::model_list::ModelListService {
        catalog: catalog.clone(),
        config: config.clone(),
        primary_provider: Arc::new(String::new),
        unsupported: Arc::new(mixdog_ai::service::effort_configuration::UnsupportedEfforts::default()),
        host: None,
    });
    let cell = {
        let (config, facts) = (config.clone(), facts.clone());
        Arc::new(mixdog_core_session::session::route_cell::SessionRoutes::new(move |request: &mixdog_ai::service::admin_route::Obj| {
            mixdog_ai::service::admin_route::resolve_route(&config.agent(), request, &|provider, full| mixdog_core_domains::domains::ai_admin::chain::RouteFacts::is_known(&*facts, provider, full))
        }))
    };
    let follow = Arc::new(mixdog_core_ports::ports::route::SessionRoutes::new(threads.clone(), threads, adapter.clone(), cell.clone()));
    let writer = Arc::new(mixdog_core_ports::ports::route_write::LiveRouteWriter { cell, session: adapter, config: config.clone(), catalog, readiness, usage: Arc::new(NoUsage) });
    let routes: Arc<dyn mixdog_core_domains::domains::ai_admin::chain::RouteContext> = Arc::new(mixdog_core_domains::domains::ai_admin::chain::CatalogRouteContext { config: config.clone(), facts: facts.clone() });
    let (saved, listed) = (config.clone(), models.clone());
    let service = Arc::new(mixdog_core_domains::domains::ai_admin::route_service::RouteService { config, facts, writer, session: follow, models, controls: directory.clone() });
    assert!(late.bind(service.clone()).is_ok(), "one route service");
    World { directory, runs, quota: rig.quota.clone(), _rig: rig, _data: data, _config: config_dir, config: saved, routes, service, models: listed }
}

impl World {
    /// A stored session under `id` with `record` as its header (the session record Node's world held, bar its own id and the
    /// fields only Node's stub runtime read).
    async fn open(&self, id: &str, record: &Value) {
        let mut header: Header = record.as_object().cloned().unwrap_or_default();
        for key in ["id", "messages", "turnHop", "turnBotChain"] {
            header.remove(key);
        }
        self.directory.create_with_id(ThreadId::from(id), header, json!({})).await.expect("the session is created");
    }

    /// A turn the world holds in flight in `id` (at bot-to-bot depth `hop`, in `chain`) until it is released.
    async fn hold(&self, id: &str, prompt: &str, hop: u32, chain: &[String]) {
        let thread = ThreadId::from(id);
        assert!(self.directory.submit_chained_turn(&thread, &json!(prompt), &format!("seed-{id}-{prompt}"), hop, chain, &serde_json::Map::new(), "").await.is_some(), "{id} takes its turn");
        let (runs, handle) = (self.runs.clone(), self.directory.handle(&thread).expect("loaded"));
        mixdog_core_session::session::testing::eventually_on_awaiting(
            || format!("the {prompt} turn of {id} to start"),
            &[&runs.started, handle.stepped()],
            || runs.inputs.lock().expect("runs").iter().any(|(thread, body)| thread == id && body["content"] == json!(prompt)).then_some(()),
        )
        .await;
    }

    async fn read(&self, id: &str) -> Value {
        ThreadRequests::request(&*self.directory, &ThreadId::from(id), "thread/read", json!({ "threadId": id })).await.expect("thread/read")
    }
}

/// A quota resume of `id` is queued once its failed turn has settled (the queue is written on the store's own lane: the store tells when).
async fn wait_for_quota_resume(world: &World, id: &str) {
    let changed = Arc::new(tokio::sync::Notify::new());
    let wake = changed.clone();
    let _subscription = world.quota.subscribe(move |_| wake.notify_waiters());
    mixdog_core_session::session::testing::awaiting(
        || format!("the quota resume of {id} to be queued"),
        async {
            loop {
                let changed = changed.notified();
                tokio::pin!(changed);
                changed.as_mut().enable();
                if world.quota.entry(id).is_some() {
                    return;
                }
                changed.await;
            }
        },
    )
    .await;
}
fn nodes_row(id: &str, at: i64) -> Value {
    json!({ "id": id, "title": format!("Title of {id}"), "status": "idle", "cwd": "/project", "lastUsedAt": 1_700_000_000_000_i64 + at * 1000, "updatedAt": 1_700_000_000_000_i64 + at * 1000 })
}

/// `session action=list|send|create|status|bots` through the tool, the port, the thread requests and a real directory, case by
/// case from Node's recording: the same arguments in the same world (its `input`). What is compared is the answer or refusal
/// of the tool whole, and the effects Node's recording lists: the catalog pages asked for, the session a create made (read from
/// the created session's stored record: its folder, place and origin) and the prompts delivered (read from the input row of each
/// turn the prompt started in the session that took it). A refused call made no session.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn session_control_answers_as_the_node_session_tool_does_over_real_sessions() {
    let g = golden(mixdog_testkit::fixture!("../../fixtures/session-control-cases/golden.json"));
    let dir = tempfile::tempdir().expect("a folder");
    let work = mixdog_testkit::canonical(dir.path()).to_string_lossy().trim_start_matches(r"\\?\").to_owned();
    mixdog_testkit::create_dir_all(std::path::Path::new(&work).join("site"));
    let escaped = serde_json::to_string(&work).expect("json");
    let escaped = &escaped[1..escaped.len() - 1];
    // A folder inside an answer that is itself JSON text is escaped twice.
    let quoted = serde_json::to_string(escaped).expect("json");
    let quoted = quoted[1..quoted.len() - 1].to_owned();
    let request = fancy_regex::Regex::new("atask_[0-9a-f-]{36}").expect("a pattern");
    // The Lead route of the config Node ran with: the route every recorded create was made on.
    let created_on = |case: &Value| case["observed"]["calls"].as_array().and_then(|calls| calls.iter().find(|call| call[0] == "service.createSession")).map(|call| json!({ "provider": call[1]["provider"], "model": call[1]["model"] }));
    let lead = g["cases"].as_array().expect("cases").iter().find_map(created_on).expect("a recorded create");
    let mut failures: Vec<String> = Vec::new();
    for case in g["cases"].as_array().expect("cases") {
        let name = case["case"].as_str().expect("name");
        eprintln!("case: {name}");
        let (args, options) = (case["input"]["args"].clone(), &case["input"]["options"]);
        let ids = |key: &str| -> Vec<String> { options[key].as_array().map(|ids| ids.iter().map(|id| id.as_str().expect("id").to_owned()).collect()).unwrap_or_default() };
        let archived = ids("archived");
        let mark = |row: &Value| -> Value {
            let mut row = row.clone();
            if archived.iter().any(|id| row["id"] == json!(id)) {
                row["archived"] = json!(true);
            }
            row
        };
        let log = Arc::new(Mutex::new(Vec::new()));
        let pages: std::collections::VecDeque<Value> = if let Some(spec) = options.get("scanPages") {
            // The catalog Node generated for the scan cap: `pages` pages of `per` rows, each continuing (the last too when `more`).
            let (count, per) = (spec["pages"].as_u64().expect("pages"), spec["per"].as_u64().expect("per"));
            (0..count)
                .map(|page| {
                    let rows: Vec<Value> = (0..per).map(|i| nodes_row(&format!("sess_gen_{page}_{i}"), 1000 - (page * per + i) as i64)).collect();
                    json!({ "sessions": rows, "nextCursor": if page < count - 1 || spec["more"] == json!(true) { json!(format!("gen_{page}")) } else { Value::Null } })
                })
                .collect()
        } else {
            options["pages"].as_array().map(|pages| pages.iter().map(|page| json!({ "sessions": page["sessions"].as_array().map(|rows| rows.iter().map(&mark).collect::<Vec<_>>()), "nextCursor": page["nextCursor"] })).collect()).unwrap_or_default()
        };
        let rows: HashMap<String, Value> = options["rows"].as_object().map(|rows| rows.iter().map(|(id, row)| (id.clone(), mark(row))).collect()).unwrap_or_default();
        let mut live = LiveWork { own: ids_of(&options["live"]["own"]), agents: ids_of(&options["live"]["agents"]) };
        // The agents a session handed work to are still working: the catalog's live work.
        live.agents.extend(ids("pending"));
        let caller_record = options.get("callerSession").cloned().unwrap_or_else(|| json!({ "id": "caller", "sourceType": "lead" }));
        let caller_id = caller_record["id"].as_str().expect("caller id").to_owned();
        let snapshots = options["snapshots"].as_object().cloned().unwrap_or_default();
        let quota_reset = snapshots.values().find_map(|snapshot| snapshot["quotaResume"]["resetAt"].as_u64()).unwrap_or(5000);
        let world = world(quota_reset, &lead).await;
        // The sessions of the world: the stored ones, those with a route or title of their own, and the caller.
        let mut sessions = if options.get("sessions").is_some() { ids("sessions") } else { vec!["target".to_owned()] };
        sessions.extend(snapshots.keys().cloned());
        sessions.extend(options["titles"].as_object().into_iter().flat_map(|titles| titles.keys().cloned()));
        sessions.push(caller_id.clone());
        let mut seen = HashSet::new();
        for id in sessions.into_iter().filter(|id| seen.insert(id.clone())) {
            let mut record = if id == caller_id { caller_record.clone() } else { rows.get(&id).map(|row| json!({ "taskOrigin": row["taskOrigin"], "title": row["title"] })).unwrap_or_else(|| json!({})) };
            if let Some(snapshot) = snapshots.get(&id) {
                for key in ["cwd", "provider", "model", "effort", "autoEffort", "fast"] {
                    if let Some(value) = snapshot.get(key) {
                        record[key] = value.clone();
                    }
                }
            }
            if let Some(title) = options["titles"][id.as_str()].as_str() {
                record["title"] = json!(title);
            }
            world.open(&id, &record).await;
        }
        // The turn the caller is in carries its bot-to-bot depth and chain; a busy session runs a turn.
        let (hop, chain) = (caller_record["turnHop"].as_u64().unwrap_or(0) as u32, caller_record["turnBotChain"].as_array().map(|ids| ids.iter().map(|id| id.as_str().expect("id").to_owned()).collect::<Vec<_>>()).unwrap_or_default());
        if hop > 0 || !chain.is_empty() {
            world.hold(&caller_id, HOLD, hop, &chain).await;
        }
        for id in ids("busy") {
            world.hold(&id, HOLD, 0, &[]).await;
        }
        for (id, snapshot) in &snapshots {
            if !snapshot["quotaResume"].is_null() {
                world.hold(id, QUOTA, 0, &[]).await;
                wait_for_quota_resume(&world, id).await;
            }
        }
        let first = world.directory.loaded_ids();
        let threads: Arc<dyn ThreadState> = Arc::new(mixdog_core_session::session::thread_state::SessionThreads::new(world.directory.clone()));
        let hosted = mixdog_core_session::session::thread_settings_rig::hosted(&world.directory, Arc::new(mixdog_core_session::session::thread_state::SessionThreads::new(world.directory.clone())));
        let built = mixdog_core_session::session::thread_settings_rig::build(
            world.directory.clone(),
            hosted.workspaces.clone(),
            hosted.worktrees.clone(),
            Vec::new(),
            hosted.dir.path().join("task").to_string_lossy().into_owned(),
        )
        .await;
        let marks = HeartbeatSessions::new();
        if options["heartbeat"] == json!(true) {
            marks.mark(&caller_id);
        }
        let callers = Arc::new(ThreadCallers::new(threads.clone(), marks, UnattendedRunRegistry::new(Arc::new(NoStamps))));
        let bot_ids = if options.get("bots").is_some() { ids("bots") } else { vec!["ann".to_owned()] };
        let bot_rows: Vec<BotRow> = bot_ids.iter().map(|id| BotRow { id: id.clone(), name: options["botRows"][id.as_str()]["name"].as_str().unwrap_or(id).to_owned(), disabled: options["botRows"][id.as_str()]["disabled"] == json!(true) }).collect();
        let routines = match options["routinesError"].as_str() {
            Some(error) => Err(error.to_owned()),
            // The kind a routine is listed under is the store it came from (`channelSetup`'s schedules and webhooks).
            None => Ok(options["routines"].as_array().map(|rows| rows.iter().map(|row| {
                let mut row = row.clone();
                row["kind"] = json!(if row["webhook"] == json!(true) { "webhook" } else { "schedule" });
                row.as_object_mut().expect("a routine").remove("webhook");
                row
            }).collect()).unwrap_or_default()),
        };
        let now = options["now"].as_i64().unwrap_or_else(|| g["clock"]["dateNow"].as_i64().expect("the recorded clock"));
        let projects = Arc::new(ListedProjects(options["projects"].as_array().map(|rows| rows.iter().map(|row| mixdog_tools::orch::session::ProjectRow { name: row["name"].as_str().expect("name").to_owned(), path: row["path"].as_str().expect("path").to_owned() }).collect()).unwrap_or_default()));
        let catalog = Arc::new(ScriptedCatalog { pages: Mutex::new(pages), rows, live, approvals: ids("approvals").into_iter().collect(), directory: world.directory.clone(), log: log.clone() });
        // The catalog the tool lists through is the case's scripted one, as the store's listing hands it over.
        let listing = Arc::new(ScriptedListing { catalog: catalog.clone(), now });
        let bot_sources = Arc::new(ScriptedBotSources {
            bots: bot_rows.iter().map(|bot: &BotRow| if bot.disabled { json!({ "id": bot.id, "name": bot.name, "disabled": true }) } else { json!({ "id": bot.id, "name": bot.name }) }).collect(),
            watches: options["watches"].as_array().cloned().unwrap_or_default(),
            held: options["held"].as_array().cloned().unwrap_or_default(),
            routines: routines.clone(),
            mixy: options["mixy"].as_str().unwrap_or("Mixy").to_owned(),
            approvals: ids("approvals").into_iter().collect(),
            now,
        });
        // The send's intake as the product binds it: the turn a prompt starts is taken by the real directory, a create makes a real
        // session on the Lead route of the config, and a bot's send reports through the task-report host.
        let queue = Arc::new(mixdog_core_session::session::pending_read::PendingQueue::new(world.directory.clone(), Arc::new(mixdog_core_session::session::delivered::DeliveredCompletions::new(world._rig.clock.clone()))));
        let host = mixdog_services::task_reports::host::TaskReportHost::new(
            // Node's recorder ran no report queue: a watch is refused, and the send says its report could not be recorded.
            Arc::new(replay::HomeRecords::refusing(mixdog_services::bots::delivery::queue::WatchError::Failed("the report queue is not available in this runtime".into()))),
            Arc::new(mixdog_core::run_host::task_report_store::DirectoryReportSessions {
                directory: world.directory.clone(),
                queue,
                completions: Arc::new(mixdog_core_session::session::agent_registry::flow::SessionCompletions::new(world.directory.clone())),
                lane: mixdog_rt::testing::tokens().durability_io,
                data_dir: world._data.path().to_path_buf(),
                scopes: Vec::new(),
            }),
            Arc::new(PendingOwners(ids("pending").into_iter().collect())),
            Arc::new(mixdog_services::task_reports::host::BotWork::new(Arc::new(|_: &str| {}))),
            Arc::new(mixdog_services::bots::delivery::env::SleepRetry),
        );
        let tasks = mixdog_services::task_reports::send::TaskSends::with_timing(
            host,
            Arc::new(mixdog_core::run_host::tool_pool::session_send::DirectorySubmit(world.directory.clone())),
            "process".into(),
            Arc::new(|| 0),
            std::time::Duration::ZERO,
            mixdog_services::task_reports::follow::FINAL_POLL,
            Vec::new(),
        );
        let (caller_row, turn_of, row_of) = (caller_record.clone(), caller_id.clone(), caller_id.clone());
        let (turn_hop, turn_bots) = (hop, chain.clone());
        let send = Arc::new(mixdog_core::run_host::tool_pool::session_send::LateSend::default());
        send.bind(Arc::new(mixdog_core::run_host::tool_pool::session_send::SessionSend {
            rooms: Arc::new(mixdog_core_rooms::rooms::room_hosts::RoomHostRegistry::default()),
            directory: world.directory.clone(),
            tasks,
            chains: mixdog_core::run_host::tool_pool::session_send::CallerChains {
                record: Arc::new(move |id: &str| (id == row_of).then(|| caller_row.clone())),
                turn: Arc::new(move |id: &str| if id == turn_of { (turn_hop, turn_bots.clone()) } else { (0, Vec::new()) }),
            },
            // A bot is named `Agent <id>` and Mixy by her display name, as the world's bot list names them.
            names: Arc::new(replay::Named(bot_ids.iter().map(|id| json!({ "id": id, "name": format!("Agent {id}") })).chain([json!({ "id": "lead", "name": options["mixy"].as_str().unwrap_or("Agent lead") })]).collect())),
            catalog: Arc::new(mixdog_core::run_host::tool_pool::session_send::ModelListRows(world.models.clone())),
            effort: Arc::new(mixdog_core::run_host::tool_pool::session_send::RouteEffort(world.service.clone())),
            rebind: Arc::new(replay::NoRebind),
            create: Arc::new(mixdog_core::run_host::tool_pool::session_create::DirectoryCreate {
                directory: world.directory.clone(),
                projects: projects.clone(),
                config: world.config.clone(),
                routes: world.routes.clone(),
                listing: listing.clone(),
                data_dir: world._data.path().to_path_buf(),
                io: mixdog_rt::testing::tokens().interactive_io,
            }),
        }))
        .expect("one send");
        let port = Arc::new(DirectorySessionPort::new(SessionPortParts {
            callers: callers.clone(),
            threads: threads.clone(),
            requests: Arc::new(mixdog_core::run_host::tool_pool::session_port::SettingsRequests::new(world.directory.clone(), Arc::new(built.settings))),
            titles: Arc::new(mixdog_core_session::session::session_title::StoredTitles::new(threads.clone(), Arc::new(Messages), Arc::new(Now))),
            ai_titles: Arc::new(Titles(true)),
            projects,
            bots: Arc::new(ListedBots { ids: bot_ids.clone(), mixy: options["mixy"].as_str().map(str::to_owned) }),
            quota: world.quota.clone(),
            world: Arc::new(ScriptedBotWorld { bots: bot_rows, routines, held: options["held"].as_array().cloned().unwrap_or_default(), watches: options["watches"].as_array().cloned().unwrap_or_default() }),
            suggestions: Arc::new(Suggested::default()),
            catalog,
            clock: Arc::new(At(now)),
            listing,
            send,
            bot_sources,
            io: mixdog_rt::testing::tokens().interactive_io,
        }));
        let tool = mixdog_tools::orch::session::SessionTool::new(port, callers);
        // A call that names a caller other than the session record is a delegated worker's.
        let context = match options.get("calling").and_then(Value::as_str) {
            Some(other) => ToolContext { thread_id: ThreadId::from(other), surface: SurfaceKind::Agent, cwd: AbsPath::new(&work).expect("absolute"), ..ctx() },
            None => ToolContext { thread_id: ThreadId::from(caller_id.as_str()), cwd: AbsPath::new(&work).expect("absolute"), ..ctx() },
        };
        let answered = answer(&tool, &context, args).await;
        let created: Option<String> = answered.as_ref().ok().and_then(|text| serde_json::from_str::<Value>(text).ok()).and_then(|out| out["session_id"].as_str().map(str::to_owned)).filter(|id| !first.iter().any(|known| known.as_str() == id));
        let mut observed = match &answered {
            Ok(text) => json!({ "answer": text }),
            Err(error) => json!({ "error": error }),
        };
        let mut calls: Vec<Value> = log.lock().expect("log").clone();
        let created_threads: Vec<_> = world.directory.loaded_ids().into_iter().filter(|id| !first.contains(id)).collect();
        match &created {
            Some(id) => {
                assert_eq!(created_threads.iter().map(|id| id.as_str()).collect::<Vec<_>>(), [id.as_str()], "{name}: the create made one session");
                // The session a create started is what Node's service was asked to create: its folder, its place and its origin.
                let header = threads.header(&ThreadId::from(id.as_str())).await.expect("the created session");
                assert_eq!(header["sourceName"], json!(format!("agent:{}@home", header["taskOrigin"]["agentId"].as_str().expect("agent"))), "{name}: the task is tagged with where it came from");
                // Its route is the one the created session stored, through the route service.
                assert_eq!(created_on(case), Some(json!({ "provider": header["provider"], "model": header["model"] })), "{name}: the created session's stored route");
                calls.push(json!(["service.createSession", { "cwd": header["cwd"], "desktopSession": header["desktopSession"], "sessionProfile": { "taskOrigin": header["taskOrigin"] }, "provider": header["provider"], "model": header["model"] }]));
            }
            None => assert!(created_threads.is_empty(), "{name}: a call that created nothing made sessions {created_threads:?}"),
        }
        // The prompts the sessions took: each starts its first turn (or, behind a running turn, a later one) with the prompt as
        // its input row, stamped with the sender, the hop and the chain.
        let mut want = case["observed"].clone();
        let recorded = want["calls"].as_array().expect("calls").iter().filter(|call| call[0] == "runtime.submitAsync").count();
        world.runs.release.add_permits(10_000);
        let runs = world.runs.clone();
        mixdog_core_session::session::testing::eventually_on_awaiting(|| format!("{name}: {recorded} prompts to start a turn"), &[&runs.started], || (runs.prompts().len() >= recorded).then_some(())).await;
        assert_eq!(runs.prompts().len(), recorded, "{name}: the prompts delivered");
        for (thread, body) in runs.prompts() {
            let meta = &body["meta"]["transcript"];
            assert_eq!(body["role"], json!("user"), "{name}: a prompt is the user's row");
            let mut transcript = Map::new();
            for key in ["sender", "fromAgent", "hop", "botChain"] {
                if !meta[key].is_null() {
                    transcript.insert(key.to_owned(), meta[key].clone());
                }
            }
            // The plain sender's submission is named here only so its queue entry can carry the message's meta; Node names the
            // submission of a bot's send and of a create only.
            let id = meta["submissionIds"][0].as_str().expect("the submission id");
            let mut options = Map::new();
            if id.starts_with("atask_") {
                options.insert("id".to_owned(), json!(id));
            }
            options.insert("mode".to_owned(), json!("prompt"));
            options.insert("transcriptMeta".to_owned(), Value::Object(transcript));
            calls.push(json!(["runtime.submitAsync", thread, body["content"], options]));
        }
        observed["calls"] = json!(calls);
        observed["delivered"] = json!([]);
        // The quota resume a status reads comes from the real failed turn, whose key is generated by that turn (declared in the
        // manifest): the answer's is checked to be the key of the resume queued for it, then both sides name it <turn key>.
        if let (Some(answer), Some((id, _))) = (observed["answer"].as_str(), snapshots.iter().find(|(_, snapshot)| !snapshot["quotaResume"].is_null())) {
            let mut out: Value = serde_json::from_str(answer).expect("the answer");
            let queued = world.quota.entry(id).expect("the queued resume").turn_key;
            assert_eq!(out["quotaResume"]["turnKey"], json!(queued), "{name}: quotaResume.turnKey is the failed turn's");
            let model = snapshots[id]["model"].as_str().expect("the session's model");
            assert_eq!(out["quotaResume"]["model"], json!(mixdog_core_run::run_host::model_display::display_model_name(model, "")), "{name}: quotaResume.model is the display name of the session's model");
            for (key, placeholder) in [("turnKey", "<turn key>"), ("model", "<model name>")] {
                out["quotaResume"][key] = json!(placeholder);
            }
            observed["answer"] = json!(serde_json::to_string(&out).expect("json"));
            let recorded = want["answer"].as_str().expect("the recorded answer");
            let mut recorded: Value = serde_json::from_str(recorded).expect("the recorded answer");
            assert!(recorded["quotaResume"]["turnKey"].as_str().is_some_and(|key| !key.is_empty()), "{name}: the recording names a turn key");
            assert_eq!(recorded["quotaResume"]["model"], json!(model), "{name}: the recording names the session's model");
            for (key, placeholder) in [("turnKey", "<turn key>"), ("model", "<model name>")] {
                recorded["quotaResume"][key] = json!(placeholder);
            }
            want["answer"] = json!(serde_json::to_string(&recorded).expect("json"));
        }
        let names = |value: &Value| -> Value {
            let mut text = serde_json::to_string(value).expect("json").replace(&quoted, "<WORK>").replace(escaped, "<WORK>");
            if let Some(created) = &created {
                text = text.replace(created.as_str(), "<created>");
            }
            serde_json::from_str(&request.replace_all(&text, "<request>")).expect("json")
        };
        let got = names(&observed);
        if got != want {
            failures.push(format!("{name}: {}\n  got:  {got}\n  want: {want}", case["input"]["args"]));
        }
    }
    assert!(failures.is_empty(), "{} cases differ:\n{}", failures.len(), failures.join("\n"));
}

fn ids_of(value: &Value) -> Vec<String> {
    value.as_array().map(|ids| ids.iter().map(|id| id.as_str().expect("id").to_owned()).collect()).unwrap_or_default()
}
