//! A session's executable tool set (the `tools` seam of [`super::assemble::SessionSeams`]): the
//! built-ins its tool spec names plus the connected MCP servers' tools, in the order Node sends
//! them (`session/manager/tool-resolution.mjs`: `resolveSessionTools`, `finalizeSessionToolList`).
//!
//! Node's pool is three parts. The built-in tools are the filesystem, shell, git and github tools
//! with `apply_patch` and `code_graph`; every other registered tool is an internal tool, merged
//! with the MCP tools and sorted by name; `todo` is appended last, and `call_tool` belongs to the
//! bridge exposure rather than to the resolved set.

use std::path::{Path, PathBuf};
use std::sync::Arc;

use async_trait::async_trait;
use mixdog_core_api::domain::approval::ActionKind;
use mixdog_core_api::domain::tool::{Freeform, Tool, ToolContext, ToolOutcome, ToolSpec};
use mixdog_js::{js_trim, JsRegex};
use mixdog_mcp::scopes::{ExtensionScopes, ScopeKind};
use mixdog_mcp::McpHub;
use mixdog_store::schema::record::Header;
use mixdog_tools::policy::surface::{AGENT_DENIED_TOOLS, READONLY_FS_TOOL_NAMES};
use mixdog_tools::policy::SessionSurface;
use serde_json::{json, Map, Value};

use super::assemble::SessionTools;
use super::agent_variants::{check_pool, VariantError};
use super::tool_surface::{bind_edit_dialect, filter_model_edit_tool_names, ROUTE_TOOL_ORDER};

type Tools = Vec<Arc<dyn Tool>>;

/// `BUILTIN_TOOLS` in definition order.
const BUILTIN: [&str; 10] = ["read", "edit", "shell", "git", "github", "task", "grep", "glob", "find", "list"];
const PATCH: &str = "apply_patch";
const CODE_GRAPH: &str = "code_graph";
/// `FILESYSTEM_TOOL_NAMES`.
const FILESYSTEM: [&str; 8] = ["code_graph", "find", "glob", "list", "grep", "read", "edit", "apply_patch"];
const TODO: &str = "todo";
const SKILL: &str = "Skill";
/// The bridge exposure's own tools: appended to a bridge surface whatever the policy lets through.
pub(super) const BRIDGE: [&str; 2] = ["load_tool", "call_tool"];
/// Rank of a tool the route order does not name.
const UNRANKED: usize = 10_000;

fn name(tool: &Arc<dyn Tool>) -> &str {
    &tool.spec().name
}

/// `SESSION_ROUTE_TOOL_RANK`: the route order, then the web tools.
pub(super) fn route_rank(name: &str) -> usize {
    ROUTE_TOOL_ORDER.iter().chain(&["web_search", "web_fetch"]).position(|n| *n == name).unwrap_or(UNRANKED)
}

fn rank(tool: &Arc<dyn Tool>) -> usize {
    route_rank(name(tool))
}

/// `orderSessionTools`: stable by route rank.
fn ordered(mut tools: Tools) -> Tools {
    tools.sort_by_key(rank);
    tools
}

/// `_dedupByName`: the first of each name; nameless tools are dropped.
fn dedup(tools: impl IntoIterator<Item = Arc<dyn Tool>>) -> Tools {
    let mut seen = std::collections::HashSet::new();
    tools.into_iter().filter(|t| !name(t).is_empty() && seen.insert(name(t).to_owned())).collect()
}

fn named(pool: &[Arc<dyn Tool>], names: &[&str]) -> Tools {
    names.iter().filter_map(|n| pool.iter().find(|t| name(t) == *n).cloned()).collect()
}

fn is_builtin(name: &str) -> bool {
    BUILTIN.contains(&name) || name == PATCH || name == CODE_GRAPH
}

/// What a session's tool set is resolved from (`resolveSessionTools` and `finalizeSessionToolList`
/// inputs).
pub struct Resolve<'a> {
    /// The header's `toolSpec` (`full` when absent or unknown).
    pub tool_spec: Option<&'a Value>,
    /// The session's model: it decides whether `edit` or `apply_patch` is offered.
    pub model: &'a str,
    /// Skills are listed for the session's folder (a non-agent session carries `Skill` only then).
    pub skills_listed: bool,
    pub agent_owned: bool,
    pub schema_allowed: Option<&'a [String]>,
    pub disallowed: &'a [String],
}

/// The read-only filesystem tools in route order (`readOnlyFilesystemTools`): the explorer's list
/// and the `readonly` spec's built-ins.
pub fn readonly_filesystem_tools(pool: &[Arc<dyn Tool>]) -> Tools {
    all_builtin(pool).into_iter().filter(|t| READONLY_FS_TOOL_NAMES.contains(&name(t))).collect()
}

/// `ALL_BUILTIN_SESSION_TOOLS`.
fn all_builtin(pool: &[Arc<dyn Tool>]) -> Tools {
    ordered(dedup(named(pool, &BUILTIN).into_iter().chain(named(pool, &[PATCH])).chain(named(pool, &[CODE_GRAPH]))))
}

/// `standaloneTools` of `collectStandaloneToolDefs` (`runtime-core/tool-defs.mjs`), group by group:
/// the tool-search tool, `Skill`, `session`, the web tools (`WEB_SEARCH_RUNTIME_TOOLS`), the memory
/// tools (the runtime's definition order), `code_graph`, the desktop bridges, `explore`, `setup`, the
/// ask/handoff/react tools, `goal` and `agent`. Node registers them in this order whatever order the
/// pool was built in; the deferred catalog lists a tie of equally ranked tools by it.
const STANDALONE_ORDER: &[&str] = &[
    "load_tool",
    "Skill",
    "session",
    "web_search",
    "web_fetch",
    "local_fetch",
    "image_fetch",
    "memory",
    "recall",
    "code_graph",
    "browser",
    "browser_devtools",
    "computer",
    "terminal",
    "office",
    "media",
    "tidy",
    "visualize",
    "explore",
    "setup",
    "ask_user",
    "handoff_user",
    "react",
    "goal",
    "agent",
];

/// `standaloneTools` of the pool, in Node's registration order: every registered tool that is not a
/// built-in (but `code_graph`, which Node registers in both lists) nor the step list or the bridge's
/// `call_tool`, which the resolved set adds itself. A tool `STANDALONE_ORDER` does not name follows the
/// named ones in pool order. A `public:false` tool never enters any model-visible schema, so it is left out.
pub fn standalone_tools(pool: &[Arc<dyn Tool>]) -> Tools {
    let mut tools: Tools =
        pool.iter().filter(|t| t.spec().public && (!is_builtin(name(t)) || name(t) == CODE_GRAPH) && ![TODO, "call_tool"].contains(&name(t))).cloned().collect();
    tools.sort_by_key(|t| STANDALONE_ORDER.iter().position(|n| *n == name(t)).unwrap_or(STANDALONE_ORDER.len()));
    tools
}

/// The internal tools of the pool: the standalone tools less `code_graph`, which the built-ins own
/// (their whole definition, not the projection an internal tool gets).
pub fn internal_tools(pool: &[Arc<dyn Tool>]) -> Tools {
    standalone_tools(pool).into_iter().filter(|t| name(t) != CODE_GRAPH).collect()
}

/// A resolved tool as the session holds it. An internal tool went through `_getMcpTools`' projection to
/// `{ name, description, inputSchema, annotations }`, which carries neither its `title` nor its
/// `trigger`: the deferred manifest lists its description. The built-ins, the connected servers' tools
/// and the step list keep their whole definition.
pub fn session_doc(pool: &[Arc<dyn Tool>], tool: &Arc<dyn Tool>) -> Value {
    let doc = tool.spec().definition();
    if !internal_tools(pool).iter().any(|internal| name(internal) == name(tool)) {
        return doc;
    }
    let mut projected = Map::new();
    projected.insert("name".to_owned(), doc["name"].clone());
    projected.insert("description".to_owned(), Value::String(doc.get("description").and_then(Value::as_str).unwrap_or_default().to_owned()));
    projected.insert("inputSchema".to_owned(), doc.get("inputSchema").filter(|schema| !schema.is_null()).cloned().unwrap_or_else(|| json!({ "type": "object", "properties": {} })));
    projected.insert("annotations".to_owned(), doc.get("annotations").cloned().unwrap_or_else(|| json!({})));
    Value::Object(projected)
}

/// The tools a session's spec resolves to, in the order they are sent. `mcp` are the connected
/// servers' tools.
pub fn resolve(pool: &[Arc<dyn Tool>], mcp: Tools, request: &Resolve<'_>) -> Tools {
    static SEARCH: std::sync::LazyLock<JsRegex> = std::sync::LazyLock::new(|| JsRegex::new_static("search", "i"));
    let builtin = all_builtin(pool);
    // `_getMcpTools`: the MCP tools and the internal ones, sorted by code point (UTF-8 byte order).
    let mut merged = mcp;
    merged.extend(internal_tools(pool));
    merged.sort_by(|a, b| name(a).cmp(name(b)));
    let skill_tools: Tools = if request.agent_owned || request.skills_listed { named(pool, &[SKILL]) } else { Vec::new() };
    let readonly = readonly_filesystem_tools(pool);
    let with = |lists: &[&Tools]| ordered(dedup(lists.iter().flat_map(|l| l.iter().cloned())));

    let base = match request.tool_spec {
        Some(Value::Array(tags)) if tags.is_empty() => dedup(skill_tools.clone()),
        Some(Value::Array(tags)) if tags.iter().any(|t| t.as_str() == Some("full")) => with(&[&builtin, &merged, &skill_tools]),
        Some(Value::Array(tags)) => {
            let mut chosen: Tools = Vec::new();
            for tag in tags {
                let tag = js_trim(&mixdog_js::value_to_string(tag)).to_owned();
                let by_names = |names: &[&str]| builtin.iter().filter(|t| names.contains(&name(t))).cloned().collect::<Tools>();
                match tag.as_str() {
                    "tools:filesystem" => chosen.extend(by_names(&FILESYSTEM)),
                    "tools:readonly" => chosen.extend(readonly.iter().cloned()),
                    "tools:shell" | "tools:analysis" => chosen.extend(by_names(&["shell", "task"])),
                    "tools:git" => chosen.extend(by_names(&["git", "shell", "task"])),
                    "tools:mcp" => chosen.extend(merged.iter().cloned()),
                    // Name-pattern match: `recall` is reached through `tools:mcp` only.
                    "tools:websearch" => chosen.extend(merged.iter().filter(|t| SEARCH.is_match(name(t))).cloned()),
                    other => tracing::warn!("[session] unknown toolset id \"{other}\" (profile.tools); skipping"),
                }
            }
            with(&[&dedup(chosen), &skill_tools])
        }
        Some(Value::String(spec)) if spec == "mcp" => with(&[&merged, &skill_tools]),
        Some(Value::String(spec)) if spec == "readonly" => with(&[&readonly, &merged, &skill_tools]),
        _ => with(&[&builtin, &merged, &skill_tools]),
    };
    // `withTodoTool`: every session that has tools owns a step list.
    let no_tools = matches!(request.tool_spec, Some(Value::Array(tags)) if tags.is_empty());
    let base = if no_tools { base } else { dedup(base.into_iter().chain(named(pool, &[TODO]))) };
    // `filterModelEditTools`: only the edit dialect the model can call.
    let kept = filter_model_edit_tool_names(&base.iter().map(|t| name(t).to_owned()).collect::<Vec<_>>(), request.model);
    let base: Tools = base.into_iter().filter(|t| kept.iter().any(|k| k == name(t))).collect();
    finalize(base, request)
}

/// `finalizeSessionToolList`: the caller's allowlist and denylist, then the agent worker's
/// removal of the Lead-only control tools.
fn finalize(mut tools: Tools, request: &Resolve<'_>) -> Tools {
    if let Some(allowed) = request.schema_allowed {
        tools.retain(|t| allowed.iter().any(|a| a.to_lowercase() == name(t).to_lowercase()));
    }
    tools.retain(|t| !request.disallowed.iter().any(|d| d.to_lowercase() == name(t).to_lowercase()));
    if request.agent_owned {
        tools.retain(|t| !AGENT_DENIED_TOOLS.contains(&name(t).to_lowercase().as_str()));
        tools = ordered(tools);
    }
    tools
}

/// An executable tool whose definitions (the Lead's and a delegated agent's) name the one edit dialect
/// the session's model can call (`bindEditDialectDescription`): `filterModelEditTools` rewrites the
/// token of a static description in the session's tool list, and the model is sent the definitions of
/// the executable set.
struct EditDialect {
    spec: ToolSpec,
    agent: Option<ToolSpec>,
    inner: Arc<dyn Tool>,
}

#[async_trait]
impl Tool for EditDialect {
    fn spec(&self) -> &ToolSpec {
        &self.spec
    }

    fn agent_spec(&self) -> Option<&ToolSpec> {
        self.agent.as_ref()
    }

    fn freeform(&self) -> Option<&Freeform> {
        self.inner.freeform()
    }

    fn outbound_kind(&self, args: &Value) -> Option<ActionKind> {
        self.inner.outbound_kind(args)
    }

    async fn call(&self, ctx: &ToolContext, args: Value) -> ToolOutcome {
        self.inner.call(ctx, args).await
    }
}

/// `tool` as `model`'s session holds it: itself, or its dialect-bound twin when a definition of it has the token.
fn bound_to_model(tool: Arc<dyn Tool>, model: &str) -> Arc<dyn Tool> {
    let rewrite = |spec: &ToolSpec| bind_edit_dialect(&spec.description, model).map(|description| ToolSpec { description, ..spec.clone() });
    let spec = rewrite(tool.spec());
    let agent = tool.agent_spec().and_then(rewrite);
    if spec.is_none() && agent.is_none() {
        return tool;
    }
    Arc::new(EditDialect { spec: spec.unwrap_or_else(|| tool.spec().clone()), agent: agent.or_else(|| tool.agent_spec().cloned()), inner: tool })
}

/// The connected MCP servers' tools a session at `cwd` may see (`getMcpTools` and
/// `filterMcpToolsForSession`).
pub trait SessionMcp: Send + Sync + 'static {
    fn tools(&self, cwd: &Path) -> Tools;
}

/// Whether skills are listed for a folder (`skills.length` of `resolveSessionTools`).
/// Answered from a collection that is current (Node collects before it filters), so it is async;
/// a collection that fails is the error, not "none".
#[async_trait]
pub trait SkillsListed: Send + Sync + 'static {
    async fn any_for(&self, cwd: &Path) -> Result<bool, String>;
}

/// [`SessionMcp`] over the hub: the tools of every ready server whose own extension scope admits
/// the folder (`filterMcpToolsForCwd`). An agent's connectors never narrow the list.
pub struct HubMcp {
    pub hub: Arc<McpHub>,
    /// The live `extensionScopes` setting.
    pub scopes: Arc<dyn Fn() -> ExtensionScopes + Send + Sync>,
}

impl SessionMcp for HubMcp {
    fn tools(&self, cwd: &Path) -> Tools {
        let scopes = (self.scopes)();
        self.hub
            .tools()
            .into_iter()
            .filter(|tool| {
                let server = self.hub.tool_target(name(tool)).map(|target| target.server.name().to_owned());
                server.is_none_or(|server| scopes.allowed_for_cwd(ScopeKind::Mcp, &server, cwd))
            })
            .collect()
    }
}

/// The `tools` seam: a session's tools from its header and surface.
pub struct SessionToolBuilder {
    /// Every registered tool (`orch::register::tools` and the file, shell, git, web and graph tools).
    pool: Tools,
    mcp: Arc<dyn SessionMcp>,
    skills: Arc<dyn SkillsListed>,
}

impl SessionToolBuilder {
    /// The pool must give a delegated agent its `git` and `task` definitions (`check_pool`): a pool
    /// without them is refused here, not at an agent's first turn.
    pub fn new(pool: Tools, mcp: Arc<dyn SessionMcp>, skills: Arc<dyn SkillsListed>) -> Result<Self, VariantError> {
        check_pool(&pool)?;
        Ok(Self { pool, mcp, skills })
    }

    /// The tools the session sends: its spec's resolved set, in the order of the surface's active
    /// tools (the header's `tools`, after the deferred surface chose them), without what the
    /// provider's route rejected. A bridge surface adds the bridge's own tools.
    pub async fn tools(&self, header: &Header, surface: &SessionSurface) -> Result<SessionTools, String> {
        let cwd = header.get("cwd").and_then(Value::as_str).map(PathBuf::from).unwrap_or_default();
        let model = header.get("model").and_then(Value::as_str).map_or("", js_trim);
        let skills_listed = self.skills.any_for(&cwd).await?;
        let resolved = resolve(
            &self.pool,
            self.mcp.tools(&cwd),
            &Resolve {
                tool_spec: header.get("toolSpec"),
                model,
                skills_listed,
                agent_owned: surface.agent_owned,
                // The allowlist narrows the schema when the surface is created (`resolveSessionToolSurface`) and gates a call
                // (`SessionSurface::refusal`), but the provider is sent the session's tools as they stand: the standalone
                // tools `applyDeferredToolSurface` adds (`modelStandaloneTools()`, `session-runtime/tool-surface.mjs`) are
                // not narrowed by it (the `lead, caller allowlist` recording).
                schema_allowed: None,
                disallowed: &surface.disallowed,
            },
        );
        let bridge = if surface.bridge { named(&self.pool, &BRIDGE) } else { Vec::new() };
        let tools: Tools = surface
            .active_tools
            .iter()
            .filter(|active| !surface.route_excluded.iter().any(|(excluded, _)| excluded == *active))
            .filter_map(|active| resolved.iter().chain(&bridge).find(|t| name(t) == active).cloned())
            .map(|tool| bound_to_model(tool, model))
            .collect();
        let builtins = tools.iter().map(|t| name(t)).filter(|n| is_builtin(n)).map(str::to_owned).collect();
        // A `public: false` tool is in no list a model is sent, but a call the runtime rewrites onto it
        // (`web_fetch` to `local_fetch` / `image_fetch`) is dispatched by name, whatever the session.
        let unlisted = self.pool.iter().filter(|t| !t.spec().public).cloned();
        Ok(SessionTools { tools: tools.into_iter().chain(unlisted).collect(), builtins, agent: surface.agent_owned })
    }
}

#[cfg(test)]
mod tests {
    use async_trait::async_trait;
    use mixdog_core_api::domain::tool::{ToolAnnotations, ToolContext, ToolOutcome, ToolOutput, ToolSpec};
    use serde_json::json;

    use super::*;

    struct Stub(ToolSpec);

    #[async_trait]
    impl Tool for Stub {
        fn spec(&self) -> &ToolSpec {
            &self.0
        }
        async fn call(&self, _: &ToolContext, _: Value) -> ToolOutcome {
            Ok(ToolOutput::default())
        }
    }

    /// A tool that has a definition for delegated agents (its own, here: only that it has one counts).
    struct Agented(ToolSpec);

    #[async_trait]
    impl Tool for Agented {
        fn spec(&self) -> &ToolSpec {
            &self.0
        }
        fn agent_spec(&self) -> Option<&ToolSpec> {
            Some(&self.0)
        }
        async fn call(&self, _: &ToolContext, _: Value) -> ToolOutcome {
            Ok(ToolOutput::default())
        }
    }

    fn spec_of(name: &str) -> ToolSpec {
        ToolSpec {
            name: name.into(),
            title: None,
            trigger: None,
            public: true,
            aliases: Vec::new(),
            description: String::new(),
            input_schema: json!({}),
            annotations: ToolAnnotations::default(),
            parallel_safe: true,
            exclusive_with: Vec::new(),
        }
    }

    fn stub(name: &str) -> Arc<dyn Tool> {
        // `git` and `task` have the definition delegated agents are sent, as the real ones do.
        if matches!(name, "git" | "task") { Arc::new(Agented(spec_of(name))) } else { Arc::new(Stub(spec_of(name))) }
    }

    fn names(tools: &[Arc<dyn Tool>]) -> Vec<String> {
        tools.iter().map(|t| name(t).to_owned()).collect()
    }

    /// `public: false` tools (`local_fetch`, `image_fetch`) are in no resolved tool list, whatever the
    /// spec form; the builder adds them to the executable set only.
    #[test]
    fn an_unlisted_tool_is_in_no_session_list() {
        let unlisted: Arc<dyn Tool> = Arc::new(Stub(ToolSpec { public: false, ..stub("local_fetch").spec().clone() }));
        let pool = vec![stub("read"), stub("web_fetch"), unlisted];
        for spec in [None, Some(json!("full")), Some(json!("mcp")), Some(json!("readonly"))] {
            let request = Resolve { tool_spec: spec.as_ref(), model: "", skills_listed: false, agent_owned: false, schema_allowed: None, disallowed: &[] };
            assert!(!names(&resolve(&pool, Vec::new(), &request)).contains(&"local_fetch".to_owned()), "{spec:?}");
        }
    }

    /// `readOnlyFilesystemTools()` holds `code_graph` (`tool-resolution.mjs:96`), but only of a pool it is registered in: the explorer host keeps one snapshot at `bind`,
    /// so the composition binds it after `code_graph` joins the pool.
    #[test]
    fn the_read_only_filesystem_tools_include_code_graph_once_it_is_in_the_pool() {
        let mut pool: Tools = vec![stub("read"), stub("grep")];
        assert!(!names(&readonly_filesystem_tools(&pool)).contains(&"code_graph".to_owned()));
        pool.push(stub("code_graph"));
        assert!(names(&readonly_filesystem_tools(&pool)).contains(&"code_graph".to_owned()));
    }

    fn golden() -> Value {
        serde_json::from_str(include_str!("golden/session_tools.json")).expect("fixture")
    }

    fn strings(value: &Value) -> Vec<String> {
        value.as_array().expect("array").iter().map(|v| v.as_str().expect("string").to_owned()).collect()
    }

    /// The pool Node's recording ran over, plus `todo` and `call_tool`, which the resolved set
    /// must leave out of its internal part.
    fn pool(g: &Value) -> (Tools, Tools) {
        let p = &g["pool"];
        let all = ["builtin", "patch", "codeGraph", "internal"].iter().flat_map(|k| strings(&p[k])).chain(["todo".to_owned(), "call_tool".to_owned()]);
        (all.map(|n| stub(&n)).collect(), strings(&p["mcp"]).iter().map(|n| stub(n)).collect())
    }

    /// Node's `resolveSessionTools` + `finalizeSessionToolList` for the Lead and an agent worker,
    /// over every tool spec form, both edit dialects, skills listed or not, and allow/deny lists.
    #[test]
    fn the_session_tool_list_follows_node() {
        let g = golden();
        let (pool, mcp) = pool(&g);
        for case in g["cases"].as_array().expect("cases") {
            let list = |key: &str| case[key].as_array().map(|_| strings(&case[key]));
            let (allowed, denied) = (list("allowed"), list("denied"));
            let got = resolve(
                &pool,
                mcp.clone(),
                &Resolve {
                    tool_spec: Some(&case["spec"]),
                    model: case["model"].as_str().expect("model"),
                    skills_listed: case["skills"].as_bool().expect("skills"),
                    agent_owned: case["agent"].as_bool().expect("agent"),
                    schema_allowed: allowed.as_deref(),
                    disallowed: denied.as_deref().unwrap_or(&[]),
                },
            );
            assert_eq!(names(&got), strings(&case["tools"]), "{}", case["name"]);
        }
    }

    #[test]
    fn the_explorer_gets_the_read_only_filesystem_tools_in_route_order() {
        let g = golden();
        let (pool, _) = pool(&g);
        assert_eq!(names(&readonly_filesystem_tools(&pool)), strings(&g["explorer"]));
    }

    struct Fixed(Tools);
    impl SessionMcp for Fixed {
        fn tools(&self, cwd: &Path) -> Tools {
            assert_eq!(cwd, Path::new("/work"));
            self.0.clone()
        }
    }
    struct Listed(bool);
    #[async_trait]
    impl SkillsListed for Listed {
        async fn any_for(&self, _: &Path) -> Result<bool, String> {
            Ok(self.0)
        }
    }

    fn builder() -> SessionToolBuilder {
        let g = golden();
        let (pool, mcp) = pool(&g);
        SessionToolBuilder::new(pool, Arc::new(Fixed(mcp)), Arc::new(Listed(false))).expect("a pool whose git and task have their agent definitions")
    }

    fn header(value: Value) -> Header {
        value.as_object().expect("object").clone()
    }

    #[tokio::test]
    async fn the_sent_set_is_the_resolved_set_in_the_order_of_the_active_tools_less_route_exclusions() {
        let surface = SessionSurface {
            active_tools: ["grep", "read", "agent", "mcp__alpha__zeta", "nope", "shell"].map(String::from).to_vec(),
            disallowed: vec!["shell".into()],
            route_excluded: vec![("read".into(), "why".into())],
            ..SessionSurface::default()
        };
        let got = builder().tools(&header(json!({"cwd": "/work", "model": "claude-sonnet-4", "toolSpec": "full"})), &surface).await.unwrap();
        // `read` is route-excluded, `nope` is not a tool, `shell` is denied.
        assert_eq!(names(&got.tools), ["grep", "agent", "mcp__alpha__zeta"]);
        assert_eq!(got.builtins, ["grep"]);
    }

    #[tokio::test]
    async fn a_bridge_surface_carries_the_bridge_tools_even_past_an_allowlist() {
        let surface = SessionSurface {
            active_tools: ["read", "load_tool", "call_tool"].map(String::from).to_vec(),
            schema_allowed: Some(vec!["read".into()]),
            bridge: true,
            ..SessionSurface::default()
        };
        let header = header(json!({"cwd": "/work", "model": "gpt-5", "toolSpec": "full"}));
        assert_eq!(names(&builder().tools(&header, &surface).await.unwrap().tools), ["read", "load_tool", "call_tool"]);
    }

    /// The allowlist gates a call, not the schema the session already holds: a Lead created with one keeps the
    /// standalone tools the deferred surface added (recorded as `lead, caller allowlist`).
    #[tokio::test]
    async fn an_allowlist_does_not_narrow_the_tools_the_session_holds() {
        let surface = SessionSurface { active_tools: ["read", "grep"].map(String::from).to_vec(), schema_allowed: Some(vec!["read".into()]), ..SessionSurface::default() };
        let header = header(json!({"cwd": "/work", "model": "gpt-5", "toolSpec": "full"}));
        assert_eq!(names(&builder().tools(&header, &surface).await.unwrap().tools), ["read", "grep"]);
    }

    #[tokio::test]
    async fn an_agent_worker_never_sends_the_lead_only_control_tools() {
        let surface = SessionSurface {
            active_tools: ["session", "agent", "ask_user", "handoff_user", "goal"].map(String::from).to_vec(),
            agent_owned: true,
            ..SessionSurface::default()
        };
        let got = builder().tools(&header(json!({"cwd": "/work", "model": "claude-sonnet-4"})), &surface).await.unwrap();
        assert_eq!(names(&got.tools), ["goal"]);
    }

    /// The builder refuses a pool whose `task` has no definition for delegated agents.
    #[test]
    fn a_pool_without_the_agent_definition_of_task_is_refused_by_the_builder() {
        let g = golden();
        let (mut pool, mcp) = pool(&g);
        let at = pool.iter().position(|tool| name(tool) == "task").expect("task");
        pool[at] = Arc::new(Stub(spec_of("task")));
        let error = SessionToolBuilder::new(pool, Arc::new(Fixed(mcp)), Arc::new(Listed(false))).err().expect("refused");
        assert_eq!(error, VariantError { tool: "task" });
    }

    /// An internal tool is held as `_getMcpTools` projects it (no `title`, no `trigger`), so the deferred
    /// manifest lists its description; a built-in keeps its whole definition.
    #[test]
    fn an_internal_tool_loses_its_trigger_and_a_builtin_keeps_it() {
        let with_trigger = |name: &str| -> Arc<dyn Tool> {
            let annotations = ToolAnnotations { read_only_hint: Some(true), ..ToolAnnotations::default() };
            Arc::new(Stub(ToolSpec { title: Some("T".into()), trigger: Some("when".into()), description: "what".into(), annotations, ..spec_of(name) }))
        };
        let pool = vec![with_trigger("read"), with_trigger("session")];
        assert_eq!(session_doc(&pool, &pool[1]), json!({ "name": "session", "description": "what", "inputSchema": {}, "annotations": { "readOnlyHint": true } }));
        assert_eq!(session_doc(&pool, &pool[0]), pool[0].spec().definition());
    }

    /// The model is sent a static description with the one edit dialect it can call (`bindEditDialectDescription`).
    #[test]
    fn a_description_names_the_edit_dialect_the_model_can_call() {
        let shell: Arc<dyn Tool> = Arc::new(Stub(ToolSpec { description: "writes with edit/apply_patch".into(), ..spec_of("shell") }));
        assert_eq!(bound_to_model(shell.clone(), "claude-opus-4-6").spec().description, "writes with edit");
        assert_eq!(bound_to_model(shell, "gpt-5").spec().description, "writes with apply_patch");
        let read = stub("read");
        assert!(Arc::ptr_eq(&bound_to_model(read.clone(), "gpt-5"), &read), "a description without the token is left as it is");
    }
}