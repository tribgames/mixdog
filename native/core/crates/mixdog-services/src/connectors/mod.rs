//! Connectors: the model-facing text of catalog connectors (selection triggers and the
//! per-server account instructions). Account sign-in and the catalog's transport belong to
//! the MCP hub; this module owns only what the model is told.

pub mod accounts;
pub mod triggers;

#[cfg(test)]
mod parity_tests;
