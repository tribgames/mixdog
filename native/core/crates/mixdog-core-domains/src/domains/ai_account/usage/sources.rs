//! The provider quota snapshots a dashboard reads, over the real services: OAuth meters from
//! `OAuthUsage`, "is the provider live" from the registry.

use std::sync::Arc;

use async_trait::async_trait;
use mixdog_ai::accounts::ACCOUNT_PROVIDERS;
use mixdog_ai::accounts::AccountStore;
use mixdog_ai::registry::providers::ProviderRegistry;
use mixdog_ai::service::oauth_usage::OAuthUsage;
use mixdog_ai::service::oauth_usage::RouteInfo;
use serde_json::Value;

use super::dashboard::UsageSources;

/// `api-usage.mjs` (OpenRouter / DeepSeek / xAI balance lookups) has no counterpart in
/// `mixdog-ai`; see the missing-function list in the work report.
#[async_trait]
pub trait ApiUsage: Send + Sync {
    fn cached(&self, provider: &str) -> Option<Value>;
    async fn fetch(&self, provider: &str, force: bool) -> Result<Option<Value>, String>;
}

pub struct ProviderUsageSources {
    oauth: Arc<OAuthUsage>,
    registry: Arc<ProviderRegistry>,
    accounts: AccountStore,
    api: Arc<dyn ApiUsage>,
}

impl ProviderUsageSources {
    pub fn new(
        oauth: Arc<OAuthUsage>,
        registry: Arc<ProviderRegistry>,
        accounts: AccountStore,
        api: Arc<dyn ApiUsage>,
    ) -> Arc<Self> {
        Arc::new(Self { oauth, registry, accounts, api })
    }

    /// `currentProviderAccountId`.
    async fn route(&self, provider: &str) -> RouteInfo {
        let account_id = if ACCOUNT_PROVIDERS.contains(&provider) {
            self.accounts
                .pool(provider)
                .await
                .ok()
                .and_then(|p| p.selected_id)
                .filter(|id| !id.is_empty())
                .unwrap_or_else(|| "default".into())
        } else {
            "default".into()
        };
        RouteInfo { provider: provider.to_owned(), model: String::new(), account_id }
    }
}

#[async_trait]
impl UsageSources for ProviderUsageSources {
    async fn cached_oauth(&self, provider: &str, allow_stale: bool) -> Option<Value> {
        self.oauth.read_cached(&self.route(provider).await, allow_stale).await
    }

    fn oauth_provider_ready(&self, provider: &str) -> bool {
        self.registry.registered(provider).is_some()
    }

    async fn fetch_oauth(&self, provider: &str, force: bool) -> Result<Option<Value>, String> {
        Ok(self.oauth.fetch_snapshot(&self.route(provider).await, force).await)
    }

    fn cached_api(&self, provider: &str) -> Option<Value> {
        self.api.cached(provider)
    }

    async fn fetch_api(&self, provider: &str, force: bool) -> Result<Option<Value>, String> {
        self.api.fetch(provider, force).await
    }
}
