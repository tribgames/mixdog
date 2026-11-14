//! One HTTP client per route, kept for reuse (`createRoutedProxyDispatcher` in
//! `http-agent.mjs`). Each request asks the policy for its origin's route and
//! rides the direct client or the client of the chosen proxy; a change of the
//! setting retires every client (in-flight requests finish on theirs, idle
//! connections close), so a pooled connection opened under the old setting is
//! never reused.

use std::collections::HashMap;
use std::sync::Arc;
use std::sync::Mutex;
use std::sync::PoisonError;

use url::Url;

use super::NetworkProxy;
use super::Subscription;
use super::route::RouteError;

type Legs = Arc<Mutex<HashMap<Option<String>, reqwest::Client>>>;
type Build = Box<dyn Fn(Option<&str>) -> Result<reqwest::Client, reqwest::Error> + Send + Sync>;

#[derive(Debug)]
pub enum ClientError {
    /// The policy could not decide: the request fails, it never goes direct.
    Route(RouteError),
    Build(reqwest::Error),
}

impl std::fmt::Display for ClientError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            ClientError::Route(error) => error.fmt(f),
            ClientError::Build(error) => error.fmt(f),
        }
    }
}

impl std::error::Error for ClientError {}

/// The proxy as `reqwest` must be given it. `socks5://` makes reqwest resolve
/// the destination itself and hand the proxy an address; Node's SOCKS client
/// sends the hostname, which is `socks5h://`.
fn reqwest_proxy_uri(uri: &str) -> String {
    match uri.strip_prefix("socks5:") {
        Some(rest) => format!("socks5h:{rest}"),
        None => uri.to_owned(),
    }
}

pub struct RoutedClients {
    policy: Arc<NetworkProxy>,
    build: Build,
    legs: Legs,
    flavours: Mutex<HashMap<&'static str, reqwest::Client>>,
    _retire: Subscription,
}

impl RoutedClients {
    /// `build(None)` makes the direct client (it must ignore the environment's
    /// proxy variables); `build(Some(uri))` the client of one proxy, `uri` in
    /// the form `reqwest` takes (a SOCKS5 proxy is `socks5h:`).
    pub fn new(
        policy: Arc<NetworkProxy>,
        build: impl Fn(Option<&str>) -> Result<reqwest::Client, reqwest::Error> + Send + Sync + 'static,
    ) -> Self {
        let legs: Legs = Arc::default();
        let weak = Arc::downgrade(&legs);
        let retire = policy.on_change(Arc::new(move |_| {
            if let Some(legs) = weak.upgrade() {
                legs.lock().unwrap_or_else(PoisonError::into_inner).clear();
            }
        }));
        let build = move |proxy: Option<&str>| build(proxy.map(reqwest_proxy_uri).as_deref());
        Self { policy, build: Box::new(build), legs, flavours: Mutex::default(), _retire: retire }
    }

    /// The direct client of a flavour the routed builder does not make, built by `build` on first
    /// use and kept here. For a caller whose connections need a check of their own that a pooled
    /// routed client cannot carry (the public-address guard's name resolver). It never rides a
    /// proxy, so no route is asked and a change of the setting leaves it alone: Node's
    /// `pinnedFetch` connects through an agent of its own, bypassing the routed dispatcher.
    pub fn direct_flavour(
        &self,
        flavour: &'static str,
        build: impl FnOnce() -> Result<reqwest::Client, reqwest::Error>,
    ) -> Result<reqwest::Client, ClientError> {
        let mut kept = self.flavours.lock().unwrap_or_else(PoisonError::into_inner);
        if let Some(client) = kept.get(flavour) {
            return Ok(client.clone());
        }
        let client = build().map_err(ClientError::Build)?;
        kept.insert(flavour, client.clone());
        Ok(client)
    }

    pub fn policy(&self) -> &Arc<NetworkProxy> {
        &self.policy
    }

    /// A client for one download from `url`: it rides the route the policy gives the origin (direct, or the
    /// proxy, a system proxy included) and, unlike the pooled routed clients, follows redirects (a model
    /// host answers with one to its CDN). Built for the request and kept nowhere.
    pub async fn download_client_for(&self, url: &str) -> Result<reqwest::Client, ClientError> {
        let target = Url::parse(url).map_err(|_| ClientError::Route(RouteError::InvalidTarget(url.to_owned())))?;
        let route = self.policy.route_for_url(&target.origin().ascii_serialization()).await.map_err(ClientError::Route)?;
        let builder = reqwest::Client::builder();
        let builder = match route.proxy {
            Some(uri) => builder.proxy(reqwest::Proxy::all(reqwest_proxy_uri(&uri)).map_err(ClientError::Build)?),
            None => builder.no_proxy(),
        };
        builder.build().map_err(ClientError::Build)
    }

    /// The client for a request to `url`.
    pub async fn client_for(&self, url: &str) -> Result<reqwest::Client, ClientError> {
        let epoch = self.policy.epoch();
        let target = Url::parse(url).map_err(|_| ClientError::Route(RouteError::InvalidTarget(url.to_owned())))?;
        let route = self
            .policy
            .route_for_url(&target.origin().ascii_serialization())
            .await
            .map_err(ClientError::Route)?;
        // A decision that resolved after a change still serves its request, but
        // on a client that is not kept: it drains this request and closes.
        let stale = route.proxy.is_some() && epoch != self.policy.epoch();
        if stale {
            return (self.build)(route.proxy.as_deref()).map_err(ClientError::Build);
        }
        let mut legs = self.legs.lock().unwrap_or_else(PoisonError::into_inner);
        if let Some(client) = legs.get(&route.proxy) {
            return Ok(client.clone());
        }
        let client = (self.build)(route.proxy.as_deref()).map_err(ClientError::Build)?;
        legs.insert(route.proxy, client.clone());
        Ok(client)
    }
}

#[cfg(test)]
mod flavour_tests {
    use std::sync::atomic::AtomicUsize;
    use std::sync::atomic::Ordering;

    use super::*;
    use crate::netproxy::ProcessEnv;
    use crate::netproxy::SystemProxy;

    #[test]
    fn a_flavour_is_built_once_and_kept_apart_from_the_routed_clients() {
        let policy = NetworkProxy::new(Arc::new(ProcessEnv), SystemProxy::default());
        let routed_builds = Arc::new(AtomicUsize::new(0));
        let counted = routed_builds.clone();
        let clients = RoutedClients::new(policy, move |_| {
            counted.fetch_add(1, Ordering::SeqCst);
            reqwest::Client::builder().build()
        });
        let built = AtomicUsize::new(0);
        let build = || {
            built.fetch_add(1, Ordering::SeqCst);
            reqwest::Client::builder().build()
        };
        clients.direct_flavour("guarded", build).unwrap();
        clients.direct_flavour("guarded", build).unwrap();
        assert_eq!(built.load(Ordering::SeqCst), 1, "the second ask reuses the first client");
        clients.direct_flavour("other", build).unwrap();
        assert_eq!(built.load(Ordering::SeqCst), 2, "another flavour is another client");
        assert_eq!(routed_builds.load(Ordering::SeqCst), 0, "the routed builder is not asked");
    }
}
