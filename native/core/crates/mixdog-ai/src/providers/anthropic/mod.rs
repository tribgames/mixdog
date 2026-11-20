//! `anthropic` (API key) and `anthropic-oauth` (Claude subscription): the
//! Anthropic Messages wire. One codec ([`AnthropicCodec`]) encodes the request
//! and decodes the SSE stream for both; [`AnthropicAdapter`] runs one attempt
//! with the provider's credentials. Retry rows are data
//! ([`AnthropicAdapter::retry_policy`]); no timer exists in this module: a
//! stream ends by a transport fact, a missing `message_stop`, a typed error
//! event or the consumer dropping it.

mod adapter;
mod before_output;
mod betas;
mod body;
mod caps;
pub mod catalog_caps;
mod client_version;
mod codec;
mod decoder;
mod effort_updates;
pub(crate) mod errors;
pub mod fast_mode;
pub mod images;
pub(crate) mod lowering;
mod max_tokens;
mod models;
mod nonstream;
pub mod oauth;
mod policy;
pub mod prefix_trace;
mod reminders;
pub mod replay_blocks;
mod threads;

#[cfg(test)]
mod effort_tests;
#[cfg(test)]
mod fallback_wire_tests;
#[cfg(test)]
mod models_tests;
#[cfg(test)]
mod tests;

pub use adapter::AnthropicAdapter;
pub use adapter::ApiKeySource;
pub use adapter::Compressor;
pub use adapter::Credentials;
#[cfg(any(test, feature = "test-support"))]
pub use adapter::gzip_latched;
#[cfg(any(test, feature = "test-support"))]
pub use adapter::reset_gzip_latch;
pub use body::CacheStrategy;
pub use body::CacheTtl;
pub use body::anthropic_tool_exclusion;
pub use caps::CapsLookup;
pub use caps::ModelCaps;
pub use client_version::ClaudeClientVersion;
pub use codec::ANTHROPIC_VERSION;
pub use codec::AnthropicCodec;
pub use codec::AnthropicConfig;
pub use codec::DEFAULT_BASE_URL;
pub use codec::DEFAULT_CLI_VERSION;
pub use codec::Flavor;
pub(crate) use codec::vertex_body;
pub(crate) use decoder::AnthropicDecoder;
pub use models::AnthropicModel;
pub use models::Tier;
pub use oauth::AnthropicLogin;
pub use oauth::OAuthSession;
pub use oauth::StoredOAuth;
pub(crate) use policy::retry_policy;

/// The Anthropic module state a send leaves in the process (the gzip latch, the message threads, the fast-mode cooldown
/// and disabled reason), as a new process has it.
#[cfg(any(test, feature = "test-support"))]
pub(crate) fn reset_process_state() {
    adapter::reset_gzip_latch();
    threads::reset_process();
    // `clearFastModeCooldown()` puts back `anthropic-fast-mode.mjs:40-41`'s initial values, cooldown 0 and reason null.
    fast_mode::process().clear();
}
