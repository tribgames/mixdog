//! The supervised `ssh -N -L` child: one task owns the child, keeps the same local port across restarts (an attached
//! client's stream simply reconnects through the new child), restarts on the [`TunnelBackoff`] schedule, and stops for
//! good on a terminal failure (a changed host key, a refused login, a client that is not installed).
//!
//! Every forward binds 127.0.0.1 only (`tunnel_args` writes the bind address), and a forward's remote end is the
//! loopback of the server.

use std::io;
use std::net::Ipv4Addr;
use std::sync::atomic::{AtomicU16, Ordering};
use std::sync::{Arc, Mutex, PoisonError};
use std::time::Duration;

use mixdog_rt::time::{sleep, timeout, Instant};
use tokio::io::{AsyncRead, AsyncReadExt};
use tokio::net::TcpStream;
use tokio::sync::{mpsc, watch};
use tokio::task::JoinHandle;

use crate::binary::missing_client_message;
use crate::command::{
    classify_failure, is_local_forward_bind_failure, stderr_tail_default, tunnel_args, FailureClass, SshError, SshTarget, TunnelBackoff,
};
use crate::context::{AttemptContext, SshEnv};
use crate::spawn::spawn_ssh;

/// A tunnel that never accepts a connection is killed (and restarted).
const READY_DEADLINE: Duration = Duration::from_millis(40_000);
const READY_POLL: Duration = Duration::from_millis(150);
/// How long the ssh child's stderr is read after it ended.
const STDERR_SETTLE: Duration = Duration::from_secs(2);
/// Bytes kept of ssh's stderr.
const STDERR_KEEP_BYTES: usize = 16 * 1024;
/// The forwards one ssh child can carry: the daemon's session port and its companion (the control listener).
const MAX_FORWARDS: usize = 2;
const LOOPBACK: &str = "127.0.0.1";

/// One `-L`: the local port (0: chosen here) forwarded to `remote_host:remote_port` on the server.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct LocalForward {
    pub local: u16,
    pub remote_host: String,
    pub remote_port: u16,
}

/// What to supervise. The first forward is the primary one: `local_port` (when set) is its local port, and
/// [`SshTunnel::local_port`] names it. A second forward rides the same ssh child.
#[derive(Clone, Debug)]
pub struct TunnelSpec {
    pub target: SshTarget,
    pub local_port: Option<u16>,
    pub forwards: Vec<LocalForward>,
}

/// Where the supervision stands.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum TunnelState {
    /// A child is starting and has not accepted a connection yet.
    Starting,
    /// A child runs and accepts connections on the local port.
    Up,
    /// The child exited; the next start is `next_ms` away (`attempt` counts the exits since the tunnel was last up).
    Backoff { attempt: u32, next_ms: u64 },
    /// No child runs and none will start by itself: `failure` is the terminal failure, or none after [`SshTunnel::stop`]
    /// and after a link that dropped with automatic reconnection off (only `restart` and `revive` start it again).
    Stopped { failure: Option<SshError> },
}

enum Command {
    Restart,
    Revive,
    Stop,
}

/// The delays of one supervision, replaceable by the tests.
#[derive(Clone)]
pub(crate) struct Timing {
    pub backoff: TunnelBackoff,
    pub ready_deadline: Duration,
    pub ready_poll: Duration,
}

impl Default for Timing {
    fn default() -> Self {
        Self { backoff: TunnelBackoff::new(), ready_deadline: READY_DEADLINE, ready_poll: READY_POLL }
    }
}

/// Resolves true once something accepts connections on 127.0.0.1:`port`.
pub async fn local_port_accepts(port: u16) -> bool {
    matches!(timeout(Duration::from_secs(1), TcpStream::connect((Ipv4Addr::LOCALHOST, port))).await, Ok(Ok(_)))
}

/// A free loopback port the user's browser can open: never one a fetch client or Chromium refuses.
pub fn free_local_port() -> io::Result<u16> {
    let listener = mixdog_workspace::pageserver::ports::bind_loopback(None)?;
    Ok(listener.local_addr()?.port())
}

/// Reads a stream to its end in the background so the child never blocks on a full pipe, keeping the last
/// [`STDERR_KEEP_BYTES`] bytes in `keep` when given.
pub(crate) fn pump(stream: Option<Box<dyn AsyncRead + Send + Unpin>>, keep: Option<Arc<Mutex<Vec<u8>>>>) -> Option<JoinHandle<()>> {
    let mut stream = stream?;
    Some(tokio::spawn(async move {
        let mut buffer = vec![0_u8; 8 * 1024];
        loop {
            match stream.read(&mut buffer).await {
                Ok(0) | Err(_) => return,
                Ok(count) => {
                    if let Some(keep) = &keep {
                        let mut kept = keep.lock().unwrap_or_else(PoisonError::into_inner);
                        kept.extend_from_slice(&buffer[..count]);
                        if kept.len() > STDERR_KEEP_BYTES {
                            let excess = kept.len() - STDERR_KEEP_BYTES;
                            kept.drain(..excess);
                        }
                    }
                }
            }
        }
    }))
}

/// The handle of a supervised tunnel. Dropping it stops the supervision and the child.
pub struct SshTunnel {
    commands: mpsc::UnboundedSender<Command>,
    state: watch::Receiver<TunnelState>,
    local_port: Arc<AtomicU16>,
    companion_port: Arc<AtomicU16>,
}

impl SshTunnel {
    /// Starts supervising on the current runtime. A spec ssh cannot carry (no forward, more than two, a remote host
    /// other than the server's loopback) is a terminal failure at once, readable from [`SshTunnel::state`].
    pub fn start(env: SshEnv, ctx: Option<AttemptContext>, spec: TunnelSpec) -> Arc<Self> {
        Self::start_with(env, ctx, spec, Timing::default())
    }

    pub(crate) fn start_with(env: SshEnv, ctx: Option<AttemptContext>, spec: TunnelSpec, timing: Timing) -> Arc<Self> {
        let (commands, receiver) = mpsc::unbounded_channel();
        let local_port = Arc::new(AtomicU16::new(0));
        let companion_port = Arc::new(AtomicU16::new(0));
        let invalid = invalid_spec(&spec);
        let (state, state_rx) = watch::channel(match &invalid {
            Some(error) => TunnelState::Stopped { failure: Some(error.clone()) },
            None => TunnelState::Starting,
        });
        if invalid.is_none() {
            let locals = spec
                .forwards
                .iter()
                .enumerate()
                .map(|(index, forward)| if index == 0 { spec.local_port.filter(|port| *port != 0).unwrap_or(forward.local) } else { forward.local })
                .collect();
            let auto_restart = ctx.as_ref().and_then(|attempt| attempt.settings.as_ref()).and_then(|settings| settings.auto_reconnect).unwrap_or(true);
            let supervisor = Supervisor {
                env,
                ctx,
                target: spec.target,
                remotes: spec.forwards.iter().map(|forward| forward.remote_port).collect(),
                locals,
                timing,
                auto_restart,
                attempt: 0,
                state,
                primary: local_port.clone(),
                companion: companion_port.clone(),
                commands: receiver,
            };
            tokio::spawn(supervisor.run());
        }
        Arc::new(Self { commands, state: state_rx, local_port, companion_port })
    }

    /// The local end of the primary forward (0 before the first is chosen); it changes only when a restart finds it
    /// taken.
    pub fn local_port(&self) -> u16 {
        self.local_port.load(Ordering::Acquire)
    }

    /// The local end of the second forward (the companion riding the same child; 0 without one or before it is
    /// chosen); like [`SshTunnel::local_port`] it changes only when a restart finds it taken.
    pub fn companion_port(&self) -> u16 {
        self.companion_port.load(Ordering::Acquire)
    }

    pub fn state(&self) -> watch::Receiver<TunnelState> {
        self.state.clone()
    }

    /// Replaces the ssh child now, with a fresh backoff: for a link whose health probes keep failing although the
    /// child has not exited. Has no effect after a terminal failure or a stop.
    pub fn restart(&self) {
        let _ = self.commands.send(Command::Restart);
    }

    /// Starts a child now when none runs (one waiting out its restart delay, or a link that dropped with automatic
    /// reconnection off); a running child is left alone.
    pub fn revive(&self) {
        let _ = self.commands.send(Command::Revive);
    }

    /// Ends the child and the supervision; resolves once the child is gone.
    pub async fn stop(&self) {
        let _ = self.commands.send(Command::Stop);
        let mut state = self.state.clone();
        let _ = state.wait_for(|now| matches!(now, TunnelState::Stopped { .. })).await;
    }
}

fn invalid_spec(spec: &TunnelSpec) -> Option<SshError> {
    let reason = if spec.forwards.is_empty() {
        "a tunnel needs a forward".to_owned()
    } else if spec.forwards.len() > MAX_FORWARDS {
        format!("a tunnel carries at most {MAX_FORWARDS} forwards")
    } else if let Some(forward) = spec.forwards.iter().find(|forward| forward.remote_host != LOOPBACK) {
        format!("a forward reaches {LOOPBACK} on the server only, not {}", forward.remote_host)
    } else {
        return None;
    };
    Some(SshError::new(format!("Cannot start the ssh tunnel to {}: {reason}.", spec.target.display), FailureClass::Terminal))
}

/// How one child's run ended.
enum Ended {
    Exited { stderr: String, status: String, code: Option<i32>, healthy_for: Duration },
    Restart,
    Stop,
    Fatal(SshError),
}

enum Pause {
    Elapsed,
    Now,
    Stop,
}

struct Supervisor {
    env: SshEnv,
    ctx: Option<AttemptContext>,
    target: SshTarget,
    remotes: Vec<u16>,
    /// The local port of each forward (0: to be chosen).
    locals: Vec<u16>,
    timing: Timing,
    auto_restart: bool,
    attempt: u32,
    state: watch::Sender<TunnelState>,
    primary: Arc<AtomicU16>,
    companion: Arc<AtomicU16>,
    commands: mpsc::UnboundedReceiver<Command>,
}

impl Supervisor {
    fn set(&self, state: TunnelState) {
        self.state.send_replace(state);
    }

    /// A line of the tunnel's account of itself, into the server's diagnostics ring.
    fn log(&self, text: &str) {
        self.env.diagnostics.log(self.ctx.as_ref().and_then(|attempt| attempt.diagnostics_key.as_deref()), text);
    }

    fn choose_ports(&mut self) -> io::Result<()> {
        for index in 0..self.locals.len() {
            while self.locals[index] == 0 {
                let port = free_local_port()?;
                if !self.locals.contains(&port) {
                    self.locals[index] = port;
                }
            }
        }
        self.primary.store(self.locals[0], Ordering::Release);
        self.companion.store(self.locals.get(1).copied().unwrap_or(0), Ordering::Release);
        Ok(())
    }

    async fn run(mut self) {
        let mut backoff = self.timing.backoff.clone();
        loop {
            self.set(TunnelState::Starting);
            match self.run_child().await {
                Ended::Stop => {
                    self.set(TunnelState::Stopped { failure: None });
                    return;
                }
                Ended::Fatal(error) => {
                    self.log(&format!("ssh tunnel stopped: {error}"));
                    self.set(TunnelState::Stopped { failure: Some(error) });
                    return;
                }
                Ended::Restart => {
                    self.log("ssh tunnel restarting now (health probes failed)");
                    backoff.reset();
                    self.attempt = 0;
                }
                Ended::Exited { stderr, status, code, healthy_for } => {
                    let tail = stderr_tail_default(&stderr);
                    if classify_failure(&stderr) == FailureClass::Terminal {
                        let reason = if tail.is_empty() { status } else { tail.clone() };
                        let error = SshError::new(format!("ssh tunnel to {} failed:\n{reason}", self.target.display), FailureClass::Terminal).with_stderr(tail, code);
                        self.log(&format!("ssh tunnel stopped: {error}"));
                        self.set(TunnelState::Stopped { failure: Some(error) });
                        return;
                    }
                    if is_local_forward_bind_failure(&stderr) {
                        self.locals.iter_mut().for_each(|port| *port = 0);
                    }
                    if !self.auto_restart && !healthy_for.is_zero() {
                        // A link that was up dropped: the host does not redial on its own.
                        self.log(&format!("ssh tunnel exited ({status}); automatic reconnection is off"));
                        self.set(TunnelState::Stopped { failure: None });
                        if matches!(self.pause(None).await, Pause::Now) {
                            backoff.reset();
                            self.attempt = 0;
                            continue;
                        }
                        return;
                    }
                    let delay = backoff.next(healthy_for);
                    let detail = if tail.is_empty() { String::new() } else { format!(": {}", tail.replace('\n', " | ")) };
                    self.log(&format!("ssh tunnel exited ({status}); restarting in {} ms{detail}", delay.as_millis()));
                    self.attempt += 1;
                    self.set(TunnelState::Backoff { attempt: self.attempt, next_ms: u64::try_from(delay.as_millis()).unwrap_or(u64::MAX) });
                    match self.pause(Some(delay)).await {
                        Pause::Elapsed => {}
                        Pause::Now => {
                            backoff.reset();
                            self.attempt = 0;
                        }
                        Pause::Stop => {
                            self.set(TunnelState::Stopped { failure: None });
                            return;
                        }
                    }
                }
            }
        }
    }

    /// Waits out `delay` (forever when none) for a command that cuts it short.
    async fn pause(&mut self, delay: Option<Duration>) -> Pause {
        let wait = async {
            match delay {
                Some(delay) => sleep(delay).await,
                None => std::future::pending::<()>().await,
            }
        };
        tokio::select! {
            biased;
            command = self.commands.recv() => match command {
                Some(Command::Restart | Command::Revive) => Pause::Now,
                Some(Command::Stop) | None => Pause::Stop,
            },
            () = wait => Pause::Elapsed,
        }
    }

    /// Runs one child until it exits, a command ends it, or ssh cannot be started at all.
    async fn run_child(&mut self) -> Ended {
        if let Err(error) = self.choose_ports() {
            return Ended::Exited { stderr: String::new(), status: format!("no free local port: {error}"), code: None, healthy_for: Duration::ZERO };
        }
        let companion = (self.locals.len() > 1).then(|| (self.locals[1], self.remotes[1]));
        let args = tunnel_args(&self.target, self.locals[0], self.remotes[0], companion);
        let mut child = match spawn_ssh(&self.env, "ssh", &args, self.ctx.as_ref()) {
            Ok(child) => child,
            Err(error) => return Ended::Fatal(SshError::new(format!("Could not start ssh: {error}"), FailureClass::Terminal)),
        };
        drop(child.take_stdin());
        self.log(&format!("ssh tunnel starting 127.0.0.1:{} -> {}:127.0.0.1:{}", self.locals[0], self.target.display, self.remotes[0]));
        let kept = Arc::new(Mutex::new(Vec::new()));
        let stderr_reader = pump(child.take_stderr(), Some(kept.clone()));
        pump(child.take_stdout(), None);
        let port = self.locals[0];
        let poll = self.timing.ready_poll;
        let deadline_after = self.timing.ready_deadline;
        let deadline = sleep(deadline_after);
        tokio::pin!(deadline);
        let mut ready_at: Option<Instant> = None;
        let mut timed_out = false;
        let mut pending: Option<Ended> = None;
        let exit = loop {
            tokio::select! {
                biased;
                command = self.commands.recv(), if pending.is_none() => match command {
                    Some(Command::Restart) => {
                        pending = Some(Ended::Restart);
                        child.kill();
                    }
                    Some(Command::Revive) => {}
                    Some(Command::Stop) | None => {
                        pending = Some(Ended::Stop);
                        child.kill();
                    }
                },
                exit = child.wait() => break exit,
                () = &mut deadline, if ready_at.is_none() && !timed_out => {
                    timed_out = true;
                    let note = format!("\nssh tunnel did not accept connections within {} ms", deadline_after.as_millis());
                    kept.lock().unwrap_or_else(PoisonError::into_inner).extend_from_slice(note.as_bytes());
                    child.kill();
                }
                accepts = async { sleep(poll).await; local_port_accepts(port).await }, if ready_at.is_none() && pending.is_none() && !timed_out => {
                    if accepts {
                        ready_at = Some(Instant::now());
                        self.log(&format!("ssh tunnel ready on 127.0.0.1:{port}"));
                        self.attempt = 0;
                        self.set(TunnelState::Up);
                    }
                }
            }
        };
        if let Some(ended) = pending {
            return ended;
        }
        let healthy_for = ready_at.map_or(Duration::ZERO, |at| at.elapsed());
        let done = match exit {
            Ok(done) => done,
            Err(error) => {
                let message = if error.kind() == io::ErrorKind::NotFound { missing_client_message("ssh") } else { format!("ssh failed to start: {error}") };
                return Ended::Fatal(SshError::new(message, FailureClass::Terminal));
            }
        };
        if let Some(reader) = stderr_reader {
            let _ = timeout(STDERR_SETTLE, reader).await;
        }
        let stderr = String::from_utf8_lossy(&kept.lock().unwrap_or_else(PoisonError::into_inner)).into_owned();
        let status = match (&done.signal, done.code) {
            (Some(signal), _) => format!("ssh exited on {signal}"),
            (None, Some(code)) => format!("ssh exited with status {code}"),
            (None, None) => "ssh exited".to_owned(),
        };
        Ended::Exited { stderr, status, code: done.code, healthy_for }
    }
}

#[cfg(test)]
#[path = "tunnel_tests.rs"]
mod tunnel_tests;
