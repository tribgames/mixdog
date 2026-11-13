//! The OpenAI-compatible family (PW §5.7, §5.14, §5.15): Chat Completions
//! gateways, xAI, DeepSeek, OpenRouter, MiMo, Muse Code, Command Code and
//! OpenCode Go. Every provider is a [`profile::CompatProfile`] row read by the
//! shared codecs; no code branches on a provider name.

pub mod adapter;
pub(crate) mod ajv_meta;
pub mod chat;
pub mod creds;
pub mod login;
pub(crate) mod listing;
pub mod error;
pub mod models;
mod nonstream;
pub mod pairing;
pub mod profile;
pub mod responses;
pub mod retry;
pub mod schema;
pub mod sse;
pub mod wire_route;
pub(crate) mod xai_cache;

#[cfg(test)]
mod chat_stream_replay_tests;
#[cfg(test)]
mod deepseek_replay_tests;
#[cfg(test)]
mod tests;

pub use chat::{CompatChatCodec, CompatConfig};

/// The profile's per-send session header ([`profile::ChatDialect::session_header`]): the trimmed session id, else a
/// UUID drawn for the send.
pub(crate) fn session_header(profile: &CompatProfile, request: &mixdog_core_api::domain::provider::ModelRequest) -> Option<(String, String)> {
    let name = profile.chat.session_header?;
    let session = [request.options.session_id.as_deref()]
        .into_iter()
        .flatten()
        .map(str::trim)
        .find(|s| !s.is_empty())
        .map(str::to_owned)
        .unwrap_or_else(crate::registry::accounting::random_uuid);
    Some((name.to_owned(), session))
}
pub use profile::CompatProfile;
