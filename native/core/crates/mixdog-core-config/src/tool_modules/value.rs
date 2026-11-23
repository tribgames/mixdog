//! The pure half of `getToolModuleSettings()`: the config-derived fields and the module gates,
//! ported from `settings-builtin-tools-api.mjs`, `builtin-features.mjs` and
//! `config-helpers.mjs`. Everything not derived from the config arrives in [`External`].

use serde_json::Map;
use serde_json::Value;
use serde_json::json;

pub(super) type Doc = Map<String, Value>;

pub const INSTRUCTION_FILES_MODES: [&str; 4] = ["all", "agents", "claude", "off"];
pub const AUTO_EFFORT_BASES: [&str; 3] = ["low", "medium", "high"];
pub const LOCAL_PROVIDER_ID: &str = "mixdog-local";

/// What the config cannot tell: the runtime state the host reads (on its own lanes).
#[derive(Debug, Clone, PartialEq)]
pub struct External {
    /// `getEmbeddingInfo()`.
    pub embedding_info: Value,
    /// `onnxRuntimeSupported()`.
    pub onnx_supported: bool,
    /// `gitExecutablePresent()`.
    pub git_available: bool,
    /// `getLocalProviderStatus()`: an object, or anything else for "no status".
    pub local_provider: Value,
    /// `localSettings.status().installationCommandError`.
    pub installation_command_error: Option<String>,
    pub effort_judge: EffortJudgeState,
}

/// `effortJudge*()` of `judge-client.mjs`.
#[derive(Debug, Clone, PartialEq)]
pub struct EffortJudgeState {
    pub available: bool,
    pub installing: bool,
    pub ready: bool,
    /// `effortJudgeLastError()`: a string, or null.
    pub last_error: Value,
    /// `effortJudgeInfo()`.
    pub info: Value,
}

/// `MIXDOG_FEATURE_*` lookups; the process environment in production.
pub type Env<'a> = &'a dyn Fn(&str) -> Option<String>;

/// `featureEnvOverride`: unset or empty = no override.
pub fn feature_env_override(env: Env<'_>, name: &str) -> Option<bool> {
    let raw = mixdog_js::js_trim(&env(name)?).to_lowercase();
    if raw.is_empty() {
        return None;
    }
    Some(!matches!(raw.as_str(), "0" | "false" | "no" | "off"))
}

fn section_enabled(entry: Option<&Value>, fallback: bool) -> bool {
    match entry {
        Some(Value::Object(map)) if map.get("enabled") == Some(&Value::Bool(false)) => false,
        _ => fallback,
    }
}

fn entry<'a>(doc: &'a Doc, section: &str, name: &str) -> Option<&'a Value> {
    doc.get(section)?.get(name)
}

pub fn module_enabled(doc: &Doc, name: &str) -> bool {
    section_enabled(entry(doc, "modules", name), true)
}

const GRANDFATHERED_BUILTIN_IDS: [&str; 3] = ["git", "memory", "office"];

fn has_builtins_section(doc: &Doc) -> bool {
    doc.get("builtins").is_some_and(|v| v.is_object() || v.is_array())
}

/// Where a config without a `builtins` section came from. Node's `withGrandfatheredBuiltins` (builtin-grandfathering.mjs) is one
/// function over a config object, but the object differs by origin, and so does what it holds:
/// - `Loaded`: the stored agent section as `loadConfig` (config.mjs:239-379) returns it. A section with any key (`hasKeys`,
///   :240) is merged onto defaults that always carry `presets`, `providers`, `modules` and `recap`, which are user marks, so
///   it is grandfathered whatever else it holds (a section holding only `autoClear.enabled:false`, as the desktop settings
///   store writes it, keeps Git/Memory/Office); an empty or absent section is stamped `builtins: {}` (:379), a fresh profile.
///   Run against Node's real `loadConfig` in `record-builtin-grandfathering.mjs`.
/// - `Given`: a config object in hand, as the recorders of the workflow, agent-store and feature-gate paths hand it to the
///   function (`record-workflow-config.mjs:254`, `config-lifecycle.mjs:123` `initialConfig`): only the keys it holds count, and
///   only the user marks among them do. The product never guesses it from the keys: a replay harness states it where it hands
///   the recorded literal in (`Config::with_origin`), a production call site states `Loaded`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Origin {
    Loaded,
    Given,
}

fn grandfathers(doc: &Doc, origin: Origin) -> bool {
    match origin {
        Origin::Loaded => !doc.is_empty(),
        // User-mark keys only: a default in-memory config may carry harmless structural keys.
        Origin::Given => ["presets", "providers", "modules", "default", "memoryTools", "recap"].iter().any(|key| doc.contains_key(*key)),
    }
}

/// The one decision of "installed" for every reader of the stored section (panel, Doctor, `setup status`, the tool surface):
/// what Node's adopted `Loaded` config holds. With a `builtins` section only it decides; without one a stored profile counts
/// git, memory and office as installed, a fresh one counts none.
pub fn builtin_installed(doc: &Doc, id: &str) -> bool {
    if has_builtins_section(doc) {
        return entry(doc, "builtins", id).and_then(|e| e.get("installed")).is_some_and(|v| *v == Value::Bool(true));
    }
    GRANDFATHERED_BUILTIN_IDS.contains(&id) && grandfathers(doc, Origin::Loaded)
}

fn memory_tools_enabled(doc: &Doc) -> bool {
    section_enabled(doc.get("memoryTools"), true)
}

/// `builtinFeatureActive` for the ids the settings value reports.
pub fn builtin_feature_active(doc: &Doc, id: &str, env: Env<'_>, onnx_supported: bool) -> bool {
    let var = |name: &str| feature_env_override(env, name);
    match id {
        "webSearch" => var("MIXDOG_FEATURE_WEB_SEARCH").unwrap_or_else(|| module_enabled(doc, id)),
        "memory" => var("MIXDOG_FEATURE_MEMORY").unwrap_or_else(|| builtin_installed(doc, id) && memory_tools_enabled(doc)),
        "office" => installed_and_enabled(doc, id, var("MIXDOG_FEATURE_OFFICE")),
        "tidy" => installed_and_enabled(doc, id, var("MIXDOG_FEATURE_TIDY")),
        "git" => installed_and_enabled(doc, id, var("MIXDOG_FEATURE_GIT")),
        "localProvider" => builtin_installed(doc, id) && module_enabled(doc, id),
        "autoEffort" => onnx_supported && var("MIXDOG_FEATURE_AUTO_EFFORT").unwrap_or_else(|| module_enabled(doc, id)),
        "media" => var("MIXDOG_FEATURE_MEDIA").unwrap_or_else(|| module_enabled(doc, id)),
        // Off until it is turned on: turning it on is what marks it installed.
        "acpAgents" => installed_and_enabled(doc, id, var("MIXDOG_FEATURE_ACP_AGENTS")),
        _ => false,
    }
}

fn installed_and_enabled(doc: &Doc, id: &str, over: Option<bool>) -> bool {
    over.unwrap_or_else(|| builtin_installed(doc, id) && module_enabled(doc, id))
}

/// `withGrandfatheredBuiltins` over a config of the given origin: the stored keys are kept, `builtins` is the section it has, or
/// the grandfathered three (`grandfathers`), or empty.
pub fn adopt(doc: &Doc, origin: Origin) -> Doc {
    if has_builtins_section(doc) {
        return doc.clone();
    }
    let mut next = doc.clone();
    next.insert("builtins".into(), Value::Object(Map::new()));
    if grandfathers(doc, origin) {
        for id in GRANDFATHERED_BUILTIN_IDS {
            super::edit::set_builtin_installed(&mut next, id);
        }
    }
    next
}

/// The adopted config of the stored agent section ([`Origin::Loaded`]): what every reader of the live config and the tool-module
/// setters hold.
pub fn adopted_stored_agent(doc: &Doc) -> Doc {
    adopt(doc, Origin::Loaded)
}

pub fn normalize_instruction_files(value: Option<&Value>) -> &'static str {
    INSTRUCTION_FILES_MODES.into_iter().find(|mode| value.and_then(Value::as_str) == Some(*mode)).unwrap_or("off")
}

/// `autoEffortBase`: `String(setting ?? '')` trimmed and lower-cased; anything else is `medium`.
pub fn auto_effort_base(value: Option<&Value>) -> &'static str {
    let text = match value {
        None | Some(Value::Null) => String::new(),
        Some(other) => mixdog_js::value_to_string(other),
    };
    let effort = mixdog_js::js_trim(&text).to_lowercase();
    AUTO_EFFORT_BASES.into_iter().find(|base| *base == effort).unwrap_or("medium")
}

/// `getToolModuleSettings()`, key for key.
pub fn tool_module_settings(doc: &Doc, external: &External, env: Env<'_>) -> Value {
    let onnx = external.onnx_supported;
    let active = |id: &str| builtin_feature_active(doc, id, env, onnx);
    let installed = |id: &str| builtin_installed(doc, id);
    let local = external.local_provider.as_object().cloned().unwrap_or_default();
    let runtime_installed = local.get("runtime").and_then(|runtime| runtime.get("installed")).is_some_and(|v| *v == Value::Bool(true));
    let git_enabled = feature_env_override(env, "MIXDOG_FEATURE_GIT").unwrap_or_else(|| module_enabled(doc, "git") && external.git_available);
    let always_on = |name: &str, var: &str| {
        json!({
            "enabled": feature_env_override(env, var).unwrap_or_else(|| module_enabled(doc, name)),
            "installed": true,
        })
    };
    let mut local_provider = local;
    // Node spreads the status object, then the command error, so those keys win over its own.
    local_provider.insert("installationCommandError".into(), external.installation_command_error.clone().map_or(Value::Null, Value::String));
    local_provider.insert("enabled".into(), json!(active("localProvider")));
    local_provider.insert("installed".into(), json!(installed("localProvider") && runtime_installed));
    let judge = &external.effort_judge;
    json!({
        "instructionFiles": normalize_instruction_files(doc.get("instructionFiles")),
        "autoEffortBase": auto_effort_base(doc.get("autoEffortBase")),
        "webSearch": { "enabled": active("webSearch") },
        "memory": {
            "enabled": active("memory"),
            "installed": installed("memory"),
            "info": external.embedding_info,
            "semanticSearchSupported": onnx,
        },
        "git": { "enabled": git_enabled, "installed": installed("git") },
        "office": { "enabled": active("office"), "installed": installed("office") },
        "tidy": { "enabled": active("tidy"), "installed": installed("tidy") },
        "visualize": always_on("visualize", "MIXDOG_FEATURE_VISUALIZE"),
        "media": always_on("media", "MIXDOG_FEATURE_MEDIA"),
        "localProvider": Value::Object(local_provider),
        "autoEffort": {
            "supported": onnx,
            "enabled": active("autoEffort"),
            "installed": judge.available,
            "installing": judge.installing,
            "ready": judge.ready,
            "lastError": judge.last_error,
            "info": judge.info,
        },
    })
}
