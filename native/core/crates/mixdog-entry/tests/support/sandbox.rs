//! A throwaway home, data and work folder for a run of the binary, and the environment it is started with: nothing of the machine's
//! own profile, and a `PATH` without any folder that holds Node or Electron.
#![allow(dead_code, reason = "each test uses the part it needs")]
#![allow(clippy::disallowed_methods, clippy::disallowed_types, reason = "the test lays out folders and reads the host's PATH")]

use std::ffi::OsString;
use std::path::Path;
use std::path::PathBuf;

/// The folders of one run.
pub struct Sandbox {
    dir: tempfile::TempDir,
}

/// The `PATH` entries of the host that hold neither Node nor Electron.
pub fn path_without_node() -> OsString {
    let holds = |dir: &Path| ["node", "node.exe", "nodejs", "electron", "electron.exe"].iter().any(|name| dir.join(name).exists());
    let kept: Vec<PathBuf> = std::env::split_paths(&std::env::var_os("PATH").unwrap_or_default()).filter(|dir| !dir.as_os_str().is_empty() && !holds(dir)).collect();
    std::env::join_paths(kept).unwrap()
}

impl Sandbox {
    pub fn new() -> Self {
        let dir = tempfile::tempdir().unwrap();
        for folder in ["home/AppData/Roaming", "home/AppData/Local", "host-data", "tmp", "work"] {
            std::fs::create_dir_all(dir.path().join(folder)).unwrap();
        }
        Self { dir }
    }

    pub fn root(&self) -> &Path {
        self.dir.path()
    }

    /// The working folder of the run.
    pub fn work(&self) -> PathBuf {
        self.dir.path().join("work")
    }

    /// The environment of a run (the command is given nothing else): the sandbox's home and data, a fake key, UTC, no proxy, the
    /// host's `SystemRoot` (Windows) and a `PATH` that names no Node or Electron.
    pub fn env(&self) -> Vec<(OsString, OsString)> {
        let root = self.dir.path();
        let at = |sub: &str| root.join(sub).into_os_string();
        let mut env: Vec<(OsString, OsString)> = vec![
            ("PATH".into(), path_without_node()),
            ("HOME".into(), at("home")),
            ("USERPROFILE".into(), at("home")),
            ("APPDATA".into(), at("home/AppData/Roaming")),
            ("LOCALAPPDATA".into(), at("home/AppData/Local")),
            ("MIXDOG_DATA_DIR".into(), at("host-data")),
            ("TEMP".into(), at("tmp")),
            ("TMP".into(), at("tmp")),
            ("TMPDIR".into(), at("tmp")),
            ("TZ".into(), "UTC".into()),
            ("ANTHROPIC_API_KEY".into(), "sk-fake".into()),
            ("NO_PROXY".into(), "127.0.0.1,localhost".into()),
            ("MIXDOG_SKIP_USER_DATA_BACKUP".into(), "1".into()),
            ("MIXDOG_DISABLE_TOOL_PREWARM".into(), "1".into()),
        ];
        for name in ["SystemRoot", "MIXDOGD_BIN"] {
            if let Some(value) = std::env::var_os(name) {
                env.push((name.into(), value));
            }
        }
        env
    }
}
