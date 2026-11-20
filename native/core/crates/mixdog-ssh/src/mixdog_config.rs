//! Mixdog's own ssh settings file and known_hosts, kept in the core's data folder.
//!
//! Every ssh Mixdog starts reads `-F <this config>`: it names Mixdog's known_hosts first (new pins land there, so the
//! user's own files are never written) and the user's known_hosts files after it, then includes the user's
//! `~/.ssh/config` for everything else. `-F` also reaches a ProxyJump hop's ssh, which `-o` would not.

use std::io;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, PoisonError};

use mixdog_fsio::{DirBuilder, OpenOptions, Unlaned};

use crate::context::{SshConfigFiles, SshEnv};
use crate::diagnostics::DiagnosticKind;
use crate::private_dir::{lock_to_user, resolve_plain_dir, resolve_plain_dir_with};

const DEFAULT_USER_FILES: [&str; 2] = ["~/.ssh/known_hosts", "~/.ssh/known_hosts2"];
const MAX_EXTRA_FILES: usize = 16;
/// Written beside Mixdog's known_hosts once the desktop's own file was merged in.
const LEGACY_MARKER: &str = ".legacy-imported";
/// Written inside the folder once `icacls` locked it to the account it names: a later start finds the folder locked and runs nothing.
const LOCKED_MARKER: &str = ".locked-to-user";

static CURRENT: Mutex<Option<Arc<MixdogSshConfig>>> = Mutex::new(None);

/// A path as ssh config words write it: quoted, forward slashes.
pub fn word(path: &str) -> String {
    format!("\"{}\"", path.replace('\\', "/").replace('"', ""))
}

/// The config text. Mixdog's file comes first so that `StrictHostKeyChecking=yes` finds a pin there; ssh reads all
/// the listed files.
pub fn mixdog_ssh_config_text(known_hosts_file: &str, extra_user_files: &[String], home: &Path) -> String {
    let user_config = home.join(".ssh").join("config");
    format!("# Written by Mixdog; rewritten on every start.\n{}\nInclude {}\n", generic_block(known_hosts_file, extra_user_files), word(&user_config.to_string_lossy()))
}

/// The `Host *` block of the generic config: Mixdog's known_hosts, the default user files and `extra_user_files`.
pub(crate) fn generic_block(known_hosts_file: &str, extra_user_files: &[String]) -> String {
    let mut files = vec![word(known_hosts_file)];
    files.extend(DEFAULT_USER_FILES.iter().map(|file| (*file).to_owned()));
    files.extend(extra_user_files.iter().map(|file| word(file)));
    format!("Host *\n  UpdateHostKeys no\n  StrictHostKeyChecking yes\n  UserKnownHostsFile {}\n", files.join(" "))
}

/// `extra` with the user files of `files` it lacks: not a default file (also spelled out with the home folder), not Mixdog's own,
/// at most [`MAX_EXTRA_FILES`].
fn grown(extra: &[String], files: &[String], own: &Path, home: &Path) -> Vec<String> {
    let home = home.to_string_lossy().replace('\\', "/");
    let own = own.to_string_lossy().replace('\\', "/");
    let mut next = extra.to_vec();
    for file in files {
        let normalized = file.replace('\\', "/");
        if next.len() >= MAX_EXTRA_FILES {
            break;
        }
        if normalized.is_empty() || normalized == "none" || DEFAULT_USER_FILES.contains(&normalized.as_str()) {
            continue;
        }
        if DEFAULT_USER_FILES.iter().any(|default| normalized == default.replacen('~', &home, 1)) || normalized == own {
            continue;
        }
        if !next.contains(file) {
            next.push(file.clone());
        }
    }
    next
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

const STATE_LOCK: &str = "state.lock";

/// Runs `work` as the one writer of Mixdog's ssh state (known_hosts, the generic config, the import marker), in
/// this process or any other: it holds an OS lock on `state.lock` beside them, so the work may reread, change and publish files
/// without a concurrent writer's change being lost. The lock file itself is never truncated, renamed or removed (a lock on a
/// replaceable file would lock nothing); closing the handle releases the lock, also when the process dies.
///
/// Blocking: async code goes through [`locked`]. `work` starts no child process, awaits nothing and does not take the lock again.
pub(crate) fn with_state_lock<T>(dir: &Path, work: impl FnOnce() -> io::Result<T>) -> io::Result<T> {
    create_dir(dir)?;
    let mut options = OpenOptions::new();
    options.read(true).write(true).create(true);
    #[cfg(unix)]
    options.mode(0o600);
    let handle = options.open(&Unlaned, dir.join(STATE_LOCK))?;
    handle.lock(&Unlaned)?;
    let result = work();
    let _ = handle.unlock(&Unlaned);
    result
}

/// [`with_state_lock`] for async code: the whole blocking transaction runs on a thread of its own and is awaited, never a guard.
pub(crate) async fn locked<T: Send + 'static>(dir: PathBuf, work: impl FnOnce() -> io::Result<T> + Send + 'static) -> io::Result<T> {
    let (done, result) = tokio::sync::oneshot::channel();
    // A thread of its own, as `Unlaned` says of a caller outside the lane contract: this crate holds no lane token.
    std::thread::spawn(move || {
        let _ = done.send(with_state_lock(&dir, work));
    });
    result.await.map_err(io::Error::other)?
}

/// A state file as bytes; a file that is not there is empty, any other failure to read it is an error (never an empty state).
pub(crate) fn read_state(path: &Path) -> io::Result<Vec<u8>> {
    match mixdog_fsio::read(&Unlaned, path) {
        Err(failure) if failure.kind() == io::ErrorKind::NotFound => Ok(Vec::new()),
        other => other,
    }
}

/// Replaces a file's whole content in one step: a unique private file beside it is written, synced and renamed over it, so a
/// lock-free reader sees the old file or the new one, never a part. The destination is not removed first: where the replace is
/// refused the failure is reported and the old file stays.
pub(crate) fn publish_file(path: &Path, bytes: &[u8]) -> io::Result<()> {
    let parent = path.parent().filter(|parent| !parent.as_os_str().is_empty()).unwrap_or_else(|| Path::new("."));
    create_dir(parent)?;
    let name = path.file_name().map(|name| name.to_string_lossy().into_owned()).unwrap_or_default();
    let temporary = parent.join(format!(".{name}.{}.{:016x}.tmp", std::process::id(), rand::random::<u64>()));
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    options.mode(0o600);
    let mut handle = options.open(&Unlaned, &temporary)?;
    let written = io::Write::write_all(&mut handle, bytes).and_then(|()| handle.sync_all(&Unlaned));
    drop(handle);
    if let Err(failure) = written.and_then(|()| mixdog_fsio::rename(&Unlaned, &temporary, path)) {
        let _ = mixdog_fsio::remove_file(&Unlaned, &temporary);
        return Err(failure);
    }
    #[cfg(unix)]
    if let Ok(folder) = mixdog_fsio::File::open(&Unlaned, parent) {
        let _ = folder.sync_all(&Unlaned);
    }
    Ok(())
}

/// Mixdog's own ssh files: where they are and which user known_hosts files the generated config also names.
pub struct MixdogSshConfig {
    known_hosts_file: PathBuf,
    config_file: PathBuf,
    home: PathBuf,
    /// The user files the published config names besides the defaults; changed only once that config is published.
    extra: Arc<Mutex<Vec<String>>>,
}

impl MixdogSshConfig {
    /// Prepares the folder (a plain path, this user only; on Windows `icacls` runs once, then a marker in the folder says it is
    /// locked), Mixdog's known_hosts and the config, merges the desktop's
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
            let user = account(env);
            let marker = dir.join(LOCKED_MARKER);
            if env.files.read_text(&marker).is_none_or(|locked| locked.trim() != user) {
                lock_to_user(env, &dir, &user).await?;
                // Without the marker the next start locks again: nothing else is lost.
                let _ = mixdog_fsio::write(&Unlaned, &marker, &user);
            }
        }
        let known_hosts_file = dir.join("known_hosts");
        let config = Arc::new(Self {
            known_hosts_file: known_hosts_file.clone(),
            config_file: dir.join("config"),
            home: env.home.clone(),
            extra: Arc::new(Mutex::new(Vec::new())),
        });
        let (config_file, text, folder) = (config.config_file.clone(), config.config_text(&[]), dir.clone());
        locked(dir.clone(), move || {
            let mut touch = OpenOptions::new();
            touch.append(true).create(true);
            #[cfg(unix)]
            touch.mode(0o600);
            touch.open(&Unlaned, &known_hosts_file)?;
            publish_file(&config_file, text.as_bytes())?;
            crate::resolved_config::purge_unselected_target_configs(&folder)
        })
        .await?;
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

    fn config_text(&self, extra: &[String]) -> String {
        mixdog_ssh_config_text(&self.known_hosts_file.to_string_lossy(), extra, &self.home)
    }

    /// The known_hosts files the user's own config names for a server: ssh keeps reading them. The config is rewritten only when
    /// the list grew. Deciding, publishing and remembering the list are one step under the state lock, run to the end on a
    /// blocking thread: two registrations publish in the order they grew the list, and one that failed (or whose caller went away)
    /// leaves the list as the published file has it.
    pub async fn register_user_known_hosts(&self, files: &[String]) -> io::Result<()> {
        let (extra, files) = (Arc::clone(&self.extra), files.to_vec());
        let (config_file, known_hosts_file, home) = (self.config_file.clone(), self.known_hosts_file.clone(), self.home.clone());
        locked(self.dir().to_path_buf(), move || {
            let mut extra = extra.lock().unwrap_or_else(PoisonError::into_inner);
            let next = grown(&extra, &files, &known_hosts_file, &home);
            if next.len() != extra.len() {
                publish_file(&config_file, mixdog_ssh_config_text(&known_hosts_file.to_string_lossy(), &next, &home).as_bytes())?;
                *extra = next;
            }
            Ok(())
        })
        .await
    }

    /// Appends the lines of the desktop's old known_hosts that Mixdog's own file does not hold yet. Nothing is ever
    /// removed or replaced, and the old file is left as it is. It runs once: a marker beside the file says so, and
    /// is written also when the old folder has no known_hosts. Returns the number of lines added.
    pub async fn import_legacy_known_hosts(&self, env: &SshEnv, legacy_user_data: &Path) -> io::Result<usize> {
        let marker = self.dir().join(LEGACY_MARKER);
        // The source's path is resolved, and the source read, outside the lock; the merge below rereads the destination under it.
        // Only read: the old desktop's folder is not created here when it is not there (it would be an empty folder left behind).
        let legacy = resolve_plain_dir_with(env, legacy_user_data, "ssh", |_| {}).await.join("known_hosts");
        let old = match mixdog_fsio::read(&Unlaned, &legacy) {
            Ok(bytes) => String::from_utf8_lossy(&bytes).into_owned(),
            Err(error) if error.kind() == io::ErrorKind::NotFound => String::new(),
            Err(error) => return Err(error),
        };
        let known_hosts = self.known_hosts_file.clone();
        locked(self.dir().to_path_buf(), move || {
            if mixdog_fsio::exists(&Unlaned, &marker)? {
                return Ok(0);
            }
            let mut text = read_state(&known_hosts)?;
            let mut held: std::collections::BTreeSet<String> = String::from_utf8_lossy(&text).lines().map(|line| line.trim().to_owned()).collect();
            let mut added = String::new();
            let mut count = 0;
            for line in old.lines().map(str::trim).filter(|line| !line.is_empty() && !line.starts_with('#')) {
                // The desktop's own entries belong to no saved server: whatever ownership mark they carry is dropped.
                let line = crate::pins::strip_reserved(line);
                if held.insert(line.clone()) {
                    added.push_str(&line);
                    added.push('\n');
                    count += 1;
                }
            }
            if count > 0 {
                if !text.is_empty() && !text.ends_with(b"\n") {
                    text.push(b'\n');
                }
                text.extend_from_slice(added.as_bytes());
                publish_file(&known_hosts, &text)?;
            }
            publish_file(&marker, b"")?;
            Ok(count)
        })
        .await
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
