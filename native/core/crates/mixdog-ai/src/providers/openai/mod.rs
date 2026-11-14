//! OpenAI Responses codecs (API key and Codex routes).

pub mod adapter;
pub mod body;
pub mod cache_key;
pub mod client_meta;
pub mod codec;
pub mod config;
pub mod continuation;
pub mod decoder;
pub mod device_login;
pub mod delta;
pub mod effort;
pub mod effort_retry;
pub mod error;
pub mod hedge;
pub mod input;
pub mod login;
pub mod models;
pub mod oauth;
pub mod policy;
pub mod pool;
pub mod profile;
#[cfg(any(test, feature = "test-support"))]
pub mod scripted;
pub mod switch;
pub mod transport_policy;
mod tool_flight;


