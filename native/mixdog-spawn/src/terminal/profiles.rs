//! Terminal shell detection: every shell installed on this machine, as a plain list. A client
//! only ever names a profile id; [`resolve`] maps it back to a spawnable path, arguments and
//! environment, so an arbitrary executable can never be requested. Detection follows the
//! conventional profile rules in miniature: existence-checked well-known paths, `git.exe`-derived
//! Git Bash, and `wsl.exe -l -q` for distributions.

use std::path::Path;
use std::path::PathBuf;
use std::time::Duration;

use mixdog_core_api::domain::common::AbsPath;
use mixdog_core_api::domain::process::CommandSpec;
use mixdog_core_api::domain::process::EnvSpec;
use mixdog_core_api::domain::process::OutputMode;
use mixdog_core_api::domain::process::ProcessEvent;
use mixdog_core_api::domain::process::ProcessManager;
use mixdog_core_api::domain::process::ProcessOwner;
use mixdog_core_api::domain::process::SpawnRequest;
use mixdog_protocol::ProcessHandle;

use super::integration::SpawnProfile;
use crate::manager::LocalProcessManager;

/// One detected shell.
#[derive(Clone, PartialEq, Eq, Debug)]
pub struct ShellProfile {
    pub id: String,
    pub label: String,
    pub path: String,
    pub args: Vec<String>,
    pub env: Vec<(String, String)>,
}

/// A profile as the picker lists it.
#[derive(Clone, PartialEq, Eq, Debug)]
pub struct ShellProfileInfo {
    pub id: String,
    pub label: String,
    pub path: String,
    /// The OS-default shell: what an empty selection spawns.
    pub default: bool,
}

fn existing_file(candidate: &Path) -> Option<PathBuf> {
    if candidate.as_os_str().is_empty() {
        return None;
    }
    std::fs::metadata(candidate)
        .ok()
        .filter(|meta| meta.is_file())
        .map(|_| candidate.to_path_buf())
}

fn find_on_path(binary: &str) -> Option<PathBuf> {
    let path = std::env::var_os("PATH")?;
    std::env::split_paths(&path)
        .filter(|dir| !dir.as_os_str().is_empty())
        .find_map(|dir| existing_file(&dir.join(binary)))
}

fn env_var(name: &str) -> Option<String> {
    std::env::var(name).ok().filter(|v| !v.is_empty())
}

fn text(path: &Path) -> String {
    path.to_string_lossy().into_owned()
}

/// Utility-VM distributions are not user shells.
fn hidden_wsl_distribution(name: &str) -> bool {
    let name = mixdog_js::js_trim(name).to_lowercase();
    ["docker-desktop", "docker-desktop-data", "rancher-desktop", "rancher-desktop-data"]
        .contains(&name.as_str())
        || name.starts_with("podman-machine")
}

/// `wsl.exe -l -q`: one distribution per line, emitted as UTF-16LE.
async fn wsl_distributions(manager: &LocalProcessManager, wsl: &Path, cwd: &Path) -> Vec<String> {
    let Some(cwd) = AbsPath::new(cwd) else {
        return Vec::new();
    };
    let handle = ProcessHandle::from(format!("profiles-wsl-{}", std::process::id()));
    let request = SpawnRequest {
        handle: handle.clone(),
        command: CommandSpec::Argv {
            program: text(wsl),
            args: vec!["-l".into(), "-q".into()],
        },
        cwd,
        env: EnvSpec {
            inherit: true,
            ..EnvSpec::default()
        },
        pty: None,
        stdin_piped: false,
        output: OutputMode::Merged,
        owner: ProcessOwner::Internal,
        time_limit: Some(Duration::from_secs(3)),
    };
    if manager.spawn(request).await.is_err() {
        return Vec::new();
    }
    let Ok(mut events) = manager.subscribe(&handle, Some(0)) else {
        return Vec::new();
    };
    let mut bytes = Vec::new();
    while let Some(event) = events.next().await {
        match event {
            ProcessEvent::Output { bytes: chunk, .. } => bytes.extend(chunk),
            ProcessEvent::Exited { exit, .. } => {
                if exit.killed.is_some() || exit.status != mixdog_core_api::domain::process::ExitStatus::Code(0) {
                    return Vec::new();
                }
                break;
            }
        }
    }
    let units: Vec<u16> = bytes
        .chunks_exact(2)
        .map(|pair| u16::from_le_bytes([pair[0], pair[1]]))
        .collect();
    String::from_utf16_lossy(&units)
        .split(['\r', '\n'])
        .map(|line| mixdog_js::js_trim(&line.replace('\0', "")).to_owned())
        .filter(|line| !line.is_empty())
        .collect()
}

fn profile(id: &str, label: &str, path: &Path, args: &[&str], env: &[(&str, &str)]) -> ShellProfile {
    ShellProfile {
        id: id.to_owned(),
        label: label.to_owned(),
        path: text(path),
        args: args.iter().map(|a| (*a).to_owned()).collect(),
        env: env.iter().map(|(k, v)| ((*k).to_owned(), (*v).to_owned())).collect(),
    }
}

async fn detect_windows(manager: &LocalProcessManager) -> Vec<ShellProfile> {
    let mut profiles = Vec::new();
    let windir = env_var("windir")
        .or_else(|| env_var("SystemRoot"))
        .unwrap_or_else(|| "C:\\Windows".to_owned());
    let system32 = Path::new(&windir).join("System32");
    let program_files = env_var("ProgramFiles").unwrap_or_else(|| "C:\\Program Files".to_owned());
    let pwsh = find_on_path("pwsh.exe").or_else(|| {
        existing_file(&Path::new(&program_files).join("PowerShell").join("7").join("pwsh.exe"))
    });
    // Label PS7 and PS5.1 unmistakably apart.
    if let Some(pwsh) = pwsh {
        profiles.push(profile("pwsh", "PowerShell (pwsh)", &pwsh, &[], &[]));
    }
    if let Some(ps) = existing_file(&system32.join("WindowsPowerShell").join("v1.0").join("powershell.exe")) {
        profiles.push(profile("windows-powershell", "Windows PowerShell", &ps, &[], &[]));
    }
    if let Some(cmd) = existing_file(&system32.join("cmd.exe")) {
        profiles.push(profile("cmd", "Command Prompt", &cmd, &[], &[]));
    }
    // Git Bash: `<install>/cmd/git.exe` implies `<install>/bin/bash.exe` plus the conventional
    // install roots as fallbacks.
    let mut git_dirs: Vec<PathBuf> = Vec::new();
    let mut add = |dir: PathBuf| {
        if !git_dirs.contains(&dir) {
            git_dirs.push(dir);
        }
    };
    if let Some(git) = find_on_path("git.exe") {
        if let Some(root) = git.parent().and_then(Path::parent).and_then(Path::parent) {
            add(root.to_path_buf());
        }
    }
    for root in [env_var("ProgramW6432"), env_var("ProgramFiles"), env_var("ProgramFiles(x86)")]
        .into_iter()
        .flatten()
    {
        add(PathBuf::from(root));
    }
    if let Some(local) = env_var("LocalAppData") {
        add(Path::new(&local).join("Programs"));
    }
    let git_bash = git_dirs.iter().find_map(|dir| {
        existing_file(&dir.join("Git").join("bin").join("bash.exe"))
            .or_else(|| existing_file(&dir.join("Git").join("usr").join("bin").join("bash.exe")))
            .or_else(|| existing_file(&dir.join("usr").join("bin").join("bash.exe")))
    });
    if let Some(bash) = git_bash {
        profiles.push(profile("git-bash", "Git Bash", &bash, &["--login", "-i"], &[]));
    }
    let home_drive = format!("{}\\", env_var("HOMEDRIVE").unwrap_or_else(|| "C:".to_owned()));
    let home_drive = Path::new(&home_drive);
    if let Some(msys) = existing_file(&home_drive.join("msys64").join("usr").join("bin").join("bash.exe")) {
        // CHERE_INVOKING keeps the requested cwd instead of MSYS2's home.
        profiles.push(profile("msys2", "bash (MSYS2)", &msys, &["--login", "-i"], &[("CHERE_INVOKING", "1")]));
    }
    let cygwin = existing_file(&home_drive.join("cygwin64").join("bin").join("bash.exe"))
        .or_else(|| existing_file(&home_drive.join("cygwin").join("bin").join("bash.exe")));
    if let Some(cygwin) = cygwin {
        profiles.push(profile("cygwin", "Cygwin", &cygwin, &["--login"], &[]));
    }
    if let Some(wsl) = existing_file(&system32.join("wsl.exe")) {
        for distro in wsl_distributions(manager, &wsl, &system32).await {
            if hidden_wsl_distribution(&distro) {
                continue;
            }
            profiles.push(ShellProfile {
                id: format!("wsl-{}", distro.to_lowercase()),
                label: format!("{distro} (WSL)"),
                path: text(&wsl),
                args: vec!["-d".into(), distro],
                env: Vec::new(),
            });
        }
    }
    profiles
}

fn detect_unix() -> Vec<ShellProfile> {
    let mut profiles: Vec<ShellProfile> = Vec::new();
    let mut push = |candidate: &str| {
        let Some(resolved) = existing_file(Path::new(candidate)) else {
            return;
        };
        let resolved = text(&resolved);
        if profiles.iter().any(|p| p.path == resolved) {
            return;
        }
        let name = resolved.rsplit('/').next().unwrap_or(&resolved).to_owned();
        // Two installs of the same shell (/bin/zsh + /usr/local/bin/zsh) keep distinct ids by
        // falling back to the full path.
        let id = if profiles.iter().any(|p| p.id == name) { resolved.clone() } else { name.clone() };
        profiles.push(ShellProfile {
            id,
            label: name,
            path: resolved,
            args: Vec::new(),
            env: Vec::new(),
        });
    };
    push(&env_var("SHELL").unwrap_or_default());
    if let Ok(shells) = std::fs::read_to_string("/etc/shells") {
        for line in shells.lines() {
            let candidate = mixdog_js::js_trim(line);
            if !candidate.is_empty() && !candidate.starts_with('#') {
                push(candidate);
            }
        }
    }
    for candidate in ["/bin/bash", "/bin/zsh", "/usr/bin/fish", "/bin/sh"] {
        push(candidate);
    }
    profiles
}

pub(crate) async fn detect(manager: &LocalProcessManager) -> Vec<ShellProfile> {
    if cfg!(windows) {
        detect_windows(manager).await
    } else {
        detect_unix()
    }
}

/// The OS-default profile id: Windows prefers PowerShell 7 over Windows PowerShell over cmd;
/// elsewhere `$SHELL` wins.
pub fn default_profile_id(profiles: &[ShellProfile], windows: bool, env_shell: &str) -> String {
    if profiles.is_empty() {
        return String::new();
    }
    if windows {
        for id in ["pwsh", "windows-powershell", "cmd"] {
            if profiles.iter().any(|p| p.id == id) {
                return id.to_owned();
            }
        }
        return profiles[0].id.clone();
    }
    profiles
        .iter()
        .find(|p| p.path == env_shell)
        .unwrap_or(&profiles[0])
        .id
        .clone()
}

pub fn list(profiles: &[ShellProfile]) -> Vec<ShellProfileInfo> {
    let default = default_profile_id(profiles, cfg!(windows), &env_var("SHELL").unwrap_or_default());
    profiles
        .iter()
        .map(|p| ShellProfileInfo {
            id: p.id.clone(),
            label: p.label.clone(),
            path: p.path.clone(),
            default: p.id == default,
        })
        .collect()
}

/// Resolves a client-chosen profile id to its spawn spec. An empty or unknown id resolves to the
/// detected OS default; `None` only when nothing was detected.
pub fn resolve(profiles: &[ShellProfile], id: &str) -> Option<SpawnProfile> {
    let wanted = mixdog_js::js_trim(id);
    let default = default_profile_id(profiles, cfg!(windows), &env_var("SHELL").unwrap_or_default());
    let found = (!wanted.is_empty())
        .then(|| profiles.iter().find(|p| p.id == wanted))
        .flatten()
        .or_else(|| profiles.iter().find(|p| p.id == default))?;
    Some(SpawnProfile {
        path: found.path.clone(),
        args: found.args.clone(),
        env: found.env.clone(),
    })
}
