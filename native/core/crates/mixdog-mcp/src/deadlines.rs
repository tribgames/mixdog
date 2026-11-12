//! The [`Liveness`] of each MCP wire exchange. Values are Node's MCP timeouts
//! (`src/runtime/agent/orchestrator/mcp/client-config.mjs`).

use std::time::Duration;

use mixdog_rt::Expired;
use mixdog_rt::Liveness;

use crate::transport::TransportError;

/// A JSON-RPC request post: only its response head is bounded, by Node's ceiling on one call
/// (`DEFAULT_MCP_MAX_TOTAL_TIMEOUT_MS`, `client-config.mjs:23`, 1_800_000); the call's own idle
/// and total limits in `rpc.rs` end it sooner.
pub const CALL: Liveness = Liveness::stream(Duration::from_secs(1800));

/// A notification or a reply to a server request. Node has no deadline for these (its SDK posts
/// them without one). Divergence (decisions.md): 30 s, Node's own MCP startup bound
/// (`DEFAULT_MCP_STARTUP_TIMEOUT_MS`, `client-config.mjs:20`).
pub const NOTICE: Liveness = Liveness::unary(Duration::from_secs(30));

/// Opening or closing a session: the standalone stream, the SSE stream and its `endpoint`
/// event, the session DELETE. `DEFAULT_MCP_STARTUP_TIMEOUT_MS` (`client-config.mjs:20`, 30_000).
pub const STARTUP: Liveness = Liveness::stream(Duration::from_secs(30));

pub fn expired(expired: Expired) -> TransportError {
    TransportError::Request(format!(
        "request timed out after {}ms",
        expired.after.as_millis()
    ))
}
