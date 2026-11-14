//! `computer/bridge/run` and `computer/bridge/abort` (desktop -> core): the desktop's loopback computer bridge, which the Node-hosted
//! runtime still talks to, runs each command it accepts through the computer service the core uses for its own sessions, with the
//! bridge's semantics (`computer/host/bridge-command-dispatch.ts`, `bridge-server-request.ts`, `bridge-server-contract.ts`):
//!
//! - a command is refused unless it is a public one (`assertPublicComputerRequest`: no internal session, no internal authority);
//! - at most 32 requests run at once (40 for lifecycle controls); one past that is answered `computer_capacity_exhausted`;
//! - the commands of one session run one at a time, in the order they came; `wait_for_user` and the lifecycle controls do not wait;
//! - a cancelled call (the caller's connection dropped, or `computer/bridge/abort`) ends its session's queued and running work and
//!   cleans the helper up, except for `wait_for_user` and the lifecycle controls;
//! - the runtime-only actions the bridge answers itself: `secret_bind`, `secret_input`, `turn_settle`, `session_abort`,
//!   `execution_end`, `session_release`, and the capture hold while a typed secret's field may hold focus;
//! - a saved-login fill is admitted only for a runtime owner whose connection is attached and whose turn has not settled; an owner is
//!   bound to its process (id and creation time), and its protection retires early only when the OS proves that process ended
//!   (the helper's `process_fate`), never because a connection closed;
//! - every reply is redacted of the secrets typed in its session, a saved-login fill's reply carries no image, and a reply is held
//!   to the bridge's size limits.
//!
//! The command is the bridge's wire shape (the helper's vocabulary plus `session_id`, `turn_id`, `runtime_id`). The ones the tool
//! has an action for (`list_windows`, `capture`, `sequence`, `fill_saved_login`, ...) run through the session's backend, the same
//! pipeline a model's `computer` call takes; the helper's own commands (`click`, `type`, `find`, `window_bounds`, ...) run through the
//! session's helper as a handed-off secret's steps do.
//!
//! Two internal actions carry the owner connection of the HTTP bridge's `/owner` endpoint, which the desktop keeps: `owner_attach`
//! (`runtime_id`, `pid`) binds the owner to its process and `owner_detach` (`runtime_id`) ends one connection of it. The answer is
//! `{ok: true, value: {text, image?}}`, or `{ok: false, error, status?}` where `status` is the HTTP status the bridge answered (400
//! for an invalid request, 429 for the allowance spent).

use std::collections::HashMap;
use std::collections::HashSet;
use std::sync::Arc;
use std::sync::Mutex;
use std::sync::MutexGuard;
use std::sync::PoisonError;
use std::sync::atomic::AtomicBool;
use std::sync::atomic::AtomicU64;
use std::sync::atomic::AtomicUsize;
use std::sync::atomic::Ordering;

use async_trait::async_trait;
use base64::Engine;
use mixdog_core_api::CoreError;
use mixdog_core_api::CoreRequest;
use mixdog_core_api::DomainService;
use mixdog_core_api::Reply;
use mixdog_core_api::domain::computer::ComputerAction;
use mixdog_core_api::domain::computer::ComputerBackend;
use mixdog_core_api::domain::computer::ComputerError;
use mixdog_core_api::domain::computer::ComputerRequest;
use mixdog_core_api::domain::tool::ImageData;
use mixdog_core_api::domain::tool::ToolPart;
use mixdog_core_api::ids::ConnectionId;
use mixdog_core_api::ids::Method;
use mixdog_core_api::service::Admit;
use mixdog_js::utf16_len;
use serde::Deserialize;
use serde_json::Map;
use serde_json::Value;
use serde_json::json;
use tokio::sync::OwnedMutexGuard;
use tokio_util::sync::CancellationToken;

use super::computer_backend::HOST_READ_ACTIONS;
use super::computer_backend::error_text;
use super::computer_pixels::ComputerBlobs;
use super::computer_reply;

pub const BRIDGE_RUN: &str = "computer/bridge/run";
pub const BRIDGE_ABORT: &str = "computer/bridge/abort";

/// What a command past the allowance is refused with (`CAPACITY_REFUSAL`), the HTTP bridge's 429.
pub const CAPACITY_REFUSAL: &str = "computer_capacity_exhausted: too many active requests";

/// The session the helper's `process_fate` read runs under (`HOST_WARMUP_SESSION_ID`: no caller owns it).
const FATE_SESSION: &str = "__computer_host_warmup__";
/// Sessions only the desktop itself uses; a bridge caller never names them (`common.ts`).
const INTERNAL_SESSIONS: [&str; 4] = ["__mixdog_browser_chrome_setup__", "__computer_host_warmup__", "__computer_user_wait__", "__computer_window_arrivals__"];
/// Authority only the host's own queue grants (`assertPublicComputerRequest`).
const INTERNAL_AUTHORITY: [&str; 7] = [
    "known_injection_tick",
    "authorization_expires_at",
    "authorization_window_id",
    "authorization_pid",
    "expected_input_tick",
    "expected_input_monitor_id",
    "expected_input_user_sequence",
];

/// `computerActionsWith('autoCapture')`: the commands that act and then look.
const AUTO_CAPTURE_ACTIONS: [&str; 24] = [
    "invoke",
    "set_value",
    "toggle",
    "click",
    "double_click",
    "right_click",
    "middle_click",
    "triple_click",
    "mouse_down",
    "mouse_up",
    "mouse_move",
    "drag",
    "type",
    "key",
    "key_down",
    "key_up",
    "scroll",
    "focus_window",
    "move_window",
    "window_state",
    "close_window",
    "terminate_process",
    "launch",
    "invoke_menu",
];
/// `computerActionsWith('lifecycle')`.
const LIFECYCLE_ACTIONS: [&str; 4] = ["execution_end", "session_release", "session_abort", "turn_settle"];
/// The commands a bridge caller may name besides the three sets above.
const OTHER_PUBLIC_ACTIONS: [&str; 6] = ["sequence", "diagnose", "clipboard_write", "secret_bind", "secret_input", "fill_saved_login"];
/// The two actions of the owner connection (internal to the desktop's bridge).
const OWNER_ATTACH: &str = "owner_attach";
const OWNER_DETACH: &str = "owner_detach";

const ORDINARY_CAPACITY: usize = 32;
const LIFECYCLE_CAPACITY: usize = 40;
/// `MAX_COMPUTER_RESPONSE_BYTES`, `MAX_COMPUTER_TEXT_CHARS`, `MAX_COMPUTER_IMAGE_CHARS`.
const MAX_RESPONSE_BYTES: usize = 32 * 1024 * 1024;
const MAX_TEXT_CHARS: usize = 1_000_000;
const MAX_IMAGE_CHARS: usize = 24 * 1024 * 1024;

const ABORTED_RUNNING: &str = "computer_session_aborted: command stopped by session cancellation";
const ABORTED_QUEUED: &str = "computer_session_aborted: queued command was cancelled before execution";
const FOCUS_HELD: &str = "capture_withheld: a secret field may be focused; move focus (Tab or a click elsewhere) first";

/// What the bridge reaches of the computer sessions of the process.
#[async_trait]
pub trait BridgeHost: Send + Sync {
    /// The session's backend (the model's `computer` call runs through it).
    fn backend(&self, session: &str) -> Arc<dyn ComputerBackend>;
    /// One helper command of the session, run to its reply; `Err` is the helper's error text.
    async fn helper(&self, session: &str, command: Map<String, Value>) -> Result<Map<String, Value>, String>;
    /// Whether the session has a helper now.
    fn has_helper(&self, session: &str) -> bool;
    /// `abortComputerSession`: the helper is stopped and its input cleaned up; whether the cleanup confirmed.
    async fn abort(&self, session: &str) -> bool;
    /// `endComputerExecution`.
    async fn end_execution(&self, session: &str) -> bool;
    /// `releaseComputerSession`.
    async fn release(&self, session: &str) -> bool;
}

/// What the bridge reaches of the secrets typed through the session.
#[async_trait]
pub trait BridgeSecrets: Send + Sync {
    /// `bindComputerSecret`: `bound` or `no_field`.
    fn bind(&self, session: &str, request_id: &str, window_id: &str, reference: &str) -> String;
    /// `typeComputerSecret`: the outcome word (`entered`, `no_field`, `page_changed`, `blocked`, `expired`).
    async fn input(&self, session: &str, request_id: &str, window_id: &str, reference: &str) -> String;
    /// `secretInputs.redact`: the text with every secret of the session and every saved-login password hidden.
    fn redact(&self, session: &str, text: &str) -> String;
    /// A typed secret's field may hold focus: no capture leaves until focus moves.
    fn focus_armed(&self, session: &str) -> bool;
    /// The next input action (which moves on) lifts the hold.
    fn clear_focus(&self, session: &str);
}

/// What the bridge reaches of the saved-login registry.
#[async_trait]
pub trait BridgeSavedLogins: Send + Sync {
    /// A fill of the session's agent turn `turn` starts: the guard to drop when it has ended, or why it is refused.
    fn admit(&self, session: &str, turn: u64) -> Result<Box<dyn Send>, String>;
    /// The turn settled (or its owner is proven gone): the password redaction and pixel guards its fills set up retire.
    async fn settle(&self, session: &str, turn: u64);
}

/// The agent turn of the saved-login fill running in each session: the fill is scoped to the runtime's own turn number, which the
/// command named, not to a count the core keeps. The composition's turn source reads it before its own.
#[derive(Default)]
pub struct FillTurns(Mutex<HashMap<String, u64>>);

impl FillTurns {
    pub fn current(&self, session: &str) -> Option<u64> {
        locked(&self.0).get(session).copied()
    }

    fn begin(&self, session: &str, turn: u64) {
        locked(&self.0).insert(session.to_owned(), turn);
    }

    fn end(&self, session: &str) {
        locked(&self.0).remove(session);
    }
}

fn locked<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(PoisonError::into_inner)
}

/// `Number(value)` as a safe integer of at least 1.
fn safe_turn(value: Option<&Value>) -> Option<u64> {
    let number = match value? {
        Value::Number(number) => number.as_f64()?,
        Value::String(text) => mixdog_js::js_trim(text).parse::<f64>().ok()?,
        _ => return None,
    };
    (number.fract() == 0.0 && (1.0..=9_007_199_254_740_991.0).contains(&number)).then_some(number as u64)
}

fn text_field<'a>(command: &'a Map<String, Value>, key: &str) -> &'a str {
    command.get(key).and_then(Value::as_str).unwrap_or_default()
}

/// An owner id as the runtime mints it (`/^[0-9a-f-]{36}$/`).
fn is_owner_id(id: &str) -> bool {
    id.len() == 36 && id.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b) || b == b'-')
}

/// The OS's answer about one process: `unknown` is never read as ended.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum Fate {
    Running,
    Ended,
    Unknown,
}

#[derive(Clone)]
struct Owner {
    pid: u64,
    created: String,
    connections: usize,
}

/// The runtime owners of the saved-login fills (`createSavedLoginRegistry`: the owner half): each is bound to its process, a fill is
/// admitted only while one of its connections is attached and its turn has not settled, and an owner the OS proved gone is never
/// admitted again.
#[derive(Default)]
struct Owners {
    owners: HashMap<String, Owner>,
    gone: HashSet<String>,
    /// Per owner and session, the newest turn settled: no fill of it or an older turn is admitted again.
    settled: HashMap<(String, String), u64>,
    /// Per owner and session, the newest turn a fill was admitted for: what retires with a proven end.
    admitted: HashMap<(String, String), u64>,
}

impl Owners {
    /// One connection of `owner`, bound to the process; false when the owner was proven ended, the id or process is not valid, or
    /// the id is already bound to another process.
    fn attach(&mut self, owner: &str, pid: u64, created: &str) -> bool {
        if !is_owner_id(owner) || self.gone.contains(owner) || pid < 1 || !created.starts_with(|c: char| ('1'..='9').contains(&c)) || !created.bytes().all(|b| b.is_ascii_digit()) {
            return false;
        }
        if self.owners.get(owner).is_some_and(|known| known.pid != pid || known.created != created) {
            return false;
        }
        self.owners.entry(owner.to_owned()).or_insert_with(|| Owner { pid, created: created.to_owned(), connections: 0 }).connections += 1;
        true
    }

    fn detach(&mut self, owner: &str) {
        if let Some(known) = self.owners.get_mut(owner) {
            known.connections = known.connections.saturating_sub(1);
        }
    }

    /// The reason a fill is refused, or nothing when it may run; a fill that may run is remembered as the owner's newest.
    fn admit(&mut self, owner: &str, session: &str, turn: Option<u64>) -> Result<u64, &'static str> {
        let Some(turn) = turn.filter(|_| !session.is_empty() && is_owner_id(owner)) else {
            return Err("the request names no runtime owner and agent turn to scope its protection to");
        };
        if self.owners.get(owner).is_none_or(|known| known.connections == 0) {
            return Err("this runtime holds no owner connection to the bridge");
        }
        let key = (owner.to_owned(), session.to_owned());
        if turn <= self.settled.get(&key).copied().unwrap_or(0) {
            return Err("its agent turn has already ended");
        }
        let newest = self.admitted.entry(key).or_insert(0);
        *newest = (*newest).max(turn);
        Ok(turn)
    }

    /// `markSettled`: the newest turn of the owner's session that is settled, `turn` included.
    fn settle(&mut self, owner: &str, session: &str, turn: u64) -> u64 {
        let through = self.settled.entry((owner.to_owned(), session.to_owned())).or_insert(0);
        *through = (*through).max(turn);
        *through
    }

    /// The owners with no attached connection, as their processes were bound.
    fn detached(&self) -> Vec<(String, Owner)> {
        self.owners.iter().filter(|(_, owner)| owner.connections == 0).map(|(id, owner)| (id.clone(), owner.clone())).collect()
    }

    /// The OS proved the owner's process ended: it is never admitted again, and the newest turn of each of its sessions is what
    /// retires. Refused while a connection is attached.
    fn retire(&mut self, owner: &str) -> Option<Vec<(String, u64)>> {
        if self.owners.get(owner).is_none_or(|known| known.connections > 0) {
            return None;
        }
        self.owners.remove(owner);
        self.gone.insert(owner.to_owned());
        self.settled.retain(|(id, _), _| id != owner);
        let admitted: Vec<((String, String), u64)> = self.admitted.iter().filter(|((id, _), _)| id == owner).map(|(key, turn)| (key.clone(), *turn)).collect();
        self.admitted.retain(|(id, _), _| id != owner);
        Some(admitted.into_iter().map(|((_, session), turn)| (session, turn)).collect())
    }

    /// The session ended: every turn of it an owner admitted a fill for is settled at once.
    fn forget(&mut self, session: &str) -> Vec<u64> {
        let admitted: Vec<((String, String), u64)> = self.admitted.iter().filter(|((_, s), _)| s == session).map(|(key, turn)| (key.clone(), *turn)).collect();
        admitted
            .into_iter()
            .map(|((owner, session), turn)| {
                self.settle(&owner, &session, turn);
                turn
            })
            .collect()
    }
}

/// One call of `computer/bridge/run` that has not ended: what `computer/bridge/abort` reaches.
struct Run {
    id: u64,
    session: String,
    signal: String,
    cancel: CancellationToken,
    /// An abort of the whole session is cleaning the helper up: this run does not.
    covered: Arc<AtomicBool>,
    /// Neither `wait_for_user` nor a lifecycle control: the work a dropped caller's session abort cancels (`queue.cancelSession`).
    ordinary: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RunParams {
    command: Value,
    session_key: String,
    signal_id: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct AbortParams {
    session_key: String,
    #[serde(default)]
    signal_id: Option<String>,
}

/// A reply before it is sealed: the text, and the image as the bridge puts it on the wire.
struct Answer {
    text: String,
    image: Option<(String, String)>,
}

impl Answer {
    fn text(text: impl Into<String>) -> Self {
        Self { text: text.into(), image: None }
    }
}

type Outcome = Result<Answer, String>;

/// Ends a request's count in the allowance and, for a saved-login fill, its admission, however the request ends.
struct Admitted<'a> {
    service: &'a ComputerBridgeRun,
    _fill: Option<Box<dyn Send>>,
}

impl Drop for Admitted<'_> {
    fn drop(&mut self) {
        self.service.active.fetch_sub(1, Ordering::SeqCst);
    }
}

pub struct ComputerBridgeRun {
    host: Arc<dyn BridgeHost>,
    secrets: Arc<dyn BridgeSecrets>,
    saved: Arc<dyn BridgeSavedLogins>,
    blobs: Option<Arc<dyn ComputerBlobs>>,
    fill_turns: Arc<FillTurns>,
    owners: Arc<Mutex<Owners>>,
    queues: Mutex<HashMap<String, Arc<tokio::sync::Mutex<()>>>>,
    runs: Mutex<Vec<Run>>,
    next_run: AtomicU64,
    active: AtomicUsize,
}

impl ComputerBridgeRun {
    pub fn new(
        host: Arc<dyn BridgeHost>,
        secrets: Arc<dyn BridgeSecrets>,
        saved: Arc<dyn BridgeSavedLogins>,
        blobs: Option<Arc<dyn ComputerBlobs>>,
        fill_turns: Arc<FillTurns>,
    ) -> Self {
        Self { host, secrets, saved, blobs, fill_turns, owners: Arc::default(), queues: Mutex::default(), runs: Mutex::default(), next_run: AtomicU64::new(1), active: AtomicUsize::new(0) }
    }

    /// `assertPublicComputerRequest`: why the command is not a public one.
    fn assert_public(command: &Value) -> Result<&Map<String, Value>, String> {
        let Some(command) = command.as_object() else {
            return Err("invalid_request: computer command must be an object".into());
        };
        if INTERNAL_SESSIONS.contains(&text_field(command, "session_id")) || INTERNAL_AUTHORITY.iter().any(|field| command.contains_key(*field)) {
            return Err("computer_policy_denied: internal execution authority cannot be supplied by a bridge caller".into());
        }
        let action = text_field(command, "action");
        let public = HOST_READ_ACTIONS.contains(&action)
            || AUTO_CAPTURE_ACTIONS.contains(&action)
            || OTHER_PUBLIC_ACTIONS.contains(&action)
            || LIFECYCLE_ACTIONS.contains(&action)
            || [OWNER_ATTACH, OWNER_DETACH].contains(&action);
        if public { Ok(command) } else { Err("invalid_action: computer bridge action is not available".into()) }
    }

    async fn run(&self, req: &CoreRequest) -> Result<Value, CoreError> {
        if !req.ctx.host_claimant {
            return Err(CoreError::PermissionDenied { method: BRIDGE_RUN.into(), origin: req.ctx.origin });
        }
        let params: RunParams = decode(req)?;
        if params.session_key.is_empty() || params.signal_id.is_empty() {
            return Err(CoreError::InvalidParams { path: "params".into(), expected: "a sessionKey and a signalId".into() });
        }
        let command = match Self::assert_public(&params.command) {
            Ok(command) => command,
            Err(message) => return Ok(refusal(&format!("invalid request: {message}"), 400)),
        };
        let session = params.session_key.as_str();
        let action = text_field(command, "action");
        let lifecycle = LIFECYCLE_ACTIONS.contains(&action);
        let ordinary = action != "wait_for_user" && !lifecycle;
        let capacity = if lifecycle { LIFECYCLE_CAPACITY } else { ORDINARY_CAPACITY };
        if self.active.load(Ordering::SeqCst) >= capacity {
            return Ok(refusal(CAPACITY_REFUSAL, 429));
        }
        // A saved-login fill counts as running from the moment it is accepted, before any queueing or target preparation, so its
        // turn's settlement waits for it; one of a settled turn or an absent owner is refused here.
        let fill = match self.admit_fill(command, session) {
            Ok(fill) => fill,
            Err(reason) => return Ok(refusal(&format!("saved_login_unavailable: {reason}; no input was sent"), 200)),
        };
        self.active.fetch_add(1, Ordering::SeqCst);
        let _admitted = Admitted { service: self, _fill: fill };
        let cancel = req.ctx.cancel.child_token();
        let covered = Arc::new(AtomicBool::new(false));
        let id = self.next_run.fetch_add(1, Ordering::SeqCst);
        locked(&self.runs).push(Run { id, session: session.to_owned(), signal: params.signal_id.clone(), cancel: cancel.clone(), covered: covered.clone(), ordinary });
        let outcome = self.dispatch(session, command, &cancel).await;
        locked(&self.runs).retain(|run| run.id != id);
        self.trim_queue(session);
        // A dropped connection is the only cancellation signal left when the runtime dies before it can send `session_abort`: the
        // session's input stops here, but a wait for the user and the lifecycle controls leave it be.
        if cancel.is_cancelled() && ordinary && !covered.load(Ordering::SeqCst) {
            // The session's other queued and running work ends with it (`queue.cancelSession`); this abort is their one cleanup.
            for run in locked(&self.runs).iter().filter(|run| run.session == session && run.ordinary) {
                run.covered.store(true, Ordering::SeqCst);
                run.cancel.cancel();
            }
            let _confirmed = self.host.abort(session).await;
        }
        Ok(self.seal(session, command, outcome).await)
    }

    /// The saved-login fill's admission: the guard that ends it. Any other command is not a fill.
    fn admit_fill(&self, command: &Map<String, Value>, session: &str) -> Result<Option<Box<dyn Send>>, String> {
        if text_field(command, "action") != "fill_saved_login" {
            return Ok(None);
        }
        let owner = text_field(command, "runtime_id");
        let turn = locked(&self.owners).admit(owner, session, safe_turn(command.get("turn_id"))).map_err(str::to_owned)?;
        self.saved.admit(session, turn).map(Some)
    }

    /// One command to its outcome (`dispatchBridgeCommand`).
    async fn dispatch(&self, session: &str, command: &Map<String, Value>, cancel: &CancellationToken) -> Outcome {
        let action = text_field(command, "action");
        match action {
            "wait_for_user" => return self.execute(session, command, cancel).await,
            OWNER_ATTACH => return self.attach_owner(command).await,
            OWNER_DETACH => {
                locked(&self.owners).detach(text_field(command, "runtime_id"));
                self.reconcile_owners().await;
                return Ok(Answer::text("detached"));
            }
            // Runtime-only: bind a secret request to its window and field at request time, then type the secret the user handed the
            // desktop.
            "secret_bind" => {
                return Ok(Answer::text(self.secrets.bind(session, text_field(command, "request_id"), text_field(command, "window_id"), text_field(command, "ref"))));
            }
            "secret_input" => {
                let _turn = self.queued(session, cancel).await?;
                return Ok(Answer::text(self.secrets.input(session, text_field(command, "request_id"), text_field(command, "window_id"), text_field(command, "ref")).await));
            }
            _ => {}
        }
        // While a typed secret's field may hold focus, no capture leaves the host: a read is refused, and the next input action (which
        // moves on) lifts the hold.
        if self.secrets.focus_armed(session) {
            if HOST_READ_ACTIONS.contains(&action) {
                return Err(FOCUS_HELD.into());
            }
            if !LIFECYCLE_ACTIONS.contains(&action) {
                self.secrets.clear_focus(session);
            }
        }
        match action {
            "turn_settle" => self.settle_turn(session, command),
            "session_abort" => self.abort_session(session).await,
            "execution_end" => {
                let _ended = self.host.end_execution(session).await;
                Ok(Answer::text("computer execution ended"))
            }
            "session_release" => {
                // `releaseComputerSession` ends in the abort, whose unconfirmed cleanup fails it (a session that never reached the helper
                // has nothing to confirm).
                let had_helper = self.host.has_helper(session);
                let released = self.host.release(session).await;
                self.forget_session(session).await;
                if !released && had_helper {
                    return Err("computer_abort_cleanup_unconfirmed: input cleanup did not finish successfully".into());
                }
                Ok(Answer::text("computer session released"))
            }
            _ => {
                let _turn = self.queued(session, cancel).await?;
                if reads_pixels(action) {
                    self.reconcile_owners().await;
                }
                // The fill is scoped to the runtime's own turn number, for as long as it runs.
                let fill_turn = (action == "fill_saved_login").then(|| safe_turn(command.get("turn_id"))).flatten();
                if let Some(turn) = fill_turn {
                    self.fill_turns.begin(session, turn);
                }
                let outcome = self.execute(session, command, cancel).await;
                if fill_turn.is_some() {
                    self.fill_turns.end(session);
                }
                outcome
            }
        }
    }

    /// The session's turn at the queue: one command of a session runs at a time, in the order they came. A cancelled wait is the
    /// command cancelled before it ran.
    async fn queued(&self, session: &str, cancel: &CancellationToken) -> Result<OwnedMutexGuard<()>, String> {
        let queue = locked(&self.queues).entry(session.to_owned()).or_default().clone();
        // Cancellation first: a command cancelled while the one before it ended never runs.
        tokio::select! {
            biased;
            () = cancel.cancelled() => Err(ABORTED_QUEUED.to_owned()),
            guard = queue.lock_owned() => Ok(guard),
        }
    }

    /// A session nothing waits for or runs in leaves the table.
    fn trim_queue(&self, session: &str) {
        let mut queues = locked(&self.queues);
        if queues.get(session).is_some_and(|queue| Arc::strong_count(queue) == 1) {
            queues.remove(session);
        }
    }

    /// The command through the tool's action when it has one, else through the session's helper.
    async fn execute(&self, session: &str, command: &Map<String, Value>, cancel: &CancellationToken) -> Outcome {
        match tool_request(command) {
            Some(request) => match self.host.backend(session).run(request, cancel.clone()).await {
                Ok(parts) => self.parts(parts).await,
                Err(error) => Err(failure_text(&error)),
            },
            None => {
                let mut raw = command.clone();
                for key in ["session_id", "turn_id", "runtime_id"] {
                    raw.remove(key);
                }
                let action = text_field(command, "action").to_owned();
                let reply = tokio::select! {
                    reply = self.host.helper(session, raw) => reply,
                    () = cancel.cancelled() => Err(ABORTED_RUNNING.to_owned()),
                }?;
                let parts = computer_reply::single(&action, &reply).map_err(|error| failure_text(&error))?;
                self.parts(parts).await
            }
        }
    }

    /// The reply parts of the tool as the bridge's one text and one image.
    async fn parts(&self, parts: Vec<ToolPart>) -> Outcome {
        let mut texts = Vec::new();
        let mut image = None;
        for part in parts {
            match part {
                ToolPart::Text(text) => texts.push(text),
                ToolPart::Json(value) => texts.push(value.to_string()),
                ToolPart::Image { mime, data, .. } if image.is_none() => {
                    let bytes = match data {
                        ImageData::Bytes(bytes) => bytes,
                        ImageData::Blob(digest) => match &self.blobs {
                            Some(blobs) => blobs.read(digest.as_str()).await.map_err(|error| failure_text(&error))?,
                            None => return Err("computer bridge returned an invalid or oversized image".into()),
                        },
                    };
                    image = Some((mime, base64::engine::general_purpose::STANDARD.encode(bytes)));
                }
                ToolPart::Image { .. } | ToolPart::Document { .. } => {}
            }
        }
        Ok(Answer { text: texts.join("\n"), image })
    }

    /// The runtime's authoritative settlement of one agent turn (`settleTurn`): no fill of that turn (or an older one of the session)
    /// is admitted from here on, and the saved-login protection they set up retires once those still running have finished. Input
    /// cleanup never retires it.
    fn settle_turn(&self, session: &str, command: &Map<String, Value>) -> Outcome {
        let owner = text_field(command, "runtime_id");
        let Some(turn) = safe_turn(command.get("turn_id")).filter(|_| !session.is_empty() && !owner.is_empty()) else {
            return Err("invalid_request: turn_settle needs a session_id, a positive turn_id and a runtime_id".into());
        };
        if is_owner_id(owner) {
            let through = locked(&self.owners).settle(owner, session, turn);
            let (saved, session) = (self.saved.clone(), session.to_owned());
            drop(tokio::spawn(async move { saved.settle(&session, through).await }));
        }
        Ok(Answer::text("turn settlement accepted"))
    }

    /// `abortComputerSession` of a cancelled turn, which never sends `execution_end`, so its visible execution and any pause it held
    /// end here too.
    async fn abort_session(&self, session: &str) -> Outcome {
        let had_helper = self.host.has_helper(session);
        for run in locked(&self.runs).iter().filter(|run| run.session == session) {
            run.covered.store(true, Ordering::SeqCst);
            run.cancel.cancel();
        }
        let confirmed = self.host.abort(session).await;
        let _ended = self.host.end_execution(session).await;
        if !confirmed && had_helper {
            return Err("computer_abort_cleanup_unconfirmed: input cleanup did not finish successfully".into());
        }
        Ok(Answer::text("computer session aborted; input state and session resources were released"))
    }

    /// The session ended: every turn of it a fill was admitted for is settled at once.
    async fn forget_session(&self, session: &str) {
        let turns = locked(&self.owners).forget(session);
        if let Some(turn) = turns.into_iter().max() {
            self.saved.settle(session, turn).await;
        }
    }

    /// One owner connection of the runtime: its process is bound by id and OS creation time (`handleOwner`), then the connection is
    /// held by the desktop. Refused when the process is not running or the owner is unknown.
    async fn attach_owner(&self, command: &Map<String, Value>) -> Outcome {
        let owner = text_field(command, "runtime_id");
        let pid = command.get("pid").and_then(Value::as_u64).filter(|pid| *pid > 0);
        let created = match pid {
            Some(pid) => match self.fate(pid, "").await {
                (Fate::Running, created) => created,
                _ => String::new(),
            },
            None => String::new(),
        };
        let attached = pid.is_some_and(|pid| locked(&self.owners).attach(owner, pid, &created));
        if !attached {
            return Err("invalid request: unknown or ended runtime owner".into());
        }
        self.reconcile_owners().await;
        Ok(Answer::text("attached"))
    }

    /// The OS's answer about a process (the helper's `process_fate`): `created` is its creation time when it could be read.
    async fn fate(&self, pid: u64, created: &str) -> (Fate, String) {
        let command = json!({ "action": "process_fate", "pid": pid, "created": created }).as_object().cloned().unwrap_or_default();
        let Ok(reply) = self.host.helper(FATE_SESSION, command).await else { return (Fate::Unknown, String::new()) };
        let state = match reply.get("state").and_then(Value::as_str) {
            Some("running") => Fate::Running,
            Some("ended") => Fate::Ended,
            _ => Fate::Unknown,
        };
        let created = match reply.get("created") {
            Some(Value::String(text)) => text.clone(),
            Some(Value::Number(number)) => number.to_string(),
            _ => String::new(),
        };
        (state, created)
    }

    /// `reconcileSavedLoginOwners`: the protection of every owner with no attached connection whose process the OS proves ended
    /// retires. An unknown answer keeps everything.
    async fn reconcile_owners(&self) {
        let detached = locked(&self.owners).detached();
        for (owner, process) in detached {
            if self.fate(process.pid, &process.created).await.0 != Fate::Ended {
                continue;
            }
            let retired = locked(&self.owners).retire(&owner);
            for (session, turn) in retired.into_iter().flatten() {
                self.saved.settle(&session, turn).await;
            }
        }
    }

    /// The reply that leaves the bridge, or the redacted message of why it failed (`answerPublicCommand`): a secret typed in the
    /// session never comes back in either, nor do the pixels of a field a saved login was typed into.
    async fn seal(&self, session: &str, command: &Map<String, Value>, outcome: Outcome) -> Value {
        let action = text_field(command, "action");
        let sealed = outcome.and_then(|mut answer| {
            answer.text = self.secrets.redact(session, &answer.text);
            if action == "fill_saved_login" {
                answer.image = None;
            }
            let oversized = |what: &str| format!("computer bridge returned {what}");
            if utf16_len(&answer.text) > MAX_TEXT_CHARS {
                return Err(oversized("invalid or oversized text"));
            }
            if let Some((mime, data)) = &answer.image
                && (data.len() > MAX_IMAGE_CHARS || !["image/jpeg", "image/png"].contains(&mime.as_str()))
            {
                return Err(oversized("an invalid or oversized image"));
            }
            let mut value = json!({ "text": answer.text });
            if let Some((mime, data)) = answer.image {
                value["image"] = json!({ "data": data, "mimeType": mime });
            }
            if value.to_string().len() > MAX_RESPONSE_BYTES {
                return Err("computer response exceeds byte limit; input may have executed and was not replayed".into());
            }
            Ok(value)
        });
        match sealed {
            Ok(value) => json!({ "ok": true, "value": value }),
            // Errors are model-bound too: a remembered secret never comes back in one.
            Err(message) => json!({ "ok": false, "error": self.secrets.redact(session, &message) }),
        }
    }

    /// `computer/bridge/abort`: the call named by `signalId` is cancelled (the caller's connection dropped), or, without one, the
    /// whole session is aborted (`session_abort`). The answer says how many calls were cancelled and whether the helper's cleanup
    /// confirmed.
    async fn abort(&self, req: &CoreRequest) -> Result<Value, CoreError> {
        if !req.ctx.host_claimant {
            return Err(CoreError::PermissionDenied { method: BRIDGE_ABORT.into(), origin: req.ctx.origin });
        }
        let params: AbortParams = decode(req)?;
        if params.session_key.is_empty() {
            return Err(CoreError::InvalidParams { path: "params/sessionKey".into(), expected: "a session id".into() });
        }
        let Some(signal) = params.signal_id else {
            let cancelled = locked(&self.runs).iter().filter(|run| run.session == params.session_key).count();
            let outcome = self.abort_session(&params.session_key).await;
            return Ok(json!({ "ok": outcome.is_ok(), "cancelled": cancelled }));
        };
        let runs = locked(&self.runs);
        let mut cancelled = 0;
        for run in runs.iter().filter(|run| run.session == params.session_key && run.signal == signal) {
            run.cancel.cancel();
            cancelled += 1;
        }
        Ok(json!({ "ok": true, "cancelled": cancelled }))
    }
}

/// A command that reads pixels looks at the detached owners' fate first: a runtime that died after its connection dropped never
/// leaves a guard stuck.
fn reads_pixels(action: &str) -> bool {
    ["capture", "zoom", "screenshot"].contains(&action)
}

fn decode<T: serde::de::DeserializeOwned>(req: &CoreRequest) -> Result<T, CoreError> {
    serde_json::from_value(req.params.clone()).map_err(|error| CoreError::InvalidParams { path: "params".into(), expected: error.to_string().into() })
}

fn refusal(message: &str, status: u16) -> Value {
    let mut answer = json!({ "ok": false, "error": message });
    if status != 200 {
        answer["status"] = json!(status);
    }
    answer
}

/// The words of a failure as the bridge answered them.
fn failure_text(error: &ComputerError) -> String {
    match error {
        ComputerError::Cancelled => ABORTED_RUNNING.to_owned(),
        other => error_text(other),
    }
}

/// The tool's action the bridge command is, with its `input`; `None` for a command only the helper knows. The inverse of
/// `host_command` (`toComputerHostCommand`), which the tool's call goes through to become the command again.
fn tool_request(command: &Map<String, Value>) -> Option<ComputerRequest> {
    let mut input = command.clone();
    let action = input.remove("action")?;
    for key in ["session_id", "turn_id", "runtime_id"] {
        input.remove(key);
    }
    let set = |input: &mut Map<String, Value>, key: &str, value: &str| {
        input.insert(key.into(), json!(value));
    };
    let tool = match action.as_str()? {
        "list_windows" => ComputerAction::List,
        "list_apps" => {
            set(&mut input, "kind", "apps");
            ComputerAction::List
        }
        "list_history" => {
            set(&mut input, "kind", "history");
            ComputerAction::List
        }
        "capture" => ComputerAction::Capture,
        "zoom" => {
            set(&mut input, "mode", "zoom");
            ComputerAction::Capture
        }
        "verify" => ComputerAction::Verify,
        "diagnose" => ComputerAction::Diagnose,
        "wait_for_user" => ComputerAction::WaitForUser,
        "sequence" => {
            if let Some(Value::Array(steps)) = input.remove("steps") {
                input.insert("actions".into(), Value::Array(steps.into_iter().map(tool_step).collect()));
            }
            if let Some(mode) = input.remove("capture_after_mode") {
                input.insert("observe".into(), mode);
            }
            ComputerAction::Act
        }
        "invoke_menu" => ComputerAction::Menu,
        "focus_window" | "move_window" | "close_window" | "terminate_process" => {
            let operation = match action.as_str()? {
                "focus_window" => "focus",
                "move_window" => "move",
                "close_window" => "close",
                _ => "terminate",
            };
            set(&mut input, "operation", operation);
            ComputerAction::Window
        }
        "window_state" => {
            let state = input.remove("state")?;
            input.insert("operation".into(), state);
            ComputerAction::Window
        }
        "clipboard_write" => {
            set(&mut input, "operation", "write");
            ComputerAction::Clipboard
        }
        "clipboard_read" => {
            set(&mut input, "operation", "read");
            ComputerAction::Clipboard
        }
        "launch" => ComputerAction::Launch,
        "fill_saved_login" => {
            input.remove("delivery");
            if let Some(account) = input.remove("saved_account") {
                input.insert("savedAccount".into(), account);
            }
            ComputerAction::SavedLogin
        }
        _ => return None,
    };
    Some(ComputerRequest { action: tool, input: Value::Object(input) })
}

/// One host sequence step as the tool's `act.actions` entry (the inverse of `host_step`).
fn tool_step(step: Value) -> Value {
    let Value::Object(mut step) = step else { return step };
    let Some(action) = step.remove("action") else { return Value::Object(step) };
    let name = action.as_str().map(str::to_owned);
    let (kind, button) = match name.as_deref() {
        Some("right_click") => (json!("click"), Some("right")),
        Some("middle_click") => (json!("click"), Some("middle")),
        Some("mouse_move") => (json!("move"), None),
        Some("set_value") => {
            if let Some(text) = step.remove("text") {
                step.insert("value".into(), text);
            }
            (action, None)
        }
        _ => (action, None),
    };
    step.insert("type".into(), kind);
    if let Some(button) = button {
        step.insert("button".into(), json!(button));
    }
    Value::Object(step)
}

#[async_trait]
impl DomainService for ComputerBridgeRun {
    fn methods(&self) -> &'static [&'static str] {
        &[BRIDGE_RUN, BRIDGE_ABORT]
    }

    async fn call(&self, req: CoreRequest) -> Result<Reply, CoreError> {
        match req.method.as_str() {
            BRIDGE_RUN => Ok(Reply::Value(self.run(&req).await?)),
            BRIDGE_ABORT => Ok(Reply::Value(self.abort(&req).await?)),
            other => Err(CoreError::InvalidParams { path: "method".into(), expected: format!("a method of the computer bridge, not {other}").into() }),
        }
    }

    fn notify(&self, _method: Method, _params: Value, _from: ConnectionId) -> Admit {
        Admit::Accepted
    }
}

#[cfg(test)]
mod tests {
    use std::sync::atomic::AtomicU32;

    use mixdog_core_api::call::CallContext;
    use mixdog_core_api::domain::computer::ComputerStatus;
    use mixdog_core_api::domain::computer::DesktopIdentity;
    use mixdog_core_api::domain::computer::DisplayId;
    use mixdog_core_api::domain::computer::DisplayInfo;
    use mixdog_core_api::domain::computer::InputOutcome;
    use mixdog_core_api::domain::computer::ScreenInput;
    use mixdog_core_api::domain::media::MediaFrameSource;
    use mixdog_protocol::Origin;

    use super::super::computer_command::host_command;
    use super::*;

    const OWNER: &str = "0a1b2c3d-0000-4000-8000-0123456789ab";

    /// A backend that records the requests it ran and answers a text and a two-byte image; `hang` never answers until cancelled.
    struct Backend {
        log: Arc<Mutex<Vec<(String, ComputerRequest)>>>,
        session: String,
        hang: bool,
        fail: bool,
    }

    #[async_trait]
    impl ComputerBackend for Backend {
        async fn run(&self, request: ComputerRequest, cancel: CancellationToken) -> Result<Vec<ToolPart>, ComputerError> {
            locked(&self.log).push((self.session.clone(), request));
            if self.hang {
                cancel.cancelled().await;
                return Err(ComputerError::Cancelled);
            }
            if self.fail {
                return Err(ComputerError::Failed { code: "stale_frame".into(), message: "stale_frame: unknown frame_id".into() });
            }
            Ok(vec![ToolPart::Text("{\"ok\":true,\"secret\":\"hunter2\"}".into()), ToolPart::Image { mime: "image/png".into(), data: ImageData::Bytes(vec![1, 2]), width: None, height: None }])
        }
        fn inject(&self, _: ScreenInput) -> Result<InputOutcome, ComputerError> {
            Ok(InputOutcome::Applied)
        }
        fn release_input(&self) -> Result<u32, ComputerError> {
            Ok(0)
        }
        fn input_desktop(&self) -> Option<DesktopIdentity> {
            None
        }
        fn displays(&self) -> Result<Vec<DisplayInfo>, ComputerError> {
            Ok(Vec::new())
        }
        fn screen_source(&self, _: DisplayId) -> Result<Box<dyn MediaFrameSource>, ComputerError> {
            Err(ComputerError::Denied)
        }
        fn status(&self) -> ComputerStatus {
            ComputerStatus::default()
        }
    }

    #[derive(Default)]
    struct Host {
        log: Arc<Mutex<Vec<(String, ComputerRequest)>>>,
        helper: Mutex<Vec<(String, Map<String, Value>)>>,
        events: Mutex<Vec<String>>,
        hang: bool,
        fail: bool,
        helper_up: bool,
        abort_confirms: bool,
        /// What the helper answers a `process_fate` read with.
        fate: Mutex<String>,
    }

    #[async_trait]
    impl BridgeHost for Host {
        fn backend(&self, session: &str) -> Arc<dyn ComputerBackend> {
            Arc::new(Backend { log: self.log.clone(), session: session.to_owned(), hang: self.hang, fail: self.fail })
        }
        async fn helper(&self, session: &str, command: Map<String, Value>) -> Result<Map<String, Value>, String> {
            let action = text_field(&command, "action").to_owned();
            locked(&self.helper).push((session.to_owned(), command));
            match action.as_str() {
                "process_fate" => {
                    let state = locked(&self.fate).clone();
                    Ok(json!({ "state": state, "created": "133000000000000000" }).as_object().cloned().unwrap_or_default())
                }
                "key_down" => Err("computer_policy_denied: not authorized".into()),
                _ => Ok(json!({ "text": "typed hunter2" }).as_object().cloned().unwrap_or_default()),
            }
        }
        fn has_helper(&self, _: &str) -> bool {
            self.helper_up
        }
        async fn abort(&self, session: &str) -> bool {
            locked(&self.events).push(format!("abort:{session}"));
            self.abort_confirms
        }
        async fn end_execution(&self, session: &str) -> bool {
            locked(&self.events).push(format!("end:{session}"));
            true
        }
        async fn release(&self, session: &str) -> bool {
            locked(&self.events).push(format!("release:{session}"));
            self.abort_confirms
        }
    }

    #[derive(Default)]
    struct Secrets {
        focus: AtomicBool,
        bound: Mutex<Vec<String>>,
    }

    #[async_trait]
    impl BridgeSecrets for Secrets {
        fn bind(&self, session: &str, request_id: &str, window_id: &str, reference: &str) -> String {
            locked(&self.bound).push(format!("{session}|{request_id}|{window_id}|{reference}"));
            "bound".into()
        }
        async fn input(&self, _: &str, _: &str, _: &str, _: &str) -> String {
            self.focus.store(true, Ordering::SeqCst);
            "entered".into()
        }
        fn redact(&self, _: &str, text: &str) -> String {
            text.replace("hunter2", "[redacted]")
        }
        fn focus_armed(&self, _: &str) -> bool {
            self.focus.load(Ordering::SeqCst)
        }
        fn clear_focus(&self, _: &str) {
            self.focus.store(false, Ordering::SeqCst);
        }
    }

    #[derive(Default)]
    struct Saved {
        settled: Mutex<Vec<(String, u64)>>,
        admitted: AtomicU32,
        refuse: bool,
    }

    #[async_trait]
    impl BridgeSavedLogins for Saved {
        fn admit(&self, _: &str, _: u64) -> Result<Box<dyn Send>, String> {
            if self.refuse {
                return Err("its agent turn has already ended".into());
            }
            self.admitted.fetch_add(1, Ordering::SeqCst);
            Ok(Box::new(()))
        }
        async fn settle(&self, session: &str, turn: u64) {
            locked(&self.settled).push((session.to_owned(), turn));
        }
    }

    struct Fixture {
        service: Arc<ComputerBridgeRun>,
        host: Arc<Host>,
        secrets: Arc<Secrets>,
        saved: Arc<Saved>,
    }

    fn fixture_with(host: Host, saved: Saved) -> Fixture {
        let (host, secrets, saved) = (Arc::new(host), Arc::new(Secrets::default()), Arc::new(saved));
        let service = Arc::new(ComputerBridgeRun::new(host.clone(), secrets.clone(), saved.clone(), None, Arc::new(FillTurns::default())));
        Fixture { service, host, secrets, saved }
    }

    fn fixture() -> Fixture {
        fixture_with(Host { abort_confirms: true, ..Host::default() }, Saved::default())
    }

    fn call(method: &'static str, params: Value, claimant: bool, cancel: CancellationToken) -> CoreRequest {
        let mut ctx = CallContext::connection(ConnectionId(1), Origin::Local, cancel);
        ctx.host_claimant = claimant;
        CoreRequest { method: Method(method), params, op: None, ctx }
    }

    async fn run_with(f: &Fixture, session: &str, signal: &str, command: Value, cancel: CancellationToken) -> Value {
        let request = call(BRIDGE_RUN, json!({ "command": command, "sessionKey": session, "signalId": signal }), true, cancel);
        match f.service.call(request).await {
            Ok(Reply::Value(value)) => value,
            _ => panic!("the call must answer"),
        }
    }

    async fn run(f: &Fixture, session: &str, command: Value) -> Value {
        run_with(f, session, "sig", command, CancellationToken::new()).await
    }

    fn error_of(answer: &Value) -> String {
        assert_eq!(answer["ok"], json!(false), "{answer}");
        answer["error"].as_str().unwrap_or_default().to_owned()
    }

    /// A tool action runs through the session's backend; the reply is one text and one image, redacted of the session's secret.
    #[tokio::test]
    async fn a_tool_command_runs_through_the_backend_and_answers_the_wire_shape() {
        let f = fixture();
        let answer = run(&f, "s1", json!({ "action": "capture", "session_id": "s1", "app": "Notepad" })).await;
        assert_eq!(answer["ok"], json!(true));
        assert_eq!(answer["value"]["text"], json!("{\"ok\":true,\"secret\":\"[redacted]\"}"));
        assert_eq!(answer["value"]["image"], json!({ "data": "AQI=", "mimeType": "image/png" }));
        let ran = locked(&f.host.log);
        assert_eq!(ran[0].0, "s1");
        assert_eq!(ran[0].1, ComputerRequest { action: ComputerAction::Capture, input: json!({ "app": "Notepad" }) });
    }

    /// A helper command no tool action names goes to the session's helper without the runtime's own fields, and a failure keeps its
    /// words.
    #[tokio::test]
    async fn a_helper_command_goes_to_the_helper_and_a_failure_keeps_its_words() {
        let f = fixture();
        let answer = run(&f, "s1", json!({ "action": "type", "session_id": "s1", "text": "x", "turn_id": 3, "runtime_id": OWNER })).await;
        assert_eq!(answer["value"]["text"], json!("typed [redacted]"));
        assert_eq!(locked(&f.host.helper)[0].1, json!({ "action": "type", "text": "x" }).as_object().cloned().unwrap_or_default());
        let refused = run(&f, "s1", json!({ "action": "key_down", "key": "a" })).await;
        assert_eq!(error_of(&refused), "computer_policy_denied: not authorized");
        let failing = fixture_with(Host { fail: true, ..Host::default() }, Saved::default());
        let answer = run(&failing, "s1", json!({ "action": "list_windows" })).await;
        assert_eq!(error_of(&answer), "stale_frame: unknown frame_id");
    }

    /// `assertPublicComputerRequest`: a non-object, an internal session, internal authority and an unknown action are refused as an
    /// invalid request (400), before anything runs.
    #[tokio::test]
    async fn only_public_commands_are_accepted() {
        let f = fixture();
        for (command, text) in [
            (json!([1]), "invalid request: invalid_request: computer command must be an object"),
            (json!({ "action": "capture", "session_id": "__computer_host_warmup__" }), "invalid request: computer_policy_denied: internal execution authority cannot be supplied by a bridge caller"),
            (json!({ "action": "click", "expected_input_tick": 4 }), "invalid request: computer_policy_denied: internal execution authority cannot be supplied by a bridge caller"),
            (json!({ "action": "format_disk" }), "invalid request: invalid_action: computer bridge action is not available"),
        ] {
            let answer = run(&f, "s1", command).await;
            assert_eq!(error_of(&answer), text);
            assert_eq!(answer["status"], json!(400));
        }
        assert!(locked(&f.host.log).is_empty() && locked(&f.host.helper).is_empty());
    }

    /// Only the host claimant may call; an unnamed session or signal is a malformed call.
    #[tokio::test]
    async fn only_the_host_claimant_calls_and_the_params_are_checked() {
        let f = fixture();
        let params = json!({ "command": { "action": "diagnose" }, "sessionKey": "s1", "signalId": "a" });
        let denied = f.service.call(call(BRIDGE_RUN, params, false, CancellationToken::new())).await;
        assert!(matches!(denied, Err(CoreError::PermissionDenied { .. })));
        let denied = f.service.call(call(BRIDGE_ABORT, json!({ "sessionKey": "s1" }), false, CancellationToken::new())).await;
        assert!(matches!(denied, Err(CoreError::PermissionDenied { .. })));
        let empty = f.service.call(call(BRIDGE_RUN, json!({ "command": {}, "sessionKey": "", "signalId": "a" }), true, CancellationToken::new())).await;
        assert!(matches!(empty, Err(CoreError::InvalidParams { .. })));
    }

    /// The allowance: 32 requests run at once, 40 for lifecycle controls; the next is answered with the 429 refusal.
    #[tokio::test]
    async fn the_allowance_refuses_the_request_past_it() {
        let f = Arc::new(fixture_with(Host { hang: true, ..Host::default() }, Saved::default()));
        let mut running = Vec::new();
        for n in 0..ORDINARY_CAPACITY {
            let (f, cancel) = (f.clone(), CancellationToken::new());
            running.push((tokio::spawn({
                let cancel = cancel.clone();
                async move { run_with(&f, &format!("s{n}"), "sig", json!({ "action": "capture", "app": "a" }), cancel).await }
            }), cancel));
        }
        for _ in 0..200 {
            if f.service.active.load(Ordering::SeqCst) == ORDINARY_CAPACITY {
                break;
            }
            tokio::task::yield_now().await;
        }
        let refused = run(&f, "extra", json!({ "action": "capture", "app": "a" })).await;
        assert_eq!(error_of(&refused), CAPACITY_REFUSAL);
        assert_eq!(refused["status"], json!(429));
        let lifecycle = run(&f, "extra", json!({ "action": "execution_end" })).await;
        assert_eq!(lifecycle["value"]["text"], json!("computer execution ended"));
        for (task, cancel) in running {
            cancel.cancel();
            let _ = task.await;
        }
        assert_eq!(f.service.active.load(Ordering::SeqCst), 0);
    }

    /// The commands of one session run one at a time, in order; another session and `wait_for_user` do not wait.
    #[tokio::test]
    async fn a_session_runs_one_command_at_a_time() {
        let f = Arc::new(fixture_with(Host { hang: true, ..Host::default() }, Saved::default()));
        let first_cancel = CancellationToken::new();
        let first = tokio::spawn({
            let (f, cancel) = (f.clone(), first_cancel.clone());
            async move { run_with(&f, "s1", "one", json!({ "action": "capture", "app": "a" }), cancel).await }
        });
        for _ in 0..200 {
            if !locked(&f.host.log).is_empty() {
                break;
            }
            tokio::task::yield_now().await;
        }
        let second_cancel = CancellationToken::new();
        let second = tokio::spawn({
            let (f, cancel) = (f.clone(), second_cancel.clone());
            async move { run_with(&f, "s1", "two", json!({ "action": "list_windows" }), cancel).await }
        });
        for _ in 0..100 {
            tokio::task::yield_now().await;
        }
        assert_eq!(locked(&f.host.log).len(), 1, "the second waits behind the first");
        // A wait for the user and a command of another session go ahead.
        let waiting = tokio::spawn({
            let (f, cancel) = (f.clone(), CancellationToken::new());
            async move { run_with(&f, "s1", "three", json!({ "action": "wait_for_user" }), cancel).await }
        });
        for _ in 0..200 {
            if locked(&f.host.log).len() == 2 {
                break;
            }
            tokio::task::yield_now().await;
        }
        assert_eq!(locked(&f.host.log)[1].1.action, ComputerAction::WaitForUser);
        // Cancelling the queued one ends it before it ran.
        second_cancel.cancel();
        let answer = second.await.unwrap_or_default();
        assert_eq!(error_of(&answer), ABORTED_QUEUED);
        first_cancel.cancel();
        let _ = first.await;
        waiting.abort();
    }

    /// A cancelled call (the dropped connection, or its signal) aborts its session's helper; a wait for the user does not.
    #[tokio::test]
    async fn a_cancelled_call_aborts_the_session_except_a_wait_for_the_user() {
        let f = Arc::new(fixture_with(Host { hang: true, abort_confirms: true, ..Host::default() }, Saved::default()));
        let task = tokio::spawn({
            let f = f.clone();
            async move { run_with(&f, "s9", "sig-9", json!({ "action": "capture", "app": "a" }), CancellationToken::new()).await }
        });
        for _ in 0..200 {
            if !locked(&f.host.log).is_empty() {
                break;
            }
            tokio::task::yield_now().await;
        }
        let aborted = f.service.call(call(BRIDGE_ABORT, json!({ "sessionKey": "s9", "signalId": "sig-9" }), true, CancellationToken::new())).await;
        assert!(matches!(aborted, Ok(Reply::Value(ref v)) if v["cancelled"] == json!(1)));
        let answer = task.await.unwrap_or_default();
        assert_eq!(error_of(&answer), ABORTED_RUNNING);
        assert_eq!(*locked(&f.host.events), vec!["abort:s9".to_owned()]);
        // The wait for the user ends with its caller but leaves the helper be.
        let cancel = CancellationToken::new();
        let waiting = tokio::spawn({
            let (f, cancel) = (f.clone(), cancel.clone());
            async move { run_with(&f, "s9", "sig-w", json!({ "action": "wait_for_user" }), cancel).await }
        });
        for _ in 0..200 {
            if locked(&f.host.log).len() == 2 {
                break;
            }
            tokio::task::yield_now().await;
        }
        cancel.cancel();
        let _ = waiting.await;
        assert_eq!(locked(&f.host.events).len(), 1);
    }

    /// A dropped caller's abort ends the session's queued work too: the command behind it never runs, and the helper is aborted once.
    #[tokio::test]
    async fn a_cancelled_call_cancels_the_sessions_queued_work() {
        let f = Arc::new(fixture_with(Host { hang: true, abort_confirms: true, ..Host::default() }, Saved::default()));
        let first_cancel = CancellationToken::new();
        let first = tokio::spawn({
            let (f, cancel) = (f.clone(), first_cancel.clone());
            async move { run_with(&f, "s4", "one", json!({ "action": "capture", "app": "a" }), cancel).await }
        });
        for _ in 0..200 {
            if !locked(&f.host.log).is_empty() {
                break;
            }
            tokio::task::yield_now().await;
        }
        let second = tokio::spawn({
            let f = f.clone();
            async move { run_with(&f, "s4", "two", json!({ "action": "list_windows" }), CancellationToken::new()).await }
        });
        for _ in 0..200 {
            if locked(&f.service.runs).len() == 2 {
                break;
            }
            tokio::task::yield_now().await;
        }
        first_cancel.cancel();
        assert_eq!(error_of(&first.await.unwrap_or_default()), ABORTED_RUNNING);
        assert_eq!(error_of(&second.await.unwrap_or_default()), ABORTED_QUEUED);
        assert_eq!(locked(&f.host.log).len(), 1, "the queued command never ran");
        assert_eq!(*locked(&f.host.events), vec!["abort:s4".to_owned()]);
    }

    /// `session_abort`, `execution_end` and `session_release` answer Node's words; an abort whose cleanup is not confirmed fails.
    #[tokio::test]
    async fn lifecycle_controls_answer_the_bridges_words() {
        let f = fixture();
        let aborted = run(&f, "s1", json!({ "action": "session_abort", "session_id": "s1" })).await;
        assert_eq!(aborted["value"]["text"], json!("computer session aborted; input state and session resources were released"));
        let ended = run(&f, "s1", json!({ "action": "execution_end" })).await;
        assert_eq!(ended["value"]["text"], json!("computer execution ended"));
        let released = run(&f, "s1", json!({ "action": "session_release" })).await;
        assert_eq!(released["value"]["text"], json!("computer session released"));
        assert_eq!(*locked(&f.host.events), ["abort:s1", "end:s1", "end:s1", "release:s1"].map(str::to_owned));
        let stuck = fixture_with(Host { helper_up: true, abort_confirms: false, ..Host::default() }, Saved::default());
        let answer = run(&stuck, "s1", json!({ "action": "session_abort" })).await;
        assert_eq!(error_of(&answer), "computer_abort_cleanup_unconfirmed: input cleanup did not finish successfully");
        let answer = run(&stuck, "s1", json!({ "action": "session_release" })).await;
        assert_eq!(error_of(&answer), "computer_abort_cleanup_unconfirmed: input cleanup did not finish successfully");
    }

    /// `secret_bind` and `secret_input` answer the outcome word alone; while the typed field may hold focus a read is refused and the
    /// next input action lifts the hold.
    #[tokio::test]
    async fn secrets_are_bound_and_typed_and_the_focus_hold_withholds_reads() {
        let f = fixture();
        let bound = run(&f, "s1", json!({ "action": "secret_bind", "session_id": "s1", "request_id": "secret_abcdefgh", "window_id": "w1", "ref": "e1" })).await;
        assert_eq!(bound["value"], json!({ "text": "bound" }));
        assert_eq!(locked(&f.secrets.bound)[0], "s1|secret_abcdefgh|w1|e1");
        let typed = run(&f, "s1", json!({ "action": "secret_input", "session_id": "s1", "request_id": "secret_abcdefgh" })).await;
        assert_eq!(typed["value"], json!({ "text": "entered" }));
        let withheld = run(&f, "s1", json!({ "action": "capture", "app": "a" })).await;
        assert_eq!(error_of(&withheld), FOCUS_HELD);
        let lifecycle = run(&f, "s1", json!({ "action": "execution_end" })).await;
        assert_eq!(lifecycle["ok"], json!(true));
        assert!(f.secrets.focus_armed("s1"), "a lifecycle control does not move focus");
        let moved = run(&f, "s1", json!({ "action": "click", "x": 1, "y": 2 })).await;
        assert_eq!(moved["ok"], json!(true));
        assert!(!f.secrets.focus_armed("s1"));
        assert_eq!(run(&f, "s1", json!({ "action": "capture", "app": "a" })).await["ok"], json!(true));
    }

    /// `turn_settle` needs a session, a positive turn and a runtime, and is accepted at once.
    #[tokio::test]
    async fn a_turn_settlement_is_validated_and_retires_the_turns_protection() {
        let f = fixture();
        for command in [
            json!({ "action": "turn_settle", "session_id": "s1", "turn_id": 0, "runtime_id": OWNER }),
            json!({ "action": "turn_settle", "session_id": "s1", "turn_id": 2.5, "runtime_id": OWNER }),
            json!({ "action": "turn_settle", "session_id": "s1", "turn_id": 2 }),
        ] {
            assert_eq!(error_of(&run(&f, "s1", command).await), "invalid_request: turn_settle needs a session_id, a positive turn_id and a runtime_id");
        }
        let accepted = run(&f, "s1", json!({ "action": "turn_settle", "session_id": "s1", "turn_id": "4", "runtime_id": OWNER })).await;
        assert_eq!(accepted["value"]["text"], json!("turn settlement accepted"));
        for _ in 0..200 {
            if !locked(&f.saved.settled).is_empty() {
                break;
            }
            tokio::task::yield_now().await;
        }
        assert_eq!(*locked(&f.saved.settled), vec![("s1".to_owned(), 4)]);
    }

    fn fill(turn: u64) -> Value {
        json!({ "action": "fill_saved_login", "session_id": "s1", "app": "Chrome", "saved_account": "a", "turn_id": turn, "runtime_id": OWNER, "delivery": "foreground" })
    }

    /// A saved-login fill is refused (nothing sent) without an attached owner, once its turn settled, and where the registry refuses
    /// it; an admitted one runs as the tool's `saved_login` with the runtime's turn, and its reply carries no image.
    #[tokio::test]
    async fn a_saved_login_fill_needs_an_attached_owner_and_an_open_turn() {
        let f = fixture();
        let refused = run(&f, "s1", fill(1)).await;
        assert_eq!(error_of(&refused), "saved_login_unavailable: this runtime holds no owner connection to the bridge; no input was sent");
        *locked(&f.host.fate) = "running".into();
        let attached = run(&f, "s1", json!({ "action": "owner_attach", "runtime_id": OWNER, "pid": 4321 })).await;
        assert_eq!(attached["value"]["text"], json!("attached"));
        let ran = run(&f, "s1", fill(2)).await;
        assert_eq!(ran["ok"], json!(true));
        assert!(ran["value"].get("image").is_none(), "the pixels of a filled field never leave");
        let request = locked(&f.host.log).last().cloned().unwrap_or_else(|| panic!("the fill must reach the backend")).1;
        assert_eq!(request, ComputerRequest { action: ComputerAction::SavedLogin, input: json!({ "app": "Chrome", "savedAccount": "a" }) });
        assert_eq!(f.saved.admitted.load(Ordering::SeqCst), 1);
        run(&f, "s1", json!({ "action": "turn_settle", "session_id": "s1", "turn_id": 2, "runtime_id": OWNER })).await;
        let late = run(&f, "s1", fill(2)).await;
        assert_eq!(error_of(&late), "saved_login_unavailable: its agent turn has already ended; no input was sent");
        let invalid = run(&f, "s1", json!({ "action": "fill_saved_login", "session_id": "s1", "app": "a" })).await;
        assert_eq!(error_of(&invalid), "saved_login_unavailable: the request names no runtime owner and agent turn to scope its protection to; no input was sent");
        let registry = fixture_with(Host::default(), Saved { refuse: true, ..Saved::default() });
        *locked(&registry.host.fate) = "running".into();
        run(&registry, "s1", json!({ "action": "owner_attach", "runtime_id": OWNER, "pid": 4321 })).await;
        assert_eq!(error_of(&run(&registry, "s1", fill(1)).await), "saved_login_unavailable: its agent turn has already ended; no input was sent");
    }

    /// An owner's connection closing only detaches; its protection retires only when the OS proves its process ended, and an
    /// unknown answer keeps it.
    #[tokio::test]
    async fn an_owner_retires_only_on_proof_its_process_ended() {
        let f = fixture();
        *locked(&f.host.fate) = "running".into();
        run(&f, "s1", json!({ "action": "owner_attach", "runtime_id": OWNER, "pid": 4321 })).await;
        assert_eq!(run(&f, "s1", fill(3)).await["ok"], json!(true));
        // Another process claiming the owner's id is refused.
        let other = run(&f, "s1", json!({ "action": "owner_attach", "runtime_id": OWNER, "pid": 99 })).await;
        assert_eq!(error_of(&other), "invalid request: unknown or ended runtime owner");
        *locked(&f.host.fate) = "unknown".into();
        run(&f, "s1", json!({ "action": "owner_detach", "runtime_id": OWNER })).await;
        assert!(locked(&f.saved.settled).is_empty(), "an unknown answer keeps the protection");
        *locked(&f.host.fate) = "ended".into();
        // The next capture reads the fate of the detached owner and retires what it set up.
        run(&f, "s1", json!({ "action": "capture", "app": "a" })).await;
        assert_eq!(*locked(&f.saved.settled), vec![("s1".to_owned(), 3)]);
        let again = run(&f, "s1", json!({ "action": "owner_attach", "runtime_id": OWNER, "pid": 4321 })).await;
        assert_eq!(error_of(&again), "invalid request: unknown or ended runtime owner");
    }

    /// Ending a session settles every turn its owners admitted a fill for.
    #[tokio::test]
    async fn releasing_a_session_settles_its_fills() {
        let f = fixture();
        *locked(&f.host.fate) = "running".into();
        run(&f, "s1", json!({ "action": "owner_attach", "runtime_id": OWNER, "pid": 4321 })).await;
        run(&f, "s1", fill(5)).await;
        run(&f, "s1", json!({ "action": "session_release" })).await;
        assert_eq!(*locked(&f.saved.settled), vec![("s1".to_owned(), 5)]);
    }

    /// The reply is held to the bridge's limits: an oversized text or an image of another type is a failure, not a reply.
    #[tokio::test]
    async fn a_reply_is_held_to_the_bridges_limits() {
        let f = fixture();
        let big = Answer::text("x".repeat(MAX_TEXT_CHARS + 1));
        let command = json!({ "action": "capture" }).as_object().cloned().unwrap_or_default();
        let sealed = f.service.seal("s1", &command, Ok(big)).await;
        assert_eq!(error_of(&sealed), "computer bridge returned invalid or oversized text");
        let gif = Answer { text: "t".into(), image: Some(("image/gif".into(), "AQI=".into())) };
        assert_eq!(error_of(&f.service.seal("s1", &command, Ok(gif)).await), "computer bridge returned an invalid or oversized image");
        let secret = f.service.seal("s1", &command, Err("typed hunter2".into())).await;
        assert_eq!(error_of(&secret), "typed [redacted]");
    }

    /// The bridge command of every tool action becomes the tool's request, and the tool's own conversion gives the command back.
    #[test]
    fn a_bridge_command_round_trips_through_the_tool_request() {
        let command = |value: Value| value.as_object().cloned().unwrap_or_default();
        for bridge in [
            json!({ "action": "list_windows", "query": "x" }),
            json!({ "action": "list_apps" }),
            json!({ "action": "list_history", "limit": 3 }),
            json!({ "action": "capture", "window_id": "w", "mode": "ax" }),
            json!({ "action": "zoom", "frame_id": "f", "region": [0, 0, 1, 1] }),
            json!({ "action": "verify", "app": "a", "expect": [{ "present": "x" }] }),
            json!({ "action": "diagnose" }),
            json!({ "action": "wait_for_user", "reason": "r" }),
            json!({ "action": "invoke_menu", "app": "a", "path": ["File"] }),
            json!({ "action": "focus_window", "window_id": "w" }),
            json!({ "action": "move_window", "window_id": "w", "x": 1 }),
            json!({ "action": "close_window", "window_id": "w" }),
            json!({ "action": "terminate_process", "window_id": "w" }),
            json!({ "action": "window_state", "window_id": "w", "state": "minimize" }),
            json!({ "action": "clipboard_write", "text": "t" }),
            json!({ "action": "clipboard_read" }),
            json!({ "action": "launch", "app": "https://example.com" }),
            json!({ "action": "fill_saved_login", "app": "a", "saved_account": "x", "delivery": "foreground" }),
            json!({ "action": "sequence", "window_id": "w", "delivery": "background", "capture_after_mode": "ax", "steps": [
                { "action": "right_click", "x": 1, "y": 2, "frame_id": "f" },
                { "action": "middle_click", "x": 1, "y": 2 },
                { "action": "click", "ref": "e1" },
                { "action": "mouse_move", "x": 3, "y": 4, "frame_id": "f" },
                { "action": "set_value", "text": "v", "ref": "e1" },
                { "action": "type", "text": "hi" }] }),
        ] {
            let host = command(bridge.clone());
            let request = tool_request(&host).unwrap_or_else(|| panic!("{bridge} is a tool action"));
            let input = request.input.as_object().cloned().unwrap_or_default();
            let back = host_command(request.action, &input).unwrap_or_else(|error| panic!("{bridge}: {error:?}"));
            let mut expected = host.clone();
            // The tool's conversion states what the bridge left to its default.
            if host.get("action") == Some(&json!("sequence")) || host.get("action") == Some(&json!("fill_saved_login")) {
                expected.insert("delivery".into(), back["delivery"].clone());
            }
            assert_eq!(Value::Object(back), Value::Object(expected), "{bridge}");
        }
        for helper in ["click", "type", "key", "find", "window_bounds", "snapshot", "screenshot", "wait", "window_predicates"] {
            assert!(tool_request(&command(json!({ "action": helper }))).is_none(), "{helper} is the helper's own");
        }
    }
}
