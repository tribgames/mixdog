//! One remote server per desktop process: bootstrap of the core there, the tunnel to it, and the check that the process
//! behind the tunnel is the core the bootstrap found, before the core's token is used.
//!
//! The session is shared by every protocol connection generation, so a restart reuses the supervised tunnel. It never
//! starts or touches a local core. Its tests are in `session_tests.rs`.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};
use std::time::Duration;

use async_trait::async_trait;
use mixdog_rt::time::{timeout, Instant};
use mixdog_rt::SerialChain;
use serde_json::Value;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpStream;
use tokio::sync::watch;

use crate::bootstrap::{bootstrap, BootstrapOptions, BootstrapPhase, RemoteReport, ServerPayloads};
use crate::command::{FailureClass, SshError, SshTarget};
use crate::connect_failure::ConnectError;
use crate::context::{AttemptContext, ModelLogin, SshEnv};
use crate::tunnel::{LocalForward, SshTunnel, TunnelSpec, TunnelState};

const DEFAULT_TUNNEL_READY_TIMEOUT: Duration = Duration::from_millis(90_000);
const IDENTITY_CHECK_TIMEOUT: Duration = Duration::from_millis(5_000);
/// The bound of the running-work read ([`RemoteSession::busy_sessions`]).
pub const BUSY_SESSIONS_TIMEOUT: Duration = Duration::from_millis(3_000);
/// A `/health` answer is a few dozen bytes; anything larger is not the core's.
const MAX_HEALTH_BYTES: usize = 64 * 1024;
const LOOPBACK: &str = "127.0.0.1";

/// Where a connect is: `Connect` (ssh dialed), `Check` (platform probed), `Install` (runtime upload) or `Start`
/// (core), `Start` again while the tunnel comes up, then `Ready` (attached).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SessionPhase {
    Connect,
    Check { detail: String },
    Install,
    Start,
    Ready,
}

/// What a connect reports its phases to.
pub type Progress = Arc<dyn Fn(SessionPhase) + Send + Sync>;

#[derive(Clone)]
pub struct RemoteSessionConfig {
    pub target: SshTarget,
    /// Whose provider logins the core runs models on; `None` is this PC's.
    pub model_login: Option<ModelLogin>,
    /// How long the server keeps the host's work after the connection drops; `None`: the server's own setting applies.
    pub grace_ms: Option<u64>,
    /// Server folder the attachment opens in: `~`, `~/x` or an absolute server path; `None` is the server's home.
    pub remote_cwd: Option<String>,
    /// How long a connect waits for the tunnel; `None` is 90 seconds.
    pub tunnel_ready_timeout: Option<Duration>,
    pub progress: Option<Progress>,
    /// The user confirmed stopping the older core's running work (`daemon-busy-other-version`): the first bootstrap
    /// may abort it.
    pub force_restart: bool,
}

impl RemoteSessionConfig {
    pub fn new(target: SshTarget) -> Self {
        Self { target, model_login: None, grace_ms: None, remote_cwd: None, tunnel_ready_timeout: None, progress: None, force_restart: false }
    }
}

/// What the protocol connection needs to dial the remote core: the local end of the tunnel to its WebSocket listener,
/// the core's token and the core's identity.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Endpoint {
    /// `ws://127.0.0.1:<local port>/rpc`.
    pub url: String,
    /// The remote core's token.
    pub token: String,
    /// The core instance; a different one after a reconnect means a new core.
    pub server_instance_id: String,
    pub pid: u32,
    /// Server-side working directory of the attachment.
    pub cwd: String,
    /// Version of the Mixdog core running on the server.
    pub core_version: String,
}

/// Who answers the control listener's `/health` on the tunnel's companion end, and how fast. `/health` takes no
/// token, and none is sent: the answer is checked first.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Health {
    pub rtt_ms: u64,
    /// Units of work the core is running.
    pub busy: u64,
    pub pid: u32,
    /// The run the answering core is: random per start, so a process that reused the pid differs.
    pub instance_id: Option<String>,
}

/// The core the bootstrap found: what the tunnel must lead to.
#[derive(Debug, Clone, PartialEq, Eq)]
struct Identity {
    pid: u32,
    instance_id: String,
}

impl Identity {
    /// The answering process is the probed core: same pid and same run. Anything else may be another user's process
    /// that bound the freed port on a shared server, or a replacement that reused the pid.
    fn is_answered_by(&self, health: &Health) -> bool {
        health.pid == self.pid && health.instance_id.as_deref() == Some(self.instance_id.as_str())
    }
}

/// Why a connect stopped.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum SessionError {
    #[error(transparent)]
    Connect(ConnectError),
    #[error("The remote Mixdog connection is closed.")]
    Closed,
    #[error("Automatic reconnection is off for this server.")]
    ReconnectOff,
    #[error("{0}")]
    Cwd(String),
}

impl From<SshError> for SessionError {
    fn from(error: SshError) -> Self {
        Self::Connect(error.into())
    }
}

impl From<ConnectError> for SessionError {
    fn from(error: ConnectError) -> Self {
        Self::Connect(error)
    }
}

impl SessionError {
    /// Redialing cannot fix it: a changed host key, a refused login, an unsupported server, an older desktop, another
    /// process behind the tunnel.
    pub fn is_terminal(&self) -> bool {
        matches!(self, Self::Connect(error) if error.is_terminal())
    }
}

/// The tunnel leads to another process than the probed core.
fn identity_error(display: &str) -> SshError {
    SshError::new(
        format!(
            "Another process answered through the ssh tunnel to {display} instead of the Mixdog core it started. \
             The connection was stopped and nothing was sent to it. Reconnect to start over."
        ),
        FailureClass::Terminal,
    )
}

/// `~` / `~/x` resolve against the remote home; anything else must be an absolute server path.
pub fn resolve_remote_cwd(configured: Option<&str>, home: &str) -> Result<String, SessionError> {
    let Some(configured) = configured.filter(|text| !text.is_empty()) else {
        return Ok(home.to_owned());
    };
    if configured.chars().any(char::is_control) {
        return Err(SessionError::Cwd("The server folder must not contain control characters.".to_owned()));
    }
    if configured == "~" {
        return Ok(home.to_owned());
    }
    if let Some(rest) = configured.strip_prefix("~/") {
        return Ok(posix_normalize(&format!("{home}/{rest}")));
    }
    if !configured.starts_with('/') {
        return Err(SessionError::Cwd(format!("The server folder must be an absolute server path: {configured}")));
    }
    Ok(posix_normalize(configured))
}

/// `path.posix.normalize` of an absolute path: `.` and empty segments dropped, `..` removed with its parent.
fn posix_normalize(path: &str) -> String {
    let mut kept: Vec<&str> = Vec::new();
    for segment in path.split('/') {
        match segment {
            "" | "." => {}
            ".." => {
                kept.pop();
            }
            other => kept.push(other),
        }
    }
    format!("/{}", kept.join("/"))
}

// ---------------------------------------------------------------------------------------------
// The two collaborators of a session
// ---------------------------------------------------------------------------------------------

/// A supervised tunnel as the session drives it.
#[async_trait]
pub trait TunnelHandle: Send + Sync {
    fn local_port(&self) -> u16;
    fn companion_port(&self) -> u16;
    fn state(&self) -> watch::Receiver<TunnelState>;
    fn restart(&self);
    fn revive(&self);
    async fn stop(&self);
}

#[async_trait]
impl TunnelHandle for SshTunnel {
    fn local_port(&self) -> u16 {
        SshTunnel::local_port(self)
    }

    fn companion_port(&self) -> u16 {
        SshTunnel::companion_port(self)
    }

    fn state(&self) -> watch::Receiver<TunnelState> {
        SshTunnel::state(self)
    }

    fn restart(&self) {
        SshTunnel::restart(self);
    }

    fn revive(&self) {
        SshTunnel::revive(self);
    }

    async fn stop(&self) {
        SshTunnel::stop(self).await;
    }
}

/// What the session reaches the server through: the bootstrap run over ssh and the supervised tunnel.
#[async_trait]
pub trait Transport: Send + Sync {
    /// Probes the server, installs when needed and makes sure its core serves this desktop's version.
    async fn bootstrap(
        &self,
        model_login: Option<ModelLogin>,
        force_restart: bool,
        progress: &(dyn Fn(BootstrapPhase) + Sync),
    ) -> Result<RemoteReport, ConnectError>;

    /// Starts supervising a tunnel on the current runtime.
    fn open_tunnel(&self, spec: TunnelSpec) -> Arc<dyn TunnelHandle>;
}

/// The transport over this PC's OpenSSH.
pub struct SshTransport {
    pub env: SshEnv,
    pub context: AttemptContext,
    pub target: SshTarget,
    pub payloads: Arc<dyn ServerPayloads + Send>,
}

#[async_trait]
impl Transport for SshTransport {
    async fn bootstrap(
        &self,
        model_login: Option<ModelLogin>,
        force_restart: bool,
        progress: &(dyn Fn(BootstrapPhase) + Sync),
    ) -> Result<RemoteReport, ConnectError> {
        let mut context = self.context.clone();
        context.force_restart = force_restart;
        let options = BootstrapOptions { model_login, payloads: self.payloads.as_ref(), progress };
        bootstrap(&self.env, &context, &self.target, options).await
    }

    fn open_tunnel(&self, spec: TunnelSpec) -> Arc<dyn TunnelHandle> {
        SshTunnel::start(self.env.clone(), Some(self.context.clone()), spec)
    }
}

// ---------------------------------------------------------------------------------------------
// /health through the tunnel
// ---------------------------------------------------------------------------------------------

/// One `GET /health` to 127.0.0.1:`port`; `None` for no answer, a late one, or one that is not the core's `ok`.
pub async fn read_health(port: u16, limit: Duration) -> Option<Health> {
    let started = Instant::now();
    let body = timeout(limit, fetch_health_body(port)).await.ok()??;
    let parsed: Value = serde_json::from_slice(&body).ok()?;
    if parsed.get("status").and_then(Value::as_str) != Some("ok") {
        return None;
    }
    Some(Health {
        rtt_ms: u64::try_from(started.elapsed().as_millis()).unwrap_or(u64::MAX),
        busy: whole_of(parsed.get("busy")),
        pid: u32::try_from(whole_of(parsed.get("pid"))).unwrap_or(0),
        instance_id: parsed.get("instanceId").and_then(Value::as_str).filter(|text| !text.is_empty()).map(str::to_owned),
    })
}

/// `Math.max(0, Number(value) || 0)` as a whole number.
fn whole_of(value: Option<&Value>) -> u64 {
    let number = match value {
        Some(Value::Number(number)) => number.as_f64(),
        Some(Value::String(text)) => text.trim().parse::<f64>().ok(),
        _ => None,
    };
    number.filter(|number| number.is_finite() && *number > 0.0).map_or(0, |number| number as u64)
}

async fn fetch_health_body(port: u16) -> Option<Vec<u8>> {
    let mut stream = TcpStream::connect((LOOPBACK, port)).await.ok()?;
    let request = format!("GET /health HTTP/1.1\r\nHost: {LOOPBACK}:{port}\r\nConnection: close\r\nAccept: application/json\r\n\r\n");
    stream.write_all(request.as_bytes()).await.ok()?;
    let mut raw = Vec::new();
    let mut chunk = [0_u8; 4096];
    loop {
        let count = stream.read(&mut chunk).await.ok()?;
        if count == 0 {
            break;
        }
        raw.extend_from_slice(&chunk[..count]);
        if raw.len() > MAX_HEALTH_BYTES {
            return None;
        }
    }
    http_body(&raw)
}

/// The body of a complete `Connection: close` response, de-chunked when the server chunked it.
fn http_body(raw: &[u8]) -> Option<Vec<u8>> {
    let split = raw.windows(4).position(|window| window == b"\r\n\r\n")?;
    let head = String::from_utf8_lossy(&raw[..split]).to_ascii_lowercase();
    let body = &raw[split + 4..];
    if head.lines().any(|line| line.starts_with("transfer-encoding:") && line.contains("chunked")) {
        return dechunk(body);
    }
    Some(body.to_vec())
}

fn dechunk(mut rest: &[u8]) -> Option<Vec<u8>> {
    let mut out = Vec::new();
    loop {
        let line_end = rest.windows(2).position(|window| window == b"\r\n")?;
        let size_text = std::str::from_utf8(&rest[..line_end]).ok()?;
        let size = usize::from_str_radix(size_text.split(';').next()?.trim(), 16).ok()?;
        rest = &rest[line_end + 2..];
        if size == 0 {
            return Some(out);
        }
        if rest.len() < size + 2 {
            return None;
        }
        out.extend_from_slice(&rest[..size]);
        rest = &rest[size + 2..];
    }
}

// ---------------------------------------------------------------------------------------------
// The session
// ---------------------------------------------------------------------------------------------

struct Slot {
    tunnel: Arc<dyn TunnelHandle>,
    /// The server ports it forwards: the core's session listener and its control listener.
    remotes: (u16, u16),
}

#[derive(Default)]
struct State {
    failure: Option<SessionError>,
    endpoint: Option<Endpoint>,
    identity: Option<Identity>,
    slot: Option<Slot>,
    closed: bool,
    force_restart: bool,
    /// Connects that finished, and how the last one ended: a connect that waited behind another gets that result.
    finished: u64,
    last: Option<Result<Endpoint, SessionError>>,
}

pub struct RemoteSession {
    display: String,
    config: RemoteSessionConfig,
    transport: Arc<dyn Transport>,
    state: Mutex<State>,
    gate: Arc<SerialChain>,
    held: AtomicBool,
}

impl RemoteSession {
    pub fn new(config: RemoteSessionConfig, transport: Arc<dyn Transport>) -> Self {
        let state = State { force_restart: config.force_restart, ..State::default() };
        Self {
            display: config.target.display.trim().to_owned(),
            config,
            transport,
            state: Mutex::new(state),
            gate: SerialChain::new(),
            held: AtomicBool::new(false),
        }
    }

    /// A session over this PC's OpenSSH.
    pub fn over_ssh(config: RemoteSessionConfig, env: SshEnv, context: AttemptContext, payloads: Arc<dyn ServerPayloads + Send>) -> Self {
        let transport = SshTransport { env, context, target: config.target.clone(), payloads };
        Self::new(config, Arc::new(transport))
    }

    pub fn display(&self) -> &str {
        &self.display
    }

    /// The host's grace period in ms, when it has its own.
    pub fn grace_ms(&self) -> Option<u64> {
        self.config.grace_ms
    }

    fn lock(&self) -> MutexGuard<'_, State> {
        self.state.lock().unwrap_or_else(PoisonError::into_inner)
    }

    /// Bootstraps (when needed) and brings the tunnel up. Never starts or touches a local core. A connect that
    /// arrives while another runs gets that one's result.
    pub async fn connect(&self) -> Result<Endpoint, SessionError> {
        let seen = {
            let state = self.lock();
            if let Some(failure) = &state.failure {
                return Err(failure.clone());
            }
            if self.held.load(Ordering::SeqCst) {
                return Err(SessionError::ReconnectOff);
            }
            if state.closed {
                return Err(SessionError::Closed);
            }
            state.finished
        };
        let _turn = self.gate.acquire().await;
        {
            let state = self.lock();
            if state.finished != seen {
                if let Some(result) = &state.last {
                    return result.clone();
                }
            }
        }
        let result = self.establish().await;
        let mut state = self.lock();
        state.finished += 1;
        state.last = Some(result.clone());
        result
    }

    /// The last attachment, for a reconnect check; `None` until connected and after [`RemoteSession::invalidate`].
    pub fn current_endpoint(&self) -> Option<Endpoint> {
        self.lock().endpoint.clone()
    }

    /// Forgets the cached attachment; the next connect re-reads the server.
    pub fn invalidate(&self) {
        self.lock().endpoint = None;
    }

    /// Stops for good on a failure no retry fixes (a protocol mismatch): the tunnel closes and every later connect
    /// rejects with `error`.
    pub fn fail(&self, error: SessionError) {
        let mut state = self.lock();
        state.failure.get_or_insert(error);
        state.endpoint = None;
        // Dropping the handle ends the supervision and its ssh child.
        state.slot = None;
    }

    /// Detach: closes the tunnel, leaves the remote core running.
    pub async fn close(&self) {
        let slot = {
            let mut state = self.lock();
            state.closed = true;
            state.endpoint = None;
            state.slot.take()
        };
        if let Some(slot) = slot {
            slot.tunnel.stop().await;
        }
    }

    /// The failure that stopped this session for good (its tunnel's included).
    pub fn stopped_by(&self) -> Option<SessionError> {
        let state = self.lock();
        let tunnel_failed = state.slot.as_ref().and_then(|slot| tunnel_failure(slot.tunnel.as_ref()));
        state.failure.clone().or_else(|| tunnel_failed.map(SessionError::from))
    }

    /// One `/health` round trip to the attached core through the tunnel, in ms; `None` when there is no attachment,
    /// it times out, or another process answers.
    pub async fn probe_health(&self, limit: Duration) -> Option<u64> {
        self.control_health(limit).await.map(|health| health.rtt_ms)
    }

    /// The attached core's running work, read from its `/health` through the tunnel; `None` when there is no
    /// attachment or another process answers.
    pub async fn busy_sessions(&self) -> Option<u64> {
        self.control_health(BUSY_SESSIONS_TIMEOUT).await.map(|health| health.busy)
    }

    /// Refuses dials (without touching the network) until [`RemoteSession::release`]: the host does not reconnect on
    /// its own.
    pub fn hold(&self) {
        self.held.store(true, Ordering::SeqCst);
    }

    pub fn release(&self) {
        self.held.store(false, Ordering::SeqCst);
    }

    /// Replaces the tunnel's ssh child now (its probes kept failing).
    pub fn reset_tunnel(&self) {
        if let Some(slot) = &self.lock().slot {
            slot.tunnel.restart();
        }
    }

    /// Starts the tunnel's ssh child now when none runs; a live one stays.
    pub fn revive_tunnel(&self) {
        if let Some(slot) = &self.lock().slot {
            slot.tunnel.revive();
        }
    }

    /// Another answer counts as a failed probe; the next attach re-reads the server and checks the core's identity
    /// before any token is sent. The control port is the tunnel's live companion end.
    async fn control_health(&self, limit: Duration) -> Option<Health> {
        let attached = {
            let state = self.lock();
            match (&state.endpoint, &state.slot, &state.identity) {
                (Some(_), Some(slot), Some(identity)) => Some((slot.tunnel.companion_port(), identity.clone())),
                _ => None,
            }
        };
        let (port, identity) = attached?;
        if port == 0 {
            return None;
        }
        let health = read_health(port, limit).await?;
        identity.is_answered_by(&health).then_some(health)
    }

    fn report(&self, phase: SessionPhase) {
        if let Some(progress) = &self.config.progress {
            progress(phase);
        }
    }

    async fn establish(&self) -> Result<Endpoint, SessionError> {
        match self.dial().await {
            Ok(endpoint) => Ok(endpoint),
            Err(error) => {
                // A changed host key, a refused login, an unsupported server or an older desktop will not fix itself:
                // stop dialing until the app restarts, and keep the original words.
                let tunnel_failed = self.lock().slot.as_ref().and_then(|slot| tunnel_failure(slot.tunnel.as_ref()));
                if error.is_terminal() || tunnel_failed.is_some() {
                    self.fail(tunnel_failed.map_or_else(|| error.clone(), SessionError::from));
                }
                Err(error)
            }
        }
    }

    async fn dial(&self) -> Result<Endpoint, SessionError> {
        self.report(SessionPhase::Connect);
        let force_restart = self.lock().force_restart;
        let progress = |phase: BootstrapPhase| {
            self.report(match phase {
                BootstrapPhase::Check { detail } => SessionPhase::Check { detail },
                BootstrapPhase::Install => SessionPhase::Install,
                BootstrapPhase::Start => SessionPhase::Start,
            });
        };
        let report = self.transport.bootstrap(self.config.model_login, force_restart, &progress).await?;
        // The user's confirmation covered this open only: a later reconnect never stops a busy core on its own.
        self.lock().force_restart = false;
        let cwd = resolve_remote_cwd(self.config.remote_cwd.as_deref(), &report.home)?;
        let Some((discovery, rpc_port)) = report.serving() else {
            return Err(SshError::new(format!("The Mixdog core on {} is not serving.", self.display), FailureClass::Transient).into());
        };
        self.report(SessionPhase::Start);
        let tunnel = self.tunnel_to(rpc_port, discovery.control_port).await?;
        if self.lock().closed {
            return Err(SessionError::Closed);
        }
        // Before the core token goes through the tunnel, the process behind it must be the core the probe found: on a
        // shared server another user could have bound the port it freed.
        let identity = Identity { pid: discovery.pid, instance_id: discovery.instance_id.clone() };
        let Some(health) = read_health(tunnel.companion_port(), IDENTITY_CHECK_TIMEOUT).await else {
            return Err(SshError::new(format!("The Mixdog core on {} does not answer through the ssh tunnel.", self.display), FailureClass::Transient).into());
        };
        if !identity.is_answered_by(&health) {
            return Err(identity_error(&self.display).into());
        }
        self.report(SessionPhase::Ready);
        let endpoint = Endpoint {
            url: format!("ws://{LOOPBACK}:{}/rpc", tunnel.local_port()),
            token: discovery.token.clone(),
            server_instance_id: discovery.instance_id.clone(),
            pid: discovery.pid,
            cwd,
            core_version: discovery.version.clone(),
        };
        let mut state = self.lock();
        state.identity = Some(identity);
        state.endpoint = Some(endpoint.clone());
        Ok(endpoint)
    }

    /// The tunnel to the core's two listeners, ready. The same ports reuse the supervised tunnel (started again when
    /// none runs); a core that moved gets a new one from scratch.
    async fn tunnel_to(&self, rpc_port: u16, control_port: u16) -> Result<Arc<dyn TunnelHandle>, SessionError> {
        let remotes = (rpc_port, control_port);
        let reusable = {
            let state = self.lock();
            if state.closed {
                return Err(SessionError::Closed);
            }
            state.slot.as_ref().filter(|slot| slot.remotes == remotes).map(|slot| slot.tunnel.clone())
        };
        let (tunnel, revived) = match reusable {
            Some(tunnel) => {
                let revived = stopped_without_failure(tunnel.as_ref());
                if revived {
                    tunnel.revive();
                }
                (tunnel, revived)
            }
            None => {
                let old = self.lock().slot.take();
                if let Some(old) = old {
                    old.tunnel.stop().await;
                }
                let tunnel = self.transport.open_tunnel(self.spec(remotes));
                self.lock().slot = Some(Slot { tunnel: tunnel.clone(), remotes });
                (tunnel, false)
            }
        };
        self.wait_up(tunnel.as_ref(), revived).await?;
        Ok(tunnel)
    }

    fn spec(&self, (rpc_port, control_port): (u16, u16)) -> TunnelSpec {
        let forward = |remote_port| LocalForward { local: 0, remote_host: LOOPBACK.to_owned(), remote_port };
        let mut forwards = vec![forward(rpc_port)];
        if control_port != 0 {
            forwards.push(forward(control_port));
        }
        TunnelSpec { target: self.config.target.clone(), local_port: None, forwards }
    }

    /// Waits through supervised restarts until the tunnel accepts connections. `revived`: a start was just asked for
    /// a tunnel that stood stopped, which does not count as an answer.
    async fn wait_up(&self, tunnel: &dyn TunnelHandle, revived: bool) -> Result<(), SessionError> {
        let limit = self.config.tunnel_ready_timeout.unwrap_or(DEFAULT_TUNNEL_READY_TIMEOUT);
        let mut state = tunnel.state();
        let reached = timeout(
            limit,
            state.wait_for(|now| match now {
                TunnelState::Up | TunnelState::Stopped { failure: Some(_) } => true,
                TunnelState::Stopped { failure: None } => !revived,
                _ => false,
            }),
        )
        .await;
        let now = match reached {
            Ok(Ok(now)) => (*now).clone(),
            _ => {
                let message = format!("The ssh tunnel to {} is not ready after {} ms.", self.display, limit.as_millis());
                return Err(SshError::new(message, FailureClass::Transient).into());
            }
        };
        match now {
            TunnelState::Up => Ok(()),
            TunnelState::Stopped { failure: Some(failure) } => Err(failure.into()),
            _ => Err(SshError::new(format!("The ssh tunnel to {} is closed.", self.display), FailureClass::Transient).into()),
        }
    }
}

/// The terminal failure the tunnel stopped with, if it did.
fn tunnel_failure(tunnel: &dyn TunnelHandle) -> Option<SshError> {
    let state = tunnel.state();
    let now = state.borrow();
    let failure = match &*now {
        TunnelState::Stopped { failure } => failure.clone(),
        _ => None,
    };
    failure
}

/// No child runs and none will start by itself (a stop, or a link that dropped with automatic reconnection off).
fn stopped_without_failure(tunnel: &dyn TunnelHandle) -> bool {
    let state = tunnel.state();
    let now = state.borrow();
    let stopped = matches!(&*now, TunnelState::Stopped { failure: None });
    stopped
}

#[cfg(test)]
#[path = "session_tests.rs"]
mod session_tests;
