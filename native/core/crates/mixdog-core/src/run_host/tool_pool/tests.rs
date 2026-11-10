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

use super::callers::ThreadCallers;
use super::model_surface::SurfaceInputs;
use super::model_surface::model_internal_tools;
use super::session_port::AiTitleSetting;
use super::session_port::BotIds;
use super::session_port::DirectorySessionPort;
use super::session_port::ProjectList;
use super::session_port::SessionPortParts;
use super::session_port::Suggestions;
use super::session_port::ThreadRequests;
use crate::run_host::unattended::UnattendedRunRegistry;
use mixdog_tools::policy::RunKind;

fn golden(text: &str) -> Value {
    serde_json::from_str(text).expect("fixture")
}

fn caller_golden() -> Value {
    golden(include_str!("../../../../../fixtures/tool-pool/caller-facts.json"))
}

fn tool_list_golden() -> Value {
    golden(include_str!("../../../../../fixtures/tool-pool/tool-list.json"))
}

fn dispatch_golden() -> Value {
    golden(include_str!("../../../../../fixtures/tool-pool/dispatch.json"))
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
}

#[async_trait]
impl ThreadRequests for Requests {
    async fn request(&self, thread: &ThreadId, method: &'static str, params: Value) -> Result<Value, CoreError> {
        self.calls.lock().expect("calls").push((thread.as_str().to_owned(), method.to_owned(), params));
        Ok(self.reply.lock().expect("reply").clone())
    }
    fn interrupt(&self, _: &ThreadId) -> Result<bool, CoreError> {
        Ok(self.interrupted)
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
    port: DirectorySessionPort,
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
    let port = DirectorySessionPort::new(SessionPortParts {
        callers: Arc::new(ThreadCallers::new(threads.clone(), marks, runs)),
        threads: threads.clone(),
        requests: requests.clone(),
        titles: Arc::new(mixdog_core_session::session::session_title::StoredTitles::new(threads.clone(), Arc::new(Messages), Arc::new(Now))),
        ai_titles: Arc::new(Titles(true)),
        projects: Arc::new(NoProjects),
        bots: Arc::new(Bots(vec!["ann"])),
        suggestions: suggested.clone(),
        listing: Arc::new(replay::Fixture::default()),
        io: mixdog_rt::testing::tokens().interactive_io,
    });
    Port { port, threads, requests, suggested }
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
    let header = p.threads.header_of("sess_copy");
    assert_eq!((header["title"].as_str(), header["titleLocked"].as_bool(), header["titleSource"].as_str()), (Some("Fix it (Fork)"), Some(true), Some("ai")));
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
    assert!(matches!(p.port.control(control("send")).await, Err(PortError::Unavailable { .. })));
}

#[tokio::test]
async fn a_proposal_is_recorded_with_its_key_and_the_dismissal() {
    let p = port(&[], Requests::default());
    assert_eq!(p.port.suggest("pause-routine:news", "Pause the news routine?", true).await, Ok(json!({ "recorded": true })));
    assert_eq!(*p.suggested.0.lock().expect("suggested"), [("pause-routine:news".to_owned(), "Pause the news routine?".to_owned(), true)]);
}
