//! The OpenAI-compatible family (PW §5.7, §5.14, §5.15): Chat Completions
//! gateways, xAI, DeepSeek, OpenRouter, MiMo, Muse Code, Command Code and
//! OpenCode Go. Every provider is a [`profile::CompatProfile`] row read by the
//! shared codecs; no code branches on a provider name.

pub mod adapter;
pub mod chat;
pub mod creds;
pub mod login;
mod listing;
pub mod error;
pub mod models;
pub mod pairing;
pub mod profile;
pub mod responses;
pub mod retry;
pub mod schema;
pub mod sse;
pub mod wire_route;
pub(crate) mod xai_cache;

#[cfg(test)]
mod tests;

pub use chat::{CompatChatCodec, CompatConfig};
pub use profile::CompatProfile;
