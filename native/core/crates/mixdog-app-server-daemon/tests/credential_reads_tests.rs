//! The credential-read counter seen from a crate that only depends on the crates that read. A read done by a
//! dependency moves `mixdog_ai::work`'s counter when the dependency's `count-work` feature is on (this crate's
//! dev-dependencies turn it on); a read gated on the dependency's own `cfg(test)` would compile out here.

use std::sync::Arc;

use mixdog_ai::registry::keys::SecretVault;
use mixdog_core::run_host::vault::KeychainVault;
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

#[tokio::test]
async fn the_keychain_vault_moves_the_counter_from_a_dependent_crate() {
    let vault = KeychainVault::new(Arc::new(mixdog_secrets::MemoryStore::default()));
    for read in 1..=2 {
        let before = mixdog_ai::work::credential_reads();
        assert_eq!(vault.get("agent.openai.apiKey").await.unwrap(), None);
        assert!(mixdog_ai::work::credential_reads() > before, "vault read {read} moved no counter seen from the dependent crate");
    }
}
