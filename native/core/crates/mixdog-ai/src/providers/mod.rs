//! Provider families. Each submodule is owned by one provider package;
//! `connect` holds the wire pieces shared by the Connect+protobuf families
//! (`cursor`, `devin`).

pub mod anthropic;
pub mod compat;
pub mod connect;
pub mod cursor;
pub mod devin;
pub mod custom;
pub mod google;
pub mod grok;
pub mod key_source;
pub mod local;
pub mod openai;
