//! The production [`SecretVault`] (Node `lib/keychain-cjs.cjs`, reached through
//! `shared/config.mjs` `getSecret` / `setSecret` / `deleteSecret` / `isFallbackSecret`).
//!
//! The storage is `mixdog-secrets`' [`SecretStore`], which reads and writes the files and
//! keychain items a 1.4.5 install already holds: a DPAPI file `<plugin data>/secrets/<account>.dpapi`
//! on Windows, a `service=mixdog` generic password on macOS, a Secret Service item (or the private
//! `<account>.secret` file on a host with no provider) on Linux. The accounts are the vault's:
//! `agent.<provider>.apiKey`, `agent.<provider>.apiKey.<keyId>`.

use std::path::Path;
use std::sync::Arc;

use async_trait::async_trait;
use mixdog_ai::registry::keys::{SecretVault, VaultError};
use mixdog_rt::DurabilityIo;
use mixdog_secrets::{default_store, SecretError, SecretStore};

pub struct KeychainVault {
    store: Arc<dyn SecretStore>,
}

fn vault_error(error: SecretError) -> VaultError {
    if error.unrun {
        // The secrets lane's own text names an internal queue; this is what the user reads.
        VaultError::unrun("the keychain could not be reached: its lane did not run the call")
    } else {
        VaultError::new(error.message)
    }
}

impl KeychainVault {
    pub fn new(store: Arc<dyn SecretStore>) -> Self {
        Self { store }
    }

    /// The host's keychain, with the private secrets file behind it on Linux. `plugin_data` is
    /// the directory Node's `resolvePluginData()` names; its `secrets/` folder is the store.
    pub fn open(io: DurabilityIo, plugin_data: &Path) -> Self {
        Self::new(default_store(io, plugin_data))
    }
}

#[async_trait]
impl SecretVault for KeychainVault {
    async fn get(&self, account: &str) -> Result<Option<String>, VaultError> {
        self.store.get(account).await.map_err(vault_error)
    }

    async fn set(&self, account: &str, value: &str) -> Result<(), VaultError> {
        self.store.set(account, value).await.map_err(vault_error)
    }

    async fn delete(&self, account: &str) -> Result<(), VaultError> {
        self.store.delete(account).await.map_err(vault_error)
    }

    async fn is_fallback(&self, account: &str) -> Result<bool, VaultError> {
        self.store.is_fallback(account).await.map_err(vault_error)
    }
}
