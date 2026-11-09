//! The `tools` domain service: `tools/toolsStatus`, the readout of a thread's tool surface
//! (every catalog tool with its kind, measured usage and whether it is active now), ported from
//! Node's `toolsStatus` in `session-runtime/turn/agent-ops.mjs` and `toolRow` /
//! `toolSearchMatches` in `tool-catalog.mjs`. What the surface *is* (the catalog, the eager
//! tools, the discovered ones, the mode) is the session's: [`ToolSurfaceStatus`] supplies it.

use std::collections::BTreeSet;
use std::sync::Arc;

use async_trait::async_trait;
use mixdog_core_api::ids::ConnectionId;
use mixdog_core_api::ids::Method;
use mixdog_core_api::service::Admit;
use mixdog_core_api::CoreError;
use mixdog_core_api::CoreRequest;
use mixdog_core_api::DomainService;
use mixdog_core_api::Reply;
use mixdog_protocol::ThreadId;
use serde_json::json;
use serde_json::Map;
use serde_json::Value;

/// Canonical route order: the single surface order wherever tools serialize.
const ROUTE_TOOL_ORDER: [&str; 13] = [
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
    "github",
    "shell",
    "task",
];

/// Measured call counts (`MEASURED_TOOL_USAGE`); orders the unrouted tail.
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

const DESCRIPTION_MAX: usize = 220;

/// One tool of the catalog, as far as the readout looks at it.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct StatusTool {
    pub name: String,
    pub description: String,
    /// `annotations.agentHidden` is truthy.
    pub agent_hidden: bool,
    /// `annotations.mixdogKind`.
    pub mixdog_kind: Option<String>,
}

/// A thread's tool surface at the moment of the call.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct StatusSurface {
    pub mode: String,
    /// The deferred catalog when the surface has one, else its eager tools.
    pub catalog: Vec<StatusTool>,
    /// Eager tool names and the deferred tools callable now.
    pub active: Vec<String>,
    /// Deferred tools the thread has discovered.
    pub discovered: Vec<String>,
    /// `getTools()` of the skills API: the names of the eager tools, the deferred catalog and the
    /// late deferred catalog, in that order, each once.
    pub listed: Vec<String>,
}

#[async_trait]
pub trait ToolSurfaceStatus: Send + Sync {
    /// The surface of `thread` (or of the current thread when none is named). An empty thread
    /// is first brought to the settings, so the list is what its first turn sends.
    async fn surface(&self, thread: Option<&ThreadId>) -> Result<StatusSurface, CoreError>;

    /// The provider request `thread`'s next send would carry (`tools/toolsStatus` with `snapshot`): the
    /// surface's tool documents, the request's system texts and tools, and the body its route's codec
    /// encodes. A surface that cannot build requests refuses.
    async fn request_snapshot(&self, _thread: &ThreadId) -> Result<Value, CoreError> {
        Err(invalid("snapshot", "a surface that builds the thread's provider request"))
    }
}

pub struct ToolsService {
    surfaces: Arc<dyn ToolSurfaceStatus>,
}

impl ToolsService {
    pub fn new(surfaces: Arc<dyn ToolSurfaceStatus>) -> Self {
        Self { surfaces }
    }
}

#[async_trait]
impl DomainService for ToolsService {
    async fn call(&self, req: CoreRequest) -> Result<Reply, CoreError> {
        match req.method.as_str() {
            "tools/toolsStatus" => {
                let (thread, query, snapshot) = parse_params(&req.params)?;
                let surface = self.surfaces.surface(thread.as_ref()).await?;
                let mut status = tools_status(&surface, &query);
                if snapshot {
                    // After `surface`, which brings an empty thread to the settings its first send uses.
                    let thread = thread.ok_or_else(|| invalid("threadId", "a thread for a snapshot"))?;
                    status["requestSnapshot"] = self.surfaces.request_snapshot(&thread).await?;
                }
                Ok(Reply::Value(status))
            }
            _ => Err(invalid("method", "tools/*")),
        }
    }

    fn methods(&self) -> &'static [&'static str] {
        &["tools/toolsStatus"]
    }

    fn notify(&self, _method: Method, _params: Value, _from: ConnectionId) -> Admit {
        Admit::Accepted
    }
}

fn invalid(path: &str, expected: &str) -> CoreError {
    CoreError::InvalidParams { path: path.into(), expected: expected.into() }
}

fn parse_params(params: &Value) -> Result<(Option<ThreadId>, String, bool), CoreError> {
    let optional_string = |key: &str| match params.get(key) {
        None | Some(Value::Null) => Ok(None),
        Some(Value::String(s)) => Ok(Some(s.clone())),
        Some(_) => Err(invalid(key, "string")),
    };
    let snapshot = match params.get("snapshot") {
        None | Some(Value::Null) => false,
        Some(Value::Bool(flag)) => *flag,
        Some(_) => return Err(invalid("snapshot", "boolean")),
    };
    let thread = optional_string("threadId")?.map(ThreadId::from);
    Ok((thread, optional_string("query")?.unwrap_or_default(), snapshot))
}

fn clean(value: &str) -> &str {
    mixdog_js::js_trim(value)
}

fn tool_kind(tool: &StatusTool) -> &'static str {
    let name = clean(&tool.name);
    if name.starts_with("mcp__") {
        "mcp"
    } else if name.starts_with("skill:")
        || tool.mixdog_kind.as_deref() == Some("skill")
        || name == "Skill"
        || name.starts_with("skill_")
        || name == "skills_list"
        || name == "skill_view"
    {
        "skill"
    } else if tool.agent_hidden {
        "control"
    } else if ["edit", "apply_patch", "shell"].contains(&name) {
        "mutation"
    } else {
        "tool"
    }
}

fn measured_usage(name: &str) -> u64 {
    let name = clean(name);
    MEASURED_TOOL_USAGE.iter().find(|(n, _)| *n == name).map_or(0, |(_, u)| *u)
}

fn route_rank(name: &str) -> usize {
    let name = clean(name);
    ROUTE_TOOL_ORDER.iter().position(|n| *n == name).unwrap_or(usize::MAX)
}

/// `compactToolSearchDescription`: whitespace runs folded, cut to 220 UTF-16 units with `…`.
fn compact_description(value: &str) -> String {
    let text = mixdog_js::js_words(value).collect::<Vec<_>>().join(" ");
    if mixdog_js::utf16_len(&text) > DESCRIPTION_MAX {
        format!("{}…", mixdog_js::slice_utf16(&text, DESCRIPTION_MAX - 1))
    } else {
        text
    }
}

use mixdog_js::locale_compare;

/// `sortedNamesByMeasuredUsage`.
fn sorted_names<'a>(names: impl IntoIterator<Item = &'a String>) -> Vec<String> {
    let mut sorted: Vec<&String> = names.into_iter().collect();
    sorted.sort_by(|a, b| {
        route_rank(a)
            .cmp(&route_rank(b))
            .then_with(|| measured_usage(b).cmp(&measured_usage(a)))
            .then_with(|| locale_compare(a, b))
    });
    sorted.into_iter().cloned().collect()
}

/// The reply of `tools/toolsStatus` for `surface` filtered by `query`.
pub fn tools_status(surface: &StatusSurface, query: &str) -> Value {
    let active: BTreeSet<&String> = surface.active.iter().filter(|n| !n.is_empty()).collect();
    let rows: Vec<(Map<String, Value>, String)> = surface
        .catalog
        .iter()
        .filter_map(|tool| {
            let name = clean(&tool.name);
            if name.is_empty() {
                return None;
            }
            let description = compact_description(&tool.description);
            let row = json!({
                "name": name,
                "kind": tool_kind(tool),
                "usage": measured_usage(name),
                "active": active.contains(&name.to_owned()),
                "description": description,
            });
            let Value::Object(row) = row else { unreachable!("object literal") };
            Some((row, format!("{name} {description}").to_lowercase()))
        })
        .collect();
    let kind = |row: &Map<String, Value>| row["kind"].as_str().unwrap_or_default().to_owned();
    let regular = rows.iter().filter(|(r, _)| !["mcp", "skill"].contains(&kind(r).as_str()));
    let count = regular.clone().count();
    let active_count = regular.filter(|(r, _)| r["active"] == Value::Bool(true)).count();
    let mcp = rows.iter().filter(|(r, _)| kind(r) == "mcp");
    let mcp_count = mcp.clone().count();
    let active_mcp = mcp.filter(|(r, _)| r["active"] == Value::Bool(true)).count();
    let needle = clean(query).to_lowercase();
    let tools: Vec<Value> = rows
        .into_iter()
        .filter(|(_, haystack)| needle.is_empty() || haystack.contains(&needle))
        .map(|(row, _)| Value::Object(row))
        .collect();
    json!({
        "mode": surface.mode,
        "count": count,
        "activeCount": active_count,
        "mcpToolCount": mcp_count,
        "activeMcpToolCount": active_mcp,
        "tools": tools,
        "activeTools": sorted_names(active.iter().copied()),
        "discoveredTools": sorted_names(&surface.discovered),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    struct Fixed(StatusSurface);

    #[async_trait]
    impl ToolSurfaceStatus for Fixed {
        async fn surface(&self, _: Option<&ThreadId>) -> Result<StatusSurface, CoreError> {
            Ok(self.0.clone())
        }
    }

    fn string_list(v: &Value) -> Vec<String> {
        v.as_array().map(|a| a.iter().filter_map(Value::as_str).map(str::to_owned).collect()).unwrap_or_default()
    }

    fn tool(doc: &Value) -> StatusTool {
        StatusTool {
            name: doc["name"].as_str().unwrap_or_default().to_owned(),
            description: doc["description"].as_str().unwrap_or_default().to_owned(),
            agent_hidden: doc["annotations"]["agentHidden"].as_bool().unwrap_or(false),
            mixdog_kind: doc["annotations"]["mixdogKind"].as_str().map(str::to_owned),
        }
    }

    /// Node's own `surface` object (as `activeToolSurface()` returns it) as a [`StatusSurface`].
    fn surface_of(mode: &str, node: &Value) -> StatusSurface {
        let tools = node["tools"].as_array().cloned().unwrap_or_default();
        let catalog = node["deferredToolCatalog"].as_array().cloned().unwrap_or(tools.clone());
        let mut active: Vec<String> = tools.iter().map(|t| t["name"].as_str().unwrap_or_default().to_owned()).collect();
        active.extend(string_list(&node["deferredCallableTools"]));
        StatusSurface {
            mode: mode.into(),
            catalog: catalog.iter().map(tool).collect(),
            active,
            discovered: string_list(&node["deferredDiscoveredTools"]),
            listed: Vec::new(),
        }
    }

    #[test]
    fn status_equals_the_recorded_node_readout() {
        let golden: Vec<Value> = serde_json::from_str(include_str!("golden/tools_status.json")).expect("golden");
        assert!(golden.len() >= 7);
        for case in golden {
            let surface = surface_of(case["mode"].as_str().unwrap(), &case["surface"]);
            let got = tools_status(&surface, case["query"].as_str().unwrap());
            assert_eq!(got.to_string(), case["result"].to_string(), "case {}", case["label"]);
        }
    }

    #[tokio::test]
    async fn the_method_replies_with_the_readout_and_refuses_other_methods() {
        use mixdog_core_api::call::CallContext;
        let surface = StatusSurface { mode: "lead".into(), catalog: vec![StatusTool { name: "read".into(), description: "Read".into(), ..StatusTool::default() }], active: vec!["read".into()], discovered: vec![], listed: vec![] };
        let service = ToolsService::new(Arc::new(Fixed(surface.clone())));
        let request = |method: &'static str, params: Value| CoreRequest { method: Method(method), params, op: None, ctx: CallContext::internal("test") };
        let Ok(Reply::Value(value)) = service.call(request("tools/toolsStatus", json!({"threadId": "t1", "query": "REA"}))).await else { panic!("reply") };
        assert_eq!(value, tools_status(&surface, "REA"));
        assert_eq!(value["activeCount"], 1);
        assert!(service.call(request("tools/other", json!({}))).await.is_err());
        assert!(service.call(request("tools/toolsStatus", json!({"query": 3}))).await.is_err());
    }

    /// A surface that builds the thread's provider request.
    struct Requests(StatusSurface);

    #[async_trait]
    impl ToolSurfaceStatus for Requests {
        async fn surface(&self, _: Option<&ThreadId>) -> Result<StatusSurface, CoreError> {
            Ok(self.0.clone())
        }
        async fn request_snapshot(&self, thread: &ThreadId) -> Result<Value, CoreError> {
            Ok(json!({ "thread": thread.as_str() }))
        }
    }

    #[tokio::test]
    async fn a_snapshot_call_adds_the_threads_provider_request_to_the_readout() {
        use mixdog_core_api::call::CallContext;
        let surface = StatusSurface { mode: "lead".into(), catalog: vec![StatusTool { name: "read".into(), description: "Read".into(), ..StatusTool::default() }], active: vec!["read".into()], discovered: vec![], listed: vec![] };
        let request = |params: Value| CoreRequest { method: Method("tools/toolsStatus"), params, op: None, ctx: CallContext::internal("test") };
        let service = ToolsService::new(Arc::new(Requests(surface.clone())));
        let Ok(Reply::Value(value)) = service.call(request(json!({"threadId": "t1", "snapshot": true}))).await else { panic!("reply") };
        let mut want = tools_status(&surface, "");
        want["requestSnapshot"] = json!({ "thread": "t1" });
        assert_eq!(value, want);
        let Ok(Reply::Value(plain)) = service.call(request(json!({"threadId": "t1", "snapshot": false}))).await else { panic!("reply") };
        assert_eq!(plain, tools_status(&surface, ""), "without the flag the readout is Node's alone");
        assert!(service.call(request(json!({"snapshot": true}))).await.is_err(), "a request is a thread's");
        assert!(service.call(request(json!({"threadId": "t1", "snapshot": "yes"}))).await.is_err());
        let plain_surface = ToolsService::new(Arc::new(Fixed(surface)));
        assert!(plain_surface.call(request(json!({"threadId": "t1", "snapshot": true}))).await.is_err(), "a surface without requests refuses");
    }
}
