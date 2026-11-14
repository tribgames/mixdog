//! The Ports panel of one server connection: what listens on the server (the `ports` feed of its daemon), and the server ports
//! forwarded to this PC. Each forward is its own supervised `ssh -N -L 127.0.0.1:<local>:127.0.0.1:<remote>` child
//! ([`SshTunnel`]), bound to this PC's loopback only. Forwards are saved per server and started again when the connection comes
//! back; a port that starts listening later is only suggested, never forwarded on its own.

use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet};
use std::future::Future;
use std::hash::Hash;
use std::io;
use std::net::{Ipv4Addr, TcpListener};
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};
use std::time::Duration;

use async_trait::async_trait;
use mixdog_app_protocol::v2::connections::{PortForward, PortForwardStatus, ServerPort, ServerPortsView};
use mixdog_rt::time::timeout;
use mixdog_ssh::command::SshTarget;
use mixdog_ssh::context::{AttemptContext, SshEnv};
use mixdog_ssh::tunnel::{free_local_port, local_port_accepts, LocalForward, SshTunnel, TunnelSpec, TunnelState};
use tokio::sync::watch;
use tokio::task::{JoinHandle, JoinSet};

use crate::port_forward_store::{PortForwardStore, SavedPortForward};

/// How long a new forward may take before the panel shows it as failing.
const FORWARD_READY_TIMEOUT: Duration = Duration::from_millis(30_000);
/// Ports below this on this PC are never bound (they need elevation).
pub const LOWEST_LOCAL_PORT: u16 = 1024;
const LOOPBACK: &str = "127.0.0.1";

/// A port the server listens on, as the `ports` feed reports it.
pub type ListeningPort = ServerPort;
/// One forward as the panel shows it.
pub type PortForwardLite = PortForward;
/// The whole panel: detected ports, forwards and suggestions.
pub type PortsViewLite = ServerPortsView;

/// Where a connection's listening ports come from: a watch holding the last list the server's feed pushed (it holds the first scan
/// from the moment it exists; that first list is what was listening before the panel looked).
pub trait PortsSource: Send + Sync {
    fn ports(&self) -> watch::Receiver<Vec<ListeningPort>>;
}

/// The ssh target of the server and the settings its ssh runs use (identity file, automatic reconnection), read at every start.
pub type ContextSource = Arc<dyn Fn() -> (SshTarget, Option<AttemptContext>) + Send + Sync>;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PortErrorCode {
    PortInvalid,
    PortPrivileged,
    PortBusy,
    PortNotActive,
    WindowClosed,
}

impl PortErrorCode {
    /// The code the panel shows in the user's language.
    pub fn as_str(self) -> &'static str {
        match self {
            Self::PortInvalid => "port-invalid",
            Self::PortPrivileged => "port-privileged",
            Self::PortBusy => "port-busy",
            Self::PortNotActive => "port-not-active",
            Self::WindowClosed => "window-closed",
        }
    }
}

/// A refused or failed port request; the code leads the message (`port-busy: Port 5173 ...`).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PortError {
    pub code: PortErrorCode,
    pub message: String,
}

impl PortError {
    fn new(code: PortErrorCode, message: impl Into<String>) -> Self {
        Self { code, message: message.into() }
    }
}

impl std::fmt::Display for PortError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}: {}", self.code.as_str(), self.message)
    }
}

impl std::error::Error for PortError {}

/// The parts of a supervised ssh tunnel a forward uses.
#[async_trait]
pub(crate) trait ForwardTunnel: Send + Sync {
    fn local_port(&self) -> u16;
    fn state(&self) -> watch::Receiver<TunnelState>;
    fn revive(&self);
    async fn stop(&self);
}

#[async_trait]
impl ForwardTunnel for SshTunnel {
    fn local_port(&self) -> u16 {
        SshTunnel::local_port(self)
    }

    fn state(&self) -> watch::Receiver<TunnelState> {
        SshTunnel::state(self)
    }

    fn revive(&self) {
        SshTunnel::revive(self);
    }

    async fn stop(&self) {
        SshTunnel::stop(self).await;
    }
}

/// Starts one ssh forward: `local` is its first local port (kept across its restarts while free).
pub(crate) trait TunnelFactory: Send + Sync {
    fn start(&self, local: u16, remote: u16) -> Arc<dyn ForwardTunnel>;
}

struct SshTunnels {
    env: SshEnv,
    context: ContextSource,
}

impl TunnelFactory for SshTunnels {
    fn start(&self, local: u16, remote: u16) -> Arc<dyn ForwardTunnel> {
        let (target, ctx) = (self.context)();
        let forward = LocalForward { local, remote_host: LOOPBACK.to_owned(), remote_port: remote };
        SshTunnel::start(self.env.clone(), ctx, TunnelSpec { target, local_port: Some(local), forwards: vec![forward] })
    }
}

/// The ports of this PC's loopback.
#[async_trait]
pub(crate) trait LocalPorts: Send + Sync {
    /// Nothing accepts there and it can be bound.
    async fn is_free(&self, port: u16) -> bool;
    fn free_port(&self) -> io::Result<u16>;
}

struct LoopbackPorts;

#[async_trait]
impl LocalPorts for LoopbackPorts {
    async fn is_free(&self, port: u16) -> bool {
        !local_port_accepts(port).await && TcpListener::bind((Ipv4Addr::LOCALHOST, port)).is_ok()
    }

    fn free_port(&self) -> io::Result<u16> {
        free_local_port()
    }
}

/// One request at a time per key: a second caller joins the first and gets its result.
struct Flights<K, T> {
    running: Mutex<HashMap<K, watch::Receiver<Option<T>>>>,
}

impl<K: Hash + Eq + Clone + Send + 'static, T: Clone + Send + Sync + 'static> Flights<K, T> {
    fn new() -> Arc<Self> {
        Arc::new(Self { running: Mutex::new(HashMap::new()) })
    }

    fn lock(&self) -> MutexGuard<'_, HashMap<K, watch::Receiver<Option<T>>>> {
        self.running.lock().unwrap_or_else(PoisonError::into_inner)
    }

    /// The running request of `key`, or the one `work` starts (on its own task, so a caller that goes away does not cancel it).
    fn join<F: Future<Output = T> + Send + 'static>(self: &Arc<Self>, key: K, work: impl FnOnce() -> F) -> watch::Receiver<Option<T>> {
        let mut running = self.lock();
        if let Some(receiver) = running.get(&key) {
            return receiver.clone();
        }
        let (sender, receiver) = watch::channel(None);
        running.insert(key.clone(), receiver.clone());
        let flights = self.clone();
        let work = work();
        tokio::spawn(async move {
            let result = work.await;
            sender.send_replace(Some(result));
            flights.lock().remove(&key);
        });
        receiver
    }

    fn running(&self, key: &K) -> Option<watch::Receiver<Option<T>>> {
        self.lock().get(key).cloned()
    }
}

/// The result of a request, or none when its task was torn down.
async fn finished<T: Clone>(mut receiver: watch::Receiver<Option<T>>) -> Option<T> {
    let reached = receiver.wait_for(Option::is_some).await;
    reached.ok().and_then(|value| value.clone())
}

#[derive(Clone)]
struct Forward {
    /// The port the user asked for (kept), or the one chosen.
    preferred: u16,
    tunnel: Arc<dyn ForwardTunnel>,
    /// A start that did not get ready in time (the tunnel keeps trying).
    last_error: Option<String>,
}

impl Forward {
    fn local_port(&self) -> u16 {
        match self.tunnel.local_port() {
            0 => self.preferred,
            bound => bound,
        }
    }
}

fn tunnel_state(tunnel: &dyn ForwardTunnel) -> TunnelState {
    let state = tunnel.state();
    let now = state.borrow().clone();
    now
}

fn failure_of(tunnel: &dyn ForwardTunnel) -> Option<String> {
    match tunnel_state(tunnel) {
        TunnelState::Stopped { failure: Some(error) } => Some(error.message),
        _ => None,
    }
}

fn forward_view(remote_port: u16, entry: &Forward) -> PortForward {
    let local_port = entry.local_port();
    let (status, message) = match tunnel_state(entry.tunnel.as_ref()) {
        TunnelState::Stopped { failure: Some(error) } => (PortForwardStatus::Error, Some(error.message)),
        TunnelState::Up => (PortForwardStatus::Active, None),
        _ => match &entry.last_error {
            Some(message) => (PortForwardStatus::Error, Some(message.clone())),
            None => (PortForwardStatus::Starting, None),
        },
    };
    PortForward { remote_port, local_port, status, message }
}

#[derive(Default)]
struct State {
    forwards: BTreeMap<u16, Forward>,
    detected: Option<Vec<ListeningPort>>,
    /// Every port seen since the first scan; a port not in it is new.
    known: Option<HashSet<u16>>,
    suggested: BTreeSet<u16>,
    dismissed: HashSet<u16>,
    disposed: bool,
    follower: Option<JoinHandle<()>>,
}

impl State {
    /// Ports worth offering: ones that started listening after the first scan, minus those forwarded, dismissed or no longer
    /// listening.
    fn update_suggestions(&mut self, ports: &[ListeningPort]) {
        let listening: HashSet<u16> = ports.iter().map(|port| port.port).collect();
        match &mut self.known {
            Some(known) => {
                for port in &listening {
                    if !known.contains(port) {
                        self.suggested.insert(*port);
                    }
                }
                known.extend(listening.iter().copied());
            }
            None => self.known = Some(listening.clone()),
        }
        let (forwards, dismissed) = (&self.forwards, &self.dismissed);
        self.suggested.retain(|port| listening.contains(port) && !forwards.contains_key(port) && !dismissed.contains(port));
    }

    fn view(&self) -> PortsViewLite {
        PortsViewLite {
            detected: self.detected.clone(),
            scan_error: None,
            forwards: self.forwards.iter().map(|(remote, entry)| forward_view(*remote, entry)).collect(),
            suggested: self.suggested.iter().copied().collect(),
        }
    }
}

struct Inner {
    host_id: String,
    store: Arc<PortForwardStore>,
    tunnels: Arc<dyn TunnelFactory>,
    local: Arc<dyn LocalPorts>,
    ready_timeout: Duration,
    state: Mutex<State>,
    view: watch::Sender<PortsViewLite>,
    forwarding: Arc<Flights<u16, Result<PortForward, PortError>>>,
    restoring: Arc<Flights<(), ()>>,
}

/// The Ports panel model of one server connection.
#[derive(Clone)]
pub struct ServerPortForwards {
    inner: Arc<Inner>,
}

impl ServerPortForwards {
    pub fn new(env: SshEnv, ctx_source: ContextSource, host_id: impl Into<String>, store: Arc<PortForwardStore>) -> Self {
        Self::with_parts(host_id.into(), store, Arc::new(SshTunnels { env, context: ctx_source }), Arc::new(LoopbackPorts), FORWARD_READY_TIMEOUT)
    }

    pub(crate) fn with_parts(
        host_id: String,
        store: Arc<PortForwardStore>,
        tunnels: Arc<dyn TunnelFactory>,
        local: Arc<dyn LocalPorts>,
        ready_timeout: Duration,
    ) -> Self {
        let state = State::default();
        let (view, _) = watch::channel(state.view());
        Self {
            inner: Arc::new(Inner {
                host_id,
                store,
                tunnels,
                local,
                ready_timeout,
                state: Mutex::new(state),
                view,
                forwarding: Flights::new(),
                restoring: Flights::new(),
            }),
        }
    }

    /// The panel now.
    pub fn list(&self) -> PortsViewLite {
        self.inner.lock().view()
    }

    /// The panel, again after every change.
    pub fn view(&self) -> watch::Receiver<PortsViewLite> {
        self.inner.view.subscribe()
    }

    /// The server's listening ports as the `ports` feed last pushed them.
    pub fn update(&self, ports: Vec<ListeningPort>) {
        self.inner.update(ports);
    }

    /// Follows a source: every list it pushes is an [`ServerPortForwards::update`] (until [`ServerPortForwards::close_all`]).
    pub fn follow(&self, source: &dyn PortsSource) {
        let mut ports = source.ports();
        let inner = self.inner.clone();
        let task = tokio::spawn(async move {
            loop {
                let list = ports.borrow_and_update().clone();
                inner.update(list);
                if ports.changed().await.is_err() {
                    return;
                }
            }
        });
        if let Some(previous) = self.inner.lock().follower.replace(task) {
            previous.abort();
        }
    }

    /// Forwards a server port to this PC: the asked-for local port is used as is or refused; without one, the server's own number
    /// when it is free here, else any free port. A second request for a forwarded port joins it.
    pub async fn forward(&self, remote_port: u16, local_port: Option<u16>) -> Result<PortForwardLite, PortError> {
        let inner = self.inner.clone();
        let pending = self.inner.forwarding.join(remote_port, move || async move { inner.create_forward(remote_port, local_port).await });
        finished(pending).await.unwrap_or_else(|| Err(PortError::new(PortErrorCode::WindowClosed, "The server window is closed.")))
    }

    /// Stops a forward and forgets it (the saved list loses it).
    pub async fn stop(&self, remote_port: u16) {
        if let Some(pending) = self.inner.forwarding.running(&remote_port) {
            finished(pending).await;
        }
        let removed = self.inner.lock().forwards.remove(&remote_port);
        let Some(entry) = removed else { return };
        entry.tunnel.stop().await;
        self.inner.persist().await;
        self.inner.emit();
    }

    /// Stops offering a port.
    pub fn dismiss(&self, port: u16) {
        {
            let mut state = self.inner.lock();
            state.dismissed.insert(port);
            state.suggested.remove(&port);
        }
        self.inner.emit();
    }

    /// `http://127.0.0.1:<local>/` of an active forward.
    pub fn browser_url(&self, remote_port: u16) -> Result<String, PortError> {
        let active = self.inner.lock().forwards.get(&remote_port).filter(|entry| tunnel_state(entry.tunnel.as_ref()) == TunnelState::Up).map(Forward::local_port);
        match active {
            Some(port) if port != 0 => Ok(format!("http://{LOOPBACK}:{port}/")),
            _ => Err(PortError::new(PortErrorCode::PortNotActive, format!("Port {remote_port} is not forwarded to this PC right now."))),
        }
    }

    /// Starts the saved forwards that do not run, and wakes the ones waiting to retry. Startup and a reconnect may both ask; they
    /// share one pass.
    pub async fn restore(&self) {
        let inner = self.inner.clone();
        let pass = self.inner.restoring.join((), move || async move { inner.restore_saved().await });
        finished(pass).await;
    }

    /// Stops every forward of this connection (the window closed); the saved list stays and later requests are refused.
    pub async fn close_all(&self) {
        let closing: Vec<Forward> = {
            let mut state = self.inner.lock();
            state.disposed = true;
            if let Some(follower) = state.follower.take() {
                follower.abort();
            }
            std::mem::take(&mut state.forwards).into_values().collect()
        };
        let mut stops = JoinSet::new();
        for entry in closing {
            stops.spawn(async move { entry.tunnel.stop().await });
        }
        while stops.join_next().await.is_some() {}
    }
}

impl Inner {
    fn lock(&self) -> MutexGuard<'_, State> {
        self.state.lock().unwrap_or_else(PoisonError::into_inner)
    }

    fn emit(&self) {
        let state = self.lock();
        if !state.disposed {
            self.view.send_replace(state.view());
        }
    }

    fn update(&self, ports: Vec<ListeningPort>) {
        {
            let mut state = self.lock();
            state.update_suggestions(&ports);
            state.detected = Some(ports);
        }
        self.emit();
    }

    async fn persist(&self) {
        let saved: Vec<SavedPortForward> =
            self.lock().forwards.iter().map(|(remote, entry)| SavedPortForward { remote_port: *remote, local_port: entry.local_port() }).collect();
        if let Err(error) = self.store.set(&self.host_id, &saved).await {
            tracing::warn!(host = %self.host_id, %error, "the port forwards could not be saved");
        }
    }

    /// The asked-for local port must be usable as is; without one, the server's own number when it is free here, else any free port.
    async fn choose_local_port(&self, remote: u16, requested: Option<u16>, strict: bool) -> Result<u16, PortError> {
        if let (Some(port), true) = (requested, strict) {
            if port < LOWEST_LOCAL_PORT {
                return Err(PortError::new(
                    PortErrorCode::PortPrivileged,
                    format!("Ports below {LOWEST_LOCAL_PORT} on this PC are not used for forwarding."),
                ));
            }
            if !self.local.is_free(port).await {
                return Err(PortError::new(PortErrorCode::PortBusy, format!("Port {port} on this PC is already in use.")));
            }
            return Ok(port);
        }
        let candidate = requested.unwrap_or(remote);
        if candidate >= LOWEST_LOCAL_PORT && self.local.is_free(candidate).await {
            return Ok(candidate);
        }
        self.local.free_port().map_err(|error| PortError::new(PortErrorCode::PortBusy, format!("No free port on this PC: {error}.")))
    }

    /// Starts the ssh forward and waits for it to get ready; a start that fails or is late leaves the forward in the panel as an
    /// error (the tunnel keeps trying).
    async fn start_forward(self: &Arc<Self>, remote: u16, local: u16) -> Forward {
        let tunnel = self.tunnels.start(local, remote);
        let entry = Forward { preferred: local, tunnel: tunnel.clone(), last_error: None };
        self.lock().forwards.insert(remote, entry);
        self.emit();
        let mut changes = tunnel.state();
        let inner = self.clone();
        tokio::spawn(async move {
            while changes.changed().await.is_ok() {
                inner.emit();
            }
        });
        let last_error = self.ready(tunnel.as_ref()).await.err();
        let started = {
            let mut state = self.lock();
            match state.forwards.get_mut(&remote).filter(|current| Arc::ptr_eq(&current.tunnel, &tunnel)) {
                Some(current) => {
                    current.last_error.clone_from(&last_error);
                    current.clone()
                }
                None => Forward { preferred: local, tunnel, last_error },
            }
        };
        self.emit();
        started
    }

    async fn ready(&self, tunnel: &dyn ForwardTunnel) -> Result<(), String> {
        let mut state = tunnel.state();
        let reached = timeout(self.ready_timeout, state.wait_for(|now| matches!(now, TunnelState::Up | TunnelState::Stopped { failure: Some(_) }))).await;
        match reached {
            Ok(Ok(now)) => match &*now {
                TunnelState::Stopped { failure: Some(error) } => Err(error.message.clone()),
                _ => Ok(()),
            },
            Ok(Err(_)) => Err("The ssh tunnel is closed.".to_owned()),
            Err(_) => Err(format!("The ssh tunnel is not ready after {} ms.", self.ready_timeout.as_millis())),
        }
    }

    async fn create_forward(self: &Arc<Self>, remote: u16, local: Option<u16>) -> Result<PortForward, PortError> {
        if self.lock().disposed {
            return Err(PortError::new(PortErrorCode::WindowClosed, "The server window is closed."));
        }
        if remote == 0 {
            return Err(PortError::new(PortErrorCode::PortInvalid, "Choose a server port between 1 and 65535."));
        }
        if local == Some(0) {
            return Err(PortError::new(PortErrorCode::PortInvalid, format!("Choose a local port between {LOWEST_LOCAL_PORT} and 65535.")));
        }
        let failed = {
            let mut state = self.lock();
            let existing = state.forwards.get(&remote).map(|entry| (failure_of(entry.tunnel.as_ref()).is_some(), forward_view(remote, entry)));
            match existing {
                Some((false, view)) => return Ok(view),
                Some((true, _)) => state.forwards.remove(&remote),
                None => None,
            }
        };
        if let Some(failed) = failed {
            failed.tunnel.stop().await;
        }
        let chosen = self.choose_local_port(remote, local, local.is_some()).await?;
        self.lock().suggested.remove(&remote);
        let entry = self.start_forward(remote, chosen).await;
        self.persist().await;
        Ok(forward_view(remote, &entry))
    }

    async fn restore_saved(self: &Arc<Self>) {
        if self.lock().disposed {
            return;
        }
        let saved = match self.store.get(&self.host_id).await {
            Ok(saved) => saved,
            Err(error) => {
                tracing::warn!(host = %self.host_id, %error, "the saved port forwards could not be read");
                return;
            }
        };
        let mut starts = JoinSet::new();
        for SavedPortForward { remote_port, local_port } in saved {
            if self.forwarding.running(&remote_port).is_some() {
                continue;
            }
            let failed = {
                let mut state = self.lock();
                let existing = state.forwards.get(&remote_port).map(|entry| (failure_of(entry.tunnel.as_ref()).is_some(), entry.tunnel.clone()));
                match existing {
                    Some((false, tunnel)) => {
                        // Running or waiting out its retry delay: try now (a live child is left alone).
                        tunnel.revive();
                        continue;
                    }
                    Some((true, _)) => state.forwards.remove(&remote_port),
                    None => None,
                }
            };
            if let Some(failed) = failed {
                failed.tunnel.stop().await;
            }
            let inner = self.clone();
            starts.spawn(async move {
                let Ok(port) = inner.choose_local_port(remote_port, Some(local_port), false).await else { return };
                let skip = {
                    let state = inner.lock();
                    state.disposed || state.forwards.contains_key(&remote_port)
                };
                if !skip {
                    inner.start_forward(remote_port, port).await;
                }
            });
        }
        while starts.join_next().await.is_some() {}
        self.emit();
    }
}

#[cfg(test)]
#[path = "port_forwards_tests.rs"]
mod tests;
