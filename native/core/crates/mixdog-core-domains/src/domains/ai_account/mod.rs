//! The `account` and `usage` domain services.

pub mod account;
pub mod admin;
#[cfg(test)]
mod admin_tests;
pub mod auth_refresh;
pub mod collaborators;
pub mod custom_admin;
/// `custom-provider-config.mjs`, which the provider builder reads too.
pub use mixdog_ai::providers::custom::config as custom_config;
#[cfg(test)]
mod credential_transitions_feature_tests;
#[cfg(test)]
mod custom_admin_tests;
#[cfg(test)]
mod custom_config_feature_tests;
pub mod custom_probe;
#[cfg(test)]
mod custom_probe_tests;
#[cfg(test)]
mod custom_send_feature_tests;
pub mod dashboards;
pub mod failure;
pub mod flows;
pub(crate) mod js;
pub mod keychain_live;
#[cfg(test)]
mod keychain_live_tests;
#[cfg(test)]
mod model_proxy_feature_tests;
pub mod oauth_credentials;
#[cfg(test)]
mod oauth_credentials_tests;
pub mod oauth_status;
#[cfg(test)]
mod oauth_status_feature_tests;
#[cfg(test)]
mod oauth_status_tests;
#[cfg(test)]
mod policy_feature_tests;
pub mod production;
#[cfg(test)]
mod production_feature_tests;
pub mod provider_changes;
pub mod provider_setup;
#[cfg(test)]
mod provider_setup_feature_tests;
pub mod setup_cache;
#[cfg(test)]
mod setup_cache_tests;
pub mod setup_overlays;
#[cfg(test)]
mod setup_overlays_tests;
pub mod setup_world;
#[cfg(test)]
mod tests;
pub mod usage;

pub use self::account::AccountService;
pub use self::admin::ProviderAdmin;
pub use self::custom_admin::CustomAdmin;
pub use self::custom_admin::CustomFacts;
pub use self::custom_admin::CustomHost;
pub use self::custom_admin::{custom_provider_row, custom_provider_rows};
pub use self::dashboards::Dashboards;
pub use self::dashboards::SetupSource;
pub use self::flows::OAuthFlows;
pub use self::keychain_live::HolderLive;
pub use self::production::{AdminParts, OAuthWiring};
pub use self::setup_cache::CachedProviderSetup;
pub use self::setup_overlays::{CatalogFailure, CatalogFailures, LiveOverlays};
pub use self::setup_world::{ProxyProviders, SetupGatherer};
pub use self::usage::SessionMetadata;
pub use self::usage::UsageService;

#[cfg(test)]
mod provider_setup_custom_feature_tests;
