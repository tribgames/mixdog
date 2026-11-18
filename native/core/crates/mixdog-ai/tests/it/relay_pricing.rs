//! Pricing of relayed models: a provider that relays other vendors' models (Cursor, Devin, OpenCode Go, ...) is priced at
//! the rate of the vendor that serves the model, never at a guess, and never lends the vendor's limits.

use std::sync::Arc;

use async_trait::async_trait;
use mixdog_ai::catalog::CatalogService;
use mixdog_ai::catalog::CatalogSnapshot;
use mixdog_ai::catalog::LITELLM_CACHE_FILE;
use mixdog_ai::catalog::ModelsDevSource;
use mixdog_ai::catalog::UsageArgs;
use mixdog_ai::oauth::CredentialIo;
use mixdog_ai::transport::Exchange;
use mixdog_ai::transport::HttpResponse;
use mixdog_ai::transport::HttpSend;
use mixdog_core_api::domain::provider::DeliveryState;
use mixdog_core_api::domain::provider::ErrorKind;
use mixdog_core_api::domain::provider::ProviderError;
use mixdog_core_api::domain::provider::WireRequest;
use serde_json::Value;
use serde_json::json;

struct Offline;

#[async_trait]
impl HttpSend for Offline {
    async fn send(&self, _: WireRequest, _: Exchange) -> Result<HttpResponse, ProviderError> {
        Err(ProviderError::new(ErrorKind::Transient, DeliveryState::NotSent))
    }
}

/// A catalog whose only table is this LiteLLM document, read from the disk cache.
async fn catalog(litellm: Value) -> (Arc<CatalogService>, tempfile::TempDir) {
    let dir = tempfile::tempdir().unwrap();
    std::fs::write(dir.path().join(LITELLM_CACHE_FILE), json!({"fetchedAt": 1, "data": litellm}).to_string()).unwrap();
    let tokens = mixdog_rt::testing::tokens();
    let io = || CredentialIo { read: tokens.interactive_io, write: tokens.durability_io };
    let metadata = ModelsDevSource::new(Arc::new(Offline), dir.path().to_path_buf(), io());
    let litellm = ModelsDevSource::litellm(Arc::new(Offline), dir.path().to_path_buf(), io());
    let service = CatalogService::cold_start(CatalogSnapshot::default(), Vec::new(), metadata).await.with_litellm(litellm).await;
    (Arc::new(service), dir)
}

fn table() -> Value {
    json!({
        "claude-relay-test-1": {"litellm_provider": "anthropic", "input_cost_per_token": 3e-06, "output_cost_per_token": 1.5e-05, "cache_read_input_token_cost": 3e-07, "max_input_tokens": 200000, "mode": "chat"},
        "gemini/gemini-relay-test-1": {"litellm_provider": "gemini", "input_cost_per_token": 1e-06, "output_cost_per_token": 4e-06, "max_input_tokens": 1000000, "max_output_tokens": 65536, "mode": "chat"},
    })
}

fn rate(meta: &serde_json::Map<String, Value>, key: &str) -> f64 {
    meta[key].as_f64().unwrap_or_else(|| panic!("{key}: {meta:?}"))
}

#[tokio::test]
async fn a_relayed_model_is_priced_at_the_rate_of_the_vendor_that_serves_it() {
    let (service, _dir) = catalog(table()).await;
    for relay in ["cursor-oauth", "devin-oauth", "opencode-go-oauth"] {
        let meta = service.sync_meta("claude-relay-test-1", relay).unwrap_or_else(|| panic!("{relay} is priced"));
        assert!((rate(&meta, "inputCostPerM") - 3.0).abs() < 1e-9, "{relay}");
        assert!((rate(&meta, "outputCostPerM") - 15.0).abs() < 1e-9, "{relay}");
        assert!((rate(&meta, "cacheReadCostPerM") - 0.3).abs() < 1e-9, "{relay}");
        assert_eq!((meta["pricingSource"].clone(), meta["pricingProvider"].clone()), (json!("litellm"), json!("anthropic")), "{relay}");
    }
    let direct = service.sync_meta("claude-relay-test-1", "anthropic-oauth").expect("the vendor itself");
    assert!((rate(&direct, "inputCostPerM") - 3.0).abs() < 1e-9);
}

#[tokio::test]
async fn a_relayed_price_is_found_under_the_vendor_prefixed_catalog_key_too() {
    let (service, _dir) = catalog(table()).await;
    let meta = service.sync_meta("gemini-relay-test-1", "cursor-oauth").expect("priced through gemini/gemini-relay-test-1");
    assert!((rate(&meta, "inputCostPerM") - 1.0).abs() < 1e-9);
    assert!((rate(&meta, "outputCostPerM") - 4.0).abs() < 1e-9);
    assert_eq!(meta["pricingProvider"], "google", "the vendor is named as the product knows it");
}

#[tokio::test]
async fn a_relayed_model_does_not_inherit_the_vendors_context_or_output_limits() {
    let (service, _dir) = catalog(table()).await;
    let meta = service.sync_meta("gemini-relay-test-1", "cursor-oauth").unwrap();
    assert_eq!((meta["contextWindow"].clone(), meta["outputTokens"].clone()), (Value::Null, Value::Null));
}

#[tokio::test]
async fn an_ordinary_provider_or_a_local_model_is_never_priced_by_a_name_that_resembles_a_vendors() {
    let (service, _dir) = catalog(table()).await;
    assert!(service.sync_meta("claude-relay-test-1", "openai-oauth").is_none());
    assert!(service.sync_meta("claude-relay-test-1", "mixdog-local").is_none());
    assert!(service.sync_meta("kimi-relay-test-1", "cursor-oauth").is_none(), "no vendor claims it");
}

fn usage(provider: &str, model: &str, input: u64) -> UsageArgs {
    serde_json::from_value(json!({"provider": provider, "model": model, "inputTokens": input, "outputTokens": 100_000, "cacheReadTokens": 500_000})).unwrap()
}

#[tokio::test]
async fn a_relayed_turn_costs_what_the_same_turn_costs_on_the_vendor_directly() {
    let (service, _dir) = catalog(table()).await;
    let pricing = service.pricing_unchecked();
    // A relay reports the prompt total with its cached part; the vendor's own API reports the uncached input alone.
    let relayed = pricing.price_usage(&usage("cursor-oauth", "claude-relay-test-1", 1_500_000));
    let direct = pricing.price_usage(&usage("anthropic-oauth", "claude-relay-test-1", 1_000_000));
    assert_eq!(relayed.input, 1_000_000.0);
    // 1M input at $3, 100k output at $15 and 500k cached reads at $0.30 per million.
    assert_eq!(relayed.cost_usd, Some(4.65));
    assert_eq!(direct.cost_usd, Some(4.65));
    assert_eq!(relayed.rates["pricingProvider"], "anthropic");
}

#[tokio::test]
async fn a_model_no_vendor_claims_and_a_local_model_are_unpriced_not_guessed() {
    let (service, _dir) = catalog(table()).await;
    let pricing = service.pricing_unchecked();
    for (provider, model) in [("cursor-oauth", "kimi-relay-test-1"), ("mixdog-local", "claude-relay-test-1")] {
        let priced = pricing.price_usage(&serde_json::from_value(json!({"provider": provider, "model": model, "inputTokens": 1_000_000})).unwrap());
        assert_eq!(priced.cost_usd, None, "{provider}/{model}");
        assert_eq!(priced.input, 1_000_000.0);
        assert_eq!(priced.rates["unpricedReason"], "model-not-found");
        assert_eq!(priced.rates["pricingProvider"], provider);
    }
}
