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
use crate::nodeerr::io_error;
use crate::nodeerr::io_error2;
use crate::pathguard::lexical;
use crate::pathguard::project_entry_path;

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

/// Makes a trash folder as Node's `mkdir(..., { recursive: true, mode: 0o700 })` does.
fn make_dir(path: &Path) -> std::io::Result<()> {
    let mut builder = std::fs::DirBuilder::new();
    builder.recursive(true);
    #[cfg(unix)]
    std::os::unix::fs::DirBuilderExt::mode(&mut builder, 0o700);
    builder.create(path)
}

/// Whether an entry of `root` can move to the user's trash.
pub fn info(root: &Path) -> Value {
    info_in(&trash_home(), root)
}

/// [`info`] with the trash at `home`.
pub fn info_in(home: &Path, root: &Path) -> Value {
    let ready = make_dir(&home.join("files")).and_then(|_| make_dir(&home.join("info"))).is_ok();
    let available = ready && std::fs::metadata(root).is_ok() && same_device(root, home);
    json!({ "available": available, "path": home.to_string_lossy() })
}

/// Node's `trashTimestamp`: the local date and time of `now_ms`, to the second.
fn timestamp(now_ms: i64) -> String {
    let local = now_ms + mixdog_js::time::local_offset_ms(now_ms as f64);
    let secs = local.div_euclid(1000);
    let (days, rem) = (secs.div_euclid(86_400), secs.rem_euclid(86_400));
    // Civil-from-days.
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

/// JavaScript's `encodeURI`: every UTF-8 byte outside the URI's unreserved and reserved characters as `%XX`.
fn encode_uri(text: &str) -> String {
    const KEPT: &[u8] = b";,/?:@&=+$-_.!~*'()#";
    let mut out = String::with_capacity(text.len());
    for byte in text.bytes() {
        if byte.is_ascii_alphanumeric() || KEPT.contains(&byte) {
            out.push(byte as char);
        } else {
            out.push_str(&format!("%{byte:02X}"));
        }
    }
    out
}

/// Node's `rm(target, { recursive: true })` (`node:internal/fs/rimraf`, Node 22.20, no retries): the same calls in the same order, so a
/// failure names the call and the path that failed (`unlink '<child>'`, `rmdir '<dir>'`, `scandir '<dir>'`). A link is removed, never
/// what it points at; a path that is already gone is no failure.
fn rimraf(path: &Path) -> WsResult<()> {
    use crate::nodeerr::code_of;
    let meta = match std::fs::symlink_metadata(path) {
        Err(error) if code_of(&error) == "ENOENT" => return Ok(()),
        Err(error) if cfg!(windows) && code_of(&error) == "EPERM" => return fix_win_eperm(path, io_error(&error, "lstat", path)),
        other => other.ok(),
    };
    if meta.is_some_and(|meta| meta.is_dir()) {
        return rimraf_dir(path, None);
    }
    match std::fs::remove_file(path) {
        Ok(()) => Ok(()),
        Err(error) if code_of(&error) == "ENOENT" => Ok(()),
        Err(error) if code_of(&error) == "EISDIR" => rimraf_dir(path, Some(io_error(&error, "unlink", path))),
        Err(error) if code_of(&error) == "EPERM" => {
            let original = io_error(&error, "unlink", path);
            if cfg!(windows) { fix_win_eperm(path, original) } else { rimraf_dir(path, Some(original)) }
        }
        Err(error) => Err(io_error(&error, "unlink", path)),
    }
}

/// `fixWinEPERM`: clear the read-only attribute (`chmod 0o666`) and try once more; what fails then is the original error, or the unlink.
fn fix_win_eperm(path: &Path, original: WsError) -> WsResult<()> {
    use crate::nodeerr::code_of;
    let writable = std::fs::metadata(path).and_then(|meta| {
        let mut permissions = meta.permissions();
        #[allow(clippy::permissions_set_readonly_false, reason = "Node's chmod 0o666")]
        permissions.set_readonly(false);
        std::fs::set_permissions(path, permissions)
    });
    if let Err(error) = writable {
        return if code_of(&error) == "ENOENT" { Ok(()) } else { Err(original) };
    }
    match std::fs::metadata(path) {
        Err(error) => if code_of(&error) == "ENOENT" { Ok(()) } else { Err(original) },
        Ok(meta) if meta.is_dir() => rimraf_dir(path, Some(original)),
        Ok(_) => std::fs::remove_file(path).map_err(|error| io_error(&error, "unlink", path)),
    }
}

/// `_rmdir`, then `_rmchildren` when the folder is not empty.
fn rimraf_dir(path: &Path, original: Option<WsError>) -> WsResult<()> {
    use crate::nodeerr::code_of;
    match std::fs::remove_dir(path) {
        Ok(()) => Ok(()),
        Err(error) if matches!(code_of(&error), "ENOTEMPTY" | "EEXIST" | "EPERM") => {
            let children = std::fs::read_dir(path).map_err(|error| io_error(&error, "scandir", path))?;
            for child in children {
                let child = child.map_err(|error| io_error(&error, "scandir", path))?;
                rimraf(&child.path())?;
            }
            std::fs::remove_dir(path).map_err(|error| io_error(&error, "rmdir", path))
        }
        Err(error) if code_of(&error) == "ENOTDIR" => Err(original.unwrap_or_else(|| io_error(&error, "rmdir", path))),
        Err(error) => Err(io_error(&error, "rmdir", path)),
    }
}

pub fn entry(root: &Path, rel: &str, permanent: bool) -> WsResult<Value> {
    let now_ms = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |d| d.as_millis() as i64);
    entry_in(&trash_home(), root, rel, permanent, now_ms)
}

/// [`entry`] with the trash at `home` and `now_ms` as the time of the deletion.
pub fn entry_in(home: &Path, root: &Path, rel: &str, permanent: bool, now_ms: i64) -> WsResult<Value> {
    let target = project_entry_path(root, rel)?;
    if target == lexical(root) {
        return Err(WsError::new(Reason::Plain, "The project folder itself cannot be deleted here."));
    }
    std::fs::metadata(&target).map_err(|error| io_error(&error, "stat", &target))?;
    if permanent {
        rimraf(&target)?;
        return Ok(json!({ "mode": "deleted" }));
    }
    if info_in(home, root)["available"] != Value::Bool(true) {
        return Err(WsError::coded("TRASH_UNAVAILABLE", "The server has no trash on this disk; delete permanently instead."));
    }
    let name = target.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
    for attempt in 1..1000 {
        let trashed_name = if attempt == 1 { name.clone() } else { format!("{name}.{attempt}") };
        let info_file = home.join("info").join(format!("{trashed_name}.trashinfo"));
        let body = format!("[Trash Info]\nPath={}\nDeletionDate={}\n", encode_uri(&target.to_string_lossy()), timestamp(now_ms));
        let mut options = std::fs::OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        std::os::unix::fs::OpenOptionsExt::mode(&mut options, 0o600);
        match options.open(&info_file) {
            Ok(mut file) => std::io::Write::write_all(&mut file, body.as_bytes()).map_err(|error| io_error(&error, "write", &info_file))?,
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(error) => return Err(io_error(&error, "open", &info_file)),
        }
        let trashed = home.join("files").join(&trashed_name);
        if let Err(error) = std::fs::rename(&target, &trashed) {
            let _ = std::fs::remove_file(&info_file);
            return Err(io_error2(&error, "rename", &target, &trashed));
        }
        return Ok(json!({ "mode": "trash", "trashPath": trashed.to_string_lossy() }));
    }
    Err(WsError::new(Reason::Plain, "The trash has too many entries with this name."))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Node's server trash, step by step (apps/mobile/fixtures/server-trash/golden.json, recorded from b6f10295a with XDG_DATA_HOME and TZ
    /// set): the answers, the `.trashinfo` each trash wrote (encodeURI'd path, local-time date), and the refusals.
    /// The recording is of a Windows host (its paths, and a child held open without delete sharing), so it is replayed there.
    #[cfg(windows)]
    #[test]
    fn the_server_trash_answers_and_writes_what_node_did() {
        let golden: Value = serde_json::from_str(include_str!("../../../../../apps/mobile/fixtures/server-trash/golden.json")).unwrap();
        let zone: mixdog_js::time::Tz = golden["zone"].as_str().unwrap().parse().unwrap();
        let base = tempfile::tempdir().unwrap();
        let base = std::fs::canonicalize(base.path()).unwrap();
        let base = PathBuf::from(base.to_string_lossy().trim_start_matches(r"\\?\"));
        let (root, home) = (base.join("proj"), base.join("data").join("Trash"));
        // The data folder of the unavailable case is a file.
        std::fs::write(base.join("not-a-folder"), "").unwrap();
        let blocked = base.join("not-a-folder").join("data").join("Trash");
        std::fs::create_dir_all(root.join("sub")).unwrap();
        let text = |path: &Path| path.to_string_lossy().into_owned();
        let fill = |template: &str| template.replace("{rootUri}", &encode_uri(&text(&root))).replace("{trash}", &text(&home)).replace("{root}", &text(&root));
        // A recorded answer is tokenized in its JSON text: the folders go back in as JSON string bodies.
        let in_json = |path: &Path| {
            let quoted = serde_json::to_string(&text(path)).unwrap();
            quoted[1..quoted.len() - 1].to_owned()
        };
        let fill_value = |value: &Value| -> Value {
            let json = serde_json::to_string(value)
                .unwrap()
                .replace("{blockedTrash}", &in_json(&blocked))
                .replace("{trash}", &in_json(&home))
                .replace("{root}", &in_json(&root));
            serde_json::from_str(&json).unwrap()
        };
        mixdog_js::time::with_local_zone(zone, || {
            let mut trashed_again = std::collections::HashMap::<String, u32>::new();
            for (at, step) in golden["steps"].as_array().unwrap().iter().enumerate() {
                let rel = step["rel"].as_str().unwrap_or_default();
                let trash_home = if step["home"] == "blocked" { &blocked } else { &home };
                // The child Node's run held open from another process, held here without delete sharing for the step.
                let mut _held = None;
                let got: Result<Value, WsError> = match step["op"].as_str().unwrap() {
                    "info" => Ok(info_in(trash_home, &root)),
                    "trash" => {
                        if rel != "missing.txt" {
                            std::fs::write(root.join(rel), rel).unwrap();
                        }
                        entry_in(trash_home, &root, rel, false, step["at"].as_i64().unwrap())
                    }
                    "delete" => {
                        if rel == "sub" {
                            std::fs::write(root.join("sub").join("inner.txt"), "x").unwrap();
                        }
                        if let Some(held) = step["held"].as_str() {
                            use std::os::windows::fs::OpenOptionsExt;
                            let child = root.join(held.replace('/', "\\"));
                            std::fs::create_dir_all(child.parent().unwrap()).unwrap();
                            std::fs::write(&child, "held").unwrap();
                            _held = Some(std::fs::OpenOptions::new().read(true).share_mode(0).open(&child).unwrap());
                        }
                        entry_in(trash_home, &root, rel, true, 0)
                    }
                    other => panic!("unknown step {other}"),
                };
                let answer = &step["answer"];
                let want = if step["op"] == "info" { answer } else { answer.get("result").unwrap_or(&Value::Null) };
                match got {
                    Ok(got) => assert_eq!(got, fill_value(want), "step {at} ({rel}): the answer"),
                    Err(error) => {
                        let message = fill(answer["error"]["message"].as_str().unwrap_or_else(|| panic!("step {at} ({rel}): Node answered {answer}, got {error:?}")));
                        assert_eq!(error.message, message, "step {at} ({rel}): the message");
                        let code = match &error.reason {
                            Reason::Coded(code) => Some(code.to_string()),
                            _ => None,
                        };
                        assert_eq!(code.as_deref(), answer["error"]["code"].as_str(), "step {at} ({rel}): the code");
                    }
                }
                if let Some(info) = step["info"].as_str() {
                    let count = trashed_again.entry(rel.to_owned()).or_insert(0);
                    *count += 1;
                    let name = if *count == 1 { rel.to_owned() } else { format!("{rel}.{count}") };
                    let written = std::fs::read_to_string(home.join("info").join(format!("{name}.trashinfo"))).unwrap();
                    assert_eq!(written, fill(info), "step {at} ({rel}): the .trashinfo");
                }
            }
        });
    }
}

