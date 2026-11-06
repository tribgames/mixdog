//! Registration of every [`DomainService`] (SPEC §3.2 `mixdog-core::domains`).
//!
//! The core routes by exact method name (`CoreHandle::domain_for(method)`). A service claims
//! the methods it lists in [`DomainService::methods`]; [`DomainsBuilder::register`] builds the
//! one method-to-service table and refuses a method that is not in the protocol's method table
//! or that a service already claimed, so a bad claim is a boot error. A method nobody claims
//! has no entry: the router answers it `capabilityUnavailable`.

use std::collections::HashMap;
use std::sync::Arc;

use mixdog_app_protocol::CLIENT_METHODS;
use mixdog_app_protocol::CLIENT_NOTIFICATIONS;
use mixdog_core_api::DomainService;

pub mod ai_account;
pub mod ai_admin;
pub mod blob;
pub mod client;
pub mod diagnostics;
pub mod feedback;
pub mod host;
pub mod instructions;
pub mod remote_access;
pub mod remote_push;
pub(crate) mod support;
pub mod update;
pub mod visualize_export;

pub use self::support::OpScopes;

/// Namespaces the server and the thread layer serve themselves: they never reach a
/// [`DomainService`]. `initialize`/`app`/`feed`/`op` are connection-level; `thread`, `turn` and
/// `approval` address the thread directory and `RunControl`. (`initialized` is the handshake
/// notification, which the table lists as a method.)
pub const CORE_NAMESPACES: &[&str] = &[
    "app",
    "approval",
    "feed",
    "initialize",
    "initialized",
    "op",
    "thread",
    "turn",
];

/// Every request and client notification of the method table, in table order.
fn table_methods() -> impl Iterator<Item = &'static str> {
    CLIENT_METHODS
        .iter()
        .map(|spec| spec.method)
        .chain(CLIENT_NOTIFICATIONS.iter().map(|spec| spec.method))
}

#[derive(Debug, thiserror::Error, PartialEq, Eq)]
pub enum DomainsError {
    #[error("`{0}` is not a method of the protocol's method table")]
    UnknownMethod(&'static str),
    #[error("method `{0}` is claimed twice")]
    Duplicate(&'static str),
}

#[derive(Default)]
pub struct DomainsBuilder {
    services: HashMap<&'static str, Arc<dyn DomainService>>,
}

impl DomainsBuilder {
    pub fn new() -> Self {
        Self::default()
    }

    /// Claims every method `service` lists. Nothing is claimed when any of them fails.
    pub fn register(&mut self, service: Arc<dyn DomainService>) -> Result<&mut Self, DomainsError> {
        let methods = service.methods();
        for (index, method) in methods.iter().copied().enumerate() {
            if !table_methods().any(|listed| listed == method) {
                return Err(DomainsError::UnknownMethod(method));
            }
            if self.services.contains_key(method) || methods[..index].contains(&method) {
                return Err(DomainsError::Duplicate(method));
            }
        }
        for method in methods {
            self.services.insert(method, Arc::clone(&service));
        }
        Ok(self)
    }

    /// The table methods the core does not serve itself that no service has claimed yet, in
    /// table order.
    pub fn unclaimed(&self) -> Vec<&'static str> {
        table_methods()
            .filter(|method| {
                let namespace = method.split('/').next().unwrap_or(method);
                !CORE_NAMESPACES.contains(&namespace) && !self.services.contains_key(method)
            })
            .collect()
    }

    pub fn build(self) -> Domains {
        Domains { services: self.services }
    }
}

/// The method-to-service table behind `CoreHandle::domain_for`.
pub struct Domains {
    services: HashMap<&'static str, Arc<dyn DomainService>>,
}

impl Domains {
    pub fn get(&self, method: &str) -> Option<&dyn DomainService> {
        self.services.get(method).map(|service| service.as_ref())
    }
}

#[cfg(test)]
mod tests {
    use mixdog_core_api::mock::MockDomain;

    use super::*;

    fn serving(methods: &'static [&'static str]) -> Arc<dyn DomainService> {
        Arc::new(MockDomain::serving(methods))
    }

    #[test]
    fn core_namespaces_are_sorted() {
        assert!(CORE_NAMESPACES.windows(2).all(|w| w[0] < w[1]));
    }

    #[test]
    fn methods_of_one_namespace_route_to_different_services() {
        let update = serving(&["config/getUpdateSettings"]);
        let config = serving(&["config/read"]);
        let mut builder = DomainsBuilder::new();
        builder.register(update.clone()).unwrap();
        builder.register(config.clone()).unwrap();
        let domains = builder.build();
        let same = |found: Option<&dyn DomainService>, expected: &Arc<dyn DomainService>| {
            std::ptr::addr_eq(found.unwrap(), Arc::as_ptr(expected))
        };
        assert!(same(domains.get("config/getUpdateSettings"), &update));
        assert!(same(domains.get("config/read"), &config));
        assert!(domains.get("config/getNetworkProxy").is_none());
    }

    #[test]
    fn register_refuses_a_duplicate_claim_and_claims_nothing() {
        let mut builder = DomainsBuilder::new();
        builder.register(serving(&["git/status"])).unwrap();
        assert_eq!(
            builder.register(serving(&["git/log", "git/status"])).err(),
            Some(DomainsError::Duplicate("git/status"))
        );
        assert_eq!(
            builder.register(serving(&["git/log", "git/log"])).err(),
            Some(DomainsError::Duplicate("git/log"))
        );
        assert!(builder.build().get("git/log").is_none());
    }

    #[test]
    fn register_refuses_a_method_outside_the_table() {
        let mut builder = DomainsBuilder::new();
        assert_eq!(
            builder.register(serving(&["config/nope"])).err(),
            Some(DomainsError::UnknownMethod("config/nope"))
        );
    }

    #[test]
    fn notifications_register_like_requests() {
        let mut builder = DomainsBuilder::new();
        builder.register(serving(&["client/activity"])).unwrap();
        assert!(!builder.unclaimed().contains(&"client/activity"));
        assert!(builder.unclaimed().contains(&"client/perfLog"));
        assert!(builder.build().get("client/activity").is_some());
    }

    #[test]
    fn unclaimed_leaves_out_what_the_core_serves_itself() {
        let builder = DomainsBuilder::new();
        let unclaimed = builder.unclaimed();
        assert!(unclaimed.contains(&"config/read"));
        assert!(unclaimed.iter().all(|method| !method.starts_with("thread/")));
        assert!(!unclaimed.contains(&"initialized"));
    }
}
