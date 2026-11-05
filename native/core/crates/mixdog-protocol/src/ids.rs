//! String identifiers. Each is a transparent string on the wire.

use schemars::JsonSchema;
use serde::Deserialize;
use serde::Serialize;
use ts_rs::TS;

macro_rules! string_id {
    ($($(#[doc = $doc:literal])* $name:ident;)*) => {$(
        $(#[doc = $doc])*
        #[derive(Debug, Clone, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize, JsonSchema, TS)]
        #[serde(transparent)]
        pub struct $name(pub String);

        impl $name {
            pub fn as_str(&self) -> &str {
                &self.0
            }
        }

        impl From<String> for $name {
            fn from(value: String) -> Self {
                Self(value)
            }
        }

        impl From<&str> for $name {
            fn from(value: &str) -> Self {
                Self(value.to_owned())
            }
        }

        impl std::fmt::Display for $name {
            fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
                f.write_str(&self.0)
            }
        }
    )*};
}

string_id! {
    /// A thread (today's session, including agent homes, group-room logs and sub-agent sessions).
    ThreadId;
    /// One run: user input to final answer.
    TurnId;
    /// A transcript item; assigned when the item starts and never reused.
    ItemId;
    /// Client-generated UUIDv7 that makes a mutation idempotent (P §9.1).
    OpId;
    /// A queued input entry of a busy thread.
    QueuedId;
    /// One subscription of one connection to one feed.
    SubscriptionId;
    /// Feed id: `app`, a thread id, or a scoped feed `<kind>:<key>` (see `ScopedFeedKind`).
    FeedId;
    /// 128-bit random feed epoch, lowercase hex.
    FeedEpoch;
    /// Content digest `sha256:<64 lowercase hex>`.
    BlobDigest;
    /// Process handle of `process/*` (client-chosen, connection-owned).
    ProcessHandle;
    /// Terminal tab id.
    TerminalTabId;
    /// Client-chosen, connection-owned watch id of `fs/watch`.
    WatchId;
    /// Client-chosen fuzzy file search session id.
    SearchSessionId;
    /// One read or write transfer.
    TransferId;
    /// A login flow (GitHub CLI, provider OAuth, MCP OAuth).
    LoginFlowId;
    /// Per-install desktop host id claimed with `host/claim`.
    HostId;
    /// Media job id.
    MediaJobId;
    /// A model tool call (the provider's call id as received).
    ToolCallId;
    /// A provider (`anthropic`, `openai-oauth`, `custom-<uuid>`, …).
    ProviderId;
}
