//! Unpacking a downloaded runtime archive: what the OS is asked to do, and what a failure says.

use std::collections::{HashMap, VecDeque};
use std::path::Path;
use std::sync::{Arc, Mutex};

use async_trait::async_trait;
use mixdog_core_api::domain::common::EventSource;
use mixdog_core_api::domain::process::{
    CommandSpec, ExitStatus, OutputStream, ProcessError, ProcessEvent, ProcessExit, ProcessInfo, ProcessManager, PtySize, SpawnRequest, SpawnedProcess,
};
use mixdog_protocol::ProcessHandle;
use tokio_util::sync::CancellationToken;

use super::assets::{AssetError, extract_archive};
use crate::tidy::process::Processes;

struct Replay(VecDeque<ProcessEvent>);

#[async_trait]
impl EventSource<ProcessEvent> for Replay {
    async fn next(&mut self) -> Option<ProcessEvent> {
        self.0.pop_front()
    }
}

/// A call as the manager saw it: program, arguments and the two archive variables.
type Call = (String, Vec<String>, Option<String>, Option<String>);

/// Runs nothing: records the spawn and answers the scripted output and exit code.
struct Scripted {
    output: Vec<(OutputStream, &'static str)>,
    code: i32,
    log: Mutex<Vec<Call>>,
    replies: Mutex<HashMap<String, VecDeque<ProcessEvent>>>,
}

fn scripted(output: Vec<(OutputStream, &'static str)>, code: i32) -> Arc<Scripted> {
    Arc::new(Scripted { output, code, log: Mutex::default(), replies: Mutex::default() })
}

#[async_trait]
impl ProcessManager for Scripted {
    async fn spawn(&self, request: SpawnRequest) -> Result<SpawnedProcess, ProcessError> {
        let CommandSpec::Argv { program, args } = &request.command else { panic!("argv expected") };
        let env = |key: &str| request.env.set.iter().find(|(k, _)| k == key).map(|(_, v)| v.clone());
        self.log.lock().unwrap().push((program.clone(), args.clone(), env("MIXDOG_LOCAL_ARCHIVE"), env("MIXDOG_LOCAL_DESTINATION")));
        let mut events: VecDeque<ProcessEvent> = self
            .output
            .iter()
            .enumerate()
            .map(|(i, (stream, text))| ProcessEvent::Output { seq: i as u64, stream: stream.clone(), bytes: text.as_bytes().to_vec() })
            .collect();
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

async fn extract(manager: &Arc<Scripted>, archive: &str) -> Result<(), AssetError> {
    let processes = Processes::new(manager.clone(), mixdog_rt::testing::tokens().durability_io);
    extract_archive(&processes, Path::new(archive), Path::new("/dest"), &CancellationToken::new()).await
}

#[tokio::test(flavor = "multi_thread")]
async fn an_aborted_extraction_spawns_nothing() {
    let manager = scripted(Vec::new(), 0);
    let processes = Processes::new(manager.clone(), mixdog_rt::testing::tokens().durability_io);
    let cancel = CancellationToken::new();
    cancel.cancel();
    let result = extract_archive(&processes, Path::new("/a.tar.gz"), Path::new("/s"), &cancel).await;
    assert!(matches!(result, Err(AssetError::Aborted)));
    assert!(manager.log.lock().unwrap().is_empty());
}

#[tokio::test(flavor = "multi_thread")]
async fn a_zip_is_expanded_by_powershell_from_variables_and_a_tarball_by_tar() {
    let manager = scripted(Vec::new(), 0);
    extract(&manager, "/pkg/runtime.zip").await.unwrap();
    extract(&manager, "/pkg/runtime.tar.gz").await.unwrap();
    let log = manager.log.lock().unwrap();
    let (program, args, archive, destination) = &log[0];
    assert_eq!(program, "powershell");
    assert!(args.last().unwrap().contains("Expand-Archive -LiteralPath $env:MIXDOG_LOCAL_ARCHIVE -DestinationPath $env:MIXDOG_LOCAL_DESTINATION -Force"));
    assert_eq!(
        (archive.as_deref(), destination.as_deref()),
        (Some("/pkg/runtime.zip"), Some("/dest")),
        "paths travel in the environment, not the command line"
    );
    assert_eq!(log[1], ("tar".to_owned(), ["-xzf", "/pkg/runtime.tar.gz", "-C", "/dest"].map(String::from).to_vec(), None, None));
}

#[tokio::test(flavor = "multi_thread")]
async fn a_failed_extraction_reports_what_the_tool_printed_in_the_order_it_printed_it() {
    let manager = scripted(vec![(OutputStream::Stdout, "unpacking\n"), (OutputStream::Stderr, "tar: bad archive\n")], 2);
    let error = extract(&manager, "/pkg/runtime.tar.gz").await.unwrap_err();
    assert_eq!(error.to_string(), "[local-provider] runtime extraction failed: unpacking\ntar: bad archive\n");
}

#[tokio::test(flavor = "multi_thread")]
async fn a_failed_extraction_that_printed_nothing_reports_its_status() {
    let error = extract(&scripted(Vec::new(), 7), "/pkg/runtime.tar.gz").await.unwrap_err();
    assert_eq!(error.to_string(), "[local-provider] runtime extraction failed: status 7");
}
