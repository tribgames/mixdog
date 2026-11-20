//! The font files of the machine: where `GlobalFonts` looks when the canvas starts, found lazily and once.
//!
//! Windows: the Windows `Fonts` folder, then the per-user `Fonts` folder. macOS: `/Library/Fonts`,
//! `~/Library/Fonts` and `/System/Library/Fonts`. Linux: the directories fontconfig names (`/etc/fonts/fonts.conf`
//! `<dir>` entries, with the `xdg` prefix and `~` resolved), or fontconfig's defaults when that file says none.
//! Folders are walked in the order of their upper-cased names, sub-folders included.

use std::collections::HashMap;
use std::path::Path;
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::OnceLock;

use mixdog_fsio::ReadProof;

use crate::provision;
use crate::provision::Provisioned;
use crate::registry::Registry;

/// The operating system families the font folders differ by.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Os {
    Windows,
    Mac,
    Linux,
}

impl Os {
    /// The system this build runs on (every other Unix is treated as Linux).
    pub fn current() -> Self {
        if cfg!(windows) {
            Self::Windows
        } else if cfg!(target_os = "macos") {
            Self::Mac
        } else {
            Self::Linux
        }
    }
}

/// What the font folders are worked out from: the system, the home folder and the environment variables read.
#[derive(Debug, Clone)]
pub struct HostEnv {
    pub os: Os,
    pub home: PathBuf,
    pub windir: Option<String>,
    pub local_app_data: Option<String>,
    pub xdg_data_home: Option<String>,
}

impl HostEnv {
    /// `env` is `process.env`, `home` is `os.homedir()`; an empty variable counts as unset.
    pub fn current(env: &dyn Fn(&str) -> Option<String>, home: &Path) -> Self {
        let non_empty = |name: &str| env(name).filter(|value| !value.is_empty());
        Self {
            os: Os::current(),
            home: home.to_path_buf(),
            windir: non_empty("WINDIR"),
            local_app_data: non_empty("LOCALAPPDATA"),
            xdg_data_home: non_empty("XDG_DATA_HOME"),
        }
    }

    /// The per-user font folder (`getUserFontDirectory`).
    pub fn user_font_dir(&self) -> PathBuf {
        match self.os {
            Os::Windows => {
                let local = self.local_app_data.as_ref().map_or_else(|| self.home.join("AppData").join("Local"), PathBuf::from);
                local.join("Microsoft").join("Windows").join("Fonts")
            }
            Os::Mac => self.home.join("Library").join("Fonts"),
            Os::Linux => self.home.join(".local").join("share").join("fonts"),
        }
    }

    /// The system-wide font folder (`systemFontDirectory`).
    pub fn system_font_dir(&self) -> PathBuf {
        match self.os {
            Os::Windows => PathBuf::from(self.windir.clone().unwrap_or_else(|| "C:\\Windows".to_owned())).join("Fonts"),
            Os::Mac => PathBuf::from("/Library/Fonts"),
            Os::Linux => PathBuf::from("/usr/share/fonts"),
        }
    }
}

/// The `<dir>` entries of a fontconfig file, resolved: `prefix="xdg"` is under the XDG data home, `~` is the home
/// folder, `prefix="cwd"` entries (relative to a working directory fontconfig itself chooses) are left out.
pub fn fontconfig_dirs(conf: &str, env: &HostEnv) -> Vec<PathBuf> {
    let xdg_home = env.xdg_data_home.as_ref().map_or_else(|| env.home.join(".local").join("share"), PathBuf::from);
    let mut dirs = Vec::new();
    let mut rest = conf;
    while let Some(open) = rest.find("<dir") {
        rest = &rest[open + 4..];
        let Some(tag_end) = rest.find('>') else { break };
        let (attributes, after) = (&rest[..tag_end], &rest[tag_end + 1..]);
        if !(attributes.is_empty() || attributes.starts_with(char::is_whitespace)) {
            continue;
        }
        let Some(close) = after.find("</dir>") else { break };
        let text = after[..close].trim();
        rest = &after[close + 6..];
        if text.is_empty() {
            continue;
        }
        let prefix = attributes.split("prefix=\"").nth(1).and_then(|tail| tail.split('"').next());
        let path = match prefix {
            Some("xdg") => xdg_home.join(text),
            Some("cwd") | Some("relative") => continue,
            _ => match text.strip_prefix('~') {
                Some(tail) => env.home.join(tail.trim_start_matches(['/', '\\'])),
                None => PathBuf::from(text),
            },
        };
        if !dirs.contains(&path) {
            dirs.push(path);
        }
    }
    dirs
}

/// Fontconfig's default folders, used when no configuration file names any.
fn default_linux_dirs(env: &HostEnv) -> Vec<PathBuf> {
    vec![
        PathBuf::from("/usr/share/fonts"),
        PathBuf::from("/usr/local/share/fonts"),
        env.xdg_data_home.as_ref().map_or_else(|| env.home.join(".local").join("share"), PathBuf::from).join("fonts"),
        env.home.join(".fonts"),
    ]
}

/// The folders to scan, in order.
pub fn system_font_dirs<P: ReadProof>(proof: &P, env: &HostEnv) -> Vec<PathBuf> {
    match env.os {
        Os::Windows => vec![env.system_font_dir(), env.user_font_dir()],
        Os::Mac => vec![env.system_font_dir(), env.user_font_dir(), PathBuf::from("/System/Library/Fonts")],
        Os::Linux => {
            let configured = mixdog_fsio::read_to_string(proof, "/etc/fonts/fonts.conf").map(|conf| fontconfig_dirs(&conf, env)).unwrap_or_default();
            if configured.is_empty() { default_linux_dirs(env) } else { configured }
        }
    }
}

/// The registry the canvas starts with and what became of the provisioned faces.
#[derive(Debug)]
pub struct Scan {
    pub registry: Registry,
    pub provisioned: Vec<(&'static str, Provisioned)>,
}

/// Every font file of the system folders, in scan order, then the Office-for-Mac faces and the provisioned faces
/// registered the way `warmupInstalledOfficeFonts` does.
pub fn scan<P: ReadProof>(proof: &P, env: &HostEnv) -> Scan {
    let mut registry = Registry::new();
    for dir in system_font_dirs(proof, env) {
        registry.register_dir(proof, &dir);
    }
    let provisioned = provision::register_installed(proof, env, &mut registry);
    Scan { registry, provisioned }
}

/// The process's scan, made the first time it is asked for and shared from then on.
#[derive(Debug, Default)]
pub struct Catalog {
    scanned: OnceLock<Arc<Scan>>,
}

impl Catalog {
    pub const fn new() -> Self {
        Self { scanned: OnceLock::new() }
    }

    /// The shared scan; the first caller's lane job does the work.
    pub fn scan<P: ReadProof>(&self, proof: &P, env: &HostEnv) -> Arc<Scan> {
        Arc::clone(self.scanned.get_or_init(|| Arc::new(scan(proof, env))))
    }
}

/// Hosts' environment as a map, for callers that hold `process.env` that way.
pub fn host_env_from(vars: &HashMap<String, String>, home: &Path) -> HostEnv {
    HostEnv::current(&|name| vars.get(name).cloned(), home)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn env(os: Os) -> HostEnv {
        HostEnv { os, home: PathBuf::from("/home/ann"), windir: None, local_app_data: None, xdg_data_home: None }
    }

    #[test]
    fn the_user_and_system_font_folders_follow_each_system() {
        let windows = HostEnv { windir: Some("D:\\Win".to_owned()), local_app_data: Some("D:\\Local".to_owned()), ..env(Os::Windows) };
        assert_eq!(windows.system_font_dir(), PathBuf::from("D:\\Win").join("Fonts"));
        assert_eq!(windows.user_font_dir(), PathBuf::from("D:\\Local").join("Microsoft").join("Windows").join("Fonts"));
        let bare = env(Os::Windows);
        assert_eq!(bare.system_font_dir(), PathBuf::from("C:\\Windows").join("Fonts"));
        assert_eq!(bare.user_font_dir(), PathBuf::from("/home/ann").join("AppData").join("Local").join("Microsoft").join("Windows").join("Fonts"));
        assert_eq!(env(Os::Mac).user_font_dir(), PathBuf::from("/home/ann/Library/Fonts"));
        assert_eq!(env(Os::Linux).user_font_dir(), PathBuf::from("/home/ann/.local/share/fonts"));
        assert_eq!(env(Os::Linux).system_font_dir(), PathBuf::from("/usr/share/fonts"));
    }

    #[test]
    fn fontconfig_directories_are_resolved() {
        let conf = r#"<?xml version="1.0"?>
<fontconfig>
  <dir>/usr/share/fonts</dir>
  <dir>/usr/local/share/fonts</dir>
  <dir prefix="xdg">fonts</dir>
  <dir>~/.fonts</dir>
  <dir prefix="cwd">here</dir>
  <dir>/usr/share/fonts</dir>
  <dirname>ignored</dirname>
</fontconfig>"#;
        assert_eq!(
            fontconfig_dirs(conf, &env(Os::Linux)),
            [
                PathBuf::from("/usr/share/fonts"),
                PathBuf::from("/usr/local/share/fonts"),
                PathBuf::from("/home/ann/.local/share/fonts"),
                PathBuf::from("/home/ann/.fonts"),
            ]
        );
        let moved = HostEnv { xdg_data_home: Some("/data".to_owned()), ..env(Os::Linux) };
        assert_eq!(fontconfig_dirs(r#"<dir prefix="xdg">fonts</dir>"#, &moved), [PathBuf::from("/data/fonts")]);
        assert!(fontconfig_dirs("<fontconfig/>", &env(Os::Linux)).is_empty());
    }

    #[test]
    fn the_default_linux_folders_are_fontconfigs() {
        let dirs = default_linux_dirs(&env(Os::Linux));
        assert_eq!(dirs[0], PathBuf::from("/usr/share/fonts"));
        assert!(dirs.contains(&PathBuf::from("/home/ann/.fonts")));
    }

    #[test]
    fn environment_values_that_are_empty_count_as_unset() {
        let vars: HashMap<String, String> = [("WINDIR", ""), ("LOCALAPPDATA", "D:\\L")].map(|(k, v)| (k.to_owned(), v.to_owned())).into();
        let parsed = host_env_from(&vars, Path::new("/home/ann"));
        assert_eq!(parsed.windir, None);
        assert_eq!(parsed.local_app_data.as_deref(), Some("D:\\L"));
    }
}
