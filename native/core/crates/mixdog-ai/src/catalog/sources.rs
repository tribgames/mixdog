use std::sync::Arc;

use async_trait::async_trait;
use mixdog_core_api::domain::provider::ProviderError;
use mixdog_protocol::JsonValue;
use mixdog_protocol::ProviderId;

use super::record::ModelRecord;

/// One provider's model listing (an adapter's `list_models`, or a static set).
#[async_trait]
pub trait ModelSource: Send + Sync {
    fn provider(&self) -> &ProviderId;
    async fn list(&self) -> Result<Vec<ModelRecord>, ProviderError>;
}

#[derive(Clone, Debug)]
pub struct ProviderEntry {
    pub id: ProviderId,
    pub enabled: bool,
    /// The provider's settings exactly as configured, API keys included.
    pub settings: JsonValue,
}

/// The provider configuration as loaded, secrets included. The only input of
/// [`build_sources`]; a redacted view for display or logs is a separate type
/// with no conversion to this one.
#[derive(Clone, Debug)]
pub struct FullProviderConfig {
    pub providers: Vec<ProviderEntry>,
}

/// Builds the listing source of one provider from its full entry.
pub trait SourceFactory: Send + Sync {
    fn source(&self, entry: &ProviderEntry) -> Option<Arc<dyn ModelSource>>;
}

/// One source per enabled provider the factory knows.
pub fn build_sources(
    config: &FullProviderConfig,
    factory: &dyn SourceFactory,
) -> Vec<Arc<dyn ModelSource>> {
    config
        .providers
        .iter()
        .filter(|entry| entry.enabled)
        .filter_map(|entry| factory.source(entry))
        .collect()
}