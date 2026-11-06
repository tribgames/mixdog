//! Real host-side implementations of the agent run loop's environment seams.

pub mod admission;
pub mod artifact;
pub mod tool_exposure;
pub mod attachment_reference;
pub mod cache;
mod grep_args;
pub mod guards;
pub mod hooks;
pub mod live_turn;
pub mod media;
pub mod progress;
pub mod reactions;
pub mod result_reuse;
pub mod retry;
pub mod route_chain;
pub mod route_fallback;
pub mod steer;
pub mod summary_routes;
pub mod tail;
