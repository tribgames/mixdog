//! `browser/bridge/run`, `browser/bridge/turn` and `browser/bridge/abort` (desktop -> core): the desktop's loopback browser bridge,
//! which the Node-hosted runtime's `browser` tool still talks to, runs each command it accepts through the core's own browser
//! command path ([`HostCommands`]: the engine where the connected desktop serves it, `host/browser/command` otherwise), with the
//! bridge's semantics (`browser/bridge-server.ts`, `agent-bridge.ts`):
//!
//! - the command is the bridge's wire shape: the tool's fields beside `action`, `session_id` (`browser` when absent), `turn_id`, and
//!   the runtime-set fields `unattended_run`, `unattended_agent`, `session_life` and `mail_link`; an `internalStep` is refused;
//! - an action of the tool is validated as the tool validates it before it runs; the runtime-only actions (the secret and
//!   saved-login actions and the handoff facts) are not, and go the way they went before;
//! - `begin_turn` and `finish_turn` mark a turn's start and end (`browser/bridge/turn` does the same): the end waits for the
//!   session's commands still running, then closes the temporary pages of the turn (the engine's, or the host's when it runs them);
//! - at most 32 commands run at once, one past that is answered 429; a command ended by [`BRIDGE_ABORT`] (the runtime's connection
//!   dropped) or by the caller's own cancel is stopped;
//! - a card a step raises goes through the one approval path ([`BrowserApprovals`](super::browser_approval::BrowserApprovals),
//!   which raises a command no tool call made through the session's own gate); [`BridgeApprovals`] adds what only a bridge command
//!   carries: a schedule or webhook run asks nothing (the saved routine was the grant) and the session's own allowance by its life
//!   mark;
//! - every reply is redacted of the secrets typed in its session, and a failure's message of urls' secrets too.
//!
//! The answer is `{ok: true, value: {text, image?, outcome?, timing?}}`, or `{ok: false, error, timing?, status?}` where `status` is
//! the HTTP status the bridge answered (400 for an invalid request, 429 for the allowance spent).

use std::sync::Arc;
use std::sync::Mutex;
use std::sync::MutexGuard;
use std::sync::PoisonError;
use std::sync::atomic::AtomicU64;
use std::sync::atomic::Ordering;

use async_trait::async_trait;
use mixdog_app_protocol::v2::browser_engine::BrowserApprovalRememberKind;
use mixdog_browser_engine::ApprovalPort;
use mixdog_browser_engine::approval::requester::own_bot_of_session;
use mixdog_browser_engine::runner::guard::SecretGuard;
use mixdog_browser_engine::runner::runner::BrowserEngine;
use mixdog_browser_engine::types::ApprovalAnswer;
use mixdog_browser_engine::types::BrowserApprovalPrompt;
use mixdog_browser_engine::types::Remember;
use mixdog_browser_policy::redaction::redact_browser_text;
use mixdog_core_api::CoreError;
use mixdog_core_api::CoreRequest;
use mixdog_core_api::DomainService;
use mixdog_core_api::HostCapability;
use mixdog_core_api::HostChannel;
use mixdog_core_api::Reply;
use mixdog_core_api::domain::approval::ActionKind;
use mixdog_core_api::domain::tool::ToolError;
use mixdog_core_api::domain::tool::ToolErrorCode;
use mixdog_core_api::ids::ConnectionId;
use mixdog_core_api::ids::Method;
use mixdog_core_api::service::Admit;
use mixdog_js::js_trim;
use mixdog_js::utf16_len;
use mixdog_protocol::ThreadId;
use mixdog_rt::CancellationToken;
use serde::Deserialize;
use serde_json::Map;
use serde_json::Value;
use serde_json::json;
use tokio::sync::Notify;

use super::browser::DEVTOOLS_ACTIONS;
use super::browser::MAX_REQUEST_BYTES;
use super::browser::validate;
use super::browser_approval::BLOCKED_BY_PERMISSION;
use super::host::BROWSER_UNAVAILABLE;
use super::host::HostCommandError;
use super::host::HostCommands;
use crate::orch::util::spec_from_def;
use crate::policy::action::GrantKey;
use crate::policy::action::kind_name;
use crate::policy::grants::AuditEntry;
use crate::policy::grants::GrantStore;
use crate::policy::grants::PermissionMode;
use crate::policy::session_grants::SessionGrantRegistry;
use crate::policy::session_grants::SessionGrants;

pub const BRIDGE_RUN: &str = "browser/bridge/run";
pub const BRIDGE_TURN: &str = "browser/bridge/turn";
pub const BRIDGE_ABORT: &str = "browser/bridge/abort";

/// What a command past the allowance is refused with: the HTTP bridge's 429.
pub const CAPACITY_REFUSAL: &str = "too many concurrent browser commands";
/// `DEFAULT_MAX_CONCURRENT_REQUESTS`.
const MAX_CONCURRENT: usize = 32;
/// The session a command with no `session_id` runs in (`DEFAULT_BROWSER_SESSION_ID`).
const DEFAULT_SESSION: &str = "browser";
/// The runtime-only actions: not tool actions, so the tool's validation never sees them, and every one goes the way it went before
/// (`HANDOFF_PAGE_ACTIONS` and the secret and saved-login actions of `agent-bridge.ts`).
const RUNTIME_ONLY_ACTIONS: [&str; 10] = [
    "secret_bind",
    "login_accounts",
    "page_url",
    "secret_precheck",
    "secret_fill",
    "saved_login_admit",
    "saved_login_release",
    "saved_login_check",
    "saved_login_type",
    "saved_login_value",
];
/// The fields the runtime sets beside the tool's own (`client.mjs`): taken out of the command before it is validated.
const RUNTIME_FIELDS: [&str; 7] = ["session_id", "turn_id", "internalStep", "unattended_run", "unattended_agent", "session_life", "mail_link"];

const BAD_CLEANUP_CONTEXT: &str = "Invalid browser task cleanup context.";
const COMMAND_CANCELLED: &str = "browser command cancelled";
const PAYMENT_IN_RUN: &str = "Browser Use step refused: payments aren't allowed in schedule/webhook runs; nothing was dispatched";
const NO_RUN_OWNER: &str = "Browser Use step refused: the run's owning bot could not be established; nothing was dispatched";

/// [`ApprovalPort`] for the steps a bridge command raises, in front of the core's one approval path: what only a bridge command
/// carries is decided here (the unattended run's rule and the session's allowance by the life mark the runtime sent), everything
/// else, and every step of a session the core hosts, is the inner port's (`approval-dialog.ts` `requestBrowserApproval`).
pub struct BridgeApprovals {
    inner: Arc<dyn ApprovalPort>,
    store: Arc<dyn GrantStore>,
    grants: Arc<SessionGrantRegistry>,
}

impl BridgeApprovals {
    pub fn new(inner: Arc<dyn ApprovalPort>, store: Arc<dyn GrantStore>, grants: Arc<SessionGrantRegistry>) -> Arc<Self> {
        Arc::new(Self { inner, store, grants })
    }

    /// The store actions every kind of the step is kept under; `None` when the step is a payment or any kind of it can never have
    /// a standing allow (`grantActions`).
    fn actions(prompt: &BrowserApprovalPrompt) -> Option<Vec<ActionKind>> {
        if prompt.payment || prompt.kinds.is_empty() {
            return None;
        }
        prompt
            .kinds
            .iter()
            .map(|kind| match kind {
                BrowserApprovalRememberKind::Submit => Some(ActionKind::BrowserSubmit),
                BrowserApprovalRememberKind::Post => Some(ActionKind::BrowserPost),
                BrowserApprovalRememberKind::Upload => Some(ActionKind::BrowserUpload),
                BrowserApprovalRememberKind::Confirm => None,
            })
            .collect()
    }

    /// Whether `agent` blocks any of the actions; a store that cannot answer means blocked (a run must not act on a permission it
    /// could not read).
    async fn blocked(&self, agent: &str, actions: &[ActionKind]) -> bool {
        for kind in actions {
            match self.store.mode_for(agent, &GrantKey::Kind(*kind), false).await {
                Ok(PermissionMode::Block) | Err(_) => return true,
                Ok(_) => {}
            }
        }
        false
    }

    async fn audit(&self, agent: &str, actions: &[ActionKind], decision: &str) {
        for kind in actions {
            let entry = AuditEntry {
                agent_id: agent.to_owned(),
                kind: "outbound".to_owned(),
                action: kind_name(*kind).to_owned(),
                tool: "browser".to_owned(),
                decision: decision.to_owned(),
                ..AuditEntry::default()
            };
            // A failed audit never decides the approval it describes.
            let _ = self.store.record_audit(entry).await;
        }
    }

    fn refused(rule: &str, message: &str) -> ToolError {
        ToolError::new(ToolErrorCode::DeniedByPolicy { rule: rule.to_owned() }, message)
    }

    /// A schedule or webhook run (and the work it started) never asks: saving the routine was the user's grant. The bot that owns
    /// the run still blocks (an operator `confirm` always asks and a payment is refused, both in `ask`).
    async fn unattended(&self, prompt: &BrowserApprovalPrompt) -> Result<ApprovalAnswer, ToolError> {
        let owner = js_trim(&prompt.unattended_agent);
        if owner.is_empty() {
            return Err(Self::refused("run_owner_unknown", NO_RUN_OWNER));
        }
        let actions = Self::actions(prompt);
        if let Some(actions) = &actions {
            if self.blocked(owner, actions).await {
                self.audit(owner, actions, "blocked").await;
                return Err(Self::refused("blocked", BLOCKED_BY_PERMISSION));
            }
            self.audit(owner, actions, "run-allowed").await;
        }
        Ok(ApprovalAnswer::Allow { remember: Remember::Once })
    }
}

#[async_trait]
impl ApprovalPort for BridgeApprovals {
    async fn ask(&self, prompt: BrowserApprovalPrompt) -> Result<ApprovalAnswer, ToolError> {
        if prompt.unattended {
            // A payment is never done in a run, an operator `confirm` step's included (`approval-dialog.ts` checks it first).
            if prompt.payment {
                return Err(Self::refused("payment_in_run", PAYMENT_IN_RUN));
            }
            if !prompt.kinds.contains(&BrowserApprovalRememberKind::Confirm) {
                return self.unattended(&prompt).await;
            }
            return self.inner.ask(prompt).await;
        }
        // The session's own allowance, bound to the life mark the runtime sent: a cleared or replaced session has another one. A
        // saved `block` still wins.
        let bot = own_bot_of_session(&prompt.session_id);
        if !bot.is_empty()
            && !prompt.session_life.is_empty()
            && let Some(actions) = Self::actions(&prompt)
        {
            let grants = SessionGrants::of(self.grants.clone(), prompt.session_id.clone());
            if actions.iter().all(|kind| grants.has(&bot, &GrantKey::Kind(*kind), &prompt.session_life)) && !self.blocked(&bot, &actions).await {
                self.audit(&bot, &actions, "session-remembered").await;
                return Ok(ApprovalAnswer::Allow { remember: Remember::Once });
            }
        }
        self.inner.ask(prompt).await
    }
}

/// A command that did not answer: the redacted message, and the timing the host measured when it said.
struct Fail {
    message: String,
    timing: Option<Value>,
}

impl Fail {
    fn plain(message: impl Into<String>) -> Self {
        Self { message: message.into(), timing: None }
    }
}

type Outcome = Result<Value, Fail>;

/// One command running now.
struct Run {
    id: u64,
    session: String,
    signal: String,
    cancel: CancellationToken,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RunParams {
    /// The bridge's wire command.
    command: Value,
    /// Names this call for [`BRIDGE_ABORT`].
    signal_id: String,
}

#[derive(Deserialize, Clone, Copy, PartialEq, Eq, Debug)]
#[serde(rename_all = "camelCase")]
enum Phase {
    Begin,
    Finish,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct TurnParams {
    phase: Phase,
    #[serde(default)]
    session_id: Option<String>,
    turn_id: Value,
    #[serde(default)]
    aborted: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct AbortParams {
    signal_id: String,
}

/// The browser bridge's service.
pub struct BrowserBridgeRun {
    host: Arc<dyn HostCommands>,
    engine: Arc<BrowserEngine>,
    channel: Arc<dyn HostChannel>,
    secrets: Arc<dyn SecretGuard>,
    browser_fields: Map<String, Value>,
    devtools_fields: Map<String, Value>,
    runs: Mutex<Vec<Run>>,
    /// Told whenever a command ends: a turn's end waits on the commands of its session.
    idle: Notify,
    next_run: AtomicU64,
}

fn locked<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(PoisonError::into_inner)
}

fn decode<T: serde::de::DeserializeOwned>(req: &CoreRequest) -> Result<T, CoreError> {
    serde_json::from_value(req.params.clone()).map_err(|error| CoreError::InvalidParams { path: "params".into(), expected: error.to_string().into() })
}

fn refusal(message: &str, status: u16) -> Value {
    json!({ "ok": false, "error": message, "status": status })
}

/// The `properties` of a tool definition's `input`, which bound the tool's string fields.
fn input_fields(def: &'static str) -> Map<String, Value> {
    spec_from_def(def, false, &[]).input_schema["properties"]["input"]["properties"].as_object().cloned().unwrap_or_default()
}

/// `browserSessionId`: the session a command runs in.
fn browser_session_id(value: Option<&Value>) -> Result<String, String> {
    let text = match value {
        None | Some(Value::Null) => return Ok(DEFAULT_SESSION.to_owned()),
        Some(Value::String(text)) if text.is_empty() => return Ok(DEFAULT_SESSION.to_owned()),
        Some(Value::String(text)) => js_trim(text),
        Some(_) => return Err("browser session_id must be a string".to_owned()),
    };
    if text.is_empty() || utf16_len(text) > 256 || !text.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-') {
        return Err("browser session_id is invalid".to_owned());
    }
    Ok(text.to_owned())
}

/// `Number.isSafeInteger(turnId) && turnId > 0`.
fn turn_number(value: Option<&Value>) -> Option<u64> {
    let number = value?.as_f64()?;
    (number.fract() == 0.0 && (1.0..=9_007_199_254_740_991.0).contains(&number)).then_some(number as u64)
}

impl BrowserBridgeRun {
    pub fn new(host: Arc<dyn HostCommands>, engine: Arc<BrowserEngine>, channel: Arc<dyn HostChannel>, secrets: Arc<dyn SecretGuard>) -> Self {
        Self {
            host,
            engine,
            channel,
            secrets,
            browser_fields: input_fields(include_str!("defs/browser.json")),
            devtools_fields: input_fields(include_str!("defs/browser_devtools.json")),
            runs: Mutex::default(),
            idle: Notify::new(),
            next_run: AtomicU64::new(1),
        }
    }

    fn claimant(req: &CoreRequest, method: &'static str) -> Result<(), CoreError> {
        if req.ctx.host_claimant { Ok(()) } else { Err(CoreError::PermissionDenied { method: method.into(), origin: req.ctx.origin }) }
    }

    /// Whether the connected desktop runs the browser through the engine's lane (the choice is made per command from what it says).
    fn engine_serves(&self) -> bool {
        self.channel.serves(HostCapability::BrowserEngine)
    }

    async fn run(&self, req: &CoreRequest) -> Result<Value, CoreError> {
        Self::claimant(req, BRIDGE_RUN)?;
        let params: RunParams = decode(req)?;
        if params.signal_id.is_empty() {
            return Err(CoreError::InvalidParams { path: "params/signalId".into(), expected: "a signal id".into() });
        }
        let Some(command) = params.command.as_object() else {
            return Ok(refusal("invalid request: browser command must be an object", 400));
        };
        if params.command.to_string().len() > MAX_REQUEST_BYTES {
            return Ok(refusal("invalid request: request too large", 400));
        }
        let id = self.next_run.fetch_add(1, Ordering::SeqCst);
        let cancel = req.ctx.cancel.child_token();
        {
            let mut runs = locked(&self.runs);
            if runs.len() >= MAX_CONCURRENT {
                return Ok(refusal(CAPACITY_REFUSAL, 429));
            }
            // The session the command names; one that is not valid is the command's own failure, below.
            let session = browser_session_id(command.get("session_id")).unwrap_or_default();
            runs.push(Run { id, session, signal: params.signal_id.clone(), cancel: cancel.clone() });
        }
        let outcome = self.execute(command, id, &cancel).await;
        locked(&self.runs).retain(|run| run.id != id);
        self.idle.notify_waiters();
        // A cancelled command answers nothing the caller could read; the words stay for the trace.
        Ok(match outcome {
            Ok(value) => json!({ "ok": true, "value": value }),
            Err(fail) => {
                let mut answer = json!({ "ok": false, "error": fail.message });
                if let Some(timing) = fail.timing {
                    answer["timing"] = timing;
                }
                answer
            }
        })
    }

    /// The command to its reply: the session's secrets and urls' secrets are redacted out of the text and the error.
    async fn execute(&self, command: &Map<String, Value>, run: u64, cancel: &CancellationToken) -> Outcome {
        let session = browser_session_id(command.get("session_id")).map_err(Fail::plain)?;
        let guarded = |text: &str| self.secrets.redact(&session, text);
        match self.dispatch(command, &session, run, cancel).await {
            Ok(mut value) => {
                if let Some(text) = value.get("text").and_then(Value::as_str) {
                    value["text"] = Value::String(guarded(text));
                }
                Ok(value)
            }
            Err(fail) => Err(Fail { message: redact_browser_text(&guarded(&fail.message)), timing: fail.timing }),
        }
    }

    async fn dispatch(&self, command: &Map<String, Value>, session: &str, run: u64, cancel: &CancellationToken) -> Outcome {
        let mut input = command.clone();
        for key in RUNTIME_FIELDS {
            input.remove(key);
        }
        if command.contains_key("internalStep") {
            return Err(Fail::plain("internalStep is not a bridge input"));
        }
        let action = command.get("action").and_then(Value::as_str).unwrap_or_default();
        // Runtime-only lifecycle messages: deliberately absent from the tool's schema.
        if action == "begin_turn" || action == "finish_turn" {
            let extra = input.keys().any(|key| key != "action" && key != "aborted");
            let raw_session = command.get("session_id").and_then(Value::as_str).filter(|text| !text.is_empty());
            if raw_session.is_none() || extra {
                return Err(Fail::plain(BAD_CLEANUP_CONTEXT));
            }
            let phase = if action == "begin_turn" { Phase::Begin } else { Phase::Finish };
            let aborted = input.get("aborted") == Some(&Value::Bool(true));
            return self.turn(phase, session, turn_number(command.get("turn_id")), aborted, run, cancel).await;
        }
        let thread = ThreadId::from(session);
        if RUNTIME_ONLY_ACTIONS.contains(&action) {
            return self.send(&thread, action, Value::Object(input), cancel).await;
        }
        let schema = if DEVTOOLS_ACTIONS.contains(&js_trim(action)) { &self.devtools_fields } else { &self.browser_fields };
        let validated = validate("", &Value::Object(input), schema).map_err(Fail::plain)?;
        let mut fields = validated.input;
        if let Some(turn) = command.get("turn_id") {
            fields.insert("turn_id".to_owned(), turn.clone());
        }
        // Runtime-set (`client.mjs`), outside the tool's schema: a schedule or webhook run, the session's life for "allow for this
        // session", and a link of a mail the runtime read.
        if command.get("unattended_run") == Some(&Value::Bool(true)) {
            fields.insert("unattended_run".to_owned(), Value::Bool(true));
            if let Some(agent) = command.get("unattended_agent") {
                fields.insert("unattended_agent".to_owned(), agent.clone());
            }
        }
        if let Some(life) = command.get("session_life").filter(|life| life.as_str().is_some_and(|text| !text.is_empty())) {
            fields.insert("session_life".to_owned(), life.clone());
        }
        if let Some(link) = command.get("mail_link") {
            fields.insert("mail_link".to_owned(), link.clone());
        }
        self.send(&thread, &validated.action, Value::Object(fields), cancel).await
    }

    /// One command to the core's browser command path (a card of it is raised by the one approval path through the session's gate).
    async fn send(&self, thread: &ThreadId, action: &str, input: Value, cancel: &CancellationToken) -> Outcome {
        self.host.browser(thread, action, input, cancel).await.map_err(|error| match error {
            HostCommandError::Cancelled => Fail::plain(COMMAND_CANCELLED),
            HostCommandError::NoHost => Fail::plain(BROWSER_UNAVAILABLE),
            HostCommandError::Rpc { message, timing, .. } => {
                Fail { message: if js_trim(&message).is_empty() { "browser bridge request failed".to_owned() } else { message }, timing }
            }
        })
    }

    /// The turn of `session` starts or ends (`begin_turn` and `finish_turn`). An end waits for the commands of the session that
    /// were running when it came, then closes the pages the turn opened for itself (`aborted`: a turn that ended badly).
    async fn turn(&self, phase: Phase, session: &str, turn: Option<u64>, aborted: bool, except: u64, cancel: &CancellationToken) -> Outcome {
        let Some(turn) = turn else { return Err(Fail::plain(BAD_CLEANUP_CONTEXT)) };
        let thread = ThreadId::from(session);
        if phase == Phase::Begin {
            // The engine owns a page by the turn of the command that opened it, so a turn's start has nothing to record there.
            return if self.engine_serves() { Ok(json!({ "text": "Browser turn started." })) } else { self.send(&thread, "begin_turn", json!({ "turn_id": turn }), cancel).await };
        }
        self.wait_idle(session, except, cancel).await;
        if self.engine_serves() {
            let closed = self.engine.finish_turn(&thread, aborted).await;
            return Ok(json!({ "text": format!("Browser task cleanup complete: {closed} temporary page(s) closed.") }));
        }
        let mut input = json!({ "turn_id": turn });
        if aborted {
            input["aborted"] = Value::Bool(true);
        }
        self.send(&thread, "finish_turn", input, cancel).await
    }

    /// Returns when every command of `session` that is running now (but `except`) has ended, or the caller's cancel fires.
    async fn wait_idle(&self, session: &str, except: u64, cancel: &CancellationToken) {
        let waiting: Vec<u64> = locked(&self.runs).iter().filter(|run| run.session == session && run.id != except).map(|run| run.id).collect();
        loop {
            let notified = self.idle.notified();
            tokio::pin!(notified);
            notified.as_mut().enable();
            if !locked(&self.runs).iter().any(|run| waiting.contains(&run.id)) {
                return;
            }
            tokio::select! {
                () = &mut notified => {}
                () = cancel.cancelled() => return,
            }
        }
    }

    async fn turn_call(&self, req: &CoreRequest) -> Result<Value, CoreError> {
        Self::claimant(req, BRIDGE_TURN)?;
        let params: TurnParams = decode(req)?;
        let session = match browser_session_id(params.session_id.as_deref().map(|id| Value::String(id.to_owned())).as_ref()) {
            Ok(session) => session,
            Err(message) => return Ok(json!({ "ok": false, "error": message })),
        };
        let outcome = self.turn(params.phase, &session, turn_number(Some(&params.turn_id)), params.aborted, 0, &req.ctx.cancel).await;
        Ok(match outcome {
            Ok(value) => json!({ "ok": true, "value": value }),
            Err(fail) => json!({ "ok": false, "error": fail.message }),
        })
    }

    /// `browser/bridge/abort`: the command named by `signalId` is stopped (its caller's connection dropped).
    fn abort(&self, req: &CoreRequest) -> Result<Value, CoreError> {
        Self::claimant(req, BRIDGE_ABORT)?;
        let params: AbortParams = decode(req)?;
        let runs = locked(&self.runs);
        let mut cancelled = 0;
        for run in runs.iter().filter(|run| run.signal == params.signal_id) {
            run.cancel.cancel();
            cancelled += 1;
        }
        Ok(json!({ "cancelled": cancelled }))
    }
}

#[async_trait]
impl DomainService for BrowserBridgeRun {
    fn methods(&self) -> &'static [&'static str] {
        &[BRIDGE_RUN, BRIDGE_TURN, BRIDGE_ABORT]
    }

    async fn call(&self, req: CoreRequest) -> Result<Reply, CoreError> {
        match req.method.as_str() {
            BRIDGE_RUN => Ok(Reply::Value(self.run(&req).await?)),
            BRIDGE_TURN => Ok(Reply::Value(self.turn_call(&req).await?)),
            BRIDGE_ABORT => Ok(Reply::Value(self.abort(&req)?)),
            other => Err(CoreError::InvalidParams { path: "method".into(), expected: format!("a method of the browser bridge, not {other}").into() }),
        }
    }

    fn notify(&self, _method: Method, _params: Value, _from: ConnectionId) -> Admit {
        Admit::Accepted
    }
}

#[cfg(test)]
mod tests {
    use std::collections::VecDeque;
    use std::path::Path;
    use std::path::PathBuf;

    use bytes::Bytes;
    use mixdog_app_protocol::v2::browser_engine::BrowserApprovalRememberKind::Confirm;
    use mixdog_app_protocol::v2::browser_engine::BrowserApprovalRememberKind::Post;
    use mixdog_app_protocol::v2::browser_engine::BrowserApprovalRememberKind::Submit;
    use mixdog_app_protocol::v2::browser_engine::BrowserApprovalRememberKind::Upload;
    use mixdog_browser_engine::BlobPort;
    use mixdog_browser_engine::FilePort;
    use mixdog_browser_engine::TakeoverPort;
    use mixdog_browser_engine::approval::classify::ActionPolicy;
    use mixdog_browser_engine::actions::registry::is_action;
    use mixdog_browser_engine::fake::Expect;
    use mixdog_browser_engine::fake::FakeHost;
    use mixdog_browser_engine::fake::page_facts;
    use mixdog_browser_engine::lane::mirror::Mirror;
    use mixdog_browser_engine::queue::user_hold::UserHold;
    use mixdog_browser_engine::runner::runner::EnginePorts;
    use mixdog_browser_engine::types::FileFacts;
    use mixdog_browser_engine::types::TakeoverGuard;
    use mixdog_browser_policy::url_policy::UrlPolicy;
    use mixdog_core_api::HostError;
    use mixdog_core_api::call::CallContext;
    use mixdog_protocol::Origin;

    use super::super::browser_engine::EngineHostCommands;
    use super::super::host::ChannelHostCommands;
    use super::super::host::HOST_COMMAND_FAILED;
    use super::*;
    use crate::policy::grants::MemoryGrantStore;

    const MARKETER: &str = "sess_home_marketer";

    /// A host channel that records what it was sent and says whether it serves the engine.
    struct Channel {
        serves_engine: bool,
        sent: Mutex<Vec<(String, Value)>>,
    }

    impl Channel {
        fn new(serves_engine: bool) -> Arc<Self> {
            Arc::new(Self { serves_engine, sent: Mutex::default() })
        }

        fn sent(&self) -> Vec<(String, Value)> {
            locked(&self.sent).clone()
        }
    }

    #[async_trait]
    impl HostChannel for Channel {
        async fn request(&self, _: HostCapability, method: Method, params: Value) -> Result<Value, HostError> {
            locked(&self.sent).push((method.as_str().to_owned(), params));
            Ok(json!({ "text": "from the pane" }))
        }

        fn serves(&self, capability: HostCapability) -> bool {
            capability != HostCapability::BrowserEngine || self.serves_engine
        }

        fn notify(&self, _: HostCapability, _: Method, _: Value) -> Result<(), CoreError> {
            Ok(())
        }
    }

    struct Masks;

    impl SecretGuard for Masks {
        fn redact(&self, _: &str, text: &str) -> String {
            text.replace("hunter2", "[secret]")
        }

        fn remember(&self, _: &str, _: &str) {}
    }

    /// The approval path under the bridge's: records every prompt it is given and answers `answer`.
    struct Inner {
        asked: Mutex<Vec<BrowserApprovalPrompt>>,
        answer: ApprovalAnswer,
    }

    #[async_trait]
    impl ApprovalPort for Inner {
        async fn ask(&self, prompt: BrowserApprovalPrompt) -> Result<ApprovalAnswer, ToolError> {
            locked(&self.asked).push(prompt);
            Ok(self.answer.clone())
        }
    }

    struct NoBlobs;

    #[async_trait]
    impl BlobPort for NoBlobs {
        async fn read(&self, _: &str) -> Result<Bytes, String> {
            Err("no blobs".to_owned())
        }
    }

    struct NoFiles;

    #[async_trait]
    impl FilePort for NoFiles {
        async fn stat(&self, _: &Path) -> FileFacts {
            FileFacts::default()
        }

        async fn write_frame(&self, run_dir: &Path, _: Bytes, _: &str) -> std::io::Result<PathBuf> {
            Ok(run_dir.to_path_buf())
        }
    }

    struct Free;

    impl TakeoverPort for Free {
        fn begin(&self, _: &str) -> Result<TakeoverGuard, String> {
            Ok(TakeoverGuard::new(CancellationToken::new(), None))
        }
    }

    fn engine(host: &Arc<FakeHost>) -> Arc<BrowserEngine> {
        Arc::new(BrowserEngine::new(
            host.clone(),
            EnginePorts {
                mirror: Arc::new(Mirror::new()),
                hold: Arc::new(UserHold::new()),
                approvals: Arc::new(Inner { asked: Mutex::default(), answer: ApprovalAnswer::Allow { remember: Remember::Once } }),
                takeover: Arc::new(Free),
                blobs: Arc::new(NoBlobs),
                files: Arc::new(NoFiles),
                secrets: Arc::new(Masks),
                approval_policy: ActionPolicy::from_env(None, None, None, is_action),
                urls: UrlPolicy::default(),
                frame_dir: PathBuf::from("frames"),
            },
        ))
    }

    /// A counter the tests wait on (a semaphore that starts empty).
    struct Permits(tokio::sync::Semaphore);

    impl Default for Permits {
        fn default() -> Self {
            Self(tokio::sync::Semaphore::new(0))
        }
    }

    impl Permits {
        fn add(&self, count: usize) {
            self.0.add_permits(count);
        }

        async fn take(&self) {
            self.0.acquire().await.expect("open").forget();
        }
    }

    /// The core's browser commands as the bridge calls them: what each was sent, answered by the script, and held while `hold` says.
    #[derive(Default)]
    struct Commands {
        seen: Mutex<Vec<(String, String, Value)>>,
        answers: Mutex<VecDeque<Result<Value, HostCommandError>>>,
        /// A command that has this action waits until released (or cancelled).
        hold_action: Option<&'static str>,
        release: Permits,
        started: Permits,
    }

    impl Commands {
        fn answer(&self, answer: Result<Value, HostCommandError>) {
            locked(&self.answers).push_back(answer);
        }

        fn seen(&self) -> Vec<(String, String, Value)> {
            locked(&self.seen).clone()
        }
    }

    #[async_trait]
    impl HostCommands for Commands {
        async fn browser(&self, thread: &ThreadId, action: &str, input: Value, cancel: &CancellationToken) -> Result<Value, HostCommandError> {
            locked(&self.seen).push((thread.as_str().to_owned(), action.to_owned(), input));
            if self.hold_action == Some(action) {
                self.started.add(1);
                tokio::select! {
                    () = self.release.take() => {}
                    () = cancel.cancelled() => return Err(HostCommandError::Cancelled),
                }
            }
            locked(&self.answers).pop_front().unwrap_or_else(|| Ok(json!({ "text": "OK" })))
        }

        async fn visualize(&self, _: &ThreadId, _: &str, _: &str, _: Value, _: &CancellationToken) -> Result<Value, HostCommandError> {
            unreachable!("a browser command")
        }
    }

    struct Rig {
        service: Arc<BrowserBridgeRun>,
        commands: Arc<Commands>,
        channel: Arc<Channel>,
        fake: Arc<FakeHost>,
    }

    fn rig_with(commands: Commands, serves_engine: bool, fake: FakeHost) -> Rig {
        let (commands, channel, fake) = (Arc::new(commands), Channel::new(serves_engine), Arc::new(fake));
        let service = Arc::new(BrowserBridgeRun::new(commands.clone(), engine(&fake), channel.clone(), Arc::new(Masks)));
        Rig { service, commands, channel, fake }
    }

    fn rig() -> Rig {
        rig_with(Commands::default(), true, FakeHost::scripted(Vec::new()))
    }

    fn call(method: &'static str, params: Value, claimant: bool, cancel: CancellationToken) -> CoreRequest {
        let mut ctx = CallContext::connection(ConnectionId(1), Origin::Local, cancel);
        ctx.host_claimant = claimant;
        CoreRequest { method: Method(method), params, op: None, ctx }
    }

    async fn answer(service: &BrowserBridgeRun, request: CoreRequest) -> Value {
        match service.call(request).await {
            Ok(Reply::Value(value)) => value,
            _ => panic!("the call must answer"),
        }
    }

    async fn run_with(service: &BrowserBridgeRun, signal: &str, command: Value, cancel: CancellationToken) -> Value {
        answer(service, call(BRIDGE_RUN, json!({ "command": command, "signalId": signal }), true, cancel)).await
    }

    async fn run(service: &BrowserBridgeRun, command: Value) -> Value {
        run_with(service, "sig", command, CancellationToken::new()).await
    }

    async fn turn(service: &BrowserBridgeRun, params: Value) -> Value {
        answer(service, call(BRIDGE_TURN, params, true, CancellationToken::new())).await
    }

    fn listed(page: &str) -> Expect {
        let row = json!({"pageId": page, "tabId": "v1", "sessionId": "s1", "background": false, "facts": page_facts(page, 1)});
        Expect::ok("host/browser/pages/list", json!({"pages": [row], "activePageId": page}))
    }

    #[tokio::test]
    async fn only_the_host_claimant_calls_it() {
        let rig = rig();
        for (method, params) in [(BRIDGE_RUN, json!({"command": {}, "signalId": "a"})), (BRIDGE_TURN, json!({"phase": "begin", "turnId": 1})), (BRIDGE_ABORT, json!({"signalId": "a"}))] {
            let refused = rig.service.call(call(method, params, false, CancellationToken::new())).await;
            assert!(matches!(refused, Err(CoreError::PermissionDenied { .. })), "{method}");
        }
    }

    /// A tool action runs through the core's command path with the runtime-set fields beside the tool's own and the session it names.
    #[tokio::test]
    async fn a_tool_action_carries_the_runtime_set_fields() {
        let rig = rig();
        let command = json!({
            "action": " click ", "session_id": " s1 ", "turn_id": 3, "ref": "e1",
            "unattended_run": true, "unattended_agent": "bot", "session_life": "5:0", "mail_link": {"url": "https://a.example"},
        });
        let reply = run(&rig.service, command).await;
        assert_eq!(reply, json!({"ok": true, "value": {"text": "OK"}}));
        let (session, action, input) = rig.commands.seen().remove(0);
        assert_eq!((session.as_str(), action.as_str()), ("s1", "click"));
        assert_eq!(input, json!({"ref": "e1", "turn_id": 3, "unattended_run": true, "unattended_agent": "bot", "session_life": "5:0", "mail_link": {"url": "https://a.example"}}));
    }

    #[tokio::test]
    async fn the_runtime_fields_are_not_forwarded_when_they_say_nothing() {
        let rig = rig();
        let command = json!({"action": "list_tabs", "unattended_run": false, "unattended_agent": "bot", "session_life": ""});
        run(&rig.service, command).await;
        let (session, action, input) = rig.commands.seen().remove(0);
        assert_eq!((session.as_str(), action.as_str(), input), ("browser", "list_tabs", json!({})));
    }

    #[tokio::test]
    async fn a_command_the_tool_would_refuse_is_refused_before_it_runs() {
        let rig = rig();
        for (command, error) in [
            (json!({"action": "teleport"}), "unknown browser action \"teleport\""),
            (json!({"action": "click"}), "browser action \"click\" requires input.ref or input.target or input.snapshotId+x+y"),
            (json!({"action": "press", "key": "A", "bogus": 1}), "browser action \"press\" does not accept input field(s): bogus"),
            (json!({"action": "click", "ref": "e1", "internalStep": true}), "internalStep is not a bridge input"),
            (json!({"action": "list_tabs", "session_id": "no good"}), "browser session_id is invalid"),
            (json!({"action": "list_tabs", "session_id": 7}), "browser session_id must be a string"),
        ] {
            assert_eq!(run(&rig.service, command.clone()).await, json!({"ok": false, "error": error}), "{command}");
        }
        assert!(rig.commands.seen().is_empty(), "nothing reached the browser");
    }

    #[tokio::test]
    async fn a_devtools_action_is_validated_with_its_tool_and_runs() {
        let rig = rig();
        let reply = run(&rig.service, json!({"action": "cookies", "operation": "list"})).await;
        assert_eq!(reply["ok"], true, "{reply}");
        assert_eq!(rig.commands.seen()[0].1, "cookies");
    }

    /// The runtime-only actions are not the tool's: nothing validates them, the runtime fields are taken off, and they go the way
    /// they went before.
    #[tokio::test]
    async fn the_runtime_only_actions_go_unvalidated() {
        let rig = rig();
        for action in RUNTIME_ONLY_ACTIONS {
            let reply = run(&rig.service, json!({"action": action, "session_id": "s1", "turn_id": 2, "request_id": "r1", "session_life": "x"})).await;
            assert_eq!(reply["ok"], true, "{action}: {reply}");
        }
        let seen = rig.commands.seen();
        assert_eq!(seen.len(), RUNTIME_ONLY_ACTIONS.len());
        assert!(seen.iter().all(|(session, _, input)| session == "s1" && *input == json!({"action": input["action"], "request_id": "r1"})));
    }

    #[tokio::test]
    async fn a_reply_and_a_failure_hide_the_secrets_of_the_session() {
        let rig = rig();
        rig.commands.answer(Ok(json!({"text": "typed hunter2", "image": {"mimeType": "image/png", "data": "AA=="}, "outcome": "ok"})));
        let reply = run(&rig.service, json!({"action": "read"})).await;
        assert_eq!(reply, json!({"ok": true, "value": {"text": "typed [secret]", "image": {"mimeType": "image/png", "data": "AA=="}, "outcome": "ok"}}));
        rig.commands.answer(Err(HostCommandError::Rpc { code: HOST_COMMAND_FAILED, message: "could not type hunter2 at https://a.example/?token=abcdef123456".to_owned(), timing: Some(json!({"commandMs": 2})) }));
        let failure = run(&rig.service, json!({"action": "read"})).await;
        assert_eq!(failure["ok"], false);
        let message = failure["error"].as_str().unwrap();
        assert!(message.contains("[secret]") && !message.contains("hunter2") && !message.contains("abcdef123456"), "{message}");
        assert_eq!(failure["timing"], json!({"commandMs": 2}));
    }

    #[tokio::test]
    async fn no_desktop_and_a_cancelled_command_read_as_the_bridge_worded_them() {
        let rig = rig();
        rig.commands.answer(Err(HostCommandError::NoHost));
        assert_eq!(run(&rig.service, json!({"action": "read"})).await, json!({"ok": false, "error": BROWSER_UNAVAILABLE}));
        rig.commands.answer(Err(HostCommandError::Rpc { code: HOST_COMMAND_FAILED, message: " ".to_owned(), timing: None }));
        assert_eq!(run(&rig.service, json!({"action": "read"})).await, json!({"ok": false, "error": "browser bridge request failed"}));
    }

    #[tokio::test]
    async fn the_engine_runs_a_command_of_the_contract_over_the_fake_host() {
        let engine_host = FakeHost::scripted(vec![listed("p1")]);
        let commands = rig_with(Commands::default(), true, engine_host);
        let engine = EngineHostCommands::new(ChannelHostCommands::new(commands.channel.clone()), commands.service.engine.clone(), commands.channel.clone());
        let service = BrowserBridgeRun::new(engine, commands.service.engine.clone(), commands.channel.clone(), Arc::new(Masks));
        let reply = run(&service, json!({"action": "list_tabs", "session_id": "s1", "turn_id": 3})).await;
        assert!(reply["value"]["text"].as_str().is_some_and(|text| text.contains("p1")), "{reply}");
        assert!(commands.channel.sent().is_empty(), "nothing went out as host/browser/command");
        commands.fake.finish().expect("the engine asked the host's lane once");
    }

    #[tokio::test]
    async fn the_turn_starts_and_ends_through_run_and_through_the_turn_method() {
        let rig = rig();
        for command in [json!({"action": "begin_turn", "session_id": "s1", "turn_id": 4}), json!({"action": "finish_turn", "session_id": "s1", "turn_id": 4, "aborted": true})] {
            let reply = run(&rig.service, command.clone()).await;
            assert_eq!(reply["ok"], true, "{command}: {reply}");
        }
        assert_eq!(turn(&rig.service, json!({"phase": "begin", "sessionId": "s1", "turnId": 4})).await, json!({"ok": true, "value": {"text": "Browser turn started."}}));
        assert_eq!(
            turn(&rig.service, json!({"phase": "finish", "sessionId": "s1", "turnId": 4})).await,
            json!({"ok": true, "value": {"text": "Browser task cleanup complete: 0 temporary page(s) closed."}})
        );
        assert!(rig.commands.seen().is_empty(), "the engine owns the turn's pages when the desktop serves it");
    }

    #[tokio::test]
    async fn a_turn_is_checked_as_the_bridge_checked_it() {
        let rig = rig();
        let bad = json!({"ok": false, "error": BAD_CLEANUP_CONTEXT});
        for command in [
            json!({"action": "begin_turn", "turn_id": 4}),
            json!({"action": "begin_turn", "session_id": "s1"}),
            json!({"action": "begin_turn", "session_id": "s1", "turn_id": "4"}),
            json!({"action": "finish_turn", "session_id": "s1", "turn_id": 0}),
            json!({"action": "finish_turn", "session_id": "s1", "turn_id": 1.5}),
            json!({"action": "finish_turn", "session_id": "s1", "turn_id": 2, "stray": 1}),
        ] {
            assert_eq!(run(&rig.service, command.clone()).await, bad, "{command}");
        }
        assert_eq!(turn(&rig.service, json!({"phase": "finish", "sessionId": "s1", "turnId": 0})).await, bad);
    }

    /// Without a desktop that serves the engine the turn marks go to the host as before.
    #[tokio::test]
    async fn a_desktop_that_runs_the_pages_itself_gets_the_turn_marks() {
        let rig = rig_with(Commands::default(), false, FakeHost::scripted(Vec::new()));
        turn(&rig.service, json!({"phase": "begin", "sessionId": "s1", "turnId": 4})).await;
        turn(&rig.service, json!({"phase": "finish", "sessionId": "s1", "turnId": 4, "aborted": true})).await;
        let seen = rig.commands.seen();
        assert_eq!(seen[0], ("s1".to_owned(), "begin_turn".to_owned(), json!({"turn_id": 4})));
        assert_eq!(seen[1], ("s1".to_owned(), "finish_turn".to_owned(), json!({"turn_id": 4, "aborted": true})));
    }

    /// A turn's end waits for the commands of its session that were running when it came.
    #[tokio::test]
    async fn a_turns_end_waits_for_the_running_commands_of_its_session() {
        let rig = rig_with(Commands { hold_action: Some("read"), ..Commands::default() }, true, FakeHost::scripted(Vec::new()));
        let service = rig.service.clone();
        let running = tokio::spawn(async move { run(&service, json!({"action": "read", "session_id": "s1", "turn_id": 2})).await });
        rig.commands.started.take().await;
        let service = rig.service.clone();
        let ending = tokio::spawn(async move { turn(&service, json!({"phase": "finish", "sessionId": "s1", "turnId": 2})).await });
        // Another session's end does not wait.
        assert_eq!(turn(&rig.service, json!({"phase": "finish", "sessionId": "other", "turnId": 2})).await["ok"], true);
        tokio::task::yield_now().await;
        assert!(!ending.is_finished(), "the end waits for the read");
        rig.commands.release.add(1);
        assert_eq!(running.await.unwrap()["ok"], true);
        assert_eq!(ending.await.unwrap()["ok"], true);
    }

    #[tokio::test]
    async fn a_dropped_caller_and_an_abort_stop_the_command() {
        let rig = rig_with(Commands { hold_action: Some("read"), ..Commands::default() }, true, FakeHost::scripted(Vec::new()));
        let service = rig.service.clone();
        let running = tokio::spawn(async move { run_with(&service, "sig-1", json!({"action": "read", "session_id": "s1"}), CancellationToken::new()).await });
        rig.commands.started.take().await;
        assert_eq!(answer(&rig.service, call(BRIDGE_ABORT, json!({"signalId": "other"}), true, CancellationToken::new())).await, json!({"cancelled": 0}));
        assert_eq!(answer(&rig.service, call(BRIDGE_ABORT, json!({"signalId": "sig-1"}), true, CancellationToken::new())).await, json!({"cancelled": 1}));
        assert_eq!(running.await.unwrap(), json!({"ok": false, "error": COMMAND_CANCELLED}));
        let cancel = CancellationToken::new();
        let service = rig.service.clone();
        let token = cancel.clone();
        let running = tokio::spawn(async move { run_with(&service, "sig-2", json!({"action": "read"}), token).await });
        rig.commands.started.take().await;
        cancel.cancel();
        assert_eq!(running.await.unwrap()["error"], COMMAND_CANCELLED);
        assert!(locked(&rig.service.runs).is_empty());
    }

    #[tokio::test]
    async fn a_thirty_third_command_is_refused_and_an_invalid_request_is_a_400() {
        let rig = rig_with(Commands { hold_action: Some("read"), ..Commands::default() }, true, FakeHost::scripted(Vec::new()));
        let mut running = Vec::new();
        for n in 0..MAX_CONCURRENT {
            let service = rig.service.clone();
            running.push(tokio::spawn(async move { run_with(&service, &format!("sig-{n}"), json!({"action": "read"}), CancellationToken::new()).await }));
        }
        for _ in 0..MAX_CONCURRENT {
            rig.commands.started.take().await;
        }
        assert_eq!(run(&rig.service, json!({"action": "read"})).await, json!({"ok": false, "error": CAPACITY_REFUSAL, "status": 429}));
        for _ in 0..MAX_CONCURRENT {
            rig.commands.release.add(1);
        }
        for task in running {
            assert_eq!(task.await.unwrap()["ok"], true);
        }
        assert_eq!(run(&rig.service, json!("read")).await["status"], 400);
        let huge = json!({"action": "evaluate", "script": "x".repeat(MAX_REQUEST_BYTES)});
        assert_eq!(run(&rig.service, huge).await, json!({"ok": false, "error": "invalid request: request too large", "status": 400}));
    }

    // ---- BridgeApprovals ----

    struct Policy {
        approvals: Arc<BridgeApprovals>,
        inner: Arc<Inner>,
        store: Arc<MemoryGrantStore>,
        grants: Arc<SessionGrantRegistry>,
    }

    fn policy() -> Policy {
        let inner = Arc::new(Inner { asked: Mutex::default(), answer: ApprovalAnswer::Deny { reason: "the card".to_owned() } });
        let (store, grants) = (Arc::new(MemoryGrantStore::default()), SessionGrantRegistry::new());
        Policy { approvals: BridgeApprovals::new(inner.clone(), store.clone(), grants.clone()), inner, store, grants }
    }

    fn step(session: &str, kinds: &[BrowserApprovalRememberKind]) -> BrowserApprovalPrompt {
        BrowserApprovalPrompt {
            thread_id: Some(ThreadId::from(session)),
            action: "click".to_owned(),
            session_id: session.to_owned(),
            kinds: kinds.to_vec(),
            ..BrowserApprovalPrompt::default()
        }
    }

    fn unattended(session: &str, kinds: &[BrowserApprovalRememberKind], agent: &str) -> BrowserApprovalPrompt {
        BrowserApprovalPrompt { unattended: true, unattended_agent: agent.to_owned(), ..step(session, kinds) }
    }

    fn decisions(policy: &Policy) -> Vec<String> {
        policy.store.audit().into_iter().map(|row| row.decision).collect()
    }

    /// `approval-dialog.ts` for a schedule or webhook run: saving the routine was the grant, the owning bot's block and a payment
    /// are the only refusals, and an operator `confirm` still asks.
    #[tokio::test]
    async fn an_unattended_run_asks_nothing_but_what_its_owner_blocks() {
        let policy = policy();
        let allowed = |answer: Result<ApprovalAnswer, ToolError>| matches!(answer, Ok(ApprovalAnswer::Allow { remember: Remember::Once }));
        assert!(allowed(policy.approvals.ask(unattended("sess_task", &[Submit, Post], " marketer ")).await));
        assert!(allowed(policy.approvals.ask(unattended(MARKETER, &[Submit], "marketer")).await));
        assert_eq!(decisions(&policy), ["run-allowed", "run-allowed", "run-allowed"]);
        assert!(policy.inner.asked.lock().unwrap().is_empty(), "no card");

        let mut payment = unattended(MARKETER, &[Post], "marketer");
        payment.payment = true;
        assert_eq!(policy.approvals.ask(payment).await.unwrap_err().message_for_model, PAYMENT_IN_RUN);
        let mut confirmed_payment = unattended(MARKETER, &[Confirm], "marketer");
        confirmed_payment.payment = true;
        assert_eq!(policy.approvals.ask(confirmed_payment).await.unwrap_err().message_for_model, PAYMENT_IN_RUN, "a run's payment is refused before its confirm asks");
        let ownerless = policy.approvals.ask(unattended(MARKETER, &[Submit], "  ")).await.unwrap_err();
        assert_eq!(ownerless.message_for_model, NO_RUN_OWNER);

        policy.store.set_mode("marketer", &GrantKey::Kind(ActionKind::BrowserPost), PermissionMode::Block);
        let blocked = policy.approvals.ask(unattended("sess_task", &[Submit, Post], "marketer")).await.unwrap_err();
        assert_eq!(blocked.message_for_model, BLOCKED_BY_PERMISSION);
        assert!(decisions(&policy).ends_with(&["blocked".to_owned(), "blocked".to_owned()]));
        assert!(policy.inner.asked.lock().unwrap().is_empty());
    }

    #[tokio::test]
    async fn an_operator_confirm_in_a_run_asks_through_the_one_path() {
        let policy = policy();
        let answer = policy.approvals.ask(unattended(MARKETER, &[Confirm], "marketer")).await;
        assert_eq!(answer.unwrap(), ApprovalAnswer::Deny { reason: "the card".to_owned() });
        assert_eq!(policy.inner.asked.lock().unwrap().len(), 1);
    }

    /// The session's own allowance by the life mark the runtime sent: only for a bot's own session, every kind of the step, the same
    /// life, no payment, no block; anything else is the inner path's.
    #[tokio::test]
    async fn a_session_allowance_answers_only_under_its_life_mark() {
        let policy = policy();
        let grants = SessionGrants::of(policy.grants.clone(), MARKETER);
        assert!(grants.grant("marketer", &GrantKey::Kind(ActionKind::BrowserSubmit), "5:0"));
        assert!(grants.grant("marketer", &GrantKey::Kind(ActionKind::BrowserPost), "5:0"));
        let with_life = |kinds: &[BrowserApprovalRememberKind], life: &str| BrowserApprovalPrompt { session_life: life.to_owned(), ..step(MARKETER, kinds) };

        assert!(matches!(policy.approvals.ask(with_life(&[Submit, Post], "5:0")).await, Ok(ApprovalAnswer::Allow { .. })));
        assert_eq!(decisions(&policy), ["session-remembered", "session-remembered"]);
        assert!(policy.inner.asked.lock().unwrap().is_empty());

        for prompt in [
            with_life(&[Submit, Post], "6:0"),
            with_life(&[Submit, Post], ""),
            with_life(&[Submit, Confirm], "5:0"),
            BrowserApprovalPrompt { payment: true, ..with_life(&[Submit], "5:0") },
            BrowserApprovalPrompt { session_life: "5:0".to_owned(), ..step("sess_task", &[Submit]) },
            with_life(&[Upload], "5:0"),
        ] {
            assert!(matches!(policy.approvals.ask(prompt.clone()).await, Err(_) | Ok(ApprovalAnswer::Deny { .. })), "{prompt:?}");
        }
        assert_eq!(policy.inner.asked.lock().unwrap().len(), 6, "each of them was the inner path's");

        policy.store.set_mode("marketer", &GrantKey::Kind(ActionKind::BrowserPost), PermissionMode::Block);
        let before = policy.inner.asked.lock().unwrap().len();
        let _ = policy.approvals.ask(with_life(&[Submit, Post], "5:0")).await;
        assert_eq!(policy.inner.asked.lock().unwrap().len(), before + 1, "a block still wins over the allowance");
    }

    /// A step of a session the core hosts carries none of it: the inner path decides, unchanged.
    #[tokio::test]
    async fn a_core_hosted_step_is_the_inner_paths() {
        let policy = policy();
        let answer = policy.approvals.ask(step(MARKETER, &[Submit])).await.unwrap();
        assert_eq!(answer, ApprovalAnswer::Deny { reason: "the card".to_owned() });
        assert_eq!(policy.inner.asked.lock().unwrap().len(), 1);
        assert!(decisions(&policy).is_empty());
    }
}
