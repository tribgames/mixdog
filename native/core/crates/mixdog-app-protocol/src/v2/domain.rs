//! Hand-written params of domain methods whose shape is not a flat field
//! list: transfer sources (DS §4.7), the merged review read (DS §5.3), the
//! channel-bridge call (P §12.1) and `process/spawn` (DS §6.1).

use mixdog_protocol::JsonValue;
use mixdog_protocol::OpId;
use mixdog_protocol::ProcessHandle;
use mixdog_protocol::ThreadId;
use schemars::JsonSchema;
use serde::Deserialize;
use serde::Serialize;
use ts_rs::TS;

/// What a read transfer opens; the real path is verified after open.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum TransferSource {
    /// A project file (today's `fileDownload*`, `previewProjectFile`).
    File {
        root: String,
        rel: String,
    },
    /// An absolute path the connection may read (server windows, granted local files).
    LocalFile {
        path: String,
    },
    #[serde(rename_all = "camelCase")]
    MediaAsset {
        asset_id: String,
    },
    /// Today's `attachmentOpen`.
    #[serde(rename_all = "camelCase")]
    Attachment {
        thread_id: ThreadId,
        attachment_id: String,
    },
    Export {
        input: JsonValue,
    },
    /// A one-file grant minted for this paired device (`transfer/grant/mint`), redeemed with the path Node's file calls name (`projectPath` + `relPath`).
    #[serde(rename_all = "camelCase")]
    Granted {
        access_token: String,
        project_path: String,
        rel_path: String,
    },
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
pub struct TransferBeginReadParams {
    pub source: TransferSource,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
#[ts(optional_fields)]
pub struct TransferBeginReadResponse {
    pub transfer_id: mixdog_protocol::TransferId,
    #[ts(type = "number")]
    pub size: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mime_type: Option<String>,
    /// Domain detail of the opened entry (today's preview/download descriptor).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub entry: Option<JsonValue>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
pub enum ReviewScope {
    /// One turn's change record (`checkpointId`).
    Turn,
    /// The thread's whole change history.
    Session,
    /// A repository review (today's `gitReview*`).
    Repo,
}

/// One read for every review family (DS §5.3).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
#[ts(optional_fields)]
pub struct ReviewDiffGetParams {
    pub scope: ReviewScope,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub thread_id: Option<ThreadId>,
    /// Repository working directory for `repo`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cwd: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub checkpoint_id: Option<String>,
    /// One file's patch.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub old_path: Option<String>,
    /// Several files' patches (today's `gitReviewDiffs`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub files: Option<Vec<JsonValue>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub untracked: Option<bool>,
    /// `branch` | `worktree` | … (today's `GitReviewSource`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source: Option<String>,
    /// Include patches (today's `patch: true`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub patch: Option<bool>,
    /// The client's review key; an unchanged review answers `{unchanged:true}`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub known: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cursor: Option<String>,
    /// Leave the patch text out of a turn review (today's `getTurnReviewDiff {summary: true}`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub summary: Option<bool>,
}

/// Channel-bridge tool call (today's channel `POST /call`).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
pub struct ChannelCallParams {
    /// Today's `callId`.
    pub op_id: OpId,
    pub name: String,
    pub args: JsonValue,
}

impl ChannelCallParams {
    /// `args.sessionId`, which keys the call on that thread.
    pub fn thread_id(&self) -> Option<ThreadId> {
        self.args
            .get("sessionId")
            .and_then(JsonValue::as_str)
            .map(ThreadId::from)
    }
}

impl crate::common::HasOpId for ChannelCallParams {
    fn op_id(&self) -> &OpId {
        &self.op_id
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
pub struct PtySize {
    pub cols: u16,
    pub rows: u16,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
#[ts(optional_fields)]
pub struct ProcessSpawnParams {
    pub op_id: OpId,
    pub process_handle: ProcessHandle,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub argv: Option<Vec<String>>,
    /// A shell command line (instead of `argv`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub shell: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cwd: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub env: Option<std::collections::BTreeMap<String, String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pty: Option<PtySize>,
    /// `tool{threadId,toolCallId}` | `terminalTab{tabId}` | `lsp{root,lang}` | `internal`.
    pub owner: JsonValue,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub output_mode: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(type = "number")]
    pub timeout_ms: Option<u64>,
}

impl crate::common::HasOpId for ProcessSpawnParams {
    fn op_id(&self) -> &OpId {
        &self.op_id
    }
}
