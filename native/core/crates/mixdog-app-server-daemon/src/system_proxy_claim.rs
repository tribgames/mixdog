//! The desktop host's system-proxy resolver (Node `systemProxyAttach`, `desktop-service-registry.mjs:244`,
//! answered by `session.resolveProxy` in the desktop app): while a host claim that serves
//! `SystemProxy` is recorded, the process routes by asking that host for the rules of an origin.
//!
//! [`Outgoing`](mixdog_app_server::Outgoing) calls [`SystemProxyClaims`] when it records such a claim
//! and keeps the returned handle in the claim, so a replaced claim, a closed connection and the end
//! of the process drop it and the resolver detaches (Node releases it with the client's visibility
//! epoch). `SystemProxy::attach_resolver` is a no-op handle when the process routes nothing (user
//! proxy variables set, or `MIXDOG_SYSTEM_PROXY=0`).

use std::any::Any;
use std::sync::Arc;

use mixdog_ai::netproxy::stack::HostResolver;
use mixdog_ai::netproxy::system::SystemProxy;
use mixdog_app_server::ClaimHook;
use mixdog_core_api::HostCapability;
use mixdog_core_api::HostChannel;

pub struct SystemProxyClaims {
    system: Arc<SystemProxy>,
    host: Arc<dyn HostChannel>,
}

impl SystemProxyClaims {
    /// `system`: `NetworkStack::system`, the same state the policy routes by. `host`: the server's
    /// `Outgoing`, which the resolver asks.
    pub fn new(system: Arc<SystemProxy>, host: Arc<dyn HostChannel>) -> Arc<Self> {
        Arc::new(Self { system, host })
    }
}

impl ClaimHook for SystemProxyClaims {
    fn claimed(&self, serves: &[HostCapability]) -> Option<Box<dyn Any + Send>> {
        if !serves.contains(&HostCapability::SystemProxy) {
            return None;
        }
        Some(Box::new(self.system.attach_resolver(Arc::new(HostResolver::new(self.host.clone())))))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_a_claim_serving_the_system_proxy_attaches_a_resolver() {
        let claims = SystemProxyClaims::new(Arc::new(SystemProxy::default()), Arc::new(mixdog_core_api::mock::MockHostChannel::default()));
        assert!(claims.claimed(&[HostCapability::Browser, HostCapability::Notifications]).is_none());
        assert!(claims.claimed(&[HostCapability::Browser, HostCapability::SystemProxy]).is_some());
    }
}
