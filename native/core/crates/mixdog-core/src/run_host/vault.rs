//! Storage is `mixdog-secrets`' [`SecretStore`], reading the 1.4.5 install's items: `<plugin data>/secrets/<account>.dpapi` on Windows, `service=mixdog` generic password on macOS, Secret Service (or `<account>.secret`) on Linux.

use std::path::Path;
use std::sync::Arc;

use async_trait::async_trait;
use mixdog_ai::registry::keys::{SecretVault, VaultError};
use mixdog_rt::DurabilityIo;
use mixdog_secrets::{SecretError, SecretStore, default_store};

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
    /// Every keychain read of the composed process comes here (the key store, the setup and admin views, the usage
    /// session key): what it yields is a credential before anything can carry it, the keychain entry its source.
    async fn get(&self, account: &str) -> Result<Option<String>, VaultError> {
        let value = self.store.get(account).await.map_err(vault_error)?;
        mixdog_ai::oauth::carried::keep(
            &mixdog_ai::registry::keys::keychain_source(&self.identity(), account),
            &value.as_deref().into_iter().collect::<Vec<_>>(),
        );
        Ok(value)
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
