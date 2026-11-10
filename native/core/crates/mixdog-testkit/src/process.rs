//! Helper processes for tests.

use std::path::Path;
use std::process::Child;
use std::process::Command;
use std::process::Stdio;

/// The pid of a process that has exited.
pub fn dead_pid() -> u32 {
    #[cfg(windows)]
    let mut child = Command::new("cmd").args(["/c", "exit"]).spawn().expect("spawn cmd");
    #[cfg(unix)]
    let mut child = Command::new("true").spawn().expect("spawn true");
    let pid = child.id();
    child.wait().expect("wait");
    pid
}

/// Runs `program` and returns its stdout as text; panics when it cannot start.
pub fn output(program: impl AsRef<std::ffi::OsStr>, args: &[&std::ffi::OsStr]) -> String {
    let out = Command::new(program).args(args).output().expect("run helper process");
    String::from_utf8(out.stdout).expect("utf-8 stdout")
}

/// Starts `program` with piped stdout.
pub fn spawn_piped(program: impl AsRef<std::ffi::OsStr>, args: &[&std::ffi::OsStr]) -> Child {
    Command::new(program).args(args).stdout(Stdio::piped()).spawn().expect("spawn helper process")
}

/// Runs `git <args>` in `dir`; panics unless it succeeds. Returns stdout.
pub fn git(dir: &Path, args: &[&str]) -> String {
    let out = Command::new("git").arg("-C").arg(dir).args(args).output().expect("run git");
    assert!(out.status.success(), "git {args:?}: {}", String::from_utf8_lossy(&out.stderr));
    String::from_utf8(out.stdout).expect("utf-8 stdout")
}
