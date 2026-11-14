//! Input validation for the `capability` methods: the protocol methods the desktop's capability calls resolve to
//! (`<namespace>/<action>` of `action-route.mjs`, plus the overrides in `action-overrides.mjs`). Ported from
//! `ipc-validation.ts` `requiredDesktopCapabilityRequest`: a capability's required arguments (the minimum of its
//! arity, as the protocol params that carry them), the structured-value bounds of its arguments, the session
//! a call addresses, the options of `retryFailedTurn`, `contextStatus` and `skillsStatus`, and the arguments
//! `validateTurnCapabilityArgs` checks (`askSide`, `revertTurnChanges`, `reapplyTurnChanges`). The rules of the
//! other groups (settings, model, prompt, worktree and import) are theirs; every message is the TypeError text the
//! host gave.
//!
//! The group answers `Some(Err)` for a refusal and `None` for everything it accepts, so the group after it for the
//! same method (`capability_settings`, `model`, `worktree_import`) still runs.

use mixdog_js::js_trim;
use mixdog_js::utf16_len;
use serde_json::Map;
use serde_json::Value;

use crate::common::path_is_absolute;
use crate::error::ErrorData;

/// `(method, capability, the params that carry the capability's required arguments)`, by method.
const CAPABILITIES: &[(&str, &str, &[&str])] = &[
    ("account/authenticateProvider", "authenticateProvider", &["providerId", "secret"]),
    ("account/beginOAuthProviderLogin", "beginOAuthProviderLogin", &["providerId"]),
    ("account/cancelOAuthProviderLogin", "cancelOAuthProviderLogin", &["flowId"]),
    ("account/checkCustomProviderKeyEnv", "checkCustomProviderKeyEnv", &["name"]),
    ("account/completeOAuthProviderLogin", "completeOAuthProviderLogin", &["flowId", "callbackUrl"]),
    ("account/consumeCodexRateLimitResetCredit", "consumeCodexRateLimitResetCredit", &["options"]),
    ("account/discoverCustomProviderModels", "discoverCustomProviderModels", &["input"]),
    ("account/forgetProviderAuth", "forgetProviderAuth", &["providerId"]),
    ("account/getOAuthProviderLoginStatus", "getOAuthProviderLoginStatus", &["flowId"]),
    ("account/getQuotaHistory", "getQuotaHistory", &[]),
    ("account/listWebSearchModels", "listWebSearchModels", &[]),
    ("account/loginOAuthProvider", "loginOAuthProvider", &["providerId"]),
    ("account/removeCustomProvider", "removeCustomProvider", &["providerId"]),
    ("account/saveCustomProvider", "saveCustomProvider", &["input"]),
    ("account/saveCustomProviderKey", "saveCustomProviderKey", &["providerId", "secret"]),
    ("account/saveOpenAIUsageSessionKey", "saveOpenAIUsageSessionKey", &["secret"]),
    ("account/saveProviderApiKey", "saveProviderApiKey", &["providerId", "secret"]),
    ("account/testCustomProvider", "testCustomProvider", &["input"]),
    ("account/updateCustomProviderModel", "updateCustomProviderModel", &["providerId", "modelId", "patch"]),
    ("account/updateProviderAccounts", "updateProviderAccounts", &["providerId", "change"]),
    ("agent/archivedAgentIdentities", "archivedAgentIdentities", &["agentIds"]),
    ("agent/deleteAgentDefinition", "deleteAgentDefinition", &["agentId"]),
    ("agent/getAgentAlwaysAllowedTools", "getAgentAlwaysAllowedTools", &["agentId"]),
    ("agent/getAgentAvatarImage", "getAgentAvatarImage", &["agentId"]),
    ("agent/getAgentConnectorTools", "getAgentConnectorTools", &["agentId"]),
    ("agent/getAgentConnectors", "getAgentConnectors", &["agentId"]),
    ("agent/getAgentDefinition", "getAgentDefinition", &["agentId"]),
    ("agent/getAgentPermissions", "getAgentPermissions", &["agentId"]),
    ("agent/getLeadAgentBody", "getLeadAgentBody", &[]),
    ("agent/getLeadAppearance", "getLeadAppearance", &[]),
    ("agent/getLeadPersona", "getLeadPersona", &[]),
    ("agent/getLeadStatus", "getLeadStatus", &[]),
    ("agent/recordAgentApprovalAudit", "recordAgentApprovalAudit", &["agentId", "action", "decision"]),
    ("agent/restoreAgentDefinition", "restoreAgentDefinition", &["agentId"]),
    ("agent/saveAgentDefinition", "saveAgentDefinition", &["payload"]),
    ("agent/saveLeadAgentBody", "saveLeadAgentBody", &["text"]),
    ("agent/saveLeadIdentity", "saveLeadIdentity", &["payload"]),
    ("agent/saveLeadPersona", "saveLeadPersona", &["text"]),
    ("agent/setAgentConnectorEnabled", "setAgentConnectorEnabled", &["agentId", "connectorId", "enabled"]),
    ("agent/setAgentConnectorToolPermission", "setAgentConnectorToolPermission", &["agentId", "connectorId", "toolName", "permission"]),
    ("agent/setAgentConnectors", "setAgentConnectors", &["agentId", "connectors"]),
    ("agent/setAgentPermission", "setAgentPermission", &["agentId", "action", "mode"]),
    ("agent/setLeadAppearance", "setLeadAppearance", &["avatar"]),
    ("agent/setLeadCreated", "setLeadCreated", &["created"]),
    ("channel/deleteSchedule", "deleteSchedule", &["name"]),
    ("channel/deleteWebhook", "deleteWebhook", &["name"]),
    ("channel/getChannelSetup", "getChannelSetup", &[]),
    ("channel/retryRoutineDelivery", "retryRoutineDelivery", &["kind", "name"]),
    ("channel/runScheduleNow", "runScheduleNow", &["name"]),
    ("channel/runWebhookNow", "runWebhookNow", &["name"]),
    ("channel/saveSchedule", "saveSchedule", &["entry"]),
    ("channel/saveWebhook", "saveWebhook", &["entry"]),
    ("channel/setScheduleEnabled", "setScheduleEnabled", &["name", "enabled"]),
    ("channel/setWebhookConfig", "setWebhookConfig", &["patch"]),
    ("channel/setWebhookEnabled", "setWebhookEnabled", &["name", "enabled"]),
    ("channel/testWebhook", "testWebhook", &["name"]),
    ("config/claimSetupRequest", "claimSetupRequest", &["id", "owner"]),
    ("config/completeOnboarding", "completeOnboarding", &[]),
    ("config/completeSetupRequest", "completeSetupRequest", &["id", "owner", "receipt"]),
    ("config/createWorkflow", "createWorkflow", &["payload"]),
    ("config/deleteWorkflow", "deleteWorkflow", &["workflowId"]),
    ("config/getAutoClear", "getAutoClear", &[]),
    ("config/getCacheWarmingSettings", "getCacheWarmingSettings", &[]),
    ("config/getCompactionSettings", "getCompactionSettings", &[]),
    ("config/getConfiguredOrchestrationMode", "getConfiguredOrchestrationMode", &[]),
    ("config/getDeveloperSettings", "getDeveloperSettings", &[]),
    ("config/getHeartbeatSettings", "getHeartbeatSettings", &[]),
    ("config/getNetworkProxy", "getNetworkProxy", &[]),
    ("config/getOrchestrationMode", "getOrchestrationMode", &[]),
    ("config/getOutputStyle", "getOutputStyle", &[]),
    ("config/getProfile", "getProfile", &[]),
    ("config/getReactionSettings", "getReactionSettings", &[]),
    ("config/getRecapSettings", "getRecapSettings", &[]),
    ("config/getSessionTitleSettings", "getSessionTitleSettings", &[]),
    ("config/getSystemShell", "getSystemShell", &[]),
    ("config/getTheme", "getTheme", &[]),
    ("config/getToolModuleSettings", "getToolModuleSettings", &[]),
    ("config/getUpdateSettings", "getUpdateSettings", &[]),
    ("config/getWorkflowPack", "getWorkflowPack", &["workflowId"]),
    ("config/getWorktreeSettings", "getWorktreeSettings", &[]),
    ("config/installBuiltinFeature", "installBuiltinFeature", &["name"]),
    ("config/isSetupRequestActive", "isSetupRequestActive", &["id", "owner"]),
    ("config/listOutputStyles", "listOutputStyles", &[]),
    ("config/saveStarterGuideState", "saveStarterGuideState", &["state"]),
    ("config/saveWorkflowPack", "saveWorkflowPack", &["payload"]),
    ("config/setAiSessionTitles", "setAiSessionTitles", &["enabled"]),
    ("config/setAutoClear", "setAutoClear", &[]),
    ("config/setAutoEffortBase", "setAutoEffortBase", &["level"]),
    ("config/setAutoUpdate", "setAutoUpdate", &["enabled"]),
    ("config/setBuiltinToolEnabled", "setBuiltinToolEnabled", &["name", "enabled"]),
    ("config/setCacheWarmingEnabled", "setCacheWarmingEnabled", &["enabled"]),
    ("config/setCompactionSettings", "setCompactionSettings", &[]),
    ("config/setDeveloperOption", "setDeveloperOption", &["id", "enabled"]),
    ("config/setExtensionScope", "setExtensionScope", &["kind", "name"]),
    ("config/setHeartbeatEnabled", "setHeartbeatEnabled", &["enabled"]),
    ("config/setHeartbeatInterval", "setHeartbeatInterval", &["minutes"]),
    ("config/setMemoryToolsEnabled", "setMemoryToolsEnabled", &["enabled"]),
    ("config/setModelPreferences", "setModelPreferences", &["providerId", "changes"]),
    ("config/setNetworkProxy", "setNetworkProxy", &["patch"]),
    ("config/setProfile", "setProfile", &[]),
    ("config/setReactionsEnabled", "setReactionsEnabled", &["enabled"]),
    ("config/setRecapEnabled", "setRecapEnabled", &["enabled"]),
    ("config/setSystemShell", "setSystemShell", &["input"]),
    ("config/setTheme", "setTheme", &["id"]),
    ("config/setWebSearchEnabled", "setWebSearchEnabled", &["enabled"]),
    ("config/setWebSearchRoute", "setWebSearchRoute", &["next"]),
    ("config/setWorktreeSettings", "setWorktreeSettings", &["patch"]),
    ("config/skipOnboarding", "skipOnboarding", &[]),
    ("config/testNetworkProxy", "testNetworkProxy", &[]),
    ("connector/addConnectorAccount", "addConnectorAccount", &["input"]),
    ("connector/listConnectorTools", "listConnectorTools", &["connectorId"]),
    ("diagnostics/runDoctor", "runDoctor", &[]),
    ("import/cancelConversationImport", "cancelConversationImport", &["params"]),
    ("import/getConversationImportJobs", "getConversationImportJobs", &[]),
    ("import/listImportableConversations", "listImportableConversations", &["params"]),
    ("import/registerConversationImportFile", "registerConversationImportFile", &["params"]),
    ("import/startConversationImport", "startConversationImport", &["params"]),
    ("instructions/getInstructionFile", "getInstructionFile", &["group", "id"]),
    ("instructions/listInstructionFiles", "listInstructionFiles", &[]),
    ("instructions/resetInstructionFile", "resetInstructionFile", &["group", "id"]),
    ("instructions/saveInstructionFile", "saveInstructionFile", &["input"]),
    ("instructions/setInstructionFiles", "setInstructionFiles", &["mode"]),
    ("localProvider/cancelLocalProviderInstallation", "cancelLocalProviderInstallation", &["jobId"]),
    ("localProvider/deleteLocalProviderModel", "deleteLocalProviderModel", &["confirmationToken"]),
    ("localProvider/discardLocalProviderInstallation", "discardLocalProviderInstallation", &["phase"]),
    ("localProvider/getLocalProviderModelDetails", "getLocalProviderModelDetails", &["modelId"]),
    ("localProvider/installLocalProviderModel", "installLocalProviderModel", &["modelId"]),
    ("localProvider/setLocalProviderContext", "setLocalProviderContext", &["modelId", "tokens"]),
    ("localProvider/setLocalProviderIdleTtl", "setLocalProviderIdleTtl", &["seconds"]),
    ("localProvider/startLocalProviderInstallation", "startLocalProviderInstallation", &["phase"]),
    ("localProvider/startLocalProviderModelMaintenance", "startLocalProviderModelMaintenance", &["modelId", "operation"]),
    ("mcp/addMcpServer", "addMcpServer", &["input"]),
    ("mcp/beginMcpOAuthLogin", "beginMcpOAuthLogin", &["name"]),
    ("mcp/cancelMcpOAuthLogin", "cancelMcpOAuthLogin", &["flowId"]),
    ("mcp/completeMcpOAuthLogin", "completeMcpOAuthLogin", &["flowId", "callbackUrl"]),
    ("mcp/enablePluginMcp", "enablePluginMcp", &["plugin"]),
    ("mcp/getMcpOAuthLoginStatus", "getMcpOAuthLoginStatus", &["flowId"]),
    ("mcp/getMcpServerConfig", "getMcpServerConfig", &["name"]),
    ("mcp/mcpStatus", "mcpStatus", &[]),
    ("mcp/probeMcpServerAuth", "probeMcpServerAuth", &["cfg"]),
    ("mcp/reconnectMcp", "reconnectMcp", &[]),
    ("mcp/removeMcpServer", "removeMcpServer", &["name"]),
    ("mcp/saveMcpServer", "saveMcpServer", &["input"]),
    ("mcp/setMcpServerEnabled", "setMcpServerEnabled", &["name", "enabled"]),
    ("mcp/signOutMcpServer", "signOutMcpServer", &["name"]),
    ("media/cacheMediaThumbnail", "cacheMediaThumbnail", &["id", "input"]),
    ("media/cancelMediaJob", "cancelMediaJob", &["id"]),
    ("media/createMediaBoard", "createMediaBoard", &["name"]),
    ("media/deleteMediaAsset", "deleteMediaAsset", &["id"]),
    ("media/deleteMediaAssets", "deleteMediaAssets", &["filter"]),
    ("media/deleteMediaBoard", "deleteMediaBoard", &["id"]),
    ("media/getMediaDefault", "getMediaDefault", &["kind"]),
    ("media/getMediaJob", "getMediaJob", &["id"]),
    ("media/getMediaPins", "getMediaPins", &[]),
    ("media/listMediaAssets", "listMediaAssets", &[]),
    ("media/listMediaBoards", "listMediaBoards", &[]),
    ("media/listMediaLanes", "listMediaLanes", &[]),
    ("media/openMediaAsset", "openMediaAsset", &["id"]),
    ("media/openMediaFolder", "openMediaFolder", &[]),
    ("media/readMediaAsset", "readMediaAsset", &["id"]),
    ("media/renameMediaBoard", "renameMediaBoard", &["id", "name"]),
    ("media/resolveMediaFile", "resolveMediaFile", &["id"]),
    ("media/setMediaAssetBoard", "setMediaAssetBoard", &["ids", "boardId"]),
    ("media/setMediaDefault", "setMediaDefault", &["input"]),
    ("media/setMediaPin", "setMediaPin", &["input"]),
    ("media/startMediaJob", "startMediaJob", &["input"]),
    ("memory/memoryControl", "memoryControl", &[]),
    ("memory/recall", "recall", &["query"]),
    ("model/list", "listProviderModels", &[]),
    ("plugins/addPlugin", "addPlugin", &["source"]),
    ("plugins/pluginsStatus", "pluginsStatus", &[]),
    ("plugins/reloadPlugins", "reloadPlugins", &[]),
    ("plugins/removePlugin", "removePlugin", &["plugin"]),
    ("plugins/setPluginEnabled", "setPluginEnabled", &["plugin", "enabled"]),
    ("plugins/updatePlugin", "updatePlugin", &["plugin"]),
    ("project/deleteWorktree", "deleteWorktree", &["input"]),
    ("project/getProjectBranchMenu", "getProjectBranchMenu", &["input"]),
    ("project/getProjectConnectors", "getProjectConnectors", &["projectPath"]),
    ("project/inspectProjectBranch", "inspectProjectBranch", &["input"]),
    ("project/listWorktrees", "listWorktrees", &[]),
    ("project/manageProjectBranch", "manageProjectBranch", &["input"]),
    ("project/mergeProjectBranch", "mergeProjectBranch", &["input"]),
    ("project/previewWorktreeCleanup", "previewWorktreeCleanup", &[]),
    ("project/pruneWorktrees", "pruneWorktrees", &[]),
    ("project/removeWorktree", "removeWorktree", &[]),
    ("project/selectProjectBranch", "selectProjectBranch", &["input"]),
    ("project/setProjectConnectorEnabled", "setProjectConnectorEnabled", &["projectPath", "connectorId", "enabled"]),
    ("skills/addSkill", "addSkill", &["input"]),
    ("skills/getDisabledSkills", "getDisabledSkills", &[]),
    ("skills/reloadSkills", "reloadSkills", &[]),
    ("skills/removeSkill", "removeSkill", &["input"]),
    ("skills/saveSkill", "saveSkill", &["input"]),
    ("skills/setDisabledSkills", "setDisabledSkills", &["names"]),
    ("skills/skillContent", "skillContent", &["name"]),
    ("skills/skillsStatus", "skillsStatus", &[]),
    ("thread/askSide", "askSide", &["question"]),
    ("thread/backgroundTerminals/clean", "stopShellJobs", &[]),
    ("thread/backgroundTerminals/release", "releaseShellJob", &["taskId"]),
    ("thread/cancelSide", "cancelSide", &[]),
    ("thread/clear", "clear", &[]),
    ("thread/clearSessionChangeHistory", "clearSessionChangeHistory", &[]),
    ("thread/compact/start", "compact", &[]),
    ("thread/contextStatus", "contextStatus", &[]),
    ("thread/getBranchMenu", "getBranchMenu", &[]),
    ("thread/agentControl", "agentControl", &[]),
    ("thread/getSessionUsage", "getSessionUsage", &[]),
    ("thread/goal/clear", "goalControl", &[]),
    ("thread/goal/control", "goalControl", &[]),
    ("thread/goal/set", "goalControl", &[]),
    ("thread/inheritancePreflight", "inheritancePreflight", &[]),
    ("thread/listShellJobs", "listShellJobs", &[]),
    ("thread/listStoppableShellJobs", "listStoppableShellJobs", &[]),
    ("thread/mergeWorkspace", "mergeWorkspace", &["input"]),
    ("thread/reapplyTurnChanges", "reapplyTurnChanges", &["checkpointId", "file", "revision"]),
    ("thread/requestWorktree", "requestWorktree", &[]),
    ("thread/resizeImage", "resizeImage", &["input"]),
    ("thread/revertTurnChanges", "revertTurnChanges", &["checkpointId", "file", "revision"]),
    ("thread/revertTurnReview", "revertTurnReview", &[]),
    ("thread/revertTurnReviewFile", "revertTurnReviewFile", &["file"]),
    ("thread/rewind", "rewindToItem", &["itemId"]),
    ("thread/selectBranch", "selectBranch", &["input"]),
    ("thread/setEffort", "setEffort", &["value"]),
    ("thread/setOrchestrationMode", "setOrchestrationMode", &["mode"]),
    ("thread/setOutputStyle", "setOutputStyle", &["value"]),
    ("thread/setToolMode", "setToolMode", &["mode"]),
    ("thread/setWorkflow", "setWorkflow", &["workflowId"]),
    ("thread/stageAttachmentOriginal", "stageAttachmentOriginal", &["input"]),
    ("tidy/getTidyEngineStatus", "getTidyEngineStatus", &[]),
    ("tidy/getTidyInstallStatus", "getTidyInstallStatus", &[]),
    ("tools/toolsStatus", "toolsStatus", &[]),
    ("turn/retryFailed", "retryFailedTurn", &["threadId", "turnKey"]),
    ("update/checkForUpdate", "checkForUpdate", &[]),
    ("update/getUpdateStatus", "getUpdateStatus", &[]),
    ("update/runUpdateNow", "runUpdateNow", &[]),
    ("usage/getUsageDashboard", "getUsageDashboard", &[]),
    ("usage/getUsageRequests", "getUsageRequests", &[]),
    ("usage/getUsageStats", "getUsageStats", &[]),
    ("voice/getVoiceStatus", "getVoiceStatus", &[]),
    ("voice/prepareTranscription", "prepareTranscription", &[]),
    ("voice/toggleVoice", "toggleVoice", &["enabled"]),
    ("voice/transcribeAudio", "transcribeAudio", &["input"]),
];

const MAX_STRUCTURED_STRING_TOTAL: usize = 32_000_000;
const MAX_STRUCTURED_NODES: usize = 20_000;
const MAX_STRUCTURED_DEPTH: usize = 12;
const MAX_STRUCTURED_ENTRIES: usize = 5_000;
const MAX_SESSION_ID_LENGTH: usize = 256;
/// `MAX_PROMPT_LENGTH` of `capability-request.ts`: the longest side question.
const MAX_SIDE_QUESTION_LENGTH: usize = 1_000_000;
/// `Number.MAX_SAFE_INTEGER`.
const MAX_SAFE_INTEGER: f64 = 9_007_199_254_740_991.0;
const CONTEXT_INSPECTION_KEYS: &[&str] = &["inspect", "entryId", "revision"];
const SKILLS_STATUS_OPTION_KEYS: &[&str] = &["projectPath"];
const STARTER_GUIDE_KEYS: &[&str] = &["closed", "welcomed", "visited"];
/// `STARTER_GUIDE_STEPS` of `ipc-validation.ts` (the runtime schema `starter-guide-state.mjs`).
const STARTER_GUIDE_STEPS: &[&str] = &["provider", "project", "workflow", "extensions", "remote"];

fn refuse(path: &str, expected: &str) -> Option<Result<(), ErrorData>> {
    Some(Err(ErrorData::InvalidParams { path: path.to_owned(), expected: expected.to_owned() }))
}

/// `None`: this group does not own `method`, or accepts `params` (a group after it may still refuse them).
pub fn check(method: &str, given: Option<&Value>) -> Option<Result<(), ErrorData>> {
    let &(_, capability, required) = CAPABILITIES.iter().find(|(name, _, _)| *name == method)?;
    let empty = Map::new();
    let params = given.and_then(Value::as_object).unwrap_or(&empty);
    // An argument left out reads as `undefined` to the host's typed checks, which name it in their own message (`turn key
    // must be a string.`); only a call that no check types has too few arguments (below, once every check has had its say).
    let missing = required.iter().find(|name| !params.contains_key(**name));
    let mut state = Structured { strings: 0, nodes: 1 };
    for (key, value) in params {
        if key == "opId" || key == "threadId" {
            continue;
        }
        if let Err(expected) = state.check(value, 1) {
            return refuse(&format!("/{key}"), expected);
        }
    }
    match capability {
        "retryFailedTurn" => {
            if let Err(expected) = required_session_id(params.get("threadId")) {
                return refuse("/threadId", expected);
            }
            if let Err(expected) = required_string(params.get("turnKey"), "turn key", 512) {
                return refuse("/turnKey", &expected);
            }
        }
        "contextStatus" => {
            if let Err((path, expected)) = context_status_options(params.get("options")) {
                return refuse(&path, &expected);
            }
        }
        "skillsStatus" => {
            if let Err((path, expected)) = skills_status_options(params.get("options")) {
                return refuse(&path, &expected);
            }
        }
        "askSide" => {
            if let Err(expected) = required_string(params.get("question"), "side question", MAX_SIDE_QUESTION_LENGTH) {
                return refuse("/question", &expected);
            }
        }
        "revertTurnChanges" | "reapplyTurnChanges" => {
            if let Err((path, expected)) = turn_changes_target(params) {
                return refuse(path, &expected);
            }
        }
        "saveStarterGuideState" => {
            if let Err(expected) = starter_guide_state(params.get("state")) {
                return refuse("/state", expected);
            }
        }
        _ => {}
    }
    // The addressed session: an empty or absent one is the control session.
    match params.get("threadId") {
        None | Some(Value::Null) => {}
        Some(Value::String(id)) if id.is_empty() => {}
        thread => {
            if let Err(expected) = required_session_id(thread) {
                return refuse("/threadId", expected);
            }
        }
    }
    let name = missing?;
    match super::typed_refusal(method, given) {
        Some(error) => Some(Err(error)),
        None => refuse(&format!("/{name}"), &format!("capability {capability} received an invalid number of arguments.")),
    }
}

/// `validateStructuredValue`: the node, depth, entry and string bounds of a call's arguments (the root is the
/// arguments array, so each argument is at depth 1).
struct Structured {
    strings: usize,
    nodes: usize,
}

impl Structured {
    fn check(&mut self, value: &Value, depth: usize) -> Result<(), &'static str> {
        self.nodes += 1;
        if self.nodes > MAX_STRUCTURED_NODES || depth > MAX_STRUCTURED_DEPTH {
            return Err("structured input is too large.");
        }
        match value {
            Value::Null | Value::Bool(_) | Value::Number(_) => Ok(()),
            Value::String(text) => {
                self.strings += utf16_len(text);
                if self.strings > MAX_STRUCTURED_STRING_TOTAL {
                    return Err("structured input is too large.");
                }
                Ok(())
            }
            Value::Array(items) => {
                if items.len() > MAX_STRUCTURED_ENTRIES {
                    return Err("structured input contains too many entries.");
                }
                items.iter().try_for_each(|item| self.check(item, depth + 1))
            }
            Value::Object(entries) => {
                if entries.len() > MAX_STRUCTURED_ENTRIES {
                    return Err("structured input contains too many fields.");
                }
                // `Object.entries`: integer keys first, so the first refusal is the one JavaScript reports.
                for key in mixdog_js::js_object_keys(entries) {
                    if matches!(key.as_str(), "__proto__" | "prototype" | "constructor") {
                        return Err("structured input contains an invalid field.");
                    }
                    self.check(&entries[key], depth + 1)?;
                }
                Ok(())
            }
        }
    }
}

/// `requiredStarterGuideState`, for the fields a state carries. The protocol client sends `{}` (the state is
/// merged by the runtime: fixtures/clients-accepted.json), so a field that is absent is not required; a field that
/// is present, an unknown field and a state that is not an object are refused as the desktop refused them.
fn starter_guide_state(value: Option<&Value>) -> Result<(), &'static str> {
    let Some(Value::Object(state)) = value else {
        return Err("starter guide state must be an object.");
    };
    if state.keys().any(|key| !STARTER_GUIDE_KEYS.contains(&key.as_str())) {
        return Err("starter guide state contains an unsupported field.");
    }
    if ["closed", "welcomed"].iter().any(|name| state.get(*name).is_some_and(|flag| !flag.is_boolean())) {
        return Err("starter guide closed and welcomed must be booleans.");
    }
    let known_steps = |steps: &Value| {
        steps.as_array().is_some_and(|list| {
            list.len() <= STARTER_GUIDE_STEPS.len() * 2
                && list.iter().all(|step| step.as_str().is_some_and(|name| STARTER_GUIDE_STEPS.contains(&name)))
        })
    };
    if state.get("visited").is_some_and(|steps| !known_steps(steps)) {
        return Err("starter guide visited must list known steps.");
    }
    Ok(())
}

/// `requiredString`: the trimmed text of a non-empty string no longer than `maximum` UTF-16 units.
fn required_string<'a>(value: Option<&'a Value>, name: &str, maximum: usize) -> Result<&'a str, String> {
    let Some(Value::String(text)) = value else {
        return Err(format!("{name} must be a string."));
    };
    let text = js_trim(text);
    if text.is_empty() || utf16_len(text) > maximum {
        return Err(format!("{name} is invalid."));
    }
    Ok(text)
}

/// `requiredSessionId`: `[A-Za-z0-9_-]+`, at most 256 units, after trimming.
fn required_session_id(value: Option<&Value>) -> Result<(), &'static str> {
    let Some(Value::String(text)) = value else {
        return Err("session id must be a string.");
    };
    let id = js_trim(text);
    if id.is_empty()
        || utf16_len(id) > MAX_SESSION_ID_LENGTH
        || !id.chars().all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
    {
        return Err("session id is invalid.");
    }
    Ok(())
}

/// `requireAllowedKeys`.
fn allowed_keys(options: &Map<String, Value>, allowed: &[&str], name: &str) -> Result<(), (String, String)> {
    if options.keys().any(|key| !allowed.contains(&key.as_str())) {
        return Err(("/options".to_owned(), format!("{name} contains an unsupported field.")));
    }
    Ok(())
}

/// An options param: absent or `null` is no options; an empty object is read as none too (the clients send `{}`).
fn options_object<'a>(
    value: Option<&'a Value>,
    expected: &str,
) -> Result<Option<&'a Map<String, Value>>, (String, String)> {
    match value {
        None | Some(Value::Null) => Ok(None),
        Some(Value::Object(options)) if options.is_empty() => Ok(None),
        Some(Value::Object(options)) => Ok(Some(options)),
        Some(_) => Err(("/options".to_owned(), expected.to_owned())),
    }
}

/// `validateContextStatusArgs`.
fn context_status_options(value: Option<&Value>) -> Result<(), (String, String)> {
    let Some(inspection) = options_object(value, "context inspection options must be an object.")? else {
        return Ok(());
    };
    allowed_keys(inspection, CONTEXT_INSPECTION_KEYS, "context inspection")?;
    if inspection.get("inspect") != Some(&Value::Bool(true)) {
        return Err(("/options".to_owned(), "context inspection requires inspect: true.".to_owned()));
    }
    if let Some(entry) = inspection.get("entryId") {
        required_string(Some(entry), "context entry id", 128)
            .map_err(|expected| ("/options/entryId".to_owned(), expected))?;
        required_string(inspection.get("revision"), "context revision", 64)
            .map_err(|expected| ("/options/revision".to_owned(), expected))?;
    } else if inspection.contains_key("revision") {
        return Err(("/options/revision".to_owned(), "context revision requires an entry id.".to_owned()));
    }
    Ok(())
}

/// `validateTurnCapabilityArgs` for `[checkpointId, file | null, revision]`. A `file` that is not a string is left to
/// the runtime, as the clients send other shapes there (`clients-accepted.json`).
fn turn_changes_target(params: &Map<String, Value>) -> Result<(), (&'static str, String)> {
    required_string(params.get("checkpointId"), "checkpointId", 512).map_err(|expected| ("/checkpointId", expected))?;
    if let Some(file @ Value::String(_)) = params.get("file") {
        required_string(Some(file), "file", 4_096).map_err(|expected| ("/file", expected))?;
    }
    let revision = params.get("revision").and_then(Value::as_f64);
    if !revision.is_some_and(|revision| revision.fract() == 0.0 && (0.0..=MAX_SAFE_INTEGER).contains(&revision)) {
        return Err(("/revision", "revision must be a non-negative integer.".to_owned()));
    }
    Ok(())
}

/// The `skillsStatus` options: a new-task draft's absolute project path (the host resolves it to a registered
/// Project and refuses anything else).
fn skills_status_options(value: Option<&Value>) -> Result<(), (String, String)> {
    let Some(options) = options_object(value, "skills status options are invalid.")? else {
        return Ok(());
    };
    allowed_keys(options, SKILLS_STATUS_OPTION_KEYS, "skills status options")?;
    let path = "/options/projectPath";
    let project_path = required_string(options.get("projectPath"), "projectPath", 4_096)
        .map_err(|expected| (path.to_owned(), expected))?;
    if !path_is_absolute(project_path) || project_path.contains('\0') {
        return Err((path.to_owned(), "projectPath is invalid.".to_owned()));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use serde::Deserialize;

    use super::*;
    use crate::methods::CLIENT_METHODS;

    #[derive(Deserialize)]
    struct Row {
        case: String,
        method: String,
        params: Value,
        path: Option<String>,
        expected: Option<String>,
    }

    #[derive(Deserialize)]
    struct Accepted {
        method: String,
        // A notification row (`initialized`) has no params.
        #[serde(default)]
        params: Value,
        client: String,
        case: String,
    }

    fn run(method: &str, params: &Value) -> Result<(), ErrorData> {
        check(method, Some(params)).unwrap_or(Ok(()))
    }

    #[test]
    fn validate_capability_fixture_rows_match() {
        let rows: Vec<Row> = serde_json::from_str(include_str!("fixtures/capability.json")).unwrap();
        assert!(!rows.is_empty());
        for row in rows {
            let got = run(&row.method, &row.params);
            match (row.path, row.expected) {
                (Some(path), Some(expected)) => assert_eq!(
                    got,
                    Err(ErrorData::InvalidParams { path, expected }),
                    "{}: {}",
                    row.method,
                    row.case
                ),
                (None, None) => assert_eq!(got, Ok(()), "{}: {}", row.method, row.case),
                _ => panic!("{}: {}: path and expected go together", row.method, row.case),
            }
        }
    }

    /// Every method the table names exists, and none is listed twice.
    #[test]
    fn validate_capability_table_names_real_methods() {
        for (i, (method, capability, _)) in CAPABILITIES.iter().enumerate() {
            assert!(CLIENT_METHODS.iter().any(|spec| spec.method == *method), "{capability}: `{method}` is not a method");
            assert!(CAPABILITIES[..i].iter().all(|(other, ..)| other != method), "`{method}` is listed twice");
        }
    }

    /// What the TUI, the phone and the clients send is accepted whatever the origin.
    #[test]
    fn validate_capability_clients_accepted_rows() {
        let rows: Vec<Accepted> = serde_json::from_str(include_str!("fixtures/clients-accepted.json")).unwrap();
        let mut owned = 0;
        for row in rows {
            owned += usize::from(CAPABILITIES.iter().any(|(method, ..)| *method == row.method));
            assert_eq!(run(&row.method, &row.params), Ok(()), "{} {}: {}", row.client, row.method, row.case);
        }
        assert!(owned > 0);
    }

    #[test]
    fn validate_capability_starter_guide_state() {
        let state = |state: Value| serde_json::json!({ "opId": "o1", "state": state });
        let refused = |expected: &str| Err(ErrorData::InvalidParams { path: "/state".to_owned(), expected: expected.to_owned() });
        assert_eq!(run("config/saveStarterGuideState", &state(serde_json::json!({}))), Ok(()));
        assert_eq!(
            run("config/saveStarterGuideState", &state(serde_json::json!({ "closed": false, "welcomed": true, "visited": ["provider", "remote"] }))),
            Ok(())
        );
        assert_eq!(run("config/saveStarterGuideState", &state(serde_json::json!([]))), refused("starter guide state must be an object."));
        assert_eq!(
            run("config/saveStarterGuideState", &state(serde_json::json!({ "extra": 1 }))),
            refused("starter guide state contains an unsupported field.")
        );
        assert_eq!(
            run("config/saveStarterGuideState", &state(serde_json::json!({ "closed": "yes" }))),
            refused("starter guide closed and welcomed must be booleans.")
        );
        assert_eq!(
            run("config/saveStarterGuideState", &state(serde_json::json!({ "visited": ["nope"] }))),
            refused("starter guide visited must list known steps.")
        );
    }

    /// The bounds a fixture file would be too large to hold: the node count and the string total.
    #[test]
    fn validate_capability_structured_bounds() {
        let params = |payload: Value| serde_json::json!({ "opId": "o1", "payload": payload });
        let too_large = |path: &str| Err(ErrorData::InvalidParams {
            path: path.to_owned(),
            expected: "structured input is too large.".to_owned(),
        });
        let rows = |count: usize| Value::Array((0..count).map(|_| Value::Array(vec![Value::Null; 4_000])).collect());
        assert_eq!(run("config/createWorkflow", &params(rows(4))), Ok(()));
        assert_eq!(run("config/createWorkflow", &params(rows(6))), too_large("/payload"));
        let text = |count: usize| Value::Array(vec![Value::String("a".repeat(1_000_000)); count]);
        assert_eq!(run("config/createWorkflow", &params(text(32))), Ok(()));
        assert_eq!(run("config/createWorkflow", &params(text(33))), too_large("/payload"));
    }

    /// An argument the call left out reads as `undefined` to the host's typed check, which names it; a capability no check
    /// types still has too few arguments.
    #[test]
    fn a_missing_typed_argument_takes_the_typed_message() {
        let params = |fields: Value| {
            let mut object = serde_json::json!({ "opId": "o1" });
            object.as_object_mut().unwrap().extend(fields.as_object().unwrap().clone());
            object
        };
        let refused = |path: &str, expected: &str| Err(ErrorData::InvalidParams { path: path.to_owned(), expected: expected.to_owned() });
        assert_eq!(
            run("turn/retryFailed", &params(serde_json::json!({ "threadId": "t1" }))),
            refused("/turnKey", "turn key must be a string.")
        );
        assert_eq!(run("thread/askSide", &params(serde_json::json!({}))), refused("/question", "side question must be a string."));
        // Typed by another group of this folder.
        assert_eq!(
            run("account/checkCustomProviderKeyEnv", &params(serde_json::json!({}))),
            refused("/name", "environment variable name must be a string.")
        );
        assert_eq!(
            run("account/saveCustomProviderKey", &params(serde_json::json!({ "providerId": "custom-0190f3c2-7a31-7c00-8000-000000000001" }))),
            refused("/secret", "provider secret is invalid.")
        );
        assert_eq!(
            run("account/removeCustomProvider", &params(serde_json::json!({}))),
            refused("/providerId", "custom provider id must be a string.")
        );
        // No check types it: the argument count.
        assert_eq!(
            run("thread/rewind", &params(serde_json::json!({ "threadId": "t1" }))),
            refused("/itemId", "capability rewindToItem received an invalid number of arguments.")
        );
    }

    /// `Object.entries` lists integer keys first, so a structured value reports the refusal JavaScript reaches first.
    #[test]
    fn a_structured_value_is_walked_in_object_key_order() {
        // Written first, the invalid field would be met before the too long list under the key `0`.
        let payload: Value = serde_json::from_str(&format!(r#"{{"constructor": 1, "0": [{}0]}}"#, "0,".repeat(5_000))).unwrap();
        assert_eq!(
            run("config/createWorkflow", &serde_json::json!({ "opId": "o1", "payload": payload })),
            Err(ErrorData::InvalidParams {
                path: "/payload".to_owned(),
                expected: "structured input contains too many entries.".to_owned()
            })
        );
    }
}
