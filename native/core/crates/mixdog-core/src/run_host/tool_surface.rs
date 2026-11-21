use std::collections::{HashMap, HashSet};
use std::sync::Arc;
use std::sync::LazyLock;

use mixdog_tools::policy::Withdrawal;

use mixdog_agent::env::Clock;
use mixdog_core_api::domain::tool::StoredTool;
use mixdog_js::{JsRegex, js_trim, locale_compare};
use serde_json::{Map, Value, json};

use super::deferred_manifest::{apply_initial_manifest, listed_deferred_tool_names};
use super::tool_exposure::{
    LoadToolDef, TOOL_EXPOSURE_BRIDGE, TOOL_EXPOSURE_NATIVE, bridge_surface_outdated, deferred_provider_mode, is_bridge_tool_definition,
    is_tool_bridge_enabled, native_provider_family, session_tool_exposure, tool_exposure_mode_for_provider,
};

/// Canonical route order: locator, path, content, symbol, read, edit, execute.
pub(super) const ROUTE_TOOL_ORDER: [&str; 13] =
    ["explore", "find", "glob", "list", "grep", "code_graph", "read", "edit", "apply_patch", "git", "github", "shell", "task"];

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

const DEFAULT_FULL_TOOLS: [&str; 12] =
    ["find", "glob", "list", "grep", "code_graph", "read", "edit", "apply_patch", "web_search", "todo", "Skill", "load_tool"];
const DEFAULT_READONLY_TOOLS: [&str; 10] = ["find", "glob", "list", "grep", "code_graph", "read", "web_search", "todo", "Skill", "load_tool"];
pub(crate) const DEFAULT_LEAD_TOOLS: [&str; 19] = [
    "explore",
    "find",
    "glob",
    "list",
    "grep",
    "code_graph",
    "read",
    "edit",
    "apply_patch",
    "git",
    "shell",
    "task",
    "agent",
    "ask_user",
    "react",
    "web_search",
    "todo",
    "Skill",
    "load_tool",
];

/// Tools a read-only session may call by name, whatever their annotations.
const READONLY_TOOL_NAMES: [&str; 10] = ["read", "list", "grep", "find", "glob", "code_graph", "web_search", "web_fetch", "recall", "Skill"];

pub(super) const SELECT_ALIASES: [(&str, &[&str]); 10] = [
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
    fn defined(&self, name: &str) -> bool;
    fn withdrawal(&self) -> Withdrawal {
        Arc::new(|_, _| false)
    }
    /// Whether the stored MCP entry `name` belongs to an account of a connector (one tool group holding several accounts)
    /// instead of a server: nothing publishes it, whether its entry records a `publisher` (the account's name) or lacks one
    /// (an entry stored by a build that listed every account as a server of its own).
    fn account_tool(&self, _name: &str, _publisher: Option<&str>) -> bool {
        false
    }
    /// Whether `name` can run at this moment (a host or backend is present, the connection is up): availability only, which
    /// moves while the core runs and retires nothing. A host with no registry answers yes.
    fn runs(&self, _name: &str) -> bool {
        true
    }
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

pub(super) fn truthy(value: Option<&Value>) -> bool {
    match value {
        None | Some(Value::Null) => false,
        Some(Value::Bool(b)) => *b,
        Some(Value::String(s)) => !s.is_empty(),
        Some(Value::Number(n)) => n.as_f64().is_some_and(|f| f != 0.0 && !f.is_nan()),
        Some(_) => true,
    }
}

pub(super) fn map_mut(session: &mut Value) -> &mut Map<String, Value> {
    session.as_object_mut().expect("session object")
}

pub(super) fn tools_of(session: &Value) -> &[Value] {
    session.get("tools").and_then(Value::as_array).map_or(&[], Vec::as_slice)
}

/// Array elements as `clean` strings (`[]` for anything but an array).
pub(super) fn clean_list(session: &Value, key: &str) -> Vec<String> {
    session.get(key).and_then(Value::as_array).map_or_else(Vec::new, |items| items.iter().map(|v| clean(Some(v))).collect())
}

pub(super) fn names_value(names: &[String]) -> Value {
    Value::Array(names.iter().map(|n| Value::String(n.clone())).collect())
}

pub(super) fn unique(names: impl IntoIterator<Item = String>) -> Vec<String> {
    let mut seen = HashSet::new();
    names.into_iter().filter(|n| seen.insert(n.clone())).collect()
}

pub(super) fn tool_name(tool: &Value) -> String {
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
    names.sort_by(|a, b| route_rank(a).cmp(&route_rank(b)).then_with(|| measured_usage(b).cmp(&measured_usage(a))).then_with(|| locale_compare(a, b)));
    names
}

pub(super) fn sorted_catalog_by_measured_usage(mut catalog: Vec<Value>) -> Vec<Value> {
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

/// `expandSelectionNames`: aliases expanded, each name once.
pub(super) fn expand_selection_names(names: &[String]) -> Vec<String> {
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

pub(super) fn permitted_by_session_policy(session: &Value, name: &str) -> bool {
    let name = name.to_lowercase();
    let excluded = session.get("schemaAllowedTools").and_then(Value::as_array).is_some_and(|allowed| !allowed.iter().any(|a| lower(a) == name));
    let denied = session.get("disallowedTools").and_then(Value::as_array).is_some_and(|denied| denied.iter().any(|d| lower(d) == name));
    !excluded && !denied
}

/// `filterDisallowedTools`: old session catalogs must not resurrect the separate staging schema.
pub(super) fn filter_disallowed_tools(tools: &[Value], disallowed: &[String]) -> Vec<Value> {
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

pub(super) fn bridge_readonly_session(session: &Value) -> bool {
    session.get("deferredSurfaceMode").and_then(Value::as_str) == Some("readonly") || readonly_tool_spec(session)
}

/// `isReadonlySelectable`.
pub(super) fn readonly_selectable(tool: &Value) -> bool {
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
pub(super) fn roster_permits(session: &Value, tool: &Value) -> bool {
    if !is_tool_bridge_enabled(session) {
        return true;
    }
    if !permitted_by_session_policy(session, &tool_name(tool)) {
        return false;
    }
    !(bridge_readonly_session(session) && !readonly_selectable(tool))
}

pub(super) fn fixed_surface_session(session: &Value) -> bool {
    fixed_surface_mode(session.get("deferredProviderMode"), session.get("toolExposureMode"))
}

pub(super) fn fixed_surface_mode(mode: Option<&Value>, exposure: Option<&Value>) -> bool {
    matches!(mode.and_then(Value::as_str), Some("full" | "manifest" | "canonical")) && exposure.and_then(Value::as_str) != Some(TOOL_EXPOSURE_BRIDGE)
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

/// `bindEditDialectDescription`: a static description names both edit dialects with one token; the
/// session reads the one dialect its model can call. `None` for a description without the token.
pub fn bind_edit_dialect(description: &str, model: &str) -> Option<String> {
    const TOKEN: &str = "edit/apply_patch";
    description.contains(TOKEN).then(|| description.replace(TOKEN, model_edit_tool_name(model)))
}

/// `filterModelEditTools`: every non-edit tool and only the edit dialect the model can call, the
/// dialect token in static descriptions rewritten to it.
pub fn filter_model_edit_tools(tools: &[Value], model: &str) -> Vec<Value> {
    let selected = model_edit_tool_name(model);
    tools
        .iter()
        .filter(|t| keeps_edit_tool(&t.get("name").map_or_else(String::new, lower), selected))
        .map(|tool| match tool.get("description").and_then(Value::as_str).and_then(|description| bind_edit_dialect(description, model)) {
            Some(description) => {
                let mut next = tool.clone();
                next["description"] = Value::String(description);
                next
            }
            None => tool.clone(),
        })
        .collect()
}

/// Whether the stored entry `tool` is withdrawn by the publisher it records itself, `withdrawn` being asked `(name, publisher)`.
/// A withdrawal applies to the entry whose recorded publisher made it: a legacy-unknown entry has no publisher to ask and is
/// never withdrawn, and one entry's publisher never withdraws another entry of the same name.
pub(super) fn entry_withdrawn(tool: &Value, withdrawn: &dyn Fn(&str, &str) -> bool) -> bool {
    StoredTool::decode(tool).publisher().is_some_and(|server| withdrawn(&tool_name(tool), server))
}

/// The stored entry lists (`tools` and both catalogs).
const ENTRY_KEYS: [&str; 3] = ["tools", "deferredToolCatalog", "deferredLateToolCatalog"];

/// The one function that yields a session's surviving entries: `session` with every entry `retired` judges gone removed from the
/// entry lists, entry by entry and before anything is selected by name. Both repair and the retired-name list use its result.
pub(super) fn surviving_entries(session: &Value, retired: &dyn Fn(&Value) -> bool) -> Value {
    let mut kept = session.clone();
    for key in ENTRY_KEYS {
        if let Some(Value::Array(items)) = kept.get_mut(key) {
            items.retain(|tool| !retired(tool));
        }
    }
    kept
}

/// The names the entries of `session` carry.
fn entry_names(session: &Value) -> HashSet<String> {
    ENTRY_KEYS.iter().flat_map(|key| session.get(*key).and_then(Value::as_array).into_iter().flatten()).map(tool_name).collect()
}

// ---- the surface ---------------------------------------------------------------------------------

pub struct ToolSurface<'a> {
    pub host: &'a dyn SurfaceHost,
    pub clock: &'a dyn Clock,
}

impl ToolSurface<'_> {
    fn load_tool_def(&self) -> LoadToolDef {
        self.host
            .bridge_tools()
            .iter()
            .find(|t| t.get("name").and_then(Value::as_str) == Some("load_tool"))
            .map_or_else(|| LoadToolDef { description: String::new(), input_schema: Value::Null }, LoadToolDef::from_def)
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

    /// Whether the core can run `name` now (the host's current availability).
    pub(super) fn runs(&self, name: &str) -> bool {
        self.host.runs(name)
    }

    /// The one availability projection every publication reads: the tool runs now and, for a connected server's tool, the
    /// session's scoped MCP snapshot lists it (`isDeferredToolAvailable`). Stored definitions and selections are never
    /// changed by it; what is advertised or callable is computed from them through it at the moment of use.
    pub(super) fn available(&self, session: &Value, name: &str) -> bool {
        self.runs(name) && super::session_catalog::deferred_available(session, name)
    }

    /// Why a catalog tool that [`Self::runs`] refuses cannot be called: what `load_tool` answers for it and what a direct call to
    /// it is answered with (one wording; both sides consult the same registered set).
    pub(super) fn unavailable_reason(name: &str) -> String {
        format!("the {name} tool is not available in this environment: no host or backend for it is registered on this core.")
    }

    fn entry_retired(&self, tool: &Value, withdrawal: &Withdrawal) -> bool {
        let name = tool_name(tool);
        let stored = StoredTool::decode(tool);
        if name.starts_with("mcp__") && self.host.account_tool(&name, stored.publisher()) {
            return true;
        }
        if stored.publisher().is_some() {
            entry_withdrawn(tool, &**withdrawal)
        } else if name.starts_with("mcp__") {
            false
        } else {
            !self.host.defined(&name)
        }
    }

    pub(super) fn repair(&self, session: &mut Value) -> bool {
        let withdrawal = self.host.withdrawal();
        let kept = surviving_entries(session, &|tool| self.entry_retired(tool, &withdrawal));
        // A name leaves the stored lists only when entries carried it and none survives; a built-in with no entry left in this
        // build leaves too.
        let surviving = entry_names(&kept);
        let lost: HashSet<String> = entry_names(session).into_iter().filter(|name| !surviving.contains(name)).collect();
        let mut removed = false;
        let Some(map) = session.as_object_mut() else { return false };
        for key in ENTRY_KEYS {
            if let Some(items) = kept.get(key)
                && map.get(key) != Some(items)
            {
                map.insert(key.to_owned(), items.clone());
                removed = true;
            }
        }
        for key in [
            "deferredSelectedTools",
            "deferredDiscoveredTools",
            "deferredCallableTools",
            "deferredDefaultTools",
            "deferredAnnouncedTools",
            "nativeDeferredDiscovery",
        ] {
            if let Some(Value::Array(items)) = map.get_mut(key) {
                let before = items.len();
                items.retain(|name| name.as_str().is_none_or(|name| !lost.contains(name) && (name.starts_with("mcp__") || self.host.defined(name))));
                removed |= items.len() != before;
            }
        }
        removed
    }

    /// The built-ins a stored session still holds that the build no longer defines: what [`Self::repair`] will remove.
    /// Empty for every session the running build made, so a route change that finds none leaves the prompt's prefix as
    /// it was; a caller asks before the rebuild to mark the changed prefix.
    pub fn retired_names(&self, session: &Value) -> Vec<String> {
        let mut retired: Vec<String> = Vec::new();
        let withdrawal = self.host.withdrawal();
        let kept = surviving_entries(session, &|tool| self.entry_retired(tool, &withdrawal));
        for key in ENTRY_KEYS {
            let left = kept.get(key).and_then(Value::as_array).map_or(&[][..], Vec::as_slice);
            for tool in session.get(key).and_then(Value::as_array).into_iter().flatten().filter(|tool| !left.contains(tool)) {
                let name = tool_name(tool);
                if !name.is_empty() && !retired.contains(&name) {
                    retired.push(name);
                }
            }
        }
        retired
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

    fn surface_catalog(&self, session: &Value, extra: &[Value], options: &ApplyOptions) -> Vec<Value> {
        let model = options.model.clone().filter(|m| !m.is_empty()).unwrap_or_else(|| clean(session.get("model")));
        let whole = |tool: &Value| {
            let mut tool = tool.clone();
            if let Some(definition) = extra.iter().find(|definition| tool_name(definition) == tool_name(&tool)) {
                for key in ["title", "trigger"] {
                    if let (Some(value), Some(stored)) = (definition.get(key), tool.as_object_mut()) {
                        stored.entry(key).or_insert_with(|| value.clone());
                    }
                }
            }
            tool
        };
        let candidates: Vec<Value> = tools_of(session)
            .iter()
            .filter(|t| !is_bridge_tool_definition(t))
            .map(whole)
            .chain(extra.iter().cloned())
            .chain(self.catalog_union(session))
            .filter(|t| !is_bridge_tool_definition(t))
            .collect();
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
    fn install_tools(&self, session: &mut Value, catalog: &[Value], selected: &HashSet<String>, mode: &str, bridge: bool, as_stored: bool) -> Vec<String> {
        let mut tools = Vec::new();
        let mut active = Vec::new();
        for tool in catalog {
            let name = tool_name(tool);
            if !selected.contains(&name) || (mode == "readonly" && !readonly_selectable(tool)) {
                continue;
            }
            // Install is a boundary where the definitions are built anew: a selected tool that cannot run now is not installed
            // into the definitions the session sends, but stays in the selection (`active` feeds the stored lists) and is
            // installed at a later boundary once it can. A resume installs the stored definitions as stored (`as_stored`).
            if as_stored || self.available(session, &name) {
                tools.push(tool.clone());
            }
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
    pub(super) fn refresh_manifest(&self, session: &mut Value, exposure_changed: bool) {
        let has_system =
            |s: &Value| s.get("messages").and_then(Value::as_array).is_some_and(|m| m.iter().any(|m| m.get("role").and_then(Value::as_str) == Some("system")));
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
        let retired = self.repair(session);
        self.apply_repaired(session, mode, extra, options, retired, false);
    }

    pub fn restore(&self, session: &mut Value, mode: &str, extra: &[Value], options: &ApplyOptions) {
        if !session.get("tools").is_some_and(Value::is_array) {
            return;
        }
        // Retirement alone is not a migration. A real exposure migration is already rebuilding the cached surface.
        let migrating = super::tool_exposure::tool_exposure_migration_needed(session, options.provider.as_deref(), &self.load_tool_def());
        if !migrating && !self.retired_names(session).is_empty() {
            return;
        }
        let retired = migrating && self.repair(session);
        self.apply_repaired(session, mode, extra, options, retired, true);
    }

    /// [`Self::apply`] over a session [`Self::repair`] already made valid; `retired`: it removed something, so the prompt's
    /// roster that listed it is rewritten once (as an exposure change rewrites it). A session with nothing removed keeps its
    /// roster, so the cached prefix holds.
    fn apply_repaired(&self, session: &mut Value, mode: &str, extra: &[Value], options: &ApplyOptions, retired: bool, as_stored: bool) {
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
        let exposure_changed =
            retired || previous.as_deref().is_some_and(|p| p != exposure || (bridge && bridge_surface_outdated(session, &self.load_tool_def())));
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
        let active = self.install_tools(session, &catalog, &selected, mode, bridge, as_stored);
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
        // Before `union` is read: the catalog handed to `apply` must not carry a tool the core cannot run back in.
        let retired = self.repair(session);
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
        self.apply_repaired(session, &mode, &union, &ApplyOptions { provider: Some(provider.to_owned()), ..ApplyOptions::default() }, retired, false);
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
pub(super) fn rendered_manifest(session: &Value) -> String {
    session
        .get("messages")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .find(|m| {
            m.get("role").and_then(Value::as_str) == Some("system")
                && m.get("content").and_then(Value::as_str).is_some_and(|c| c.contains("<available-deferred-tools>"))
        })
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
        fn defined(&self, _name: &str) -> bool {
            true
        }
        fn bridge_tools(&self) -> Vec<Value> {
            self.0.clone()
        }
        fn mcp_server_instructions(&self, _scope: Option<&str>) -> Value {
            json!({})
        }
    }

    /// A new session's standalone tools are stored projected (no `title`/`trigger`): the catalog takes the trigger
    /// and title their whole definitions declare, so the deferred listing names the trigger, and a field the stored
    /// definition already states stays its own.
    #[test]
    fn a_projected_tool_takes_its_declared_trigger_into_the_catalog() {
        let host = Host(Vec::new());
        let surface = ToolSurface { host: &host, clock: &Fixed };
        let schema = json!({ "type": "object", "properties": {} });
        let mut session = json!({
            "provider": "anthropic",
            "model": "claude-opus-4-6",
            "tools": [
                { "name": "web_fetch", "description": "Fetch the page or docs body of known URLs.", "inputSchema": schema },
                { "name": "recall", "title": "Stored", "description": "Recall.", "inputSchema": schema },
            ],
        });
        let extra = [
            json!({ "name": "web_fetch", "title": "Mixdog Web Fetch", "trigger": "Page or docs body from a known URL.", "description": "Whole.", "inputSchema": schema }),
            json!({ "name": "recall", "title": "Recall", "trigger": "Prior sessions.", "description": "Whole.", "inputSchema": schema }),
        ];
        surface.apply(&mut session, "lead", &extra, &ApplyOptions { provider: None, model: None, disallowed: Vec::new() });
        let catalog = session["deferredToolCatalog"].as_array().expect("catalog");
        let entry = |name: &str| catalog.iter().find(|tool| tool["name"] == name).cloned().expect("entry");
        let fetch = entry("web_fetch");
        assert_eq!((&fetch["trigger"], &fetch["title"]), (&json!("Page or docs body from a known URL."), &json!("Mixdog Web Fetch")));
        assert_eq!(fetch["description"], "Fetch the page or docs body of known URLs.", "the stored definition stays the session's");
        let recall = entry("recall");
        assert_eq!((&recall["trigger"], &recall["title"]), (&json!("Prior sessions."), &json!("Stored")));
    }

    /// A host whose registry lacks `machine`, the tool an upgrade removed.
    struct WithoutMachine;
    impl SurfaceHost for WithoutMachine {
        fn bridge_tools(&self) -> Vec<Value> {
            Vec::new()
        }
        fn mcp_server_instructions(&self, _scope: Option<&str>) -> Value {
            json!({})
        }
        fn defined(&self, name: &str) -> bool {
            name != "machine"
        }
        fn runs(&self, name: &str) -> bool {
            self.defined(name)
        }
    }

    /// A session that outlived the upgrade stored `machine` in its catalogs: nothing the surface reads lists, describes or
    /// resolves it, the next apply drops it from both catalogs (an MCP tool of the late pool stays), and a session
    /// with no removed tool reports none, so its roster and prefix stay as they were.
    #[test]
    fn a_tool_the_core_no_longer_runs_leaves_a_stored_catalog() {
        let schema = json!({ "type": "object", "properties": {} });
        let tool = |name: &str| json!({ "name": name, "description": format!("{name}."), "inputSchema": schema });
        let surface = ToolSurface { host: &WithoutMachine, clock: &Fixed };
        let mut session = json!({
            "provider": "anthropic",
            "model": "smoke",
            "tools": [tool("read"), tool("machine")],
            "deferredToolCatalog": [tool("read"), tool("machine"), tool("web_fetch")],
            "deferredLateToolCatalog": [tool("machine"), tool("mcp__srv__echo")],
            "deferredDiscoveredTools": ["machine", "web_fetch"],
        });
        assert_eq!(surface.retired_names(&session), ["machine"]);
        // A rebuild that cannot prepare replacement tools (the stored ones stay) must not bring it back either.
        let mut rebuilt = session.clone();
        surface.rebuild_for_provider(&mut rebuilt, "anthropic");
        surface.apply(&mut session, "lead", &[], &ApplyOptions::default());
        for session in [&session, &rebuilt] {
            assert!(surface.retired_names(session).is_empty());
            let listed = |key: &str| -> Vec<String> { session[key].as_array().expect("a list").iter().map(tool_name).collect() };
            for key in ["tools", "deferredToolCatalog", "deferredLateToolCatalog"] {
                assert!(!listed(key).contains(&"machine".to_owned()), "{key}");
            }
            assert!(!session["deferredDiscoveredTools"].to_string().contains("machine"));
            assert!(!surface.pool_tool_names(session).contains(&"machine".to_owned()));
            assert_eq!(surface.catalog_union(session).iter().map(tool_name).filter(|n| n == "machine").count(), 0);
        }
        assert_eq!(session["deferredLateToolCatalog"].as_array().unwrap().iter().map(tool_name).collect::<Vec<_>>(), ["mcp__srv__echo"]);
        let current = json!({ "provider": "anthropic", "tools": [tool("read")], "deferredToolCatalog": [tool("read"), tool("web_fetch")] });
        assert!(surface.retired_names(&current).is_empty());
    }

    /// A host whose hub holds one `gmail` connector with the accounts `gmail-2` and `gmail-3`.
    struct Connector;
    impl SurfaceHost for Connector {
        fn bridge_tools(&self) -> Vec<Value> {
            Vec::new()
        }
        fn mcp_server_instructions(&self, _scope: Option<&str>) -> Value {
            json!({})
        }
        fn defined(&self, _name: &str) -> bool {
            true
        }
        fn account_tool(&self, name: &str, publisher: Option<&str>) -> bool {
            match publisher {
                Some(owner) => owner == "gmail-2" || owner == "gmail-3",
                None => name.starts_with("mcp__gmail-2__") || name.starts_with("mcp__gmail-3__"),
            }
        }
    }

    /// A session created while every account of a connector was a server of its own stored an entry (with no recorded publisher)
    /// and a roster line per account. The cold repair drops them: the connector is one tool group.
    #[test]
    fn a_connectors_accounts_stored_as_servers_leave_the_catalog_and_the_roster() {
        let schema = json!({ "type": "object", "properties": {} });
        let tool = |name: &str| json!({ "name": name, "description": "Gmail email: sending, reading, searching or organizing mail.", "inputSchema": schema });
        let stale = ["mcp__gmail__search", "mcp__gmail-2__search", "mcp__gmail-3__search"];
        let surface = ToolSurface { host: &Connector, clock: &Fixed };
        let mut session = json!({
            "provider": "anthropic",
            "model": "smoke",
            "tools": [tool("read")],
            "messages": [
                { "role": "system", "content": "base" },
                { "role": "system", "content": "<available-deferred-tools>\n- mcp__gmail: Gmail.\n- mcp__gmail-2: Gmail.\n- mcp__gmail-3: Gmail.\n</available-deferred-tools>" },
            ],
            // The last entry records its publisher, the account: no server publishes as it any more, so the withdrawal check alone
            // would keep it.
            "deferredToolCatalog": stale.iter().map(|name| tool(name)).chain([mixdog_core_api::domain::tool::StoredTool::mcp(tool("mcp__gmail-2__recorded"), "gmail-2", Some("n")).encode()]).collect::<Vec<_>>(),
            "deferredAnnouncedTools": stale,
        });
        // A refresh while warm rewrites neither the catalog nor the roster: the stale accounts leave at the cold fold or an explicit
        // rebuild, which repair first and then regenerate the manifest.
        let warm = session.clone();
        surface.reconcile_mcp_catalog(&mut session, &[tool("mcp__gmail__search")]);
        assert_eq!(session["deferredToolCatalog"], warm["deferredToolCatalog"]);
        assert_eq!(session["messages"], warm["messages"], "the prompt's roster is not regenerated by a refresh");
        assert!(surface.repair(&mut session));
        surface.refresh_manifest(&mut session, true);
        let names: Vec<String> = session["deferredToolCatalog"].as_array().expect("catalog").iter().map(tool_name).collect();
        assert!(names.contains(&"mcp__gmail__search".to_owned()), "{names:?}");
        assert!(!names.iter().any(|name| name.starts_with("mcp__gmail-")), "{names:?}");
        // The roster: the prompt's deferred-tool block and the announced names. The refresh told the model the accounts it had
        // announced are gone (the pending delta's removal, which names them), and the roster no longer lists them.
        let roster = json!([session["messages"], session["deferredAnnouncedTools"]]).to_string();
        assert!(!roster.contains("mcp__gmail-2") && !roster.contains("mcp__gmail-3"), "{roster}");
        let mut removed: Vec<&str> = stale[1..].iter().copied().chain(["mcp__gmail-2__recorded"]).collect();
        removed.sort_unstable();
        assert_eq!(session["pendingDeferredToolDelta"]["removed"], json!(removed), "{session}");
    }

    /// A host that defines every tool but `machine` (an upgrade removed it) and runs `computer` and `eagerone` only once the flag
    /// is set (the desktop attaching).
    struct Attaching(std::sync::Arc<std::sync::atomic::AtomicBool>);
    impl SurfaceHost for Attaching {
        fn bridge_tools(&self) -> Vec<Value> {
            Vec::new()
        }
        fn mcp_server_instructions(&self, _scope: Option<&str>) -> Value {
            json!({})
        }
        fn defined(&self, name: &str) -> bool {
            name != "machine"
        }
        fn runs(&self, name: &str) -> bool {
            match name {
                "machine" => false,
                "computer" | "eagerone" => self.0.load(std::sync::atomic::Ordering::SeqCst),
                _ => true,
            }
        }
    }

    fn unavailable_tool_session() -> Value {
        let schema = json!({ "type": "object", "properties": {} });
        let tool = |name: &str| json!({ "name": name, "description": format!("{name}."), "inputSchema": schema });
        json!({
            "provider": "anthropic",
            "model": "smoke",
            "tools": [tool("read"), tool("eagerone"), tool("machine")],
            "deferredToolCatalog": [tool("read"), tool("computer"), tool("machine")],
            "deferredLateToolCatalog": [tool("computer")],
            "deferredDiscoveredTools": ["computer", "machine"],
            "deferredSelectedTools": ["read", "computer", "machine"],
            "deferredCallableTools": ["read", "computer", "machine"],
        })
    }

    fn held(session: &Value, key: &str, name: &str) -> bool {
        session[key].as_array().expect("a list").iter().any(|entry| entry == name || tool_name(entry) == name)
    }

    #[test]
    fn an_apply_a_rebuild_and_a_route_change_keep_an_unavailable_tools_definitions_and_remove_a_retired_one() {
        let attached = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
        let surface = ToolSurface { host: &Attaching(attached.clone()), clock: &Fixed };
        let mut session = unavailable_tool_session();
        assert_eq!(surface.retired_names(&session), ["machine"]);
        let (mut rebuilt, mut routed) = (session.clone(), session.clone());
        surface.apply(&mut session, "lead", &[], &ApplyOptions::default());
        surface.rebuild_for_provider(&mut rebuilt, "anthropic");
        surface.rebuild_for_provider(&mut routed, "openai");
        for (which, session) in [("apply", &session), ("rebuild", &rebuilt), ("route change", &routed)] {
            assert!(surface.retired_names(session).is_empty(), "{which}");
            assert!(held(session, "deferredToolCatalog", "computer") && held(session, "deferredToolCatalog", "eagerone"), "{which}: definitions stay");
            assert!(
                !held(session, "deferredToolCatalog", "machine") && !held(session, "deferredDiscoveredTools", "machine"),
                "{which}: a retired name is removed"
            );
            assert!(
                !held(session, "tools", "machine") && !held(session, "deferredCallableTools", "machine") && !held(session, "deferredSelectedTools", "machine"),
                "{which}"
            );
        }
    }

    #[test]
    fn the_selection_of_an_unavailable_tool_stays_on_the_same_provider() {
        let attached = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
        let surface = ToolSurface { host: &Attaching(attached.clone()), clock: &Fixed };
        let mut session = unavailable_tool_session();
        let mut rebuilt = session.clone();
        surface.apply(&mut session, "lead", &[], &ApplyOptions::default());
        surface.rebuild_for_provider(&mut rebuilt, "anthropic");
        assert!(
            held(&session, "deferredDiscoveredTools", "computer") && held(&rebuilt, "deferredDiscoveredTools", "computer"),
            "the selection stays on the same provider"
        );
        assert!(held(&session, "deferredLateToolCatalog", "computer"), "and in the late catalog");
    }

    #[test]
    fn an_unavailable_tool_is_advertised_again_once_it_can_run_with_no_reload() {
        let attached = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
        let surface = ToolSurface { host: &Attaching(attached.clone()), clock: &Fixed };
        let mut session = unavailable_tool_session();
        surface.apply(&mut session, "lead", &[], &ApplyOptions::default());
        let listed = |session: &mut Value| -> Value {
            serde_json::from_str(&super::super::deferred_select::render_tool_search(&surface, session, &json!({ "names": [] }), "lead", &[], &Value::Null))
                .expect("json")
        };
        let before = listed(&mut session);
        assert!(
            !before.to_string().contains("computer") && !before["activeTools"].to_string().contains("eagerone"),
            "nothing advertised names it while it cannot run: {before}"
        );
        attached.store(true, std::sync::atomic::Ordering::SeqCst);
        let after = listed(&mut session);
        assert!(after["discoveredTools"].to_string().contains("computer"), "{after}");
        let selection = super::super::deferred_select::select(&surface, &mut session, &[], &["computer".to_owned()], false, false);
        assert_eq!(selection.already, ["computer"], "{:?}", selection.to_value());
        assert!(selection.added.is_empty() && selection.unavailable.is_empty());
    }

    /// A host that defines everything and runs `.1` only while the flag is set.
    struct Gated(std::sync::Arc<std::sync::atomic::AtomicBool>, &'static str);
    impl SurfaceHost for Gated {
        fn bridge_tools(&self) -> Vec<Value> {
            Vec::new()
        }
        fn mcp_server_instructions(&self, _scope: Option<&str>) -> Value {
            json!({})
        }
        fn defined(&self, _name: &str) -> bool {
            true
        }
        fn runs(&self, name: &str) -> bool {
            name != self.1 || self.0.load(std::sync::atomic::Ordering::SeqCst)
        }
    }

    #[test]
    fn availability_never_edits_the_sent_definitions_between_boundaries() {
        let on = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
        let surface = ToolSurface { host: &Gated(on.clone(), "web_search"), clock: &Fixed };
        let schema = json!({ "type": "object", "properties": {} });
        let tool = |name: &str| json!({ "name": name, "description": format!("{name}."), "inputSchema": schema });
        let held: Vec<Value> = ["read", "web_search", "web_fetch", "grep"].iter().map(|name| tool(name)).collect();
        let mut session = json!({ "provider": "anthropic", "model": "smoke", "toolSpec": "full", "tools": held });
        let sent = |session: &Value| -> String { tools_of(session).iter().map(Value::to_string).collect::<Vec<_>>().join("\n") };
        let names = |session: &Value| -> Vec<String> { tools_of(session).iter().map(tool_name).collect() };
        // The boundary: web_search cannot run, so it is not installed, yet it stays selected.
        surface.apply(&mut session, "lead", &[], &ApplyOptions::default());
        assert!(!names(&session).contains(&"web_search".to_owned()));
        assert!(session["deferredCallableTools"].to_string().contains("web_search"), "the selection keeps it");
        let epoch = sent(&session);
        // Availability flips and a listing and a model load run: the sent definitions are byte-identical.
        for flip in [true, false, true] {
            on.store(flip, std::sync::atomic::Ordering::SeqCst);
            // A load of `read`, already active, answers the whole active set (a load with no names lists the eager names alone).
            let listing = super::super::deferred_select::render_tool_search(&surface, &mut session, &json!({ "names": ["read"] }), "lead", &[], &Value::Null);
            let listing: Value = serde_json::from_str(&listing).expect("json");
            let active = listing["activeTools"].as_array().expect("active").iter().any(|name| name == "web_search");
            assert_eq!(active, flip, "the listing follows availability: {listing}");
            assert_eq!(sent(&session), epoch, "flip {flip}");
        }
        // A model load on a native route is a reference, not an edit of the sent definitions.
        super::super::deferred_select::select(&surface, &mut session, &[], &["web_fetch".to_owned()], false, false);
        assert_eq!(sent(&session), epoch);
        assert!(session["deferredDiscoveredTools"].to_string().contains("web_fetch"));
        // The next boundary installs it now that it can run.
        surface.apply(&mut session, "lead", &[], &ApplyOptions::default());
        assert!(names(&session).contains(&"web_search".to_owned()));
        // A withdrawn name is retired once: the first repair removes it, the second finds nothing and the definitions hold.
        let machine = |session: &mut Value| session["deferredToolCatalog"].as_array_mut().expect("catalog").push(tool("machine"));
        let retiring = ToolSurface { host: &WithoutMachine, clock: &Fixed };
        machine(&mut session);
        assert!(retiring.repair(&mut session));
        let after = sent(&session);
        assert!(!retiring.repair(&mut session));
        assert_eq!(sent(&session), after);
    }

    /// A host whose server `.0` has withdrawn every tool it published.
    struct Withdraws(&'static str);
    impl SurfaceHost for Withdraws {
        fn bridge_tools(&self) -> Vec<Value> {
            Vec::new()
        }
        fn mcp_server_instructions(&self, _scope: Option<&str>) -> Value {
            json!({})
        }
        fn defined(&self, _name: &str) -> bool {
            true
        }
        fn withdrawal(&self) -> Withdrawal {
            let server = self.0;
            Arc::new(move |_, owner| owner == server)
        }
    }

    fn entry_of(publisher: Option<&str>, description: &str) -> Value {
        let doc = json!({ "name": "mcp__x__n", "description": description, "inputSchema": { "type": "object", "properties": {} } });
        match publisher {
            Some(server) => StoredTool::mcp(doc, server, Some("n")).encode(),
            None => doc,
        }
    }

    #[test]
    fn a_withdrawal_removes_the_entry_of_its_publisher_and_never_another_of_the_same_name() {
        let session = || {
            json!({
                "deferredToolCatalog": [entry_of(None, "boot")], "deferredLateToolCatalog": [entry_of(Some("fs"), "late")],
                "deferredSelectedTools": ["mcp__x__n"],
            })
        };
        let mut migrated = session();
        assert!(ToolSurface { host: &Withdraws("fs"), clock: &Fixed }.repair(&mut migrated));
        assert_eq!(migrated["deferredToolCatalog"], json!([entry_of(None, "boot")]), "the legacy-unknown entry stays");
        assert_eq!(migrated["deferredLateToolCatalog"], json!([]), "the publisher's own entry goes");
        assert_eq!(migrated["deferredSelectedTools"], json!(["mcp__x__n"]), "an entry still holds the name");
        // Two publishers of one name: only the withdrawing one's entry goes, whichever it is.
        for (gone, stays) in [("a", "b"), ("b", "a")] {
            let mut both = json!({
                "tools": [entry_of(Some("a"), "from a")], "deferredToolCatalog": [entry_of(Some("b"), "from b")], "deferredSelectedTools": ["mcp__x__n"],
            });
            assert!(ToolSurface { host: &Withdraws(gone), clock: &Fixed }.repair(&mut both));
            let left = [both["tools"].clone(), both["deferredToolCatalog"].clone()].concat_entries();
            assert_eq!(left, vec![entry_of(Some(stays), &format!("from {stays}"))], "{gone} withdrew: only its own entry goes");
            assert_eq!(both["deferredSelectedTools"], json!(["mcp__x__n"]));
        }
        // When every entry of the name is withdrawn, the name leaves the stored lists too.
        let mut all = json!({ "deferredToolCatalog": [entry_of(Some("fs"), "x")], "deferredSelectedTools": ["mcp__x__n"] });
        assert!(ToolSurface { host: &Withdraws("fs"), clock: &Fixed }.repair(&mut all));
        assert_eq!(all["deferredSelectedTools"], json!([]));
    }

    /// The entries of two stored arrays, in one list.
    trait ConcatEntries {
        fn concat_entries(self) -> Vec<Value>;
    }
    impl ConcatEntries for [Value; 2] {
        fn concat_entries(self) -> Vec<Value> {
            self.iter().flat_map(|list| list.as_array().expect("entries").clone()).collect()
        }
    }

    const GATED_LEAD_TOOLS: [&str; 4] = ["browser", "browser_devtools", "memory", "recall"];
    const LEAD_PROVIDERS: [(&str, bool); 2] = [("custom-11111111-1111-4111-8111-111111111111", true), ("anthropic", false)];

    fn new_lead_session(surface: &ToolSurface<'_>, provider: &str) -> Value {
        let schema = json!({ "type": "object", "properties": {} });
        let tool = |name: &str| json!({ "name": name, "description": format!("{name}."), "inputSchema": schema });
        let eager = [
            "find",
            "glob",
            "list",
            "grep",
            "code_graph",
            "read",
            "edit",
            "git",
            "shell",
            "task",
            "agent",
            "ask_user",
            "web_search",
            "todo",
            "Skill",
            "load_tool",
        ];
        let held: Vec<Value> = eager.iter().chain(GATED_LEAD_TOOLS.iter()).chain(["computer"].iter()).map(|name| tool(name)).collect();
        let mut session = json!({ "provider": provider, "model": "smoke", "toolSpec": "full", "tools": held });
        surface.apply(&mut session, "lead", &[], &ApplyOptions { provider: None, model: None, disallowed: vec!["computer".to_owned()] });
        session
    }

    fn lead_host() -> Host {
        let schema = json!({ "type": "object", "properties": {} });
        Host(["load_tool", "call_tool"].iter().map(|name| json!({ "name": name, "description": format!("{name}."), "inputSchema": schema })).collect())
    }

    fn tool_names_of(session: &Value, key: &str) -> Vec<String> {
        session[key].as_array().expect("a tool list").iter().map(tool_name).collect()
    }

    #[test]
    fn a_lead_surface_defers_the_bridge_and_memory_tools() {
        let host = lead_host();
        let surface = ToolSurface { host: &host, clock: &Fixed };
        for (provider, _) in LEAD_PROVIDERS {
            let session = new_lead_session(&surface, provider);
            let (defined, catalog, roster) =
                (tool_names_of(&session, "tools"), tool_names_of(&session, "deferredToolCatalog"), surface.pool_tool_names(&session));
            for name in GATED_LEAD_TOOLS {
                assert!(!defined.iter().any(|entry| entry == name), "{provider}: {name} is defined in no request of a new session");
                assert!(catalog.iter().any(|entry| entry == name), "{provider}: {name} stays in the deferred catalog");
                assert!(roster.iter().any(|entry| entry == name), "{provider}: the roster lists {name}");
            }
        }
    }

    #[test]
    fn a_lead_surface_leaves_a_denied_tool_out_of_every_list() {
        let host = lead_host();
        let surface = ToolSurface { host: &host, clock: &Fixed };
        for (provider, _) in LEAD_PROVIDERS {
            let session = new_lead_session(&surface, provider);
            let roster = surface.pool_tool_names(&session);
            for list in [tool_names_of(&session, "tools"), tool_names_of(&session, "deferredToolCatalog"), roster] {
                assert!(!list.iter().any(|entry| entry == "computer"), "{provider}: a tool the gates deny is in no list");
            }
        }
    }

    #[test]
    fn a_lead_request_defines_the_eager_core_and_the_bridge_only_on_the_bridge_exposure() {
        let host = lead_host();
        let surface = ToolSurface { host: &host, clock: &Fixed };
        for (provider, bridge) in LEAD_PROVIDERS {
            let session = new_lead_session(&surface, provider);
            let defined = tool_names_of(&session, "tools");
            assert!(defined.iter().any(|entry| entry == "load_tool"), "{provider}: load_tool is defined");
            assert_eq!(defined.iter().any(|entry| entry == "call_tool"), bridge, "{provider}: call_tool belongs to the bridge exposure");
            assert_eq!(session.get("toolExposureMode").and_then(Value::as_str) == Some(TOOL_EXPOSURE_BRIDGE), bridge, "{provider}: the exposure");
            let mut core: Vec<&str> = defined.iter().map(String::as_str).filter(|name| *name != "call_tool").collect();
            core.sort_unstable();
            let mut expected = vec!["find", "glob", "list", "grep", "code_graph", "read", "edit", "git", "shell", "task", "agent", "web_search"];
            expected.extend(["Skill", "ask_user", "load_tool", "todo"]);
            expected.sort_unstable();
            assert_eq!(core, expected, "{provider}: the tools a new Lead session's request defines");
        }
    }

    /// A resume is not a boundary for availability: the stored `tools` are installed as stored, whether the tool can run at that
    /// moment or not (the session's cache is still warm), and a call to a tool that cannot run answers unavailable. Only an
    /// explicit act that builds the definitions anew (here an apply, as a route change does) leaves the unavailable one out.
    #[test]
    fn a_resume_installs_the_stored_definitions_whatever_the_availability() {
        struct Nothing;
        impl mixdog_tools::policy::ToolResolver for Nothing {
            fn resolve(&self, _: Option<&str>, _: &str) -> Option<std::sync::Arc<dyn mixdog_core_api::domain::tool::Tool>> {
                None
            }
        }
        let on = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(true));
        let surface = ToolSurface { host: &Gated(on.clone(), "web_search"), clock: &Fixed };
        let schema = json!({ "type": "object", "properties": {} });
        let tool = |name: &str| json!({ "name": name, "description": format!("{name}."), "inputSchema": schema });
        let held: Vec<Value> = ["read", "grep", "web_search"].iter().map(|name| tool(name)).collect();
        let mut session = json!({ "provider": "anthropic", "model": "smoke", "toolSpec": "full", "tools": held });
        let sent = |session: &Value| tools_of(session).iter().map(Value::to_string).collect::<Vec<_>>().join("\n");
        surface.apply(&mut session, "lead", &[], &ApplyOptions::default());
        let stored = sent(&session);
        assert!(stored.contains("web_search"));
        for open in [false, true, false] {
            on.store(open, std::sync::atomic::Ordering::SeqCst);
            let mut resumed = session.clone();
            surface.restore(&mut resumed, "lead", &[], &ApplyOptions::default());
            assert_eq!(sent(&resumed), stored, "resumed with the gate open: {open}");
            if !open {
                let surface_of = mixdog_tools::policy::SessionSurface::from_header(resumed.as_object().expect("object"), Vec::new());
                let set = super::super::assemble::with_surface_registry(
                    mixdog_agent::tools::ToolSet::new(Vec::new()),
                    std::sync::Arc::new(Nothing),
                    None,
                    &surface_of,
                );
                assert!(set.unknown_message("web_search").contains("unavailable"), "{}", set.unknown_message("web_search"));
            }
        }
        // A surface built anew (a route or model change, a clear) leaves it out while it cannot run.
        let mut anew = session.clone();
        surface.apply(&mut anew, "lead", &[], &ApplyOptions::default());
        assert!(!sent(&anew).contains("web_search"));
    }

    /// A gate closing after creation stages a denial (`stage_tool_availability`) and leaves the stored `tools` as they are; the
    /// tool leaves the definitions at the next boundary (an apply) and comes back at a later one once the gate opens, on a native
    /// and on a bridge session.
    #[test]
    fn a_closed_gate_removes_a_definition_at_the_next_boundary_and_it_returns_at_a_later_one() {
        use super::super::tool_availability::stage_tool_availability;
        let schema = json!({ "type": "object", "properties": {} });
        let tool = |name: &str| json!({ "name": name, "description": format!("{name}."), "inputSchema": schema });
        let host = Host(vec![tool("load_tool"), tool("call_tool")]);
        let surface = ToolSurface { host: &host, clock: &Fixed };
        for provider in ["anthropic", "custom-11111111-1111-4111-8111-111111111111"] {
            let held: Vec<Value> = ["read", "grep", "web_search", "load_tool"].iter().map(|name| tool(name)).collect();
            let mut session = json!({ "provider": provider, "model": "smoke", "toolSpec": "full", "tools": held, "disallowedTools": [] });
            let names = |session: &Value| -> Vec<String> { tools_of(session).iter().map(tool_name).collect() };
            surface.apply(&mut session, "lead", &[], &ApplyOptions::default());
            assert!(names(&session).contains(&"web_search".to_owned()), "{provider}");
            // The gate closes mid-session: denied at dispatch, the definitions untouched.
            let sent = tools_of(&session).iter().map(Value::to_string).collect::<Vec<_>>().join("\n");
            let moved = stage_tool_availability(session.as_object_mut().expect("object"), &["web_search".to_owned()], &[], 1).expect("the gate closed");
            assert_eq!(moved.removed, ["web_search"], "{provider}");
            assert!(session["disallowedTools"].to_string().contains("web_search"));
            assert_eq!(tools_of(&session).iter().map(Value::to_string).collect::<Vec<_>>().join("\n"), sent, "{provider}: no edit of a live epoch");
            // The next boundary rebuilds the definitions without it.
            surface.apply(&mut session, "lead", &[], &ApplyOptions::default());
            assert!(!names(&session).contains(&"web_search".to_owned()), "{provider}: removed at the boundary");
            // The gate opens: the definition joins the late catalog, and a later boundary installs it again.
            let reopened = stage_tool_availability(session.as_object_mut().expect("object"), &[], &[tool("web_search")], 2).expect("the gate opened");
            assert_eq!(reopened.added, ["web_search"], "{provider}");
            surface.apply(&mut session, "lead", &[], &ApplyOptions::default());
            assert!(names(&session).contains(&"web_search".to_owned()), "{provider}: back at a later boundary");
        }
    }
}
