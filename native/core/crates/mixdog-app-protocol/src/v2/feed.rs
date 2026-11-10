//! Feeds, subscriptions and resume (P §6, SPEC §4.2, DS §2.1).

use mixdog_protocol::FeedEpoch;
use mixdog_protocol::FeedId;
use mixdog_protocol::JsonValue;
use mixdog_protocol::SectionUpdate;
use mixdog_protocol::SubscriptionId;
use serde::Deserialize;
use serde::Serialize;

/// Kinds of scoped feeds; the feed id is `<kind>:<key>` (`ports` has no key).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema, ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub enum ScopedFeedKind {
    /// `fs:<watchId>`, from `fs/watch`.
    Fs,
    /// `search:<sessionId>`, from `search/start`.
    Search,
    /// `process:<handle>`; terminal tabs use `process:<tabId>` from `terminal/attach`.
    Process,
    /// `login:<flowId>`: GitHub CLI, provider OAuth and MCP OAuth flows.
    Login,
    /// `git:<repoRoot>`, from `git/watch`.
    Git,
    /// `lsp:<root>`.
    Lsp,
    /// `media:<jobId>`.
    Media,
    /// `ports`, from `system/ports/subscribe`.
    Ports,
}

impl ScopedFeedKind {
    pub const fn prefix(self) -> &'static str {
        match self {
            Self::Fs => "fs",
            Self::Search => "search",
            Self::Process => "process",
            Self::Login => "login",
            Self::Git => "git",
            Self::Lsp => "lsp",
            Self::Media => "media",
            Self::Ports => "ports",
        }
    }
}

/// The app feed id.
pub const APP_FEED_ID: &str = "app";

/// A client's last position in a feed.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema, ts_rs::TS))]
pub struct FeedPosition {
    pub epoch: FeedEpoch,
    #[cfg_attr(feature = "codegen", ts(type = "number"))]
    pub seq: u64,
}

/// Closed window descriptor of a thread subscription (P §6.3).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema, ts_rs::TS))]
#[serde(untagged)]
pub enum ResumeWindow {
    /// Items of the newest turns up to n, 1 ≤ n ≤ 512.
    #[serde(rename_all = "camelCase")]
    LastItems { last_items: u16 },
    #[serde(rename_all = "camelCase")]
    LastTurns { last_turns: u16 },
    /// Header and runtime sections only; `none` is always `true`.
    None { none: bool },
}

/// Thread resume position: replay requires an equal window (P §6.3 rule 3).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema, ts_rs::TS))]
pub struct ThreadResumePosition {
    pub epoch: FeedEpoch,
    #[cfg_attr(feature = "codegen", ts(type = "number"))]
    pub seq: u64,
    pub window: ResumeWindow,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema, ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub enum SubscriptionMode {
    Replay,
    Snapshot,
}

/// The core's attach decision, the same object for every subscribing method.
/// Wire order after the response: replay frames or a snapshot at
/// `startSeq - 1`, then live events from `startSeq`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema, ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct Subscription {
    pub id: SubscriptionId,
    pub mode: SubscriptionMode,
    pub epoch: FeedEpoch,
    #[cfg_attr(feature = "codegen", ts(type = "number"))]
    pub start_seq: u64,
    /// The first seq published after this attach. A replay's frames are below it: they were published while the client was away
    /// (Node's relay sent a phone only what happened while it was connected). Absent from a core that predates it.
    #[serde(default)]
    #[cfg_attr(feature = "codegen", ts(type = "number"))]
    pub live_seq: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema, ts_rs::TS))]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "codegen", ts(optional_fields))]
pub struct AppSubscribeParams {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub resume_from: Option<FeedPosition>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema, ts_rs::TS))]
pub struct AppSubscribeResponse {
    pub subscription: Subscription,
}

/// Generic subscription to a scoped feed whose id the client already knows
/// (`login:<flowId>`, `media:<jobId>`, `lsp:<root>`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema, ts_rs::TS))]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "codegen", ts(optional_fields))]
pub struct FeedSubscribeParams {
    pub feed_id: FeedId,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub resume_from: Option<FeedPosition>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema, ts_rs::TS))]
pub struct FeedSubscribeResponse {
    pub subscription: Subscription,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema, ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct FeedUnsubscribeParams {
    pub feed_id: FeedId,
}

/// Empty result `{}`.
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema, ts_rs::TS))]
pub struct EmptyResult {}

/// `app/snapshot`: every unkeyed app section plus keyed sections bounded by
/// configuration (SPEC R14). Replaces the whole section store.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema, ts_rs::TS))]
pub struct AppSnapshotParams {
    pub sections: Vec<SectionUpdate>,
}

/// `feed/snapshot`: the read model of a scoped feed (terminal screen text,
/// search result set, login flow state, port list).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema, ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct FeedSnapshotParams {
    pub feed_id: FeedId,
    pub state: JsonValue,
}
