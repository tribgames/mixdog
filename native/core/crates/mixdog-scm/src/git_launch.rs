//! The git executable a child is started with, and the environment it starts with
//! (`src/runtime/shared/git-launch.mjs` at b6f10295a).
//!
//! On Windows `git` on PATH is usually Git for Windows' launcher, `<root>\cmd\git.exe` (or the
//! identical `<root>\bin\git.exe`), which only prepares an environment and starts
//! `<root>\<msystem>\bin\git.exe`. When PATH's git is that launcher the children start the real
//! binary directly with the environment the launcher would have built (git-wrapper.c's
//! `setup_environment`). Anything else — another platform, a scoop shim, MinGit, a `git.exe`
//! outside such a layout, an ambiguous or incomplete install — keeps plain `git` and the
//! caller's environment.

#![allow(clippy::disallowed_methods, clippy::disallowed_types, reason = "every blocking std::fs call in this module is the body of a lane job")]

use std::collections::HashMap;
use std::path::Path;
use std::path::PathBuf;
use std::sync::Mutex;
use std::sync::OnceLock;

#[cfg(all(test, windows))]
mod tests;

/// The wrapper's compile-time MSYSTEM, lower-cased, names its binary directory.
const MSYSTEM_DIRECTORIES: [&str; 3] = ["mingw64", "clangarm64", "mingw32"];

/// `resolveGitLaunch`'s answer: the layout behind PATH's `git`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Layout {
    pub command: String,
    pub root: String,
    pub msystem: String,
    pub msys_config: Vec<String>,
}

/// What a child is started with: the program, and the environment variables to set on top of
/// the inherited ones.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Launch {
    pub program: String,
    pub env: Vec<(String, String)>,
}

fn is_file(path: &Path) -> bool {
    path.is_file()
}

fn is_dir(path: &Path) -> bool {
    path.is_dir()
}

/// `path.win32.isAbsolute`.
fn win32_is_absolute(entry: &str) -> bool {
    let bytes = entry.as_bytes();
    let separator = |byte: u8| byte == b'/' || byte == b'\\';
    match bytes {
        [] => false,
        [first, ..] if separator(*first) => true,
        [letter, b':', third, ..] => letter.is_ascii_alphabetic() && separator(*third),
        _ => false,
    }
}

/// libuv's search for a bare `git` (no directory, no extension): each PATH entry in order,
/// `git.com` before `git.exe`.
fn launcher_on_path(path_value: &str) -> Option<PathBuf> {
    for raw in path_value.split(';') {
        let raw = raw.trim();
        let entry = raw.strip_prefix('"').and_then(|rest| rest.strip_suffix('"')).unwrap_or(raw);
        if entry.is_empty() {
            continue;
        }
        // A relative entry resolves against each child's cwd: not decidable once.
        if !win32_is_absolute(entry) {
            return None;
        }
        if is_file(&Path::new(entry).join("git.com")) {
            return None;
        }
        let candidate = Path::new(entry).join("git.exe");
        if is_file(&candidate) {
            return Some(candidate);
        }
    }
    None
}

/// `realpathSync.native`: libuv drops the `\\?\` of a drive path and turns `\\?\UNC\server\share`
/// into `\\server\share`; any other verbatim form is an error.
pub fn native_realpath(path: &Path) -> Option<String> {
    let resolved = std::fs::canonicalize(path).ok()?.to_string_lossy().into_owned();
    let Some(rest) = resolved.strip_prefix(r"\\?\") else {
        return Some(resolved);
    };
    normalize_verbatim(rest)
}

/// The part after `\\?\` of a final path name, as libuv words it.
pub fn normalize_verbatim(after_prefix: &str) -> Option<String> {
    if let Some(unc) = after_prefix.strip_prefix(r"UNC\") {
        return Some(format!(r"\\{unc}"));
    }
    let bytes = after_prefix.as_bytes();
    (bytes.len() >= 3 && bytes[1] == b':' && bytes[2] == b'\\').then(|| after_prefix.to_owned())
}

/// etc\git-bash.config `MSYS=` lines, each prepended to MSYS in file order.
fn read_msys_config(root: &Path) -> Vec<String> {
    let Ok(bytes) = std::fs::read(root.join("etc").join("git-bash.config")) else {
        return Vec::new();
    };
    String::from_utf8_lossy(&bytes)
        .split('\n')
        .map(|line| line.strip_suffix('\r').unwrap_or(line))
        .filter_map(|line| line.strip_prefix("MSYS=").map(str::to_owned))
        .collect()
}

/// `resolveGitLaunch({ platform: 'win32', pathValue })`.
pub fn resolve_layout(path_value: &str) -> Option<Layout> {
    let found = launcher_on_path(path_value)?;
    let launcher = PathBuf::from(native_realpath(&found)?);
    if !launcher.file_name()?.eq_ignore_ascii_case("git.exe") {
        return None;
    }
    let directory = launcher.parent()?;
    let name = directory.file_name()?;
    if !name.eq_ignore_ascii_case("cmd") && !name.eq_ignore_ascii_case("bin") {
        return None;
    }
    let root = directory.parent()?;
    // The installer and PortableGit ship git-bash.exe; MinGit and other layouts do not.
    if !is_file(&root.join("git-bash.exe")) || !is_dir(&root.join("usr").join("bin")) {
        return None;
    }
    let installed: Vec<&str> = MSYSTEM_DIRECTORIES.into_iter().filter(|name| is_file(&root.join(name).join("bin").join("git.exe"))).collect();
    let [msystem_directory] = installed.as_slice() else {
        return None;
    };
    Some(Layout {
        command: root.join(msystem_directory).join("bin").join("git.exe").to_string_lossy().into_owned(),
        root: root.to_string_lossy().into_owned(),
        msystem: msystem_directory.to_uppercase(),
        msys_config: read_msys_config(root),
    })
}

pub type Env = Vec<(String, String)>;

/// Windows names are case-insensitive. Of several spellings in one environment Node passes the
/// first in sorted order to the child, so that one is read and written.
fn env_key(env: &Env, name: &str) -> String {
    let upper = name.to_uppercase();
    env.iter().map(|(key, _)| key).filter(|key| key.to_uppercase() == upper).min().cloned().unwrap_or_else(|| name.to_owned())
}

fn env_value(env: &Env, name: &str) -> Option<String> {
    let key = env_key(env, name);
    env.iter().find(|(k, _)| *k == key).map(|(_, value)| value.clone())
}

fn env_set(env: &mut Env, name: &str, value: String) {
    let key = env_key(env, name);
    match env.iter_mut().find(|(k, _)| *k == key) {
        Some(entry) => entry.1 = value,
        None => env.push((key, value)),
    }
}

/// The wrapper's my_path_append: one backslash between the parts.
fn append_path(list: &str, part: &str) -> String {
    if list.ends_with('\\') { format!("{list}{part}") } else { format!("{list}\\{part}") }
}

/// `path.win32.join(base, 'System32')`, for comparing a directory with the system one.
fn win32_join_system32(base: &str) -> String {
    let unified = format!("{base}\\System32").replace('/', "\\");
    let (prefix, rest) = match unified.strip_prefix(r"\\") {
        Some(unc) => (r"\\", unc),
        None => ("", unified.as_str()),
    };
    let mut parts: Vec<&str> = Vec::new();
    for part in rest.split('\\').filter(|p| !p.is_empty() && *p != ".") {
        if part == ".." && parts.last().is_some_and(|last| *last != ".." && !last.ends_with(':')) {
            parts.pop();
        } else {
            parts.push(part);
        }
    }
    let rooted = if prefix.is_empty() && rest.starts_with('\\') { "\\" } else { prefix };
    format!("{rooted}{}", parts.join("\\"))
}

fn is_system_directory(path: &str, system_root: &str) -> bool {
    path.to_lowercase() == win32_join_system32(system_root).to_lowercase()
}

/// `SystemRoot || windir || 'C:\Windows'` of this process.
fn process_system_root() -> String {
    ["SystemRoot", "windir"]
        .iter()
        .find_map(|name| std::env::var(name).ok().filter(|value| !value.is_empty()))
        .unwrap_or_else(|| "C:\\Windows".to_owned())
}

/// `gitLaunchEnvironment(layout, base)`: `base` as the launcher would hand it to the real git
/// (setup_environment).
pub fn launch_environment(layout: &Layout, base: &Env) -> Env {
    launch_environment_in(layout, base, &process_system_root())
}

fn launch_environment_in(layout: &Layout, base: &Env, system_root: &str) -> Env {
    let mut env = base.clone();
    env_set(&mut env, "MSYSTEM", layout.msystem.clone());
    if env_value(&env, "PLINK_PROTOCOL").is_none() {
        env_set(&mut env, "PLINK_PROTOCOL", "ssh".to_owned());
    }
    if env_value(&env, "HOME").is_none() {
        let home_path = env_value(&env, "HOMEPATH");
        let drive = format!("{}{}", env_value(&env, "HOMEDRIVE").unwrap_or_default(), home_path.clone().unwrap_or_default());
        if home_path.is_some() && !is_system_directory(&drive, system_root) && is_dir(Path::new(&drive)) {
            env_set(&mut env, "HOME", drive);
        } else if let Some(profile) = env_value(&env, "USERPROFILE") {
            env_set(&mut env, "HOME", profile);
        }
    }
    // <root>\<msystem>\bin;<root>\usr\bin;<HOME>\bin; ahead of the inherited PATH.
    let prefix = format!(
        "{};{}{}",
        append_path(&layout.root, &format!("{}\\bin", layout.msystem.to_lowercase())),
        append_path(&layout.root, "usr\\bin;"),
        append_path(&env_value(&env, "HOME").unwrap_or_default(), "bin;"),
    );
    let path = format!("{prefix}{}", env_value(&env, "PATH").unwrap_or_default());
    env_set(&mut env, "PATH", path);
    for msys in &layout.msys_config {
        let joined = match env_value(&env, "MSYS") {
            None => msys.clone(),
            Some(current) => format!("{msys} {current}"),
        };
        env_set(&mut env, "MSYS", joined);
    }
    env
}

/// PATH value -> its layout (or none), resolved once per PATH: a child is started with the git
/// its own environment's PATH names, as bare `git` is.
fn resolved() -> &'static Mutex<HashMap<String, Option<Layout>>> {
    static RESOLVED: OnceLock<Mutex<HashMap<String, Option<Layout>>>> = OnceLock::new();
    RESOLVED.get_or_init(Mutex::default)
}

fn layout_for(path_value: &str) -> Option<Layout> {
    if !cfg!(windows) {
        return None;
    }
    let mut cache = resolved().lock().unwrap_or_else(|e| e.into_inner());
    cache.entry(path_value.to_owned()).or_insert_with(|| resolve_layout(path_value)).clone()
}

/// The environment of this process.
pub fn process_env() -> Env {
    std::env::vars_os().map(|(k, v)| (k.to_string_lossy().into_owned(), v.to_string_lossy().into_owned())).collect()
}

/// `gitCommand(env)` and `gitChildEnv(env)` together, for `base` (the environment the child
/// would inherit): the program, and the variables that differ from `base`.
pub fn launch_for(base: &Env) -> Launch {
    let Some(layout) = layout_for(&env_value(base, "PATH").unwrap_or_default()) else {
        return Launch { program: "git".to_owned(), env: Vec::new() };
    };
    let changed = launch_environment(&layout, base)
        .into_iter()
        .filter(|(key, value)| base.iter().find(|(k, _)| k == key).is_none_or(|(_, before)| before != value))
        .collect();
    Launch { program: layout.command, env: changed }
}

/// `gitCommand()`: the program a git child of this process is started with, and the one a
/// timeout message names (`run-child.mjs`: `${command} ${args} timed out after ${ms}ms`).
pub fn git_command() -> String {
    let base = process_env();
    layout_for(&env_value(&base, "PATH").unwrap_or_default()).map_or_else(|| "git".to_owned(), |layout| layout.command)
}

/// `forgetMissingGit`: whether a spawn of `program` failed because that resolved binary is gone
/// (an uninstalled or moved Git). Its resolutions are dropped then, so the next resolution reads
/// PATH afresh.
pub fn forget_missing(program: &str) -> bool {
    if program == "git" || is_file(Path::new(program)) {
        return false;
    }
    resolved().lock().unwrap_or_else(|e| e.into_inner()).retain(|_, layout| layout.as_ref().is_none_or(|l| l.command != program));
    true
}
