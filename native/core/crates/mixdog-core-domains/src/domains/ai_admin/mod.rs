//! The AI administration services of Node's session runtime (`model`, `modelProxy`, `route`,
//! `fast`, and the setup route actions), over the pure helpers of `mixdog_ai::service`.

pub mod account_actions;
pub mod agent_route_service;
pub mod chain;
pub mod chat_routes;
pub mod model_catalog_feed;
pub mod model_list;
pub mod model_warmup;
pub mod provider_warmup;
pub mod statusline_warmup;
#[cfg(node_twin)]
#[cfg(test)]
mod statusline_warmup_tests;
#[cfg(node_twin)]
#[cfg(node_twin)]
#[cfg(node_twin)]
#[cfg(node_twin)]
#[cfg(test)]
mod catalog_refresh_start_tests;
pub mod model_proxy;
pub mod model_proxy_adapter;
pub mod model_proxy_service;
pub mod provider_status;
pub mod provider_sync;
mod quick_rows;
pub mod route_actions;
pub mod route_service;
pub mod route_set_service;
pub mod thread_route_service;
pub mod web_search_host;
pub mod web_search_models;

#[cfg(node_twin)]
#[cfg(node_twin)]
#[cfg(node_twin)]
#[cfg(node_twin)]
#[cfg(test)]
mod account_actions_tests;
#[cfg(node_twin)]
#[cfg(test)]
#[allow(clippy::disallowed_methods, reason = "test setup")]
mod agent_route_tests;
#[cfg(node_twin)]
#[cfg(node_twin)]
#[cfg(node_twin)]
#[cfg(node_twin)]
#[cfg(test)]
mod chat_routes_tests;
#[cfg(node_twin)]
#[cfg(test)]
mod model_catalog_feed_tests;
#[cfg(node_twin)]
#[cfg(test)]
mod config_snapshot_node_cases;
#[cfg(test)]
mod model_list_rig;
#[cfg(all(test, node_twin))]
use model_list_rig as model_list_node_tests;
#[cfg(test)]
mod model_list_tests;
#[cfg(test)]
mod model_warmup_tests;
#[cfg(test)]
mod provider_status_tests;
#[cfg(node_twin)]
#[cfg(node_twin)]
#[cfg(node_twin)]
#[cfg(node_twin)]
#[cfg(test)]
mod route_actions_tests;
#[cfg(test)]
#[allow(clippy::disallowed_methods, reason = "test setup")]
mod route_service_tests;
#[cfg(node_twin)]
#[cfg(test)]
#[allow(clippy::disallowed_methods, reason = "test setup")]
mod route_set_service_tests;
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
