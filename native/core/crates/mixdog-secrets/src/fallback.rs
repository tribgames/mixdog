//! The Linux fallback file: on a headless host with no keychain provider (an SSH server, WSL) a
//! secret is kept in `<plugin data>/secrets/<account>.secret` — one owner-only (0600) file per
//! account in an owner-only (0700) directory, written atomically, never in the config file
//! (`keychain-cjs.cjs` "Linux fallback file").
//!
//! A read re-verifies that layout (no symlink, a regular file, this user's, no group or other
//! access) and treats a store that fails it as unreadable. Only a host that positively has no
//! provider uses it; a locked keyring must be unlocked, and an unknown failure fails closed.
//!
//! Order: the keychain is always tried first and wins when it has the account; the file is read
//! only when the keychain has nothing (or cannot be read), so a value saved here stays readable
//! after a keychain becomes available, and a later save into an available keychain supersedes
//! (and removes) the file value.

// The file layout code is POSIX-only and used on Linux; elsewhere the fallback is inert.
#![cfg_attr(not(target_os = "linux"), allow(dead_code))]

use std::path::Path;
use std::path::PathBuf;
use std::sync::Arc;

use async_trait::async_trait;
use mixdog_rt::DurabilityIo;

use super::SecretError;
use super::SecretStore;
use super::on_lane;

/// How a stat disqualifies the store, as the repair it needs.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Unsafe {
    /// A symlink or not a regular file / directory: remove it.
    Type,
    /// Someone else's: chown it.
    Owner,
    /// Group or other can reach it: chmod it.
    Permissions,
}

/// `encodeURIComponent` of an account name (the file name).
fn encode_component(account: &str) -> String {
    let mut out = String::new();
    for byte in account.bytes() {
        if byte.is_ascii_alphanumeric() || b"-_.!~*'()".contains(&byte) {
            out.push(byte as char);
        } else {
            out.push_str(&format!("%{byte:02X}"));
        }
    }
    out
}

fn unsafe_error(message: &str, kind: Option<Unsafe>) -> SecretError {
    SecretError::new(format!("{message}{}", kind.map(|k| format!(" ({k:?})")).unwrap_or_default()))
}

#[derive(Clone)]
struct SecretsFiles {
    dir: PathBuf,
}

impl SecretsFiles {
    fn new(plugin_data: &Path) -> Self {
        Self { dir: plugin_data.join("secrets") }
    }

    fn file(&self, account: &str) -> PathBuf {
        self.dir.join(format!("{}.secret", encode_component(account)))
    }
}

#[cfg(unix)]
#[allow(clippy::disallowed_methods, clippy::disallowed_types, reason = "every function runs as a durability-lane job")]
mod fs_unix {
    use std::fs;
    use std::io::Read;
    use std::io::Write;
    use std::os::unix::fs::DirBuilderExt;
    use std::os::unix::fs::MetadataExt;
    use std::os::unix::fs::OpenOptionsExt;
    use std::os::unix::fs::PermissionsExt;

    use super::*;

    fn unsafe_kind(meta: &fs::Metadata, directory: bool) -> Option<Unsafe> {
        let right_type = if directory { meta.is_dir() } else { meta.is_file() };
        if !right_type {
            return Some(Unsafe::Type);
        }
        // SAFETY: getuid has no preconditions.
        if meta.uid() != unsafe { libc::getuid() } {
            return Some(Unsafe::Owner);
        }
        (meta.mode() & 0o077 != 0).then_some(Unsafe::Permissions)
    }

    /// The verified secrets directory, or `None` when absent and not `create`d. A symlink, a
    /// non-directory or a directory owned by someone else is refused: following it would chmod
    /// and write outside the data dir. `create` repairs the mode itself; a reader passes
    /// `require_private` and refuses a directory that group or other can reach instead.
    fn dir(files: &SecretsFiles, create: bool, require_private: bool) -> Result<Option<PathBuf>, SecretError> {
        let io = |e: std::io::Error| SecretError::new(e.to_string());
        let before = match fs::symlink_metadata(&files.dir) {
            Ok(meta) => meta,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                if !create {
                    return Ok(None);
                }
                if let Some(parent) = files.dir.parent() {
                    fs::DirBuilder::new().recursive(true).mode(0o700).create(parent).map_err(io)?;
                }
                fs::DirBuilder::new().mode(0o700).create(&files.dir).map_err(io)?;
                fs::symlink_metadata(&files.dir).map_err(io)?
            }
            Err(e) => return Err(io(e)),
        };
        let kind = unsafe_kind(&before, true);
        if kind.is_some_and(|k| k != Unsafe::Permissions || require_private) {
            return Err(unsafe_error("the secrets directory is not a private directory owned by this user", kind));
        }
        if create {
            fs::set_permissions(&files.dir, fs::Permissions::from_mode(0o700)).map_err(io)?;
            // The chmod must have hit the directory that was verified, not a swapped-in link.
            let after = fs::symlink_metadata(&files.dir).map_err(io)?;
            if !after.is_dir() || after.ino() != before.ino() || after.dev() != before.dev() {
                return Err(unsafe_error("the secrets directory changed while it was being secured", None));
            }
        }
        Ok(Some(files.dir.clone()))
    }

    /// A stored value is served only from a private regular file owned by this user, opened
    /// without following a symlink or blocking on a FIFO and judged by fstat on the descriptor
    /// that is actually read.
    pub fn get(files: &SecretsFiles, account: &str) -> Result<Option<String>, SecretError> {
        if dir(files, false, true)?.is_none() {
            return Ok(None);
        }
        let opened = fs::OpenOptions::new().read(true).custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK).open(files.file(account));
        let mut file = match opened {
            Ok(file) => file,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(e) if e.raw_os_error() == Some(libc::ELOOP) => {
                return Err(unsafe_error("the secret file is a symbolic link, not a private file", Some(Unsafe::Type)));
            }
            Err(e) => return Err(SecretError::new(e.to_string())),
        };
        let meta = file.metadata().map_err(|e| SecretError::new(e.to_string()))?;
        if let Some(kind) = unsafe_kind(&meta, false) {
            return Err(unsafe_error("the secret file is not a private regular file owned by this user", Some(kind)));
        }
        let mut text = String::new();
        file.read_to_string(&mut text).map_err(|e| SecretError::new(e.to_string()))?;
        Ok((!text.is_empty()).then_some(text))
    }

    pub fn set(files: &SecretsFiles, account: &str, value: &str) -> std::io::Result<()> {
        let dir = dir(files, true, false).map_err(|e| std::io::Error::other(e.message))?.expect("created");
        let target = files.file(account);
        let temporary = dir.join(format!(
            "{}.mixdog-tmp-{}-{:08x}",
            target.file_name().and_then(|n| n.to_str()).unwrap_or("secret"),
            std::process::id(),
            rand::random::<u32>()
        ));
        let written = (|| {
            let mut file = fs::OpenOptions::new().write(true).create_new(true).mode(0o600).open(&temporary)?;
            file.write_all(value.as_bytes())?;
            file.sync_all()?;
            fs::rename(&temporary, &target)?;
            let _ = fs::set_permissions(&target, fs::Permissions::from_mode(0o600));
            if let Ok(directory) = fs::File::open(&dir) {
                let _ = directory.sync_all();
            }
            Ok(())
        })();
        if written.is_err() {
            let _ = fs::remove_file(&temporary);
        }
        written
    }

    pub fn remove(files: &SecretsFiles, account: &str) -> Result<(), SecretError> {
        if dir(files, false, false)?.is_none() {
            return Ok(());
        }
        match fs::remove_file(files.file(account)) {
            Ok(()) => Ok(()),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(e) => Err(SecretError::new(e.to_string())),
        }
    }

    /// `(dir, kind)` when the store has a layout `get` refuses (so its keys read as absent).
    pub fn unsafe_store(files: &SecretsFiles) -> Option<(PathBuf, Unsafe)> {
        match dir(files, false, true) {
            Ok(None) => None,
            Ok(Some(dir)) => fs::read_dir(&dir).ok()?.flatten().find_map(|entry| {
                let name = entry.file_name();
                if !name.to_string_lossy().ends_with(".secret") {
                    return None;
                }
                let kind = unsafe_kind(&fs::symlink_metadata(entry.path()).ok()?, false)?;
                Some((dir.clone(), kind))
            }),
            Err(_) => Some((files.dir.clone(), Unsafe::Type)),
        }
    }
}

#[cfg(not(unix))]
mod fs_unix {
    use super::*;

    pub fn get(_: &SecretsFiles, _: &str) -> Result<Option<String>, SecretError> {
        Ok(None)
    }
    pub fn set(_: &SecretsFiles, _: &str, _: &str) -> std::io::Result<()> {
        Err(std::io::Error::other("the secrets file is a Linux fallback"))
    }
    pub fn remove(_: &SecretsFiles, _: &str) -> Result<(), SecretError> {
        Ok(())
    }
    pub fn unsafe_store(_: &SecretsFiles) -> Option<(PathBuf, Unsafe)> {
        None
    }
}

/// The layout problem that makes the fallback store's keys read as absent, if any (for the
/// keychain status). Call it from a lane job.
pub fn unsafe_store(plugin_data: &Path) -> Option<(PathBuf, Unsafe)> {
    if cfg!(target_os = "linux") { fs_unix::unsafe_store(&SecretsFiles::new(plugin_data)) } else { None }
}

/// The keychain with the private secrets file behind it, for hosts with no keychain provider.
pub struct FallbackStore {
    keychain: Arc<dyn SecretStore>,
    files: SecretsFiles,
    io: DurabilityIo,
}

impl FallbackStore {
    pub fn new(keychain: Arc<dyn SecretStore>, plugin_data: &Path, io: DurabilityIo) -> Self {
        Self { keychain, files: SecretsFiles::new(plugin_data), io }
    }

    async fn file_get(&self, account: &str) -> Result<Option<String>, SecretError> {
        if !cfg!(target_os = "linux") {
            return Ok(None);
        }
        let (files, account) = (self.files.clone(), account.to_owned());
        on_lane(self.io, move || fs_unix::get(&files, &account)).await?
    }

    async fn file_remove(&self, account: &str) -> Result<(), SecretError> {
        if !cfg!(target_os = "linux") {
            return Ok(());
        }
        let (files, account) = (self.files.clone(), account.to_owned());
        on_lane(self.io, move || fs_unix::remove(&files, &account)).await?
    }
}

#[async_trait]
impl SecretStore for FallbackStore {
    async fn get(&self, account: &str) -> Result<Option<String>, SecretError> {
        match self.keychain.get(account).await {
            Ok(Some(value)) => Ok(Some(value)),
            Ok(None) => self.file_get(account).await,
            // An unreadable keychain: a secret saved to the file is still there; otherwise the
            // keychain error stands, never masked by an unreadable file.
            Err(error) => match self.file_get(account).await.ok().flatten() {
                Some(value) => Ok(Some(value)),
                None => Err(error),
            },
        }
    }

    async fn set(&self, account: &str, value: &str) -> Result<(), SecretError> {
        match self.keychain.set(account, value).await {
            Ok(()) => {
                // The file value is now stale; best effort, the keychain write succeeded.
                if let Err(error) = self.file_remove(account).await {
                    tracing::debug!(%error, "could not remove superseded fallback secret");
                }
                Ok(())
            }
            Err(error) if error.no_provider && cfg!(target_os = "linux") => {
                let (files, account, value) = (self.files.clone(), account.to_owned(), value.to_owned());
                // The message carries the filesystem error only, never the value.
                on_lane(self.io, move || fs_unix::set(&files, &account, &value))
                    .await?
                    .map_err(|e| {
                        let reason = e.raw_os_error().map_or_else(|| "unknown error".to_owned(), |c| format!("os error {c}"));
                        SecretError::new(format!(
                            "{}\n  The private secrets file could not be written either: {reason}",
                            error.message
                        ))
                    })
            }
            Err(error) => Err(error),
        }
    }

    async fn delete(&self, account: &str) -> Result<(), SecretError> {
        self.file_remove(account).await?;
        match self.keychain.delete(account).await {
            Ok(()) => Ok(()),
            // No keychain provider here: nothing can be stored in it to delete.
            Err(error) if error.no_provider && cfg!(target_os = "linux") => Ok(()),
            Err(error) => Err(error),
        }
    }

    /// `hasFallbackSecret`: a value the keychain holds wins over the file; an unreadable file
    /// or keychain counts as "not served by the file".
    async fn is_fallback(&self, account: &str) -> bool {
        if matches!(self.keychain.get(account).await, Ok(Some(_))) {
            return false;
        }
        matches!(self.file_get(account).await, Ok(Some(_)))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn file_names_are_uri_components() {
        assert_eq!(encode_component("mcp-oauth.ab12"), "mcp-oauth.ab12");
        assert_eq!(encode_component("a/b c"), "a%2Fb%20c");
    }

    /// The private files Node's `setSecret` wrote on a host with no keychain provider
    /// (`record-process-services.mjs`, `keychain-cjs.cjs` run as Linux): the file of an account is
    /// `encodeURIComponent(account).secret` and holds the value as it is.
    const NODE_FILES: &str = include_str!("../../../fixtures/process-services/secrets.json");

    #[test]
    fn the_file_of_an_account_is_the_one_node_wrote() {
        let golden: serde_json::Value = serde_json::from_str(NODE_FILES).unwrap();
        let files = SecretsFiles::new(Path::new("data"));
        let recorded = golden["fallback"]["files"].as_object().unwrap();
        for case in golden["fallback"]["cases"].as_array().unwrap() {
            let account = case["account"].as_str().unwrap();
            let name = files.file(account).file_name().unwrap().to_str().unwrap().to_owned();
            assert_eq!(recorded[&name].as_str(), case["value"].as_str(), "{account}");
        }
        assert_eq!(recorded.len(), golden["fallback"]["cases"].as_array().unwrap().len());
    }

    #[cfg(target_os = "linux")]
    #[tokio::test]
    async fn a_file_node_wrote_is_read_and_labelled_a_fallback() {
        use std::os::unix::fs::PermissionsExt;
        let golden: serde_json::Value = serde_json::from_str(NODE_FILES).unwrap();
        let data = tempfile::tempdir().unwrap();
        let dir = data.path().join("secrets");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o700)).unwrap();
        for (name, content) in golden["fallback"]["files"].as_object().unwrap() {
            std::fs::write(dir.join(name), content.as_str().unwrap()).unwrap();
            std::fs::set_permissions(dir.join(name), std::fs::Permissions::from_mode(0o600)).unwrap();
        }
        let store = FallbackStore::new(Arc::new(crate::MemoryStore::default()), data.path(), mixdog_rt::testing::tokens().durability_io);
        for case in golden["fallback"]["cases"].as_array().unwrap() {
            let account = case["account"].as_str().unwrap();
            assert_eq!(store.get(account).await.unwrap().as_deref(), case["expected"].as_str(), "{account}");
            assert_eq!(store.is_fallback(account).await, case["hasFallback"].as_bool().unwrap(), "{account}");
        }
        let absent = &golden["fallback"]["absent"];
        assert_eq!(store.is_fallback(absent["account"].as_str().unwrap()).await, absent["hasFallback"].as_bool().unwrap());
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn the_file_layout_is_private_and_a_loosened_one_is_refused() {
        use std::os::unix::fs::PermissionsExt;
        let data = tempfile::tempdir().unwrap();
        let files = SecretsFiles::new(data.path());
        assert_eq!(fs_unix::get(&files, "acct").unwrap(), None);
        fs_unix::set(&files, "acct", "s3cret").unwrap();
        assert_eq!(fs_unix::get(&files, "acct").unwrap().as_deref(), Some("s3cret"));
        let mode = |p: &Path| std::fs::metadata(p).unwrap().permissions().mode() & 0o777;
        assert_eq!((mode(&data.path().join("secrets")), mode(&files.file("acct"))), (0o700, 0o600));
        std::fs::set_permissions(files.file("acct"), std::fs::Permissions::from_mode(0o644)).unwrap();
        assert!(fs_unix::get(&files, "acct").is_err(), "group/other access makes the store unreadable");
        assert_eq!(unsafe_store(data.path()).map(|(_, k)| k), Some(Unsafe::Permissions));
        std::fs::set_permissions(files.file("acct"), std::fs::Permissions::from_mode(0o600)).unwrap();
        fs_unix::remove(&files, "acct").unwrap();
        assert_eq!(fs_unix::get(&files, "acct").unwrap(), None);
    }
}
