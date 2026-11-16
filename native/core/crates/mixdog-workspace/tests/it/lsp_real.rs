#![allow(clippy::disallowed_types, reason = "test setup")]
#![allow(clippy::disallowed_methods, reason = "test setup")]
//! DS-WS-8: a real language server (typescript-language-server) driven through
//! `LspManager` reproduces the facts recorded from today's Node
//! `LanguageServerManager` (`fixtures/desktop/lsp/typescript-real.json`):
//! capabilities after open, settled diagnostics after each step, the
//! unsupported-method answer, `stopped` after a server crash, restart on the next
//! document, and `disposeUnder`. Skipped (loudly) when the server is not installed.

use std::collections::HashMap;
use std::path::Path;
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::Mutex;
use std::time::Duration;
use std::time::Instant;

use mixdog_workspace::lsp::DocumentInput;
use mixdog_workspace::lsp::LspManager;
use mixdog_workspace::lsp::LspSink;
use serde_json::Value;
use serde_json::json;

// Test-only observation: forward the real process manager and its one event stream unchanged.
// Keep raw stderr because cmd diagnostics can use the OEM code page and the public status keeps only its last line.
use async_trait::async_trait;
use mixdog_core_api::domain::common::EventSource;
use mixdog_core_api::domain::process::*;
use mixdog_protocol::ProcessHandle;

#[derive(Default, Debug)]
struct LaunchDiagnostics {
    requests: Vec<String>,
    stderr: Vec<u8>,
    exits: Vec<String>,
}

struct ObservedProcesses {
    inner: mixdog_spawn::LocalProcessManager,
    diagnostics: Arc<Mutex<LaunchDiagnostics>>,
}

impl ObservedProcesses {
    fn record(&self, request: &SpawnRequest) {
        let allowed = |key: &str| ["PATH", "ComSpec", "SystemRoot", "TEMP"].iter().any(|name| key.eq_ignore_ascii_case(name));
        let inherited: Vec<_> = std::env::vars_os().filter(|(key, _)| allowed(&key.to_string_lossy())).collect();
        let set: Vec<_> = request.env.set.iter().filter(|(key, _)| allowed(key)).collect();
        let remove: Vec<_> = request.env.remove.iter().filter(|key| allowed(key)).collect();
        self.diagnostics.lock().unwrap().requests.push(format!("command={:?} cwd={:?} inherit={} set={set:?} remove={remove:?} parent={inherited:?}", request.command, request.cwd, request.env.inherit));
    }

    fn observe(&self, inner: Box<dyn EventSource<ProcessEvent>>) -> Box<dyn EventSource<ProcessEvent>> {
        Box::new(ObservedEvents { inner, diagnostics: self.diagnostics.clone() })
    }
}

struct ObservedEvents {
    inner: Box<dyn EventSource<ProcessEvent>>,
    diagnostics: Arc<Mutex<LaunchDiagnostics>>,
}

#[async_trait]
impl EventSource<ProcessEvent> for ObservedEvents {
    async fn next(&mut self) -> Option<ProcessEvent> {
        let event = self.inner.next().await;
        match &event {
            Some(ProcessEvent::Output { stream: OutputStream::Stderr, bytes, .. }) => self.diagnostics.lock().unwrap().stderr.extend_from_slice(bytes),
            Some(ProcessEvent::Exited { exit, .. }) => self.diagnostics.lock().unwrap().exits.push(format!("{exit:?}")),
            _ => {}
        }
        event
    }
    async fn close(&mut self) { self.inner.close().await; }
}

#[async_trait]
impl ProcessManager for ObservedProcesses {
    async fn spawn(&self, request: SpawnRequest) -> Result<SpawnedProcess, ProcessError> {
        self.record(&request);
        self.inner.spawn(request).await
    }
    async fn spawn_subscribed(&self, request: SpawnRequest) -> Result<(SpawnedProcess, Box<dyn EventSource<ProcessEvent>>), ProcessError> {
        self.record(&request);
        let (spawned, events) = self.inner.spawn_subscribed(request).await?;
        Ok((spawned, self.observe(events)))
    }
    fn subscribe(&self, handle: &ProcessHandle, from_seq: Option<u64>) -> Result<Box<dyn EventSource<ProcessEvent>>, ProcessError> {
        self.inner.subscribe(handle, from_seq).map(|events| self.observe(events))
    }
    async fn write_stdin(&self, handle: &ProcessHandle, bytes: Vec<u8>) -> Result<(), ProcessError> { self.inner.write_stdin(handle, bytes).await }
    async fn write_stdin_whole(&self, handle: &ProcessHandle, bytes: Vec<u8>) -> Result<(), ProcessError> { self.inner.write_stdin_whole(handle, bytes).await }
    fn close_stdin(&self, handle: &ProcessHandle) -> Result<(), ProcessError> { self.inner.close_stdin(handle) }
    fn resize_pty(&self, handle: &ProcessHandle, size: PtySize) -> Result<(), ProcessError> { self.inner.resize_pty(handle, size) }
    fn kill(&self, handle: &ProcessHandle) -> Result<(), ProcessError> { self.inner.kill(handle) }
    fn terminate(&self, handle: &ProcessHandle) -> Result<(), ProcessError> { self.inner.terminate(handle) }
    fn list(&self) -> Vec<ProcessInfo> { self.inner.list() }
    fn claim(&self, handle: &ProcessHandle, owner: ProcessOwner, time_limit: Option<Duration>) -> Result<(), ProcessError> { self.inner.claim(handle, owner, time_limit) }
}

#[derive(Default)]
struct Events {
    statuses: Mutex<Vec<Value>>,
    diagnostics: Mutex<HashMap<String, Vec<Value>>>,
    diagnostic_events: Mutex<usize>,
}

impl LspSink for Events {
    fn status(&self, event: Value) {
        self.statuses.lock().unwrap().push(event);
    }
    fn diagnostics(&self, event: Value) {
        let rel = event["relPath"].as_str().unwrap_or_default().to_owned();
        let list = event["diagnostics"].as_array().cloned().unwrap_or_default();
        self.diagnostics.lock().unwrap().insert(rel, list);
        *self.diagnostic_events.lock().unwrap() += 1;
    }
}

fn golden() -> Value {
    let path = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../fixtures/desktop/lsp/typescript-real.json");
    serde_json::from_slice(&std::fs::read(path).unwrap()).unwrap()
}

fn entry<'a>(golden: &'a Value, op: &str) -> &'a Value {
    golden["entries"].as_array().unwrap().iter().find(|e| e["op"] == op).unwrap_or_else(|| panic!("no golden entry {op}"))
}

/// The diagnostics a quiet server converges on (the recorder's `settled`).
async fn settled(events: &Events, rel: &str, ready: impl Fn(&[Value]) -> bool, quiet: Duration) -> Vec<Value> {
    let deadline = Instant::now() + Duration::from_secs(30);
    let mut last_change = Instant::now();
    let mut seen = *events.diagnostic_events.lock().unwrap();
    while Instant::now() < deadline {
        mixdog_rt::time::sleep(Duration::from_millis(100)).await;
        let now = *events.diagnostic_events.lock().unwrap();
        if now != seen {
            seen = now;
            last_change = Instant::now();
        }
        let list = events.diagnostics.lock().unwrap().get(rel).cloned().unwrap_or_default();
        if ready(&list) && last_change.elapsed() >= quiet {
            return list;
        }
    }
    panic!("diagnostics for {rel} did not settle");
}

fn brief(list: Vec<Value>) -> Value {
    let mut rows: Vec<Value> = list
        .into_iter()
        .map(|d| json!({ "code": d["code"], "message": d["message"], "range": d["range"], "severity": d["severity"], "source": d["source"] }))
        .collect();
    rows.sort_by_key(|d| d["code"].as_i64());
    Value::Array(rows)
}

/// The golden's diagnostics in the same canonical order (the server's publish order is timing).
fn sorted(value: &Value) -> Value {
    let mut rows = value.as_array().cloned().unwrap_or_default();
    rows.sort_by_key(|d| d["code"].as_i64());
    Value::Array(rows)
}

fn doc(kind: &str, version: i64, content: &str) -> DocumentInput {
    DocumentInput { kind: kind.into(), language_id: "typescript".into(), rel_path: "src/a.ts".into(), content: content.into(), version }
}

#[tokio::test(flavor = "multi_thread")]
async fn real_typescript_server_matches_the_recorded_node_behavior() {
    if which("typescript-language-server").is_none() {
        eprintln!("SKIPPED: typescript-language-server is not installed");
        return;
    }
    let golden = golden();
    let dir = tempfile::tempdir().unwrap();
    let project = mixdog_workspace::pathguard::canonical(dir.path()).unwrap().join("project");
    std::fs::create_dir_all(project.join("src")).unwrap();
    std::fs::write(
        project.join("tsconfig.json"),
        r#"{"compilerOptions":{"strict":true,"target":"es2022","module":"esnext","noEmit":true},"include":["src"]}"#,
    )
    .unwrap();
    std::fs::write(project.join("src/util.ts"), "export function twice(n: number): number {\n  return n * 2;\n}\n").unwrap();
    std::fs::write(project.join("src/a.ts"), "import { twice } from \"./util\";\nconst x: number = twice(2);\n").unwrap();

    let events = Arc::new(Events::default());
    let diagnostics = Arc::new(Mutex::new(LaunchDiagnostics::default()));
    let observed = ObservedProcesses { inner: mixdog_spawn::LocalProcessManager::new(mixdog_rt::testing::tokens().spawn_io, mixdog_spawn::ProcessConfig::default()), diagnostics: diagnostics.clone() };
    let manager = LspManager::new(Arc::new(observed), events.clone(), mixdog_rt::testing::tokens().maintenance_io);
    let project_path = project.to_string_lossy().into_owned();
    let bad = "import { twice } from \"./util\";\nconst x: number = twice(\"2\");\n";
    let fixed = "import { twice } from \"./util\";\nconst x: number = twice(2);\nconst y: string = x;\n";

    let opened = manager.document(&project_path, &project, doc("open", 1, bad)).await.unwrap();
    assert_eq!(opened, entry(&golden, "document(open)")["result"], "capabilities after open; launch diagnostics: {:?}", diagnostics.lock().unwrap());
    let after_open = settled(&events, "src/a.ts", |l| !l.is_empty(), Duration::from_millis(1200)).await;
    assert_eq!(brief(after_open), sorted(&entry(&golden, "diagnostics(after open)")["result"]));

    let hover = manager
        .request(&project_path, &project, "src/a.ts", "typescript", "textDocument/hover", &json!({"position": {"line": 1, "character": 6}}))
        .await
        .unwrap();
    let recorded = &entry(&golden, "request(hover)")["result"];
    assert_eq!((&hover["status"], &hover["server"], &hover["capabilities"]), (&recorded["status"], &recorded["server"], &recorded["capabilities"]));
    assert!(hover["result"]["contents"].is_object() || hover["result"]["contents"].is_string() || hover["result"]["contents"].is_array());
    let definition = manager
        .request(&project_path, &project, "src/a.ts", "typescript", "textDocument/definition", &json!({"position": {"line": 1, "character": 21}}))
        .await
        .unwrap();
    assert!(definition["result"].to_string().contains("util.ts"));
    let unsupported = manager.request(&project_path, &project, "src/a.ts", "typescript", "textDocument/notAMethod", &json!({})).await.unwrap();
    assert_eq!(unsupported, entry(&golden, "request(unsupported method)")["result"]);

    manager.document(&project_path, &project, doc("change", 2, fixed)).await.unwrap();
    assert_eq!(manager.document(&project_path, &project, doc("save", 2, fixed)).await.unwrap()["status"], "ready");
    manager.document(&project_path, &project, doc("close", 2, "")).await.unwrap();
    let closed = settled(&events, "src/a.ts", |l| l.is_empty(), Duration::from_millis(300)).await;
    assert_eq!(brief(closed), sorted(&entry(&golden, "diagnostics(after close)")["result"]));

    // The server dies on its own: the status says so, with the retry wait.
    let mark = events.statuses.lock().unwrap().len();
    let pid = manager.live_roots().len();
    assert_eq!(pid, 1);
    kill_servers();
    let deadline = Instant::now() + Duration::from_secs(10);
    let stopped = loop {
        let found = events.statuses.lock().unwrap()[mark..].iter().find(|s| s["status"] == "stopped").cloned();
        if let Some(found) = found {
            break found;
        }
        assert!(Instant::now() < deadline, "no stopped status");
        mixdog_rt::time::sleep(Duration::from_millis(100)).await;
    };
    let recorded_crash = &entry(&golden, "crash(kill server)")["result"][0];
    assert_eq!(stopped["status"], recorded_crash["status"]);
    assert!(stopped["detail"].as_str().unwrap().ends_with("Retrying after 1s."));

    mixdog_rt::time::sleep(Duration::from_millis(1500)).await;
    let reopened = manager.document(&project_path, &project, doc("open", 3, bad)).await.unwrap();
    assert_eq!(reopened["status"], "ready");
    let after_restart = settled(&events, "src/a.ts", |l| !l.is_empty(), Duration::from_millis(1200)).await;
    assert_eq!(brief(after_restart), sorted(&entry(&golden, "diagnostics(after restart)")["result"]));

    let disposed = manager.dispose_under(&project).await;
    assert_eq!(disposed, [project.to_string_lossy().into_owned()]);
    manager.dispose().await;
}

fn which(program: &str) -> Option<PathBuf> {
    std::env::split_paths(&std::env::var_os("PATH")?).find_map(|dir| {
        ["", ".cmd", ".exe"].iter().map(|e| dir.join(format!("{program}{e}"))).find(|c| c.is_file())
    })
}

/// Kills the language server's node process tree from outside, as a crash would.
fn kill_servers() {
    #[cfg(windows)]
    {
        let _ = std::process::Command::new("powershell")
            .args([
                "-NoProfile",
                "-Command",
                "Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like '*typescript-language-server*--stdio*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }",
            ])
            .status();
    }
    #[cfg(not(windows))]
    {
        let _ = std::process::Command::new("pkill").args(["-9", "-f", "typescript-language-server"]).status();
    }
}
