//! The tools a session is denied: `featureDisallowedToolsFor` (`runtime-core/builtin-features.mjs`,
//! the settings gates, desktop bridge presence and the headless `load_tool` rule),
//! `reactionDisabled` (`session/manager/session-tool-surface.mjs`) and `liveDeniedTools`
//! (`tool-policy/policy-stage.mjs`).

use async_trait::async_trait;
use mixdog_app_protocol::v2::thread::ToolProfile;
use mixdog_core_base::rooms::ids::agent_id_of_home_session;
use mixdog_core_base::rooms::ids::room_member_of_session;
use mixdog_core_config::config::agent_disabled;
use mixdog_core_config::tool_modules::builtin_feature_active;
use mixdog_core_config::tool_modules::value::Env;
use mixdog_core_config::tool_modules::value::feature_env_override;
use mixdog_core_config::tool_modules::value::module_enabled;
use mixdog_core_config::workflow::ids::truthy;
use mixdog_core_session::session::session_options::model_tool_allowlist;
use mixdog_core_session::session::thread_switches::SurfaceFailure;
use mixdog_js::js_trim;
use mixdog_js::value_to_string;
use mixdog_store::agent_mode::session_mode_of;
use mixdog_store::schema::record::Header;
use serde_json::Map;
use serde_json::Value;

use crate::run_host::compaction_world::is_agent_owner;
use crate::run_host::tool_pool::model_surface::workflow_disallows_agent_tool;
use crate::run_host::tool_surface::DEFAULT_LEAD_TOOLS;

/// `REACTION_TOOL_NAME`.
const REACTION_TOOL: &str = "react";

/// What the settings cannot tell about the machine: which desktop bridges are up
/// (`browserBridgeAvailableSync()` and the like, the bridge discovery files), and whether a git
/// executable is on PATH (`gitExecutablePresent()`). Read on the host's own lanes, once per use.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct FeatureFacts {
    pub browser: bool,
    pub computer: bool,
    pub terminal: bool,
    pub visualize: bool,
    pub git: bool,
}

#[async_trait]
pub trait FeatureProbes: Send + Sync {
    /// A read that cannot run is a typed failure, never "no bridge, no git".
    async fn read(&self) -> Result<FeatureFacts, SurfaceFailure>;
}

/// `String(text || '')`.
fn text_of(value: Option<&Value>) -> String {
    match value {
        Some(value) if truthy(Some(value)) => value_to_string(value),
        _ => String::new(),
    }
}

/// `exploreRouteConfigured(config)`: Explore is on and `agents.explore` names a provider and a model.
fn explore_route_configured(config: &Map<String, Value>) -> bool {
    if agent_disabled(config, "explore") {
        return false;
    }
    let route = config.get("agents").and_then(Value::as_object).and_then(|agents| agents.get("explore"));
    route.and_then(Value::as_object).is_some_and(|route| {
        !js_trim(&text_of(route.get("provider"))).is_empty() && !js_trim(&text_of(route.get("model"))).is_empty()
    })
}

/// `featureDisallowedToolsFor(config, ...)` over the config as the runtime holds it (builtins
/// stamped), the process environment `env`, the machine `facts` and the runtime's tool profile.
pub fn feature_disallowed_tools(config: &Map<String, Value>, facts: &FeatureFacts, env: Env<'_>, profile: ToolProfile) -> Vec<String> {
    let var = |name: &str| feature_env_override(env, name);
    let active = |id: &str| builtin_feature_active(config, id, env, false);
    let browser = var("MIXDOG_FEATURE_BROWSER").unwrap_or(facts.browser);
    let computer = var("MIXDOG_FEATURE_COMPUTER").unwrap_or(facts.computer);
    let terminal = var("MIXDOG_FEATURE_TERMINAL").unwrap_or(facts.terminal);
    // The local `git` tool needs no install, only an executable (`localGitToolsActive`).
    let local_git = var("MIXDOG_FEATURE_GIT").unwrap_or_else(|| module_enabled(config, "git") && facts.git);
    let visualize = var("MIXDOG_FEATURE_VISUALIZE").unwrap_or_else(|| module_enabled(config, "visualize") && facts.visualize);
    let gates: [(bool, &[&str]); 12] = [
        (active("webSearch"), &["web_search", "web_fetch"]),
        (active("memory"), &["memory", "recall"]),
        (local_git, &["git"]),
        (active("git"), &["github"]),
        (browser, &["browser", "browser_devtools"]),
        (computer, &["computer"]),
        (terminal, &["terminal"]),
        (active("office"), &["office"]),
        (active("media"), &["media"]),
        (active("tidy"), &["tidy"]),
        (visualize, &["visualize"]),
        (explore_route_configured(config), &["explore"]),
    ];
    let mut denied: Vec<String> = gates.iter().filter(|(on, _)| !on).flat_map(|(_, names)| names.iter().map(|name| (*name).to_owned())).collect();
    // Bots' emoji reactions: on unless turned off.
    if config.get("reactions") == Some(&Value::Bool(false)) {
        denied.push(REACTION_TOOL.to_owned());
    }
    // Headless exec uses the Lead surface: when only its eager defaults remain, neither schemas nor
    // loader guidance help.
    if profile == ToolProfile::Headless
        && model_tool_allowlist(profile).is_some_and(|listed| listed.iter().all(|name| denied.iter().any(|d| d.as_str() == *name) || DEFAULT_LEAD_TOOLS.contains(name)))
    {
        denied.push("load_tool".to_owned());
    }
    denied
}

/// `reactionDisabled(session, ownerIsAgent)`: `react` belongs to a bot's own chat with the user,
/// its home chat or its seat in a group room, decided by the session's id.
pub fn reaction_disabled(session: &Header, owner_is_agent: bool) -> bool {
    let id = text_of(session.get("id"));
    owner_is_agent || (agent_id_of_home_session(&id).is_none() && room_member_of_session(&id).is_none())
}

/// `...session.callerDisallowedTools`: a list spreads into its entries (as text), a string into its
/// characters; anything else (a record without the field, `null`, a number, an object) is what
/// Node's spread throws a `TypeError` on.
fn caller_denials(session: &Header) -> Result<Vec<String>, SurfaceFailure> {
    match session.get("callerDisallowedTools") {
        Some(Value::Array(names)) => Ok(names.iter().map(|name| text_of(Some(name))).collect()),
        Some(Value::String(text)) => Ok(text.chars().map(String::from).collect()),
        _ => Err(SurfaceFailure("session.callerDisallowedTools is not iterable".to_owned())),
    }
}

/// `liveDeniedTools(session, workflow)`: the caller's denials, the feature gates as they stand,
/// `agent` for an agent-mode Lead whose workflow delegates to no one, and `react` outside a bot's
/// chat with the user. Names that are empty once made text are dropped. A session record without
/// an iterable `callerDisallowedTools` is a typed failure, where Node throws.
pub fn live_denied_tools(session: &Header, workflow: &Value, features: &[String]) -> Result<Vec<String>, SurfaceFailure> {
    let mut names = caller_denials(session)?;
    names.extend(features.iter().cloned());
    if workflow_disallows_agent_tool(workflow, session_mode_of(session) == "agent") {
        names.push("agent".to_owned());
    }
    if reaction_disabled(session, is_agent_owner(session)) {
        names.push(REACTION_TOOL.to_owned());
    }
    names.retain(|name| !name.is_empty());
    Ok(names)
}
