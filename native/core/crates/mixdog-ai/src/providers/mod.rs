//! Provider families. Each submodule is owned by one provider package;
//! `connect` holds the wire pieces shared by the Connect+protobuf families
//! (`cursor`, `devin`).

pub mod action_input;
#[cfg(test)]
mod action_input_tests;
pub mod anthropic;
pub mod compat;
pub mod connect;
pub mod cursor;
pub mod devin;
pub(crate) mod flat_schema;
pub mod custom;
pub mod google;
pub mod grok;
pub(crate) mod js_value;
pub mod key_source;
pub mod listing_row;
pub mod local;
pub mod openai;
