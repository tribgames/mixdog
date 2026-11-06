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
        Self { policy, build: Box::new(build), legs, _retire: retire }
    }

    pub fn policy(&self) -> &Arc<NetworkProxy> {
        &self.policy
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
