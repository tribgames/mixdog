//! The policy-backed `ToolGate` against the pipeline it wraps: the answers the loop sees
//! (allow, rewrite, deny), the approval wait stages, the user-wait mark on a "no", and the
//! not-saved notice. The pipeline's own rules are tested in `mixdog-tools` (`policy`).

use std::sync::Arc;
use std::sync::Mutex;

use async_trait::async_trait;
use mixdog_agent::env::ALLOW_NOT_SAVED_NOTICE;
use mixdog_agent::env::GateCall;
use mixdog_agent::env::GateDecision;
use mixdog_agent::env::GateSession;
use mixdog_agent::env::PolicyGate;
use mixdog_agent::env::PolicyGateParts;
use mixdog_agent::env::Retracted;
use mixdog_agent::env::RunEvent;
use mixdog_agent::env::RunObserver;
use mixdog_agent::env::Stage;
use mixdog_agent::env::TextRetraction;
use mixdog_agent::env::ToolGate;
use mixdog_agent::env::TurnGuards;
use mixdog_core_api::domain::mock::MockApprovalGate;
use mixdog_protocol::ApprovalRemember;
use mixdog_protocol::ApprovalResolution;
use mixdog_protocol::ConnectionKind;
use mixdog_protocol::ThreadId;
use mixdog_protocol::ToolApprovalDecision;
use mixdog_tools::policy::ConnectorPermissions;
use mixdog_tools::policy::HookAction;
use mixdog_tools::policy::HookCall;
use mixdog_tools::policy::HookDecision;
use mixdog_tools::policy::HookFailure;
use mixdog_tools::policy::MemoryGrantStore;
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

#[derive(Default)]
struct Events(Mutex<Vec<RunEvent>>);

impl RunObserver for Events {
    fn event(&self, event: RunEvent) {
        self.0.lock().expect("events").push(event);
    }
    fn can_retract(&self) -> bool {
        false
    }
    fn retract_text(&self, _retraction: TextRetraction) -> Retracted {
        Retracted::Refused
    }
}

#[derive(Default)]
struct Guards(Mutex<u32>);

#[async_trait]
impl TurnGuards for Guards {
    fn note_progress(&self) {}
    fn note_user_wait(&self) {
        *self.0.lock().expect("waits") += 1;
    }
    async fn stale_reminder(&self, _: &[mixdog_core_api::domain::provider::ToolCall], _: &[mixdog_agent::message::AgentMessage]) -> Option<String> {
        None
    }
    async fn completion_reminder(&self, _turn_limited: bool) -> Option<String> {
        None
    }
}

#[derive(Default)]
struct Connectors {
    needs: Vec<String>,
    disabled: Vec<String>,
    save_works: bool,
}

#[async_trait]
impl ConnectorPermissions for Connectors {
    fn needs_approval(&self, _agent: &str, tool: &str) -> bool {
        self.needs.iter().any(|n| n == tool)
    }
    fn disabled(&self, _agent: &str, tool: &str) -> bool {
        self.disabled.iter().any(|n| n == tool)
    }
    fn project_disabled(&self, _thread: &ThreadId, _tool: &str) -> bool {
        false
    }
    async fn allow_always(&self, _bot: &str, _tool: &str) -> bool {
        self.save_works
    }
}

struct NoTools;

impl ToolResolver for NoTools {
    fn resolve(&self, _name: &str) -> Option<Arc<dyn mixdog_core_api::domain::tool::Tool>> {
        None
    }
}

struct Session {
    surface: SessionSurface,
}

impl GateSession for Session {
    fn facts(&self) -> SessionFacts {
        SessionFacts {
            agent_id: "mailer".into(),
            acting_bot: Some("mailer".into()),
            contact_bot: Some("mailer".into()),
            connector_agent_id: "mailer".into(),
            run: None,
            life: Some("life".into()),
        }
    }
    fn surface(&self) -> SessionSurface {
        self.surface.clone()
    }
    fn settings(&self) -> PolicySettings {
        PolicySettings::default()
    }
    fn account(&self, _call: &GateCall) -> Option<String> {
        None
    }
}

struct RewriteHook;

#[async_trait]
impl PreToolHook for RewriteHook {
    async fn pre_tool(&self, call: &HookCall<'_>) -> Result<Option<HookDecision>, HookFailure> {
        Ok((call.name == "read").then(|| HookDecision {
            action: HookAction::Rewrite,
            reason: None,
            name: None,
            args: Some(json!({"path": "rewritten"})),
        }))
    }
}

struct Rig {
    gate: PolicyGate,
    approvals: Arc<MockApprovalGate>,
    events: Arc<Events>,
    guards: Arc<Guards>,
}

fn rig(connectors: Connectors, surface: SessionSurface, hook: bool) -> Rig {
    let connectors = Arc::new(connectors);
    let mut policy = ToolPolicy::new(Arc::new(MemoryGrantStore::default()), connectors.clone());
    if hook {
        policy = policy.with_hook(Arc::new(RewriteHook));
    }
    let approvals = Arc::new(MockApprovalGate::default());
    let events = Arc::new(Events::default());
    let guards = Arc::new(Guards::default());
    let gate = PolicyGate::new(PolicyGateParts {
        policy: Arc::new(policy),
        connectors,
        session: Arc::new(Session { surface }),
        tools: Arc::new(NoTools),
        grants: Arc::new(SessionGrants::default()),
        approvals: approvals.clone(),
        observer: events.clone(),
        guards: guards.clone(),
        thread_id: ThreadId::from("t1"),
        cwd: std::path::PathBuf::from("work"),
        cancel: CancellationToken::new(),
    });
    Rig { gate, approvals, events, guards }
}

fn decided(approved: bool, remember: Option<ApprovalRemember>) -> ApprovalResolution {
    ApprovalResolution::Decided {
        decision: ToolApprovalDecision {
            approved,
            reason: None,
            answers: None,
            reply: None,
            response: None,
            edited_args: None,
            remember,
            scope: None,
        },
        device: "Pixel".into(),
        connection_kind: ConnectionKind::Phone,
        at: 0,
    }
}

fn call(name: &str, args: Value) -> GateCall {
    GateCall::new(name, args)
}

fn waits(events: &Events) -> Vec<bool> {
    events
        .0
        .lock()
        .expect("events")
        .iter()
        .filter_map(|e| match e {
            RunEvent::Stage(Stage::ApprovalWait { waiting }) => Some(*waiting),
            _ => None,
        })
        .collect()
}

#[tokio::test]
async fn an_ordinary_call_is_allowed_and_a_hook_rewrite_is_passed_on() {
    let r = rig(Connectors::default(), SessionSurface::default(), true);
    assert_eq!(r.gate.check_call("c1", &call("grep", json!({"pattern": "x"}))).await, GateDecision::Allow);
    assert_eq!(
        r.gate.check_call("c2", &call("read", json!({"path": "a"}))).await,
        GateDecision::Rewrite(call("read", json!({"path": "rewritten"})))
    );
    assert!(waits(&r.events).is_empty());
}

#[tokio::test]
async fn the_session_surface_refuses_before_dedup_and_at_the_gate_with_the_same_text() {
    let surface = SessionSurface {
        disallowed: vec!["goal".into()],
        feature_denied: vec!["goal".into()],
        ..SessionSurface::default()
    };
    let r = rig(Connectors { disabled: vec!["mcp__a__b".into()], ..Connectors::default() }, surface, false);
    let text = "Error: tool \"goal\" is disabled in settings by the user. Do not retry unless the user turns it back on.";
    assert_eq!(r.gate.pre_dispatch_deny(&call("goal", json!({}))).as_deref(), Some(text));
    assert_eq!(r.gate.check_call("c", &call("goal", json!({}))).await, GateDecision::Deny(text.into()));
    // The connector switch is per called tool.
    let off = "Error: tool \"mcp__a__b\" is not available to this agent.";
    assert_eq!(r.gate.pre_dispatch_deny(&call("mcp__a__b", json!({}))).as_deref(), Some(off));
    assert_eq!(r.gate.pre_dispatch_deny(&call("mcp__a__c", json!({}))), None);
}

/// Node judges a routed `web_fetch` (sent to `local_fetch`) under its schema name `web_fetch`:
/// the allowlist, the denied tools and the connector switch all read the schema name.
#[tokio::test]
async fn a_routed_call_is_judged_under_its_schema_name() {
    let routed = |schema: Option<&str>| GateCall {
        name: "local_fetch".into(),
        args: json!({"url": "http://localhost/"}),
        schema_name: schema.map(str::to_owned),
    };
    let surface = SessionSurface { schema_allowed: Some(vec!["web_fetch".into()]), ..SessionSurface::default() };
    let r = rig(Connectors::default(), surface, false);
    assert_eq!(r.gate.pre_dispatch_deny(&routed(Some("web_fetch"))), None);
    assert_eq!(r.gate.check_call("c", &routed(Some("web_fetch"))).await, GateDecision::Allow);
    // Judged under its own transport name the call would be off the allowlist.
    let off = "Error: tool \"local_fetch\" is not available on this session's schema allowlist.";
    assert_eq!(r.gate.pre_dispatch_deny(&routed(None)).as_deref(), Some(off));
    assert_eq!(r.gate.check_call("c", &routed(None)).await, GateDecision::Deny(off.into()));

    let denied = SessionSurface { disallowed: vec!["web_fetch".into()], ..SessionSurface::default() };
    let r = rig(Connectors::default(), denied, false);
    assert_eq!(
        r.gate.pre_dispatch_deny(&routed(Some("web_fetch"))).as_deref(),
        Some("Error: tool \"local_fetch\" is not available in this session.")
    );
    assert_eq!(r.gate.pre_dispatch_deny(&routed(None)), None);

    let r = rig(Connectors { disabled: vec!["web_fetch".into()], ..Connectors::default() }, SessionSurface::default(), false);
    assert_eq!(
        r.gate.pre_dispatch_deny(&routed(Some("web_fetch"))).as_deref(),
        Some("Error: tool \"local_fetch\" is not available to this agent.")
    );
}

#[tokio::test]
async fn a_no_from_the_person_denies_waits_and_marks_the_turn_as_waiting_on_them() {
    let r = rig(
        Connectors { needs: vec!["mcp__notes__append".into()], ..Connectors::default() },
        SessionSurface::default(),
        false,
    );
    r.approvals.script.lock().expect("script").push_back(decided(false, None));
    let got = r.gate.check_call("c", &call("mcp__notes__append", json!({}))).await;
    let GateDecision::Deny(text) = got else { panic!("{got:?}") };
    assert!(text.starts_with("Error: tool \"mcp__notes__append\" was not approved: "), "{text}");
    assert_eq!(waits(&r.events), [true, false]);
    assert_eq!(*r.guards.0.lock().expect("waits"), 1);
}

#[tokio::test]
async fn an_approved_ask_runs_and_an_unsaved_always_allow_is_noticed() {
    let r = rig(
        Connectors { needs: vec!["mcp__notes__append".into()], save_works: false, ..Connectors::default() },
        SessionSurface::default(),
        false,
    );
    r.approvals.script.lock().expect("script").push_back(decided(true, Some(ApprovalRemember::Agent)));
    assert_eq!(r.gate.check_call("c", &call("mcp__notes__append", json!({}))).await, GateDecision::Allow);
    assert_eq!(waits(&r.events), [true, false]);
    assert_eq!(*r.guards.0.lock().expect("waits"), 0);
    assert!(r
        .events
        .0
        .lock()
        .expect("events")
        .contains(&RunEvent::Stage(Stage::Notice { message: ALLOW_NOT_SAVED_NOTICE.into() })));
}
