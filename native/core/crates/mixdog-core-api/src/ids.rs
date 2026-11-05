//! Identifiers crossing the core seams. Wire ids are the protocol crate's; the seams add only
//! the server-local connection id, the server-request id and the method name.

use std::fmt;

use serde::Deserialize;
use serde::Serialize;

pub use mixdog_protocol::FeedEpoch;
pub use mixdog_protocol::FeedId;
pub use mixdog_protocol::HostId;
pub use mixdog_protocol::ItemId;
pub use mixdog_protocol::OpId;
pub use mixdog_protocol::QueuedId;
pub use mixdog_protocol::SubscriptionId;
pub use mixdog_protocol::ThreadId;
pub use mixdog_protocol::TurnId;

/// One accepted connection, unique for the life of the core. Never on the wire.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub struct ConnectionId(pub u64);

impl fmt::Display for ConnectionId {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}", self.0)
    }
}

/// A server-initiated request: `String(approvalId)`, durable and unique per data dir and stable
/// across reconnects (P §8.2). The JSON-RPC request id of the request frame.
#[derive(Clone, Debug, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(transparent)]
pub struct ServerRequestId(pub String);

impl ServerRequestId {
    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl fmt::Display for ServerRequestId {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}

/// A wire method name from the protocol method table (`"turn/start"`, `"config/value/write"`).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub struct Method(pub &'static str);

impl Method {
    pub fn as_str(&self) -> &'static str {
        self.0
    }
}

impl fmt::Display for Method {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.0)
    }
}
