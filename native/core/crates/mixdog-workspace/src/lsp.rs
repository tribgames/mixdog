//! Language servers (DS §4.6; port of `language-server-*.ts`): one server per
//! (project root, server id), started on demand through the `ProcessManager`,
//! spoken to over stdio JSON-RPC. The editor sends document events and
//! requests; the manager owns lifecycle (idle stop, crash → `stopped` with a
//! backoff, restart on the next document), dynamic capability registrations and
//! diagnostics. Status and diagnostics are pushed through an [`LspSink`].

use std::collections::HashMap;
use std::collections::HashSet;
use std::path::Path;
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::Mutex;
use std::sync::atomic::AtomicBool;
use std::sync::atomic::AtomicI64;
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
    Spec {
        id: id.into(),
        name: name.into(),
        command: command.into(),
        args: args.iter().map(|a| (*a).into()).collect(),
        project_candidates: Vec::new(),
    }
}

/// `SERVER_BY_LANGUAGE`.
pub fn default_spec(language: &str) -> Option<Spec> {
    let ts = || spec("typescript-language-server", "TypeScript Language Server", "typescript-language-server", &["--stdio"]);
    let clangd = || spec("clangd", "clangd", "clangd", &["--background-index"]);
    Some(match language {
        "typescript" | "javascript" => ts(),
        "python" => Spec {
            project_candidates: vec![PathBuf::from("node_modules")
                .join(".bin")
                .join(if cfg!(windows) { "pyright-langserver.cmd" } else { "pyright-langserver" })],
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
    let text = |v: Option<&Value>, name: &str, max: usize| -> WsResult<String> {
        match v.and_then(Value::as_str) {
            Some(s) if !s.trim().is_empty() && s.len() <= max && !s.contains('\0') => Ok(s.trim().to_owned()),
            _ => Err(WsError::invalid(format!("{name} is invalid."))),
        }
    };
    let list = |v: Option<&Value>, name: &str, max: usize, len: usize| -> WsResult<Vec<String>> {
        match v.and_then(Value::as_array) {
            Some(a) if !a.is_empty() && a.len() <= max => {
                a.iter().enumerate().map(|(i, e)| text(Some(e), &format!("{name}[{i}]"), len)).collect()
            }
            _ => Err(WsError::invalid(format!("{name} is invalid."))),
        }
    };
    let mut by_language = HashMap::new();
    for (index, row) in rows.iter().enumerate() {
        let Some(server) = row.as_object() else { return Err(WsError::invalid(format!("LSP server {index} is invalid."))) };
        let id = text(server.get("id"), &format!("LSP server {index} id"), 128)?;
        if !id.chars().all(|c| c.is_ascii_alphanumeric() || "._-".contains(c)) {
            return Err(WsError::invalid(format!("LSP server {index} id is invalid.")));
        }
        let command = text(server.get("command"), &format!("LSP server {id} command"), 4096)?;
        let languages: Vec<String> =
            list(server.get("languages"), &format!("LSP server {id} languages"), 32, 128)?.into_iter().map(|l| l.to_lowercase()).collect();
        let args = if server.get("args").is_none() { Vec::new() } else { list(server.get("args"), &format!("LSP server {id} args"), 64, 4096)? };
        let candidates =
            if server.get("candidates").is_none() { Vec::new() } else { list(server.get("candidates"), &format!("LSP server {id} candidates"), 32, 4096)? };
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
        let name = if server.get("name").is_some() { text(server.get("name"), &format!("LSP server {id} name"), 128)? } else { id.clone() };
        let built = Spec { id: id.clone(), name, command, args, project_candidates: resolved };
        for language in languages {
            if !language.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || "_+.-".contains(c)) {
                return Err(WsError::invalid(format!("LSP server {id} language is invalid.")));
            }
            if by_language.insert(language.clone(), built.clone()).is_some() {
                return Err(WsError::invalid(format!("LSP language {language} is configured more than once.")));
            }
        }
    }
    Ok(by_language)
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
    let mut candidates: Vec<PathBuf> = spec
        .project_candidates
        .iter()
        .map(|c| if c.is_absolute() { c.clone() } else { root.join(c) })
        .flat_map(variants)
        .collect();
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
    std::env::split_paths(&std::env::var_os("PATH").unwrap_or_default()).find_map(|dir| {
        extensions.iter().map(|e| dir.join(format!("{command}{e}"))).find(|c| executable(c))
    })
}

/// Receives what the servers say; called from reader tasks, it must not block.
pub trait LspSink: Send + Sync + 'static {
    fn status(&self, event: Value);
    fn diagnostics(&self, event: Value);
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

struct DocInfo {
    language_id: String,
    rel_path: String,
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
        let _ = self.out.send(frame(&json!({ "jsonrpc": "2.0", "id": id, "method": method, "params": params })));
        match tokio::time::timeout(timeout, rx).await {
            Ok(Ok(result)) => result,
            Ok(Err(_)) => Err("The language server connection closed.".into()),
            Err(_) => {
                self.pending.lock().expect("lsp pending").remove(&id);
                Err(timeout_message.into())
            }
        }
    }

    fn fail_all(&self) {
        for (_, tx) in self.pending.lock().expect("lsp pending").drain() {
            let _ = tx.send(Err("The language server connection closed.".into()));
        }
    }
}

struct Session {
    key: String,
    project_path: String,
    root: PathBuf,
    spec: Spec,
    handle: ProcessHandle,
    conn: Arc<Conn>,
    base_caps: Mutex<Value>,
    registrations: Mutex<HashMap<String, (String, Value)>>,
    language_ids: Mutex<HashSet<String>>,
    documents: Mutex<HashMap<String, DocInfo>>,
    closing: AtomicBool,
    ready: AtomicBool,
    idle_generation: AtomicU64,
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
}

/// An editor document event (`lsp/document`).
#[derive(Clone, Debug)]
pub struct DocumentInput {
    pub kind: String,
    pub language_id: String,
    pub rel_path: String,
    pub content: String,
    pub version: i64,
}

impl DocumentInput {
    pub fn from_value(value: &Value) -> WsResult<Self> {
        let text = |k: &str| value.get(k).and_then(Value::as_str).map(str::to_owned);
        let kind = text("kind").filter(|k| matches!(k.as_str(), "open" | "change" | "save" | "close")).ok_or_else(|| WsError::invalid("document.kind is invalid."))?;
        Ok(Self {
            kind,
            language_id: text("languageId").ok_or_else(|| WsError::invalid("document.languageId is invalid."))?,
            rel_path: text("relPath").ok_or_else(|| WsError::invalid("document.relPath is invalid."))?,
            content: text("content").unwrap_or_default(),
            version: value.get("version").and_then(Value::as_i64).unwrap_or(0),
        })
    }
}

#[derive(Default)]
struct Health {
    missing_until: HashMap<String, Instant>,
    failures: HashMap<String, (u32, Instant)>,
}

pub struct LspManager {
    pm: Arc<dyn ProcessManager>,
    lane: mixdog_rt::MaintenanceIo,
    sink: Arc<dyn LspSink>,
    sessions: Mutex<HashMap<String, Arc<Session>>>,
    /// Single flight per key: a start in progress, and whoever waits for it.
    starting: Mutex<HashMap<String, tokio::sync::watch::Receiver<()>>>,
    health: Mutex<Health>,
    states: Mutex<HashMap<String, Value>>,
    next_handle: AtomicU64,
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
            sessions: Mutex::default(),
            starting: Mutex::default(),
            health: Mutex::default(),
            states: Mutex::default(),
            next_handle: AtomicU64::new(1),
        })
    }

    async fn spec_for(&self, root: &Path, language_id: &str) -> WsResult<Option<Spec>> {
        let (root, language) = (root.to_path_buf(), language_id.to_lowercase());
        crate::lanes::run_fallible(self.lane, &tokio_util::sync::CancellationToken::new(), move || {
            let mut project = project_specs(&root)?;
            Ok(project.remove(&language).or_else(|| default_spec(&language)))
        })
        .await
    }

    fn emit_status(
        &self,
        project_path: &str,
        root: &Path,
        language_id: &str,
        spec: Option<&Spec>,
        status: &str,
        detail: Option<&str>,
        caps: Option<&Value>,
        rel_path: Option<&str>,
    ) -> Value {
        let state = public_state(spec, status, detail, caps);
        if let Some(spec) = spec {
            self.states.lock().expect("lsp states").insert(session_key(root, spec), state.clone());
        }
        let mut event = json!({ "projectPath": project_path, "languageId": language_id });
        if let Some(rel) = rel_path {
            event["relPath"] = json!(rel);
        }
        if let (Some(e), Some(s)) = (event.as_object_mut(), state.as_object()) {
            e.extend(s.clone());
        }
        self.sink.status(event);
        state
    }

    fn refresh_capabilities(&self, session: &Session) {
        let docs: Vec<(String, String, String)> = session
            .documents
            .lock()
            .expect("lsp documents")
            .iter()
            .map(|(uri, d)| (uri.clone(), d.language_id.clone(), d.rel_path.clone()))
            .collect();
        let mut emitted = HashSet::new();
        for (uri, language, rel) in docs {
            let caps = session.capabilities(&language, Some(&uri));
            emitted.insert(language.clone());
            self.emit_status(&session.project_path, &session.root, &language, Some(&session.spec), "ready", None, Some(&caps), Some(&rel));
        }
        let languages: Vec<String> = session.language_ids.lock().expect("lsp languages").iter().cloned().collect();
        for language in languages.into_iter().filter(|l| !emitted.contains(l)) {
            let caps = session.capabilities(&language, None);
            self.emit_status(&session.project_path, &session.root, &language, Some(&session.spec), "ready", None, Some(&caps), None);
        }
    }

    fn record_failure(&self, key: &str) -> u64 {
        let mut health = self.health.lock().expect("lsp health");
        let count = (health.failures.get(key).map_or(0, |f| f.0) + 1).min(6);
        let delay = (1000u64 << (count - 1)).min(30_000);
        health.failures.insert(key.to_owned(), (count, Instant::now() + Duration::from_millis(delay)));
        delay
    }

    fn stopped(&self, session: &Session, language_id: &str) {
        self.sessions.lock().expect("lsp sessions").remove(&session.key);
        let delay = self.record_failure(&session.key);
        let tail = session.stderr.lock().expect("lsp stderr").trim().lines().last().map(|l| l.chars().take(200).collect::<String>());
        let detail = [tail, Some(format!("Retrying after {}s.", delay.div_ceil(1000)))].into_iter().flatten().collect::<Vec<_>>().join(" ");
        self.emit_status(&session.project_path, &session.root, language_id, Some(&session.spec), "stopped", Some(&detail), None, None);
    }

    /// A live session of the key, or a started one; `None` when the server is
    /// missing, cooling down, or failed to start (its status was emitted).
    async fn ensure(self: &Arc<Self>, project_path: &str, root: &Path, language_id: &str, spec: &Spec) -> Option<Arc<Session>> {
        let key = session_key(root, spec);
        let (mine, receiver) = tokio::sync::watch::channel(());
        loop {
            if let Some(live) = self.sessions.lock().expect("lsp sessions").get(&key).cloned().filter(|s| !s.closing.load(Ordering::SeqCst)) {
                live.idle_generation.fetch_add(1, Ordering::SeqCst);
                return Some(live);
            }
            let pending = {
                let mut starting = self.starting.lock().expect("lsp starting");
                match starting.get(&key).cloned() {
                    Some(other) => Some(other),
                    None => {
                        starting.insert(key.clone(), receiver.clone());
                        None
                    }
                }
            };
            match pending {
                // The starter never sends: `changed` fails exactly when it is dropped.
                Some(mut other) => while other.changed().await.is_ok() {},
                None => break,
            }
        }
        let health_blocks = {
            let health = self.health.lock().expect("lsp health");
            health.missing_until.get(&key).is_some_and(|t| *t > Instant::now()) || health.failures.get(&key).is_some_and(|f| f.1 > Instant::now())
        };
        let started = if health_blocks { None } else { self.start(project_path, root, language_id, spec, key.clone()).await };
        self.starting.lock().expect("lsp starting").remove(&key);
        drop(mine);
        started
    }

    async fn start(self: &Arc<Self>, project_path: &str, root: &Path, language_id: &str, spec: &Spec, key: String) -> Option<Arc<Session>> {
        self.emit_status(project_path, root, language_id, Some(spec), "starting", None, None, None);
        let (probe_spec, probe_root) = (spec.clone(), root.to_path_buf());
        let found = crate::lanes::run(self.lane, &tokio_util::sync::CancellationToken::new(), move || resolve_executable(&probe_spec, &probe_root)).await.ok().flatten();
        let Some(executable) = found else {
            self.health.lock().expect("lsp health").missing_until.insert(key, Instant::now() + Duration::from_secs(30));
            self.emit_status(project_path, root, language_id, Some(spec), "missing", None, None, None);
            return None;
        };
        let handle = ProcessHandle::from(format!("lsp-{}-{}", std::process::id(), self.next_handle.fetch_add(1, Ordering::SeqCst)).as_str());
        let Some(cwd) = AbsPath::new(root.to_path_buf()) else { return None };
        let request = SpawnRequest {
            handle: handle.clone(),
            command: CommandSpec::Argv { program: executable.to_string_lossy().into_owned(), args: spec.args.clone() },
            cwd,
            env: EnvSpec { inherit: true, set: Vec::new(), remove: Vec::new() },
            pty: None,
            stdin_piped: true,
            output: OutputMode::Separate,
            owner: ProcessOwner::Lsp { root: AbsPath::new(root.to_path_buf())?, language: language_id.to_owned() },
            time_limit: None,
        };
        let (out_tx, mut out_rx) = mpsc::unbounded_channel::<Vec<u8>>();
        let conn = Arc::new(Conn { out: out_tx, next_id: AtomicI64::new(1), pending: Mutex::default() });
        let session = Arc::new(Session {
            key: key.clone(),
            project_path: project_path.to_owned(),
            root: root.to_path_buf(),
            spec: spec.clone(),
            handle: handle.clone(),
            conn: conn.clone(),
            base_caps: Mutex::new(json!({})),
            registrations: Mutex::default(),
            language_ids: Mutex::new(HashSet::from([language_id.to_owned()])),
            documents: Mutex::default(),
            closing: AtomicBool::new(false),
            ready: AtomicBool::new(false),
            idle_generation: AtomicU64::new(0),
            stderr: Mutex::default(),
        });
        let events = match self.pm.spawn(request).await.and_then(|_| self.pm.subscribe(&handle, None)) {
            Ok(events) => events,
            Err(error) => {
                self.fail_start(&session, language_id, &format!("{} could not be started: {error:?}", spec.name)).await;
                return None;
            }
        };
        // Writer: one task keeps frames in order.
        let pm = self.pm.clone();
        let writer_handle = handle.clone();
        tokio::spawn(async move {
            while let Some(bytes) = out_rx.recv().await {
                if pm.write_stdin(&writer_handle, bytes).await.is_err() {
                    break;
                }
            }
        });
        // Reader: dispatches everything the server sends, from before `initialize`.
        let this = self.clone();
        let reader_session = session.clone();
        let reader_language = language_id.to_owned();
        tokio::spawn(async move {
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
            if reader_session.ready.load(Ordering::SeqCst) && !reader_session.closing.load(Ordering::SeqCst) {
                this.stopped(&reader_session, &reader_language);
            }
        });
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
        let message = format!("{} did not finish initializing.", spec.name);
        match conn.request("initialize", params, INITIALIZE_TIMEOUT, &message).await {
            Ok(initialization) => {
                let caps = lspcaps::normalize(&initialization);
                *session.base_caps.lock().expect("lsp caps") = caps.clone();
                self.sessions.lock().expect("lsp sessions").insert(key.clone(), session.clone());
                self.health.lock().expect("lsp health").failures.remove(&key);
                session.ready.store(true, Ordering::SeqCst);
                conn.notify("initialized", json!({}));
                self.emit_status(project_path, root, language_id, Some(spec), "ready", None, Some(&caps), None);
                Some(session)
            }
            Err(error) => {
                self.fail_start(&session, language_id, &error).await;
                None
            }
        }
    }

    /// A handshake that never completed: end the process, report why with the retry delay.
    async fn fail_start(&self, session: &Session, language_id: &str, error: &str) {
        session.closing.store(true, Ordering::SeqCst);
        let _ = self.pm.kill(&session.handle);
        let delay = self.record_failure(&session.key);
        let tail = session.stderr.lock().expect("lsp stderr").trim().lines().last().map(|l| l.chars().take(500).collect::<String>());
        let detail = [Some(error.to_owned()), tail, Some(format!("Retrying after {}s.", delay.div_ceil(1000)))].into_iter().flatten().collect::<Vec<_>>().join(" ");
        self.emit_status(&session.project_path, &session.root, language_id, Some(&session.spec), "error", Some(&detail), None, None);
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
                if !session.ready.load(Ordering::SeqCst) {
                    return;
                }
                let params = message.get("params").cloned().unwrap_or(Value::Null);
                let uri = params.get("uri").and_then(Value::as_str).unwrap_or_default();
                let Some(rel) = relative_document_path(&session.root, uri) else { return };
                let diagnostics: Vec<Value> = params.get("diagnostics").and_then(Value::as_array).map(|a| a.iter().take(2000).cloned().collect()).unwrap_or_default();
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
                if changed && session.ready.load(Ordering::SeqCst) {
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
                if changed && session.ready.load(Ordering::SeqCst) {
                    self.refresh_capabilities(session);
                }
            }
            "workspace/applyEdit" => conn.respond(id, json!({ "applied": false, "failureReason": "Server-initiated edits require an explicit editor action." })),
            _ => conn.respond(id, Value::Null),
        }
    }

    fn schedule_idle(self: &Arc<Self>, session: &Arc<Session>) {
        if !session.documents.lock().expect("lsp documents").is_empty() || session.closing.load(Ordering::SeqCst) {
            return;
        }
        let generation = session.idle_generation.fetch_add(1, Ordering::SeqCst) + 1;
        let (this, session) = (self.clone(), session.clone());
        tokio::spawn(async move {
            tokio::time::sleep(IDLE).await;
            if session.idle_generation.load(Ordering::SeqCst) == generation {
                this.stop(&session).await;
            }
        });
    }

    async fn stop(&self, session: &Arc<Session>) {
        if session.closing.swap(true, Ordering::SeqCst) {
            return;
        }
        session.idle_generation.fetch_add(1, Ordering::SeqCst);
        self.sessions.lock().expect("lsp sessions").remove(&session.key);
        if session.conn.request("shutdown", Value::Null, Duration::from_secs(1), "shutdown timeout").await.is_ok() {
            session.conn.notify("exit", Value::Null);
        }
        let _ = self.pm.kill(&session.handle);
    }

    /// Editor document events (`lsp/document`).
    pub async fn document(self: &Arc<Self>, project_path: &str, root: &Path, input: DocumentInput) -> Value {
        let spec = match self.spec_for(root, &input.language_id).await {
            Ok(Some(spec)) => spec,
            Ok(None) => return public_state(None, "unsupported", None, None),
            Err(error) => return self.emit_status(project_path, root, &input.language_id, None, "error", Some(&error.message), None, None),
        };
        let uri = match project_entry_path(root, &input.rel_path) {
            Ok(p) => file_uri(&p),
            Err(error) => return self.emit_status(project_path, root, &input.language_id, Some(&spec), "error", Some(&error.message), None, None),
        };
        let key = session_key(root, &spec);
        // A late cleanup must never start a server merely to close a document.
        let session = if input.kind == "close" {
            self.sessions.lock().expect("lsp sessions").get(&key).cloned()
        } else {
            self.ensure(project_path, root, &input.language_id, &spec).await
        };
        let Some(session) = session else {
            let fallback = public_state(Some(&spec), if input.kind == "close" { "stopped" } else { "missing" }, None, None);
            return self.states.lock().expect("lsp states").get(&key).cloned().unwrap_or(fallback);
        };
        session.language_ids.lock().expect("lsp languages").insert(input.language_id.clone());
        let known = session.documents.lock().expect("lsp documents").contains_key(&uri);
        let caps = || session.capabilities(&input.language_id, Some(&uri));
        if input.kind == "close" {
            if known {
                session.conn.notify("textDocument/didClose", json!({ "textDocument": { "uri": uri } }));
                session.documents.lock().expect("lsp documents").remove(&uri);
                self.sink.diagnostics(json!({
                    "projectPath": project_path, "relPath": input.rel_path, "uri": uri,
                    "server": spec.name, "diagnostics": [],
                }));
            }
            self.schedule_idle(&session);
            return public_state(Some(&spec), "ready", None, Some(&caps()));
        }
        let doc = DocInfo { language_id: input.language_id.clone(), rel_path: input.rel_path.clone() };
        if !known {
            // A restarted server lost its documents; any event on an unopened one becomes didOpen.
            session.conn.notify(
                "textDocument/didOpen",
                json!({ "textDocument": {
                    "uri": uri, "languageId": document_language_id(&input.rel_path, &input.language_id),
                    "version": input.version, "text": input.content,
                } }),
            );
            session.documents.lock().expect("lsp documents").insert(uri.clone(), doc);
        } else if input.kind == "save" {
            session.conn.notify("textDocument/didSave", json!({ "textDocument": { "uri": uri }, "text": input.content }));
        } else {
            session.conn.notify(
                "textDocument/didChange",
                json!({ "textDocument": { "uri": uri, "version": input.version }, "contentChanges": [{ "text": input.content }] }),
            );
            session.documents.lock().expect("lsp documents").insert(uri.clone(), doc);
        }
        public_state(Some(&spec), "ready", None, Some(&caps()))
    }

    /// A language-server request (`lsp/request`).
    pub async fn request(self: &Arc<Self>, project_path: &str, root: &Path, rel_path: &str, language_id: &str, method: &str, params: &Value) -> Value {
        let spec = match self.spec_for(root, language_id).await {
            Ok(Some(spec)) => spec,
            Ok(None) => return json!({ "available": false, "status": "unsupported", "server": "" }),
            Err(error) => return json!({ "available": false, "status": "error", "server": "", "detail": error.message }),
        };
        let Some(session) = self.ensure(project_path, root, language_id, &spec).await else {
            let state = self
                .states
                .lock()
                .expect("lsp states")
                .get(&session_key(root, &spec))
                .cloned()
                .unwrap_or_else(|| public_state(Some(&spec), "missing", None, None));
            let mut out = json!({ "available": false, "status": state["status"], "server": state["server"] });
            if let Some(detail) = state.get("detail") {
                out["detail"] = detail.clone();
            }
            return out;
        };
        let reply = async {
            let uri = match project_entry_path(root, rel_path) {
                Ok(p) => file_uri(&p),
                Err(error) => return json!({ "available": true, "status": "error", "server": spec.name, "detail": error.message }),
            };
            let caps = session.capabilities(language_id, Some(&uri));
            if !lspcaps::method_supported(method, &caps) {
                return public_state(Some(&spec), "ready", Some(&format!("{} does not support {method}.", spec.name)), Some(&caps));
            }
            let mut wire = params.as_object().cloned().unwrap_or_default();
            if method.starts_with("textDocument/") {
                wire.insert("textDocument".into(), json!({ "uri": uri }));
            }
            let timeout = format!("{} request timed out.", spec.name);
            match session.conn.request(method, Value::Object(wire), REQUEST_TIMEOUT, &timeout).await {
                Ok(result) => json!({ "available": true, "status": "ready", "server": spec.name, "capabilities": caps, "result": result }),
                Err(detail) => json!({ "available": true, "status": "error", "server": spec.name, "capabilities": caps, "detail": detail }),
            }
        }
        .await;
        self.schedule_idle(&session);
        reply
    }

    /// Stops the servers rooted in `root` (a worktree being removed); returns their roots.
    pub async fn dispose_under(&self, root: &Path) -> Vec<String> {
        let doomed: Vec<Arc<Session>> = self
            .sessions
            .lock()
            .expect("lsp sessions")
            .values()
            .filter(|s| is_within(root, &s.root))
            .cloned()
            .collect();
        for session in &doomed {
            self.stop(session).await;
        }
        doomed.iter().map(|s| s.root.to_string_lossy().into_owned()).collect()
    }

    pub async fn dispose(&self) {
        let all: Vec<Arc<Session>> = self.sessions.lock().expect("lsp sessions").values().cloned().collect();
        for session in &all {
            self.stop(session).await;
        }
        self.sessions.lock().expect("lsp sessions").clear();
    }

    /// Test seam: the live roots.
    pub fn live_roots(&self) -> Vec<PathBuf> {
        self.sessions.lock().expect("lsp sessions").values().map(|s| s.root.clone()).collect()
    }
}
