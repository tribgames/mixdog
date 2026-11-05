//! One request to the desktop host for the `browser` and `visualize` domains, and the one mapping
//! of its failure to a coded domain error.

use mixdog_core_api::CoreError;
use mixdog_core_api::HostCapability;
use mixdog_core_api::HostChannel;
use mixdog_core_api::HostError;
use mixdog_core_api::ids::Method;
use mixdog_protocol::DomainErrorDetail;
use serde_json::Value;

/// The code of a command the host answered with a JSON-RPC error.
pub(crate) const HOST_COMMAND_FAILED: &str = "HOST_COMMAND_FAILED";

pub(crate) async fn forward(
    channel: &dyn HostChannel,
    capability: HostCapability,
    domain: &'static str,
    method: &'static str,
    params: Value,
) -> Result<Value, CoreError> {
    match channel.request(capability, Method(method), params).await {
        Ok(value) => Ok(value),
        // No claimant, or it closed first: the channel's own `capabilityUnavailable`.
        Err(HostError::Core(error)) => Err(error),
        // The host's redacted message is what the user reads; `data.timing` is for logs only.
        Err(HostError::Rpc { message, .. }) => Err(CoreError::DomainError {
            domain: domain.into(),
            code: Some(HOST_COMMAND_FAILED.into()),
            detail: Some(Box::new(DomainErrorDetail::ExternalFailure { message })),
        }),
    }
}
