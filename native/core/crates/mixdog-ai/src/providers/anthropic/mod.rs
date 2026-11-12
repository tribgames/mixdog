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
mod codec;
mod decoder;
mod effort_updates;
pub(crate) mod errors;
pub mod fast_mode;
pub mod images;
mod lowering;
mod models;
pub mod oauth;
mod policy;
pub mod prefix_trace;
mod reminders;
mod threads;

#[cfg(test)]
mod effort_tests;
#[cfg(test)]
mod fallback_wire_tests;
#[cfg(test)]
mod fast_mode_tests;
#[cfg(test)]
mod leak_tests;
#[cfg(test)]
mod models_tests;
#[cfg(test)]
mod schema_tests;
#[cfg(test)]
mod native_search_tests;
#[cfg(test)]
mod shared_prefix_tests;
#[cfg(test)]
mod tests;
#[cfg(test)]
pub(crate) mod wire_tests;

pub use adapter::AnthropicAdapter;
pub use adapter::ApiKeySource;
pub use adapter::Credentials;
pub use body::CacheStrategy;
pub use body::anthropic_tool_exclusion;
pub use body::CacheTtl;
pub use caps::CapsLookup;
pub use caps::ModelCaps;
pub use codec::ANTHROPIC_VERSION;
pub use codec::AnthropicCodec;
pub use codec::AnthropicConfig;
pub use codec::DEFAULT_BASE_URL;
pub use codec::DEFAULT_CLI_VERSION;
pub use codec::Flavor;
pub(crate) use codec::vertex_body;
pub(crate) use decoder::AnthropicDecoder;
pub(crate) use policy::retry_policy;
pub use models::AnthropicModel;
pub use models::Tier;
pub use oauth::AnthropicLogin;
pub use oauth::OAuthSession;
pub use oauth::StoredOAuth;

/// The Anthropic module state a send leaves in the process (the gzip latch, the message threads, the fast-mode cooldown
/// and disabled reason), as a new process has it.
#[cfg(any(test, feature = "test-support"))]
pub(crate) fn reset_process_state() {
    adapter::reset_gzip_latch();
    threads::reset_process();
    // `clearFastModeCooldown()` puts back `anthropic-fast-mode.mjs:40-41`'s initial values, cooldown 0 and reason null.
    fast_mode::process().clear();
}
