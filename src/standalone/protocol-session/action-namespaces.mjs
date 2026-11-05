// Session action -> protocol namespace (protocol.md §12.4: "Method = <namespace>/<action>, with the action name verbatim").
// Data only; the few actions whose method or params are not the verbatim form are in action-overrides.mjs.
export const ACTION_NAMESPACES = Object.freeze({
  thread: [
    'isSessionTerminal', 'contextStatus', 'getSessionReviewDiff', 'getSessionReviewFilePatch', 'getSessionUsage',
    'getTurnChanges', 'getTurnReviewDiff', 'getTurnReviewFilePatch', 'getTurnLiveness', 'getSessionWorktreeWork',
    'inheritancePreflight', 'listShellJobs', 'listStoppableShellJobs', 'getBranchMenu', 'clear', 'compact',
    'rewindToItem', 'prioritizeQueued', 'restoreQueued', 'retryFailedTurn', 'inheritFrom', 'continueSessionInModel',
    'goalControl', 'renameSessionTitle', 'deleteSession', 'deleteSessionIfIdle', 'askSide', 'cancelSide',
    'agentControl', 'taskControl', 'switchContext', 'selectTools', 'setCwd', 'setEffort', 'setFast', 'toggleFast',
    'setModel', 'setRoute', 'setToolMode', 'setWorkflow', 'setOrchestrationMode', 'setOutputStyle', 'setProgressHint',
    'noteUserInput', 'stopShellJob', 'stopShellJobs', 'releaseShellJob', 'scheduleQuotaResume', 'cancelQuotaResume',
    'revertTurnReview', 'revertTurnReviewFile', 'revertTurnChanges', 'reapplyTurnChanges',
    'clearSessionChangeHistory', 'restoreNewerTranscript', 'restoreOlderTranscript', 'decideRoomTurn',
    'appendRoomRows', 'stageAttachmentOriginal', 'resizeImage', 'rememberPromptHistory', 'pushNotice', 'removeNotice',
    'requestWorktree', 'mergeWorkspace', 'selectBranch',
  ],
  project: [
    'inspectProjectBranch', 'getProjectBranchMenu', 'getProjectConnectors', 'listWorktrees', 'previewWorktreeCleanup',
    'selectProjectBranch', 'mergeProjectBranch', 'manageProjectBranch', 'removeWorktree', 'pruneWorktrees',
    'deleteWorktree', 'setArchivedSessionWorktrees', 'setProjectConnectorEnabled',
  ],
  agent: [
    'agentDefinitionPresence', 'archivedAgentIdentities', 'getAgentDefinition', 'getAgentAvatarImage',
    'getAgentConnectors', 'getAgentAlwaysAllowedTools', 'getAgentConnectorTools', 'getAgentPermissions',
    'getLeadPersona', 'getLeadAgentBody', 'getLeadStatus', 'getLeadHomeRoute', 'getLeadAppearance', 'getBotOrder',
    'listAgents', 'saveAgentDefinition', 'deleteAgentDefinition', 'restoreAgentDefinition', 'purgeAgentDefinition',
    'setAgentConnectors', 'setAgentConnectorEnabled', 'setAgentConnectorToolPermission', 'setAgentPermission',
    'recordAgentApprovalAudit', 'saveLeadPersona', 'saveLeadAgentBody', 'setLeadCreated', 'saveLeadIdentity',
    'setLeadAppearance', 'setBotOrder', 'setAgentRoute',
  ],
  instructions: [
    'listInstructionFiles', 'getInstructionFile', 'saveInstructionFile', 'resetInstructionFile',
    'setInstructionFiles',
  ],
  connector: [
    'listConnectors', 'listConnectorTools', 'addConnectorAccount',
  ],
  config: [
    'getAutoClear', 'getCacheWarmingSettings', 'getCompactionSettings', 'getDeveloperSettings', 'getOutputStyle',
    'getOrchestrationMode', 'getConfiguredOrchestrationMode', 'getProfile', 'getRecapSettings',
    'getSessionTitleSettings', 'getHeartbeatSettings', 'getReactionSettings', 'getSettingsSnapshot', 'getSystemShell',
    'getTheme', 'getToolModuleSettings', 'getUpdateSettings', 'getWorktreeSettings', 'getNetworkProxy',
    'testNetworkProxy', 'getQuotaAutoResume', 'getWorkflowPack', 'getWebSearchRoute', 'listOutputStyles',
    'listPresets', 'listThemes', 'listWorkflows', 'getOnboardingStatus', 'isSetupRequestActive', 'setAutoClear',
    'setAutoUpdate', 'setCacheWarmingEnabled', 'setCompactionSettings', 'setDeveloperOption', 'setProfile',
    'setRecapEnabled', 'setAiSessionTitles', 'setHeartbeatEnabled', 'setHeartbeatInterval', 'setReactionsEnabled',
    'setSystemShell', 'setTheme', 'setWebSearchEnabled', 'setWebSearchRoute', 'setAutoEffortBase',
    'setMemoryToolsEnabled', 'setBuiltinToolEnabled', 'installBuiltinFeature', 'setWorktreeSettings',
    'setNetworkProxy', 'setQuotaAutoResume', 'saveWorkflowPack', 'createWorkflow', 'deleteWorkflow',
    'setModelPreferences', 'skipOnboarding', 'completeOnboarding', 'saveStarterGuideState', 'claimSetupRequest',
    'completeSetupRequest', 'setExtensionScope',
  ],
  channel: [
    'getChannelSettings', 'getChannelSetup', 'getChannelWorkerStatus', 'setWebhookConfig', 'saveSchedule',
    'deleteSchedule', 'setScheduleEnabled', 'runScheduleNow', 'runWebhookNow', 'retryRoutineDelivery', 'testWebhook',
    'saveWebhook', 'deleteWebhook', 'setWebhookEnabled',
  ],
  import: [
    'getConversationImportJobs', 'listImportableConversations', 'startConversationImport', 'cancelConversationImport',
    'registerConversationImportFile',
  ],
  media: [
    'getMediaDefault', 'getMediaJob', 'getMediaPins', 'listMediaAssets', 'listMediaBoards', 'listMediaLanes',
    'readMediaAsset', 'resolveMediaFile', 'startMediaJob', 'cancelMediaJob', 'deleteMediaAsset', 'deleteMediaAssets',
    'createMediaBoard', 'renameMediaBoard', 'deleteMediaBoard', 'setMediaAssetBoard', 'setMediaDefault',
    'setMediaPin', 'cacheMediaThumbnail', 'openMediaAsset', 'openMediaFolder',
  ],
  mcp: [
    'getMcpServerConfig', 'getMcpOAuthLoginStatus', 'mcpStatus', 'addMcpServer', 'saveMcpServer', 'removeMcpServer',
    'setMcpServerEnabled', 'reconnectMcp', 'beginMcpOAuthLogin', 'cancelMcpOAuthLogin', 'completeMcpOAuthLogin',
    'signOutMcpServer', 'probeMcpServerAuth', 'enablePluginMcp',
  ],
  account: [
    'getOAuthProviderLoginStatus', 'getProviderSetup', 'getProviderAccounts', 'listProviders', 'listProviderModels',
    'listWebSearchModels', 'getQuotaHistory', 'authenticateProvider', 'beginOAuthProviderLogin',
    'completeOAuthProviderLogin', 'cancelOAuthProviderLogin', 'loginOAuthProvider', 'forgetProviderAuth',
    'updateProviderAccounts', 'saveProviderApiKey', 'saveCustomProvider', 'saveCustomProviderKey',
    'removeCustomProvider', 'updateCustomProviderModel', 'testCustomProvider', 'checkCustomProviderKeyEnv',
    'discoverCustomProviderModels', 'saveOpenAIUsageSessionKey', 'consumeCodexRateLimitResetCredit',
  ],
  localProvider: [
    'searchLocalProviderModels', 'inspectHuggingFaceModel', 'getLocalProviderModelDetails',
    'installLocalProviderModel', 'startLocalProviderInstallation', 'cancelLocalProviderInstallation',
    'discardLocalProviderInstallation', 'setLocalProviderIdleTtl', 'setLocalProviderContext',
    'registerHuggingFaceModel', 'startLocalProviderModelMaintenance', 'deleteLocalProviderModel',
  ],
  usage: [
    'getUsageDashboard', 'getUsageStats', 'getUsageRequests',
  ],
  update: [
    'getUpdateStatus', 'checkForUpdate', 'runUpdateNow',
  ],
  voice: [
    'getVoiceStatus', 'toggleVoice', 'transcribeAudio', 'prepareTranscription',
  ],
  tidy: [
    'getTidyEngineStatus', 'getTidyInstallStatus',
  ],
  skills: [
    'skillsStatus', 'skillContent', 'getDisabledSkills', 'addSkill', 'saveSkill', 'removeSkill', 'reloadSkills',
    'setDisabledSkills',
  ],
  plugins: [
    'pluginsStatus', 'addPlugin', 'updatePlugin', 'setPluginEnabled', 'removePlugin', 'reloadPlugins',
  ],
  hooks: [
    'hooksStatus', 'addHookRule', 'deleteHookRule', 'setHookRuleEnabled',
  ],
  tools: [
    'toolsStatus',
  ],
  memory: [
    'memoryControl', 'recall',
  ],
  diagnostics: [
    'runDoctor',
  ],
});
