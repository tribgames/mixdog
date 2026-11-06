//! The prompt-cache warmer (`session/cache-warm.mjs` and its stores): the plan, the chain, the durable
//! touch and idle-gap stores and the warm's stream reader.
pub mod chain;
pub mod gate;
pub mod plan;
pub mod send;
pub mod stores;
pub mod stream;
#[cfg(test)]
mod chain_tests;

pub use chain::Warmer;
