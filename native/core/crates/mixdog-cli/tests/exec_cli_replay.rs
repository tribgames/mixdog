//! The `mixdogd exec` binary, started as a process, replayed from Node's recording of its real CLI process
//! (`fixtures/exec-cli`, `record-exec-cli.mjs`): the same argv, closed stdin and environment, against a stand-in
//! provider serving the recorded answers. Compared per case: the output as ordered chunks with their stream (stdout and
//! stderr, normalized as the recorder normalizes them), the exit code, the provider requests (origin, path, model, tools,
//! tool results), the requests outside the turn, the working folder, for a run interrupted by Ctrl+C or killed, what it
//! left (pristine roots, live child processes), and for the case recorded beside a running daemon, whether that daemon
//! still answers. What is left out of the output and the requests outside the turn is named, with its side and reason, in
//! the manifest (`stderrNotCompared`, `othersNotCompared`), each one exact line or request; everything else is compared whole.
//!
//! The binary reaches the stand-in through the `test-support` pin of its HTTP client (`REPLAY_PROVIDER_PIN`): every
//! connect goes to the stand-in, which serves TLS under a throwaway certificate for the recorded hosts. Ctrl+C is a
//! CTRL_C_EVENT on the binary's own hidden console, sent by this test binary re-run as a helper; Windows only, as the
//! recording is.
#![cfg(windows)]
#![allow(clippy::disallowed_methods, reason = "the test lays out an install, runs a process and reads what it left on disk")]

mod support {
    pub mod request;
}

use std::collections::BTreeMap;
use std::io::Read;
use std::os::windows::io::AsRawHandle;
use std::os::windows::process::CommandExt;
use std::path::Path;
use std::path::PathBuf;
use std::process::Command;
use std::process::Stdio;
use std::sync::Arc;
use std::sync::Mutex;
use std::time::Duration;

use serde_json::Value;
use serde_json::json;
use tokio::io::AsyncWriteExt;

const CASES: [&str; 7] = ["text", "json", "provider-error", "failed-turn", "ctrl-c", "kill", "beside-daemon"];
/// A run that has not ended in this long has hung.
const RUN_DEADLINE: Duration = Duration::from_secs(180);
/// The Ctrl+C helper attaches to a console and sends one event.
const HELPER_DEADLINE: Duration = Duration::from_secs(60);
/// What a killed or interrupted binary's children are given to end: a bound on a hang, as the run's own, not on a speed (the children end
/// when the system gets to them, which on a loaded machine takes as long as the run itself does).
const CHILDREN_DEADLINE: Duration = RUN_DEADLINE;
/// The binary's console is its own and has no window.
const CREATE_NO_WINDOW: u32 = 0x0800_0000;
/// The helper's target, when this binary runs as the Ctrl+C helper.
const CTRL_C_TARGET: &str = "EXEC_CLI_CTRL_C_TARGET";
const NO_SCRIPT: &str = "HTTP/1.1 404 Not Found\r\ncontent-type: text/plain\r\ncontent-length: 9\r\nconnection: close\r\n\r\nno script";

fn fixture(name: &str) -> &'static str {
    match name {
        "text" => mixdog_testkit::fixture!("../../fixtures/exec-cli/text.json"),
        "json" => mixdog_testkit::fixture!("../../fixtures/exec-cli/json.json"),
        "provider-error" => mixdog_testkit::fixture!("../../fixtures/exec-cli/provider-error.json"),
        "failed-turn" => mixdog_testkit::fixture!("../../fixtures/exec-cli/failed-turn.json"),
        "ctrl-c" => mixdog_testkit::fixture!("../../fixtures/exec-cli/ctrl-c.json"),
        "kill" => mixdog_testkit::fixture!("../../fixtures/exec-cli/kill.json"),
        "beside-daemon" => mixdog_testkit::fixture!("../../fixtures/exec-cli/beside-daemon.json"),
        other => panic!("no case {other}"),
    }
}

/// An install of the binary under test: the binary hard-linked beside a `js-runtime.json` naming this tree's JS package
/// and the `node` on `PATH`.
fn install() -> PathBuf {
    let dir = Path::new(env!("CARGO_TARGET_TMPDIR")).join(format!("exec-cli-install-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&dir).unwrap();
    let exe = dir.join("mixdogd.exe");
    std::fs::hard_link(env!("CARGO_BIN_EXE_mixdogd"), &exe).unwrap();
    let package = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../..").canonicalize().unwrap();
    std::fs::write(dir.join("js-runtime.json"), json!({ "program": "node", "packageRoot": package }).to_string()).unwrap();
    exe
}

/// The recorder's `normalize`: the sandbox, session and thread ids, times and durations of the run replaced.
fn normalize(text: &str, sandbox: &str) -> String {
    let mut out = text.to_owned();
    let escaped = serde_json::to_string(sandbox).unwrap();
    for form in [&escaped[1..escaped.len() - 1], sandbox, &sandbox.replace('\\', "/")] {
        out = out.replace(form, "<sandbox>");
    }
    let rules = [
        (r"\(node:\d+\)", "(node:<pid>)"),
        (r"(\[atomic-file\] async lock wait )\d+ms: queueWaitMs=\d+ms osAcquireMs=\d+ms", "${1}<ms>: queueWaitMs=<ms> osAcquireMs=<ms>"),
        (r"mixdog-headless-pristine-[A-Za-z0-9]+", "mixdog-headless-pristine-<id>"),
        (r"sess_[A-Za-z0-9_]+", "<session>"),
        (r"exec_[0-9a-f]{32}", "<thread>"),
        (r"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z", "<time>"),
        (r#""(duration_ms|duration_api_ms|queue_ms|dispatch_ms|execution_ms|batch_wait_ms|postprocess_ms|total_ms)":\d+(?:\.\d+)?"#, r#""$1":0"#),
    ];
    for (pattern, replacement) in rules {
        out = regex::Regex::new(pattern).unwrap().replace_all(&out, replacement).into_owned();
    }
    out
}

/// The recorder's `ordered`, over what the two pipes delivered in arrival order: every line, consecutive chunks of one stream
/// joined (the manifest's `exclusions.chunking`), then normalized.
fn ordered(chunks: &[(&'static str, Vec<u8>)], sandbox: &str) -> Value {
    let mut joined: Vec<(&str, String)> = Vec::new();
    for (stream, bytes) in chunks {
        match joined.last_mut() {
            Some((last, text)) if *last == *stream => text.push_str(&String::from_utf8_lossy(bytes)),
            _ => joined.push((*stream, String::from_utf8_lossy(bytes).into_owned())),
        }
    }
    Value::Array(joined.into_iter().map(|(stream, text)| json!({ "stream": stream, "text": normalize(&text, sandbox) })).collect())
}

/// The manifest's declared leave-outs: `stderrNotCompared` (each an exact `line` of one side's stderr) and `othersNotCompared`
/// (each an exact `request` only one side makes), every one with its side and reason. Each must be met by what it names, in some
/// case: a leave-out that matches nothing hides nothing and is not declared.
struct NotCompared {
    stderr: Vec<Declared>,
    others: Vec<Declared>,
}

struct Declared {
    side: String,
    name: String,
    text: String,
    /// What it names is a timing fact (it may or may not occur in a recording): it need not be met.
    timing: bool,
    met: std::cell::Cell<bool>,
}

impl NotCompared {
    fn from_manifest() -> Self {
        let manifest: Value = serde_json::from_str(mixdog_testkit::fixture!("../../fixtures/exec-cli/MANIFEST.json")).unwrap();
        let declared = |key: &str, text: &str| -> Vec<Declared> {
            manifest[key]
                .as_array()
                .unwrap()
                .iter()
                .map(|entry| {
                    assert!(!entry["reason"].as_str().unwrap().is_empty(), "{key}: {} has no reason", entry["name"]);
                    Declared { side: entry["side"].as_str().unwrap().to_owned(), name: entry["name"].as_str().unwrap().to_owned(), text: entry[text].as_str().unwrap().to_owned(), timing: entry["timing"] == true, met: std::cell::Cell::new(false) }
                })
                .collect()
        };
        Self { stderr: declared("stderrNotCompared", "line"), others: declared("othersNotCompared", "request") }
    }

    /// The names of the declared leave-outs that no compared data of their side held.
    fn unmet(&self) -> Vec<&str> {
        self.stderr.iter().chain(&self.others).filter(|declared| !declared.timing && !declared.met.get()).map(|declared| declared.name.as_str()).collect()
    }

    /// Whether a leave-out of `side` names exactly `text`; the ones that do are met.
    fn names(declared: &[Declared], side: &str, text: &str) -> bool {
        let named: Vec<&Declared> = declared.iter().filter(|declared| declared.side == side && declared.text == text).collect();
        named.iter().for_each(|declared| declared.met.set(true));
        !named.is_empty()
    }

    /// `output` of `side` (`node` or `core`) without the stderr lines declared for that side; runs the leave-out empties are
    /// joined again.
    fn output(&self, output: &Value, side: &str) -> Value {
        let mut joined: Vec<(String, String)> = Vec::new();
        for chunk in output.as_array().unwrap() {
            let stream = chunk["stream"].as_str().unwrap();
            let text = chunk["text"].as_str().unwrap();
            let left_out = |line: &str| Self::names(&self.stderr, side, line.trim_end_matches(['\r', '\n']));
            let kept: String = if stream == "stderr" { text.split_inclusive('\n').filter(|line| !left_out(line)).collect() } else { text.to_owned() };
            if kept.is_empty() {
                continue;
            }
            match joined.last_mut() {
                Some((last, text)) if last == stream => text.push_str(&kept),
                _ => joined.push((stream.to_owned(), kept)),
            }
        }
        Value::Array(joined.into_iter().map(|(stream, text)| json!({ "stream": stream, "text": text })).collect())
    }

    /// The requests outside the turn that `side` (`node` or `core`) makes, without those declared for that side only.
    fn others(&self, others: &Value, side: &str) -> Value {
        Value::Array(others.as_array().unwrap().iter().filter(|request| !Self::names(&self.others, side, request.as_str().unwrap())).cloned().collect())
    }
}

/// The stand-in provider's record of a run.
#[derive(Default)]
struct Heard {
    requests: Vec<Value>,
    others: Vec<String>,
}

/// The stand-in: TLS under `cert` for every connect; each messages request gets the next recorded answer (the last again
/// when the case repeats it, else a 404), a held answer is never written, any other request gets the recorder's 404.
async fn serve(listener: tokio::net::TcpListener, config: Arc<rustls::ServerConfig>, names: Vec<String>, case: Arc<Value>, heard: Arc<Mutex<Heard>>, held: Arc<tokio::sync::Notify>) {
    loop {
        let Ok((tcp, _)) = listener.accept().await else { return };
        let (config, names, case, heard, held) = (config.clone(), names.clone(), case.clone(), heard.clone(), held.clone());
        tokio::spawn(async move {
            let Ok(start) = tokio_rustls::LazyConfigAcceptor::new(rustls::server::Acceptor::default(), tcp).await else { return };
            let sni = start.client_hello().server_name().map(str::to_owned);
            if !sni.as_ref().is_some_and(|name| names.contains(name)) {
                // A host the recording never reached: the connect is the record, the certificate does not cover it.
                heard.lock().unwrap().others.push(format!("CONNECT {}", sni.as_deref().unwrap_or("<no name>")));
            }
            let Ok(mut io) = start.into_stream(config).await else { return };
            let Some(request) = support::request::read_request(&mut io).await else { return };
            let host = request.host.as_deref().unwrap_or_default().trim_end_matches(":443").to_owned();
            let path = request.path.split('?').next().unwrap_or_default().to_owned();
            if request.method != "POST" || !path.ends_with("/v1/messages") {
                heard.lock().unwrap().others.push(format!("{} https://{host}{path}", request.method));
                io.write_all(NO_SCRIPT.as_bytes()).await.ok();
                io.shutdown().await.ok();
                return;
            }
            let body: Value = serde_json::from_slice(&request.body).unwrap();
            let index = {
                let mut heard = heard.lock().unwrap();
                let mut entry = json!({ "origin": format!("https://{host}"), "path": path });
                entry.as_object_mut().unwrap().extend(support::request::heard(&body).as_object().unwrap().clone());
                heard.requests.push(entry);
                heard.requests.len() - 1
            };
            let replies = case["replies"].as_array().unwrap();
            let reply = replies.get(index).or_else(|| (case["repeat"] == true).then(|| replies.last().unwrap()));
            let Some(reply) = reply else {
                io.write_all(NO_SCRIPT.as_bytes()).await.ok();
                io.shutdown().await.ok();
                return;
            };
            if reply["hold"] == true {
                held.notify_one();
                // The connection stays open, unanswered, until the run ends it.
                let mut rest = Vec::new();
                tokio::io::AsyncReadExt::read_to_end(&mut io, &mut rest).await.ok();
                return;
            }
            let body = reply["body"].as_str().unwrap();
            let head = format!("HTTP/1.1 {} X\r\ncontent-type: {}\r\ncontent-length: {}\r\nconnection: close\r\n\r\n", reply["status"], reply["contentType"].as_str().unwrap(), body.len());
            io.write_all(head.as_bytes()).await.ok();
            io.write_all(body.as_bytes()).await.ok();
            io.shutdown().await.ok();
        });
    }
}

/// The hosts the recording reached, which the stand-in's certificate covers.
fn hosts(case: &Value) -> Vec<String> {
    let mut names: Vec<String> = case["requests"].as_array().unwrap().iter().map(|request| request["origin"].as_str().unwrap().trim_start_matches("https://").to_owned()).collect();
    for other in case["others"].as_array().unwrap() {
        if let Some(url) = other.as_str().unwrap().split(' ').nth(1).and_then(|url| url.strip_prefix("https://")) {
            names.push(url.split('/').next().unwrap().to_owned());
        }
    }
    names.push("api.anthropic.com".to_owned());
    names.sort();
    names.dedup();
    names
}

/// The live processes whose parent is `pid`, as (pid, image name).
fn children_of(pid: u32) -> Vec<(u32, String)> {
    use windows_sys::Win32::Foundation::CloseHandle;
    use windows_sys::Win32::Foundation::INVALID_HANDLE_VALUE;
    use windows_sys::Win32::System::Diagnostics::ToolHelp::CreateToolhelp32Snapshot;
    use windows_sys::Win32::System::Diagnostics::ToolHelp::PROCESSENTRY32W;
    use windows_sys::Win32::System::Diagnostics::ToolHelp::Process32FirstW;
    use windows_sys::Win32::System::Diagnostics::ToolHelp::Process32NextW;
    use windows_sys::Win32::System::Diagnostics::ToolHelp::TH32CS_SNAPPROCESS;
    let mut found = Vec::new();
    // SAFETY: the snapshot handle is checked and closed; the entry is sized as the API requires.
    unsafe {
        let snapshot = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
        assert!(snapshot != INVALID_HANDLE_VALUE, "a process snapshot");
        let mut entry: PROCESSENTRY32W = std::mem::zeroed();
        entry.dwSize = u32::try_from(std::mem::size_of::<PROCESSENTRY32W>()).unwrap();
        let mut more = Process32FirstW(snapshot, &mut entry) != 0;
        while more {
            if entry.th32ParentProcessID == pid {
                let end = entry.szExeFile.iter().position(|c| *c == 0).unwrap_or(entry.szExeFile.len());
                found.push((entry.th32ProcessID, String::from_utf16_lossy(&entry.szExeFile[..end])));
            }
            more = Process32NextW(snapshot, &mut entry) != 0;
        }
        CloseHandle(snapshot);
    }
    found
}

/// Waits, each up to [`CHILDREN_DEADLINE`], for the processes that were children of `pid` to end. A killed binary's job object
/// (kill-on-close) ends its children when the kernel closes the job, which happens after the binary's own exit is
/// signalled: a snapshot taken at that exit may still show them, so the end of each is waited for as an event, on its handle.
/// A child still running at its deadline fails here, by name: it could otherwise end while a later one is waited for and be
/// missing from the snapshot the comparison takes afterwards.
fn wait_children_end(pid: u32) {
    use windows_sys::Win32::Foundation::CloseHandle;
    use windows_sys::Win32::Foundation::WAIT_OBJECT_0;
    use windows_sys::Win32::System::Threading::OpenProcess;
    use windows_sys::Win32::System::Threading::PROCESS_SYNCHRONIZE;
    use windows_sys::Win32::System::Threading::WaitForSingleObject;
    let limit = u32::try_from(CHILDREN_DEADLINE.as_millis()).unwrap();
    for (child, name) in children_of(pid) {
        // SAFETY: the handle is checked and closed; a process that already ended cannot be opened and needs no wait.
        let waited = unsafe {
            let handle = OpenProcess(PROCESS_SYNCHRONIZE, 0, child);
            if handle.is_null() {
                continue;
            }
            let waited = WaitForSingleObject(handle, limit);
            let error = std::io::Error::last_os_error();
            CloseHandle(handle);
            (waited, error)
        };
        assert!(
            waited.0 == WAIT_OBJECT_0,
            "{name} (pid {child}), a child of the binary (pid {pid}), had not ended {CHILDREN_DEADLINE:?} after the binary's exit: wait result {:#x}, {}",
            waited.0,
            waited.1
        );
    }
}

fn terminate(pid: u32) {
    use windows_sys::Win32::Foundation::CloseHandle;
    use windows_sys::Win32::System::Threading::OpenProcess;
    use windows_sys::Win32::System::Threading::PROCESS_TERMINATE;
    use windows_sys::Win32::System::Threading::TerminateProcess;
    // SAFETY: the handle is checked and closed.
    unsafe {
        let handle = OpenProcess(PROCESS_TERMINATE, 0, pid);
        if !handle.is_null() {
            TerminateProcess(handle, 1);
            CloseHandle(handle);
        }
    }
}

/// Ctrl+C to the console of `pid`, from this binary re-run as the helper ([`ctrl_c_helper`]).
fn ctrl_c(pid: u32) {
    let mut helper = Command::new(std::env::current_exe().unwrap())
        .args(["ctrl_c_helper", "--exact", "--nocapture", "--test-threads=1"])
        .env(CTRL_C_TARGET, pid.to_string())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .creation_flags(CREATE_NO_WINDOW)
        .spawn()
        .unwrap();
    let (helper_pid, mut said) = (helper.id(), helper.stdout.take().unwrap());
    let (done, ended) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        let mut text = String::new();
        said.read_to_string(&mut text).ok();
        done.send((helper.wait().unwrap(), text)).ok();
    });
    let (status, text) = ended.recv_timeout(HELPER_DEADLINE).unwrap_or_else(|_| {
        terminate(helper_pid);
        panic!("the Ctrl+C helper for {pid} did not end in {HELPER_DEADLINE:?}")
    });
    assert!(status.success(), "Ctrl+C to {pid} was not sent: {text}");
}

/// Ends a run and what it started, before a failing wait panics: the binary and its live children.
fn end_tree(pid: u32) {
    for (child, _) in children_of(pid) {
        terminate(child);
    }
    terminate(pid);
}

/// The helper: attached to the target's console, it sends CTRL_C_EVENT to every process on it, ignoring it itself. Run
/// as an ordinary test it does nothing.
#[test]
fn ctrl_c_helper() {
    use windows_sys::Win32::System::Console::AttachConsole;
    use windows_sys::Win32::System::Console::CTRL_C_EVENT;
    use windows_sys::Win32::System::Console::FreeConsole;
    use windows_sys::Win32::System::Console::GenerateConsoleCtrlEvent;
    use windows_sys::Win32::System::Console::SetConsoleCtrlHandler;
    let Ok(target) = std::env::var(CTRL_C_TARGET) else { return };
    let pid: u32 = target.parse().unwrap();
    // SAFETY: plain console API calls on this process.
    unsafe {
        FreeConsole();
        assert!(AttachConsole(pid) != 0, "attached to the console of {pid}");
        SetConsoleCtrlHandler(None, 1);
        assert!(GenerateConsoleCtrlEvent(CTRL_C_EVENT, 0) != 0, "CTRL_C_EVENT sent");
    }
}

/// The recorded environment of a case, `<sandbox>` replaced by `root`.
fn apply_env(command: &mut Command, case: &Value, root: &str) {
    for (name, value) in case["env"].as_object().unwrap() {
        let value = value.as_str().unwrap();
        let value = if value == "<host>" { std::env::var(name).unwrap() } else { value.replacen("<sandbox>", root, 1).replace('/', "\\") };
        command.env(name, value);
    }
}

/// The core running beside the exec (`mixdogd serve` on the case's own data and temp folders), ended with its children when
/// this value goes, whatever the test does.
struct Daemon {
    child: std::process::Child,
}

impl Daemon {
    /// Started and waited for until it published its discovery file (`<temp>/mixdog/daemon.json` naming its pid), by watching the
    /// folder for the file to appear.
    fn start(exe: &Path, case: &Value, sandbox: &Path, root: &str) -> Self {
        use notify::Watcher;
        let (changed, events) = std::sync::mpsc::channel();
        let mut watcher = notify::recommended_watcher(move |_: notify::Result<notify::Event>| {
            changed.send(()).ok();
        })
        .unwrap();
        let temp = sandbox.join("tmp");
        watcher.watch(&temp, notify::RecursiveMode::Recursive).unwrap();
        let mut command = Command::new(exe);
        command.arg("serve").current_dir(sandbox.join("work")).env_clear();
        apply_env(&mut command, case, root);
        let child = command.stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null()).creation_flags(CREATE_NO_WINDOW).spawn().unwrap();
        let daemon = Self { child };
        let discovery = temp.join("mixdog").join("daemon.json");
        let published = || std::fs::read_to_string(&discovery).ok().and_then(|text| serde_json::from_str::<Value>(&text).ok()).is_some_and(|doc| doc["pid"] == daemon.child.id());
        while !published() {
            events.recv_timeout(RUN_DEADLINE).unwrap_or_else(|_| panic!("the core beside the exec did not publish {} in {RUN_DEADLINE:?}", discovery.display()));
        }
        daemon
    }

    /// Whether the core still runs and answers a client of its control listener (`ctl status`).
    fn answers(&mut self, exe: &Path, case: &Value, root: &str, work: &Path) -> bool {
        if self.child.try_wait().unwrap().is_some() {
            return false;
        }
        let mut command = Command::new(exe);
        command.args(["ctl", "status", "--json"]).current_dir(work).env_clear();
        apply_env(&mut command, case, root);
        let status = command.stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null()).creation_flags(CREATE_NO_WINDOW).status().unwrap();
        status.success()
    }
}

impl Drop for Daemon {
    fn drop(&mut self) {
        end_tree(self.child.id());
        self.child.wait().ok();
    }
}

/// One case: the binary run as Node's CLI was, and what it did, in the recording's shape.
fn run_case(exe: &Path, runtime: &tokio::runtime::Runtime, case: &Value) -> Value {
    let label = case["case"].as_str().unwrap();
    let sandbox = tempfile::tempdir().unwrap();
    let root = sandbox.path().to_string_lossy().into_owned();
    for folder in ["home/AppData/Roaming", "home/AppData/Local", "host-data", "tmp", "work"] {
        std::fs::create_dir_all(sandbox.path().join(folder)).unwrap();
    }
    std::fs::write(sandbox.path().join("work").join("a.txt"), "hello\n").unwrap();

    let names = hosts(case);
    let issued = rcgen::generate_simple_self_signed(names.clone()).unwrap();
    let cert_path = sandbox.path().join("stand-in.der");
    std::fs::write(&cert_path, issued.cert.der().to_vec()).unwrap();
    let key = rustls::pki_types::PrivateKeyDer::Pkcs8(rustls::pki_types::PrivatePkcs8KeyDer::from(issued.signing_key.serialize_der()));
    let mut config = rustls::ServerConfig::builder_with_provider(Arc::new(rustls::crypto::ring::default_provider()))
        .with_safe_default_protocol_versions()
        .unwrap()
        .with_no_client_auth()
        .with_single_cert(vec![issued.cert.der().clone()], key)
        .unwrap();
    config.alpn_protocols = vec![b"http/1.1".to_vec()];
    let heard = Arc::new(Mutex::new(Heard::default()));
    let held = Arc::new(tokio::sync::Notify::new());
    let listener = runtime.block_on(tokio::net::TcpListener::bind("127.0.0.1:0")).unwrap();
    let addr = listener.local_addr().unwrap();
    let server = runtime.spawn(serve(listener, Arc::new(config), names, Arc::new(case.clone()), heard.clone(), held.clone()));

    // A case recorded beside a running daemon starts the core's own on the same folders first.
    let mut daemon = case.get("daemon").map(|_| Daemon::start(exe, case, sandbox.path(), &root));
    let mut command = Command::new(exe);
    command.args(case["argv"].as_array().unwrap().iter().map(|arg| arg.as_str().unwrap())).current_dir(sandbox.path().join("work")).env_clear();
    apply_env(&mut command, case, &root);
    command.env("REPLAY_PROVIDER_PIN", addr.to_string()).env("REPLAY_PROVIDER_PIN_CERT", &cert_path);
    let mut child = command.stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped()).creation_flags(CREATE_NO_WINDOW).spawn().unwrap();
    drop(child.stdin.take());
    let pid = child.id();
    let chunks: Arc<Mutex<Vec<(&'static str, Vec<u8>)>>> = Arc::default();
    let pipes: [(&'static str, Box<dyn Read + Send>); 2] = [("stdout", Box::new(child.stdout.take().unwrap())), ("stderr", Box::new(child.stderr.take().unwrap()))];
    let readers: Vec<_> = pipes
        .into_iter()
        .map(|(stream, mut pipe)| {
            let chunks = chunks.clone();
            std::thread::spawn(move || {
                let mut buffer = [0u8; 8192];
                while let Ok(read) = pipe.read(&mut buffer) {
                    if read == 0 {
                        break;
                    }
                    chunks.lock().unwrap().push((stream, buffer[..read].to_vec()));
                }
            })
        })
        .collect();
    let handle = child.as_raw_handle() as usize;
    let (exited, exit) = std::sync::mpsc::channel();
    let waiter = std::thread::spawn(move || exited.send(child.wait().unwrap()).ok());
    let interrupt = case["left"].is_object().then(|| if case["code"].is_null() { "kill" } else { "ctrl-c" });
    if let Some(interrupt) = interrupt {
        runtime.block_on(async { tokio::time::timeout(RUN_DEADLINE, held.notified()).await }).unwrap_or_else(|_| {
            end_tree(pid);
            panic!("{label}: the held request never came in {RUN_DEADLINE:?}")
        });
        if interrupt == "ctrl-c" {
            ctrl_c(pid);
        } else {
            // SAFETY: the waiter thread owns the child, so its handle is open until the wait returns.
            unsafe { windows_sys::Win32::System::Threading::TerminateProcess(handle as windows_sys::Win32::Foundation::HANDLE, 1) };
        }
    }
    let status = exit.recv_timeout(RUN_DEADLINE).unwrap_or_else(|_| {
        end_tree(pid);
        panic!("{label}: the run did not end in {RUN_DEADLINE:?}")
    });
    waiter.join().unwrap();
    let beside = daemon.as_mut().map(|daemon| json!({ "aliveAfterExec": daemon.answers(exe, case, &root, &sandbox.path().join("work")) }));
    let left = interrupt.map(|_| {
        wait_children_end(pid);
        let children = children_of(pid);
        let roots = std::fs::read_dir(sandbox.path().join("tmp")).unwrap().filter(|entry| entry.as_ref().unwrap().file_name().to_string_lossy().starts_with("mixdog-headless-pristine-")).count();
        for (child, _) in &children {
            terminate(*child);
        }
        let mut names: Vec<String> = children.into_iter().map(|(_, name)| name).collect();
        names.sort();
        json!({ "roots": roots, "children": names })
    });
    for reader in readers {
        reader.join().unwrap();
    }
    server.abort();
    let code = if interrupt == Some("kill") { Value::Null } else { json!(status.code().unwrap()) };
    let files: BTreeMap<String, String> = std::fs::read_dir(sandbox.path().join("work")).unwrap().map(|entry| entry.unwrap()).map(|entry| (entry.file_name().to_string_lossy().into_owned(), std::fs::read_to_string(entry.path()).unwrap())).collect();
    let heard = std::mem::take(&mut *heard.lock().unwrap());
    let mut others = heard.others;
    others.sort();
    others.dedup();
    let mut got = json!({
        "code": code,
        "output": ordered(&chunks.lock().unwrap(), &root),
        "requests": heard.requests,
        "others": others,
        "files": files,
    });
    if let Some(left) = left {
        got["left"] = left;
    }
    if let Some(beside) = beside {
        got["daemon"] = beside;
    }
    got
}

#[test]
fn the_exec_binary_does_what_nodes_cli_process_recorded_for_every_case() {
    let exe = install();
    let runtime = tokio::runtime::Builder::new_multi_thread().enable_all().build().unwrap();
    let mut differences = Vec::new();
    let declared = NotCompared::from_manifest();
    for name in CASES {
        let case: Value = serde_json::from_str(fixture(name)).unwrap();
        let got = run_case(&exe, &runtime, &case);
        for field in ["code", "requests", "files", "left", "daemon"] {
            if got.get(field) != case.get(field) {
                differences.push(format!(
                    "{name}: {field}\n  Node: {}\n  core: {}",
                    serde_json::to_string(&case.get(field)).unwrap(),
                    serde_json::to_string(&got.get(field)).unwrap()
                ));
            }
        }
        // The output and the requests outside the turn, but for what the manifest declares (`stderrNotCompared`,
        // `othersNotCompared`): the rest of each is compared whole.
        let sides = [
            ("output", declared.output(&case["output"], "node"), declared.output(&got["output"], "core")),
            ("others", declared.others(&case["others"], "node"), declared.others(&got["others"], "core")),
        ];
        for (field, node, core) in sides {
            if node != core {
                differences.push(format!("{name}: {field}\n  Node: {node}\n  core: {core}"));
            }
        }
    }
    assert!(differences.is_empty(), "{} difference(s) from Node's CLI:\n{}", differences.len(), differences.join("\n"));
    assert!(declared.unmet().is_empty(), "declared leave-outs that no compared data of their side held: {:?}", declared.unmet());
}
