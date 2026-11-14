//! Approval server requests and their resolution (P §8, SPEC R18, R41).
//! The `RequestId` of every approval request is the durable approval id
//! (a string); the response result is `ToolApprovalDecision`.

use mixdog_protocol::ApprovalResolution;
use mixdog_protocol::ItemId;
use mixdog_protocol::JsonValue;
use mixdog_protocol::OpId;
use mixdog_protocol::ThreadId;
use mixdog_protocol::TurnId;
use serde::Deserialize;
use serde::Serialize;

use crate::rpc::RequestId;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema, ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub enum ToolApprovalKind {
    Shell,
    Patch,
    Mcp,
    Builtin,
    Outbound,
    /// Human-in-the-loop gate (R41): response values of `ToolApprovalDecision.response`.
    HumanGate,
}

/// Fields every approval request carries.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema, ts_rs::TS))]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "codegen", ts(optional_fields))]
pub struct ApprovalEnvelope {
    pub thread_id: ThreadId,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub turn_id: Option<TurnId>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub item_id: Option<ItemId>,
    /// Top-level chat that shows a sub-agent's request.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub surface_thread_id: Option<ThreadId>,
    /// Delegation chain from the surface thread to the asking thread.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub chain: Option<Vec<ThreadId>>,
    #[cfg_attr(feature = "codegen", ts(type = "number"))]
    pub requested_at: i64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(feature = "codegen", ts(type = "number"))]
    pub expires_at: Option<i64>,
    /// Per-surface presentation order; the lowest is the active card (P §8.5).
    #[cfg_attr(feature = "codegen", ts(type = "number"))]
    pub order: u64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema, ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct ToolApprovalRequestParams {
    #[serde(flatten)]
    pub envelope: ApprovalEnvelope,
    pub kind: ToolApprovalKind,
    pub tool: String,
    /// The card content (tool input, editable fields, reason).
    pub request: JsonValue,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema, ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct UserInputRequestParams {
    #[serde(flatten)]
    pub envelope: ApprovalEnvelope,
    /// `ask_user` questions (including room hand-off questions).
    pub questions: Vec<JsonValue>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema, ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct PermissionsRequestParams {
    #[serde(flatten)]
    pub envelope: ApprovalEnvelope,
    /// Offered permission scopes.
    pub scopes: Vec<JsonValue>,
    pub request: JsonValue,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema, ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct BrowserApprovalRequestParams {
    #[serde(flatten)]
    pub envelope: ApprovalEnvelope,
    /// Form submit / Enter, send/post click, upload, … (policy is the core's).
    pub action: String,
    pub request: JsonValue,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema, ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct ComputerApprovalRequestParams {
    #[serde(flatten)]
    pub envelope: ApprovalEnvelope,
    pub request: JsonValue,
}

/// To every eligible connection, losers included (P §8.4 step 4); to the claimant alone, with an empty threadId and resolution cancelled, for a `host/*` request the core stopped waiting for without its answer (DS §12).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema, ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct ServerRequestResolvedParams {
    pub thread_id: ThreadId,
    pub request_id: RequestId,
    pub resolution: ApprovalResolution,
}

/// A phone notification's button on an approval (today's `answerApprovalNotification`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema, ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub enum ApprovalNotificationAction {
    Allow,
    Deny,
}

/// `thread/approval/answerNotification`: the approval the notification was about, in the thread it waits in.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema, ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct ThreadApprovalAnswerNotificationParams {
    pub thread_id: ThreadId,
    pub approval_id: String,
    pub action: ApprovalNotificationAction,
}

/// What came of the button: `answered` (this answer resolved the approval), `settled` (it was answered already),
/// `open` (Allow is not taken from a notification for it: the phone opens the app instead).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema, ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub enum ApprovalNotificationOutcome {
    Answered,
    Settled,
    Open,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema, ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct ThreadApprovalAnswerNotificationResponse {
    pub outcome: ApprovalNotificationOutcome,
}

/// `thread/approval/answer`: a card's decision on the approval request `approval_id` (the server request's id) of the thread it
/// waits in, the `result` a server-request response would carry.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema, ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct ThreadApprovalAnswerParams {
    pub thread_id: ThreadId,
    pub approval_id: String,
    pub result: JsonValue,
}

/// `accepted`: this decision resolved the request; `false` when it was resolved or resolving already (Node's
/// `resolveToolApprovalForSession` result).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema, ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct ThreadApprovalAnswerResponse {
    pub accepted: bool,
}

/// Secret answer of a human-gate `provide-secret` request (today's `provideSecretInput`);
/// never part of a decision or a log record.
#[derive(Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema, ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct ApprovalProvideSecretParams {
    pub op_id: OpId,
    pub request_id: RequestId,
    pub secret: String,
}

/// The secret never prints: a {:?} of the params (a log line, a panic message, a test failure)
/// shows the request and that a secret is held.
impl std::fmt::Debug for ApprovalProvideSecretParams {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ApprovalProvideSecretParams")
            .field("op_id", &self.op_id)
            .field("request_id", &self.request_id)
            .field("secret", &"<redacted>")
            .finish()
    }
}

impl crate::common::HasOpId for ApprovalProvideSecretParams {
    fn op_id(&self) -> &OpId {
        &self.op_id
    }
}
