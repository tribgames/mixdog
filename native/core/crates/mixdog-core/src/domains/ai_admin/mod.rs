//! The AI administration services of Node's session runtime (`model`, `modelProxy`, `route`,
//! `fast`, and the setup route actions), over the pure helpers of `mixdog_ai::service`.

pub mod agent_route_service;
pub mod chain;
pub mod hidden_agents;
pub mod model_proxy;
pub mod model_proxy_service;

#[cfg(test)]
mod agent_route_tests;
