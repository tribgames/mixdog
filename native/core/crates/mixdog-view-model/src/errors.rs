//! Error presentation: the one text, classification and label of a failure, ported from the Node `err-text.mjs`,
//! `error-presentation.mjs`, `provider-error-kind.mjs`, `transport-error-text.mjs` and `provider-timeout-phase.mjs`.
//!
//! A failure is a `serde_json::Value` as Node holds it: a string, an `Error`-like object (`message`, `name`, `code`,
//! `status`, `cause`, ...) or a persisted row. Where an absent field and `null` differ in Node the functions take an
//! `Option<&Value>` (`None` is `undefined`). An `Error` instance is told from a plain object by [`js_value::ERROR_INSTANCE_KEY`].

pub mod err_text;
pub mod error_presentation;
pub mod js_value;
pub mod provider_error_kind;
pub mod provider_timeout_phase;
pub mod transport_error_text;
