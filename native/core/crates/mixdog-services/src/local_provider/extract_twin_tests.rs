//! Node-recorded twin `fixtures/services/extract-archive-twin.json`
//! (`benchmarks/rust-core/recorders/record-extract-archive.mjs`): what `asset-installer.mjs`
//! hands the OS to unpack a runtime archive and the text of each failure. Rust
//! `extract_archive` must ask for the same and fail with the same words. `MIXDOG_FIXTURES_ROOT`
//! overrides the fixture location.

use std::collections::{HashMap, VecDeque};
use std::path::Path;
use std::sync::{Arc, Mutex};

use async_trait::async_trait;
use mixdog_core_api::domain::common::EventSource;
use mixdog_core_api::domain::process::{CommandSpec, ExitStatus, OutputStream, ProcessError, ProcessEvent, ProcessExit, ProcessInfo, ProcessManager, PtySize, SpawnRequest, SpawnedProcess};
use mixdog_protocol::ProcessHandle;
use serde_json::{Value, json};
use tokio_util::sync::CancellationToken;

use super::assets::extract_archive;
use crate::tidy::process::Processes;

fn twin() -> Value {
    let root = std::env::var("MIXDOG_FIXTURES_ROOT").unwrap_or_else(|_| concat!(env!("CARGO_MANIFEST_DIR"), "/../../fixtures").to_owned());
    serde_json::from_str(&std::fs::read_to_string(format!("{root}/services/extract-archive-twin.json")).unwrap()).unwrap()
}

struct Replay(VecDeque<ProcessEvent>);

#[async_trait]
impl EventSource<ProcessEvent> for Replay {
    async fn next(&mut self) -> Option<ProcessEvent> {
        self.0.pop_front()
    }
}

/// Runs nothing: logs the spawn and answers the scripted output and exit code.
struct Scripted {
    output: Vec<(OutputStream, String)>,
    code: i32,
    log: Mutex<Vec<Value>>,
    replies: Mutex<HashMap<String, VecDeque<ProcessEvent>>>,
}

#[async_trait]
impl ProcessManager for Scripted {
    async fn spawn(&self, request: SpawnRequest) -> Result<SpawnedProcess, ProcessError> {
        let CommandSpec::Argv { program, args } = &request.command else { panic!("argv expected") };
        let env = |key: &str| request.env.set.iter().find(|(k, _)| k == key).map(|(_, v)| v.clone());
        self.log.lock().unwrap().push(json!({"command": program, "args": args, "archiveEnv": env("MIXDOG_LOCAL_ARCHIVE"), "destinationEnv": env("MIXDOG_LOCAL_DESTINATION")}));
        let mut events: VecDeque<ProcessEvent> = self.output.iter().enumerate().map(|(i, (stream, text))| ProcessEvent::Output { seq: i as u64, stream: stream.clone(), bytes: text.clone().into_bytes() }).collect();
        events.push_back(ProcessEvent::Exited { seq: events.len() as u64, exit: ProcessExit { status: ExitStatus::Code(self.code), killed: None } });
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

#[tokio::test(flavor = "multi_thread")]
async fn extraction_asks_the_os_and_fails_the_way_node_does() {
    let twin = twin();
    let mut differences = Vec::new();
    for case in twin["cases"].as_array().unwrap() {
        let name = case["name"].as_str().unwrap();
        let output = case["output"].as_array().unwrap().iter().map(|o| (if o[0] == "stdout" { OutputStream::Stdout } else { OutputStream::Stderr }, o[1].as_str().unwrap().to_owned())).collect::<Vec<_>>();
        let manager = Arc::new(Scripted { output, code: case["code"].as_i64().unwrap() as i32, log: Mutex::default(), replies: Mutex::default() });
        let processes = Processes::new(manager.clone(), mixdog_rt::testing::tokens().durability_io);
        let result = extract_archive(&processes, Path::new(case["archive"].as_str().unwrap()), Path::new(case["destination"].as_str().unwrap()), &CancellationToken::new()).await;
        let outcome = match &result {
            Ok(()) => json!({"ok": true}),
            Err(e) => json!({"ok": false, "message": e.to_string()}),
        };
        let call = manager.log.lock().unwrap().first().cloned().unwrap_or(Value::Null);
        let expected = &case["call"];
        for field in ["command", "args", "archiveEnv", "destinationEnv"] {
            if call[field] != expected[field] {
                differences.push(format!("{name}: {field} {} != Node {}", call[field], expected[field]));
            }
        }
        // Node appends every chunk of either stream to one log in arrival order; so does the runner's
        // `combined`, so even the interleaved case matches exactly.
        if outcome != case["outcome"] {
            differences.push(format!("{name}: {} != Node {}", outcome.to_string().chars().take(200).collect::<String>(), case["outcome"].to_string().chars().take(200).collect::<String>()));
        }
    }
    assert!(differences.is_empty(), "{} differences:\n{}", differences.len(), differences.join("\n"));
}

#[tokio::test(flavor = "multi_thread")]
async fn an_aborted_extraction_spawns_nothing() {
    let manager = Arc::new(Scripted { output: Vec::new(), code: 0, log: Mutex::default(), replies: Mutex::default() });
    let processes = Processes::new(manager.clone(), mixdog_rt::testing::tokens().durability_io);
    let cancel = CancellationToken::new();
    cancel.cancel();
    let result = extract_archive(&processes, Path::new("/a.tar.gz"), Path::new("/s"), &cancel).await;
    assert!(matches!(result, Err(super::assets::AssetError::Aborted)));
    // Node throws before it spawns (`signal?.throwIfAborted()`); the recorded `aborted.spawned` is false.
    assert_eq!(manager.log.lock().unwrap().len(), 0, "an aborted extraction must not spawn");
}
