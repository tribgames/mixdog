//! What a hook-ask decision leaves on disk across a restart: the gate's grants and audit files live in the data folder, so a
//! daemon that starts again over the same folder finds the denial recorded and no grant made by it, and a remembered approval
//! still answering the next ask (the registry of "allow for this session" grants is the process's and starts empty).

use std::path::Path;
use std::sync::Arc;

use async_trait::async_trait;
use mixdog_core_api::domain::approval::ActionKind;
use mixdog_core_api::domain::mock::MockApprovalGate;
use mixdog_core_api::domain::tool::Tool;
use mixdog_core_api::domain::tool::ToolAnnotations;
use mixdog_core_api::domain::tool::ToolContext;
use mixdog_core_api::domain::tool::ToolOutcome;
use mixdog_core_api::domain::tool::ToolOutput;
use mixdog_core_api::domain::tool::ToolSpec;
use mixdog_core_api::ids::ThreadId;
use mixdog_protocol::ApprovalRemember;
use mixdog_protocol::ApprovalResolution;
use mixdog_protocol::ConnectionKind;
use mixdog_protocol::ToolApprovalDecision;
use mixdog_protocol::ToolCallId;
use mixdog_tools::policy::AuthorizeRequest;
use mixdog_tools::policy::ConnectorPermissions;
use mixdog_tools::policy::FileGrantStore;
use mixdog_tools::policy::HookAction;
use mixdog_tools::policy::HookCall;
use mixdog_tools::policy::HookDecision;
use mixdog_tools::policy::HookFailure;
use mixdog_tools::policy::PolicySettings;
use mixdog_tools::policy::PreToolHook;
use mixdog_tools::policy::SessionFacts;
use mixdog_tools::policy::SessionGrants;
use mixdog_tools::policy::SessionSurface;
use mixdog_tools::policy::ToolPolicy;
use mixdog_tools::policy::ToolResolver;
use serde_json::Value;
use serde_json::json;
use tokio_util::sync::CancellationToken;

struct Shell(ToolSpec);

#[async_trait]
impl Tool for Shell {
    fn spec(&self) -> &ToolSpec {
        &self.0
    }
    fn outbound_kind(&self, _args: &Value) -> Option<ActionKind> {
        None
    }
    async fn call(&self, _ctx: &ToolContext, _args: Value) -> ToolOutcome {
        Ok(ToolOutput::default())
    }
}

struct Tools(Arc<dyn Tool>);

impl Tools {
    fn new() -> Self {
        let spec = ToolSpec {
            name: "shell".into(),
            title: None,
            trigger: None,
            public: true,
            aliases: Vec::new(),
            description: String::new(),
            input_schema: json!({}),
            annotations: ToolAnnotations::default(),
            parallel_safe: true,
            exclusive_with: Vec::new(),
        };
        Self(Arc::new(Shell(spec)))
    }
}

impl ToolResolver for Tools {
    fn resolve(&self, _scope: Option<&str>, name: &str) -> Option<Arc<dyn Tool>> {
        (name == "shell").then(|| self.0.clone())
    }
}

struct Connectors;

#[async_trait]
impl ConnectorPermissions for Connectors {
    fn needs_approval(&self, _agent: &str, _tool: &str) -> bool {
        false
    }
    fn disabled(&self, _agent: &str, _tool: &str) -> bool {
        false
    }
    fn project_disabled(&self, _thread: &ThreadId, _tool: &str) -> bool {
        false
    }
    async fn allow_always(&self, _bot: &str, _tool: &str) -> bool {
        false
    }
}

/// The PreToolUse hook that asks about every call.
struct AskHook;

#[async_trait]
impl PreToolHook for AskHook {
    async fn pre_tool(&self, _call: &HookCall<'_>) -> Result<Option<HookDecision>, HookFailure> {
        Ok(Some(HookDecision { action: HookAction::Ask, reason: Some("shell needs a look".into()), ..HookDecision::default() }))
    }
}

fn answer(approved: bool, remember: Option<ApprovalRemember>) -> ApprovalResolution {
    ApprovalResolution::Decided {
        decision: ToolApprovalDecision { approved, reason: None, answers: None, reply: None, response: None, edited_args: None, remember, scope: None },
        device: "Pixel".into(),
        connection_kind: ConnectionKind::Phone,
        at: 0,
    }
}

/// One start of the daemon over `folder`: its grant store, its (empty) session grants and the card surface it shows.
struct Daemon {
    store: Arc<FileGrantStore>,
    cards: MockApprovalGate,
    session_grants: SessionGrants,
    tools: Tools,
    policy: ToolPolicy,
}

impl Daemon {
    fn start(folder: &Path) -> Self {
        let tokens = mixdog_rt::testing::tokens();
        let store = FileGrantStore::new(folder.join("human-gate"), tokens.interactive_io, tokens.durability_io);
        let policy = ToolPolicy::new(store.clone(), Arc::new(Connectors)).with_hook(Arc::new(AskHook));
        Self { store, cards: MockApprovalGate::default(), session_grants: SessionGrants::default(), tools: Tools::new(), policy }
    }

    fn answer_with(&self, resolution: ApprovalResolution) {
        self.cards.script.lock().unwrap().push_back(resolution);
    }

    fn cards_shown(&self) -> usize {
        self.cards.asks.lock().unwrap().len()
    }

    /// The Lead's `shell` call, as a turn runs it through the gate.
    async fn lead_runs_shell(&self) -> bool {
        let lead = SessionFacts { agent_id: "lead".into(), connector_agent_id: "lead".into(), life: Some("life".into()), ..SessionFacts::default() };
        self.policy
            .authorize(AuthorizeRequest {
                call_id: &ToolCallId::from("call"),
                thread_id: &ThreadId::from("sess_lead"),
                name: "shell",
                args: json!({ "command": "ls" }),
                cwd: Path::new("work"),
                facts: &lead,
                surface: &SessionSurface::default(),
                schema_name: None,
                settings: PolicySettings::default(),
                account: None,
                session_grants: &self.session_grants,
                tools: &self.tools,
                approvals: &self.cards,
                cancel: &CancellationToken::new(),
            })
            .await
            .is_ok()
    }

    async fn decisions(&self) -> Vec<String> {
        self.store.read_audit(None, 100).await.expect("the audit").into_iter().map(|row| row.decision).collect()
    }
}

/// A denied hook ask stops the call, makes no grant, and its audit row is on disk after a restart; the next ask over the same
/// folder is shown again.
#[tokio::test]
async fn a_denied_hook_ask_leaves_its_audit_row_and_no_grant_across_a_restart() {
    let folder = tempfile::tempdir().expect("data folder");
    {
        let before = Daemon::start(folder.path());
        before.answer_with(answer(false, Some(ApprovalRemember::Always)));
        assert!(!before.lead_runs_shell().await, "the denied call does not run");
        assert_eq!(before.cards_shown(), 1);
        assert!(before.store.list_grants(None).await.expect("grants").is_empty(), "a denial, whatever it asked to remember, grants nothing");
    }
    let after = Daemon::start(folder.path());
    assert!(after.store.list_grants(None).await.expect("grants").is_empty(), "no grant after the restart");
    assert_eq!(after.decisions().await, ["deny"], "the denial is in the audit the restart reads");
    after.answer_with(answer(true, None));
    assert!(after.lead_runs_shell().await);
    assert_eq!(after.cards_shown(), 1, "the call is asked again: nothing remembered the denial as an allow");
}

/// An approval remembered for always answers the next ask after a restart without a card; one given for this session only does
/// not (the registry of session grants is the process's).
#[tokio::test]
async fn an_always_approval_survives_a_restart_and_a_session_approval_does_not() {
    let folder = tempfile::tempdir().expect("data folder");
    {
        let before = Daemon::start(folder.path());
        before.answer_with(answer(true, Some(ApprovalRemember::Session)));
        assert!(before.lead_runs_shell().await);
        assert!(before.lead_runs_shell().await);
        assert_eq!(before.cards_shown(), 1, "the session grant answers the second ask");
    }
    let restarted = Daemon::start(folder.path());
    restarted.answer_with(answer(true, Some(ApprovalRemember::Always)));
    assert!(restarted.lead_runs_shell().await);
    assert_eq!(restarted.cards_shown(), 1, "the session grant did not outlive the process: the card is shown again");
    drop(restarted);

    let again = Daemon::start(folder.path());
    assert!(again.lead_runs_shell().await);
    assert_eq!(again.cards_shown(), 0, "the always grant is on disk and answers the ask");
    assert_eq!(again.store.list_grants(None).await.expect("grants").len(), 1);
}