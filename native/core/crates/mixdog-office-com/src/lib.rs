//! Microsoft Office through COM: the transport to the PowerShell hosts that implement the operations.
//!
//! The scripts in `assets/` are the COM implementation and stay PowerShell. This crate embeds them, writes them under
//! the data directory, starts a host per call (one-shot) or per session (long-lived, one JSON line per request), and
//! keeps the guarantees the hosts depend on: a cancel or a timeout never kills a host, it only closes the host's stdin
//! so the host's own `finally` closes its document and quits the application it owns; a cleanup that did not finish is
//! reported pending, not forced; and every live session host gets that same EOF when [`OfficeCom::shutdown`] runs.
//!
//! Answers are the hosts' JSON, as `serde_json::Value`, with the transport's own failures in the same shape.

mod cleanup;
pub mod com;
pub mod identity;
pub mod platform;
pub mod ps;
mod oneshot;
mod route;
mod scripts;
mod session;

use std::ffi::OsString;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use mixdog_rt::LaneToken;
use mixdog_rt::LaneTokens;
use serde_json::Map;
use serde_json::Value;
use serde_json::json;
use tokio::runtime::Handle;
use tokio_util::sync::CancellationToken;

pub use cleanup::cleanup_error;
pub use identity::Identity;
pub use identity::Ownership;
pub use session::HostExit;

use session::Attach;
use session::BACKEND;
use session::HostClient;
use session::HostCommand;
use session::Running;
use session::Sessions;

/// How long a call may take unless its caller says otherwise.
pub const DEFAULT_TIMEOUT: Duration = Duration::from_millis(90_000);

/// How long the detect probe may take.
const DETECT_TIMEOUT: Duration = Duration::from_millis(20_000);

/// How long a host that was asked to end is waited for before its cleanup is reported pending.
pub const DRAIN_GRACE: Duration = Duration::from_millis(15_000);

/// How long a host that answered `close_session` is given to exit before it is ended.
pub const CLOSE_TIMEOUT: Duration = Duration::from_millis(15_000);

const UNSUPPORTED: &str = "Microsoft Office COM is available on Windows only";

/// Where the transport keeps its scripts and which lanes it runs on.
#[derive(Clone)]
pub struct OfficeComConfig {
    /// The scripts are written under `<data_dir>/office/com/<digest>/`.
    pub data_dir: PathBuf,
    pub tokens: LaneTokens,
    /// The wait for a host that was asked to end ([`DRAIN_GRACE`]).
    pub drain_grace: Duration,
    /// The program the formats on the Rust host list are started on (as `<program> office-com-host`): the service
    /// binary. The composer sets it, since the process composing the transport is not always that binary.
    pub rust_host_program: PathBuf,
    #[cfg(any(test, feature = "test-support"))]
    host_command: Option<HostCommand>,
    #[cfg(any(test, feature = "test-support"))]
    rust_host_formats: Option<Vec<String>>,
}

impl OfficeComConfig {
    pub fn new(data_dir: PathBuf, tokens: LaneTokens) -> Self {
        Self {
            data_dir,
            tokens,
            drain_grace: DRAIN_GRACE,
            rust_host_program: std::env::current_exe().unwrap_or_else(|_| PathBuf::from("mixdogd")),
            #[cfg(any(test, feature = "test-support"))]
            host_command: None,
            #[cfg(any(test, feature = "test-support"))]
            rust_host_formats: None,
        }
    }

    /// Hosts are started as `program args... <script path>` instead of through Windows PowerShell, and the transport is
    /// available on every platform: for a stand-in host that speaks the line protocol.
    #[cfg(any(test, feature = "test-support"))]
    #[must_use]
    pub fn with_host_command(mut self, program: PathBuf, args: Vec<OsString>) -> Self {
        self.host_command = Some((program, args));
        self
    }

    /// The formats served by the Rust host, in place of the compiled list.
    #[cfg(any(test, feature = "test-support"))]
    #[must_use]
    pub fn with_rust_host_formats(mut self, formats: &[&str]) -> Self {
        self.rust_host_formats = Some(formats.iter().map(|format| (*format).to_owned()).collect());
        self
    }
}

/// One call's timeout and cancellation.
#[derive(Clone, Debug)]
pub struct CallOptions {
    pub timeout: Duration,
    pub cancel: CancellationToken,
}

impl Default for CallOptions {
    fn default() -> Self {
        Self { timeout: DEFAULT_TIMEOUT, cancel: CancellationToken::new() }
    }
}

/// How a session is closed.
#[derive(Clone, Debug)]
pub struct CloseOptions {
    /// Whether the document is saved before it is closed.
    pub save: bool,
    /// How long the host has to answer `close_session`.
    pub timeout: Duration,
    /// How long the host has to exit after it answered, before it is ended.
    pub close_timeout: Duration,
    pub cancel: CancellationToken,
}

impl Default for CloseOptions {
    fn default() -> Self {
        Self { save: false, timeout: DEFAULT_TIMEOUT, close_timeout: CLOSE_TIMEOUT, cancel: CancellationToken::new() }
    }
}

/// A host's answer.
pub struct OfficeReply {
    pub value: Value,
    /// Set when the answer was given while the host was still ending (a cancel or a timeout): it settles once the
    /// host process is gone, which may be after the grace period. Callers that own files the host holds open wait on it.
    pub host_exit: Option<HostExit>,
}

impl OfficeReply {
    fn plain(value: Value) -> Self {
        Self { value, host_exit: None }
    }
}

/// The Office COM transport: its session hosts and the way to start more.
#[derive(Clone)]
pub struct OfficeCom {
    inner: Arc<Inner>,
}

struct Inner {
    config: OfficeComConfig,
    sessions: Arc<Sessions>,
}

fn unsupported() -> Value {
    json!({"ok": false, "available": false, "error": UNSUPPORTED})
}

/// `String(payload?.session || '')`, for the values a session id can sensibly be.
fn session_id_of(payload: &Value) -> String {
    match payload.get("session") {
        Some(Value::String(id)) => id.clone(),
        Some(Value::Number(number)) => match number.as_f64() {
            Some(n) if n == 0.0 || n.is_nan() => String::new(),
            Some(n) if n.fract() == 0.0 && n.abs() < 1e21 => format!("{n:.0}"),
            _ => number.to_string(),
        },
        Some(Value::Bool(true)) => "true".to_owned(),
        _ => String::new(),
    }
}

fn failed(value: &Value) -> bool {
    value.get("ok") != Some(&Value::Bool(true))
}

impl OfficeCom {
    pub fn new(config: OfficeComConfig) -> Self {
        Self { inner: Arc::new(Inner { config, sessions: Arc::new(Sessions::default()) }) }
    }

    /// Whether Office COM exists on this platform: Windows only.
    pub fn supported(&self) -> bool {
        self.inner.supported()
    }

    /// Which Office applications are installed and running, for docx, xlsx and pptx (one-shot, 20 s). `path` also tells
    /// whether that document is open in its application.
    pub async fn detect(&self, format: &str, path: &str) -> OfficeReply {
        // Off Windows there is no COM to probe, and starting powershell.exe would only report a spawn failure as if
        // Office were broken.
        if !self.supported() {
            return OfficeReply::plain(unsupported());
        }
        let payload = json!({"action": "detect", "format": format, "path": path});
        let options = CallOptions { timeout: DETECT_TIMEOUT, ..CallOptions::default() };
        self.inner.call_once(&payload, &options).await
    }

    /// One call. With a `session` in the payload it goes to that session's host as one request line; without, a host
    /// is started for it alone.
    pub async fn call(&self, payload: &Value, options: CallOptions) -> OfficeReply {
        if !self.supported() {
            return OfficeReply::plain(unsupported());
        }
        let session_id = session_id_of(payload);
        if session_id.is_empty() {
            return self.inner.call_once(payload, &options).await;
        }
        let Some(client) = self.inner.sessions.get(&session_id) else {
            return OfficeReply::plain(
                json!({"ok": false, "backend": BACKEND, "error": format!("Unknown Microsoft Office session: {session_id}")}),
            );
        };
        OfficeReply::plain(client.request(payload, options.timeout, &options.cancel).await)
    }

    /// Starts a session host and opens the session in it.
    pub async fn open_session(&self, payload: &Value, options: CallOptions) -> Value {
        if !self.supported() {
            return unsupported();
        }
        let session_id = session_id_of(payload);
        if session_id.is_empty() {
            return json!({"ok": false, "error": "Microsoft Office session id is required"});
        }
        let sessions = &self.inner.sessions;
        if !sessions.reserve(&session_id) {
            return json!({"ok": false, "error": format!("Microsoft Office session already exists: {session_id}")});
        }
        let running = match self.inner.start(true, payload.get("format").and_then(Value::as_str)).await {
            Ok(running) => running,
            Err(error) => {
                sessions.release(&session_id);
                return json!({"ok": false, "backend": BACKEND, "error": error});
            }
        };
        let client = HostClient::attach(
            running,
            Attach {
                session_id: session_id.clone(),
                one_shot: false,
                sessions: Arc::downgrade(sessions),
                grace: self.inner.config.drain_grace,
            },
        );
        sessions.register(client.clone());
        if client.is_closed() {
            sessions.remove(&session_id);
        }
        let mut request = match payload {
            Value::Object(map) => map.clone(),
            _ => Map::new(),
        };
        request.insert("action".to_owned(), Value::String("open_session".to_owned()));
        let mut result = client.request(&Value::Object(request), options.timeout, &options.cancel).await;
        if failed(&result) && !client.is_closing() {
            let existing = result.get("cleanup").filter(|cleanup| !cleanup.is_null()).cloned();
            let cleanup = match existing {
                Some(cleanup) => cleanup,
                None => {
                    let error = result.get("error").and_then(Value::as_str).unwrap_or_default().to_owned();
                    client.drain(&error).await
                }
            };
            let message = result.get("error").and_then(Value::as_str).map(str::to_owned);
            let with_cleanup = cleanup_error(message.as_deref().unwrap_or("undefined"), Some(&cleanup));
            if let Some(map) = result.as_object_mut() {
                map.insert("cleanup".to_owned(), cleanup);
                if message.is_some() || with_cleanup != "undefined" {
                    map.insert("error".to_owned(), Value::String(with_cleanup));
                }
            }
        }
        result
    }

    /// Closes a session: `close_session` to its host, then its stdin's EOF, and the host is ended only when it does not
    /// exit within [`CloseOptions::close_timeout`]. A session whose application is gone (the call failed because the
    /// RPC server is unreachable, or the cleanup says the process exited) is released with the unconfirmed cleanup
    /// carried in the result, so it is not left neither usable nor closable.
    pub async fn close_session(&self, session_id: &str, options: CloseOptions) -> Value {
        let Some(client) = self.inner.sessions.get(session_id) else {
            return json!({
                "ok": false,
                "closed": false,
                "reaped": true,
                "error": "Office session host is unavailable; application cleanup cannot be confirmed.",
            });
        };
        let request = json!({"action": "close_session", "session": session_id, "save": options.save});
        let mut result = client.request(&request, options.timeout, &options.cancel).await;
        let reaped = failed(&result) && cleanup::application_gone(&result);
        if !failed(&result) || reaped {
            if reaped && let Some(map) = result.as_object_mut() {
                map.insert("reaped".to_owned(), Value::Bool(true));
            }
            self.inner.sessions.remove(session_id);
            client.end_stdin();
            let graceful = client.is_closed()
                || client.has_exited()
                || mixdog_rt::time::timeout(options.close_timeout, client.wait_closed()).await.is_ok();
            client.mark_closed();
            if !graceful {
                client.kill();
                if let Some(map) = result.as_object_mut() {
                    map.insert("forcedHostCleanup".to_owned(), Value::Bool(true));
                }
            }
        }
        result
    }

    /// What the session's host has said about its application so far, `None` for an unknown session.
    pub fn session_identity(&self, session_id: &str) -> Option<Identity> {
        self.inner.sessions.get(session_id).map(|client| client.identity())
    }

    /// The end of the process: every live session host gets the EOF cleanup (its document closed, the application it
    /// owns quit, an attached application left alone), and this returns once each host has gone or its drain grace
    /// lapsed. A host still running when the process exits would be left with its file open and its application
    /// running, since the application is started by DCOM outside this process's job.
    pub async fn shutdown(&self) {
        let drains: Vec<_> = self.inner.sessions.all().iter().map(|client| client.drain_task("process exit")).collect();
        for drain in drains {
            let _ = drain.await;
        }
    }
}

impl Inner {
    fn supported(&self) -> bool {
        #[cfg(any(test, feature = "test-support"))]
        if self.config.host_command.is_some() {
            return true;
        }
        cfg!(windows)
    }

    /// Whether the Rust host serves `format`.
    fn rust_serves(&self, format: Option<&str>) -> bool {
        #[cfg(any(test, feature = "test-support"))]
        if let Some(formats) = &self.config.rust_host_formats {
            return route::serves(formats.iter().map(String::as_str), format);
        }
        route::serves(route::RUST_HOST_FORMATS.iter().copied(), format)
    }

    /// The program and leading arguments a PowerShell host is started with; the script path follows.
    fn powershell_command(&self) -> HostCommand {
        #[cfg(any(test, feature = "test-support"))]
        if let Some(command) = &self.config.host_command {
            return command.clone();
        }
        let program = match std::env::var_os("SystemRoot") {
            Some(root) => PathBuf::from(root).join("System32").join("WindowsPowerShell").join("v1.0").join("powershell.exe"),
            None => PathBuf::from("powershell.exe"),
        };
        let args = ["-NoLogo", "-NoProfile", "-NonInteractive", "-Sta", "-ExecutionPolicy", "Bypass", "-File"];
        (program, args.iter().map(OsString::from).collect())
    }

    /// Starts a host for a call or a session on `format`: the Rust host when it serves the format, otherwise
    /// PowerShell on the embedded script (written first, the bytes already there verified).
    async fn start(&self, session: bool, format: Option<&str>) -> Result<Running, String> {
        let rt = Handle::current();
        let tokens = self.config.tokens;
        let (program, args) = if self.rust_serves(format) {
            (self.config.rust_host_program.clone(), route::rust_host_args(session))
        } else {
            let script = if session { scripts::SESSION_HOST_SCRIPT } else { scripts::HOST_SCRIPT };
            let data_dir = self.config.data_dir.clone();
            let dir = tokens
                .maintenance_io
                .submit(&CancellationToken::new(), move |lane| scripts::ensure(lane, &data_dir))
                .map_err(|full| full.to_string())?
                .await
                .map_err(|dropped| dropped.to_string())?
                .map_err(|error| format!("Microsoft Office host scripts could not be written: {error}"))?;
            let (program, mut args) = self.powershell_command();
            args.push(dir.join(script).into_os_string());
            (program, args)
        };
        tokens
            .spawn_io
            .submit(&CancellationToken::new(), move |_lane| session::spawn_host(&program, &args, &rt))
            .map_err(|full| full.to_string())?
            .await
            .map_err(|dropped| dropped.to_string())?
            .map_err(|error| error.to_string())
    }

    async fn call_once(&self, payload: &Value, options: &CallOptions) -> OfficeReply {
        match self.start(false, route::one_shot_format(payload)).await {
            Ok(running) => {
                let client = oneshot::attach(running, self.config.drain_grace);
                oneshot::call_once(client, payload, options.timeout, &options.cancel).await
            }
            Err(error) => OfficeReply::plain(json!({"ok": false, "error": error})),
        }
    }
}
