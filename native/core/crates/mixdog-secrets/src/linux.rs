//! Linux: Secret Service items with the attributes `service=mixdog` and `account=<account>` and
//! the label `mixdog <account>` — exactly what `secret-tool store/lookup/clear` writes and reads
//! (`keychain-cjs.cjs` linux), so items saved by earlier builds stay readable. The client is
//! pure Rust (zbus), with no libsecret and no `secret-tool`.
//!
//! Which failures mean "this host has no provider" (and so fall back to the private file) is read
//! from typed D-Bus errors, never from message text; a locked keyring, a dismissed prompt and
//! every other failure keep failing closed.

use std::collections::HashMap;
use std::future::Future;

use async_trait::async_trait;
use secret_service::EncryptionType;
use secret_service::SecretService;

use super::SERVICE;
use super::SecretError;
use super::SecretStore;
use super::keychain_timeout;

/// The D-Bus error names that say a host has no Secret Service to talk to: nothing owns
/// `org.freedesktop.secrets` (`ServiceUnknown`, `NameHasNoOwner`), the bus socket is absent or
/// refuses (`FileNotFound`, `NoServer`), or the bus launcher cannot start (`Spawn.ExecFailed`).
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
/// `$XDG_RUNTIME_DIR/bus` socket, and no `DISPLAY` to autolaunch one with (Node's "Cannot
/// autolaunch D-Bus without X11 $DISPLAY"). A fact about the environment, found before any
/// connect.
pub fn no_session_bus(address: Option<&str>, display: Option<&str>, runtime_bus_exists: bool) -> bool {
    address.is_none_or(str::is_empty) && display.is_none_or(str::is_empty) && !runtime_bus_exists
}

#[allow(clippy::disallowed_methods, reason = "a bounded stat of the user's runtime bus socket")]
fn session_bus_missing() -> bool {
    let var = |name: &str| std::env::var(name).ok();
    let runtime_bus = std::env::var_os("XDG_RUNTIME_DIR").is_some_and(|dir| std::path::Path::new(&dir).join("bus").exists());
    no_session_bus(var("DBUS_SESSION_BUS_ADDRESS").as_deref(), var("DISPLAY").as_deref(), runtime_bus)
}

fn fdo_means_no_provider(error: &zbus::fdo::Error) -> bool {
    use zbus::fdo::Error as Fdo;
    match error {
        Fdo::ServiceUnknown(_) | Fdo::NameHasNoOwner(_) | Fdo::NoServer(_) | Fdo::FileNotFound(_) | Fdo::SpawnExecFailed(_) => true,
        Fdo::ZBus(inner) => zbus_means_no_provider(inner),
        _ => false,
    }
}

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

fn means_no_provider(error: &secret_service::Error) -> bool {
    match error {
        secret_service::Error::Unavailable => true,
        secret_service::Error::Zbus(inner) => zbus_means_no_provider(inner),
        secret_service::Error::ZbusFdo(inner) => fdo_means_no_provider(inner),
        _ => false,
    }
}

const LOCKED: &str = "the keyring is locked or the unlock prompt was declined. Unlock your keyring and retry.";
const HINT: &str = "run a Secret Service provider such as gnome-keyring or KeePassXC, or set the relevant MIXDOG_*/PROVIDER_API_KEY environment variable instead";

fn failure(action: &str, error: &secret_service::Error) -> SecretError {
    let no_provider = means_no_provider(error);
    let message = match error {
        secret_service::Error::Locked | secret_service::Error::Prompt => format!("[keychain] secret service {action} failed: {LOCKED}"),
        _ => format!("[keychain] secret service {action} failed — {HINT}"),
    };
    tracing::debug!(%error, action, "secret service call failed");
    SecretError { message, no_provider, unrun: false }
}

/// `op` bounded by the keychain timeout, which a locked keyring waiting on its unlock prompt hits.
async fn bounded<T>(action: &str, op: impl Future<Output = Result<T, SecretError>>) -> Result<T, SecretError> {
    let limit = keychain_timeout();
    mixdog_rt::time::timeout(limit, op).await.unwrap_or_else(|_| {
        Err(SecretError::new(format!(
            "[keychain] secret service {action} timed out after {}ms — the keyring is locked or its unlock prompt was not answered. Unlock your keyring (e.g. log in again or open Passwords and Keys) and retry.",
            limit.as_millis()
        )))
    })
}

async fn connect(action: &str) -> Result<SecretService<'static>, SecretError> {
    if session_bus_missing() {
        return Err(SecretError { message: "no D-Bus session bus is available".to_owned(), no_provider: true, unrun: false });
    }
    SecretService::connect(EncryptionType::Dh).await.map_err(|e| failure(action, &e))
}

fn attributes(account: &str) -> HashMap<&str, &str> {
    HashMap::from([("service", SERVICE), ("account", account)])
}

pub struct SecretServiceStore;

impl SecretServiceStore {
    pub fn new() -> Self {
        Self
    }
}

async fn lookup(account: &str) -> Result<Option<String>, SecretError> {
    #[cfg(feature = "count-work")]
    crate::work::secret_read();
    let service = connect("lookup").await?;
    let found = service.search_items(attributes(account)).await.map_err(|e| failure("lookup", &e))?;
    let Some(item) = found.unlocked.iter().chain(found.locked.iter()).next() else { return Ok(None) };
    item.ensure_unlocked().await.map_err(|e| failure("lookup", &e))?;
    let secret = item.get_secret().await.map_err(|e| failure("lookup", &e))?;
    Ok(Some(String::from_utf8_lossy(&secret).into_owned()))
}

async fn store(account: &str, value: &str) -> Result<(), SecretError> {
    let service = connect("store").await?;
    let collection = service.get_default_collection().await.map_err(|e| failure("store", &e))?;
    collection.ensure_unlocked().await.map_err(|e| failure("store", &e))?;
    collection
        .create_item(&format!("{SERVICE} {account}"), attributes(account), value.as_bytes(), true, "text/plain")
        .await
        .map_err(|e| failure("store", &e))?;
    Ok(())
}

async fn clear(account: &str) -> Result<(), SecretError> {
    let service = connect("clear").await?;
    let found = service.search_items(attributes(account)).await.map_err(|e| failure("clear", &e))?;
    for item in found.unlocked.iter().chain(found.locked.iter()) {
        item.ensure_unlocked().await.map_err(|e| failure("clear", &e))?;
        item.delete().await.map_err(|e| failure("clear", &e))?;
    }
    Ok(())
}

#[async_trait]
impl SecretStore for SecretServiceStore {
    async fn get(&self, account: &str) -> Result<Option<String>, SecretError> {
        bounded("lookup", lookup(account)).await
    }

    async fn set(&self, account: &str, value: &str) -> Result<(), SecretError> {
        bounded("store", store(account, value)).await
    }

    async fn delete(&self, account: &str) -> Result<(), SecretError> {
        bounded("clear", clear(account)).await
    }

    async fn is_fallback(&self, _account: &str) -> Result<bool, SecretError> {
        Ok(false)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_a_missing_provider_is_recognised() {
        for name in ["ServiceUnknown", "NameHasNoOwner", "NoServer", "FileNotFound", "Spawn.ExecFailed"] {
            assert!(dbus_error_means_no_provider(&format!("org.freedesktop.DBus.Error.{name}")), "{name}");
        }
        // A locked keyring, a dismissed prompt and everything else keep failing closed.
        for name in ["AccessDenied", "NoReply", "Failed", "UnknownMethod", "InvalidArgs", "AuthFailed", "Timeout"] {
            assert!(!dbus_error_means_no_provider(&format!("org.freedesktop.DBus.Error.{name}")), "{name}");
        }
        assert!(!dbus_error_means_no_provider("org.freedesktop.Secret.Error.IsLocked"));
        assert!(!dbus_error_means_no_provider(""));
        assert!(!means_no_provider(&secret_service::Error::Locked));
        assert!(means_no_provider(&secret_service::Error::Unavailable));
        // The bus is missing only when nothing names one and nothing can start one.
        assert!(no_session_bus(None, None, false));
        assert!(no_session_bus(Some(""), Some(""), false));
        assert!(!no_session_bus(Some("unix:path=/run/user/1000/bus"), None, false));
        assert!(!no_session_bus(None, Some(":0"), false));
        assert!(!no_session_bus(None, None, true));
    }
}
