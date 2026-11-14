//! Input validation for the `capability` methods: the protocol methods the desktop's capability calls resolve to
//! (`<namespace>/<action>` of `action-route.mjs`, plus the overrides in `action-overrides.mjs`). Ported from
//! `ipc-validation.ts` `requiredDesktopCapabilityRequest`: a capability's required arguments (the minimum of its
//! arity, as the protocol params that carry them), the structured-value bounds of its arguments, the session
//! a call addresses, and the options of `retryFailedTurn`, `contextStatus` and `skillsStatus`. The rules of the
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
    ("thread/getSessionUsage", "getSessionUsage", &[]),
    ("thread/goal/control", "goalControl", &[]),
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
const CONTEXT_INSPECTION_KEYS: &[&str] = &["inspect", "entryId", "revision"];
const SKILLS_STATUS_OPTION_KEYS: &[&str] = &["projectPath"];

fn refuse(path: &str, expected: &str) -> Option<Result<(), ErrorData>> {
    Some(Err(ErrorData::InvalidParams { path: path.to_owned(), expected: expected.to_owned() }))
}

/// `None`: this group does not own `method`, or accepts `params` (a group after it may still refuse them).
pub fn check(method: &str, params: Option<&Value>) -> Option<Result<(), ErrorData>> {
    let &(_, capability, required) = CAPABILITIES.iter().find(|(name, _, _)| *name == method)?;
    let empty = Map::new();
    let params = params.and_then(Value::as_object).unwrap_or(&empty);
    for name in required {
        if !params.contains_key(*name) {
            return refuse(
                &format!("/{name}"),
                &format!("capability {capability} received an invalid number of arguments."),
            );
        }
    }
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
        _ => {}
    }
    // The addressed session: an empty or absent one is the control session.
    match params.get("threadId") {
        None | Some(Value::Null) => None,
        Some(Value::String(id)) if id.is_empty() => None,
        thread => match required_session_id(thread) {
            Ok(()) => None,
            Err(expected) => refuse("/threadId", expected),
        },
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
                for (key, entry) in entries {
                    if matches!(key.as_str(), "__proto__" | "prototype" | "constructor") {
                        return Err("structured input contains an invalid field.");
                    }
                    self.check(entry, depth + 1)?;
                }
                Ok(())
            }
        }
    }
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
}
