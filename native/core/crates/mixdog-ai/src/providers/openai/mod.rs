//! OpenAI Responses codecs (API key and Codex routes).

pub mod adapter;
pub mod body;
pub mod cache_key;
pub mod client_meta;
pub mod codec;
pub mod config;
pub mod continuation;
pub mod decoder;
pub mod delta;
pub mod effort;
pub mod effort_retry;
pub mod error;
pub mod input;
pub mod login;
pub mod models;
pub mod oauth;
pub mod policy;
pub mod pool;
pub mod profile;
pub mod switch;
mod tool_flight;


