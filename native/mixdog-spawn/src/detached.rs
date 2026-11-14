//! A process the core starts and then forgets: Node's
//! `spawn(program, args, { stdio: 'ignore', detached, windowsHide: true })` followed by `unref()`
//! (`runtime/shared/open-url.mjs`, `spawn-flags.mjs` `detachedSpawnOpts`). It is not placed in a
//! job, is not tracked by the manager and is not killed with the core. Its exit is collected by
//! a thread that does nothing else (libuv does the same for Node), so no zombie waits.

use std::process::Command;
use std::process::Stdio;

/// `CREATE_NO_WINDOW`: `windowsHide`. Windows never gets `DETACHED_PROCESS` (it would make the
/// OS ignore the hidden window).
#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

/// Starts `program` with its streams ignored, on Windows without a window and elsewhere as the
/// leader of a session of its own (libuv's `detached`). Answers the pid; the exit is reaped by a
/// thread of its own, whatever the status.
pub fn spawn_detached(program: &str, args: &[String]) -> std::io::Result<u32> {
    let mut command = Command::new(program);
    command.args(args).stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null());
    #[cfg(windows)]
    std::os::windows::process::CommandExt::creation_flags(&mut command, CREATE_NO_WINDOW);
    #[cfg(unix)]
    // SAFETY: the closure only calls the async-signal-safe `setsid`.
    unsafe {
        std::os::unix::process::CommandExt::pre_exec(&mut command, || {
            if libc::setsid() < 0 {
                return Err(std::io::Error::last_os_error());
            }
            Ok(())
        });
    }
    let mut child = command.spawn()?;
    let pid = child.id();
    std::thread::Builder::new().name("detached-reaper".into()).spawn(move || drop(child.wait()))?;
    Ok(pid)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_program_that_cannot_start_is_the_callers_error() {
        let error = spawn_detached("mixdog-no-such-program", &[]).unwrap_err();
        assert_eq!(error.kind(), std::io::ErrorKind::NotFound);
    }

    #[test]
    fn a_started_program_runs_on_its_own() {
        let (program, args): (&str, Vec<String>) = if cfg!(windows) { ("cmd.exe", vec!["/C".into(), "exit 0".into()]) } else { ("true", Vec::new()) };
        assert!(spawn_detached(program, &args).unwrap() > 0);
    }
}
