//! The dashboard cache of `provider-usage.mjs`: one cached dashboard, the live-sweep reuse
//! window, and the redeem path that drops the cache.

use std::sync::Arc;
use std::sync::Mutex;

use async_trait::async_trait;
use mixdog_ai::accounts::AccountStore;
use serde_json::Value;
use serde_json::json;

use super::failure::Failure;
use super::usage::dashboard::DashboardOptions;
use super::usage::dashboard::UsageSources;
use super::usage::dashboard::create_usage_dashboard;
use super::usage::now_ms;

/// A sweep that forced every provider live answers a plain refresh for this long.
pub const USAGE_REFRESH_REUSE_MS: i64 = 30_000;

/// The provider setup and display config a dashboard is built over.
#[async_trait]
pub trait SetupSource: Send + Sync {
    /// `cachedProviderSetup({ force, quick })`.
    async fn setup(&self, force: bool, quick: bool) -> Result<Value, String>;
    /// `displayConfig()`: the loaded config, providers with their defaults. `Err` only when a
    /// keychain read never ran.
    async fn display_config(&self) -> Result<Value, String>;
}

#[derive(Default, Clone)]
struct Cache {
    dashboard: Option<Value>,
    at: i64,
    live_at: Option<i64>,
}

pub struct Dashboards {
    setup: Arc<dyn SetupSource>,
    cache: Mutex<Cache>,
}

fn scope_key(options: &Value) -> String {
    let Some(list) = options.get("refreshProviders").and_then(Value::as_array) else { return String::new() };
    let mut ids: Vec<String> = list
        .iter()
        .take(16)
        .map(|v| super::js::clean(Some(v)).to_lowercase())
        .filter(|v| !v.is_empty())
        .collect();
    ids.sort();
    ids.dedup();
    ids.join(",")
}

impl Dashboards {
    pub fn new(setup: Arc<dyn SetupSource>) -> Arc<Self> {
        Arc::new(Self { setup, cache: Mutex::default() })
    }

    fn cache(&self) -> std::sync::MutexGuard<'_, Cache> {
        self.cache.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// Forgets the cached dashboard (a credential change, a redeem).
    pub fn invalidate(&self) {
        *self.cache() = Cache::default();
    }

    fn cached(&self, cache: &Cache) -> Value {
        let mut value = cache.dashboard.clone().unwrap_or_else(|| json!({}));
        value["refresh"] = json!(false);
        value["checking"] = json!(false);
        value["cached"] = json!(true);
        value["cachedAt"] = json!(cache.at);
        value
    }

    pub async fn get(&self, options: &Value, sources: &dyn UsageSources, accounts: &AccountStore) -> Result<Value, Failure> {
        let refresh_usage = options.get("refresh") == Some(&Value::Bool(true));
        let force_setup = options.get("force") == Some(&Value::Bool(true))
            || (refresh_usage && options.get("refreshSetup") != Some(&Value::Bool(false)));
        {
            let cache = self.cache();
            if !force_setup && !refresh_usage && cache.dashboard.is_some() {
                return Ok(self.cached(&cache));
            }
            let scope = scope_key(options);
            if refresh_usage && !force_setup && scope.is_empty() {
                if let (Some(_), Some(live)) = (&cache.dashboard, cache.live_at) {
                    if now_ms() - live < USAGE_REFRESH_REUSE_MS {
                        return Ok(self.cached(&cache));
                    }
                }
            }
        }
        self.build(options, refresh_usage, force_setup, sources, accounts).await
    }

    async fn build(
        &self,
        options: &Value,
        refresh_usage: bool,
        force_setup: bool,
        sources: &dyn UsageSources,
        accounts: &AccountStore,
    ) -> Result<Value, Failure> {
        let scope = scope_key(options);
        let setup = match self.setup.setup(force_setup, false).await {
            Ok(setup) => setup,
            // One unavailable keychain or provider must not take down the dashboard.
            Err(_) => self.setup.setup(force_setup, true).await.map_err(Failure::error)?,
        };
        let dashboard_options = DashboardOptions {
            refresh: refresh_usage,
            refresh_providers: options
                .get("refreshProviders")
                .and_then(Value::as_array)
                .map(|l| l.iter().map(|v| super::js::clean(Some(v))).collect()),
            preview: false,
        };
        let config = self.setup.display_config().await.map_err(Failure::error)?;
        let at = now_ms();
        let dashboard = create_usage_dashboard(&config, &setup, &dashboard_options, at, sources, accounts).await;
        *self.cache() = Cache {
            dashboard: Some(dashboard.clone()),
            at,
            live_at: (refresh_usage && scope.is_empty()).then_some(at),
        };
        Ok(dashboard)
    }

    /// The courtesy rebuild after a redeem: the cache is dropped, then a refresh without a
    /// setup sweep; `None` when it fails.
    pub async fn after_redeem(&self, sources: &dyn UsageSources, accounts: &AccountStore) -> Option<Value> {
        self.invalidate();
        self.get(&json!({ "refresh": true, "refreshSetup": false }), sources, accounts).await.ok()
    }
}
