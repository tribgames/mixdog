// Generated from the Rust crates mixdog-protocol and mixdog-app-protocol
// (cargo test -p mixdog-app-protocol with MIXDOG_UPDATE_PROTOCOL_GOLDEN=1). Do not edit.

/**
 * Params of `account/authenticateProvider`.
 */
export type AccountAuthenticateProviderParams = { opId: OpId, threadId?: ThreadId, providerId: string, secret: string, };

/**
 * Params of `account/beginOAuthProviderLogin`.
 */
export type AccountBeginOAuthProviderLoginParams = { opId: OpId, threadId?: ThreadId, providerId: string, options?: JsonValue, };

/**
 * Params of `account/cancelOAuthProviderLogin`.
 */
export type AccountCancelOAuthProviderLoginParams = { opId: OpId, threadId?: ThreadId, flowId: LoginFlowId, };

/**
 * Params of `account/checkCustomProviderKeyEnv`.
 */
export type AccountCheckCustomProviderKeyEnvParams = { opId: OpId, threadId?: ThreadId, name: string, };

/**
 * Params of `account/completeOAuthProviderLogin`.
 */
export type AccountCompleteOAuthProviderLoginParams = { opId: OpId, threadId?: ThreadId, flowId: LoginFlowId, callbackUrl: string, };

/**
 * Params of `account/consumeCodexRateLimitResetCredit`.
 */
export type AccountConsumeCodexRateLimitResetCreditParams = { opId: OpId, threadId?: ThreadId, options?: JsonValue, };

/**
 * Params of `account/discoverCustomProviderModels`.
 */
export type AccountDiscoverCustomProviderModelsParams = { opId: OpId, threadId?: ThreadId, input: JsonValue, };

/**
 * Params of `account/forgetProviderAuth`.
 */
export type AccountForgetProviderAuthParams = { opId: OpId, threadId?: ThreadId, providerId: string, accountId?: string, };

/**
 * Params of `account/getOAuthProviderLoginStatus`.
 */
export type AccountGetOAuthProviderLoginStatusParams = { threadId?: ThreadId, flowId: LoginFlowId, };

/**
 * Params of `account/getQuotaHistory`.
 */
export type AccountGetQuotaHistoryParams = { threadId?: ThreadId, options?: JsonValue, };

/**
 * Params of `account/listWebSearchModels`.
 */
export type AccountListWebSearchModelsParams = { threadId?: ThreadId, options?: JsonValue, };

/**
 * Params of `account/loginOAuthProvider`.
 */
export type AccountLoginOAuthProviderParams = { opId: OpId, threadId?: ThreadId, providerId: string, };

/**
 * Params of `account/refreshProviderSetup`.
 */
export type AccountRefreshProviderSetupParams = { opId: OpId, force?: boolean, refresh?: boolean, unlockKeychain?: boolean, recheckKeychain?: boolean, };

/**
 * Params of `account/removeCustomProvider`.
 */
export type AccountRemoveCustomProviderParams = { opId: OpId, threadId?: ThreadId, providerId: string, };

/**
 * Params of `account/saveCustomProviderKey`.
 */
export type AccountSaveCustomProviderKeyParams = { opId: OpId, threadId?: ThreadId, providerId: string, secret: string, };

/**
 * Params of `account/saveCustomProvider`.
 */
export type AccountSaveCustomProviderParams = { opId: OpId, threadId?: ThreadId, input: JsonValue, };

/**
 * Params of `account/saveOpenAIUsageSessionKey`.
 */
export type AccountSaveOpenAIUsageSessionKeyParams = { opId: OpId, threadId?: ThreadId, secret: string, };

/**
 * Params of `account/saveProviderApiKey`.
 */
export type AccountSaveProviderApiKeyParams = { opId: OpId, threadId?: ThreadId, providerId: string, secret: string, options?: JsonValue, };

/**
 * Params of `account/testCustomProvider`.
 */
export type AccountTestCustomProviderParams = { opId: OpId, threadId?: ThreadId, input: JsonValue, };

/**
 * Params of `account/updateCustomProviderModel`.
 */
export type AccountUpdateCustomProviderModelParams = { opId: OpId, threadId?: ThreadId, providerId: string, modelId: string, patch: JsonValue, };

/**
 * Params of `account/updateProviderAccounts`.
 */
export type AccountUpdateProviderAccountsParams = { opId: OpId, threadId?: ThreadId, providerId: string, change: JsonValue, };

/**
 * What a registered unit of work is. The first five make a stop wait; the last three only
 * keep an unattended core alive.
 */
export type ActivityKind = "turn" | "approvalWait" | "subAgent" | "scheduledRun" | "backgroundShell" | "goal" | "schedule" | "channel";

/**
 * Params of `agent/agentDefinitionPresence`.
 */
export type AgentAgentDefinitionPresenceParams = { threadId?: ThreadId, agentIds: Array<string>, };

/**
 * Params of `agent/archivedAgentIdentities`.
 */
export type AgentArchivedAgentIdentitiesParams = { threadId?: ThreadId, agentIds: Array<string>, };

/**
 * Params of `agent/deleteAgentDefinition`.
 */
export type AgentDeleteAgentDefinitionParams = { opId: OpId, threadId?: ThreadId, agentId: string, };

/**
 * Params of `agent/getAgentAlwaysAllowedTools`.
 */
export type AgentGetAgentAlwaysAllowedToolsParams = { threadId?: ThreadId, agentId: string, };

/**
 * Params of `agent/getAgentAvatarImage`.
 */
export type AgentGetAgentAvatarImageParams = { threadId?: ThreadId, agentId: string, };

/**
 * Params of `agent/getAgentConnectorTools`.
 */
export type AgentGetAgentConnectorToolsParams = { threadId?: ThreadId, agentId: string, };

/**
 * Params of `agent/getAgentConnectors`.
 */
export type AgentGetAgentConnectorsParams = { threadId?: ThreadId, agentId: string, };

/**
 * Params of `agent/getAgentDefinition`.
 */
export type AgentGetAgentDefinitionParams = { threadId?: ThreadId, agentId: string, };

/**
 * Params of `agent/getAgentPermissions`.
 */
export type AgentGetAgentPermissionsParams = { threadId?: ThreadId, agentId: string, };

/**
 * Params of `agent/getLeadAgentBody`.
 */
export type AgentGetLeadAgentBodyParams = { threadId?: ThreadId, };

/**
 * Params of `agent/getLeadAppearance`.
 */
export type AgentGetLeadAppearanceParams = { threadId?: ThreadId, };

/**
 * Params of `agent/getLeadHomeRoute`.
 */
export type AgentGetLeadHomeRouteParams = { threadId?: ThreadId, };

/**
 * Params of `agent/getLeadPersona`.
 */
export type AgentGetLeadPersonaParams = { threadId?: ThreadId, };

/**
 * Params of `agent/getLeadStatus`.
 */
export type AgentGetLeadStatusParams = { threadId?: ThreadId, };

/**
 * Params of `agent/home/open`.
 */
export type AgentHomeOpenParams = { opId: OpId, agentId: string, };

/**
 * Params of `agent/home/reset`.
 */
export type AgentHomeResetParams = { opId: OpId, agentId: string, };

/**
 * Params of `agent/memory/delete`.
 */
export type AgentMemoryDeleteParams = { opId: OpId, agentId: string, entryId: string, indexRevision: JsonValue, };

/**
 * Params of `agent/memory/list`.
 */
export type AgentMemoryListParams = { agentId: string, };

/**
 * Params of `agent/pool/list`.
 */
export type AgentPoolListParams = Record<string, never>;

/**
 * Params of `agent/purgeAgentDefinition`.
 */
export type AgentPurgeAgentDefinitionParams = { opId: OpId, threadId?: ThreadId, agentId: string, };

/**
 * Params of `agent/recordAgentApprovalAudit`.
 */
export type AgentRecordAgentApprovalAuditParams = { opId: OpId, threadId?: ThreadId, agentId: string, action: string, decision: string, };

/**
 * Params of `agent/restoreAgentDefinition`.
 */
export type AgentRestoreAgentDefinitionParams = { opId: OpId, threadId?: ThreadId, agentId: string, };

/**
 * Params of `agent/saveAgentDefinition`.
 */
export type AgentSaveAgentDefinitionParams = { opId: OpId, threadId?: ThreadId, payload: JsonValue, options?: JsonValue, };

/**
 * Params of `agent/saveLeadAgentBody`.
 */
export type AgentSaveLeadAgentBodyParams = { opId: OpId, threadId?: ThreadId, text: string, };

/**
 * Params of `agent/saveLeadIdentity`.
 */
export type AgentSaveLeadIdentityParams = { opId: OpId, threadId?: ThreadId, payload: JsonValue, };

/**
 * Params of `agent/saveLeadPersona`.
 */
export type AgentSaveLeadPersonaParams = { opId: OpId, threadId?: ThreadId, text: string, };

/**
 * Params of `agent/setAgentConnectorEnabled`.
 */
export type AgentSetAgentConnectorEnabledParams = { opId: OpId, threadId?: ThreadId, agentId: string, connectorId: string, enabled: boolean, options?: JsonValue, };

/**
 * Params of `agent/setAgentConnectorToolPermission`.
 */
export type AgentSetAgentConnectorToolPermissionParams = { opId: OpId, threadId?: ThreadId, agentId: string, connectorId: string, toolName: string, permission: JsonValue, options?: JsonValue, };

/**
 * Params of `agent/setAgentConnectors`.
 */
export type AgentSetAgentConnectorsParams = { opId: OpId, threadId?: ThreadId, agentId: string, connectors: JsonValue, options?: JsonValue, };

/**
 * Params of `agent/setAgentPermission`.
 */
export type AgentSetAgentPermissionParams = { opId: OpId, threadId?: ThreadId, agentId: string, action: string, mode: string, options?: JsonValue, };

/**
 * Params of `agent/setLeadAppearance`.
 */
export type AgentSetLeadAppearanceParams = { opId: OpId, threadId?: ThreadId, avatar: JsonValue, };

/**
 * Params of `agent/setLeadCreated`.
 */
export type AgentSetLeadCreatedParams = { opId: OpId, threadId?: ThreadId, created: boolean, description?: string, };

/**
 * One category entry of an aggregate tool card header (`categories` / `doneCategories`).
 */
export type AggregateCategory = { key: string, category: string, active: string, done: string, noun: string, pluralNoun: string, effect: boolean, count: number, };

/**
 * `app/snapshot`: every unkeyed app section plus keyed sections bounded by
 * configuration (SPEC R14). Replaces the whole section store.
 */
export type AppSnapshotParams = { sections: Array<SectionUpdate>, };

export type AppSubscribeParams = { resumeFrom?: FeedPosition, };

export type AppSubscribeResponse = { subscription: Subscription, };

/**
 * Node accepts only `implicit`; anything else means none.
 */
export type ApprovalMode = "implicit";

/**
 * Secret answer of a human-gate `provide-secret` request (today's `provideSecretInput`);
 * never part of a decision or a log record.
 */
export type ApprovalProvideSecretParams = { opId: OpId, requestId: RequestId, secret: string, };

export type ApprovalRemember = "once" | "session" | "agent" | "always";

/**
 * Durable outcome of a server request (P §8.4).
 */
export type ApprovalResolution = { "kind": "decided", decision: ToolApprovalDecision, device: string, connectionKind: ConnectionKind, at: number, } | { "kind": "timedOut", at: number, } | { "kind": "interrupted", at: number, } | { "kind": "cancelled", at: number, } | { "kind": "withdrawn", at: number, } | { "kind": "unavailable", at: number, };

export type AttachmentKind = "image" | "file" | "text";

/**
 * The picked file behind a resized image: its blob is kept while the record exists.
 */
export type AttachmentOriginal = { attachmentRef: string, mimeType: string, };

export type AutoEffortBase = "low" | "medium" | "high";

export type AutoEffortModule = { supported: boolean, enabled: boolean,
/**
 * The judge model is on disk.
 */
installed: boolean,
/**
 * A download is in flight, including the boot download the settings did not start.
 */
installing: boolean, ready: boolean,
/**
 * Why the judge last failed to load; empty when it loaded or never failed.
 */
lastError: string, info: EffortJudgeInfo, };

/**
 * Server-produced and embedded in store records, which parse it strictly.
 */
export type BlobDescriptor = { digest: BlobDigest, bytes: number, mediaType: string, };

/**
 * Content digest `sha256:<64 lowercase hex>`.
 */
export type BlobDigest = string;

/**
 * One upload chunk; raw chunk ≤ `limits.maxBlobPutChunkBytes`. The blob is
 * complete when the bytes received hash to `digest`.
 */
export type BlobPutParams = { digest: BlobDigest, offset: number, bytesB64: string, };

export type BlobReadParams = { digest: BlobDigest, offset?: number,
/**
 * At most `limits.maxBlobPageBytes`.
 */
length?: number, };

export type BlobReadResponse = { bytesB64: string, };

/**
 * `{"blob":{"digest":"sha256:…","bytes":n,"mediaType":"…"}}`.
 */
export type BlobRef = { blob: BlobDescriptor, };

/**
 * The one bot order (Lead and Sessions bot lists): trimmed, de-duplicated agent ids, at most
 * 500. Mixy is pinned first by the UI and is not part of it. Empty means no stored order.
 * Result of `config/getBotOrder` and `config/setBotOrder`.
 */
export type BotOrder = { order: Array<string>, };

export type BrowserApprovalRequestParams = {
/**
 * Form submit / Enter, send/post click, upload, … (policy is the core's).
 */
action: string, request: JsonValue, threadId: ThreadId, turnId?: TurnId, itemId?: ItemId,
/**
 * Top-level chat that shows a sub-agent's request.
 */
surfaceThreadId?: ThreadId,
/**
 * Delegation chain from the surface thread to the asking thread.
 */
chain?: Array<ThreadId>, requestedAt: number, expiresAt?: number,
/**
 * Per-surface presentation order; the lowest is the active card (P §8.5).
 */
order: number, };

/**
 * Params of `browser/command`.
 */
export type BrowserCommandParams = { action: string, input?: JsonValue, };

export type CapabilityState = { "state": "available" } | { "state": "unavailable", detail: string, };

/**
 * Channel-bridge tool call (today's channel `POST /call`).
 */
export type ChannelCallParams = {
/**
 * Today's `callId`.
 */
opId: OpId, name: string, args: JsonValue, };

/**
 * Params of `channel/deleteSchedule`.
 */
export type ChannelDeleteScheduleParams = { opId: OpId, threadId?: ThreadId, name: string, };

/**
 * Params of `channel/deleteWebhook`.
 */
export type ChannelDeleteWebhookParams = { opId: OpId, threadId?: ThreadId, name: string, };

/**
 * Params of `channel/getChannelSettings`.
 */
export type ChannelGetChannelSettingsParams = { threadId?: ThreadId, options?: JsonValue, };

/**
 * Params of `channel/getChannelSetup`.
 */
export type ChannelGetChannelSetupParams = { threadId?: ThreadId, };

/**
 * Params of `channel/getChannelWorkerStatus`.
 */
export type ChannelGetChannelWorkerStatusParams = { threadId?: ThreadId, };

/**
 * Params of `channel/retryRoutineDelivery`.
 */
export type ChannelRetryRoutineDeliveryParams = { opId: OpId, threadId?: ThreadId, kind: string, name: string, };

/**
 * Params of `channel/runScheduleNow`.
 */
export type ChannelRunScheduleNowParams = { opId: OpId, threadId?: ThreadId, name: string, };

/**
 * Params of `channel/runWebhookNow`.
 */
export type ChannelRunWebhookNowParams = { opId: OpId, threadId?: ThreadId, name: string, };

/**
 * Params of `channel/saveSchedule`.
 */
export type ChannelSaveScheduleParams = { opId: OpId, threadId?: ThreadId, entry: JsonValue, };

/**
 * Params of `channel/saveWebhook`.
 */
export type ChannelSaveWebhookParams = { opId: OpId, threadId?: ThreadId, entry: JsonValue, };

/**
 * Params of `channel/setScheduleEnabled`.
 */
export type ChannelSetScheduleEnabledParams = { opId: OpId, threadId?: ThreadId, name: string, enabled: boolean, };

/**
 * Params of `channel/setWebhookConfig`.
 */
export type ChannelSetWebhookConfigParams = { opId: OpId, threadId?: ThreadId, patch: JsonValue, };

/**
 * Params of `channel/setWebhookEnabled`.
 */
export type ChannelSetWebhookEnabledParams = { opId: OpId, threadId?: ThreadId, name: string, enabled: boolean, };

/**
 * Params of `channel/testWebhook`.
 */
export type ChannelTestWebhookParams = { opId: OpId, threadId?: ThreadId, name: string, };

export type ClassLimits = { c0: number, c1: number, c2: number, c3: number, };

/**
 * `client/activity`: sent on user input, at most once per 60 s (client-side rate).
 */
export type ClientActivityParams = { at: number, };

export type ClientInfo = { name: string, title?: string,
/**
 * Must equal the core's `serverVersion` (version gate, no ranges).
 */
version: string, kind: ConnectionKind, build?: string, };

/**
 * Client notifications (X11): they take no in-flight slot.
 */
export type ClientNotification = { "method": "initialized" } | { "method": "terminal/input", "params": TerminalInputParams } | { "method": "terminal/resize", "params": TerminalResizeParams } | { "method": "process/input", "params": ProcessInputParams } | { "method": "client/activity", "params": ClientActivityParams } | { "method": "client/perfLog", "params": ClientPerfLogParams } | { "method": "host/power", "params": HostPowerParams } | { "method": "host/update/report", "params": HostUpdateReportParams } | { "method": "host/browser/surface", "params": HostBrowserSurfaceParams } | { "method": "host/notification/clicked", "params": HostNotificationClickedParams } | { "method": "model/proxy/event", "params": ModelProxyEventParams } | { "method": "model/proxy/heartbeat", "params": ModelProxyHeartbeatParams } | { "method": "modelProxy/cancel", "params": ModelProxyRunCancelParams } | { "method": "ui/newTab/created", "params": UiNewTabCreatedParams } | { "method": "ui/terminalRun/claimed", "params": UiTerminalRunClaimedParams } | { "method": "ui/screenSessions/changed", "params": UiScreenSessionsChangedParams };

export type ClientPerfLogParams = { line: string, };

/**
 * Request from a client to the core.
 */
export type ClientRequest = { "method": "initialize", id: RequestId, params: InitializeParams, } | { "method": "app/subscribe", id: RequestId, params: AppSubscribeParams, } | { "method": "feed/subscribe", id: RequestId, params: FeedSubscribeParams, } | { "method": "feed/unsubscribe", id: RequestId, params: FeedUnsubscribeParams, } | { "method": "op/status", id: RequestId, params: OpStatusParams, } | { "method": "blob/read", id: RequestId, params: BlobReadParams, } | { "method": "blob/put", id: RequestId, params: BlobPutParams, } | { "method": "model/list", id: RequestId, params: ModelListParams, } | { "method": "feedback/upload", id: RequestId, params: FeedbackUploadParams, } | { "method": "approval/provideSecret", id: RequestId, params: ApprovalProvideSecretParams, } | { "method": "channel/call", id: RequestId, params: ChannelCallParams, } | { "method": "route/set", id: RequestId, params: RouteSetParams, } | { "method": "fast/set", id: RequestId, params: FastSetParams, } | { "method": "thread/start", id: RequestId, params: ThreadStartParams, } | { "method": "thread/resume", id: RequestId, params: ThreadResumeParams, } | { "method": "thread/unsubscribe", id: RequestId, params: ThreadIdParams, } | { "method": "thread/list", id: RequestId, params: ThreadListParams, } | { "method": "thread/read", id: RequestId, params: ThreadReadParams, } | { "method": "thread/turns/list", id: RequestId, params: ThreadTurnsListParams, } | { "method": "thread/items/list", id: RequestId, params: ThreadItemsListParams, } | { "method": "thread/items/read", id: RequestId, params: ThreadItemsReadParams, } | { "method": "thread/attachment/list", id: RequestId, params: ThreadPageParams, } | { "method": "thread/modelMessages/list", id: RequestId, params: ThreadModelMessagesListParams, } | { "method": "thread/finalAnswer/read", id: RequestId, params: ThreadFinalAnswerReadParams, } | { "method": "thread/readState/update", id: RequestId, params: ThreadReadStateUpdateParams, } | { "method": "thread/search", id: RequestId, params: ThreadSearchParams, } | { "method": "thread/name/set", id: RequestId, params: ThreadNameSetParams, } | { "method": "thread/metadata/update", id: RequestId, params: ThreadMetadataUpdateParams, } | { "method": "thread/archive", id: RequestId, params: ThreadOpParams, } | { "method": "thread/unarchive", id: RequestId, params: ThreadOpParams, } | { "method": "thread/delete", id: RequestId, params: ThreadDeleteParams, } | { "method": "thread/fork", id: RequestId, params: ThreadForkParams, } | { "method": "thread/continueInModel", id: RequestId, params: ThreadContinueInModelParams, } | { "method": "thread/rewind", id: RequestId, params: ThreadRewindParams, } | { "method": "thread/clear", id: RequestId, params: ThreadClearParams, } | { "method": "thread/compact/start", id: RequestId, params: ThreadCompactStartParams, } | { "method": "thread/queue/delete", id: RequestId, params: ThreadQueueDeleteParams, } | { "method": "thread/goal/set", id: RequestId, params: ThreadGoalSetParams, } | { "method": "thread/goal/clear", id: RequestId, params: ThreadOpParams, } | { "method": "thread/goal/control", id: RequestId, params: ThreadGoalControlParams, } | { "method": "thread/quotaResume/schedule", id: RequestId, params: ThreadOpParams, } | { "method": "thread/quotaResume/cancel", id: RequestId, params: ThreadOpParams, } | { "method": "thread/backgroundTerminals/terminate", id: RequestId, params: ThreadBackgroundTerminalParams, } | { "method": "thread/backgroundTerminals/release", id: RequestId, params: ThreadBackgroundTerminalParams, } | { "method": "thread/backgroundTerminals/clean", id: RequestId, params: ThreadOpParams, } | { "method": "turn/start", id: RequestId, params: TurnStartParams, } | { "method": "turn/interrupt", id: RequestId, params: TurnInterruptParams, } | { "method": "turn/steer", id: RequestId, params: TurnSteerParams, } | { "method": "turn/retryFailed", id: RequestId, params: TurnRetryFailedParams, } | { "method": "thread/contextStatus", id: RequestId, params: ThreadContextStatusParams, } | { "method": "thread/getSessionUsage", id: RequestId, params: ThreadGetSessionUsageParams, } | { "method": "thread/getSessionWorktreeWork", id: RequestId, params: ThreadGetSessionWorktreeWorkParams, } | { "method": "thread/inheritancePreflight", id: RequestId, params: ThreadInheritancePreflightParams, } | { "method": "thread/listShellJobs", id: RequestId, params: ThreadListShellJobsParams, } | { "method": "thread/listStoppableShellJobs", id: RequestId, params: ThreadListStoppableShellJobsParams, } | { "method": "thread/getBranchMenu", id: RequestId, params: ThreadGetBranchMenuParams, } | { "method": "thread/askSide", id: RequestId, params: ThreadAskSideParams, } | { "method": "thread/cancelSide", id: RequestId, params: ThreadCancelSideParams, } | { "method": "thread/agentControl", id: RequestId, params: ThreadAgentControlParams, } | { "method": "thread/switchContext", id: RequestId, params: ThreadSwitchContextParams, } | { "method": "thread/setCwd", id: RequestId, params: ThreadSetCwdParams, } | { "method": "thread/setEffort", id: RequestId, params: ThreadSetEffortParams, } | { "method": "thread/setToolMode", id: RequestId, params: ThreadSetToolModeParams, } | { "method": "thread/setWorkflow", id: RequestId, params: ThreadSetWorkflowParams, } | { "method": "thread/setOrchestrationMode", id: RequestId, params: ThreadSetOrchestrationModeParams, } | { "method": "thread/setOutputStyle", id: RequestId, params: ThreadSetOutputStyleParams, } | { "method": "thread/revertTurnReview", id: RequestId, params: ThreadRevertTurnReviewParams, } | { "method": "thread/revertTurnReviewFile", id: RequestId, params: ThreadRevertTurnReviewFileParams, } | { "method": "thread/revertTurnChanges", id: RequestId, params: ThreadRevertTurnChangesParams, } | { "method": "thread/reapplyTurnChanges", id: RequestId, params: ThreadReapplyTurnChangesParams, } | { "method": "thread/clearSessionChangeHistory", id: RequestId, params: ThreadClearSessionChangeHistoryParams, } | { "method": "thread/stageAttachmentOriginal", id: RequestId, params: ThreadStageAttachmentOriginalParams, } | { "method": "thread/resizeImage", id: RequestId, params: ThreadResizeImageParams, } | { "method": "thread/pushNotice", id: RequestId, params: ThreadPushNoticeParams, } | { "method": "thread/requestWorktree", id: RequestId, params: ThreadRequestWorktreeParams, } | { "method": "thread/mergeWorkspace", id: RequestId, params: ThreadMergeWorkspaceParams, } | { "method": "thread/selectBranch", id: RequestId, params: ThreadSelectBranchParams, } | { "method": "project/inspectProjectBranch", id: RequestId, params: ProjectInspectProjectBranchParams, } | { "method": "project/getProjectBranchMenu", id: RequestId, params: ProjectGetProjectBranchMenuParams, } | { "method": "project/getProjectConnectors", id: RequestId, params: ProjectGetProjectConnectorsParams, } | { "method": "project/listWorktrees", id: RequestId, params: ProjectListWorktreesParams, } | { "method": "project/previewWorktreeCleanup", id: RequestId, params: ProjectPreviewWorktreeCleanupParams, } | { "method": "project/selectProjectBranch", id: RequestId, params: ProjectSelectProjectBranchParams, } | { "method": "project/mergeProjectBranch", id: RequestId, params: ProjectMergeProjectBranchParams, } | { "method": "project/manageProjectBranch", id: RequestId, params: ProjectManageProjectBranchParams, } | { "method": "project/removeWorktree", id: RequestId, params: ProjectRemoveWorktreeParams, } | { "method": "project/pruneWorktrees", id: RequestId, params: ProjectPruneWorktreesParams, } | { "method": "project/deleteWorktree", id: RequestId, params: ProjectDeleteWorktreeParams, } | { "method": "project/setArchivedSessionWorktrees", id: RequestId, params: ProjectSetArchivedSessionWorktreesParams, } | { "method": "project/setProjectConnectorEnabled", id: RequestId, params: ProjectSetProjectConnectorEnabledParams, } | { "method": "agent/agentDefinitionPresence", id: RequestId, params: AgentAgentDefinitionPresenceParams, } | { "method": "agent/archivedAgentIdentities", id: RequestId, params: AgentArchivedAgentIdentitiesParams, } | { "method": "agent/getAgentDefinition", id: RequestId, params: AgentGetAgentDefinitionParams, } | { "method": "agent/getAgentAvatarImage", id: RequestId, params: AgentGetAgentAvatarImageParams, } | { "method": "agent/getAgentConnectors", id: RequestId, params: AgentGetAgentConnectorsParams, } | { "method": "agent/getAgentAlwaysAllowedTools", id: RequestId, params: AgentGetAgentAlwaysAllowedToolsParams, } | { "method": "agent/getAgentConnectorTools", id: RequestId, params: AgentGetAgentConnectorToolsParams, } | { "method": "agent/getAgentPermissions", id: RequestId, params: AgentGetAgentPermissionsParams, } | { "method": "agent/getLeadPersona", id: RequestId, params: AgentGetLeadPersonaParams, } | { "method": "agent/getLeadAgentBody", id: RequestId, params: AgentGetLeadAgentBodyParams, } | { "method": "agent/getLeadStatus", id: RequestId, params: AgentGetLeadStatusParams, } | { "method": "agent/getLeadHomeRoute", id: RequestId, params: AgentGetLeadHomeRouteParams, } | { "method": "agent/getLeadAppearance", id: RequestId, params: AgentGetLeadAppearanceParams, } | { "method": "agent/saveAgentDefinition", id: RequestId, params: AgentSaveAgentDefinitionParams, } | { "method": "agent/deleteAgentDefinition", id: RequestId, params: AgentDeleteAgentDefinitionParams, } | { "method": "agent/restoreAgentDefinition", id: RequestId, params: AgentRestoreAgentDefinitionParams, } | { "method": "agent/purgeAgentDefinition", id: RequestId, params: AgentPurgeAgentDefinitionParams, } | { "method": "agent/setAgentConnectors", id: RequestId, params: AgentSetAgentConnectorsParams, } | { "method": "agent/setAgentConnectorEnabled", id: RequestId, params: AgentSetAgentConnectorEnabledParams, } | { "method": "agent/setAgentConnectorToolPermission", id: RequestId, params: AgentSetAgentConnectorToolPermissionParams, } | { "method": "agent/setAgentPermission", id: RequestId, params: AgentSetAgentPermissionParams, } | { "method": "agent/recordAgentApprovalAudit", id: RequestId, params: AgentRecordAgentApprovalAuditParams, } | { "method": "agent/saveLeadPersona", id: RequestId, params: AgentSaveLeadPersonaParams, } | { "method": "agent/saveLeadAgentBody", id: RequestId, params: AgentSaveLeadAgentBodyParams, } | { "method": "agent/setLeadCreated", id: RequestId, params: AgentSetLeadCreatedParams, } | { "method": "agent/saveLeadIdentity", id: RequestId, params: AgentSaveLeadIdentityParams, } | { "method": "agent/setLeadAppearance", id: RequestId, params: AgentSetLeadAppearanceParams, } | { "method": "config/getBotOrder", id: RequestId, params: ConfigGetBotOrderParams, } | { "method": "config/setBotOrder", id: RequestId, params: ConfigSetBotOrderParams, } | { "method": "agent/home/open", id: RequestId, params: AgentHomeOpenParams, } | { "method": "agent/home/reset", id: RequestId, params: AgentHomeResetParams, } | { "method": "agent/memory/list", id: RequestId, params: AgentMemoryListParams, } | { "method": "agent/memory/delete", id: RequestId, params: AgentMemoryDeleteParams, } | { "method": "agent/pool/list", id: RequestId, params: AgentPoolListParams, } | { "method": "room/create", id: RequestId, params: RoomCreateParams, } | { "method": "room/update", id: RequestId, params: RoomUpdateParams, } | { "method": "room/continue", id: RequestId, params: RoomContinueParams, } | { "method": "room/leave", id: RequestId, params: RoomLeaveParams, } | { "method": "room/remove", id: RequestId, params: RoomRemoveParams, } | { "method": "instructions/listInstructionFiles", id: RequestId, params: InstructionsListInstructionFilesParams, } | { "method": "instructions/getInstructionFile", id: RequestId, params: InstructionsGetInstructionFileParams, } | { "method": "instructions/saveInstructionFile", id: RequestId, params: InstructionsSaveInstructionFileParams, } | { "method": "instructions/resetInstructionFile", id: RequestId, params: InstructionsResetInstructionFileParams, } | { "method": "instructions/setInstructionFiles", id: RequestId, params: InstructionsSetInstructionFilesParams, } | { "method": "connector/listConnectorTools", id: RequestId, params: ConnectorListConnectorToolsParams, } | { "method": "connector/addConnectorAccount", id: RequestId, params: ConnectorAddConnectorAccountParams, } | { "method": "config/getAutoClear", id: RequestId, params: ConfigGetAutoClearParams, } | { "method": "config/getCacheWarmingSettings", id: RequestId, params: ConfigGetCacheWarmingSettingsParams, } | { "method": "config/getCompactionSettings", id: RequestId, params: ConfigGetCompactionSettingsParams, } | { "method": "config/getDeveloperSettings", id: RequestId, params: ConfigGetDeveloperSettingsParams, } | { "method": "config/getOutputStyle", id: RequestId, params: ConfigGetOutputStyleParams, } | { "method": "config/getOrchestrationMode", id: RequestId, params: ConfigGetOrchestrationModeParams, } | { "method": "config/getConfiguredOrchestrationMode", id: RequestId, params: ConfigGetConfiguredOrchestrationModeParams, } | { "method": "config/getProfile", id: RequestId, params: ConfigGetProfileParams, } | { "method": "config/getRecapSettings", id: RequestId, params: ConfigGetRecapSettingsParams, } | { "method": "config/getSessionTitleSettings", id: RequestId, params: ConfigGetSessionTitleSettingsParams, } | { "method": "config/getHeartbeatSettings", id: RequestId, params: ConfigGetHeartbeatSettingsParams, } | { "method": "config/getReactionSettings", id: RequestId, params: ConfigGetReactionSettingsParams, } | { "method": "config/getSystemShell", id: RequestId, params: ConfigGetSystemShellParams, } | { "method": "config/getTheme", id: RequestId, params: ConfigGetThemeParams, } | { "method": "config/getToolModuleSettings", id: RequestId, params: ConfigGetToolModuleSettingsParams, } | { "method": "config/getUpdateSettings", id: RequestId, params: ConfigGetUpdateSettingsParams, } | { "method": "config/getWorktreeSettings", id: RequestId, params: ConfigGetWorktreeSettingsParams, } | { "method": "config/listOutputStyles", id: RequestId, params: ConfigListOutputStylesParams, } | { "method": "config/getNetworkProxy", id: RequestId, params: ConfigGetNetworkProxyParams, } | { "method": "config/testNetworkProxy", id: RequestId, params: ConfigTestNetworkProxyParams, } | { "method": "config/getWorkflowPack", id: RequestId, params: ConfigGetWorkflowPackParams, } | { "method": "config/isSetupRequestActive", id: RequestId, params: ConfigIsSetupRequestActiveParams, } | { "method": "config/setAutoUpdate", id: RequestId, params: ConfigSetAutoUpdateParams, } | { "method": "config/setCacheWarmingEnabled", id: RequestId, params: ConfigSetCacheWarmingEnabledParams, } | { "method": "config/setRecapEnabled", id: RequestId, params: ConfigSetRecapEnabledParams, } | { "method": "config/setAiSessionTitles", id: RequestId, params: ConfigSetAiSessionTitlesParams, } | { "method": "config/setHeartbeatEnabled", id: RequestId, params: ConfigSetHeartbeatEnabledParams, } | { "method": "config/setReactionsEnabled", id: RequestId, params: ConfigSetReactionsEnabledParams, } | { "method": "config/setWebSearchEnabled", id: RequestId, params: ConfigSetWebSearchEnabledParams, } | { "method": "config/setMemoryToolsEnabled", id: RequestId, params: ConfigSetMemoryToolsEnabledParams, } | { "method": "config/setAutoClear", id: RequestId, params: ConfigSetAutoClearParams, } | { "method": "config/setCompactionSettings", id: RequestId, params: ConfigSetCompactionSettingsParams, } | { "method": "config/setDeveloperOption", id: RequestId, params: ConfigSetDeveloperOptionParams, } | { "method": "config/setProfile", id: RequestId, params: ConfigSetProfileParams, } | { "method": "config/setHeartbeatInterval", id: RequestId, params: ConfigSetHeartbeatIntervalParams, } | { "method": "config/setSystemShell", id: RequestId, params: ConfigSetSystemShellParams, } | { "method": "config/setTheme", id: RequestId, params: ConfigSetThemeParams, } | { "method": "config/setWebSearchRoute", id: RequestId, params: ConfigSetWebSearchRouteParams, } | { "method": "config/setAutoEffortBase", id: RequestId, params: ConfigSetAutoEffortBaseParams, } | { "method": "config/setBuiltinToolEnabled", id: RequestId, params: ConfigSetBuiltinToolEnabledParams, } | { "method": "config/installBuiltinFeature", id: RequestId, params: ConfigInstallBuiltinFeatureParams, } | { "method": "config/setWorktreeSettings", id: RequestId, params: ConfigSetWorktreeSettingsParams, } | { "method": "config/setNetworkProxy", id: RequestId, params: ConfigSetNetworkProxyParams, } | { "method": "config/saveWorkflowPack", id: RequestId, params: ConfigSaveWorkflowPackParams, } | { "method": "config/createWorkflow", id: RequestId, params: ConfigCreateWorkflowParams, } | { "method": "config/deleteWorkflow", id: RequestId, params: ConfigDeleteWorkflowParams, } | { "method": "config/setModelPreferences", id: RequestId, params: ConfigSetModelPreferencesParams, } | { "method": "config/skipOnboarding", id: RequestId, params: ConfigSkipOnboardingParams, } | { "method": "config/completeOnboarding", id: RequestId, params: ConfigCompleteOnboardingParams, } | { "method": "config/saveStarterGuideState", id: RequestId, params: ConfigSaveStarterGuideStateParams, } | { "method": "config/claimSetupRequest", id: RequestId, params: ConfigClaimSetupRequestParams, } | { "method": "config/completeSetupRequest", id: RequestId, params: ConfigCompleteSetupRequestParams, } | { "method": "config/setExtensionScope", id: RequestId, params: ConfigSetExtensionScopeParams, } | { "method": "config/read", id: RequestId, params: ConfigReadParams, } | { "method": "config/value/write", id: RequestId, params: ConfigValueWriteParams, } | { "method": "config/batchWrite", id: RequestId, params: ConfigBatchWriteParams, } | { "method": "channel/getChannelSettings", id: RequestId, params: ChannelGetChannelSettingsParams, } | { "method": "channel/getChannelSetup", id: RequestId, params: ChannelGetChannelSetupParams, } | { "method": "channel/getChannelWorkerStatus", id: RequestId, params: ChannelGetChannelWorkerStatusParams, } | { "method": "channel/setWebhookConfig", id: RequestId, params: ChannelSetWebhookConfigParams, } | { "method": "channel/saveSchedule", id: RequestId, params: ChannelSaveScheduleParams, } | { "method": "channel/deleteSchedule", id: RequestId, params: ChannelDeleteScheduleParams, } | { "method": "channel/setScheduleEnabled", id: RequestId, params: ChannelSetScheduleEnabledParams, } | { "method": "channel/runScheduleNow", id: RequestId, params: ChannelRunScheduleNowParams, } | { "method": "channel/runWebhookNow", id: RequestId, params: ChannelRunWebhookNowParams, } | { "method": "channel/retryRoutineDelivery", id: RequestId, params: ChannelRetryRoutineDeliveryParams, } | { "method": "channel/testWebhook", id: RequestId, params: ChannelTestWebhookParams, } | { "method": "channel/saveWebhook", id: RequestId, params: ChannelSaveWebhookParams, } | { "method": "channel/deleteWebhook", id: RequestId, params: ChannelDeleteWebhookParams, } | { "method": "channel/setWebhookEnabled", id: RequestId, params: ChannelSetWebhookEnabledParams, } | { "method": "import/getConversationImportJobs", id: RequestId, params: ImportGetConversationImportJobsParams, } | { "method": "import/listImportableConversations", id: RequestId, params: ImportListImportableConversationsParams, } | { "method": "import/startConversationImport", id: RequestId, params: ImportStartConversationImportParams, } | { "method": "import/cancelConversationImport", id: RequestId, params: ImportCancelConversationImportParams, } | { "method": "import/registerConversationImportFile", id: RequestId, params: ImportRegisterConversationImportFileParams, } | { "method": "media/getMediaDefault", id: RequestId, params: MediaGetMediaDefaultParams, } | { "method": "media/getMediaJob", id: RequestId, params: MediaGetMediaJobParams, } | { "method": "media/getMediaPins", id: RequestId, params: MediaGetMediaPinsParams, } | { "method": "media/listMediaAssets", id: RequestId, params: MediaListMediaAssetsParams, } | { "method": "media/listMediaBoards", id: RequestId, params: MediaListMediaBoardsParams, } | { "method": "media/listMediaLanes", id: RequestId, params: MediaListMediaLanesParams, } | { "method": "media/readMediaAsset", id: RequestId, params: MediaReadMediaAssetParams, } | { "method": "media/resolveMediaFile", id: RequestId, params: MediaResolveMediaFileParams, } | { "method": "media/startMediaJob", id: RequestId, params: MediaStartMediaJobParams, } | { "method": "media/cancelMediaJob", id: RequestId, params: MediaCancelMediaJobParams, } | { "method": "media/deleteMediaAsset", id: RequestId, params: MediaDeleteMediaAssetParams, } | { "method": "media/deleteMediaAssets", id: RequestId, params: MediaDeleteMediaAssetsParams, } | { "method": "media/createMediaBoard", id: RequestId, params: MediaCreateMediaBoardParams, } | { "method": "media/renameMediaBoard", id: RequestId, params: MediaRenameMediaBoardParams, } | { "method": "media/deleteMediaBoard", id: RequestId, params: MediaDeleteMediaBoardParams, } | { "method": "media/setMediaAssetBoard", id: RequestId, params: MediaSetMediaAssetBoardParams, } | { "method": "media/setMediaDefault", id: RequestId, params: MediaSetMediaDefaultParams, } | { "method": "media/setMediaPin", id: RequestId, params: MediaSetMediaPinParams, } | { "method": "media/cacheMediaThumbnail", id: RequestId, params: MediaCacheMediaThumbnailParams, } | { "method": "media/openMediaAsset", id: RequestId, params: MediaOpenMediaAssetParams, } | { "method": "media/openMediaFolder", id: RequestId, params: MediaOpenMediaFolderParams, } | { "method": "mcp/getMcpServerConfig", id: RequestId, params: McpGetMcpServerConfigParams, } | { "method": "mcp/getMcpOAuthLoginStatus", id: RequestId, params: McpGetMcpOAuthLoginStatusParams, } | { "method": "mcp/mcpStatus", id: RequestId, params: McpMcpStatusParams, } | { "method": "mcp/addMcpServer", id: RequestId, params: McpAddMcpServerParams, } | { "method": "mcp/saveMcpServer", id: RequestId, params: McpSaveMcpServerParams, } | { "method": "mcp/removeMcpServer", id: RequestId, params: McpRemoveMcpServerParams, } | { "method": "mcp/setMcpServerEnabled", id: RequestId, params: McpSetMcpServerEnabledParams, } | { "method": "mcp/reconnectMcp", id: RequestId, params: McpReconnectMcpParams, } | { "method": "mcp/beginMcpOAuthLogin", id: RequestId, params: McpBeginMcpOAuthLoginParams, } | { "method": "mcp/cancelMcpOAuthLogin", id: RequestId, params: McpCancelMcpOAuthLoginParams, } | { "method": "mcp/completeMcpOAuthLogin", id: RequestId, params: McpCompleteMcpOAuthLoginParams, } | { "method": "mcp/signOutMcpServer", id: RequestId, params: McpSignOutMcpServerParams, } | { "method": "mcp/probeMcpServerAuth", id: RequestId, params: McpProbeMcpServerAuthParams, } | { "method": "mcp/enablePluginMcp", id: RequestId, params: McpEnablePluginMcpParams, } | { "method": "account/getOAuthProviderLoginStatus", id: RequestId, params: AccountGetOAuthProviderLoginStatusParams, } | { "method": "account/listWebSearchModels", id: RequestId, params: AccountListWebSearchModelsParams, } | { "method": "account/getQuotaHistory", id: RequestId, params: AccountGetQuotaHistoryParams, } | { "method": "account/authenticateProvider", id: RequestId, params: AccountAuthenticateProviderParams, } | { "method": "account/beginOAuthProviderLogin", id: RequestId, params: AccountBeginOAuthProviderLoginParams, } | { "method": "account/completeOAuthProviderLogin", id: RequestId, params: AccountCompleteOAuthProviderLoginParams, } | { "method": "account/cancelOAuthProviderLogin", id: RequestId, params: AccountCancelOAuthProviderLoginParams, } | { "method": "account/loginOAuthProvider", id: RequestId, params: AccountLoginOAuthProviderParams, } | { "method": "account/forgetProviderAuth", id: RequestId, params: AccountForgetProviderAuthParams, } | { "method": "account/updateProviderAccounts", id: RequestId, params: AccountUpdateProviderAccountsParams, } | { "method": "account/saveProviderApiKey", id: RequestId, params: AccountSaveProviderApiKeyParams, } | { "method": "account/saveCustomProvider", id: RequestId, params: AccountSaveCustomProviderParams, } | { "method": "account/saveCustomProviderKey", id: RequestId, params: AccountSaveCustomProviderKeyParams, } | { "method": "account/removeCustomProvider", id: RequestId, params: AccountRemoveCustomProviderParams, } | { "method": "account/updateCustomProviderModel", id: RequestId, params: AccountUpdateCustomProviderModelParams, } | { "method": "account/testCustomProvider", id: RequestId, params: AccountTestCustomProviderParams, } | { "method": "account/checkCustomProviderKeyEnv", id: RequestId, params: AccountCheckCustomProviderKeyEnvParams, } | { "method": "account/discoverCustomProviderModels", id: RequestId, params: AccountDiscoverCustomProviderModelsParams, } | { "method": "account/saveOpenAIUsageSessionKey", id: RequestId, params: AccountSaveOpenAIUsageSessionKeyParams, } | { "method": "account/consumeCodexRateLimitResetCredit", id: RequestId, params: AccountConsumeCodexRateLimitResetCreditParams, } | { "method": "account/refreshProviderSetup", id: RequestId, params: AccountRefreshProviderSetupParams, } | { "method": "localProvider/searchLocalProviderModels", id: RequestId, params: LocalProviderSearchLocalProviderModelsParams, } | { "method": "localProvider/inspectHuggingFaceModel", id: RequestId, params: LocalProviderInspectHuggingFaceModelParams, } | { "method": "localProvider/getLocalProviderModelDetails", id: RequestId, params: LocalProviderGetLocalProviderModelDetailsParams, } | { "method": "localProvider/installLocalProviderModel", id: RequestId, params: LocalProviderInstallLocalProviderModelParams, } | { "method": "localProvider/startLocalProviderInstallation", id: RequestId, params: LocalProviderStartLocalProviderInstallationParams, } | { "method": "localProvider/cancelLocalProviderInstallation", id: RequestId, params: LocalProviderCancelLocalProviderInstallationParams, } | { "method": "localProvider/discardLocalProviderInstallation", id: RequestId, params: LocalProviderDiscardLocalProviderInstallationParams, } | { "method": "localProvider/setLocalProviderIdleTtl", id: RequestId, params: LocalProviderSetLocalProviderIdleTtlParams, } | { "method": "localProvider/setLocalProviderContext", id: RequestId, params: LocalProviderSetLocalProviderContextParams, } | { "method": "localProvider/registerHuggingFaceModel", id: RequestId, params: LocalProviderRegisterHuggingFaceModelParams, } | { "method": "localProvider/startLocalProviderModelMaintenance", id: RequestId, params: LocalProviderStartLocalProviderModelMaintenanceParams, } | { "method": "localProvider/deleteLocalProviderModel", id: RequestId, params: LocalProviderDeleteLocalProviderModelParams, } | { "method": "usage/getUsageDashboard", id: RequestId, params: UsageGetUsageDashboardParams, } | { "method": "usage/getUsageStats", id: RequestId, params: UsageGetUsageStatsParams, } | { "method": "usage/getUsageRequests", id: RequestId, params: UsageGetUsageRequestsParams, } | { "method": "update/getUpdateStatus", id: RequestId, params: UpdateGetUpdateStatusParams, } | { "method": "update/checkForUpdate", id: RequestId, params: UpdateCheckForUpdateParams, } | { "method": "update/runUpdateNow", id: RequestId, params: UpdateRunUpdateNowParams, } | { "method": "update/desktop/command", id: RequestId, params: UpdateDesktopCommandParams, } | { "method": "voice/getVoiceStatus", id: RequestId, params: VoiceGetVoiceStatusParams, } | { "method": "voice/toggleVoice", id: RequestId, params: VoiceToggleVoiceParams, } | { "method": "voice/transcribeAudio", id: RequestId, params: VoiceTranscribeAudioParams, } | { "method": "voice/prepareTranscription", id: RequestId, params: VoicePrepareTranscriptionParams, } | { "method": "tidy/getTidyEngineStatus", id: RequestId, params: TidyGetTidyEngineStatusParams, } | { "method": "tidy/getTidyInstallStatus", id: RequestId, params: TidyGetTidyInstallStatusParams, } | { "method": "skills/skillsStatus", id: RequestId, params: SkillsSkillsStatusParams, } | { "method": "skills/skillContent", id: RequestId, params: SkillsSkillContentParams, } | { "method": "skills/getDisabledSkills", id: RequestId, params: SkillsGetDisabledSkillsParams, } | { "method": "skills/addSkill", id: RequestId, params: SkillsAddSkillParams, } | { "method": "skills/saveSkill", id: RequestId, params: SkillsSaveSkillParams, } | { "method": "skills/removeSkill", id: RequestId, params: SkillsRemoveSkillParams, } | { "method": "skills/reloadSkills", id: RequestId, params: SkillsReloadSkillsParams, } | { "method": "skills/setDisabledSkills", id: RequestId, params: SkillsSetDisabledSkillsParams, } | { "method": "plugins/pluginsStatus", id: RequestId, params: PluginsPluginsStatusParams, } | { "method": "plugins/addPlugin", id: RequestId, params: PluginsAddPluginParams, } | { "method": "plugins/updatePlugin", id: RequestId, params: PluginsUpdatePluginParams, } | { "method": "plugins/setPluginEnabled", id: RequestId, params: PluginsSetPluginEnabledParams, } | { "method": "plugins/removePlugin", id: RequestId, params: PluginsRemovePluginParams, } | { "method": "plugins/reloadPlugins", id: RequestId, params: PluginsReloadPluginsParams, } | { "method": "tools/toolsStatus", id: RequestId, params: ToolsToolsStatusParams, } | { "method": "memory/memoryControl", id: RequestId, params: MemoryMemoryControlParams, } | { "method": "memory/recall", id: RequestId, params: MemoryRecallParams, } | { "method": "diagnostics/runDoctor", id: RequestId, params: DiagnosticsRunDoctorParams, } | { "method": "project/list", id: RequestId, params: ProjectListParams, } | { "method": "project/read", id: RequestId, params: ProjectReadParams, } | { "method": "project/create", id: RequestId, params: ProjectCreateParams, } | { "method": "project/touch", id: RequestId, params: ProjectTouchParams, } | { "method": "project/update", id: RequestId, params: ProjectUpdateParams, } | { "method": "project/delete", id: RequestId, params: ProjectDeleteParams, } | { "method": "project/ensureDirectory", id: RequestId, params: ProjectEnsureDirectoryParams, } | { "method": "project/directory", id: RequestId, params: ProjectDirectoryParams, } | { "method": "project/recoveryDirectory", id: RequestId, params: ProjectRecoveryDirectoryParams, } | { "method": "project/taskWorkspace", id: RequestId, params: ProjectTaskWorkspaceParams, } | { "method": "project/codeGraph", id: RequestId, params: ProjectCodeGraphParams, } | { "method": "projectFs/listDir", id: RequestId, params: ProjectFsListDirParams, } | { "method": "projectFs/readText", id: RequestId, params: ProjectFsReadTextParams, } | { "method": "projectFs/writeText", id: RequestId, params: ProjectFsWriteTextParams, } | { "method": "projectFs/writeTextBatch", id: RequestId, params: ProjectFsWriteTextBatchParams, } | { "method": "projectFs/stat", id: RequestId, params: ProjectFsStatParams, } | { "method": "projectFs/create", id: RequestId, params: ProjectFsCreateParams, } | { "method": "projectFs/rename", id: RequestId, params: ProjectFsRenameParams, } | { "method": "projectFs/move", id: RequestId, params: ProjectFsMoveParams, } | { "method": "projectFs/copy", id: RequestId, params: ProjectFsCopyParams, } | { "method": "projectFs/trash", id: RequestId, params: ProjectFsTrashParams, } | { "method": "projectFs/entryPath", id: RequestId, params: ProjectFsEntryPathParams, } | { "method": "projectFs/readLocal", id: RequestId, params: ProjectFsReadLocalParams, } | { "method": "projectFs/statLocal", id: RequestId, params: ProjectFsStatLocalParams, } | { "method": "projectFs/browseDirs", id: RequestId, params: ProjectFsBrowseDirsParams, } | { "method": "projectFs/searchText", id: RequestId, params: ProjectFsSearchTextParams, } | { "method": "projectFs/replaceText", id: RequestId, params: ProjectFsReplaceTextParams, } | { "method": "projectFs/recovery", id: RequestId, params: ProjectFsRecoveryParams, } | { "method": "projectFs/backup/read", id: RequestId, params: ProjectFsBackupReadParams, } | { "method": "projectFs/backup/write", id: RequestId, params: ProjectFsBackupWriteParams, } | { "method": "projectFs/backup/delete", id: RequestId, params: ProjectFsBackupDeleteParams, } | { "method": "projectFs/workspaceFile/read", id: RequestId, params: ProjectFsWorkspaceFileReadParams, } | { "method": "projectFs/workspaceFile/write", id: RequestId, params: ProjectFsWorkspaceFileWriteParams, } | { "method": "projectFs/readEditorSettings", id: RequestId, params: ProjectFsReadEditorSettingsParams, } | { "method": "projectFs/captureSnapshot", id: RequestId, params: ProjectFsCaptureSnapshotParams, } | { "method": "projectFs/localPageUrl", id: RequestId, params: ProjectFsLocalPageUrlParams, } | { "method": "fs/watch", id: RequestId, params: FsWatchParams, } | { "method": "fs/unwatch", id: RequestId, params: FsUnwatchParams, } | { "method": "search/start", id: RequestId, params: SearchStartParams, } | { "method": "search/update", id: RequestId, params: SearchUpdateParams, } | { "method": "search/stop", id: RequestId, params: SearchStopParams, } | { "method": "transfer/beginRead", id: RequestId, params: TransferBeginReadParams, } | { "method": "transfer/beginZip", id: RequestId, params: TransferBeginZipParams, } | { "method": "transfer/readRange", id: RequestId, params: TransferReadRangeParams, } | { "method": "transfer/endRead", id: RequestId, params: TransferEndReadParams, } | { "method": "transfer/beginWrite", id: RequestId, params: TransferBeginWriteParams, } | { "method": "transfer/writeChunk", id: RequestId, params: TransferWriteChunkParams, } | { "method": "transfer/commit", id: RequestId, params: TransferCommitParams, } | { "method": "transfer/abort", id: RequestId, params: TransferAbortParams, } | { "method": "transfer/trash/info", id: RequestId, params: TransferTrashInfoParams, } | { "method": "transfer/trash/entry", id: RequestId, params: TransferTrashEntryParams, } | { "method": "transfer/grant/mint", id: RequestId, params: TransferGrantMintParams, } | { "method": "lsp/subscribe", id: RequestId, params: LspSubscribeParams, } | { "method": "lsp/unsubscribe", id: RequestId, params: LspSubscribeParams, } | { "method": "lsp/document", id: RequestId, params: LspDocumentParams, } | { "method": "lsp/request", id: RequestId, params: LspRequestParams, } | { "method": "document/preview", id: RequestId, params: DocumentPreviewParams, } | { "method": "document/previewPages", id: RequestId, params: DocumentPreviewPagesParams, } | { "method": "document/libreOfficeStatus", id: RequestId, params: DocumentLibreOfficeStatusParams, } | { "method": "document/installLibreOffice", id: RequestId, params: DocumentInstallLibreOfficeParams, } | { "method": "git/status", id: RequestId, params: GitStatusParams, } | { "method": "git/branches", id: RequestId, params: GitBranchesParams, } | { "method": "git/log", id: RequestId, params: GitLogParams, } | { "method": "git/show", id: RequestId, params: GitShowParams, } | { "method": "git/showDiff", id: RequestId, params: GitShowDiffParams, } | { "method": "git/showFile", id: RequestId, params: GitShowFileParams, } | { "method": "git/diff", id: RequestId, params: GitDiffParams, } | { "method": "git/stashList", id: RequestId, params: GitStashListParams, } | { "method": "git/requestContext", id: RequestId, params: GitRequestContextParams, } | { "method": "git/cliStatus", id: RequestId, params: GitCliStatusParams, } | { "method": "git/globalConfig/read", id: RequestId, params: GitGlobalConfigReadParams, } | { "method": "git/watch", id: RequestId, params: GitWatchParams, } | { "method": "git/unwatch", id: RequestId, params: GitUnwatchParams, } | { "method": "git/stage", id: RequestId, params: GitStageParams, } | { "method": "git/unstage", id: RequestId, params: GitUnstageParams, } | { "method": "git/commit", id: RequestId, params: GitCommitParams, } | { "method": "git/commitPaths", id: RequestId, params: GitCommitPathsParams, } | { "method": "git/amend", id: RequestId, params: GitAmendParams, } | { "method": "git/undoLastCommit", id: RequestId, params: GitUndoLastCommitParams, } | { "method": "git/push", id: RequestId, params: GitPushParams, } | { "method": "git/pull", id: RequestId, params: GitPullParams, } | { "method": "git/fetch", id: RequestId, params: GitFetchParams, } | { "method": "git/sync", id: RequestId, params: GitSyncParams, } | { "method": "git/stash", id: RequestId, params: GitStashParams, } | { "method": "git/stashPop", id: RequestId, params: GitStashPopParams, } | { "method": "git/stashApply", id: RequestId, params: GitStashApplyParams, } | { "method": "git/stashDrop", id: RequestId, params: GitStashDropParams, } | { "method": "git/createTag", id: RequestId, params: GitCreateTagParams, } | { "method": "git/deleteTag", id: RequestId, params: GitDeleteTagParams, } | { "method": "git/deleteBranch", id: RequestId, params: GitDeleteBranchParams, } | { "method": "git/renameBranch", id: RequestId, params: GitRenameBranchParams, } | { "method": "git/resetToCommit", id: RequestId, params: GitResetToCommitParams, } | { "method": "git/revertCommit", id: RequestId, params: GitRevertCommitParams, } | { "method": "git/revertFile", id: RequestId, params: GitRevertFileParams, } | { "method": "git/cherryPickCommit", id: RequestId, params: GitCherryPickCommitParams, } | { "method": "git/applyPatch", id: RequestId, params: GitApplyPatchParams, } | { "method": "git/ignore", id: RequestId, params: GitIgnoreParams, } | { "method": "git/continue", id: RequestId, params: GitContinueParams, } | { "method": "git/abortOperation", id: RequestId, params: GitAbortOperationParams, } | { "method": "git/globalConfig/write", id: RequestId, params: GitGlobalConfigWriteParams, } | { "method": "git/cli/install", id: RequestId, params: GitCliInstallParams, } | { "method": "github/status", id: RequestId, params: GithubStatusParams, } | { "method": "github/account", id: RequestId, params: GithubAccountParams, } | { "method": "github/login/start", id: RequestId, params: GithubLoginStartParams, } | { "method": "github/login/status", id: RequestId, params: GithubLoginStatusParams, } | { "method": "github/login/openBrowser", id: RequestId, params: GithubLoginOpenBrowserParams, } | { "method": "github/login/cancel", id: RequestId, params: GithubLoginCancelParams, } | { "method": "github/logout", id: RequestId, params: GithubLogoutParams, } | { "method": "github/install", id: RequestId, params: GithubInstallParams, } | { "method": "github/request", id: RequestId, params: GithubRequestParams, } | { "method": "github/starStatus", id: RequestId, params: GithubStarStatusParams, } | { "method": "github/star", id: RequestId, params: GithubStarParams, } | { "method": "github/pr/list", id: RequestId, params: GithubPrListParams, } | { "method": "github/pr/view", id: RequestId, params: GithubPrViewParams, } | { "method": "github/pr/diff", id: RequestId, params: GithubPrDiffParams, } | { "method": "github/pr/defaultBranch", id: RequestId, params: GithubPrDefaultBranchParams, } | { "method": "github/pr/create", id: RequestId, params: GithubPrCreateParams, } | { "method": "github/pr/checkout", id: RequestId, params: GithubPrCheckoutParams, } | { "method": "github/pr/merge", id: RequestId, params: GithubPrMergeParams, } | { "method": "review/diff/get", id: RequestId, params: ReviewDiffGetParams, } | { "method": "process/spawn", id: RequestId, params: ProcessSpawnParams, } | { "method": "process/kill", id: RequestId, params: ProcessKillParams, } | { "method": "process/resizePty", id: RequestId, params: ProcessResizePtyParams, } | { "method": "process/writeStdin", id: RequestId, params: ProcessWriteStdinParams, } | { "method": "terminal/ensure", id: RequestId, params: TerminalEnsureParams, } | { "method": "terminal/attach", id: RequestId, params: TerminalAttachParams, } | { "method": "terminal/profiles", id: RequestId, params: TerminalProfilesParams, } | { "method": "terminal/focus", id: RequestId, params: TerminalFocusParams, } | { "method": "terminal/pause", id: RequestId, params: TerminalPauseParams, } | { "method": "terminal/resume", id: RequestId, params: TerminalResumeParams, } | { "method": "terminal/dispose", id: RequestId, params: TerminalDisposeParams, } | { "method": "system/ports/subscribe", id: RequestId, params: SystemPortsSubscribeParams, } | { "method": "system/ports/unsubscribe", id: RequestId, params: SystemPortsUnsubscribeParams, } | { "method": "remoteAccess/setEnabled", id: RequestId, params: RemoteAccessSetEnabledParams, } | { "method": "remoteAccess/setName", id: RequestId, params: RemoteAccessSetNameParams, } | { "method": "remoteAccess/setClientAlias", id: RequestId, params: RemoteAccessSetClientAliasParams, } | { "method": "remoteAccess/rotate", id: RequestId, params: RemoteAccessRotateParams, } | { "method": "remoteAccess/resolveClaim", id: RequestId, params: RemoteAccessResolveClaimParams, } | { "method": "remoteAccess/pairCode", id: RequestId, params: RemoteAccessPairCodeParams, } | { "method": "remoteAccess/revokeClient", id: RequestId, params: RemoteAccessRevokeClientParams, } | { "method": "remoteAccess/settleOwedControllerKeys", id: RequestId, params: RemoteAccessSettleOwedControllerKeysParams, } | { "method": "remoteAccess/deliverScreenControllerKey", id: RequestId, params: RemoteAccessDeliverScreenControllerKeyParams, } | { "method": "remoteAccess/pushPublicKey", id: RequestId, params: RemoteAccessPushPublicKeyParams, } | { "method": "remoteAccess/registerPushSubscription", id: RequestId, params: RemoteAccessRegisterPushSubscriptionParams, } | { "method": "remoteAccess/removePushSubscription", id: RequestId, params: RemoteAccessRemovePushSubscriptionParams, } | { "method": "remoteAccess/registerNativePush", id: RequestId, params: RemoteAccessRegisterNativePushParams, } | { "method": "remoteAccess/removeNativePush", id: RequestId, params: RemoteAccessRemoveNativePushParams, } | { "method": "remoteAccess/activate", id: RequestId, params: RemoteAccessActivateParams, } | { "method": "remoteAccess/state", id: RequestId, params: RemoteAccessStateParams, } | { "method": "browser/command", id: RequestId, params: BrowserCommandParams, } | { "method": "visualize/command", id: RequestId, params: VisualizeCommandParams, } | { "method": "notify/test", id: RequestId, params: NotifyTestParams, } | { "method": "host/claim", id: RequestId, params: HostClaimParams, } | { "method": "host/state/set", id: RequestId, params: HostStateSetParams, } | { "method": "host/remoteTarget/set", id: RequestId, params: HostRemoteTargetSetParams, } | { "method": "modelProxy/run", id: RequestId, params: ModelProxyRunParams, };

/**
 * WebSocket close codes (P §4.5, X17).
 */
export type CloseCode = 1000 | 1001 | 1003 | 1007 | 1008 | 1009 | 4000 | 4001 | 4002;

/**
 * How a compaction ended (the `status` of its divider row).
 */
export type CompactionStatus = "compacted" | "failed" | "no_change";

export type ComputerApprovalRequestParams = { request: JsonValue, threadId: ThreadId, turnId?: TurnId, itemId?: ItemId,
/**
 * Top-level chat that shows a sub-agent's request.
 */
surfaceThreadId?: ThreadId,
/**
 * Delegation chain from the surface thread to the asking thread.
 */
chain?: Array<ThreadId>, requestedAt: number, expiresAt?: number,
/**
 * Per-surface presentation order; the lowest is the active card (P §8.5).
 */
order: number, };

/**
 * Section value of `computer` (SPEC R40).
 */
export type ComputerSection = { active: boolean, observeOnly: boolean, controller: string | null,
/**
 * Every session with an open execution, oldest first (the overlay draws one activity per session,
 * `overlay/model.ts`); `active`, `observeOnly` and `sessionThreadId` describe the latest of them.
 */
sessions: Array<ComputerSessionSection>, sessionThreadId: ThreadId | null, };

/**
 * One session's open execution in `computer`.
 */
export type ComputerSessionSection = { sessionThreadId: ThreadId, observeOnly: boolean, };

export type ConfigBatchWriteParams = { opId: OpId, edits: Array<ConfigEdit>, };

/**
 * Params of `config/claimSetupRequest`.
 */
export type ConfigClaimSetupRequestParams = { opId: OpId, threadId?: ThreadId, id: string, owner: string, };

/**
 * Params of `config/completeOnboarding`.
 */
export type ConfigCompleteOnboardingParams = { opId: OpId, threadId?: ThreadId, payload?: JsonValue, };

/**
 * Params of `config/completeSetupRequest`.
 */
export type ConfigCompleteSetupRequestParams = { opId: OpId, threadId?: ThreadId, id: string, owner: string, receipt: JsonValue, };

/**
 * Params of `config/createWorkflow`.
 */
export type ConfigCreateWorkflowParams = { opId: OpId, threadId?: ThreadId, payload: JsonValue, };

/**
 * Params of `config/deleteWorkflow`.
 */
export type ConfigDeleteWorkflowParams = { opId: OpId, threadId?: ThreadId, workflowId: string, };

export type ConfigEdit = { path: ConfigPath, value: JsonValue, mode?: ConfigWriteMode, };

/**
 * Params of `config/getAutoClear`.
 */
export type ConfigGetAutoClearParams = { threadId?: ThreadId, };

/**
 * Params of `config/getBotOrder`.
 */
export type ConfigGetBotOrderParams = { threadId?: ThreadId, };

/**
 * Params of `config/getCacheWarmingSettings`.
 */
export type ConfigGetCacheWarmingSettingsParams = { threadId?: ThreadId, };

/**
 * Params of `config/getCompactionSettings`.
 */
export type ConfigGetCompactionSettingsParams = { threadId?: ThreadId, };

/**
 * Params of `config/getConfiguredOrchestrationMode`.
 */
export type ConfigGetConfiguredOrchestrationModeParams = { threadId?: ThreadId, };

/**
 * Params of `config/getDeveloperSettings`.
 */
export type ConfigGetDeveloperSettingsParams = { threadId?: ThreadId, };

/**
 * Params of `config/getHeartbeatSettings`.
 */
export type ConfigGetHeartbeatSettingsParams = { threadId?: ThreadId, };

/**
 * Params of `config/getNetworkProxy`.
 */
export type ConfigGetNetworkProxyParams = { threadId?: ThreadId, options?: JsonValue, };

/**
 * Params of `config/getOrchestrationMode`.
 */
export type ConfigGetOrchestrationModeParams = { threadId?: ThreadId, };

/**
 * Params of `config/getOutputStyle`.
 */
export type ConfigGetOutputStyleParams = { threadId?: ThreadId, };

/**
 * Params of `config/getProfile`.
 */
export type ConfigGetProfileParams = { threadId?: ThreadId, };

/**
 * Params of `config/getReactionSettings`.
 */
export type ConfigGetReactionSettingsParams = { threadId?: ThreadId, };

/**
 * Params of `config/getRecapSettings`.
 */
export type ConfigGetRecapSettingsParams = { threadId?: ThreadId, };

/**
 * Params of `config/getSessionTitleSettings`.
 */
export type ConfigGetSessionTitleSettingsParams = { threadId?: ThreadId, };

/**
 * Params of `config/getSystemShell`.
 */
export type ConfigGetSystemShellParams = { threadId?: ThreadId, };

/**
 * Params of `config/getTheme`.
 */
export type ConfigGetThemeParams = { threadId?: ThreadId, };

/**
 * Params of `config/getToolModuleSettings`.
 */
export type ConfigGetToolModuleSettingsParams = { threadId?: ThreadId, };

/**
 * Params of `config/getUpdateSettings`.
 */
export type ConfigGetUpdateSettingsParams = { threadId?: ThreadId, };

/**
 * Params of `config/getWorkflowPack`.
 */
export type ConfigGetWorkflowPackParams = { threadId?: ThreadId, workflowId: string, };

/**
 * Params of `config/getWorktreeSettings`.
 */
export type ConfigGetWorktreeSettingsParams = { threadId?: ThreadId, };

/**
 * Params of `config/installBuiltinFeature`.
 */
export type ConfigInstallBuiltinFeatureParams = { opId: OpId, threadId?: ThreadId, name: string, options?: JsonValue, };

/**
 * Params of `config/isSetupRequestActive`.
 */
export type ConfigIsSetupRequestActiveParams = { threadId?: ThreadId, id: string, owner: string, };

/**
 * Params of `config/listOutputStyles`.
 */
export type ConfigListOutputStylesParams = { threadId?: ThreadId, };

export type ConfigPath = string;

export type ConfigReadParams = { keys?: Array<ConfigPath>, };

export type ConfigReadResponse = { config: JsonValue, };

/**
 * Params of `config/saveStarterGuideState`.
 */
export type ConfigSaveStarterGuideStateParams = { opId: OpId, threadId?: ThreadId, state: JsonValue, };

/**
 * Params of `config/saveWorkflowPack`.
 */
export type ConfigSaveWorkflowPackParams = { opId: OpId, threadId?: ThreadId, payload: JsonValue, };

/**
 * Params of `config/setAiSessionTitles`.
 */
export type ConfigSetAiSessionTitlesParams = { opId: OpId, threadId?: ThreadId, enabled: boolean, };

/**
 * Params of `config/setAutoClear`.
 */
export type ConfigSetAutoClearParams = { opId: OpId, threadId?: ThreadId, input?: JsonValue, };

/**
 * Params of `config/setAutoEffortBase`.
 */
export type ConfigSetAutoEffortBaseParams = { opId: OpId, threadId?: ThreadId, level: string, };

/**
 * Params of `config/setAutoUpdate`.
 */
export type ConfigSetAutoUpdateParams = { opId: OpId, threadId?: ThreadId, enabled: boolean, };

/**
 * Params of `config/setBotOrder`. Node rejects more than 500 ids, or an id that is empty after
 * trimming or longer than 128, with `usage: setBotOrder(an array of agent ids)`; an empty
 * list clears the stored order.
 */
export type ConfigSetBotOrderParams = { opId: OpId, threadId?: ThreadId, order: Array<string>, };

/**
 * Params of `config/setBuiltinToolEnabled`.
 */
export type ConfigSetBuiltinToolEnabledParams = { opId: OpId, threadId?: ThreadId, name: string, enabled: boolean, };

/**
 * Params of `config/setCacheWarmingEnabled`.
 */
export type ConfigSetCacheWarmingEnabledParams = { opId: OpId, threadId?: ThreadId, enabled: boolean, };

/**
 * Params of `config/setCompactionSettings`.
 */
export type ConfigSetCompactionSettingsParams = { opId: OpId, threadId?: ThreadId, input?: JsonValue, };

/**
 * Params of `config/setDeveloperOption`.
 */
export type ConfigSetDeveloperOptionParams = { opId: OpId, threadId?: ThreadId, id: string, enabled: boolean, };

/**
 * Params of `config/setExtensionScope`.
 */
export type ConfigSetExtensionScopeParams = { opId: OpId, threadId?: ThreadId, kind: string, name: string, projects?: Array<string>, };

/**
 * Params of `config/setHeartbeatEnabled`.
 */
export type ConfigSetHeartbeatEnabledParams = { opId: OpId, threadId?: ThreadId, enabled: boolean, };

/**
 * Params of `config/setHeartbeatInterval`.
 */
export type ConfigSetHeartbeatIntervalParams = { opId: OpId, threadId?: ThreadId, minutes: number, };

/**
 * Params of `config/setMemoryToolsEnabled`.
 */
export type ConfigSetMemoryToolsEnabledParams = { opId: OpId, threadId?: ThreadId, enabled: boolean, };

/**
 * Params of `config/setModelPreferences`.
 */
export type ConfigSetModelPreferencesParams = { opId: OpId, threadId?: ThreadId, providerId: string, changes: JsonValue, };

/**
 * Params of `config/setNetworkProxy`.
 */
export type ConfigSetNetworkProxyParams = { opId: OpId, threadId?: ThreadId, patch: JsonValue, options?: JsonValue, };

/**
 * Params of `config/setProfile`.
 */
export type ConfigSetProfileParams = { opId: OpId, threadId?: ThreadId, input?: JsonValue, };

/**
 * Params of `config/setReactionsEnabled`.
 */
export type ConfigSetReactionsEnabledParams = { opId: OpId, threadId?: ThreadId, enabled: boolean, };

/**
 * Params of `config/setRecapEnabled`.
 */
export type ConfigSetRecapEnabledParams = { opId: OpId, threadId?: ThreadId, enabled: boolean, };

/**
 * Params of `config/setSystemShell`.
 */
export type ConfigSetSystemShellParams = { opId: OpId, threadId?: ThreadId, input: JsonValue, };

/**
 * Params of `config/setTheme`.
 */
export type ConfigSetThemeParams = { opId: OpId, threadId?: ThreadId, id: string, options?: JsonValue, };

/**
 * Params of `config/setWebSearchEnabled`.
 */
export type ConfigSetWebSearchEnabledParams = { opId: OpId, threadId?: ThreadId, enabled: boolean, };

/**
 * Params of `config/setWebSearchRoute`.
 */
export type ConfigSetWebSearchRouteParams = { opId: OpId, threadId?: ThreadId, next: JsonValue, };

/**
 * Params of `config/setWorktreeSettings`.
 */
export type ConfigSetWorktreeSettingsParams = { opId: OpId, threadId?: ThreadId, patch: JsonValue, };

/**
 * Params of `config/skipOnboarding`.
 */
export type ConfigSkipOnboardingParams = { opId: OpId, threadId?: ThreadId, };

/**
 * Params of `config/testNetworkProxy`.
 */
export type ConfigTestNetworkProxyParams = { threadId?: ThreadId, options?: JsonValue, };

export type ConfigValueWriteParams = { opId: OpId, path: ConfigPath, value: JsonValue, mode?: ConfigWriteMode, };

/**
 * How a `config/value/write` edit applies.
 */
export type ConfigWriteMode = "replace" | "initializeIfMissing" | "mergePatch" | "mergePatchBots" | "setConversation";

/**
 * The stored value after the write (`initializeIfMissing` returns the kept value).
 */
export type ConfigWriteResponse = { revision: number, values: Array<JsonValue>, };

/**
 * What the core knows about this connection.
 */
export type ConnectionInfo = { origin: Origin,
/**
 * Host-stamped device name used on submits, aborts and decisions (today's `viewerDevice`).
 */
device: string, };

export type ConnectionKind = "desktop" | "tui" | "cli" | "remoteDesktop" | "phone" | "channelBridge";

/**
 * Params of `connector/addConnectorAccount`.
 */
export type ConnectorAddConnectorAccountParams = { opId: OpId, threadId?: ThreadId, input: JsonValue, };

/**
 * Params of `connector/listConnectorTools`.
 */
export type ConnectorListConnectorToolsParams = { threadId?: ThreadId, connectorId: string, };

export type ConversationNotificationOverride = { target: NotificationTarget, setting: ConversationNotificationSetting, };

/**
 * An override in force; "inherit" is the absence of an entry.
 */
export type ConversationNotificationSetting = { "mode": "always" } | { "mode": "muted", until: number | null, };

/**
 * Notification `core/drain` (`lifecycle-remote.md` §5.1 step 2): the core is draining; sent to
 * every connected client with what is still running, and the token that authorizes an abort.
 */
export type CoreDrainParams = { drainId: string, running: Array<DrainRunning>, confirmToken: string, };

export type CoreState = { "state": "serving" } | { "state": "migrating", kind: string, done: number, total: number, } | { "state": "draining", reason: DrainReason, };

/**
 * Feed a server notification travels on (P §6, DS §2.1).
 */
export type Delivery = "thread" | "app" | { "scoped": ScopedFeedKind } | "anyScoped" | "connection";

export type DeliveryState = "notSent" | "ambiguous" | "accepted";

/**
 * Params of `diagnostics/runDoctor`.
 */
export type DiagnosticsRunDoctorParams = { opId: OpId, threadId?: ThreadId, options?: JsonValue, };

/**
 * `files` of `WORKTREE_DIRTY`: a path preview, or a count (carry `too-large`).
 */
export type DirtyFiles = number | Array<string>;

/**
 * Params of `document/installLibreOffice`.
 */
export type DocumentInstallLibreOfficeParams = { opId: OpId, };

/**
 * Params of `document/libreOfficeStatus`.
 */
export type DocumentLibreOfficeStatusParams = { refresh?: boolean, };

/**
 * Params of `document/previewPages`.
 */
export type DocumentPreviewPagesParams = { root: string, rel: string, options?: JsonValue, };

/**
 * Params of `document/preview`.
 */
export type DocumentPreviewParams = { root: string, rel: string, options?: JsonValue, };

/**
 * Structured detail of a coded domain failure, one variant per code that
 * carries details today (worktree, merge, room and schedule refusals). Fields
 * and their optionality are the union over every producer of that code.
 * Shared by core-api and the wire. The error's text is never here: it is the error's own
 * `message`, as Node's `error.message`.
 */
export type DomainErrorDetail = { "type": "worktreeBusyJobs", reason: string, outcome?: string, admission?: string, sessions?: Array<string>, entryId?: string, kept?: string, workers?: number, jobs?: number, shellJobs?: number, starting?: number, sessionId?: string, } | { "type": "worktreeDirty", reason?: string, operation?: string, count?: number, files?: DirtyFiles, paths?: Array<string>, maxFiles?: number, maxBytes?: number, head?: string, baseCommit?: string, recoveryRef?: string, restored?: boolean, cause?: string, restoreError?: string, entryId?: string, ignored?: Array<string>, } | { "type": "worktreeDirtyChoice", count: number, paths: Array<string>, } | { "type": "worktreeTargetMismatch", target?: string, current?: string, expected?: string, actual?: string, } | { "type": "worktreeUnmerged", commit?: string, entryId?: string, branch?: string, mergeTarget?: string, commits?: number, } | { "type": "worktreeProjectUnknown", projectPath?: string, reason?: string, } | { "type": "worktreeUnsupportedRepo", projectPath?: string, file?: string, line?: number, rel?: string, baseBranch?: string, branch?: string, } | { "type": "worktreePathUnsafe", entryId: string, path: string, reason?: string, links?: Array<string>, count?: number, } | { "type": "worktreeRevisionConflict", entryId?: string, remaining?: Array<RemovalRemnant>, branch?: string, txId?: string, expectedRevision?: number, revision?: number, } | { "type": "worktreeBranchOccupied", branch: string, path?: string,
/**
 * `session` or `external` (today's `kind`).
 */
kind?: string, sessionId?: string, } | { "type": "worktreeMissing", entryId?: string, worktreeId?: string, path?: string, } | { "type": "worktreeFileRecovery", entryId: string, path: string, recoveryRoot: string, } | { "type": "worktreeDefaultBranch", branch: string, } | { "type": "worktreeDiskInsufficient", requiredBytes: number, freeBytes?: number, path: string, reason?: string, } | { "type": "worktreeLargeRepoConfirm", estimateBytes: number, thresholdBytes: number, } | { "type": "worktreeProjectMismatch", projectPath: string, worktreeId?: string, worktreeProject?: string, repoCommonDir?: string, } | { "type": "worktreeRemovalIncomplete", entryId: string, path: string, retryable: boolean, remaining: Array<RemovalRemnant>, reason?: string, revision?: number, } | { "type": "mergeFailed", reason: string, source?: string, aborted?: boolean, } | { "type": "mergeTargetDirty", operation: string, files: Array<string>, count?: number, } | { "type": "roomMemberSwitchedOff", name: string, } | { "type": "scheduleNameTaken", name: string, } | { "type": "scheduleRenameRunning", name: string, } | { "type": "scheduleRenameReloadFailed", name: string, } | { "type": "mergeConflict", files: Array<string>, };

/**
 * Why the core is winding down (LR §5, SPEC R22). Shared by core-api and the wire.
 */
export type DrainReason = "update" | "quit" | "restart" | "noClients";

/**
 * One unit of running work, as listed to the user.
 */
export type DrainRunning = { threadId: string | null, turnId: string | null, kind: ActivityKind, title: string, };

/**
 * The auto-effort judge model card (`effortJudgeInfo`).
 */
export type EffortJudgeInfo = { model: string, quantization: string, engine: string, device: string, modelBytes: number, ready: boolean, };

/**
 * The embedding model behind the memory module (`getEmbeddingInfo`).
 */
export type EmbeddingInfo = { model: string, dtype: string | null, dimensions: number | null,
/**
 * Empty until the model is loaded.
 */
device: string, engine: string, supported: boolean, };

/**
 * Empty result `{}`.
 */
export type EmptyResult = Record<string, never>;

export type EnabledModule = { enabled: boolean, };

/**
 * `{"reason": …, …typed fields}`.
 */
export type ErrorData = { "reason": "notInitialized" } | { "reason": "alreadyInitialized" } | { "reason": "clientOutdated", serverVersion: string, clientVersion: string, } | { "reason": "serverOutdated", serverVersion: string, clientVersion: string, } | { "reason": "serverShuttingDown", drainReason: DrainReason, } | { "reason": "coreMigrating", kind: string, done: number, total: number, } | { "reason": "catalogRebuilding", done: number, total: number, } | { "reason": "threadNotFound", threadId: ThreadId, } | { "reason": "threadClosing", threadId: ThreadId, } | { "reason": "turnNotActive", threadId: ThreadId, turnId?: TurnId, } | { "reason": "itemNotFound", threadId: ThreadId, itemId: ItemId, } | { "reason": "queuedEntryNotFound", threadId: ThreadId, queuedId: QueuedId, } | { "reason": "preconditionFailed", expected: JsonValue, actual: JsonValue, } | { "reason": "permissionDenied", method: string, origin: Origin, } | { "reason": "capabilityUnavailable", capability: string, detail: string, } | { "reason": "opFenced", opId: OpId, } | { "reason": "connectionClosed" } | { "reason": "storeDamaged", threadId: ThreadId, fileNo: number, offset: number, } | { "reason": "blobNotFound", digest: BlobDigest, } | { "reason": "itemTooLarge", limit: number, } | { "reason": "domainError", domain: string, code?: string, message?: string, detail?: DomainErrorDetail, } | { "reason": "methodNotFound", method: string, } | { "reason": "invalidParams", path: string, expected: string, } | { "reason": "opIdConflict", opId: OpId, } | { "reason": "opIdExpired", opId: OpId, watermark: string, } | { "reason": "opIdRequired" } | { "reason": "cursorInvalidated", threadId: ThreadId, historyRev: number, } | { "reason": "inputTooLarge", limit: number, } | { "reason": "internal", incidentId: string, } | { "reason": "barrierFailed", scope: string, ioKind: string, } | { "reason": "storageIndeterminate", scope: string, } | { "reason": "storageUnsupported", op: string, osError: string, } | { "reason": "externalOutcomeUnknown", opId: OpId, effect: string, target: string, } | { "reason": "providerError", provider: string, status?: number, kind: string, } | { "reason": "cancelled", by: string, } | { "reason": "blobCorrupt", digest: BlobDigest, } | { "reason": "inflightLimit", class: RequestClass, limit: number, } | { "reason": "windowFull", threadId: ThreadId, } | { "reason": "queueFull", queue: string, } | { "reason": "invalidServerRequestResponse", requestId: RequestId, detail: string, };

/**
 * `error`: a connection-scoped failure, or a thread error with `willRetry`.
 */
export type ErrorNotificationParams = { error: JsonRpcErrorBody, threadId?: ThreadId, willRetry?: boolean, providerError?: ProviderErrorDetail, };

/**
 * Params of `fast/set`.
 */
export type FastSetParams = { opId: OpId, threadId?: ThreadId, on: boolean, };

/**
 * 128-bit random feed epoch, lowercase hex.
 */
export type FeedEpoch = string;

/**
 * Feed id: `app`, a thread id, or a scoped feed `<kind>:<key>` (see `ScopedFeedKind`).
 */
export type FeedId = string;

/**
 * A client's last position in a feed.
 */
export type FeedPosition = { epoch: FeedEpoch, seq: number, };

/**
 * `feed/snapshot`: the read model of a scoped feed (terminal screen text,
 * search result set, login flow state, port list).
 */
export type FeedSnapshotParams = { feedId: FeedId, state: JsonValue, };

/**
 * Position of a notification in its feed (P §6.1, X1).
 */
export type FeedStamp = { id: FeedId, epoch: FeedEpoch, seq: number, };

/**
 * Generic subscription to a scoped feed whose id the client already knows
 * (`login:<flowId>`, `media:<jobId>`, `lsp:<root>`).
 */
export type FeedSubscribeParams = { feedId: FeedId, resumeFrom?: FeedPosition, };

export type FeedSubscribeResponse = { subscription: Subscription, };

export type FeedUnsubscribeParams = { feedId: FeedId, };

/**
 * Params of `feedback/upload`.
 */
export type FeedbackUploadParams = { opId: OpId, input: JsonValue, };

export type FsChangedParams = { watchId: WatchId, changedPaths: Array<string>,
/**
 * `modified` | `removed` | `renamed` | `git` | `overflow`.
 */
kind: string, };

/**
 * Params of `fs/unwatch`.
 */
export type FsUnwatchParams = { watchId: WatchId, };

/**
 * Params of `fs/watch`.
 */
export type FsWatchParams = { watchId: WatchId, path: string, recursive: boolean, };

/**
 * Params of `git/abortOperation`.
 */
export type GitAbortOperationParams = { opId: OpId, cwd: string, };

/**
 * Params of `git/amend`.
 */
export type GitAmendParams = { opId: OpId, cwd: string, message?: string, };

/**
 * Params of `git/applyPatch`.
 */
export type GitApplyPatchParams = { opId: OpId, cwd: string, path: string, patch: string, reverse?: boolean, };

/**
 * Params of `git/branches`.
 */
export type GitBranchesParams = { cwd: string, };

/**
 * Params of `git/cherryPickCommit`.
 */
export type GitCherryPickCommitParams = { opId: OpId, cwd: string, value: string, };

/**
 * Params of `git/cli/install`.
 */
export type GitCliInstallParams = { opId: OpId, };

/**
 * Params of `git/cliStatus`.
 */
export type GitCliStatusParams = { refresh?: boolean, };

/**
 * Params of `git/commit`.
 */
export type GitCommitParams = { opId: OpId, cwd: string, message: string, };

/**
 * Input of `git/commitPaths` (`gitCommitPaths(cwd, message, paths)`).
 */
export type GitCommitPathsInput = {
/**
 * 1–20 000 characters.
 */
message: string,
/**
 * Repository-relative, 1–500 paths.
 */
paths: Array<string>, };

/**
 * Params of `git/commitPaths`.
 */
export type GitCommitPathsParams = { opId: OpId, cwd: string, input: GitCommitPathsInput, };

/**
 * Params of `git/continue`.
 */
export type GitContinueParams = { opId: OpId, cwd: string, };

/**
 * Params of `git/createTag`.
 */
export type GitCreateTagParams = { opId: OpId, cwd: string, value: string, at: string, };

/**
 * Input of `git/deleteBranch` (`gitDeleteBranch(cwd, branch)`): a local branch.
 */
export type GitDeleteBranchInput = { branch: string, };

/**
 * Params of `git/deleteBranch`.
 */
export type GitDeleteBranchParams = { opId: OpId, cwd: string, input: GitDeleteBranchInput, };

/**
 * Params of `git/deleteTag`.
 */
export type GitDeleteTagParams = { opId: OpId, cwd: string, value: string, };

/**
 * Params of `git/diff`.
 */
export type GitDiffParams = { cwd: string, path: string, staged: boolean, worktreeOnly?: boolean, untracked?: boolean, };

/**
 * Params of `git/fetch`.
 */
export type GitFetchParams = { opId: OpId, cwd: string, };

/**
 * Params of `git/globalConfig/read`.
 */
export type GitGlobalConfigReadParams = Record<string, never>;

/**
 * Params of `git/globalConfig/write`.
 */
export type GitGlobalConfigWriteParams = { opId: OpId, key: string, value: string, };

/**
 * Params of `git/ignore`.
 */
export type GitIgnoreParams = { opId: OpId, cwd: string, path: string, scope?: string, };

/**
 * Params of `git/log`.
 */
export type GitLogParams = { cwd: string, query?: string, skip?: number, limit?: number, };

/**
 * Params of `git/pull`.
 */
export type GitPullParams = { opId: OpId, cwd: string, };

/**
 * Params of `git/push`.
 */
export type GitPushParams = { opId: OpId, cwd: string, };

/**
 * Input of `git/renameBranch` (`gitRenameBranch(cwd, branch, nextBranch)`).
 */
export type GitRenameBranchInput = { branch: string, nextBranch: string, };

/**
 * Params of `git/renameBranch`.
 */
export type GitRenameBranchParams = { opId: OpId, cwd: string, input: GitRenameBranchInput, };

/**
 * Input of `git/requestContext` (`requiredGitRequestContextInput`): the listed
 * repository-relative files (0–500, may be empty) and an optional base branch.
 */
export type GitRequestContextInput = { paths: Array<string>,
/**
 * Absent or empty: no base branch.
 */
base?: string, };

/**
 * Params of `git/requestContext`.
 */
export type GitRequestContextParams = { cwd: string, input: GitRequestContextInput, };

/**
 * Params of `git/resetToCommit`.
 */
export type GitResetToCommitParams = { opId: OpId, cwd: string, value: string, mode: string, confirmedDirty?: boolean, };

/**
 * Params of `git/revertCommit`.
 */
export type GitRevertCommitParams = { opId: OpId, cwd: string, value: string, };

/**
 * Params of `git/revertFile`.
 */
export type GitRevertFileParams = { opId: OpId, cwd: string, path: string, untracked: boolean, mode?: string, };

/**
 * Params of `git/showDiff`.
 */
export type GitShowDiffParams = { cwd: string, hash: string, path: string, };

/**
 * Params of `git/showFile`.
 */
export type GitShowFileParams = { cwd: string, rev: string, path: string, };

/**
 * Params of `git/show`.
 */
export type GitShowParams = { cwd: string, hash: string, };

/**
 * Params of `git/stage`.
 */
export type GitStageParams = { opId: OpId, cwd: string, paths: Array<string>, };

/**
 * Params of `git/stashApply`.
 */
export type GitStashApplyParams = { opId: OpId, cwd: string, ref: string, };

/**
 * Params of `git/stashDrop`.
 */
export type GitStashDropParams = { opId: OpId, cwd: string, ref: string, };

/**
 * Params of `git/stashList`.
 */
export type GitStashListParams = { cwd: string, };

/**
 * Params of `git/stash`.
 */
export type GitStashParams = { opId: OpId, cwd: string, message?: string, };

/**
 * Params of `git/stashPop`.
 */
export type GitStashPopParams = { opId: OpId, cwd: string, };

/**
 * Params of `git/status`.
 */
export type GitStatusParams = { cwd: string, reuseLineStats?: boolean, skipLineStats?: boolean, };

/**
 * Params of `git/sync`.
 */
export type GitSyncParams = { opId: OpId, cwd: string, };

/**
 * Params of `git/undoLastCommit`.
 */
export type GitUndoLastCommitParams = { opId: OpId, cwd: string, };

/**
 * Params of `git/unstage`.
 */
export type GitUnstageParams = { opId: OpId, cwd: string, paths: Array<string>, };

/**
 * Params of `git/unwatch`.
 */
export type GitUnwatchParams = { cwd: string, };

/**
 * Params of `git/watch`.
 */
export type GitWatchParams = { cwd: string, };

/**
 * Params of `github/account`.
 */
export type GithubAccountParams = Record<string, never>;

/**
 * Params of `github/install`.
 */
export type GithubInstallParams = { opId: OpId, };

/**
 * Params of `github/login/cancel`.
 */
export type GithubLoginCancelParams = { opId: OpId, flowId: LoginFlowId, };

/**
 * Params of `github/login/openBrowser`.
 */
export type GithubLoginOpenBrowserParams = { opId: OpId, flowId: LoginFlowId, };

/**
 * Params of `github/login/start`.
 */
export type GithubLoginStartParams = { opId: OpId, openBrowser?: boolean, };

/**
 * Params of `github/login/status`.
 */
export type GithubLoginStatusParams = { flowId: LoginFlowId, };

/**
 * Params of `github/logout`.
 */
export type GithubLogoutParams = { opId: OpId, };

/**
 * Params of `github/pr/checkout`.
 */
export type GithubPrCheckoutParams = { opId: OpId, cwd: string, value: JsonValue, };

/**
 * Params of `github/pr/create`.
 */
export type GithubPrCreateParams = { opId: OpId, cwd: string, value: JsonValue, };

/**
 * Params of `github/pr/defaultBranch`.
 */
export type GithubPrDefaultBranchParams = { cwd: string, };

/**
 * Params of `github/pr/diff`.
 */
export type GithubPrDiffParams = { cwd: string, value: JsonValue, };

/**
 * Params of `github/pr/list`.
 */
export type GithubPrListParams = { cwd: string, };

/**
 * Params of `github/pr/merge`.
 */
export type GithubPrMergeParams = { opId: OpId, cwd: string, value: JsonValue, method: JsonValue, };

/**
 * Params of `github/pr/view`.
 */
export type GithubPrViewParams = { cwd: string, value: JsonValue, };

/**
 * Params of `github/request`.
 */
export type GithubRequestParams = { opId: OpId, cwd: string, input: JsonValue, };

/**
 * Params of `github/star`.
 */
export type GithubStarParams = { opId: OpId, };

/**
 * Params of `github/starStatus`.
 */
export type GithubStarStatusParams = Record<string, never>;

/**
 * Params of `github/status`.
 */
export type GithubStatusParams = { refresh?: boolean, };

export type GpuVendor = "NVIDIA" | "Apple";

/**
 * A held request of an unattended run (Node `meta.heldRequest`, `normalizeHeldRequest`). The
 * desktop paints a pending one as an approval card and answers it with `id` through the
 * ordinary approval call; `status` and `device` show how it settled.
 */
export type HeldRequest = { id: string, status: HeldRequestStatus, agentId: string,
/**
 * `approval` unless the request says otherwise.
 */
kind: string, tool: string, target: string, reason: string,
/**
 * The outbound text the card may show; never a secret.
 */
payload?: string, action?: string, account?: string, editable?: Array<string>, details?: { [key in string]?: string },
/**
 * The remember scopes the request allows.
 */
remember?: Array<string>, run: HeldRun, expiresAt?: number, device?: string, };

export type HeldRequestStatus = "pending" | "approved" | "denied" | "expired";

/**
 * The run that was held.
 */
export type HeldRun = { kind: HeldRunKind, name: string, sessionId?: string, };

export type HeldRunKind = "schedule" | "webhook" | "room";

export type HistoryResetReason = "rewind" | "clear";

/**
 * `host/browser/surface` (host → core notification): the window process's browser host asked its
 * window to reveal or hide a session's browser surface (`browserRemoteOpen`). The core publishes
 * it as `ui/openRequested { kind: "browser" }` so every attached client, paired phones included,
 * opens the same surface. Fields are `UiOpenBrowser`'s.
 */
export type HostBrowserSurfaceParams = { sessionId: string, reveal?: boolean, hide?: boolean, handoff?: boolean, tabId?: string, title?: string, error?: string, };

/**
 * First viewer → `on`, last viewer gone → `off` (SPEC §4.7.3).
 */
export type HostBrowserViewFramesParams = { tabId: string,
/**
 * The X17 `streamId` the host stamps on this tab's frames.
 */
streamId: number, on: boolean,
/**
 * Phone stream request (fit, quality) as today's take-over request.
 */
request: JsonValue, };

/**
 * The desktop host role (DS §12.2): what this connection serves for the core.
 */
export type HostCapabilities = {
/**
 * In-app browser: `host/browser/command`, `item/browser/requestApproval` presentation.
 */
browser: boolean, visualize: boolean,
/**
 * OS toast and sound: `host/notification/show`.
 */
notifications: boolean,
/**
 * `host/systemProxy/resolve`.
 */
systemProxy: boolean,
/**
 * Sends `host/power`.
 */
power: boolean,
/**
 * May send X17 binary media frames.
 */
media: boolean,
/**
 * Desktop updater: `host/update/command`, sends `host/update/report`.
 */
updater: boolean,
/**
 * File snapshots and the local page server.
 */
files: boolean, };

/**
 * Claims the host role for this install (`hostId` generated per install).
 */
export type HostClaimParams = { hostId: HostId, };

export type HostCommandParams = { action: string, input?: JsonValue, threadId?: ThreadId, };

/**
 * Result of `host/capture/fileSnapshot`: the picture of the file.
 */
export type HostFileSnapshot = {
/**
 * `data:image/png;base64,…` or `data:image/jpeg;base64,…`.
 */
dataUrl: string, mtimeMs: number, size: number, };

/**
 * Params of `host/capture/fileSnapshot` (core → host). The core has already confined the path.
 */
export type HostFileSnapshotParams = { root: string, rel: string, grant?: boolean, };

/**
 * Per-install desktop host id claimed with `host/claim`.
 */
export type HostId = string;

/**
 * Params of `host/localPage/url` (core → host); the result is the URL string.
 */
export type HostLocalPageUrlParams = { root: string, rel: string, scope?: LocalPageScope, };

export type HostNotificationClickedParams = { threadId: ThreadId, };

export type HostNotificationShowParams = { title: string, body: string, threadId?: ThreadId, sound?: string, volume?: number, };

/**
 * Result of `host/notification/status` (Node's host method `notificationStatus`).
 */
export type HostNotificationStatus = {
/**
 * Whether this PC can show OS notifications (`Notification.isSupported()`).
 */
supported: boolean,
/**
 * The OS's system idle time in seconds (`powerMonitor.getSystemIdleTime()`: input anywhere
 * on the PC counts); `null` when the host cannot tell, which the caller treats as not
 * active. The caller judges it against its own window (Node: 180 s).
 */
idleSeconds: number | null, };

/**
 * Params of `host/notification/status` (core → host): none.
 */
export type HostNotificationStatusParams = Record<string, never>;

export type HostPowerParams = { event: PowerEvent, };

/**
 * SSH server core the local core bridges phone connections to (R25).
 */
export type HostRemoteTargetSetParams = {
/**
 * `ws://127.0.0.1:<port>/rpc` of the tunnel; absent = the local core.
 */
endpoint?: string, token?: string, };

/**
 * Publishes desktop-owned state into section `hostState`: `{key, value}`, the value's shape
 * picked by the key. Only `visualize` is typed; the others stay the desktop's own JSON.
 */
export type HostStateSetParams = { "key": "browserTabs", "value": JsonValue } | { "key": "browserImport", "value": JsonValue } | { "key": "visualize", "value": VisualizeHostValue } | { "key": "displayPreferences", "value": JsonValue };

export type HostSystemProxyResolveParams = { url: string, };

export type HostSystemProxyResolveResponse = {
/**
 * Chromium proxy rules for the URL (`DIRECT`, `PROXY host:port`, …).
 */
rules: string, };

/**
 * Params of `host/update/command` (core → host).
 */
export type HostUpdateCommandParams = { action: UpdaterAction,
/**
 * Node's `updaterInstall` argument `args[0]`: the user confirmed the install.
 */
confirmed?: boolean, };

/**
 * Today's `DesktopUpdaterState`.
 */
export type HostUpdateReportParams = { state: JsonValue, };

/**
 * Params of `host/visualize/command` (core → host): the loopback bridge's request body.
 * The result is the service's object (`{text, tabs?, path?, …}`), `null` when it returns nothing
 * (`visualizeCommand`: `(await visualize.command(…)) ?? null`).
 */
export type HostVisualizeCommandParams = { sessionId: string, cwd: string, action: VisualizeAction, input?: JsonValue, };

export type HumanGateResponse = "approve" | "deny" | "edit-and-approve" | "provide-secret" | "skip" | "done";

/**
 * Byte-free image metadata of a user row (`images`): its chip.
 */
export type ImageChip = { id?: ImageChipId, name: string, mimeType: string, bytes: number, attachmentRef?: string, };

/**
 * `id` of an image chip: the paste number or a string id.
 */
export type ImageChipId = bigint | string;

/**
 * The stored original of one restored `[Image: …]` line (`imageRefs`); an
 * image without a stored original has no `ref`, so later images keep their slot.
 */
export type ImageRef = { line: string, ref?: string, };

/**
 * Params of `import/cancelConversationImport`.
 */
export type ImportCancelConversationImportParams = { opId: OpId, threadId?: ThreadId, params: JsonValue, };

/**
 * Params of `import/getConversationImportJobs`.
 */
export type ImportGetConversationImportJobsParams = { threadId?: ThreadId, params?: JsonValue, };

/**
 * Params of `import/listImportableConversations`.
 */
export type ImportListImportableConversationsParams = { threadId?: ThreadId, params: JsonValue, };

/**
 * Params of `import/registerConversationImportFile`.
 */
export type ImportRegisterConversationImportFileParams = { opId: OpId, threadId?: ThreadId, params: JsonValue, };

/**
 * Params of `import/startConversationImport`.
 */
export type ImportStartConversationImportParams = { opId: OpId, threadId?: ThreadId, params: JsonValue, };

/**
 * One tool of an imported run: its name and how many times it ran.
 */
export type ImportedTool = { name: string, count: number, };

/**
 * A run of tool use inside an imported assistant message's text. `start`/`end` locate the
 * run's canonical line (`[ran tools: shell ×6, Read ×2]`) in `text` as UTF-16 code-unit
 * offsets, Node's string indices; the client keeps a run only where the text still holds
 * that line, and draws the text around the runs as assistant rows. The calls' results were
 * never imported.
 */
export type ImportedToolRun = { start: number, end: number, tools: Array<ImportedTool>, };

export type InitializeCapabilities = {
/**
 * Exact notification methods suppressed for this connection.
 */
optOutNotificationMethods?: Array<string>, experimentalApi?: boolean,
/**
 * Receive every pending approval request even without a thread subscription (P §8.3).
 */
approvalsInbox?: boolean, host?: HostCapabilities,
/**
 * Executes `model/proxy/execute` with this machine's accounts (DS §12.4).
 */
modelProxy?: boolean, };

export type InitializeParams = { clientInfo: ClientInfo, capabilities?: InitializeCapabilities, };

export type InitializeResponse = { userAgent: string, platformFamily: string, platformOs: string, serverVersion: string, serverBuild: string,
/**
 * Changes on every core start; a different value means every held epoch is stale.
 */
serverInstanceId: string, coreState: CoreState, limits: Limits, capabilities: ServerCapabilities, connection: ConnectionInfo, };

/**
 * A module with a separate install step (`git`, `office`, `tidy`, `visualize`, `media`).
 */
export type InstallableModule = { enabled: boolean, installed: boolean, };

export type InstructionFilesMode = "all" | "agents" | "claude" | "off";

/**
 * Params of `instructions/getInstructionFile`.
 */
export type InstructionsGetInstructionFileParams = { threadId?: ThreadId, group: string, id: string, };

/**
 * Params of `instructions/listInstructionFiles`.
 */
export type InstructionsListInstructionFilesParams = { threadId?: ThreadId, };

/**
 * Params of `instructions/resetInstructionFile`.
 */
export type InstructionsResetInstructionFileParams = { opId: OpId, threadId?: ThreadId, group: string, id: string, expectedRevision?: JsonValue, };

/**
 * Params of `instructions/saveInstructionFile`.
 */
export type InstructionsSaveInstructionFileParams = { opId: OpId, threadId?: ThreadId, input: JsonValue, };

/**
 * Params of `instructions/setInstructionFiles`.
 */
export type InstructionsSetInstructionFilesParams = { opId: OpId, threadId?: ThreadId, mode: string, };

/**
 * Deltas are hints; `item/completed` is authoritative.
 */
export type ItemDeltaParams = { threadId: ThreadId, turnId: TurnId, itemId: ItemId, delta: string,
/**
 * Reasoning summary part index.
 */
index?: number, };

/**
 * A transcript item; assigned when the item starts and never reused.
 */
export type ItemId = string;

/**
 * Attributes shared by every item (today's `DesktopTranscriptItem` common fields).
 */
export type ItemMeta = { turnId?: TurnId, at?: number, status?: ItemStatus, label?: string, detail?: string,
/**
 * Human-readable model label.
 */
model?: string,
/**
 * Actual route id.
 */
modelId?: string, provider?: string, agent?: string,
/**
 * The stable message id of the row's message (`meta.transcript.messageId`):
 * what a compaction's dropped-message ids and a room line's `room.id` name.
 */
messageId?: string,
/**
 * Delivered into the thread outside any turn (agent-home delivery).
 */
posted?: boolean,
/**
 * Remaining row attributes of today's transcript row.
 */
ext: { [key in string]?: JsonValue }, };

export type ItemNotificationParams = { threadId: ThreadId, turnId: TurnId, item: ThreadItem, };

export type ItemStatus = "inProgress" | "completed" | "failed" | "declined" | "interrupted";

/**
 * Opaque cursor, or an item anchor (today's `before`/`after` row reads).
 */
export type ItemsCursor = string | {
/**
 * Always `item`.
 */
type: string, itemId: ItemId, };

export type JsonRpcError = { error: JsonRpcErrorBody, id: RequestId, };

/**
 * `data` is always `{"reason": "<camelCase>", …typed fields}` (`ErrorData`);
 * clients branch on `code` + `data.reason` only and never parse `message`.
 */
export type JsonRpcErrorBody = { code: number, data?: JsonValue, message: string, };

/**
 * Any message that can be decoded off the wire or encoded onto it.
 */
export type JsonRpcMessage = JsonRpcRequest | JsonRpcNotification | JsonRpcResponse | JsonRpcError;

export type JsonRpcNotification = { method: string, params?: JsonValue,
/**
 * Emission time of a server notification (a flattened field).
 */
emittedAtMs?: number,
/**
 * Present on every notification that belongs to a feed; absent on
 * connection-scoped notifications and client notifications.
 */
feed?: FeedStamp, };

export type JsonRpcRequest = { id: RequestId, method: string, params?: JsonValue, trace?: W3cTraceContext, };

export type JsonRpcResponse = { id: RequestId, result: JsonValue, };

export type JsonValue = number | string | boolean | Array<JsonValue> | { [key in string]?: JsonValue } | null;

export type Limits = { maxInboundFrameBytes: number,
/**
 * Host role only (X17): raw BGRA bound of the pinned live-view size.
 */
maxMediaFrameBytes: number,
/**
 * `INLINE_MAX`.
 */
maxItemFieldBytes: number,
/**
 * Outbound non-snapshot frame bound.
 */
maxFrameBytes: number, queueBytes: number, controlReserveBytes: number, eventBudgetBytes: number, maxSnapshotBytes: number, ringBytes: number, appRingBytes: number,
/**
 * Terminal feed replay ring, in characters (`REPLAY_BUFFER_LIMIT`).
 */
terminalRingChars: number, maxBlobPageBytes: number,
/**
 * Raw `blob/put` chunk bound, so the frame stays under `maxInboundFrameBytes` after base64.
 */
maxBlobPutChunkBytes: number,
/**
 * Per-connection in-flight cap per request class.
 */
inflight: ClassLimits, maxConnections: number, heartbeatTickMs: number, maxProcesses: number,
/**
 * Per-terminal input buffer before socket reads pause (P §7.3).
 */
terminalInputBufferBytes: number, };

export type LocalDisk = { availableBytes: number | null, };

/**
 * One GPU. An Apple GPU reports its name and shared memory only.
 */
export type LocalGpu = { index?: number, uuid?: string, vendor: GpuVendor, name: string, memoryBytes: number, freeMemoryBytes?: number, };

export type LocalHardware = { platform: string, arch: string, gpu: LocalGpu | null, gpus: Array<LocalGpu>, supported: boolean,
/**
 * Detection still running.
 */
checking: boolean,
/**
 * Epoch ms of the last completed detection.
 */
checkedAt: number | null, error: string | null, };

/**
 * The model's latest request. A `running` one carries `queueWaitMs` only.
 */
export type LocalInference = { "state": "running", queueWaitMs: number, } | { "state": "complete" } & LocalInferenceEnd | { "state": "failed" } & LocalInferenceEnd;

/**
 * An ended request: every member is present, `null` when the request did not measure it.
 */
export type LocalInferenceEnd = {
/**
 * ISO time the request ended.
 */
at: string, queueWaitMs: number, durationMs: number, firstResponseMs: number | null, outputTokens: number | null, inputTokens: number | null, tokensPerSecond: number | null, error: string | null, };

export type LocalInstallPhase = "runtime" | "model";

export type LocalInstallState = "running" | "failed" | "paused" | "complete";

/**
 * A live installation job, or a paused partial download found on disk (no `jobId`).
 */
export type LocalInstallation = { jobId?: string, phase: LocalInstallPhase, modelId?: string | null, state: LocalInstallState,
/**
 * `preparing`, `verifying`, `paused`, `complete`, or a download stage.
 */
stage: string,
/**
 * `null` while unknown.
 */
percent: number | null, updatedAt?: number, error?: string | null,
/**
 * Paused partial downloads only.
 */
receivedBytes?: number, totalBytes?: number, };

/**
 * One catalog model (Node's `publicModel`).
 */
export type LocalModel = { id: string, name: string, description: string, sizeBytes: number, remainingDownloadBytes: number, estimatedVramBytes: number, minimumVramBytes: number,
/**
 * The user's context size; `null` runs the default.
 */
configuredContextWindow: number | null, defaultContextWindow: number, minContextWindow: number, maxContextWindow: number, contextWindow: number, runtimeContextWindow: number, supportsFunctionCalling?: boolean, supportsReasoning?: boolean, supportsImages: boolean, supportsReasoningSettings: boolean, architecture?: string, compatibility: string, revision?: string, capabilities?: LocalModelCapabilities, loadTimeMs?: number | null, inference?: LocalInference, verification?: LocalVerification, license: string, source: string, recommended: boolean,
/**
 * The GPU has the model's minimum VRAM.
 */
compatible: boolean,
/**
 * The weights file is complete.
 */
installed: boolean,
/**
 * Some file exists, complete or partial.
 */
present: boolean, };

/**
 * What the running server reported when a model loaded.
 */
export type LocalModelCapabilities = {
/**
 * Tool support: `null` when the template does not say.
 */
tools: boolean | null, images: boolean, audio: boolean, video: boolean, reasoningSettings: boolean, };

/**
 * What a `host/localPage/url` lease covers; absent means `project`.
 */
export type LocalPageScope = "file" | "project";

/**
 * Params of `localProvider/cancelLocalProviderInstallation`.
 */
export type LocalProviderCancelLocalProviderInstallationParams = { opId: OpId, threadId?: ThreadId, jobId: string, };

/**
 * Params of `localProvider/deleteLocalProviderModel`.
 */
export type LocalProviderDeleteLocalProviderModelParams = { opId: OpId, threadId?: ThreadId, confirmationToken: string, };

/**
 * Params of `localProvider/discardLocalProviderInstallation`.
 */
export type LocalProviderDiscardLocalProviderInstallationParams = { opId: OpId, threadId?: ThreadId, phase: string, modelId?: string, };

/**
 * Params of `localProvider/getLocalProviderModelDetails`.
 */
export type LocalProviderGetLocalProviderModelDetailsParams = { threadId?: ThreadId, modelId: string, };

/**
 * Params of `localProvider/inspectHuggingFaceModel`.
 */
export type LocalProviderInspectHuggingFaceModelParams = { threadId?: ThreadId, options: JsonValue, };

/**
 * Params of `localProvider/installLocalProviderModel`.
 */
export type LocalProviderInstallLocalProviderModelParams = { opId: OpId, threadId?: ThreadId, modelId: string, };

/**
 * The `localProvider` module: catalog status, server and queue status, installations and the
 * switches, flattened as Node merges them.
 */
export type LocalProviderModule = { platformSupported: boolean, available: boolean, runtime: LocalRuntime, hardware: LocalHardware, disk: LocalDisk, models: Array<LocalModel>, recommendation: LocalModel | null, running: boolean, starting: boolean, activeModel: string | null, gpu: LocalGpu | null, loadTimeMs: number | null, lastExit: LocalServerExit | null, lastError: string | null, activeRequests: number, queuedRequests: number, idleTtlSeconds: number,
/**
 * Epoch ms the idle server unloads, while armed.
 */
idleDeadline: number | null, lastUnloadError: string | null, installations: Array<LocalInstallation>,
/**
 * The last installation command's failure, until the next command.
 */
installationCommandError: string | null, enabled: boolean,
/**
 * The runtime is installed and the module is installed.
 */
installed: boolean, };

/**
 * Params of `localProvider/registerHuggingFaceModel`.
 */
export type LocalProviderRegisterHuggingFaceModelParams = { opId: OpId, threadId?: ThreadId, previewId: string, licenseAccepted: boolean, };

/**
 * Params of `localProvider/searchLocalProviderModels`.
 */
export type LocalProviderSearchLocalProviderModelsParams = { threadId?: ThreadId, query: string, };

/**
 * Params of `localProvider/setLocalProviderContext`.
 */
export type LocalProviderSetLocalProviderContextParams = { opId: OpId, threadId?: ThreadId, modelId: string, tokens: number, };

/**
 * Params of `localProvider/setLocalProviderIdleTtl`.
 */
export type LocalProviderSetLocalProviderIdleTtlParams = { opId: OpId, threadId?: ThreadId, seconds: number, };

/**
 * Params of `localProvider/startLocalProviderInstallation`.
 */
export type LocalProviderStartLocalProviderInstallationParams = { opId: OpId, threadId?: ThreadId, phase: string, modelId?: string, };

/**
 * Params of `localProvider/startLocalProviderModelMaintenance`.
 */
export type LocalProviderStartLocalProviderModelMaintenanceParams = { opId: OpId, threadId?: ThreadId, modelId: string, operation: string, };

export type LocalRuntime = { installed: boolean, version: string, downloadBytes: number, source: string, license: string,
/**
 * Empty on an unsupported platform.
 */
backend: string, };

/**
 * How the last server process ended.
 */
export type LocalServerExit = {
/**
 * ISO time.
 */
at: string, modelId: string, exitCode: number | null, signal: string | null,
/**
 * The stop was asked for.
 */
expected: boolean,
/**
 * Redacted tail of the server log.
 */
log: string, };

/**
 * The last integrity check of the model file.
 */
export type LocalVerification = { valid: boolean, sizeBytes: number, sha256: string,
/**
 * ISO time of the check.
 */
at: string, };

/**
 * A login flow (GitHub CLI, provider OAuth, MCP OAuth).
 */
export type LoginFlowId = string;

export type LoginUpdatedParams = { flowId: LoginFlowId,
/**
 * Device code, verification URL, `waiting|done|failed`, error.
 */
state: JsonValue, };

/**
 * Params of `lsp/document`.
 */
export type LspDocumentParams = { projectPath: string, root: string, document: JsonValue, };

/**
 * Params of `lsp/request`.
 */
export type LspRequestParams = { opId: OpId, projectPath: string, root: string, request: JsonValue, };

/**
 * Params of `lsp/subscribe` and `lsp/unsubscribe`.
 */
export type LspSubscribeParams = {
/**
 * The project root; the feed is `lsp:<root>`.
 */
root: string, };

/**
 * A body that is inline when its encoding is ≤ `INLINE_MAX`, else a blob reference.
 */
export type MaybeBlob<T> = BlobRef | T;

/**
 * Params of `mcp/addMcpServer`.
 */
export type McpAddMcpServerParams = { opId: OpId, threadId?: ThreadId, input: JsonValue, };

/**
 * Params of `mcp/beginMcpOAuthLogin`.
 */
export type McpBeginMcpOAuthLoginParams = { opId: OpId, threadId?: ThreadId, name: string, options?: JsonValue, };

/**
 * Params of `mcp/cancelMcpOAuthLogin`.
 */
export type McpCancelMcpOAuthLoginParams = { opId: OpId, threadId?: ThreadId, flowId: LoginFlowId, };

/**
 * Params of `mcp/completeMcpOAuthLogin`.
 */
export type McpCompleteMcpOAuthLoginParams = { opId: OpId, threadId?: ThreadId, flowId: LoginFlowId, callbackUrl: string, };

/**
 * Params of `mcp/enablePluginMcp`.
 */
export type McpEnablePluginMcpParams = { opId: OpId, threadId?: ThreadId, plugin: JsonValue, };

/**
 * Params of `mcp/getMcpOAuthLoginStatus`.
 */
export type McpGetMcpOAuthLoginStatusParams = { threadId?: ThreadId, flowId: LoginFlowId, options?: JsonValue, };

/**
 * Params of `mcp/getMcpServerConfig`.
 */
export type McpGetMcpServerConfigParams = { threadId?: ThreadId, name: string, };

/**
 * Params of `mcp/mcpStatus`.
 */
export type McpMcpStatusParams = { threadId?: ThreadId, };

/**
 * Params of `mcp/probeMcpServerAuth`.
 */
export type McpProbeMcpServerAuthParams = { opId: OpId, threadId?: ThreadId, cfg: JsonValue, };

/**
 * Params of `mcp/reconnectMcp`.
 */
export type McpReconnectMcpParams = { opId: OpId, threadId?: ThreadId, name?: string, };

/**
 * Params of `mcp/removeMcpServer`.
 */
export type McpRemoveMcpServerParams = { opId: OpId, threadId?: ThreadId, name: string, };

/**
 * Params of `mcp/saveMcpServer`.
 */
export type McpSaveMcpServerParams = { opId: OpId, threadId?: ThreadId, input: JsonValue, };

/**
 * Params of `mcp/setMcpServerEnabled`.
 */
export type McpSetMcpServerEnabledParams = { opId: OpId, threadId?: ThreadId, name: string, enabled: boolean, };

/**
 * Params of `mcp/signOutMcpServer`.
 */
export type McpSignOutMcpServerParams = { opId: OpId, threadId?: ThreadId, name: string, };

/**
 * Params of `media/cacheMediaThumbnail`.
 */
export type MediaCacheMediaThumbnailParams = { opId: OpId, threadId?: ThreadId, id: string, input: JsonValue, };

/**
 * Params of `media/cancelMediaJob`.
 */
export type MediaCancelMediaJobParams = { opId: OpId, threadId?: ThreadId, id: string, };

/**
 * Params of `media/createMediaBoard`.
 */
export type MediaCreateMediaBoardParams = { opId: OpId, threadId?: ThreadId, name: string, };

/**
 * Params of `media/deleteMediaAsset`.
 */
export type MediaDeleteMediaAssetParams = { opId: OpId, threadId?: ThreadId, id: string, };

/**
 * Params of `media/deleteMediaAssets`.
 */
export type MediaDeleteMediaAssetsParams = { opId: OpId, threadId?: ThreadId, filter: JsonValue, };

/**
 * Params of `media/deleteMediaBoard`.
 */
export type MediaDeleteMediaBoardParams = { opId: OpId, threadId?: ThreadId, id: string, };

export type MediaFormat = "jpeg";

export type MediaFrameHeader = { purpose: MediaPurpose, flags: number,
/**
 * Stream id assigned by `host/browser/viewFrames`.
 */
streamId: number, width: number, height: number, format: MediaFormat, };

/**
 * Params of `media/getMediaDefault`.
 */
export type MediaGetMediaDefaultParams = { threadId?: ThreadId, kind: string, };

/**
 * Params of `media/getMediaJob`.
 */
export type MediaGetMediaJobParams = { threadId?: ThreadId, id: string, };

/**
 * Params of `media/getMediaPins`.
 */
export type MediaGetMediaPinsParams = { threadId?: ThreadId, };

/**
 * Params of `media/listMediaAssets`.
 */
export type MediaListMediaAssetsParams = { threadId?: ThreadId, options?: JsonValue, };

/**
 * Params of `media/listMediaBoards`.
 */
export type MediaListMediaBoardsParams = { threadId?: ThreadId, };

/**
 * Params of `media/listMediaLanes`.
 */
export type MediaListMediaLanesParams = { threadId?: ThreadId, options?: JsonValue, };

/**
 * Params of `media/openMediaAsset`.
 */
export type MediaOpenMediaAssetParams = { opId: OpId, threadId?: ThreadId, id: string, };

/**
 * Params of `media/openMediaFolder`.
 */
export type MediaOpenMediaFolderParams = { opId: OpId, threadId?: ThreadId, id?: string, };

export type MediaPurpose = "browserView";

/**
 * Params of `media/readMediaAsset`.
 */
export type MediaReadMediaAssetParams = { threadId?: ThreadId, id: string, options?: JsonValue, };

/**
 * Params of `media/renameMediaBoard`.
 */
export type MediaRenameMediaBoardParams = { opId: OpId, threadId?: ThreadId, id: string, name: string, };

/**
 * Params of `media/resolveMediaFile`.
 */
export type MediaResolveMediaFileParams = { threadId?: ThreadId, id: string, options?: JsonValue, };

/**
 * Params of `media/setMediaAssetBoard`.
 */
export type MediaSetMediaAssetBoardParams = { opId: OpId, threadId?: ThreadId, ids: Array<string>, boardId: JsonValue, };

/**
 * Params of `media/setMediaDefault`.
 */
export type MediaSetMediaDefaultParams = { opId: OpId, threadId?: ThreadId, input: JsonValue, };

/**
 * Params of `media/setMediaPin`.
 */
export type MediaSetMediaPinParams = { opId: OpId, threadId?: ThreadId, input: JsonValue, };

/**
 * Params of `media/startMediaJob`.
 */
export type MediaStartMediaJobParams = { opId: OpId, threadId?: ThreadId, input: JsonValue, };

/**
 * Params of `memory/memoryControl`.
 */
export type MemoryMemoryControlParams = { opId: OpId, threadId?: ThreadId, args?: JsonValue, };

export type MemoryModule = { enabled: boolean, installed: boolean, info: EmbeddingInfo, semanticSearchSupported: boolean, };

/**
 * Params of `memory/recall`.
 */
export type MemoryRecallParams = { opId: OpId, threadId?: ThreadId, query: string, args?: JsonValue, };

/**
 * One attachment of a user message (`meta.transcript.attachments`, `normalizeMessageAttachments`).
 */
export type MessageAttachment = {
/**
 * The content hash (64 lowercase hex, no `sha256:` prefix) the attachment store keeps the bytes under.
 */
id: string,
/**
 * The same hash again: the key the store's census marks as referenced.
 */
attachmentRef: string, kind: AttachmentKind, name: string, mimeType: string, size: number, original?: AttachmentOriginal, };

/**
 * A bot's emoji reaction on a user message, one per bot, in the order left.
 */
export type MessageReaction = { agentId: string, emoji: string, at?: number, };

/**
 * What a stored user-role message is (Node's `meta.source`). Absent on `UserRowDetails` means
 * a typed prompt. Everything but a typed prompt, `Import`, `RoutineTrigger` and `Steering`
 * is runtime-written text: a client shows it as the notice or card it stands for and never
 * as the user's own words, and the core never sends such text as a plain prompt.
 */
export type MessageSource = "import" | "routine-trigger" | "steering" | "schedule-result" | "held-request" | "task-notification" | "compact-summary" | "compact-context" | "compact-active-turn-continuation" | "compact-execution-recovery" | "context-ack" | "skill-context" | "goal-continuation" | "goal-closeout" | "max-output-recovery" | "refusal-recovery" | "stream-cut-recovery" | "content-filter-recovery" | "turn-limit";

/**
 * Params of `model/list`.
 */
export type ModelListParams = { force?: boolean, refresh?: boolean, quick?: boolean, };

/**
 * Server core → the connection running a `model/proxy/execute` request: the call was given up
 * (cancelled, abandoned); stop spending on it. The connection's answer is no longer read.
 */
export type ModelProxyCancelParams = { requestId: RequestId, };

/**
 * Electron → server core: one streamed event of a `model/proxy/execute` request.
 */
export type ModelProxyEventParams = { requestId: RequestId, event: ProxyEvent, };

/**
 * Server core → a connection with `capabilities.modelProxy`: run one model call
 * with this machine's accounts. Completion is the response; losing the
 * connection resolves the call `cancelled`.
 */
export type ModelProxyExecuteParams = { call: ProxyCall, };

/**
 * Electron → server core: these `model/proxy/execute` requests are still being run; the first beat of a request claims it, each renews its lease.
 */
export type ModelProxyHeartbeatParams = { requestIds: Array<RequestId>, };

/**
 * A failed call answers with a JSON-RPC error whose data is a
 * [`crate::v2::model_proxy::ProxyFailure`].
 */
export type ModelProxyResult = { result: ProxyAnswer, };

/**
 * Electron → its local core: stop the `modelProxy/run` run `run_id` (the abort of a
 * `model/proxy/cancel`).
 */
export type ModelProxyRunCancelParams = { runId: string, };

/**
 * Local core → Electron: one streamed event of a `modelProxy/run` request.
 */
export type ModelProxyRunEventParams = { runId: string, event: ProxyEvent, };

/**
 * Electron → its local core: execute a proxied call.
 */
export type ModelProxyRunParams = {
/**
 * Stream id the local core stamps on `modelProxy/run/event`.
 */
runId: string, call: ProxyCall,
/**
 * The providers this server may use through this PC: the host's saved list, `null` for every provider enabled here. Always sent: a message without it is refused, never read as every provider.
 */
allowedProviders: Array<string> | null, };

export type ModelRequestPhase = "started" | "completed" | "failed";

/**
 * `thread/modelRequest/updated`: one provider request of a turn (Node `model.request.*`).
 * Request ids are `model_request_<index>`, the index counting from 1.
 */
export type ModelRequestUpdatedParams = { threadId: ThreadId, turnId: TurnId, requestId: string, requestIndex: number, phase: ModelRequestPhase,
/**
 * On `completed` and `failed`.
 */
durationMs?: number,
/**
 * Node's usage delta summary of the request, on `completed`.
 */
usage?: JsonValue, };

/**
 * Today's `DesktopModelSelection`.
 */
export type ModelSelection = { provider: string, model: string, effort?: string, fast?: boolean, autoEffort?: boolean, modelParameters?: { [key in string]?: string }, contextPercent?: number, contextTokens?: number,
/**
 * The Lead's ordered fallback models; `[]` clears, absent keeps.
 */
fallbacks?: Array<ModelSelection>,
/**
 * Compare-and-set: applied only while the target route has no model.
 */
onlyIfEmpty?: boolean, };

/**
 * Mutation column of a method row.
 */
export type Mutation = { "kind": "none" } | { "kind": "op", "domain": OpDomain };

/**
 * Today's `DesktopNewTaskDraft`.
 */
export type NewTaskDraft = { projectPath?: string, route?: ModelSelection, workflowId?: string, orchestrationMode?: OrchestrationMode,
/**
 * Today's `DesktopNewTaskWorktree`.
 */
worktree?: JsonValue, };

/**
 * One device's preferences (this PC under device id `pc`, a paired device under its client id).
 */
export type NotificationDevicePreferences = { scope: NotificationScope, events: NotificationEvents,
/**
 * Final answers and errors of turns a schedule or webhook started.
 */
automaticRuns: boolean, quietHours: NotificationQuietHours,
/**
 * Paired devices: wait while this PC has recent user input.
 */
holdWhileDesktopActive: boolean,
/**
 * This PC: flash the taskbar.
 */
taskbarFlash: boolean, };

/**
 * Which kinds of event notify.
 */
export type NotificationEvents = { finished: boolean, question: boolean, approval: boolean, error: boolean, };

/**
 * The value of config key `notifications`.
 */
export type NotificationPreferences = {
/**
 * When the store was first written: devices paired before it keep today's behaviour.
 */
migratedAt: number,
/**
 * By device id.
 */
devices: { [key in string]?: NotificationDevicePreferences }, overrides: Array<ConversationNotificationOverride>, };

export type NotificationQuietDays = "every" | "weekdays" | "weekends";

export type NotificationQuietHours = { enabled: boolean,
/**
 * `HH:MM` on the PC's local clock; an end at or before the start spans midnight.
 */
start: string, end: string, days: NotificationQuietDays,
/**
 * Questions and approvals still notify inside quiet hours.
 */
allowWaiting: boolean, };

export type NotificationScope = "all" | "bots" | "off";

/**
 * What a conversation override is attached to.
 */
export type NotificationTarget = { kind: NotificationTargetKind,
/**
 * 1–200 of `[A-Za-z0-9_.:-]`.
 */
id: string, };

export type NotificationTargetKind = "session" | "agent" | "room";

/**
 * Params of `notify/test`.
 */
export type NotifyTestParams = { opId: OpId, target?: string, };

/**
 * Owner scope of a mutation's op record (P §9.2). For a method whose
 * serialization scope resolves to a thread, the op scope is that thread.
 */
export type OpDomain = "core" | "thread" | "config" | "account" | "agent" | "instructions" | "connector" | "project" | "projectFs" | "transfer" | "lsp" | "document" | "media" | "channel" | "import" | "mcp" | "skills" | "plugins" | "localProvider" | "terminal" | "process" | "git" | "github" | "remoteAccess" | "notify" | "room" | "memory" | "update" | "voice" | "diagnostics" | "feedback" | "approval" | "host";

/**
 * Client-generated UUIDv7 that makes a mutation idempotent (P §9.1).
 */
export type OpId = string;

/**
 * `thread:<id>` or a domain name (`config`, `project`, …).
 */
export type OpScopeName = string;

export type OpStatusEntry = { opId: OpId, } & ({ "state": "applied", seq?: number, result?: JsonValue, } | { "state": "rejected", error: JsonValue, } | { "state": "inProgress" } | { "state": "externalUnknown", effect: string, target: string, } | { "state": "notApplied" } | { "state": "expired" });

export type OpStatusParams = { scope: OpScopeName, opIds: Array<OpId>,
/**
 * Record every unknown id newer than the watermark as fenced before answering.
 */
fence: boolean, };

export type OpStatusResponse = { ops: Array<OpStatusEntry>, };

export type OrchestrationMode = "none" | "focused" | "balanced" | "swarm";

/**
 * Who issued a call: the connection origin (P §4.1, DS §4.2). Shared by
 * core-api (`PermissionDenied.origin`) and the method table.
 */
export type Origin = "local" | "ssh" | "relay";

/**
 * Today's `DesktopPastedText`.
 */
export type PastedText = { id: number, text?: string, attachmentRef?: string, sizeBytes?: number, chars?: number, filename?: string, mimeType?: string, source?: string, };

export type PermissionsRequestParams = {
/**
 * Offered permission scopes.
 */
scopes: Array<JsonValue>, request: JsonValue, threadId: ThreadId, turnId?: TurnId, itemId?: ItemId,
/**
 * Top-level chat that shows a sub-agent's request.
 */
surfaceThreadId?: ThreadId,
/**
 * Delegation chain from the surface thread to the asking thread.
 */
chain?: Array<ThreadId>, requestedAt: number, expiresAt?: number,
/**
 * Per-surface presentation order; the lowest is the active card (P §8.5).
 */
order: number, };

/**
 * Params of `plugins/addPlugin`.
 */
export type PluginsAddPluginParams = { opId: OpId, threadId?: ThreadId, source: JsonValue, };

/**
 * Params of `plugins/pluginsStatus`.
 */
export type PluginsPluginsStatusParams = { threadId?: ThreadId, };

/**
 * Params of `plugins/reloadPlugins`.
 */
export type PluginsReloadPluginsParams = { opId: OpId, threadId?: ThreadId, };

/**
 * Params of `plugins/removePlugin`.
 */
export type PluginsRemovePluginParams = { opId: OpId, threadId?: ThreadId, plugin: JsonValue, };

/**
 * Params of `plugins/setPluginEnabled`.
 */
export type PluginsSetPluginEnabledParams = { opId: OpId, threadId?: ThreadId, plugin: JsonValue, enabled: boolean, };

/**
 * Params of `plugins/updatePlugin`.
 */
export type PluginsUpdatePluginParams = { opId: OpId, threadId?: ThreadId, plugin: JsonValue, };

export type PowerEvent = "suspend" | "resume";

export type ProcessExitedParams = { processHandle: ProcessHandle, code?: number, signal?: string, };

/**
 * Process handle of `process/*` (client-chosen, connection-owned).
 */
export type ProcessHandle = string;

export type ProcessInputParams = { processHandle: ProcessHandle, bytesB64: string, };

/**
 * Params of `process/kill`.
 */
export type ProcessKillParams = { processHandle: ProcessHandle, };

export type ProcessOutputDeltaParams = { processHandle: ProcessHandle, bytesB64: string, };

/**
 * Params of `process/resizePty`.
 */
export type ProcessResizePtyParams = { processHandle: ProcessHandle, cols: number, rows: number, };

export type ProcessSpawnParams = { opId: OpId, processHandle: ProcessHandle, argv?: Array<string>,
/**
 * A shell command line (instead of `argv`).
 */
shell?: string, cwd?: string, env?: { [key in string]?: string }, pty?: PtySize,
/**
 * `tool{threadId,toolCallId}` | `terminalTab{tabId}` | `lsp{root,lang}` | `internal`.
 */
owner: JsonValue, outputMode?: string, timeoutMs?: number, };

/**
 * Params of `process/writeStdin`.
 */
export type ProcessWriteStdinParams = { processHandle: ProcessHandle, bytesB64: string, closeStdin?: boolean, };

/**
 * Params of `project/codeGraph`.
 */
export type ProjectCodeGraphParams = { path: string, mode: string, query: string, };

/**
 * Params of `project/create`.
 */
export type ProjectCreateParams = { opId: OpId, path: string, };

/**
 * Params of `project/delete`.
 */
export type ProjectDeleteParams = { opId: OpId, path: string, };

/**
 * Params of `project/deleteWorktree`.
 */
export type ProjectDeleteWorktreeParams = { opId: OpId, threadId?: ThreadId, input: JsonValue, };

/**
 * Params of `project/directory`.
 */
export type ProjectDirectoryParams = { path: string, };

/**
 * Params of `project/ensureDirectory`.
 */
export type ProjectEnsureDirectoryParams = { opId: OpId, path: string, };

/**
 * Params of `projectFs/backup/delete`.
 */
export type ProjectFsBackupDeleteParams = { opId: OpId, sourcePath: string, };

/**
 * Params of `projectFs/backup/read`.
 */
export type ProjectFsBackupReadParams = { sourcePath: string, };

/**
 * Params of `projectFs/backup/write`.
 */
export type ProjectFsBackupWriteParams = { opId: OpId, sourcePath: string, content: string, expectedContent: string, };

/**
 * Params of `projectFs/browseDirs`.
 */
export type ProjectFsBrowseDirsParams = { path: string, includeHidden?: boolean, };

/**
 * Params of `projectFs/captureSnapshot`.
 */
export type ProjectFsCaptureSnapshotParams = { root: string, rel: string, };

/**
 * Params of `projectFs/copy`.
 */
export type ProjectFsCopyParams = { opId: OpId, root: string, rel: string, targetDirRel: string, };

/**
 * Params of `projectFs/create`.
 */
export type ProjectFsCreateParams = { opId: OpId, root: string, relDir: string, name: string, directory: boolean, };

/**
 * Params of `projectFs/entryPath`.
 */
export type ProjectFsEntryPathParams = { root: string, rel: string, };

/**
 * Params of `projectFs/listDir`.
 */
export type ProjectFsListDirParams = { root: string, rel: string, };

/**
 * Params of `projectFs/localPageUrl`.
 */
export type ProjectFsLocalPageUrlParams = { root: string, rel: string, };

/**
 * Params of `projectFs/move`.
 */
export type ProjectFsMoveParams = { opId: OpId, root: string, rel: string, targetDirRel: string, };

/**
 * Params of `projectFs/readEditorSettings`.
 */
export type ProjectFsReadEditorSettingsParams = { root: string, rel: string, workspaceFile?: string, };

/**
 * Params of `projectFs/readLocal`.
 */
export type ProjectFsReadLocalParams = { path: string, };

/**
 * Params of `projectFs/readText`.
 */
export type ProjectFsReadTextParams = { root: string, rel: string,
/**
 * A paired device's one-file grant (`transfer/grant/mint`): `root` and `rel` are then Node's `projectPath` and `relPath`.
 */
accessToken?: string, };

/**
 * Params of `projectFs/recovery`.
 */
export type ProjectFsRecoveryParams = { opId: OpId, root: string, action: string, id?: string, revision?: string, };

/**
 * Params of `projectFs/rename`.
 */
export type ProjectFsRenameParams = { opId: OpId, root: string, rel: string, newName: string, };

/**
 * Params of `projectFs/replaceText`.
 */
export type ProjectFsReplaceTextParams = { opId: OpId, root: string, options: JsonValue, replacement: string, relPaths?: Array<string>, };

/**
 * Params of `projectFs/searchText`.
 */
export type ProjectFsSearchTextParams = { root: string, options: JsonValue, };

/**
 * Params of `projectFs/statLocal`.
 */
export type ProjectFsStatLocalParams = { paths: Array<string>, };

/**
 * Params of `projectFs/stat`.
 */
export type ProjectFsStatParams = { root: string, rel: string,
/**
 * A paired device's one-file grant, as on `projectFs/readText`.
 */
accessToken?: string, };

/**
 * Params of `projectFs/trash`.
 */
export type ProjectFsTrashParams = { opId: OpId, root: string, rel: string, };

/**
 * Params of `projectFs/workspaceFile/read`.
 */
export type ProjectFsWorkspaceFileReadParams = { workspaceFile: string, };

/**
 * Params of `projectFs/workspaceFile/write`.
 */
export type ProjectFsWorkspaceFileWriteParams = { opId: OpId, workspaceFile: string, folders: JsonValue, };

/**
 * Params of `projectFs/writeTextBatch`.
 */
export type ProjectFsWriteTextBatchParams = { opId: OpId, root: string, files: JsonValue, };

/**
 * Params of `projectFs/writeText`.
 */
export type ProjectFsWriteTextParams = { opId: OpId, root: string, rel: string, content: string, expectedContent: string, encoding?: string, };

/**
 * Params of `project/getProjectBranchMenu`.
 */
export type ProjectGetProjectBranchMenuParams = { threadId?: ThreadId, input: JsonValue, };

/**
 * Params of `project/getProjectConnectors`.
 */
export type ProjectGetProjectConnectorsParams = { threadId?: ThreadId, projectPath: string, };

/**
 * Params of `project/inspectProjectBranch`.
 */
export type ProjectInspectProjectBranchParams = { threadId?: ThreadId, input: JsonValue, };

/**
 * Params of `project/list`.
 */
export type ProjectListParams = Record<string, never>;

/**
 * Params of `project/listWorktrees`.
 */
export type ProjectListWorktreesParams = { threadId?: ThreadId, };

/**
 * Params of `project/manageProjectBranch`.
 */
export type ProjectManageProjectBranchParams = { opId: OpId, threadId?: ThreadId, input: JsonValue, };

/**
 * Params of `project/mergeProjectBranch`.
 */
export type ProjectMergeProjectBranchParams = { opId: OpId, threadId?: ThreadId, input: JsonValue, };

/**
 * Params of `project/previewWorktreeCleanup`.
 */
export type ProjectPreviewWorktreeCleanupParams = { threadId?: ThreadId, input?: JsonValue, };

/**
 * Params of `project/pruneWorktrees`.
 */
export type ProjectPruneWorktreesParams = { opId: OpId, threadId?: ThreadId, input?: JsonValue, };

/**
 * Params of `project/read`.
 */
export type ProjectReadParams = { path: string, };

/**
 * Params of `project/recoveryDirectory`.
 */
export type ProjectRecoveryDirectoryParams = { path: string, };

/**
 * Params of `project/removeWorktree`.
 */
export type ProjectRemoveWorktreeParams = { opId: OpId, threadId?: ThreadId, input?: JsonValue, options?: JsonValue, };

/**
 * Params of `project/selectProjectBranch`.
 */
export type ProjectSelectProjectBranchParams = { opId: OpId, threadId?: ThreadId, input: JsonValue, };

/**
 * Params of `project/setArchivedSessionWorktrees`.
 */
export type ProjectSetArchivedSessionWorktreesParams = { opId: OpId, threadId?: ThreadId, input: JsonValue, };

/**
 * Params of `project/setProjectConnectorEnabled`.
 */
export type ProjectSetProjectConnectorEnabledParams = { opId: OpId, threadId?: ThreadId, projectPath: string, connectorId: string, enabled: boolean, options?: JsonValue, };

/**
 * Params of `project/taskWorkspace`.
 */
export type ProjectTaskWorkspaceParams = Record<string, never>;

/**
 * Params of `project/touch`.
 */
export type ProjectTouchParams = { opId: OpId, path: string, };

/**
 * Params of `project/update`.
 */
export type ProjectUpdateParams = { opId: OpId, path: string, alias: JsonValue, };

/**
 * Today's `DesktopPromptAttachment`.
 */
export type PromptAttachment = { id: number,
/**
 * Always `image` today.
 */
type: string, content?: string, attachmentRef?: string, sizeBytes?: number, mediaType: string, filename?: string, sourcePath?: string, metadataText?: string, originalRef?: string, originalMediaType?: string, };

/**
 * Today's `DesktopPromptContent`: a string or an array of parts.
 */
export type PromptContent = string | Array<PromptPart>;

/**
 * Value of `thread/promptHistory/updated`.
 */
export type PromptHistoryChange = { "kind": "added", prompt: string, } | { "kind": "replaced", prompts: Array<string>, };

/**
 * One part of a prompt (today's `DesktopPromptContent` array form).
 */
export type PromptPart = { "type": "text", text?: string, textKind?: string, attachmentRef?: string, sizeBytes?: number, mimeType?: string, filename?: string, } | { "type": "image",
/**
 * Base64 bytes; a part that names a stored `attachment_ref` instead has none.
 */
data?: string, mimeType: string, attachmentRef?: string, sizeBytes?: number, filename?: string, } | { "type": "file", data?: string, mimeType: string, filename?: string, attachmentRef?: string, sizeBytes?: number, };

export type PromptPriority = "now" | "next" | "later";

export type PromptRestore = { id: string, ids: Array<string>, text: string, device: string, at: number, };

export type ProviderAccountChange = { provider: string, accountId: string, at: number, };

export type ProviderErrorDetail = { provider: string, status?: number, kind: string,
/**
 * Delivery state of the failed attempt (SPEC §4.9).
 */
delivery?: DeliveryState, };

/**
 * A provider (`anthropic`, `openai-oauth`, `custom-<uuid>`, …).
 */
export type ProviderId = string;

/**
 * The answer to a [`ProxyCall`].
 */
export type ProxyAnswer = { "result": "sent", attempts: number, } | { "result": "models", models: Array<ProxyModel>, } | { "result": "usable", usable: boolean, } | { "result": "route", route: ProxyWireRoute | null, } | { "result": "providerConfig",
/**
 * In the order the PC advertised them: a JSON object on the wire, whose key order Node keeps
 * (the setup lists custom providers in it).
 */
providers: { [key in string]?: ProxyProviderInfo },
/**
 * Whether the PC's registry is loaded. An older PC omits it, and the server then reads the
 * answer as loaded only when it names an enabled provider.
 */
ready?: boolean, } | { "result": "failed", failure: ProxyFailure, };

/**
 * A file part's bytes. The sender's attachment-store reference means nothing on the PC, so it
 * is never carried: the sender inlines the bytes (under its byte budget), and a reference that
 * stays travels as `unavailable`.
 */
export type ProxyBinary = { "kind": "base64", data: string, } | { "kind": "unavailable" };

export type ProxyBudget = { transportMs: number, semanticMs: number, };

export type ProxyCacheTier = "tier3" | "env";

/**
 * What the remote runtime asks of the PC's providers (`ModelProxyProvider`,
 * `quota-reading.mjs:93`, `loadModelProxyProviderConfig`).
 */
export type ProxyCall = { "method": "send", provider: string, request: ProxyRequest, } | { "method": "listModels", provider: string, refresh: boolean, } | { "method": "quotaUsable", provider: string, model: string, } | { "method": "resolveWireRoute", provider: string, model: string, context: ProxyRouteContext, } | { "method": "providerConfig" };

export type ProxyContent = string | Array<ProxyPart>;

/**
 * A custom provider's reasoning wire contract (``CustomReasoning``).
 */
export type ProxyCustomReasoning = { wireFormat: string, wireValues: { [key in string]?: string }, replay: boolean, };

export type ProxyDelivery = "notSent" | "ambiguous" | "accepted";

export type ProxyDocument = { "kind": "base64", mediaType: string, data: string, } | { "kind": "text", mediaType: string | null, data: string, } | { "kind": "content", content: JsonValue, };

export type ProxyEffortProjection = { initialEffort: string,
/**
 * `(message index, effort)` pairs; a JSON object would key them by text.
 */
updates: Array<[number, string]>, };

export type ProxyErrorKind = "overloaded" | "rateLimited" | "quotaExhausted" | "entitlement" | "billing" | "auth" | "permission" | "contextOverflow" | "requestTooLarge" | "policy" | "serviceTierUnavailable" | "invalidRequest" | "imageRejected" | "replayRejected" | "toolSchemaRejected" | "transient" | "unknown";

/**
 * One stream event of an attempt (`StreamEvent`).
 */
export type ProxyEvent = { "type": "itemStart", item: ProxyItemKind, phase: ProxyPhase | null, } | { "type": "textDelta", text: string, } | { "type": "reasoningDelta", text: string, } | { "type": "reasoningReplay", replay: ProxyReplay, } | { "type": "toolCallStart", id: string, name: string, } | { "type": "toolCallArgsDelta", id: string, delta: string, } | { "type": "toolCallDone", call: ProxyToolCall, } | { "type": "usage", usage: ProxyUsage, } | { "type": "refusal", text: string, } | { "type": "citation", value: JsonValue, } | { "type": "serverToolBlock", value: JsonValue, } | { "type": "providerKeepalive" } | { "type": "progress", kind: ProxyProgress, } | { "type": "chunkProgress", kind: ProxyProgress | null, } | { "type": "finalContent", text: string, } | { "type": "returnedCalls", calls: Array<ProxyToolCall>, } | { "type": "thinkingBlocks", value: JsonValue, } | { "type": "providerState", state: JsonValue, } | { "type": "completed", stop: ProxyStop | null, pricingModel: string | null, requestMs: number | null, } | { "type": "attemptDiscarded" } | { "type": "attemptAbandoned", usage: ProxyUsage, model: string | null, };

/**
 * A failed call as the sender's retry and recovery read it (the classified `ProviderError`);
 * credential-shaped text in the message is redacted and nothing else of the PC leaves it.
 */
export type ProxyFailure = { outcome: ProxyOutcome, kind: ProxyErrorKind, code: string | null, status: number | null, retryAfterMs: number | null, resetAtMs: number | null, quotaScope: ProxyQuotaScope | null, reauthRequired: boolean, shouldRetry: boolean | null, textEmitted: boolean, toolDispatched: boolean, toolInputCut: boolean, delivery: ProxyDelivery, transport: ProxyFault | null, message: string, partialUsage: ProxyUsage | null, partialModel: string | null, verificationUrl: string | null, rejectedTool: string | null, accountBlocked: boolean, unsafeToRetry: boolean, quotaLimit: string | null, };

export type ProxyFault = { "fault": "connect", osCode: number | null, } | { "fault": "dns" } | { "fault": "reset" } | { "fault": "closed" } | { "fault": "tls" } | { "fault": "h2GoAway", code: number, } | { "fault": "h2RstStream", code: number, } | { "fault": "wsClose", code: number | null, } | { "fault": "keepaliveExpired", transport: ProxyTransportKind, } | { "fault": "truncatedStream" } | { "fault": "io", osCode: number | null, };

export type ProxyHostedTool = { "kind": "webSearch", toolType: string, allowedDomains: Array<string>, userLocation: ProxyLocation | null, maxUses: number | null, contextSize: string | null, includeSources: boolean, };

export type ProxyImage = { "kind": "base64", data: string, mimeType: string, } | { "kind": "url", url: string, } | { "kind": "fileId", id: string, };

export type ProxyItemKind = "text" | "reasoning" | "tool";

export type ProxyLocation = { country: string | null, region: string | null, city: string | null, timezone: string | null, };

export type ProxyMessage = { role: ProxyRole, content: ProxyContent, cacheTier: ProxyCacheTier | null, toolCalls: Array<ProxyToolCall>, toolCallId: string | null, isError: boolean, phase: ProxyPhase | null, thinkingBlocks: JsonValue | null, assistantBlocks: JsonValue | null, nativeToolSearch: JsonValue | null, source: ProxyMessageSource | null, turnReminder: string | null, providerReplay: Array<ProxyReplay>, };

export type ProxyMessageSource = "steering" | "streamCutRecovery" | "tailReminder";

/**
 * A model the PC's provider lists, with the first-response budget of its catalog entry.
 */
export type ProxyModel = { id: string, displayName: string | null,
/**
 * The row's own `name`, the label when no display name is known.
 */
name: string | null,
/**
 * A custom provider's own name for itself.
 */
providerName: string | null,
/**
 * A custom model added by hand.
 */
manual: boolean, supportsReasoningEffortUpdates: boolean | null, supportsPromptCaching: boolean | null, reasoningContentField: string | null, contextWindow: number | null,
/**
 * The largest window the listing states for the model.
 */
maxContextWindow: number | null,
/**
 * What a managed local runtime has allocated; bounds a selected window.
 */
runtimeContextWindow: number | null, maxOutputTokens: number | null,
/**
 * The row's own prices, USD per million tokens; absent when not finite.
 */
inputCostPerM: number | null, outputCostPerM: number | null, cacheReadCostPerM: number | null, cacheWriteCostPerM: number | null, supportsReasoning: boolean | null, reasoningLevels: Array<string>, defaultReasoningLevel: string | null, supportsImages: boolean | null, hidden: boolean, raw: JsonValue | null,
/**
 * The kind of model the listing states (`chat`, `embedding`, ...).
 */
mode: string | null,
/**
 * When the provider created the model (epoch seconds, as listed).
 */
created: number | null,
/**
 * The model a routing alias resolves to.
 */
aliasTarget: string | null,
/**
 * The wire id(s) the picker id is sent under.
 */
wire: string | { [level: string]: string } | null, picker: ProxyPicker, firstResponseBudget: ProxyBudget | null, };

/**
 * `RequestOptions` field for field. The connection scope and the model's output ceiling are the
 * PC's to derive, so they are not carried.
 */
export type ProxyOptions = { sessionId: string | null, effort: string | null, maxOutputTokensOverride: number | null, fast: boolean, toolChoice: string | null, verbosity: string | null, requestKind: string | null, iteration: number, promptCacheKey: string | null, promptCacheScope: string | null, xaiResponsesCacheScope: string | null, modelParameters: JsonValue | null, thread: ProxyThread | null, parentSessionId: string | null, parallelToolCalls: boolean | null, temperature: number | null, effortProjection: ProxyEffortProjection | null, hostedTools: Array<ProxyHostedTool>, sharedCachePrefixCount: number | null, providerState: JsonValue | null, };

/**
 * How the PC's broker ended a failed send.
 */
export type ProxyOutcome = { "outcome": "provider" } | { "outcome": "exhausted" } | { "outcome": "fallback", model: string, } | { "outcome": "admission" };

/**
 * A selectable non-effort, non-fast model parameter (``ParameterOption``).
 */
export type ProxyParameterOption = { id: string, label: string, kind: string, options: Array<ProxyParameterValue>, };

/**
 * One value of a picker parameter (``ParameterValue``).
 */
export type ProxyParameterValue = { value: string, label: string, contextWindow: number | null, };

export type ProxyPart = { "type": "text", text: string, } | { "type": "image", source: ProxyImage, } | { "type": "file", source: ProxyBinary, mimeType: string, filename: string | null, } | { "type": "document", source: ProxyDocument, title: string | null, };

export type ProxyPhase = "commentary" | "finalAnswer";

/**
 * What the model picker shows beyond limits and capabilities (``PickerFields``).
 */
export type ProxyPicker = { releaseDate: string | null, accessPrograms: Array<string> | null, modelParameterOptions: Array<ProxyParameterOption>, parameterVariants: Array<{ [key in string]?: string }>, fastEfforts: Array<string>, serviceTiers: Array<ProxyServiceTier>, additionalSpeedTiers: Array<string>, reasoningOptions: Array<ProxyReasoningOption>, customReasoning: ProxyCustomReasoning | null, tier: string | null, latest: boolean, description: string | null, defaultServiceTier: string | null, defaultModelParameters: { [key in string]?: string }, defaultFast: boolean, supportsMaxMode: boolean, };

export type ProxyProgress = "semantic" | "reasoning" | "text" | "tool";

/**
 * What a server learns of one PC provider: usable or not, and its traits.
 */
export type ProxyProviderInfo = { enabled: boolean, type?: string, name?: string, hiddenModels?: Array<string>, authState?: string, modelProxy: ProxyTraits, };

export type ProxyQuotaScope = "minute" | "day" | "plan";

/**
 * A declared effort ladder (``ReasoningOption``).
 */
export type ProxyReasoningOption = { type: string, values: Array<string>, };

export type ProxyReplay = { owner: string, items: JsonValue, };

export type ProxyRequest = { model: string, messages: Array<ProxyMessage>, tools: Array<ProxyTool>, options: ProxyOptions, };

export type ProxyRole = "system" | "user" | "assistant" | "tool" | "developer";

export type ProxyRouteContext = {
/**
 * An agent/tool session, or a send carrying tools.
 */
agent: boolean,
/**
 * A session that predates the wire table (`model-proxy-provider.mjs:193`).
 */
legacy: boolean, };

export type ProxyRouteSource = "pinned" | "override" | "catalog" | "endpoints" | "family" | "default" | "legacy" | "unknown";

export type ProxyServiceTier = { id: string, name: string, description: string, };

export type ProxyStop = { "kind": "endTurn" } | { "kind": "toolUse" } | { "kind": "maxTokens" } | { "kind": "stopSequence" } | { "kind": "contentFilter" } | { "kind": "refusal" } | { "kind": "continueTurn" } | { "kind": "other", value: string, };

export type ProxyThread = { id: string, window: number, turn: string | null, };

export type ProxyTool = { name: string, description: string, inputSchema: JsonValue, deferLoading: boolean, };

export type ProxyToolCall = { id: string, name: string, arguments: JsonValue, nativeType: string | null, };

/**
 * The adapter traits of a PC provider its stand-in needs.
 */
export type ProxyTraits = { inputExcludesCache?: boolean, nativePdf?: boolean, consumesReadWindows?: boolean, takesImages?: boolean, firstResponseBudget?: ProxyBudget, };

export type ProxyTransportKind = "http1" | "http2" | "webSocket";

export type ProxyUsage = { inputTokens: number, outputTokens: number, cacheReadTokens: number, cacheWriteTokens: number, cacheWrite1hTokens: number,
/**
 * Absent when the provider reported none; an explicit 0 stays 0.
 */
reasoningTokens: number | null,
/**
 * `reasoningTokensComplete === false` on an aggregate.
 */
reasoningIncomplete: boolean, raw: JsonValue | null, costTicks: number | null, };

export type ProxyWire = "chat" | "responses" | "messages" | "gemini";

export type ProxyWireRoute = { wire: ProxyWire, source: ProxyRouteSource,
/**
 * `<provider>:<wire>`.
 */
profileId: string, };

export type PtySize = { cols: number, rows: number, };

/**
 * One `ask_user` answer, aligned by index with the questions.
 */
export type QuestionAnswer = { selected: Array<string>, text?: string, };

/**
 * A queued input entry of a busy thread.
 */
export type QueuedId = string;

/**
 * Today's `DesktopQuotaResume`.
 */
export type QuotaResume = {
/**
 * Always `waiting`.
 */
state: string, turnKey: string, provider: string, model: string, resetAt: number, attempts: number, };

/**
 * Params of `remoteAccess/activate`.
 */
export type RemoteAccessActivateParams = { opId: OpId, };

/**
 * Params of `remoteAccess/deliverScreenControllerKey`.
 */
export type RemoteAccessDeliverScreenControllerKeyParams = { opId: OpId, input: JsonValue, };

/**
 * Params of `remoteAccess/pairCode`.
 */
export type RemoteAccessPairCodeParams = { opId: OpId, action: string, };

/**
 * Params of `remoteAccess/pushPublicKey`.
 */
export type RemoteAccessPushPublicKeyParams = Record<string, never>;

/**
 * Params of `remoteAccess/registerNativePush`.
 */
export type RemoteAccessRegisterNativePushParams = { opId: OpId, input: JsonValue, };

/**
 * Params of `remoteAccess/registerPushSubscription`.
 */
export type RemoteAccessRegisterPushSubscriptionParams = { opId: OpId, input: JsonValue, };

/**
 * Params of `remoteAccess/removeNativePush`.
 */
export type RemoteAccessRemoveNativePushParams = { opId: OpId, token?: string, };

/**
 * Params of `remoteAccess/removePushSubscription`.
 */
export type RemoteAccessRemovePushSubscriptionParams = { opId: OpId, endpoint: string, };

/**
 * Params of `remoteAccess/resolveClaim`.
 */
export type RemoteAccessResolveClaimParams = { opId: OpId, claimId: string, approve: boolean, };

/**
 * Params of `remoteAccess/revokeClient`.
 */
export type RemoteAccessRevokeClientParams = { opId: OpId, clientId: string, };

/**
 * Params of `remoteAccess/rotate`.
 */
export type RemoteAccessRotateParams = { opId: OpId, };

/**
 * Params of `remoteAccess/setClientAlias`.
 */
export type RemoteAccessSetClientAliasParams = { opId: OpId, clientId: string, alias: string, };

/**
 * Params of `remoteAccess/setEnabled`.
 */
export type RemoteAccessSetEnabledParams = { opId: OpId, enabled: boolean, };

/**
 * Params of `remoteAccess/setName`.
 */
export type RemoteAccessSetNameParams = { opId: OpId, name: string, };

/**
 * Params of `remoteAccess/settleOwedControllerKeys`.
 */
export type RemoteAccessSettleOwedControllerKeysParams = { opId: OpId, input: JsonValue, };

/**
 * Params of `remoteAccess/state`.
 */
export type RemoteAccessStateParams = Record<string, never>;

/**
 * The `pairCode` member of the `remote` section (today's `DesktopRemotePairCode`):
 * the relay code of an open Settings → Connection screen. `remoteAccess/pairCode`
 * issues or renews it; the section carries it, `null` once it expires or is released.
 */
export type RemotePairCode = {
/**
 * Six digits, no separator.
 */
code: string,
/**
 * Epoch ms.
 */
expiresAt: number, };

/**
 * App-feed event: remote pointer position (today's `notify` remote pointer).
 */
export type RemotePointerParams = { pointer: JsonValue, };

/**
 * One thing a worktree removal left behind.
 */
export type RemovalRemnant = {
/**
 * `link`, `registry`, `cleanup` or `error`.
 */
kind: string, path?: string, name?: string, error?: string, };

/**
 * Request class (RL §4.1, SPEC §4.3): static per method, never derived at runtime.
 */
export type RequestClass = "C0" | "C1" | "C2" | "C3";

export type RequestId = string | number;

/**
 * Closed window descriptor of a thread subscription (P §6.3).
 */
export type ResumeWindow = { lastItems: number, } | { lastTurns: number, } | { none: boolean, };

/**
 * One read for every review family (DS §5.3).
 */
export type ReviewDiffGetParams = { scope: ReviewScope, threadId?: ThreadId,
/**
 * Repository working directory for `repo`.
 */
cwd?: string, checkpointId?: string,
/**
 * One file's patch.
 */
path?: string, oldPath?: string,
/**
 * Several files' patches (today's `gitReviewDiffs`).
 */
files?: Array<JsonValue>, untracked?: boolean,
/**
 * `branch` | `worktree` | … (today's `GitReviewSource`).
 */
source?: string,
/**
 * Include patches (today's `patch: true`).
 */
patch?: boolean,
/**
 * The client's review key; an unchanged review answers `{unchanged:true}`.
 */
known?: string, cursor?: string,
/**
 * Leave the patch text out of a turn review (today's `getTurnReviewDiff {summary: true}`).
 */
summary?: boolean, };

export type ReviewScope = "turn" | "session" | "repo";

/**
 * Params of `room/continue`.
 */
export type RoomContinueParams = { opId: OpId, input: JsonValue, };

/**
 * Params of `room/create`.
 */
export type RoomCreateParams = { opId: OpId, input: JsonValue, };

/**
 * Params of `room/leave`.
 */
export type RoomLeaveParams = { opId: OpId, input: JsonValue, };

export type RoomLimit = "rounds" | "messages" | "usage";

/**
 * The payload of a group-room line (`normalizeRoomRow`, the row's `room`).
 */
export type RoomLine = { kind: RoomRowKind, at?: number,
/**
 * The member id of a speech or pass.
 */
speaker?: string,
/**
 * The member's display name.
 */
name?: string,
/**
 * A user line another session sent: its sender session, the sending bot and its name.
 */
fromSession?: string, fromAgent?: string, fromName?: string,
/**
 * Addressee ids and their names, index for index.
 */
to: Array<string>, toName: Array<string>, failed?: boolean,
/**
 * The members a collapsed run of failed passes names.
 */
names: Array<string>, reason?: string, limit?: RoomLimit, usage?: RoomUsage, rounds?: number, messages?: number, tools: Array<RoomTool>, parts: Array<RoomPart>, };

/**
 * A stored file reference of a room line (`parts`).
 */
export type RoomPart = { type: AttachmentKind, attachmentRef: string,
/**
 * `paste` | `file`, for a text part.
 */
textKind?: string, mimeType?: string, filename?: string, sizeBytes?: number, };

/**
 * Params of `room/remove`.
 */
export type RoomRemoveParams = { opId: OpId, input: JsonValue, };

export type RoomRowKind = "user" | "speech" | "pass" | "cap" | "stopped" | "interrupted";

/**
 * A tool a member used in its turn, as the speech line summarises it.
 */
export type RoomTool = { name: string, summary: string, };

/**
 * Params of `room/update`.
 */
export type RoomUpdateParams = { opId: OpId, input: JsonValue, };

/**
 * The usage limit a `cap` line stopped at.
 */
export type RoomUsage = { kind: string, provider: string, model: string, resetAt: number | null, };

/**
 * Params of `route/set`.
 */
export type RouteSetParams = { opId: OpId, threadId?: ThreadId, agentId?: string, route: JsonValue, };

export type RoutineKind = "schedule" | "webhook";

/**
 * The routine fire a turn delivered (`routineTrigger`): painted as its marker row.
 */
export type RoutineTrigger = { kind: RoutineKind, name: string, event?: string, };

/**
 * Kinds of scoped feeds; the feed id is `<kind>:<key>` (`ports` has no key).
 */
export type ScopedFeedKind = "fs" | "search" | "process" | "login" | "git" | "lsp" | "media" | "ports";

export type SearchCompletedParams = { sessionId: SearchSessionId, query: string, };

/**
 * Client-chosen fuzzy file search session id.
 */
export type SearchSessionId = string;

/**
 * Params of `search/start`.
 */
export type SearchStartParams = { sessionId: SearchSessionId, roots: Array<string>, limit?: number, includeIgnored?: boolean, includeDirectories?: boolean, consumer?: string, };

/**
 * Params of `search/stop`.
 */
export type SearchStopParams = { sessionId: SearchSessionId, };

/**
 * Params of `search/update`.
 */
export type SearchUpdateParams = { sessionId: SearchSessionId, query: string, };

export type SearchUpdatedParams = { sessionId: SearchSessionId, query: string, files: Array<JsonValue>, };

/**
 * Every section name. The registry is closed: adding one is a contract change.
 */
export type SectionName = "config" | "projects" | "agentPool" | "agents" | "botOrder" | "presets" | "modelCatalog" | "workflows" | "webSearch" | "toolModules" | "providerSetup" | "providerAccounts" | "usage" | "hostShellJobs" | "terminalActivity" | "terminalTabs" | "remote" | "notice" | "update" | "hostState" | "computer" | "approvalInbox" | "core" | "coreHealth" | "migration" | "reviewDiff" | "gitStatus" | "lspStatus" | "lspDiagnostics" | "mediaJobs" | "ports";

/**
 * Value above `INLINE_MAX` is replaced by a stub; the client pages the detail
 * with the section's list method.
 */
export type SectionStub = { count: number,
/**
 * Always `true`.
 */
stub: boolean, };

/**
 * Params of every section notification:
 * `{"section", "key", "revision", "value"}` or `{…, "removed": true}` or
 * `{…, "stub": {count, stub:true}}`. Exactly one of `value`, `removed`, `stub`.
 * The client keeps `(section,key)` iff `revision` is greater than the stored one.
 */
export type SectionUpdate = { section: SectionName, key?: string,
/**
 * Per `(section,key)`, strictly increasing.
 */
revision: number, value?: JsonValue, removed?: boolean, stub?: SectionStub, };

/**
 * Core capabilities (D6: office and JS skills are unavailable without Node).
 */
export type ServerCapabilities = { office: CapabilityState, jsSkills: CapabilityState, browser: CapabilityState, computer: CapabilityState, voice: CapabilityState, };

export type ServerNotification = { "method": "thread/snapshot", "params": ThreadSnapshotParams } | { "method": "thread/closed", "params": ThreadIdParams } | { "method": "thread/status/changed", "params": ThreadStatusChangedParams } | { "method": "thread/name/updated", "params": ThreadNameUpdatedParams } | { "method": "thread/tokenUsage/updated", "params": TokenUsageUpdatedParams } | { "method": "thread/goal/updated", "params": ThreadValueParams } | { "method": "thread/goal/cleared", "params": ThreadIdParams } | { "method": "thread/queue/changed", "params": ThreadQueueChangedParams } | { "method": "turn/started", "params": TurnNotificationParams } | { "method": "turn/completed", "params": TurnNotificationParams } | { "method": "thread/notification", "params": ThreadNotificationParams } | { "method": "thread/modelRequest/updated", "params": ModelRequestUpdatedParams } | { "method": "thread/toolBatch/updated", "params": ToolBatchUpdatedParams } | { "method": "item/started", "params": ItemNotificationParams } | { "method": "item/completed", "params": ItemNotificationParams } | { "method": "item/agentMessage/delta", "params": ItemDeltaParams } | { "method": "item/reasoning/textDelta", "params": ItemDeltaParams } | { "method": "item/reasoning/summaryTextDelta", "params": ItemDeltaParams } | { "method": "thread/historyReset", "params": ThreadHistoryResetParams } | { "method": "thread/runtime/updated", "params": ThreadSectionParams<ThreadRuntime> } | { "method": "thread/route/updated", "params": ThreadSectionParams<ThreadRoute> } | { "method": "thread/context/updated", "params": ThreadSectionParams<ThreadContext> } | { "method": "thread/todo/updated", "params": ThreadSectionParams<JsonValue | null> } | { "method": "thread/quotaResume/updated", "params": ThreadSectionParams<QuotaResume | null> } | { "method": "thread/agents/updated", "params": ThreadSectionParams<ThreadAgents> } | { "method": "thread/shellJobs/updated", "params": ThreadSectionParams<JsonValue> } | { "method": "thread/workflow/updated", "params": ThreadSectionParams<ThreadWorkflow> } | { "method": "thread/workspace/updated", "params": ThreadSectionParams<JsonValue | null> } | { "method": "thread/approvals/updated", "params": ThreadSectionParams<ThreadApprovals> } | { "method": "thread/promptRestore", "params": ThreadSectionParams<PromptRestore | null> } | { "method": "thread/providerAccount/changed", "params": ThreadSectionParams<ProviderAccountChange | null> } | { "method": "thread/promptHistory/updated", "params": ThreadSectionParams<PromptHistoryChange> } | { "method": "thread/remote/updated", "params": ThreadSectionParams<boolean> } | { "method": "thread/setupUiRequest/updated", "params": ThreadSectionParams<SetupUiRequest | null> } | { "method": "thread/roomView/updated", "params": ThreadSectionParams<ThreadRoomView | null> } | { "method": "review/diff/updated", "params": SectionUpdate } | { "method": "error", "params": ErrorNotificationParams } | { "method": "serverRequest/resolved", "params": ServerRequestResolvedParams } | { "method": "host/notification/show", "params": HostNotificationShowParams } | { "method": "host/browser/viewFrames", "params": HostBrowserViewFramesParams } | { "method": "modelProxy/run/event", "params": ModelProxyRunEventParams } | { "method": "model/proxy/cancel", "params": ModelProxyCancelParams } | { "method": "app/snapshot", "params": AppSnapshotParams } | { "method": "thread/started", "params": ThreadStartedParams } | { "method": "thread/summary/updated", "params": ThreadSummaryUpdatedParams } | { "method": "thread/deleted", "params": ThreadIdParams } | { "method": "thread/archived", "params": ThreadIdParams } | { "method": "thread/unarchived", "params": ThreadIdParams } | { "method": "warning", "params": WarningParams } | { "method": "configWarning", "params": WarningParams } | { "method": "ui/openRequested", "params": UiOpenRequestedParams } | { "method": "remote/pointer", "params": RemotePointerParams } | { "method": "core/drain", "params": CoreDrainParams } | { "method": "config/updated", "params": SectionUpdate } | { "method": "project/updated", "params": SectionUpdate } | { "method": "agent/pool/updated", "params": SectionUpdate } | { "method": "agent/list/updated", "params": SectionUpdate } | { "method": "agent/botOrder/updated", "params": SectionUpdate } | { "method": "model/presets/updated", "params": SectionUpdate } | { "method": "model/catalog/updated", "params": SectionUpdate } | { "method": "workflow/list/updated", "params": SectionUpdate } | { "method": "webSearch/updated", "params": SectionUpdate } | { "method": "toolModules/updated", "params": SectionUpdate } | { "method": "account/updated", "params": SectionUpdate } | { "method": "usage/updated", "params": SectionUpdate } | { "method": "shellJobs/host/updated", "params": SectionUpdate } | { "method": "terminal/activity/updated", "params": SectionUpdate } | { "method": "terminal/tabs/updated", "params": SectionUpdate } | { "method": "remote/state/updated", "params": SectionUpdate } | { "method": "notice/updated", "params": SectionUpdate } | { "method": "update/status/updated", "params": SectionUpdate } | { "method": "host/state/updated", "params": SectionUpdate } | { "method": "computer/updated", "params": SectionUpdate } | { "method": "approval/inbox/updated", "params": SectionUpdate } | { "method": "core/state/updated", "params": SectionUpdate } | { "method": "core/health/updated", "params": SectionUpdate } | { "method": "migration/progress", "params": SectionUpdate } | { "method": "feed/snapshot", "params": FeedSnapshotParams } | { "method": "fs/changed", "params": FsChangedParams } | { "method": "search/updated", "params": SearchUpdatedParams } | { "method": "search/completed", "params": SearchCompletedParams } | { "method": "process/outputDelta", "params": ProcessOutputDeltaParams } | { "method": "process/exited", "params": ProcessExitedParams } | { "method": "login/updated", "params": LoginUpdatedParams } | { "method": "git/status/updated", "params": SectionUpdate } | { "method": "lsp/status/updated", "params": SectionUpdate } | { "method": "lsp/diagnostics/updated", "params": SectionUpdate } | { "method": "media/job/updated", "params": SectionUpdate } | { "method": "system/ports/updated", "params": SectionUpdate };

/**
 * Request from the core to a client.
 */
export type ServerRequest = { "method": "item/tool/requestApproval", id: RequestId, params: ToolApprovalRequestParams, } | { "method": "item/tool/requestUserInput", id: RequestId, params: UserInputRequestParams, } | { "method": "item/permissions/requestApproval", id: RequestId, params: PermissionsRequestParams, } | { "method": "item/browser/requestApproval", id: RequestId, params: BrowserApprovalRequestParams, } | { "method": "item/computer/requestApproval", id: RequestId, params: ComputerApprovalRequestParams, } | { "method": "host/browser/command", id: RequestId, params: HostCommandParams, } | { "method": "host/visualize/command", id: RequestId, params: HostVisualizeCommandParams, } | { "method": "host/systemProxy/resolve", id: RequestId, params: HostSystemProxyResolveParams, } | { "method": "host/notification/status", id: RequestId, params: HostNotificationStatusParams, } | { "method": "host/update/command", id: RequestId, params: HostUpdateCommandParams, } | { "method": "host/capture/fileSnapshot", id: RequestId, params: HostFileSnapshotParams, } | { "method": "host/localPage/url", id: RequestId, params: HostLocalPageUrlParams, } | { "method": "model/proxy/execute", id: RequestId, params: ModelProxyExecuteParams, };

/**
 * To every eligible connection, losers included (P §8.4 step 4).
 */
export type ServerRequestResolvedParams = { threadId: ThreadId, requestId: RequestId, resolution: ApprovalResolution, };

/**
 * Node's `TOOL_MODES`.
 */
export type SessionToolMode = "full" | "readonly" | "lead";

/**
 * The setup tool's desktop request waiting for a window to claim it (Node's session store
 * `setupUiRequest`): its id, and when the thread took it.
 */
export type SetupUiRequest = { id: string, at: number, };

/**
 * Params of `skills/addSkill`.
 */
export type SkillsAddSkillParams = { opId: OpId, threadId?: ThreadId, input: JsonValue, };

/**
 * Params of `skills/getDisabledSkills`.
 */
export type SkillsGetDisabledSkillsParams = { threadId?: ThreadId, };

/**
 * Params of `skills/reloadSkills`.
 */
export type SkillsReloadSkillsParams = { opId: OpId, threadId?: ThreadId, };

/**
 * Params of `skills/removeSkill`.
 */
export type SkillsRemoveSkillParams = { opId: OpId, threadId?: ThreadId, input: JsonValue, };

/**
 * Params of `skills/saveSkill`.
 */
export type SkillsSaveSkillParams = { opId: OpId, threadId?: ThreadId, input: JsonValue, };

/**
 * Params of `skills/setDisabledSkills`.
 */
export type SkillsSetDisabledSkillsParams = { opId: OpId, threadId?: ThreadId, names: Array<string>, };

/**
 * Params of `skills/skillContent`.
 */
export type SkillsSkillContentParams = { threadId?: ThreadId, name: string, };

/**
 * Params of `skills/skillsStatus`.
 */
export type SkillsSkillsStatusParams = { threadId?: ThreadId, options?: JsonValue, };

export type SortDirection = "asc" | "desc";

export type StorageState = "ok" | "durabilityPending" | "indeterminate";

/**
 * Caller options of `turn/start` (today's `DesktopSubmitOptions` without the
 * host-only fields `device`, `hop`, `roomRow`, `origin`; a request carrying
 * any of them is `invalidParams`, P §4.3).
 */
export type SubmitOptions = {
/**
 * Today's submit `id`: the client's correlation id reused by queue and transcript.
 */
clientSubmissionId?: string, submittedAt?: number, displayText?: string, goalCommand?: string, retryFailedTurn?: boolean,
/**
 * The failed user message a retry replays from the model history (`retryTurnId`).
 */
retryTurnId?: string,
/**
 * The failed attempt of that message (`retryAttemptId`).
 */
retryAttemptId?: string, priority?: PromptPriority, pastedImages?: { [key in string]?: PromptAttachment }, pastedTexts?: { [key in string]?: PastedText }, kickoff?: boolean,
/**
 * The agent tool's `context` of a queued follow-up (`submitAsync` option `context`): kept on
 * the queue entry as Node keeps it. Host-only: a connection's request carrying it is
 * `invalidParams`.
 */
context?: string,
/**
 * The stored files' sizes by `attachmentRef`, which the message's attachment records take
 * in place of a part's claimed `sizeBytes` (`attachmentBlobSize`). Host-only, like `context`.
 */
attachmentSizes?: { [key in string]?: number }, };

/**
 * The core's attach decision, the same object for every subscribing method.
 * Wire order after the response: replay frames or a snapshot at
 * `startSeq - 1`, then live events from `startSeq`.
 */
export type Subscription = { id: SubscriptionId, mode: SubscriptionMode, epoch: FeedEpoch, startSeq: number, };

/**
 * One subscription of one connection to one feed.
 */
export type SubscriptionId = string;

export type SubscriptionMode = "replay" | "snapshot";

/**
 * Params of `system/ports/subscribe`.
 */
export type SystemPortsSubscribeParams = Record<string, never>;

/**
 * Params of `system/ports/unsubscribe`.
 */
export type SystemPortsUnsubscribeParams = Record<string, never>;

/**
 * Params of `terminal/attach`.
 */
export type TerminalAttachParams = { tabId: TerminalTabId, resumeFrom?: JsonValue, };

/**
 * Params of `terminal/dispose`.
 */
export type TerminalDisposeParams = { opId: OpId, tabId: TerminalTabId, };

/**
 * Params of `terminal/ensure`.
 */
export type TerminalEnsureParams = { opId: OpId, tabId?: TerminalTabId, options: JsonValue, };

/**
 * Params of `terminal/focus`.
 */
export type TerminalFocusParams = { tabId: TerminalTabId, focused: boolean, };

export type TerminalInputParams = { tabId: TerminalTabId, data: string, };

/**
 * Params of `terminal/pause`.
 */
export type TerminalPauseParams = { tabId: TerminalTabId, };

/**
 * Params of `terminal/profiles`.
 */
export type TerminalProfilesParams = Record<string, never>;

export type TerminalResizeParams = { tabId: TerminalTabId, cols: number, rows: number, };

/**
 * Params of `terminal/resume`.
 */
export type TerminalResumeParams = { tabId: TerminalTabId, };

/**
 * Terminal tab id.
 */
export type TerminalTabId = string;

/**
 * Active-state flags of a loaded thread (Codex flags plus Mixdog's).
 */
export type ThreadActiveFlag = "waitingOnApproval" | "waitingOnUserInput" | "quotaWaiting" | "goalActive" | "backgroundJobs";

/**
 * Params of `thread/agentControl`.
 */
export type ThreadAgentControlParams = { opId: OpId, threadId?: ThreadId, args?: JsonValue, };

export type ThreadAgents = { agentWorkers: Array<JsonValue>, agentJobs: Array<JsonValue>, agentScope: JsonValue | null, };

export type ThreadApprovals = { toolApprovalResult?: ToolApprovalResult, handoffQuestions?: Array<JsonValue>, };

/**
 * Params of `thread/askSide`.
 */
export type ThreadAskSideParams = { opId: OpId, threadId?: ThreadId, question: string, };

export type ThreadBackgroundTerminalParams = { threadId: ThreadId, opId: OpId, taskId: string, };

/**
 * Params of `thread/cancelSide`.
 */
export type ThreadCancelSideParams = { opId: OpId, threadId?: ThreadId, targetThreadId?: ThreadId, };

export type ThreadClearParams = { threadId: ThreadId, opId: OpId, rebuildPrompt?: boolean, };

/**
 * Params of `thread/clearSessionChangeHistory`.
 */
export type ThreadClearSessionChangeHistoryParams = { opId: OpId, threadId?: ThreadId, };

export type ThreadCompactStartParams = { threadId: ThreadId, opId: OpId, options?: JsonValue, };

export type ThreadContext = { contextPercent?: number, contextTokens?: number, contextDefaultPercent?: number, contextWindow: number, displayContextWindow: number, autoCompactTokenLimit: number, stats?: JsonValue, rawContextWindow?: number, effectiveContextWindowPercent?: number, compactBoundaryTokens?: number, };

/**
 * Params of `thread/contextStatus`.
 */
export type ThreadContextStatusParams = { threadId?: ThreadId, options?: JsonValue, };

export type ThreadContinueInModelParams = { threadId: ThreadId, opId: OpId, route: ModelSelection, };

export type ThreadDeleteParams = { threadId: ThreadId, opId: OpId,
/**
 * Today's `deleteSessionIfIdle` expectation (e.g. `{lastUsedAt}`); not idle → the reply `{deleted: false, reason}`, never an error.
 */
ifIdle?: JsonValue, };

export type ThreadFinalAnswerReadParams = { threadId: ThreadId, startedAt: number, };

export type ThreadForkParams = {
/**
 * The source thread; it is never changed.
 */
threadId: ThreadId, opId: OpId,
/**
 * Inherit into this existing empty thread (today's `inheritFrom`); absent creates a new thread.
 */
intoThreadId?: ThreadId, route?: ModelSelection, compact?: boolean, };

/**
 * Params of `thread/getBranchMenu`.
 */
export type ThreadGetBranchMenuParams = { threadId?: ThreadId, };

/**
 * Params of `thread/getSessionUsage`.
 */
export type ThreadGetSessionUsageParams = { threadId?: ThreadId, options?: JsonValue, };

/**
 * Params of `thread/getSessionWorktreeWork`.
 */
export type ThreadGetSessionWorktreeWorkParams = { threadId?: ThreadId, input?: JsonValue, };

export type ThreadGoalControlParams = { threadId: ThreadId, opId: OpId,
/**
 * Today's `goalControl` action other than set/clear.
 */
action: string, args?: JsonValue, };

export type ThreadGoalSetParams = { threadId: ThreadId, opId: OpId, goal: JsonValue, };

export type ThreadHistoryResetParams = { threadId: ThreadId, reason: HistoryResetReason,
/**
 * Items after this one are discarded; absent for `clear`.
 */
fromItemId?: ItemId,
/**
 * `hasOlder` of the thread's transcript after the reset: the only change of
 * that flag outside a snapshot.
 */
hasOlder: boolean, };

/**
 * A thread (today's session, including agent homes, group-room logs and sub-agent sessions).
 */
export type ThreadId = string;

export type ThreadIdParams = { threadId: ThreadId, };

/**
 * Params of `thread/inheritancePreflight`.
 */
export type ThreadInheritancePreflightParams = { threadId?: ThreadId, sourceThreadId?: ThreadId, selection?: JsonValue, };

export type ThreadItem = { "type": "userMessage", id: ItemId, content: Array<UserInput>,
/**
 * Device that submitted the prompt (host-stamped).
 */
device?: string,
/**
 * The client correlation id of the submit.
 */
clientSubmissionId?: string,
/**
 * The turn's change-record key (what review reads and reverts address).
 */
checkpointId?: string, appliedSkills?: Array<string>,
/**
 * The row text Node shows, chips included; the client's `user` row `text`.
 * Computed at commit (migration: for 1.4.5 history).
 */
displayText: string,
/**
 * Whether the prompt belongs in the composer's prompt history.
 * Computed at commit (migration: for 1.4.5 history).
 */
countsForPromptHistory: boolean,
/**
 * Sender, attachments, reactions and the other facts of the row.
 */
details?: UserRowDetails, meta: ItemMeta, } | { "type": "agentMessage", id: ItemId, text: MaybeBlob<string>,
/**
 * Tool use an imported assistant message recorded (Node `importedToolRuns`); the
 * client draws each as tool cards. Empty for every other message.
 */
importedToolRuns?: Array<ImportedToolRun>, meta: ItemMeta, } | { "type": "reasoning", id: ItemId, summary: Array<string>, content: Array<string>, meta: ItemMeta, } | { "type": "contextCompaction", id: ItemId, summary?: MaybeBlob<string>,
/**
 * How it ended; the divider's label (`Conversation compacted`, `Compact failed`, …) and
 * stats are `meta.label` and `meta.detail`.
 */
status?: CompactionStatus, meta: ItemMeta, } | { "type": "subAgentActivity", id: ItemId, agent: string, threadId?: ThreadId, meta: ItemMeta, } | { "type": "toolCall", id: ItemId, name: string, input: JsonValue, output?: MaybeBlob<JsonValue>,
/**
 * The tool row's shared facts (call id, display args/result, timing, aggregate).
 */
run?: ToolRun, meta: ItemMeta, } | { "type": "turnEnd", id: ItemId, status: TurnEndStatus, elapsedMs: number, verb?: string, checkpointId?: string,
/**
 * The turn's last assistant row, on a `done` end.
 */
finalAssistantId?: ItemId,
/**
 * A `failed` end's reason, details, error kind and quota stop.
 */
detail?: string, errorDetails?: string, errorKind?: { [key in string]?: JsonValue }, quota?: { [key in string]?: JsonValue }, meta: ItemMeta, } | { "type": "statusRow", id: ItemId, kind: string, meta: ItemMeta, } | { "type": "roomRow", id: ItemId, room: RoomLine, text: MaybeBlob<string>, attachments?: Array<MessageAttachment>, images?: Array<ImageChip>, reactions?: Array<MessageReaction>, meta: ItemMeta, } | { "type": "agentJob", id: ItemId, tag?: string, taskId?: string, meta: ItemMeta, };

export type ThreadItemsListParams = { threadId: ThreadId, turnId?: TurnId, cursor?: ItemsCursor, limit?: number, sortDirection?: SortDirection, byteBudget?: number, };

export type ThreadItemsListResponse = { data: Array<ThreadItem>, hasOlder: boolean, hasNewer: boolean, nextCursor?: string, backwardsCursor?: string, };

export type ThreadItemsReadParams = { threadId: ThreadId, itemIds: Array<ItemId>, turnId?: TurnId, };

export type ThreadItemsReadResponse = { items: Array<ThreadItem>, };

export type ThreadListParams = { cursor?: string, limit?: number, sortKey?: string, sortDirection?: SortDirection, archived?: boolean, cwd?: string, searchTerm?: string, };

export type ThreadListResponse = { data: Array<ThreadSummary>, nextCursor?: string, backwardsCursor?: string, };

/**
 * Params of `thread/listShellJobs`.
 */
export type ThreadListShellJobsParams = { threadId?: ThreadId, };

/**
 * Params of `thread/listStoppableShellJobs`.
 */
export type ThreadListStoppableShellJobsParams = { threadId?: ThreadId, };

/**
 * Params of `thread/mergeWorkspace`.
 */
export type ThreadMergeWorkspaceParams = { opId: OpId, threadId?: ThreadId, input: JsonValue, };

export type ThreadMetadataUpdateParams = { threadId: ThreadId, opId: OpId, favorite?: boolean,
/**
 * Today's `setSessionProject`.
 */
projectPath?: string, };

export type ThreadModelMessagesListParams = { threadId: ThreadId, start: number, limit?: number, };

export type ThreadNameSetParams = { threadId: ThreadId, opId: OpId, title: string, };

export type ThreadNameUpdatedParams = { threadId: ThreadId, title: string, };

/**
 * `thread/notification`: a runtime notification (a finished background task, a channel
 * message) as Node's `runtime.onNotification` delivers it. The delivered text also lands as
 * a `task-notification` user row; this is the live event with its status.
 */
export type ThreadNotificationParams = { threadId: ThreadId, turnId?: TurnId, content: string,
/**
 * Node's `meta`; `meta.status` is `completed`, `failed`, `cancelled`, `canceled` or
 * `timed_out` when the notification settles a task.
 */
meta: JsonValue, };

export type ThreadOpParams = { threadId: ThreadId, opId: OpId, };

export type ThreadPageParams = { threadId: ThreadId, cursor?: string, limit?: number, };

/**
 * Params of `thread/pushNotice`.
 */
export type ThreadPushNoticeParams = { opId: OpId, threadId?: ThreadId, text: string, level?: string, };

export type ThreadQueueChangedParams = { threadId: ThreadId, queued: Array<JsonValue>, };

export type ThreadQueueDeleteParams = { threadId: ThreadId, opId: OpId,
/**
 * Absent with `restore`: every queued entry is handed back (today's `restoreQueued` with no id).
 */
queuedId?: QueuedId,
/**
 * Today's `restoreQueued` submission identity.
 */
submissionId?: string,
/**
 * Hand the entry back to the composer.
 */
restore: boolean,
/**
 * The composer's text when the entry is handed back (today's `restoreQueued` first
 * argument): the reply's `text` ends with it.
 */
currentText?: string, };

export type ThreadReadParams = { threadId: ThreadId, window?: ResumeWindow, includeTurns?: boolean, };

export type ThreadReadResponse = { thread: ThreadSummary, state: ThreadState, items: Array<ThreadItem>, hasOlder: boolean, turns?: Array<Turn>, };

export type ThreadReadStateUpdateParams = { threadId: ThreadId, opId: OpId, messageCount: number, consumedUnread?: boolean, };

/**
 * Params of `thread/reapplyTurnChanges`.
 */
export type ThreadReapplyTurnChangesParams = { opId: OpId, threadId?: ThreadId, checkpointId: string, file: JsonValue, revision: number, };

/**
 * Params of `thread/requestWorktree`.
 */
export type ThreadRequestWorktreeParams = { opId: OpId, threadId?: ThreadId, input: JsonValue, };

/**
 * Params of `thread/resizeImage`.
 */
export type ThreadResizeImageParams = { opId: OpId, threadId?: ThreadId, input: JsonValue, };

export type ThreadResumeParams = { threadId: ThreadId, window: ResumeWindow, resumeFrom?: ThreadResumePosition, };

/**
 * Thread resume position: replay requires an equal window (P §6.3 rule 3).
 */
export type ThreadResumePosition = { epoch: FeedEpoch, seq: number, window: ResumeWindow, };

export type ThreadResumeResponse = { thread: ThreadSummary, subscription: Subscription, };

/**
 * Params of `thread/revertTurnChanges`.
 */
export type ThreadRevertTurnChangesParams = { opId: OpId, threadId?: ThreadId, checkpointId: string, file: JsonValue, revision: number, };

/**
 * Params of `thread/revertTurnReviewFile`.
 */
export type ThreadRevertTurnReviewFileParams = { opId: OpId, threadId?: ThreadId, file: string, checkpointId?: string, };

/**
 * Params of `thread/revertTurnReview`.
 */
export type ThreadRevertTurnReviewParams = { opId: OpId, threadId?: ThreadId, checkpointId?: string, };

export type ThreadRewindParams = { threadId: ThreadId, opId: OpId, itemId: ItemId, restoreFiles?: boolean, };

/**
 * A group room's log as its views see it while the room runs (Node `agent-room-views.ts`
 * `decorateRoomSnapshot`, pushed with the room's session state): the client lays it over the
 * room log thread's own fields. Absent when the room has no exchange state and no handed-off
 * questions.
 */
export type ThreadRoomView = {
/**
 * The room has an exchange state: the log reads busy (so the composer offers stop).
 */
busy: boolean,
/**
 * The speaking member's pending approval, as Node's queue presents it (`toolApproval`).
 */
toolApproval?: JsonValue,
/**
 * The typing row naming who speaks (`{ kind: 'notice', id, tone: 'info', text, room: { kind:
 * 'typing', speaker, name } }`), shown after the transcript.
 */
typing?: JsonValue,
/**
 * The questions of sessions the members handed work to, while they wait.
 */
handoffQuestions?: Array<JsonValue>, };

export type ThreadRoute = { sessionProvider?: string, sessionModel?: string, fast?: boolean, fastCapable?: boolean, autoEffort?: boolean, modelParameters?: { [key in string]?: string }, selectedContextWindow?: number, effort?: string, provider?: string, model?: string, turnEffort?: string, effortOptions?: Array<JsonValue>, cwd?: string, sessionForkedFrom?: string, systemShell?: JsonValue, webSearchRoute?: JsonValue, autoClear?: JsonValue, };

export type ThreadRuntime = { busy: boolean, commandBusy: boolean, thinking?: JsonValue, spinner?: JsonValue, commandStatus?: JsonValue, progressHint?: JsonValue, activeTools?: JsonValue, storage?: StorageState,
/**
 * Provider keepalives seen while no content arrives (SPEC §4.9), epoch ms.
 */
waitingOnProviderSince?: number, clientHostPid?: number, toasts: Array<JsonValue>, activeToolSummary?: string, toolMode?: string, setupChanged?: JsonValue, };

export type ThreadSearchParams = { query: string, };

/**
 * Params of the `thread/<section>/updated` notifications: one typed section of the projection.
 */
export type ThreadSectionParams<T> = { threadId: ThreadId, value: T, };

/**
 * Params of `thread/selectBranch`.
 */
export type ThreadSelectBranchParams = { opId: OpId, threadId?: ThreadId, input: JsonValue, };

/**
 * The session options Node's `createMixdogSessionRuntime` takes (headless exec sets all of
 * them, `headless-exec.mjs` `createHeadlessSessionRuntime`). Stored in the thread's header.
 */
export type ThreadSessionOptions = {
/**
 * Node default `interactive`.
 */
toolProfile?: ToolProfile,
/**
 * Node default `full`.
 */
toolMode?: SessionToolMode,
/**
 * Node default none: approvals go to a person. Under `implicit` every approval ask is
 * denied at once with Node's text, as when no approval UI is wired.
 */
approvalMode?: ApprovalMode,
/**
 * Node default `false`: the session may not delegate to agents.
 */
disallowDelegation?: boolean,
/**
 * Node default `true`: finished background work wakes the session.
 */
autoWakeCompletions?: boolean,
/**
 * The web-search feature switch for this session (`MIXDOG_FEATURE_WEB_SEARCH`).
 */
webSearch?: boolean,
/**
 * The memory feature switch for this session (`MIXDOG_FEATURE_MEMORY`).
 */
memory?: boolean, };

/**
 * Params of `thread/setCwd`.
 */
export type ThreadSetCwdParams = { opId: OpId, threadId?: ThreadId, path: string, };

/**
 * Params of `thread/setEffort`.
 */
export type ThreadSetEffortParams = { opId: OpId, threadId?: ThreadId, value: string, options?: JsonValue, };

/**
 * Params of `thread/setOrchestrationMode`.
 */
export type ThreadSetOrchestrationModeParams = { opId: OpId, threadId?: ThreadId, mode: string, options?: JsonValue, };

/**
 * Params of `thread/setOutputStyle`.
 */
export type ThreadSetOutputStyleParams = { opId: OpId, threadId?: ThreadId, value: string, };

/**
 * Params of `thread/setToolMode`.
 */
export type ThreadSetToolModeParams = { opId: OpId, threadId?: ThreadId, mode: string, };

/**
 * Params of `thread/setWorkflow`.
 */
export type ThreadSetWorkflowParams = { opId: OpId, threadId?: ThreadId, workflowId: string, options?: JsonValue, };

export type ThreadSnapshotParams = { thread: ThreadSummary, state: ThreadState, items: Array<ThreadItem>, hasOlder: boolean, };

/**
 * Params of `thread/stageAttachmentOriginal`.
 */
export type ThreadStageAttachmentOriginalParams = { opId: OpId, threadId?: ThreadId, input: JsonValue, };

export type ThreadStartKind = "project" | "projectTask" | "task" | "control";

export type ThreadStartParams = { opId: OpId, kind: ThreadStartKind, projectPath?: string, draft?: NewTaskDraft,
/**
 * Starts the first turn in the same request (today's `submitNewTask`).
 */
initialInput?: TurnInput,
/**
 * How the session runs; absent is an interactive session (Node's defaults).
 */
session?: ThreadSessionOptions, };

export type ThreadStartResponse = { thread: ThreadSummary, turn?: TurnStartResponse, };

export type ThreadStartedParams = { thread: ThreadSummary, };

/**
 * The runtime projection of one thread (today's `DesktopSessionState` fields,
 * grouped as the thread-feed notifications of P §5.1 carry them).
 */
export type ThreadState = { title?: string, runtime?: ThreadRuntime, route?: ThreadRoute, context?: ThreadContext, todo?: JsonValue, goal?: JsonValue, queued?: Array<JsonValue>, quotaResume?: QuotaResume, agents?: ThreadAgents, shellJobs?: JsonValue, workflow?: ThreadWorkflow, workspace?: JsonValue, approvals?: ThreadApprovals, promptRestore?: PromptRestore, providerAccountChange?: ProviderAccountChange, remoteEnabled?: boolean,
/**
 * The setup tool's desktop request, from the notice until it is claimed or its claim window
 * ends.
 */
setupUiRequest?: SetupUiRequest,
/**
 * A group room log's view while the room runs (`thread/roomView/updated`).
 */
roomView?: ThreadRoomView,
/**
 * The composer's Up-arrow recall (today's `promptHistoryList`, Node's merged list): the
 * thread's user prompts over the whole transcript plus the per-folder saved prompt
 * history of its cwd, newest first, trimmed, at most `PROMPT_HISTORY_LIMIT` (50), one
 * entry per whitespace-collapsed text.
 */
promptHistoryList?: Array<string>, };

export type ThreadStatus = { "type": "notLoaded" } | { "type": "idle" } | { "type": "systemError" } | { "type": "active", activeFlags: Array<ThreadActiveFlag>, };

export type ThreadStatusChangedParams = { threadId: ThreadId, status: ThreadStatus, };

/**
 * One list row (today's `DesktopSessionSummary`), live on the app feed as
 * `thread/summary/updated`.
 */
export type ThreadSummary = { id: ThreadId, preview: string, title: string, updatedAt: number, messageCount: number, cwd: string,
/**
 * Today's `DesktopSessionClassification`.
 */
classification: JsonValue, projectPath?: string, status?: ThreadStatus, parentThreadId?: ThreadId,
/**
 * Inherit source (`inheritedFromSessionId` today).
 */
forkedFromId?: ThreadId, agentSession?: boolean, activityAt?: number, incomingTail?: number[], compactCount?: number, readMessageCount?: number, readRevision?: number, working?: boolean, leadWorking?: boolean, agentWorking?: boolean, awaitingApproval?: boolean, awaitingQuestion?: boolean, archived?: boolean, favorite?: boolean, agentHome?: string, agentDeleted?: boolean, taskAgent?: string, handedBy?: Array<string>, taskFrom?: string, readWith?: ThreadId, sessionMode?: string,
/**
 * Today's `DesktopAgentRoomSummary`.
 */
agentRoom?: JsonValue, lastMessagePreview?: string,
/**
 * Today's `RoutineProvenance`.
 */
lastMessageRoutine?: JsonValue, sourceType?: string, sourceName?: string, provider?: string, model?: string, createdAt?: number,
/**
 * Today's `DesktopSessionWorkspace`.
 */
workspace?: JsonValue, };

export type ThreadSummaryUpdatedParams = { thread: ThreadSummary, };

/**
 * Params of `thread/switchContext`.
 */
export type ThreadSwitchContextParams = { opId: OpId, threadId?: ThreadId, input?: JsonValue, };

export type ThreadTurnsListParams = { threadId: ThreadId, cursor?: string, limit?: number, sortDirection?: SortDirection, itemsView?: boolean, };

export type ThreadTurnsListResponse = { data: Array<Turn>, nextCursor?: string, };

export type ThreadValueParams = { threadId: ThreadId, value: JsonValue, };

export type ThreadWorkflow = { workflow?: JsonValue, orchestrationMode?: OrchestrationMode, pendingWorkflowSwitch?: boolean, pendingOrchestrationModeSwitch?: boolean, };

/**
 * Params of `tidy/getTidyEngineStatus`.
 */
export type TidyGetTidyEngineStatusParams = { threadId?: ThreadId, };

/**
 * Params of `tidy/getTidyInstallStatus`.
 */
export type TidyGetTidyInstallStatusParams = { threadId?: ThreadId, };

export type TokenUsageUpdatedParams = { threadId: ThreadId, usage: JsonValue, };

/**
 * What an aggregate tool card (`aggregate: true`, name `__aggregate__`) adds.
 */
export type ToolAggregate = {
/**
 * The calls the card folds, in order.
 */
callIds: Array<string>,
/**
 * First-seen order of the `categories` keys (`args.categoryOrder`).
 */
categoryOrder: Array<string>, categories: { [key in string]?: AggregateCategory }, doneCategories: { [key in string]?: AggregateCategory }, completedCount: number, };

/**
 * Mixdog's `ToolApprovalDecision` without `device`: the core stamps the
 * device from the answering connection (P §8.1). The result type of every
 * approval server request.
 */
export type ToolApprovalDecision = { approved: boolean, reason?: string,
/**
 * `ask_user` answers aligned with the questions; `null` = unanswered.
 */
answers?: Array<QuestionAnswer | null>,
/**
 * `ask_user`: the composer message that answered the question.
 */
reply?: string,
/**
 * Human-in-the-loop response; a secret value never travels here (`approval/provideSecret`).
 */
response?: HumanGateResponse,
/**
 * edit-and-approve: the edited text of the request's editable fields.
 */
editedArgs?: { [key in string]?: string }, remember?: ApprovalRemember,
/**
 * Permission requests: the chosen scope id.
 */
scope?: string, };

export type ToolApprovalKind = "shell" | "patch" | "mcp" | "builtin" | "outbound" | "humanGate";

export type ToolApprovalRequestParams = { kind: ToolApprovalKind, tool: string,
/**
 * The card content (tool input, editable fields, reason).
 */
request: JsonValue, threadId: ThreadId, turnId?: TurnId, itemId?: ItemId,
/**
 * Top-level chat that shows a sub-agent's request.
 */
surfaceThreadId?: ThreadId,
/**
 * Delegation chain from the surface thread to the asking thread.
 */
chain?: Array<ThreadId>, requestedAt: number, expiresAt?: number,
/**
 * Per-surface presentation order; the lowest is the active card (P §8.5).
 */
order: number, };

/**
 * How the last approval of a thread ended (today's `toolApprovalResult`).
 */
export type ToolApprovalResult = { id: string, approved: boolean, device: string, at: number, expired?: boolean, withdrawn?: boolean, interrupted?: boolean, };

export type ToolBatchPhase = "started" | "completed";

/**
 * `thread/toolBatch/updated`: the tool calls of one model response run together (Node
 * `tool.batch.*`). Batch ids are `tool_batch_<request index>`.
 */
export type ToolBatchUpdatedParams = { threadId: ThreadId, turnId: TurnId, batchId: string, phase: ToolBatchPhase,
/**
 * On `completed`.
 */
iteration?: number,
/**
 * On `completed`: the calls the batch ran.
 */
calls?: number,
/**
 * On `completed`.
 */
durationMs?: number, };

/**
 * A model tool call (the provider's call id as received).
 */
export type ToolCallId = string;

/**
 * A result's side channel: a stable code, the missing capability names and, for a
 * `visualize` call run for another session's work, that owner session.
 */
export type ToolMeta = { code: string, missing: Array<string>, ownerSessionId?: string, };

/**
 * Value of the `toolModules` section.
 */
export type ToolModuleSettings = { instructionFiles: InstructionFilesMode, autoEffortBase: AutoEffortBase, webSearch: EnabledModule, memory: MemoryModule, git: InstallableModule, office: InstallableModule, tidy: InstallableModule, visualize: InstallableModule, media: InstallableModule, localProvider: LocalProviderModule, autoEffort: AutoEffortModule, };

/**
 * `normalizeToolProfile`'s value set.
 */
export type ToolProfile = "interactive" | "headless" | "heartbeat";

/**
 * The facts of a tool row shared by every tool-backed item variant
 * (today's `kind: 'tool'` row). `args`, `result` and `rawResult` are the
 * row's display values; the variant's own fields stay the typed call.
 */
export type ToolRun = {
/**
 * The call id tying the row to its call and result messages.
 */
callId?: string, result?: MaybeBlob<string>, rawResult?: MaybeBlob<string>, isError?: boolean, startedAt?: number, completedAt?: number, uiDiff?: MaybeBlob<string>,
/**
 * The structured side channel of a result (`toolMeta`).
 */
toolMeta?: ToolMeta, count?: number, completedCount?: number, aggregate?: ToolAggregate,
/**
 * Built by a live turn's tool cards (`turn-tool-cards.mjs`): the row reads as that turn's card, an `__aggregate__`
 * even for one call, not as the card a restore rebuilds (`mergeRestoredToolItems` merges only two or more).
 */
live?: boolean, };

/**
 * Params of `tools/toolsStatus`.
 */
export type ToolsToolsStatusParams = { threadId?: ThreadId, query?: string, };

/**
 * Params of `transfer/abort`.
 */
export type TransferAbortParams = { transferId: TransferId, };

export type TransferBeginReadParams = { source: TransferSource, };

export type TransferBeginReadResponse = { transferId: TransferId, size: number, mimeType?: string,
/**
 * Domain detail of the opened entry (today's preview/download descriptor).
 */
entry?: JsonValue, };

/**
 * Params of `transfer/beginWrite`.
 */
export type TransferBeginWriteParams = { opId: OpId, root?: string, rel?: string, size: number, name?: string, scope?: string, };

/**
 * Params of `transfer/beginZip`.
 */
export type TransferBeginZipParams = { root: string, rel: string, };

/**
 * Params of `transfer/commit`.
 */
export type TransferCommitParams = { opId: OpId, transferId: TransferId, };

/**
 * Params of `transfer/endRead`.
 */
export type TransferEndReadParams = { transferId: TransferId, };

/**
 * Params of `transfer/grant/mint`.
 */
export type TransferGrantMintParams = { path: string, sessionId?: string, };

/**
 * One read or write transfer.
 */
export type TransferId = string;

/**
 * Params of `transfer/readRange`.
 */
export type TransferReadRangeParams = { transferId?: TransferId, root?: string, rel?: string, offset: number, length: number, };

/**
 * What a read transfer opens; the real path is verified after open.
 */
export type TransferSource = { "kind": "file", root: string, rel: string, } | { "kind": "localFile", path: string, } | { "kind": "mediaAsset", assetId: string, } | { "kind": "attachment", threadId: ThreadId, attachmentId: string, } | { "kind": "export", input: JsonValue, } | { "kind": "granted", accessToken: string, projectPath: string, relPath: string, };

/**
 * Params of `transfer/trash/entry`.
 */
export type TransferTrashEntryParams = { opId: OpId, path: string, rel: string, permanent?: boolean, };

/**
 * Params of `transfer/trash/info`.
 */
export type TransferTrashInfoParams = { path: string, };

/**
 * Params of `transfer/writeChunk`.
 */
export type TransferWriteChunkParams = { transferId: TransferId, offset: number, bytesB64: string, };

export type Turn = { id: TurnId, status: TurnStatus, startedAt?: number, completedAt?: number, error?: TurnError,
/**
 * The model's stop reason of the turn's final answer (Node `result.stopReason`, a provider
 * string such as `end_turn`); on a completed turn only.
 */
stopReason?: string,
/**
 * Why the turn ended where it did (Node `result.terminationReason`; `refusal` is the one
 * the headless result treats as an error); on a completed turn only.
 */
terminationReason?: string,
/**
 * Present only when the read asked for items (`itemsView`).
 */
items?: Array<ThreadItem>, };

/**
 * How a turn ended (`turndone.status`).
 */
export type TurnEndStatus = "done" | "failed" | "cancelled";

/**
 * Why a turn failed: an error reason object (`{reason, …}`, P §10) and,
 * for provider failures, the typed upstream detail.
 */
export type TurnError = { message: string,
/**
 * `{reason, …typed fields}` exactly as in JSON-RPC error `data` (P §10).
 */
data: JsonValue, providerError?: ProviderErrorDetail, };

/**
 * One run: user input to final answer.
 */
export type TurnId = string;

export type TurnInput = { prompt: PromptContent, options?: SubmitOptions, };

export type TurnInterruptParams = { threadId: ThreadId, turnId?: TurnId,
/**
 * Rewind a submitted prompt only when the composer was empty at cancel.
 */
restorePrompt?: boolean, submissionId?: string, };

/**
 * Fixed C0 reply (R12).
 */
export type TurnInterruptResponse = {
/**
 * Always `true`.
 */
cancelRequested: boolean, turnId?: TurnId, };

export type TurnNotificationParams = { threadId: ThreadId, turn: Turn, };

export type TurnRetryFailedParams = { threadId: ThreadId, opId: OpId, turnKey: string, };

export type TurnStartParams = { threadId: ThreadId, opId: OpId, input: TurnInput, };

/**
 * `turn/start` answers once the input is a turn or a queued entry (X9).
 */
export type TurnStartResponse = { "kind": "started", turnId: TurnId, } | { "kind": "queued", queuedId: QueuedId, };

export type TurnStatus = "inProgress" | "completed" | "interrupted" | "failed";

export type TurnSteerParams = { threadId: ThreadId,
/**
 * Absent: the core steers the thread's active turn (today's `prioritizeQueued` names none).
 */
expectedTurnId?: TurnId, queuedId: QueuedId, };

/**
 * Fixed C0 reply (R12).
 */
export type TurnSteerResponse = {
/**
 * Always `true`.
 */
accepted: boolean, queuedId: QueuedId, };

/**
 * Client notification `ui/newTab/created` (UI → core): the pane created the tab that request
 * `openRequestId` (a `ui/openRequested` visualize open with `openUrl`) asked for, and this is
 * the page's agent-facing id (`p…`), Node's `watchNewTab(...).page`.
 *
 * Semantics, from `main/browser/new-tab-waiters.ts`: the core starts waiting when it publishes
 * the open and answers the agent's `open` with this page id. Only a report whose `sessionId`
 * and `openRequestId` both match the pending open settles it, once; a tab nobody named (the
 * user's "+"), another request's tab or a different session's says nothing about it. There is
 * no negative report: a pane that drops or replaces the request sends nothing, so the wait
 * ends with no page id after 3000 ms, or when the open is cancelled, a new open reuses the
 * request id, or the session's browser is released. With no page id the agent is told to find
 * the page with the browser tool's `list_tabs`.
 */
export type UiNewTabCreatedParams = { sessionId: string, openRequestId: string, pageId: string, };

/**
 * `DesktopBrowserOpenRequest` (`shared/contract-browser.ts`).
 */
export type UiOpenBrowser = { sessionId: string,
/**
 * `false` creates or retains the surface without opening the session dock.
 */
reveal?: boolean,
/**
 * Hide only: never create or release pages; overrides `reveal`.
 */
hide?: boolean,
/**
 * A takeover hand-off: the user must act on the page, so the panel opens even where closed.
 */
handoff?: boolean,
/**
 * An agent's `open`: the page it showed (session-local id `p…`).
 */
tabId?: string, title?: string,
/**
 * An agent's `open` that failed, and why: nothing is revealed for it.
 */
error?: string, };

/**
 * App-feed event (`desktop-services.md` §12.4): the core asks attached UIs to open something.
 * One variant per Node flow it replaces: `browser-open-requested`, `terminal-run-requested`
 * and the visualize open (`visualize/open-actions.ts`).
 */
export type UiOpenRequestedParams = { "kind": "browser" } & UiOpenBrowser | { "kind": "terminal" } & UiOpenTerminal | { "kind": "visualize" } & UiOpenVisualize;

/**
 * `DesktopTerminalRunRequest` (`shared/terminal-command.ts`): the `terminal` tool ran a command
 * in one of the session's terminals.
 */
export type UiOpenTerminal = { sessionId: string,
/**
 * The terminal the command went to; its tab is selected. (The spec's §6.3 sketch calls it
 * `tabId`; Node's request, which this follows, calls it `terminalId`.)
 */
terminalId?: string,
/**
 * Every terminal the core runs for the session: tabs the device lacks are added.
 */
tabs?: Array<UiTerminalTab>,
/**
 * The core waits on this: the desktop renderer claims it once a pane really shows
 * `terminalId`; unclaimed, the run is reported as running in the background. Not sent to
 * paired clients.
 */
requestId?: string, };

/**
 * The visualize open: a web URL handed to the session's browser panel (`openUrl`), or a
 * revealed tab (`reveal`, `tab`), as `DesktopVisualizeEvent` carries them.
 */
export type UiOpenVisualize = { sessionId: string, openUrl?: string,
/**
 * With `openUrl`: names the request, so the browser tab the pane creates reports back to
 * the agent's open (`ui/newTab/created`) and no other tab does.
 */
openRequestId?: string,
/**
 * An agent open or content update: bring the panel up on this tab.
 */
tab?: string, reveal?: boolean, };

/**
 * Client notification `ui/screenSessions/changed` (UI → core): the sessions the user is looking
 * at right now. Node asks `isSessionOnScreen(sessionId)` (`screen-sessions.ts`) at each
 * delivery: true only while the window is visible, not minimized and focused, and its page
 * reports painting that session. The host applies those window conditions itself, so this is
 * the effective set: empty while the window is hidden, minimized or unfocused, or its page is
 * gone (reload, navigation, renderer crash). It is a full replacement, sent on every change of
 * the set (a report from the page, focus, blur, minimize, hide, show) and once when the UI
 * attaches. The core treats a session as on screen only while it is in the latest set, and
 * treats a detached UI as an empty set. No response.
 *
 * A paired phone sends the same notification over its relay connection, with its page
 * visibility and app foreground applied. `browserId` is the id its direct Web Push
 * subscription is keyed by (Node's `setForeground(visible, browserId)`): at most 64 UTF-16
 * units, kept until the phone states another, and ignored on every connection that is not a
 * relay connection.
 */
export type UiScreenSessionsChangedParams = { sessionIds: Array<string>, browserId?: string, };

/**
 * Client notification `ui/terminalRun/claimed` (UI → core): a pane now shows the terminal of a
 * `ui/openRequested` terminal open that carried `requestId`.
 *
 * No response. The core waits for the claim 2000 ms (the renderer's 1500 ms shown-wait plus
 * 500 ms for the claim's trip back) and then settles the run as `shown: false`, reported to the
 * agent as running in the background; with no UI attached it settles `shown: false` at once. A
 * claim settles its run once: a claim for an unknown or already-settled id has no effect.
 */
export type UiTerminalRunClaimedParams = { requestId: string, };

/**
 * `DesktopTerminalRunTab`.
 */
export type UiTerminalTab = { id: string,
/**
 * Tab number within the session (1 = the session's first terminal).
 */
tab: number, cwd?: string | null, };

/**
 * Params of `update/checkForUpdate`.
 */
export type UpdateCheckForUpdateParams = { opId: OpId, threadId?: ThreadId, options?: JsonValue, };

/**
 * Params of `update/desktop/command` (any client → core).
 */
export type UpdateDesktopCommandParams = { opId: OpId, action: UpdaterAction, };

/**
 * Params of `update/getUpdateStatus`.
 */
export type UpdateGetUpdateStatusParams = { threadId?: ThreadId, };

/**
 * Params of `update/runUpdateNow`.
 */
export type UpdateRunUpdateNowParams = { opId: OpId, threadId?: ThreadId, };

export type UpdaterAction = "check" | "install";

/**
 * Params of `usage/getUsageDashboard`.
 */
export type UsageGetUsageDashboardParams = { threadId?: ThreadId, options?: JsonValue, };

/**
 * Params of `usage/getUsageRequests`.
 */
export type UsageGetUsageRequestsParams = { threadId?: ThreadId, options?: JsonValue, };

/**
 * Params of `usage/getUsageStats`.
 */
export type UsageGetUsageStatsParams = { threadId?: ThreadId, options?: JsonValue, };

/**
 * One input element of a user message.
 */
export type UserInput = { "type": "text", text: string, } | { "type": "attachment", blob: BlobDescriptor, filename?: string, original?: BlobDescriptor, } | { "type": "pastedText", text: MaybeBlob<string>, filename?: string, };

export type UserInputRequestParams = {
/**
 * `ask_user` questions (including room hand-off questions).
 */
questions: Array<JsonValue>, threadId: ThreadId, turnId?: TurnId, itemId?: ItemId,
/**
 * Top-level chat that shows a sub-agent's request.
 */
surfaceThreadId?: ThreadId,
/**
 * Delegation chain from the surface thread to the asking thread.
 */
chain?: Array<ThreadId>, requestedAt: number, expiresAt?: number,
/**
 * Per-surface presentation order; the lowest is the active card (P §8.5).
 */
order: number, };

/**
 * Who and what a user row came from, beyond its content.
 */
export type UserRowDetails = {
/**
 * What the message is; absent for a typed prompt.
 */
source?: MessageSource, routineTrigger?: RoutineTrigger,
/**
 * The request of a `held-request` message; the client's row carries it as `heldRequest`.
 */
heldRequest?: HeldRequest,
/**
 * The sender (`lead` for the user's Lead session).
 */
sender?: string,
/**
 * The bot that sent the message (a bot's `session send`).
 */
fromAgent?: string,
/**
 * Delivered into the running turn (steering): the row's read mark.
 */
steered?: boolean,
/**
 * Every submission a merged queued batch delivered as this turn.
 */
submissionIds: Array<string>,
/**
 * The executions a woken batch delivered; `null` keeps the position of an entry that named none.
 */
consumedExecutionIds: Array<string | null>,
/**
 * Bot-to-bot chain position.
 */
hop?: number,
/**
 * The bots that handed the message on, sender last.
 */
botChain: Array<string>,
/**
 * A group-room member turn: the newest user row of the room log its prompt shows.
 */
roomRow?: string, attachments: Array<MessageAttachment>, images: Array<ImageChip>, imageRefs: Array<ImageRef>, reactions: Array<MessageReaction>, };

/**
 * The visualize service's actions (`host/visualize/command`).
 */
export type VisualizeAction = "open" | "close" | "annotate" | "capture" | "export" | "check" | "inspect" | "act";

/**
 * The agent's mark on displayed pane `pane` (selectors and labels only).
 */
export type VisualizeAnnotation = { pane: number, selector: string, label?: string, };

/**
 * Params of `visualize/command`.
 */
export type VisualizeCommandParams = { action: string, input?: JsonValue, };

/**
 * An open of a finished turn whose tab had nothing left to show.
 */
export type VisualizeGoneOpen = { tab: string, call: string, };

/**
 * One thing opened in a session (open or since closed); path-free.
 */
export type VisualizeHistoryItem = { id: string, label: string, kind: VisualizeHistoryKind, versions: number,
/**
 * When it was last opened (ms since epoch).
 */
at: number, open: boolean, };

/**
 * The pane kinds and inline kinds a history entry can show, or a `split` of several.
 */
export type VisualizeHistoryKind = "html" | "document" | "pdf" | "image" | "audio" | "video" | "inline" | "mermaid" | "svg" | "chart" | "markdown" | "split";

/**
 * `VisualizeHostEvent` (`apps/desktop/src/shared/visualize.ts`), main → core: the change
 * `DesktopVisualizeEvent` carries, with host paths.
 */
export type VisualizeHostEvent = { sessionId: string, state?: VisualizeHostState, reveal?: boolean,
/**
 * With `reveal`: the tab the open or update was for.
 */
tab?: string,
/**
 * A content update of this tab.
 */
updated?: string,
/**
 * Sent while the session's agent turn runs.
 */
held?: boolean,
/**
 * With `held`: when the turn started (ms).
 */
heldSince?: number, openUrl?: string, };

/**
 * A pane with the symlink-resolved file it shows.
 */
export type VisualizeHostPane = { kind: VisualizePaneKind, label: string, target: string,
/**
 * `""` for an `inline` pane, which has no file.
 */
path: string, inline?: VisualizeInlineContent,
/**
 * What a remote client is told the target is.
 */
remoteTarget: string,
/**
 * The folder this pane's file and page assets must stay inside.
 */
root?: string, version?: number,
/**
 * Inline panes: the render id a remote client's report must carry.
 */
remoteRenderId?: string, };

/**
 * One session's tabs with their resolved files.
 */
export type VisualizeHostState = { sessionId: string, tabs: Array<VisualizeHostTab>,
/**
 * Always written; `null` when no tab is active.
 */
active: string | null, history?: Array<VisualizeHistoryItem>, goneOpens?: Array<VisualizeGoneOpen>, };

export type VisualizeHostTab = { id: string, label: string,
/**
 * The label a remote client sees.
 */
remoteLabel: string, revision: number,
/**
 * The working directory every pane and page asset must stay inside.
 */
cwd: string, panes: Array<VisualizeHostPane>,
/**
 * Always `true` when present.
 */
missing?: true, problems?: Array<VisualizeProblem>,
/**
 * Always `true` when present.
 */
networkAllowed?: true, versions?: Array<VisualizeVersionView>,
/**
 * The version shown instead of the live files; `null` = live.
 */
version?: number | null, compare?: boolean, restoreAssets?: Array<string>,
/**
 * A data URL.
 */
thumbnail?: string, thumbnailVersion?: number, annotations?: Array<VisualizeAnnotation>, };

/**
 * What the desktop publishes under `visualize`: the visualize service's `hostSnapshot()`
 * (every session's state, sent again on each claim) or one `publishRemote` change event.
 */
export type VisualizeHostValue = Array<VisualizeHostState> | VisualizeHostEvent;

export type VisualizeInlineContent = { kind: VisualizeInlineKind, source: string, title?: string,
/**
 * Always `true` when present: a device's snapshot left the source out.
 */
deferred?: true, };

/**
 * What `open` can render straight from `input.content`.
 */
export type VisualizeInlineKind = "mermaid" | "svg" | "chart" | "html" | "markdown";

export type VisualizePaneKind = "html" | "document" | "pdf" | "image" | "audio" | "video" | "inline";

/**
 * One distinct runtime problem of a tab's HTML pane; `source` is project-relative.
 */
export type VisualizeProblem = { kind: VisualizeProblemKind, message: string, source: string, line: number, count: number,
/**
 * Index of the pane (in the tab's displayed panes) it came from.
 */
pane: number, version?: number, };

export type VisualizeProblemKind = "exception" | "rejection" | "csp" | "asset-failed" | "blocked-network" | "blocked-navigation" | "load" | "console-error" | "console-warn" | "render";

/**
 * One agent turn's span (ms since epoch).
 */
export type VisualizeVersionTurn = { since: number, end: number, };

/**
 * One kept version of a tab's files (`n` counts up per tab from 1).
 */
export type VisualizeVersionView = { n: number,
/**
 * When it was kept (ms since epoch).
 */
at: number, label?: string, turns?: Array<VisualizeVersionTurn>, };

/**
 * Params of `voice/getVoiceStatus`.
 */
export type VoiceGetVoiceStatusParams = { threadId?: ThreadId, };

/**
 * Params of `voice/prepareTranscription`.
 */
export type VoicePrepareTranscriptionParams = { opId: OpId, threadId?: ThreadId, };

/**
 * Params of `voice/toggleVoice`.
 */
export type VoiceToggleVoiceParams = { opId: OpId, threadId?: ThreadId, enabled: boolean, };

/**
 * Params of `voice/transcribeAudio`.
 */
export type VoiceTranscribeAudioParams = { opId: OpId, threadId?: ThreadId, input: JsonValue, };

/**
 * W3C trace context carried on requests.
 */
export type W3cTraceContext = { traceparent: string, tracestate?: string, };

export type WarningParams = { message: string, threadId?: ThreadId,
/**
 * `configWarning`: the offending config path.
 */
path?: string, detail?: JsonValue, };

/**
 * Client-chosen, connection-owned watch id of `fs/watch`.
 */
export type WatchId = string;

/** Params and result of every client method. */
export type ClientMethods = {
  "initialize": { params: InitializeParams; result: InitializeResponse };
  "app/subscribe": { params: AppSubscribeParams; result: AppSubscribeResponse };
  "feed/subscribe": { params: FeedSubscribeParams; result: FeedSubscribeResponse };
  "feed/unsubscribe": { params: FeedUnsubscribeParams; result: EmptyResult };
  "op/status": { params: OpStatusParams; result: OpStatusResponse };
  "blob/read": { params: BlobReadParams; result: BlobReadResponse };
  "blob/put": { params: BlobPutParams; result: EmptyResult };
  "model/list": { params: ModelListParams; result: JsonValue };
  "feedback/upload": { params: FeedbackUploadParams; result: JsonValue };
  "approval/provideSecret": { params: ApprovalProvideSecretParams; result: EmptyResult };
  "channel/call": { params: ChannelCallParams; result: JsonValue };
  "route/set": { params: RouteSetParams; result: JsonValue };
  "fast/set": { params: FastSetParams; result: JsonValue };
  "thread/start": { params: ThreadStartParams; result: ThreadStartResponse };
  "thread/resume": { params: ThreadResumeParams; result: ThreadResumeResponse };
  "thread/unsubscribe": { params: ThreadIdParams; result: EmptyResult };
  "thread/list": { params: ThreadListParams; result: ThreadListResponse };
  "thread/read": { params: ThreadReadParams; result: ThreadReadResponse };
  "thread/turns/list": { params: ThreadTurnsListParams; result: ThreadTurnsListResponse };
  "thread/items/list": { params: ThreadItemsListParams; result: ThreadItemsListResponse };
  "thread/items/read": { params: ThreadItemsReadParams; result: ThreadItemsReadResponse };
  "thread/attachment/list": { params: ThreadPageParams; result: JsonValue };
  "thread/modelMessages/list": { params: ThreadModelMessagesListParams; result: JsonValue };
  "thread/finalAnswer/read": { params: ThreadFinalAnswerReadParams; result: JsonValue };
  "thread/readState/update": { params: ThreadReadStateUpdateParams; result: JsonValue };
  "thread/search": { params: ThreadSearchParams; result: JsonValue };
  "thread/name/set": { params: ThreadNameSetParams; result: JsonValue };
  "thread/metadata/update": { params: ThreadMetadataUpdateParams; result: JsonValue };
  "thread/archive": { params: ThreadOpParams; result: JsonValue };
  "thread/unarchive": { params: ThreadOpParams; result: JsonValue };
  "thread/delete": { params: ThreadDeleteParams; result: JsonValue };
  "thread/fork": { params: ThreadForkParams; result: JsonValue };
  "thread/continueInModel": { params: ThreadContinueInModelParams; result: JsonValue };
  "thread/rewind": { params: ThreadRewindParams; result: JsonValue };
  "thread/clear": { params: ThreadClearParams; result: JsonValue };
  "thread/compact/start": { params: ThreadCompactStartParams; result: JsonValue };
  "thread/queue/delete": { params: ThreadQueueDeleteParams; result: JsonValue };
  "thread/goal/set": { params: ThreadGoalSetParams; result: JsonValue };
  "thread/goal/clear": { params: ThreadOpParams; result: JsonValue };
  "thread/goal/control": { params: ThreadGoalControlParams; result: JsonValue };
  "thread/quotaResume/schedule": { params: ThreadOpParams; result: JsonValue };
  "thread/quotaResume/cancel": { params: ThreadOpParams; result: JsonValue };
  "thread/backgroundTerminals/terminate": { params: ThreadBackgroundTerminalParams; result: JsonValue };
  "thread/backgroundTerminals/release": { params: ThreadBackgroundTerminalParams; result: JsonValue };
  "thread/backgroundTerminals/clean": { params: ThreadOpParams; result: JsonValue };
  "turn/start": { params: TurnStartParams; result: TurnStartResponse };
  "turn/interrupt": { params: TurnInterruptParams; result: TurnInterruptResponse };
  "turn/steer": { params: TurnSteerParams; result: TurnSteerResponse };
  "turn/retryFailed": { params: TurnRetryFailedParams; result: JsonValue };
  "thread/contextStatus": { params: ThreadContextStatusParams; result: JsonValue };
  "thread/getSessionUsage": { params: ThreadGetSessionUsageParams; result: JsonValue };
  "thread/getSessionWorktreeWork": { params: ThreadGetSessionWorktreeWorkParams; result: JsonValue };
  "thread/inheritancePreflight": { params: ThreadInheritancePreflightParams; result: JsonValue };
  "thread/listShellJobs": { params: ThreadListShellJobsParams; result: JsonValue };
  "thread/listStoppableShellJobs": { params: ThreadListStoppableShellJobsParams; result: JsonValue };
  "thread/getBranchMenu": { params: ThreadGetBranchMenuParams; result: JsonValue };
  "thread/askSide": { params: ThreadAskSideParams; result: JsonValue };
  "thread/cancelSide": { params: ThreadCancelSideParams; result: JsonValue };
  "thread/agentControl": { params: ThreadAgentControlParams; result: JsonValue };
  "thread/switchContext": { params: ThreadSwitchContextParams; result: JsonValue };
  "thread/setCwd": { params: ThreadSetCwdParams; result: JsonValue };
  "thread/setEffort": { params: ThreadSetEffortParams; result: JsonValue };
  "thread/setToolMode": { params: ThreadSetToolModeParams; result: JsonValue };
  "thread/setWorkflow": { params: ThreadSetWorkflowParams; result: JsonValue };
  "thread/setOrchestrationMode": { params: ThreadSetOrchestrationModeParams; result: JsonValue };
  "thread/setOutputStyle": { params: ThreadSetOutputStyleParams; result: JsonValue };
  "thread/revertTurnReview": { params: ThreadRevertTurnReviewParams; result: JsonValue };
  "thread/revertTurnReviewFile": { params: ThreadRevertTurnReviewFileParams; result: JsonValue };
  "thread/revertTurnChanges": { params: ThreadRevertTurnChangesParams; result: JsonValue };
  "thread/reapplyTurnChanges": { params: ThreadReapplyTurnChangesParams; result: JsonValue };
  "thread/clearSessionChangeHistory": { params: ThreadClearSessionChangeHistoryParams; result: JsonValue };
  "thread/stageAttachmentOriginal": { params: ThreadStageAttachmentOriginalParams; result: JsonValue };
  "thread/resizeImage": { params: ThreadResizeImageParams; result: JsonValue };
  "thread/pushNotice": { params: ThreadPushNoticeParams; result: JsonValue };
  "thread/requestWorktree": { params: ThreadRequestWorktreeParams; result: JsonValue };
  "thread/mergeWorkspace": { params: ThreadMergeWorkspaceParams; result: JsonValue };
  "thread/selectBranch": { params: ThreadSelectBranchParams; result: JsonValue };
  "project/inspectProjectBranch": { params: ProjectInspectProjectBranchParams; result: JsonValue };
  "project/getProjectBranchMenu": { params: ProjectGetProjectBranchMenuParams; result: JsonValue };
  "project/getProjectConnectors": { params: ProjectGetProjectConnectorsParams; result: JsonValue };
  "project/listWorktrees": { params: ProjectListWorktreesParams; result: JsonValue };
  "project/previewWorktreeCleanup": { params: ProjectPreviewWorktreeCleanupParams; result: JsonValue };
  "project/selectProjectBranch": { params: ProjectSelectProjectBranchParams; result: JsonValue };
  "project/mergeProjectBranch": { params: ProjectMergeProjectBranchParams; result: JsonValue };
  "project/manageProjectBranch": { params: ProjectManageProjectBranchParams; result: JsonValue };
  "project/removeWorktree": { params: ProjectRemoveWorktreeParams; result: JsonValue };
  "project/pruneWorktrees": { params: ProjectPruneWorktreesParams; result: JsonValue };
  "project/deleteWorktree": { params: ProjectDeleteWorktreeParams; result: JsonValue };
  "project/setArchivedSessionWorktrees": { params: ProjectSetArchivedSessionWorktreesParams; result: JsonValue };
  "project/setProjectConnectorEnabled": { params: ProjectSetProjectConnectorEnabledParams; result: JsonValue };
  "agent/agentDefinitionPresence": { params: AgentAgentDefinitionPresenceParams; result: JsonValue };
  "agent/archivedAgentIdentities": { params: AgentArchivedAgentIdentitiesParams; result: JsonValue };
  "agent/getAgentDefinition": { params: AgentGetAgentDefinitionParams; result: JsonValue };
  "agent/getAgentAvatarImage": { params: AgentGetAgentAvatarImageParams; result: JsonValue };
  "agent/getAgentConnectors": { params: AgentGetAgentConnectorsParams; result: JsonValue };
  "agent/getAgentAlwaysAllowedTools": { params: AgentGetAgentAlwaysAllowedToolsParams; result: JsonValue };
  "agent/getAgentConnectorTools": { params: AgentGetAgentConnectorToolsParams; result: JsonValue };
  "agent/getAgentPermissions": { params: AgentGetAgentPermissionsParams; result: JsonValue };
  "agent/getLeadPersona": { params: AgentGetLeadPersonaParams; result: JsonValue };
  "agent/getLeadAgentBody": { params: AgentGetLeadAgentBodyParams; result: JsonValue };
  "agent/getLeadStatus": { params: AgentGetLeadStatusParams; result: JsonValue };
  "agent/getLeadHomeRoute": { params: AgentGetLeadHomeRouteParams; result: JsonValue };
  "agent/getLeadAppearance": { params: AgentGetLeadAppearanceParams; result: JsonValue };
  "agent/saveAgentDefinition": { params: AgentSaveAgentDefinitionParams; result: JsonValue };
  "agent/deleteAgentDefinition": { params: AgentDeleteAgentDefinitionParams; result: JsonValue };
  "agent/restoreAgentDefinition": { params: AgentRestoreAgentDefinitionParams; result: JsonValue };
  "agent/purgeAgentDefinition": { params: AgentPurgeAgentDefinitionParams; result: JsonValue };
  "agent/setAgentConnectors": { params: AgentSetAgentConnectorsParams; result: JsonValue };
  "agent/setAgentConnectorEnabled": { params: AgentSetAgentConnectorEnabledParams; result: JsonValue };
  "agent/setAgentConnectorToolPermission": { params: AgentSetAgentConnectorToolPermissionParams; result: JsonValue };
  "agent/setAgentPermission": { params: AgentSetAgentPermissionParams; result: JsonValue };
  "agent/recordAgentApprovalAudit": { params: AgentRecordAgentApprovalAuditParams; result: JsonValue };
  "agent/saveLeadPersona": { params: AgentSaveLeadPersonaParams; result: JsonValue };
  "agent/saveLeadAgentBody": { params: AgentSaveLeadAgentBodyParams; result: JsonValue };
  "agent/setLeadCreated": { params: AgentSetLeadCreatedParams; result: JsonValue };
  "agent/saveLeadIdentity": { params: AgentSaveLeadIdentityParams; result: JsonValue };
  "agent/setLeadAppearance": { params: AgentSetLeadAppearanceParams; result: JsonValue };
  "config/getBotOrder": { params: ConfigGetBotOrderParams; result: BotOrder };
  "config/setBotOrder": { params: ConfigSetBotOrderParams; result: BotOrder };
  "agent/home/open": { params: AgentHomeOpenParams; result: JsonValue };
  "agent/home/reset": { params: AgentHomeResetParams; result: JsonValue };
  "agent/memory/list": { params: AgentMemoryListParams; result: JsonValue };
  "agent/memory/delete": { params: AgentMemoryDeleteParams; result: JsonValue };
  "agent/pool/list": { params: AgentPoolListParams; result: JsonValue };
  "room/create": { params: RoomCreateParams; result: JsonValue };
  "room/update": { params: RoomUpdateParams; result: JsonValue };
  "room/continue": { params: RoomContinueParams; result: JsonValue };
  "room/leave": { params: RoomLeaveParams; result: JsonValue };
  "room/remove": { params: RoomRemoveParams; result: JsonValue };
  "instructions/listInstructionFiles": { params: InstructionsListInstructionFilesParams; result: JsonValue };
  "instructions/getInstructionFile": { params: InstructionsGetInstructionFileParams; result: JsonValue };
  "instructions/saveInstructionFile": { params: InstructionsSaveInstructionFileParams; result: JsonValue };
  "instructions/resetInstructionFile": { params: InstructionsResetInstructionFileParams; result: JsonValue };
  "instructions/setInstructionFiles": { params: InstructionsSetInstructionFilesParams; result: JsonValue };
  "connector/listConnectorTools": { params: ConnectorListConnectorToolsParams; result: JsonValue };
  "connector/addConnectorAccount": { params: ConnectorAddConnectorAccountParams; result: JsonValue };
  "config/getAutoClear": { params: ConfigGetAutoClearParams; result: JsonValue };
  "config/getCacheWarmingSettings": { params: ConfigGetCacheWarmingSettingsParams; result: JsonValue };
  "config/getCompactionSettings": { params: ConfigGetCompactionSettingsParams; result: JsonValue };
  "config/getDeveloperSettings": { params: ConfigGetDeveloperSettingsParams; result: JsonValue };
  "config/getOutputStyle": { params: ConfigGetOutputStyleParams; result: JsonValue };
  "config/getOrchestrationMode": { params: ConfigGetOrchestrationModeParams; result: JsonValue };
  "config/getConfiguredOrchestrationMode": { params: ConfigGetConfiguredOrchestrationModeParams; result: JsonValue };
  "config/getProfile": { params: ConfigGetProfileParams; result: JsonValue };
  "config/getRecapSettings": { params: ConfigGetRecapSettingsParams; result: JsonValue };
  "config/getSessionTitleSettings": { params: ConfigGetSessionTitleSettingsParams; result: JsonValue };
  "config/getHeartbeatSettings": { params: ConfigGetHeartbeatSettingsParams; result: JsonValue };
  "config/getReactionSettings": { params: ConfigGetReactionSettingsParams; result: JsonValue };
  "config/getSystemShell": { params: ConfigGetSystemShellParams; result: JsonValue };
  "config/getTheme": { params: ConfigGetThemeParams; result: JsonValue };
  "config/getToolModuleSettings": { params: ConfigGetToolModuleSettingsParams; result: ToolModuleSettings };
  "config/getUpdateSettings": { params: ConfigGetUpdateSettingsParams; result: JsonValue };
  "config/getWorktreeSettings": { params: ConfigGetWorktreeSettingsParams; result: JsonValue };
  "config/listOutputStyles": { params: ConfigListOutputStylesParams; result: JsonValue };
  "config/getNetworkProxy": { params: ConfigGetNetworkProxyParams; result: JsonValue };
  "config/testNetworkProxy": { params: ConfigTestNetworkProxyParams; result: JsonValue };
  "config/getWorkflowPack": { params: ConfigGetWorkflowPackParams; result: JsonValue };
  "config/isSetupRequestActive": { params: ConfigIsSetupRequestActiveParams; result: JsonValue };
  "config/setAutoUpdate": { params: ConfigSetAutoUpdateParams; result: JsonValue };
  "config/setCacheWarmingEnabled": { params: ConfigSetCacheWarmingEnabledParams; result: JsonValue };
  "config/setRecapEnabled": { params: ConfigSetRecapEnabledParams; result: JsonValue };
  "config/setAiSessionTitles": { params: ConfigSetAiSessionTitlesParams; result: JsonValue };
  "config/setHeartbeatEnabled": { params: ConfigSetHeartbeatEnabledParams; result: JsonValue };
  "config/setReactionsEnabled": { params: ConfigSetReactionsEnabledParams; result: JsonValue };
  "config/setWebSearchEnabled": { params: ConfigSetWebSearchEnabledParams; result: JsonValue };
  "config/setMemoryToolsEnabled": { params: ConfigSetMemoryToolsEnabledParams; result: JsonValue };
  "config/setAutoClear": { params: ConfigSetAutoClearParams; result: JsonValue };
  "config/setCompactionSettings": { params: ConfigSetCompactionSettingsParams; result: JsonValue };
  "config/setDeveloperOption": { params: ConfigSetDeveloperOptionParams; result: JsonValue };
  "config/setProfile": { params: ConfigSetProfileParams; result: JsonValue };
  "config/setHeartbeatInterval": { params: ConfigSetHeartbeatIntervalParams; result: JsonValue };
  "config/setSystemShell": { params: ConfigSetSystemShellParams; result: JsonValue };
  "config/setTheme": { params: ConfigSetThemeParams; result: JsonValue };
  "config/setWebSearchRoute": { params: ConfigSetWebSearchRouteParams; result: JsonValue };
  "config/setAutoEffortBase": { params: ConfigSetAutoEffortBaseParams; result: JsonValue };
  "config/setBuiltinToolEnabled": { params: ConfigSetBuiltinToolEnabledParams; result: JsonValue };
  "config/installBuiltinFeature": { params: ConfigInstallBuiltinFeatureParams; result: JsonValue };
  "config/setWorktreeSettings": { params: ConfigSetWorktreeSettingsParams; result: JsonValue };
  "config/setNetworkProxy": { params: ConfigSetNetworkProxyParams; result: JsonValue };
  "config/saveWorkflowPack": { params: ConfigSaveWorkflowPackParams; result: JsonValue };
  "config/createWorkflow": { params: ConfigCreateWorkflowParams; result: JsonValue };
  "config/deleteWorkflow": { params: ConfigDeleteWorkflowParams; result: JsonValue };
  "config/setModelPreferences": { params: ConfigSetModelPreferencesParams; result: JsonValue };
  "config/skipOnboarding": { params: ConfigSkipOnboardingParams; result: JsonValue };
  "config/completeOnboarding": { params: ConfigCompleteOnboardingParams; result: JsonValue };
  "config/saveStarterGuideState": { params: ConfigSaveStarterGuideStateParams; result: JsonValue };
  "config/claimSetupRequest": { params: ConfigClaimSetupRequestParams; result: JsonValue };
  "config/completeSetupRequest": { params: ConfigCompleteSetupRequestParams; result: JsonValue };
  "config/setExtensionScope": { params: ConfigSetExtensionScopeParams; result: JsonValue };
  "config/read": { params: ConfigReadParams; result: ConfigReadResponse };
  "config/value/write": { params: ConfigValueWriteParams; result: ConfigWriteResponse };
  "config/batchWrite": { params: ConfigBatchWriteParams; result: ConfigWriteResponse };
  "channel/getChannelSettings": { params: ChannelGetChannelSettingsParams; result: JsonValue };
  "channel/getChannelSetup": { params: ChannelGetChannelSetupParams; result: JsonValue };
  "channel/getChannelWorkerStatus": { params: ChannelGetChannelWorkerStatusParams; result: JsonValue };
  "channel/setWebhookConfig": { params: ChannelSetWebhookConfigParams; result: JsonValue };
  "channel/saveSchedule": { params: ChannelSaveScheduleParams; result: JsonValue };
  "channel/deleteSchedule": { params: ChannelDeleteScheduleParams; result: JsonValue };
  "channel/setScheduleEnabled": { params: ChannelSetScheduleEnabledParams; result: JsonValue };
  "channel/runScheduleNow": { params: ChannelRunScheduleNowParams; result: JsonValue };
  "channel/runWebhookNow": { params: ChannelRunWebhookNowParams; result: JsonValue };
  "channel/retryRoutineDelivery": { params: ChannelRetryRoutineDeliveryParams; result: JsonValue };
  "channel/testWebhook": { params: ChannelTestWebhookParams; result: JsonValue };
  "channel/saveWebhook": { params: ChannelSaveWebhookParams; result: JsonValue };
  "channel/deleteWebhook": { params: ChannelDeleteWebhookParams; result: JsonValue };
  "channel/setWebhookEnabled": { params: ChannelSetWebhookEnabledParams; result: JsonValue };
  "import/getConversationImportJobs": { params: ImportGetConversationImportJobsParams; result: JsonValue };
  "import/listImportableConversations": { params: ImportListImportableConversationsParams; result: JsonValue };
  "import/startConversationImport": { params: ImportStartConversationImportParams; result: JsonValue };
  "import/cancelConversationImport": { params: ImportCancelConversationImportParams; result: JsonValue };
  "import/registerConversationImportFile": { params: ImportRegisterConversationImportFileParams; result: JsonValue };
  "media/getMediaDefault": { params: MediaGetMediaDefaultParams; result: JsonValue };
  "media/getMediaJob": { params: MediaGetMediaJobParams; result: JsonValue };
  "media/getMediaPins": { params: MediaGetMediaPinsParams; result: JsonValue };
  "media/listMediaAssets": { params: MediaListMediaAssetsParams; result: JsonValue };
  "media/listMediaBoards": { params: MediaListMediaBoardsParams; result: JsonValue };
  "media/listMediaLanes": { params: MediaListMediaLanesParams; result: JsonValue };
  "media/readMediaAsset": { params: MediaReadMediaAssetParams; result: JsonValue };
  "media/resolveMediaFile": { params: MediaResolveMediaFileParams; result: JsonValue };
  "media/startMediaJob": { params: MediaStartMediaJobParams; result: JsonValue };
  "media/cancelMediaJob": { params: MediaCancelMediaJobParams; result: JsonValue };
  "media/deleteMediaAsset": { params: MediaDeleteMediaAssetParams; result: JsonValue };
  "media/deleteMediaAssets": { params: MediaDeleteMediaAssetsParams; result: JsonValue };
  "media/createMediaBoard": { params: MediaCreateMediaBoardParams; result: JsonValue };
  "media/renameMediaBoard": { params: MediaRenameMediaBoardParams; result: JsonValue };
  "media/deleteMediaBoard": { params: MediaDeleteMediaBoardParams; result: JsonValue };
  "media/setMediaAssetBoard": { params: MediaSetMediaAssetBoardParams; result: JsonValue };
  "media/setMediaDefault": { params: MediaSetMediaDefaultParams; result: JsonValue };
  "media/setMediaPin": { params: MediaSetMediaPinParams; result: JsonValue };
  "media/cacheMediaThumbnail": { params: MediaCacheMediaThumbnailParams; result: JsonValue };
  "media/openMediaAsset": { params: MediaOpenMediaAssetParams; result: JsonValue };
  "media/openMediaFolder": { params: MediaOpenMediaFolderParams; result: JsonValue };
  "mcp/getMcpServerConfig": { params: McpGetMcpServerConfigParams; result: JsonValue };
  "mcp/getMcpOAuthLoginStatus": { params: McpGetMcpOAuthLoginStatusParams; result: JsonValue };
  "mcp/mcpStatus": { params: McpMcpStatusParams; result: JsonValue };
  "mcp/addMcpServer": { params: McpAddMcpServerParams; result: JsonValue };
  "mcp/saveMcpServer": { params: McpSaveMcpServerParams; result: JsonValue };
  "mcp/removeMcpServer": { params: McpRemoveMcpServerParams; result: JsonValue };
  "mcp/setMcpServerEnabled": { params: McpSetMcpServerEnabledParams; result: JsonValue };
  "mcp/reconnectMcp": { params: McpReconnectMcpParams; result: JsonValue };
  "mcp/beginMcpOAuthLogin": { params: McpBeginMcpOAuthLoginParams; result: JsonValue };
  "mcp/cancelMcpOAuthLogin": { params: McpCancelMcpOAuthLoginParams; result: JsonValue };
  "mcp/completeMcpOAuthLogin": { params: McpCompleteMcpOAuthLoginParams; result: JsonValue };
  "mcp/signOutMcpServer": { params: McpSignOutMcpServerParams; result: JsonValue };
  "mcp/probeMcpServerAuth": { params: McpProbeMcpServerAuthParams; result: JsonValue };
  "mcp/enablePluginMcp": { params: McpEnablePluginMcpParams; result: JsonValue };
  "account/getOAuthProviderLoginStatus": { params: AccountGetOAuthProviderLoginStatusParams; result: JsonValue };
  "account/listWebSearchModels": { params: AccountListWebSearchModelsParams; result: JsonValue };
  "account/getQuotaHistory": { params: AccountGetQuotaHistoryParams; result: JsonValue };
  "account/authenticateProvider": { params: AccountAuthenticateProviderParams; result: JsonValue };
  "account/beginOAuthProviderLogin": { params: AccountBeginOAuthProviderLoginParams; result: JsonValue };
  "account/completeOAuthProviderLogin": { params: AccountCompleteOAuthProviderLoginParams; result: JsonValue };
  "account/cancelOAuthProviderLogin": { params: AccountCancelOAuthProviderLoginParams; result: JsonValue };
  "account/loginOAuthProvider": { params: AccountLoginOAuthProviderParams; result: JsonValue };
  "account/forgetProviderAuth": { params: AccountForgetProviderAuthParams; result: JsonValue };
  "account/updateProviderAccounts": { params: AccountUpdateProviderAccountsParams; result: JsonValue };
  "account/saveProviderApiKey": { params: AccountSaveProviderApiKeyParams; result: JsonValue };
  "account/saveCustomProvider": { params: AccountSaveCustomProviderParams; result: JsonValue };
  "account/saveCustomProviderKey": { params: AccountSaveCustomProviderKeyParams; result: JsonValue };
  "account/removeCustomProvider": { params: AccountRemoveCustomProviderParams; result: JsonValue };
  "account/updateCustomProviderModel": { params: AccountUpdateCustomProviderModelParams; result: JsonValue };
  "account/testCustomProvider": { params: AccountTestCustomProviderParams; result: JsonValue };
  "account/checkCustomProviderKeyEnv": { params: AccountCheckCustomProviderKeyEnvParams; result: JsonValue };
  "account/discoverCustomProviderModels": { params: AccountDiscoverCustomProviderModelsParams; result: JsonValue };
  "account/saveOpenAIUsageSessionKey": { params: AccountSaveOpenAIUsageSessionKeyParams; result: JsonValue };
  "account/consumeCodexRateLimitResetCredit": { params: AccountConsumeCodexRateLimitResetCreditParams; result: JsonValue };
  "account/refreshProviderSetup": { params: AccountRefreshProviderSetupParams; result: EmptyResult };
  "localProvider/searchLocalProviderModels": { params: LocalProviderSearchLocalProviderModelsParams; result: JsonValue };
  "localProvider/inspectHuggingFaceModel": { params: LocalProviderInspectHuggingFaceModelParams; result: JsonValue };
  "localProvider/getLocalProviderModelDetails": { params: LocalProviderGetLocalProviderModelDetailsParams; result: JsonValue };
  "localProvider/installLocalProviderModel": { params: LocalProviderInstallLocalProviderModelParams; result: JsonValue };
  "localProvider/startLocalProviderInstallation": { params: LocalProviderStartLocalProviderInstallationParams; result: JsonValue };
  "localProvider/cancelLocalProviderInstallation": { params: LocalProviderCancelLocalProviderInstallationParams; result: JsonValue };
  "localProvider/discardLocalProviderInstallation": { params: LocalProviderDiscardLocalProviderInstallationParams; result: JsonValue };
  "localProvider/setLocalProviderIdleTtl": { params: LocalProviderSetLocalProviderIdleTtlParams; result: JsonValue };
  "localProvider/setLocalProviderContext": { params: LocalProviderSetLocalProviderContextParams; result: JsonValue };
  "localProvider/registerHuggingFaceModel": { params: LocalProviderRegisterHuggingFaceModelParams; result: JsonValue };
  "localProvider/startLocalProviderModelMaintenance": { params: LocalProviderStartLocalProviderModelMaintenanceParams; result: JsonValue };
  "localProvider/deleteLocalProviderModel": { params: LocalProviderDeleteLocalProviderModelParams; result: JsonValue };
  "usage/getUsageDashboard": { params: UsageGetUsageDashboardParams; result: JsonValue };
  "usage/getUsageStats": { params: UsageGetUsageStatsParams; result: JsonValue };
  "usage/getUsageRequests": { params: UsageGetUsageRequestsParams; result: JsonValue };
  "update/getUpdateStatus": { params: UpdateGetUpdateStatusParams; result: JsonValue };
  "update/checkForUpdate": { params: UpdateCheckForUpdateParams; result: JsonValue };
  "update/runUpdateNow": { params: UpdateRunUpdateNowParams; result: JsonValue };
  "update/desktop/command": { params: UpdateDesktopCommandParams; result: JsonValue };
  "voice/getVoiceStatus": { params: VoiceGetVoiceStatusParams; result: JsonValue };
  "voice/toggleVoice": { params: VoiceToggleVoiceParams; result: JsonValue };
  "voice/transcribeAudio": { params: VoiceTranscribeAudioParams; result: JsonValue };
  "voice/prepareTranscription": { params: VoicePrepareTranscriptionParams; result: JsonValue };
  "tidy/getTidyEngineStatus": { params: TidyGetTidyEngineStatusParams; result: JsonValue };
  "tidy/getTidyInstallStatus": { params: TidyGetTidyInstallStatusParams; result: JsonValue };
  "skills/skillsStatus": { params: SkillsSkillsStatusParams; result: JsonValue };
  "skills/skillContent": { params: SkillsSkillContentParams; result: JsonValue };
  "skills/getDisabledSkills": { params: SkillsGetDisabledSkillsParams; result: JsonValue };
  "skills/addSkill": { params: SkillsAddSkillParams; result: JsonValue };
  "skills/saveSkill": { params: SkillsSaveSkillParams; result: JsonValue };
  "skills/removeSkill": { params: SkillsRemoveSkillParams; result: JsonValue };
  "skills/reloadSkills": { params: SkillsReloadSkillsParams; result: JsonValue };
  "skills/setDisabledSkills": { params: SkillsSetDisabledSkillsParams; result: JsonValue };
  "plugins/pluginsStatus": { params: PluginsPluginsStatusParams; result: JsonValue };
  "plugins/addPlugin": { params: PluginsAddPluginParams; result: JsonValue };
  "plugins/updatePlugin": { params: PluginsUpdatePluginParams; result: JsonValue };
  "plugins/setPluginEnabled": { params: PluginsSetPluginEnabledParams; result: JsonValue };
  "plugins/removePlugin": { params: PluginsRemovePluginParams; result: JsonValue };
  "plugins/reloadPlugins": { params: PluginsReloadPluginsParams; result: JsonValue };
  "tools/toolsStatus": { params: ToolsToolsStatusParams; result: JsonValue };
  "memory/memoryControl": { params: MemoryMemoryControlParams; result: JsonValue };
  "memory/recall": { params: MemoryRecallParams; result: JsonValue };
  "diagnostics/runDoctor": { params: DiagnosticsRunDoctorParams; result: JsonValue };
  "project/list": { params: ProjectListParams; result: JsonValue };
  "project/read": { params: ProjectReadParams; result: JsonValue };
  "project/create": { params: ProjectCreateParams; result: JsonValue };
  "project/touch": { params: ProjectTouchParams; result: JsonValue };
  "project/update": { params: ProjectUpdateParams; result: JsonValue };
  "project/delete": { params: ProjectDeleteParams; result: JsonValue };
  "project/ensureDirectory": { params: ProjectEnsureDirectoryParams; result: JsonValue };
  "project/directory": { params: ProjectDirectoryParams; result: JsonValue };
  "project/recoveryDirectory": { params: ProjectRecoveryDirectoryParams; result: JsonValue };
  "project/taskWorkspace": { params: ProjectTaskWorkspaceParams; result: JsonValue };
  "project/codeGraph": { params: ProjectCodeGraphParams; result: JsonValue };
  "projectFs/listDir": { params: ProjectFsListDirParams; result: JsonValue };
  "projectFs/readText": { params: ProjectFsReadTextParams; result: JsonValue };
  "projectFs/writeText": { params: ProjectFsWriteTextParams; result: JsonValue };
  "projectFs/writeTextBatch": { params: ProjectFsWriteTextBatchParams; result: JsonValue };
  "projectFs/stat": { params: ProjectFsStatParams; result: JsonValue };
  "projectFs/create": { params: ProjectFsCreateParams; result: JsonValue };
  "projectFs/rename": { params: ProjectFsRenameParams; result: JsonValue };
  "projectFs/move": { params: ProjectFsMoveParams; result: JsonValue };
  "projectFs/copy": { params: ProjectFsCopyParams; result: JsonValue };
  "projectFs/trash": { params: ProjectFsTrashParams; result: JsonValue };
  "projectFs/entryPath": { params: ProjectFsEntryPathParams; result: JsonValue };
  "projectFs/readLocal": { params: ProjectFsReadLocalParams; result: JsonValue };
  "projectFs/statLocal": { params: ProjectFsStatLocalParams; result: JsonValue };
  "projectFs/browseDirs": { params: ProjectFsBrowseDirsParams; result: JsonValue };
  "projectFs/searchText": { params: ProjectFsSearchTextParams; result: JsonValue };
  "projectFs/replaceText": { params: ProjectFsReplaceTextParams; result: JsonValue };
  "projectFs/recovery": { params: ProjectFsRecoveryParams; result: JsonValue };
  "projectFs/backup/read": { params: ProjectFsBackupReadParams; result: JsonValue };
  "projectFs/backup/write": { params: ProjectFsBackupWriteParams; result: JsonValue };
  "projectFs/backup/delete": { params: ProjectFsBackupDeleteParams; result: JsonValue };
  "projectFs/workspaceFile/read": { params: ProjectFsWorkspaceFileReadParams; result: JsonValue };
  "projectFs/workspaceFile/write": { params: ProjectFsWorkspaceFileWriteParams; result: JsonValue };
  "projectFs/readEditorSettings": { params: ProjectFsReadEditorSettingsParams; result: JsonValue };
  "projectFs/captureSnapshot": { params: ProjectFsCaptureSnapshotParams; result: JsonValue };
  "projectFs/localPageUrl": { params: ProjectFsLocalPageUrlParams; result: JsonValue };
  "fs/watch": { params: FsWatchParams; result: Subscription };
  "fs/unwatch": { params: FsUnwatchParams; result: EmptyResult };
  "search/start": { params: SearchStartParams; result: Subscription };
  "search/update": { params: SearchUpdateParams; result: EmptyResult };
  "search/stop": { params: SearchStopParams; result: EmptyResult };
  "transfer/beginRead": { params: TransferBeginReadParams; result: TransferBeginReadResponse };
  "transfer/beginZip": { params: TransferBeginZipParams; result: TransferBeginReadResponse };
  "transfer/readRange": { params: TransferReadRangeParams; result: BlobReadResponse };
  "transfer/endRead": { params: TransferEndReadParams; result: EmptyResult };
  "transfer/beginWrite": { params: TransferBeginWriteParams; result: JsonValue };
  "transfer/writeChunk": { params: TransferWriteChunkParams; result: EmptyResult };
  "transfer/commit": { params: TransferCommitParams; result: JsonValue };
  "transfer/abort": { params: TransferAbortParams; result: JsonValue };
  "transfer/trash/info": { params: TransferTrashInfoParams; result: JsonValue };
  "transfer/trash/entry": { params: TransferTrashEntryParams; result: JsonValue };
  "transfer/grant/mint": { params: TransferGrantMintParams; result: JsonValue };
  "lsp/subscribe": { params: LspSubscribeParams; result: Subscription };
  "lsp/unsubscribe": { params: LspSubscribeParams; result: EmptyResult };
  "lsp/document": { params: LspDocumentParams; result: JsonValue };
  "lsp/request": { params: LspRequestParams; result: JsonValue };
  "document/preview": { params: DocumentPreviewParams; result: JsonValue };
  "document/previewPages": { params: DocumentPreviewPagesParams; result: JsonValue };
  "document/libreOfficeStatus": { params: DocumentLibreOfficeStatusParams; result: JsonValue };
  "document/installLibreOffice": { params: DocumentInstallLibreOfficeParams; result: JsonValue };
  "git/status": { params: GitStatusParams; result: JsonValue };
  "git/branches": { params: GitBranchesParams; result: JsonValue };
  "git/log": { params: GitLogParams; result: JsonValue };
  "git/show": { params: GitShowParams; result: JsonValue };
  "git/showDiff": { params: GitShowDiffParams; result: JsonValue };
  "git/showFile": { params: GitShowFileParams; result: JsonValue };
  "git/diff": { params: GitDiffParams; result: JsonValue };
  "git/stashList": { params: GitStashListParams; result: JsonValue };
  "git/requestContext": { params: GitRequestContextParams; result: JsonValue };
  "git/cliStatus": { params: GitCliStatusParams; result: JsonValue };
  "git/globalConfig/read": { params: GitGlobalConfigReadParams; result: JsonValue };
  "git/watch": { params: GitWatchParams; result: Subscription };
  "git/unwatch": { params: GitUnwatchParams; result: EmptyResult };
  "git/stage": { params: GitStageParams; result: JsonValue };
  "git/unstage": { params: GitUnstageParams; result: JsonValue };
  "git/commit": { params: GitCommitParams; result: JsonValue };
  "git/commitPaths": { params: GitCommitPathsParams; result: JsonValue };
  "git/amend": { params: GitAmendParams; result: JsonValue };
  "git/undoLastCommit": { params: GitUndoLastCommitParams; result: JsonValue };
  "git/push": { params: GitPushParams; result: JsonValue };
  "git/pull": { params: GitPullParams; result: JsonValue };
  "git/fetch": { params: GitFetchParams; result: JsonValue };
  "git/sync": { params: GitSyncParams; result: JsonValue };
  "git/stash": { params: GitStashParams; result: JsonValue };
  "git/stashPop": { params: GitStashPopParams; result: JsonValue };
  "git/stashApply": { params: GitStashApplyParams; result: JsonValue };
  "git/stashDrop": { params: GitStashDropParams; result: JsonValue };
  "git/createTag": { params: GitCreateTagParams; result: JsonValue };
  "git/deleteTag": { params: GitDeleteTagParams; result: JsonValue };
  "git/deleteBranch": { params: GitDeleteBranchParams; result: JsonValue };
  "git/renameBranch": { params: GitRenameBranchParams; result: JsonValue };
  "git/resetToCommit": { params: GitResetToCommitParams; result: JsonValue };
  "git/revertCommit": { params: GitRevertCommitParams; result: JsonValue };
  "git/revertFile": { params: GitRevertFileParams; result: JsonValue };
  "git/cherryPickCommit": { params: GitCherryPickCommitParams; result: JsonValue };
  "git/applyPatch": { params: GitApplyPatchParams; result: JsonValue };
  "git/ignore": { params: GitIgnoreParams; result: JsonValue };
  "git/continue": { params: GitContinueParams; result: JsonValue };
  "git/abortOperation": { params: GitAbortOperationParams; result: JsonValue };
  "git/globalConfig/write": { params: GitGlobalConfigWriteParams; result: JsonValue };
  "git/cli/install": { params: GitCliInstallParams; result: JsonValue };
  "github/status": { params: GithubStatusParams; result: JsonValue };
  "github/account": { params: GithubAccountParams; result: JsonValue };
  "github/login/start": { params: GithubLoginStartParams; result: JsonValue };
  "github/login/status": { params: GithubLoginStatusParams; result: JsonValue };
  "github/login/openBrowser": { params: GithubLoginOpenBrowserParams; result: JsonValue };
  "github/login/cancel": { params: GithubLoginCancelParams; result: JsonValue };
  "github/logout": { params: GithubLogoutParams; result: JsonValue };
  "github/install": { params: GithubInstallParams; result: JsonValue };
  "github/request": { params: GithubRequestParams; result: JsonValue };
  "github/starStatus": { params: GithubStarStatusParams; result: JsonValue };
  "github/star": { params: GithubStarParams; result: JsonValue };
  "github/pr/list": { params: GithubPrListParams; result: JsonValue };
  "github/pr/view": { params: GithubPrViewParams; result: JsonValue };
  "github/pr/diff": { params: GithubPrDiffParams; result: JsonValue };
  "github/pr/defaultBranch": { params: GithubPrDefaultBranchParams; result: JsonValue };
  "github/pr/create": { params: GithubPrCreateParams; result: JsonValue };
  "github/pr/checkout": { params: GithubPrCheckoutParams; result: JsonValue };
  "github/pr/merge": { params: GithubPrMergeParams; result: JsonValue };
  "review/diff/get": { params: ReviewDiffGetParams; result: JsonValue };
  "process/spawn": { params: ProcessSpawnParams; result: Subscription };
  "process/kill": { params: ProcessKillParams; result: EmptyResult };
  "process/resizePty": { params: ProcessResizePtyParams; result: EmptyResult };
  "process/writeStdin": { params: ProcessWriteStdinParams; result: EmptyResult };
  "terminal/ensure": { params: TerminalEnsureParams; result: JsonValue };
  "terminal/attach": { params: TerminalAttachParams; result: JsonValue };
  "terminal/profiles": { params: TerminalProfilesParams; result: JsonValue };
  "terminal/focus": { params: TerminalFocusParams; result: EmptyResult };
  "terminal/pause": { params: TerminalPauseParams; result: EmptyResult };
  "terminal/resume": { params: TerminalResumeParams; result: EmptyResult };
  "terminal/dispose": { params: TerminalDisposeParams; result: EmptyResult };
  "system/ports/subscribe": { params: SystemPortsSubscribeParams; result: Subscription };
  "system/ports/unsubscribe": { params: SystemPortsUnsubscribeParams; result: EmptyResult };
  "remoteAccess/setEnabled": { params: RemoteAccessSetEnabledParams; result: JsonValue };
  "remoteAccess/setName": { params: RemoteAccessSetNameParams; result: JsonValue };
  "remoteAccess/setClientAlias": { params: RemoteAccessSetClientAliasParams; result: JsonValue };
  "remoteAccess/rotate": { params: RemoteAccessRotateParams; result: JsonValue };
  "remoteAccess/resolveClaim": { params: RemoteAccessResolveClaimParams; result: JsonValue };
  "remoteAccess/pairCode": { params: RemoteAccessPairCodeParams; result: JsonValue };
  "remoteAccess/revokeClient": { params: RemoteAccessRevokeClientParams; result: JsonValue };
  "remoteAccess/settleOwedControllerKeys": { params: RemoteAccessSettleOwedControllerKeysParams; result: JsonValue };
  "remoteAccess/deliverScreenControllerKey": { params: RemoteAccessDeliverScreenControllerKeyParams; result: JsonValue };
  "remoteAccess/pushPublicKey": { params: RemoteAccessPushPublicKeyParams; result: JsonValue };
  "remoteAccess/registerPushSubscription": { params: RemoteAccessRegisterPushSubscriptionParams; result: JsonValue };
  "remoteAccess/removePushSubscription": { params: RemoteAccessRemovePushSubscriptionParams; result: JsonValue };
  "remoteAccess/registerNativePush": { params: RemoteAccessRegisterNativePushParams; result: JsonValue };
  "remoteAccess/removeNativePush": { params: RemoteAccessRemoveNativePushParams; result: JsonValue };
  "remoteAccess/activate": { params: RemoteAccessActivateParams; result: JsonValue };
  "remoteAccess/state": { params: RemoteAccessStateParams; result: JsonValue };
  "browser/command": { params: BrowserCommandParams; result: JsonValue };
  "visualize/command": { params: VisualizeCommandParams; result: JsonValue };
  "notify/test": { params: NotifyTestParams; result: JsonValue };
  "host/claim": { params: HostClaimParams; result: EmptyResult };
  "host/state/set": { params: HostStateSetParams; result: EmptyResult };
  "host/remoteTarget/set": { params: HostRemoteTargetSetParams; result: EmptyResult };
  "modelProxy/run": { params: ModelProxyRunParams; result: ModelProxyResult };
};

export type ClientMethod = keyof ClientMethods;

/** Params and result of every server request (core → client). */
export type ServerRequestMethods = {
  "item/tool/requestApproval": { params: ToolApprovalRequestParams; result: ToolApprovalDecision };
  "item/tool/requestUserInput": { params: UserInputRequestParams; result: ToolApprovalDecision };
  "item/permissions/requestApproval": { params: PermissionsRequestParams; result: ToolApprovalDecision };
  "item/browser/requestApproval": { params: BrowserApprovalRequestParams; result: ToolApprovalDecision };
  "item/computer/requestApproval": { params: ComputerApprovalRequestParams; result: ToolApprovalDecision };
  "host/browser/command": { params: HostCommandParams; result: JsonValue };
  "host/visualize/command": { params: HostVisualizeCommandParams; result: JsonValue | null };
  "host/systemProxy/resolve": { params: HostSystemProxyResolveParams; result: HostSystemProxyResolveResponse };
  "host/notification/status": { params: HostNotificationStatusParams; result: HostNotificationStatus };
  "host/update/command": { params: HostUpdateCommandParams; result: JsonValue };
  "host/capture/fileSnapshot": { params: HostFileSnapshotParams; result: HostFileSnapshot };
  "host/localPage/url": { params: HostLocalPageUrlParams; result: string };
  "model/proxy/execute": { params: ModelProxyExecuteParams; result: ModelProxyResult };
};

/** Params of every server notification. */
export type ServerNotificationMethods = {
  "thread/snapshot": ThreadSnapshotParams;
  "thread/closed": ThreadIdParams;
  "thread/status/changed": ThreadStatusChangedParams;
  "thread/name/updated": ThreadNameUpdatedParams;
  "thread/tokenUsage/updated": TokenUsageUpdatedParams;
  "thread/goal/updated": ThreadValueParams;
  "thread/goal/cleared": ThreadIdParams;
  "thread/queue/changed": ThreadQueueChangedParams;
  "turn/started": TurnNotificationParams;
  "turn/completed": TurnNotificationParams;
  "thread/notification": ThreadNotificationParams;
  "thread/modelRequest/updated": ModelRequestUpdatedParams;
  "thread/toolBatch/updated": ToolBatchUpdatedParams;
  "item/started": ItemNotificationParams;
  "item/completed": ItemNotificationParams;
  "item/agentMessage/delta": ItemDeltaParams;
  "item/reasoning/textDelta": ItemDeltaParams;
  "item/reasoning/summaryTextDelta": ItemDeltaParams;
  "thread/historyReset": ThreadHistoryResetParams;
  "thread/runtime/updated": ThreadSectionParams<ThreadRuntime>;
  "thread/route/updated": ThreadSectionParams<ThreadRoute>;
  "thread/context/updated": ThreadSectionParams<ThreadContext>;
  "thread/todo/updated": ThreadSectionParams<JsonValue | null>;
  "thread/quotaResume/updated": ThreadSectionParams<QuotaResume | null>;
  "thread/agents/updated": ThreadSectionParams<ThreadAgents>;
  "thread/shellJobs/updated": ThreadSectionParams<JsonValue>;
  "thread/workflow/updated": ThreadSectionParams<ThreadWorkflow>;
  "thread/workspace/updated": ThreadSectionParams<JsonValue | null>;
  "thread/approvals/updated": ThreadSectionParams<ThreadApprovals>;
  "thread/promptRestore": ThreadSectionParams<PromptRestore | null>;
  "thread/providerAccount/changed": ThreadSectionParams<ProviderAccountChange | null>;
  "thread/promptHistory/updated": ThreadSectionParams<PromptHistoryChange>;
  "thread/remote/updated": ThreadSectionParams<boolean>;
  "thread/setupUiRequest/updated": ThreadSectionParams<SetupUiRequest | null>;
  "thread/roomView/updated": ThreadSectionParams<ThreadRoomView | null>;
  "review/diff/updated": SectionUpdate;
  "error": ErrorNotificationParams;
  "serverRequest/resolved": ServerRequestResolvedParams;
  "host/notification/show": HostNotificationShowParams;
  "host/browser/viewFrames": HostBrowserViewFramesParams;
  "modelProxy/run/event": ModelProxyRunEventParams;
  "model/proxy/cancel": ModelProxyCancelParams;
  "app/snapshot": AppSnapshotParams;
  "thread/started": ThreadStartedParams;
  "thread/summary/updated": ThreadSummaryUpdatedParams;
  "thread/deleted": ThreadIdParams;
  "thread/archived": ThreadIdParams;
  "thread/unarchived": ThreadIdParams;
  "warning": WarningParams;
  "configWarning": WarningParams;
  "ui/openRequested": UiOpenRequestedParams;
  "remote/pointer": RemotePointerParams;
  "core/drain": CoreDrainParams;
  "config/updated": SectionUpdate;
  "project/updated": SectionUpdate;
  "agent/pool/updated": SectionUpdate;
  "agent/list/updated": SectionUpdate;
  "agent/botOrder/updated": SectionUpdate;
  "model/presets/updated": SectionUpdate;
  "model/catalog/updated": SectionUpdate;
  "workflow/list/updated": SectionUpdate;
  "webSearch/updated": SectionUpdate;
  "toolModules/updated": SectionUpdate;
  "account/updated": SectionUpdate;
  "usage/updated": SectionUpdate;
  "shellJobs/host/updated": SectionUpdate;
  "terminal/activity/updated": SectionUpdate;
  "terminal/tabs/updated": SectionUpdate;
  "remote/state/updated": SectionUpdate;
  "notice/updated": SectionUpdate;
  "update/status/updated": SectionUpdate;
  "host/state/updated": SectionUpdate;
  "computer/updated": SectionUpdate;
  "approval/inbox/updated": SectionUpdate;
  "core/state/updated": SectionUpdate;
  "core/health/updated": SectionUpdate;
  "migration/progress": SectionUpdate;
  "feed/snapshot": FeedSnapshotParams;
  "fs/changed": FsChangedParams;
  "search/updated": SearchUpdatedParams;
  "search/completed": SearchCompletedParams;
  "process/outputDelta": ProcessOutputDeltaParams;
  "process/exited": ProcessExitedParams;
  "login/updated": LoginUpdatedParams;
  "git/status/updated": SectionUpdate;
  "lsp/status/updated": SectionUpdate;
  "lsp/diagnostics/updated": SectionUpdate;
  "media/job/updated": SectionUpdate;
  "system/ports/updated": SectionUpdate;
};

/** The method tables (same content as `schema/method_table.json`): per client
 * method its scope, class, mutation, opScope and origins, with wire field paths. */
export const methodTable = {
  "clientMethods": [
    {
      "class": "C0",
      "method": "initialize",
      "mutation": {
        "kind": "none"
      },
      "opScope": {
        "kind": "none"
      },
      "origins": [
        "local",
        "ssh",
        "relay"
      ],
      "params": "v1::InitializeParams",
      "result": "v1::InitializeResponse",
      "scope": {
        "kind": "none"
      }
    },
    {
      "class": "C0",
      "method": "app/subscribe",
      "mutation": {
        "kind": "none"
      },
      "opScope": {
        "kind": "none"
      },
      "origins": [
        "local",
        "ssh",
        "relay"
      ],
      "params": "v2::feed::AppSubscribeParams",
      "result": "v2::feed::AppSubscribeResponse",
      "scope": {
        "kind": "none"
      }
    },
    {
      "class": "C0",
      "method": "feed/subscribe",
      "mutation": {
        "kind": "none"
      },
      "opScope": {
        "kind": "none"
      },
      "origins": [
        "local",
        "ssh",
        "relay"
      ],
      "params": "v2::feed::FeedSubscribeParams",
      "result": "v2::feed::FeedSubscribeResponse",
      "scope": {
        "kind": "none"
      }
    },
    {
      "class": "C0",
      "method": "feed/unsubscribe",
      "mutation": {
        "kind": "none"
      },
      "opScope": {
        "kind": "none"
      },
      "origins": [
        "local",
        "ssh",
        "relay"
      ],
      "params": "v2::feed::FeedUnsubscribeParams",
      "result": "v2::feed::EmptyResult",
      "scope": {
        "kind": "none"
      }
    },
    {
      "class": "C0",
      "method": "op/status",
      "mutation": {
        "kind": "none"
      },
      "opScope": {
        "kind": "none"
      },
      "origins": [
        "local",
        "ssh",
        "relay"
      ],
      "params": "v2::op::OpStatusParams",
      "result": "v2::op::OpStatusResponse",
      "scope": {
        "kind": "none"
      }
    },
    {
      "class": "C1",
      "method": "blob/read",
      "mutation": {
        "kind": "none"
      },
      "opScope": {
        "kind": "none"
      },
      "origins": [
        "local",
        "ssh",
        "relay"
      ],
      "params": "v2::op::BlobReadParams",
      "result": "v2::op::BlobReadResponse",
      "scope": {
        "kind": "none"
      }
    },
    {
      "class": "C2",
      "method": "blob/put",
      "mutation": {
        "kind": "none"
      },
      "opScope": {
        "kind": "none"
      },
      "origins": [
        "local",
        "ssh",
        "relay"
      ],
      "params": "v2::op::BlobPutParams",
      "result": "v2::feed::EmptyResult",
      "scope": {
        "kind": "none"
      }
    },
    {
      "class": "C1",
      "method": "model/list",
      "mutation": {
        "kind": "none"
      },
      "opScope": {
        "kind": "none"
      },
      "origins": [
        "local",
        "ssh",
        "relay"
      ],
      "params": "ModelListParams",
      "result": "JsonValue",
      "scope": {
        "kind": "none"
      }
    },
    {
      "class": "C2",
      "method": "feedback/upload",
      "mutation": {
        "domain": "feedback",
        "kind": "op"
      },
      "opScope": {
        "domain": "feedback",
        "kind": "domain"
      },
      "origins": [
        "local",
        "ssh",
        "relay"
      ],
      "params": "FeedbackUploadParams",
      "result": "JsonValue",
      "scope": {
        "kind": "none"
      }
    },
    {
      "class": "C2",
      "method": "approval/provideSecret",
      "mutation": {
        "domain": "approval",
        "kind": "op"
      },
      "opScope": {
        "domain": "approval",
        "kind": "domain"
      },
      "origins": [
        "local",
        "ssh",
        "relay"
      ],
      "params": "v2::approval::ApprovalProvideSecretParams",
      "result": "v2::feed::EmptyResult",
      "scope": {
        "kind": "none"
      }
    },
    {
      "class": "C2",
      "method": "channel/call",
      "mutation": {
        "domain": "channel",
        "kind": "op"
      },
      "opScope": {
        "domain": "channel",
        "field": "args.sessionId",
        "kind": "threadOrDomain"
      },
      "origins": [
        "local",
        "ssh"
      ],
      "params": "v2::domain::ChannelCallParams",
      "result": "JsonValue",
      "scope": {
        "kind": "channelCall"
      }
    },
    {
      "class": "C2",
      "method": "route/set",
      "mutation": {
        "domain": "config",
        "kind": "op"
      },
      "opScope": {
        "domain": "config",
        "field": "threadId",
        "kind": "threadOrDomain"
      },
      "origins": [
        "local",
        "ssh",
        "relay"
      ],
      "params": "RouteSetParams",
      "result": "JsonValue",
      "scope": {
        "field": "threadId",
        "key": "config",
        "kind": "threadOrGlobal"
      }
    },
    {
      "class": "C2",
      "method": "fast/set",
      "mutation": {
        "domain": "config",
        "kind": "op"
      },
      "opScope": {
        "domain": "config",
        "field": "threadId",
        "kind": "threadOrDomain"
      },
      "origins": [
        "local",
        "ssh",
        "relay"
      ],
      "params": "FastSetParams",
      "result": "JsonValue",
      "scope": {
        "field": "threadId",
        "key": "config",
        "kind": "threadOrGlobal"
      }
    },
    {
      "class": "C2",
      "method": "thread/start",
      "mutation": {
        "domain": "core",
        "kind": "op"
      },
      "opScope": {
        "domain": "core",
        "kind": "domain"
      },
      "origins": [
        "local",
        "ssh",
        "relay"
      ],
      "params": "v2::thread::ThreadStartParams",
      "result": "v2::thread::ThreadStartResponse",
      "scope": {
        "kind": "none"
      }
    },
    {
      "class": "C0",
      "method": "thread/resume",
      "mutation": {
        "kind": "none"
      },
      "opScope": {
        "kind": "none"
      },
      "origins": [
        "local",
        "ssh",
        "relay"
      ],
      "params": "v2::thread::ThreadResumeParams",
      "result": "v2::thread::ThreadResumeResponse",
      "scope": {
        "kind": "none"
      }
    },
    {
      "class": "C0",
      "method": "thread/unsubscribe",
      "mutation": {
        "kind": "none"
      },
      "opScope": {
        "kind": "none"
      },
      "origins": [
        "local",
        "ssh",
        "relay"
      ],
      "params": "v2::thread::ThreadIdParams",
      "result": "v2::feed::EmptyResult",
      "scope": {
        "kind": "none"
      }
    },
    {
      "class": "C1",
      "method": "thread/list",
      "mutation": {
        "kind": "none"
      },
      "opScope": {
        "kind": "none"
      },
      "origins": [
        "local",
        "ssh",
        "relay"
      ],
      "params": "v2::thread::ThreadListParams",
      "result": "v2::thread::ThreadListResponse",
      "scope": {
        "kind": "none"
      }
    },
    {
      "class": "C1",
      "method": "thread/read",
      "mutation": {
        "kind": "none"
      },
      "opScope": {
        "kind": "none"
      },
      "origins": [
        "local",
        "ssh",
        "relay"
      ],
      "params": "v2::thread::ThreadReadParams",
      "result": "v2::thread::ThreadReadResponse",
      "scope": {
        "kind": "none"
      }
    },
    {
      "class": "C1",
      "method": "thread/turns/list",
      "mutation": {
        "kind": "none"
      },
      "opScope": {
        "kind": "none"
      },
      "origins": [
        "local",
        "ssh"
      ],
      "params": "v2::thread::ThreadTurnsListParams",
      "result": "v2::thread::ThreadTurnsListResponse",
      "scope": {
        "kind": "none"
      }
    },
    {
      "class": "C1",
      "method": "thread/items/list",
      "mutation": {
        "kind": "none"
      },
      "opScope": {
        "kind": "none"
      },
      "origins": [
        "local",
        "ssh",
        "relay"
      ],
      "params": "v2::thread::ThreadItemsListParams",
      "result": "v2::thread::ThreadItemsListResponse",
      "scope": {
        "kind": "none"
      }
    },
    {
      "class": "C1",
      "method": "thread/items/read",
      "mutation": {
        "kind": "none"
      },
      "opScope": {
        "kind": "none"
      },
      "origins": [
        "local",
        "ssh",
        "relay"
      ],
      "params": "v2::thread::ThreadItemsReadParams",
      "result": "v2::thread::ThreadItemsReadResponse",
      "scope": {
        "kind": "none"
      }
    },
    {
      "class": "C1",
      "method": "thread/attachment/list",
      "mutation": {
        "kind": "none"
      },
      "opScope": {
        "kind": "none"
      },
      "origins": [
        "local",
        "ssh"
      ],
      "params": "v2::thread::ThreadPageParams",
      "result": "JsonValue",
      "scope": {
        "kind": "none"
      }
    },
    {
      "class": "C1",
      "method": "thread/modelMessages/list",
      "mutation": {
        "kind": "none"
      },
      "opScope": {
        "kind": "none"
      },
      "origins": [
        "local",
        "ssh"
      ],
      "params": "v2::thread::ThreadModelMessagesListParams",
      "result": "JsonValue",
      "scope": {
        "kind": "none"
      }
    },
    {
      "class": "C1",
      "method": "thread/finalAnswer/read",
      "mutation": {
        "kind": "none"
      },
      "opScope": {
        "kind": "none"
      },
      "origins": [
        "local",
        "ssh"
      ],
      "params": "v2::thread::ThreadFinalAnswerReadParams",
      "result": "JsonValue",
      "scope": {
        "kind": "none"
      }
    },
    {
      "class": "C2",
      "method": "thread/readState/update",
      "mutation": {
        "domain": "thread",
        "kind": "op"
      },
      "opScope": {
        "field": "threadId",
        "kind": "thread"
      },
      "origins": [
        "local",
        "ssh",
        "relay"
      ],
      "params": "v2::thread::ThreadReadStateUpdateParams",
      "result": "JsonValue",
      "scope": {
        "field": "threadId",
        "kind": "thread"
      }
    },
    {
      "class": "C3",
      "method": "thread/search",
      "mutation": {
        "kind": "none"
      },
      "opScope": {
        "kind": "none"
      },
      "origins": [
        "local",
        "ssh",
        "relay"
      ],
      "params": "v2::thread::ThreadSearchParams",
      "result": "JsonValue",
      "scope": {
        "kind": "none"
      }
    },
    {
      "class": "C2",
      "method": "thread/name/set",
      "mutation": {
        "domain": "thread",
        "kind": "op"
      },
      "opScope": {
        "field": "threadId",
        "kind": "thread"
      },
      "origins": [
        "local",
        "ssh",
        "relay"
      ],
      "params": "v2::thread::ThreadNameSetParams",
      "result": "JsonValue",
      "scope": {
        "field": "threadId",
        "kind": "thread"
      }
    },
    {
      "class": "C2",
      "method": "thread/metadata/update",
      "mutation": {
        "domain": "thread",
        "kind": "op"
      },
      "opScope": {
        "field": "threadId",
        "kind": "thread"
      },
      "origins": [
        "local",
        "ssh",
        "relay"
      ],
      "params": "v2::thread::ThreadMetadataUpdateParams",
      "result": "JsonValue",
      "scope": {
        "field": "threadId",
        "kind": "thread"
      }
    },
    {
      "class": "C2",
      "method": "thread/archive",
      "mutation": {
        "domain": "thread",
        "kind": "op"
      },
      "opScope": {
        "field": "threadId",
        "kind": "thread"
      },
      "origins": [
        "local",
        "ssh",
        "relay"
      ],
      "params": "v2::thread::ThreadOpParams",
      "result": "JsonValue",
      "scope": {
        "field": "threadId",
        "kind": "thread"
      }
    },
    {
      "class": "C2",
      "method": "thread/unarchive",
      "mutation": {
        "domain": "thread",
        "kind": "op"
      },
      "opScope": {
        "field": "threadId",
        "kind": "thread"
      },
      "origins": [
        "local",
        "ssh",
        "relay"
      ],
      "params": "v2::thread::ThreadOpParams",
      "result": "JsonValue",
      "scope": {
        "field": "threadId",
        "kind": "thread"
      }
    },
    {
      "class": "C2",
      "method": "thread/delete",
      "mutation": {
        "domain": "thread",
        "kind": "op"
      },
      "opScope": {
        "field": "threadId",
        "kind": "thread"
      },
      "origins": [
        "local",
        "ssh",
        "relay"
      ],
      "params": "v2::thread::ThreadDeleteParams",
      "result": "JsonValue",
      "scope": {
        "field": "threadId",
        "kind": "thread"
      }
    },
    {
      "class": "C2",
      "method": "thread/fork",
      "mutation": {
        "domain": "thread",
        "kind": "op"
      },
      "opScope": {
        "field": "threadId",
        "kind": "thread"
      },
      "origins": [
        "local",
        "ssh",
        "relay"
      ],
      "params": "v2::thread::ThreadForkParams",
      "result": "JsonValue",
      "scope": {
        "field": "threadId",
        "kind": "thread"
      }
    },
    {
      "class": "C2",
      "method": "thread/continueInModel",
      "mutation": {
        "domain": "thread",
        "kind": "op"
      },
      "opScope": {
        "field": "threadId",
        "kind": "thread"
      },
      "origins": [
        "local",
        "ssh",
        "relay"
      ],
      "params": "v2::thread::ThreadContinueInModelParams",
      "result": "JsonValue",
      "scope": {
        "field": "threadId",
        "kind": "thread"
      }
    },
    {
      "class": "C2",
      "method": "thread/rewind",
      "mutation": {
        "domain": "thread",
        "kind": "op"
      },
      "opScope": {
        "field": "threadId",
        "kind": "thread"
      },
      "origins": [
        "local",
        "ssh",
        "relay"
      ],
      "params": "v2::thread::ThreadRewindParams",
      "result": "JsonValue",
      "scope": {
        "field": "threadId",
        "kind": "thread"
      }
    },
    {
      "class": "C2",
      "method": "thread/clear",
      "mutation": {
        "domain": "thread",
        "kind": "op"
      },
      "opScope": {
        "field": "threadId",
        "kind": "thread"
      },
      "origins": [
        "local",
        "ssh",
        "relay"
      ],
      "params": "v2::thread::ThreadClearParams",
      "result": "JsonValue",
      "scope": {
        "field": "threadId",
        "kind": "thread"
      }
    },
    {
      "class": "C2",
      "method": "thread/compact/start",
      "mutation": {
        "domain": "thread",
        "kind": "op"
      },
      "opScope": {
        "field": "threadId",
        "kind": "thread"
      },
      "origins": [
        "local",
        "ssh",
        "relay"
      ],
      "params": "v2::thread::ThreadCompactStartParams",
      "result": "JsonValue",
      "scope": {
        "field": "threadId",
        "kind": "thread"
      }
    },
    {
      "class": "C2",
      "method": "thread/queue/delete",
      "mutation": {
        "domain": "thread",
        "kind": "op"
      },
      "opScope": {
        "field": "threadId",
        "kind": "thread"
      },
      "origins": [
        "local",
        "ssh",
        "relay"
      ],
      "params": "v2::thread::ThreadQueueDeleteParams",
      "result": "JsonValue",
      "scope": {
        "field": "threadId",
        "kind": "thread"
      }
    },
    {
      "class": "C2",
      "method": "thread/goal/set",
      "mutation": {
        "domain": "thread",
        "kind": "op"
      },
      "opScope": {
        "field": "threadId",
        "kind": "thread"
      },
      "origins": [
        "local",
        "ssh",
        "relay"
      ],
      "params": "v2::thread::ThreadGoalSetParams",
      "result": "JsonValue",
      "scope": {
        "field": "threadId",
        "kind": "thread"
      }
    },
    {
      "class": "C2",
      "method": "thread/goal/clear",
      "mutation": {
        "domain": "thread",
        "kind": "op"
      },
      "opScope": {
        "field": "threadId",
        "kind": "thread"
      },
      "origins": [
        "local",
        "ssh",
        "relay"
      ],
      "params": "v2::thread::ThreadOpParams",
      "result": "JsonValue",
      "scope": {
        "field": "threadId",
        "kind": "thread"
      }
    },
    {
      "class": "C2",
      "method": "thread/goal/control",
      "mutation": {
        "domain": "thread",
        "kind": "op"
      },
      "opScope": {
        "field": "threadId",
        "kind": "thread"
      },
      "origins": [
        "local",
        "ssh",
        "relay"
      ],
      "params": "v2::thread::ThreadGoalControlParams",
      "result": "JsonValue",
      "scope": {
        "field": "threadId",
        "kind": "thread"
      }
    },
    {
      "class": "C2",
      "method": "thread/quotaResume/schedule",
      "mutation": {
        "domain": "thread",
        "kind": "op"
      },
      "opScope": {
        "field": "threadId",
        "kind": "thread"
      },
      "origins": [
        "local",
        "ssh",
        "relay"
      ],
      "params": "v2::thread::ThreadOpParams",
      "result": "JsonValue",
      "scope": {
        "field": "threadId",
        "kind": "thread"
      }
    },
    {
      "class": "C2",
      "method": "thread/quotaResume/cancel",
      "mutation": {
        "domain": "thread",
        "kind": "op"
      },
      "opScope": {
        "field": "threadId",
        "kind": "thread"
      },
      "origins": [
        "local",
        "ssh",
        "relay"
      ],
      "params": "v2::thread::ThreadOpParams",
      "result": "JsonValue",
      "scope": {
        "field": "threadId",
        "kind": "thread"
      }
    },
    {
      "class": "C2",
      "method": "thread/backgroundTerminals/terminate",
      "mutation": {
        "domain": "thread",
        "kind": "op"
      },
      "opScope": {
        "field": "threadId",
        "kind": "thread"
      },
      "origins": [
        "local",
        "ssh",
        "relay"
      ],
      "params": "v2::thread::ThreadBackgroundTerminalParams",
      "result": "JsonValue",
      "scope": {
        "field": "threadId",
        "kind": "thread"
      }
    },
    {
      "class": "C2",
      "method": "thread/backgroundTerminals/release",
      "mutation": {
        "domain": "thread",
        "kind": "op"
      },
      "opScope": {
        "field": "threadId",
        "kind": "thread"
      },
      "origins": [
        "local",
        "ssh",
        "relay"
      ],
      "params": "v2::thread::ThreadBackgroundTerminalParams",
      "result": "JsonValue",
      "scope": {
        "field": "threadId",
        "kind": "thread"
      }
    },
    {
      "class": "C2",
      "method": "thread/backgroundTerminals/clean",
      "mutation": {
        "domain": "thread",
        "kind": "op"
      },
      "opScope": {
        "field": "threadId",
        "kind": "thread"
      },
      "origins": [
        "local",
        "ssh",
        "relay"
      ],
      "params": "v2::thread::ThreadOpParams",
      "result": "JsonValue",
      "scope": {
        "field": "threadId",
        "kind": "thread"
      }
    },
    {
      "class": "C2",
      "method": "turn/start",
      "mutation": {
        "domain": "thread",
        "kind": "op"
      },
      "opScope": {
        "field": "threadId",
        "kind": "thread"
      },
      "origins": [
        "local",
        "ssh",
        "relay"
      ],
      "params": "v2::thread::TurnStartParams",
      "result": "v2::thread::TurnStartResponse",
      "scope": {
        "field": "threadId",
        "kind": "thread"
      }
    },
    {
      "class": "C0",
      "method": "turn/interrupt",
      "mutation": {
        "kind": "none"
      },
      "opScope": {
        "kind": "none"
      },
      "origins": [
        "local",
        "ssh",
        "relay"
      ],
      "params": "v2::thread::TurnInterruptParams",
      "result": "v2::thread::TurnInterruptResponse",
      "scope": {
        "kind": "none"
      }
    },
    {
      "class": "C0",
      "method": "turn/steer",
      "mutation": {
        "kind": "none"
      },
      "opScope": {
        "kind": "none"
      },
      "origins": [
        "local",
        "ssh",
        "relay"
      ],
      "params": "v2::thread::TurnSteerParams",
      "result": "v2::thread::TurnSteerResponse",
      "scope": {
        "kind": "none"
      }
    },
    {
      "class": "C2",
      "method": "turn/retryFailed",
      "mutation": {
        "domain": "thread",
        "kind": "op"
      },
      "opScope": {
        "field": "threadId",
        "kind": "thread"
      },
      "origins": [
        "local",
        "ssh",
        "relay"
      ],
      "params": "v2::thread::TurnRetryFailedParams",
      "result": "JsonValue",
      "scope": {
        "field": "threadId",
        "kind": "thread"
      }
    },
    {
      "class": "C1",
      "method": "thread/contextStatus",
      "mutation": {
        "kind": "none"
      },
      "opScope": {
        "kind": "none"
      },
      "origins": [
        "local",
        "ssh",
        "relay"
      ],
      "params": "ThreadContextStatusParams",
      "result": "JsonValue",
      "scope": {
        "kind": "none"
      }
    },
    {
      "class": "C1",
      "method": "thread/getSessionUsage",
      "mutation": {
        "kind": "none"
      },
      "opScope": {
        "kind": "none"
      },
      "origins": [
        "local",
        "ssh",
        "relay"
      ],
      "params": "ThreadGetSessionUsageParams",
      "result": "JsonValue",
      "scope": {
        "kind": "none"
      }
    },
    {
      "class": "C1",
      "method": "thread/getSessionWorktreeWork",
      "mutation": {
        "kind": "none"
      },
      "opScope": {
        "kind": "none"
      },
      "origins": [
        "local",
        "ssh"
      ],
      "params": "ThreadGetSessionWorktreeWorkParams",
      "result": "JsonValue",
      "scope": {
        "kind": "none"
      }
    },
    {
      "class": "C1",
      "method": "thread/inheritancePreflight",
      "mutation": {
        "kind": "none"
      },
      "opScope": {
        "kind": "none"
      },
      "origins": [
        "local",
        "ssh",
        "relay"
      ],
      "params": "ThreadInheritancePreflightParams",
      "result": "JsonValue",
      "scope": {
        "kind": "none"
      }
    },
    {
      "class": "C1",
      "method": "thread/listShellJobs",
      "mutation": {
        "kind": "none"
      },
      "opScope": {
        "kind": "none"
      },
      "origins": [
        "local",
        "ssh",
        "relay"
      ],
      "params": "ThreadListShellJobsParams",
      "result": "JsonValue",
      "scope": {
        "kind": "none"
      }
    },
    {
      "class": "C1",
      "method": "thread/listStoppableShellJobs",
      "mutation": {
        "kind": "none"
      },
      "opScope": {
        "kind": "none"
      },
      "origins": [
        "local",
        "ssh",
        "relay"
      ],
      "params": "ThreadListStoppableShellJobsParams",
      "result": "JsonValue",
      "scope": {
        "kind": "none"
      }
    },
    {
      "class": "C1",
      "method": "thread/getBranchMenu",
      "mutation": {
        "kind": "none"
      },
      "opScope": {
        "kind": "none"
      },
      "origins": [
        "local",
        "ssh",
        "relay"
      ],
      "params": "ThreadGetBranchMenuParams",
      "result": "JsonValue",
      "scope": {
        "kind": "none"
      }
    },
    {
      "class": "C2",
      "method": "thread/askSide",
      "mutation": {
        "domain": "thread",
        "kind": "op"
      },
      "opScope": {
        "domain": "thread",
        "field": "threadId",
        "kind": "threadOrDomain"
      },
      "origins": [
        "local",
        "ssh",
        "relay"
      ],
      "params": "ThreadAskSideParams",
      "result": "JsonValue",
      "scope": {
        "field": "threadId",
        "kind": "threadOrNone"
      }
    },
    {
      "class": "C2",
      "method": "thread/cancelSide",
      "mutation": {
        "domain": "thread",
        "kind": "op"
      },
      "opScope": {
        "domain": "thread",
        "field": "threadId",
        "kind": "threadOrDomain"
      },
      "origins": [
        "local",
        "ssh",
        "relay"
      ],
      "params": "ThreadCancelSideParams",
      "result": "JsonValue",
      "scope": {
        "field": "threadId",
        "kind": "threadOrNone"
      }
    },
    {
      "class": "C2",
      "method": "thread/agentControl",
      "mutation": {
        "domain": "thread",
        "kind": "op"
      },
      "opScope": {
        "domain": "thread",
        "field": "threadId",
        "kind": "threadOrDomain"
      },
      "origins": [
        "local",
        "ssh",
        "relay"
      ],
      "params": "ThreadAgentControlParams",
      "result": "JsonValue",
      "scope": {
        "field": "threadId",
        "kind": "threadOrNone"
      }
    },
    {
      "class": "C2",
      "method": "thread/switchContext",
      "mutation": {
        "domain": "thread",
        "kind": "op"
      },
      "opScope": {
        "domain": "thread",
        "field": "threadId",
        "kind": "threadOrDomain"
      },
      "origins": [
        "local",
        "ssh"
      ],
      "params": "ThreadSwitchContextParams",
      "result": "JsonValue",
      "scope": {
        "field": "threadId",
        "kind": "threadOrNone"
      }
    },
    {
      "class": "C2",
      "method": "thread/setCwd",
      "mutation": {
        "domain": "thread",
        "kind": "op"
      },
      "opScope": {
        "domain": "thread",
        "field": "threadId",
        "kind": "threadOrDomain"
      },
      "origins": [
        "local",
        "ssh"
      ],
      "params": "ThreadSetCwdParams",
      "result": "JsonValue",
      "scope": {
        "field": "threadId",
        "kind": "threadOrNone"
      }
    },
    {
      "class": "C2",
      "method": "thread/setEffort",
      "mutation": {
        "domain": "thread",
        "kind": "op"
      },
      "opScope": {
        "domain": "thread",
        "field": "threadId",
        "kind": "threadOrDomain"
      },
      "origins": [
        "local",
        "ssh",
        "relay"
      ],
      "params": "ThreadSetEffortParams",
      "result": "JsonValue",
      "scope": {
        "field": "threadId",
        "kind": "threadOrNone"
      }
    },
    {
      "class": "C2",
      "method": "thread/setToolMode",
      "mutation": {
        "domain": "thread",
        "kind": "op"
      },
      "opScope": {
        "domain": "thread",
        "field": "threadId",
        "kind": "threadOrDomain"
      },
      "origins": [
        "local",
        "ssh",
        "relay"
      ],
      "params": "ThreadSetToolModeParams",
      "result": "JsonValue",
      "scope": {
        "field": "threadId",
        "kind": "threadOrNone"
      }
    },
    {
      "class": "C2",
      "method": "thread/setWorkflow",
      "mutation": {
        "domain": "thread",
        "kind": "op"
      },
      "opScope": {
        "domain": "thread",
        "field": "threadId",
        "kind": "threadOrDomain"
      },
      "origins": [
        "local",
        "ssh",
        "relay"
      ],
      "params": "ThreadSetWorkflowParams",
      "result": "JsonValue",
      "scope": {
        "field": "threadId",
        "kind": "threadOrNone"
      }
    },
    {
      "class": "C2",
      "method": "thread/setOrchestrationMode",
      "mutation": {
        "domain": "thread",
        "kind": "op"
      },
      "opScope": {
        "domain": "thread",
        "field": "threadId",
        "kind": "threadOrDomain"
      },
      "origins": [
        "local",
        "ssh",
        "relay"
      ],
      "params": "ThreadSetOrchestrationModeParams",
      "result": "JsonValue",
      "scope": {
        "field": "threadId",
        "kind": "threadOrNone"
      }
    },
    {
      "class": "C2",
      "method": "thread/setOutputStyle",
      "mutation": {
        "domain": "thread",
        "kind": "op"
      },
      "opScope": {
        "domain": "thread",
        "field": "threadId",
        "kind": "threadOrDomain"
      },
      "origins": [
        "local",
        "ssh",
        "relay"
      ],
      "params": "ThreadSetOutputStyleParams",
      "result": "JsonValue",
      "scope": {
        "field": "threadId",
        "kind": "threadOrNone"
      }
    },
    {
      "class": "C2",
      "method": "thread/revertTurnReview",
      "mutation": {
        "domain": "thread",
        "kind": "op"
      },
      "opScope": {
        "domain": "thread",
        "field": "threadId",
        "kind": "threadOrDomain"
      },
      "origins": [
        "local",
        "ssh",
        "relay"
      ],
      "params": "ThreadRevertTurnReviewParams",
      "result": "JsonValue",
      "scope": {
        "field": "threadId",
        "kind": "threadOrNone"
      }
    },
    {
      "class": "C2",
      "method": "thread/revertTurnReviewFile",
      "mutation": {
        "domain": "thread",
        "kind": "op"
      },
      "opScope": {
        "domain": "thread",
        "field": "threadId",
        "kind": "threadOrDomain"
      },
      "origins": [
        "local",
        "ssh",
        "relay"
      ],
      "params": "ThreadRevertTurnReviewFileParams",
      "result": "JsonValue",
      "scope": {
        "field": "threadId",
        "kind": "threadOrNone"
      }
    },
    {
      "class": "C2",
      "method": "thread/revertTurnChanges",
      "mutation": {
        "domain": "thread",
        "kind": "op"
      },
      "opScope": {
        "domain": "thread",
        "field": "threadId",
        "kind": "threadOrDomain"
      },
      "origins": [
        "local",
        "ssh",
        "relay"
      ],
      "params": "ThreadRevertTurnChangesParams",
      "result": "JsonValue",
      "scope": {
        "field": "threadId",
        "kind": "threadOrNone"
      }
    },
    {
      "class": "C2",
      "method": "thread/reapplyTurnChanges",
      "mutation": {
        "domain": "thread",
        "kind": "op"
      },
      "opScope": {
        "domain": "thread",
        "field": "threadId",
        "kind": "threadOrDomain"
      },
      "origins": [
        "local",
        "ssh",
        "relay"
      ],
      "params": "ThreadReapplyTurnChangesParams",
      "result": "JsonValue",
      "scope": {
        "field": "threadId",
        "kind": "threadOrNone"
      }
    },
    {
      "class": "C2",
      "method": "thread/clearSessionChangeHistory",
      "mutation": {
        "domain": "thread",
        "kind": "op"
      },
      "opScope": {
        "domain": "thread",
        "field": "threadId",
        "kind": "threadOrDomain"
      },
      "origins": [
        "local",
        "ssh",
        "relay"
      ],
      "params": "ThreadClearSessionChangeHistoryParams",
      "result": "JsonValue",
      "scope": {
        "field": "threadId",
        "kind": "threadOrNone"
      }
    },
    {
      "class": "C2",
      "method": "thread/stageAttachmentOriginal",
      "mutation": {
        "domain": "thread",
        "kind": "op"
      },
      "opScope": {
        "domain": "thread",
        "field": "threadId",
        "kind": "threadOrDomain"
      },
      "origins": [
        "local",
        "ssh",
        "relay"
      ],
      "params": "ThreadStageAttachmentOriginalParams",
      "result": "JsonValue",
      "scope": {
        "field": "threadId",
        "kind": "threadOrNone"
      }
    },
    {
      "class": "C2",
      "method": "thread/resizeImage",
      "mutation": {
        "domain": "thread",
        "kind": "op"
      },
      "opScope": {
        "domain": "thread",
        "field": "threadId",
        "kind": "threadOrDomain"
      },
      "origins": [
        "local",
        "ssh",
        "relay"
      ],
      "params": "ThreadResizeImageParams",
      "result": "JsonValue",
      "scope": {
        "field": "threadId",
        "kind": "threadOrNone"
      }
    },
    {
      "class": "C2",
      "method": "thread/pushNotice",
      "mutation": {
        "domain": "thread",
        "kind": "op"
      },
      "opScope": {
        "domain": "thread",
        "field": "threadId",
        "kind": "threadOrDomain"
      },
      "origins": [
        "local",
        "ssh"
      ],
      "params": "ThreadPushNoticeParams",
      "result": "JsonValue",
      "scope": {
        "field": "threadId",
        "kind": "threadOrNone"
      }
    },
    {
      "class": "C2",
      "method": "thread/requestWorktree",
      "mutation": {
        "domain": "thread",
        "kind": "op"
      },
      "opScope": {
        "domain": "thread",
        "field": "threadId",
        "kind": "threadOrDomain"
      },
      "origins": [
        "local",
        "ssh",
        "relay"
      ],
      "params": "ThreadRequestWorktreeParams",
      "result": "JsonValue",
      "scope": {
        "field": "threadId",
        "kind": "threadOrNone"
      }
    },
    {
      "class": "C2",
      "method": "thread/mergeWorkspace",
      "mutation": {
        "domain": "thread",
        "kind": "op"
      },
      "opScope": {
        "domain": "thread",
        "field": "threadId",
        "kind": "threadOrDomain"
      },
      "origins": [
        "local",
        "ssh",
        "relay"
      ],
      "params": "ThreadMergeWorkspaceParams",
      "result": "JsonValue",
      "scope": {
        "field": "threadId",
        "kind": "threadOrNone"
      }
    },
    {
      "class": "C2",
      "method": "thread/selectBranch",
      "mutation": {
        "domain": "thread",
        "kind": "op"
      },
      "opScope": {
        "domain": "thread",
        "field": "threadId",
        "kind": "threadOrDomain"
      },
      "origins": [
        "local",
        "ssh",
        "relay"
      ],
      "params": "ThreadSelectBranchParams",
      "result": "JsonValue",
      "scope": {
        "field": "threadId",
        "kind": "threadOrNone"
      }
    },
    {
      "class": "C1",
      "method": "project/inspectProjectBranch",
      "mutation": {
        "kind": "none"
      },
      "opScope": {
        "kind": "none"
      },
      "origins": [
        "local",
        "ssh",
        "relay"
      ],
      "params": "ProjectInspectProjectBranchParams",
      "result": "JsonValue",
      "scope": {
        "kind": "none"
      }
    },
    {
      "class": "C1",
      "method": "project/getProjectBranchMenu",
      "mutation": {
        "kind": "none"
      },
      "opScope": {
        "kind": "none"
      },
      "origins": [
        "local",
        "ssh",
        "relay"
      ],
      "params": "ProjectGetProjectBranchMenuParams",
      "result": "JsonValue",
      "scope": {
        "kind": "none"
      }
    },
    {
      "class": "C1",
      "method": "project/getProjectConnectors",
      "mutation": {
        "kind": "none"
      },
      "opScope": {
        "kind": "none"
      },
      "origins": [
        "local",
        "ssh",
        "relay"
      ],
      "params": "ProjectGetProjectConnectorsParams",
      "result": "JsonValue",
      "scope": {
        "kind": "none"
      }
    },
    {
      "class": "C1",
      "method": "project/listWorktrees",
      "mutation": {
        "kind": "none"
      },
      "opScope": {
        "kind": "none"
      },
      "origins": [
        "local",
        "ssh",
        "relay"
      ],
      "params": "ProjectListWorktreesParams",
      "result": "JsonValue",
      "scope": {
        "kind": "none"
      }
    },
    {
      "class": "C1",
      "method": "project/previewWorktreeCleanup",
      "mutation": {
        "kind": "none"
      },
      "opScope": {
        "kind": "none"
      },
      "origins": [
        "local",
        "ssh",
        "relay"
      ],
      "params": "ProjectPreviewWorktreeCleanupParams",
      "result": "JsonValue",
      "scope": {
        "kind": "none"
      }
    },
    {
      "class": "C2",
      "method": "project/selectProjectBranch",
      "mutation": {
        "domain": "project",
        "kind": "op"
      },
      "opScope": {
        "domain": "project",
        "field": "threadId",
        "kind": "threadOrDomain"
      },
      "origins": [
        "local",
        "ssh",
        "relay"
      ],
      "params": "ProjectSelectProjectBranchParams",
      "result": "JsonValue",
      "scope": {
        "field": "threadId",
        "kind": "threadOrNone"
      }
    },
    {
      "class": "C2",
      "method": "project/mergeProjectBranch",
      "mutation": {
        "domain": "project",
        "kind": "op"
      },
      "opScope": {
        "domain": "project",
        "field": "threadId",
        "kind": "threadOrDomain"
      },
      "origins": [
        "local",
        "ssh",
        "relay"
      ],
      "params": "ProjectMergeProjectBranchParams",
      "result": "JsonValue",
      "scope": {
        "field": "threadId",
        "kind": "threadOrNone"
      }
    },
    {
      "class": "C2",
      "method": "project/manageProjectBranch",
      "mutation": {
        "domain": "project",
        "kind": "op"
      },
      "opScope": {
        "domain": "project",
        "field": "threadId",
        "kind": "threadOrDomain"
      },
      "origins": [
        "local",
        "ssh",
        "relay"
      ],
      "params": "ProjectManageProjectBranchParams",
      "result": "JsonValue",
      "scope": {
        "field": "threadId",
        "kind": "threadOrNone"
      }
    },
    {
      "class": "C2",
      "method": "project/removeWorktree",
      "mutation": {
        "domain": "project",
        "kind": "op"
      },
      "opScope": {
        "domain": "project",
        "field": "threadId",
        "kind": "threadOrDomain"
      },
      "origins": [
        "local",
        "ssh",
        "relay"
      ],
      "params": "ProjectRemoveWorktreeParams",
      "result": "JsonValue",
      "scope": {
        "field": "threadId",
        "kind": "threadOrNone"
      }
    },
    {
      "class": "C2",
      "method": "project/pruneWorktrees",
      "mutation": {
        "domain": "project",
        "kind": "op"
      },
      "opScope": {
        "domain": "project",
        "field": "threadId",
        "kind": "threadOrDomain"
      },
      "origins": [
        "local",
        "ssh",
        "relay"
      ],
      "params": "ProjectPruneWorktreesParams",
      "result": "JsonValue",
      "scope": {
        "field": "threadId",
        "kind": "threadOrNone"
      }
    },
    {
      "class": "C2",
      "method": "project/deleteWorktree",
      "mutation": {
        "domain": "project",
        "kind": "op"
      },
      "opScope": {
        "domain": "project",
        "field": "threadId",
        "kind": "threadOrDomain"
      },
      "origins": [
        "local",
        "ssh",
        "relay"
      ],
      "params": "ProjectDeleteWorktreeParams",
      "result": "JsonValue",
      "scope": {
        "field": "threadId",
        "kind": "threadOrNone"
      }
    },
    {
      "class": "C2",
      "method": "project/setArchivedSessionWorktrees",
      "mutation": {
        "domain": "project",
        "kind": "op"
      },
      "opScope": {
        "domain": "project",
        "field": "threadId",
        "kind": "threadOrDomain"
      },
      "origins": [
        "local",
        "ssh"
      ],
      "params": "ProjectSetArchivedSessionWorktreesParams",
      "result": "JsonValue",
      "scope": {
        "field": "threadId",
        "kind": "threadOrNone"
      }
    },
    {
      "class": "C2",
      "method": "project/setProjectConnectorEnabled",
      "mutation": {
        "domain": "project",
        "kind": "op"
      },
      "opScope": {
        "domain": "project",
        "field": "threadId",
        "kind": "threadOrDomain"
      },
      "origins": [
        "local",
        "ssh",
        "relay"
      ],
      "params": "ProjectSetProjectConnectorEnabledParams",
      "result": "JsonValue",
      "scope": {
        "field": "threadId",
        "kind": "threadOrNone"
      }
    },
    {
      "class": "C1",
      "method": "agent/agentDefinitionPresence",
      "mutation": {
        "kind": "none"
      },
      "opScope": {
        "kind": "none"
      },
      "origins": [
        "local",
        "ssh"
      ],
      "params": "AgentAgentDefinitionPresenceParams",
      "result": "JsonValue",
      "scope": {
        "kind": "none"
      }
    },
    {
      "class": "C1",
      "method": "agent/archivedAgentIdentities",
      "mutation": {
        "kind": "none"
      },
      "opScope": {
        "kind": "none"
      },
      "origins": [
        "local",
        "ssh",
        "relay"
      ],
      "params": "AgentArchivedAgentIdentitiesParams",
      "result": "JsonValue",
      "scope": {
        "kind": "none"
      }
    },
    {
      "class": "C1",
      "method": "agent/getAgentDefinition",
      "mutation": {
        "kind": "none"
      },
      "opScope": {
        "kind": "none"
      },
      "origins": [
        "local",
        "ssh",
        "relay"
      ],
      "params": "AgentGetAgentDefinitionParams",
      "result": "JsonValue",
      "scope": {
        "kind": "none"
      }
    },
    {
      "class": "C1",
      "method": "agent/getAgentAvatarImage",
      "mutation": {
        "kind": "none"
      },
      "opScope": {
        "kind": "none"
      },
      "origins": [
        "local",
        "ssh",
        "relay"
      ],
      "params": "AgentGetAgentAvatarImageParams",
      "result": "JsonValue",
      "scope": {
        "kind": "none"
      }
    },
    {
      "class": "C1",
      "method": "agent/getAgentConnectors",
      "mutation": {
        "kind": "none"
      },
      "opScope": {
        "kind": "none"
      },
      "origins": [
        "local",
        "ssh",
        "relay"
      ],
      "params": "AgentGetAgentConnectorsParams",
      "result": "JsonValue",
      "scope": {
        "kind": "none"
      }
    },
    {
      "class": "C1",
      "method": "agent/getAgentAlwaysAllowedTools",
      "mutation": {
        "kind": "none"
      },
      "opScope": {
        "kind": "none"
      },
      "origins": [
        "local",
        "ssh",
        "relay"
      ],
      "params": "AgentGetAgentAlwaysAllowedToolsParams",
      "result": "JsonValue",
      "scope": {
        "kind": "none"
      }
    },
    {
      "class": "C1",
      "method": "agent/getAgentConnectorTools",
      "mutation": {
        "kind": "none"
      },
      "opScope": {
        "kind": "none"
      },
      "origins": [
        "local",
        "ssh",
        "relay"
      ],
      "params": "AgentGetAgentConnectorToolsParams",
      "result": "JsonValue",
      "scope": {
        "kind": "none"
      }
    },
    {
      "class": "C1",
      "method": "agent/getAgentPermissions",
      "mutation": {
        "kind": "none"
      },
      "opScope": {
        "kind": "none"
      },
      "origins": [
        "local",
        "ssh",
        "relay"
      ],
      "params": "AgentGetAgentPermissionsParams",
      "result": "JsonValue",
      "scope": {
        "kind": "none"
      }
    },
    {
      "class": "C1",
      "method": "agent/getLeadPersona",
      "mutation": {
        "kind": "none"
      },
      "opScope": {
        "kind": "none"
      },
      "origins": [
        "local",
        "ssh",
        "relay"
      ],
      "params": "AgentGetLeadPersonaParams",
      "result": "JsonValue",
      "scope": {
        "kind": "none"
      }
    },
    {
      "class": "C1",
      "method": "agent/getLeadAgentBody",
      "mutation": {
        "kind": "none"
      },
      "opScope": {
        "kind": "none"
      },
      "origins": [
        "local",
        "ssh",
        "relay"
      ],
      "params": "AgentGetLeadAgentBodyParams",
      "result": "JsonValue",
      "scope": {
        "kind": "none"
      }
    },
    {
      "class": "C1",
      "method": "agent/getLeadStatus",
      "mutation": {
        "kind": "none"
      },
      "opScope": {
        "kind": "none"
      },
      "origins": [
        "local",
        "ssh",
        "relay"
      ],
      "params": "AgentGetLeadStatusParams",
      "result": "JsonValue",
      "scope": {
        "kind": "none"
      }
    },
    {
      "class": "C1",
      "method": "agent/getLeadHomeRoute",
      "mutation": {
        "kind": "none"
      },
      "opScope": {
        "kind": "none"
      },
      "origins": [
        "local",
        "ssh"
      ],
      "params": "AgentGetLeadHomeRouteParams",
      "result": "JsonValue",
      "scope": {
        "kind": "none"
      }
    },
    {
      "class": "C1",
      "method": "agent/getLeadAppearance",
      "mutation": {
        "kind": "none"
      },
      "opScope": {
        "kind": "none"
      },
      "origins": [
        "local",
        "ssh",
        "relay"
      ],
      "params": "AgentGetLeadAppearanceParams",
      "result": "JsonValue",
      "scope": {
        "kind": "none"
      }
    },
    {
      "class": "C2",
      "method": "agent/saveAgentDefinition",
      "mutation": {
        "domain": "agent",
        "kind": "op"
      },
      "opScope": {
        "domain": "agent",
        "field": "threadId",
        "kind": "threadOrDomain"
      },
      "origins": [
        "local",
        "ssh",
        "relay"
      ],
      "params": "AgentSaveAgentDefinitionParams",
      "result": "JsonValue",
      "scope": {
        "field": "threadId",
        "kind": "threadOrNone"
      }
    },
    {
      "class": "C2",
      "method": "agent/deleteAgentDefinition",
      "mutation": {
        "domain": "agent",
        "kind": "op"
      },
      "opScope": {
        "domain": "agent",
        "field": "threadId",
        "kind": "threadOrDomain"
      },
      "origins": [
        "local",
        "ssh",
        "relay"
      ],
      "params": "AgentDeleteAgentDefinitionParams",
      "result": "JsonValue",
      "scope": {
        "field": "threadId",
        "kind": "threadOrNone"
      }
    },
    {
      "class": "C2",
      "method": "agent/restoreAgentDefinition",
      "mutation": {
        "domain": "agent",
        "kind": "op"
      },
      "opScope": {
        "domain": "agent",
        "field": "threadId",
        "kind": "threadOrDomain"
      },
      "origins": [
        "local",
        "ssh",
        "relay"
      ],
      "params": "AgentRestoreAgentDefinitionParams",
      "result": "JsonValue",
      "scope": {
        "field": "threadId",
        "kind": "threadOrNone"
      }
    },
    {
      "class": "C2",
      "method": "agent/purgeAgentDefinition",
      "mutation": {
        "domain": "agent",
        "kind": "op"
      },
      "opScope": {
        "domain": "agent",
        "field": "threadId",
        "kind": "threadOrDomain"
      },
      "origins": [
        "local",
        "ssh"
      ],
      "params": "AgentPurgeAgentDefinitionParams",
      "result": "JsonValue",
      "scope": {
        "field": "threadId",
        "kind": "threadOrNone"
      }
    },
    {
      "class": "C2",
      "method": "agent/setAgentConnectors",
      "mutation": {
        "domain": "agent",
        "kind": "op"
      },
      "opScope": {
        "domain": "agent",
        "field": "threadId",
        "kind": "threadOrDomain"
      },
      "origins": [
        "local",
        "ssh",
        "relay"
      ],
      "params": "AgentSetAgentConnectorsParams",
      "result": "JsonValue",
      "scope": {
        "field": "threadId",
        "kind": "threadOrNone"
      }
    },
    {
      "class": "C2",
      "method": "agent/setAgentConnectorEnabled",
      "mutation": {
        "domain": "agent",
        "kind": "op"
      },
      "opScope": {
        "domain": "agent",
        "field": "threadId",
        "kind": "threadOrDomain"
      },
      "origins": [
        "local",
        "ssh",
        "relay"
      ],
      "params": "AgentSetAgentConnectorEnabledParams",
      "result": "JsonValue",
      "scope": {
        "field": "threadId",
        "kind": "threadOrNone"
      }
    },
    {
      "class": "C2",
      "method": "agent/setAgentConnectorToolPermission",
      "mutation": {
        "domain": "agent",
        "kind": "op"
      },
      "opScope": {
        "domain": "agent",
        "field": "threadId",
        "kind": "threadOrDomain"
      },
      "origins": [
        "local",
        "ssh",
        "relay"
      ],
      "params": "AgentSetAgentConnectorToolPermissionParams",
      "result": "JsonValue",
      "scope": {
        "field": "threadId",
        "kind": "threadOrNone"
      }
    },
    {
      "class": "C2",
      "method": "agent/setAgentPermission",
      "mutation": {
        "domain": "agent",
        "kind": "op"
      },
      "opScope": {
        "domain": "agent",
        "field": "threadId",
        "kind": "threadOrDomain"
      },
      "origins": [
        "local",
        "ssh",
        "relay"
      ],
      "params": "AgentSetAgentPermissionParams",
      "result": "JsonValue",
      "scope": {
        "field": "threadId",
        "kind": "threadOrNone"
      }
    },
    {
      "class": "C2",
      "method": "agent/recordAgentApprovalAudit",
      "mutation": {
        "domain": "agent",
        "kind": "op"
      },
      "opScope": {
        "domain": "agent",
        "field": "threadId",
        "kind": "threadOrDomain"
      },
      "origins": [
        "local",
        "ssh"
      ],
      "params": "AgentRecordAgentApprovalAuditParams",
      "result": "JsonValue",
      "scope": {
        "field": "threadId",
        "kind": "threadOrNone"
      }
    },
    {
      "class": "C2",
      "method": "agent/saveLeadPersona",
      "mutation": {
        "domain": "agent",
        "kind": "op"
      },
      "opScope": {
        "domain": "agent",
        "field": "threadId",
        "kind": "threadOrDomain"
      },
      "origins": [
        "local",
        "ssh",
        "relay"
      ],
      "params": "AgentSaveLeadPersonaParams",
      "result": "JsonValue",
      "scope": {
        "field": "threadId",
        "kind": "threadOrNone"
      }
    },
    {
      "class": "C2",
      "method": "agent/saveLeadAgentBody",
      "mutation": {
        "domain": "agent",
        "kind": "op"
      },
      "opScope": {
        "domain": "agent",
        "field": "threadId",
        "kind": "threadOrDomain"
      },
      "origins": [
        "local",
        "ssh",
        "relay"
      ],
      "params": "AgentSaveLeadAgentBodyParams",
      "result": "JsonValue",
      "scope": {
        "field": "threadId",
        "kind": "threadOrNone"
      }
    },
    {
      "class": "C2",
      "method": "agent/setLeadCreated",
      "mutation": {
        "domain": "agent",
        "kind": "op"
      },
      "opScope": {
        "domain": "agent",
        "field": "threadId",
        "kind": "threadOrDomain"
      },
      "origins": [
        "local",
        "ssh",
        "relay"
      ],
      "params": "AgentSetLeadCreatedParams",
      "result": "JsonValue",
      "scope": {
        "field": "threadId",
        "kind": "threadOrNone"
      }
    },
    {
      "class": "C2",
      "method": "agent/saveLeadIdentity",
      "mutation": {
        "domain": "agent",
        "kind": "op"
      },
      "opScope": {
        "domain": "agent",
        "field": "threadId",
        "kind": "threadOrDomain"
      },
      "origins": [
        "local",
        "ssh",
        "relay"
      ],
      "params": "AgentSaveLeadIdentityParams",
      "result": "JsonValue",
      "scope": {
        "field": "threadId",
        "kind": "threadOrNone"
      }
    },
    {
      "class": "C2",
      "method": "agent/setLeadAppearance",
      "mutation": {
        "domain": "agent",
        "kind": "op"
      },
      "opScope": {
        "domain": "agent",
        "field": "threadId",
        "kind": "threadOrDomain"
      },
      "origins": [
        "local",
        "ssh",
        "relay"
      ],
      "params": "AgentSetLeadAppearanceParams",
      "result": "JsonValue",
      "scope": {
        "field": "threadId",
        "kind": "threadOrNone"
      }
    },
    {
      "class": "C1",
      "method": "config/getBotOrder",
      "mutation": {
        "kind": "none"
      },
      "opScope": {
        "kind": "none"
      },
      "origins": [
        "local",
        "ssh",
        "relay"
      ],
      "params": "ConfigGetBotOrderParams",
      "result": "BotOrder",
      "scope": {
        "field": "threadId",
        "key": "config",
        "kind": "threadOrSharedRead"
      }
    },
    {
      "class": "C2",
      "method": "config/setBotOrder",
      "mutation": {
        "domain": "config",
        "kind": "op"
      },
      "opScope": {
        "domain": "config",
        "field": "threadId",
        "kind": "threadOrDomain"
      },
      "origins": [
        "local",
        "ssh",
        "relay"
      ],
      "params": "ConfigSetBotOrderParams",
      "result": "BotOrder",
      "scope": {
        "field": "threadId",
        "key": "config",
        "kind": "threadOrGlobal"
      }
    },
    {
      "class": "C2",
      "method": "agent/home/open",
      "mutation": {
        "domain": "agent",
        "kind": "op"
      },
      "opScope": {
        "domain": "agent",
        "kind": "domain"
      },
      "origins": [
        "local",
        "ssh",
        "relay"
      ],
      "params": "AgentHomeOpenParams",
      "result": "JsonValue",
      "scope": {
        "field": "agentId",
        "kind": "keyed",
        "namespace": "agentHome"
      }
    },
    {
      "class": "C2",
      "method": "agent/home/reset",
      "mutation": {
        "domain": "agent",
        "kind": "op"
      },
      "opScope": {
        "domain": "agent",
        "kind": "domain"
      },
      "origins": [
        "local",
        "ssh",
        "relay"
      ],
      "params": "AgentHomeResetParams",
      "result": "JsonValue",
      "scope": {
        "field": "agentId",
        "kind": "keyed",
        "namespace": "agentHome"
      }
    },
    {
      "class": "C1",
      "method": "agent/memory/list",
      "mutation": {
        "kind": "none"
      },
      "opScope": {
        "kind": "none"
      },
      "origins": [
        "local",
        "ssh"
      ],
      "params": "AgentMemoryListParams",
      "result": "JsonValue",
      "scope": {
        "kind": "none"
      }
    },
    {
      "class": "C2",
      "method": "agent/memory/delete",
      "mutation": {
        "domain": "agent",
        "kind": "op"
      },
      "opScope": {
        "domain": "agent",
        "kind": "domain"
      },
      "origins": [
        "local",
        "ssh"
      ],
      "params": "AgentMemoryDeleteParams",
      "result": "JsonValue",
      "scope": {
        "field": "agentId",
        "kind": "keyed",
        "namespace": "agentMemory"
      }
    },
    {
      "class": "C1",
      "method": "agent/pool/list",
      "mutation": {
        "kind": "none"
      },
      "opScope": {
        "kind": "none"
      },
      "origins": [
        "local",
        "ssh",
        "relay"
      ],
      "params": "AgentPoolListParams",
      "result": "JsonValue",
      "scope": {
        "kind": "none"
      }
    },
    {
      "class": "C2",
      "method": "room/create",
      "mutation": {
        "domain": "room",
        "kind": "op"
      },
      "opScope": {
        "domain": "room",
        "kind": "domain"
      },
      "origins": [
        "local",
        "ssh",
        "relay"
      ],
      "params": "RoomCreateParams",
      "result": "JsonValue",
      "scope": {
        "key": "room",
        "kind": "global"
      }
    },
    {
      "class": "C2",
      "method": "room/update",
      "mutation": {
        "domain": "room",
        "kind": "op"
      },
      "opScope": {
        "domain": "room",
        "kind": "domain"
      },
      "origins": [
        "local",
        "ssh",
        "relay"
      ],
      "params": "RoomUpdateParams",
      "result": "JsonValue",
      "scope": {
        "key": "room",
        "kind": "global"
      }
    },
    {
      "class": "C2",
      "method": "room/continue",
      "mutation": {
        "domain": "room",
        "kind": "op"
      },
      "opScope": {
        "domain": "room",
        "kind": "domain"
      },
      "origins": [
        "local",
        "ssh",
        "relay"
      ],
      "params": "RoomContinueParams",
      "result": "JsonValue",
      "scope": {
        "key": "room",
        "kind": "global"
      }
    },
    {
      "class": "C2",
      "method": "room/leave",
      "mutation": {
        "domain": "room",
        "kind": "op"
      },
      "opScope": {
        "domain": "room",
        "kind": "domain"
      },
      "origins": [
        "local",
        "ssh",
        "relay"
      ],
      "params": "RoomLeaveParams",
      "result": "JsonValue",
      "scope": {
        "key": "room",
        "kind": "global"
      }
    },
    {
      "class": "C2",
      "method": "room/remove",
      "mutation": {
        "domain": "room",
        "kind": "op"
      },
      "opScope": {
        "domain": "room",
        "kind": "domain"
      },
      "origins": [
        "local",
        "ssh",
        "relay"
      ],
      "params": "RoomRemoveParams",
      "result": "JsonValue",
      "scope": {
        "key": "room",
        "kind": "global"
      }
    },
    {
      "class": "C1",
      "method": "instructions/listInstructionFiles",
      "mutation": {
        "kind": "none"
      },
      "opScope": {
        "kind": "none"
      },
      "origins": [
        "local",
        "ssh",
        "relay"
      ],
      "params": "InstructionsListInstructionFilesParams",
      "result": "JsonValue",
      "scope": {
        "kind": "none"
      }
    },
    {
      "class": "C1",
      "method": "instructions/getInstructionFile",
      "mutation": {
        "kind": "none"
      },
      "opScope": {
        "kind": "none"
      },
      "origins": [
        "local",
        "ssh",
        "relay"
      ],
      "params": "InstructionsGetInstructionFileParams",
      "result": "JsonValue",
      "scope": {
        "kind": "none"
      }
    },
    {
      "class": "C2",
      "method": "instructions/saveInstructionFile",
      "mutation": {
        "domain": "instructions",
        "kind": "op"
      },
      "opScope": {
        "domain": "instructions",
        "field": "threadId",
        "kind": "threadOrDomain"
      },
      "origins": [
        "local",
        "ssh",
        "relay"
      ],
      "params": "InstructionsSaveInstructionFileParams",
      "result": "JsonValue",
      "scope": {
        "field": "threadId",
        "kind": "threadOrNone"
      }
    },
    {
      "class": "C2",
      "method": "instructions/resetInstructionFile",
      "mutation": {
        "domain": "instructions",
        "kind": "op"
      },
      "opScope": {
        "domain": "instructions",
        "field": "threadId",
        "kind": "threadOrDomain"
      },
      "origins": [
        "local",
        "ssh",
        "relay"
      ],
      "params": "InstructionsResetInstructionFileParams",
      "result": "JsonValue",
      "scope": {
        "field": "threadId",
        "kind": "threadOrNone"
      }
    },
    {
      "class": "C2",
      "method": "instructions/setInstructionFiles",
      "mutation": {
        "domain": "instructions",
        "kind": "op"
      },
      "opScope": {
        "domain": "instructions",
        "field": "threadId",
        "kind": "threadOrDomain"
      },
      "origins": [
        "local",
        "ssh",
        "relay"
      ],
      "params": "InstructionsSetInstructionFilesParams",
      "result": "JsonValue",
      "scope": {
        "field": "threadId",
        "kind": "threadOrNone"
      }
    },
    {
      "class": "C1",
      "method": "connector/listConnectorTools",
      "mutation": {
        "kind": "none"
      },
      "opScope": {
        "kind": "none"
      },
      "origins": [
        "local",
        "ssh",
        "relay"
      ],
      "params": "ConnectorListConnectorToolsParams",
      "result": "JsonValue",
      "scope": {
        "kind": "none"
      }
    },
    {
      "class": "C2",
      "method": "connector/addConnectorAccount",
      "mutation": {
        "domain": "connector",
        "kind": "op"
      },
      "opScope": {
        "domain": "connector",
        "field": "threadId",
        "kind": "threadOrDomain"
      },
      "origins": [
        "local",
        "ssh",
        "relay"
      ],
      "params": "ConnectorAddConnectorAccountParams",
      "result": "JsonValue",
      "scope": {
        "field": "threadId",
        "kind": "threadOrNone"
      }
    },
    {
      "class": "C1",
      "method": "config/getAutoClear",
      "mutation": {
        "kind": "none"
      },
      "opScope": {
        "kind": "none"
      },
      "origins": [
        "local",
        "ssh",
        "relay"
      ],
      "params": "ConfigGetAutoClearParams",
      "result": "JsonValue",
      "scope": {
        "field": "threadId",
        "key": "config",
        "kind": "threadOrSharedRead"
      }
    },
    {
      "class": "C1",
      "method": "config/getCacheWarmingSettings",
      "mutation": {
        "kind": "none"
      },
      "opScope": {
        "kind": "none"
      },
      "origins": [
        "local",
        "ssh",
        "relay"
      ],
      "params": "ConfigGetCacheWarmingSettingsParams",
      "result": "JsonValue",
      "scope": {
        "field": "threadId",
        "key": "config",
        "kind": "threadOrSharedRead"
      }
    },
    {
      "class": "C1",
      "method": "config/getCompactionSettings",
      "mutation": {
        "kind": "none"
      },
      "opScope": {
        "kind": "none"
      },
      "origins": [
        "local",
        "ssh",
        "relay"
      ],
      "params": "ConfigGetCompactionSettingsParams",
      "result": "JsonValue",
      "scope": {
        "field": "threadId",
        "key": "config",
        "kind": "threadOrSharedRead"
      }
    },
    {
      "class": "C1",
      "method": "config/getDeveloperSettings",
      "mutation": {
        "kind": "none"
      },
      "opScope": {
        "kind": "none"
      },
      "origins": [
        "local",
        "ssh",
        "relay"
      ],
      "params": "ConfigGetDeveloperSettingsParams",
      "result": "JsonValue",
      "scope": {
        "field": "threadId",
        "key": "config",
        "kind": "threadOrSharedRead"
      }
    },
    {
      "class": "C1",
      "method": "config/getOutputStyle",
      "mutation": {
        "kind": "none"
      },
      "opScope": {
        "kind": "none"
      },
      "origins": [
        "local",
        "ssh",
        "relay"
      ],
      "params": "ConfigGetOutputStyleParams",
      "result": "JsonValue",
      "scope": {
        "field": "threadId",
        "key": "config",
        "kind": "threadOrSharedRead"
      }
    },
    {
      "class": "C1",
      "method": "config/getOrchestrationMode",
      "mutation": {
        "kind": "none"
      },
      "opScope": {
        "kind": "none"
      },
      "origins": [
        "local",
        "ssh",
        "relay"
      ],
      "params": "ConfigGetOrchestrationModeParams",
      "result": "JsonValue",
      "scope": {
        "field": "threadId",
        "key": "config",
        "kind": "threadOrSharedRead"
      }
    },
    {
      "class": "C1",
      "method": "config/getConfiguredOrchestrationMode",
      "mutation": {
        "kind": "none"
      },
      "opScope": {
        "kind": "none"
      },
      "origins": [
        "local",
        "ssh",
        "relay"
      ],
      "params": "ConfigGetConfiguredOrchestrationModeParams",
      "result": "JsonValue",
      "scope": {
        "field": "threadId",
        "key": "config",
        "kind": "threadOrSharedRead"
      }
    },
    {
      "class": "C1",
      "method": "config/getProfile",
      "mutation": {
        "kind": "none"
      },
      "opScope": {
        "kind": "none"
      },
      "origins": [
        "local",
        "ssh",
        "relay"
      ],
      "params": "ConfigGetProfileParams",
      "result": "JsonValue",
      "scope": {
        "field": "threadId",
        "key": "config",
        "kind": "threadOrSharedRead"
      }
    },
    {
      "class": "C1",
      "method": "config/getRecapSettings",
      "mutation": {
        "kind": "none"
      },
      "opScope": {
        "kind": "none"
      },
      "origins": [
        "local",
        "ssh",
        "relay"
      ],
      "params": "ConfigGetRecapSettingsParams",
      "result": "JsonValue",
      "scope": {
        "field": "threadId",
        "key": "config",
        "kind": "threadOrSharedRead"
      }
    },
    {
      "class": "C1",
      "method": "config/getSessionTitleSettings",
      "mutation": {
        "kind": "none"
      },
      "opScope": {
        "kind": "none"
      },
      "origins": [
        "local",
        "ssh",
        "relay"
      ],
      "params": "ConfigGetSessionTitleSettingsParams",
      "result": "JsonValue",
      "scope": {
        "field": "threadId",
        "key": "config",
        "kind": "threadOrSharedRead"
      }
    },
    {
      "class": "C1",
      "method": "config/getHeartbeatSettings",
      "mutation": {
        "kind": "none"
      },
      "opScope": {
        "kind": "none"
      },
      "origins": [
        "local",
        "ssh",
        "relay"
      ],
      "params": "ConfigGetHeartbeatSettingsParams",
      "result": "JsonValue",
      "scope": {
        "field": "threadId",
        "key": "config",
        "kind": "threadOrSharedRead"
      }
    },
    {
      "class": "C1",
      "method": "config/getReactionSettings",
      "mutation": {
        "kind": "none"
      },
      "opScope": {
        "kind": "none"
      },
      "origins": [
        "local",
        "ssh",
        "relay"
      ],
      "params": "ConfigGetReactionSettingsParams",
      "result": "JsonValue",
      "scope": {
        "field": "threadId",
        "key": "config",
        "kind": "threadOrSharedRead"
      }
    },
    {
      "class": "C1",
      "method": "config/getSystemShell",
      "mutation": {
        "kind": "none"
      },
      "opScope": {
        "kind": "none"
      },
      "origins": [
        "local",
        "ssh",
        "relay"
      ],
      "params": "ConfigGetSystemShellParams",
      "result": "JsonValue",
      "scope": {
        "field": "threadId",
        "key": "config",
        "kind": "threadOrSharedRead"
      }
    },
    {
      "class": "C1",
      "method": "config/getTheme",
      "mutation": {
        "kind": "none"
      },
      "opScope": {
        "kind": "none"
      },
      "origins": [
        "local",
        "ssh",
        "relay"
      ],
      "params": "ConfigGetThemeParams",
      "result": "JsonValue",
      "scope": {
        "field": "threadId",
        "key": "config",
        "kind": "threadOrSharedRead"
      }
    },
    {
      "class": "C1",
      "method": "config/getToolModuleSettings",
      "mutation": {
        "kind": "none"
      },
      "opScope": {
        "kind": "none"
      },
      "origins": [
        "local",
        "ssh",
        "relay"
      ],
      "params": "ConfigGetToolModuleSettingsParams",
      "result": "mixdog_protocol::ToolModuleSettings",
      "scope": {
        "field": "threadId",
        "key": "config",
        "kind": "threadOrSharedRead"
      }
    },
    {
      "class": "C1",
      "method": "config/getUpdateSettings",
      "mutation": {
        "kind": "none"
      },
      "opScope": {
        "kind": "none"
      },
      "origins": [
        "local",
        "ssh",
        "relay"
      ],
      "params": "ConfigGetUpdateSettingsParams",
      "result": "JsonValue",
      "scope": {
        "field": "threadId",
        "key": "config",
        "kind": "threadOrSharedRead"
      }
    },
    {
      "class": "C1",
      "method": "config/getWorktreeSettings",
      "mutation": {
        "kind": "none"
      },
      "opScope": {
        "kind": "none"
      },
      "origins": [
        "local",
        "ssh",
        "relay"
      ],
      "params": "ConfigGetWorktreeSettingsParams",
      "result": "JsonValue",
      "scope": {
        "field": "threadId",
        "key": "config",
        "kind": "threadOrSharedRead"
      }
    },
    {
      "class": "C1",
      "method": "config/listOutputStyles",
      "mutation": {
        "kind": "none"
      },
      "opScope": {
        "kind": "none"
      },
      "origins": [
        "local",
        "ssh",
        "relay"
      ],
      "params": "ConfigListOutputStylesParams",
      "result": "JsonValue",
      "scope": {
        "field": "threadId",
        "key": "config",
        "kind": "threadOrSharedRead"
      }
    },
    {
      "class": "C1",
      "method": "config/getNetworkProxy",
      "mutation": {
        "kind": "none"
      },
      "opScope": {
        "kind": "none"
      },
      "origins": [
        "local",
        "ssh",
        "relay"
      ],
      "params": "ConfigGetNetworkProxyParams",
      "result": "JsonValue",
      "scope": {
        "field": "threadId",
        "key": "config",
        "kind": "threadOrSharedRead"
      }
    },
    {
      "class": "C1",
      "method": "config/testNetworkProxy",
      "mutation": {
        "kind": "none"
      },
      "opScope": {
        "kind": "none"
      },
      "origins": [
        "local",
        "ssh",
        "relay"
      ],
      "params": "ConfigTestNetworkProxyParams",
      "result": "JsonValue",
      "scope": {
        "field": "threadId",
        "key": "config",
        "kind": "threadOrSharedRead"
      }
    },
    {
      "class": "C1",
      "method": "config/getWorkflowPack",
      "mutation": {
        "kind": "none"
      },
      "opScope": {
        "kind": "none"
      },
      "origins": [
        "local",
        "ssh",
        "relay"
      ],
      "params": "ConfigGetWorkflowPackParams",
      "result": "JsonValue",
      "scope": {
        "field": "threadId",
        "key": "config",
        "kind": "threadOrSharedRead"
      }
    },
    {
      "class": "C1",
      "method": "config/isSetupRequestActive",
      "mutation": {
        "kind": "none"
      },
      "opScope": {
        "kind": "none"
      },
      "origins": [
        "local",
        "ssh",
        "relay"
      ],
      "params": "ConfigIsSetupRequestActiveParams",
      "result": "JsonValue",
      "scope": {
        "field": "threadId",
        "key": "config",
        "kind": "threadOrSharedRead"
      }
    },
    {
      "class": "C2",
      "method": "config/setAutoUpdate",
      "mutation": {
        "domain": "config",
        "kind": "op"
      },
      "opScope": {
        "domain": "config",
        "field": "threadId",
        "kind": "threadOrDomain"
      },
      "origins": [
        "local",
        "ssh",
        "relay"
      ],
      "params": "ConfigSetAutoUpdateParams",
      "result": "JsonValue",
      "scope": {
        "field": "threadId",
        "key": "config",
        "kind": "threadOrGlobal"
      }
    },
    {
      "class": "C2",
      "method": "config/setCacheWarmingEnabled",
      "mutation": {
        "domain": "config",
        "kind": "op"
      },
      "opScope": {
        "domain": "config",
        "field": "threadId",
        "kind": "threadOrDomain"
      },
      "origins": [
        "local",
        "ssh",
        "relay"
      ],
      "params": "ConfigSetCacheWarmingEnabledParams",
      "result": "JsonValue",
      "scope": {
        "field": "threadId",
        "key": "config",
        "kind": "threadOrGlobal"
      }
    },
    {
      "class": "C2",
      "method": "config/setRecapEnabled",
      "mutation": {
        "domain": "config",
        "kind": "op"
      },
      "opScope": {
        "domain": "config",
        "field": "threadId",
        "kind": "threadOrDomain"
      },
      "origins": [
        "local",
        "ssh",
        "relay"
      ],
      "params": "ConfigSetRecapEnabledParams",
      "result": "JsonValue",
      "scope": {
        "field": "threadId",
        "key": "config",
        "kind": "threadOrGlobal"
      }
    },
    {
      "class": "C2",
      "method": "config/setAiSessionTitles",
      "mutation": {
        "domain": "config",
        "kind": "op"
      },
      "opScope": {
        "domain": "config",
        "field": "threadId",
        "kind": "threadOrDomain"
      },
      "origins": [
        "local",
        "ssh",
        "relay"
      ],
      "params": "ConfigSetAiSessionTitlesParams",
      "result": "JsonValue",
      "scope": {
        "field": "threadId",
        "key": "config",
        "kind": "threadOrGlobal"
      }
    },
    {
      "class": "C2",
      "method": "config/setHeartbeatEnabled",
      "mutation": {
        "domain": "config",
        "kind": "op"
      },
      "opScope": {
        "domain": "config",
        "field": "threadId",
        "kind": "threadOrDomain"
      },
      "origins": [
        "local",
        "ssh",
        "relay"
      ],
      "params": "ConfigSetHeartbeatEnabledParams",
      "result": "JsonValue",
      "scope": {
        "field": "threadId",
        "key": "config",
        "kind": "threadOrGlobal"
      }
    },
    {
      "class": "C2",
      "method": "config/setReactionsEnabled",
      "mutation": {
        "domain": "config",
        "kind": "op"
      },
      "opScope": {
        "domain": "config",
        "field": "threadId",
        "kind": "threadOrDomain"
      },
      "origins": [
        "local",
        "ssh",
        "relay"
      ],
      "params": "ConfigSetReactionsEnabledParams",
      "result": "JsonValue",
      "scope": {
        "field": "threadId",
        "key": "config",
        "kind": "threadOrGlobal"
      }
    },
    {
      "class": "C2",
      "method": "config/setWebSearchEnabled",
      "mutation": {
        "domain": "config",
        "kind": "op"
      },
      "opScope": {
        "domain": "config",
        "field": "threadId",
        "kind": "threadOrDomain"
      },
      "origins": [
        "local",
        "ssh",
        "relay"
      ],
      "params": "ConfigSetWebSearchEnabledParams",
      "result": "JsonValue",
      "scope": {
        "field": "threadId",
        "key": "config",
        "kind": "threadOrGlobal"
      }
    },
    {
      "class": "C2",
      "method": "config/setMemoryToolsEnabled",
      "mutation": {
        "domain": "config",
        "kind": "op"
      },
      "opScope": {
        "domain": "config",
        "field": "threadId",
        "kind": "threadOrDomain"
      },
      "origins": [
        "local",
        "ssh",
        "relay"
      ],
      "params": "ConfigSetMemoryToolsEnabledParams",
      "result": "JsonValue",
      "scope": {
        "field": "threadId",
        "key": "config",
        "kind": "threadOrGlobal"
      }
    },
    {
      "class": "C2",
      "method": "config/setAutoClear",
      "mutation": {
        "domain": "config",
        "kind": "op"
      },
      "opScope": {
        "domain": "config",
        "field": "threadId",
        "kind": "threadOrDomain"
      },
      "origins": [
        "local",
        "ssh",
        "relay"
      ],
      "params": "ConfigSetAutoClearParams",
      "result": "JsonValue",
      "scope": {
        "field": "threadId",
        "key": "config",
        "kind": "threadOrGlobal"
      }
    },
    {
      "class": "C2",
      "method": "config/setCompactionSettings",
      "mutation": {
        "domain": "config",
        "kind": "op"
      },
      "opScope": {
        "domain": "config",
        "field": "threadId",
        "kind": "threadOrDomain"
      },
      "origins": [
        "local",
        "ssh",
        "relay"
      ],
      "params": "ConfigSetCompactionSettingsParams",
      "result": "JsonValue",
      "scope": {
        "field": "threadId",
        "key": "config",
        "kind": "threadOrGlobal"
      }
    },
    {
      "class": "C2",
      "method": "config/setDeveloperOption",
      "mutation": {
        "domain": "config",
        "kind": "op"
      },
      "opScope": {
        "domain": "config",
        "field": "threadId",
        "kind": "threadOrDomain"
      },
      "origins": [
        "local",
        "ssh",
        "relay"
      ],
      "params": "ConfigSetDeveloperOptionParams",
      "result": "JsonValue",
      "scope": {
        "field": "threadId",
        "key": "config",
        "kind": "threadOrGlobal"
      }
    },
    {
      "class": "C2",
      "method": "config/setProfile",
      "mutation": {
        "domain": "config",
        "kind": "op"
      },
      "opScope": {
        "domain": "config",
        "field": "threadId",
        "kind": "threadOrDomain"
      },
      "origins": [
        "local",
        "ssh",
        "relay"
      ],
      "params": "ConfigSetProfileParams",
      "result": "JsonValue",
      "scope": {
        "field": "threadId",
        "key": "config",
        "kind": "threadOrGlobal"
      }
    },
    {
      "class": "C2",
      "method": "config/setHeartbeatInterval",
      "mutation": {
        "domain": "config",
        "kind": "op"
      },
      "opScope": {
        "domain": "config",
        "field": "threadId",
        "kind": "threadOrDomain"
      },
      "origins": [
        "local",
        "ssh",
        "relay"
      ],
      "params": "ConfigSetHeartbeatIntervalParams",
      "result": "JsonValue",
      "scope": {
        "field": "threadId",
        "key": "config",
        "kind": "threadOrGlobal"
      }
    },
    {
      "class": "C2",
      "method": "config/setSystemShell",
      "mutation": {
        "domain": "config",
        "kind": "op"
      },
      "opScope": {
        "domain": "config",
        "field": "threadId",
        "kind": "threadOrDomain"
      },
      "origins": [
        "local",
        "ssh",
        "relay"
      ],
      "params": "ConfigSetSystemShellParams",
      "result": "JsonValue",
      "scope": {
        "field": "threadId",
        "key": "config",
        "kind": "threadOrGlobal"
      }
    },
    {
      "class": "C2",
      "method": "config/setTheme",
      "mutation": {
        "domain": "config",
        "kind": "op"
      },
      "opScope": {
        "domain": "config",
        "field": "threadId",
        "kind": "threadOrDomain"
      },
      "origins": [
        "local",
        "ssh",
        "relay"
      ],
      "params": "ConfigSetThemeParams",
      "result": "JsonValue",
      "scope": {
        "field": "threadId",
        "key": "config",
        "kind": "threadOrGlobal"
      }
    },
    {
      "class": "C2",
      "method": "config/setWebSearchRoute",
      "mutation": {
        "domain": "config",
        "kind": "op"
      },
      "opScope": {
        "domain": "config",
        "field": "threadId",
        "kind": "threadOrDomain"
      },
      "origins": [
        "local",
        "ssh",
        "relay"
      ],
      "params": "ConfigSetWebSearchRouteParams",
      "result": "JsonValue",
      "scope": {
        "field": "threadId",
        "key": "config",
        "kind": "threadOrGlobal"
      }
    },
    {
      "class": "C2",
      "method": "config/setAutoEffortBase",
      "mutation": {
        "domain": "config",
        "kind": "op"
      },
      "opScope": {
        "domain": "config",
        "field": "threadId",
        "kind": "threadOrDomain"
      },
      "origins": [
        "local",
        "ssh",
        "relay"
      ],
      "params": "ConfigSetAutoEffortBaseParams",
      "result": "JsonValue",
      "scope": {
        "field": "threadId",
        "key": "config",
        "kind": "threadOrGlobal"
      }
    },
    {
      "class": "C2",
      "method": "config/setBuiltinToolEnabled",
      "mutation": {
        "domain": "config",
        "kind": "op"
      },
      "opScope": {
        "domain": "config",
        "field": "threadId",
        "kind": "threadOrDomain"
      },
      "origins": [
        "local",
        "ssh",
        "relay"
      ],
      "params": "ConfigSetBuiltinToolEnabledParams",
      "result": "JsonValue",
      "scope": {
        "field": "threadId",
        "key": "config",
        "kind": "threadOrGlobal"
      }
    },
    {
      "class": "C2",
      "method": "config/installBuiltinFeature",
      "mutation": {
        "domain": "config",
        "kind": "op"
      },
      "opScope": {
        "domain": "config",
        "field": "threadId",
        "kind": "threadOrDomain"
      },
      "origins": [
        "local",
        "ssh",
        "relay"
      ],
      "params": "ConfigInstallBuiltinFeatureParams",
      "result": "JsonValue",
      "scope": {
        "field": "threadId",
        "key": "config",
        "kind": "threadOrGlobal"
      }
    },
    {
      "class": "C2",
      "method": "config/setWorktreeSettings",
      "mutation": {
        "domain": "config",
        "kind": "op"
      },
      "opScope": {
        "domain": "config",
        "field": "threadId",
        "kind": "threadOrDomain"
      },
      "origins": [
        "local",
        "ssh",
        "relay"
      ],
      "params": "ConfigSetWorktreeSettingsParams",
      "result": "JsonValue",
      "scope": {
        "field": "threadId",
        "key": "config",
        "kind": "threadOrGlobal"
      }
    },
    {
      "class": "C2",
      "method": "config/setNetworkProxy",
      "mutation": {
        "domain": "config",
        "kind": "op"
      },
      "opScope": {
        "domain": "config",
        "field": "threadId",
        "kind": "threadOrDomain"
      },
      "origins": [
        "local",
        "ssh",
        "relay"
      ],
      "params": "ConfigSetNetworkProxyParams",
      "result": "JsonValue",
      "scope": {
        "field": "threadId",
        "key": "config",
        "kind": "threadOrGlobal"
      }
    },
    {
      "class": "C2",
      "method": "config/saveWorkflowPack",
      "mutation": {
        "domain": "config",
        "kind": "op"
      },
      "opScope": {
        "domain": "config",
        "field": "threadId",
        "kind": "threadOrDomain"
      },
      "origins": [
        "local",
        "ssh",
        "relay"
      ],
      "params": "ConfigSaveWorkflowPackParams",
      "result": "JsonValue",
      "scope": {
        "field": "threadId",
        "key": "config",
        "kind": "threadOrGlobal"
      }
    },
    {
      "class": "C2",
      "method": "config/createWorkflow",
      "mutation": {
        "domain": "config",
        "kind": "op"
      },
      "opScope": {
        "domain": "config",
        "field": "threadId",
        "kind": "threadOrDomain"
      },
      "origins": [
        "local",
        "ssh",
        "relay"
      ],
      "params": "ConfigCreateWorkflowParams",
      "result": "JsonValue",
      "scope": {
        "field": "threadId",
        "key": "config",
        "kind": "threadOrGlobal"
      }
    },
    {
      "class": "C2",
      "method": "config/deleteWorkflow",
      "mutation": {
        "domain": "config",
        "kind": "op"
      },
      "opScope": {
        "domain": "config",
        "field": "threadId",
        "kind": "threadOrDomain"
      },
      "origins": [
        "local",
        "ssh",
        "relay"
      ],
      "params": "ConfigDeleteWorkflowParams",
      "result": "JsonValue",
      "scope": {
        "field": "threadId",
        "key": "config",
        "kind": "threadOrGlobal"
      }
    },
    {
      "class": "C2",
      "method": "config/setModelPreferences",
      "mutation": {
        "domain": "config",
        "kind": "op"
      },
      "opScope": {
        "domain": "config",
        "field": "threadId",
        "kind": "threadOrDomain"
      },
      "origins": [
        "local",
        "ssh",
        "relay"
      ],
      "params": "ConfigSetModelPreferencesParams",
      "result": "JsonValue",
      "scope": {
        "field": "threadId",
        "key": "config",
        "kind": "threadOrGlobal"
      }
    },
    {
      "class": "C2",
      "method": "config/skipOnboarding",
      "mutation": {
        "domain": "config",
        "kind": "op"
      },
      "opScope": {
        "domain": "config",
        "field": "threadId",
        "kind": "threadOrDomain"
      },
      "origins": [
        "local",
        "ssh",
        "relay"
      ],
      "params": "ConfigSkipOnboardingParams",
      "result": "JsonValue",
      "scope": {
        "field": "threadId",
        "key": "config",
        "kind": "threadOrGlobal"
      }
    },
    {
      "class": "C2",
      "method": "config/completeOnboarding",
      "mutation": {
        "domain": "config",
        "kind": "op"
      },
      "opScope": {
        "domain": "config",
        "field": "threadId",
        "kind": "threadOrDomain"
      },
      "origins": [
        "local",
        "ssh",
        "relay"
      ],
      "params": "ConfigCompleteOnboardingParams",
      "result": "JsonValue",
      "scope": {
        "field": "threadId",
        "key": "config",
        "kind": "threadOrGlobal"
      }
    },
    {
      "class": "C2",
      "method": "config/saveStarterGuideState",
      "mutation": {
        "domain": "config",
        "kind": "op"
      },
      "opScope": {
        "domain": "config",
        "field": "threadId",
        "kind": "threadOrDomain"
      },
      "origins": [
        "local",
        "ssh",
        "relay"
      ],
      "params": "ConfigSaveStarterGuideStateParams",
      "result": "JsonValue",
      "scope": {
        "field": "threadId",
        "key": "config",
        "kind": "threadOrGlobal"
      }
    },
    {
      "class": "C2",
      "method": "config/claimSetupRequest",
      "mutation": {
        "domain": "config",
        "kind": "op"
      },
      "opScope": {
        "domain": "config",
        "field": "threadId",
        "kind": "threadOrDomain"
      },
      "origins": [
        "local",
        "ssh",
        "relay"
      ],
      "params": "ConfigClaimSetupRequestParams",
      "result": "JsonValue",
      "scope": {
        "field": "threadId",
        "key": "config",
        "kind": "threadOrGlobal"
      }
    },
    {
      "class": "C2",
      "method": "config/completeSetupRequest",
      "mutation": {
        "domain": "config",
        "kind": "op"
      },
      "opScope": {
        "domain": "config",
        "field": "threadId",
        "kind": "threadOrDomain"
      },
      "origins": [
        "local",
        "ssh",
        "relay"
      ],
      "params": "ConfigCompleteSetupRequestParams",
      "result": "JsonValue",
      "scope": {
        "field": "threadId",
        "key": "config",
        "kind": "threadOrGlobal"
      }
    },
    {
      "class": "C2",
      "method": "config/setExtensionScope",
      "mutation": {
        "domain": "config",
        "kind": "op"
      },
      "opScope": {
        "domain": "config",
        "field": "threadId",
        "kind": "threadOrDomain"
      },
      "origins": [
        "local",
        "ssh",
        "relay"
      ],
      "params": "ConfigSetExtensionScopeParams",
      "result": "JsonValue",
      "scope": {
        "field": "threadId",
        "key": "config",
        "kind": "threadOrGlobal"
      }
    },
    {
      "class": "C1",
      "method": "config/read",
      "mutation": {
        "kind": "none"
      },
      "opScope": {
        "kind": "none"
      },
      "origins": [
        "local",
        "ssh"
      ],
      "params": "v2::config::ConfigReadParams",
      "result": "v2::config::ConfigReadResponse",
      "scope": {
        "key": "config",
        "kind": "sharedRead"
      }
    },
    {
      "class": "C2",
      "method": "config/value/write",
      "mutation": {
        "domain": "config",
        "kind": "op"
      },
      "opScope": {
        "domain": "config",
        "kind": "domain"
      },
      "origins": [
        "local",
        "ssh",
        "relay"
      ],
      "params": "v2::config::ConfigValueWriteParams",
      "result": "v2::config::ConfigWriteResponse",
      "scope": {
        "key": "config",
        "kind": "global"
      }
    },
    {
      "class": "C2",
      "method": "config/batchWrite",
      "mutation": {
        "domain": "config",
        "kind": "op"
      },
      "opScope": {
        "domain": "config",
        "kind": "domain"
      },
      "origins": [
        "local",
        "ssh"
      ],
      "params": "v2::config::ConfigBatchWriteParams",
      "result": "v2::config::ConfigWriteResponse",
      "scope": {
        "key": "config",
        "kind": "global"
      }
    },
    {
      "class": "C1",
      "method": "channel/getChannelSettings",
      "mutation": {
        "kind": "none"
      },
      "opScope": {
        "kind": "none"
      },
      "origins": [
        "local",
        "ssh"
      ],
      "params": "ChannelGetChannelSettingsParams",
      "result": "JsonValue",
      "scope": {
        "kind": "none"
      }
    },
    {
      "class": "C1",
      "method": "channel/getChannelSetup",
      "mutation": {
        "kind": "none"
      },
      "opScope": {
        "kind": "none"
      },
      "origins": [
        "local",
        "ssh",
        "relay"
      ],
      "params": "ChannelGetChannelSetupParams",
      "result": "JsonValue",
      "scope": {
        "kind": "none"
      }
    },
    {
      "class": "C1",
      "method": "channel/getChannelWorkerStatus",
      "mutation": {
        "kind": "none"
      },
      "opScope": {
        "kind": "none"
      },
      "origins": [
        "local",
        "ssh"
      ],
      "params": "ChannelGetChannelWorkerStatusParams",
      "result": "JsonValue",
      "scope": {
        "kind": "none"
      }
    },
    {
      "class": "C2",
      "method": "channel/setWebhookConfig",
      "mutation": {
        "domain": "channel",
        "kind": "op"
      },
      "opScope": {
        "domain": "channel",
        "field": "threadId",
        "kind": "threadOrDomain"
      },
      "origins": [
        "local",
        "ssh",
        "relay"
      ],
      "params": "ChannelSetWebhookConfigParams",
      "result": "JsonValue",
      "scope": {
        "field": "threadId",
        "kind": "threadOrNone"
      }
    },
    {
      "class": "C2",
      "method": "channel/saveSchedule",
      "mutation": {
        "domain": "channel",
        "kind": "op"
      },
      "opScope": {
        "domain": "channel",
        "field": "threadId",
        "kind": "threadOrDomain"
      },
      "origins": [
        "local",
        "ssh",
        "relay"
      ],
      "params": "ChannelSaveScheduleParams",
      "result": "JsonValue",
      "scope": {
        "field": "threadId",
        "kind": "threadOrNone"
      }
    },
    {
      "class": "C2",
      "method": "channel/deleteSchedule",
      "mutation": {
        "domain": "channel",
        "kind": "op"
      },
      "opScope": {
        "domain": "channel",
        "field": "threadId",
        "kind": "threadOrDomain"
      },
      "origins": [
        "local",
        "ssh",
        "relay"
      ],
      "params": "ChannelDeleteScheduleParams",
      "result": "JsonValue",
      "scope": {
        "field": "threadId",
        "kind": "threadOrNone"
      }
    },
    {
      "class": "C2",
      "method": "channel/setScheduleEnabled",
      "mutation": {
        "domain": "channel",
        "kind": "op"
      },
      "opScope": {
        "domain": "channel",
        "field": "threadId",
        "kind": "threadOrDomain"
      },
      "origins": [
        "local",
        "ssh",
        "relay"
      ],
      "params": "ChannelSetScheduleEnabledParams",
      "result": "JsonValue",
      "scope": {
        "field": "threadId",
        "kind": "threadOrNone"
      }
    },
    {
      "class": "C2",
      "method": "channel/runScheduleNow",
      "mutation": {
        "domain": "channel",
        "kind": "op"
      },
      "opScope": {
        "domain": "channel",
        "field": "threadId",
        "kind": "threadOrDomain"
      },
      "origins": [
        "local",
        "ssh",
        "relay"
      ],
      "params": "ChannelRunScheduleNowParams",
      "result": "JsonValue",
      "scope": {
        "field": "threadId",
        "kind": "threadOrNone"
      }
    },
    {
      "class": "C2",
      "method": "channel/runWebhookNow",
      "mutation": {
        "domain": "channel",
        "kind": "op"
      },
      "opScope": {
        "domain": "channel",
        "field": "threadId",
        "kind": "threadOrDomain"
      },
      "origins": [
        "local",
        "ssh",
        "relay"
      ],
      "params": "ChannelRunWebhookNowParams",
      "result": "JsonValue",
      "scope": {
        "field": "threadId",
        "kind": "threadOrNone"
      }
    },
    {
      "class": "C2",
      "method": "channel/retryRoutineDelivery",
      "mutation": {
        "domain": "channel",
        "kind": "op"
      },
      "opScope": {
        "domain": "channel",
        "field": "threadId",
        "kind": "threadOrDomain"
      },
      "origins": [
        "local",
        "ssh",
        "relay"
      ],
      "params": "ChannelRetryRoutineDeliveryParams",
      "result": "JsonValue",
      "scope": {
        "field": "threadId",
        "kind": "threadOrNone"
      }
    },
    {
      "class": "C2",
      "method": "channel/testWebhook",
      "mutation": {
        "domain": "channel",
        "kind": "op"
      },
      "opScope": {
        "domain": "channel",
        "field": "threadId",
        "kind": "threadOrDomain"
      },
      "origins": [
        "local",
        "ssh",
        "relay"
      ],
      "params": "ChannelTestWebhookParams",
      "result": "JsonValue",
      "scope": {
        "field": "threadId",
        "kind": "threadOrNone"
      }
    },
    {
      "class": "C2",
      "method": "channel/saveWebhook",
      "mutation": {
        "domain": "channel",
        "kind": "op"
      },
      "opScope": {
        "domain": "channel",
        "field": "threadId",
        "kind": "threadOrDomain"
      },
      "origins": [
        "local",
        "ssh",
        "relay"
      ],
      "params": "ChannelSaveWebhookParams",
      "result": "JsonValue",
      "scope": {
        "field": "threadId",
        "kind": "threadOrNone"
      }
    },
    {
      "class": "C2",
      "method": "channel/deleteWebhook",
      "mutation": {
        "domain": "channel",
        "kind": "op"
      },
      "opScope": {
        "domain": "channel",
        "field": "threadId",
        "kind": "threadOrDomain"
      },
      "origins": [
        "local",
        "ssh",
        "relay"
      ],
      "params": "ChannelDeleteWebhookParams",
      "result": "JsonValue",
      "scope": {
        "field": "threadId",
        "kind": "threadOrNone"
      }
    },
    {
      "class": "C2",
      "method": "channel/setWebhookEnabled",
      "mutation": {
        "domain": "channel",
        "kind": "op"
      },
      "opScope": {
        "domain": "channel",
        "field": "threadId",
        "kind": "threadOrDomain"
      },
      "origins": [
        "local",
        "ssh",
        "relay"
      ],
      "params": "ChannelSetWebhookEnabledParams",
      "result": "JsonValue",
      "scope": {
        "field": "threadId",
        "kind": "threadOrNone"
      }
    },
    {
      "class": "C1",
      "method": "import/getConversationImportJobs",
      "mutation": {
        "kind": "none"
      },
      "opScope": {
        "kind": "none"
      },
      "origins": [
        "local",
        "ssh"
      ],
      "params": "ImportGetConversationImportJobsParams",
      "result": "JsonValue",
      "scope": {
        "kind": "none"
      }
    },
    {
      "class": "C1",
      "method": "import/listImportableConversations",
      "mutation": {
        "kind": "none"
      },
      "opScope": {
        "kind": "none"
      },
      "origins": [
        "local",
        "ssh"
      ],
      "params": "ImportListImportableConversationsParams",
      "result": "JsonValue",
      "scope": {
        "kind": "none"
      }
    },
    {
      "class": "C2",
      "method": "import/startConversationImport",
      "mutation": {
        "domain": "import",
        "kind": "op"
      },
      "opScope": {
        "domain": "import",
        "field": "threadId",
        "kind": "threadOrDomain"
      },
      "origins": [
        "local",
        "ssh"
      ],
      "params": "ImportStartConversationImportParams",
      "result": "JsonValue",
      "scope": {
        "field": "threadId",
        "kind": "threadOrNone"
      }
    },
    {
      "class": "C2",
      "method": "import/cancelConversationImport",
      "mutation": {
        "domain": "import",
        "kind": "op"
      },
      "opScope": {
        "domain": "import",
        "field": "threadId",
        "kind": "threadOrDomain"
      },
      "origins": [
        "local",
        "ssh"
      ],
      "params": "ImportCancelConversationImportParams",
      "result": "JsonValue",
      "scope": {
        "field": "threadId",
        "kind": "threadOrNone"
      }
    },
    {
      "class": "C2",
      "method": "import/registerConversationImportFile",
      "mutation": {
        "domain": "import",
        "kind": "op"
      },
      "opScope": {
        "domain": "import",
        "field": "threadId",
        "kind": "threadOrDomain"
      },
      "origins": [
        "local",
        "ssh"
      ],
      "params": "ImportRegisterConversationImportFileParams",
      "result": "JsonValue",
      "scope": {
        "field": "threadId",
        "kind": "threadOrNone"
      }
    },
    {
      "class": "C1",
      "method": "media/getMediaDefault",
      "mutation": {
        "kind": "none"
      },
      "opScope": {
        "kind": "none"
      },
      "origins": [
        "local",
        "ssh",
        "relay"
      ],
      "params": "MediaGetMediaDefaultParams",
      "result": "JsonValue",
      "scope": {
        "kind": "none"
      }
    },
    {
      "class": "C1",
      "method": "media/getMediaJob",
      "mutation": {
        "kind": "none"
      },
      "opScope": {
        "kind": "none"
      },
      "origins": [
        "local",
        "ssh",
        "relay"
      ],
      "params": "MediaGetMediaJobParams",
      "result": "JsonValue",
      "scope": {
        "kind": "none"
      }
    },
    {
      "class": "C1",
      "method": "media/getMediaPins",
      "mutation": {
        "kind": "none"
      },
      "opScope": {
        "kind": "none"
      },
      "origins": [
        "local",
        "ssh",
        "relay"
      ],
      "params": "MediaGetMediaPinsParams",
      "result": "JsonValue",
      "scope": {
        "kind": "none"
      }
    },
    {
      "class": "C1",
      "method": "media/listMediaAssets",
      "mutation": {
        "kind": "none"
      },
      "opScope": {
        "kind": "none"
      },
      "origins": [
        "local",
        "ssh",
        "relay"
      ],
      "params": "MediaListMediaAssetsParams",
      "result": "JsonValue",
      "scope": {
        "kind": "none"
      }
    },
    {
      "class": "C1",
      "method": "media/listMediaBoards",
      "mutation": {
        "kind": "none"
      },
      "opScope": {
        "kind": "none"
      },
      "origins": [
        "local",
        "ssh",
        "relay"
      ],
      "params": "MediaListMediaBoardsParams",
      "result": "JsonValue",
      "scope": {
        "kind": "none"
      }
    },
    {
      "class": "C1",
      "method": "media/listMediaLanes",
      "mutation": {
        "kind": "none"
      },
      "opScope": {
        "kind": "none"
      },
      "origins": [
        "local",
        "ssh",
        "relay"
      ],
      "params": "MediaListMediaLanesParams",
      "result": "JsonValue",
      "scope": {
        "kind": "none"
      }
    },
    {
      "class": "C1",
      "method": "media/readMediaAsset",
      "mutation": {
        "kind": "none"
      },
      "opScope": {
        "kind": "none"
      },
      "origins": [
        "local",
        "ssh",
        "relay"
      ],
      "params": "MediaReadMediaAssetParams",
      "result": "JsonValue",
      "scope": {
        "kind": "none"
      }
    },
    {
      "class": "C1",
      "method": "media/resolveMediaFile",
      "mutation": {
        "kind": "none"
      },
      "opScope": {
        "kind": "none"
      },
      "origins": [
        "local",
        "ssh"
      ],
      "params": "MediaResolveMediaFileParams",
      "result": "JsonValue",
      "scope": {
        "kind": "none"
      }
    },
    {
      "class": "C2",
      "method": "media/startMediaJob",
      "mutation": {
        "domain": "media",
        "kind": "op"
      },
      "opScope": {
        "domain": "media",
        "field": "threadId",
        "kind": "threadOrDomain"
      },
      "origins": [
        "local",
        "ssh",
        "relay"
      ],
      "params": "MediaStartMediaJobParams",
      "result": "JsonValue",
      "scope": {
        "field": "threadId",
        "kind": "threadOrNone"
      }
    },
    {
      "class": "C2",
      "method": "media/cancelMediaJob",
      "mutation": {
        "domain": "media",
        "kind": "op"
      },
      "opScope": {
        "domain": "media",
        "field": "threadId",
        "kind": "threadOrDomain"
      },
      "origins": [
        "local",
        "ssh",
        "relay"
      ],
      "params": "MediaCancelMediaJobParams",
      "result": "JsonValue",
      "scope": {
        "field": "threadId",
        "kind": "threadOrNone"
      }
    },
    {
      "class": "C2",
      "method": "media/deleteMediaAsset",
      "mutation": {
        "domain": "media",
        "kind": "op"
      },
      "opScope": {
        "domain": "media",
        "field": "threadId",
        "kind": "threadOrDomain"
      },
      "origins": [
        "local",
        "ssh",
        "relay"
      ],
      "params": "MediaDeleteMediaAssetParams",
      "result": "JsonValue",
      "scope": {
        "field": "threadId",
        "kind": "threadOrNone"
      }
    },
    {
      "class": "C2",
      "method": "media/deleteMediaAssets",
      "mutation": {
        "domain": "media",
        "kind": "op"
      },
      "opScope": {
        "domain": "media",
        "field": "threadId",
        "kind": "threadOrDomain"
      },
      "origins": [
        "local",
        "ssh",
        "relay"
      ],
      "params": "MediaDeleteMediaAssetsParams",
      "result": "JsonValue",
      "scope": {
        "field": "threadId",
        "kind": "threadOrNone"
      }
    },
    {
      "class": "C2",
      "method": "media/createMediaBoard",
      "mutation": {
        "domain": "media",
        "kind": "op"
      },
      "opScope": {
        "domain": "media",
        "field": "threadId",
        "kind": "threadOrDomain"
      },
      "origins": [
        "local",
        "ssh",
        "relay"
      ],
      "params": "MediaCreateMediaBoardParams",
      "result": "JsonValue",
      "scope": {
        "field": "threadId",
        "kind": "threadOrNone"
      }
    },
    {
      "class": "C2",
      "method": "media/renameMediaBoard",
      "mutation": {
        "domain": "media",
        "kind": "op"
      },
      "opScope": {
        "domain": "media",
        "field": "threadId",
        "kind": "threadOrDomain"
      },
      "origins": [
        "local",
        "ssh",
        "relay"
      ],
      "params": "MediaRenameMediaBoardParams",
      "result": "JsonValue",
      "scope": {
        "field": "threadId",
        "kind": "threadOrNone"
      }
    },
    {
      "class": "C2",
      "method": "media/deleteMediaBoard",
      "mutation": {
        "domain": "media",
        "kind": "op"
      },
      "opScope": {
        "domain": "media",
        "field": "threadId",
        "kind": "threadOrDomain"
      },
      "origins": [
        "local",
        "ssh",
        "relay"
      ],
      "params": "MediaDeleteMediaBoardParams",
      "result": "JsonValue",
      "scope": {
        "field": "threadId",
        "kind": "threadOrNone"
      }
    },
    {
      "class": "C2",
      "method": "media/setMediaAssetBoard",
      "mutation": {
        "domain": "media",
        "kind": "op"
      },
      "opScope": {
        "domain": "media",
        "field": "threadId",
        "kind": "threadOrDomain"
      },
      "origins": [
        "local",
        "ssh",
        "relay"
      ],
      "params": "MediaSetMediaAssetBoardParams",
      "result": "JsonValue",
      "scope": {
        "field": "threadId",
        "kind": "threadOrNone"
      }
    },
    {
      "class": "C2",
      "method": "media/setMediaDefault",
      "mutation": {
        "domain": "media",
        "kind": "op"
      },
      "opScope": {
        "domain": "media",
        "field": "threadId",
        "kind": "threadOrDomain"
      },
      "origins": [
        "local",
        "ssh",
        "relay"
      ],
      "params": "MediaSetMediaDefaultParams",
      "result": "JsonValue",
      "scope": {
        "field": "threadId",
        "kind": "threadOrNone"
      }
    },
    {
      "class": "C2",
      "method": "media/setMediaPin",
      "mutation": {
        "domain": "media",
        "kind": "op"
      },
      "opScope": {
        "domain": "media",
        "field": "threadId",
        "kind": "threadOrDomain"
      },
      "origins": [
        "local",
        "ssh",
        "relay"
      ],
      "params": "MediaSetMediaPinParams",
      "result": "JsonValue",
      "scope": {
        "field": "threadId",
        "kind": "threadOrNone"
      }
    },
    {
      "class": "C2",
      "method": "media/cacheMediaThumbnail",
      "mutation": {
        "domain": "media",
        "kind": "op"
      },
      "opScope": {
        "domain": "media",
        "field": "threadId",
        "kind": "threadOrDomain"
      },
      "origins": [
        "local",
        "ssh",
        "relay"
      ],
      "params": "MediaCacheMediaThumbnailParams",
      "result": "JsonValue",
      "scope": {
        "field": "threadId",
        "kind": "threadOrNone"
      }
    },
    {
      "class": "C2",
      "method": "media/openMediaAsset",
      "mutation": {
        "domain": "media",
        "kind": "op"
      },
      "opScope": {
        "domain": "media",
        "field": "threadId",
        "kind": "threadOrDomain"
      },
      "origins": [
        "local",
        "ssh",
        "relay"
      ],
      "params": "MediaOpenMediaAssetParams",
      "result": "JsonValue",
      "scope": {
        "field": "threadId",
        "kind": "threadOrNone"
      }
    },
    {
      "class": "C2",
      "method": "media/openMediaFolder",
      "mutation": {
        "domain": "media",
        "kind": "op"
      },
      "opScope": {
        "domain": "media",
        "field": "threadId",
        "kind": "threadOrDomain"
      },
      "origins": [
        "local",
        "ssh",
        "relay"
      ],
      "params": "MediaOpenMediaFolderParams",
      "result": "JsonValue",
      "scope": {
        "field": "threadId",
        "kind": "threadOrNone"
      }
    },
    {
      "class": "C1",
      "method": "mcp/getMcpServerConfig",
      "mutation": {
        "kind": "none"
      },
      "opScope": {
        "kind": "none"
      },
      "origins": [
        "local",
        "ssh",
        "relay"
      ],
      "params": "McpGetMcpServerConfigParams",
      "result": "JsonValue",
      "scope": {
        "kind": "none"
      }
    },
    {
      "class": "C1",
      "method": "mcp/getMcpOAuthLoginStatus",
      "mutation": {
        "kind": "none"
      },
      "opScope": {
        "kind": "none"
      },
      "origins": [
        "local",
        "ssh",
        "relay"
      ],
      "params": "McpGetMcpOAuthLoginStatusParams",
      "result": "JsonValue",
      "scope": {
        "kind": "none"
      }
    },
    {
      "class": "C1",
      "method": "mcp/mcpStatus",
      "mutation": {
        "kind": "none"
      },
      "opScope": {
        "kind": "none"
      },
      "origins": [
        "local",
        "ssh",
        "relay"
      ],
      "params": "McpMcpStatusParams",
      "result": "JsonValue",
      "scope": {
        "kind": "none"
      }
    },
    {
      "class": "C2",
      "method": "mcp/addMcpServer",
      "mutation": {
        "domain": "mcp",
        "kind": "op"
      },
      "opScope": {
        "domain": "mcp",
        "field": "threadId",
        "kind": "threadOrDomain"
      },
      "origins": [
        "local",
        "ssh",
        "relay"
      ],
      "params": "McpAddMcpServerParams",
      "result": "JsonValue",
      "scope": {
        "field": "threadId",
        "kind": "threadOrNone"
      }
    },
    {
      "class": "C2",
      "method": "mcp/saveMcpServer",
      "mutation": {
        "domain": "mcp",
        "kind": "op"
      },
      "opScope": {
        "domain": "mcp",
        "field": "threadId",
        "kind": "threadOrDomain"
      },
      "origins": [
        "local",
        "ssh",
        "relay"
      ],
      "params": "McpSaveMcpServerParams",
      "result": "JsonValue",
      "scope": {
        "field": "threadId",
        "kind": "threadOrNone"
      }
    },
    {
      "class": "C2",
      "method": "mcp/removeMcpServer",
      "mutation": {
        "domain": "mcp",
        "kind": "op"
      },
      "opScope": {
        "domain": "mcp",
        "field": "threadId",
        "kind": "threadOrDomain"
      },
      "origins": [
        "local",
        "ssh",
        "relay"
      ],
      "params": "McpRemoveMcpServerParams",
      "result": "JsonValue",
      "scope": {
        "field": "threadId",
        "kind": "threadOrNone"
      }
    },
    {
      "class": "C2",
      "method": "mcp/setMcpServerEnabled",
      "mutation": {
        "domain": "mcp",
        "kind": "op"
      },
      "opScope": {
        "domain": "mcp",
        "field": "threadId",
        "kind": "threadOrDomain"
      },
      "origins": [
        "local",
        "ssh",
        "relay"
      ],
      "params": "McpSetMcpServerEnabledParams",
      "result": "JsonValue",
      "scope": {
        "field": "threadId",
        "kind": "threadOrNone"
      }
    },
    {
      "class": "C2",
      "method": "mcp/reconnectMcp",
      "mutation": {
        "domain": "mcp",
        "kind": "op"
      },
      "opScope": {
        "domain": "mcp",
        "field": "threadId",
        "kind": "threadOrDomain"
      },
      "origins": [
        "local",
        "ssh",
        "relay"
      ],
      "params": "McpReconnectMcpParams",
      "result": "JsonValue",
      "scope": {
        "field": "threadId",
        "kind": "threadOrNone"
      }
    },
    {
      "class": "C2",
      "method": "mcp/beginMcpOAuthLogin",
      "mutation": {
        "domain": "mcp",
        "kind": "op"
      },
      "opScope": {
        "domain": "mcp",
        "field": "threadId",
        "kind": "threadOrDomain"
      },
      "origins": [
        "local",
        "ssh",
        "relay"
      ],
      "params": "McpBeginMcpOAuthLoginParams",
      "result": "JsonValue",
      "scope": {
        "field": "threadId",
        "kind": "threadOrNone"
      }
    },
    {
      "class": "C2",
      "method": "mcp/cancelMcpOAuthLogin",
      "mutation": {
        "domain": "mcp",
        "kind": "op"
      },
      "opScope": {
        "domain": "mcp",
        "field": "threadId",
        "kind": "threadOrDomain"
      },
      "origins": [
        "local",
        "ssh",
        "relay"
      ],
      "params": "McpCancelMcpOAuthLoginParams",
      "result": "JsonValue",
      "scope": {
        "field": "threadId",
        "kind": "threadOrNone"
      }
    },
    {
      "class": "C2",
      "method": "mcp/completeMcpOAuthLogin",
      "mutation": {
        "domain": "mcp",
        "kind": "op"
      },
      "opScope": {
        "domain": "mcp",
        "field": "threadId",
        "kind": "threadOrDomain"
      },
      "origins": [
        "local",
        "ssh",
        "relay"
      ],
      "params": "McpCompleteMcpOAuthLoginParams",
      "result": "JsonValue",
      "scope": {
        "field": "threadId",
        "kind": "threadOrNone"
      }
    },
    {
      "class": "C2",
      "method": "mcp/signOutMcpServer",
      "mutation": {
        "domain": "mcp",
        "kind": "op"
      },
      "opScope": {
        "domain": "mcp",
        "field": "threadId",
        "kind": "threadOrDomain"
      },
      "origins": [
        "local",
        "ssh",
        "relay"
      ],
      "params": "McpSignOutMcpServerParams",
      "result": "JsonValue",
      "scope": {
        "field": "threadId",
        "kind": "threadOrNone"
      }
    },
    {
      "class": "C2",
      "method": "mcp/probeMcpServerAuth",
      "mutation": {
        "domain": "mcp",
        "kind": "op"
      },
      "opScope": {
        "domain": "mcp",
        "field": "threadId",
        "kind": "threadOrDomain"
      },
      "origins": [
        "local",
        "ssh",
        "relay"
      ],
      "params": "McpProbeMcpServerAuthParams",
      "result": "JsonValue",
      "scope": {
        "field": "threadId",
        "kind": "threadOrNone"
      }
    },
    {
      "class": "C2",
      "method": "mcp/enablePluginMcp",
      "mutation": {
        "domain": "mcp",
        "kind": "op"
      },
      "opScope": {
        "domain": "mcp",
        "field": "threadId",
        "kind": "threadOrDomain"
      },
      "origins": [
        "local",
        "ssh",
        "relay"
      ],
      "params": "McpEnablePluginMcpParams",
      "result": "JsonValue",
      "scope": {
        "field": "threadId",
        "kind": "threadOrNone"
      }
    },
    {
      "class": "C1",
      "method": "account/getOAuthProviderLoginStatus",
      "mutation": {
        "kind": "none"
      },
      "opScope": {
        "kind": "none"
      },
      "origins": [
        "local",
        "ssh",
        "relay"
      ],
      "params": "AccountGetOAuthProviderLoginStatusParams",
      "result": "JsonValue",
      "scope": {
        "kind": "none"
      }
    },
    {
      "class": "C1",
      "method": "account/listWebSearchModels",
      "mutation": {
        "kind": "none"
      },
      "opScope": {
        "kind": "none"
      },
      "origins": [
        "local",
        "ssh",
        "relay"
      ],
      "params": "AccountListWebSearchModelsParams",
      "result": "JsonValue",
      "scope": {
        "kind": "none"
      }
    },
    {
      "class": "C1",
      "method": "account/getQuotaHistory",
      "mutation": {
        "kind": "none"
      },
      "opScope": {
        "kind": "none"
      },
      "origins": [
        "local",
        "ssh",
        "relay"
      ],
      "params": "AccountGetQuotaHistoryParams",
      "result": "JsonValue",
      "scope": {
        "kind": "none"
      }
    },
    {
      "class": "C2",
      "method": "account/authenticateProvider",
      "mutation": {
        "domain": "account",
        "kind": "op"
      },
      "opScope": {
        "domain": "account",
        "field": "threadId",
        "kind": "threadOrDomain"
      },
      "origins": [
        "local",
        "ssh",
        "relay"
      ],
      "params": "AccountAuthenticateProviderParams",
      "result": "JsonValue",
      "scope": {
        "field": "threadId",
        "kind": "threadOrNone"
      }
    },
    {
      "class": "C2",
      "method": "account/beginOAuthProviderLogin",
      "mutation": {
        "domain": "account",
        "kind": "op"
      },
      "opScope": {
        "domain": "account",
        "field": "threadId",
        "kind": "threadOrDomain"
      },
      "origins": [
        "local",
        "ssh",
        "relay"
      ],
      "params": "AccountBeginOAuthProviderLoginParams",
      "result": "JsonValue",
      "scope": {
        "field": "threadId",
        "kind": "threadOrNone"
      }
    },
    {
      "class": "C2",
      "method": "account/completeOAuthProviderLogin",
      "mutation": {
        "domain": "account",
        "kind": "op"
      },
      "opScope": {
        "domain": "account",
        "field": "threadId",
        "kind": "threadOrDomain"
      },
      "origins": [
        "local",
        "ssh",
        "relay"
      ],
      "params": "AccountCompleteOAuthProviderLoginParams",
      "result": "JsonValue",
      "scope": {
        "field": "threadId",
        "kind": "threadOrNone"
      }
    },
    {
      "class": "C2",
      "method": "account/cancelOAuthProviderLogin",
      "mutation": {
        "domain": "account",
        "kind": "op"
      },
      "opScope": {
        "domain": "account",
        "field": "threadId",
        "kind": "threadOrDomain"
      },
      "origins": [
        "local",
        "ssh",
        "relay"
      ],
      "params": "AccountCancelOAuthProviderLoginParams",
      "result": "JsonValue",
      "scope": {
        "field": "threadId",
        "kind": "threadOrNone"
      }
    },
    {
      "class": "C2",
      "method": "account/loginOAuthProvider",
      "mutation": {
        "domain": "account",
        "kind": "op"
      },
      "opScope": {
        "domain": "account",
        "field": "threadId",
        "kind": "threadOrDomain"
      },
      "origins": [
        "local",
        "ssh",
        "relay"
      ],
      "params": "AccountLoginOAuthProviderParams",
      "result": "JsonValue",
      "scope": {
        "field": "threadId",
        "kind": "threadOrNone"
      }
    },
    {
      "class": "C2",
      "method": "account/forgetProviderAuth",
      "mutation": {
        "domain": "account",
        "kind": "op"
      },
      "opScope": {
        "domain": "account",
        "field": "threadId",
        "kind": "threadOrDomain"
      },
      "origins": [
        "local",
        "ssh",
        "relay"
      ],
      "params": "AccountForgetProviderAuthParams",
      "result": "JsonValue",
      "scope": {
        "field": "threadId",
        "kind": "threadOrNone"
      }
    },
    {
      "class": "C2",
      "method": "account/updateProviderAccounts",
      "mutation": {
        "domain": "account",
        "kind": "op"
      },
      "opScope": {
        "domain": "account",
        "field": "threadId",
        "kind": "threadOrDomain"
      },
      "origins": [
        "local",
        "ssh",
        "relay"
      ],
      "params": "AccountUpdateProviderAccountsParams",
      "result": "JsonValue",
      "scope": {
        "field": "threadId",
        "kind": "threadOrNone"
      }
    },
    {
      "class": "C2",
      "method": "account/saveProviderApiKey",
      "mutation": {
        "domain": "account",
        "kind": "op"
      },
      "opScope": {
        "domain": "account",
        "field": "threadId",
        "kind": "threadOrDomain"
      },
      "origins": [
        "local",
        "ssh",
        "relay"
      ],
      "params": "AccountSaveProviderApiKeyParams",
      "result": "JsonValue",
      "scope": {
        "field": "threadId",
        "kind": "threadOrNone"
      }
    },
    {
      "class": "C2",
      "method": "account/saveCustomProvider",
      "mutation": {
        "domain": "account",
        "kind": "op"
      },
      "opScope": {
        "domain": "account",
        "field": "threadId",
        "kind": "threadOrDomain"
      },
      "origins": [
        "local",
        "ssh",
        "relay"
      ],
      "params": "AccountSaveCustomProviderParams",
      "result": "JsonValue",
      "scope": {
        "field": "threadId",
        "kind": "threadOrNone"
      }
    },
    {
      "class": "C2",
      "method": "account/saveCustomProviderKey",
      "mutation": {
        "domain": "account",
        "kind": "op"
      },
      "opScope": {
        "domain": "account",
        "field": "threadId",
        "kind": "threadOrDomain"
      },
      "origins": [
        "local",
        "ssh",
        "relay"
      ],
      "params": "AccountSaveCustomProviderKeyParams",
      "result": "JsonValue",
      "scope": {
        "field": "threadId",
        "kind": "threadOrNone"
      }
    },
    {
      "class": "C2",
      "method": "account/removeCustomProvider",
      "mutation": {
        "domain": "account",
        "kind": "op"
      },
      "opScope": {
        "domain": "account",
        "field": "threadId",
        "kind": "threadOrDomain"
      },
      "origins": [
        "local",
        "ssh",
        "relay"
      ],
      "params": "AccountRemoveCustomProviderParams",
      "result": "JsonValue",
      "scope": {
        "field": "threadId",
        "kind": "threadOrNone"
      }
    },
    {
      "class": "C2",
      "method": "account/updateCustomProviderModel",
      "mutation": {
        "domain": "account",
        "kind": "op"
      },
      "opScope": {
        "domain": "account",
        "field": "threadId",
        "kind": "threadOrDomain"
      },
      "origins": [
        "local",
        "ssh",
        "relay"
      ],
      "params": "AccountUpdateCustomProviderModelParams",
      "result": "JsonValue",
      "scope": {
        "field": "threadId",
        "kind": "threadOrNone"
      }
    },
    {
      "class": "C2",
      "method": "account/testCustomProvider",
      "mutation": {
        "domain": "account",
        "kind": "op"
      },
      "opScope": {
        "domain": "account",
        "field": "threadId",
        "kind": "threadOrDomain"
      },
      "origins": [
        "local",
        "ssh",
        "relay"
      ],
      "params": "AccountTestCustomProviderParams",
      "result": "JsonValue",
      "scope": {
        "field": "threadId",
        "kind": "threadOrNone"
      }
    },
    {
      "class": "C2",
      "method": "account/checkCustomProviderKeyEnv",
      "mutation": {
        "domain": "account",
        "kind": "op"
      },
      "opScope": {
        "domain": "account",
        "field": "threadId",
        "kind": "threadOrDomain"
      },
      "origins": [
        "local",
        "ssh",
        "relay"
      ],
      "params": "AccountCheckCustomProviderKeyEnvParams",
      "result": "JsonValue",
      "scope": {
        "field": "threadId",
        "kind": "threadOrNone"
      }
    },
    {
      "class": "C2",
      "method": "account/discoverCustomProviderModels",
      "mutation": {
        "domain": "account",
        "kind": "op"
      },
      "opScope": {
        "domain": "account",
        "field": "threadId",
        "kind": "threadOrDomain"
      },
      "origins": [
        "local",
        "ssh",
        "relay"
      ],
      "params": "AccountDiscoverCustomProviderModelsParams",
      "result": "JsonValue",
      "scope": {
        "field": "threadId",
        "kind": "threadOrNone"
      }
    },
    {
      "class": "C2",
      "method": "account/saveOpenAIUsageSessionKey",
      "mutation": {
        "domain": "account",
        "kind": "op"
      },
      "opScope": {
        "domain": "account",
        "field": "threadId",
        "kind": "threadOrDomain"
      },
      "origins": [
        "local",
        "ssh",
        "relay"
      ],
      "params": "AccountSaveOpenAIUsageSessionKeyParams",
      "result": "JsonValue",
      "scope": {
        "field": "threadId",
        "kind": "threadOrNone"
      }
    },
    {
      "class": "C2",
      "method": "account/consumeCodexRateLimitResetCredit",
      "mutation": {
        "domain": "account",
        "kind": "op"
      },
      "opScope": {
        "domain": "account",
        "field": "threadId",
        "kind": "threadOrDomain"
      },
      "origins": [
        "local",
        "ssh",
        "relay"
      ],
      "params": "AccountConsumeCodexRateLimitResetCreditParams",
      "result": "JsonValue",
      "scope": {
        "field": "threadId",
        "kind": "threadOrNone"
      }
    },
    {
      "class": "C2",
      "method": "account/refreshProviderSetup",
      "mutation": {
        "domain": "account",
        "kind": "op"
      },
      "opScope": {
        "domain": "account",
        "kind": "domain"
      },
      "origins": [
        "local",
        "ssh",
        "relay"
      ],
      "params": "AccountRefreshProviderSetupParams",
      "result": "v2::feed::EmptyResult",
      "scope": {
        "kind": "none"
      }
    },
    {
      "class": "C1",
      "method": "localProvider/searchLocalProviderModels",
      "mutation": {
        "kind": "none"
      },
      "opScope": {
        "kind": "none"
      },
      "origins": [
        "local",
        "ssh"
      ],
      "params": "LocalProviderSearchLocalProviderModelsParams",
      "result": "JsonValue",
      "scope": {
        "kind": "none"
      }
    },
    {
      "class": "C1",
      "method": "localProvider/inspectHuggingFaceModel",
      "mutation": {
        "kind": "none"
      },
      "opScope": {
        "kind": "none"
      },
      "origins": [
        "local",
        "ssh"
      ],
      "params": "LocalProviderInspectHuggingFaceModelParams",
      "result": "JsonValue",
      "scope": {
        "kind": "none"
      }
    },
    {
      "class": "C1",
      "method": "localProvider/getLocalProviderModelDetails",
      "mutation": {
        "kind": "none"
      },
      "opScope": {
        "kind": "none"
      },
      "origins": [
        "local",
        "ssh",
        "relay"
      ],
      "params": "LocalProviderGetLocalProviderModelDetailsParams",
      "result": "JsonValue",
      "scope": {
        "kind": "none"
      }
    },
    {
      "class": "C2",
      "method": "localProvider/installLocalProviderModel",
      "mutation": {
        "domain": "localProvider",
        "kind": "op"
      },
      "opScope": {
        "domain": "localProvider",
        "field": "threadId",
        "kind": "threadOrDomain"
      },
      "origins": [
        "local",
        "ssh",
        "relay"
      ],
      "params": "LocalProviderInstallLocalProviderModelParams",
      "result": "JsonValue",
      "scope": {
        "field": "threadId",
        "kind": "threadOrNone"
      }
    },
    {
      "class": "C2",
      "method": "localProvider/startLocalProviderInstallation",
      "mutation": {
        "domain": "localProvider",
        "kind": "op"
      },
      "opScope": {
        "domain": "localProvider",
        "field": "threadId",
        "kind": "threadOrDomain"
      },
      "origins": [
        "local",
        "ssh",
        "relay"
      ],
      "params": "LocalProviderStartLocalProviderInstallationParams",
      "result": "JsonValue",
      "scope": {
        "field": "threadId",
        "kind": "threadOrNone"
      }
    },
    {
      "class": "C2",
      "method": "localProvider/cancelLocalProviderInstallation",
      "mutation": {
        "domain": "localProvider",
        "kind": "op"
      },
      "opScope": {
        "domain": "localProvider",
        "field": "threadId",
        "kind": "threadOrDomain"
      },
      "origins": [
        "local",
        "ssh",
        "relay"
      ],
      "params": "LocalProviderCancelLocalProviderInstallationParams",
      "result": "JsonValue",
      "scope": {
        "field": "threadId",
        "kind": "threadOrNone"
      }
    },
    {
      "class": "C2",
      "method": "localProvider/discardLocalProviderInstallation",
      "mutation": {
        "domain": "localProvider",
        "kind": "op"
      },
      "opScope": {
        "domain": "localProvider",
        "field": "threadId",
        "kind": "threadOrDomain"
      },
      "origins": [
        "local",
        "ssh",
        "relay"
      ],
      "params": "LocalProviderDiscardLocalProviderInstallationParams",
      "result": "JsonValue",
      "scope": {
        "field": "threadId",
        "kind": "threadOrNone"
      }
    },
    {
      "class": "C2",
      "method": "localProvider/setLocalProviderIdleTtl",
      "mutation": {
        "domain": "localProvider",
        "kind": "op"
      },
      "opScope": {
        "domain": "localProvider",
        "field": "threadId",
        "kind": "threadOrDomain"
      },
      "origins": [
        "local",
        "ssh",
        "relay"
      ],
      "params": "LocalProviderSetLocalProviderIdleTtlParams",
      "result": "JsonValue",
      "scope": {
        "field": "threadId",
        "kind": "threadOrNone"
      }
    },
    {
      "class": "C2",
      "method": "localProvider/setLocalProviderContext",
      "mutation": {
        "domain": "localProvider",
        "kind": "op"
      },
      "opScope": {
        "domain": "localProvider",
        "field": "threadId",
        "kind": "threadOrDomain"
      },
      "origins": [
        "local",
        "ssh",
        "relay"
      ],
      "params": "LocalProviderSetLocalProviderContextParams",
      "result": "JsonValue",
      "scope": {
        "field": "threadId",
        "kind": "threadOrNone"
      }
    },
    {
      "class": "C2",
      "method": "localProvider/registerHuggingFaceModel",
      "mutation": {
        "domain": "localProvider",
        "kind": "op"
      },
      "opScope": {
        "domain": "localProvider",
        "field": "threadId",
        "kind": "threadOrDomain"
      },
      "origins": [
        "local",
        "ssh"
      ],
      "params": "LocalProviderRegisterHuggingFaceModelParams",
      "result": "JsonValue",
      "scope": {
        "field": "threadId",
        "kind": "threadOrNone"
      }
    },
    {
      "class": "C2",
      "method": "localProvider/startLocalProviderModelMaintenance",
      "mutation": {
        "domain": "localProvider",
        "kind": "op"
      },
      "opScope": {
        "domain": "localProvider",
        "field": "threadId",
        "kind": "threadOrDomain"
      },
      "origins": [
        "local",
        "ssh",
        "relay"
      ],
      "params": "LocalProviderStartLocalProviderModelMaintenanceParams",
      "result": "JsonValue",
      "scope": {
        "field": "threadId",
        "kind": "threadOrNone"
      }
    },
    {
      "class": "C2",
      "method": "localProvider/deleteLocalProviderModel",
      "mutation": {
        "domain": "localProvider",
        "kind": "op"
      },
      "opScope": {
        "domain": "localProvider",
        "field": "threadId",
        "kind": "threadOrDomain"
      },
      "origins": [
        "local",
        "ssh",
        "relay"
      ],
      "params": "LocalProviderDeleteLocalProviderModelParams",
      "result": "JsonValue",
      "scope": {
        "field": "threadId",
        "kind": "threadOrNone"
      }
    },
    {
      "class": "C1",
      "method": "usage/getUsageDashboard",
      "mutation": {
        "kind": "none"
      },
      "opScope": {
        "kind": "none"
      },
      "origins": [
        "local",
        "ssh",
        "relay"
      ],
      "params": "UsageGetUsageDashboardParams",
      "result": "JsonValue",
      "scope": {
        "kind": "none"
      }
    },
    {
      "class": "C1",
      "method": "usage/getUsageStats",
      "mutation": {
        "kind": "none"
      },
      "opScope": {
        "kind": "none"
      },
      "origins": [
        "local",
        "ssh",
        "relay"
      ],
      "params": "UsageGetUsageStatsParams",
      "result": "JsonValue",
      "scope": {
        "kind": "none"
      }
    },
    {
      "class": "C1",
      "method": "usage/getUsageRequests",
      "mutation": {
        "kind": "none"
      },
      "opScope": {
        "kind": "none"
      },
      "origins": [
        "local",
        "ssh",
        "relay"
      ],
      "params": "UsageGetUsageRequestsParams",
      "result": "JsonValue",
      "scope": {
        "kind": "none"
      }
    },
    {
      "class": "C1",
      "method": "update/getUpdateStatus",
      "mutation": {
        "kind": "none"
      },
      "opScope": {
        "kind": "none"
      },
      "origins": [
        "local",
        "ssh",
        "relay"
      ],
      "params": "UpdateGetUpdateStatusParams",
      "result": "JsonValue",
      "scope": {
        "kind": "none"
      }
    },
    {
      "class": "C2",
      "method": "update/checkForUpdate",
      "mutation": {
        "domain": "update",
        "kind": "op"
      },
      "opScope": {
        "domain": "update",
        "field": "threadId",
        "kind": "threadOrDomain"
      },
      "origins": [
        "local",
        "ssh",
        "relay"
      ],
      "params": "UpdateCheckForUpdateParams",
      "result": "JsonValue",
      "scope": {
        "field": "threadId",
        "kind": "threadOrNone"
      }
    },
    {
      "class": "C2",
      "method": "update/runUpdateNow",
      "mutation": {
        "domain": "update",
        "kind": "op"
      },
      "opScope": {
        "domain": "update",
        "field": "threadId",
        "kind": "threadOrDomain"
      },
      "origins": [
        "local",
        "ssh",
        "relay"
      ],
      "params": "UpdateRunUpdateNowParams",
      "result": "JsonValue",
      "scope": {
        "field": "threadId",
        "kind": "threadOrNone"
      }
    },
    {
      "class": "C2",
      "method": "update/desktop/command",
      "mutation": {
        "domain": "update",
        "kind": "op"
      },
      "opScope": {
        "domain": "update",
        "kind": "domain"
      },
      "origins": [
        "local",
        "ssh",
        "relay"
      ],
      "params": "v2::host::UpdateDesktopCommandParams",
      "result": "JsonValue",
      "scope": {
        "key": "update",
        "kind": "global"
      }
    },
    {
      "class": "C1",
      "method": "voice/getVoiceStatus",
      "mutation": {
        "kind": "none"
      },
      "opScope": {
        "kind": "none"
      },
      "origins": [
        "local",
        "ssh",
        "relay"
      ],
      "params": "VoiceGetVoiceStatusParams",
      "result": "JsonValue",
      "scope": {
        "kind": "none"
      }
    },
    {
      "class": "C2",
      "method": "voice/toggleVoice",
      "mutation": {
        "domain": "voice",
        "kind": "op"
      },
      "opScope": {
        "domain": "voice",
        "field": "threadId",
        "kind": "threadOrDomain"
      },
      "origins": [
        "local",
        "ssh",
        "relay"
      ],
      "params": "VoiceToggleVoiceParams",
      "result": "JsonValue",
      "scope": {
        "field": "threadId",
        "kind": "threadOrNone"
      }
    },
    {
      "class": "C2",
      "method": "voice/transcribeAudio",
      "mutation": {
        "domain": "voice",
        "kind": "op"
      },
      "opScope": {
        "domain": "voice",
        "field": "threadId",
        "kind": "threadOrDomain"
      },
      "origins": [
        "local",
        "ssh",
        "relay"
      ],
      "params": "VoiceTranscribeAudioParams",
      "result": "JsonValue",
      "scope": {
        "field": "threadId",
        "key": "voice",
        "kind": "threadOrGlobal"
      }
    },
    {
      "class": "C2",
      "method": "voice/prepareTranscription",
      "mutation": {
        "domain": "voice",
        "kind": "op"
      },
      "opScope": {
        "domain": "voice",
        "field": "threadId",
        "kind": "threadOrDomain"
      },
      "origins": [
        "local",
        "ssh",
        "relay"
      ],
      "params": "VoicePrepareTranscriptionParams",
      "result": "JsonValue",
      "scope": {
        "field": "threadId",
        "kind": "threadOrNone"
      }
    },
    {
      "class": "C1",
      "method": "tidy/getTidyEngineStatus",
      "mutation": {
        "kind": "none"
      },
      "opScope": {
        "kind": "none"
      },
      "origins": [
        "local",
        "ssh",
        "relay"
      ],
      "params": "TidyGetTidyEngineStatusParams",
      "result": "JsonValue",
      "scope": {
        "kind": "none"
      }
    },
    {
      "class": "C1",
      "method": "tidy/getTidyInstallStatus",
      "mutation": {
        "kind": "none"
      },
      "opScope": {
        "kind": "none"
      },
      "origins": [
        "local",
        "ssh",
        "relay"
      ],
      "params": "TidyGetTidyInstallStatusParams",
      "result": "JsonValue",
      "scope": {
        "kind": "none"
      }
    },
    {
      "class": "C1",
      "method": "skills/skillsStatus",
      "mutation": {
        "kind": "none"
      },
      "opScope": {
        "kind": "none"
      },
      "origins": [
        "local",
        "ssh",
        "relay"
      ],
      "params": "SkillsSkillsStatusParams",
      "result": "JsonValue",
      "scope": {
        "kind": "none"
      }
    },
    {
      "class": "C1",
      "method": "skills/skillContent",
      "mutation": {
        "kind": "none"
      },
      "opScope": {
        "kind": "none"
      },
      "origins": [
        "local",
        "ssh",
        "relay"
      ],
      "params": "SkillsSkillContentParams",
      "result": "JsonValue",
      "scope": {
        "kind": "none"
      }
    },
    {
      "class": "C1",
      "method": "skills/getDisabledSkills",
      "mutation": {
        "kind": "none"
      },
      "opScope": {
        "kind": "none"
      },
      "origins": [
        "local",
        "ssh",
        "relay"
      ],
      "params": "SkillsGetDisabledSkillsParams",
      "result": "JsonValue",
      "scope": {
        "kind": "none"
      }
    },
    {
      "class": "C2",
      "method": "skills/addSkill",
      "mutation": {
        "domain": "skills",
        "kind": "op"
      },
      "opScope": {
        "domain": "skills",
        "field": "threadId",
        "kind": "threadOrDomain"
      },
      "origins": [
        "local",
        "ssh",
        "relay"
      ],
      "params": "SkillsAddSkillParams",
      "result": "JsonValue",
      "scope": {
        "field": "threadId",
        "kind": "threadOrNone"
      }
    },
    {
      "class": "C2",
      "method": "skills/saveSkill",
      "mutation": {
        "domain": "skills",
        "kind": "op"
      },
      "opScope": {
        "domain": "skills",
        "field": "threadId",
        "kind": "threadOrDomain"
      },
      "origins": [
        "local",
        "ssh",
        "relay"
      ],
      "params": "SkillsSaveSkillParams",
      "result": "JsonValue",
      "scope": {
        "field": "threadId",
        "kind": "threadOrNone"
      }
    },
    {
      "class": "C2",
      "method": "skills/removeSkill",
      "mutation": {
        "domain": "skills",
        "kind": "op"
      },
      "opScope": {
        "domain": "skills",
        "field": "threadId",
        "kind": "threadOrDomain"
      },
      "origins": [
        "local",
        "ssh",
        "relay"
      ],
      "params": "SkillsRemoveSkillParams",
      "result": "JsonValue",
      "scope": {
        "field": "threadId",
        "kind": "threadOrNone"
      }
    },
    {
      "class": "C2",
      "method": "skills/reloadSkills",
      "mutation": {
        "domain": "skills",
        "kind": "op"
      },
      "opScope": {
        "domain": "skills",
        "field": "threadId",
        "kind": "threadOrDomain"
      },
      "origins": [
        "local",
        "ssh",
        "relay"
      ],
      "params": "SkillsReloadSkillsParams",
      "result": "JsonValue",
      "scope": {
        "field": "threadId",
        "kind": "threadOrNone"
      }
    },
    {
      "class": "C2",
      "method": "skills/setDisabledSkills",
      "mutation": {
        "domain": "skills",
        "kind": "op"
      },
      "opScope": {
        "domain": "skills",
        "field": "threadId",
        "kind": "threadOrDomain"
      },
      "origins": [
        "local",
        "ssh",
        "relay"
      ],
      "params": "SkillsSetDisabledSkillsParams",
      "result": "JsonValue",
      "scope": {
        "field": "threadId",
        "kind": "threadOrNone"
      }
    },
    {
      "class": "C1",
      "method": "plugins/pluginsStatus",
      "mutation": {
        "kind": "none"
      },
      "opScope": {
        "kind": "none"
      },
      "origins": [
        "local",
        "ssh",
        "relay"
      ],
      "params": "PluginsPluginsStatusParams",
      "result": "JsonValue",
      "scope": {
        "kind": "none"
      }
    },
    {
      "class": "C2",
      "method": "plugins/addPlugin",
      "mutation": {
        "domain": "plugins",
        "kind": "op"
      },
      "opScope": {
        "domain": "plugins",
        "field": "threadId",
        "kind": "threadOrDomain"
      },
      "origins": [
        "local",
        "ssh",
        "relay"
      ],
      "params": "PluginsAddPluginParams",
      "result": "JsonValue",
      "scope": {
        "field": "threadId",
        "kind": "threadOrNone"
      }
    },
    {
      "class": "C2",
      "method": "plugins/updatePlugin",
      "mutation": {
        "domain": "plugins",
        "kind": "op"
      },
      "opScope": {
        "domain": "plugins",
        "field": "threadId",
        "kind": "threadOrDomain"
      },
      "origins": [
        "local",
        "ssh",
        "relay"
      ],
      "params": "PluginsUpdatePluginParams",
      "result": "JsonValue",
      "scope": {
        "field": "threadId",
        "kind": "threadOrNone"
      }
    },
    {
      "class": "C2",
      "method": "plugins/setPluginEnabled",
      "mutation": {
        "domain": "plugins",
        "kind": "op"
      },
      "opScope": {
        "domain": "plugins",
        "field": "threadId",
        "kind": "threadOrDomain"
      },
      "origins": [
        "local",
        "ssh",
        "relay"
      ],
      "params": "PluginsSetPluginEnabledParams",
      "result": "JsonValue",
      "scope": {
        "field": "threadId",
        "kind": "threadOrNone"
      }
    },
    {
      "class": "C2",
      "method": "plugins/removePlugin",
      "mutation": {
        "domain": "plugins",
        "kind": "op"
      },
      "opScope": {
        "domain": "plugins",
        "field": "threadId",
        "kind": "threadOrDomain"
      },
      "origins": [
        "local",
        "ssh",
        "relay"
      ],
      "params": "PluginsRemovePluginParams",
      "result": "JsonValue",
      "scope": {
        "field": "threadId",
        "kind": "threadOrNone"
      }
    },
    {
      "class": "C2",
      "method": "plugins/reloadPlugins",
      "mutation": {
        "domain": "plugins",
        "kind": "op"
      },
      "opScope": {
        "domain": "plugins",
        "field": "threadId",
        "kind": "threadOrDomain"
      },
      "origins": [
        "local",
        "ssh",
        "relay"
      ],
      "params": "PluginsReloadPluginsParams",
      "result": "JsonValue",
      "scope": {
        "field": "threadId",
        "kind": "threadOrNone"
      }
    },
    {
      "class": "C1",
      "method": "tools/toolsStatus",
      "mutation": {
        "kind": "none"
      },
      "opScope": {
        "kind": "none"
      },
      "origins": [
        "local",
        "ssh",
        "relay"
      ],
      "params": "ToolsToolsStatusParams",
      "result": "JsonValue",
      "scope": {
        "kind": "none"
      }
    },
    {
      "class": "C2",
      "method": "memory/memoryControl",
      "mutation": {
        "domain": "memory",
        "kind": "op"
      },
      "opScope": {
        "domain": "memory",
        "field": "threadId",
        "kind": "threadOrDomain"
      },
      "origins": [
        "local",
        "ssh",
        "relay"
      ],
      "params": "MemoryMemoryControlParams",
      "result": "JsonValue",
      "scope": {
        "field": "threadId",
        "kind": "threadOrNone"
      }
    },
    {
      "class": "C2",
      "method": "memory/recall",
      "mutation": {
        "domain": "memory",
        "kind": "op"
      },
      "opScope": {
        "domain": "memory",
        "field": "threadId",
        "kind": "threadOrDomain"
      },
      "origins": [
        "local",
        "ssh",
        "relay"
      ],
      "params": "MemoryRecallParams",
      "result": "JsonValue",
      "scope": {
        "field": "threadId",
        "kind": "threadOrNone"
      }
    },
    {
      "class": "C2",
      "method": "diagnostics/runDoctor",
      "mutation": {
        "domain": "diagnostics",
        "kind": "op"
      },
      "opScope": {
        "domain": "diagnostics",
        "field": "threadId",
        "kind": "threadOrDomain"
      },
      "origins": [
        "local",
        "ssh",
        "relay"
      ],
      "params": "DiagnosticsRunDoctorParams",
      "result": "JsonValue",
      "scope": {
        "field": "threadId",
        "kind": "threadOrNone"
      }
    },
    {
      "class": "C1",
      "method": "project/list",
      "mutation": {
        "kind": "none"
      },
      "opScope": {
        "kind": "none"
      },
      "origins": [
        "local",
        "ssh",
        "relay"
      ],
      "params": "ProjectListParams",
      "result": "JsonValue",
      "scope": {
        "key": "project",
        "kind": "sharedRead"
      }
    },
    {
      "class": "C1",
      "method": "project/read",
      "mutation": {
        "kind": "none"
      },
      "opScope": {
        "kind": "none"
      },
      "origins": [
        "local",
        "ssh"
      ],
      "params": "ProjectReadParams",
      "result": "JsonValue",
      "scope": {
        "key": "project",
        "kind": "sharedRead"
      }
    },
    {
      "class": "C2",
      "method": "project/create",
      "mutation": {
        "domain": "project",
        "kind": "op"
      },
      "opScope": {
        "domain": "project",
        "kind": "domain"
      },
      "origins": [
        "local",
        "ssh",
        "relay"
      ],
      "params": "ProjectCreateParams",
      "result": "JsonValue",
      "scope": {
        "key": "project",
        "kind": "global"
      }
    },
    {
      "class": "C2",
      "method": "project/touch",
      "mutation": {
        "domain": "project",
        "kind": "op"
      },
      "opScope": {
        "domain": "project",
        "kind": "domain"
      },
      "origins": [
        "local",
        "ssh"
      ],
      "params": "ProjectTouchParams",
      "result": "JsonValue",
      "scope": {
        "key": "project",
        "kind": "global"
      }
    },
    {
      "class": "C2",
      "method": "project/update",
      "mutation": {
        "domain": "project",
        "kind": "op"
      },
      "opScope": {
        "domain": "project",
        "kind": "domain"
      },
      "origins": [
        "local",
        "ssh",
        "relay"
      ],
      "params": "ProjectUpdateParams",
      "result": "JsonValue",
      "scope": {
        "key": "project",
        "kind": "global"
      }
    },
    {
      "class": "C2",
      "method": "project/delete",
      "mutation": {
        "domain": "project",
        "kind": "op"
      },
      "opScope": {
        "domain": "project",
        "kind": "domain"
      },
      "origins": [
        "local",
        "ssh",
        "relay"
      ],
      "params": "ProjectDeleteParams",
      "result": "JsonValue",
      "scope": {
        "key": "project",
        "kind": "global"
      }
    },
    {
      "class": "C2",
      "method": "project/ensureDirectory",
      "mutation": {
        "domain": "project",
        "kind": "op"
      },
      "opScope": {
        "domain": "project",
        "kind": "domain"
      },
      "origins": [
        "local",
        "ssh"
      ],
      "params": "ProjectEnsureDirectoryParams",
      "result": "JsonValue",
      "scope": {
        "key": "project",
        "kind": "global"
      }
    },
    {
      "class": "C1",
      "method": "project/directory",
      "mutation": {
        "kind": "none"
      },
      "opScope": {
        "kind": "none"
      },
      "origins": [
        "local",
        "ssh"
      ],
      "params": "ProjectDirectoryParams",
      "result": "JsonValue",
      "scope": {
        "key": "project",
        "kind": "sharedRead"
      }
    },
    {
      "class": "C1",
      "method": "project/recoveryDirectory",
      "mutation": {
        "kind": "none"
      },
      "opScope": {
        "kind": "none"
      },
      "origins": [
        "local",
        "ssh"
      ],
      "params": "ProjectRecoveryDirectoryParams",
      "result": "JsonValue",
      "scope": {
        "key": "project",
        "kind": "sharedRead"
      }
    },
    {
      "class": "C1",
      "method": "project/taskWorkspace",
      "mutation": {
        "kind": "none"
      },
      "opScope": {
        "kind": "none"
      },
      "origins": [
        "local",
        "ssh",
        "relay"
      ],
      "params": "ProjectTaskWorkspaceParams",
      "result": "JsonValue",
      "scope": {
        "key": "project",
        "kind": "sharedRead"
      }
    },
    {
      "class": "C3",
      "method": "project/codeGraph",
      "mutation": {
        "kind": "none"
      },
      "opScope": {
        "kind": "none"
      },
      "origins": [
        "local",
        "ssh",
        "relay"
      ],
      "params": "ProjectCodeGraphParams",
      "result": "JsonValue",
      "scope": {
        "kind": "none"
      }
    },
    {
      "class": "C1",
      "method": "projectFs/listDir",
      "mutation": {
        "kind": "none"
      },
      "opScope": {
        "kind": "none"
      },
      "origins": [
        "local",
        "ssh",
        "relay"
      ],
      "params": "ProjectFsListDirParams",
      "result": "JsonValue",
      "scope": {
        "kind": "none"
      }
    },
    {
      "class": "C1",
      "method": "projectFs/readText",
      "mutation": {
        "kind": "none"
      },
      "opScope": {
        "kind": "none"
      },
      "origins": [
        "local",
        "ssh",
        "relay"
      ],
      "params": "ProjectFsReadTextParams",
      "result": "JsonValue",
      "scope": {
        "kind": "none"
      }
    },
    {
      "class": "C2",
      "method": "projectFs/writeText",
      "mutation": {
        "domain": "projectFs",
        "kind": "op"
      },
      "opScope": {
        "domain": "projectFs",
        "kind": "domain"
      },
      "origins": [
        "local",
        "ssh",
        "relay"
      ],
      "params": "ProjectFsWriteTextParams",
      "result": "JsonValue",
      "scope": {
        "kind": "none"
      }
    },
    {
      "class": "C2",
      "method": "projectFs/writeTextBatch",
      "mutation": {
        "domain": "projectFs",
        "kind": "op"
      },
      "opScope": {
        "domain": "projectFs",
        "kind": "domain"
      },
      "origins": [
        "local",
        "ssh",
        "relay"
      ],
      "params": "ProjectFsWriteTextBatchParams",
      "result": "JsonValue",
      "scope": {
        "kind": "none"
      }
    },
    {
      "class": "C1",
      "method": "projectFs/stat",
      "mutation": {
        "kind": "none"
      },
      "opScope": {
        "kind": "none"
      },
      "origins": [
        "local",
        "ssh",
        "relay"
      ],
      "params": "ProjectFsStatParams",
      "result": "JsonValue",
      "scope": {
        "kind": "none"
      }
    },
    {
      "class": "C2",
      "method": "projectFs/create",
      "mutation": {
        "domain": "projectFs",
        "kind": "op"
      },
      "opScope": {
        "domain": "projectFs",
        "kind": "domain"
      },
      "origins": [
        "local",
        "ssh",
        "relay"
      ],
      "params": "ProjectFsCreateParams",
      "result": "JsonValue",
      "scope": {
        "kind": "none"
      }
    },
    {
      "class": "C2",
      "method": "projectFs/rename",
      "mutation": {
        "domain": "projectFs",
        "kind": "op"
      },
      "opScope": {
        "domain": "projectFs",
        "kind": "domain"
      },
      "origins": [
        "local",
        "ssh",
        "relay"
      ],
      "params": "ProjectFsRenameParams",
      "result": "JsonValue",
      "scope": {
        "kind": "none"
      }
    },
    {
      "class": "C2",
      "method": "projectFs/move",
      "mutation": {
        "domain": "projectFs",
        "kind": "op"
      },
      "opScope": {
        "domain": "projectFs",
        "kind": "domain"
      },
      "origins": [
        "local",
        "ssh",
        "relay"
      ],
      "params": "ProjectFsMoveParams",
      "result": "JsonValue",
      "scope": {
        "kind": "none"
      }
    },
    {
      "class": "C2",
      "method": "projectFs/copy",
      "mutation": {
        "domain": "projectFs",
        "kind": "op"
      },
      "opScope": {
        "domain": "projectFs",
        "kind": "domain"
      },
      "origins": [
        "local",
        "ssh",
        "relay"
      ],
      "params": "ProjectFsCopyParams",
      "result": "JsonValue",
      "scope": {
        "kind": "none"
      }
    },
    {
      "class": "C2",
      "method": "projectFs/trash",
      "mutation": {
        "domain": "projectFs",
        "kind": "op"
      },
      "opScope": {
        "domain": "projectFs",
        "kind": "domain"
      },
      "origins": [
        "local",
        "ssh",
        "relay"
      ],
      "params": "ProjectFsTrashParams",
      "result": "JsonValue",
      "scope": {
        "kind": "none"
      }
    },
    {
      "class": "C1",
      "method": "projectFs/entryPath",
      "mutation": {
        "kind": "none"
      },
      "opScope": {
        "kind": "none"
      },
      "origins": [
        "local",
        "ssh"
      ],
      "params": "ProjectFsEntryPathParams",
      "result": "JsonValue",
      "scope": {
        "kind": "none"
      }
    },
    {
      "class": "C1",
      "method": "projectFs/readLocal",
      "mutation": {
        "kind": "none"
      },
      "opScope": {
        "kind": "none"
      },
      "origins": [
        "local",
        "ssh",
        "relay"
      ],
      "params": "ProjectFsReadLocalParams",
      "result": "JsonValue",
      "scope": {
        "kind": "none"
      }
    },
    {
      "class": "C1",
      "method": "projectFs/statLocal",
      "mutation": {
        "kind": "none"
      },
      "opScope": {
        "kind": "none"
      },
      "origins": [
        "local",
        "ssh",
        "relay"
      ],
      "params": "ProjectFsStatLocalParams",
      "result": "JsonValue",
      "scope": {
        "kind": "none"
      }
    },
    {
      "class": "C1",
      "method": "projectFs/browseDirs",
      "mutation": {
        "kind": "none"
      },
      "opScope": {
        "kind": "none"
      },
      "origins": [
        "local",
        "ssh",
        "relay"
      ],
      "params": "ProjectFsBrowseDirsParams",
      "result": "JsonValue",
      "scope": {
        "kind": "none"
      }
    },
    {
      "class": "C3",
      "method": "projectFs/searchText",
      "mutation": {
        "kind": "none"
      },
      "opScope": {
        "kind": "none"
      },
      "origins": [
        "local",
        "ssh",
        "relay"
      ],
      "params": "ProjectFsSearchTextParams",
      "result": "JsonValue",
      "scope": {
        "kind": "none"
      }
    },
    {
      "class": "C3",
      "method": "projectFs/replaceText",
      "mutation": {
        "domain": "projectFs",
        "kind": "op"
      },
      "opScope": {
        "domain": "projectFs",
        "kind": "domain"
      },
      "origins": [
        "local",
        "ssh",
        "relay"
      ],
      "params": "ProjectFsReplaceTextParams",
      "result": "JsonValue",
      "scope": {
        "kind": "none"
      }
    },
    {
      "class": "C2",
      "method": "projectFs/recovery",
      "mutation": {
        "domain": "projectFs",
        "kind": "op"
      },
      "opScope": {
        "domain": "projectFs",
        "kind": "domain"
      },
      "origins": [
        "local",
        "ssh",
        "relay"
      ],
      "params": "ProjectFsRecoveryParams",
      "result": "JsonValue",
      "scope": {
        "kind": "none"
      }
    },
    {
      "class": "C1",
      "method": "projectFs/backup/read",
      "mutation": {
        "kind": "none"
      },
      "opScope": {
        "kind": "none"
      },
      "origins": [
        "local",
        "ssh",
        "relay"
      ],
      "params": "ProjectFsBackupReadParams",
      "result": "JsonValue",
      "scope": {
        "kind": "none"
      }
    },
    {
      "class": "C2",
      "method": "projectFs/backup/write",
      "mutation": {
        "domain": "projectFs",
        "kind": "op"
      },
      "opScope": {
        "domain": "projectFs",
        "kind": "domain"
      },
      "origins": [
        "local",
        "ssh",
        "relay"
      ],
      "params": "ProjectFsBackupWriteParams",
      "result": "JsonValue",
      "scope": {
        "kind": "none"
      }
    },
    {
      "class": "C2",
      "method": "projectFs/backup/delete",
      "mutation": {
        "domain": "projectFs",
        "kind": "op"
      },
      "opScope": {
        "domain": "projectFs",
        "kind": "domain"
      },
      "origins": [
        "local",
        "ssh",
        "relay"
      ],
      "params": "ProjectFsBackupDeleteParams",
      "result": "JsonValue",
      "scope": {
        "kind": "none"
      }
    },
    {
      "class": "C1",
      "method": "projectFs/workspaceFile/read",
      "mutation": {
        "kind": "none"
      },
      "opScope": {
        "kind": "none"
      },
      "origins": [
        "local",
        "ssh"
      ],
      "params": "ProjectFsWorkspaceFileReadParams",
      "result": "JsonValue",
      "scope": {
        "kind": "none"
      }
    },
    {
      "class": "C2",
      "method": "projectFs/workspaceFile/write",
      "mutation": {
        "domain": "projectFs",
        "kind": "op"
      },
      "opScope": {
        "domain": "projectFs",
        "kind": "domain"
      },
      "origins": [
        "local",
        "ssh",
        "relay"
      ],
      "params": "ProjectFsWorkspaceFileWriteParams",
      "result": "JsonValue",
      "scope": {
        "kind": "none"
      }
    },
    {
      "class": "C1",
      "method": "projectFs/readEditorSettings",
      "mutation": {
        "kind": "none"
      },
      "opScope": {
        "kind": "none"
      },
      "origins": [
        "local",
        "ssh",
        "relay"
      ],
      "params": "ProjectFsReadEditorSettingsParams",
      "result": "JsonValue",
      "scope": {
        "kind": "none"
      }
    },
    {
      "class": "C1",
      "method": "projectFs/captureSnapshot",
      "mutation": {
        "kind": "none"
      },
      "opScope": {
        "kind": "none"
      },
      "origins": [
        "local",
        "ssh",
        "relay"
      ],
      "params": "ProjectFsCaptureSnapshotParams",
      "result": "JsonValue",
      "scope": {
        "kind": "none"
      }
    },
    {
      "class": "C1",
      "method": "projectFs/localPageUrl",
      "mutation": {
        "kind": "none"
      },
      "opScope": {
        "kind": "none"
      },
      "origins": [
        "local",
        "ssh",
        "relay"
      ],
      "params": "ProjectFsLocalPageUrlParams",
      "result": "JsonValue",
      "scope": {
        "kind": "none"
      }
    },
    {
      "class": "C1",
      "method": "fs/watch",
      "mutation": {
        "kind": "none"
      },
      "opScope": {
        "kind": "none"
      },
      "origins": [
        "local",
        "ssh",
        "relay"
      ],
      "params": "FsWatchParams",
      "result": "v2::feed::Subscription",
      "scope": {
        "field": "watchId",
        "kind": "fsWatch"
      }
    },
    {
      "class": "C1",
      "method": "fs/unwatch",
      "mutation": {
        "kind": "none"
      },
      "opScope": {
        "kind": "none"
      },
      "origins": [
        "local",
        "ssh",
        "relay"
      ],
      "params": "FsUnwatchParams",
      "result": "v2::feed::EmptyResult",
      "scope": {
        "field": "watchId",
        "kind": "fsWatch"
      }
    },
    {
      "class": "C3",
      "method": "search/start",
      "mutation": {
        "kind": "none"
      },
      "opScope": {
        "kind": "none"
      },
      "origins": [
        "local",
        "ssh",
        "relay"
      ],
      "params": "SearchStartParams",
      "result": "v2::feed::Subscription",
      "scope": {
        "field": "sessionId",
        "kind": "fuzzySession"
      }
    },
    {
      "class": "C1",
      "method": "search/update",
      "mutation": {
        "kind": "none"
      },
      "opScope": {
        "kind": "none"
      },
      "origins": [
        "local",
        "ssh",
        "relay"
      ],
      "params": "SearchUpdateParams",
      "result": "v2::feed::EmptyResult",
      "scope": {
        "field": "sessionId",
        "kind": "fuzzySession"
      }
    },
    {
      "class": "C1",
      "method": "search/stop",
      "mutation": {
        "kind": "none"
      },
      "opScope": {
        "kind": "none"
      },
      "origins": [
        "local",
        "ssh",
        "relay"
      ],
      "params": "SearchStopParams",
      "result": "v2::feed::EmptyResult",
      "scope": {
        "field": "sessionId",
        "kind": "fuzzySession"
      }
    },
    {
      "class": "C1",
      "method": "transfer/beginRead",
      "mutation": {
        "kind": "none"
      },
      "opScope": {
        "kind": "none"
      },
      "origins": [
        "local",
        "ssh",
        "relay"
      ],
      "params": "v2::domain::TransferBeginReadParams",
      "result": "v2::domain::TransferBeginReadResponse",
      "scope": {
        "kind": "none"
      }
    },
    {
      "class": "C3",
      "method": "transfer/beginZip",
      "mutation": {
        "kind": "none"
      },
      "opScope": {
        "kind": "none"
      },
      "origins": [
        "local",
        "ssh"
      ],
      "params": "TransferBeginZipParams",
      "result": "v2::domain::TransferBeginReadResponse",
      "scope": {
        "kind": "none"
      }
    },
    {
      "class": "C1",
      "method": "transfer/readRange",
      "mutation": {
        "kind": "none"
      },
      "opScope": {
        "kind": "none"
      },
      "origins": [
        "local",
        "ssh",
        "relay"
      ],
      "params": "TransferReadRangeParams",
      "result": "v2::op::BlobReadResponse",
      "scope": {
        "kind": "none"
      }
    },
    {
      "class": "C1",
      "method": "transfer/endRead",
      "mutation": {
        "kind": "none"
      },
      "opScope": {
        "kind": "none"
      },
      "origins": [
        "local",
        "ssh",
        "relay"
      ],
      "params": "TransferEndReadParams",
      "result": "v2::feed::EmptyResult",
      "scope": {
        "kind": "none"
      }
    },
    {
      "class": "C2",
      "method": "transfer/beginWrite",
      "mutation": {
        "domain": "transfer",
        "kind": "op"
      },
      "opScope": {
        "domain": "transfer",
        "kind": "domain"
      },
      "origins": [
        "local",
        "ssh"
      ],
      "params": "TransferBeginWriteParams",
      "result": "JsonValue",
      "scope": {
        "kind": "none"
      }
    },
    {
      "class": "C2",
      "method": "transfer/writeChunk",
      "mutation": {
        "kind": "none"
      },
      "opScope": {
        "kind": "none"
      },
      "origins": [
        "local",
        "ssh"
      ],
      "params": "TransferWriteChunkParams",
      "result": "v2::feed::EmptyResult",
      "scope": {
        "kind": "none"
      }
    },
    {
      "class": "C2",
      "method": "transfer/commit",
      "mutation": {
        "domain": "transfer",
        "kind": "op"
      },
      "opScope": {
        "domain": "transfer",
        "kind": "domain"
      },
      "origins": [
        "local",
        "ssh"
      ],
      "params": "TransferCommitParams",
      "result": "JsonValue",
      "scope": {
        "kind": "none"
      }
    },
    {
      "class": "C2",
      "method": "transfer/abort",
      "mutation": {
        "kind": "none"
      },
      "opScope": {
        "kind": "none"
      },
      "origins": [
        "local",
        "ssh"
      ],
      "params": "TransferAbortParams",
      "result": "JsonValue",
      "scope": {
        "kind": "none"
      }
    },
    {
      "class": "C1",
      "method": "transfer/trash/info",
      "mutation": {
        "kind": "none"
      },
      "opScope": {
        "kind": "none"
      },
      "origins": [
        "local",
        "ssh"
      ],
      "params": "TransferTrashInfoParams",
      "result": "JsonValue",
      "scope": {
        "kind": "none"
      }
    },
    {
      "class": "C2",
      "method": "transfer/trash/entry",
      "mutation": {
        "domain": "transfer",
        "kind": "op"
      },
      "opScope": {
        "domain": "transfer",
        "kind": "domain"
      },
      "origins": [
        "local",
        "ssh"
      ],
      "params": "TransferTrashEntryParams",
      "result": "JsonValue",
      "scope": {
        "kind": "none"
      }
    },
    {
      "class": "C1",
      "method": "transfer/grant/mint",
      "mutation": {
        "kind": "none"
      },
      "opScope": {
        "kind": "none"
      },
      "origins": [
        "relay"
      ],
      "params": "TransferGrantMintParams",
      "result": "JsonValue",
      "scope": {
        "kind": "none"
      }
    },
    {
      "class": "C1",
      "method": "lsp/subscribe",
      "mutation": {
        "kind": "none"
      },
      "opScope": {
        "kind": "none"
      },
      "origins": [
        "local",
        "ssh",
        "relay"
      ],
      "params": "LspSubscribeParams",
      "result": "v2::feed::Subscription",
      "scope": {
        "field": "root",
        "kind": "keyed",
        "namespace": "lsp"
      }
    },
    {
      "class": "C1",
      "method": "lsp/unsubscribe",
      "mutation": {
        "kind": "none"
      },
      "opScope": {
        "kind": "none"
      },
      "origins": [
        "local",
        "ssh",
        "relay"
      ],
      "params": "LspSubscribeParams",
      "result": "v2::feed::EmptyResult",
      "scope": {
        "field": "root",
        "kind": "keyed",
        "namespace": "lsp"
      }
    },
    {
      "class": "C1",
      "method": "lsp/document",
      "mutation": {
        "kind": "none"
      },
      "opScope": {
        "kind": "none"
      },
      "origins": [
        "local",
        "ssh",
        "relay"
      ],
      "params": "LspDocumentParams",
      "result": "JsonValue",
      "scope": {
        "kind": "none"
      }
    },
    {
      "class": "C2",
      "method": "lsp/request",
      "mutation": {
        "domain": "lsp",
        "kind": "op"
      },
      "opScope": {
        "domain": "lsp",
        "kind": "domain"
      },
      "origins": [
        "local",
        "ssh",
        "relay"
      ],
      "params": "LspRequestParams",
      "result": "JsonValue",
      "scope": {
        "kind": "none"
      }
    },
    {
      "class": "C1",
      "method": "document/preview",
      "mutation": {
        "kind": "none"
      },
      "opScope": {
        "kind": "none"
      },
      "origins": [
        "local",
        "ssh"
      ],
      "params": "DocumentPreviewParams",
      "result": "JsonValue",
      "scope": {
        "kind": "none"
      }
    },
    {
      "class": "C1",
      "method": "document/previewPages",
      "mutation": {
        "kind": "none"
      },
      "opScope": {
        "kind": "none"
      },
      "origins": [
        "local",
        "ssh",
        "relay"
      ],
      "params": "DocumentPreviewPagesParams",
      "result": "JsonValue",
      "scope": {
        "kind": "none"
      }
    },
    {
      "class": "C1",
      "method": "document/libreOfficeStatus",
      "mutation": {
        "kind": "none"
      },
      "opScope": {
        "kind": "none"
      },
      "origins": [
        "local",
        "ssh",
        "relay"
      ],
      "params": "DocumentLibreOfficeStatusParams",
      "result": "JsonValue",
      "scope": {
        "kind": "none"
      }
    },
    {
      "class": "C2",
      "method": "document/installLibreOffice",
      "mutation": {
        "domain": "document",
        "kind": "op"
      },
      "opScope": {
        "domain": "document",
        "kind": "domain"
      },
      "origins": [
        "local",
        "ssh",
        "relay"
      ],
      "params": "DocumentInstallLibreOfficeParams",
      "result": "JsonValue",
      "scope": {
        "kind": "none"
      }
    },
    {
      "class": "C1",
      "method": "git/status",
      "mutation": {
        "kind": "none"
      },
      "opScope": {
        "kind": "none"
      },
      "origins": [
        "local",
        "ssh",
        "relay"
      ],
      "params": "GitStatusParams",
      "result": "JsonValue",
      "scope": {
        "kind": "none"
      }
    },
    {
      "class": "C1",
      "method": "git/branches",
      "mutation": {
        "kind": "none"
      },
      "opScope": {
        "kind": "none"
      },
      "origins": [
        "local",
        "ssh",
        "relay"
      ],
      "params": "GitBranchesParams",
      "result": "JsonValue",
      "scope": {
        "kind": "none"
      }
    },
    {
      "class": "C1",
      "method": "git/log",
      "mutation": {
        "kind": "none"
      },
      "opScope": {
        "kind": "none"
      },
      "origins": [
        "local",
        "ssh",
        "relay"
      ],
      "params": "GitLogParams",
      "result": "JsonValue",
      "scope": {
        "kind": "none"
      }
    },
    {
      "class": "C1",
      "method": "git/show",
      "mutation": {
        "kind": "none"
      },
      "opScope": {
        "kind": "none"
      },
      "origins": [
        "local",
        "ssh",
        "relay"
      ],
      "params": "GitShowParams",
      "result": "JsonValue",
      "scope": {
        "kind": "none"
      }
    },
    {
      "class": "C1",
      "method": "git/showDiff",
      "mutation": {
        "kind": "none"
      },
      "opScope": {
        "kind": "none"
      },
      "origins": [
        "local",
        "ssh",
        "relay"
      ],
      "params": "GitShowDiffParams",
      "result": "JsonValue",
      "scope": {
        "kind": "none"
      }
    },
    {
      "class": "C1",
      "method": "git/showFile",
      "mutation": {
        "kind": "none"
      },
      "opScope": {
        "kind": "none"
      },
      "origins": [
        "local",
        "ssh",
        "relay"
      ],
      "params": "GitShowFileParams",
      "result": "JsonValue",
      "scope": {
        "kind": "none"
      }
    },
    {
      "class": "C1",
      "method": "git/diff",
      "mutation": {
        "kind": "none"
      },
      "opScope": {
        "kind": "none"
      },
      "origins": [
        "local",
        "ssh",
        "relay"
      ],
      "params": "GitDiffParams",
      "result": "JsonValue",
      "scope": {
        "kind": "none"
      }
    },
    {
      "class": "C1",
      "method": "git/stashList",
      "mutation": {
        "kind": "none"
      },
      "opScope": {
        "kind": "none"
      },
      "origins": [
        "local",
        "ssh",
        "relay"
      ],
      "params": "GitStashListParams",
      "result": "JsonValue",
      "scope": {
        "kind": "none"
      }
    },
    {
      "class": "C1",
      "method": "git/requestContext",
      "mutation": {
        "kind": "none"
      },
      "opScope": {
        "kind": "none"
      },
      "origins": [
        "local",
        "ssh",
        "relay"
      ],
      "params": "GitRequestContextParams",
      "result": "JsonValue",
      "scope": {
        "kind": "none"
      }
    },
    {
      "class": "C1",
      "method": "git/cliStatus",
      "mutation": {
        "kind": "none"
      },
      "opScope": {
        "kind": "none"
      },
      "origins": [
        "local",
        "ssh",
        "relay"
      ],
      "params": "GitCliStatusParams",
      "result": "JsonValue",
      "scope": {
        "kind": "none"
      }
    },
    {
      "class": "C1",
      "method": "git/globalConfig/read",
      "mutation": {
        "kind": "none"
      },
      "opScope": {
        "kind": "none"
      },
      "origins": [
        "local",
        "ssh",
        "relay"
      ],
      "params": "GitGlobalConfigReadParams",
      "result": "JsonValue",
      "scope": {
        "kind": "none"
      }
    },
    {
      "class": "C1",
      "method": "git/watch",
      "mutation": {
        "kind": "none"
      },
      "opScope": {
        "kind": "none"
      },
      "origins": [
        "local",
        "ssh"
      ],
      "params": "GitWatchParams",
      "result": "v2::feed::Subscription",
      "scope": {
        "kind": "none"
      }
    },
    {
      "class": "C1",
      "method": "git/unwatch",
      "mutation": {
        "kind": "none"
      },
      "opScope": {
        "kind": "none"
      },
      "origins": [
        "local",
        "ssh"
      ],
      "params": "GitUnwatchParams",
      "result": "v2::feed::EmptyResult",
      "scope": {
        "kind": "none"
      }
    },
    {
      "class": "C2",
      "method": "git/stage",
      "mutation": {
        "domain": "git",
        "kind": "op"
      },
      "opScope": {
        "domain": "git",
        "kind": "domain"
      },
      "origins": [
        "local",
        "ssh",
        "relay"
      ],
      "params": "GitStageParams",
      "result": "JsonValue",
      "scope": {
        "field": "cwd",
        "kind": "repo"
      }
    },
    {
      "class": "C2",
      "method": "git/unstage",
      "mutation": {
        "domain": "git",
        "kind": "op"
      },
      "opScope": {
        "domain": "git",
        "kind": "domain"
      },
      "origins": [
        "local",
        "ssh",
        "relay"
      ],
      "params": "GitUnstageParams",
      "result": "JsonValue",
      "scope": {
        "field": "cwd",
        "kind": "repo"
      }
    },
    {
      "class": "C2",
      "method": "git/commit",
      "mutation": {
        "domain": "git",
        "kind": "op"
      },
      "opScope": {
        "domain": "git",
        "kind": "domain"
      },
      "origins": [
        "local",
        "ssh",
        "relay"
      ],
      "params": "GitCommitParams",
      "result": "JsonValue",
      "scope": {
        "field": "cwd",
        "kind": "repo"
      }
    },
    {
      "class": "C2",
      "method": "git/commitPaths",
      "mutation": {
        "domain": "git",
        "kind": "op"
      },
      "opScope": {
        "domain": "git",
        "kind": "domain"
      },
      "origins": [
        "local",
        "ssh",
        "relay"
      ],
      "params": "GitCommitPathsParams",
      "result": "JsonValue",
      "scope": {
        "field": "cwd",
        "kind": "repo"
      }
    },
    {
      "class": "C2",
      "method": "git/amend",
      "mutation": {
        "domain": "git",
        "kind": "op"
      },
      "opScope": {
        "domain": "git",
        "kind": "domain"
      },
      "origins": [
        "local",
        "ssh",
        "relay"
      ],
      "params": "GitAmendParams",
      "result": "JsonValue",
      "scope": {
        "field": "cwd",
        "kind": "repo"
      }
    },
    {
      "class": "C2",
      "method": "git/undoLastCommit",
      "mutation": {
        "domain": "git",
        "kind": "op"
      },
      "opScope": {
        "domain": "git",
        "kind": "domain"
      },
      "origins": [
        "local",
        "ssh",
        "relay"
      ],
      "params": "GitUndoLastCommitParams",
      "result": "JsonValue",
      "scope": {
        "field": "cwd",
        "kind": "repo"
      }
    },
    {
      "class": "C2",
      "method": "git/push",
      "mutation": {
        "domain": "git",
        "kind": "op"
      },
      "opScope": {
        "domain": "git",
        "kind": "domain"
      },
      "origins": [
        "local",
        "ssh",
        "relay"
      ],
      "params": "GitPushParams",
      "result": "JsonValue",
      "scope": {
        "field": "cwd",
        "kind": "repo"
      }
    },
    {
      "class": "C2",
      "method": "git/pull",
      "mutation": {
        "domain": "git",
        "kind": "op"
      },
      "opScope": {
        "domain": "git",
        "kind": "domain"
      },
      "origins": [
        "local",
        "ssh",
        "relay"
      ],
      "params": "GitPullParams",
      "result": "JsonValue",
      "scope": {
        "field": "cwd",
        "kind": "repo"
      }
    },
    {
      "class": "C2",
      "method": "git/fetch",
      "mutation": {
        "domain": "git",
        "kind": "op"
      },
      "opScope": {
        "domain": "git",
        "kind": "domain"
      },
      "origins": [
        "local",
        "ssh",
        "relay"
      ],
      "params": "GitFetchParams",
      "result": "JsonValue",
      "scope": {
        "field": "cwd",
        "kind": "repo"
      }
    },
    {
      "class": "C2",
      "method": "git/sync",
      "mutation": {
        "domain": "git",
        "kind": "op"
      },
      "opScope": {
        "domain": "git",
        "kind": "domain"
      },
      "origins": [
        "local",
        "ssh",
        "relay"
      ],
      "params": "GitSyncParams",
      "result": "JsonValue",
      "scope": {
        "field": "cwd",
        "kind": "repo"
      }
    },
    {
      "class": "C2",
      "method": "git/stash",
      "mutation": {
        "domain": "git",
        "kind": "op"
      },
      "opScope": {
        "domain": "git",
        "kind": "domain"
      },
      "origins": [
        "local",
        "ssh",
        "relay"
      ],
      "params": "GitStashParams",
      "result": "JsonValue",
      "scope": {
        "field": "cwd",
        "kind": "repo"
      }
    },
    {
      "class": "C2",
      "method": "git/stashPop",
      "mutation": {
        "domain": "git",
        "kind": "op"
      },
      "opScope": {
        "domain": "git",
        "kind": "domain"
      },
      "origins": [
        "local",
        "ssh",
        "relay"
      ],
      "params": "GitStashPopParams",
      "result": "JsonValue",
      "scope": {
        "field": "cwd",
        "kind": "repo"
      }
    },
    {
      "class": "C2",
      "method": "git/stashApply",
      "mutation": {
        "domain": "git",
        "kind": "op"
      },
      "opScope": {
        "domain": "git",
        "kind": "domain"
      },
      "origins": [
        "local",
        "ssh",
        "relay"
      ],
      "params": "GitStashApplyParams",
      "result": "JsonValue",
      "scope": {
        "field": "cwd",
        "kind": "repo"
      }
    },
    {
      "class": "C2",
      "method": "git/stashDrop",
      "mutation": {
        "domain": "git",
        "kind": "op"
      },
      "opScope": {
        "domain": "git",
        "kind": "domain"
      },
      "origins": [
        "local",
        "ssh",
        "relay"
      ],
      "params": "GitStashDropParams",
      "result": "JsonValue",
      "scope": {
        "field": "cwd",
        "kind": "repo"
      }
    },
    {
      "class": "C2",
      "method": "git/createTag",
      "mutation": {
        "domain": "git",
        "kind": "op"
      },
      "opScope": {
        "domain": "git",
        "kind": "domain"
      },
      "origins": [
        "local",
        "ssh",
        "relay"
      ],
      "params": "GitCreateTagParams",
      "result": "JsonValue",
      "scope": {
        "field": "cwd",
        "kind": "repo"
      }
    },
    {
      "class": "C2",
      "method": "git/deleteTag",
      "mutation": {
        "domain": "git",
        "kind": "op"
      },
      "opScope": {
        "domain": "git",
        "kind": "domain"
      },
      "origins": [
        "local",
        "ssh",
        "relay"
      ],
      "params": "GitDeleteTagParams",
      "result": "JsonValue",
      "scope": {
        "field": "cwd",
        "kind": "repo"
      }
    },
    {
      "class": "C2",
      "method": "git/deleteBranch",
      "mutation": {
        "domain": "git",
        "kind": "op"
      },
      "opScope": {
        "domain": "git",
        "kind": "domain"
      },
      "origins": [
        "local",
        "ssh",
        "relay"
      ],
      "params": "GitDeleteBranchParams",
      "result": "JsonValue",
      "scope": {
        "field": "cwd",
        "kind": "repo"
      }
    },
    {
      "class": "C2",
      "method": "git/renameBranch",
      "mutation": {
        "domain": "git",
        "kind": "op"
      },
      "opScope": {
        "domain": "git",
        "kind": "domain"
      },
      "origins": [
        "local",
        "ssh",
        "relay"
      ],
      "params": "GitRenameBranchParams",
      "result": "JsonValue",
      "scope": {
        "field": "cwd",
        "kind": "repo"
      }
    },
    {
      "class": "C2",
      "method": "git/resetToCommit",
      "mutation": {
        "domain": "git",
        "kind": "op"
      },
      "opScope": {
        "domain": "git",
        "kind": "domain"
      },
      "origins": [
        "local",
        "ssh",
        "relay"
      ],
      "params": "GitResetToCommitParams",
      "result": "JsonValue",
      "scope": {
        "field": "cwd",
        "kind": "repo"
      }
    },
    {
      "class": "C2",
      "method": "git/revertCommit",
      "mutation": {
        "domain": "git",
        "kind": "op"
      },
      "opScope": {
        "domain": "git",
        "kind": "domain"
      },
      "origins": [
        "local",
        "ssh",
        "relay"
      ],
      "params": "GitRevertCommitParams",
      "result": "JsonValue",
      "scope": {
        "field": "cwd",
        "kind": "repo"
      }
    },
    {
      "class": "C2",
      "method": "git/revertFile",
      "mutation": {
        "domain": "git",
        "kind": "op"
      },
      "opScope": {
        "domain": "git",
        "kind": "domain"
      },
      "origins": [
        "local",
        "ssh",
        "relay"
      ],
      "params": "GitRevertFileParams",
      "result": "JsonValue",
      "scope": {
        "field": "cwd",
        "kind": "repo"
      }
    },
    {
      "class": "C2",
      "method": "git/cherryPickCommit",
      "mutation": {
        "domain": "git",
        "kind": "op"
      },
      "opScope": {
        "domain": "git",
        "kind": "domain"
      },
      "origins": [
        "local",
        "ssh",
        "relay"
      ],
      "params": "GitCherryPickCommitParams",
      "result": "JsonValue",
      "scope": {
        "field": "cwd",
        "kind": "repo"
      }
    },
    {
      "class": "C2",
      "method": "git/applyPatch",
      "mutation": {
        "domain": "git",
        "kind": "op"
      },
      "opScope": {
        "domain": "git",
        "kind": "domain"
      },
      "origins": [
        "local",
        "ssh",
        "relay"
      ],
      "params": "GitApplyPatchParams",
      "result": "JsonValue",
      "scope": {
        "field": "cwd",
        "kind": "repo"
      }
    },
    {
      "class": "C2",
      "method": "git/ignore",
      "mutation": {
        "domain": "git",
        "kind": "op"
      },
      "opScope": {
        "domain": "git",
        "kind": "domain"
      },
      "origins": [
        "local",
        "ssh",
        "relay"
      ],
      "params": "GitIgnoreParams",
      "result": "JsonValue",
      "scope": {
        "field": "cwd",
        "kind": "repo"
      }
    },
    {
      "class": "C2",
      "method": "git/continue",
      "mutation": {
        "domain": "git",
        "kind": "op"
      },
      "opScope": {
        "domain": "git",
        "kind": "domain"
      },
      "origins": [
        "local",
        "ssh",
        "relay"
      ],
      "params": "GitContinueParams",
      "result": "JsonValue",
      "scope": {
        "field": "cwd",
        "kind": "repo"
      }
    },
    {
      "class": "C2",
      "method": "git/abortOperation",
      "mutation": {
        "domain": "git",
        "kind": "op"
      },
      "opScope": {
        "domain": "git",
        "kind": "domain"
      },
      "origins": [
        "local",
        "ssh",
        "relay"
      ],
      "params": "GitAbortOperationParams",
      "result": "JsonValue",
      "scope": {
        "field": "cwd",
        "kind": "repo"
      }
    },
    {
      "class": "C2",
      "method": "git/globalConfig/write",
      "mutation": {
        "domain": "git",
        "kind": "op"
      },
      "opScope": {
        "domain": "git",
        "kind": "domain"
      },
      "origins": [
        "local",
        "ssh",
        "relay"
      ],
      "params": "GitGlobalConfigWriteParams",
      "result": "JsonValue",
      "scope": {
        "kind": "none"
      }
    },
    {
      "class": "C2",
      "method": "git/cli/install",
      "mutation": {
        "domain": "git",
        "kind": "op"
      },
      "opScope": {
        "domain": "git",
        "kind": "domain"
      },
      "origins": [
        "local",
        "ssh",
        "relay"
      ],
      "params": "GitCliInstallParams",
      "result": "JsonValue",
      "scope": {
        "kind": "none"
      }
    },
    {
      "class": "C1",
      "method": "github/status",
      "mutation": {
        "kind": "none"
      },
      "opScope": {
        "kind": "none"
      },
      "origins": [
        "local",
        "ssh",
        "relay"
      ],
      "params": "GithubStatusParams",
      "result": "JsonValue",
      "scope": {
        "kind": "none"
      }
    },
    {
      "class": "C1",
      "method": "github/account",
      "mutation": {
        "kind": "none"
      },
      "opScope": {
        "kind": "none"
      },
      "origins": [
        "local",
        "ssh",
        "relay"
      ],
      "params": "GithubAccountParams",
      "result": "JsonValue",
      "scope": {
        "kind": "none"
      }
    },
    {
      "class": "C2",
      "method": "github/login/start",
      "mutation": {
        "domain": "github",
        "kind": "op"
      },
      "opScope": {
        "domain": "github",
        "kind": "domain"
      },
      "origins": [
        "local",
        "ssh",
        "relay"
      ],
      "params": "GithubLoginStartParams",
      "result": "JsonValue",
      "scope": {
        "kind": "none"
      }
    },
    {
      "class": "C1",
      "method": "github/login/status",
      "mutation": {
        "kind": "none"
      },
      "opScope": {
        "kind": "none"
      },
      "origins": [
        "local",
        "ssh",
        "relay"
      ],
      "params": "GithubLoginStatusParams",
      "result": "JsonValue",
      "scope": {
        "kind": "none"
      }
    },
    {
      "class": "C2",
      "method": "github/login/openBrowser",
      "mutation": {
        "domain": "github",
        "kind": "op"
      },
      "opScope": {
        "domain": "github",
        "kind": "domain"
      },
      "origins": [
        "local",
        "ssh",
        "relay"
      ],
      "params": "GithubLoginOpenBrowserParams",
      "result": "JsonValue",
      "scope": {
        "field": "flowId",
        "kind": "keyed",
        "namespace": "githubLogin"
      }
    },
    {
      "class": "C2",
      "method": "github/login/cancel",
      "mutation": {
        "domain": "github",
        "kind": "op"
      },
      "opScope": {
        "domain": "github",
        "kind": "domain"
      },
      "origins": [
        "local",
        "ssh",
        "relay"
      ],
      "params": "GithubLoginCancelParams",
      "result": "JsonValue",
      "scope": {
        "field": "flowId",
        "kind": "keyed",
        "namespace": "githubLogin"
      }
    },
    {
      "class": "C2",
      "method": "github/logout",
      "mutation": {
        "domain": "github",
        "kind": "op"
      },
      "opScope": {
        "domain": "github",
        "kind": "domain"
      },
      "origins": [
        "local",
        "ssh",
        "relay"
      ],
      "params": "GithubLogoutParams",
      "result": "JsonValue",
      "scope": {
        "kind": "none"
      }
    },
    {
      "class": "C2",
      "method": "github/install",
      "mutation": {
        "domain": "github",
        "kind": "op"
      },
      "opScope": {
        "domain": "github",
        "kind": "domain"
      },
      "origins": [
        "local",
        "ssh",
        "relay"
      ],
      "params": "GithubInstallParams",
      "result": "JsonValue",
      "scope": {
        "kind": "none"
      }
    },
    {
      "class": "C2",
      "method": "github/request",
      "mutation": {
        "domain": "github",
        "kind": "op"
      },
      "opScope": {
        "domain": "github",
        "kind": "domain"
      },
      "origins": [
        "local",
        "ssh",
        "relay"
      ],
      "params": "GithubRequestParams",
      "result": "JsonValue",
      "scope": {
        "kind": "none"
      }
    },
    {
      "class": "C1",
      "method": "github/starStatus",
      "mutation": {
        "kind": "none"
      },
      "opScope": {
        "kind": "none"
      },
      "origins": [
        "local",
        "ssh",
        "relay"
      ],
      "params": "GithubStarStatusParams",
      "result": "JsonValue",
      "scope": {
        "kind": "none"
      }
    },
    {
      "class": "C2",
      "method": "github/star",
      "mutation": {
        "domain": "github",
        "kind": "op"
      },
      "opScope": {
        "domain": "github",
        "kind": "domain"
      },
      "origins": [
        "local",
        "ssh",
        "relay"
      ],
      "params": "GithubStarParams",
      "result": "JsonValue",
      "scope": {
        "kind": "none"
      }
    },
    {
      "class": "C1",
      "method": "github/pr/list",
      "mutation": {
        "kind": "none"
      },
      "opScope": {
        "kind": "none"
      },
      "origins": [
        "local",
        "ssh",
        "relay"
      ],
      "params": "GithubPrListParams",
      "result": "JsonValue",
      "scope": {
        "kind": "none"
      }
    },
    {
      "class": "C1",
      "method": "github/pr/view",
      "mutation": {
        "kind": "none"
      },
      "opScope": {
        "kind": "none"
      },
      "origins": [
        "local",
        "ssh",
        "relay"
      ],
      "params": "GithubPrViewParams",
      "result": "JsonValue",
      "scope": {
        "kind": "none"
      }
    },
    {
      "class": "C1",
      "method": "github/pr/diff",
      "mutation": {
        "kind": "none"
      },
      "opScope": {
        "kind": "none"
      },
      "origins": [
        "local",
        "ssh",
        "relay"
      ],
      "params": "GithubPrDiffParams",
      "result": "JsonValue",
      "scope": {
        "kind": "none"
      }
    },
    {
      "class": "C1",
      "method": "github/pr/defaultBranch",
      "mutation": {
        "kind": "none"
      },
      "opScope": {
        "kind": "none"
      },
      "origins": [
        "local",
        "ssh",
        "relay"
      ],
      "params": "GithubPrDefaultBranchParams",
      "result": "JsonValue",
      "scope": {
        "kind": "none"
      }
    },
    {
      "class": "C2",
      "method": "github/pr/create",
      "mutation": {
        "domain": "github",
        "kind": "op"
      },
      "opScope": {
        "domain": "github",
        "kind": "domain"
      },
      "origins": [
        "local",
        "ssh",
        "relay"
      ],
      "params": "GithubPrCreateParams",
      "result": "JsonValue",
      "scope": {
        "kind": "none"
      }
    },
    {
      "class": "C2",
      "method": "github/pr/checkout",
      "mutation": {
        "domain": "github",
        "kind": "op"
      },
      "opScope": {
        "domain": "github",
        "kind": "domain"
      },
      "origins": [
        "local",
        "ssh",
        "relay"
      ],
      "params": "GithubPrCheckoutParams",
      "result": "JsonValue",
      "scope": {
        "field": "cwd",
        "kind": "repo"
      }
    },
    {
      "class": "C2",
      "method": "github/pr/merge",
      "mutation": {
        "domain": "github",
        "kind": "op"
      },
      "opScope": {
        "domain": "github",
        "kind": "domain"
      },
      "origins": [
        "local",
        "ssh",
        "relay"
      ],
      "params": "GithubPrMergeParams",
      "result": "JsonValue",
      "scope": {
        "kind": "none"
      }
    },
    {
      "class": "C1",
      "method": "review/diff/get",
      "mutation": {
        "kind": "none"
      },
      "opScope": {
        "kind": "none"
      },
      "origins": [
        "local",
        "ssh",
        "relay"
      ],
      "params": "v2::domain::ReviewDiffGetParams",
      "result": "JsonValue",
      "scope": {
        "kind": "none"
      }
    },
    {
      "class": "C2",
      "method": "process/spawn",
      "mutation": {
        "domain": "process",
        "kind": "op"
      },
      "opScope": {
        "domain": "process",
        "kind": "domain"
      },
      "origins": [
        "local",
        "ssh"
      ],
      "params": "v2::domain::ProcessSpawnParams",
      "result": "v2::feed::Subscription",
      "scope": {
        "field": "processHandle",
        "kind": "process"
      }
    },
    {
      "class": "C2",
      "method": "process/kill",
      "mutation": {
        "kind": "none"
      },
      "opScope": {
        "kind": "none"
      },
      "origins": [
        "local",
        "ssh"
      ],
      "params": "ProcessKillParams",
      "result": "v2::feed::EmptyResult",
      "scope": {
        "field": "processHandle",
        "kind": "process"
      }
    },
    {
      "class": "C2",
      "method": "process/resizePty",
      "mutation": {
        "kind": "none"
      },
      "opScope": {
        "kind": "none"
      },
      "origins": [
        "local",
        "ssh"
      ],
      "params": "ProcessResizePtyParams",
      "result": "v2::feed::EmptyResult",
      "scope": {
        "field": "processHandle",
        "kind": "process"
      }
    },
    {
      "class": "C2",
      "method": "process/writeStdin",
      "mutation": {
        "kind": "none"
      },
      "opScope": {
        "kind": "none"
      },
      "origins": [
        "local",
        "ssh"
      ],
      "params": "ProcessWriteStdinParams",
      "result": "v2::feed::EmptyResult",
      "scope": {
        "field": "processHandle",
        "kind": "process"
      }
    },
    {
      "class": "C2",
      "method": "terminal/ensure",
      "mutation": {
        "domain": "terminal",
        "kind": "op"
      },
      "opScope": {
        "domain": "terminal",
        "kind": "domain"
      },
      "origins": [
        "local",
        "ssh",
        "relay"
      ],
      "params": "TerminalEnsureParams",
      "result": "JsonValue",
      "scope": {
        "field": "tabId",
        "kind": "terminalOrNone"
      }
    },
    {
      "class": "C2",
      "method": "terminal/attach",
      "mutation": {
        "kind": "none"
      },
      "opScope": {
        "kind": "none"
      },
      "origins": [
        "local",
        "ssh",
        "relay"
      ],
      "params": "TerminalAttachParams",
      "result": "JsonValue",
      "scope": {
        "field": "tabId",
        "kind": "terminal"
      }
    },
    {
      "class": "C1",
      "method": "terminal/profiles",
      "mutation": {
        "kind": "none"
      },
      "opScope": {
        "kind": "none"
      },
      "origins": [
        "local",
        "ssh",
        "relay"
      ],
      "params": "TerminalProfilesParams",
      "result": "JsonValue",
      "scope": {
        "kind": "none"
      }
    },
    {
      "class": "C2",
      "method": "terminal/focus",
      "mutation": {
        "kind": "none"
      },
      "opScope": {
        "kind": "none"
      },
      "origins": [
        "local",
        "ssh",
        "relay"
      ],
      "params": "TerminalFocusParams",
      "result": "v2::feed::EmptyResult",
      "scope": {
        "field": "tabId",
        "kind": "terminal"
      }
    },
    {
      "class": "C2",
      "method": "terminal/pause",
      "mutation": {
        "kind": "none"
      },
      "opScope": {
        "kind": "none"
      },
      "origins": [
        "local",
        "ssh"
      ],
      "params": "TerminalPauseParams",
      "result": "v2::feed::EmptyResult",
      "scope": {
        "field": "tabId",
        "kind": "terminal"
      }
    },
    {
      "class": "C2",
      "method": "terminal/resume",
      "mutation": {
        "kind": "none"
      },
      "opScope": {
        "kind": "none"
      },
      "origins": [
        "local",
        "ssh"
      ],
      "params": "TerminalResumeParams",
      "result": "v2::feed::EmptyResult",
      "scope": {
        "field": "tabId",
        "kind": "terminal"
      }
    },
    {
      "class": "C2",
      "method": "terminal/dispose",
      "mutation": {
        "domain": "terminal",
        "kind": "op"
      },
      "opScope": {
        "domain": "terminal",
        "kind": "domain"
      },
      "origins": [
        "local",
        "ssh",
        "relay"
      ],
      "params": "TerminalDisposeParams",
      "result": "v2::feed::EmptyResult",
      "scope": {
        "field": "tabId",
        "kind": "terminal"
      }
    },
    {
      "class": "C1",
      "method": "system/ports/subscribe",
      "mutation": {
        "kind": "none"
      },
      "opScope": {
        "kind": "none"
      },
      "origins": [
        "local",
        "ssh"
      ],
      "params": "SystemPortsSubscribeParams",
      "result": "v2::feed::Subscription",
      "scope": {
        "kind": "none"
      }
    },
    {
      "class": "C1",
      "method": "system/ports/unsubscribe",
      "mutation": {
        "kind": "none"
      },
      "opScope": {
        "kind": "none"
      },
      "origins": [
        "local",
        "ssh"
      ],
      "params": "SystemPortsUnsubscribeParams",
      "result": "v2::feed::EmptyResult",
      "scope": {
        "kind": "none"
      }
    },
    {
      "class": "C2",
      "method": "remoteAccess/setEnabled",
      "mutation": {
        "domain": "remoteAccess",
        "kind": "op"
      },
      "opScope": {
        "domain": "remoteAccess",
        "kind": "domain"
      },
      "origins": [
        "local",
        "ssh"
      ],
      "params": "RemoteAccessSetEnabledParams",
      "result": "JsonValue",
      "scope": {
        "key": "remoteAccess",
        "kind": "global"
      }
    },
    {
      "class": "C2",
      "method": "remoteAccess/setName",
      "mutation": {
        "domain": "remoteAccess",
        "kind": "op"
      },
      "opScope": {
        "domain": "remoteAccess",
        "kind": "domain"
      },
      "origins": [
        "local",
        "ssh"
      ],
      "params": "RemoteAccessSetNameParams",
      "result": "JsonValue",
      "scope": {
        "key": "remoteAccess",
        "kind": "global"
      }
    },
    {
      "class": "C2",
      "method": "remoteAccess/setClientAlias",
      "mutation": {
        "domain": "remoteAccess",
        "kind": "op"
      },
      "opScope": {
        "domain": "remoteAccess",
        "kind": "domain"
      },
      "origins": [
        "local",
        "ssh"
      ],
      "params": "RemoteAccessSetClientAliasParams",
      "result": "JsonValue",
      "scope": {
        "key": "remoteAccess",
        "kind": "global"
      }
    },
    {
      "class": "C2",
      "method": "remoteAccess/rotate",
      "mutation": {
        "domain": "remoteAccess",
        "kind": "op"
      },
      "opScope": {
        "domain": "remoteAccess",
        "kind": "domain"
      },
      "origins": [
        "local",
        "ssh"
      ],
      "params": "RemoteAccessRotateParams",
      "result": "JsonValue",
      "scope": {
        "key": "remoteAccess",
        "kind": "global"
      }
    },
    {
      "class": "C2",
      "method": "remoteAccess/resolveClaim",
      "mutation": {
        "domain": "remoteAccess",
        "kind": "op"
      },
      "opScope": {
        "domain": "remoteAccess",
        "kind": "domain"
      },
      "origins": [
        "local",
        "ssh"
      ],
      "params": "RemoteAccessResolveClaimParams",
      "result": "JsonValue",
      "scope": {
        "key": "remoteAccess",
        "kind": "global"
      }
    },
    {
      "class": "C2",
      "method": "remoteAccess/pairCode",
      "mutation": {
        "domain": "remoteAccess",
        "kind": "op"
      },
      "opScope": {
        "domain": "remoteAccess",
        "kind": "domain"
      },
      "origins": [
        "local",
        "ssh"
      ],
      "params": "RemoteAccessPairCodeParams",
      "result": "JsonValue",
      "scope": {
        "key": "remoteAccess",
        "kind": "global"
      }
    },
    {
      "class": "C2",
      "method": "remoteAccess/revokeClient",
      "mutation": {
        "domain": "remoteAccess",
        "kind": "op"
      },
      "opScope": {
        "domain": "remoteAccess",
        "kind": "domain"
      },
      "origins": [
        "local",
        "ssh"
      ],
      "params": "RemoteAccessRevokeClientParams",
      "result": "JsonValue",
      "scope": {
        "key": "remoteAccess",
        "kind": "global"
      }
    },
    {
      "class": "C2",
      "method": "remoteAccess/settleOwedControllerKeys",
      "mutation": {
        "domain": "remoteAccess",
        "kind": "op"
      },
      "opScope": {
        "domain": "remoteAccess",
        "kind": "domain"
      },
      "origins": [
        "local",
        "ssh"
      ],
      "params": "RemoteAccessSettleOwedControllerKeysParams",
      "result": "JsonValue",
      "scope": {
        "key": "remoteAccess",
        "kind": "global"
      }
    },
    {
      "class": "C2",
      "method": "remoteAccess/deliverScreenControllerKey",
      "mutation": {
        "domain": "remoteAccess",
        "kind": "op"
      },
      "opScope": {
        "domain": "remoteAccess",
        "kind": "domain"
      },
      "origins": [
        "local",
        "ssh",
        "relay"
      ],
      "params": "RemoteAccessDeliverScreenControllerKeyParams",
      "result": "JsonValue",
      "scope": {
        "key": "remoteAccess",
        "kind": "global"
      }
    },
    {
      "class": "C1",
      "method": "remoteAccess/pushPublicKey",
      "mutation": {
        "kind": "none"
      },
      "opScope": {
        "kind": "none"
      },
      "origins": [
        "local",
        "ssh",
        "relay"
      ],
      "params": "RemoteAccessPushPublicKeyParams",
      "result": "JsonValue",
      "scope": {
        "kind": "none"
      }
    },
    {
      "class": "C2",
      "method": "remoteAccess/registerPushSubscription",
      "mutation": {
        "domain": "remoteAccess",
        "kind": "op"
      },
      "opScope": {
        "domain": "remoteAccess",
        "kind": "domain"
      },
      "origins": [
        "local",
        "ssh",
        "relay"
      ],
      "params": "RemoteAccessRegisterPushSubscriptionParams",
      "result": "JsonValue",
      "scope": {
        "key": "remoteAccess",
        "kind": "global"
      }
    },
    {
      "class": "C2",
      "method": "remoteAccess/removePushSubscription",
      "mutation": {
        "domain": "remoteAccess",
        "kind": "op"
      },
      "opScope": {
        "domain": "remoteAccess",
        "kind": "domain"
      },
      "origins": [
        "local",
        "ssh",
        "relay"
      ],
      "params": "RemoteAccessRemovePushSubscriptionParams",
      "result": "JsonValue",
      "scope": {
        "key": "remoteAccess",
        "kind": "global"
      }
    },
    {
      "class": "C2",
      "method": "remoteAccess/registerNativePush",
      "mutation": {
        "domain": "remoteAccess",
        "kind": "op"
      },
      "opScope": {
        "domain": "remoteAccess",
        "kind": "domain"
      },
      "origins": [
        "local",
        "ssh",
        "relay"
      ],
      "params": "RemoteAccessRegisterNativePushParams",
      "result": "JsonValue",
      "scope": {
        "key": "remoteAccess",
        "kind": "global"
      }
    },
    {
      "class": "C2",
      "method": "remoteAccess/removeNativePush",
      "mutation": {
        "domain": "remoteAccess",
        "kind": "op"
      },
      "opScope": {
        "domain": "remoteAccess",
        "kind": "domain"
      },
      "origins": [
        "local",
        "ssh",
        "relay"
      ],
      "params": "RemoteAccessRemoveNativePushParams",
      "result": "JsonValue",
      "scope": {
        "key": "remoteAccess",
        "kind": "global"
      }
    },
    {
      "class": "C2",
      "method": "remoteAccess/activate",
      "mutation": {
        "domain": "remoteAccess",
        "kind": "op"
      },
      "opScope": {
        "domain": "remoteAccess",
        "kind": "domain"
      },
      "origins": [
        "local",
        "ssh"
      ],
      "params": "RemoteAccessActivateParams",
      "result": "JsonValue",
      "scope": {
        "key": "remoteAccess",
        "kind": "global"
      }
    },
    {
      "class": "C1",
      "method": "remoteAccess/state",
      "mutation": {
        "kind": "none"
      },
      "opScope": {
        "kind": "none"
      },
      "origins": [
        "local",
        "ssh",
        "relay"
      ],
      "params": "RemoteAccessStateParams",
      "result": "JsonValue",
      "scope": {
        "kind": "none"
      }
    },
    {
      "class": "C2",
      "method": "browser/command",
      "mutation": {
        "kind": "none"
      },
      "opScope": {
        "kind": "none"
      },
      "origins": [
        "local",
        "ssh",
        "relay"
      ],
      "params": "BrowserCommandParams",
      "result": "JsonValue",
      "scope": {
        "kind": "none"
      }
    },
    {
      "class": "C2",
      "method": "visualize/command",
      "mutation": {
        "kind": "none"
      },
      "opScope": {
        "kind": "none"
      },
      "origins": [
        "local",
        "ssh",
        "relay"
      ],
      "params": "VisualizeCommandParams",
      "result": "JsonValue",
      "scope": {
        "kind": "none"
      }
    },
    {
      "class": "C2",
      "method": "notify/test",
      "mutation": {
        "domain": "notify",
        "kind": "op"
      },
      "opScope": {
        "domain": "notify",
        "kind": "domain"
      },
      "origins": [
        "local",
        "ssh",
        "relay"
      ],
      "params": "NotifyTestParams",
      "result": "JsonValue",
      "scope": {
        "kind": "none"
      }
    },
    {
      "class": "C2",
      "method": "host/claim",
      "mutation": {
        "kind": "none"
      },
      "opScope": {
        "kind": "none"
      },
      "origins": [
        "local",
        "ssh"
      ],
      "params": "v2::host::HostClaimParams",
      "result": "v2::feed::EmptyResult",
      "scope": {
        "key": "host",
        "kind": "global"
      }
    },
    {
      "class": "C2",
      "method": "host/state/set",
      "mutation": {
        "kind": "none"
      },
      "opScope": {
        "kind": "none"
      },
      "origins": [
        "local",
        "ssh"
      ],
      "params": "v2::host::HostStateSetParams",
      "result": "v2::feed::EmptyResult",
      "scope": {
        "key": "host",
        "kind": "global"
      }
    },
    {
      "class": "C2",
      "method": "host/remoteTarget/set",
      "mutation": {
        "kind": "none"
      },
      "opScope": {
        "kind": "none"
      },
      "origins": [
        "local",
        "ssh"
      ],
      "params": "v2::host::HostRemoteTargetSetParams",
      "result": "v2::feed::EmptyResult",
      "scope": {
        "key": "host",
        "kind": "global"
      }
    },
    {
      "class": "C2",
      "method": "modelProxy/run",
      "mutation": {
        "kind": "none"
      },
      "opScope": {
        "kind": "none"
      },
      "origins": [
        "local",
        "ssh"
      ],
      "params": "v2::host::ModelProxyRunParams",
      "result": "v2::host::ModelProxyResult",
      "scope": {
        "kind": "none"
      }
    }
  ],
  "clientNotifications": [
    {
      "delivery": null,
      "method": "initialized",
      "params": "()"
    },
    {
      "delivery": null,
      "method": "terminal/input",
      "params": "TerminalInputParams"
    },
    {
      "delivery": null,
      "method": "terminal/resize",
      "params": "TerminalResizeParams"
    },
    {
      "delivery": null,
      "method": "process/input",
      "params": "ProcessInputParams"
    },
    {
      "delivery": null,
      "method": "client/activity",
      "params": "ClientActivityParams"
    },
    {
      "delivery": null,
      "method": "client/perfLog",
      "params": "ClientPerfLogParams"
    },
    {
      "delivery": null,
      "method": "host/power",
      "params": "HostPowerParams"
    },
    {
      "delivery": null,
      "method": "host/update/report",
      "params": "HostUpdateReportParams"
    },
    {
      "delivery": null,
      "method": "host/browser/surface",
      "params": "HostBrowserSurfaceParams"
    },
    {
      "delivery": null,
      "method": "host/notification/clicked",
      "params": "HostNotificationClickedParams"
    },
    {
      "delivery": null,
      "method": "model/proxy/event",
      "params": "ModelProxyEventParams"
    },
    {
      "delivery": null,
      "method": "model/proxy/heartbeat",
      "params": "ModelProxyHeartbeatParams"
    },
    {
      "delivery": null,
      "method": "modelProxy/cancel",
      "params": "ModelProxyRunCancelParams"
    },
    {
      "delivery": null,
      "method": "ui/newTab/created",
      "params": "UiNewTabCreatedParams"
    },
    {
      "delivery": null,
      "method": "ui/terminalRun/claimed",
      "params": "UiTerminalRunClaimedParams"
    },
    {
      "delivery": null,
      "method": "ui/screenSessions/changed",
      "params": "UiScreenSessionsChangedParams"
    }
  ],
  "serverNotifications": [
    {
      "delivery": "thread",
      "method": "thread/snapshot",
      "params": "ThreadSnapshotParams"
    },
    {
      "delivery": "thread",
      "method": "thread/closed",
      "params": "ThreadIdParams"
    },
    {
      "delivery": "thread",
      "method": "thread/status/changed",
      "params": "ThreadStatusChangedParams"
    },
    {
      "delivery": "thread",
      "method": "thread/name/updated",
      "params": "ThreadNameUpdatedParams"
    },
    {
      "delivery": "thread",
      "method": "thread/tokenUsage/updated",
      "params": "TokenUsageUpdatedParams"
    },
    {
      "delivery": "thread",
      "method": "thread/goal/updated",
      "params": "ThreadValueParams"
    },
    {
      "delivery": "thread",
      "method": "thread/goal/cleared",
      "params": "ThreadIdParams"
    },
    {
      "delivery": "thread",
      "method": "thread/queue/changed",
      "params": "ThreadQueueChangedParams"
    },
    {
      "delivery": "thread",
      "method": "turn/started",
      "params": "TurnNotificationParams"
    },
    {
      "delivery": "thread",
      "method": "turn/completed",
      "params": "TurnNotificationParams"
    },
    {
      "delivery": "thread",
      "method": "thread/notification",
      "params": "ThreadNotificationParams"
    },
    {
      "delivery": "thread",
      "method": "thread/modelRequest/updated",
      "params": "ModelRequestUpdatedParams"
    },
    {
      "delivery": "thread",
      "method": "thread/toolBatch/updated",
      "params": "ToolBatchUpdatedParams"
    },
    {
      "delivery": "thread",
      "method": "item/started",
      "params": "ItemNotificationParams"
    },
    {
      "delivery": "thread",
      "method": "item/completed",
      "params": "ItemNotificationParams"
    },
    {
      "delivery": "thread",
      "method": "item/agentMessage/delta",
      "params": "ItemDeltaParams"
    },
    {
      "delivery": "thread",
      "method": "item/reasoning/textDelta",
      "params": "ItemDeltaParams"
    },
    {
      "delivery": "thread",
      "method": "item/reasoning/summaryTextDelta",
      "params": "ItemDeltaParams"
    },
    {
      "delivery": "thread",
      "method": "thread/historyReset",
      "params": "ThreadHistoryResetParams"
    },
    {
      "delivery": "thread",
      "method": "thread/runtime/updated",
      "params": "ThreadSectionParams<ThreadRuntime>"
    },
    {
      "delivery": "thread",
      "method": "thread/route/updated",
      "params": "ThreadSectionParams<ThreadRoute>"
    },
    {
      "delivery": "thread",
      "method": "thread/context/updated",
      "params": "ThreadSectionParams<ThreadContext>"
    },
    {
      "delivery": "thread",
      "method": "thread/todo/updated",
      "params": "ThreadSectionParams<Option<JsonValue>>"
    },
    {
      "delivery": "thread",
      "method": "thread/quotaResume/updated",
      "params": "ThreadSectionParams<Option<QuotaResume>>"
    },
    {
      "delivery": "thread",
      "method": "thread/agents/updated",
      "params": "ThreadSectionParams<ThreadAgents>"
    },
    {
      "delivery": "thread",
      "method": "thread/shellJobs/updated",
      "params": "ThreadSectionParams<JsonValue>"
    },
    {
      "delivery": "thread",
      "method": "thread/workflow/updated",
      "params": "ThreadSectionParams<ThreadWorkflow>"
    },
    {
      "delivery": "thread",
      "method": "thread/workspace/updated",
      "params": "ThreadSectionParams<Option<JsonValue>>"
    },
    {
      "delivery": "thread",
      "method": "thread/approvals/updated",
      "params": "ThreadSectionParams<ThreadApprovals>"
    },
    {
      "delivery": "thread",
      "method": "thread/promptRestore",
      "params": "ThreadSectionParams<Option<PromptRestore>>"
    },
    {
      "delivery": "thread",
      "method": "thread/providerAccount/changed",
      "params": "ThreadSectionParams<Option<ProviderAccountChange>>"
    },
    {
      "delivery": "thread",
      "method": "thread/promptHistory/updated",
      "params": "ThreadSectionParams<PromptHistoryChange>"
    },
    {
      "delivery": "thread",
      "method": "thread/remote/updated",
      "params": "ThreadSectionParams<bool>"
    },
    {
      "delivery": "thread",
      "method": "thread/setupUiRequest/updated",
      "params": "ThreadSectionParams<Option<SetupUiRequest>>"
    },
    {
      "delivery": "thread",
      "method": "thread/roomView/updated",
      "params": "ThreadSectionParams<Option<ThreadRoomView>>"
    },
    {
      "delivery": "thread",
      "method": "review/diff/updated",
      "params": "SectionUpdate"
    },
    {
      "delivery": "connection",
      "method": "error",
      "params": "ErrorNotificationParams"
    },
    {
      "delivery": "connection",
      "method": "serverRequest/resolved",
      "params": "ServerRequestResolvedParams"
    },
    {
      "delivery": "connection",
      "method": "host/notification/show",
      "params": "HostNotificationShowParams"
    },
    {
      "delivery": "connection",
      "method": "host/browser/viewFrames",
      "params": "HostBrowserViewFramesParams"
    },
    {
      "delivery": "connection",
      "method": "modelProxy/run/event",
      "params": "ModelProxyRunEventParams"
    },
    {
      "delivery": "connection",
      "method": "model/proxy/cancel",
      "params": "ModelProxyCancelParams"
    },
    {
      "delivery": "app",
      "method": "app/snapshot",
      "params": "AppSnapshotParams"
    },
    {
      "delivery": "app",
      "method": "thread/started",
      "params": "ThreadStartedParams"
    },
    {
      "delivery": "app",
      "method": "thread/summary/updated",
      "params": "ThreadSummaryUpdatedParams"
    },
    {
      "delivery": "app",
      "method": "thread/deleted",
      "params": "ThreadIdParams"
    },
    {
      "delivery": "app",
      "method": "thread/archived",
      "params": "ThreadIdParams"
    },
    {
      "delivery": "app",
      "method": "thread/unarchived",
      "params": "ThreadIdParams"
    },
    {
      "delivery": "app",
      "method": "warning",
      "params": "WarningParams"
    },
    {
      "delivery": "app",
      "method": "configWarning",
      "params": "WarningParams"
    },
    {
      "delivery": "app",
      "method": "ui/openRequested",
      "params": "UiOpenRequestedParams"
    },
    {
      "delivery": "app",
      "method": "remote/pointer",
      "params": "RemotePointerParams"
    },
    {
      "delivery": "app",
      "method": "core/drain",
      "params": "CoreDrainParams"
    },
    {
      "delivery": "app",
      "method": "config/updated",
      "params": "SectionUpdate"
    },
    {
      "delivery": "app",
      "method": "project/updated",
      "params": "SectionUpdate"
    },
    {
      "delivery": "app",
      "method": "agent/pool/updated",
      "params": "SectionUpdate"
    },
    {
      "delivery": "app",
      "method": "agent/list/updated",
      "params": "SectionUpdate"
    },
    {
      "delivery": "app",
      "method": "agent/botOrder/updated",
      "params": "SectionUpdate"
    },
    {
      "delivery": "app",
      "method": "model/presets/updated",
      "params": "SectionUpdate"
    },
    {
      "delivery": "app",
      "method": "model/catalog/updated",
      "params": "SectionUpdate"
    },
    {
      "delivery": "app",
      "method": "workflow/list/updated",
      "params": "SectionUpdate"
    },
    {
      "delivery": "app",
      "method": "webSearch/updated",
      "params": "SectionUpdate"
    },
    {
      "delivery": "app",
      "method": "toolModules/updated",
      "params": "SectionUpdate"
    },
    {
      "delivery": "app",
      "method": "account/updated",
      "params": "SectionUpdate"
    },
    {
      "delivery": "app",
      "method": "usage/updated",
      "params": "SectionUpdate"
    },
    {
      "delivery": "app",
      "method": "shellJobs/host/updated",
      "params": "SectionUpdate"
    },
    {
      "delivery": "app",
      "method": "terminal/activity/updated",
      "params": "SectionUpdate"
    },
    {
      "delivery": "app",
      "method": "terminal/tabs/updated",
      "params": "SectionUpdate"
    },
    {
      "delivery": "app",
      "method": "remote/state/updated",
      "params": "SectionUpdate"
    },
    {
      "delivery": "app",
      "method": "notice/updated",
      "params": "SectionUpdate"
    },
    {
      "delivery": "app",
      "method": "update/status/updated",
      "params": "SectionUpdate"
    },
    {
      "delivery": "app",
      "method": "host/state/updated",
      "params": "SectionUpdate"
    },
    {
      "delivery": "app",
      "method": "computer/updated",
      "params": "SectionUpdate"
    },
    {
      "delivery": "app",
      "method": "approval/inbox/updated",
      "params": "SectionUpdate"
    },
    {
      "delivery": "app",
      "method": "core/state/updated",
      "params": "SectionUpdate"
    },
    {
      "delivery": "app",
      "method": "core/health/updated",
      "params": "SectionUpdate"
    },
    {
      "delivery": "app",
      "method": "migration/progress",
      "params": "SectionUpdate"
    },
    {
      "delivery": "anyScoped",
      "method": "feed/snapshot",
      "params": "FeedSnapshotParams"
    },
    {
      "delivery": {
        "scoped": "fs"
      },
      "method": "fs/changed",
      "params": "FsChangedParams"
    },
    {
      "delivery": {
        "scoped": "search"
      },
      "method": "search/updated",
      "params": "SearchUpdatedParams"
    },
    {
      "delivery": {
        "scoped": "search"
      },
      "method": "search/completed",
      "params": "SearchCompletedParams"
    },
    {
      "delivery": {
        "scoped": "process"
      },
      "method": "process/outputDelta",
      "params": "ProcessOutputDeltaParams"
    },
    {
      "delivery": {
        "scoped": "process"
      },
      "method": "process/exited",
      "params": "ProcessExitedParams"
    },
    {
      "delivery": {
        "scoped": "login"
      },
      "method": "login/updated",
      "params": "LoginUpdatedParams"
    },
    {
      "delivery": {
        "scoped": "git"
      },
      "method": "git/status/updated",
      "params": "SectionUpdate"
    },
    {
      "delivery": {
        "scoped": "lsp"
      },
      "method": "lsp/status/updated",
      "params": "SectionUpdate"
    },
    {
      "delivery": {
        "scoped": "lsp"
      },
      "method": "lsp/diagnostics/updated",
      "params": "SectionUpdate"
    },
    {
      "delivery": {
        "scoped": "media"
      },
      "method": "media/job/updated",
      "params": "SectionUpdate"
    },
    {
      "delivery": {
        "scoped": "ports"
      },
      "method": "system/ports/updated",
      "params": "SectionUpdate"
    }
  ],
  "serverRequests": [
    {
      "method": "item/tool/requestApproval",
      "params": "ToolApprovalRequestParams",
      "requires": null,
      "result": "ToolApprovalDecision"
    },
    {
      "method": "item/tool/requestUserInput",
      "params": "UserInputRequestParams",
      "requires": null,
      "result": "ToolApprovalDecision"
    },
    {
      "method": "item/permissions/requestApproval",
      "params": "PermissionsRequestParams",
      "requires": null,
      "result": "ToolApprovalDecision"
    },
    {
      "method": "item/browser/requestApproval",
      "params": "BrowserApprovalRequestParams",
      "requires": null,
      "result": "ToolApprovalDecision"
    },
    {
      "method": "item/computer/requestApproval",
      "params": "ComputerApprovalRequestParams",
      "requires": null,
      "result": "ToolApprovalDecision"
    },
    {
      "method": "host/browser/command",
      "params": "HostCommandParams",
      "requires": "host.browser",
      "result": "JsonValue"
    },
    {
      "method": "host/visualize/command",
      "params": "HostVisualizeCommandParams",
      "requires": "host.visualize",
      "result": "Option<JsonValue>"
    },
    {
      "method": "host/systemProxy/resolve",
      "params": "HostSystemProxyResolveParams",
      "requires": "host.systemProxy",
      "result": "HostSystemProxyResolveResponse"
    },
    {
      "method": "host/notification/status",
      "params": "HostNotificationStatusParams",
      "requires": "host.notifications",
      "result": "HostNotificationStatus"
    },
    {
      "method": "host/update/command",
      "params": "HostUpdateCommandParams",
      "requires": "host.updater",
      "result": "JsonValue"
    },
    {
      "method": "host/capture/fileSnapshot",
      "params": "HostFileSnapshotParams",
      "requires": "host.files",
      "result": "HostFileSnapshot"
    },
    {
      "method": "host/localPage/url",
      "params": "HostLocalPageUrlParams",
      "requires": "host.files",
      "result": "String"
    },
    {
      "method": "model/proxy/execute",
      "params": "ModelProxyExecuteParams",
      "requires": "modelProxy",
      "result": "ModelProxyResult"
    }
  ]
} as const;

export type MethodTable = typeof methodTable;
export type MethodSpec = MethodTable["clientMethods"][number];
