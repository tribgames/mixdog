//! Replay of Node's K1 recordings `fixtures/hook-ask-grants-cases` and `fixtures/session-grants-cases`
//! (`record-hook-ask-grants-cases.mjs`, `record-session-grants-cases.mjs`, b6f10295a): one interpreter for the recorded logs.
//!
//! Each step drives the product's entry: a `decide` runs the call through [`ToolPolicy::authorize`] as a turn does (the recorded
//! PreToolUse hook, the session's facts and settings from [`SessionGate`], the tool's own `outbound_kind`, the session's grants in
//! the process registry [`SessionGrantRegistry`]) until it shows the client a card in the client's [`ApprovalBook`] or ends; the
//! verdict it acted on is read through the development-only `policy-observer`, and a call it let run is rendered from the call it
//! passed on. A `choose` or `answer` is a client's response to that card, sent as recorded (with the recorded gate) through
//! [`ApprovalBook::validate`] and resolved into the waiting pipeline, which audits it and stores its grant; a card no longer
//! pending is the call asked again. The grants, audit and permission views are [`FileGrantStore`] and [`AgentPermissions`]
//! on a real directory. Every wait has a deadline. The store's clock is the recording's held `Date.now`; a session grant has no clock (it has no time limit),
//! so a recorded advance does nothing. A card is what a client is shown for the
//! request ([`tool_approval`] of the approval book's request), compared on the fields `humanRequestFields` defines.
//!
//! A decision is the core's verdict written as Node's `{ decision, request, gate, remembered }`: the decision as the
//! hooks left it (an answered `ask` runs as `allow`, or `modify` when the hook rewrote the call), the request the card
//! presents and the audit identity its answer is recorded under.
//!
//! A recorded `answer` carries the gate Node's `recordHumanDecision(gate, approval)` was called with. Node's gate is the
//! server's, never a client's, and so is the core's ([`GateAudit`] of the pipeline's ask). Where the recorded gate is not the
//! one the decided call showed (forged by the recorder), the replay hands it to the pipeline in place of its own ask's
//! (development-only `policy-observer`: the audit identity and the scopes the card offers), re-asks the call and sends the
//! recorded approval through the client's book: the pipeline's own `record_decision` then answers under the forged gate.
//! The forged answers:
//!
//! | case (steps) | forged in the answer | Node's outcome | the replay's assertion |
//! |---|---|---|---|
//! | H6 (1, 2, 5, 6) | `gate.action` `"tool:mcp__stripe__create_payment"` / `"tool:mcp__drive__delete_permanently"` (the shown gate has none) and `gate.remember` `["once","session","always"]` (shown: none); answered `remember` `session`, then `always` | nothing honoured: the decides of steps 3, 7, 9 (after a stored `always` grant) and 11, 12 (Allow all actions) still ask with `["once"]`; no grants or audit step recorded | the forged gate reaches `record_decision` (the card offers its scopes); steps 3, 7, 9, 11, 12 compared whole in `hook_ask_6_…` |
//! | H8 (4) | `gate.remember` `["once","session","always"]` (shown: `["once"]`); answered `remember` `session` while the Lead session is a schedule run | no session grant: step 7 (after the run ends and the life resets) asks with `["once","session","always"]` | not exercisable: a granted run never shows a card (`ToolPolicy::ask`, run branch), so no client answer exists to carry the gate, in the core as in Node's product. `answer` asserts the response reaches no card (`Ok(None)`); step 7 compared whole in `hook_ask_8_…` |
//! | S5 (7) | `gate.remember` `["once","session"]` (shown: `["once","agent"]`); answered `remember` `session` while the home session is a schedule run | no session grant: step 9 (after the run ends) asks with `["once","session","agent"]` | not exercisable, for H8's reason; `answer` asserts no card was answered; step 9 compared whole in `session_5_…` |
//! | S6 (1, 2, 5, 6) | `gate.remember` `["once","session","agent"]` (shown: `["once"]`), then `undefined` (Node offers every scope, `gate.mjs:383`); answered `remember` `session`, then `agent`, for a payment and a permanent delete | no grant: `grants` at step 8 is `[]`; steps 3, 7, 10, 11 ask with `["once"]` | the forged gate reaches `record_decision`; step 8's grants and the decides compared whole in `session_6_…` |

#[cfg(node_twin)]
use std::collections::HashMap;
#[cfg(node_twin)]
use std::path::Path;
#[cfg(node_twin)]
use std::sync::Arc;
#[cfg(node_twin)]
use std::sync::Mutex;
#[cfg(node_twin)]
use std::sync::atomic::AtomicBool;
#[cfg(node_twin)]
use std::sync::atomic::AtomicU64;
#[cfg(node_twin)]
use std::sync::atomic::Ordering;
#[cfg(node_twin)]
use std::time::Duration;

#[cfg(node_twin)]
use async_trait::async_trait;
#[cfg(node_twin)]
use mixdog_agent::env::BoundAccount;
#[cfg(node_twin)]
use mixdog_agent::env::GateCall as SessionCall;
#[cfg(node_twin)]
use mixdog_agent::env::GateSession;
#[cfg(node_twin)]
use mixdog_core_agents::agents::AgentPermissions;
#[cfg(node_twin)]
use mixdog_core_api::domain::approval::ActionKind;
#[cfg(node_twin)]
use mixdog_core_api::domain::approval::ApprovalAsk;
#[cfg(node_twin)]
use mixdog_core_api::domain::approval::ApprovalGate;
#[cfg(node_twin)]
use mixdog_core_api::domain::approval::ApprovalId;
#[cfg(node_twin)]
use mixdog_core_api::domain::approval::ApprovalKind;
#[cfg(node_twin)]
use mixdog_core_api::domain::tool::Tool;
#[cfg(node_twin)]
use mixdog_core_api::domain::tool::ToolAnnotations;
#[cfg(node_twin)]
use mixdog_core_api::domain::tool::ToolContext;
#[cfg(node_twin)]
use mixdog_core_api::domain::tool::ToolOutcome;
#[cfg(node_twin)]
use mixdog_core_api::domain::tool::ToolOutput;
#[cfg(node_twin)]
use mixdog_core_api::domain::tool::ToolSpec;
#[cfg(node_twin)]
use mixdog_core_api::ids::ThreadId;
#[cfg(node_twin)]
use mixdog_core_api::ids::TurnId;
#[cfg(node_twin)]
use mixdog_core_base::approvals::ApprovalBook;
#[cfg(node_twin)]
use mixdog_core_base::approvals::DeviceInfo;
#[cfg(node_twin)]
use mixdog_core_base::approvals::Lineage;
#[cfg(node_twin)]
use mixdog_core_ports::ports::gate::GateEnv;
#[cfg(node_twin)]
use mixdog_core_ports::ports::gate::GateRun;
#[cfg(node_twin)]
use mixdog_core_ports::ports::gate::LiveHeader;
#[cfg(node_twin)]
use mixdog_core_ports::ports::gate::SessionGate;
#[cfg(node_twin)]
use mixdog_protocol::ApprovalRemember;
#[cfg(node_twin)]
use mixdog_protocol::ApprovalResolution;
#[cfg(node_twin)]
use mixdog_protocol::ConnectionKind;
#[cfg(node_twin)]
use mixdog_protocol::ToolCallId;
#[cfg(node_twin)]
use mixdog_scm::error::ScmFailure;
#[cfg(node_twin)]
use mixdog_scm::gh::client::GhClient;
#[cfg(node_twin)]
use mixdog_scm::gh::client::GhOutput;
#[cfg(node_twin)]
use mixdog_scm::gh::client::GhRunner;
#[cfg(node_twin)]
use mixdog_scm::gh::commands::GhCommand;
#[cfg(node_twin)]
use mixdog_scm::locks::RepoLocks;
#[cfg(node_twin)]
use mixdog_store::schema::record::Header;
#[cfg(node_twin)]
use mixdog_testkit::Exact;
#[cfg(node_twin)]
use mixdog_tools::policy::AuthorizeRequest;
#[cfg(node_twin)]
use mixdog_tools::policy::ConnectorPermissions;
#[cfg(node_twin)]
use mixdog_tools::policy::FileGrantStore;
#[cfg(node_twin)]
use mixdog_tools::policy::GrantKey;
#[cfg(node_twin)]
use mixdog_tools::policy::GrantStore as _;
#[cfg(node_twin)]
use mixdog_tools::policy::HookAction;
#[cfg(node_twin)]
use mixdog_tools::policy::HookCall;
#[cfg(node_twin)]
use mixdog_tools::policy::HookDecision;
#[cfg(node_twin)]
use mixdog_tools::policy::HookFailure;
#[cfg(node_twin)]
use mixdog_tools::policy::PermissionMode;
#[cfg(node_twin)]
use mixdog_tools::policy::PreToolHook;
#[cfg(node_twin)]
use mixdog_tools::policy::RunKind;
#[cfg(node_twin)]
use mixdog_tools::policy::SessionGrantRegistry;
#[cfg(node_twin)]
use mixdog_tools::policy::SessionGrants;
#[cfg(node_twin)]
use mixdog_tools::policy::SessionSurface;
#[cfg(node_twin)]
use mixdog_tools::policy::ToolPolicy;
#[cfg(node_twin)]
use mixdog_tools::policy::ToolResolver;
#[cfg(node_twin)]
use mixdog_core_api::domain::tool::ToolError;
#[cfg(node_twin)]
use mixdog_tools::policy::Authorized;
#[cfg(node_twin)]
use mixdog_tools::policy::gate::OUTBOUND_APPROVAL_REASON;
#[cfg(node_twin)]
use mixdog_tools::policy::offer::Card;
#[cfg(node_twin)]
use mixdog_tools::policy::gate::AskRequest;
#[cfg(node_twin)]
use mixdog_tools::policy::gate::GateAudit;
#[cfg(node_twin)]
use mixdog_tools::policy::gate::GateVerdict;
#[cfg(node_twin)]
use tokio::sync::mpsc;
#[cfg(node_twin)]
use tokio::sync::oneshot;
#[cfg(node_twin)]
use tokio::task::JoinHandle;
#[cfg(node_twin)]
use mixdog_tools::policy::run_policy::AUTOMATION_GRANT_REASON;
#[cfg(node_twin)]
use mixdog_tools::policy::grants::ANY_AGENT;
#[cfg(node_twin)]
use mixdog_tools::policy::grants::grant_id;
#[cfg(node_twin)]
use serde_json::Map;
#[cfg(node_twin)]
use serde_json::Value;
#[cfg(node_twin)]
use serde_json::json;
#[cfg(node_twin)]
use tokio::sync::watch;
#[cfg(node_twin)]
use tokio_util::sync::CancellationToken;

#[cfg(node_twin)]
use mixdog_core_session::session::room_approval::normalize_tool_approval_request;
#[cfg(node_twin)]
use mixdog_core_session::session::room_approval::tool_approval;

#[cfg(node_twin)]
/// The sessions the recorders name.
const LEAD: &str = "sess_lead_coding";
#[cfg(node_twin)]
const HOME: &str = "sess_home_mailer";
#[cfg(node_twin)]
/// The recorders' agent roster: `kind: bot` definitions.
const CONTACT_BOTS: [&str; 2] = ["mailer", "scribe"];

std::thread_local! {
    /// The case being replayed, for a failure the comparison does not report (a test's runtime is one thread).
    static CASE: std::cell::RefCell<String> = const { std::cell::RefCell::new(String::new()) };
}

#[cfg(node_twin)]
fn case_id() -> String {
    CASE.with(|case| case.borrow().clone())
}

#[cfg(node_twin)]
fn compare(actual: &Exact, expected: &Exact, case: &str) {
    if let Some(difference) = actual.difference(expected) {
        panic!("{case}: the core's outcome differs from Node's at {difference}");
    }
}

#[cfg(node_twin)]
fn remember_name(scope: ApprovalRemember) -> &'static str {
    match scope {
        ApprovalRemember::Once => "once",
        ApprovalRemember::Session => "session",
        ApprovalRemember::Agent => "agent",
        ApprovalRemember::Always => "always",
    }
}

#[cfg(node_twin)]
fn remember_of(name: &str) -> ApprovalRemember {
    match name {
        "once" => ApprovalRemember::Once,
        "session" => ApprovalRemember::Session,
        "agent" => ApprovalRemember::Agent,
        "always" => ApprovalRemember::Always,
        other => panic!("a remember scope, not {other}"),
    }
}

#[cfg(node_twin)]
fn key(text: &str) -> GrantKey {
    GrantKey::parse(text).unwrap_or_else(|| panic!("a grant key, not {text}"))
}

#[cfg(node_twin)]
/// The `gh` of the registered `github` tool: deciding a call never runs it.
struct NoGh;

#[cfg(node_twin)]
#[async_trait]
impl GhRunner for NoGh {
    async fn raw(&self, command: &GhCommand, _cwd: &Path, _cancel: &CancellationToken) -> Result<GhOutput, ScmFailure> {
        panic!("a decision ran gh: {:?}", command.args)
    }
}

#[cfg(node_twin)]
/// A connector tool as the MCP catalog would hold it, its outbound kind by the connector rule.
struct ConnectorTool(ToolSpec);

#[cfg(node_twin)]
#[async_trait]
impl Tool for ConnectorTool {
    fn spec(&self) -> &ToolSpec {
        &self.0
    }

    fn outbound_kind(&self, args: &Value) -> Option<ActionKind> {
        let mut parts = self.0.name.splitn(3, "__");
        let (_, server, tool) = (parts.next(), parts.next().unwrap_or_default(), parts.next().unwrap_or_default());
        mixdog_mcp::outbound::outbound_kind(None, server, tool, args, mixdog_mcp::outbound::Hints::default())
    }

    async fn call(&self, _ctx: &ToolContext, _args: Value) -> ToolOutcome {
        Ok(ToolOutput::default())
    }
}

#[cfg(node_twin)]
struct Tools {
    github: Arc<dyn Tool>,
}

#[cfg(node_twin)]
impl Tools {
    #[cfg(node_twin)]
    fn new() -> Self {
        let client = Arc::new(GhClient::new(Arc::new(NoGh), RepoLocks::new()));
        Self { github: Arc::new(mixdog_tools::github::GithubTool::new(client, None)) }
    }
}

#[cfg(node_twin)]
impl ToolResolver for Tools {
    fn resolve(&self, _scope: Option<&str>, name: &str) -> Option<Arc<dyn Tool>> {
        if name == "github" {
            return Some(self.github.clone());
        }
        name.starts_with("mcp__").then(|| {
            Arc::new(ConnectorTool(ToolSpec {
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
            })) as Arc<dyn Tool>
        })
    }
}

#[cfg(node_twin)]
/// No connector of the roster is set to ask, disabled or switched off.
struct Connectors;

#[cfg(node_twin)]
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

#[cfg(node_twin)]
/// The PreToolUse decision of the call being answered: the recorded hook.
#[derive(Default)]
struct Hook(Mutex<Option<HookDecision>>);

#[cfg(node_twin)]
#[async_trait]
impl PreToolHook for Hook {
    async fn pre_tool(&self, _call: &HookCall<'_>) -> Result<Option<HookDecision>, HookFailure> {
        Ok(self.0.lock().unwrap().clone())
    }
}

#[cfg(node_twin)]
fn hook_of(hook: &Value) -> Option<HookDecision> {
    let action = match hook.get("action")?.as_str()? {
        "ask" => HookAction::Ask,
        "deny" | "block" => HookAction::Deny,
        "modify" | "rewrite" => HookAction::Rewrite,
        _ => HookAction::Allow,
    };
    Some(HookDecision {
        action,
        reason: hook.get("reason").and_then(Value::as_str).map(str::to_owned),
        name: hook.get("name").and_then(Value::as_str).map(str::to_owned),
        args: hook.get("args").cloned(),
    })
}

#[cfg(node_twin)]
/// Every wait of the replay ends here at the latest.
const DEADLINE: Duration = Duration::from_secs(30);

#[cfg(node_twin)]
/// The client side of the session's approvals, as the app server holds it: the approval book a card is inserted into with its
/// run waiting on it, and a client's response is validated in. Each card is told to the replay as it is shown.
struct Client {
    book: Mutex<ApprovalBook>,
    ids: AtomicU64,
    /// The session the next card is asked in: one call runs at a time.
    thread: Mutex<ThreadId>,
    cards: mpsc::UnboundedSender<(ApprovalId, ApprovalAsk)>,
    now_ms: i64,
}

#[cfg(node_twin)]
#[async_trait]
impl ApprovalGate for Client {
    async fn request(&self, ask: ApprovalAsk) -> ApprovalResolution {
        let aid = ApprovalId(self.ids.fetch_add(1, Ordering::SeqCst) + 1);
        let thread = self.thread.lock().unwrap().clone();
        let (waiter, resolution) = oneshot::channel();
        let request = ApprovalBook::request(aid, &thread, &Lineage::top_level(&thread), ask.clone(), self.now_ms);
        self.book.lock().unwrap().insert(request, TurnId::from("r"), Some(waiter));
        let _ = self.cards.send((aid, ask));
        resolution.await.unwrap_or(ApprovalResolution::Interrupted { at: self.now_ms })
    }
}

#[cfg(node_twin)]
/// How the pipeline's run of a call went on: it showed a card and waits for its answer, or it ended.
enum Started {
    Card(ApprovalId, ApprovalAsk, JoinHandle<Result<Authorized, ToolError>>),
    Ended(Result<Authorized, ToolError>),
}

#[cfg(node_twin)]
/// A shown card and the call waiting on it.
struct Waiting {
    aid: ApprovalId,
    run: JoinHandle<Result<Authorized, ToolError>>,
}

#[cfg(node_twin)]
/// A client's response to `ask` through the approval book: the resolution the waiting run receives.
fn validate(ask: ApprovalAsk, result: &Value, device: &str, now_ms: i64) -> ApprovalResolution {
    let thread = ThreadId::from("t");
    let aid = ApprovalId(1);
    let mut book = ApprovalBook::default();
    book.insert(ApprovalBook::request(aid, &thread, &Lineage::top_level(&thread), ask, now_ms), TurnId::from("r"), None);
    book.validate(&aid.request_id(), result, DeviceInfo { device: device.to_owned(), kind: ConnectionKind::Desktop }, now_ms, mixdog_protocol::Origin::Local)
        .expect("the response decodes")
        .expect("the request is pending")
        .resolution
}

#[cfg(node_twin)]
/// The decision a client's `result` becomes, written as Node's response object.
fn normalized(ask: &ApprovalAsk, result: Value, now_ms: i64) -> Value {
    match validate(ask.clone(), &result, "", now_ms) {
        ApprovalResolution::Decided { decision, .. } => serde_json::to_value(decision).expect("a decision serializes"),
        other => panic!("decided, not {other:?}"),
    }
}

#[cfg(node_twin)]
/// The card a client is shown for `ask`.
fn card(ask: &ApprovalAsk, now_ms: i64) -> Map<String, Value> {
    let thread = ThreadId::from("t");
    let request = ApprovalBook::request(ApprovalId(1), &thread, &Lineage::top_level(&thread), ask.clone(), now_ms);
    tool_approval(&request).as_object().expect("a card").clone()
}

#[cfg(node_twin)]
/// The card's `humanRequestFields`, with its `kind` when `presented`.
fn fields(card: &Map<String, Value>, presented: bool) -> Value {
    let mut names = vec!["account", "remember", "agentId", "grantAction", "outbound", "secret"];
    if card.contains_key("secret") {
        names.push("args");
    }
    names.extend(["takeover", "permission", "connector"]);
    let mut out = Map::new();
    if presented {
        out.insert("kind".into(), card["kind"].clone());
    }
    for name in names {
        if let Some(value) = card.get(name) {
            out.insert(name.into(), value.clone());
        }
    }
    Value::Object(out)
}

#[cfg(node_twin)]
struct Live(Mutex<Arc<Header>>);

#[cfg(node_twin)]
impl LiveHeader for Live {
    fn header(&self) -> Arc<Header> {
        self.0.lock().unwrap().clone()
    }
}

#[cfg(node_twin)]
impl Live {
    #[cfg(node_twin)]
    fn change(&self, edit: impl FnOnce(&mut Header)) {
        let mut header = self.0.lock().unwrap();
        let mut next = (**header).clone();
        edit(&mut next);
        *header = Arc::new(next);
    }
}

#[cfg(node_twin)]
#[derive(Default)]
struct Env {
    runs: Mutex<HashMap<String, GateRun>>,
    allow_all: AtomicBool,
}

#[cfg(node_twin)]
#[async_trait]
impl GateEnv for Env {
    async fn run_of(&self, thread: &ThreadId) -> Option<GateRun> {
        self.runs.lock().unwrap().get(thread.as_str()).cloned()
    }
    async fn is_contact_bot(&self, agent_id: &str) -> bool {
        CONTACT_BOTS.contains(&agent_id)
    }
    fn allow_all_actions(&self) -> bool {
        self.allow_all.load(Ordering::SeqCst)
    }
    async fn connector_account(&self, _: &ThreadId, _: &Header, _: &SessionCall) -> Result<Option<BoundAccount>, String> {
        Ok(None)
    }
}

#[cfg(node_twin)]
struct Session {
    live: Arc<Live>,
    gate: SessionGate,
    grants: SessionGrants,
    _surface: watch::Sender<Arc<SessionSurface>>,
}

#[cfg(node_twin)]
/// The call the last `decide` decided: what a `choose` or an `answer` answers.
#[derive(Clone)]
struct Pending {
    call: Value,
    session: String,
    hook: Value,
}

#[cfg(node_twin)]
/// The permission row of the tool an approval was given for (Node's recording called it the `comment` row); `null` when the
/// agent's table has none (nothing allows the tool for it).
fn github_row(rows: &Value) -> Value {
    rows.as_array().expect("rows").iter().find(|row| row["action"] == "tool:github").cloned().unwrap_or(Value::Null)
}

#[cfg(node_twin)]
/// The recorded step with every output the core computed in place of the recorded one.
fn with_outputs(step: &Exact, outputs: Vec<(&str, Value)>) -> Exact {
    let mut entries = step.entries().to_vec();
    for (name, value) in outputs {
        let slot = entries.iter_mut().find(|(key, _)| key == name).unwrap_or_else(|| panic!("the step has no {name}"));
        slot.1 = Exact::decode(&value).expect("the core's value decodes");
    }
    Exact::Object(entries)
}

#[cfg(node_twin)]
/// `{ ...base, [key]: value }`.
fn with(mut base: Map<String, Value>, key: &str, value: Value) -> Map<String, Value> {
    base.insert(key.into(), value);
    base
}

#[cfg(node_twin)]
/// The pipeline's judgement as Node's `{ decision, request, gate, remembered }`: the gate's verdict the pipeline acted on, and for
/// a call it let run, the call as the pipeline passed it on (`authorized`): an answered hook `ask` runs as `allow`, or as `modify`
/// with the name and arguments the pipeline runs when they are not the call's own. The hook's reason is the hook's.
///
/// Inputs that reach the result, each only where Node's `humanGateDecision`
/// (`src/runtime/agent/orchestrator/session/human-gate/gate.mjs`, b6f10295a) passes them through untouched:
/// - a run the hook did not ask about: the hook's decision as given (`:267` no outbound rule, `:341` a remembered grant);
///   the pipeline's `authorized` must be the call that decision describes ([`ran_as_decided`]);
/// - an answered or skipped hook ask: the hook's fields but `action`/`name`/`args`, which come from `authorized` (`:179`);
/// - a deny: the hook's fields with `action`/`reason` set (`:258`, `:328`);
/// - an approval card: the hook's decision as given (`:297`), or with the automation reason (`:297`); proved by the
///   answered call running as it describes (`World::answer`);
/// - an outbound card: the hook's fields, without `name`/`args` unless the hook rewrites or asks (`:365`); proved likewise.
///
/// The session id in the gate is the decided call's (`:299`, `:368`).
fn render(verdict: &GateVerdict, hook: &Value, session: &str, call: &Value, authorized: Option<&Authorized>) -> Value {
    let base = hook.as_object().cloned().unwrap_or_default();
    let asked = hook.get("action").and_then(Value::as_str) == Some("ask");
    let mut out = Map::new();
    match verdict {
        GateVerdict::Run { remembered } => {
            let decision = if asked {
                let authorized = authorized.expect("a call the gate let run ran through the pipeline");
                let mut decision = base;
                decision.shift_remove("name");
                decision.shift_remove("args");
                let renamed = call["name"].as_str() != Some(authorized.name.as_str());
                let reargued = call["args"] != authorized.args;
                decision.insert("action".into(), json!(if renamed || reargued { "modify" } else { "allow" }));
                if renamed {
                    decision.insert("name".into(), json!(authorized.name));
                }
                if reargued {
                    decision.insert("args".into(), authorized.args.clone());
                }
                Value::Object(decision)
            } else {
                ran_as_decided(authorized.expect("a call the gate let run ran through the pipeline"), hook, call);
                hook.clone()
            };
            out.insert("decision".into(), decision);
            out.insert("request".into(), Value::Null);
            out.insert("gate".into(), Value::Null);
            if *remembered {
                out.insert("remembered".into(), json!(true));
            }
        }
        GateVerdict::Deny { reason, .. } => {
            out.insert("decision".into(), Value::Object(with(with(base, "action", json!("deny")), "reason", json!(reason))));
            out.insert("request".into(), Value::Null);
            out.insert("gate".into(), Value::Null);
        }
        GateVerdict::Ask(plan) => {
            let decision = match &plan.request {
                AskRequest::Approval { .. } if plan.reason == AUTOMATION_GRANT_REASON => Value::Object(with(base, "reason", json!(plan.reason))),
                AskRequest::Approval { .. } => hook.clone(),
                AskRequest::Outbound { .. } => {
                    let mut base = base;
                    if !asked && !matches!(hook.get("action").and_then(Value::as_str), Some("modify" | "rewrite")) {
                        base.shift_remove("name");
                        base.shift_remove("args");
                    }
                    Value::Object(with(with(base, "action", json!("ask")), "reason", json!(plan.reason)))
                }
                AskRequest::Connector { .. } => unreachable!("the gate never asks a connector policy's question"),
            };
            out.insert("decision".into(), decision);
            out.insert("request".into(), request_of(&plan.request));
            out.insert("gate".into(), gate_of(&plan.audit, offered_of(&plan.request), session));
        }
    }
    Value::Object(out)
}

#[cfg(node_twin)]
/// The pipeline ran the call the hook's decision describes: the hook's `name`/`args` where it rewrites (`modify`, `rewrite`, or an
/// `ask` carrying them, gate.mjs:179), else the call's own. Fails naming the case.
fn ran_as_decided(ran: &Authorized, hook: &Value, call: &Value) {
    let rewrites = matches!(hook.get("action").and_then(Value::as_str), Some("modify" | "rewrite" | "ask"));
    let field = |key: &str| (if rewrites { hook.get(key).filter(|v| !v.is_null()).unwrap_or(&call[key]) } else { &call[key] }).clone();
    let (name, args) = (field("name"), field("args"));
    assert!(
        name.as_str() == Some(ran.name.as_str()) && args == ran.args,
        "{}: the pipeline ran {} {} where the hook's decision describes {name} {args}",
        case_id(),
        ran.name,
        ran.args
    );
}

#[cfg(node_twin)]
fn names(remember: &[ApprovalRemember]) -> Value {
    json!(remember.iter().map(|scope| remember_name(*scope)).collect::<Vec<_>>())
}

#[cfg(node_twin)]
fn request_of(request: &AskRequest) -> Value {
    match request {
        AskRequest::Approval { agent_id, remember, grant_action, .. } => {
            let mut out = json!({"kind": "approval", "agentId": agent_id, "remember": names(remember)});
            if let Some(action) = grant_action {
                out["grantAction"] = json!(action.render());
            }
            out
        }
        AskRequest::Outbound { agent_id, card, remember } => {
            json!({"kind": "outbound", "agentId": agent_id, "outbound": card.to_json(), "remember": names(remember)})
        }
        AskRequest::Connector { .. } => unreachable!("the gate never asks a connector policy's question"),
    }
}

#[cfg(node_twin)]
/// The scopes the request offers: Node's gate carried them as `gate.remember`.
fn offered_of(request: &AskRequest) -> &[ApprovalRemember] {
    match request {
        AskRequest::Approval { remember, .. } | AskRequest::Outbound { remember, .. } | AskRequest::Connector { remember, .. } => remember,
    }
}

#[cfg(node_twin)]
fn gate_of(audit: &GateAudit, remember: &[ApprovalRemember], session: &str) -> Value {
    if audit.card == Card::Outbound {
        return json!({
            "agentId": audit.agent_id, "kind": "outbound", "action": audit.action.as_ref().map(GrantKey::render), "tool": audit.tool,
            "target": audit.target, "sessionId": session, "remember": names(remember),
        });
    }
    let mut out = json!({"agentId": audit.agent_id, "kind": audit.card.kind(), "tool": audit.tool, "target": audit.target});
    if let Some(action) = &audit.action {
        out["action"] = json!(action.render());
        out["sessionId"] = json!(session);
        out["remember"] = names(remember);
    }
    out
}

#[cfg(node_twin)]
fn obj(entries: Vec<(&str, Exact)>) -> Exact {
    Exact::Object(entries.into_iter().map(|(key, value)| (key.to_owned(), value)).collect())
}

#[cfg(node_twin)]
fn ex(value: Value) -> Exact {
    Exact::decode(&value).expect("the core's value decodes")
}

#[cfg(node_twin)]
const HOOK_ASK: &str = "hook-ask-grants-cases";
#[cfg(node_twin)]
const SESSION: &str = "session-grants-cases";

#[cfg(node_twin)]
#[test]
#[should_panic(expected = "hook-ask-grants case 3: the pipeline ran shell {\"command\":\"rm -rf /\"}")]
fn a_run_the_hook_did_not_ask_about_fails_naming_the_case_when_the_pipeline_ran_another_call() {
    CASE.with(|case| *case.borrow_mut() = "hook-ask-grants case 3".to_owned());
    let ran = Authorized { name: "shell".into(), args: json!({"command": "rm -rf /"}), allow_not_saved: false };
    render(&GateVerdict::Run { remembered: false }, &json!({"action": "allow"}), LEAD, &json!({"name": "shell", "args": {"command": "ls"}}), Some(&ran));
}

#[cfg(node_twin)]
/// `future`'s output, or a failure naming what did not happen within [`DEADLINE`].
async fn within<T>(what: &str, future: impl std::future::Future<Output = T>) -> T {
    tokio::time::timeout(DEADLINE, future).await.unwrap_or_else(|_| panic!("{what}: nothing within {DEADLINE:?}"))
}


#[cfg(node_twin)]
fn golden(set: &str) -> Exact {
    Exact::load(Path::new(env!("CARGO_MANIFEST_DIR")).join("../../fixtures").join(set).join("golden.json"))
}
#[cfg(node_twin)]
fn recorded(set: &str, index: usize, name: &str) -> (Exact, i64) {
    CASE.with(|case| *case.borrow_mut() = format!("{set} case {index}"));
    let golden = golden(set);
    let case = &golden.get("cases").as_array()[index];
    assert_eq!(case.get("case").as_str(), name, "case {index} of {set}");
    let now = golden.get("clock").get("dateNow").as_f64() as i64;
    (diverged(set, index, case.get("observed"), now), now)
}

#[cfg(node_twin)]
/// Node 1.4.5 keyed an approval by the action category (`comment`, `email`); the product keys it by the tool approved, for every
/// account of its connector (the product owner's decision). What that changes in a recording, and only that, is set here to what
/// the tool-keyed decision gives; everything else the recording says is still compared. Each edit names the value Node recorded
/// and fails when the recording holds anything else, so an edit can never hide another difference.
///
/// | what the recording has | the core |
/// |---|---|
/// | a card's `grantAction`, its gate's `action` for an approval: the category (`comment`, `email`) | `tool:<the tool>` |
/// | a stored grant: the category as `action`, the id hashed from it | the tool as `action`, the id hashed from it |
/// | a category allowed by a card's "always" answering every call of the category | only the tool approved is answered: `github` `pr.merge` is answered by the `github` approval (hook_ask_4) |
/// | a category allowed by `store.grant` (fed to the core as recorded) answering the category's calls | a category allow stores and answers nothing (the upgrade rule for 1.4.5's category allows): the next call of that category is asked. hook_ask_10 harness2 step 2 and session_5 step 5 are asked (session_5's in a schedule run, so its run policy answers it and nothing else in the log changes); hook_ask_11's mailer has no own `github` row (step 8 shows the every-agent one), so its "ask" at step 9 removes the every-agent allow its mode came from, leaves no `github` row, and step 10 is asked |
/// | the permission table: the category rows `allow`ed, `rememberable` | category rows are never allowed (`ask`, not `rememberable`), the tools allowed follow as rows |
/// | an agent's own allow of `tool:shell` stored nothing (hook_ask_12) | a tool may be allowed for one agent from its card ("Allow for this agent"); the grant is listed under that agent and answers nobody else (the recorded `modeFor` of another agent stays `ask`, also after that row is hand-edited to name the other agent) |
/// | a hook's `ask` on a bot's outbound call offered once / this session / always (hook_ask_10) | the outbound card offers what an outbound card offers, once / this conversation / this agent: the chosen "always" is answered once and stores nothing, so the calls it answered (steps 3, 4, 5) are asked |
/// | a session grant ended 12 h after it was given (hook_ask_3 step 15, session_2 steps 5 and 6) | a session grant has no time limit: the call is answered by it as before the limit |
/// | the outbound reason "This sends or posts outside Mixdog; …" | the app never names itself: [`OUTBOUND_APPROVAL_REASON`], in every decision that carries it |
/// | an approval request covering no tool and a permission request listed "this agent" (session_10) | a row offers only what its writer can store ([`mixdog_tools::policy::offer::offered_scopes`]): once; the connector policy's own ask is marked as such and offers "this agent" |
type Edit = (String, Box<dyn Fn(&Value) -> Value>);

#[cfg(node_twin)]
/// An edit: Node recorded `node` here, the core gives `core`.
fn becomes(path: impl Into<String>, node: Value, core: Value) -> Edit {
    let path = path.into();
    let at = path.clone();
    (path, Box::new(move |recorded: &Value| {
        assert_eq!(recorded, &node, "{}: Node recorded something else at {at}", case_id());
        core.clone()
    }))
}

#[cfg(node_twin)]
/// The card and gate of the approval decided at `log[step]`: the key it covers is the tool `tool`, not the category `node`.
fn tool_keyed_approval(step: usize, node: &str, tool: &str) -> Vec<Edit> {
    let key = format!("tool:{tool}");
    vec![
        becomes(format!("/log/{step}/result/request/grantAction"), json!(node), json!(key)),
        becomes(format!("/log/{step}/result/gate/action"), json!(node), json!(key)),
    ]
}

#[cfg(node_twin)]
/// The grant row at `path` (`.../grants/0`) as stored for `tool`: its action and the id hashed from it.
fn tool_keyed_grant(path: &str, node_id: &str, kind: &str, agent: &str, tool: &str) -> Vec<Edit> {
    let key = GrantKey::tool(tool).expect("a tool key");
    vec![
        becomes(format!("{path}/id"), json!(node_id), json!(grant_id(agent, &key))),
        becomes(format!("{path}/action"), json!(kind), json!(key.render())),
    ]
}

#[cfg(node_twin)]
/// A recorded permission table as the core lists it: the allowed `comment` category is not allowed and no category but a
/// browser action is `rememberable`; the tools allowed follow.
fn category_free_table(tools: Vec<Value>) -> Box<dyn Fn(&Value) -> Value> {
    Box::new(move |recorded: &Value| {
        let mut rows = Vec::new();
        for row in recorded.as_array().expect("rows") {
            let action = row["action"].as_str().expect("an action");
            let browser = action.starts_with("browser_");
            let row = match action {
                "comment" => {
                    assert_eq!(row, &json!({"action": "comment", "mode": "allow", "rememberable": true, "shared": true}), "{}", case_id());
                    json!({"action": "comment", "mode": "ask", "rememberable": false})
                }
                "review" | "message" | "email" | "publish" | "form" | "trash" => {
                    assert_eq!(row, &json!({"action": action, "mode": "ask", "rememberable": true}), "{}", case_id());
                    json!({"action": action, "mode": "ask", "rememberable": false})
                }
                _ => {
                    assert!(browser || action == "payment" || action == "delete" || action.starts_with("tool:"), "{}: {action}", case_id());
                    row.clone()
                }
            };
            rows.push(row);
        }
        rows.extend(tools.iter().cloned());
        Value::Array(rows)
    })
}

#[cfg(node_twin)]
/// Node's outbound reason; the core's is [`OUTBOUND_APPROVAL_REASON`].
const NODE_OUTBOUND_REASON: &str = "This sends or posts outside Mixdog; it needs your approval.";

#[cfg(node_twin)]
/// The decided result Node recorded after the hook let the call run.
fn allowed(remembered: bool) -> Value {
    let mut out = json!({"decision": {"action": "allow"}, "request": null, "gate": null});
    if remembered {
        out["remembered"] = json!(true);
    }
    out
}

#[cfg(node_twin)]
/// The recorded `mcp__gmail__send_email` card (`to: a@b.c`, `subject: s`, `body: hi`) of `agent` in `session`, under `reason`.
fn send_card(agent: &str, session: &str, reason: &str, remember: Value) -> Value {
    json!({
        "decision": {"action": "ask", "reason": reason},
        "request": {
            "kind": "outbound", "agentId": agent,
            "outbound": {"category": "email", "target": "a@b.c", "account": "gmail", "payload": "hi", "editable": ["body", "subject"], "details": {"to": "a@b.c", "subject": "s"}},
            "remember": remember,
        },
        "gate": {"agentId": agent, "kind": "outbound", "action": "email", "tool": "mcp__gmail__send_email", "target": "a@b.c", "sessionId": session, "remember": remember},
    })
}

#[cfg(node_twin)]
/// A coding Lead's hook ask on `tool`, as recorded: once / this session / always, keyed by the tool.
fn lead_hook_ask(tool: &str) -> Value {
    let scopes = json!(["once", "session", "always"]);
    let key = format!("tool:{tool}");
    json!({
        "decision": {"action": "ask", "reason": "hook rule"},
        "request": {"kind": "approval", "agentId": "lead", "remember": scopes, "grantAction": key},
        "gate": {"agentId": "lead", "kind": "approval", "tool": tool, "target": "", "action": key, "sessionId": LEAD, "remember": scopes},
    })
}

#[cfg(node_twin)]
/// The scopes a recorded outbound card at `result` (`.../result`) offered for a hook's ask, and what the outbound card offers.
fn outbound_scopes(result: &str) -> Vec<Edit> {
    let node = json!(["once", "session", "always"]);
    let core = json!(["once", "session", "agent"]);
    vec![
        becomes(format!("{result}/request/remember"), node.clone(), core.clone()),
        becomes(format!("{result}/gate/remember"), node, core),
    ]
}

#[cfg(node_twin)]
/// Every decision of the log at `log` (`/log`, `/harness2/log`) carrying Node's outbound reason, reworded; none at or under
/// a path another edit replaces.
fn reworded_reasons(observed: &Exact, log: &str, replaced: &[String]) -> Vec<Edit> {
    let steps = log.split('/').filter(|part| !part.is_empty()).fold(observed, |node, part| node.get(part));
    let mut edits = Vec::new();
    for (step, recorded) in steps.as_array().iter().enumerate() {
        let reason = recorded.try_get("result").and_then(|result| result.try_get("decision")).and_then(|decision| decision.try_get("reason"));
        let path = format!("{log}/{step}/result/decision/reason");
        if matches!(reason, Some(Exact::String(text)) if text == NODE_OUTBOUND_REASON) && !replaced.iter().any(|edit| path.starts_with(edit.as_str())) {
            edits.push(becomes(path, json!(NODE_OUTBOUND_REASON), json!(OUTBOUND_APPROVAL_REASON)));
        }
    }
    edits
}

#[cfg(node_twin)]
fn divergences(set: &str, index: usize, observed: &Exact, now: i64) -> Vec<Edit> {
    let mut edits = case_divergences(set, index, now);
    let replaced: Vec<String> = edits.iter().map(|(path, _)| path.clone()).collect();
    for log in ["/log", "/harness2/log", "/harness3/log"] {
        let root = log.split('/').nth(1).expect("a key");
        if observed.try_get(root).is_some() {
            edits.extend(reworded_reasons(observed, log, &replaced));
        }
    }
    edits
}

#[cfg(node_twin)]
fn case_divergences(set: &str, index: usize, now: i64) -> Vec<Edit> {
    let github_shared = json!({"action": "tool:github", "mode": "allow", "rememberable": true, "shared": true});
    let once_session_agent = json!(["once", "session", "agent"]);
    match (set, index) {
        // The approval of `github` covers the tool, so its `pr.merge` is answered too.
        (HOOK_ASK, 4) => {
            let node_ask = json!({"decision": {"action": "ask", "reason": "hook rule"}, "request": {"kind": "approval", "agentId": "lead", "remember": ["once", "session", "always"], "grantAction": "tool:github"}, "gate": {"agentId": "lead", "kind": "approval", "tool": "github", "target": "", "action": "tool:github", "sessionId": LEAD, "remember": ["once", "session", "always"]}});
            let answered = json!({"decision": {"action": "allow", "reason": "hook rule"}, "request": null, "gate": null});
            let mut edits = tool_keyed_approval(7, "comment", "github");
            edits.push(becomes("/log/10/result", node_ask.clone(), answered.clone()));
            edits.push(becomes("/log/11/result", node_ask, answered));
            edits
        }
        (HOOK_ASK, 7) => {
            let mut edits = tool_keyed_approval(0, "comment", "github");
            edits.extend(tool_keyed_approval(6, "email", "mcp__gmail__send_email"));
            edits
        }
        // A session grant has no time limit: the call after Node's 12 h limit is answered by it, as at step 13.
        (HOOK_ASK, 3) => vec![becomes("/log/15/result", lead_hook_ask("shell"), json!({"decision": {"action": "allow", "reason": "hook rule"}, "request": null, "gate": null}))],
        // A hook's ask on a bot's send is put on the outbound card, which never offers "always": the "always" chosen is answered
        // once and stores nothing, so the calls it answered in Node are asked. harness2's `store.grant` of the `email` category
        // stores nothing, so its next call is asked too.
        (HOOK_ASK, 10) => {
            let hook_rule = "hook rule";
            let mut edits = outbound_scopes("/log/0/result");
            edits.push(becomes("/log/1/answered/remember", json!("always"), json!("once")));
            edits.push(becomes(
                "/log/2/grants",
                json!([{"id": "grant_e0502a5ecf33b648d69bebe6", "agentId": ANY_AGENT, "action": "email", "mode": "allow", "device": "", "at": now}]),
                json!([]),
            ));
            let answered = json!({"decision": {"action": "allow", "reason": hook_rule}, "request": null, "gate": null});
            edits.push(becomes("/log/3/result", answered.clone(), send_card("scribe", "sess_home_scribe", hook_rule, once_session_agent.clone())));
            edits.push(becomes("/log/4/result", answered.clone(), send_card("lead", "sess_home_lead", hook_rule, once_session_agent.clone())));
            edits.push(becomes("/log/5/result", answered, lead_hook_ask("mcp__gmail__send_email")));
            edits.extend(outbound_scopes("/harness2/log/1/result"));
            edits.push(becomes("/harness2/log/2/result", allowed(true), send_card("mailer", HOME, OUTBOUND_APPROVAL_REASON, once_session_agent.clone())));
            edits.extend(outbound_scopes("/harness3/log/0/result"));
            edits.extend(outbound_scopes("/harness3/log/3/result"));
            edits
        }
        (HOOK_ASK, 11) => {
            let mut edits = tool_keyed_approval(2, "comment", "github");
            edits.extend(tool_keyed_approval(14, "comment", "github"));
            for step in [4, 5, 6] {
                edits.push((format!("/log/{step}/rows"), category_free_table(vec![github_shared.clone()])));
            }
            // The recorded `store.grant` of `comment` for mailer stores nothing: mailer's `github` row is the every-agent allow,
            // and mailer's "ask" removes it (the allow its mode came from), so nothing answers step 10's call.
            edits.push(becomes("/log/8/row", json!({"action": "comment", "mode": "allow", "rememberable": true}), github_shared.clone()));
            edits.push(becomes("/log/9/row", json!({"action": "comment", "mode": "allow", "rememberable": true, "shared": true}), Value::Null));
            edits.push(becomes("/log/10/result", json!({"decision": {"action": "allow", "reason": "hook rule"}, "request": null, "gate": null}), lead_hook_ask("github")));
            edits
        }
        (HOOK_ASK, 12) => {
            let shell = GrantKey::tool("shell").expect("a tool key");
            vec![becomes(
                "/log/0/grants",
                json!([]),
                json!([{"id": grant_id("mailer", &shell), "agentId": "mailer", "action": "tool:shell", "mode": "allow", "device": "", "at": now}]),
            )]
        }
        (HOOK_ASK, 13) => {
            let mut edits = tool_keyed_approval(0, "comment", "github");
            edits.push(becomes("/grantActions/comment/grantAction", json!("comment"), json!("tool:github")));
            edits
        }
        (SESSION, 1) => {
            let mut edits = tool_keyed_grant("/log/2/grants/0", "grant_5daaacd28c7d911a9eed1b29", "email", "mailer", "mcp__gmail__send_email");
            edits.push(becomes("/grantAction", json!("email"), json!("tool:mcp__gmail__send_email")));
            edits
        }
        // A session grant has no time limit: the calls after Node's 12 h limit are answered by it, as at step 3.
        (SESSION, 2) => [5, 6]
            .into_iter()
            .map(|step| becomes(format!("/log/{step}/result"), send_card("mailer", HOME, NODE_OUTBOUND_REASON, once_session_agent.clone()), allowed(true)))
            .collect(),
        // The recorded `store.grant` of the `email` category stores nothing, so step 5's call in the schedule run is asked (and
        // answered by the run policy) as step 3's was, rather than answered by a remembered allow.
        (SESSION, 5) => vec![becomes("/log/5/result", allowed(true), send_card("mailer", HOME, OUTBOUND_APPROVAL_REASON, json!(["once", "agent"])))],
        // A request covering no tool and a permission request offer only once: nothing their answer carries can be stored.
        (SESSION, 10) => ["/approvalWithoutKindFields/remember", "/permissionFields/remember"]
            .into_iter()
            .map(|path| becomes(path, json!(["once", "agent"]), json!(["once"])))
            .collect(),
        _ => Vec::new(),
    }
}

#[cfg(node_twin)]
fn edit_at(node: &Exact, path: &[&str], edit: &dyn Fn(&Value) -> Value) -> Exact {
    let Some((head, rest)) = path.split_first() else { return ex(edit(&plain(node))) };
    match node {
        Exact::Object(entries) => {
            assert!(entries.iter().any(|(key, _)| key == head), "{}: the recording has no {head}", case_id());
            Exact::Object(entries.iter().map(|(key, item)| (key.clone(), if key == head { edit_at(item, rest, edit) } else { item.clone() })).collect())
        }
        Exact::Array(items) => {
            let at: usize = head.parse().unwrap_or_else(|_| panic!("{}: {head} is no index", case_id()));
            assert!(at < items.len(), "{}: the recording has no item {at}", case_id());
            Exact::Array(items.iter().enumerate().map(|(i, item)| if i == at { edit_at(item, rest, edit) } else { item.clone() }).collect())
        }
        other => panic!("{}: nothing at {head} in {other:?}", case_id()),
    }
}

#[cfg(node_twin)]
fn diverged(set: &str, index: usize, observed: &Exact, now: i64) -> Exact {
    divergences(set, index, observed, now).into_iter().fold(observed.clone(), |at, (path, edit)| {
        let parts: Vec<&str> = path.split('/').filter(|part| !part.is_empty()).collect();
        edit_at(&at, &parts, edit.as_ref())
    })
}
#[cfg(node_twin)]
/// A recorded input as the JavaScript value the recorder passed: an integer stays an integer, `undefined` is absent (null).
fn plain(value: &Exact) -> Value {
    match value {
        Exact::Undefined => Value::Null,
        Exact::Number(n) if n.fract() == 0.0 && n.abs() < 9_007_199_254_740_992.0 => json!(*n as i64),
        Exact::Array(items) => Value::Array(items.iter().map(plain).collect()),
        Exact::Object(entries) => Value::Object(entries.iter().map(|(key, item)| (key.clone(), plain(item))).collect()),
        other => other.to_plain().expect("a plain recorded value"),
    }
}
#[cfg(node_twin)]
/// A recorded gate an ask is made under: its audit identity (the call's category is filled in from the call) and the scopes
/// its card shows. What the answer may store is still the pipeline's rule ([`GateAudit::offered`]), never these scopes.
#[derive(Clone)]
struct Forged {
    audit: GateAudit,
    remember: Vec<ApprovalRemember>,
}

#[cfg(node_twin)]
/// One recorder harness: a store on its own directory, the process's session-grant registry, the sessions.
struct World {
    _dir: tempfile::TempDir,
    store: Arc<FileGrantStore>,
    registry: Arc<SessionGrantRegistry>,
    env: Arc<Env>,
    sessions: Mutex<HashMap<String, Arc<Session>>>,
    tools: Tools,
    hook: Arc<Hook>,
    policy: ToolPolicy,
    client: Arc<Client>,
    cards: tokio::sync::Mutex<mpsc::UnboundedReceiver<(ApprovalId, ApprovalAsk)>>,
    /// The gate's verdict of the call the pipeline judged last (`policy-observer`).
    verdict: Arc<Mutex<Option<GateVerdict>>>,
    /// A recorded gate the next ask is made under in place of the pipeline's own (`policy-observer`).
    forged: Arc<Mutex<Option<Forged>>>,
    /// The gate the last decided call showed, as rendered; none for a call the gate never judges.
    shown_gate: Mutex<Option<Value>>,
    pending: Mutex<Option<Pending>>,
    /// The card the client was shown last, while its call waits on it.
    waiting: Mutex<Option<Waiting>>,
    /// The card of every decided call that showed one, in log order.
    asks: Mutex<Vec<Option<ApprovalAsk>>>,
    lives: AtomicU64,
    now_ms: i64,
}
#[cfg(node_twin)]
impl World {
    fn new(now_ms: i64) -> Arc<Self> {
        let dir = tempfile::tempdir().expect("a data dir");
        let tokens = mixdog_rt::testing::tokens();
        let store = FileGrantStore::with_clock(dir.path().join("human-gate"), tokens.interactive_io, tokens.durability_io, Arc::new(move || now_ms));
        let registry = SessionGrantRegistry::new();
        let hook = Arc::new(Hook::default());
        let verdict = Arc::new(Mutex::new(None));
        let seen = verdict.clone();
        let forged = Arc::new(Mutex::new(None::<Forged>));
        let forging = forged.clone();
        let policy = ToolPolicy::new(store.clone(), Arc::new(Connectors)).with_hook(hook.clone()).with_observer(move |judged: &mut GateVerdict| {
            if let (Some(gate), GateVerdict::Ask(plan)) = (forging.lock().unwrap().clone(), &mut *judged) {
                match &mut plan.request {
                    AskRequest::Approval { remember, .. } | AskRequest::Outbound { remember, .. } | AskRequest::Connector { remember, .. } => {
                        *remember = gate.remember.clone();
                    }
                }
                // What the call is classified as is the call's, not the gate's: the pipeline's own.
                plan.audit = GateAudit { category: plan.audit.category, ..gate.audit };
            }
            *seen.lock().unwrap() = Some(judged.clone());
        });
        let (cards_tx, cards_rx) = mpsc::unbounded_channel();
        let client = Arc::new(Client { book: Mutex::default(), ids: AtomicU64::new(0), thread: Mutex::new(ThreadId::from(LEAD)), cards: cards_tx, now_ms });
        Arc::new(Self {
            _dir: dir,
            store,
            registry,
            env: Arc::new(Env::default()),
            sessions: Mutex::default(),
            tools: Tools::new(),
            hook,
            policy,
            client,
            cards: tokio::sync::Mutex::new(cards_rx),
            verdict,
            forged,
            shown_gate: Mutex::new(None),
            pending: Mutex::default(),
            waiting: Mutex::default(),
            asks: Mutex::default(),
            lives: AtomicU64::new(0),
            now_ms,
        })
    }

    #[cfg(node_twin)]
    /// The loaded session `id`: its header names the agent it was started for, its life the moment it was created.
    fn session(&self, id: &str) -> Arc<Session> {
        self.sessions
            .lock()
            .unwrap()
            .entry(id.to_owned())
            .or_insert_with(|| {
                let header = json!({"agent": "lead", "createdAt": 1}).as_object().unwrap().clone();
                let live = Arc::new(Live(Mutex::new(Arc::new(header))));
                let (surface, watched) = watch::channel(Arc::new(SessionSurface::default()));
                let gate = SessionGate::new(ThreadId::from(id), live.clone(), watched, self.env.clone());
                Arc::new(Session { live, gate, grants: SessionGrants::of(self.registry.clone(), id), _surface: surface })
            })
            .clone()
    }

    #[cfg(node_twin)]
    /// The product's pipeline for `call`, as a turn runs it: the session's facts and settings, the PreToolUse hook, the gate,
    /// the card in the client's approval book and the grant its answer stores.
    async fn authorize(&self, call: &Pending) -> Result<Authorized, ToolError> {
        let state = self.session(&call.session);
        let facts = within("the session's gate facts", state.gate.facts()).await;
        let thread = ThreadId::from(call.session.as_str());
        self.policy
            .authorize(AuthorizeRequest {
                call_id: &ToolCallId::from("call"),
                thread_id: &thread,
                name: call.call["name"].as_str().expect("a tool name"),
                args: call.call["args"].clone(),
                cwd: Path::new("C:\\work"),
                facts: &facts,
                surface: &SessionSurface::default(),
                schema_name: None,
                settings: state.gate.settings(),
                account: None,
                session_grants: &state.grants,
                tools: &self.tools,
                approvals: self.client.as_ref(),
                cancel: &CancellationToken::new(),
            })
            .await
    }

    #[cfg(node_twin)]
    /// Runs the pipeline for `call` until it shows the client a card or ends.
    async fn start(self: &Arc<Self>, call: &Pending) -> Started {
        *self.hook.0.lock().unwrap() = hook_of(&call.hook);
        *self.client.thread.lock().unwrap() = ThreadId::from(call.session.as_str());
        *self.verdict.lock().unwrap() = None;
        let world = self.clone();
        let running = call.clone();
        let mut run = tokio::spawn(async move { world.authorize(&running).await });
        let mut cards = within("the client's card channel", self.cards.lock()).await;
        let card = within("the pipeline to show a card or end", async {
            tokio::select! {
                card = cards.recv() => Ok(card.expect("the client channel stays open")),
                ended = &mut run => Err(ended.expect("the pipeline's task ran")),
            }
        })
        .await;
        match card {
            Ok((aid, ask)) => Started::Card(aid, ask, run),
            Err(ended) => Started::Ended(ended),
        }
    }

    #[cfg(node_twin)]
    /// The card the client was shown and has not answered is gone with its turn (`interrupted`): its call ends unrun.
    async fn abandon(&self) {
        let Some(Waiting { aid, run }) = self.waiting.lock().unwrap().take() else { return };
        self.client.book.lock().unwrap().resolved(aid, &ApprovalResolution::Interrupted { at: self.now_ms });
        let ended = within("the abandoned call to end", run).await.expect("the pipeline's task ran");
        assert!(ended.is_err(), "an unanswered card runs nothing: {ended:?}");
    }

    #[cfg(node_twin)]
    async fn decide(self: &Arc<Self>, call: &Value, session: &str, hook: &Value) -> Value {
        self.abandon().await;
        let pending = Pending { call: call.clone(), session: session.to_owned(), hook: hook.clone() };
        *self.pending.lock().unwrap() = Some(pending.clone());
        let started = self.start(&pending).await;
        let verdict = self.verdict.lock().unwrap().take();
        let rendered = match started {
            Started::Card(aid, ask, run) => {
                self.asks.lock().unwrap().push(Some(ask));
                *self.waiting.lock().unwrap() = Some(Waiting { aid, run });
                render(&verdict.expect("the gate judged the call it asks for"), hook, session, call, None)
            }
            Started::Ended(outcome) => match verdict {
                // `ask_user` and `handoff_user` never reach the gate (before-hook.mjs:159 in Node too): the call as the pipeline passed it.
                None => json!({"unjudged": outcome.map(|a| json!({"name": a.name, "args": a.args})).map_err(|e| e.message_for_model).unwrap_or_else(Value::String)}),
                Some(verdict) => {
                    match &verdict {
                        GateVerdict::Deny { .. } => assert!(outcome.is_err(), "the pipeline ran a call its gate denied: {outcome:?}"),
                        GateVerdict::Run { .. } => assert!(outcome.is_ok(), "the pipeline refused a call its gate let run: {outcome:?}"),
                        GateVerdict::Ask(_) => {}
                    }
                    render(&verdict, hook, session, call, outcome.as_ref().ok())
                }
            },
        };
        *self.shown_gate.lock().unwrap() = rendered.get("gate").cloned();
        rendered
    }

    #[cfg(node_twin)]
    /// A recorded answer under `gate`: when it is not the gate the decided call showed, the call is asked again with `gate` in
    /// place of the pipeline's own (its audit identity and the scopes the card offers) and the approval answers that card. A call
    /// the gate never judges (`ask_user`, `handoff_user`) has no gate of the pipeline's to replace.
    async fn answer_under(self: &Arc<Self>, gate: Value, approval: Value, device: String, timed_out: bool) {
        let shown = self.shown_gate.lock().unwrap().clone();
        if shown.is_none_or(|shown| shown == gate) {
            self.answer(approval, device, timed_out).await;
            return;
        }
        let session = self.pending.lock().unwrap().clone().expect("a decided call").session;
        assert_eq!(gate["sessionId"].as_str(), Some(session.as_str()), "{}: a forged gate of another session", case_id());
        let remember = match &gate["remember"] {
            // `!Array.isArray(gate.remember)`: every scope is offered (gate.mjs:383).
            Value::Array(scopes) => scopes.iter().map(|scope| remember_of(scope.as_str().expect("a scope"))).collect(),
            _ => vec![ApprovalRemember::Once, ApprovalRemember::Session, ApprovalRemember::Agent, ApprovalRemember::Always],
        };
        let action = gate["action"].as_str().and_then(GrantKey::parse);
        // An outbound gate names the action category; what its answer stores is the tool the call is for.
        let grant = match &action {
            Some(kind) if !kind.is_tool() && kind.rememberable() => {
                let pending = self.pending.lock().unwrap().clone().expect("a decided call");
                GrantKey::tool(pending.call["name"].as_str().expect("a tool name"))
            }
            other => other.clone(),
        };
        let forged = Forged {
            audit: GateAudit {
                agent_id: gate["agentId"].as_str().expect("an agent").to_owned(),
                card: if gate["kind"] == "outbound" { Card::Outbound } else { Card::HookAsk },
                grant,
                action,
                // Replaced by the call's own when it is asked (the observer).
                category: None,
                tool: gate["tool"].as_str().unwrap_or_default().to_owned(),
                target: gate["target"].as_str().unwrap_or_default().to_owned(),
            },
            remember,
        };
        self.abandon().await;
        *self.forged.lock().unwrap() = Some(forged);
        self.answer(approval, device, timed_out).await;
        *self.forged.lock().unwrap() = None;
    }

    #[cfg(node_twin)]
    /// A client's response to the card of the decided call, through the client's approval book: the card it was shown while its
    /// call waits, else the call asked again. A timed-out request is resolved as its deadline resolves it. The answered call's
    /// outcome is the pipeline's: it runs exactly when the answer approved it. Returns the decision the book accepted.
    async fn answer(self: &Arc<Self>, result: Value, device: String, timed_out: bool) -> Option<Value> {
        let waiting = self.waiting.lock().unwrap().take();
        let waiting = match waiting {
            Some(waiting) => Some(waiting),
            None => {
                let pending = self.pending.lock().unwrap().clone().expect("a decided call");
                match self.start(&pending).await {
                    Started::Card(aid, _, run) => Some(Waiting { aid, run }),
                    Started::Ended(_) => None,
                }
            }
        };
        let Some(Waiting { aid, run }) = waiting else {
            // No card is pending (an unattended run answered the call itself): the response reaches none.
            let last = ApprovalId(self.client.ids.load(Ordering::SeqCst));
            let accepted = self.client.book.lock().unwrap().validate(&last.request_id(), &result, DeviceInfo { device, kind: ConnectionKind::Desktop }, self.now_ms);
            assert!(matches!(accepted, Ok(None)), "a response to no pending card is a no-op: {accepted:?}");
            return None;
        };
        let resolution = if timed_out {
            ApprovalResolution::TimedOut { at: self.now_ms }
        } else {
            self.client
                .book
                .lock()
                .unwrap()
                .validate(&aid.request_id(), &result, DeviceInfo { device, kind: ConnectionKind::Desktop }, self.now_ms, mixdog_protocol::Origin::Local)
                .expect("the response decodes")
                .expect("the card is pending")
                .resolution
        };
        self.client.book.lock().unwrap().resolved(aid, &resolution);
        let outcome = within("the answered call to settle", run).await.expect("the pipeline's task ran");
        let ApprovalResolution::Decided { decision, .. } = resolution else {
            assert!(outcome.is_err(), "a timed-out card runs nothing: {outcome:?}");
            return None;
        };
        assert_eq!(outcome.is_ok(), decision.approved, "the answered call runs exactly when approved: {outcome:?}");
        if let Ok(ran) = &outcome {
            // What proves the decision `render` echoed for the card (the hook's own, gate.mjs:297/365): the approved call runs
            // as that decision describes it.
            let pending = self.pending.lock().unwrap().clone().expect("a decided call");
            ran_as_decided(ran, &pending.hook, &pending.call);
        }
        Some(serde_json::to_value(decision).expect("a decision serializes"))
    }

    fn ask(&self, index: usize) -> ApprovalAsk {
        self.asks.lock().unwrap()[index].clone().expect("the call showed a card")
    }

    #[cfg(node_twin)]
    async fn grants(&self, filter: &Value) -> Value {
        let rows = within("the store's grants", self.store.list_grants(filter.get("agentId").and_then(Value::as_str))).await.expect("the grants");
        Value::Array(
            rows.iter()
                .map(|g| json!({"id": g.id, "agentId": g.agent_id, "action": g.action.render(), "mode": g.mode.as_str(), "device": g.device, "at": g.at_ms}))
                .collect(),
        )
    }

    async fn audit(&self, filter: &Value) -> Value {
        let agent = filter.get("agentId").and_then(Value::as_str);
        let limit = filter.get("limit").and_then(Value::as_u64).unwrap_or(100) as usize;
        let rows = within("the store's audit", self.store.read_audit(agent, limit)).await.expect("the audit");
        Value::Array(
            rows.iter()
                .map(|r| {
                    json!({"at": r.at_ms, "agentId": r.agent_id, "kind": r.kind, "action": r.action, "tool": r.tool, "target": r.target, "decision": r.decision, "device": r.device})
                })
                .collect(),
        )
    }

    fn permissions(&self) -> AgentPermissions {
        AgentPermissions::new(self.store.clone())
    }

    /// `store.setMode`: an action that is no grant key (an unknown kind, a tool that is never remembered) sets nothing.
    async fn set_mode(&self, agent: &str, action: &str, mode: &str) {
        let mode = PermissionMode::parse(mode).expect("a mode");
        if let Some(action) = GrantKey::parse(action) {
            let _ = within("the store's setMode", self.store.set_mode(agent, &action, mode, "", false)).await.expect("the store");
        }
    }

    #[cfg(node_twin)]
    fn set_run(&self, session: &str, run: Option<&Value>) {
        let mut runs = self.env.runs.lock().unwrap();
        runs.clear();
        if let Some(run) = run {
            let kind = match run["kind"].as_str() {
                Some("webhook") => RunKind::Webhook,
                _ => RunKind::Schedule,
            };
            runs.insert(session.to_owned(), GateRun { kind, agent_id: run["agentId"].as_str().unwrap_or_default().to_owned() });
        }
    }

    #[cfg(node_twin)]
    /// One recorded step, done on the core; the step as the core gives it.
    async fn step(self: &Arc<Self>, step: &Exact) -> Exact {
        let input = |key: &str| plain(step.get(key));
        let action = step.get("do").as_str().to_owned();
        let out: Vec<(&str, Value)> = match action.as_str() {
            "decide" => vec![("result", self.decide(&input("call"), step.get("sessionId").as_str(), &input("hook")).await)],
            "choose" => {
                let result = json!({"approved": true, "response": "approve", "remember": step.get("remember").as_str()});
                vec![("answered", self.answer(result, String::new(), false).await.expect("the card was answered"))]
            }
            "answer" => {
                // The response as recorded, the gate the recorder answered under included: a client's response carries
                // whatever it carries, and the book takes from it only what a decision is.
                let mut approval = input("approval");
                let fields = approval.as_object_mut().expect("an approval");
                let timed_out = fields.remove("timedOut") == Some(Value::Bool(true));
                let device = fields.remove("device").and_then(|d| d.as_str().map(str::to_owned)).unwrap_or_default();
                let gate = input("gate");
                fields.insert("gate".into(), gate.clone());
                self.answer_under(gate, approval, device, timed_out).await;
                Vec::new()
            }
            "grants" => vec![("grants", self.grants(&input("filter")).await)],
            "audit" => vec![("rows", self.audit(&input("filter")).await)],
            // A session grant has no time limit: time passing changes nothing, so the step has nothing to do.
            "advance" => Vec::new(),
            "reset session life" => {
                let at = 100 + self.lives.fetch_add(1, Ordering::SeqCst);
                self.session(step.get("sessionId").as_str()).live.change(|header| {
                    header.insert("compaction".into(), json!({"lastClearAt": at}));
                });
                Vec::new()
            }
            "end session life (null)" => {
                self.session(step.get("sessionId").as_str()).live.change(|header| {
                    header.insert("closed".into(), json!(true));
                });
                Vec::new()
            }
            "store.grant" => {
                // As recorded: an action category (what Node allowed) stores nothing and answers no call, the upgrade rule for
                // 1.4.5's category allows; what that changes in a recording is declared in `divergences`.
                let scope = remember_of(step.get("scope").as_str());
                let action = key(step.get("action").as_str());
                within("the store's grant", self.store.grant(step.get("agentId").as_str(), &action, scope, "")).await.expect("the grant");
                Vec::new()
            }
            "store.setMode" => {
                self.set_mode(step.get("agentId").as_str(), step.get("action").as_str(), step.get("mode").as_str()).await;
                Vec::new()
            }
            "config agent.developer.allowAllActions = true" => {
                self.env.allow_all.store(true, Ordering::SeqCst);
                Vec::new()
            }
            "unattended port: the Lead session is a run" => {
                self.set_run(LEAD, Some(&input("run")));
                Vec::new()
            }
            "unattended port: the home session is a run" => {
                self.set_run(HOME, Some(&input("run")));
                Vec::new()
            }
            "unattended port: no run" => {
                self.set_run(LEAD, None);
                Vec::new()
            }
            "agentPermissions" => vec![("rows", within("the permission table", self.permissions().table(&input("agent"))).await.expect("the table"))],
            // The recording's `comment` allow is the approval of the `github` tool (see `divergences`).
            "mailer comment row" => {
                let rows = within("the permission table", self.permissions().table(&json!("mailer"))).await.expect("the table");
                vec![("row", github_row(&rows))]
            }
            "setAgentPermission mailer comment ask" => {
                let rows = within("setAgentPermission", self.permissions().set(&json!("mailer"), &json!("tool:github"), &json!("ask"), false)).await.expect("the table");
                vec![("row", github_row(&rows))]
            }
            "setAgentPermission scribe comment ask; mailer tool:shell ask" => {
                within("setAgentPermission", self.permissions().set(&json!("scribe"), &json!("tool:github"), &json!("ask"), false)).await.expect("the table");
                within("setAgentPermission", self.permissions().set(&json!("mailer"), &json!("tool:shell"), &json!("ask"), false)).await.expect("the table");
                Vec::new()
            }
            "setAgentPermission lead tool:shell ask noWiden" => {
                within("setAgentPermission", self.permissions().set(&json!("lead"), &json!("tool:shell"), &json!("ask"), true)).await.expect("the table");
                Vec::new()
            }
            "modeFor mailer comment" => {
                let mode = within("the store's modeFor", self.store.mode_for("mailer", &key("comment"), false)).await.expect("the mode");
                vec![("mode", json!(mode.as_str()))]
            }
            "revokeGrant (the one grant)" => {
                let grants = within("the store's grants", self.store.list_grants(Some("mailer"))).await.expect("the grants");
                vec![("revoked", json!(within("the store's revoke", self.store.revoke_grant(&grants[0].id)).await.expect("the revoke")))]
            }
            marker if marker.starts_with("scenario ") => Vec::new(),
            other => panic!("a step the replay does not know: {other}"),
        };
        with_outputs(step, out)
    }

    #[cfg(node_twin)]
    async fn run(self: &Arc<Self>, log: &Exact) -> Exact {
        let mut steps = Vec::new();
        for step in log.as_array() {
            steps.push(self.step(step).await);
        }
        self.abandon().await;
        Exact::Array(steps)
    }
}
#[cfg(node_twin)]
/// A case of plain logs: the observed object with its log replayed, every other recorded field computed by `extra`.
async fn replay_log(world: &Arc<World>, observed: &Exact) -> Exact {
    world.run(observed.get("log")).await
}
#[cfg(node_twin)]
async fn log_only(set: &str, index: usize, name: &str) {
    let (expected, now) = recorded(set, index, name);
    let world = World::new(now);
    compare(&obj(vec![("log", replay_log(&world, &expected).await)]), &expected, &format!("{set} case {index}"));
}
#[cfg(node_twin)]
/// The recorded case with Node's 12 h limit on a session grant (`sessionGrantTtlMs`): the whole log is replayed and compared;
/// the answers Node recorded after the limit are the ones `divergences` replaces (a session grant has no time limit). The
/// limit itself is Node's setting, which the core does not have, so it is checked to be what the log's clock steps cross.
async fn session_grant_has_no_time_limit(set: &str, index: usize, name: &str) {
    let (expected, now) = recorded(set, index, name);
    assert_eq!(expected.get("sessionGrantTtlMs").as_f64(), 43_200_000.0, "{set} case {index}: Node's limit is 12 h");
    let world = World::new(now);
    let log = replay_log(&world, &expected).await;
    compare(&obj(vec![("log", log)]), &obj(vec![("log", expected.get("log").clone())]), &format!("{set} case {index}"));
}
#[cfg(node_twin)]
#[tokio::test]
async fn hook_ask_0_a_coding_lead_hook_ask_offers_once_this_session_always_keyed_by_the_tool() {
    let (expected, now) = recorded(HOOK_ASK, 0, "a coding Lead hook ask offers once / this session / always, keyed by the tool");
    let world = World::new(now);
    let log = replay_log(&world, &expected).await;
    let ask = world.ask(0);
    let presented = fields(&card(&ask, now), true);
    let normalized: Vec<Value> = ["once", "session", "always", "agent"]
        .iter()
        .map(|remember| json!({"remember": remember, "response": normalized(&ask, json!({"approved": true, "remember": remember}), now)}))
        .collect();
    let no_key = normalize_tool_approval_request(json!({"kind": "approval", "remember": ["once", "session", "always"]}).as_object().unwrap(), "1", now);
    let actual = obj(vec![
        ("log", log),
        ("presented", ex(presented)),
        ("normalized", ex(json!(normalized))),
        ("requestNamingNoKey", ex(fields(no_key.as_object().unwrap(), false))),
    ]);
    compare(&actual, &expected, "hook-ask-grants case 0");
}
#[cfg(node_twin)]
#[tokio::test]
async fn hook_ask_1_always_saves_one_every_agent_grant() {
    log_only(HOOK_ASK, 1, "\"always\" saves one every-agent grant: no card for that tool in this or any other conversation").await;
}
#[cfg(node_twin)]
#[tokio::test]
async fn hook_ask_2_the_answered_call_keeps_a_hook_rewrite() {
    log_only(HOOK_ASK, 2, "the answered call keeps a hook rewrite and is not marked as an outbound approval").await;
}
#[cfg(node_twin)]
#[tokio::test]
async fn hook_ask_3_this_session_covers_the_tool_for_that_conversation_only() {
    session_grant_has_no_time_limit(HOOK_ASK, 3, "\"this session\" covers the tool for that conversation only, ends on reset and after 12 h, never saved").await;
}
#[cfg(node_twin)]
#[tokio::test]
async fn hook_ask_4_the_key_is_the_tool_or_the_classified_kind() {
    let (expected, now) = recorded(HOOK_ASK, 4, "the key is the tool (or the classified kind), never the arguments: nothing widens to an unrelated call");
    let world = World::new(now);
    let log = replay_log(&world, &expected).await;
    let long = "a".repeat(200);
    let tool_action_of: Vec<Value> = ["shell", "", "has space", long.as_str(), "setup", "ask_user", "handoff_user", "x/y"]
        .iter()
        .map(|name| {
            let label = if name.len() > 20 { format!("a x {}", name.len()) } else { (*name).to_owned() };
            json!({"name": label, "key": GrantKey::tool(name).map(|key| key.render()).unwrap_or_default()})
        })
        .collect();
    let parsed = |text: &str| GrantKey::parse(text);
    let actual = obj(vec![
        ("log", log),
        ("toolActionOf", ex(json!(tool_action_of))),
        ("isToolAction", ex(json!(parsed("tool:shell").is_some_and(|key| key.is_tool())))),
        ("isRememberableShell", ex(json!(parsed("tool:shell").is_some_and(|key| key.rememberable())))),
        ("isRememberableSetup", ex(json!(parsed("tool:setup").is_some_and(|key| key.rememberable())))),
    ]);
    compare(&actual, &expected, "hook-ask-grants case 4");
}
#[cfg(node_twin)]
#[tokio::test]
async fn hook_ask_5_tools_that_change_what_agents_may_do_are_asked_once() {
    let (expected, now) = recorded(HOOK_ASK, 5, "tools that change what agents may do, and the user prompts, are asked once");
    let world = World::new(now);
    let log = replay_log(&world, &expected).await;
    // `ask_user` and `handoff_user` are themselves the user prompt: the product's pipeline (Node's before-hook.mjs:159 too) passes
    // them on unjudged, so their decide and its answer were recorded off the product path (the recorder called humanGateDecision
    // directly). Each passed through unchanged is checked here; those steps are left out of the comparison (declared in the manifest).
    let prompt = |step: &Exact| ["ask_user", "handoff_user"].contains(&step.try_get("call").or_else(|| step.try_get("gate")).map_or("", |at| at.get(if step.try_get("call").is_some() { "name" } else { "tool" }).as_str()));
    let mut kept = Vec::new();
    for step in log.as_array() {
        if !prompt(step) {
            kept.push(step.clone());
        } else if step.get("do").as_str() == "decide" {
            let passed = obj(vec![("unjudged", obj(vec![("name", step.get("call").get("name").clone()), ("args", step.get("call").get("args").clone())]))]);
            compare(step.get("result"), &passed, "hook-ask-grants case 5: a user prompt passes the pipeline unjudged");
        }
    }
    let expected_kept: Vec<Exact> = expected.get("log").as_array().iter().filter(|step| !prompt(step)).cloned().collect();
    compare(&obj(vec![("log", Exact::Array(kept))]), &obj(vec![("log", Exact::Array(expected_kept))]), "hook-ask-grants case 5");
}
#[cfg(node_twin)]
#[tokio::test]
async fn hook_ask_6_payments_and_permanent_deletes_are_never_offered_stored_or_honoured() {
    log_only(HOOK_ASK, 6, "payments and permanent deletes are never offered, stored or honoured, and are not skipped by Allow all actions").await;
}
#[cfg(node_twin)]
#[tokio::test]
async fn hook_ask_7_a_grant_for_one_kind_or_tool_never_answers_another() {
    log_only(HOOK_ASK, 7, "a grant for one kind or tool never answers a payment, a delete or another kind").await;
}
#[cfg(node_twin)]
#[tokio::test]
async fn hook_ask_8_an_unattended_run_never_gets_or_uses_a_session_grant() {
    log_only(HOOK_ASK, 8, "an unattended run never gets or uses a session grant; it may use a saved always grant").await;
}
#[cfg(node_twin)]
#[tokio::test]
async fn hook_ask_9_a_timeout_or_a_denial_stores_no_decision() {
    let (expected, now) = recorded(HOOK_ASK, 9, "a timeout or a denial stores no decision");
    let world = World::new(now);
    let log = replay_log(&world, &expected).await;
    let denied = normalized(&world.ask(0), json!({"approved": false, "remember": "always"}), now);
    compare(&obj(vec![("log", log), ("denied", ex(denied))]), &expected, "hook-ask-grants case 9");
}
#[cfg(node_twin)]
#[tokio::test]
async fn hook_ask_10_a_bot_hook_ask_on_a_classified_send() {
    let (expected, now) = recorded(HOOK_ASK, 10, "a bot hook ask on a classified send offers once / session / always and is answered by those only");
    let harness = |name: &str| {
        let recorded = expected.get(name).clone();
        async move {
            let world = World::new(now);
            obj(vec![("note", recorded.get("note").clone()), ("log", world.run(recorded.get("log")).await)])
        }
    };
    let world = World::new(now);
    let log = replay_log(&world, &expected).await;
    let actual = obj(vec![("log", log), ("harness2", harness("harness2").await), ("harness3", harness("harness3").await)]);
    compare(&actual, &expected, "hook-ask-grants case 10");
}
#[cfg(node_twin)]
#[tokio::test]
async fn hook_ask_11_a_shared_allow_is_listed_in_every_agents_permissions() {
    let (expected, now) = recorded(HOOK_ASK, 11, "a shared allow is listed in every agent's permissions and revoking it there turns it back to asking");
    let world = World::new(now);
    let log = replay_log(&world, &expected).await;
    let mut results = Vec::new();
    for rejection in expected.get("rejections").as_array() {
        let refused = within(
            "setAgentPermission",
            world.permissions().set(&plain(rejection.get("agent")), &plain(rejection.get("action")), &plain(rejection.get("mode")), false),
        )
        .await
        .expect_err("the change is refused");
        results.push(obj(vec![(
            "rejected",
            Exact::Error { name: "Error".into(), message: refused.to_string(), code: None, cause: None, props: Vec::new() },
        )]));
    }
    let actual = obj(vec![("log", log), ("rejections", expected.get("rejections").clone()), ("results", Exact::Array(results))]);
    compare(&actual, &expected, "hook-ask-grants case 11");
}
#[cfg(node_twin)]
#[tokio::test]
async fn hook_ask_12_a_damaged_or_hand_edited_grants_file_never_yields_a_tool_grant_for_another_agent() {
    let (expected, now) = recorded(HOOK_ASK, 12, "a damaged or hand-edited grants file never yields a tool grant for another agent or a block");
    let world = World::new(now);
    for set in expected.get("setModes").as_array() {
        let [agent, action, mode] = set.as_array() else { panic!("a setMode") };
        world.set_mode(agent.as_str(), action.as_str(), mode.as_str()).await;
    }
    let log = replay_log(&world, &expected).await;
    // The grants file hand-edited: mailer's `tool:shell` row is changed to name the Lead, keeping mailer's id. The store reads
    // the file again on the next decision, so this is a real load of a row whose id is not its owner's and action's.
    let file = world._dir.path().join("human-gate").join("grants.json");
    let mut doc: Value = serde_json::from_str(&std::fs::read_to_string(&file).expect("the grants file")).expect("the grants JSON");
    let row = doc["grants"]
        .as_array_mut()
        .expect("rows")
        .iter_mut()
        .find(|row| row["agentId"] == "mailer" && row["action"] == "tool:shell")
        .expect("mailer's shell row");
    row["agentId"] = json!("lead");
    std::fs::write(&file, serde_json::to_string_pretty(&doc).expect("the edited JSON")).expect("the edited file");
    let mode = within("the store's modeFor", world.store.mode_for("lead", &key("tool:shell"), false)).await.expect("the mode");
    let listed = within("the store's grants", world.store.list_grants(None)).await.expect("the grants");
    assert!(listed.is_empty(), "hook-ask-grants case 12: the edited row is damaged and lists nothing: {listed:?}");
    let actual = obj(vec![("log", log), ("setModes", expected.get("setModes").clone()), ("modeFor", ex(json!(mode.as_str())))]);
    compare(&actual, &expected, "hook-ask-grants case 12");
}
#[cfg(node_twin)]
#[tokio::test]
async fn hook_ask_13_the_card_is_told_what_the_choice_covers() {
    let (expected, now) = recorded(HOOK_ASK, 13, "the card is told what the choice covers: the action kind of a classified call, else the tool");
    let world = World::new(now);
    let log = replay_log(&world, &expected).await;
    let card_of = |index: usize, presented: bool| fields(&card(&world.ask(index), now), presented);
    let actual = obj(vec![
        ("log", log),
        (
            "grantActions",
            ex(json!({
                "comment": card_of(0, true),
                "shell": card_of(1, false),
                "merge": card_of(2, false),
                "mcp__stripe__create_payment": card_of(3, false),
                "setup": card_of(4, false),
            })),
        ),
    ]);
    compare(&actual, &expected, "hook-ask-grants case 13");
}
#[cfg(node_twin)]
#[tokio::test]
async fn session_0_a_session_grant_covers_the_action_kind_on_every_site_and_target() {
    let (expected, now) = recorded(SESSION, 0, "a session grant covers the action kind on every site and target, nothing else, nobody else");
    let world = World::new(now);
    let log = replay_log(&world, &expected).await;
    let normalized = normalized(&world.ask(0), json!({"approved": true, "remember": "session"}), now);
    let room = mixdog_core_base::rooms::ids::room_member_session_id("room123abc", "mailer").expect("a room seat");
    compare(&obj(vec![("log", log), ("normalized", ex(normalized)), ("roomSession", ex(json!(room)))]), &expected, "session-grants case 0");
}
#[cfg(node_twin)]
#[tokio::test]
async fn session_1_always_stays_a_saved_revocable_allow() {
    let (expected, now) = recorded(SESSION, 1, "\"always\" stays a saved, revocable allow and is audited like the session one");
    let world = World::new(now);
    let log = replay_log(&world, &expected).await;
    let action = log.as_array()[2].get("grants").as_array()[0].get("action").clone();
    compare(&obj(vec![("log", log), ("grantAction", action)]), &expected, "session-grants case 1");
}
#[cfg(node_twin)]
#[tokio::test]
async fn session_2_a_session_grant_expires_after_its_time_limit() {
    session_grant_has_no_time_limit(SESSION, 2, "a session grant expires after its time limit").await;
}
#[cfg(node_twin)]
#[tokio::test]
async fn session_3_a_session_grant_ends_when_its_session_is_reset_closed_or_replaced() {
    log_only(SESSION, 3, "a session grant ends when its session is reset, closed or replaced").await;
}
#[cfg(node_twin)]
#[tokio::test]
async fn session_4_the_real_session_life_changes_when_the_session_is_cleared_or_closed() {
    let (expected, now) = recorded(SESSION, 4, "the real session life changes when the session is cleared or closed");
    let world = World::new(now);
    let id = expected.get("sessionId").as_str();
    let session = world.session(id);
    session.live.change(|header| *header = json!({"owner": "cli", "agent": "lead", "createdAt": 5}).as_object().unwrap().clone());
    let before = within("the session's gate facts", session.gate.facts()).await.life;
    session.live.change(|header| {
        header.insert("compaction".into(), json!({"lastClearAt": 77}));
    });
    let after_clear = within("the session's gate facts", session.gate.facts()).await.life;
    session.live.change(|header| {
        header.insert("closed".into(), json!(true));
    });
    let after_close = within("the session's gate facts", session.gate.facts()).await.life;
    let actual = obj(vec![
        ("log", Exact::Array(Vec::new())),
        ("sessionId", ex(json!(id))),
        ("before", ex(json!(before))),
        ("afterClear", ex(json!(after_clear))),
        ("afterClose", ex(json!(after_close))),
        // Declared in the manifest: the core builds a session's gate only for a session it holds.
        ("unknown", expected.get("unknown").clone()),
    ]);
    compare(&actual, &expected, "session-grants case 4");
}
#[cfg(node_twin)]
#[tokio::test]
async fn session_5_unattended_runs_never_inherit_a_session_grant() {
    log_only(SESSION, 5, "unattended runs never inherit a session grant but do use \"always\" and run policy").await;
}
#[cfg(node_twin)]
#[tokio::test]
async fn session_6_payments_and_permanent_deletes_are_never_offered_granted_or_remembered() {
    let (expected, now) = recorded(SESSION, 6, "payments and permanent deletes are never offered, granted or remembered for a session");
    let world = World::new(now);
    let log = replay_log(&world, &expected).await;
    let mut offered = Vec::new();
    for (index, tool) in [(0, "mcp__stripe__create_payment"), (2, "mcp__drive__delete_permanently")] {
        let mut ask = world.ask(index);
        ask.payload["remember"] = json!(["once", "session", "agent"]);
        offered.push(json!({"tool": tool, "listsMoreStillOnce": fields(&card(&ask, now), false)}));
    }
    let home = SessionGrants::of(world.registry.clone(), HOME);
    let direct = [home.grant("mailer", &key("payment"), ""), home.grant("mailer", &key("delete"), "")];
    let actual = obj(vec![("log", log), ("offered", ex(json!(offered))), ("sessionGrantsGrantPaymentThenDelete", ex(json!(direct)))]);
    compare(&actual, &expected, "session-grants case 6");
}
#[cfg(node_twin)]
#[tokio::test]
async fn session_7_a_grant_for_one_kind_never_answers_a_payment_a_delete_or_another_kind() {
    let (expected, now) = recorded(SESSION, 7, "a grant for one kind never answers a payment, a delete or another kind");
    let world = World::new(now);
    let home = SessionGrants::of(world.registry.clone(), HOME);
    let granted: Vec<Value> = ["comment", "email", "message", "publish", "form"]
        .iter()
        .map(|kind| json!({"kind": kind, "granted": home.grant("mailer", &key(kind), "")}))
        .collect();
    let has: Vec<Value> = [("mailer", "payment"), ("mailer", "delete"), ("mailer", "review"), ("scribe", "email")]
        .iter()
        .map(|(agent, action)| json!({"agentId": agent, "action": action, "has": home.has(agent, &key(action), "")}))
        .collect();
    let log = replay_log(&world, &expected).await;
    compare(&obj(vec![("log", log), ("granted", ex(json!(granted))), ("has", ex(json!(has)))]), &expected, "session-grants case 7");
}
#[cfg(node_twin)]
#[tokio::test]
async fn session_8_the_bots_block_still_stops_a_kind_that_was_allowed_for_the_session() {
    log_only(SESSION, 8, "the bot's block still stops a kind that was allowed for the session").await;
}
#[cfg(node_twin)]
#[tokio::test]
async fn session_9_a_timeout_or_a_denial_stores_no_decision() {
    let (expected, now) = recorded(SESSION, 9, "a timeout or a denial stores no decision, whatever scope came with it");
    let world = World::new(now);
    let log = replay_log(&world, &expected).await;
    let timed_out = normalized(&world.ask(0), json!({"approved": false, "remember": "session"}), now);
    compare(&obj(vec![("log", log), ("timedOut", ex(timed_out))]), &expected, "session-grants case 9");
}
#[cfg(node_twin)]
#[tokio::test]
async fn session_10_secret_takeover_connector_and_permission_requests_are_answered_once() {
    let (expected, now) = recorded(SESSION, 10, "secret, takeover, connector and permission requests are answered once, whatever they list");
    let listed = plain(expected.get("listed"));
    let card_of = |input: &Value| {
        let mut input = input.as_object().expect("a request").clone();
        input.insert("remember".into(), listed.clone());
        normalize_tool_approval_request(&input, "1", now).as_object().expect("a card").clone()
    };
    let mut requests = Vec::new();
    for request in expected.get("requests").as_array() {
        let input = plain(request.get("input"));
        let shown = card_of(&input);
        let presented = fields(&shown, true);
        let ask = ApprovalAsk {
            kind: ApprovalKind::UserInput,
            call_id: None,
            tool: None,
            action_kind: None,
            reason: None,
            payload: presented.clone(),
            remember: Vec::new(),
            expires_after: None,
        };
        let normalized: Vec<Value> = listed
            .as_array()
            .unwrap()
            .iter()
            .map(|remember| json!({"remember": remember, "response": normalized(&ask, json!({"approved": true, "remember": remember, "scope": "auto"}), now)}))
            .collect();
        requests.push(json!({"input": input, "fields": fields(&shown, false), "presented": presented, "normalized": normalized}));
    }
    let actual = obj(vec![
        ("log", Exact::Array(Vec::new())),
        ("listed", ex(listed.clone())),
        ("requests", ex(json!(requests))),
        ("permissionFields", ex(fields(&card_of(&json!({"kind": "permission"})), false))),
        ("approvalWithoutKindFields", ex(fields(&card_of(&json!({"kind": "approval"})), false))),
    ]);
    compare(&actual, &expected, "session-grants case 10");
}
#[cfg(node_twin)]
#[tokio::test]
async fn session_11_the_session_registry_has_no_count_limit_and_a_closed_session_leaves_nothing() {
    // Node bounded the registry (oldest first, and by time); a grant now lives exactly as long as its conversation.
    let (expected, _) = recorded(SESSION, 11, "the session registry is bounded: oldest first, expired entries pruned on read");
    let beyond_the_old_cap = expected.get("maxEntries").as_f64() as usize + 1;
    let registry = SessionGrantRegistry::new();
    let mail = GrantKey::tool("mail__send").expect("a tool key");
    let of = |session: &str| SessionGrants::of(registry.clone(), session);
    for n in 0..beyond_the_old_cap {
        assert!(of(&format!("s{n}")).grant("a", &mail, ""), "s{n}");
    }
    for n in 0..beyond_the_old_cap {
        assert!(of(&format!("s{n}")).has("a", &mail, ""), "s{n} is still granted: nothing evicted it");
    }
    registry.forget("s0");
    assert!(!of("s0").has("a", &mail, ""), "a closed session's grant is gone");
    assert_eq!(registry.held("s0"), 0);
    assert!(of("s1").has("a", &mail, ""), "another session keeps its own");
}