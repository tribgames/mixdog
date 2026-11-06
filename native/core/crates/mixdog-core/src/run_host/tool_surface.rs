//! The deferred tool surface (Node `runtime-core/tool-catalog.mjs`: `applyDeferredToolSurface`,
//! `rebuildDeferredToolSurfaceForProvider`, with `tool-catalog-data.mjs`, the ordering and
//! selection helpers of `tool-catalog-schema.mjs`, `deferred-tool-availability.mjs` and
//! `filterModelEditTools` of `edit-tool-dialect.mjs`).
//!
//! A session is its stored object (`Value`) with its `tools` and `messages`, changed in place as
//! Node's live session is; the caller turns the result into a header change (everything but
//! `messages`) and the rewritten system messages.

use std::collections::{HashMap, HashSet};
use std::sync::LazyLock;

use mixdog_agent::env::Clock;
use mixdog_js::{js_trim, locale_compare, JsRegex};
use serde_json::{json, Map, Value};

use super::deferred_manifest::{apply_initial_manifest, listed_deferred_tool_names};
use super::tool_exposure::{
    bridge_surface_outdated, deferred_provider_mode, is_bridge_tool_definition, is_tool_bridge_enabled, native_provider_family, session_tool_exposure,
    tool_exposure_mode_for_provider, LoadToolDef, TOOL_EXPOSURE_BRIDGE, TOOL_EXPOSURE_NATIVE,
};

/// Canonical route order: locator, path, content, symbol, read, edit, execute.
const ROUTE_TOOL_ORDER: [&str; 13] = ["explore", "find", "glob", "list", "grep", "code_graph", "read", "edit", "apply_patch", "git", "github", "shell", "task"];

/// Measured call counts (3-day trace window): order the unrouted tail and feed `deferredToolUsage`.
const MEASURED_TOOL_USAGE: [(&str, u64); 15] = [
    ("read", 710),
    ("code_graph", 520),
    ("grep", 500),
    ("find", 480),
    ("glob", 460),
    ("list", 430),
    ("edit", 400),
    ("apply_patch", 400),
    ("git", 0),
    ("agent", 330),
    ("shell", 81),
    ("cwd", 2),
    ("recall", 2),
    ("web_search", 2),
    ("web_fetch", 2),
];

const DEFAULT_FULL_TOOLS: [&str; 12] = ["find", "glob", "list", "grep", "code_graph", "read", "edit", "apply_patch", "web_search", "todo", "Skill", "load_tool"];
const DEFAULT_READONLY_TOOLS: [&str; 10] = ["find", "glob", "list", "grep", "code_graph", "read", "web_search", "todo", "Skill", "load_tool"];
const DEFAULT_LEAD_TOOLS: [&str; 19] = [
    "explore", "find", "glob", "list", "grep", "code_graph", "read", "edit", "apply_patch", "git", "shell", "task", "agent", "ask_user", "react", "web_search", "todo", "Skill",
    "load_tool",
];

/// Tools a read-only session may call by name, whatever their annotations.
const READONLY_TOOL_NAMES: [&str; 10] = ["read", "list", "grep", "find", "glob", "code_graph", "web_search", "web_fetch", "recall", "Skill"];

const SELECT_ALIASES: [(&str, &[&str]); 10] = [
    ("filesystem", &["read", "list", "grep", "find", "glob"]),
    ("websearch", &["web_search", "web_fetch"]),
    ("web", &["web_fetch", "web_search"]),
    ("memory", &["memory", "recall"]),
    ("agent", &["agent"]),
    ("graph", &["code_graph"]),
    ("code", &["code_graph"]),
    ("shell", &["shell", "task"]),
    ("git", &["git"]),
    ("github", &["github"]),
];

static SELECT_PREFIX: LazyLock<JsRegex> = LazyLock::new(|| JsRegex::new_static(r"^select\s*:", "i"));
static SELECTION_SEPARATOR: LazyLock<JsRegex> = LazyLock::new(|| JsRegex::new_static(r"[,\s]+", ""));

/// What a surface needs from the host: the bridge's own definitions (`TOOL_BRIDGE_TOOLS`, the
/// shared `load_tool` among them) and the connected MCP servers' instruction text.
pub trait SurfaceHost: Send + Sync {
    fn bridge_tools(&self) -> Vec<Value>;
    /// `getMcpServerInstructionsMap(scopeId)`: server name to its trimmed instructions.
    fn mcp_server_instructions(&self, scope: Option<&str>) -> Value;
}

/// `options` of `applyDeferredToolSurface`.
#[derive(Default, Clone)]
pub struct ApplyOptions {
    pub provider: Option<String>,
    pub model: Option<String>,
    pub disallowed: Vec<String>,
}

// ---- value helpers -------------------------------------------------------------------------------

/// `clean`: `String(value ?? '').trim()`.
pub(super) fn clean(value: Option<&Value>) -> String {
    match value {
        None | Some(Value::Null) => String::new(),
        Some(Value::String(s)) => js_trim(s).to_owned(),
        Some(other) => js_trim(&mixdog_js::value_to_string(other)).to_owned(),
    }
}

fn truthy(value: Option<&Value>) -> bool {
    match value {
        None | Some(Value::Null) => false,
        Some(Value::Bool(b)) => *b,
        Some(Value::String(s)) => !s.is_empty(),
        Some(Value::Number(n)) => n.as_f64().is_some_and(|f| f != 0.0 && !f.is_nan()),
        Some(_) => true,
    }
}

fn map_mut(session: &mut Value) -> &mut Map<String, Value> {
    session.as_object_mut().expect("session object")
}

fn tools_of(session: &Value) -> &[Value] {
    session.get("tools").and_then(Value::as_array).map_or(&[], Vec::as_slice)
}

/// Array elements as `clean` strings (`[]` for anything but an array).
fn clean_list(session: &Value, key: &str) -> Vec<String> {
    session.get(key).and_then(Value::as_array).map_or_else(Vec::new, |items| items.iter().map(|v| clean(Some(v))).collect())
}

fn names_value(names: &[String]) -> Value {
    Value::Array(names.iter().map(|n| Value::String(n.clone())).collect())
}

fn unique(names: impl IntoIterator<Item = String>) -> Vec<String> {
    let mut seen = HashSet::new();
    names.into_iter().filter(|n| seen.insert(n.clone())).collect()
}

fn tool_name(tool: &Value) -> String {
    clean(tool.get("name"))
}

// ---- ordering ------------------------------------------------------------------------------------

fn route_rank(name: &str) -> u64 {
    ROUTE_TOOL_ORDER.iter().position(|n| *n == js_trim(name)).map_or(u64::MAX, |i| i as u64)
}

fn measured_usage(name: &str) -> u64 {
    MEASURED_TOOL_USAGE.iter().find(|(n, _)| *n == js_trim(name)).map_or(0, |(_, usage)| *usage)
}

/// `sortedNamesByMeasuredUsage`: canonical route order first; measured usage orders the unrouted tail.
pub fn sorted_names_by_measured_usage(mut names: Vec<String>) -> Vec<String> {
    names.sort_by(|a, b| {
        route_rank(a)
            .cmp(&route_rank(b))
            .then_with(|| measured_usage(b).cmp(&measured_usage(a)))
            .then_with(|| locale_compare(a, b))
    });
    names
}

fn sorted_catalog_by_measured_usage(mut catalog: Vec<Value>) -> Vec<Value> {
    catalog.sort_by(|a, b| {
        let (a, b) = (tool_name(a), tool_name(b));
        route_rank(&a).cmp(&route_rank(&b)).then_with(|| measured_usage(&b).cmp(&measured_usage(&a)))
    });
    catalog
}

/// `parseToolSelection`.
pub fn parse_tool_selection(value: Option<&Value>) -> Vec<String> {
    if let Some(items) = value.and_then(Value::as_array) {
        return items.iter().map(|v| clean(Some(v))).filter(|s| !s.is_empty()).collect();
    }
    let text = match value {
        None | Some(Value::Null) | Some(Value::Bool(false)) => String::new(),
        Some(Value::String(s)) => s.clone(),
        Some(other) => mixdog_js::value_to_string(other),
    };
    let text = match SELECT_PREFIX.find(&text) {
        Some(range) => format!("{}{}", &text[..range.start], &text[range.end..]),
        None => text,
    };
    let mut parts = Vec::new();
    let mut from = 0;
    for range in SELECTION_SEPARATOR.find_iter(&text) {
        parts.push(&text[from..range.start]);
        from = range.end;
    }
    parts.push(&text[from..]);
    parts.into_iter().map(|p| js_trim(p).to_owned()).filter(|s| !s.is_empty()).collect()
}

fn expand_selection_names(names: &[String]) -> Vec<String> {
    let mut out = Vec::new();
    for raw in names {
        let key = js_trim(raw);
        if key.is_empty() {
            continue;
        }
        match SELECT_ALIASES.iter().find(|(alias, _)| *alias == key.to_lowercase()) {
            Some((_, tools)) => out.extend(tools.iter().map(|t| (*t).to_owned())),
            None => out.push(key.to_owned()),
        }
    }
    unique(out)
}

/// `canonicalDeferredToolNames`: `names` (aliases expanded, case folded) as the catalog spells them.
fn canonical_deferred_tool_names(catalog: &[Value], names: &[String]) -> Vec<String> {
    let mut by_name: HashMap<String, String> = HashMap::new();
    for tool in catalog {
        let name = tool_name(tool);
        if name.is_empty() {
            continue;
        }
        by_name.insert(name.clone(), name.clone());
        by_name.insert(name.to_lowercase(), name);
    }
    let out = expand_selection_names(names).into_iter().filter_map(|raw| {
        let name = js_trim(&raw).to_owned();
        by_name.get(&name).or_else(|| by_name.get(&name.to_lowercase())).cloned()
    });
    sorted_names_by_measured_usage(unique(out))
}

// ---- policy --------------------------------------------------------------------------------------

fn lower(value: &Value) -> String {
    if truthy(Some(value)) { mixdog_js::value_to_string(value).to_lowercase() } else { String::new() }
}

fn permitted_by_session_policy(session: &Value, name: &str) -> bool {
    let name = name.to_lowercase();
    let excluded = session.get("schemaAllowedTools").and_then(Value::as_array).is_some_and(|allowed| !allowed.iter().any(|a| lower(a) == name));
    let denied = session.get("disallowedTools").and_then(Value::as_array).is_some_and(|denied| denied.iter().any(|d| lower(d) == name));
    !excluded && !denied
}

/// `filterDisallowedTools`: old session catalogs must not resurrect the separate staging schema.
fn filter_disallowed_tools(tools: &[Value], disallowed: &[String]) -> Vec<Value> {
    let deny: HashSet<&str> = std::iter::once("git_stage").chain(disallowed.iter().map(String::as_str)).filter(|s| !s.is_empty()).collect();
    tools.iter().filter(|t| !deny.contains(tool_name(t).as_str())).cloned().collect()
}

fn disallowed_of(session: &Value) -> Vec<String> {
    clean_list(session, "disallowedTools")
}

/// `resolveDeferredSelectMode(session) === 'readonly'`.
fn readonly_tool_spec(session: &Value) -> bool {
    match session.get("toolSpec") {
        Some(Value::String(spec)) => spec == "readonly",
        Some(Value::Array(items)) => {
            let has = |tag: &str| items.iter().any(|i| i.as_str() == Some(tag));
            !has("full") && has("tools:readonly")
        }
        _ => false,
    }
}

fn bridge_readonly_session(session: &Value) -> bool {
    session.get("deferredSurfaceMode").and_then(Value::as_str) == Some("readonly") || readonly_tool_spec(session)
}

/// `isReadonlySelectable`.
fn readonly_selectable(tool: &Value) -> bool {
    if READONLY_TOOL_NAMES.contains(&tool_name(tool).as_str()) {
        return true;
    }
    let annotations = tool.get("annotations");
    if annotations.and_then(|a| a.get("destructiveHint")) == Some(&Value::Bool(true)) {
        return false;
    }
    annotations.and_then(|a| a.get("readOnlyHint")) == Some(&Value::Bool(true))
}

/// Whether a bridge session's roster may name `tool`: only what its own policy lets it run.
fn roster_permits(session: &Value, tool: &Value) -> bool {
    if !is_tool_bridge_enabled(session) {
        return true;
    }
    if !permitted_by_session_policy(session, &tool_name(tool)) {
        return false;
    }
    !(bridge_readonly_session(session) && !readonly_selectable(tool))
}

fn fixed_surface_session(session: &Value) -> bool {
    matches!(session.get("deferredProviderMode").and_then(Value::as_str), Some("full" | "manifest" | "canonical")) && !is_tool_bridge_enabled(session)
}

// ---- model edit dialect --------------------------------------------------------------------------

fn gpt_family_model(model: &str) -> bool {
    let lowered = js_trim(model).to_lowercase();
    let leaf = lowered.rsplit('/').next().unwrap_or_default();
    let rest = leaf.strip_prefix("chat").unwrap_or(leaf);
    rest.strip_prefix("gpt").is_some_and(|after| after.chars().next().is_none_or(|c| matches!(c, '-' | '_' | '.') || c.is_ascii_digit()))
}

fn model_edit_tool_name(model: &str) -> &'static str {
    if gpt_family_model(model) { "apply_patch" } else { "edit" }
}

/// `unusedModelEditToolName`: the edit dialect this model never receives.
pub fn unused_model_edit_tool_name(model: &str) -> &'static str {
    if model_edit_tool_name(model) == "edit" { "apply_patch" } else { "edit" }
}

fn keeps_edit_tool(name: &str, selected: &str) -> bool {
    let key = name.to_lowercase();
    !matches!(key.as_str(), "apply_patch" | "edit") || key == selected
}

/// `filterModelEditToolNames`.
pub fn filter_model_edit_tool_names(names: &[String], model: &str) -> Vec<String> {
    let selected = model_edit_tool_name(model);
    names.iter().filter(|n| keeps_edit_tool(n, selected)).cloned().collect()
}

/// `filterModelEditTools`: every non-edit tool and only the edit dialect the model can call, the
/// dialect token in static descriptions rewritten to it.
pub fn filter_model_edit_tools(tools: &[Value], model: &str) -> Vec<Value> {
    const TOKEN: &str = "edit/apply_patch";
    let selected = model_edit_tool_name(model);
    tools
        .iter()
        .filter(|t| keeps_edit_tool(&t.get("name").map_or_else(String::new, lower), selected))
        .map(|tool| match tool.get("description").and_then(Value::as_str).filter(|d| d.contains(TOKEN)) {
            Some(description) => {
                let mut next = tool.clone();
                next["description"] = Value::String(description.replace(TOKEN, selected));
                next
            }
            None => tool.clone(),
        })
        .collect()
}

// ---- the surface ---------------------------------------------------------------------------------

pub struct ToolSurface<'a> {
    pub host: &'a dyn SurfaceHost,
    pub clock: &'a dyn Clock,
}

impl ToolSurface<'_> {
    fn load_tool_def(&self) -> LoadToolDef {
        self.host.bridge_tools().iter().find(|t| t.get("name").and_then(Value::as_str) == Some("load_tool")).map_or_else(
            || LoadToolDef { description: String::new(), input_schema: Value::Null },
            LoadToolDef::from_def,
        )
    }

    /// `deferredCatalogUnion`: definition history, the boot catalog with refreshed MCP definitions
    /// winning same-name collisions. Selection separately checks current availability.
    pub fn catalog_union(&self, session: &Value) -> Vec<Value> {
        let disallowed = disallowed_of(session);
        let list = |key: &str| session.get(key).and_then(Value::as_array).map_or(&[][..], Vec::as_slice);
        let boot = filter_disallowed_tools(list("deferredToolCatalog"), &disallowed);
        let late = filter_disallowed_tools(list("deferredLateToolCatalog"), &disallowed);
        if late.is_empty() {
            return boot;
        }
        let mut order: Vec<String> = Vec::new();
        let mut by_name: HashMap<String, Value> = HashMap::new();
        for tool in boot {
            let name = tool_name(&tool);
            if !name.is_empty() && !by_name.contains_key(&name) {
                order.push(name.clone());
                by_name.insert(name, tool);
            }
        }
        for tool in late {
            let name = tool_name(&tool);
            if !name.is_empty() {
                if !by_name.contains_key(&name) {
                    order.push(name.clone());
                }
                by_name.insert(name, tool);
            }
        }
        order.into_iter().filter_map(|n| by_name.remove(&n)).collect()
    }

    fn stored_names(session: &Value) -> Vec<String> {
        for key in ["deferredDiscoveredTools", "deferredSelectedTools"] {
            let names = parse_tool_selection(session.get(key));
            if !names.is_empty() {
                return names;
            }
        }
        Vec::new()
    }

    fn set_tool_state(session: &mut Value, names: &[String]) {
        let selected = sorted_names_by_measured_usage(unique(parse_tool_selection(Some(&names_value(names)))));
        let map = map_mut(session);
        map.insert("deferredDiscoveredTools".into(), names_value(&selected));
        map.insert("deferredSelectedTools".into(), names_value(&selected));
    }

    /// The pool a native or bridge manifest lists: the catalog less what is active, named only
    /// where the session's policy lets it run.
    pub fn pool_tool_names(&self, session: &Value) -> Vec<String> {
        if fixed_surface_session(session) {
            return Vec::new();
        }
        let mut active: HashSet<String> = tools_of(session).iter().map(tool_name).filter(|n| !n.is_empty()).collect();
        active.extend(parse_tool_selection(session.get("deferredCallableTools")));
        let catalog = session.get("deferredToolCatalog").and_then(Value::as_array).map_or(&[][..], Vec::as_slice);
        let out = catalog.iter().filter(|tool| {
            let name = tool_name(tool);
            !name.is_empty() && !active.contains(&name) && roster_permits(session, tool)
        });
        sorted_names_by_measured_usage(out.map(tool_name).collect())
    }

    /// The surface's catalog, rebuilt from the full catalog (current definitions before retained
    /// ones). Bridge definitions belong to the exposure, never to the catalog.
    fn surface_catalog(&self, session: &Value, extra: &[Value], options: &ApplyOptions) -> Vec<Value> {
        let model = options.model.clone().filter(|m| !m.is_empty()).unwrap_or_else(|| clean(session.get("model")));
        let candidates: Vec<Value> = tools_of(session).iter().cloned().chain(extra.iter().cloned()).chain(self.catalog_union(session)).filter(|t| !is_bridge_tool_definition(t)).collect();
        let mut denied = disallowed_of(session);
        denied.extend(options.disallowed.iter().cloned());
        let candidates = filter_disallowed_tools(&filter_model_edit_tools(&candidates, &model), &denied);
        let mut seen = HashSet::new();
        let by_name = candidates.into_iter().filter(|tool| {
            let name = tool_name(tool);
            !name.is_empty() && seen.insert(name)
        });
        sorted_catalog_by_measured_usage(by_name.collect())
    }

    /// The mode's eager tools in `catalog`, less those the session keeps loadable.
    fn surface_default_names(session: &Value, catalog: &[Value], mode: &str) -> Vec<String> {
        let available: HashSet<String> = catalog.iter().map(tool_name).filter(|n| !n.is_empty()).collect();
        let defaults: &[&str] = match mode {
            "lead" => &DEFAULT_LEAD_TOOLS,
            "readonly" => &DEFAULT_READONLY_TOOLS,
            _ => &DEFAULT_FULL_TOOLS,
        };
        let mut names: Vec<String> = defaults.iter().filter(|n| available.contains(**n)).map(|n| (*n).to_owned()).collect();
        // The mode the prompt was built with: a mid-conversation switch never reshapes the surface.
        let orchestration = if truthy(session.get("workflowOverlay")) {
            session["workflowOverlay"].get("promptOrchestrationMode")
        } else if truthy(session.get("orchestrationModeOverlay")) {
            session["orchestrationModeOverlay"].get("prompt")
        } else {
            session.get("orchestrationMode")
        };
        // Solo keeps `agent` in the deferred pool: loadable on request, never eager.
        if orchestration.and_then(Value::as_str) == Some("none") {
            names.retain(|n| n != "agent");
        }
        // Tools a workflow switch opened stay loadable, never eager, until the prompt is rebuilt.
        let opened = clean_list(session, "workflowOpenedTools");
        names.retain(|n| !opened.contains(n));
        names
    }

    fn surface_selected_names(session: &Value, catalog: &[Value], defaults: &[String], provider_mode: &str, bridge: bool) -> Vec<String> {
        // Bridge sessions expose the mode's core only: a stored selection never widens the wire
        // surface, and load_tool is the bridge's own.
        let stored = if provider_mode == "native" || bridge { Vec::new() } else { Self::stored_names(session) };
        let mut selected = if stored.is_empty() { Vec::new() } else { canonical_deferred_tool_names(catalog, &stored) };
        if selected.is_empty() || provider_mode == "native" {
            selected = sorted_names_by_measured_usage(defaults.to_vec());
        }
        if bridge {
            selected.retain(|n| n != "load_tool");
        }
        selected
    }

    /// `session.tools` becomes the selected definitions (plus the bridge's own); returns the active names.
    fn install_tools(&self, session: &mut Value, catalog: &[Value], selected: &HashSet<String>, mode: &str, bridge: bool) -> Vec<String> {
        let mut tools = Vec::new();
        let mut active = Vec::new();
        for tool in catalog {
            let name = tool_name(tool);
            if !selected.contains(&name) || (mode == "readonly" && !readonly_selectable(tool)) {
                continue;
            }
            tools.push(tool.clone());
            active.push(name);
        }
        // Every other definition stays in the scoped catalog, reached through the bridge. A
        // tool-free session stays tool-free.
        if bridge && !catalog.is_empty() {
            tools.extend(self.host.bridge_tools());
        }
        let map = map_mut(session);
        map.insert("tools".into(), Value::Array(tools));
        if bridge {
            map.insert("toolExposureMode".into(), json!(TOOL_EXPOSURE_BRIDGE));
        } else {
            map.shift_remove("toolExposureMode");
        }
        active
    }

    /// Keeps the prompt's deferred-tool block and the announced set in step with the surface.
    fn refresh_manifest(&self, session: &mut Value, exposure_changed: bool) {
        let has_system = |s: &Value| s.get("messages").and_then(Value::as_array).is_some_and(|m| m.iter().any(|m| m.get("role").and_then(Value::as_str) == Some("system")));
        let scope = session.get("mcpScopeId").and_then(Value::as_str).map(str::to_owned);
        if exposure_changed && has_system(session) {
            // Replace the previous exposure's fixed block once: the native deferred manifest, or
            // the bridge roster and guidance. History stays as is.
            session["mcpServerInstructions"] = self.host.mcp_server_instructions(scope.as_deref());
            let pool = self.pool_tool_names(session);
            apply_initial_manifest(session, &pool, true, self.clock);
            let rendered = rendered_manifest(session);
            let pool = self.pool_tool_names(session);
            let announced = listed_deferred_tool_names(session, &pool, &rendered);
            session["deferredAnnouncedTools"] = names_value(&announced);
        }
        let applied = |s: &Value| s.get("deferredToolBp2Applied").and_then(Value::as_bool) == Some(true);
        if !applied(session) && has_system(session) {
            if !session.get("mcpServerInstructions").is_some_and(Value::is_object) {
                session["mcpServerInstructions"] = self.host.mcp_server_instructions(scope.as_deref());
            }
            let pool = self.pool_tool_names(session);
            apply_initial_manifest(session, &pool, false, self.clock);
        }
        if !session.get("deferredAnnouncedTools").is_some_and(Value::is_array) && applied(session) {
            // Seed the announced set with everything the manifest already advertises, so the
            // turn-boundary MCP delta announces only genuinely new, late-connecting tools.
            let pool = self.pool_tool_names(session);
            session["deferredAnnouncedTools"] = names_value(&pool);
        }
    }

    /// `applyDeferredToolSurface(session, mode, extraTools, options)`.
    pub fn apply(&self, session: &mut Value, mode: &str, extra: &[Value], options: &ApplyOptions) {
        if !session.get("tools").is_some_and(Value::is_array) {
            return;
        }
        let provider = options.provider.clone().filter(|p| !p.is_empty()).unwrap_or_else(|| clean(session.get("provider")));
        let route = session.get("wireRoute").cloned();
        // The pinned wire route decides a gateway's mode (it names its own provider, so a surface
        // built for another provider ignores it).
        let provider_mode = deferred_provider_mode(&provider, route.as_ref());
        let exposure = tool_exposure_mode_for_provider(&provider, route.as_ref());
        let bridge = exposure == TOOL_EXPOSURE_BRIDGE;
        // An existing surface built for another exposure is migrated, not merely re-selected; a
        // surface an earlier bridge revision built is rebuilt once, the same rewrite.
        let previous = session_tool_exposure(session);
        let exposure_changed = previous.as_deref().is_some_and(|p| p != exposure || (bridge && bridge_surface_outdated(session, &self.load_tool_def())));
        // The one native <-> bridge transition, whoever triggers it: leaving native keeps its
        // discoveries aside, and the way back restores them below.
        if previous.as_deref() == Some(TOOL_EXPOSURE_NATIVE) && bridge {
            let kept = canonical_deferred_tool_names(&self.catalog_union(session), &clean_list(session, "deferredDiscoveredTools"));
            session["nativeDeferredDiscovery"] = names_value(&kept);
        }
        let catalog = self.surface_catalog(session, extra, options);
        let defaults = Self::surface_default_names(session, &catalog, mode);
        let selected: HashSet<String> = Self::surface_selected_names(session, &catalog, &defaults, provider_mode, bridge).into_iter().collect();
        {
            let map = map_mut(session);
            map.insert("deferredToolCatalog".into(), Value::Array(catalog.clone()));
            map.insert("deferredToolUsage".into(), Value::Object(MEASURED_TOOL_USAGE.iter().map(|(n, u)| ((*n).to_owned(), json!(u))).collect()));
            map.insert("deferredDefaultTools".into(), names_value(&sorted_names_by_measured_usage(defaults)));
            map.insert("deferredProviderMode".into(), json!(provider_mode));
            map.insert("deferredNativeTools".into(), json!(provider_mode == "native"));
            map.insert("deferredSurfaceMode".into(), json!(mode));
        }
        let active = self.install_tools(session, &catalog, &selected, mode, bridge);
        map_mut(session).insert("deferredCallableTools".into(), names_value(&sorted_names_by_measured_usage(active.clone())));
        if provider_mode == "native" {
            let restored = if previous.as_deref() == Some(TOOL_EXPOSURE_BRIDGE) { clean_list(session, "nativeDeferredDiscovery") } else { Vec::new() };
            map_mut(session).shift_remove("nativeDeferredDiscovery");
            let mut known = clean_list(session, "deferredDiscoveredTools");
            known.extend(restored);
            let discovered = canonical_deferred_tool_names(&catalog, &known);
            let map = map_mut(session);
            map.insert("deferredSelectedTools".into(), names_value(&active));
            map.insert("deferredDiscoveredTools".into(), names_value(&discovered.into_iter().filter(|n| !selected.contains(n)).collect::<Vec<_>>()));
        } else {
            Self::set_tool_state(session, &active);
        }
        self.refresh_manifest(session, exposure_changed);
    }

    /// `rebuildDeferredToolSurfaceForProvider(session, provider)`: the surface for another provider.
    pub fn rebuild_for_provider(&self, session: &mut Value, provider: &str) {
        if !session.get("tools").is_some_and(Value::is_array) {
            return;
        }
        let route = session.get("wireRoute").cloned();
        let previous_family = native_provider_family(&clean(session.get("provider")), route.as_ref());
        let next_family = native_provider_family(provider, route.as_ref());
        let preserve = !previous_family.is_empty() && previous_family == next_family;
        let union = self.catalog_union(session);
        let discovered = if preserve { canonical_deferred_tool_names(&union, &clean_list(session, "deferredDiscoveredTools")) } else { Vec::new() };
        let from_bridge = is_tool_bridge_enabled(session);
        // Another native family starts without this family's discoveries. Leaving native for the
        // bridge keeps them: `apply` sets them aside.
        if !next_family.is_empty() {
            session["deferredDiscoveredTools"] = names_value(&discovered);
        }
        let mode = session.get("deferredSurfaceMode").and_then(Value::as_str).filter(|m| !m.is_empty()).unwrap_or("lead").to_owned();
        self.apply(session, &mode, &union, &ApplyOptions { provider: Some(provider.to_owned()), ..ApplyOptions::default() });
        // Back from the bridge: the discoveries `apply` restored become callable again. Otherwise
        // exactly the native family's own.
        let eager: HashSet<String> = tools_of(session).iter().map(tool_name).collect();
        let kept = if from_bridge {
            sorted_names_by_measured_usage(clean_list(session, "deferredDiscoveredTools").into_iter().filter(|n| !eager.contains(n)).collect())
        } else {
            discovered
        };
        if session.get("deferredProviderMode").and_then(Value::as_str) == Some("native") && !kept.is_empty() {
            let callable = sorted_names_by_measured_usage(unique(clean_list(session, "deferredCallableTools").into_iter().chain(kept.iter().cloned())));
            let map = map_mut(session);
            map.insert("deferredDiscoveredTools".into(), names_value(&kept));
            map.insert("deferredSelectedTools".into(), names_value(&callable));
            map.insert("deferredCallableTools".into(), names_value(&callable));
        }
    }
}

/// The rendered manifest text, or "" when no system message carries one.
fn rendered_manifest(session: &Value) -> String {
    session
        .get("messages")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .find(|m| m.get("role").and_then(Value::as_str) == Some("system") && m.get("content").and_then(Value::as_str).is_some_and(|c| c.contains("<available-deferred-tools>")))
        .and_then(|m| m.get("content").and_then(Value::as_str))
        .unwrap_or_default()
        .to_owned()
}

#[cfg(test)]
mod tests {
    use super::*;

    struct Fixed;
    impl Clock for Fixed {
        fn now_ms(&self) -> i64 {
            1_700_000_000_000
        }
    }

    struct Host(Vec<Value>);
    impl SurfaceHost for Host {
        fn bridge_tools(&self) -> Vec<Value> {
            self.0.clone()
        }
        fn mcp_server_instructions(&self, _scope: Option<&str>) -> Value {
            json!({})
        }
    }

    /// Node's `applyDeferredToolSurface` and `rebuildDeferredToolSurfaceForProvider` over 18
    /// sessions: native, bridge and manifest providers, modes, policy rosters, switches between
    /// families and back.
    #[test]
    fn the_surface_follows_node() {
        let golden: Value = serde_json::from_str(include_str!("golden/tool_surface.json")).expect("fixture");
        let host = Host(golden["bridgeTools"].as_array().unwrap().clone());
        let surface = ToolSurface { host: &host, clock: &Fixed };
        for (name, rows) in golden["cases"].as_object().unwrap() {
            let mut session = rows[0]["before"].clone();
            for (n, row) in rows.as_array().unwrap().iter().enumerate().skip(1) {
                let step = &row["step"];
                if let Some(mode) = step.get("apply").and_then(Value::as_str) {
                    let extra: Vec<Value> = step.get("extra").and_then(Value::as_array).cloned().unwrap_or_default();
                    let options = step.get("options");
                    let options = ApplyOptions {
                        provider: None,
                        model: options.and_then(|o| o.get("model")).and_then(Value::as_str).map(str::to_owned),
                        disallowed: options.and_then(|o| o.get("disallowed")).and_then(Value::as_array).map_or_else(Vec::new, |d| d.iter().filter_map(|v| v.as_str().map(str::to_owned)).collect()),
                    };
                    surface.apply(&mut session, mode, &extra, &options);
                } else if let Some(provider) = step.get("rebuild").and_then(Value::as_str) {
                    surface.rebuild_for_provider(&mut session, provider);
                } else {
                    session["deferredDiscoveredTools"] = step["discovered"].clone();
                }
                let want = &row["after"];
                for key in want.as_object().unwrap().keys().chain(session.as_object().unwrap().keys()) {
                    assert_eq!(session.get(key), want.get(key), "{name} step {n} key {key}");
                }
            }
        }
    }
}
