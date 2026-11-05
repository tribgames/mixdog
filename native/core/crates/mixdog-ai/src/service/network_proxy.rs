//! The `config/getNetworkProxy`, `config/setNetworkProxy` and
//! `config/testNetworkProxy` methods (`settings-network-proxy-api.mjs`):
//! Settings → System → Network proxy. Persisted at the agent config
//! `networkProxy` `{ mode, url, exceptions }`. Every outbound provider path
//! follows the stored value on its next request: a change closes the pooled
//! connections opened under the old one.

use std::sync::Arc;

use async_trait::async_trait;
use serde_json::Map;
use serde_json::Value;

use mixdog_core_api::CoreError;
use mixdog_core_api::CoreRequest;
use mixdog_core_api::DomainService;
use mixdog_core_api::Reply;
use mixdog_core_api::ids::ConnectionId;
use mixdog_core_api::ids::Method;
use mixdog_core_api::service::Admit;

use crate::netproxy::NetworkProxy;
use crate::netproxy::RoutedClients;
use crate::netproxy::RouteError;
use crate::netproxy::diagnostics::check_proxy_connection;
use crate::netproxy::diagnostics::explain_proxy_route;
use crate::netproxy::diagnostics::provider_check_origin;
use crate::netproxy::setting::NetworkProxySetting;
use crate::netproxy::setting::apply_network_proxy_patch;
use crate::netproxy::setting::normalize_network_proxy;

/// The agent config these methods read and write.
#[async_trait]
pub trait NetworkProxyStore: Send + Sync {
    /// The stored `networkProxy` value (`null` when the config has none).
    fn network_proxy(&self) -> Value;
    /// The agent config's `providers` map (`null` when it has none).
    fn providers(&self) -> Value;
    /// Stores `networkProxy` and waits until the config file is written: the
    /// connections of every process follow the stored file.
    async fn save_network_proxy(&self, value: Value) -> Result<(), String>;
}

#[derive(Debug, PartialEq, Eq)]
pub enum NetworkProxyError {
    /// The patch is invalid (`TypeError` text); nothing was stored.
    Invalid(String),
    /// The config could not be written.
    Save(String),
    /// The target is not a URL.
    Route(String),
}

impl std::fmt::Display for NetworkProxyError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            NetworkProxyError::Invalid(message) | NetworkProxyError::Save(message) | NetworkProxyError::Route(message) => {
                f.write_str(message)
            }
        }
    }
}

impl std::error::Error for NetworkProxyError {}

impl From<RouteError> for NetworkProxyError {
    fn from(error: RouteError) -> Self {
        NetworkProxyError::Route(error.to_string())
    }
}

const METHODS: &[&str] = &["config/getNetworkProxy", "config/setNetworkProxy", "config/testNetworkProxy"];

fn core_error(error: NetworkProxyError) -> CoreError {
    match error {
        NetworkProxyError::Invalid(message) => {
            CoreError::InvalidParams { path: "params.patch".into(), expected: message.into() }
        }
        NetworkProxyError::Save(_) => {
            CoreError::DomainError { domain: "config".into(), code: Some("configFailed".into()), message: None, detail: None }
        }
        NetworkProxyError::Route(_) => {
            CoreError::DomainError { domain: "config".into(), code: Some("networkProxyFailed".into()), message: None, detail: None }
        }
    }
}

#[async_trait]
impl DomainService for NetworkProxyService {
    fn methods(&self) -> &'static [&'static str] {
        METHODS
    }

    async fn call(&self, req: CoreRequest) -> Result<Reply, CoreError> {
        let options = req.params.get("options").cloned().unwrap_or(Value::Null);
        let value = match req.method.as_str() {
            "config/getNetworkProxy" => self.get_network_proxy(&options).await,
            "config/testNetworkProxy" => self.test_network_proxy(&options).await,
            "config/setNetworkProxy" => {
                let patch = req.params.get("patch").cloned().unwrap_or(Value::Null);
                self.set_network_proxy(&patch, &options).await
            }
            other => {
                return Err(CoreError::CapabilityUnavailable {
                    capability: other.into(),
                    detail: "not a network proxy method".into(),
                });
            }
        };
        value.map(Reply::Value).map_err(core_error)
    }

    fn notify(&self, _method: Method, _params: Value, _from: ConnectionId) -> Admit {
        Admit::Accepted
    }
}

pub struct NetworkProxyService {
    store: Arc<dyn NetworkProxyStore>,
    policy: Arc<NetworkProxy>,
    clients: Arc<RoutedClients>,
}

fn provider_of(options: &Value) -> Value {
    options.get("provider").cloned().unwrap_or(Value::Null)
}

impl NetworkProxyService {
    pub fn new(store: Arc<dyn NetworkProxyStore>, policy: Arc<NetworkProxy>, clients: Arc<RoutedClients>) -> Self {
        Self { store, policy, clients }
    }

    fn current(&self) -> NetworkProxySetting {
        normalize_network_proxy(&self.store.network_proxy())
    }

    fn origin(&self, options: &Value) -> String {
        provider_check_origin(&provider_of(options), &self.store.providers())
    }

    async fn view(&self, options: &Value) -> Result<Value, NetworkProxyError> {
        let setting = self.current();
        let endpoint = self.origin(options);
        let route = explain_proxy_route(&self.policy, &endpoint, &setting).await?;
        let mut out: Map<String, Value> = setting.to_value();
        out.insert("origin".into(), Value::String(endpoint));
        out.insert("route".into(), route);
        Ok(Value::Object(out))
    }

    /// `{ mode, url, exceptions, origin, route }`; `route` describes the
    /// effective route to the main provider's endpoint.
    pub async fn get_network_proxy(&self, options: &Value) -> Result<Value, NetworkProxyError> {
        self.view(options).await
    }

    /// Patch `{ mode?, url?, exceptions? }`: nothing is stored unless all of it is valid.
    pub async fn set_network_proxy(&self, patch: &Value, options: &Value) -> Result<Value, NetworkProxyError> {
        let next = apply_network_proxy_patch(&self.store.network_proxy(), patch).map_err(NetworkProxyError::Invalid)?;
        let stored = Value::Object(next.to_value());
        self.store.save_network_proxy(stored).await.map_err(NetworkProxyError::Save)?;
        // This process's next request follows it at once (its pooled connections
        // retire here); other processes hear the file's change.
        self.policy.adopt(&self.store.network_proxy());
        self.view(options).await
    }

    /// Connect to the main provider's endpoint through the current policy:
    /// `{ ok, ms, origin, status | code, route }`.
    pub async fn test_network_proxy(&self, options: &Value) -> Result<Value, NetworkProxyError> {
        let origin = self.origin(options);
        Ok(check_proxy_connection(&self.clients, &origin, &self.current()).await?)
    }
}
