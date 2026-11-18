//! `cleanup` (as 1.4.5 did) lets only its own process run from the install: any other process under it, a second installer
//! included, blocks the removal.

use std::path::PathBuf;
use std::time::Duration;

use super::*;
use crate::control::api::ReplacementBuild;
use crate::server_ensure::args::Mode;
use crate::server_ensure::host::CoreReport;
use crate::server_ensure::host::DrainReport;
use crate::server_ensure::host::Launch;
use crate::server_ensure::host::ProcessImage;
use crate::server_ensure::host::ServerCore;

struct Host {
    home: PathBuf,
    /// Every process running the installed binary.
    processes: Vec<u32>,
}

impl EnsureHost for Host {
    fn home(&self) -> PathBuf {
        self.home.clone()
    }
    fn uid(&self) -> u32 {
        1000
    }
    fn hostname(&self) -> String {
        "h".into()
    }
    fn process_alive(&self, pid: u32) -> bool {
        self.processes.contains(&pid)
    }
    fn process_images(&self) -> Option<Vec<ProcessImage>> {
        let image = RemotePaths::new(&self.home).versions.join("1.4.6-b6").join("mixdogd");
        Some(self.processes.iter().map(|pid| ProcessImage { pid: *pid, image: image.clone() }).collect())
    }
    fn now_ms(&self) -> u64 {
        std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_millis() as u64
    }
    fn pause(&self, _: Duration) {}
}

/// No core answers discovery: nothing to retire.
struct NoCore;

impl CoreAccess for NoCore {
    fn discovery(&self) -> Result<Option<ServerCore>, EnsureError> {
        Ok(None)
    }
    fn answers(&self, _: &ServerCore) -> bool {
        unreachable!()
    }
    fn hold(&self, _: &ServerCore, _: bool) -> Result<(), EnsureError> {
        unreachable!()
    }
    fn stop_when_idle(&self, _: &ServerCore, _: StopReason, _: Option<&ReplacementBuild>) -> Result<Option<DrainReport>, EnsureError> {
        unreachable!()
    }
    fn stop_confirmed(&self, _: &ServerCore, _: StopReason, _: &str, _: Option<&ReplacementBuild>) -> Result<bool, EnsureError> {
        unreachable!()
    }
    fn wait_exit(&self, _: &ServerCore) -> Result<(), EnsureError> {
        unreachable!()
    }
    fn terminate(&self, _: &ServerCore) -> Result<(), EnsureError> {
        unreachable!()
    }
    fn launch(&self, _: &Launch) -> Result<(), EnsureError> {
        unreachable!()
    }
    fn await_core(&self) -> Result<CoreReport, EnsureError> {
        unreachable!()
    }
    fn await_serving(&self, _: &ServerCore, _: std::time::Instant) -> Result<CoreReport, EnsureError> {
        unreachable!()
    }
}

fn remove_args(remove_user_data: bool) -> ProgramArgs {
    ProgramArgs {
        mode: Mode::Cleanup,
        install_id: "1.4.6-b6".into(),
        version: "1.4.6".into(),
        build: "b6".into(),
        upload: false,
        sha256: None,
        confirm_token: None,
        model_login: None,
        phase: Some(CleanupPhase::Remove),
        remove_user_data,
        lock_wait_ms: Some(50),
        lock_stale_ms: None,
        grace_ms: None,
    }
}

fn install(home: &std::path::Path) -> RemotePaths {
    let paths = RemotePaths::new(home);
    std::fs::create_dir_all(paths.versions.join("1.4.6-b6")).unwrap();
    std::fs::create_dir_all(&paths.user_data).unwrap();
    std::fs::write(paths.user_data.join("keep.txt"), "data").unwrap();
    paths
}

#[test]
fn cleanup_succeeds_when_only_this_process_runs_from_the_install_and_refuses_while_any_other_does() {
    let own = std::process::id();
    for remove_user_data in [false, true] {
        let home = tempfile::tempdir().unwrap();
        let paths = install(home.path());
        let host = Host { home: home.path().to_owned(), processes: vec![own] };
        let report = cleanup(&remove_args(remove_user_data), &host, &NoCore).unwrap();
        let result = report.cleanup.unwrap();
        assert!(result.removed.iter().any(|name| name == "versions"), "{result:?}");
        assert_eq!(result.kept.is_empty(), remove_user_data);
        assert!(!paths.versions.exists());
        assert_eq!(paths.user_data.exists(), !remove_user_data);
    }

    // 77 is a core or a second installer: the image cannot tell, and neither may be deleted from under.
    let home = tempfile::tempdir().unwrap();
    let paths = install(home.path());
    let host = Host { home: home.path().to_owned(), processes: vec![own, 77] };
    let error = cleanup(&remove_args(true), &host, &NoCore).unwrap_err();
    assert_eq!(error.code(), "daemon-unproven");
    assert!(error.to_string().contains("pid 77") && !error.to_string().contains(&format!("pid {own}")), "{error}");
    assert!(paths.versions.exists(), "nothing was removed");
}
