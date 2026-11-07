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

fn route(provider: &str, account_id: &str) -> RouteInfo {
    RouteInfo { provider: provider.to_owned(), model: String::new(), account_id: account_id.to_owned() }
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
        // Only an account-pooled provider reports exhausted quota at all.
        if !ACCOUNT_PROVIDERS.contains(&provider) {
            return Ok(true);
        }
        let failed = UsageError::Failed;
        let pool = self.readings.pool(provider).await.map_err(failed)?;
        let use_credits = pool.uses_credits();
        if pool.accounts.is_empty() {
            // No roster: the single credential's fresh meter decides.
            let reading = self.readings.forced(&route(provider, "default")).await;
            let measurement = Measurement::Single { use_credits, reading: reading.as_ref() };
            return Ok(quota_measurement_serves_model(&measurement, model, (self.now)()));
        }
        // The routes outlive the futures that borrow them.
        let routes: Vec<RouteInfo> = pool.accounts.iter().map(|row| route(provider, &row.id)).collect();
        let results = join_all(routes.iter().map(|route| self.readings.forced(route))).await;
        // The readings recorded what they measured: the pool's choice is over the roster as they left it.
        let after = self.readings.pool(provider).await.map_err(UsageError::Failed)?;
        let accounts = pool.accounts.iter().zip(&results).map(|(row, reading)| AccountReading { id: &row.id, reading: reading.as_ref() }).collect();
        let measurement = Measurement::Roster { use_credits, accounts, pool: &after };
        Ok(quota_measurement_serves_model(&measurement, model, (self.now)()))
    }
}

#[cfg(test)]
mod tests {
    use std::sync::Mutex;

    use serde_json::json;

    use super::*;

    const TWIN: &str = include_str!("../../../../fixtures/quota-usable/quota-usable-twin.json");

    struct Vars(Option<&'static str>);

    impl Environment for Vars {
        fn var(&self, name: &str) -> Option<String> {
            (name == "MIXDOG_MODEL_PROXY").then(|| self.0.map(str::to_owned)).flatten()
        }
    }

    /// Answers `quotaUsable` as the recorded PC channel did.
    struct Channel(Mutex<Vec<(String, String)>>, Result<Value, (bool, String)>);

    #[async_trait]
    impl QuotaChannel for Channel {
        async fn quota_usable(&self, provider: &str, model: &str) -> Result<Value, ChannelError> {
            self.0.lock().unwrap().push((provider.to_owned(), model.to_owned()));
            match &self.1 {
                Ok(value) => Ok(value.clone()),
                Err((true, message)) => Err(ChannelError::Unavailable(message.clone())),
                Err((false, message)) => Err(ChannelError::Failed(message.clone())),
            }
        }
    }

    /// The recorded roster reads and forced readings, answered in order.
    struct Replay {
        case: Value,
        step: Mutex<usize>,
        reads: Mutex<usize>,
    }

    #[async_trait]
    impl QuotaReadings for Replay {
        async fn pool(&self, provider: &str) -> Result<Pool, String> {
            assert_eq!(provider, self.case["provider"]);
            let mut reads = self.reads.lock().unwrap();
            let key = if *reads == 0 { "poolBefore" } else { "poolAfter" };
            // The roster is read again only after readings were taken.
            assert!(*reads == 0 || *self.step.lock().unwrap() == self.case["calls"].as_array().unwrap().len(), "{}", self.case);
            *reads += 1;
            Ok(serde_json::from_value(self.case[key].clone()).unwrap())
        }

        async fn forced(&self, route: &RouteInfo) -> Option<Value> {
            let mut step = self.step.lock().unwrap();
            let call = &self.case["calls"][*step];
            *step += 1;
            assert_eq!((route.provider.as_str(), route.model.as_str(), route.account_id.as_str()), (self.case["provider"].as_str().unwrap(), "", call["account"].as_str().unwrap()), "{}", self.case);
            // A reading that threw is the same as one that measured nothing.
            Some(call["answer"].clone()).filter(|answer| answer.is_object())
        }
    }

    #[tokio::test]
    async fn the_readings_decide_as_nodes_provider_quota_usable() {
        let twin: Value = serde_json::from_str(TWIN).unwrap();
        let cases = twin["cases"].as_array().unwrap();
        assert!(cases.len() > 500);
        for case in cases {
            let replay = Arc::new(Replay { case: case.clone(), step: Mutex::new(0), reads: Mutex::new(0) });
            let channel = Arc::new(Channel(Mutex::default(), Ok(Value::Null)));
            let now = case["now"].as_i64().unwrap();
            let usage = ProviderQuotaUsable::new(Arc::new(Vars(None)), channel.clone(), replay.clone(), Arc::new(move || now));
            let got = usage.usable(case["provider"].as_str().unwrap(), case["model"].as_str().unwrap()).await;
            assert_eq!(got, Ok(case["value"].as_bool().unwrap()), "{case}");
            assert_eq!(*replay.step.lock().unwrap(), case["calls"].as_array().unwrap().len(), "readings left over: {case}");
            assert!(channel.0.lock().unwrap().is_empty(), "the PC is not asked outside proxy mode");
        }
    }

    #[tokio::test]
    async fn the_pc_answers_and_a_disconnected_pc_reports_as_node_does() {
        let twin: Value = serde_json::from_str(TWIN).unwrap();
        let cases = twin["proxy"].as_array().unwrap();
        assert!(cases.len() > 70);
        let never = Arc::new(Replay { case: json!({}), step: Mutex::new(0), reads: Mutex::new(0) });
        for case in cases {
            let name = case["name"].as_str().unwrap();
            let answer = match case.get("error") {
                Some(error) => Err((error["code"] == "MODEL_PROXY_UNAVAILABLE", error["message"].as_str().unwrap().to_owned())),
                None => Ok(name.strip_prefix("PC answers ").map_or(Value::Null, |raw| serde_json::from_str(raw).unwrap())),
            };
            let channel = Arc::new(Channel(Mutex::default(), answer));
            let usage = ProviderQuotaUsable::new(Arc::new(Vars(Some("client"))), channel.clone(), never.clone(), Arc::new(|| 0));
            let (provider, model) = (case["provider"].as_str().unwrap(), case["model"].as_str().unwrap());
            let got = usage.usable(provider, model).await;
            match case.get("error") {
                None => assert_eq!(got, Ok(case["value"].as_bool().unwrap()), "{case}"),
                Some(error) if error["code"] == "MODEL_PROXY_UNAVAILABLE" => assert_eq!(got, Err(UsageError::ProxyUnavailable(error["message"].as_str().unwrap().to_owned())), "{case}"),
                Some(error) => assert_eq!(got, Err(UsageError::Failed(error["message"].as_str().unwrap().to_owned())), "{case}"),
            }
            assert_eq!(*channel.0.lock().unwrap(), vec![(provider.to_owned(), model.to_owned())], "{case}");
            // A call refused at once (no client) is never published to anyone.
            let published = case["published"].as_array().unwrap();
            assert!(published.is_empty() || *published == [json!({ "provider": provider, "method": "quotaUsable", "model": model })], "{case}");
        }
        assert_eq!(*never.step.lock().unwrap(), 0, "proxy mode reads no roster");
    }
}