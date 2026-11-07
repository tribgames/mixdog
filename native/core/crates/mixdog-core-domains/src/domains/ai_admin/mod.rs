//! The AI administration services of Node's session runtime (`model`, `modelProxy`, `route`,
//! `fast`, and the setup route actions), over the pure helpers of `mixdog_ai::service`.

pub mod account_actions;
pub mod agent_route_service;
pub mod chain;
pub mod chat_routes;
pub mod model_list;
pub mod model_proxy;
pub mod model_proxy_service;
pub mod provider_status;
mod quick_rows;
pub mod route_actions;
pub mod route_service;
pub mod route_set_service;
pub mod thread_route_service;
pub mod web_search_host;
pub mod web_search_models;

#[cfg(test)]
mod account_actions_tests;
#[cfg(test)]
#[allow(clippy::disallowed_methods, reason = "test setup")]
mod agent_route_tests;
#[cfg(test)]
mod chat_routes_tests;
#[cfg(test)]
mod model_list_tests;
#[cfg(test)]
mod provider_status_tests;
#[cfg(test)]
mod route_actions_tests;
#[cfg(test)]
#[allow(clippy::disallowed_methods, reason = "test setup")]
mod route_service_tests;
#[cfg(test)]
#[allow(clippy::disallowed_methods, reason = "test setup")]
mod route_set_service_tests;
#[cfg(test)]
#[allow(clippy::disallowed_methods, reason = "test setup")]
mod thread_route_service_tests;
#[cfg(test)]
mod web_search_host_tests;
