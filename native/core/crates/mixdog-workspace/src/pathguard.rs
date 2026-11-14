#![allow(clippy::disallowed_methods, clippy::disallowed_types, reason = "blocking file bodies run only as lane jobs (lanes::run_fallible); the service never calls them on an async thread")]
//! Traversal- and symlink-guarded project paths (port of `projectEntryPathIn`).

use std::io;
use std::path::Component;
use std::path::Path;
use std::path::PathBuf;

use crate::error::WsError;
use crate::error::WsResult;

/// Case-folded on Windows, where paths compare case-insensitively.
pub fn comparable(path: &Path) -> PathBuf {
    if cfg!(windows) {
        PathBuf::from(path.to_string_lossy().to_lowercase())
    } else {
        path.to_path_buf()
    }
}

/// `path` is `root` or under it, component-wise.
pub fn is_within(root: &Path, path: &Path) -> bool {
    comparable(path).starts_with(comparable(root))
}

/// Resolves `.` and `..` without touching the disk.
pub fn lexical(path: &Path) -> PathBuf {
    let mut out = PathBuf::new();
    for component in path.components() {
        match component {
            Component::CurDir => {}
            Component::ParentDir => {
                if !out.pop() {
                    out.push("..");
                }
            }
            other => out.push(other.as_os_str()),
        }
    }
    out
}

/// `fs::canonicalize` without the Windows verbatim prefix.
pub fn canonical(path: &Path) -> io::Result<PathBuf> {
    let real = std::fs::canonicalize(path)?;
    Ok(strip_verbatim(real))
}

fn strip_verbatim(path: PathBuf) -> PathBuf {
    let text = path.to_string_lossy();
    if let Some(rest) = text.strip_prefix(r"\\?\UNC\") {
        return PathBuf::from(format!(r"\\{rest}"));
    }
    if let Some(rest) = text.strip_prefix(r"\\?\") {
        if rest.as_bytes().get(1) == Some(&b':') {
            return PathBuf::from(rest);
        }
    }
    path
}

/// The canonical form of `path` through its nearest existing ancestor.
pub fn canonical_through_existing(path: &Path) -> io::Result<PathBuf> {
    let mut existing = path.to_path_buf();
    let mut missing: Vec<std::ffi::OsString> = Vec::new();
    while !existing.exists() {
        let Some(parent) = existing.parent().map(Path::to_path_buf) else { break };
        let Some(name) = existing.file_name().map(|n| n.to_os_string()) else { break };
        missing.push(name);
        existing = parent;
    }
    let mut real = canonical(&existing)?;
    for name in missing.into_iter().rev() {
        real.push(name);
    }
    Ok(real)
}

/// Node's `path.resolve`: absolute against the process folder, separators and `.`/`..` settled
/// lexically (a `..` at the root stays at the root), without touching the disk.
pub fn resolve(path: &Path) -> PathBuf {
    let path = if path.as_os_str().is_empty() { Path::new(".") } else { path };
    let full = std::path::absolute(path).unwrap_or_else(|_| path.to_path_buf());
    let mut out = PathBuf::new();
    for component in full.components() {
        match component {
            Component::CurDir => {}
            Component::ParentDir => {
                out.pop();
            }
            other => out.push(other.as_os_str()),
        }
    }
    out
}

/// Node's `canonicalPath` (`src/runtime/shared/worktrees/paths.mjs`): `resolve`, then the real path of
/// the nearest existing ancestor with the missing tail kept; the resolved path itself when no ancestor
/// can be read.
pub fn canonical_path(path: &Path) -> PathBuf {
    let full = resolve(path);
    let mut head = full.as_path();
    while !head.exists() {
        match head.parent() {
            Some(parent) => head = parent,
            None => return full,
        }
    }
    let Ok(real) = canonical(head) else { return full };
    match full.strip_prefix(head) {
        Ok(rest) if !rest.as_os_str().is_empty() => real.join(rest),
        _ => real,
    }
}

/// Absolute path of a project-relative entry; neither `..` nor a link may
/// leave the project.
pub fn project_entry_path(root: &Path, rel: &str) -> WsResult<PathBuf> {
    if !root.is_absolute() {
        return Err(WsError::invalid("Project root must be absolute."));
    }
    let root = lexical(root);
    let rel = rel.replace('\\', "/");
    let target = lexical(&root.join(rel));
    if !is_within(&root, &target) {
        return Err(WsError::denied(OUTSIDE_PROJECT));
    }
    let canonical_root = node_realpath(&root).map_err(|error| error.node())?;
    let canonical_target = node_realpath_through_existing(&target).map_err(|error| error.node())?;
    if !is_within(&canonical_root, &canonical_target) {
        return Err(WsError::denied(RESOLVES_OUTSIDE_PROJECT));
    }
    Ok(target)
}

/// Node's `fs.realpathSync` (the JS walk, not `.native`) failing: the call that failed (`lstat`, or `stat` and `readlink` of a link), its cause, and
/// the path it was made on, as the walk had built it.
#[derive(Debug)]
pub struct RealpathError {
    pub cause: io::Error,
    pub syscall: &'static str,
    pub at: PathBuf,
}

impl RealpathError {
    /// The error Node threw: its libuv name and `<name>: <description>, <syscall> '<path>'` text.
    pub fn node(&self) -> WsError {
        crate::nodeerr::io_error(&self.cause, self.syscall, &self.at)
    }
}

/// Node's `fs.realpathSync` (the JS walk, not `.native`): the path's components are taken one by one and a link is replaced by its target;
/// nothing else is rewritten, so a mapped drive letter stays a drive letter and an 8.3 name stays as given (the OS's canonical form names
/// the share, and spells the long name).
pub fn node_realpath(path: &Path) -> Result<PathBuf, RealpathError> {
    const MAX_LINKS: usize = 40;
    let fail = |cause: io::Error, syscall: &'static str, at: &Path| RealpathError { cause, syscall, at: at.to_path_buf() };
    let split = |full: &Path| {
        let mut root = PathBuf::new();
        let mut names = std::collections::VecDeque::new();
        for component in full.components() {
            match component {
                Component::Prefix(_) | Component::RootDir => root.push(component.as_os_str()),
                other => names.push_back(other.as_os_str().to_os_string()),
            }
        }
        (root, names)
    };
    let (mut resolved, mut names) = split(&resolve(path));
    if cfg!(windows) {
        std::fs::symlink_metadata(&resolved).map_err(|cause| fail(cause, "lstat", &resolved))?;
    }
    let mut links = 0;
    while let Some(name) = names.pop_front() {
        let next = resolved.join(&name);
        let meta = std::fs::symlink_metadata(&next).map_err(|cause| fail(cause, "lstat", &next))?;
        if !meta.file_type().is_symlink() {
            resolved = next;
            continue;
        }
        links += 1;
        if links > MAX_LINKS {
            return Err(fail(io::Error::other("too many symbolic links"), "lstat", &next));
        }
        // Node `stat`s the link (following it) before it reads it, so a dangling link fails as that `stat`.
        std::fs::metadata(&next).map_err(|cause| fail(cause, "stat", &next))?;
        let target = strip_verbatim(std::fs::read_link(&next).map_err(|cause| fail(cause, "readlink", &next))?);
        let (root, mut head) = split(&resolve(&resolved.join(target)));
        head.extend(names);
        (resolved, names) = (root, head);
    }
    Ok(resolved)
}

/// The real path of `path` through its nearest existing ancestor, as the guard reads it: `existsSync` of each ancestor, then
/// `resolve(realpathSync(existing), ...missing)`.
fn node_realpath_through_existing(path: &Path) -> Result<PathBuf, RealpathError> {
    let mut existing = path;
    let mut missing: Vec<&std::ffi::OsStr> = Vec::new();
    while !existing.exists() {
        let (Some(parent), Some(name)) = (existing.parent(), existing.file_name()) else { break };
        missing.push(name);
        existing = parent;
    }
    let mut real = node_realpath(existing)?;
    real.extend(missing.into_iter().rev());
    Ok(real)
}

pub const OUTSIDE_PROJECT: &str = "Path is outside the project.";
pub const RESOLVES_OUTSIDE_PROJECT: &str = "Path resolves outside the project.";

/// The refusal of [`project_entry_path`] for a path beyond the project. Every caller gets the permission refusal; the phone's calls (which
/// ask for `nodeErrors`) are answered with Node's plain `Error` of the same text (service.rs `map_error`).
pub fn is_beyond_project(error: &WsError) -> bool {
    matches!(error.reason, crate::error::Reason::PermissionDenied) && (error.message == OUTSIDE_PROJECT || error.message == RESOLVES_OUTSIDE_PROJECT)
}

/// Node's `absoluteLocalPath` (local-files.ts): the string trimmed, shape-checked, required to be absolute by the host's
/// `path.isAbsolute` (on Windows that includes a rooted `\dir`, which `path.resolve` then puts on the working directory's drive), and
/// resolved by the host's `path.resolve`.
pub fn absolute_local_path(value: &str) -> WsResult<PathBuf> {
    absolute_local_path_in(mixdog_js::nodepath::Style::host(), value)
}

/// [`absolute_local_path`] under the path rules of `style` (Node's `path` is `path.win32` on a Windows host and `path.posix` elsewhere).
pub fn absolute_local_path_in(style: mixdog_js::nodepath::Style, value: &str) -> WsResult<PathBuf> {
    let text = mixdog_js::js_trim(value);
    if text.is_empty() || mixdog_js::utf16_len(text) > 16_384 || text.contains('\0') {
        return Err(WsError::invalid("path is invalid."));
    }
    if !mixdog_js::nodepath::is_absolute(style, text) {
        return Err(WsError::invalid("path must be absolute."));
    }
    Ok(PathBuf::from(mixdog_js::nodepath::resolve(style, &[text])))
}

/// How Node's project registry reads a path (`resolveProjectPath`, projects.mjs:251, behind `knownPath`, `ensureDir` and the catalog): the
/// string trimmed and, unless empty, resolved by the host's `path.resolve` against the working directory. Nothing else is checked and a
/// relative path is not refused, unlike `absoluteLocalPath` (local-files.ts:7), which the local-file operations use.
pub fn project_path(value: &str) -> Option<PathBuf> {
    let cwd = std::env::current_dir().map(|dir| dir.to_string_lossy().into_owned()).unwrap_or_default();
    project_path_in(mixdog_js::nodepath::Style::host(), &cwd, value).map(PathBuf::from)
}

/// [`project_path`] under the path rules of `style` with `cwd` as the working directory: Node's `toAbsolute` (projects.mjs:21),
/// `isAbsolute(text) ? resolve(text) : resolve(process.cwd(), text)`.
pub fn project_path_in(style: mixdog_js::nodepath::Style, cwd: &str, value: &str) -> Option<String> {
    use mixdog_js::nodepath::{is_absolute, resolve};
    let text = mixdog_js::js_trim(value);
    if text.is_empty() {
        return None;
    }
    Some(if is_absolute(style, text) { resolve(style, &[text]) } else { resolve(style, &[cwd, text]) })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn outside_and_symlink_escape_refused() {
        let dir = tempfile::tempdir().unwrap();
        let root = canonical(dir.path()).unwrap();
        std::fs::create_dir(root.join("in")).unwrap();
        assert_eq!(project_entry_path(&root, "in/new.txt").unwrap(), root.join("in").join("new.txt"));
        let err = project_entry_path(&root, "../escape.txt").unwrap_err();
        assert_eq!((err.reason.clone(), err.message.as_str()), (crate::error::Reason::PermissionDenied, "Path is outside the project."));
        let outside = tempfile::tempdir().unwrap();
        #[cfg(unix)]
        std::os::unix::fs::symlink(outside.path(), root.join("link")).unwrap();
        #[cfg(windows)]
        if std::os::windows::fs::symlink_dir(outside.path(), root.join("link")).is_err() {
            return;
        }
        let err = project_entry_path(&root, "link/x.txt").unwrap_err();
        assert_eq!(err.message, "Path resolves outside the project.");
    }

    /// Node's `realpathSync` walk: a link's relative target is taken from the link's own folder, a component that is missing past it
    /// fails as `lstat` of the path the walk had built (the link replaced by its target), not of the spelling given, and a dangling link
    /// fails as the `stat` of the link itself.
    #[test]
    fn node_realpath_replaces_a_link_by_its_target_and_names_the_missing_component() {
        let dir = tempfile::tempdir().unwrap();
        let root = canonical(dir.path()).unwrap();
        std::fs::create_dir_all(root.join("a").join("real")).unwrap();
        #[cfg(unix)]
        std::os::unix::fs::symlink("real", root.join("a").join("link")).unwrap();
        #[cfg(windows)]
        if std::os::windows::fs::symlink_dir("real", root.join("a").join("link")).is_err() {
            return;
        }
        assert_eq!(node_realpath(&root.join("a").join("link")).unwrap(), root.join("a").join("real"));
        let err = node_realpath(&root.join("a").join("link").join("gone")).unwrap_err();
        assert_eq!((err.syscall, err.at), ("lstat", root.join("a").join("real").join("gone")));
        #[cfg(unix)]
        std::os::unix::fs::symlink("nowhere", root.join("a").join("dangling")).unwrap();
        #[cfg(windows)]
        std::os::windows::fs::symlink_dir("nowhere", root.join("a").join("dangling")).unwrap();
        let err = node_realpath(&root.join("a").join("dangling")).unwrap_err();
        assert_eq!((err.syscall, err.at), ("stat", root.join("a").join("dangling")));
    }

    /// A root that is gone fails as Node's `realpathSync` did: `lstat` of its first missing component.
    #[test]
    fn missing_root_fails_with_node_realpath_sync_text() {
        let dir = tempfile::tempdir().unwrap();
        let root = canonical(dir.path()).unwrap();
        let err = project_entry_path(&root.join("gone").join("deeper"), "a.ts").unwrap_err();
        assert_eq!(err.reason, crate::error::Reason::Coded("ENOENT"));
        assert_eq!(err.message, format!("ENOENT: no such file or directory, lstat '{}'", root.join("gone").display()));
    }

    /// Node's `absoluteLocalPath` for every recorded input (apps/mobile/fixtures/absolute-local-path/golden.json, a Windows host), as the
    /// recording with the working directory on this process's drive answered it. Non-string inputs are answered by the service's param
    /// check (tests/it/service.rs), not by this helper.
    #[cfg(windows)]
    #[test]
    fn absolute_local_path_answers_each_recorded_input_as_node_does() {
        let golden: serde_json::Value = serde_json::from_str(mixdog_testkit::fixture!("../../../../apps/mobile/fixtures/absolute-local-path/golden.json")).unwrap();
        let drive: String = std::env::current_dir().unwrap().to_string_lossy().chars().next().unwrap().to_ascii_uppercase().to_string();
        let recorded = golden["drives"].get(&drive).unwrap_or_else(|| panic!("absolute-local-path has no recording with the working directory on drive {drive}: record it on a host with that drive (benchmarks/rust-core/recorders/record-absolute-local-path.mjs)"));
        let mut replayed = 0;
        for (input, answer) in golden["inputs"].as_array().unwrap().iter().zip(recorded.as_array().unwrap()) {
            let Some(text) = input["value"].as_str() else { continue };
            let got = absolute_local_path(text).map(|path| path.to_string_lossy().into_owned()).map_err(|error| error.message);
            let want = match answer.get("result") {
                Some(result) => Ok(result.as_str().unwrap().to_owned()),
                None => Err(answer["error"]["message"].as_str().unwrap().to_owned()),
            };
            assert_eq!(got, want, "{}: {text:?}", input["name"]);
            replayed += 1;
        }
        assert_eq!(replayed, golden["inputs"].as_array().unwrap().iter().filter(|input| input["value"].is_string()).count());
    }

    /// The same function under the POSIX rules, against Node's answers with `node:path` as `path.posix` (the `posix` section of the same recording,
    /// made by loading local-files.ts with that path module): the criterion holds on both kinds of host.
    #[test]
    fn absolute_local_path_answers_each_recorded_posix_input_as_node_does() {
        let golden: serde_json::Value = serde_json::from_str(mixdog_testkit::fixture!("../../../../apps/mobile/fixtures/absolute-local-path/golden.json")).unwrap();
        let posix = &golden["posix"];
        let mut replayed = 0;
        for (input, answer) in posix["inputs"].as_array().unwrap().iter().zip(posix["answers"].as_array().unwrap()) {
            let text = input["value"].as_str().unwrap();
            let got = absolute_local_path_in(mixdog_js::nodepath::Style::Posix, text).map(|path| path.to_string_lossy().into_owned()).map_err(|error| error.message);
            let want = match answer.get("result") {
                Some(result) => Ok(result.as_str().unwrap().to_owned()),
                None => Err(answer["error"]["message"].as_str().unwrap().to_owned()),
            };
            assert_eq!(got, want, "{}: {text:?}", input["name"]);
            replayed += 1;
        }
        assert_eq!(replayed, 23);
    }

    /// Node's `resolveProjectPath` under the POSIX rules (apps/mobile/fixtures/project-path-classes/golden.json, `posix`: projects.mjs
    /// loaded with `node:path` as `path.posix` and the recording's working directory), replayed against the rule every project-path
    /// read of the workspace takes.
    #[test]
    fn project_path_answers_each_recorded_posix_input_as_node_does() {
        let golden: serde_json::Value = serde_json::from_str(include_str!("../../../../../apps/mobile/fixtures/project-path-classes/golden.json")).unwrap();
        let posix = &golden["posix"];
        let cwd = posix["cwd"].as_str().unwrap();
        let inputs = posix["inputs"].as_array().unwrap();
        let answers = posix["answers"].as_array().unwrap();
        assert_eq!(inputs.len(), answers.len());
        for (input, answer) in inputs.iter().zip(answers) {
            let got = project_path_in(mixdog_js::nodepath::Style::Posix, cwd, input["value"].as_str().unwrap()).unwrap_or_default();
            assert_eq!(got, answer["result"].as_str().unwrap(), "{}", input["name"]);
        }
    }
}
