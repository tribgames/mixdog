//! The client request table (SPEC R19). Row order is the export order.

#[cfg(feature = "codegen")]
use mixdog_protocol::JsonValue;

use crate::v1;
use crate::v2;
use crate::v2::params::*;
use crate::v2::browser_engine::*;
use crate::v2::connections::*;
use crate::v2::desktop_residual::*;

crate::client_request_definitions! {
    /// Handshake and version gate (P §4.4).
    Initialize => "initialize" {
        params: v1::InitializeParams,
        result: v1::InitializeResponse,
        scope: none,
        class: C0,
        mutation: none,
        origins: [Local, Ssh, Relay],
    },
    /// Subscribes the app feed; replay or `app/snapshot`.
    AppSubscribe => "app/subscribe" {
        params: v2::feed::AppSubscribeParams,
        result: v2::feed::AppSubscribeResponse,
        scope: none,
        class: C0,
        mutation: none,
        origins: [Local, Ssh, Relay],
    },
    /// Subscribes a scoped feed whose id is known (`login:`, `media:`, `lsp:`).
    FeedSubscribe => "feed/subscribe" {
        params: v2::feed::FeedSubscribeParams,
        result: v2::feed::FeedSubscribeResponse,
        scope: none,
        class: C0,
        mutation: none,
        origins: [Local, Ssh, Relay],
    },
    /// Ends a scoped-feed subscription.
    FeedUnsubscribe => "feed/unsubscribe" {
        params: v2::feed::FeedUnsubscribeParams,
        result: v2::feed::EmptyResult,
        scope: none,
        class: C0,
        mutation: none,
        origins: [Local, Ssh, Relay],
    },
    /// Outcome of mutations whose response was lost; `fence` makes `notApplied` final (P §9.4).
    OpStatus => "op/status" {
        params: v2::op::OpStatusParams,
        result: v2::op::OpStatusResponse,
        scope: none,
        class: C0,
        mutation: none,
        origins: [Local, Ssh, Relay],
    },
    /// One page of a blob; not a mutation.
    BlobRead => "blob/read" {
        params: v2::op::BlobReadParams,
        result: v2::op::BlobReadResponse,
        scope: none,
        class: C1,
        mutation: none,
        origins: [Local, Ssh, Relay],
    },
    /// One upload chunk; content-addressed, not a mutation.
    BlobPut => "blob/put" {
        params: v2::op::BlobPutParams,
        result: v2::feed::EmptyResult,
        scope: none,
        class: C2,
        mutation: none,
        origins: [Local, Ssh, Relay],
    },
    /// Model catalog rows; pager of section `modelCatalog`.
    ModelList => "model/list" {
        params: ModelListParams,
        result: JsonValue,
        scope: none,
        class: C1,
        mutation: none,
        origins: [Local, Ssh, Relay],
    },
    /// Today's `submitFeedback`.
    FeedbackUpload => "feedback/upload" {
        params: FeedbackUploadParams,
        result: JsonValue,
        scope: none,
        class: C2,
        mutation: op(Feedback),
        origins: [Local, Ssh, Relay],
    },
    /// Secret answer of a `provide-secret` human gate.
    ApprovalProvideSecret => "approval/provideSecret" {
        params: v2::approval::ApprovalProvideSecretParams,
        result: v2::feed::EmptyResult,
        scope: none,
        class: C2,
        mutation: op(Approval),
        origins: [Local, Ssh, Relay],
    },
    /// Channel-bridge tool call (P §12.1).
    ChannelCall => "channel/call" {
        params: v2::domain::ChannelCallParams,
        result: JsonValue,
        scope: channel_call,
        class: C2,
        mutation: op(Channel),
        origins: [Local, Ssh],
    },
    /// One route write for a thread, an agent or the default (R15). `route` is a `ModelSelection` or today's route value.
    RouteSet => "route/set" {
        params: RouteSetParams,
        result: JsonValue,
        scope: thread_or_global(thread_id, "config"),
        class: C2,
        mutation: op(Config),
        origins: [Local, Ssh, Relay],
    },
    /// Fast mode for a thread or the default (R15); `toggleFast` is a client-side flip.
    FastSet => "fast/set" {
        params: FastSetParams,
        result: JsonValue,
        scope: thread_or_global(thread_id, "config"),
        class: C2,
        mutation: op(Config),
        origins: [Local, Ssh, Relay],
    },
    /// New thread; with `initialInput` also its first turn.
    ThreadStart => "thread/start" {
        params: v2::thread::ThreadStartParams,
        result: v2::thread::ThreadStartResponse,
        scope: none,
        class: C2,
        mutation: op(Core),
        origins: [Local, Ssh, Relay],
    },
    /// The only call that creates a thread subscription (P §6.3). A relay phone subscribes
    /// through Node's relay-handled `setVisibleSessions` (`remote-relay-client-calls.ts`),
    /// which the inventory maps to this call and `thread/unsubscribe`.
    ThreadResume => "thread/resume" {
        params: v2::thread::ThreadResumeParams,
        result: v2::thread::ThreadResumeResponse,
        scope: none,
        class: C0,
        mutation: none,
        origins: [Local, Ssh, Relay],
    },
    /// Ends the subscription; never stops work (X10).
    ThreadUnsubscribe => "thread/unsubscribe" {
        params: v2::thread::ThreadIdParams,
        result: v2::feed::EmptyResult,
        scope: none,
        class: C0,
        mutation: none,
        origins: [Local, Ssh, Relay],
    },
    /// Paged list rows.
    ThreadList => "thread/list" {
        params: v2::thread::ThreadListParams,
        result: v2::thread::ThreadListResponse,
        scope: none,
        class: C1,
        mutation: none,
        origins: [Local, Ssh, Relay],
    },
    /// One snapshot, no subscription.
    ThreadRead => "thread/read" {
        params: v2::thread::ThreadReadParams,
        result: v2::thread::ThreadReadResponse,
        scope: none,
        class: C1,
        mutation: none,
        origins: [Local, Ssh, Relay],
    },
    /// Turn pages.
    ThreadTurnsList => "thread/turns/list" {
        params: v2::thread::ThreadTurnsListParams,
        result: v2::thread::ThreadTurnsListResponse,
        scope: none,
        class: C1,
        mutation: none,
        origins: [Local, Ssh],
    },
    /// History pages; never changes a subscription.
    ThreadItemsList => "thread/items/list" {
        params: v2::thread::ThreadItemsListParams,
        result: v2::thread::ThreadItemsListResponse,
        scope: none,
        class: C1,
        mutation: none,
        origins: [Local, Ssh, Relay],
    },
    /// Full items including blob-stubbed fields.
    ThreadItemsRead => "thread/items/read" {
        params: v2::thread::ThreadItemsReadParams,
        result: v2::thread::ThreadItemsReadResponse,
        scope: none,
        class: C1,
        mutation: none,
        origins: [Local, Ssh, Relay],
    },
    /// Today's `session.read{attachmentHistory}`.
    ThreadAttachmentList => "thread/attachment/list" {
        params: v2::thread::ThreadPageParams,
        result: JsonValue,
        scope: none,
        class: C1,
        mutation: none,
        origins: [Local, Ssh],
    },
    /// Today's `session.read{messageStart}`.
    ThreadModelMessagesList => "thread/modelMessages/list" {
        params: v2::thread::ThreadModelMessagesListParams,
        result: JsonValue,
        scope: none,
        class: C1,
        mutation: none,
        origins: [Local, Ssh],
    },
    /// Today's `readSessionFinalAnswer`.
    ThreadFinalAnswerRead => "thread/finalAnswer/read" {
        params: v2::thread::ThreadFinalAnswerReadParams,
        result: JsonValue,
        scope: none,
        class: C1,
        mutation: none,
        origins: [Local, Ssh],
    },
    /// Today's `markSessionRead`.
    ThreadReadStateUpdate => "thread/readState/update" {
        params: v2::thread::ThreadReadStateUpdateParams,
        result: JsonValue,
        scope: thread(thread_id),
        class: C2,
        mutation: op(Thread),
        origins: [Local, Ssh, Relay],
    },
    /// Today's `searchSessionContent`.
    ThreadSearch => "thread/search" {
        params: v2::thread::ThreadSearchParams,
        result: JsonValue,
        scope: none,
        class: C3,
        mutation: none,
        origins: [Local, Ssh, Relay],
    },
    /// Rename.
    ThreadNameSet => "thread/name/set" {
        params: v2::thread::ThreadNameSetParams,
        result: JsonValue,
        scope: thread(thread_id),
        class: C2,
        mutation: op(Thread),
        origins: [Local, Ssh, Relay],
    },
    /// Favorite and project.
    ThreadMetadataUpdate => "thread/metadata/update" {
        params: v2::thread::ThreadMetadataUpdateParams,
        result: JsonValue,
        scope: thread(thread_id),
        class: C2,
        mutation: op(Thread),
        origins: [Local, Ssh, Relay],
    },
    /// Archive.
    ThreadArchive => "thread/archive" {
        params: v2::thread::ThreadOpParams,
        result: JsonValue,
        scope: thread(thread_id),
        class: C2,
        mutation: op(Thread),
        origins: [Local, Ssh, Relay],
    },
    /// Unarchive.
    ThreadUnarchive => "thread/unarchive" {
        params: v2::thread::ThreadOpParams,
        result: JsonValue,
        scope: thread(thread_id),
        class: C2,
        mutation: op(Thread),
        origins: [Local, Ssh, Relay],
    },
    /// Delete; `ifIdle` answers `{deleted: false, reason}` when not idle, never an error.
    ThreadDelete => "thread/delete" {
        params: v2::thread::ThreadDeleteParams,
        result: JsonValue,
        scope: thread(thread_id),
        class: C2,
        mutation: op(Thread),
        origins: [Local, Ssh, Relay],
    },
    /// Inherit into a new or an empty thread; the source is untouched.
    ThreadFork => "thread/fork" {
        params: v2::thread::ThreadForkParams,
        result: JsonValue,
        scope: thread(thread_id),
        class: C2,
        mutation: op(Thread),
        origins: [Local, Ssh, Relay],
    },
    /// Continue in another model.
    ThreadContinueInModel => "thread/continueInModel" {
        params: v2::thread::ThreadContinueInModelParams,
        result: JsonValue,
        scope: thread(thread_id),
        class: C2,
        mutation: op(Thread),
        origins: [Local, Ssh, Relay],
    },
    /// Item-granular rewind (X8).
    ThreadRewind => "thread/rewind" {
        params: v2::thread::ThreadRewindParams,
        result: JsonValue,
        scope: thread(thread_id),
        class: C2,
        mutation: op(Thread),
        origins: [Local, Ssh, Relay],
    },
    /// Clear history.
    ThreadClear => "thread/clear" {
        params: v2::thread::ThreadClearParams,
        result: JsonValue,
        scope: thread(thread_id),
        class: C2,
        mutation: op(Thread),
        origins: [Local, Ssh, Relay],
    },
    /// Answers when the compaction turn has started.
    ThreadCompactStart => "thread/compact/start" {
        params: v2::thread::ThreadCompactStartParams,
        result: JsonValue,
        scope: thread(thread_id),
        class: C2,
        mutation: op(Thread),
        origins: [Local, Ssh, Relay],
    },
    /// Today's `restoreQueued`.
    ThreadQueueDelete => "thread/queue/delete" {
        params: v2::thread::ThreadQueueDeleteParams,
        result: JsonValue,
        scope: thread(thread_id),
        class: C2,
        mutation: op(Thread),
        origins: [Local, Ssh, Relay],
    },
    /// Today's `answerApprovalNotification`: a notification's Allow or Deny on the approval the thread shows. Allow is taken only
    /// where the PC's card allows once with a bare Enter, and answers with that card's decision; like a server-request response,
    /// it is not an op.
    ThreadApprovalAnswerNotification => "thread/approval/answerNotification" {
        params: v2::approval::ThreadApprovalAnswerNotificationParams,
        result: v2::approval::ThreadApprovalAnswerNotificationResponse,
        scope: thread(thread_id),
        class: C2,
        mutation: none,
        origins: [Local, Ssh, Relay],
    },
    /// Today's `resolveToolApprovalForSession`: a card's decision on the approval request it shows, answered once the thread took
    /// it or another decision had (`accepted`), as Node's serialized answer was; like a server-request response, it is not an op.
    ThreadApprovalAnswer => "thread/approval/answer" {
        params: v2::approval::ThreadApprovalAnswerParams,
        result: v2::approval::ThreadApprovalAnswerResponse,
        scope: thread(thread_id),
        class: C2,
        mutation: none,
        origins: [Local, Ssh, Relay],
    },
    /// Set the goal.
    ThreadGoalSet => "thread/goal/set" {
        params: v2::thread::ThreadGoalSetParams,
        result: JsonValue,
        scope: thread(thread_id),
        class: C2,
        mutation: op(Thread),
        origins: [Local, Ssh, Relay],
    },
    /// Clear the goal.
    ThreadGoalClear => "thread/goal/clear" {
        params: v2::thread::ThreadOpParams,
        result: JsonValue,
        scope: thread(thread_id),
        class: C2,
        mutation: op(Thread),
        origins: [Local, Ssh, Relay],
    },
    /// The other `goalControl` actions.
    ThreadGoalControl => "thread/goal/control" {
        params: v2::thread::ThreadGoalControlParams,
        result: JsonValue,
        scope: thread(thread_id),
        class: C2,
        mutation: op(Thread),
        origins: [Local, Ssh, Relay],
    },
    /// Schedule a quota resume.
    ThreadQuotaResumeSchedule => "thread/quotaResume/schedule" {
        params: v2::thread::ThreadOpParams,
        result: JsonValue,
        scope: thread(thread_id),
        class: C2,
        mutation: op(Thread),
        origins: [Local, Ssh, Relay],
    },
    /// Cancel a quota resume.
    ThreadQuotaResumeCancel => "thread/quotaResume/cancel" {
        params: v2::thread::ThreadOpParams,
        result: JsonValue,
        scope: thread(thread_id),
        class: C2,
        mutation: op(Thread),
        origins: [Local, Ssh, Relay],
    },
    /// Stop one background shell job.
    ThreadBackgroundTerminalsTerminate => "thread/backgroundTerminals/terminate" {
        params: v2::thread::ThreadBackgroundTerminalParams,
        result: JsonValue,
        scope: thread(thread_id),
        class: C2,
        mutation: op(Thread),
        origins: [Local, Ssh, Relay],
    },
    /// Release an unconfirmed job.
    ThreadBackgroundTerminalsRelease => "thread/backgroundTerminals/release" {
        params: v2::thread::ThreadBackgroundTerminalParams,
        result: JsonValue,
        scope: thread(thread_id),
        class: C2,
        mutation: op(Thread),
        origins: [Local, Ssh, Relay],
    },
    /// Stop every background shell job of the thread.
    ThreadBackgroundTerminalsClean => "thread/backgroundTerminals/clean" {
        params: v2::thread::ThreadOpParams,
        result: JsonValue,
        scope: thread(thread_id),
        class: C2,
        mutation: op(Thread),
        origins: [Local, Ssh, Relay],
    },
    /// Start, or queue on a busy thread (X9).
    TurnStart => "turn/start" {
        params: v2::thread::TurnStartParams,
        result: v2::thread::TurnStartResponse,
        scope: thread(thread_id),
        class: C2,
        mutation: op(Thread),
        origins: [Local, Ssh, Relay],
    },
    /// Abort; C0 bypass, reply before durability (D-L1).
    TurnInterrupt => "turn/interrupt" {
        params: v2::thread::TurnInterruptParams,
        result: v2::thread::TurnInterruptResponse,
        scope: none,
        class: C0,
        mutation: none,
        origins: [Local, Ssh, Relay],
    },
    /// Prioritize a queued entry into the running turn.
    TurnSteer => "turn/steer" {
        params: v2::thread::TurnSteerParams,
        result: v2::thread::TurnSteerResponse,
        scope: none,
        class: C0,
        mutation: none,
        origins: [Local, Ssh, Relay],
    },
    /// Today's `retryFailedTurn`.
    TurnRetryFailed => "turn/retryFailed" {
        params: v2::thread::TurnRetryFailedParams,
        result: JsonValue,
        scope: thread(thread_id),
        class: C2,
        mutation: op(Thread),
        origins: [Local, Ssh, Relay],
    },
    /// Today's session read action `contextStatus`.
    ThreadContextStatus => "thread/contextStatus" {
        params: ThreadContextStatusParams,
        result: JsonValue,
        scope: none,
        class: C1,
        mutation: none,
        origins: [Local, Ssh, Relay],
    },
    /// Today's session read action `getSessionUsage`.
    ThreadGetSessionUsage => "thread/getSessionUsage" {
        params: ThreadGetSessionUsageParams,
        result: JsonValue,
        scope: none,
        class: C1,
        mutation: none,
        origins: [Local, Ssh, Relay],
    },
    /// Today's session read action `getSessionWorktreeWork`.
    ThreadGetSessionWorktreeWork => "thread/getSessionWorktreeWork" {
        params: ThreadGetSessionWorktreeWorkParams,
        result: JsonValue,
        scope: none,
        class: C1,
        mutation: none,
        origins: [Local, Ssh],
    },
    /// Today's session read action `inheritancePreflight`.
    ThreadInheritancePreflight => "thread/inheritancePreflight" {
        params: ThreadInheritancePreflightParams,
        result: JsonValue,
        scope: none,
        class: C1,
        mutation: none,
        origins: [Local, Ssh, Relay],
    },
    /// Today's session read action `listShellJobs`.
    ThreadListShellJobs => "thread/listShellJobs" {
        params: ThreadListShellJobsParams,
        result: JsonValue,
        scope: none,
        class: C1,
        mutation: none,
        origins: [Local, Ssh, Relay],
    },
    /// Today's session read action `listStoppableShellJobs`.
    ThreadListStoppableShellJobs => "thread/listStoppableShellJobs" {
        params: ThreadListStoppableShellJobsParams,
        result: JsonValue,
        scope: none,
        class: C1,
        mutation: none,
        origins: [Local, Ssh, Relay],
    },
    /// Today's session read action `getBranchMenu`.
    ThreadGetBranchMenu => "thread/getBranchMenu" {
        params: ThreadGetBranchMenuParams,
        result: JsonValue,
        scope: none,
        class: C1,
        mutation: none,
        origins: [Local, Ssh, Relay],
    },
    /// Today's session configure action `askSide`.
    ThreadAskSide => "thread/askSide" {
        params: ThreadAskSideParams,
        result: JsonValue,
        scope: thread_or_none(thread_id),
        class: C2,
        mutation: op(Thread),
        origins: [Local, Ssh, Relay],
    },
    /// Today's session configure action `cancelSide`.
    ThreadCancelSide => "thread/cancelSide" {
        params: ThreadCancelSideParams,
        result: JsonValue,
        scope: thread_or_none(thread_id),
        class: C2,
        mutation: op(Thread),
        origins: [Local, Ssh, Relay],
    },
    /// Today's session configure action `agentControl`.
    ThreadAgentControl => "thread/agentControl" {
        params: ThreadAgentControlParams,
        result: JsonValue,
        scope: thread_or_none(thread_id),
        class: C2,
        mutation: op(Thread),
        origins: [Local, Ssh, Relay],
    },
    /// Today's session configure action `switchContext`.
    ThreadSwitchContext => "thread/switchContext" {
        params: ThreadSwitchContextParams,
        result: JsonValue,
        scope: thread_or_none(thread_id),
        class: C2,
        mutation: op(Thread),
        origins: [Local, Ssh],
    },
    /// Today's session configure action `setCwd`.
    ThreadSetCwd => "thread/setCwd" {
        params: ThreadSetCwdParams,
        result: JsonValue,
        scope: thread_or_none(thread_id),
        class: C2,
        mutation: op(Thread),
        origins: [Local, Ssh],
    },
    /// Today's session configure action `setEffort`.
    ThreadSetEffort => "thread/setEffort" {
        params: ThreadSetEffortParams,
        result: JsonValue,
        scope: thread_or_none(thread_id),
        class: C2,
        mutation: op(Thread),
        origins: [Local, Ssh, Relay],
    },
    /// Today's session configure action `setToolMode`.
    ThreadSetToolMode => "thread/setToolMode" {
        params: ThreadSetToolModeParams,
        result: JsonValue,
        scope: thread_or_none(thread_id),
        class: C2,
        mutation: op(Thread),
        origins: [Local, Ssh, Relay],
    },
    /// Today's session configure action `setWorkflow`.
    ThreadSetWorkflow => "thread/setWorkflow" {
        params: ThreadSetWorkflowParams,
        result: JsonValue,
        scope: thread_or_none(thread_id),
        class: C2,
        mutation: op(Thread),
        origins: [Local, Ssh, Relay],
    },
    /// Today's session configure action `setOrchestrationMode`.
    ThreadSetOrchestrationMode => "thread/setOrchestrationMode" {
        params: ThreadSetOrchestrationModeParams,
        result: JsonValue,
        scope: thread_or_none(thread_id),
        class: C2,
        mutation: op(Thread),
        origins: [Local, Ssh, Relay],
    },
    /// Today's session configure action `setOutputStyle`.
    ThreadSetOutputStyle => "thread/setOutputStyle" {
        params: ThreadSetOutputStyleParams,
        result: JsonValue,
        scope: thread_or_none(thread_id),
        class: C2,
        mutation: op(Thread),
        origins: [Local, Ssh, Relay],
    },
    /// Today's session configure action `revertTurnReview`.
    ThreadRevertTurnReview => "thread/revertTurnReview" {
        params: ThreadRevertTurnReviewParams,
        result: JsonValue,
        scope: thread_or_none(thread_id),
        class: C2,
        mutation: op(Thread),
        origins: [Local, Ssh, Relay],
    },
    /// Today's session configure action `revertTurnReviewFile`.
    ThreadRevertTurnReviewFile => "thread/revertTurnReviewFile" {
        params: ThreadRevertTurnReviewFileParams,
        result: JsonValue,
        scope: thread_or_none(thread_id),
        class: C2,
        mutation: op(Thread),
        origins: [Local, Ssh, Relay],
    },
    /// Today's session configure action `revertTurnChanges`.
    ThreadRevertTurnChanges => "thread/revertTurnChanges" {
        params: ThreadRevertTurnChangesParams,
        result: JsonValue,
        scope: thread_or_none(thread_id),
        class: C2,
        mutation: op(Thread),
        origins: [Local, Ssh, Relay],
    },
    /// Today's session configure action `reapplyTurnChanges`.
    ThreadReapplyTurnChanges => "thread/reapplyTurnChanges" {
        params: ThreadReapplyTurnChangesParams,
        result: JsonValue,
        scope: thread_or_none(thread_id),
        class: C2,
        mutation: op(Thread),
        origins: [Local, Ssh, Relay],
    },
    /// Today's session configure action `clearSessionChangeHistory`.
    ThreadClearSessionChangeHistory => "thread/clearSessionChangeHistory" {
        params: ThreadClearSessionChangeHistoryParams,
        result: JsonValue,
        scope: thread_or_none(thread_id),
        class: C2,
        mutation: op(Thread),
        origins: [Local, Ssh, Relay],
    },
    /// Today's session configure action `stageAttachmentOriginal`.
    ThreadStageAttachmentOriginal => "thread/stageAttachmentOriginal" {
        params: ThreadStageAttachmentOriginalParams,
        result: JsonValue,
        scope: thread_or_none(thread_id),
        class: C2,
        mutation: op(Thread),
        origins: [Local, Ssh, Relay],
    },
    /// Today's session configure action `resizeImage`.
    ThreadResizeImage => "thread/resizeImage" {
        params: ThreadResizeImageParams,
        result: JsonValue,
        scope: thread_or_none(thread_id),
        class: C2,
        mutation: op(Thread),
        origins: [Local, Ssh, Relay],
    },
    /// Today's session configure action `pushNotice`.
    ThreadPushNotice => "thread/pushNotice" {
        params: ThreadPushNoticeParams,
        result: JsonValue,
        scope: thread_or_none(thread_id),
        class: C2,
        mutation: op(Thread),
        origins: [Local, Ssh],
    },
    /// Today's session configure action `requestWorktree`.
    ThreadRequestWorktree => "thread/requestWorktree" {
        params: ThreadRequestWorktreeParams,
        result: JsonValue,
        scope: thread_or_none(thread_id),
        class: C2,
        mutation: op(Thread),
        origins: [Local, Ssh, Relay],
    },
    /// Today's session configure action `mergeWorkspace`.
    ThreadMergeWorkspace => "thread/mergeWorkspace" {
        params: ThreadMergeWorkspaceParams,
        result: JsonValue,
        scope: thread_or_none(thread_id),
        class: C2,
        mutation: op(Thread),
        origins: [Local, Ssh, Relay],
    },
    /// Today's session configure action `selectBranch`.
    ThreadSelectBranch => "thread/selectBranch" {
        params: ThreadSelectBranchParams,
        result: JsonValue,
        scope: thread_or_none(thread_id),
        class: C2,
        mutation: op(Thread),
        origins: [Local, Ssh, Relay],
    },
    /// Today's session read action `inspectProjectBranch`.
    ProjectInspectProjectBranch => "project/inspectProjectBranch" {
        params: ProjectInspectProjectBranchParams,
        result: JsonValue,
        scope: none,
        class: C1,
        mutation: none,
        origins: [Local, Ssh, Relay],
    },
    /// Today's session read action `getProjectBranchMenu`.
    ProjectGetProjectBranchMenu => "project/getProjectBranchMenu" {
        params: ProjectGetProjectBranchMenuParams,
        result: JsonValue,
        scope: none,
        class: C1,
        mutation: none,
        origins: [Local, Ssh, Relay],
    },
    /// Today's session read action `getProjectConnectors`.
    ProjectGetProjectConnectors => "project/getProjectConnectors" {
        params: ProjectGetProjectConnectorsParams,
        result: JsonValue,
        scope: none,
        class: C1,
        mutation: none,
        origins: [Local, Ssh, Relay],
    },
    /// Today's session read action `listWorktrees`.
    ProjectListWorktrees => "project/listWorktrees" {
        params: ProjectListWorktreesParams,
        result: JsonValue,
        scope: none,
        class: C1,
        mutation: none,
        origins: [Local, Ssh, Relay],
    },
    /// Today's session read action `previewWorktreeCleanup`.
    ProjectPreviewWorktreeCleanup => "project/previewWorktreeCleanup" {
        params: ProjectPreviewWorktreeCleanupParams,
        result: JsonValue,
        scope: none,
        class: C1,
        mutation: none,
        origins: [Local, Ssh, Relay],
    },
    /// Today's session configure action `selectProjectBranch`.
    ProjectSelectProjectBranch => "project/selectProjectBranch" {
        params: ProjectSelectProjectBranchParams,
        result: JsonValue,
        scope: thread_or_none(thread_id),
        class: C2,
        mutation: op(Project),
        origins: [Local, Ssh, Relay],
    },
    /// Today's session configure action `mergeProjectBranch`.
    ProjectMergeProjectBranch => "project/mergeProjectBranch" {
        params: ProjectMergeProjectBranchParams,
        result: JsonValue,
        scope: thread_or_none(thread_id),
        class: C2,
        mutation: op(Project),
        origins: [Local, Ssh, Relay],
    },
    /// Today's session configure action `manageProjectBranch`.
    ProjectManageProjectBranch => "project/manageProjectBranch" {
        params: ProjectManageProjectBranchParams,
        result: JsonValue,
        scope: thread_or_none(thread_id),
        class: C2,
        mutation: op(Project),
        origins: [Local, Ssh, Relay],
    },
    /// Today's session configure action `removeWorktree`.
    ProjectRemoveWorktree => "project/removeWorktree" {
        params: ProjectRemoveWorktreeParams,
        result: JsonValue,
        scope: thread_or_none(thread_id),
        class: C2,
        mutation: op(Project),
        origins: [Local, Ssh, Relay],
    },
    /// Today's session configure action `pruneWorktrees`.
    ProjectPruneWorktrees => "project/pruneWorktrees" {
        params: ProjectPruneWorktreesParams,
        result: JsonValue,
        scope: thread_or_none(thread_id),
        class: C2,
        mutation: op(Project),
        origins: [Local, Ssh, Relay],
    },
    /// Today's session configure action `deleteWorktree`.
    ProjectDeleteWorktree => "project/deleteWorktree" {
        params: ProjectDeleteWorktreeParams,
        result: JsonValue,
        scope: thread_or_none(thread_id),
        class: C2,
        mutation: op(Project),
        origins: [Local, Ssh, Relay],
    },
    /// Today's session configure action `setArchivedSessionWorktrees`.
    ProjectSetArchivedSessionWorktrees => "project/setArchivedSessionWorktrees" {
        params: ProjectSetArchivedSessionWorktreesParams,
        result: JsonValue,
        scope: thread_or_none(thread_id),
        class: C2,
        mutation: op(Project),
        origins: [Local, Ssh],
    },
    /// Today's session configure action `setProjectConnectorEnabled`.
    ProjectSetProjectConnectorEnabled => "project/setProjectConnectorEnabled" {
        params: ProjectSetProjectConnectorEnabledParams,
        result: JsonValue,
        scope: thread_or_none(thread_id),
        class: C2,
        mutation: op(Project),
        origins: [Local, Ssh, Relay],
    },
    /// Today's session read action `agentDefinitionPresence`.
    AgentAgentDefinitionPresence => "agent/agentDefinitionPresence" {
        params: AgentAgentDefinitionPresenceParams,
        result: JsonValue,
        scope: none,
        class: C1,
        mutation: none,
        origins: [Local, Ssh],
    },
    /// Today's session read action `archivedAgentIdentities`.
    AgentArchivedAgentIdentities => "agent/archivedAgentIdentities" {
        params: AgentArchivedAgentIdentitiesParams,
        result: JsonValue,
        scope: none,
        class: C1,
        mutation: none,
        origins: [Local, Ssh, Relay],
    },
    /// Today's session read action `getAgentDefinition`.
    AgentGetAgentDefinition => "agent/getAgentDefinition" {
        params: AgentGetAgentDefinitionParams,
        result: JsonValue,
        scope: none,
        class: C1,
        mutation: none,
        origins: [Local, Ssh, Relay],
    },
    /// Today's session read action `getAgentAvatarImage`.
    AgentGetAgentAvatarImage => "agent/getAgentAvatarImage" {
        params: AgentGetAgentAvatarImageParams,
        result: JsonValue,
        scope: none,
        class: C1,
        mutation: none,
        origins: [Local, Ssh, Relay],
    },
    /// Today's session read action `getAgentConnectors`.
    AgentGetAgentConnectors => "agent/getAgentConnectors" {
        params: AgentGetAgentConnectorsParams,
        result: JsonValue,
        scope: none,
        class: C1,
        mutation: none,
        origins: [Local, Ssh, Relay],
    },
    /// Today's session read action `getAgentAlwaysAllowedTools`.
    AgentGetAgentAlwaysAllowedTools => "agent/getAgentAlwaysAllowedTools" {
        params: AgentGetAgentAlwaysAllowedToolsParams,
        result: JsonValue,
        scope: none,
        class: C1,
        mutation: none,
        origins: [Local, Ssh, Relay],
    },
    /// Today's session read action `getAgentConnectorTools`.
    AgentGetAgentConnectorTools => "agent/getAgentConnectorTools" {
        params: AgentGetAgentConnectorToolsParams,
        result: JsonValue,
        scope: none,
        class: C1,
        mutation: none,
        origins: [Local, Ssh, Relay],
    },
    /// Today's session read action `getAgentPermissions`.
    AgentGetAgentPermissions => "agent/getAgentPermissions" {
        params: AgentGetAgentPermissionsParams,
        result: JsonValue,
        scope: none,
        class: C1,
        mutation: none,
        origins: [Local, Ssh, Relay],
    },
    /// Today's session read action `getLeadPersona`.
    AgentGetLeadPersona => "agent/getLeadPersona" {
        params: AgentGetLeadPersonaParams,
        result: JsonValue,
        scope: none,
        class: C1,
        mutation: none,
        origins: [Local, Ssh, Relay],
    },
    /// Today's session read action `getLeadAgentBody`.
    AgentGetLeadAgentBody => "agent/getLeadAgentBody" {
        params: AgentGetLeadAgentBodyParams,
        result: JsonValue,
        scope: none,
        class: C1,
        mutation: none,
        origins: [Local, Ssh, Relay],
    },
    /// Today's session read action `getLeadStatus`.
    AgentGetLeadStatus => "agent/getLeadStatus" {
        params: AgentGetLeadStatusParams,
        result: JsonValue,
        scope: none,
        class: C1,
        mutation: none,
        origins: [Local, Ssh, Relay],
    },
    /// Today's session read action `getLeadHomeRoute`.
    AgentGetLeadHomeRoute => "agent/getLeadHomeRoute" {
        params: AgentGetLeadHomeRouteParams,
        result: JsonValue,
        scope: none,
        class: C1,
        mutation: none,
        origins: [Local, Ssh],
    },
    /// Today's session read action `getLeadAppearance`.
    AgentGetLeadAppearance => "agent/getLeadAppearance" {
        params: AgentGetLeadAppearanceParams,
        result: JsonValue,
        scope: none,
        class: C1,
        mutation: none,
        origins: [Local, Ssh, Relay],
    },
    /// Today's session configure action `saveAgentDefinition`.
    AgentSaveAgentDefinition => "agent/saveAgentDefinition" {
        params: AgentSaveAgentDefinitionParams,
        result: JsonValue,
        scope: thread_or_none(thread_id),
        class: C2,
        mutation: op(Agent),
        origins: [Local, Ssh, Relay],
    },
    /// Today's session configure action `deleteAgentDefinition`.
    AgentDeleteAgentDefinition => "agent/deleteAgentDefinition" {
        params: AgentDeleteAgentDefinitionParams,
        result: JsonValue,
        scope: thread_or_none(thread_id),
        class: C2,
        mutation: op(Agent),
        origins: [Local, Ssh, Relay],
    },
    /// Today's session configure action `restoreAgentDefinition`.
    AgentRestoreAgentDefinition => "agent/restoreAgentDefinition" {
        params: AgentRestoreAgentDefinitionParams,
        result: JsonValue,
        scope: thread_or_none(thread_id),
        class: C2,
        mutation: op(Agent),
        origins: [Local, Ssh, Relay],
    },
    /// Today's session configure action `purgeAgentDefinition`.
    AgentPurgeAgentDefinition => "agent/purgeAgentDefinition" {
        params: AgentPurgeAgentDefinitionParams,
        result: JsonValue,
        scope: thread_or_none(thread_id),
        class: C2,
        mutation: op(Agent),
        origins: [Local, Ssh],
    },
    /// Today's session configure action `setAgentConnectors`.
    AgentSetAgentConnectors => "agent/setAgentConnectors" {
        params: AgentSetAgentConnectorsParams,
        result: JsonValue,
        scope: thread_or_none(thread_id),
        class: C2,
        mutation: op(Agent),
        origins: [Local, Ssh, Relay],
    },
    /// Today's session configure action `setAgentConnectorEnabled`.
    AgentSetAgentConnectorEnabled => "agent/setAgentConnectorEnabled" {
        params: AgentSetAgentConnectorEnabledParams,
        result: JsonValue,
        scope: thread_or_none(thread_id),
        class: C2,
        mutation: op(Agent),
        origins: [Local, Ssh, Relay],
    },
    /// Today's session configure action `setAgentConnectorToolPermission`.
    AgentSetAgentConnectorToolPermission => "agent/setAgentConnectorToolPermission" {
        params: AgentSetAgentConnectorToolPermissionParams,
        result: JsonValue,
        scope: thread_or_none(thread_id),
        class: C2,
        mutation: op(Agent),
        origins: [Local, Ssh, Relay],
    },
    /// Today's session configure action `setAgentPermission`.
    AgentSetAgentPermission => "agent/setAgentPermission" {
        params: AgentSetAgentPermissionParams,
        result: JsonValue,
        scope: thread_or_none(thread_id),
        class: C2,
        mutation: op(Agent),
        origins: [Local, Ssh, Relay],
    },
    /// Today's session configure action `recordAgentApprovalAudit`.
    AgentRecordAgentApprovalAudit => "agent/recordAgentApprovalAudit" {
        params: AgentRecordAgentApprovalAuditParams,
        result: JsonValue,
        scope: thread_or_none(thread_id),
        class: C2,
        mutation: op(Agent),
        origins: [Local, Ssh],
    },
    /// Today's session configure action `saveLeadPersona`.
    AgentSaveLeadPersona => "agent/saveLeadPersona" {
        params: AgentSaveLeadPersonaParams,
        result: JsonValue,
        scope: thread_or_none(thread_id),
        class: C2,
        mutation: op(Agent),
        origins: [Local, Ssh, Relay],
    },
    /// Today's session configure action `saveLeadAgentBody`.
    AgentSaveLeadAgentBody => "agent/saveLeadAgentBody" {
        params: AgentSaveLeadAgentBodyParams,
        result: JsonValue,
        scope: thread_or_none(thread_id),
        class: C2,
        mutation: op(Agent),
        origins: [Local, Ssh, Relay],
    },
    /// Today's session configure action `setLeadCreated`.
    AgentSetLeadCreated => "agent/setLeadCreated" {
        params: AgentSetLeadCreatedParams,
        result: JsonValue,
        scope: thread_or_none(thread_id),
        class: C2,
        mutation: op(Agent),
        origins: [Local, Ssh, Relay],
    },
    /// Today's session configure action `saveLeadIdentity`.
    AgentSaveLeadIdentity => "agent/saveLeadIdentity" {
        params: AgentSaveLeadIdentityParams,
        result: JsonValue,
        scope: thread_or_none(thread_id),
        class: C2,
        mutation: op(Agent),
        origins: [Local, Ssh, Relay],
    },
    /// Today's session configure action `setLeadAppearance`.
    AgentSetLeadAppearance => "agent/setLeadAppearance" {
        params: AgentSetLeadAppearanceParams,
        result: JsonValue,
        scope: thread_or_none(thread_id),
        class: C2,
        mutation: op(Agent),
        origins: [Local, Ssh, Relay],
    },
    /// Today's session read action `getBotOrder`.
    ConfigGetBotOrder => "config/getBotOrder" {
        params: ConfigGetBotOrderParams,
        result: BotOrder,
        scope: thread_or_shared_read(thread_id, "config"),
        class: C1,
        mutation: none,
        origins: [Local, Ssh, Relay],
    },
    /// Today's session configure action `setBotOrder`; answers the order as stored.
    ConfigSetBotOrder => "config/setBotOrder" {
        params: ConfigSetBotOrderParams,
        result: BotOrder,
        scope: thread_or_global(thread_id, "config"),
        class: C2,
        mutation: op(Config),
        origins: [Local, Ssh, Relay],
    },
    /// Today's `openAgentHome`.
    AgentHomeOpen => "agent/home/open" {
        params: AgentHomeOpenParams,
        result: JsonValue,
        scope: keyed("agentHome", agent_id),
        class: C2,
        mutation: op(Agent),
        origins: [Local, Ssh, Relay],
    },
    /// Today's `resetAgentHome`.
    AgentHomeReset => "agent/home/reset" {
        params: AgentHomeResetParams,
        result: JsonValue,
        scope: keyed("agentHome", agent_id),
        class: C2,
        mutation: op(Agent),
        origins: [Local, Ssh, Relay],
    },
    /// Today's `listAgentMemory`.
    AgentMemoryList => "agent/memory/list" {
        params: AgentMemoryListParams,
        result: JsonValue,
        scope: none,
        class: C1,
        mutation: none,
        origins: [Local, Ssh],
    },
    /// Revision mismatch → `preconditionFailed`.
    AgentMemoryDelete => "agent/memory/delete" {
        params: AgentMemoryDeleteParams,
        result: JsonValue,
        scope: keyed("agentMemory", agent_id),
        class: C2,
        mutation: op(Agent),
        origins: [Local, Ssh],
    },
    /// Snapshot read; section `agentPool` is the source.
    AgentPoolList => "agent/pool/list" {
        params: AgentPoolListParams,
        result: JsonValue,
        scope: none,
        class: C1,
        mutation: none,
        origins: [Local, Ssh, Relay],
    },
    /// Today's `agentRoomAction('create', …)`.
    RoomCreate => "room/create" {
        params: RoomCreateParams,
        result: JsonValue,
        scope: global("room"),
        class: C2,
        mutation: op(Room),
        origins: [Local, Ssh, Relay],
    },
    /// Today's `agentRoomAction('update', …)`.
    RoomUpdate => "room/update" {
        params: RoomUpdateParams,
        result: JsonValue,
        scope: global("room"),
        class: C2,
        mutation: op(Room),
        origins: [Local, Ssh, Relay],
    },
    /// Today's `agentRoomAction('continue', …)`.
    RoomContinue => "room/continue" {
        params: RoomContinueParams,
        result: JsonValue,
        scope: global("room"),
        class: C2,
        mutation: op(Room),
        origins: [Local, Ssh, Relay],
    },
    /// Today's `agentRoomAction('leave', …)`.
    RoomLeave => "room/leave" {
        params: RoomLeaveParams,
        result: JsonValue,
        scope: global("room"),
        class: C2,
        mutation: op(Room),
        origins: [Local, Ssh, Relay],
    },
    /// Today's `submitToSession` on a room log (`session-host.ts:1089-1091` → `agentRooms.send`): a user's message posted
    /// into the room and routed to its members; the reply is `true`.
    RoomSend => "room/send" {
        params: RoomSendParams,
        result: JsonValue,
        scope: global("room"),
        class: C2,
        mutation: op(Room),
        origins: [Local, Ssh, Relay],
    },
    /// Today's `agentRoomAction('reset', …)`: the room's log starts over, its members' sessions are emptied.
    RoomReset => "room/reset" {
        params: RoomResetParams,
        result: JsonValue,
        scope: global("room"),
        class: C2,
        mutation: op(Room),
        origins: [Local, Ssh, Relay],
    },
    /// Today's `agentRoomAction('remove', …)`.
    RoomRemove => "room/remove" {
        params: RoomRemoveParams,
        result: JsonValue,
        scope: global("room"),
        class: C2,
        mutation: op(Room),
        origins: [Local, Ssh, Relay],
    },
    /// Today's session read action `listInstructionFiles`.
    InstructionsListInstructionFiles => "instructions/listInstructionFiles" {
        params: InstructionsListInstructionFilesParams,
        result: JsonValue,
        scope: none,
        class: C1,
        mutation: none,
        origins: [Local, Ssh, Relay],
    },
    /// Today's session read action `getInstructionFile`.
    InstructionsGetInstructionFile => "instructions/getInstructionFile" {
        params: InstructionsGetInstructionFileParams,
        result: JsonValue,
        scope: none,
        class: C1,
        mutation: none,
        origins: [Local, Ssh, Relay],
    },
    /// Today's session configure action `saveInstructionFile`.
    InstructionsSaveInstructionFile => "instructions/saveInstructionFile" {
        params: InstructionsSaveInstructionFileParams,
        result: JsonValue,
        scope: thread_or_none(thread_id),
        class: C2,
        mutation: op(Instructions),
        origins: [Local, Ssh, Relay],
    },
    /// Today's session configure action `resetInstructionFile`.
    InstructionsResetInstructionFile => "instructions/resetInstructionFile" {
        params: InstructionsResetInstructionFileParams,
        result: JsonValue,
        scope: thread_or_none(thread_id),
        class: C2,
        mutation: op(Instructions),
        origins: [Local, Ssh, Relay],
    },
    /// Today's session configure action `setInstructionFiles`.
    InstructionsSetInstructionFiles => "instructions/setInstructionFiles" {
        params: InstructionsSetInstructionFilesParams,
        result: JsonValue,
        scope: thread_or_none(thread_id),
        class: C2,
        mutation: op(Instructions),
        origins: [Local, Ssh, Relay],
    },
    /// Today's session read action `listConnectorTools`.
    ConnectorListConnectorTools => "connector/listConnectorTools" {
        params: ConnectorListConnectorToolsParams,
        result: JsonValue,
        scope: none,
        class: C1,
        mutation: none,
        origins: [Local, Ssh, Relay],
    },
    /// Today's session configure action `addConnectorAccount`.
    ConnectorAddConnectorAccount => "connector/addConnectorAccount" {
        params: ConnectorAddConnectorAccountParams,
        result: JsonValue,
        scope: thread_or_none(thread_id),
        class: C2,
        mutation: op(Connector),
        origins: [Local, Ssh, Relay],
    },
    /// Today's session read action `getAutoClear`.
    ConfigGetAutoClear => "config/getAutoClear" {
        params: ConfigGetAutoClearParams,
        result: JsonValue,
        scope: thread_or_shared_read(thread_id, "config"),
        class: C1,
        mutation: none,
        origins: [Local, Ssh, Relay],
    },
    /// Today's session read action `getCacheWarmingSettings`.
    ConfigGetCacheWarmingSettings => "config/getCacheWarmingSettings" {
        params: ConfigGetCacheWarmingSettingsParams,
        result: JsonValue,
        scope: thread_or_shared_read(thread_id, "config"),
        class: C1,
        mutation: none,
        origins: [Local, Ssh, Relay],
    },
    /// Today's session read action `getCompactionSettings`.
    ConfigGetCompactionSettings => "config/getCompactionSettings" {
        params: ConfigGetCompactionSettingsParams,
        result: JsonValue,
        scope: thread_or_shared_read(thread_id, "config"),
        class: C1,
        mutation: none,
        origins: [Local, Ssh, Relay],
    },
    /// Today's session read action `getDeveloperSettings`.
    ConfigGetDeveloperSettings => "config/getDeveloperSettings" {
        params: ConfigGetDeveloperSettingsParams,
        result: JsonValue,
        scope: thread_or_shared_read(thread_id, "config"),
        class: C1,
        mutation: none,
        origins: [Local, Ssh, Relay],
    },
    /// Today's session read action `getOutputStyle`.
    ConfigGetOutputStyle => "config/getOutputStyle" {
        params: ConfigGetOutputStyleParams,
        result: JsonValue,
        scope: thread_or_shared_read(thread_id, "config"),
        class: C1,
        mutation: none,
        origins: [Local, Ssh, Relay],
    },
    /// Today's session read action `getOrchestrationMode`.
    ConfigGetOrchestrationMode => "config/getOrchestrationMode" {
        params: ConfigGetOrchestrationModeParams,
        result: JsonValue,
        scope: thread_or_shared_read(thread_id, "config"),
        class: C1,
        mutation: none,
        origins: [Local, Ssh, Relay],
    },
    /// Today's session read action `getConfiguredOrchestrationMode`.
    ConfigGetConfiguredOrchestrationMode => "config/getConfiguredOrchestrationMode" {
        params: ConfigGetConfiguredOrchestrationModeParams,
        result: JsonValue,
        scope: thread_or_shared_read(thread_id, "config"),
        class: C1,
        mutation: none,
        origins: [Local, Ssh, Relay],
    },
    /// Today's session read action `getProfile`.
    ConfigGetProfile => "config/getProfile" {
        params: ConfigGetProfileParams,
        result: JsonValue,
        scope: thread_or_shared_read(thread_id, "config"),
        class: C1,
        mutation: none,
        origins: [Local, Ssh, Relay],
    },
    /// Today's session read action `getRecapSettings`.
    ConfigGetRecapSettings => "config/getRecapSettings" {
        params: ConfigGetRecapSettingsParams,
        result: JsonValue,
        scope: thread_or_shared_read(thread_id, "config"),
        class: C1,
        mutation: none,
        origins: [Local, Ssh, Relay],
    },
    /// Today's session read action `getSessionTitleSettings`.
    ConfigGetSessionTitleSettings => "config/getSessionTitleSettings" {
        params: ConfigGetSessionTitleSettingsParams,
        result: JsonValue,
        scope: thread_or_shared_read(thread_id, "config"),
        class: C1,
        mutation: none,
        origins: [Local, Ssh, Relay],
    },
    /// Today's session read action `getHeartbeatSettings`.
    ConfigGetHeartbeatSettings => "config/getHeartbeatSettings" {
        params: ConfigGetHeartbeatSettingsParams,
        result: JsonValue,
        scope: thread_or_shared_read(thread_id, "config"),
        class: C1,
        mutation: none,
        origins: [Local, Ssh, Relay],
    },
    /// Today's session read action `getReactionSettings`.
    ConfigGetReactionSettings => "config/getReactionSettings" {
        params: ConfigGetReactionSettingsParams,
        result: JsonValue,
        scope: thread_or_shared_read(thread_id, "config"),
        class: C1,
        mutation: none,
        origins: [Local, Ssh, Relay],
    },
    /// Today's session read action `getSystemShell`.
    ConfigGetSystemShell => "config/getSystemShell" {
        params: ConfigGetSystemShellParams,
        result: JsonValue,
        scope: thread_or_shared_read(thread_id, "config"),
        class: C1,
        mutation: none,
        origins: [Local, Ssh, Relay],
    },
    /// Today's session read action `getTheme`.
    ConfigGetTheme => "config/getTheme" {
        params: ConfigGetThemeParams,
        result: JsonValue,
        scope: thread_or_shared_read(thread_id, "config"),
        class: C1,
        mutation: none,
        origins: [Local, Ssh, Relay],
    },
    /// Today's session read action `getToolModuleSettings`.
    ConfigGetToolModuleSettings => "config/getToolModuleSettings" {
        params: ConfigGetToolModuleSettingsParams,
        result: mixdog_protocol::ToolModuleSettings,
        scope: thread_or_shared_read(thread_id, "config"),
        class: C1,
        mutation: none,
        origins: [Local, Ssh, Relay],
    },
    /// Today's session read action `getUpdateSettings`.
    ConfigGetUpdateSettings => "config/getUpdateSettings" {
        params: ConfigGetUpdateSettingsParams,
        result: JsonValue,
        scope: thread_or_shared_read(thread_id, "config"),
        class: C1,
        mutation: none,
        origins: [Local, Ssh, Relay],
    },
    /// Today's session read action `getWorktreeSettings`.
    ConfigGetWorktreeSettings => "config/getWorktreeSettings" {
        params: ConfigGetWorktreeSettingsParams,
        result: JsonValue,
        scope: thread_or_shared_read(thread_id, "config"),
        class: C1,
        mutation: none,
        origins: [Local, Ssh, Relay],
    },
    /// Today's session read action `listOutputStyles`.
    ConfigListOutputStyles => "config/listOutputStyles" {
        params: ConfigListOutputStylesParams,
        result: JsonValue,
        scope: thread_or_shared_read(thread_id, "config"),
        class: C1,
        mutation: none,
        origins: [Local, Ssh, Relay],
    },
    /// Today's session read action `getNetworkProxy`.
    ConfigGetNetworkProxy => "config/getNetworkProxy" {
        params: ConfigGetNetworkProxyParams,
        result: JsonValue,
        scope: thread_or_shared_read(thread_id, "config"),
        class: C1,
        mutation: none,
        origins: [Local, Ssh, Relay],
    },
    /// Today's session read action `testNetworkProxy`.
    ConfigTestNetworkProxy => "config/testNetworkProxy" {
        params: ConfigTestNetworkProxyParams,
        result: JsonValue,
        scope: thread_or_shared_read(thread_id, "config"),
        class: C1,
        mutation: none,
        origins: [Local, Ssh, Relay],
    },
    /// Today's session read action `getWorkflowPack`.
    ConfigGetWorkflowPack => "config/getWorkflowPack" {
        params: ConfigGetWorkflowPackParams,
        result: JsonValue,
        scope: thread_or_shared_read(thread_id, "config"),
        class: C1,
        mutation: none,
        origins: [Local, Ssh, Relay],
    },
    /// Today's session read action `isSetupRequestActive`.
    ConfigIsSetupRequestActive => "config/isSetupRequestActive" {
        params: ConfigIsSetupRequestActiveParams,
        result: JsonValue,
        scope: thread_or_shared_read(thread_id, "config"),
        class: C1,
        mutation: none,
        origins: [Local, Ssh, Relay],
    },
    /// Today's session configure action `setAutoUpdate`.
    ConfigSetAutoUpdate => "config/setAutoUpdate" {
        params: ConfigSetAutoUpdateParams,
        result: JsonValue,
        scope: thread_or_global(thread_id, "config"),
        class: C2,
        mutation: op(Config),
        origins: [Local, Ssh, Relay],
    },
    /// Today's session configure action `setCacheWarmingEnabled`.
    ConfigSetCacheWarmingEnabled => "config/setCacheWarmingEnabled" {
        params: ConfigSetCacheWarmingEnabledParams,
        result: JsonValue,
        scope: thread_or_global(thread_id, "config"),
        class: C2,
        mutation: op(Config),
        origins: [Local, Ssh, Relay],
    },
    /// Today's session configure action `setRecapEnabled`.
    ConfigSetRecapEnabled => "config/setRecapEnabled" {
        params: ConfigSetRecapEnabledParams,
        result: JsonValue,
        scope: thread_or_global(thread_id, "config"),
        class: C2,
        mutation: op(Config),
        origins: [Local, Ssh, Relay],
    },
    /// Today's session configure action `setAiSessionTitles`.
    ConfigSetAiSessionTitles => "config/setAiSessionTitles" {
        params: ConfigSetAiSessionTitlesParams,
        result: JsonValue,
        scope: thread_or_global(thread_id, "config"),
        class: C2,
        mutation: op(Config),
        origins: [Local, Ssh, Relay],
    },
    /// Today's session configure action `setHeartbeatEnabled`.
    ConfigSetHeartbeatEnabled => "config/setHeartbeatEnabled" {
        params: ConfigSetHeartbeatEnabledParams,
        result: JsonValue,
        scope: thread_or_global(thread_id, "config"),
        class: C2,
        mutation: op(Config),
        origins: [Local, Ssh, Relay],
    },
    /// Today's session configure action `setReactionsEnabled`.
    ConfigSetReactionsEnabled => "config/setReactionsEnabled" {
        params: ConfigSetReactionsEnabledParams,
        result: JsonValue,
        scope: thread_or_global(thread_id, "config"),
        class: C2,
        mutation: op(Config),
        origins: [Local, Ssh, Relay],
    },
    /// Today's session configure action `setWebSearchEnabled`.
    ConfigSetWebSearchEnabled => "config/setWebSearchEnabled" {
        params: ConfigSetWebSearchEnabledParams,
        result: JsonValue,
        scope: thread_or_global(thread_id, "config"),
        class: C2,
        mutation: op(Config),
        origins: [Local, Ssh, Relay],
    },
    /// Today's session configure action `setMemoryToolsEnabled`.
    ConfigSetMemoryToolsEnabled => "config/setMemoryToolsEnabled" {
        params: ConfigSetMemoryToolsEnabledParams,
        result: JsonValue,
        scope: thread_or_global(thread_id, "config"),
        class: C2,
        mutation: op(Config),
        origins: [Local, Ssh, Relay],
    },
    /// Today's session configure action `setAutoClear`.
    ConfigSetAutoClear => "config/setAutoClear" {
        params: ConfigSetAutoClearParams,
        result: JsonValue,
        scope: thread_or_global(thread_id, "config"),
        class: C2,
        mutation: op(Config),
        origins: [Local, Ssh, Relay],
    },
    /// Today's session configure action `setCompactionSettings`.
    ConfigSetCompactionSettings => "config/setCompactionSettings" {
        params: ConfigSetCompactionSettingsParams,
        result: JsonValue,
        scope: thread_or_global(thread_id, "config"),
        class: C2,
        mutation: op(Config),
        origins: [Local, Ssh, Relay],
    },
    /// Today's session configure action `setDeveloperOption`.
    ConfigSetDeveloperOption => "config/setDeveloperOption" {
        params: ConfigSetDeveloperOptionParams,
        result: JsonValue,
        scope: thread_or_global(thread_id, "config"),
        class: C2,
        mutation: op(Config),
        origins: [Local, Ssh, Relay],
    },
    /// Today's session configure action `setProfile`.
    ConfigSetProfile => "config/setProfile" {
        params: ConfigSetProfileParams,
        result: JsonValue,
        scope: thread_or_global(thread_id, "config"),
        class: C2,
        mutation: op(Config),
        origins: [Local, Ssh, Relay],
    },
    /// Today's session configure action `setHeartbeatInterval`.
    ConfigSetHeartbeatInterval => "config/setHeartbeatInterval" {
        params: ConfigSetHeartbeatIntervalParams,
        result: JsonValue,
        scope: thread_or_global(thread_id, "config"),
        class: C2,
        mutation: op(Config),
        origins: [Local, Ssh, Relay],
    },
    /// Today's session configure action `setSystemShell`.
    ConfigSetSystemShell => "config/setSystemShell" {
        params: ConfigSetSystemShellParams,
        result: JsonValue,
        scope: thread_or_global(thread_id, "config"),
        class: C2,
        mutation: op(Config),
        origins: [Local, Ssh, Relay],
    },
    /// Today's session configure action `setTheme`.
    ConfigSetTheme => "config/setTheme" {
        params: ConfigSetThemeParams,
        result: JsonValue,
        scope: thread_or_global(thread_id, "config"),
        class: C2,
        mutation: op(Config),
        origins: [Local, Ssh, Relay],
    },
    /// Today's session configure action `setWebSearchRoute`.
    ConfigSetWebSearchRoute => "config/setWebSearchRoute" {
        params: ConfigSetWebSearchRouteParams,
        result: JsonValue,
        scope: thread_or_global(thread_id, "config"),
        class: C2,
        mutation: op(Config),
        origins: [Local, Ssh, Relay],
    },
    /// Today's session configure action `setAutoEffortBase`.
    ConfigSetAutoEffortBase => "config/setAutoEffortBase" {
        params: ConfigSetAutoEffortBaseParams,
        result: JsonValue,
        scope: thread_or_global(thread_id, "config"),
        class: C2,
        mutation: op(Config),
        origins: [Local, Ssh, Relay],
    },
    /// Today's session configure action `setBuiltinToolEnabled`.
    ConfigSetBuiltinToolEnabled => "config/setBuiltinToolEnabled" {
        params: ConfigSetBuiltinToolEnabledParams,
        result: JsonValue,
        scope: thread_or_global(thread_id, "config"),
        class: C2,
        mutation: op(Config),
        origins: [Local, Ssh, Relay],
    },
    /// Today's session configure action `installBuiltinFeature`.
    ConfigInstallBuiltinFeature => "config/installBuiltinFeature" {
        params: ConfigInstallBuiltinFeatureParams,
        result: JsonValue,
        scope: thread_or_global(thread_id, "config"),
        class: C2,
        mutation: op(Config),
        origins: [Local, Ssh, Relay],
    },
    /// Today's session configure action `setWorktreeSettings`.
    ConfigSetWorktreeSettings => "config/setWorktreeSettings" {
        params: ConfigSetWorktreeSettingsParams,
        result: JsonValue,
        scope: thread_or_global(thread_id, "config"),
        class: C2,
        mutation: op(Config),
        origins: [Local, Ssh, Relay],
    },
    /// Today's session configure action `setNetworkProxy`.
    ConfigSetNetworkProxy => "config/setNetworkProxy" {
        params: ConfigSetNetworkProxyParams,
        result: JsonValue,
        scope: thread_or_global(thread_id, "config"),
        class: C2,
        mutation: op(Config),
        origins: [Local, Ssh, Relay],
    },
    /// Today's session configure action `saveWorkflowPack`.
    ConfigSaveWorkflowPack => "config/saveWorkflowPack" {
        params: ConfigSaveWorkflowPackParams,
        result: JsonValue,
        scope: thread_or_global(thread_id, "config"),
        class: C2,
        mutation: op(Config),
        origins: [Local, Ssh, Relay],
    },
    /// Today's session configure action `createWorkflow`.
    ConfigCreateWorkflow => "config/createWorkflow" {
        params: ConfigCreateWorkflowParams,
        result: JsonValue,
        scope: thread_or_global(thread_id, "config"),
        class: C2,
        mutation: op(Config),
        origins: [Local, Ssh, Relay],
    },
    /// Today's session configure action `deleteWorkflow`.
    ConfigDeleteWorkflow => "config/deleteWorkflow" {
        params: ConfigDeleteWorkflowParams,
        result: JsonValue,
        scope: thread_or_global(thread_id, "config"),
        class: C2,
        mutation: op(Config),
        origins: [Local, Ssh, Relay],
    },
    /// Today's session configure action `setModelPreferences`.
    ConfigSetModelPreferences => "config/setModelPreferences" {
        params: ConfigSetModelPreferencesParams,
        result: JsonValue,
        scope: thread_or_global(thread_id, "config"),
        class: C2,
        mutation: op(Config),
        origins: [Local, Ssh, Relay],
    },
    /// Today's session configure action `skipOnboarding`.
    ConfigSkipOnboarding => "config/skipOnboarding" {
        params: ConfigSkipOnboardingParams,
        result: JsonValue,
        scope: thread_or_global(thread_id, "config"),
        class: C2,
        mutation: op(Config),
        origins: [Local, Ssh, Relay],
    },
    /// Today's session configure action `completeOnboarding`.
    ConfigCompleteOnboarding => "config/completeOnboarding" {
        params: ConfigCompleteOnboardingParams,
        result: JsonValue,
        scope: thread_or_global(thread_id, "config"),
        class: C2,
        mutation: op(Config),
        origins: [Local, Ssh, Relay],
    },
    /// Today's session configure action `saveStarterGuideState`.
    ConfigSaveStarterGuideState => "config/saveStarterGuideState" {
        params: ConfigSaveStarterGuideStateParams,
        result: JsonValue,
        scope: thread_or_global(thread_id, "config"),
        class: C2,
        mutation: op(Config),
        origins: [Local, Ssh, Relay],
    },
    /// Today's session configure action `claimSetupRequest`.
    ConfigClaimSetupRequest => "config/claimSetupRequest" {
        params: ConfigClaimSetupRequestParams,
        result: JsonValue,
        scope: thread_or_global(thread_id, "config"),
        class: C2,
        mutation: op(Config),
        origins: [Local, Ssh, Relay],
    },
    /// Today's session configure action `completeSetupRequest`.
    ConfigCompleteSetupRequest => "config/completeSetupRequest" {
        params: ConfigCompleteSetupRequestParams,
        result: JsonValue,
        scope: thread_or_global(thread_id, "config"),
        class: C2,
        mutation: op(Config),
        origins: [Local, Ssh, Relay],
    },
    /// Today's session configure action `setExtensionScope`.
    ConfigSetExtensionScope => "config/setExtensionScope" {
        params: ConfigSetExtensionScopeParams,
        result: JsonValue,
        scope: thread_or_global(thread_id, "config"),
        class: C2,
        mutation: op(Config),
        origins: [Local, Ssh, Relay],
    },
    /// Raw config read (non-subscribed tools).
    ConfigRead => "config/read" {
        params: v2::config::ConfigReadParams,
        result: v2::config::ConfigReadResponse,
        scope: shared_read("config"),
        class: C1,
        mutation: none,
        origins: [Local, Ssh],
    },
    /// One typed key write.
    ConfigValueWrite => "config/value/write" {
        params: v2::config::ConfigValueWriteParams,
        result: v2::config::ConfigWriteResponse,
        scope: global("config"),
        class: C2,
        mutation: op(Config),
        origins: [Local, Ssh, Relay],
    },
    /// Several key writes in one transaction.
    ConfigBatchWrite => "config/batchWrite" {
        params: v2::config::ConfigBatchWriteParams,
        result: v2::config::ConfigWriteResponse,
        scope: global("config"),
        class: C2,
        mutation: op(Config),
        origins: [Local, Ssh],
    },
    /// Today's session read action `getChannelSettings`.
    ChannelGetChannelSettings => "channel/getChannelSettings" {
        params: ChannelGetChannelSettingsParams,
        result: JsonValue,
        scope: none,
        class: C1,
        mutation: none,
        origins: [Local, Ssh],
    },
    /// Today's session read action `getChannelSetup`.
    ChannelGetChannelSetup => "channel/getChannelSetup" {
        params: ChannelGetChannelSetupParams,
        result: JsonValue,
        scope: none,
        class: C1,
        mutation: none,
        origins: [Local, Ssh, Relay],
    },
    /// Today's session read action `getChannelWorkerStatus`.
    ChannelGetChannelWorkerStatus => "channel/getChannelWorkerStatus" {
        params: ChannelGetChannelWorkerStatusParams,
        result: JsonValue,
        scope: none,
        class: C1,
        mutation: none,
        origins: [Local, Ssh],
    },
    /// Today's session configure action `setWebhookConfig`.
    ChannelSetWebhookConfig => "channel/setWebhookConfig" {
        params: ChannelSetWebhookConfigParams,
        result: JsonValue,
        scope: thread_or_none(thread_id),
        class: C2,
        mutation: op(Channel),
        origins: [Local, Ssh, Relay],
    },
    /// Today's session configure action `saveSchedule`.
    ChannelSaveSchedule => "channel/saveSchedule" {
        params: ChannelSaveScheduleParams,
        result: JsonValue,
        scope: thread_or_none(thread_id),
        class: C2,
        mutation: op(Channel),
        origins: [Local, Ssh, Relay],
    },
    /// Today's session configure action `deleteSchedule`.
    ChannelDeleteSchedule => "channel/deleteSchedule" {
        params: ChannelDeleteScheduleParams,
        result: JsonValue,
        scope: thread_or_none(thread_id),
        class: C2,
        mutation: op(Channel),
        origins: [Local, Ssh, Relay],
    },
    /// Today's session configure action `setScheduleEnabled`.
    ChannelSetScheduleEnabled => "channel/setScheduleEnabled" {
        params: ChannelSetScheduleEnabledParams,
        result: JsonValue,
        scope: thread_or_none(thread_id),
        class: C2,
        mutation: op(Channel),
        origins: [Local, Ssh, Relay],
    },
    /// Today's session configure action `runScheduleNow`.
    ChannelRunScheduleNow => "channel/runScheduleNow" {
        params: ChannelRunScheduleNowParams,
        result: JsonValue,
        scope: thread_or_none(thread_id),
        class: C2,
        mutation: op(Channel),
        origins: [Local, Ssh, Relay],
    },
    /// Today's session configure action `runWebhookNow`.
    ChannelRunWebhookNow => "channel/runWebhookNow" {
        params: ChannelRunWebhookNowParams,
        result: JsonValue,
        scope: thread_or_none(thread_id),
        class: C2,
        mutation: op(Channel),
        origins: [Local, Ssh, Relay],
    },
    /// Today's session configure action `retryRoutineDelivery`.
    ChannelRetryRoutineDelivery => "channel/retryRoutineDelivery" {
        params: ChannelRetryRoutineDeliveryParams,
        result: JsonValue,
        scope: thread_or_none(thread_id),
        class: C2,
        mutation: op(Channel),
        origins: [Local, Ssh, Relay],
    },
    /// Today's session configure action `testWebhook`.
    ChannelTestWebhook => "channel/testWebhook" {
        params: ChannelTestWebhookParams,
        result: JsonValue,
        scope: thread_or_none(thread_id),
        class: C2,
        mutation: op(Channel),
        origins: [Local, Ssh, Relay],
    },
    /// Today's session configure action `saveWebhook`.
    ChannelSaveWebhook => "channel/saveWebhook" {
        params: ChannelSaveWebhookParams,
        result: JsonValue,
        scope: thread_or_none(thread_id),
        class: C2,
        mutation: op(Channel),
        origins: [Local, Ssh, Relay],
    },
    /// Today's session configure action `deleteWebhook`.
    ChannelDeleteWebhook => "channel/deleteWebhook" {
        params: ChannelDeleteWebhookParams,
        result: JsonValue,
        scope: thread_or_none(thread_id),
        class: C2,
        mutation: op(Channel),
        origins: [Local, Ssh, Relay],
    },
    /// Today's session configure action `setWebhookEnabled`.
    ChannelSetWebhookEnabled => "channel/setWebhookEnabled" {
        params: ChannelSetWebhookEnabledParams,
        result: JsonValue,
        scope: thread_or_none(thread_id),
        class: C2,
        mutation: op(Channel),
        origins: [Local, Ssh, Relay],
    },
    /// Today's session read action `getConversationImportJobs`.
    ImportGetConversationImportJobs => "import/getConversationImportJobs" {
        params: ImportGetConversationImportJobsParams,
        result: JsonValue,
        scope: none,
        class: C1,
        mutation: none,
        origins: [Local, Ssh],
    },
    /// Today's session read action `listImportableConversations`.
    ImportListImportableConversations => "import/listImportableConversations" {
        params: ImportListImportableConversationsParams,
        result: JsonValue,
        scope: none,
        class: C1,
        mutation: none,
        origins: [Local, Ssh],
    },
    /// Today's session configure action `startConversationImport`.
    ImportStartConversationImport => "import/startConversationImport" {
        params: ImportStartConversationImportParams,
        result: JsonValue,
        scope: thread_or_none(thread_id),
        class: C2,
        mutation: op(Import),
        origins: [Local, Ssh],
    },
    /// Today's session configure action `cancelConversationImport`.
    ImportCancelConversationImport => "import/cancelConversationImport" {
        params: ImportCancelConversationImportParams,
        result: JsonValue,
        scope: thread_or_none(thread_id),
        class: C2,
        mutation: op(Import),
        origins: [Local, Ssh],
    },
    /// Today's session configure action `registerConversationImportFile`.
    ImportRegisterConversationImportFile => "import/registerConversationImportFile" {
        params: ImportRegisterConversationImportFileParams,
        result: JsonValue,
        scope: thread_or_none(thread_id),
        class: C2,
        mutation: op(Import),
        origins: [Local, Ssh],
    },
    /// Today's session read action `getMediaDefault`.
    MediaGetMediaDefault => "media/getMediaDefault" {
        params: MediaGetMediaDefaultParams,
        result: JsonValue,
        scope: none,
        class: C1,
        mutation: none,
        origins: [Local, Ssh, Relay],
    },
    /// Today's session read action `getMediaJob`.
    MediaGetMediaJob => "media/getMediaJob" {
        params: MediaGetMediaJobParams,
        result: JsonValue,
        scope: none,
        class: C1,
        mutation: none,
        origins: [Local, Ssh, Relay],
    },
    /// Today's session read action `getMediaPins`.
    MediaGetMediaPins => "media/getMediaPins" {
        params: MediaGetMediaPinsParams,
        result: JsonValue,
        scope: none,
        class: C1,
        mutation: none,
        origins: [Local, Ssh, Relay],
    },
    /// Today's session read action `listMediaAssets`.
    MediaListMediaAssets => "media/listMediaAssets" {
        params: MediaListMediaAssetsParams,
        result: JsonValue,
        scope: none,
        class: C1,
        mutation: none,
        origins: [Local, Ssh, Relay],
    },
    /// Today's session read action `listMediaBoards`.
    MediaListMediaBoards => "media/listMediaBoards" {
        params: MediaListMediaBoardsParams,
        result: JsonValue,
        scope: none,
        class: C1,
        mutation: none,
        origins: [Local, Ssh, Relay],
    },
    /// Today's session read action `listMediaLanes`.
    MediaListMediaLanes => "media/listMediaLanes" {
        params: MediaListMediaLanesParams,
        result: JsonValue,
        scope: none,
        class: C1,
        mutation: none,
        origins: [Local, Ssh, Relay],
    },
    /// Today's session read action `readMediaAsset`.
    MediaReadMediaAsset => "media/readMediaAsset" {
        params: MediaReadMediaAssetParams,
        result: JsonValue,
        scope: none,
        class: C1,
        mutation: none,
        origins: [Local, Ssh, Relay],
    },
    /// Today's session read action `resolveMediaFile`.
    MediaResolveMediaFile => "media/resolveMediaFile" {
        params: MediaResolveMediaFileParams,
        result: JsonValue,
        scope: none,
        class: C1,
        mutation: none,
        origins: [Local, Ssh],
    },
    /// Today's session configure action `startMediaJob`.
    MediaStartMediaJob => "media/startMediaJob" {
        params: MediaStartMediaJobParams,
        result: JsonValue,
        scope: thread_or_none(thread_id),
        class: C2,
        mutation: op(Media),
        origins: [Local, Ssh, Relay],
    },
    /// Today's session configure action `cancelMediaJob`.
    MediaCancelMediaJob => "media/cancelMediaJob" {
        params: MediaCancelMediaJobParams,
        result: JsonValue,
        scope: thread_or_none(thread_id),
        class: C2,
        mutation: op(Media),
        origins: [Local, Ssh, Relay],
    },
    /// Today's session configure action `deleteMediaAsset`.
    MediaDeleteMediaAsset => "media/deleteMediaAsset" {
        params: MediaDeleteMediaAssetParams,
        result: JsonValue,
        scope: thread_or_none(thread_id),
        class: C2,
        mutation: op(Media),
        origins: [Local, Ssh, Relay],
    },
    /// Today's session configure action `deleteMediaAssets`.
    MediaDeleteMediaAssets => "media/deleteMediaAssets" {
        params: MediaDeleteMediaAssetsParams,
        result: JsonValue,
        scope: thread_or_none(thread_id),
        class: C2,
        mutation: op(Media),
        origins: [Local, Ssh, Relay],
    },
    /// Today's session configure action `createMediaBoard`.
    MediaCreateMediaBoard => "media/createMediaBoard" {
        params: MediaCreateMediaBoardParams,
        result: JsonValue,
        scope: thread_or_none(thread_id),
        class: C2,
        mutation: op(Media),
        origins: [Local, Ssh, Relay],
    },
    /// Today's session configure action `renameMediaBoard`.
    MediaRenameMediaBoard => "media/renameMediaBoard" {
        params: MediaRenameMediaBoardParams,
        result: JsonValue,
        scope: thread_or_none(thread_id),
        class: C2,
        mutation: op(Media),
        origins: [Local, Ssh, Relay],
    },
    /// Today's session configure action `deleteMediaBoard`.
    MediaDeleteMediaBoard => "media/deleteMediaBoard" {
        params: MediaDeleteMediaBoardParams,
        result: JsonValue,
        scope: thread_or_none(thread_id),
        class: C2,
        mutation: op(Media),
        origins: [Local, Ssh, Relay],
    },
    /// Today's session configure action `setMediaAssetBoard`.
    MediaSetMediaAssetBoard => "media/setMediaAssetBoard" {
        params: MediaSetMediaAssetBoardParams,
        result: JsonValue,
        scope: thread_or_none(thread_id),
        class: C2,
        mutation: op(Media),
        origins: [Local, Ssh, Relay],
    },
    /// Today's session configure action `setMediaDefault`.
    MediaSetMediaDefault => "media/setMediaDefault" {
        params: MediaSetMediaDefaultParams,
        result: JsonValue,
        scope: thread_or_none(thread_id),
        class: C2,
        mutation: op(Media),
        origins: [Local, Ssh, Relay],
    },
    /// Today's session configure action `setMediaPin`.
    MediaSetMediaPin => "media/setMediaPin" {
        params: MediaSetMediaPinParams,
        result: JsonValue,
        scope: thread_or_none(thread_id),
        class: C2,
        mutation: op(Media),
        origins: [Local, Ssh, Relay],
    },
    /// Today's session configure action `cacheMediaThumbnail`.
    MediaCacheMediaThumbnail => "media/cacheMediaThumbnail" {
        params: MediaCacheMediaThumbnailParams,
        result: JsonValue,
        scope: thread_or_none(thread_id),
        class: C2,
        mutation: op(Media),
        origins: [Local, Ssh, Relay],
    },
    /// Today's session configure action `openMediaAsset`.
    MediaOpenMediaAsset => "media/openMediaAsset" {
        params: MediaOpenMediaAssetParams,
        result: JsonValue,
        scope: thread_or_none(thread_id),
        class: C2,
        mutation: op(Media),
        origins: [Local, Ssh, Relay],
    },
    /// Today's session configure action `openMediaFolder`.
    MediaOpenMediaFolder => "media/openMediaFolder" {
        params: MediaOpenMediaFolderParams,
        result: JsonValue,
        scope: thread_or_none(thread_id),
        class: C2,
        mutation: op(Media),
        origins: [Local, Ssh, Relay],
    },
    /// Today's session read action `getMcpServerConfig`.
    McpGetMcpServerConfig => "mcp/getMcpServerConfig" {
        params: McpGetMcpServerConfigParams,
        result: JsonValue,
        scope: none,
        class: C1,
        mutation: none,
        origins: [Local, Ssh, Relay],
    },
    /// Today's session read action `getMcpOAuthLoginStatus`.
    McpGetMcpOAuthLoginStatus => "mcp/getMcpOAuthLoginStatus" {
        params: McpGetMcpOAuthLoginStatusParams,
        result: JsonValue,
        scope: none,
        class: C1,
        mutation: none,
        origins: [Local, Ssh, Relay],
    },
    /// Today's session read action `mcpStatus`.
    McpMcpStatus => "mcp/mcpStatus" {
        params: McpMcpStatusParams,
        result: JsonValue,
        scope: none,
        class: C1,
        mutation: none,
        origins: [Local, Ssh, Relay],
    },
    /// Today's session configure action `addMcpServer`.
    McpAddMcpServer => "mcp/addMcpServer" {
        params: McpAddMcpServerParams,
        result: JsonValue,
        scope: thread_or_none(thread_id),
        class: C2,
        mutation: op(Mcp),
        origins: [Local, Ssh, Relay],
    },
    /// Today's session configure action `saveMcpServer`.
    McpSaveMcpServer => "mcp/saveMcpServer" {
        params: McpSaveMcpServerParams,
        result: JsonValue,
        scope: thread_or_none(thread_id),
        class: C2,
        mutation: op(Mcp),
        origins: [Local, Ssh, Relay],
    },
    /// Today's session configure action `removeMcpServer`.
    McpRemoveMcpServer => "mcp/removeMcpServer" {
        params: McpRemoveMcpServerParams,
        result: JsonValue,
        scope: thread_or_none(thread_id),
        class: C2,
        mutation: op(Mcp),
        origins: [Local, Ssh, Relay],
    },
    /// Today's session configure action `setMcpServerEnabled`.
    McpSetMcpServerEnabled => "mcp/setMcpServerEnabled" {
        params: McpSetMcpServerEnabledParams,
        result: JsonValue,
        scope: thread_or_none(thread_id),
        class: C2,
        mutation: op(Mcp),
        origins: [Local, Ssh, Relay],
    },
    /// Today's session configure action `reconnectMcp`.
    McpReconnectMcp => "mcp/reconnectMcp" {
        params: McpReconnectMcpParams,
        result: JsonValue,
        scope: thread_or_none(thread_id),
        class: C2,
        mutation: op(Mcp),
        origins: [Local, Ssh, Relay],
    },
    /// Today's session configure action `beginMcpOAuthLogin`.
    McpBeginMcpOAuthLogin => "mcp/beginMcpOAuthLogin" {
        params: McpBeginMcpOAuthLoginParams,
        result: JsonValue,
        scope: thread_or_none(thread_id),
        class: C2,
        mutation: op(Mcp),
        origins: [Local, Ssh, Relay],
    },
    /// Today's session configure action `cancelMcpOAuthLogin`.
    McpCancelMcpOAuthLogin => "mcp/cancelMcpOAuthLogin" {
        params: McpCancelMcpOAuthLoginParams,
        result: JsonValue,
        scope: thread_or_none(thread_id),
        class: C2,
        mutation: op(Mcp),
        origins: [Local, Ssh, Relay],
    },
    /// Today's session configure action `completeMcpOAuthLogin`.
    McpCompleteMcpOAuthLogin => "mcp/completeMcpOAuthLogin" {
        params: McpCompleteMcpOAuthLoginParams,
        result: JsonValue,
        scope: thread_or_none(thread_id),
        class: C2,
        mutation: op(Mcp),
        origins: [Local, Ssh, Relay],
    },
    /// Today's session configure action `signOutMcpServer`.
    McpSignOutMcpServer => "mcp/signOutMcpServer" {
        params: McpSignOutMcpServerParams,
        result: JsonValue,
        scope: thread_or_none(thread_id),
        class: C2,
        mutation: op(Mcp),
        origins: [Local, Ssh, Relay],
    },
    /// Today's session configure action `probeMcpServerAuth`.
    McpProbeMcpServerAuth => "mcp/probeMcpServerAuth" {
        params: McpProbeMcpServerAuthParams,
        result: JsonValue,
        scope: thread_or_none(thread_id),
        class: C2,
        mutation: op(Mcp),
        origins: [Local, Ssh, Relay],
    },
    /// Today's session configure action `enablePluginMcp`.
    McpEnablePluginMcp => "mcp/enablePluginMcp" {
        params: McpEnablePluginMcpParams,
        result: JsonValue,
        scope: thread_or_none(thread_id),
        class: C2,
        mutation: op(Mcp),
        origins: [Local, Ssh, Relay],
    },
    /// Today's session read action `getOAuthProviderLoginStatus`.
    AccountGetOAuthProviderLoginStatus => "account/getOAuthProviderLoginStatus" {
        params: AccountGetOAuthProviderLoginStatusParams,
        result: JsonValue,
        scope: none,
        class: C1,
        mutation: none,
        origins: [Local, Ssh, Relay],
    },
    /// Today's session read action `listWebSearchModels`.
    AccountListWebSearchModels => "account/listWebSearchModels" {
        params: AccountListWebSearchModelsParams,
        result: JsonValue,
        scope: none,
        class: C1,
        mutation: none,
        origins: [Local, Ssh, Relay],
    },
    /// Today's session read action `getQuotaHistory`.
    AccountGetQuotaHistory => "account/getQuotaHistory" {
        params: AccountGetQuotaHistoryParams,
        result: JsonValue,
        scope: none,
        class: C1,
        mutation: none,
        origins: [Local, Ssh, Relay],
    },
    /// Today's session configure action `authenticateProvider`.
    AccountAuthenticateProvider => "account/authenticateProvider" {
        params: AccountAuthenticateProviderParams,
        result: JsonValue,
        scope: thread_or_none(thread_id),
        class: C2,
        mutation: op(Account),
        origins: [Local, Ssh, Relay],
    },
    /// Today's session configure action `beginOAuthProviderLogin`.
    AccountBeginOAuthProviderLogin => "account/beginOAuthProviderLogin" {
        params: AccountBeginOAuthProviderLoginParams,
        result: JsonValue,
        scope: thread_or_none(thread_id),
        class: C2,
        mutation: op(Account),
        origins: [Local, Ssh, Relay],
    },
    /// Today's session configure action `completeOAuthProviderLogin`.
    AccountCompleteOAuthProviderLogin => "account/completeOAuthProviderLogin" {
        params: AccountCompleteOAuthProviderLoginParams,
        result: JsonValue,
        scope: thread_or_none(thread_id),
        class: C2,
        mutation: op(Account),
        origins: [Local, Ssh, Relay],
    },
    /// Today's session configure action `cancelOAuthProviderLogin`.
    AccountCancelOAuthProviderLogin => "account/cancelOAuthProviderLogin" {
        params: AccountCancelOAuthProviderLoginParams,
        result: JsonValue,
        scope: thread_or_none(thread_id),
        class: C2,
        mutation: op(Account),
        origins: [Local, Ssh, Relay],
    },
    /// Today's session configure action `loginOAuthProvider`.
    AccountLoginOAuthProvider => "account/loginOAuthProvider" {
        params: AccountLoginOAuthProviderParams,
        result: JsonValue,
        scope: thread_or_none(thread_id),
        class: C2,
        mutation: op(Account),
        origins: [Local, Ssh, Relay],
    },
    /// Today's session configure action `forgetProviderAuth`.
    AccountForgetProviderAuth => "account/forgetProviderAuth" {
        params: AccountForgetProviderAuthParams,
        result: JsonValue,
        scope: thread_or_none(thread_id),
        class: C2,
        mutation: op(Account),
        origins: [Local, Ssh, Relay],
    },
    /// Today's session configure action `updateProviderAccounts`.
    AccountUpdateProviderAccounts => "account/updateProviderAccounts" {
        params: AccountUpdateProviderAccountsParams,
        result: JsonValue,
        scope: thread_or_none(thread_id),
        class: C2,
        mutation: op(Account),
        origins: [Local, Ssh, Relay],
    },
    /// Today's session configure action `saveProviderApiKey`.
    AccountSaveProviderApiKey => "account/saveProviderApiKey" {
        params: AccountSaveProviderApiKeyParams,
        result: JsonValue,
        scope: thread_or_none(thread_id),
        class: C2,
        mutation: op(Account),
        origins: [Local, Ssh, Relay],
    },
    /// Today's session configure action `saveCustomProvider`.
    AccountSaveCustomProvider => "account/saveCustomProvider" {
        params: AccountSaveCustomProviderParams,
        result: JsonValue,
        scope: thread_or_none(thread_id),
        class: C2,
        mutation: op(Account),
        origins: [Local, Ssh, Relay],
    },
    /// Today's session configure action `saveCustomProviderKey`.
    AccountSaveCustomProviderKey => "account/saveCustomProviderKey" {
        params: AccountSaveCustomProviderKeyParams,
        result: JsonValue,
        scope: thread_or_none(thread_id),
        class: C2,
        mutation: op(Account),
        origins: [Local, Ssh, Relay],
    },
    /// Today's session configure action `removeCustomProvider`.
    AccountRemoveCustomProvider => "account/removeCustomProvider" {
        params: AccountRemoveCustomProviderParams,
        result: JsonValue,
        scope: thread_or_none(thread_id),
        class: C2,
        mutation: op(Account),
        origins: [Local, Ssh, Relay],
    },
    /// Today's session configure action `updateCustomProviderModel`.
    AccountUpdateCustomProviderModel => "account/updateCustomProviderModel" {
        params: AccountUpdateCustomProviderModelParams,
        result: JsonValue,
        scope: thread_or_none(thread_id),
        class: C2,
        mutation: op(Account),
        origins: [Local, Ssh, Relay],
    },
    /// Today's session configure action `testCustomProvider`.
    AccountTestCustomProvider => "account/testCustomProvider" {
        params: AccountTestCustomProviderParams,
        result: JsonValue,
        scope: thread_or_none(thread_id),
        class: C2,
        mutation: op(Account),
        origins: [Local, Ssh, Relay],
    },
    /// Today's session configure action `checkCustomProviderKeyEnv`.
    AccountCheckCustomProviderKeyEnv => "account/checkCustomProviderKeyEnv" {
        params: AccountCheckCustomProviderKeyEnvParams,
        result: JsonValue,
        scope: thread_or_none(thread_id),
        class: C2,
        mutation: op(Account),
        origins: [Local, Ssh, Relay],
    },
    /// Today's session configure action `discoverCustomProviderModels`.
    AccountDiscoverCustomProviderModels => "account/discoverCustomProviderModels" {
        params: AccountDiscoverCustomProviderModelsParams,
        result: JsonValue,
        scope: thread_or_none(thread_id),
        class: C2,
        mutation: op(Account),
        origins: [Local, Ssh, Relay],
    },
    /// Today's session configure action `saveOpenAIUsageSessionKey`.
    AccountSaveOpenAIUsageSessionKey => "account/saveOpenAIUsageSessionKey" {
        params: AccountSaveOpenAIUsageSessionKeyParams,
        result: JsonValue,
        scope: thread_or_none(thread_id),
        class: C2,
        mutation: op(Account),
        origins: [Local, Ssh, Relay],
    },
    /// Today's session configure action `consumeCodexRateLimitResetCredit`.
    AccountConsumeCodexRateLimitResetCredit => "account/consumeCodexRateLimitResetCredit" {
        params: AccountConsumeCodexRateLimitResetCreditParams,
        result: JsonValue,
        scope: thread_or_none(thread_id),
        class: C2,
        mutation: op(Account),
        origins: [Local, Ssh, Relay],
    },
    /// Recompute section `providerSetup` (today's `getProviderSetup` options); the section carries the result.
    AccountRefreshProviderSetup => "account/refreshProviderSetup" {
        params: AccountRefreshProviderSetupParams,
        result: v2::feed::EmptyResult,
        scope: none,
        class: C2,
        mutation: op(Account),
        origins: [Local, Ssh, Relay],
    },
    /// Today's session read action `searchLocalProviderModels`.
    LocalProviderSearchLocalProviderModels => "localProvider/searchLocalProviderModels" {
        params: LocalProviderSearchLocalProviderModelsParams,
        result: JsonValue,
        scope: none,
        class: C1,
        mutation: none,
        origins: [Local, Ssh],
    },
    /// Today's session read action `inspectHuggingFaceModel`.
    LocalProviderInspectHuggingFaceModel => "localProvider/inspectHuggingFaceModel" {
        params: LocalProviderInspectHuggingFaceModelParams,
        result: JsonValue,
        scope: none,
        class: C1,
        mutation: none,
        origins: [Local, Ssh],
    },
    /// Today's session read action `getLocalProviderModelDetails`.
    LocalProviderGetLocalProviderModelDetails => "localProvider/getLocalProviderModelDetails" {
        params: LocalProviderGetLocalProviderModelDetailsParams,
        result: JsonValue,
        scope: none,
        class: C1,
        mutation: none,
        origins: [Local, Ssh, Relay],
    },
    /// Today's session configure action `installLocalProviderModel`.
    LocalProviderInstallLocalProviderModel => "localProvider/installLocalProviderModel" {
        params: LocalProviderInstallLocalProviderModelParams,
        result: JsonValue,
        scope: thread_or_none(thread_id),
        class: C2,
        mutation: op(LocalProvider),
        origins: [Local, Ssh, Relay],
    },
    /// Today's session configure action `startLocalProviderInstallation`.
    LocalProviderStartLocalProviderInstallation => "localProvider/startLocalProviderInstallation" {
        params: LocalProviderStartLocalProviderInstallationParams,
        result: JsonValue,
        scope: thread_or_none(thread_id),
        class: C2,
        mutation: op(LocalProvider),
        origins: [Local, Ssh, Relay],
    },
    /// Today's session configure action `cancelLocalProviderInstallation`.
    LocalProviderCancelLocalProviderInstallation => "localProvider/cancelLocalProviderInstallation" {
        params: LocalProviderCancelLocalProviderInstallationParams,
        result: JsonValue,
        scope: thread_or_none(thread_id),
        class: C2,
        mutation: op(LocalProvider),
        origins: [Local, Ssh, Relay],
    },
    /// Today's session configure action `discardLocalProviderInstallation`.
    LocalProviderDiscardLocalProviderInstallation => "localProvider/discardLocalProviderInstallation" {
        params: LocalProviderDiscardLocalProviderInstallationParams,
        result: JsonValue,
        scope: thread_or_none(thread_id),
        class: C2,
        mutation: op(LocalProvider),
        origins: [Local, Ssh, Relay],
    },
    /// Today's session configure action `setLocalProviderIdleTtl`.
    LocalProviderSetLocalProviderIdleTtl => "localProvider/setLocalProviderIdleTtl" {
        params: LocalProviderSetLocalProviderIdleTtlParams,
        result: JsonValue,
        scope: thread_or_none(thread_id),
        class: C2,
        mutation: op(LocalProvider),
        origins: [Local, Ssh, Relay],
    },
    /// Today's session configure action `setLocalProviderContext`.
    LocalProviderSetLocalProviderContext => "localProvider/setLocalProviderContext" {
        params: LocalProviderSetLocalProviderContextParams,
        result: JsonValue,
        scope: thread_or_none(thread_id),
        class: C2,
        mutation: op(LocalProvider),
        origins: [Local, Ssh, Relay],
    },
    /// Today's session configure action `registerHuggingFaceModel`.
    LocalProviderRegisterHuggingFaceModel => "localProvider/registerHuggingFaceModel" {
        params: LocalProviderRegisterHuggingFaceModelParams,
        result: JsonValue,
        scope: thread_or_none(thread_id),
        class: C2,
        mutation: op(LocalProvider),
        origins: [Local, Ssh],
    },
    /// Today's session configure action `startLocalProviderModelMaintenance`.
    LocalProviderStartLocalProviderModelMaintenance => "localProvider/startLocalProviderModelMaintenance" {
        params: LocalProviderStartLocalProviderModelMaintenanceParams,
        result: JsonValue,
        scope: thread_or_none(thread_id),
        class: C2,
        mutation: op(LocalProvider),
        origins: [Local, Ssh, Relay],
    },
    /// Today's session configure action `deleteLocalProviderModel`.
    LocalProviderDeleteLocalProviderModel => "localProvider/deleteLocalProviderModel" {
        params: LocalProviderDeleteLocalProviderModelParams,
        result: JsonValue,
        scope: thread_or_none(thread_id),
        class: C2,
        mutation: op(LocalProvider),
        origins: [Local, Ssh, Relay],
    },
    /// Today's session read action `getUsageDashboard`.
    UsageGetUsageDashboard => "usage/getUsageDashboard" {
        params: UsageGetUsageDashboardParams,
        result: JsonValue,
        scope: none,
        class: C1,
        mutation: none,
        origins: [Local, Ssh, Relay],
    },
    /// Today's session read action `getUsageStats`.
    UsageGetUsageStats => "usage/getUsageStats" {
        params: UsageGetUsageStatsParams,
        result: JsonValue,
        scope: none,
        class: C1,
        mutation: none,
        origins: [Local, Ssh, Relay],
    },
    /// Today's session read action `getUsageRequests`.
    UsageGetUsageRequests => "usage/getUsageRequests" {
        params: UsageGetUsageRequestsParams,
        result: JsonValue,
        scope: none,
        class: C1,
        mutation: none,
        origins: [Local, Ssh, Relay],
    },
    /// Today's session read action `getUpdateStatus`.
    UpdateGetUpdateStatus => "update/getUpdateStatus" {
        params: UpdateGetUpdateStatusParams,
        result: JsonValue,
        scope: none,
        class: C1,
        mutation: none,
        origins: [Local, Ssh, Relay],
    },
    /// Today's session configure action `checkForUpdate`.
    UpdateCheckForUpdate => "update/checkForUpdate" {
        params: UpdateCheckForUpdateParams,
        result: JsonValue,
        scope: thread_or_none(thread_id),
        class: C2,
        mutation: op(Update),
        origins: [Local, Ssh, Relay],
    },
    /// Today's session configure action `runUpdateNow`.
    UpdateRunUpdateNow => "update/runUpdateNow" {
        params: UpdateRunUpdateNowParams,
        result: JsonValue,
        scope: thread_or_none(thread_id),
        class: C2,
        mutation: op(Update),
        origins: [Local, Ssh, Relay],
    },
    /// Desktop updater check/install from any client; the core forwards `host/update/command`.
    UpdateDesktopCommand => "update/desktop/command" {
        params: v2::host::UpdateDesktopCommandParams,
        result: JsonValue,
        scope: global("update"),
        class: C2,
        mutation: op(Update),
        origins: [Local, Ssh, Relay],
    },
    /// Today's session read action `getVoiceStatus`.
    VoiceGetVoiceStatus => "voice/getVoiceStatus" {
        params: VoiceGetVoiceStatusParams,
        result: JsonValue,
        scope: none,
        class: C1,
        mutation: none,
        origins: [Local, Ssh, Relay],
    },
    /// Today's session configure action `toggleVoice`.
    VoiceToggleVoice => "voice/toggleVoice" {
        params: VoiceToggleVoiceParams,
        result: JsonValue,
        scope: thread_or_none(thread_id),
        class: C2,
        mutation: op(Voice),
        origins: [Local, Ssh, Relay],
    },
    /// Today's session configure action `transcribeAudio`.
    VoiceTranscribeAudio => "voice/transcribeAudio" {
        params: VoiceTranscribeAudioParams,
        result: JsonValue,
        scope: thread_or_global(thread_id, "voice"),
        class: C2,
        mutation: op(Voice),
        origins: [Local, Ssh, Relay],
    },
    /// Today's session configure action `prepareTranscription`.
    VoicePrepareTranscription => "voice/prepareTranscription" {
        params: VoicePrepareTranscriptionParams,
        result: JsonValue,
        scope: thread_or_none(thread_id),
        class: C2,
        mutation: op(Voice),
        origins: [Local, Ssh, Relay],
    },
    /// Today's session read action `getTidyEngineStatus`.
    TidyGetTidyEngineStatus => "tidy/getTidyEngineStatus" {
        params: TidyGetTidyEngineStatusParams,
        result: JsonValue,
        scope: none,
        class: C1,
        mutation: none,
        origins: [Local, Ssh, Relay],
    },
    /// Today's session read action `getTidyInstallStatus`.
    TidyGetTidyInstallStatus => "tidy/getTidyInstallStatus" {
        params: TidyGetTidyInstallStatusParams,
        result: JsonValue,
        scope: none,
        class: C1,
        mutation: none,
        origins: [Local, Ssh, Relay],
    },
    /// Today's session read action `skillsStatus`.
    SkillsSkillsStatus => "skills/skillsStatus" {
        params: SkillsSkillsStatusParams,
        result: JsonValue,
        scope: none,
        class: C1,
        mutation: none,
        origins: [Local, Ssh, Relay],
    },
    /// Today's session read action `skillContent`.
    SkillsSkillContent => "skills/skillContent" {
        params: SkillsSkillContentParams,
        result: JsonValue,
        scope: none,
        class: C1,
        mutation: none,
        origins: [Local, Ssh, Relay],
    },
    /// Today's session read action `getDisabledSkills`.
    SkillsGetDisabledSkills => "skills/getDisabledSkills" {
        params: SkillsGetDisabledSkillsParams,
        result: JsonValue,
        scope: none,
        class: C1,
        mutation: none,
        origins: [Local, Ssh, Relay],
    },
    /// Today's session configure action `addSkill`.
    SkillsAddSkill => "skills/addSkill" {
        params: SkillsAddSkillParams,
        result: JsonValue,
        scope: thread_or_none(thread_id),
        class: C2,
        mutation: op(Skills),
        origins: [Local, Ssh, Relay],
    },
    /// Today's session configure action `saveSkill`.
    SkillsSaveSkill => "skills/saveSkill" {
        params: SkillsSaveSkillParams,
        result: JsonValue,
        scope: thread_or_none(thread_id),
        class: C2,
        mutation: op(Skills),
        origins: [Local, Ssh, Relay],
    },
    /// Today's session configure action `removeSkill`.
    SkillsRemoveSkill => "skills/removeSkill" {
        params: SkillsRemoveSkillParams,
        result: JsonValue,
        scope: thread_or_none(thread_id),
        class: C2,
        mutation: op(Skills),
        origins: [Local, Ssh, Relay],
    },
    /// Today's session configure action `reloadSkills`.
    SkillsReloadSkills => "skills/reloadSkills" {
        params: SkillsReloadSkillsParams,
        result: JsonValue,
        scope: thread_or_none(thread_id),
        class: C2,
        mutation: op(Skills),
        origins: [Local, Ssh, Relay],
    },
    /// Today's session configure action `setDisabledSkills`.
    SkillsSetDisabledSkills => "skills/setDisabledSkills" {
        params: SkillsSetDisabledSkillsParams,
        result: JsonValue,
        scope: thread_or_none(thread_id),
        class: C2,
        mutation: op(Skills),
        origins: [Local, Ssh, Relay],
    },
    /// Today's session read action `pluginsStatus`.
    PluginsPluginsStatus => "plugins/pluginsStatus" {
        params: PluginsPluginsStatusParams,
        result: JsonValue,
        scope: none,
        class: C1,
        mutation: none,
        origins: [Local, Ssh, Relay],
    },
    /// Today's session configure action `addPlugin`.
    PluginsAddPlugin => "plugins/addPlugin" {
        params: PluginsAddPluginParams,
        result: JsonValue,
        scope: thread_or_none(thread_id),
        class: C2,
        mutation: op(Plugins),
        origins: [Local, Ssh, Relay],
    },
    /// Today's session configure action `updatePlugin`.
    PluginsUpdatePlugin => "plugins/updatePlugin" {
        params: PluginsUpdatePluginParams,
        result: JsonValue,
        scope: thread_or_none(thread_id),
        class: C2,
        mutation: op(Plugins),
        origins: [Local, Ssh, Relay],
    },
    /// Today's session configure action `setPluginEnabled`.
    PluginsSetPluginEnabled => "plugins/setPluginEnabled" {
        params: PluginsSetPluginEnabledParams,
        result: JsonValue,
        scope: thread_or_none(thread_id),
        class: C2,
        mutation: op(Plugins),
        origins: [Local, Ssh, Relay],
    },
    /// Today's session configure action `removePlugin`.
    PluginsRemovePlugin => "plugins/removePlugin" {
        params: PluginsRemovePluginParams,
        result: JsonValue,
        scope: thread_or_none(thread_id),
        class: C2,
        mutation: op(Plugins),
        origins: [Local, Ssh, Relay],
    },
    /// Today's session configure action `reloadPlugins`.
    PluginsReloadPlugins => "plugins/reloadPlugins" {
        params: PluginsReloadPluginsParams,
        result: JsonValue,
        scope: thread_or_none(thread_id),
        class: C2,
        mutation: op(Plugins),
        origins: [Local, Ssh, Relay],
    },
    /// Today's session read action `toolsStatus`.
    ToolsToolsStatus => "tools/toolsStatus" {
        params: ToolsToolsStatusParams,
        result: JsonValue,
        scope: none,
        class: C1,
        mutation: none,
        origins: [Local, Ssh, Relay],
    },
    /// Today's session configure action `memoryControl`.
    MemoryMemoryControl => "memory/memoryControl" {
        params: MemoryMemoryControlParams,
        result: JsonValue,
        scope: thread_or_none(thread_id),
        class: C2,
        mutation: op(Memory),
        origins: [Local, Ssh, Relay],
    },
    /// Today's session configure action `recall`.
    MemoryRecall => "memory/recall" {
        params: MemoryRecallParams,
        result: JsonValue,
        scope: thread_or_none(thread_id),
        class: C2,
        mutation: op(Memory),
        origins: [Local, Ssh, Relay],
    },
    /// Today's session configure action `runDoctor`.
    DiagnosticsRunDoctor => "diagnostics/runDoctor" {
        params: DiagnosticsRunDoctorParams,
        result: JsonValue,
        scope: thread_or_none(thread_id),
        class: C2,
        mutation: op(Diagnostics),
        origins: [Local, Ssh, Relay],
    },
    /// Registered projects; pager of section `projects`.
    ProjectList => "project/list" {
        params: ProjectListParams,
        result: JsonValue,
        scope: shared_read("project"),
        class: C1,
        mutation: none,
        origins: [Local, Ssh, Relay],
    },
    /// Today's `project.inspect`.
    ProjectRead => "project/read" {
        params: ProjectReadParams,
        result: JsonValue,
        scope: shared_read("project"),
        class: C1,
        mutation: none,
        origins: [Local, Ssh],
    },
    /// Register a project.
    ProjectCreate => "project/create" {
        params: ProjectCreateParams,
        result: JsonValue,
        scope: global("project"),
        class: C2,
        mutation: op(Project),
        origins: [Local, Ssh, Relay],
    },
    /// Mark used.
    ProjectTouch => "project/touch" {
        params: ProjectTouchParams,
        result: JsonValue,
        scope: global("project"),
        class: C2,
        mutation: op(Project),
        origins: [Local, Ssh, Relay],
    },
    /// Rename (alias).
    ProjectUpdate => "project/update" {
        params: ProjectUpdateParams,
        result: JsonValue,
        scope: global("project"),
        class: C2,
        mutation: op(Project),
        origins: [Local, Ssh, Relay],
    },
    /// Remove; drops watches, LSP and processes under it internally.
    ProjectDelete => "project/delete" {
        params: ProjectDeleteParams,
        result: JsonValue,
        scope: global("project"),
        class: C2,
        mutation: op(Project),
        origins: [Local, Ssh, Relay],
    },
    /// Create the folder when missing.
    ProjectEnsureDirectory => "project/ensureDirectory" {
        params: ProjectEnsureDirectoryParams,
        result: JsonValue,
        scope: global("project"),
        class: C2,
        mutation: op(Project),
        origins: [Local, Ssh],
    },
    /// Today's `projectDirectory`.
    ProjectDirectory => "project/directory" {
        params: ProjectDirectoryParams,
        result: JsonValue,
        scope: shared_read("project"),
        class: C1,
        mutation: none,
        origins: [Local, Ssh, Relay],
    },
    /// Today's `projectRecoveryDirectory`.
    ProjectRecoveryDirectory => "project/recoveryDirectory" {
        params: ProjectRecoveryDirectoryParams,
        result: JsonValue,
        scope: shared_read("project"),
        class: C1,
        mutation: none,
        origins: [Local, Ssh],
    },
    /// Today's `getTaskWorkspace`.
    ProjectTaskWorkspace => "project/taskWorkspace" {
        params: ProjectTaskWorkspaceParams,
        result: JsonValue,
        scope: shared_read("project"),
        class: C1,
        mutation: none,
        origins: [Local, Ssh, Relay],
    },
    /// Code graph query (linked `mixdog-graph`).
    ProjectCodeGraph => "project/codeGraph" {
        params: ProjectCodeGraphParams,
        result: JsonValue,
        scope: none,
        class: C3,
        mutation: none,
        origins: [Local, Ssh, Relay],
    },
    /// List one directory.
    ProjectFsListDir => "projectFs/listDir" {
        params: ProjectFsListDirParams,
        result: JsonValue,
        scope: none,
        class: C1,
        mutation: none,
        origins: [Local, Ssh, Relay],
    },
    /// Read a text file (replaces the `In`/`Authorized` variants; origin rules apply).
    ProjectFsReadText => "projectFs/readText" {
        params: ProjectFsReadTextParams,
        result: JsonValue,
        scope: none,
        class: C1,
        mutation: none,
        origins: [Local, Ssh, Relay],
    },
    /// Compare-and-set write; mismatch → `preconditionFailed`.
    ProjectFsWriteText => "projectFs/writeText" {
        params: ProjectFsWriteTextParams,
        result: JsonValue,
        scope: none,
        class: C2,
        mutation: op(ProjectFs),
        origins: [Local, Ssh, Relay],
    },
    /// Recovery-backed multi-file write.
    ProjectFsWriteTextBatch => "projectFs/writeTextBatch" {
        params: ProjectFsWriteTextBatchParams,
        result: JsonValue,
        scope: none,
        class: C2,
        mutation: op(ProjectFs),
        origins: [Local, Ssh, Relay],
    },
    /// Stat a project entry.
    ProjectFsStat => "projectFs/stat" {
        params: ProjectFsStatParams,
        result: JsonValue,
        scope: none,
        class: C1,
        mutation: none,
        origins: [Local, Ssh, Relay],
    },
    /// Create a file or directory.
    ProjectFsCreate => "projectFs/create" {
        params: ProjectFsCreateParams,
        result: JsonValue,
        scope: none,
        class: C2,
        mutation: op(ProjectFs),
        origins: [Local, Ssh, Relay],
    },
    /// Rename an entry.
    ProjectFsRename => "projectFs/rename" {
        params: ProjectFsRenameParams,
        result: JsonValue,
        scope: none,
        class: C2,
        mutation: op(ProjectFs),
        origins: [Local, Ssh, Relay],
    },
    /// Move an entry.
    ProjectFsMove => "projectFs/move" {
        params: ProjectFsMoveParams,
        result: JsonValue,
        scope: none,
        class: C2,
        mutation: op(ProjectFs),
        origins: [Local, Ssh, Relay],
    },
    /// Copy an entry.
    ProjectFsCopy => "projectFs/copy" {
        params: ProjectFsCopyParams,
        result: JsonValue,
        scope: none,
        class: C2,
        mutation: op(ProjectFs),
        origins: [Local, Ssh, Relay],
    },
    /// Move an entry to the OS trash.
    ProjectFsTrash => "projectFs/trash" {
        params: ProjectFsTrashParams,
        result: JsonValue,
        scope: none,
        class: C2,
        mutation: op(ProjectFs),
        origins: [Local, Ssh, Relay],
    },
    /// Absolute path of an entry.
    ProjectFsEntryPath => "projectFs/entryPath" {
        params: ProjectFsEntryPathParams,
        result: JsonValue,
        scope: none,
        class: C1,
        mutation: none,
        origins: [Local, Ssh, Relay],
    },
    /// Read an absolute path the connection may read.
    ProjectFsReadLocal => "projectFs/readLocal" {
        params: ProjectFsReadLocalParams,
        result: JsonValue,
        scope: none,
        class: C1,
        mutation: none,
        origins: [Local, Ssh, Relay],
    },
    /// Stat absolute paths (single and list form).
    ProjectFsStatLocal => "projectFs/statLocal" {
        params: ProjectFsStatLocalParams,
        result: JsonValue,
        scope: none,
        class: C1,
        mutation: none,
        origins: [Local, Ssh, Relay],
    },
    /// Host/server directory browser.
    ProjectFsBrowseDirs => "projectFs/browseDirs" {
        params: ProjectFsBrowseDirsParams,
        result: JsonValue,
        scope: none,
        class: C1,
        mutation: none,
        origins: [Local, Ssh, Relay],
    },
    /// Workspace text search.
    ProjectFsSearchText => "projectFs/searchText" {
        params: ProjectFsSearchTextParams,
        result: JsonValue,
        scope: none,
        class: C3,
        mutation: none,
        origins: [Local, Ssh, Relay],
    },
    /// Recovery-backed workspace replace.
    ProjectFsReplaceText => "projectFs/replaceText" {
        params: ProjectFsReplaceTextParams,
        result: JsonValue,
        scope: none,
        class: C3,
        mutation: op(ProjectFs),
        origins: [Local, Ssh, Relay],
    },
    /// Editor recovery: `inspect` | `restore` | `discard`.
    ProjectFsRecovery => "projectFs/recovery" {
        params: ProjectFsRecoveryParams,
        result: JsonValue,
        scope: none,
        class: C2,
        mutation: op(ProjectFs),
        origins: [Local, Ssh, Relay],
    },
    /// Editor backup read.
    ProjectFsBackupRead => "projectFs/backup/read" {
        params: ProjectFsBackupReadParams,
        result: JsonValue,
        scope: none,
        class: C1,
        mutation: none,
        origins: [Local, Ssh, Relay],
    },
    /// Editor backup write.
    ProjectFsBackupWrite => "projectFs/backup/write" {
        params: ProjectFsBackupWriteParams,
        result: JsonValue,
        scope: none,
        class: C2,
        mutation: op(ProjectFs),
        origins: [Local, Ssh, Relay],
    },
    /// Editor backup delete.
    ProjectFsBackupDelete => "projectFs/backup/delete" {
        params: ProjectFsBackupDeleteParams,
        result: JsonValue,
        scope: none,
        class: C2,
        mutation: op(ProjectFs),
        origins: [Local, Ssh, Relay],
    },
    /// Read a `.code-workspace` file.
    ProjectFsWorkspaceFileRead => "projectFs/workspaceFile/read" {
        params: ProjectFsWorkspaceFileReadParams,
        result: JsonValue,
        scope: none,
        class: C1,
        mutation: none,
        origins: [Local, Ssh],
    },
    /// Write a `.code-workspace` file.
    ProjectFsWorkspaceFileWrite => "projectFs/workspaceFile/write" {
        params: ProjectFsWorkspaceFileWriteParams,
        result: JsonValue,
        scope: none,
        class: C2,
        mutation: op(ProjectFs),
        origins: [Local, Ssh, Relay],
    },
    /// Scoped editor settings.
    ProjectFsReadEditorSettings => "projectFs/readEditorSettings" {
        params: ProjectFsReadEditorSettingsParams,
        result: JsonValue,
        scope: none,
        class: C1,
        mutation: none,
        origins: [Local, Ssh, Relay],
    },
    /// Rendered snapshot of a file by the desktop host (`host/capture/fileSnapshot`).
    ProjectFsCaptureSnapshot => "projectFs/captureSnapshot" {
        params: ProjectFsCaptureSnapshotParams,
        result: JsonValue,
        scope: none,
        class: C1,
        mutation: none,
        origins: [Local, Ssh, Relay],
    },
    /// URL of the desktop host's local page server (`host/localPage/url`).
    ProjectFsLocalPageUrl => "projectFs/localPageUrl" {
        params: ProjectFsLocalPageUrlParams,
        result: JsonValue,
        scope: none,
        class: C1,
        mutation: none,
        origins: [Local, Ssh, Relay],
    },
    /// Lease a page held in memory (`index.html` and sibling files) from the core page server, for the visualize pane and its exports (Node's `localVirtualPageUrl`, local-page-server.ts).
    ProjectFsLocalPageVirtual => "projectFs/localPage/virtual" {
        params: v2::desktop_files::ProjectFsLocalPageVirtualParams,
        result: JsonValue,
        scope: none,
        class: C1,
        mutation: none,
        origins: [Local],
    },
    /// Describe local paths for the desktop and mint one-file grants (Node's `describeLocalPaths`, selected-file-access.ts).
    ProjectFsGrantDescribe => "projectFs/grant/describe" {
        params: v2::desktop_files::ProjectFsGrantDescribeParams,
        result: JsonValue,
        scope: none,
        class: C1,
        mutation: none,
        origins: [Local],
    },
    /// Check a one-file grant against the path asked for and answer the file's folder and name (Node's `requireGrant`, selected-file-access.ts).
    ProjectFsGrantRedeem => "projectFs/grant/redeem" {
        params: v2::desktop_files::ProjectFsGrantRedeemParams,
        result: JsonValue,
        scope: none,
        class: C1,
        mutation: none,
        origins: [Local],
    },
    /// End every page lease a desktop window holds (Node's `revokeLocalPagesForOwner`, local-page-server.ts).
    ProjectFsLocalPageRevokeOwner => "projectFs/localPage/revokeOwner" {
        params: v2::desktop_files::ProjectFsLocalPageRevokeOwnerParams,
        result: JsonValue,
        scope: none,
        class: C1,
        mutation: none,
        origins: [Local],
    },
    /// Origin of the core's local page server (Node's `localPageOrigin`, local-page-server.ts).
    ProjectFsLocalPageOrigin => "projectFs/localPage/origin" {
        params: v2::desktop_files::ProjectFsLocalPageOriginParams,
        result: JsonValue,
        scope: none,
        class: C1,
        mutation: none,
        origins: [Local],
    },
    /// What a paired device's file preview reads first: kind, mime, size, modification time and the media lease (Node's `previewProjectFile`).
    ProjectFsPreviewFile => "projectFs/previewFile" {
        params: ProjectFsPreviewFileParams,
        result: JsonValue,
        scope: none,
        class: C1,
        mutation: none,
        origins: [Local, Ssh, Relay],
    },
    /// One bounded window of a previewable file, base64 (Node's `previewProjectFileRange`).
    ProjectFsPreviewRange => "projectFs/previewRange" {
        params: ProjectFsPreviewRangeParams,
        result: JsonValue,
        scope: none,
        class: C1,
        mutation: none,
        origins: [Local, Ssh, Relay],
    },
    /// Connection-owned watch; changes on scoped feed `fs:<watchId>`.
    FsWatch => "fs/watch" {
        params: FsWatchParams,
        result: v2::feed::Subscription,
        scope: fs_watch(watch_id),
        class: C1,
        mutation: none,
        origins: [Local, Ssh, Relay],
    },
    /// Drop a watch.
    FsUnwatch => "fs/unwatch" {
        params: FsUnwatchParams,
        result: v2::feed::EmptyResult,
        scope: fs_watch(watch_id),
        class: C1,
        mutation: none,
        origins: [Local, Ssh, Relay],
    },
    /// Sessioned fuzzy file search; results on `search:<sessionId>`.
    SearchStart => "search/start" {
        params: SearchStartParams,
        result: v2::feed::Subscription,
        scope: fuzzy(session_id),
        class: C3,
        mutation: none,
        origins: [Local, Ssh, Relay],
    },
    /// New query for a search session.
    SearchUpdate => "search/update" {
        params: SearchUpdateParams,
        result: v2::feed::EmptyResult,
        scope: fuzzy(session_id),
        class: C1,
        mutation: none,
        origins: [Local, Ssh, Relay],
    },
    /// End a search session.
    SearchStop => "search/stop" {
        params: SearchStopParams,
        result: v2::feed::EmptyResult,
        scope: fuzzy(session_id),
        class: C1,
        mutation: none,
        origins: [Local, Ssh, Relay],
    },
    /// Open one read handle (connection-owned).
    TransferBeginRead => "transfer/beginRead" {
        params: v2::domain::TransferBeginReadParams,
        result: v2::domain::TransferBeginReadResponse,
        scope: none,
        class: C1,
        mutation: none,
        origins: [Local, Ssh, Relay],
    },
    /// Zip a folder (git-aware list, size cap) into a read transfer.
    TransferBeginZip => "transfer/beginZip" {
        params: TransferBeginZipParams,
        result: v2::domain::TransferBeginReadResponse,
        scope: none,
        class: C3,
        mutation: none,
        origins: [Local, Ssh],
    },
    /// One page of an open read.
    TransferReadRange => "transfer/readRange" {
        params: TransferReadRangeParams,
        result: v2::op::BlobReadResponse,
        scope: none,
        class: C1,
        mutation: none,
        origins: [Local, Ssh, Relay],
    },
    /// A paired phone's download, first stage: opens the file and answers a grant that expires.
    TransferAuthorizeRead => "transfer/authorizeRead" {
        params: TransferAuthorizeReadParams,
        result: JsonValue,
        scope: none,
        class: C1,
        mutation: none,
        origins: [Relay],
    },
    /// A paired phone's download, second stage: consumes the grant once into a transfer.
    TransferRedeemGrant => "transfer/redeemGrant" {
        params: TransferRedeemGrantParams,
        result: JsonValue,
        scope: none,
        class: C1,
        mutation: none,
        origins: [Relay],
    },
    /// A paired phone's download is done: the file must still be the leased version; the transfer ends either way.
    TransferFinishRead => "transfer/finishRead" {
        params: TransferFinishReadParams,
        result: JsonValue,
        scope: none,
        class: C1,
        mutation: none,
        origins: [Relay],
    },
    /// Close a read (finish or abort).
    TransferEndRead => "transfer/endRead" {
        params: TransferEndReadParams,
        result: v2::feed::EmptyResult,
        scope: none,
        class: C1,
        mutation: none,
        origins: [Local, Ssh, Relay],
    },
    /// Open an upload.
    TransferBeginWrite => "transfer/beginWrite" {
        params: TransferBeginWriteParams,
        result: JsonValue,
        scope: none,
        class: C2,
        mutation: op(Transfer),
        origins: [Local, Ssh],
    },
    /// One upload chunk.
    TransferWriteChunk => "transfer/writeChunk" {
        params: TransferWriteChunkParams,
        result: v2::feed::EmptyResult,
        scope: none,
        class: C2,
        mutation: none,
        origins: [Local, Ssh],
    },
    /// Commit an upload.
    TransferCommit => "transfer/commit" {
        params: TransferCommitParams,
        result: JsonValue,
        scope: none,
        class: C2,
        mutation: op(Transfer),
        origins: [Local, Ssh],
    },
    /// Abort an upload.
    TransferAbort => "transfer/abort" {
        params: TransferAbortParams,
        result: JsonValue,
        scope: none,
        class: C2,
        mutation: none,
        origins: [Local, Ssh],
    },
    /// Server trash info.
    TransferTrashInfo => "transfer/trash/info" {
        params: TransferTrashInfoParams,
        result: JsonValue,
        scope: none,
        class: C1,
        mutation: none,
        origins: [Local, Ssh],
    },
    /// Move a server entry to trash.
    TransferTrashEntry => "transfer/trash/entry" {
        params: TransferTrashEntryParams,
        result: JsonValue,
        scope: none,
        class: C2,
        mutation: op(Transfer),
        origins: [Local, Ssh],
    },
    /// Mint a one-file grant for a paired device's path outside every project (Node's `rememberFileGrant`).
    TransferGrantMint => "transfer/grant/mint" {
        params: TransferGrantMintParams,
        result: JsonValue,
        scope: none,
        class: C1,
        mutation: none,
        origins: [Relay],
    },
    /// Subscribes the project's language-server feed `lsp:<root>`
    /// (`lsp/status/updated`, `lsp/diagnostics/updated`).
    LspSubscribe => "lsp/subscribe" {
        params: LspSubscribeParams,
        result: v2::feed::Subscription,
        scope: keyed("lsp", root),
        class: C1,
        mutation: none,
        origins: [Local, Ssh, Relay],
    },
    /// Ends the subscription of `lsp/subscribe`.
    LspUnsubscribe => "lsp/unsubscribe" {
        params: LspSubscribeParams,
        result: v2::feed::EmptyResult,
        scope: keyed("lsp", root),
        class: C1,
        mutation: none,
        origins: [Local, Ssh, Relay],
    },
    /// Document sync.
    LspDocument => "lsp/document" {
        params: LspDocumentParams,
        result: JsonValue,
        scope: none,
        class: C1,
        mutation: none,
        origins: [Local, Ssh, Relay],
    },
    /// Language-server request (may carry edits).
    LspRequest => "lsp/request" {
        params: LspRequestParams,
        result: JsonValue,
        scope: none,
        class: C2,
        mutation: op(Lsp),
        origins: [Local, Ssh, Relay],
    },
    /// Document preview.
    DocumentPreview => "document/preview" {
        params: DocumentPreviewParams,
        result: JsonValue,
        scope: none,
        class: C1,
        mutation: none,
        origins: [Local, Ssh],
    },
    /// Document preview pages.
    DocumentPreviewPages => "document/previewPages" {
        params: DocumentPreviewPagesParams,
        result: JsonValue,
        scope: none,
        class: C1,
        mutation: none,
        origins: [Local, Ssh, Relay],
    },
    /// LibreOffice status.
    DocumentLibreOfficeStatus => "document/libreOfficeStatus" {
        params: DocumentLibreOfficeStatusParams,
        result: JsonValue,
        scope: none,
        class: C1,
        mutation: none,
        origins: [Local, Ssh, Relay],
    },
    /// Install LibreOffice (external effect).
    DocumentInstallLibreOffice => "document/installLibreOffice" {
        params: DocumentInstallLibreOfficeParams,
        result: JsonValue,
        scope: none,
        class: C2,
        mutation: op(Document),
        origins: [Local, Ssh, Relay],
    },
    /// Repository status.
    GitStatus => "git/status" {
        params: GitStatusParams,
        result: JsonValue,
        scope: none,
        class: C1,
        mutation: none,
        origins: [Local, Ssh, Relay],
    },
    /// Branches.
    GitBranches => "git/branches" {
        params: GitBranchesParams,
        result: JsonValue,
        scope: none,
        class: C1,
        mutation: none,
        origins: [Local, Ssh, Relay],
    },
    /// History.
    GitLog => "git/log" {
        params: GitLogParams,
        result: JsonValue,
        scope: none,
        class: C1,
        mutation: none,
        origins: [Local, Ssh, Relay],
    },
    /// One commit.
    GitShow => "git/show" {
        params: GitShowParams,
        result: JsonValue,
        scope: none,
        class: C1,
        mutation: none,
        origins: [Local, Ssh, Relay],
    },
    /// One commit file diff.
    GitShowDiff => "git/showDiff" {
        params: GitShowDiffParams,
        result: JsonValue,
        scope: none,
        class: C1,
        mutation: none,
        origins: [Local, Ssh, Relay],
    },
    /// File at a revision.
    GitShowFile => "git/showFile" {
        params: GitShowFileParams,
        result: JsonValue,
        scope: none,
        class: C1,
        mutation: none,
        origins: [Local, Ssh, Relay],
    },
    /// Working diff.
    GitDiff => "git/diff" {
        params: GitDiffParams,
        result: JsonValue,
        scope: none,
        class: C1,
        mutation: none,
        origins: [Local, Ssh, Relay],
    },
    /// Stashes.
    GitStashList => "git/stashList" {
        params: GitStashListParams,
        result: JsonValue,
        scope: none,
        class: C1,
        mutation: none,
        origins: [Local, Ssh, Relay],
    },
    /// Context for a git request.
    GitRequestContext => "git/requestContext" {
        params: GitRequestContextParams,
        result: JsonValue,
        scope: none,
        class: C1,
        mutation: none,
        origins: [Local, Ssh, Relay],
    },
    /// git CLI presence.
    GitCliStatus => "git/cliStatus" {
        params: GitCliStatusParams,
        result: JsonValue,
        scope: none,
        class: C1,
        mutation: none,
        origins: [Local, Ssh, Relay],
    },
    /// Global git identity config.
    GitGlobalConfigRead => "git/globalConfig/read" {
        params: GitGlobalConfigReadParams,
        result: JsonValue,
        scope: none,
        class: C1,
        mutation: none,
        origins: [Local, Ssh, Relay],
    },
    /// Subscribe `git:<root>` (section `gitStatus`).
    GitWatch => "git/watch" {
        params: GitWatchParams,
        result: v2::feed::Subscription,
        scope: none,
        class: C1,
        mutation: none,
        origins: [Local, Ssh],
    },
    /// Unsubscribe `git:<root>`.
    GitUnwatch => "git/unwatch" {
        params: GitUnwatchParams,
        result: v2::feed::EmptyResult,
        scope: none,
        class: C1,
        mutation: none,
        origins: [Local, Ssh],
    },
    /// Stage.
    GitStage => "git/stage" {
        params: GitStageParams,
        result: JsonValue,
        scope: repo(cwd),
        class: C2,
        mutation: op(Git),
        origins: [Local, Ssh, Relay],
    },
    /// Unstage.
    GitUnstage => "git/unstage" {
        params: GitUnstageParams,
        result: JsonValue,
        scope: repo(cwd),
        class: C2,
        mutation: op(Git),
        origins: [Local, Ssh, Relay],
    },
    /// Commit.
    GitCommit => "git/commit" {
        params: GitCommitParams,
        result: JsonValue,
        scope: repo(cwd),
        class: C2,
        mutation: op(Git),
        origins: [Local, Ssh, Relay],
    },
    /// Commit selected paths (commit transaction).
    GitCommitPaths => "git/commitPaths" {
        params: GitCommitPathsParams,
        result: JsonValue,
        scope: repo(cwd),
        class: C2,
        mutation: op(Git),
        origins: [Local, Ssh, Relay],
    },
    /// Amend.
    GitAmend => "git/amend" {
        params: GitAmendParams,
        result: JsonValue,
        scope: repo(cwd),
        class: C2,
        mutation: op(Git),
        origins: [Local, Ssh, Relay],
    },
    /// Undo last commit.
    GitUndoLastCommit => "git/undoLastCommit" {
        params: GitUndoLastCommitParams,
        result: JsonValue,
        scope: repo(cwd),
        class: C2,
        mutation: op(Git),
        origins: [Local, Ssh, Relay],
    },
    /// Push (external effect).
    GitPush => "git/push" {
        params: GitPushParams,
        result: JsonValue,
        scope: repo(cwd),
        class: C2,
        mutation: op(Git),
        origins: [Local, Ssh, Relay],
    },
    /// Pull (external effect).
    GitPull => "git/pull" {
        params: GitPullParams,
        result: JsonValue,
        scope: repo(cwd),
        class: C2,
        mutation: op(Git),
        origins: [Local, Ssh, Relay],
    },
    /// Fetch (external effect).
    GitFetch => "git/fetch" {
        params: GitFetchParams,
        result: JsonValue,
        scope: repo(cwd),
        class: C2,
        mutation: op(Git),
        origins: [Local, Ssh, Relay],
    },
    /// Pull then push (external effect).
    GitSync => "git/sync" {
        params: GitSyncParams,
        result: JsonValue,
        scope: repo(cwd),
        class: C2,
        mutation: op(Git),
        origins: [Local, Ssh, Relay],
    },
    /// Stash.
    GitStash => "git/stash" {
        params: GitStashParams,
        result: JsonValue,
        scope: repo(cwd),
        class: C2,
        mutation: op(Git),
        origins: [Local, Ssh, Relay],
    },
    /// Stash pop.
    GitStashPop => "git/stashPop" {
        params: GitStashPopParams,
        result: JsonValue,
        scope: repo(cwd),
        class: C2,
        mutation: op(Git),
        origins: [Local, Ssh, Relay],
    },
    /// Stash apply.
    GitStashApply => "git/stashApply" {
        params: GitStashApplyParams,
        result: JsonValue,
        scope: repo(cwd),
        class: C2,
        mutation: op(Git),
        origins: [Local, Ssh, Relay],
    },
    /// Stash drop.
    GitStashDrop => "git/stashDrop" {
        params: GitStashDropParams,
        result: JsonValue,
        scope: repo(cwd),
        class: C2,
        mutation: op(Git),
        origins: [Local, Ssh, Relay],
    },
    /// Create tag.
    GitCreateTag => "git/createTag" {
        params: GitCreateTagParams,
        result: JsonValue,
        scope: repo(cwd),
        class: C2,
        mutation: op(Git),
        origins: [Local, Ssh, Relay],
    },
    /// Delete tag.
    GitDeleteTag => "git/deleteTag" {
        params: GitDeleteTagParams,
        result: JsonValue,
        scope: repo(cwd),
        class: C2,
        mutation: op(Git),
        origins: [Local, Ssh, Relay],
    },
    /// Delete branch.
    GitDeleteBranch => "git/deleteBranch" {
        params: GitDeleteBranchParams,
        result: JsonValue,
        scope: repo(cwd),
        class: C2,
        mutation: op(Git),
        origins: [Local, Ssh, Relay],
    },
    /// Rename branch.
    GitRenameBranch => "git/renameBranch" {
        params: GitRenameBranchParams,
        result: JsonValue,
        scope: repo(cwd),
        class: C2,
        mutation: op(Git),
        origins: [Local, Ssh, Relay],
    },
    /// Reset.
    GitResetToCommit => "git/resetToCommit" {
        params: GitResetToCommitParams,
        result: JsonValue,
        scope: repo(cwd),
        class: C2,
        mutation: op(Git),
        origins: [Local, Ssh, Relay],
    },
    /// Revert a commit.
    GitRevertCommit => "git/revertCommit" {
        params: GitRevertCommitParams,
        result: JsonValue,
        scope: repo(cwd),
        class: C2,
        mutation: op(Git),
        origins: [Local, Ssh, Relay],
    },
    /// Revert a file.
    GitRevertFile => "git/revertFile" {
        params: GitRevertFileParams,
        result: JsonValue,
        scope: repo(cwd),
        class: C2,
        mutation: op(Git),
        origins: [Local, Ssh, Relay],
    },
    /// Cherry-pick.
    GitCherryPickCommit => "git/cherryPickCommit" {
        params: GitCherryPickCommitParams,
        result: JsonValue,
        scope: repo(cwd),
        class: C2,
        mutation: op(Git),
        origins: [Local, Ssh, Relay],
    },
    /// Apply a patch.
    GitApplyPatch => "git/applyPatch" {
        params: GitApplyPatchParams,
        result: JsonValue,
        scope: repo(cwd),
        class: C2,
        mutation: op(Git),
        origins: [Local, Ssh, Relay],
    },
    /// Add to an ignore file.
    GitIgnore => "git/ignore" {
        params: GitIgnoreParams,
        result: JsonValue,
        scope: repo(cwd),
        class: C2,
        mutation: op(Git),
        origins: [Local, Ssh, Relay],
    },
    /// Continue an operation.
    GitContinue => "git/continue" {
        params: GitContinueParams,
        result: JsonValue,
        scope: repo(cwd),
        class: C2,
        mutation: op(Git),
        origins: [Local, Ssh, Relay],
    },
    /// Abort an operation.
    GitAbortOperation => "git/abortOperation" {
        params: GitAbortOperationParams,
        result: JsonValue,
        scope: repo(cwd),
        class: C2,
        mutation: op(Git),
        origins: [Local, Ssh, Relay],
    },
    /// Write global git identity config.
    GitGlobalConfigWrite => "git/globalConfig/write" {
        params: GitGlobalConfigWriteParams,
        result: JsonValue,
        scope: none,
        class: C2,
        mutation: op(Git),
        origins: [Local, Ssh, Relay],
    },
    /// Install the git CLI (external effect).
    GitCliInstall => "git/cli/install" {
        params: GitCliInstallParams,
        result: JsonValue,
        scope: none,
        class: C2,
        mutation: op(Git),
        origins: [Local, Ssh, Relay],
    },
    /// GitHub CLI status.
    GithubStatus => "github/status" {
        params: GithubStatusParams,
        result: JsonValue,
        scope: none,
        class: C1,
        mutation: none,
        origins: [Local, Ssh, Relay],
    },
    /// Signed-in account.
    GithubAccount => "github/account" {
        params: GithubAccountParams,
        result: JsonValue,
        scope: none,
        class: C1,
        mutation: none,
        origins: [Local, Ssh, Relay],
    },
    /// Start `gh auth login`; progress on `login:<flowId>`.
    GithubLoginStart => "github/login/start" {
        params: GithubLoginStartParams,
        result: JsonValue,
        scope: none,
        class: C2,
        mutation: op(Github),
        origins: [Local, Ssh, Relay],
    },
    /// Login flow snapshot read.
    GithubLoginStatus => "github/login/status" {
        params: GithubLoginStatusParams,
        result: JsonValue,
        scope: none,
        class: C1,
        mutation: none,
        origins: [Local, Ssh, Relay],
    },
    /// Open the verification page.
    GithubLoginOpenBrowser => "github/login/openBrowser" {
        params: GithubLoginOpenBrowserParams,
        result: JsonValue,
        scope: keyed_text("githubLogin", flow_id, 200),
        class: C2,
        mutation: op(Github),
        origins: [Local, Ssh, Relay],
    },
    /// Cancel the flow.
    GithubLoginCancel => "github/login/cancel" {
        params: GithubLoginCancelParams,
        result: JsonValue,
        scope: keyed_text("githubLogin", flow_id, 200),
        class: C2,
        mutation: op(Github),
        origins: [Local, Ssh, Relay],
    },
    /// Sign out.
    GithubLogout => "github/logout" {
        params: GithubLogoutParams,
        result: JsonValue,
        scope: none,
        class: C2,
        mutation: op(Github),
        origins: [Local, Ssh, Relay],
    },
    /// Install the GitHub CLI.
    GithubInstall => "github/install" {
        params: GithubInstallParams,
        result: JsonValue,
        scope: none,
        class: C2,
        mutation: op(Github),
        origins: [Local, Ssh, Relay],
    },
    /// GitHub API request (never retried).
    GithubRequest => "github/request" {
        params: GithubRequestParams,
        result: JsonValue,
        scope: none,
        class: C2,
        mutation: op(Github),
        origins: [Local, Ssh, Relay],
    },
    /// Star status.
    GithubStarStatus => "github/starStatus" {
        params: GithubStarStatusParams,
        result: JsonValue,
        scope: none,
        class: C1,
        mutation: none,
        origins: [Local, Ssh, Relay],
    },
    /// Star the repository.
    GithubStar => "github/star" {
        params: GithubStarParams,
        result: JsonValue,
        scope: none,
        class: C2,
        mutation: op(Github),
        origins: [Local, Ssh, Relay],
    },
    /// Pull requests.
    GithubPrList => "github/pr/list" {
        params: GithubPrListParams,
        result: JsonValue,
        scope: none,
        class: C1,
        mutation: none,
        origins: [Local, Ssh, Relay],
    },
    /// One pull request.
    GithubPrView => "github/pr/view" {
        params: GithubPrViewParams,
        result: JsonValue,
        scope: none,
        class: C1,
        mutation: none,
        origins: [Local, Ssh, Relay],
    },
    /// Pull request diff.
    GithubPrDiff => "github/pr/diff" {
        params: GithubPrDiffParams,
        result: JsonValue,
        scope: none,
        class: C1,
        mutation: none,
        origins: [Local, Ssh, Relay],
    },
    /// Default branch.
    GithubPrDefaultBranch => "github/pr/defaultBranch" {
        params: GithubPrDefaultBranchParams,
        result: JsonValue,
        scope: none,
        class: C1,
        mutation: none,
        origins: [Local, Ssh, Relay],
    },
    /// Create a pull request.
    GithubPrCreate => "github/pr/create" {
        params: GithubPrCreateParams,
        result: JsonValue,
        scope: none,
        class: C2,
        mutation: op(Github),
        origins: [Local, Ssh, Relay],
    },
    /// Check out a pull request.
    GithubPrCheckout => "github/pr/checkout" {
        params: GithubPrCheckoutParams,
        result: JsonValue,
        scope: repo(cwd),
        class: C2,
        mutation: op(Github),
        origins: [Local, Ssh, Relay],
    },
    /// Merge a pull request.
    GithubPrMerge => "github/pr/merge" {
        params: GithubPrMergeParams,
        result: JsonValue,
        scope: none,
        class: C2,
        mutation: op(Github),
        origins: [Local, Ssh, Relay],
    },
    /// Every review read (turn, session, repo); `pending{key}` while computing.
    ReviewDiffGet => "review/diff/get" {
        params: v2::domain::ReviewDiffGetParams,
        result: JsonValue,
        scope: none,
        class: C1,
        mutation: none,
        origins: [Local, Ssh, Relay],
    },
    /// Spawn; output on `process:<handle>`.
    ProcessSpawn => "process/spawn" {
        params: v2::domain::ProcessSpawnParams,
        result: v2::feed::Subscription,
        scope: process(process_handle),
        class: C2,
        mutation: op(Process),
        origins: [Local, Ssh],
    },
    /// Kill the process tree.
    ProcessKill => "process/kill" {
        params: ProcessKillParams,
        result: v2::feed::EmptyResult,
        scope: process(process_handle),
        class: C2,
        mutation: none,
        origins: [Local, Ssh],
    },
    /// Resize a PTY.
    ProcessResizePty => "process/resizePty" {
        params: ProcessResizePtyParams,
        result: v2::feed::EmptyResult,
        scope: process(process_handle),
        class: C2,
        mutation: none,
        origins: [Local, Ssh],
    },
    /// Programmatic stdin with a result.
    ProcessWriteStdin => "process/writeStdin" {
        params: ProcessWriteStdinParams,
        result: v2::feed::EmptyResult,
        scope: process(process_handle),
        class: C2,
        mutation: none,
        origins: [Local, Ssh],
    },
    /// Create or reuse a terminal tab.
    TerminalEnsure => "terminal/ensure" {
        params: TerminalEnsureParams,
        result: JsonValue,
        scope: terminal_or_none(tab_id),
        class: C2,
        mutation: op(Terminal),
        origins: [Local, Ssh, Relay],
    },
    /// Subscribe `process:<tabId>`; snapshot = screen text.
    TerminalAttach => "terminal/attach" {
        params: TerminalAttachParams,
        result: JsonValue,
        scope: terminal(tab_id),
        class: C2,
        mutation: none,
        origins: [Local, Ssh, Relay],
    },
    /// Terminal profiles.
    TerminalProfiles => "terminal/profiles" {
        params: TerminalProfilesParams,
        result: JsonValue,
        scope: none,
        class: C1,
        mutation: none,
        origins: [Local, Ssh, Relay],
    },
    /// This connection becomes the size owner.
    TerminalFocus => "terminal/focus" {
        params: TerminalFocusParams,
        result: v2::feed::EmptyResult,
        scope: terminal(tab_id),
        class: C2,
        mutation: none,
        origins: [Local, Ssh, Relay],
    },
    /// xterm flow control.
    TerminalPause => "terminal/pause" {
        params: TerminalPauseParams,
        result: v2::feed::EmptyResult,
        scope: terminal(tab_id),
        class: C2,
        mutation: none,
        origins: [Local, Ssh],
    },
    /// xterm flow control.
    TerminalResume => "terminal/resume" {
        params: TerminalResumeParams,
        result: v2::feed::EmptyResult,
        scope: terminal(tab_id),
        class: C2,
        mutation: none,
        origins: [Local, Ssh],
    },
    /// Close a tab.
    TerminalDispose => "terminal/dispose" {
        params: TerminalDisposeParams,
        result: v2::feed::EmptyResult,
        scope: terminal(tab_id),
        class: C2,
        mutation: op(Terminal),
        origins: [Local, Ssh, Relay],
    },
    /// Subscribe `ports`; the sampler runs only while subscribed.
    SystemPortsSubscribe => "system/ports/subscribe" {
        params: SystemPortsSubscribeParams,
        result: v2::feed::Subscription,
        scope: none,
        class: C1,
        mutation: none,
        origins: [Local, Ssh],
    },
    /// Unsubscribe `ports`.
    SystemPortsUnsubscribe => "system/ports/unsubscribe" {
        params: SystemPortsUnsubscribeParams,
        result: v2::feed::EmptyResult,
        scope: none,
        class: C1,
        mutation: none,
        origins: [Local, Ssh],
    },
    /// Subscribe the `connections` scoped feed; with `connectionId` only that server's `link/<id>` and `ports/<id>` are delivered. Caller: M or S.
    ConnectionsSubscribe => "connections/subscribe" {
        params: ConnectionsSubscribeParams,
        result: v2::feed::Subscription,
        scope: none,
        class: C2,
        mutation: none,
        origins: [Local],
    },
    /// End a `connections/subscribe` subscription. Caller: M or S.
    ConnectionsUnsubscribe => "connections/unsubscribe" {
        params: ConnectionsUnsubscribeParams,
        result: v2::feed::EmptyResult,
        scope: none,
        class: C2,
        mutation: none,
        origins: [Local],
    },
    /// The saved SSH servers (the desktop's `sshListHosts`). Caller: M.
    ConnectionsSshList => "connections/ssh/list" {
        params: ConnectionsNoParams,
        result: Vec<SshHost>,
        scope: none,
        class: C2,
        mutation: none,
        origins: [Local],
    },
    /// Local name of a saved SSH server (`sshRenameHost`). Caller: M.
    ConnectionsSshRename => "connections/ssh/rename" {
        params: ConnectionsRenameParams,
        result: v2::feed::EmptyResult,
        scope: none,
        class: C2,
        mutation: none,
        origins: [Local],
    },
    /// Remove only the saved entry (`sshForgetHost`). Caller: M.
    ConnectionsSshForget => "connections/ssh/forget" {
        params: ConnectionsIdParams,
        result: v2::feed::EmptyResult,
        scope: none,
        class: C2,
        mutation: none,
        origins: [Local],
    },
    /// Open (or focus) a saved server's window; a failure comes back as a result (`sshOpenHost`). Caller: M.
    ConnectionsSshOpen => "connections/ssh/open" {
        params: ConnectionsIdParams,
        result: SshConnectResult,
        scope: none,
        class: C2,
        mutation: none,
        origins: [Local],
    },
    /// Host aliases of this PC's `~/.ssh/config`, wildcard patterns skipped (`sshConfigHosts`). Caller: M.
    ConnectionsSshConfigHosts => "connections/ssh/configHosts" {
        params: ConnectionsNoParams,
        result: Vec<SshConfigHost>,
        scope: none,
        class: C2,
        mutation: none,
        origins: [Local],
    },
    /// Read the server's host key, compare it with this PC's known_hosts and open an attempt bound to the caller (`sshInspectHostKey`). Caller: M.
    ConnectionsSshInspect => "connections/ssh/inspect" {
        params: SshInspectParams,
        result: SshInspection,
        scope: none,
        class: C2,
        mutation: none,
        origins: [Local],
    },
    /// Connect the inspected address, save the server and open its window; progress arrives as `connections/ssh/progress` (`sshConnect`). Caller: M, the caller that minted attemptId.
    ConnectionsSshConnect => "connections/ssh/connect" {
        params: SshConnectParams,
        result: SshConnectResult,
        scope: none,
        class: C2,
        mutation: none,
        origins: [Local],
    },
    /// Cancel a connect attempt (`sshCancel`). Caller: M, the caller that minted attemptId.
    ConnectionsSshCancel => "connections/ssh/cancel" {
        params: SshCancelParams,
        result: v2::feed::EmptyResult,
        scope: none,
        class: C2,
        mutation: none,
        origins: [Local],
    },
    /// Answer a question ssh asked; `secret: null` cancels it (`sshAskpassReply`). Caller: M, the caller that minted attemptId.
    ConnectionsSshAskpassReply => "connections/ssh/askpassReply" {
        params: SshAskpassReplyParams,
        result: v2::feed::EmptyResult,
        scope: none,
        class: C2,
        mutation: none,
        origins: [Local],
    },
    /// Remove Mixdog from a saved server over ssh, then optionally forget the entry (`sshCleanupHost`). Caller: M.
    ConnectionsSshCleanup => "connections/ssh/cleanup" {
        params: SshCleanupParams,
        result: SshCleanupResult,
        scope: none,
        class: C2,
        mutation: none,
        origins: [Local],
    },
    /// Per-server settings: folder, login key file, auto-reconnect, model login, providers, grace (`sshUpdateHostSettings`). Caller: M.
    ConnectionsSshUpdateSettings => "connections/ssh/updateSettings" {
        params: SshUpdateSettingsParams,
        result: SshHost,
        scope: none,
        class: C2,
        mutation: none,
        origins: [Local],
    },
    /// The connection log of a server (`sshDiagnosticsLog`). Caller: M or S.
    ConnectionsSshDiagnosticsLog => "connections/ssh/diagnosticsLog" {
        params: SshDiagnosticsRefParams,
        result: SshLogView,
        scope: none,
        class: C2,
        mutation: none,
        origins: [Local],
    },
    /// The text to copy for a bug report (`sshDiagnosticsCopy`). Caller: M or S.
    ConnectionsSshDiagnosticsCopy => "connections/ssh/diagnosticsCopy" {
        params: SshDiagnosticsRefParams,
        result: SshDiagnosticsText,
        scope: none,
        class: C2,
        mutation: none,
        origins: [Local],
    },
    /// The last 200 lines of the server's daemon.log (`sshServerLog`). Caller: M or S.
    ConnectionsSshServerLog => "connections/ssh/serverLog" {
        params: SshDiagnosticsRefParams,
        result: SshServerLog,
        scope: none,
        class: C2,
        mutation: none,
        origins: [Local],
    },
    /// The provider logins stored on a saved server (`sshServerLogins`). Caller: M.
    ConnectionsSshServerLogins => "connections/ssh/serverLogins" {
        params: ConnectionsIdParams,
        result: SshServerLogins,
        scope: none,
        class: C2,
        mutation: none,
        origins: [Local],
    },
    /// Start a subscription login on the server; the flow carries `openUrl` for the renderer's `openExternal` (`sshServerLoginBegin`). Caller: M.
    ConnectionsSshServerLoginBegin => "connections/ssh/serverLoginBegin" {
        params: SshServerLoginProviderParams,
        result: SshServerLoginFlow,
        scope: none,
        class: C2,
        mutation: none,
        origins: [Local],
    },
    /// State of a server login flow (`sshServerLoginStatus`). Caller: M.
    ConnectionsSshServerLoginStatus => "connections/ssh/serverLoginStatus" {
        params: SshServerLoginFlowParams,
        result: SshServerLoginFlow,
        scope: none,
        class: C2,
        mutation: none,
        origins: [Local],
    },
    /// Complete a pending login with the address the browser was redirected to (`sshServerLoginComplete`). Caller: M.
    ConnectionsSshServerLoginComplete => "connections/ssh/serverLoginComplete" {
        params: SshServerLoginCompleteParams,
        result: SshServerLoginFlow,
        scope: none,
        class: C2,
        mutation: none,
        origins: [Local],
    },
    /// Cancel a server login flow (`sshServerLoginCancel`). Caller: M.
    ConnectionsSshServerLoginCancel => "connections/ssh/serverLoginCancel" {
        params: SshServerLoginFlowParams,
        result: v2::feed::EmptyResult,
        scope: none,
        class: C2,
        mutation: none,
        origins: [Local],
    },
    /// Store an API key on the server (`sshServerLoginSaveKey`). Caller: M.
    ConnectionsSshServerLoginSaveKey => "connections/ssh/serverLoginSaveKey" {
        params: SshServerLoginSaveKeyParams,
        result: SshServerLogins,
        scope: none,
        class: C2,
        mutation: none,
        origins: [Local],
    },
    /// Remove a provider login from the server (`sshServerLoginLogout`). Caller: M.
    ConnectionsSshServerLoginLogout => "connections/ssh/serverLoginLogout" {
        params: SshServerLoginProviderParams,
        result: SshServerLogins,
        scope: none,
        class: C2,
        mutation: none,
        origins: [Local],
    },
    /// Delete a custom provider and its models from the server (`sshServerLoginRemoveCustom`). Caller: M.
    ConnectionsSshServerLoginRemoveCustom => "connections/ssh/serverLoginRemoveCustom" {
        params: SshServerLoginProviderParams,
        result: SshServerLogins,
        scope: none,
        class: C2,
        mutation: none,
        origins: [Local],
    },
    /// Open a server window for `MIXDOG_SSH_TARGET` that is not remembered; the desktop host's own call. Caller: H.
    ConnectionsSshOpenEphemeral => "connections/ssh/openEphemeral" {
        params: SshOpenEphemeralParams,
        result: SshConnectResult,
        scope: none,
        class: C2,
        mutation: none,
        origins: [Local],
    },
    /// A server window's link to its daemon as last pushed (`getConnectionLink`). Caller: M or S.
    ConnectionsLinkGet => "connections/link/get" {
        params: ConnectionIdParams,
        result: Option<ConnectionLinkView>,
        scope: none,
        class: C2,
        mutation: none,
        origins: [Local],
    },
    /// Reconnect now; a stopped connection is opened again (`retryConnection`). Caller: M or S.
    ConnectionsLinkRetry => "connections/link/retry" {
        params: ConnectionIdParams,
        result: v2::feed::EmptyResult,
        scope: none,
        class: C2,
        mutation: none,
        origins: [Local],
    },
    /// Run the waiting reconnect attempt now instead of after its countdown (`retryConnectionNow`). Caller: M or S.
    ConnectionsLinkRetryNow => "connections/link/retryNow" {
        params: ConnectionIdParams,
        result: v2::feed::EmptyResult,
        scope: none,
        class: C2,
        mutation: none,
        origins: [Local],
    },
    /// A server window needs the user's connect attempt: the core focuses the main window and sends `connections/signIn`. Caller: S.
    ConnectionsLinkRequestSignIn => "connections/link/requestSignIn" {
        params: ConnectionIdParams,
        result: v2::feed::EmptyResult,
        scope: none,
        class: C2,
        mutation: none,
        origins: [Local],
    },
    /// A server window's Ports panel as last pushed (`listServerPorts`). Caller: M or S.
    ConnectionsPortsList => "connections/ports/list" {
        params: ConnectionIdParams,
        result: ServerPortsView,
        scope: none,
        class: C2,
        mutation: none,
        origins: [Local],
    },
    /// Forward a server port to 127.0.0.1 on this PC (`forwardServerPort`). An error message leads with port-invalid, port-privileged, port-busy, port-not-active or window-closed. Caller: S.
    ConnectionsPortsForward => "connections/ports/forward" {
        params: PortsForwardParams,
        result: PortForward,
        scope: none,
        class: C2,
        mutation: none,
        origins: [Local],
    },
    /// Stop a port forward (`stopServerPortForward`). Caller: S.
    ConnectionsPortsStop => "connections/ports/stop" {
        params: PortsStopParams,
        result: v2::feed::EmptyResult,
        scope: none,
        class: C2,
        mutation: none,
        origins: [Local],
    },
    /// Dismiss a suggested port (`dismissServerPort`). Caller: S.
    ConnectionsPortsDismiss => "connections/ports/dismiss" {
        params: PortsDismissParams,
        result: v2::feed::EmptyResult,
        scope: none,
        class: C2,
        mutation: none,
        origins: [Local],
    },
    /// "Reopen server windows when the app starts" (`getReopenServerWindows`). Caller: M.
    ConnectionsRestoreGet => "connections/restore/get" {
        params: ConnectionsNoParams,
        result: ConnectionsRestoreState,
        scope: none,
        class: C2,
        mutation: none,
        origins: [Local],
    },
    /// Set "Reopen server windows when the app starts" (`setReopenServerWindows`). Caller: M.
    ConnectionsRestoreSet => "connections/restore/set" {
        params: ConnectionsRestoreState,
        result: v2::feed::EmptyResult,
        scope: none,
        class: C2,
        mutation: none,
        origins: [Local],
    },
    /// The reopenings still running or failed (`getServerRestoreProgress`). Caller: M.
    ConnectionsRestoreProgress => "connections/restore/progress" {
        params: ConnectionsNoParams,
        result: Vec<ServerRestoreProgress>,
        scope: none,
        class: C2,
        mutation: none,
        origins: [Local],
    },
    /// Where a server window's relay dials the tunnel: its url, token and server instance id. The server token reaches the host. Caller: H.
    ConnectionsEndpoint => "connections/endpoint" {
        params: ConnectionIdParams,
        result: ConnectionEndpoint,
        scope: none,
        class: C2,
        mutation: none,
        origins: [Local],
    },
    /// The saved "Connect to another PC" hosts, `open: false` (the desktop fills it) (`listRemoteHosts`). Caller: H or M.
    RemoteHostsList => "remoteHosts/list" {
        params: ConnectionsNoParams,
        result: Vec<RemoteHost>,
        scope: none,
        class: C2,
        mutation: none,
        origins: [Local],
    },
    /// Redeem the main PC's 6-digit code and save that host (`connectRemoteHostByCode`). Caller: H.
    RemoteHostsRedeemCode => "remoteHosts/redeemCode" {
        params: RemoteHostRedeemParams,
        result: RemoteHost,
        scope: none,
        class: C2,
        mutation: none,
        origins: [Local],
    },
    /// Local name of a saved remote PC (`renameRemoteHost`). Caller: H.
    RemoteHostsRename => "remoteHosts/rename" {
        params: ConnectionsRenameParams,
        result: RemoteHost,
        scope: none,
        class: C2,
        mutation: none,
        origins: [Local],
    },
    /// Forget a saved remote PC and clear its stored pairing (`forgetRemoteHost`). Caller: H.
    RemoteHostsForget => "remoteHosts/forget" {
        params: ConnectionsIdParams,
        result: v2::feed::EmptyResult,
        scope: none,
        class: C2,
        mutation: none,
        origins: [Local],
    },
    /// Which of the saved hosts' desktops are connected to their relay right now. Caller: H.
    RemoteHostsPresence => "remoteHosts/presence" {
        params: RemoteHostPresenceParams,
        result: RemoteHostPresenceResult,
        scope: none,
        class: C2,
        mutation: none,
        origins: [Local],
    },
    /// Enable remote access.
    RemoteAccessSetEnabled => "remoteAccess/setEnabled" {
        params: RemoteAccessSetEnabledParams,
        result: JsonValue,
        scope: global("remoteAccess"),
        class: C2,
        mutation: op(RemoteAccess),
        origins: [Local, Ssh],
    },
    /// Desktop name.
    RemoteAccessSetName => "remoteAccess/setName" {
        params: RemoteAccessSetNameParams,
        result: JsonValue,
        scope: global("remoteAccess"),
        class: C2,
        mutation: op(RemoteAccess),
        origins: [Local, Ssh],
    },
    /// Device alias.
    RemoteAccessSetClientAlias => "remoteAccess/setClientAlias" {
        params: RemoteAccessSetClientAliasParams,
        result: JsonValue,
        scope: global("remoteAccess"),
        class: C2,
        mutation: op(RemoteAccess),
        origins: [Local, Ssh],
    },
    /// Rotate the pairing identity.
    RemoteAccessRotate => "remoteAccess/rotate" {
        params: RemoteAccessRotateParams,
        result: JsonValue,
        scope: global("remoteAccess"),
        class: C2,
        mutation: op(RemoteAccess),
        origins: [Local, Ssh],
    },
    /// Approve or deny a pairing claim.
    RemoteAccessResolveClaim => "remoteAccess/resolveClaim" {
        params: RemoteAccessResolveClaimParams,
        result: JsonValue,
        scope: global("remoteAccess"),
        class: C2,
        mutation: op(RemoteAccess),
        origins: [Local, Ssh],
    },
    /// Request a pairing code.
    RemoteAccessPairCode => "remoteAccess/pairCode" {
        params: RemoteAccessPairCodeParams,
        result: JsonValue,
        scope: global("remoteAccess"),
        class: C2,
        mutation: op(RemoteAccess),
        origins: [Local, Ssh],
    },
    /// Revoke a device.
    RemoteAccessRevokeClient => "remoteAccess/revokeClient" {
        params: RemoteAccessRevokeClientParams,
        result: JsonValue,
        scope: global("remoteAccess"),
        class: C2,
        mutation: op(RemoteAccess),
        origins: [Local, Ssh],
    },
    /// Settle owed controller keys.
    RemoteAccessSettleOwedControllerKeys => "remoteAccess/settleOwedControllerKeys" {
        params: RemoteAccessSettleOwedControllerKeysParams,
        result: JsonValue,
        scope: global("remoteAccess"),
        class: C2,
        mutation: op(RemoteAccess),
        origins: [Local, Ssh],
    },
    /// Deliver a screen controller key.
    RemoteAccessDeliverScreenControllerKey => "remoteAccess/deliverScreenControllerKey" {
        params: RemoteAccessDeliverScreenControllerKeyParams,
        result: JsonValue,
        scope: global("remoteAccess"),
        class: C2,
        mutation: op(RemoteAccess),
        origins: [Local, Ssh, Relay],
    },
    /// Relay Web Push public key.
    RemoteAccessPushPublicKey => "remoteAccess/pushPublicKey" {
        params: RemoteAccessPushPublicKeyParams,
        result: JsonValue,
        scope: none,
        class: C1,
        mutation: none,
        origins: [Local, Ssh, Relay],
    },
    /// Register a Web Push subscription.
    RemoteAccessRegisterPushSubscription => "remoteAccess/registerPushSubscription" {
        params: RemoteAccessRegisterPushSubscriptionParams,
        result: JsonValue,
        scope: global("remoteAccess"),
        class: C2,
        mutation: op(RemoteAccess),
        origins: [Local, Ssh, Relay],
    },
    /// Remove a Web Push subscription.
    RemoteAccessRemovePushSubscription => "remoteAccess/removePushSubscription" {
        params: RemoteAccessRemovePushSubscriptionParams,
        result: JsonValue,
        scope: global("remoteAccess"),
        class: C2,
        mutation: op(RemoteAccess),
        origins: [Local, Ssh, Relay],
    },
    /// Register native push.
    RemoteAccessRegisterNativePush => "remoteAccess/registerNativePush" {
        params: RemoteAccessRegisterNativePushParams,
        result: JsonValue,
        scope: global("remoteAccess"),
        class: C2,
        mutation: op(RemoteAccess),
        origins: [Local, Ssh, Relay],
    },
    /// Remove native push.
    RemoteAccessRemoveNativePush => "remoteAccess/removeNativePush" {
        params: RemoteAccessRemoveNativePushParams,
        result: JsonValue,
        scope: global("remoteAccess"),
        class: C2,
        mutation: op(RemoteAccess),
        origins: [Local, Ssh, Relay],
    },
    /// Activate remote access, an explicit user action (Node `remote.start(true)`), and answer the full `remote` section value as it stands afterwards.
    RemoteAccessActivate => "remoteAccess/activate" {
        params: RemoteAccessActivateParams,
        result: JsonValue,
        scope: global("remoteAccess"),
        class: C2,
        mutation: op(RemoteAccess),
        origins: [Local, Ssh],
    },
    /// The full `remote` section value: the list method of the section when it is published as a stub.
    RemoteAccessState => "remoteAccess/state" {
        params: RemoteAccessStateParams,
        result: JsonValue,
        scope: none,
        class: C1,
        mutation: none,
        origins: [Local, Ssh, Relay],
    },
    /// PC access readiness: the secure-desktop service install state, the paired phones' keys it holds or lacks, and the revocations owed (Node's `PcAccess.readiness`, pc-access.ts). Local only.
    PcAccessReadiness => "pcAccess/readiness" {
        params: v2::pc_access::PcAccessReadinessParams,
        result: v2::pc_access::PcAccessReadiness,
        scope: none,
        class: C2,
        mutation: none,
        origins: [Local],
    },
    /// PC access Approve: one UAC install-or-enroll of every paired phone's key, applying the owed revocations in the same call (Node's `PcAccess.approve`, pc-access.ts). Local only.
    PcAccessApprove => "pcAccess/approve" {
        params: v2::pc_access::PcAccessApproveParams,
        result: v2::pc_access::PcAccessApproval,
        scope: none,
        class: C2,
        mutation: none,
        origins: [Local],
    },
    /// The desktop-profile move's state: its generation, and the profile directory the core has recorded (Local only).
    MigrateProfileStatus => "migrate/profile/status" {
        params: v2::migrate_profile::MigrateProfileStatusParams,
        result: v2::migrate_profile::MigrateProfileStatus,
        scope: none,
        class: C2,
        mutation: none,
        origins: [Local],
    },
    /// Adopts the Electron profile for a core started without it: moves the profile files of generation 2 into the data dir (idempotent; only the profile recorded already may be named again). Local only.
    MigrateProfileAdopt => "migrate/profile/adopt" {
        params: v2::migrate_profile::MigrateProfileAdoptParams,
        result: v2::migrate_profile::MigrateProfileAdopted,
        scope: none,
        class: C2,
        mutation: none,
        origins: [Local],
    },
    /// The absolute host path a conversation link's href names (decoded as MarkdownLink decodes it, `:line`/`#L` dropped, relative to the session's folder); `path` is null for a web link, a UNC target or a relative link with no folder.
    DesktopLinkResolve => "desktop/link/resolve" {
        params: DesktopLinkResolveParams,
        result: JsonValue,
        scope: none,
        class: C1,
        mutation: none,
        origins: [Local, Ssh, Relay],
    },
    /// The same resolution for an already decoded path (`resolveLinkedPath`).
    DesktopLinkResolvePath => "desktop/link/resolvePath" {
        params: DesktopLinkResolvePathParams,
        result: JsonValue,
        scope: none,
        class: C1,
        mutation: none,
        origins: [Local, Ssh, Relay],
    },
    /// An attachment of a session by content hash: served only when THIS session's transcript (the window, else the whole stored conversation) names the id and the stored bytes hash to it. Refusals carry code `file-download:not-linked`, `file-download:not-found` or `file-download:changed`.
    DesktopAttachmentResolve => "desktop/attachment/resolve" {
        params: DesktopAttachmentParams,
        result: JsonValue,
        scope: none,
        class: C1,
        mutation: none,
        origins: [Local, Ssh, Relay],
    },
    /// The same check, then the bytes written to `<temp>/mixdog-attachments/<id16>-<name>` on the PC; answers the path.
    DesktopAttachmentStage => "desktop/attachment/stage" {
        params: DesktopAttachmentParams,
        result: JsonValue,
        scope: none,
        class: C1,
        mutation: none,
        origins: [Local, Ssh, Relay],
    },
    /// The object a JSONC settings file holds; `config` is null when the file is missing, empty or NUL-filled.
    DesktopWorkflowConfigRead => "desktop/workflowConfig/read" {
        params: DesktopWorkflowConfigReadParams,
        result: JsonValue,
        scope: none,
        class: C1,
        mutation: none,
        origins: [Local],
    },
    /// The installed font families of the PC (one OS listing per process, cached); an empty list when the OS cannot list them.
    DesktopFontsList => "desktop/fonts/list" {
        params: DesktopFontsListParams,
        result: JsonValue,
        scope: none,
        class: C1,
        mutation: none,
        origins: [Local, Ssh, Relay],
    },
    /// The desktop pet's per-device settings (desktop-pet-store.ts `readDesktopPetPrefs`), every field normalized: anything malformed reads as the default for that field. The first read of a data dir without the file copies the profile's `desktop-pet.json` once.
    DesktopPetStateRead => "desktopPet/state/read" {
        params: v2::desktop_pet::DesktopPetStateReadParams,
        result: v2::desktop_pet::DesktopPetPrefs,
        scope: none,
        class: C2,
        mutation: none,
        origins: [Local],
    },
    /// Stores the pet's settings (`writeDesktopPetPrefs`): the given document is normalized as a read does, written atomically and announced to every client as `desktopPet/state/changed`. Answers what was stored.
    DesktopPetStateWrite => "desktopPet/state/write" {
        params: v2::desktop_pet::DesktopPetStateWriteParams,
        result: v2::desktop_pet::DesktopPetPrefs,
        scope: none,
        class: C2,
        mutation: none,
        origins: [Local],
    },
    /// One of the rules that place the desktop pet's window (desktop-pet-store.ts: `desktopPetGeometry`, `pinnedPetPosition`, `clampPetPosition`, `clampFreePetPosition`, `petHereAnchor`, `petHerePosition`, `displayForPetPosition`, `petPositionOn`), named by `op`, over the rectangles and displays the window controller read from Electron. Answers a point, an anchor, a display id (null for none) or the geometry.
    DesktopPetPlacementResolve => "desktopPet/placement/resolve" {
        params: v2::desktop_pet::DesktopPetPlacementResolveParams,
        result: JsonValue,
        scope: none,
        class: C2,
        mutation: none,
        origins: [Local],
    },
    /// UI-originated in-app browser control; forwarded as `host/browser/command`.
    BrowserCommand => "browser/command" {
        params: BrowserCommandParams,
        result: JsonValue,
        scope: none,
        class: C2,
        mutation: none,
        origins: [Local, Ssh, Relay],
    },
    /// UI-originated visualize command and pane reads; forwarded as `host/visualize/command`.
    VisualizeCommand => "visualize/command" {
        params: VisualizeCommandParams,
        result: JsonValue,
        scope: none,
        class: C2,
        mutation: none,
        origins: [Local, Ssh, Relay],
    },
    /// The Computer Use pill's Resume or Stop (Node's coordinator `resumeAfterUserTakeover`, the pill's Stop).
    ComputerUserControl => "computer/userControl" {
        params: v2::host::ComputerUserControlParams,
        result: v2::host::ComputerUserControlResult,
        scope: none,
        class: C2,
        mutation: none,
        origins: [Local, Ssh],
    },
    /// One Computer Use command through the live helper pool outside a model turn (test hook: served only by a `test-hooks` build started with MIXDOGD_TEST_HOOKS=1; the handler calls DevComputerRunParams::validate).
    DevComputerRun => "dev/computer/run" {
        params: v2::computer_host::DevComputerRunParams,
        result: v2::computer_host::DevComputerRunResult,
        scope: none,
        class: C2,
        mutation: none,
        origins: [Local],
    },
    /// Today's `sendTestNotification`.
    NotifyTest => "notify/test" {
        params: NotifyTestParams,
        result: JsonValue,
        scope: none,
        class: C2,
        mutation: op(Notify),
        origins: [Local, Ssh, Relay],
    },
    /// What Settings › Notifications reads besides the sections: whether this PC shows OS notifications (the desktop host's
    /// `host/notification/status`, false with no host: Node asked its window at each read, desktop-service.ts:866) and the
    /// stored notification document after the default of this PC and of every paired device without stored preferences was
    /// written (Node's `notificationPreferencesState` wrote them, notification-preferences.ts `withDefaults`).
    NotifyState => "notify/state" {
        params: NotifyStateParams,
        result: NotifyStateResult,
        scope: none,
        class: C2,
        mutation: none,
        origins: [Local, Ssh, Relay],
    },
    /// Node's `notifySettingsChanged(scope)` (desktop-operations.ts:459-464): open settings pages on every client re-read.
    /// Published to every client as `ui/settings/changed`. The desktop's alone: Node's relay methods had no such call (a
    /// phone's own setting write announces through `config/value/write`'s `announce`).
    UiSettingsAnnounce => "ui/settings/announce" {
        params: v2::config::UiSettingsChangedParams,
        result: v2::feed::EmptyResult,
        scope: none,
        class: C2,
        mutation: none,
        origins: [Local, Ssh],
    },
    /// Node's `notifyProviderModelsChanged(origin)` (desktop-operations.ts:455-458, relay remote-methods.ts:916-917): every
    /// client drops its provider model lists. Published to every client, the caller included, as `ui/providerModels/changed`.
    /// The only input rule is Node's `requiredString(origin, 'origin', 128)`.
    UiProviderModelsAnnounce => "ui/providerModels/announce" {
        params: v2::config::UiProviderModelsChangedParams,
        result: v2::feed::EmptyResult,
        scope: none,
        class: C2,
        mutation: none,
        origins: [Local, Ssh, Relay],
    },
    /// Claim the desktop host role.
    HostClaim => "host/claim" {
        params: v2::host::HostClaimParams,
        result: v2::feed::EmptyResult,
        scope: global("host"),
        class: C2,
        mutation: none,
        origins: [Local, Ssh],
    },
    /// Publish desktop-owned state into section `hostState`.
    HostStateSet => "host/state/set" {
        params: v2::host::HostStateSetParams,
        result: v2::feed::EmptyResult,
        scope: global("host"),
        class: C2,
        mutation: none,
        origins: [Local, Ssh],
    },
    /// Bridge phone connections to an SSH server core (R25).
    HostRemoteTargetSet => "host/remoteTarget/set" {
        params: v2::host::HostRemoteTargetSetParams,
        result: v2::feed::EmptyResult,
        scope: global("host"),
        class: C2,
        mutation: none,
        origins: [Local, Ssh],
    },
    /// Hold the core's Computer Use for a human-only dialog; answered once its running operations ended.
    HostHumanOnlyBegin => "host/humanOnly/begin" {
        params: v2::host::HostHumanOnlyBeginParams,
        result: v2::host::HostHumanOnlyBeginResult,
        scope: none,
        class: C2,
        mutation: none,
        origins: [Local, Ssh],
    },
    /// End a hold of `host/humanOnly/begin`.
    HostHumanOnlyEnd => "host/humanOnly/end" {
        params: v2::host::HostHumanOnlyEndParams,
        result: v2::feed::EmptyResult,
        scope: none,
        class: C2,
        mutation: none,
        origins: [Local, Ssh],
    },
    /// Whether the person may act on takeover `takeoverId` of session `sessionId`: answered once its commands drained, `false` when it ends first or is never seen (the core's takeover owner, Node's `takeoverReady`).
    TakeoverReady => "takeover/ready" {
        params: v2::takeover::TakeoverReadyParams,
        result: v2::takeover::TakeoverReadyResult,
        scope: none,
        class: C2,
        mutation: none,
        origins: [Local, Ssh],
    },
    /// Run one `browser` or `browser_devtools` tool call through the Rust engine (test hook, MIXDOGD_TEST_HOOKS=1 only).
    TestBrowserEngineRun => "test/browserEngine/run" {
        params: BrowserEngineTestRunParams,
        result: BrowserEngineTestRunResult,
        scope: none,
        class: C2,
        mutation: none,
        origins: [Local],
    },
    /// A paired phone's WebRTC live-view signal (Node's `browserRemoteWebrtcSignal` relay call).
    /// The reply settles once every signal it caused was pushed (`browser/webrtcSignal`).
    BrowserWebrtcSignal => "browser/webrtcSignal" {
        params: v2::host::BrowserWebrtcSignalParams,
        result: v2::feed::EmptyResult,
        scope: none,
        class: C2,
        mutation: none,
        origins: [Relay],
    },
    /// A phone starts or stops streaming a browser session (Node's `browserRemoteStream`).
    BrowserStream => "browser/stream" {
        params: v2::host::BrowserStreamParams,
        result: v2::feed::EmptyResult,
        scope: none,
        class: C2,
        mutation: none,
        origins: [Relay],
    },
    /// The displays a granted phone may choose for the remote screen (Node's
    /// `browserRemoteScreenDisplays`): `RemoteScreenDisplaySummary[]` from the host.
    BrowserScreenDisplays => "browser/screenDisplays" {
        params: v2::host::ScreenDisplaysParams,
        result: JsonValue,
        scope: none,
        class: C2,
        mutation: none,
        origins: [Relay],
    },
    /// Run a proxied model call for a server core; events as `modelProxy/run/event`.
    ModelProxyRun => "modelProxy/run" {
        params: v2::host::ModelProxyRunParams,
        result: v2::host::ModelProxyResult,
        scope: none,
        class: C2,
        mutation: none,
        origins: [Local, Ssh],
    },
}
