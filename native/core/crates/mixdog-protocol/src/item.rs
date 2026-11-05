//! Transcript items (P §5.3), tagged by `type`. Shared variants keep the
//! parity shape where the meaning is equal; Mixdog variants are added (X12). Every variant carries `id` and the common `meta`; `ext` holds
//! the remaining attributes of today's transcript row that the client fold
//! needs for field-for-field parity (P §14.12).

use schemars::JsonSchema;
use serde::Deserialize;
use serde::Serialize;
use ts_rs::TS;

use crate::BlobRef;
use crate::ItemId;
use crate::JsonObject;
use crate::JsonValue;
use crate::MaybeBlob;
use crate::ThreadId;
use crate::TurnId;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
pub enum ItemStatus {
    InProgress,
    Completed,
    Failed,
    Declined,
    Interrupted,
}

/// Attributes shared by every item (today's `DesktopTranscriptItem` common fields).
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
#[ts(optional_fields)]
pub struct ItemMeta {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub turn_id: Option<TurnId>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(type = "number")]
    pub at: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub status: Option<ItemStatus>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub label: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
    /// Human-readable model label.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    /// Actual route id.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub provider: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub agent: Option<String>,
    /// Remaining row attributes of today's transcript row.
    #[serde(default, skip_serializing_if = "JsonObject::is_empty")]
    pub ext: JsonObject,
}

/// One input element of a user message.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum UserInput {
    Text {
        text: String,
    },
    /// An image or file attachment, by content digest.
    #[serde(rename_all = "camelCase")]
    Attachment {
        blob: crate::BlobDescriptor,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        filename: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        original: Option<crate::BlobDescriptor>,
    },
    /// Pasted text kept out of line (today's `pastedTexts`).
    #[serde(rename_all = "camelCase")]
    PastedText {
        text: MaybeBlob<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        filename: Option<String>,
    },
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
pub struct FileUpdateChange {
    pub path: String,
    /// `add` | `delete` | `update` | `rename`.
    pub kind: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub old_path: Option<String>,
    pub diff: MaybeBlob<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum ThreadItem {
    #[serde(rename_all = "camelCase")]
    UserMessage {
        id: ItemId,
        content: Vec<UserInput>,
        /// Device that submitted the prompt (host-stamped).
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        device: Option<String>,
        /// The client correlation id of the submit.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        client_submission_id: Option<String>,
        /// The turn's change-record key (what review reads and reverts address).
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        checkpoint_id: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        applied_skills: Option<Vec<String>>,
        #[serde(default)]
        meta: ItemMeta,
    },
    #[serde(rename_all = "camelCase")]
    AgentMessage {
        id: ItemId,
        text: MaybeBlob<String>,
        #[serde(default)]
        meta: ItemMeta,
    },
    #[serde(rename_all = "camelCase")]
    Reasoning {
        id: ItemId,
        #[serde(default)]
        summary: Vec<String>,
        #[serde(default)]
        content: Vec<String>,
        #[serde(default)]
        meta: ItemMeta,
    },
    #[serde(rename_all = "camelCase")]
    Plan {
        id: ItemId,
        text: String,
        #[serde(default)]
        meta: ItemMeta,
    },
    /// The `shell` tool.
    #[serde(rename_all = "camelCase")]
    CommandExecution {
        id: ItemId,
        command: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        cwd: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        exit_code: Option<i32>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        output: Option<MaybeBlob<String>>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional, type = "number")]
        duration_ms: Option<i64>,
        #[serde(default)]
        meta: ItemMeta,
    },
    /// Patch and write tools.
    #[serde(rename_all = "camelCase")]
    FileChange {
        id: ItemId,
        changes: Vec<FileUpdateChange>,
        #[serde(default)]
        meta: ItemMeta,
    },
    #[serde(rename_all = "camelCase")]
    McpToolCall {
        id: ItemId,
        server: String,
        tool: String,
        arguments: JsonValue,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        result: Option<MaybeBlob<JsonValue>>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        error: Option<String>,
        #[serde(default)]
        meta: ItemMeta,
    },
    #[serde(rename_all = "camelCase")]
    WebSearch {
        id: ItemId,
        query: String,
        #[serde(default)]
        meta: ItemMeta,
    },
    #[serde(rename_all = "camelCase")]
    ImageView {
        id: ItemId,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        path: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        image: Option<BlobRef>,
        #[serde(default)]
        meta: ItemMeta,
    },
    #[serde(rename_all = "camelCase")]
    ContextCompaction {
        id: ItemId,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        summary: Option<MaybeBlob<String>>,
        #[serde(default)]
        meta: ItemMeta,
    },
    #[serde(rename_all = "camelCase")]
    SubAgentActivity {
        id: ItemId,
        agent: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        thread_id: Option<ThreadId>,
        #[serde(default)]
        meta: ItemMeta,
    },
    /// Every other built-in tool.
    #[serde(rename_all = "camelCase")]
    ToolCall {
        id: ItemId,
        name: String,
        input: JsonValue,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        output: Option<MaybeBlob<JsonValue>>,
        #[serde(default)]
        meta: ItemMeta,
    },
    /// `statusdone` / `turndone` rows and notices.
    #[serde(rename_all = "camelCase")]
    StatusRow {
        id: ItemId,
        kind: String,
        #[serde(default)]
        meta: ItemMeta,
    },
    /// A group-room line.
    #[serde(rename_all = "camelCase")]
    RoomRow {
        id: ItemId,
        speaker: String,
        text: MaybeBlob<String>,
        #[serde(default)]
        meta: ItemMeta,
    },
    /// A sub-agent dispatch row.
    #[serde(rename_all = "camelCase")]
    AgentJob {
        id: ItemId,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        tag: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        task_id: Option<String>,
        #[serde(default)]
        meta: ItemMeta,
    },
}

impl ThreadItem {
    pub fn id(&self) -> &ItemId {
        match self {
            Self::UserMessage { id, .. }
            | Self::AgentMessage { id, .. }
            | Self::Reasoning { id, .. }
            | Self::Plan { id, .. }
            | Self::CommandExecution { id, .. }
            | Self::FileChange { id, .. }
            | Self::McpToolCall { id, .. }
            | Self::WebSearch { id, .. }
            | Self::ImageView { id, .. }
            | Self::ContextCompaction { id, .. }
            | Self::SubAgentActivity { id, .. }
            | Self::ToolCall { id, .. }
            | Self::StatusRow { id, .. }
            | Self::RoomRow { id, .. }
            | Self::AgentJob { id, .. } => id,
        }
    }
}
