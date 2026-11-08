//! The provider quota snapshots a dashboard reads, over the real services: OAuth meters from
//! `OAuthUsage`, "is the provider live" from the registry.

use std::sync::Arc;

use async_trait::async_trait;
use mixdog_ai::accounts::ACCOUNT_PROVIDERS;
use mixdog_ai::accounts::AccountStore;
use mixdog_ai::registry::providers::ProviderRegistry;
use mixdog_ai::service::admin_route::clean;
use mixdog_ai::service::oauth_usage::OAuthUsage;
use mixdog_core_api::ids::ThreadId;
use mixdog_core_ports::ports::route::Route;
use mixdog_core_ports::ports::route_write::StatuslineUsage;
use crate::domains::ai_admin::statusline_warmup::StatuslineSink;
use mixdog_ai::service::api_usage::ApiUsageService;
use mixdog_ai::service::oauth_usage::RouteInfo;
use serde_json::Value;

use super::dashboard::UsageSources;

/// `api-usage.mjs`: the balance lookups of DeepSeek, OpenAI, Anthropic, Gemini and xAI
/// (`mixdog_ai::service::api_usage::ApiUsageService`).
#[async_trait]
pub trait ApiUsage: Send + Sync {
    async fn cached(&self, provider: &str) -> Option<Value>;
    async fn fetch(&self, provider: &str, force: bool) -> Result<Option<Value>, String>;
}

/// The real lookups of `api-usage.mjs`.
#[async_trait]
impl ApiUsage for ApiUsageService {
    async fn cached(&self, provider: &str) -> Option<Value> {
        ApiUsageService::cached(self, provider, true).await
    }

    async fn fetch(&self, provider: &str, force: bool) -> Result<Option<Value>, String> {
        ApiUsageService::fetch(self, provider, force).await.map_err(|error| error.message)
    }
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
        current_route(&self.accounts, provider).await
    }
}

/// `currentProviderAccountId`: the roster's selected account, `default` without one.
async fn current_route(accounts: &AccountStore, provider: &str) -> RouteInfo {
    let account_id = if ACCOUNT_PROVIDERS.contains(&provider) {
        accounts.pool(provider).await.ok().and_then(|p| p.selected_id).filter(|id| !id.is_empty()).unwrap_or_else(|| "default".into())
    } else {
        "default".into()
    };
    RouteInfo { provider: provider.to_owned(), model: String::new(), account_id }
}

/// `refreshStatuslineUsageSnapshot(route)`: the provider and model whose reading a route change
/// refreshes, or `None` when it refreshes nothing (not an OAuth provider, or one the registry does
/// not hold).
pub fn statusline_target(route: &Route, registered: &dyn Fn(&str) -> bool) -> Option<(String, String)> {
    let provider = clean(route.get("provider"));
    let model = clean(route.get("model"));
    (provider.contains("oauth") && registered(&provider)).then_some((provider, model))
}

/// The route change's refresh of the statusline reading: the usage service measures the route's
/// account in the background, a failure dropped.
impl StatuslineUsage for ProviderUsageSources {
    fn refresh(&self, _thread: &ThreadId, route: &Route) {
        self.refresh_route_now(route);
    }
}

/// The statusline warm-up's refresh of the route it prepared (`refreshStatuslineUsageSnapshot(route)`).
impl StatuslineSink for ProviderUsageSources {
    fn refresh_route(&self, route: &Route) {
        self.refresh_route_now(route);
    }
}

impl ProviderUsageSources {
    fn refresh_route_now(&self, route: &Route) {
        let Some((provider, model)) = statusline_target(route, &|name| self.registry.registered(name).is_some()) else { return };
        let (oauth, accounts) = (self.oauth.clone(), self.accounts.clone());
        drop(mixdog_rt::spawn("statusline-usage", mixdog_rt::TaskClass::Work, async move {
            let mut route = current_route(&accounts, &provider).await;
            route.model = model;
            let _ = oauth.fetch_snapshot(&route, false).await;
        }));
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

    async fn cached_api(&self, provider: &str) -> Option<Value> {
        self.api.cached(provider).await
    }

    async fn fetch_api(&self, provider: &str, force: bool) -> Result<Option<Value>, String> {
        self.api.fetch(provider, force).await
    }
}

#[cfg(test)]
#[path = "statusline_tests.rs"]
mod statusline_tests;
