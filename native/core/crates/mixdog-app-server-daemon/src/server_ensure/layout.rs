//! `~/.mixdog-remote` (LR §8.1). Data dir and runtime root stay where 1.4.5 put them, so an
//! updated server migrates its 1.4.5 data through the normal boot.

use std::path::Path;
use std::path::PathBuf;

use super::error::EnsureError;

pub const STATE_DIRECTORY: &str = ".mixdog-remote";
/// The one self-contained binary in a version directory.
pub const BINARY_NAME: &str = "mixdogd";
pub const COMPLETE_MARKER: &str = ".install-complete";

#[derive(Debug, Clone)]
pub struct RemotePaths {
    pub root: PathBuf,
    pub versions: PathBuf,
    pub deps: PathBuf,
    pub lock: PathBuf,
    pub state: PathBuf,
    pub log: PathBuf,
    pub runtime_root: PathBuf,
    pub user_data: PathBuf,
    pub mixdog_home: PathBuf,
    pub data_dir: PathBuf,
}

impl RemotePaths {
    pub fn new(home: &Path) -> Self {
        let root = home.join(STATE_DIRECTORY);
        let user_data = root.join("user-data");
        let mixdog_home = user_data.join("home");
        Self {
            versions: root.join("versions"),
            deps: root.join("deps"),
            lock: root.join(".install-lock"),
            state: root.join("state.json"),
            log: root.join("daemon.log"),
            runtime_root: root.join("runtime"),
            data_dir: mixdog_home.join("data"),
            mixdog_home,
            user_data,
            root,
        }
    }

    pub fn version_dir(&self, install_id: &str) -> Result<PathBuf, EnsureError> {
        let mut chars = install_id.chars();
        let safe = chars.next().is_some_and(|c| c.is_ascii_alphanumeric())
            && chars.all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '+' | '_' | '-'));
        if safe {
            Ok(self.versions.join(install_id))
        } else {
            Err(EnsureError::UnsafeInstallId(install_id.to_owned()))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn install_ids_cannot_leave_the_versions_directory() {
        let paths = RemotePaths::new(Path::new("/home/u"));
        assert!(paths.version_dir("1.4.6-abc123").is_ok());
        for bad in ["", "../x", "a/b", ".hidden", "a b", "a\\b"] {
            assert!(paths.version_dir(bad).is_err(), "{bad:?}");
        }
    }
}
