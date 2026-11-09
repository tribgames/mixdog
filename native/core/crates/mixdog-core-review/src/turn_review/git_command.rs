//! The program a git timeout message names: `run-child.mjs` words it `${command} ${args} timed out
//! after ${ms}ms` with the `command` `git-launch.mjs` `gitCommand()` hands it. On Windows that is
//! the real `git.exe` behind the Git for Windows launcher PATH's `git` names (`resolveGitLaunch`),
//! and plain `git` for anything else.

use std::ffi::OsStr;
#[cfg(windows)]
use std::path::Path;
use std::path::PathBuf;

/// The `MSYSTEM` directories of Git for Windows' wrapper, lower-cased.
#[cfg(windows)]
const MSYSTEM_DIRECTORIES: [&str; 3] = ["mingw64", "clangarm64", "mingw32"];

/// `gitCommand()` for the process's own PATH.
pub fn git_command() -> String {
    git_command_for(std::env::var_os("PATH").as_deref())
}

pub fn git_command_for(path: Option<&OsStr>) -> String {
    launch_command(path).map_or_else(|| "git".to_owned(), |command| command.to_string_lossy().into_owned())
}

#[cfg(not(windows))]
fn launch_command(_: Option<&OsStr>) -> Option<PathBuf> {
    None
}

/// `resolveGitLaunch().command`: libuv's search for a bare `git` (each PATH entry in order,
/// `git.com` before `git.exe`), then the install layout around the launcher it finds.
#[cfg(windows)]
fn launch_command(path: Option<&OsStr>) -> Option<PathBuf> {
    let found = launcher_on_path(&path?.to_string_lossy())?;
    let launcher = strip_verbatim(std::fs::canonicalize(found).ok()?);
    if !launcher.file_name()?.eq_ignore_ascii_case("git.exe") {
        return None;
    }
    let directory = launcher.parent()?;
    if !["cmd", "bin"].iter().any(|name| directory.file_name().is_some_and(|d| d.eq_ignore_ascii_case(name))) {
        return None;
    }
    let root = directory.parent()?;
    if !root.join("git-bash.exe").is_file() || !root.join("usr").join("bin").is_dir() {
        return None;
    }
    let installed: Vec<_> = MSYSTEM_DIRECTORIES.iter().filter(|name| root.join(name).join("bin").join("git.exe").is_file()).collect();
    match installed.as_slice() {
        [name] => Some(root.join(name).join("bin").join("git.exe")),
        _ => None,
    }
}

#[cfg(windows)]
fn launcher_on_path(path: &str) -> Option<PathBuf> {
    for raw in path.split(';') {
        let raw = raw.trim();
        let entry = raw.strip_prefix('"').and_then(|r| r.strip_suffix('"')).unwrap_or(raw);
        if entry.is_empty() {
            continue;
        }
        let entry = Path::new(entry);
        // A relative entry resolves against each child's cwd: not decidable once.
        if !entry.is_absolute() {
            return None;
        }
        if entry.join("git.com").is_file() {
            return None;
        }
        let candidate = entry.join("git.exe");
        if candidate.is_file() {
            return Some(candidate);
        }
    }
    None
}

/// `realpathSync.native` names a path without the `\\?\` prefix `canonicalize` adds.
#[cfg(windows)]
fn strip_verbatim(path: PathBuf) -> PathBuf {
    match path.to_str().and_then(|p| p.strip_prefix(r"\\?\")) {
        Some(plain) if !plain.starts_with("UNC\\") => PathBuf::from(plain),
        _ => path,
    }
}
