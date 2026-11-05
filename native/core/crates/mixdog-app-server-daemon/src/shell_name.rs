//! The default model shell's program name, resolved as Node's `shell-runtime.mjs` does: on Windows
//! `pwsh.exe` (on `PATH`, then in the known PowerShell 7 roots) before Windows PowerShell 5.1; on
//! other hosts `bash`. The name tells PowerShell 7 (has `&&`) from 5.1 (has none).

use std::ffi::OsStr;
use std::path::Path;
use std::path::PathBuf;

const PWSH: &str = "pwsh.exe";
const WINDOWS_POWERSHELL: &str = "powershell.exe";

/// `path` is the `PATH` searched (the working directory first, as Node does); `env` reads one
/// environment variable.
pub fn resolve(
    windows: bool,
    cwd: Option<&Path>,
    path: Option<&OsStr>,
    env: &dyn Fn(&str) -> Option<String>,
) -> String {
    if !windows {
        return "bash".to_owned();
    }
    let on_path = cwd
        .map(Path::to_path_buf)
        .into_iter()
        .chain(path.into_iter().flat_map(std::env::split_paths))
        .any(|dir| dir.join(PWSH).is_file());
    if on_path || known_root_pwsh(env) {
        PWSH.to_owned()
    } else {
        WINDOWS_POWERSHELL.to_owned()
    }
}

/// Newest major first, then the Store alias.
fn known_root_pwsh(env: &dyn Fn(&str) -> Option<String>) -> bool {
    let bases: Vec<PathBuf> = [
        env("ProgramW6432"),
        env("ProgramFiles"),
        env("ProgramFiles(x86)"),
        Some("C:\\Program Files".to_owned()),
        Some("C:\\Program Files (x86)".to_owned()),
    ]
    .into_iter()
    .flatten()
    .filter(|base| !base.is_empty())
    .map(|base| PathBuf::from(base).join("PowerShell"))
    .collect();
    let in_roots = bases
        .iter()
        .any(|base| ["7", "7-preview", "8", "9"].iter().any(|version| base.join(version).join(PWSH).is_file()));
    in_roots
        || env("LOCALAPPDATA")
            .is_some_and(|local| Path::new(&local).join("Microsoft").join("WindowsApps").join(PWSH).is_file())
}

/// The name for this process.
pub fn resolve_current() -> String {
    resolve(
        cfg!(windows),
        std::env::current_dir().ok().as_deref(),
        std::env::var_os("PATH").as_deref(),
        &|name| std::env::var(name).ok(),
    )
}

/// The shell's program path as `resolvePosixBash` finds it: the known install paths, then `bash`
/// on `PATH`, then `/bin/sh`. On Windows the default shell is PowerShell, so the resolved name
/// stands (only bash and zsh paths get an environment snapshot).
pub fn resolve_program(windows: bool, name: &str, path: Option<&OsStr>) -> String {
    if windows {
        return name.to_owned();
    }
    ["/bin/bash", "/usr/bin/bash", "/usr/local/bin/bash", "/opt/homebrew/bin/bash"]
        .into_iter()
        .map(PathBuf::from)
        .chain(path.into_iter().flat_map(std::env::split_paths).map(|dir| dir.join("bash")))
        .find(|candidate| candidate.is_file())
        .map_or_else(|| "/bin/sh".to_owned(), |found| found.to_string_lossy().into_owned())
}

/// The program path for this process.
pub fn resolve_program_current() -> String {
    resolve_program(cfg!(windows), &resolve_current(), std::env::var_os("PATH").as_deref())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn windows_program_is_the_resolved_name_and_posix_falls_back_to_sh() {
        assert_eq!(resolve_program(true, PWSH, None), PWSH);
        let dir = tempfile::tempdir().unwrap();
        let found = resolve_program(false, "bash", Some(dir.path().as_os_str()));
        assert!(found.ends_with("bash") || found == "/bin/sh");
    }

    #[test]
    fn posix_hosts_use_bash() {
        assert_eq!(resolve(false, None, None, &|_| None), "bash");
    }

    #[test]
    fn windows_prefers_pwsh_on_path_and_falls_back_to_5_1() {
        let dir = tempfile::tempdir().unwrap();
        let none = |_: &str| None;
        assert_eq!(resolve(true, None, Some(dir.path().as_os_str()), &none), WINDOWS_POWERSHELL);
        std::fs::write(dir.path().join(PWSH), b"").unwrap();
        assert_eq!(resolve(true, None, Some(dir.path().as_os_str()), &none), PWSH);
    }

    #[test]
    fn windows_finds_pwsh_in_a_known_root() {
        let root = tempfile::tempdir().unwrap();
        let install = root.path().join("PowerShell").join("7");
        std::fs::create_dir_all(&install).unwrap();
        std::fs::write(install.join(PWSH), b"").unwrap();
        let program_files = root.path().to_string_lossy().into_owned();
        let env = |name: &str| (name == "ProgramFiles").then(|| program_files.clone());
        assert_eq!(resolve(true, None, None, &env), PWSH);
    }
}
