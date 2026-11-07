//! The turn assembly's WP-MCP seams over their services: explicit skill selection
//! (`ExplicitSkillSelector`) replayed against the messages today's Node product added to the
//! transcript (`mixdog-mcp/tests/golden/skillprep.mjs`), and the post-tool dispatch's delegation
//! to the hook bus (the hook payloads and decisions themselves are replayed by
//! `mixdog-mcp/tests/posttool_suite.rs`).

use std::collections::HashSet;
use std::path::Path;
use std::sync::Arc;
use std::sync::Mutex;
use std::sync::atomic::AtomicUsize;
use std::sync::atomic::Ordering;

use async_trait::async_trait;
use mixdog_agent::env::GateCall;
use mixdog_agent::env::GateDecision;
use mixdog_agent::env::SkillSelector;
use mixdog_agent::env::ToolGate;
use mixdog_agent::message::AgentMessage;
use mixdog_agent::message::Source;
use mixdog_agent::tools::ToolEnv;
use mixdog_core::run_host::hooks::PostToolDispatch;
use mixdog_core::run_host::hooks::PostToolEvent;
use mixdog_core::run_host::mcp_seams::BusPostToolDispatch;
use mixdog_core::run_host::mcp_seams::ExplicitSkillSelector;
use mixdog_core_api::domain::mock::MockApprovalGate;
use mixdog_core_api::domain::mock::MockFileService;
use mixdog_core_api::domain::mock::MockProcessManager;
use mixdog_core_api::domain::mock::MockProgress;
use mixdog_core_api::domain::provider::Content;
use mixdog_core_api::domain::provider::ContentPart;
use mixdog_core_api::domain::tool::FollowUpMessage;
use mixdog_core_api::domain::tool::SurfaceKind;
use mixdog_core_api::domain::tool::Tool;
use mixdog_core_api::domain::tool::ToolAnnotations;
use mixdog_core_api::domain::tool::ToolContext;
use mixdog_core_api::domain::tool::ToolError;
use mixdog_core_api::domain::tool::ToolErrorCode;
use mixdog_core_api::domain::tool::ToolIo;
use mixdog_core_api::domain::tool::ToolOutcome;
use mixdog_core_api::domain::tool::ToolOutput;
use mixdog_core_api::domain::tool::ToolPart;
use mixdog_core_api::domain::tool::ToolSpec;
use mixdog_core_ports::ports::gate::GateEnv;
use mixdog_core_ports::ports::gate::GateRun;
use mixdog_core::run_host::mcp_seams::AllowAllActions;
use mixdog_core::run_host::mcp_seams::CatalogSkillsListed;
use mixdog_core::run_host::mcp_seams::ConfigAllowAll;
use mixdog_core::run_host::mcp_seams::ContactBots;
use mixdog_core::run_host::mcp_seams::HostGateEnv;
use mixdog_core::run_host::mcp_seams::McpAwareResolver;
use mixdog_core::run_host::mcp_seams::UnattendedRuns;
use mixdog_core::run_host::session_tools::SkillsListed;
use mixdog_mcp::McpHub;
use mixdog_mcp::McpIo;
use mixdog_mcp::result::OutputPolicy;
use mixdog_mcp::skill_catalog::SkillCatalog;
use mixdog_store::schema::record::Header;
use mixdog_tools::policy::RunKind;
use mixdog_tools::policy::ToolResolver;
use mixdog_mcp::hook_bus::HookBus;
use mixdog_mcp::hook_bus::HookCommon;
use mixdog_mcp::skill_select::SkillNames;
use mixdog_protocol::JsonValue;
use mixdog_protocol::ThreadId;
use mixdog_protocol::TurnId;
use serde_json::Value;
use serde_json::json;
use tokio_util::sync::CancellationToken;

struct Names {
    available: HashSet<String>,
    fail: bool,
}

#[async_trait]
impl SkillNames for Names {
    async fn names(&self, _: &Path) -> Result<HashSet<String>, String> {
        if self.fail { Err("the catalog is unreadable".to_owned()) } else { Ok(self.available.clone()) }
    }
}

/// A `Skill` tool that answers each skill with the golden's fixed result.
struct SkillTool {
    spec: ToolSpec,
    answers: Value,
    calls: Mutex<Vec<String>>,
}

#[async_trait]
impl Tool for SkillTool {
    fn spec(&self) -> &ToolSpec {
        &self.spec
    }

    async fn call(&self, _: &ToolContext, args: JsonValue) -> ToolOutcome {
        let name = args["name"].as_str().unwrap().to_owned();
        self.calls.lock().unwrap().push(name.clone());
        let fallback = json!(format!("Loaded skill: {name}"));
        match self.answers.get(&name).unwrap_or(&fallback) {
            Value::String(text) if text.starts_with("Error: ") => Err(ToolError::new(ToolErrorCode::Internal { incident_id: String::new() }, text.clone())),
            Value::String(text) => Ok(ToolOutput { parts: vec![ToolPart::Text(text.clone())], ..ToolOutput::default() }),
            envelope => Ok(ToolOutput {
                parts: vec![ToolPart::Text(envelope["result"].as_str().unwrap().to_owned())],
                follow_up_messages: envelope["bodies"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .map(|b| FollowUpMessage { text: b.as_str().unwrap().to_owned(), meta: Some("skill".to_owned()) })
                    .collect(),
                ..ToolOutput::default()
            }),
        }
    }
}

struct Gate {
    deny: Option<String>,
}

#[async_trait]
impl ToolGate for Gate {
    async fn check_call(&self, _: &str, _: &GateCall) -> GateDecision {
        GateDecision::Allow
    }

    fn pre_dispatch_deny(&self, _: &GateCall) -> Option<String> {
        self.deny.clone()
    }
}

fn tool_env() -> ToolEnv {
    let tokens = mixdog_rt::testing::tokens();
    ToolEnv {
        thread_id: ThreadId::from("t"),
        turn_id: TurnId::from("r"),
        cwd: mixdog_core_api::domain::common::AbsPath::new(std::env::temp_dir()).unwrap(),
        surface: SurfaceKind::Lead,
        io: ToolIo { interactive: tokens.interactive_io, durability: tokens.durability_io, maintenance: tokens.maintenance_io },
        approvals: Arc::new(MockApprovalGate::default()),
        files: Arc::new(MockFileService::default()),
        processes: Arc::new(MockProcessManager::default()),
        progress: Arc::new(MockProgress::default()),
        deadline_of: None,
        notify: None,
        review: None,
    }
}

fn golden() -> Value {
    serde_json::from_str(include_str!("../../mixdog-mcp/tests/golden/skillprep.json")).unwrap()
}

fn selector(golden: &Value, deny: Option<&str>, fail: bool) -> (ExplicitSkillSelector, Arc<SkillTool>) {
    let available = golden["available"].as_array().unwrap().iter().map(|n| n.as_str().unwrap().to_owned()).collect();
    let tool = Arc::new(SkillTool {
        spec: ToolSpec {
            name: "Skill".to_owned(),
            title: None,
            trigger: None,
            public: true,
            aliases: Vec::new(),
            description: String::new(),
            input_schema: json!({"type": "object"}),
            annotations: ToolAnnotations::default(),
            parallel_safe: true,
            exclusive_with: Vec::new(),
        },
        answers: golden["answers"].clone(),
        calls: Mutex::new(Vec::new()),
    });
    let selector = ExplicitSkillSelector::new(
        Arc::new(Names { available, fail }),
        tool.clone(),
        Arc::new(Gate { deny: deny.map(str::to_owned) }),
        tool_env(),
        CancellationToken::new(),
    );
    (selector, tool)
}

fn content_of(prompt: &Value) -> Content {
    match prompt {
        Value::String(text) => Content::Text(text.clone()),
        Value::Array(parts) => Content::Parts(parts.iter().map(|p| ContentPart::Text(p["text"].as_str().unwrap().to_owned(), None)).collect()),
        other => panic!("{other}"),
    }
}

/// A transcript message as the golden writes it: its text and its `meta`.
fn shown(message: &AgentMessage) -> (String, Value) {
    let Content::Text(text) = &message.message.content else { panic!("text expected") };
    let meta = match message.source {
        Some(Source::SkillContext) => json!({"source": "skill-context"}),
        Some(Source::Skill) => json!("skill"),
        other => panic!("source {other:?}"),
    };
    (text.clone(), meta)
}

#[tokio::test(flavor = "multi_thread")]
async fn explicit_selection_adds_what_node_adds_to_the_transcript() {
    let golden = golden();
    for case in golden["cases"].as_array().unwrap() {
        let label = format!("{}", case["prompt"]);
        let (selector, tool) = selector(&golden, None, false);
        let mut transcript = Vec::new();
        selector.select(&content_of(&case["prompt"]), &mut transcript).await;
        let calls: Vec<&str> = case["calls"].as_array().unwrap().iter().map(|c| c["args"]["name"].as_str().unwrap()).collect();
        assert_eq!(*tool.calls.lock().unwrap(), calls, "{label}: skills loaded");
        let got: Vec<(String, Value)> = transcript.iter().map(shown).collect();
        let expected: Vec<(String, Value)> =
            case["messages"].as_array().unwrap().iter().map(|m| (m["content"].as_str().unwrap().to_owned(), m["meta"].clone())).collect();
        assert_eq!(got, expected, "{label}: transcript");
    }
}

/// `selection`, when given (even empty), is read instead of the prompt (`prepareExplicitSkills`).
#[tokio::test(flavor = "multi_thread")]
async fn a_trusted_selection_replaces_the_prompt_even_when_empty() {
    let golden = golden();
    let (selector, tool) = selector(&golden, None, false);
    let selector = selector.with_selection(Some("$alpha".to_owned()));
    let mut transcript = Vec::new();
    selector.select(&Content::Text("no mention here".to_owned()), &mut transcript).await;
    assert_eq!(*tool.calls.lock().unwrap(), ["alpha"]);

    let (selector, tool) = self::selector(&golden, None, false);
    let selector = selector.with_selection(Some(String::new()));
    let mut transcript = Vec::new();
    selector.select(&Content::Text("$alpha".to_owned()), &mut transcript).await;
    assert!(transcript.is_empty() && tool.calls.lock().unwrap().is_empty());
}

#[tokio::test(flavor = "multi_thread")]
async fn a_session_that_cannot_call_skill_selects_nothing() {
    let golden = golden();
    let (selector, tool) = selector(&golden, Some("Skill is not available here"), false);
    let mut transcript = Vec::new();
    selector.select(&Content::Text("$alpha".to_owned()), &mut transcript).await;
    assert!(transcript.is_empty() && tool.calls.lock().unwrap().is_empty());
}

#[tokio::test(flavor = "multi_thread")]
async fn an_unreadable_catalog_selects_nothing() {
    let golden = golden();
    let (selector, tool) = selector(&golden, None, true);
    let mut transcript = Vec::new();
    selector.select(&Content::Text("$alpha".to_owned()), &mut transcript).await;
    assert!(transcript.is_empty() && tool.calls.lock().unwrap().is_empty());
}

fn named_tool(name: &str, aliases: &[&str]) -> Arc<dyn Tool> {
    Arc::new(SkillTool {
        spec: ToolSpec {
            name: name.to_owned(),
            title: None,
            trigger: None,
            public: true,
            aliases: aliases.iter().map(|a| (*a).to_owned()).collect(),
            description: String::new(),
            input_schema: json!({"type": "object"}),
            annotations: ToolAnnotations::default(),
            parallel_safe: true,
            exclusive_with: Vec::new(),
        },
        answers: json!({}),
        calls: Mutex::new(Vec::new()),
    })
}

fn empty_hub() -> Arc<McpHub> {
    let tokens = mixdog_rt::testing::tokens();
    McpHub::new(McpIo { spawn: tokens.spawn_io, durability: tokens.durability_io }, std::env::temp_dir().join("mcp-seams-artifacts"), OutputPolicy::default())
}

#[tokio::test(flavor = "multi_thread")]
async fn the_resolver_finds_pool_tools_by_name_or_alias_and_nothing_else_without_a_server() {
    let resolver = McpAwareResolver::new(vec![named_tool("read", &["Read"]), named_tool("grep", &[])], empty_hub());
    let name = |found: Option<Arc<dyn Tool>>| found.map(|tool| tool.spec().name.clone());
    assert_eq!(name(resolver.resolve(None, "read")).as_deref(), Some("read"));
    assert_eq!(name(resolver.resolve(None, "Read")).as_deref(), Some("read"));
    assert_eq!(name(resolver.resolve(None, "grep")).as_deref(), Some("grep"));
    assert!(resolver.resolve(None, "edit").is_none());
    // An MCP tool of a server the hub does not run resolves to nothing (so the call is not outbound).
    assert!(resolver.resolve(None, "mcp__mail__send").is_none());
}

struct Runs(Option<GateRun>);
#[async_trait]
impl UnattendedRuns for Runs {
    async fn run_of(&self, thread: &ThreadId) -> Option<GateRun> {
        (thread.as_str() == "sess_task").then(|| self.0.clone()).flatten()
    }
}

struct Contacts;
#[async_trait::async_trait]
impl ContactBots for Contacts {
    async fn is_contact_bot(&self, agent_id: &str) -> bool {
        agent_id == "ann"
    }
}

struct AllowAll(bool);
impl AllowAllActions for AllowAll {
    fn allow_all_actions(&self) -> bool {
        self.0
    }
}

/// The gate's connector account is the hub's choice among the connector's accounts
/// (`resolveMcpToolAccount`); the other three answers come from their owners.
#[tokio::test(flavor = "multi_thread")]
async fn the_gate_env_binds_a_connector_call_to_the_hubs_account_choice() {
    use mixdog_mcp::McpServerConfig;
    use mixdog_mcp::connector_accounts::AccountHealth;
    use mixdog_mcp::connector_accounts::AccountReport;
    use mixdog_mcp::connector_accounts::AccountSeed;
    use mixdog_mcp::connector_accounts::ConnectorAccounts;

    let tokens = mixdog_rt::testing::tokens();
    let dir = tempfile::tempdir().unwrap();
    let hub = empty_hub();
    // The server never starts (no such program), but it is known: a call resolves to it.
    let missing = dir.path().join("no-such-program");
    hub.apply(vec![McpServerConfig::from_entry("linear", &json!({"command": missing.to_string_lossy()}), &std::env::vars().collect()).unwrap()]);
    let seeds = [("linear", "a@example.com"), ("linear-2", "b@example.com")]
        .map(|(name, email)| AccountSeed { name: name.to_owned(), id: format!("{name}|{email}"), email: email.to_owned() })
        .to_vec();
    let accounts = ConnectorAccounts::new("linear", seeds, Arc::new(AccountHealth::default()), dir.path().to_path_buf(), tokens.maintenance_io).unwrap();
    for name in ["linear", "linear-2"] {
        accounts.note_tools(name, vec!["search".to_owned()]);
        accounts.record(name, &AccountReport::default());
    }
    accounts.set_listed(vec!["search".to_owned()]);
    hub.set_connector_accounts("linear", accounts);

    let run = GateRun { kind: RunKind::Schedule, agent_id: "ann".to_owned() };
    let env = HostGateEnv::new(Arc::new(Runs(Some(run.clone()))), Arc::new(Contacts), Arc::new(AllowAll(true)), hub);
    let header = Header::new();
    let bound = |args: Value| {
        let call = GateCall::new("mcp__linear__search", args);
        let (env, header) = (&env, &header);
        async move { env.connector_account(&ThreadId::from("sess_a"), header, &call).await }
    };
    // The account the call names; without one, the connector's default.
    let named = bound(json!({"account": "linear-2"})).await.unwrap().unwrap();
    assert_eq!((named.name.as_str(), named.label.as_str()), ("linear-2", "b@example.com"));
    let default = bound(json!({})).await.unwrap().unwrap();
    assert_eq!((default.name.as_str(), default.label.as_str()), ("linear", "a@example.com"));
    // An account that does not exist is the refusal, with the usable ones listed.
    let refusal = bound(json!({"account": "nobody"})).await.unwrap_err();
    assert_eq!(refusal, "No connected Linear account is \"nobody\". Usable Linear accounts: a@example.com, b@example.com. Pass one as `account`.");
    // A session of another MCP scope has none of this scope's accounts (`resolveMcpToolAccount` reads its `scopeId`).
    let mut elsewhere = Header::new();
    elsewhere.insert("mcpScopeId".to_owned(), json!("agent-runtime-7"));
    let search = GateCall::new("mcp__linear__search", json!({}));
    assert_eq!(env.connector_account(&ThreadId::from("sess_a"), &elsewhere, &search).await, Ok(None));
    // A tool of a server the hub does not know is bound to nothing.
    let other = GateCall::new("mcp__other__search", json!({}));
    assert_eq!(env.connector_account(&ThreadId::from("sess_a"), &header, &other).await, Ok(None));

    assert_eq!(env.run_of(&ThreadId::from("sess_task")).await, Some(run));
    assert_eq!(env.run_of(&ThreadId::from("sess_a")).await, None);
    assert!(env.is_contact_bot("ann").await && !env.is_contact_bot("bob").await);
    assert!(env.allow_all_actions());
}

/// "Allow all actions" is on only when the stored option is `true` (`developerOptionEnabledStrict`).
/// Writes `body` to `path` (parent directories made) as a durability-lane job.
async fn write_file(path: &Path, body: &[u8]) {
    use mixdog_rt::LaneToken;
    let (path, body) = (path.to_owned(), body.to_vec());
    mixdog_rt::testing::tokens()
        .durability_io
        .submit(&tokio_util::sync::CancellationToken::new(), move |lane| {
            mixdog_statefile::write_file(lane, &path, &body, &mixdog_statefile::Opts::default())
        })
        .unwrap()
        .await
        .unwrap()
        .unwrap();
}

/// `std::fs::remove_dir_all(path).unwrap()` as a durability-lane job.
async fn remove_dir_all(path: &Path) {
    use mixdog_rt::LaneToken;
    let path = path.to_owned();
    mixdog_rt::testing::tokens()
        .durability_io
        .submit(&tokio_util::sync::CancellationToken::new(), move |lane| mixdog_statefile::remove_dir_all(lane, &path))
        .unwrap()
        .await
        .unwrap()
        .unwrap();
}

#[tokio::test(flavor = "multi_thread")]
async fn allow_all_actions_is_on_only_for_a_stored_true() {
    use mixdog_core_config::config::Config;
    use mixdog_core_config::config::ConfigLanes;
    use mixdog_core_api::mock::MockStatePublisher;

    let tokens = mixdog_rt::testing::tokens();
    let dir = tempfile::tempdir().unwrap();
    for (index, (stored, expected)) in [
        (json!({"agent": {"developer": {"allowAllActions": true}}}), true),
        (json!({"agent": {"developer": {"allowAllActions": "true"}}}), false),
        (json!({"agent": {"developer": {"allowAllActions": false}}}), false),
        (json!({"agent": {"developer": {}}}), false),
        (json!({"agent": {}}), false),
    ]
    .into_iter()
    .enumerate()
    {
        let path = dir.path().join(format!("config-{index}.json"));
        write_file(&path, &serde_json::to_vec(&stored).unwrap()).await;
        let lanes = ConfigLanes { read: tokens.interactive_io, write: tokens.durability_io };
        let (config, _) = Config::open(path, Arc::new(MockStatePublisher::default()), lanes).await.unwrap();
        assert_eq!(ConfigAllowAll(config).allow_all_actions(), expected, "{stored}");
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn the_skill_listing_answers_from_the_catalog() {
    use mixdog_mcp::skill_catalog::SkillSettings;
    use mixdog_mcp::skill_catalog::SkillSettingsSource;
    use mixdog_mcp::skills::SkillRoot;
    use mixdog_mcp::skills::SkillSource;
    use mixdog_mcp::skills_watch::SkillsWatch;

    struct NoSettings;
    impl SkillSettingsSource for NoSettings {
        fn current(&self) -> SkillSettings {
            SkillSettings::default()
        }
    }

    let tokens = mixdog_rt::testing::tokens();
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().join("skills");
    write_file(&root.join("alpha").join("SKILL.md"), b"---\nname: alpha\ndescription: Use when alpha.\n---\n\nbody\n").await;
    let skill_root = SkillRoot { dir: root, source: SkillSource::Global, plugin: None };
    let catalog = SkillCatalog::new(
        dir.path().to_path_buf(),
        tokens.maintenance_io,
        Arc::new(move |_lane| vec![skill_root.clone()]),
        Arc::new(NoSettings),
        &SkillsWatch::new(),
    );
    let listed = CatalogSkillsListed(Arc::clone(&catalog));
    // A cold start collects before it answers.
    assert_eq!(listed.any_for(dir.path()).await, Ok(true));
    // A skill added since, after invalidation, is listed on the very next read.
    remove_dir_all(&dir.path().join("skills").join("alpha")).await;
    catalog.invalidate();
    assert_eq!(listed.any_for(dir.path()).await, Ok(false));
    write_file(&dir.path().join("skills").join("beta").join("SKILL.md"), b"---\nname: beta\ndescription: Use when beta.\n---\n\nbody\n").await;
    catalog.invalidate();
    assert_eq!(listed.any_for(dir.path()).await, Ok(true));
}

#[tokio::test(flavor = "multi_thread")]
async fn the_post_tool_dispatch_asks_the_bus_with_the_sessions_common_fields() {
    let tokens = mixdog_rt::testing::tokens();
    let dir = tempfile::tempdir().unwrap();
    let bus = HookBus::new(dir.path().to_path_buf(), tokens.maintenance_io, Arc::new(MockProcessManager::default()), None, None, None);
    let asked = Arc::new(AtomicUsize::new(0));
    let counter = Arc::clone(&asked);
    let dispatch = BusPostToolDispatch::new(
        bus,
        Arc::new(move |session: &str| {
            assert_eq!(session, "s1");
            counter.fetch_add(1, Ordering::SeqCst);
            HookCommon::default()
        }),
    );
    let event = PostToolEvent { name: "edit".to_owned(), args: json!({"file_path": "a"}), cwd: dir.path().to_string_lossy().into_owned(), session_id: "s1".to_owned(), result: "ok".to_owned() };
    // No hooks are configured: nothing replaces the result and nothing blocks.
    assert_eq!(dispatch.post_tool(&event).await, None);
    dispatch.post_failure(&event).await;
    let decision = dispatch.post_batch("s1", &event.cwd, 2).await.expect("a batch with calls is dispatched");
    assert!(!decision.blocked);
    assert!(dispatch.post_batch("s1", &event.cwd, 0).await.is_none());
    // Every dispatch reads the session's common fields first (an empty batch included).
    assert_eq!(asked.load(Ordering::SeqCst), 4);
}
