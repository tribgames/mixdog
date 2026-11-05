//! One retry mechanism (SPEC §4.9, PW §3–§4): [`StandardRetryDecider`] is the
//! only function that turns a typed [`ProviderError`](mixdog_core_api::domain::provider::ProviderError)
//! and the attempt state into a verdict; per-provider numbers are
//! [`RetryPolicy`](mixdog_core_api::domain::retry::RetryPolicy) rows owned by
//! the provider packages. [`classify`] and [`advice`] are the shared pure
//! rules adapters use once, at their boundary, to fill the error's fields.

pub mod advice;
pub mod classify;
mod decider;

pub use decider::StandardRetryDecider;
pub use decider::random_samples;