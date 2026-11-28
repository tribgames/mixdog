//! The words of an exit (`daemon-exit-record.mjs` `describeExit`). The code's words are shared with the core's own exit record
//! (`mixdog_app_server_daemon::crash_record`); a signal is named as Node names it.

/// `describeExit(code, null)`.
pub fn describe_code(code: Option<i32>) -> String {
    let Some(code) = code else { return "exit not observed".to_owned() };
    match code as u32 {
        0x4001_0004 => "terminated externally (DBG_TERMINATE_PROCESS 0x40010004: process-tree/job termination by its parent)".to_owned(),
        0x4001_0005 => "terminated by Ctrl+C (DBG_CONTROL_C 0x40010005)".to_owned(),
        0xC000_013A => "terminated by Ctrl+C / console close (STATUS_CONTROL_C_EXIT 0xC000013A)".to_owned(),
        0 => "exited normally (code 0)".to_owned(),
        _ => format!("exited with code {code}"),
    }
}

/// `describeExit(code, signal)`: a signal first, then the code (`exit not observed` when there is neither).
pub fn describe_exit(code: Option<i32>, signal: Option<&str>) -> String {
    match signal {
        Some(signal) => format!("killed by signal {signal}"),
        None => describe_code(code),
    }
}

/// The name Node reports for a Unix signal number (`SIGKILL`); a number it has no name for is `SIG<n>`.
#[cfg(unix)]
pub fn signal_name(number: i32) -> String {
    let name = match number {
        libc::SIGHUP => "SIGHUP",
        libc::SIGINT => "SIGINT",
        libc::SIGQUIT => "SIGQUIT",
        libc::SIGILL => "SIGILL",
        libc::SIGTRAP => "SIGTRAP",
        libc::SIGABRT => "SIGABRT",
        libc::SIGBUS => "SIGBUS",
        libc::SIGFPE => "SIGFPE",
        libc::SIGKILL => "SIGKILL",
        libc::SIGUSR1 => "SIGUSR1",
        libc::SIGSEGV => "SIGSEGV",
        libc::SIGUSR2 => "SIGUSR2",
        libc::SIGPIPE => "SIGPIPE",
        libc::SIGALRM => "SIGALRM",
        libc::SIGTERM => "SIGTERM",
        _ => return format!("SIG{number}"),
    };
    name.to_owned()
}
