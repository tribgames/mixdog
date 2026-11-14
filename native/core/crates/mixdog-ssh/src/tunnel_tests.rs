//! Tests of the supervised tunnel and the callback forward (cases of the desktop's tunnel and callback-forward tests).
//! No ssh is started: the spawner hands out scripted children, and the local ports are real loopback listeners.

use std::collections::BTreeMap;
use std::io;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, PoisonError};
use std::time::Duration;

use async_trait::async_trait;
use mixdog_rt::time::{sleep, timeout};
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt, DuplexStream};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::oneshot;

use crate::callback_forward::{open_callback_forward, CallbackForwardError, MAX_CONNECTIONS};
use crate::command::{parse_ssh_target, FailureClass, TunnelBackoff};
use crate::context::{
    AttemptContext, ChildExit, ConfigFiles, HostSettings, Platform, PreparedSpawn, SshChild, SshConfigFiles, SshEnv, SshSpawner, ToolOutput,
    ToolRunner,
};
use crate::diagnostics::Diagnostics;
use crate::tunnel::{free_local_port, local_port_accepts, LocalForward, SshTunnel, Timing, TunnelSpec, TunnelState};

struct NoFiles;

impl ConfigFiles for NoFiles {
    fn read_text(&self, _path: &Path) -> Option<String> {
        None
    }

    fn list_names(&self, _directory: &Path) -> Vec<String> {
        Vec::new()
    }

    fn is_file(&self, _path: &Path) -> bool {
        false
    }
}

struct NoConfigs;

impl SshConfigFiles for NoConfigs {
    fn for_args(&self, _args: &[String]) -> Option<PathBuf> {
        None
    }

    fn generic(&self) -> Option<PathBuf> {
        None
    }
}

struct NoTools;

#[async_trait]
impl ToolRunner for NoTools {
    async fn run(&self, command: &Path, _args: &[String], _timeout: Duration) -> io::Result<ToolOutput> {
        Err(io::Error::other(format!("unexpected {}", command.display())))
    }
}

/// What a test holds of one scripted ssh child.
struct Probe {
    args: Vec<String>,
    exit: Mutex<Option<oneshot::Sender<ChildExit>>>,
    stderr: Mutex<Option<DuplexStream>>,
    killed: AtomicBool,
}

impl Probe {
    /// The child prints `stderr`, then ends with `code`.
    async fn finish(&self, code: i32, stderr: &str) {
        let writer = self.stderr.lock().unwrap_or_else(PoisonError::into_inner).take();
        if let Some(mut writer) = writer {
            writer.write_all(stderr.as_bytes()).await.unwrap();
        }
        let exit = self.exit.lock().unwrap_or_else(PoisonError::into_inner).take();
        if let Some(exit) = exit {
            let _ = exit.send(ChildExit { code: Some(code), signal: None });
        }
    }

    fn killed(&self) -> bool {
        self.killed.load(Ordering::SeqCst)
    }
}

struct FakeChild {
    probe: Arc<Probe>,
    exit: oneshot::Receiver<ChildExit>,
    stderr: Option<DuplexStream>,
    stdin: Option<DuplexStream>,
    stdout: Option<DuplexStream>,
}

#[async_trait]
impl SshChild for FakeChild {
    fn take_stdin(&mut self) -> Option<Box<dyn AsyncWrite + Send + Unpin>> {
        self.stdin.take().map(|stream| Box::new(stream) as Box<dyn AsyncWrite + Send + Unpin>)
    }

    fn take_stdout(&mut self) -> Option<Box<dyn AsyncRead + Send + Unpin>> {
        self.stdout.take().map(|stream| Box::new(stream) as Box<dyn AsyncRead + Send + Unpin>)
    }

    fn take_stderr(&mut self) -> Option<Box<dyn AsyncRead + Send + Unpin>> {
        self.stderr.take().map(|stream| Box::new(stream) as Box<dyn AsyncRead + Send + Unpin>)
    }

    async fn wait(&mut self) -> io::Result<ChildExit> {
        Ok((&mut self.exit).await.unwrap_or(ChildExit { code: None, signal: Some("SIGKILL".to_owned()) }))
    }

    fn kill(&mut self) {
        self.probe.killed.store(true, Ordering::SeqCst);
        let exit = self.probe.exit.lock().unwrap_or_else(PoisonError::into_inner).take();
        if let Some(exit) = exit {
            let _ = exit.send(ChildExit { code: None, signal: Some("SIGKILL".to_owned()) });
        }
    }
}

impl Drop for FakeChild {
    fn drop(&mut self) {
        self.probe.killed.store(true, Ordering::SeqCst);
    }
}

/// Hands out one scripted child per spawn. An echo child answers each chunk it is sent with `server:<chunk>`.
struct Spawner {
    echo: bool,
    probes: Mutex<Vec<Arc<Probe>>>,
}

impl Spawner {
    fn new(echo: bool) -> Arc<Self> {
        Arc::new(Self { echo, probes: Mutex::new(Vec::new()) })
    }

    fn count(&self) -> usize {
        self.probes.lock().unwrap_or_else(PoisonError::into_inner).len()
    }

    fn probe(&self, index: usize) -> Arc<Probe> {
        self.probes.lock().unwrap_or_else(PoisonError::into_inner)[index].clone()
    }
}

impl SshSpawner for Spawner {
    fn spawn(&self, prepared: &PreparedSpawn) -> io::Result<Box<dyn SshChild>> {
        let (stderr_writer, stderr_reader) = tokio::io::duplex(4096);
        let (exit_tx, exit_rx) = oneshot::channel();
        let probe = Arc::new(Probe {
            args: prepared.args.clone(),
            exit: Mutex::new(Some(exit_tx)),
            stderr: Mutex::new(Some(stderr_writer)),
            killed: AtomicBool::new(false),
        });
        let (mut stdin, mut stdout) = (None, None);
        if self.echo {
            let (stdin_writer, mut stdin_reader) = tokio::io::duplex(4096);
            let (mut stdout_writer, stdout_reader) = tokio::io::duplex(4096);
            tokio::spawn(async move {
                let mut buffer = [0_u8; 1024];
                loop {
                    match stdin_reader.read(&mut buffer).await {
                        Ok(0) | Err(_) => return,
                        Ok(count) => {
                            let mut answer = b"server:".to_vec();
                            answer.extend_from_slice(&buffer[..count]);
                            if stdout_writer.write_all(&answer).await.is_err() {
                                return;
                            }
                        }
                    }
                }
            });
            (stdin, stdout) = (Some(stdin_writer), Some(stdout_reader));
        }
        self.probes.lock().unwrap_or_else(PoisonError::into_inner).push(probe.clone());
        Ok(Box::new(FakeChild { probe, exit: exit_rx, stderr: Some(stderr_reader), stdin, stdout }))
    }
}

fn env_of(spawner: Arc<Spawner>) -> SshEnv {
    SshEnv {
        platform: Platform::Linux,
        env: BTreeMap::new(),
        home: PathBuf::from("/home/tester"),
        askpass_helper: None,
        server_cores_dir: None,
        files: Arc::new(NoFiles),
        config_files: Arc::new(NoConfigs),
        tools: Arc::new(NoTools),
        spawner,
        diagnostics: Arc::new(Diagnostics::new()),
    }
}

fn timing_of(schedule_ms: [u64; 3]) -> Timing {
    Timing {
        backoff: TunnelBackoff::with_schedule(schedule_ms.iter().map(|ms| Duration::from_millis(*ms)).collect(), Duration::from_secs(60)),
        ready_deadline: Duration::from_secs(40),
        ready_poll: Duration::from_millis(5),
    }
}

fn timing() -> Timing {
    timing_of([10, 20, 40])
}

fn forward(remote_port: u16) -> LocalForward {
    LocalForward { local: 0, remote_host: "127.0.0.1".to_owned(), remote_port }
}

fn spec(local_port: Option<u16>, forwards: Vec<LocalForward>) -> TunnelSpec {
    TunnelSpec { target: parse_ssh_target("devbox").unwrap(), local_port, forwards }
}

/// A loopback listener: it is what accepts connections on the tunnel's local port while the scripted ssh runs.
async fn open_port() -> (TcpListener, u16) {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    (listener, port)
}

async fn until(mut reached: impl FnMut() -> bool) {
    for _ in 0..600 {
        if reached() {
            return;
        }
        sleep(Duration::from_millis(5)).await;
    }
    panic!("condition not reached");
}

async fn state_is(tunnel: &SshTunnel, wanted: impl Fn(&TunnelState) -> bool) -> TunnelState {
    let mut state = tunnel.state();
    let reached = timeout(Duration::from_secs(5), state.wait_for(|now| wanted(now))).await.expect("the state was not reached").expect("the tunnel ended");
    let found = TunnelState::clone(&reached);
    found
}

#[tokio::test]
async fn same_port_after_restart() {
    let (_listener, port) = open_port().await;
    let spawner = Spawner::new(false);
    let tunnel = SshTunnel::start_with(env_of(spawner.clone()), None, spec(Some(port), vec![forward(41001)]), timing());
    state_is(&tunnel, |state| *state == TunnelState::Up).await;
    assert_eq!(tunnel.local_port(), port);
    let wanted = format!("127.0.0.1:{port}:127.0.0.1:41001");
    let first = spawner.probe(0);
    assert!(first.args.contains(&wanted));
    assert_eq!(first.args.last().map(String::as_str), Some("devbox"));

    first.finish(255, "client_loop: send disconnect: Connection reset\n").await;
    until(|| spawner.count() == 2).await;
    state_is(&tunnel, |state| *state == TunnelState::Up).await;
    assert_eq!(tunnel.local_port(), port);
    assert!(spawner.probe(1).args.contains(&wanted));

    tunnel.stop().await;
    assert!(spawner.probe(1).killed());
    assert_eq!(*tunnel.state().borrow(), TunnelState::Stopped { failure: None });
    assert_eq!(tunnel.local_port(), port);
}

#[tokio::test]
async fn backoff_schedule() {
    let port = free_local_port().unwrap();
    let spawner = Spawner::new(false);
    let tunnel = SshTunnel::start_with(env_of(spawner.clone()), None, spec(Some(port), vec![forward(41001)]), timing_of([100, 200, 400]));
    // A tunnel that never comes up walks the schedule; its last entry repeats.
    for (attempt, next_ms) in [(1_u32, 100_u64), (2, 200), (3, 400), (4, 400)] {
        until(|| spawner.count() == attempt as usize).await;
        spawner.probe(attempt as usize - 1).finish(255, "Connection timed out\n").await;
        let seen = state_is(&tunnel, |state| matches!(state, TunnelState::Backoff { attempt: now, .. } if *now == attempt)).await;
        assert_eq!(seen, TunnelState::Backoff { attempt, next_ms });
    }
    tunnel.stop().await;
}

#[tokio::test]
async fn terminal_failure_stops() {
    let (_listener, port) = open_port().await;
    let spawner = Spawner::new(false);
    let tunnel = SshTunnel::start_with(env_of(spawner.clone()), None, spec(Some(port), vec![forward(41001)]), timing());
    until(|| spawner.count() == 1).await;
    spawner.probe(0).finish(255, "@    WARNING: REMOTE HOST IDENTIFICATION HAS CHANGED!     @\nHost key verification failed.\n").await;
    let TunnelState::Stopped { failure: Some(failure) } = state_is(&tunnel, |state| matches!(state, TunnelState::Stopped { .. })).await else {
        panic!("no failure")
    };
    assert_eq!(failure.kind, FailureClass::Terminal);
    assert!(failure.message.contains("REMOTE HOST IDENTIFICATION HAS CHANGED"));
    assert!(failure.message.contains("Host key verification failed."));
    sleep(Duration::from_millis(100)).await;
    assert_eq!(spawner.count(), 1, "no restart after a terminal failure");
    tunnel.restart();
    tunnel.revive();
    sleep(Duration::from_millis(50)).await;
    assert_eq!(spawner.count(), 1, "neither restart nor revive starts a stopped tunnel");
    tunnel.stop().await;
}

#[tokio::test]
async fn restart_replaces_a_running_child() {
    let (_listener, port) = open_port().await;
    let spawner = Spawner::new(false);
    let tunnel = SshTunnel::start_with(env_of(spawner.clone()), None, spec(Some(port), vec![forward(41001)]), timing());
    state_is(&tunnel, |state| *state == TunnelState::Up).await;
    tunnel.restart();
    until(|| spawner.count() == 2).await;
    assert!(spawner.probe(0).killed());
    state_is(&tunnel, |state| *state == TunnelState::Up).await;
    tunnel.stop().await;
}

#[tokio::test]
async fn a_dropped_link_with_automatic_reconnection_off_waits_for_revive() {
    let (_listener, port) = open_port().await;
    let spawner = Spawner::new(false);
    let ctx = AttemptContext { settings: Some(HostSettings { auto_reconnect: Some(false), ..Default::default() }), ..Default::default() };
    let tunnel = SshTunnel::start_with(env_of(spawner.clone()), Some(ctx), spec(Some(port), vec![forward(41001)]), timing());
    state_is(&tunnel, |state| *state == TunnelState::Up).await;
    spawner.probe(0).finish(255, "client_loop: send disconnect\n").await;
    state_is(&tunnel, |state| matches!(state, TunnelState::Stopped { failure: None })).await;
    sleep(Duration::from_millis(100)).await;
    assert_eq!(spawner.count(), 1);
    tunnel.revive();
    until(|| spawner.count() == 2).await;
    state_is(&tunnel, |state| *state == TunnelState::Up).await;
    tunnel.stop().await;
}

#[tokio::test]
async fn a_companion_forward_rides_the_same_child() {
    let (_listener, port) = open_port().await;
    let spawner = Spawner::new(false);
    let tunnel = SshTunnel::start_with(env_of(spawner.clone()), None, spec(Some(port), vec![forward(41001), forward(41002)]), timing());
    state_is(&tunnel, |state| *state == TunnelState::Up).await;
    assert_eq!(spawner.count(), 1);
    let args = spawner.probe(0).args.clone();
    let forwards: Vec<&String> = args.windows(2).filter(|pair| pair[0] == "-L").map(|pair| &pair[1]).collect();
    assert_eq!(forwards.len(), 2);
    assert_eq!(forwards[0], &format!("127.0.0.1:{port}:127.0.0.1:41001"));
    assert!(forwards[1].ends_with(":127.0.0.1:41002"));
    tunnel.stop().await;
}

#[tokio::test]
async fn a_spec_ssh_cannot_carry_is_a_terminal_failure_at_once() {
    let spawner = Spawner::new(false);
    for forwards in [Vec::new(), vec![forward(1), forward(2), forward(3)], vec![LocalForward { local: 0, remote_host: "10.0.0.5".to_owned(), remote_port: 80 }]] {
        let tunnel = SshTunnel::start_with(env_of(spawner.clone()), None, spec(None, forwards), timing());
        assert!(matches!(&*tunnel.state().borrow(), TunnelState::Stopped { failure: Some(failure) } if failure.is_terminal()));
        tunnel.stop().await;
    }
    assert_eq!(spawner.count(), 0);
}

#[tokio::test]
async fn a_free_local_port_is_one_a_browser_opens() {
    let port = free_local_port().unwrap();
    assert!(port != 0 && !mixdog_workspace::pageserver::ports::FETCH_BLOCKED_PORTS.contains(&port));
    let (_listener, taken) = open_port().await;
    assert!(local_port_accepts(taken).await);
    assert!(!local_port_accepts(port).await);
}

// ---- the callback forward ----

async fn exchange(port: u16, line: &str) -> String {
    let mut socket = TcpStream::connect(("127.0.0.1", port)).await.unwrap();
    socket.write_all(line.as_bytes()).await.unwrap();
    let mut answer = vec![0_u8; 64];
    let count = socket.read(&mut answer).await.unwrap();
    String::from_utf8_lossy(&answer[..count]).into_owned()
}

#[tokio::test]
async fn callback_each_connection_reaches_the_servers_port_through_its_own_ssh() {
    let (listener, port) = open_port().await;
    drop(listener);
    let spawner = Spawner::new(true);
    let target = parse_ssh_target("dev@build-box").unwrap();
    let forward = open_callback_forward(env_of(spawner.clone()), None, target, port).await.unwrap();
    assert_eq!(exchange(port, "GET /auth/callback").await, "server:GET /auth/callback");
    assert_eq!(exchange(port, "again").await, "server:again");
    assert_eq!(spawner.count(), 2);
    let probe = spawner.probe(0);
    let args = &probe.args;
    assert_eq!(args[args.len() - 4..], ["-W".to_owned(), format!("127.0.0.1:{port}"), "--".to_owned(), "dev@build-box".to_owned()]);
    assert!(args.contains(&"BatchMode=yes".to_owned()));
    forward.close().await;
    // Closed: the port is free again.
    drop(TcpListener::bind(("127.0.0.1", port)).await.unwrap());
}

#[tokio::test]
async fn callback_a_port_something_on_this_pc_holds_is_refused_by_the_bind_itself() {
    let (_holder, port) = open_port().await;
    let spawner = Spawner::new(true);
    let target = parse_ssh_target("dev@build-box").unwrap();
    let refused = open_callback_forward(env_of(spawner.clone()), None, target, port).await;
    assert!(matches!(refused, Err(CallbackForwardError::PortInUse(held)) if held == port));
    assert_eq!(spawner.count(), 0);
}

#[tokio::test]
async fn callback_max_8() {
    let (listener, port) = open_port().await;
    drop(listener);
    let spawner = Spawner::new(true);
    let target = parse_ssh_target("dev@build-box").unwrap();
    let forward = open_callback_forward(env_of(spawner.clone()), None, target, port).await.unwrap();
    let mut carried = Vec::new();
    for _ in 0..MAX_CONNECTIONS {
        let mut socket = TcpStream::connect(("127.0.0.1", port)).await.unwrap();
        socket.write_all(b"x").await.unwrap();
        let mut answer = [0_u8; 16];
        let count = socket.read(&mut answer).await.unwrap();
        assert_eq!(&answer[..count], b"server:x");
        carried.push(socket);
    }
    assert_eq!(spawner.count(), MAX_CONNECTIONS);
    // The two over the cap are dropped by the forward and get no ssh.
    for _ in 0..2 {
        let mut socket = TcpStream::connect(("127.0.0.1", port)).await.unwrap();
        let _ = socket.write_all(b"x").await;
        let mut answer = [0_u8; 16];
        let outcome = timeout(Duration::from_secs(5), socket.read(&mut answer)).await.expect("the connection over the cap was kept");
        assert!(matches!(outcome, Ok(0) | Err(_)));
    }
    assert_eq!(spawner.count(), MAX_CONNECTIONS);
    forward.close().await;
    for index in 0..MAX_CONNECTIONS {
        assert!(spawner.probe(index).killed(), "closing the forward stops the ssh of a connection still open");
    }
    for mut socket in carried {
        let mut answer = [0_u8; 16];
        assert!(matches!(socket.read(&mut answer).await, Ok(0) | Err(_)));
    }
}
