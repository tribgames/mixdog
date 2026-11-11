//! Approval requests (P §8). One request record for every server-initiated
//! approval kind. Decisions and resolutions are the protocol types
//! (`ToolApprovalDecision` minus `device`, `ApprovalResolution`).

use std::time::Duration;
use std::time::SystemTime;

use async_trait::async_trait;
use mixdog_protocol::ApprovalPayload;
use mixdog_protocol::ApprovalRemember;
use mixdog_protocol::ApprovalResolution;
use mixdog_protocol::ThreadId;

use crate::ids::Method;
use crate::ids::ServerRequestId;
use mixdog_protocol::ToolCallId;

/// Durable, unique per data dir; the server request id is its decimal text.
#[derive(Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, Debug)]
pub struct ApprovalId(pub u64);

impl ApprovalId {
    pub fn request_id(self) -> ServerRequestId {
        ServerRequestId(self.0.to_string())
    }
}

/// Server request a pending approval is published as (P §8.1).
#[derive(Clone, Copy, PartialEq, Eq, Hash, Debug)]
pub enum ApprovalKind {
    Tool,
    /// `ask_user`, `handoff_user`.
    UserInput,
    Permissions,
    /// Human gate.
    Elicitation,
    Browser,
    Computer,
}

impl ApprovalKind {
    pub const fn method(self) -> Method {
        Method(match self {
            Self::Tool => "item/tool/requestApproval",
            Self::UserInput => "item/tool/requestUserInput",
            Self::Permissions => "item/permissions/requestApproval",
            Self::Elicitation => "mcpServer/elicitation/request",
            Self::Browser => "item/browser/requestApproval",
            Self::Computer => "item/computer/requestApproval",
        })
    }
}

/// Outbound action kinds a remembered grant is keyed by (`ACTION_KINDS`).
#[derive(Clone, Copy, PartialEq, Eq, Hash, Debug)]
pub enum ActionKind {
    Comment,
    Review,
    Message,
    Email,
    Publish,
    Form,
    Payment,
    Delete,
    Trash,
    BrowserSubmit,
    BrowserPost,
    BrowserUpload,
}

impl ActionKind {
    pub const ALL: [ActionKind; 12] = [
        Self::Comment,
        Self::Review,
        Self::Message,
        Self::Email,
        Self::Publish,
        Self::Form,
        Self::Payment,
        Self::Delete,
        Self::Trash,
        Self::BrowserSubmit,
        Self::BrowserPost,
        Self::BrowserUpload,
    ];

    /// Payments and permanent deletes always ask.
    pub const fn rememberable(self) -> bool {
        !matches!(self, Self::Payment | Self::Delete)
    }
}

/// One hop of a delegated request shown in a parent chat.
#[derive(Clone, PartialEq, Eq, Debug)]
pub struct ChainLink {
    pub thread_id: ThreadId,
    pub agent: Option<String>,
}

/// What a caller asks for. The owning session actor assigns id, surface,
/// chain, order and `requested_at`, persists `approval.requested`, then
/// publishes it.
#[derive(Clone, PartialEq, Debug)]
pub struct ApprovalAsk {
    pub kind: ApprovalKind,
    pub call_id: Option<ToolCallId>,
    pub tool: Option<String>,
    pub action_kind: Option<ActionKind>,
    pub reason: Option<String>,
    /// Kind-specific params (command, patch, questions, card fields).
    pub payload: ApprovalPayload,
    /// Remember scopes this request offers beyond `once`.
    pub remember: Vec<ApprovalRemember>,
    /// The request's own expiry, measured from `requested_at` (a data timer
    /// of the request, resolved `timedOut` by the actor's timer wheel).
    pub expires_after: Option<Duration>,
}

/// The persisted request record (`approval.requested`).
#[derive(Clone, PartialEq, Debug)]
pub struct ApprovalRequest {
    pub id: ApprovalId,
    pub thread_id: ThreadId,
    /// Top-level chat that shows the card.
    pub surface_thread_id: ThreadId,
    pub chain: Vec<ChainLink>,
    /// Per-surface presentation order (P §8.5).
    pub order: u64,
    pub requested_at: SystemTime,
    pub expires_at: Option<SystemTime>,
    pub ask: ApprovalAsk,
}

/// The owning session actor's approval entry point. Resolves with the
/// persisted resolution. Dropping the future does not resolve the request;
/// cancelling the asking run does (`cancelled`).
#[async_trait]
pub trait ApprovalGate: Send + Sync {
    async fn request(&self, ask: ApprovalAsk) -> ApprovalResolution;
}
