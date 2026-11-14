//! Interactive login for ssh children that BatchMode cannot serve: a passphrase for a protected key, a password or a
//! keyboard-interactive code (the server half of the desktop's `ssh-auth.ts`; the client half is the `mixdog-askpass`
//! helper). The first try of every connection stays BatchMode; only a refused login is retried with `SSH_ASKPASS` set to
//! the helper. The helper dials back into this process over a private endpoint (a named pipe on Windows, a unix socket in
//! a 0700 folder elsewhere) and presents the attempt's random token; the prompter asks the user and the answer goes back
//! on the same connection. Answers live in memory for the session only, held in [`Zeroizing`] and never logged.
//!
//! Wire: one line `{"token":..,"prompt":..}` in (at most [`MAX_REQUEST_BYTES`] with its newline), one line
//! `{"ok":bool,"secret":string}` out. Prompts are answered one at a time, in the order the helpers arrive.

use std::collections::HashMap;
use std::io;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, LazyLock, Mutex, OnceLock};
use std::time::{Duration, Instant};

use async_trait::async_trait;
use mixdog_rt::{CancellationToken, DurabilityIo, InLane, LaneToken};
use regex::Regex;
use serde::Serialize;
use tokio::io::{AsyncBufReadExt, AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt, BufReader};
use tokio::sync::Semaphore;
use tokio::task::JoinHandle;
use zeroize::Zeroizing;

use crate::context::{AskpassEnv, Platform};

/// How long a question waits for the user before it counts as cancelled.
pub const ASKPASS_TIMEOUT_MS: u64 = 120_000;
/// A password or passphrase asked for again within this time was refused by the server.
pub const RETRY_WINDOW_MS: u64 = 2_000;
/// The largest request line (its newline included) a helper may send.
pub const MAX_REQUEST_BYTES: usize = 64 * 1024;

/// A connection that has not finished its exchange this long after the question's own timeout is dropped.
const CONNECTION_SLACK: Duration = Duration::from_secs(5);
const DIR_ATTEMPTS: usize = 16;

/// What a prompt asks for. `Otp` is a code the server asks for; `Other` is any server text that is neither a
/// passphrase, a password nor a recognizable code.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum AskpassKind {
    Passphrase,
    Password,
    Otp,
    Other,
}

/// One question put to the user.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AskpassQuestion {
    pub kind: AskpassKind,
    /// The prompt exactly as ssh printed it.
    pub prompt: String,
    /// The answer given before for this prompt was refused.
    pub retry: bool,
}

/// Puts a question in front of the user. `None` is a cancel. When the question times out or the session closes, the
/// future is dropped: that is the signal to close the dialog.
#[async_trait]
pub trait AskpassPrompter: Send + Sync {
    async fn ask(&self, question: AskpassQuestion) -> Option<String>;
}

static PASSPHRASE_PROMPT: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?i)passphrase").expect("the passphrase pattern is valid"));
static PASSWORD_PROMPT: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?i)password").expect("the password pattern is valid"));
static CODE_PROMPT: LazyLock<Regex> = LazyLock::new(|| {
    // ASCII word boundaries, as the script regular expression the desktop used.
    Regex::new(r"(?i)verification|one-time|otp|(?-u:\b)code(?-u:\b)|token|passcode|authenticator|(?-u:\b)pin(?-u:\b)|duo|yubikey")
        .expect("the code-prompt pattern is valid")
});

/// What a prompt asks for. Text the server supplies that is not clearly a code is `Other`, never taken for a one-time code.
pub fn classify_prompt(prompt: &str) -> AskpassKind {
    if PASSPHRASE_PROMPT.is_match(prompt) {
        AskpassKind::Passphrase
    } else if CODE_PROMPT.is_match(prompt) {
        AskpassKind::Otp
    } else if PASSWORD_PROMPT.is_match(prompt) {
        AskpassKind::Password
    } else {
        AskpassKind::Other
    }
}

/// Printable ASCII without spaces: a path ssh can name on Windows (it starts a jump host's ssh with the path as one
/// unquoted word, and cmd.exe reads wrapper paths in the console code page).
fn is_plain_path(path: &Path) -> bool {
    path.to_str().is_some_and(|text| !text.is_empty() && text.bytes().all(|b| (0x21..=0x7e).contains(&b)))
}

fn same_token(a: &[u8], b: &[u8]) -> bool {
    a.len() == b.len() && a.iter().zip(b).fold(0u8, |diff, (x, y)| diff | (x ^ y)) == 0
}

fn random_hex(bytes: usize) -> String {
    (0..bytes).map(|_| format!("{:02x}", rand::random::<u8>())).collect()
}

fn monotonic_ms() -> u64 {
    static EPOCH: OnceLock<Instant> = OnceLock::new();
    u64::try_from(EPOCH.get_or_init(Instant::now).elapsed().as_millis()).unwrap_or(u64::MAX)
}

/// How long a question waits and how long an answer counts as just given.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct AskpassTimings {
    pub timeout: Duration,
    pub retry_window: Duration,
}

impl Default for AskpassTimings {
    fn default() -> Self {
        Self { timeout: Duration::from_millis(ASKPASS_TIMEOUT_MS), retry_window: Duration::from_millis(RETRY_WINDOW_MS) }
    }
}

/// Starts askpass sessions: one per interactive retry of a connect attempt.
pub struct AskpassServer {
    prompter: Arc<dyn AskpassPrompter>,
    io: DurabilityIo,
    platform: Platform,
    plain_base: Option<PathBuf>,
    timings: AskpassTimings,
    clock: Arc<dyn Fn() -> u64 + Send + Sync>,
}

impl AskpassServer {
    pub fn new(prompter: Arc<dyn AskpassPrompter>, io: DurabilityIo, platform: Platform) -> Self {
        Self { prompter, io, platform, plain_base: None, timings: AskpassTimings::default(), clock: Arc::new(monotonic_ms) }
    }

    /// A plain-ASCII folder (the caller resolves it) a Windows helper whose own path is not plain is copied under.
    pub fn with_plain_base(mut self, base: PathBuf) -> Self {
        self.plain_base = Some(base);
        self
    }

    pub fn with_timings(mut self, timings: AskpassTimings) -> Self {
        self.timings = timings;
        self
    }

    /// The clock (milliseconds) the retry window is measured on.
    pub fn with_clock(mut self, clock: Arc<dyn Fn() -> u64 + Send + Sync>) -> Self {
        self.clock = clock;
        self
    }

    /// Opens the endpoint and returns the session whose environment points an ssh child at `helper`.
    pub async fn start(&self, helper: &Path) -> io::Result<AskpassSession> {
        let mut folders: Vec<PathBuf> = Vec::new();
        let result = self.start_in(helper, &mut folders).await;
        if result.is_err() {
            remove_folders(self.io, folders).await;
        }
        result
    }

    async fn start_in(&self, helper: &Path, folders: &mut Vec<PathBuf>) -> io::Result<AskpassSession> {
        let script = if self.platform.is_windows() && !is_plain_path(helper) {
            let base = self.plain_base.clone().ok_or_else(|| {
                io::Error::new(io::ErrorKind::InvalidInput, "the askpass helper's path is not plain ASCII and no plain folder is available for a copy")
            })?;
            if !is_plain_path(&base) {
                return Err(io::Error::new(io::ErrorKind::InvalidInput, "the folder for the askpass helper copy is not a plain ASCII path"));
            }
            let dir = new_private_dir(self.io, base, "mxa-").await?;
            folders.push(dir.clone());
            let target = dir.join(match helper.extension().and_then(|e| e.to_str()) {
                Some(ext) if ext.bytes().all(|b| b.is_ascii_alphanumeric()) => format!("askpass.{ext}"),
                _ => "askpass".to_owned(),
            });
            let (from, to) = (helper.to_path_buf(), target.clone());
            on_lane(self.io, move |lane| mixdog_fsio::copy(lane, from, to)).await??;
            target
        } else {
            helper.to_path_buf()
        };
        let token = random_hex(24);
        let (endpoint, control_dir) = if cfg!(windows) {
            (format!(r"\\.\pipe\mixdog-askpass-{}", random_hex(12)), None)
        } else {
            let dir = new_private_dir(self.io, std::env::temp_dir(), "mxa-").await?;
            folders.push(dir.clone());
            (dir.join("s").to_string_lossy().into_owned(), Some(dir))
        };
        let inner = Arc::new(Inner {
            token: token.clone(),
            closed: AtomicBool::new(false),
            cancelled: AtomicBool::new(false),
            answers: Mutex::new(HashMap::new()),
            turn: Semaphore::new(1),
            prompter: self.prompter.clone(),
            timings: self.timings,
            clock: self.clock.clone(),
            cancel: CancellationToken::new(),
        });
        let listener = bind(&endpoint)?;
        #[cfg(unix)]
        {
            // The socket itself is owner-only too (best effort: its folder already is).
            use std::os::unix::fs::PermissionsExt;
            let socket = PathBuf::from(&endpoint);
            drop(on_lane(self.io, move |lane| mixdog_fsio::set_permissions(lane, socket, std::fs::Permissions::from_mode(0o600))).await);
        }
        let task = tokio::spawn(accept_loop(listener, endpoint.clone(), inner.clone()));
        Ok(AskpassSession {
            env: vec![
                ("SSH_ASKPASS".to_owned(), script.to_string_lossy().into_owned()),
                ("MIXDOG_ASKPASS_ENDPOINT".to_owned(), endpoint),
                ("MIXDOG_ASKPASS_TOKEN".to_owned(), token),
            ],
            control_dir,
            folders: std::mem::take(folders),
            io: self.io,
            inner,
            task: Mutex::new(Some(task)),
        })
    }
}

async fn on_lane<R: Send + 'static>(io: DurabilityIo, job: impl FnOnce(&InLane<DurabilityIo>) -> R + Send + 'static) -> io::Result<R> {
    let handle = io.submit(&CancellationToken::new(), job).map_err(|full| io::Error::other(full.to_string()))?;
    handle.await.map_err(|dropped| io::Error::other(dropped.to_string()))
}

/// A new private (owner-only) folder `<parent>/<prefix><random>` that did not exist before.
async fn new_private_dir(io: DurabilityIo, parent: PathBuf, prefix: &'static str) -> io::Result<PathBuf> {
    on_lane(io, move |lane| {
        for _ in 0..DIR_ATTEMPTS {
            let dir = parent.join(format!("{prefix}{}", random_hex(4)));
            if mixdog_fsio::exists(lane, &dir).unwrap_or(true) {
                continue;
            }
            mixdog_statefile::create_private_dir_all(lane, &dir)?;
            return Ok(dir);
        }
        Err(io::Error::new(io::ErrorKind::AlreadyExists, "no unused askpass folder name was found"))
    })
    .await?
}

async fn remove_folders(io: DurabilityIo, folders: Vec<PathBuf>) {
    if folders.is_empty() {
        return;
    }
    // Best effort: a folder that is already gone or still held is left for the system's own cleanup.
    drop(
        on_lane(io, move |lane| {
            for folder in &folders {
                drop(mixdog_fsio::remove_dir_all(lane, folder));
            }
        })
        .await,
    );
}

/// What the connection tasks of one session share.
struct Inner {
    token: String,
    closed: AtomicBool,
    cancelled: AtomicBool,
    /// Password and passphrase answers with the time they were last handed out; one-time codes are never kept.
    answers: Mutex<HashMap<String, (Zeroizing<String>, u64)>>,
    /// One question at a time, in arrival order (the semaphore queues fairly).
    turn: Semaphore,
    prompter: Arc<dyn AskpassPrompter>,
    timings: AskpassTimings,
    clock: Arc<dyn Fn() -> u64 + Send + Sync>,
    cancel: CancellationToken,
}

fn locked<T>(mutex: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(std::sync::PoisonError::into_inner)
}

impl Inner {
    /// The user's answer to `prompt` (or the one given a moment ago), `None` when they cancelled or the time ran out.
    async fn answer(&self, prompt: &str) -> Option<Zeroizing<String>> {
        let Ok(_turn) = self.turn.acquire().await else {
            return None;
        };
        if self.closed.load(Ordering::SeqCst) {
            return None;
        }
        let kind = classify_prompt(prompt);
        let reusable = matches!(kind, AskpassKind::Passphrase | AskpassKind::Password);
        let window = u64::try_from(self.timings.retry_window.as_millis()).unwrap_or(u64::MAX);
        let mut retry = false;
        let reused = {
            let now = (self.clock)();
            let mut answers = locked(&self.answers);
            let mut reused = None;
            if let Some((secret, at)) = answers.get_mut(prompt) {
                retry = reusable && now.saturating_sub(*at) < window;
                if reusable && !retry {
                    *at = now;
                    reused = Some(secret.clone());
                }
            }
            if reused.is_none() {
                answers.remove(prompt);
            }
            reused
        };
        if reused.is_some() {
            return reused;
        }
        let question = AskpassQuestion { kind, prompt: prompt.to_owned(), retry };
        let asked = mixdog_rt::time::timeout(self.timings.timeout, self.prompter.ask(question)).await;
        let Some(secret) = asked.ok().flatten().map(Zeroizing::new) else {
            self.cancelled.store(true, Ordering::SeqCst);
            return None;
        };
        if reusable && !self.closed.load(Ordering::SeqCst) {
            locked(&self.answers).insert(prompt.to_owned(), (secret.clone(), (self.clock)()));
        }
        Some(secret)
    }
}

#[derive(Serialize)]
struct Reply<'a> {
    ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    secret: Option<&'a str>,
}

/// One helper connection: the request line in, the reply line out.
async fn serve<S: AsyncRead + AsyncWrite + Send + Unpin>(inner: &Inner, stream: S) {
    // A connection that does not finish is dropped, the question's own wait excluded.
    let _ = mixdog_rt::time::timeout(inner.timings.timeout + CONNECTION_SLACK, serve_exchange(inner, stream)).await;
}

async fn serve_exchange<S: AsyncRead + AsyncWrite + Send + Unpin>(inner: &Inner, stream: S) {
    let (mut read, mut write) = tokio::io::split(stream);
    let mut line = Vec::new();
    {
        let mut reader = BufReader::new((&mut read).take(MAX_REQUEST_BYTES as u64 + 1));
        if reader.read_until(b'\n', &mut line).await.is_err() || line.pop() != Some(b'\n') || line.len() + 1 > MAX_REQUEST_BYTES {
            return;
        }
    }
    let secret = request_secret(inner, &line).await;
    let body = Zeroizing::new(
        serde_json::to_string(&Reply { ok: secret.is_some(), secret: secret.as_ref().map(|s| s.as_str()) }).unwrap_or_default(),
    );
    let sent = async {
        write.write_all(body.as_bytes()).await?;
        write.write_all(b"\n").await?;
        write.flush().await
    }
    .await;
    if sent.is_err() {
        return;
    }
    drop(write.shutdown().await);
    // Wait for the helper to close its end: a pipe closed with the reply still unread may lose it.
    let mut rest = [0u8; 64];
    while matches!(read.read(&mut rest).await, Ok(n) if n > 0) {}
}

async fn request_secret(inner: &Inner, line: &[u8]) -> Option<Zeroizing<String>> {
    let request: serde_json::Value = serde_json::from_slice(line).ok()?;
    let token = request.get("token")?.as_str()?;
    let prompt = request.get("prompt")?.as_str()?;
    if inner.closed.load(Ordering::SeqCst) || !same_token(token.as_bytes(), inner.token.as_bytes()) {
        return None;
    }
    inner.answer(prompt).await
}

fn spawn_connection<S: AsyncRead + AsyncWrite + Send + Unpin + 'static>(inner: &Arc<Inner>, stream: S) {
    let inner = inner.clone();
    drop(tokio::spawn(async move {
        tokio::select! {
            () = inner.cancel.cancelled() => {}
            () = serve(&inner, stream) => {}
        }
    }));
}

#[cfg(windows)]
type Listener = tokio::net::windows::named_pipe::NamedPipeServer;
#[cfg(unix)]
type Listener = tokio::net::UnixListener;

#[cfg(windows)]
fn bind(endpoint: &str) -> io::Result<Listener> {
    // The first instance of a fresh random name: nothing else can already hold it.
    tokio::net::windows::named_pipe::ServerOptions::new().first_pipe_instance(true).reject_remote_clients(true).create(endpoint)
}

#[cfg(unix)]
fn bind(endpoint: &str) -> io::Result<Listener> {
    tokio::net::UnixListener::bind(endpoint)
}

#[cfg(windows)]
async fn accept_loop(mut server: Listener, endpoint: String, inner: Arc<Inner>) {
    use tokio::net::windows::named_pipe::ServerOptions;
    loop {
        tokio::select! {
            () = inner.cancel.cancelled() => break,
            connected = server.connect() => {
                if connected.is_err() {
                    break;
                }
                // The next instance exists before the connected one is handed off, so a helper never finds none.
                let Ok(next) = ServerOptions::new().reject_remote_clients(true).create(&endpoint) else {
                    break;
                };
                spawn_connection(&inner, std::mem::replace(&mut server, next));
            }
        }
    }
}

#[cfg(unix)]
async fn accept_loop(listener: Listener, _endpoint: String, inner: Arc<Inner>) {
    loop {
        tokio::select! {
            () = inner.cancel.cancelled() => break,
            accepted = listener.accept() => match accepted {
                Ok((stream, _)) => spawn_connection(&inner, stream),
                Err(_) => mixdog_rt::time::sleep(Duration::from_millis(50)).await,
            },
        }
    }
}

/// One askpass session: the endpoint, the token and the folders they live in.
pub struct AskpassSession {
    env: Vec<(String, String)>,
    control_dir: Option<PathBuf>,
    folders: Vec<PathBuf>,
    io: DurabilityIo,
    inner: Arc<Inner>,
    task: Mutex<Option<JoinHandle<()>>>,
}

impl AskpassSession {
    /// The user dismissed or timed out a prompt of this session.
    pub fn cancelled(&self) -> bool {
        self.inner.cancelled.load(Ordering::SeqCst)
    }

    /// Ends the session: later helpers are refused, open connections and questions are dropped, the answers are
    /// forgotten and the session's folders removed. Closing twice does nothing.
    pub async fn close(&self) {
        if self.inner.closed.swap(true, Ordering::SeqCst) {
            return;
        }
        locked(&self.inner.answers).clear();
        self.inner.cancel.cancel();
        let task = locked(&self.task).take();
        if let Some(task) = task {
            drop(task.await);
        }
        remove_folders(self.io, self.folders.clone()).await;
    }
}

impl AskpassEnv for AskpassSession {
    fn env(&self) -> Vec<(String, String)> {
        self.env.clone()
    }

    fn closed(&self) -> bool {
        self.inner.closed.load(Ordering::SeqCst)
    }

    fn control_dir(&self) -> Option<PathBuf> {
        self.control_dir.clone()
    }
}

#[cfg(test)]
#[path = "askpass_tests.rs"]
mod askpass_tests;
