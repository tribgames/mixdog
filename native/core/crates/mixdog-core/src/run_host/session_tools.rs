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
use mixdog_core_api::domain::tool::{Freeform, StoredTool, Tool, ToolContext, ToolOutcome, ToolSpec};
use mixdog_js::{js_trim, JsRegex};
use mixdog_mcp::scopes::ExtensionScopes;
use mixdog_mcp::McpHub;
use mixdog_mcp::hub::normalize_scope;
use mixdog_store::schema::record::Header;
use mixdog_tools::policy::surface::{AGENT_DENIED_TOOLS, READONLY_FS_TOOL_NAMES};
use mixdog_tools::policy::SessionSurface;
use mixdog_tools::policy::Withdrawal;
use serde_json::{json, Map, Value};

use super::assemble::SessionTools;
use super::agent_variants::{check_pool, VariantError};
use super::tool_surface::{bind_edit_dialect, filter_model_edit_tool_names, fixed_surface_mode, ROUTE_TOOL_ORDER};

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

/// `standaloneTools` of the pool, which `internalToolDefs` (and so `_getMcpTools`' merge) holds, in Node's
/// registration order: every registered tool that is not a built-in (but `code_graph`, which Node registers in
/// both lists) nor the step list or the bridge's `call_tool`, which the resolved set adds itself. A tool
/// `STANDALONE_ORDER` does not name follows the named ones in pool order. A `public:false` tool never enters
/// any model-visible schema, so it is left out.
pub fn internal_tools(pool: &[Arc<dyn Tool>]) -> Tools {
    let mut tools: Tools =
        pool.iter().filter(|t| t.spec().public && (!is_builtin(name(t)) || name(t) == CODE_GRAPH) && ![TODO, "call_tool"].contains(&name(t))).cloned().collect();
    tools.sort_by_key(|t| STANDALONE_ORDER.iter().position(|n| *n == name(t)).unwrap_or(STANDALONE_ORDER.len()));
    tools
}

/// A resolved tool as the session holds it. An internal tool went through `_getMcpTools`' projection to
/// `{ name, description, inputSchema, annotations }`, which carries neither its `title` nor its
/// `trigger`: the deferred manifest lists its description. The built-ins, the connected servers' tools
/// and the step list keep their whole definition, and so does code_graph, which a built-in spec resolves as a built-in (under the
/// mcp specs Node projects it; the stored definition only differs by `title` and `trigger`, never on the wire).
pub fn session_doc(pool: &[Arc<dyn Tool>], tool: &Arc<dyn Tool>) -> Value {
    // The tool's stored entry: payload and publisher together, the unit every stored catalog holds.
    let doc = tool.stored().encode();
    if name(tool) == CODE_GRAPH || !internal_tools(pool).iter().any(|internal| name(internal) == name(tool)) {
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
                    other => mixdog_rt::node_stderr!("[session] unknown toolset id \"{other}\" (profile.tools); skipping"),
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
    if mixdog_mcp::skill_catalog::skills_disabled_by_env() {
        tools.retain(|t| name(t) != SKILL);
    }
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

/// The connected MCP servers' tools a session of MCP scope `scope` at `cwd` may see
/// (`getMcpTools(scopeId)` and `filterMcpToolsForSession`). `scope` is the header's `mcpScopeId`;
/// none is the default scope.
pub trait SessionMcp: Send + Sync + 'static {
    fn tools(&self, scope: Option<&str>, cwd: &Path) -> Tools;
    /// One reading of what the servers have published, as the judgement `(name, owner)` of whether `owner` (the server recorded
    /// with the stored definition of the MCP tool `name`) has withdrawn it (published a catalog without it). A server that is
    /// down or a scope that moved withdraws nothing.
    fn withdrawal(&self) -> Withdrawal {
        Arc::new(|_, _| false)
    }
    /// The tools and the withdrawal judgement of one reading. A source that can read both at once overrides this; the default
    /// reads them one after the other.
    fn read(&self, scope: Option<&str>, cwd: &Path) -> (Tools, Withdrawal) {
        (self.tools(scope, cwd), self.withdrawal())
    }
}

/// The `mcpScopeId` a header names, trimmed; none when it is absent, null or empty
/// (`normalizeMcpScopeId` reads those as the default scope).
pub(super) fn header_scope(header: &Header) -> Option<&str> {
    header.get("mcpScopeId").and_then(Value::as_str).map(js_trim).filter(|scope| !scope.is_empty())
}

/// Whether skills are listed for a folder (`skills.length` of `resolveSessionTools`).
/// Answered from a collection that is current (Node collects before it filters), so it is async;
/// a collection that fails is the error, not "none".
#[async_trait]
pub trait SkillsListed: Send + Sync + 'static {
    async fn any_for(&self, cwd: &Path) -> Result<bool, String>;
}

/// [`SessionMcp`] over the hub: the tools of every ready server of the session's scope whose own
/// extension scope admits the folder (`filterMcpToolsForCwd`). An agent's connectors never narrow
/// the list.
pub struct HubMcp {
    pub hub: Arc<McpHub>,
    /// The live `extensionScopes` setting.
    pub scopes: Arc<dyn Fn() -> ExtensionScopes + Send + Sync>,
}

impl SessionMcp for HubMcp {
    fn tools(&self, scope: Option<&str>, cwd: &Path) -> Tools {
        self.hub.tools_for_cwd(&normalize_scope(scope), &(self.scopes)(), cwd)
    }

    fn withdrawal(&self) -> Withdrawal {
        let published = self.hub.published();
        Arc::new(move |name, owner| published.withdrawn(name, owner))
    }

    fn read(&self, scope: Option<&str>, cwd: &Path) -> (Tools, Withdrawal) {
        let (tools, published) = self.hub.read_for_cwd(&normalize_scope(scope), &(self.scopes)(), cwd);
        (tools, Arc::new(move |name, owner| published.withdrawn(name, owner)))
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
        let listed = self.mcp.tools(header_scope(header), &cwd);
        let resolved = resolve(
            &self.pool,
            listed,
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
                // The denials too gate a call and not the schema: what a session was never allowed to have is already absent from
                // its stored `tools` (the creation and resume paths resolve with them), and a gate that closes afterwards
                // (`stage_tool_availability`: the desktop leaving, Computer Use toggled) is enforced at dispatch by
                // `SessionSurface::refusal`, never by editing the definitions of a live epoch (Node `pre-dispatch-deny.mjs:128-131`).
                disallowed: &[],
            },
        );
        let bridge = if surface.bridge { named(&self.pool, &BRIDGE) } else { Vec::new() };
        // The standalone tools `applyDeferredToolSurface` adds to a Lead's schema are in the pool, not in its spec's
        // list (a `readonly` spec holds the filesystem tools only, yet sends `web_search`, `load_tool` and `Skill`).
        // A worker's list never holds the Lead-only control tools, whoever added them.
        let standalone: Tools = if surface.agent_owned { Vec::new() } else { internal_tools(&self.pool) };
        let fixed = fixed_surface_mode(header.get("deferredProviderMode"), header.get("toolExposureMode"));
        let tools: Tools = surface
            .active_tools
            .iter()
            .filter(|active| !surface.route_excluded.iter().any(|(excluded, _)| excluded == *active))
            .filter_map(|active| {
                let live = resolved
                    .iter()
                    .chain(&bridge)
                    .chain(&standalone)
                    .find(|t| name(t) == active)
                    .cloned();
                // Fixed surfaces keep the stored MCP definition even on reconnect. Bind it here, before any request
                // assembly, so a caller that doesn't run the boundary snapshot sees the same definition.
                if (live.is_none() || (fixed && active.starts_with("mcp__")))
                    && let Some(entry) = Self::stored_entry(header, active)
                {
                    let retained: Arc<dyn Tool> = Arc::new(Retained::new(entry).with_handler(live));
                    return Some(if fixed { retained } else { bound_to_model(retained, model) });
                }
                live.map(|tool| bound_to_model(tool, model))
            })
            .collect();
        let builtins = tools.iter().map(name).filter(|n| is_builtin(n)).map(str::to_owned).collect();
        // A `public: false` tool is in no list a model is sent, but a call the runtime rewrites onto it
        // (`web_fetch` to `local_fetch` / `image_fetch`) is dispatched by name, whatever the session.
        let unlisted = self.pool.iter().filter(|t| !t.spec().public).cloned();
        Ok(SessionTools { tools: tools.into_iter().chain(unlisted).collect(), builtins, agent: surface.agent_owned })
    }

    fn stored_entry(header: &Header, active: &str) -> Option<StoredTool> {
        let doc = header.get("tools")?.as_array()?.iter().find(|doc| doc.get("name").and_then(Value::as_str) == Some(active))?;
        if !active.starts_with("mcp__") && doc.get("inputSchema").is_none() {
            return None;
        }
        Some(StoredTool::decode(doc))
    }
}

/// A cached definition with a separate execution handler, if one is available.
struct Retained {
    entry: StoredTool,
    spec: ToolSpec,
    freeform: Option<Freeform>,
    handler: Option<Arc<dyn Tool>>,
}

impl Retained {
    fn new(entry: StoredTool) -> Self {
        let spec = retained_spec(entry.stored());
        let freeform = Freeform::from_definition(entry.stored());
        Self { entry, spec, freeform, handler: None }
    }

    fn with_handler(mut self, handler: Option<Arc<dyn Tool>>) -> Self {
        self.handler = handler;
        self
    }
}

/// The spec of a stored definition (`ToolSpec::definition` read back), so the request's bytes for it are the stored ones.
fn retained_spec(doc: &Value) -> ToolSpec {
    use mixdog_core_api::domain::tool::ToolAnnotations;
    let text = |key: &str| doc.get(key).and_then(Value::as_str).map(str::to_owned);
    let hints = doc.get("annotations");
    let flag = |key: &str| hints.and_then(|hints| hints.get(key)).and_then(Value::as_bool);
    ToolSpec {
        name: text("name").unwrap_or_default(),
        title: text("title"),
        aliases: Vec::new(),
        description: text("description").unwrap_or_default(),
        trigger: text("trigger"),
        public: doc.get("public") != Some(&Value::Bool(false)),
        input_schema: doc.get("inputSchema").cloned().unwrap_or_else(|| json!({})),
        annotations: ToolAnnotations {
            title: hints.and_then(|hints| hints.get("title")).and_then(Value::as_str).map(str::to_owned),
            read_only_hint: flag("readOnlyHint"),
            destructive_hint: flag("destructiveHint"),
            idempotent_hint: flag("idempotentHint"),
            open_world_hint: flag("openWorldHint"),
            compressible: flag("compressible"),
            compressible_lossless: flag("compressibleLossless"),
            agent_hidden: flag("agentHidden"),
        },
        parallel_safe: true,
        exclusive_with: Vec::new(),
    }
}

impl Retained {
    /// What a call is answered with: unavailable, with why.
    fn refusal(&self) -> mixdog_core_api::domain::tool::ToolError {
        let name = &self.spec.name;
        let (capability, reason) = if name.starts_with("mcp__") {
            ("mcp", format!("the MCP server of {name} is not connected right now"))
        } else {
            ("tools", format!("the tool {name} is no longer registered"))
        };
        mixdog_core_api::domain::tool::ToolError::new(
            mixdog_core_api::domain::tool::ToolErrorCode::Unavailable { capability: capability.to_owned(), reason: reason.clone() },
            format!("Error: tool \"{name}\" is unavailable: {reason}."),
        )
    }
}

#[async_trait]
impl Tool for Retained {
    fn spec(&self) -> &ToolSpec {
        &self.spec
    }

    /// The entry as stored, publisher included: never rebuilt from the derived spec.
    fn stored(&self) -> StoredTool {
        self.entry.clone()
    }

    fn freeform(&self) -> Option<&Freeform> {
        self.freeform.as_ref()
    }

    fn outbound_kind(&self, args: &Value) -> Option<ActionKind> {
        self.handler.as_ref().and_then(|tool| tool.outbound_kind(args))
    }

    fn runnable(&self) -> bool {
        self.handler.as_ref().is_some_and(|tool| tool.runnable())
    }

    async fn call(&self, ctx: &ToolContext, args: Value) -> ToolOutcome {
        match &self.handler {
            Some(tool) => tool.call(ctx, args).await,
            None => Err(self.refusal()),
        }
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

    #[cfg(node_twin)]
    fn strings(value: &Value) -> Vec<String> {
        value.as_array().expect("array").iter().map(|v| v.as_str().expect("string").to_owned()).collect()
    }

    /// The pool Node's recording ran over, plus `todo` and `call_tool`, which the resolved set
    /// must leave out of its internal part.
    #[cfg(node_twin)]
    fn pool(g: &Value) -> (Tools, Tools) {
        let p = &g["pool"];
        let all = ["builtin", "patch", "codeGraph", "internal"].iter().flat_map(|k| strings(&p[k])).chain(["todo".to_owned(), "call_tool".to_owned()]);
        (all.map(|n| stub(&n)).collect(), strings(&p["mcp"]).iter().map(|n| stub(n)).collect())
    }

    #[cfg(node_twin)]
    struct Fixed(Tools);
    #[cfg(node_twin)]
    impl SessionMcp for Fixed {
        fn tools(&self, _: Option<&str>, cwd: &Path) -> Tools {
            assert_eq!(cwd, Path::new("/work"));
            self.0.clone()
        }
    }
    #[cfg(node_twin)]
    struct Listed(bool);
    #[async_trait]
    #[cfg(node_twin)]
    impl SkillsListed for Listed {
        async fn any_for(&self, _: &Path) -> Result<bool, String> {
            Ok(self.0)
        }
    }

    #[cfg(node_twin)]
    fn header(value: Value) -> Header {
        value.as_object().expect("object").clone()
    }

    /// A tool whose availability the test flips (`computer` with its helper and the desktop).
    #[cfg(node_twin)]
    struct Flips(ToolSpec, Arc<std::sync::atomic::AtomicBool>);
    #[async_trait]
    #[cfg(node_twin)]
    impl Tool for Flips {
        fn spec(&self) -> &ToolSpec {
            &self.0
        }
        fn runnable(&self) -> bool {
            self.1.load(std::sync::atomic::Ordering::SeqCst)
        }
        async fn call(&self, _: &ToolContext, _: Value) -> ToolOutcome {
            Ok(ToolOutput::default())
        }
    }

    /// A connected server's tool, published through the production constructor of a stored entry (`StoredTool::mcp`, what
    /// `McpTool::stored` calls with its server): the server `alpha` and the tool's own name `zeta`.
    #[cfg(node_twin)]
    struct Pub(ToolSpec);
    #[async_trait]
    #[cfg(node_twin)]
    impl Tool for Pub {
        fn spec(&self) -> &ToolSpec {
            &self.0
        }
        fn stored(&self) -> StoredTool {
            StoredTool::mcp(self.0.definition(), "alpha", Some("zeta"))
        }
        async fn call(&self, _: &ToolContext, _: Value) -> ToolOutcome {
            Ok(ToolOutput::default())
        }
    }

    #[cfg(node_twin)]
    fn published(schema: Value) -> Arc<dyn Tool> {
        Arc::new(Pub(ToolSpec { input_schema: schema, ..spec_of("mcp__alpha__zeta") }))
    }

    /// An MCP server whose tool list and withdrawals the test moves.
    #[cfg(node_twin)]
    struct LiveMcp(std::sync::Mutex<Tools>, Arc<std::sync::atomic::AtomicBool>);
    #[cfg(node_twin)]
    impl SessionMcp for LiveMcp {
        fn tools(&self, _: Option<&str>, _: &Path) -> Tools {
            self.0.lock().expect("tools").clone()
        }
        fn withdrawal(&self) -> Withdrawal {
            // The flag as it stands at this reading.
            let withdrawn = self.1.load(std::sync::atomic::Ordering::SeqCst);
            Arc::new(move |_, owner| owner == "alpha" && withdrawn)
        }
    }

    #[cfg(node_twin)]
    impl super::super::tool_surface::SurfaceHost for LiveMcp {
        fn defined(&self, _: &str) -> bool {
            true
        }
        fn bridge_tools(&self) -> Vec<Value> {
            Vec::new()
        }
        fn mcp_server_instructions(&self, _: Option<&str>) -> Value {
            Value::Null
        }
        fn withdrawal(&self) -> Withdrawal {
            SessionMcp::withdrawal(self)
        }
    }

    /// What a session stores of `tool` at creation, and what a restart reads back: the production document, persisted as text.
    #[cfg(node_twin)]
    fn persisted(pool: &[Arc<dyn Tool>], tool: &Arc<dyn Tool>) -> Value {
        serde_json::from_str(&serde_json::to_string(&session_doc(pool, tool)).expect("stored")).expect("reloaded")
    }

    /// The same entry as an older build stored it: no publisher recorded.
    #[cfg(node_twin)]
    fn legacy(doc: &Value) -> Value {
        let mut doc = doc.clone();
        let fields = doc.as_object_mut().expect("object");
        fields.remove("mcpServerName");
        fields.remove("mcpToolName");
        doc
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

    /// `reconcile_mcp_catalog` of a fixed-surface session over `live` docs, the request boundary's fold.
    #[cfg(node_twin)]
    fn reconcile_in_place(session: &mut Value, live: &[Value]) {
        use mixdog_agent::env::Clock;
        use super::super::tool_surface::{SurfaceHost as Host, ToolSurface};
        struct Clk;
        impl Clock for Clk {
            fn now_ms(&self) -> i64 {
                1
            }
        }
        struct NoHost;
        impl Host for NoHost {
            fn defined(&self, _: &str) -> bool {
                true
            }
            fn bridge_tools(&self) -> Vec<Value> {
                Vec::new()
            }
            fn mcp_server_instructions(&self, _: Option<&str>) -> Value {
                Value::Null
            }
        }
        session["deferredProviderMode"] = json!("full");
        ToolSurface { host: &NoHost, clock: &Clk }.reconcile_mcp_catalog(session, live);
    }


    #[cfg(node_twin)]
    fn golden() -> Value {
        serde_json::from_str(include_str!("golden/session_tools.json")).expect("fixture")
    }
    /// Node's `resolveSessionTools` + `finalizeSessionToolList` for the Lead and an agent worker,
    /// over every tool spec form, both edit dialects, skills listed or not, and allow/deny lists.
    #[test]
    #[cfg(node_twin)]
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
    #[cfg(node_twin)]
    fn the_explorer_gets_the_read_only_filesystem_tools_in_route_order() {
        let g = golden();
        let (pool, _) = pool(&g);
        assert_eq!(names(&readonly_filesystem_tools(&pool)), strings(&g["explorer"]));
    }
    #[cfg(node_twin)]
    fn builder() -> SessionToolBuilder {
        let g = golden();
        let (pool, mcp) = pool(&g);
        SessionToolBuilder::new(pool, Arc::new(Fixed(mcp)), Arc::new(Listed(false))).expect("a pool whose git and task have their agent definitions")
    }
    /// The sent set is the stored `tools` in order, less route exclusions. A denial (`disallowedTools`) is not applied here: the
    /// old expectation that a denied `shell` leaves the request was the port's, not Node's. Node persists `session.tools` and
    /// enforces the deny set at dispatch ("A workflow switched mid-conversation keeps the schema; its denials apply here",
    /// `pre-dispatch-deny.mjs:128-131`, and `stageToolAvailability` works "without touching its request prefix",
    /// `tool-availability.mjs:76`); what a session was never allowed to have is absent from its `tools` at creation.
    #[tokio::test]
    #[cfg(node_twin)]
    async fn the_sent_set_is_the_resolved_set_in_the_order_of_the_active_tools_less_route_exclusions() {
        let surface = SessionSurface {
            active_tools: ["grep", "read", "agent", "mcp__alpha__zeta", "nope", "shell"].map(String::from).to_vec(),
            disallowed: vec!["shell".into()],
            route_excluded: vec![("read".into(), "why".into())],
            ..SessionSurface::default()
        };
        let got = builder().tools(&header(json!({"cwd": "/work", "model": "claude-sonnet-4", "toolSpec": "full"})), &surface).await.unwrap();
        // `read` is route-excluded, `nope` is not a tool; `shell` is denied for dispatch and stays in the definitions.
        assert_eq!(names(&got.tools), ["grep", "agent", "mcp__alpha__zeta", "shell"]);
    }
    #[tokio::test]
    #[cfg(node_twin)]
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
    /// The tool definitions a session sends are fixed for its cache epoch: a tool starting or stopping to run (a desktop attaching
    /// or leaving, a helper found late) never adds, removes or rewrites one, on a native or on a bridge route. A call to it is
    /// answered unavailable at dispatch instead.
    #[tokio::test]
    #[cfg(node_twin)]
    async fn the_sent_definitions_do_not_move_when_a_tool_stops_or_starts_running() {
        let g = golden();
        let (mut pool, mcp) = pool(&g);
        let up = Arc::new(std::sync::atomic::AtomicBool::new(true));
        let at = pool.iter().position(|tool| name(tool) == "read").expect("read");
        pool[at] = Arc::new(Flips(spec_of("read"), up.clone()));
        let builder = SessionToolBuilder::new(pool, Arc::new(Fixed(mcp)), Arc::new(Listed(false))).expect("pool");
        let bytes = |tools: &[Arc<dyn Tool>]| tools.iter().map(|tool| tool.spec().definition().to_string()).collect::<Vec<_>>().join("\n");
        for (bridge, active) in [(false, vec!["read", "grep"]), (true, vec!["read", "grep", "load_tool", "call_tool"])] {
            let surface = SessionSurface { active_tools: active.into_iter().map(String::from).collect(), bridge, ..SessionSurface::default() };
            let header = header(json!({"cwd": "/work", "model": "gpt-5", "toolSpec": "full"}));
            let first = bytes(&builder.tools(&header, &surface).await.unwrap().tools);
            assert!(first.contains("\"read\""), "bridge {bridge}");
            for flip in [false, true, false] {
                up.store(flip, std::sync::atomic::Ordering::SeqCst);
                assert_eq!(bytes(&builder.tools(&header, &surface).await.unwrap().tools), first, "bridge {bridge}, running {flip}");
            }
        }
    }
    /// A server dropping and returning in a live session never moves the definitions: the request's bytes are identical
    /// while the hub lists nothing (the stored definition holds its place and refuses a call as unavailable) and after it
    /// returns. Withdrawal is covered separately, including the live removal notice.
    #[tokio::test]
    #[cfg(node_twin)]
    async fn an_mcp_server_dropping_and_returning_never_moves_the_sent_definitions() {
        let g = golden();
        let (pool, _) = pool(&g);
        let tool = published(json!({}));
        let live = Arc::new(LiveMcp(std::sync::Mutex::new(vec![tool.clone()]), Arc::new(std::sync::atomic::AtomicBool::new(false))));
        let builder = SessionToolBuilder::new(pool.clone(), live.clone(), Arc::new(Listed(false))).expect("pool");
        // Created, persisted and reloaded as a restarted core reads it: the stored entry carries its publisher.
        let stored = persisted(&pool, &tool);
        assert_eq!(stored["mcpServerName"], "alpha");
        let held = header(json!({ "cwd": "/work", "model": "gpt-5", "toolSpec": "full", "tools": [stored.clone()] }));
        let surface = SessionSurface::from_header(&held, Vec::new());
        let bytes = |tools: &[Arc<dyn Tool>]| tools.iter().map(|tool| tool.spec().definition().to_string()).collect::<Vec<_>>().join("\n");
        let first = builder.tools(&held, &surface).await.unwrap().tools;
        assert!(bytes(&first).contains("mcp__alpha__zeta"));
        // The server drops (and the scope may move): nothing listed, nothing withdrawn.
        live.0.lock().expect("tools").clear();
        let during = builder.tools(&held, &surface).await.unwrap().tools;
        assert_eq!(bytes(&during), bytes(&first), "the definitions did not move");
        let kept = during.iter().find(|t| name(t) == "mcp__alpha__zeta").expect("kept");
        assert!(!kept.runnable());
        assert_eq!(kept.stored().encode(), stored, "what is stored again is the entry as stored, never rebuilt from its spec");
        let refusal = Retained::new(StoredTool::decode(&stored)).refusal();
        assert!(refusal.message_for_model.starts_with("Error: tool \"mcp__alpha__zeta\" is unavailable:"), "{}", refusal.message_for_model);
        // It returns: the live tool is sent again, byte-identical.
        live.0.lock().expect("tools").push(tool.clone());
        assert_eq!(bytes(&builder.tools(&held, &surface).await.unwrap().tools), bytes(&first));
    }
    /// An entry stored before publishers were recorded is legacy-unknown: through resume, reconcile and a disconnect its payload
    /// is kept whole and sent as stored, and its owner withdrawing every tool it knows (or another catalog's absence) never
    /// removes it; no publisher is filled in from its name or from today's tool of that name.
    #[tokio::test]
    #[cfg(node_twin)]
    async fn a_legacy_entry_survives_resume_reconcile_and_disconnect_and_is_never_withdrawn() {
        let g = golden();
        let (pool, _) = pool(&g);
        let tool = published(json!({}));
        let old = legacy(&persisted(&pool, &tool));
        assert_eq!(StoredTool::decode(&old).provenance(), &mixdog_core_api::domain::tool::Provenance::LegacyUnknown);
        let live = Arc::new(LiveMcp(std::sync::Mutex::new(vec![tool.clone()]), Arc::new(std::sync::atomic::AtomicBool::new(true))));
        let builder = SessionToolBuilder::new(pool.clone(), live.clone(), Arc::new(Listed(false))).expect("pool");
        let session = json!({ "cwd": "/work", "model": "gpt-5", "toolSpec": "full", "tools": [old.clone()], "deferredToolCatalog": [old.clone()] });
        // Resume installs the stored entry as stored; the hub lists nothing (a disconnect) and its owner has withdrawn all it knew.
        live.0.lock().expect("tools").clear();
        let held = header(session.clone());
        let surface = SessionSurface::from_header(&held, Vec::new());
        let sent = builder.tools(&held, &surface).await.unwrap().tools;
        let kept = sent.iter().find(|t| name(t) == "mcp__alpha__zeta").expect("a legacy entry is kept");
        assert_eq!(kept.stored().encode(), old, "the payload is kept whole, no publisher added");
        // Reconcile with a catalog that does not list it: the stored tool is untouched.
        let mut reconciled = session;
        reconcile_in_place(&mut reconciled, &[]);
        assert_eq!(reconciled["tools"], json!([old]));
    }
    /// An owner's changed schema on a fixed surface updates the scoped catalog only (`reconcile_mcp_catalog` returns there, as
    /// Node's does): the stored tool is not re-linked, so a tool that then drops is sent exactly as it was stored (A).
    #[tokio::test]
    #[cfg(node_twin)]
    async fn a_fixed_surface_reconcile_updates_the_catalog_and_leaves_the_stored_tool_as_stored() {
        use mixdog_core_api::domain::common::AbsPath;
        use mixdog_core_api::domain::mock::{MockApprovalGate, MockFileService, MockProcessManager, MockProgress};
        use mixdog_core_api::domain::tool::{SurfaceKind, ToolIo};

        let g = golden();
        let (pool, _) = pool(&g);
        let (a, b) = (published(json!({ "type": "object", "properties": { "a": {} } })), published(json!({ "type": "object", "properties": { "b": {} } })));
        let live = Arc::new(LiveMcp(std::sync::Mutex::new(vec![a.clone()]), Arc::new(std::sync::atomic::AtomicBool::new(false))));
        let builder = SessionToolBuilder::new(pool.clone(), live.clone(), Arc::new(Listed(false))).expect("pool");
        // A fixed-surface session created with A, persisted and reloaded; the owner publishes B and the request boundary reconciles.
        let stored_a = persisted(&pool, &a);
        let mut session = json!({ "cwd": "/work", "model": "gpt-5", "toolSpec": "full", "tools": [stored_a.clone()], "deferredToolCatalog": [stored_a.clone()] });
        reconcile_in_place(&mut session, &[super::super::surface_host::tool_doc(&b)]);
        assert_eq!(session["tools"][0], stored_a, "the eager tool is not re-linked on a fixed surface");
        assert_eq!(session["deferredToolCatalog"][0], session_doc(&pool, &b), "the scoped catalog holds the published entry");
        // Build the request without going through a boundary snapshot (the cache-warmer path).
        let held = header(serde_json::from_str(&session.to_string()).expect("reloaded"));
        let surface = SessionSurface::from_header(&held, Vec::new());
        let tokens = mixdog_rt::testing::tokens();
        let ctx = ToolContext {
            call_id: "call".into(),
            thread_id: "thread".into(),
            turn_id: "turn".into(),
            tool: "mcp__alpha__zeta".into(),
            cwd: AbsPath::new(std::env::temp_dir()).expect("absolute cwd"),
            surface: SurfaceKind::Lead,
            cancel: tokio_util::sync::CancellationToken::new(),
            deadline: None,
            progress: Arc::new(MockProgress::default()),
            io: ToolIo { interactive: tokens.interactive_io, durability: tokens.durability_io, maintenance: tokens.maintenance_io },
            approvals: Arc::new(MockApprovalGate::default()),
            files: Arc::new(MockFileService::default()),
            processes: Arc::new(MockProcessManager::default()),
            options: Default::default(),
            review: None,
        };
        for connected in [Vec::new(), vec![b.clone()]] {
            let available = !connected.is_empty();
            *live.0.lock().expect("tools") = connected;
            let built = builder.tools(&held, &surface).await.unwrap();
            let set = mixdog_agent::tools::ToolSet::new(built.tools);
            let (request, _) = mixdog_agent::assemble_request("gpt-5", Default::default(), Vec::new(), None, set.definitions());
            assert_eq!(request.tools.len(), 1);
            assert_eq!(request.tools[0].input_schema.to_string(), a.spec().input_schema.to_string());
            assert_eq!(set.resolve("mcp__alpha__zeta").expect("eager tool").call(&ctx, json!({})).await.is_ok(), available);
        }
    }

    #[test]
    #[cfg(node_twin)]
    fn a_withdrawn_late_schema_is_still_sent_for_native_search_history() {
        use super::super::tool_surface::ToolSurface;
        use mixdog_agent::env::Clock;

        struct FixedClock;
        impl Clock for FixedClock {
            fn now_ms(&self) -> i64 { 1 }
        }

        const NAME: &str = "mcp__alpha__zeta";
        let live = LiveMcp(std::sync::Mutex::new(Vec::new()), Arc::new(std::sync::atomic::AtomicBool::new(false)));
        let surface = ToolSurface { host: &live, clock: &FixedClock };
        let schema = json!({ "type": "object", "properties": { "zeta": { "type": "string" } } });
        let doc = published(schema.clone()).stored().encode();
        let mut session = json!({
            "provider": "anthropic", "deferredProviderMode": "native", "deferredNativeTools": true,
            "tools": [{ "name": "read" }], "deferredToolCatalog": [],
            "deferredMcpToolNames": [NAME], "deferredLateToolCatalog": [doc],
        });
        let mut result = mixdog_agent::message::AgentMessage::user("native search result");
        result.message.native_tool_search = Some(json!({ "provider": "anthropic", "toolReferences": [NAME] }));
        let references = super::super::factory::native_searches(&[result]);
        let request = |session: &Value, native: &[Value]| {
            let base = mixdog_agent::tools::ToolSet::new(vec![stub("read")]).definitions();
            let tools = super::super::assemble::boundary_tools(session.as_object().expect("header"), base, native);
            mixdog_agent::assemble_request("claude", Default::default(), Vec::new(), None, tools).0
        };
        let before = request(&session, &references);
        assert_eq!(before.tools.len(), 2);
        assert_eq!(before.tools[1].name, NAME);
        assert!(before.tools[1].defer_loading);
        assert_eq!(before.tools[1].input_schema, schema);
        live.1.store(true, std::sync::atomic::Ordering::SeqCst);
        surface.reconcile_mcp_catalog(&mut session, &[]);
        let after = request(&session, &references);
        assert_eq!(after.tools, before.tools, "the same schema replays with the native search result");
        assert_eq!(request(&session, &[]).tools.len(), 1, "keeping the schema doesn't expose it without the reference");
        assert_eq!(session["pendingDeferredToolDelta"]["removed"], json!([NAME]));
        let policy = SessionSurface::from_header(&header(session), Vec::new());
        assert!(policy.deferred_call_refusal(NAME, &ToolAnnotations::default()).is_some());
    }

    /// A withdrawal that lands between two boundaries moves nothing a warm prefix sends: the request's tools at the next boundary
    /// are the earlier ones, byte for byte, and the withdrawn tool refuses a call.
    #[tokio::test]
    #[cfg(node_twin)]
    async fn a_warm_withdrawal_keeps_the_prefix_and_announces_the_refused_tool() {
        use super::super::tool_surface::ToolSurface;
        use mixdog_agent::env::Clock;
        use mixdog_core_api::domain::tool::ToolAnnotations;

        struct Fixed;
        impl Clock for Fixed {
            fn now_ms(&self) -> i64 { 1 }
        }

        const NAME: &str = "mcp__alpha__zeta";
        let g = golden();
        let (pool, _) = pool(&g);
        let tool = published(json!({}));
        let flag = Arc::new(std::sync::atomic::AtomicBool::new(false));
        let live = Arc::new(LiveMcp(std::sync::Mutex::new(vec![tool.clone()]), flag.clone()));
        let builder = SessionToolBuilder::new(pool.clone(), live.clone(), Arc::new(Listed(false))).expect("pool");
        let stored = persisted(&pool, &tool);
        let system = json!([
            { "role": "system", "content": "Rules" },
            { "role": "system", "content": "<available-deferred-tools>\n- mcp__alpha: Alpha tools.\n</available-deferred-tools>" },
        ]);
        let mut session = json!({
            "cwd": "/work", "model": "gpt-5", "provider": "openai", "toolSpec": "full",
            "deferredProviderMode": "native", "tools": [stored.clone()], "deferredToolCatalog": [stored.clone()],
            "deferredMcpToolNames": [NAME], "messages": system.clone(),
        });
        let sent = |held: &Header, built: SessionTools| {
            super::super::assemble::boundary_tools(held, mixdog_agent::tools::ToolSet::new(built.tools).definitions(), &[])
        };
        let held = header(session.clone());
        let surface = SessionSurface::from_header(&held, Vec::new());
        let before = sent(&held, builder.tools(&held, &surface).await.unwrap());
        assert_eq!(before.iter().map(|tool| tool.name.as_str()).collect::<Vec<_>>(), [NAME]);
        // The publisher withdraws it: nothing is listed and the owner says it is gone.
        live.0.lock().expect("tools").clear();
        flag.store(true, std::sync::atomic::Ordering::SeqCst);
        let tool_surface = ToolSurface { host: live.as_ref(), clock: &Fixed };
        tool_surface.reconcile_mcp_catalog(&mut session, &[]);
        assert_eq!(session["messages"], system, "the cached system text stays as sent");
        assert_eq!(session["deferredToolCatalog"], json!([stored]), "boot pruning waits for the cold fold");
        assert_eq!(session["pendingDeferredToolDelta"]["removed"], json!([NAME]));
        let mut resumed = session.clone();
        tool_surface.restore(&mut resumed, "lead", &[], &Default::default());
        assert_eq!(resumed["messages"], system, "a same-route resume leaves the cached text alone too");
        assert_eq!(resumed["tools"], session["tools"]);
        let held = header(session);
        let surface = SessionSurface::from_header(&held, Vec::new());
        let next = builder.tools(&held, &surface).await.unwrap();
        assert_eq!(sent(&held, next), before, "the next boundary sends the same tools");
        let refusal = surface.deferred_call_refusal(NAME, &ToolAnnotations::default()).expect("dispatch refuses the unavailable tool");
        assert!(refusal.contains("no call was sent"));
    }
    /// A gate that closes after creation (the desktop leaving, Computer Use toggled, a bridge feature going away; here the helper
    /// gone and the gate list moving too) never removes a definition from a live epoch: the next request's definitions are
    /// byte-identical on a non-bridge and on a bridge session, and a call to the tool is refused at dispatch.
    #[tokio::test]
    #[cfg(node_twin)]
    async fn a_gate_closing_after_creation_is_enforced_at_dispatch_and_never_edits_the_sent_definitions() {
        let g = golden();
        let (mut pool, mcp) = pool(&g);
        let up = Arc::new(std::sync::atomic::AtomicBool::new(true));
        let at = pool.iter().position(|tool| name(tool) == "read").expect("read");
        pool[at] = Arc::new(Flips(spec_of("read"), up.clone()));
        let builder = SessionToolBuilder::new(pool, Arc::new(Fixed(mcp)), Arc::new(Listed(false))).expect("pool");
        let bytes = |tools: &[Arc<dyn Tool>]| tools.iter().map(|tool| tool.spec().definition().to_string()).collect::<Vec<_>>().join("\n");
        for bridge in [false, true] {
            let exposure = if bridge { "bridge" } else { "native" };
            let mut held = header(json!({
                "cwd": "/work", "model": "gpt-5", "toolSpec": "full",
                "tools": [{ "name": "read" }, { "name": "grep" }],
                "toolExposureMode": exposure,
            }));
            let first = bytes(&builder.tools(&held, &SessionSurface::from_header(&held, Vec::new())).await.unwrap().tools);
            assert!(first.contains("\"read\""), "bridge {bridge}");
            // The helper goes, and the gate closes: it joins the enforced deny set and the gate list.
            up.store(false, std::sync::atomic::Ordering::SeqCst);
            held.insert("disallowedTools".to_owned(), json!(["read"]));
            held.insert("featureDeniedTools".to_owned(), json!(["read"]));
            let surface = SessionSurface::from_header(&held, Vec::new());
            assert_eq!(bytes(&builder.tools(&held, &surface).await.unwrap().tools), first, "bridge {bridge}: the definitions did not move");
            assert!(surface.refusal("read", None).is_some(), "bridge {bridge}: a call is refused");
            up.store(true, std::sync::atomic::Ordering::SeqCst);
        }
    }
    /// The allowlist gates a call, not the schema the session already holds: a Lead created with one keeps the
    /// standalone tools the deferred surface added (recorded as `lead, caller allowlist`).
    #[tokio::test]
    #[cfg(node_twin)]
    async fn an_allowlist_does_not_narrow_the_tools_the_session_holds() {
        let surface = SessionSurface { active_tools: ["read", "grep"].map(String::from).to_vec(), schema_allowed: Some(vec!["read".into()]), ..SessionSurface::default() };
        let header = header(json!({"cwd": "/work", "model": "gpt-5", "toolSpec": "full"}));
        assert_eq!(names(&builder().tools(&header, &surface).await.unwrap().tools), ["read", "grep"]);
    }
    #[tokio::test]
    #[cfg(node_twin)]
    async fn an_agent_worker_never_sends_the_lead_only_control_tools() {
        let surface = SessionSurface {
            active_tools: ["session", "agent", "ask_user", "handoff_user", "goal"].map(String::from).to_vec(),
            agent_owned: true,
            ..SessionSurface::default()
        };
        // The recorded pool is the one Node's `internalToolDefs` held when it was recorded, which has no `goal`
        // (registered only with the goal lane); add it so the test keeps a tool a worker is left with.
        let g = golden();
        let (mut pool, mcp) = pool(&g);
        pool.push(stub("goal"));
        let builder = SessionToolBuilder::new(pool, Arc::new(Fixed(mcp)), Arc::new(Listed(false))).expect("pool");
        let got = builder.tools(&header(json!({"cwd": "/work", "model": "claude-sonnet-4"})), &surface).await.unwrap();
        assert_eq!(names(&got.tools), ["goal"]);
    }
    /// The builder refuses a pool whose `task` has no definition for delegated agents.
    #[test]
    #[cfg(node_twin)]
    fn a_pool_without_the_agent_definition_of_task_is_refused_by_the_builder() {
        let g = golden();
        let (mut pool, mcp) = pool(&g);
        let at = pool.iter().position(|tool| name(tool) == "task").expect("task");
        pool[at] = Arc::new(Stub(spec_of("task")));
        let error = SessionToolBuilder::new(pool, Arc::new(Fixed(mcp)), Arc::new(Listed(false))).err().expect("refused");
        assert_eq!(error, VariantError { tool: "task" });
    }
}
