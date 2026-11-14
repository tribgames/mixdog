//! Mixdog's own ssh settings file and known_hosts, kept in the core's data folder.
//!
//! Every ssh Mixdog starts reads `-F <this config>`: it names Mixdog's known_hosts first (new pins land there, so the
//! user's own files are never written) and the user's known_hosts files after it, then includes the user's
//! `~/.ssh/config` for everything else. `-F` also reaches a ProxyJump hop's ssh, which `-o` would not.

use std::io;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, PoisonError};

use mixdog_fsio::{DirBuilder, OpenOptions, Unlaned};

use crate::context::{ConfigFiles, SshConfigFiles, SshEnv};
use crate::diagnostics::DiagnosticKind;
use crate::private_dir::{lock_to_user, resolve_plain_dir};

const DEFAULT_USER_FILES: [&str; 2] = ["~/.ssh/known_hosts", "~/.ssh/known_hosts2"];
const MAX_EXTRA_FILES: usize = 16;
/// Written beside Mixdog's known_hosts once the desktop's own file was merged in.
const LEGACY_MARKER: &str = ".legacy-imported";

static CURRENT: Mutex<Option<Arc<MixdogSshConfig>>> = Mutex::new(None);

/// A path as ssh config words write it: quoted, forward slashes.
pub fn word(path: &str) -> String {
    format!("\"{}\"", path.replace('\\', "/").replace('"', ""))
}

/// The config text. Mixdog's file comes first so that `StrictHostKeyChecking=yes` finds a pin there; ssh reads all
/// the listed files.
pub fn mixdog_ssh_config_text(known_hosts_file: &str, extra_user_files: &[String], home: &Path) -> String {
    let mut files = vec![word(known_hosts_file)];
    files.extend(DEFAULT_USER_FILES.iter().map(|file| (*file).to_owned()));
    files.extend(extra_user_files.iter().map(|file| word(file)));
    let user_config = home.join(".ssh").join("config");
    format!(
        "# Written by Mixdog; rewritten on every start.\nHost *\n  UserKnownHostsFile {}\n\nInclude {}\n",
        files.join(" "),
        word(&user_config.to_string_lossy())
    )
}

/// The folder every file of this module lives in: `ssh` under the core's data folder.
fn data_dir(env: &SshEnv) -> PathBuf {
    let set = |name: &str| env.var(name).filter(|value| !value.is_empty()).map(PathBuf::from);
    set("MIXDOG_DATA_DIR").unwrap_or_else(|| set("MIXDOG_HOME").unwrap_or_else(|| env.home.join(".mixdog")).join("data"))
}

/// The signed-in account, as the folders of this crate are locked to it.
pub(crate) fn account(env: &SshEnv) -> String {
    ["USERNAME", "USER", "LOGNAME"].iter().find_map(|name| env.var(name).filter(|value| !value.is_empty())).unwrap_or("user").to_owned()
}

/// Creates a folder (and its parents) this user alone can enter on Unix.
pub(crate) fn create_dir(dir: &Path) -> io::Result<()> {
    let mut builder = DirBuilder::new();
    builder.recursive(true);
    #[cfg(unix)]
    builder.mode(0o700);
    builder.create(&Unlaned, dir)
}

/// Appends `text` (which ends in a newline) to a file, creating it and its folder; a last line without a newline
/// gets one first, so the new text starts a line of its own.
pub(crate) fn append_text(files: &dyn ConfigFiles, file: &Path, text: &str) -> io::Result<()> {
    if let Some(parent) = file.parent().filter(|parent| !parent.as_os_str().is_empty()) {
        create_dir(parent)?;
    }
    let lead = if files.read_text(file).is_some_and(|existing| !existing.is_empty() && !existing.ends_with('\n')) { "\n" } else { "" };
    let mut options = OpenOptions::new();
    options.append(true).create(true);
    #[cfg(unix)]
    options.mode(0o600);
    let mut handle = options.open(&Unlaned, file)?;
    io::Write::write_all(&mut handle, format!("{lead}{text}").as_bytes())
}

/// Mixdog's own ssh files: where they are and which user known_hosts files the generated config also names.
pub struct MixdogSshConfig {
    known_hosts_file: PathBuf,
    config_file: PathBuf,
    home: PathBuf,
    extra: Mutex<Vec<String>>,
}

impl MixdogSshConfig {
    /// Prepares the folder (a plain path, this user only), Mixdog's known_hosts and the config, merges the desktop's
    /// old known_hosts in when `MIXDOG_DESKTOP_USER_DATA` names its folder, and makes this the configuration
    /// [`current`] returns. `env` is the machine as it is before this config exists (its `config_files` are not asked).
    pub async fn configure(env: &SshEnv) -> io::Result<Arc<Self>> {
        let dir = resolve_plain_dir(env, &data_dir(env), "ssh").await;
        create_dir(&dir)?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            mixdog_fsio::set_permissions(&Unlaned, &dir, std::fs::Permissions::from_mode(0o700))?;
        }
        if env.platform.is_windows() {
            lock_to_user(env, &dir, &account(env)).await?;
        }
        let known_hosts_file = dir.join("known_hosts");
        let mut touch = OpenOptions::new();
        touch.append(true).create(true);
        #[cfg(unix)]
        touch.mode(0o600);
        touch.open(&Unlaned, &known_hosts_file)?;
        let config = Arc::new(Self { known_hosts_file, config_file: dir.join("config"), home: env.home.clone(), extra: Mutex::new(Vec::new()) });
        config.write_config(&[])?;
        if let Some(legacy) = env.var("MIXDOG_DESKTOP_USER_DATA").filter(|value| !value.is_empty()) {
            // A failed merge leaves no marker, so the next start tries again; ssh itself is not held up by it.
            if let Err(error) = config.import_legacy_known_hosts(env, Path::new(legacy)).await {
                env.diagnostics.record(None, DiagnosticKind::Log, &format!("known_hosts of the desktop could not be merged: {error}"), 0);
            }
        }
        *CURRENT.lock().unwrap_or_else(PoisonError::into_inner) = Some(Arc::clone(&config));
        Ok(config)
    }

    /// The configuration [`Self::configure`] made last, or None before it ran.
    pub fn current() -> Option<Arc<Self>> {
        CURRENT.lock().unwrap_or_else(PoisonError::into_inner).clone()
    }

    /// Mixdog's own known_hosts (new pins go there).
    pub fn known_hosts_file(&self) -> &Path {
        &self.known_hosts_file
    }

    /// The generated ssh config every Mixdog ssh reads (`-F`).
    pub fn config_file(&self) -> &Path {
        &self.config_file
    }

    /// The folder that holds Mixdog's generated ssh files.
    pub fn dir(&self) -> &Path {
        self.config_file.parent().unwrap_or_else(|| Path::new("."))
    }

    fn write_config(&self, extra: &[String]) -> io::Result<()> {
        let text = mixdog_ssh_config_text(&self.known_hosts_file.to_string_lossy(), extra, &self.home);
        mixdog_fsio::write(&Unlaned, &self.config_file, text)
    }

    /// The known_hosts files the user's own config names for a server: ssh keeps reading them. The config is
    /// rewritten only when the list changed.
    pub fn register_user_known_hosts(&self, files: &[String]) -> io::Result<()> {
        let home = self.home.to_string_lossy().replace('\\', "/");
        let own = self.known_hosts_file.to_string_lossy().replace('\\', "/");
        let mut extra = self.extra.lock().unwrap_or_else(PoisonError::into_inner);
        let before = extra.len();
        for file in files {
            let normalized = file.replace('\\', "/");
            if extra.len() >= MAX_EXTRA_FILES {
                break;
            }
            if normalized.is_empty() || normalized == "none" || DEFAULT_USER_FILES.contains(&normalized.as_str()) {
                continue;
            }
            if DEFAULT_USER_FILES.iter().any(|default| normalized == default.replacen('~', &home, 1)) || normalized == own {
                continue;
            }
            if !extra.contains(file) {
                extra.push(file.clone());
            }
        }
        if extra.len() == before { Ok(()) } else { self.write_config(&extra) }
    }

    /// Appends the lines of the desktop's old known_hosts that Mixdog's own file does not hold yet. Nothing is ever
    /// removed or replaced, and the old file is left as it is. It runs once: a marker beside the file says so, and
    /// is written also when the old folder has no known_hosts. Returns the number of lines added.
    pub async fn import_legacy_known_hosts(&self, env: &SshEnv, legacy_user_data: &Path) -> io::Result<usize> {
        let marker = self.dir().join(LEGACY_MARKER);
        if mixdog_fsio::exists(&Unlaned, &marker)? {
            return Ok(0);
        }
        let legacy = resolve_plain_dir(env, legacy_user_data, "ssh").await.join("known_hosts");
        let old = match mixdog_fsio::read(&Unlaned, &legacy) {
            Ok(bytes) => String::from_utf8_lossy(&bytes).into_owned(),
            Err(error) if error.kind() == io::ErrorKind::NotFound => String::new(),
            Err(error) => return Err(error),
        };
        let mut held: std::collections::BTreeSet<String> =
            env.files.read_text(&self.known_hosts_file).unwrap_or_default().lines().map(|line| line.trim().to_owned()).collect();
        let mut added = String::new();
        let mut count = 0;
        for line in old.lines().map(str::trim).filter(|line| !line.is_empty() && !line.starts_with('#')) {
            if held.insert(line.to_owned()) {
                added.push_str(line);
                added.push('\n');
                count += 1;
            }
        }
        if count > 0 {
            append_text(env.files.as_ref(), &self.known_hosts_file, &added)?;
        }
        mixdog_fsio::write(&Unlaned, &marker, "")?;
        Ok(count)
    }
}

impl SshConfigFiles for MixdogSshConfig {
    /// Mixdog's generic config is the only one this type knows; a target's own generated config is the business of
    /// `resolved_config`.
    fn for_args(&self, _args: &[String]) -> Option<PathBuf> {
        None
    }

    fn generic(&self) -> Option<PathBuf> {
        Some(self.config_file.clone())
    }
}
