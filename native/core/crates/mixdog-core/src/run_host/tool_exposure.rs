//! Versioned tool exposure (Node `runtime-core/tool-exposure.mjs`, with `deferredProviderMode`
//! of `tool-catalog-schema.mjs` and `nativeDeferredFamilyForRoute` of `wire-route.mjs`).
//!
//! `deferredProviderMode` classifies the provider (native tool search or not);
//! `toolExposureMode` records how the session's tools reach the model. Non-native providers use
//! the fixed bridge: a small eager core plus the shared `load_tool` and `call_tool`, with every
//! other tool only in the session's scoped catalog. Native sessions carry no field. A session is
//! its stored header (`Value`), read as Node reads the live object.

use serde_json::Value;

pub const TOOL_EXPOSURE_BRIDGE: &str = "bridge-v1";
pub const TOOL_EXPOSURE_NATIVE: &str = "native";
pub const TOOL_SURFACE_MIGRATION_INTENT: &str = "tool_surface_bridge_migration";

/// Static and byte-stable; it follows the deferred roster, never replaces it. A prompt holding
/// any other bridge guidance is migrated once.
pub const TOOL_BRIDGE_GUIDANCE: &str = "<tool-bridge>\nDeferred tools (listed above, or announced later as added) are not defined here: run one with call_tool {name, arguments}, and use load_tool first to see its parameters (a keyword instead of a name searches the deferred tools). Call directly defined tools directly.\n</tool-bridge>";

/// `load_tool` definitions earlier bridge surfaces carried: the describe-only bridge loader, and
/// the shared loader with query/cursor inputs.
const LEGACY_BRIDGE_LOAD_TOOL_DESCRIPTIONS: [&str; 2] = [
    "Describe tools by exact name: description, input schema and annotations, or the part one JSON Pointer selects. Large definitions arrive in chunks; pass nextCursor back for the rest. Describing never enables a tool.",
    "Load full schemas for missing deferred tool names/aliases; batch needed names in one call. Or find tools by keyword with query. Pass nextCursor back for the next page.",
];

/// The shared `load_tool` definition the bridge surface carries now (`TOOL_SEARCH_TOOL`).
#[derive(Clone, Debug)]
pub struct LoadToolDef {
    pub description: String,
    pub input_schema: Value,
}

impl LoadToolDef {
    /// From the tool's definition JSON (`orch/defs/load_tool.json`).
    pub fn from_def(def: &Value) -> Self {
        Self {
            description: def.get("description").and_then(Value::as_str).unwrap_or_default().to_owned(),
            input_schema: def.get("inputSchema").cloned().unwrap_or(Value::Null),
        }
    }
}

fn truthy_str(value: Option<&Value>) -> Option<&str> {
    value.and_then(Value::as_str).filter(|s| !s.is_empty())
}

/// `nativeDeferredFamilyForRoute`: the family a pinned route gives `provider`, or `""` — a route
/// for another provider, one pinned without verified support, or a wire with no native contract.
fn native_family_for_route(provider: &str, route: Option<&Value>) -> &'static str {
    let Some(route) = route.filter(|r| r.get("nativeDeferredTools") == Some(&Value::Bool(true))) else { return "" };
    let name = mixdog_js::js_trim(provider).to_lowercase();
    if name.is_empty() || route.get("provider").and_then(Value::as_str).map(str::to_lowercase).as_deref() != Some(name.as_str()) {
        return "";
    }
    match route.get("wire").and_then(Value::as_str) {
        Some("messages") => "anthropic",
        Some("responses") => "openai",
        _ => "",
    }
}

/// `nativeProviderFamily`: the native tool-search family of `provider` (`openai`, `anthropic`),
/// or `""` for a provider that has none.
pub fn native_provider_family(provider: &str, route: Option<&Value>) -> &'static str {
    let p = mixdog_js::js_trim(provider).to_lowercase();
    match p.as_str() {
        "openai" | "openai-oauth" => "openai",
        "anthropic" | "anthropic-oauth" => "anthropic",
        _ => native_family_for_route(&p, route),
    }
}

/// `deferredProviderMode`: `manifest` for Gemini, `native` for the first-party Anthropic and
/// OpenAI providers (or a route pinned with verified support), else `canonical`.
pub fn deferred_provider_mode(provider: &str, route: Option<&Value>) -> &'static str {
    let p = mixdog_js::js_trim(provider).to_lowercase();
    if p == "gemini" {
        return "manifest";
    }
    let first_party = matches!(p.as_str(), "openai" | "openai-oauth" | "anthropic" | "anthropic-oauth");
    if first_party || !native_family_for_route(&p, route).is_empty() { "native" } else { "canonical" }
}

/// `toolExposureModeForProvider`.
pub fn tool_exposure_mode_for_provider(provider: &str, route: Option<&Value>) -> &'static str {
    if matches!(deferred_provider_mode(provider, route), "canonical" | "manifest") { TOOL_EXPOSURE_BRIDGE } else { TOOL_EXPOSURE_NATIVE }
}

/// `isToolBridgeEnabled`.
pub fn is_tool_bridge_enabled(session: &Value) -> bool {
    session.get("toolExposureMode").and_then(Value::as_str) == Some(TOOL_EXPOSURE_BRIDGE)
}

/// `sessionToolExposure`: the exposure a session's persisted surface was built with, or `None`
/// before it has one. Surfaces persisted before exposure versions: native providers were already
/// native; fixed-surface providers carried the whole catalog.
pub fn session_tool_exposure(session: &Value) -> Option<String> {
    if let Some(mode) = truthy_str(session.get("toolExposureMode")) {
        return Some(mode.to_owned());
    }
    let mode = truthy_str(session.get("deferredProviderMode"))?;
    Some(if mode == "native" { TOOL_EXPOSURE_NATIVE.to_owned() } else { "legacy-fixed".to_owned() })
}

/// `toolExposureMigrationNeeded(session, provider)`: an existing surface was built for another
/// exposure than `provider` needs, or is a bridge surface an earlier bridge revision built.
pub fn tool_exposure_migration_needed(session: &Value, provider: Option<&str>, load_tool: &LoadToolDef) -> bool {
    let Some(current) = session_tool_exposure(session) else { return false };
    let provider = provider.or_else(|| session.get("provider").and_then(Value::as_str)).unwrap_or_default();
    let target = tool_exposure_mode_for_provider(provider, session.get("wireRoute"));
    current != target || (target == TOOL_EXPOSURE_BRIDGE && bridge_surface_outdated(session, load_tool))
}

/// `bridgeSurfaceOutdated`: a bridge session an earlier bridge revision built — its eager surface
/// carries `search_tools` or a `load_tool` other than the shared one, or its fixed prompt holds
/// other bridge guidance than the current one.
pub fn bridge_surface_outdated(session: &Value, load_tool: &LoadToolDef) -> bool {
    if !is_tool_bridge_enabled(session) {
        return false;
    }
    let stale_tool = session.get("tools").and_then(Value::as_array).is_some_and(|tools| {
        tools.iter().any(|tool| match tool.get("name").and_then(Value::as_str) {
            Some("search_tools") => true,
            Some("load_tool") => {
                tool.get("description").and_then(Value::as_str) != Some(load_tool.description.as_str())
                    || tool.get("inputSchema") != Some(&load_tool.input_schema)
            }
            _ => false,
        })
    });
    if stale_tool {
        return true;
    }
    session.get("messages").and_then(Value::as_array).is_some_and(|messages| {
        messages.iter().any(|m| {
            m.get("role").and_then(Value::as_str) == Some("system")
                && m.get("content").and_then(Value::as_str).is_some_and(|c| c.contains("<tool-bridge>") && !c.contains(TOOL_BRIDGE_GUIDANCE))
        })
    })
}

/// `isBridgeToolDefinition`: a bridge-only definition (never part of the scoped catalog).
pub fn is_bridge_tool_definition(tool: &Value) -> bool {
    let name = tool.get("name").map_or_else(String::new, |n| mixdog_js::value_to_string(n));
    if name == "search_tools" || name == "call_tool" {
        return true;
    }
    name == "load_tool"
        && tool.get("description").and_then(Value::as_str).is_some_and(|d| LEGACY_BRIDGE_LOAD_TOOL_DESCRIPTIONS.contains(&d))
}

/// The provider-native tool objects a session's request sends ahead of the schemas, in wire order.
/// A conversation's request has none, whatever the exposure: `opts.nativeTools` is set only by the
/// hosted web-search send (`session-runtime/native-web-search.mjs`), a one-shot request outside any
/// session's fingerprint, and the request boundary starts its native prefix at zero for every
/// provider. The exposure mode is taken so a future native tool lands here, in one place.
pub fn native_request_tools(_session: &Value) -> Vec<Value> {
    Vec::new()
}

#[cfg(test)]
mod tests {

    use serde_json::json;

    use super::*;

    fn golden() -> Value {
        serde_json::from_str(include_str!("golden/tool_exposure.json")).expect("fixture")
    }

    /// The shared loader Node's bridge carries is the one the Rust tool definition has.
    #[test]
    fn the_shared_load_tool_is_the_rust_definition() {
        let rust: Value = serde_json::from_str(include_str!("../../../mixdog-tools/src/orch/defs/load_tool.json")).unwrap();
        let load = LoadToolDef::from_def(&rust);
        assert_eq!(json!(load.description), golden()["load"]["description"]);
        assert_eq!(load.input_schema, golden()["load"]["inputSchema"]);
    }

    /// Node's real functions over 13 stored sessions.
    #[test]
    fn exposure_and_migration_follow_node() {
        let golden = golden();
        let load = LoadToolDef { description: golden["load"]["description"].as_str().unwrap().to_owned(), input_schema: golden["load"]["inputSchema"].clone() };
        for (name, row) in golden["sessions"].as_object().unwrap() {
            let s = &row["session"];
            assert_eq!(json!(session_tool_exposure(s)), row["exposure"], "{name} exposure");
            assert_eq!(json!(tool_exposure_migration_needed(s, None, &load)), row["migrationNeeded"], "{name} migration");
            assert_eq!(json!(bridge_surface_outdated(s, &load)), row["outdated"], "{name} outdated");
            assert_eq!(json!(tool_exposure_migration_needed(s, Some("gemini"), &load)), row["forGemini"], "{name} for gemini");
            assert_eq!(json!(tool_exposure_migration_needed(s, Some("openai"), &load)), row["forOpenai"], "{name} for openai");
        }
        assert_eq!(TOOL_BRIDGE_GUIDANCE, golden["guidance"].as_str().unwrap());
    }

    #[test]
    fn the_provider_decides_the_mode_unless_a_verified_route_is_pinned() {
        let golden = golden();
        for (provider, want) in golden["modes"].as_object().unwrap() {
            let given = if provider == "undefined" { "" } else { provider.as_str() };
            assert_eq!(tool_exposure_mode_for_provider(given, None), want.as_str().unwrap(), "{provider:?}");
        }
        let route = json!({ "provider": "groq", "wire": "messages", "nativeDeferredTools": true });
        assert_eq!(tool_exposure_mode_for_provider("groq", Some(&route)), golden["modes_route"].as_str().unwrap());
    }

    /// Node's request assembly (`snapshotProviderRequestTools`) leaves no native prefix on any provider.
    #[test]
    fn a_session_request_has_no_native_tools() {
        let golden: Value = serde_json::from_str(include_str!("golden/native_tools.json")).unwrap();
        for (provider, row) in golden.as_object().unwrap() {
            assert_eq!(row["nativeCount"], 0, "{provider}");
            assert!(native_request_tools(&json!({ "provider": provider })).is_empty(), "{provider}");
        }
    }

    #[test]
    fn bridge_only_definitions_are_recognised() {

        let load = golden()["load"]["description"].clone();
        assert!(is_bridge_tool_definition(&json!({ "name": "search_tools" })));
        assert!(is_bridge_tool_definition(&json!({ "name": "call_tool" })));
        assert!(is_bridge_tool_definition(&json!({ "name": "load_tool", "description": LEGACY_BRIDGE_LOAD_TOOL_DESCRIPTIONS[0] })));
        assert!(!is_bridge_tool_definition(&json!({ "name": "load_tool", "description": load })));
        assert!(!is_bridge_tool_definition(&json!({ "name": "read" })));
    }
}
