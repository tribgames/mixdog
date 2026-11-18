//! What an initialization of the provider set registers, when it is refused instead of leaving the registry dark, when
//! a signed-in OAuth provider is kept, and when readiness is announced.

use std::sync::Arc;
use std::sync::Mutex;

use async_trait::async_trait;
use mixdog_ai::accounts::CredentialState;
use mixdog_ai::registry::ProviderRegistry;
use mixdog_ai::registry::providers::NO_ENABLED_PROVIDERS;
use mixdog_ai::registry::providers::ProviderBuilder;
use mixdog_ai::registry::providers::RegistryError;
use mixdog_core_api::domain::mock::MockAttempt;
use mixdog_core_api::domain::mock::MockProvider;
use mixdog_core_api::domain::provider::ProviderAdapter;
use serde_json::Value;
use serde_json::json;

/// Builds every name; a name in `off` is a dev-gated provider that is not on; `credential` is what the probes read.
struct Builder {
    credential: Mutex<CredentialState>,
    off: Vec<&'static str>,
}

fn builder(credential: CredentialState) -> Arc<Builder> {
    Arc::new(Builder { credential: Mutex::new(credential), off: vec!["devin-oauth"] })
}

#[async_trait]
impl ProviderBuilder for Builder {
    async fn build(&self, _name: &str, _config: &Value) -> Result<Arc<dyn ProviderAdapter>, String> {
        Ok(Arc::new(MockProvider::new(Vec::<MockAttempt>::new())))
    }
    async fn custom_key_ids(&self, _name: &str) -> Result<Vec<String>, String> {
        Ok(Vec::new())
    }
    fn available(&self, name: &str) -> bool {
        !self.off.contains(&name)
    }
    async fn oauth_credentials_usable(&self, _name: &str) -> Result<bool, String> {
        Ok(*self.credential.lock().unwrap() == CredentialState::Present)
    }
    async fn oauth_credential_state(&self, _name: &str) -> Result<CredentialState, String> {
        Ok(*self.credential.lock().unwrap())
    }
}

async fn init(registry: &ProviderRegistry, config: Value) -> Result<(), RegistryError> {
    registry.init_providers(config.as_object().expect("a config object")).await
}

/// Whether `wait_initialized` has resolved, given the event loop a few turns (no wall time).
async fn resolved(registry: &Arc<ProviderRegistry>) -> bool {
    let waiter = tokio::spawn({
        let registry = Arc::clone(registry);
        async move { registry.wait_initialized().await }
    });
    for _ in 0..20 {
        tokio::task::yield_now().await;
    }
    let done = waiter.is_finished();
    waiter.abort();
    done
}

const NONE_LEFT: &str = "[provider] all providers disabled in config — refusing to clear registry";

#[tokio::test]
async fn an_init_registers_the_enabled_providers_and_announces_readiness() {
    let registry = Arc::new(ProviderRegistry::new(builder(CredentialState::Present)));
    assert!(!registry.initialized());
    assert!(!resolved(&registry).await);
    init(&registry, json!({"anthropic": {"enabled": true}, "openai": {"enabled": true}, "gemini": {"enabled": false}})).await.unwrap();
    assert_eq!(registry.names().into_iter().collect::<Vec<_>>(), ["anthropic", "openai"], "a disabled entry is not built");
    assert!(registry.initialized());
    assert!(resolved(&registry).await, "readiness is announced");
}

#[tokio::test]
async fn an_init_that_leaves_nothing_registered_is_refused_with_the_code_and_leaves_the_registry_unready() {
    let registry = Arc::new(ProviderRegistry::new(builder(CredentialState::Present)));
    for config in [
        json!({"anthropic": {"enabled": false}}),
        json!({"devin-oauth": {"enabled": true}}),
        json!({"opencode-go": {"enabled": true}}),
        json!({"anthropic": {}}),
    ] {
        let error = init(&registry, config.clone()).await.expect_err("nothing would be left");
        assert_eq!((error.message.as_str(), error.code), (NONE_LEFT, Some(NO_ENABLED_PROVIDERS)), "{config}");
    }
    assert!(registry.names().is_empty());
    assert!(!registry.initialized(), "a refused init never announces readiness");
    assert!(!resolved(&registry).await, "the wait stays pending");
}

#[tokio::test]
async fn an_init_adds_what_is_missing_and_leaves_a_registered_provider_as_it_is() {
    let registry = ProviderRegistry::new(builder(CredentialState::Present));
    init(&registry, json!({"anthropic": {"enabled": true}})).await.unwrap();
    let first = registry.registered("anthropic").expect("registered");
    init(&registry, json!({"anthropic": {"enabled": true, "apiKey": "changed"}, "openai": {"enabled": true}})).await.unwrap();
    assert!(Arc::ptr_eq(&first, &registry.registered("anthropic").unwrap()), "an init never rebuilds a registered provider");
    assert!(registry.registered("openai").is_some());
    init(&registry, json!({"anthropic": {"enabled": true}})).await.unwrap();
    assert_eq!(registry.names().len(), 2, "an init that names fewer removes none");
}

#[tokio::test]
async fn a_later_refusal_does_not_unsettle_a_registry_that_was_ready() {
    let registry = Arc::new(ProviderRegistry::new(builder(CredentialState::Present)));
    init(&registry, json!({"anthropic": {"enabled": true}})).await.unwrap();
    let error = init(&registry, json!({"gemini": {"enabled": false}})).await.expect_err("nothing of this config is registered");
    assert_eq!(error.code, Some(NO_ENABLED_PROVIDERS));
    assert!(registry.initialized() && resolved(&registry).await);
    assert!(registry.registered("anthropic").is_some(), "a refused init changes nothing");
}

#[tokio::test]
async fn a_signed_in_oauth_provider_outside_the_config_keeps_the_registry_alive_unless_its_credential_is_gone() {
    for (credential, kept) in [(CredentialState::Present, true), (CredentialState::Unreadable, true), (CredentialState::Absent, false)] {
        let build = builder(CredentialState::Present);
        let registry = ProviderRegistry::new(build.clone());
        init(&registry, json!({"anthropic-oauth": {"enabled": true}})).await.unwrap();
        *build.credential.lock().unwrap() = credential;
        let outcome = init(&registry, json!({"gemini": {"enabled": false}})).await;
        assert_eq!(outcome.is_ok(), kept, "{credential:?}: an unreadable credential is never a logout, an absent one is");
        if !kept {
            assert_eq!(outcome.unwrap_err().message, NONE_LEFT);
        }
    }
}

#[tokio::test]
async fn an_explicit_opt_out_of_an_oauth_provider_is_not_kept_but_an_unreadable_probe_is() {
    let build = builder(CredentialState::Present);
    let registry = ProviderRegistry::new(build);
    init(&registry, json!({"anthropic-oauth": {"enabled": true}})).await.unwrap();
    let opted_out = init(&registry, json!({"anthropic-oauth": {"enabled": false}})).await;
    assert_eq!(opted_out.expect_err("the user turned it off").code, Some(NO_ENABLED_PROVIDERS));
    let unreadable = init(&registry, json!({"anthropic-oauth": {"enabled": false, "credentialProbeUnavailable": true}})).await;
    assert!(unreadable.is_ok(), "the config only says off because its probe could not read");
}

#[tokio::test]
async fn an_oauth_provider_the_config_enables_is_registered_without_a_credential_check() {
    let registry = ProviderRegistry::new(builder(CredentialState::Absent));
    init(&registry, json!({"anthropic-oauth": {"enabled": true}})).await.unwrap();
    assert!(registry.registered("anthropic-oauth").is_some());
}
