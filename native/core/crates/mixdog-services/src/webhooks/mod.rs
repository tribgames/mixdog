//! Inbound webhooks: signature verification, delivery dedup and dispatch into an owner's
//! routine run. A listening server and every in-flight request count as running work.

pub mod deliveries;
pub mod handler;
pub mod prompt;
pub mod records;
pub mod signature;

#[cfg(test)]
mod tests;

pub use handler::{
    Claim, Endpoint, HttpReply, MAX_BODY_BYTES, WebhookConfig, WebhookDispatch, WebhookService, WebhookStore,
};
pub use records::{EndpointRecord, EndpointRecords, RunStamp, StateWebhookStore};
pub use signature::Headers;
