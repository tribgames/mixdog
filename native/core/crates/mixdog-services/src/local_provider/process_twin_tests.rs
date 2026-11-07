//! Node-recorded twin `fixtures/services/local-process-twin.json`
//! (`benchmarks/rust-core/recorders/record-local-process.mjs`): `hardware.mjs` parsing, probing and
//! GPU selection, and what `ensureLocalProviderServer` runs (program, arguments, working directory,
//! environment) with `child_process` and `fetch` scripted. Rust must give the same answers and ask
//! the OS for the same things, in the same order. `MIXDOG_FIXTURES_ROOT` overrides the fixture
//! location.

use std::collections::{HashMap, VecDeque};
use std::sync::{Arc, Mutex};

use async_trait::async_trait;
use mixdog_core_api::domain::common::EventSource;
use mixdog_core_api::domain::process::{CommandSpec, ExitStatus, OutputStream, ProcessError, ProcessEvent, ProcessExit, ProcessInfo, ProcessManager, PtySize, SpawnRequest, SpawnedProcess};
use mixdog_protocol::ProcessHandle;
use serde_json::{Value, json};
use tokio::sync::watch;

use super::hardware::{HardwareProbe, Query, parse_nvidia_gpus, select_gpu};
use super::provider::tests::provider_with;
use super::server_process::{ExitInfo, Health, Launcher, LogSink, RunningProcess};
use crate::tidy::process::Processes;

fn twin() -> Value {
    let root = std::env::var("MIXDOG_FIXTURES_ROOT").unwrap_or_else(|_| concat!(env!("CARGO_MANIFEST_DIR"), "/../../fixtures").to_owned());
    serde_json::from_str(&std::fs::read_to_string(format!("{root}/services/local-process-twin.json")).unwrap()).unwrap()
}

fn same(a: &Value, b: &Value) -> bool {
    match (a, b) {
        (Value::Number(x), Value::Number(y)) => x.as_f64() == y.as_f64(),
        (Value::Array(x), Value::Array(y)) => x.len() == y.len() && x.iter().zip(y).all(|(p, q)| same(p, q)),
        (Value::Object(x), Value::Object(y)) => x.len() == y.len() && x.iter().all(|(k, v)| y.get(k).is_some_and(|w| same(v, w))),
        _ => a == b,
    }
}

#[derive(Default)]
struct Differences(Vec<String>);

impl Differences {
    fn check(&mut self, name: &str, actual: &Value, expected: &Value) {
        if !same(actual, expected) {
            let cut = |v: &Value| serde_json::to_string(v).unwrap().chars().take(900).collect::<String>();
            self.0.push(format!("{name}\n  actual: {}\n expected: {}", cut(actual), cut(expected)));
        }
    }

    fn none(self) {
        assert!(self.0.is_empty(), "{} differences:\n{}", self.0.len(), self.0.iter().take(20).cloned().collect::<Vec<_>>().join("\n"));
    }
}

/// Node's `platform`/`arch` names for the ones Rust spells differently.
fn rust_os(node: &str) -> &str {
    match node {
        "win32" => "windows",
        "darwin" => "macos",
        other => other,
    }
}

fn rust_arch(node: &str) -> &str {
    match node {
        "x64" => "x86_64",
        "arm64" => "aarch64",
        other => other,
    }
}

#[test]
fn nvidia_output_is_parsed_the_way_node_does() {
    let mut differences = Differences::default();
    for case in twin()["parse"].as_array().unwrap() {
        let actual = Value::Array(parse_nvidia_gpus(case["output"].as_str().unwrap()).iter().map(|g| g.to_json()).collect());
        differences.check(&format!("{:?}", case["output"]), &actual, &case["gpus"]);
    }
    differences.none();
}

fn query_of(case: &Value) -> Result<Query, String> {
    let query = &case["query"];
    if let Some(text) = query["nvidia"].as_str() {
        Ok(Query::Nvidia(text.to_owned()))
    } else if let Some(apple) = query.get("apple") {
        Ok(Query::Apple { name: apple["name"].as_str().unwrap().to_owned(), total_bytes: apple["totalBytes"].as_i64().unwrap(), wired_limit_mb: apple["wiredLimitMb"].as_i64().unwrap() })
    } else {
        Err(query["error"].as_str().unwrap_or("never").to_owned())
    }
}

fn without_checked_at(mut hardware: Value) -> Value {
    hardware.as_object_mut().unwrap().remove("checkedAt");
    hardware
}

#[tokio::test]
async fn the_probe_reports_what_node_reports() {
    let mut differences = Differences::default();
    for case in twin()["probe"].as_array().unwrap() {
        let name = case["name"].as_str().unwrap();
        let probe = HardwareProbe::new(rust_os(case["platform"].as_str().unwrap()), rust_arch(case["arch"].as_str().unwrap()), None, Processes::for_tests());
        differences.check(&format!("{name} (before)"), &without_checked_at(probe.status().to_json()), &case["initial"]);
        let answer = query_of(case);
        let status = probe.refresh(!name.starts_with("first unforced"), || async move { answer }).await;
        differences.check(name, &without_checked_at(status.to_json()), &case["status"]);
    }
    differences.none();
}

#[tokio::test]
async fn gpu_selection_answers_what_node_does() {
    let mut differences = Differences::default();
    for case in twin()["select"].as_array().unwrap() {
        let label = case["hardware"].as_str().unwrap();
        let hardware = match case["output"].as_str() {
            Some(output) => HardwareProbe::new("windows", "x86_64", None, Processes::for_tests()).refresh(true, || async { Ok(Query::Nvidia(output.to_owned())) }).await,
            None if label == "unsupported platform" => HardwareProbe::new("linux", "x86_64", None, Processes::for_tests()).refresh(true, || async { Err("never".into()) }).await,
            None => HardwareProbe::new("windows", "x86_64", None, Processes::for_tests()).refresh(true, || async { Err("boom".into()) }).await,
        };
        let model = &case["model"];
        let actual = match select_gpu(&hardware, model["estimatedVramBytes"].as_i64().unwrap(), model["minimumVramBytes"].as_i64().unwrap()) {
            Ok(gpu) => json!({"gpu": gpu.to_json()}),
            Err(e) => json!({"error": e.to_string()}),
        };
        let expected = if case.get("gpu").is_some() { json!({"gpu": case["gpu"]}) } else { json!({"error": case["error"]}) };
        differences.check(&format!("{label} / {model}"), &actual, &expected);
    }
    differences.none();
}

// ---- scripted children ---------------------------------------------------------------------

type Log = Arc<Mutex<Vec<Value>>>;

/// A process manager that runs nothing: `nvidia-smi` answers the scripted text (or is missing),
/// and every spawn is logged in order with the launcher's.
struct Scripted {
    smi: String,
    smi_missing: bool,
    log: Log,
    replies: Mutex<HashMap<String, VecDeque<ProcessEvent>>>,
}

struct Replay(VecDeque<ProcessEvent>);

#[async_trait]
impl EventSource<ProcessEvent> for Replay {
    async fn next(&mut self) -> Option<ProcessEvent> {
        self.0.pop_front()
    }
}

#[async_trait]
impl ProcessManager for Scripted {
    async fn spawn(&self, request: SpawnRequest) -> Result<SpawnedProcess, ProcessError> {
        let CommandSpec::Argv { program, args } = &request.command else { panic!("argv expected") };
        self.log.lock().unwrap().push(json!({"kind": "execFile", "file": program, "args": args, "timeoutMs": request.time_limit.map(|t| t.as_millis() as u64)}));
        if self.smi_missing {
            return Err(ProcessError::ProgramNotFound { program: program.clone() });
        }
        let events = VecDeque::from([
            ProcessEvent::Output { seq: 0, stream: OutputStream::Stdout, bytes: self.smi.clone().into_bytes() },
            ProcessEvent::Exited { seq: 1, exit: ProcessExit { status: ExitStatus::Code(0), killed: None } },
        ]);
        self.replies.lock().unwrap().insert(request.handle.0.clone(), events);
        Ok(SpawnedProcess { handle: request.handle, pid: 1 })
    }
    fn subscribe(&self, handle: &ProcessHandle, _: Option<u64>) -> Result<Box<dyn EventSource<ProcessEvent>>, ProcessError> {
        let events = self.replies.lock().unwrap().remove(&handle.0).ok_or(ProcessError::UnknownHandle)?;
        Ok(Box::new(Replay(events)))
    }
    async fn write_stdin(&self, _: &ProcessHandle, _: Vec<u8>) -> Result<(), ProcessError> {
        Err(ProcessError::StdinClosed)
    }
    fn close_stdin(&self, _: &ProcessHandle) -> Result<(), ProcessError> {
        Ok(())
    }
    fn resize_pty(&self, _: &ProcessHandle, _: PtySize) -> Result<(), ProcessError> {
        Err(ProcessError::NotPty)
    }
    fn kill(&self, _: &ProcessHandle) -> Result<(), ProcessError> {
        Ok(())
    }
    fn list(&self) -> Vec<ProcessInfo> {
        Vec::new()
    }
}

/// A launcher that logs the call and hands back a child that lives until it is killed.
struct Capture(Log);

struct Child(watch::Sender<Option<ExitInfo>>);

#[async_trait]
impl RunningProcess for Child {
    async fn wait(&self) -> ExitInfo {
        let mut rx = self.0.subscribe();
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
        let _ = self.0.send(Some(ExitInfo { exit_code: None, signal: Some("SIGKILL".into()) }));
    }
}

#[async_trait]
impl Launcher for Capture {
    async fn launch(&self, executable: &str, args: &[String], cwd: &str, env: &[(String, String)], _: LogSink) -> Result<Arc<dyn RunningProcess>, String> {
        let cuda = env.iter().find(|(k, _)| k == "CUDA_VISIBLE_DEVICES").map(|(_, v)| v.clone());
        self.0.lock().unwrap().push(json!({"kind": "spawn", "file": executable, "args": args, "cwd": cwd, "env": {"CUDA_VISIBLE_DEVICES": cuda}}));
        Ok(Arc::new(Child(watch::channel(None).0)))
    }
}

struct HealthyLoopback(Mutex<usize>);

#[async_trait]
impl Health for HealthyLoopback {
    async fn check(&self, _: u16, api_key: &str) -> bool {
        assert!(!api_key.is_empty());
        *self.0.lock().unwrap() += 1;
        true
    }
    async fn free_port(&self) -> Result<u16, String> {
        Ok(4242)
    }
}

fn slashes(value: &Value, data: &str) -> Value {
    match value {
        Value::String(s) => json!(s.replace('\\', "/").replace(data, "{DATA}")),
        Value::Array(items) => Value::Array(items.iter().map(|v| slashes(v, data)).collect()),
        Value::Object(map) => Value::Object(map.iter().map(|(k, v)| (k.clone(), slashes(v, data))).collect()),
        other => other.clone(),
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn the_model_server_is_launched_the_way_node_launches_it() {
    let host = format!("{}-{}", if cfg!(windows) { "win32" } else if cfg!(target_os = "macos") { "darwin" } else { "linux" }, if cfg!(target_arch = "x86_64") { "x64" } else { "arm64" });
    let mut differences = Differences::default();
    let mut ran = 0;
    for case in twin()["server"].as_array().unwrap() {
        let platform = case["platform"].as_str().unwrap();
        if platform != host {
            // The probe asks the host it runs on; the recording is only comparable on that host.
            continue;
        }
        ran += 1;
        let key = if platform == "win32-x64" { "win32-x64-nvidia" } else { "darwin-arm64-metal" };
        let name = case["name"].as_str().unwrap();
        let dir = tempfile::tempdir().unwrap();
        let log: Log = Arc::default();
        let manager = Arc::new(Scripted { smi: case["smiOutput"].as_str().unwrap().to_owned(), smi_missing: case.get("smiFailure").is_some(), log: log.clone(), replies: Mutex::default() });
        let processes = Processes::new(manager, mixdog_rt::testing::tokens().durability_io);
        let health = Arc::new(HealthyLoopback(Mutex::new(0)));
        let p = provider_with(dir.path(), processes, Arc::new(Capture(log.clone())), health.clone());
        let registered = p.hf.registry().register(&case["model"]).await.unwrap();
        if case.get("weights") != Some(&json!(false)) {
            let weights = vec![1u8; case["weightsBytes"].as_u64().unwrap_or(case["model"]["size"].as_u64().unwrap()) as usize];
            let path = p.catalog.model_path(&registered);
            std::fs::create_dir_all(path.parent().unwrap()).unwrap();
            std::fs::write(path, weights).unwrap();
        }
        if case.get("runtime") != Some(&json!(false)) {
            let executable = p.catalog.runtime_platform_entry(key).unwrap()["executable"].as_str().unwrap().to_owned();
            std::fs::create_dir_all(p.catalog.runtime_directory()).unwrap();
            std::fs::write(p.catalog.runtime_directory().join(executable), "x").unwrap();
        }
        let requested = case.get("requestId").and_then(Value::as_str).unwrap_or(case["model"]["id"].as_str().unwrap());
        let outcome = match p.ensure_server(requested, None).await {
            Ok(_) => json!({"ok": true}),
            Err(e) => json!({"error": e.to_string()}),
        };
        let data = dir.path().to_string_lossy().replace('\\', "/");
        let mut spawns = Vec::new();
        for mut call in log.lock().unwrap().clone() {
            if call["kind"] == "spawn" {
                for (flag, token) in [("--port", "{PORT}"), ("--api-key", "{KEY}")] {
                    let args = call["args"].as_array_mut().unwrap();
                    let at = args.iter().position(|a| a == flag).unwrap();
                    args[at + 1] = json!(token);
                }
            }
            spawns.push(slashes(&call, &data));
        }
        // What `execFile`/`spawn` options Node set that a manager owns (`windowsHide`, `stdio`) is not a Rust concern.
        let strip = |list: &Value| -> Value {
            Value::Array(
                list.as_array()
                    .unwrap()
                    .iter()
                    .map(|c| {
                        let mut c = slashes(c, &data);
                        for field in ["windowsHide", "stdio"] {
                            c.as_object_mut().unwrap().remove(field);
                        }
                        c
                    })
                    .collect(),
            )
        };
        differences.check(&format!("{name}: spawns"), &Value::Array(spawns), &strip(&case["spawns"]));
        // `nvidia-smi` missing carries the OS's own words; only the failure's place is shared.
        if case.get("smiFailure").is_some() {
            let message = outcome["error"].as_str().unwrap_or("");
            if !message.starts_with("[local-provider] GPU detection failed: ") {
                differences.0.push(format!("{name}: {message}"));
            }
        } else {
            differences.check(&format!("{name}: outcome"), &outcome, &case["outcome"]);
        }
        let probes = *health.0.lock().unwrap();
        let expected_probes = case["health"].as_array().unwrap().iter().filter(|h| h["url"].as_str().unwrap().ends_with("/health")).count();
        if probes != expected_probes {
            differences.0.push(format!("{name}: {probes} health probes, Node made {expected_probes}"));
        }
    }
    if ran == 0 {
        eprintln!("no recorded launch is for this host ({host}); nothing compared");
    }
    differences.none();
}
