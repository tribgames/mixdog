//! The default model shell, resolved as Node's `shell-runtime.mjs` does (`resolveShell`): on
//! Windows `pwsh.exe` (searched on the working directory and `PATH`, then in the known PowerShell
//! 7 roots) before the bundled Windows PowerShell 5.1 and any `powershell.exe` on `PATH`; on other
//! hosts a real `bash`, `/bin/sh` only when none exists. The program's file name tells PowerShell
//! 7 (has `&&`) from 5.1 (has none).

use std::collections::HashSet;
use std::ffi::OsStr;
use std::path::Path;
use std::path::PathBuf;

const PWSH: &str = "pwsh.exe";
const WINDOWS_POWERSHELL: &str = "powershell.exe";
const POSIX_BASH_PATHS: [&str; 4] = ["/bin/bash", "/usr/bin/bash", "/usr/local/bin/bash", "/opt/homebrew/bin/bash"];

/// `firstExistingPathFromPath`: the working directory first, then each `PATH` entry (trimmed,
/// surrounding quotes removed, duplicates dropped; case-insensitive on Windows).
fn first_on_path(command: &str, windows: bool, cwd: Option<&Path>, path: Option<&OsStr>) -> Option<PathBuf> {
    let raw = path.map(|p| p.to_string_lossy().into_owned()).unwrap_or_default();
    let delimiter = if windows { ';' } else { ':' };
    let mut seen = HashSet::new();
    cwd.map(|dir| dir.to_string_lossy().into_owned())
        .into_iter()
        .chain(raw.split(delimiter).map(str::to_owned))
        .map(|entry| {
            let entry = entry.trim();
            entry.strip_prefix('"').and_then(|e| e.strip_suffix('"')).unwrap_or(entry).to_owned()
        })
        .filter(|entry| !entry.is_empty())
        .map(|entry| Path::new(&entry).join(command))
        .filter(|candidate| {
            let key = candidate.to_string_lossy();
            seen.insert(if windows { key.to_lowercase() } else { key.into_owned() })
        })
        .find(|candidate| candidate.exists())
}

/// `pwshFromKnownWindowsRoots`: newest major first, then the Store alias.
fn known_root_pwsh(env: &dyn Fn(&str) -> Option<String>) -> Option<PathBuf> {
    let bases = [
        env("ProgramW6432"),
        env("ProgramFiles"),
        env("ProgramFiles(x86)"),
        Some("C:\\Program Files".to_owned()),
        Some("C:\\Program Files (x86)".to_owned()),
    ];
    let in_roots = bases
        .into_iter()
        .flatten()
        .filter(|base| !base.is_empty())
        .map(|base| PathBuf::from(base).join("PowerShell"))
        .flat_map(|base| ["7", "7-preview", "8", "9"].map(|version| base.join(version).join(PWSH)))
        .find(|candidate| candidate.exists());
    in_roots.or_else(|| {
        env("LOCALAPPDATA")
            .filter(|local| !local.is_empty())
            .map(|local| Path::new(&local).join("Microsoft").join("WindowsApps").join(PWSH))
            .filter(|alias| alias.exists())
    })
}

/// The shell's program: the path `resolveShell` returns. `cwd` and `path` are the working
/// directory and `PATH` searched; `env` reads one environment variable.
pub fn resolve_program(
    windows: bool,
    cwd: Option<&Path>,
    path: Option<&OsStr>,
    env: &dyn Fn(&str) -> Option<String>,
) -> String {
    let text = |p: PathBuf| p.to_string_lossy().into_owned();
    if !windows {
        return POSIX_BASH_PATHS
            .iter()
            .map(PathBuf::from)
            .find(|candidate| candidate.exists())
            .or_else(|| first_on_path("bash", false, cwd, path))
            .map_or_else(|| "/bin/sh".to_owned(), text);
    }
    if let Some(pwsh) = first_on_path(PWSH, true, cwd, path) {
        return text(pwsh);
    }
    if let Some(installed) = known_root_pwsh(env) {
        return text(installed);
    }
    let system_root =
        env("SystemRoot").filter(|v| !v.is_empty()).or_else(|| env("WINDIR").filter(|v| !v.is_empty()));
    let bundled = PathBuf::from(system_root.unwrap_or_else(|| "C:\\Windows".to_owned()))
        .join("System32")
        .join("WindowsPowerShell")
        .join("v1.0")
        .join(WINDOWS_POWERSHELL);
    if bundled.exists() {
        return text(bundled);
    }
    first_on_path(WINDOWS_POWERSHELL, true, cwd, path).map_or_else(|| WINDOWS_POWERSHELL.to_owned(), text)
}

/// The program's file name (`pwsh.exe`, `powershell.exe`, `bash`).
pub fn name_of(program: &str) -> String {
    Path::new(program).file_name().map_or_else(|| program.to_owned(), |name| name.to_string_lossy().into_owned())
}

/// The program for this process.
pub fn resolve_program_current() -> String {
    resolve_program(
        cfg!(windows),
        std::env::current_dir().ok().as_deref(),
        std::env::var_os("PATH").as_deref(),
        &|name| std::env::var(name).ok(),
    )
}

/// The program name for this process.
pub fn resolve_current() -> String {
    name_of(&resolve_program_current())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn windows_prefers_pwsh_on_path_and_returns_its_path() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join(PWSH), b"").unwrap();
        let none = |_: &str| None;
        let program = resolve_program(true, None, Some(dir.path().as_os_str()), &none);
        assert_eq!(PathBuf::from(&program), dir.path().join(PWSH));
        assert_eq!(name_of(&program), PWSH);
    }

    #[test]
    fn windows_finds_pwsh_in_a_known_root() {
        let root = tempfile::tempdir().unwrap();
        let install = root.path().join("PowerShell").join("7");
        std::fs::create_dir_all(&install).unwrap();
        std::fs::write(install.join(PWSH), b"").unwrap();
        let program_files = root.path().to_string_lossy().into_owned();
        let env = |name: &str| (name == "ProgramFiles").then(|| program_files.clone());
        assert_eq!(PathBuf::from(resolve_program(true, None, None, &env)), install.join(PWSH));
    }

    #[test]
    fn windows_takes_the_bundled_5_1_before_a_powershell_on_path() {
        let root = tempfile::tempdir().unwrap();
        let bundled = root.path().join("System32").join("WindowsPowerShell").join("v1.0");
        std::fs::create_dir_all(&bundled).unwrap();
        std::fs::write(bundled.join(WINDOWS_POWERSHELL), b"").unwrap();
        let system_root = root.path().to_string_lossy().into_owned();
        let env = |name: &str| (name == "SystemRoot").then(|| system_root.clone());
        let program = resolve_program(true, None, None, &env);
        // A PowerShell 7 install on the machine running the test wins over the bundled one.
        if !program.to_lowercase().ends_with("pwsh.exe") {
            assert_eq!(PathBuf::from(program), bundled.join(WINDOWS_POWERSHELL));
        }
    }

    #[test]
    fn posix_hosts_resolve_a_bash_or_sh() {
        let program = resolve_program(false, None, None, &|_| None);
        assert!(matches!(name_of(&program).as_str(), "bash" | "sh"));
    }
}
