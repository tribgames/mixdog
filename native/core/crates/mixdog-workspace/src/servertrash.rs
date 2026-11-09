#![allow(clippy::disallowed_methods, clippy::disallowed_types, reason = "blocking file bodies run only as lane jobs (lanes::run_fallible)")]
//! The freedesktop.org trash of the server user (port of `trashInfo` / `trashEntry` in
//! `server-file-operations.ts`): a trash that never reaches outside a registered project
//! and works only on the project's own filesystem.

use std::path::Path;
use std::path::PathBuf;

use serde_json::Value;
use serde_json::json;

use crate::error::Reason;
use crate::error::WsError;
use crate::error::WsResult;
use crate::pathguard::lexical;
use crate::pathguard::guarded_entry_path;

fn trash_home() -> PathBuf {
    match std::env::var_os("XDG_DATA_HOME").map(PathBuf::from).filter(|p| p.is_absolute()) {
        Some(data) => data.join("Trash"),
        None => std::env::var_os("HOME")
            .or_else(|| std::env::var_os("USERPROFILE"))
            .map(PathBuf::from)
            .unwrap_or_default()
            .join(".local")
            .join("share")
            .join("Trash"),
    }
}

#[cfg(unix)]
fn same_device(a: &Path, b: &Path) -> bool {
    use std::os::unix::fs::MetadataExt;
    matches!((std::fs::metadata(a), std::fs::metadata(b)), (Ok(x), Ok(y)) if x.dev() == y.dev())
}

#[cfg(not(unix))]
fn same_device(a: &Path, b: &Path) -> bool {
    // One volume: the same drive prefix.
    a.components().next() == b.components().next()
}

/// Whether an entry of `root` can move to the user's trash.
pub fn info(root: &Path) -> Value {
    let home = trash_home();
    let ready = std::fs::create_dir_all(home.join("files")).and_then(|_| std::fs::create_dir_all(home.join("info"))).is_ok();
    let available = ready && std::fs::metadata(root).is_ok() && same_device(root, &home);
    json!({ "available": available, "path": home.to_string_lossy() })
}

fn timestamp() -> String {
    let secs = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |d| d.as_secs()) as i64;
    let (days, rem) = (secs.div_euclid(86_400), secs.rem_euclid(86_400));
    // Civil-from-days (UTC).
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let (y, doy) = (yoe + era * 400, doe - (365 * yoe + yoe / 4 - yoe / 100));
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = if m <= 2 { y + 1 } else { y };
    format!("{y:04}-{m:02}-{d:02}T{:02}:{:02}:{:02}", rem / 3600, rem % 3600 / 60, rem % 60)
}

pub fn entry(root: &Path, rel: &str, permanent: bool) -> WsResult<Value> {
    let target = guarded_entry_path(root, rel)?;
    if target == lexical(root) {
        return Err(WsError::invalid("The project folder itself cannot be deleted here."));
    }
    std::fs::metadata(&target)?;
    if permanent {
        if std::fs::symlink_metadata(&target)?.is_dir() { std::fs::remove_dir_all(&target)? } else { std::fs::remove_file(&target)? }
        return Ok(json!({ "mode": "deleted" }));
    }
    let home = trash_home();
    if info(root)["available"] != Value::Bool(true) {
        return Err(WsError::new(Reason::Unsupported, "The server has no trash on this disk; delete permanently instead."));
    }
    let name = target.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
    for attempt in 1..1000 {
        let trashed_name = if attempt == 1 { name.clone() } else { format!("{name}.{attempt}") };
        let info_file = home.join("info").join(format!("{trashed_name}.trashinfo"));
        let body = format!("[Trash Info]\nPath={}\nDeletionDate={}\n", target.to_string_lossy(), timestamp());
        let created = std::fs::OpenOptions::new().write(true).create_new(true).open(&info_file);
        match created {
            Ok(mut file) => std::io::Write::write_all(&mut file, body.as_bytes())?,
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(e) => return Err(e.into()),
        }
        let trashed = home.join("files").join(&trashed_name);
        if let Err(error) = std::fs::rename(&target, &trashed) {
            let _ = std::fs::remove_file(&info_file);
            return Err(error.into());
        }
        return Ok(json!({ "mode": "trash", "trashPath": trashed.to_string_lossy() }));
    }
    Err(WsError::new(Reason::Busy, "The trash has too many entries with this name."))
}
