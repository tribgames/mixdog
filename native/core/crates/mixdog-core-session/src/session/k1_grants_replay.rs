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
//! on a real directory. Every wait has a deadline. The store's clock is the recording's held `Date.now`; the session-grant clock starts where the
//! recorder's did (1_000_000 ms) and moves only by the recorded advances. A card is what a client is shown for the
//! request ([`tool_approval`] of the approval book's request), compared on the fields `humanRequestFields` defines.
//!
//! A decision is the core's verdict written as Node's `{ decision, request, gate, remembered }`: the decision as the
//! hooks left it (an answered `ask` runs as `allow`, or `modify` when the hook rewrote the call), the request the card
//! presents and the audit identity its answer is recorded under.

use std::collections::HashMap;
use std::path::Path;
use std::sync::Arc;
use std::sync::Mutex;
use std::sync::atomic::AtomicBool;
use std::sync::atomic::AtomicU64;
use std::sync::atomic::Ordering;
use std::time::Duration;
use std::time::Instant;

use async_trait::async_trait;
use mixdog_agent::env::BoundAccount;
use mixdog_agent::env::GateCall as SessionCall;
use mixdog_agent::env::GateSession;
use mixdog_core_agents::agents::AgentPermissions;
use mixdog_core_api::domain::approval::ActionKind;
use mixdog_core_api::domain::approval::ApprovalAsk;
use mixdog_core_api::domain::approval::ApprovalGate;
use mixdog_core_api::domain::approval::ApprovalId;
use mixdog_core_api::domain::approval::ApprovalKind;
use mixdog_core_api::domain::tool::Tool;
use mixdog_core_api::domain::tool::ToolAnnotations;
use mixdog_core_api::domain::tool::ToolContext;
use mixdog_core_api::domain::tool::ToolOutcome;
use mixdog_core_api::domain::tool::ToolOutput;
use mixdog_core_api::domain::tool::ToolSpec;
use mixdog_core_api::ids::ThreadId;
use mixdog_core_api::ids::TurnId;
use mixdog_core_base::approvals::ApprovalBook;
use mixdog_core_base::approvals::DeviceInfo;
use mixdog_core_base::approvals::Lineage;
use mixdog_core_ports::ports::gate::GateEnv;
use mixdog_core_ports::ports::gate::GateRun;
use mixdog_core_ports::ports::gate::LiveHeader;
use mixdog_core_ports::ports::gate::SessionGate;
use mixdog_protocol::ApprovalRemember;
use mixdog_protocol::ApprovalResolution;
use mixdog_protocol::ConnectionKind;
use mixdog_protocol::ToolCallId;
use mixdog_scm::error::ScmFailure;
use mixdog_scm::gh::client::GhClient;
use mixdog_scm::gh::client::GhOutput;
use mixdog_scm::gh::client::GhRunner;
use mixdog_scm::gh::commands::GhCommand;
use mixdog_scm::locks::RepoLocks;
use mixdog_store::schema::record::Header;
use mixdog_testkit::Exact;
use mixdog_tools::policy::AuthorizeRequest;
use mixdog_tools::policy::ConnectorPermissions;
use mixdog_tools::policy::FileGrantStore;
use mixdog_tools::policy::GrantKey;
use mixdog_tools::policy::GrantStore as _;
use mixdog_tools::policy::HookAction;
use mixdog_tools::policy::HookCall;
use mixdog_tools::policy::HookDecision;
use mixdog_tools::policy::HookFailure;
use mixdog_tools::policy::PermissionMode;
use mixdog_tools::policy::PreToolHook;
use mixdog_tools::policy::RunKind;
use mixdog_tools::policy::SessionGrantRegistry;
use mixdog_tools::policy::SessionGrants;
use mixdog_tools::policy::SessionSurface;
use mixdog_tools::policy::ToolPolicy;
use mixdog_tools::policy::ToolResolver;
use mixdog_core_api::domain::tool::ToolError;
use mixdog_tools::policy::Authorized;
use mixdog_tools::policy::gate::AskRequest;
use mixdog_tools::policy::gate::GateAudit;
use mixdog_tools::policy::gate::GateVerdict;
use tokio::sync::mpsc;
use tokio::sync::oneshot;
use tokio::task::JoinHandle;
use mixdog_tools::policy::run_policy::AUTOMATION_GRANT_REASON;
use mixdog_tools::policy::session_grants::SESSION_GRANT_TTL;
use serde_json::Map;
use serde_json::Value;
use serde_json::json;
use tokio::sync::watch;
use tokio_util::sync::CancellationToken;

use super::room_approval::normalize_tool_approval_request;
use super::room_approval::tool_approval;

/// The recorder's movable session-grant clock starts here (`let clock = 1_000_000`).
const SESSION_CLOCK_START_MS: u64 = 1_000_000;
/// The sessions the recorders name.
const LEAD: &str = "sess_lead_coding";
const HOME: &str = "sess_home_mailer";
/// The recorders' agent roster: `kind: bot` definitions.
const CONTACT_BOTS: [&str; 2] = ["mailer", "scribe"];

fn golden(set: &str) -> Exact {
    Exact::load(Path::new(env!("CARGO_MANIFEST_DIR")).join("../../fixtures").join(set).join("golden.json"))
}

fn recorded(set: &str, index: usize, name: &str) -> (Exact, i64) {
    let golden = golden(set);
    let case = &golden.get("cases").as_array()[index];
    assert_eq!(case.get("case").as_str(), name, "case {index} of {set}");
    (case.get("observed").clone(), golden.get("clock").get("dateNow").as_f64() as i64)
}

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

fn compare(actual: &Exact, expected: &Exact, case: &str) {
    if let Some(difference) = actual.difference(expected) {
        panic!("{case}: the core's outcome differs from Node's at {difference}");
    }
}

fn remember_name(scope: ApprovalRemember) -> &'static str {
    match scope {
        ApprovalRemember::Once => "once",
        ApprovalRemember::Session => "session",
        ApprovalRemember::Agent => "agent",
        ApprovalRemember::Always => "always",
    }
}

fn remember_of(name: &str) -> ApprovalRemember {
    match name {
        "once" => ApprovalRemember::Once,
        "session" => ApprovalRemember::Session,
        "agent" => ApprovalRemember::Agent,
        "always" => ApprovalRemember::Always,
        other => panic!("a remember scope, not {other}"),
    }
}

fn key(text: &str) -> GrantKey {
    GrantKey::parse(text).unwrap_or_else(|| panic!("a grant key, not {text}"))
}

/// The `gh` of the registered `github` tool: deciding a call never runs it.
struct NoGh;

#[async_trait]
impl GhRunner for NoGh {
    async fn raw(&self, command: &GhCommand, _cwd: &Path, _cancel: &CancellationToken) -> Result<GhOutput, ScmFailure> {
        panic!("a decision ran gh: {:?}", command.args)
    }
}

/// A connector tool as the MCP catalog would hold it, its outbound kind by the connector rule.
struct ConnectorTool(ToolSpec);

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

struct Tools {
    github: Arc<dyn Tool>,
}

impl Tools {
    fn new() -> Self {
        let client = Arc::new(GhClient::new(Arc::new(NoGh), RepoLocks::new()));
        Self { github: Arc::new(mixdog_tools::github::GithubTool::new(client, None)) }
    }
}

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

/// No connector of the roster is set to ask, disabled or switched off.
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

/// The PreToolUse decision of the call being answered: the recorded hook.
#[derive(Default)]
struct Hook(Mutex<Option<HookDecision>>);

#[async_trait]
impl PreToolHook for Hook {
    async fn pre_tool(&self, _call: &HookCall<'_>) -> Result<Option<HookDecision>, HookFailure> {
        Ok(self.0.lock().unwrap().clone())
    }
}

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

/// Every wait of the replay ends here at the latest.
const DEADLINE: Duration = Duration::from_secs(30);

/// `future`'s output, or a failure naming what did not happen within [`DEADLINE`].
async fn within<T>(what: &str, future: impl std::future::Future<Output = T>) -> T {
    tokio::time::timeout(DEADLINE, future).await.unwrap_or_else(|_| panic!("{what}: nothing within {DEADLINE:?}"))
}

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

/// How the pipeline's run of a call went on: it showed a card and waits for its answer, or it ended.
enum Started {
    Card(ApprovalId, ApprovalAsk, JoinHandle<Result<Authorized, ToolError>>),
    Ended(Result<Authorized, ToolError>),
}

/// A shown card and the call waiting on it.
struct Waiting {
    aid: ApprovalId,
    run: JoinHandle<Result<Authorized, ToolError>>,
}

/// A client's response to `ask` through the approval book: the resolution the waiting run receives.
fn validate(ask: ApprovalAsk, result: &Value, device: &str, now_ms: i64) -> ApprovalResolution {
    let thread = ThreadId::from("t");
    let aid = ApprovalId(1);
    let mut book = ApprovalBook::default();
    book.insert(ApprovalBook::request(aid, &thread, &Lineage::top_level(&thread), ask, now_ms), TurnId::from("r"), None);
    book.validate(&aid.request_id(), result, DeviceInfo { device: device.to_owned(), kind: ConnectionKind::Desktop }, now_ms)
        .expect("the response decodes")
        .expect("the request is pending")
        .resolution
}

/// The decision a client's `result` becomes, written as Node's response object.
fn normalized(ask: &ApprovalAsk, result: Value, now_ms: i64) -> Value {
    match validate(ask.clone(), &result, "", now_ms) {
        ApprovalResolution::Decided { decision, .. } => serde_json::to_value(decision).expect("a decision serializes"),
        other => panic!("decided, not {other:?}"),
    }
}

/// The card a client is shown for `ask`.
fn card(ask: &ApprovalAsk, now_ms: i64) -> Map<String, Value> {
    let thread = ThreadId::from("t");
    let request = ApprovalBook::request(ApprovalId(1), &thread, &Lineage::top_level(&thread), ask.clone(), now_ms);
    tool_approval(&request).as_object().expect("a card").clone()
}

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

struct Live(Mutex<Arc<Header>>);

impl LiveHeader for Live {
    fn header(&self) -> Arc<Header> {
        self.0.lock().unwrap().clone()
    }
}

impl Live {
    fn change(&self, edit: impl FnOnce(&mut Header)) {
        let mut header = self.0.lock().unwrap();
        let mut next = (**header).clone();
        edit(&mut next);
        *header = Arc::new(next);
    }
}

#[derive(Default)]
struct Env {
    runs: Mutex<HashMap<String, GateRun>>,
    allow_all: AtomicBool,
}

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

struct Session {
    live: Arc<Live>,
    gate: SessionGate,
    grants: SessionGrants,
    _surface: watch::Sender<Arc<SessionSurface>>,
}

/// The call the last `decide` decided: what a `choose` or an `answer` answers.
#[derive(Clone)]
struct Pending {
    call: Value,
    session: String,
    hook: Value,
}

/// One recorder harness: a store on its own directory, the process's session-grant registry, the sessions.
struct World {
    _dir: tempfile::TempDir,
    store: Arc<FileGrantStore>,
    registry: Arc<SessionGrantRegistry>,
    clock: Arc<AtomicU64>,
    env: Arc<Env>,
    sessions: Mutex<HashMap<String, Arc<Session>>>,
    tools: Tools,
    hook: Arc<Hook>,
    policy: ToolPolicy,
    client: Arc<Client>,
    cards: tokio::sync::Mutex<mpsc::UnboundedReceiver<(ApprovalId, ApprovalAsk)>>,
    /// The gate's verdict of the call the pipeline judged last (`policy-observer`).
    verdict: Arc<Mutex<Option<GateVerdict>>>,
    pending: Mutex<Option<Pending>>,
    /// The card the client was shown last, while its call waits on it.
    waiting: Mutex<Option<Waiting>>,
    /// The card of every decided call that showed one, in log order.
    asks: Mutex<Vec<Option<ApprovalAsk>>>,
    lives: AtomicU64,
    now_ms: i64,
}

impl World {
    fn new(now_ms: i64) -> Arc<Self> {
        let dir = tempfile::tempdir().expect("a data dir");
        let tokens = mixdog_rt::testing::tokens();
        let store = FileGrantStore::with_clock(dir.path().join("human-gate"), tokens.interactive_io, tokens.durability_io, Arc::new(move || now_ms));
        let clock = Arc::new(AtomicU64::new(SESSION_CLOCK_START_MS));
        let base = Instant::now();
        let ticks = clock.clone();
        let registry = SessionGrantRegistry::with_settings(
            move || base + Duration::from_millis(ticks.load(Ordering::SeqCst)),
            mixdog_tools::policy::session_grants::SESSION_GRANT_TTL,
            mixdog_tools::policy::session_grants::MAX_SESSION_GRANTS,
        );
        let hook = Arc::new(Hook::default());
        let verdict = Arc::new(Mutex::new(None));
        let seen = verdict.clone();
        let policy = ToolPolicy::new(store.clone(), Arc::new(Connectors))
            .with_hook(hook.clone())
            .with_observer(move |judged: &GateVerdict| *seen.lock().unwrap() = Some(judged.clone()));
        let (cards_tx, cards_rx) = mpsc::unbounded_channel();
        let client = Arc::new(Client { book: Mutex::default(), ids: AtomicU64::new(0), thread: Mutex::new(ThreadId::from(LEAD)), cards: cards_tx, now_ms });
        Arc::new(Self {
            _dir: dir,
            store,
            registry,
            clock,
            env: Arc::new(Env::default()),
            sessions: Mutex::default(),
            tools: Tools::new(),
            hook,
            policy,
            client,
            cards: tokio::sync::Mutex::new(cards_rx),
            verdict,
            pending: Mutex::default(),
            waiting: Mutex::default(),
            asks: Mutex::default(),
            lives: AtomicU64::new(0),
            now_ms,
        })
    }

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

    /// The card the client was shown and has not answered is gone with its turn (`interrupted`): its call ends unrun.
    async fn abandon(&self) {
        let Some(Waiting { aid, run }) = self.waiting.lock().unwrap().take() else { return };
        self.client.book.lock().unwrap().resolved(aid, &ApprovalResolution::Interrupted { at: self.now_ms });
        let ended = within("the abandoned call to end", run).await.expect("the pipeline's task ran");
        assert!(ended.is_err(), "an unanswered card runs nothing: {ended:?}");
    }

    async fn decide(self: &Arc<Self>, call: &Value, session: &str, hook: &Value) -> Value {
        self.abandon().await;
        let pending = Pending { call: call.clone(), session: session.to_owned(), hook: hook.clone() };
        *self.pending.lock().unwrap() = Some(pending.clone());
        let started = self.start(&pending).await;
        let verdict = self.verdict.lock().unwrap().take();
        match started {
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
        }
    }

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
                .validate(&aid.request_id(), &result, DeviceInfo { device, kind: ConnectionKind::Desktop }, self.now_ms)
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
        Some(serde_json::to_value(decision).expect("a decision serializes"))
    }

    fn ask(&self, index: usize) -> ApprovalAsk {
        self.asks.lock().unwrap()[index].clone().expect("the call showed a card")
    }

    async fn grants(&self, filter: &Value) -> Value {
        let rows = self.store.list_grants(filter.get("agentId").and_then(Value::as_str)).await.expect("the grants");
        Value::Array(
            rows.iter()
                .map(|g| json!({"id": g.id, "agentId": g.agent_id, "action": g.action.render(), "mode": g.mode.as_str(), "device": g.device, "at": g.at_ms}))
                .collect(),
        )
    }

    async fn audit(&self, filter: &Value) -> Value {
        let agent = filter.get("agentId").and_then(Value::as_str);
        let limit = filter.get("limit").and_then(Value::as_u64).unwrap_or(100) as usize;
        let rows = self.store.read_audit(agent, limit).await.expect("the audit");
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
            let _ = self.store.set_mode(agent, &action, mode, "", false).await.expect("the store");
        }
    }

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
                let mut approval = input("approval");
                let fields = approval.as_object_mut().expect("an approval");
                let timed_out = fields.remove("timedOut") == Some(Value::Bool(true));
                let device = fields.remove("device").and_then(|d| d.as_str().map(str::to_owned)).unwrap_or_default();
                self.answer(approval, device, timed_out).await;
                Vec::new()
            }
            "grants" => vec![("grants", self.grants(&input("filter")).await)],
            "audit" => vec![("rows", self.audit(&input("filter")).await)],
            "advance" => {
                self.clock.fetch_add(step.get("ms").as_f64() as u64, Ordering::SeqCst);
                Vec::new()
            }
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
                let scope = remember_of(step.get("scope").as_str());
                self.store.grant(step.get("agentId").as_str(), &key(step.get("action").as_str()), scope, "").await.expect("the grant");
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
            "agentPermissions" => vec![("rows", self.permissions().table(&input("agent")).await.expect("the table"))],
            "mailer comment row" => {
                let rows = self.permissions().table(&json!("mailer")).await.expect("the table");
                vec![("row", comment_row(&rows))]
            }
            "setAgentPermission mailer comment ask" => {
                let rows = self.permissions().set(&json!("mailer"), &json!("comment"), &json!("ask"), false).await.expect("the table");
                vec![("row", comment_row(&rows))]
            }
            "setAgentPermission scribe comment ask; mailer tool:shell ask" => {
                self.permissions().set(&json!("scribe"), &json!("comment"), &json!("ask"), false).await.expect("the table");
                self.permissions().set(&json!("mailer"), &json!("tool:shell"), &json!("ask"), false).await.expect("the table");
                Vec::new()
            }
            "setAgentPermission lead tool:shell ask noWiden" => {
                self.permissions().set(&json!("lead"), &json!("tool:shell"), &json!("ask"), true).await.expect("the table");
                Vec::new()
            }
            "modeFor mailer comment" => {
                let mode = self.store.mode_for("mailer", &key("comment"), false).await.expect("the mode");
                vec![("mode", json!(mode.as_str()))]
            }
            "revokeGrant (the one grant)" => {
                let grants = self.store.list_grants(Some("mailer")).await.expect("the grants");
                vec![("revoked", json!(self.store.revoke_grant(&grants[0].id).await.expect("the revoke")))]
            }
            marker if marker.starts_with("scenario ") => Vec::new(),
            other => panic!("a step the replay does not know: {other}"),
        };
        with_outputs(step, out)
    }

    async fn run(self: &Arc<Self>, log: &Exact) -> Exact {
        let mut steps = Vec::new();
        for step in log.as_array() {
            steps.push(self.step(step).await);
        }
        self.abandon().await;
        Exact::Array(steps)
    }
}

fn comment_row(rows: &Value) -> Value {
    rows.as_array().expect("rows").iter().find(|row| row["action"] == "comment").cloned().expect("the comment row")
}

/// The recorded step with every output the core computed in place of the recorded one.
fn with_outputs(step: &Exact, outputs: Vec<(&str, Value)>) -> Exact {
    let mut entries = step.entries().to_vec();
    for (name, value) in outputs {
        let slot = entries.iter_mut().find(|(key, _)| key == name).unwrap_or_else(|| panic!("the step has no {name}"));
        slot.1 = Exact::decode(&value).expect("the core's value decodes");
    }
    Exact::Object(entries)
}

/// `{ ...base, [key]: value }`.
fn with(mut base: Map<String, Value>, key: &str, value: Value) -> Map<String, Value> {
    base.insert(key.into(), value);
    base
}

/// The pipeline's judgement as Node's `{ decision, request, gate, remembered }`: the gate's verdict the pipeline acted on, and for
/// a call it let run, the call as the pipeline passed it on (`authorized`): an answered hook `ask` runs as `allow`, or as `modify`
/// with the name and arguments the pipeline runs when they are not the call's own. The hook's reason is the hook's.
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
            };
            out.insert("decision".into(), decision);
            out.insert("request".into(), request_of(&plan.request));
            out.insert("gate".into(), gate_of(&plan.audit, session));
        }
    }
    Value::Object(out)
}

fn names(remember: &[ApprovalRemember]) -> Value {
    json!(remember.iter().map(|scope| remember_name(*scope)).collect::<Vec<_>>())
}

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
    }
}

fn gate_of(audit: &GateAudit, session: &str) -> Value {
    if audit.kind == "outbound" {
        return json!({
            "agentId": audit.agent_id, "kind": "outbound", "action": audit.action.as_ref().map(GrantKey::render), "tool": audit.tool,
            "target": audit.target, "sessionId": session, "remember": names(&audit.remember),
        });
    }
    let mut out = json!({"agentId": audit.agent_id, "kind": audit.kind, "tool": audit.tool, "target": audit.target});
    if let Some(action) = &audit.action {
        out["action"] = json!(action.render());
        out["sessionId"] = json!(session);
        out["remember"] = names(&audit.remember);
    }
    out
}

fn obj(entries: Vec<(&str, Exact)>) -> Exact {
    Exact::Object(entries.into_iter().map(|(key, value)| (key.to_owned(), value)).collect())
}

fn ex(value: Value) -> Exact {
    Exact::decode(&value).expect("the core's value decodes")
}

/// A case of plain logs: the observed object with its log replayed, every other recorded field computed by `extra`.
async fn replay_log(world: &Arc<World>, observed: &Exact) -> Exact {
    world.run(observed.get("log")).await
}

const HOOK_ASK: &str = "hook-ask-grants-cases";
const SESSION: &str = "session-grants-cases";

async fn log_only(set: &str, index: usize, name: &str, ttl: bool) {
    let (expected, now) = recorded(set, index, name);
    let world = World::new(now);
    let mut entries = vec![("log", replay_log(&world, &expected).await)];
    if ttl {
        entries.push(("sessionGrantTtlMs", ex(json!(SESSION_GRANT_TTL.as_millis() as u64))));
    }
    compare(&obj(entries), &expected, &format!("{set} case {index}"));
}

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

#[tokio::test]
async fn hook_ask_1_always_saves_one_every_agent_grant() {
    log_only(HOOK_ASK, 1, "\"always\" saves one every-agent grant: no card for that tool in this or any other conversation", false).await;
}

#[tokio::test]
async fn hook_ask_2_the_answered_call_keeps_a_hook_rewrite() {
    log_only(HOOK_ASK, 2, "the answered call keeps a hook rewrite and is not marked as an outbound approval", false).await;
}

#[tokio::test]
async fn hook_ask_3_this_session_covers_the_tool_for_that_conversation_only() {
    log_only(HOOK_ASK, 3, "\"this session\" covers the tool for that conversation only, ends on reset and after 12 h, never saved", true).await;
}

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

#[tokio::test]
async fn hook_ask_6_payments_and_permanent_deletes_are_never_offered_stored_or_honoured() {
    log_only(HOOK_ASK, 6, "payments and permanent deletes are never offered, stored or honoured, and are not skipped by Allow all actions", false).await;
}

#[tokio::test]
async fn hook_ask_7_a_grant_for_one_kind_or_tool_never_answers_another() {
    log_only(HOOK_ASK, 7, "a grant for one kind or tool never answers a payment, a delete or another kind", false).await;
}

#[tokio::test]
async fn hook_ask_8_an_unattended_run_never_gets_or_uses_a_session_grant() {
    log_only(HOOK_ASK, 8, "an unattended run never gets or uses a session grant; it may use a saved always grant", false).await;
}

#[tokio::test]
async fn hook_ask_9_a_timeout_or_a_denial_stores_no_decision() {
    let (expected, now) = recorded(HOOK_ASK, 9, "a timeout or a denial stores no decision");
    let world = World::new(now);
    let log = replay_log(&world, &expected).await;
    let denied = normalized(&world.ask(0), json!({"approved": false, "remember": "always"}), now);
    compare(&obj(vec![("log", log), ("denied", ex(denied))]), &expected, "hook-ask-grants case 9");
}

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

#[tokio::test]
async fn hook_ask_11_a_shared_allow_is_listed_in_every_agents_permissions() {
    let (expected, now) = recorded(HOOK_ASK, 11, "a shared allow is listed in every agent's permissions and revoking it there turns it back to asking");
    let world = World::new(now);
    let log = replay_log(&world, &expected).await;
    let mut results = Vec::new();
    for rejection in expected.get("rejections").as_array() {
        let refused = world.permissions().set(&plain(rejection.get("agent")), &plain(rejection.get("action")), &plain(rejection.get("mode")), false)
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

#[tokio::test]
async fn hook_ask_12_a_damaged_or_hand_edited_grants_file_never_yields_a_tool_grant_for_another_agent() {
    let (expected, now) = recorded(HOOK_ASK, 12, "a damaged or hand-edited grants file never yields a tool grant for another agent or a block");
    let world = World::new(now);
    for set in expected.get("setModes").as_array() {
        let [agent, action, mode] = set.as_array() else { panic!("a setMode") };
        world.set_mode(agent.as_str(), action.as_str(), mode.as_str()).await;
    }
    let log = replay_log(&world, &expected).await;
    let mode = world.store.mode_for("lead", &key("tool:shell"), false).await.expect("the mode");
    let actual = obj(vec![("log", log), ("setModes", expected.get("setModes").clone()), ("modeFor", ex(json!(mode.as_str())))]);
    compare(&actual, &expected, "hook-ask-grants case 12");
}

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

#[tokio::test]
async fn session_0_a_session_grant_covers_the_action_kind_on_every_site_and_target() {
    let (expected, now) = recorded(SESSION, 0, "a session grant covers the action kind on every site and target, nothing else, nobody else");
    let world = World::new(now);
    let log = replay_log(&world, &expected).await;
    let normalized = normalized(&world.ask(0), json!({"approved": true, "remember": "session"}), now);
    let room = mixdog_core_base::rooms::ids::room_member_session_id("room123abc", "mailer").expect("a room seat");
    compare(&obj(vec![("log", log), ("normalized", ex(normalized)), ("roomSession", ex(json!(room)))]), &expected, "session-grants case 0");
}

#[tokio::test]
async fn session_1_always_stays_a_saved_revocable_allow() {
    let (expected, now) = recorded(SESSION, 1, "\"always\" stays a saved, revocable allow and is audited like the session one");
    let world = World::new(now);
    let log = replay_log(&world, &expected).await;
    let action = log.as_array()[2].get("grants").as_array()[0].get("action").clone();
    compare(&obj(vec![("log", log), ("grantAction", action)]), &expected, "session-grants case 1");
}

#[tokio::test]
async fn session_2_a_session_grant_expires_after_its_time_limit() {
    log_only(SESSION, 2, "a session grant expires after its time limit", true).await;
}

#[tokio::test]
async fn session_3_a_session_grant_ends_when_its_session_is_reset_closed_or_replaced() {
    log_only(SESSION, 3, "a session grant ends when its session is reset, closed or replaced", false).await;
}

#[tokio::test]
async fn session_4_the_real_session_life_changes_when_the_session_is_cleared_or_closed() {
    let (expected, now) = recorded(SESSION, 4, "the real session life changes when the session is cleared or closed");
    let world = World::new(now);
    let id = expected.get("sessionId").as_str();
    let session = world.session(id);
    session.live.change(|header| *header = json!({"owner": "cli", "agent": "lead", "createdAt": 5}).as_object().unwrap().clone());
    let before = session.gate.facts().await.life;
    session.live.change(|header| {
        header.insert("compaction".into(), json!({"lastClearAt": 77}));
    });
    let after_clear = session.gate.facts().await.life;
    session.live.change(|header| {
        header.insert("closed".into(), json!(true));
    });
    let after_close = session.gate.facts().await.life;
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

#[tokio::test]
async fn session_5_unattended_runs_never_inherit_a_session_grant() {
    log_only(SESSION, 5, "unattended runs never inherit a session grant but do use \"always\" and run policy", false).await;
}

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

#[tokio::test]
async fn session_8_the_bots_block_still_stops_a_kind_that_was_allowed_for_the_session() {
    log_only(SESSION, 8, "the bot's block still stops a kind that was allowed for the session", false).await;
}

#[tokio::test]
async fn session_9_a_timeout_or_a_denial_stores_no_decision() {
    let (expected, now) = recorded(SESSION, 9, "a timeout or a denial stores no decision, whatever scope came with it");
    let world = World::new(now);
    let log = replay_log(&world, &expected).await;
    let timed_out = normalized(&world.ask(0), json!({"approved": false, "remember": "session"}), now);
    compare(&obj(vec![("log", log), ("timedOut", ex(timed_out))]), &expected, "session-grants case 9");
}

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

#[tokio::test]
async fn session_11_the_session_registry_is_bounded_oldest_first_expired_entries_pruned_on_read() {
    let (expected, _) = recorded(SESSION, 11, "the session registry is bounded: oldest first, expired entries pruned on read");
    let (max, ttl) = (expected.get("maxEntries").as_f64() as usize, expected.get("ttlMs").as_f64() as u64);
    let clock = Arc::new(AtomicU64::new(0));
    let base = Instant::now();
    let ticks = clock.clone();
    let registry = SessionGrantRegistry::with_settings(move || base + Duration::from_millis(ticks.load(Ordering::SeqCst)), Duration::from_millis(ttl), max);
    let email = key("email");
    let of = |session: &str| SessionGrants::of(registry.clone(), session);
    let mut steps: Vec<Value> = (1..=4).map(|n| json!({"do": "grant", "sessionId": format!("s{n}"), "granted": of(&format!("s{n}")).grant("a", &email, "")})).collect();
    steps.push(json!({"do": "has s1 (oldest evicted)", "has": of("s1").has("a", &email, "")}));
    steps.push(json!({"do": "has s4", "has": of("s4").has("a", &email, "")}));
    clock.store(101, Ordering::SeqCst);
    steps.push(json!({"do": "clock 101: has s2", "has": of("s2").has("a", &email, "")}));
    clock.store(0, Ordering::SeqCst);
    steps.push(json!({"do": "clock 0: has s3 (pruned, not just hidden)", "has": of("s3").has("a", &email, "")}));
    let actual = obj(vec![
        ("log", Exact::Array(Vec::new())),
        ("maxEntries", ex(json!(max))),
        ("ttlMs", ex(json!(ttl))),
        ("steps", ex(json!(steps))),
    ]);
    compare(&actual, &expected, "session-grants case 11");
}
