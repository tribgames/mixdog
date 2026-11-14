//! A process's fate as the OS proves it (ProcessFate, MixWin32Process.cs:
//! 266-294; Do-ProcessFate, runtime-saved-login.ps1:330-347). It reads the
//! process object only and never touches the desktop.

use super::native::Process;
use serde_json::{json, Value};
use windows::Win32::Foundation::{
    ERROR_INVALID_PARAMETER, FILETIME, HANDLE, WAIT_OBJECT_0, WAIT_TIMEOUT,
};
use windows::Win32::System::Threading::{
    GetProcessTimes, OpenProcess, WaitForSingleObject, PROCESS_QUERY_LIMITED_INFORMATION,
    PROCESS_SYNCHRONIZE,
};

#[derive(Clone, Copy, Debug, PartialEq)]
enum State {
    /// Never read as ended.
    Unknown,
    Running,
    Ended,
}

impl State {
    fn name(self) -> &'static str {
        match self {
            State::Unknown => "unknown",
            State::Running => "running",
            State::Ended => "ended",
        }
    }
}

/// What the system answered about a process id.
#[derive(Clone, Copy)]
enum Probe {
    /// The id could not be opened; `no_such_process` when the system says no
    /// process has it (ERROR_INVALID_PARAMETER, measured for an exited one).
    Unopened { no_such_process: bool },
    /// `created` is the creation FILETIME, 0 when it could not be read;
    /// `signaled` whether the process object signals its exit, None when the
    /// wait answered neither.
    Opened { created: i64, signaled: Option<bool> },
}

/// {state: unknown | running | ended, created: FILETIME text}. `created`
/// binds the answer to the exact process; empty means whichever process has
/// the id now.
pub fn fate(pid: &str, created: &str) -> Value {
    let Some((pid, expected)) = parse(pid, created) else {
        return crate::platform::unknown_process_fate();
    };
    let (state, created) = if pid == 0 {
        (State::Unknown, 0)
    } else {
        decide(probe(pid), expected)
    };
    // A FILETIME exceeds a JSON number's exact range, so it travels as text.
    let created = if created == 0 {
        String::new()
    } else {
        created.to_string()
    };
    json!({ "state": state.name(), "created": created })
}

/// The pid and the expected creation time (0: any) as the request's text
/// gives them; None when either does not parse.
fn parse(pid: &str, created: &str) -> Option<(u32, i64)> {
    let pid = pid.trim().parse::<u32>().ok()?;
    let expected = if created.is_empty() {
        0
    } else {
        created.trim().parse::<i64>().ok()?
    };
    Some((pid, expected))
}

/// Ended means: no process has the id, the id now names a process created at
/// another time (an id is unique among live processes), or the process object
/// is signaled. The second value is the creation time read, or 0.
fn decide(probe: Probe, expected: i64) -> (State, i64) {
    match probe {
        Probe::Unopened { no_such_process: true } => (State::Ended, 0),
        Probe::Unopened { no_such_process: false } => (State::Unknown, 0),
        Probe::Opened { created: 0, .. } => (State::Unknown, 0),
        Probe::Opened { created, .. } if expected != 0 && created != expected => {
            (State::Ended, created)
        }
        Probe::Opened { created, signaled } => (
            match signaled {
                Some(true) => State::Ended,
                Some(false) => State::Running,
                None => State::Unknown,
            },
            created,
        ),
    }
}

fn probe(pid: u32) -> Probe {
    // SAFETY: a plain open; the handle is owned by `process` below.
    let opened = unsafe {
        OpenProcess(
            PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_SYNCHRONIZE,
            false,
            pid,
        )
    };
    let process = match opened {
        Ok(handle) => Process(handle),
        Err(error) => {
            return Probe::Unopened {
                no_such_process: error.code() == ERROR_INVALID_PARAMETER.to_hresult(),
            }
        }
    };
    let created = creation_time(process.0);
    // SAFETY: the handle is open with SYNCHRONIZE; a zero timeout only polls.
    let wait = unsafe { WaitForSingleObject(process.0, 0) };
    let signaled = match wait {
        WAIT_OBJECT_0 => Some(true),
        WAIT_TIMEOUT => Some(false),
        _ => None,
    };
    Probe::Opened { created, signaled }
}

/// The process's creation FILETIME, 0 when it cannot be read.
pub(super) fn creation_time(process: HANDLE) -> i64 {
    let mut times = [FILETIME::default(); 4];
    let [created, exited, kernel, user] = &mut times;
    // SAFETY: four valid out pointers.
    if unsafe { GetProcessTimes(process, created, exited, kernel, user) }.is_err() {
        return 0;
    }
    ((created.dwHighDateTime as i64) << 32) | created.dwLowDateTime as i64
}

#[cfg(test)]
mod tests {
    use super::*;

    const CREATED: i64 = 133_750_000_000_000_000;

    fn opened(created: i64, signaled: Option<bool>) -> Probe {
        Probe::Opened { created, signaled }
    }

    #[test]
    fn a_process_that_does_not_signal_is_running() {
        assert_eq!(decide(opened(CREATED, Some(false)), 0), (State::Running, CREATED));
        assert_eq!(decide(opened(CREATED, Some(false)), CREATED), (State::Running, CREATED));
    }

    #[test]
    fn a_signaled_process_or_a_missing_id_has_ended() {
        // A handle someone still holds keeps the id openable after the exit.
        assert_eq!(decide(opened(CREATED, Some(true)), CREATED), (State::Ended, CREATED));
        assert_eq!(decide(Probe::Unopened { no_such_process: true }, CREATED), (State::Ended, 0));
    }

    #[test]
    fn an_id_reused_by_a_process_created_at_another_time_has_ended() {
        let reused = opened(CREATED + 1, Some(false));
        assert_eq!(decide(reused, CREATED), (State::Ended, CREATED + 1));
        // Without an expected time the id's current process answers.
        assert_eq!(decide(reused, 0), (State::Running, CREATED + 1));
    }

    #[test]
    fn what_the_system_does_not_prove_is_unknown_never_ended() {
        // Access denied, for one.
        assert_eq!(decide(Probe::Unopened { no_such_process: false }, CREATED), (State::Unknown, 0));
        // No creation time read: even a signaled handle proves nothing.
        assert_eq!(decide(opened(0, Some(true)), CREATED), (State::Unknown, 0));
        assert_eq!(decide(opened(CREATED, None), CREATED), (State::Unknown, CREATED));
    }

    #[test]
    fn the_pid_and_creation_time_travel_as_text() {
        assert_eq!(parse("4242", ""), Some((4242, 0)));
        assert_eq!(parse(" 4242 ", "133750000000000000"), Some((4242, CREATED)));
        assert_eq!(parse("x", ""), None);
        assert_eq!(parse("-1", ""), None);
        assert_eq!(parse("", ""), None);
        assert_eq!(parse("4242", "y"), None);
    }

    #[test]
    fn unparsable_text_and_pid_zero_answer_unknown_without_a_read() {
        let unknown = json!({ "state": "unknown", "created": "" });
        assert_eq!(fate("x", ""), unknown);
        assert_eq!(fate("42", "y"), unknown);
        assert_eq!(fate("0", ""), unknown);
    }

    // The two tests below read process objects only: this process, and a
    // windowless child they start themselves.

    #[test]
    fn this_process_is_running_and_bound_to_its_creation_time() {
        let pid = std::process::id().to_string();
        let running = fate(&pid, "");
        assert_eq!(running["state"], json!("running"));
        let created = running["created"].as_str().unwrap_or_default().to_string();
        assert!(created.parse::<i64>().is_ok_and(|created| created > 0), "{running}");
        assert_eq!(fate(&pid, &created), running);
        // The same id created at another time is another process.
        assert_eq!(fate(&pid, "1"), json!({ "state": "ended", "created": created }));
    }

    #[test]
    fn a_child_that_exited_has_ended_while_its_handle_keeps_the_id() {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        let mut child = std::process::Command::new("cmd")
            .args(["/c", "exit", "0"])
            .creation_flags(CREATE_NO_WINDOW)
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .spawn()
            .expect("cmd starts");
        let pid = child.id().to_string();
        child.wait().expect("cmd exits");
        // `child` still holds the process handle, so the id is not reused.
        assert_eq!(fate(&pid, "")["state"], json!("ended"));
        drop(child);
    }
}
