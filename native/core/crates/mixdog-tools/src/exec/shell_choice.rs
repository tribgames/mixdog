//! The model shell of one spawn, chosen as `shell-runtime.mjs` `resolveShell` does. The "system
//! shell" setting (`getConfiguredShell()`) is read on every spawn, so a change reaches the next
//! command; only the default program is resolved once, at start, by the host.

/// `shellTypeFor(shell) === 'posix'`: a `bash`, `zsh` or `sh` program. Every other name is
/// PowerShell on Windows (`shellTypeFor`'s fallback there).
fn is_posix_shell(program: &str) -> bool {
    let stem = program_name(program).to_lowercase();
    matches!(stem.strip_suffix(".exe").unwrap_or(&stem), "bash" | "zsh" | "sh")
}

/// `resolveShell()`'s program. Off Windows the default (a real bash, else `/bin/sh`) is the only
/// choice. On Windows an explicit program, the setting before the `MIXDOG_SHELL` variable (the
/// variable is not trimmed; an empty one is none), replaces the default PowerShell unless it is a
/// POSIX shell.
pub(crate) fn chosen_shell(windows: bool, configured: &str, env_shell: Option<&str>, default_program: &str) -> String {
    if !windows {
        return default_program.to_owned();
    }
    let explicit = if configured.is_empty() { env_shell.unwrap_or_default() } else { configured };
    if explicit.is_empty() || is_posix_shell(explicit) { default_program.to_owned() } else { explicit.to_owned() }
}

/// `resolveShell()`'s default program: the kept one, else a probe on `lane` kept for the next
/// spawns until the setting changes (the setting is its only source the kept value tracks, as
/// Node's `_resolvedShell`). `Err` is the reason the probe could not run.
pub(crate) async fn default_program(
    source: &std::sync::Arc<dyn super::jobs::ShellSource>,
    lane: mixdog_rt::SpawnIo,
    cancel: &tokio_util::sync::CancellationToken,
    configured: &str,
) -> Result<String, String> {
    if let Some(kept) = source.kept_default() {
        return Ok(kept);
    }
    use mixdog_rt::LaneToken;
    let probe = source.clone();
    let program = lane
        .submit(cancel, move |_lane| probe.resolve_default())
        .map_err(|_| "the lane is full".to_owned())?
        .await
        .map_err(|error| error.to_string())?;
    source.keep_default(configured, program.clone());
    Ok(program)
}

/// How long a Git Bash lookup that found nothing is kept (`SHELL_RESOLUTION_MISS_TTL_MS`): a later install is found again.
const BASH_MISS_TTL: std::time::Duration = std::time::Duration::from_secs(30);

/// The last Git Bash lookup: whether it found one, and when it was made.
static GIT_BASH: std::sync::Mutex<Option<(bool, std::time::Instant)>> = std::sync::Mutex::new(None);

/// Whether a call that asks for the `bash` shell (a foreign CLI's `bash` name, `shell: 'bash'`) is read as POSIX syntax
/// (`requestedShellType` over `resolveShellFor('bash')`). Off Windows a bash, or `/bin/sh` as the last resort, is always
/// there. On Windows it is Git Bash, and without one the request is no request: the default shell's syntax applies. A
/// found Git Bash is kept for the process, a miss for 30 s.
pub(crate) fn bash_request_is_posix(windows: bool) -> bool {
    if !windows {
        return true;
    }
    let mut slot = GIT_BASH.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
    if let Some((found, at)) = *slot
        && (found || at.elapsed() < BASH_MISS_TTL)
    {
        return found;
    }
    let entries = path_entries(std::env::current_dir().ok(), &std::env::var("PATH").unwrap_or_default());
    let found = git_bash(&entries, &known_git_roots(&|name: &str| std::env::var(name).ok())).is_some();
    *slot = Some((found, std::time::Instant::now()));
    found
}

/// The folders a command name is looked up in (`allExistingPathsFromPath`): the working directory, then every `PATH` entry,
/// trimmed and unquoted.
fn path_entries(cwd: Option<std::path::PathBuf>, path: &str) -> Vec<std::path::PathBuf> {
    let listed = std::env::split_paths(path).map(|entry| std::path::PathBuf::from(entry.to_string_lossy().trim().trim_matches('"')));
    cwd.into_iter().chain(listed).filter(|entry| !entry.as_os_str().is_empty()).collect()
}

/// Every existing `name` in `entries`, once per path (case-insensitively).
fn existing_on_path(entries: &[std::path::PathBuf], name: &str) -> Vec<std::path::PathBuf> {
    let mut seen = std::collections::HashSet::new();
    entries
        .iter()
        .map(|entry| entry.join(name))
        .filter(|candidate| seen.insert(candidate.to_string_lossy().to_lowercase()) && candidate.exists())
        .collect()
}

/// The Git-for-Windows launcher under an install root: `bin\bash.exe`, then `usr\bin\bash.exe`.
fn bash_under(root: &std::path::Path) -> Option<std::path::PathBuf> {
    let launcher = |dirs: &[&str]| dirs.iter().fold(root.to_path_buf(), |path, part| path.join(part)).join("bash.exe");
    [launcher(&["bin"]), launcher(&["usr", "bin"])].into_iter().find(|candidate| candidate.exists())
}

/// `resolveWindowsGitBash`: the launcher beside a `git.exe` on the path (up to three folders up from it, so `cmd`, `bin` and
/// `mingw64\bin` all lead to the install root), else a `bash.exe` on the path that is not the System32 launcher of WSL, else
/// the well-known install `roots` ([`known_git_roots`]).
fn git_bash(entries: &[std::path::PathBuf], roots: &[std::path::PathBuf]) -> Option<std::path::PathBuf> {
    for git in existing_on_path(entries, "git.exe") {
        let mut dir = git.parent();
        for _ in 0..3 {
            let Some(current) = dir else { break };
            if let Some(bash) = bash_under(current) {
                return Some(bash);
            }
            dir = current.parent();
        }
    }
    let wsl = |path: &std::path::Path| path.to_string_lossy().to_lowercase().replace('/', "\\").contains(r"\system32\");
    if let Some(bash) = existing_on_path(entries, "bash.exe").into_iter().find(|candidate| !wsl(candidate)) {
        return Some(bash);
    }
    roots.iter().find_map(|root| bash_under(root))
}

/// `gitBashFromKnownWindowsRoots`: the Git-for-Windows install roots of the machine and of the user, then the fixed ones.
fn known_git_roots(env: &dyn Fn(&str) -> Option<String>) -> Vec<std::path::PathBuf> {
    let mut roots: Vec<std::path::PathBuf> = ["ProgramW6432", "ProgramFiles", "ProgramFiles(x86)"]
        .iter()
        .filter_map(|name| env(name).filter(|base| !base.is_empty()))
        .map(|base| std::path::Path::new(&base).join("Git"))
        .collect();
    if let Some(local) = env("LOCALAPPDATA").filter(|base| !base.is_empty()) {
        roots.push(std::path::Path::new(&local).join("Programs").join("Git"));
    }
    roots.push(r"C:\Program Files\Git".into());
    roots.push(r"C:\Program Files (x86)\Git".into());
    roots
}

/// `basename(program)`: the file name of a program path, either separator, trailing ones ignored.
fn program_name(program: &str) -> &str {
    let trimmed = program.trim_end_matches(['\\', '/']);
    trimmed.rsplit(['\\', '/']).next().unwrap_or(trimmed)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn golden() -> serde_json::Value {
        serde_json::from_str(include_str!("testdata/shell_choice.json")).unwrap()
    }

    /// The recorded `<default>` stands for the host's own default program.
    const DEFAULT: &str = "C:\\Host\\default-shell.exe";

    fn expected(case: &serde_json::Value) -> String {
        match case["shell"].as_str().unwrap() {
            "<default>" => DEFAULT.to_owned(),
            explicit => explicit.to_owned(),
        }
    }

    /// Node's shell for every recorded setting, `MIXDOG_SHELL` value and platform. The setting is
    /// stored trimmed (`setConfiguredShell`), as the daemon's `ConfiguredShell` does.
    #[test]
    fn the_chosen_shell_equals_nodes_for_every_setting_variable_and_platform() {
        let golden = golden();
        let cases = golden["cases"].as_array().unwrap();
        assert!(cases.len() > 100);
        for case in cases {
            let windows = case["platform"] == "win32";
            let configured = mixdog_js::js_trim(case["configured"].as_str().unwrap());
            let env = case["env"].as_str();
            assert_eq!(chosen_shell(windows, configured, env, DEFAULT), expected(case), "{case}");
        }
    }

    /// The type of the shell Node chose is the platform's: the PowerShell-only paths (wmic rewrite,
    /// hygiene, the UTF-8 preamble) follow `windows`, whatever is configured.
    #[test]
    fn the_shell_type_is_the_platforms_for_every_recorded_choice() {
        let golden = golden();
        for case in golden["cases"].as_array().unwrap() {
            let want = if case["platform"] == "win32" { "powershell" } else { "posix" };
            assert_eq!(case["shellType"], want, "{case}");
        }
        for (platform, kind) in golden["defaults"].as_object().unwrap() {
            assert_eq!(kind, if platform == "win32" { "powershell" } else { "posix" });
        }
    }

    /// One process, the setting changing between spawns: each spawn follows the current value.
    #[test]
    fn the_setting_is_followed_from_one_spawn_to_the_next() {
        let golden = golden();
        for step in golden["sequence"].as_array().unwrap() {
            let configured = mixdog_js::js_trim(step["set"].as_str().unwrap());
            assert_eq!(chosen_shell(true, configured, None, DEFAULT), expected(step), "{step}");
        }
    }

    /// A setting whose change drops the kept default, as the daemon's `ConfiguredShell` does
    /// (`setConfiguredShell`); every probe answers a new program.
    #[derive(Default)]
    struct Setting {
        value: std::sync::Mutex<String>,
        kept: std::sync::Mutex<Option<String>>,
        probes: std::sync::atomic::AtomicUsize,
    }

    impl super::super::jobs::ShellSource for Setting {
        fn configured(&self) -> String {
            self.value.lock().unwrap().clone()
        }
        fn kept_default(&self) -> Option<String> {
            self.kept.lock().unwrap().clone()
        }
        fn resolve_default(&self) -> String {
            format!("probe-{}", self.probes.fetch_add(1, std::sync::atomic::Ordering::SeqCst) + 1)
        }
        fn keep_default(&self, configured: &str, program: String) {
            if *self.value.lock().unwrap() == configured {
                *self.kept.lock().unwrap() = Some(program);
            }
        }
    }

    /// The default program of one spawn.
    async fn spawn_program(source: &std::sync::Arc<dyn super::super::jobs::ShellSource>) -> String {
        let cancel = tokio_util::sync::CancellationToken::new();
        default_program(source, mixdog_rt::testing::tokens().spawn_io, &cancel, &source.configured()).await.unwrap()
    }

    /// The default program is probed once and kept; a setting change makes the next spawn probe again.
    #[tokio::test]
    async fn the_kept_default_program_is_probed_again_after_the_setting_changes() {
        let setting = std::sync::Arc::new(Setting::default());
        let source: std::sync::Arc<dyn super::super::jobs::ShellSource> = setting.clone();
        assert_eq!(spawn_program(&source).await, "probe-1");
        assert_eq!(spawn_program(&source).await, "probe-1");
        *setting.value.lock().unwrap() = "pwsh".into();
        *setting.kept.lock().unwrap() = None;
        assert_eq!(spawn_program(&source).await, "probe-2");
        assert_eq!(spawn_program(&source).await, "probe-2");
        assert_eq!(setting.probes.load(std::sync::atomic::Ordering::SeqCst), 2);
    }

    /// `resolveWindowsGitBash`: a `git.exe` leads to the install root's launcher from `cmd`, `bin` or `mingw64\bin`; the WSL
    /// launcher under System32 is never taken; a known install root is the last resort.
    #[test]
    fn git_bash_is_found_beside_git_and_never_as_the_wsl_launcher() {
        let make = |root: &std::path::Path, files: &[&str]| {
            for file in files {
                let path = root.join(file);
                std::fs::create_dir_all(path.parent().unwrap()).unwrap();
                std::fs::write(path, b"").unwrap();
            }
        };
        let dir = tempfile::tempdir().unwrap();
        let git = dir.path().join("Git");
        make(&git, &["cmd/git.exe", "usr/bin/bash.exe"]);
        assert_eq!(git_bash(&[git.join("cmd")], &[]), Some(git.join("usr").join("bin").join("bash.exe")));
        let deep = dir.path().join("Deep");
        make(&deep, &["mingw64/bin/git.exe", "bin/bash.exe"]);
        assert_eq!(git_bash(&[deep.join("mingw64").join("bin")], &[]), Some(deep.join("bin").join("bash.exe")));
        let wsl = dir.path().join("Windows").join("System32");
        make(&wsl, &["bash.exe"]);
        assert_eq!(git_bash(&[wsl.clone()], &[]), None);
        let other = dir.path().join("Tools");
        make(&other, &["bash.exe"]);
        assert_eq!(git_bash(&[wsl, other.clone()], &[]), Some(other.join("bash.exe")));
        let installed = dir.path().join("PF");
        make(&installed.join("Git"), &["bin/bash.exe"]);
        let base = installed.to_string_lossy().into_owned();
        let roots = known_git_roots(&move |name: &str| (name == "ProgramFiles").then(|| base.clone()));
        assert_eq!(roots.first(), Some(&installed.join("Git")));
        assert_eq!(roots.len(), 3, "the machine's root, then the two fixed ones");
        assert_eq!(git_bash(&[], &roots), Some(installed.join("Git").join("bin").join("bash.exe")));
    }

    #[test]
    fn the_lookup_folders_are_the_working_directory_then_the_path_unquoted() {
        let separator = if cfg!(windows) { ';' } else { ':' };
        let entries = path_entries(Some("work".into()), &format!("\"a b\"{separator}{separator}c"));
        assert_eq!(entries.iter().map(|e| e.to_string_lossy().into_owned()).collect::<Vec<_>>(), ["work", "a b", "c"]);
        assert!(bash_request_is_posix(false));
    }

    #[test]
    fn the_program_name_is_the_last_path_component() {
        assert_eq!(program_name("C:\\Program Files\\PowerShell\\7\\pwsh.exe"), "pwsh.exe");
        assert_eq!(program_name("/usr/bin/pwsh"), "pwsh");
        assert_eq!(program_name("C:\\Git\\bin\\bash.exe\\"), "bash.exe");
        assert_eq!(program_name("powershell.exe"), "powershell.exe");
    }
}
