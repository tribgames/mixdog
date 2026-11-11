//! Replay of `native/core/fixtures/system-proxy-cases` (Node `apps/desktop/src/main/system-proxy.test.mjs` at
//! b6f10295a), case "an attached app routes the daemon per origin; when it leaves the fallback applies again": the
//! registry fallback adopted by [`SystemProxy::adopt`], the desktop's resolver attached as a claim attaches it
//! (`SystemProxyClaims::claimed`: [`SystemProxy::attach_resolver`] over a [`HostResolver`] that asks
//! `host/systemProxy/resolve`), the per-origin routes, and the fallback again once the claim's handle drops.
//! Cases 0-2 run the desktop window's own code and are declared in the manifest's `replay.declaredExclusions`.

use std::sync::Arc;
use std::sync::Mutex;

use async_trait::async_trait;
use mixdog_core_api::CoreError;
use mixdog_core_api::HostCapability;
use mixdog_core_api::HostChannel;
use mixdog_core_api::HostError;
use mixdog_core_api::ids::Method;
use mixdog_testkit::exact::Exact;
use serde_json::Value;
use serde_json::json;

use super::EnvLookup;
use super::stack::HostResolver;
use super::system::RegistryReader;
use super::system::RegistryValues;
use super::system::SystemProxy;
use super::system::SystemRoute;

const GOLDEN: mixdog_testkit::Fixture = mixdog_testkit::fixture_const!("../../fixtures/system-proxy-cases/golden.json");
const CASE: &str = "an attached app routes the daemon per origin; when it leaves the fallback applies again";

struct NoEnv;

impl EnvLookup for NoEnv {
    fn get(&self, _: &str) -> Option<String> {
        None
    }
}

/// The recording's scripted registry reader.
struct Registry(Value);

#[async_trait]
impl RegistryReader for Registry {
    async fn read(&self) -> Option<RegistryValues> {
        let text = |key: &str| self.0[key].as_str().map(str::to_owned);
        Some(RegistryValues {
            proxy_enable: text("proxyEnable"),
            proxy_server: text("proxyServer"),
            proxy_override: text("proxyOverride"),
            auto_config_url: None,
        })
    }
}

/// The desktop that claimed the host role: answers `host/systemProxy/resolve` with the recording's Chromium rules.
struct Desktop {
    pac: Value,
    otherwise: String,
    asked: Mutex<Vec<String>>,
}

#[async_trait]
impl HostChannel for Desktop {
    async fn request(&self, capability: HostCapability, method: Method, params: Value) -> Result<Value, HostError> {
        assert_eq!((capability, method.0), (HostCapability::SystemProxy, "host/systemProxy/resolve"));
        let origin = params["url"].as_str().expect("the lookup names its origin").to_owned();
        let host = url::Url::parse(&origin).expect("an origin").host_str().unwrap_or_default().to_owned();
        self.asked.lock().unwrap().push(origin);
        let rules = self.pac[host.as_str()].as_str().unwrap_or(&self.otherwise).to_owned();
        Ok(json!({ "rules": rules }))
    }

    fn notify(&self, capability: HostCapability, method: Method, _: Value) -> Result<(), CoreError> {
        panic!("the lookup sends no notification ({capability:?} {})", method.0)
    }
}

fn route_view(route: SystemRoute) -> Value {
    json!({ "proxy": route.proxy })
}

#[tokio::test]
async fn an_attached_desktop_routes_per_origin_and_its_departure_restores_the_fallback() {
    let golden: Value = serde_json::from_str(&GOLDEN).unwrap();
    let recorded = Exact::decode(&golden).unwrap();
    let case = recorded.get("cases").as_array().iter().find(|c| c.get("case").as_str() == CASE).expect("the case is recorded");
    let observed = case.get("observed");
    let registry = observed.get("registry").to_plain().unwrap();
    let pac = observed.get("pac").to_plain().unwrap();
    let otherwise = observed.get("otherwise").as_str().to_owned();

    let system = SystemProxy::new(Arc::new(|_: &str| {}));
    system.adopt(&NoEnv, None, true, &Registry(registry.clone())).await;
    let desktop = Arc::new(Desktop { pac: pac.clone(), otherwise: otherwise.clone(), asked: Mutex::new(Vec::new()) });
    let mut log = Vec::new();
    let origin = "https://api.openai.com";
    log.push(json!({ "step": "before attach, registry fallback", "origin": origin, "route": route_view(system.route(origin).await) }));
    let claim = system.attach_resolver(Arc::new(HostResolver::new(desktop.clone())));
    for origin in ["https://api.openai.com", "https://intranet.corp.example", "https://api.anthropic.com"] {
        log.push(json!({ "step": "attached", "origin": origin, "route": route_view(system.route(origin).await) }));
    }
    drop(claim);
    let origin = "https://intranet.corp.example";
    log.push(json!({ "step": "released, fallback again", "origin": origin, "route": route_view(system.route(origin).await) }));
    let asked = desktop.asked.lock().unwrap().clone();
    let replayed = json!({ "registry": registry, "pac": pac, "otherwise": otherwise, "chromiumAskedFor": asked, "log": log });
    assert_eq!(&Exact::plain(&replayed), observed);
}
