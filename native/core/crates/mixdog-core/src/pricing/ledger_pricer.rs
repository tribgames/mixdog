//! The ledger's price table over the model catalog. `mixdog-ai` and
//! `mixdog-ledger` do not depend on each other; this adapter joins them.

use std::sync::Arc;

use mixdog_ai::catalog::CatalogService;
use mixdog_ai::catalog::ColdCatalog;
use mixdog_ai::catalog::PricingCatalog;
use mixdog_ai::catalog::UsageArgs;
use mixdog_ledger::refresh::Pricer;
use mixdog_ledger::repair::PriceRequest;
use mixdog_ledger::repair::Priced;

/// A [`Pricer`] that exists only for a loaded catalog: a cold one cannot be
/// wrapped, so the refresh never stamps an empty revision as checked.
#[derive(Clone)]
pub struct CatalogPricer {
    catalog: PricingCatalog,
}

impl CatalogPricer {
    /// Fails with [`ColdCatalog`] until both price tables are resident.
    pub fn new(service: &Arc<CatalogService>) -> Result<Self, ColdCatalog> {
        Ok(Self { catalog: service.pricing()? })
    }
}

impl Pricer for CatalogPricer {
    fn revision(&self) -> String {
        self.catalog.revision()
    }

    fn price(&self, request: &PriceRequest) -> mixdog_ledger::error::Result<Priced> {
        let priced = self.catalog.price_usage(&UsageArgs {
            provider: request.provider.clone(),
            model: request.model.clone(),
            requested_model: request.requested_model.clone(),
            pricing_model: request.pricing_model.clone(),
            input_tokens_known: request.input_tokens_known,
            uncached_input_tokens: Some(request.uncached_input_tokens),
            output_tokens: request.output_tokens,
            cache_read_tokens: request.cache_read_tokens,
            cache_write_tokens: request.cache_write_tokens,
            cache_write_1h_tokens: request.cache_write_1h_tokens.unwrap_or(0.0),
            request_service_tier: request.request_service_tier.clone(),
            service_tier: request.service_tier.clone(),
            kind: Some(request.kind.clone()),
            ts: Some(request.ts as f64),
            historical: request.historical,
            ..UsageArgs::default()
        });
        Ok(Priced { cost_usd: priced.cost_usd, rates: Some(priced.rates_json()) })
    }
}

#[cfg(test)]
mod tests {
    use mixdog_ai::catalog::CatalogSnapshot;
    use mixdog_ai::catalog::ModelsDevSource;
    use mixdog_ai::catalog::LITELLM_CACHE_FILE;
    use mixdog_ai::catalog::MODELS_DEV_CACHE_FILE;
    use mixdog_ai::oauth::CredentialIo;
    use mixdog_ai::transport::http::HttpResponse;
    use mixdog_ai::transport::http::HttpSend;
    use mixdog_core_api::domain::provider::DeliveryState;
    use mixdog_core_api::domain::provider::ErrorKind;
    use mixdog_core_api::domain::provider::ProviderError;
    use mixdog_core_api::domain::provider::WireRequest;

    use super::*;

    struct Offline;
    #[async_trait::async_trait]
    impl HttpSend for Offline {
        async fn send(&self, _: WireRequest) -> Result<HttpResponse, ProviderError> {
            Err(ProviderError::new(ErrorKind::Transient, DeliveryState::NotSent))
        }
    }

    fn io() -> CredentialIo {
        let tokens = mixdog_rt::testing::tokens();
        CredentialIo { read: tokens.interactive_io, write: tokens.durability_io }
    }

    async fn catalog(dir: &std::path::Path) -> Arc<CatalogService> {
        let metadata = ModelsDevSource::new(Arc::new(Offline), dir.to_path_buf(), io());
        let litellm = ModelsDevSource::litellm(Arc::new(Offline), dir.to_path_buf(), io());
        Arc::new(CatalogService::cold_start(CatalogSnapshot::default(), Vec::new(), metadata).await.with_litellm(litellm).await)
    }

    #[tokio::test]
    async fn a_pricer_exists_only_for_a_warm_catalog_and_prices_like_the_catalog() {
        let dir = tempfile::tempdir().unwrap();
        assert!(CatalogPricer::new(&catalog(dir.path()).await).is_err(), "cold");

        let row = r#"{"fetchedAt":1,"data":{"gpt-x":{"litellm_provider":"openai","mode":"chat","input_cost_per_token":0.000001,"output_cost_per_token":0.000002}}}"#;
        std::fs::write(dir.path().join(LITELLM_CACHE_FILE), row).unwrap();
        std::fs::write(dir.path().join(MODELS_DEV_CACHE_FILE), r#"{"fetchedAt":1,"data":{}}"#).unwrap();
        let service = catalog(dir.path()).await;
        let pricer = CatalogPricer::new(&service).expect("warm");
        assert_eq!(pricer.revision(), service.pricing().unwrap().revision());
        assert!(!pricer.revision().is_empty());

        let request = PriceRequest {
            provider: "openai".into(),
            model: "gpt-x".into(),
            pricing_model: None,
            requested_model: None,
            input_tokens_known: None,
            uncached_input_tokens: 1000.0,
            output_tokens: 500.0,
            cache_read_tokens: 0.0,
            cache_write_tokens: 0.0,
            cache_write_1h_tokens: None,
            request_service_tier: None,
            service_tier: None,
            kind: "api".into(),
            ts: 1_800_000_000_000,
            historical: true,
        };
        let got = pricer.price(&request).unwrap();
        let direct = service.pricing().unwrap().price_usage(&UsageArgs {
            provider: "openai".into(),
            model: "gpt-x".into(),
            uncached_input_tokens: Some(1000.0),
            output_tokens: 500.0,
            kind: Some("api".into()),
            ts: Some(1_800_000_000_000.0),
            historical: true,
            ..UsageArgs::default()
        });
        assert_eq!(got.cost_usd, direct.cost_usd);
        assert_eq!(got.rates.as_deref(), Some(direct.rates_json().as_str()));
    }
}
