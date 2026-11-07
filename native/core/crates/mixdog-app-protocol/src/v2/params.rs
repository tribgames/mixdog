//! Flat params of domain methods (one struct per method, named `<Method>Params`).
//! Fields keep today's argument names; open values are `JsonValue` where
//! today's contract carries an open record. `threadId` on carried-over session
//! actions is today's `sessionId` addressing (absent = the control session).

#![allow(clippy::derive_partial_eq_without_eq)]

use mixdog_protocol::*;
use schemars::JsonSchema;
use serde::Deserialize;
use serde::Serialize;
use ts_rs::TS;

/// Params of `model/list`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
#[ts(optional_fields)]
pub struct ModelListParams {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub force: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub refresh: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub quick: Option<bool>,
}

/// Params of `feedback/upload`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
pub struct FeedbackUploadParams {
    pub op_id: OpId,
    pub input: JsonValue,
}

impl crate::common::HasOpId for FeedbackUploadParams {
    fn op_id(&self) -> &OpId {
        &self.op_id
    }
}

/// Params of `route/set`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(optional_fields)]
pub struct RouteSetParams {
    pub op_id: OpId,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub thread_id: Option<ThreadId>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub agent_id: Option<String>,
    pub route: JsonValue,
}

impl crate::common::HasOpId for RouteSetParams {
    fn op_id(&self) -> &OpId {
        &self.op_id
    }
}

/// Params of `fast/set`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(optional_fields)]
pub struct FastSetParams {
    pub op_id: OpId,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub thread_id: Option<ThreadId>,
    pub on: bool,
}

impl crate::common::HasOpId for FastSetParams {
    fn op_id(&self) -> &OpId {
        &self.op_id
    }
}

/// Params of `thread/contextStatus`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
#[ts(optional_fields)]
pub struct ThreadContextStatusParams {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub thread_id: Option<ThreadId>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub options: Option<JsonValue>,
}

/// Params of `thread/getSessionUsage`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
#[ts(optional_fields)]
pub struct ThreadGetSessionUsageParams {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub thread_id: Option<ThreadId>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub options: Option<JsonValue>,
}

/// Params of `thread/getSessionWorktreeWork`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
#[ts(optional_fields)]
pub struct ThreadGetSessionWorktreeWorkParams {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub thread_id: Option<ThreadId>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub input: Option<JsonValue>,
}

/// Params of `thread/inheritancePreflight`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
#[ts(optional_fields)]
pub struct ThreadInheritancePreflightParams {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub thread_id: Option<ThreadId>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source_thread_id: Option<ThreadId>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub selection: Option<JsonValue>,
}

/// Params of `thread/listShellJobs`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
#[ts(optional_fields)]
pub struct ThreadListShellJobsParams {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub thread_id: Option<ThreadId>,
}

/// Params of `thread/listStoppableShellJobs`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
#[ts(optional_fields)]
pub struct ThreadListStoppableShellJobsParams {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub thread_id: Option<ThreadId>,
}

/// Params of `thread/getBranchMenu`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
#[ts(optional_fields)]
pub struct ThreadGetBranchMenuParams {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub thread_id: Option<ThreadId>,
}

/// Params of `thread/askSide`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
#[ts(optional_fields)]
pub struct ThreadAskSideParams {
    pub op_id: OpId,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub thread_id: Option<ThreadId>,
    pub question: String,
}

impl crate::common::HasOpId for ThreadAskSideParams {
    fn op_id(&self) -> &OpId {
        &self.op_id
    }
}

/// Params of `thread/cancelSide`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
#[ts(optional_fields)]
pub struct ThreadCancelSideParams {
    pub op_id: OpId,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub thread_id: Option<ThreadId>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub target_thread_id: Option<ThreadId>,
}

impl crate::common::HasOpId for ThreadCancelSideParams {
    fn op_id(&self) -> &OpId {
        &self.op_id
    }
}

/// Params of `thread/agentControl`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
#[ts(optional_fields)]
pub struct ThreadAgentControlParams {
    pub op_id: OpId,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub thread_id: Option<ThreadId>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub args: Option<JsonValue>,
}

impl crate::common::HasOpId for ThreadAgentControlParams {
    fn op_id(&self) -> &OpId {
        &self.op_id
    }
}

/// Params of `thread/switchContext`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
#[ts(optional_fields)]
pub struct ThreadSwitchContextParams {
    pub op_id: OpId,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub thread_id: Option<ThreadId>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub input: Option<JsonValue>,
}

impl crate::common::HasOpId for ThreadSwitchContextParams {
    fn op_id(&self) -> &OpId {
        &self.op_id
    }
}

/// Params of `thread/setCwd`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(optional_fields)]
pub struct ThreadSetCwdParams {
    pub op_id: OpId,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub thread_id: Option<ThreadId>,
    pub path: String,
}

impl crate::common::HasOpId for ThreadSetCwdParams {
    fn op_id(&self) -> &OpId {
        &self.op_id
    }
}

/// Params of `thread/setEffort`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(optional_fields)]
pub struct ThreadSetEffortParams {
    pub op_id: OpId,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub thread_id: Option<ThreadId>,
    pub value: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub options: Option<JsonValue>,
}

impl crate::common::HasOpId for ThreadSetEffortParams {
    fn op_id(&self) -> &OpId {
        &self.op_id
    }
}

/// Params of `thread/setToolMode`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(optional_fields)]
pub struct ThreadSetToolModeParams {
    pub op_id: OpId,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub thread_id: Option<ThreadId>,
    pub mode: String,
}

impl crate::common::HasOpId for ThreadSetToolModeParams {
    fn op_id(&self) -> &OpId {
        &self.op_id
    }
}

/// Params of `thread/setWorkflow`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(optional_fields)]
pub struct ThreadSetWorkflowParams {
    pub op_id: OpId,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub thread_id: Option<ThreadId>,
    pub workflow_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub options: Option<JsonValue>,
}

impl crate::common::HasOpId for ThreadSetWorkflowParams {
    fn op_id(&self) -> &OpId {
        &self.op_id
    }
}

/// Params of `thread/setOrchestrationMode`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(optional_fields)]
pub struct ThreadSetOrchestrationModeParams {
    pub op_id: OpId,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub thread_id: Option<ThreadId>,
    pub mode: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub options: Option<JsonValue>,
}

impl crate::common::HasOpId for ThreadSetOrchestrationModeParams {
    fn op_id(&self) -> &OpId {
        &self.op_id
    }
}

/// Params of `thread/setOutputStyle`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(optional_fields)]
pub struct ThreadSetOutputStyleParams {
    pub op_id: OpId,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub thread_id: Option<ThreadId>,
    pub value: String,
}

impl crate::common::HasOpId for ThreadSetOutputStyleParams {
    fn op_id(&self) -> &OpId {
        &self.op_id
    }
}

/// Params of `thread/revertTurnReview`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
#[ts(optional_fields)]
pub struct ThreadRevertTurnReviewParams {
    pub op_id: OpId,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub thread_id: Option<ThreadId>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub checkpoint_id: Option<String>,
}

impl crate::common::HasOpId for ThreadRevertTurnReviewParams {
    fn op_id(&self) -> &OpId {
        &self.op_id
    }
}

/// Params of `thread/revertTurnReviewFile`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
#[ts(optional_fields)]
pub struct ThreadRevertTurnReviewFileParams {
    pub op_id: OpId,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub thread_id: Option<ThreadId>,
    pub file: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub checkpoint_id: Option<String>,
}

impl crate::common::HasOpId for ThreadRevertTurnReviewFileParams {
    fn op_id(&self) -> &OpId {
        &self.op_id
    }
}

/// Params of `thread/revertTurnChanges`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
#[ts(optional_fields)]
pub struct ThreadRevertTurnChangesParams {
    pub op_id: OpId,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub thread_id: Option<ThreadId>,
    pub checkpoint_id: String,
    pub file: JsonValue,
    #[ts(type = "number")]
    pub revision: i64,
}

impl crate::common::HasOpId for ThreadRevertTurnChangesParams {
    fn op_id(&self) -> &OpId {
        &self.op_id
    }
}

/// Params of `thread/reapplyTurnChanges`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
#[ts(optional_fields)]
pub struct ThreadReapplyTurnChangesParams {
    pub op_id: OpId,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub thread_id: Option<ThreadId>,
    pub checkpoint_id: String,
    pub file: JsonValue,
    #[ts(type = "number")]
    pub revision: i64,
}

impl crate::common::HasOpId for ThreadReapplyTurnChangesParams {
    fn op_id(&self) -> &OpId {
        &self.op_id
    }
}

/// Params of `thread/clearSessionChangeHistory`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
#[ts(optional_fields)]
pub struct ThreadClearSessionChangeHistoryParams {
    pub op_id: OpId,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub thread_id: Option<ThreadId>,
}

impl crate::common::HasOpId for ThreadClearSessionChangeHistoryParams {
    fn op_id(&self) -> &OpId {
        &self.op_id
    }
}

/// Params of `thread/stageAttachmentOriginal`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
#[ts(optional_fields)]
pub struct ThreadStageAttachmentOriginalParams {
    pub op_id: OpId,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub thread_id: Option<ThreadId>,
    pub input: JsonValue,
}

impl crate::common::HasOpId for ThreadStageAttachmentOriginalParams {
    fn op_id(&self) -> &OpId {
        &self.op_id
    }
}

/// Params of `thread/resizeImage`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
#[ts(optional_fields)]
pub struct ThreadResizeImageParams {
    pub op_id: OpId,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub thread_id: Option<ThreadId>,
    pub input: JsonValue,
}

impl crate::common::HasOpId for ThreadResizeImageParams {
    fn op_id(&self) -> &OpId {
        &self.op_id
    }
}

/// Params of `thread/pushNotice`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
#[ts(optional_fields)]
pub struct ThreadPushNoticeParams {
    pub op_id: OpId,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub thread_id: Option<ThreadId>,
    pub text: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub level: Option<String>,
}

impl crate::common::HasOpId for ThreadPushNoticeParams {
    fn op_id(&self) -> &OpId {
        &self.op_id
    }
}

/// Params of `thread/requestWorktree`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
#[ts(optional_fields)]
pub struct ThreadRequestWorktreeParams {
    pub op_id: OpId,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub thread_id: Option<ThreadId>,
    pub input: JsonValue,
}

impl crate::common::HasOpId for ThreadRequestWorktreeParams {
    fn op_id(&self) -> &OpId {
        &self.op_id
    }
}

/// Params of `thread/mergeWorkspace`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
#[ts(optional_fields)]
pub struct ThreadMergeWorkspaceParams {
    pub op_id: OpId,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub thread_id: Option<ThreadId>,
    pub input: JsonValue,
}

impl crate::common::HasOpId for ThreadMergeWorkspaceParams {
    fn op_id(&self) -> &OpId {
        &self.op_id
    }
}

/// Params of `thread/selectBranch`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
#[ts(optional_fields)]
pub struct ThreadSelectBranchParams {
    pub op_id: OpId,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub thread_id: Option<ThreadId>,
    pub input: JsonValue,
}

impl crate::common::HasOpId for ThreadSelectBranchParams {
    fn op_id(&self) -> &OpId {
        &self.op_id
    }
}

/// Params of `project/inspectProjectBranch`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
#[ts(optional_fields)]
pub struct ProjectInspectProjectBranchParams {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub thread_id: Option<ThreadId>,
    pub input: JsonValue,
}

/// Params of `project/getProjectBranchMenu`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
#[ts(optional_fields)]
pub struct ProjectGetProjectBranchMenuParams {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub thread_id: Option<ThreadId>,
    pub input: JsonValue,
}

/// Params of `project/getProjectConnectors`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
#[ts(optional_fields)]
pub struct ProjectGetProjectConnectorsParams {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub thread_id: Option<ThreadId>,
    pub project_path: String,
}

/// Params of `project/listWorktrees`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
#[ts(optional_fields)]
pub struct ProjectListWorktreesParams {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub thread_id: Option<ThreadId>,
}

/// Params of `project/previewWorktreeCleanup`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
#[ts(optional_fields)]
pub struct ProjectPreviewWorktreeCleanupParams {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub thread_id: Option<ThreadId>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub input: Option<JsonValue>,
}

/// Params of `project/selectProjectBranch`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
#[ts(optional_fields)]
pub struct ProjectSelectProjectBranchParams {
    pub op_id: OpId,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub thread_id: Option<ThreadId>,
    pub input: JsonValue,
}

impl crate::common::HasOpId for ProjectSelectProjectBranchParams {
    fn op_id(&self) -> &OpId {
        &self.op_id
    }
}

/// Params of `project/mergeProjectBranch`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
#[ts(optional_fields)]
pub struct ProjectMergeProjectBranchParams {
    pub op_id: OpId,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub thread_id: Option<ThreadId>,
    pub input: JsonValue,
}

impl crate::common::HasOpId for ProjectMergeProjectBranchParams {
    fn op_id(&self) -> &OpId {
        &self.op_id
    }
}

/// Params of `project/manageProjectBranch`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
#[ts(optional_fields)]
pub struct ProjectManageProjectBranchParams {
    pub op_id: OpId,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub thread_id: Option<ThreadId>,
    pub input: JsonValue,
}

impl crate::common::HasOpId for ProjectManageProjectBranchParams {
    fn op_id(&self) -> &OpId {
        &self.op_id
    }
}

/// Params of `project/removeWorktree`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
#[ts(optional_fields)]
pub struct ProjectRemoveWorktreeParams {
    pub op_id: OpId,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub thread_id: Option<ThreadId>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub input: Option<JsonValue>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub options: Option<JsonValue>,
}

impl crate::common::HasOpId for ProjectRemoveWorktreeParams {
    fn op_id(&self) -> &OpId {
        &self.op_id
    }
}

/// Params of `project/pruneWorktrees`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
#[ts(optional_fields)]
pub struct ProjectPruneWorktreesParams {
    pub op_id: OpId,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub thread_id: Option<ThreadId>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub input: Option<JsonValue>,
}

impl crate::common::HasOpId for ProjectPruneWorktreesParams {
    fn op_id(&self) -> &OpId {
        &self.op_id
    }
}

/// Params of `project/deleteWorktree`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
#[ts(optional_fields)]
pub struct ProjectDeleteWorktreeParams {
    pub op_id: OpId,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub thread_id: Option<ThreadId>,
    pub input: JsonValue,
}

impl crate::common::HasOpId for ProjectDeleteWorktreeParams {
    fn op_id(&self) -> &OpId {
        &self.op_id
    }
}

/// Params of `project/setArchivedSessionWorktrees`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(optional_fields)]
pub struct ProjectSetArchivedSessionWorktreesParams {
    pub op_id: OpId,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub thread_id: Option<ThreadId>,
    pub input: JsonValue,
}

impl crate::common::HasOpId for ProjectSetArchivedSessionWorktreesParams {
    fn op_id(&self) -> &OpId {
        &self.op_id
    }
}

/// Params of `project/setProjectConnectorEnabled`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(optional_fields)]
pub struct ProjectSetProjectConnectorEnabledParams {
    pub op_id: OpId,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub thread_id: Option<ThreadId>,
    pub project_path: String,
    pub connector_id: String,
    pub enabled: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub options: Option<JsonValue>,
}

impl crate::common::HasOpId for ProjectSetProjectConnectorEnabledParams {
    fn op_id(&self) -> &OpId {
        &self.op_id
    }
}

/// Params of `agent/agentDefinitionPresence`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
#[ts(optional_fields)]
pub struct AgentAgentDefinitionPresenceParams {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub thread_id: Option<ThreadId>,
    pub agent_ids: Vec<String>,
}

/// Params of `agent/archivedAgentIdentities`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
#[ts(optional_fields)]
pub struct AgentArchivedAgentIdentitiesParams {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub thread_id: Option<ThreadId>,
    pub agent_ids: Vec<String>,
}

/// Params of `agent/getAgentDefinition`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
#[ts(optional_fields)]
pub struct AgentGetAgentDefinitionParams {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub thread_id: Option<ThreadId>,
    pub agent_id: String,
}

/// Params of `agent/getAgentAvatarImage`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
#[ts(optional_fields)]
pub struct AgentGetAgentAvatarImageParams {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub thread_id: Option<ThreadId>,
    pub agent_id: String,
}

/// Params of `agent/getAgentConnectors`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
#[ts(optional_fields)]
pub struct AgentGetAgentConnectorsParams {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub thread_id: Option<ThreadId>,
    pub agent_id: String,
}

/// Params of `agent/getAgentAlwaysAllowedTools`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
#[ts(optional_fields)]
pub struct AgentGetAgentAlwaysAllowedToolsParams {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub thread_id: Option<ThreadId>,
    pub agent_id: String,
}

/// Params of `agent/getAgentConnectorTools`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
#[ts(optional_fields)]
pub struct AgentGetAgentConnectorToolsParams {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub thread_id: Option<ThreadId>,
    pub agent_id: String,
}

/// Params of `agent/getAgentPermissions`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
#[ts(optional_fields)]
pub struct AgentGetAgentPermissionsParams {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub thread_id: Option<ThreadId>,
    pub agent_id: String,
}

/// Params of `agent/getLeadPersona`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
#[ts(optional_fields)]
pub struct AgentGetLeadPersonaParams {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub thread_id: Option<ThreadId>,
}

/// Params of `agent/getLeadAgentBody`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
#[ts(optional_fields)]
pub struct AgentGetLeadAgentBodyParams {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub thread_id: Option<ThreadId>,
}

/// Params of `agent/getLeadStatus`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
#[ts(optional_fields)]
pub struct AgentGetLeadStatusParams {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub thread_id: Option<ThreadId>,
}

/// Params of `agent/getLeadHomeRoute`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
#[ts(optional_fields)]
pub struct AgentGetLeadHomeRouteParams {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub thread_id: Option<ThreadId>,
}

/// Params of `agent/getLeadAppearance`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
#[ts(optional_fields)]
pub struct AgentGetLeadAppearanceParams {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub thread_id: Option<ThreadId>,
}

/// Params of `agent/saveAgentDefinition`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
#[ts(optional_fields)]
pub struct AgentSaveAgentDefinitionParams {
    pub op_id: OpId,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub thread_id: Option<ThreadId>,
    pub payload: JsonValue,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub options: Option<JsonValue>,
}

impl crate::common::HasOpId for AgentSaveAgentDefinitionParams {
    fn op_id(&self) -> &OpId {
        &self.op_id
    }
}

/// Params of `agent/deleteAgentDefinition`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
#[ts(optional_fields)]
pub struct AgentDeleteAgentDefinitionParams {
    pub op_id: OpId,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub thread_id: Option<ThreadId>,
    pub agent_id: String,
}

impl crate::common::HasOpId for AgentDeleteAgentDefinitionParams {
    fn op_id(&self) -> &OpId {
        &self.op_id
    }
}

/// Params of `agent/restoreAgentDefinition`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
#[ts(optional_fields)]
pub struct AgentRestoreAgentDefinitionParams {
    pub op_id: OpId,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub thread_id: Option<ThreadId>,
    pub agent_id: String,
}

impl crate::common::HasOpId for AgentRestoreAgentDefinitionParams {
    fn op_id(&self) -> &OpId {
        &self.op_id
    }
}

/// Params of `agent/purgeAgentDefinition`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
#[ts(optional_fields)]
pub struct AgentPurgeAgentDefinitionParams {
    pub op_id: OpId,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub thread_id: Option<ThreadId>,
    pub agent_id: String,
}

impl crate::common::HasOpId for AgentPurgeAgentDefinitionParams {
    fn op_id(&self) -> &OpId {
        &self.op_id
    }
}

/// Params of `agent/setAgentConnectors`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(optional_fields)]
pub struct AgentSetAgentConnectorsParams {
    pub op_id: OpId,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub thread_id: Option<ThreadId>,
    pub agent_id: String,
    pub connectors: JsonValue,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub options: Option<JsonValue>,
}

impl crate::common::HasOpId for AgentSetAgentConnectorsParams {
    fn op_id(&self) -> &OpId {
        &self.op_id
    }
}

/// Params of `agent/setAgentConnectorEnabled`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(optional_fields)]
pub struct AgentSetAgentConnectorEnabledParams {
    pub op_id: OpId,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub thread_id: Option<ThreadId>,
    pub agent_id: String,
    pub connector_id: String,
    pub enabled: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub options: Option<JsonValue>,
}

impl crate::common::HasOpId for AgentSetAgentConnectorEnabledParams {
    fn op_id(&self) -> &OpId {
        &self.op_id
    }
}

/// Params of `agent/setAgentConnectorToolPermission`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(optional_fields)]
pub struct AgentSetAgentConnectorToolPermissionParams {
    pub op_id: OpId,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub thread_id: Option<ThreadId>,
    pub agent_id: String,
    pub connector_id: String,
    pub tool_name: String,
    pub permission: JsonValue,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub options: Option<JsonValue>,
}

impl crate::common::HasOpId for AgentSetAgentConnectorToolPermissionParams {
    fn op_id(&self) -> &OpId {
        &self.op_id
    }
}

/// Params of `agent/setAgentPermission`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(optional_fields)]
pub struct AgentSetAgentPermissionParams {
    pub op_id: OpId,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub thread_id: Option<ThreadId>,
    pub agent_id: String,
    pub action: String,
    pub mode: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub options: Option<JsonValue>,
}

impl crate::common::HasOpId for AgentSetAgentPermissionParams {
    fn op_id(&self) -> &OpId {
        &self.op_id
    }
}

/// Params of `agent/recordAgentApprovalAudit`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
#[ts(optional_fields)]
pub struct AgentRecordAgentApprovalAuditParams {
    pub op_id: OpId,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub thread_id: Option<ThreadId>,
    pub agent_id: String,
    pub action: String,
    pub decision: String,
}

impl crate::common::HasOpId for AgentRecordAgentApprovalAuditParams {
    fn op_id(&self) -> &OpId {
        &self.op_id
    }
}

/// Params of `agent/saveLeadPersona`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
#[ts(optional_fields)]
pub struct AgentSaveLeadPersonaParams {
    pub op_id: OpId,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub thread_id: Option<ThreadId>,
    pub text: String,
}

impl crate::common::HasOpId for AgentSaveLeadPersonaParams {
    fn op_id(&self) -> &OpId {
        &self.op_id
    }
}

/// Params of `agent/saveLeadAgentBody`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
#[ts(optional_fields)]
pub struct AgentSaveLeadAgentBodyParams {
    pub op_id: OpId,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub thread_id: Option<ThreadId>,
    pub text: String,
}

impl crate::common::HasOpId for AgentSaveLeadAgentBodyParams {
    fn op_id(&self) -> &OpId {
        &self.op_id
    }
}

/// Params of `agent/setLeadCreated`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(optional_fields)]
pub struct AgentSetLeadCreatedParams {
    pub op_id: OpId,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub thread_id: Option<ThreadId>,
    pub created: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
}

impl crate::common::HasOpId for AgentSetLeadCreatedParams {
    fn op_id(&self) -> &OpId {
        &self.op_id
    }
}

/// Params of `agent/saveLeadIdentity`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
#[ts(optional_fields)]
pub struct AgentSaveLeadIdentityParams {
    pub op_id: OpId,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub thread_id: Option<ThreadId>,
    pub payload: JsonValue,
}

impl crate::common::HasOpId for AgentSaveLeadIdentityParams {
    fn op_id(&self) -> &OpId {
        &self.op_id
    }
}

/// Params of `agent/setLeadAppearance`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(optional_fields)]
pub struct AgentSetLeadAppearanceParams {
    pub op_id: OpId,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub thread_id: Option<ThreadId>,
    pub avatar: JsonValue,
}

impl crate::common::HasOpId for AgentSetLeadAppearanceParams {
    fn op_id(&self) -> &OpId {
        &self.op_id
    }
}

/// Params of `config/getBotOrder`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
#[ts(optional_fields)]
pub struct ConfigGetBotOrderParams {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub thread_id: Option<ThreadId>,
}

/// The one bot order (Lead and Sessions bot lists): trimmed, de-duplicated agent ids, at most
/// 500. Mixy is pinned first by the UI and is not part of it. Empty means no stored order.
/// Result of `config/getBotOrder` and `config/setBotOrder`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema, TS)]
pub struct BotOrder {
    pub order: Vec<String>,
}

/// Params of `config/setBotOrder`. Node rejects more than 500 ids, or an id that is empty after
/// trimming or longer than 128, with `usage: setBotOrder(an array of agent ids)`; an empty
/// list clears the stored order.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(optional_fields)]
pub struct ConfigSetBotOrderParams {
    pub op_id: OpId,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub thread_id: Option<ThreadId>,
    pub order: Vec<String>,
}

impl crate::common::HasOpId for ConfigSetBotOrderParams {
    fn op_id(&self) -> &OpId {
        &self.op_id
    }
}

/// Params of `agent/home/open`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
pub struct AgentHomeOpenParams {
    pub op_id: OpId,
    pub agent_id: String,
}

impl crate::common::HasOpId for AgentHomeOpenParams {
    fn op_id(&self) -> &OpId {
        &self.op_id
    }
}

/// Params of `agent/home/reset`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
pub struct AgentHomeResetParams {
    pub op_id: OpId,
    pub agent_id: String,
}

impl crate::common::HasOpId for AgentHomeResetParams {
    fn op_id(&self) -> &OpId {
        &self.op_id
    }
}

/// Params of `agent/memory/list`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
pub struct AgentMemoryListParams {
    pub agent_id: String,
}

/// Params of `agent/memory/delete`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
pub struct AgentMemoryDeleteParams {
    pub op_id: OpId,
    pub agent_id: String,
    pub entry_id: String,
    pub index_revision: JsonValue,
}

impl crate::common::HasOpId for AgentMemoryDeleteParams {
    fn op_id(&self) -> &OpId {
        &self.op_id
    }
}

/// Params of `agent/pool/list`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
pub struct AgentPoolListParams {}

/// Params of `room/create`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
pub struct RoomCreateParams {
    pub op_id: OpId,
    pub input: JsonValue,
}

impl crate::common::HasOpId for RoomCreateParams {
    fn op_id(&self) -> &OpId {
        &self.op_id
    }
}

/// Params of `room/update`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RoomUpdateParams {
    pub op_id: OpId,
    pub input: JsonValue,
}

impl crate::common::HasOpId for RoomUpdateParams {
    fn op_id(&self) -> &OpId {
        &self.op_id
    }
}

/// Params of `room/continue`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
pub struct RoomContinueParams {
    pub op_id: OpId,
    pub input: JsonValue,
}

impl crate::common::HasOpId for RoomContinueParams {
    fn op_id(&self) -> &OpId {
        &self.op_id
    }
}

/// Params of `room/leave`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
pub struct RoomLeaveParams {
    pub op_id: OpId,
    pub input: JsonValue,
}

impl crate::common::HasOpId for RoomLeaveParams {
    fn op_id(&self) -> &OpId {
        &self.op_id
    }
}

/// Params of `room/remove`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
pub struct RoomRemoveParams {
    pub op_id: OpId,
    pub input: JsonValue,
}

impl crate::common::HasOpId for RoomRemoveParams {
    fn op_id(&self) -> &OpId {
        &self.op_id
    }
}

/// Params of `instructions/listInstructionFiles`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
#[ts(optional_fields)]
pub struct InstructionsListInstructionFilesParams {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub thread_id: Option<ThreadId>,
}

/// Params of `instructions/getInstructionFile`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
#[ts(optional_fields)]
pub struct InstructionsGetInstructionFileParams {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub thread_id: Option<ThreadId>,
    pub group: String,
    pub id: String,
}

/// Params of `instructions/saveInstructionFile`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
#[ts(optional_fields)]
pub struct InstructionsSaveInstructionFileParams {
    pub op_id: OpId,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub thread_id: Option<ThreadId>,
    pub input: JsonValue,
}

impl crate::common::HasOpId for InstructionsSaveInstructionFileParams {
    fn op_id(&self) -> &OpId {
        &self.op_id
    }
}

/// Params of `instructions/resetInstructionFile`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
#[ts(optional_fields)]
pub struct InstructionsResetInstructionFileParams {
    pub op_id: OpId,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub thread_id: Option<ThreadId>,
    pub group: String,
    pub id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub expected_revision: Option<JsonValue>,
}

impl crate::common::HasOpId for InstructionsResetInstructionFileParams {
    fn op_id(&self) -> &OpId {
        &self.op_id
    }
}

/// Params of `instructions/setInstructionFiles`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(optional_fields)]
pub struct InstructionsSetInstructionFilesParams {
    pub op_id: OpId,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub thread_id: Option<ThreadId>,
    pub mode: String,
}

impl crate::common::HasOpId for InstructionsSetInstructionFilesParams {
    fn op_id(&self) -> &OpId {
        &self.op_id
    }
}

/// Params of `connector/listConnectorTools`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
#[ts(optional_fields)]
pub struct ConnectorListConnectorToolsParams {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub thread_id: Option<ThreadId>,
    pub connector_id: String,
}

/// Params of `connector/addConnectorAccount`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
#[ts(optional_fields)]
pub struct ConnectorAddConnectorAccountParams {
    pub op_id: OpId,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub thread_id: Option<ThreadId>,
    pub input: JsonValue,
}

impl crate::common::HasOpId for ConnectorAddConnectorAccountParams {
    fn op_id(&self) -> &OpId {
        &self.op_id
    }
}

/// Params of `config/getAutoClear`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
#[ts(optional_fields)]
pub struct ConfigGetAutoClearParams {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub thread_id: Option<ThreadId>,
}

/// Params of `config/getCacheWarmingSettings`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
#[ts(optional_fields)]
pub struct ConfigGetCacheWarmingSettingsParams {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub thread_id: Option<ThreadId>,
}

/// Params of `config/getCompactionSettings`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
#[ts(optional_fields)]
pub struct ConfigGetCompactionSettingsParams {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub thread_id: Option<ThreadId>,
}

/// Params of `config/getDeveloperSettings`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
#[ts(optional_fields)]
pub struct ConfigGetDeveloperSettingsParams {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub thread_id: Option<ThreadId>,
}

/// Params of `config/getOutputStyle`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
#[ts(optional_fields)]
pub struct ConfigGetOutputStyleParams {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub thread_id: Option<ThreadId>,
}

/// Params of `config/getOrchestrationMode`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
#[ts(optional_fields)]
pub struct ConfigGetOrchestrationModeParams {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub thread_id: Option<ThreadId>,
}

/// Params of `config/getConfiguredOrchestrationMode`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
#[ts(optional_fields)]
pub struct ConfigGetConfiguredOrchestrationModeParams {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub thread_id: Option<ThreadId>,
}

/// Params of `config/getProfile`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
#[ts(optional_fields)]
pub struct ConfigGetProfileParams {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub thread_id: Option<ThreadId>,
}

/// Params of `config/getRecapSettings`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
#[ts(optional_fields)]
pub struct ConfigGetRecapSettingsParams {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub thread_id: Option<ThreadId>,
}

/// Params of `config/getSessionTitleSettings`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
#[ts(optional_fields)]
pub struct ConfigGetSessionTitleSettingsParams {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub thread_id: Option<ThreadId>,
}

/// Params of `config/getHeartbeatSettings`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
#[ts(optional_fields)]
pub struct ConfigGetHeartbeatSettingsParams {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub thread_id: Option<ThreadId>,
}

/// Params of `config/getReactionSettings`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
#[ts(optional_fields)]
pub struct ConfigGetReactionSettingsParams {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub thread_id: Option<ThreadId>,
}

/// Params of `config/getSystemShell`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
#[ts(optional_fields)]
pub struct ConfigGetSystemShellParams {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub thread_id: Option<ThreadId>,
}

/// Params of `config/getTheme`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
#[ts(optional_fields)]
pub struct ConfigGetThemeParams {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub thread_id: Option<ThreadId>,
}

/// Params of `config/getToolModuleSettings`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
#[ts(optional_fields)]
pub struct ConfigGetToolModuleSettingsParams {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub thread_id: Option<ThreadId>,
}

/// Params of `config/getUpdateSettings`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
#[ts(optional_fields)]
pub struct ConfigGetUpdateSettingsParams {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub thread_id: Option<ThreadId>,
}

/// Params of `config/getWorktreeSettings`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
#[ts(optional_fields)]
pub struct ConfigGetWorktreeSettingsParams {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub thread_id: Option<ThreadId>,
}

/// Params of `config/listOutputStyles`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
#[ts(optional_fields)]
pub struct ConfigListOutputStylesParams {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub thread_id: Option<ThreadId>,
}

/// Params of `config/getNetworkProxy`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
#[ts(optional_fields)]
pub struct ConfigGetNetworkProxyParams {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub thread_id: Option<ThreadId>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub options: Option<JsonValue>,
}

/// Params of `config/testNetworkProxy`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
#[ts(optional_fields)]
pub struct ConfigTestNetworkProxyParams {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub thread_id: Option<ThreadId>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub options: Option<JsonValue>,
}

/// Params of `config/getWorkflowPack`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
#[ts(optional_fields)]
pub struct ConfigGetWorkflowPackParams {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub thread_id: Option<ThreadId>,
    pub workflow_id: String,
}

/// Params of `config/isSetupRequestActive`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
#[ts(optional_fields)]
pub struct ConfigIsSetupRequestActiveParams {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub thread_id: Option<ThreadId>,
    pub id: String,
    pub owner: String,
}

/// Params of `config/setAutoUpdate`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(optional_fields)]
pub struct ConfigSetAutoUpdateParams {
    pub op_id: OpId,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub thread_id: Option<ThreadId>,
    pub enabled: bool,
}

impl crate::common::HasOpId for ConfigSetAutoUpdateParams {
    fn op_id(&self) -> &OpId {
        &self.op_id
    }
}

/// Params of `config/setCacheWarmingEnabled`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(optional_fields)]
pub struct ConfigSetCacheWarmingEnabledParams {
    pub op_id: OpId,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub thread_id: Option<ThreadId>,
    pub enabled: bool,
}

impl crate::common::HasOpId for ConfigSetCacheWarmingEnabledParams {
    fn op_id(&self) -> &OpId {
        &self.op_id
    }
}

/// Params of `config/setRecapEnabled`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(optional_fields)]
pub struct ConfigSetRecapEnabledParams {
    pub op_id: OpId,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub thread_id: Option<ThreadId>,
    pub enabled: bool,
}

impl crate::common::HasOpId for ConfigSetRecapEnabledParams {
    fn op_id(&self) -> &OpId {
        &self.op_id
    }
}

/// Params of `config/setAiSessionTitles`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(optional_fields)]
pub struct ConfigSetAiSessionTitlesParams {
    pub op_id: OpId,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub thread_id: Option<ThreadId>,
    pub enabled: bool,
}

impl crate::common::HasOpId for ConfigSetAiSessionTitlesParams {
    fn op_id(&self) -> &OpId {
        &self.op_id
    }
}

/// Params of `config/setHeartbeatEnabled`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(optional_fields)]
pub struct ConfigSetHeartbeatEnabledParams {
    pub op_id: OpId,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub thread_id: Option<ThreadId>,
    pub enabled: bool,
}

impl crate::common::HasOpId for ConfigSetHeartbeatEnabledParams {
    fn op_id(&self) -> &OpId {
        &self.op_id
    }
}

/// Params of `config/setReactionsEnabled`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(optional_fields)]
pub struct ConfigSetReactionsEnabledParams {
    pub op_id: OpId,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub thread_id: Option<ThreadId>,
    pub enabled: bool,
}

impl crate::common::HasOpId for ConfigSetReactionsEnabledParams {
    fn op_id(&self) -> &OpId {
        &self.op_id
    }
}

/// Params of `config/setWebSearchEnabled`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(optional_fields)]
pub struct ConfigSetWebSearchEnabledParams {
    pub op_id: OpId,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub thread_id: Option<ThreadId>,
    pub enabled: bool,
}

impl crate::common::HasOpId for ConfigSetWebSearchEnabledParams {
    fn op_id(&self) -> &OpId {
        &self.op_id
    }
}

/// Params of `config/setMemoryToolsEnabled`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(optional_fields)]
pub struct ConfigSetMemoryToolsEnabledParams {
    pub op_id: OpId,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub thread_id: Option<ThreadId>,
    pub enabled: bool,
}

impl crate::common::HasOpId for ConfigSetMemoryToolsEnabledParams {
    fn op_id(&self) -> &OpId {
        &self.op_id
    }
}

/// Params of `config/setAutoClear`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(optional_fields)]
pub struct ConfigSetAutoClearParams {
    pub op_id: OpId,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub thread_id: Option<ThreadId>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub input: Option<JsonValue>,
}

impl crate::common::HasOpId for ConfigSetAutoClearParams {
    fn op_id(&self) -> &OpId {
        &self.op_id
    }
}

/// Params of `config/setCompactionSettings`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(optional_fields)]
pub struct ConfigSetCompactionSettingsParams {
    pub op_id: OpId,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub thread_id: Option<ThreadId>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub input: Option<JsonValue>,
}

impl crate::common::HasOpId for ConfigSetCompactionSettingsParams {
    fn op_id(&self) -> &OpId {
        &self.op_id
    }
}

/// Params of `config/setDeveloperOption`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(optional_fields)]
pub struct ConfigSetDeveloperOptionParams {
    pub op_id: OpId,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub thread_id: Option<ThreadId>,
    pub id: String,
    pub enabled: bool,
}

impl crate::common::HasOpId for ConfigSetDeveloperOptionParams {
    fn op_id(&self) -> &OpId {
        &self.op_id
    }
}

/// Params of `config/setProfile`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(optional_fields)]
pub struct ConfigSetProfileParams {
    pub op_id: OpId,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub thread_id: Option<ThreadId>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub input: Option<JsonValue>,
}

impl crate::common::HasOpId for ConfigSetProfileParams {
    fn op_id(&self) -> &OpId {
        &self.op_id
    }
}

/// Params of `config/setHeartbeatInterval`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(optional_fields)]
pub struct ConfigSetHeartbeatIntervalParams {
    pub op_id: OpId,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub thread_id: Option<ThreadId>,
    #[ts(type = "number")]
    pub minutes: i64,
}

impl crate::common::HasOpId for ConfigSetHeartbeatIntervalParams {
    fn op_id(&self) -> &OpId {
        &self.op_id
    }
}

/// Params of `config/setSystemShell`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(optional_fields)]
pub struct ConfigSetSystemShellParams {
    pub op_id: OpId,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub thread_id: Option<ThreadId>,
    pub input: JsonValue,
}

impl crate::common::HasOpId for ConfigSetSystemShellParams {
    fn op_id(&self) -> &OpId {
        &self.op_id
    }
}

/// Params of `config/setTheme`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(optional_fields)]
pub struct ConfigSetThemeParams {
    pub op_id: OpId,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub thread_id: Option<ThreadId>,
    pub id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub options: Option<JsonValue>,
}

impl crate::common::HasOpId for ConfigSetThemeParams {
    fn op_id(&self) -> &OpId {
        &self.op_id
    }
}

/// Params of `config/setWebSearchRoute`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(optional_fields)]
pub struct ConfigSetWebSearchRouteParams {
    pub op_id: OpId,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub thread_id: Option<ThreadId>,
    pub next: JsonValue,
}

impl crate::common::HasOpId for ConfigSetWebSearchRouteParams {
    fn op_id(&self) -> &OpId {
        &self.op_id
    }
}

/// Params of `config/setAutoEffortBase`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(optional_fields)]
pub struct ConfigSetAutoEffortBaseParams {
    pub op_id: OpId,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub thread_id: Option<ThreadId>,
    pub level: String,
}

impl crate::common::HasOpId for ConfigSetAutoEffortBaseParams {
    fn op_id(&self) -> &OpId {
        &self.op_id
    }
}

/// Params of `config/setBuiltinToolEnabled`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(optional_fields)]
pub struct ConfigSetBuiltinToolEnabledParams {
    pub op_id: OpId,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub thread_id: Option<ThreadId>,
    pub name: String,
    pub enabled: bool,
}

impl crate::common::HasOpId for ConfigSetBuiltinToolEnabledParams {
    fn op_id(&self) -> &OpId {
        &self.op_id
    }
}

/// Params of `config/installBuiltinFeature`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
#[ts(optional_fields)]
pub struct ConfigInstallBuiltinFeatureParams {
    pub op_id: OpId,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub thread_id: Option<ThreadId>,
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub options: Option<JsonValue>,
}

impl crate::common::HasOpId for ConfigInstallBuiltinFeatureParams {
    fn op_id(&self) -> &OpId {
        &self.op_id
    }
}

/// Params of `config/setWorktreeSettings`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(optional_fields)]
pub struct ConfigSetWorktreeSettingsParams {
    pub op_id: OpId,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub thread_id: Option<ThreadId>,
    pub patch: JsonValue,
}

impl crate::common::HasOpId for ConfigSetWorktreeSettingsParams {
    fn op_id(&self) -> &OpId {
        &self.op_id
    }
}

/// Params of `config/setNetworkProxy`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(optional_fields)]
pub struct ConfigSetNetworkProxyParams {
    pub op_id: OpId,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub thread_id: Option<ThreadId>,
    pub patch: JsonValue,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub options: Option<JsonValue>,
}

impl crate::common::HasOpId for ConfigSetNetworkProxyParams {
    fn op_id(&self) -> &OpId {
        &self.op_id
    }
}

/// Params of `config/saveWorkflowPack`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
#[ts(optional_fields)]
pub struct ConfigSaveWorkflowPackParams {
    pub op_id: OpId,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub thread_id: Option<ThreadId>,
    pub payload: JsonValue,
}

impl crate::common::HasOpId for ConfigSaveWorkflowPackParams {
    fn op_id(&self) -> &OpId {
        &self.op_id
    }
}

/// Params of `config/createWorkflow`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
#[ts(optional_fields)]
pub struct ConfigCreateWorkflowParams {
    pub op_id: OpId,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub thread_id: Option<ThreadId>,
    pub payload: JsonValue,
}

impl crate::common::HasOpId for ConfigCreateWorkflowParams {
    fn op_id(&self) -> &OpId {
        &self.op_id
    }
}

/// Params of `config/deleteWorkflow`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
#[ts(optional_fields)]
pub struct ConfigDeleteWorkflowParams {
    pub op_id: OpId,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub thread_id: Option<ThreadId>,
    pub workflow_id: String,
}

impl crate::common::HasOpId for ConfigDeleteWorkflowParams {
    fn op_id(&self) -> &OpId {
        &self.op_id
    }
}

/// Params of `config/setModelPreferences`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(optional_fields)]
pub struct ConfigSetModelPreferencesParams {
    pub op_id: OpId,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub thread_id: Option<ThreadId>,
    pub provider_id: String,
    pub changes: JsonValue,
}

impl crate::common::HasOpId for ConfigSetModelPreferencesParams {
    fn op_id(&self) -> &OpId {
        &self.op_id
    }
}

/// Params of `config/skipOnboarding`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
#[ts(optional_fields)]
pub struct ConfigSkipOnboardingParams {
    pub op_id: OpId,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub thread_id: Option<ThreadId>,
}

impl crate::common::HasOpId for ConfigSkipOnboardingParams {
    fn op_id(&self) -> &OpId {
        &self.op_id
    }
}

/// Params of `config/completeOnboarding`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
#[ts(optional_fields)]
pub struct ConfigCompleteOnboardingParams {
    pub op_id: OpId,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub thread_id: Option<ThreadId>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub payload: Option<JsonValue>,
}

impl crate::common::HasOpId for ConfigCompleteOnboardingParams {
    fn op_id(&self) -> &OpId {
        &self.op_id
    }
}

/// Params of `config/saveStarterGuideState`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
#[ts(optional_fields)]
pub struct ConfigSaveStarterGuideStateParams {
    pub op_id: OpId,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub thread_id: Option<ThreadId>,
    pub state: JsonValue,
}

impl crate::common::HasOpId for ConfigSaveStarterGuideStateParams {
    fn op_id(&self) -> &OpId {
        &self.op_id
    }
}

/// Params of `config/claimSetupRequest`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
#[ts(optional_fields)]
pub struct ConfigClaimSetupRequestParams {
    pub op_id: OpId,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub thread_id: Option<ThreadId>,
    pub id: String,
    pub owner: String,
}

impl crate::common::HasOpId for ConfigClaimSetupRequestParams {
    fn op_id(&self) -> &OpId {
        &self.op_id
    }
}

/// Params of `config/completeSetupRequest`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
#[ts(optional_fields)]
pub struct ConfigCompleteSetupRequestParams {
    pub op_id: OpId,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub thread_id: Option<ThreadId>,
    pub id: String,
    pub owner: String,
    pub receipt: JsonValue,
}

impl crate::common::HasOpId for ConfigCompleteSetupRequestParams {
    fn op_id(&self) -> &OpId {
        &self.op_id
    }
}

/// Params of `config/setExtensionScope`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(optional_fields)]
pub struct ConfigSetExtensionScopeParams {
    pub op_id: OpId,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub thread_id: Option<ThreadId>,
    pub kind: String,
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub projects: Option<Vec<String>>,
}

impl crate::common::HasOpId for ConfigSetExtensionScopeParams {
    fn op_id(&self) -> &OpId {
        &self.op_id
    }
}

/// Params of `channel/getChannelSettings`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
#[ts(optional_fields)]
pub struct ChannelGetChannelSettingsParams {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub thread_id: Option<ThreadId>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub options: Option<JsonValue>,
}

/// Params of `channel/getChannelSetup`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
#[ts(optional_fields)]
pub struct ChannelGetChannelSetupParams {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub thread_id: Option<ThreadId>,
}

/// Params of `channel/getChannelWorkerStatus`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
#[ts(optional_fields)]
pub struct ChannelGetChannelWorkerStatusParams {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub thread_id: Option<ThreadId>,
}

/// Params of `channel/setWebhookConfig`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(optional_fields)]
pub struct ChannelSetWebhookConfigParams {
    pub op_id: OpId,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub thread_id: Option<ThreadId>,
    pub patch: JsonValue,
}

impl crate::common::HasOpId for ChannelSetWebhookConfigParams {
    fn op_id(&self) -> &OpId {
        &self.op_id
    }
}

/// Params of `channel/saveSchedule`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
#[ts(optional_fields)]
pub struct ChannelSaveScheduleParams {
    pub op_id: OpId,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub thread_id: Option<ThreadId>,
    pub entry: JsonValue,
}

impl crate::common::HasOpId for ChannelSaveScheduleParams {
    fn op_id(&self) -> &OpId {
        &self.op_id
    }
}

/// Params of `channel/deleteSchedule`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
#[ts(optional_fields)]
pub struct ChannelDeleteScheduleParams {
    pub op_id: OpId,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub thread_id: Option<ThreadId>,
    pub name: String,
}

impl crate::common::HasOpId for ChannelDeleteScheduleParams {
    fn op_id(&self) -> &OpId {
        &self.op_id
    }
}

/// Params of `channel/setScheduleEnabled`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(optional_fields)]
pub struct ChannelSetScheduleEnabledParams {
    pub op_id: OpId,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub thread_id: Option<ThreadId>,
    pub name: String,
    pub enabled: bool,
}

impl crate::common::HasOpId for ChannelSetScheduleEnabledParams {
    fn op_id(&self) -> &OpId {
        &self.op_id
    }
}

/// Params of `channel/runScheduleNow`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
#[ts(optional_fields)]
pub struct ChannelRunScheduleNowParams {
    pub op_id: OpId,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub thread_id: Option<ThreadId>,
    pub name: String,
}

impl crate::common::HasOpId for ChannelRunScheduleNowParams {
    fn op_id(&self) -> &OpId {
        &self.op_id
    }
}

/// Params of `channel/runWebhookNow`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
#[ts(optional_fields)]
pub struct ChannelRunWebhookNowParams {
    pub op_id: OpId,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub thread_id: Option<ThreadId>,
    pub name: String,
}

impl crate::common::HasOpId for ChannelRunWebhookNowParams {
    fn op_id(&self) -> &OpId {
        &self.op_id
    }
}

/// Params of `channel/retryRoutineDelivery`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
#[ts(optional_fields)]
pub struct ChannelRetryRoutineDeliveryParams {
    pub op_id: OpId,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub thread_id: Option<ThreadId>,
    pub kind: String,
    pub name: String,
}

impl crate::common::HasOpId for ChannelRetryRoutineDeliveryParams {
    fn op_id(&self) -> &OpId {
        &self.op_id
    }
}

/// Params of `channel/testWebhook`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
#[ts(optional_fields)]
pub struct ChannelTestWebhookParams {
    pub op_id: OpId,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub thread_id: Option<ThreadId>,
    pub name: String,
}

impl crate::common::HasOpId for ChannelTestWebhookParams {
    fn op_id(&self) -> &OpId {
        &self.op_id
    }
}

/// Params of `channel/saveWebhook`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
#[ts(optional_fields)]
pub struct ChannelSaveWebhookParams {
    pub op_id: OpId,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub thread_id: Option<ThreadId>,
    pub entry: JsonValue,
}

impl crate::common::HasOpId for ChannelSaveWebhookParams {
    fn op_id(&self) -> &OpId {
        &self.op_id
    }
}

/// Params of `channel/deleteWebhook`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
#[ts(optional_fields)]
pub struct ChannelDeleteWebhookParams {
    pub op_id: OpId,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub thread_id: Option<ThreadId>,
    pub name: String,
}

impl crate::common::HasOpId for ChannelDeleteWebhookParams {
    fn op_id(&self) -> &OpId {
        &self.op_id
    }
}

/// Params of `channel/setWebhookEnabled`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(optional_fields)]
pub struct ChannelSetWebhookEnabledParams {
    pub op_id: OpId,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub thread_id: Option<ThreadId>,
    pub name: String,
    pub enabled: bool,
}

impl crate::common::HasOpId for ChannelSetWebhookEnabledParams {
    fn op_id(&self) -> &OpId {
        &self.op_id
    }
}

/// Params of `import/getConversationImportJobs`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
#[ts(optional_fields)]
pub struct ImportGetConversationImportJobsParams {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub thread_id: Option<ThreadId>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub params: Option<JsonValue>,
}

/// Params of `import/listImportableConversations`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
#[ts(optional_fields)]
pub struct ImportListImportableConversationsParams {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub thread_id: Option<ThreadId>,
    pub params: JsonValue,
}

/// Params of `import/startConversationImport`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
#[ts(optional_fields)]
pub struct ImportStartConversationImportParams {
    pub op_id: OpId,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub thread_id: Option<ThreadId>,
    pub params: JsonValue,
}

impl crate::common::HasOpId for ImportStartConversationImportParams {
    fn op_id(&self) -> &OpId {
        &self.op_id
    }
}

/// Params of `import/cancelConversationImport`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
#[ts(optional_fields)]
pub struct ImportCancelConversationImportParams {
    pub op_id: OpId,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub thread_id: Option<ThreadId>,
    pub params: JsonValue,
}

impl crate::common::HasOpId for ImportCancelConversationImportParams {
    fn op_id(&self) -> &OpId {
        &self.op_id
    }
}

/// Params of `import/registerConversationImportFile`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
#[ts(optional_fields)]
pub struct ImportRegisterConversationImportFileParams {
    pub op_id: OpId,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub thread_id: Option<ThreadId>,
    pub params: JsonValue,
}

impl crate::common::HasOpId for ImportRegisterConversationImportFileParams {
    fn op_id(&self) -> &OpId {
        &self.op_id
    }
}

/// Params of `media/getMediaDefault`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
#[ts(optional_fields)]
pub struct MediaGetMediaDefaultParams {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub thread_id: Option<ThreadId>,
    pub kind: String,
}

/// Params of `media/getMediaJob`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
#[ts(optional_fields)]
pub struct MediaGetMediaJobParams {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub thread_id: Option<ThreadId>,
    pub id: String,
}

/// Params of `media/getMediaPins`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
#[ts(optional_fields)]
pub struct MediaGetMediaPinsParams {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub thread_id: Option<ThreadId>,
}

/// Params of `media/listMediaAssets`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
#[ts(optional_fields)]
pub struct MediaListMediaAssetsParams {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub thread_id: Option<ThreadId>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub options: Option<JsonValue>,
}

/// Params of `media/listMediaBoards`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
#[ts(optional_fields)]
pub struct MediaListMediaBoardsParams {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub thread_id: Option<ThreadId>,
}

/// Params of `media/listMediaLanes`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
#[ts(optional_fields)]
pub struct MediaListMediaLanesParams {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub thread_id: Option<ThreadId>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub options: Option<JsonValue>,
}

/// Params of `media/readMediaAsset`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
#[ts(optional_fields)]
pub struct MediaReadMediaAssetParams {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub thread_id: Option<ThreadId>,
    pub id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub options: Option<JsonValue>,
}

/// Params of `media/resolveMediaFile`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
#[ts(optional_fields)]
pub struct MediaResolveMediaFileParams {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub thread_id: Option<ThreadId>,
    pub id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub options: Option<JsonValue>,
}

/// Params of `media/startMediaJob`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
#[ts(optional_fields)]
pub struct MediaStartMediaJobParams {
    pub op_id: OpId,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub thread_id: Option<ThreadId>,
    pub input: JsonValue,
}

impl crate::common::HasOpId for MediaStartMediaJobParams {
    fn op_id(&self) -> &OpId {
        &self.op_id
    }
}

/// Params of `media/cancelMediaJob`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
#[ts(optional_fields)]
pub struct MediaCancelMediaJobParams {
    pub op_id: OpId,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub thread_id: Option<ThreadId>,
    pub id: String,
}

impl crate::common::HasOpId for MediaCancelMediaJobParams {
    fn op_id(&self) -> &OpId {
        &self.op_id
    }
}

/// Params of `media/deleteMediaAsset`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
#[ts(optional_fields)]
pub struct MediaDeleteMediaAssetParams {
    pub op_id: OpId,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub thread_id: Option<ThreadId>,
    pub id: String,
}

impl crate::common::HasOpId for MediaDeleteMediaAssetParams {
    fn op_id(&self) -> &OpId {
        &self.op_id
    }
}

/// Params of `media/deleteMediaAssets`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
#[ts(optional_fields)]
pub struct MediaDeleteMediaAssetsParams {
    pub op_id: OpId,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub thread_id: Option<ThreadId>,
    pub filter: JsonValue,
}

impl crate::common::HasOpId for MediaDeleteMediaAssetsParams {
    fn op_id(&self) -> &OpId {
        &self.op_id
    }
}

/// Params of `media/createMediaBoard`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
#[ts(optional_fields)]
pub struct MediaCreateMediaBoardParams {
    pub op_id: OpId,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub thread_id: Option<ThreadId>,
    pub name: String,
}

impl crate::common::HasOpId for MediaCreateMediaBoardParams {
    fn op_id(&self) -> &OpId {
        &self.op_id
    }
}

/// Params of `media/renameMediaBoard`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
#[ts(optional_fields)]
pub struct MediaRenameMediaBoardParams {
    pub op_id: OpId,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub thread_id: Option<ThreadId>,
    pub id: String,
    pub name: String,
}

impl crate::common::HasOpId for MediaRenameMediaBoardParams {
    fn op_id(&self) -> &OpId {
        &self.op_id
    }
}

/// Params of `media/deleteMediaBoard`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
#[ts(optional_fields)]
pub struct MediaDeleteMediaBoardParams {
    pub op_id: OpId,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub thread_id: Option<ThreadId>,
    pub id: String,
}

impl crate::common::HasOpId for MediaDeleteMediaBoardParams {
    fn op_id(&self) -> &OpId {
        &self.op_id
    }
}

/// Params of `media/setMediaAssetBoard`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(optional_fields)]
pub struct MediaSetMediaAssetBoardParams {
    pub op_id: OpId,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub thread_id: Option<ThreadId>,
    pub ids: Vec<String>,
    pub board_id: JsonValue,
}

impl crate::common::HasOpId for MediaSetMediaAssetBoardParams {
    fn op_id(&self) -> &OpId {
        &self.op_id
    }
}

/// Params of `media/setMediaDefault`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(optional_fields)]
pub struct MediaSetMediaDefaultParams {
    pub op_id: OpId,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub thread_id: Option<ThreadId>,
    pub input: JsonValue,
}

impl crate::common::HasOpId for MediaSetMediaDefaultParams {
    fn op_id(&self) -> &OpId {
        &self.op_id
    }
}

/// Params of `media/setMediaPin`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(optional_fields)]
pub struct MediaSetMediaPinParams {
    pub op_id: OpId,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub thread_id: Option<ThreadId>,
    pub input: JsonValue,
}

impl crate::common::HasOpId for MediaSetMediaPinParams {
    fn op_id(&self) -> &OpId {
        &self.op_id
    }
}

/// Params of `media/cacheMediaThumbnail`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
#[ts(optional_fields)]
pub struct MediaCacheMediaThumbnailParams {
    pub op_id: OpId,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub thread_id: Option<ThreadId>,
    pub id: String,
    pub input: JsonValue,
}

impl crate::common::HasOpId for MediaCacheMediaThumbnailParams {
    fn op_id(&self) -> &OpId {
        &self.op_id
    }
}

/// Params of `media/openMediaAsset`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
#[ts(optional_fields)]
pub struct MediaOpenMediaAssetParams {
    pub op_id: OpId,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub thread_id: Option<ThreadId>,
    pub id: String,
}

impl crate::common::HasOpId for MediaOpenMediaAssetParams {
    fn op_id(&self) -> &OpId {
        &self.op_id
    }
}

/// Params of `media/openMediaFolder`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
#[ts(optional_fields)]
pub struct MediaOpenMediaFolderParams {
    pub op_id: OpId,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub thread_id: Option<ThreadId>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub id: Option<String>,
}

impl crate::common::HasOpId for MediaOpenMediaFolderParams {
    fn op_id(&self) -> &OpId {
        &self.op_id
    }
}

/// Params of `mcp/getMcpServerConfig`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
#[ts(optional_fields)]
pub struct McpGetMcpServerConfigParams {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub thread_id: Option<ThreadId>,
    pub name: String,
}

/// Params of `mcp/getMcpOAuthLoginStatus`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
#[ts(optional_fields)]
pub struct McpGetMcpOAuthLoginStatusParams {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub thread_id: Option<ThreadId>,
    pub flow_id: LoginFlowId,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub options: Option<JsonValue>,
}

/// Params of `mcp/mcpStatus`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
#[ts(optional_fields)]
pub struct McpMcpStatusParams {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub thread_id: Option<ThreadId>,
}

/// Params of `mcp/addMcpServer`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
#[ts(optional_fields)]
pub struct McpAddMcpServerParams {
    pub op_id: OpId,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub thread_id: Option<ThreadId>,
    pub input: JsonValue,
}

impl crate::common::HasOpId for McpAddMcpServerParams {
    fn op_id(&self) -> &OpId {
        &self.op_id
    }
}

/// Params of `mcp/saveMcpServer`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
#[ts(optional_fields)]
pub struct McpSaveMcpServerParams {
    pub op_id: OpId,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub thread_id: Option<ThreadId>,
    pub input: JsonValue,
}

impl crate::common::HasOpId for McpSaveMcpServerParams {
    fn op_id(&self) -> &OpId {
        &self.op_id
    }
}

/// Params of `mcp/removeMcpServer`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
#[ts(optional_fields)]
pub struct McpRemoveMcpServerParams {
    pub op_id: OpId,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub thread_id: Option<ThreadId>,
    pub name: String,
}

impl crate::common::HasOpId for McpRemoveMcpServerParams {
    fn op_id(&self) -> &OpId {
        &self.op_id
    }
}

/// Params of `mcp/setMcpServerEnabled`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(optional_fields)]
pub struct McpSetMcpServerEnabledParams {
    pub op_id: OpId,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub thread_id: Option<ThreadId>,
    pub name: String,
    pub enabled: bool,
}

impl crate::common::HasOpId for McpSetMcpServerEnabledParams {
    fn op_id(&self) -> &OpId {
        &self.op_id
    }
}

/// Params of `mcp/reconnectMcp`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
#[ts(optional_fields)]
pub struct McpReconnectMcpParams {
    pub op_id: OpId,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub thread_id: Option<ThreadId>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
}

impl crate::common::HasOpId for McpReconnectMcpParams {
    fn op_id(&self) -> &OpId {
        &self.op_id
    }
}

/// Params of `mcp/beginMcpOAuthLogin`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
#[ts(optional_fields)]
pub struct McpBeginMcpOAuthLoginParams {
    pub op_id: OpId,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub thread_id: Option<ThreadId>,
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub options: Option<JsonValue>,
}

impl crate::common::HasOpId for McpBeginMcpOAuthLoginParams {
    fn op_id(&self) -> &OpId {
        &self.op_id
    }
}

/// Params of `mcp/cancelMcpOAuthLogin`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
#[ts(optional_fields)]
pub struct McpCancelMcpOAuthLoginParams {
    pub op_id: OpId,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub thread_id: Option<ThreadId>,
    pub flow_id: LoginFlowId,
}

impl crate::common::HasOpId for McpCancelMcpOAuthLoginParams {
    fn op_id(&self) -> &OpId {
        &self.op_id
    }
}

/// Params of `mcp/completeMcpOAuthLogin`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
#[ts(optional_fields)]
pub struct McpCompleteMcpOAuthLoginParams {
    pub op_id: OpId,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub thread_id: Option<ThreadId>,
    pub flow_id: LoginFlowId,
    pub callback_url: String,
}

impl crate::common::HasOpId for McpCompleteMcpOAuthLoginParams {
    fn op_id(&self) -> &OpId {
        &self.op_id
    }
}

/// Params of `mcp/signOutMcpServer`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
#[ts(optional_fields)]
pub struct McpSignOutMcpServerParams {
    pub op_id: OpId,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub thread_id: Option<ThreadId>,
    pub name: String,
}

impl crate::common::HasOpId for McpSignOutMcpServerParams {
    fn op_id(&self) -> &OpId {
        &self.op_id
    }
}

/// Params of `mcp/probeMcpServerAuth`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
#[ts(optional_fields)]
pub struct McpProbeMcpServerAuthParams {
    pub op_id: OpId,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub thread_id: Option<ThreadId>,
    pub cfg: JsonValue,
}

impl crate::common::HasOpId for McpProbeMcpServerAuthParams {
    fn op_id(&self) -> &OpId {
        &self.op_id
    }
}

/// Params of `mcp/enablePluginMcp`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
#[ts(optional_fields)]
pub struct McpEnablePluginMcpParams {
    pub op_id: OpId,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub thread_id: Option<ThreadId>,
    pub plugin: JsonValue,
}

impl crate::common::HasOpId for McpEnablePluginMcpParams {
    fn op_id(&self) -> &OpId {
        &self.op_id
    }
}

/// Params of `account/getOAuthProviderLoginStatus`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
#[ts(optional_fields)]
pub struct AccountGetOAuthProviderLoginStatusParams {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub thread_id: Option<ThreadId>,
    pub flow_id: LoginFlowId,
}

/// Params of `account/listWebSearchModels`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
#[ts(optional_fields)]
pub struct AccountListWebSearchModelsParams {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub thread_id: Option<ThreadId>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub options: Option<JsonValue>,
}

/// Params of `account/getQuotaHistory`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
#[ts(optional_fields)]
pub struct AccountGetQuotaHistoryParams {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub thread_id: Option<ThreadId>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub options: Option<JsonValue>,
}

/// Params of `account/authenticateProvider`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
#[ts(optional_fields)]
pub struct AccountAuthenticateProviderParams {
    pub op_id: OpId,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub thread_id: Option<ThreadId>,
    pub provider_id: String,
    pub secret: String,
}

impl crate::common::HasOpId for AccountAuthenticateProviderParams {
    fn op_id(&self) -> &OpId {
        &self.op_id
    }
}

/// Params of `account/beginOAuthProviderLogin`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
#[ts(optional_fields)]
pub struct AccountBeginOAuthProviderLoginParams {
    pub op_id: OpId,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub thread_id: Option<ThreadId>,
    pub provider_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub options: Option<JsonValue>,
}

impl crate::common::HasOpId for AccountBeginOAuthProviderLoginParams {
    fn op_id(&self) -> &OpId {
        &self.op_id
    }
}

/// Params of `account/completeOAuthProviderLogin`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
#[ts(optional_fields)]
pub struct AccountCompleteOAuthProviderLoginParams {
    pub op_id: OpId,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub thread_id: Option<ThreadId>,
    pub flow_id: LoginFlowId,
    pub callback_url: String,
}

impl crate::common::HasOpId for AccountCompleteOAuthProviderLoginParams {
    fn op_id(&self) -> &OpId {
        &self.op_id
    }
}

/// Params of `account/cancelOAuthProviderLogin`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
#[ts(optional_fields)]
pub struct AccountCancelOAuthProviderLoginParams {
    pub op_id: OpId,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub thread_id: Option<ThreadId>,
    pub flow_id: LoginFlowId,
}

impl crate::common::HasOpId for AccountCancelOAuthProviderLoginParams {
    fn op_id(&self) -> &OpId {
        &self.op_id
    }
}

/// Params of `account/loginOAuthProvider`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
#[ts(optional_fields)]
pub struct AccountLoginOAuthProviderParams {
    pub op_id: OpId,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub thread_id: Option<ThreadId>,
    pub provider_id: String,
}

impl crate::common::HasOpId for AccountLoginOAuthProviderParams {
    fn op_id(&self) -> &OpId {
        &self.op_id
    }
}

/// Params of `account/forgetProviderAuth`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
#[ts(optional_fields)]
pub struct AccountForgetProviderAuthParams {
    pub op_id: OpId,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub thread_id: Option<ThreadId>,
    pub provider_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub account_id: Option<String>,
}

impl crate::common::HasOpId for AccountForgetProviderAuthParams {
    fn op_id(&self) -> &OpId {
        &self.op_id
    }
}

/// Params of `account/updateProviderAccounts`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
#[ts(optional_fields)]
pub struct AccountUpdateProviderAccountsParams {
    pub op_id: OpId,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub thread_id: Option<ThreadId>,
    pub provider_id: String,
    pub change: JsonValue,
}

impl crate::common::HasOpId for AccountUpdateProviderAccountsParams {
    fn op_id(&self) -> &OpId {
        &self.op_id
    }
}

/// Params of `account/saveProviderApiKey`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
#[ts(optional_fields)]
pub struct AccountSaveProviderApiKeyParams {
    pub op_id: OpId,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub thread_id: Option<ThreadId>,
    pub provider_id: String,
    pub secret: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub options: Option<JsonValue>,
}

impl crate::common::HasOpId for AccountSaveProviderApiKeyParams {
    fn op_id(&self) -> &OpId {
        &self.op_id
    }
}

/// Params of `account/saveCustomProvider`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
#[ts(optional_fields)]
pub struct AccountSaveCustomProviderParams {
    pub op_id: OpId,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub thread_id: Option<ThreadId>,
    pub input: JsonValue,
}

impl crate::common::HasOpId for AccountSaveCustomProviderParams {
    fn op_id(&self) -> &OpId {
        &self.op_id
    }
}

/// Params of `account/saveCustomProviderKey`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
#[ts(optional_fields)]
pub struct AccountSaveCustomProviderKeyParams {
    pub op_id: OpId,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub thread_id: Option<ThreadId>,
    pub provider_id: String,
    pub secret: String,
}

impl crate::common::HasOpId for AccountSaveCustomProviderKeyParams {
    fn op_id(&self) -> &OpId {
        &self.op_id
    }
}

/// Params of `account/removeCustomProvider`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
#[ts(optional_fields)]
pub struct AccountRemoveCustomProviderParams {
    pub op_id: OpId,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub thread_id: Option<ThreadId>,
    pub provider_id: String,
}

impl crate::common::HasOpId for AccountRemoveCustomProviderParams {
    fn op_id(&self) -> &OpId {
        &self.op_id
    }
}

/// Params of `account/updateCustomProviderModel`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
#[ts(optional_fields)]
pub struct AccountUpdateCustomProviderModelParams {
    pub op_id: OpId,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub thread_id: Option<ThreadId>,
    pub provider_id: String,
    pub model_id: String,
    pub patch: JsonValue,
}

impl crate::common::HasOpId for AccountUpdateCustomProviderModelParams {
    fn op_id(&self) -> &OpId {
        &self.op_id
    }
}

/// Params of `account/testCustomProvider`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
#[ts(optional_fields)]
pub struct AccountTestCustomProviderParams {
    pub op_id: OpId,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub thread_id: Option<ThreadId>,
    pub input: JsonValue,
}

impl crate::common::HasOpId for AccountTestCustomProviderParams {
    fn op_id(&self) -> &OpId {
        &self.op_id
    }
}

/// Params of `account/checkCustomProviderKeyEnv`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
#[ts(optional_fields)]
pub struct AccountCheckCustomProviderKeyEnvParams {
    pub op_id: OpId,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub thread_id: Option<ThreadId>,
    pub name: String,
}

impl crate::common::HasOpId for AccountCheckCustomProviderKeyEnvParams {
    fn op_id(&self) -> &OpId {
        &self.op_id
    }
}

/// Params of `account/discoverCustomProviderModels`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
#[ts(optional_fields)]
pub struct AccountDiscoverCustomProviderModelsParams {
    pub op_id: OpId,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub thread_id: Option<ThreadId>,
    pub input: JsonValue,
}

impl crate::common::HasOpId for AccountDiscoverCustomProviderModelsParams {
    fn op_id(&self) -> &OpId {
        &self.op_id
    }
}

/// Params of `account/saveOpenAIUsageSessionKey`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
#[ts(optional_fields)]
pub struct AccountSaveOpenAIUsageSessionKeyParams {
    pub op_id: OpId,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub thread_id: Option<ThreadId>,
    pub secret: String,
}

impl crate::common::HasOpId for AccountSaveOpenAIUsageSessionKeyParams {
    fn op_id(&self) -> &OpId {
        &self.op_id
    }
}

/// Params of `account/consumeCodexRateLimitResetCredit`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
#[ts(optional_fields)]
pub struct AccountConsumeCodexRateLimitResetCreditParams {
    pub op_id: OpId,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub thread_id: Option<ThreadId>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub options: Option<JsonValue>,
}

impl crate::common::HasOpId for AccountConsumeCodexRateLimitResetCreditParams {
    fn op_id(&self) -> &OpId {
        &self.op_id
    }
}

/// Params of `account/refreshProviderSetup`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
#[ts(optional_fields)]
pub struct AccountRefreshProviderSetupParams {
    pub op_id: OpId,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub force: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub refresh: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub unlock_keychain: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub recheck_keychain: Option<bool>,
}

impl crate::common::HasOpId for AccountRefreshProviderSetupParams {
    fn op_id(&self) -> &OpId {
        &self.op_id
    }
}

/// Params of `localProvider/searchLocalProviderModels`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
#[ts(optional_fields)]
pub struct LocalProviderSearchLocalProviderModelsParams {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub thread_id: Option<ThreadId>,
    pub query: String,
}

/// Params of `localProvider/inspectHuggingFaceModel`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
#[ts(optional_fields)]
pub struct LocalProviderInspectHuggingFaceModelParams {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub thread_id: Option<ThreadId>,
    pub options: JsonValue,
}

/// Params of `localProvider/getLocalProviderModelDetails`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
#[ts(optional_fields)]
pub struct LocalProviderGetLocalProviderModelDetailsParams {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub thread_id: Option<ThreadId>,
    pub model_id: String,
}

/// Params of `localProvider/installLocalProviderModel`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
#[ts(optional_fields)]
pub struct LocalProviderInstallLocalProviderModelParams {
    pub op_id: OpId,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub thread_id: Option<ThreadId>,
    pub model_id: String,
}

impl crate::common::HasOpId for LocalProviderInstallLocalProviderModelParams {
    fn op_id(&self) -> &OpId {
        &self.op_id
    }
}

/// Params of `localProvider/startLocalProviderInstallation`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
#[ts(optional_fields)]
pub struct LocalProviderStartLocalProviderInstallationParams {
    pub op_id: OpId,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub thread_id: Option<ThreadId>,
    pub phase: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model_id: Option<String>,
}

impl crate::common::HasOpId for LocalProviderStartLocalProviderInstallationParams {
    fn op_id(&self) -> &OpId {
        &self.op_id
    }
}

/// Params of `localProvider/cancelLocalProviderInstallation`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
#[ts(optional_fields)]
pub struct LocalProviderCancelLocalProviderInstallationParams {
    pub op_id: OpId,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub thread_id: Option<ThreadId>,
    pub job_id: String,
}

impl crate::common::HasOpId for LocalProviderCancelLocalProviderInstallationParams {
    fn op_id(&self) -> &OpId {
        &self.op_id
    }
}

/// Params of `localProvider/discardLocalProviderInstallation`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
#[ts(optional_fields)]
pub struct LocalProviderDiscardLocalProviderInstallationParams {
    pub op_id: OpId,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub thread_id: Option<ThreadId>,
    pub phase: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model_id: Option<String>,
}

impl crate::common::HasOpId for LocalProviderDiscardLocalProviderInstallationParams {
    fn op_id(&self) -> &OpId {
        &self.op_id
    }
}

/// Params of `localProvider/setLocalProviderIdleTtl`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(optional_fields)]
pub struct LocalProviderSetLocalProviderIdleTtlParams {
    pub op_id: OpId,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub thread_id: Option<ThreadId>,
    #[ts(type = "number")]
    pub seconds: i64,
}

impl crate::common::HasOpId for LocalProviderSetLocalProviderIdleTtlParams {
    fn op_id(&self) -> &OpId {
        &self.op_id
    }
}

/// Params of `localProvider/setLocalProviderContext`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(optional_fields)]
pub struct LocalProviderSetLocalProviderContextParams {
    pub op_id: OpId,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub thread_id: Option<ThreadId>,
    pub model_id: String,
    #[ts(type = "number")]
    pub tokens: i64,
}

impl crate::common::HasOpId for LocalProviderSetLocalProviderContextParams {
    fn op_id(&self) -> &OpId {
        &self.op_id
    }
}

/// Params of `localProvider/registerHuggingFaceModel`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
#[ts(optional_fields)]
pub struct LocalProviderRegisterHuggingFaceModelParams {
    pub op_id: OpId,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub thread_id: Option<ThreadId>,
    pub preview_id: String,
    pub license_accepted: bool,
}

impl crate::common::HasOpId for LocalProviderRegisterHuggingFaceModelParams {
    fn op_id(&self) -> &OpId {
        &self.op_id
    }
}

/// Params of `localProvider/startLocalProviderModelMaintenance`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
#[ts(optional_fields)]
pub struct LocalProviderStartLocalProviderModelMaintenanceParams {
    pub op_id: OpId,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub thread_id: Option<ThreadId>,
    pub model_id: String,
    pub operation: String,
}

impl crate::common::HasOpId for LocalProviderStartLocalProviderModelMaintenanceParams {
    fn op_id(&self) -> &OpId {
        &self.op_id
    }
}

/// Params of `localProvider/deleteLocalProviderModel`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
#[ts(optional_fields)]
pub struct LocalProviderDeleteLocalProviderModelParams {
    pub op_id: OpId,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub thread_id: Option<ThreadId>,
    pub confirmation_token: String,
}

impl crate::common::HasOpId for LocalProviderDeleteLocalProviderModelParams {
    fn op_id(&self) -> &OpId {
        &self.op_id
    }
}

/// Params of `usage/getUsageDashboard`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
#[ts(optional_fields)]
pub struct UsageGetUsageDashboardParams {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub thread_id: Option<ThreadId>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub options: Option<JsonValue>,
}

/// Params of `usage/getUsageStats`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
#[ts(optional_fields)]
pub struct UsageGetUsageStatsParams {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub thread_id: Option<ThreadId>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub options: Option<JsonValue>,
}

/// Params of `usage/getUsageRequests`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
#[ts(optional_fields)]
pub struct UsageGetUsageRequestsParams {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub thread_id: Option<ThreadId>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub options: Option<JsonValue>,
}

/// Params of `update/getUpdateStatus`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
#[ts(optional_fields)]
pub struct UpdateGetUpdateStatusParams {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub thread_id: Option<ThreadId>,
}

/// Params of `update/checkForUpdate`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
#[ts(optional_fields)]
pub struct UpdateCheckForUpdateParams {
    pub op_id: OpId,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub thread_id: Option<ThreadId>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub options: Option<JsonValue>,
}

impl crate::common::HasOpId for UpdateCheckForUpdateParams {
    fn op_id(&self) -> &OpId {
        &self.op_id
    }
}

/// Params of `update/runUpdateNow`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
#[ts(optional_fields)]
pub struct UpdateRunUpdateNowParams {
    pub op_id: OpId,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub thread_id: Option<ThreadId>,
}

impl crate::common::HasOpId for UpdateRunUpdateNowParams {
    fn op_id(&self) -> &OpId {
        &self.op_id
    }
}

/// Params of `voice/getVoiceStatus`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
#[ts(optional_fields)]
pub struct VoiceGetVoiceStatusParams {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub thread_id: Option<ThreadId>,
}

/// Params of `voice/toggleVoice`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
#[ts(optional_fields)]
pub struct VoiceToggleVoiceParams {
    pub op_id: OpId,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub thread_id: Option<ThreadId>,
    pub enabled: bool,
}

impl crate::common::HasOpId for VoiceToggleVoiceParams {
    fn op_id(&self) -> &OpId {
        &self.op_id
    }
}

/// Params of `voice/transcribeAudio`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
#[ts(optional_fields)]
pub struct VoiceTranscribeAudioParams {
    pub op_id: OpId,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub thread_id: Option<ThreadId>,
    pub input: JsonValue,
}

impl crate::common::HasOpId for VoiceTranscribeAudioParams {
    fn op_id(&self) -> &OpId {
        &self.op_id
    }
}

/// Params of `voice/prepareTranscription`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
#[ts(optional_fields)]
pub struct VoicePrepareTranscriptionParams {
    pub op_id: OpId,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub thread_id: Option<ThreadId>,
}

impl crate::common::HasOpId for VoicePrepareTranscriptionParams {
    fn op_id(&self) -> &OpId {
        &self.op_id
    }
}

/// Params of `tidy/getTidyEngineStatus`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
#[ts(optional_fields)]
pub struct TidyGetTidyEngineStatusParams {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub thread_id: Option<ThreadId>,
}

/// Params of `tidy/getTidyInstallStatus`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
#[ts(optional_fields)]
pub struct TidyGetTidyInstallStatusParams {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub thread_id: Option<ThreadId>,
}

/// Params of `skills/skillsStatus`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
#[ts(optional_fields)]
pub struct SkillsSkillsStatusParams {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub thread_id: Option<ThreadId>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub options: Option<JsonValue>,
}

/// Params of `skills/skillContent`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
#[ts(optional_fields)]
pub struct SkillsSkillContentParams {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub thread_id: Option<ThreadId>,
    pub name: String,
}

/// Params of `skills/getDisabledSkills`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
#[ts(optional_fields)]
pub struct SkillsGetDisabledSkillsParams {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub thread_id: Option<ThreadId>,
}

/// Params of `skills/addSkill`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
#[ts(optional_fields)]
pub struct SkillsAddSkillParams {
    pub op_id: OpId,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub thread_id: Option<ThreadId>,
    pub input: JsonValue,
}

impl crate::common::HasOpId for SkillsAddSkillParams {
    fn op_id(&self) -> &OpId {
        &self.op_id
    }
}

/// Params of `skills/saveSkill`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
#[ts(optional_fields)]
pub struct SkillsSaveSkillParams {
    pub op_id: OpId,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub thread_id: Option<ThreadId>,
    pub input: JsonValue,
}

impl crate::common::HasOpId for SkillsSaveSkillParams {
    fn op_id(&self) -> &OpId {
        &self.op_id
    }
}

/// Params of `skills/removeSkill`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
#[ts(optional_fields)]
pub struct SkillsRemoveSkillParams {
    pub op_id: OpId,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub thread_id: Option<ThreadId>,
    pub input: JsonValue,
}

impl crate::common::HasOpId for SkillsRemoveSkillParams {
    fn op_id(&self) -> &OpId {
        &self.op_id
    }
}

/// Params of `skills/reloadSkills`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
#[ts(optional_fields)]
pub struct SkillsReloadSkillsParams {
    pub op_id: OpId,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub thread_id: Option<ThreadId>,
}

impl crate::common::HasOpId for SkillsReloadSkillsParams {
    fn op_id(&self) -> &OpId {
        &self.op_id
    }
}

/// Params of `skills/setDisabledSkills`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(optional_fields)]
pub struct SkillsSetDisabledSkillsParams {
    pub op_id: OpId,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub thread_id: Option<ThreadId>,
    pub names: Vec<String>,
}

impl crate::common::HasOpId for SkillsSetDisabledSkillsParams {
    fn op_id(&self) -> &OpId {
        &self.op_id
    }
}

/// Params of `plugins/pluginsStatus`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
#[ts(optional_fields)]
pub struct PluginsPluginsStatusParams {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub thread_id: Option<ThreadId>,
}

/// Params of `plugins/addPlugin`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
#[ts(optional_fields)]
pub struct PluginsAddPluginParams {
    pub op_id: OpId,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub thread_id: Option<ThreadId>,
    pub source: JsonValue,
}

impl crate::common::HasOpId for PluginsAddPluginParams {
    fn op_id(&self) -> &OpId {
        &self.op_id
    }
}

/// Params of `plugins/updatePlugin`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
#[ts(optional_fields)]
pub struct PluginsUpdatePluginParams {
    pub op_id: OpId,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub thread_id: Option<ThreadId>,
    pub plugin: JsonValue,
}

impl crate::common::HasOpId for PluginsUpdatePluginParams {
    fn op_id(&self) -> &OpId {
        &self.op_id
    }
}

/// Params of `plugins/setPluginEnabled`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(optional_fields)]
pub struct PluginsSetPluginEnabledParams {
    pub op_id: OpId,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub thread_id: Option<ThreadId>,
    pub plugin: JsonValue,
    pub enabled: bool,
}

impl crate::common::HasOpId for PluginsSetPluginEnabledParams {
    fn op_id(&self) -> &OpId {
        &self.op_id
    }
}

/// Params of `plugins/removePlugin`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
#[ts(optional_fields)]
pub struct PluginsRemovePluginParams {
    pub op_id: OpId,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub thread_id: Option<ThreadId>,
    pub plugin: JsonValue,
}

impl crate::common::HasOpId for PluginsRemovePluginParams {
    fn op_id(&self) -> &OpId {
        &self.op_id
    }
}

/// Params of `plugins/reloadPlugins`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
#[ts(optional_fields)]
pub struct PluginsReloadPluginsParams {
    pub op_id: OpId,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub thread_id: Option<ThreadId>,
}

impl crate::common::HasOpId for PluginsReloadPluginsParams {
    fn op_id(&self) -> &OpId {
        &self.op_id
    }
}

/// Params of `tools/toolsStatus`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
#[ts(optional_fields)]
pub struct ToolsToolsStatusParams {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub thread_id: Option<ThreadId>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub query: Option<String>,
}

/// Params of `memory/memoryControl`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
#[ts(optional_fields)]
pub struct MemoryMemoryControlParams {
    pub op_id: OpId,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub thread_id: Option<ThreadId>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub args: Option<JsonValue>,
}

impl crate::common::HasOpId for MemoryMemoryControlParams {
    fn op_id(&self) -> &OpId {
        &self.op_id
    }
}

/// Params of `memory/recall`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
#[ts(optional_fields)]
pub struct MemoryRecallParams {
    pub op_id: OpId,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub thread_id: Option<ThreadId>,
    pub query: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub args: Option<JsonValue>,
}

impl crate::common::HasOpId for MemoryRecallParams {
    fn op_id(&self) -> &OpId {
        &self.op_id
    }
}

/// Params of `diagnostics/runDoctor`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
#[ts(optional_fields)]
pub struct DiagnosticsRunDoctorParams {
    pub op_id: OpId,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub thread_id: Option<ThreadId>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub options: Option<JsonValue>,
}

impl crate::common::HasOpId for DiagnosticsRunDoctorParams {
    fn op_id(&self) -> &OpId {
        &self.op_id
    }
}

/// Params of `project/list`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
pub struct ProjectListParams {}

/// Params of `project/read`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
pub struct ProjectReadParams {
    pub path: String,
}

/// Params of `project/create`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
pub struct ProjectCreateParams {
    pub op_id: OpId,
    pub path: String,
}

impl crate::common::HasOpId for ProjectCreateParams {
    fn op_id(&self) -> &OpId {
        &self.op_id
    }
}

/// Params of `project/touch`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
pub struct ProjectTouchParams {
    pub op_id: OpId,
    pub path: String,
}

impl crate::common::HasOpId for ProjectTouchParams {
    fn op_id(&self) -> &OpId {
        &self.op_id
    }
}

/// Params of `project/update`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProjectUpdateParams {
    pub op_id: OpId,
    pub path: String,
    pub alias: JsonValue,
}

impl crate::common::HasOpId for ProjectUpdateParams {
    fn op_id(&self) -> &OpId {
        &self.op_id
    }
}

/// Params of `project/delete`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
pub struct ProjectDeleteParams {
    pub op_id: OpId,
    pub path: String,
}

impl crate::common::HasOpId for ProjectDeleteParams {
    fn op_id(&self) -> &OpId {
        &self.op_id
    }
}

/// Params of `project/ensureDirectory`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
pub struct ProjectEnsureDirectoryParams {
    pub op_id: OpId,
    pub path: String,
}

impl crate::common::HasOpId for ProjectEnsureDirectoryParams {
    fn op_id(&self) -> &OpId {
        &self.op_id
    }
}

/// Params of `project/directory`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
pub struct ProjectDirectoryParams {
    pub path: String,
}

/// Params of `project/recoveryDirectory`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
pub struct ProjectRecoveryDirectoryParams {
    pub path: String,
}

/// Params of `project/taskWorkspace`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
pub struct ProjectTaskWorkspaceParams {}

/// Params of `project/codeGraph`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
pub struct ProjectCodeGraphParams {
    pub path: String,
    pub mode: String,
    pub query: String,
}

/// Params of `projectFs/listDir`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
pub struct ProjectFsListDirParams {
    pub root: String,
    pub rel: String,
}

/// Params of `projectFs/readText`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
pub struct ProjectFsReadTextParams {
    pub root: String,
    pub rel: String,
}

/// Params of `projectFs/writeText`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
#[ts(optional_fields)]
pub struct ProjectFsWriteTextParams {
    pub op_id: OpId,
    pub root: String,
    pub rel: String,
    pub content: String,
    pub expected_content: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub encoding: Option<String>,
}

impl crate::common::HasOpId for ProjectFsWriteTextParams {
    fn op_id(&self) -> &OpId {
        &self.op_id
    }
}

/// Params of `projectFs/writeTextBatch`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
pub struct ProjectFsWriteTextBatchParams {
    pub op_id: OpId,
    pub root: String,
    pub files: JsonValue,
}

impl crate::common::HasOpId for ProjectFsWriteTextBatchParams {
    fn op_id(&self) -> &OpId {
        &self.op_id
    }
}

/// Params of `projectFs/stat`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
pub struct ProjectFsStatParams {
    pub root: String,
    pub rel: String,
}

/// Params of `projectFs/create`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
pub struct ProjectFsCreateParams {
    pub op_id: OpId,
    pub root: String,
    pub rel_dir: String,
    pub name: String,
    pub directory: bool,
}

impl crate::common::HasOpId for ProjectFsCreateParams {
    fn op_id(&self) -> &OpId {
        &self.op_id
    }
}

/// Params of `projectFs/rename`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
pub struct ProjectFsRenameParams {
    pub op_id: OpId,
    pub root: String,
    pub rel: String,
    pub new_name: String,
}

impl crate::common::HasOpId for ProjectFsRenameParams {
    fn op_id(&self) -> &OpId {
        &self.op_id
    }
}

/// Params of `projectFs/move`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
pub struct ProjectFsMoveParams {
    pub op_id: OpId,
    pub root: String,
    pub rel: String,
    pub target_dir_rel: String,
}

impl crate::common::HasOpId for ProjectFsMoveParams {
    fn op_id(&self) -> &OpId {
        &self.op_id
    }
}

/// Params of `projectFs/copy`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
pub struct ProjectFsCopyParams {
    pub op_id: OpId,
    pub root: String,
    pub rel: String,
    pub target_dir_rel: String,
}

impl crate::common::HasOpId for ProjectFsCopyParams {
    fn op_id(&self) -> &OpId {
        &self.op_id
    }
}

/// Params of `projectFs/trash`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
pub struct ProjectFsTrashParams {
    pub op_id: OpId,
    pub root: String,
    pub rel: String,
}

impl crate::common::HasOpId for ProjectFsTrashParams {
    fn op_id(&self) -> &OpId {
        &self.op_id
    }
}

/// Params of `projectFs/entryPath`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
pub struct ProjectFsEntryPathParams {
    pub root: String,
    pub rel: String,
}

/// Params of `projectFs/readLocal`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
pub struct ProjectFsReadLocalParams {
    pub path: String,
}

/// Params of `projectFs/statLocal`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
pub struct ProjectFsStatLocalParams {
    pub paths: Vec<String>,
}

/// Params of `projectFs/browseDirs`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
#[ts(optional_fields)]
pub struct ProjectFsBrowseDirsParams {
    pub path: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub include_hidden: Option<bool>,
}

/// Params of `projectFs/searchText`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
pub struct ProjectFsSearchTextParams {
    pub root: String,
    pub options: JsonValue,
}

/// Params of `projectFs/replaceText`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
#[ts(optional_fields)]
pub struct ProjectFsReplaceTextParams {
    pub op_id: OpId,
    pub root: String,
    pub options: JsonValue,
    pub replacement: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub rel_paths: Option<Vec<String>>,
}

impl crate::common::HasOpId for ProjectFsReplaceTextParams {
    fn op_id(&self) -> &OpId {
        &self.op_id
    }
}

/// Params of `projectFs/recovery`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
#[ts(optional_fields)]
pub struct ProjectFsRecoveryParams {
    pub op_id: OpId,
    pub root: String,
    pub action: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub revision: Option<String>,
}

impl crate::common::HasOpId for ProjectFsRecoveryParams {
    fn op_id(&self) -> &OpId {
        &self.op_id
    }
}

/// Params of `projectFs/backup/read`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
pub struct ProjectFsBackupReadParams {
    pub source_path: String,
}

/// Params of `projectFs/backup/write`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
pub struct ProjectFsBackupWriteParams {
    pub op_id: OpId,
    pub source_path: String,
    pub content: String,
    pub expected_content: String,
}

impl crate::common::HasOpId for ProjectFsBackupWriteParams {
    fn op_id(&self) -> &OpId {
        &self.op_id
    }
}

/// Params of `projectFs/backup/delete`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
pub struct ProjectFsBackupDeleteParams {
    pub op_id: OpId,
    pub source_path: String,
}

impl crate::common::HasOpId for ProjectFsBackupDeleteParams {
    fn op_id(&self) -> &OpId {
        &self.op_id
    }
}

/// Params of `projectFs/workspaceFile/read`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
pub struct ProjectFsWorkspaceFileReadParams {
    pub workspace_file: String,
}

/// Params of `projectFs/workspaceFile/write`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
pub struct ProjectFsWorkspaceFileWriteParams {
    pub op_id: OpId,
    pub workspace_file: String,
    pub folders: JsonValue,
}

impl crate::common::HasOpId for ProjectFsWorkspaceFileWriteParams {
    fn op_id(&self) -> &OpId {
        &self.op_id
    }
}

/// Params of `projectFs/readEditorSettings`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
#[ts(optional_fields)]
pub struct ProjectFsReadEditorSettingsParams {
    pub root: String,
    pub rel: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub workspace_file: Option<String>,
}

/// Params of `projectFs/captureSnapshot`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
pub struct ProjectFsCaptureSnapshotParams {
    pub root: String,
    pub rel: String,
}

/// Params of `projectFs/localPageUrl`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
pub struct ProjectFsLocalPageUrlParams {
    pub root: String,
    pub rel: String,
}

/// Params of `fs/watch`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
pub struct FsWatchParams {
    pub watch_id: WatchId,
    pub path: String,
    pub recursive: bool,
}

/// Params of `fs/unwatch`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
pub struct FsUnwatchParams {
    pub watch_id: WatchId,
}

/// Params of `search/start`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
#[ts(optional_fields)]
pub struct SearchStartParams {
    pub session_id: SearchSessionId,
    pub roots: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub limit: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub include_ignored: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub include_directories: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub consumer: Option<String>,
}

/// Params of `search/update`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
pub struct SearchUpdateParams {
    pub session_id: SearchSessionId,
    pub query: String,
}

/// Params of `search/stop`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
pub struct SearchStopParams {
    pub session_id: SearchSessionId,
}

/// Params of `transfer/beginZip`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
pub struct TransferBeginZipParams {
    pub root: String,
    pub rel: String,
}

/// Params of `transfer/readRange`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
#[ts(optional_fields)]
pub struct TransferReadRangeParams {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub transfer_id: Option<TransferId>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub root: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub rel: Option<String>,
    #[ts(type = "number")]
    pub offset: u64,
    #[ts(type = "number")]
    pub length: u64,
}

/// Params of `transfer/endRead`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
pub struct TransferEndReadParams {
    pub transfer_id: TransferId,
}

/// Params of `transfer/beginWrite`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
#[ts(optional_fields)]
pub struct TransferBeginWriteParams {
    pub op_id: OpId,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub root: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub rel: Option<String>,
    #[ts(type = "number")]
    pub size: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub scope: Option<String>,
}

impl crate::common::HasOpId for TransferBeginWriteParams {
    fn op_id(&self) -> &OpId {
        &self.op_id
    }
}

/// Params of `transfer/writeChunk`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
pub struct TransferWriteChunkParams {
    pub transfer_id: TransferId,
    #[ts(type = "number")]
    pub offset: u64,
    pub bytes_b64: String,
}

/// Params of `transfer/commit`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
pub struct TransferCommitParams {
    pub op_id: OpId,
    pub transfer_id: TransferId,
}

impl crate::common::HasOpId for TransferCommitParams {
    fn op_id(&self) -> &OpId {
        &self.op_id
    }
}

/// Params of `transfer/abort`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
pub struct TransferAbortParams {
    pub transfer_id: TransferId,
}

/// Params of `transfer/trash/info`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
pub struct TransferTrashInfoParams {
    pub path: String,
}

/// Params of `transfer/trash/entry`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
#[ts(optional_fields)]
pub struct TransferTrashEntryParams {
    pub op_id: OpId,
    pub path: String,
    pub rel: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub permanent: Option<bool>,
}

impl crate::common::HasOpId for TransferTrashEntryParams {
    fn op_id(&self) -> &OpId {
        &self.op_id
    }
}

/// Params of `lsp/document`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
pub struct LspDocumentParams {
    pub project_path: String,
    pub root: String,
    pub document: JsonValue,
}

/// Params of `lsp/subscribe` and `lsp/unsubscribe`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
pub struct LspSubscribeParams {
    /// The project root; the feed is `lsp:<root>`.
    pub root: String,
}

/// Params of `lsp/request`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
pub struct LspRequestParams {
    pub op_id: OpId,
    pub project_path: String,
    pub root: String,
    pub request: JsonValue,
}

impl crate::common::HasOpId for LspRequestParams {
    fn op_id(&self) -> &OpId {
        &self.op_id
    }
}

/// Params of `document/preview`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
#[ts(optional_fields)]
pub struct DocumentPreviewParams {
    pub root: String,
    pub rel: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub options: Option<JsonValue>,
}

/// Params of `document/previewPages`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
#[ts(optional_fields)]
pub struct DocumentPreviewPagesParams {
    pub root: String,
    pub rel: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub options: Option<JsonValue>,
}

/// Params of `document/libreOfficeStatus`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
#[ts(optional_fields)]
pub struct DocumentLibreOfficeStatusParams {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub refresh: Option<bool>,
}

/// Params of `document/installLibreOffice`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
pub struct DocumentInstallLibreOfficeParams {
    pub op_id: OpId,
}

impl crate::common::HasOpId for DocumentInstallLibreOfficeParams {
    fn op_id(&self) -> &OpId {
        &self.op_id
    }
}

/// Params of `git/status`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
#[ts(optional_fields)]
pub struct GitStatusParams {
    pub cwd: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reuse_line_stats: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub skip_line_stats: Option<bool>,
}

/// Params of `git/branches`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
pub struct GitBranchesParams {
    pub cwd: String,
}

/// Params of `git/log`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
#[ts(optional_fields)]
pub struct GitLogParams {
    pub cwd: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub query: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub skip: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub limit: Option<u32>,
}

/// Params of `git/show`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
pub struct GitShowParams {
    pub cwd: String,
    pub hash: String,
}

/// Params of `git/showDiff`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
pub struct GitShowDiffParams {
    pub cwd: String,
    pub hash: String,
    pub path: String,
}

/// Params of `git/showFile`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
pub struct GitShowFileParams {
    pub cwd: String,
    pub rev: String,
    pub path: String,
}

/// Params of `git/diff`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
#[ts(optional_fields)]
pub struct GitDiffParams {
    pub cwd: String,
    pub path: String,
    pub staged: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub worktree_only: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub untracked: Option<bool>,
}

/// Params of `git/stashList`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
pub struct GitStashListParams {
    pub cwd: String,
}

/// Params of `git/requestContext`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
pub struct GitRequestContextParams {
    pub cwd: String,
    pub input: GitRequestContextInput,
}

/// Input of `git/requestContext` (`requiredGitRequestContextInput`): the listed
/// repository-relative files (0–500, may be empty) and an optional base branch.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
#[ts(optional_fields)]
pub struct GitRequestContextInput {
    pub paths: Vec<String>,
    /// Absent or empty: no base branch.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub base: Option<String>,
}

/// Params of `git/cliStatus`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
#[ts(optional_fields)]
pub struct GitCliStatusParams {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub refresh: Option<bool>,
}

/// Params of `git/globalConfig/read`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
pub struct GitGlobalConfigReadParams {}

/// Params of `git/watch`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
pub struct GitWatchParams {
    pub cwd: String,
}

/// Params of `git/unwatch`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
pub struct GitUnwatchParams {
    pub cwd: String,
}

/// Params of `git/stage`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
pub struct GitStageParams {
    pub op_id: OpId,
    pub cwd: String,
    pub paths: Vec<String>,
}

impl crate::common::HasOpId for GitStageParams {
    fn op_id(&self) -> &OpId {
        &self.op_id
    }
}

/// Params of `git/unstage`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
pub struct GitUnstageParams {
    pub op_id: OpId,
    pub cwd: String,
    pub paths: Vec<String>,
}

impl crate::common::HasOpId for GitUnstageParams {
    fn op_id(&self) -> &OpId {
        &self.op_id
    }
}

/// Params of `git/commit`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
pub struct GitCommitParams {
    pub op_id: OpId,
    pub cwd: String,
    pub message: String,
}

impl crate::common::HasOpId for GitCommitParams {
    fn op_id(&self) -> &OpId {
        &self.op_id
    }
}

/// Params of `git/commitPaths`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
pub struct GitCommitPathsParams {
    pub op_id: OpId,
    pub cwd: String,
    pub input: GitCommitPathsInput,
}

/// Input of `git/commitPaths` (`gitCommitPaths(cwd, message, paths)`).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
pub struct GitCommitPathsInput {
    /// 1–20 000 characters.
    pub message: String,
    /// Repository-relative, 1–500 paths.
    pub paths: Vec<String>,
}

impl crate::common::HasOpId for GitCommitPathsParams {
    fn op_id(&self) -> &OpId {
        &self.op_id
    }
}

/// Params of `git/amend`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
#[ts(optional_fields)]
pub struct GitAmendParams {
    pub op_id: OpId,
    pub cwd: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
}

impl crate::common::HasOpId for GitAmendParams {
    fn op_id(&self) -> &OpId {
        &self.op_id
    }
}

/// Params of `git/undoLastCommit`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
pub struct GitUndoLastCommitParams {
    pub op_id: OpId,
    pub cwd: String,
}

impl crate::common::HasOpId for GitUndoLastCommitParams {
    fn op_id(&self) -> &OpId {
        &self.op_id
    }
}

/// Params of `git/push`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
pub struct GitPushParams {
    pub op_id: OpId,
    pub cwd: String,
}

impl crate::common::HasOpId for GitPushParams {
    fn op_id(&self) -> &OpId {
        &self.op_id
    }
}

/// Params of `git/pull`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
pub struct GitPullParams {
    pub op_id: OpId,
    pub cwd: String,
}

impl crate::common::HasOpId for GitPullParams {
    fn op_id(&self) -> &OpId {
        &self.op_id
    }
}

/// Params of `git/fetch`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
pub struct GitFetchParams {
    pub op_id: OpId,
    pub cwd: String,
}

impl crate::common::HasOpId for GitFetchParams {
    fn op_id(&self) -> &OpId {
        &self.op_id
    }
}

/// Params of `git/sync`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
pub struct GitSyncParams {
    pub op_id: OpId,
    pub cwd: String,
}

impl crate::common::HasOpId for GitSyncParams {
    fn op_id(&self) -> &OpId {
        &self.op_id
    }
}

/// Params of `git/stash`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
#[ts(optional_fields)]
pub struct GitStashParams {
    pub op_id: OpId,
    pub cwd: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
}

impl crate::common::HasOpId for GitStashParams {
    fn op_id(&self) -> &OpId {
        &self.op_id
    }
}

/// Params of `git/stashPop`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
pub struct GitStashPopParams {
    pub op_id: OpId,
    pub cwd: String,
}

impl crate::common::HasOpId for GitStashPopParams {
    fn op_id(&self) -> &OpId {
        &self.op_id
    }
}

/// Params of `git/stashApply`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
pub struct GitStashApplyParams {
    pub op_id: OpId,
    pub cwd: String,
    pub r#ref: String,
}

impl crate::common::HasOpId for GitStashApplyParams {
    fn op_id(&self) -> &OpId {
        &self.op_id
    }
}

/// Params of `git/stashDrop`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
pub struct GitStashDropParams {
    pub op_id: OpId,
    pub cwd: String,
    pub r#ref: String,
}

impl crate::common::HasOpId for GitStashDropParams {
    fn op_id(&self) -> &OpId {
        &self.op_id
    }
}

/// Params of `git/createTag`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
pub struct GitCreateTagParams {
    pub op_id: OpId,
    pub cwd: String,
    pub value: String,
    pub at: String,
}

impl crate::common::HasOpId for GitCreateTagParams {
    fn op_id(&self) -> &OpId {
        &self.op_id
    }
}

/// Params of `git/deleteTag`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
pub struct GitDeleteTagParams {
    pub op_id: OpId,
    pub cwd: String,
    pub value: String,
}

impl crate::common::HasOpId for GitDeleteTagParams {
    fn op_id(&self) -> &OpId {
        &self.op_id
    }
}

/// Params of `git/deleteBranch`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
pub struct GitDeleteBranchParams {
    pub op_id: OpId,
    pub cwd: String,
    pub input: GitDeleteBranchInput,
}

/// Input of `git/deleteBranch` (`gitDeleteBranch(cwd, branch)`): a local branch.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
pub struct GitDeleteBranchInput {
    pub branch: String,
}

impl crate::common::HasOpId for GitDeleteBranchParams {
    fn op_id(&self) -> &OpId {
        &self.op_id
    }
}

/// Params of `git/renameBranch`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
pub struct GitRenameBranchParams {
    pub op_id: OpId,
    pub cwd: String,
    pub input: GitRenameBranchInput,
}

/// Input of `git/renameBranch` (`gitRenameBranch(cwd, branch, nextBranch)`).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
pub struct GitRenameBranchInput {
    pub branch: String,
    pub next_branch: String,
}

impl crate::common::HasOpId for GitRenameBranchParams {
    fn op_id(&self) -> &OpId {
        &self.op_id
    }
}

/// Params of `git/resetToCommit`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
#[ts(optional_fields)]
pub struct GitResetToCommitParams {
    pub op_id: OpId,
    pub cwd: String,
    pub value: String,
    pub mode: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub confirmed_dirty: Option<bool>,
}

impl crate::common::HasOpId for GitResetToCommitParams {
    fn op_id(&self) -> &OpId {
        &self.op_id
    }
}

/// Params of `git/revertCommit`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
pub struct GitRevertCommitParams {
    pub op_id: OpId,
    pub cwd: String,
    pub value: String,
}

impl crate::common::HasOpId for GitRevertCommitParams {
    fn op_id(&self) -> &OpId {
        &self.op_id
    }
}

/// Params of `git/revertFile`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
#[ts(optional_fields)]
pub struct GitRevertFileParams {
    pub op_id: OpId,
    pub cwd: String,
    pub path: String,
    pub untracked: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mode: Option<String>,
}

impl crate::common::HasOpId for GitRevertFileParams {
    fn op_id(&self) -> &OpId {
        &self.op_id
    }
}

/// Params of `git/cherryPickCommit`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
pub struct GitCherryPickCommitParams {
    pub op_id: OpId,
    pub cwd: String,
    pub value: String,
}

impl crate::common::HasOpId for GitCherryPickCommitParams {
    fn op_id(&self) -> &OpId {
        &self.op_id
    }
}

/// Params of `git/applyPatch`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
#[ts(optional_fields)]
pub struct GitApplyPatchParams {
    pub op_id: OpId,
    pub cwd: String,
    pub path: String,
    pub patch: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reverse: Option<bool>,
}

impl crate::common::HasOpId for GitApplyPatchParams {
    fn op_id(&self) -> &OpId {
        &self.op_id
    }
}

/// Params of `git/ignore`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
#[ts(optional_fields)]
pub struct GitIgnoreParams {
    pub op_id: OpId,
    pub cwd: String,
    pub path: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub scope: Option<String>,
}

impl crate::common::HasOpId for GitIgnoreParams {
    fn op_id(&self) -> &OpId {
        &self.op_id
    }
}

/// Params of `git/continue`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
pub struct GitContinueParams {
    pub op_id: OpId,
    pub cwd: String,
}

impl crate::common::HasOpId for GitContinueParams {
    fn op_id(&self) -> &OpId {
        &self.op_id
    }
}

/// Params of `git/abortOperation`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
pub struct GitAbortOperationParams {
    pub op_id: OpId,
    pub cwd: String,
}

impl crate::common::HasOpId for GitAbortOperationParams {
    fn op_id(&self) -> &OpId {
        &self.op_id
    }
}

/// Params of `git/globalConfig/write`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GitGlobalConfigWriteParams {
    pub op_id: OpId,
    pub key: String,
    pub value: String,
}

impl crate::common::HasOpId for GitGlobalConfigWriteParams {
    fn op_id(&self) -> &OpId {
        &self.op_id
    }
}

/// Params of `git/cli/install`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
pub struct GitCliInstallParams {
    pub op_id: OpId,
}

impl crate::common::HasOpId for GitCliInstallParams {
    fn op_id(&self) -> &OpId {
        &self.op_id
    }
}

/// Params of `github/status`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
#[ts(optional_fields)]
pub struct GithubStatusParams {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub refresh: Option<bool>,
}

/// Params of `github/account`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
pub struct GithubAccountParams {}

/// Params of `github/login/start`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
#[ts(optional_fields)]
pub struct GithubLoginStartParams {
    pub op_id: OpId,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub open_browser: Option<bool>,
}

impl crate::common::HasOpId for GithubLoginStartParams {
    fn op_id(&self) -> &OpId {
        &self.op_id
    }
}

/// Params of `github/login/status`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
pub struct GithubLoginStatusParams {
    pub flow_id: LoginFlowId,
}

/// Params of `github/login/openBrowser`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
pub struct GithubLoginOpenBrowserParams {
    pub op_id: OpId,
    pub flow_id: LoginFlowId,
}

impl crate::common::HasOpId for GithubLoginOpenBrowserParams {
    fn op_id(&self) -> &OpId {
        &self.op_id
    }
}

/// Params of `github/login/cancel`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
pub struct GithubLoginCancelParams {
    pub op_id: OpId,
    pub flow_id: LoginFlowId,
}

impl crate::common::HasOpId for GithubLoginCancelParams {
    fn op_id(&self) -> &OpId {
        &self.op_id
    }
}

/// Params of `github/logout`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
pub struct GithubLogoutParams {
    pub op_id: OpId,
}

impl crate::common::HasOpId for GithubLogoutParams {
    fn op_id(&self) -> &OpId {
        &self.op_id
    }
}

/// Params of `github/install`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
pub struct GithubInstallParams {
    pub op_id: OpId,
}

impl crate::common::HasOpId for GithubInstallParams {
    fn op_id(&self) -> &OpId {
        &self.op_id
    }
}

/// Params of `github/request`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
pub struct GithubRequestParams {
    pub op_id: OpId,
    pub cwd: String,
    pub input: JsonValue,
}

impl crate::common::HasOpId for GithubRequestParams {
    fn op_id(&self) -> &OpId {
        &self.op_id
    }
}

/// Params of `github/starStatus`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
pub struct GithubStarStatusParams {}

/// Params of `github/star`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
pub struct GithubStarParams {
    pub op_id: OpId,
}

impl crate::common::HasOpId for GithubStarParams {
    fn op_id(&self) -> &OpId {
        &self.op_id
    }
}

/// Params of `github/pr/list`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
pub struct GithubPrListParams {
    pub cwd: String,
}

/// Params of `github/pr/view`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
pub struct GithubPrViewParams {
    pub cwd: String,
    pub value: JsonValue,
}

/// Params of `github/pr/diff`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
pub struct GithubPrDiffParams {
    pub cwd: String,
    pub value: JsonValue,
}

/// Params of `github/pr/defaultBranch`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
pub struct GithubPrDefaultBranchParams {
    pub cwd: String,
}

/// Params of `github/pr/create`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
pub struct GithubPrCreateParams {
    pub op_id: OpId,
    pub cwd: String,
    pub value: JsonValue,
}

impl crate::common::HasOpId for GithubPrCreateParams {
    fn op_id(&self) -> &OpId {
        &self.op_id
    }
}

/// Params of `github/pr/checkout`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
pub struct GithubPrCheckoutParams {
    pub op_id: OpId,
    pub cwd: String,
    pub value: JsonValue,
}

impl crate::common::HasOpId for GithubPrCheckoutParams {
    fn op_id(&self) -> &OpId {
        &self.op_id
    }
}

/// Params of `github/pr/merge`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
pub struct GithubPrMergeParams {
    pub op_id: OpId,
    pub cwd: String,
    pub value: JsonValue,
    pub method: JsonValue,
}

impl crate::common::HasOpId for GithubPrMergeParams {
    fn op_id(&self) -> &OpId {
        &self.op_id
    }
}

/// Params of `process/kill`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
pub struct ProcessKillParams {
    pub process_handle: ProcessHandle,
}

/// Params of `process/resizePty`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
pub struct ProcessResizePtyParams {
    pub process_handle: ProcessHandle,
    pub cols: u16,
    pub rows: u16,
}

/// Params of `process/writeStdin`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
#[ts(optional_fields)]
pub struct ProcessWriteStdinParams {
    pub process_handle: ProcessHandle,
    pub bytes_b64: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub close_stdin: Option<bool>,
}

/// Params of `terminal/ensure`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
#[ts(optional_fields)]
pub struct TerminalEnsureParams {
    pub op_id: OpId,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tab_id: Option<TerminalTabId>,
    pub options: JsonValue,
}

impl crate::common::HasOpId for TerminalEnsureParams {
    fn op_id(&self) -> &OpId {
        &self.op_id
    }
}

/// Params of `terminal/attach`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
#[ts(optional_fields)]
pub struct TerminalAttachParams {
    pub tab_id: TerminalTabId,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub resume_from: Option<JsonValue>,
}

/// Params of `terminal/profiles`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
pub struct TerminalProfilesParams {}

/// Params of `terminal/focus`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
pub struct TerminalFocusParams {
    pub tab_id: TerminalTabId,
    pub focused: bool,
}

/// Params of `terminal/pause`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
pub struct TerminalPauseParams {
    pub tab_id: TerminalTabId,
}

/// Params of `terminal/resume`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
pub struct TerminalResumeParams {
    pub tab_id: TerminalTabId,
}

/// Params of `terminal/dispose`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
pub struct TerminalDisposeParams {
    pub op_id: OpId,
    pub tab_id: TerminalTabId,
}

impl crate::common::HasOpId for TerminalDisposeParams {
    fn op_id(&self) -> &OpId {
        &self.op_id
    }
}

/// Params of `system/ports/subscribe`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
pub struct SystemPortsSubscribeParams {}

/// Params of `system/ports/unsubscribe`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
pub struct SystemPortsUnsubscribeParams {}

/// Params of `remoteAccess/setEnabled`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RemoteAccessSetEnabledParams {
    pub op_id: OpId,
    pub enabled: bool,
}

impl crate::common::HasOpId for RemoteAccessSetEnabledParams {
    fn op_id(&self) -> &OpId {
        &self.op_id
    }
}

/// Params of `remoteAccess/setName`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RemoteAccessSetNameParams {
    pub op_id: OpId,
    pub name: String,
}

impl crate::common::HasOpId for RemoteAccessSetNameParams {
    fn op_id(&self) -> &OpId {
        &self.op_id
    }
}

/// Params of `remoteAccess/setClientAlias`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RemoteAccessSetClientAliasParams {
    pub op_id: OpId,
    pub client_id: String,
    pub alias: String,
}

impl crate::common::HasOpId for RemoteAccessSetClientAliasParams {
    fn op_id(&self) -> &OpId {
        &self.op_id
    }
}

/// Params of `remoteAccess/rotate`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
pub struct RemoteAccessRotateParams {
    pub op_id: OpId,
}

impl crate::common::HasOpId for RemoteAccessRotateParams {
    fn op_id(&self) -> &OpId {
        &self.op_id
    }
}

/// Params of `remoteAccess/resolveClaim`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
pub struct RemoteAccessResolveClaimParams {
    pub op_id: OpId,
    pub claim_id: String,
    pub approve: bool,
}

impl crate::common::HasOpId for RemoteAccessResolveClaimParams {
    fn op_id(&self) -> &OpId {
        &self.op_id
    }
}

/// Params of `remoteAccess/pairCode`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
pub struct RemoteAccessPairCodeParams {
    pub op_id: OpId,
    pub action: String,
}

impl crate::common::HasOpId for RemoteAccessPairCodeParams {
    fn op_id(&self) -> &OpId {
        &self.op_id
    }
}

/// Params of `remoteAccess/revokeClient`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
pub struct RemoteAccessRevokeClientParams {
    pub op_id: OpId,
    pub client_id: String,
}

impl crate::common::HasOpId for RemoteAccessRevokeClientParams {
    fn op_id(&self) -> &OpId {
        &self.op_id
    }
}

/// Params of `remoteAccess/settleOwedControllerKeys`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
pub struct RemoteAccessSettleOwedControllerKeysParams {
    pub op_id: OpId,
    pub input: JsonValue,
}

impl crate::common::HasOpId for RemoteAccessSettleOwedControllerKeysParams {
    fn op_id(&self) -> &OpId {
        &self.op_id
    }
}

/// Params of `remoteAccess/deliverScreenControllerKey`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
pub struct RemoteAccessDeliverScreenControllerKeyParams {
    pub op_id: OpId,
    pub input: JsonValue,
}

impl crate::common::HasOpId for RemoteAccessDeliverScreenControllerKeyParams {
    fn op_id(&self) -> &OpId {
        &self.op_id
    }
}

/// Params of `remoteAccess/pushPublicKey`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
pub struct RemoteAccessPushPublicKeyParams {}

/// Params of `remoteAccess/registerPushSubscription`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
pub struct RemoteAccessRegisterPushSubscriptionParams {
    pub op_id: OpId,
    pub input: JsonValue,
}

impl crate::common::HasOpId for RemoteAccessRegisterPushSubscriptionParams {
    fn op_id(&self) -> &OpId {
        &self.op_id
    }
}

/// Params of `remoteAccess/removePushSubscription`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
pub struct RemoteAccessRemovePushSubscriptionParams {
    pub op_id: OpId,
    pub endpoint: String,
}

impl crate::common::HasOpId for RemoteAccessRemovePushSubscriptionParams {
    fn op_id(&self) -> &OpId {
        &self.op_id
    }
}

/// Params of `remoteAccess/registerNativePush`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
pub struct RemoteAccessRegisterNativePushParams {
    pub op_id: OpId,
    pub input: JsonValue,
}

impl crate::common::HasOpId for RemoteAccessRegisterNativePushParams {
    fn op_id(&self) -> &OpId {
        &self.op_id
    }
}

/// Params of `remoteAccess/removeNativePush`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
#[ts(optional_fields)]
pub struct RemoteAccessRemoveNativePushParams {
    pub op_id: OpId,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub token: Option<String>,
}

impl crate::common::HasOpId for RemoteAccessRemoveNativePushParams {
    fn op_id(&self) -> &OpId {
        &self.op_id
    }
}

/// Params of `browser/command`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
#[ts(optional_fields)]
pub struct BrowserCommandParams {
    pub action: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub input: Option<JsonValue>,
}

/// Params of `visualize/command`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
#[ts(optional_fields)]
pub struct VisualizeCommandParams {
    pub action: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub input: Option<JsonValue>,
}

/// Params of `notify/test`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
#[ts(optional_fields)]
pub struct NotifyTestParams {
    pub op_id: OpId,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub target: Option<String>,
}

impl crate::common::HasOpId for NotifyTestParams {
    fn op_id(&self) -> &OpId {
        &self.op_id
    }
}
