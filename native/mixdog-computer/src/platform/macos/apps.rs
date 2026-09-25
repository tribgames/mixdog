//! Installed applications and launching without taking the foreground.

use super::appkit;
use crate::platform::{AppEntry, Launched};
use std::path::PathBuf;
use std::process::Command;

fn roots() -> Vec<PathBuf> {
    let mut roots: Vec<PathBuf> = ["/Applications", "/Applications/Utilities", "/System/Applications", "/System/Applications/Utilities"]
        .iter()
        .map(PathBuf::from)
        .collect();
    if let Some(home) = std::env::var_os("HOME") {
        roots.push(PathBuf::from(home).join("Applications"));
    }
    roots
}

pub fn installed() -> Vec<AppEntry> {
    let mut apps: Vec<AppEntry> = Vec::new();
    for root in roots() {
        let Ok(entries) = std::fs::read_dir(&root) else { continue };
        for entry in entries.flatten() {
            let path = entry.path();
            if path.extension().and_then(|ext| ext.to_str()) != Some("app") {
                continue;
            }
            let name = path.file_stem().and_then(|stem| stem.to_str()).unwrap_or_default().to_string();
            if name.is_empty() || apps.iter().any(|app| app.name == name) {
                continue;
            }
            apps.push(AppEntry { name, app_id: path.to_string_lossy().into_owned() });
        }
    }
    apps.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
    apps
}

fn category(stderr: &str) -> &'static str {
    let lower = stderr.to_lowercase();
    if lower.contains("unable to find application") || lower.contains("does not exist") || lower.contains("couldn't be found") {
        "target_not_found"
    } else if lower.contains("permission") || lower.contains("not permitted") {
        "access_denied"
    } else if lower.contains("no application knows how") || lower.contains("no application") {
        "no_file_association"
    } else {
        "shell_launch_failed"
    }
}

/// Opens with `-g` so the app starts without being brought forward: the
/// user's foreground survives the launch.
pub fn launch(target: &str, app: Option<&AppEntry>) -> Result<Launched, String> {
    let (arguments, app_id): (Vec<String>, String) = match app {
        Some(app) => (vec!["-g".into(), "-a".into(), app.app_id.clone()], app.app_id.clone()),
        None if target.contains('/') || target.contains(':') => (vec!["-g".into(), target.to_string()], String::new()),
        None => (vec!["-g".into(), "-a".into(), target.to_string()], String::new()),
    };
    let output = Command::new("/usr/bin/open").args(&arguments).output().map_err(|error| format!("launch failed [shell_launch_failed/0] for '{target}': {error}"))?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        let code = output.status.code().unwrap_or(0);
        return Err(format!("launch failed [{}/{code}] for '{target}': {stderr}", category(&stderr)));
    }
    let mut launched = Launched { route: "launch_services", pid: 0, app_id: app_id.clone(), app_hint: String::new() };
    if !app_id.is_empty() {
        for _ in 0..20 {
            if let Some((pid, name)) = appkit::running_pid_for_bundle(&app_id) {
                launched.pid = pid as i64;
                launched.app_hint = name;
                break;
            }
            std::thread::sleep(std::time::Duration::from_millis(100));
        }
    }
    Ok(launched)
}
