//! The credential-read counter seen from a crate that only depends on the crates that read. A read done by a
//! dependency moves `mixdog_ai::work`'s counter when the dependency's `count-work` feature is on (this crate's
//! dev-dependencies turn it on); a read gated on the dependency's own `cfg(test)` would compile out here.

use std::sync::Arc;

use mixdog_ai::registry::keys::ApiKeyStore;
use mixdog_ai::registry::keys::ProcessEnv;
use mixdog_ai::registry::keys::SecretVault;
use mixdog_core::run_host::vault::KeychainVault;
use mixdog_core_domains::domains::ai_account::admin::ProviderAdmin;
use mixdog_core_domains::domains::ai_account::oauth_credentials::credential_file;
use mixdog_core_domains::domains::ai_account::oauth_credentials::load_oauth_credentials;

#[test]
fn the_domains_oauth_loader_moves_the_counter_from_a_dependent_crate() {
    let dir = tempfile::tempdir().unwrap();
    let path = credential_file("openai-oauth", &|_| None, dir.path(), dir.path()).unwrap();
    for read in 1..=2 {
        let before = mixdog_ai::work::credential_reads();
        assert_eq!(load_oauth_credentials("openai-oauth", &path, 0, None), None);
        assert!(mixdog_ai::work::credential_reads() > before, "oauth load {read} moved no counter seen from the dependent crate");
    }
}

/// One logical lookup is one counted read, counted by the store that performs it: not again by the vault over it, nor by
/// `ApiKeyStore::stored` over that.
#[tokio::test]
async fn one_vault_lookup_through_the_key_store_is_one_credential_read() {
    let vault = Arc::new(KeychainVault::new(Arc::new(mixdog_secrets::MemoryStore::default())));
    let keys = ApiKeyStore::new(vault, Arc::new(ProcessEnv), false);
    for read in 1..=2 {
        let before = mixdog_ai::work::credential_reads();
        assert_eq!(keys.read_custom("custom-one", "k1").await.unwrap(), "");
        assert_eq!(mixdog_ai::work::credential_reads() - before, 1, "ApiKeyStore::read_custom, lookup {read}");
    }
}

/// The Windows store (DPAPI files) over a directory the test owns: a lookup is exactly one read, and `is_fallback` is a
/// constant that reads nothing. Only Windows has a platform store the test can own: macOS ignores the directory and reads
/// the user's real keychain, Linux the real keyring (two reads on a keyring miss: keyring, then the fallback file), so
/// neither is looked up from a test; the platform-independent count is `one_vault_lookup_through_the_key_store_...`.
#[cfg(windows)]
#[tokio::test]
async fn the_windows_store_counts_one_read_per_lookup_and_a_constant_fallback_check_reads_nothing() {
    let dir = tempfile::tempdir().unwrap();
    let store = mixdog_secrets::default_store(mixdog_rt::testing::tokens().durability_io, dir.path());
    let vault = KeychainVault::new(store);
    let before = mixdog_ai::work::credential_reads();
    assert_eq!(vault.get("agent.test-owned.apiKey").await.unwrap(), None);
    assert_eq!(mixdog_ai::work::credential_reads() - before, 1, "one keychain lookup");
    let before = mixdog_ai::work::credential_reads();
    vault.is_fallback("agent.test-owned.apiKey").await.unwrap();
    assert_eq!(mixdog_ai::work::credential_reads() - before, 0, "is_fallback reads nothing on this platform");
}

/// The settings view's probe of a custom provider's key variable reads the process environment through the counted function.
#[test]
fn the_admin_key_variable_probe_is_one_credential_read() {
    for read in 1..=2 {
        let before = mixdog_ai::work::credential_reads();
        let found = ProviderAdmin::check_custom_provider_key_env("MIXDOG_NO_SUCH_KEY_VARIABLE").unwrap();
        assert_eq!(found["found"], false);
        assert_eq!(mixdog_ai::work::credential_reads() - before, 1, "check_custom_provider_key_env, probe {read}");
    }
}
