//! Explicit MCP OAuth sign-in flows (`session-runtime/mcp-oauth-login.mjs`): the only interactive
//! MCP connect. A flow signs one configured server in, hands the authorization URL back to the
//! caller (opening the host browser only when asked), and is then polled until it settles. One
//! sign-in per server: a new one replaces the pending one.
//!
//! The login itself is the core's [`LoginSession`] (the loopback callback, the pasted code, the
//! token exchange); this registry keeps the flows readable by id, as Node's module-level map does.

use std::collections::HashMap;
use std::sync::Arc;
use std::sync::Mutex;
use std::sync::atomic::AtomicBool;
use std::sync::atomic::Ordering;
use std::time::Duration;

use async_trait::async_trait;
use mixdog_core_api::domain::login::LoginError;
use mixdog_core_api::domain::login::LoginFailure;
use mixdog_core_api::domain::login::LoginInput;
use mixdog_core_api::domain::login::LoginSession;
use mixdog_core_api::domain::login::LoginState;
use serde_json::Value;
use serde_json::json;
use tokio::sync::oneshot;
use tokio::sync::watch;

use crate::oauth::account::AccountMode;

/// Settled flows stay readable long enough for a poller to observe the result.
const SETTLED_FLOW_TTL: Duration = Duration::from_secs(10 * 60);
const NOT_COMPLETED: &str = "MCP OAuth sign-in was not completed";
const TIMED_OUT: &str = "MCP OAuth sign-in timed out";
const NOT_PENDING: &str = "MCP OAuth sign-in is no longer pending";
/// A sign-in nobody finishes ends here, ahead of the OAuth layer's own 5-minute abort, so its
/// failure is reported as the timeout it is.
pub const LOGIN_DEADLINE: Duration = Duration::from_secs(5 * 60 - 10);
/// The longest a status read waits for a change.
const MAX_STATUS_WAIT: Duration = Duration::from_secs(15);

/// How a sign-in began.
pub enum Started {
    /// The browser login runs.
    Browser(Box<dyn LoginSession>),
    /// The stored credentials sufficed: the server is connected and no login is needed.
    Connected,
}

/// What the logins need of the process around them.
#[async_trait]
pub trait LoginBackend: Send + Sync {
    /// Starts the sign-in of `name`: the server's own, or an account of a connector, in `mode`.
    /// `beside` runs any mode as a sign-in beside the stored one.
    async fn start(&self, name: &str, mode: AccountMode, beside: bool) -> Result<Started, String>;
    /// Tokens are stored: connects the server with them. `(connected, error)` is the outcome;
    /// a switch that cannot connect is rolled back here.
    async fn settle(&self, name: &str, mode: AccountMode, beside: bool, account: Option<String>) -> (bool, Option<String>);
    /// `openInBrowser(url)`.
    fn open_browser(&self, url: &str);
    /// The flow reports complete; the other runtimes reconnect (`onComplete`).
    async fn completed(&self, name: &str);
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum State {
    Pending,
    Complete,
    Failed,
    Cancelled,
}

impl State {
    fn as_str(self) -> &'static str {
        match self {
            Self::Pending => "pending",
            Self::Complete => "complete",
            Self::Failed => "failed",
            Self::Cancelled => "cancelled",
        }
    }
}

struct View {
    state: State,
    /// `starting`, `browser` (the sign-in page), `connecting` (the callback arrived), `tools`.
    step: &'static str,
    url: Option<String>,
    error: Option<String>,
    reason: Option<String>,
    awaiting_callback: bool,
}

struct Flow {
    id: String,
    name: String,
    view: Mutex<View>,
    /// Bumped on every change: wakes the status reads waiting on the flow.
    changed: watch::Sender<u64>,
    session: Mutex<Option<Arc<dyn LoginSession>>>,
    cancelled: AtomicBool,
    timed_out: AtomicBool,
}

fn lock<T>(mutex: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(|e| e.into_inner())
}

impl Flow {
    fn view(&self) -> Value {
        let view = lock(&self.view);
        let mut out = json!({"flowId": self.id, "state": view.state.as_str()});
        if view.state == State::Pending {
            out["step"] = json!(view.step);
            if let Some(url) = &view.url {
                out["url"] = json!(url);
            }
        }
        if let Some(error) = view.error.as_ref().filter(|e| !e.is_empty()) {
            out["error"] = json!(error);
        }
        if let Some(reason) = &view.reason {
            out["reason"] = json!(reason);
        }
        out
    }

    fn version(&self) -> String {
        let view = lock(&self.view);
        format!("{}:{}", view.state.as_str(), view.step)
    }

    fn is_pending(&self) -> bool {
        lock(&self.view).state == State::Pending
    }

    fn touch(&self) {
        self.changed.send_modify(|n| *n += 1);
    }

    fn set_step(&self, step: &'static str) {
        {
            let mut view = lock(&self.view);
            if view.state != State::Pending || view.step == step {
                return;
            }
            view.step = step;
        }
        self.touch();
    }

    /// Only a pending flow settles.
    fn settle(&self, state: State, error: Option<String>) -> bool {
        {
            let mut view = lock(&self.view);
            if view.state != State::Pending {
                return false;
            }
            view.state = state;
            if state == State::Failed {
                view.error = Some(error.filter(|e| !e.is_empty()).unwrap_or_else(|| NOT_COMPLETED.to_owned()));
            }
        }
        self.touch();
        true
    }

    async fn settled(&self) {
        let mut rx = self.changed.subscribe();
        while self.is_pending() {
            if rx.changed().await.is_err() {
                return;
            }
        }
    }
}

#[derive(Default)]
struct Options {
    open_browser: Option<bool>,
    mode: AccountMode,
    beside: bool,
}

fn options_of(options: &Value) -> Result<Options, String> {
    let mut out = Options::default();
    match options.get("openBrowser") {
        None | Some(Value::Null) => {}
        Some(Value::Bool(open)) => out.open_browser = Some(*open),
        Some(_) => return Err("openBrowser must be a boolean".to_owned()),
    }
    out.mode = match options.get("mode") {
        None | Some(Value::Null) => AccountMode::Connect,
        Some(Value::String(mode)) => match mode.as_str() {
            "connect" => AccountMode::Connect,
            "reauth" => AccountMode::Reauth,
            "switch" => AccountMode::Switch,
            _ => return Err("mode must be connect, reauth or switch".to_owned()),
        },
        Some(_) => return Err("mode must be connect, reauth or switch".to_owned()),
    };
    out.beside = options.get("beside") == Some(&Value::Bool(true));
    Ok(out)
}

pub struct McpLogins {
    backend: Arc<dyn LoginBackend>,
    flows: Arc<Mutex<HashMap<String, Arc<Flow>>>>,
    /// One server's begin/cancel/sign-out steps run one at a time, so replacing a pending flow is
    /// atomic and exactly one can be pending.
    lanes: Arc<mixdog_rt::KeyedChains>,
    login_deadline: Duration,
}

impl McpLogins {
    pub fn new(backend: Arc<dyn LoginBackend>) -> Self {
        Self::with_deadline(backend, LOGIN_DEADLINE)
    }

    pub fn with_deadline(backend: Arc<dyn LoginBackend>, login_deadline: Duration) -> Self {
        Self { backend, flows: Arc::default(), lanes: mixdog_rt::KeyedChains::new(), login_deadline }
    }

    fn flow_of(&self, flow_id: &str) -> Result<Arc<Flow>, String> {
        lock(&self.flows).get(flow_id).cloned().ok_or_else(|| "MCP OAuth login not found".to_owned())
    }

    /// `cancelFlow`: a pending flow is cancelled and awaited.
    async fn cancel_flow(flow: &Arc<Flow>) -> Value {
        if flow.is_pending() {
            flow.cancelled.store(true, Ordering::SeqCst);
            let session = lock(&flow.session).clone();
            if let Some(session) = session {
                session.cancel();
            }
            flow.settled().await;
        }
        flow.view()
    }

    async fn cancel_server_flows(&self, name: &str) {
        let flows: Vec<Arc<Flow>> = lock(&self.flows).values().filter(|f| f.name == name).cloned().collect();
        futures::future::join_all(flows.iter().map(Self::cancel_flow)).await;
    }

    /// `begin`: `{ flowId, state: 'pending', url }` once the browser login starts, or
    /// `{ flowId, state: 'complete' }` when stored credentials sufficed.
    pub async fn begin(&self, name: &str, options: &Value) -> Result<Value, String> {
        let options = options_of(options)?;
        let (url_tx, url_rx) = oneshot::channel::<String>();
        let flow = {
            let _turn = self.lanes.acquire(name).await;
            self.cancel_server_flows(name).await;
            let (changed, _) = watch::channel(0u64);
            let flow = Arc::new(Flow {
                id: format!("mcp_oauth_{}", uuid::Uuid::new_v4()),
                name: name.to_owned(),
                view: Mutex::new(View { state: State::Pending, step: "starting", url: None, error: None, reason: None, awaiting_callback: false }),
                changed,
                session: Mutex::new(None),
                cancelled: AtomicBool::new(false),
                timed_out: AtomicBool::new(false),
            });
            lock(&self.flows).insert(flow.id.clone(), Arc::clone(&flow));
            let driver = Driver {
                backend: Arc::clone(&self.backend),
                flows: Arc::clone(&self.flows),
                flow: Arc::clone(&flow),
                mode: options.mode,
                beside: options.beside,
                open_browser: options.open_browser,
                deadline: self.login_deadline,
            };
            mixdog_rt::spawn("mcp.login.flow", mixdog_rt::TaskClass::Work, driver.run(url_tx));
            flow
        };
        let mut url_rx = url_rx;
        let url = tokio::select! {
            url = &mut url_rx => url.ok(),
            () = flow.settled() => None,
        };
        if let Some(url) = url {
            return Ok(json!({"flowId": flow.id, "state": "pending", "url": url}));
        }
        // The URL may have been announced in the same instant the flow settled.
        if let Ok(url) = url_rx.try_recv() {
            return Ok(json!({"flowId": flow.id, "state": "pending", "url": url}));
        }
        if lock(&flow.view).state == State::Complete {
            return Ok(flow.view());
        }
        // A superseded or failed begin stays readable (cancelled / failed).
        Err(lock(&flow.view).error.clone().filter(|e| !e.is_empty()).unwrap_or_else(|| NOT_COMPLETED.to_owned()))
    }

    /// The flow's view. With `{ since, waitMs }` (the `state:step` a caller last saw) the read
    /// resolves on the flow's next change, or after at most `waitMs` unchanged.
    pub async fn status(&self, flow_id: &str, options: &Value) -> Result<Value, String> {
        let flow = self.flow_of(flow_id)?;
        let since = match options.get("since") {
            None => return Ok(flow.view()),
            Some(Value::String(since)) => since.clone(),
            Some(_) => return Err("since must be a string".to_owned()),
        };
        let wait_ms = options.get("waitMs").and_then(Value::as_f64).filter(|w| w.is_finite() && *w >= 0.0);
        let Some(wait_ms) = wait_ms else { return Err("waitMs must be a non-negative number".to_owned()) };
        if since != flow.version() || !flow.is_pending() || wait_ms == 0.0 {
            return Ok(flow.view());
        }
        let wait = Duration::from_millis(wait_ms as u64).min(MAX_STATUS_WAIT);
        let mut rx = flow.changed.subscribe();
        // A change between the check above and the subscription is caught by the version check.
        if since != flow.version() {
            return Ok(flow.view());
        }
        let _ = tokio::time::timeout(wait, rx.changed()).await;
        Ok(flow.view())
    }

    pub async fn cancel(&self, flow_id: &str) -> Result<Value, String> {
        let flow = self.flow_of(flow_id)?;
        let _turn = self.lanes.acquire(&flow.name).await;
        Ok(Self::cancel_flow(&flow).await)
    }

    /// Answers the pending flow with the redirect URL pasted from the browser and resolves once
    /// it settles. An invalid paste fails with a fixed message and leaves the flow pending.
    pub async fn complete(&self, flow_id: &str, callback_url: &str) -> Result<Value, String> {
        let flow = self.flow_of(flow_id)?;
        let session = {
            let view = lock(&flow.view);
            if view.state != State::Pending || flow.cancelled.load(Ordering::SeqCst) || !view.awaiting_callback {
                return Err(NOT_PENDING.to_owned());
            }
            lock(&flow.session).clone()
        };
        let Some(session) = session else { return Err(NOT_PENDING.to_owned()) };
        match session.provide(LoginInput::AuthorizationCode(callback_url.to_owned())).await {
            Ok(()) => {}
            Err(LoginError::Failed(LoginFailure::Failed { message, .. })) => return Err(message),
            Err(_) => return Err(NOT_PENDING.to_owned()),
        }
        flow.settled().await;
        Ok(flow.view())
    }

    /// Whether a sign-in of `name` is waiting on the user (`isMcpLoginPending`).
    pub fn is_pending(&self, name: &str) -> bool {
        lock(&self.flows).values().any(|f| f.name == name && f.is_pending())
    }

    /// Cancels every pending sign-in of one server and holds off a later begin of it until the
    /// returned guard drops (sign-out).
    pub async fn cancel_server(&self, name: &str) -> mixdog_rt::ChainGuard {
        let turn = self.lanes.acquire(name).await;
        self.cancel_server_flows(name).await;
        turn
    }
}

struct Driver {
    backend: Arc<dyn LoginBackend>,
    flows: Arc<Mutex<HashMap<String, Arc<Flow>>>>,
    flow: Arc<Flow>,
    mode: AccountMode,
    beside: bool,
    open_browser: Option<bool>,
    deadline: Duration,
}

impl Driver {
    async fn run(self, url_tx: oneshot::Sender<String>) {
        let flow = Arc::clone(&self.flow);
        self.drive(url_tx).await;
        let (flows, id) = (Arc::clone(&self.flows), flow.id.clone());
        mixdog_rt::spawn("mcp.login.expire", mixdog_rt::TaskClass::Work, async move {
            tokio::time::sleep(SETTLED_FLOW_TTL).await;
            lock(&flows).remove(&id);
        });
    }

    fn end(&self, state: State, error: Option<String>) {
        let flow = &self.flow;
        if flow.timed_out.load(Ordering::SeqCst) {
            lock(&flow.view).reason = Some("timeout".to_owned());
            flow.settle(State::Failed, Some(TIMED_OUT.to_owned()));
        } else if flow.cancelled.load(Ordering::SeqCst) {
            flow.settle(State::Cancelled, None);
        } else {
            flow.settle(state, error);
        }
    }

    /// The flow reports complete; the other runtimes reconnect after that. The caller never
    /// waits for every peer's reconnect, and a failed follow-up never undoes the sign-in.
    async fn complete(&self) {
        let flow = &self.flow;
        flow.settle(State::Complete, None);
        let (backend, name) = (Arc::clone(&self.backend), flow.name.clone());
        mixdog_rt::spawn("mcp.login.completed", mixdog_rt::TaskClass::Work, async move { backend.completed(&name).await });
    }

    async fn drive(&self, url_tx: oneshot::Sender<String>) {
        let flow = &self.flow;
        let started = self.backend.start(&flow.name, self.mode, self.beside).await;
        let session: Arc<dyn LoginSession> = match started {
            Ok(Started::Browser(session)) => Arc::from(session),
            Ok(Started::Connected) => return self.complete().await,
            Err(message) => return self.end(State::Failed, Some(message)),
        };
        *lock(&flow.session) = Some(Arc::clone(&session));
        if flow.cancelled.load(Ordering::SeqCst) {
            session.cancel();
        }
        let mut url_tx = Some(url_tx);
        let mut deadline: Option<std::pin::Pin<Box<tokio::time::Sleep>>> = None;
        loop {
            let next = match deadline.as_mut() {
                Some(sleep) => tokio::select! {
                    next = session.next() => next,
                    () = sleep.as_mut() => {
                        deadline = None;
                        if flow.is_pending() && lock(&flow.view).step == "browser" {
                            flow.timed_out.store(true, Ordering::SeqCst);
                            flow.cancelled.store(true, Ordering::SeqCst);
                            session.cancel();
                        }
                        continue;
                    }
                },
                None => session.next().await,
            };
            let Some(state) = next else { return self.end(State::Failed, None) };
            match state {
                LoginState::Authorize { url, .. } => {
                    // A login reached after its flow was cancelled never opens anything.
                    if flow.cancelled.load(Ordering::SeqCst) {
                        session.cancel();
                        continue;
                    }
                    {
                        let mut view = lock(&flow.view);
                        view.awaiting_callback = true;
                        view.url = Some(url.clone());
                    }
                    flow.set_step("browser");
                    if let Some(tx) = url_tx.take() {
                        let _ = tx.send(url.clone());
                    }
                    if self.open_browser != Some(false) {
                        self.backend.open_browser(&url);
                    }
                    deadline = Some(Box::pin(tokio::time::sleep(self.deadline)));
                }
                LoginState::Waiting => flow.set_step("connecting"),
                LoginState::Starting | LoginState::DeviceCode { .. } => {}
                LoginState::Done { account } => {
                    flow.set_step("tools");
                    let (connected, error) = self.backend.settle(&flow.name, self.mode, self.beside, account).await;
                    if flow.timed_out.load(Ordering::SeqCst) || flow.cancelled.load(Ordering::SeqCst) {
                        return self.end(State::Failed, error);
                    }
                    if connected {
                        self.complete().await;
                    } else {
                        flow.settle(State::Failed, error);
                    }
                    return;
                }
                LoginState::Failed(LoginFailure::Expired) => {
                    flow.timed_out.store(true, Ordering::SeqCst);
                    return self.end(State::Failed, None);
                }
                LoginState::Failed(failure) => {
                    let message = match failure {
                        LoginFailure::Failed { message, .. } => Some(message),
                        _ => None,
                    };
                    return self.end(State::Failed, message);
                }
                LoginState::Cancelled => return self.end(State::Cancelled, None),
            }
        }
    }
}
