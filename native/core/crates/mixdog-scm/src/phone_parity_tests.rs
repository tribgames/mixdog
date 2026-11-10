//! What the phone replay cannot reach: the callers of this core that are not the phone. Everything the phone receives is
//! compared with Node's recording (`apps/desktop/src/renderer/fixtures/phone-scm/golden.json`, b6f10295a) by the replay of
//! `benchmarks/rust-core/recorders/record-phone-scm.mjs --replay <mixdogd.exe>` over a built daemon, one case per recorded call.

use std::sync::Arc;

use async_trait::async_trait;
use mixdog_core_api::CoreError;
use tokio_util::sync::CancellationToken;

use crate::engine::Scm;
/// A machine on which no program starts: git is not installed.
struct NoPrograms(std::sync::Mutex<Option<String>>);

#[async_trait]
impl mixdog_core_api::domain::process::ProcessManager for NoPrograms {
    async fn spawn(
        &self,
        request: mixdog_core_api::domain::process::SpawnRequest,
    ) -> Result<mixdog_core_api::domain::process::SpawnedProcess, mixdog_core_api::domain::process::ProcessError> {
        let mixdog_core_api::domain::process::CommandSpec::Argv { program, .. } = request.command else { panic!("argv") };
        *self.0.lock().unwrap() = Some(program.clone());
        Err(mixdog_core_api::domain::process::ProcessError::ProgramNotFound { program })
    }
    fn subscribe(
        &self,
        _: &mixdog_protocol::ProcessHandle,
        _: Option<u64>,
    ) -> Result<Box<dyn mixdog_core_api::domain::common::EventSource<mixdog_core_api::domain::process::ProcessEvent>>, mixdog_core_api::domain::process::ProcessError> {
        unreachable!("nothing started")
    }
    async fn write_stdin(&self, _: &mixdog_protocol::ProcessHandle, _: Vec<u8>) -> Result<(), mixdog_core_api::domain::process::ProcessError> {
        unreachable!("nothing started")
    }
    fn close_stdin(&self, _: &mixdog_protocol::ProcessHandle) -> Result<(), mixdog_core_api::domain::process::ProcessError> {
        unreachable!("nothing started")
    }
    fn resize_pty(&self, _: &mixdog_protocol::ProcessHandle, _: mixdog_core_api::domain::process::PtySize) -> Result<(), mixdog_core_api::domain::process::ProcessError> {
        unreachable!("nothing started")
    }
    fn kill(&self, _: &mixdog_protocol::ProcessHandle) -> Result<(), mixdog_core_api::domain::process::ProcessError> {
        unreachable!("nothing started")
    }
    fn list(&self) -> Vec<mixdog_core_api::domain::process::ProcessInfo> {
        Vec::new()
    }
}

/// Only the status answer tells a git that could not start apart. A caller that reads the work tree for another purpose (the
/// dirty-paths guard of a reset, the commit's selection) has always been told a git diagnostic under `COMMAND_FAILED`.
#[tokio::test]
async fn a_caller_other_than_status_is_told_a_git_that_could_not_start_as_before() {
    let (_guard, repo, _head) = crate::golden_tests::fixture_repo();
    let programs = Arc::new(NoPrograms(std::sync::Mutex::new(None)));
    let scm = Scm::new(
        programs.clone(),
        mixdog_rt::testing::tokens().maintenance_io,
        std::env::temp_dir().join(format!("mixdog-scm-nogit-{}", std::process::id())),
    );
    let cancel = CancellationToken::new();
    let failure = scm.open(&repo, &cancel).await.unwrap().dirty_paths().await.unwrap_err();
    let CoreError::DomainError { code, message, .. } = CoreError::from(failure) else { panic!("not a domain error") };
    assert_eq!(code.as_deref(), Some("COMMAND_FAILED"));
    // The diagnostic names the program exactly as the manager was asked to start it.
    let asked = programs.0.lock().unwrap().clone().expect("a program was asked for");
    assert_eq!(message.as_deref(), Some(format!("{asked} is not available").as_str()));
}
