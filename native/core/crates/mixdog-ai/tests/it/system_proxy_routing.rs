//! The system proxy: the registry decision routes every origin until a desktop app attaches its own resolver, which then
//! decides per origin; when the app leaves, the registry decision applies again.

use std::sync::Arc;

use async_trait::async_trait;
use mixdog_ai::netproxy::EnvLookup;
use mixdog_ai::netproxy::SystemProxy;
use mixdog_ai::netproxy::system::RegistryReader;
use mixdog_ai::netproxy::system::RegistryValues;
use mixdog_ai::netproxy::system::SystemProxyResolver;

struct NoEnv;

impl EnvLookup for NoEnv {
    fn get(&self, _: &str) -> Option<String> {
        None
    }
}

struct Registry;

#[async_trait]
impl RegistryReader for Registry {
    async fn read(&self) -> Option<RegistryValues> {
        Some(RegistryValues {
            proxy_enable: Some("0x1".into()),
            proxy_server: Some("registry.example:3128".into()),
            proxy_override: Some("*.corp.example".into()),
            auto_config_url: None,
        })
    }
}

/// A desktop that routes the intranet direct, one origin through a SOCKS-only rule, and the rest through its proxy.
struct Desktop;

#[async_trait]
impl SystemProxyResolver for Desktop {
    async fn resolve(&self, origin: &str) -> Result<String, String> {
        Ok(if origin.contains("intranet") {
            "DIRECT"
        } else if origin.contains("socks") {
            "SOCKS5 10.0.0.1:1080"
        } else {
            "PROXY 127.0.0.1:7890; DIRECT"
        }
        .to_owned())
    }
}

async fn adopted() -> SystemProxy {
    let system = SystemProxy::new(Arc::new(|_: &str| {}));
    assert!(system.adopt(&NoEnv, None, true, &Registry).await, "the registry names a proxy");
    system
}

#[tokio::test]
async fn without_an_app_the_registry_proxy_routes_except_its_excepted_hosts() {
    let system = adopted().await;
    assert_eq!(system.route("https://api.openai.com").await.proxy.as_deref(), Some("http://registry.example:3128"));
    assert_eq!(system.route("https://intranet.corp.example").await.proxy, None, "excepted by the registry override");
}

#[tokio::test]
async fn an_attached_app_decides_each_origin_and_its_departure_restores_the_registry_decision() {
    let system = adopted().await;
    let claim = system.attach_resolver(Arc::new(Desktop));
    assert_eq!(system.route("https://api.openai.com").await.proxy.as_deref(), Some("http://127.0.0.1:7890"));
    assert_eq!(system.route("https://intranet.corp.example").await.proxy, None, "the app says DIRECT");
    assert_eq!(system.route("https://socks.example").await.proxy, None, "a SOCKS-only answer goes direct");
    drop(claim);
    assert_eq!(system.route("https://api.openai.com").await.proxy.as_deref(), Some("http://registry.example:3128"));
}

#[tokio::test]
async fn a_user_set_proxy_variable_leaves_the_system_proxy_unused() {
    struct UserProxy;
    impl EnvLookup for UserProxy {
        fn get(&self, name: &str) -> Option<String> {
            (name == "HTTPS_PROXY").then(|| "http://mine:1".to_owned())
        }
    }
    let system = SystemProxy::new(Arc::new(|_: &str| {}));
    assert!(!system.adopt(&UserProxy, None, true, &Registry).await);
    assert_eq!(system.route("https://api.openai.com").await.proxy, None);
}
