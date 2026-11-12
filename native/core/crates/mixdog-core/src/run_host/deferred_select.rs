//! Loading deferred tools into a session that is not on the tool bridge (Node
//! `runtime-core/tool-catalog.mjs`): `selectDeferredTools` (`:864`), `toolSearchNativePayload`
//! (`:199`), `activeToolSchemas` (`:223`) and the branch of `renderToolSearch` (`:1036`) that a
//! native or fixed-surface session's `load_tool` runs. The session is the thread's header as a
//! `Value`, changed in place as Node changes its live session; whatever the load asks of the world
//! (the route's exclusions, the MCP servers' status) is looked up before and passed in.

use std::collections::HashMap;

use mixdog_store::schema::record::Header;
use serde_json::Map;
use serde_json::Value;
use serde_json::json;

use super::route_schema::Verdict;
use super::route_schema::freeform;
use super::route_schema::schema_verdict;
use super::session_catalog::announce_mcp_servers;
use super::session_catalog::deferred_available;
use super::session_catalog::mcp_server_selection;
use super::session_catalog::pending_mcp_instructions;
use super::session_catalog::strings;
use super::tool_surface::ToolSurface;
use super::tool_surface::clean;
use super::tool_surface::expand_selection_names;
use super::tool_surface::filter_disallowed_tools;
use super::tool_surface::parse_tool_selection;
use super::tool_surface::permitted_by_session_policy;
use super::tool_surface::readonly_selectable;
use super::tool_surface::sorted_names_by_measured_usage;
use super::tool_surface::tool_name;
use super::tool_surface::truthy;

/// What `selectDeferredTools` did.
pub(super) struct Selection {
    pub(super) added: Vec<String>,
    pub(super) already: Vec<String>,
    /// `(name, reason)`.
    pub(super) blocked: Vec<(String, String)>,
    pub(super) missing: Vec<String>,
    pub(super) native: bool,
}

impl Selection {
    /// `{added, already, blocked, missing, native}` as Node returns it.
    pub(super) fn to_value(&self) -> Value {
        json!({
            "added": self.added,
            "already": self.already,
            "blocked": blocked_value(&self.blocked),
            "missing": self.missing,
            "native": self.native,
        })
    }
}

fn blocked_value(blocked: &[(String, String)]) -> Value {
    Value::Array(blocked.iter().map(|(name, reason)| json!({ "name": name, "reason": reason })).collect())
}

/// An ordered set: `name` joins unless it is in already.
pub(super) fn insert(set: &mut Vec<String>, name: String) {
    if !set.contains(&name) {
        set.push(name);
    }
}

pub(super) fn names_value(names: &[String]) -> Value {
    Value::Array(names.iter().cloned().map(Value::String).collect())
}

/// `resolvableCatalog(session)`: the deferred catalog union, or the session's own tools when
/// nothing is deferred, within what the session's policy lets it run.
pub(super) fn resolvable(surface: &ToolSurface<'_>, session: &Value) -> Vec<Value> {
    let mut tools = surface.catalog_union(session);
    if tools.is_empty() {
        tools = session.get("tools").and_then(Value::as_array).cloned().unwrap_or_default();
    }
    filter_disallowed_tools(&tools, &strings(session, "disallowedTools")).into_iter().filter(|tool| permitted_by_session_policy(session, &tool_name(tool))).collect()
}

/// `routeToolExclusionReason(session, tool)`: why the route leaves the tool out of every request,
/// when it does: the provider dropped it (`excluded`), or the wire's schema rule refuses it.
pub(super) fn route_exclusion(header: &Header, excluded: &[(String, String)], tool: &Value) -> Option<String> {
    let raw = tool.get("name").and_then(Value::as_str).unwrap_or_default();
    if let Some((_, reason)) = excluded.iter().find(|(name, _)| name == raw) {
        return Some(reason.clone());
    }
    match schema_verdict(header, tool) {
        Verdict::Excluded(reason) => Some(reason),
        Verdict::Sent => None,
    }
}

/// `selectDeferredTools(session, names, mode, { exact })`, `readonly` being `mode === 'readonly'`
/// and `excluded` the route's dropped tools.
pub(super) fn select(surface: &ToolSurface<'_>, session: &mut Value, excluded: &[(String, String)], names: &[String], readonly: bool, exact: bool) -> Selection {
    let header = session.as_object().cloned().unwrap_or_default();
    let catalog = resolvable(surface, session);
    let mut active: Vec<String> = Vec::new();
    let eager = session.get("tools").and_then(Value::as_array).map_or(&[][..], Vec::as_slice);
    for name in eager.iter().map(tool_name).filter(|name| !name.is_empty()).chain(parse_tool_selection(session.get("deferredCallableTools"))) {
        insert(&mut active, name);
    }
    let native = session.get("deferredProviderMode").and_then(Value::as_str) == Some("native") || session.get("deferredNativeTools") == Some(&Value::Bool(true));
    let mut discovered: Vec<String> = Vec::new();
    for name in session.get("deferredDiscoveredTools").and_then(Value::as_array).into_iter().flatten().filter_map(Value::as_str) {
        insert(&mut discovered, name.to_owned());
    }
    // Bridge sessions keep a fixed surface: deferred tools are described and run through the
    // bridge, never appended to `session.tools`.
    let bridge = super::tool_exposure::is_tool_bridge_enabled(session);
    let mut by_name: HashMap<String, usize> = HashMap::new();
    for (index, tool) in catalog.iter().enumerate() {
        let name = tool_name(tool);
        if !name.is_empty() {
            by_name.insert(name.clone(), index);
            by_name.insert(name.to_lowercase(), index);
        }
    }
    let lookup = |key: &str| by_name.get(key).or_else(|| by_name.get(&key.to_lowercase())).map(|&index| &catalog[index]);
    let requested: Vec<String> = if exact {
        names.to_vec()
    } else {
        expand_selection_names(names)
            .into_iter()
            .flat_map(|raw| {
                let key = mixdog_js::js_trim(&raw).to_owned();
                if lookup(&key).is_some() {
                    return vec![key];
                }
                let members = mcp_server_selection(&catalog, &key);
                if members.is_empty() { vec![key] } else { members }
            })
            .collect()
    };
    let mut unique: Vec<String> = Vec::new();
    for raw in requested {
        insert(&mut unique, raw);
    }
    let mut selection = Selection { added: Vec::new(), already: Vec::new(), blocked: Vec::new(), missing: Vec::new(), native };
    for raw in unique {
        let requested = mixdog_js::js_trim(&raw);
        let Some(tool) = lookup(requested).filter(|tool| deferred_available(session, &tool_name(tool))) else {
            selection.missing.push(requested.to_owned());
            continue;
        };
        let name = tool_name(tool);
        // A tool this route never sends is not loaded and not listed as active.
        if !bridge && let Some(reason) = route_exclusion(&header, excluded, tool) {
            selection.blocked.push((name, reason));
            continue;
        }
        if readonly && !readonly_selectable(tool) {
            selection.blocked.push((name, "readonly mode".to_owned()));
            continue;
        }
        if bridge || active.contains(&name) || (native && discovered.contains(&name)) {
            selection.already.push(name);
            continue;
        }
        if native {
            insert(&mut discovered, name.clone());
        } else {
            if let Some(Value::Array(tools)) = session.get_mut("tools") {
                tools.push(tool.clone());
            }
            discovered.retain(|known| *known != name);
        }
        insert(&mut active, name.clone());
        selection.added.push(name);
    }
    if !bridge && let Some(map) = session.as_object_mut() {
        let selected = names_value(&sorted_names_by_measured_usage(active));
        if native {
            map.insert("deferredCallableTools".to_owned(), selected.clone());
            map.insert("deferredDiscoveredTools".to_owned(), names_value(&sorted_names_by_measured_usage(discovered)));
        } else {
            map.insert("deferredDiscoveredTools".to_owned(), selected.clone());
        }
        map.insert("deferredSelectedTools".to_owned(), selected);
    }
    selection
}

/// `toolParameters(tool)`.
fn tool_parameters(tool: &Value) -> Value {
    tool.get("inputSchema").filter(|schema| schema.is_object() || schema.is_array()).cloned().unwrap_or_else(|| json!({ "type": "object", "properties": {} }))
}

/// `openAILoadableToolSpec(tool, provider)`: a free-form tool as the Responses API's custom tool
/// where the provider has them, else a deferred function with its input schema.
fn loadable_spec(tool: &Value, name: &str, custom_tools: bool) -> Value {
    if custom_tools && freeform(tool) {
        let mut spec = Map::new();
        spec.insert("type".to_owned(), json!("custom"));
        spec.insert("name".to_owned(), tool.get("name").cloned().unwrap_or(Value::Null));
        // `tool.freeformDescription || tool.description`; an absent description is left out.
        let description = tool.get("freeformDescription").filter(|text| truthy(Some(*text))).or_else(|| tool.get("description"));
        if let Some(description) = description {
            spec.insert("description".to_owned(), description.clone());
        }
        spec.insert("format".to_owned(), tool.get("freeform").cloned().unwrap_or(Value::Null));
        return Value::Object(spec);
    }
    json!({ "type": "function", "name": name, "description": clean(tool.get("description")), "defer_loading": true, "parameters": tool_parameters(tool) })
}

/// `toolSearchNativePayload(catalog, names, provider)`: the named tools in the catalog's order, as
/// the provider's tool search takes them; `None` when none of them is in the catalog.
pub(super) fn tool_search_native_payload<'a>(catalog: impl IntoIterator<Item = &'a Value>, names: &[String], provider: &str) -> Option<Value> {
    let selected: Vec<&str> = names.iter().map(|name| mixdog_js::js_trim(name)).filter(|name| !name.is_empty()).collect();
    if selected.is_empty() {
        return None;
    }
    let provider = mixdog_js::js_trim(provider).to_lowercase();
    let custom_tools = matches!(provider.as_str(), "" | "openai" | "openai-oauth");
    let (mut references, mut tools) = (Vec::new(), Vec::new());
    for tool in catalog {
        let name = tool_name(tool);
        if name.is_empty() || !selected.contains(&name.as_str()) {
            continue;
        }
        tools.push(loadable_spec(tool, &name, custom_tools));
        references.push(name);
    }
    if references.is_empty() {
        return None;
    }
    let summary = format!("Loaded deferred tools: {}", references.join(", "));
    Some(json!({ "provider": provider, "toolReferences": references, "openaiTools": tools, "summary": summary }))
}

/// `activeToolSchemas(catalog, session, names)`: the schemas of tools already active, the
/// session's own first.
fn active_tool_schemas(catalog: &[Value], session: &Value, names: &[String]) -> Vec<Value> {
    let wanted: Vec<&str> = names.iter().map(|name| mixdog_js::js_trim(name)).filter(|name| !name.is_empty()).collect();
    let mut seen: Vec<String> = Vec::new();
    let mut specs = Vec::new();
    let eager = session.get("tools").and_then(Value::as_array).map_or(&[][..], Vec::as_slice);
    for tool in eager.iter().chain(catalog) {
        let name = tool_name(tool);
        if name.is_empty() || !wanted.contains(&name.as_str()) || seen.contains(&name) {
            continue;
        }
        seen.push(name.clone());
        specs.push(json!({ "name": name, "description": clean(tool.get("description")), "parameters": tool_parameters(tool) }));
    }
    specs
}

/// The MCP servers `mcpStatus` names as still connecting (`disconnected`) and as `failed`, each
/// sorted, once (`pendingAndFailedMcpServers`). A status that is not `{servers: [..]}` names none.
pub(super) fn pending_and_failed_mcp_servers(status: &Value) -> (Vec<String>, Vec<String>) {
    let (mut pending, mut failed) = (Vec::new(), Vec::new());
    for row in status.get("servers").and_then(Value::as_array).into_iter().flatten() {
        let name = clean(row.get("name"));
        if name.is_empty() {
            continue;
        }
        match row.get("status").and_then(Value::as_str) {
            Some("disconnected") => insert(&mut pending, name),
            Some("failed") => insert(&mut failed, name),
            _ => {}
        }
    }
    pending.sort();
    failed.sort();
    (pending, failed)
}

/// `sessionFeatureDenies(session, name)`: a settings gate closed `name` for the session.
fn feature_denies(session: &Value, name: &str) -> bool {
    let name = name.to_lowercase();
    session.get("featureDeniedTools").and_then(Value::as_array).is_some_and(|denied| denied.iter().any(|d| d.as_str().is_some_and(|d| d.to_lowercase() == name)))
}

/// `permittedNames(session, names)`.
fn permitted(session: &Value, names: Vec<String>) -> Vec<String> {
    names.into_iter().filter(|name| permitted_by_session_policy(session, name)).collect()
}

/// `sentOnRoute(session, catalog)`: the names the route sends (a name of no known tool is sent).
fn sent_on_route(header: &Header, excluded: &[(String, String)], session: &Value, catalog: &[Value], names: Vec<String>) -> Vec<String> {
    let eager = session.get("tools").and_then(Value::as_array).map_or(&[][..], Vec::as_slice);
    let mut by_name: HashMap<String, &Value> = HashMap::new();
    for tool in catalog.iter().chain(eager) {
        by_name.insert(clean(tool.get("name")), tool);
    }
    names.into_iter().filter(|name| by_name.get(name).is_none_or(|tool| route_exclusion(header, excluded, tool).is_none())).collect()
}

/// The names of the session's own tools.
fn eager_names(session: &Value) -> Vec<String> {
    session.get("tools").and_then(Value::as_array).into_iter().flatten().map(tool_name).filter(|name| !name.is_empty()).collect()
}

/// `JSON.stringify(value, null, 2)`.
fn pretty(value: &Value) -> String {
    serde_json::to_string_pretty(value).expect("a JSON value serializes")
}

/// `renderToolSearch(args, session, mode, { mcpStatus })` for a session not on the bridge: loads
/// the named deferred tools into `session` and answers what it did. `excluded` is the route's
/// dropped tools, `status` the `mcpStatus()` answer (anything else names no server).
pub(super) fn render_tool_search(surface: &ToolSurface<'_>, session: &mut Value, args: &Value, mode: &str, excluded: &[(String, String)], status: &Value) -> String {
    let catalog = resolvable(surface, session);
    let requested = parse_tool_selection(args.get("names"));
    let (pending, failed) = pending_and_failed_mcp_servers(status);
    let mcp_fields = |out: &mut Map<String, Value>| {
        if !pending.is_empty() {
            out.insert("pendingMcpServers".to_owned(), names_value(&pending));
        }
        if !failed.is_empty() {
            out.insert("failedMcpServers".to_owned(), names_value(&failed));
        }
    };
    let header = session.as_object().cloned().unwrap_or_default();
    if requested.is_empty() {
        // `clean(args.query || args.q || args.text)`.
        let stray = ["query", "q", "text"].iter().find_map(|key| args.get(*key).filter(|value| truthy(Some(*value)))).map(|value| clean(Some(value))).unwrap_or_default();
        let error = if stray.is_empty() {
            "load_tool requires names:[\"exact_tool_name\", ...] (deferred tool names/aliases).".to_owned()
        } else {
            format!("load_tool is a loader, not a search: \"{stray}\" is not an exact tool name. Pass names:[\"exact_tool_name\", ...] (deferred tool names/aliases). No keyword search.")
        };
        let mut out = Map::new();
        out.insert("error".to_owned(), json!(error));
        out.insert("loaded".to_owned(), json!([]));
        out.insert("alreadyActive".to_owned(), json!([]));
        out.insert("missing".to_owned(), json!([]));
        mcp_fields(&mut out);
        let active = sent_on_route(&header, excluded, session, &catalog, permitted(session, eager_names(session)));
        out.insert("activeTools".to_owned(), names_value(&sorted_names_by_measured_usage(active)));
        out.insert("discoveredTools".to_owned(), names_value(&sorted_names_by_measured_usage(permitted(session, discovered_names(session)))));
        return pretty(&Value::Object(out));
    }
    let selection = select(surface, session, excluded, &requested, mode == "readonly", false);
    let mut next_active: Vec<String> = Vec::new();
    for name in eager_names(session).into_iter().chain(parse_tool_selection(session.get("deferredCallableTools"))) {
        insert(&mut next_active, name);
    }
    let loaded = selection.added.clone();
    let already = selection.already.clone();
    // A tool a settings gate closed is named as such, not as unknown.
    let disabled: Vec<String> = selection.missing.iter().filter(|name| feature_denies(session, name)).cloned().collect();
    let missing: Vec<String> = selection.missing.iter().filter(|name| !disabled.contains(name)).cloned().collect();
    let both: Vec<String> = loaded.iter().chain(&already).cloned().collect();
    let provider = clean(session.get("provider"));
    // Native discovery is history-driven: an explicit re-selection emits the reference again.
    let native_base = selection.native.then(|| {
        tool_search_native_payload(&catalog, &both, &provider).unwrap_or_else(|| json!({ "provider": provider.to_lowercase(), "toolReferences": [], "openaiTools": [], "summary": "" }))
    });
    let already_schemas = if selection.native { Vec::new() } else { active_tool_schemas(&catalog, session, &already) };
    let mut summary: Vec<String> = Vec::new();
    if !loaded.is_empty() {
        summary.push(format!("Loaded deferred tools: {}", loaded.join(", ")));
    }
    if !already.is_empty() {
        summary.push(format!("Already active: {}", already.join(", ")));
    }
    let native_search = native_base.map(|mut base| {
        if !summary.is_empty() {
            base["summary"] = json!(summary.join("\n"));
        }
        base
    });
    let mut notes: Vec<String> = Vec::new();
    if !disabled.is_empty() {
        notes.push(format!("Disabled in settings: {}. Do not retry unless the user turns it on.", disabled.join(", ")));
    }
    if !missing.is_empty() && !pending.is_empty() {
        notes.push("Some requested names may belong to an MCP server still connecting — retry next turn.".to_owned());
    }
    if !missing.is_empty() && !failed.is_empty() {
        notes.push("Some requested names may belong to a failed MCP server; those tools are unavailable.".to_owned());
    }
    // Tools the session already had active count too: their server's text may never have been told.
    let told = pending_mcp_instructions(session, &catalog, &both);
    announce_mcp_servers(session, &told);
    let instructions = told.iter().map(|entry| entry.block.as_str()).collect::<Vec<_>>().join("\n");
    let mut out = Map::new();
    out.insert("selected".to_owned(), json!({ "mode": "select", "tools": selection.to_value() }));
    if let Some(native_search) = native_search {
        out.insert("nativeToolSearch".to_owned(), native_search);
    }
    if !instructions.is_empty() {
        out.insert("mcpInstructions".to_owned(), json!(instructions));
    }
    out.insert("loaded".to_owned(), names_value(&loaded));
    out.insert("alreadyActive".to_owned(), names_value(&already));
    if !already_schemas.is_empty() {
        out.insert("alreadyActiveSchemas".to_owned(), Value::Array(already_schemas));
    }
    out.insert("missing".to_owned(), names_value(&missing));
    if !disabled.is_empty() {
        out.insert("disabledInSettings".to_owned(), names_value(&disabled));
    }
    if !selection.blocked.is_empty() {
        out.insert("blocked".to_owned(), blocked_value(&selection.blocked));
    }
    mcp_fields(&mut out);
    let available: Vec<String> = permitted(session, next_active).into_iter().filter(|name| deferred_available(session, name)).collect();
    let header = session.as_object().cloned().unwrap_or_default();
    let active = sent_on_route(&header, excluded, session, &catalog, available);
    out.insert("activeTools".to_owned(), names_value(&sorted_names_by_measured_usage(active)));
    out.insert("discoveredTools".to_owned(), names_value(&sorted_names_by_measured_usage(permitted(session, discovered_names(session)))));
    if !notes.is_empty() {
        out.insert("note".to_owned(), json!(notes.join(" ")));
    }
    pretty(&Value::Object(out))
}

/// `session.deferredDiscoveredTools` as `permittedNames` reads it (`names || []`).
fn discovered_names(session: &Value) -> Vec<String> {
    session.get("deferredDiscoveredTools").and_then(Value::as_array).into_iter().flatten().filter_map(Value::as_str).map(str::to_owned).collect()
}

/// `scopeMode(session)` of the `load_tool` handler (`knowledge-tools.mjs`): the session's surface
/// mode, else the mode its tool spec names, else the thread's own (`rt.mode`).
pub(super) fn scope_mode(session: &Value, thread_mode: &str) -> String {
    if let Some(mode) = session.get("deferredSurfaceMode").filter(|mode| truthy(Some(*mode))) {
        return clean(Some(mode));
    }
    let named = match session.get("toolSpec") {
        Some(Value::String(spec)) if spec == "readonly" => Some("readonly"),
        Some(Value::String(spec)) if spec == "full" || spec == "mcp" => Some("full"),
        Some(Value::Array(items)) if !items.is_empty() => {
            let has = |tag: &str| items.iter().any(|item| item.as_str() == Some(tag));
            Some(if has("full") { "full" } else if has("tools:readonly") { "readonly" } else { "full" })
        }
        _ => None,
    };
    named.unwrap_or(thread_mode).to_owned()
}
