//! The words of an exit (`daemon-exit-record.mjs` `describeExit`). The code's words are the core's own, shared with its exit
//! record; a signal is named as Node names it.

use mixdog_app_server_daemon::crash_record::describe_exit as describe_code;

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
