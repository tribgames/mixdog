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
                    // The serialized strings, as Node compares them (`JSON.stringify`): a schema that reads equal as a value but is
                    // stored with another key order is another definition on the wire.
                    || tool.get("inputSchema").map(Value::to_string) != Some(load_tool.input_schema.to_string())
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
    let name = tool.get("name").map_or_else(String::new, mixdog_js::value_to_string);
    if name == "search_tools" || name == "call_tool" {
        return true;
    }
    name == "load_tool" && tool.get("description").and_then(Value::as_str).is_some_and(|d| LEGACY_BRIDGE_LOAD_TOOL_DESCRIPTIONS.contains(&d))
}

pub fn native_request_tools(_session: &Value) -> Vec<Value> {
    Vec::new()
}

#[cfg(test)]
mod tests {

    use serde_json::json;

    use super::*;

    #[test]
    fn a_load_tool_with_a_differently_serialized_schema_needs_migration() {
        let load = LoadToolDef { description: "load tools".into(), input_schema: json!({ "type": "object", "properties": {} }) };
        let mut session = json!({
            "provider": "gemini", "toolExposureMode": "bridge-v1",
            "tools": [{ "name": "load_tool", "description": &load.description, "inputSchema": &load.input_schema }],
        });
        assert!(!tool_exposure_migration_needed(&session, None, &load));
        session["tools"][0]["inputSchema"] = json!({ "properties": {}, "type": "object" });
        assert!(tool_exposure_migration_needed(&session, None, &load));
    }
}
