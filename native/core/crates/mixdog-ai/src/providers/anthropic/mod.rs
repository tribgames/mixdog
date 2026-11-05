//! `anthropic` (API key) and `anthropic-oauth` (Claude subscription): the
//! Anthropic Messages wire. One codec ([`AnthropicCodec`]) encodes the request
//! and decodes the SSE stream for both; [`AnthropicAdapter`] runs one attempt
//! with the provider's credentials. Retry rows are data
//! ([`AnthropicAdapter::retry_policy`]); no timer exists in this module: a
//! stream ends by a transport fact, a missing `message_stop`, a typed error
//! event or the consumer dropping it.

mod adapter;
mod betas;
mod body;
mod caps;
mod codec;
mod decoder;
mod effort_updates;
mod errors;
mod lowering;
pub mod oauth;
mod policy;

#[cfg(test)]
mod effort_tests;
#[cfg(test)]
mod tests;

pub use adapter::AnthropicAdapter;
pub use adapter::ApiKeySource;
pub use adapter::Credentials;
pub use body::CacheStrategy;
pub use body::CacheTtl;
pub use caps::CapsLookup;
pub use caps::ModelCaps;
pub use codec::ANTHROPIC_VERSION;
pub use codec::AnthropicCodec;
pub use codec::AnthropicConfig;
pub use codec::DEFAULT_BASE_URL;
pub use codec::DEFAULT_CLI_VERSION;
pub use codec::Flavor;
pub use oauth::AnthropicLogin;
pub use oauth::OAuthSession;
pub use oauth::StoredOAuth;
