//! Domain services over the AI layer: the protocol namespaces `account`,
//! `model`, `modelProxy`, `route`, `usage` and `fast`, and the plan-usage
//! probe the account rotation calls.

pub mod admin_models;
pub mod admin_route;
pub mod model_proxy;
pub mod model_proxy_inline;
pub mod network_proxy;
pub mod oauth_usage;
pub mod quota_usable;
pub mod routes;
pub mod usage_normalize;
pub mod web_search;