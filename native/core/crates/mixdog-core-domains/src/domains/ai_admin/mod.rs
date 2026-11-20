//! The AI administration services of Node's session runtime (`model`, `modelProxy`, `route`,
//! `fast`, and the setup route actions), over the pure helpers of `mixdog_ai::service`.

pub mod account_actions;
pub mod agent_route_service;
pub mod chain;
pub mod chat_routes;
pub mod model_catalog_feed;
pub mod model_list;
pub mod model_proxy;
pub mod model_proxy_adapter;
pub mod model_proxy_service;
pub mod model_warmup;
pub mod provider_status;
pub mod provider_sync;
pub mod provider_warmup;
mod quick_rows;
pub mod route_actions;
pub mod route_service;
pub mod route_set_service;
pub mod statusline_warmup;
pub mod thread_route_service;
pub mod web_search_host;
pub mod web_search_models;

#[cfg(test)]
mod model_list_rig;
#[cfg(test)]
mod model_list_tests;
#[cfg(test)]
mod model_warmup_tests;
#[cfg(test)]
mod provider_status_tests;
#[cfg(test)]
#[allow(clippy::disallowed_methods, reason = "test setup")]
mod route_service_tests;
#[cfg(test)]
mod route_set_rules_tests;
#[cfg(test)]
#[allow(clippy::disallowed_methods, reason = "test setup")]
mod thread_route_service_feature_tests;
#[cfg(test)]
mod web_search_host_tests;

#[cfg(test)]
mod account_actions_feature_tests;

#[cfg(test)]
mod agent_route_feature_tests;

#[cfg(test)]
mod chat_routes_feature_tests;

#[cfg(test)]
mod route_actions_feature_tests;

#[cfg(test)]
mod statusline_warmup_feature_tests;

#[cfg(test)]
mod model_catalog_feed_feature_tests;

#[cfg(test)]
mod config_snapshot_feature_tests;

#[cfg(test)]
mod catalog_refresh_start_feature_tests;
