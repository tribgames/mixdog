//! Language servers: one per (project root, server id), started on demand and spoken to over stdio JSON-RPC.
//! Status and diagnostics are pushed through an [`LspSink`].

use std::collections::HashMap;
use std::collections::HashSet;
use std::path::Path;
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::Mutex;
use std::sync::atomic::AtomicBool;
use std::sync::atomic::AtomicI64;
use std::sync::atomic::AtomicU8;
use std::sync::atomic::AtomicU64;
use std::sync::atomic::Ordering;
use std::time::Duration;
use std::time::Instant;

use mixdog_core_api::domain::common::AbsPath;
use mixdog_core_api::domain::process::CommandSpec;
use mixdog_core_api::domain::process::EnvSpec;
use mixdog_core_api::domain::process::OutputMode;
use mixdog_core_api::domain::process::OutputStream;
use mixdog_core_api::domain::process::ProcessEvent;
use mixdog_core_api::domain::process::ProcessManager;
use mixdog_core_api::domain::process::ProcessOwner;
use mixdog_core_api::domain::process::SpawnRequest;
use mixdog_protocol::ProcessHandle;
use serde_json::Value;
use serde_json::json;
use tokio::sync::mpsc;
use tokio::sync::oneshot;

use crate::error::WsError;
use crate::error::WsResult;
use crate::lspcaps;
use crate::lspwire::Framer;
use crate::lspwire::file_uri;
use crate::lspwire::frame;
use crate::lspwire::uri_to_path;
use crate::pathguard::comparable;
use crate::pathguard::is_within;
use crate::pathguard::project_entry_path;

const IDLE: Duration = Duration::from_secs(30);
const INITIALIZE_TIMEOUT: Duration = Duration::from_secs(10);
const REQUEST_TIMEOUT: Duration = Duration::from_secs(15);

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Spec {
    pub id: String,
    pub name: String,
    pub command: String,
    pub args: Vec<String>,
    pub project_candidates: Vec<PathBuf>,
}

fn spec(id: &str, name: &str, command: &str, args: &[&str]) -> Spec {
    Spec { id: id.into(), name: name.into(), command: command.into(), args: args.iter().map(|a| (*a).into()).collect(), project_candidates: Vec::new() }
}

/// `SERVER_BY_LANGUAGE`.
pub fn default_spec(language: &str) -> Option<Spec> {
    let ts = || spec("typescript-language-server", "TypeScript Language Server", "typescript-language-server", &["--stdio"]);
    let clangd = || spec("clangd", "clangd", "clangd", &["--background-index"]);
    Some(match language {
        "typescript" | "javascript" => ts(),
        "python" => Spec {
            project_candidates: vec![PathBuf::from("node_modules").join(".bin").join(if cfg!(windows) {
                "pyright-langserver.cmd"
            } else {
                "pyright-langserver"
            })],
            ..spec("pyright", "Pyright", "pyright-langserver", &["--stdio"])
        },
        "go" => spec("gopls", "gopls", "gopls", &[]),
        "rust" => spec("rust-analyzer", "rust-analyzer", "rust-analyzer", &[]),
        "c" | "cpp" | "objective-c" => clangd(),
        "ruby" => spec("ruby-lsp", "Ruby LSP", "ruby-lsp", &[]),
        _ => return None,
    })
}

pub const DEFAULT_LANGUAGES: &[&str] = &["typescript", "javascript", "python", "go", "rust", "c", "cpp", "objective-c", "ruby"];

/// The wire language for `didOpen`: Monaco has no JSX languages.
pub fn document_language_id(rel_path: &str, language_id: &str) -> String {
    let ext = Path::new(rel_path).extension().map(|e| format!(".{}", e.to_string_lossy().to_lowercase()));
    match (ext.as_deref(), language_id) {
        (Some(".tsx"), "typescript") => "typescriptreact".into(),
        (Some(".jsx"), "javascript") => "javascriptreact".into(),
        _ => language_id.into(),
    }
}

fn initialization_options(spec: &Spec) -> Option<Value> {
    (spec.id == "typescript-language-server").then(|| {
        json!({
            "hostInfo": "mixdog",
            "disableAutomaticTypingAcquisition": true,
            "maxTsServerMemory": 768,
            "tsserver": { "useSyntaxServer": "never" },
        })
    })
}

#[allow(clippy::disallowed_methods, reason = "a lane-job body: the manager only calls it through its maintenance lane")]
/// Project servers from `<root>/.mixdog/lsp.json`.
fn project_specs(root: &Path) -> WsResult<HashMap<String, Spec>> {
    let path = root.join(".mixdog").join("lsp.json");
    let meta = match std::fs::metadata(&path) {
        Ok(m) => m,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(HashMap::new()),
        Err(e) => return Err(e.into()),
    };
    if meta.len() > 262_144 {
        return Err(WsError::invalid("LSP configuration is too large."));
    }
    let value: Value = serde_json::from_slice(&std::fs::read(&path)?).map_err(|e| WsError::invalid(e.to_string()))?;
    let raw = value.get("servers").cloned().unwrap_or(Value::Null);
    let rows: Vec<Value> = match raw {
        Value::Array(a) => a,
        Value::Object(map) => map
            .into_iter()
            .map(|(id, server)| {
                let mut server = server.as_object().cloned().unwrap_or_default();
                server.insert("id".into(), Value::String(id));
                Value::Object(server)
            })
            .collect(),
        _ => return Err(WsError::invalid("LSP servers configuration is invalid.")),
    };
    if rows.len() > 64 {
        return Err(WsError::invalid("LSP servers configuration is invalid."));
    }
    let mut by_language = HashMap::new();
    for (index, row) in rows.iter().enumerate() {
        let (built, languages) = parse_server(root, index, row)?;
        for language in languages {
            if !language.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || "_+.-".contains(c)) {
                return Err(WsError::invalid(format!("LSP server {} language is invalid.", built.id)));
            }
            if by_language.insert(language.clone(), built.clone()).is_some() {
                return Err(WsError::invalid(format!("LSP language {language} is configured more than once.")));
            }
        }
    }
    Ok(by_language)
}

fn config_text(v: Option<&Value>, name: &str, max: usize) -> WsResult<String> {
    match v.and_then(Value::as_str) {
        Some(s) if !s.trim().is_empty() && s.len() <= max && !s.contains('\0') => Ok(s.trim().to_owned()),
        _ => Err(WsError::invalid(format!("{name} is invalid."))),
    }
}

fn config_list(v: Option<&Value>, name: &str, max: usize, len: usize) -> WsResult<Vec<String>> {
    match v.and_then(Value::as_array) {
        Some(a) if !a.is_empty() && a.len() <= max => a.iter().enumerate().map(|(i, e)| config_text(Some(e), &format!("{name}[{i}]"), len)).collect(),
        _ => Err(WsError::invalid(format!("{name} is invalid."))),
    }
}

/// One `servers` row of the project configuration, and the languages it serves.
fn parse_server(root: &Path, index: usize, row: &Value) -> WsResult<(Spec, Vec<String>)> {
    let Some(server) = row.as_object() else { return Err(WsError::invalid(format!("LSP server {index} is invalid."))) };
    let id = config_text(server.get("id"), &format!("LSP server {index} id"), 128)?;
    if !id.chars().all(|c| c.is_ascii_alphanumeric() || "._-".contains(c)) {
        return Err(WsError::invalid(format!("LSP server {index} id is invalid.")));
    }
    let command = config_text(server.get("command"), &format!("LSP server {id} command"), 4096)?;
    let languages: Vec<String> =
        config_list(server.get("languages"), &format!("LSP server {id} languages"), 32, 128)?.into_iter().map(|l| l.to_lowercase()).collect();
    let args = if server.get("args").is_none() { Vec::new() } else { config_list(server.get("args"), &format!("LSP server {id} args"), 64, 4096)? };
    let candidates =
        if server.get("candidates").is_none() { Vec::new() } else { config_list(server.get("candidates"), &format!("LSP server {id} candidates"), 32, 4096)? };
    let mut resolved = Vec::new();
    for candidate in candidates {
        if Path::new(&candidate).is_absolute() {
            return Err(WsError::invalid(format!("LSP server {id} candidate must be project-relative.")));
        }
        let target = crate::pathguard::lexical(&root.join(&candidate));
        if !is_within(root, &target) {
            return Err(WsError::invalid(format!("LSP server {id} candidate escaped the project.")));
        }
        resolved.push(target);
    }
    let name = if server.get("name").is_some() { config_text(server.get("name"), &format!("LSP server {id} name"), 128)? } else { id.clone() };
    Ok((Spec { id, name, command, args, project_candidates: resolved }, languages))
}

fn variants(path: PathBuf) -> Vec<PathBuf> {
    if !cfg!(windows) || path.extension().is_some() {
        return vec![path];
    }
    let mut all: Vec<PathBuf> = ["exe", "cmd", "bat"].iter().map(|e| PathBuf::from(format!("{}.{e}", path.display()))).collect();
    all.push(path);
    all
}

#[allow(clippy::disallowed_methods, reason = "a lane-job body: the manager only calls it through its maintenance lane")]
fn executable(path: &Path) -> bool {
    path.is_file()
}

#[allow(clippy::disallowed_methods, reason = "a lane-job body: the manager only calls it through its maintenance lane")]
fn resolve_executable(spec: &Spec, root: &Path) -> Option<PathBuf> {
    let command = spec.command.trim_matches('"');
    let mut candidates: Vec<PathBuf> =
        spec.project_candidates.iter().map(|c| if c.is_absolute() { c.clone() } else { root.join(c) }).flat_map(variants).collect();
    let given = Path::new(command);
    if given.is_absolute() {
        candidates.extend(variants(given.to_path_buf()));
    } else if command.contains('/') || command.contains('\\') {
        let target = crate::pathguard::lexical(&root.join(command));
        if is_within(root, &target) {
            candidates.extend(variants(target));
        }
    } else {
        let bins: &[&[&str]] = if cfg!(windows) {
            &[&["node_modules", ".bin"], &[".venv", "Scripts"], &["venv", "Scripts"]]
        } else {
            &[&["node_modules", ".bin"], &[".venv", "bin"], &["venv", "bin"]]
        };
        for bin in bins {
            let mut dir = root.to_path_buf();
            dir.extend(*bin);
            candidates.extend(variants(dir.join(command)));
        }
    }
    let mut seen = HashSet::new();
    for candidate in candidates {
        if seen.insert(candidate.clone()) && executable(&candidate) {
            return Some(candidate);
        }
    }
    if given.is_absolute() || command.contains('/') || command.contains('\\') {
        return None;
    }
    let extensions: Vec<&str> = if cfg!(windows) && Path::new(command).extension().is_none() { vec![".exe", ".cmd", ".bat", ""] } else { vec![""] };
    std::env::split_paths(&std::env::var_os("PATH").unwrap_or_default())
        .find_map(|dir| extensions.iter().map(|e| dir.join(format!("{command}{e}"))).find(|c| executable(c)))
}

/// Receives what the servers say; called from reader tasks, it must not block.
pub trait LspSink: Send + Sync + 'static {
    fn status(&self, event: Value);
    fn diagnostics(&self, event: Value);
    /// Removes a closed document's feeds without broadcasting a fake `"stopped"` status.
    fn clear_document(&self, project_path: &str, server: &str, _language_id: &str, rel_path: &str, uri: &str) {
        self.diagnostics(json!({
            "projectPath": project_path, "relPath": rel_path, "uri": uri,
            "server": server, "diagnostics": [],
        }));
    }
}

fn public_state(spec: Option<&Spec>, status: &str, detail: Option<&str>, caps: Option<&Value>) -> Value {
    let mut state = json!({
        "available": status == "ready",
        "status": status,
        "server": spec.map_or("", |s| s.name.as_str()),
    });
    if let Some(detail) = detail.filter(|d| !d.is_empty()) {
        state["detail"] = json!(detail);
    }
    if let Some(caps) = caps {
        state["capabilities"] = caps.clone();
    }
    state
}

fn session_key(root: &Path, spec: &Spec) -> String {
    format!("{}\0{}", comparable(root).display(), spec.id)
}

fn key_is_under(key: &str, root: &Path) -> bool {
    let Some((key_root, _)) = key.split_once('\0') else { return false };
    is_within(root, Path::new(key_root))
}

const DEFAULT_ATTACHMENT_ID: &str = "";

struct DocInfo {
    language_id: String,
    rel_path: String,
    server_version: i64,
    owners: HashSet<String>,
}

struct PendingRequestGuard<'a> {
    pending: &'a Mutex<HashMap<i64, oneshot::Sender<Result<Value, String>>>>,
    id: i64,
}

impl Drop for PendingRequestGuard<'_> {
    fn drop(&mut self) {
        self.pending.lock().expect("lsp pending").remove(&self.id);
    }
}

struct Conn {
    out: mpsc::UnboundedSender<Vec<u8>>,
    next_id: AtomicI64,
    pending: Mutex<HashMap<i64, oneshot::Sender<Result<Value, String>>>>,
}

impl Conn {
    fn notify(&self, method: &str, params: Value) {
        let _ = self.out.send(frame(&json!({ "jsonrpc": "2.0", "method": method, "params": params })));
    }

    fn respond(&self, id: &Value, result: Value) {
        let _ = self.out.send(frame(&json!({ "jsonrpc": "2.0", "id": id, "result": result })));
    }

    async fn request(&self, method: &str, params: Value, timeout: Duration, timeout_message: &str) -> Result<Value, String> {
        let id = self.next_id.fetch_add(1, Ordering::SeqCst);
        let (tx, rx) = oneshot::channel();
        self.pending.lock().expect("lsp pending").insert(id, tx);
        let _guard = PendingRequestGuard { pending: &self.pending, id };
        let _ = self.out.send(frame(&json!({ "jsonrpc": "2.0", "id": id, "method": method, "params": params })));
        match mixdog_rt::time::timeout(timeout, rx).await {
            Ok(Ok(result)) => result,
            Ok(Err(_)) => Err("The language server connection closed.".into()),
            Err(_) => Err(timeout_message.into()),
        }
    }

    fn fail_all(&self) {
        for (_, tx) in self.pending.lock().expect("lsp pending").drain() {
            let _ = tx.send(Err("The language server connection closed.".into()));
        }
    }
}

struct Session {
    id: u64,
    key: String,
    project_path: String,
    root: PathBuf,
    comparable_root: PathBuf,
    spec: Spec,
    handle: ProcessHandle,
    conn: Arc<Conn>,
    base_caps: Mutex<Value>,
    registrations: Mutex<HashMap<String, (String, Value)>>,
    language_ids: Mutex<HashSet<String>>,
    documents: Mutex<HashMap<String, DocInfo>>,
    closing: AtomicBool,
    killed: AtomicBool,
    ready: AtomicBool,
    reader_started: AtomicBool,
    exited_tx: tokio::sync::watch::Sender<bool>,
    exited_rx: tokio::sync::watch::Receiver<bool>,
    cancel: tokio_util::sync::CancellationToken,
    idle_generation: AtomicU64,
    idle_task: Mutex<Option<(u64, tokio::task::JoinHandle<()>)>>,
    stderr: Mutex<String>,
}

impl Session {
    fn registrations(&self) -> Vec<(String, Value)> {
        let mut rows: Vec<(String, (String, Value))> = self.registrations.lock().expect("lsp registrations").clone().into_iter().collect();
        rows.sort_by(|a, b| a.0.cmp(&b.0));
        rows.into_iter().map(|(_, row)| row).collect()
    }

    fn capabilities(&self, language_id: &str, uri: Option<&str>) -> Value {
        lspcaps::with_registrations(&self.base_caps.lock().expect("lsp caps"), &self.registrations(), language_id, uri)
    }

    fn cancel_idle(&self) {
        self.idle_generation.fetch_add(1, Ordering::SeqCst);
        if let Some((_, task)) = self.idle_task.lock().expect("lsp idle").take() {
            task.abort();
        }
    }

    fn is_active(&self) -> bool {
        !self.closing.load(Ordering::Acquire) && !self.cancel.is_cancelled()
    }

    fn mark_exited(&self) {
        let _ = self.exited_tx.send(true);
    }

    fn is_exited(&self) -> bool {
        *self.exited_rx.borrow()
    }

    async fn wait_exited(&self) {
        let mut rx = self.exited_rx.clone();
        let _ = rx.wait_for(|exited| *exited).await;
    }
}

async fn wait_closed(mut done: tokio::sync::watch::Receiver<()>) {
    while done.changed().await.is_ok() {}
}

async fn wait_optional_closed(done: Option<tokio::sync::watch::Receiver<()>>) {
    if let Some(done) = done {
        wait_closed(done).await;
    }
}

#[cfg(test)]
async fn wait_test_gate(gate: &Mutex<Option<(Arc<tokio::sync::Notify>, Arc<tokio::sync::Notify>)>>) {
    let gate = gate.lock().expect("lsp test gate").clone();
    if let Some((arrived, release)) = gate {
        let wait = release.notified();
        arrived.notify_waiters();
        wait.await;
    }
}

fn decrement_count<K, Q>(map: &mut HashMap<K, usize>, key: &Q)
where
    K: Eq + std::hash::Hash + std::borrow::Borrow<Q>,
    Q: Eq + std::hash::Hash + ?Sized,
{
    if let Some(count) = map.get_mut(key) {
        *count = count.saturating_sub(1);
        if *count == 0 {
            map.remove(key);
        }
    }
}

async fn kill_and_wait_exited(pm: &dyn ProcessManager, session: &Session) {
    session.conn.fail_all();
    if !session.killed.swap(true, Ordering::SeqCst) && matches!(pm.kill(&session.handle), Err(mixdog_core_api::domain::process::ProcessError::UnknownHandle)) {
        session.mark_exited();
    }
    if !session.reader_started.load(Ordering::Acquire) {
        session.mark_exited();
        return;
    }
    session.wait_exited().await;
}

fn spawn_stop_task(
    pm: Arc<dyn ProcessManager>,
    state: Arc<Mutex<ManagerState>>,
    session: Arc<Session>,
    graceful: bool,
    done_tx: tokio::sync::watch::Sender<()>,
) {
    mixdog_rt::spawn("lsp-stop", mixdog_rt::TaskClass::Work, async move {
        struct Finish {
            pm: Arc<dyn ProcessManager>,
            state: Arc<Mutex<ManagerState>>,
            session: Arc<Session>,
            _done: tokio::sync::watch::Sender<()>,
        }
        impl Drop for Finish {
            fn drop(&mut self) {
                if !self.session.killed.swap(true, Ordering::SeqCst) {
                    self.session.conn.fail_all();
                    let _ = self.pm.kill(&self.session.handle);
                }
                self.state.lock().expect("lsp state").stopping.remove(&self.session.id);
            }
        }
        let _finish = Finish { pm: pm.clone(), state, session: session.clone(), _done: done_tx };
        if graceful && session.conn.request("shutdown", Value::Null, Duration::from_secs(1), "shutdown timeout").await.is_ok() {
            session.conn.notify("exit", Value::Null);
        }
        kill_and_wait_exited(&*pm, &session).await;
    });
}

/// An editor document event (`lsp/document`).
#[derive(Clone, Debug, Default)]
pub struct DocumentInput {
    pub kind: String,
    pub language_id: String,
    pub rel_path: String,
    pub content: String,
    pub version: i64,
    pub attachment_id: Option<String>,
}

impl DocumentInput {
    pub fn from_value(value: &Value) -> WsResult<Self> {
        let text = |k: &str| value.get(k).and_then(Value::as_str).map(str::to_owned);
        let kind =
            text("kind").filter(|k| matches!(k.as_str(), "open" | "change" | "save" | "close")).ok_or_else(|| WsError::invalid("document.kind is invalid."))?;
        Ok(Self {
            kind,
            language_id: text("languageId").ok_or_else(|| WsError::invalid("document.languageId is invalid."))?,
            rel_path: text("relPath").ok_or_else(|| WsError::invalid("document.relPath is invalid."))?,
            content: text("content").unwrap_or_default(),
            version: value.get("version").and_then(Value::as_i64).unwrap_or(0),
            attachment_id: text("attachmentId"),
        })
    }
}

const FLIGHT_PENDING: u8 = 0;
const FLIGHT_READY: u8 = 1;
const FLIGHT_FAILED: u8 = 2;
const FLIGHT_CANCELLED: u8 = 3;

#[derive(Default)]
struct Health {
    missing_until: HashMap<String, Instant>,
    failures: HashMap<String, (u32, Instant)>,
}

struct PendingCall {
    id: u64,
    root: PathBuf,
    cancel: tokio_util::sync::CancellationToken,
}

impl PendingCall {
    fn is_cancelled(&self) -> bool {
        self.cancel.is_cancelled()
    }
}

struct CallGuard<'a> {
    manager: &'a LspManager,
    call: Arc<PendingCall>,
    registered: bool,
}

impl CallGuard<'_> {
    fn finish_locked(&mut self, state: &mut ManagerState) {
        if self.registered {
            self.registered = false;
            state.calls.remove(&self.call.id);
        }
    }
}

impl Drop for CallGuard<'_> {
    fn drop(&mut self) {
        if self.registered {
            self.registered = false;
            self.manager.state.lock().expect("lsp state").calls.remove(&self.call.id);
        }
    }
}

struct Starting {
    id: u64,
    done: tokio::sync::watch::Receiver<()>,
    cancel: tokio_util::sync::CancellationToken,
    outcome: AtomicU8,
    session: Mutex<Option<Arc<Session>>>,
    #[cfg(test)]
    waiter_joined: tokio::sync::Notify,
}

impl Starting {
    fn is_cancelled(&self) -> bool {
        self.cancel.is_cancelled()
    }
}

struct StartTarget {
    project_path: String,
    root: PathBuf,
    language_id: String,
    spec: Spec,
    key: String,
}

struct StartingGuard {
    manager: Arc<LspManager>,
    key: String,
    flight: Arc<Starting>,
    _mine: tokio::sync::watch::Sender<()>,
}

impl Drop for StartingGuard {
    fn drop(&mut self) {
        let mut state = self.manager.state.lock().expect("lsp state");
        if let Some(session) = self.flight.session.lock().expect("lsp starting session").take()
            && !session.ready.load(Ordering::SeqCst)
        {
            let _ = self.manager.begin_stop_locked(&mut state, &session, false, false, None);
        }
        if state.starting.get(&self.key).is_some_and(|e| e.id == self.flight.id) {
            state.starting.remove(&self.key);
        }
    }
}

struct Stopping {
    key: String,
    root: PathBuf,
    done: tokio::sync::watch::Receiver<()>,
}

struct OpenGuard {
    manager: Arc<LspManager>,
    session: Arc<Session>,
    active: bool,
}

impl OpenGuard {
    fn release_locked(&mut self, state: &mut ManagerState) {
        if self.active {
            self.active = false;
            state.release_open(self.session.id);
        }
    }
}

impl Drop for OpenGuard {
    fn drop(&mut self) {
        if self.active {
            self.active = false;
            let mut state = self.manager.state.lock().expect("lsp state");
            state.release_open(self.session.id);
            self.manager.schedule_idle_locked(&mut state, &self.session);
        }
    }
}

struct RootOpenGuard {
    manager: Arc<LspManager>,
    comparable_root: PathBuf,
    active: bool,
}

impl RootOpenGuard {
    fn release_locked(&mut self, state: &mut ManagerState) {
        if self.active {
            self.active = false;
            self.manager.release_root_open_locked(state, &self.comparable_root);
        }
    }
}

impl Drop for RootOpenGuard {
    fn drop(&mut self) {
        if self.active {
            self.active = false;
            let mut state = self.manager.state.lock().expect("lsp state");
            self.manager.release_root_open_locked(&mut state, &self.comparable_root);
        }
    }
}

enum EnsureOutcome {
    Live(Arc<Session>, Option<OpenGuard>),
    Cancelled,
    Unavailable,
}

#[derive(Default)]
struct ManagerState {
    sessions: HashMap<String, Arc<Session>>,
    starting: HashMap<String, Arc<Starting>>,
    stopping: HashMap<u64, Stopping>,
    active_opens: HashMap<u64, usize>,
    pending_opens_by_root: HashMap<PathBuf, usize>,
    calls: HashMap<u64, Arc<PendingCall>>,
    disposing_roots: HashMap<u64, PathBuf>,
    disposing_all: usize,
    states: HashMap<String, Value>,
    health: Health,
}

impl ManagerState {
    fn is_disposing(&self, root: &Path) -> bool {
        self.disposing_all > 0 || self.disposing_roots.values().any(|r| is_within(r, root))
    }

    fn is_live_session(&self, session: &Arc<Session>) -> bool {
        session.is_active() && !self.is_disposing(&session.root) && self.sessions.get(&session.key).is_some_and(|live| Arc::ptr_eq(live, session))
    }

    fn has_active_open(&self, session: &Session) -> bool {
        self.active_opens.get(&session.id).copied().unwrap_or(0) > 0 || self.pending_opens_by_root.get(&session.comparable_root).copied().unwrap_or(0) > 0
    }

    fn release_open(&mut self, session_id: u64) {
        decrement_count(&mut self.active_opens, &session_id);
    }

    fn release_root_open(&mut self, comparable_root: &Path) {
        decrement_count(&mut self.pending_opens_by_root, comparable_root);
    }

    fn record_failure(&mut self, key: &str) -> u64 {
        let count = (self.health.failures.get(key).map_or(0, |f| f.0) + 1).min(6);
        let delay = (1000u64 << (count - 1)).min(30_000);
        self.health.failures.insert(key.to_owned(), (count, Instant::now() + Duration::from_millis(delay)));
        delay
    }
}

struct DisposeGuard<'a> {
    manager: &'a LspManager,
    id: Option<u64>,
}

impl Drop for DisposeGuard<'_> {
    fn drop(&mut self) {
        let mut state = self.manager.state.lock().expect("lsp state");
        match self.id {
            Some(id) => {
                state.disposing_roots.remove(&id);
            }
            None => {
                state.disposing_all = state.disposing_all.saturating_sub(1);
            }
        }
    }
}

pub struct LspManager {
    pm: Arc<dyn ProcessManager>,
    lane: mixdog_rt::MaintenanceIo,
    sink: Arc<dyn LspSink>,
    /// Live sessions, single-flight starts, active shutdowns, active opens, in-flight calls,
    /// disposals, cached public states, and health backoff coordinated under one lock.
    state: Arc<Mutex<ManagerState>>,
    next_handle: AtomicU64,
    #[cfg(test)]
    resolve_override: Option<Arc<dyn Fn(&Spec, &Path) -> Option<PathBuf> + Send + Sync>>,
    #[cfg(test)]
    spec_override: Mutex<Option<Arc<dyn Fn(&Path, &str) -> WsResult<Option<Spec>> + Send + Sync>>>,
    #[cfg(test)]
    request_finalize_gate: Mutex<Option<(Arc<tokio::sync::Notify>, Arc<tokio::sync::Notify>)>>,
    #[cfg(test)]
    promote_gate: Mutex<Option<(Arc<tokio::sync::Notify>, Arc<tokio::sync::Notify>)>>,
    #[cfg(test)]
    document_post_ensure_gate: Mutex<Option<(Arc<tokio::sync::Notify>, Arc<tokio::sync::Notify>)>>,
}

fn client_capabilities() -> Value {
    json!({
        "workspace": {
            "workspaceFolders": true, "applyEdit": false,
            "executeCommand": { "dynamicRegistration": true },
            "symbol": { "dynamicRegistration": true }, "configuration": true,
        },
        "textDocument": {
            "synchronization": { "didSave": true, "dynamicRegistration": true },
            "publishDiagnostics": {
                "relatedInformation": true, "versionSupport": false,
                "tagSupport": { "valueSet": [1, 2] }, "codeDescriptionSupport": true, "dataSupport": true,
            },
            "completion": {
                "dynamicRegistration": true,
                "completionItem": {
                    "snippetSupport": true, "commitCharactersSupport": true, "insertReplaceSupport": true,
                    "deprecatedSupport": true, "documentationFormat": ["markdown", "plaintext"],
                    "resolveSupport": { "properties": ["detail", "documentation", "additionalTextEdits"] },
                },
                "completionList": { "itemDefaults": ["commitCharacters", "editRange", "insertTextFormat", "insertTextMode"] },
            },
            "signatureHelp": {
                "dynamicRegistration": true,
                "signatureInformation": {
                    "documentationFormat": ["markdown", "plaintext"],
                    "parameterInformation": { "labelOffsetSupport": true }, "activeParameterSupport": true,
                },
                "contextSupport": true,
            },
            "hover": { "dynamicRegistration": true, "contentFormat": ["markdown", "plaintext"] },
            "declaration": { "dynamicRegistration": true, "linkSupport": true },
            "definition": { "dynamicRegistration": true, "linkSupport": true },
            "typeDefinition": { "dynamicRegistration": true, "linkSupport": true },
            "implementation": { "dynamicRegistration": true, "linkSupport": true },
            "references": { "dynamicRegistration": true },
            "documentHighlight": { "dynamicRegistration": true },
            "linkedEditingRange": { "dynamicRegistration": true },
            "documentSymbol": { "dynamicRegistration": true, "hierarchicalDocumentSymbolSupport": true },
            "codeLens": { "dynamicRegistration": true },
            "rename": { "dynamicRegistration": true, "prepareSupport": true },
            "codeAction": {
                "dynamicRegistration": true, "dataSupport": true,
                "resolveSupport": { "properties": ["edit", "command"] },
                "codeActionLiteralSupport": { "codeActionKind": { "valueSet": ["", "quickfix", "refactor", "source"] } },
            },
            "formatting": { "dynamicRegistration": true },
            "rangeFormatting": { "dynamicRegistration": true },
            "onTypeFormatting": { "dynamicRegistration": true },
            "documentLink": { "dynamicRegistration": true, "tooltipSupport": true },
            "colorProvider": { "dynamicRegistration": true },
            "foldingRange": {
                "dynamicRegistration": true, "lineFoldingOnly": true,
                "foldingRangeKind": { "valueSet": ["comment", "imports", "region"] },
            },
            "selectionRange": { "dynamicRegistration": true },
            "semanticTokens": {
                "dynamicRegistration": true,
                "requests": { "range": true, "full": { "delta": true } },
                "tokenTypes": [
                    "namespace", "type", "class", "enum", "interface", "struct", "typeParameter", "parameter",
                    "variable", "property", "enumMember", "event", "function", "method", "macro", "keyword",
                    "modifier", "comment", "string", "number", "regexp", "operator", "decorator",
                ],
                "tokenModifiers": [
                    "declaration", "definition", "readonly", "static", "deprecated", "abstract", "async",
                    "modification", "documentation", "defaultLibrary",
                ],
                "formats": ["relative"], "overlappingTokenSupport": false, "multilineTokenSupport": false,
            },
            "inlayHint": {
                "dynamicRegistration": true,
                "resolveSupport": { "properties": ["tooltip", "textEdits", "label.tooltip", "label.location", "label.command"] },
            },
            "callHierarchy": { "dynamicRegistration": true },
        },
    })
}

fn sync_document(session: &Session, input: &DocumentInput, uri: &str) {
    let owner = input.attachment_id.as_deref().unwrap_or(DEFAULT_ATTACHMENT_ID);
    let mut docs = session.documents.lock().expect("lsp documents");
    match docs.get_mut(uri) {
        None => {
            let server_version = 1;
            // A restarted server lost its documents; any event on an unopened one becomes didOpen.
            session.conn.notify(
                "textDocument/didOpen",
                json!({ "textDocument": {
                    "uri": uri, "languageId": document_language_id(&input.rel_path, &input.language_id),
                    "version": server_version, "text": input.content,
                } }),
            );
            docs.insert(
                uri.to_owned(),
                DocInfo { language_id: input.language_id.clone(), rel_path: input.rel_path.clone(), server_version, owners: HashSet::from([owner.to_owned()]) },
            );
        }
        Some(_) if input.kind == "save" => {
            session.conn.notify("textDocument/didSave", json!({ "textDocument": { "uri": uri }, "text": input.content }));
        }
        Some(doc) => {
            if input.kind == "open" {
                doc.owners.insert(owner.to_owned());
            }
            doc.language_id = input.language_id.clone();
            doc.rel_path = input.rel_path.clone();
            doc.server_version = doc.server_version.saturating_add(1);
            session.conn.notify(
                "textDocument/didChange",
                json!({ "textDocument": { "uri": uri, "version": doc.server_version }, "contentChanges": [{ "text": input.content }] }),
            );
        }
    }
}

fn spawn_request(handle: &ProcessHandle, executable: &Path, spec: &Spec, root: &Path, language_id: &str) -> Option<SpawnRequest> {
    Some(SpawnRequest {
        handle: handle.clone(),
        command: CommandSpec::Argv { program: executable.to_string_lossy().into_owned(), args: spec.args.clone() },
        cwd: AbsPath::new(root.to_path_buf())?,
        env: EnvSpec { inherit: true, set: Vec::new(), remove: Vec::new() },
        pty: None,
        stdin_piped: true,
        output: OutputMode::Separate,
        owner: ProcessOwner::Lsp { root: AbsPath::new(root.to_path_buf())?, language: language_id.to_owned() },
        time_limit: None,
    })
}

fn initialize_params(root: &Path, spec: &Spec) -> Value {
    let workspace_folders = json!([{
        "uri": file_uri(root),
        "name": root.file_name().map_or_else(|| root.to_string_lossy().into_owned(), |n| n.to_string_lossy().into_owned()),
    }]);
    let mut params = json!({
        "processId": std::process::id(),
        "clientInfo": { "name": "Mixdog Desktop", "version": "0.9" },
        "rootUri": file_uri(root),
        "rootPath": root.to_string_lossy(),
        "workspaceFolders": workspace_folders,
        "capabilities": client_capabilities(),
    });
    if let Some(options) = initialization_options(spec) {
        params["initializationOptions"] = options;
    }
    params
}

fn relative_document_path(root: &Path, uri: &str) -> Option<String> {
    let absolute = crate::pathguard::lexical(&uri_to_path(uri)?);
    if !is_within(root, &absolute) {
        return None;
    }
    let full = absolute.to_string_lossy().into_owned();
    let rest = full.get(root.to_string_lossy().len()..)?;
    Some(rest.trim_start_matches(['\\', '/']).replace('\\', "/"))
}

impl LspManager {
    pub fn new(pm: Arc<dyn ProcessManager>, sink: Arc<dyn LspSink>, lane: mixdog_rt::MaintenanceIo) -> Arc<Self> {
        Arc::new(Self {
            pm,
            lane,
            sink,
            state: Arc::default(),
            next_handle: AtomicU64::new(1),
            #[cfg(test)]
            resolve_override: None,
            #[cfg(test)]
            spec_override: Mutex::default(),
            #[cfg(test)]
            request_finalize_gate: Mutex::default(),
            #[cfg(test)]
            promote_gate: Mutex::default(),
            #[cfg(test)]
            document_post_ensure_gate: Mutex::default(),
        })
    }

    #[cfg(test)]
    fn with_resolver(
        pm: Arc<dyn ProcessManager>,
        sink: Arc<dyn LspSink>,
        lane: mixdog_rt::MaintenanceIo,
        resolver: Arc<dyn Fn(&Spec, &Path) -> Option<PathBuf> + Send + Sync>,
    ) -> Arc<Self> {
        Arc::new(Self {
            pm,
            lane,
            sink,
            state: Arc::default(),
            next_handle: AtomicU64::new(1),
            resolve_override: Some(resolver),
            spec_override: Mutex::default(),
            request_finalize_gate: Mutex::default(),
            promote_gate: Mutex::default(),
            document_post_ensure_gate: Mutex::default(),
        })
    }

    fn begin_call(&self, root: &Path) -> CallGuard<'_> {
        let id = self.next_handle.fetch_add(1, Ordering::SeqCst);
        let call = Arc::new(PendingCall { id, root: root.to_path_buf(), cancel: tokio_util::sync::CancellationToken::new() });
        let mut state = self.state.lock().expect("lsp state");
        let registered = if state.is_disposing(root) {
            call.cancel.cancel();
            false
        } else {
            state.calls.insert(id, call.clone());
            true
        };
        CallGuard { manager: self, call, registered }
    }

    fn begin_root_open(self: &Arc<Self>, root: &Path) -> RootOpenGuard {
        let comparable_root = comparable(root);
        let mut state = self.state.lock().expect("lsp state");
        *state.pending_opens_by_root.entry(comparable_root.clone()).or_default() += 1;
        RootOpenGuard { manager: self.clone(), comparable_root, active: true }
    }

    async fn spec_for(&self, root: &Path, language_id: &str, cancel: &tokio_util::sync::CancellationToken) -> WsResult<Option<Spec>> {
        let (root, language) = (root.to_path_buf(), language_id.to_lowercase());
        #[cfg(test)]
        let spec_override = self.spec_override.lock().expect("lsp spec override").clone();
        tokio::select! {
            biased;
            _ = cancel.cancelled() => Err(WsError::new(crate::error::Reason::Cancelled, "LSP cancelled.")),
            result = crate::lanes::run_fallible(self.lane, cancel, move || {
                #[cfg(test)]
                if let Some(override_fn) = spec_override {
                    return override_fn(&root, &language);
                }
                let mut project = project_specs(&root)?;
                Ok(project.remove(&language).or_else(|| default_spec(&language)))
            }) => result,
        }
    }

    #[allow(clippy::too_many_arguments)]
    fn emit_status_locked(
        &self,
        state: &mut ManagerState,
        (project_path, root, language_id): (&str, &Path, &str),
        spec: Option<&Spec>,
        status: &str,
        detail: Option<&str>,
        caps: Option<&Value>,
        rel_path: Option<&str>,
    ) -> Value {
        let public = public_state(spec, status, detail, caps);
        if let Some(spec) = spec {
            state.states.insert(session_key(root, spec), public.clone());
        }
        let mut event = json!({ "projectPath": project_path, "languageId": language_id });
        if let Some(rel) = rel_path {
            event["relPath"] = json!(rel);
        }
        if let (Some(e), Some(s)) = (event.as_object_mut(), public.as_object()) {
            e.extend(s.clone());
        }
        self.sink.status(event);
        public
    }

    fn refresh_capabilities(&self, session: &Arc<Session>) {
        let mut state = self.state.lock().expect("lsp state");
        if !session.ready.load(Ordering::Acquire) || !state.is_live_session(session) {
            return;
        }
        let docs: Vec<(String, String, String)> =
            session.documents.lock().expect("lsp documents").iter().map(|(uri, d)| (uri.clone(), d.language_id.clone(), d.rel_path.clone())).collect();
        let mut emitted = HashSet::new();
        for (uri, language, rel) in docs {
            let caps = session.capabilities(&language, Some(&uri));
            emitted.insert(language.clone());
            self.emit_status_locked(&mut state, (&session.project_path, &session.root, &language), Some(&session.spec), "ready", None, Some(&caps), Some(&rel));
        }
        let languages: Vec<String> = session.language_ids.lock().expect("lsp languages").iter().cloned().collect();
        for language in languages.into_iter().filter(|l| !emitted.contains(l)) {
            let caps = session.capabilities(&language, None);
            self.emit_status_locked(&mut state, (&session.project_path, &session.root, &language), Some(&session.spec), "ready", None, Some(&caps), None);
        }
    }

    fn clear_document_feeds(&self, project_path: &str, spec: &Spec, uri: &str, language_id: &str, rel_path: &str) {
        self.sink.clear_document(project_path, &spec.name, language_id, rel_path, uri);
    }

    fn clear_session_documents(&self, session: &Session) {
        let docs: Vec<(String, DocInfo)> = session.documents.lock().expect("lsp documents").drain().collect();
        for (uri, doc) in docs {
            self.clear_document_feeds(&session.project_path, &session.spec, &uri, &doc.language_id, &doc.rel_path);
        }
    }

    fn stopped_locked(&self, state: &mut ManagerState, session: &Arc<Session>, language_id: &str) {
        if session.closing.swap(true, Ordering::SeqCst) {
            return;
        }
        session.cancel.cancel();
        session.cancel_idle();
        let was_live = if state.sessions.get(&session.key).is_some_and(|live| Arc::ptr_eq(live, session)) {
            state.sessions.remove(&session.key);
            true
        } else {
            false
        };
        if !was_live || state.is_disposing(&session.root) {
            return;
        }
        self.clear_session_documents(session);
        let delay = state.record_failure(&session.key);
        let tail = session.stderr.lock().expect("lsp stderr").trim().lines().last().map(|l| l.chars().take(200).collect::<String>());
        let detail = [tail, Some(format!("Retrying after {}s.", delay.div_ceil(1000)))].into_iter().flatten().collect::<Vec<_>>().join(" ");
        self.emit_status_locked(state, (&session.project_path, &session.root, language_id), Some(&session.spec), "stopped", Some(&detail), None, None);
    }

    /// A live session of the key, or a started one.
    async fn ensure(self: &Arc<Self>, project_path: &str, root: &Path, language_id: &str, spec: &Spec, call: &PendingCall, hold_open: bool) -> EnsureOutcome {
        let key = session_key(root, spec);
        loop {
            enum EnsureStep {
                Live(Arc<Session>, Option<OpenGuard>),
                WaitFlight(Arc<Starting>, bool),
                WaitStopping(tokio::sync::watch::Receiver<()>),
                Cancelled,
                Unavailable,
            }
            let step = {
                let mut state = self.state.lock().expect("lsp state");
                if call.is_cancelled() || state.is_disposing(root) {
                    EnsureStep::Cancelled
                } else if let Some(live) = state.sessions.get(&key).cloned().filter(|s| s.is_active()) {
                    live.cancel_idle();
                    let open_guard = hold_open.then(|| {
                        *state.active_opens.entry(live.id).or_default() += 1;
                        OpenGuard { manager: self.clone(), session: live.clone(), active: true }
                    });
                    EnsureStep::Live(live, open_guard)
                } else if let Some(other) = state.starting.get(&key).cloned() {
                    EnsureStep::WaitFlight(other, true)
                } else if let Some(stopping) = state.stopping.values().find(|s| s.key == key) {
                    EnsureStep::WaitStopping(stopping.done.clone())
                } else {
                    let now = Instant::now();
                    let health_blocks =
                        state.health.missing_until.get(&key).is_some_and(|t| *t > now) || state.health.failures.get(&key).is_some_and(|f| f.1 > now);
                    if health_blocks {
                        EnsureStep::Unavailable
                    } else {
                        let (mine, receiver) = tokio::sync::watch::channel(());
                        let flight = Arc::new(Starting {
                            id: self.next_handle.fetch_add(1, Ordering::SeqCst),
                            done: receiver,
                            cancel: tokio_util::sync::CancellationToken::new(),
                            outcome: AtomicU8::new(FLIGHT_PENDING),
                            session: Mutex::new(None),
                            #[cfg(test)]
                            waiter_joined: tokio::sync::Notify::new(),
                        });
                        state.starting.insert(key.clone(), flight.clone());
                        let guard = StartingGuard { manager: self.clone(), key: key.clone(), flight: flight.clone(), _mine: mine };
                        let manager = self.clone();
                        let target = StartTarget {
                            project_path: project_path.to_owned(),
                            root: root.to_path_buf(),
                            language_id: language_id.to_owned(),
                            spec: spec.clone(),
                            key: key.clone(),
                        };
                        let start_flight = flight.clone();
                        mixdog_rt::spawn("lsp-start", mixdog_rt::TaskClass::Work, async move {
                            manager.run_start(target, &start_flight, guard).await;
                        });
                        EnsureStep::WaitFlight(flight, false)
                    }
                }
            };
            match step {
                EnsureStep::Live(live, guard) => return EnsureOutcome::Live(live, guard),
                EnsureStep::Cancelled => return EnsureOutcome::Cancelled,
                EnsureStep::Unavailable => return EnsureOutcome::Unavailable,
                EnsureStep::WaitStopping(done) => {
                    let cancelled = tokio::select! {
                        biased;
                        _ = call.cancel.cancelled() => true,
                        _ = wait_closed(done) => false,
                    };
                    if cancelled || call.is_cancelled() {
                        return EnsureOutcome::Cancelled;
                    }
                }
                // The start task never sends: `changed` fails exactly when it drops `StartingGuard`.
                EnsureStep::WaitFlight(other, is_waiter) => {
                    let done = other.done.clone();
                    #[cfg(test)]
                    if is_waiter {
                        other.waiter_joined.notify_one();
                    }
                    #[cfg(not(test))]
                    let _ = is_waiter;
                    let cancelled = tokio::select! {
                        biased;
                        _ = call.cancel.cancelled() => true,
                        _ = other.cancel.cancelled() => true,
                        _ = wait_closed(done) => false,
                    };
                    let outcome = other.outcome.load(Ordering::SeqCst);
                    if cancelled || other.is_cancelled() || call.is_cancelled() || outcome == FLIGHT_CANCELLED {
                        return EnsureOutcome::Cancelled;
                    }
                    if outcome == FLIGHT_FAILED {
                        return EnsureOutcome::Unavailable;
                    }
                }
            }
        }
    }

    async fn run_start(self: &Arc<Self>, target: StartTarget, flight: &Starting, guard: StartingGuard) {
        let _guard = guard;
        let StartTarget { project_path, root, language_id, spec, key } = target;
        {
            let mut state = self.state.lock().expect("lsp state");
            if flight.is_cancelled() || state.is_disposing(&root) {
                flight.outcome.store(FLIGHT_CANCELLED, Ordering::SeqCst);
                return;
            }
            self.emit_status_locked(&mut state, (&project_path, &root, &language_id), Some(&spec), "starting", None, None, None);
        }
        let (probe_spec, probe_root) = (spec.clone(), root.clone());
        #[cfg(test)]
        let probe_override = self.resolve_override.clone();
        let found = tokio::select! {
            biased;
            _ = flight.cancel.cancelled() => {
                flight.outcome.store(FLIGHT_CANCELLED, Ordering::SeqCst);
                return;
            }
            found = crate::lanes::run(self.lane, &flight.cancel, move || {
                #[cfg(test)]
                if let Some(resolver) = probe_override {
                    return resolver(&probe_spec, &probe_root);
                }
                resolve_executable(&probe_spec, &probe_root)
            }) => found.ok().flatten(),
        };
        if flight.is_cancelled() {
            flight.outcome.store(FLIGHT_CANCELLED, Ordering::SeqCst);
            return;
        }
        let Some(executable) = found else {
            let mut state = self.state.lock().expect("lsp state");
            if flight.is_cancelled() || state.is_disposing(&root) {
                flight.outcome.store(FLIGHT_CANCELLED, Ordering::SeqCst);
                return;
            }
            state.health.missing_until.insert(key, Instant::now() + Duration::from_secs(30));
            flight.outcome.store(FLIGHT_FAILED, Ordering::SeqCst);
            self.emit_status_locked(&mut state, (&project_path, &root, &language_id), Some(&spec), "missing", None, None, None);
            return;
        };
        let session_id = self.next_handle.fetch_add(1, Ordering::SeqCst);
        let handle = ProcessHandle::from(format!("lsp-{}-{}", std::process::id(), session_id).as_str());
        let Some(request) = spawn_request(&handle, &executable, &spec, &root, &language_id) else {
            flight.outcome.store(FLIGHT_FAILED, Ordering::SeqCst);
            return;
        };
        let (out_tx, out_rx) = mpsc::unbounded_channel::<Vec<u8>>();
        let conn = Arc::new(Conn { out: out_tx, next_id: AtomicI64::new(1), pending: Mutex::default() });
        let (exited_tx, exited_rx) = tokio::sync::watch::channel(false);
        let session = Arc::new(Session {
            id: session_id,
            key: key.clone(),
            project_path: project_path.clone(),
            root: root.clone(),
            comparable_root: comparable(&root),
            spec: spec.clone(),
            handle: handle.clone(),
            conn: conn.clone(),
            base_caps: Mutex::new(json!({})),
            registrations: Mutex::default(),
            language_ids: Mutex::new(HashSet::from([language_id.clone()])),
            documents: Mutex::default(),
            closing: AtomicBool::new(false),
            killed: AtomicBool::new(false),
            ready: AtomicBool::new(false),
            reader_started: AtomicBool::new(false),
            exited_tx,
            exited_rx,
            cancel: tokio_util::sync::CancellationToken::new(),
            idle_generation: AtomicU64::new(0),
            idle_task: Mutex::default(),
            stderr: Mutex::default(),
        });
        if flight.is_cancelled() {
            flight.outcome.store(FLIGHT_CANCELLED, Ordering::SeqCst);
            return;
        }
        let (_, events) = match self.pm.spawn_subscribed_cancellable(request, flight.cancel.clone()).await {
            Ok(spawned) => spawned,
            Err(error) => {
                if flight.is_cancelled() {
                    session.closing.store(true, Ordering::SeqCst);
                    session.cancel.cancel();
                    session.mark_exited();
                    flight.outcome.store(FLIGHT_CANCELLED, Ordering::SeqCst);
                    return;
                }
                flight.outcome.store(FLIGHT_FAILED, Ordering::SeqCst);
                self.fail_start(&session, flight, &language_id, &format!("{} could not be started: {error:?}", spec.name)).await;
                return;
            }
        };
        *flight.session.lock().expect("lsp starting session") = Some(session.clone());
        self.attach_io(&session, events, out_rx, &language_id);
        if flight.is_cancelled() {
            flight.outcome.store(FLIGHT_CANCELLED, Ordering::SeqCst);
            self.shutdown_cancelled(&session, false).await;
            return;
        }
        let params = initialize_params(&root, &spec);
        let message = format!("{} did not finish initializing.", spec.name);
        let init = tokio::select! {
            biased;
            _ = flight.cancel.cancelled() => None,
            result = conn.request("initialize", params, INITIALIZE_TIMEOUT, &message) => Some(result),
        };
        match init {
            Some(Ok(initialization)) => {
                let caps = lspcaps::normalize(&initialization);
                *session.base_caps.lock().expect("lsp caps") = caps.clone();
                #[cfg(test)]
                wait_test_gate(&self.promote_gate).await;
                let stop_done = {
                    let mut state = self.state.lock().expect("lsp state");
                    if flight.is_cancelled() || state.is_disposing(&root) {
                        flight.outcome.store(FLIGHT_CANCELLED, Ordering::SeqCst);
                        self.begin_stop_locked(&mut state, &session, true, false, None)
                    } else if session.is_exited() || session.closing.load(Ordering::SeqCst) {
                        flight.outcome.store(FLIGHT_FAILED, Ordering::SeqCst);
                        self.fail_start_locked(&mut state, &session, flight, &language_id, "The language server exited during initialization.")
                    } else {
                        debug_assert!(!state.sessions.contains_key(&key));
                        state.sessions.insert(key.clone(), session.clone());
                        if state.starting.get(&key).is_some_and(|e| e.id == flight.id) {
                            state.starting.remove(&key);
                        }
                        state.health.failures.remove(&key);
                        session.ready.store(true, Ordering::SeqCst);
                        flight.outcome.store(FLIGHT_READY, Ordering::SeqCst);
                        conn.notify("initialized", json!({}));
                        self.emit_status_locked(&mut state, (&project_path, &root, &language_id), Some(&spec), "ready", None, Some(&caps), None);
                        self.schedule_idle_locked(&mut state, &session);
                        None
                    }
                };
                wait_optional_closed(stop_done).await;
            }
            Some(Err(error)) => {
                if flight.is_cancelled() {
                    flight.outcome.store(FLIGHT_CANCELLED, Ordering::SeqCst);
                    self.shutdown_cancelled(&session, false).await;
                } else {
                    flight.outcome.store(FLIGHT_FAILED, Ordering::SeqCst);
                    self.fail_start(&session, flight, &language_id, &error).await;
                }
            }
            None => {
                flight.outcome.store(FLIGHT_CANCELLED, Ordering::SeqCst);
                self.shutdown_cancelled(&session, false).await;
            }
        }
    }

    async fn shutdown_cancelled(&self, session: &Arc<Session>, initialized: bool) {
        let done = {
            let mut state = self.state.lock().expect("lsp state");
            self.begin_stop_locked(&mut state, session, initialized, false, None)
        };
        wait_optional_closed(done).await;
    }

    /// A writer task keeps outgoing frames in order; a reader task dispatches everything the server sends, from before `initialize`.
    fn attach_io(
        self: &Arc<Self>,
        session: &Arc<Session>,
        events: Box<dyn mixdog_core_api::domain::common::EventSource<ProcessEvent>>,
        mut out_rx: mpsc::UnboundedReceiver<Vec<u8>>,
        language_id: &str,
    ) {
        session.reader_started.store(true, Ordering::Release);
        let pm = self.pm.clone();
        let writer_handle = session.handle.clone();
        mixdog_rt::spawn("lsp-writer", mixdog_rt::TaskClass::Work, async move {
            while let Some(bytes) = out_rx.recv().await {
                if pm.write_stdin(&writer_handle, bytes).await.is_err() {
                    break;
                }
            }
        });
        let this = self.clone();
        let reader_session = session.clone();
        let reader_language = language_id.to_owned();
        mixdog_rt::spawn("lsp-reader", mixdog_rt::TaskClass::Work, async move {
            struct ExitedGuard(Arc<Session>);
            impl Drop for ExitedGuard {
                fn drop(&mut self) {
                    self.0.mark_exited();
                }
            }
            let _exited = ExitedGuard(reader_session.clone());
            let mut events = events;
            let mut framer = Framer::default();
            while let Some(event) = events.next().await {
                match event {
                    ProcessEvent::Output { stream: OutputStream::Stdout, bytes, .. } => {
                        for message in framer.push(&bytes) {
                            this.dispatch(&reader_session, message);
                        }
                    }
                    ProcessEvent::Output { stream: OutputStream::Stderr, bytes, .. } => {
                        let mut tail = reader_session.stderr.lock().expect("lsp stderr");
                        tail.push_str(&String::from_utf8_lossy(&bytes));
                        let cut = tail.len().saturating_sub(4000);
                        if cut > 0 {
                            let boundary = (cut..tail.len()).find(|i| tail.is_char_boundary(*i)).unwrap_or(tail.len());
                            tail.drain(..boundary);
                        }
                    }
                    ProcessEvent::Output { .. } => {}
                    ProcessEvent::Exited { .. } => break,
                }
            }
            reader_session.conn.fail_all();
            {
                let mut state = this.state.lock().expect("lsp state");
                reader_session.mark_exited();
                if reader_session.ready.load(Ordering::SeqCst) && !reader_session.closing.load(Ordering::SeqCst) {
                    this.stopped_locked(&mut state, &reader_session, &reader_language);
                }
            }
        });
    }

    fn fail_start_locked(
        &self,
        state: &mut ManagerState,
        session: &Arc<Session>,
        flight: &Starting,
        language_id: &str,
        error: &str,
    ) -> Option<tokio::sync::watch::Receiver<()>> {
        let done = self.begin_stop_locked(state, session, false, false, None);
        if !flight.is_cancelled() && !state.is_disposing(&session.root) {
            let delay = state.record_failure(&session.key);
            let tail = session.stderr.lock().expect("lsp stderr").trim().lines().last().map(|l| l.chars().take(500).collect::<String>());
            let detail =
                [Some(error.to_owned()), tail, Some(format!("Retrying after {}s.", delay.div_ceil(1000)))].into_iter().flatten().collect::<Vec<_>>().join(" ");
            self.emit_status_locked(state, (&session.project_path, &session.root, language_id), Some(&session.spec), "error", Some(&detail), None, None);
        }
        done
    }

    /// A handshake that never completed: end the process, report why with the retry delay.
    async fn fail_start(&self, session: &Arc<Session>, flight: &Starting, language_id: &str, error: &str) {
        let done = {
            let mut state = self.state.lock().expect("lsp state");
            self.fail_start_locked(&mut state, session, flight, language_id, error)
        };
        wait_optional_closed(done).await;
    }

    fn dispatch(&self, session: &Arc<Session>, message: Value) {
        let method = message.get("method").and_then(Value::as_str);
        let id = message.get("id").filter(|v| !v.is_null());
        match (method, id) {
            (None, Some(id)) => {
                let Some(id) = id.as_i64() else { return };
                let tx = session.conn.pending.lock().expect("lsp pending").remove(&id);
                if let Some(tx) = tx {
                    let _ = tx.send(match message.get("error") {
                        Some(e) => Err(e.get("message").and_then(Value::as_str).unwrap_or("Language server error.").to_owned()),
                        None => Ok(message.get("result").cloned().unwrap_or(Value::Null)),
                    });
                }
            }
            (Some(method), Some(id)) => self.server_request(session, method, id, message.get("params").unwrap_or(&Value::Null)),
            (Some("textDocument/publishDiagnostics"), None) => {
                if !session.ready.load(Ordering::Acquire) || !session.is_active() {
                    return;
                }
                let params = message.get("params").cloned().unwrap_or(Value::Null);
                let uri = params.get("uri").and_then(Value::as_str).unwrap_or_default();
                let Some(rel) = relative_document_path(&session.root, uri) else { return };
                let diagnostics: Vec<Value> =
                    params.get("diagnostics").and_then(Value::as_array).map(|a| a.iter().take(2000).cloned().collect()).unwrap_or_default();
                let state = self.state.lock().expect("lsp state");
                if !session.ready.load(Ordering::Acquire) || !state.is_live_session(session) {
                    return;
                }
                self.sink.diagnostics(json!({
                    "projectPath": session.project_path, "relPath": rel, "uri": uri,
                    "server": session.spec.name, "diagnostics": diagnostics,
                }));
            }
            _ => {}
        }
    }

    fn server_request(&self, session: &Arc<Session>, method: &str, id: &Value, params: &Value) {
        let conn = &session.conn;
        match method {
            "workspace/configuration" => {
                let items = params.get("items").and_then(Value::as_array).map_or(0, Vec::len);
                conn.respond(id, Value::Array(vec![Value::Null; items]));
            }
            "workspace/workspaceFolders" => conn.respond(
                id,
                json!([{ "uri": file_uri(&session.root), "name": session.root.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default() }]),
            ),
            "client/registerCapability" => {
                let mut changed = false;
                if let Some(rows) = params.get("registrations").and_then(Value::as_array) {
                    for row in rows.iter().take(256) {
                        let rid = row.get("id").and_then(Value::as_str).unwrap_or_default();
                        let rmethod = row.get("method").and_then(Value::as_str).unwrap_or_default();
                        if rid.is_empty() || rid.len() > 256 || !lspcaps::is_dynamic_method(rmethod) {
                            continue;
                        }
                        let options = row.get("registerOptions").filter(|v| v.is_object()).cloned().unwrap_or_else(|| json!({}));
                        session.registrations.lock().expect("lsp registrations").insert(rid.to_owned(), (rmethod.to_owned(), options));
                        changed = true;
                    }
                }
                conn.respond(id, Value::Null);
                if changed && session.ready.load(Ordering::Acquire) && !session.closing.load(Ordering::Acquire) {
                    self.refresh_capabilities(session);
                }
            }
            "client/unregisterCapability" => {
                let rows = params.get("unregisterations").or_else(|| params.get("unregistrations")).and_then(Value::as_array);
                let mut changed = false;
                for row in rows.into_iter().flatten().take(256) {
                    if let Some(rid) = row.get("id").and_then(Value::as_str) {
                        changed |= session.registrations.lock().expect("lsp registrations").remove(rid).is_some();
                    }
                }
                conn.respond(id, Value::Null);
                if changed && session.ready.load(Ordering::Acquire) && !session.closing.load(Ordering::Acquire) {
                    self.refresh_capabilities(session);
                }
            }
            "workspace/applyEdit" => {
                conn.respond(id, json!({ "applied": false, "failureReason": "Server-initiated edits require an explicit editor action." }))
            }
            _ => conn.respond(id, Value::Null),
        }
    }

    fn release_root_open_locked(self: &Arc<Self>, state: &mut ManagerState, comparable_root: &Path) {
        state.release_root_open(comparable_root);
        if state.pending_opens_by_root.get(comparable_root).copied().unwrap_or(0) > 0 {
            return;
        }
        let idle_candidates: Vec<Arc<Session>> =
            state.sessions.values().filter(|s| s.comparable_root == comparable_root && s.idle_task.lock().expect("lsp idle").is_none()).cloned().collect();
        for session in idle_candidates {
            self.schedule_idle_locked(state, &session);
        }
    }

    fn schedule_idle_locked(self: &Arc<Self>, state: &mut ManagerState, session: &Arc<Session>) {
        if !session.documents.lock().expect("lsp documents").is_empty() || state.has_active_open(session) || !state.is_live_session(session) {
            return;
        }
        let generation = session.idle_generation.fetch_add(1, Ordering::SeqCst) + 1;
        let (this, spawned_session) = (self.clone(), session.clone());
        let handle = mixdog_rt::spawn("lsp-idle", mixdog_rt::TaskClass::Work, async move {
            mixdog_rt::time::sleep(IDLE).await;
            this.stop_inner(&spawned_session, Some(generation)).await;
        });
        if let Some((_, prev)) = session.idle_task.lock().expect("lsp idle").replace((generation, handle)) {
            prev.abort();
        }
    }

    #[cfg(test)]
    fn schedule_idle(self: &Arc<Self>, session: &Arc<Session>) {
        let mut state = self.state.lock().expect("lsp state");
        self.schedule_idle_locked(&mut state, session);
    }

    fn begin_stop_locked(
        &self,
        state: &mut ManagerState,
        session: &Arc<Session>,
        graceful: bool,
        emit_stopped: bool,
        idle_gen: Option<u64>,
    ) -> Option<tokio::sync::watch::Receiver<()>> {
        if session.closing.swap(true, Ordering::SeqCst) {
            return state.stopping.get(&session.id).map(|s| s.done.clone());
        }
        session.cancel.cancel();
        session.idle_generation.fetch_add(1, Ordering::SeqCst);
        if let Some((task_gen, task)) = session.idle_task.lock().expect("lsp idle").take()
            && idle_gen != Some(task_gen)
        {
            task.abort();
        }
        if state.sessions.get(&session.key).is_some_and(|live| Arc::ptr_eq(live, session)) {
            state.sessions.remove(&session.key);
        }
        let (done_tx, done_rx) = tokio::sync::watch::channel(());
        state.stopping.insert(session.id, Stopping { key: session.key.clone(), root: session.root.clone(), done: done_rx.clone() });
        if emit_stopped {
            self.clear_session_documents(session);
            let languages: Vec<String> = session.language_ids.lock().expect("lsp languages").iter().cloned().collect();
            for language in languages {
                self.emit_status_locked(state, (&session.project_path, &session.root, &language), Some(&session.spec), "stopped", None, None, None);
            }
        }
        spawn_stop_task(self.pm.clone(), self.state.clone(), session.clone(), graceful, done_tx);
        Some(done_rx)
    }

    async fn stop_inner(&self, session: &Arc<Session>, idle_gen: Option<u64>) {
        let done = {
            let mut state = self.state.lock().expect("lsp state");
            if let Some(generation) = idle_gen {
                let skip = session.idle_generation.load(Ordering::SeqCst) != generation
                    || state.is_disposing(&session.root)
                    || state.has_active_open(session)
                    || !session.documents.lock().expect("lsp documents").is_empty()
                    || !state.sessions.get(&session.key).is_some_and(|live| Arc::ptr_eq(live, session));
                if skip {
                    let mut idle = session.idle_task.lock().expect("lsp idle");
                    if idle.as_ref().is_some_and(|(g, _)| *g == generation) {
                        idle.take();
                    }
                    return;
                }
            }
            self.begin_stop_locked(&mut state, session, true, true, idle_gen)
        };
        wait_optional_closed(done).await;
    }

    fn close_document(self: &Arc<Self>, project_path: &str, root: &Path, spec: &Spec, input: &DocumentInput, uri: &str, call: &mut CallGuard<'_>) -> Value {
        let key = session_key(root, spec);
        let mut state = self.state.lock().expect("lsp state");
        call.finish_locked(&mut state);
        if call.call.is_cancelled() || state.is_disposing(root) {
            return public_state(Some(spec), "stopped", None, None);
        }
        let Some(session) = state.sessions.get(&key).cloned() else {
            let fallback = public_state(Some(spec), "stopped", None, None);
            return state.states.get(&key).cloned().unwrap_or(fallback);
        };
        if !session.is_active() {
            return public_state(Some(spec), "stopped", None, None);
        }
        session.language_ids.lock().expect("lsp languages").insert(input.language_id.clone());
        let owner = input.attachment_id.as_deref().unwrap_or(DEFAULT_ATTACHMENT_ID);
        let closed = {
            let mut docs = session.documents.lock().expect("lsp documents");
            let should_remove = docs.get_mut(uri).is_some_and(|doc| doc.owners.remove(owner) && doc.owners.is_empty());
            if should_remove { docs.remove(uri) } else { None }
        };
        if let Some(doc) = closed {
            session.conn.notify("textDocument/didClose", json!({ "textDocument": { "uri": uri } }));
            self.clear_document_feeds(project_path, spec, uri, &doc.language_id, &input.rel_path);
        }
        self.schedule_idle_locked(&mut state, &session);
        let caps = session.capabilities(&input.language_id, Some(uri));
        public_state(Some(spec), "ready", None, Some(&caps))
    }

    /// Editor document events (`lsp/document`). An entry the project refuses fails the call and leaves the language's status alone.
    pub async fn document(self: &Arc<Self>, project_path: &str, root: &Path, input: DocumentInput) -> WsResult<Value> {
        let mut call = self.begin_call(root);
        if call.call.is_cancelled() {
            return Ok(public_state(None, "stopped", None, None));
        }
        let mut root_open = (input.kind != "close").then(|| self.begin_root_open(root));
        let spec = match self.spec_for(root, &input.language_id, &call.call.cancel).await {
            Ok(Some(spec)) => spec,
            Ok(None) => return Ok(public_state(None, "unsupported", None, None)),
            Err(_) if call.call.is_cancelled() => return Ok(public_state(None, "stopped", None, None)),
            Err(error) => {
                let mut state = self.state.lock().expect("lsp state");
                if call.call.is_cancelled() || state.is_disposing(root) {
                    return Ok(public_state(None, "stopped", None, None));
                }
                return Ok(self.emit_status_locked(&mut state, (project_path, root, &input.language_id), None, "error", Some(&error.message), None, None));
            }
        };
        if call.call.is_cancelled() {
            return Ok(public_state(Some(&spec), "stopped", None, None));
        }
        let uri = file_uri(&project_entry_path(root, &input.rel_path)?);
        let key = session_key(root, &spec);
        // A late cleanup must never start a server merely to close a document.
        if input.kind == "close" {
            return Ok(self.close_document(project_path, root, &spec, &input, &uri, &mut call));
        }
        let (session, mut open_guard) = match self.ensure(project_path, root, &input.language_id, &spec, &call.call, true).await {
            EnsureOutcome::Live(session, guard) => (session, guard),
            EnsureOutcome::Cancelled => return Ok(public_state(Some(&spec), "stopped", None, None)),
            EnsureOutcome::Unavailable => {
                let state = self.state.lock().expect("lsp state");
                if call.call.is_cancelled() || state.is_disposing(root) {
                    return Ok(public_state(Some(&spec), "stopped", None, None));
                }
                let fallback = public_state(Some(&spec), "missing", None, None);
                return Ok(state.states.get(&key).cloned().unwrap_or(fallback));
            }
        };
        #[cfg(test)]
        wait_test_gate(&self.document_post_ensure_gate).await;
        let mut state = self.state.lock().expect("lsp state");
        call.finish_locked(&mut state);
        if call.call.is_cancelled() || !state.is_live_session(&session) {
            if let Some(guard) = open_guard.as_mut() {
                guard.release_locked(&mut state);
            }
            if let Some(guard) = root_open.as_mut() {
                guard.release_locked(&mut state);
            }
            return Ok(public_state(Some(&spec), "stopped", None, None));
        }
        session.cancel_idle();
        session.language_ids.lock().expect("lsp languages").insert(input.language_id.clone());
        sync_document(&session, &input, &uri);
        if let Some(guard) = open_guard.as_mut() {
            guard.release_locked(&mut state);
        }
        if let Some(guard) = root_open.as_mut() {
            guard.release_locked(&mut state);
        }
        let caps = session.capabilities(&input.language_id, Some(&uri));
        Ok(public_state(Some(&spec), "ready", None, Some(&caps)))
    }

    /// A language-server request (`lsp/request`). An entry the project refuses fails the call; the idle stop is re-armed all the same.
    pub async fn request(
        self: &Arc<Self>,
        project_path: &str,
        root: &Path,
        rel_path: &str,
        language_id: &str,
        method: &str,
        params: &Value,
    ) -> WsResult<Value> {
        let mut call = self.begin_call(root);
        if call.call.is_cancelled() {
            return Ok(json!({ "available": false, "status": "stopped", "server": "" }));
        }
        let spec = match self.spec_for(root, language_id, &call.call.cancel).await {
            Ok(Some(spec)) => spec,
            Ok(None) => return Ok(json!({ "available": false, "status": "unsupported", "server": "" })),
            Err(_) if call.call.is_cancelled() => return Ok(json!({ "available": false, "status": "stopped", "server": "" })),
            Err(error) => return Ok(json!({ "available": false, "status": "error", "server": "", "detail": error.message })),
        };
        let stopped_reply = || json!({ "available": false, "status": "stopped", "server": spec.name });
        if call.call.is_cancelled() {
            return Ok(stopped_reply());
        }
        let key = session_key(root, &spec);
        let session = match self.ensure(project_path, root, language_id, &spec, &call.call, false).await {
            EnsureOutcome::Live(session, _) => session,
            EnsureOutcome::Cancelled => return Ok(stopped_reply()),
            EnsureOutcome::Unavailable => {
                let state = self.state.lock().expect("lsp state");
                if call.call.is_cancelled() || state.is_disposing(root) {
                    return Ok(stopped_reply());
                }
                let cached = state.states.get(&key).cloned().unwrap_or_else(|| public_state(Some(&spec), "missing", None, None));
                let mut out = json!({ "available": false, "status": cached["status"], "server": cached["server"] });
                if let Some(detail) = cached.get("detail") {
                    out["detail"] = detail.clone();
                }
                return Ok(out);
            }
        };
        if !session.is_active() || call.call.is_cancelled() {
            return Ok(stopped_reply());
        }
        let mut reply = async {
            let uri = file_uri(&project_entry_path(root, rel_path)?);
            if !session.is_active() || call.call.is_cancelled() {
                return Ok(stopped_reply());
            }
            let caps = session.capabilities(language_id, Some(&uri));
            if !lspcaps::method_supported(method, &caps) {
                return Ok(public_state(Some(&spec), "ready", Some(&format!("{} does not support {method}.", spec.name)), Some(&caps)));
            }
            let mut wire = params.as_object().cloned().unwrap_or_default();
            if method.starts_with("textDocument/") {
                wire.insert("textDocument".into(), json!({ "uri": uri }));
            }
            let timeout = format!("{} request timed out.", spec.name);
            let response = tokio::select! {
                biased;
                _ = call.call.cancel.cancelled() => return Ok(stopped_reply()),
                _ = session.cancel.cancelled() => return Ok(stopped_reply()),
                result = session.conn.request(method, Value::Object(wire), REQUEST_TIMEOUT, &timeout) => result,
            };
            Ok::<_, WsError>(match response {
                Ok(result) => json!({ "available": true, "status": "ready", "server": spec.name, "capabilities": caps, "result": result }),
                Err(detail) => json!({ "available": true, "status": "error", "server": spec.name, "capabilities": caps, "detail": detail }),
            })
        }
        .await;
        #[cfg(test)]
        wait_test_gate(&self.request_finalize_gate).await;
        {
            let mut state = self.state.lock().expect("lsp state");
            call.finish_locked(&mut state);
            self.schedule_idle_locked(&mut state, &session);
            if reply.is_ok() && (call.call.is_cancelled() || !state.is_live_session(&session)) {
                reply = Ok(stopped_reply());
            }
        }
        reply
    }

    fn begin_dispose(&self, root: Option<&Path>) -> (DisposeGuard<'_>, Vec<String>) {
        let mut state = self.state.lock().expect("lsp state");
        let id = match root {
            Some(root) => {
                let id = self.next_handle.fetch_add(1, Ordering::SeqCst);
                state.disposing_roots.insert(id, root.to_path_buf());
                Some(id)
            }
            None => {
                state.disposing_all += 1;
                None
            }
        };
        for call in state.calls.values() {
            if root.is_none_or(|r| is_within(r, &call.root)) {
                call.cancel.cancel();
            }
        }
        for (key, flight) in &state.starting {
            if root.is_none_or(|r| key_is_under(key, r)) {
                flight.cancel.cancel();
            }
        }
        let doomed: Vec<Arc<Session>> = state.sessions.values().filter(|s| root.is_none_or(|r| is_within(r, &s.root))).cloned().collect();
        let mut stopped_roots = Vec::with_capacity(doomed.len());
        for session in doomed {
            stopped_roots.push(session.root.to_string_lossy().into_owned());
            let _ = self.begin_stop_locked(&mut state, &session, true, true, None);
        }
        (DisposeGuard { manager: self, id }, stopped_roots)
    }

    async fn drain_disposal(&self, root: Option<&Path>) -> Vec<String> {
        let (_dispose, mut stopped_roots) = self.begin_dispose(root);
        loop {
            let (in_flight, active_stops) = {
                let mut state = self.state.lock().expect("lsp state");
                let in_flight: Vec<Arc<Starting>> =
                    state.starting.iter().filter(|(k, _)| root.is_none_or(|r| key_is_under(k, r))).map(|(_, f)| f.clone()).collect();
                let doomed: Vec<Arc<Session>> = state.sessions.values().filter(|s| root.is_none_or(|r| is_within(r, &s.root))).cloned().collect();
                for session in doomed {
                    stopped_roots.push(session.root.to_string_lossy().into_owned());
                    let _ = self.begin_stop_locked(&mut state, &session, true, true, None);
                }
                let active_stops: Vec<tokio::sync::watch::Receiver<()>> =
                    state.stopping.values().filter(|s| root.is_none_or(|r| is_within(r, &s.root))).map(|s| s.done.clone()).collect();
                (in_flight, active_stops)
            };
            if in_flight.is_empty() && active_stops.is_empty() {
                break;
            }
            for flight in in_flight {
                wait_closed(flight.done.clone()).await;
            }
            for done in active_stops {
                wait_closed(done).await;
            }
        }
        {
            let mut state = self.state.lock().expect("lsp state");
            match root {
                Some(root) => {
                    state.states.retain(|key, _| !key_is_under(key, root));
                    state.health.missing_until.retain(|key, _| !key_is_under(key, root));
                    state.health.failures.retain(|key, _| !key_is_under(key, root));
                }
                None => {
                    state.sessions.clear();
                    state.states.clear();
                    state.health.missing_until.clear();
                    state.health.failures.clear();
                }
            }
        }
        stopped_roots
    }

    /// Stops the servers rooted in `root` (a worktree or project being removed); returns their roots.
    pub async fn dispose_under(&self, root: &Path) -> Vec<String> {
        self.drain_disposal(Some(root)).await
    }

    pub async fn dispose(&self) {
        let _ = self.drain_disposal(None).await;
    }

    /// Test seam: the live roots.
    pub fn live_roots(&self) -> Vec<PathBuf> {
        self.state.lock().expect("lsp state").sessions.values().map(|s| s.root.clone()).collect()
    }
}

#[cfg(test)]
mod tests {
    use async_trait::async_trait;
    use mixdog_core_api::domain::common::EventSource;
    use mixdog_core_api::domain::process::ExitStatus;
    use mixdog_core_api::domain::process::KillReason;
    use mixdog_core_api::domain::process::ProcessError;
    use mixdog_core_api::domain::process::ProcessExit;
    use mixdog_core_api::domain::process::ProcessInfo;
    use mixdog_core_api::domain::process::PtySize;
    use mixdog_core_api::domain::process::SpawnedProcess;

    use super::*;

    struct Source(mpsc::UnboundedReceiver<ProcessEvent>);

    #[async_trait]
    impl EventSource<ProcessEvent> for Source {
        async fn next(&mut self) -> Option<ProcessEvent> {
            self.0.recv().await
        }
    }

    #[derive(Default)]
    struct ScriptedPm {
        events: Mutex<HashMap<String, mpsc::UnboundedSender<ProcessEvent>>>,
        receivers: Mutex<HashMap<String, mpsc::UnboundedReceiver<ProcessEvent>>>,
        framers: Mutex<HashMap<String, Framer>>,
        seq: AtomicU64,
        spawn_count: AtomicU64,
        spawned_handles: Mutex<Vec<String>>,
        hold_spawn: AtomicBool,
        spawn_arrived: Arc<tokio::sync::Notify>,
        spawn_release: Arc<tokio::sync::Notify>,
        spawn_dropped: Arc<AtomicBool>,
        hold_inflight_spawn: AtomicBool,
        inflight_spawn_arrived: Arc<tokio::sync::Notify>,
        inflight_spawn_release: Arc<tokio::sync::Notify>,
        hold_initialize: AtomicBool,
        init_arrived: Arc<tokio::sync::Notify>,
        held_inits: Mutex<Vec<(String, Value)>>,
        hold_request: AtomicBool,
        request_arrived: Arc<tokio::sync::Notify>,
        held_requests: Mutex<Vec<(String, Value)>>,
        hold_shutdown: AtomicBool,
        shutdown_arrived: Arc<tokio::sync::Notify>,
        held_shutdowns: Mutex<Vec<(String, Value)>>,
        hold_exit: AtomicBool,
        kill_arrived: Arc<tokio::sync::Notify>,
        killed: Mutex<Vec<String>>,
        notifications: Mutex<Vec<(String, String)>>,
        notification_messages: Mutex<Vec<Value>>,
    }

    impl ScriptedPm {
        fn say(&self, handle: &str, message: &Value) {
            let seq = self.seq.fetch_add(1, Ordering::SeqCst);
            if let Some(tx) = self.events.lock().unwrap().get(handle) {
                let _ = tx.send(ProcessEvent::Output { seq, stream: OutputStream::Stdout, bytes: frame(message) });
            }
        }

        fn emit_exit(&self, handle: &str) {
            let seq = self.seq.fetch_add(1, Ordering::SeqCst);
            if let Some(tx) = self.events.lock().unwrap().remove(handle) {
                let _ = tx.send(ProcessEvent::Exited { seq, exit: ProcessExit { status: ExitStatus::Signal(9), killed: Some(KillReason::Requested) } });
            }
        }
    }

    #[async_trait]
    impl ProcessManager for ScriptedPm {
        async fn spawn(&self, request: SpawnRequest) -> Result<SpawnedProcess, ProcessError> {
            if self.hold_spawn.load(Ordering::SeqCst) {
                struct DropFlag(Arc<AtomicBool>);
                impl Drop for DropFlag {
                    fn drop(&mut self) {
                        self.0.store(true, Ordering::SeqCst);
                    }
                }
                let _drop_flag = DropFlag(self.spawn_dropped.clone());
                let release = self.spawn_release.notified();
                self.spawn_arrived.notify_waiters();
                release.await;
            }
            self.spawn_count.fetch_add(1, Ordering::SeqCst);
            self.spawned_handles.lock().unwrap().push(request.handle.as_str().to_owned());
            let (tx, rx) = mpsc::unbounded_channel();
            self.events.lock().unwrap().insert(request.handle.as_str().to_owned(), tx);
            self.receivers.lock().unwrap().insert(request.handle.as_str().to_owned(), rx);
            Ok(SpawnedProcess { handle: request.handle, pid: 1001 })
        }

        async fn spawn_subscribed_cancellable(
            &self,
            request: SpawnRequest,
            cancel: tokio_util::sync::CancellationToken,
        ) -> Result<(SpawnedProcess, Box<dyn EventSource<ProcessEvent>>), ProcessError> {
            if cancel.is_cancelled() {
                return Err(ProcessError::Revoked);
            }
            if self.hold_spawn.load(Ordering::SeqCst) {
                struct DropFlag(Arc<AtomicBool>);
                impl Drop for DropFlag {
                    fn drop(&mut self) {
                        self.0.store(true, Ordering::SeqCst);
                    }
                }
                let drop_flag = DropFlag(self.spawn_dropped.clone());
                let release = self.spawn_release.notified();
                self.spawn_arrived.notify_waiters();
                let cancelled = tokio::select! {
                    biased;
                    _ = cancel.cancelled() => true,
                    _ = release => false,
                };
                if cancelled {
                    drop(drop_flag);
                    return Err(ProcessError::Revoked);
                }
                std::mem::forget(drop_flag);
            }
            if self.hold_inflight_spawn.load(Ordering::SeqCst) {
                let release = self.inflight_spawn_release.notified();
                self.inflight_spawn_arrived.notify_waiters();
                release.await;
            }
            self.spawn_count.fetch_add(1, Ordering::SeqCst);
            self.spawned_handles.lock().unwrap().push(request.handle.as_str().to_owned());
            let (tx, rx) = mpsc::unbounded_channel();
            self.events.lock().unwrap().insert(request.handle.as_str().to_owned(), tx);
            let mut events: Box<dyn EventSource<ProcessEvent>> = Box::new(Source(rx));
            let spawned = SpawnedProcess { handle: request.handle, pid: 1001 };
            if cancel.is_cancelled() {
                let _ = self.kill(&spawned.handle);
                while let Some(event) = events.next().await {
                    if matches!(event, ProcessEvent::Exited { .. }) {
                        break;
                    }
                }
                return Err(ProcessError::Revoked);
            }
            Ok((spawned, events))
        }

        fn subscribe_holding(&self, handle: &ProcessHandle, from_seq: Option<u64>) -> Result<Box<dyn EventSource<ProcessEvent>>, ProcessError> {
            self.subscribe(handle, from_seq)
        }

        fn subscribe(&self, handle: &ProcessHandle, _from_seq: Option<u64>) -> Result<Box<dyn EventSource<ProcessEvent>>, ProcessError> {
            Ok(Box::new(Source(self.receivers.lock().unwrap().remove(handle.as_str()).expect("receiver"))))
        }

        async fn write_stdin(&self, handle: &ProcessHandle, bytes: Vec<u8>) -> Result<(), ProcessError> {
            let messages = self.framers.lock().unwrap().entry(handle.as_str().to_owned()).or_default().push(&bytes);
            for message in messages {
                if let Some(method) = message["method"].as_str()
                    && message.get("id").is_none()
                {
                    let uri = message["params"]["textDocument"]["uri"].as_str().unwrap_or_default().to_owned();
                    self.notifications.lock().unwrap().push((method.to_owned(), uri));
                    self.notification_messages.lock().unwrap().push(message.clone());
                }
                if let (Some(method), Some(id)) = (message["method"].as_str(), message.get("id")) {
                    if method == "initialize" && self.hold_initialize.load(Ordering::SeqCst) {
                        self.held_inits.lock().unwrap().push((handle.as_str().to_owned(), id.clone()));
                        self.init_arrived.notify_waiters();
                        continue;
                    }
                    if method == "shutdown" && self.hold_shutdown.load(Ordering::SeqCst) {
                        self.held_shutdowns.lock().unwrap().push((handle.as_str().to_owned(), id.clone()));
                        self.shutdown_arrived.notify_waiters();
                        continue;
                    }
                    if method != "initialize" && method != "shutdown" && self.hold_request.load(Ordering::SeqCst) {
                        self.held_requests.lock().unwrap().push((handle.as_str().to_owned(), id.clone()));
                        self.request_arrived.notify_waiters();
                        continue;
                    }
                    let result = match method {
                        "initialize" => json!({ "capabilities": { "hoverProvider": true } }),
                        _ => Value::Null,
                    };
                    self.say(handle.as_str(), &json!({ "jsonrpc": "2.0", "id": id, "result": result }));
                }
            }
            Ok(())
        }

        fn close_stdin(&self, _handle: &ProcessHandle) -> Result<(), ProcessError> {
            Ok(())
        }

        fn resize_pty(&self, _handle: &ProcessHandle, _size: PtySize) -> Result<(), ProcessError> {
            Err(ProcessError::NotPty)
        }

        fn kill(&self, handle: &ProcessHandle) -> Result<(), ProcessError> {
            self.killed.lock().unwrap().push(handle.as_str().to_owned());
            self.kill_arrived.notify_waiters();
            if !self.hold_exit.load(Ordering::SeqCst) {
                self.emit_exit(handle.as_str());
            }
            Ok(())
        }

        fn list(&self) -> Vec<ProcessInfo> {
            Vec::new()
        }
    }

    #[derive(Default)]
    struct Sink {
        statuses: Mutex<Vec<Value>>,
        diagnostics: Mutex<Vec<Value>>,
        cleared: Mutex<Vec<(String, String, String, String)>>,
        timeline: Mutex<Vec<String>>,
    }

    impl LspSink for Sink {
        fn status(&self, event: Value) {
            if let Some(rel) = event.get("relPath").and_then(Value::as_str) {
                self.timeline.lock().unwrap().push(format!("status:{rel}"));
            } else {
                self.timeline.lock().unwrap().push(format!("status:{}", event["status"].as_str().unwrap_or_default()));
            }
            self.statuses.lock().unwrap().push(event);
        }
        fn diagnostics(&self, event: Value) {
            self.diagnostics.lock().unwrap().push(event);
        }
        fn clear_document(&self, project_path: &str, server: &str, language_id: &str, rel_path: &str, uri: &str) {
            self.timeline.lock().unwrap().push(format!("clear:{rel_path}"));
            self.cleared.lock().unwrap().push((project_path.to_owned(), language_id.to_owned(), rel_path.to_owned(), uri.to_owned()));
            self.diagnostics(json!({
                "projectPath": project_path, "relPath": rel_path, "uri": uri,
                "server": server, "diagnostics": [],
            }));
        }
    }

    fn write_project(command: &str) -> (tempfile::TempDir, PathBuf) {
        let dir = tempfile::tempdir().unwrap();
        let root = crate::pathguard::canonical(dir.path()).unwrap();
        std::fs::create_dir_all(root.join(".mixdog")).unwrap();
        let cfg = json!({ "servers": { "scripted": { "command": command, "languages": ["scriptlang"], "name": "Scripted" } } });
        std::fs::write(root.join(".mixdog").join("lsp.json"), cfg.to_string()).unwrap();
        (dir, root)
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn dispose_under_prunes_states_and_health_and_stop_clears_open_document_feeds() {
        let pm = Arc::new(ScriptedPm::default());
        let sink = Arc::new(Sink::default());
        let lsp = LspManager::new(pm.clone(), sink.clone(), mixdog_rt::testing::tokens().maintenance_io);

        let bin_dir = tempfile::tempdir().unwrap();
        let program = bin_dir.path().join("fake-lsp.bin");
        std::fs::write(&program, b"").unwrap();

        let (_dir_missing, root_missing) = write_project("mixdog-nonexistent-lsp-bin");
        let (_dir_live, root_live) = write_project(&program.to_string_lossy());
        let (_dir_keep, root_keep) = write_project(&program.to_string_lossy());

        let missing_p = root_missing.to_string_lossy().into_owned();
        let live_p = root_live.to_string_lossy().into_owned();
        let keep_p = root_keep.to_string_lossy().into_owned();

        let open_doc = |rel: &str| DocumentInput {
            kind: "open".into(),
            language_id: "scriptlang".into(),
            rel_path: rel.into(),
            content: "x".into(),
            version: 1,
            attachment_id: None,
        };
        let close_doc = |rel: &str| DocumentInput {
            kind: "close".into(),
            language_id: "scriptlang".into(),
            rel_path: rel.into(),
            content: String::new(),
            version: 1,
            attachment_id: None,
        };

        // Missing server populates states + health.missing_until.
        let _ = lsp.document(&missing_p, &root_missing, open_doc("a.script")).await.unwrap();
        assert!(!lsp.state.lock().unwrap().health.missing_until.is_empty());

        // Live servers populate sessions + states.
        let _ = lsp.document(&live_p, &root_live, open_doc("closed.script")).await.unwrap();
        let _ = lsp.document(&live_p, &root_live, open_doc("open.script")).await.unwrap();
        let _ = lsp.document(&keep_p, &root_keep, open_doc("keep.script")).await.unwrap();

        // Closing one document clears its feeds directly without broadcasting a fake "stopped" status.
        sink.statuses.lock().unwrap().clear();
        let _ = lsp.document(&live_p, &root_live, close_doc("closed.script")).await.unwrap();
        assert!(sink.diagnostics.lock().unwrap().iter().any(|e| e["relPath"] == "closed.script" && e["diagnostics"] == json!([])));
        assert!(sink.cleared.lock().unwrap().iter().any(|(p, l, r, _)| p == &live_p && l == "scriptlang" && r == "closed.script"));
        assert!(!sink.statuses.lock().unwrap().iter().any(|e| e["status"] == "stopped"), "closing a document must not emit stopped status");

        // dispose_under stops live sessions, clears remaining open docs' feeds, and prunes states + health.
        sink.diagnostics.lock().unwrap().clear();
        sink.statuses.lock().unwrap().clear();
        sink.cleared.lock().unwrap().clear();
        lsp.dispose_under(&root_missing).await;
        lsp.dispose_under(&root_live).await;

        assert!(sink.diagnostics.lock().unwrap().iter().any(|e| e["relPath"] == "open.script" && e["diagnostics"] == json!([])));
        assert!(sink.cleared.lock().unwrap().iter().any(|(p, l, r, _)| p == &live_p && l == "scriptlang" && r == "open.script"));
        assert!(sink.statuses.lock().unwrap().iter().any(|e| e["status"] == "stopped" && e.get("relPath").is_none()));
        assert!(!sink.statuses.lock().unwrap().iter().any(|e| e["status"] == "stopped" && e.get("relPath").is_some()));
        assert!(lsp.state.lock().unwrap().health.missing_until.is_empty(), "missing_until pruned");
        assert!(lsp.state.lock().unwrap().health.failures.is_empty(), "failures pruned");
        assert_eq!(lsp.state.lock().unwrap().states.len(), 1, "only unrelated project state remains");
        assert_eq!(lsp.live_roots(), vec![root_keep]);

        lsp.dispose().await;
        assert!(lsp.state.lock().unwrap().states.is_empty());
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn dispose_under_cancels_initializing_server_without_inserting_or_publishing() {
        let pm = Arc::new(ScriptedPm::default());
        pm.hold_initialize.store(true, Ordering::SeqCst);
        let sink = Arc::new(Sink::default());
        let lsp = LspManager::new(pm.clone(), sink.clone(), mixdog_rt::testing::tokens().maintenance_io);

        let bin_dir = tempfile::tempdir().unwrap();
        let program = bin_dir.path().join("fake-lsp.bin");
        std::fs::write(&program, b"").unwrap();
        let (_dir, root) = write_project(&program.to_string_lossy());
        let project = root.to_string_lossy().into_owned();

        let open_doc = |rel: &str| DocumentInput {
            kind: "open".into(),
            language_id: "scriptlang".into(),
            rel_path: rel.into(),
            content: "x".into(),
            version: 1,
            attachment_id: None,
        };

        let init_arrived = pm.init_arrived.notified();
        let first = tokio::spawn({
            let (lsp, project, root) = (lsp.clone(), project.clone(), root.clone());
            async move { lsp.document(&project, &root, open_doc("a.script")).await.unwrap() }
        });
        init_arrived.await;

        assert!(lsp.state.lock().unwrap().sessions.is_empty(), "server must still be initializing, not in sessions");
        let flight = {
            let state = lsp.state.lock().unwrap();
            assert_eq!(state.starting.len(), 1, "in-flight start must be tracked in starting");
            state.starting.values().next().unwrap().clone()
        };

        let waiter = tokio::spawn({
            let (lsp, project, root) = (lsp.clone(), project.clone(), root.clone());
            async move { lsp.document(&project, &root, open_doc("b.script")).await.unwrap() }
        });
        flight.waiter_joined.notified().await;

        lsp.dispose_under(&root).await;
        sink.statuses.lock().unwrap().clear();
        sink.diagnostics.lock().unwrap().clear();

        let held = std::mem::take(&mut *pm.held_inits.lock().unwrap());
        assert_eq!(held.len(), 1, "exactly one initialize request should have been sent");
        let (handle, id) = &held[0];
        pm.say(handle, &json!({ "jsonrpc": "2.0", "id": id, "result": { "capabilities": { "hoverProvider": true } } }));

        let first_state = first.await.unwrap();
        let waiter_state = waiter.await.unwrap();
        assert_eq!(first_state["status"], "stopped");
        assert_eq!(waiter_state["status"], "stopped");

        assert!(pm.killed.lock().unwrap().contains(handle), "cancelled initializing server must be killed");
        assert!(lsp.state.lock().unwrap().sessions.is_empty(), "cancelled server must never be inserted into sessions");
        assert!(lsp.state.lock().unwrap().starting.is_empty(), "starting entry must be removed");
        assert!(lsp.state.lock().unwrap().states.is_empty(), "removed project must not retain states");
        assert!(lsp.state.lock().unwrap().health.failures.is_empty(), "cancelled start must not record failure backoff");
        assert!(lsp.state.lock().unwrap().health.missing_until.is_empty());
        assert!(sink.statuses.lock().unwrap().is_empty(), "no status may be published after project release");
        assert!(sink.diagnostics.lock().unwrap().is_empty(), "no diagnostics may be published after project release");
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn request_arriving_during_dispose_under_shutdown_does_not_spawn_or_insert() {
        let pm = Arc::new(ScriptedPm::default());
        let sink = Arc::new(Sink::default());
        let lsp = LspManager::new(pm.clone(), sink.clone(), mixdog_rt::testing::tokens().maintenance_io);

        let bin_dir = tempfile::tempdir().unwrap();
        let program = bin_dir.path().join("fake-lsp.bin");
        std::fs::write(&program, b"").unwrap();
        let (_dir, root) = write_project(&program.to_string_lossy());
        let project = root.to_string_lossy().into_owned();

        let open_doc = |rel: &str| DocumentInput {
            kind: "open".into(),
            language_id: "scriptlang".into(),
            rel_path: rel.into(),
            content: "x".into(),
            version: 1,
            attachment_id: None,
        };
        let initial = lsp.document(&project, &root, open_doc("a.script")).await.unwrap();
        assert_eq!(initial["status"], "ready");
        assert_eq!(pm.spawn_count.load(Ordering::SeqCst), 1);

        pm.hold_shutdown.store(true, Ordering::SeqCst);
        let shutdown_arrived = pm.shutdown_arrived.notified();
        let dispose = tokio::spawn({
            let (lsp, root) = (lsp.clone(), root.clone());
            async move { lsp.dispose_under(&root).await }
        });
        shutdown_arrived.await;

        let doc_during = lsp.document(&project, &root, open_doc("b.script")).await.unwrap();
        let req_during = lsp.request(&project, &root, "b.script", "scriptlang", "textDocument/hover", &json!({})).await.unwrap();
        assert_eq!(doc_during["status"], "stopped");
        assert_eq!(req_during["available"], false);
        assert_eq!(req_during["status"], "stopped");
        assert_eq!(pm.spawn_count.load(Ordering::SeqCst), 1, "requests during dispose_under must not spawn a server");
        assert!(lsp.state.lock().unwrap().sessions.is_empty(), "requests during dispose_under must not insert a session");

        let held = std::mem::take(&mut *pm.held_shutdowns.lock().unwrap());
        assert_eq!(held.len(), 1);
        pm.say(&held[0].0, &json!({ "jsonrpc": "2.0", "id": &held[0].1, "result": Value::Null }));

        dispose.await.unwrap();
        assert!(lsp.state.lock().unwrap().sessions.is_empty());
        assert!(lsp.state.lock().unwrap().states.is_empty());
        assert!(lsp.state.lock().unwrap().disposing_roots.is_empty());
    }

    #[tokio::test(flavor = "current_thread")]
    async fn idle_timer_after_stopped_and_dispose_under_does_not_recreate_state() {
        let pm = Arc::new(ScriptedPm::default());
        let sink = Arc::new(Sink::default());
        let lsp = LspManager::new(pm.clone(), sink.clone(), mixdog_rt::testing::tokens().maintenance_io);

        let bin_dir = tempfile::tempdir().unwrap();
        let program = bin_dir.path().join("fake-lsp.bin");
        std::fs::write(&program, b"").unwrap();
        let (_dir, root) = write_project(&program.to_string_lossy());
        let project = root.to_string_lossy().into_owned();

        let open_doc = DocumentInput {
            kind: "open".into(),
            language_id: "scriptlang".into(),
            rel_path: "a.script".into(),
            content: "x".into(),
            version: 1,
            attachment_id: None,
        };
        let close_doc = DocumentInput {
            kind: "close".into(),
            language_id: "scriptlang".into(),
            rel_path: "a.script".into(),
            content: String::new(),
            version: 1,
            attachment_id: None,
        };

        let state = lsp.document(&project, &root, open_doc).await.unwrap();
        assert_eq!(state["status"], "ready");

        tokio::time::pause();
        let _ = lsp.document(&project, &root, close_doc).await.unwrap();

        let session = lsp.state.lock().unwrap().sessions.values().next().unwrap().clone();
        assert!(session.idle_task.lock().unwrap().is_some(), "closing last document must arm idle timer");

        pm.kill(&session.handle).unwrap();
        for _ in 0..50 {
            if lsp.state.lock().unwrap().sessions.is_empty() {
                break;
            }
            tokio::task::yield_now().await;
        }
        assert!(lsp.state.lock().unwrap().sessions.is_empty(), "reader exit must remove session");
        assert!(session.idle_task.lock().unwrap().is_none(), "stopped must abort and clear idle timer");

        lsp.dispose_under(&root).await;
        sink.statuses.lock().unwrap().clear();
        sink.diagnostics.lock().unwrap().clear();
        assert!(lsp.state.lock().unwrap().states.is_empty());

        tokio::time::advance(IDLE + Duration::from_secs(1)).await;
        for _ in 0..10 {
            tokio::task::yield_now().await;
        }

        // Late detached reader traffic on a closing session must also be dropped.
        lsp.dispatch(
            &session,
            json!({
                "jsonrpc": "2.0",
                "method": "textDocument/publishDiagnostics",
                "params": { "uri": file_uri(&root.join("a.script")), "diagnostics": [{ "message": "stale" }] }
            }),
        );
        lsp.dispatch(
            &session,
            json!({
                "jsonrpc": "2.0",
                "id": 99,
                "method": "client/registerCapability",
                "params": { "registrations": [{ "id": "r1", "method": "textDocument/definition", "registerOptions": {} }] }
            }),
        );

        assert!(lsp.state.lock().unwrap().states.is_empty(), "idle timer or late reader must not recreate state for disposed project");
        assert!(sink.statuses.lock().unwrap().is_empty(), "idle timer or late reader must not publish status after disposal");
        assert!(sink.diagnostics.lock().unwrap().is_empty(), "late reader must not publish diagnostics after closing");
    }

    #[test]
    fn dispose_under_cancels_blocked_executable_discovery_promptly() {
        use mixdog_rt::Backend;
        let (executors, tokens) = mixdog_rt::exec::boot(mixdog_rt::exec::RtConfig::for_cores(4)).expect("boot");
        let rt = executors.handle(mixdog_rt::TaskClass::Work);
        let (tx, rx) = std::sync::mpsc::channel::<()>();
        let rx = Arc::new(Mutex::new(rx));
        rt.block_on(async {
            let pm = Arc::new(ScriptedPm::default());
            let sink = Arc::new(Sink::default());
            let probe_entered = Arc::new(tokio::sync::Notify::new());
            let entered = probe_entered.clone();
            let lsp = LspManager::with_resolver(
                pm.clone(),
                sink.clone(),
                tokens.maintenance_io,
                Arc::new(move |_, _| {
                    entered.notify_one();
                    let _ = rx.lock().unwrap().recv();
                    None
                }),
            );

            let (_dir, root) = write_project("slow-network-lsp");
            let project = root.to_string_lossy().into_owned();
            let open_doc = DocumentInput {
                kind: "open".into(),
                language_id: "scriptlang".into(),
                rel_path: "a.script".into(),
                content: "x".into(),
                version: 1,
                attachment_id: None,
            };

            let probe_wait = probe_entered.notified();
            let doc_task = tokio::spawn({
                let (lsp, project, root) = (lsp.clone(), project.clone(), root.clone());
                async move { lsp.document(&project, &root, open_doc).await.unwrap() }
            });
            probe_wait.await;

            let disposed = mixdog_rt::time::timeout(Duration::from_secs(2), lsp.dispose_under(&root)).await;
            assert!(disposed.is_ok(), "dispose_under must not wait on blocked executable discovery");
            sink.statuses.lock().unwrap().clear();

            let state = doc_task.await.unwrap();
            assert_eq!(state["status"], "stopped");
            let _ = tx.send(());

            assert_eq!(pm.spawn_count.load(Ordering::SeqCst), 0);
            assert!(lsp.state.lock().unwrap().sessions.is_empty());
            assert!(lsp.state.lock().unwrap().states.is_empty());
            assert!(lsp.state.lock().unwrap().health.missing_until.is_empty());
            assert!(lsp.state.lock().unwrap().starting.is_empty());
            assert!(sink.statuses.lock().unwrap().is_empty());
        });
        let _ = tx.send(());
        drop(executors);
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn concurrent_opens_share_single_session_and_leave_no_orphan_on_dispose() {
        let pm = Arc::new(ScriptedPm::default());
        pm.hold_initialize.store(true, Ordering::SeqCst);
        let sink = Arc::new(Sink::default());
        let lsp = LspManager::new(pm.clone(), sink.clone(), mixdog_rt::testing::tokens().maintenance_io);

        let bin_dir = tempfile::tempdir().unwrap();
        let program = bin_dir.path().join("fake-lsp.bin");
        std::fs::write(&program, b"").unwrap();
        let (_dir, root) = write_project(&program.to_string_lossy());
        let project = root.to_string_lossy().into_owned();

        let open_doc = |rel: &str| DocumentInput {
            kind: "open".into(),
            language_id: "scriptlang".into(),
            rel_path: rel.into(),
            content: "x".into(),
            version: 1,
            attachment_id: None,
        };

        let init_arrived = pm.init_arrived.notified();
        let starter = tokio::spawn({
            let (lsp, project, root) = (lsp.clone(), project.clone(), root.clone());
            async move { lsp.document(&project, &root, open_doc("doc0.script")).await.unwrap() }
        });
        init_arrived.await;

        let flight = lsp.state.lock().unwrap().starting.values().next().unwrap().clone();
        let mut tasks = vec![starter];
        for idx in 1..=3 {
            let joined = flight.waiter_joined.notified();
            let rel = format!("doc{idx}.script");
            tasks.push(tokio::spawn({
                let (lsp, project, root) = (lsp.clone(), project.clone(), root.clone());
                async move { lsp.document(&project, &root, open_doc(&rel)).await.unwrap() }
            }));
            joined.await;
        }

        // Launch another wave racing right against promotion from starting -> sessions.
        let held = std::mem::take(&mut *pm.held_inits.lock().unwrap());
        assert_eq!(held.len(), 1);
        let (handle, id) = held[0].clone();
        pm.hold_initialize.store(false, Ordering::SeqCst);
        for idx in 4..=8 {
            let rel = format!("doc{idx}.script");
            tasks.push(tokio::spawn({
                let (lsp, project, root) = (lsp.clone(), project.clone(), root.clone());
                async move { lsp.document(&project, &root, open_doc(&rel)).await.unwrap() }
            }));
        }
        pm.say(&handle, &json!({ "jsonrpc": "2.0", "id": id, "result": { "capabilities": { "hoverProvider": true } } }));

        for task in tasks {
            let res = task.await.unwrap();
            assert_eq!(res["status"], "ready");
        }
        assert_eq!(pm.spawn_count.load(Ordering::SeqCst), 1, "concurrent opens must spawn exactly one server");
        assert_eq!(pm.spawned_handles.lock().unwrap().len(), 1);
        {
            let state = lsp.state.lock().unwrap();
            assert_eq!(state.sessions.len(), 1);
            assert!(state.starting.is_empty());
            let session = state.sessions.values().next().unwrap();
            assert_eq!(session.documents.lock().unwrap().len(), 9);
        }

        let session = lsp.state.lock().unwrap().sessions.values().next().unwrap().clone();
        lsp.dispose_under(&root).await;
        assert_eq!(*pm.killed.lock().unwrap(), vec![handle]);
        assert!(lsp.live_roots().is_empty());
        assert!(lsp.state.lock().unwrap().sessions.is_empty());

        sink.diagnostics.lock().unwrap().clear();
        lsp.dispatch(
            &session,
            json!({
                "jsonrpc": "2.0",
                "method": "textDocument/publishDiagnostics",
                "params": { "uri": file_uri(&root.join("doc0.script")), "diagnostics": [{ "message": "orphan" }] }
            }),
        );
        assert!(sink.diagnostics.lock().unwrap().is_empty(), "disposed session must never publish diagnostics");
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn dispose_under_cancels_stalled_spawn_promptly() {
        let pm = Arc::new(ScriptedPm::default());
        pm.hold_spawn.store(true, Ordering::SeqCst);
        let sink = Arc::new(Sink::default());
        let lsp = LspManager::new(pm.clone(), sink.clone(), mixdog_rt::testing::tokens().maintenance_io);

        let bin_dir = tempfile::tempdir().unwrap();
        let program = bin_dir.path().join("fake-lsp.bin");
        std::fs::write(&program, b"").unwrap();
        let (_dir, root) = write_project(&program.to_string_lossy());
        let project = root.to_string_lossy().into_owned();

        let open_doc = DocumentInput {
            kind: "open".into(),
            language_id: "scriptlang".into(),
            rel_path: "a.script".into(),
            content: "x".into(),
            version: 1,
            attachment_id: None,
        };
        let spawn_arrived = pm.spawn_arrived.notified();
        let doc_task = tokio::spawn({
            let (lsp, project, root) = (lsp.clone(), project.clone(), root.clone());
            async move { lsp.document(&project, &root, open_doc).await.unwrap() }
        });
        spawn_arrived.await;

        let disposed = mixdog_rt::time::timeout(Duration::from_secs(2), lsp.dispose_under(&root)).await;
        assert!(disposed.is_ok(), "dispose_under must cancel stalled pm.spawn promptly");
        assert!(pm.spawn_dropped.load(Ordering::SeqCst), "stalled pm.spawn future must be dropped on cancellation");

        let state = doc_task.await.unwrap();
        assert_eq!(state["status"], "stopped");
        assert_eq!(state["available"], false);
        assert_eq!(pm.spawn_count.load(Ordering::SeqCst), 0);
        assert!(lsp.state.lock().unwrap().sessions.is_empty());
        assert!(lsp.state.lock().unwrap().starting.is_empty());
        assert!(lsp.state.lock().unwrap().states.is_empty());
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn dispose_under_waits_for_in_flight_idle_shutdown_and_overlapping_disposal() {
        let pm = Arc::new(ScriptedPm::default());
        let sink = Arc::new(Sink::default());
        let lsp = LspManager::new(pm.clone(), sink.clone(), mixdog_rt::testing::tokens().maintenance_io);

        let bin_dir = tempfile::tempdir().unwrap();
        let program = bin_dir.path().join("fake-lsp.bin");
        std::fs::write(&program, b"").unwrap();
        let (_dir, root) = write_project(&program.to_string_lossy());
        let project = root.to_string_lossy().into_owned();

        let open_doc = |rel: &str| DocumentInput {
            kind: "open".into(),
            language_id: "scriptlang".into(),
            rel_path: rel.into(),
            content: "x".into(),
            version: 1,
            attachment_id: None,
        };
        let close_doc = |rel: &str| DocumentInput {
            kind: "close".into(),
            language_id: "scriptlang".into(),
            rel_path: rel.into(),
            content: String::new(),
            version: 1,
            attachment_id: None,
        };

        // Part 1: idle shutdown already in progress when two overlapping dispose_under calls arrive.
        let _ = lsp.document(&project, &root, open_doc("a.script")).await.unwrap();
        let _ = lsp.document(&project, &root, close_doc("a.script")).await.unwrap();
        let session = lsp.state.lock().unwrap().sessions.values().next().unwrap().clone();
        let idle_gen = session.idle_generation.load(Ordering::SeqCst);

        pm.hold_shutdown.store(true, Ordering::SeqCst);
        let shutdown_arrived = pm.shutdown_arrived.notified();
        let idle_stop = tokio::spawn({
            let (lsp, session) = (lsp.clone(), session.clone());
            async move { lsp.stop_inner(&session, Some(idle_gen)).await }
        });
        shutdown_arrived.await;

        assert!(lsp.state.lock().unwrap().sessions.is_empty());
        assert_eq!(lsp.state.lock().unwrap().stopping.len(), 1);

        let dispose1 = tokio::spawn({
            let (lsp, root) = (lsp.clone(), root.clone());
            async move { lsp.dispose_under(&root).await }
        });
        let dispose2 = tokio::spawn({
            let (lsp, root) = (lsp.clone(), root.clone());
            async move { lsp.dispose_under(&root).await }
        });

        mixdog_rt::time::sleep(Duration::from_millis(60)).await;
        assert!(!dispose1.is_finished(), "dispose_under must wait for in-flight idle shutdown");
        assert!(!dispose2.is_finished(), "overlapping dispose_under must wait for in-flight idle shutdown");
        assert!(pm.killed.lock().unwrap().is_empty(), "process must not be killed before shutdown completes");

        let held = std::mem::take(&mut *pm.held_shutdowns.lock().unwrap());
        assert_eq!(held.len(), 1);
        pm.say(&held[0].0, &json!({ "jsonrpc": "2.0", "id": &held[0].1, "result": Value::Null }));

        idle_stop.await.unwrap();
        dispose1.await.unwrap();
        dispose2.await.unwrap();
        assert!(pm.killed.lock().unwrap().contains(&held[0].0), "process must be killed before dispose_under returns");
        assert!(lsp.state.lock().unwrap().stopping.is_empty());

        // Part 2: second dispose_under arrives while first dispose_under is awaiting shutdown.
        pm.hold_shutdown.store(false, Ordering::SeqCst);
        let _ = lsp.document(&project, &root, open_doc("b.script")).await.unwrap();
        pm.hold_shutdown.store(true, Ordering::SeqCst);
        let shutdown_arrived = pm.shutdown_arrived.notified();
        let first_dispose = tokio::spawn({
            let (lsp, root) = (lsp.clone(), root.clone());
            async move { lsp.dispose_under(&root).await }
        });
        shutdown_arrived.await;

        let second_dispose = tokio::spawn({
            let (lsp, root) = (lsp.clone(), root.clone());
            async move { lsp.dispose_under(&root).await }
        });
        mixdog_rt::time::sleep(Duration::from_millis(60)).await;
        assert!(!second_dispose.is_finished(), "overlapping dispose_under must wait for earlier disposal's shutdown");

        let held = std::mem::take(&mut *pm.held_shutdowns.lock().unwrap());
        assert_eq!(held.len(), 1);
        pm.say(&held[0].0, &json!({ "jsonrpc": "2.0", "id": &held[0].1, "result": Value::Null }));

        first_dispose.await.unwrap();
        second_dispose.await.unwrap();
        assert!(pm.killed.lock().unwrap().contains(&held[0].0));
        assert!(lsp.state.lock().unwrap().stopping.is_empty());
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn idle_timer_does_not_stop_session_with_open_document_or_in_progress_open() {
        let pm = Arc::new(ScriptedPm::default());
        let sink = Arc::new(Sink::default());
        let lsp = LspManager::new(pm.clone(), sink.clone(), mixdog_rt::testing::tokens().maintenance_io);

        let bin_dir = tempfile::tempdir().unwrap();
        let program = bin_dir.path().join("fake-lsp.bin");
        std::fs::write(&program, b"").unwrap();
        let (_dir, root) = write_project(&program.to_string_lossy());
        let project = root.to_string_lossy().into_owned();

        let open_doc = |rel: &str| DocumentInput {
            kind: "open".into(),
            language_id: "scriptlang".into(),
            rel_path: rel.into(),
            content: "x".into(),
            version: 1,
            attachment_id: None,
        };
        let close_doc = |rel: &str| DocumentInput {
            kind: "close".into(),
            language_id: "scriptlang".into(),
            rel_path: rel.into(),
            content: String::new(),
            version: 1,
            attachment_id: None,
        };

        let _ = lsp.document(&project, &root, open_doc("a.script")).await.unwrap();
        let _ = lsp.document(&project, &root, close_doc("a.script")).await.unwrap();

        let spec = lsp.spec_for(&root, "scriptlang", &tokio_util::sync::CancellationToken::new()).await.unwrap().unwrap();
        let call = lsp.begin_call(&root);
        let (session, mut open_guard) = match lsp.ensure(&project, &root, "scriptlang", &spec, &call.call, true).await {
            EnsureOutcome::Live(s, g) => (s, g.expect("open guard")),
            _ => panic!("expected live session"),
        };
        assert!(session.idle_task.lock().unwrap().is_none(), "ensure must cancel existing idle timer");

        // Concurrent request completing while open is in progress must not arm idle timer.
        lsp.schedule_idle(&session);
        assert!(session.idle_task.lock().unwrap().is_none(), "schedule_idle must not arm while an open is in progress");

        // Even an idle stop matching the current generation must refuse to stop while an open is in progress.
        let gen_during_open = session.idle_generation.load(Ordering::SeqCst);
        lsp.stop_inner(&session, Some(gen_during_open)).await;
        assert!(!session.closing.load(Ordering::SeqCst));
        assert_eq!(lsp.state.lock().unwrap().sessions.len(), 1);
        {
            let mut state = lsp.state.lock().unwrap();
            open_guard.release_locked(&mut state);
        }
        drop(call);

        // Open a document and verify neither schedule_idle nor a matching idle stop can shut down the session.
        let _ = lsp.document(&project, &root, open_doc("b.script")).await.unwrap();
        lsp.schedule_idle(&session);
        assert!(session.idle_task.lock().unwrap().is_none(), "schedule_idle must not arm while documents are open");

        let gen_with_doc = session.idle_generation.load(Ordering::SeqCst);
        lsp.stop_inner(&session, Some(gen_with_doc)).await;
        assert!(!session.closing.load(Ordering::SeqCst), "idle stop must refuse to stop a session with an open document");
        assert_eq!(lsp.state.lock().unwrap().sessions.len(), 1);
        assert!(pm.killed.lock().unwrap().is_empty());

        // Closing the last document allows idle arming and stopping cleanly.
        let _ = lsp.document(&project, &root, close_doc("b.script")).await.unwrap();
        assert!(session.idle_task.lock().unwrap().is_some());
        let armed_gen = session.idle_generation.load(Ordering::SeqCst);
        lsp.stop_inner(&session, Some(armed_gen)).await;
        assert!(session.closing.load(Ordering::SeqCst));
        assert!(lsp.state.lock().unwrap().sessions.is_empty());
        assert_eq!(pm.killed.lock().unwrap().len(), 1);
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn capability_refresh_does_not_recreate_closed_document_status() {
        let pm = Arc::new(ScriptedPm::default());
        let sink = Arc::new(Sink::default());
        let lsp = LspManager::new(pm.clone(), sink.clone(), mixdog_rt::testing::tokens().maintenance_io);

        let bin_dir = tempfile::tempdir().unwrap();
        let program = bin_dir.path().join("fake-lsp.bin");
        std::fs::write(&program, b"").unwrap();
        let (_dir, root) = write_project(&program.to_string_lossy());
        let project = root.to_string_lossy().into_owned();

        let open_doc = |rel: &str| DocumentInput {
            kind: "open".into(),
            language_id: "scriptlang".into(),
            rel_path: rel.into(),
            content: "x".into(),
            version: 1,
            attachment_id: None,
        };
        let close_doc = |rel: &str| DocumentInput {
            kind: "close".into(),
            language_id: "scriptlang".into(),
            rel_path: rel.into(),
            content: String::new(),
            version: 1,
            attachment_id: None,
        };

        let _ = lsp.document(&project, &root, open_doc("keep.script")).await.unwrap();
        let _ = lsp.document(&project, &root, open_doc("closing.script")).await.unwrap();
        let session = lsp.state.lock().unwrap().sessions.values().next().unwrap().clone();

        let _ = lsp.document(&project, &root, close_doc("closing.script")).await.unwrap();
        sink.statuses.lock().unwrap().clear();

        lsp.dispatch(
            &session,
            json!({
                "jsonrpc": "2.0",
                "id": 10,
                "method": "client/registerCapability",
                "params": { "registrations": [{ "id": "def-1", "method": "textDocument/definition", "registerOptions": {} }] }
            }),
        );

        let statuses = sink.statuses.lock().unwrap().clone();
        assert!(statuses.iter().any(|e| e.get("relPath").and_then(Value::as_str) == Some("keep.script")));
        assert!(
            !statuses.iter().any(|e| e.get("relPath").and_then(Value::as_str) == Some("closing.script")),
            "capability refresh must not republish status for a closed document"
        );

        // Concurrent close and capability refresh must never emit status for the document after clear_document.
        for iter in 0..25u64 {
            let _ = lsp.document(&project, &root, open_doc("race.script")).await.unwrap();
            sink.timeline.lock().unwrap().clear();
            let reg_id = format!("race-def-{iter}");
            let (close_res, refresh_res) = tokio::join!(
                tokio::spawn({
                    let (lsp, project, root) = (lsp.clone(), project.clone(), root.clone());
                    async move { lsp.document(&project, &root, close_doc("race.script")).await.unwrap() }
                }),
                tokio::spawn({
                    let (lsp, session) = (lsp.clone(), session.clone());
                    async move {
                        lsp.dispatch(
                            &session,
                            json!({
                                "jsonrpc": "2.0",
                                "id": 100 + iter,
                                "method": "client/registerCapability",
                                "params": { "registrations": [{ "id": reg_id, "method": "textDocument/references", "registerOptions": {} }] }
                            }),
                        );
                    }
                })
            );
            close_res.unwrap();
            refresh_res.unwrap();

            let timeline = sink.timeline.lock().unwrap().clone();
            let clear_idx = timeline.iter().position(|e| e == "clear:race.script").expect("clear_document must run");
            assert!(
                !timeline[clear_idx + 1..].iter().any(|e| e == "status:race.script"),
                "capability refresh recreated closed document status after clear_document: {timeline:?}"
            );
        }

        lsp.dispose().await;
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn cancelled_start_and_wire_request_never_return_stale_status_or_available_true() {
        let pm = Arc::new(ScriptedPm::default());
        let sink = Arc::new(Sink::default());
        let lsp = LspManager::new(pm.clone(), sink.clone(), mixdog_rt::testing::tokens().maintenance_io);

        let bin_dir = tempfile::tempdir().unwrap();
        let program = bin_dir.path().join("fake-lsp.bin");
        std::fs::write(&program, b"").unwrap();
        let dir = tempfile::tempdir().unwrap();
        let root = crate::pathguard::canonical(dir.path()).unwrap();
        std::fs::create_dir_all(root.join(".mixdog")).unwrap();
        let cfg = json!({
            "servers": {
                "scripted": { "command": program.to_string_lossy(), "languages": ["scriptlang"], "name": "Scripted" },
                "keeper": { "command": program.to_string_lossy(), "languages": ["keeplang"], "name": "Keeper" },
            }
        });
        std::fs::write(root.join(".mixdog").join("lsp.json"), cfg.to_string()).unwrap();
        let project = root.to_string_lossy().into_owned();

        let open_doc = |lang: &str, rel: &str| DocumentInput {
            kind: "open".into(),
            language_id: lang.into(),
            rel_path: rel.into(),
            content: "x".into(),
            version: 1,
            attachment_id: None,
        };

        // Start a second server under the same root so dispose_under pauses on its shutdown before pruning states.
        let keeper_ready = lsp.document(&project, &root, open_doc("keeplang", "k.keep")).await.unwrap();
        assert_eq!(keeper_ready["status"], "ready");

        // Part 1: cancelling an in-flight start while cached state still holds "starting" must return "stopped".
        pm.hold_initialize.store(true, Ordering::SeqCst);
        pm.hold_shutdown.store(true, Ordering::SeqCst);
        let init_arrived = pm.init_arrived.notified();
        let doc_task = tokio::spawn({
            let (lsp, project, root) = (lsp.clone(), project.clone(), root.clone());
            async move { lsp.document(&project, &root, open_doc("scriptlang", "a.script")).await.unwrap() }
        });
        init_arrived.await;

        let flight = lsp.state.lock().unwrap().starting.values().next().unwrap().clone();
        let waiter_joined = flight.waiter_joined.notified();
        let req_task = tokio::spawn({
            let (lsp, project, root) = (lsp.clone(), project.clone(), root.clone());
            async move { lsp.request(&project, &root, "a.script", "scriptlang", "textDocument/hover", &json!({})).await.unwrap() }
        });
        waiter_joined.await;

        let shutdown_arrived = pm.shutdown_arrived.notified();
        let dispose = tokio::spawn({
            let (lsp, root) = (lsp.clone(), root.clone());
            async move { lsp.dispose_under(&root).await }
        });
        shutdown_arrived.await;

        // Cached state for "scripted" is guaranteed still present as "starting" while dispose_under awaits keeper's shutdown.
        assert!(
            lsp.state.lock().unwrap().states.values().any(|s| s["server"] == "Scripted" && s["status"] == "starting"),
            "cache must still contain starting state before disposal prune"
        );

        let doc_reply = doc_task.await.unwrap();
        let req_reply = req_task.await.unwrap();
        assert_eq!(doc_reply["status"], "stopped");
        assert_eq!(doc_reply["available"], false);
        assert_eq!(req_reply["status"], "stopped");
        assert_eq!(req_reply["available"], false);

        let held = std::mem::take(&mut *pm.held_shutdowns.lock().unwrap());
        assert_eq!(held.len(), 1);
        pm.say(&held[0].0, &json!({ "jsonrpc": "2.0", "id": &held[0].1, "result": Value::Null }));
        dispose.await.unwrap();

        // Part 2: cancelling an in-flight wire request must return immediately with available: false, status: "stopped",
        // even if a reply arrives while shutdown is still in flight.
        pm.hold_initialize.store(false, Ordering::SeqCst);
        pm.hold_shutdown.store(false, Ordering::SeqCst);
        let ready = lsp.document(&project, &root, open_doc("scriptlang", "a.script")).await.unwrap();
        assert_eq!(ready["status"], "ready");
        let session = lsp.state.lock().unwrap().sessions.values().next().unwrap().clone();

        pm.hold_request.store(true, Ordering::SeqCst);
        pm.hold_shutdown.store(true, Ordering::SeqCst);
        let req_arrived = pm.request_arrived.notified();
        let wire_req = tokio::spawn({
            let (lsp, project, root) = (lsp.clone(), project.clone(), root.clone());
            async move { lsp.request(&project, &root, "a.script", "scriptlang", "textDocument/hover", &json!({})).await.unwrap() }
        });
        req_arrived.await;

        let shutdown_arrived = pm.shutdown_arrived.notified();
        let dispose = tokio::spawn({
            let (lsp, root) = (lsp.clone(), root.clone());
            async move { lsp.dispose_under(&root).await }
        });
        shutdown_arrived.await;

        // Reply to the held wire request after disposal already cancelled it.
        let held_req = std::mem::take(&mut *pm.held_requests.lock().unwrap());
        assert_eq!(held_req.len(), 1);
        pm.say(&held_req[0].0, &json!({ "jsonrpc": "2.0", "id": &held_req[0].1, "result": { "contents": "stale hover" } }));

        let wire_reply =
            mixdog_rt::time::timeout(Duration::from_secs(2), wire_req).await.expect("cancelled wire request must not wait for REQUEST_TIMEOUT").unwrap();
        assert_eq!(wire_reply["available"], false, "cancelled wire request must never return available: true");
        assert_eq!(wire_reply["status"], "stopped");
        let req_id = held_req[0].1.as_i64().unwrap();
        assert!(!session.conn.pending.lock().unwrap().contains_key(&req_id), "cancelled wire request must clean up its pending entry");

        let held_sd = std::mem::take(&mut *pm.held_shutdowns.lock().unwrap());
        assert_eq!(held_sd.len(), 1);
        pm.say(&held_sd[0].0, &json!({ "jsonrpc": "2.0", "id": &held_sd[0].1, "result": Value::Null }));
        dispose.await.unwrap();
        assert!(session.conn.pending.lock().unwrap().is_empty());
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn dispose_under_waits_for_child_exit_after_kill() {
        let pm = Arc::new(ScriptedPm::default());
        let sink = Arc::new(Sink::default());
        let lsp = LspManager::new(pm.clone(), sink.clone(), mixdog_rt::testing::tokens().maintenance_io);

        let bin_dir = tempfile::tempdir().unwrap();
        let program = bin_dir.path().join("fake-lsp.bin");
        std::fs::write(&program, b"").unwrap();
        let (_dir, root) = write_project(&program.to_string_lossy());
        let project = root.to_string_lossy().into_owned();

        let open_doc = DocumentInput {
            kind: "open".into(),
            language_id: "scriptlang".into(),
            rel_path: "a.script".into(),
            content: "x".into(),
            version: 1,
            attachment_id: None,
        };
        let ready = lsp.document(&project, &root, open_doc).await.unwrap();
        assert_eq!(ready["status"], "ready");
        let handle = pm.spawned_handles.lock().unwrap()[0].clone();

        pm.hold_exit.store(true, Ordering::SeqCst);
        let kill_arrived = pm.kill_arrived.notified();
        let dispose = tokio::spawn({
            let (lsp, root) = (lsp.clone(), root.clone());
            async move { lsp.dispose_under(&root).await }
        });
        kill_arrived.await;

        assert!(pm.killed.lock().unwrap().contains(&handle), "kill must have been issued");
        mixdog_rt::time::sleep(Duration::from_millis(60)).await;
        assert!(!dispose.is_finished(), "dispose_under must wait for child ProcessEvent::Exited after kill");
        assert_eq!(lsp.state.lock().unwrap().stopping.len(), 1);

        pm.emit_exit(&handle);
        let stopped = mixdog_rt::time::timeout(Duration::from_secs(2), dispose).await.expect("dispose_under must complete once child exits").unwrap();
        assert_eq!(stopped, vec![root.to_string_lossy().into_owned()]);
        assert!(lsp.state.lock().unwrap().stopping.is_empty());
        assert!(lsp.state.lock().unwrap().sessions.is_empty());
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn dropping_opening_task_during_cancelled_start_shutdown_still_kills_and_reaps_before_dispose_returns() {
        let pm = Arc::new(ScriptedPm::default());
        pm.hold_initialize.store(true, Ordering::SeqCst);
        pm.hold_shutdown.store(true, Ordering::SeqCst);
        pm.hold_exit.store(true, Ordering::SeqCst);
        let sink = Arc::new(Sink::default());
        let lsp = LspManager::new(pm.clone(), sink.clone(), mixdog_rt::testing::tokens().maintenance_io);

        let promote_arrived = Arc::new(tokio::sync::Notify::new());
        let promote_release = Arc::new(tokio::sync::Notify::new());
        *lsp.promote_gate.lock().unwrap() = Some((promote_arrived.clone(), promote_release.clone()));

        let bin_dir = tempfile::tempdir().unwrap();
        let program = bin_dir.path().join("fake-lsp.bin");
        std::fs::write(&program, b"").unwrap();
        let (_dir, root) = write_project(&program.to_string_lossy());
        let project = root.to_string_lossy().into_owned();

        let open_doc = DocumentInput {
            kind: "open".into(),
            language_id: "scriptlang".into(),
            rel_path: "a.script".into(),
            content: "x".into(),
            version: 1,
            attachment_id: None,
        };
        let init_arrived = pm.init_arrived.notified();
        let doc_task = tokio::spawn({
            let (lsp, project, root) = (lsp.clone(), project.clone(), root.clone());
            async move { lsp.document(&project, &root, open_doc).await.unwrap() }
        });
        init_arrived.await;

        let flight = lsp.state.lock().unwrap().starting.values().next().unwrap().clone();
        let held_init = std::mem::take(&mut *pm.held_inits.lock().unwrap());
        assert_eq!(held_init.len(), 1);
        let (handle, init_id) = held_init[0].clone();

        let promote_wait = promote_arrived.notified();
        pm.say(&handle, &json!({ "jsonrpc": "2.0", "id": init_id, "result": { "capabilities": { "hoverProvider": true } } }));
        promote_wait.await;

        let dispose = tokio::spawn({
            let (lsp, root) = (lsp.clone(), root.clone());
            async move { lsp.dispose_under(&root).await }
        });
        flight.cancel.cancelled().await;

        let shutdown_arrived = pm.shutdown_arrived.notified();
        promote_release.notify_waiters();
        shutdown_arrived.await;

        // Drop the opening task while graceful shutdown of the cancelled start is in flight.
        doc_task.abort();
        let _ = doc_task.await;

        mixdog_rt::time::sleep(Duration::from_millis(60)).await;
        assert!(!dispose.is_finished(), "dispose_under must stay pending until detached teardown kills and reaps the child");
        assert!(pm.killed.lock().unwrap().is_empty(), "kill waits for shutdown reply");

        let held_sd = std::mem::take(&mut *pm.held_shutdowns.lock().unwrap());
        assert_eq!(held_sd.len(), 1);
        let kill_arrived = pm.kill_arrived.notified();
        pm.say(&held_sd[0].0, &json!({ "jsonrpc": "2.0", "id": &held_sd[0].1, "result": Value::Null }));
        kill_arrived.await;

        assert!(pm.killed.lock().unwrap().contains(&handle), "dropped opening task must still result in kill");
        mixdog_rt::time::sleep(Duration::from_millis(40)).await;
        assert!(!dispose.is_finished(), "dispose_under must wait for child exit after kill");

        pm.emit_exit(&handle);
        mixdog_rt::time::timeout(Duration::from_secs(2), dispose).await.expect("dispose_under must finish after child exits").unwrap();
        assert!(lsp.state.lock().unwrap().sessions.is_empty());
        assert!(lsp.state.lock().unwrap().starting.is_empty());
        assert!(lsp.state.lock().unwrap().stopping.is_empty());
        assert!(lsp.state.lock().unwrap().states.is_empty());
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn dropping_disposal_midway_leaves_no_cancelled_session_and_serializes_replacement() {
        let pm = Arc::new(ScriptedPm::default());
        let sink = Arc::new(Sink::default());
        let lsp = LspManager::new(pm.clone(), sink.clone(), mixdog_rt::testing::tokens().maintenance_io);

        let bin_dir = tempfile::tempdir().unwrap();
        let program = bin_dir.path().join("fake-lsp.bin");
        std::fs::write(&program, b"").unwrap();
        let dir = tempfile::tempdir().unwrap();
        let root = crate::pathguard::canonical(dir.path()).unwrap();
        std::fs::create_dir_all(root.join(".mixdog")).unwrap();
        let cfg = json!({
            "servers": {
                "first": { "command": program.to_string_lossy(), "languages": ["langone"], "name": "First" },
                "second": { "command": program.to_string_lossy(), "languages": ["langtwo"], "name": "Second" },
            }
        });
        std::fs::write(root.join(".mixdog").join("lsp.json"), cfg.to_string()).unwrap();
        let project = root.to_string_lossy().into_owned();

        let open_doc = |lang: &str, rel: &str| DocumentInput {
            kind: "open".into(),
            language_id: lang.into(),
            rel_path: rel.into(),
            content: "x".into(),
            version: 1,
            attachment_id: None,
        };
        assert_eq!(lsp.document(&project, &root, open_doc("langone", "a.one")).await.unwrap()["status"], "ready");
        assert_eq!(lsp.document(&project, &root, open_doc("langtwo", "b.two")).await.unwrap()["status"], "ready");
        assert_eq!(pm.spawn_count.load(Ordering::SeqCst), 2);
        let old_handles = pm.spawned_handles.lock().unwrap().clone();
        assert_eq!(old_handles.len(), 2);

        pm.hold_shutdown.store(true, Ordering::SeqCst);
        pm.hold_exit.store(true, Ordering::SeqCst);
        let shutdown_arrived = pm.shutdown_arrived.notified();
        let dispose = tokio::spawn({
            let (lsp, root) = (lsp.clone(), root.clone());
            async move { lsp.dispose_under(&root).await }
        });
        shutdown_arrived.await;

        // Abort/drop the disposal future mid-way while both servers are shutting down.
        dispose.abort();
        let _ = dispose.await;

        {
            let state = lsp.state.lock().unwrap();
            assert!(state.sessions.is_empty(), "no cancelled session may remain in sessions after mid-way disposal drop");
            assert!(state.disposing_roots.is_empty(), "DisposeGuard must release disposing_roots on drop");
            assert_eq!(state.stopping.len(), 2, "both cancelled sessions must stay tracked in stopping");
        }

        // Start a replacement for langone while the old server is still stopping: it must wait instead of overlapping.
        let replacement = tokio::spawn({
            let (lsp, project, root) = (lsp.clone(), project.clone(), root.clone());
            async move { lsp.document(&project, &root, open_doc("langone", "c.one")).await.unwrap() }
        });
        mixdog_rt::time::sleep(Duration::from_millis(60)).await;
        assert!(!replacement.is_finished(), "replacement must wait for stopping server of the same key to exit");
        assert_eq!(pm.spawn_count.load(Ordering::SeqCst), 2, "replacement must not spawn before old server exits");

        // Wait until both shutdown requests have arrived, then release both shutdowns and exits.
        for _ in 0..50 {
            if pm.held_shutdowns.lock().unwrap().len() == 2 {
                break;
            }
            mixdog_rt::time::sleep(Duration::from_millis(10)).await;
        }
        let held_sd = std::mem::take(&mut *pm.held_shutdowns.lock().unwrap());
        assert_eq!(held_sd.len(), 2, "both cancelled servers must receive shutdown even after disposal was dropped");
        pm.hold_shutdown.store(false, Ordering::SeqCst);
        for (h, id) in &held_sd {
            pm.say(h, &json!({ "jsonrpc": "2.0", "id": id, "result": Value::Null }));
        }
        for _ in 0..50 {
            if pm.killed.lock().unwrap().len() == 2 {
                break;
            }
            mixdog_rt::time::sleep(Duration::from_millis(10)).await;
        }
        assert_eq!(pm.killed.lock().unwrap().len(), 2, "both cancelled servers must be killed");
        let stopped: Vec<_> = lsp.state.lock().unwrap().stopping.values().map(|stopping| stopping.done.clone()).collect();
        for h in &old_handles {
            pm.emit_exit(h);
        }

        let replaced =
            mixdog_rt::time::timeout(Duration::from_secs(2), replacement).await.expect("replacement must start cleanly once stopping server exits").unwrap();
        assert_eq!(replaced["status"], "ready");
        assert_eq!(pm.spawn_count.load(Ordering::SeqCst), 3);
        // The replacement waits for its own key's server only: the other one's stop ends on its own task.
        for mut done in stopped {
            let _ = done.changed().await;
        }
        assert!(lsp.state.lock().unwrap().stopping.is_empty());

        pm.hold_exit.store(false, Ordering::SeqCst);
        lsp.dispose().await;
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn wire_reply_cancelled_during_finalize_never_returns_available_true() {
        let pm = Arc::new(ScriptedPm::default());
        let sink = Arc::new(Sink::default());
        let lsp = LspManager::new(pm.clone(), sink.clone(), mixdog_rt::testing::tokens().maintenance_io);

        let bin_dir = tempfile::tempdir().unwrap();
        let program = bin_dir.path().join("fake-lsp.bin");
        std::fs::write(&program, b"").unwrap();
        let (_dir, root) = write_project(&program.to_string_lossy());
        let project = root.to_string_lossy().into_owned();

        let open_doc = DocumentInput {
            kind: "open".into(),
            language_id: "scriptlang".into(),
            rel_path: "a.script".into(),
            content: "x".into(),
            version: 1,
            attachment_id: None,
        };
        assert_eq!(lsp.document(&project, &root, open_doc).await.unwrap()["status"], "ready");

        let finalize_arrived = Arc::new(tokio::sync::Notify::new());
        let finalize_release = Arc::new(tokio::sync::Notify::new());
        *lsp.request_finalize_gate.lock().unwrap() = Some((finalize_arrived.clone(), finalize_release.clone()));

        let wait_arrived = finalize_arrived.notified();
        let req_task = tokio::spawn({
            let (lsp, project, root) = (lsp.clone(), project.clone(), root.clone());
            async move { lsp.request(&project, &root, "a.script", "scriptlang", "textDocument/hover", &json!({})).await.unwrap() }
        });
        // Wire reply has already returned Ok(...) and the call is paused right before the final state lock / schedule_idle.
        wait_arrived.await;

        lsp.dispose_under(&root).await;
        finalize_release.notify_waiters();

        let reply = req_task.await.unwrap();
        assert_eq!(reply["available"], false, "request cancelled during finalize/schedule_idle must never return available: true");
        assert_eq!(reply["status"], "stopped");
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn waiter_sharing_cancelled_start_returns_stopped_without_waiting_for_shutdown() {
        let pm = Arc::new(ScriptedPm::default());
        pm.hold_initialize.store(true, Ordering::SeqCst);
        pm.hold_shutdown.store(true, Ordering::SeqCst);
        let sink = Arc::new(Sink::default());
        let lsp = LspManager::new(pm.clone(), sink.clone(), mixdog_rt::testing::tokens().maintenance_io);

        let promote_arrived = Arc::new(tokio::sync::Notify::new());
        let promote_release = Arc::new(tokio::sync::Notify::new());
        *lsp.promote_gate.lock().unwrap() = Some((promote_arrived.clone(), promote_release.clone()));

        let bin_dir = tempfile::tempdir().unwrap();
        let program = bin_dir.path().join("fake-lsp.bin");
        std::fs::write(&program, b"").unwrap();
        let (_dir, root) = write_project(&program.to_string_lossy());
        let project = root.to_string_lossy().into_owned();

        let open_doc = |rel: &str| DocumentInput {
            kind: "open".into(),
            language_id: "scriptlang".into(),
            rel_path: rel.into(),
            content: "x".into(),
            version: 1,
            attachment_id: None,
        };
        let init_arrived = pm.init_arrived.notified();
        let starter = tokio::spawn({
            let (lsp, project, root) = (lsp.clone(), project.clone(), root.clone());
            async move { lsp.document(&project, &root, open_doc("a.script")).await.unwrap() }
        });
        init_arrived.await;

        let flight = lsp.state.lock().unwrap().starting.values().next().unwrap().clone();
        let waiter_joined = flight.waiter_joined.notified();
        let waiter = tokio::spawn({
            let (lsp, project, root) = (lsp.clone(), project.clone(), root.clone());
            async move { lsp.request(&project, &root, "b.script", "scriptlang", "textDocument/hover", &json!({})).await.unwrap() }
        });
        waiter_joined.await;

        let held_init = std::mem::take(&mut *pm.held_inits.lock().unwrap());
        let promote_wait = promote_arrived.notified();
        pm.say(&held_init[0].0, &json!({ "jsonrpc": "2.0", "id": &held_init[0].1, "result": { "capabilities": { "hoverProvider": true } } }));
        promote_wait.await;

        let dispose = tokio::spawn({
            let (lsp, root) = (lsp.clone(), root.clone());
            async move { lsp.dispose_under(&root).await }
        });
        flight.cancel.cancelled().await;
        let shutdown_arrived = pm.shutdown_arrived.notified();
        promote_release.notify_waiters();
        shutdown_arrived.await;

        // Disposal is parked waiting on graceful shutdown; waiter and starter return "stopped" immediately.
        let waiter_reply = mixdog_rt::time::timeout(Duration::from_millis(250), waiter)
            .await
            .expect("waiter sharing a cancelled start must return immediately without waiting for shutdown timeout")
            .unwrap();
        assert_eq!(waiter_reply["status"], "stopped");
        assert_eq!(waiter_reply["available"], false);
        assert!(!dispose.is_finished(), "disposal must still be awaiting graceful shutdown");

        let held_sd = std::mem::take(&mut *pm.held_shutdowns.lock().unwrap());
        assert_eq!(held_sd.len(), 1);
        pm.say(&held_sd[0].0, &json!({ "jsonrpc": "2.0", "id": &held_sd[0].1, "result": Value::Null }));

        let starter_reply = starter.await.unwrap();
        assert_eq!(starter_reply["status"], "stopped");
        dispose.await.unwrap();
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn document_open_blocked_in_spec_for_prevents_idle_stop() {
        let pm = Arc::new(ScriptedPm::default());
        let sink = Arc::new(Sink::default());
        let lsp = LspManager::new(pm.clone(), sink.clone(), mixdog_rt::testing::tokens().maintenance_io);

        let bin_dir = tempfile::tempdir().unwrap();
        let program = bin_dir.path().join("fake-lsp.bin");
        std::fs::write(&program, b"").unwrap();
        let (_dir, root) = write_project(&program.to_string_lossy());
        let project = root.to_string_lossy().into_owned();

        let open_doc = |rel: &str| DocumentInput {
            kind: "open".into(),
            language_id: "scriptlang".into(),
            rel_path: rel.into(),
            content: "x".into(),
            version: 1,
            attachment_id: None,
        };
        let close_doc = |rel: &str| DocumentInput {
            kind: "close".into(),
            language_id: "scriptlang".into(),
            rel_path: rel.into(),
            content: String::new(),
            version: 1,
            attachment_id: None,
        };

        assert_eq!(lsp.document(&project, &root, open_doc("a.script")).await.unwrap()["status"], "ready");
        assert_eq!(lsp.document(&project, &root, close_doc("a.script")).await.unwrap()["status"], "ready");

        let session = lsp.state.lock().unwrap().sessions.values().next().unwrap().clone();
        let armed_gen = session.idle_generation.load(Ordering::SeqCst);
        assert!(session.idle_task.lock().unwrap().is_some());

        let spec_entered = Arc::new(tokio::sync::Notify::new());
        let (release_tx, release_rx) = std::sync::mpsc::channel::<()>();
        let release_rx = Arc::new(Mutex::new(release_rx));
        *lsp.spec_override.lock().unwrap() = Some(Arc::new({
            let spec_entered = spec_entered.clone();
            move |root, language| {
                spec_entered.notify_waiters();
                let _ = release_rx.lock().unwrap().recv();
                let mut project = project_specs(root)?;
                Ok(project.remove(language).or_else(|| default_spec(language)))
            }
        }));

        let wait_spec = spec_entered.notified();
        let open_task = tokio::spawn({
            let (lsp, project, root) = (lsp.clone(), project.clone(), root.clone());
            async move { lsp.document(&project, &root, open_doc("b.script")).await.unwrap() }
        });
        wait_spec.await;

        assert_eq!(lsp.state.lock().unwrap().pending_opens_by_root.get(&session.comparable_root).copied(), Some(1));

        // Idle stop firing while document open is still blocked in spec_for must refuse to stop the server.
        lsp.stop_inner(&session, Some(armed_gen)).await;
        assert!(!session.closing.load(Ordering::SeqCst), "idle stop must not stop session while open is in spec_for");
        assert_eq!(lsp.state.lock().unwrap().sessions.len(), 1);
        assert!(pm.killed.lock().unwrap().is_empty());

        lsp.schedule_idle(&session);
        assert!(session.idle_task.lock().unwrap().is_none(), "schedule_idle must not arm while open is in spec_for");

        let _ = release_tx.send(());
        let opened = open_task.await.unwrap();
        assert_eq!(opened["status"], "ready");
        assert_eq!(pm.spawn_count.load(Ordering::SeqCst), 1, "existing server must be reused");
        assert_eq!(session.documents.lock().unwrap().len(), 1);
        assert!(lsp.state.lock().unwrap().pending_opens_by_root.is_empty());

        *lsp.spec_override.lock().unwrap() = None;
        lsp.dispose().await;
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn aborting_opening_task_during_inflight_launch_does_not_let_dispose_return_early() {
        let pm = Arc::new(ScriptedPm::default());
        pm.hold_inflight_spawn.store(true, Ordering::SeqCst);
        pm.hold_exit.store(true, Ordering::SeqCst);
        let sink = Arc::new(Sink::default());
        let lsp = LspManager::new(pm.clone(), sink.clone(), mixdog_rt::testing::tokens().maintenance_io);

        let bin_dir = tempfile::tempdir().unwrap();
        let program = bin_dir.path().join("fake-lsp.bin");
        std::fs::write(&program, b"").unwrap();
        let (_dir, root) = write_project(&program.to_string_lossy());
        let project = root.to_string_lossy().into_owned();

        let open_doc = DocumentInput {
            kind: "open".into(),
            language_id: "scriptlang".into(),
            rel_path: "a.script".into(),
            content: "x".into(),
            version: 1,
            attachment_id: None,
        };
        let arrived = pm.inflight_spawn_arrived.notified();
        let open_task = tokio::spawn({
            let (lsp, project, root) = (lsp.clone(), project.clone(), root.clone());
            async move { lsp.document(&project, &root, open_doc).await.unwrap() }
        });
        arrived.await;

        let flight = lsp.state.lock().unwrap().starting.values().next().unwrap().clone();
        let dispose = tokio::spawn({
            let (lsp, root) = (lsp.clone(), root.clone());
            async move { lsp.dispose_under(&root).await }
        });
        flight.cancel.cancelled().await;

        // Aborting the external caller task must not abandon the manager-owned launch task.
        open_task.abort();
        let _ = open_task.await;

        mixdog_rt::time::sleep(Duration::from_millis(60)).await;
        assert!(!dispose.is_finished(), "dispose_under must wait for the detached launch task even after caller abort");

        let kill_wait = pm.kill_arrived.notified();
        pm.inflight_spawn_release.notify_waiters();
        kill_wait.await;

        mixdog_rt::time::sleep(Duration::from_millis(60)).await;
        assert!(!dispose.is_finished(), "dispose_under must wait until the killed child exits");

        let handle = pm.spawned_handles.lock().unwrap()[0].clone();
        pm.emit_exit(&handle);

        mixdog_rt::time::timeout(Duration::from_secs(2), dispose).await.expect("dispose_under must finish once the detached launch reaps its child").unwrap();
        let state = lsp.state.lock().unwrap();
        assert!(state.starting.is_empty());
        assert!(state.stopping.is_empty());
        assert!(state.sessions.is_empty());
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn server_exiting_during_promotion_is_not_inserted_as_ready() {
        let pm = Arc::new(ScriptedPm::default());
        pm.hold_initialize.store(true, Ordering::SeqCst);
        let sink = Arc::new(Sink::default());
        let lsp = LspManager::new(pm.clone(), sink.clone(), mixdog_rt::testing::tokens().maintenance_io);

        let promote_arrived = Arc::new(tokio::sync::Notify::new());
        let promote_release = Arc::new(tokio::sync::Notify::new());
        *lsp.promote_gate.lock().unwrap() = Some((promote_arrived.clone(), promote_release.clone()));

        let bin_dir = tempfile::tempdir().unwrap();
        let program = bin_dir.path().join("fake-lsp.bin");
        std::fs::write(&program, b"").unwrap();
        let (_dir, root) = write_project(&program.to_string_lossy());
        let project = root.to_string_lossy().into_owned();

        let open_doc = DocumentInput {
            kind: "open".into(),
            language_id: "scriptlang".into(),
            rel_path: "a.script".into(),
            content: "x".into(),
            version: 1,
            attachment_id: None,
        };
        let init_arrived = pm.init_arrived.notified();
        let open_task = tokio::spawn({
            let (lsp, project, root) = (lsp.clone(), project.clone(), root.clone());
            async move { lsp.document(&project, &root, open_doc).await.unwrap() }
        });
        init_arrived.await;

        let session = lsp.state.lock().unwrap().starting.values().next().unwrap().session.lock().unwrap().clone().unwrap();
        let held = std::mem::take(&mut *pm.held_inits.lock().unwrap());
        let promote_wait = promote_arrived.notified();
        pm.say(&held[0].0, &json!({ "jsonrpc": "2.0", "id": &held[0].1, "result": { "capabilities": { "hoverProvider": true } } }));
        promote_wait.await;

        // Server exits immediately after replying to initialize, before promotion acquires `self.state`.
        pm.emit_exit(&held[0].0);
        session.wait_exited().await;

        promote_release.notify_waiters();
        let reply = open_task.await.unwrap();
        assert_eq!(reply["available"], false, "a server that crashed before promotion must not report available: true");
        assert_ne!(reply["status"], "ready", "a server that crashed before promotion must not become ready");

        let state = lsp.state.lock().unwrap();
        assert!(state.sessions.is_empty(), "crashed session must never be inserted into state.sessions");
        assert!(state.starting.is_empty());
        assert!(state.stopping.is_empty());
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn obsolete_deferred_close_does_not_close_reopened_document() {
        let pm = Arc::new(ScriptedPm::default());
        let sink = Arc::new(Sink::default());
        let lsp = LspManager::new(pm.clone(), sink.clone(), mixdog_rt::testing::tokens().maintenance_io);

        let bin_dir = tempfile::tempdir().unwrap();
        let program = bin_dir.path().join("fake-lsp.bin");
        std::fs::write(&program, b"").unwrap();
        let (_dir, root) = write_project(&program.to_string_lossy());
        let project = root.to_string_lossy().into_owned();

        let open_v1 = DocumentInput {
            kind: "open".into(),
            language_id: "scriptlang".into(),
            rel_path: "a.script".into(),
            content: "v1".into(),
            version: 1,
            attachment_id: Some("att-1".into()),
        };
        let open_v2 = DocumentInput {
            kind: "open".into(),
            language_id: "scriptlang".into(),
            rel_path: "a.script".into(),
            content: "v2".into(),
            version: 2,
            attachment_id: Some("att-2".into()),
        };
        let close_v1 = DocumentInput {
            kind: "close".into(),
            language_id: "scriptlang".into(),
            rel_path: "a.script".into(),
            content: String::new(),
            version: 1,
            attachment_id: Some("att-1".into()),
        };
        let close_v2 = DocumentInput {
            kind: "close".into(),
            language_id: "scriptlang".into(),
            rel_path: "a.script".into(),
            content: String::new(),
            version: 2,
            attachment_id: Some("att-2".into()),
        };

        assert_eq!(lsp.document(&project, &root, open_v1).await.unwrap()["status"], "ready");
        assert_eq!(lsp.document(&project, &root, open_v2).await.unwrap()["status"], "ready");

        // Obsolete deferred close from the first open arrives after reopen.
        assert_eq!(lsp.document(&project, &root, close_v1).await.unwrap()["status"], "ready");

        let session = lsp.state.lock().unwrap().sessions.values().next().unwrap().clone();
        {
            let docs = session.documents.lock().unwrap();
            assert_eq!(docs.len(), 1, "reopened document must stay open after obsolete close");
            assert_eq!(docs.values().next().unwrap().owners, HashSet::from(["att-2".to_owned()]));
        }
        assert!(session.idle_task.lock().unwrap().is_none(), "idle timer must not arm while reopened document is open");
        assert!(sink.cleared.lock().unwrap().is_empty(), "obsolete close must not clear reopened document feeds");
        // Allow writer task to flush notifications before asserting on ScriptedPm.
        mixdog_rt::time::sleep(Duration::from_millis(30)).await;
        {
            let notes = pm.notifications.lock().unwrap();
            assert_eq!(notes.iter().filter(|(m, _)| m == "textDocument/didOpen").count(), 1);
            assert_eq!(notes.iter().filter(|(m, _)| m == "textDocument/didClose").count(), 0);
        }

        // Final close balances the reopen, sends didClose, clears feeds, and arms idle.
        assert_eq!(lsp.document(&project, &root, close_v2).await.unwrap()["status"], "ready");
        assert!(session.documents.lock().unwrap().is_empty());
        assert!(session.idle_task.lock().unwrap().is_some(), "final close must arm idle shutdown");
        assert_eq!(sink.cleared.lock().unwrap().len(), 1);
        mixdog_rt::time::sleep(Duration::from_millis(30)).await;
        assert_eq!(pm.notifications.lock().unwrap().iter().filter(|(m, _)| m == "textDocument/didClose").count(), 1);

        lsp.dispose().await;
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn releasing_last_pending_root_open_on_stale_session_rearms_sibling_idle() {
        let pm = Arc::new(ScriptedPm::default());
        let sink = Arc::new(Sink::default());
        let lsp = LspManager::new(pm.clone(), sink.clone(), mixdog_rt::testing::tokens().maintenance_io);

        let bin_dir = tempfile::tempdir().unwrap();
        let program = bin_dir.path().join("fake-lsp.bin");
        std::fs::write(&program, b"").unwrap();
        let dir = tempfile::tempdir().unwrap();
        let root = crate::pathguard::canonical(dir.path()).unwrap();
        std::fs::create_dir_all(root.join(".mixdog")).unwrap();
        let cfg = json!({
            "servers": {
                "server-a": { "command": program.to_string_lossy(), "languages": ["langa"], "name": "ServerA" },
                "server-b": { "command": program.to_string_lossy(), "languages": ["langb"], "name": "ServerB" }
            }
        });
        std::fs::write(root.join(".mixdog").join("lsp.json"), cfg.to_string()).unwrap();
        let project = root.to_string_lossy().into_owned();

        let open_a = |rel: &str| DocumentInput {
            kind: "open".into(),
            language_id: "langa".into(),
            rel_path: rel.into(),
            content: "a".into(),
            version: 1,
            attachment_id: None,
        };
        let open_b = |rel: &str| DocumentInput {
            kind: "open".into(),
            language_id: "langb".into(),
            rel_path: rel.into(),
            content: "b".into(),
            version: 1,
            attachment_id: None,
        };
        let close_b = |rel: &str| DocumentInput {
            kind: "close".into(),
            language_id: "langb".into(),
            rel_path: rel.into(),
            content: String::new(),
            version: 1,
            attachment_id: None,
        };

        assert_eq!(lsp.document(&project, &root, open_a("a1.langa")).await.unwrap()["status"], "ready");
        assert_eq!(lsp.document(&project, &root, open_b("b1.langb")).await.unwrap()["status"], "ready");

        let (session_a, session_b) = {
            let state = lsp.state.lock().unwrap();
            let a = state.sessions.values().find(|s| s.spec.name == "ServerA").unwrap().clone();
            let b = state.sessions.values().find(|s| s.spec.name == "ServerB").unwrap().clone();
            (a, b)
        };

        // Hold an open on ServerA right after ensure() so RootOpenGuard is active while ServerB closes its last doc.
        let gate_arrived = Arc::new(tokio::sync::Notify::new());
        let gate_release = Arc::new(tokio::sync::Notify::new());
        *lsp.document_post_ensure_gate.lock().unwrap() = Some((gate_arrived.clone(), gate_release.clone()));

        let wait_gate = gate_arrived.notified();
        let open_a2 = tokio::spawn({
            let (lsp, project, root) = (lsp.clone(), project.clone(), root.clone());
            async move { lsp.document(&project, &root, open_a("a2.langa")).await.unwrap() }
        });
        wait_gate.await;

        // Close ServerB's last document: pending root open suppresses ServerB's idle timer.
        assert_eq!(lsp.document(&project, &root, close_b("b1.langb")).await.unwrap()["status"], "ready");
        assert!(session_b.documents.lock().unwrap().is_empty());
        assert!(session_b.idle_task.lock().unwrap().is_none(), "pending root open on ServerA should temporarily suppress ServerB idle");

        // Crash ServerA so open_a2 takes the stale-session release_locked() path.
        pm.emit_exit(&session_a.handle.as_str());
        session_a.wait_exited().await;
        // Wait for reader to finish stopped_locked on session_a.
        let deadline = tokio::time::Instant::now() + Duration::from_secs(2);
        while !session_a.closing.load(Ordering::SeqCst) {
            assert!(tokio::time::Instant::now() < deadline, "session_a did not transition to closing");
            mixdog_rt::time::sleep(Duration::from_millis(10)).await;
        }

        *lsp.document_post_ensure_gate.lock().unwrap() = None;
        gate_release.notify_waiters();

        let reply = open_a2.await.unwrap();
        assert_eq!(reply["status"], "stopped");
        assert!(lsp.state.lock().unwrap().pending_opens_by_root.is_empty());
        assert!(
            session_b.idle_task.lock().unwrap().is_some(),
            "releasing the last pending root open on the stale-session path must rearm sibling zero-document server idle"
        );

        lsp.dispose().await;
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn old_attachment_close_does_not_close_document_on_replacement_server() {
        let pm = Arc::new(ScriptedPm::default());
        let sink = Arc::new(Sink::default());
        let lsp = LspManager::new(pm.clone(), sink.clone(), mixdog_rt::testing::tokens().maintenance_io);

        let bin_dir = tempfile::tempdir().unwrap();
        let program = bin_dir.path().join("fake-lsp.bin");
        std::fs::write(&program, b"").unwrap();
        let (_dir, root) = write_project(&program.to_string_lossy());
        let project = root.to_string_lossy().into_owned();

        let open_att = |att: &str, content: &str| DocumentInput {
            kind: "open".into(),
            language_id: "scriptlang".into(),
            rel_path: "a.script".into(),
            content: content.into(),
            version: 1,
            attachment_id: Some(att.into()),
        };
        let close_att = |att: &str| DocumentInput {
            kind: "close".into(),
            language_id: "scriptlang".into(),
            rel_path: "a.script".into(),
            content: String::new(),
            version: 1,
            attachment_id: Some(att.into()),
        };

        // Pane A opens on server S1.
        assert_eq!(lsp.document(&project, &root, open_att("att-a", "v1")).await.unwrap()["status"], "ready");
        let s1 = lsp.state.lock().unwrap().sessions.values().next().unwrap().clone();

        // S1 crashes and clears backoff so replacement S2 can start.
        pm.emit_exit(s1.handle.as_str());
        s1.wait_exited().await;
        let deadline = tokio::time::Instant::now() + Duration::from_secs(2);
        while !s1.closing.load(Ordering::SeqCst) {
            assert!(tokio::time::Instant::now() < deadline, "S1 did not transition to closing");
            mixdog_rt::time::sleep(Duration::from_millis(10)).await;
        }
        lsp.state.lock().unwrap().health.failures.clear();
        sink.cleared.lock().unwrap().clear();
        pm.notifications.lock().unwrap().clear();

        // Pane B opens on replacement server S2.
        assert_eq!(lsp.document(&project, &root, open_att("att-b", "v2")).await.unwrap()["status"], "ready");
        assert_eq!(pm.spawn_count.load(Ordering::SeqCst), 2, "replacement server S2 must be started");
        let s2 = lsp.state.lock().unwrap().sessions.values().next().unwrap().clone();
        assert!(!Arc::ptr_eq(&s1, &s2));

        // Pane A detaches and sends close targeting the current session S2.
        assert_eq!(lsp.document(&project, &root, close_att("att-a")).await.unwrap()["status"], "ready");
        {
            let docs = s2.documents.lock().unwrap();
            assert_eq!(docs.len(), 1, "Pane A's stale close must not remove Pane B's document on S2");
            assert_eq!(docs.values().next().unwrap().owners, HashSet::from(["att-b".to_owned()]));
        }
        assert!(s2.idle_task.lock().unwrap().is_none(), "stale close must not arm idle shutdown on S2");
        assert!(sink.cleared.lock().unwrap().is_empty(), "stale close must not clear Pane B's diagnostics");
        mixdog_rt::time::sleep(Duration::from_millis(30)).await;
        assert_eq!(pm.notifications.lock().unwrap().iter().filter(|(m, _)| m == "textDocument/didClose").count(), 0);

        // Pane B closes normally and cleans up S2.
        assert_eq!(lsp.document(&project, &root, close_att("att-b")).await.unwrap()["status"], "ready");
        assert!(s2.documents.lock().unwrap().is_empty());
        assert!(s2.idle_task.lock().unwrap().is_some());
        assert_eq!(sink.cleared.lock().unwrap().len(), 1);
        mixdog_rt::time::sleep(Duration::from_millis(30)).await;
        assert_eq!(pm.notifications.lock().unwrap().iter().filter(|(m, _)| m == "textDocument/didClose").count(), 1);

        lsp.dispose().await;
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn config_error_retry_open_by_same_attachment_is_idempotent() {
        let pm = Arc::new(ScriptedPm::default());
        let sink = Arc::new(Sink::default());
        let lsp = LspManager::new(pm.clone(), sink.clone(), mixdog_rt::testing::tokens().maintenance_io);

        let bin_dir = tempfile::tempdir().unwrap();
        let program = bin_dir.path().join("fake-lsp.bin");
        std::fs::write(&program, b"").unwrap();
        let (_dir, root) = write_project(&program.to_string_lossy());
        let project = root.to_string_lossy().into_owned();
        let cfg_path = root.join(".mixdog").join("lsp.json");
        let valid_cfg = std::fs::read_to_string(&cfg_path).unwrap();

        let att = Some("att-solo".to_owned());
        let open_doc = DocumentInput {
            kind: "open".into(),
            language_id: "scriptlang".into(),
            rel_path: "a.script".into(),
            content: "v1".into(),
            version: 1,
            attachment_id: att.clone(),
        };
        assert_eq!(lsp.document(&project, &root, open_doc.clone()).await.unwrap()["status"], "ready");
        let session = lsp.state.lock().unwrap().sessions.values().next().unwrap().clone();

        // Temporarily corrupt config: change returns error without closing the live document.
        std::fs::write(&cfg_path, "{ not valid json").unwrap();
        let change_err = lsp
            .document(
                &project,
                &root,
                DocumentInput {
                    kind: "change".into(),
                    language_id: "scriptlang".into(),
                    rel_path: "a.script".into(),
                    content: "v2".into(),
                    version: 2,
                    attachment_id: att.clone(),
                },
            )
            .await
            .unwrap();
        assert_eq!(change_err["available"], false);
        assert_eq!(change_err["status"], "error");

        // Restore config and retry open from the exact same attachment.
        std::fs::write(&cfg_path, valid_cfg).unwrap();
        let retry_open = lsp
            .document(
                &project,
                &root,
                DocumentInput {
                    kind: "open".into(),
                    language_id: "scriptlang".into(),
                    rel_path: "a.script".into(),
                    content: "v2".into(),
                    version: 2,
                    attachment_id: att.clone(),
                },
            )
            .await
            .unwrap();
        assert_eq!(retry_open["status"], "ready");
        {
            let docs = session.documents.lock().unwrap();
            assert_eq!(docs.values().next().unwrap().owners.len(), 1, "retrying open with same attachmentId must be idempotent");
        }

        // Closing the sole pane once must remove the document and arm idle shutdown.
        let closed = lsp
            .document(
                &project,
                &root,
                DocumentInput {
                    kind: "close".into(),
                    language_id: "scriptlang".into(),
                    rel_path: "a.script".into(),
                    content: String::new(),
                    version: 2,
                    attachment_id: att,
                },
            )
            .await
            .unwrap();
        assert_eq!(closed["status"], "ready");
        assert!(session.documents.lock().unwrap().is_empty(), "single close must release sole owner after retry open");
        assert!(session.idle_task.lock().unwrap().is_some(), "idle shutdown must be armed after sole pane closes");

        lsp.dispose().await;
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn reopening_recreated_model_with_lower_client_version_syncs_new_text_with_monotonic_server_version() {
        let pm = Arc::new(ScriptedPm::default());
        let sink = Arc::new(Sink::default());
        let lsp = LspManager::new(pm.clone(), sink.clone(), mixdog_rt::testing::tokens().maintenance_io);

        let bin_dir = tempfile::tempdir().unwrap();
        let program = bin_dir.path().join("fake-lsp.bin");
        std::fs::write(&program, b"").unwrap();
        let (_dir, root) = write_project(&program.to_string_lossy());
        let project = root.to_string_lossy().into_owned();

        // Old model opens at version 1 and advances to high client version 5 with discarded edits.
        assert_eq!(
            lsp.document(
                &project,
                &root,
                DocumentInput {
                    kind: "open".into(),
                    language_id: "scriptlang".into(),
                    rel_path: "a.script".into(),
                    content: "initial".into(),
                    version: 1,
                    attachment_id: Some("att-old".into()),
                },
            )
            .await
            .unwrap()["status"],
            "ready"
        );
        assert_eq!(
            lsp.document(
                &project,
                &root,
                DocumentInput {
                    kind: "change".into(),
                    language_id: "scriptlang".into(),
                    rel_path: "a.script".into(),
                    content: "discarded high-version text".into(),
                    version: 5,
                    attachment_id: Some("att-old".into()),
                },
            )
            .await
            .unwrap()["status"],
            "ready"
        );

        // Recreated Monaco model opens at client version 1 with fresh disk content before old close runs.
        assert_eq!(
            lsp.document(
                &project,
                &root,
                DocumentInput {
                    kind: "open".into(),
                    language_id: "scriptlang".into(),
                    rel_path: "a.script".into(),
                    content: "fresh reopened text".into(),
                    version: 1,
                    attachment_id: Some("att-new".into()),
                },
            )
            .await
            .unwrap()["status"],
            "ready"
        );

        // Deferred close from old attachment arrives afterwards.
        assert_eq!(
            lsp.document(
                &project,
                &root,
                DocumentInput {
                    kind: "close".into(),
                    language_id: "scriptlang".into(),
                    rel_path: "a.script".into(),
                    content: String::new(),
                    version: 5,
                    attachment_id: Some("att-old".into()),
                },
            )
            .await
            .unwrap()["status"],
            "ready"
        );

        mixdog_rt::time::sleep(Duration::from_millis(40)).await;
        let messages = pm.notification_messages.lock().unwrap().clone();
        let opens: Vec<&Value> = messages.iter().filter(|m| m["method"] == "textDocument/didOpen").collect();
        let changes: Vec<&Value> = messages.iter().filter(|m| m["method"] == "textDocument/didChange").collect();
        let closes: Vec<&Value> = messages.iter().filter(|m| m["method"] == "textDocument/didClose").collect();

        assert_eq!(opens.len(), 1);
        assert_eq!(opens[0]["params"]["textDocument"]["version"], json!(1));
        assert_eq!(opens[0]["params"]["textDocument"]["text"], json!("initial"));

        assert_eq!(changes.len(), 2, "reopening a recreated model at version 1 must emit didChange with fresh text");
        assert_eq!(changes[0]["params"]["textDocument"]["version"], json!(2));
        assert_eq!(changes[0]["params"]["contentChanges"][0]["text"], json!("discarded high-version text"));
        assert_eq!(changes[1]["params"]["textDocument"]["version"], json!(3));
        assert_eq!(changes[1]["params"]["contentChanges"][0]["text"], json!("fresh reopened text"));
        assert_eq!(closes.len(), 0, "deferred close of att-old must not close att-new");

        let session = lsp.state.lock().unwrap().sessions.values().next().unwrap().clone();
        assert_eq!(session.documents.lock().unwrap().values().next().unwrap().owners, HashSet::from(["att-new".to_owned()]));

        lsp.dispose().await;
    }
}
