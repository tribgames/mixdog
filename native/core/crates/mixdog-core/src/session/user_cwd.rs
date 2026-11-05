//! Today's `src/runtime/shared/user-cwd.mjs`: the explicit session cwd and the per-terminal
//! last session cwd. The inline-session scope (`runWithCwdOverride`) is the thread's header
//! `cwd`, which [`super::SessionHandle::explicit_cwd`] passes in.

use std::path::Path;
use std::path::PathBuf;

use mixdog_js::is_js_space;
use mixdog_js::js_trim;
use mixdog_store::fsio::Access;
use mixdog_store::fsio::publish_file_with;

/// The cwd files under the data dir (`resolvePluginData()`).
#[derive(Clone, Debug)]
pub struct UserCwd {
    data_dir: PathBuf,
}

impl UserCwd {
    pub fn new(data_dir: impl Into<PathBuf>) -> Self {
        Self { data_dir: data_dir.into() }
    }

    /// `explicitSessionCwd()`: the scope's cwd, then a live `MIXDOG_SESSION_CWD`, then
    /// `<data>/user-cwd.txt`; never the process cwd.
    pub async fn explicit_cwd(&self, scoped: Option<&str>) -> Option<String> {
        // `runWithCwdOverride` stores `normalized || String(cwd)`.
        if let Some(scoped) = scoped.filter(|cwd| !cwd.is_empty()) {
            return Some(normalize_platform_cwd(scoped).unwrap_or_else(|| scoped.to_owned()));
        }
        if let Ok(raw) = std::env::var("MIXDOG_SESSION_CWD")
            && !raw.is_empty()
            && let Some(dir) = existing_directory(&raw).await
        {
            return Some(dir);
        }
        let raw = read_text(&self.data_dir.join("user-cwd.txt")).await?;
        // A crash can leave NUL bytes in place of the path: that is no path.
        if holds_no_data(&raw) {
            return None;
        }
        let txt = js_trim(&raw);
        if txt.is_empty() {
            return None;
        }
        normalize_platform_cwd(txt).filter(|cwd| !cwd.is_empty())
    }

    /// `readLastSessionCwd(keyPid)`: this terminal's last `cwd set`, when it is still a
    /// directory.
    pub async fn last_cwd(&self, key_pid: Option<&str>) -> Option<String> {
        let raw = read_text(&self.last_cwd_file(key_pid)).await?;
        if holds_no_data(&raw) {
            return None;
        }
        existing_directory(js_trim(&raw)).await
    }

    /// `writeLastSessionCwd(cwd, keyPid)`: best effort.
    pub async fn write_last_cwd(&self, cwd: &str, key_pid: Option<&str>) {
        let (path, bytes) = (self.last_cwd_file(key_pid), cwd.as_bytes().to_vec());
        let _ = tokio::task::spawn_blocking(move || publish_file_with(&path, &bytes, Access::Inherit)).await;
    }

    /// `_lastSessionCwdFile(keyPid)`: keyed by the connection's lead pid, else
    /// `MIXDOG_SUPERVISOR_PID`, else `solo`.
    fn last_cwd_file(&self, key_pid: Option<&str>) -> PathBuf {
        let raw = match key_pid.filter(|pid| !pid.is_empty()) {
            Some(pid) => Some(pid.to_owned()),
            None => std::env::var("MIXDOG_SUPERVISOR_PID").ok(),
        };
        let key = raw
            .filter(|raw| !raw.is_empty() && raw.bytes().all(|b| b.is_ascii_digit()))
            .unwrap_or_else(|| "solo".into());
        self.data_dir.join(format!("session-cwd-{key}.txt"))
    }
}

async fn read_text(path: &Path) -> Option<String> {
    let bytes = tokio::fs::read(path).await.ok()?;
    Some(String::from_utf8_lossy(&bytes).into_owned())
}

/// `holdsNoData` of a string: `/^[\0\s]*$/`.
fn holds_no_data(text: &str) -> bool {
    text.chars().all(|c| c == '\0' || is_js_space(c))
}

/// `_existingDirectory(raw)`: the normalized path when it names a live directory.
async fn existing_directory(raw: &str) -> Option<String> {
    let normalized = normalize_platform_cwd(raw).filter(|cwd| !cwd.is_empty())?;
    let meta = tokio::fs::metadata(&normalized).await.ok()?;
    meta.is_dir().then_some(normalized)
}

/// `_normalizePlatformCwd(p)`: on Windows the MSYS, Cygwin and WSL drive prefixes become
/// native paths; then `path.resolve`. `None` for an empty path (returned unchanged in Node).
pub fn normalize_platform_cwd(p: &str) -> Option<String> {
    if p.is_empty() {
        return None;
    }
    if !cfg!(windows) {
        return Some(node_resolve(p));
    }
    let drive = |at: usize| p.as_bytes().get(at).copied().filter(u8::is_ascii_alphabetic);
    let native = if p.starts_with("/cygdrive/") && p.as_bytes().get(11) == Some(&b'/') && drive(10).is_some() {
        format!("{}:\\{}", (drive(10)? as char).to_ascii_uppercase(), p[11..].replace('/', "\\"))
    } else if p.starts_with("/mnt/") && p.as_bytes().get(6) == Some(&b'/') && drive(5).is_some() {
        format!("{}:\\{}", (drive(5)? as char).to_ascii_uppercase(), p[7..].replace('/', "\\"))
    } else {
        let sep = |at: usize| matches!(p.as_bytes().get(at), Some(b'/' | b'\\'));
        // `^[/\\]([a-zA-Z])[/\\](.*)$`: `.` stops at line terminators.
        let rest_ok = p.get(3..).is_some_and(|rest| !rest.contains(['\n', '\r', '\u{2028}', '\u{2029}']));
        if sep(0) && drive(1).is_some() && sep(2) && rest_ok {
            format!("{}:\\{}", (drive(1)? as char).to_ascii_uppercase(), p[3..].replace('/', "\\"))
        } else {
            p.to_owned()
        }
    };
    Some(node_resolve(&native))
}

/// Node's `path.resolve(p)` against the process cwd: absolute, `.` and `..` folded, no
/// trailing separator except at a root.
fn node_resolve(p: &str) -> String {
    use std::path::Component;
    let joined = std::env::current_dir().unwrap_or_default().join(p);
    let absolute = std::path::absolute(&joined).unwrap_or(joined);
    let mut out = PathBuf::new();
    for part in absolute.components() {
        match part {
            Component::CurDir => {}
            Component::ParentDir => {
                out.pop();
            }
            other => out.push(other.as_os_str()),
        }
    }
    let text = out.to_string_lossy().into_owned();
    if cfg!(windows) { text.replace('/', "\\") } else { text }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn the_explicit_cwd_prefers_the_scope_then_the_saved_file() {
        let data = tempfile::tempdir().expect("data");
        let cwd = UserCwd::new(data.path());
        assert_eq!(cwd.explicit_cwd(Some("/scoped")).await, normalize_platform_cwd("/scoped"));
        if std::env::var("MIXDOG_SESSION_CWD").is_ok() {
            return;
        }
        assert_eq!(cwd.explicit_cwd(None).await, None);
        std::fs::write(data.path().join("user-cwd.txt"), "\0\0 \n").unwrap();
        assert_eq!(cwd.explicit_cwd(None).await, None, "a crash leftover is no path");
        let dir = data.path().to_string_lossy().into_owned();
        std::fs::write(data.path().join("user-cwd.txt"), format!("  {dir}\n")).unwrap();
        assert_eq!(cwd.explicit_cwd(None).await, normalize_platform_cwd(&dir));
    }

    #[tokio::test]
    async fn the_last_cwd_is_keyed_per_terminal_and_must_still_exist() {
        let data = tempfile::tempdir().expect("data");
        let cwd = UserCwd::new(data.path());
        let dir = data.path().to_string_lossy().into_owned();
        cwd.write_last_cwd(&dir, Some("4242")).await;
        assert!(data.path().join("session-cwd-4242.txt").exists());
        assert_eq!(cwd.last_cwd(Some("4242")).await, normalize_platform_cwd(&dir));
        assert_eq!(cwd.last_cwd(Some("1")).await, None);
        cwd.write_last_cwd(&data.path().join("gone").to_string_lossy(), Some("7")).await;
        assert_eq!(cwd.last_cwd(Some("7")).await, None, "a removed directory is no cwd");
        // A non-numeric key falls back to `solo`.
        cwd.write_last_cwd(&dir, Some("abc")).await;
        assert!(data.path().join("session-cwd-solo.txt").exists());
    }

    #[cfg(windows)]
    #[test]
    fn posix_drive_prefixes_become_native_paths() {
        assert_eq!(normalize_platform_cwd("/c/Project/x").as_deref(), Some("C:\\Project\\x"));
        assert_eq!(normalize_platform_cwd("/mnt/d/a/").as_deref(), Some("D:\\a"));
        assert_eq!(normalize_platform_cwd("/cygdrive/e/b").as_deref(), Some("E:\\b"));
        assert_eq!(normalize_platform_cwd("C:\\a\\..\\b").as_deref(), Some("C:\\b"));
    }
}
