//! What a session may call at all: the refusals that come before any hook or
//! approval (the schema allowlist, the session's denied tools, a setting that
//! switched a tool off, a connector the agent or project does not mount, a
//! read-only session, and the Lead-only control tools of an agent worker).
//! The lists are today's, exactly.

use std::sync::LazyLock;

use serde_json::Map;
use serde_json::Value;

use crate::exec::scan::JsRegex;
use crate::exec::scan::cs;
use mixdog_core_api::domain::tool::ToolAnnotations;
use mixdog_core_api::domain::tool::ToolError;
use mixdog_core_api::domain::tool::ToolErrorCode;

/// Tools a read-only session may call by name, whatever their annotations.
pub const READONLY_TOOL_NAMES: [&str; 10] = [
    "read",
    "list",
    "grep",
    "find",
    "glob",
    "code_graph",
    "web_search",
    "web_fetch",
    "recall",
    "Skill",
];

/// The `tools:readonly` schema bundle (the file-system tools that only read).
pub const READONLY_FS_TOOL_NAMES: [&str; 6] = ["code_graph", "find", "glob", "list", "grep", "read"];

/// Lead-only control tools: refused to agent workers and sub-agents. This is
/// not the `agentHidden` annotation (which marks more tools and leaves
/// `agent` visible); the refusal is exactly these four.
pub const AGENT_DENIED_TOOLS: [&str; 4] = ["agent", "ask_user", "handoff_user", "session"];

/// Skill-list plumbing that runs in any read-only session.
const INACTIVE_INFRA: [&str; 2] = ["skills_list", "skill_view"];

/// The discovery tool the call bridge never strands behind an allowlist.
const BRIDGE_DISCOVERY_TOOLS: [&str; 1] = ["load_tool"];

/// Whether a tool is offered to a read-only session: it is named in
/// [`READONLY_TOOL_NAMES`], or declares itself read-only and not destructive.
pub fn readonly_selectable(name: &str, annotations: &ToolAnnotations) -> bool {
    READONLY_TOOL_NAMES.contains(&name)
        || (annotations.destructive_hint != Some(true) && annotations.read_only_hint == Some(true))
}

const BRIDGE_CALL_TOOL: &str = "call_tool";
const BRIDGE_EXPOSURE: &str = "bridge-v1";

/// `resolveDeferredSelectMode(session) === 'readonly'`: the `readonly` spec, or a list naming
/// `tools:readonly` without `full`.
fn readonly_tool_spec(spec: Option<&Value>) -> bool {
    match spec {
        Some(Value::String(spec)) => spec == "readonly",
        Some(Value::Array(items)) => {
            let has = |tag: &str| items.iter().any(|item| item.as_str() == Some(tag));
            !has("full") && has("tools:readonly")
        }
        _ => false,
    }
}

/// `resolveDeferredSelectMode(session) !== null`: the session's `toolSpec` names a tool mode.
fn tool_mode_resolved(spec: Option<&Value>) -> bool {
    match spec {
        Some(Value::String(spec)) => matches!(spec.as_str(), "readonly" | "full" | "mcp"),
        Some(Value::Array(items)) => !items.is_empty(),
        _ => false,
    }
}

/// The session's tool policy as the session actor holds it.
#[derive(Clone, PartialEq, Eq, Debug, Default)]
pub struct SessionSurface {
    /// The session's `toolSpec` names a tool mode (`resolveDeferredSelectMode` is not null).
    pub mode_resolved: bool,
    /// The last MCP snapshot of the connected tools (`deferredMcpToolNames`); none before the first.
    pub mcp_names: Option<Vec<String>>,
    /// The persisted schema allowlist (also the execution allowlist).
    pub schema_allowed: Option<Vec<String>>,
    /// Tools the session denies.
    pub disallowed: Vec<String>,
    /// Tools a settings gate denies to the session.
    pub feature_denied: Vec<String>,
    /// The agent's connector policy sets the tool to `disabled`.
    pub connector_disabled: bool,
    /// The project switched the connector tool off.
    pub project_disabled: bool,
    /// A read-only session.
    pub readonly: bool,
    /// The session's persisted deferred surface is read-only (`deferredSurfaceMode`), whatever its tool mode: the deferred-call guard
    /// counts it with `readonly` (`isBridgeReadonlySession`, `tool-bridge.mjs:187`).
    pub deferred_readonly: bool,
    /// Names of the session's active tools.
    pub active_tools: Vec<String>,
    /// Names in the deferred catalog.
    pub catalog_tools: Vec<String>,
    /// The call bridge is on (its discovery tool is never allowlisted away).
    pub bridge: bool,
    /// An agent worker or sub-agent session.
    pub agent_owned: bool,
    /// Tools the provider's route left out of this session's requests, with
    /// the model text of why (the run owns this state; it is not persisted).
    pub route_excluded: Vec<(String, String)>,
    /// The workflow this conversation switched to, and the tools it refuses.
    pub workflow_name: String,
    pub workflow_denied: Vec<String>,
    /// The MCP scope the session's servers are registered under (`session.mcpScopeId`): what an MCP tool
    /// name, a connector card and a nested call resolve against, as Node reads `sessionRef.mcpScopeId`
    /// (`tool-exec/dispatch.mjs:57-59`). None: the session holds no scope, so no MCP server resolves.
    pub mcp_scope: Option<String>,
}

const COMPACTED_PATCH_REFUSAL: &str = "Error: [tool-input-validation] apply_patch received a compacted-history placeholder, not executable patch content. Re-read the current target files and submit a fresh full patch; do not replay or reconstruct the stored marker.";

/// `apply_patch` input that carries a `[mixdog compacted …]` marker line
/// outside the patch's own `+`, `-` and context lines.
fn has_compacted_patch_placeholder(name: &str, args: &Value) -> bool {
    static MARKER: LazyLock<JsRegex> =
        LazyLock::new(|| cs(r"^\s*\[mixdog compacted\b[^\]\n]*\]"));
    if name != "apply_patch" {
        return false;
    }
    let text = match args {
        Value::String(text) => Some(text.as_str()),
        other => other.get("patch").and_then(Value::as_str),
    };
    text.is_some_and(|text| {
        text.split('\n').any(|line| {
            let line = line.strip_suffix('\r').unwrap_or(line);
            !line.starts_with(['+', '-', ' ']) && MARKER.is_match(line)
        })
    })
}

fn listed(list: &[String], name: &str) -> bool {
    list.iter().any(|item| item.eq_ignore_ascii_case(name))
}

fn refused(rule: &str, text: String) -> ToolError {
    ToolError::new(ToolErrorCode::DeniedByPolicy { rule: rule.into() }, text)
}

impl SessionSurface {
    /// The refusal for a call to `name` (`schema_name` is the name it has in
    /// the schema when routing renamed it), or `None` when the session may
    /// call it.
    pub fn refusal(&self, name: &str, schema_name: Option<&str>) -> Option<ToolError> {
        self.refusal_for_call(name, schema_name, &Value::Null)
    }

    /// [`Self::refusal`] for a call with its arguments (the compacted-patch
    /// check reads them). The order is Node's `preDispatchDenyForSession`.
    pub fn refusal_for_call(&self, name: &str, schema_name: Option<&str>, args: &Value) -> Option<ToolError> {
        let schema = schema_name.unwrap_or(name);
        if self.bridge && name == BRIDGE_CALL_TOOL {
            return Some(refused(
                "bridge-recursion",
                "Error: BRIDGE_RECURSION: call_tool runs one tool named in its arguments and cannot be dispatched itself."
                    .into(),
            ));
        }
        if let Some((_, reason)) = self.route_excluded.iter().find(|(tool, _)| tool == schema) {
            return Some(refused("route-excluded", format!("Error: {reason}")));
        }
        let bridge_discovery = self.bridge && BRIDGE_DISCOVERY_TOOLS.contains(&schema);
        if !bridge_discovery
            && self
                .schema_allowed
                .as_ref()
                .is_some_and(|allowed| !listed(allowed, schema))
        {
            return Some(refused(
                "schema-allowlist",
                format!("Error: tool \"{name}\" is not available on this session's schema allowlist."),
            ));
        }
        if listed(&self.workflow_denied, schema) {
            return Some(refused(
                "workflow-denied",
                format!(
                    "Error: tool \"{schema}\" is not available in workflow {}: this conversation switched to it. Do the work without it.",
                    self.workflow_name
                ),
            ));
        }
        if listed(&self.disallowed, schema) {
            return Some(if listed(&self.feature_denied, schema) {
                refused(
                    "disabled-in-settings",
                    format!(
                        "Error: tool \"{schema}\" is disabled in settings by the user. Do not retry unless the user turns it back on."
                    ),
                )
            } else {
                refused(
                    "not-in-session",
                    format!("Error: tool \"{name}\" is not available in this session."),
                )
            });
        }
        if self.connector_disabled {
            return Some(refused(
                "connector-disabled",
                format!("Error: tool \"{name}\" is not available to this agent."),
            ));
        }
        if self.project_disabled {
            return Some(refused(
                "project-disabled",
                format!("Error: tool \"{name}\" is switched off in this project."),
            ));
        }
        if self.off_readonly_surface(schema) {
            return Some(refused(
                "readonly-session",
                format!("Error: tool \"{name}\" is not available in this read-only session."),
            ));
        }
        if has_compacted_patch_placeholder(name, args) {
            return Some(refused("compacted-patch", COMPACTED_PATCH_REFUSAL.into()));
        }
        if self.agent_owned && AGENT_DENIED_TOOLS.contains(&name) {
            return Some(refused(
                "lead-only",
                format!(
                    "Error: control-plane tool \"{name}\" is Lead-only and not available to agent workers."
                ),
            ));
        }
        None
    }

    /// The session's surface from its persisted header (`schemaAllowedTools`,
    /// `disallowedTools`, `featureDeniedTools`, `toolSpec`, `scope`, `owner`,
    /// `tools`, the deferred catalogs, `toolExposureMode`, `workflowOverlay`),
    /// with the run's route exclusions. `connector_disabled` and
    /// `project_disabled` depend on the called tool and are set per call.
    pub fn from_header(header: &Map<String, Value>, route_excluded: Vec<(String, String)>) -> Self {
        let names = |key: &str| -> Option<Vec<String>> {
            header
                .get(key)
                .and_then(Value::as_array)
                .map(|items| items.iter().filter_map(Value::as_str).map(str::to_owned).collect())
        };
        let tool_names = |key: &str| -> Vec<String> {
            header
                .get(key)
                .and_then(Value::as_array)
                .map(|tools| {
                    tools
                        .iter()
                        .filter_map(|tool| tool.get("name").and_then(Value::as_str))
                        .map(|name| mixdog_js::js_trim(name).to_owned())
                        .collect()
                })
                .unwrap_or_default()
        };
        let disallowed = names("disallowedTools").unwrap_or_default();
        // `deferredCatalogUnion`: the boot and late catalogs, minus denied tools.
        let catalog_tools = ["deferredToolCatalog", "deferredLateToolCatalog"]
            .into_iter()
            .flat_map(tool_names)
            .filter(|name| !listed(&disallowed, name))
            .collect();
        let text = |key: &str| header.get(key).and_then(Value::as_str).unwrap_or("");
        let overlay = header.get("workflowOverlay");
        Self {
            mode_resolved: tool_mode_resolved(header.get("toolSpec")),
            mcp_names: names("deferredMcpToolNames"),
            schema_allowed: names("schemaAllowedTools"),
            disallowed,
            feature_denied: names("featureDeniedTools").unwrap_or_default(),
            readonly: readonly_tool_spec(header.get("toolSpec")),
            deferred_readonly: text("deferredSurfaceMode") == "readonly",
            active_tools: tool_names("tools"),
            catalog_tools,
            bridge: text("toolExposureMode") == BRIDGE_EXPOSURE,
            agent_owned: text("scope").starts_with("agent:")
                || mixdog_js::js_trim(&text("owner")).to_lowercase() == "agent",
            workflow_name: overlay
                .and_then(|o| o.pointer("/workflow/name"))
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_owned(),
            workflow_denied: overlay
                .and_then(|o| o.get("deniedTools"))
                .and_then(Value::as_array)
                .map(|items| items.iter().filter_map(Value::as_str).map(str::to_owned).collect())
                .unwrap_or_default(),
            route_excluded,
            connector_disabled: false,
            project_disabled: false,
            mcp_scope: Some(mixdog_js::js_trim(&text("mcpScopeId")).to_owned()).filter(|scope| !scope.is_empty()),
        }
    }

    /// `prepareDeferredToolCallThrough`, which runs after the hooks and the approval and before the
    /// tool: on any session, a connector tool outside the last MCP snapshot (taken for the session's
    /// cwd as it is now) is unavailable; on a bridge session, a deferred catalog tool that is not
    /// read-only selectable never runs without a tool mode or in a read-only one. `annotations` are the
    /// called tool's own.
    pub fn deferred_call_refusal(&self, name: &str, annotations: &ToolAnnotations) -> Option<String> {
        if name.starts_with("mcp__") && self.mcp_names.as_ref().is_some_and(|names| !names.iter().any(|known| known == name)) {
            return Some(format!("Error: MCP tool \"{name}\" is unavailable in the current session catalog; no call was sent."));
        }
        if !self.bridge {
            return None;
        }
        if !listed(&self.catalog_tools, name) || listed(&self.active_tools, name) || INACTIVE_INFRA.contains(&name) {
            return None;
        }
        if readonly_selectable(name, annotations) {
            return None;
        }
        if !self.mode_resolved {
            return Some(format!("Error: tool \"{name}\" is deferred and cannot be auto-loaded without a resolved tool mode; no call was sent."));
        }
        (self.readonly || self.deferred_readonly).then(|| format!("Error: tool \"{name}\" is not available in readonly mode"))
    }

    /// A read-only session runs only what its surfaces offer: active tools,
    /// catalog tools (whose read-only gate is [`readonly_selectable`]) and
    /// skill-list plumbing.
    fn off_readonly_surface(&self, name: &str) -> bool {
        self.readonly
            && !name.is_empty()
            && !INACTIVE_INFRA.contains(&name)
            && !listed(&self.active_tools, name)
            && !listed(&self.catalog_tools, name)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn names(items: &[&str]) -> Vec<String> {
        items.iter().map(|s| (*s).to_owned()).collect()
    }

    fn text(error: Option<ToolError>) -> String {
        error.expect("refused").message_for_model
    }

    #[test]
    fn an_open_session_refuses_nothing() {
        assert!(SessionSurface::default().refusal("shell", None).is_none());
    }

    #[test]
    fn the_allowlist_is_case_blind_and_never_strands_the_bridge_discovery_tool() {
        let surface = SessionSurface {
            schema_allowed: Some(names(&["Read"])),
            ..SessionSurface::default()
        };
        assert!(surface.refusal("read", None).is_none());
        assert_eq!(
            text(surface.refusal("shell", None)),
            "Error: tool \"shell\" is not available on this session's schema allowlist."
        );
        assert!(surface.refusal("load_tool", None).is_some());
        let bridged = SessionSurface { bridge: true, ..surface };
        assert!(bridged.refusal("load_tool", None).is_none());
    }

    #[test]
    fn a_renamed_call_is_judged_by_its_schema_name() {
        let surface = SessionSurface {
            schema_allowed: Some(names(&["web_fetch"])),
            ..SessionSurface::default()
        };
        assert!(surface.refusal("local_fetch", Some("web_fetch")).is_none());
    }

    #[test]
    fn a_denied_tool_says_whether_settings_switched_it_off() {
        let surface = SessionSurface {
            disallowed: names(&["goal", "react"]),
            feature_denied: names(&["goal"]),
            ..SessionSurface::default()
        };
        assert_eq!(
            text(surface.refusal("goal", None)),
            "Error: tool \"goal\" is disabled in settings by the user. Do not retry unless the user turns it back on."
        );
        assert_eq!(
            text(surface.refusal("react", None)),
            "Error: tool \"react\" is not available in this session."
        );
    }

    #[test]
    fn connectors_the_agent_or_project_turned_off_are_refused() {
        let agent = SessionSurface { connector_disabled: true, ..SessionSurface::default() };
        assert_eq!(
            text(agent.refusal("mcp__a__b", None)),
            "Error: tool \"mcp__a__b\" is not available to this agent."
        );
        let project = SessionSurface { project_disabled: true, ..SessionSurface::default() };
        assert_eq!(
            text(project.refusal("mcp__a__b", None)),
            "Error: tool \"mcp__a__b\" is switched off in this project."
        );
    }

    #[test]
    fn a_readonly_session_runs_active_and_catalog_tools_and_skill_plumbing_only() {
        let surface = SessionSurface {
            readonly: true,
            active_tools: names(&["read"]),
            catalog_tools: names(&["Web_Search"]),
            ..SessionSurface::default()
        };
        for ok in ["read", "READ", "web_search", "skills_list", "skill_view"] {
            assert!(surface.refusal(ok, None).is_none(), "{ok}");
        }
        assert_eq!(
            text(surface.refusal("apply_patch", None)),
            "Error: tool \"apply_patch\" is not available in this read-only session."
        );
    }

    #[test]
    fn agent_workers_lose_exactly_the_four_control_tools() {
        let surface = SessionSurface { agent_owned: true, ..SessionSurface::default() };
        for name in AGENT_DENIED_TOOLS {
            assert_eq!(
                text(surface.refusal(name, None)),
                format!("Error: control-plane tool \"{name}\" is Lead-only and not available to agent workers.")
            );
        }
        // Hidden by annotation but not refused: load_tool, goal, react, setup, call_tool.
        for name in ["load_tool", "goal", "react", "setup", "call_tool", "todo"] {
            assert!(surface.refusal(name, None).is_none(), "{name}");
        }
        assert!(SessionSurface::default().refusal("agent", None).is_none());
    }

    fn header(value: Value) -> Map<String, Value> {
        value.as_object().expect("object").clone()
    }

    #[test]
    fn the_surface_is_built_from_the_persisted_header() {
        let surface = SessionSurface::from_header(
            &header(serde_json::json!({
                "schemaAllowedTools": ["read", "grep"],
                "disallowedTools": ["goal"],
                "featureDeniedTools": ["goal"],
                "toolSpec": ["tools:readonly"],
                "scope": "agent:worker",
                "tools": [{"name": "read"}, {"name": " grep "}],
                "deferredToolCatalog": [{"name": "web_search"}, {"name": "goal"}],
                "deferredLateToolCatalog": [{"name": "recall"}],
                "toolExposureMode": "bridge-v1",
                "workflowOverlay": {"deniedTools": ["shell"], "workflow": {"name": "plan"}},
            })),
            vec![("grep".into(), "tool \"grep\" is unavailable with the current model".into())],
        );
        assert_eq!(surface.schema_allowed, Some(names(&["read", "grep"])));
        assert!(surface.readonly && surface.bridge && surface.agent_owned);
        assert_eq!(surface.active_tools, names(&["read", "grep"]));
        assert_eq!(surface.catalog_tools, names(&["web_search", "recall"]));
        assert_eq!(surface.workflow_name, "plan");
        // Node's order: the route exclusion answers before the allowlist and the rest.
        assert_eq!(
            text(surface.refusal("grep", None)),
            "Error: tool \"grep\" is unavailable with the current model"
        );
        assert_eq!(
            text(SessionSurface { schema_allowed: None, route_excluded: vec![], ..surface.clone() }.refusal("shell", None)),
            "Error: tool \"shell\" is not available in workflow plan: this conversation switched to it. Do the work without it."
        );
        assert!(
            SessionSurface::from_header(&header(serde_json::json!({"toolSpec": ["full", "tools:readonly"]})), vec![])
                .readonly
                == false
        );
        // deferredSurfaceMode: readonly under a full tool mode: the deferred-call guard refuses what is not read-only selectable.
        let persisted = SessionSurface::from_header(
            &header(serde_json::json!({"toolSpec": "full", "deferredSurfaceMode": "readonly", "toolExposureMode": "bridge-v1", "deferredToolCatalog": [{"name": "odd"}]})),
            vec![],
        );
        assert!(!persisted.readonly && persisted.deferred_readonly);
        assert_eq!(persisted.deferred_call_refusal("odd", &ToolAnnotations::default()).as_deref(), Some("Error: tool \"odd\" is not available in readonly mode"));
        // call_tool is never dispatched itself on a bridge session.
        assert_eq!(
            text(surface.refusal("call_tool", None)),
            "Error: BRIDGE_RECURSION: call_tool runs one tool named in its arguments and cannot be dispatched itself."
        );
    }

    #[test]
    fn a_compacted_history_placeholder_is_not_an_executable_patch() {
        let surface = SessionSurface::default();
        let marker = "*** Begin Patch\n[mixdog compacted 12 lines]\n*** End Patch";
        let refused = surface.refusal_for_call("apply_patch", None, &serde_json::json!({ "patch": marker }));
        assert!(text(refused).starts_with("Error: [tool-input-validation] apply_patch received a compacted-history placeholder"));
        // A marker inside a `+` line is patch content, and other tools are not checked.
        let content = "*** Begin Patch\n+[mixdog compacted 12 lines]\n*** End Patch";
        assert!(surface.refusal_for_call("apply_patch", None, &serde_json::json!({ "patch": content })).is_none());
        assert!(surface.refusal_for_call("edit", None, &serde_json::json!({ "patch": marker })).is_none());
        // Windows line endings and a string argument are read the same way.
        assert!(surface.refusal_for_call("apply_patch", None, &Value::String("x\r\n[mixdog compacted]\r\n".into())).is_some());
    }

    #[test]
    fn readonly_selection_follows_the_name_list_then_the_annotations() {
        let read_only = ToolAnnotations { read_only_hint: Some(true), ..ToolAnnotations::default() };
        let destructive = ToolAnnotations {
            read_only_hint: Some(true),
            destructive_hint: Some(true),
            ..ToolAnnotations::default()
        };
        assert!(readonly_selectable("ask_user", &read_only));
        assert!(!readonly_selectable("odd", &destructive));
        assert!(!readonly_selectable("shell", &ToolAnnotations::default()));
        assert!(readonly_selectable("recall", &ToolAnnotations::default()));
        assert!(readonly_selectable("Skill", &destructive));
    }
}
