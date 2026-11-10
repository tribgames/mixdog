//! What the phone replay cannot reach: the callers of this core that are not the phone. Everything the phone receives is
//! compared with Node's recording (`apps/desktop/src/renderer/fixtures/phone-scm/golden.json`, b6f10295a) by the replay of
//! `benchmarks/rust-core/recorders/record-phone-scm.mjs --replay <mixdogd.exe>` over a built daemon, one case per recorded call.

use std::sync::Arc;

use async_trait::async_trait;
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

/// The dirty-paths guard of a reset or cherry-pick reads the work tree as Node's `assertCleanWorktree` does (git-branches.ts:92):
/// a status that cannot read the repository yields no files, and the first git command after it reports the missing git.
#[tokio::test]
async fn the_dirty_guard_finds_nothing_when_git_cannot_start() {
    let (_guard, repo, _head) = crate::golden_tests::fixture_repo();
    let programs = Arc::new(NoPrograms(std::sync::Mutex::new(None)));
    let scm = Scm::new(
        programs.clone(),
        mixdog_rt::testing::tokens().maintenance_io,
        std::env::temp_dir().join(format!("mixdog-scm-nogit-{}", std::process::id())),
    );
    let cancel = CancellationToken::new();
    let dirty = scm.open(&repo, &cancel).await.unwrap().dirty_paths().await.unwrap();
    assert!(dirty.is_empty(), "{dirty:?}");
    assert!(programs.0.lock().unwrap().is_some(), "git was never asked for");
}
