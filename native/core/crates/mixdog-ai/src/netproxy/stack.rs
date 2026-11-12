//! The daemon's one network stack: the OS proxy decision, the routing policy over it and the
//! routed clients that follow the policy. Built once; the policy goes to `ProcessInputs.network`
//! (every provider link), the policy, the clients and the system proxy to `DomainSeams`.
//!
//! Node's order (`cli.mjs:35` `adoptSystemProxyAsync`, then the `networkProxy` of the config
//! read per request): [`NetworkStack::start`] settles the OS decision, then adopts the stored
//! `networkProxy`; [`NetworkStack::follow`] adopts it again whenever the config changes, which
//! covers this process's own write and another writer's change of the file.

use std::sync::Arc;

use async_trait::async_trait;
use mixdog_core_api::HostCapability;
use mixdog_core_api::HostChannel;
use mixdog_core_api::domain::keepalive::KeepaliveSchedule;
use mixdog_core_api::ids::Method;
use serde_json::Value;
use tokio::sync::watch;
use tokio::task::JoinHandle;

use super::EnvLookup;
use super::NetworkProxy;
use super::ProcessEnv;
use super::RoutedClients;
use super::SystemProxy;
use super::system::HANDOFF_VAR;
use super::system::SystemProxyResolver;
use super::system::WindowsRegistry;
use crate::service::network_proxy::NetworkProxyStore;
use crate::transport::link::routed_builder;

pub struct NetworkStack {
    /// The one policy: `ProcessInputs.network` and `DomainSeams.network_proxy`.
    pub policy: Arc<NetworkProxy>,
    /// The same OS decision the policy asks (a clone shares its state): `DomainSeams.system_proxy`.
    pub system: Arc<SystemProxy>,
    /// `DomainSeams.routed_clients`, the clients of `config/testNetworkProxy`.
    pub clients: Arc<RoutedClients>,
}

impl NetworkStack {
    /// `schedule` is the keepalive schedule of every provider link (`KeepaliveSchedule::SPEC`).
    /// Nothing may go out before [`start`](Self::start): the policy knows no setting until then.
    pub fn new(schedule: KeepaliveSchedule) -> Self {
        let system = SystemProxy::default();
        let policy = NetworkProxy::new(Arc::new(ProcessEnv), system.clone());
        let clients = Arc::new(RoutedClients::new(policy.clone(), routed_builder(schedule, false)));
        Self { policy, system: Arc::new(system), clients }
    }

    /// `adoptSystemProxyAsync(process.env)` then the stored `networkProxy` (`config.agent.networkProxy`,
    /// `Null` when absent). The launching process's handoff is the decision when it set one; the
    /// caller removes `MIXDOG_SYSTEM_PROXY_HANDOFF` from the process environment afterwards, as Node's
    /// `beginAdoption` does (`system-proxy.mjs:462`), so no child inherits it.
    pub async fn start(&self, stored: &Value) {
        let handoff = ProcessEnv.get(HANDOFF_VAR);
        self.system.adopt(&ProcessEnv, handoff.as_deref(), cfg!(windows), &WindowsRegistry).await;
        self.policy.adopt(stored);
    }

    /// Adopts `store.network_proxy()` after every tick of `changes` (`Config::changes()`): the one
    /// path from a changed setting to the policy, which retires the clients itself when the value
    /// differs. Ends when the config is dropped.
    pub fn follow(&self, store: Arc<dyn NetworkProxyStore>, mut changes: watch::Receiver<u64>) -> JoinHandle<()> {
        let policy = Arc::clone(&self.policy);
        tokio::spawn(async move {
            while changes.changed().await.is_ok() {
                policy.adopt(&store.network_proxy());
            }
        })
    }
}

/// The desktop host's answer to a proxy lookup (`host/systemProxy/resolve`, Node's
/// `SYSTEM_PROXY_REQUEST_EVENT` answered by `session.resolveProxy`): the Chromium rules of one origin.
/// Attach it with `stack.system.attach_resolver(Arc::new(HostResolver::new(host)))` when a client
/// claims the host role and keep the returned handle as long as the claim: dropping it detaches.
pub struct HostResolver {
    host: Arc<dyn HostChannel>,
}

impl HostResolver {
    pub fn new(host: Arc<dyn HostChannel>) -> Self {
        Self { host }
    }
}

#[async_trait]
impl SystemProxyResolver for HostResolver {
    async fn resolve(&self, origin: &str) -> Result<String, String> {
        let answer = self
            .host
            .request(HostCapability::SystemProxy, Method("host/systemProxy/resolve"), serde_json::json!({ "url": origin }))
            .await
            .map_err(|error| format!("{error:?}"))?;
        answer.get("rules").and_then(Value::as_str).map(str::to_owned).ok_or_else(|| "no rules in the answer".to_owned())
    }
}

#[cfg(test)]
mod tests {
    use std::sync::Mutex;
    use std::time::Duration;

    use async_trait::async_trait;
    use serde_json::json;

    use super::*;

    struct Store(Mutex<Value>);

    #[async_trait]
    impl NetworkProxyStore for Store {
        fn network_proxy(&self) -> Value {
            self.0.lock().unwrap().clone()
        }
        fn providers(&self) -> Value {
            Value::Null
        }
        async fn save_network_proxy(&self, value: Value) -> Result<(), String> {
            *self.0.lock().unwrap() = value;
            Ok(())
        }
    }

    #[tokio::test(start_paused = true)]
    async fn a_config_change_reaches_the_policy_and_a_changed_setting_moves_its_epoch() {
        let stack = NetworkStack::new(KeepaliveSchedule::SPEC);
        assert!(stack.policy.current().is_err(), "no setting is known before it is adopted");
        let store = Arc::new(Store(Mutex::new(json!({ "mode": "off" }))));
        let (tick, changes) = watch::channel(0u64);
        let task = stack.follow(store.clone(), changes);
        tick.send(1).unwrap();
        mixdog_rt::time::timeout(Duration::from_secs(5), async {
            while stack.policy.current().is_err() {
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
        let epoch = stack.policy.epoch();
        tick.send(2).unwrap();
        store.save_network_proxy(json!({ "mode": "system" })).await.unwrap();
        tick.send(3).unwrap();
        mixdog_rt::time::timeout(Duration::from_secs(5), async {
            while stack.policy.epoch() == epoch {
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
        drop(tick);
        task.await.unwrap();
    }

    struct Desk(Value);

    #[async_trait]
    impl HostChannel for Desk {
        async fn request(
            &self,
            capability: HostCapability,
            method: Method,
            params: Value,
        ) -> Result<Value, mixdog_core_api::HostError> {
            assert_eq!(capability, HostCapability::SystemProxy);
            assert_eq!(method, Method("host/systemProxy/resolve"));
            assert_eq!(params, json!({ "url": "https://api.example.com" }));
            Ok(self.0.clone())
        }

        fn notify(&self, _: HostCapability, _: Method, _: Value) -> Result<(), mixdog_core_api::CoreError> {
            Ok(())
        }
    }

    #[tokio::test]
    async fn the_host_resolver_asks_the_claimant_for_the_rules_of_an_origin() {
        let rules = HostResolver::new(Arc::new(Desk(json!({ "rules": "PROXY 127.0.0.1:7890; DIRECT" }))));
        assert_eq!(rules.resolve("https://api.example.com").await.unwrap(), "PROXY 127.0.0.1:7890; DIRECT");
        let bad = HostResolver::new(Arc::new(Desk(json!({ "other": 1 }))));
        assert!(bad.resolve("https://api.example.com").await.is_err());
    }
}