//! Where a sign-in lives: the secret store (the OS keychain) holds the credentials; beside it,
//! two non-secret files per account tell the rest of the app what is stored without a keychain
//! read — `<account>.rev` (the entry's revision, with `+tokens` when it holds tokens) and
//! `<account>.who` (who the sign-in belongs to).

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Mutex;

use async_trait::async_trait;
use mixdog_rt::DurabilityIo;
use mixdog_rt::LaneToken;
use serde::Deserialize;
use serde::Serialize;
use tokio_util::sync::CancellationToken;

use super::account::Identity;
use super::account::can_force_account_choice;

/// A secret store failure (a locked or unavailable keychain).
#[derive(Clone, PartialEq, Eq, Debug, thiserror::Error)]
#[error("{message}")]
pub struct StoreError {
    pub message: String,
    /// The host positively has no keychain provider (not a locked or failing keychain).
    pub no_provider: bool,
}

impl StoreError {
    pub fn new(message: impl Into<String>) -> Self {
        Self { message: message.into(), no_provider: false }
    }
}

#[async_trait]
pub trait SecretStore: Send + Sync {
    async fn get(&self, account: &str) -> Result<Option<String>, StoreError>;
    async fn set(&self, account: &str, value: &str) -> Result<(), StoreError>;
    async fn delete(&self, account: &str) -> Result<(), StoreError>;
}

/// Runs a blocking closure on the durability lane.
pub(super) async fn on_lane<T: Send + 'static>(
    io: DurabilityIo,
    work: impl FnOnce() -> T + Send + 'static,
) -> Result<T, StoreError> {
    let job = io.submit(&CancellationToken::new(), move |_lane| work()).map_err(|_| StoreError::new("the durability lane is full"))?;
    job.await.map_err(|e| StoreError::new(format!("{e:?}")))
}

const SERVICE: &str = "mixdog";
/// The Windows credential blob holds 2560 bytes (UTF-16): longer values are stored in chunks.
const CHUNK_CHARS: usize = 1000;
const CHUNK_HEADER: &str = "mixdog-chunks:";

/// The OS keychain: Windows Credential Manager, the macOS keychain, the Secret Service.
pub struct KeyringStore {
    io: DurabilityIo,
}

impl KeyringStore {
    pub fn new(io: DurabilityIo) -> Self {
        Self { io }
    }
}

/// The D-Bus error names that say a host has no Secret Service to talk to: nothing owns
/// `org.freedesktop.secrets` (`ServiceUnknown`, `NameHasNoOwner`), the bus socket is absent or
/// refuses (`FileNotFound`, `NoServer`: libdbus maps `ENOENT` and `ECONNREFUSED` to them), or
/// the bus launcher cannot start (`Spawn.ExecFailed`). Anything else — a locked keyring, a
/// dismissed prompt, an unknown failure — is not a missing provider, so it never falls back to
/// the secrets file. These replace the text patterns Node matched on `secret-tool`'s stderr.
const NO_PROVIDER_DBUS_ERRORS: [&str; 5] = [
    "org.freedesktop.DBus.Error.ServiceUnknown",
    "org.freedesktop.DBus.Error.NameHasNoOwner",
    "org.freedesktop.DBus.Error.NoServer",
    "org.freedesktop.DBus.Error.FileNotFound",
    "org.freedesktop.DBus.Error.Spawn.ExecFailed",
];

pub fn dbus_error_means_no_provider(name: &str) -> bool {
    NO_PROVIDER_DBUS_ERRORS.contains(&name)
}

/// Whether no D-Bus session bus can be reached: no `DBUS_SESSION_BUS_ADDRESS`, no
/// `$XDG_RUNTIME_DIR/bus` socket, and no `DISPLAY` for libdbus to autolaunch one with (Node's
/// "Cannot autolaunch D-Bus without X11 $DISPLAY"). A fact about the environment, found before
/// any connect.
pub fn no_session_bus(address: Option<&str>, display: Option<&str>, runtime_bus_exists: bool) -> bool {
    address.is_none_or(str::is_empty) && display.is_none_or(str::is_empty) && !runtime_bus_exists
}

#[cfg(target_os = "linux")]
#[allow(clippy::disallowed_methods, reason = "runs inside a durability-lane job")]
fn session_bus_missing() -> bool {
    let var = |name: &str| std::env::var(name).ok();
    let runtime_bus = std::env::var_os("XDG_RUNTIME_DIR").is_some_and(|dir| std::path::Path::new(&dir).join("bus").exists());
    no_session_bus(var("DBUS_SESSION_BUS_ADDRESS").as_deref(), var("DISPLAY").as_deref(), runtime_bus)
}

#[cfg(not(target_os = "linux"))]
fn session_bus_missing() -> bool {
    false
}

/// Whether the keyring library's typed error says the provider is absent. The library wraps
/// the Secret Service client's error in `PlatformFailure`; zbus reports a missing or refusing
/// bus socket as an I/O error (or an address error when none is named), and an absent service
/// as one of the D-Bus error names above.
#[cfg(target_os = "linux")]
fn error_means_no_provider(error: &keyring::Error) -> bool {
    let keyring::Error::PlatformFailure(source) = error else { return false };
    match source.downcast_ref::<secret_service::Error>() {
        Some(secret_service::Error::Zbus(inner)) => zbus_means_no_provider(inner),
        Some(secret_service::Error::ZbusFdo(inner)) => fdo_means_no_provider(inner),
        _ => false,
    }
}

#[cfg(target_os = "linux")]
fn fdo_means_no_provider(error: &zbus::fdo::Error) -> bool {
    use zbus::fdo::Error as Fdo;
    match error {
        Fdo::ServiceUnknown(_) | Fdo::NameHasNoOwner(_) | Fdo::NoServer(_) | Fdo::FileNotFound(_) | Fdo::SpawnExecFailed(_) => true,
        Fdo::ZBus(inner) => zbus_means_no_provider(inner),
        _ => false,
    }
}

#[cfg(target_os = "linux")]
fn zbus_means_no_provider(error: &zbus::Error) -> bool {
    use zbus::Error as Zbus;
    match error {
        Zbus::Address(_) => true,
        Zbus::InputOutput(io) => matches!(io.kind(), std::io::ErrorKind::NotFound | std::io::ErrorKind::ConnectionRefused),
        Zbus::MethodError(name, _, _) => dbus_error_means_no_provider(name.as_str()),
        Zbus::FDO(inner) => fdo_means_no_provider(inner),
        _ => false,
    }
}

#[cfg(not(target_os = "linux"))]
fn error_means_no_provider(_: &keyring::Error) -> bool {
    false
}

fn keyring_error(error: keyring::Error) -> StoreError {
    StoreError { no_provider: error_means_no_provider(&error), message: error.to_string() }
}

fn entry(account: &str) -> Result<keyring::Entry, StoreError> {
    if session_bus_missing() {
        return Err(StoreError { message: "no D-Bus session bus is available".to_owned(), no_provider: true });
    }
    keyring::Entry::new(SERVICE, account).map_err(keyring_error)
}

fn read_one(account: &str) -> Result<Option<String>, StoreError> {
    match entry(account)?.get_password() {
        Ok(value) => Ok(Some(value)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(error) => Err(keyring_error(error)),
    }
}

fn delete_one(account: &str) -> Result<(), StoreError> {
    match entry(account)?.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(error) => Err(keyring_error(error)),
    }
}

fn chunk_count(header: &str) -> Option<usize> {
    header.strip_prefix(CHUNK_HEADER)?.parse().ok()
}

fn read_value(account: &str) -> Result<Option<String>, StoreError> {
    let Some(first) = read_one(account)? else { return Ok(None) };
    let Some(count) = chunk_count(&first) else { return Ok(Some(first)) };
    let mut out = String::new();
    for index in 0..count {
        out.push_str(&read_one(&format!("{account}.{index}"))?.ok_or_else(|| StoreError::new("the stored entry is incomplete"))?);
    }
    Ok(Some(out))
}

fn delete_value(account: &str) -> Result<(), StoreError> {
    if let Some(count) = read_one(account)?.as_deref().and_then(chunk_count) {
        for index in 0..count {
            delete_one(&format!("{account}.{index}"))?;
        }
    }
    delete_one(account)
}

fn write_value(account: &str, value: &str) -> Result<(), StoreError> {
    let previous = read_one(account)?.as_deref().and_then(chunk_count).unwrap_or(0);
    let chars: Vec<char> = value.chars().collect();
    let count = if chars.len() <= CHUNK_CHARS {
        entry(account)?.set_password(value).map_err(keyring_error)?;
        0
    } else {
        let chunks: Vec<String> = chars.chunks(CHUNK_CHARS).map(|c| c.iter().collect()).collect();
        for (index, chunk) in chunks.iter().enumerate() {
            entry(&format!("{account}.{index}"))?.set_password(chunk).map_err(keyring_error)?;
        }
        entry(account)?.set_password(&format!("{CHUNK_HEADER}{}", chunks.len())).map_err(keyring_error)?;
        chunks.len()
    };
    for index in count..previous {
        delete_one(&format!("{account}.{index}"))?;
    }
    Ok(())
}

#[async_trait]
impl SecretStore for KeyringStore {
    async fn get(&self, account: &str) -> Result<Option<String>, StoreError> {
        let account = account.to_owned();
        on_lane(self.io, move || read_value(&account)).await?
    }

    async fn set(&self, account: &str, value: &str) -> Result<(), StoreError> {
        let (account, value) = (account.to_owned(), value.to_owned());
        on_lane(self.io, move || write_value(&account, &value)).await?
    }

    async fn delete(&self, account: &str) -> Result<(), StoreError> {
        let account = account.to_owned();
        on_lane(self.io, move || delete_value(&account)).await?
    }
}

/// An in-process store (tests, and hosts with no keychain that accept losing sign-ins on exit).
#[derive(Default)]
pub struct MemoryStore {
    entries: Mutex<HashMap<String, String>>,
}

#[async_trait]
impl SecretStore for MemoryStore {
    async fn get(&self, account: &str) -> Result<Option<String>, StoreError> {
        Ok(self.entries.lock().unwrap_or_else(|e| e.into_inner()).get(account).cloned())
    }

    async fn set(&self, account: &str, value: &str) -> Result<(), StoreError> {
        self.entries.lock().unwrap_or_else(|e| e.into_inner()).insert(account.to_owned(), value.to_owned());
        Ok(())
    }

    async fn delete(&self, account: &str) -> Result<(), StoreError> {
        self.entries.lock().unwrap_or_else(|e| e.into_inner()).remove(account);
        Ok(())
    }
}

pub const TOKENS_FLAG: &str = "+tokens";

/// The revision marker: `deleted` when there is no entry, the revision, plus the tokens flag.
pub fn marker_of(revision: Option<&str>, has_tokens: bool) -> String {
    match revision {
        None => "deleted".to_owned(),
        Some(revision) if has_tokens => format!("{revision}{TOKENS_FLAG}"),
        Some(revision) => revision.to_owned(),
    }
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct WhoFile {
    #[serde(default)]
    account: String,
    #[serde(default)]
    workspace: String,
    #[serde(default)]
    forced_choice: bool,
}

/// Who a stored sign-in belongs to, as the status lists it.
#[derive(Clone, PartialEq, Eq, Debug)]
pub struct StoredIdentity {
    pub account: String,
    pub workspace: String,
    pub forced_choice: bool,
}

/// The non-secret marker files of the accounts, under `<plugin data>/mcp-oauth/`.
#[derive(Clone)]
pub struct MarkerFiles {
    dir: PathBuf,
    io: DurabilityIo,
}

#[allow(clippy::disallowed_methods, reason = "runs as a durability-lane job")]
fn write_atomic(dir: &std::path::Path, name: &str, text: &str) -> std::io::Result<()> {
    std::fs::create_dir_all(dir)?;
    let tmp = dir.join(format!("{name}.{}.tmp", uuid::Uuid::new_v4().simple()));
    std::fs::write(&tmp, text)?;
    std::fs::rename(&tmp, dir.join(name)).inspect_err(|_| {
        let _ = std::fs::remove_file(&tmp);
    })
}

impl MarkerFiles {
    pub fn new(plugin_data: PathBuf, io: DurabilityIo) -> Self {
        Self { dir: plugin_data.join("mcp-oauth"), io }
    }

    pub async fn write_revision(&self, account: &str, revision: Option<&str>, has_tokens: bool) -> Result<(), StoreError> {
        let (dir, name, text) = (self.dir.clone(), format!("{account}.rev"), marker_of(revision, has_tokens));
        on_lane(self.io, move || write_atomic(&dir, &name, &text)).await?.map_err(|e| StoreError::new(e.to_string()))
    }

    /// Writes who the sign-in belongs to, or removes the file when signed out.
    #[allow(clippy::disallowed_methods, reason = "runs as a durability-lane job")]
    pub async fn write_identity(
        &self,
        account: &str,
        identity: Option<(&Identity, Option<&str>)>,
    ) -> Result<(), StoreError> {
        let (dir, name) = (self.dir.clone(), format!("{account}.who"));
        let text = identity.map(|(who, authorization_endpoint)| {
            serde_json::to_string(&WhoFile {
                account: who.account.clone(),
                workspace: who.workspace.clone(),
                forced_choice: can_force_account_choice(authorization_endpoint),
            })
            .unwrap_or_default()
        });
        on_lane(self.io, move || match text {
            Some(text) => write_atomic(&dir, &name, &text),
            None => std::fs::remove_file(dir.join(&name)).or_else(|e| if e.kind() == std::io::ErrorKind::NotFound { Ok(()) } else { Err(e) }),
        })
        .await?
        .map_err(|e| StoreError::new(e.to_string()))
    }

    #[allow(clippy::disallowed_methods, reason = "runs as a durability-lane job")]
    async fn read(&self, name: String) -> Option<String> {
        let path = self.dir.join(name);
        on_lane(self.io, move || std::fs::read_to_string(path).ok()).await.ok().flatten()
    }

    /// Whether tokens are stored for `account`, from the marker alone.
    pub async fn has_tokens(&self, account: &str) -> bool {
        self.read(format!("{account}.rev")).await.is_some_and(|m| m.ends_with(TOKENS_FLAG))
    }

    pub async fn identity(&self, account: &str) -> Option<StoredIdentity> {
        let text = self.read(format!("{account}.who")).await?;
        let file: WhoFile = serde_json::from_str(&text).ok()?;
        Some(StoredIdentity { account: file.account, workspace: file.workspace, forced_choice: file.forced_choice })
    }
}
