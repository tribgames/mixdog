//! Finding a program on `PATH` and the form a program is spawned in. This is the one
//! resolution every caller of [`super::process::ProcessManager`] uses: a bare name resolves
//! through `PATH`/`PATHEXT`, and on Windows a `.cmd`/`.bat` shim (yarn, npm) cannot be spawned
//! itself, so it runs under the command interpreter.

use std::collections::HashMap;
use std::collections::HashSet;
use std::path::Path;
use std::path::PathBuf;
use std::sync::Mutex;

fn is_windows_script(program: &str) -> bool {
    cfg!(windows) && Path::new(program).extension().is_some_and(|e| e.eq_ignore_ascii_case("cmd") || e.eq_ignore_ascii_case("bat"))
}

/// The program and arguments to hand to the process manager: a Windows script becomes
/// `ComSpec /d /s /c <script> <args>`, anything else is unchanged.
pub fn spawn_form(program: &str, args: &[String]) -> (String, Vec<String>) {
    if is_windows_script(program) {
        let shell = std::env::var("ComSpec").unwrap_or_else(|_| "cmd.exe".into());
        let argv = ["/d", "/s", "/c", program].iter().map(|s| (*s).to_owned()).chain(args.iter().cloned()).collect();
        (shell, argv)
    } else {
        (program.to_owned(), args.to_vec())
    }
}

fn path_dirs(env: Option<&HashMap<String, String>>) -> Vec<PathBuf> {
    let value = env
        .and_then(|e| e.get("PATH").or_else(|| e.get("Path")).cloned())
        .or_else(|| std::env::var("PATH").ok())
        .unwrap_or_default();
    std::env::split_paths(&value).filter(|p| !p.as_os_str().is_empty()).collect()
}

fn executable_candidates(name: &str) -> Vec<String> {
    if !cfg!(windows) || Path::new(name).extension().is_some() {
        return vec![name.to_owned()];
    }
    let pathext = std::env::var("PATHEXT").unwrap_or_else(|_| ".COM;.EXE;.BAT;.CMD".into());
    std::iter::once(name.to_owned()).chain(pathext.split(';').map(mixdog_js::js_trim).filter(|e| !e.is_empty()).map(|e| format!("{name}{}", e.to_lowercase()))).collect()
}

fn name_key(value: &str) -> String {
    if cfg!(windows) { value.to_lowercase() } else { value.to_owned() }
}

/// One PATH's directory listings, read once per directory on first use, for a batch of
/// [`which`] lookups: a name on no directory costs no filesystem call at all.
pub struct PathIndex {
    pub dirs: Vec<PathBuf>,
    listings: Mutex<HashMap<PathBuf, Option<HashSet<String>>>>,
}

impl PathIndex {
    pub fn new(env: Option<&HashMap<String, String>>) -> Self {
        Self { dirs: path_dirs(env), listings: Mutex::default() }
    }

    #[allow(clippy::disallowed_methods, reason = "runs as a lane job: every caller reaches `which` from a lane body")]
    fn has(&self, dir: &Path, candidate: &str) -> bool {
        let mut listings = self.listings.lock().unwrap();
        let names = listings.entry(dir.to_owned()).or_insert_with(|| {
            // Unlistable (no list permission, gone): probe it per candidate instead.
            std::fs::read_dir(dir).ok().map(|rd| rd.filter_map(|e| e.ok()).map(|e| name_key(&e.file_name().to_string_lossy())).collect())
        });
        names.as_ref().is_none_or(|n| n.contains(&name_key(candidate)))
    }
}

/// First match for `name` on PATH (`env`'s, else the process's), or `None`. A pure
/// filesystem lookup, no spawn. Blocking: call it from a lane job.
#[allow(clippy::disallowed_methods, reason = "runs as a lane job: every caller reaches `which` from a lane body")]
pub fn which(name: &str, env: Option<&HashMap<String, String>>, index: Option<&PathIndex>) -> Option<PathBuf> {
    let bin = mixdog_js::js_trim(name);
    if bin.is_empty() {
        return None;
    }
    if Path::new(bin).is_absolute() || bin.contains('/') || bin.contains('\\') {
        return Path::new(bin).exists().then(|| PathBuf::from(bin));
    }
    let owned;
    let dirs = match index {
        Some(i) => &i.dirs,
        None => {
            owned = path_dirs(env);
            &owned
        }
    };
    for dir in dirs {
        for candidate in executable_candidates(bin) {
            if index.is_some_and(|i| !i.has(dir, &candidate)) {
                continue;
            }
            let full = dir.join(&candidate);
            if std::fs::metadata(&full).is_ok_and(|m| m.is_file()) {
                return Some(full);
            }
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn which_finds_files_on_a_supplied_path_through_the_index() {
        let dir = std::env::temp_dir().join(format!("mixdog-which-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let name = if cfg!(windows) { "tool.exe" } else { "tool" };
        std::fs::write(dir.join(name), b"x").unwrap();
        let env = HashMap::from([("PATH".to_owned(), dir.to_string_lossy().into_owned())]);
        let index = PathIndex::new(Some(&env));
        assert_eq!(which("tool", Some(&env), Some(&index)), Some(dir.join(name)));
        assert!(which("nothing-here", Some(&env), Some(&index)).is_none());
        assert!(which("", Some(&env), None).is_none());
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn a_script_runs_under_the_interpreter_on_windows_only() {
        let args = vec!["--version".to_owned()];
        let (program, argv) = spawn_form("C:/x/yarn.cmd", &args);
        if cfg!(windows) {
            assert_eq!(&argv[..4], ["/d", "/s", "/c", "C:/x/yarn.cmd"]);
            assert_eq!(argv[4], "--version");
            assert!(!program.is_empty());
        } else {
            assert_eq!((program.as_str(), &argv), ("C:/x/yarn.cmd", &args));
        }
        assert_eq!(spawn_form("git", &args), ("git".to_owned(), args.clone()));
    }
}
