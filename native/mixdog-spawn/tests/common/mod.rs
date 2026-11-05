#![allow(dead_code)]
//! Helpers shared by the library's integration tests. They start real processes.

use std::path::PathBuf;
use std::time::Duration;

use mixdog_core_api::domain::common::AbsPath;
use mixdog_core_api::domain::process::CommandSpec;
use mixdog_core_api::domain::process::EnvSpec;
use mixdog_core_api::domain::process::OutputMode;
use mixdog_core_api::domain::process::ProcessEvent;
use mixdog_core_api::domain::process::ProcessExit;
use mixdog_core_api::domain::process::ProcessManager;
use mixdog_core_api::domain::process::ProcessOwner;
use mixdog_core_api::domain::process::PtySize;
use mixdog_core_api::domain::process::SpawnRequest;
use mixdog_protocol::ProcessHandle;
use mixdog_spawn::LocalProcessManager;
use mixdog_spawn::ProcessConfig;

pub const WAIT: Duration = Duration::from_secs(60);

pub fn manager() -> LocalProcessManager {
    manager_with(ProcessConfig::default())
}

pub fn manager_with(config: ProcessConfig) -> LocalProcessManager {
    LocalProcessManager::new(mixdog_rt::testing::tokens().spawn_io, config)
}

pub fn handle(name: &str) -> ProcessHandle {
    ProcessHandle::from(format!("{name}-{}", std::process::id()))
}

pub fn temp_dir() -> AbsPath {
    AbsPath::new(std::env::temp_dir()).expect("the temp dir is absolute")
}

pub fn scratch_dir(name: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("mixdog-spawn-{name}-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

/// `script` for the platform's plain shell (`cmd` on Windows, `sh` elsewhere).
pub fn shell(script_windows: &str, script_unix: &str) -> CommandSpec {
    if cfg!(windows) {
        CommandSpec::Shell {
            script: script_windows.to_owned(),
            shell: Some("cmd".to_owned()),
        }
    } else {
        CommandSpec::Shell {
            script: script_unix.to_owned(),
            shell: None,
        }
    }
}

pub fn request(handle: &ProcessHandle, command: CommandSpec) -> SpawnRequest {
    SpawnRequest {
        handle: handle.clone(),
        command,
        cwd: temp_dir(),
        env: EnvSpec {
            inherit: true,
            ..EnvSpec::default()
        },
        pty: None,
        stdin_piped: false,
        output: OutputMode::Merged,
        owner: ProcessOwner::Internal,
        time_limit: None,
    }
}

pub fn pty_request(handle: &ProcessHandle, command: CommandSpec, size: PtySize) -> SpawnRequest {
    SpawnRequest {
        pty: Some(size),
        stdin_piped: true,
        ..request(handle, command)
    }
}

/// All output of `handle` up to its exit, and the exit.
pub async fn collect(manager: &LocalProcessManager, handle: &ProcessHandle) -> (Vec<u8>, ProcessExit) {
    tokio::time::timeout(WAIT, async {
        let mut events = manager.subscribe(handle, Some(0)).expect("subscribe");
        let mut bytes = Vec::new();
        loop {
            match events.next().await.expect("the feed ends with the exit event") {
                ProcessEvent::Output { bytes: chunk, .. } => bytes.extend(chunk),
                ProcessEvent::Exited { exit, .. } => return (bytes, exit),
            }
        }
    })
    .await
    .expect("the process exits in time")
}

pub fn text(bytes: &[u8]) -> String {
    String::from_utf8_lossy(bytes).into_owned()
}

/// Threads of this test process.
pub fn thread_count() -> usize {
    #[cfg(windows)]
    {
        use windows_sys::Win32::Foundation::CloseHandle;
        use windows_sys::Win32::Foundation::INVALID_HANDLE_VALUE;
        use windows_sys::Win32::System::Diagnostics::ToolHelp::CreateToolhelp32Snapshot;
        use windows_sys::Win32::System::Diagnostics::ToolHelp::TH32CS_SNAPTHREAD;
        use windows_sys::Win32::System::Diagnostics::ToolHelp::THREADENTRY32;
        use windows_sys::Win32::System::Diagnostics::ToolHelp::Thread32First;
        use windows_sys::Win32::System::Diagnostics::ToolHelp::Thread32Next;
        unsafe {
            let snapshot = CreateToolhelp32Snapshot(TH32CS_SNAPTHREAD, 0);
            assert_ne!(snapshot, INVALID_HANDLE_VALUE);
            let mut entry: THREADENTRY32 = std::mem::zeroed();
            entry.dwSize = std::mem::size_of::<THREADENTRY32>() as u32;
            let pid = std::process::id();
            let mut count = 0;
            let mut more = Thread32First(snapshot, &mut entry);
            while more != 0 {
                if entry.th32OwnerProcessID == pid {
                    count += 1;
                }
                more = Thread32Next(snapshot, &mut entry);
            }
            CloseHandle(snapshot);
            count
        }
    }
    #[cfg(target_os = "linux")]
    {
        std::fs::read_to_string("/proc/self/status")
            .unwrap()
            .lines()
            .find_map(|l| l.strip_prefix("Threads:"))
            .and_then(|n| n.trim().parse().ok())
            .unwrap()
    }
    #[cfg(not(any(windows, target_os = "linux")))]
    {
        0
    }
}

pub fn pid_alive(pid: u32) -> bool {
    #[cfg(windows)]
    unsafe {
        use windows_sys::Win32::Foundation::CloseHandle;
        use windows_sys::Win32::System::Threading::GetExitCodeProcess;
        use windows_sys::Win32::System::Threading::OpenProcess;
        use windows_sys::Win32::System::Threading::PROCESS_QUERY_LIMITED_INFORMATION;
        let process = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
        if process.is_null() {
            return false;
        }
        let mut code = 0u32;
        let ok = GetExitCodeProcess(process, &mut code);
        CloseHandle(process);
        ok != 0 && code == 259
    }
    #[cfg(unix)]
    unsafe {
        libc::kill(pid as i32, 0) == 0
    }
}

pub fn fixture(relative: &str) -> serde_json::Value {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join(relative);
    serde_json::from_slice(&std::fs::read(&path).unwrap_or_else(|e| panic!("{}: {e}", path.display())))
        .expect("fixture is JSON")
}
