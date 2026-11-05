//! Reading a JSON state file the way Node's `readJsonStateSync` does: a damaged file (not JSON, or
//! failing the caller's check) never blocks the feature. Its bytes are kept aside as
//! `<file>.corrupt-<ms>` and the last good copy `<file>.bak`, when there is one, is restored.
//! A file that cannot be read is an error, never "empty".

use std::path::Path;
use std::path::PathBuf;

use mixdog_rt::InLane;
use mixdog_rt::MaintenanceIo;
use serde_json::Value;

/// What a state file holds: parsed, or damaged.
enum Parsed {
    Absent,
    Ok(Value, Vec<u8>),
    Damaged(String),
}

fn parse(content: Option<Vec<u8>>, validate: &dyn Fn(&Value) -> Result<(), String>) -> Parsed {
    let Some(bytes) = content else { return Parsed::Absent };
    let text = String::from_utf8_lossy(&bytes);
    let text = text.strip_prefix('\u{feff}').unwrap_or(&text);
    match serde_json::from_str::<Value>(text) {
        Ok(value) => match validate(&value) {
            Ok(()) => Parsed::Ok(value, bytes),
            Err(reason) => Parsed::Damaged(reason),
        },
        Err(error) => Parsed::Damaged(error.to_string()),
    }
}

#[allow(clippy::disallowed_methods, reason = "runs as a maintenance-lane job (InLane proof)")]
fn read_or_null(path: &Path) -> std::io::Result<Option<Vec<u8>>> {
    match std::fs::read(path) {
        Ok(bytes) => Ok(Some(bytes)),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(error),
    }
}

/// The file's value that passes `validate`; `None` when the file is missing or damaged with no
/// good copy to restore (the caller's fallback applies).
pub(crate) fn read_json_state(
    _lane: &InLane<MaintenanceIo>,
    path: &Path,
    validate: &dyn Fn(&Value) -> Result<(), String>,
) -> std::io::Result<Option<Value>> {
    match parse(read_or_null(path)?, validate) {
        Parsed::Ok(value, _) => Ok(Some(value)),
        Parsed::Absent => Ok(None),
        Parsed::Damaged(_) => recover(path, validate),
    }
}

#[allow(clippy::disallowed_methods, reason = "runs as a maintenance-lane job (InLane proof)")]
fn recover(path: &Path, validate: &dyn Fn(&Value) -> Result<(), String>) -> std::io::Result<Option<Value>> {
    // Re-read: a file another process repaired meanwhile is kept.
    let reason = match parse(read_or_null(path)?, validate) {
        Parsed::Ok(value, _) => return Ok(Some(value)),
        Parsed::Absent => return Ok(None),
        Parsed::Damaged(reason) => reason,
    };
    let mut backup_path = path.as_os_str().to_owned();
    backup_path.push(".bak");
    let backup = parse(read_or_null(Path::new(&backup_path))?, validate);
    let (aside, restored) = match backup {
        Parsed::Ok(value, bytes) => (restore_from_backup(path, &bytes)?, Some(value)),
        Parsed::Absent | Parsed::Damaged(_) => {
            let aside = quarantine_path(path);
            std::fs::rename(path, &aside)?;
            (aside, None)
        }
    };
    tracing::warn!(
        file = %path.display(),
        "[state] file is damaged ({reason}); kept as {}; {}",
        aside.display(),
        if restored.is_some() { "restored the last good copy" } else { "starting empty" }
    );
    Ok(restored)
}

/// Keeps the damaged `path` aside as `<file>.corrupt-<ms>` and publishes the good copy
/// `backup` in its place (a staged file renamed over it); the aside path.
#[allow(clippy::disallowed_methods, reason = "runs as a maintenance-lane job (InLane proof)")]
pub(crate) fn restore_from_backup(path: &Path, backup: &[u8]) -> std::io::Result<PathBuf> {
    let aside = quarantine_path(path);
    std::fs::rename(path, &aside)?;
    let mut staged = path.as_os_str().to_owned();
    staged.push(format!(".mixdog-tmp-{}", uuid::Uuid::new_v4().simple()));
    let staged = PathBuf::from(staged);
    std::fs::write(&staged, backup)?;
    std::fs::rename(&staged, path)?;
    Ok(aside)
}

/// The first `<file>.corrupt-<ms>` that does not exist yet.
#[allow(clippy::disallowed_methods, reason = "runs as a maintenance-lane job (InLane proof)")]
fn quarantine_path(path: &Path) -> PathBuf {
    let mut stamp = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |d| d.as_millis());
    loop {
        let mut candidate = path.as_os_str().to_owned();
        candidate.push(format!(".corrupt-{stamp}"));
        let candidate = PathBuf::from(candidate);
        if !candidate.exists() {
            return candidate;
        }
        stamp += 1;
    }
}
