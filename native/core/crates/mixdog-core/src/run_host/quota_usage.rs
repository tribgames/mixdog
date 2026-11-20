//! The production `QuotaUsage` of the session resume host: Node's `providerQuotaUsable`
//! (`providers/quota-reading.mjs`), the answer a quota resume asks before it fires.
//!
//! In proxy-client mode (`MIXDOG_MODEL_PROXY=client`, read at every call) the PC owns the
//! accounts and answers `quotaUsable` itself; a disconnected PC is `ProxyUnavailable` with the
//! channel's message, so the scheduler defers without spending an attempt. Otherwise one forced
//! usage reading per roster account (or the single credential) is taken by the usage service
//! (`OAuthUsage::fetch_snapshot`, which also records what it measured into the roster) and
//! `quota_measurement_serves_model` decides over the roster as the readings left it.

use std::sync::Arc;

use async_trait::async_trait;
use futures::future::join_all;
use mixdog_ai::accounts::{ACCOUNT_PROVIDERS, AccountStore, Pool};
use mixdog_ai::registry::keys::Environment;
use mixdog_ai::service::admin_models::model_proxy_client_mode;
use mixdog_ai::service::oauth_usage::{OAuthUsage, RouteInfo};
use mixdog_ai::service::quota_usable::{AccountReading, Measurement, quota_measurement_serves_model};
use mixdog_core_session::session::quota_resume_host::QuotaUsage;
use mixdog_core_session::session::quota_resume_scheduler::UsageError;
use serde_json::Value;

/// Why the PC did not answer `quotaUsable`.
#[derive(Debug)]
pub enum ChannelError {
    /// `MODEL_PROXY_UNAVAILABLE`: no client, a client that left, did not pick the call up or
    /// stopped responding. The message is `model proxy unavailable: <detail>`.
    Unavailable(String),
    /// Any other failure of the call (the PC's own error, a cancelled call).
    Failed(String),
}

/// `getModelProxyChannel().request({ provider, method: 'quotaUsable', model })`.
#[async_trait]
pub trait QuotaChannel: Send + Sync {
    async fn quota_usable(&self, provider: &str, model: &str) -> Result<Value, ChannelError>;
}

/// What `measureProviderQuota` reads: the roster, and a forced usage reading.
#[async_trait]
pub trait QuotaReadings: Send + Sync {
    /// `readProviderAccountPool(provider)`.
    async fn pool(&self, provider: &str) -> Result<Pool, String>;
    /// `fetchOAuthUsageSnapshot(route, provider, noop, { force: true })` (a failed reading is `None`).
    async fn forced(&self, route: &RouteInfo) -> Option<Value>;
}

/// The readings of the process: the account store and the usage service.
pub struct UsageReadings {
    pub store: AccountStore,
    pub usage: Arc<OAuthUsage>,
}

#[async_trait]
impl QuotaReadings for UsageReadings {
    async fn pool(&self, provider: &str) -> Result<Pool, String> {
        self.store.pool(provider).await.map_err(|error| error.to_string())
    }

    async fn forced(&self, route: &RouteInfo) -> Option<Value> {
        self.usage.fetch_snapshot(route, true).await
    }
}

/// `measureProviderQuota(provider)`'s answer, owned so a caller may keep it: the model proxy's PC
/// shares one per provider for a window and judges each model against it.
pub enum Measured {
    /// A provider that reports no exhausted quota.
    None,
    /// No roster: the single credential's fresh meter.
    Single { use_credits: bool, reading: Option<Value> },
    /// One forced reading per roster account.
    Roster { use_credits: bool, accounts: Vec<(String, Option<Value>)> },
}

fn route(provider: &str, account_id: &str) -> RouteInfo {
    RouteInfo { provider: provider.to_owned(), model: String::new(), account_id: account_id.to_owned() }
}

/// `measureProviderQuota`: the model-independent, account-wide measurement. Only an account-pooled
/// provider reports exhausted quota at all.
pub async fn measure(readings: &dyn QuotaReadings, provider: &str) -> Result<Measured, String> {
    if !ACCOUNT_PROVIDERS.contains(&provider) {
        return Ok(Measured::None);
    }
    let pool = readings.pool(provider).await?;
    let use_credits = pool.uses_credits();
    if pool.accounts.is_empty() {
        // No roster: the single credential's fresh meter decides.
        let reading = readings.forced(&route(provider, "default")).await;
        return Ok(Measured::Single { use_credits, reading });
    }
    // The routes outlive the futures that borrow them.
    let routes: Vec<RouteInfo> = pool.accounts.iter().map(|row| route(provider, &row.id)).collect();
    let results = join_all(routes.iter().map(|route| readings.forced(route))).await;
    Ok(Measured::Roster { use_credits, accounts: pool.accounts.iter().map(|row| row.id.clone()).zip(results).collect() })
}

/// `quotaMeasurementServesModel(measurement, model)`: the pool's choice is over the roster as the
/// readings left it, so a roster is read again here.
pub async fn serves(readings: &dyn QuotaReadings, provider: &str, measured: &Measured, model: &str, now: i64) -> Result<bool, String> {
    match measured {
        Measured::None => Ok(true),
        Measured::Single { use_credits, reading } => {
            Ok(quota_measurement_serves_model(&Measurement::Single { use_credits: *use_credits, reading: reading.as_ref() }, model, now))
        }
        Measured::Roster { use_credits, accounts } => {
            let after = readings.pool(provider).await?;
            let accounts = accounts.iter().map(|(id, reading)| AccountReading { id, reading: reading.as_ref() }).collect();
            Ok(quota_measurement_serves_model(&Measurement::Roster { use_credits: *use_credits, accounts, pool: &after }, model, now))
        }
    }
}

pub struct ProviderQuotaUsable {
    env: Arc<dyn Environment>,
    channel: Arc<dyn QuotaChannel>,
    readings: Arc<dyn QuotaReadings>,
    now: Arc<dyn Fn() -> i64 + Send + Sync>,
}

impl ProviderQuotaUsable {
    pub fn new(
        env: Arc<dyn Environment>,
        channel: Arc<dyn QuotaChannel>,
        readings: Arc<dyn QuotaReadings>,
        now: Arc<dyn Fn() -> i64 + Send + Sync>,
    ) -> Self {
        Self { env, channel, readings, now }
    }
}

#[async_trait]
impl QuotaUsage for ProviderQuotaUsable {
    async fn usable(&self, provider: &str, model: &str) -> Result<bool, UsageError> {
        // The PC owns the accounts in proxy mode; no server provider is resolved.
        if model_proxy_client_mode(&|name| self.env.var(name)) {
            return match self.channel.quota_usable(provider, model).await {
                Ok(answer) => Ok(answer == Value::Bool(true)),
                Err(ChannelError::Unavailable(message)) => Err(UsageError::ProxyUnavailable(message)),
                Err(ChannelError::Failed(message)) => Err(UsageError::Failed(message)),
            };
        }
        let measured = measure(&*self.readings, provider).await.map_err(UsageError::Failed)?;
        serves(&*self.readings, provider, &measured, model, (self.now)()).await.map_err(UsageError::Failed)
    }
}

#[cfg(test)]
mod tests {

}

