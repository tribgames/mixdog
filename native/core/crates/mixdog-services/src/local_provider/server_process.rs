//! The single llama-server child. One process owner for all sessions: starts and stops are
//! serialized so model switches never overlap, and a cancelled queued caller never starts a
//! child. Spawning, readiness probing and the loopback port sit behind small traits so the
//! lifecycle is testable without a GPU.

use std::future::Future;
use std::pin::Pin;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use async_trait::async_trait;
use mixdog_core_api::domain::command::spawn_form;
use mixdog_core_api::domain::common::AbsPath;
use mixdog_core_api::domain::process::{CommandSpec, EnvSpec, ExitStatus, OutputMode, ProcessError, ProcessEvent, ProcessManager, ProcessOwner, SpawnRequest};
use mixdog_protocol::ProcessHandle;
use serde_json::{Value, json};
use tokio::sync::Notify;
use tokio_util::sync::CancellationToken;

use super::change::ChangeSignal;
use super::hardware::Gpu;
use crate::tidy::process::Processes;

const LOG_LIMIT: usize = 16_384;

pub type BoxFut<T> = Pin<Box<dyn Future<Output = T> + Send>>;

pub struct Launch {
    pub gpu: Option<Gpu>,
    pub env: Vec<(String, String)>,
}

pub struct Ready {
    pub base_url: String,
    pub api_key: String,
    pub load_time_ms: f64,
}

pub struct StartSpec {
    /// Same key, same running child: `executable|weights|contextWindow`.
    pub key: String,
    pub model_id: String,
    pub executable: String,
    pub cwd: String,
    /// Runs after the previous child is stopped, so GPU memory is measured free.
    pub prepare: Box<dyn FnOnce(CancellationToken) -> BoxFut<Result<Launch, String>> + Send>,
    pub on_ready: Box<dyn FnOnce(Ready, CancellationToken) -> BoxFut<()> + Send>,
    pub args: Box<dyn FnOnce(u16, &str) -> Vec<String> + Send>,
}

#[derive(Debug, Clone)]
pub struct ExitInfo {
    pub exit_code: Option<i32>,
    pub signal: Option<String>,
}

#[async_trait]
pub trait RunningProcess: Send + Sync {
    /// Resolves once the process exits.
    async fn wait(&self) -> ExitInfo;
    fn kill(&self);
}

/// Receives a child's stdout/stderr text. The alias keeps the argument's lifetime higher-ranked
/// through `async_trait`.
pub type LogSink = Arc<dyn for<'a> Fn(&'a str) + Send + Sync + 'static>;

#[async_trait]
pub trait Launcher: Send + Sync {
    /// Spawns the child; `log` receives its stdout/stderr text.
    async fn launch(&self, executable: &str, args: &[String], cwd: &str, env: &[(String, String)], log: LogSink) -> Result<Arc<dyn RunningProcess>, String>;
}

#[async_trait]
pub trait Health: Send + Sync {
    async fn check(&self, port: u16, api_key: &str) -> bool;
    async fn free_port(&self) -> Result<u16, String>;
}

struct ChildState {
    process: Arc<dyn RunningProcess>,
    key: String,
    model_id: String,
    api_key: String,
    port: u16,
    gpu: Option<Gpu>,
    base_url: String,
    started: Instant,
    inner: Mutex<ChildInner>,
    exited: Notify,
}

#[derive(Default)]
struct ChildInner {
    ready: bool,
    exited: bool,
    expected_exit: bool,
    log: String,
    load_time_ms: Option<f64>,
}

impl ChildState {
    fn redacted_log(&self) -> String {
        self.inner.lock().unwrap().log.replace(&self.api_key, "[redacted]")
    }
    fn has_exited(&self) -> bool {
        self.inner.lock().unwrap().exited
    }
}

#[derive(Default)]
struct Owner {
    current: Option<Arc<ChildState>>,
    last_exit: Option<Value>,
    last_error: Option<String>,
}

pub struct ServerProcess {
    launcher: Arc<dyn Launcher>,
    health: Arc<dyn Health>,
    owner: Arc<Mutex<Owner>>,
    serial: tokio::sync::Mutex<()>,
    /// Next ticket and the tokens of starts not yet finished.
    pending: Mutex<(u64, Vec<(u64, CancellationToken)>)>,
    start_timeout: Duration,
    stop_timeout: Duration,
    poll: Duration,
    on_exit: Arc<dyn Fn(&Value) + Send + Sync>,
    signal: ChangeSignal,
}

pub struct Timing {
    pub start_timeout: Duration,
    pub stop_timeout: Duration,
    pub poll: Duration,
}

impl Default for Timing {
    fn default() -> Self {
        Self { start_timeout: Duration::from_secs(180), stop_timeout: Duration::from_secs(5), poll: Duration::from_millis(500) }
    }
}

fn now_iso() -> String {
    chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}

impl ServerProcess {
    pub fn new(launcher: Arc<dyn Launcher>, health: Arc<dyn Health>, timing: Timing, on_exit: Arc<dyn Fn(&Value) + Send + Sync>) -> Self {
        Self {
            launcher,
            health,
            owner: Arc::default(),
            serial: tokio::sync::Mutex::new(()),
            pending: Mutex::default(),
            start_timeout: timing.start_timeout,
            stop_timeout: timing.stop_timeout,
            poll: timing.poll,
            on_exit,
            signal: ChangeSignal::default(),
        }
    }

    /// Ticks `signal` whenever the server's `status()` may have changed.
    pub fn with_signal(mut self, signal: ChangeSignal) -> Self {
        self.signal = signal;
        self
    }

    async fn stop_state(&self, state: &Option<Arc<ChildState>>) -> Result<(), String> {
        let Some(state) = state else { return Ok(()) };
        if state.has_exited() {
            return Ok(());
        }
        state.inner.lock().unwrap().expected_exit = true;
        state.process.kill();
        let waited = tokio::time::timeout(self.stop_timeout, async {
            while !state.has_exited() {
                let notified = state.exited.notified();
                if state.has_exited() {
                    break;
                }
                notified.await;
            }
        })
        .await;
        if waited.is_err() && !state.has_exited() {
            return Err("[local-provider] llama-server did not exit after termination".into());
        }
        Ok(())
    }

    async fn start(&self, spec: StartSpec, cancel: CancellationToken) -> Result<Value, String> {
        let current = self.owner.lock().unwrap().current.clone();
        if let Some(c) = &current {
            if c.key == spec.key && c.inner.lock().unwrap().ready && !c.has_exited() {
                return Ok(json!({"baseURL": c.base_url, "apiKey": c.api_key}));
            }
        }
        self.stop_state(&current).await?;
        if cancel.is_cancelled() {
            return Err("aborted".into());
        }
        let launch = match (spec.prepare)(cancel.clone()).await {
            Ok(l) => l,
            Err(e) => {
                self.owner.lock().unwrap().last_error = (!cancel.is_cancelled()).then(|| e.clone());
                self.signal.notify();
                return Err(e);
            }
        };
        if cancel.is_cancelled() {
            return Err("aborted".into());
        }
        let port = self.health.free_port().await?;
        let api_key: String = (0..2).map(|_| uuid::Uuid::new_v4().simple().to_string()).collect();
        let args = (spec.args)(port, &api_key);
        let log_sink: Arc<Mutex<String>> = Arc::default();
        let log_cb: LogSink = {
            let sink = log_sink.clone();
            Arc::new(move |text| {
                let mut s = sink.lock().unwrap();
                s.push_str(text);
                if s.len() > LOG_LIMIT {
                    let mut cut = s.len() - LOG_LIMIT;
                    while !s.is_char_boundary(cut) {
                        cut += 1;
                    }
                    s.drain(..cut);
                }
            })
        };
        let process = self.launcher.launch(&spec.executable, &args, &spec.cwd, &launch.env, log_cb).await;
        let state_log = log_sink.clone();
        let (process, spawn_error) = match process {
            Ok(p) => (Some(p), None),
            Err(e) => (None, Some(e)),
        };
        let Some(process) = process else {
            let message = spawn_error.unwrap_or_default();
            self.owner.lock().unwrap().last_error = Some(format!("[local-provider] llama-server exited (spawn error): {message}"));
            self.signal.notify();
            return Err(message);
        };
        let state = Arc::new(ChildState {
            process: process.clone(),
            key: spec.key.clone(),
            model_id: spec.model_id.clone(),
            api_key: api_key.clone(),
            port,
            gpu: launch.gpu,
            base_url: format!("http://127.0.0.1:{port}/v1"),
            started: Instant::now(),
            inner: Mutex::default(),
            exited: Notify::new(),
        });
        self.owner.lock().unwrap().current = Some(state.clone());
        self.signal.notify();
        // Watch the child: its exit is recorded by the owner whatever the cause.
        {
            let (state, owner, on_exit, sink, signal) = (state.clone(), self.owner.clone(), self.on_exit.clone(), state_log, self.signal.clone());
            tokio::spawn(async move {
                let exit = process.wait().await;
                let mut inner = state.inner.lock().unwrap();
                inner.log = sink.lock().unwrap().clone();
                inner.exited = true;
                inner.ready = false;
                let expected = inner.expected_exit;
                let log = inner.log.replace(&state.api_key, "[redacted]");
                drop(inner);
                let info = json!({"at": now_iso(), "modelId": state.model_id, "exitCode": exit.exit_code, "signal": exit.signal, "expected": expected, "log": log});
                {
                    let mut o = owner.lock().unwrap();
                    if !expected {
                        o.last_error = Some(format!("[local-provider] llama-server exited ({}): {}", exit.exit_code.map_or_else(|| exit.signal.clone().unwrap_or_else(|| "spawn error".into()), |c| c.to_string()), mixdog_js::js_trim(&log)));
                    }
                    if o.current.as_ref().is_some_and(|c| Arc::ptr_eq(c, &state)) {
                        o.current = None;
                    }
                    o.last_exit = Some(info.clone());
                }
                state.exited.notify_waiters();
                signal.notify();
                on_exit(&info);
            });
        }
        let startup = cancel.child_token();
        let timer = {
            let startup = startup.clone();
            let timeout = self.start_timeout;
            tokio::spawn(async move {
                tokio::time::sleep(timeout).await;
                startup.cancel();
            })
        };
        let ready = self.await_ready(&state, spec.on_ready, &startup, &log_sink).await;
        timer.abort();
        match ready {
            Ok(v) => Ok(v),
            Err(error) => {
                let failure = if cancel.is_cancelled() {
                    "aborted".to_owned()
                } else if startup.is_cancelled() {
                    format!("[local-provider] llama-server did not become ready: {}", mixdog_js::js_trim(&state.redacted_log()))
                } else {
                    error
                };
                self.owner.lock().unwrap().last_error = (!cancel.is_cancelled()).then(|| failure.clone());
                self.signal.notify();
                let _ = self.stop_state(&Some(state)).await;
                Err(failure)
            }
        }
    }

    /// Polls `/health` until the server answers, the child exits, or the deadline/caller aborts.
    async fn await_ready(&self, state: &Arc<ChildState>, on_ready: Box<dyn FnOnce(Ready, CancellationToken) -> BoxFut<()> + Send>, wait: &CancellationToken, log: &Arc<Mutex<String>>) -> Result<Value, String> {
        loop {
            if wait.is_cancelled() {
                return Err("aborted".into());
            }
            if state.has_exited() {
                let last = self.owner.lock().unwrap().last_exit.as_ref().map(|e| e["log"].as_str().unwrap_or("").to_owned());
                let tail = last.unwrap_or_else(|| log.lock().unwrap().replace(&state.api_key, "[redacted]"));
                return Err(format!("[local-provider] llama-server exited during startup: {tail}"));
            }
            let ok = tokio::select! {
                ok = self.health.check(state.port, &state.api_key) => ok,
                _ = wait.cancelled() => return Err("aborted".into()),
            };
            if ok && !state.has_exited() {
                let load_ms = state.started.elapsed().as_secs_f64() * 1000.0;
                state.inner.lock().unwrap().load_time_ms = Some(load_ms);
                on_ready(Ready { base_url: state.base_url.clone(), api_key: state.api_key.clone(), load_time_ms: load_ms }, wait.clone()).await;
                if wait.is_cancelled() {
                    return Err("aborted".into());
                }
                if state.has_exited() {
                    return Err("[local-provider] server exited while reading capabilities".into());
                }
                state.inner.lock().unwrap().ready = true;
                self.owner.lock().unwrap().last_error = None;
                self.signal.notify();
                return Ok(json!({"baseURL": state.base_url, "apiKey": state.api_key}));
            }
            tokio::select! {
                _ = tokio::time::sleep(self.poll) => {}
                _ = wait.cancelled() => return Err("aborted".into()),
            }
        }
    }

    /// Starts (or reuses) the server for `spec`; `{baseURL, apiKey}` once it is ready.
    pub async fn ensure(&self, spec: StartSpec, cancel: Option<CancellationToken>) -> Result<Value, String> {
        let token = cancel.unwrap_or_default().child_token();
        if token.is_cancelled() {
            return Err("aborted".into());
        }
        let ticket = {
            let mut pending = self.pending.lock().unwrap();
            pending.0 += 1;
            let ticket = pending.0;
            pending.1.push((ticket, token.clone()));
            ticket
        };
        let result = {
            let lane = tokio::select! {
                lane = self.serial.lock() => Some(lane),
                _ = token.cancelled() => None,
            };
            match lane {
                None => Err("aborted".into()),
                Some(_lane) => self.start(spec, token.clone()).await,
            }
        };
        self.pending.lock().unwrap().1.retain(|(id, _)| *id != ticket);
        result
    }

    /// Cancels loading work first (never queued behind it), then stops the child.
    pub async fn stop(&self) -> Result<(), String> {
        for (_, t) in self.pending.lock().unwrap().1.iter() {
            t.cancel();
        }
        let _lane = self.serial.lock().await;
        let current = self.owner.lock().unwrap().current.clone();
        self.stop_state(&current).await
    }

    pub fn status(&self) -> Value {
        let o = self.owner.lock().unwrap();
        let (running, starting) = o.current.as_ref().map_or((false, false), |c| {
            let i = c.inner.lock().unwrap();
            (i.ready && !i.exited, !i.ready && !i.exited)
        });
        json!({
            "running": running, "starting": starting,
            "activeModel": o.current.as_ref().map(|c| c.model_id.clone()),
            "gpu": o.current.as_ref().and_then(|c| c.gpu.as_ref().map(Gpu::to_json)),
            "loadTimeMs": o.current.as_ref().and_then(|c| c.inner.lock().unwrap().load_time_ms),
            "lastExit": o.last_exit, "lastError": o.last_error,
        })
    }

    /// Only the owning process's exit hook calls this synchronous fallback.
    pub fn kill_on_owner_exit(&self) {
        if let Some(c) = self.owner.lock().unwrap().current.as_ref() {
            c.inner.lock().unwrap().expected_exit = true;
            c.process.kill();
        }
    }
}

/// The real thing: a child of the shared process manager (tree kill, exit events); `/health`
/// goes over loopback.
pub struct SystemLauncher(Arc<dyn ProcessManager>);

impl SystemLauncher {
    pub fn new(processes: &Processes) -> Self {
        Self(processes.manager())
    }
}

static NEXT_SERVER: AtomicU64 = AtomicU64::new(0);

struct ManagedProcess {
    exit: tokio::sync::watch::Receiver<Option<ExitInfo>>,
    manager: Arc<dyn ProcessManager>,
    handle: ProcessHandle,
}

#[async_trait]
impl RunningProcess for ManagedProcess {
    async fn wait(&self) -> ExitInfo {
        let mut rx = self.exit.clone();
        loop {
            if let Some(info) = rx.borrow_and_update().clone() {
                return info;
            }
            if rx.changed().await.is_err() {
                return ExitInfo { exit_code: None, signal: None };
            }
        }
    }
    fn kill(&self) {
        let _ = self.manager.kill(&self.handle);
    }
}

#[async_trait]
impl Launcher for SystemLauncher {
    async fn launch(&self, executable: &str, args: &[String], cwd: &str, env: &[(String, String)], log: LogSink) -> Result<Arc<dyn RunningProcess>, String> {
        let (program, argv) = spawn_form(executable, args);
        let cwd = AbsPath::new(std::path::absolute(cwd).map_err(|e| e.to_string())?).ok_or_else(|| format!("working directory {cwd} is not absolute"))?;
        let handle = ProcessHandle(format!("llama-{}-{}", std::process::id(), NEXT_SERVER.fetch_add(1, Ordering::Relaxed)));
        let request = SpawnRequest {
            handle: handle.clone(),
            command: CommandSpec::Argv { program: program.clone(), args: argv },
            cwd,
            env: EnvSpec { inherit: true, set: env.iter().cloned().collect(), remove: Vec::new() },
            pty: None,
            stdin_piped: false,
            output: OutputMode::Separate,
            owner: ProcessOwner::Internal,
            time_limit: None,
        };
        self.0.spawn(request).await.map_err(|e| match e {
            ProcessError::ProgramNotFound { .. } => format!("{program}: program not found"),
            ProcessError::PermissionDenied => format!("{program}: permission denied"),
            other => format!("{program}: could not start ({other:?})"),
        })?;
        let mut events = self.0.subscribe(&handle, Some(0)).map_err(|e| format!("{program}: {e:?}"))?;
        let (tx, rx) = tokio::sync::watch::channel(None);
        tokio::spawn(async move {
            while let Some(event) = events.next().await {
                match event {
                    ProcessEvent::Output { bytes, .. } => log(&String::from_utf8_lossy(&bytes)),
                    ProcessEvent::Exited { exit, .. } => {
                        let (exit_code, signal) = match exit.status {
                            ExitStatus::Code(code) => (Some(code), None),
                            ExitStatus::Signal(signal) => (None, Some(format!("SIG{signal}"))),
                        };
                        let _ = tx.send(Some(ExitInfo { exit_code, signal }));
                        break;
                    }
                }
            }
        });
        Ok(Arc::new(ManagedProcess { exit: rx, manager: self.0.clone(), handle }))
    }
}

pub struct LoopbackHealth(reqwest::Client);

impl Default for LoopbackHealth {
    fn default() -> Self {
        Self(reqwest::Client::builder().timeout(Duration::from_secs(2)).build().expect("client builds"))
    }
}

#[async_trait]
impl Health for LoopbackHealth {
    async fn check(&self, port: u16, api_key: &str) -> bool {
        self.0.get(format!("http://127.0.0.1:{port}/health")).bearer_auth(api_key).send().await.is_ok_and(|r| r.status().is_success())
    }
    async fn free_port(&self) -> Result<u16, String> {
        let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0)).await.map_err(|e| e.to_string())?;
        listener.local_addr().map(|a| a.port()).map_err(|e| e.to_string())
    }
}

/// The `/props` document of a ready server; an unavailable capability endpoint stays unknown.
pub async fn fetch_props(base_url: &str, api_key: &str, cancel: &CancellationToken) -> Value {
    let url = format!("{}/props", base_url.trim_end_matches("/v1"));
    let client = reqwest::Client::builder().timeout(Duration::from_secs(2)).build().expect("client builds");
    let request = client.get(url).bearer_auth(api_key).send();
    tokio::select! {
        r = request => match r {
            Ok(resp) if resp.status().is_success() => resp.bytes().await.ok().and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or_else(|| json!({})),
            _ => json!({}),
        },
        _ = cancel.cancelled() => json!({}),
    }
}

#[cfg(test)]
mod tests {
    use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};

    use super::*;

    struct FakeProcess {
        killed: AtomicBool,
        exit: tokio::sync::watch::Sender<Option<ExitInfo>>,
        rx: tokio::sync::watch::Receiver<Option<ExitInfo>>,
    }

    #[async_trait]
    impl RunningProcess for FakeProcess {
        async fn wait(&self) -> ExitInfo {
            let mut rx = self.rx.clone();
            loop {
                if let Some(i) = rx.borrow_and_update().clone() {
                    return i;
                }
                rx.changed().await.unwrap();
            }
        }
        fn kill(&self) {
            self.killed.store(true, Ordering::SeqCst);
            let _ = self.exit.send(Some(ExitInfo { exit_code: None, signal: Some("SIGKILL".into()) }));
        }
    }

    #[derive(Default)]
    struct FakeLauncher {
        launched: AtomicUsize,
        crash_at_launch: AtomicBool,
        last: Mutex<Option<Arc<FakeProcess>>>,
    }

    #[async_trait]
    impl Launcher for FakeLauncher {
        async fn launch(&self, _: &str, args: &[String], _: &str, _: &[(String, String)], log: LogSink) -> Result<Arc<dyn RunningProcess>, String> {
            self.launched.fetch_add(1, Ordering::SeqCst);
            let (exit, rx) = tokio::sync::watch::channel(None);
            let p = Arc::new(FakeProcess { killed: AtomicBool::new(false), exit, rx });
            // The api key travels in argv; a crash log that echoes it must be redacted.
            log(&format!("starting with {}", args.join(" ")));
            if self.crash_at_launch.load(Ordering::SeqCst) {
                let _ = p.exit.send(Some(ExitInfo { exit_code: Some(1), signal: None }));
            }
            *self.last.lock().unwrap() = Some(p.clone());
            Ok(p)
        }
    }

    struct FakeHealth(AtomicBool);

    #[async_trait]
    impl Health for FakeHealth {
        async fn check(&self, _: u16, _: &str) -> bool {
            self.0.load(Ordering::SeqCst)
        }
        async fn free_port(&self) -> Result<u16, String> {
            Ok(4242)
        }
    }

    fn spec(key: &str, ready_count: Arc<AtomicUsize>) -> StartSpec {
        StartSpec {
            key: key.into(),
            model_id: "m".into(),
            executable: "x".into(),
            cwd: ".".into(),
            prepare: Box::new(|_| Box::pin(async { Ok(Launch { gpu: None, env: vec![] }) })),
            on_ready: Box::new(move |_, _| {
                ready_count.fetch_add(1, Ordering::SeqCst);
                Box::pin(async {})
            }),
            args: Box::new(|port, key| vec![format!("--port={port}"), format!("--api-key={key}")]),
        }
    }

    fn server(healthy: bool) -> (ServerProcess, Arc<FakeLauncher>, Arc<FakeHealth>) {
        let launcher = Arc::new(FakeLauncher::default());
        let health = Arc::new(FakeHealth(AtomicBool::new(healthy)));
        let timing = Timing { start_timeout: Duration::from_secs(5), stop_timeout: Duration::from_secs(1), poll: Duration::from_millis(10) };
        (ServerProcess::new(launcher.clone(), health.clone(), timing, Arc::new(|_| {})), launcher, health)
    }

    #[tokio::test(start_paused = true)]
    async fn a_ready_server_is_reused_for_the_same_key_and_replaced_for_another() {
        let (s, launcher, _) = server(true);
        let ready = Arc::new(AtomicUsize::new(0));
        let first = s.ensure(spec("k1", ready.clone()), None).await.unwrap();
        assert!(first["baseURL"].as_str().unwrap().ends_with(":4242/v1"));
        assert_eq!(s.status()["running"], true);
        s.ensure(spec("k1", ready.clone()), None).await.unwrap();
        assert_eq!(launcher.launched.load(Ordering::SeqCst), 1);
        s.ensure(spec("k2", ready.clone()), None).await.unwrap();
        assert_eq!(launcher.launched.load(Ordering::SeqCst), 2);
        assert_eq!(ready.load(Ordering::SeqCst), 2);
        assert_eq!(s.status()["lastExit"]["expected"], true);
        s.stop().await.unwrap();
        assert_eq!(s.status()["running"], false);
    }

    #[tokio::test]
    async fn the_system_launcher_runs_a_child_under_the_process_manager() {
        let dir = tempfile::tempdir().unwrap();
        let cwd = dir.path().to_string_lossy().into_owned();
        let launcher = SystemLauncher::new(&Processes::for_tests());
        let shell = if cfg!(windows) { "cmd.exe" } else { "sh" };
        let flag = if cfg!(windows) { "/C" } else { "-c" };
        let text: Arc<Mutex<String>> = Arc::default();
        let sink = |text: &Arc<Mutex<String>>| -> LogSink {
            let text = text.clone();
            Arc::new(move |chunk: &str| text.lock().unwrap().push_str(chunk))
        };
        // Output and the exit code arrive through the manager's events; env is passed on.
        let echo = if cfg!(windows) { "echo out %MIXDOG_PROBE% & echo err 1>&2 & exit 7" } else { "echo out $MIXDOG_PROBE; echo err >&2; exit 7" };
        let process = launcher.launch(shell, &[flag.into(), echo.into()], &cwd, &[("MIXDOG_PROBE".into(), "hello".into())], sink(&text)).await.unwrap();
        let exit = tokio::time::timeout(Duration::from_secs(20), process.wait()).await.unwrap();
        assert_eq!((exit.exit_code, exit.signal), (Some(7), None));
        let seen = text.lock().unwrap().clone();
        assert!(seen.contains("out hello") && seen.contains("err"), "{seen}");
        // A long-running child dies when killed.
        let sleeper = if cfg!(windows) { "ping -n 60 127.0.0.1 >nul" } else { "sleep 60" };
        let process = launcher.launch(shell, &[flag.into(), sleeper.into()], &cwd, &[], sink(&text)).await.unwrap();
        process.kill();
        tokio::time::timeout(Duration::from_secs(20), process.wait()).await.unwrap();
        // A missing program is a launch error, not a panic.
        let missing = launcher.launch("definitely-not-a-binary-xyz", &[], &cwd, &[], sink(&text)).await.err().unwrap();
        assert!(missing.contains("not found"), "{missing}");
    }

    #[tokio::test(start_paused = true)]
    async fn a_crash_during_startup_fails_with_a_redacted_log() {
        let (s, launcher, _) = server(false);
        launcher.crash_at_launch.store(true, Ordering::SeqCst);
        let error = s.ensure(spec("k", Arc::new(AtomicUsize::new(0))), None).await.unwrap_err();
        assert!(error.contains("exited during startup"), "{error}");
        let status = s.status();
        let last = status["lastError"].as_str().unwrap();
        assert!(last.contains("--api-key=[redacted]"), "{last}");
        assert_eq!(status["running"], false);
    }

    #[tokio::test(start_paused = true)]
    async fn an_unhealthy_server_times_out_and_is_stopped() {
        let (s, launcher, _) = server(false);
        let error = s.ensure(spec("k", Arc::new(AtomicUsize::new(0))), None).await.unwrap_err();
        assert!(error.contains("did not become ready"), "{error}");
        assert!(launcher.last.lock().unwrap().as_ref().unwrap().killed.load(Ordering::SeqCst));
        assert_eq!(s.status()["starting"], false);
    }

    #[tokio::test(start_paused = true)]
    async fn stop_cancels_a_pending_start_and_a_cancelled_caller_never_launches() {
        let (s, launcher, _) = server(false);
        let s = Arc::new(s);
        let pending = {
            let s = s.clone();
            tokio::spawn(async move { s.ensure(spec("k", Arc::new(AtomicUsize::new(0))), None).await })
        };
        tokio::time::sleep(Duration::from_millis(50)).await;
        s.stop().await.unwrap();
        assert_eq!(pending.await.unwrap().unwrap_err(), "aborted");
        let token = CancellationToken::new();
        token.cancel();
        let before = launcher.launched.load(Ordering::SeqCst);
        assert!(s.ensure(spec("k", Arc::new(AtomicUsize::new(0))), Some(token)).await.is_err());
        assert_eq!(launcher.launched.load(Ordering::SeqCst), before);
    }
}
