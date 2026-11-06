//! Approval decisions (P X7) and resolutions (P §8.4).

use schemars::JsonSchema;
use serde::Deserialize;
use serde::Serialize;
use ts_rs::TS;

use crate::JsonValue;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "kebab-case")]
pub enum HumanGateResponse {
    Approve,
    Deny,
    EditAndApprove,
    ProvideSecret,
    Skip,
    Done,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
pub enum ApprovalRemember {
    Once,
    Session,
    Agent,
    Always,
}

/// One `ask_user` answer, aligned by index with the questions.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
#[ts(optional_fields)]
pub struct QuestionAnswer {
    pub selected: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub text: Option<String>,
}

/// Mixdog's `ToolApprovalDecision` without `device`: the core stamps the
/// device from the answering connection (P §8.1). The result type of every
/// approval server request.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
#[ts(optional_fields)]
pub struct ToolApprovalDecision {
    pub approved: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
    /// `ask_user` answers aligned with the questions; `null` = unanswered.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub answers: Option<Vec<Option<QuestionAnswer>>>,
    /// `ask_user`: the composer message that answered the question.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reply: Option<String>,
    /// Human-in-the-loop response; a secret value never travels here (`approval/provideSecret`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub response: Option<HumanGateResponse>,
    /// edit-and-approve: the edited text of the request's editable fields.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub edited_args: Option<std::collections::BTreeMap<String, String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub remember: Option<ApprovalRemember>,
    /// Permission requests: the chosen scope id.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub scope: Option<String>,
}

/// How the last approval of a thread ended (today's `toolApprovalResult`).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
#[ts(optional_fields)]
pub struct ToolApprovalResult {
    pub id: String,
    pub approved: bool,
    pub device: String,
    #[ts(type = "number")]
    pub at: i64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub expired: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub withdrawn: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub interrupted: Option<bool>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
pub enum ConnectionKind {
    Desktop,
    Tui,
    Cli,
    RemoteDesktop,
    Phone,
    ChannelBridge,
}

/// Durable outcome of a server request (P §8.4).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum ApprovalResolution {
    /// First valid decision from any eligible connection.
    #[serde(rename_all = "camelCase")]
    Decided {
        decision: ToolApprovalDecision,
        device: String,
        connection_kind: ConnectionKind,
        #[ts(type = "number")]
        at: i64,
    },
    /// The request's own `expiresAt` passed.
    #[serde(rename_all = "camelCase")]
    TimedOut {
        #[ts(type = "number")]
        at: i64,
    },
    /// Own-turn interrupt or session close.
    #[serde(rename_all = "camelCase")]
    Interrupted {
        #[ts(type = "number")]
        at: i64,
    },
    /// The asking run was cancelled from its parent.
    #[serde(rename_all = "camelCase")]
    Cancelled {
        #[ts(type = "number")]
        at: i64,
    },
    /// The copy shown on a surface was taken away unanswered.
    #[serde(rename_all = "camelCase")]
    Withdrawn {
        #[ts(type = "number")]
        at: i64,
    },
    /// The session has no approval surface (`approvalMode: "implicit"`, headless exec): nobody
    /// was asked and nothing was persisted.
    #[serde(rename_all = "camelCase")]
    Unavailable {
        #[ts(type = "number")]
        at: i64,
    },
}

/// Open request payload carried with an approval (tool input, question set, card fields).
pub type ApprovalPayload = JsonValue;
