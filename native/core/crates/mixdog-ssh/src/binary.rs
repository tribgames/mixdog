//! Finds the OpenSSH tools. On Windows the client is an optional feature whose folder is not always on PATH, so
//! System32\OpenSSH is the second place to look.

use std::path::PathBuf;
use std::sync::LazyLock;

use regex::Regex;

use crate::context::{Platform, SshEnv};

/// The tools of the OpenSSH client this crate runs.
pub const SSH_TOOL_NAMES: [&str; 4] = ["ssh", "ssh-keygen", "ssh-keyscan", "ssh-add"];

/// Installs the Windows OpenSSH client (run in an administrator PowerShell).
pub const WINDOWS_SSH_CLIENT_COMMAND: &str = "Add-WindowsCapability -Online -Name OpenSSH.Client~~~~0.0.1.0";

/// The spawn error text for a missing client.
pub fn missing_client_message(tool: &str) -> String {
    format!("The OpenSSH client ({tool}) was not found on PATH.")
}

/// Is this text the one [`missing_client_message`] writes?
pub fn is_missing_message(text: &str) -> bool {
    static PATTERN: LazyLock<Option<Regex>> = LazyLock::new(|| Regex::new(r"(?i)OpenSSH client \(\S+\) was not found").ok());
    PATTERN.as_ref().is_some_and(|pattern| pattern.is_match(text))
}

/// The command that installs the client where the platform has one (Windows only).
pub fn client_install_command(platform: Platform) -> Option<&'static str> {
    platform.is_windows().then_some(WINDOWS_SSH_CLIENT_COMMAND)
}

fn join(platform: Platform, directory: &str, file: &str) -> String {
    let separator = if platform.is_windows() { '\\' } else { '/' };
    let trimmed = directory.trim_end_matches(['/', '\\']);
    if trimmed.is_empty() && !directory.is_empty() {
        return format!("{separator}{file}");
    }
    format!("{trimmed}{separator}{file}")
}

/// Full path of the tool: PATH first, then (Windows) %SystemRoot%\System32\OpenSSH. None when the client is not
/// installed. Paths may hold spaces or non-ASCII characters; they are only ever passed as one argv entry, never
/// through a shell.
pub fn resolve_ssh_tool(name: &str, env: &SshEnv) -> Option<PathBuf> {
    let platform = env.platform;
    let windows = platform.is_windows();
    let file = if windows { format!("{name}.exe") } else { name.to_owned() };
    let path_var = env.var("Path").or_else(|| env.var("PATH")).unwrap_or("");
    let mut directories: Vec<String> = path_var.split(if windows { ';' } else { ':' }).map(str::to_owned).collect();
    if windows {
        let root = env.var("SystemRoot").or_else(|| env.var("windir")).unwrap_or(r"C:\Windows");
        directories.push(join(platform, &join(platform, root, "System32"), "OpenSSH"));
    }
    for directory in &directories {
        let trimmed = directory.trim();
        let trimmed = trimmed.strip_prefix('"').and_then(|rest| rest.strip_suffix('"')).unwrap_or(trimmed);
        if trimmed.is_empty() {
            continue;
        }
        let candidate = PathBuf::from(join(platform, trimmed, &file));
        if env.files.is_file(&candidate) {
            return Some(candidate);
        }
    }
    None
}

/// What to spawn for a tool: the resolved path, or the bare name so the spawn failure carries the usual "not
/// found" error the dialog explains. A command that is not one of the OpenSSH tools is returned as given.
pub fn ssh_tool_command(name: &str, env: &SshEnv) -> PathBuf {
    if SSH_TOOL_NAMES.contains(&name) {
        resolve_ssh_tool(name, env).unwrap_or_else(|| PathBuf::from(name))
    } else {
        PathBuf::from(name)
    }
}
