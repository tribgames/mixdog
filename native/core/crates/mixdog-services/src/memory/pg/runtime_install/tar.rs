//! Extraction of the runtime archive with the system `tar` (`runtime-fetcher.mjs`
//! `probeTar`, `_validateRuntimeTarEntries`, `_extractRuntimeTarGz`). Like Node, the archive is
//! listed and validated before anything is extracted. No `tar` crate is used: bsdtar ships with
//! Windows 10 1803+.

use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::process::Stdio;

use mixdog_js::js_trim_start;
use mixdog_rt::DurabilityIo;
use tokio::process::Command;

use crate::model_install::fsio;

/// What `tar` is asked from the archive's own folder: its name is relative to the working
/// directory, because GNU tar reads `C:\runtime.tar.gz` as a remote host path.
async fn tar(args: &[&str], cwd: &Path) -> Option<std::process::Output> {
    let mut command = Command::new("tar");
    command.args(args).current_dir(cwd).stdin(Stdio::null());
    #[cfg(windows)]
    command.creation_flags(0x0800_0000); // CREATE_NO_WINDOW, as Node's windowsHide
    command.output().await.ok()
}

/// A `tar` run that exited 0; else its stderr (empty when it did not start).
async fn tar_ok(args: &[&str], cwd: &Path) -> Result<std::process::Output, String> {
    match tar(args, cwd).await {
        Some(output) if output.status.success() => Ok(output),
        other => Err(other.map(|o| String::from_utf8_lossy(&o.stderr).into_owned()).unwrap_or_default()),
    }
}

/// JavaScript's `text || fallback`.
fn or(text: String, fallback: &str) -> String {
    if text.is_empty() { fallback.to_owned() } else { text }
}

/// One-shot `tar --version`: an install needs `tar`, a cache hit does not.
pub async fn probe() -> Result<(), String> {
    let cwd = std::env::current_dir().unwrap_or_default();
    if tar_ok(&["--version"], &cwd).await.is_ok() {
        return Ok(());
    }
    Err("[runtime-fetcher] `tar` not found or not executable. \
On Windows, bsdtar (tar.exe) is required (available since Windows 10 1803). \
Ensure tar.exe is on PATH (typically %SystemRoot%\\System32\\tar.exe)."
        .to_owned())
}

/// An entry path or link target that is empty, holds a NUL or a backslash, or is absolute or
/// names a drive.
fn unsafe_path(path: &str) -> bool {
    let mut chars = path.chars();
    let drive = matches!((chars.next(), chars.next()), (Some(letter), Some(':')) if letter.is_ascii_alphabetic());
    path.is_empty() || path.contains('\0') || path.contains('\\') || path.starts_with('/') || drive
}

/// The components of an absolute path, lexically normalised (`.` and `..` resolved).
fn components(path: &Path) -> Vec<String> {
    let absolute = std::path::absolute(path).unwrap_or_else(|_| path.to_owned());
    let mut out: Vec<String> = Vec::new();
    for component in absolute.components() {
        match component {
            std::path::Component::CurDir => {}
            std::path::Component::ParentDir => {
                if out.len() > 1 {
                    out.pop();
                }
            }
            other => out.push(other.as_os_str().to_string_lossy().into_owned()),
        }
    }
    out
}

/// `resolve(join(base, rel))` for a relative, forward-slash `rel`.
fn join(base: &[String], rel: &str) -> Vec<String> {
    let mut out = base.to_vec();
    for segment in rel.split('/') {
        match segment {
            "" | "." => {}
            ".." => {
                if out.len() > 1 {
                    out.pop();
                }
            }
            other => out.push(other.to_owned()),
        }
    }
    out
}

/// `_validateRuntimeTarEntries`: rejects traversal, absolute and drive paths, special files and
/// links that leave the staging tree or point at something the archive does not hold.
pub fn validate_entries(entries: &[String], details: &[String], staging_base: &Path) -> Result<(), String> {
    if entries.len() != details.len() {
        return Err("[runtime-fetcher] tar listings disagree; refusing extraction".to_owned());
    }
    let base = components(staging_base);
    let inside = |candidate: &[String]| candidate.len() >= base.len() && candidate[..base.len()] == base[..];
    let mut known: HashSet<Vec<String>> = HashSet::new();
    for entry in entries {
        if unsafe_path(entry) || entry.split('/').any(|segment| segment == "..") {
            return Err(format!("[runtime-fetcher] tar entry path validation failed (unsafe entry): {entry}"));
        }
        let resolved = join(&base, entry);
        if !inside(&resolved) {
            return Err(format!("[runtime-fetcher] tar entry escapes staging dir: {entry}"));
        }
        known.insert(resolved);
    }
    for (entry, detail) in entries.iter().zip(details) {
        let detail = js_trim_start(detail);
        let kind = detail.chars().next();
        if matches!(kind, Some('-' | 'd')) {
            continue;
        }
        let symbolic = kind == Some('l');
        if !symbolic && kind != Some('h') {
            return Err(format!("[runtime-fetcher] tar entry type is unsafe: {entry}"));
        }
        let marker = if symbolic { " -> " } else { " link to " };
        let target = detail.rfind(marker).map_or("", |at| &detail[at + marker.len()..]);
        let link_error = || format!("[runtime-fetcher] tar link target is unsafe: {entry}");
        if unsafe_path(target) {
            return Err(link_error());
        }
        let entry_path = join(&base, entry);
        let target_path = if symbolic {
            let mut parent = entry_path;
            parent.pop();
            join(&parent, target)
        } else {
            join(&base, target)
        };
        if !inside(&target_path) || !known.contains(&target_path) {
            return Err(link_error());
        }
    }
    Ok(())
}

fn lines(output: &std::process::Output) -> Vec<String> {
    String::from_utf8_lossy(&output.stdout).split('\n').filter(|line| !line.is_empty()).map(str::to_owned).collect()
}

/// `_extractRuntimeTarGz`: list, validate, extract into `dest` (which is `staging_base`); the
/// archive sits beside `dest`.
pub async fn extract(lane: DurabilityIo, archive: &Path, dest: &Path) -> Result<(), String> {
    fsio::create_dir_all(lane, dest).await.map_err(|e| e.to_string())?;
    let archive = std::path::absolute(archive).map_err(|e| e.to_string())?;
    let cwd: PathBuf = archive.parent().map(Path::to_owned).unwrap_or_default();
    let name = archive.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
    let listed = tar_ok(&["-tzf", &name], &cwd).await.map_err(|e| format!("[runtime-fetcher] tar list failed: {}", or(e, "unknown")))?;
    let detailed =
        tar_ok(&["-tvzf", &name], &cwd).await.map_err(|e| format!("[runtime-fetcher] tar detail list failed: {}", or(e, "unknown")))?;
    validate_entries(&lines(&listed), &lines(&detailed), dest)?;
    let relative = format!("../{name}");
    tar_ok(&["-xzf", &relative], dest)
        .await
        .map(drop)
        .map_err(|e| format!("[runtime-fetcher] tar extraction failed: {}", or(e, "unknown error")))
}
