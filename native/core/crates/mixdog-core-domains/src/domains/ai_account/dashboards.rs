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
        self.get_at(options, sources, accounts, now_ms()).await
    }

    /// [`get`](Self::get) at the clock reading `now` (`Date.now()`): the sweep-reuse window and the dashboard's
    /// `checkedAt` are measured on it.
    pub async fn get_at(&self, options: &Value, sources: &dyn UsageSources, accounts: &AccountStore, now: i64) -> Result<Value, Failure> {
        self.answer(options, sources, accounts, now, true).await
    }

    /// [`get_at`](Self::get_at) for the core's own reading (the `usage` section producer): it may reuse the cached dashboard
    /// but never stores what it builds. Node's cache is filled only by a client's question, so a client's first plain question
    /// builds and answers without `cached` even though the producer has already published a dashboard.
    pub async fn read_at(&self, options: &Value, sources: &dyn UsageSources, accounts: &AccountStore, now: i64) -> Result<Value, Failure> {
        self.answer(options, sources, accounts, now, false).await
    }

    async fn answer(&self, options: &Value, sources: &dyn UsageSources, accounts: &AccountStore, now: i64, remember: bool) -> Result<Value, Failure> {
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
                    if now - live < USAGE_REFRESH_REUSE_MS {
                        return Ok(self.cached(&cache));
                    }
                }
            }
        }
        let dashboard = self.build(options, refresh_usage, force_setup, sources, accounts, now).await?;
        if remember {
            *self.cache() = Cache {
                dashboard: Some(dashboard.clone()),
                at: now,
                live_at: (refresh_usage && scope_key(options).is_empty()).then_some(now),
            };
        }
        Ok(dashboard)
    }

    async fn build(
        &self,
        options: &Value,
        refresh_usage: bool,
        force_setup: bool,
        sources: &dyn UsageSources,
        accounts: &AccountStore,
        at: i64,
    ) -> Result<Value, Failure> {
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
        Ok(create_usage_dashboard(&config, &setup, &dashboard_options, at, sources, accounts).await)
    }

    /// The courtesy rebuild after a redeem: the cache is dropped, then a refresh without a
    /// setup sweep; `None` when it fails.
    pub async fn after_redeem(&self, sources: &dyn UsageSources, accounts: &AccountStore) -> Option<Value> {
        self.invalidate();
        self.get(&json!({ "refresh": true, "refreshSetup": false }), sources, accounts).await.ok()
    }
}
