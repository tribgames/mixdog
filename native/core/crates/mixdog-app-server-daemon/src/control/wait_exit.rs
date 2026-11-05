//! `mixdogd ctl wait-exit --pid <pid> --start-time <t>`: returns when that process exits.
//!
//! The updater and fast deploy wait for the old core with this instead of polling
//! `kill(pid, 0)`: the OS reports the exit through a process handle opened on the identity
//! (pid and the discovery `processStartTime`), so a reused pid is never waited on.

use crate::verdict::ProcessIdentity;

/// Returns once the process is gone (at once when it already is).
pub fn wait_exit(pid: u32, start_time: u64) -> std::io::Result<()> {
    crate::verdict::wait_for_exit(ProcessIdentity { pid, start_ms: start_time })
}

#[cfg(test)]
#[allow(clippy::disallowed_methods, clippy::disallowed_types, reason = "test fixture spawns a real process")]
mod tests {
    use std::process::Command;
    use std::process::Stdio;

    use super::*;
    use crate::verdict::OsProcessTable;
    use crate::verdict::ProcessTable;

    fn sleeper() -> Command {
        #[cfg(windows)]
        let mut command = Command::new("powershell.exe");
        #[cfg(windows)]
        command.args(["-NoProfile", "-Command", "Start-Sleep -Seconds 2"]);
        #[cfg(unix)]
        let mut command = Command::new("sleep");
        #[cfg(unix)]
        command.arg("2");
        command.stdout(Stdio::null()).stderr(Stdio::null());
        command
    }

    #[test]
    fn returns_when_the_process_exits_and_at_once_for_a_reused_pid() {
        let mut child = sleeper().spawn().unwrap();
        let identity = OsProcessTable.query(u64::from(child.id())).unwrap().unwrap().identity;
        // A start time that is not this process's: the pid names someone else.
        wait_exit(identity.pid, identity.start_ms + 1).unwrap();
        assert!(child.try_wait().unwrap().is_none(), "a different identity is not waited on");
        let waiter = std::thread::spawn(move || wait_exit(identity.pid, identity.start_ms));
        child.wait().unwrap();
        waiter.join().unwrap().unwrap();
        wait_exit(identity.pid, identity.start_ms).unwrap();
    }
}
