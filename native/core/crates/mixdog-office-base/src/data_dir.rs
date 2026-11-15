//! The Office data directory (`defaultOfficeDataDir` of `core/journal.mjs`) and the lexical path resolution Node's
//! `path.resolve` gives it.

use std::io;
use std::path::{Component, Path, PathBuf};

/// The folder under the data directory that holds the transaction journal.
pub const JOURNAL_FOLDER: &str = "office-transactions";

/// `path.resolve(cwd, path)`: `path` taken against `cwd` when it is relative, `.` dropped and `..` collapsed without
/// touching the disk (a `..` at the root stays at the root).
pub fn resolve_path(cwd: &Path, path: &Path) -> PathBuf {
    let joined = cwd.join(path);
    let mut out = PathBuf::new();
    for component in joined.components() {
        match component {
            Component::CurDir => {}
            Component::ParentDir => {
                if matches!(out.components().next_back(), Some(Component::Normal(_))) {
                    out.pop();
                }
            }
            other => out.push(other.as_os_str()),
        }
    }
    out
}

/// `path.resolve(path)`: against the process's working directory.
pub fn resolve_from_process_cwd(path: &Path) -> io::Result<PathBuf> {
    Ok(resolve_path(&std::env::current_dir()?, path))
}

/// `defaultOfficeDataDir` over an explicit environment: `MIXDOG_DATA_DIR`, else `<MIXDOG_HOME, else ~/.mixdog>/data`,
/// resolved against `cwd`. A variable that is set but empty counts as unset (`||`), and the home directory is asked
/// only when `MIXDOG_HOME` is not set.
pub fn office_data_dir_from(
    env: &dyn Fn(&str) -> Option<String>,
    home: &dyn Fn() -> Option<PathBuf>,
    cwd: &Path,
) -> io::Result<PathBuf> {
    let set = |name: &str| env(name).filter(|value| !value.is_empty());
    let dir = match set("MIXDOG_DATA_DIR") {
        Some(dir) => PathBuf::from(dir),
        None => {
            let mixdog_home = match set("MIXDOG_HOME") {
                Some(dir) => PathBuf::from(dir),
                None => home().ok_or_else(|| io::Error::other("no home directory"))?.join(".mixdog"),
            };
            mixdog_home.join("data")
        }
    };
    Ok(resolve_path(cwd, &dir))
}

/// `defaultOfficeDataDir()` over the process environment.
pub fn default_office_data_dir() -> io::Result<PathBuf> {
    office_data_dir_from(
        &|name| std::env::var_os(name).map(|value| value.to_string_lossy().into_owned()),
        &std::env::home_dir,
        &std::env::current_dir()?,
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn root() -> PathBuf {
        std::env::temp_dir().join("office-root")
    }

    fn from(vars: &[(&str, &str)], home: Option<PathBuf>) -> io::Result<PathBuf> {
        let vars: Vec<(String, String)> = vars.iter().map(|(k, v)| ((*k).to_owned(), (*v).to_owned())).collect();
        office_data_dir_from(
            &|name| vars.iter().find(|(key, _)| key == name).map(|(_, value)| value.clone()),
            &|| home.clone(),
            &root().join("cwd"),
        )
    }

    #[test]
    fn the_data_directory_comes_from_the_data_variable_then_home_then_the_user_home() {
        let base = root();
        let data = base.join("d").display().to_string();
        let mixdog_home = base.join("h").display().to_string();
        assert_eq!(from(&[("MIXDOG_DATA_DIR", &data), ("MIXDOG_HOME", &mixdog_home)], None).unwrap(), base.join("d"));
        assert_eq!(from(&[("MIXDOG_HOME", &mixdog_home)], None).unwrap(), base.join("h").join("data"));
        assert_eq!(from(&[], Some(base.join("home"))).unwrap(), base.join("home").join(".mixdog").join("data"));
        // A set but empty variable counts as unset.
        assert_eq!(from(&[("MIXDOG_DATA_DIR", ""), ("MIXDOG_HOME", "")], Some(base.join("home"))).unwrap(), base.join("home").join(".mixdog").join("data"));
        assert!(from(&[], None).is_err());
    }

    #[test]
    fn a_relative_or_dotted_value_is_resolved_against_the_working_directory() {
        let base = root();
        assert_eq!(from(&[("MIXDOG_DATA_DIR", "rel/dir")], None).unwrap(), base.join("cwd").join("rel").join("dir"));
        let dotted = format!("{}/a/../b/./c", base.display());
        assert_eq!(from(&[("MIXDOG_DATA_DIR", &dotted)], None).unwrap(), base.join("b").join("c"));
    }

    #[test]
    fn a_parent_step_at_the_root_stays_at_the_root() {
        let root = std::env::temp_dir().ancestors().last().expect("root").to_path_buf();
        assert_eq!(resolve_path(&root, Path::new("../..")), root);
    }
}
