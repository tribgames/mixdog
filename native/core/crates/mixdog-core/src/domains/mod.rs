//! Registration of every [`DomainService`] (SPEC §3.2 `mixdog-core::domains`).
//!
//! A *slot* is a method-table namespace routed to a domain service
//! (`CoreHandle::domain(namespace)`). The composition root fills every slot before the core
//! is built: [`DomainsBuilder::build`] refuses an unfilled slot, so a namespace without an
//! owner is a boot error, never a runtime `None`. One service may fill several slots
//! (the workspace service owns both `project` and `projectFs`).

use std::collections::HashMap;
use std::sync::Arc;

use mixdog_core_api::DomainService;

pub mod blob;
pub mod client;
pub mod diagnostics;
pub mod feedback;
pub mod host;
pub mod instructions;
pub(crate) mod support;
pub mod update;

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

/// Every domain slot, sorted. Checked against the method table by the daemon's
/// `domain_slots_match_method_table` test, so a new method namespace cannot ship unowned.
pub const DOMAIN_NAMESPACES: &[&str] = &[
    "account",
    "agent",
    "blob",
    "browser",
    "channel",
    "client",
    "config",
    "connector",
    "diagnostics",
    "document",
    "fast",
    "feedback",
    "fs",
    "git",
    "github",
    "host",
    "import",
    "instructions",
    "localProvider",
    "lsp",
    "mcp",
    "media",
    "memory",
    "model",
    "modelProxy",
    "notify",
    "plugins",
    "process",
    "project",
    "projectFs",
    "remoteAccess",
    "review",
    "room",
    "route",
    "search",
    "skills",
    "system",
    "terminal",
    "tidy",
    "tools",
    "transfer",
    "update",
    "usage",
    "visualize",
    "voice",
];

#[derive(Debug, thiserror::Error, PartialEq, Eq)]
pub enum DomainsError {
    #[error("`{0}` is not a domain namespace")]
    UnknownNamespace(String),
    #[error("domain namespace `{0}` is registered twice")]
    Duplicate(&'static str),
    #[error("domain namespaces without a service: {0:?}")]
    Unfilled(Vec<&'static str>),
}

#[derive(Default)]
pub struct DomainsBuilder {
    services: HashMap<&'static str, Arc<dyn DomainService>>,
}

impl DomainsBuilder {
    pub fn new() -> Self {
        Self::default()
    }

    /// Fills the slot of `namespace`.
    pub fn register(
        &mut self,
        namespace: &str,
        service: Arc<dyn DomainService>,
    ) -> Result<&mut Self, DomainsError> {
        let slot = DOMAIN_NAMESPACES
            .iter()
            .copied()
            .find(|slot| *slot == namespace)
            .ok_or_else(|| DomainsError::UnknownNamespace(namespace.to_owned()))?;
        if self.services.insert(slot, service).is_some() {
            return Err(DomainsError::Duplicate(slot));
        }
        Ok(self)
    }

    /// Slots still empty, in slot order.
    pub fn unfilled(&self) -> Vec<&'static str> {
        DOMAIN_NAMESPACES
            .iter()
            .copied()
            .filter(|slot| !self.services.contains_key(slot))
            .collect()
    }

    pub fn build(self) -> Result<Domains, DomainsError> {
        let unfilled = self.unfilled();
        if !unfilled.is_empty() {
            return Err(DomainsError::Unfilled(unfilled));
        }
        Ok(Domains {
            services: self.services,
        })
    }
}

/// The filled registry behind `CoreHandle::domain`.
pub struct Domains {
    services: HashMap<&'static str, Arc<dyn DomainService>>,
}

impl Domains {
    pub fn get(&self, namespace: &str) -> Option<&dyn DomainService> {
        self.services.get(namespace).map(|service| service.as_ref())
    }
}

#[cfg(test)]
mod tests {
    use mixdog_core_api::mock::MockDomain;

    use super::*;

    #[test]
    fn slots_are_sorted_and_disjoint_from_core_namespaces() {
        assert!(DOMAIN_NAMESPACES.windows(2).all(|w| w[0] < w[1]));
        assert!(CORE_NAMESPACES.windows(2).all(|w| w[0] < w[1]));
        assert!(
            DOMAIN_NAMESPACES
                .iter()
                .all(|slot| !CORE_NAMESPACES.contains(slot))
        );
    }

    #[test]
    fn build_refuses_an_unfilled_slot() {
        let mut builder = DomainsBuilder::new();
        builder
            .register("config", Arc::new(MockDomain::default()))
            .unwrap();
        let err = builder.build().err().unwrap();
        match err {
            DomainsError::Unfilled(list) => {
                assert_eq!(list.len(), DOMAIN_NAMESPACES.len() - 1);
                assert!(!list.contains(&"config"));
            }
            other => panic!("unexpected {other:?}"),
        }
    }

    #[test]
    fn register_refuses_unknown_and_duplicate() {
        let mut builder = DomainsBuilder::new();
        assert_eq!(
            builder
                .register("thread", Arc::new(MockDomain::default()))
                .err(),
            Some(DomainsError::UnknownNamespace("thread".into()))
        );
        builder
            .register("git", Arc::new(MockDomain::default()))
            .unwrap();
        assert_eq!(
            builder
                .register("git", Arc::new(MockDomain::default()))
                .err(),
            Some(DomainsError::Duplicate("git"))
        );
    }

    #[test]
    fn one_service_fills_several_slots() {
        let shared: Arc<dyn DomainService> = Arc::new(MockDomain::default());
        let mut builder = DomainsBuilder::new();
        builder.register("project", shared.clone()).unwrap();
        builder.register("projectFs", shared).unwrap();
        assert!(!builder.unfilled().contains(&"project"));
        assert!(!builder.unfilled().contains(&"projectFs"));
    }
}
