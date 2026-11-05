//! The network proxy: how Mixdog reaches AI services. The setting (agent config
//! `networkProxy` `{ mode, url, exceptions }`), the one routing decision every
//! outbound path asks ([`NetworkProxy::route_for_url`]), the OS proxy
//! ([`system`]), the route epoch that retires pooled connections when the
//! setting changes, and the diagnostics behind `config/getNetworkProxy` and
//! `config/testNetworkProxy`.
//!
//! The setting is held in memory and replaced by [`NetworkProxy::adopt`], which
//! the config owner calls with the stored value at startup, after this
//! process's own write and when another writer changes the file; a routing
//! decision touches no file.

pub mod clients;
pub mod diagnostics;
mod hosts;
pub mod route;
pub mod setting;
pub mod system;
pub mod tunnel;

use std::sync::Arc;
use std::sync::Mutex;
use std::sync::PoisonError;
use std::sync::Weak;
use std::sync::atomic::AtomicU64;
use std::sync::atomic::Ordering;

use serde_json::Value;

pub use self::clients::RoutedClients;
pub use self::hosts::is_local_host;
pub use self::route::EnvLookup;
pub use self::route::ProcessEnv;
pub use self::route::ProxyConfigError;
pub use self::route::Route;
pub use self::route::RouteError;
pub use self::setting::Mode;
pub use self::setting::NetworkProxySetting;
pub use self::system::SystemProxy;

#[cfg(test)]
mod tests;

type Listener = Arc<dyn Fn(u64) + Send + Sync>;

/// The message of the error raised while no setting has ever been read.
pub const UNREADABLE_MESSAGE: &str = "The network proxy setting cannot be read from the config file.";

struct Held {
    setting: Option<NetworkProxySetting>,
    listeners: Vec<(u64, Listener)>,
    next_listener: u64,
}

pub struct NetworkProxy {
    held: Mutex<Held>,
    epoch: AtomicU64,
    env: Arc<dyn EnvLookup>,
    system: SystemProxy,
}

impl NetworkProxy {
    /// `env` is the process environment in production. No setting is known
    /// until the first [`adopt`](Self::adopt): nothing may go out before that.
    pub fn new(env: Arc<dyn EnvLookup>, system: SystemProxy) -> Arc<Self> {
        Arc::new(Self {
            held: Mutex::new(Held { setting: None, listeners: Vec::new(), next_listener: 0 }),
            epoch: AtomicU64::new(0),
            env,
            system,
        })
    }

    fn held(&self) -> std::sync::MutexGuard<'_, Held> {
        self.held.lock().unwrap_or_else(PoisonError::into_inner)
    }

    pub fn env(&self) -> &dyn EnvLookup {
        self.env.as_ref()
    }

    pub fn system(&self) -> &SystemProxy {
        &self.system
    }

    /// The network proxy setting now. Fails with a [`ProxyConfigError`] when it
    /// has never been read: no setting is known, so nothing may go out.
    pub fn current(&self) -> Result<NetworkProxySetting, ProxyConfigError> {
        self.held().setting.clone().ok_or_else(|| ProxyConfigError::new(UNREADABLE_MESSAGE))
    }

    /// The stored `networkProxy` value (`null` when the config has none) is the
    /// setting from now on; a change announces itself to every listener.
    pub fn adopt(&self, stored: &Value) {
        let next = setting::normalize_network_proxy(stored);
        let announce = {
            let mut held = self.held();
            let changed = held.setting.as_ref() != Some(&next);
            held.setting = Some(next);
            changed
        };
        if announce {
            self.route_changed();
        }
    }

    fn route_changed(&self) {
        let epoch = self.epoch.fetch_add(1, Ordering::SeqCst) + 1;
        let listeners: Vec<Listener> = self.held().listeners.iter().map(|(_, listener)| Arc::clone(listener)).collect();
        for listener in listeners {
            // One pool failing to retire its connections never blocks the others.
            let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| listener(epoch)));
        }
    }

    /// The current route epoch; record it before connecting, and compare before reusing a connection.
    pub fn epoch(&self) -> u64 {
        self.epoch.load(Ordering::SeqCst)
    }

    /// `listener(epoch)` hears every change of the setting, synchronously, until
    /// the returned subscription is dropped.
    pub fn on_change(self: &Arc<Self>, listener: Listener) -> Subscription {
        let mut held = self.held();
        held.next_listener += 1;
        let id = held.next_listener;
        held.listeners.push((id, listener));
        Subscription { owner: Arc::downgrade(self), id }
    }

    /// The route for `target` (an http(s) or ws(s) URL) under the current setting.
    pub async fn route_for_url(&self, target: &str) -> Result<Route, RouteError> {
        let setting = self.current()?;
        self.route_with(target, &setting).await
    }

    pub async fn route_with(&self, target: &str, setting: &NetworkProxySetting) -> Result<Route, RouteError> {
        let system = self.system.registered().then_some(&self.system);
        route::decide_proxy_route(target, setting, self.env.as_ref(), system).await
    }

    /// The OS proxy route of `origin` whatever the setting says (to describe
    /// what `off` ignores); no proxy without one.
    pub async fn os_proxy_route(&self, origin: &str) -> system::SystemRoute {
        if self.system.registered() { self.system.route(origin).await } else { system::SystemRoute::default() }
    }
}

/// Keeps a change listener registered.
pub struct Subscription {
    owner: Weak<NetworkProxy>,
    id: u64,
}

impl Drop for Subscription {
    fn drop(&mut self) {
        if let Some(owner) = self.owner.upgrade() {
            owner.held().listeners.retain(|(id, _)| *id != self.id);
        }
    }
}
