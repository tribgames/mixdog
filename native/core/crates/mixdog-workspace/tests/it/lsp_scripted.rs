//! The language-server registry and a server's life, against a server the test scripts: which server a language gets, what a missing
//! one reports, the handshake, document events, requests, a method the server does not offer, diagnostics, and stopping.
//! The server is an in-memory process manager that answers the framed JSON-RPC the manager writes to its stdin.

use std::path::Path;
use std::sync::Arc;
use std::sync::Mutex;
use std::sync::atomic::AtomicU64;
use std::sync::atomic::Ordering;

use async_trait::async_trait;
use mixdog_core_api::domain::common::EventSource;
use mixdog_core_api::domain::process::CommandSpec;
use mixdog_core_api::domain::process::ExitStatus;
use mixdog_core_api::domain::process::KillReason;
use mixdog_core_api::domain::process::OutputStream;
use mixdog_core_api::domain::process::ProcessError;
use mixdog_core_api::domain::process::ProcessEvent;
use mixdog_core_api::domain::process::ProcessExit;
use mixdog_core_api::domain::process::ProcessInfo;
use mixdog_core_api::domain::process::ProcessManager;
use mixdog_core_api::domain::process::PtySize;
use mixdog_core_api::domain::process::SpawnRequest;
use mixdog_core_api::domain::process::SpawnedProcess;
use mixdog_protocol::ProcessHandle;
use mixdog_workspace::lsp::DocumentInput;
use mixdog_workspace::lsp::LspManager;
use mixdog_workspace::lsp::LspSink;
use mixdog_workspace::lsp::default_spec;
use mixdog_workspace::lsp::document_language_id;
use mixdog_workspace::lspwire::Framer;
use mixdog_workspace::lspwire::frame;
use serde_json::Value;
use serde_json::json;
use tokio::sync::mpsc;

struct Source(mpsc::UnboundedReceiver<ProcessEvent>);

#[async_trait]
impl EventSource<ProcessEvent> for Source {
    async fn next(&mut self) -> Option<ProcessEvent> {
        self.0.recv().await
    }
}

/// A process manager whose one child is a scripted language server.
#[derive(Default)]
struct Scripted {
    events: Mutex<Option<mpsc::UnboundedSender<ProcessEvent>>>,
    receiver: Mutex<Option<mpsc::UnboundedReceiver<ProcessEvent>>>,
    framer: Mutex<Framer>,
    /// Every message the manager wrote to the server, in order.
    received: Mutex<Vec<Value>>,
    /// `(program, args)` of each spawn.
    spawned: Mutex<Vec<(String, Vec<String>)>>,
    killed: Mutex<u32>,
    seq: AtomicU64,
}

impl Scripted {
    fn say(&self, message: &Value) {
        let seq = self.seq.fetch_add(1, Ordering::SeqCst);
        if let Some(tx) = self.events.lock().unwrap().as_ref() {
            let _ = tx.send(ProcessEvent::Output { seq, stream: OutputStream::Stdout, bytes: frame(message) });
        }
    }

    fn methods(&self) -> Vec<String> {
        self.received.lock().unwrap().iter().filter_map(|m| m["method"].as_str().map(str::to_owned)).collect()
    }

    fn message(&self, method: &str) -> Value {
        self.received.lock().unwrap().iter().find(|m| m["method"] == method).cloned().unwrap_or_else(|| panic!("the server was sent no {method}"))
    }

    /// A notification is written to the server by a task of its own, so it arrives after the call that queued it returns.
    async fn sent(&self, method: &str) -> Value {
        for _ in 0..500 {
            if let Some(found) = self.received.lock().unwrap().iter().find(|m| m["method"] == method).cloned() {
                return found;
            }
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        }
        panic!("the server was sent no {method}")
    }
}

#[async_trait]
impl ProcessManager for Scripted {
    async fn spawn(&self, request: SpawnRequest) -> Result<SpawnedProcess, ProcessError> {
        let CommandSpec::Argv { program, args } = &request.command else { panic!("a language server is started by argv") };
        self.spawned.lock().unwrap().push((program.clone(), args.clone()));
        let (tx, rx) = mpsc::unbounded_channel();
        *self.events.lock().unwrap() = Some(tx);
        *self.receiver.lock().unwrap() = Some(rx);
        Ok(SpawnedProcess { handle: request.handle, pid: 4242 })
    }

    fn subscribe_holding(&self, handle: &ProcessHandle, from_seq: Option<u64>) -> Result<Box<dyn EventSource<ProcessEvent>>, ProcessError> {
        self.subscribe(handle, from_seq)
    }
    fn subscribe(&self, _handle: &ProcessHandle, _from_seq: Option<u64>) -> Result<Box<dyn EventSource<ProcessEvent>>, ProcessError> {
        Ok(Box::new(Source(self.receiver.lock().unwrap().take().expect("subscribed once after a spawn"))))
    }

    async fn write_stdin(&self, _handle: &ProcessHandle, bytes: Vec<u8>) -> Result<(), ProcessError> {
        let messages = self.framer.lock().unwrap().push(&bytes);
        for message in messages {
            self.received.lock().unwrap().push(message.clone());
            let (Some(method), Some(id)) = (message["method"].as_str(), message.get("id")) else {
                if message["method"] == "textDocument/didOpen" {
                    let uri = message["params"]["textDocument"]["uri"].clone();
                    self.say(&json!({ "jsonrpc": "2.0", "method": "textDocument/publishDiagnostics", "params": { "uri": uri, "diagnostics": [{ "message": "scripted problem" }] } }));
                }
                continue;
            };
            let result = match method {
                "initialize" => json!({ "capabilities": { "hoverProvider": true, "completionProvider": { "triggerCharacters": ["."] } } }),
                "textDocument/hover" => json!({ "contents": "scripted hover" }),
                _ => Value::Null,
            };
            self.say(&json!({ "jsonrpc": "2.0", "id": id, "result": result }));
        }
        Ok(())
    }

    fn close_stdin(&self, _handle: &ProcessHandle) -> Result<(), ProcessError> {
        Ok(())
    }

    fn resize_pty(&self, _handle: &ProcessHandle, _size: PtySize) -> Result<(), ProcessError> {
        Err(ProcessError::NotPty)
    }

    fn kill(&self, _handle: &ProcessHandle) -> Result<(), ProcessError> {
        *self.killed.lock().unwrap() += 1;
        let seq = self.seq.fetch_add(1, Ordering::SeqCst);
        if let Some(tx) = self.events.lock().unwrap().take() {
            let _ = tx.send(ProcessEvent::Exited { seq, exit: ProcessExit { status: ExitStatus::Signal(9), killed: Some(KillReason::Requested) } });
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
}

impl LspSink for Sink {
    fn status(&self, event: Value) {
        self.statuses.lock().unwrap().push(event);
    }
    fn diagnostics(&self, event: Value) {
        self.diagnostics.lock().unwrap().push(event);
    }
}

impl Sink {
    fn states(&self) -> Vec<String> {
        self.statuses.lock().unwrap().iter().map(|e| e["status"].as_str().unwrap().to_owned()).collect()
    }
}

fn manager(pm: &Arc<Scripted>, sink: &Arc<Sink>) -> Arc<LspManager> {
    LspManager::new(pm.clone(), sink.clone(), mixdog_rt::testing::tokens().maintenance_io)
}

/// A project that configures `scriptlang` to be served by `command`.
fn project(command: &str) -> (tempfile::TempDir, std::path::PathBuf) {
    let dir = tempfile::tempdir().unwrap();
    let root = mixdog_workspace::pathguard::canonical(dir.path()).unwrap();
    std::fs::create_dir_all(root.join(".mixdog")).unwrap();
    let config = json!({ "servers": { "scripted": { "command": command, "languages": ["scriptlang"], "name": "Scripted" } } });
    std::fs::write(root.join(".mixdog").join("lsp.json"), config.to_string()).unwrap();
    (dir, root)
}

fn open(rel: &str, content: &str, version: i64) -> DocumentInput {
    DocumentInput { kind: "open".into(), language_id: "scriptlang".into(), rel_path: rel.into(), content: content.into(), version }
}

/// Which server a language gets, and what the editor tells the server a document's language is.
#[test]
fn each_language_has_its_server_and_jsx_documents_their_own_wire_language() {
    let spec = |language: &str| default_spec(language).map(|s| (s.id, s.command, s.args));
    let ts = Some(("typescript-language-server".to_owned(), "typescript-language-server".to_owned(), vec!["--stdio".to_owned()]));
    assert_eq!(spec("typescript"), ts);
    assert_eq!(spec("javascript"), ts);
    assert_eq!(spec("python"), Some(("pyright".into(), "pyright-langserver".into(), vec!["--stdio".into()])));
    assert_eq!(spec("go"), Some(("gopls".into(), "gopls".into(), vec![])));
    assert_eq!(spec("rust"), Some(("rust-analyzer".into(), "rust-analyzer".into(), vec![])));
    for language in ["c", "cpp", "objective-c"] {
        assert_eq!(spec(language), Some(("clangd".into(), "clangd".into(), vec!["--background-index".into()])), "{language}");
    }
    assert_eq!(spec("ruby"), Some(("ruby-lsp".into(), "ruby-lsp".into(), vec![])));
    assert_eq!(spec("cobol"), None);
    assert_eq!(mixdog_workspace::lsp::DEFAULT_LANGUAGES.len(), 9);
    assert_eq!(document_language_id("a.tsx", "typescript"), "typescriptreact");
    assert_eq!(document_language_id("a.jsx", "javascript"), "javascriptreact");
    assert_eq!(document_language_id("a.ts", "typescript"), "typescript");
    assert_eq!(document_language_id("Dockerfile", "plaintext"), "plaintext");
}

/// A language nobody serves is `unsupported` and nothing is started; a configured server whose program is not there is `missing`
/// (after `starting`), and is not tried again at once.
#[tokio::test(flavor = "multi_thread")]
async fn an_unserved_language_is_unsupported_and_a_missing_server_is_reported_once() {
    let pm = Arc::new(Scripted::default());
    let sink = Arc::new(Sink::default());
    let lsp = manager(&pm, &sink);
    let (_dir, root) = project("mixdog-no-such-language-server-program");
    let project_path = root.to_string_lossy().into_owned();

    let unsupported = lsp.document(&project_path, &root, DocumentInput { language_id: "cobol".into(), ..open("a.cob", "", 1) }).await.unwrap();
    assert_eq!((unsupported["status"].clone(), unsupported["available"].clone()), (json!("unsupported"), json!(false)));
    assert!(pm.spawned.lock().unwrap().is_empty());

    let missing = lsp.document(&project_path, &root, open("a.script", "x", 1)).await.unwrap();
    assert_eq!((missing["status"].clone(), missing["server"].clone()), (json!("missing"), json!("Scripted")));
    assert_eq!(sink.states(), ["starting", "missing"]);
    lsp.document(&project_path, &root, open("a.script", "x", 2)).await.unwrap();
    assert_eq!(sink.states(), ["starting", "missing"], "a server found missing is not looked for again at once");
    assert!(pm.spawned.lock().unwrap().is_empty());

    let answer = lsp.request(&project_path, &root, "a.script", "scriptlang", "textDocument/hover", &json!({})).await.unwrap();
    assert_eq!((answer["available"].clone(), answer["status"].clone()), (json!(false), json!("missing")));
}

struct Started {
    pm: Arc<Scripted>,
    sink: Arc<Sink>,
    lsp: Arc<LspManager>,
    root: std::path::PathBuf,
    project_path: String,
    program: std::path::PathBuf,
    state: Value,
    /// A test that calls the manager again binds this: left to `..`, the folders and the project's `lsp.json` are deleted at once.
    _dirs: (tempfile::TempDir, tempfile::TempDir),
}

async fn started_server() -> Started {
    let pm = Arc::new(Scripted::default());
    let sink = Arc::new(Sink::default());
    let lsp = manager(&pm, &sink);
    let dir = tempfile::tempdir().unwrap();
    let program = dir.path().join("scripted-server.bin");
    std::fs::write(&program, b"").unwrap();
    let (project_dir, root) = project(&program.to_string_lossy());
    let project_path = root.to_string_lossy().into_owned();
    let state = lsp.document(&project_path, &root, open("src/a.script", "let a", 1)).await.unwrap();
    Started { pm, sink, lsp, root, project_path, program, state, _dirs: (dir, project_dir) }
}

async fn first_diagnostics(sink: &Sink) -> Value {
    for _ in 0..200 {
        if !sink.diagnostics.lock().unwrap().is_empty() {
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(10)).await;
    }
    sink.diagnostics.lock().unwrap()[0].clone()
}

#[tokio::test(flavor = "multi_thread")]
async fn a_first_document_starts_the_server_and_reports_the_capabilities_it_announced() {
    let Started { pm, sink, program, state, .. } = started_server().await;
    assert_eq!((state["status"].clone(), state["available"].clone(), state["server"].clone()), (json!("ready"), json!(true), json!("Scripted")));
    assert_eq!(
        (state["capabilities"]["hover"].clone(), state["capabilities"]["completion"].clone(), state["capabilities"]["rename"].clone()),
        (json!(true), json!(true), json!(false))
    );
    assert_eq!(state["capabilities"]["completionTriggerCharacters"], json!(["."]));
    assert_eq!(sink.states(), ["starting", "ready"]);
    assert_eq!(pm.spawned.lock().unwrap().len(), 1);
    assert_eq!(pm.spawned.lock().unwrap()[0].0, program.to_string_lossy());
}

#[tokio::test(flavor = "multi_thread")]
async fn the_handshake_names_the_project_folder_and_did_open_carries_the_documents_text() {
    let Started { pm, root, .. } = started_server().await;
    let initialize = pm.message("initialize");
    assert_eq!(initialize["params"]["rootPath"], root.to_string_lossy().as_ref());
    assert_eq!(initialize["params"]["workspaceFolders"][0]["name"], root.file_name().unwrap().to_string_lossy().as_ref());
    let opened = pm.sent("textDocument/didOpen").await;
    assert_eq!(
        (
            opened["params"]["textDocument"]["languageId"].clone(),
            opened["params"]["textDocument"]["text"].clone(),
            opened["params"]["textDocument"]["version"].clone()
        ),
        (json!("scriptlang"), json!("let a"), json!(1))
    );
    assert_eq!(pm.methods()[..3], ["initialize", "initialized", "textDocument/didOpen"]);
}

#[tokio::test(flavor = "multi_thread")]
async fn the_servers_diagnostics_reach_the_sink_under_the_relative_path() {
    let Started { sink, .. } = started_server().await;
    let first = first_diagnostics(&sink).await;
    assert_eq!(
        (first["relPath"].clone(), first["server"].clone(), first["diagnostics"][0]["message"].clone()),
        (json!("src/a.script"), json!("Scripted"), json!("scripted problem"))
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn a_second_event_of_an_open_document_is_a_change_and_does_not_start_the_server_again() {
    let Started { pm, lsp, root, project_path, _dirs, .. } = started_server().await;
    lsp.document(&project_path, &root, DocumentInput { kind: "change".into(), ..open("src/a.script", "let ab", 2) }).await.unwrap();
    let change = pm.sent("textDocument/didChange").await;
    assert_eq!((change["params"]["textDocument"]["version"].clone(), change["params"]["contentChanges"][0]["text"].clone()), (json!(2), json!("let ab")));
    assert_eq!(pm.spawned.lock().unwrap().len(), 1);
}

#[tokio::test(flavor = "multi_thread")]
async fn a_supported_request_is_the_servers_answer_and_an_unoffered_method_is_not_asked() {
    let Started { pm, lsp, root, project_path, _dirs, .. } = started_server().await;
    let hover = lsp
        .request(&project_path, &root, "src/a.script", "scriptlang", "textDocument/hover", &json!({ "position": { "line": 0, "character": 1 } }))
        .await
        .unwrap();
    assert_eq!((hover["status"].clone(), hover["result"]["contents"].clone()), (json!("ready"), json!("scripted hover")));
    let hover_wire = pm.message("textDocument/hover");
    assert_eq!(hover_wire["params"]["position"], json!({ "line": 0, "character": 1 }));
    let rename = lsp.request(&project_path, &root, "src/a.script", "scriptlang", "textDocument/rename", &json!({})).await.unwrap();
    assert_eq!((rename["status"].clone(), rename["detail"].clone()), (json!("ready"), json!("Scripted does not support textDocument/rename.")));
    assert!(!pm.methods().contains(&"textDocument/rename".to_owned()));
}

#[tokio::test(flavor = "multi_thread")]
async fn a_document_path_out_of_the_project_is_refused() {
    let Started { lsp, root, project_path, _dirs, .. } = started_server().await;
    assert!(lsp.document(&project_path, &root, open("../outside.script", "x", 1)).await.is_err());
}

#[tokio::test(flavor = "multi_thread")]
async fn closing_a_document_clears_its_diagnostics_and_stopping_the_project_ends_the_server() {
    let Started { pm, sink, lsp, root, project_path, _dirs, .. } = started_server().await;
    first_diagnostics(&sink).await;
    lsp.document(&project_path, &root, DocumentInput { kind: "close".into(), ..open("src/a.script", "", 3) }).await.unwrap();
    pm.sent("textDocument/didClose").await;
    assert_eq!(sink.diagnostics.lock().unwrap().last().unwrap()["diagnostics"], json!([]));
    assert_eq!(lsp.live_roots(), [root.clone()]);
    assert_eq!(lsp.dispose_under(&root).await, [root.to_string_lossy().into_owned()]);
    assert!(lsp.live_roots().is_empty());
    assert!(pm.methods().contains(&"shutdown".to_owned()));
    assert_eq!(*pm.killed.lock().unwrap(), 1);
    assert!(lsp.dispose_under(Path::new(&root)).await.is_empty());
}
