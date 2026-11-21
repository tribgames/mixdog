//! A request with invalid SCM input answers the first validation error, in the order the checks run, and starts no program.

use std::sync::Arc;
use std::sync::atomic::AtomicUsize;
use std::sync::atomic::Ordering;

use async_trait::async_trait;
use mixdog_core_api::CoreError;
use mixdog_core_api::CoreRequest;
use mixdog_core_api::DomainService;
use mixdog_core_api::call::CallContext;
use mixdog_core_api::domain::common::EventSource;
use mixdog_core_api::domain::process::ProcessError;
use mixdog_core_api::domain::process::ProcessEvent;
use mixdog_core_api::domain::process::ProcessInfo;
use mixdog_core_api::domain::process::ProcessManager;
use mixdog_core_api::domain::process::PtySize;
use mixdog_core_api::domain::process::SpawnRequest;
use mixdog_core_api::domain::process::SpawnedProcess;
use mixdog_core_api::ids::ConnectionId;
use mixdog_core_api::ids::Method;
use mixdog_protocol::ProcessHandle;
use serde_json::json;

use crate::review_dispatch_tests::Log;
use crate::review_dispatch_tests::service_over;

/// Starts nothing and counts every program it was asked to start.
#[derive(Default)]
struct NoPrograms(AtomicUsize);

#[async_trait]
impl ProcessManager for NoPrograms {
    async fn spawn(&self, request: SpawnRequest) -> Result<SpawnedProcess, ProcessError> {
        self.0.fetch_add(1, Ordering::SeqCst);
        Err(ProcessError::ProgramNotFound { program: format!("{:?}", request.command) })
    }
    fn subscribe_holding(&self, handle: &ProcessHandle, from_seq: Option<u64>) -> Result<Box<dyn EventSource<ProcessEvent>>, ProcessError> {
        self.subscribe(handle, from_seq)
    }
    fn subscribe(&self, _handle: &ProcessHandle, _from_seq: Option<u64>) -> Result<Box<dyn EventSource<ProcessEvent>>, ProcessError> {
        Err(ProcessError::AlreadyExited)
    }
    async fn write_stdin(&self, _handle: &ProcessHandle, _bytes: Vec<u8>) -> Result<(), ProcessError> {
        Err(ProcessError::AlreadyExited)
    }
    fn close_stdin(&self, _handle: &ProcessHandle) -> Result<(), ProcessError> {
        Err(ProcessError::AlreadyExited)
    }
    fn resize_pty(&self, _handle: &ProcessHandle, _size: PtySize) -> Result<(), ProcessError> {
        Err(ProcessError::AlreadyExited)
    }
    fn kill(&self, _handle: &ProcessHandle) -> Result<(), ProcessError> {
        Err(ProcessError::AlreadyExited)
    }
    fn list(&self) -> Vec<ProcessInfo> {
        Vec::new()
    }
}

/// `git/applyPatch` with an invalid direction and an invalid directory: the direction is checked first.
#[tokio::test]
async fn the_first_invalid_argument_answers_and_no_program_starts() {
    let programs = Arc::new(NoPrograms::default());
    let handle = service_over(programs.clone(), Log::default());
    let params = json!({ "cwd": 5, "path": "a.txt", "patch": "p", "reverse": "yes" });
    let ctx = CallContext::connection(ConnectionId(1), mixdog_protocol::Origin::Local, Default::default());
    let answer = handle.call(CoreRequest { method: Method("git/applyPatch"), params, op: None, ctx }).await;
    let expected = CoreError::DomainError {
        domain: "git".into(),
        code: Some("COMMAND_FAILED".into()),
        message: Some("git patch direction is invalid.".into()),
        detail: None,
    };
    assert_eq!(answer.err(), Some(expected));
    assert_eq!(programs.0.load(Ordering::SeqCst), 0);
}

#[test]
fn a_revision_is_rebuilt_from_its_checked_hash() {
    assert_eq!(crate::input::revision(" abcd ^ ").expect("a hash and its parent mark"), "abcd^");
    assert_eq!(crate::input::revision(" HEAD ").expect("HEAD"), "HEAD");
    assert_eq!(crate::input::revision("ABCDEF12").expect("a hash"), "ABCDEF12");
}
